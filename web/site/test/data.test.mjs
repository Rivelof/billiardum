import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiUnavailable, createData } from '../src/data.mjs';

function counter(responses) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const r = responses.shift() ?? { status: 200, body: { n: calls.length } };
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  return { calls, fetchImpl };
}

test('ответы API кэшируются на 60 с: один запрос в минуту на адрес', async () => {
  let t = 0;
  const { calls, fetchImpl } = counter([]);
  const data = createData({ apiUrl: 'http://api', fetchImpl, now: () => t });
  assert.deepEqual(await data.get('/api/public/cities'), { n: 1 });
  t = 59_000;
  assert.deepEqual(await data.get('/api/public/cities'), { n: 1 });
  assert.equal(calls.length, 1);
  t = 60_000;
  assert.deepEqual(await data.get('/api/public/cities'), { n: 2 });
  assert.equal(calls[0], 'http://api/api/public/cities');
});

test('одновременные запросы одного адреса — один поход в API', async () => {
  const { calls, fetchImpl } = counter([]);
  const data = createData({ apiUrl: 'http://api', fetchImpl });
  await Promise.all([data.get('/x'), data.get('/x'), data.get('/x')]);
  assert.equal(calls.length, 1);
});

test('404 и 400 → null; 5xx и обрыв → устаревший ответ до 10 минут, иначе ApiUnavailable', async () => {
  let t = 0;
  const { fetchImpl } = counter([{ status: 404, body: { error: 'not_found' } }, { status: 400, body: { error: 'bad_request' } }, { status: 200, body: { ok: 1 } }, { status: 502, body: {} }, new Error('ECONNRESET'), { status: 500, body: {} }]);
  const data = createData({ apiUrl: 'http://api', fetchImpl, now: () => t });
  assert.equal(await data.get('/a'), null);
  assert.equal(await data.get('/b'), null);
  assert.deepEqual(await data.get('/c'), { ok: 1 });
  t = 61_000;
  assert.deepEqual(await data.get('/c'), { ok: 1 }, '502 — отдаём устаревшее');
  t = 120_000;
  assert.deepEqual(await data.get('/c'), { ok: 1 }, 'обрыв — отдаём устаревшее');
  t = 11 * 60_000;
  await assert.rejects(data.get('/c'), ApiUnavailable);
});

test('заглушка: тот же интерфейс без сети', async () => {
  const data = createData({ mock: true });
  const res = await data.get('/api/public/cities');
  assert.ok(res.items.length >= 1);
  assert.equal(await data.get('/api/public/cities/net-takogo'), null);
});
