// Бронь по телефону, «гость пришёл», отмена персоналом (контракт M3 §4; decisions №114, №115).
//
// Стол E2E_PHONE_TABLE (по умолчанию 4).
// 1. Ресепшн бронирует по телефону (имя, телефон): 201 confirmed, source phone, без предоплаты,
//    телефон в ответе, списке клуба, журнале и логе сервера — только маской.
// 2. Ближняя бронь по телефону → reserved (стол синий); ресепшн «гость пришёл»
//    (POST /api/bookings/{id}/arrive) → бронь started, синий снят (state.free); гостю маршрут — 403.
// 3. Отмена ресепшеном (№115): своя бронь по телефону без причины — 400 reason_required, с
//    причиной — 200, журнал manual.booking_cancel, тревога manual_action и уведомление владельцу;
//    бронь гостя из приложения с предоплатой и без — 403.
// 4. Отмена управляющим брони гостя с предоплатой за час до начала (по правилам гостя предоплата
//    уже не вернулась бы): без причины — 400; с причиной — возврат целиком через ЮKassa с чеком
//    возврата, payment.forfeited 0 %, тревога владельцу, гостю — booking.canceled.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  auditOf,
  cancelBooking,
  cancelLeftovers,
  CLUB_A,
  cmdsWithAudit,
  containerLog,
  createBooking,
  emuPayment,
  FAST_BOOKING,
  getBooking,
  hhmm,
  MIN,
  newGuest,
  notificationsOf,
  OWNER_ID,
  ok,
  patchClubSettings,
  payBooking,
  phoneBooking,
  refundsOf,
  SERVER_CONTAINER,
  slotAfter,
  staff,
  waitBooking,
  waitFor,
  waitSim,
  waitTableFree,
} from './helpers.mjs';

const T = Number(process.env.E2E_PHONE_TABLE || 4);
const PHONE = `+7999${String(Date.now()).slice(-7)}`;
let db;
let rec;
let man;
const created = [];

before(async () => {
  db = await adminClient();
  rec = await staff('reception');
  man = await staff('manager');
  await cancelLeftovers(db, man, [T], (m) => console.log(m));
  await waitTableFree(T);
  await patchClubSettings(db, { ...FAST_BOOKING, booking_prepayment: 'full' });
});

after(async () => {
  for (const id of created) await cancelBooking(man.token, id, { reason: 'e2e: уборка', staff: true }).catch(() => null);
  await db?.end();
});

/** Открытая тревога manual_action стола (ручные действия склеиваются по столу, count растёт). */
async function manualAlarm(n) {
  const { rows } = await db.query(
    "select id, type, level, count, data, raised_at from bl.alarms where club_id = $1 and type = 'manual_action' and resource_id = $2 and acked_at is null order by last_raised_at desc limit 1",
    [CLUB_A, `e1000000-0000-4000-8000-${String(n).padStart(12, '0')}`],
  );
  assert.ok(rows[0], 'тревога manual_action по столу');
  return rows[0];
}

function localDate(d) {
  // Рабочие сутки клуба начинаются в 06:00 Екатеринбурга (01:00 UTC).
  return new Date(new Date(d).getTime() - 3600_000).toISOString().slice(0, 10);
}

test('бронь по телефону ресепшеном: confirmed без предоплаты, телефон только маской', async (t) => {
  const since = new Date();
  const startsAt = slotAfter(26 * 3600_000, 30);
  const r = await phoneBooking(rec.token, { table: T, startsAt, minutes: 60, name: 'Иван (тест e2e)', phone: `${PHONE.slice(0, 2)} ${PHONE.slice(2, 5)} ${PHONE.slice(5, 8)}-${PHONE.slice(8, 10)}-${PHONE.slice(10)}` });
  assert.equal(r.status, 201, r.text);
  created.push(r.json.id);
  t.diagnostic(`бронь: ${r.json.status}, source ${r.json.source}, предоплата ${r.json.prepayment_kopecks}, гость ${JSON.stringify(r.json.guest)}`);
  assert.equal(r.json.status, 'confirmed');
  assert.equal(r.json.source, 'phone');
  assert.equal(r.json.prepayment_kopecks, 0);
  assert.equal(r.json.guest.name, 'Иван (тест e2e)');
  assert.ok(!r.text.includes(PHONE.slice(2)), 'полного телефона в ответе нет');
  assert.ok(r.json.guest.phone_masked && r.json.guest.phone_masked.includes('*'));
  const list = await ok(api('GET', `/api/clubs/${CLUB_A}/bookings?date=${localDate(startsAt)}`, { token: rec.token }));
  const mine = list.bookings.find((x) => x.id === r.json.id);
  t.diagnostic(`список клуба на ${list.date}: ${list.bookings.length} броней, наша: ${JSON.stringify(mine?.guest)}`);
  assert.ok(mine);
  assert.ok(!JSON.stringify(list).includes(PHONE.slice(2)));
  const au = await auditOf(db, r.json.id);
  assert.ok(au.some((a) => a.action === 'booking.create'));
  assert.ok(!JSON.stringify(au).includes(PHONE.slice(2)), 'в журнале нет полного телефона');
  const logs = containerLog(SERVER_CONTAINER, { since });
  assert.ok(!JSON.stringify(logs).includes(PHONE.slice(2)), 'в логе сервера нет полного телефона');
  const guest = await newGuest();
  const g = await getBooking(guest.token, r.json.id);
  t.diagnostic(`чужой гость читает бронь: ${g.status}`);
  assert.equal(g.status, 404);
});

