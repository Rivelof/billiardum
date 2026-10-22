// Критерий приёмки M2: сверка за смену сходится до копейки на тестовом дне из 50 продаж разными
// способами. Тест ведёт свою книгу продаж (суммы — по своему каталогу, скидки — своим расчётом,
// столы — по котировке гостя) и после закрытия смены сравнивает её с отчётом смены, с эмулятором
// АТОЛ (документы по UUID заданий) и с эмулятором ЮKassa (платежи по id).
//
// День (50 продаж, одна смена, размен 5 000 ₽):
//   * 2 старта игры гостем онлайн (СБП, карта) и 1 продление (СБП) — первые два стола E2E_RECON_TABLES;
//   * 6 заказов бара гостем онлайн (СБП, карта);
//   * 4 оплаты счёта стола: гостем онлайн (СБП, карта), на ресепшене (наличные, терминал);
//   * 13 продаж кассы наличными (со сдачей, одна без сдачи, одна — на экран бара), 9 — терминалом, 5 — СБП по QR;
//   * скидки в пределах лимита (10 %, 5 %, 10,01 ₽) и одна 20 % по PIN управляющего;
//   * 6 заявок стола M1 на ресепшене (касса: наличные, терминал, заявка + бар одной продажей — два
//     чека, №86; «Принять» M1: наличные и терминал);
//   * один возврат (управляющий, часть продажи наличными).
// Закрытие смены с честным фактом (свой расчёт) → расхождение 0; отчёт: ККТ = продажи кассы и
// заявок, онлайн = ЮKassa, по способам оплаты = своей книге. Чужие платежи в окне смены
// (pentester на столах 7–8) выделяются и учитываются отдельно.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  auditFor,
  catalog,
  cartAmount,
  CLUB_A,
  docsFor,
  emuPayment,
  emuSucceed,
  extendGame,
  kktDocs,
  M,
  MANAGER_ID,
  newGuest,
  ok,
  openMyShift,
  P,
  pay,
  percentOf,
  PIN,
  posSale,
  quote,
  receiptRow,
  rub,
  staff,
  startGame,
  table,
  waitFor,
  waitReceiptsPrinted,
  waitSale,
  waitTableFree,
  ykId,
  ensureStock,
  serveOrders,
} from './helpers.mjs';

const TABLES = (process.env.E2E_RECON_TABLES || '1,3,4,5,6').split(',').map(Number);
// Гости онлайн — первые два стола; заявки M1 — остальные по кругу.
const REQ_TABLES = TABLES.slice(2);
let reqTurn = 0;
const nextReqTable = () => REQ_TABLES[reqTurn++ % REQ_TABLES.length];
const FLOAT = 500_000;
let db;
let rec;
let man;
let owner;
let cat;
let shift;
let closed;
let G1;
let G2;
const book = []; // { n, what, method, channel: kkt|online, amount, pid?, paymentIds, receiptIds, saleId? }
const refunds = []; // { amount, method, refundId, receiptId }
const requestSessions = [];

let sales = 0;
/** Запись книги; sameSale — та же продажа (заявка + бар в одной продаже кассы: два чека ККТ). */
function add(e, t) {
  if (!e.sameSale) sales += 1;
  const entry = { n: book.length + 1, sale: sales, paymentIds: [], receiptIds: [], ...e };
  book.push(entry);
  t?.diagnostic(`продажа ${String(entry.sale).padStart(2, '0')}${e.sameSale ? ' (та же)' : ''}: ${entry.what} — ${entry.method} ${rub(entry.amount)}`);
  return entry;
}

const sum = (list) => list.reduce((s, x) => s + x.amount, 0);

before(async () => {
  db = await adminClient();
  rec = await staff('reception');
  man = await staff('manager');
  owner = await staff('owner');
  await ensureStock(db, man, { [P.chips]: 30, [P.nuts]: 20, [P.waterStill]: 30, [P.waterSpark]: 20, [P.beer]: 20 });
  cat = await catalog(db, rec.token);
});

after(async () => {
  const served = await serveOrders(db, rec.token, { saleIds: book.map((e) => e.saleId), sessionIds: [G1?.sessionId, G2?.sessionId] }).catch(() => 0);
  console.log(`# заказы теста убраны с экрана бара («выдан»): ${served}`);
  for (const g of [G1, G2, ...requestSessions]) {
    if (g?.sessionId) await api('POST', `/api/sessions/${g.sessionId}/stop`, { token: g.guest.token, body: {} }).catch(() => {});
  }
  if (shift && !closed) console.log(`# ВНИМАНИЕ: смена №${shift.number} осталась открытой (тест упал до закрытия)`);
  await db?.end();
});

