// M4 core: роли платформы и журнал платформы (№134), уведомления платформе, публичные
// маршруты с кэшем и лимитом, публичный поток турнира tournament:{id}.

import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { ROLES } from '../../../api/router.mjs';
import { appendAudit } from '../../lib/audit.mjs';
import { safely, TxAbortedError, withContext } from '../../lib/store.mjs';
import { enqueue } from '../../outbox.mjs';
import { sendPlatform } from '../../notify/index.mjs';
import { CLUB_A, startTestApp, waitFor } from './helpers.mjs';

const ADMIN = 'af000000-0000-4000-8000-000000000009';
const OPERATOR = 'af000000-0000-4000-8000-000000000010';
let t;
let publicCalls = 0;
let lastPrincipal;

const extraRoutes = [
  {
    method: 'POST',
    path: '/api/test/swallow',
    auth: 'guest',
    handler: async (ctx, req) => {
      await ctx.db.query("update bl.users set name = 'Проглочено' where id = $1", [ctx.user.id]);
      const call = (db) => db.query('select 1 / 0');
      try {
        if (req.body.safely) await safely(ctx.db, call);
        else await call(ctx.db);
      } catch {
        // ошибку соседа поймали и продолжили
      }
      await ctx.db.query("update bl.users set name = 'После ошибки' where id = $1", [ctx.user.id]).catch(() => {});
      return { status: 200, json: { ok: true } };
    },
  },
  {
    method: 'GET',
    path: '/api/platform/whoami',
    auth: 'platform',
    roles: ROLES.PLATFORM_OPERATOR,
    handler: async (ctx) => {
      const db = (await ctx.db.query('select bl.ctx_platform_role() as r')).rows[0].r;
      await appendAudit(ctx.db, { action: 'platform.whoami', data: {} });
      return { status: 200, json: { role: ctx.platformRole, roles: ctx.roles, db } };
    },
  },
  { method: 'GET', path: '/api/platform/admin-only', auth: 'platform', roles: ROLES.PLATFORM_ADMIN, handler: async () => ({ status: 200, json: { ok: true } }) },
  {
    method: 'GET',
    path: '/api/public/test/{id}',
    auth: 'none',
    handler: async (ctx, req) => {
      publicCalls += 1;
      lastPrincipal = ctx.principal;
      if (req.params.id === '00000000-0000-4000-8000-000000000000') return { status: 404, json: { error: 'not_found' } };
      return { status: 200, json: { id: req.params.id, n: publicCalls, q: req.query.q ?? null } };
    },
  },
];

before(async () => {
  t = await startTestApp({ extraRoutes, notifyWorker: false });
});

after(async () => {
  await t?.stop();
});

describe('роли платформы (№134)', () => {
  it('auth platform: администратор — и как оператор; оператор — не администратор; гость — 403; без входа — 401', async () => {
    const admin = await t.login('+70000000009');
    const op = await t.login('+70000000010');
    const guest = await t.login('+79990020001');
    const a = await t.request('GET', '/api/platform/whoami', { token: admin.token });
    assert.deepEqual(a.json, { role: 'platform_admin', roles: ['platform_admin', 'platform_operator'], db: 'platform_admin' });
    const o = await t.request('GET', '/api/platform/whoami', { token: op.token });
    assert.deepEqual(o.json, { role: 'platform_operator', roles: ['platform_operator'], db: 'platform_operator' });
    assert.equal((await t.request('GET', '/api/platform/admin-only', { token: op.token })).status, 403);
    assert.equal((await t.request('GET', '/api/platform/admin-only', { token: admin.token })).status, 200);
    assert.equal((await t.request('GET', '/api/platform/whoami', { token: guest.token })).status, 403);
    assert.equal((await t.request('GET', '/api/platform/whoami')).status, 401);
    // X-Club-Id не переводит маршрут платформы в контекст клуба.
    assert.equal((await t.request('GET', '/api/platform/whoami', { token: op.token, headers: { 'x-club-id': CLUB_A } })).json.db, 'platform_operator');
    // Журнал платформы: запись от имени сотрудника (actor_type support), club_id null.
    const j = await t.admin.query("select club_id, actor_type, actor_id from bl.audit_log where action = 'platform.whoami' order by seq");
    assert.deepEqual(j.rows.map((r) => [r.club_id, r.actor_type, r.actor_id]).slice(0, 2), [
      [null, 'support', ADMIN],
      [null, 'support', OPERATOR],
    ]);
    const chain = await t.admin.query('select ok from bl.audit_verify(null)');
    assert.equal(chain.rows[0].ok, true, 'цепочка платформы цела');
  });

  it('GET /api/me: user.platform_role', async () => {
    assert.equal((await t.request('GET', '/api/me', { token: (await t.login('+70000000009')).token })).json.user.platform_role, 'platform_admin');
    assert.equal((await t.request('GET', '/api/me', { token: (await t.login('+70000000010')).token })).json.user.platform_role, 'platform_operator');
    assert.equal((await t.request('GET', '/api/me', { token: (await t.login('+79990020002')).token })).json.user.platform_role, null);
  });

  it('sendPlatform: операторам и Андрею из контекста клуба; операторов нет — администратору', async () => {
    const inClub = (fn) => withContext(t.pool, { clubId: CLUB_A, actorType: 'system' }, fn);
    const a = await inClub((db) => sendPlatform(db, { role: 'platform_operator', kind: 'platform.request', text: 'Заявка гостя без ответа клуба', level: 'important' }));
    const b = await inClub((db) => sendPlatform(db, { role: 'platform_admin', kind: 'platform.lead', text: 'Новая заявка клуба на программу' }));
    const users = async (ids) => (await t.admin.query('select user_id from bl.notifications where id = any($1::uuid[])', [ids])).rows.map((r) => r.user_id);
    assert.deepEqual(await users(a.ids), [OPERATOR]);
    assert.deepEqual(await users(b.ids), [ADMIN]);
    await t.admin.query('update bl.platform_members set active = false where user_id = $1', [OPERATOR]);
    try {
      const c = await inClub((db) => sendPlatform(db, { role: 'platform_operator', kind: 'platform.request', text: 'Ещё заявка' }));
      assert.deepEqual(await users(c.ids), [ADMIN]);
    } finally {
      await t.admin.query('update bl.platform_members set active = true where user_id = $1', [OPERATOR]);
    }
    await assert.rejects(inClub((db) => sendPlatform(db, { role: 'owner', kind: 'x.y', text: 'x' })), /role/);
  });
});

