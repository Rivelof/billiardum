// Сессии стола на настоящей базе и ускоренных часах (контракт M1 §6, ROADMAP T1, T3, T4).

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CLUB, createTestDb, GUEST, makePayment, MIN, RES, SKIP, startLight } from './harness.mjs';

const OPEN = ['active', 'ending', 'grace'];

describe('сессии: оплата → свет → продление → льгота → закрытие', { skip: SKIP }, () => {
  let t;
  let h;
  before(async () => {
    t = await createTestDb();
    h = await startLight(t);
  });
  after(async () => {
    await h?.stop();
    await t?.drop();
  });

  let sessionId;

  it('payment.confirmed start: сессия active, paid_until = now + minutes, session.start с остатком, журнал, light_latency', async () => {
    const pay = await makePayment(t, { resource: 1, minutes: 30, at: h.time.now() });
    const res = await h.outbox.deliver('payment.confirmed', pay);
    assert.equal(res.result, 'started');
    sessionId = res.session_id;
    const { rows } = await t.q('select status, paid_until, started_at, payer_user_id from bl.sessions where id = $1', [sessionId]);
    assert.equal(rows[0].status, 'active');
    assert.equal(rows[0].paid_until.getTime() - rows[0].started_at.getTime(), 30 * MIN);
    assert.equal(rows[0].payer_user_id, GUEST(1));
    const c = h.ctl.get(1);
    await h.until(() => c.received.some((x) => x.type === 'session.start'), 'session.start');
    const start = c.received.find((x) => x.type === 'session.start');
    assert.equal(start.body.session_id, sessionId);
    assert.equal(start.body.remaining_ms, 30 * MIN);
    assert.deepEqual(start.body.warn_ms, [300_000, 60_000]);
    assert.equal(start.body.grace_ms, 120_000);
    assert.equal(typeof start.body.buzzer, 'boolean');
    assert.ok(c.lit, 'свет горит');
    await h.until(() => h.logs('light_latency').length === 1, 'light_latency');
    const lat = h.logs('light_latency')[0];
    assert.equal(lat.session_id, sessionId);
    assert.equal(typeof lat.ms, 'number');
    // Журнал: session.start и device.cmd с id и seq команды.
    const audit = await t.q("select action, data from bl.audit_log where club_id = $1 and action in ('session.start', 'device.cmd') order by seq", [CLUB]);
    const cmd = audit.rows.find((r) => r.action === 'device.cmd' && r.data.type === 'session.start');
    assert.ok(cmd, 'device.cmd session.start');
    assert.equal(cmd.data.cmd_id, start.id);
    assert.equal(cmd.data.seq, start.seq);
    assert.equal(cmd.data.session_id, sessionId);
    assert.ok(audit.rows.some((r) => r.action === 'session.start' && r.data.payment_id === pay.payment_id));
    const dc = await t.q('select status, seq, acked_at from bl.device_commands where id = $1', [start.id]);
    assert.equal(dc.rows[0].status, 'acked');
    const ob = await t.q("select topic from bl.outbox where topic like 'session.%' order by id");
    assert.deepEqual(ob.rows.map((r) => r.topic), ['session.started']);
    // SSE session — только общие поля, без зависящего от зрителя is_payer.
    await h.until(() => h.sse.events.some((e) => e.channel === `session:${sessionId}` && e.event === 'session'), 'SSE session');
    for (const e of h.sse.events.filter((x) => x.channel === `session:${sessionId}` && x.event === 'session')) {
      assert.ok(!('is_payer' in e.data), 'is_payer не уходит в SSE');
      assert.equal(e.data.id, sessionId);
      assert.equal(e.data.club.timezone, 'Asia/Yekaterinburg');
    }
    const sp = await t.q('select session_id from bl.payments where id = $1', [pay.payment_id]);
    assert.equal(sp.rows[0].session_id, sessionId, 'платёж связан с сессией');
  });

  it('повтор payment.confirmed (доставка хотя бы один раз) ничего не меняет', async () => {
    const before = h.ctl.get(1).received.length;
    const { rows } = await t.q('select payment_id from bl.session_payments where session_id = $1', [sessionId]);
    const pay = { payment_id: rows[0].payment_id, club_id: CLUB, kind: 'start', resource_id: RES(1), user_id: GUEST(1), minutes: 30, amount_kopecks: 80_000, method: 'sbp' };
    const res = await h.outbox.deliver('payment.confirmed', pay);
    assert.equal(res.result, 'duplicate');
    const n = await t.q('select count(*)::int as n from bl.sessions');
    assert.equal(n.rows[0].n, 1);
    await h.settle();
    assert.equal(h.ctl.get(1).received.length, before);
  });

  it('T−10: уведомление «осталось 10 минут» с действием extend; T−5: ending', async () => {
    await h.advance(20 * MIN + 1_000);
    const n = await t.q("select kind, text, data from bl.notifications where kind like 'session.%' order by created_at");
    assert.deepEqual(n.rows.map((r) => r.kind), ['session.t10']);
    assert.match(n.rows[0].text, /Стол 1: осталось (10|9) минут/);
    assert.equal(n.rows[0].data.action, 'extend');
    assert.ok(!/\+7/.test(n.rows[0].text), 'без телефонов');
    await h.advance(5 * MIN);
    const s = await t.q('select status from bl.sessions where id = $1', [sessionId]);
    assert.equal(s.rows[0].status, 'ending');
  });

  it('T3: продление любым участником за 3 минуты до конца: paid_until += minutes, session.extend', async () => {
    await h.advance(2 * MIN - 1_000); // T−3
    const before = (await t.q('select paid_until from bl.sessions where id = $1', [sessionId])).rows[0].paid_until;
    const pay = await makePayment(t, { kind: 'extend', resource: 1, user: GUEST(2), sessionId, minutes: 10, amount: 15_000, at: h.time.now() });
    const res = await h.outbox.deliver('payment.confirmed', pay);
    assert.equal(res.result, 'extended');
    const { rows } = await t.q('select paid_until, status from bl.sessions where id = $1', [sessionId]);
    assert.equal(rows[0].paid_until.getTime() - before.getTime(), 10 * MIN);
    assert.equal(rows[0].status, 'active', '13 минут — снова active');
    const c = h.ctl.get(1);
    await h.until(() => c.received.some((x) => x.type === 'session.extend'), 'session.extend');
    const ext = c.received.find((x) => x.type === 'session.extend');
    assert.equal(ext.body.remaining_ms, rows[0].paid_until.getTime() - h.time.t);
    const p = await t.q('select user_id, role from bl.session_participants where session_id = $1 order by ordinal', [sessionId]);
    assert.deepEqual(p.rows.map((r) => r.role), ['payer', 'player'], 'плательщик продления — участник');
  });

  it('T4: T−1, T−0 (grace), продление из grace, затем гость молчит: льгота и закрытие, свет гаснет', async () => {
    const c = h.ctl.get(1);
    await h.advance(12 * MIN + 2_000); // T−1 нового paid_until
    let kinds = (await t.q("select kind from bl.notifications where kind like 'session.%' order by created_at")).rows.map((r) => r.kind);
    assert.ok(kinds.includes('session.t1'));
    await h.advance(MIN); // T−0
    const s1 = await t.q('select status from bl.sessions where id = $1', [sessionId]);
    assert.equal(s1.rows[0].status, 'grace');
    kinds = (await t.q("select kind from bl.notifications where kind like 'session.%' order by created_at")).rows.map((r) => r.kind);
    assert.ok(kinds.includes('session.t0'));
    // Продление из льготы (контракт §6): paid_until += minutes.
    await h.advance(30_000);
    const before = (await t.q('select paid_until from bl.sessions where id = $1', [sessionId])).rows[0].paid_until;
    const pay = await makePayment(t, { kind: 'extend', resource: 1, sessionId, minutes: 5, amount: 7_000, at: h.time.now() });
    assert.equal((await h.outbox.deliver('payment.confirmed', pay)).result, 'extended');
    const s2 = await t.q('select status, paid_until from bl.sessions where id = $1', [sessionId]);
    assert.equal(s2.rows[0].paid_until.getTime(), before.getTime() + 5 * MIN);
    assert.equal(s2.rows[0].status, 'ending');
    await h.until(() => c.received.filter((x) => x.type === 'session.extend').length === 2, 'второй session.extend');
    assert.ok(c.lit);
    // Гость молчит: конец, льгота 2 минуты, закрытие.
    await h.advance(5 * MIN);
    assert.equal((await t.q('select status from bl.sessions where id = $1', [sessionId])).rows[0].status, 'grace');
    await h.advance(2 * MIN + 1_000);
    const s3 = await t.q('select status, close_reason, ended_at from bl.sessions where id = $1', [sessionId]);
    assert.equal(s3.rows[0].status, 'closed');
    assert.equal(s3.rows[0].close_reason, 'expired');
    assert.ok(!c.lit, 'свет погас по локальному таймеру');
    kinds = (await t.q("select kind from bl.notifications where kind like 'session.%' order by created_at")).rows.map((r) => r.kind);
    assert.equal(kinds.at(-1), 'session.closed');
    const audit = await t.q("select action from bl.audit_log where action like 'session.%' order by seq");
    assert.deepEqual(audit.rows.map((r) => r.action), ['session.start', 'session.extend', 'session.extend', 'session.close']);
    const ob = await t.q("select topic, payload from bl.outbox where topic like 'session.%' order by id");
    assert.deepEqual(ob.rows.map((r) => r.topic), ['session.started', 'session.extended', 'session.extended', 'session.closed']);
    assert.equal(ob.rows.at(-1).payload.session_id, sessionId);
    assert.equal(h.st.scheduler.size(), 0, 'таймер сессии снят');
    assert.ok(!OPEN.includes(s3.rows[0].status));
  });
});

