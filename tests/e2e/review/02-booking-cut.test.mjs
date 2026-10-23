// Ревью (бронь/свет, №129): игра оплачена, пока создавалась бронь → игра обрезана до начала
// брони − 5 минут, разница вернулась.
//
// Стол E2E_REVIEW_CUT_TABLE (по умолчанию 2).
// 1. Гость A берёт котировку старта на 60 минут: бронь гостя B на ближайшие 20 минут — 409
//    booking_conflict; A нажал «Оплатить» (платёж ждёт в ЮKassa) — бронь снова 409.
// 2. Гонку, которую закрывает №129, на стенде можно воспроизвести только «состарив» ожидание:
//    платёж A старше часа (money перестаёт его учитывать), котировка и pending истекли (база,
//    подготовка стенда). Бронь B принимается.
// 3. A оплачивает (эмулятор) → игра стартует, но paid_until = начало брони − 5 мин; неотыгранная
//    часть оплаты возвращена через ЮKassa (чек возврата), журнал session.booking_cut, гостю уведомление.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  cancelBooking,
  cancelLeftovers,
  createBooking,
  emuPayment,
  emuSucceed,
  FAST_BOOKING,
  hhmm,
  MIN,
  newGuest,
  notificationsOf,
  ok,
  patchClubSettings,
  pay,
  payBooking,
  providerId,
  quote,
  RES,
  session,
  slotAfter,
  staff,
  waitFor,
  waitPaymentSession,
  waitSim,
  waitTableFree,
} from '../m3/helpers.mjs';

const T = Number(process.env.E2E_REVIEW_CUT_TABLE || 2);
let db;
let man;
let bookingId;

before(async () => {
  db = await adminClient();
  man = await staff('manager');
  await cancelLeftovers(db, man, [T], (m) => console.log(m));
  await waitTableFree(T);
  await patchClubSettings(db, { ...FAST_BOOKING, booking_prepayment: 'full' });
});

after(async () => {
  if (bookingId) await cancelBooking(man.token, bookingId, { reason: 'e2e ревью: уборка', staff: true }).catch(() => null);
  await db?.end();
});

test(`игра оплачена, пока создавалась бронь → обрезана до брони − 5 мин, разница вернулась (стол ${T})`, { timeout: 10 * MIN }, async (t) => {
  const A = await newGuest();
  const B = await newGuest();
  const q = await ok(quote(A.token, { resourceId: RES(T), minutes: 60 }));
  const S = slotAfter(20 * MIN);
  const b1 = await createBooking(B.token, { table: T, startsAt: S, minutes: 30 });
  t.diagnostic(`котировка A на 60 мин (${q.amount_kopecks} коп.); бронь B на ${hhmm(S)}: ${b1.status} ${b1.text}`);
  assert.equal(b1.status, 409);
  const payResp = await ok(pay(A.token, q.quote_id));
  const b2 = await createBooking(B.token, { table: T, startsAt: S, minutes: 30 });
  t.diagnostic(`A нажал «Оплатить» (платёж ждёт): бронь B ${b2.status} ${b2.text}`);
  assert.equal(b2.status, 409);
  assert.equal(b2.json.error, 'booking_conflict');

  // «Состарить» ожидание: платёж старше часа, котировка и pending истекли.
  await db.query("update bl.payments set created_at = now() - interval '61 minutes' where id = $1", [payResp.payment_id]);
  await db.query("update bl.quotes set created_at = now() - interval '62 minutes', valid_until = now() - interval '59 minutes' where id = $1", [q.quote_id]);
  await db.query("update bl.resource_holds set until = now() where resource_id = $1 and kind = 'pending' and released_at is null", [RES(T)]);
  const b3 = await createBooking(B.token, { table: T, startsAt: S, minutes: 30 });
  assert.equal(b3.status, 201, b3.text);
  bookingId = b3.json.id;
  await payBooking(B, bookingId);
  t.diagnostic(`после «старения» ожидания бронь B принята: ${hhmm(S)}–${hhmm(b3.json.ends_at)}`);

  const pid = providerId(payResp);
  emuSucceed(pid);
  const p = await waitPaymentSession(A.token, payResp.payment_id);
  const s = await session(A.token, p.session_id);
  const limit = new Date(S.getTime() - 5 * MIN);
  const lit = await waitSim(T, (x) => x.state.relay === true && x.state.session_id === p.session_id, { timeoutMs: 5000, what: 'свет' });
  t.diagnostic(`игра A: до ${hhmm(s.paid_until)} (предел ${hhmm(limit)}), контроллер остаток ${Math.round(lit.state.remaining_ms / 1000)} с`);
  assert.ok(new Date(s.paid_until) <= limit, 'игра не заходит в бронь (до начала − 5 мин)');
  assert.ok(limit - new Date(s.paid_until) < MIN);
  assert.ok(Math.abs(lit.state.remaining_ms - (new Date(s.paid_until) - Date.now())) < 3000);

  const refunds = await waitFor(async () => {
    const { rows } = await db.query('select amount_kopecks, status from bl.refunds where payment_id = $1', [payResp.payment_id]);
    return rows.length && rows.every((r) => r.status === 'succeeded') ? rows : null;
  }, { timeoutMs: 20_000, what: 'возврат обрезанной части' });
  const back = refunds.reduce((x, r) => x + Number(r.amount_kopecks), 0);
  const playedMin = (new Date(s.paid_until) - new Date(s.started_at)) / MIN;
  const ep = emuPayment(pid);
  const { rows: au } = await db.query("select data from bl.audit_log where action = 'session.booking_cut' and data->>'session_id' = $1", [p.session_id]);
  const notes = await notificationsOf(db, A.user.id, { kind: 'session.booking_cut' });
  t.diagnostic(`оплачено ${q.amount_kopecks}, игра ${playedMin.toFixed(1)} мин, возвращено ${back} (ЮKassa ${ep.refunded_amount?.value}, чеков возврата ${(ep.receipts ?? []).filter((r) => r.kind === 'refund').length}); журнал ${JSON.stringify(au.map((a) => a.data))}; гостю «${notes[0]?.text}»`);
  assert.ok(back > 0 && back < q.amount_kopecks, 'вернулась несыгранная часть');
  const expectedBack = q.amount_kopecks * (1 - playedMin / 60);
  assert.ok(Math.abs(back - expectedBack) <= q.amount_kopecks / 60 + 100, `≈ ${Math.round(expectedBack)} коп. за ${(60 - playedMin).toFixed(1)} мин`);
  assert.equal(au.length, 1);
  assert.equal(notes.length, 1);
  await ok(api('POST', `/api/sessions/${p.session_id}/stop`, { token: A.token }));
  await waitSim(T, (x) => x.state.relay === false, { timeoutMs: 10_000 });
});
