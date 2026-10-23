// Пакеты часов (контракт M3 §1 п. 10; decisions №112, №117, №118).
//
// Стол для игры балансом — E2E_PKG_TABLE (по умолчанию 6).
// 1. Управляющий заводит пакет «1 ч» (причина обязательна; журнал tariff.package_created,
//    уведомление владельцу); ресепшн — 403.
// 2. Гость покупает пакет в приложении (СБП, эмулятор): платёж kind package, чек ЮKassa
//    «предоплата 100 %», баланс +60 минут.
// 3. Игра балансом: котировка use_balance → 0 ₽, оплата method balance — свет сразу, без нового
//    платежа ЮKassa и без чека прихода; чек зачёта по платежу пакета (/v3/receipts, prepayment) на
//    долю цены; минуты списаны (balance_debits), баланс 58.
// 4. Возврат тронутого пакета — 409 package_used; второго, нетронутого: ресепшн — 403, без
//    причины — 400, управляющий — партия отозвана, возврат ЮKassa с чеком возврата, журнал
//    manual.package_refund, тревога владельцу; повтор — 409 already_refunded.
// 5. Касса (своя смена): пакет незарегистрированному телефону — 409 guest_not_found, учётка не
//    создана; гостю приложения наличными — чек ККТ с позицией full_prepayment, минуты начислены;
//    возврат этого пакета в возврате продажи — партия отозвана, чек возврата ККТ; пакет, из
//    которого играли, — 409 package_used. Смена закрывается без расхождения. Отчёт смены: возврат
//    пакета — одна строка ручных действий (деньги склеены, linked); поздняя отмена брони гостем
//    (удержание 30 %, возврат 70 %) — в действиях гостей, не в ручных.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  auditOf,
  CLUB_A,
  closeMyShift,
  createBooking,
  emu,
  emuPayment,
  emuReceipts,
  FAST_BOOKING,
  guestPhone,
  MIN,
  newGuest,
  notificationsOf,
  OWNER_ID,
  ok,
  openMyShift,
  patchClubSettings,
  payBooking,
  posSale,
  RES,
  restoreForfeitPercent,
  session,
  setForfeitPercent,
  slotAfter,
  staff,
  waitFor,
  waitReceiptsPrinted,
  waitSale,
  waitSettlementSent,
  waitSim,
  waitTableFree,
  ykId,
} from './helpers.mjs';

const T = Number(process.env.E2E_PKG_TABLE || 6);
const PRICE = 60_000;
let db;
let man;
let rec;
let pkg;
let shift;

before(async () => {
  db = await adminClient();
  man = await staff('manager');
  rec = await staff('reception');
});

after(async () => {
  if (shift) await closeMyShift({ rec, man, shiftId: shift.id }).catch((e) => console.log(`смена не закрыта: ${e.message}`));
  if (pkg) await api('POST', `/api/packages/${pkg.id}/archive`, { token: man.token, body: { reason: 'e2e: уборка' } }).catch(() => null);
  await db?.end();
});

async function balance(token) {
  return ok(api('GET', `/api/clubs/${CLUB_A}/balance`, { token }));
}

async function buy(guest) {
  const r = await ok(api('POST', `/api/packages/${pkg.id}/buy`, { token: guest.token, body: { method: 'sbp' }, idem: true }));
  const pid = ykId(r.confirmation);
  emu(`/__emu/payments/${pid}/succeed?wait=1`, { post: true });
  const b = await waitFor(async () => {
    const x = await balance(guest.token);
    return x.lots.some((l) => l.package_id === pkg.id) ? x : null;
  }, { timeoutMs: 15_000, what: 'минуты пакета начислены' });
  return { r, pid, b };
}