describe('перезапуск сервера: таймеры и свет восстанавливаются из базы', { skip: SKIP }, () => {
  let t;
  let h;
  before(async () => {
    t = await createTestDb();
  });
  after(async () => {
    await h?.stop();
    await t?.drop();
  });

  it('сессия идёт, сервер перезапущен: планировщик находит её (bl.light_open_sessions), сигналы и закрытие — в срок', async () => {
    h = await startLight(t, { devices: [1] });
    const pay = await makePayment(t, { resource: 1, minutes: 15, at: h.time.now() });
    const { session_id: sid } = await h.outbox.deliver('payment.confirmed', pay);
    await h.until(() => h.ctl.get(1).lit, 'свет');
    const time = h.time;
    await h.stop();
    time.queue.clear(); // таймеры старого процесса умерли вместе с ним
    await time.advance(2 * MIN);
    h = await startLight(t, { devices: [1], time });
    assert.equal(h.st.scheduler.size(), 1, 'таймер восстановлен');
    // Контроллер после перезапуска сервера получает актуальное состояние: session.resume.
    await h.until(() => h.ctl.get(1).received.some((c) => c.type === 'session.resume'), 'session.resume');
    const resume = h.ctl.get(1).received.find((c) => c.type === 'session.resume');
    assert.equal(resume.body.remaining_ms, 13 * MIN);
    await h.advance(3 * MIN + 1_000); // T−10
    const kinds = (await t.q("select kind from bl.notifications where kind like 'session.%'")).rows.map((r) => r.kind);
    assert.deepEqual(kinds, ['session.t10']);
    await h.advance(12 * MIN);
    const s = await t.q('select status from bl.sessions where id = $1', [sid]);
    assert.equal(s.rows[0].status, 'closed');
  });
});

