// Падел-корт и свет (M5.8 №204–205, T47 на уровне сервера): тот же контроллер и протокол, что у
// стола. Оплата слота → подписанная команда и журнал; продление слотом; «Я играю на этом корте» —
// до 4 игроков; неоплаченное не продолжается (закрытие после льготы); «Без лимита» по депозиту —
// не для корта; тексты — «Корт 1». Корт сида: e1…101, контроллер d1…101 (seed.d/1300_padel.sql).

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { deviceKeyContext, encryptSecret } from '../../lib/secrets.mjs';
import { CLUB, createTestDb, FakeController, GUEST, MIN, RECEPTION, SKIP, startLight } from './harness.mjs';

const COURT = 'e1000000-0000-4000-8000-000000000101';
const COURT_DEV = 'd1000000-0000-4000-8000-000000000101';
const COURT_CODE = 'TESTC00001';
const N = 101; // ключ контроллера корта в h.ctl
const PLAYER = (n) => `a5000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;

const code = async (fn) => {
  try {
    await fn();
  } catch (err) {
    return err.code;
  }
  return 'ok';
};

async function courtPayment(t, { kind = 'start', user = GUEST(1), sessionId = null, minutes = 90, amount = 240_000, at, method = 'sbp' }) {
  const id = randomUUID();
  await t.q(
    `insert into bl.payments (id, club_id, resource_id, user_id, session_id, kind, provider, method, provider_payment_id, idempotence_key,
                              status, amount_kopecks, minutes, unlimited, capture, confirmed_at)
     values ($1, $2, $3, $4, $5, $6, 'yookassa', $7, $8, $9, 'succeeded', $10, $11, false, true, $12)`,
    [id, CLUB, COURT, user, sessionId, kind, method, `yk-${randomUUID()}`, randomUUID(), amount, minutes, at],
  );
  return { payment_id: id, club_id: CLUB, quote_id: null, kind, session_id: sessionId, resource_id: COURT, user_id: user, minutes, unlimited: false, amount_kopecks: amount, method };
}

describe('падел-корт: свет по слотам, продление слотом, до 4 игроков', { skip: SKIP }, () => {
  let t;
  let h;
  let svc;
  let court;
  let sid;

  before(async () => {
    t = await createTestDb();
    const key = randomBytes(32);
    t.keys.set(COURT_DEV, key);
    await t.q('update bl.devices set device_key_enc = $2 where id = $1', [COURT_DEV, encryptSecret(key, t.encKey, deviceKeyContext(COURT_DEV))]);
    const values = Array.from({ length: 5 }, (_, i) => `('${PLAYER(i + 1)}', '+799900030${String(i + 1).padStart(2, '0')}')`).join(', ');
    await t.q(`insert into bl.users (id, phone) values ${values}`);
    h = await startLight(t, { devices: [1] });
    svc = h.st.service;
    court = new FakeController({ client: h.client, bridge: h.st.bridge, time: h.time, deviceId: COURT_DEV, clubId: CLUB, key });
    h.ctl.set(N, court);
    await court.connect();
    await h.until(() => court.received.length >= 1, 'корт на связи');
  });

  after(async () => {
    await h?.stop();
    await t?.drop();
  });

  it('оплата слота: сессия на 90 минут, подписанная команда session.start контроллеру корта, журнал device.cmd', async () => {
    const pay = await courtPayment(t, { at: h.time.now() });
    const res = await h.outbox.deliver('payment.confirmed', pay);
    assert.equal(res.result, 'started');
    sid = res.session_id;
    const s = (await t.q('select paid_until, started_at, status from bl.sessions where id = $1', [sid])).rows[0];
    assert.equal(s.paid_until.getTime() - s.started_at.getTime(), 90 * MIN);
    await h.until(() => court.received.some((c) => c.type === 'session.start'), 'session.start на корте');
    const start = court.received.find((c) => c.type === 'session.start');
    assert.equal(start.body.session_id, sid);
    assert.equal(start.body.remaining_ms, 90 * MIN);
    assert.ok(court.lit, 'свет корта горит');
    const cmd = (await t.q("select data from bl.audit_log where club_id = $1 and action = 'device.cmd' and data->>'cmd_id' = $2", [CLUB, start.id])).rows;
    assert.equal(cmd.length, 1);
    assert.equal(cmd[0].data.session_id, sid);
    // Столу 1 — ничего: команда только контроллеру корта.
    assert.ok(!h.ctl.get(1).received.some((c) => c.type === 'session.start'));
    // Представление сессии: вид ресурса и предел игроков.
    const v = await h.asUser(GUEST(1), (db) => svc.getSession(db, { sessionId: sid, userId: GUEST(1) }));
    assert.deepEqual([v.resource.kind, v.resource.family, v.resource.max_players, v.resource.title], ['padel_court', 'court', 4, 'Корт 1']);
  });

  it('«Я играю на этом корте»: до 4 игроков вместе с плательщиком, пятый — limit_exceeded', async () => {
    for (const n of [1, 2, 3]) await h.asUser(PLAYER(n), (db) => svc.join(db, { sessionId: sid, userId: PLAYER(n), code: COURT_CODE }));
    assert.equal(await code(() => h.asUser(PLAYER(4), (db) => svc.join(db, { sessionId: sid, userId: PLAYER(4), code: COURT_CODE }))), 'limit_exceeded');
    // Повтор уже играющего — не ошибка.
    assert.equal(await code(() => h.asUser(PLAYER(1), (db) => svc.join(db, { sessionId: sid, userId: PLAYER(1), code: COURT_CODE }))), 'ok');
    const p = await t.q('select role from bl.session_participants where session_id = $1 order by ordinal', [sid]);
    assert.deepEqual(p.rows.map((r) => r.role), ['payer', 'player', 'player', 'player']);
  });

  it('T−10 по-русски для корта: «Корт 1: осталось …»', async () => {
    await h.advance(80 * MIN + 1_000);
    const n = (await t.q("select text from bl.notifications where kind = 'session.t10' order by created_at")).rows;
    assert.ok(n.length >= 1);
    assert.match(n[0].text, /^Корт 1: осталось (10|9) минут/);
  });

  it('продление слотом: paid_until += 90, session.extend; плательщик сверх 4 игроков не добавляется', async () => {
    const before = (await t.q('select paid_until from bl.sessions where id = $1', [sid])).rows[0].paid_until;
    const pay = await courtPayment(t, { kind: 'extend', user: PLAYER(5), sessionId: sid, minutes: 90, at: h.time.now() });
    const res = await h.outbox.deliver('payment.confirmed', pay);
    assert.equal(res.result, 'extended');
    const after = (await t.q('select paid_until, status from bl.sessions where id = $1', [sid])).rows[0];
    assert.equal(after.paid_until.getTime() - before.getTime(), 90 * MIN);
    await h.until(() => court.received.some((c) => c.type === 'session.extend'), 'session.extend');
    const ext = court.received.find((c) => c.type === 'session.extend');
    assert.equal(ext.body.remaining_ms, after.paid_until.getTime() - h.time.t);
    const p = await t.q('select count(*)::int as n from bl.session_participants where session_id = $1', [sid]);
    assert.equal(p.rows[0].n, 4, 'предел игроков корта');
    const audit = (await t.q("select data from bl.audit_log where action = 'session.extend' and data->>'session_id' = $1", [sid])).rows;
    assert.equal(audit[0].data.minutes, 90);
  });

  it('неоплаченное не продолжается: после paid_until + льгота — закрытие и session.stop/свет гаснет', async () => {
    const paidUntil = (await t.q('select paid_until from bl.sessions where id = $1', [sid])).rows[0].paid_until.getTime();
    await h.advance(paidUntil - h.time.t + 2 * MIN + 5_000);
    const s = (await t.q('select status, close_reason from bl.sessions where id = $1', [sid])).rows[0];
    assert.equal(s.status, 'closed');
    assert.equal(court.lit, false, 'свет корта погас');
    const closed = (await t.q("select text from bl.notifications where kind = 'session.closed' order by created_at desc limit 1")).rows[0];
    assert.equal(closed.text, 'Корт 1: игра завершена');
  });

  it('«Без лимита» по депозиту — не для корта (bad_request)', async () => {
    assert.equal(
      await code(() => h.asUser(RECEPTION, (db) => svc.startFromDeposit(db, { resourceId: COURT, staffId: RECEPTION, depositKopecks: 100_000 }))),
      'bad_request',
    );
  });
});