/** Игра балансом на столе T: котировка use_balance → pay method balance → свет. */
async function playByBalance(guest, minutes) {
  await waitTableFree(T);
  const q = await ok(api('POST', '/api/quotes', { token: guest.token, body: { resource_id: RES(T), kind: 'start', minutes, use_balance: true } }));
  const p = await ok(api('POST', `/api/quotes/${q.quote_id}/pay`, { token: guest.token, body: { method: 'balance' }, idem: true }));
  const pay = await waitFor(async () => {
    const r = await api('GET', `/api/payments/${p.payment_id}`, { token: guest.token });
    return r.status === 200 && r.json.session_id ? r.json : null;
  }, { timeoutMs: 15_000, what: 'сессия по балансу' });
  const on = await waitSim(T, (s) => s.state.relay === true && s.state.session_id === pay.session_id, { timeoutMs: 5000, what: 'свет по балансу' });
  return { q, p, sessionId: pay.session_id, on };
}

async function stopGame(guest, sessionId) {
  await ok(api('POST', `/api/sessions/${sessionId}/stop`, { token: guest.token }));
  await waitSim(T, (s) => s.state.mode === 'free', { timeoutMs: 10_000 });
}

test('пакет заводит управляющий с причиной; ресепшн — 403', async (t) => {
  const since = new Date(Date.now() - 1000);
  const body = { title: `Час e2e ${Date.now() % 10000}`, hours: 1, price_kopecks: PRICE, valid_days: 30 };
  const byRec = await api('POST', `/api/clubs/${CLUB_A}/packages`, { token: rec.token, body: { ...body, reason: 'x' } });
  const noReason = await api('POST', `/api/clubs/${CLUB_A}/packages`, { token: man.token, body });
  t.diagnostic(`ресепшн: ${byRec.status}; без причины: ${noReason.status} ${noReason.text}`);
  assert.equal(byRec.status, 403);
  assert.equal(noReason.status, 400);
  pkg = await ok(api('POST', `/api/clubs/${CLUB_A}/packages`, { token: man.token, body: { ...body, reason: 'Акция для постоянных гостей (тест e2e)' } }), 201);
  const list = await ok(api('GET', `/api/clubs/${CLUB_A}/packages`));
  t.diagnostic(`пакет ${JSON.stringify(pkg)}; в витрине без входа: ${list.some((p) => p.id === pkg.id)}`);
  assert.ok(list.some((p) => p.id === pkg.id));
  const au = await auditOf(db, pkg.id);
  assert.ok(au.some((a) => a.action === 'tariff.package_created' && a.reason));
  const n = await waitFor(async () => (await notificationsOf(db, OWNER_ID, { since })).find((x) => x.text.includes(pkg.title)) ?? null, { timeoutMs: 10_000, what: 'уведомление владельцу' });
  t.diagnostic(`владельцу: «${n.text}»`);
});

let buyer;
let firstLot;

