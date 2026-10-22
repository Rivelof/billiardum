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
import { routes as paymentRoutes } from '../../api/routes/payments.mjs';
import { applyRefundStatus, pendingPlayUntil, createBookingQuote, createPrepayment, creditPackageForSale, onlineMethodAvailable, refund, revokeLotOnly, revokePackageLot, debitBalance, forfeitPrepayment, packageSaleLine, recordOfflinePayment, settleDeposit, settlePrepayment } from '../../server/payments/api.mjs';
import { resolveDeps } from '../../server/payments/deps.mjs';
import { tick } from '../../server/payments/index.mjs';
import { applyRemote, cancelLocal, NOT_FOUND_REASON, onProviderNotFound } from '../../server/payments/pay.mjs';
import { clientFor, loadPaymentSettings } from '../../server/payments/settings.mjs';
import { sendSettlementReceipt, SETTLE_TOPIC, settleSessionBalance } from '../../server/payments/settle.mjs';
import { cashTotals } from '../../server/shifts/service.mjs';
import { withContext } from '../../server/lib/store.mjs';
import { formatMoney } from '../../shared/format.mjs';
import { CLUB_A, CLUB_B, GUEST_1, GUEST_2, newKey, OWNER_A, OWNER_B, RECEPTION_A, setupMoney } from './money_harness.mjs';

const route = (list, method, path) => list.find((r) => r.method === method && r.path === path);
const QUOTE = route(quoteRoutes, 'POST', '/api/quotes');
const TABLE_ROUTE = route(quoteRoutes, 'GET', '/api/t/{code}');
const PAY = route(quoteRoutes, 'POST', '/api/quotes/{id}/pay');
const LIST_PKG = route(packageRoutes, 'GET', '/api/clubs/{club}/packages');
const CREATE_PKG = route(packageRoutes, 'POST', '/api/clubs/{club}/packages');
const ARCHIVE_PKG = route(packageRoutes, 'POST', '/api/packages/{id}/archive');
const BUY_PKG = route(packageRoutes, 'POST', '/api/packages/{id}/buy');
const BALANCE = route(packageRoutes, 'GET', '/api/clubs/{club}/balance');
const REFUND_LOT = route(packageRoutes, 'POST', '/api/packages/lots/{id}/refund');
const LOTS = route(packageRoutes, 'GET', '/api/clubs/{club}/package-lots');
const RETRY = route(paymentRoutes, 'POST', '/api/receipts/{id}/retry');
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
    // Чек зачёта — не при оплате, а при закрытии сессии, за сыгранное (ревью п. 2).
    await drainSettlements();
    assert.equal((await h.q('select count(*)::int as n from bl.receipts where payment_id = $1', [p.id]))[0].n, 0, 'до закрытия сессии чека зачёта нет');
    const sid = await session(t, { paidUntil: '2026-10-20T09:00:00Z' });
    await h.pool.query('update bl.payments set session_id = $2 where id = $1', [p.id, sid]);
    await asClub((db) => settleSessionBalance(db, deps, { sessionId: sid, now: h.clock.now() }));
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

describe('сверка: платёж, которого ЮKassa не знает (404)', () => {
  const runTick = () => tick({ pool: h.pool, withContext: asAppApi, deps, config: h.config });
  const notFoundLogs = (id) => h.logs.filter((l) => l.msg === 'payment_not_found_at_provider' && l.payment_id === id);
  const reconcileFails = (id) => h.logs.filter((l) => l.msg === 'payment_reconcile_failed' && l.payment_id === id);
  const notFoundAlarms = (id) => h.alarms.items.filter((a) => a.type === 'payment_not_found_at_provider' && a.data.payment_id === id);

  it('pending: первый 404 — один лог; до часа ждём молча; старше часа — canceled (not_found_at_provider), стол освобождён, тревога один раз', async () => {
    const t = T(7);
    h.sessions.holds.delete(t);
    for (const [id, s] of h.sessions.sessions) if (s.resource_id === t) h.sessions.sessions.delete(id);
    const q = await h.call(QUOTE, { user: GUEST_2, body: { resource_id: t, kind: 'start', minutes: 60 } });
    assert.equal(q.status, 200, JSON.stringify(q.json));
    const r = await h.call(PAY, { user: GUEST_2, params: { id: q.json.quote_id }, body: { method: 'sbp' }, idempotencyKey: newKey() });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const id = r.json.payment_id;
    assert.ok(h.sessions.holds.get(t), 'pending на столе');
    // ЮKassa (эмулятор после перезапуска) этот платёж не знает.
    await h.pool.query('update bl.payments set provider_payment_id = $2 where id = $1', [id, `lost-${newKey().slice(0, 20)}`]);
    let shift = 0;
    const advance = (ms) => {
      h.clock.advance(ms);
      shift += ms;
    };
    try {
      for (let i = 0; i < 5; i += 1) {
        advance(2 * 60_000);
        await runTick();
      }
      let p = await payment(id);
      assert.equal(p.status, 'pending', 'моложе часа — не отменяем');
      assert.ok(p.provider_missing_at);
      assert.equal(notFoundLogs(id).length, 1, 'лог — один раз на платёж');
      assert.equal(reconcileFails(id).length, 0);
      assert.equal(notFoundAlarms(id).length, 0);
      advance(60 * 60_000);
      await runTick();
      await runTick();
      p = await payment(id);
      assert.deepEqual({ s: p.status, r: p.cancellation_reason }, { s: 'canceled', r: NOT_FOUND_REASON });
      assert.equal(h.sessions.holds.get(t), undefined, 'pending со стола снят');
      assert.equal(p.session_id, null, 'сессия не запущена');
      const ev = await h.q("select payload from bl.outbox where topic = 'payment.canceled' and payload->>'payment_id' = $1", [id]);
      assert.equal(ev.length, 1);
      const alarms = notFoundAlarms(id);
      assert.equal(alarms.length, 1, 'тревога один раз');
      assert.deepEqual({ l: alarms[0].level, a: alarms[0].data.action }, { l: 'important', a: 'canceled' });
      assert.equal(notFoundLogs(id).length, 1);
      assert.equal(reconcileFails(id).length, 0);
    } finally {
      h.clock.advance(-shift);
    }
  });

  it('у нас уже succeeded — платёж не трогаем, только тревога (один раз)', async () => {
    h.sessions.holds.delete(T(7));
    const q = await h.call(QUOTE, { user: GUEST_1, body: { resource_id: T(7), kind: 'start', minutes: 60 } });
    assert.equal(q.status, 200, JSON.stringify(q.json));
    const r = await h.call(PAY, { user: GUEST_1, params: { id: q.json.quote_id }, body: { method: 'sbp' }, idempotencyKey: newKey() });
    await emuSucceed(r.json.payment_id);
    const before = await payment(r.json.payment_id);
    assert.equal(before.status, 'succeeded');
    for (let i = 0; i < 2; i += 1) {
      const out = await asAppApi(h.pool, { clubId: CLUB_A, actorType: 'system' }, (db) => onProviderNotFound(db, deps, before, { source: 'test' }));
      assert.equal(out.result, 'already');
    }
    const p = await payment(r.json.payment_id);
    assert.deepEqual({ s: p.status, c: p.canceled_at }, { s: 'succeeded', c: null });
    const alarms = notFoundAlarms(p.id);
    assert.equal(alarms.length, 1);
    assert.deepEqual({ l: alarms[0].level, a: alarms[0].data.action }, { l: 'critical', a: 'kept' });
  });
});

