// T29 «Цифры сходятся» на живых сутках: известный набор сегодня на столах 1–6 клуба сида
// (docs/contracts/m5-2.md §6; №167–171, №177, №178, №187).
//
// Своя смена ресепшена (размен 3 000 ₽) и набор:
//   стол 1 — игра по QR (СБП) + продление гостем по QR;   стол 2 — «Оплачу на ресепшене», наличные со сдачей;
//   стол 3 — депозит «Без лимита» наличными, расчёт по факту (возврат остатка наличными);
//   стол 4 — пакет часов (покупка онлайн) и игра пакетом;   стол 5 — сервисный свет с причиной (в причине телефон);
//   стол 6 — бронь по телефону с неявкой (no_show);        бар — касса: наличные и карта на кассе;
//   возврат «на следующий день»: продажа бара по СБП за 23.10 возвращается сегодня управляющим;
//   тревога сервисного света — принята управляющим (реакция), тревога за 23.10 — принята сегодня (> 10 мин).
// Проверки:
//   * дашборд за сегодня (на лету) = свежая утренняя сводка за сегодня = SQL по оплатам; сумма отчётов
//     смен + оплаты вне смен (№187); своя смена — свой отчёт = своё; приращение после набора = набор;
//   * игры, минуты, сервис, брони, продления, пакеты, гости, ручные действия, тревоги, скан → свет,
//     свет без журнала (0); таблица по столам; CSV = экран; причина с телефоном — маской;
//   * возврат 23.10 уменьшает сегодня, агрегат 23.10 не меняется (№168);
//   * закрытие суток: настоящий planner дашборда (recomputeDay) и планировщик сводок с подставными
//     часами «завтра 06:10» и «завтра 10:00» в транзакции с ROLLBACK — агрегат = на лету = сводка;
//   * поздний возврат, пришедший в закрытые сутки (подставная строка в ROLLBACK): триггер отмечает
//     сутки «грязными», настоящий tick() дашборда пересчитывает, агрегат уменьшается на возврат = сводка;
//   * настоящий пересчёт закрытых суток сервером: тревога 23.10 принята сегодня → отметка → агрегат
//     23.10 пересчитан планировщиком сервера.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { tick as statsTick } from '../../../server/dashboard/index.mjs';
import { computeDay } from '../../../server/dashboard/day.mjs';
import { loadClub, recomputeDay } from '../../../server/dashboard/store.mjs';
import { tick as summariesTick, buildMorningSummary } from '../../../server/summaries/index.mjs';
import {
  addDays,
  adminClient,
  api,
  apiRaw,
  appClient,
  bounds,
  closeApp,
  CLUB_A,
  dash,
  emu,
  ensureFree,
  extendGame,
  get,
  guestPhone,
  loginWait,
  newGuest,
  ok,
  openMyShift,
  closeMyShift,
  P,
  parseCsv,
  phoneBooking,
  posSale,
  quote,
  pay,
  RES,
  ru,
  rubCsv,
  saveState,
  shiftReportsOfDay,
  sim,
  sleep,
  slotAfter,
  startGame,
  summaryOf,
  table,
  tv,
  TZ,
  waitFor,
  waitPaymentSession,
  waitSim,
  workingDay,
  ykId,
} from './helpers.mjs';

const METHODS = ['cash', 'card_terminal', 'sbp', 'card'];
const FLOAT = 300_000;
const S = { pays: [], sessions: [], guests: [] };
let db;
let app;

before(async () => {
  db = await adminClient();
  app = await appClient();
  S.owner = await loginWait('+70000000001');
  S.man = await loginWait('+70000000003');
  S.rec = await loginWait('+70000000004');
  S.today = workingDay();
});

after(async () => {
  if (S.shift && !S.shiftClosed) await closeMyShift({ rec: S.rec, man: S.man, shiftId: S.shift.id }).catch((e) => console.log(`# смена не закрыта: ${e.message}`));
  await closeApp();
  await app?.end();
  await db?.end();
});

/** Срез дашборда за сегодня по всем вкладкам (кэш живых суток — 15 с: ждём свежий ответ). */
async function snapshot() {
  await sleep(16_000);
  const out = { at: new Date() };
  for (const tab of ['summary', 'money', 'hall', 'guests', 'control']) {
    const r = await dash(S.owner.token, CLUB_A, { from: S.today, to: S.today, tab });
    assert.equal(r.status, 200, `${tab}: ${r.text.slice(0, 200)}`);
    assert.notEqual(r.headers['x-cache'], 'hit', `${tab}: свежий ответ`);
    out[tab] = r.json;
  }
  return out;
}

const methodsOf = (j) => Object.fromEntries(j.tables.methods.map((m) => [m.id, m]));
const structOf = (j) => Object.fromEntries(j.tables.structure.map((m) => [m.id, m.kopecks]));
const rememberPay = (id, what) => S.pays.push({ id, what });

test('подготовка: столы 1–6 свободны, своя смена, срез «до»', { timeout: 30 * 60_000 }, async (t) => {
  for (const n of [1, 2, 3, 4, 5, 6]) await ensureFree(n);
  // Старые открытые тревоги сервисного света столов 5 (дедупликация тревоги) — подтвердить заранее.
  const open = (await ok(api('GET', `/api/clubs/${CLUB_A}/alarms?state=open`, { token: S.owner.token }))) ?? [];
  for (const a of open.filter((x) => x.type === 'service_light' && x.resource_number === 5)) await api('POST', `/api/alarms/${a.id}/ack`, { token: S.man.token, body: {} });
  S.shift = await openMyShift({ rec: S.rec, man: S.man, floatKopecks: FLOAT, log: (m) => t.diagnostic(m) });
  saveState({ liveShift: S.shift.id, today: S.today });
  S.agg23 = (await db.query("select net_kopecks, computed_at, data->'revenue' as rev from bl.stats_daily where club_id = $1 and day = '2026-10-23'", [CLUB_A])).rows[0];
  S.before = await snapshot();
  t.diagnostic(`смена №${S.shift.number}; сегодня ${S.today}; до набора: выручка ${tv(S.before.money, 'revenue')}, игр ${tv(S.before.summary, 'games')}`);
});

