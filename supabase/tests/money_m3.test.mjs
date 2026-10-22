// Деньги M3 (контракт m3.md §1 п. 5, 10, 11; §3): лимит продления перед бронью (T19),
// предоплата брони → зачёт → сгорание, пакеты часов → баланс → списание, депозит наличными →
// возврат остатка, смена сходится. Настоящий Postgres и эмулятор ЮKassa; бронь, ККТ и старт
// по депозиту — заглушки по контракту §3 (money_harness.mjs).

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { routes as quoteRoutes } from '../../api/routes/quotes.mjs';
import { routes as packageRoutes } from '../../api/routes/packages.mjs';
import { routes as receptionRoutes } from '../../api/routes/reception.mjs';
import { routes as webhookRoutes } from '../../api/routes/webhooks.mjs';
import { createBookingQuote, createPrepayment, creditPackageForSale, revokeLotOnly, revokePackageLot, debitBalance, forfeitPrepayment, packageSaleLine, recordOfflinePayment, settleDeposit, settlePrepayment } from '../../server/payments/api.mjs';
import { resolveDeps } from '../../server/payments/deps.mjs';
import { sendSettlementReceipt, SETTLE_TOPIC } from '../../server/payments/settle.mjs';
import { cashTotals } from '../../server/shifts/service.mjs';
import { withContext } from '../../server/lib/store.mjs';
import { CLUB_A, GUEST_1, GUEST_2, newKey, OWNER_A, RECEPTION_A, setupMoney } from './money_harness.mjs';

const route = (list, method, path) => list.find((r) => r.method === method && r.path === path);
const QUOTE = route(quoteRoutes, 'POST', '/api/quotes');
const PAY = route(quoteRoutes, 'POST', '/api/quotes/{id}/pay');
const LIST_PKG = route(packageRoutes, 'GET', '/api/clubs/{club}/packages');
const CREATE_PKG = route(packageRoutes, 'POST', '/api/clubs/{club}/packages');
const ARCHIVE_PKG = route(packageRoutes, 'POST', '/api/packages/{id}/archive');
const BUY_PKG = route(packageRoutes, 'POST', '/api/packages/{id}/buy');
const BALANCE = route(packageRoutes, 'GET', '/api/clubs/{club}/balance');
const REFUND_LOT = route(packageRoutes, 'POST', '/api/packages/lots/{id}/refund');
const DEPOSIT = route(receptionRoutes, 'POST', '/api/reception/deposits');
const WEBHOOK = route(webhookRoutes, 'POST', '/api/webhooks/yookassa/{club_id}');

// Вторник 20.10.2026, 13:00 в Екатеринбурге (08:00Z): 500 ₽/ч до 17:00.
const START = '2026-10-20T08:00:00.000Z';
const T = (n) => `e1000000-0000-4000-8000-00000000000${n}`;

const asAppApi = (pool, c, fn) =>
  withContext(pool, c, async (db) => {
    await db.query('set local role app_api');
    return fn(db);
  });

let h;
let deps;
const bookings = new Map(); // resourceId → Date начала ближайшей брони
const kktCalls = [];

before(async () => {
  h = await setupMoney({ start: START });
  h.setWebhookRoute(WEBHOOK);
  // Заглушка брони (§3): nextBookingStart — ближайшая бронь стола не раньше after.
  h.ctx.bookingsApi = {
    async nextBookingStart(_db, { resourceId, after }) {
      const b = bookings.get(resourceId);
      return b && b.getTime() >= new Date(after).getTime() ? b : null;
    },
  };
  // Заглушка ККТ (M2 §5 + зачёт): задание — строка bl.receipts channel kkt.
  h.ctx.kktApi = {
    async enqueueReceipt(db, a) {
      kktCalls.push(a);
      const amount = a.payments.reduce((s, p) => s + p.amount_kopecks, 0);
      const { rows } = await db.query(
        `insert into bl.receipts (club_id, payment_id, refund_id, kind, channel, status, amount_kopecks, items, settles_payment_id, settlement_kopecks, created_at, updated_at)
         values ($1, $2, $3, $4, 'kkt', 'receipt_pending', $5, $6::jsonb, $8, $9, $7, $7) returning id`,
        [a.clubId, a.paymentId ?? null, a.refundId ?? null, a.kind === 'sell' ? 'sale' : 'refund', amount, JSON.stringify(a.lines), a.now ?? new Date(), a.settlesPaymentId ?? null, a.settlesPaymentId ? a.settlementKopecks : null],
      );
      return rows[0].id;
    },
  };
  // Старт по депозиту (light §3): сессия «Без лимита», paid_until — 2 часа (для теста).
  h.sessions.startFromDeposit = async (db, { resourceId, userId, staffId, depositKopecks }) => {
    const now = h.clock.now();
    const paidUntil = new Date(now.getTime() + 120 * 60_000);
    const { rows } = await db.query(
      `insert into bl.sessions (club_id, resource_id, status, source, payer_user_id, unlimited, started_at, paid_until, deposit_kopecks, created_at, updated_at)
       values (bl.ctx_club_id(), $1, 'active', 'reception', $2, true, $3, $4, $5, $3, $3) returning id`,
      [resourceId, userId ?? staffId, now, paidUntil, depositKopecks],
    );
    return { session_id: rows[0].id, paid_until: paidUntil.toISOString(), minutes: 120 };
  };
  deps = await resolveDeps(h.ctx);
});

