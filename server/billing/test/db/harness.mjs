// Обвязка тестов подписки клубов (M5.3) на настоящем Postgres и эмуляторе ЮKassa.
//
// * Временная база с миграциями и сидом: клуб A сида и клуб B — боевые (как клубы до M5.3),
//   пробный период — с выкатки (released_at).
// * Приложение — настоящий createApp: роутер, outbox, уведомления, журнал; маршруты: вход (auth),
//   подписка (billing), клубы (clubs — приостановка платформой, магазин клуба), вебхуки (webhooks —
//   гостей и платформы), котировки (quotes — «игры работают»).
//   Модуль billing — с подставными часами (clock.offsetMs) и планировщиком по вызову (tick()).
// * ЮKassa — эмулятор tools/yookassa-emu/ в процессе теста: магазин платформы 700001 (вебхук —
//   /api/webhooks/yookassa-platform) и боевой магазин клуба A 900301 (вебхук — адрес клуба).

import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import { createEmulator } from '../../../../tools/yookassa-emu/lib/emulator.mjs';
import { createApp } from '../../../http/app.mjs';
import { createOutbox } from '../../../outbox.mjs';
import { loadMoneyConfig } from '../../../payments/config.mjs';
import { encryptShopSecret } from '../../../payments/settings.mjs';
import { loadRoutes } from '../../../../api/router.mjs';
import { appPool, memoryLog, ORIGIN, testConfig } from '../../../test/db/helpers.mjs';
import { createTestDatabase, seedClubB } from '../../../../supabase/tests/helpers.mjs';
import { loadBillingConfig } from '../../config.mjs';
import * as billingModule from '../../index.mjs';

export const CLUB_A = 'c1000000-0000-4000-8000-000000000001';
export const CLUB_B = 'c2000000-0000-4000-8000-000000000002';
export const PLAN_CLUB = 'bf000000-0000-4000-8000-000000000001';
export const PHONES = {
  ownerA: '+70000000001',
  ownerB: '+70000000002',
  managerA: '+70000000003',
  receptionA: '+70000000004',
  andrey: '+70000000009',
  operator: '+70000000010',
};
export const PLATFORM_SHOP = { shopId: '700001', secret: `live_${randomBytes(16).toString('hex')}`, test: false, fiscalization: true };
export const CLUB_SHOP = { shopId: '900301', secret: `live_${randomBytes(16).toString('hex')}`, test: false, fiscalization: true };

export async function setup({ configured = true } = {}) {
  const db = await createTestDatabase();
  await seedClubB(db.pool);
  const config = testConfig();
  const admin = db.pool;
  const emu = createEmulator({ shops: [CLUB_SHOP], webhookRetries: 6, webhookRetryDelayMs: 50 });
  const emuAddr = await emu.listen(0);
  const emuBase = `http://127.0.0.1:${emuAddr.port}`;
  emu.config.publicUrl = emuBase;
  const moneyConfig = loadMoneyConfig({ YOOKASSA_API_URL: `${emuBase}/v3`, PUBLIC_HOST: 'bl.test', NODE_ENV: 'test' }, { encKey: config.encKey });
  const billingConfig = loadBillingConfig(
    configured ? { PLATFORM_YOOKASSA_SHOP_ID: PLATFORM_SHOP.shopId, PLATFORM_YOOKASSA_SECRET: PLATFORM_SHOP.secret, PLATFORM_TAX_SYSTEM_CODE: '2' } : {},
    { ...moneyConfig, publicHost: 'bl.test' },
  );
  // Боевой магазин клуба A (деньги гостей) — для проверки, что потоки не пересекаются (T32).
  await admin.query(
    `insert into bl.club_payment_settings (club_id, shop_id, secret_key_enc, sbp_enabled, card_enabled)
     values ($1, $2, $3, true, true)
     on conflict (club_id) do update set shop_id = excluded.shop_id, secret_key_enc = excluded.secret_key_enc, sbp_enabled = true, card_enabled = true`,
    [CLUB_A, CLUB_SHOP.shopId, encryptShopSecret(CLUB_SHOP.secret, config.encKey, CLUB_A, 'live')],
  );

  const clock = { offsetMs: 0, now() { return new Date(Date.now() + this.offsetMs); } };
  const pool = appPool(db.url, { max: 20 });
  const log = memoryLog();
  const outbox = createOutbox({ pollMs: 100, clock });
  const sse = { publish() {}, closeAll() {}, setLogger() {} };
  const setupModule = {
    async init(ctx) {
      ctx.money = { config: moneyConfig };
      ctx.billing = { config: billingConfig, tickMs: 3_600_000 };
    },
    async stop() {},
  };
  const routes = await loadRoutes({ config, only: ['auth.mjs', 'billing.mjs', 'clubs.mjs', 'webhooks.mjs', 'quotes.mjs'] });
  const app = await createApp({
    config,
    log,
    pool,
    clock,
    modules: [{ name: 'setup', module: setupModule }, { name: 'billing', module: billingModule }],
    outbox,
    sse,
    routes,
  });
  await app.ctx.notify.stop();
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  emu.config.webhookUrl = `${base}/api/webhooks/yookassa/{club_id}`;
  emu.addShop({ ...PLATFORM_SHOP, webhookUrl: `${base}/api/webhooks/yookassa-platform` });

  async function request(method, path, { body, token, headers = {} } = {}) {
    const h = { ...headers };
    if (method !== 'GET') {
      h['content-type'] = 'application/json';
      h.origin = ORIGIN;
    }
    if (token) h.authorization = `Bearer ${token}`;
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

  async function emuApi(method, path, body) {
    const res = await fetch(`${emuBase}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json();
  }

  const tokens = new Map();
  async function login(phone) {
    if (tokens.has(phone)) return tokens.get(phone);
    const res = await request('POST', '/api/auth/dev', { body: { phone } });
    if (res.status !== 200) throw new Error(`login ${phone}: ${res.status} ${res.text}`);
    const c = await request('POST', '/api/auth/consent', { body: { version: config.consentVersion }, token: res.json.token });
    if (c.status !== 200) throw new Error(`consent ${phone}: ${c.status}`);
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

  /** Транзакция от app_api с контекстом (коммит): узкие функции так, как их зовёт сервер. */
  async function asApp({ clubId = null, userId = null, actorType = 'system', platformRole = null }, fn) {
    const c = new pg.Client({ connectionString: db.url });
    await c.connect();
    try {
      await c.query('begin');
      await c.query('set local role app_api');
      await c.query(
        "select set_config('app.club_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_type', $3, true), set_config('app.platform_role', $4, true)",
        [clubId ?? '', userId ?? '', actorType, platformRole ?? ''],
      );
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (err) {
      await c.query('rollback').catch(() => {});
      throw err;
    } finally {
      await c.end();
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
    emuApi,
    config,
    moneyConfig,
    billingConfig,
    clock,
    outbox,
    request,
    login,
    waitFor,
    asApp,
    newKey: () => randomUUID(),
    async q(sql, params) {
      return (await admin.query(sql, params)).rows;
    },
    /** Подставные часы: момент «сейчас» для сервера и планировщика. */
    setNow(date) {
      clock.offsetMs = new Date(date).getTime() - Date.now();
    },
    /** Один проход планировщика подписки. */
    async tick() {
      const out = await billingModule.tick(app.ctx);
      await emu.settle();
      return out;
    },
    async stop() {
      await emu.settle();
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
