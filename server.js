'use strict';
require('dotenv').config();

const express = require('express');
const nodemailer = require('nodemailer');
const webpush = require('web-push');
const cron = require('node-cron');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

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
// ROUTES
// ──────────────────────────────────────────
app.get('/api/push/vapid-public-key', (_req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/push/subscribe', (req, res) => {
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

app.get('/api/packages', (_req, res) => {
  res.json(db.pkgList());
});

app.get('/api/packages/:id', (req, res) => {
  const id = Number(req.params.id);
  const pkg = db.pkgById(id);
  if (!pkg) return res.status(404).json({ error: 'Pacote não encontrado' });
  res.json(pkg);
});

app.post('/api/packages', async (req, res) => {
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

app.post('/api/packages/:id/subscribe/email', (req, res) => {
  const id = Number(req.params.id);
  const { email } = req.body;
  if (!email || !/\S+@\S+\.\S+/.test(email)) return res.status(400).json({ error: 'Email inválido' });
  const pkg = db.pkgById(id);
  if (!pkg) return res.status(404).json({ error: 'Pacote não encontrado' });
  db.subAdd(id, 'email', email.toLowerCase().trim());
  res.json({ success: true });
});

app.post('/api/packages/:id/subscribe/phone', (req, res) => {
  const id = Number(req.params.id);
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Telefone inválido' });
  if (!twilioClient) return res.status(503).json({ error: 'SMS não configurado. Configure TWILIO_* no .env' });
  const pkg = db.pkgById(id);
  if (!pkg) return res.status(404).json({ error: 'Pacote não encontrado' });
  db.subAdd(id, 'sms', phone.trim());
  res.json({ success: true });
});

app.post('/api/packages/:id/refresh', async (req, res) => {
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

app.delete('/api/packages/:id', (req, res) => {
  const id = Number(req.params.id);
  const pkg = db.pkgById(id);
  if (!pkg) return res.status(404).json({ error: 'Pacote não encontrado' });
  db.pkgDelete(id);
  res.json({ success: true });
});

app.get('/api/status', (_req, res) => {
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
