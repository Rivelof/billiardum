// Ревью (бронь, №128): стол недоступен гостю в окне удержания брони → бронь закрывается с
// причиной table_unavailable, предоплата возвращается целиком (чек возврата), владельцу тревога.
//
// Две брони с предоплатой, удержание сокращено до 2 минут (настройка клуба на время создания):
// A — стол E2E_REVIEW_UNAV_TABLE_A (3): сервисный свет (ресепшн, с причиной) включён до подтверждения
//     брони и кончается через минуту после её начала: сервис идёт до конца (удержание брони его не
//     гасит, R2), после него стол синий до конца удержания;
// B — стол E2E_REVIEW_UNAV_TABLE_B (4): стол без связи всё окно удержания (симулятор net down).
// Тревога владельцу — на каждую бронь (R3): на столе A открыта тревога прошлых прогонов.
// Для сравнения T18 (01-t18) — стол доступен, удержание по правилам клуба.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  CLUB_A,
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
  waitSim,
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
  // Сервис кончается через минуту после начала брони (до конца удержания): после него стол — синий.
  const svcMinutes = Math.ceil((S.getTime() + MIN - Date.now()) / MIN);
  const sv = await api('POST', `/api/resources/${RES(TA)}/service`, { token: rec.token, body: { minutes: svcMinutes, reason_code: 'cleaning', reason_text: 'Уборка стола (тест e2e ревью)' } });
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

  // A: сервис идёт до своего конца, затем — синий до конца удержания.
  const svcEnd = new Date(sv.json.until);
  const svcMid = await sim(TA);
  await sleepUntil(new Date(svcEnd.getTime() - 3000));
  const svcLate = await sim(TA);
  const blueAfter = await waitSim(TA, (x) => x.state.mode === 'reserved', { timeoutMs: 25_000, what: 'синий после сервиса' }).catch(() => null);
  t.diagnostic(`стол ${TA}: сервис до ${hhmm(svcEnd)}; перед концом сервиса ${svcLate.state.mode}/${svcLate.state.led}; после сервиса ${blueAfter ? `${blueAfter.state.mode}/${blueAfter.state.led}` : 'синего нет'} (удержание до ${hhmm(a.hold_until)})`);
  const blueOk = svcMid.state.mode === 'service' && svcLate.state.mode === 'service' && Boolean(blueAfter);
  serviceOn = false;
  const ea = await waitBooking(ga.token, a.id, (x) => x.status === 'expired', { timeoutMs: 4 * MIN, what: 'бронь A закрыта' });
  const eb = await waitBooking(gb.token, b.id, (x) => x.status === 'expired', { timeoutMs: 2 * MIN, what: 'бронь B закрыта' });
  await simPost(TB, 'net', { up: true });
  netDown = false;
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
  // R3: тревога на каждую бронь (на столе A уже есть открытая тревога прошлых прогонов — склеиваться нельзя).
  const { rows: alarms } = await db.query(
    "select id, level, resource_id, count, data, raised_at from bl.alarms where club_id = $1 and type = 'booking_table_unavailable' and data->>'booking_id' = any($2::text[])",
    [CLUB_A, [a.id, b.id]],
  );
  const { rows: older } = await db.query("select count(*)::int as n from bl.alarms where type = 'booking_table_unavailable' and resource_id = $1 and acked_at is null and raised_at < $2", [RES(TA), since]);
  const owner = (await notificationsOf(db, OWNER_ID, { kind: 'alarm', since })).filter((n) => /недоступ/i.test(n.text));
  t.diagnostic(`тревоги: ${JSON.stringify(alarms.map((x) => [x.level, x.data?.booking_id?.slice(0, 8), x.data?.why, x.count]))}; открытых тревог прошлых броней стола ${TA}: ${older[0].n}; владельцу: ${owner.map((n) => `«${n.text}»`).join(' | ')}`);
  if (alarms.length !== 2) problems.push(`тревог по броням ${alarms.length} из 2`);
  if (owner.length < 2) problems.push(`тревог владельцу ${owner.length} из 2`);
  if (!svcOk) problems.push('A: сервисный свет погашен удержанием брони / контроллер отклонял команды');
  if (!blueOk) problems.push('A: сервис не дошёл до конца или после него стол не синий');
  assert.deepEqual(problems, [], 'стол недоступен → полный возврат; сервисный свет не трогается');
});