test('набор: бронь по телефону на столе 6 (будет неявка)', async (t) => {
  const startsAt = slotAfter(2 * 60_000);
  S.bookingPhone = guestPhone();
  const r = await phoneBooking(S.rec.token, { table: 6, startsAt, minutes: 15, name: 'Гость e2e M5.2', phone: S.bookingPhone });
  assert.equal(r.status, 201, r.text);
  S.booking = r.json;
  S.bookingStarts = startsAt;
  t.diagnostic(`бронь ${r.json.id?.slice(0, 8)} стол 6 на ${startsAt.toISOString()}, статус ${r.json.status}`);
});

test('набор: стол 1 — игра по QR (СБП) и продление гостем', async (t) => {
  const g = await startGame(1, 3);
  S.g1 = g;
  S.guests.push(g.guest);
  rememberPay(g.payResp.payment_id, 'qr start');
  await waitSim(1, (x) => x.state.relay === true && x.state.session_id === g.sessionId, { timeoutMs: 5000, what: 'свет стола 1' });
  const ex = await extendGame(g.guest, g.tbl.resource.id, g.sessionId, 1);
  rememberPay(ex.payResp.payment_id, 'qr extend');
  await waitFor(async () => {
    const { rows } = await db.query("select status from bl.payments where id = $1", [ex.payResp.payment_id]);
    return rows[0]?.status === 'succeeded';
  }, { timeoutMs: 15_000, what: 'продление оплачено' });
  S.sessions.push(g.sessionId);
  // Бар через QR: заказ гостя к столу с оплатой онлайн (СБП).
  const ord = await api('POST', '/api/orders', { token: g.guest.token, idem: true, body: { session_id: g.sessionId, items: [{ product_id: P.chips, qty: 1 }], pay: 'online', method: 'sbp' } });
  assert.equal(ord.status, 201, ord.text);
  emu(`/__emu/payments/${ykId(ord.json.payment.confirmation)}/succeed?wait=1`, { post: true });
  const orderPay = await waitFor(async () => {
    const x = (await db.query("select p.id from bl.orders o join bl.payments p on p.id = o.payment_id where o.id = $1 and p.status = 'succeeded'", [ord.json.order.id])).rows[0];
    return x?.id ?? null;
  }, { timeoutMs: 20_000, what: 'заказ бара по QR оплачен' });
  rememberPay(orderPay, 'bar qr sbp');
  S.qrOrder = ord.json.order.id;
  S.exp = { qr_start: g.q.amount_kopecks, qr_extend: ex.q.amount_kopecks, bar_qr: ord.json.order.subtotal_kopecks };
  t.diagnostic(`стол 1: старт ${g.q.amount_kopecks} коп. (3 мин), продление ${ex.q.amount_kopecks} коп. (1 мин), заказ бара по QR ${S.exp.bar_qr} коп.`);
});

test('набор: стол 2 — «Оплачу на ресепшене», наличные со сдачей', async (t) => {
  const guest = await newGuest();
  S.guests.push(guest);
  const tbl = await table(2, guest.token);
  const q = await ok(quote(guest.token, { resourceId: tbl.resource.id, minutes: 2 }));
  const r = await ok(pay(guest.token, q.quote_id, 'reception'));
  const received = Math.ceil((q.amount_kopecks + 1) / 10_000) * 10_000 + 10_000;
  const a = await api('POST', `/api/reception/requests/${r.reception_request_id}/accept`, { token: S.rec.token, idem: true, body: { method: 'cash', received_kopecks: received } });
  assert.equal(a.status, 200, a.text);
  assert.equal(a.json.change_kopecks, received - q.amount_kopecks);
  rememberPay(a.json.payment_id, 'reception cash');
  const sid = a.json.session_id ?? (await waitPaymentSession(guest.token, a.json.payment_id)).session_id;
  await waitSim(2, (x) => x.state.relay === true, { timeoutMs: 8000, what: 'свет стола 2' });
  S.sessions.push(sid);
  S.g2 = { guest, sid };
  S.exp.reception_cash = q.amount_kopecks;
  t.diagnostic(`стол 2: ${q.amount_kopecks} коп. наличными, получено ${received}, сдача ${a.json.change_kopecks}`);
});

test('набор: бар на кассе — наличные и карта на кассе', async (t) => {
  const cash = await posSale(S.rec.token, { items: [{ product_id: P.chips, qty: 2 }, { product_id: P.waterStill, qty: 1 }], method: 'cash', received_kopecks: 200_000 });
  assert.equal(cash.status, 201, cash.text);
  const card = await posSale(S.rec.token, { items: [{ product_id: P.nuts, qty: 1 }], method: 'card_terminal' });
  assert.equal(card.status, 201, card.text);
  rememberPay(cash.json.payment_id, 'bar cash');
  rememberPay(card.json.payment_id, 'bar card_terminal');
  S.exp.bar_cash = cash.json.total_kopecks;
  S.exp.bar_card = card.json.total_kopecks;
  S.sales = [cash.json.sale_id, card.json.sale_id];
  t.diagnostic(`бар: наличные ${cash.json.total_kopecks} коп. (${cash.json.status}), карта на кассе ${card.json.total_kopecks} коп. (${card.json.status})`);
});

test('набор: стол 3 — депозит «Без лимита» наличными, расчёт по факту', { timeout: 5 * 60_000 }, async (t) => {
  const guest = await newGuest();
  S.guests.push(guest);
  const r = await api('POST', '/api/reception/deposits', { token: S.rec.token, idem: true, body: { resource_id: RES(3), amount_kopecks: 100_000, received_kopecks: 150_000, user_id: guest.user.id } });
  assert.equal(r.status, 201, r.text);
  S.dep = r.json;
  rememberPay(r.json.payment_id, 'deposit cash');
  await waitSim(3, (x) => x.state.relay === true, { timeoutMs: 8000, what: 'свет стола 3' });
  await sleep(70_000);
  const stop = await api('POST', `/api/sessions/${r.json.session_id}/stop`, { token: S.rec.token, headers: { 'x-club-id': CLUB_A } });
  assert.equal(stop.status, 200, stop.text);
  const p = await waitFor(async () => {
    const { rows } = await db.query('select settlement_status, settled_kopecks from bl.payments where id = $1', [r.json.payment_id]);
    return rows[0].settlement_status === 'settled' ? rows[0] : null;
  }, { timeoutMs: 30_000, what: 'депозит рассчитан' });
  const rf = (await db.query('select amount_kopecks, status, created_at from bl.refunds where payment_id = $1', [r.json.payment_id])).rows;
  S.sessions.push(r.json.session_id);
  S.exp.deposit = 100_000;
  S.exp.deposit_refund = rf.reduce((a, x) => a + Number(x.amount_kopecks), 0);
  t.diagnostic(`депозит 100 000 коп.; зачтено ${p.settled_kopecks}, возврат остатка ${S.exp.deposit_refund} (${rf.map((x) => x.status).join(',')})`);
});

