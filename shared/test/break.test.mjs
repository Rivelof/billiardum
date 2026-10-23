import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BREAK_ASPECT, breakSvg, rack, simulateBreak } from '../break.mjs';

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