describe('«Без лимита»: подтверждение продолжения за 5 минут до extend_limit_until (№69)', { skip: SKIP }, () => {
  let t;
  let h;
  before(async () => {
    t = await createTestDb();
    h = await startLight(t, { devices: [1] });
  });
  after(async () => {
    await h?.stop();
    await t?.drop();
  });

  it('T−5: session.unlimited_confirm с действием extend/minutes null и SSE; подтвердил — снова через 5 минут до нового предела; не подтвердил — обычный конец', async () => {
    const pay = await makePayment(t, { resource: 1, minutes: 30, unlimited: true, method: 'card', amount: 40_000, at: h.time.now() });
    const { session_id: sid } = await h.outbox.deliver('payment.confirmed', pay);
    await h.until(() => h.ctl.get(1).lit, 'свет');
    const view = await h.asUser(GUEST(1), (db) => h.st.service.getSession(db, { sessionId: sid, userId: GUEST(1) }));
    assert.equal(view.unlimited, true);
    assert.equal(view.extend_limit_until, view.paid_until);
    const confirms = async () => (await t.q("select text, data from bl.notifications where kind = 'session.unlimited_confirm' order by created_at")).rows;
    await h.advance(24 * MIN + 59_000);
    assert.equal((await confirms()).length, 0, 'до T−5 — нет');
    await h.advance(2_000);
    const c1 = await confirms();
    assert.equal(c1.length, 1);
    // 12:30 UTC — 17:30 в Екатеринбурге.
    assert.equal(c1[0].text, 'Стол 1: заморозка заканчивается в 17:30. Подтвердите продолжение игры');
    assert.equal(c1[0].data.action, 'extend');
    assert.equal(c1[0].data.kind, 'extend');
    assert.equal(c1[0].data.minutes, null);
    const ev = h.sse.events.filter((e) => e.channel === `session:${sid}` && e.event === 'unlimited_confirm');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].data.extend_limit_until, view.paid_until);
    // Гость подтвердил: новая заморозка на 30 минут — предел сдвинулся, сигнал повторится.
    const ext = await makePayment(t, { kind: 'extend', resource: 1, sessionId: sid, minutes: 30, unlimited: true, method: 'card', amount: 40_000, at: h.time.now() });
    await h.outbox.deliver('payment.confirmed', ext);
    await h.advance(30 * MIN);
    assert.equal((await confirms()).length, 2);
    assert.match((await confirms())[1].text, /заканчивается в 18:00/);
    // Не подтвердил: обычные сигналы и закрытие по extend_limit_until.
    await h.advance(5 * MIN + 2 * MIN + 1_000);
    const s = await t.q('select status, close_reason from bl.sessions where id = $1', [sid]);
    assert.deepEqual([s.rows[0].status, s.rows[0].close_reason], ['closed', 'expired']);
    const kinds = (await t.q("select kind from bl.notifications where kind like 'session.%' order by created_at")).rows.map((r) => r.kind);
    assert.deepEqual(kinds, ['session.t10', 'session.unlimited_confirm', 'session.t10', 'session.unlimited_confirm', 'session.t1', 'session.t0', 'session.closed']);
    assert.ok(!h.ctl.get(1).lit);
  });
});
