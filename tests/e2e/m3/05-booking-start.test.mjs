// Старт по брони через QR (контракт M3 §1 п. 5, §4; decisions №108, №113, №116).
//
// Стол E2E_START_TABLE (по умолчанию 3), правила брони — helpers.FAST_BOOKING.
// A. Полная предоплата, гость у стола за ≤5 минут до начала: POST /api/bookings/{id}/start
//    {code} → started без новой оплаты: свет (session.start с записью в журнале), сессия до
//    конца брони, новых платежей нет, чек зачёта предоплаты ушёл в ЮKassa (/v3/receipts,
//    full_payment + settlements prepayment на всю предоплату); повтор — та же сессия; код
//    чужого стола — 403. Гость закончил игру — бронь completed.
// B. Ранний приход (за 20 минут) с полной предоплатой: payment_required, котировка money
//    booking_start — доплата только за время до начала брони; оплата обычным
//    POST /api/quotes/{id}/pay → игра до конца брони, одна сессия, одна команда session.start.
// C. Опоздание без предоплаты (№113): бронь confirmed без денег, гость пришёл через ~1,5 минуты
//    после начала — платит только с прихода до конца брони (меньше цены брони), игра до конца брони.
// D. Отказ ЮKassa (400) на чек зачёта при старте по брони: игра идёт, чек failed, тревога с
//    действием «Повторить»; повтор POST /api/receipts/{id}/retry — ресепшн 403, без причины 400,
//    управляющий с причиной — чек ушёл, журнал manual.receipt_retry (Д2).
// Длится около 12 минут.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  auditOf,
  CLUB_A,
  cancelLeftovers,
  cmdsWithAudit,
  createBooking,
  emu,
  emuReceipts,
  emuSucceed,
  FAST_BOOKING,
  hhmm,
  MIN,
  newGuest,
  ok,
  patchClubSettings,
  pay,
  payBooking,
  paymentRow,
  providerId,
  receiptsOf,
  session,
  sleepUntil,
  slotAfter,
  staff,
  tableCode,
  waitBooking,
  waitFor,
  waitSettlementSent,
  waitSim,
  waitTableFree,
} from './helpers.mjs';

const T = Number(process.env.E2E_START_TABLE || 3);
const OTHER = Number(process.env.E2E_START_OTHER_TABLE || 5);
let db;

before(async () => {
  db = await adminClient();
  const man = await staff('manager');
  await cancelLeftovers(db, man, [T], (m) => console.log(m));
  await waitTableFree(T);
});

after(async () => {
  await db?.end();
});

async function paymentsOfUser(userId) {
  const { rows } = await db.query('select id, kind, method, status, amount_kopecks from bl.payments where user_id = $1 order by created_at', [userId]);
  return rows;
}

async function stopAndComplete(guest, sessionId, bookingId) {
  await ok(api('POST', `/api/sessions/${sessionId}/stop`, { token: guest.token }));
  await waitSim(T, (s) => s.state.mode === 'free', { timeoutMs: 10_000, what: 'стол свободен' });
  return waitBooking(guest.token, bookingId, (b) => b.status === 'completed', { timeoutMs: 20_000, what: 'бронь completed' });
}

/** Цена часа стола сейчас (GET /api/t/{code}: price_now). */
async function perHourNow() {
  return (await ok(api('GET', `/api/t/${tableCode(T)}`))).price_now.price_per_hour_kopecks;
}

/** Ожидаемая цена по тарифу клуба — для грубой сверки, ±1 минута и округление. */
function approxPrice(minutes, perHour) {
  return Math.round((perHour * minutes) / 60);
}

