// Роутер на временной базе: Idempotency-Key (контракт §3), роли и клуб запроса,
// ограничение частоты по IP (подделанный X-Forwarded-For не обходит лимит), afterCommit.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { HttpError } from '../../http/errors.mjs';
import { parseCidrs } from '../../http/request.mjs';
import { createApp, importOptional } from '../../http/app.mjs';
import { createOutbox } from '../../outbox.mjs';
import { CLUB_A, memoryLog, startTestApp, testConfig } from './helpers.mjs';

let t;
let executed = 0;
const committed = [];

const testRoutes = [
  {
    method: 'POST',
    path: '/api/test/pay',
    auth: 'guest',
    idempotent: true,
    async handler(ctx, req) {
      executed += 1;
      await new Promise((r) => setTimeout(r, 150));
      return { status: 201, json: { n: executed, echo: req.body, key: req.idempotencyKey } };
    },
  },
  {
    method: 'POST',
    path: '/api/test/busy',
    auth: 'guest',
    idempotent: true,
    async handler() {
      executed += 1;
      throw new HttpError(409, 'table_busy');
    },
  },
  {
    method: 'GET',
    path: '/api/test/limited',
    auth: 'none',
    rateLimit: { max: 3, windowMs: 60_000 },
    async handler(_ctx, req) {
      return { status: 200, json: { ip: req.ip } };
    },
  },
  {
    method: 'POST',
    path: '/api/test/after-commit',
    auth: 'guest',
    async handler(ctx, req) {
      ctx.afterCommit(() => committed.push(req.body.n));
      if (req.body.fail) throw new HttpError(400, 'bad_request');
      return { status: 200, json: { ok: true } };
    },
  },
  {
    method: 'GET',
    path: '/api/test/staff/{id}',
    auth: 'staff',
    roles: ['owner', 'manager', 'reception'],
    async handler(ctx) {
      return { status: 200, json: { club: ctx.club, roles: ctx.roles } };
    },
  },
];

before(async () => {
  t = await startTestApp({
    extraRoutes: testRoutes,
    // Доверенный прокси — только 10.0.0.0/8: запросы теста с 127.0.0.1 не доверенные.
    config: { trustedProxies: parseCidrs(['10.0.0.0/8']) },
  });
});

after(async () => {
  await t?.stop();
});

describe('Idempotency-Key', () => {
  it('без ключа или с неверным ключом — 400', async () => {
    const { token } = await t.login('+79990001001');
    assert.equal((await t.request('POST', '/api/test/pay', { token, body: { a: 1 } })).status, 400);
    assert.equal((await t.request('POST', '/api/test/pay', { token, body: { a: 1 }, headers: { 'idempotency-key': 'not-a-uuid' } })).status, 400);
  });

  it('повтор с тем же ключом — тот же ответ без повторного исполнения; другое тело — 409', async () => {
    const { token } = await t.login('+79990001002');
    const key = randomUUID();
    const before = executed;
    const first = await t.request('POST', '/api/test/pay', { token, body: { a: 1 }, headers: { 'idempotency-key': key } });
    assert.equal(first.status, 201);
    const again = await t.request('POST', '/api/test/pay', { token, body: { a: 1 }, headers: { 'idempotency-key': key } });
    assert.equal(again.status, 201);
    assert.deepEqual(again.json, first.json);
    assert.equal(again.headers.get('idempotent-replayed'), 'true');
    assert.equal(executed, before + 1);
    const other = await t.request('POST', '/api/test/pay', { token, body: { a: 2 }, headers: { 'idempotency-key': key } });
    assert.equal(other.status, 409);
    assert.deepEqual(other.json, { error: 'idempotency_conflict' });
  });

  it('два одновременных запроса с одним ключом — одно исполнение, один ответ', async () => {
    const { token } = await t.login('+79990001003');
    const key = randomUUID();
    const before = executed;
    const [a, b] = await Promise.all([
      t.request('POST', '/api/test/pay', { token, body: { c: 1 }, headers: { 'idempotency-key': key } }),
      t.request('POST', '/api/test/pay', { token, body: { c: 1 }, headers: { 'idempotency-key': key } }),
    ]);
    assert.equal(executed, before + 1);
    assert.deepEqual(a.json, b.json);
  });

  it('тот же ключ у другого пользователя — своё исполнение', async () => {
    const u1 = await t.login('+79990001004');
    const u2 = await t.login('+79990001005');
    const key = randomUUID();
    const r1 = await t.request('POST', '/api/test/pay', { token: u1.token, body: {}, headers: { 'idempotency-key': key } });
    const r2 = await t.request('POST', '/api/test/pay', { token: u2.token, body: {}, headers: { 'idempotency-key': key } });
    assert.notEqual(r1.json.n, r2.json.n);
  });

  it('ошибка обработчика не сохраняется (повтор исполняется); ключ старше 24 ч — новое исполнение', async () => {
    const { token, user } = await t.login('+79990001006');
    const key = randomUUID();
    const before = executed;
    assert.equal((await t.request('POST', '/api/test/busy', { token, body: {}, headers: { 'idempotency-key': key } })).status, 409);
    assert.equal((await t.request('POST', '/api/test/busy', { token, body: {}, headers: { 'idempotency-key': key } })).status, 409);
    assert.equal(executed, before + 2);
    const key2 = randomUUID();
    const first = await t.request('POST', '/api/test/pay', { token, body: {}, headers: { 'idempotency-key': key2 } });
    await t.admin.query("update bl.idempotency_keys set created_at = created_at - interval '25 hours', expires_at = now() - interval '1 hour' where user_id = $1 and key = $2", [
      user.id,
      key2,
    ]);
    const second = await t.request('POST', '/api/test/pay', { token, body: {}, headers: { 'idempotency-key': key2 } });
    assert.notEqual(second.json.n, first.json.n);
  });

  it('RLS: ключи пользователя не видны другому пользователю', async () => {
    const u = await t.login('+79990001007');
    const { rows } = await t.admin.query('select count(*)::int as n from bl.idempotency_keys');
    assert.ok(rows[0].n > 0);
    const res = await t.app.ctx.withContext(t.pool, { clubId: null, userId: u.user.id, actorType: 'user' }, (db) => db.query('select * from bl.idempotency_keys'));
    assert.equal(res.rowCount, 0);
  });
});

