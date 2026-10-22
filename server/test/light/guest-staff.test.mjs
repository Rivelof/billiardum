// Гость и персонал: остановка, «Я играю», удержание pending (T12), сервисный свет (T11),
// продление без оплаты, стол занят к оплате, код стола, зал, изоляция клубов.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  CLUB,
  CLUB_B,
  createTestDb,
  DEV,
  GUEST,
  makePayment,
  MANAGER,
  MIN,
  OWNER,
  RECEPTION,
  RES,
  RES_B,
  SKIP,
  startLight,
} from './harness.mjs';
import * as api from '../../sessions/api.mjs';

const code = async (fn) => {
  try {
    await fn();
  } catch (err) {
    return err.code;
  }
  return 'ok';
};

describe('гость и персонал', { skip: SKIP }, () => {
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

  async function start(resource, user = GUEST(1), minutes = 60) {
    const pay = await makePayment(t, { resource, user, minutes, at: h.time.now() });
    const res = await h.outbox.deliver('payment.confirmed', pay);
    assert.equal(res.result, 'started');
    await h.until(() => h.ctl.get(resource).received.some((c) => c.type === 'session.start' && c.body.session_id === res.session_id), 'свет');
    return res.session_id;
  }

  it('стоп не плательщиком — not_payer (участник) или not_found (чужой); плательщиком — closed и session.stop', async () => {
    const sid = await start(2);
    // «Я играю» — только с кодом этого стола (ревью п. 9): session_id не секрет.
    assert.equal(await code(() => h.asUser(GUEST(2), (db) => svc.join(db, { sessionId: sid, userId: GUEST(2) }))), 'bad_request');
    assert.equal(await code(() => h.asUser(GUEST(2), (db) => svc.join(db, { sessionId: sid, userId: GUEST(2), code: 'TEST000003' }))), 'not_found');
    await h.asUser(GUEST(2), (db) => svc.join(db, { sessionId: sid, userId: GUEST(2), code: 'test-000002' }));
    assert.equal(await code(() => h.asUser(GUEST(2), (db) => svc.stop(db, { sessionId: sid, userId: GUEST(2) }))), 'not_payer');
    assert.equal(await code(() => h.asUser(GUEST(3), (db) => svc.stop(db, { sessionId: sid, userId: GUEST(3) }))), 'not_found');
    const view = await h.asUser(GUEST(1), (db) => svc.stop(db, { sessionId: sid, userId: GUEST(1) }));
    assert.equal(view.status, 'closed');
    assert.equal(view.is_payer, true);
    assert.deepEqual(view.participants, [{ nick: 'Игрок 1' }, { nick: 'Игрок 2' }]);
    await h.until(() => h.ctl.get(2).received.some((c) => c.type === 'session.stop'), 'session.stop');
    assert.ok(!h.ctl.get(2).lit);
    const ob = await t.q("select payload from bl.outbox where topic = 'session.closed'");
    assert.equal(ob.rows[0].payload.reason, 'stopped');
    assert.equal(await code(() => h.asUser(GUEST(1), (db) => svc.stop(db, { sessionId: sid, userId: GUEST(1) }))), 'session_not_active');
    assert.equal(await code(() => h.asUser(GUEST(3), (db) => svc.join(db, { sessionId: sid, userId: GUEST(3), code: 'TEST000002' }))), 'session_not_active');
  });

  it('GET current и session: участник видит сессию из любого клуба, чужой — not_found', async () => {
    const sid = await start(3, GUEST(3), 30);
    const list = await h.asUser(GUEST(3), (db) => svc.listCurrent(db, { userId: GUEST(3) }));
    assert.equal(list.length, 1);
    assert.equal(list[0].id, sid);
    assert.equal(list[0].resource.number, 3);
    assert.equal(list[0].remaining_ms, 30 * MIN);
    assert.equal(await code(() => h.asUser(GUEST(2), (db) => svc.getSession(db, { sessionId: sid, userId: GUEST(2) }))), 'not_found');
    const staff = await h.asUser(RECEPTION, (db) => svc.getSession(db, { sessionId: sid, userId: RECEPTION }));
    assert.equal(staff.is_payer, false);
    let receipt = await h.asUser(GUEST(3), (db) => svc.receipt(db, { sessionId: sid, userId: GUEST(3) }));
    assert.equal(receipt.total_kopecks, 80_000);
    assert.equal(receipt.lines[0].title, 'Стол 3, 30 минут');
    assert.equal(receipt.receipt_status, 'none', 'чека ещё нет');
    const pid = receipt.payments[0].payment_id;
    await t.q(`insert into bl.receipts (club_id, payment_id, kind, channel, status, amount_kopecks, items) values ($1, $2, 'sale', 'yookassa', 'pending', 80000, '[]')`, [CLUB, pid]);
    receipt = await h.asUser(GUEST(3), (db) => svc.receipt(db, { sessionId: sid, userId: GUEST(3) }));
    assert.equal(receipt.receipt_status, 'pending');
    assert.equal(receipt.payments[0].receipt_status, 'pending');
    await t.q("update bl.receipts set status = 'succeeded' where payment_id = $1", [pid]);
    receipt = await h.asUser(GUEST(3), (db) => svc.receipt(db, { sessionId: sid, userId: GUEST(3) }));
    assert.equal(receipt.receipt_status, 'succeeded');
    assert.deepEqual(list[0].club, { id: CLUB, timezone: 'Asia/Yekaterinburg' });
    assert.deepEqual(list[0].resource, { id: RES(3), number: 3, type: 'billiard_pyramid', title: 'Стол 3' });
    await h.asUser(GUEST(3), (db) => svc.stop(db, { sessionId: sid, userId: GUEST(3) }));
  });

  it('T12: два гостя на свободный стол — первый держит 3 минуты, второй получает table_pending (блокировка строки ресурса)', async () => {
    const until = new Date(h.time.t + 3 * MIN);
    let releaseA;
    const gate = new Promise((r) => {
      releaseA = r;
    });
    let lockedA;
    const lockedPromise = new Promise((r) => {
      lockedA = r;
    });
    const a = h.asUser(GUEST(1), async (db) => {
      const r = await api.holdPending(db, { resourceId: RES(4), userId: GUEST(1), until });
      lockedA();
      await gate; // транзакция A ещё не закоммичена
      return r;
    });
    await lockedPromise;
    let bDone = false;
    const b = h
      .asUser(GUEST(2), (db) => api.holdPending(db, { resourceId: RES(4), userId: GUEST(2), until }))
      .then(
        () => 'ok',
        (e) => e.code,
      )
      .finally(() => {
        bDone = true;
      });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(bDone, false, 'второй ждёт блокировку строки ресурса');
    releaseA();
    const ra = await a;
    assert.equal(ra.ok, true);
    assert.equal(await b, 'table_pending');
    // Повтор тем же гостем продлевает удержание; статус стола — pending (свой — pending_mine).
    const again = await h.asUser(GUEST(1), (db) => api.holdPending(db, { resourceId: RES(4), userId: GUEST(1), until: new Date(h.time.t + 2 * MIN) }));
    assert.equal(again.hold_id, ra.hold_id);
    const st = await h.asUser(GUEST(1), (db) => api.getResourceStatus(db, RES(4), { userId: GUEST(1) }), { clubId: CLUB });
    assert.equal(st.status, 'pending');
    assert.equal(st.pending_mine, true);
    await h.until(() => h.ctl.get(4).received.some((c) => c.type === 'state.pending'), 'state.pending');
    assert.equal(h.ctl.get(4).st.mode, 'pending');
    // Оплата первого гостя: удержание переходит в сессию.
    const sid = await start(4, GUEST(1), 60);
    const holds = await t.q('select release_reason from bl.resource_holds where resource_id = $1 order by created_at', [RES(4)]);
    assert.deepEqual(holds.rows.map((r) => r.release_reason), ['session']);
    assert.equal(await code(() => h.asUser(GUEST(2), (db) => api.holdPending(db, { resourceId: RES(4), userId: GUEST(2), until }))), 'table_busy');
    await h.asUser(GUEST(1), (db) => svc.stop(db, { sessionId: sid, userId: GUEST(1) }));
  });

  it('releasePending снимает удержание и шлёт state.free; оффлайн-стол — table_offline', async () => {
    const until = new Date(h.time.t + 3 * MIN);
    await h.asUser(GUEST(2), (db) => api.holdPending(db, { resourceId: RES(2), userId: GUEST(2), until }));
    const r = await h.asUser(GUEST(2), (db) => api.releasePending(db, { resourceId: RES(2), userId: GUEST(2) }));
    assert.deepEqual(r, { ok: true, released: true });
    await h.until(() => h.ctl.get(2).st.mode === 'free' && h.ctl.get(2).received.at(-1).type === 'state.free', 'state.free');
    // Стол 5: контроллер не на связи.
    assert.equal(await code(() => h.asUser(GUEST(2), (db) => api.holdPending(db, { resourceId: RES(5), userId: GUEST(2), until }))), 'table_offline');
    const st = await h.asSystem(CLUB, (db) => api.getResourceStatus(db, RES(5)));
    assert.equal(st.status, 'offline');
  });

  it('payment.confirmed бара (M2, kind bar, без стола и гостя) — игнорируется: ни сессии, ни тревоги', async () => {
    const before = (await t.q('select count(*)::int as n from bl.session_payments')).rows[0].n;
    const res = await h.outbox.deliver('payment.confirmed', {
      payment_id: '0b000000-0000-4000-8000-000000000001',
      club_id: CLUB,
      quote_id: null,
      kind: 'bar',
      session_id: null,
      resource_id: null,
      user_id: null,
      minutes: null,
      unlimited: false,
      amount_kopecks: 45_000,
      method: 'sbp',
    });
    assert.deepEqual(res, { result: 'ignored' });
    assert.equal((await t.q('select count(*)::int as n from bl.session_payments')).rows[0].n, before);
    assert.equal((await t.q("select count(*)::int as n from bl.alarms where type = 'payment_unapplied'")).rows[0].n, 0);
    // Испорченный платёж за стол по-прежнему поднимает тревогу.
    const bad = await h.outbox.deliver('payment.confirmed', { payment_id: '0b000000-0000-4000-8000-000000000002', club_id: CLUB, kind: 'start', amount_kopecks: 1 });
    assert.equal(bad.result, 'invalid');
    assert.equal((await t.q("select level from bl.alarms where type = 'payment_unapplied'")).rows[0].level, 'critical');
  });

  it('стол занят к моменту оплаты — автоматический возврат и тревога payment_conflict', async () => {
    const sid = await start(1, GUEST(1), 60);
    const pay = await makePayment(t, { resource: 1, user: GUEST(2), minutes: 60, at: h.time.now() });
    const res = await h.outbox.deliver('payment.confirmed', pay);
    assert.deepEqual(res, { result: 'refunded', reason: 'busy' });
    assert.deepEqual(h.refunds.at(-1), { paymentId: pay.payment_id, amountKopecks: pay.amount_kopecks, reason: 'light_busy' });
    const al = await t.q("select type, level from bl.alarms where type = 'payment_conflict'");
    assert.equal(al.rows[0].level, 'important');
    const sp = await t.q('select outcome, refunded_kopecks from bl.session_payments where payment_id = $1', [pay.payment_id]);
    assert.equal(sp.rows[0].outcome, 'refunded');
    assert.equal((await h.outbox.deliver('payment.confirmed', pay)).result, 'duplicate', 'возврат не повторяется');
    assert.equal(h.refunds.filter((r) => r.paymentId === pay.payment_id).length, 1);
    await h.asUser(GUEST(1), (db) => svc.stop(db, { sessionId: sid, userId: GUEST(1) }));
  });

  it('payment.refunded (возврат персоналом): часть — сессия идёт; всё оплаченное — отмена и свет гаснет', async () => {
    const sid = await start(2, GUEST(1), 30);
    const pay = (await t.q('select payment_id from bl.session_payments where session_id = $1', [sid])).rows[0].payment_id;
    const refund = async (amount) => {
      await t.q(
        `insert into bl.refunds (club_id, payment_id, idempotence_key, amount_kopecks, status, reason) values ($1, $2, $3, $4, 'succeeded', 'Возврат по просьбе гостя')`,
        [CLUB, pay, `k-${Math.random()}`, amount],
      );
      return h.outbox.deliver('payment.refunded', { payment_id: pay, club_id: CLUB, session_id: sid, amount_kopecks: amount });
    };
    assert.equal((await refund(30_000)).result, 'partial');
    assert.equal((await t.q('select status from bl.sessions where id = $1', [sid])).rows[0].status, 'active');
    assert.equal((await refund(50_000)).result, 'cancelled');
    const s = await t.q('select status, close_reason from bl.sessions where id = $1', [sid]);
    assert.deepEqual([s.rows[0].status, s.rows[0].close_reason], ['cancelled', 'cancelled']);
    await h.until(() => h.ctl.get(2).received.at(-1).type === 'session.stop', 'session.stop');
    assert.ok(!h.ctl.get(2).lit);
    assert.equal((await refund(1)).result, 'ignored', 'повтор — без действий');
  });

  it('T11: сервисный свет — без причины reason_required, сверх предела limit_exceeded, гость forbidden; с причиной: свет, журнал, тревога', async () => {
    const run = (user, body) => h.asUser(user, (db) => svc.serviceStart(db, { resourceId: RES(3), userId: user, ...body }), { clubId: CLUB });
    assert.equal(await code(() => run(RECEPTION, { minutes: 10, reasonCode: 'cleaning' })), 'reason_required');
    assert.equal(await code(() => run(RECEPTION, { minutes: 10, reasonText: 'Уборка' })), 'reason_required');
    assert.equal(await code(() => run(RECEPTION, { minutes: 10, reasonCode: 'party', reasonText: 'x' })), 'bad_request', 'коды — cleaning, repair, training, other');
    assert.equal(await code(() => run(RECEPTION, { minutes: 10, reasonCode: 'cleaning', reasonText: '   ' })), 'reason_required');
    assert.equal(await code(() => run(RECEPTION, { minutes: 31, reasonCode: 'cleaning', reasonText: 'Уборка' })), 'limit_exceeded');
    assert.equal(await code(() => h.asUser(GUEST(1), (db) => svc.serviceStart(db, { resourceId: RES(3), userId: GUEST(1), minutes: 5, reasonCode: 'cleaning', reasonText: 'y' }))), 'forbidden');
    assert.equal((await t.q("select count(*)::int as n from bl.audit_log where action = 'service.start'")).rows[0].n, 0, 'без причины — ни журнала, ни света');
    const res = await run(RECEPTION, { minutes: 10, reasonCode: 'cleaning', reasonText: 'Уборка стола после игры' });
    assert.equal(res.ok, true);
    assert.equal(new Date(res.until).getTime(), h.time.t + 10 * MIN);
    await h.until(() => h.ctl.get(3).received.some((c) => c.type === 'service.start'), 'service.start');
    const cmd = h.ctl.get(3).received.find((c) => c.type === 'service.start');
    assert.deepEqual(cmd.body, { duration_ms: 10 * MIN, reason_code: 'cleaning' });
    assert.ok(h.ctl.get(3).lit);
    const a = await t.q("select actor_type, actor_id, reason, data from bl.audit_log where action = 'service.start'");
    assert.equal(a.rows[0].reason, 'Уборка стола после игры');
    assert.equal(a.rows[0].actor_id, RECEPTION);
    assert.equal(a.rows[0].data.reason_code, 'cleaning');
    const al = await t.q("select level from bl.alarms where type = 'service_light'");
    assert.equal(al.rows[0].level, 'critical');
    const n = await t.q("select count(*)::int as n from bl.notifications where user_id = $1 and kind = 'alarm'", [OWNER]);
    assert.ok(n.rows[0].n >= 1, 'владелец уведомлён сразу');
    assert.equal(await code(() => run(RECEPTION, { minutes: 5, reasonCode: 'cleaning', reasonText: 'ещё' })), 'table_service');
    const st = await h.asSystem(CLUB, (db) => api.getResourceStatus(db, RES(3)));
    assert.equal(st.status, 'service');
    await h.asUser(RECEPTION, (db) => svc.serviceStop(db, { resourceId: RES(3), userId: RECEPTION }), { clubId: CLUB });
    await h.until(() => h.ctl.get(3).received.at(-1).type === 'service.stop', 'service.stop');
    assert.ok(!h.ctl.get(3).lit);
    const stop = await t.q("select reason from bl.audit_log where action = 'service.stop'");
    assert.equal(stop.rows[0].reason, 'Уборка стола после игры');
  });

  it('второе ручное действие при открытой тревоге всё равно уходит владельцу (инвариант 8)', async () => {
    const before = (await t.q("select count(*)::int as n from bl.notifications where user_id = $1 and kind = 'alarm'", [OWNER])).rows[0].n;
    await h.asUser(MANAGER, (db) => svc.serviceStart(db, { resourceId: RES(3), userId: MANAGER, minutes: 1, reasonCode: 'repair', reasonText: 'Замена лузы' }), { clubId: CLUB });
    const after = (await t.q("select count(*)::int as n from bl.notifications where user_id = $1 and kind = 'alarm'", [OWNER])).rows[0].n;
    assert.equal(after, before + 1);
    await h.advance(MIN + 1_000);
  });

  it('продление без оплаты: ресепшн — forbidden, без причины — reason_required; управляющий — журнал manual.extend_free и тревога', async () => {
    const sid = await start(2, GUEST(1), 30);
    const run = (user, body) => h.asUser(user, (db) => svc.extendFree(db, { sessionId: sid, userId: user, ...body }), { clubId: CLUB });
    assert.equal(await code(() => run(RECEPTION, { minutes: 10, reasonText: 'Сбой питания' })), 'forbidden');
    assert.equal(await code(() => run(MANAGER, { minutes: 10, reasonText: '' })), 'reason_required');
    assert.equal(await code(() => run(MANAGER, { minutes: 1000, reasonText: 'x' })), 'limit_exceeded');
    const before = (await t.q('select paid_until from bl.sessions where id = $1', [sid])).rows[0].paid_until;
    const view = await run(MANAGER, { minutes: 10, reasonText: 'Свет пропадал 10 минут' });
    assert.equal(new Date(view.paid_until).getTime(), before.getTime() + 10 * MIN);
    const a = await t.q("select reason, actor_id, data from bl.audit_log where action = 'manual.extend_free'");
    assert.equal(a.rows[0].reason, 'Свет пропадал 10 минут');
    assert.equal(a.rows[0].actor_id, MANAGER);
    assert.equal(a.rows[0].data.minutes, 10);
    const al = await t.q("select level, data from bl.alarms where type = 'manual_action'");
    assert.equal(al.rows[0].level, 'critical');
    await h.until(() => h.ctl.get(2).received.some((c) => c.type === 'session.extend' && c.body.session_id === sid), 'session.extend');
    await h.asUser(GUEST(1), (db) => svc.stop(db, { sessionId: sid, userId: GUEST(1) }));
  });

  it('код стола: нормализация Crockford, контекст клуба; чужой код — null', async () => {
    const found = await h.asUser(null, (db) => api.getResourceByCode(db, 'test-oooo-o1'));
    assert.equal(found.resource.id, RES(1));
    assert.equal(found.resource.code, 'TEST000001');
    assert.equal(found.club.timezone, 'Asia/Yekaterinburg');
    assert.equal(await h.asUser(null, (db) => api.getResourceByCode(db, 'ZZZZZZZZZZ')), null);
    assert.equal(await h.asUser(null, (db) => api.getResourceByCode(db, 'TEST0000U1')), null, 'U не из алфавита');
    // В транзакции с контекстом другого клуба стол не находится.
    assert.equal(await h.asUser(null, (db) => api.getResourceByCode(db, 'TEST000001'), { clubId: CLUB_B }), null);
    const ext = await h.asUser(GUEST(1), (db) => api.getSessionForExtend(db, { sessionId: '00000000-0000-4000-8000-000000000000', userId: GUEST(1) }));
    assert.equal(ext, null);
  });

  it('зал: статусы столов, устройство и сессия; монтажнику — без сессий; гостю — forbidden', async () => {
    const sid = await start(1, GUEST(2), 60);
    const hall = await h.asUser(OWNER, (db) => svc.hall(db, { clubId: CLUB, userId: OWNER }), { clubId: CLUB });
    assert.equal(hall.length, 8);
    const t1 = hall.find((x) => x.resource.number === 1);
    assert.equal(t1.status, 'active');
    assert.equal(t1.session.id, sid);
    assert.equal(t1.device.online, true);
    assert.equal(t1.device.fw, '1.0.0-fake');
    assert.equal(hall.find((x) => x.resource.number === 5).status, 'offline');
    assert.equal(hall.find((x) => x.resource.number === 4).status, 'free');
    assert.equal(await code(() => h.asUser(GUEST(1), (db) => svc.hall(db, { clubId: CLUB, userId: GUEST(1) }))), 'forbidden');
    const inst = await h.asUser('a1000000-0000-4000-8000-000000000009', (db) => svc.hall(db, { clubId: CLUB, userId: 'a1000000-0000-4000-8000-000000000009' }), { clubId: CLUB });
    assert.equal(inst.find((x) => x.resource.number === 1).session, null);
    await h.asUser(GUEST(2), (db) => svc.stop(db, { sessionId: sid, userId: GUEST(2) }));
  });

  it('изоляция: в контексте клуба Б не видно ни одной строки light клуба А; вставка в клуб А из Б — RLS', async () => {
    const tables = ['sessions', 'session_participants', 'session_payments', 'resource_holds', 'device_commands', 'device_events', 'device_bind_windows'];
    await h.asSystem(CLUB_B, async (db) => {
      for (const tb of tables) {
        const r = await db.query(`select count(*)::int as n from bl.${tb}`);
        assert.equal(r.rows[0].n, 0, tb);
      }
      await db.query('savepoint s');
      await assert.rejects(
        db.query(
          `insert into bl.resource_holds (club_id, resource_id, kind, user_id, until, created_at) values ($1, $2, 'pending', $3, now() + interval '1 minute', now())`,
          [CLUB, RES(1), GUEST(1)],
        ),
        /row-level security/,
      );
      await db.query('rollback to savepoint s');
    });
    const a = await h.asSystem(CLUB, (db) => db.query('select count(*)::int as n from bl.sessions'));
    assert.ok(a.rows[0].n > 0);
    // Стол клуба Б не удержать из контекста клуба А.
    assert.equal(await code(() => h.asUser(GUEST(1), (db) => api.holdPending(db, { resourceId: RES_B, userId: GUEST(1), until: new Date(h.time.t + MIN) }), { clubId: CLUB })), 'not_found');
    // В журнале команд — только устройства клуба А.
    const cmds = await t.q('select distinct club_id from bl.device_commands');
    assert.deepEqual(cmds.rows.map((r) => r.club_id), [CLUB]);
    void DEV;
  });
});
