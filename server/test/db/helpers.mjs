// Общее для тестов сервера с базой (npm run test:db -w @billiardum/server).
// Каждый файл создаёт временную базу bl_test_* (миграции и сид, supabase/tests/helpers.mjs)
// и пул, где каждое соединение работает под ролью app_api (SET ROLE): те же права и RLS,
// что у сервера. HTTP-сервер приложения — на свободном порту 127.0.0.1.

import { randomBytes } from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import { createApp } from '../../http/app.mjs';
import { createOutbox } from '../../outbox.mjs';
import { hub } from '../../http/sse.mjs';
import { createLogger } from '../../lib/log.mjs';
import { createTestDatabase } from '../../../supabase/tests/helpers.mjs';

export const CLUB_A = 'c1000000-0000-4000-8000-000000000001';
export const OWNER_A = 'a1000000-0000-4000-8000-000000000001';
export const MANAGER_A = 'a1000000-0000-4000-8000-000000000003';
export const RECEPTION_A = 'a1000000-0000-4000-8000-000000000004';
export const RESOURCE_1 = 'e1000000-0000-4000-8000-000000000001';
export const ORIGIN = 'https://bl.test';
/** Маршруты core: тесты не зависят от маршрутов light и money. */
export const CORE_ROUTE_FILES = ['auth.mjs', 'owner.mjs', 'stream.mjs', 'staff.mjs'];

/** Пул под app_api к временной базе. */
export function appPool(url, { max = 10 } = {}) {
  const pool = new pg.Pool({ connectionString: url, max });
  pool.on('connect', (client) => {
    client.query('set role app_api').catch(() => {});
  });
  pool.on('error', () => {});
  return pool;
}

export function testConfig(overrides = {}) {
  return {
    nodeEnv: 'test',
    production: false,
    logLevel: 'debug',
    publicHost: 'bl.test',
    allowedOrigins: [ORIGIN],
    allowDevLogin: true,
    consentVersion: '2026-10-21',
    encKey: randomBytes(32),
    pinPepper: randomBytes(32),
    vapid: { publicKey: null, privateKey: null, subject: 'mailto:test@bl.test' },
    telegram: { botToken: null, botUsername: null, webhookSecret: null, proxyUrl: null },
    max: { botToken: null },
    ...overrides,
  };
}

/** Лог в массив: строки JSON разобраны. */
export function memoryLog() {
  const lines = [];
  const log = createLogger({ level: 'debug', write: (line) => lines.push(JSON.parse(line)) });
  log.lines = lines;
  return log;
}

/**
 * База, приложение (без модулей light и money) и HTTP-сервер.
 * @param {{ config?: object, routes?: object[], extraRoutes?: object[], telegram?: object, clock?: object, listen?: boolean, pollMs?: number }} [options]
 */
export async function startTestApp(options = {}) {
  const db = await createTestDatabase();
  const pool = appPool(db.url);
  const log = memoryLog();
  const config = testConfig(options.config);
  const clock = options.clock ?? { now: () => new Date() };
  const outbox = createOutbox({ pollMs: options.pollMs ?? 200, clock });
  // Общий хаб процесса: модули (alarms) публикуют в него напрямую. Файл тестов — свой процесс.
  const sse = hub;
  sse.setLogger(log);
  const { loadRoutes } = await import('../../../api/router.mjs');
  const core = () => loadRoutes({ config, only: CORE_ROUTE_FILES });
  const routes = options.routes ?? [...(await core()), ...(options.extraRoutes ?? [])];
  const app = await createApp({
    config,
    log,
    pool,
    clock,
    modules: [],
    outbox,
    sse,
    telegram: options.telegram,
    routes,
    listen: options.listen ?? true,
  });
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  /**
   * Запрос к API. token — Bearer; cookie — строка Cookie; origin по умолчанию свой.
   * @returns {Promise<{ status: number, json: any, headers: Headers, text: string }>}
   */
  async function request(method, path, { body, token, cookie, origin = ORIGIN, headers = {}, raw = false } = {}) {
    const h = { ...headers };
    if (method !== 'GET' && !('content-type' in h)) h['content-type'] = 'application/json';
    if (token) h.authorization = `Bearer ${token}`;
    if (cookie) h.cookie = cookie;
    if (origin && method !== 'GET') h.origin = origin;
    const res = await fetch(`${base}${path}`, { method, headers: h, body: method === 'GET' ? undefined : raw ? body : JSON.stringify(body ?? {}) });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, headers: res.headers, text, buf };
  }

  /** Вход для разработки по телефону: { token, user }. */
  async function login(phone) {
    const res = await request('POST', '/api/auth/dev', { body: { phone }, origin: null });
    if (res.status !== 200) throw new Error(`login ${phone}: ${res.status} ${res.text}`);
    return res.json;
  }

  return {
    db,
    pool,
    log,
    config,
    clock,
    outbox,
    sse,
    app,
    base,
    request,
    login,
    /** Суперпользователь (в обход RLS) — для проверок и подготовки данных. */
    admin: db.pool,
    async stop() {
      sse.closeAll();
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
      await app.stop();
      await pool.end();
      await db.drop();
    },
  };
}

/** Ждать условие до timeoutMs. */
export async function waitFor(fn, { timeoutMs = 5_000, stepMs = 20 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor: не дождались');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
