import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateBreak, rack, BALL_R, FIELD } from '../src/lib/break-sim.js';

test('разбой: детерминированный, все 16 шаров в лузах, сукно чистое к концу, шары не вылетают за борт', () => {
  const a = simulateBreak();
  const b = simulateBreak();
  assert.deepEqual(a.frames, b.frames, 'одна и та же симуляция — одинаковые кадры');
  assert.equal(a.balls, 16);
  assert.ok(a.count > 60 && a.count <= 480, `${a.count} кадров`);
  const N = a.balls;
  const last = a.count - 1;
  for (let i = 0; i < N; i += 1) assert.ok(a.frames[(last * N + i) * 3 + 2] <= 0, `шар ${i} в лузе`);
  // первый кадр — собранная пирамида и биток, все на сукне
  for (let i = 0; i < N; i += 1) assert.equal(a.frames[i * 3 + 2], 1);
  for (let f = 0; f < a.count; f += 1) {
    for (let i = 0; i < N; i += 1) {
      const o = (f * N + i) * 3;
      if (a.frames[o + 2] < 1) continue;
      assert.ok(a.frames[o] >= BALL_R - 1e-6 && a.frames[o] <= FIELD.w - BALL_R + 1e-6, `x шара ${i} в кадре ${f}`);
      assert.ok(a.frames[o + 1] >= BALL_R - 1e-6 && a.frames[o + 1] <= FIELD.h - BALL_R + 1e-6, `y шара ${i} в кадре ${f}`);
    }
  }
  // пирамида: 15 шаров, не пересекаются
  const r = rack();
  assert.equal(r.length, 15);
  for (let i = 0; i < r.length; i += 1) for (let j = i + 1; j < r.length; j += 1) assert.ok(Math.hypot(r[i].x - r[j].x, r[i].y - r[j].y) >= 2 * BALL_R);
});
