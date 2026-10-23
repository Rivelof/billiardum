// Ревью (бронь, №128): стол недоступен гостю в окне удержания брони → бронь закрывается с
// причиной table_unavailable, предоплата возвращается целиком (чек возврата), владельцу тревога.
//
// Две брони с предоплатой, удержание сокращено до 2 минут (настройка клуба на время создания):
// A — стол E2E_REVIEW_UNAV_TABLE_A (3): сервисный свет (ресепшн, с причиной) включён до подтверждения
//     брони и идёт всё окно удержания (на синий стол сервис не включается — 409 table_busy);
// B — стол E2E_REVIEW_UNAV_TABLE_B (4): стол без связи всё окно удержания (симулятор net down).
// Для сравнения T18 (01-t18) — стол доступен, удержание по правилам клуба.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  alarmsSince,
  api,
  cancelLeftovers,
  createBooking,
  DEV,
  emuPayment,
  FAST_BOOKING,
  hhmm,
  MIN,
  newGuest,
  notificationsOf,
  OWNER_ID,
  ok,
  patchClubSettings,
  payBooking,
  paymentRow,
  refundsOf,
  RES,
  sim,
  simPost,
  sleep,
  sleepUntil,
  slotAfter,
  staff,
  waitBooking,
  waitFor,
  waitTableFree,
} from '../m3/helpers.mjs';

const TA = Number(process.env.E2E_REVIEW_UNAV_TABLE_A || 3);
const TB = Number(process.env.E2E_REVIEW_UNAV_TABLE_B || 4);
let db;
let rec;
let serviceOn = false;
let netDown = false;

before(async () => {
  db = await adminClient();
  rec = await staff('reception');
  const man = await staff('manager');
  await cancelLeftovers(db, man, [TA, TB], (m) => console.log(m));
  await waitTableFree(TA);
  await waitTableFree(TB);
});

after(async () => {
  if (serviceOn) await api('POST', `/api/resources/${RES(TA)}/service/stop`, { token: rec.token, body: {} }).catch(() => null);
  if (netDown) await simPost(TB, 'net', { up: true }).catch(() => null);
  await db?.end();
});

test(`стол недоступен в окне удержания: сервисный свет (стол ${TA}) и без связи (стол ${TB}) → полный возврат`, { timeout: 15 * MIN }, async (t) => {
  const since = new Date();
  const ga = await newGuest();
  const gb = await newGuest();
  const S = slotAfter(2 * MIN);
  let a;
  let b;
  await patchClubSettings(db, { ...FAST_BOOKING, booking_prepayment: 'full', booking_hold_prepaid_minutes: 2 });
  try {
    a = await ok(createBooking(ga.token, { table: TA, startsAt: S, minutes: 15 }), 201);
    b = await ok(createBooking(gb.token, { table: TB, startsAt: S, minutes: 15 }), 201);
  } finally {
    await patchClubSettings(db, { booking_hold_prepaid_minutes: 30 });
  }
  // A: сервисный свет включён до подтверждения брони (на синий стол брони сервис не включить —
  // 409 table_busy, поэтому раньше); он идёт и в окне удержания.
  const sv = await api('POST', `/api/resources/${RES(TA)}/service`, { token: rec.token, body: { minutes: 15, reason_code: 'cleaning', reason_text: 'Уборка стола (тест e2e ревью)' } });
  t.diagnostic(`сервисный свет на столе ${TA} до начала брони: ${sv.status} ${sv.text.slice(0, 100)}`);
  assert.ok([200, 201].includes(sv.status), sv.text);
  serviceOn = true;
  const pa = await payBooking(ga, a.id);
  const pb = await payBooking(gb, b.id);
  t.diagnostic(`брони на ${hhmm(S)}, удержание до ${hhmm(a.hold_until)}; предоплата ${pa.booking.paid_kopecks} и ${pb.booking.paid_kopecks} коп.`);
  // Сервисный свет ресепшена не должен гаснуть из-за удержания брони (два тика планировщика).
  await sleep(25_000);
  const svc = await sim(TA);
  const { rows: rej } = await db.query("select type, error, cause from bl.device_commands where device_id = $1 and created_at >= $2 and (status = 'failed' or cause = 'sync')", [DEV(TA), since]);
  t.diagnostic(`стол ${TA} через 25 с: ${svc.state.mode}/${svc.state.led}; отказы и сверка: ${JSON.stringify(rej)}`);
  const svcOk = svc.state.mode === 'service' && rej.length === 0;

  // B: стол без связи до конца удержания.
  await sleepUntil(new Date(S.getTime() - 30_000));
  await simPost(TB, 'net', { up: false });
  netDown = true;

  const ea = await waitBooking(ga.token, a.id, (x) => x.status === 'expired', { timeoutMs: 4 * MIN, what: 'бронь A закрыта' });
  const eb = await waitBooking(gb.token, b.id, (x) => x.status === 'expired', { timeoutMs: 2 * MIN, what: 'бронь B закрыта' });
  await simPost(TB, 'net', { up: true });
  netDown = false;
  await api('POST', `/api/resources/${RES(TA)}/service/stop`, { token: rec.token, body: {} });
  serviceOn = false;
  const problems = [];
  for (const [name, x, p, g] of [['A (сервис)', ea, pa, ga], ['B (без связи)', eb, pb, gb]]) {
    const pay = await waitFor(async () => {
      const r = await paymentRow(db, p.booking.payment_id);
      return r.settlement_status === 'forfeited' ? r : null;
    }, { timeoutMs: 20_000, what: `${name}: расчёт предоплаты` });
    await new Promise((r) => setTimeout(r, 3000));
    const refunds = await refundsOf(db, p.booking.payment_id);
    const back = refunds.filter((r) => r.status === 'succeeded').reduce((s, r) => s + Number(r.amount_kopecks), 0);
    const ep = emuPayment(p.pid);
    const notes = await notificationsOf(db, g.user.id, { kind: 'booking.expired' });
    t.diagnostic(`${name}: ${x.status}/${x.expire_reason}; удержано ${pay.settled_kopecks}, возвращено ${back} (ЮKassa ${ep.refunded_amount?.value ?? 0}, чеков возврата ${(ep.receipts ?? []).filter((r) => r.kind === 'refund').length}); гостю «${notes[0]?.text}»`);
    if (x.expire_reason !== 'table_unavailable') problems.push(`${name}: причина ${x.expire_reason}`);
    if (Number(pay.settled_kopecks) !== 0) problems.push(`${name}: удержано ${pay.settled_kopecks}`);
    if (back !== p.booking.paid_kopecks) problems.push(`${name}: возвращено ${back} из ${p.booking.paid_kopecks}`);
  }
  const alarms = await alarmsSince(db, since, 'booking_table_unavailable');
  const owner = await notificationsOf(db, OWNER_ID, { kind: 'alarm', since });
  t.diagnostic(`тревоги: ${JSON.stringify(alarms.map((x) => [x.level, x.data?.booking_id?.slice(0, 8), x.data?.reason ?? x.data?.why]))}; владельцу: ${owner.filter((n) => /брон/i.test(n.text)).map((n) => `«${n.text}»`).join(' | ')}`);
  assert.ok(alarms.length >= 1, 'тревога владельцу');
  if (!svcOk) problems.push('A: сервисный свет погашен удержанием брони / контроллер отклонял команды');
  assert.deepEqual(problems, [], 'стол недоступен → полный возврат; сервисный свет не трогается');
});