// Касса ---------------------------------------------------------------------------------------

async function cashSale(t, what, items, { received, discount, toBar } = {}) {
  const sub = cartAmount(cat, items);
  const disc = discount ? (discount.percent !== undefined ? percentOf(sub, discount.percent) : discount.amount_kopecks) : 0;
  const total = sub - disc;
  const got = received ?? Math.ceil((total + 1) / 50_000) * 50_000;
  const r = await posSale(rec.token, { items, method: 'cash', received_kopecks: got, ...(discount ? { discount } : {}), ...(toBar ? { to_bar: true } : {}) });
  assert.equal(r.status, 201, `${what}: ${r.text}`);
  assert.equal(r.json.total_kopecks, total, `${what}: сумма сервера = своей`);
  assert.equal(r.json.discount_kopecks, disc);
  assert.equal(r.json.change_kopecks, got - total, `${what}: сдача`);
  return add({ what: `${what} (получено ${rub(got)}, сдача ${rub(got - total)}${disc ? `, скидка ${rub(disc)}` : ''})`, method: 'cash', channel: 'kkt', amount: total, saleId: r.json.sale_id, paymentIds: [r.json.payment_id], receiptIds: [r.json.receipt_id], items }, t);
}

async function terminalSale(t, what, items, { discount } = {}) {
  const sub = cartAmount(cat, items);
  const disc = discount ? (discount.percent !== undefined ? percentOf(sub, discount.percent) : discount.amount_kopecks) : 0;
  const total = sub - disc;
  const r = await posSale(rec.token, { items, method: 'card_terminal', ...(discount ? { discount } : {}) });
  assert.equal(r.status, 201, `${what}: ${r.text}`);
  assert.equal(r.json.total_kopecks, total);
  return add({ what: `${what}${disc ? ` (скидка ${rub(disc)})` : ''}`, method: 'card_terminal', channel: 'kkt', amount: total, saleId: r.json.sale_id, paymentIds: [r.json.payment_id], receiptIds: [r.json.receipt_id] }, t);
}

async function sbpSale(t, what, items) {
  const total = cartAmount(cat, items);
  const r = await posSale(rec.token, { items, method: 'sbp' });
  assert.equal(r.status, 201, `${what}: ${r.text}`);
  assert.equal(r.json.status, 'pending');
  assert.equal(r.json.confirmation?.type, 'qr');
  const pid = ykId(r.json.confirmation);
  emuSucceed(pid);
  const s = await waitSale(rec.token, r.json.sale_id, { printed: false });
  assert.equal(s.total_kopecks, total);
  return add({ what: `${what} (QR на кассе)`, method: 'sbp', channel: 'online', amount: total, pid, saleId: s.sale_id, paymentIds: [s.payment_id] }, t);
}

// Гость ---------------------------------------------------------------------------------------

async function guestOnline(t, g, what, items, method) {
  const total = cartAmount(cat, items);
  const r = await api('POST', '/api/orders', { token: g.guest.token, idem: true, body: { session_id: g.sessionId, items, pay: 'online', method } });
  assert.equal(r.status, 201, `${what}: ${r.text}`);
  assert.equal(r.json.order.subtotal_kopecks, total);
  const pid = ykId(r.json.payment.confirmation);
  emuSucceed(pid);
  const s = await waitSale(rec.token, r.json.payment.sale_id, { printed: false });
  return add({ what, method, channel: 'online', amount: total, pid, saleId: s.sale_id, paymentIds: [s.payment_id] }, t);
}

async function guestTab(g, items) {
  const r = await api('POST', '/api/orders', { token: g.guest.token, idem: true, body: { session_id: g.sessionId, items, pay: 'tab' } });
  assert.equal(r.status, 201, r.text);
  g.tab = (g.tab ?? 0) + cartAmount(cat, items);
  return r.json.order;
}

async function guestTabPay(t, g, what, method) {
  const r = await api('POST', `/api/sessions/${g.sessionId}/tab/pay`, { token: g.guest.token, idem: true, body: { method } });
  assert.ok([200, 201].includes(r.status), r.text);
  assert.equal(r.json.total_kopecks, g.tab);
  const pid = ykId(r.json.confirmation);
  emuSucceed(pid);
  const s = await waitSale(rec.token, r.json.sale_id, { printed: false });
  const e = add({ what, method, channel: 'online', amount: g.tab, pid, saleId: s.sale_id, paymentIds: [s.payment_id] }, t);
  g.tab = 0;
  return e;
}

