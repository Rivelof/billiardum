// T18. Бронь с предоплатой, гость не пришёл (decisions №107, №108; контракт M3 §1 п. 4–5).
//
// A (стол E2E_T18_TABLE, по умолчанию 2), удержание по правилам клуба — 30 минут, удержание
//   предоплаты 100 % (настройка клуба по умолчанию): бронь на 60 минут с началом через 16–21
//   минуту, предоплата СБП в эмуляторе ЮKassa → confirmed; за 15 минут до начала — reserved,
//   симулятор синий (state.reserved с записью в журнале); в начало+29 мин бронь ещё ждёт; к
//   начало+30 мин — expired (no_show), стол зелёный (state.free), предоплата удержана: платёж
//   forfeited, чек зачёта на всю сумму ушёл в ЮKassa (/v3/receipts, settlements prepayment),
//   возврата нет; журнал booking.reserve, booking.expire, payment.forfeited; гостю — booking.expired.
// B (стол E2E_T18_TABLE_B, по умолчанию 3), booking_forfeit_percent = 30 и удержание 2 минуты
//   (иначе ещё 30 минут ожидания): бронь сгорает — удержано 30 % (чек зачёта), 70 % возвращено
//   через ЮKassa с чеком возврата; старт после сгорания — 409 booking_expired.
// Правила брони клуба на время файла: шаг 5 минут, без упреждения (helpers.FAST_BOOKING).
// Длительность ~55 минут (A ждёт удержание целиком).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  auditOf,
  bookingRow,
  cancelLeftovers,
  cmdsWithAudit,
  createBooking,
  emuPayment,
  emuReceipts,
  FAST_BOOKING,
  getBooking,
  hhmm,
  MIN,
  newGuest,
  notificationsOf,
  ok,
  patchClubSettings,
  payBooking,
  paymentRow,
  receiptsOf,
  refundsOf,
  restoreClubSettings,
  restoreForfeitPercent,
  setForfeitPercent,
  sim,
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

const TA = Number(process.env.E2E_T18_TABLE || 2);
const TB = Number(process.env.E2E_T18_TABLE_B || 3);
let db;
let man;
const A = {};

before(async () => {
  db = await adminClient();
  man = await staff('manager');
  await restoreForfeitPercent(db);
  await restoreClubSettings(db);
  await cancelLeftovers(db, man, [TA, TB], (m) => console.log(m));
  await waitTableFree(TA);
  await waitTableFree(TB);
  await patchClubSettings(db, { ...FAST_BOOKING, booking_prepayment: 'full' });
  // A создаётся сразу: её 15 минут до reserved идут, пока проверяется B.
  A.t0 = new Date();
  A.guest = await newGuest();
  A.startsAt = slotAfter(16 * MIN + 30_000);
  const r = await createBooking(A.guest.token, { table: TA, startsAt: A.startsAt, minutes: 60 });
  assert.equal(r.status, 201, r.text);
  A.created = r.json;
  A.paid = await payBooking(A.guest, A.created.id);
  A.simAtCreate = await sim(TA);
  A.rowAtCreate = await bookingRow(db, A.created.id);
});

after(async () => {
  await restoreForfeitPercent(db);
  await restoreClubSettings(db);
  await db?.end();
});

