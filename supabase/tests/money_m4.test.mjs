// Деньги M4 (контракт m4.md, решение №138): взнос за турнир — платёж ЮKassa kind tournament с
// чеком «полный расчёт» (услуга), payment.confirmed {kind: 'tournament', entry_id, tournament_id};
// возврат записи целиком с чеком возврата (идемпотентно); отмена турнира клубом — возврат по
// одному на запись через outbox. Турнирный матч (сессия без плательщика): депозит и продление
// оплатой — отказ без падения. Настоящий Postgres и эмулятор ЮKassa.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { routes as quoteRoutes } from '../../api/routes/quotes.mjs';
import { routes as webhookRoutes } from '../../api/routes/webhooks.mjs';
import { createTournamentFee, refundTournamentFee, refundTournamentFees, takeDeposit } from '../../server/payments/api.mjs';
import { resolveDeps } from '../../server/payments/deps.mjs';
import { TOURNAMENT_REFUND_TOPIC } from '../../server/payments/tournaments.mjs';
import { withContext } from '../../server/lib/store.mjs';
import { CLUB_A, GUEST_1, GUEST_2, newKey, RECEPTION_A, setupMoney } from './money_harness.mjs';

const route = (list, method, path) => list.find((r) => r.method === method && r.path === path);
const QUOTE = route(quoteRoutes, 'POST', '/api/quotes');
const WEBHOOK = route(webhookRoutes, 'POST', '/api/webhooks/yookassa/{club_id}');
const START = '2026-10-20T08:00:00.000Z';
const TABLE = 'e1000000-0000-4000-8000-000000000006';

let h;
let deps;
const inj = () => ({ deps, config: h.config });
const asClub = (fn) =>
  withContext(h.pool, { clubId: CLUB_A, actorType: 'system' }, async (db) => {
    await db.query('set local role app_api');
    return fn(db);
  });
const payment = async (id) => (await h.q('select * from bl.payments where id = $1', [id]))[0];
const emuPayment = async (providerId) => (await fetch(`${h.emuBase}/__emu/payments/${providerId}`)).json();

async function emuSucceed(paymentId) {
  const p = await payment(paymentId);
  await fetch(`${h.emuBase}/__emu/payments/${p.provider_payment_id}/succeed?wait=1`, { method: 'POST' });
  await h.emu.settle();
}

before(async () => {
  h = await setupMoney({ start: START });
  h.setWebhookRoute(WEBHOOK);
  h.ctx.kktApi = { async enqueueReceipt() { return null; } };
  deps = await resolveDeps(h.ctx);
});

after(async () => {
  await h?.close();
});

const fee = (over = {}) =>
  asClub((db) =>
    createTournamentFee(
      db,
      { clubId: CLUB_A, tournamentId: over.tournamentId ?? T1, entryId: over.entryId ?? E1, amountKopecks: 50000, customer: { phone: '+79990000001' }, userId: GUEST_1, title: 'Кубок клуба', ...over },
      inj(),
    ),
  );
const T1 = newKey();
const E1 = newKey();