async function recTabPay(t, g, what, method) {
  const body = method === 'cash' ? { method, received_kopecks: Math.ceil((g.tab + 1) / 100_000) * 100_000 } : { method };
  const r = await api('POST', `/api/sessions/${g.sessionId}/tab/pay`, { token: rec.token, idem: true, body });
  assert.ok([200, 201].includes(r.status), r.text);
  assert.equal(r.json.total_kopecks, g.tab);
  if (method === 'cash') assert.equal(r.json.change_kopecks, body.received_kopecks - g.tab);
  const e = add({ what: `${what}${method === 'cash' ? ` (сдача ${rub(r.json.change_kopecks)})` : ''}`, method, channel: 'kkt', amount: g.tab, saleId: r.json.sale_id, paymentIds: [r.json.payment_id], receiptIds: [r.json.receipt_id] }, t);
  g.tab = 0;
  return e;
}

// Заявки стола M1 -----------------------------------------------------------------------------

async function request(n, minutes = 30) {
  await waitTableFree(n);
  const guest = await newGuest();
  const tbl = await table(n, guest.token);
  const q = await ok(quote(guest.token, { resourceId: tbl.resource.id, minutes }));
  const r = await ok(pay(guest.token, q.quote_id, 'reception'));
  assert.equal(r.status, 'waiting_reception');
  return { n, guest, requestId: r.reception_request_id, amount: q.amount_kopecks };
}

async function requestSession(req) {
  const g = await waitFor(
    async () => {
      const x = await api('GET', `/api/reception/requests/${req.requestId}`, { token: req.guest.token });
      return x.status === 200 && x.json.session_id ? x.json : null;
    },
    { timeoutMs: 10_000, intervalMs: 100, what: 'сессия заявки' },
  );
  req.sessionId = g.session_id;
  requestSessions.push(req);
  return req;
}

async function stopRequest(req) {
  await ok(api('POST', `/api/sessions/${req.sessionId}/stop`, { token: req.guest.token, body: {} }));
  req.sessionId = null;
}

async function tableReceipts(paymentIds) {
  const { rows } = await db.query("select id from bl.receipts where payment_id = any($1::uuid[]) and kind = 'sale' and channel = 'kkt'", [paymentIds]);
  return rows.map((r) => r.id);
}

// День ----------------------------------------------------------------------------------------

test(`сверка: смена открыта, гости за столами ${TABLES[0]} и ${TABLES[1]} (старты онлайн)`, async (t) => {
  shift = await openMyShift({ rec, man, floatKopecks: FLOAT, log: (m) => t.diagnostic(m) });
  t.diagnostic(`смена №${shift.number} (${shift.id.slice(0, 8)}), размен ${rub(FLOAT)}, открыта ${shift.opened_at}`);
  await waitTableFree(TABLES[0]);
  G1 = await startGame(TABLES[0], 60, { method: 'sbp' });
  add({ what: `старт игры стол ${TABLES[0]}, 60 мин`, method: 'sbp', channel: 'online', amount: G1.q.amount_kopecks, pid: G1.pid, paymentIds: [G1.payResp.payment_id] }, t);
  await waitTableFree(TABLES[1]);
  G2 = await startGame(TABLES[1], 60, { method: 'card' });
  add({ what: `старт игры стол ${TABLES[1]}, 60 мин`, method: 'card', channel: 'online', amount: G2.q.amount_kopecks, pid: G2.pid, paymentIds: [G2.payResp.payment_id] }, t);
});