test(`T18 B: удержание 30 % — 70 % возвращено с чеком возврата (стол ${TB})`, { timeout: 20 * MIN }, async (t) => {
  const t0 = new Date();
  await setForfeitPercent(db, 30);
  await patchClubSettings(db, { booking_hold_prepaid_minutes: 2 });
  const guest = await newGuest();
  const startsAt = slotAfter(60_000);
  let created;
  try {
    const r = await createBooking(guest.token, { table: TB, startsAt, minutes: 15 });
    assert.equal(r.status, 201, r.text);
    created = r.json;
  } finally {
    await patchClubSettings(db, { booking_hold_prepaid_minutes: 30 });
  }
  t.diagnostic(`бронь ${created.id.slice(0, 8)}: ${hhmm(created.starts_at)}–${hhmm(created.ends_at)}, ${created.status}, предоплата ${created.prepayment_kopecks} коп., удержание до ${hhmm(created.hold_until)}`);
  assert.equal(created.status, 'pending_payment');
  assert.equal(created.prepayment_mode, 'full');
  assert.equal(created.prepayment_kopecks, created.amount_kopecks);
  const { pid, booking } = await payBooking(guest, created.id);
  const pay = await paymentRow(db, booking.payment_id);
  t.diagnostic(`предоплата: платёж ${pay.id.slice(0, 8)} kind=${pay.kind} ${pay.status} ${pay.amount_kopecks} коп.; ЮKassa ${pid}`);
  assert.equal(pay.kind, 'booking');
  assert.equal(pay.status, 'succeeded');
  const ep = emuPayment(pid);
  const modes = (ep.receipt?.items ?? []).map((i) => i.payment_mode);
  t.diagnostic(`чек оплаты в эмуляторе: признаки ${JSON.stringify(modes)}`);
  assert.deepEqual([...new Set(modes)], ['full_prepayment']);

  const reserved = await waitBooking(guest.token, created.id, (b) => b.status === 'reserved', { timeoutMs: 40_000, what: 'бронь B reserved' });
  const blue = await waitSim(TB, (s) => s.state?.mode === 'reserved', { timeoutMs: 15_000, what: `стол ${TB} синий` });
  t.diagnostic(`reserved: ${reserved.status}, симулятор ${blue.state.mode}/${blue.state.led}`);
  const expired = await waitBooking(guest.token, created.id, (b) => b.status === 'expired', {
    timeoutMs: Math.max(60_000, new Date(created.hold_until).getTime() - Date.now() + 60_000),
    what: 'бронь B expired',
  });
  const row = await bookingRow(db, created.id);
  t.diagnostic(`expired в ${hhmm(row.expired_at)} (удержание до ${hhmm(created.hold_until)}), причина ${expired.expire_reason}, forfeit_percent ${row.forfeit_percent}`);
  assert.equal(expired.expire_reason, 'no_show');
  assert.ok(new Date(row.expired_at) >= new Date(created.hold_until), 'не раньше конца удержания');
  assert.equal(row.forfeit_percent, 30);

  const paid = pay.amount_kopecks * 1;
  const kept = Math.floor((paid * 30 * 2 + 100) / 200);
  const back = paid - kept;
  const after = await waitFor(async () => {
    const p = await paymentRow(db, pay.id);
    return p.settlement_status === 'forfeited' ? p : null;
  }, { timeoutMs: 20_000, what: 'платёж forfeited' });
  assert.equal(Number(after.settled_kopecks), kept, 'удержано 30 %');
  const refunds = await refundsOf(db, pay.id);
  t.diagnostic(`удержано ${after.settled_kopecks} коп. (ждали ${kept}), возвраты ${JSON.stringify(refunds.map((r) => [r.amount_kopecks, r.status]))}`);
  assert.equal(refunds.length, 1);
  assert.equal(Number(refunds[0].amount_kopecks), back, 'возвращено 70 %');
  const settle = await waitSettlementSent(db, pay.id);
  assert.equal(settle.length, 1);
  assert.equal(Number(settle[0].settlement_kopecks), kept);
  const er = emuReceipts(pid);
  t.diagnostic(`зачёт в ЮKassa: ${JSON.stringify(er.map((r) => ({ id: r.id, type: r.type, items: r.items?.map((i) => [i.amount?.value, i.payment_mode]), settlements: r.settlements })))}`);
  assert.ok(er.some((r) => r.settlements?.some((s) => s.type === 'prepayment' && Math.round(Number(s.amount.value) * 100) === kept)), 'чек зачёта на удержанное');
  const ep2 = emuPayment(pid);
  const refundReceipts = (ep2.receipts ?? []).filter((r) => r.kind === 'refund');
  t.diagnostic(`эмулятор: возвращено ${JSON.stringify(ep2.refunded_amount ?? null)}, чеки возврата ${JSON.stringify(refundReceipts.map((r) => r.receipt?.items?.map((i) => [i.amount?.value, i.payment_mode])))}`);
  assert.equal(Math.round(Number(ep2.refunded_amount?.value ?? 0) * 100), back);
  assert.ok(refundReceipts.length >= 1, 'чек возврата в ЮKassa');

  const free = await waitSim(TB, (s) => s.state?.mode === 'free', { timeoutMs: 15_000, what: `стол ${TB} снова свободен` });
  t.diagnostic(`симулятор после сгорания: ${free.state.mode}/${free.state.led}`);
  const tbl = await ok(api('GET', `/api/t/${tableCode(TB)}`));
  assert.equal(tbl.status, 'free');
  const start = await api('POST', `/api/bookings/${created.id}/start`, { token: guest.token, body: { code: tableCode(TB) } });
  t.diagnostic(`старт после сгорания: ${start.status} ${start.text}`);
  assert.equal(start.status, 409);
  assert.equal(start.json.error, 'booking_expired');

  const au = (await auditOf(db, created.id)).map((r) => r.action);
  t.diagnostic(`журнал брони: ${au.join(', ')}`);
  for (const a of ['booking.create', 'booking.confirm', 'booking.reserve', 'booking.expire', 'payment.forfeited']) assert.ok(au.includes(a), a);
  const { cmds, missing } = await cmdsWithAudit(db, TB, t0);
  t.diagnostic(`команды стола ${TB}: ${cmds.map((c) => `${c.type}:${c.status}`).join(', ')}; без журнала ${missing.length}`);
  assert.ok(cmds.some((c) => c.type === 'state.reserved'));
  // state.free не обязателен: удержание на контроллере (until_ms) кончается вместе с бронью, он гаснет сам.
  assert.deepEqual(missing, []);
  const notes = await notificationsOf(db, guest.user.id, { kind: 'booking.expired' });
  t.diagnostic(`уведомление гостю: ${notes.map((n) => `${n.kind}/${n.status}: «${n.text}»`).join(' | ')}`);
  assert.equal(notes.length, 1);
  await restoreForfeitPercent(db);
});

