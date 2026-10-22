// Модуль light без базы и брокера: код стола, настройки клуба (тихие часы), фазы сессии,
// планировщик на поддельных часах. Тесты на базе — server/test/light/ (README модуля).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateCode, isCode, normalizeCode } from '../sessions/codes.mjs';
import { phaseOf, premarkNotified, unplayedMs } from '../sessions/kit.mjs';
import { buzzerFlag, graceMs, inQuietHours, serviceMaxMinutes, warnMs } from '../sessions/settings.mjs';
import { LightError, errorResponse } from '../sessions/errors.mjs';
import { createScheduler } from '../scheduler.mjs';
import { toHttpError } from '../http/errors.mjs';

const YEKB = 'Asia/Yekaterinburg';

describe('код стола (decisions №47)', () => {
  it('10 символов Crockford Base32 без I, L, O, U; нормализация ввода', () => {
    for (let i = 0; i < 200; i += 1) {
      const c = generateCode();
      assert.match(c, /^[0-9A-HJKMNP-TV-Z]{10}$/);
      assert.ok(isCode(c));
    }
    assert.equal(normalizeCode('test-oooo-o1'), 'TEST000001');
    assert.equal(normalizeCode('TEST 0000 L1'), 'TEST000011');
    assert.equal(normalizeCode('i234567890'), '1234567890');
    assert.equal(normalizeCode('TEST0000U1'), null, 'U нет в алфавите');
    assert.equal(normalizeCode('TEST00001'), null, '9 символов');
    assert.equal(normalizeCode('TEST0000011'), null, '11 символов');
    assert.equal(normalizeCode(null), null);
    assert.equal(normalizeCode('x'.repeat(100)), null);
  });

  it('50 бит: символы распределены по всему алфавиту', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i += 1) for (const ch of generateCode()) seen.add(ch);
    assert.equal(seen.size, 32);
  });
});

describe('настройки клуба', () => {
  it('значения по умолчанию и проверка диапазонов', () => {
    assert.equal(graceMs({}), 120_000);
    assert.equal(graceMs({ grace_ms: 0 }), 0);
    assert.equal(graceMs({ grace_ms: 700_000 }), 120_000);
    assert.deepEqual(warnMs({}), [300_000, 60_000]);
    assert.deepEqual(warnMs({ warn_ms: [600_000, 120_000] }), [600_000, 120_000]);
    assert.deepEqual(warnMs({ warn_ms: [60_000, 120_000] }), [300_000, 60_000], 'не по убыванию — по умолчанию');
    assert.equal(serviceMaxMinutes({}), 30);
    assert.equal(serviceMaxMinutes({ service_max_minutes: 45 }), 45);
    assert.equal(serviceMaxMinutes({ service_max_minutes: '45' }), 30);
  });

  it('тихие часы по местному времени клуба, интервал через полночь (decisions №32)', () => {
    const quiet = { buzzer_quiet: { from: '23:00', to: '09:00' } };
    // 18:30 UTC = 23:30 в Екатеринбурге (UTC+5).
    assert.equal(inQuietHours(quiet, new Date('2026-10-22T18:30:00Z'), YEKB), true);
    assert.equal(inQuietHours(quiet, new Date('2026-10-22T03:59:00Z'), YEKB), true, '08:59 местного');
    assert.equal(inQuietHours(quiet, new Date('2026-10-22T04:00:00Z'), YEKB), false, '09:00 местного');
    assert.equal(inQuietHours(quiet, new Date('2026-10-22T12:00:00Z'), YEKB), false);
    assert.equal(buzzerFlag(quiet, new Date('2026-10-22T18:30:00Z'), YEKB), false);
    assert.equal(buzzerFlag(quiet, new Date('2026-10-22T12:00:00Z'), YEKB), true);
    assert.equal(buzzerFlag({ buzzer: false }, new Date('2026-10-22T12:00:00Z'), YEKB), false);
    assert.equal(inQuietHours({ buzzer_quiet: [{ from: '13:00', to: '14:00' }, { from: 'xx', to: '1' }] }, new Date('2026-10-22T08:30:00Z'), YEKB), true);
    assert.equal(inQuietHours({ buzzer_quiet: { from: '10:00', to: '10:00' } }, new Date('2026-10-22T05:00:00Z'), YEKB), false);
  });
});

