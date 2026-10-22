// T15. Заказ бара со стола «в счёт стола»: заказ на экране бара (SSE bar у бармена и ресепшена,
// очередь GET bar/queue), статусы new → preparing → ready → served (гость видит SSE order),
// счёт закрывается при уходе: A — сессия закрылась по времени, счёт остаётся открытым (свет
// погас, новые заказы не принимаются), гость оплачивает счёт онлайн (СБП, эмулятор ЮKassa);
// B — гость закончил игру, счёт оплачивает ресепшн наличными со сдачей (чек ККТ).
//
// Стол A — E2E_T15_TABLE (3), стол B — E2E_T15_TABLE_B (4). Игра A — 2 минуты (DEV_ALLOW_ANY_MINUTES),
// закрытие по времени — после льготы 2 мин (~4,5 мин). Бармен +70000000005 — ensureBarUser.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  barStaff,
  catalog,
  cartAmount,
  CLUB_A,
  closeMyShift,
  emuPayment,
  emuSucceed,
  ensureBarUser,
  kktDocs,
  docsFor,
  M,
  ok,
  openMyShift,
  P,
  receiptRow,
  rub,
  sim,
  sse,
  staff,
  startGame,
  waitFor,
  waitSale,
  waitSim,
  waitTableFree,
  ykId,
  ensureStock,
  serveOrders,
} from './helpers.mjs';

const TABLE_A = Number(process.env.E2E_T15_TABLE || 3);
const TABLE_B = Number(process.env.E2E_T15_TABLE_B || 4);
let db;
let rec;
let man;
let bar;
let cat;
let shift;
let A;
let B;
let barStream;
let recStream;
let guestStream;
let orderA;
const mySessions = [];
const itemsA = [
  { product_id: P.americano, qty: 1, modifier_ids: [M.v04, M.sugar] },
  { product_id: P.chips, qty: 1 },
];
const itemsA2 = [{ product_id: P.waterSpark, qty: 2 }];
const itemsB = [{ product_id: P.teaGreen, qty: 2, modifier_ids: [M.sugar] }];

before(async () => {
  db = await adminClient();
  await ensureBarUser(db);
  rec = await staff('reception');
  man = await staff('manager');
  await ensureStock(db, man, { [P.chips]: 30, [P.nuts]: 20, [P.waterStill]: 30, [P.waterSpark]: 20, [P.beer]: 20 });
  bar = await barStaff();
  cat = await catalog(db, rec.token);
  shift = await openMyShift({ rec, man, floatKopecks: 100_000, log: (m) => console.log(`# ${m}`) });
  barStream = sse(`club=${CLUB_A}`, bar.token);
  recStream = sse(`club=${CLUB_A}`, rec.token);
  await Promise.all([barStream.ready, recStream.ready]);
});

after(async () => {
  const served = await serveOrders(db, rec.token, { sessionIds: mySessions }).catch(() => 0);
  console.log(`# заказы теста убраны с экрана бара («выдан»): ${served}`);
  barStream?.close();
  recStream?.close();
  guestStream?.close();
  for (const g of [A, B]) {
    if (g?.sessionId) await api('POST', `/api/sessions/${g.sessionId}/stop`, { token: g.guest.token, body: {} }).catch(() => {});
  }
  if (shift) {
    const closed = await closeMyShift({ rec, man, shiftId: shift.id, comment: 'e2e T15' }).catch((e) => console.log(`# смена не закрыта: ${e.message}`));
    if (closed) console.log(`# смена №${closed.number} закрыта честно, расхождение ${closed.discrepancy_kopecks}`);
  }
  await db?.end();
});

test(`T15: гость стола ${TABLE_A} заказывает «в счёт стола» — заказ на экране бара (SSE bar)`, async (t) => {
  await waitTableFree(TABLE_A);
  A = await startGame(TABLE_A, 2);
  mySessions.push(A.sessionId);
  t.diagnostic(`игра A: стол ${TABLE_A}, 2 мин, сессия ${A.sessionId.slice(0, 8)}, оплата ${rub(A.q.amount_kopecks)} СБП`);
  guestStream = sse(`session=${A.sessionId}`, A.guest.token);
  await guestStream.ready;
  const tOrder = Date.now();
  const r = await api('POST', '/api/orders', { token: A.guest.token, idem: true, body: { session_id: A.sessionId, items: itemsA, pay: 'tab', comment: 'e2e T15' } });
  t.diagnostic(`POST /api/orders pay=tab → HTTP ${r.status}: №${r.json?.order?.number} status=${r.json?.order?.status} subtotal=${r.json?.order?.subtotal_kopecks} payment=${JSON.stringify(r.json?.payment ?? null)}`);
  assert.equal(r.status, 201);
  orderA = r.json.order;
  assert.equal(orderA.status, 'new');
  assert.equal(orderA.pay_mode, 'tab');
  assert.equal(orderA.subtotal_kopecks, cartAmount(cat, itemsA));
  const evBar = await barStream.waitEvent((e) => e.event === 'bar' && e.data.id === orderA.id, { what: 'SSE bar у бармена' });
  const evRec = await recStream.waitEvent((e) => e.event === 'bar' && e.data.id === orderA.id, { what: 'SSE bar у ресепшена' });
  t.diagnostic(`SSE bar: бармен через ${evBar.at - tOrder} мс (стол ${evBar.data.resource?.number}, ${evBar.data.items.map((i) => `${i.name} × ${i.qty}`).join('; ')}), ресепшн через ${evRec.at - tOrder} мс`);
  assert.equal(evBar.data.resource.number, TABLE_A);
  const q = await ok(api('GET', `/api/clubs/${CLUB_A}/bar/queue`, { token: bar.token }));
  t.diagnostic(`очередь бара (бармен): ${q.length} заказов, наш: ${q.some((o) => o.id === orderA.id)}`);
  assert.ok(q.some((o) => o.id === orderA.id));
});