describe('публичные маршруты /api/public/* (кэш 60 с, лимит)', () => {
  it('ответ 200 общий и кэшируется 60 с (повтор без обработчика); токен не читается; ошибки не кэшируются', async () => {
    const id = randomUUID();
    const before = publicCalls;
    const guest = await t.login('+79990020003');
    const r1 = await t.request('GET', `/api/public/test/${id}?q=1`, { token: guest.token });
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('cache-control'), 'public, max-age=60');
    assert.equal(lastPrincipal, null, 'публичный маршрут анонимен');
    const r2 = await t.request('GET', `/api/public/test/${id}?q=1`);
    assert.deepEqual(r2.json, r1.json);
    assert.equal(r2.headers.get('cache-control'), 'public, max-age=60');
    assert.equal(publicCalls, before + 1, 'второй ответ из кэша');
    // Другой запрос — свой ключ кэша.
    assert.equal((await t.request('GET', `/api/public/test/${id}?q=2`)).json.q, '2');
    assert.equal(publicCalls, before + 2);
    // Ошибка — no-store и без кэша.
    const miss = '00000000-0000-4000-8000-000000000000';
    const e1 = await t.request('GET', `/api/public/test/${miss}`);
    assert.equal(e1.status, 404);
    assert.equal(e1.headers.get('cache-control'), 'no-store');
    await t.request('GET', `/api/public/test/${miss}`);
    assert.equal(publicCalls, before + 4);
  });

  it('лимит 120 в минуту с IP по умолчанию', async () => {
    t.app.router.rateLimiter.clear();
    t.app.router.responseCache.clear();
    let limited = null;
    for (let i = 0; i < 121; i += 1) {
      const r = await t.request('GET', `/api/public/test/${randomUUID()}`);
      if (r.status === 429) {
        limited = i;
        break;
      }
    }
    assert.equal(limited, 120);
    t.app.router.rateLimiter.clear();
  });
});