test('сверка: заказы бара гостем онлайн и счета столов', async (t) => {
  await guestOnline(t, G1, `заказ гостя стол ${G1.tbl.resource.number}: капучино 0,4 л`, [{ product_id: P.cappuccino, qty: 1, modifier_ids: [M.v04, M.noSugar] }], 'sbp');
  await guestOnline(t, G1, `заказ гостя стол ${G1.tbl.resource.number}: вода × 2`, [{ product_id: P.waterStill, qty: 2 }], 'sbp');
  await guestOnline(t, G2, `заказ гостя стол ${G2.tbl.resource.number}: чай, чипсы`, [{ product_id: P.teaGreen, qty: 1, modifier_ids: [M.sugar] }, { product_id: P.chips, qty: 1 }], 'card');
  await guestOnline(t, G2, `заказ гостя стол ${G2.tbl.resource.number}: орешки`, [{ product_id: P.nuts, qty: 1 }], 'sbp');
  await guestOnline(t, G1, `заказ гостя стол ${G1.tbl.resource.number}: американо × 2`, [{ product_id: P.americano, qty: 2, modifier_ids: [M.v03, M.sugar] }], 'card');
  await guestOnline(t, G2, `заказ гостя стол ${G2.tbl.resource.number}: газ. вода`, [{ product_id: P.waterSpark, qty: 1 }], 'sbp');
  // Счета столов: в счёт → оплата.
  await guestTab(G1, [{ product_id: P.teaBlack, qty: 1, modifier_ids: [M.noSugar] }]);
  await guestTab(G1, [{ product_id: P.chips, qty: 2 }]);
  await guestTabPay(t, G1, `счёт стола ${G1.tbl.resource.number} гостем онлайн (2 заказа)`, 'sbp');
  await guestTab(G2, [{ product_id: P.cappuccino, qty: 2, modifier_ids: [M.v03, M.noSugar] }]);
  await recTabPay(t, G2, `счёт стола ${G2.tbl.resource.number} на ресепшене наличными`, 'cash');
  await guestTab(G1, [{ product_id: P.nuts, qty: 1 }, { product_id: P.waterSpark, qty: 1 }]);
  await recTabPay(t, G1, `счёт стола ${G1.tbl.resource.number} на ресепшене терминалом`, 'card_terminal');
  await guestTab(G2, [{ product_id: P.americano, qty: 1, modifier_ids: [M.v04, M.sugar] }]);
  await guestTabPay(t, G2, `счёт стола ${G2.tbl.resource.number} гостем онлайн`, 'card');
  const ext = await extendGame(G1.guest, G1.tbl.resource.id, G1.sessionId, 15);
  await waitFor(async () => (await db.query("select status from bl.payments where id = $1 and status = 'succeeded'", [ext.payResp.payment_id])).rowCount === 1, { what: 'продление оплачено' });
  add({ what: `продление игры стол ${G1.tbl.resource.number}, 15 мин`, method: 'sbp', channel: 'online', amount: ext.q.amount_kopecks, pid: ext.pid, paymentIds: [ext.payResp.payment_id] }, t);
});

test('сверка: касса — наличные со сдачей, терминал, СБП по QR', async (t) => {
  const cash = [
    [{ product_id: P.americano, qty: 1, modifier_ids: [M.v03, M.noSugar] }],
    [{ product_id: P.beer, qty: 2 }, { product_id: P.nuts, qty: 1 }],
    [{ product_id: P.teaBlack, qty: 2, modifier_ids: [M.sugar] }],
    [{ product_id: P.waterStill, qty: 3 }],
    [{ product_id: P.cappuccino, qty: 1, modifier_ids: [M.v04, M.sugar] }, { product_id: P.chips, qty: 1 }],
    [{ product_id: P.beer, qty: 1 }],
    [{ product_id: P.teaGreen, qty: 1, modifier_ids: [M.noSugar] }],
    [{ product_id: P.americano, qty: 3, modifier_ids: [M.v04, M.noSugar] }],
    [{ product_id: P.waterSpark, qty: 1 }, { product_id: P.nuts, qty: 2 }],
    [{ product_id: P.chips, qty: 1 }],
    [{ product_id: P.cappuccino, qty: 2, modifier_ids: [M.v03, M.sugar] }],
  ];
  for (const [k, items] of cash.entries()) await cashSale(t, `касса наличные ${k + 1}`, items);
  await cashSale(t, 'касса наличные без сдачи', [{ product_id: P.teaBlack, qty: 1, modifier_ids: [M.noSugar] }], { received: 15_000 });
  const toBar = await cashSale(t, 'касса наличные, заказ на экран бара', [{ product_id: P.americano, qty: 1, modifier_ids: [M.v04, M.sugar] }], { toBar: true });
  const q = await ok(api('GET', `/api/clubs/${CLUB_A}/bar/queue`, { token: rec.token }));
  assert.ok(q.some((o) => o.sale_id === toBar.saleId || o.items.some((i) => i.name.startsWith('Американо'))), 'заказ кассы с to_bar — в очереди бара');
  const term = [
    [{ product_id: P.cappuccino, qty: 1, modifier_ids: [M.v03, M.noSugar] }],
    [{ product_id: P.beer, qty: 3 }],
    [{ product_id: P.waterStill, qty: 1 }, { product_id: P.chips, qty: 1 }],
    [{ product_id: P.teaGreen, qty: 2, modifier_ids: [M.sugar] }],
    [{ product_id: P.nuts, qty: 1 }],
    [{ product_id: P.americano, qty: 2, modifier_ids: [M.v04, M.sugar] }],
    [{ product_id: P.waterSpark, qty: 2 }],
    [{ product_id: P.teaBlack, qty: 1, modifier_ids: [M.sugar] }, { product_id: P.chips, qty: 1 }],
    [{ product_id: P.cappuccino, qty: 1, modifier_ids: [M.v04, M.noSugar] }],
  ];
  for (const [k, items] of term.entries()) await terminalSale(t, `касса терминал ${k + 1}`, items);
  const sbp = [
    [{ product_id: P.teaBlack, qty: 1, modifier_ids: [M.noSugar] }],
    [{ product_id: P.beer, qty: 1 }, { product_id: P.chips, qty: 1 }],
    [{ product_id: P.cappuccino, qty: 1, modifier_ids: [M.v03, M.sugar] }],
    [{ product_id: P.waterStill, qty: 2 }],
    [{ product_id: P.americano, qty: 1, modifier_ids: [M.v04, M.noSugar] }],
  ];
  for (const [k, items] of sbp.entries()) await sbpSale(t, `касса СБП ${k + 1}`, items);
});

