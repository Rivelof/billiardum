// Outbox (контракт M1 §2.2) на временной базе: доставка после коммита по NOTIFY (без опроса),
// откат — без доставки, сбой обработчика — повтор с паузой, тревога после 5 неудач,
// независимые подписчики, контекст клуба события.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { backoffMs, createOutbox, enqueue, errorCode } from '../../outbox.mjs';
import { withContext } from '../../lib/store.mjs';
import { CLUB_A, appPool, memoryLog, waitFor } from './helpers.mjs';
import { createTestDatabase } from '../../../supabase/tests/helpers.mjs';
import { raise } from '../../alarms/index.mjs';

let db;
let pool;
const log = memoryLog();

before(async () => {
  db = await createTestDatabase();
  pool = appPool(db.url);
});

after(async () => {
  await pool?.end();
  await db?.drop();
});

/** Часы, которые двигает тест. */
function manualClock(start = Date.now()) {
  let t = start;
  return { now: () => new Date(t), advance: (ms) => (t += ms) };
}

describe('outbox', () => {
  it('событие доставляется после коммита по NOTIFY быстрее 300 мс; откат — не доставляется', async () => {
    const outbox = createOutbox({ pollMs: 3_600_000 });
    const got = [];
    outbox.subscribe('test.notify', async (payload, { db: tx, clubId }) => {
      const ctxClub = (await tx.query('select bl.ctx_club_id() as c')).rows[0].c;
      got.push({ payload, clubId, ctxClub, at: Date.now() });
    });
    await outbox.start({ pool, log, alarms: { raise } });
    try {
      // Первый проход опроса на старте прошёл; дальше только NOTIFY.
      await new Promise((r) => setTimeout(r, 100));
      await assert.rejects(
        withContext(pool, { clubId: CLUB_A, actorType: 'system' }, async (tx) => {
          await enqueue(tx, 'test.notify', { n: 0 });
          throw new Error('откат');
        }),
      );
      const t0 = Date.now();
      await withContext(pool, { clubId: CLUB_A, actorType: 'system' }, (tx) => enqueue(tx, 'test.notify', { n: 1 }));
      await waitFor(() => got.length >= 1, { timeoutMs: 2000, stepMs: 5 });
      const ms = got[0].at - t0;
      assert.ok(ms < 300, `доставка ${ms} мс`);
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(
        got.map((g) => g.payload),
        [{ n: 1 }],
      );
      assert.equal(got[0].clubId, CLUB_A);
      assert.equal(got[0].ctxClub, CLUB_A, 'обработчик работает в контексте клуба события');
      const { rows } = await db.pool.query("select processed_at, attempts from bl.outbox where topic = 'test.notify'");
      assert.equal(rows.length, 1);
      assert.ok(rows[0].processed_at);
    } finally {
      await outbox.stop();
    }
  });

  it('сбой обработчика: повтор с паузой 1, 2, 4, 8 с; после 5 неудач — тревога outbox_failed; потом успех', async () => {
    const clock = manualClock();
    const outbox = createOutbox({ pollMs: 3_600_000, clock });
    let calls = 0;
    let fail = true;
    let other = 0;
    outbox.subscribe(
      'test.flaky',
      async () => {
        calls += 1;
        if (fail) throw Object.assign(new Error('не вышло +79991234567'), {});
      },
      { name: 'flaky' },
    );
    outbox.subscribe(
      'test.flaky',
      async () => {
        other += 1;
      },
      { name: 'steady' },
    );
    await outbox.start({ pool, log, alarms: { raise }, listen: false });
    try {
      await withContext(pool, { clubId: CLUB_A, actorType: 'system' }, (tx) => enqueue(tx, 'test.flaky', { x: 1 }));
      await outbox.drain();
      assert.equal(calls, 1);
      assert.equal(other, 1, 'второй подписчик обработал событие, несмотря на сбой первого');
      const row = async () => (await db.pool.query("select * from bl.outbox where topic = 'test.flaky'")).rows[0];
      let r = await row();
      assert.equal(r.attempts, 1);
      assert.equal(r.next_attempt_at.getTime() - clock.now().getTime(), 1000);
      assert.ok(!r.last_error.includes('79991234567'), 'в last_error нет телефона');
      // Раньше паузы — не повторяется.
      await outbox.drain();
      assert.equal(calls, 1);
      for (const [attempt, pause] of [
        [2, 1000],
        [3, 2000],
        [4, 4000],
        [5, 8000],
      ]) {
        clock.advance(pause);
        await outbox.drain();
        assert.equal(calls, attempt);
      }
      r = await row();
      assert.equal(r.attempts, 5);
      assert.ok(r.alarmed_at, 'тревога отмечена');
      assert.equal(other, 1, 'успешный подписчик не повторяется');
      const alarms = await db.pool.query("select type, level, data from bl.alarms where club_id = $1 and type = 'outbox_failed'", [CLUB_A]);
      assert.equal(alarms.rows.length, 1);
      assert.equal(alarms.rows[0].level, 'critical');
      assert.equal(alarms.rows[0].data.topic, 'test.flaky');
      const journal = await db.pool.query("select count(*)::int as n from bl.audit_log where club_id = $1 and action = 'alarm.raised'", [CLUB_A]);
      assert.equal(journal.rows[0].n, 1);
      assert.equal(backoffMs(5), 16000);
      clock.advance(16000);
      fail = false;
      await outbox.drain();
      assert.equal(calls, 6);
      r = await row();
      assert.ok(r.processed_at);
      clock.advance(60_000);
      await outbox.drain();
      assert.equal(calls, 6, 'обработанное событие не повторяется');
    } finally {
      await outbox.stop();
    }
  });

  it('событие без подписчика ждёт; подписчик, добавленный позже, получает его', async () => {
    const outbox = createOutbox({ pollMs: 3_600_000 });
    await outbox.start({ pool, log, listen: false });
    try {
      await withContext(pool, { clubId: null, actorType: 'system' }, (tx) => enqueue(tx, 'test.late', { y: 2 }, { clubId: null }));
      await outbox.drain();
      const got = [];
      outbox.subscribe('test.late', async (p, { clubId }) => got.push({ p, clubId }));
      await outbox.drain();
      assert.deepEqual(got, [{ p: { y: 2 }, clubId: null }], JSON.stringify(log.lines.filter((l) => l.level !== 'debug').slice(-5)));
    } finally {
      await outbox.stop();
    }
  });

  it('enqueue проверяет тему и тело; errorCode не пропускает текст с цифрами', async () => {
    await withContext(pool, { clubId: CLUB_A, actorType: 'system' }, async (tx) => {
      await assert.rejects(enqueue(tx, 'BadTopic', {}));
      await assert.rejects(enqueue(tx, 'a.b', [1]));
    });
    assert.equal(errorCode({ code: '23505', constraint: 'users_phone_key' }), 'pg:23505:users_phone_key');
    assert.equal(errorCode(new Error('телефон +7 999 123-45-67')), 'телефон ***');
  });

  it('RLS: в контексте клуба A событий клуба B не видно; без контекста — ничего', async () => {
    await db.pool.query(`insert into bl.clubs (id, name, city, timezone) values ('c2000000-0000-4000-8000-000000000002', 'Б', 'Владивосток', 'Asia/Vladivostok') on conflict do nothing`);
    await withContext(pool, { clubId: 'c2000000-0000-4000-8000-000000000002', actorType: 'system' }, (tx) => enqueue(tx, 'test.rls', { b: 1 }));
    const seenA = await withContext(pool, { clubId: CLUB_A, actorType: 'system' }, (tx) => tx.query("select * from bl.outbox where topic = 'test.rls'"));
    assert.equal(seenA.rowCount, 0);
    const seenUser = await withContext(pool, { clubId: null, userId: 'a1000000-0000-4000-8000-000000000001', actorType: 'user' }, (tx) =>
      tx.query('select * from bl.outbox'),
    );
    assert.equal(seenUser.rowCount, 0);
    await assert.rejects(
      withContext(pool, { clubId: CLUB_A, actorType: 'system' }, (tx) =>
        tx.query("insert into bl.outbox (club_id, topic, payload) values ('c2000000-0000-4000-8000-000000000002', 'x.y', '{}')"),
      ),
      /row-level security/,
    );
  });
});
