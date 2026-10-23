import assert from 'node:assert/strict';
import { test } from 'node:test';
import { render } from 'preact-render-to-string';
import { createApi } from '../src/api.mjs';
import { Bracket } from '../src/components.mjs';

// Д2 приёмки M4: после отмены идущего турнира матчи canceled — на сайте «Отменён», без стола
test('матч canceled в сетке сайта — «Отменён», без номера стола', async () => {
  const T = { id: 't1', title: 'Кубок', club: { id: 'c1' }, discipline: 'pool', status: 'canceled', starts_at: '2026-10-23T15:00:00Z',
    bracket: { rounds: [{ title: 'Финал', matches: [{ id: 'm1', a: { nick: 'A', seed: 1 }, b: { nick: 'B', seed: 2 }, score_a: null, score_b: null, status: 'canceled', winner: null, table_number: 3 }] }] } };
  const data = { get: async (path) => (path === '/api/public/tournaments/t1' ? T : path === '/api/public/cities' ? { items: [] } : null) };
  const res = await createApi(data).tournament('t1');
  assert.equal(res.bracket.rounds[0].matches[0].status, 'canceled');
  const h = render(Bracket({ bracket: res.bracket }));
  assert.match(h, /Отменён/);
  assert.doesNotMatch(h, /стол 3/);
});