test('сверка: скидки — в пределах лимита (ресепшн) и 20 % по PIN управляющего', async (t) => {
  await cashSale(t, 'скидка 10 % (ровно лимит), наличные', [{ product_id: P.cappuccino, qty: 1, modifier_ids: [M.v04, M.sugar] }, { product_id: P.chips, qty: 1 }], { discount: { percent: 10, reason: 'постоянный гость' } });
  await terminalSale(t, 'скидка 5 %, терминал', [{ product_id: P.americano, qty: 2, modifier_ids: [M.v03, M.noSugar] }, { product_id: P.waterStill, qty: 1 }], { discount: { percent: 5 } });
  await cashSale(t, 'скидка 10,01 ₽ суммой, наличные (раскладка по строкам)', [{ product_id: P.teaBlack, qty: 3, modifier_ids: [M.noSugar] }, { product_id: P.nuts, qty: 1 }], { discount: { amount_kopecks: 1001 } });
  const over = await posSale(rec.token, { items: [{ product_id: P.cappuccino, qty: 2, modifier_ids: [M.v03, M.noSugar] }], method: 'cash', received_kopecks: 50_000, discount: { percent: 20, reason: 'x' } });
  t.diagnostic(`ресепшн сам 20 % → ${over.status} ${over.text}`);
  assert.ok([400, 403].includes(over.status));
  assert.equal(over.json.error, 'limit_exceeded');
  const items = [{ product_id: P.cappuccino, qty: 2, modifier_ids: [M.v03, M.noSugar] }];
  const sub = cartAmount(cat, items);
  const bad = await api('POST', '/api/pos/discount-approvals', { token: rec.token, body: { user_id: MANAGER_ID, pin: '0000', reason_code: 'compensation', reason_text: 'e2e', percent: 20, subtotal_kopecks: sub } });
  t.diagnostic(`PIN неверный → ${bad.status} ${bad.text}`);
  assert.equal(bad.status, 401);
  const ap = await api('POST', '/api/pos/discount-approvals', { token: rec.token, body: { user_id: MANAGER_ID, pin: PIN, reason_code: 'compensation', reason_text: 'Компенсация за ожидание заказа (e2e)', percent: 20, subtotal_kopecks: sub } });
  t.diagnostic(`PIN управляющего → ${ap.status} ${ap.text}`);
  assert.equal(ap.status, 201);
  const e = await cashSale(t, 'скидка 20 % по PIN управляющего, наличные', items, { discount: { percent: 20, approval_id: ap.json.approval_id } });
  const au = await auditFor(db, e.saleId, ['manual.discount', 'pos.discount', 'pos.discount_approval']);
  t.diagnostic(`журнал скидки: ${au.map((a) => `${a.action} actor=${a.actor_id === MANAGER_ID ? 'управляющий' : a.actor_id} reason=${a.reason}`).join('; ')}`);
  assert.ok(au.some((a) => a.action === 'manual.discount' && a.actor_id === MANAGER_ID && a.reason));
  const reuse = await posSale(rec.token, { items, method: 'cash', received_kopecks: 50_000, discount: { percent: 20, approval_id: ap.json.approval_id } });
  t.diagnostic(`повтор того же подтверждения → ${reuse.status} ${reuse.text}`);
  assert.equal(reuse.status, 403);
  const { rows: al } = await db.query("select type, level, count from bl.alarms where club_id = $1 and type = 'discount_over_limit' and state = 'open'", [CLUB_A]);
  t.diagnostic(`тревога владельцу: ${JSON.stringify(al)}`);
  assert.equal(al.length, 1);
});

