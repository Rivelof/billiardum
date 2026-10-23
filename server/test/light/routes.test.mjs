// Маршруты light через настоящий роутер core (api/router.mjs) по HTTP: формат обработчика
// контракта §2.1, роли, коды ошибок §3, контекст клуба.

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createRouter } from '../../../api/router.mjs';
import { routes as deviceRoutes } from '../../../api/routes/devices.mjs';
import { routes as resourceRoutes } from '../../../api/routes/resources.mjs';
import { routes as sessionRoutes } from '../../../api/routes/sessions.mjs';
import { CLUB, createTestDb, GUEST, makePayment, OWNER, RECEPTION, RES, SKIP, startLight } from './harness.mjs';

describe('маршруты light через роутер core', { skip: SKIP }, () => {
  let t;
  let h;
  let server;
  let base;
  const principals = {
    g1: { kind: 'session', userId: GUEST(1), hasPhone: true, consents: [] },
    g2: { kind: 'session', userId: GUEST(2), hasPhone: true, consents: [] },
    owner: { kind: 'session', userId: OWNER, hasPhone: true, consents: [] },
    rec: { kind: 'session', userId: RECEPTION, hasPhone: true, consents: [] },
  };

  before(async () => {
    t = await createTestDb();
    h = await startLight(t, { devices: [1, 2] });
    const app = { ...h.ctx, config: { ...h.ctx.config, allowedOrigins: [] }, clock: h.ctx.clock, pool: t.app };
    const routes = [
      ...sessionRoutes.map((r) => ({ ...r, file: 'sessions.mjs' })),
      ...resourceRoutes.map((r) => ({ ...r, file: 'resources.mjs' })),
      ...deviceRoutes.map((r) => ({ ...r, file: 'devices.mjs' })),
    ];
    const router = createRouter(app, { routes, resolvePrincipal: async (tok) => principals[tok] ?? null });
    server = http.createServer((req, res) => router.handle(req, res));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    await h?.stop();
    await t?.drop();
  });

  async function call(method, path, { token, body, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  it('гость: текущие сессии, сессия, «Я играю», остановка (not_payer), выбор после interrupted — session_not_active', async () => {
    const pay = await makePayment(t, { resource: 1, minutes: 60, at: h.time.now() });
    const { session_id: sid } = await h.outbox.deliver('payment.confirmed', pay);
    assert.equal((await call('GET', '/api/sessions/current')).status, 401);
    const cur = await call('GET', '/api/sessions/current', { token: 'g1' });
    assert.equal(cur.status, 200);
    assert.equal(cur.json[0].id, sid);
    assert.equal(cur.json[0].is_payer, true);
    assert.equal((await call('GET', `/api/sessions/${sid}`, { token: 'g2' })).status, 404);
    assert.deepEqual(await call('POST', `/api/sessions/${sid}/join`, { token: 'g2', body: {} }), { status: 400, json: { error: 'bad_request' } });
    assert.deepEqual(await call('POST', `/api/sessions/${sid}/join`, { token: 'g2', body: { code: 'TEST000002' } }), { status: 404, json: { error: 'not_found' } });
    assert.deepEqual((await call('POST', `/api/sessions/${sid}/join`, { token: 'g2', body: { code: 'TEST000001' } })).json, { ok: true });
    const one = await call('GET', `/api/sessions/${sid}`, { token: 'g2' });
    assert.equal(one.status, 200);
    assert.equal(one.json.is_payer, false);
    assert.deepEqual(one.json.participants.map((p) => [p.nick, p.label]), [[null, 'Игрок 1'], [null, 'Игрок 2']]);
    assert.equal(one.json.participants.length, 2);
    assert.ok(one.json.participants.every((p) => /^[0-9a-f-]{36}$/.test(p.user_id)), 'user_id для выбора соперника');
    assert.deepEqual(await call('POST', `/api/sessions/${sid}/stop`, { token: 'g2', body: {} }), { status: 403, json: { error: 'not_payer' } });
    assert.deepEqual(await call('POST', `/api/sessions/${sid}/resolve`, { token: 'g1', body: { choice: 'continue' } }), {
      status: 409,
      json: { error: 'session_not_active' },
    });
    assert.deepEqual(await call('POST', `/api/sessions/${sid}/resolve`, { token: 'g1', body: { choice: 'x' } }), { status: 400, json: { error: 'bad_request' } });
    const rc = await call('GET', `/api/sessions/${sid}/receipt`, { token: 'g2' });
    assert.equal(rc.json.total_kopecks, 80_000);
    const stop = await call('POST', `/api/sessions/${sid}/stop`, { token: 'g1', body: {} });
    assert.equal(stop.status, 200);
    assert.equal(stop.json.status, 'closed');
    assert.equal((await call('GET', '/api/sessions/00000000-0000-4000-8000-000000000000', { token: 'g1' })).status, 404);
  });

  it('персонал: сервисный свет без причины — 400 reason_required, гостю — 403; зал; продление без оплаты ресепшену — 403', async () => {
    assert.deepEqual(await call('POST', `/api/resources/${RES(2)}/service`, { token: 'rec', body: { minutes: 5, reason_code: 'cleaning' } }), {
      status: 400,
      json: { error: 'reason_required' },
    });
    assert.equal((await call('POST', `/api/resources/${RES(2)}/service`, { token: 'g1', body: { minutes: 5, reason_code: 'cleaning', reason_text: 'x' } })).status, 403);
    const ok = await call('POST', `/api/resources/${RES(2)}/service`, { token: 'rec', body: { minutes: 5, reason_code: 'cleaning', reason_text: 'Уборка' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    const hall = await call('GET', `/api/clubs/${CLUB}/hall`, { token: 'rec' });
    assert.equal(hall.status, 200);
    assert.equal(hall.json.find((x) => x.resource.number === 2).status, 'service');
    assert.equal((await call('GET', `/api/clubs/${CLUB}/hall`, { token: 'g1' })).status, 403);
    assert.equal((await call('POST', `/api/resources/${RES(2)}/service/stop`, { token: 'rec', body: {} })).status, 200);
    const pay = await makePayment(t, { resource: 2, minutes: 30, at: h.time.now() });
    const { session_id: sid } = await h.outbox.deliver('payment.confirmed', pay);
    assert.equal((await call('POST', `/api/sessions/${sid}/extend-free`, { token: 'rec', body: { minutes: 5, reason_text: 'x' } })).status, 403);
    assert.deepEqual(await call('POST', `/api/sessions/${sid}/extend-free`, { token: 'owner', body: { minutes: 5 } }), { status: 400, json: { error: 'reason_required' } });
    const free = await call('POST', `/api/sessions/${sid}/extend-free`, { token: 'owner', body: { minutes: 5, reason_text: 'Компенсация' } });
    assert.equal(free.status, 200);
    assert.equal(free.json.id, sid);
    assert.equal((await call('POST', `/api/resources/${RES(1)}/identify`, { token: 'owner', body: { seconds: 10 } })).status, 200);
  });

  it('привязка: bind владельцем, claim без входа — ключи один раз; неверный запрос — 400, неверный код — 403', async () => {
    const dev = 'd9000000-0000-4000-8000-000000000002';
    assert.equal((await call('POST', `/api/clubs/${CLUB}/devices/bind`, { token: 'rec', body: { device_id: dev, resource_id: RES(3), claim_code: 'CODE-1234' } })).status, 403);
    const b = await call('POST', `/api/clubs/${CLUB}/devices/bind`, { token: 'owner', body: { device_id: dev, resource_id: RES(3), claim_code: 'CODE-1234' } });
    assert.equal(b.status, 200);
    assert.ok(b.json.bind_until);
    assert.equal((await call('POST', '/api/devices/claim', { body: { device_id: dev } })).status, 400);
    assert.deepEqual(await call('POST', '/api/devices/claim', { body: { device_id: dev, claim_code: 'CODE-0000' } }), { status: 403, json: { error: 'forbidden' } });
    const c = await call('POST', '/api/devices/claim', { body: { device_id: dev, claim_code: 'CODE-1234' } });
    assert.equal(c.status, 200);
    assert.deepEqual(Object.keys(c.json).sort(), ['club_id', 'device_key', 'mqtt_password', 'mqtt_url', 'mqtt_username']);
    assert.equal((await call('POST', '/api/devices/claim', { body: { device_id: dev, claim_code: 'CODE-1234' } })).status, 403);
    // Неудачная попытка записана, несмотря на откат транзакции запроса.
    const w = await t.q('select failed_attempts from bl.device_bind_windows where device_id = $1', [dev]);
    assert.equal(w.rows[0].failed_attempts, 1);
  });
});
