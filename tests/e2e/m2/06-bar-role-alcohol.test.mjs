// Алкоголь (decisions №76) и роль бармена (№97).
//
// Алкоголь: гостю (и без входа) меню без is_alcohol; прямой запрос заказа пива со стола — отказ
// (в счёт и онлайн), заказ не создан; персоналу пиво видно, касса продаёт.
// Бармен +70000000005 (синтетический, ensureBarUser): очередь бара, статусы (без отмены),
// стоп-лист (гость видит и не может заказать, SSE stop_list), меню персонала; касса, деньги,
// смены, счета, заявки, ККТ, склад, отчёты, зал — 403; поток клуба — только bar и stop_list.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  BAR_PHONE,
  barStaff,
  CLUB_A,
  closeMyShift,
  ensureBarUser,
  ok,
  openMyShift,
  P,
  posSale,
  sse,
  staff,
  startGame,
  waitFor,
  waitTableFree,
  ensureStock,
} from './helpers.mjs';

const TABLE = Number(process.env.E2E_BAR_TABLE || 1);
let db;
let rec;
let man;
let bar;
let game;
let shift;
let barStream;
let recStream;
let order1;
let order2;

before(async () => {
  db = await adminClient();
  const u = await ensureBarUser(db);
  console.log(`# бармен ${BAR_PHONE}: user ${u.userId}, роль ${u.member.role}, active ${u.member.active}`);
  rec = await staff('reception');
  man = await staff('manager');
  await ensureStock(db, man, { [P.chips]: 30, [P.nuts]: 20, [P.waterStill]: 30, [P.waterSpark]: 20, [P.beer]: 20 });
  bar = await barStaff();
});

after(async () => {
  barStream?.close();
  recStream?.close();
  await api('POST', `/api/catalog/products/${P.teaGreen}/stop-list`, { token: rec.token, body: { stop_list: false } }).catch(() => {});
  if (game?.sessionId) await api('POST', `/api/sessions/${game.sessionId}/stop`, { token: game.guest.token, body: {} }).catch(() => {});
  if (shift) {
    const closed = await closeMyShift({ rec, man, shiftId: shift.id, comment: 'e2e бармен' }).catch((e) => console.log(`# смена не закрыта: ${e.message}`));
    if (closed) console.log(`# смена №${closed.number} закрыта честно, расхождение ${closed.discrepancy_kopecks}`);
  }
  await db?.end();
});

test('алкоголь (№76): гостю не виден в меню и не заказывается прямым запросом', async (t) => {
  const { rows } = await db.query("select value from bl.platform_settings where key = 'qr_alcohol_allowed'");
  t.diagnostic(`bl.platform_settings qr_alcohol_allowed = ${JSON.stringify(rows[0]?.value)}`);
  assert.equal(rows[0]?.value, false);
  await waitTableFree(TABLE);
  game = await startGame(TABLE, 30);
  const names = (m) => m.categories.flatMap((c) => c.products.map((p) => p.name));
  const anon = await ok(api('GET', `/api/clubs/${CLUB_A}/menu`));
  const guest = await ok(api('GET', `/api/clubs/${CLUB_A}/menu`, { token: game.guest.token }));
  const staffMenu = await ok(api('GET', `/api/clubs/${CLUB_A}/menu`, { token: rec.token }));
  const hasBeer = (m) => m.categories.some((c) => c.products.some((p) => p.id === P.beer || p.is_alcohol));
  t.diagnostic(`меню без входа: audience=${anon.audience} alcohol_hidden=${anon.alcohol_hidden}, пиво: ${hasBeer(anon)}; гость: ${hasBeer(guest)} (${names(guest).length} позиций, категории ${guest.categories.map((c) => c.name).join(', ')}); ресепшн: ${hasBeer(staffMenu)}`);
  assert.equal(hasBeer(anon), false);
  assert.equal(hasBeer(guest), false);
  assert.ok(!guest.categories.some((c) => c.name === 'Пиво'), 'пустая категория «Пиво» гостю не показана');
  assert.equal(hasBeer(staffMenu), true);
  const { rows: before0 } = await db.query('select count(*)::int as n from bl.orders where session_id = $1', [game.sessionId]);
  const tab = await api('POST', '/api/orders', { token: game.guest.token, idem: true, body: { session_id: game.sessionId, items: [{ product_id: P.beer, qty: 1 }], pay: 'tab' } });
  const online = await api('POST', '/api/orders', { token: game.guest.token, idem: true, body: { session_id: game.sessionId, items: [{ product_id: P.beer, qty: 1 }], pay: 'online', method: 'sbp' } });
  const mixed = await api('POST', '/api/orders', { token: game.guest.token, idem: true, body: { session_id: game.sessionId, items: [{ product_id: P.chips, qty: 1 }, { product_id: P.beer, qty: 2 }], pay: 'tab' } });
  const { rows: after0 } = await db.query('select count(*)::int as n from bl.orders where session_id = $1', [game.sessionId]);
  t.diagnostic(`гость: пиво в счёт → ${tab.status} ${tab.text}; онлайн → ${online.status} ${online.text}; чипсы + пиво → ${mixed.status} ${mixed.text}; заказов у сессии ${before0[0].n} → ${after0[0].n}`);
  for (const r of [tab, online, mixed]) assert.ok(r.status >= 400 && r.status < 500);
  assert.equal(after0[0].n, before0[0].n, 'заказ с алкоголем не создан');
});