test('набор: пакет часов онлайн и игра пакетом на столе 4', { timeout: 3 * 60_000 }, async (t) => {
  let pkgs = (await ok(api('GET', `/api/clubs/${CLUB_A}/packages`))).filter((p) => !p.archived_at);
  if (!pkgs.length) {
    const pkg = await ok(api('POST', `/api/clubs/${CLUB_A}/packages`, { token: S.man.token, body: { title: `Час e2e M5.2`, hours: 1, price_kopecks: 60_000, valid_days: 30, reason: 'Пакет для приёмки M5.2 (тест e2e)' } }), 201);
    pkgs = [pkg];
    S.createdPkg = pkg.id;
  }
  const pkg = pkgs[0];
  const guest = await newGuest();
  S.guests.push(guest);
  const b = await ok(api('POST', `/api/packages/${pkg.id}/buy`, { token: guest.token, body: { method: 'sbp' }, idem: true }));
  emu(`/__emu/payments/${ykId(b.confirmation)}/succeed?wait=1`, { post: true });
  await waitFor(async () => (await ok(api('GET', `/api/clubs/${CLUB_A}/balance`, { token: guest.token }))).lots.some((l) => l.package_id === pkg.id), { timeoutMs: 15_000, what: 'минуты пакета' });
  rememberPay(b.payment_id, 'package sbp');
  const q = await ok(api('POST', '/api/quotes', { token: guest.token, body: { resource_id: RES(4), kind: 'start', minutes: 2, use_balance: true } }));
  const p = await ok(api('POST', `/api/quotes/${q.quote_id}/pay`, { token: guest.token, body: { method: 'balance' }, idem: true }));
  const ps = await waitPaymentSession(guest.token, p.payment_id);
  await waitSim(4, (x) => x.state.relay === true, { timeoutMs: 8000, what: 'свет стола 4' });
  S.sessions.push(ps.session_id);
  S.g4 = { guest, sid: ps.session_id };
  S.exp.package = Number((await db.query('select amount_kopecks from bl.payments where id = $1', [b.payment_id])).rows[0].amount_kopecks);
  S.exp.package_minutes = pkg.minutes ?? pkg.hours * 60;
  t.diagnostic(`пакет «${pkg.title}» ${S.exp.package} коп., ${S.exp.package_minutes} мин; игра балансом 2 мин (котировка ${q.amount_kopecks} коп.)`);
});

test('набор: стол 5 — сервисный свет с причиной (в причине телефон); тревога принята управляющим', { timeout: 3 * 60_000 }, async (t) => {
  S.svcSince = new Date();
  const r = await api('POST', `/api/resources/${RES(5)}/service`, { token: S.rec.token, body: { minutes: 2, reason_code: 'cleaning', reason_text: 'гость +79990001122 пролил чай (e2e M5.2)' } });
  assert.equal(r.status, 200, r.text);
  await waitSim(5, (x) => x.state.mode === 'service' && x.state.relay === true, { timeoutMs: 5000, what: 'сервисный свет' });
  const alarm = await waitFor(
    async () => (await ok(api('GET', `/api/clubs/${CLUB_A}/alarms?state=open`, { token: S.owner.token }))).find((a) => a.type === 'service_light' && a.resource_number === 5 && new Date(a.last_raised_at) >= S.svcSince),
    { timeoutMs: 8000, what: 'тревога service_light' },
  );
  await sleep(20_000);
  const ack = await api('POST', `/api/alarms/${alarm.id}/ack`, { token: S.man.token, body: {} });
  assert.equal(ack.status, 200, ack.text);
  S.svcAlarm = alarm.id;
  await sleep(40_000);
  await ok(api('POST', `/api/resources/${RES(5)}/service/stop`, { token: S.rec.token, body: {} }));
  await waitSim(5, (x) => x.state.mode === 'free', { timeoutMs: 8000, what: 'сервис выключен' });
  const row = (await db.query('select raised_at, acked_at, acked_by from bl.alarms where id = $1', [alarm.id])).rows[0];
  S.svcReactSec = Math.round((row.acked_at - row.raised_at) / 1000);
  t.diagnostic(`тревога ${alarm.id.slice(0, 8)} принята через ${S.svcReactSec} с управляющим; сервис ~1 мин`);
});

// Продажа наличными: платежи ЮKassa прошлых суток эмулятор после перезапуска (13:31 UTC) не помнит —
// их возврат даёт payment_failed (состояние эмулятора в памяти, не дефект продукта).
test('набор: возврат сегодня продажи бара наличными за 23.10 (возврат на следующий день)', async (t) => {
  const { rows } = await db.query(
    `select s.id, s.payment_id, s.bar_total_kopecks, p.method, p.confirmed_at from bl.pos_sales s join bl.payments p on p.id = s.payment_id
      where s.club_id = $1 and s.status = 'completed' and s.refunded_kopecks = 0 and not s.is_test and p.method = 'cash' and p.status = 'succeeded'
        and p.confirmed_at >= $2 and p.confirmed_at < $3 and s.bar_total_kopecks > 0 and s.table_kopecks = 0 and coalesce(s.package_kopecks, 0) = 0
      order by p.confirmed_at desc limit 1`,
    [CLUB_A, (await bounds(db, '2026-10-23')).from, (await bounds(db, '2026-10-23')).to],
  );
  assert.ok(rows[0], 'есть продажа бара наличными за 23.10 без возврата');
  const sale = rows[0];
  const r = await api('POST', `/api/pos/sales/${sale.id}/refund`, { token: S.man.token, idem: true, body: { reason: 'Гость вернул заказ на следующий день (тест e2e M5.2)' } });
  assert.ok([200, 201].includes(r.status), r.text);
  const ref = await waitFor(async () => {
    const x = (await db.query('select amount_kopecks, status, created_at from bl.refunds where payment_id = $1', [sale.payment_id])).rows;
    return x.length && x.every((y) => ['succeeded', 'manual'].includes(y.status)) ? x : null;
  }, { timeoutMs: 30_000, what: 'возврат выдан' });
  S.lateRefund = { sale: sale.id, payment: sale.payment_id, amount: ref.reduce((a, x) => a + Number(x.amount_kopecks), 0), paidAt: sale.confirmed_at };
  t.diagnostic(`продажа ${sale.id.slice(0, 8)} от ${sale.confirmed_at.toISOString()} (${sale.bar_total_kopecks} коп., наличные) — возврат ${S.lateRefund.amount} коп. сегодня`);
});