describe('роли и клуб запроса', () => {
  it('единственный клуб персонала подставляется сам; гостю — 403; чужой X-Club-Id — 403', async () => {
    const manager = await t.login('+70000000003');
    const id = randomUUID();
    const ok = await t.request('GET', `/api/test/staff/${id}`, { token: manager.token });
    assert.deepEqual(ok.json, { club: CLUB_A, roles: ['manager'] });
    const guest = await t.login('+79990001008');
    assert.equal((await t.request('GET', `/api/test/staff/${id}`, { token: guest.token })).status, 403);
    const other = await t.request('GET', `/api/test/staff/${id}`, { token: manager.token, headers: { 'x-club-id': 'c9000000-0000-4000-8000-000000000009' } });
    assert.equal(other.status, 403);
  });

  it('параметр id не UUID — 404, неизвестный путь — 404, не тот метод — 405', async () => {
    const manager = await t.login('+70000000003');
    assert.equal((await t.request('GET', '/api/test/staff/12', { token: manager.token })).status, 404);
    assert.deepEqual((await t.request('GET', '/api/nope')).json, { error: 'not_found' });
    assert.deepEqual((await t.request('DELETE', '/api/me', { origin: null })).json, { error: 'method_not_allowed' });
  });
});

describe('ограничение частоты по IP', () => {
  it('после лимита — 429 с Retry-After; подделанный X-Forwarded-For с недоверенного адреса лимит не обходит', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await t.request('GET', '/api/test/limited', { headers: { 'x-forwarded-for': `203.0.113.${i}` } });
      assert.equal(res.status, 200);
      assert.equal(res.json.ip, '127.0.0.1', 'X-Forwarded-For от недоверенного адреса игнорируется');
    }
    const limited = await t.request('GET', '/api/test/limited', { headers: { 'x-forwarded-for': '198.51.100.7' } });
    assert.equal(limited.status, 429);
    assert.deepEqual(limited.json, { error: 'rate_limited' });
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  });
});

describe('сборка сервера', () => {
  it('модуля нет — сервер работает без него и создаёт мост M0; модуль есть — init(ctx) и stop() по порядку', async () => {
    assert.equal(await importOptional('../nonexistent-module.mjs'), null);
    const order = [];
    const fake = (name) => ({
      async init(ctx) {
        order.push(`init:${name}`);
        assert.ok(ctx.outbox && ctx.alarms && ctx.notify && ctx.sse && ctx.audit && ctx.withContext && ctx.clock);
      },
      async stop() {
        order.push(`stop:${name}`);
      },
    });
    const log = memoryLog();
    const app = await createApp({
      config: testConfig(),
      log,
      pool: t.pool,
      modules: [
        { name: 'light', spec: '../nonexistent-light.mjs' },
        { name: 'money', module: fake('money') },
      ],
      fallbackBridge: async () => {
        order.push('bridge:m0');
        return { isConnected: () => false };
      },
      outbox: createOutbox(),
      routes: [],
      listen: false,
    });
    assert.ok(log.lines.some((l) => l.msg === 'module_missing' && l.module === 'light'));
    assert.equal(app.ctx.bridge.isConnected(), false);
    await app.stop();
    assert.deepEqual(order, ['init:money', 'bridge:m0', 'stop:money']);
  });
});

describe('уборка', () => {
  it('просроченные ключи идемпотентности удаляются, действующие — нет', async () => {
    const { token } = await t.login('+79990001010');
    const k1 = randomUUID();
    const k2 = randomUUID();
    await t.request('POST', '/api/test/pay', { token, body: {}, headers: { 'idempotency-key': k1 } });
    await t.request('POST', '/api/test/pay', { token, body: {}, headers: { 'idempotency-key': k2 } });
    await t.admin.query("update bl.idempotency_keys set created_at = now() - interval '2 days', expires_at = now() - interval '1 day' where key = $1", [k1]);
    await t.app.janitor();
    const { rows } = await t.admin.query('select key from bl.idempotency_keys where key = any($1)', [[k1, k2]]);
    assert.deepEqual(rows.map((r) => r.key), [k2]);
  });
});

describe('afterCommit', () => {
  it('выполняется после коммита и не выполняется при откате', async () => {
    const { token } = await t.login('+79990001009');
    await t.request('POST', '/api/test/after-commit', { token, body: { n: 1 } });
    await t.request('POST', '/api/test/after-commit', { token, body: { n: 2, fail: true } });
    assert.deepEqual(committed, [1]);
  });
});
