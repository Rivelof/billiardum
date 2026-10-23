// HTTP-ядро без базы: роутер (сопоставление путей, ошибки только кодом, CSRF, тело,
// заголовки безопасности, роли на поддельной базе), ограничение частоты, адрес клиента
// за Caddy, хаб SSE, исходящие запросы через прокси CONNECT и SOCKS5 (заглушки).

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import { compilePath, createRouter, loadRoutes, SECURITY_HEADERS } from '../../api/router.mjs';
import { clientIp, ipInCidrs, parseCidrs, parseCookies, serializeCookie } from '../http/request.mjs';
import { createRateLimiter } from '../http/rate-limit.mjs';
import { createSseHub, formatEvent } from '../http/sse.mjs';
import { httpRequest } from '../lib/http-client.mjs';
import { createTelegramBot } from '../lib/telegram-bot.mjs';
import { createHttpHandler } from '../http/server.mjs';
import { HttpError, safeErrorData } from '../http/errors.mjs';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const CLUB = 'c1000000-0000-4000-8000-000000000001';
const USER = 'a1000000-0000-4000-8000-000000000003';

/** Поддельная база: withContext в форме M0 и ответы на запросы ролей. */
function fakeApp(roles = []) {
  const db = {
    async query(sql) {
      if (/from bl\.club_members/.test(sql)) return { rows: roles.map((role) => ({ role, club_id: CLUB })), rowCount: roles.length };
      return { rows: [], rowCount: 0 };
    },
  };
  return {
    config: { allowedOrigins: ['https://bl.test'], consentVersion: 'v1' },
    log: silent,
    pool: {},
    clock: { now: () => new Date() },
    withContext: async (_pool, _opts, fn) => fn(db),
  };
}

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      const closed = new Promise((r) => server.close(r));
      server.closeAllConnections();
      return closed;
    },
  };
}