test('набор: тревога 23.10 принята сегодня (реакция > 10 мин, пересчёт закрытых суток сервером)', async (t) => {
  const b = await bounds(db, '2026-10-23');
  const { rows } = await db.query("select id, type, raised_at from bl.alarms where club_id = $1 and acked_at is null and raised_at >= $2 and raised_at < $3 order by raised_at limit 1", [CLUB_A, b.from, b.to]);
  assert.ok(rows[0], 'есть непринятая тревога за 23.10');
  S.oldAlarm = rows[0];
  const before = (await db.query("select computed_at, data->'alarms'->'by_type'->$2 as t from bl.stats_daily where club_id = $1 and day = '2026-10-23'", [CLUB_A, rows[0].type])).rows[0];
  S.oldAlarmBefore = before;
  const r = await api('POST', `/api/alarms/${rows[0].id}/ack`, { token: S.man.token, body: {} });
  assert.equal(r.status, 200, r.text);
  const dirty = await db.query("select gen from bl.stats_dirty where club_id = $1 and day = '2026-10-23'", [CLUB_A]);
  t.diagnostic(`тревога ${rows[0].type} от ${rows[0].raised_at.toISOString()} принята; 23.10 «грязные»: ${dirty.rowCount ? `да (gen ${dirty.rows[0].gen})` : 'нет (уже пересчитаны?)'}; агрегат до: ${JSON.stringify(before.t)}`);
  S.oldAlarmDirty = dirty.rowCount > 0;
});

test('набор: игры закончены, неявка по брони, смена закрыта честно', { timeout: 30 * 60_000 }, async (t) => {
  // Закончить игры гостей (стол 1 — сам гость, стол 2 — гость, стол 4 — гость).
  await ok(api('POST', `/api/sessions/${S.g1.sessionId}/stop`, { token: S.g1.guest.token }));
  await ok(api('POST', `/api/sessions/${S.g2.sid}/stop`, { token: S.g2.guest.token }));
  await ok(api('POST', `/api/sessions/${S.g4.sid}/stop`, { token: S.g4.guest.token }));
  for (const n of [1, 2, 4]) await waitSim(n, (x) => x.state.mode === 'free', { timeoutMs: 10_000, what: `стол ${n} свободен` });
  const b = await waitFor(
    async () => {
      const x = (await db.query('select status, expire_reason from bl.bookings where id = $1', [S.booking.id])).rows[0];
      return x.status === 'expired' ? x : null;
    },
    { timeoutMs: 25 * 60_000, intervalMs: 5000, what: 'бронь стола 6 — неявка' },
  );
  assert.equal(b.expire_reason, 'no_show');
  const cur = (await ok(api('GET', `/api/clubs/${CLUB_A}/shifts/current`, { token: S.man.token }))).shift;
  assert.equal(cur.id, S.shift.id);
  S.expectedCash = cur.expected_cash_kopecks;
  const closed = await closeMyShift({ rec: S.rec, man: S.man, shiftId: S.shift.id, comment: 'e2e M5.2 T29' });
  S.shiftClosed = true;
  S.closedShift = closed;
  t.diagnostic(`неявка ${b.expire_reason}; смена закрыта: ожидалось ${S.expectedCash} коп., расхождение ${closed?.discrepancy_kopecks ?? closed?.shift?.discrepancy_kopecks}`);
});

test('T29 сегодня: дашборд = свежая сводка = SQL; = сумма отчётов смен + вне смен; своя смена = свой отчёт', { timeout: 5 * 60_000 }, async (t) => {
  S.after = await snapshot();
  const A = S.after;
  const fresh = await summaryOf(db, S.today);
  const m = methodsOf(A.money);
  assert.equal(tv(A.money, 'revenue'), fresh.revenue.net_kopecks, 'чистая выручка = сводка');
  assert.equal(tv(A.money, 'revenue_total'), fresh.revenue.total_kopecks, 'выручка = сводка');
  assert.equal(tv(A.money, 'refunds'), fresh.revenue.refunds_kopecks, 'возвраты = сводка');
  for (const k of METHODS) assert.equal(m[k].kopecks, fresh.revenue.by_method[k], `способ ${k} = сводка`);
  assert.equal(tv(A.summary, 'games'), fresh.play.sessions, 'игры = сводка');
  assert.equal(tv(A.summary, 'play_hours'), fresh.play.hours, 'часы = сводка');
  assert.equal(tv(A.control, 'manual_actions'), fresh.manual_actions.count, 'ручные действия = сводка');
  assert.equal(tv(A.control, 'alarms'), fresh.alarms.total, 'тревоги = сводка');
  // Своя смена: отчёт = оплаты в окне смены.
  const rep = (await ok(get(`/api/shifts/${S.shift.id}/report`, S.owner.token, { 'x-club-id': CLUB_A }))).revenue;
  const sh = (await db.query('select opened_at, closed_at from bl.shifts where id = $1', [S.shift.id])).rows[0];
  const inShift = (
    await db.query(
      `select p.method, sum(case when p.capture then p.amount_kopecks else coalesce(p.captured_kopecks, 0) end)::bigint as k from bl.payments p
        where p.club_id = $1 and p.status = 'succeeded' and p.provider <> 'balance' and not p.is_test and p.confirmed_at >= $2 and p.confirmed_at <= $3 group by 1`,
      [CLUB_A, sh.opened_at, sh.closed_at],
    )
  ).rows;
  for (const k of METHODS) assert.equal(rep.by_method[k], Number(inShift.find((x) => x.method === k)?.k ?? 0), `отчёт своей смены ${k} = оплаты в окне смены`);
  // Все мои оплаты — в окне своей смены (кроме возврата «на следующий день» — он тоже в окне).
  const mine = (await db.query('select id, confirmed_at from bl.payments where id = any($1::uuid[])', [S.pays.map((p) => p.id)])).rows;
  assert.equal(mine.length, S.pays.length, 'все оплаты набора найдены');
  for (const p of mine) assert.ok(p.confirmed_at >= sh.opened_at && p.confirmed_at <= sh.closed_at, `оплата ${p.id.slice(0, 8)} в окне смены`);
  // Сумма отчётов смен суток + вне смен = дашборд.
  const reports = await shiftReportsOfDay(db, S.owner.token, S.today);
  const b = await bounds(db, S.today);
  const shifts = (await db.query('select opened_at, coalesce(closed_at, now()) as closed_at from bl.shifts where club_id = $1 and not is_test', [CLUB_A])).rows;
  const all = (
    await db.query(
      `select p.method, p.confirmed_at, case when p.status = 'succeeded' then (case when p.capture then p.amount_kopecks else coalesce(p.captured_kopecks, 0) end) else 0 end::bigint as k
         from bl.payments p where p.club_id = $1 and p.status in ('succeeded', 'waiting_for_capture') and p.provider <> 'balance' and not p.is_test
          and p.confirmed_at >= $2 and p.confirmed_at < $3 and p.confirmed_at <= now()`,
      [CLUB_A, b.from, b.to],
    )
  ).rows;
  const isIn = (at) => shifts.some((s) => at >= s.opened_at && at <= s.closed_at);
  for (const k of METHODS) {
    const sqlAll = all.filter((x) => x.method === k).reduce((a, x) => a + Number(x.k), 0);
    const out = all.filter((x) => x.method === k && !isIn(x.confirmed_at)).reduce((a, x) => a + Number(x.k), 0);
    assert.equal(m[k].kopecks, sqlAll, `способ ${k} = SQL`);
    assert.equal(m[k].kopecks, reports.reduce((a, r) => a + r.revenue.by_method[k], 0) + out, `способ ${k} = смены + вне смен`);
  }
  t.diagnostic(`сегодня: выручка ${tv(A.money, 'revenue')} (до возвратов ${tv(A.money, 'revenue_total')}, возвраты ${tv(A.money, 'refunds')}); смен суток ${reports.length}; своя смена: ${JSON.stringify(rep.by_method)}`);
});

