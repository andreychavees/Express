'use strict';
require('dotenv').config();

const express = require('express');
const nodemailer = require('nodemailer');
const webpush = require('web-push');
const cron = require('node-cron');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ──────────────────────────────────────────
// JSON STORE (sem dependências nativas)
// ──────────────────────────────────────────
const DB_FILE = path.join(__dirname, 'data.json');
let store = { packages: [], _nextId: 1 };

function dbLoad() {
  try {
    if (fs.existsSync(DB_FILE)) {
      store = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[DB] Erro ao carregar:', e.message);
  }
  store.packages = store.packages || [];
  store._nextId = store._nextId || 1;
}

function dbSave() {
  fs.writeFileSync(DB_FILE, JSON.stringify(store, null, 2));
}

function nextId() {
  const id = store._nextId++;
  dbSave();
  return id;
}

dbLoad();

// CRUD helpers
const db = {
  pkgList: () => [...store.packages],
  pkgById: (id) => store.packages.find(p => p.id === id),
  pkgByCode: (code) => store.packages.find(p => p.tracking_code === code),
  pkgAdd(data) {
    const pkg = {
      id: nextId(),
      tracking_code: data.tracking_code,
      description: data.description || '',
      service_type: data.service_type || '',
      last_status: data.last_status || '',
      events: data.events || [],
      last_checked: 0,
      created_at: Math.floor(Date.now() / 1000),
      is_delivered: data.is_delivered || 0,
      subscriptions: []
    };
    store.packages.unshift(pkg);
    dbSave();
    return pkg;
  },
  pkgUpdate(id, updates) {
    const idx = store.packages.findIndex(p => p.id === id);
    if (idx === -1) return null;
    Object.assign(store.packages[idx], updates);
    dbSave();
    return store.packages[idx];
  },
  pkgDelete(id) {
    store.packages = store.packages.filter(p => p.id !== id);
    dbSave();
  },
  subAdd(packageId, type, contact) {
    const pkg = db.pkgById(packageId);
    if (!pkg) return null;
    if (!pkg.subscriptions) pkg.subscriptions = [];
    const exists = pkg.subscriptions.find(s => s.type === type && s.contact === contact);
    if (exists) return exists;
    const sub = { id: nextId(), type, contact };
    pkg.subscriptions.push(sub);
    dbSave();
    return sub;
  },
  subRemove(subId) {
    for (const pkg of store.packages) {
      if (pkg.subscriptions) {
        const len = pkg.subscriptions.length;
        pkg.subscriptions = pkg.subscriptions.filter(s => s.id !== subId);
        if (pkg.subscriptions.length !== len) { dbSave(); return; }
      }
    }
  }
};

// ──────────────────────────────────────────
// AUTH — Users store + JWT
// ──────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  const s = crypto.randomBytes(32).toString('hex');
  console.warn('[Auth] JWT_SECRET não definido — usando chave temporária. Defina JWT_SECRET no .env para produção!');
  return s;
})();

const USERS_FILE = path.join(__dirname, 'users.json');
let uStore = { users: [], _nextId: 1 };

function uLoad() {
  try { if (fs.existsSync(USERS_FILE)) uStore = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch(e) {}
  uStore.users   = uStore.users   || [];
  uStore._nextId = uStore._nextId || 1;
}
function uSave() { fs.writeFileSync(USERS_FILE, JSON.stringify(uStore, null, 2)); }
uLoad();

const udb = {
  byEmail:  (e)  => uStore.users.find(u => u.email === e.toLowerCase()),
  byGoogle: (id) => uStore.users.find(u => u.google_id === id),
  byToken:  (t)  => uStore.users.find(u => u.verify_token === t),
  byId:     (id) => uStore.users.find(u => u.id === id),
  create(d) {
    const u = {
      id: uStore._nextId++, name: d.name, email: d.email.toLowerCase(),
      password_hash: d.password_hash || null, google_id: d.google_id || null,
      verified: d.verified ?? false, verify_token: d.verify_token || null,
      created_at: Math.floor(Date.now() / 1000)
    };
    uStore.users.push(u); uSave(); return u;
  },
  update(id, data) {
    const i = uStore.users.findIndex(u => u.id === id);
    if (i === -1) return null;
    Object.assign(uStore.users[i], data); uSave(); return uStore.users[i];
  }
};

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'andreychaves2009@gmail.com').toLowerCase();
const isAdmin = (email) => email?.toLowerCase() === ADMIN_EMAIL;

function makeToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, admin: isAdmin(user.email) },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Não autenticado' });
  try { req.user = jwt.verify(h.slice(7), JWT_SECRET); next(); }
  catch(e) { res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' }); }
}

function requireAdmin(req, res, next) {
  if (!req.user?.admin) return res.status(403).json({ error: 'Acesso restrito ao administrador.' });
  next();
}

// ──────────────────────────────────────────
// VAPID / WEB PUSH
// ──────────────────────────────────────────
const vapidFile = path.join(__dirname, 'vapid-keys.json');
let vapidKeys;

if (fs.existsSync(vapidFile)) {
  vapidKeys = JSON.parse(fs.readFileSync(vapidFile, 'utf8'));
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(vapidFile, JSON.stringify(vapidKeys, null, 2));
  console.log('[Push] Chaves VAPID geradas e salvas.');
}

webpush.setVapidDetails(
  `mailto:${process.env.EMAIL_USER || 'rastreio@localhost.com'}`,
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// ──────────────────────────────────────────
// EMAIL
// ──────────────────────────────────────────
let emailTransporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  emailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
  });
  emailTransporter.verify().then(() => {
    console.log('[Email] Gmail conectado ✓');
  }).catch(err => {
    console.warn('[Email] Falha na autenticação Gmail:', err.message);
    emailTransporter = null;
  });
}

// ──────────────────────────────────────────
// TWILIO SMS (opcional)
// ──────────────────────────────────────────
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  try {
    const twilio = require('twilio');
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    console.log('[SMS] Twilio configurado ✓');
  } catch (e) {
    console.warn('[SMS] Twilio não instalado.');
  }
}

// ──────────────────────────────────────────
// TRACKING API
// ──────────────────────────────────────────
function parseDateTime(dtStr) {
  if (!dtStr) return { date: '', time: '' };
  try {
    const d = new Date(dtStr);
    if (isNaN(d)) return { date: dtStr, time: '' };
    return {
      date: d.toLocaleDateString('pt-BR'),
      time: d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    };
  } catch {
    return { date: dtStr, time: '' };
  }
}

function normalizeCorreios(obj, code) {
  const eventos = (obj.eventos || []).map(e => {
    const { date, time } = parseDateTime(e.dtHrCriado);
    const end = e.unidade?.endereco || {};
    const local = [end.cidade, end.uf].filter(Boolean).join(' / ');
    const subStatuses = (e.subEventos || []).map(s => s.descricao).filter(Boolean);
    return {
      date,
      time,
      status: e.descricao || '',
      location: e.unidade?.nome ? `${e.unidade.nome}${local ? ' - ' + local : ''}` : local,
      detail: subStatuses.join(' • ')
    };
  });
  return {
    code,
    service: obj.tipoPostal?.descricao || obj.tipoPostal?.categoria || '',
    events: eventos,
    latestStatus: eventos[0]?.status || 'Sem informações'
  };
}

function normalizeLinkeTrack(data, code) {
  const eventos = (data.eventos || []).map(e => ({
    date: e.data || '',
    time: e.hora || '',
    status: e.status || '',
    location: e.local || '',
    detail: (e.subStatus || []).filter(s => s?.trim()).join(' • ')
  }));
  return {
    code,
    service: data.servico || '',
    events: eventos,
    latestStatus: eventos[0]?.status || 'Sem informações'
  };
}

const TRACK_HEADERS = {
  'User-Agent': 'CorreiosMobile/7.0 (Android 13; SM-G990B)',
  'Accept': 'application/json',
  'Accept-Language': 'pt-BR,pt;q=0.9'
};

async function fetchFromCorreiosProxy(code) {
  // Mobile proxy endpoint (usado pelo app oficial dos Correios)
  const res = await axios.get(
    `https://proxyapp.correios.com.br/v1/sro-rastro/${code}`,
    { headers: TRACK_HEADERS, timeout: 15000 }
  );
  if (!res.data?.objetos?.length) throw new Error('Sem resultado');
  return normalizeCorreios(res.data.objetos[0], code);
}