test('«гость пришёл»: ресепшн снимает синий, бронь started; гостю — 403', { timeout: 6 * MIN }, async (t) => {
  const since = new Date(Date.now() - 1000);
  // Ближайший свободный слот (повторный прогон: прошлая бронь «гость пришёл» держит свой интервал до конца).
  let startsAt;
  let r;
  for (let i = 0; i < 6; i += 1) {
    startsAt = slotAfter(30_000 + i * 5 * MIN);
    r = await phoneBooking(rec.token, { table: T, startsAt, minutes: 15, name: 'Пётр (тест e2e)', phone: PHONE });
    if (r.status !== 409) break;
  }
  assert.equal(r.status, 201, r.text);
  const b = r.json;
  assert.ok(startsAt.getTime() - Date.now() < 15 * MIN, 'ближняя бронь (до reserved меньше 15 минут)');
  created.push(b.id);
  const res = await waitBooking(rec.token, b.id, (x) => x.status === 'reserved', { timeoutMs: 30_000, clubHeader: true, what: 'бронь по телефону reserved' });
  const blue = await waitSim(T, (s) => s.state.mode === 'reserved', { timeoutMs: 10_000, what: 'стол синий' });
  t.diagnostic(`бронь ${hhmm(startsAt)}: ${res.status}, стол ${blue.state.mode}/${blue.state.led}`);
  const guest = await newGuest();
  const byGuest = await api('POST', `/api/bookings/${b.id}/arrive`, { token: guest.token });
  t.diagnostic(`гость вызывает arrive: ${byGuest.status} ${byGuest.text}`);
  assert.equal(byGuest.status, 403);
  const arr = await ok(api('POST', `/api/bookings/${b.id}/arrive`, { token: rec.token, headers: { 'x-club-id': CLUB_A } }));
  const free = await waitSim(T, (s) => s.state.mode === 'free', { timeoutMs: 10_000, what: 'синий снят' });
  t.diagnostic(`arrive: ${arr.status}; стол ${free.state.mode}/${free.state.led}`);
  assert.equal(arr.status, 'started');
  const au = (await auditOf(db, b.id)).map((a) => a.action);
  t.diagnostic(`журнал: ${au.join(', ')}`);
  assert.ok(au.includes('booking.arrive'));
  const { cmds, missing } = await cmdsWithAudit(db, T, since);
  t.diagnostic(`команды стола: ${cmds.map((c) => `${c.type}:${c.status}`).join(', ')}`);
  assert.ok(cmds.some((c) => c.type === 'state.reserved') && cmds.some((c) => c.type === 'state.free'));
  assert.deepEqual(missing, []);
});

test('отмена ресепшеном: только phone/staff без предоплаты, с причиной; тревога владельцу (№115)', async (t) => {
  const since = new Date(Date.now() - 1000);
  const startsAt = slotAfter(27 * 3600_000, 30);
  const b = await ok(phoneBooking(rec.token, { table: T, startsAt, minutes: 60, phone: PHONE }), 201);
  created.push(b.id);
  const noReason = await cancelBooking(rec.token, b.id, { staff: true });
  t.diagnostic(`ресепшн без причины: ${noReason.status} ${noReason.text}`);
  assert.equal(noReason.status, 400);
  assert.equal(noReason.json.error, 'reason_required');
  const c = await cancelBooking(rec.token, b.id, { reason: 'Гость позвонил и отменил (тест e2e)', staff: true });
  t.diagnostic(`ресепшн с причиной: ${c.status}, статус ${c.json?.status}`);
  assert.equal(c.status, 200, c.text);
  assert.equal(c.json.status, 'canceled');
  const au = await auditOf(db, b.id);
  const manual = au.find((a) => a.action === 'manual.booking_cancel');
  t.diagnostic(`журнал: ${au.map((a) => a.action).join(', ')}; причина «${manual?.reason}»`);
  assert.ok(manual);
  assert.equal(manual.reason, 'Гость позвонил и отменил (тест e2e)');
  const alarm = await manualAlarm(T);
  const owner = await waitFor(async () => (await notificationsOf(db, OWNER_ID, { kind: 'alarm', since })).find((n) => n.text.includes('Гость позвонил и отменил')) ?? null, {
    timeoutMs: 10_000,
    what: 'уведомление владельцу',
  });
  t.diagnostic(`тревога ${alarm.type}/${alarm.level}, count ${alarm.count}, в data бронь ${alarm.data.booking_id === b.id ? 'эта' : `другая (${alarm.data.booking_id.slice(0, 8)} — склейка по столу)`}; владельцу: «${owner.text}» (${owner.status})`);
  assert.equal(alarm.level, 'critical');

  // Брони гостей из приложения ресепшн не отменяет — ни с предоплатой, ни без.
  const g1 = await newGuest();
  const s1 = slotAfter(28 * 3600_000, 30);
  const paid = await ok(createBooking(g1.token, { table: T, startsAt: s1, minutes: 60 }), 201);
  created.push(paid.id);
  await payBooking(g1, paid.id);
  const g2 = await newGuest();
  let free;
  await patchClubSettings(db, { booking_prepayment: 'none' });
  try {
    free = await ok(createBooking(g2.token, { table: T, startsAt: slotAfter(29 * 3600_000, 30), minutes: 60 }), 201);
  } finally {
    await patchClubSettings(db, { booking_prepayment: 'full' });
  }
  created.push(free.id);
  const r1 = await cancelBooking(rec.token, paid.id, { reason: 'тест e2e', staff: true });
  const r2 = await cancelBooking(rec.token, free.id, { reason: 'тест e2e', staff: true });
  t.diagnostic(`ресепшн отменяет бронь гостя с предоплатой: ${r1.status} ${r1.text}; без предоплаты (source app): ${r2.status} ${r2.text}`);
  assert.equal(r1.status, 403);
  assert.equal(r2.status, 403);
  const own = await cancelBooking(g2.token, free.id);
  t.diagnostic(`гость отменяет свою бронь без причины: ${own.status}, журнал ${(await auditOf(db, free.id)).map((a) => a.action).join(', ')}`);
  assert.equal(own.status, 200);
});