describe('роутер', () => {
  let srv;
  const principal = { tokenId: 't', kind: 'session', userId: USER, clubId: null, terminalId: null, hasPhone: true, consents: ['v1'] };
  const TOKEN = 'A'.repeat(43);
  const routes = [
    { method: 'GET', path: '/api/ping', auth: 'none', handler: async () => ({ status: 200, json: { pong: true } }) },
    { method: 'POST', path: '/api/echo', auth: 'guest', handler: async (_ctx, req) => ({ status: 200, json: req.body }) },
    { method: 'GET', path: '/api/clubs/{club}/staff', auth: 'staff', roles: ['owner'], handler: async (ctx) => ({ status: 200, json: { roles: ctx.roles } }) },
    { method: 'GET', path: '/api/items/new', auth: 'none', handler: async () => ({ status: 200, json: { which: 'static' } }) },
    { method: 'GET', path: '/api/items/{id}', auth: 'none', handler: async (_c, req) => ({ status: 200, json: { which: req.params.id } }) },
    { method: 'GET', path: '/api/boom', auth: 'none', handler: async () => { throw new Error('секрет +79991234567 в сообщении'); } },
    { method: 'GET', path: '/api/needs', auth: 'guest', requires: ['phone', 'consent'], handler: async () => ({ status: 200, json: {} }) },
    {
      method: 'GET',
      path: '/api/conflict',
      auth: 'none',
      handler: async () => {
        // Ошибка модуля в виде LightError/MoneyError: status, code и data.
        const err = new Error('booking_start_required: детали только в лог');
        Object.assign(err, {
          status: 409,
          code: 'booking_start_required',
          data: { booking_id: 'b1000000-0000-4000-8000-000000000001', busy_until: '2026-10-22T18:30:00.000Z', phone: '+79991234567', note: 'текст', resource_id: 'не uuid' },
        });
        throw err;
      },
    },
    {
      method: 'GET',
      path: '/api/conflict500',
      auth: 'none',
      handler: async () => {
        throw new HttpError(503, 'not_configured', { data: { booking_id: 'b1000000-0000-4000-8000-000000000001' } });
      },
    },
  ];

  before(async () => {
    let roles = ['owner'];
    const app = fakeApp(roles);
    app.withContext = async (_p, _o, fn) =>
      fn({
        async query(sql) {
          if (/from bl\.club_members/.test(sql)) return { rows: roles.map((role) => ({ role })), rowCount: roles.length };
          return { rows: [], rowCount: 0 };
        },
      });
    srv = await serve(
      createHttpHandler({
        router: createRouter(app, { routes, resolvePrincipal: async (t) => (t === TOKEN ? principal : null) }),
        checkDb: async () => {},
        mqttConnected: () => true,
        log: silent,
      }),
    );
    srv.setRoles = (r) => (roles = r);
  });

  after(() => srv.close());

  it('шаблоны путей: параметры — сегмент целиком; постоянный сегмент главнее параметра', async () => {
    assert.deepEqual(compilePath('/api/clubs/{club}/x').names, ['club']);
    assert.throws(() => compilePath('/api/a{b}'));
    assert.deepEqual(await (await fetch(`${srv.base}/api/items/new`)).json(), { which: 'static' });
    assert.equal((await fetch(`${srv.base}/api/items/abc`)).status, 404, 'id не UUID');
  });

  it('/health — как в M0; неизвестный путь — 404, метод — 405, ошибки только кодом', async () => {
    assert.deepEqual(await (await fetch(`${srv.base}/health`)).json(), { ok: true, db: true, mqtt: true });
    assert.deepEqual(await (await fetch(`${srv.base}/api/none`)).json(), { error: 'not_found' });
    const r = await fetch(`${srv.base}/api/ping`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 405);
    const boom = await fetch(`${srv.base}/api/boom`);
    assert.equal(boom.status, 500);
    assert.equal(await boom.text(), '{"error":"internal"}');
  });

  it('заголовки безопасности у каждого ответа', async () => {
    const r = await fetch(`${srv.base}/api/ping`);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(r.headers.get(k), v, k);
  });

  it('вход: без токена 401; Bearer; cookie требует свой Origin', async () => {
    const post = (headers) => fetch(`${srv.base}/api/echo`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"a":1}' });
    assert.equal((await post({})).status, 401);
    assert.deepEqual(await (await post({ authorization: `Bearer ${TOKEN}` })).json(), { a: 1 });
    assert.equal((await post({ cookie: `bl_session=${TOKEN}` })).status, 403);
    assert.equal((await post({ cookie: `bl_session=${TOKEN}`, origin: 'https://evil.test' })).status, 403);
    assert.equal((await post({ cookie: `bl_session=${TOKEN}`, origin: 'https://bl.test' })).status, 200);
    // Сверка с PUBLIC_HOST, а не с заголовком Host: подделанный Host не помогает.
    assert.equal((await post({ cookie: `bl_session=${TOKEN}`, origin: 'https://evil.test', host: 'evil.test' })).status, 403);
  });

  it('тело: Content-Type обязателен (415), больше 64 КБ — 413, не объект — 400', async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    assert.equal((await fetch(`${srv.base}/api/echo`, { method: 'POST', headers: auth, body: '{}' })).status, 415);
    const big = await fetch(`${srv.base}/api/echo`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ x: 'y'.repeat(70000) }) });
    assert.equal(big.status, 413);
    assert.equal((await fetch(`${srv.base}/api/echo`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '[1]' })).status, 400);
  });

  it('роли: нужная роль — 200, без неё — 403; phone и consent проверяются', async () => {
    const h = { authorization: `Bearer ${TOKEN}` };
    srv.setRoles(['owner']);
    assert.deepEqual(await (await fetch(`${srv.base}/api/clubs/${CLUB}/staff`, { headers: h })).json(), { roles: ['owner'] });
    srv.setRoles(['reception']);
    assert.equal((await fetch(`${srv.base}/api/clubs/${CLUB}/staff`, { headers: h })).status, 403);
    assert.equal((await fetch(`${srv.base}/api/needs`, { headers: h })).status, 200);
    principal.consents = [];
    assert.deepEqual(await (await fetch(`${srv.base}/api/needs`, { headers: h })).json(), { error: 'consent_required' });
    principal.hasPhone = false;
    assert.deepEqual(await (await fetch(`${srv.base}/api/needs`, { headers: h })).json(), { error: 'phone_required' });
    principal.hasPhone = true;
    principal.consents = ['v1'];
  });

  it('ошибка с данными: наружу только поля белого списка нужного вида (без ПДн); у 5xx — без данных', async () => {
    const r = await fetch(`${srv.base}/api/conflict`);
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: 'booking_start_required', booking_id: 'b1000000-0000-4000-8000-000000000001', busy_until: '2026-10-22T18:30:00.000Z' });
    assert.deepEqual(await (await fetch(`${srv.base}/api/conflict500`)).json(), { error: 'not_configured' });
    assert.deepEqual(safeErrorData({ limit_until: new Date('2026-10-22T20:00:00Z'), retry_after_sec: 30, extend_limit_until: null, error: 'x' }), {
      limit_until: '2026-10-22T20:00:00.000Z',
      retry_after_sec: 30,
      extend_limit_until: null,
    });
    assert.equal(safeErrorData({ phone: '+79991234567' }), null);
    assert.equal(safeErrorData('booking_id'), null);
  });

  it('M4: platform — только с ролями платформы; cache — только GET без входа; /api/public/* — только GET без входа', () => {
    const h = async () => ({ status: 200, json: {} });
    assert.throws(() => createRouter(fakeApp(), { routes: [{ method: 'GET', path: '/api/p', auth: 'platform', handler: h }] }), /roles платформы/);
    assert.throws(() => createRouter(fakeApp(), { routes: [{ method: 'GET', path: '/api/p', auth: 'platform', roles: ['owner'], handler: h }] }), /roles платформы/);
    assert.throws(() => createRouter(fakeApp(), { routes: [{ method: 'POST', path: '/api/c', auth: 'none', cache: 60, handler: h }] }), /cache/);
    assert.throws(() => createRouter(fakeApp(), { routes: [{ method: 'GET', path: '/api/c', auth: 'guest', cache: 60, handler: h }] }), /cache/);
    assert.throws(() => createRouter(fakeApp(), { routes: [{ method: 'POST', path: '/api/public/x', auth: 'none', handler: h }] }), /api\/public/);
    assert.throws(() => createRouter(fakeApp(), { routes: [{ method: 'GET', path: '/api/public/x', auth: 'guest', handler: h }] }), /api\/public/);
    const r = createRouter(fakeApp(), { routes: [{ method: 'GET', path: '/api/public/x', auth: 'none', handler: h }, { method: 'GET', path: '/api/public/s', auth: 'none', stream: true, handler: h }] });
    const x = r.routes.find((c) => c.path === '/api/public/x');
    assert.deepEqual([x.cache, x.rateLimit.max], [60, 120]);
    assert.equal(r.routes.find((c) => c.path === '/api/public/s').cache, undefined, 'поток без кэша');
    assert.deepEqual(safeErrorData({ limit: 1500, rating: 1620, nick: 'Иван' }), { limit: 1500, rating: 1620 });
    // reason — только код из закрытого списка.
    assert.deepEqual(safeErrorData({ reason: 'tournament', busy_until: '2026-10-23T18:00:00.000Z' }), { reason: 'tournament', busy_until: '2026-10-23T18:00:00.000Z' });
    for (const reason of ['Стол занят Иваном +79990000000', 'unknown_code', 'TOURNAMENT', 'a'.repeat(40), 5]) assert.equal(safeErrorData({ reason }), null, String(reason));
  });

  it('маршрут объявлен дважды — ошибка при сборке', () => {
    assert.throws(() => createRouter(fakeApp(), { routes: [routes[0], { ...routes[0] }] }), /дважды/);
    assert.throws(() => createRouter(fakeApp(), { routes: [{ method: 'GET', path: '/api/x', auth: 'staff', handler() {} }] }), /roles/);
  });
});

