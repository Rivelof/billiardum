// Обвязка тестов подключения клуба (M5.1 backend-A) на настоящем Postgres и эмуляторе ЮKassa.
//
// * Временная база с миграциями и сидом (клуб сида — live, как до M5.1), второй клуб для изоляции.
// * Приложение — настоящий createApp: роутер, outbox, тревоги, уведомления, журнал; маршруты:
//   вход (auth), подключение клуба (clubs), вебхук ЮKassa (webhooks), котировки (quotes) и
//   проверочный маршрут ctx.clubMode / ctx.manual. Модуль clubs — с подменой соседей backend-B.
// * ЮKassa — эмулятор tools/yookassa-emu/ в процессе теста: магазины test (900101), live (900102),
//   live без фискализации (900103); вебхуки — на сервер теста.

import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { createEmulator } from '../../../../tools/yookassa-emu/lib/emulator.mjs';
import { createApp } from '../../../http/app.mjs';
import { createOutbox } from '../../../outbox.mjs';
import { loadMoneyConfig } from '../../../payments/config.mjs';
import { loadRoutes } from '../../../../api/router.mjs';
import { appPool, memoryLog, ORIGIN, testConfig } from '../../../test/db/helpers.mjs';
import { createTestDatabase, seedClubB } from '../../../../supabase/tests/helpers.mjs';
import * as clubsModule from '../../index.mjs';

export const CLUB_A = 'c1000000-0000-4000-8000-000000000001';
export const CLUB_B = 'c2000000-0000-4000-8000-000000000002';
export const OWNER_A = 'a1000000-0000-4000-8000-000000000001';
export const SHOPS = {
  test: { shopId: '900101', secret: `test_${randomBytes(12).toString('hex')}`, test: true },
  live: { shopId: '900102', secret: `live_${randomBytes(12).toString('hex')}`, test: false, fiscalization: true },
  liveNoFiscal: { shopId: '900103', secret: `live_${randomBytes(12).toString('hex')}`, test: false, fiscalization: false },
};

/** Подменяемые функции соседей backend-B (§3): по умолчанию — ничего не готово. */
export function fakeNeighbors() {
  const state = { covers: false, printedAt: null };
  return {
    state,
    neighbors: {
      tariffs: { coversWeek: async () => (state.covers ? { ok: true } : { ok: false, gap: { weekday: 6, from: '00:00', to: '12:00', kind: 'pool' } }) },
      qr: { printedAt: async () => state.printedAt },
    },
  };
}

export async function setup() {
  const db = await createTestDatabase();
  await seedClubB(db.pool);
  const config = testConfig();
  const admin = db.pool;
  const emu = createEmulator({ shops: Object.values(SHOPS), webhookRetries: 3, webhookRetryDelayMs: 50 });
  const emuAddr = await emu.listen(0);
  const emuBase = `http://127.0.0.1:${emuAddr.port}`;
  emu.config.publicUrl = emuBase;
  const moneyConfig = loadMoneyConfig({ YOOKASSA_API_URL: `${emuBase}/v3`, PUBLIC_HOST: 'bl.test', NODE_ENV: 'test' }, { encKey: config.encKey });
  const clock = { offsetMs: 0, now() { return new Date(Date.now() + this.offsetMs); } };
  const pool = appPool(db.url, { max: 20 });
  const log = memoryLog();
  const outbox = createOutbox({ pollMs: 100, clock });
  const sse = { publish() {}, closeAll() {}, setLogger() {} };
  const fake = fakeNeighbors();
  const setupModule = {
    async init(ctx) {
      ctx.money = { config: moneyConfig };
      ctx.clubsModule = { neighbors: fake.neighbors, tickMs: 3_600_000 };
    },
    async stop() {},
  };
  // Проверочный маршрут: режим клуба запроса и ручное действие (ctx.clubMode, ctx.manual).
  const probe = [
    {
      method: 'GET',
      path: '/api/test/clubs/{club}/mode',
      auth: 'staff',
      roles: ['owner', 'manager'],
      handler: async (ctx) => ({
        json: { mode: ctx.clubMode, guc: (await ctx.db.query("select current_setting('app.club_mode', true) as m")).rows[0].m },
      }),
    },
    {
      method: 'POST',
      path: '/api/test/clubs/{club}/manual',
      auth: 'staff',
      roles: ['owner', 'manager'],
      handler: async (ctx, req) => ({ json: await ctx.manual({ action: 'manual.tariff_change', reason: req.body.reason, objectType: 'club', objectId: ctx.club, text: 'Изменён тариф клуба.' }) }),
    },
  ].map((r) => ({ ...r, file: 'probe' }));
  const routes = [...(await loadRoutes({ config, only: ['auth.mjs', 'clubs.mjs', 'webhooks.mjs', 'quotes.mjs'] })), ...probe];
  const app = await createApp({
    config,
    log,
    pool,
    clock,
    modules: [{ name: 'setup', module: setupModule }, { name: 'clubs', module: clubsModule }],
    outbox,
    sse,
    routes,
  });
  await app.ctx.notify.stop();
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  emu.config.webhookUrl = `${base}/api/webhooks/yookassa/{club_id}`;

  async function request(method, path, { body, token, headers = {}, key } = {}) {
    const h = { ...headers };
    if (method !== 'GET') {
      h['content-type'] = 'application/json';
      h.origin = ORIGIN;
    }
    if (token) h.authorization = `Bearer ${token}`;
    if (key) h['idempotency-key'] = key;
    const res = await fetch(`${base}${path}`, { method, headers: h, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  }

  const tokens = new Map();
  async function login(phone, { consent = true } = {}) {
    if (tokens.has(phone)) return tokens.get(phone);
    const res = await request('POST', '/api/auth/dev', { body: { phone } });
    if (res.status !== 200) throw new Error(`login ${phone}: ${res.status} ${res.text}`);
    if (consent) {
      const c = await request('POST', '/api/auth/consent', { body: { version: config.consentVersion }, token: res.json.token });
      if (c.status !== 200) throw new Error(`consent ${phone}: ${c.status}`);
    }
    const out = { token: res.json.token, id: res.json.user.id };
    tokens.set(phone, out);
    return out;
  }

  async function waitFor(fn, timeoutMs = 8000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > until) throw new Error('waitFor: не дождались');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  return {
    db,
    admin,
    pool,
    app,
    base,
    log,
    emu,
    emuBase,
    config,
    moneyConfig,
    clock,
    outbox,
    fake,
    request,
    login,
    waitFor,
    newKey: () => randomUUID(),
    async q(sql, params) {
      return (await admin.query(sql, params)).rows;
    },
    /** Один проход планировщика модуля clubs. */
    tick() {
      return clubsModule.tick({
        pool,
        withContext: app.ctx.withContext,
        deps: { clock, log, alarms: app.ctx.alarms, audit: app.ctx.audit, outbox },
        config: moneyConfig,
      });
    },
    async stop() {
      await new Promise((r) => {
        server.close(r);
        server.closeAllConnections?.();
      });
      await app.stop();
      await emu.close();
      await pool.end();
      await db.drop();
    },
  };
}