test('сверка: заявки стола M1 на ресепшене (касса и «Принять»)', async (t) => {
  // Касса: заявка наличными со сдачей.
  let req = await request(nextReqTable());
  let r = await posSale(rec.token, { requests: [req.requestId], method: 'cash', received_kopecks: Math.ceil((req.amount + 1) / 100_000) * 100_000 });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.table_kopecks, req.amount);
  add({ what: `заявка стол ${req.n} на кассе наличными (сдача ${rub(r.json.change_kopecks)})`, method: 'cash', channel: 'kkt', amount: req.amount, saleId: r.json.sale_id, paymentIds: r.json.table_payments.map((p) => p.payment_id) }, t);
  await stopRequest(await requestSession(req));
  // Касса: заявка терминалом.
  req = await request(nextReqTable());
  r = await posSale(rec.token, { requests: [req.requestId], method: 'card_terminal' });
  assert.equal(r.status, 201, r.text);
  add({ what: `заявка стол ${req.n} на кассе терминалом`, method: 'card_terminal', channel: 'kkt', amount: req.amount, saleId: r.json.sale_id, paymentIds: r.json.table_payments.map((p) => p.payment_id) }, t);
  await stopRequest(await requestSession(req));
  // «Принять» M1: наличные и терминал.
  req = await request(nextReqTable());
  let acc = await ok(api('POST', `/api/reception/requests/${req.requestId}/accept`, { token: rec.token, idem: true, body: { method: 'cash', received_kopecks: Math.ceil((req.amount + 1) / 100_000) * 100_000 } }));
  add({ what: `заявка стол ${req.n} «Принять» наличными (сдача ${rub(acc.change_kopecks)})`, method: 'cash', channel: 'kkt', amount: req.amount, paymentIds: [acc.payment_id] }, t);
  await stopRequest(await requestSession(req));
  req = await request(nextReqTable());
  acc = await ok(api('POST', `/api/reception/requests/${req.requestId}/accept`, { token: rec.token, idem: true, body: { method: 'card_terminal' } }));
  add({ what: `заявка стол ${req.n} «Принять» терминалом`, method: 'card_terminal', channel: 'kkt', amount: req.amount, paymentIds: [acc.payment_id] }, t);
  await stopRequest(await requestSession(req));
  // Касса: заявка + бар в одной продаже (два чека ККТ, №86).
  req = await request(nextReqTable());
  const items = [{ product_id: P.beer, qty: 2 }, { product_id: P.chips, qty: 1 }];
  const bar = cartAmount(cat, items);
  r = await posSale(rec.token, { requests: [req.requestId], items, method: 'cash', received_kopecks: Math.ceil((req.amount + bar + 1) / 100_000) * 100_000 });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.total_kopecks, req.amount + bar);
  add({ what: `заявка стол ${req.n} на кассе наличными (часть «стол»)`, method: 'cash', channel: 'kkt', amount: req.amount, saleId: r.json.sale_id, paymentIds: r.json.table_payments.map((p) => p.payment_id) }, t);
  add({ sameSale: true, what: `та же продажа, бар (сдача ${rub(r.json.change_kopecks)} на всё)`, method: 'cash', channel: 'kkt', amount: bar, saleId: r.json.sale_id, paymentIds: [r.json.payment_id], receiptIds: [r.json.receipt_id] }, t);
  await stopRequest(await requestSession(req));
  req = await request(nextReqTable());
  r = await posSale(rec.token, { requests: [req.requestId], method: 'cash', received_kopecks: req.amount });
  assert.equal(r.status, 201, r.text);
  add({ what: `заявка стол ${req.n} на кассе наличными без сдачи`, method: 'cash', channel: 'kkt', amount: req.amount, saleId: r.json.sale_id, paymentIds: r.json.table_payments.map((p) => p.payment_id) }, t);
  await stopRequest(await requestSession(req));
});