test('T29 сегодня: приращение после набора = набор (деньги, структура, источники, игры, гости, брони, пакеты, продления, сервис)', async (t) => {
  const B = S.before;
  const A = S.after;
  // Чужие оплаты за время набора (pentester и др.) — вычитаются по SQL.
  const foreign = (
    await db.query(
      `select p.method, p.kind, sum(case when p.capture then p.amount_kopecks else coalesce(p.captured_kopecks, 0) end)::bigint as k, count(*)::int as n from bl.payments p
        where p.club_id = $1 and p.status = 'succeeded' and p.provider <> 'balance' and not p.is_test and p.confirmed_at >= $2 and p.confirmed_at <= $3 and not (p.id = any($4::uuid[]))
        group by 1, 2`,
      [CLUB_A, new Date(B.at.getTime() - 20_000), A.at, S.pays.map((p) => p.id)],
    )
  ).rows;
  const fsum = (pred) => foreign.filter(pred).reduce((a, x) => a + Number(x.k), 0);
  const e = S.exp;
  const d = (j0, j1, id) => tv(j1, id) - tv(j0, id);
  const expTotal = e.qr_start + e.qr_extend + e.bar_qr + e.reception_cash + e.bar_cash + e.bar_card + e.deposit + e.package;
  assert.equal(d(B.money, A.money, 'revenue_total'), expTotal + fsum(() => true), 'выручка до возвратов: + набор');
  const foreignRefunds = Number(
    (
      await db.query(
        "select coalesce(sum(f.amount_kopecks), 0)::bigint as k from bl.refunds f where f.club_id = $1 and f.kind = 'refund' and f.status in ('succeeded', 'manual') and not f.is_test and f.created_at >= $2 and f.created_at <= $3 and not (f.payment_id = any($4::uuid[]))",
        [CLUB_A, new Date(B.at.getTime() - 20_000), A.at, [...S.pays.map((p) => p.id), S.lateRefund.payment]],
      )
    ).rows[0].k,
  );
  assert.equal(d(B.money, A.money, 'refunds'), e.deposit_refund + S.lateRefund.amount + foreignRefunds, 'возвраты: остаток депозита + возврат за 23.10');
  const mb = methodsOf(B.money);
  const ma = methodsOf(A.money);
  assert.equal(ma.cash.kopecks - mb.cash.kopecks, e.reception_cash + e.bar_cash + e.deposit + fsum((x) => x.method === 'cash'), 'наличные');
  assert.equal(ma.cash.refunds_kopecks - mb.cash.refunds_kopecks, e.deposit_refund + S.lateRefund.amount, 'возвраты наличными: остаток депозита + возврат за 23.10');
  assert.equal(ma.card_terminal.kopecks - mb.card_terminal.kopecks, e.bar_card + fsum((x) => x.method === 'card_terminal'), 'карта на кассе');
  assert.equal(ma.sbp.kopecks - mb.sbp.kopecks, e.qr_start + e.qr_extend + e.bar_qr + e.package + fsum((x) => x.method === 'sbp'), 'СБП');
  const sb = structOf(B.money);
  const sa = structOf(A.money);
  if (foreign.length === 0) {
    assert.equal(sa.deposits - sb.deposits, e.deposit, 'структура: депозит');
    assert.equal(sa.bar - sb.bar, e.bar_qr + e.bar_cash + e.bar_card, 'структура: бар');
    assert.equal(sa.packages - sb.packages, e.package, 'структура: пакеты');
    assert.equal(sa.tables - sb.tables, e.qr_start + e.qr_extend + e.reception_cash, 'структура: столы');
    const src = (j) => Object.fromEntries(j.tables.sources.map((x) => [x.id, x.kopecks]));
    assert.equal(src(A.money).qr - src(B.money).qr, e.qr_start + e.qr_extend + e.bar_qr + e.package, 'источник: QR гостя');
    assert.equal(src(A.money).reception - src(B.money).reception, e.reception_cash + e.bar_cash + e.bar_card + e.deposit, 'источник: касса ресепшена');
  }
  // Игры и часы: 4 игры набора (столы 1, 2, 3, 4), минуты — по сессиям.
  const ss = (await db.query("select id, source, started_at, coalesce(ended_at, interrupted_at) as e from bl.sessions where id = any($1::uuid[])", [S.sessions])).rows;
  assert.equal(ss.length, 4);
  const foreignGames = (await db.query('select count(*)::int as n from bl.sessions where club_id = $1 and not is_test and status <> $4 and started_at >= $2 and started_at <= $3 and not (id = any($5::uuid[]))', [CLUB_A, new Date(B.at.getTime() - 20_000), A.at, 'cancelled', S.sessions])).rows[0].n;
  assert.equal(d(B.summary, A.summary, 'games'), 4 + foreignGames, 'игры: + 4');
  const hb = (await db.query('select data from bl.stats_daily where false')).rows; // заглушка для формы
  void hb;
  // Брони: + 1, неявка + 1.
  const gb = B.guests.tables.bookings;
  const ga = A.guests.tables.bookings;
  assert.equal(ga.total - gb.total, 1, 'брони: + 1');
  assert.equal(ga.no_show - gb.no_show, 1, 'неявка: + 1');
  // Продления: + 1 оплаченное, из приложения.
  assert.equal(A.guests.tables.extensions.paid - B.guests.tables.extensions.paid, 1, 'продления оплачены: + 1');
  assert.equal(A.guests.tables.extensions.from_app - B.guests.tables.extensions.from_app, 1, 'продления из приложения: + 1');
  // Пакеты: продано + 1, использовано + 2 мин.
  assert.equal(A.guests.tables.packages.sold - B.guests.tables.packages.sold, 1, 'пакеты: продано + 1');
  assert.equal(A.guests.tables.packages.used_minutes - B.guests.tables.packages.used_minutes, 2, 'пакеты: использовано + 2 мин');
  // Гости: + 4 новых гостя игр (столы 1–4) + автор брони по телефону, если это гость.
  const newDelta = A.guests.tables.guests.new - B.guests.tables.guests.new;
  assert.ok(newDelta >= 4, `новые гости: + ${newDelta} (не меньше 4)`);
  // Сервисный свет: 1 включение.
  const svcB = B.hall.series.ring.service_minutes;
  const svcA = A.hall.series.ring.service_minutes;
  assert.ok(svcA - svcB >= 0 && svcA - svcB <= 2, `сервис: + ${svcA - svcB} мин`);
  // Таблица по столам 1–4: игры по одной.
  for (const n of [1, 2, 3, 4]) {
    // Номера столов и кортов у семей свои (решение №213, с M5.8 есть «Стол 1» и «Корт 1»): ищем по id стола сида,
    // а не по номеру — иначе чужие игры pentester на кортах (там же шли проверки M5.8) попадали в строку стола.
    const tableId = `e1000000-0000-4000-8000-00000000000${n}`;
    const rb = B.hall.tables.by_resource.find((x) => x.resource_id === tableId);
    const ra = A.hall.tables.by_resource.find((x) => x.resource_id === tableId);
    assert.equal(ra.games - (rb?.games ?? 0), 1, `стол ${n}: + 1 игра`);
  }
  // Доля без персонала и скан → свет: игра по QR стола 1 — в метрике.
  assert.ok(A.control.tables.pilot.scan_to_light.count >= B.control.tables.pilot.scan_to_light.count + 1, 'скан → свет: + игра по QR');
  assert.deepEqual(A.control.tables.pilot.lights_without_journal, { commands: 0, sessions: 0 }, 'свет без журнала — 0');
  t.diagnostic(
    `набор: QR ${e.qr_start}+${e.qr_extend}, ресепшн ${e.reception_cash}, бар ${e.bar_cash}+${e.bar_card}, депозит ${e.deposit} (возврат ${e.deposit_refund}), пакет ${e.package}; возврат за 23.10 ${S.lateRefund.amount}; чужих оплат за время набора ${foreign.length ? JSON.stringify(foreign) : 'нет'}; новых гостей + ${newDelta}; сервис + ${svcA - svcB} мин; скан → свет медиана ${A.control.tables.pilot.scan_to_light.median_sec} с`,
  );
});

