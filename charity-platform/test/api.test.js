'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'athar-'));
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'test-password-123';
process.env.WHATSAPP_TOKEN = '';
const { server } = require('../server');

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const post = (p, body, token) => fetch(base + p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
  body: JSON.stringify(body)
});

const valid = { name: 'محمد', phone: '0551234567', city: 'الرياض', types: ['أثاث', 'ملابس'], quantity: '4', lat: '24.7', lng: '46.6' };

test('يرفض الطلب الناقص', async () => {
  const r = await post('/api/donations', { ...valid, phone: '123' });
  assert.strictEqual(r.status, 400);
  const r2 = await post('/api/donations', { ...valid, types: ['شيء آخر'] });
  assert.strictEqual(r2.status, 400);
});

test('دورة الطلب كاملة: إنشاء، تتبع، تحديث من اللوحة، إشعار', async () => {
  const created = await post('/api/donations', valid);
  assert.strictEqual(created.status, 201);
  const { code } = await created.json();
  assert.match(code, /^ATR-[A-Z0-9]{6}$/);

  const bad = await post('/api/track', { code, phoneLast4: '0000' });
  assert.strictEqual(bad.status, 404);
  const tr = await post('/api/track', { code, phoneLast4: '4567' });
  assert.strictEqual(tr.status, 200);
  const view = await tr.json();
  assert.strictEqual(view.status, 'new');
  assert.strictEqual(view.phone, undefined, 'لا يكشف الجوال في التتبع');

  const unauth = await fetch(`${base}/api/admin/donations`);
  assert.strictEqual(unauth.status, 401);
  const wrong = await post('/api/admin/login', { password: 'nope' });
  assert.strictEqual(wrong.status, 401);
  const { token } = await (await post('/api/admin/login', { password: 'test-password-123' })).json();

  const list = await (await fetch(`${base}/api/admin/donations`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.strictEqual(list.donations.length, 1);
  const id = list.donations[0].id;
  assert.deepStrictEqual(list.donations[0].location, { lat: 24.7, lng: 46.6 });

  const upd = await fetch(`${base}/api/admin/donations/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ status: 'scheduled', pickupDate: '2026-10-01T10:00', note: 'سائق: خالد' })
  });
  assert.strictEqual(upd.status, 200);
  const out = await upd.json();
  assert.strictEqual(out.donation.status, 'scheduled');
  assert.match(out.notification.manualLink, /^https:\/\/wa\.me\/966551234567\?text=/);
  assert.match(out.notification.message, /موعد الاستلام/);

  const stats = await (await fetch(`${base}/api/stats`)).json();
  assert.deepStrictEqual(stats, { total: 1, delivered: 0, items: 4, cities: 1 });

  const csv = await fetch(`${base}/api/admin/export.csv`, { headers: { Authorization: `Bearer ${token}` } });
  assert.match(await csv.text(), new RegExp(code));

  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'donations.json'), 'utf8'));
  assert.strictEqual(saved[0].status, 'scheduled');
});

test('الملفات الثابتة ومنع تجاوز المسار', async () => {
  assert.strictEqual((await fetch(`${base}/`)).status, 200);
  assert.strictEqual((await fetch(`${base}/admin`)).status, 200);
  const r = await fetch(`${base}/..%2fserver.js`);
  assert.notStrictEqual(r.status, 200);
});