after(async () => {
  await h?.close();
});

const inj = () => ({ deps, config: h.config });
const asClub = (fn, userId = null) => h.tx({ clubId: CLUB_A, userId, actorType: userId ? 'user' : 'system' }, fn);
const payment = async (id) => (await h.q('select * from bl.payments where id = $1', [id]))[0];

async function emuSucceed(paymentId) {
  const p = await payment(paymentId);
  await fetch(`${h.emuBase}/__emu/payments/${p.provider_payment_id}/succeed?wait=1`, { method: 'POST' });
  await h.emu.settle();
  return p.provider_payment_id;
}

/** Обработать события money.receipt_settle (как outbox core). */
async function drainSettlements() {
  const rows = await h.q('select id, payload from bl.outbox where topic = $1 and processed_at is null order by id', [SETTLE_TOPIC]);
  const out = [];
  for (const r of rows) {
    out.push(await asAppApi(h.pool, { clubId: r.payload.club_id, actorType: 'system' }, (db) => sendSettlementReceipt(db, deps, h.config, r.payload)));
    await h.pool.query('update bl.outbox set processed_at = now() where id = $1', [r.id]);
  }
  return out;
}

async function session(resourceId, { paidUntil, unlimited = false, participants = [GUEST_1] } = {}) {
  const { rows } = await h.pool.query(
    `insert into bl.sessions (club_id, resource_id, status, payer_user_id, unlimited, started_at, paid_until, created_at, updated_at)
     values ($1, $2, 'active', $3, $4, $5, $6, $5, $5) returning id`,
    [CLUB_A, resourceId, participants[0], unlimited, START, paidUntil],
  );
  const id = rows[0].id;
  h.sessions.sessions.set(id, { id, resource_id: resourceId, paid_until: new Date(paidUntil), status: 'active', participants: new Set(participants), payer: participants[0], unlimited });
  return id;
}

