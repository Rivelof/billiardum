import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateBreak, rack, BALL_R, FIELD, POCKETS } from '../src/lib/break-sim.js';
import * as shared from '@billiardum/shared/break';
import { isMiniAppHash } from '../src/lib/platform.js';

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

test('гость и сайт — один и тот же разбой: симуляция берётся из shared/break.mjs (№229)', () => {
  assert.equal(simulateBreak, shared.simulateBreak);
  assert.equal(rack, shared.rack);
  assert.equal(POCKETS, shared.POCKETS);
  assert.deepEqual(simulateBreak().frames, shared.simulateBreak().frames);
  // параметры сглаживания и хода — общие константы, а не копии в двух местах
  assert.equal(shared.SCROLL.tauMs, 150);
  assert.equal(shared.PHYSICS.cueSpeed, 2.0);
});

test('мини-приложения MAX и Telegram узнаются по параметрам запуска в адресе — там плавной прокрутки нет', () => {
  assert.equal(isMiniAppHash('#tgWebAppData=query_id%3DAA&tgWebAppVersion=8.0&tgWebAppPlatform=android'), true);
  assert.equal(isMiniAppHash('#tgWebAppPlatform=tdesktop'), true);
  assert.equal(isMiniAppHash('#WebAppData=abc&WebAppPlatform=ios'), true);
  assert.equal(isMiniAppHash('#/s/123'), false);
  assert.equal(isMiniAppHash('#features'), false);
  assert.equal(isMiniAppHash(''), false);
  assert.equal(isMiniAppHash(undefined), false);
});