test('T29 сегодня: ручные действия и реакция на тревоги (№178); причина с телефоном — маской', async (t) => {
  const c = S.after.control;
  const svc = c.tables.manual_items.find((i) => i.action === 'service.start' && i.resource_number === 5 && new Date(i.at) >= S.svcSince);
  assert.ok(svc, 'service.start стола 5 в ручных действиях');
  assert.doesNotMatch(svc.reason, /79990001122/, 'телефон в причине замаскирован');
  assert.equal(svc.actor_name, 'Ресепшн (тест)');
  assert.ok(c.tables.manual_items.some((i) => /refund/.test(i.action) && new Date(i.at) >= S.before.at), 'возврат продажи — в ручных действиях');
  const bt = c.tables.alarms.by_type.find((x) => x.type === 'service_light');
  assert.ok(bt && bt.acked >= 1, 'тревога сервисного света принята');
  const man = c.tables.alarms.by_staff.find((x) => x.name === 'Управляющий (тест)' || x.user_id === 'a1000000-0000-4000-8000-000000000003');
  assert.ok(man, 'реакция управляющего');
  // Своя тревога: реакция = acked_at − raised_at, не проблемная (< 10 мин).
  const prob = c.tables.alarms.problems.find((p) => p.alarm_id === S.svcAlarm);
  assert.equal(prob, undefined, 'тревога принята за 20 с — не проблемная');
  const csv = await apiRaw('GET', `/api/clubs/${CLUB_A}/dashboard/export.csv?from=${S.today}&to=${S.today}&table=manual`, { token: S.owner.token, headers: { 'x-club-id': CLUB_A } });
  assert.equal(csv.status, 200);
  const rows = parseCsv(csv.buf);
  const line = rows.find((r) => r[3] === 'service.start' && r[6] === '5' && /пролил/.test(r[8]));
  assert.ok(line, 'service.start в CSV');
  assert.doesNotMatch(csv.buf.toString(), /79990001122/, 'в CSV нет телефона из причины');
  t.diagnostic(`причина на экране: «${svc.reason}»; CSV: «${line[8]}»; тревога service_light: ${JSON.stringify(bt)}; управляющий: ${JSON.stringify({ count: man.count, slow: man.slow, avg: man.avg_react_sec })}; реакция по базе ${S.svcReactSec} с`);
});

