import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from '../src/mock/backend.js';

// Заглушка тоже должна держать контракт: иначе разработка на ней уведёт экраны в сторону
const memory = () => {
  let s = null;
  return { load: () => s, save: (v) => (s = structuredClone(v)) };
};

test('заглушка: стол, вход, согласие, котировка, оплата и сессия по контракту', async () => {
  let now = Date.parse('2026-10-21T15:00:00Z');
  const b = createBackend({ ...memory(), now: () => now });
  const t = await b.handle('GET', '/api/t/4K7P9QW2XM');
  assert.equal(t.status, 200);
  for (const k of ['club', 'resource', 'status', 'busy_until', 'price_now', 'price_next', 'options', 'my_session_id']) assert.ok(k in t.body, k);
  assert.deepEqual(t.body.options, [60, 120, 180, 'unlimited']);

  assert.equal((await b.handle('POST', '/api/quotes', { resource_id: t.body.resource.id, kind: 'start', minutes: 60 })).body.error, 'unauthorized');
  await b.handle('POST', '/api/auth/dev', { phone: '+79001234567' });
  assert.equal((await b.handle('POST', '/api/quotes', { resource_id: t.body.resource.id, kind: 'start', minutes: 60 })).body.error, 'consent_required');
  await b.handle('POST', '/api/auth/consent', { version: 'x' });
  const q = await b.handle('POST', '/api/quotes', { resource_id: t.body.resource.id, kind: 'start', minutes: 120 });
  assert.equal(q.status, 200);
  assert.ok(Number.isSafeInteger(q.body.amount_kopecks) && q.body.amount_kopecks % 100 === 0, 'целые рубли (№44)');
  assert.equal(q.body.breakdown.reduce((a, x) => a + x.amount_kopecks, 0) >= q.body.amount_kopecks - 100, true);

  const pay = await b.handle('POST', `/api/quotes/${q.body.quote_id}/pay`, { method: 'sbp' });
  assert.equal(pay.body.status, 'pending');
  assert.equal(pay.body.confirmation.type, 'redirect');
  assert.equal((await b.handle('POST', `/api/quotes/${q.body.quote_id}/pay`, { method: 'sbp' })).body.error, 'quote_used');

  b.confirm(pay.body.payment_id, true);
  now += 2000;
  const p = await b.handle('GET', `/api/payments/${pay.body.payment_id}`);
  assert.equal(p.body.status, 'succeeded');
  const s = await b.handle('GET', `/api/sessions/${p.body.session_id}`);
  for (const k of ['id', 'resource', 'status', 'started_at', 'paid_until', 'grace_until', 'remaining_ms', 'unlimited', 'is_payer', 'participants', 'extend_limit_until']) assert.ok(k in s.body, k);
  assert.equal(s.body.remaining_ms, 120 * 60_000);

  now += 118 * 60_000;
  assert.equal((await b.handle('GET', `/api/sessions/${p.body.session_id}`)).body.status, 'ending');
  now += 3 * 60_000;
  assert.equal((await b.handle('GET', `/api/sessions/${p.body.session_id}`)).body.status, 'grace');
  now += 2 * 60_000;
  assert.equal((await b.handle('GET', `/api/sessions/${p.body.session_id}`)).body.status, 'closed');
});

test('заглушка: занятый стол и второй гость', async () => {
  const b = createBackend(memory());
  const busy = await b.handle('GET', '/api/t/7H3D2RT9QF');
  assert.equal(busy.body.status, 'busy');
  assert.ok(busy.body.busy_until);
  assert.equal((await b.handle('GET', '/api/t/NOPE')).status, 404);
});