test('покупка в приложении (чек full_prepayment) и игра балансом: без нового чека прихода, чек зачёта, минуты списаны', { timeout: 5 * MIN }, async (t) => {
  assert.ok(pkg);
  buyer = await newGuest();
  const { r, pid, b } = await buy(buyer);
  const pay = (await db.query('select id, kind, status, amount_kopecks from bl.payments where id = $1', [r.payment_id])).rows[0];
  const ep = emuPayment(pid);
  t.diagnostic(`покупка: платёж ${pay.kind}/${pay.status}/${pay.amount_kopecks}; чек ЮKassa ${JSON.stringify(ep.receipt?.items?.map((i) => [i.description, i.amount.value, i.payment_mode]))}; баланс ${b.minutes} мин`);
  assert.equal(pay.kind, 'package');
  assert.equal(Number(pay.amount_kopecks), PRICE);
  assert.deepEqual(ep.receipt.items.map((i) => i.payment_mode), ['full_prepayment']);
  assert.equal(b.minutes, 60);
  firstLot = b.lots[0];

  const tPlay = new Date();
  const g = await playByBalance(buyer, 2);
  t.diagnostic(`котировка балансом: ${g.q.amount_kopecks} коп., balance_minutes ${g.q.balance_minutes}; оплата ${JSON.stringify(g.p)}; свет ${g.on.state.relay}`);
  assert.equal(g.q.amount_kopecks, 0);
  assert.equal(g.q.balance_minutes, 2);
  const balPay = (await db.query('select id, provider, method, status, amount_kopecks, provider_payment_id from bl.payments where id = $1', [g.p.payment_id])).rows[0];
  // Платежи гостя в ЮKassa после начала игры (эмулятор общий с параллельными сценариями — считаем по гостю).
  const { rows: ykNew } = await db.query("select count(*)::int as n from bl.payments where user_id = $1 and provider = 'yookassa' and created_at >= $2", [buyer.user.id, tPlay]);
  const ownReceipts = (await db.query('select kind, channel, status, amount_kopecks, settles_payment_id from bl.receipts where payment_id = $1', [balPay.id])).rows;
  t.diagnostic(`платёж игры: ${balPay.provider}/${balPay.method}/${balPay.status}, стоимость ${balPay.amount_kopecks} коп., в ЮKassa ${balPay.provider_payment_id}; новых платежей ЮKassa гостя ${ykNew[0].n}; чеки по платежу игры ${JSON.stringify(ownReceipts)}`);
  assert.equal(balPay.method, 'balance');
  assert.equal(balPay.provider_payment_id, null);
  assert.equal(ykNew[0].n, 0, 'нового платежа ЮKassa нет');
  assert.ok(ownReceipts.every((x) => x.settles_payment_id), 'чека прихода по игре нет — только зачёт');
  // Ревью п. 2: чек зачёта за минуты баланса — при закрытии сессии, за сыгранное.
  await stopGame(buyer, g.sessionId);
  const settle = await waitSettlementSent(db, r.payment_id);
  const share = Math.floor((PRICE * 2 * 2 + 60) / (2 * 60));
  const er = emuReceipts(pid);
  t.diagnostic(`чек зачёта: ${settle.map((x) => `${x.settlement_kopecks}/${x.status}`).join(', ')} (доля 2/60 цены = ${share}); в ЮKassa ${JSON.stringify(er.map((x) => ({ items: x.items.map((i) => [i.amount.value, i.payment_mode]), s: x.settlements })))}`);
  assert.equal(settle.length, 1);
  assert.equal(Number(settle[0].settlement_kopecks), share);
  assert.ok(er.some((x) => x.settlements[0].type === 'prepayment'));
  const debits = (await db.query('select minutes, value_kopecks from bl.balance_debits where payment_id = $1', [balPay.id]).catch(() => ({ rows: [] }))).rows;
  const b2 = await balance(buyer.token);
  t.diagnostic(`списания ${JSON.stringify(debits)}; баланс ${b2.minutes} мин`);
  assert.equal(b2.minutes, 58);
  const s = await session(buyer.token, g.sessionId);
  assert.ok(Math.abs(new Date(s.paid_until) - new Date(s.started_at) - 2 * MIN) < 2000);
});