describe('return_url: только путь своего сайта (пакет и предоплата брони)', () => {
  const emuReturnUrl = async (paymentId) => {
    const p = await payment(paymentId);
    return (await (await fetch(`${h.emuBase}/__emu/payments/${p.provider_payment_id}`)).json()).confirmation?.return_url;
  };
  const BAD = ['https://evil.example/app', '//evil.example/app', 'https://billiardum.test@evil.example/', '/app/../admin', '/\\evil.example', 'javascript:alert(1)', '', 42];

  it('покупка пакета: путь → наш хост; чужой адрес — bad_request; без return_url — экран ожидания', async () => {
    const { rows } = await h.pool.query('select id from bl.tariff_packages where club_id = $1 and active order by created_at limit 1', [CLUB_A]);
    const id = rows[0].id;
    for (const bad of BAD) {
      const r = await h.call(BUY_PKG, { user: GUEST_2, params: { id }, body: { method: 'sbp', return_url: bad }, idempotencyKey: newKey() });
      assert.deepEqual([r.status, r.json], [400, { error: 'bad_request' }], String(bad));
    }
    const ok = await h.call(BUY_PKG, { user: GUEST_2, params: { id }, body: { method: 'sbp', return_url: '/app/packages?paid=1' }, idempotencyKey: newKey() });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(await emuReturnUrl(ok.json.payment_id), 'https://billiardum.test/app/packages?paid=1');
    const dflt = await h.call(BUY_PKG, { user: GUEST_2, params: { id }, body: { method: 'sbp' }, idempotencyKey: newKey() });
    assert.equal(await emuReturnUrl(dflt.json.payment_id), `https://billiardum.test/app/wait/${dflt.json.payment_id}`);
  });

  it('createPrepayment: returnUrl — путь или полный адрес на своём хосте; чужой — bad_request', async () => {
    const make = (returnUrl) =>
      asClub((db) => createPrepayment(db, { clubId: CLUB_A, bookingId: newKey(), resourceId: T(3), userId: GUEST_1, amountKopecks: 10000, returnUrl }, inj()), GUEST_1);
    for (const bad of BAD) await assert.rejects(make(bad), (e) => e.code === 'bad_request', String(bad));
    const a = await make('/app/bookings?paid=1');
    assert.equal(await emuReturnUrl(a.payment.id), 'https://billiardum.test/app/bookings?paid=1');
    const b = await make('https://billiardum.test/app/bookings/x');
    assert.equal(await emuReturnUrl(b.payment.id), 'https://billiardum.test/app/bookings/x');
  });
});