test('бармен: вход, роль bar, очередь бара и статусы (без отмены)', async (t) => {
  const me = await ok(api('GET', '/api/me', { token: bar.token }));
  t.diagnostic(`/api/me бармена: роли ${JSON.stringify(me.clubs.map((c) => c.role))}`);
  assert.deepEqual(me.clubs.map((c) => c.role), ['bar']);
  barStream = sse(`club=${CLUB_A}`, bar.token);
  recStream = sse(`club=${CLUB_A}`, rec.token);
  const ready = await barStream.ready;
  await recStream.ready;
  t.diagnostic(`SSE клуба для бармена → HTTP ${ready.status}`);
  assert.equal(ready.status, 200);
  const r1 = await api('POST', '/api/orders', { token: game.guest.token, idem: true, body: { session_id: game.sessionId, items: [{ product_id: P.teaBlack, qty: 1 }], pay: 'tab' } });
  const r2 = await api('POST', '/api/orders', { token: game.guest.token, idem: true, body: { session_id: game.sessionId, items: [{ product_id: P.waterStill, qty: 1 }], pay: 'tab' } });
  assert.equal(r1.status, 201, r1.text);
  assert.equal(r2.status, 201, r2.text);
  order1 = r1.json.order;
  order2 = r2.json.order;
  await barStream.waitEvent((e) => e.event === 'bar' && e.data.id === order1.id, { what: 'SSE bar у бармена' });
  const q = await api('GET', `/api/clubs/${CLUB_A}/bar/queue`, { token: bar.token });
  t.diagnostic(`очередь бара (бармен) → ${q.status}, наш заказ: ${q.json?.some((o) => o.id === order1.id)}`);
  assert.equal(q.status, 200);
  for (const s of ['preparing', 'ready', 'served']) {
    const r = await api('POST', `/api/orders/${order1.id}/status`, { token: bar.token, body: { status: s } });
    assert.equal(r.status, 200, `${s}: ${r.text}`);
  }
  const cancel = await api('POST', `/api/orders/${order2.id}/status`, { token: bar.token, body: { status: 'canceled', reason: 'e2e' } });
  t.diagnostic(`бармен: статусы preparing → ready → served — 200; отмена → ${cancel.status} ${cancel.text}`);
  assert.equal(cancel.status, 403);
  assert.equal((await api('POST', `/api/orders/${order2.id}/status`, { token: bar.token, body: { status: 'served' } })).status, 200);
  const staffMenu = await api('GET', `/api/clubs/${CLUB_A}/menu`, { token: bar.token });
  t.diagnostic(`меню персонала для бармена → ${staffMenu.status} audience=${staffMenu.json?.audience}`);
  assert.equal(staffMenu.status, 200);
});