test('T15: бармен ведёт статусы, гость видит их (SSE order и GET /api/orders/{id})', async (t) => {
  assert.ok(orderA);
  for (const status of ['preparing', 'ready', 'served']) {
    const t0 = Date.now();
    const r = await api('POST', `/api/orders/${orderA.id}/status`, { token: bar.token, body: { status } });
    assert.equal(r.status, 200, r.text);
    const ev = await guestStream.waitEvent((e) => e.event === 'order' && e.data.id === orderA.id && e.data.status === status, { what: `SSE order ${status}` });
    const g = await ok(api('GET', `/api/orders/${orderA.id}`, { token: A.guest.token }));
    t.diagnostic(`бармен → ${status}: HTTP ${r.status}; гость SSE order через ${ev.at - t0} мс; GET у гостя: ${g.status}`);
    assert.equal(g.status, status);
  }
  const back = await api('POST', `/api/orders/${orderA.id}/status`, { token: bar.token, body: { status: 'preparing' } });
  const guestTry = await api('POST', `/api/orders/${orderA.id}/status`, { token: A.guest.token, body: { status: 'served' } });
  t.diagnostic(`назад served → preparing: ${back.status} ${back.text}; гость меняет статус: ${guestTry.status}`);
  assert.equal(back.status, 400);
  assert.ok([401, 403].includes(guestTry.status));
  // Второй заказ в тот же счёт.
  const r2 = await api('POST', '/api/orders', { token: A.guest.token, idem: true, body: { session_id: A.sessionId, items: itemsA2, pay: 'tab' } });
  assert.equal(r2.status, 201);
  const tab = await ok(api('GET', `/api/sessions/${A.sessionId}/tab`, { token: A.guest.token }));
  t.diagnostic(`счёт стола A у гостя: ${tab.orders.length} заказа, ${rub(tab.total_kopecks)}`);
  assert.equal(tab.total_kopecks, cartAmount(cat, itemsA) + cartAmount(cat, itemsA2));
});

test(`T15: стол ${TABLE_B} — гость закончил игру, счёт оплачивает ресепшн наличными (чек ККТ)`, async (t) => {
  await waitTableFree(TABLE_B);
  B = await startGame(TABLE_B, 30);
  mySessions.push(B.sessionId);
  const r = await api('POST', '/api/orders', { token: B.guest.token, idem: true, body: { session_id: B.sessionId, items: itemsB, pay: 'tab' } });
  assert.equal(r.status, 201, r.text);
  await ok(api('POST', `/api/sessions/${B.sessionId}/stop`, { token: B.guest.token, body: {} }));
  await waitSim(TABLE_B, (x) => x.state.mode === 'free' && x.state.relay === false, { timeoutMs: 10_000 });
  const tabs = await ok(api('GET', `/api/clubs/${CLUB_A}/tabs`, { token: rec.token }));
  const mine = tabs.find((x) => x.session_id === B.sessionId);
  t.diagnostic(`гость B закончил игру, свет погас; счета у ресепшена: ${JSON.stringify(mine)}`);
  assert.ok(mine, 'счёт стола B открыт у ресепшена после конца игры');
  const total = cartAmount(cat, itemsB);
  assert.equal(mine.total_kopecks, total);
  const pay = await api('POST', `/api/sessions/${B.sessionId}/tab/pay`, { token: rec.token, idem: true, body: { method: 'cash', received_kopecks: 50_000 } });
  t.diagnostic(`ресепшн: оплата счёта наличными 500 ₽ → HTTP ${pay.status} status=${pay.json?.status} total=${pay.json?.total_kopecks} сдача=${pay.json?.change_kopecks}`);
  assert.ok([200, 201].includes(pay.status), pay.text);
  assert.equal(pay.json.total_kopecks, total);
  assert.equal(pay.json.change_kopecks, 50_000 - total);
  const sale = await waitSale(rec.token, pay.json.sale_id);
  const rc = await receiptRow(db, sale.receipt_id);
  const docs = docsFor(kktDocs(), rc);
  t.diagnostic(`чек ККТ счёта: ${sale.receipt_status} ФД ${sale.receipt_fd} ФП ${sale.receipt_fp}; документов в АТОЛ ${docs.length}, сумма ${docs[0]?.total_kopecks}`);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].total_kopecks, total);
  const after = await ok(api('GET', `/api/sessions/${B.sessionId}/tab`, { token: B.guest.token }));
  const tabs2 = await ok(api('GET', `/api/clubs/${CLUB_A}/tabs`, { token: rec.token }));
  t.diagnostic(`после оплаты: счёт у гостя ${rub(after.total_kopecks)}, у ресепшена есть: ${tabs2.some((x) => x.session_id === B.sessionId)}`);
  assert.equal(after.total_kopecks, 0);
  assert.ok(!tabs2.some((x) => x.session_id === B.sessionId));
  const again = await api('POST', `/api/sessions/${B.sessionId}/tab/pay`, { token: rec.token, idem: true, body: { method: 'cash', received_kopecks: 50_000 } });
  t.diagnostic(`повторная оплата пустого счёта → ${again.status} ${again.text}`);
  assert.equal(again.status, 409);
});

