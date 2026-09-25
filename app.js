const CONFIG = window.GITPAGE_CONFIG || {};
const APPS_SCRIPT_URL = String(CONFIG.APPS_SCRIPT_URL || '').trim();
const SESSION_STORAGE_KEY = 'gitpage_admin_session_v2';
const CLIENT_STORAGE_KEY = 'gitpage_client_id_v1';

function safeStorageGet(storage, key) {
  try {
    return storage.getItem(key) || '';
  } catch (_) {
    return '';
  }
}

function safeStorageSet(storage, key, value) {
  try {
    storage.setItem(key, value);
    return true;
  } catch (_) {
    return false;
  }
}

function safeStorageRemove(storage, key) {
  try {
    storage.removeItem(key);
  } catch (_) {}
}

const state = {
  dashboard: null,
  currentView: 'dashboard',
  currentRepo: '',
  currentPath: '',
  editor: {repo:'', path:'', sha:null, isNew:false},
  sessionToken: '',
  clientId: '',
  backendWarmStarted: false,
  rpcSeq: 0,
  rpcPending: new Map()
};

document.addEventListener('DOMContentLoaded', async () => {
  // UI tampil terlebih dahulu. Tidak ada request backend sebelum diperlukan.
  bindUI();

  state.sessionToken = safeStorageGet(sessionStorage, SESSION_STORAGE_KEY);
  state.clientId = getOrCreateClientId();

  try {
    validateBackendUrl();
    warmBackendSilently();
  } catch (err) {
    showAuth();
    const note = document.getElementById('authNote');
    if (note) note.textContent = err.message;
    return;
  }

  // Belum punya sesi: form login tampil seketika.
  // Warm-up backend tetap berjalan diam-diam di belakang layar.
  if (!state.sessionToken) {
    showAuth();
    return;
  }

  // Ada sesi lokal: langsung coba memuat aplikasi.
  // Jika token sudah kedaluwarsa, initialize() akan mengembalikan ke login.
  hideAuth();
  await initialize();
});

function bindUI() {
  document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));
  document.querySelectorAll('[data-view-link]').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.viewLink)));
  document.querySelectorAll('[data-open-create]').forEach(btn => btn.addEventListener('click', () => openModal('createModal')));
  document.querySelectorAll('[data-close-modal]').forEach(btn => btn.addEventListener('click', () => closeModal(btn.dataset.closeModal)));
  document.querySelectorAll('.modal-backdrop').forEach(el => el.addEventListener('click', e => { if (e.target === el) closeModal(el.id); }));

  document.getElementById('adminLoginForm').addEventListener('submit', loginAdmin);
  document.getElementById('togglePassword').addEventListener('click', () => {
    const i = document.getElementById('adminPasswordInput');
    i.type = i.type === 'password' ? 'text' : 'password';
  });
  document.getElementById('logoutBtn').addEventListener('click', logoutAdmin);
  document.getElementById('refreshBtn').addEventListener('click', () => refreshDashboard(true));
  document.getElementById('createForm').addEventListener('submit', createWebsite);
  document.getElementById('createTemplateSelect').addEventListener('change', updateCreateTemplateState);
  document.getElementById('repoSearch').addEventListener('input', renderRepoTable);
  document.getElementById('fileRepoSelect').addEventListener('change', async e => {
    state.currentRepo = e.target.value;
    state.currentPath = '';
    await loadDirectory('');
  });
  document.getElementById('newFileBtn').addEventListener('click', newFile);
  document.getElementById('uploadInput').addEventListener('change', uploadFile);
  document.getElementById('saveFileBtn').addEventListener('click', saveEditor);
  document.getElementById('deleteFileBtn').addEventListener('click', deleteEditor);
  document.getElementById('testConnectionBtn').addEventListener('click', testConnection);
  document.getElementById('mobileMenu').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'));
  updateCreateTemplateState();
}

function warmBackendSilently() {
  if (state.backendWarmStarted || !APPS_SCRIPT_URL) return;
  state.backendWarmStarted = true;

  try {
    const url = new URL(APPS_SCRIPT_URL);
    url.searchParams.set('warm', String(Date.now()));

    // no-cors sengaja dipakai: kita hanya ingin membangunkan Apps Script.
    // Tidak ada password/token yang dikirim pada warm-up ini.
    fetch(url.toString(), {
      method: 'GET',
      mode: 'no-cors',
      cache: 'no-store',
      credentials: 'omit'
    }).catch(() => {});
  } catch (_) {}
}

