import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BREAK_ASPECT, BALL_R, FIELD, PHYSICS, SCROLL, breakRange, breakSvg, rack, sampleFrame, simulateBreak, smoothProgress } from '../break.mjs';

test('разбой: детерминированный, 16 шаров, к концу все в лузах', () => {
  const a = simulateBreak();
  const b = simulateBreak();
  assert.equal(a.balls, 16);
  assert.equal(a.count, b.count);
  assert.deepEqual([...a.frames.subarray(-48)], [...b.frames.subarray(-48)]);
  const last = (a.count - 1) * a.balls * 3;
  for (let i = 0; i < a.balls; i += 1) assert.equal(a.frames[last + i * 3 + 2], 0, `шар ${i} в лузе`);
  for (let i = 0; i < a.balls; i += 1) assert.equal(a.frames[i * 3 + 2], 1, `шар ${i} на сукне в начале`);
});

test('пирамида: 15 шаров с номерами 1–15', () => {
  assert.deepEqual(rack().map((b) => b.n), Array.from({ length: 15 }, (_, i) => i + 1));
});

test('картинка разбоя: пропорции стола, без атрибутов style и внешних ссылок', () => {
  const svg = breakSvg({ uid: 't' });
  assert.match(svg, /viewBox="0 0 3890 2115"/);
  assert.ok(Math.abs(BREAK_ASPECT - 2115 / 3890) < 1e-9);
  assert.doesNotMatch(svg, /style=|https?:\/\/|<script/);
  assert.equal((svg.match(/fill="url\(#t-b\)"/g) ?? []).length, 16);
  assert.match(breakSvg({ label: 'Стол' }), /<title>Стол<\/title>/);
});

test('разбой: детерминирован до последнего бита, все шары на сукне в границах, к концу все в лузах', () => {
  const a = simulateBreak();
  const b = simulateBreak();
  assert.deepEqual(a.frames, b.frames);
  assert.ok(a.count > 120 && a.count <= 480, `${a.count} кадров`);
  for (let f = 0; f < a.count; f += 1) {
    for (let i = 0; i < a.balls; i += 1) {
      const o = (f * a.balls + i) * 3;
      if (a.frames[o + 2] < 1) continue;
      assert.ok(a.frames[o] >= BALL_R - 1e-6 && a.frames[o] <= FIELD.w - BALL_R + 1e-6, `x шара ${i} в кадре ${f}`);
      assert.ok(a.frames[o + 1] >= BALL_R - 1e-6 && a.frames[o + 1] <= FIELD.h - BALL_R + 1e-6, `y шара ${i} в кадре ${f}`);
    }
  }
});

test('разбой мягче прежнего (№229): биток 2,0 вместо 2,9, шар не сдвигается за кадр сильнее прежнего порога', () => {
  assert.equal(PHYSICS.cueSpeed, 2.0);
  const s = simulateBreak();
  const N = s.balls;
  let max = 0;
  let over = 0;
  for (let f = 1; f < s.count; f += 1) {
    for (let i = 0; i < N; i += 1) {
      const a = ((f - 1) * N + i) * 3;
      const b = (f * N + i) * 3;
      if (s.frames[a + 2] < 1 || s.frames[b + 2] < 1) continue; // закатывающиеся — отдельно
      const d = Math.hypot(s.frames[b] - s.frames[a], s.frames[b + 1] - s.frames[a + 1]);
      max = Math.max(max, d);
      if (d > 0.025) over += 1;
    }
  }
  // было: 0,048 поля за кадр (биток 2,9), больше 0,025 — около сорока шаро-кадров; стало не больше 0,036 и мало таких кадров
  assert.ok(max < 0.036, `за кадр до ${max.toFixed(4)} поля`);
  assert.ok(over <= 20, `${over} шаро-кадров быстрее 0,025`);
  // шары замедляются: скорость в начале сильнее, чем через секунду после разбоя
  const speed = (f) => {
    let m = 0;
    for (let i = 0; i < N; i += 1) {
      const a = ((f - 1) * N + i) * 3;
      const b = (f * N + i) * 3;
      m = Math.max(m, Math.hypot(s.frames[b] - s.frames[a], s.frames[b + 1] - s.frames[a + 1]));
    }
    return m;
  };
  assert.ok(speed(60) < speed(20) * 0.6, 'затухание заметно');
});

test('закатывание в лузу растянуто: шар гаснет не быстрее 10 кадров', () => {
  const s = simulateBreak();
  const N = s.balls;
  for (let i = 0; i < N; i += 1) {
    const vis = [];
    for (let f = 0; f < s.count; f += 1) vis.push(s.frames[(f * N + i) * 3 + 2]);
    const first = vis.findIndex((v) => v < 1);
    const last = vis.findIndex((v) => v <= 0);
    assert.ok(first >= 0 && last > first, `шар ${i} закатился`);
    assert.ok(last - first >= 10, `шар ${i}: ${last - first} кадров`);
  }
});

test('smoothProgress: результат не зависит от частоты кадров (без предела скорости)', () => {
  const run = (dtMs, ms) => {
    let p = 0;
    for (let t = 0; t < ms - 1e-9; t += dtMs) p = smoothProgress(p, 1, dtMs, { maxRate: Infinity, eps: 0 });
    return p;
  };
  for (const ms of [500, 1000, 2000]) {
    const ref = run(1000 / 60, ms);
    for (const fps of [30, 120, 144]) assert.ok(Math.abs(run(1000 / fps, ms) - ref) < 1e-9, `${fps} fps, ${ms} мс`);
  }
  // постоянная времени: за tauMs остаётся 1/e
  assert.ok(Math.abs(1 - run(5, SCROLL.tauMs) - Math.exp(-1)) < 1e-9);
});