describe('взнос за турнир', () => {
  it('проверка входа: UUID, сумма, контакт для чека, return_url только своего сайта', async () => {
    for (const bad of [{ entryId: 'x' }, { amountKopecks: 0 }, { customer: {} }, { customer: { email: 'не почта' } }, { returnUrl: 'https://evil.example/app' }, { method: 'cash' }]) {
      await assert.rejects(fee({ ...bad, entryId: bad.entryId ?? newKey() }), (e) => e.code === 'bad_request', JSON.stringify(bad));
    }
  });

  it('платёж kind tournament: чек «полный расчёт», услуга участия; повтор — тот же; оплата → payment.confirmed с entry_id; ещё раз — already_paid', async () => {
    const r = await fee({ returnUrl: '/app/tournaments/1?paid=1' });
    assert.equal(r.confirmation.type, 'redirect');
    const p = await payment(r.payment.id);
    assert.deepEqual(
      { k: p.kind, t: p.tournament_id, e: p.entry_id, res: p.resource_id, u: p.user_id, a: Number(p.amount_kopecks), c: p.capture },
      { k: 'tournament', t: T1, e: E1, res: null, u: GUEST_1, a: 50000, c: true },
    );
    const emuP = await emuPayment(p.provider_payment_id);
    assert.deepEqual(emuP.receipt.items[0], {
      description: 'Участие в турнире «Кубок клуба»',
      quantity: 1,
      amount: { value: '500.00', currency: 'RUB' },
      vat_code: 1,
      payment_mode: 'full_payment',
      payment_subject: 'service',
    });
    assert.deepEqual(emuP.receipt.customer, { phone: '79990000001' });
    assert.deepEqual({ t: emuP.metadata.tournament_id, e: emuP.metadata.entry_id, k: emuP.metadata.kind }, { t: T1, e: E1, k: 'tournament' });
    assert.equal(emuP.confirmation.return_url, 'https://billiardum.test/app/tournaments/1?paid=1');
    assert.equal((await fee()).payment.id, p.id, 'брошенная попытка с той же суммой — та же');
    await emuSucceed(p.id);
    assert.equal((await payment(p.id)).status, 'succeeded');
    const ev = (await h.outbox('payment.confirmed')).filter((e) => e.payload.payment_id === p.id);
    assert.equal(ev.length, 1);
    assert.deepEqual({ k: ev[0].payload.kind, e: ev[0].payload.entry_id, t: ev[0].payload.tournament_id }, { k: 'tournament', e: E1, t: T1 });
    await assert.rejects(fee(), (e) => e.code === 'already_paid');
  });

  it('возврат записи целиком с чеком возврата (как чек продажи); повтор — тот же возврат; неоплаченная — not_paid', async () => {
    await assert.rejects(asClub((db) => refundTournamentFee(db, { entryId: E1, reason: ' ' }, inj())), (e) => e.code === 'reason_required');
    const r = await asClub((db) => refundTournamentFee(db, { entryId: E1, reason: 'Игрок снялся до закрытия записи' }, inj()));
    assert.equal(r.status, 'refunded');
    assert.equal(r.amount_kopecks, 50000);
    assert.equal(r.refunds.length, 1);
    const p = (await h.q("select * from bl.payments where entry_id = $1 and status = 'succeeded'", [E1]))[0];
    const f = (await h.q('select * from bl.refunds where id = $1', [r.refunds[0].refund_id]))[0];
    assert.deepEqual({ k: f.idempotence_key, a: Number(f.amount_kopecks), kind: f.kind }, { k: `trn-${p.id}`, a: 50000, kind: 'refund' });
    const emuP = await emuPayment(p.provider_payment_id);
    assert.deepEqual(emuP.refunded_amount, { value: '500.00', currency: 'RUB' });
    const sale = (await h.q("select items from bl.receipts where payment_id = $1 and kind = 'sale'", [p.id]))[0];
    const ret = (await h.q("select * from bl.receipts where refund_id = $1 and kind = 'refund'", [f.id]))[0];
    assert.deepEqual(ret.items, sale.items);
    assert.equal((await h.audit('payment.refunded')).filter((a) => a.object_id === p.id && a.reason === 'Игрок снялся до закрытия записи').length, 1);
    const again = await asClub((db) => refundTournamentFee(db, { entryId: E1, reason: 'Игрок снялся до закрытия записи' }, inj()));
    assert.equal(again.refunds[0].refund_id, f.id);
    assert.deepEqual((await emuPayment(p.provider_payment_id)).refunded_amount, { value: '500.00', currency: 'RUB' }, 'второго возврата нет');
    // После возврата запись можно оплатить снова (новая попытка).
    const re = await fee();
    assert.notEqual(re.payment.id, p.id);
    const none = await asClub((db) => refundTournamentFee(db, { entryId: newKey(), reason: 'нет оплаты' }, inj()));
    assert.deepEqual(none, { entry_id: none.entry_id, status: 'not_paid', refunds: [], amount_kopecks: 0 });
  });

  it('контакт — почта: чек продажи и чек возврата с email', async () => {
    const entry = newKey();
    const r = await fee({ entryId: entry, customer: { email: 'player@example.ru' }, userId: null, method: 'card' });
    const p = await payment(r.payment.id);
    assert.deepEqual((await emuPayment(p.provider_payment_id)).receipt.customer, { email: 'player@example.ru' });
    assert.equal((await h.q("select customer_email from bl.receipts where payment_id = $1 and kind = 'sale'", [p.id]))[0].customer_email, 'player@example.ru');
    await emuSucceed(p.id);
    const back = await asClub((db) => refundTournamentFee(db, { entryId: entry, reason: 'Отмена записи' }, inj()));
    assert.equal(back.status, 'refunded');
    const emuR = (await (await fetch(`${h.emuBase}/__emu/requests`)).json()).filter((x) => x.path === '/v3/refunds' && x.idempotence_key === `trn-${p.id}`);
    assert.equal(emuR.length, 1);
  });

  it('paymentId: возврат только лишней попытки; остальная оплата записи цела; повтор — без второго возврата', async () => {
    const entry = newKey();
    const a = await fee({ entryId: entry }); // СБП, гость бросил
    const b = await fee({ entryId: entry, method: 'card' }); // новая попытка картой
    assert.notEqual(a.payment.id, b.payment.id);
    await emuSucceed(b.payment.id);
    await emuSucceed(a.payment.id); // гость всё же оплатил и старую — лишняя оплата
    assert.deepEqual([(await payment(a.payment.id)).status, (await payment(b.payment.id)).status], ['succeeded', 'succeeded']);
    await assert.rejects(asClub((db) => refundTournamentFee(db, { entryId: entry, paymentId: newKey(), reason: 'x' }, inj())), (e) => e.code === 'not_found');
    await assert.rejects(asClub((db) => refundTournamentFee(db, { entryId: entry, paymentId: a.payment.id, reason: 'x', reasonCode: 'Bad Code' }, inj())), (e) => e.code === 'bad_request');
    const r = await asClub((db) => refundTournamentFee(db, { entryId: entry, paymentId: a.payment.id, reason: 'Лишняя повторная оплата', reasonCode: 'duplicate_payment' }, inj()));
    assert.deepEqual(r.refunds.map((x) => x.payment_id), [a.payment.id]);
    assert.equal((await h.q('select count(*)::int as n from bl.refunds where payment_id = $1', [b.payment.id]))[0].n, 0, 'вторая оплата не тронута');
    const again = await asClub((db) => refundTournamentFee(db, { entryId: entry, paymentId: a.payment.id, reason: 'Лишняя повторная оплата' }, inj()));
    assert.equal(again.refunds[0].refund_id, r.refunds[0].refund_id);
    // Без paymentId — все оплаченные попытки; уже возвращённая — тем же возвратом, не дважды.
    const all = await asClub((db) => refundTournamentFee(db, { entryId: entry, reason: 'Игрок снялся' }, inj()));
    assert.deepEqual(all.refunds.map((x) => x.payment_id).sort(), [a.payment.id, b.payment.id].sort());
    assert.equal((await h.q('select count(*)::int as n from bl.refunds where payment_id = $1', [a.payment.id]))[0].n, 1);
    assert.equal((await h.q('select count(*)::int as n from bl.refunds where payment_id = $1', [b.payment.id]))[0].n, 1);
  });

  it('отмена турнира клубом: событие на каждую оплаченную запись (неоплаченная — без события); обработчик возвращает каждую', async () => {
    const T2 = newKey();
    const [e1, e2, e3] = [newKey(), newKey(), newKey()];
    for (const e of [e1, e2]) {
      const r = await fee({ tournamentId: T2, entryId: e });
      await emuSucceed(r.payment.id);
    }
    await fee({ tournamentId: T2, entryId: e3 }); // не оплачена
    await assert.rejects(asClub((db) => refundTournamentFees(db, { tournamentId: T2, reason: '' }, inj())), (e) => e.code === 'reason_required');
    const q = await asClub((db) => refundTournamentFees(db, { tournamentId: T2, reason: 'Турнир отменён клубом' }, inj()));
    assert.deepEqual(q.entries.sort(), [e1, e2].sort());
    const evs = (await h.outbox(TOURNAMENT_REFUND_TOPIC)).filter((e) => e.payload.tournament_id === T2);
    assert.equal(evs.length, 2);
    // Обработчик outbox (как money index) — повтор события безопасен.
    for (const ev of [...evs, evs[0]]) {
      await asClub((db) => refundTournamentFee(db, { entryId: ev.payload.entry_id, reason: ev.payload.reason }, inj()));
    }
    const refunds = await h.q("select f.* from bl.refunds f join bl.payments p on p.id = f.payment_id where p.tournament_id = $1", [T2]);
    assert.equal(refunds.length, 2);
    assert.ok(refunds.every((f) => f.reason === 'Турнир отменён клубом' && Number(f.amount_kopecks) === 50000));
  });
});

