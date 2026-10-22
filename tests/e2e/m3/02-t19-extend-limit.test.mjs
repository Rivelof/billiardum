// T19. Гость играет перед бронью и пытается продлить через время брони (decisions №106, №107).
//
// Стол E2E_T19_TABLE (по умолчанию 4):
// 1. Гость A играет 8 минут (СБП, свет). Гость B не может забронировать стол на время игры A
//    (409 table_busy) и ближе 5 минут к её концу (409 booking_conflict, №123), бронирует слот
//    позже (предоплата) — начало S.
// 2. Сессия A: extend_limit_until = S − 5 мин (GET /api/sessions/{id}).
// 3. Котировка продления на 60 минут — 409 booking_conflict; ровно до S − 5 — 200, в ответе
//    extend_limit_until = S − 5; оплата → paid_until = S − 5 и в API, и в контроллере.
//    Ещё минута — 409 booking_conflict.
// 4. За 15 минут до начала бронь reserved, но стол занят игрой A — контроллер продолжает игру
//    (свет горит, не синий). A заканчивает игру — стол сразу синий (state.reserved), чужой гость
//    не может занять стол. Уборка: управляющий отменяет бронь B (предоплата возвращается).
// Длится около 10 минут.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  cancelBooking,
  cancelLeftovers,
  cmdsWithAudit,
  createBooking,
  extendGame,
  FAST_BOOKING,
  hhmm,
  MIN,
  newGuest,
  ok,
  patchClubSettings,
  payBooking,
  quote,
  RES,
  session,
  sim,
  sleepUntil,
  slotAfter,
  startGame,
  staff,
  waitBooking,
  waitFor,
  waitSim,
  waitTableFree,
} from './helpers.mjs';

const T = Number(process.env.E2E_T19_TABLE || 4);
let db;
let man;

before(async () => {
  db = await adminClient();
  man = await staff('manager');
  await cancelLeftovers(db, man, [T], (m) => console.log(m));
  await waitTableFree(T);
});

after(async () => {
  await db?.end();
});