test('smoothProgress: не перескакивает цель, монотонен, сходится и садится ровно в цель', () => {
  for (const [from, to] of [[0, 1], [1, 0], [0.2, 0.25], [0.9, 0.1]]) {
    let p = from;
    let prev = p;
    let steps = 0;
    while (p !== to && steps < 2000) {
      p = smoothProgress(p, to, 16.7, { seconds: 3.3 });
      assert.ok(from < to ? p >= prev && p <= to : p <= prev && p >= to, `${from}→${to}: ${p}`);
      prev = p;
      steps += 1;
    }
    assert.equal(p, to, `${from}→${to} дошёл`);
    assert.ok(steps < 600, `${from}→${to}: ${steps} кадров`);
  }
  // огромный шаг времени (вкладка спала) — прямо в цель, а не за неё
  assert.equal(smoothProgress(0, 1, 1e9, { maxRate: Infinity }), 1);
  assert.equal(smoothProgress(0.4, 0.4, 16.7), 0.4);
  assert.equal(smoothProgress(0.3, 0.9, 0), 0.3);
  assert.equal(smoothProgress(0.3, 0.9, -5), 0.3);
});

test('smoothProgress: предел скорости — не больше maxRate секунд симуляции в секунду', () => {
  const seconds = 3.3;
  const dt = 1000 / 60;
  const cap = (SCROLL.maxRate * dt) / 1000 / seconds;
  // цель далеко: шаг равен пределу и не зависит от расстояния
  const a = smoothProgress(0, 1, dt, { seconds });
  assert.ok(Math.abs(a - cap) < 1e-12, `${a} против ${cap}`);
  const b = smoothProgress(1, 0, dt, { seconds });
  assert.ok(Math.abs(1 - b - cap) < 1e-12);
  // цель рядом: работает затухание, шаг меньше предела
  const c = smoothProgress(0, 0.004, dt, { seconds });
  assert.ok(c > 0 && c < 0.004);
  // резкая прокрутка из начала в конец занимает не меньше seconds / maxRate секунд
  let p = 0;
  let ms = 0;
  while (p < 1 && ms < 20000) {
    p = smoothProgress(p, 1, dt, { seconds });
    ms += dt;
  }
  assert.ok(ms >= (seconds / SCROLL.maxRate) * 1000 - dt, `${ms} мс`);
});

test('sampleFrame: целый прогресс — точно кадр предрасчёта, между кадрами — линейно по x, y и видимости', () => {
  const frames = new Float32Array([
    // кадр 0: два шара
    0.1, 0.2, 1, 0.5, 0.25, 1,
    // кадр 1
    0.3, 0.4, 0.5, 0.5, 0.25, 0,
    // кадр 2
    0.7, 0.0, 0, 0.5, 0.25, 0,
  ]);
  const at = (p) => [...sampleFrame(frames, 2, 3, p)];
  assert.deepEqual(at(0), [...frames.subarray(0, 6)]);
  assert.deepEqual(at(0.5), [...frames.subarray(6, 12)]);
  assert.deepEqual(at(1), [...frames.subarray(12, 18)]);
  const mid = at(0.25); // между кадрами 0 и 1, k = 0,5
  assert.ok(Math.abs(mid[0] - 0.2) < 1e-6 && Math.abs(mid[1] - 0.3) < 1e-6 && Math.abs(mid[2] - 0.75) < 1e-6);
  assert.ok(Math.abs(mid[5] - 0.5) < 1e-6);
  // за пределами — крайние кадры, без NaN
  assert.deepEqual(at(-3), at(0));
  assert.deepEqual(at(7), at(1));
  const out = new Float32Array(6);
  assert.equal(sampleFrame(frames, 2, 3, 0.1, out), out, 'пишет в переданный массив');
  // настоящая симуляция: между кадрами ни один шар не прыгает дальше, чем соседние кадры
  const s = simulateBreak();
  const f = 40.5 / (s.count - 1);
  const m = sampleFrame(s.frames, s.balls, s.count, f);
  for (let i = 0; i < s.balls; i += 1) {
    const a = (40 * s.balls + i) * 3;
    const b = (41 * s.balls + i) * 3;
    assert.ok(Math.abs(m[i * 3] - (s.frames[a] + s.frames[b]) / 2) < 1e-6);
  }
});

test('breakRange: разбой кончается, пока стол на экране; не длиннее потолка и страницы', () => {
  const g = { tableTop: 148, tableHeight: 313, viewport: 800, scrollable: 3200 };
  const r = breakRange(g);
  // прежний ход при тех же размерах: min(max(100, 148 + 0,45 × 313), 0,85 × 800, страница) = 289
  assert.ok(r > 289, `${r}`);
  assert.ok(r <= 148 + 313 * (1 - SCROLL.keepTable) + 1e-9);
  assert.ok(r <= 800 * SCROLL.spanScreens);
  assert.equal(breakRange({ ...g, scrollable: 90 }), 90, 'не длиннее страницы');
  assert.equal(breakRange({ ...g, scrollable: 0 }), 1);
  assert.equal(breakRange({ ...g, viewport: 200 }), 200 * SCROLL.spanScreens, 'потолок в высотах экрана');
  assert.equal(breakRange({ tableTop: 0, tableHeight: 40, viewport: 800, scrollable: 3000 }), SCROLL.minRange);
  assert.ok(SCROLL.spanScreens >= 1.3 && SCROLL.spanScreens <= 1.6);
  assert.ok(SCROLL.tauMs >= 120 && SCROLL.tauMs <= 180);
  assert.ok(SCROLL.autoStretch >= 1.5);
});