describe('турнирный матч без плательщика (light source tournament)', () => {
  let sid;
  before(async () => {
    const { rows } = await h.pool.query(
      `insert into bl.sessions (club_id, resource_id, status, source, payer_user_id, unlimited, started_at, paid_until, match_id, created_at, updated_at)
       values ($1, $2, 'active', 'tournament', null, false, $3, $4, $5, $3, $3) returning id`,
      [CLUB_A, TABLE, START, '2026-10-20T10:00:00Z', newKey()],
    );
    sid = rows[0].id;
    h.sessions.sessions.set(sid, { id: sid, resource_id: TABLE, paid_until: new Date('2026-10-20T10:00:00Z'), status: 'active', participants: new Set([GUEST_1]), payer: null, unlimited: false });
    await h.pool.query('insert into bl.shifts (club_id, number, opened_by, opened_at, float_kopecks) values ($1, 7, $2, $3, 0)', [CLUB_A, RECEPTION_A, START]);
  });

  it('депозит к турнирному матчу — table_busy, без падения', async () => {
    await assert.rejects(
      asClub((db) => takeDeposit(db, { clubId: CLUB_A, sessionId: sid, amountKopecks: 100000, staffId: RECEPTION_A }, inj())),
      (e) => e.code === 'table_busy',
    );
    assert.equal((await h.q('select count(*)::int as n from bl.payments where session_id = $1', [sid]))[0].n, 0);
  });

  it('продление турнирного матча оплатой — bad_request, без падения', async () => {
    const r = await h.call(QUOTE, { user: GUEST_1, body: { resource_id: TABLE, kind: 'extend', minutes: 60, session_id: sid } });
    assert.deepEqual([r.status, r.json], [400, { error: 'bad_request' }]);
    const other = await h.call(QUOTE, { user: GUEST_2, body: { resource_id: TABLE, kind: 'extend', minutes: 60, session_id: sid } });
    assert.ok([400, 403].includes(other.status));
  });
});

