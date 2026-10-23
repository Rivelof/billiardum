// Регресс R4 (браузерный прогон): сервер стартовал раньше Postgres — сообщения state/status
// контроллеров (retained, status больше не повторяется) упали, мост не восстанавливался.
// Здесь: база «не принимает соединения» первые 20 с; после её подъёма в пределах 30 с все
// контроллеры онлайн и получили актуальное состояние по базе.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createTestDb, SKIP, startLight } from './harness.mjs';

/** Пул, который пока down — отвечает как Postgres при старте (57P03). */
function flakyPool(real) {
  const state = { down: true };
  const refuse = () => Promise.reject(Object.assign(new Error('the database system is not accepting connections'), { code: '57P03' }));
  const pool = {
    connect: (...a) => (state.down ? refuse() : real.connect(...a)),
    query: (...a) => (state.down ? refuse() : real.query(...a)),
    on: () => pool,
    end: async () => {},
  };
  return { pool, state };
}

describe('R4: база недоступна при старте сервера', { skip: SKIP }, () => {
  let t;
  let h;
  let flaky;
  before(async () => {
    t = await createTestDb();
    flaky = flakyPool(t.app);
    h = await startLight(t, { connect: false, extra: { pool: flaky.pool } });
  });
  after(async () => {
    await h?.stop();
    await t?.drop();
  });

  it('20 с без базы → после подъёма ≤ 30 с все 4 стола онлайн, state.free по базе, devices_online не 0', async () => {
    for (const c of h.ctl.values()) await c.connect();
    await h.settle();
    assert.equal(h.st.bridge.stats().online, 0);
    assert.ok(h.logs('device_message_failed').length >= 8, 'status и state всех столов упали');
    for (let i = 0; i < 4; i += 1) await h.advance(5_000);
    assert.equal(h.st.bridge.stats().online, 0);
    flaky.state.down = false;
    let waited = 0;
    while (h.st.bridge.stats().online < 4 && waited < 30_000) {
      await h.advance(5_000);
      waited += 5_000;
    }
    assert.equal(h.st.bridge.stats().online, 4, `онлайн через ${waited} мс после подъёма базы`);
    await h.until(() => [...h.ctl.values()].every((c) => c.received.some((x) => x.type === 'state.free')), 'актуальное состояние каждому столу');
    assert.ok(h.logs('db_recovered').length >= 1);
    assert.ok(h.client.subscribes >= 2, 'повторная подписка: retained заново');
    assert.equal(h.logs('devices_online').at(-1).online, 4);
    const cmds = await t.q("select count(*)::int as n from bl.audit_log where action = 'device.cmd'");
    assert.ok(cmds.rows[0].n >= 4, 'каждая команда — в журнале');
  });
});