describe('партии гостя для экрана возврата (№118, волна B)', () => {
  const lots = (user, club, query) => h.call(LOTS, { user, club, params: { club }, query });

  it('точный телефон → партии клуба с источником, продажей кассы и маской; полный телефон нигде не светится', async () => {
    // Кассовая партия GUEST_2 — строка продажи pos (чтение pos_sale_packages, сами строки pos тут — суперпользователем).
    const pos = (await h.q("select l.*, p.id as pay_id from bl.balance_lots l join bl.payments p on p.id = l.payment_id where l.user_id = $1 and p.kind = 'bar' limit 1", [GUEST_2]))[0];
    const saleId = newKey();
    await h.pool.query(
      `insert into bl.pos_sales (id, club_id, channel, method, status, payment_id, package_kopecks, created_by, created_at, completed_at, updated_at)
       values ($1, $2, 'pos', 'card_terminal', 'completed', $3, 300000, $4, now(), now(), now())`,
      [saleId, CLUB_A, pos.pay_id, RECEPTION_A],
    );
    await h.pool.query(
      `insert into bl.pos_sale_packages (club_id, sale_id, idx, package_id, user_id, amount_kopecks, line, lot_id, created_at)
       values ($1, $2, 0, $3, $4, 300000, '{}'::jsonb, $5, now())`,
      [CLUB_A, saleId, pos.package_id, GUEST_2, pos.id],
    );
    const logStart = h.logs.length;
    const r = await lots(OWNER_A, CLUB_A, { phone: '+7 (999) 000-00-02' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const expected = await h.q('select id from bl.balance_lots where club_id = $1 and user_id = $2', [CLUB_A, GUEST_2]);
    assert.deepEqual(r.json.map((x) => x.id).sort(), expected.map((x) => x.id).sort());
    const p = r.json.find((x) => x.id === pos.id);
    assert.deepEqual({ s: p.source, sale: p.sale_id, idx: p.idx }, { s: 'pos', sale: saleId, idx: 0 });
    assert.ok(p.refunded_at, 'кассовая партия отозвана раньше (revokeLotOnly)');
    const app = r.json.filter((x) => x.source === 'app');
    assert.ok(app.length >= 1);
    assert.ok(app.every((x) => x.sale_id === null && x.idx === null));
    for (const x of r.json) {
      assert.deepEqual(Object.keys(x).sort(), ['created_at', 'expires_at', 'guest', 'id', 'idx', 'minutes_left', 'minutes_total', 'package_id', 'price_kopecks', 'refunded_at', 'sale_id', 'source', 'title']);
      assert.deepEqual(x.guest, { name: null, phone_masked: '+7999***0002' });
    }
    assert.ok(!JSON.stringify(r.json).includes('79990000002'));
    const newLogs = h.logs.slice(logStart);
    assert.ok(newLogs.some((l) => l.msg === 'package_lots_lookup' && l.phone === '+7999***0002' && l.found === true));
    assert.ok(!JSON.stringify(newLogs).includes('79990000002'), 'в логе — только маска');
  });

  it('без телефона и с неполным — 400; ресепшн — 403; чужой клуб — 403 или пусто; гость без партий — пусто', async () => {
    assert.deepEqual([(await lots(OWNER_A, CLUB_A, {})).status, (await lots(OWNER_A, CLUB_A, {})).json], [400, { error: 'bad_request' }]);
    for (const bad of ['+7999', '7999*', '+7999000000%', '', 'abc']) assert.equal((await lots(OWNER_A, CLUB_A, { phone: bad })).status, 400, bad);
    const rec = await lots(RECEPTION_A, CLUB_A, { phone: '+79990000002' });
    assert.deepEqual([rec.status, rec.json], [403, { error: 'forbidden' }]);
    assert.equal((await lots(OWNER_A, CLUB_B, { phone: '+79990000002' })).status, 403, 'владелец A в клубе B');
    const other = await lots(OWNER_B, CLUB_B, { phone: '+79990000002' });
    assert.deepEqual([other.status, other.json], [200, []], 'у клуба B нет партий этого гостя');
    assert.deepEqual((await lots(OWNER_A, CLUB_A, { phone: '+79990000099' })).json, []);
    // Узкая функция сама проверяет роль: ресепшну и без клуба — пусто.
    const fn = (user, club) => h.tx({ clubId: club, userId: user }, async (db) => (await db.query('select * from bl.money_lot_guest($1)', ['+79990000002'])).rows);
    assert.equal((await fn(RECEPTION_A, CLUB_A)).length, 0);
    assert.equal((await fn(OWNER_A, null)).length, 0);
    assert.equal((await fn(OWNER_B, CLUB_B)).length, 0);
    assert.deepEqual(Object.keys((await fn(OWNER_A, CLUB_A))[0]).sort(), ['name', 'phone_masked', 'user_id']);
  });

  it('не чаще 30 запросов в минуту на сотрудника — дальше 429 rate_limited', async () => {
    let n = 0;
    let last;
    do {
      n += 1;
      last = await lots(OWNER_B, CLUB_B, { phone: '+79990000002' });
    } while (last.status === 200 && n < 40);
    assert.deepEqual([last.status, last.json], [429, { error: 'rate_limited' }]);
    assert.ok(n <= 31 && n >= 29, `сработало на ${n}-м запросе`);
  });
});

describe('B-L1: платёж отменён у нас, а в ЮKassa оплачен — автовозврат, тревога один раз', () => {
  const runTick = () => tick({ pool: h.pool, withContext: asAppApi, deps, config: h.config });
  const lateAlarms = (id) => h.alarms.items.filter((a) => a.type === 'payment_paid_after_cancel' && a.data.payment_id === id);
  const guestNotes = (id) => h.notes.items.filter((n) => n.kind === 'payment_returned' && n.data?.payment_id === id);
  const startPay = async (t, user, body) => {
    h.sessions.holds.delete(t);
    for (const [sid, s] of h.sessions.sessions) if (s.resource_id === t) h.sessions.sessions.delete(sid);
    const q = await h.call(QUOTE, { user, body: { resource_id: t, kind: 'start', ...body.quote } });
    assert.equal(q.status, 200, JSON.stringify(q.json));
    const r = await h.call(PAY, { user, params: { id: q.json.quote_id }, body: { method: body.method }, idempotencyKey: newKey() });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.payment_id;
  };
  const webhookAgain = (pid, event) =>
    h.call(WEBHOOK, { params: { club_id: CLUB_A }, body: { type: 'notification', event, object: { id: pid } }, actor: 'system' });

  it('отмена по 404, затем гость оплатил: возврат всей суммы с чеком возврата (как чек продажи), игры нет, тревога и уведомление гостю — один раз', async () => {
    const id = await startPay(T(7), GUEST_2, { quote: { minutes: 60 }, method: 'sbp' });
    const real = (await payment(id)).provider_payment_id;
    await h.pool.query('update bl.payments set provider_payment_id = $2 where id = $1', [id, `lost-${newKey().slice(0, 20)}`]);
    let shift = 0;
    try {
      h.clock.advance(5 * 60_000);
      shift += 5 * 60_000;
      await runTick();
      h.clock.advance(61 * 60_000);
      shift += 61 * 60_000;
      await runTick();
      assert.deepEqual([(await payment(id)).status, (await payment(id)).cancellation_reason], ['canceled', NOT_FOUND_REASON]);
      // Платёж снова виден в ЮKassa, гость оплачивает; вебхук.
      await h.pool.query('update bl.payments set provider_payment_id = $2 where id = $1', [id, real]);
      await fetch(`${h.emuBase}/__emu/payments/${real}/succeed?wait=1`, { method: 'POST' });
      await h.emu.settle();
      const p = await payment(id);
      assert.equal(p.status, 'canceled', 'статус окончательный');
      assert.equal(p.session_id, null, 'игра не началась');
      assert.equal(h.sessions.holds.get(T(7)), undefined);
      assert.ok(p.late_paid_at);
      assert.equal((await h.q("select * from bl.outbox where topic = 'payment.confirmed' and payload->>'payment_id' = $1", [id])).length, 0);
      const refunds = await h.q('select * from bl.refunds where payment_id = $1', [id]);
      assert.equal(refunds.length, 1);
      assert.deepEqual({ k: refunds[0].idempotence_key, a: Number(refunds[0].amount_kopecks), s: refunds[0].status, kind: refunds[0].kind }, { k: `late-${id}`, a: Number(p.amount_kopecks), s: 'succeeded', kind: 'late' });
      const emuP = await (await fetch(`${h.emuBase}/__emu/payments/${real}`)).json();
      assert.deepEqual(emuP.refunded_amount, { value: formatRub(Number(p.amount_kopecks)), currency: 'RUB' });
      const sale = (await h.q("select items from bl.receipts where payment_id = $1 and kind = 'sale'", [id]))[0];
      const ret = (await h.q("select * from bl.receipts where refund_id = $1 and kind = 'refund'", [refunds[0].id]))[0];
      assert.equal(ret.channel, 'yookassa');
      assert.deepEqual(ret.items, sale.items, 'чек возврата повторяет чек продажи');
      assert.ok(emuP.receipts.some((x) => x.kind === 'refund'));
      assert.equal((await h.audit('payment.refunded')).filter((a) => a.object_id === id).length, 1);
      const alarms = lateAlarms(id);
      assert.equal(alarms.length, 1);
      assert.deepEqual({ l: alarms[0].level, a: alarms[0].data.action, s: alarms[0].data.provider_status }, { l: 'critical', a: 'refunded', s: 'succeeded' });
      assert.equal(guestNotes(id).length, 1);
      assert.equal(guestNotes(id)[0].userId, GUEST_2);
      // Повтор вебхука — ни второго возврата, ни второй тревоги.
      const again = await webhookAgain(real, 'payment.succeeded');
      assert.equal(again.status, 200);
      assert.equal((await h.q('select * from bl.refunds where payment_id = $1', [id])).length, 1);
      assert.equal(lateAlarms(id).length, 1);
      assert.equal(guestNotes(id).length, 1);
    } finally {
      h.clock.advance(-shift);
    }
  });

  it('перед отменой по 404 — повторный запрос: платёж нашёлся — не отменяем', async () => {
    const id = await startPay(T(7), GUEST_2, { quote: { minutes: 60 }, method: 'sbp' });
    const shift = 61 * 60_000;
    h.clock.advance(shift);
    try {
      const out = await asAppApi(h.pool, { clubId: CLUB_A, actorType: 'system' }, async (db) => {
        const client = clientFor(await loadPaymentSettings(db, CLUB_A), h.config);
        return onProviderNotFound(db, deps, await payment(id), { source: 'test', client });
      });
      assert.equal(out.result, 'pending');
      const p = await payment(id);
      assert.deepEqual({ s: p.status, c: p.canceled_at }, { s: 'pending', c: null });
    } finally {
      h.clock.advance(-shift);
    }
  });

  it('заморозка «Без лимита», отменённая у нас, затем подтверждённая в ЮKassa — заморозка снимается, тревога один раз, возврата нет', async () => {
    const id = await startPay(T(6), GUEST_1, { quote: { minutes: null }, method: 'card' });
    assert.equal((await payment(id)).capture, false);
    await asAppApi(h.pool, { clubId: CLUB_A, actorType: 'system' }, async (db) => cancelLocal(db, deps, await payment(id), { reason: 'expired_on_confirmation', now: h.clock.now() }));
    const real = (await payment(id)).provider_payment_id;
    await fetch(`${h.emuBase}/__emu/payments/${real}/succeed?wait=1`, { method: 'POST' });
    await h.emu.settle();
    const emuP = await (await fetch(`${h.emuBase}/__emu/payments/${real}`)).json();
    assert.equal(emuP.status, 'canceled', 'заморозка снята в ЮKassa');
    const p = await payment(id);
    assert.deepEqual({ s: p.status, sess: p.session_id }, { s: 'canceled', sess: null });
    assert.equal((await h.q('select * from bl.refunds where payment_id = $1', [id])).length, 0);
    const alarms = lateAlarms(id);
    assert.equal(alarms.length, 1);
    assert.deepEqual({ l: alarms[0].level, a: alarms[0].data.action, s: alarms[0].data.provider_status }, { l: 'critical', a: 'released', s: 'waiting_for_capture' });
    assert.equal(guestNotes(id).length, 1);
    await webhookAgain(real, 'payment.canceled');
    assert.equal(lateAlarms(id).length, 1);
  });
});

describe('B-R1: гонка вебхука со сверкой; доступность способа оплаты для кассы', () => {
  it('устаревшая строка pending (сверка уже отменила по 404), ЮKassa — succeeded: всё равно автовозврат и тревога', async () => {
    h.sessions.holds.delete(T(2));
    const q = await h.call(QUOTE, { user: GUEST_1, body: { resource_id: T(2), kind: 'start', minutes: 60 } });
    assert.equal(q.status, 200, JSON.stringify(q.json));
    const r = await h.call(PAY, { user: GUEST_1, params: { id: q.json.quote_id }, body: { method: 'sbp' }, idempotencyKey: newKey() });
    const id = r.json.payment_id;
    const stale = await payment(id);
    const shift = 61 * 60_000;
    h.clock.advance(shift);
    try {
      // Сверка без повторного запроса (client не передан) отменяет по 404.
      await asAppApi(h.pool, { clubId: CLUB_A, actorType: 'system' }, async (db) => onProviderNotFound(db, deps, await payment(id), { source: 'test' }));
      assert.equal((await payment(id)).status, 'canceled');
      const remote = {
        id: stale.provider_payment_id,
        status: 'succeeded',
        amount: { value: (Number(stale.amount_kopecks) / 100).toFixed(2), currency: 'RUB' },
        metadata: { club_id: CLUB_A, quote_id: stale.quote_id },
        receipt_registration: 'succeeded',
      };
      const calls = [];
      const client = { createRefund: async (_body, key) => (calls.push(key), { id: `rf-${newKey().slice(0, 12)}`, status: 'succeeded', receipt_registration: 'succeeded' }) };
      const out = await asAppApi(h.pool, { clubId: CLUB_A, actorType: 'system' }, (db) => applyRemote(db, deps, stale, remote, { source: 'race', client }));
      assert.equal(out.result, 'late_refund');
      assert.deepEqual(calls, [`late-${id}`]);
      assert.equal(h.alarms.items.filter((a) => a.type === 'payment_paid_after_cancel' && a.data.payment_id === id).length, 1);
      assert.equal((await payment(id)).status, 'canceled');
    } finally {
      h.clock.advance(-shift);
    }
  });

  it('вебхук берёт строку платежа FOR UPDATE: пока сверка держит строку, вебхук ждёт', async () => {
    h.sessions.holds.delete(T(2));
    const q = await h.call(QUOTE, { user: GUEST_2, body: { resource_id: T(2), kind: 'start', minutes: 60 } });
    const r = await h.call(PAY, { user: GUEST_2, params: { id: q.json.quote_id }, body: { method: 'sbp' }, idempotencyKey: newKey() });
    await emuSucceed(r.json.payment_id);
    const p = await payment(r.json.payment_id);
    assert.equal(p.status, 'succeeded');
    const holder = await h.pool.connect();
    let done = false;
    try {
      await holder.query('begin');
      await holder.query('select id from bl.payments where id = $1 for update', [p.id]);
      const hook = h
        .call(WEBHOOK, { params: { club_id: CLUB_A }, body: { type: 'notification', event: 'payment.succeeded', object: { id: p.provider_payment_id } }, actor: 'system' })
        .then((x) => {
          done = true;
          return x;
        });
      await new Promise((res) => setTimeout(res, 300));
      assert.equal(done, false, 'вебхук ждёт блокировку строки');
      await holder.query('commit');
      assert.equal((await hook).status, 200);
    } finally {
      holder.release();
    }
  });

  it('onlineMethodAvailable: магазин есть и способ включён — true; выключен, неизвестный способ — false', async () => {
    const check = (method, club = CLUB_A) => asClub((db) => onlineMethodAvailable(db, { clubId: club, method }), RECEPTION_A);
    assert.equal(await check('sbp'), true);
    assert.equal(await check('card'), true);
    assert.equal(await check('cash'), false);
    assert.equal(await check('qr'), false);
    await h.pool.query('update bl.club_payment_settings set sbp_enabled = false where club_id = $1', [CLUB_A]);
    try {
      assert.equal(await check('sbp'), false);
      assert.equal(await check('card'), true);
    } finally {
      await h.pool.query('update bl.club_payment_settings set sbp_enabled = true where club_id = $1', [CLUB_A]);
    }
    await assert.rejects(asClub((db) => onlineMethodAvailable(db, { clubId: 'x', method: 'sbp' })), (e) => e.code === 'bad_request');
  });
});

describe('Д3 и Д2: текст тревоги о возврате пакета; повтор чека зачёта', () => {
  it('Д3: тревога владельцу — пакет, маска гостя, сумма, кто и причина; critical', async () => {
    const posLot = (await h.q("select l.* from bl.balance_lots l join bl.payments p on p.id = l.payment_id where p.kind = 'bar' and l.revoked_at is not null limit 1"))[0];
    const a = h.alarms.items.find((x) => x.type === 'manual_action' && x.data.lot_id === posLot.id);
    const title = (await h.q('select title from bl.tariff_packages where id = $1', [posLot.package_id]))[0].title;
    assert.equal(a.level, 'critical');
    assert.equal(a.manual, true);
    assert.equal(a.text, `Возврат пакета «${title}» гостю +7999***0002 на ${formatMoney(300000)} — Владелец (тест): Ошибка продажи на кассе`);
    const app = h.alarms.items.find((x) => x.type === 'manual_action' && x.data.action === 'manual.package_refund' && x.text.includes('Купил по ошибке'));
    assert.ok(app.text.startsWith('Возврат пакета «') && app.text.endsWith(`гостю +7999***0002 на ${formatMoney(300000)} — Владелец (тест): Купил по ошибке`), app.text);
  });

  async function settlementReceipt() {
    const bookingId = newKey();
    const r = await asClub((db) => createPrepayment(db, { clubId: CLUB_A, bookingId, resourceId: T(3), userId: GUEST_1, amountKopecks: 50000, method: 'card' }, inj()), GUEST_1);
    await emuSucceed(r.payment.id);
    const { rows } = await h.pool.query(
      `insert into bl.sessions (club_id, resource_id, status, payer_user_id, unlimited, started_at, paid_until, ended_at, close_reason, created_at, updated_at)
       values ($1, $2, 'closed', $3, false, $4, $5, $5, 'stopped', $4, $4) returning id`,
      [CLUB_A, T(3), GUEST_1, START, '2026-10-20T09:00:00Z'],
    );
    const s = await asClub((db) => settlePrepayment(db, { paymentId: r.payment.id, sessionId: rows[0].id }, inj()));
    return s.receipt_id;
  }
  const emuFail = (status) => fetch(`${h.emuBase}/__emu/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fail_next: { count: 1, status } }) });
  const send = (id) => asAppApi(h.pool, { clubId: CLUB_A, actorType: 'system' }, (db) => sendSettlementReceipt(db, deps, h.config, { receipt_id: id, club_id: CLUB_A }));
  const receipt = async (id) => (await h.q('select * from bl.receipts where id = $1', [id]))[0];
  const keysFor = async () => (await (await fetch(`${h.emuBase}/__emu/requests`)).json()).filter((x) => x.path === '/v3/receipts').map((x) => x.idempotence_key);

  it('Д2: 5xx — ошибка наверх (outbox повторит с паузой), чек в очереди; повтор тем же ключом проходит', async () => {
    const id = await settlementReceipt();
    await drainOtherSettlements(id);
    await emuFail(500);
    await assert.rejects(send(id), (e) => e.retryable === true);
    assert.equal((await receipt(id)).status, 'receipt_pending');
    assert.equal((await send(id)).result, 'succeeded');
    assert.ok((await keysFor()).includes(`st-${id}`));
  });

  it('Д2: 4xx — failed и тревога с действием «Повторить»; повтор управляющим с причиной — новый ключ, чек пробит; ресепшн — 403', async () => {
    const id = await settlementReceipt();
    await drainOtherSettlements(id);
    await emuFail(400);
    assert.equal((await send(id)).result, 'failed');
    assert.equal((await receipt(id)).status, 'failed');
    const a = h.alarms.items.filter((x) => x.type === 'settlement_receipt_failed' && x.data.receipt_id === id);
    assert.equal(a.length, 1);
    assert.deepEqual({ t: a[0].data.action_title, u: a[0].data.action_url }, { t: 'Повторить', u: `/api/receipts/${id}/retry` });
    const call = (user, body) => h.call(RETRY, { user, club: CLUB_A, params: { id }, body, idempotencyKey: newKey() });
    assert.equal((await call(RECEPTION_A, { reason: 'x' })).status, 403);
    assert.deepEqual((await call(OWNER_A, {})).json, { error: 'reason_required' });
    const ok = await call(OWNER_A, { reason: 'ЮKassa отклонила чек, телефон гостя исправлен' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.deepEqual(ok.json, { receipt_id: id, status: 'receipt_pending', retried: true });
    const au = (await h.audit('manual.receipt_retry')).filter((x) => x.data.receipt_id === id);
    assert.equal(au.length, 1);
    assert.equal(au[0].reason, 'ЮKassa отклонила чек, телефон гостя исправлен');
    const ev = (await h.outbox(SETTLE_TOPIC)).filter((e) => e.payload.receipt_id === id && !e.processed_at);
    assert.equal(ev.length, 1);
    assert.equal((await send(id)).result, 'succeeded');
    const r = await receipt(id);
    assert.deepEqual({ s: r.status, n: r.settle_retry }, { s: 'succeeded', n: 1 });
    assert.ok(r.provider_receipt_id);
    assert.ok((await keysFor()).includes(`st-${id}-r1`), 'повтор — ключ st-<id>-r1');
    const again = await call(OWNER_A, { reason: 'ещё раз' });
    assert.deepEqual(again.json, { receipt_id: id, status: 'succeeded', retried: false });
    const foreign = await h.call(RETRY, { user: OWNER_B, club: CLUB_B, params: { id }, body: { reason: 'x' }, idempotencyKey: newKey() });
    assert.equal(foreign.status, 404, 'чек другого клуба не виден');
  });
});

/** Отметить события чека зачёта, кроме id, обработанными, чтобы прямые вызовы теста не путались. */
async function drainOtherSettlements(id) {
  await h.pool.query("update bl.outbox set processed_at = now() where topic = $1 and processed_at is null and payload->>'receipt_id' = $2", [SETTLE_TOPIC, id]);
}

describe('ревью денег: баланс, заморозка, отмена возврата, чеки зачёта, наличные без смены, сверки', () => {
  const t = T(2);
  const runTick = (d = deps) => tick({ pool: h.pool, withContext: asAppApi, deps: d, config: h.config });
  const freeTable = async () => {
    h.sessions.holds.delete(t);
    for (const [sid, x] of h.sessions.sessions) if (x.resource_id === t) h.sessions.sessions.delete(sid);
    await h.pool.query("update bl.sessions set status = 'closed', ended_at = coalesce(ended_at, now()), close_reason = coalesce(close_reason, 'stopped') where resource_id = $1 and status <> 'closed'", [t]);
  };
  const balanceOf = async (user) => (await h.call(BALANCE, { user, club: CLUB_A, params: { club: CLUB_A } })).json.minutes;
  /** Свежая партия минут гостю (пакет, оплаченный в приложении) — напрямую. */
  async function giveMinutes(user, minutes, price) {
    const pkg = (await h.q(`insert into bl.tariff_packages (club_id, title, minutes, price_kopecks, valid_days) values ($1, 'Тест', $2, $3, 30) returning id`, [CLUB_A, minutes, price]))[0].id;
    const pay = (await h.q(
      `insert into bl.payments (club_id, user_id, kind, provider, method, idempotence_key, status, amount_kopecks, capture, package_id, provider_payment_id, confirmed_at, captured_at, created_at, updated_at)
       values ($1, $2, 'package', 'yookassa', 'sbp', $3, 'succeeded', $4, true, $5, $6, now(), now(), now(), now()) returning id`,
      [CLUB_A, user, `pk-${newKey()}`, price, pkg, `yk-${newKey()}`],
    ))[0].id;
    await h.q(
      `insert into bl.balance_lots (club_id, user_id, package_id, payment_id, minutes_total, minutes_left, price_kopecks, expires_at, source_key, created_at)
       values ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9)`,
      [CLUB_A, user, pkg, pay, minutes, price, new Date(h.clock.now().getTime() + 30 * 86_400_000), `${pay}:${pkg}:0`, h.clock.now()],
    );
  }
  const asSystem = (fn, d = deps) => asAppApi(h.pool, { clubId: CLUB_A, actorType: 'system' }, (db) => fn(db, d));

  it('п. 2: продление балансом после закрытия сессии — минуты вернулись (без ЮKassa), журнал, гостю уведомление; чек зачёта не пробит', async () => {
    await freeTable();
    await giveMinutes(GUEST_1, 120, 60000);
    const sid = await session(t, { paidUntil: '2026-10-20T09:00:00Z' });
    const q = await h.call(QUOTE, { user: GUEST_1, body: { resource_id: t, kind: 'extend', minutes: 30, session_id: sid, use_balance: true } });
    assert.equal(q.status, 200, JSON.stringify(q.json));
    assert.equal(q.json.amount_kopecks, 0);
    const before = await balanceOf(GUEST_1);
    const r = await h.call(PAY, { user: GUEST_1, params: { id: q.json.quote_id }, body: { method: 'balance' }, idempotencyKey: newKey() });
    const p = await payment(r.json.payment_id);
    assert.equal(await balanceOf(GUEST_1), before - 30);
    // Сессия уже закрыта — light отклоняет продление и возвращает всю сумму (rejectPayment).
    await h.pool.query("update bl.sessions set status = 'closed', ended_at = now(), close_reason = 'stopped' where id = $1", [sid]);
    const back = await asSystem((db) => refund(db, { paymentId: p.id, amountKopecks: Number(p.amount_kopecks), reason: 'light_session_closed' }, inj()));
    assert.deepEqual({ s: back.status, m: back.minutes_restored }, { s: 'succeeded', m: 30 });
    assert.equal(await balanceOf(GUEST_1), before);
    const f = (await h.q('select * from bl.refunds where id = $1', [back.refund_id]))[0];
    assert.deepEqual({ k: f.kind, s: f.status, prov: f.provider_refund_id }, { k: 'balance', s: 'succeeded', prov: null });
    assert.equal((await h.audit('payment.refunded')).filter((a) => a.object_id === p.id).length, 1);
    assert.equal((await h.outbox('payment.refunded')).filter((e) => e.payload.payment_id === p.id).length, 1);
    assert.ok(h.notes.items.some((n) => n.kind === 'balance_returned' && n.userId === GUEST_1 && n.data.minutes === 30));
    // Повтор outbox light — тот же возврат.
    const again = await asSystem((db) => refund(db, { paymentId: p.id, amountKopecks: Number(p.amount_kopecks), reason: 'light_session_closed' }, inj()));
    assert.equal(again.refund_id, back.refund_id);
    assert.equal(await balanceOf(GUEST_1), before);
    await asSystem((db) => settleSessionBalance(db, deps, { sessionId: sid, now: h.clock.now() }));
    assert.equal((await h.q('select count(*)::int as n from bl.receipts where payment_id = $1', [p.id]))[0].n, 0, 'зачёт за неоказанное не пробит');
    await assert.rejects(asSystem((db) => refund(db, { paymentId: p.id, amountKopecks: 1, reason: 'ещё' }, inj())), (e) => e.code === 'limit_exceeded');
  });

  it('п. 2: прерванная игра балансом — частичный возврат минут; при закрытии чек зачёта только за сыгранное', async () => {
    await freeTable();
    await giveMinutes(GUEST_1, 60, 30000);
    const q = await h.call(QUOTE, { user: GUEST_1, body: { resource_id: t, kind: 'start', minutes: 60, use_balance: true } });
    const r = await h.call(PAY, { user: GUEST_1, params: { id: q.json.quote_id }, body: { method: 'balance' }, idempotencyKey: newKey() });
    const p = await payment(r.json.payment_id);
    const sid = await session(t, { paidUntil: '2026-10-20T09:00:00Z' });
    await h.pool.query('update bl.payments set session_id = $2 where id = $1', [p.id, sid]);
    const half = Math.floor(Number(p.amount_kopecks) / 2);
    const before = await balanceOf(GUEST_1);
    const back = await asSystem((db) => refund(db, { paymentId: p.id, amountKopecks: half, reason: 'interrupted' }, inj()));
    assert.equal(back.minutes_restored, 30);
    assert.equal(await balanceOf(GUEST_1), before + 30);
    await asSystem((db) => settleSessionBalance(db, deps, { sessionId: sid, now: h.clock.now() }));
    const rec = (await h.q("select * from bl.receipts where payment_id = $1 and kind = 'sale'", [p.id]));
    const total = rec.reduce((x, y) => x + Number(y.settlement_kopecks), 0);
    const debits = (await h.q('select coalesce(sum(value_kopecks), 0)::bigint as v, coalesce(sum(minutes), 0)::int as m from bl.balance_debits where payment_id = $1 and restored_at is null', [p.id]))[0];
    assert.equal(debits.m, 30);
    assert.equal(total, Number(debits.v), 'чек зачёта — за 30 сыгранных минут');
  });

  it('п. 2: смешанная оплата (карта + баланс) — возврат карты ЮKassa и минут на баланс', async () => {
    await freeTable();
    const have = await balanceOf(GUEST_2);
    if (have < 60) await giveMinutes(GUEST_2, 60 - have, 30000);
    const bal = await balanceOf(GUEST_2);
    const q = await h.call(QUOTE, { user: GUEST_2, body: { resource_id: t, kind: 'start', minutes: bal + 60, use_balance: true } });
    assert.equal(q.status, 200, JSON.stringify(q.json));
    assert.equal(q.json.balance_minutes, bal);
    assert.ok(q.json.amount_kopecks > 0);
    const r = await h.call(PAY, { user: GUEST_2, params: { id: q.json.quote_id }, body: { method: 'sbp' }, idempotencyKey: newKey() });
    await emuSucceed(r.json.payment_id);
    const p = await payment(r.json.payment_id);
    assert.equal(await balanceOf(GUEST_2), 0);
    const back = await asSystem((db) => refund(db, { paymentId: p.id, amountKopecks: Number(p.amount_kopecks), reason: 'light_table_busy' }, inj()));
    assert.equal(back.minutes_restored, bal);
    assert.equal(await balanceOf(GUEST_2), bal);
    const emuP = await (await fetch(`${h.emuBase}/__emu/payments/${p.provider_payment_id}`)).json();
    assert.deepEqual(emuP.refunded_amount, { value: formatRub(Number(p.amount_kopecks)), currency: 'RUB' });
  });

  it('п. 3: заморозка 1000 ₽, возврат 300 ₽ → списано 700 ₽; строка возврата kind release; следующий возврат — до 700 ₽', async () => {
    await freeTable();
    const q = await h.call(QUOTE, { user: GUEST_1, body: { resource_id: t, kind: 'start', minutes: null } });
    const r = await h.call(PAY, { user: GUEST_1, params: { id: q.json.quote_id }, body: { method: 'card' }, idempotencyKey: newKey() });
    await emuSucceed(r.json.payment_id);
    let p = await payment(r.json.payment_id);
    assert.equal(p.status, 'waiting_for_capture');
    assert.equal(Number(p.amount_kopecks), 100000);
    const a = await asSystem((db) => refund(db, { paymentId: p.id, amountKopecks: 30000, reason: 'Свет не включился' }, inj()));
    const fa = (await h.q('select * from bl.refunds where id = $1', [a.refund_id]))[0];
    assert.equal(fa.kind, 'release');
    p = await payment(p.id);
    assert.deepEqual({ s: p.status, c: Number(p.captured_kopecks) }, { s: 'succeeded', c: 70000 });
    await assert.rejects(asSystem((db) => refund(db, { paymentId: p.id, amountKopecks: 70001, reason: 'больше списанного' }, inj())), (e) => e.code === 'limit_exceeded');
    const b = await asSystem((db) => refund(db, { paymentId: p.id, amountKopecks: 70000, reason: 'Вернуть всё списанное' }, inj()));
    assert.equal((await h.q('select kind from bl.refunds where id = $1', [b.refund_id]))[0].kind, 'refund');
    await assert.rejects(asSystem((db) => refund(db, { paymentId: p.id, amountKopecks: 1, reason: 'ещё' }, inj())), (e) => e.code === 'limit_exceeded');
  });

  it('п. 4: возврат отменён ЮKassa — payment.refund_canceled, критичная тревога, не входит в «уже возвращено»; пакет из приложения снова действует', async () => {
    const buy = await h.call(BUY_PKG, { user: GUEST_2, params: { id: (await h.q("select id from bl.tariff_packages where club_id = $1 and active order by created_at limit 1", [CLUB_A]))[0].id }, body: { method: 'sbp' }, idempotencyKey: newKey() });
    await emuSucceed(buy.json.payment_id);
    const lot = (await h.q('select * from bl.balance_lots where payment_id = $1', [buy.json.payment_id]))[0];
    const rr = await h.call(REFUND_LOT, { user: OWNER_A, params: { id: lot.id }, body: { reason: 'Передумал' } });
    assert.equal(rr.status, 200, JSON.stringify(rr.json));
    const f = (await h.q('select * from bl.refunds where id = $1', [rr.json.refund_id]))[0];
    // Эмулятор проводит возврат сразу; отмену имитируем: возврат снова pending, ЮKassa сообщает canceled.
    await h.pool.query("update bl.refunds set status = 'pending' where id = $1", [f.id]);
    await asSystem((db) => applyRefundStatus(db, deps, { ...f, status: 'pending' }, 'canceled'));
    const ev = (await h.outbox('payment.refund_canceled')).filter((e) => e.payload.refund_id === f.id);
    assert.equal(ev.length, 1);
    assert.deepEqual(ev[0].payload, { refund_id: f.id, payment_id: f.payment_id, club_id: CLUB_A, amount_kopecks: Number(f.amount_kopecks), lots_restored: [lot.id] });
    const al = h.alarms.items.filter((x) => x.type === 'refund_canceled' && x.data.refund_id === f.id);
    assert.equal(al.length, 1);
    assert.equal(al[0].level, 'critical');
    const l2 = (await h.q('select * from bl.balance_lots where id = $1', [lot.id]))[0];
    assert.deepEqual({ m: l2.minutes_left, r: l2.revoked_at }, { m: l2.minutes_total, r: null });
    assert.equal((await h.audit('package.restored')).filter((x) => x.data.lot_id === lot.id).length, 1);
    // Отменённый возврат не в лимите: возврат пакета можно провести снова.
    // Наш лимит пропускает (отменённый не в «уже возвращено»), запрос уходит в ЮKassa с новым ключом
    // pkr-<lot>-1; эмулятор деньги уже вернул (отмену мы имитировали) и отказывает — у настоящей
    // ЮKassa после отмены возврата остаток платежа снова доступен.
    const emuBefore = (await (await fetch(`${h.emuBase}/__emu/requests`)).json()).length;
    const again = await h.call(REFUND_LOT, { user: OWNER_A, params: { id: lot.id }, body: { reason: 'Повтор после отмены' } });
    assert.deepEqual([again.status, again.json], [409, { error: 'payment_failed' }]);
    const sent = (await (await fetch(`${h.emuBase}/__emu/requests`)).json()).slice(emuBefore).filter((x) => x.path === '/v3/refunds');
    assert.deepEqual(sent.map((x) => x.idempotence_key), [`pkr-${lot.id}-1`]);
    assert.equal((await h.q('select minutes_left from bl.balance_lots where id = $1', [lot.id]))[0].minutes_left, lot.minutes_total, 'отказ — откат, партия действует');
  });

  it('п. 4: зависший pending-возврат — сверка опрашивает ЮKassa', async () => {
    await freeTable();
    const q = await h.call(QUOTE, { user: GUEST_1, body: { resource_id: t, kind: 'start', minutes: 60 } });
    const pay = await h.call(PAY, { user: GUEST_1, params: { id: q.json.quote_id }, body: { method: 'sbp' }, idempotencyKey: newKey() });
    await emuSucceed(pay.json.payment_id);
    const p = await payment(pay.json.payment_id);
    const remote = await asSystem(async (db) => {
      const client = clientFor(await loadPaymentSettings(db, CLUB_A), h.config);
      const item = { description: 'Тест', quantity: 1, amount: { value: '1.00', currency: 'RUB' }, vat_code: 1, payment_mode: 'full_payment', payment_subject: 'service' };
      return client.createRefund({ payment_id: p.provider_payment_id, amount: { value: '1.00', currency: 'RUB' }, description: 'тест', receipt: { customer: { phone: '79990000001' }, items: [item] } }, `t-${newKey().slice(0, 30)}`);
    });
    const f = (await h.q(
      `insert into bl.refunds (club_id, payment_id, provider_refund_id, idempotence_key, amount_kopecks, status, reason, created_at, updated_at)
       values ($1, $2, $3, $4, 100, 'pending', 'тест сверки', $5, $5) returning *`,
      [CLUB_A, p.id, remote.id, `t-${newKey().slice(0, 30)}`, new Date(h.clock.now().getTime() - 5 * 60_000)],
    ))[0];
    await runTick();
    assert.equal((await h.q('select status from bl.refunds where id = $1', [f.id]))[0].status, 'succeeded');
  });

  it('п. 6: чек зачёта pending — сверка опрашивает ЮKassa; «Повторить» сбрасывает provider_receipt_id', async () => {
    const rec = (await h.q("select * from bl.receipts where club_id = $1 and channel = 'yookassa' and settles_payment_id is not null and status = 'succeeded' and provider_receipt_id is not null limit 1", [CLUB_A]))[0];
    await h.pool.query("update bl.receipts set status = 'pending', updated_at = $2 where id = $1", [rec.id, new Date(h.clock.now().getTime() - 5 * 60_000)]);
    await runTick();
    assert.equal((await h.q('select status from bl.receipts where id = $1', [rec.id]))[0].status, 'succeeded');
    await h.pool.query("update bl.receipts set status = 'failed' where id = $1", [rec.id]);
    const r = await h.call(RETRY, { user: OWNER_A, club: CLUB_A, params: { id: rec.id }, body: { reason: 'ЮKassa отменила чек' }, idempotencyKey: newKey() });
    assert.equal(r.json.retried, true);
    const after = (await h.q('select status, provider_receipt_id from bl.receipts where id = $1', [rec.id]))[0];
    assert.deepEqual(after, { status: 'receipt_pending', provider_receipt_id: null });
    await h.pool.query("update bl.outbox set processed_at = now() where topic = $1 and processed_at is null", [SETTLE_TOPIC]);
  });

  it('п. 7: возврат наличных без открытой смены ждёт смены — тревога и ресепшену; после открытия проводится в новой смене', async () => {
    const p = (await h.q(
      `insert into bl.payments (club_id, resource_id, user_id, kind, provider, method, idempotence_key, status, amount_kopecks, capture, minutes, confirmed_at, captured_at, created_at, updated_at)
       values ($1, $2, $3, 'start', 'reception', 'cash', $4, 'succeeded', 50000, true, 60, now(), now(), now(), now()) returning *`,
      [CLUB_A, t, GUEST_1, `rc-${newKey()}`],
    ))[0];
    const noShift = { ...deps, shifts: { currentShift: async () => null } };
    const kktBefore = kktCalls.length;
    const q = await asSystem((db) => refund(db, { paymentId: p.id, amountKopecks: 20000, reason: 'Недоиграно' }, { deps: noShift, config: h.config }));
    assert.equal(q.status, 'queued');
    assert.equal((await h.q('select count(*)::int as n from bl.refunds where payment_id = $1', [p.id]))[0].n, 0, 'в смену без кассира не попал');
    assert.ok(h.alarms.items.some((a) => a.type === 'cash_refund_awaiting_shift' && a.data.pending_id === q.pending_id));
    assert.ok(h.notes.items.some((n) => n.kind === 'cash_refund' && n.roles?.includes('reception') && n.data.pending_id === q.pending_id));
    // Повтор и лимит учитывают ожидающий возврат.
    assert.equal((await asSystem((db) => refund(db, { paymentId: p.id, amountKopecks: 20000, reason: 'Недоиграно' }, { deps: noShift, config: h.config }))).pending_id, q.pending_id);
    await assert.rejects(asSystem((db) => refund(db, { paymentId: p.id, amountKopecks: 30001, reason: 'больше' }, { deps: noShift, config: h.config })), (e) => e.code === 'limit_exceeded');
    await runTick(noShift);
    assert.equal((await h.q('select done_at from bl.cash_refunds_pending where id = $1', [q.pending_id]))[0].done_at, null);
    const withShift = { ...deps, shifts: { currentShift: async () => ({ id: newKey(), opened_by_name: 'Анна' }) } };
    h.clock.advance(2 * 60_000);
    try {
      await runTick(withShift);
    } finally {
      h.clock.advance(-2 * 60_000);
    }
    const pend = (await h.q('select * from bl.cash_refunds_pending where id = $1', [q.pending_id]))[0];
    assert.ok(pend.done_at && pend.refund_id);
    const f = (await h.q('select * from bl.refunds where id = $1', [pend.refund_id]))[0];
    assert.deepEqual({ s: f.status, a: Number(f.amount_kopecks) }, { s: 'manual', a: 20000 });
    const call = kktCalls.slice(kktBefore).find((c) => c.refundId === f.id);
    assert.deepEqual({ k: call.kind, op: call.operatorName, pay: call.payments }, { k: 'sell_refund', op: 'Анна', pay: [{ method: 'cash', amount_kopecks: 20000 }] });
  });

  it('п. 11: сбой сверки откатывает её частичные записи (точка сохранения), checked_at отмечен', async () => {
    await freeTable();
    const cfg = await (await fetch(`${h.emuBase}/__emu/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    const hookUrl = cfg.config.webhookUrl;
    const q = await h.call(QUOTE, { user: GUEST_1, body: { resource_id: t, kind: 'start', minutes: 60 } });
    const r = await h.call(PAY, { user: GUEST_1, params: { id: q.json.quote_id }, body: { method: 'sbp' }, idempotencyKey: newKey() });
    const p = await payment(r.json.payment_id);
    await fetch(`${h.emuBase}/__emu/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ webhook_url: 'http://127.0.0.1:9/none' }) });
    try {
      await fetch(`${h.emuBase}/__emu/payments/${p.provider_payment_id}/succeed`, { method: 'POST' });
    } finally {
      await fetch(`${h.emuBase}/__emu/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ webhook_url: hookUrl }) });
    }
    const broken = { ...deps, outbox: { ...deps.outbox, enqueue: async (db, topic, payload) => { if (topic === 'payment.confirmed') throw new Error('outbox down'); return deps.outbox.enqueue(db, topic, payload); } } };
    h.clock.advance(2 * 60_000);
    try {
      await runTick(broken);
    } finally {
      h.clock.advance(-2 * 60_000);
    }
    const after = await payment(p.id);
    assert.deepEqual({ s: after.status, c: after.confirmed_at }, { s: 'pending', c: null }, 'статус не закоммичен без события');
    assert.ok(after.checked_at);
    h.clock.advance(4 * 60_000);
    try {
      await runTick();
    } finally {
      h.clock.advance(-4 * 60_000);
    }
    assert.equal((await payment(p.id)).status, 'succeeded');
    assert.equal((await h.outbox('payment.confirmed')).filter((e) => e.payload.payment_id === p.id).length, 1);
  });
});