test(`T15: стол ${TABLE_A} — игра закрылась по времени, счёт открыт до оплаты гостем онлайн`, { timeout: 8 * 60_000 }, async (t) => {
  assert.ok(A);
  const closed = await waitFor(
    async () => {
      const s = await api('GET', `/api/sessions/${A.sessionId}`, { token: A.guest.token });
      return s.status === 200 && s.json.status === 'closed' ? s.json : null;
    },
    { timeoutMs: 7 * 60_000, intervalMs: 2000, what: 'сессия A закрыта по времени' },
  );
  const st = await sim(TABLE_A);
  t.diagnostic(`сессия A: status=${closed.status} close_reason=${closed.close_reason}; симулятор: mode=${st.state.mode} relay=${st.state.relay}`);
  assert.equal(st.state.relay, false, 'свет погас по времени, счёт на свет не влияет');
  const tab = await ok(api('GET', `/api/sessions/${A.sessionId}/tab`, { token: A.guest.token }));
  const tabs = await ok(api('GET', `/api/clubs/${CLUB_A}/tabs`, { token: rec.token }));
  const atRec = tabs.find((x) => x.session_id === A.sessionId);
  t.diagnostic(`после закрытия: счёт у гостя ${rub(tab.total_kopecks)} (${tab.orders.length} заказа); у ресепшена: ${JSON.stringify(atRec)}`);
  assert.equal(tab.total_kopecks, cartAmount(cat, itemsA) + cartAmount(cat, itemsA2));
  assert.equal(atRec?.session_status, 'closed');
  const late = await api('POST', '/api/orders', { token: A.guest.token, idem: true, body: { session_id: A.sessionId, items: [{ product_id: P.nuts, qty: 1 }], pay: 'tab' } });
  t.diagnostic(`новый заказ после конца игры → ${late.status} ${late.text}`);
  assert.equal(late.status, 409);

  const pay = await api('POST', `/api/sessions/${A.sessionId}/tab/pay`, { token: A.guest.token, idem: true, body: { method: 'sbp' } });
  t.diagnostic(`гость: оплатить счёт СБП → HTTP ${pay.status} ${JSON.stringify(pay.json).slice(0, 300)}`);
  assert.ok([200, 201].includes(pay.status), pay.text);
  assert.equal(pay.json.total_kopecks, tab.total_kopecks);
  const pid = ykId(pay.json.confirmation);
  emuSucceed(pid);
  const sale = await waitSale(rec.token, pay.json.sale_id);
  const ep = emuPayment(pid);
  const rcpt = ep.receipt ?? ep.receipts?.[0]?.receipt ?? ep.receipts?.[0];
  const items = rcpt?.items ?? [];
  const sum = items.reduce((s, i) => s + Math.round(Number(i.amount.value) * 100 * Number(i.quantity)), 0);
  t.diagnostic(`ЮKassa (эмулятор): ${ep.status} ${ep.amount?.value} ₽; чек: ${items.map((i) => `${i.description} ${i.amount.value}×${i.quantity}`).join('; ')} = ${sum}; продажа ${sale.status} receipt_status=${sale.receipt_status}`);
  assert.equal(ep.status, 'succeeded');
  assert.equal(Math.round(Number(ep.amount.value) * 100), tab.total_kopecks);
  assert.equal(sum, tab.total_kopecks, 'позиции чека ЮKassa = сумма счёта');
  const after = await ok(api('GET', `/api/sessions/${A.sessionId}/tab`, { token: A.guest.token }));
  const tabs2 = await ok(api('GET', `/api/clubs/${CLUB_A}/tabs`, { token: rec.token }));
  t.diagnostic(`после оплаты: счёт ${rub(after.total_kopecks)}, у ресепшена: ${tabs2.some((x) => x.session_id === A.sessionId)}`);
  assert.equal(after.total_kopecks, 0);
  assert.ok(!tabs2.some((x) => x.session_id === A.sessionId));
  A.sessionId = null;
});