test('бармен: стоп-лист — гость видит и не может заказать, SSE stop_list', async (t) => {
  const on = await api('POST', `/api/catalog/products/${P.teaGreen}/stop-list`, { token: bar.token, body: { stop_list: true } });
  t.diagnostic(`бармен ставит «Чай зелёный» в стоп-лист → ${on.status}`);
  assert.equal(on.status, 200, on.text);
  const ev = await barStream.waitEvent((e) => e.event === 'stop_list', { what: 'SSE stop_list' }).catch(() => null);
  t.diagnostic(`SSE stop_list у бармена: ${ev ? JSON.stringify(ev.data).slice(0, 160) : 'нет'}`);
  const menu = await ok(api('GET', `/api/clubs/${CLUB_A}/menu`, { token: game.guest.token }));
  const p = menu.categories.flatMap((c) => c.products).find((x) => x.id === P.teaGreen);
  const order = await api('POST', '/api/orders', { token: game.guest.token, idem: true, body: { session_id: game.sessionId, items: [{ product_id: P.teaGreen, qty: 1 }], pay: 'tab' } });
  t.diagnostic(`гость: в меню stop_list=${p?.stop_list} available=${p?.available}; заказ → ${order.status} ${order.text}`);
  assert.ok(p && (p.stop_list === true || p.available === false));
  assert.equal(order.status, 409);
  const off = await api('POST', `/api/catalog/products/${P.teaGreen}/stop-list`, { token: bar.token, body: { stop_list: false } });
  assert.equal(off.status, 200);
  const price = await api('PATCH', `/api/catalog/products/${P.teaGreen}`, { token: bar.token, body: { price_kopecks: 100 } });
  t.diagnostic(`снял со стоп-листа → ${off.status}; бармен меняет цену → ${price.status}`);
  assert.equal(price.status, 403);
});