test(`T19: продление перед бронью ограничено «начало брони − 5 минут» (стол ${T})`, { timeout: 25 * MIN }, async (t) => {
  const since = new Date(Date.now() - 1000);
  await patchClubSettings(db, { ...FAST_BOOKING, booking_prepayment: 'full' });
  const A = await startGame(T, 8);
  await waitSim(T, (s) => s.state.relay === true && s.state.session_id === A.sessionId, { timeoutMs: 5000 });
  const s0 = await session(A.guest.token, A.sessionId);
  const { rows: g } = await db.query('select grace_ms from bl.sessions where id = $1', [A.sessionId]);
  t.diagnostic(`игра A: до ${hhmm(s0.paid_until)}, льгота ${g[0].grace_ms / 1000} с, extend_limit_until ${s0.extend_limit_until}`);
  assert.equal(s0.extend_limit_until, null, 'брони нет — предела нет');

  const B = await newGuest();
  const busySlot = slotAfter(2 * MIN);
  const busy = await createBooking(B.token, { table: T, startsAt: busySlot, minutes: 15 });
  t.diagnostic(`бронь на время игры A (${hhmm(busySlot)}): ${busy.status} ${busy.text}`);
  assert.equal(busy.status, 409);
  assert.equal(busy.json.error, 'table_busy');

  // Слот брони — так, чтобы до «начала − 5 минут» оставалось место продлить хотя бы на минуту.
  // №123 (Д7): бронь ближе 5 минут к оплаченному концу игры — booking_conflict.
  const near = slotAfter(new Date(s0.paid_until).getTime() - Date.now());
  const nearR = await createBooking(B.token, { table: T, startsAt: near, minutes: 15 });
  t.diagnostic(`бронь на ${hhmm(near)} (через ${Math.round((near - new Date(s0.paid_until)) / 1000)} с после конца игры): ${nearR.status} ${nearR.text}`);
  assert.equal(nearR.status, 409);
  assert.equal(nearR.json.error, 'booking_conflict');

  const S = slotAfter(new Date(s0.paid_until).getTime() - Date.now() + Math.max(g[0].grace_ms, 5 * MIN) + 90_000);
  const created = await ok(createBooking(B.token, { table: T, startsAt: S, minutes: 30 }), 201);
  const { booking } = await payBooking(B, created.id);
  const limit = new Date(S.getTime() - 5 * MIN);
  t.diagnostic(`бронь B: ${hhmm(S)}–${hhmm(booking.ends_at)}, ${booking.status}, предоплата ${booking.paid_kopecks} коп.; ждём предел ${hhmm(limit)}`);

  const s1 = await session(A.guest.token, A.sessionId);
  t.diagnostic(`сессия A: extend_limit_until ${s1.extend_limit_until}`);
  assert.equal(s1.extend_limit_until, limit.toISOString(), 'extend_limit_until в сессии = начало брони − 5 мин');

  const q60 = await quote(A.guest.token, { resourceId: RES(T), kind: 'extend', minutes: 60, sessionId: A.sessionId });
  t.diagnostic(`продление на 60 мин: ${q60.status} ${q60.text}`);
  assert.equal(q60.status, 409);
  assert.equal(q60.json.error, 'booking_conflict');

  const paidUntil = new Date(s1.paid_until);
  const maxMin = Math.floor((limit - paidUntil) / MIN);
  const qOk = await ok(quote(A.guest.token, { resourceId: RES(T), kind: 'extend', minutes: maxMin, sessionId: A.sessionId }));
  t.diagnostic(`продление на ${maxMin} мин (до предела): ${qOk.amount_kopecks} коп., extend_limit_until ${qOk.extend_limit_until}`);
  assert.equal(qOk.extend_limit_until, limit.toISOString());
  const ext = await extendGame(A.guest, RES(T), A.sessionId, maxMin);
  const s2 = await waitFor(async () => {
    const x = await session(A.guest.token, A.sessionId);
    return new Date(x.paid_until) > paidUntil ? x : null;
  }, { timeoutMs: 15_000, what: 'продление применено' });
  t.diagnostic(`после продления: до ${hhmm(s2.paid_until)} (предел ${hhmm(limit)}), платёж ${ext.payResp.payment_id.slice(0, 8)}`);
  assert.ok(new Date(s2.paid_until) <= limit, 'не дальше предела');
  assert.ok(limit - new Date(s2.paid_until) < MIN);
  const simExt = await waitSim(T, (s) => s.state.remaining_ms > (paidUntil - Date.now()) + 30_000, { timeoutMs: 10_000, what: 'контроллер продлён' });
  t.diagnostic(`контроллер: ${simExt.state.mode}, остаток ${Math.round(simExt.state.remaining_ms / 1000)} с`);

  const q1 = await quote(A.guest.token, { resourceId: RES(T), kind: 'extend', minutes: 1, sessionId: A.sessionId });
  t.diagnostic(`ещё 1 минута: ${q1.status} ${q1.text}`);
  assert.equal(q1.status, 409);
  assert.equal(q1.json.error, 'booking_conflict');

  // 4. Бронь reserved при занятом столе: свет игры не трогается, синий — после конца игры.
  await sleepUntil(new Date(S.getTime() - 15 * MIN + 15_000), (m) => t.diagnostic(m));
  const r = await waitBooking(B.token, created.id, (b) => b.status === 'reserved', { timeoutMs: 30_000, what: 'бронь B reserved' });
  const during = await sim(T);
  t.diagnostic(`бронь ${r.status} при игре A: контроллер ${during.state.mode}/${during.state.led}, свет ${during.state.relay}`);
  assert.equal(during.state.relay, true, 'игра A продолжается');
  assert.equal(during.state.session_id, A.sessionId);
  const stop = await api('POST', `/api/sessions/${A.sessionId}/stop`, { token: A.guest.token });
  assert.equal(stop.status, 200, stop.text);
  const blue = await waitSim(T, (s) => s.state.mode === 'reserved', { timeoutMs: 10_000, what: 'стол синий после игры' });
  t.diagnostic(`A закончил игру → контроллер ${blue.state.mode}/${blue.state.led}, свет ${blue.state.relay}`);
  assert.equal(blue.state.relay, false);
  const C = await newGuest();
  const qc = await quote(C.token, { resourceId: RES(T), kind: 'start', minutes: 30 });
  t.diagnostic(`чужой гость на синем столе: ${qc.status} ${qc.text.slice(0, 100)}`);
  assert.notEqual(qc.status, 200);

  const cancel = await cancelBooking(man.token, created.id, { reason: 'e2e T19: уборка', staff: true });
  t.diagnostic(`уборка: отмена управляющим ${cancel.status}, возврат ${cancel.json?.refund_kopecks} коп.`);
  assert.equal(cancel.status, 200, cancel.text);
  await waitSim(T, (s) => s.state.mode === 'free', { timeoutMs: 10_000, what: 'стол свободен' });
  const { cmds, missing } = await cmdsWithAudit(db, T, since);
  t.diagnostic(`команды стола: ${cmds.map((c) => `${c.type}:${c.status}`).join(', ')}; без журнала ${missing.length}`);
  assert.deepEqual(missing, []);
  // Конец игры при ждущей брони: session.stop гостя, затем state.reserved — по порядку, без отказов
  // контроллера (wrong_session) и без досылки session.stop сверкой (reason not_paid).
  const failed = cmds.filter((c) => c.status === 'failed');
  const { rows: stops } = await db.query("select cause, status, body->>'reason_code' as reason from bl.device_commands where device_id = $1 and type = 'session.stop' and created_at >= $2 order by queue_no", [
    `d1000000-0000-4000-8000-${String(T).padStart(12, '0')}`,
    since,
  ]);
  t.diagnostic(`session.stop: ${JSON.stringify(stops)}; отказы контроллера: ${failed.map((c) => `${c.type}`).join(', ') || 'нет'}`);
  assert.deepEqual(failed.map((c) => c.type), [], 'контроллер не отклонял команды');
  assert.deepEqual(stops.map((s) => `${s.cause}:${s.status}`), ['guest:acked'], 'один session.stop гостя, подтверждён');
  await waitTableFree(T);
});