test(`A: старт по брони через QR без повторной оплаты, чек зачёта предоплаты (стол ${T})`, { timeout: 8 * MIN }, async (t) => {
  const since = new Date(Date.now() - 1000);
  await patchClubSettings(db, { ...FAST_BOOKING, booking_prepayment: 'full' });
  const guest = await newGuest();
  const startsAt = slotAfter(10_000);
  const b = await ok(createBooking(guest.token, { table: T, startsAt, minutes: 15 }), 201);
  const { booking, pid } = await payBooking(guest, b.id);
  await sleepUntil(new Date(startsAt.getTime() - 4.5 * MIN));
  const wrong = await api('POST', `/api/bookings/${b.id}/start`, { token: guest.token, body: { code: tableCode(OTHER) } });
  t.diagnostic(`бронь ${hhmm(startsAt)}–${hhmm(booking.ends_at)}, предоплата ${booking.paid_kopecks} коп.; код чужого стола: ${wrong.status} ${wrong.text}`);
  assert.equal(wrong.status, 403);
  const t0 = Date.now();
  const st = await ok(api('POST', `/api/bookings/${b.id}/start`, { token: guest.token, body: { code: tableCode(T) } }));
  const on = await waitSim(T, (s) => s.state.relay === true && s.state.session_id === st.session_id, { timeoutMs: 5000, intervalMs: 50, what: 'свет по брони' });
  t.diagnostic(`старт: ${st.status}, сессия ${st.session_id?.slice(0, 8)}, свет через ${Date.now() - t0} мс, остаток контроллера ${Math.round(on.state.remaining_ms / 1000)} с`);
  assert.equal(st.status, 'started');
  assert.equal(st.booking.status, 'started');
  const s = await session(guest.token, st.session_id);
  const endGap = (new Date(s.paid_until) - new Date(booking.ends_at)) / 1000;
  t.diagnostic(`сессия до ${hhmm(s.paid_until)}, конец брони ${hhmm(booking.ends_at)} (разница ${endGap} с), booking_id ${s.booking_id?.slice(0, 8)}`);
  assert.equal(s.booking_id, b.id);
  assert.equal(endGap, 0, 'игра кончается ровно в конце брони (№123)');
  const again = await ok(api('POST', `/api/bookings/${b.id}/start`, { token: guest.token, body: { code: tableCode(T) } }));
  assert.equal(again.session_id, st.session_id, 'повтор — та же сессия');

  const pays = await paymentsOfUser(guest.user.id);
  t.diagnostic(`платежи гостя: ${pays.map((p) => `${p.kind}/${p.method}/${p.status}/${p.amount_kopecks}`).join(', ')}`);
  assert.equal(pays.length, 1, 'новой оплаты нет');
  const settled = await waitSettlementSent(db, booking.payment_id);
  const p = await paymentRow(db, booking.payment_id);
  const er = emuReceipts(pid);
  t.diagnostic(`предоплата ${p.settlement_status}, зачтено ${p.settled_kopecks}; чек зачёта ${settled.map((r) => `${r.settlement_kopecks}/${r.status}`).join(', ')}; в ЮKassa ${JSON.stringify(er.map((r) => ({ items: r.items.map((i) => [i.description, i.amount.value, i.payment_mode]), settlements: r.settlements })))}`);
  assert.equal(p.settlement_status, 'settled');
  assert.equal(Number(p.settled_kopecks), booking.paid_kopecks);
  assert.equal(er.length, 1);
  assert.equal(er[0].settlements[0].type, 'prepayment');
  assert.equal(Math.round(Number(er[0].settlements[0].amount.value) * 100), booking.paid_kopecks);
  assert.ok(er[0].items.every((i) => i.payment_mode === 'full_payment'));

  const done = await stopAndComplete(guest, st.session_id, b.id);
  const au = (await auditOf(db, b.id)).map((r) => r.action);
  t.diagnostic(`бронь после конца игры: ${done.status}; журнал: ${au.join(', ')}`);
  for (const a of ['booking.create', 'booking.confirm', 'booking.start', 'session.start', 'payment.settled', 'booking.complete']) assert.ok(au.includes(a), a);
  const { cmds, missing } = await cmdsWithAudit(db, T, since);
  t.diagnostic(`команды стола: ${cmds.map((c) => `${c.type}:${c.status}`).join(', ')}`);
  assert.equal(cmds.filter((c) => c.type === 'session.start').length, 1);
  assert.deepEqual(missing, []);
});