describe('T19: продление перед бронью (№106)', () => {
  it('продление упирается в бронь: до начала минус 5 минут, больше — booking_conflict', async () => {
    const t = T(1);
    bookings.set(t, new Date('2026-10-20T09:30:00Z')); // бронь 14:30 местного
    const sid = await session(t, { paidUntil: '2026-10-20T08:30:00Z' }); // оплачено до 13:30
    const ok = await h.call(QUOTE, { user: GUEST_1, body: { resource_id: t, kind: 'extend', minutes: 30, session_id: sid } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.extend_limit_until, '2026-10-20T09:25:00.000Z');
    const bad = await h.call(QUOTE, { user: GUEST_1, body: { resource_id: t, kind: 'extend', minutes: 60, session_id: sid } });
    assert.equal(bad.status, 409);
    assert.deepEqual(bad.json, { error: 'booking_conflict' });
  });

  it('старт перед бронью: час можно, два — нет; «Без лимита» заморожено только до брони; бронь через 4 минуты — конфликт', async () => {
    const t = T(2);
    bookings.set(t, new Date('2026-10-20T09:30:00Z'));
    h.sessions.holds.delete(t);
    assert.equal((await h.call(QUOTE, { user: GUEST_2, body: { resource_id: t, kind: 'start', minutes: 120 } })).json.error, 'booking_conflict');
    const one = await h.call(QUOTE, { user: GUEST_2, body: { resource_id: t, kind: 'start', minutes: 60 } });
    assert.equal(one.status, 200);
    assert.equal(one.json.extend_limit_until, '2026-10-20T09:25:00.000Z');
    const unl = await h.call(QUOTE, { user: GUEST_2, body: { resource_id: t, kind: 'start', minutes: null } });
    assert.equal(unl.json.unlimited.hold_minutes, 85);
    bookings.set(t, new Date('2026-10-20T08:04:00Z'));
    assert.equal((await h.call(QUOTE, { user: GUEST_2, body: { resource_id: t, kind: 'start', minutes: 60 } })).json.error, 'booking_conflict');
    bookings.delete(t);
    assert.equal((await h.call(QUOTE, { user: GUEST_2, body: { resource_id: t, kind: 'start', minutes: 120 } })).json.extend_limit_until, null);
  });
});

describe('предоплата брони (№108): чек предоплаты → зачёт или сгорание', () => {
  async function prepaid(bookingId, amount = 100000) {
    const r = await asClub((db) => createPrepayment(db, { clubId: CLUB_A, bookingId, resourceId: T(3), userId: GUEST_1, amountKopecks: amount, method: 'card' }, inj()), GUEST_1);
    await emuSucceed(r.payment.id);
    return r.payment.id;
  }

  it('предоплата: чек full_prepayment; вебхук → payment.confirmed kind booking с booking_id; зачёт при старте — чек /v3/receipts', async () => {
    const bookingId = newKey();
    const r = await asClub((db) => createPrepayment(db, { clubId: CLUB_A, bookingId, resourceId: T(3), userId: GUEST_1, amountKopecks: 100000 }, inj()), GUEST_1);
    assert.equal(r.confirmation.type, 'redirect');
    const p0 = await payment(r.payment.id);
    assert.deepEqual({ k: p0.kind, b: p0.booking_id, s: p0.settlement_status }, { k: 'booking', b: bookingId, s: 'open' });
    const emuP = await (await fetch(`${h.emuBase}/__emu/payments/${p0.provider_payment_id}`)).json();
    assert.equal(emuP.receipt.items[0].payment_mode, 'full_prepayment');
    assert.equal(emuP.metadata.booking_id, bookingId);
    // Повтор — тот же платёж.
    const again = await asClub((db) => createPrepayment(db, { clubId: CLUB_A, bookingId, resourceId: T(3), userId: GUEST_1, amountKopecks: 100000 }, inj()), GUEST_1);
    assert.equal(again.payment.id, p0.id);
    await emuSucceed(p0.id);
    const ev = (await h.outbox('payment.confirmed')).filter((e) => e.payload.payment_id === p0.id);
    assert.equal(ev.length, 1);
    assert.deepEqual({ k: ev[0].payload.kind, b: ev[0].payload.booking_id }, { k: 'booking', b: bookingId });

    const sid = await session(T(3), { paidUntil: '2026-10-20T10:00:00Z' });
    const s1 = await asClub((db) => settlePrepayment(db, { paymentId: p0.id, sessionId: sid }, inj()));
    assert.equal(s1.settled_kopecks, 100000);
    const s2 = await asClub((db) => settlePrepayment(db, { paymentId: p0.id, sessionId: sid }, inj()));
    assert.equal(s2.receipt_id, s1.receipt_id, 'повтор — тот же чек');
    const sent = await drainSettlements();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].result, 'succeeded');
    const rec = (await h.q('select * from bl.receipts where id = $1', [s1.receipt_id]))[0];
    assert.deepEqual({ st: rec.status, c: rec.channel, sp: rec.settles_payment_id, k: Number(rec.settlement_kopecks) }, { st: 'succeeded', c: 'yookassa', sp: p0.id, k: 100000 });
    const emuR = (await (await fetch(`${h.emuBase}/__emu/receipts`)).json()).find((x) => x.id === rec.provider_receipt_id);
    assert.equal(emuR.payment_id, p0.provider_payment_id);
    assert.deepEqual(emuR.settlements, [{ type: 'prepayment', amount: { value: '1000.00', currency: 'RUB' } }]);
    assert.equal(emuR.items[0].payment_mode, 'full_payment');
    const p1 = await payment(p0.id);
    assert.deepEqual({ s: p1.settlement_status, sess: p1.session_id }, { s: 'settled', sess: sid });
    await assert.rejects(asClub((db) => forfeitPrepayment(db, { paymentId: p0.id, reason: 'неявка' }, inj())), (e) => e.code === 'bad_request');
  });

  it('сгорание по умолчанию: удержано 100 %, чек зачёта на удержанное, без возврата', async () => {
    const pid = await prepaid(newKey(), 80000);
    const r = await asClub((db) => forfeitPrepayment(db, { paymentId: pid, reason: 'Гость не пришёл, удержание 30 минут истекло' }, inj()));
    assert.deepEqual(r, { kept_kopecks: 80000, refunded_kopecks: 0, refund_id: null });
    assert.equal((await payment(pid)).settlement_status, 'forfeited');
    await drainSettlements();
    const rec = (await h.q('select * from bl.receipts where settles_payment_id = $1', [pid]))[0];
    assert.equal(rec.status, 'succeeded');
    assert.match(rec.items[0].description, /удержание/);
    const audit = (await h.audit('payment.forfeited')).filter((a) => a.object_id === pid);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].reason, 'Гость не пришёл, удержание 30 минут истекло');
    // Повтор — тот же итог.
    assert.deepEqual(await asClub((db) => forfeitPrepayment(db, { paymentId: pid, reason: 'повтор' }, inj())), r);
  });

  it('сгорание с долей 30 %: 70 % возвращено с чеком возврата предоплаты, 30 % — чек зачёта', async () => {
    const pid = await prepaid(newKey(), 100000);
    const r = await asClub((db) => forfeitPrepayment(db, { paymentId: pid, percent: 30, reason: 'Отмена менее чем за час' }, inj()));
    assert.equal(r.kept_kopecks, 30000);
    assert.equal(r.refunded_kopecks, 70000);
    const p = await payment(pid);
    const emuP = await (await fetch(`${h.emuBase}/__emu/payments/${p.provider_payment_id}`)).json();
    const refundReceipt = emuP.receipts.find((x) => x.kind === 'refund');
    assert.equal(refundReceipt.receipt.items[0].payment_mode, 'full_prepayment');
    assert.equal(refundReceipt.amount_kopecks, 70000);
    await drainSettlements();
    const settle = emuP.receipts.length; // до отправки зачёта
    const after = await (await fetch(`${h.emuBase}/__emu/payments/${p.provider_payment_id}`)).json();
    assert.equal(after.receipts.length, settle + 1);
    assert.equal(after.receipts.at(-1).amount_kopecks, 30000);
    assert.equal((await h.outbox('payment.refunded')).filter((e) => e.payload.payment_id === pid).length, 1);
  });

  it('клуб с настройкой 0 %: вся предоплата возвращается', async () => {
    await h.pool.query('update bl.club_payment_settings set booking_forfeit_percent = 0 where club_id = $1', [CLUB_A]);
    try {
      const pid = await prepaid(newKey(), 50000);
      const r = await asClub((db) => forfeitPrepayment(db, { paymentId: pid, reason: 'Отмена заранее' }, inj()));
      assert.deepEqual({ k: r.kept_kopecks, b: r.refunded_kopecks }, { k: 0, b: 50000 });
      assert.equal((await h.q('select count(*)::int as n from bl.receipts where settles_payment_id = $1', [pid]))[0].n, 0);
    } finally {
      await h.pool.query('update bl.club_payment_settings set booking_forfeit_percent = 100 where club_id = $1', [CLUB_A]);
    }
  });
});