async function fetchFromCorreiosWeb(code) {
  // Endpoint web principal
  const res = await axios.post(
    'https://rastreamento.correios.com.br/rest/rastro/rastroJSON/',
    { objetos: code },
    {
      headers: {
        ...TRACK_HEADERS,
        'Content-Type': 'application/json',
        'Origin': 'https://rastreamento.correios.com.br',
        'Referer': 'https://rastreamento.correios.com.br/'
      },
      timeout: 15000
    }
  );
  if (!res.data?.objetos?.length) throw new Error('Sem resultado');
  return normalizeCorreios(res.data.objetos[0], code);
}

async function fetchFromLinkeTrack(code) {
  const user = process.env.LINKETRACK_USER || 'teste';
  const token = process.env.LINKETRACK_TOKEN || '1abcd00b2731640422b9e7e3fdc96668d47';
  const res = await axios.get(
    `https://api.linketrack.com/track/json?user=${user}&token=${token}&codigo=${code}`,
    { headers: TRACK_HEADERS, timeout: 15000 }
  );
  if (!res.data || res.data.eventos === undefined) throw new Error('Resposta inválida');
  return normalizeLinkeTrack(res.data, code);
}

async function fetchTracking(code) {
  const sources = [
    { name: 'Proxy Correios', fn: () => fetchFromCorreiosProxy(code) },
    { name: 'Web Correios', fn: () => fetchFromCorreiosWeb(code) },
    { name: 'LinkeTrack', fn: () => fetchFromLinkeTrack(code) }
  ];

  for (const src of sources) {
    try {
      const r = await src.fn();
      console.log(`[Track] ✓ ${src.name} para ${code}`);
      return r;
    } catch (e) {
      console.warn(`[Track] ${src.name} falhou (${code}): ${e.message}`);
    }
  }

  // Retorna resultado vazio mas não lança erro — permite adicionar o código
  // O cron tentará novamente mais tarde
  return {
    code,
    service: '',
    events: [],
    latestStatus: 'Aguardando informações dos Correios'
  };
}

// ──────────────────────────────────────────
// NOTIFICATIONS
// ──────────────────────────────────────────
function buildEmailHtml(pkg, event) {
  const colorMap = s => {
    if (!s) return '#6B7280';
    const l = s.toLowerCase();
    if (l.includes('entregue')) return '#10B981';
    if (l.includes('saiu para entrega') || l.includes('trânsito') || l.includes('transito')) return '#3B82F6';
    if (l.includes('devolvido') || l.includes('retornado')) return '#EF4444';
    return '#F59E0B';
  };
  const color = colorMap(event.status);
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:Arial,sans-serif">
<div style="max-width:600px;margin:30px auto;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.1)">
  <div style="background:linear-gradient(135deg,#FFB800,#FF8C00);padding:28px 30px;text-align:center">
    <div style="font-size:40px;margin-bottom:8px">📦</div>
    <h1 style="margin:0;color:#1C1C2E;font-size:22px;font-weight:700">Atualização de Rastreio</h1>
  </div>
  <div style="background:white;padding:30px">
    <p style="color:#999;font-size:12px;text-transform:uppercase;margin:0 0 4px;letter-spacing:1px">Código de rastreio</p>
    <p style="color:#1C1C2E;font-size:20px;font-weight:700;font-family:monospace;margin:0 0 16px;background:#f8f8f8;padding:8px 12px;border-radius:6px;display:inline-block">${pkg.tracking_code}</p>
    ${pkg.description ? `<p style="color:#666;font-size:14px;margin:0 0 16px">Encomenda: <strong>${pkg.description}</strong></p>` : ''}
    <div style="background:#FFF8E1;border-left:4px solid #FFB800;padding:16px 20px;border-radius:6px;margin-bottom:20px">
      <p style="margin:0 0 6px;color:#999;font-size:11px;text-transform:uppercase;letter-spacing:.5px">Novo Status</p>
      <p style="margin:0;color:#1C1C2E;font-size:17px;font-weight:600">${event.status}</p>
      ${event.location ? `<p style="margin:6px 0 0;color:#555;font-size:14px">📍 ${event.location}</p>` : ''}
      ${event.date ? `<p style="margin:4px 0 0;color:#555;font-size:13px">🕐 ${event.date}${event.time ? ' às ' + event.time : ''}</p>` : ''}
      ${event.detail ? `<p style="margin:6px 0 0;color:#777;font-size:13px;font-style:italic">${event.detail}</p>` : ''}
    </div>
    <p style="color:#aaa;font-size:11px;text-align:center;margin-top:24px">
      Rastreio Correios • ${new Date().getFullYear()}<br>
      Você recebe este email porque se inscreveu para acompanhar esta encomenda.
    </p>
  </div>
</div>
</body></html>`;
}

async function sendEmailNotification(email, pkg, event) {
  if (!emailTransporter) return;
  try {
    await emailTransporter.sendMail({
      from: `"Rastreio Correios" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: `📦 ${pkg.tracking_code} — ${event.status}`,
      html: buildEmailHtml(pkg, event)
    });
    console.log(`[Email] ✓ ${email} (${pkg.tracking_code})`);
  } catch (err) {
    console.error(`[Email] Falha:`, err.message);
  }
}