test(`B: ранний приход за 20 минут — доплата только за время до брони (стол ${T})`, { timeout: 8 * MIN }, async (t) => {
  await waitTableFree(T);
  const since = new Date();
  await patchClubSettings(db, { ...FAST_BOOKING, booking_prepayment: 'full' });
  const guest = await newGuest();
  const startsAt = slotAfter(20 * MIN);
  const b = await ok(createBooking(guest.token, { table: T, startsAt, minutes: 15 }), 201);
  const { booking } = await payBooking(guest, b.id);
  const ph = await perHourNow();
  const tArrive = Date.now();
  const st = await ok(api('POST', `/api/bookings/${b.id}/start`, { token: guest.token, body: { code: tableCode(T) } }));
  const earlyMin = Math.max(1, Math.floor((startsAt.getTime() - tArrive) / MIN)); // №123: минуты вниз
  t.diagnostic(`бронь ${hhmm(startsAt)}–${hhmm(booking.ends_at)} (${booking.paid_kopecks} коп. внесено); пришёл в ${hhmm(tArrive)} — раньше на ~${earlyMin} мин: ${st.status}, к оплате ${st.amount_kopecks} коп., котировка ${JSON.stringify(st.quote)}`);
  assert.equal(st.status, 'payment_required');
  assert.ok(Math.abs(st.amount_kopecks - approxPrice(earlyMin, ph)) <= approxPrice(1, ph) + 100, `доплата ≈ цене ${earlyMin} мин`);
  const sim0 = await waitSim(T, () => true);
  assert.equal(sim0.state.relay, false, 'до оплаты свет не горит');
  const pr = await ok(pay(guest.token, st.quote.quote_id));
  emuSucceed(providerId(pr));
  const started = await waitBooking(guest.token, b.id, (x) => x.status === 'started' && x.session_id, { timeoutMs: 20_000, what: 'бронь started после доплаты' });
  const on = await waitSim(T, (s) => s.state.relay === true && s.state.session_id === started.session_id, { timeoutMs: 5000, what: 'свет после доплаты' });
  const s = await session(guest.token, started.session_id);
  const endGap = (new Date(s.paid_until) - new Date(booking.ends_at)) / 1000;
  t.diagnostic(`после доплаты: сессия до ${hhmm(s.paid_until)} (конец брони ${hhmm(booking.ends_at)}, разница ${endGap} с), контроллер ${on.state.mode}`);
  assert.equal(endGap, 0, 'ровно в конце брони (№123)');
  const pays = await paymentsOfUser(guest.user.id);
  t.diagnostic(`платежи гостя: ${pays.map((p) => `${p.kind}/${p.method}/${p.status}/${p.amount_kopecks}`).join(', ')}`);
  assert.equal(pays.length, 2);
  assert.equal(Number(pays[1].amount_kopecks), st.amount_kopecks);
  await waitSettlementSent(db, booking.payment_id);
  const rc = await receiptsOf(db, pays[1].id);
  t.diagnostic(`чеки доплаты: ${rc.map((r) => `${r.kind}/${r.channel}/${r.status}/${r.amount_kopecks}`).join(', ')}`);
  const { rows: sess } = await db.query('select id from bl.sessions where booking_id = $1', [b.id]);
  assert.equal(sess.length, 1, 'одна сессия на бронь');
  await stopAndComplete(guest, started.session_id, b.id);
  const { cmds, missing } = await cmdsWithAudit(db, T, since);
  t.diagnostic(`команды стола: ${cmds.map((c) => `${c.type}:${c.status}`).join(', ')}`);
  assert.equal(cmds.filter((c) => c.type === 'session.start').length, 1);
  assert.deepEqual(missing, []);
});

test(`C: опоздание без предоплаты — оплата только с прихода до конца брони, №113 (стол ${T})`, { timeout: 12 * MIN }, async (t) => {
  await waitTableFree(T);
  const since = new Date();
  const guest = await newGuest();
  const startsAt = slotAfter(10_000);
  let b;
  await patchClubSettings(db, { ...FAST_BOOKING, booking_prepayment: 'none' });
  try {
    b = await ok(createBooking(guest.token, { table: T, startsAt, minutes: 15 }), 201);
  } finally {
    await patchClubSettings(db, { booking_prepayment: 'full' });
  }
  t.diagnostic(`бронь без предоплаты ${hhmm(startsAt)}–${hhmm(b.ends_at)}: ${b.status}, цена брони ${b.amount_kopecks} коп., удержание до ${hhmm(b.hold_until)}`);
  assert.equal(b.status, 'confirmed');
  assert.equal(b.prepayment_kopecks, 0);
  assert.equal(new Date(b.hold_until) - startsAt, 15 * MIN, 'без предоплаты — удержание 15 минут');
  await sleepUntil(new Date(startsAt.getTime() + 90_000), (m) => t.diagnostic(m));
  const ph = await perHourNow();
  const tArrive = Date.now();
  const st = await ok(api('POST', `/api/bookings/${b.id}/start`, { token: guest.token, body: { code: tableCode(T) } }));
  const leftMin = Math.max(1, Math.floor((new Date(b.ends_at) - tArrive) / MIN)); // №123: минуты вниз
  t.diagnostic(`пришёл в ${hhmm(tArrive)} (опоздал на ${Math.round((tArrive - startsAt) / 1000)} с): ${st.status}, к оплате ${st.amount_kopecks} коп. за ~${leftMin} мин (цена брони ${b.amount_kopecks}); котировка ${JSON.stringify(st.quote)}`);
  assert.equal(st.status, 'payment_required');
  assert.ok(st.amount_kopecks < b.amount_kopecks, 'меньше цены всей брони');
  assert.ok(Math.abs(st.amount_kopecks - approxPrice(leftMin, ph)) <= approxPrice(1, ph) + 100, `≈ цене ${leftMin} мин с прихода`);
  assert.equal(st.quote.minutes, leftMin, 'минуты с прихода — вниз (№123)');
  const pr = await ok(pay(guest.token, st.quote.quote_id));
  emuSucceed(providerId(pr));
  const started = await waitBooking(guest.token, b.id, (x) => x.status === 'started' && x.session_id, { timeoutMs: 20_000, what: 'бронь started' });
  await waitSim(T, (s) => s.state.relay === true && s.state.session_id === started.session_id, { timeoutMs: 5000, what: 'свет' });
  const s = await session(guest.token, started.session_id);
  const endGap = (new Date(s.paid_until) - new Date(b.ends_at)) / 1000;
  t.diagnostic(`игра до ${hhmm(s.paid_until)}, конец брони ${hhmm(b.ends_at)} (разница ${endGap} с)`);
  assert.equal(endGap, 0, 'ровно в конце брони (№123)');
  await stopAndComplete(guest, started.session_id, b.id);
  const { missing } = await cmdsWithAudit(db, T, since);
  assert.deepEqual(missing, []);
});