test('сверка: 50 продаж в книге и один возврат (управляющий)', async (t) => {
  t.diagnostic(`продаж: ${sales} (записей книги ${book.length}: заявка + бар в одной продаже — два чека)`);
  assert.equal(sales, 50, 'тестовый день — 50 продаж');
  // Возврат: в продаже «касса наличные 2» (пиво × 2, орешки) вернуть одно пиво.
  const target = book.find((e) => e.what.startsWith('касса наличные 2 '));
  const sale = await ok(api('GET', `/api/pos/sales/${target.saleId}`, { token: man.token }));
  const beer = sale.items.find((i) => i.name.startsWith('Пиво'));
  const recTry = await api('POST', `/api/pos/sales/${target.saleId}/refund`, { token: rec.token, idem: true, body: { reason: 'x', items: [{ order_item_id: beer.order_item_id, qty: 1 }] } });
  const noReason = await api('POST', `/api/pos/sales/${target.saleId}/refund`, { token: man.token, idem: true, body: { items: [{ order_item_id: beer.order_item_id, qty: 1 }] } });
  t.diagnostic(`возврат ресепшеном → ${recTry.status}; без причины → ${noReason.status} ${noReason.text}`);
  assert.equal(recTry.status, 403);
  assert.equal(noReason.status, 400);
  const unit = beer.amount_kopecks / beer.qty; // строка без скидки — цена единицы ровно
  const rf = await api('POST', `/api/pos/sales/${target.saleId}/refund`, { token: man.token, idem: true, body: { reason: 'Гость вернул закрытую бутылку (e2e)', items: [{ order_item_id: beer.order_item_id, qty: 1 }] } });
  t.diagnostic(`возврат управляющим → HTTP ${rf.status} ${JSON.stringify(rf.json)}`);
  assert.equal(rf.status, 201, rf.text);
  assert.equal(rf.json.amount_kopecks, unit);
  refunds.push({ amount: unit, method: 'cash', refundId: rf.json.refund_id, receiptId: rf.json.receipt_id, saleId: target.saleId });
  const au = await auditFor(db, target.saleId, ['pos.refund']);
  assert.equal(au.length, 1);
  assert.ok(au[0].reason);
  const { rows: al } = await db.query("select level from bl.alarms where club_id = $1 and type = 'pos_refund' and state = 'open'", [CLUB_A]);
  t.diagnostic(`журнал pos.refund: reason=«${au[0].reason}»; тревога pos_refund: ${JSON.stringify(al)}`);
  assert.equal(al.length, 1);
});

test('сверка: чеки ККТ пробиты, по одному документу на чек; онлайн — в ЮKassa', async (t) => {
  // Чеки заявок стола пишет money M1 (не касса) — находим по платежам.
  for (const e of book) if (e.channel === 'kkt' && e.receiptIds.filter(Boolean).length === 0) e.receiptIds = await tableReceipts(e.paymentIds);
  const ids = [...book.flatMap((e) => (e.channel === 'kkt' ? e.receiptIds : [])), ...refunds.map((r) => r.receiptId)];
  assert.equal(ids.filter(Boolean).length, ids.length, 'у каждой продажи наличными и терминалом есть чек ККТ');
  await waitReceiptsPrinted(db, ids, { timeoutMs: 120_000 });
  const docs = kktDocs();
  let kktSell = 0;
  let kktReturn = 0;
  for (const id of ids) {
    const r = await receiptRow(db, id);
    const d = docsFor(docs, r);
    assert.equal(d.length, 1, `чек ${id}: документов ${d.length}`);
    assert.equal(d[0].total_kopecks, Number(r.amount_kopecks));
    if (d[0].kind === 'sellReturn') kktReturn += d[0].total_kopecks;
    else kktSell += d[0].total_kopecks;
  }
  const myKkt = sum(book.filter((e) => e.channel === 'kkt'));
  t.diagnostic(`АТОЛ: чеков прихода ${ids.length - refunds.length} на ${rub(kktSell)}, возврата ${refunds.length} на ${rub(kktReturn)}; своя книга: касса и заявки ${rub(myKkt)}, возвраты ${rub(sum(refunds))}`);
  assert.equal(kktSell, myKkt);
  assert.equal(kktReturn, sum(refunds));
  let yk = 0;
  for (const e of book.filter((x) => x.channel === 'online')) {
    const p = emuPayment(e.pid);
    assert.equal(p.status, 'succeeded', `${e.what}: ${p.status}`);
    assert.equal(Math.round(Number(p.amount.value) * 100), e.amount, `${e.what}: сумма в ЮKassa`);
    yk += e.amount;
  }
  t.diagnostic(`ЮKassa (эмулятор): ${book.filter((x) => x.channel === 'online').length} платежей на ${rub(yk)}`);
  // Журнал: у каждой продажи кассы и гостя — pos.sale, у заявок — reception.accept, у стартов — payment.succeeded.
  let missing = 0;
  for (const e of book) {
    const acts = e.saleId ? ['pos.sale'] : e.pid ? ['payment.succeeded'] : ['reception.accept'];
    const au = await auditFor(db, e.saleId ?? e.paymentIds[0], acts);
    if (au.length === 0) {
      missing += 1;
      t.diagnostic(`нет записи журнала ${acts} у «${e.what}»`);
    }
  }
  assert.equal(missing, 0, 'у каждой продажи есть запись в журнале');
});