describe('короткая ссылка с наклейки /t/{code} (decisions №72)', () => {
  let srv;
  let dbCalls = 0;

  before(async () => {
    const app = fakeApp();
    app.withContext = async () => {
      dbCalls += 1;
      throw new Error('база не нужна');
    };
    const routes = await loadRoutes({ config: app.config, only: ['owner.mjs'] });
    srv = await serve(createHttpHandler({ router: createRouter(app, { routes }), checkDb: async () => {}, mqttConnected: () => true, log: silent }));
  });

  after(() => srv.close());

  const get = (path, headers = {}) => fetch(`${srv.base}${path}`, { redirect: 'manual', headers });

  it('верный код — 302 на /app/t/{CODE}, no-store; нижний регистр приводится; запрос в базу не идёт', async () => {
    for (const [path, loc] of [
      ['/t/TEST000004', '/app/t/TEST000004'],
      ['/t/test000004', '/app/t/TEST000004'],
      ['/t/4K7P9QW2XM', '/app/t/4K7P9QW2XM'],
      ['/t/TEST000004?next=https://evil.example&url=//evil.example', '/app/t/TEST000004'],
    ]) {
      const res = await get(path, { host: 'evil.example', referer: 'https://evil.example/' });
      assert.equal(res.status, 302, path);
      assert.equal(res.headers.get('location'), loc, path);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
    assert.equal(dbCalls, 0);
  });

  it('всё остальное — 404 без перенаправления', async () => {
    for (const path of [
      '/t/',
      '/t',
      '/t/TEST00000',
      '/t/TEST0000044',
      `/t/${'A'.repeat(500)}`,
      '/t/TEST00000I',
      '/t/TEST00000L',
      '/t/TEST00000O',
      '/t/TEST00000U',
      '/t/TEST-00004',
      '/t/..%2F..',
      '/t/..%2F..%2Fapi%2Fme',
      '/t/https:%2F%2Fevil.example',
      '/t/%2F%2Fevil.example',
      '/t/%5C%5Cevil.example',
      '/t/TEST000004%0D%0ALocation:%20https://evil.example',
      '/t/TEST000004/extra',
      '/t/%E2%80%AETEST00004',
      '/t/%ZZ',
    ]) {
      const res = await get(path);
      assert.equal(res.status, 404, path);
      assert.equal(res.headers.get('location'), null, path);
      assert.deepEqual(await res.json(), { error: 'not_found' }, path);
    }
  });

  it('db: false — только для маршрутов без входа', () => {
    assert.throws(() => createRouter(fakeApp(), { routes: [{ method: 'GET', path: '/x', auth: 'guest', db: false, handler() {} }] }), /db: false/);
  });
});

describe('адрес клиента за Caddy и ограничение частоты', () => {
  it('X-Forwarded-For — только от доверенного прокси, последний адрес цепочки', () => {
    const trusted = parseCidrs(['172.16.0.0/12', '127.0.0.1/32']);
    const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} });
    assert.equal(clientIp(req('::ffff:172.18.0.4', '1.2.3.4, 5.6.7.8'), { trustedProxies: trusted }), '5.6.7.8');
    assert.equal(clientIp(req('203.0.113.9', '1.2.3.4'), { trustedProxies: trusted }), '203.0.113.9', 'подделка с внешнего адреса');
    assert.equal(clientIp(req('127.0.0.1', 'не адрес'), { trustedProxies: trusted }), '127.0.0.1');
    assert.equal(clientIp(req('172.18.0.4')), '172.18.0.4');
    assert.ok(ipInCidrs('fd00::5', parseCidrs(['fc00::/7'])));
    assert.ok(!ipInCidrs('2001:db8::1', parseCidrs(['fc00::/7'])));
    assert.throws(() => parseCidrs(['10.0.0.0/33']));
  });

  it('окно на ключ: после max — отказ с Retry-After; новое окно — снова можно', () => {
    let now = 0;
    const rl = createRateLimiter({ now: () => now });
    const limit = { max: 2, windowMs: 1000 };
    assert.ok(rl.hit('a', limit).ok);
    assert.ok(rl.hit('a', limit).ok);
    const no = rl.hit('a', limit);
    assert.equal(no.ok, false);
    assert.equal(no.retryAfterSec, 1);
    assert.ok(rl.hit('b', limit).ok, 'другой ключ');
    now = 1000;
    assert.ok(rl.hit('a', limit).ok);
    const small = createRateLimiter({ now: () => now, maxKeys: 10 });
    for (let i = 0; i < 50; i += 1) small.hit(`k${i}`, limit);
    assert.ok(small.size <= 10, 'память ограничена');
  });

  it('cookie: разбор и Set-Cookie с HttpOnly, Secure, SameSite=Lax', () => {
    assert.deepEqual({ ...parseCookies('a=1; bl_session=xyz; a=2') }, { a: '1', bl_session: 'xyz' });
    assert.equal(serializeCookie('bl_session', 'abc', { path: '/api', maxAgeSec: 60 }), 'bl_session=abc; Path=/api; Max-Age=60; HttpOnly; Secure; SameSite=Lax');
    assert.throws(() => serializeCookie('x', 'a;b'));
  });
});

