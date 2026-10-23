// Сборка сервера M2 на временной базе: все модули (light, money, catalog, stock, pos, kkt)
// поднимаются через init(ctx) со всеми маршрутами api/routes/*.mjs; upgrade на /api/kkt/ws
// доходит до модуля ККТ, остальные upgrade закрываются; остановка не висит при открытом мосте.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import { loadRoutes } from '../../../api/router.mjs';
import { createApp, MODULES } from '../../http/app.mjs';
import { createOutbox } from '../../outbox.mjs';
import { appPool, memoryLog, testConfig } from './helpers.mjs';
import { createTestDatabase } from '../../../supabase/tests/helpers.mjs';

/** Клиент MQTT без брокера (модуль light создаёт мост на нём). */
class FakeMqtt extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
  }

  publish(_topic, _payload, _opts, cb) {
    cb?.();
  }

  subscribe(topics, _opts, cb) {
    cb?.(null, topics.map((topic) => ({ topic, qos: 1 })));
  }
}

/** Первый модуль теста: подставляет в ctx клиента MQTT и Dynamic Security без брокера. */
const setup = {
  async init(ctx) {
    ctx.mqttClient = new FakeMqtt();
    ctx.dynsec = { async ensureRole() {}, async ensureClient() {} };
  },
  async stop() {},
};

async function listen(app) {
  const server = http.createServer(app.handler);
  server.on('upgrade', (req, socket, head) => app.upgrade(req, socket, head));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

/** Сырой запрос upgrade: ответ сервера до закрытия сокета (или '' — закрыт без ответа). */
function rawUpgrade(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      const lines = [`GET ${path} HTTP/1.1`, 'Host: 127.0.0.1', 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='];
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      sock.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    let data = '';
    sock.on('data', (c) => (data += c.toString('latin1')));
    sock.on('close', () => resolve(data));
    sock.on('error', (err) => (err.code === 'ECONNRESET' ? resolve(data) : reject(err)));
    sock.setTimeout(5000, () => {
      sock.destroy();
      resolve(`TIMEOUT ${data}`);
    });
  });
}

let db;
let pool;

before(async () => {
  db = await createTestDatabase();
  pool = appPool(db.url);
});

after(async () => {
  await pool?.end();
  await db?.drop();
});

describe('сервер со всеми модулями M2', () => {
  it('модули поднимаются по порядку, маршруты всех модулей собираются, WS ККТ доходит до модуля, остановка не висит', async () => {
    const log = memoryLog();
    const config = testConfig();
    const routes = await loadRoutes({ config });
    const app = await createApp({ config, log, pool, modules: [{ name: 'setup', module: setup }, ...MODULES], outbox: createOutbox(), routes, listen: false });
    const started = log.lines.filter((l) => l.msg === 'module_started').map((l) => l.module);
    const missing = log.lines.filter((l) => l.msg === 'module_missing').map((l) => l.module);
    // Модули M3 и M4 соседей появляются по ходу волны: их может ещё не быть.
    assert.ok(missing.every((m) => ['packages', 'bookings', 'waitlist', 'directory', 'plus', 'tournaments'].includes(m)), `нет модулей: ${missing}`);
    const order = ['setup', 'light', 'money', 'catalog', 'stock', 'pos', 'kkt', 'packages', 'bookings', 'waitlist', 'summaries', 'directory', 'plus', 'tournaments', 'clubs'].filter(
      (m) => !missing.includes(m),
    );
    assert.deepEqual(started, order);
    // Маршруты всех модулей: core, light, money, pos (каталог, касса, склад), kkt (мосты, смены).
    for (const p of ['/api/me', '/t/{code}', '/api/sessions/{id}', '/api/t/{code}', '/api/clubs/{club}/catalog', '/api/clubs/{club}/pos/sales', '/api/clubs/{club}/stock', '/api/clubs/{club}/kkt/status', '/api/clubs/{club}/shifts', '/api/clubs/{club}/onboarding']) {
      assert.ok(app.router.routes.some((r) => r.path === p), `маршрут ${p}`);
    }
    const { server, port } = await listen(app);
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal((await health.json()).db, true);
      // Мост без токена — ответ модуля ККТ (401), а не закрытие сокета ядром.
      const ws = await rawUpgrade(port, '/api/kkt/ws');
      assert.match(ws, /^HTTP\/1\.1 401 /);
      assert.match(ws, /"error":"unauthorized"/);
      // Любой другой путь — сокет закрывается без ответа.
      assert.equal(await rawUpgrade(port, '/api/stream'), '');
      assert.equal(await rawUpgrade(port, '/api/kkt/ws/../me'), '');
    } finally {
      const t0 = Date.now();
      await app.shutdown(server, { timeoutMs: 5000 });
      assert.ok(Date.now() - t0 < 4000, 'остановка не ждёт таймаута');
    }
    const stopped = log.lines.filter((l) => /_stopped$|module_stop_failed/.test(l.msg));
    assert.ok(!stopped.some((l) => l.msg === 'module_stop_failed'), JSON.stringify(stopped));
  });

  it('открытый мост ККТ (апгрейд принят) не держит остановку: closeConnections закрывает его до server.close()', async () => {
    const sockets = new Set();
    let closedByModule = 0;
    const kkt = {
      async init() {},
      async stop() {},
      handleUpgrade(req, socket) {
        if (new URL(req.url, 'http://x').pathname !== '/api/kkt/ws') return false;
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        sockets.add(socket);
        return true;
      },
      closeConnections() {
        for (const s of sockets) {
          closedByModule += 1;
          s.destroy();
        }
      },
    };
    const log = memoryLog();
    const app = await createApp({ config: testConfig(), log, pool, modules: [{ name: 'kkt', module: kkt }], outbox: createOutbox(), routes: [], listen: false });
    const { server, port } = await listen(app);
    const client = net.connect(port, '127.0.0.1');
    await new Promise((r) => client.on('connect', r));
    client.write('GET /api/kkt/ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    await new Promise((r) => client.once('data', r));
    const clientClosed = new Promise((r) => client.on('close', r));
    client.on('error', () => {});
    const t0 = Date.now();
    await app.shutdown(server, { timeoutMs: 5000 });
    assert.ok(Date.now() - t0 < 2000, `остановка ${Date.now() - t0} мс`);
    assert.equal(closedByModule, 1);
    await clientClosed;
  });
});