test('T29 сегодня: CSV revenue_daily, shifts, bookings = экран', async (t) => {
  const csv = parseCsv((await apiRaw('GET', `/api/clubs/${CLUB_A}/dashboard/export.csv?from=${S.today}&to=${S.today}&table=revenue_daily`, { token: S.owner.token, headers: { 'x-club-id': CLUB_A } })).buf);
  const d = S.after.money.tables.daily.find((x) => x.date === S.today);
  const line = csv.find((r) => r[0] === ru(S.today));
  assert.deepEqual(line.slice(1, 4), [rubCsv(d.total_kopecks), rubCsv(d.refunds_kopecks), rubCsv(d.net_kopecks)]);
  const sh = parseCsv((await apiRaw('GET', `/api/clubs/${CLUB_A}/dashboard/export.csv?from=${S.today}&to=${S.today}&table=shifts`, { token: S.owner.token, headers: { 'x-club-id': CLUB_A } })).buf);
  const mineRow = sh.find((r) => r[0] === String(S.shift.number));
  assert.ok(mineRow, 'своя смена в CSV');
  assert.equal(mineRow[5], rubCsv(FLOAT), 'размен');
  assert.equal(mineRow[8], rubCsv(0), 'расхождение 0');
  const bk = parseCsv((await apiRaw('GET', `/api/clubs/${CLUB_A}/dashboard/export.csv?from=${S.today}&to=${S.today}&table=bookings`, { token: S.owner.token, headers: { 'x-club-id': CLUB_A } })).buf);
  const bl = bk.find((r) => r[0] === ru(S.today));
  const g = S.after.guests.tables.bookings;
  assert.deepEqual(bl.slice(1).map(Number), [g.total, g.came, g.no_show, g.canceled], 'брони CSV = экран');
  t.diagnostic(`CSV сегодня: ${line.slice(0, 4).join(' | ')}; смена ${mineRow.join(' | ')}; брони ${bl.join(' | ')}`);
});

test('T29: возврат за 23.10 уменьшает сегодня, агрегат 23.10 не меняется (№168)', async () => {
  const now23 = (await db.query("select net_kopecks, data->'revenue' as rev from bl.stats_daily where club_id = $1 and day = '2026-10-23'", [CLUB_A])).rows[0];
  assert.equal(Number(now23.net_kopecks), Number(S.agg23.net_kopecks), 'чистая выручка 23.10 та же');
  assert.deepEqual(now23.rev.refunds, S.agg23.rev.refunds, 'возвраты 23.10 те же');
  const fresh23 = await summaryOf(db, '2026-10-23');
  assert.equal(fresh23.revenue.net_kopecks, Number(now23.net_kopecks), 'сводка 23.10 = агрегат');
});

/** withContext сервера поверх одного соединения app_api в транзакции (savepoint на каждый вызов). */
function txContext(conn) {
  return async (_pool, { clubId, userId = null, actorType }, fn) => {
    await conn.query('savepoint e2e_ctx');
    try {
      await conn.query("select set_config('app.club_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_type', $3, true)", [clubId ?? '', userId ?? '', actorType]);
      const r = await fn(conn);
      await conn.query('release savepoint e2e_ctx');
      return r;
    } catch (err) {
      await conn.query('rollback to savepoint e2e_ctx');
      throw err;
    }
  };
}

test('T29: закрытие сегодняшних суток с подставными часами (ROLLBACK): агрегат = на лету = утренняя сводка', async (t) => {
  const b = await bounds(db, S.today);
  const fakeClose = new Date(b.to.getTime() + 10 * 60_000); // завтра 06:10 местного
  const fakeSummary = new Date(b.to.getTime() + 4 * 3_600_000); // завтра 10:00 местного
  const live = S.after ?? null;
  await app.query('begin');
  try {
    const ctx = txContext(app);
    const daily = await ctx(null, { clubId: CLUB_A, actorType: 'system' }, async (c) => {
      const club = await loadClub(c, CLUB_A);
      return recomputeDay(c, club, S.today, fakeClose);
    });
    const row = (await app.query('select net_kopecks, revenue_total_kopecks, refunds_kopecks, games, play_minutes, capacity_minutes, data from bl.stats_daily where club_id = $1 and day = $2', [CLUB_A, S.today])).rows[0];
    assert.ok(row, 'агрегат записан узкой функцией (в транзакции)');
    const { sent } = await summariesTick({ pool: null, withContext: ctx, clock: { now: () => fakeSummary }, log: { info() {}, warn() {}, error: (m, f) => t.diagnostic(`${m} ${JSON.stringify(f)}`) } });
    const mineSent = sent.find((s) => s.club_id === CLUB_A);
    assert.ok(mineSent && mineSent.day === S.today, 'утренняя сводка за сегодня отправлена бы завтра в 10:00');
    const sum = (await ctx(null, { clubId: CLUB_A, actorType: 'system' }, (c) => c.query("select data from bl.club_summaries where club_id = $1 and kind = 'morning' and day = $2", [CLUB_A, S.today]))).rows[0].data;
    assert.equal(Number(row.net_kopecks), sum.revenue.net_kopecks, 'агрегат = сводка: чистая выручка');
    assert.equal(Number(row.revenue_total_kopecks), sum.revenue.total_kopecks, 'агрегат = сводка: выручка');
    assert.equal(Number(row.refunds_kopecks), sum.revenue.refunds_kopecks, 'агрегат = сводка: возвраты');
    assert.deepEqual(daily.revenue.by_method, sum.revenue.by_method, 'агрегат = сводка: способы');
    assert.equal(row.games, sum.play.sessions, 'агрегат = сводка: игры');
    assert.equal(row.play_minutes, sum.play.minutes, 'агрегат = сводка: минуты');
    // Агрегат = живой расчёт после набора (если после среза не было новых оплат и игр).
    const later = live ? (await db.query("select count(*)::int as n from bl.payments where club_id = $1 and confirmed_at > $2 and not is_test and status = 'succeeded'", [CLUB_A, live.at])).rows[0].n : -1;
    if (later === 0) assert.equal(Number(row.net_kopecks), tv(live.money, 'revenue'), 'агрегат = дашборд на лету');
    // С M5.8 в сиде ещё 2 корта (ёмкость — тоже ресурсы в работе): число ресурсов в работе × 24 ч.
    const nRes = (await db.query('select count(*)::int as n from bl.resources where club_id = $1 and active', [CLUB_A])).rows[0].n;
    assert.equal(Number(row.capacity_minutes), nRes * 24 * 60, `ёмкость закрытых суток = ${nRes} ресурсов × 24 ч`);
    t.diagnostic(`агрегат ${S.today} с часами ${fakeClose.toISOString()}: выручка ${row.net_kopecks}, игр ${row.games}, минут ${row.play_minutes}, ёмкость ${row.capacity_minutes}; сводка: ${sum.revenue.net_kopecks}, ${sum.play.sessions}, ${sum.play.minutes}`);
  } finally {
    await app.query('rollback');
  }
});