async function sendSmsNotification(phone, pkg, event) {
  if (!twilioClient) return;
  try {
    await twilioClient.messages.create({
      body: `📦 ${pkg.tracking_code}\n${event.status}${event.location ? '\n📍 ' + event.location : ''}`,
      from: process.env.TWILIO_FROM_NUMBER,
      to: phone
    });
    console.log(`[SMS] ✓ ${phone} (${pkg.tracking_code})`);
  } catch (err) {
    console.error(`[SMS] Falha:`, err.message);
  }
}

async function sendPushNotification(sub, pkg, event) {
  try {
    await webpush.sendNotification(
      JSON.parse(sub.contact),
      JSON.stringify({
        title: `📦 ${pkg.tracking_code}`,
        body: `${event.status}${event.location ? '\n📍 ' + event.location : ''}`,
        data: { packageId: pkg.id }
      })
    );
    console.log(`[Push] ✓ ${pkg.tracking_code}`);
  } catch (err) {
    console.error(`[Push] Falha:`, err.message);
    if (err.statusCode === 410 || err.statusCode === 404) {
      db.subRemove(sub.id);
    }
  }
}

async function notifyAll(pkg, event) {
  const subs = pkg.subscriptions || [];
  for (const sub of subs) {
    if (sub.type === 'email') await sendEmailNotification(sub.contact, pkg, event);
    else if (sub.type === 'sms') await sendSmsNotification(sub.contact, pkg, event);
    else if (sub.type === 'push') await sendPushNotification(sub, pkg, event);
  }
}

// ──────────────────────────────────────────
// UPDATE LOGIC
// ──────────────────────────────────────────
async function updatePackage(pkg) {
  const tracking = await fetchTracking(pkg.tracking_code);
  const prevLatest = pkg.events?.[0]?.status || '';
  const newLatest = tracking.events[0]?.status || '';
  const hasChange = newLatest && newLatest !== prevLatest;
  const isDelivered = /entregue ao destinat/i.test(newLatest) ? 1 : 0;

  const updated = db.pkgUpdate(pkg.id, {
    service_type: tracking.service,
    last_status: newLatest,
    events: tracking.events,
    last_checked: Math.floor(Date.now() / 1000),
    is_delivered: isDelivered
  });

  if (hasChange && tracking.events.length > 0) {
    console.log(`[Update] ${pkg.tracking_code}: "${prevLatest}" → "${newLatest}"`);
    if (updated) await notifyAll(updated, tracking.events[0]);
  }

  return { hasChange, tracking };
}

// ──────────────────────────────────────────
// ROUTES — AUTH
// ──────────────────────────────────────────

// Config pública (Google Client ID para o frontend)
app.get('/api/auth/config', (_req, res) => {
  res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || null });
});

