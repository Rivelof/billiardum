import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createHandler } from '../lib/http.mjs';

const deps = { db: true, mqtt: true };
let server;
let base;

before(async () => {
  server = http.createServer(
    createHandler({
      checkDb: async () => {
        if (deps.db === 'hang') return new Promise(() => {});
        if (!deps.db) throw new Error('db down');
      },
      mqttConnected: () => deps.mqtt,
    }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

describe('GET /health (контракт M0 §6)', () => {
  it('200 {"ok":true,"db":true,"mqtt":true}, когда всё доступно', async () => {
    Object.assign(deps, { db: true, mqtt: true });
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^application\/json/);
    assert.deepEqual(await res.json(), { ok: true, db: true, mqtt: true });
  });

  it('503 того же вида, если недоступна база', async () => {
    Object.assign(deps, { db: false, mqtt: true });
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, db: false, mqtt: true });
  });

  it('503, если нет брокера', async () => {
    Object.assign(deps, { db: true, mqtt: false });
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, db: true, mqtt: false });
  });

  it('зависшая база — 503 по таймауту, а не вечное ожидание', async () => {
    Object.assign(deps, { db: 'hang', mqtt: true });
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, db: false, mqtt: true });
  });

  it('прочие пути — 404, другие методы — 405, ошибки только кодом', async () => {
    Object.assign(deps, { db: true, mqtt: true });
    const notFound = await fetch(`${base}/nope`);
    assert.equal(notFound.status, 404);
    assert.deepEqual(await notFound.json(), { error: 'not_found' });
    const post = await fetch(`${base}/health`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.deepEqual(await post.json(), { error: 'method_not_allowed' });
  });
});