describe('pendingPlayUntil для брони', () => {
  it('живая котировка → её конец; оплата в ожидании → сейчас + минуты; подтверждено или нет ничего — null', async () => {
    const t = T(2);
    h.sessions.holds.delete(t);
    for (const [sid, x] of h.sessions.sessions) if (x.resource_id === t) h.sessions.sessions.delete(sid);
    await h.pool.query("update bl.sessions set status = 'closed', ended_at = coalesce(ended_at, now()), close_reason = coalesce(close_reason, 'stopped') where resource_id = $1 and status <> 'closed'", [t]);
    // Старые котировки и платежи этого стола из других тестов — вне окна: сдвигаем часы на 2 часа.
    h.clock.advance(2 * 3600_000);
    try {
      const now = () => h.clock.now();
      const until = () => asAppApi(h.pool, { clubId: CLUB_A, actorType: 'system' }, (db) => pendingPlayUntil(db, { resourceId: t, now: now() }));
      assert.equal(await until(), null);
      const q = await h.call(QUOTE, { user: GUEST_1, body: { resource_id: t, kind: 'start', minutes: 60 } });
      assert.equal(q.status, 200, JSON.stringify(q.json));
      const qr = (await h.q('select valid_until from bl.quotes where id = $1', [q.json.quote_id]))[0];
      assert.equal((await until()).toISOString(), new Date(new Date(qr.valid_until).getTime() + 60 * 60_000).toISOString());
      const r = await h.call(PAY, { user: GUEST_1, params: { id: q.json.quote_id }, body: { method: 'sbp' }, idempotencyKey: newKey() });
      assert.equal((await until()).toISOString(), new Date(now().getTime() + 60 * 60_000).toISOString(), 'платёж в ожидании');
      await emuSucceed(r.json.payment_id);
      assert.equal(await until(), null, 'подтверждено — время уже у сессии');
    } finally {
      h.clock.advance(-2 * 3600_000);
    }
  });
});

