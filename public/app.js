'use strict';

// ── UTILS ──────────────────────────────────
function toast(msg, type = 'info', ms = 3200) {
  const c = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function statusLabel(status) {
  if (!status) return { label: 'Aguardando', cls: 'sp-waiting', icon: '⏳' };
  const s = status.toLowerCase();
  if (s.includes('entregue'))                                       return { label: 'Entregue',          cls: 'sp-delivered', icon: '✅' };
  if (s.includes('saiu') || s.includes('rota de entrega'))         return { label: 'Saiu para entrega', cls: 'sp-out',       icon: '🛵' };
  if (s.includes('trânsito') || s.includes('transito') || s.includes('encaminhado')) return { label: 'Em trânsito', cls: 'sp-transit', icon: '🚚' };
  if (s.includes('postado') || s.includes('coletado'))             return { label: 'Postado',           cls: 'sp-posted',   icon: '📮' };
  if (s.includes('devolvido') || s.includes('retornado'))          return { label: 'Devolvido',         cls: 'sp-returned', icon: '↩️' };
  if (s.includes('distribuição') || s.includes('distribuicao'))    return { label: 'Em distribuição',   cls: 'sp-transit',  icon: '🏭' };
  return { label: status.length > 28 ? status.slice(0, 28) + '…' : status, cls: 'sp-waiting', icon: '📦' };
}

function pkgIcon(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('entregue'))    return { emoji: '✅', bg: '#DDF8DD' };
  if (s.includes('saiu'))        return { emoji: '🛵', bg: '#E0F7FA' };
  if (s.includes('trânsito') || s.includes('transito')) return { emoji: '🚚', bg: '#FFF4CC' };
  if (s.includes('postado'))     return { emoji: '📮', bg: '#F3F4F6' };
  if (s.includes('devolvido'))   return { emoji: '↩️', bg: '#FEE2E2' };
  return { emoji: '📦', bg: '#F3F4F6' };
}

function progressStep(status) {
  if (!status) return 0;
  const s = status.toLowerCase();
  if (s.includes('entregue'))                                       return 5;
  if (s.includes('saiu') || s.includes('rota de entrega'))         return 4;
  if (s.includes('distribuição') || s.includes('distribuicao'))    return 3;
  if (s.includes('trânsito') || s.includes('transito') || s.includes('encaminhado')) return 2;
  if (s.includes('postado') || s.includes('coletado') || s.includes('aguardando')) return 1;
  return 0;
}

function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

function relTime(ts) {
  if (!ts) return '';
  const d = Math.floor(Date.now() / 1000 - ts);
  if (d < 60)   return 'agora';
  if (d < 3600) return `${Math.floor(d/60)}min atrás`;
  if (d < 86400) return `${Math.floor(d/3600)}h atrás`;
  return `${Math.floor(d/86400)}d atrás`;
}

// ── API ────────────────────────────────────
async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro desconhecido');
  return data;
}

// ── STATE ──────────────────────────────────
let allPackages = [];
let currentDetailId = null;
const userName = localStorage.getItem('entregue_name') || 'Andrey';

// ── VIEWS ──────────────────────────────────
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + id).classList.add('active');
  window.scrollTo(0, 0);
}

function goToDashboard() {
  showView('dashboard');
  loadAll();
}

function scrollToPkgs() {
  document.getElementById('pkgs-section')?.scrollIntoView({ behavior: 'smooth' });
}

// Set user name
document.getElementById('user-name-display').textContent = userName;
document.getElementById('welcome-name').textContent = userName;
document.getElementById('user-initial').textContent = userName[0].toUpperCase();

// ── LOAD DATA ──────────────────────────────
async function loadAll() {
  try {
    const [pkgs, stats] = await Promise.all([api('GET', '/packages'), api('GET', '/status')]);
    allPackages = pkgs;
    renderStats(stats);
    renderPackages(pkgs);
  } catch (e) {
    toast('Erro ao carregar dados: ' + e.message, 'error');
  }
}

// ── STATS ──────────────────────────────────
function renderStats(s) {
  document.getElementById('stat-total').textContent     = s.total ?? 0;
  document.getElementById('stat-transit').textContent   = s.inTransit ?? 0;
  document.getElementById('stat-delivered').textContent = s.delivered ?? 0;

  // Compute extras from packages
  const out     = allPackages.filter(p => /saiu|rota de entrega/i.test(p.last_status)).length;
  const waiting = allPackages.filter(p => /aguardando/i.test(p.last_status) || !p.last_status).length;
  document.getElementById('stat-out').textContent     = out;
  document.getElementById('stat-waiting').textContent = waiting;
}