test('бармен: касса, деньги, смены, счета, заявки, ККТ, склад, отчёты, зал — 403; в потоке только бар', async (t) => {
  shift = await openMyShift({ rec, man, floatKopecks: 0, log: (m) => t.diagnostic(m) });
  const sale = await posSale(rec.token, { items: [{ product_id: P.chips, qty: 1 }], method: 'card_terminal' });
  assert.equal(sale.status, 201);
  const S = sale.json.sale_id;
  const checks = [
    ['POST /api/pos/sales', () => posSale(bar.token, { items: [{ product_id: P.chips, qty: 1 }], method: 'cash', received_kopecks: 20_000 })],
    ['GET /api/clubs/{club}/pos/sales', () => api('GET', `/api/clubs/${CLUB_A}/pos/sales`, { token: bar.token })],
    ['GET /api/pos/sales/{id}', () => api('GET', `/api/pos/sales/${S}`, { token: bar.token })],
    ['POST /api/pos/sales/{id}/refund', () => api('POST', `/api/pos/sales/${S}/refund`, { token: bar.token, idem: true, body: { reason: 'x' } })],
    ['POST /api/pos/sales/{id}/cancel', () => api('POST', `/api/pos/sales/${S}/cancel`, { token: bar.token, body: { reason: 'x' } })],
    ['POST /api/pos/discount-approvals', () => api('POST', '/api/pos/discount-approvals', { token: bar.token, body: { user_id: man.user.id, pin: '1234', reason_code: 'other', reason_text: 'x', percent: 50, subtotal_kopecks: 10_000 } })],
    ['GET /api/clubs/{club}/pos/settings', () => api('GET', `/api/clubs/${CLUB_A}/pos/settings`, { token: bar.token })],
    ['GET /api/clubs/{club}/shifts/current', () => api('GET', `/api/clubs/${CLUB_A}/shifts/current`, { token: bar.token })],
    ['POST /api/clubs/{club}/shifts', () => api('POST', `/api/clubs/${CLUB_A}/shifts`, { token: bar.token, body: { float_kopecks: 0 } })],
    ['GET /api/shifts/{id}', () => api('GET', `/api/shifts/${shift.id}`, { token: bar.token })],
    ['POST /api/shifts/{id}/close', () => api('POST', `/api/shifts/${shift.id}/close`, { token: bar.token, body: { actual_cash_kopecks: 0 } })],
    ['GET /api/shifts/{id}/report', () => api('GET', `/api/shifts/${shift.id}/report`, { token: bar.token })],
    ['GET /api/clubs/{club}/tabs', () => api('GET', `/api/clubs/${CLUB_A}/tabs`, { token: bar.token })],
    ['POST /api/sessions/{id}/tab/pay cash', () => api('POST', `/api/sessions/${game.sessionId}/tab/pay`, { token: bar.token, idem: true, body: { method: 'cash', received_kopecks: 100_000 } })],
    ['GET /api/sessions/{id}/tab', () => api('GET', `/api/sessions/${game.sessionId}/tab`, { token: bar.token })],
    ['GET /api/clubs/{club}/reception/requests', () => api('GET', `/api/clubs/${CLUB_A}/reception/requests`, { token: bar.token })],
    ['GET /api/clubs/{club}/kkt/status', () => api('GET', `/api/clubs/${CLUB_A}/kkt/status`, { token: bar.token })],
    ['GET /api/clubs/{club}/kkt/receipts', () => api('GET', `/api/clubs/${CLUB_A}/kkt/receipts`, { token: bar.token })],
    ['GET /api/clubs/{club}/stock', () => api('GET', `/api/clubs/${CLUB_A}/stock`, { token: bar.token })],
    ['POST /api/stock/arrivals', () => api('POST', '/api/stock/arrivals', { token: bar.token, body: { items: [{ product_id: P.chips, qty: 1, cost_kopecks: 100 }] } })],
    ['GET /api/clubs/{club}/hall', () => api('GET', `/api/clubs/${CLUB_A}/hall`, { token: bar.token })],
    ['GET /api/clubs/{club}/alarms', () => api('GET', `/api/clubs/${CLUB_A}/alarms`, { token: bar.token })],
    ['GET /api/clubs/{club}/audit', () => api('GET', `/api/clubs/${CLUB_A}/audit`, { token: bar.token })],
    ['GET /api/clubs/{club}/catalog', () => api('GET', `/api/clubs/${CLUB_A}/catalog`, { token: bar.token })],
    ['POST /api/resources/{id}/service', () => api('POST', `/api/resources/${game.tbl.resource.id}/service`, { token: bar.token, body: { reason_code: 'cleaning', reason_text: 'x', minutes: 5 } })],
  ];
  const results = [];
  for (const [name, fn] of checks) {
    const r = await fn();
    results.push([name, r.status]);
  }
  t.diagnostic(results.map(([n, s]) => `${n} → ${s}`).join('; '));
  const leaked = results.filter(([, s]) => s < 400);
  assert.deepEqual(leaked, [], 'бармену недоступны касса и деньги');
  assert.ok(results.every(([, s]) => [401, 403, 404].includes(s)));
  // Поток: ресепшн получает pos_sale/kkt/shift, бармен — только bar и stop_list.
  await waitFor(() => recStream.events.some((e) => e.event === 'pos_sale' || e.event === 'kkt'), { timeoutMs: 10_000, what: 'pos_sale или kkt у ресепшена' });
  const barKinds = [...new Set(barStream.events.map((e) => e.event))];
  const recKinds = [...new Set(recStream.events.map((e) => e.event))];
  t.diagnostic(`события у ресепшена: ${recKinds.join(', ')}; у бармена: ${barKinds.join(', ')}`);
  assert.ok(barKinds.every((k) => ['bar', 'stop_list', 'ready'].includes(k)), `бармену пришло лишнее: ${barKinds}`);
  // Счёт стола гостя оплачивает ресепшн (данные стенда не оставляем открытыми).
  const pay = await api('POST', `/api/sessions/${game.sessionId}/tab/pay`, { token: rec.token, idem: true, body: { method: 'card_terminal' } });
  assert.ok([200, 201].includes(pay.status), pay.text);
});