describe('фазы сессии и сигналы', () => {
  const now = new Date('2026-10-22T12:00:00Z');
  const at = (min) => new Date(now.getTime() + min * 60_000);
  it('active → ending (≤ 5 мин) → grace', () => {
    assert.equal(phaseOf(at(30), now, [300_000, 60_000]), 'active');
    assert.equal(phaseOf(at(5), now, [300_000, 60_000]), 'ending');
    assert.equal(phaseOf(at(0), now, [300_000, 60_000]), 'grace');
    assert.equal(phaseOf(at(-1), now, [300_000, 60_000]), 'grace');
  });
  it('пройденные пороги не шлются задним числом', () => {
    assert.deepEqual(premarkNotified({}, at(60), now), {});
    assert.deepEqual(premarkNotified({}, at(5), now), { t10: at(5).toISOString() });
    assert.deepEqual(premarkNotified({ t0: 'x' }, at(1), now), { t0: 'x', t10: at(1).toISOString(), t1: at(1).toISOString() });
  });
  it('недоигранное время — от подтверждённого контроллером конца', () => {
    assert.equal(unplayedMs({ paid_until: at(40), device_paid_until: at(10), started_at: now }), 30 * 60_000);
    assert.equal(unplayedMs({ paid_until: at(40), device_paid_until: null, started_at: now }), 40 * 60_000);
    assert.equal(unplayedMs({ paid_until: at(40), device_paid_until: at(41), started_at: now }), 0);
  });
});

describe('ошибки', () => {
  it('LightError → {status, code} для роутера core; прочие ошибки — 500', () => {
    const e = new LightError('not_payer', 'stop');
    assert.deepEqual(toHttpError(e), { status: 403, code: 'not_payer', headers: undefined });
    assert.deepEqual(errorResponse(new LightError('table_busy')), { status: 409, json: { error: 'table_busy' } });
    assert.equal(new LightError('reason_required').status, 400);
    assert.throws(() => errorResponse(new Error('x')));
  });
});

describe('планировщик на поддельных часах', () => {
  function fakeTime(start) {
    const q = new Map();
    let seq = 0;
    const time = {
      t: start,
      now: () => new Date(time.t),
      setTimeout: (fn, ms) => {
        const id = (seq += 1);
        q.set(id, { at: time.t + ms, fn });
        return id;
      },
      clearTimeout: (id) => q.delete(id),
      setInterval: () => 0,
      clearInterval: () => {},
      async advance(ms) {
        const end = time.t + ms;
        for (;;) {
          const next = [...q.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
          if (!next) break;
          q.delete(next[0]);
          time.t = next[1].at;
          next[1].fn();
          await new Promise((r) => setImmediate(r));
          await new Promise((r) => setImmediate(r));
        }
        time.t = end;
      },
    };
    return time;
  }

  it('восстанавливает сессии из базы, вызывает шаг в срок и перевзводит таймер по ответу', async () => {
    const time = fakeTime(Date.parse('2026-10-22T12:00:00Z'));
    const calls = [];
    const due = new Map([['s1', [time.t + 60_000, time.t + 120_000, null]]]);
    const pool = {};
    const withContext = async (_pool, opts, fn) => fn({ opts, query: async () => ({ rows: [{ session_id: 's1', club_id: 'c1000000-0000-4000-8000-000000000001' }] }) });
    const log = { info() {}, error() {}, warn() {}, debug() {} };
    const sch = createScheduler({
      pool,
      withContext,
      clock: time,
      log,
      timers: time,
      tick: async (_db, id) => {
        calls.push([id, time.t]);
        const next = due.get(id).shift();
        return next === null ? null : new Date(next);
      },
    });
    await sch.start();
    assert.equal(sch.size(), 1);
    assert.equal(calls.length, 1, 'сразу после восстановления — шаг');
    await time.advance(59_999);
    assert.equal(calls.length, 1);
    await time.advance(1);
    assert.equal(calls.length, 2);
    await time.advance(60_000);
    assert.equal(calls.length, 3);
    assert.equal(sch.size(), 0, 'сессия не идёт — таймер снят');
    await sch.stop();
  });

  it('ошибка шага — повтор через 5 с, без Date.now()', async () => {
    const time = fakeTime(1_000_000);
    let n = 0;
    const sch = createScheduler({
      pool: {},
      withContext: async (_p, _o, fn) => fn({ query: async () => ({ rows: [] }) }),
      clock: time,
      log: { info() {}, error() {}, warn() {}, debug() {} },
      timers: time,
      tick: async () => {
        n += 1;
        if (n === 1) throw new Error('база недоступна');
        return null;
      },
    });
    await sch.start();
    await sch.refresh('s2', 'c1000000-0000-4000-8000-000000000001');
    assert.equal(n, 1);
    await time.advance(5_000);
    assert.equal(n, 2);
    assert.equal(sch.size(), 0);
    await sch.stop();
  });
});
