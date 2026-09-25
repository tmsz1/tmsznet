'use strict';
/**
 * خادم منصة أثر الخيرية
 * - يقدّم ملفات الموقع من مجلد public
 * - يستقبل طلبات التبرع ويحفظها في ملف JSON
 * - يوفر واجهة تتبع للمتبرع ولوحة تحكم إدارية محمية بكلمة مرور
 * - يرسل إشعارات واتساب عند تغيّر حالة الطلب (عند تفعيل WhatsApp Cloud API)
 * لا يحتاج أي مكتبات خارجية: node server.js
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

loadEnvFile(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'donations.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const WA_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';
const WA_TEMPLATE = process.env.WHATSAPP_TEMPLATE || '';
const WA_TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || 'ar';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) {
  console.error('يجب ضبط ADMIN_PASSWORD (8 أحرف على الأقل) في ملف .env أو متغيرات البيئة.');
  process.exit(1);
}

// مراحل الطلب بالترتيب كما تظهر للمتبرع
const STATUSES = [
  { key: 'new', label: 'تم استلام الطلب', notify: 'تم استلام طلب تبرعك بنجاح، وسيتواصل معك فريقنا قريبًا.' },
  { key: 'contacted', label: 'تم التواصل', notify: 'تواصل معك فريقنا بخصوص طلب تبرعك.' },
  { key: 'scheduled', label: 'تم تحديد موعد الاستلام', notify: 'تم تحديد موعد استلام تبرعك.' },
  { key: 'picked', label: 'تم استلام التبرع', notify: 'استلمنا تبرعك، شكرًا لعطائك! نعمل الآن على فرزه وتجهيزه.' },
  { key: 'sorting', label: 'قيد الفرز والتجهيز', notify: 'تبرعك الآن قيد الفرز والتجهيز ليصل بأفضل حال.' },
  { key: 'delivered', label: 'وصل لأسرة مستفيدة', notify: 'بشرى سارة 🌱 تبرعك وصل إلى أسرة مستفيدة. جزاك الله خيرًا وجعله في ميزان حسناتك.' }
];
const CANCELLED = { key: 'cancelled', label: 'ملغي', notify: 'تم إلغاء طلب تبرعك. للاستفسار تواصل معنا.' };
const ALL_STATUSES = [...STATUSES, CANCELLED];
const statusByKey = Object.fromEntries(ALL_STATUSES.map((s) => [s.key, s]));
const DONATION_TYPES = ['أثاث', 'ملابس', 'أجهزة منزلية', 'مفارش وبطانيات'];

// ================= التخزين =================
fs.mkdirSync(DATA_DIR, { recursive: true });
let donations = [];
if (fs.existsSync(DATA_FILE)) {
  donations = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
let writeChain = Promise.resolve();
function persist() {
  const snapshot = JSON.stringify(donations, null, 2);
  // كتابة ذرّية ومتسلسلة لتجنب تلف الملف
  writeChain = writeChain.then(async () => {
    const tmp = `${DATA_FILE}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, snapshot);
    await fs.promises.rename(tmp, DATA_FILE);
  }).catch((err) => console.error('فشل حفظ البيانات:', err));
  return writeChain;
}

// ================= أدوات مساعدة =================
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function clean(value, max = 200) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  const m = digits.match(/^(?:00966|966|0)?(5\d{8})$/);
  return m ? `0${m[1]}` : null;
}
const toIntlPhone = (local) => `966${local.slice(1)}`;

// يحوّل قيمة datetime-local إلى نص عربي مقروء للمتبرع
function formatPickup(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || '')) return value || '';
  return new Date(value).toLocaleString('ar-SA-u-ca-gregory', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
}

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = 'ATR-' + Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
  } while (donations.some((d) => d.code === code));
  return code;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

// محدد معدل بسيط لكل عنوان IP
function rateLimiter(limit, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now > entry.reset) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}
const donateLimit = rateLimiter(10, 60 * 60 * 1000);
const trackLimit = rateLimiter(30, 15 * 60 * 1000);
const loginLimit = rateLimiter(10, 15 * 60 * 1000);

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readJson(req, maxBytes = 20 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(Object.assign(new Error('حجم الطلب كبير جدًا'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('صيغة البيانات غير صحيحة'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// ================= الإشعارات =================
function buildMessage(donation, statusKey, extra) {
  const s = statusByKey[statusKey];
  const lines = [
    `مرحبًا ${donation.name} 👋`,
    s.notify,
    statusKey === 'scheduled' && donation.pickupDate ? `📅 موعد الاستلام: ${formatPickup(donation.pickupDate)}` : '',
    extra ? `📝 ${extra}` : '',
    `رقم الطلب: ${donation.code}`,
    `تابع طلبك: ${SITE_URL}/track.html?code=${donation.code}`,
    'منصة أثر 🌱'
  ];
  return lines.filter(Boolean).join('\n');
}

async function sendWhatsApp(donation, statusKey, message) {
  if (!WA_TOKEN || !WA_PHONE_ID) return { channel: 'manual', ok: false, info: 'واتساب API غير مفعّل، أرسل الرسالة يدويًا' };
  // خارج نافذة الـ24 ساعة تشترط Meta قالبًا معتمدًا؛ نستخدمه إن وُجد
  const body = WA_TEMPLATE
    ? {
        messaging_product: 'whatsapp', to: toIntlPhone(donation.phone), type: 'template',
        template: {
          name: WA_TEMPLATE, language: { code: WA_TEMPLATE_LANG },
          components: [{ type: 'body', parameters: [
            { type: 'text', text: donation.name },
            { type: 'text', text: statusByKey[statusKey].label },
            { type: 'text', text: donation.code }
          ] }]
        }
      }
    : { messaging_product: 'whatsapp', to: toIntlPhone(donation.phone), type: 'text', text: { body: message } };
  try {
    const r = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) return { channel: 'whatsapp', ok: false, info: `رفض واتساب الإرسال (${r.status})` };
    return { channel: 'whatsapp', ok: true, info: 'أُرسل عبر واتساب' };
  } catch (err) {
    return { channel: 'whatsapp', ok: false, info: `تعذّر الاتصال بواتساب: ${err.message}` };
  }
}

async function notify(donation, statusKey, extra) {
  const message = buildMessage(donation, statusKey, extra);
  const result = await sendWhatsApp(donation, statusKey, message);
  donation.notifications.push({ at: new Date().toISOString(), status: statusKey, ...result });
  return {
    ...result,
    message,
    manualLink: `https://wa.me/${toIntlPhone(donation.phone)}?text=${encodeURIComponent(message)}`
  };
}

// ================= الجلسات الإدارية =================
const sessions = new Map();
function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}
function isAuthed(req) {
  const m = (req.headers.authorization || '').match(/^Bearer ([a-f0-9]{64})$/);
  if (!m) return false;
  const exp = sessions.get(m[1]);
  if (!exp || exp < Date.now()) { sessions.delete(m[1]); return false; }
  return true;
}

// ================= المسارات =================
function publicView(d) {
  return {
    code: d.code,
    status: d.status,
    statusLabel: statusByKey[d.status].label,
    types: d.types,
    city: d.city,
    pickupDate: formatPickup(d.pickupDate) || null,
    createdAt: d.createdAt,
    history: d.history.map((h) => ({ status: h.status, label: statusByKey[h.status].label, at: h.at }))
  };
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const ip = clientIp(req);

  if (route === 'GET /api/statuses') {
    return send(res, 200, { statuses: STATUSES.map(({ key, label }) => ({ key, label })), cancelled: { key: CANCELLED.key, label: CANCELLED.label } });
  }

  if (route === 'GET /api/stats') {
    const active = donations.filter((d) => d.status !== 'cancelled');
    return send(res, 200, {
      total: active.length,
      delivered: active.filter((d) => d.status === 'delivered').length,
      items: active.reduce((sum, d) => sum + (d.quantity || 0), 0),
      cities: new Set(active.map((d) => d.city)).size
    }, { 'Cache-Control': 'public, max-age=60' });
  }

  if (route === 'POST /api/donations') {
    if (!donateLimit(ip)) return send(res, 429, { error: 'عدد الطلبات كبير، حاول لاحقًا' });
    const b = await readJson(req);
    const phone = normalizePhone(b.phone);
    const types = Array.isArray(b.types) ? b.types.filter((t) => DONATION_TYPES.includes(t)) : [];
    const name = clean(b.name, 80);
    const city = clean(b.city, 60);
    if (!name) return send(res, 400, { error: 'الاسم مطلوب' });
    if (!phone) return send(res, 400, { error: 'رقم الجوال غير صحيح' });
    if (!city) return send(res, 400, { error: 'المدينة مطلوبة' });
    if (!types.length) return send(res, 400, { error: 'اختر نوع التبرع' });
    const lat = Number(b.lat);
    const lng = Number(b.lng);
    const hasLoc = b.lat !== '' && b.lat != null && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    const now = new Date().toISOString();
    const donation = {
      id: crypto.randomUUID(),
      code: makeCode(),
      name, phone, city,
      district: clean(b.district, 60),
      address: clean(b.address, 200),
      location: hasLoc ? { lat, lng } : null,
      types,
      details: clean(b.details, 1000),
      quantity: Math.min(Math.max(parseInt(b.quantity, 10) || 0, 0), 999),
      preferredTime: clean(b.time, 30),
      status: 'new',
      pickupDate: '',
      assignee: '',
      notes: [],
      history: [{ status: 'new', at: now }],
      notifications: [],
      createdAt: now,
      updatedAt: now
    };
    donations.push(donation);
    await persist();
    notify(donation, 'new').then(persist); // تأكيد الاستلام للمتبرع دون تأخير الاستجابة
    return send(res, 201, { code: donation.code });
  }

  if (route === 'POST /api/track') {
    if (!trackLimit(ip)) return send(res, 429, { error: 'محاولات كثيرة، حاول بعد قليل' });
    const b = await readJson(req);
    const code = clean(b.code, 20).toUpperCase();
    const last4 = String(b.phoneLast4 || '').replace(/\D/g, '');
    const d = donations.find((x) => x.code === code);
    if (!d || last4.length !== 4 || !d.phone.endsWith(last4)) {
      return send(res, 404, { error: 'لم نجد طلبًا بهذه البيانات، تأكد من رقم الطلب وآخر 4 أرقام من جوالك' });
    }
    return send(res, 200, publicView(d));
  }

  if (route === 'POST /api/admin/login') {
    if (!loginLimit(ip)) return send(res, 429, { error: 'محاولات كثيرة، حاول بعد 15 دقيقة' });
    const b = await readJson(req);
    if (!safeEqual(b.password || '', ADMIN_PASSWORD)) return send(res, 401, { error: 'كلمة المرور غير صحيحة' });
    return send(res, 200, { token: createSession() });
  }

  // ---------- المسارات المحمية ----------
  if (url.pathname.startsWith('/api/admin/')) {
    if (!isAuthed(req)) return send(res, 401, { error: 'انتهت الجلسة، سجّل الدخول مجددًا' });

    if (route === 'POST /api/admin/logout') {
      sessions.delete(req.headers.authorization.slice(7));
      return send(res, 200, { ok: true });
    }

    if (route === 'GET /api/admin/donations') {
      const status = url.searchParams.get('status');
      const city = url.searchParams.get('city');
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      let list = donations;
      if (status) list = list.filter((d) => d.status === status);
      if (city) list = list.filter((d) => d.city === city);
      if (q) list = list.filter((d) => [d.code, d.name, d.phone, d.district, d.details].join(' ').toLowerCase().includes(q));
      const counts = Object.fromEntries(ALL_STATUSES.map((s) => [s.key, donations.filter((d) => d.status === s.key).length]));
      return send(res, 200, {
        donations: [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        counts,
        cities: [...new Set(donations.map((d) => d.city))].sort(),
        statuses: ALL_STATUSES.map(({ key, label }) => ({ key, label }))
      });
    }

    const m = url.pathname.match(/^\/api\/admin\/donations\/([0-9a-f-]{36})$/);
    if (m && req.method === 'PATCH') {
      const d = donations.find((x) => x.id === m[1]);
      if (!d) return send(res, 404, { error: 'الطلب غير موجود' });
      const b = await readJson(req);
      const now = new Date().toISOString();
      if (b.pickupDate !== undefined) d.pickupDate = clean(b.pickupDate, 40);
      if (b.assignee !== undefined) d.assignee = clean(b.assignee, 60);
      if (b.note) d.notes.push({ at: now, text: clean(b.note, 1000) });
      let notification = null;
      if (b.status && b.status !== d.status) {
        if (!statusByKey[b.status]) return send(res, 400, { error: 'حالة غير معروفة' });
        d.status = b.status;
        d.history.push({ status: b.status, at: now });
        if (b.notify !== false) notification = await notify(d, b.status, clean(b.message, 300));
      }
      d.updatedAt = now;
      await persist();
      return send(res, 200, { donation: d, notification });
    }

    if (route === 'GET /api/admin/export.csv') {
      const cols = ['code', 'createdAt', 'status', 'name', 'phone', 'city', 'district', 'address', 'types', 'quantity', 'details', 'pickupDate', 'assignee', 'map'];
      const esc = (v) => {
        let s = String(v ?? '');
        if (/^[=+\-@]/.test(s)) s = `'${s}`; // منع حقن الصيغ في Excel
        return `"${s.replace(/"/g, '""')}"`;
      };
      const rows = donations.map((d) => cols.map((c) => esc(
        c === 'types' ? d.types.join('، ')
          : c === 'status' ? statusByKey[d.status].label
          : c === 'map' ? (d.location ? `https://maps.google.com/?q=${d.location.lat},${d.location.lng}` : '')
          : d[c]
      )).join(','));
      return send(res, 200, '﻿' + [cols.join(','), ...rows].join('\n'), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="donations.csv"'
      });
    }
  }

  return send(res, 404, { error: 'غير موجود' });
}

// ================= الملفات الثابتة =================
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8'
};
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  if (rel === '/admin') rel = '/admin.html';
  if (rel === '/track') rel = '/track.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'ممنوع');
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, 'الصفحة غير موجودة');
    const headers = {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    };
    if (file.endsWith('admin.html')) headers['X-Frame-Options'] = 'DENY';
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'غير مسموح');
    return serveStatic(req, res, url);
  } catch (err) {
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'حدث خطأ في الخادم' });
    if (!err.status) console.error(err);
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`منصة أثر تعمل على ${SITE_URL}  | لوحة التحكم: ${SITE_URL}/admin`));
}
module.exports = { server, STATUSES };