test('возврат пакета: тронутый — package_used; нетронутый — целиком с чеком возврата (№118)', async (t) => {
  const since = new Date(Date.now() - 1000);
  const used = await api('POST', `/api/packages/lots/${firstLot.id}/refund`, { token: man.token, body: { reason: 'тест e2e' } });
  t.diagnostic(`тронутый пакет: ${used.status} ${used.text}`);
  assert.equal(used.status, 409);
  assert.equal(used.json.error, 'package_used');
  const { pid, b } = await buy(buyer);
  const lot = b.lots.find((l) => l.id !== firstLot.id);
  const byRec = await api('POST', `/api/packages/lots/${lot.id}/refund`, { token: rec.token, body: { reason: 'тест e2e' } });
  const noReason = await api('POST', `/api/packages/lots/${lot.id}/refund`, { token: man.token, body: {} });
  t.diagnostic(`второй пакет ${lot.minutes_left} мин: ресепшн ${byRec.status}, без причины ${noReason.status}`);
  assert.equal(byRec.status, 403);
  assert.equal(noReason.status, 400);
  const rf = await ok(api('POST', `/api/packages/lots/${lot.id}/refund`, { token: man.token, body: { reason: 'Ошибка продажи (тест e2e)' } }));
  const ep = await waitFor(async () => {
    const x = emuPayment(pid);
    return x.refunded_amount ? x : null;
  }, { timeoutMs: 15_000, what: 'возврат в ЮKassa' });
  const rr = ep.receipts.filter((x) => x.kind === 'refund');
  const { rows: lr } = await db.query('select minutes_left, revoked_at from bl.balance_lots where id = $1', [lot.id]);
  t.diagnostic(`возврат: ${JSON.stringify(rf)}; ЮKassa вернула ${ep.refunded_amount.value}, чек возврата ${JSON.stringify(rr.map((x) => x.receipt.items.map((i) => [i.amount.value, i.payment_mode])))}; партия ${JSON.stringify(lr[0])}`);
  assert.equal(rf.amount_kopecks, PRICE);
  assert.equal(Math.round(Number(ep.refunded_amount.value) * 100), PRICE);
  assert.equal(rr.length, 1);
  assert.equal(lr[0].minutes_left, 0);
  assert.ok(lr[0].revoked_at);
  assert.equal((await balance(buyer.token)).minutes, 58);
  const au = await auditOf(db, lot.id);
  assert.ok(au.some((a) => a.action === 'manual.package_refund' && a.reason));
  const again = await api('POST', `/api/packages/lots/${lot.id}/refund`, { token: man.token, body: { reason: 'повтор' } });
  t.diagnostic(`повтор: ${again.status} ${again.text}`);
  assert.equal(again.status, 409);
  assert.equal(again.json.error, 'already_refunded');
  // Инвариант 8: ручное действие сразу уходит владельцу — и владелец должен понять, что и почему.
  const owner = await waitFor(async () => (await notificationsOf(db, OWNER_ID, { kind: 'alarm', since }))[0] ?? null, { timeoutMs: 10_000, what: 'тревога владельцу о возврате пакета' });
  t.diagnostic(`владельцу (${owner.level}): «${owner.text}»`);
  assert.ok(owner.text.includes('Ошибка продажи (тест e2e)'), 'в уведомлении владельцу — что сделано и причина');
  assert.ok(owner.text.includes('600'), 'сумма возврата');
  assert.ok(owner.text.includes(pkg.title), 'какой пакет');
  assert.ok(!owner.text.includes(buyer.phone.slice(2)), 'телефон гостя — только маской');
  assert.equal(owner.level, 'critical');
});