describe('замечания light: id чужой игры и booking_start_required', () => {
  it('GET /api/t/{code}: аноним не видит session_id; вошедший — видит (присоединиться с кодом), my_session_id — только участник', async () => {
    const t = T(2);
    h.sessions.holds.delete(t);
    for (const [sid, x] of h.sessions.sessions) if (x.resource_id === t) h.sessions.sessions.delete(sid);
    const sid = await session(t, { paidUntil: '2026-10-20T09:00:00Z', participants: [GUEST_1] });
    try {
      const anon = await h.call(TABLE_ROUTE, { params: { code: 'TEST000002' } });
      assert.equal(anon.json.status, 'busy');
      assert.deepEqual({ s: anon.json.session_id, m: anon.json.my_session_id }, { s: null, m: null });
      const other = await h.call(TABLE_ROUTE, { user: GUEST_2, params: { code: 'TEST000002' } });
      assert.deepEqual({ s: other.json.session_id, m: other.json.my_session_id }, { s: sid, m: null });
      const mine = await h.call(TABLE_ROUTE, { user: GUEST_1, params: { code: 'TEST000002' } });
      assert.deepEqual({ s: mine.json.session_id, m: mine.json.my_session_id }, { s: sid, m: sid });
    } finally {
      h.sessions.sessions.delete(sid);
      await h.pool.query("update bl.sessions set status = 'closed', ended_at = now(), close_reason = 'stopped' where id = $1", [sid]);
    }
  });

  it('стол ждёт брони гостя: 409 {error: booking_start_required, booking_id}; лишние поля не уходят', async () => {
    const t = T(2);
    h.sessions.holds.delete(t);
    const bookingId = newKey();
    const orig = h.sessions.holdPending;
    h.sessions.holdPending = async () => {
      throw Object.assign(new Error('booking'), { code: 'booking_start_required', data: { booking_id: bookingId, phone: '+79990000001' } });
    };
    try {
      const r = await h.call(QUOTE, { user: GUEST_1, body: { resource_id: t, kind: 'start', minutes: 60 } });
      assert.deepEqual([r.status, r.json], [409, { error: 'booking_start_required', booking_id: bookingId }]);
    } finally {
      h.sessions.holdPending = orig;
    }
  });
});

function formatRub(k) {
  return `${Math.floor(k / 100)}.${String(k % 100).padStart(2, '0')}`;
}