describe('Д3: котировка не заходит в окно турнира (№146) — как в бронь', () => {
  const T7 = 'e1000000-0000-4000-8000-000000000007';
  const T8 = 'e1000000-0000-4000-8000-000000000008';
  const windows = []; // { resource, from, to, match_id? }
  const MIN = 60_000;
  const at = (min) => new Date(h.clock.now().getTime() + min * MIN);
  const iso = (min) => at(min).toISOString();
  let nextBooking = null;
  before(() => {
    h.ctx.tournamentsApi = {
      async tournamentHolds(_db, { resourceId, from, to }) {
        return windows
          .filter((w) => w.resource === resourceId && new Date(w.from) < new Date(to) && new Date(w.to) > new Date(from))
          .map((w) => ({ from: w.from, to: w.to, tournament_id: 'f0000000-0000-4000-8000-000000000001', ...(w.match_id ? { match_id: w.match_id } : {}) }));
      },
    };
    h.ctx.bookingsApi = { async nextBookingStart(_db, { resourceId, after }) { return nextBooking && nextBooking.resource === resourceId && nextBooking.at >= new Date(after) ? nextBooking.at : null; } };
  });
  after(() => {
    delete h.ctx.tournamentsApi;
    delete h.ctx.bookingsApi;
  });
  const reset = (list) => {
    windows.length = 0;
    windows.push(...list);
    h.sessions.holds.clear();
  };
  const quote = (body, user = GUEST_2) => h.call(QUOTE, { user, body });
  async function playing(resourceId, paidUntil) {
    const { rows } = await h.pool.query(
      `insert into bl.sessions (club_id, resource_id, status, payer_user_id, unlimited, started_at, paid_until, created_at, updated_at)
       values ($1, $2, 'active', $3, false, $4, $5, $4, $4) returning id`,
      [CLUB_A, resourceId, GUEST_1, h.clock.now(), paidUntil],
    );
    const id = rows[0].id;
    h.sessions.sessions.set(id, { id, resource_id: resourceId, paid_until: paidUntil, status: 'active', participants: new Set([GUEST_1]), payer: GUEST_1, unlimited: false });
    return id;
  }

  it('старт: окно через час — 30 минут можно (extend_limit_until = начало − 5 мин), час — 409 table_busy {reason, busy_until}; «Без лимита» заморожено до окна', async () => {
    reset([{ resource: T7, from: iso(60), to: iso(300) }]);
    const bad = await quote({ resource_id: T7, kind: 'start', minutes: 60 });
    assert.deepEqual([bad.status, bad.json], [409, { error: 'table_busy', reason: 'tournament', busy_until: iso(300) }]);
    assert.equal(h.sessions.holds.has(T7), false, 'стол не удержан');
    const ok = await quote({ resource_id: T7, kind: 'start', minutes: 30 });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.extend_limit_until, iso(55));
    h.sessions.holds.clear();
    const unl = await quote({ resource_id: T7, kind: 'start', minutes: null });
    assert.equal(unl.status, 200, JSON.stringify(unl.json));
    assert.equal(unl.json.unlimited.hold_minutes, 55);
    assert.equal(unl.json.extend_limit_until, iso(55));
  });

  it('котировка за 3 минуты до окна: старт и продление — 409 table_busy, busy_until — конец окна с матчем после него', async () => {
    reset([
      { resource: T7, from: iso(3), to: iso(120) },
      { resource: T7, from: iso(100), to: iso(160), match_id: 'f0000000-0000-4000-8000-0000000000aa' },
    ]);
    const start = await quote({ resource_id: T7, kind: 'start', minutes: 30 });
    assert.deepEqual([start.status, start.json], [409, { error: 'table_busy', reason: 'tournament', busy_until: iso(160) }]);
    const unl = await quote({ resource_id: T7, kind: 'start', minutes: null });
    assert.equal(unl.json.error, 'table_busy');
    reset([{ resource: T8, from: iso(3), to: iso(120) }]);
    const sid = await playing(T8, at(2));
    const ext = await quote({ resource_id: T8, kind: 'extend', minutes: 30, session_id: sid }, GUEST_1);
    assert.deepEqual([ext.status, ext.json], [409, { error: 'table_busy', reason: 'tournament', busy_until: iso(120) }]);
    await h.pool.query("update bl.sessions set status = 'closed', ended_at = $2, close_reason = 'stopped' where id = $1", [sid, h.clock.now()]);
    h.sessions.sessions.delete(sid);
  });

  it('продление: до окна минус 5 минут; больше — 409 table_busy; игра уже зашла в окно — продлить нельзя совсем', async () => {
    reset([{ resource: T8, from: iso(120), to: iso(360) }]);
    const sid = await playing(T8, at(30));
    const ok = await quote({ resource_id: T8, kind: 'extend', minutes: 30, session_id: sid }, GUEST_1);
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.extend_limit_until, iso(115));
    const bad = await quote({ resource_id: T8, kind: 'extend', minutes: 120, session_id: sid }, GUEST_1);
    assert.deepEqual([bad.status, bad.json], [409, { error: 'table_busy', reason: 'tournament', busy_until: iso(360) }]);
    // Оплаченная игра заходит в окно, которое уже началось (доигрывается), — продление 409.
    reset([{ resource: T8, from: iso(-10), to: iso(200) }]);
    const inside = await quote({ resource_id: T8, kind: 'extend', minutes: 30, session_id: sid }, GUEST_1);
    assert.deepEqual([inside.status, inside.json], [409, { error: 'table_busy', reason: 'tournament', busy_until: iso(200) }]);
    await h.pool.query("update bl.sessions set status = 'closed', ended_at = $2, close_reason = 'stopped' where id = $1", [sid, h.clock.now()]);
    h.sessions.sessions.delete(sid);
  });

  it('бронь раньше окна — booking_conflict как прежде; окно раньше брони — table_busy; без окна и брони — без предела', async () => {
    reset([{ resource: T7, from: iso(180), to: iso(400) }]);
    nextBooking = { resource: T7, at: at(60) };
    const b = await quote({ resource_id: T7, kind: 'start', minutes: 120 });
    assert.deepEqual([b.status, b.json], [409, { error: 'booking_conflict' }]);
    nextBooking = { resource: T7, at: at(300) };
    const tw = await quote({ resource_id: T7, kind: 'start', minutes: 180 });
    assert.deepEqual([tw.status, tw.json], [409, { error: 'table_busy', reason: 'tournament', busy_until: iso(400) }]);
    nextBooking = null;
    reset([]);
    const free = await quote({ resource_id: T7, kind: 'start', minutes: 180 });
    assert.equal(free.status, 200, JSON.stringify(free.json));
    assert.equal(free.json.extend_limit_until, null);
  });
});