// ── PACKAGES LIST ──────────────────────────
function renderPackages(pkgs) {
  const list = document.getElementById('pkgs-list');

  if (!pkgs.length) {
    list.innerHTML = `
      <div class="dash-empty">
        <div class="ei">📭</div>
        <h3>Nenhuma encomenda ainda</h3>
        <p>Clique em "Adicionar Rastreio" para começar.</p>
      </div>`;
    return;
  }

  list.innerHTML = pkgs.map(pkg => {
    const st = statusLabel(pkg.last_status);
    const ic = pkgIcon(pkg.last_status);
    const ev = pkg.events?.[0];
    const loc = ev?.location ? `📍 ${ev.location}` : '';
    const checked = pkg.last_checked ? relTime(pkg.last_checked) : 'nunca verificado';

    return `
    <div class="pkg-row" onclick="openDetail(${pkg.id})">
      <div class="pkg-row-icon" style="background:${ic.bg}">${ic.emoji}</div>
      <div class="pkg-row-info">
        <h3>${pkg.description || 'Sem descrição'}</h3>
        <div class="pkg-row-code">${pkg.tracking_code}</div>
        <div class="pkg-row-carrier">${pkg.service_type || 'Correios'} ${loc ? '· ' + loc : ''}</div>
      </div>
      <div class="pkg-row-right">
        <div>
          <div class="status-pill ${st.cls}">${st.label}</div>
          <div class="pkg-row-date" style="margin-top:6px;text-align:right">Adicionado ${fmtDate(pkg.created_at)}</div>
        </div>
        <button class="pkg-row-action" onclick="deletePkg(event,${pkg.id})" title="Remover">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');
}

function filterPackages(q) {
  const term = q.toLowerCase().trim();
  const filtered = term
    ? allPackages.filter(p =>
        p.tracking_code.toLowerCase().includes(term) ||
        (p.description || '').toLowerCase().includes(term) ||
        (p.last_status || '').toLowerCase().includes(term)
      )
    : allPackages;
  renderPackages(filtered);
}

// ── DELETE ─────────────────────────────────
async function deletePkg(e, id) {
  e.stopPropagation();
  if (!confirm('Remover esta encomenda?')) return;
  try {
    await api('DELETE', `/packages/${id}`);
    allPackages = allPackages.filter(p => p.id !== id);
    const stats = await api('GET', '/status');
    renderStats(stats);
    renderPackages(allPackages);
    toast('Encomenda removida.', 'info');
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

// ── DETAIL VIEW ────────────────────────────
async function openDetail(id) {
  currentDetailId = id;
  showView('detail');

  const local = allPackages.find(p => p.id === id);
  if (local) renderDetail(local);

  try {
    const full = await api('GET', `/packages/${id}`);
    const idx = allPackages.findIndex(p => p.id === id);
    if (idx !== -1) allPackages[idx] = full;
    renderDetail(full);
  } catch {}
}

function renderDetail(pkg) {
  const st   = statusLabel(pkg.last_status);
  const step  = progressStep(pkg.last_status);
  const events = pkg.events || [];
  const subs   = pkg.subscriptions || [];

  const STEPS = [
    { label: 'Postado',             icon: '📮' },
    { label: 'Em trânsito',         icon: '🚚' },
    { label: 'Centro de distribuição', icon: '🏭' },
    { label: 'Saiu para entrega',   icon: '🛵' },
    { label: 'Entregue',            icon: '🏠' },
  ];

  const stepsHtml = STEPS.map((s, i) => {
    const cls = i < step ? 'done' : i === step ? 'active' : '';
    return `
    <div class="step-item ${cls}">
      <div class="step-circle">${cls ? (i < step ? '✓' : s.icon) : s.icon}</div>
      <div class="step-label">${s.label}</div>
    </div>`;
  }).join('');

  // progress bar width: step 0→0%, 1→25%, 2→50%, 3→75%, 4→100%
  const pct = Math.min(100, (step / (STEPS.length - 1)) * 100);

  const timelineHtml = events.length
    ? events.map(ev => `
      <div class="tl-event">
        <div class="tl-dot"></div>
        <div class="tl-content">
          <h4>${ev.status || '—'}</h4>
          <p>${ev.location || ''}</p>
          ${ev.detail ? `<small>${ev.detail}</small>` : ''}
        </div>
        <div class="tl-date">${ev.date || ''}${ev.time ? '<br>' + ev.time : ''}</div>
      </div>`).join('')
    : '<p style="color:#999;font-size:14px;padding:12px 0">Nenhum evento disponível ainda. O rastreio é atualizado automaticamente a cada 30 minutos.</p>';

  const emailSubs = subs.filter(s => s.type === 'email').map(s => s.contact);
  const hasPush   = subs.some(s => s.type === 'push');

  const shareUrl = `${location.origin}/#package/${pkg.id}`;

  document.getElementById('detail-grid').innerHTML = `
    <!-- LEFT -->
    <div>
      <!-- Package Info -->
      <div class="dcard">
        <div class="pkg-info-top">
          <div class="pkg-carrier-logo">📦</div>
          <div class="pkg-info-text">
            <h1>${pkg.description || 'Encomenda'}</h1>
            <div class="status-pill ${st.cls}" style="margin-bottom:6px">${st.label}</div>
            <div class="pkg-code-big">${pkg.tracking_code}</div>
          </div>
        </div>
      </div>

      <!-- Progress -->
      <div class="dcard">
        <h3>Progresso da entrega</h3>
        <div style="position:relative">
          <div class="steps-row">${stepsHtml}</div>
          <div class="steps-progress" style="width:calc(${pct}% - 50px + 25px)"></div>
        </div>
      </div>

      <!-- Timeline -->
      <div class="dcard">
        <h3>Histórico de rastreamento</h3>
        <div class="timeline">${timelineHtml}</div>
      </div>
    </div>

    <!-- RIGHT -->
    <div>
      <!-- Delivery date -->
      <div class="dcard">
        <h3>Previsão de entrega</h3>
        <div class="delivery-date">
          <div style="font-size:36px">📅</div>
          <h2>${pkg.is_delivered ? 'Entregue ✓' : '—'}</h2>
          <p>${pkg.is_delivered ? 'Sua encomenda foi entregue!' : 'Data estimada não disponível'}</p>
        </div>
      </div>

      <!-- Shipping details -->
      <div class="dcard">
        <h3>Detalhes do envio</h3>
        <ul class="detail-list">
          <li><span>Transportadora</span><strong>${pkg.service_type || 'Correios'}</strong></li>
          <li><span>Código</span><strong style="font-family:monospace;font-size:13px">${pkg.tracking_code}</strong></li>
          <li><span>Último status</span><strong>${pkg.last_status || '—'}</strong></li>
          <li><span>Verificado</span><strong>${pkg.last_checked ? relTime(pkg.last_checked) : 'nunca'}</strong></li>
        </ul>
      </div>

      <!-- Notifications -->
      <div class="dcard">
        <h3>🔔 Notificações</h3>
        ${emailSubs.length ? `<div style="margin-bottom:10px;display:flex;flex-wrap:wrap;gap:6px">${emailSubs.map(e => `<span style="padding:4px 10px;background:#FFF4CC;color:#7a6200;border-radius:7px;font-size:12px;font-weight:600">✉️ ${e}</span>`).join('')}</div>` : ''}
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <input id="detail-email-inp" class="form-input" type="email" placeholder="Adicionar email..." style="flex:1;padding:10px 13px;font-size:13px">
          <button class="btn-yellow" style="padding:10px 16px;font-size:13px;border-radius:var(--r)" onclick="addEmailSub(${pkg.id})">Salvar</button>
        </div>
        <button class="btn-yellow ${hasPush ? '' : ''}" id="btn-push-${pkg.id}" onclick="togglePush(${pkg.id})"
          style="width:100%;padding:12px;border-radius:var(--r);background:${hasPush ? '#FFC400' : '#fff'};border:1.5px solid ${hasPush ? '#FFC400' : '#eee'};font-weight:600;font-size:14px">
          🔔 ${hasPush ? 'Push ativo ✓' : 'Ativar notificação push no celular'}
        </button>
        <div style="font-size:11px;color:#999;text-align:center;margin-top:7px;line-height:1.5">
          Funciona no Chrome (Android) e Safari 16.4+ (iOS)
        </div>
      </div>

      <!-- Share -->
      <div class="dcard">
        <h3>Compartilhar rastreio</h3>
        <input class="share-input" value="${shareUrl}" readonly onclick="this.select()">
        <button class="btn-yellow" style="width:100%;padding:12px;border-radius:var(--r);font-weight:600"
          onclick="copyLink('${shareUrl}')">
          Copiar Link
        </button>
      </div>
    </div>`;

  // Refresh button
  document.getElementById('detail-refresh-btn').onclick = async () => {
    const btn = document.getElementById('detail-refresh-btn');
    btn.textContent = '⏳ Atualizando...';
    btn.disabled = true;
    try {
      const res = await api('POST', `/packages/${pkg.id}/refresh`);
      const idx = allPackages.findIndex(p => p.id === pkg.id);
      if (idx !== -1) allPackages[idx] = res.package;
      renderDetail(res.package);
      toast(res.hasChange ? '🔔 Status atualizado!' : '✓ Sem novidades ainda', res.hasChange ? 'success' : 'info');
    } catch (e) {
      toast('Erro: ' + e.message, 'error');
    } finally {
      btn.textContent = '⟳ Atualizar';
      btn.disabled = false;
    }
  };
}

function copyLink(url) {
  navigator.clipboard.writeText(url).then(() => toast('🔗 Link copiado!', 'success')).catch(() => toast('Não foi possível copiar.', 'error'));
}

// ── ADD PACKAGE ────────────────────────────
function openAddModal() {
  document.getElementById('inp-code').value = '';
  document.getElementById('inp-desc').value = '';
  document.getElementById('inp-email').value = '';
  document.getElementById('inp-phone').value = '';
  document.getElementById('modal-err').style.display = 'none';
  document.getElementById('modal-add').classList.add('open');
  setTimeout(() => document.getElementById('inp-code').focus(), 80);
}

function closeAddModal() {
  document.getElementById('modal-add').classList.remove('open');
}

document.getElementById('modal-add').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeAddModal();
});