describe('хаб SSE', () => {
  function fakeRes() {
    const res = { chunks: [], writableEnded: false, writableLength: 0, headers: null, handlers: {} };
    res.writeHead = (s, h) => (res.headers = { status: s, ...h });
    res.write = (c) => res.chunks.push(c);
    res.end = () => {
      res.writableEnded = true;
      res.handlers.close?.();
    };
    res.on = (e, f) => (res.handlers[e] = f);
    return res;
  }

  it('события только подписчикам канала; keep-alive; закрытие; предел на пользователя', () => {
    const timers = { setInterval: (fn) => ({ fn, unref() {} }), clearInterval() {} };
    const hub = createSseHub({ timers, maxPerUser: 2 });
    const a = fakeRes();
    const b = fakeRes();
    hub.attach(a, { channels: [`club:${CLUB}`], userId: USER });
    hub.attach(b, { channels: [`session:${CLUB}`], userId: USER });
    assert.equal(a.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert.equal(hub.attach(fakeRes(), { channels: [`user:${USER}`], userId: USER }).ok, false);
    assert.equal(hub.publish(`club:${CLUB}`, 'alarm', { id: 1 }), 1);
    assert.equal(a.chunks.at(-1), formatEvent('alarm', { id: 1 }));
    assert.ok(!b.chunks.some((c) => c.includes('alarm')));
    assert.throws(() => hub.publish('club:not-uuid', 'alarm', {}));
    assert.throws(() => hub.attach(fakeRes(), { channels: ['anything'] }));
    a.end();
    assert.equal(hub.size, 1);
    hub.closeAll();
    assert.equal(hub.size, 0);
  });

  it('only: на канале — только разрешённые события (бармену — события бара)', () => {
    const hub = createSseHub({ timers: { setInterval: () => ({ unref() {} }), clearInterval() {} } });
    const a = fakeRes();
    hub.attach(a, { channels: [`club:${CLUB}`, `user:${USER}`], only: { [`club:${CLUB}`]: ['bar'] } });
    assert.equal(hub.publish(`club:${CLUB}`, 'pos_sale', {}), 0);
    assert.equal(hub.publish(`club:${CLUB}`, 'bar', { id: 1 }), 1);
    assert.equal(hub.publish(`user:${USER}`, 'reception_request', {}), 1, 'другие каналы — без фильтра');
    assert.ok(!a.chunks.some((c) => c.includes('pos_sale')));
  });

  it('медленный клиент с большим хвостом отключается', () => {
    const hub = createSseHub({ timers: { setInterval: () => ({ unref() {} }), clearInterval() {} } });
    const a = fakeRes();
    hub.attach(a, { channels: [`club:${CLUB}`] });
    a.writableLength = 2 * 1024 * 1024;
    hub.publish(`club:${CLUB}`, 'hall', {});
    assert.equal(hub.size, 0);
  });
});

describe('исходящие запросы через прокси (заглушки; настоящий Telegram недоступен из этой среды)', () => {
  let target;
  let connectProxy;
  let socksProxy;
  const seen = { connect: [], socks: [], target: [] };
  const sockets = new Set();

  before(async () => {
    target = await serve((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.target.push({ url: req.url, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: { echo: body ? JSON.parse(body) : null } }));
      });
    });
    const tPort = Number(new URL(target.base).port);
    // HTTP-прокси с CONNECT и Basic-авторизацией.
    connectProxy = http.createServer();
    connectProxy.on('connect', (req, socket) => {
      sockets.add(socket);
      seen.connect.push({ path: req.url, auth: req.headers['proxy-authorization'] });
      if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('u:p').toString('base64')}`) {
        socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        return;
      }
      const up = net.connect(tPort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        up.pipe(socket);
        socket.pipe(up);
      });
    });
    await new Promise((r) => connectProxy.listen(0, '127.0.0.1', r));
    // SOCKS5 с входом по логину и паролю (RFC 1929).
    socksProxy = net.createServer((sock) => {
      sockets.add(sock);
      let stage = 0;
      let buf = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (stage === 0 && buf.length >= 2 + buf[1]) {
          buf = buf.subarray(2 + buf[1]);
          sock.write(Buffer.from([5, 2]));
          stage = 1;
        }
        if (stage === 1 && buf.length >= 2 && buf.length >= 3 + buf[1] && buf.length >= 3 + buf[1] + buf[2 + buf[1]]) {
          const ulen = buf[1];
          const user = buf.subarray(2, 2 + ulen).toString();
          const plen = buf[2 + ulen];
          const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
          buf = buf.subarray(3 + ulen + plen);
          sock.write(Buffer.from([1, user === 'su' && pass === 'sp' ? 0 : 1]));
          stage = 2;
        }
        if (stage === 2 && buf.length >= 5 && buf.length >= 7 + buf[4]) {
          const host = buf.subarray(5, 5 + buf[4]).toString();
          const port = buf.readUInt16BE(5 + buf[4]);
          seen.socks.push(`${host}:${port}`);
          buf = Buffer.alloc(0);
          stage = 3;
          const up = net.connect(port, '127.0.0.1', () => {
            sock.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, port >> 8, port & 255]));
            up.pipe(sock);
            sock.pipe(up);
          });
        }
      });
    });
    await new Promise((r) => socksProxy.listen(0, '127.0.0.1', r));
  });

  after(async () => {
    for (const s of sockets) s.destroy();
    await target.close();
    connectProxy.closeAllConnections();
    await new Promise((r) => connectProxy.close(r));
    await new Promise((r) => socksProxy.close(r));
  });

  it('через HTTP CONNECT: туннель к цели, Basic-авторизация прокси; неверный пароль — ошибка', async () => {
    const tUrl = new URL(target.base);
    const res = await httpRequest(`http://localhost:${tUrl.port}/x?y=1`, { proxyUrl: `http://u:p@127.0.0.1:${connectProxy.address().port}` });
    assert.equal(res.status, 200);
    assert.equal(seen.connect.at(-1).path, `localhost:${tUrl.port}`);
    await assert.rejects(httpRequest(`http://localhost:${tUrl.port}/x`, { proxyUrl: `http://u:bad@127.0.0.1:${connectProxy.address().port}` }), /407/);
  });

  it('через SOCKS5: имя хоста передаётся прокси, вход по паролю', async () => {
    const tUrl = new URL(target.base);
    const res = await httpRequest(`http://localhost:${tUrl.port}/s`, { proxyUrl: `socks5://su:sp@127.0.0.1:${socksProxy.address().port}` });
    assert.equal(res.status, 200);
    assert.equal(seen.socks.at(-1), `localhost:${tUrl.port}`);
    await assert.rejects(httpRequest(`http://localhost:${tUrl.port}/s`, { proxyUrl: `socks5://su:no@127.0.0.1:${socksProxy.address().port}` }));
  });

  it('клиент Bot API: метод и JSON через прокси; токен не попадает в ошибку', async () => {
    const tUrl = new URL(target.base);
    const bot = createTelegramBot({
      token: '1:SECRET',
      proxyUrl: `http://u:p@127.0.0.1:${connectProxy.address().port}`,
      apiBase: `http://localhost:${tUrl.port}`,
    });
    const r = await bot.call('sendMessage', { chat_id: 1, text: 'Стол 4' });
    assert.deepEqual(r.echo, { chat_id: 1, text: 'Стол 4' });
    assert.equal(seen.target.at(-1).url, '/bot1:SECRET/sendMessage');
    const broken = createTelegramBot({ token: '1:SECRET', proxyUrl: 'http://127.0.0.1:1', apiBase: `http://localhost:${tUrl.port}` });
    await assert.rejects(broken.call('getMe'), (err) => !err.message.includes('SECRET'));
    assert.equal(createTelegramBot({ token: '1:x', proxyUrl: null }).configured, false, 'без прокси Telegram выключен');
  });
});