test(`T18 A: reserved за 15 минут, удержание 30 минут, предоплата удержана 100 % (стол ${TA})`, { timeout: 70 * MIN }, async (t) => {
  const c = A.created;
  t.diagnostic(`бронь ${c.id.slice(0, 8)}: создана ${hhmm(A.t0)}, начало ${hhmm(c.starts_at)}, удержание до ${hhmm(c.hold_until)}, предоплата ${c.prepayment_kopecks} коп.; при создании стол ${A.simAtCreate.state.mode}`);
  assert.equal(new Date(c.hold_until) - new Date(c.starts_at), 30 * MIN, 'удержание с предоплатой — 30 минут');
  assert.equal(A.simAtCreate.state.mode, 'free', 'раньше чем за 15 минут стол не синий');
  const pay = await paymentRow(db, A.paid.booking.payment_id);
  assert.equal(pay.status, 'succeeded');
  assert.equal(A.rowAtCreate.reserved_at, null, 'раньше чем за 15 минут не reserved');
  assert.equal(A.rowAtCreate.status, 'confirmed');

  const start = new Date(c.starts_at).getTime();
  await sleepUntil(new Date(start - 15 * MIN + 25_000), (m) => t.diagnostic(m));
  const b1 = await waitBooking(A.guest.token, c.id, (b) => b.status === 'reserved', { timeoutMs: 30_000, what: 'бронь A reserved' });
  const row1 = await bookingRow(db, c.id);
  const lead = (start - new Date(row1.reserved_at).getTime()) / 1000;
  const blue = await waitSim(TA, (s) => s.state?.mode === 'reserved', { timeoutMs: 15_000, what: `стол ${TA} синий` });
  const tbl = await ok(api('GET', `/api/t/${tableCode(TA)}`));
  t.diagnostic(`reserved в ${hhmm(row1.reserved_at)} — за ${lead} с до начала; симулятор ${blue.state.mode}/${blue.state.led}; GET /api/t: ${tbl.status} до ${tbl.busy_until}`);
  assert.equal(b1.status, 'reserved');
  assert.ok(lead <= 15 * 60 && lead >= 15 * 60 - 25, `reserved за 15 минут (±тик планировщика), было ${lead} с`);
  assert.equal(blue.state.led, 'blue');
  assert.equal(tbl.status, 'reserved');
  // Чужой гость не может занять синий стол.
  const other = await newGuest();
  const q = await api('POST', '/api/quotes', { token: other.token, body: { resource_id: c.resource.id, kind: 'start', minutes: 30 } });
  t.diagnostic(`чужой гость на синем столе: котировка ${q.status} ${q.text.slice(0, 120)}`);
  assert.notEqual(q.status, 200);

  await sleepUntil(new Date(start + 29 * MIN), (m) => t.diagnostic(m));
  const b2 = await ok(getBooking(A.guest.token, c.id));
  const s2 = await sim(TA);
  t.diagnostic(`начало+29 мин: бронь ${b2.status}, стол ${s2.state.mode}`);
  assert.equal(b2.status, 'reserved', 'удержание ещё идёт');
  assert.equal(s2.state.mode, 'reserved');

  const b3 = await waitBooking(A.guest.token, c.id, (b) => b.status === 'expired', { timeoutMs: 3 * MIN, what: 'бронь A expired' });
  const row3 = await bookingRow(db, c.id);
  const late = (new Date(row3.expired_at).getTime() - start) / 1000;
  t.diagnostic(`expired в ${hhmm(row3.expired_at)} — через ${late} с после начала; причина ${b3.expire_reason}; forfeit ${row3.forfeit_percent} %`);
  assert.equal(b3.expire_reason, 'no_show');
  assert.ok(late >= 30 * 60 && late <= 30 * 60 + 25, `сгорает через 30 минут (±тик), было ${late} с`);
  assert.equal(row3.forfeit_percent, 100);
  const green = await waitSim(TA, (s) => s.state?.mode === 'free', { timeoutMs: 15_000, what: `стол ${TA} свободен` });
  t.diagnostic(`симулятор после сгорания: ${green.state.mode}/${green.state.led}`);

  const p = await waitFor(async () => {
    const x = await paymentRow(db, pay.id);
    return x.settlement_status === 'forfeited' ? x : null;
  }, { timeoutMs: 20_000, what: 'платёж forfeited' });
  assert.equal(Number(p.settled_kopecks), Number(pay.amount_kopecks), 'удержано 100 %');
  const refunds = await refundsOf(db, pay.id);
  assert.deepEqual(refunds, [], 'при 100 % возврата нет');
  const settle = await waitSettlementSent(db, pay.id);
  const er = emuReceipts(A.paid.pid);
  t.diagnostic(`чек зачёта: ${settle.map((r) => `${r.settlement_kopecks} коп. ${r.status} ${r.provider_receipt_id}`).join(', ')}; в эмуляторе ${JSON.stringify(er.map((r) => ({ items: r.items?.map((i) => [i.description, i.amount?.value, i.payment_mode]), settlements: r.settlements })))}`);
  assert.equal(settle.length, 1);
  assert.equal(Number(settle[0].settlement_kopecks), Number(pay.amount_kopecks));
  assert.ok(er.some((r) => r.items?.every((i) => i.payment_mode === 'full_payment') && r.settlements?.[0]?.type === 'prepayment'));
  const all = await receiptsOf(db, pay.id);
  t.diagnostic(`чеки платежа: ${all.map((r) => `${r.kind}/${r.channel}/${r.status}/${r.amount_kopecks}${r.settles_payment_id ? ' зачёт' : ''}`).join(', ')}`);

  const au = (await auditOf(db, c.id)).map((r) => `${r.action}@${hhmm(r.created_at)}`);
  t.diagnostic(`журнал брони: ${au.join(', ')}`);
  for (const a of ['booking.create', 'booking.confirm', 'booking.reserve', 'booking.expire', 'payment.forfeited']) assert.ok(au.some((x) => x.startsWith(`${a}@`)), a);
  const { cmds, missing } = await cmdsWithAudit(db, TA, A.t0);
  t.diagnostic(`команды стола ${TA}: ${cmds.map((x) => `${x.type}:${x.status}@${hhmm(x.created_at)}`).join(', ')}; без журнала ${missing.length}`);
  assert.ok(cmds.some((x) => x.type === 'state.reserved'));
  assert.deepEqual(missing, []);
  const notes = await notificationsOf(db, A.guest.user.id);
  t.diagnostic(`уведомления гостю: ${notes.map((n) => `${n.kind}/${n.status}`).join(', ')}; booking.expired: «${notes.find((n) => n.kind === 'booking.expired')?.text}»`);
  assert.ok(notes.some((n) => n.kind === 'booking.soon'), 'напоминание за 15 минут');
  assert.equal(notes.filter((n) => n.kind === 'booking.expired').length, 1);
});