test('отмена управляющим: предоплата возвращается целиком, чек возврата, тревога владельцу', async (t) => {
  const since = new Date(Date.now() - 1000);
  const g = await newGuest();
  const startsAt = slotAfter(60 * MIN);
  const b = await ok(createBooking(g.token, { table: T, startsAt, minutes: 30 }), 201);
  created.push(b.id);
  const { booking, pid } = await payBooking(g, b.id);
  t.diagnostic(`бронь гостя ${hhmm(startsAt)}, внесено ${booking.paid_kopecks} коп.; по правилам гостя при отмене сейчас вернётся ${booking.cancel.refund_kopecks} коп. (бесплатно до ${booking.cancel.free_until})`);
  assert.ok(booking.cancel.refund_kopecks < booking.paid_kopecks, 'гостю уже не вернулось бы целиком');
  const noReason = await cancelBooking(man.token, b.id, { staff: true });
  assert.equal(noReason.status, 400);
  const c = await cancelBooking(man.token, b.id, { reason: 'Стол на ремонте (тест e2e)', staff: true });
  t.diagnostic(`управляющий: ${c.status}, refund_kopecks ${c.json?.refund_kopecks}, money ${JSON.stringify(c.json?.money)}`);
  assert.equal(c.status, 200, c.text);
  assert.equal(c.json.refund_kopecks, booking.paid_kopecks);
  const refunds = await waitFor(async () => {
    const r = await refundsOf(db, booking.payment_id);
    return r.length && r.every((x) => x.status === 'succeeded') ? r : null;
  }, { timeoutMs: 15_000, what: 'возврат succeeded' });
  const ep = emuPayment(pid);
  const rr = (ep.receipts ?? []).filter((x) => x.kind === 'refund');
  t.diagnostic(`возвраты: ${refunds.map((r) => `${r.amount_kopecks}/${r.status}`).join(', ')}; ЮKassa вернула ${ep.refunded_amount?.value}, чеков возврата ${rr.length} (${JSON.stringify(rr.map((x) => x.receipt.items.map((i) => [i.amount.value, i.payment_mode])))})`);
  assert.equal(refunds.reduce((s, r) => s + Number(r.amount_kopecks), 0), booking.paid_kopecks);
  assert.equal(rr.length, 1);
  const au = await auditOf(db, b.id);
  const forfeit = au.find((a) => a.action === 'payment.forfeited');
  t.diagnostic(`журнал: ${au.map((a) => a.action).join(', ')}; forfeited ${JSON.stringify(forfeit?.data)}`);
  assert.ok(au.some((a) => a.action === 'manual.booking_cancel'));
  assert.equal(forfeit.data.percent, 0);
  const alarm = await manualAlarm(T);
  const owner = await waitFor(async () => (await notificationsOf(db, OWNER_ID, { kind: 'alarm', since })).find((n) => n.text.includes('Стол на ремонте')) ?? null, { timeoutMs: 10_000, what: 'уведомление владельцу' });
  t.diagnostic(`тревога ${alarm.type}/${alarm.level} count ${alarm.count}; владельцу: «${owner.text}»`);
  const note = await waitFor(async () => (await notificationsOf(db, g.user.id, { kind: 'booking.canceled' }))[0] ?? null, { timeoutMs: 10_000, what: 'уведомление гостю' });
  t.diagnostic(`гостю: «${note.text}»`);
});