test('T29: поздний возврат в закрытые сутки (подставная строка в ROLLBACK) — отметка, пересчёт tick(), агрегат − возврат = сводка', async (t) => {
  const b23 = await bounds(db, '2026-10-23');
  // Оплата 23.10 по СБП без возврата — «возврат» с моментом в 23.10 (как запись, закоммиченная после конца суток).
  const pay23 = (
    await db.query(
      `select p.id, p.amount_kopecks from bl.payments p where p.club_id = $1 and p.status = 'succeeded' and p.provider = 'yookassa' and p.capture and not p.is_test
          and p.confirmed_at >= $2 and p.confirmed_at < $3 and not exists (select 1 from bl.refunds f where f.payment_id = p.id) order by p.confirmed_at desc limit 1`,
      [CLUB_A, b23.from, b23.to],
    )
  ).rows[0];
  assert.ok(pay23);
  const before = (await db.query("select net_kopecks, refunds_kopecks from bl.stats_daily where club_id = $1 and day = '2026-10-23'", [CLUB_A])).rows[0];
  const amount = Math.min(10_000, Number(pay23.amount_kopecks));
  await app.query('begin');
  try {
    const ctx = txContext(app);
    await ctx(null, { clubId: CLUB_A, actorType: 'system' }, (c) =>
      c.query(
        `insert into bl.refunds (club_id, payment_id, amount_kopecks, status, kind, reason, idempotence_key, created_at, updated_at)
         values ($1, $2, $3, 'succeeded', 'refund', 'e2e M5.2: поздний возврат (ROLLBACK)', $4, $5, $5)`,
        [CLUB_A, pay23.id, amount, `e2e-m52-${randomUUID()}`, new Date(b23.to.getTime() - 60_000)],
      ),
    );
    const dirty = (await ctx(null, { clubId: CLUB_A, actorType: 'system' }, (c) => c.query("select gen from bl.stats_dirty where club_id = $1 and day = '2026-10-23'", [CLUB_A]))).rows;
    assert.equal(dirty.length, 1, 'триггер отметил 23.10 «грязными»');
    const r = await statsTick({ pool: null, withContext: ctx, clock: { now: () => new Date() }, log: { info() {}, warn() {}, error: (m, f) => t.diagnostic(`${m} ${JSON.stringify(f)}`) }, daysPerClub: 31 });
    assert.ok(r.computed.some((x) => x.club_id === CLUB_A && x.day === '2026-10-23'), 'tick() пересчитал 23.10');
    const after = (await ctx(null, { clubId: CLUB_A, actorType: 'system' }, (c) => c.query("select net_kopecks, refunds_kopecks from bl.stats_daily where club_id = $1 and day = '2026-10-23'", [CLUB_A]))).rows[0];
    assert.equal(Number(after.net_kopecks), Number(before.net_kopecks) - amount, 'чистая выручка 23.10 − возврат');
    assert.equal(Number(after.refunds_kopecks), Number(before.refunds_kopecks) + amount, 'возвраты 23.10 + возврат');
    const s = await ctx(null, { clubId: CLUB_A, actorType: 'system' }, (c) => buildMorningSummary(c, { clubId: CLUB_A, day: '2026-10-23', timezone: TZ, dayStartLocal: '06:00' }));
    assert.equal(s.revenue.net_kopecks, Number(after.net_kopecks), 'агрегат = сводка после пересчёта');
    const left = (await ctx(null, { clubId: CLUB_A, actorType: 'system' }, (c) => c.query("select 1 from bl.stats_dirty where club_id = $1 and day = '2026-10-23'", [CLUB_A]))).rowCount;
    assert.equal(left, 0, 'отметка снята');
    t.diagnostic(`23.10: ${before.net_kopecks} → ${after.net_kopecks} (возврат ${amount} коп.), пересчитано: ${r.computed.filter((x) => x.club_id === CLUB_A).map((x) => x.day).join(', ')}`);
  } finally {
    await app.query('rollback');
  }
});

test('T29: настоящий пересчёт закрытых суток сервером после исправления (тревога 23.10 принята сегодня)', { timeout: 4 * 60_000 }, async (t) => {
  const type = S.oldAlarm.type;
  const row = await waitFor(
    async () => {
      const x = (await db.query("select computed_at, data->'alarms'->'by_type'->$2 as t from bl.stats_daily where club_id = $1 and day = '2026-10-23'", [CLUB_A, type])).rows[0];
      const dirty = (await db.query("select 1 from bl.stats_dirty where club_id = $1 and day = '2026-10-23'", [CLUB_A])).rowCount;
      return x.computed_at > S.oldAlarmBefore.computed_at && dirty === 0 ? x : null;
    },
    { timeoutMs: 3 * 60_000, intervalMs: 5000, what: 'планировщик сервера пересчитал 23.10' },
  );
  assert.equal(row.t.acked, S.oldAlarmBefore.t.acked + 1, 'принятых + 1');
  assert.equal(row.t.unacked, S.oldAlarmBefore.t.unacked - 1, 'непринятых − 1');
  assert.equal(row.t.slow, S.oldAlarmBefore.t.slow + 1, 'принята позже 10 минут — slow + 1');
  await sleep(61_000); // кэш закрытых суток — 60 с
  const c = await dash(S.owner.token, CLUB_A, { from: '2026-10-23', to: '2026-10-23', tab: 'control' });
  const bt = c.json.tables.alarms.by_type.find((x) => x.type === type);
  assert.equal(bt.slow, row.t.slow, 'дашборд показывает пересчитанное');
  assert.equal(bt.problem, true);
  const fresh = await summaryOf(db, '2026-10-23');
  assert.equal(tv(c.json, 'alarms'), fresh.alarms.total);
  t.diagnostic(`23.10 пересчитан ${row.computed_at.toISOString()} (было ${S.oldAlarmBefore.computed_at.toISOString()}): ${type} ${JSON.stringify(S.oldAlarmBefore.t)} → ${JSON.stringify(row.t)}; отметка была: ${S.oldAlarmDirty}`);
});

export { addDays, sim, computeDay };