document.getElementById('btn-add-submit').addEventListener('click', submitAdd);
document.getElementById('inp-code').addEventListener('keydown', e => { if (e.key === 'Enter') submitAdd(); });

async function submitAdd() {
  const code        = document.getElementById('inp-code').value.trim().toUpperCase();
  const description = document.getElementById('inp-desc').value.trim();
  const email       = document.getElementById('inp-email').value.trim();
  const phone       = document.getElementById('inp-phone').value.trim();
  const errEl       = document.getElementById('modal-err');

  errEl.style.display = 'none';
  if (!code) { errEl.textContent = 'Digite o código de rastreio.'; errEl.style.display = 'block'; return; }

  const btn = document.getElementById('btn-add-submit');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Consultando...';

  try {
    const res = await api('POST', '/packages', { trackingCode: code, description, email, phone });
    allPackages.unshift(res.package);
    const stats = await api('GET', '/status');
    renderStats(stats);
    renderPackages(allPackages);
    closeAddModal();
    toast(res.warning ? '⚠️ Código adicionado — aguardando Correios' : '✅ Encomenda adicionada!', res.warning ? 'info' : 'success', 4000);
    openDetail(res.package.id);
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Adicionar e rastrear';
  }
}

// ── TABS ───────────────────────────────────
document.querySelectorAll('.contact-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.contact-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab)?.classList.add('active');
  });
});

