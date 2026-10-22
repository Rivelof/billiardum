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

test('заглушка бара: меню без алкоголя, заказ в счёт стола и онлайн, счёт стола и его оплата (m2 §4)', async () => {
  let now = Date.parse('2026-10-22T15:00:00Z');
  const b = createBackend({ ...memory(), now: () => now });
  b.scenario('game');
  const sid = '6f1c2a9e-0d4b-4c7e-9a51-3b2f8e7d4c10';
  const menu = (await b.handle('GET', '/api/clubs/c/menu')).body;
  const products = menu.categories.flatMap((c) => c.products);
  assert.ok(products.length > 10);
  assert.ok(products.every((p) => !('is_alcohol' in p) && !/пиво|сидр/i.test(p.name)), 'алкоголь гостю не отдаётся (№76)');
  const cola = products.find((p) => p.name.startsWith('Кола'));
  const capp = products.find((p) => p.name === 'Капучино');

  const beer = await b.handle('POST', '/api/orders', { session_id: sid, pay: 'tab', items: [{ product_id: 'd0000001-0000-4000-8000-000000000016', qty: 1 }] });
  assert.equal(beer.status, 404, 'алкоголь со стола — 404 даже прямым запросом');
  const mors = products.find((p) => p.stop_list);
  assert.equal((await b.handle('POST', '/api/orders', { session_id: sid, pay: 'tab', items: [{ product_id: mors.id, qty: 1 }] })).body.error, 'stop_list');

  const tab = await b.handle('POST', '/api/orders', { session_id: sid, pay: 'tab', items: [{ product_id: cola.id, qty: 2 }, { product_id: capp.id, qty: 1, modifier_ids: [] }] });
  assert.equal(tab.status, 201);
  assert.equal(tab.body.order.status, 'new');
  assert.equal(tab.body.order.subtotal_kopecks, 15000 * 2 + 22000, 'модификаторы по умолчанию без доплаты');
  assert.equal(tab.body.order.items[1].modifiers.length, 3, 'обязательные группы — варианты по умолчанию');

  const online = await b.handle('POST', '/api/orders', { session_id: sid, pay: 'online', method: 'sbp', items: [{ product_id: cola.id, qty: 1 }] });
  assert.equal(online.body.order.awaiting_payment, true);
  assert.match(online.body.payment.confirmation.url, /^\/app\/mock-pay\//);
  b.confirm(online.body.payment.payment_id, true);
  assert.equal((await b.handle('GET', `/api/orders/${online.body.order.id}`)).body.paid, true);
  assert.equal(b.state.payments[online.body.payment.payment_id].return_url, `/app/orders/${online.body.order.id}`);

  now += 65_000;
  const order = (await b.handle('GET', `/api/orders/${tab.body.order.id}`)).body;
  assert.equal(order.status, 'ready', 'бар готовит сам: через минуту «Готов»');

  const t1 = (await b.handle('GET', `/api/sessions/${sid}/tab`)).body;
  assert.equal(t1.total_kopecks, 52000);
  assert.equal(t1.orders.length, 1, 'онлайн-заказ не в счёте стола');
  const pay = await b.handle('POST', `/api/sessions/${sid}/tab/pay`, { method: 'card' });
  assert.equal(pay.body.total_kopecks, 52000);
  assert.ok((await b.handle('GET', `/api/sessions/${sid}/tab`)).body.pending_payment, 'оплата идёт');
  b.confirm(pay.body.payment_id, true);
  const t2 = (await b.handle('GET', `/api/sessions/${sid}/tab`)).body;
  assert.equal(t2.total_kopecks, 0);
  assert.equal(t2.pending_payment, null);
  assert.equal((await b.handle('POST', `/api/sessions/${sid}/tab/pay`, { method: 'card' })).body.error, 'already_paid');
});