function validateBackendUrl() {
  if (!APPS_SCRIPT_URL) {
    throw new Error('Isi APPS_SCRIPT_URL di config.js.');
  }

  let url;
  try {
    url = new URL(APPS_SCRIPT_URL);
  } catch (_) {
    throw new Error('APPS_SCRIPT_URL tidak valid.');
  }

  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'script.google.com' ||
    !/^\/macros\/s\/[^/]+\/exec\/?$/.test(url.pathname)
  ) {
    throw new Error('Gunakan URL deployment Apps Script yang berakhir /exec.');
  }
}

function makeNonce() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(24);
  if (globalThis.crypto && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
}

function getOrCreateClientId() {
  let id = safeStorageGet(localStorage, CLIENT_STORAGE_KEY);
  if (/^[A-Za-z0-9_-]{20,120}$/.test(id)) return id;

  id = makeNonce().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 96);
  if (id.length < 20) {
    id = `client_${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
  }

  // Jika localStorage diblokir, ID masih tetap dipakai selama halaman aktif.
  safeStorageSet(localStorage, CLIENT_STORAGE_KEY, id);
  return id;
}

function isAppsScriptResponseOrigin(origin) {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:') return false;
    return (
      url.hostname === 'script.google.com' ||
      url.hostname === 'script.googleusercontent.com' ||
      url.hostname.endsWith('.googleusercontent.com')
    );
  } catch (_) {
    return false;
  }
}

window.addEventListener('message', event => {
  const msg = event.data || {};
  if (msg.type !== 'gitpage-rpc-result' || !msg.id || !msg.nonce) return;

  const pending = state.rpcPending.get(msg.id);
  if (!pending || pending.nonce !== msg.nonce) return;

  // Normal Apps Script responses come from script.google.com /
  // googleusercontent.com. Some browser/sandbox combinations may expose
  // origin "null"; accept that only when the sender is the exact RPC iframe.
  const exactFrameSource = event.source === pending.iframe.contentWindow;
  const trustedOrigin =
    isAppsScriptResponseOrigin(event.origin) ||
    (event.origin === 'null' && exactFrameSource);

  if (!trustedOrigin) return;

  clearTimeout(pending.timer);
  pending.iframe.remove();
  state.rpcPending.delete(msg.id);

  if (msg.ok) {
    pending.resolve(msg.result);
    return;
  }

  const error = new Error(msg.error || 'Backend error.');
  if (/Sesi admin belum aktif|Sesi admin berakhir|Token sesi/i.test(error.message)) {
    clearAdminSession();
    showAuth();
  }
  pending.reject(error);
});

function gas(method, ...args) {
  return new Promise((resolve, reject) => {
    validateBackendUrl();

    const id = `rpc_${Date.now()}_${++state.rpcSeq}_${makeNonce().slice(0, 10)}`;
    const nonce = makeNonce();
    const frameName = `gitpage_rpc_frame_${state.rpcSeq}_${Date.now()}`;

    const iframe = document.createElement('iframe');
    iframe.name = frameName;
    iframe.title = 'GitPage RPC';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;width:1px;height:1px;left:-9999px;top:-9999px;border:0;opacity:0;pointer-events:none;';
    document.body.appendChild(iframe);

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = APPS_SCRIPT_URL;
    form.target = frameName;
    form.acceptCharset = 'UTF-8';
    form.style.display = 'none';

    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'payload';
    input.value = JSON.stringify({
      id,
      nonce,
      method,
      args,
      sessionToken: state.sessionToken || '',
      clientId: state.clientId || '',
      requestOrigin: window.location.origin || ''
    });

    form.appendChild(input);
    document.body.appendChild(form);

    const timeoutMs = method === 'loginAdmin' ? 45000 : 30000;

    const timer = setTimeout(() => {
      if (!state.rpcPending.has(id)) return;
      state.rpcPending.delete(id);
      iframe.remove();

      const hint = method === 'loginAdmin'
        ? ' Periksa APPS_SCRIPT_URL, deployment Web App, dan FRONTEND_ORIGIN.'
        : '';

      reject(new Error(
        `Backend Apps Script tidak merespons dalam ${Math.round(timeoutMs / 1000)} detik.${hint}`
      ));
    }, timeoutMs);

    state.rpcPending.set(id, {resolve, reject, nonce, iframe, timer});

    try {
      form.submit();
    } catch (err) {
      clearTimeout(timer);
      state.rpcPending.delete(id);
      iframe.remove();
      reject(err);
    } finally {
      form.remove();
    }
  });
}

function saveAdminSession(token) {
  state.sessionToken = String(token || '');
  if (state.sessionToken) {
    safeStorageSet(sessionStorage, SESSION_STORAGE_KEY, state.sessionToken);
  } else {
    safeStorageRemove(sessionStorage, SESSION_STORAGE_KEY);
  }
}

function clearAdminSession() {
  state.sessionToken = '';
  safeStorageRemove(sessionStorage, SESSION_STORAGE_KEY);
}

async function initialize() {
  showLoading('Memuat dashboard...');
  try {
    const initial = await gas('getInitialData');
    renderStatus(initial.status);

    if (!initial.status.configured) {
      switchView('settings');
      return;
    }

    state.dashboard = initial.dashboard;
    renderDashboard(initial.dashboard);
    renderRepoTable();
    populateRepoSelect();
    renderProfile(initial.dashboard.user);
  } catch (err) {
    if (/Sesi admin|ADMIN_PASSWORD|Token sesi/.test(err.message)) {
      clearAdminSession();
      showAuth();
    }
    toast(err.message,'error');
  } finally {
    hideLoading();
  }
}

async function loginAdmin(e) {
  e.preventDefault();

  const input = document.getElementById('adminPasswordInput');
  const button = document.getElementById('adminLoginBtn');

  if (!input.value) {
    input.focus();
    return;
  }

  if (button.disabled) return;

  button.disabled = true;
  button.dataset.originalText = button.textContent;
  button.textContent = 'Memeriksa...';

  const note = document.getElementById('authNote');
  if (note) note.textContent = '';

  showLoading('Memeriksa password...');

  try {
    validateBackendUrl();

    const result = await gas('loginAdmin', input.value);
    saveAdminSession(result && result.sessionToken ? result.sessionToken : '');

    if (!state.sessionToken) {
      throw new Error('Backend tidak mengembalikan sesi login.');
    }

    // Password sudah benar pada titik ini.
    // Ubah indikator agar waktu mengambil GitHub tidak dianggap waktu verifikasi password.
    input.value = '';
    hideAuth();
    button.textContent = 'Masuk sebagai Admin';
    showLoading('Memuat dashboard...');
    toast('Login berhasil.','success');

    await initialize();
  } catch (err) {
    input.focus();
    input.select();

    const note = document.getElementById('authNote');
    if (note) note.textContent = err.message || 'Login gagal.';

    toast(err.message || 'Login gagal.','error');
  } finally {
    hideLoading();
    button.disabled = false;
    button.textContent = button.dataset.originalText || 'Masuk sebagai Admin';
  }
}

async function logoutAdmin() {
  showLoading('Keluar...');
  try { await gas('logoutAdmin'); } catch {}
  clearAdminSession();
  state.dashboard=null;
  showAuth();
  hideLoading();
  toast('Anda telah keluar.');
}

function showAuth(){document.getElementById('authScreen').classList.remove('hidden');document.getElementById('app').classList.add('app-locked')}
function hideAuth(){
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('app').classList.remove('app-locked');
  const note=document.getElementById('authNote');
  if(note)note.textContent='';
}

async function refreshDashboard(show=true) {
  if (show) showLoading('Memuat repository...');
  try {
    const d = await gas('getDashboardData');
    state.dashboard=d;
    renderDashboard(d);
    renderRepoTable();
    populateRepoSelect();
    renderProfile(d.user);
    if (show) toast('Data diperbarui.','success');
  } catch(err){toast(err.message,'error')}
  finally{if(show)hideLoading()}
}

function renderStatus(s){
  const pill=document.getElementById('connectionPill');
  pill.textContent=s.configured?'Terhubung':'Belum siap';
  pill.className='status '+(s.configured?'good':'bad');
  document.getElementById('tokenStatus').textContent=s.configured?'Sudah diatur':'Belum diatur';
  document.getElementById('passwordStatus').textContent='Sudah diatur';
  document.getElementById('backendStatus').textContent='Apps Script';
  if(s.user)renderProfile(s.user);
}

function renderProfile(u){
  document.getElementById('profileName').textContent=u.name||u.login;
  document.getElementById('profileLogin').textContent='@'+u.login;
  const a=document.getElementById('avatar');
  a.innerHTML=u.avatarUrl?`<img src="${escAttr(u.avatarUrl)}" alt="">`:'GH';
}

function renderDashboard(d){
  document.getElementById('statRepos').textContent=d.stats.repositories;
  document.getElementById('statPages').textContent=d.stats.pagesActive;
  document.getElementById('statPublic').textContent=d.stats.publicRepositories;
  document.getElementById('statPrivate').textContent=d.stats.privateRepositories;
  const c=document.getElementById('recentRepos');
  const rs=d.repositories.slice(0,6);
  c.innerHTML=rs.length?rs.map(repoRow).join(''):`<div class="empty"><b>Belum ada repository</b><span>Buat website pertama Anda.</span></div>`;
  bindRepoButtons(c);
}

function repoRow(r){return `<div class="repo-row"><div class="repo-icon">◫</div><div class="repo-main"><strong>${esc(r.name)}</strong><p>${esc(r.description||'Tanpa deskripsi')}</p></div><div class="repo-meta"><span class="pill">${r.private?'Private':'Public'}</span>${r.hasPages?'<span class="pill green">Pages</span>':''}</div><button class="small-btn" data-repo="${escAttr(r.name)}">Kelola</button></div>`}
function bindRepoButtons(root){root.querySelectorAll('[data-repo]').forEach(b=>b.addEventListener('click',()=>openRepo(b.dataset.repo)))}

function renderRepoTable(){
  if(!state.dashboard)return;
  const q=document.getElementById('repoSearch').value.trim().toLowerCase();
  const rs=state.dashboard.repositories.filter(r=>r.name.toLowerCase().includes(q)||(r.description||'').toLowerCase().includes(q));
  const body=document.getElementById('repoTableBody');
  body.innerHTML=rs.length?rs.map(r=>`<tr><td><b>${esc(r.name)}</b><div class="muted">${esc(r.description||'Tanpa deskripsi')}</div></td><td><span class="pill">${r.private?'Private':'Public'}</span></td><td>${r.hasPages?'<span class="pill green">Aktif</span>':'Belum aktif'}</td><td>${formatDate(r.updatedAt)}</td><td><button class="small-btn" data-repo="${escAttr(r.name)}">Kelola</button></td></tr>`).join(''):`<tr><td colspan="5" class="center">Tidak ditemukan.</td></tr>`;
  bindRepoButtons(body);
}

function populateRepoSelect(){
  const s=document.getElementById('fileRepoSelect'), current=s.value;
  const rs=state.dashboard?state.dashboard.repositories:[];
  s.innerHTML='<option value="">Pilih repository...</option>'+rs.map(r=>`<option value="${escAttr(r.name)}">${esc(r.name)}</option>`).join('');
  if(rs.some(r=>r.name===current))s.value=current;
}

function updateCreateTemplateState() {
  const template = document.getElementById('createTemplateSelect').value;
  const pages = document.getElementById('createPagesCheck');
  const templateHint = document.getElementById('templateHint');
  const pagesHint = document.getElementById('pagesHint');
  const notice = document.getElementById('noTemplateNotice');

  const noTemplate = template === 'none';

  notice.hidden = !noTemplate;

  if (noTemplate) {
    templateHint.textContent = 'Repository dibuat kosong agar Anda dapat upload kode sendiri.';
    pages.checked = false;
    pages.disabled = true;
    pagesHint.textContent = 'Aktifkan setelah Anda mengupload index.html atau kode website.';
  } else {
    templateHint.textContent = 'Template akan langsung membuat file website awal.';
    pages.disabled = false;
    pagesHint.textContent = 'Publish dari branch utama, folder root.';
  }
}

async function loadTemplate(name, title){
  if(name==='none') return [];
  const url=new URL(`templates/${encodeURIComponent(name)}.json`,location.href);
  const r=await fetch(url,{cache:'no-store'});
  if(!r.ok)throw new Error('Template tidak dapat dimuat dari GitHub.');
  const t=await r.json();
  const vars={'{{TITLE}}':title||'Website Baru'};
  return (t.files||[]).map(f=>({
    path:f.path,
    content:Object.entries(vars).reduce((v,[k,val])=>v.split(k).join(String(val)),String(f.content||''))
  }));
}

async function createWebsite(e){
  e.preventDefault();
  const fd=new FormData(e.target);
  closeModal('createModal');
  showLoading('Membuat repository...');
  try{
    const name=String(fd.get('name')||'').trim();
    const title=String(fd.get('siteTitle')||name||'Website Baru').trim();
    const template=String(fd.get('template')||'landing');
    const files=await loadTemplate(template,title);
    const noTemplate=template==='none';

    const result=await gas('createWebsite',{
      name,
      description:String(fd.get('description')||''),
      private:fd.get('visibility')==='private',
      enablePages:!noTemplate && fd.get('enablePages')==='on',
      emptyRepository:noTemplate,
      files
    });
    toast(result.message,result.pagesWarning?'error':'success');
    e.target.reset();
    e.target.querySelector('[name="enablePages"]').checked=true;
    updateCreateTemplateState();
    await refreshDashboard(false);
    await openRepo(result.repo.name);
  }catch(err){toast(err.message,'error')}
  finally{hideLoading()}
}

async function openRepo(name){
  openModal('repoModal');
  document.getElementById('repoModalTitle').textContent=name;
  document.getElementById('repoModalBody').innerHTML='<div class="center">Memuat...</div>';

  try{
    const d=await gas('getRepositoryDetails',name);
    const r=d.repo;
    const p=d.pages;
    const rootFiles=Array.isArray(d.files)?d.files:[];
    const repositoryHasContent=rootFiles.length>0;
    const body=document.getElementById('repoModalBody');

    const pagesHtml=p?`
      <div class="pages-stack">
        <div class="pages-summary">
          <div>
            <h3>GitHub Pages</h3>
            <p class="muted">Status: ${esc(p.status||'aktif')}</p>
          </div>
          ${p.htmlUrl?`<a class="btn btn-primary" href="${escAttr(p.htmlUrl)}" target="_blank" rel="noreferrer">Buka Website ↗</a>`:''}
        </div>

        <div class="domain-box">
          <div class="domain-box-head">
            <div>
              <h4>Custom Domain</h4>
              <p>Hubungkan domain atau subdomain ke website GitHub Pages.</p>
            </div>
          </div>

          <div class="domain-form-card">
            <label class="domain-label" for="customDomainInput">Domain / subdomain</label>
            <div class="domain-input-row">
              <div class="domain-input-wrap">
                <span class="domain-prefix">https://</span>
                <input id="customDomainInput" type="text" inputmode="url"
                  value="${escAttr(p.cname||'')}"
                  placeholder="web.domainanda.id">
              </div>
              <button class="btn btn-primary domain-save-btn" id="saveCustomDomainBtn">Simpan Domain</button>
            </div>
            <div class="domain-help">Contoh: <b>web.domainanda.id</b> — cukup masukkan nama domain, tanpa path.</div>
          </div>

          <div class="domain-actions">
            ${p.cname?'<button class="btn btn-danger" id="removeCustomDomainBtn">Hapus Custom Domain</button>':''}
            ${p.cname?'<button class="btn" id="checkDnsBtn">Cek DNS</button>':''}
          </div>

          <div class="domain-status">
            <div><span>Domain aktif</span><strong>${esc(p.cname||'Belum diatur')}</strong></div>
            <div><span>Status verifikasi</span><strong>${esc(p.protectedDomainState||'—')}</strong></div>
            <div><span>Sertifikat HTTPS</span><strong>${esc(p.httpsCertificateState||'—')}</strong></div>
            <div><span>HTTPS dipaksa</span><strong>${p.httpsEnforced?'Aktif':'Tidak aktif'}</strong></div>
          </div>

          <div class="https-line">
            <div>
              <strong>Enforce HTTPS</strong>
              <div class="muted">HTTPS baru dapat diaktifkan setelah domain dan sertifikat siap.</div>
            </div>
            <label class="switch" title="Enforce HTTPS">
              <input id="httpsEnforcedToggle" type="checkbox" ${p.httpsEnforced?'checked':''} ${p.cname?'':'disabled'}>
              <span class="switch-slider"></span>
            </label>
          </div>

          <div id="dnsHealthResult"></div>
        </div>
      </div>
    `:repositoryHasContent?`
      <div>
        <h3>GitHub Pages</h3>
        <p class="muted">Belum aktif. Repository sudah memiliki file dan siap dipublikasikan.</p>
        <button class="btn btn-primary" id="enablePagesBtn">Aktifkan Pages</button>
      </div>
    `:`
      <div>
        <h3>GitHub Pages</h3>
        <p class="muted">Repository masih kosong. Upload <b>index.html</b> atau kode website terlebih dahulu sebelum mengaktifkan Pages.</p>
        <button class="btn" id="emptyRepoFilesBtn">Buka File Manager</button>
      </div>
    `;

    body.innerHTML=`
      <div class="settings-grid">
        <div class="panel">
          <h3>${esc(r.fullName)}</h3>
          <p class="muted">${esc(r.description||'Tanpa deskripsi')}</p>
          <div class="setting-row"><span>Branch</span><b>${esc(r.defaultBranch||'Belum ada branch')}</b></div>
          <div class="setting-row"><span>Visibilitas</span><b>${r.private?'Private':'Public'}</b></div>
          <div class="modal-actions">
            <a class="btn" href="${escAttr(r.htmlUrl)}" target="_blank" rel="noreferrer">GitHub ↗</a>
            <button class="btn" id="repoFilesBtn">File Manager</button>
          </div>
        </div>
        <div class="panel">${pagesHtml}</div>
      </div>
    `;

    document.getElementById('repoFilesBtn').addEventListener('click',async()=>{
      closeModal('repoModal');
      switchView('files');
      document.getElementById('fileRepoSelect').value=r.name;
      state.currentRepo=r.name;
      state.currentPath='';
      await loadDirectory('');
    });

    const emptyFilesBtn=document.getElementById('emptyRepoFilesBtn');
    if(emptyFilesBtn){
      emptyFilesBtn.addEventListener('click',async()=>{
        closeModal('repoModal');
        switchView('files');
        document.getElementById('fileRepoSelect').value=r.name;
        state.currentRepo=r.name;
        state.currentPath='';
        await loadDirectory('');
      });
    }

    const ep=document.getElementById('enablePagesBtn');
    if(ep){
      ep.addEventListener('click',async()=>{
        showLoading('Mengaktifkan Pages...');
        try{
          await gas('configurePages',r.name,r.defaultBranch,'/');
          toast('GitHub Pages berhasil diaktifkan.','success');
          await refreshDashboard(false);
          await openRepo(r.name);
        }catch(err){
          toast(err.message,'error');
        }finally{
          hideLoading();
        }
      });
    }

    bindCustomDomainControls(r,p);
  }catch(err){
    document.getElementById('repoModalBody').innerHTML=`<div class="center">${esc(err.message)}</div>`;
  }
}

function normalizeDomainInput(value){
  return String(value||'')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//,'')
    .replace(/\/.*$/,'')
    .replace(/\.$/,'');
}

function bindCustomDomainControls(repo,pages){
  if(!pages)return;

  const input=document.getElementById('customDomainInput');
  const save=document.getElementById('saveCustomDomainBtn');
  const remove=document.getElementById('removeCustomDomainBtn');
  const dns=document.getElementById('checkDnsBtn');
  const httpsToggle=document.getElementById('httpsEnforcedToggle');

  if(save){
    save.addEventListener('click',async()=>{
      const domain=normalizeDomainInput(input.value);
      if(!domain){
        toast('Masukkan custom domain terlebih dahulu.','error');
        input.focus();
        return;
      }

      showLoading('Menyimpan custom domain...');
      try{
        const result=await gas('setCustomDomain',repo.name,domain);
        toast(
          result.cnameWarning
            ? 'Domain tersimpan, tetapi sinkronisasi file CNAME perlu diperiksa.'
            : 'Custom domain berhasil disimpan.',
          result.cnameWarning?'error':'success'
        );
        await openRepo(repo.name);
      }catch(err){
        toast(err.message,'error');
      }finally{
        hideLoading();
      }
    });
  }

  if(remove){
    remove.addEventListener('click',async()=>{
      if(!confirm(`Hapus custom domain ${pages.cname}?`))return;

      showLoading('Menghapus custom domain...');
      try{
        const result=await gas('removeCustomDomain',repo.name);
        toast(
          result.cnameWarning
            ? 'Domain dihapus, tetapi file CNAME perlu diperiksa.'
            : 'Custom domain berhasil dihapus.',
          result.cnameWarning?'error':'success'
        );
        await openRepo(repo.name);
      }catch(err){
        toast(err.message,'error');
      }finally{
        hideLoading();
      }
    });
  }

  if(httpsToggle){
    httpsToggle.addEventListener('change',async()=>{
      const desired=httpsToggle.checked;
      httpsToggle.disabled=true;
      showLoading(desired?'Mengaktifkan HTTPS...':'Menonaktifkan Enforce HTTPS...');
      try{
        const result=await gas('setPagesHttps',repo.name,desired);
        toast(
          result.httpsEnforced
            ? 'Enforce HTTPS aktif.'
            : 'Enforce HTTPS dinonaktifkan.',
          'success'
        );
        await openRepo(repo.name);
      }catch(err){
        httpsToggle.checked=!desired;
        toast(err.message,'error');
      }finally{
        hideLoading();
      }
    });
  }

  if(dns){
    dns.addEventListener('click',async()=>{
      const resultBox=document.getElementById('dnsHealthResult');
      resultBox.innerHTML='<div class="dns-result">Memeriksa DNS...</div>';

      try{
        const result=await gas('getPagesDnsHealth',repo.name);
        renderDnsHealth(result);
      }catch(err){
        resultBox.innerHTML=`<div class="dns-result bad">${esc(err.message)}</div>`;
      }
    });
  }
}

function renderDnsHealth(result){
  const box=document.getElementById('dnsHealthResult');
  if(!box)return;

  if(result.checking){
    box.innerHTML='<div class="dns-result warn">Pemeriksaan DNS sedang diproses oleh GitHub. Tekan “Cek DNS” lagi beberapa saat kemudian.</div>';
    return;
  }

  const d=result.domain||{};
  const valid=Boolean(d.isValid);
  const resolves=Boolean(d.dnsResolves);
  const served=Boolean(d.isServedByPages);
  const https=Boolean(d.respondsToHttps);
  const reason=d.reason||d.httpsError||d.caaError||'';

  const klass=valid&&resolves&&served?'good':resolves?'warn':'bad';

  box.innerHTML=`
    <div class="dns-result ${klass}">
      <b>${valid&&resolves&&served?'DNS terhubung ke GitHub Pages':'DNS belum sepenuhnya siap'}</b><br>
      Resolve: ${resolves?'Ya':'Tidak'} ·
      Served by Pages: ${served?'Ya':'Tidak'} ·
      HTTPS: ${https?'Ya':'Belum'}
      ${reason?`<br>${esc(reason)}`:''}
    </div>
  `;
}


async function loadDirectory(path){
  const c=document.getElementById('fileList');
  if(!state.currentRepo){c.innerHTML='<div class="empty"><b>Pilih repository</b><span>Isi repository akan tampil di sini.</span></div>';return}
  state.currentPath=path||''; renderBreadcrumb(state.currentPath); c.innerHTML='<div class="center">Memuat...</div>';
  try{renderFiles(await gas('getDirectory',state.currentRepo,state.currentPath))}catch(err){c.innerHTML=`<div class="empty"><b>Gagal memuat</b><span>${esc(err.message)}</span></div>`}
}
function renderBreadcrumb(path){
  const b=document.getElementById('breadcrumb'),parts=(path||'').split('/').filter(Boolean);let cur='',html='<button data-path="">root</button>';
  parts.forEach(p=>{cur=cur?cur+'/'+p:p;html+=`<span>/</span><button data-path="${escAttr(cur)}">${esc(p)}</button>`});
  b.innerHTML=html;b.querySelectorAll('button').forEach(x=>x.addEventListener('click',()=>loadDirectory(x.dataset.path)));
}
function renderFiles(items){
  const c=document.getElementById('fileList');
  if(!items.length){c.innerHTML='<div class="empty"><b>Folder kosong</b><span>Buat atau upload file baru.</span></div>';return}
  items=[...items].sort((a,b)=>a.type===b.type?a.name.localeCompare(b.name):a.type==='dir'?-1:1);
  c.innerHTML=items.map(i=>`<div class="file-row" data-path="${escAttr(i.path)}" data-type="${i.type}" data-sha="${escAttr(i.sha)}"><div class="file-icon">${i.type==='dir'?'▣':'▤'}</div><div class="file-name"><strong>${esc(i.name)}</strong><span>${esc(i.path)}</span></div><div class="file-size">${i.type==='dir'?'Folder':formatSize(i.size)}</div><div class="file-type">${i.type==='dir'?'DIR':ext(i.name).toUpperCase()}</div></div>`).join('');
  c.querySelectorAll('.file-row').forEach(x=>x.addEventListener('click',()=>x.dataset.type==='dir'?loadDirectory(x.dataset.path):openTextFile(x.dataset.path)));
}

async function openTextFile(path){
  if(!isText(path))return toast('Editor hanya untuk file teks.','error');
  openModal('editorModal');document.getElementById('editorTitle').textContent=path.split('/').pop();document.getElementById('editorBadge').textContent='EDITOR';document.getElementById('editorContent').value='Memuat...';
  try{const f=await gas('getTextFile',state.currentRepo,path);state.editor={repo:state.currentRepo,path:f.path,sha:f.sha,isNew:false};document.getElementById('editorPath').value=f.path;document.getElementById('editorPath').disabled=true;document.getElementById('editorContent').value=f.content||'';document.getElementById('deleteFileBtn').style.display=''}catch(err){closeModal('editorModal');toast(err.message,'error')}
}
function newFile(){
  if(!state.currentRepo)return toast('Pilih repository terlebih dahulu.','error');
  state.editor={repo:state.currentRepo,path:'',sha:null,isNew:true};document.getElementById('editorBadge').textContent='FILE BARU';document.getElementById('editorTitle').textContent='Buat File';document.getElementById('editorPath').value=state.currentPath?state.currentPath+'/':'';document.getElementById('editorPath').disabled=false;document.getElementById('editorContent').value='';document.getElementById('deleteFileBtn').style.display='none';openModal('editorModal')
}
async function saveEditor(){
  const path=document.getElementById('editorPath').value.trim(),content=document.getElementById('editorContent').value;if(!path)return toast('Path wajib diisi.','error');
  showLoading('Menyimpan commit...');try{await gas('saveTextFile',state.editor.repo,path,content,state.editor.sha);closeModal('editorModal');toast('File disimpan.','success');await loadDirectory(state.currentPath);await refreshDashboard(false)}catch(err){toast(err.message,'error')}finally{hideLoading()}
}
async function deleteEditor(){
  if(state.editor.isNew||!state.editor.sha)return;if(!confirm(`Hapus ${state.editor.path}?`))return;
  showLoading('Menghapus file...');try{await gas('deleteFile',state.editor.repo,state.editor.path,state.editor.sha);closeModal('editorModal');toast('File dihapus.','success');await loadDirectory(state.currentPath);await refreshDashboard(false)}catch(err){toast(err.message,'error')}finally{hideLoading()}
}
async function uploadFile(e){
  const file=e.target.files[0];e.target.value='';if(!file)return;if(!state.currentRepo)return toast('Pilih repository.','error');if(file.size>6*1024*1024)return toast('Maksimal upload 6 MB agar stabil melalui Apps Script.','error');
  showLoading('Mengupload...');try{const base64=await fileBase64(file),path=(state.currentPath?state.currentPath+'/':'')+file.name;await gas('uploadFileBase64',state.currentRepo,path,base64);toast('Upload berhasil.','success');await loadDirectory(state.currentPath);await refreshDashboard(false)}catch(err){toast(err.message,'error')}finally{hideLoading()}
}
function fileBase64(file){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result).split(',')[1]);r.onerror=rej;r.readAsDataURL(file)})}

async function testConnection(){showLoading('Menguji koneksi...');try{const r=await gas('testGithubConnection');toast(`Terhubung sebagai @${r.login}.`,'success')}catch(err){toast(err.message,'error')}finally{hideLoading()}}

function switchView(v){state.currentView=v;document.querySelectorAll('.view').forEach(x=>x.classList.remove('active'));document.getElementById('view-'+v).classList.add('active');document.querySelectorAll('.nav-item').forEach(x=>x.classList.toggle('active',x.dataset.view===v));const t={dashboard:['Dashboard','Kelola repository dan GitHub Pages.'],repositories:['Repository','Lihat dan kelola repository GitHub.'],files:['File Manager','Edit, buat, hapus, dan upload file.'],settings:['Pengaturan','Status koneksi dan arsitektur aplikasi.']};document.getElementById('pageTitle').textContent=t[v][0];document.getElementById('pageSubtitle').textContent=t[v][1];document.getElementById('sidebar').classList.remove('open')}
function openModal(id){document.getElementById(id).classList.add('show')}function closeModal(id){document.getElementById(id).classList.remove('show')}
function showLoading(t){document.getElementById('loadingText').textContent=t||'Memproses...';document.getElementById('loadingOverlay').classList.add('show')}function hideLoading(){document.getElementById('loadingOverlay').classList.remove('show')}
function toast(m,type=''){const s=document.getElementById('toastStack'),d=document.createElement('div');d.className='toast '+type;d.textContent=m;s.appendChild(d);setTimeout(()=>d.remove(),4200)}
function formatDate(v){if(!v)return'—';try{return new Intl.DateTimeFormat('id-ID',{day:'2-digit',month:'short',year:'numeric'}).format(new Date(v))}catch{return v}}
function formatSize(n){n=Number(n||0);if(n<1024)return n+' B';if(n<1048576)return(n/1024).toFixed(1)+' KB';return(n/1048576).toFixed(1)+' MB'}
function ext(n){const p=String(n).split('.');return p.length>1?p.pop():'file'}function isText(p){const e=ext(p).toLowerCase();return['html','htm','css','js','json','txt','md','xml','yml','yaml','csv','svg','gitignore','nojekyll'].includes(e)||p.endsWith('.gitignore')||p.endsWith('.nojekyll')}
function esc(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;')}function escAttr(v){return esc(v)}