describe('старт по брони: котировка доплаты и попытки предоплаты (№113, №116)', () => {
  it('котировка booking_start: сумма не больше тарифа (опоздавший платит с прихода до конца), оплата → payment.confirmed booking_start', async () => {
    const bookingId = newKey();
    // Бронь 13:00–15:00 без предоплаты, гость пришёл в 14:00: осталось 60 минут — 500 ₽, хоть бронь и просила 1000 ₽.
    const q = await asClub(
      (db) => createBookingQuote(db, { clubId: CLUB_A, bookingId, resourceId: T(6), userId: GUEST_2, from: new Date('2026-10-20T09:00:00Z'), minutes: 60, amountKopecks: 100000, earlyMinutes: 0 }, inj()),
      GUEST_2,
    );
    assert.deepEqual({ a: q.amount_kopecks, t: q.tariff_kopecks, m: q.minutes }, { a: 50000, t: 50000, m: 60 });
    // Остаток после частичной предоплаты меньше тарифа — как есть.
    const part = await asClub((db) => createBookingQuote(db, { clubId: CLUB_A, bookingId, resourceId: T(6), userId: GUEST_2, from: new Date(START), minutes: 120, amountKopecks: 30000 }, inj()), GUEST_2);
    assert.equal(part.amount_kopecks, 30000);
    assert.equal((await h.call(PAY, { user: GUEST_2, params: { id: q.quote_id }, body: { method: 'reception' }, idempotencyKey: newKey() })).json.error, 'bad_request');
    const r = await h.call(PAY, { user: GUEST_2, params: { id: q.quote_id }, body: { method: 'sbp' }, idempotencyKey: newKey() });
    assert.equal(r.status, 200);
    const p = await payment(r.json.payment_id);
    assert.deepEqual({ k: p.kind, b: p.booking_id, a: Number(p.amount_kopecks), s: p.settlement_status }, { k: 'booking_start', b: bookingId, a: 50000, s: null });
    await emuSucceed(p.id);
    const ev = (await h.outbox('payment.confirmed')).filter((e) => e.payload.payment_id === p.id);
    assert.equal(ev.length, 1);
    assert.deepEqual({ k: ev[0].payload.kind, q: ev[0].payload.quote_id, b: ev[0].payload.booking_id }, { k: 'booking_start', q: q.quote_id, b: bookingId });
    await assert.rejects(asClub((db) => createBookingQuote(db, { clubId: CLUB_A, bookingId, resourceId: T(6), userId: GUEST_2, from: new Date(START), minutes: 0, amountKopecks: 1 }, inj())), (e) => e.code === 'bad_request');
  });

  it('предоплата: брошенная попытка не мешает новой с другой суммой; та же сумма — та же попытка; оплачено — already_paid', async () => {
    const bookingId = newKey();
    const make = (amount, method = 'sbp') => asClub((db) => createPrepayment(db, { clubId: CLUB_A, bookingId, resourceId: T(3), userId: GUEST_1, amountKopecks: amount, method }, inj()), GUEST_1);
    const a = await make(100000);
    const b = await make(80000);
    assert.notEqual(b.payment.id, a.payment.id);
    assert.equal((await make(80000)).payment.id, b.payment.id);
    const c = await make(80000, 'card');
    assert.notEqual(c.payment.id, b.payment.id);
    await emuSucceed(b.payment.id);
    await assert.rejects(make(80000), (e) => e.code === 'already_paid');
    const keys = (await h.q('select idempotence_key from bl.payments where booking_id = $1 order by created_at, id', [bookingId])).map((x) => x.idempotence_key);
    assert.deepEqual(new Set(keys).size, 3);
  });
});