// ── EMAIL SUBSCRIPTION ─────────────────────
async function addEmailSub(id) {
  const email = document.getElementById('detail-email-inp')?.value.trim();
  if (!email) return;
  try {
    await api('POST', `/packages/${id}/subscribe/email`, { email });
    toast(`✅ ${email} adicionado!`, 'success');
    const full = await api('GET', `/packages/${id}`);
    const idx = allPackages.findIndex(p => p.id === id);
    if (idx !== -1) allPackages[idx] = full;
    renderDetail(full);
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

// ── PUSH NOTIFICATIONS ─────────────────────
let _vapidKey = null;

async function getVapidKey() {
  if (_vapidKey) return _vapidKey;
  const r = await api('GET', '/push/vapid-public-key');
  _vapidKey = r.publicKey;
  return _vapidKey;
}

function b64ToUint8(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return new Uint8Array([...raw].map(c => c.charCodeAt(0)));
}

async function togglePush(packageId) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    toast('Navegador não suporta push. Use Chrome ou Safari 16.4+.', 'error', 5000);
    return;
  }
  const btn = document.getElementById(`btn-push-${packageId}`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Aguarde...'; }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Permissão de notificação negada.', 'error', 5000); return; }
    const reg = await navigator.serviceWorker.ready;
    const key = await getVapidKey();
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(key) });
    await api('POST', '/push/subscribe', { packageId, subscription: sub });
    toast('🔔 Push ativado!', 'success');
    const full = await api('GET', `/packages/${packageId}`);
    const idx = allPackages.findIndex(p => p.id === packageId);
    if (idx !== -1) allPackages[idx] = full;
    renderDetail(full);
  } catch (e) {
    toast('Erro push: ' + e.message, 'error', 5000);
    if (btn) { btn.disabled = false; btn.textContent = '🔔 Ativar notificação push no celular'; }
  }
}

// ── SERVICE WORKER ─────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js')
    .then(r => console.log('[SW]', r.scope))
    .catch(e => console.warn('[SW]', e));
}

// ── HASH ROUTING ───────────────────────────
function handleHash() {
  const h = location.hash;
  if (!h || h === '#' || h === '#landing') { showView('landing'); return; }
  if (h === '#dashboard') { showView('dashboard'); loadAll(); return; }
  if (h.startsWith('#package/')) {
    const id = parseInt(h.split('/')[1]);
    if (!isNaN(id)) {
      showView('dashboard');
      loadAll().then(() => openDetail(id));
    }
  }
}

window.addEventListener('hashchange', handleHash);
handleHash(); // initial