// Cadastro
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name?.trim() || !email?.trim() || !password)
    return res.status(400).json({ error: 'Preencha todos os campos.' });
  if (!/\S+@\S+\.\S+/.test(email))
    return res.status(400).json({ error: 'Email inválido.' });
  if (password.length < 6)
    return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres.' });
  if (udb.byEmail(email))
    return res.status(409).json({ error: 'Este email já está cadastrado.' });

  const password_hash = await bcrypt.hash(password, 10);
  const verify_token  = crypto.randomBytes(32).toString('hex');
  const verified      = !emailTransporter;

  const user = udb.create({ name: name.trim(), email, password_hash, verify_token, verified });

  if (emailTransporter && !verified) {
    const base = `${req.protocol}://${req.get('host')}`;
    await emailTransporter.sendMail({
      from: `"Entregue" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: '✉️ Confirme seu email — Entregue',
      html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px">
        <h2 style="color:#111827">Olá, ${name}! 👋</h2>
        <p style="color:#6B7280">Clique no botão abaixo para confirmar seu email e ativar sua conta:</p>
        <a href="${base}/api/auth/verify/${verify_token}"
           style="display:inline-block;background:#FFC800;color:#111827;font-weight:700;padding:14px 28px;border-radius:12px;text-decoration:none;margin:20px 0">
          ✅ Confirmar email
        </a>
        <p style="color:#9CA3AF;font-size:12px">Se você não se cadastrou no Entregue, ignore este email.</p>
      </div>`
    }).catch(e => console.error('[Auth] Email verificação:', e.message));
    return res.json({ success: true, requiresVerification: true });
  }

  res.json({ success: true, token: makeToken(user), user: { id: user.id, name: user.name, email: user.email } });
});

// Verificação de email
app.get('/api/auth/verify/:token', (req, res) => {
  const user = udb.byToken(req.params.token);
  if (!user) return res.status(400).send('<p style="font-family:sans-serif;text-align:center;padding:40px;color:#EF4444">Link inválido ou já utilizado.</p>');
  udb.update(user.id, { verified: true, verify_token: null });
  res.redirect('/?verified=1');
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Preencha email e senha.' });
  const user = udb.byEmail(email);
  if (!user || !user.password_hash) return res.status(401).json({ error: 'Email ou senha incorretos.' });
  if (!user.verified) return res.status(401).json({ error: 'Email não verificado. Verifique sua caixa de entrada.' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Email ou senha incorretos.' });
  res.json({ success: true, token: makeToken(user), user: { id: user.id, name: user.name, email: user.email } });
});

// Login com Google (verifica credential/ID token enviado pelo GIS no frontend)
app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Credencial inválida.' });
  try {
    const gRes = await axios.get(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
    const { email, name, sub: googleId, email_verified } = gRes.data;
    if (email_verified !== 'true') return res.status(401).json({ error: 'Email Google não verificado.' });

    let user = udb.byGoogle(googleId) || udb.byEmail(email);
    if (!user) {
      user = udb.create({ name, email, google_id: googleId, verified: true });
    } else if (!user.google_id) {
      udb.update(user.id, { google_id: googleId, verified: true });
      user = udb.byId(user.id);
    }
    res.json({ success: true, token: makeToken(user), user: { id: user.id, name: user.name, email: user.email } });
  } catch(e) {
    console.error('[Auth] Google:', e.message);
    res.status(401).json({ error: 'Falha na autenticação com Google.' });
  }
});

// Usuário atual
app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = udb.byId(req.user.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
  res.json({ id: user.id, name: user.name, email: user.email, admin: isAdmin(user.email) });
});

// Admin — lista todos os usuários
app.get('/api/admin/users', requireAuth, requireAdmin, (_req, res) => {
  const users = uStore.users.map(u => ({
    id: u.id, name: u.name, email: u.email,
    verified: u.verified, admin: isAdmin(u.email),
    google: !!u.google_id, created_at: u.created_at
  }));
  res.json(users);
});

// ──────────────────────────────────────────
// ROUTES — PUSH & PACKAGES (protegidas)
// ──────────────────────────────────────────
app.get('/api/push/vapid-public-key', (_req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const { packageId, subscription } = req.body;
  if (!packageId || !subscription) return res.status(400).json({ error: 'Dados inválidos' });
  const pkg = db.pkgById(packageId);
  if (!pkg) return res.status(404).json({ error: 'Pacote não encontrado' });

  // Remove old push sub if exists, then add new
  if (pkg.subscriptions) {
    pkg.subscriptions = pkg.subscriptions.filter(s => s.type !== 'push');
  }
  db.subAdd(packageId, 'push', JSON.stringify(subscription));
  res.json({ success: true });
});

app.get('/api/packages', requireAuth, (_req, res) => {
  res.json(db.pkgList());
});

app.get('/api/packages/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const pkg = db.pkgById(id);
  if (!pkg) return res.status(404).json({ error: 'Pacote não encontrado' });
  res.json(pkg);
});