describe('пакеты часов и баланс (№112)', () => {
  let pkg;

  it('управляющий создаёт пакет с причиной (журнал, уведомление владельцу); гость видит его без входа', async () => {
    assert.equal((await h.call(CREATE_PKG, { user: OWNER_A, club: CLUB_A, params: { club: CLUB_A }, body: { title: '10 часов', hours: 10, price_kopecks: 300000, valid_days: 30 } })).json.error, 'reason_required');
    assert.equal((await h.call(CREATE_PKG, { user: GUEST_1, club: CLUB_A, params: { club: CLUB_A }, body: { title: '10 часов', hours: 10, price_kopecks: 300000, valid_days: 30, reason: 'x' } })).json.error, 'forbidden');
    const r = await h.call(CREATE_PKG, { user: OWNER_A, club: CLUB_A, params: { club: CLUB_A }, body: { title: '10 часов', hours: 10, price_kopecks: 300000, valid_days: 30, reason: 'Осенняя акция' } });
    assert.equal(r.status, 201);
    pkg = r.json;
    assert.deepEqual({ h: pkg.hours, m: pkg.minutes, p: pkg.price_kopecks }, { h: 10, m: 600, p: 300000 });
    assert.equal((await h.audit('tariff.package_created')).length, 1);
    assert.ok(h.notes.items.some((n) => n.kind === 'manual_action' && n.roles.includes('owner')));
    const list = await h.call(LIST_PKG, { params: { club: CLUB_A } });
    assert.deepEqual(list.json.map((x) => x.id), [pkg.id]);
  });

  it('покупка в приложении: чек full_prepayment, после оплаты — 600 минут на балансе на 30 дней', async () => {
    const key = newKey();
    const r = await h.call(BUY_PKG, { user: GUEST_1, params: { id: pkg.id }, body: { method: 'card' }, idempotencyKey: key });
    assert.equal(r.status, 200);
    const p = await payment(r.json.payment_id);
    assert.deepEqual({ k: p.kind, pk: p.package_id, res: p.resource_id }, { k: 'package', pk: pkg.id, res: null });
    const emuP = await (await fetch(`${h.emuBase}/__emu/payments/${p.provider_payment_id}`)).json();
    assert.equal(emuP.receipt.items[0].payment_mode, 'full_prepayment');
    assert.match(emuP.receipt.items[0].description, /Пакет «10 часов»: 10 ч на 30 дн\./);
    assert.equal((await h.call(BALANCE, { user: GUEST_1, club: CLUB_A, params: { club: CLUB_A } })).json.minutes, 0, 'до оплаты — ноль');
    await emuSucceed(p.id);
    const bal = (await h.call(BALANCE, { user: GUEST_1, club: CLUB_A, params: { club: CLUB_A } })).json;
    assert.equal(bal.minutes, 600);
    assert.equal(bal.lots[0].expires_at, new Date(Date.parse(START) + 30 * 86_400_000).toISOString());
    // Повтор вебхука — минуты не удваиваются.
    await fetch(`${h.emuBase}/__emu/payments/${p.provider_payment_id}/webhook?repeat=2`, { method: 'POST' });
    assert.equal((await h.call(BALANCE, { user: GUEST_1, club: CLUB_A, params: { club: CLUB_A } })).json.minutes, 600);
  });

  it('игра целиком балансом: котировка 0 ₽, способ balance, payment.confirmed, чек зачёта по платежу пакета', async () => {
    const t = T(4);
    h.sessions.holds.delete(t);
    const q = await h.call(QUOTE, { user: GUEST_1, body: { resource_id: t, kind: 'start', minutes: 60, use_balance: true } });
    assert.deepEqual({ a: q.json.amount_kopecks, b: q.json.balance_minutes, av: q.json.balance_available_minutes, m: q.json.minutes }, { a: 0, b: 60, av: 600, m: 60 });
    assert.equal((await h.call(PAY, { user: GUEST_1, params: { id: q.json.quote_id }, body: { method: 'card' }, idempotencyKey: newKey() })).json.error, 'bad_request');
    const r = await h.call(PAY, { user: GUEST_1, params: { id: q.json.quote_id }, body: { method: 'balance' }, idempotencyKey: newKey() });
    assert.equal(r.json.status, 'succeeded');
    const p = await payment(r.json.payment_id);
    assert.deepEqual({ pr: p.provider, m: p.method, a: Number(p.amount_kopecks), bm: p.balance_minutes }, { pr: 'balance', m: 'balance', a: 30000, bm: 60 });
    const ev = (await h.outbox('payment.confirmed')).find((e) => e.payload.payment_id === p.id);
    assert.deepEqual({ m: ev.payload.minutes, me: ev.payload.method, k: ev.payload.kind }, { m: 60, me: 'balance', k: 'start' });
    assert.equal((await h.call(BALANCE, { user: GUEST_1, club: CLUB_A, params: { club: CLUB_A } })).json.minutes, 540);
    await drainSettlements();
    const rec = (await h.q('select * from bl.receipts where payment_id = $1', [p.id]))[0];
    assert.equal(rec.status, 'succeeded');
    assert.equal(Number(rec.settlement_kopecks), 30000);
    assert.equal(rec.items[0].description, 'Игра, стол 4, 1 ч');
  });

  it('часть балансом, остаток картой: минуты резервируются, отказ гостя возвращает их', async () => {
    // У GUEST_1 540 минут: котировка 180 минут — 180 балансом; для остатка берём гостя 2 с пакетом на час.
    const small = await h.call(CREATE_PKG, { user: OWNER_A, club: CLUB_A, params: { club: CLUB_A }, body: { title: 'Час', hours: 1, price_kopecks: 40000, valid_days: 7, reason: 'Пробный пакет' } });
    const buy = await h.call(BUY_PKG, { user: GUEST_2, params: { id: small.json.id }, body: { method: 'sbp' }, idempotencyKey: newKey() });
    await emuSucceed(buy.json.payment_id);
    const t = T(5);
    h.sessions.holds.delete(t);
    const q = await h.call(QUOTE, { user: GUEST_2, body: { resource_id: t, kind: 'start', minutes: 120, use_balance: true } });
    assert.deepEqual({ a: q.json.amount_kopecks, b: q.json.balance_minutes }, { a: 50000, b: 60 });
    assert.equal(q.json.breakdown[0].from, '2026-10-20T09:00:00.000Z', 'доплата — за второй час');
    assert.equal((await h.call(PAY, { user: GUEST_2, params: { id: q.json.quote_id }, body: { method: 'reception' }, idempotencyKey: newKey() })).json.error, 'bad_request');
    const r = await h.call(PAY, { user: GUEST_2, params: { id: q.json.quote_id }, body: { method: 'sbp' }, idempotencyKey: newKey() });
    assert.equal(r.status, 200);
    assert.equal((await h.call(BALANCE, { user: GUEST_2, club: CLUB_A, params: { club: CLUB_A } })).json.minutes, 0, 'зарезервировано');
    const p = await payment(r.json.payment_id);
    assert.equal(p.balance_minutes, 60);
    await fetch(`${h.emuBase}/__emu/payments/${p.provider_payment_id}/cancel?wait=1`, { method: 'POST' });
    await h.emu.settle();
    assert.equal((await payment(p.id)).status, 'canceled');
    assert.equal((await h.call(BALANCE, { user: GUEST_2, club: CLUB_A, params: { club: CLUB_A } })).json.minutes, 60, 'минуты вернулись');
    assert.equal((await h.q('select count(*)::int as n from bl.receipts where payment_id = $1 and settles_payment_id is not null', [p.id]))[0].n, 0);
  });

  it('срок пакета истёк — баланса нет; списание сверх баланса — limit_exceeded', async () => {
    h.clock.advance(8 * 86_400_000);
    try {
      assert.equal((await h.call(BALANCE, { user: GUEST_2, club: CLUB_A, params: { club: CLUB_A } })).json.minutes, 0);
      const sid = await session(T(6), { paidUntil: '2026-10-28T10:00:00Z', participants: [GUEST_2] });
      await assert.rejects(asClub((db) => debitBalance(db, { clubId: CLUB_A, userId: GUEST_2, minutes: 30, sessionId: sid }, inj())), (e) => e.code === 'limit_exceeded');
    } finally {
      h.clock.advance(-8 * 86_400_000);
    }
  });

  it('debitBalance для соседей: платёж balance по сессии и чек зачёта', async () => {
    const sid = await session(T(7), { paidUntil: '2026-10-20T10:00:00Z' });
    const r = await asClub((db) => debitBalance(db, { clubId: CLUB_A, userId: GUEST_1, minutes: 30, sessionId: sid }, inj()));
    assert.equal(r.minutes, 30);
    assert.equal(r.value_kopecks, 15000);
    const p = await payment(r.payment_id);
    assert.deepEqual({ k: p.kind, s: p.session_id, st: p.status }, { k: 'extend', s: sid, st: 'succeeded' });
    assert.equal((await h.call(BALANCE, { user: GUEST_1, club: CLUB_A, params: { club: CLUB_A } })).json.minutes, 510);
  });

  it('касса pos: позиция пакета (предоплата 100 %) и начисление после оплаты продажи', async () => {
    const line = await asClub((db) => packageSaleLine(db, { packageId: pkg.id }), RECEPTION_A);
    assert.deepEqual({ m: line.line.payment_mode, a: line.amount_kopecks }, { m: 'full_prepayment', a: 300000 });
    const saleId = newKey();
    const pay = await asClub((db) => recordOfflinePayment(db, { clubId: CLUB_A, saleId, method: 'card_terminal', amountKopecks: 300000, staffId: RECEPTION_A }, inj()), RECEPTION_A);
    const lot = await asClub((db) => creditPackageForSale(db, { payment: pay, packageId: pkg.id, userId: GUEST_2 }, inj()), RECEPTION_A);
    const again = await asClub((db) => creditPackageForSale(db, { payment: pay, packageId: pkg.id, userId: GUEST_2 }, inj()), RECEPTION_A);
    assert.equal(again.id, lot.id);
    assert.equal((await h.call(BALANCE, { user: GUEST_2, club: CLUB_A, params: { club: CLUB_A } })).json.minutes, 660);
  });

  it('возврат пакета (№118): целиком и пока не тронут; тронутый — package_used; повтор — already_refunded; кассовый — только отзыв партии', async () => {
    const buy = await h.call(BUY_PKG, { user: GUEST_2, params: { id: pkg.id }, body: { method: 'card' }, idempotencyKey: newKey() });
    await emuSucceed(buy.json.payment_id);
    const lot = (await h.q('select * from bl.balance_lots where payment_id = $1', [buy.json.payment_id]))[0];
    const before = (await h.call(BALANCE, { user: GUEST_2, club: CLUB_A, params: { club: CLUB_A } })).json.minutes;
    assert.equal((await h.call(REFUND_LOT, { user: OWNER_A, params: { id: lot.id }, body: {} })).json.error, 'reason_required');
    assert.equal((await h.call(REFUND_LOT, { user: RECEPTION_A, params: { id: lot.id }, body: { reason: 'x' } })).json.error, 'forbidden');
    const r = await h.call(REFUND_LOT, { user: OWNER_A, params: { id: lot.id }, body: { reason: 'Купил по ошибке' } });
    assert.equal(r.status, 200);
    assert.deepEqual({ p: r.json.payment_id, a: r.json.amount_kopecks }, { p: buy.json.payment_id, a: 300000 });
    assert.equal((await h.call(BALANCE, { user: GUEST_2, club: CLUB_A, params: { club: CLUB_A } })).json.minutes, before - 600);
    const p = await payment(buy.json.payment_id);
    const emuP = await (await fetch(`${h.emuBase}/__emu/payments/${p.provider_payment_id}`)).json();
    assert.deepEqual(emuP.refunded_amount, { value: '3000.00', currency: 'RUB' });
    assert.equal(emuP.receipts.find((x) => x.kind === 'refund').receipt.items[0].payment_mode, 'full_prepayment');
    const audit = (await h.audit('manual.package_refund')).filter((a) => a.object_id === p.id);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].reason, 'Купил по ошибке');
    assert.ok(h.alarms.items.some((a) => a.type === 'manual_action' && a.data.lot_id === lot.id));
    assert.equal((await h.call(REFUND_LOT, { user: OWNER_A, params: { id: lot.id }, body: { reason: 'ещё раз' } })).json.error, 'already_refunded');
    // Тронутая партия (GUEST_1 играл балансом) — не возвращается.
    const used = (await h.q('select l.id from bl.balance_lots l join bl.payments p on p.id = l.payment_id where l.user_id = $1 and p.kind = $2', [GUEST_1, 'package']))[0];
    assert.equal((await h.call(REFUND_LOT, { user: OWNER_A, params: { id: used.id }, body: { reason: 'хочет вернуть' } })).json.error, 'package_used');
    // Кассовая партия: денежный возврат — не здесь; отзыв без денег — revokeLotOnly.
    const posLot = (await h.q('select l.id from bl.balance_lots l join bl.payments p on p.id = l.payment_id where p.kind = $1', ['bar']))[0];
    await assert.rejects(asClub((db) => revokePackageLot(db, { lotId: posLot.id, reason: 'ошибка', staffId: OWNER_A }, inj()), OWNER_A), (e) => e.code === 'bad_request');
    const only = await asClub((db) => revokeLotOnly(db, { lotId: posLot.id, reason: 'Ошибка продажи на кассе', staffId: OWNER_A }, inj()), OWNER_A);
    assert.equal(only.amount_kopecks, 300000);
    assert.equal((await h.q('select minutes_left, revoked_at from bl.balance_lots where id = $1', [posLot.id]))[0].minutes_left, 0);
  });

  it('снятие пакета с продажи — с причиной; купить снятый нельзя', async () => {
    const r = await h.call(ARCHIVE_PKG, { user: OWNER_A, params: { id: pkg.id }, body: { reason: 'Акция закончилась' } });
    assert.deepEqual(r.json, { ok: true });
    assert.equal((await h.call(BUY_PKG, { user: GUEST_1, params: { id: pkg.id }, body: { method: 'card' }, idempotencyKey: newKey() })).status, 404);
  });
});

