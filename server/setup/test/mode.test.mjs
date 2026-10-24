// Режим клуба для ручных действий мастера (pentester П-2): приостановленный бывший live — боевой.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isLiveClub } from '../../lib/club-mode.mjs';
import { isLiveClub as shopsIsLiveClub } from '../../clubs/shops.mjs';
import { clubLive, isLive } from '../mode.mjs';

const CLUB = 'c1000000-0000-4000-8000-000000000001';

/** Транзакция без базы: app.club_mode и строка bl.clubs. */
function fakeDb({ setting = null, row = null } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push(sql);
      if (sql.includes("current_setting('app.club_mode'")) return { rows: [{ m: setting }] };
      if (sql.includes('information_schema.columns')) return { rows: [{ ok: true }] };
      if (sql.includes('select mode_before_suspend from bl.clubs')) {
        assert.deepEqual(params, [CLUB]);
        return { rows: row ? [{ mode_before_suspend: row.mode_before_suspend }] : [] };
      }
      if (sql.includes('select mode from bl.clubs')) return { rows: row ? [{ mode: row.mode }] : [] };
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

describe('боевой режим клуба (П-2)', () => {
  it('одна функция: live и приостановленный после live — боевые; test и после test — нет', () => {
    assert.equal(shopsIsLiveClub, isLiveClub, 'clubs/shops — та же функция');
    for (const f of [isLiveClub, isLive]) {
      assert.equal(f('live'), true);
      assert.equal(f('suspended', 'live'), true);
      assert.equal(f('suspended', 'test'), false);
      assert.equal(f('test'), false);
      assert.equal(f('test', null), false);
      assert.equal(f(null), false);
    }
  });

  it('clubLive: режим из ctx, настройки транзакции или таблицы; до приостановки — из таблицы', async () => {
    assert.deepEqual(await clubLive(fakeDb(), CLUB, { clubMode: 'live' }), { mode: 'live', live: true });
    assert.deepEqual(await clubLive(fakeDb(), CLUB, { clubMode: 'test' }), { mode: 'test', live: false });
    assert.deepEqual(await clubLive(fakeDb({ setting: 'live' }), CLUB), { mode: 'live', live: true });
    assert.deepEqual(await clubLive(fakeDb({ row: { mode: 'test' } }), CLUB), { mode: 'test', live: false });
    // Приостановлен после live: роутер даёт ctx.clubMode = 'suspended', mode_before_suspend — из bl.clubs.
    const db = fakeDb({ row: { mode_before_suspend: 'live' } });
    assert.deepEqual(await clubLive(db, CLUB, { clubMode: 'suspended' }), { mode: 'suspended', live: true });
    assert.ok(db.queries.some((q) => q.includes('mode_before_suspend')));
    assert.deepEqual(await clubLive(fakeDb({ setting: 'suspended', row: { mode_before_suspend: 'test' } }), CLUB), { mode: 'suspended', live: false });
    // Из объекта клуба в ctx — без запроса.
    const quiet = fakeDb();
    assert.deepEqual(await clubLive(quiet, CLUB, { club: { mode: 'suspended', mode_before_suspend: 'live' } }), { mode: 'suspended', live: true });
    assert.deepEqual(await clubLive(quiet, CLUB, { club: { mode: 'suspended', mode_before_suspend: 'test' } }), { mode: 'suspended', live: false });
    assert.equal(quiet.queries.length, 0);
    // Строку не прочитать — боевой: причина и уведомление лишними не бывают.
    assert.deepEqual(await clubLive(fakeDb(), CLUB, { clubMode: 'suspended' }), { mode: 'suspended', live: true });
  });
});
