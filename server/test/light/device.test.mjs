// Контроллер и сессии: офлайн (T5, T6), перезагрузка (T7), повтор (T8), неверная подпись (T9),
// свет в обход (T10), очередь одной неподтверждённой команды, сверка state, привязка (protocol §7).

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { decryptSecret, deviceKeyContext } from '../../lib/secrets.mjs';
import { deviceRoleAcls } from '../../lib/dynsec.mjs';
import { CLUB, createTestDb, DEV, GUEST, INSTALLER, makePayment, MIN, OWNER, RECEPTION, RES, SKIP, startLight } from './harness.mjs';

const code = async (fn) => {
  try {
    await fn();
  } catch (err) {
    return err.code;
  }
  return 'ok';
};

describe('контроллер и сессии', { skip: SKIP }, () => {
  let t;
  let h;
  let svc;
  before(async () => {
    t = await createTestDb();
    h = await startLight(t);
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
  const alarms = async (type) => (await t.q('select type, level, count, data from bl.alarms where type = $1', [type])).rows;

  it('T5: связь пропала посреди игры — тревога через 120 с; вернулась до конца — session.resume с остатком по paid_until', async () => {
    const sid = await start(1, GUEST(1), 30);
    const c = h.ctl.get(1);
    await h.advance(5 * MIN);
    await c.disconnect();
    await h.advance(110_000);
    assert.equal((await alarms('device_offline')).length, 0, '110 с — рано');
    await h.advance(15_000);
    const al = await alarms('device_offline');
    assert.equal(al.length, 1);
    assert.equal(al[0].level, 'critical');
    assert.equal(al[0].data.session_id, sid);
    assert.ok(c.lit, 'контроллер доигрывает сам');
    await c.connect();
    await h.until(() => c.received.at(-1).type === 'session.resume', 'session.resume');
    const s = await session(sid);
    assert.equal(c.received.at(-1).body.remaining_ms, s.paid_until.getTime() - h.time.t);
    assert.equal(s.status, 'active');
    await h.asUser(GUEST(1), (db) => svc.stop(db, { sessionId: sid, userId: GUEST(1) }));
  });

  it('T5: контроллер доиграл без связи — свет гаснет сам, сессия закрыта по времени, offline_session_finished в журнале, без interrupted', async () => {
    const sid = await start(2, GUEST(1), 10);
    const c = h.ctl.get(2);
    await h.advance(2 * MIN);
    await c.disconnect();
    await h.advance(11 * MIN);
    assert.ok(!c.lit, 'погас по локальному таймеру');
    const s = await session(sid);
    assert.equal(s.status, 'closed');
    assert.equal(s.close_reason, 'expired');
    await c.connect();
    await h.until(async () => (await t.q("select 1 from bl.device_events where device_id = $1 and type = 'offline_session_finished'", [DEV(2)])).rowCount === 1, 'событие');
    const ev = await t.q("select data from bl.audit_log where action = 'device.event' and data->>'type' = 'offline_session_finished'");
    assert.equal(ev.rows[0].data.data.session_id, sid);
    assert.equal((await session(sid)).status, 'closed');
    assert.equal(c.received.at(-1).type, 'state.free');
  });

  it('T6: продление оплачено офлайн, связь вернулась до конца льготы — очередь заменена, свет продлён session.resume', async () => {
    const sid = await start(3, GUEST(1), 10);
    const c = h.ctl.get(3);
    await h.advance(5 * MIN);
    await c.disconnect();
    const pay = await makePayment(t, { kind: 'extend', resource: 3, sessionId: sid, minutes: 30, amount: 40_000, at: h.time.now() });
    assert.equal((await h.outbox.deliver('payment.confirmed', pay)).result, 'extended');
    await h.settle();
    const q = await t.q("select status from bl.device_commands where session_id = $1 and type = 'session.extend'", [sid]);
    assert.deepEqual(q.rows.map((r) => r.status), ['queued'], 'команда ждёт в очереди');
    await h.advance(5 * MIN + 30_000); // контроллер в льготе по старому остатку
    c.refresh();
    assert.equal(c.st.mode, 'grace');
    await c.connect();
    await h.until(() => c.received.at(-1).type === 'session.resume', 'session.resume');
    const s = await session(sid);
    assert.equal(c.received.at(-1).body.remaining_ms, s.paid_until.getTime() - h.time.t);
    assert.ok(c.lit);
    assert.equal(c.st.mode, 'active');
    const q2 = await t.q("select status from bl.device_commands where session_id = $1 and type = 'session.extend'", [sid]);
    assert.deepEqual(q2.rows.map((r) => r.status), ['superseded']);
    await h.asUser(GUEST(1), (db) => svc.stop(db, { sessionId: sid, userId: GUEST(1) }));
  });

  it('T6: связь не вернулась — свет погас по локальному таймеру; после связи interrupted, гость выбирает «Продолжить»', async () => {
    const sid = await start(4, GUEST(2), 10);
    const c = h.ctl.get(4);
    await h.advance(5 * MIN);
    await c.disconnect();
    const pay = await makePayment(t, { kind: 'extend', resource: 4, user: GUEST(2), sessionId: sid, minutes: 30, amount: 40_000, at: h.time.now() });
    await h.outbox.deliver('payment.confirmed', pay);
    await h.advance(8 * MIN); // старый конец + льгота прошли
    assert.ok(!c.lit);
    assert.equal((await session(sid)).status, 'active', 'на сервере оплачено дальше');
    await c.connect();
    await h.until(async () => (await session(sid)).status === 'interrupted', 'interrupted');
    const s = await session(sid);
    assert.equal(Number(s.unplayed_ms), s.paid_until.getTime() - s.device_paid_until.getTime());
    assert.ok(Number(s.unplayed_ms) >= 30 * MIN);
    assert.ok(!c.lit, 'свет сам не возвращается');
    assert.notEqual(c.received.at(-1).type, 'session.resume');
    const n = await t.q("select user_id, data from bl.notifications where kind = 'session.interrupted'");
    assert.equal(n.rows[0].user_id, GUEST(2));
    assert.equal(n.rows[0].data.actions, 'continue,refund');
    const ob = await t.q("select payload from bl.outbox where topic = 'session.interrupted'");
    assert.equal(ob.rows[0].payload.session_id, sid);
    // Не плательщик выбрать не может.
    await h.asUser(GUEST(1), (db) => svc.join(db, { sessionId: sid, userId: GUEST(1) })).catch(() => {});
    assert.equal(await code(() => h.asUser(GUEST(1), (db) => svc.resolve(db, { sessionId: sid, userId: GUEST(1), choice: 'continue' }))), 'not_found');
    const view = await h.asUser(GUEST(2), (db) => svc.resolve(db, { sessionId: sid, userId: GUEST(2), choice: 'continue' }));
    assert.equal(view.status, 'active');
    assert.equal(new Date(view.paid_until).getTime(), h.time.t + Number(s.unplayed_ms));
    await h.until(() => c.received.at(-1).type === 'session.start' && c.received.at(-1).body.session_id === sid, 'session.start');
    assert.equal(c.received.at(-1).body.remaining_ms, Number(s.unplayed_ms));
    assert.ok(c.lit);
    const a = await t.q("select data from bl.audit_log where action = 'session.resolve'");
    assert.equal(a.rows[0].data.choice, 'continue');
    await h.asUser(GUEST(2), (db) => svc.stop(db, { sessionId: sid, userId: GUEST(2) }));
  });

  it('T6: «Вернуть деньги за неотыгранное время» — возврат долями с последних платежей', async () => {
    const sid = await start(4, GUEST(3), 10); // 80 000 коп. за 10 минут
    const c = h.ctl.get(4);
    await h.advance(5 * MIN);
    await c.disconnect();
    const pay = await makePayment(t, { kind: 'extend', resource: 4, user: GUEST(3), sessionId: sid, minutes: 20, amount: 30_000, at: h.time.now() });
    await h.outbox.deliver('payment.confirmed', pay);
    // Связь так и не вернулась до конца оплаченного: планировщик закрывает как interrupted.
    await h.advance(28 * MIN);
    const s = await session(sid);
    assert.equal(s.status, 'interrupted');
    assert.equal(Number(s.unplayed_ms), 20 * MIN, 'не отыграно ровно продление');
    const first = (await t.q('select payment_id from bl.session_payments where session_id = $1 and kind = $2', [sid, 'start'])).rows[0].payment_id;
    const view = await h.asUser(GUEST(3), (db) => svc.resolve(db, { sessionId: sid, userId: GUEST(3), choice: 'refund' }));
    assert.equal(view.status, 'closed');
    assert.equal(view.close_reason, 'refunded');
    const mine = h.refunds.filter((r) => r.paymentId === pay.payment_id || r.paymentId === first);
    assert.deepEqual(mine, [{ paymentId: pay.payment_id, amountKopecks: 30_000, reason: 'interrupted' }]);
    const sp = await t.q('select refunded_kopecks from bl.session_payments where payment_id = $1', [pay.payment_id]);
    assert.equal(Number(sp.rows[0].refunded_kopecks), 30_000);
    assert.equal(await code(() => h.asUser(GUEST(3), (db) => svc.resolve(db, { sessionId: sid, userId: GUEST(3), choice: 'refund' }))), 'session_not_active');
    await c.connect();
    await h.until(() => c.received.at(-1).type === 'state.free', 'state.free');
  });

  it('№65: гость не выбрал за 24 часа — автоматический возврат за неотыгранное, уведомление; таймер переживает перезапуск', async () => {
    const sid = await start(4, GUEST(1), 10);
    const c = h.ctl.get(4);
    await h.advance(3 * MIN);
    await c.disconnect();
    const pay = await makePayment(t, { kind: 'extend', resource: 4, user: GUEST(1), sessionId: sid, minutes: 20, amount: 30_000, at: h.time.now() });
    await h.outbox.deliver('payment.confirmed', pay);
    await h.advance(30 * MIN); // оплачено до +30 мин, льгота 2 мин — закрытие как interrupted
    assert.equal((await session(sid)).status, 'interrupted');
    const open = await t.q('select session_id from bl.light_open_sessions()');
    assert.ok(open.rows.some((r) => r.session_id === sid), 'планировщик найдёт прерванную после перезапуска');
    assert.ok(h.st.scheduler.dueAt(sid), 'срок выбора взведён');
    await h.jump(24 * 60 * MIN - 30 * MIN);
    assert.equal((await session(sid)).status, 'interrupted', 'до 24 часов ждём выбора');
    await h.jump(31 * MIN);
    await h.until(async () => (await session(sid)).status === 'closed', 'автовозврат');
    const s = await session(sid);
    assert.equal(s.close_reason, 'refunded');
    assert.deepEqual(h.refunds.filter((r) => r.paymentId === pay.payment_id), [{ paymentId: pay.payment_id, amountKopecks: 30_000, reason: 'interrupted_auto' }]);
    const a = await t.q("select actor_type, data from bl.audit_log where action = 'session.resolve' and object_id = $1", [sid]);
    assert.equal(a.rows[0].actor_type, 'system');
    assert.equal(a.rows[0].data.auto, true);
    const n = await t.q("select user_id, text from bl.notifications where kind = 'session.refunded'");
    assert.equal(n.rows[0].user_id, GUEST(1));
    assert.match(n.rows[0].text, /^Стол 4: вернули 300\s₽ за неотыгранное время$/);
    await c.connect();
    await h.until(() => c.received.at(-1).type === 'state.free', 'state.free');
  });

  it('№73 (T6-C): ack пришёл с задержкой, продление не показано — возврат целиком, задержка не засчитана как игра', async () => {
    const c = h.ctl.get(1);
    c.auto = false;
    const pay = await makePayment(t, { resource: 1, user: GUEST(2), minutes: 10, at: h.time.now() });
    const { session_id: sid } = await h.outbox.deliver('payment.confirmed', pay);
    await h.until(() => c.dropped.length === 1, 'session.start опубликован');
    await h.advance(1_500); // подтверждение через 1,5 с
    c.auto = true;
    await c.onCmd(c.dropped.shift());
    await h.until(async () => (await session(sid)).device_paid_until !== null, 'ack');
    const s0 = await session(sid);
    assert.equal(s0.device_paid_until.getTime(), s0.paid_until.getTime(), 'конец света — от отправки команды');
    await h.advance(5 * MIN);
    await c.disconnect();
    const ext = await makePayment(t, { kind: 'extend', resource: 1, user: GUEST(2), sessionId: sid, minutes: 3, amount: 2_500, at: h.time.now() });
    await h.outbox.deliver('payment.confirmed', ext);
    await h.advance(11 * MIN);
    const s = await session(sid);
    assert.equal(s.status, 'interrupted');
    assert.equal(Number(s.unplayed_ms), 3 * MIN);
    await h.asUser(GUEST(2), (db) => svc.resolve(db, { sessionId: sid, userId: GUEST(2), choice: 'refund' }));
    const mine = h.refunds.filter((r) => r.paymentId === ext.payment_id || r.paymentId === pay.payment_id);
    assert.deepEqual(mine, [{ paymentId: ext.payment_id, amountKopecks: 2_500, reason: 'interrupted' }]);
    await c.connect();
    await h.until(() => c.received.at(-1).type === 'state.free', 'state.free');
  });

  it('T7: перезагрузка посреди игры — session.resume, остаток верный, событие boot в журнале', async () => {
    const sid = await start(1, GUEST(1), 30);
    const c = h.ctl.get(1);
    await h.advance(7 * MIN);
    await c.reboot();
    assert.ok(!c.lit || c.received.at(-1).type === 'session.resume');
    await h.until(() => c.received.at(-1).type === 'session.resume', 'session.resume');
    const s = await session(sid);
    assert.equal(c.received.at(-1).body.session_id, sid);
    assert.equal(c.received.at(-1).body.remaining_ms, s.paid_until.getTime() - h.time.t);
    assert.ok(c.lit);
    const boot = await t.q("select 1 from bl.device_events where device_id = $1 and type = 'boot'", [DEV(1)]);
    assert.equal(boot.rowCount, 1);
    await h.asUser(GUEST(1), (db) => svc.stop(db, { sessionId: sid, userId: GUEST(1) }));
  });

  it('T8: повтор старой команды — replayed_seq, свет не продлён, событие в журнале один раз', async () => {
    const sid = await start(2, GUEST(1), 30);
    const c = h.ctl.get(2);
    const old = h.client.published.filter((p) => p.topic === c.topic('cmd')).find((p) => p.payload.includes('"session.start"') && p.payload.includes(sid));
    const ext = await makePayment(t, { kind: 'extend', resource: 2, sessionId: sid, minutes: 10, amount: 10_000, at: h.time.now() });
    await h.outbox.deliver('payment.confirmed', ext);
    await h.until(() => c.received.at(-1).type === 'session.extend', 'extend');
    const endBefore = c.st.endAt;
    await c.onCmd(old.payload); // злоумышленник подаёт записанную команду
    await h.settle();
    assert.equal(c.acks.at(-1).error, 'replayed_seq');
    assert.equal(c.st.endAt, endBefore, 'свет не продлён');
    await h.until(async () => (await t.q("select 1 from bl.device_events where device_id = $1 and type = 'replayed_seq'", [DEV(2)])).rowCount === 1, 'событие');
    await c.event('replayed_seq', { cmd_id: 'x', seq: 1 }, { n: c.n }); // досылка того же события
    await h.settle();
    const j = await t.q("select count(*)::int as n from bl.audit_log where action = 'device.event' and object_id = $1 and data->>'type' = 'replayed_seq'", [DEV(2)]);
    assert.equal(j.rows[0].n, 1, 'один раз по (device_id, boot_id, n)');
    assert.equal((await alarms('replayed_seq'))[0].level, 'important');
    await h.asUser(GUEST(1), (db) => svc.stop(db, { sessionId: sid, userId: GUEST(1) }));
  });

  it('T9: команда с неверной подписью — bad_sig и тревога critical', async () => {
    const c = h.ctl.get(3);
    const old = h.client.published.filter((p) => p.topic === c.topic('cmd')).at(-1).payload;
    const forged = old.replace(/"seq":(\d+)/, (_m, n) => `"seq":${Number(n) + 100}`);
    await c.onCmd(forged);
    await h.settle();
    assert.equal(c.acks.at(-1).error, 'bad_sig');
    await h.until(async () => (await alarms('bad_sig')).length === 1, 'тревога bad_sig');
    assert.equal((await alarms('bad_sig'))[0].level, 'critical');
    const j = await t.q("select data from bl.audit_log where action = 'device.event' and data->>'type' = 'bad_sig'");
    assert.equal(j.rowCount, 1);
  });

  it('T10: ток при выключенном реле — bypass_detected, тревога владельцу сразу', async () => {
    const c = h.ctl.get(3);
    await c.event('bypass_detected', { current_ma: 380 });
    await h.until(async () => (await alarms('bypass_detected')).length === 1, 'тревога');
    const al = (await alarms('bypass_detected'))[0];
    assert.equal(al.level, 'critical');
    assert.equal(al.data.current_ma, 380);
    const n = await t.q("select count(*)::int as n from bl.notifications where user_id = $1 and kind = 'alarm' and level = 'critical'", [OWNER]);
    assert.ok(n.rows[0].n >= 1);
  });

  it('одна неподтверждённая команда: следующая — только после ack; без ack — повтор тем же id и seq, затем cmd_no_ack', async () => {
    const c = h.ctl.get(2);
    c.auto = false;
    const until = new Date(h.time.t + 3 * MIN);
    await h.asUser(GUEST(1), (db) => svc.holdPending(db, { resourceId: RES(2), userId: GUEST(1), until }));
    await h.until(() => c.dropped.length === 1, 'state.pending опубликован');
    await h.asUser(GUEST(1), (db) => svc.releasePending(db, { resourceId: RES(2), userId: GUEST(1) }));
    await h.settle();
    await new Promise((r) => setTimeout(r, 100));
    await h.settle();
    assert.equal(c.dropped.length, 1, 'вторая ждёт ack первой');
    await h.advance(3_000);
    assert.equal(c.dropped.length, 2);
    assert.equal(c.dropped[1], c.dropped[0], 'повтор байт в байт');
    c.auto = true;
    await c.onCmd(c.dropped[0]);
    await h.until(() => c.received.at(-1).type === 'state.free', 'state.free после ack');
    const rows = await t.q("select type, status, attempts from bl.device_commands where device_id = $1 and type in ('state.pending', 'state.free') order by seq desc limit 2", [DEV(2)]);
    assert.deepEqual(rows.rows.map((r) => [r.type, r.status]), [['state.free', 'acked'], ['state.pending', 'acked']]);
    // Без ack совсем: 1 + 5 повторов, затем тревога и отказ.
    c.auto = false;
    c.dropped = [];
    await h.asUser(OWNER, (db) => svc.identify(db, { resourceId: RES(2), userId: OWNER, seconds: 5 }), { clubId: CLUB });
    await h.until(() => c.dropped.length === 1, 'identify');
    for (let i = 0; i < 6; i += 1) await h.advance(3_000);
    assert.equal(c.dropped.length, 6);
    await h.until(async () => (await alarms('cmd_no_ack')).length === 1, 'cmd_no_ack');
    const st = await t.q("select status from bl.device_commands where device_id = $1 and type = 'identify'", [DEV(2)]);
    assert.equal(st.rows[0].status, 'no_ack');
    c.auto = true;
  });

  it('сверка: свет горит без сессии дольше 10 с — device.state_mismatch, тревога critical, свет гасится', async () => {
    const c = h.ctl.get(3);
    const ghost = randomUUID();
    Object.assign(c.st, { mode: 'active', session_id: ghost, endAt: h.time.t + 60 * MIN });
    await c.publishState();
    await h.advance(5_000);
    assert.equal((await alarms('light_without_session')).length, 0, 'до 10 с — без тревоги');
    await h.advance(10_000);
    await h.until(async () => (await alarms('light_without_session')).length === 1, 'тревога');
    assert.equal((await alarms('light_without_session'))[0].level, 'critical');
    const a = await t.q("select data from bl.audit_log where action = 'device.state_mismatch'");
    assert.equal(a.rows[0].data.mode, 'active');
    await h.until(() => c.received.at(-1).type === 'session.stop' && c.received.at(-1).body.session_id === ghost, 'session.stop');
    assert.ok(!c.lit);
  });

  it('офлайн-устройству команда ждёт; после возвращения — актуальное состояние вместо старой команды', async () => {
    const c = h.ctl.get(1);
    await c.disconnect();
    const res = await h.asUser(RECEPTION, (db) => svc.serviceStart(db, { resourceId: RES(1), userId: RECEPTION, minutes: 5, reasonCode: 'cleaning', reasonText: 'x' }), { clubId: CLUB }).then(
      () => 'ok',
      (e) => e.code,
    );
    assert.equal(res, 'table_offline', 'сервисный свет офлайн-столу не включается');
    await c.connect();
    await h.until(() => c.received.at(-1).type === 'state.free', 'state.free');
  });

  describe('привязка контроллера (protocol §7)', () => {
    const NEW = 'd9000000-0000-4000-8000-000000000001';
    beforeEach(() => {});

    it('bind: только владелец или монтажник; окно 30 минут; claim без окна и с неверным кодом — forbidden; 5 ошибок закрывают окно', async () => {
      const bind = (user, body) => h.asUser(user, (db) => h.st.binding.bind(db, { clubId: CLUB, userId: user, ...body }), { clubId: CLUB });
      const claim = (body) => h.asUser(null, (db) => h.st.binding.claim(db, body));
      assert.equal(await code(() => claim({ deviceId: NEW, claimCode: 'ABCDEF-1234' })), 'forbidden', 'без окна');
      assert.equal(await code(() => bind(RECEPTION, { deviceId: NEW, resourceId: RES(5), claimCode: 'ABCDEF-1234' })), 'forbidden');
      assert.equal(await code(() => bind(OWNER, { deviceId: NEW, resourceId: RES(5), claimCode: 'x' })), 'bad_request');
      const r = await bind(INSTALLER, { deviceId: NEW, resourceId: RES(5), claimCode: 'ABCDEF-1234' });
      assert.equal(new Date(r.bind_until).getTime(), h.time.t + 30 * MIN);
      for (let i = 0; i < 5; i += 1) assert.equal(await code(() => claim({ deviceId: NEW, claimCode: 'WRONG-0000' })), 'forbidden');
      assert.equal(await code(() => claim({ deviceId: NEW, claimCode: 'ABCDEF-1234' })), 'forbidden', 'окно закрыто после 5 ошибок');
      const w = await t.q('select failed_attempts, closed_at, claim_code_hash from bl.device_bind_windows where device_id = $1', [NEW]);
      assert.equal(w.rows[0].failed_attempts, 5);
      assert.ok(w.rows[0].closed_at);
      assert.equal(w.rows[0].claim_code_hash, createHash('sha256').update(`${NEW}:ABCDEF-1234`).digest('hex'), 'в базе только хеш');
    });

    it('claim: ключи один раз, стол переходит новому устройству, last_seq = 0, Dynamic Security, код сгорает; окно 30 минут', async () => {
      await h.asUser(OWNER, (db) => h.st.binding.bind(db, { clubId: CLUB, userId: OWNER, deviceId: NEW, resourceId: RES(5), claimCode: 'GOOD-CODE-77' }), { clubId: CLUB });
      const out = await h.asUser(null, (db) => h.st.binding.claim(db, { deviceId: NEW, claimCode: 'GOOD-CODE-77' }));
      assert.equal(out.mqtt_username, NEW);
      assert.equal(out.club_id, CLUB);
      assert.equal(out.mqtt_url, 'mqtts://dev.billiardum.test:8883');
      assert.equal(Buffer.from(out.device_key, 'base64').length, 32);
      assert.ok(out.mqtt_password.length >= 24);
      const d = await t.q('select resource_id, last_seq, device_key_enc from bl.devices where id = $1', [NEW]);
      assert.equal(d.rows[0].resource_id, RES(5));
      assert.equal(Number(d.rows[0].last_seq), 0);
      assert.deepEqual(decryptSecret(d.rows[0].device_key_enc, t.encKey, deviceKeyContext(NEW)), Buffer.from(out.device_key, 'base64'));
      const old = await t.q('select resource_id from bl.devices where id = $1', [DEV(5)]);
      assert.equal(old.rows[0].resource_id, null, 'старый контроллер стола отвязан');
      const role = h.dynsecCalls.find((x) => x.op === 'role');
      assert.deepEqual(role.acls, deviceRoleAcls(CLUB, NEW));
      const cl = h.dynsecCalls.find((x) => x.op === 'client');
      assert.equal(cl.username, NEW);
      assert.equal(cl.clientid, NEW);
      assert.equal(cl.password, out.mqtt_password);
      assert.equal(await code(() => h.asUser(null, (db) => h.st.binding.claim(db, { deviceId: NEW, claimCode: 'GOOD-CODE-77' }))), 'forbidden', 'код сгорел');
      const a = await t.q("select action from bl.audit_log where action in ('device.bind', 'device.claim') order by seq");
      assert.deepEqual(a.rows.map((r) => r.action), ['device.bind', 'device.bind', 'device.claim']);
      // Окно истекает через 30 минут.
      await h.asUser(OWNER, (db) => h.st.binding.bind(db, { clubId: CLUB, userId: OWNER, deviceId: NEW, resourceId: RES(5), claimCode: 'LATE-CODE-01' }), { clubId: CLUB });
      await h.advance(30 * MIN + 1_000);
      assert.equal(await code(() => h.asUser(null, (db) => h.st.binding.claim(db, { deviceId: NEW, claimCode: 'LATE-CODE-01' }))), 'forbidden');
    });
  });
});