describe('депозит наличными для «Без лимита» (№112)', () => {
  let dep;

  it('без открытой смены депозит не принимается — shift_closed', async () => {
    const r = await h.call(DEPOSIT, { user: RECEPTION_A, body: { resource_id: T(8), amount_kopecks: 100000 }, idempotencyKey: newKey() });
    assert.deepEqual(r.json, { error: 'shift_closed' });
    assert.equal((await h.q('select count(*)::int as n from bl.sessions where deposit_kopecks is not null'))[0].n, 0);
  });

  it('депозит 1000 ₽ (дали 1500 ₽): сессия light, платёж cash, сдача, чек ККТ предоплаты, журнал', async () => {
    await h.pool.query('insert into bl.shifts (club_id, number, opened_by, opened_at, float_kopecks) values ($1, 1, $2, $3, 500000)', [CLUB_A, RECEPTION_A, START]);
    const key = newKey();
    const r = await h.call(DEPOSIT, { user: RECEPTION_A, body: { resource_id: T(8), amount_kopecks: 100000, received_kopecks: 150000 }, idempotencyKey: key });
    assert.equal(r.status, 201);
    dep = r.json;
    assert.equal(dep.change_kopecks, 50000);
    assert.equal(dep.minutes, 120);
    const p = await payment(dep.payment_id);
    assert.deepEqual(
      { m: p.method, d: p.deposit, u: p.unlimited, s: p.session_id, st: p.settlement_status, conf: Boolean(p.confirmed_at) },
      { m: 'cash', d: true, u: true, s: dep.session_id, st: 'open', conf: true },
    );
    assert.equal((await h.outbox('payment.confirmed')).filter((e) => e.payload.payment_id === p.id).length, 0, 'сессию уже начал light');
    const call = kktCalls.find((c) => c.paymentId === p.id && c.kind === 'sell');
    assert.equal(call.lines[0].payment_mode, 'full_prepayment');
    assert.deepEqual(call.payments, [{ method: 'cash', amount_kopecks: 100000 }]);
    assert.equal((await h.audit('reception.deposit')).length, 1);
    const repeat = await h.call(DEPOSIT, { user: RECEPTION_A, body: { resource_id: T(8), amount_kopecks: 100000, received_kopecks: 150000 }, idempotencyKey: key });
    assert.equal(repeat.json.payment_id, dep.payment_id);
  });

  it('депозитная сессия сама не продлевается', async () => {
    h.sessions.sessions.set(dep.session_id, { id: dep.session_id, resource_id: T(8), paid_until: new Date('2026-10-20T10:00:00Z'), status: 'active', participants: new Set([GUEST_1]), payer: GUEST_1, unlimited: true });
    const r = await h.call(QUOTE, { user: GUEST_1, body: { resource_id: T(8), kind: 'extend', minutes: 60, session_id: dep.session_id } });
    assert.deepEqual(r.json, { error: 'bad_request' });
  });

  it('закрытие: сыграно на 400 ₽ — чек зачёта (оплата «предоплата»), 600 ₽ — возврат наличными с чеком; повтор — без действий; смена сходится', async () => {
    await h.pool.query("update bl.sessions set status = 'closed', ended_at = $2, close_reason = 'stopped' where id = $1", [dep.session_id, '2026-10-20T08:48:00Z']);
    const run = () =>
      asAppApi(h.pool, { clubId: CLUB_A, actorType: 'system' }, (db) => settleDeposit(db, { sessionId: dep.session_id, usedKopecks: 40000 }, inj()));
    const r = await run();
    assert.equal(r.used_kopecks, 40000);
    assert.equal(r.refunded_kopecks, 60000);
    const settleCall = kktCalls.find((c) => c.paymentId === dep.payment_id && c.settlesPaymentId === dep.payment_id);
    assert.deepEqual(settleCall.payments, [{ method: 'prepayment', amount_kopecks: 40000 }]);
    assert.equal(settleCall.lines[0].payment_mode, 'full_payment');
    const refundCall = kktCalls.find((c) => c.kind === 'sell_refund' && c.refundId === r.refund_id);
    assert.deepEqual(refundCall.payments, [{ method: 'cash', amount_kopecks: 60000 }]);
    assert.equal(refundCall.lines[0].payment_mode, 'full_prepayment');
    const f = (await h.q('select * from bl.refunds where id = $1', [r.refund_id]))[0];
    assert.deepEqual({ s: f.status, a: Number(f.amount_kopecks) }, { s: 'manual', a: 60000 });
    assert.ok(h.notes.items.some((n) => n.kind === 'refund' && n.roles.includes('reception')));
    assert.equal((await payment(dep.payment_id)).settlement_status, 'settled');
    const before = kktCalls.length;
    assert.deepEqual(await run(), { used_kopecks: 40000, refunded_kopecks: 60000, refund_id: r.refund_id });
    assert.equal(kktCalls.length, before);
    // Смена: размен 5000 ₽ + депозит 1000 ₽ − возврат 600 ₽ = 5400 ₽ в кассе.
    const cash = await asAppApi(h.pool, { clubId: CLUB_A, actorType: 'system' }, (db) => cashTotals(db, { clubId: CLUB_A, from: new Date(START), to: new Date(Date.parse(START) + 3600_000) }));
    assert.equal(500000 + cash.salesKopecks - cash.refundsKopecks, 540000);
  });

  it('без usedKopecks — расчёт по тарифу: 30 минут минимум при игре 10 минут', async () => {
    const r = await h.call(DEPOSIT, { user: RECEPTION_A, body: { resource_id: T(5), amount_kopecks: 50000 }, idempotencyKey: newKey() });
    await h.pool.query("update bl.sessions set status = 'closed', ended_at = $2, close_reason = 'stopped' where id = $1", [r.json.session_id, '2026-10-20T08:10:00Z']);
    const s = await asAppApi(h.pool, { clubId: CLUB_A, actorType: 'system' }, (db) => settleDeposit(db, { sessionId: r.json.session_id }, inj()));
    assert.deepEqual({ u: s.used_kopecks, b: s.refunded_kopecks }, { u: 25000, b: 25000 });
  });
});
