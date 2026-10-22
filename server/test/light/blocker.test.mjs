// Блокер ревью (инвариант 4): после «Продолжить» и повторного открытия неотыгранное считается
// только от начала нового отрезка, а не от started_at.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createTestDb, GUEST, makePayment, MIN, SKIP, startLight } from './harness.mjs';

describe('неотыгранное после «Продолжить» и повторного открытия', { skip: SKIP }, () => {
  let t;
  let h;
  let svc;
  before(async () => {
    t = await createTestDb();
    h = await startLight(t, { devices: [1, 2] });
    svc = h.st.service;
  });
  after(async () => {
    await h?.stop();
    await t?.drop();
  });

  async function start(resource, user = GUEST(1), minutes = 30) {
    const pay = await makePayment(t, { resource, user, minutes, at: h.time.now() });
    const res = await h.outbox.deliver('payment.confirmed', pay);
    await h.until(() => h.ctl.get(resource).received.some((c) => c.type === 'session.start' && c.body.session_id === res.session_id), 'свет');
    return res.session_id;
  }
  const session = async (id) => (await t.q('select * from bl.sessions where id = $1', [id])).rows[0];

  it('блокер: «Продолжить», контроллер не подтвердил — повторное прерывание с прежним долгом, возврат только его', async () => {
    const sid = await start(1, GUEST(1), 60); // 80 000 коп. за 60 минут
    const c = h.ctl.get(1);
    await h.advance(30 * MIN);
    await c.disconnect();
    // Контроллер подтвердил только 30 минут света (например, обрыв питания без связи).
    await t.q("update bl.sessions set device_paid_until = started_at + interval '30 minutes' where id = $1", [sid]);
    await h.advance(3 * MIN);
    await c.reboot();
    await h.until(async () => (await session(sid)).status === 'interrupted', 'interrupted');
    assert.equal(Number((await session(sid)).unplayed_ms), 30 * MIN);
    await h.advance(10 * MIN);
    c.auto = false; // session.start после «Продолжить» не доходит
    await h.asUser(GUEST(1), (db) => svc.resolve(db, { sessionId: sid, userId: GUEST(1), choice: 'continue' }));
    await h.advance(33 * MIN);
    const s = await session(sid);
    assert.equal(s.status, 'interrupted');
    assert.equal(Number(s.unplayed_ms), 30 * MIN, 'долг не вырос (было бы 73 минуты от started_at)');
    c.auto = true;
    await h.asUser(GUEST(1), (db) => svc.resolve(db, { sessionId: sid, userId: GUEST(1), choice: 'refund' }));
    const pid = (await t.q('select payment_id from bl.session_payments where session_id = $1', [sid])).rows[0].payment_id;
    assert.deepEqual(h.refunds.filter((r) => r.paymentId === pid), [{ paymentId: pid, amountKopecks: 40_000, reason: 'interrupted' }], 'половина, а не весь платёж');
    await h.until(() => c.received.at(-1)?.type === 'state.free' || !c.lit, 'стол свободен');
  });

  it('блокер: повторное открытие после закрытия — отыгранный платёж в возврат не попадает', async () => {
    const sid = await start(2, GUEST(1), 10);
    const c = h.ctl.get(2);
    await h.advance(12 * MIN + 1_000);
    assert.equal((await session(sid)).close_reason, 'expired');
    c.auto = false;
    const ext = await makePayment(t, { kind: 'extend', resource: 2, sessionId: sid, minutes: 10, amount: 15_000, at: h.time.now() });
    assert.equal((await h.outbox.deliver('payment.confirmed', ext)).result, 'reopened');
    await h.advance(12 * MIN + 1_000);
    const s = await session(sid);
    assert.equal(s.status, 'interrupted');
    assert.equal(Number(s.unplayed_ms), 10 * MIN);
    c.auto = true;
    await h.asUser(GUEST(1), (db) => svc.resolve(db, { sessionId: sid, userId: GUEST(1), choice: 'refund' }));
    const pays = (await t.q('select payment_id from bl.session_payments where session_id = $1', [sid])).rows.map((r) => r.payment_id);
    assert.deepEqual(h.refunds.filter((r) => pays.includes(r.paymentId)), [{ paymentId: ext.payment_id, amountKopecks: 15_000, reason: 'interrupted' }]);
  });

});