test('сверка: закрытие смены честным фактом и отчёт — расхождение 0 копеек', async (t) => {
  const by = { cash: 0, card_terminal: 0, sbp: 0, card: 0 };
  for (const e of book) by[e.method] += e.amount;
  const myRefundCash = sum(refunds.filter((r) => r.method === 'cash'));
  const myIds = new Set(book.flatMap((e) => e.paymentIds));
  const { rows: all } = await db.query(
    "select id, method, amount_kopecks, kind from bl.payments where club_id = $1 and confirmed_at >= $2 and status = 'succeeded'",
    [CLUB_A, shift.opened_at],
  );
  const foreign = all.filter((p) => !myIds.has(p.id));
  const fBy = { cash: 0, card_terminal: 0, sbp: 0, card: 0 };
  for (const p of foreign) fBy[p.method] += Number(p.amount_kopecks);
  t.diagnostic(`своя книга: ${sales} продаж (${book.length} записей); наличные ${rub(by.cash)}, терминал ${rub(by.card_terminal)}, СБП ${rub(by.sbp)}, карта онлайн ${rub(by.card)}; возврат наличными ${rub(myRefundCash)}`);
  t.diagnostic(`чужие платежи в окне смены: ${foreign.length} ${JSON.stringify(fBy)}`);
  const myExpected = FLOAT + by.cash - myRefundCash + fBy.cash;
  const r = await api('POST', `/api/shifts/${shift.id}/close`, { token: rec.token, body: { actual_cash_kopecks: myExpected, comment: 'e2e: сверка 50 продаж' } });
  t.diagnostic(`закрытие с фактом ${rub(myExpected)} (свой расчёт: размен + наличные − возврат) → HTTP ${r.status}: ожидалось ${r.json?.expected_cash_kopecks}, расхождение ${r.json?.discrepancy_kopecks}`);
  assert.equal(r.status, 200, r.text);
  closed = r.json;
  assert.equal(closed.expected_cash_kopecks, myExpected);
  assert.equal(closed.discrepancy_kopecks, 0, 'расхождение 0 копеек');

  const rep = await ok(api('GET', `/api/shifts/${shift.id}/report`, { token: owner.token }));
  const v = rep.revenue;
  t.diagnostic(`отчёт: выручка ${rub(v.total_kopecks)} (столы ${rub(v.tables.total_kopecks)}, бар ${rub(v.bar.total_kopecks)}); по способам ${JSON.stringify(v.by_method)}; возвраты ${JSON.stringify(v.refunds.by_method)}; платежей ${v.payments_count}`);
  for (const m of Object.keys(by)) assert.equal(v.by_method[m], by[m] + fBy[m], `отчёт ${m}`);
  assert.equal(v.refunds.by_method.cash, myRefundCash);
  const k = rep.reconciliation.kkt;
  const myKkt = by.cash + by.card_terminal - myRefundCash + fBy.cash + fBy.card_terminal;
  t.diagnostic(`сверка ККТ: ok=${k.ok} система ${rub(k.system_kopecks)} ККТ ${rub(k.kkt_kopecks)} разница ${k.diff_kopecks}; без чека ${k.missing_count}; чеки ${JSON.stringify(k.receipts)}; свой расчёт ${rub(myKkt)}`);
  assert.equal(k.ok, true);
  assert.equal(k.diff_kopecks, 0);
  assert.equal(k.kkt_kopecks, myKkt);
  const o = rep.reconciliation.online;
  const myOnline = by.sbp + by.card + fBy.sbp + fBy.card;
  t.diagnostic(`сверка онлайн: ok=${o.ok} status=${o.status} система ${rub(o.system_kopecks)} ЮKassa ${rub(o.yookassa_kopecks)} разница ${o.diff_kopecks}, платежей ${o.payments}, расхождений ${o.mismatches?.length}; свой расчёт ${rub(myOnline)}`);
  assert.equal(o.status, 'checked');
  assert.equal(o.ok, true);
  assert.equal(o.diff_kopecks, 0);
  assert.equal(o.yookassa_kopecks, myOnline);
  t.diagnostic(`касса: ${JSON.stringify(rep.cash)}; ссылки смены: ${JSON.stringify(rep.reconciliation.shift_links).slice(0, 200)}; ручных действий ${rep.manual_actions?.count}`);
  assert.equal(rep.cash.discrepancy_kopecks, 0);
});