app.post('/api/packages', requireAuth, async (req, res) => {
  const { trackingCode, description, email, phone } = req.body;
  if (!trackingCode) return res.status(400).json({ error: 'Código de rastreio é obrigatório' });

  const code = trackingCode.trim().toUpperCase().replace(/\s/g, '');
  const existing = db.pkgByCode(code);
  if (existing) return res.status(409).json({ error: 'Este código já está sendo rastreado', package: existing });

  try {
    // Tenta rastrear mas não falha se o código não tiver eventos ainda
    const tracking = await fetchTracking(code);
    const isDelivered = /entregue ao destinat/i.test(tracking.latestStatus) ? 1 : 0;

    const pkg = db.pkgAdd({
      tracking_code: code,
      description: (description || '').trim(),
      service_type: tracking.service,
      last_status: tracking.latestStatus,
      events: tracking.events,
      is_delivered: isDelivered
    });

    if (email && /\S+@\S+\.\S+/.test(email)) {
      db.subAdd(pkg.id, 'email', email.toLowerCase().trim());
    }
    if (phone && twilioClient) {
      db.subAdd(pkg.id, 'sms', phone.trim());
    }

    const noEvents = tracking.events.length === 0;
    res.json({
      success: true,
      package: db.pkgById(pkg.id),
      warning: noEvents ? 'O código foi adicionado mas os Correios ainda não têm informações disponíveis. O aplicativo verificará automaticamente a cada 30 minutos.' : undefined
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/packages/:id/subscribe/email', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const { email } = req.body;
  if (!email || !/\S+@\S+\.\S+/.test(email)) return res.status(400).json({ error: 'Email inválido' });
  const pkg = db.pkgById(id);
  if (!pkg) return res.status(404).json({ error: 'Pacote não encontrado' });
  db.subAdd(id, 'email', email.toLowerCase().trim());
  res.json({ success: true });
});

app.post('/api/packages/:id/subscribe/phone', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Telefone inválido' });
  if (!twilioClient) return res.status(503).json({ error: 'SMS não configurado. Configure TWILIO_* no .env' });
  const pkg = db.pkgById(id);
  if (!pkg) return res.status(404).json({ error: 'Pacote não encontrado' });
  db.subAdd(id, 'sms', phone.trim());
  res.json({ success: true });
});

app.post('/api/packages/:id/refresh', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const pkg = db.pkgById(id);
  if (!pkg) return res.status(404).json({ error: 'Pacote não encontrado' });
  try {
    const { hasChange } = await updatePackage(pkg);
    res.json({ success: true, hasChange, package: db.pkgById(id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/packages/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const pkg = db.pkgById(id);
  if (!pkg) return res.status(404).json({ error: 'Pacote não encontrado' });
  db.pkgDelete(id);
  res.json({ success: true });
});

app.get('/api/status', requireAuth, (_req, res) => {
  const all = db.pkgList();
  const delivered = all.filter(p => p.is_delivered).length;
  res.json({
    total: all.length,
    delivered,
    inTransit: all.length - delivered,
    emailConfigured: !!emailTransporter,
    smsConfigured: !!twilioClient
  });
});

// ──────────────────────────────────────────
// CRON — verifica a cada 30 minutos
// ──────────────────────────────────────────
cron.schedule('*/30 * * * *', async () => {
  const pending = db.pkgList().filter(p => !p.is_delivered);
  if (pending.length === 0) return;
  console.log(`[Cron] Verificando ${pending.length} pacote(s)...`);
  for (const pkg of pending) {
    try {
      await updatePackage(pkg);
    } catch (err) {
      console.error(`[Cron] Erro em ${pkg.tracking_code}:`, err.message);
    }
    await new Promise(r => setTimeout(r, 2500));
  }
  console.log('[Cron] Verificação concluída.');
});

// ──────────────────────────────────────────
// START
// ──────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n' + '═'.repeat(50));
  console.log('  📦 RASTREIO CORREIOS');
  console.log('═'.repeat(50));
  console.log(`  🌐 URL:   http://localhost:${PORT}`);
  console.log(`  📧 Email: ${emailTransporter ? 'Configurado ✓' : 'Não configurado (configure .env)'}`);
  console.log(`  📱 SMS:   ${twilioClient ? 'Configurado ✓' : 'Não configurado (opcional)'}`);
  console.log(`  🔔 Push:  Ativo ✓`);
  console.log(`  ⏱  Auto:  a cada 30 minutos`);
  console.log('═'.repeat(50) + '\n');
});