describe('публичный поток турнира tournament:{id}', () => {
  /** Открыть поток и читать события; close() — закрыть. */
  function openStream(path) {
    return new Promise((resolve, reject) => {
      const req = http.get(`${t.base}${path}`, (res) => {
        let buf = '';
        const waiters = [];
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          for (const w of [...waiters]) if (buf.includes(w.text)) (waiters.splice(waiters.indexOf(w), 1), w.resolve());
        });
        resolve({
          status: res.statusCode,
          headers: res.headers,
          wait: (text) => (buf.includes(text) ? Promise.resolve() : new Promise((r) => waiters.push({ text, resolve: r }))),
          text: () => buf,
          close: () => req.destroy(),
        });
      });
      req.on('error', (err) => (err.code === 'ECONNRESET' ? null : reject(err)));
    });
  }

  /** Турнир клуба A в базе: status registration — опубликован, draft — черновик. */
  async function tournament(status) {
    const id = randomUUID();
    const t0 = Date.now();
    await t.admin.query(
      `insert into bl.tournaments (id, club_id, title, discipline, format, race_to, fee_kopecks, places, match_minutes, starts_at, ends_at,
                                   registration_closes_at, status, created_at, updated_at)
       values ($1, $2, 'Поток', 'pool', 'single_elim', 2, 0, 8, 60, $3, $4, $3, $5, now(), now())`,
      [id, CLUB_A, new Date(t0 + 86_400_000), new Date(t0 + 90_000_000), status],
    );
    return id;
  }

  it('без входа: только канал турнира и только публичные события; лимит потоков с IP; неверный id — 400', async () => {
    const id = await tournament('registration');
    // M4-7: поток — только у опубликованного турнира: несуществующий и черновик — 404.
    assert.equal((await t.request('GET', `/api/public/stream?tournament=${randomUUID()}`)).status, 404);
    assert.equal((await t.request('GET', `/api/public/stream?tournament=${await tournament('draft')}`)).status, 404);
    const s = await openStream(`/api/public/stream?tournament=${id}`);
    assert.equal(s.status, 200);
    assert.match(s.headers['content-type'], /text\/event-stream/);
    await s.wait('event: ready');
    t.sse.publish(`tournament:${id}`, 'bracket', { rounds: [{ title: 'Финал', matches: [] }] });
    await s.wait('event: bracket');
    assert.throws(() => t.sse.publish(`tournament:${id}`, 'session', { phone: '+79990000000' }), /not public/);
    s.close();

    assert.equal((await t.request('GET', '/api/public/stream?tournament=abc')).status, 400);
    assert.equal((await t.request('GET', `/api/public/stream?tournament=${id}&club=${CLUB_A}`)).status, 400);

    const many = [];
    for (let i = 0; i < 10; i += 1) many.push(await openStream(`/api/public/stream?tournament=${id}`));
    const extra = await openStream(`/api/public/stream?tournament=${id}`);
    assert.equal(extra.status, 429);
    for (const m of many) m.close();
    extra.close();
  });
});

describe('проглоченная ошибка запроса не превращается в «успех» (tx_aborted_swallowed)', () => {
  it('обработчик поймал ошибку без savepoint — 500 и откат, в логе место; через safely — 200 и запись', async () => {
    const g = await t.login('+79990020010');
    const bad = await t.request('POST', '/api/test/swallow', { token: g.token, body: {} });
    assert.equal(bad.status, 500);
    assert.deepEqual(bad.json, { error: 'internal' });
    assert.equal((await t.admin.query('select name from bl.users where id = $1', [g.user.id])).rows[0].name, null, 'ничего не записано');
    const line = t.log.lines.find((l) => l.msg === 'tx_aborted_swallowed');
    assert.equal(line.pg_code, '22012');
    assert.match(line.swallowed_at, /m4-core\.test\.mjs/);
    const ok = await t.request('POST', '/api/test/swallow', { token: g.token, body: { safely: true } });
    assert.equal(ok.status, 200);
    assert.equal((await t.admin.query('select name from bl.users where id = $1', [g.user.id])).rows[0].name, 'После ошибки');
  });

  it('withContext: проглоченная ошибка — TxAbortedError и откат; ROLLBACK TO SAVEPOINT вручную — нормальный коммит', async () => {
    await assert.rejects(
      withContext(t.pool, { clubId: CLUB_A, actorType: 'system' }, async (db) => {
        await db.query('select 1 / 0').catch(() => {});
        return 'ok';
      }),
      (err) => err instanceof TxAbortedError && err.code === 'tx_aborted_swallowed',
    );
    const r = await withContext(t.pool, { clubId: CLUB_A, actorType: 'system' }, async (db) => {
      await db.query('savepoint x');
      await db.query('select 1 / 0').catch(() => {});
      await db.query('rollback to savepoint x');
      return (await db.query('select 2 as n')).rows[0].n;
    });
    assert.equal(r, 2);
  });

  it('outbox: обработчик с проглоченной ошибкой — повтор (не «обработано»); afterCommit — только после коммита', async () => {
    const hooks = [];
    let swallow = true;
    const off = t.outbox.subscribe(
      'test.swallow',
      async (_p, { db, afterCommit }) => {
        afterCommit(() => hooks.push('after'));
        if (swallow) await db.query('select 1 / 0').catch(() => {});
      },
      { name: 'test.swallow' },
    );
    try {
      await withContext(t.pool, { clubId: CLUB_A, actorType: 'system' }, (db) => enqueue(db, 'test.swallow', { n: 1 }));
      await waitFor(async () => (await t.admin.query("select attempts, last_error from bl.outbox where topic = 'test.swallow'")).rows[0]?.attempts >= 1);
      const row = (await t.admin.query("select last_error, processed_at from bl.outbox where topic = 'test.swallow'")).rows[0];
      assert.equal(row.last_error, 'tx_aborted_swallowed');
      assert.equal(row.processed_at, null);
      assert.deepEqual(hooks, [], 'хук отката не выполняется');
      swallow = false;
      await t.admin.query("update bl.outbox set next_attempt_at = now() where topic = 'test.swallow'");
      await waitFor(async () => (await t.admin.query("select processed_at from bl.outbox where topic = 'test.swallow'")).rows[0].processed_at !== null);
      await waitFor(() => hooks.length === 1);
      assert.deepEqual(hooks, ['after']);
    } finally {
      off();
    }
  });
});

