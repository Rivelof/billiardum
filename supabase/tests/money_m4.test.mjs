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