test('пакет на кассе: guest_not_found для незарегистрированного (№117), продажа наличными, возврат', { timeout: 6 * MIN }, async (t) => {
  shift = await openMyShift({ rec, man, floatKopecks: 500_000, log: (m) => t.diagnostic(m) });
  const stranger = guestPhone();
  const nf = await posSale(rec.token, { items: [{ kind: 'package', package_id: pkg.id, phone: stranger }], method: 'cash', received_kopecks: PRICE });
  const { rows: u } = await db.query('select count(*)::int as n from bl.users where phone = $1', [stranger]);
  t.diagnostic(`незарегистрированный телефон: ${nf.status} ${nf.text}; учёток с этим номером: ${u[0].n}`);
  assert.equal(nf.status, 409);
  assert.equal(nf.json.error, 'guest_not_found');
  assert.equal(u[0].n, 0);

  const g = await newGuest();
  const sale = await posSale(rec.token, { items: [{ kind: 'package', package_id: pkg.id, phone: g.phone }], method: 'cash', received_kopecks: 100_000 });
  assert.equal(sale.status, 201, sale.text);
  const done = await waitSale(rec.token, sale.json.sale_id);
  const rc = (await db.query('select id, kind, status, items, fd from bl.receipts where sale_id = $1 or payment_id = $2', [sale.json.sale_id, done.payment_id ?? null])).rows;
  t.diagnostic(`продажа: ${done.total_kopecks} коп., сдача ${sale.json.change_kopecks}, пакеты ${JSON.stringify(done.packages?.map((p) => [p.title, p.amount_kopecks, Boolean(p.lot_id)]))}; чек ККТ ${JSON.stringify(rc.map((r) => [r.kind, r.status, r.fd, (r.items ?? []).map((i) => i.payment_mode ?? i.paymentMethod ?? i.payment_method)]))}`);
  assert.equal(done.package_kopecks, PRICE);
  assert.ok(JSON.stringify(rc[0].items).includes('full_prepayment') || JSON.stringify(rc[0].items).includes('fullPrepayment'), 'позиция пакета — предоплата 100 %');
  assert.equal((await balance(g.token)).minutes, 60);
  const refund = await api('POST', `/api/pos/sales/${sale.json.sale_id}/refund`, { token: man.token, idem: true, body: { reason: 'Гость передумал (тест e2e)', packages: [0] } });
  t.diagnostic(`возврат пакета кассы: ${refund.status} ${refund.text.slice(0, 200)}`);
  assert.equal(refund.status, 201, refund.text);
  if (refund.json.receipt_id) await waitReceiptsPrinted(db, refund.json.receipt_id);
  assert.equal((await balance(g.token)).minutes, 0);

  // Тронутый пакет кассы не возвращается.
  const g2 = await newGuest();
  const sale2 = await posSale(rec.token, { items: [{ kind: 'package', package_id: pkg.id, phone: g2.phone }], method: 'cash', received_kopecks: PRICE });
  assert.equal(sale2.status, 201, sale2.text);
  await waitSale(rec.token, sale2.json.sale_id);
  const game = await playByBalance(g2, 1);
  await stopGame(g2, game.sessionId);
  const used = await api('POST', `/api/pos/sales/${sale2.json.sale_id}/refund`, { token: man.token, idem: true, body: { reason: 'тест e2e', packages: [0] } });
  t.diagnostic(`возврат тронутого пакета кассы: ${used.status} ${used.text}`);
  assert.equal(used.status, 409);
  assert.equal(used.json.error, 'package_used');

  // Поздняя отмена брони гостем в этой смене (удержание 30 %, 70 % возвращается) — действие гостя.
  await patchClubSettings(db, { ...FAST_BOOKING, booking_prepayment: 'full' });
  const g3 = await newGuest();
  const bk = await ok(createBooking(g3.token, { table: T, startsAt: slotAfter(60 * MIN), minutes: 15 }), 201);
  await payBooking(g3, bk.id);
  await setForfeitPercent(db, 30);
  let late;
  try {
    late = await ok(api('POST', `/api/bookings/${bk.id}/cancel`, { token: g3.token, body: {} }));
  } finally {
    await restoreForfeitPercent(db);
  }
  t.diagnostic(`поздняя отмена брони гостем: возврат ${late.refund_kopecks} коп. из ${bk.amount_kopecks}`);

  const closed = await closeMyShift({ rec, man, shiftId: shift.id });
  t.diagnostic(`смена закрыта: расхождение ${closed?.discrepancy_kopecks ?? closed?.shift?.discrepancy_kopecks}`);
  const shiftId = shift.id;
  shift = null;
  // Отчёт смены пишется после закрытия (report_sent_at).
  const rep = await waitFor(async () => (await db.query('select report from bl.shifts where id = $1', [shiftId])).rows[0]?.report ?? null, { timeoutMs: 20_000, what: 'отчёт смены' });
  const ma = rep.manual_actions;
  assert.ok(ma, 'в отчёте смены есть ручные действия');
  const pkgRows = ma.items.filter((i) => i.action === 'manual.package_refund');
  t.diagnostic(`отчёт смены: ручных ${ma.count} ${JSON.stringify(ma.by_action)}; возврат пакета: ${JSON.stringify(pkgRows.map((i) => ({ reason: i.reason, linked: i.linked })))}; гостей ${ma.guests?.count} ${JSON.stringify(ma.guests?.by_action)}; автоматических ${ma.automatic?.count} ${JSON.stringify(ma.automatic?.by_action)}`);
  assert.ok(pkgRows.length >= 1, 'возврат пакета в ручных');
  assert.ok(pkgRows.every((i) => Array.isArray(i.linked) && i.linked.length >= 1), 'деньги возврата пакета склеены с ним (linked)');
  assert.equal(ma.by_action['pos.refund'], undefined, 'возврат кассы пакета — не отдельной строкой');
  assert.equal(ma.by_action['payment.refunded'], undefined, 'возврат денег — не отдельной строкой');
  assert.ok((ma.guests?.by_action?.['payment.refunded'] ?? 0) >= 1, 'возврат при поздней отмене гостем — в действиях гостей');
  assert.equal(ma.by_action['booking.cancel'], undefined);
});