test(`D: отказ ЮKassa на чек зачёта (4xx) — повтор управляющим с причиной, Д2 (стол ${T})`, { timeout: 8 * MIN }, async (t) => {
  await waitTableFree(T);
  await patchClubSettings(db, { ...FAST_BOOKING, booking_prepayment: 'full' });
  const guest = await newGuest();
  const startsAt = slotAfter(10_000);
  const b = await ok(createBooking(guest.token, { table: T, startsAt, minutes: 15 }), 201);
  const { booking, pid } = await payBooking(guest, b.id);
  await sleepUntil(new Date(startsAt.getTime() - 4.5 * MIN));
  emu('/__emu/config', { post: true, body: { fail_next: { count: 1, status: 400 } } });
  let st;
  try {
    st = await ok(api('POST', `/api/bookings/${b.id}/start`, { token: guest.token, body: { code: tableCode(T) } }));
    await waitSim(T, (s) => s.state.relay === true && s.state.session_id === st.session_id, { timeoutMs: 5000, what: 'свет по брони' });
  } finally {
    emu('/__emu/config', { post: true, body: { fail_next: { count: 0 } } });
  }
  const failed = await waitFor(async () => (await receiptsOf(db, booking.payment_id)).find((r) => r.settles_payment_id && r.status === 'failed') ?? null, {
    timeoutMs: 30_000,
    what: 'чек зачёта failed после 400',
  });
  const { rows: al } = await db.query("select level, data from bl.alarms where club_id = $1 and type = 'settlement_receipt_failed' and data->>'receipt_id' = $2", [CLUB_A, failed.id]);
  t.diagnostic(`свет есть, игра идёт; чек зачёта ${failed.id.slice(0, 8)} → ${failed.status}; тревога ${JSON.stringify(al.map((a) => [a.level, a.data.action_id, a.data.action_url]))}`);
  assert.equal(al.length, 1);
  assert.equal(al[0].data.action_id, 'retry');
  const rec = await staff('reception');
  const man = await staff('manager');
  const byRec = await api('POST', `/api/receipts/${failed.id}/retry`, { token: rec.token, idem: true, body: { reason: 'тест e2e' } });
  const noReason = await api('POST', `/api/receipts/${failed.id}/retry`, { token: man.token, idem: true, body: {} });
  t.diagnostic(`повтор ресепшеном: ${byRec.status}; без причины: ${noReason.status} ${noReason.text}`);
  assert.equal(byRec.status, 403);
  assert.equal(noReason.status, 400);
  const r = await ok(api('POST', `/api/receipts/${failed.id}/retry`, { token: man.token, idem: true, body: { reason: 'ЮKassa отказала, повтор (тест e2e)' } }));
  const sent = await waitSettlementSent(db, booking.payment_id);
  const er = emuReceipts(pid);
  const au = (await auditOf(db, failed.id)).filter((a) => a.action === 'manual.receipt_retry');
  t.diagnostic(`повтор: ${JSON.stringify(r)}; чек ${sent.map((x) => `${x.status}/${x.provider_receipt_id}`).join(', ')}; в ЮKassa чеков зачёта ${er.length}; журнал manual.receipt_retry: ${au.length} («${au[0]?.reason}»)`);
  assert.equal(r.retried, true);
  assert.equal(er.length, 1);
  assert.equal(au.length, 1);
  await stopAndComplete(guest, st.session_id, b.id);
});
