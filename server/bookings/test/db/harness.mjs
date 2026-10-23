// Обвязка тестов брони и листа ожидания на настоящем Postgres.
//
// * Временная база со всеми миграциями и сидом (supabase/tests/helpers.mjs), второй клуб для RLS.
// * Приложение — настоящий createApp (core): роутер, outbox, тревоги, уведомления, журнал;
//   маршруты: вход (auth.mjs), bookings.mjs, waitlist.mjs. Модули: bookings и waitlist.
// * light — настоящий сервис сессий (server/sessions/service.mjs: startFromBooking, setReserved,
//   clearReserved, holdPending) без MQTT: команды остаются в bl.device_commands, контроллеры
//   «на связи» (подделка моста).
// * money — настоящий модуль (server/payments: createPrepayment, createBookingQuote, settlePrepayment,
//   forfeitPrepayment, refund, маршруты котировок и вебхука) с эмулятором ЮKassa tools/yookassa-emu;
//   вызовы брони записываются в moneyCalls. Оплата — h.succeed(paymentId): вебхук → payment.confirmed.
// * Часы — поддельные (ускоренное время): тест двигает clock.set(...) и зовёт tick().

import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { createApp } from '../../../http/app.mjs';
import { isChannel } from '../../../http/sse.mjs';
import { createOutbox } from '../../../outbox.mjs';
import { loadRoutes } from '../../../../api/router.mjs';
import { appPool, memoryLog, ORIGIN, testConfig } from '../../../test/db/helpers.mjs';
import { createTestDatabase, seedClubB } from '../../../../supabase/tests/helpers.mjs';
import { createLightService } from '../../../sessions/service.mjs';
import { amountFor, amountForActual, pricesAround } from '../../../tariffs/index.mjs';
import { createEmulator } from '../../../../tools/yookassa-emu/lib/emulator.mjs';
import * as moneyApi from '../../../payments/api.mjs';
import { loadMoneyConfig } from '../../../payments/config.mjs';
import * as moneyModule from '../../../payments/index.mjs';
import { provisionPayments } from '../../../payments/provision-dev.mjs';
import * as bookingsModule from '../../index.mjs';
import * as waitlistModule from '../../../waitlist/index.mjs';

export const CLUB_A = 'c1000000-0000-4000-8000-000000000001';
export const CLUB_B = 'c2000000-0000-4000-8000-000000000002';
export const table = (n) => `e1000000-0000-4000-8000-00000000000${n}`;
export const TABLE_B = 'e2000000-0000-4000-8000-000000000001';
export const PHONES = { owner: '+70000000001', manager: '+70000000003', reception: '+70000000004', ownerB: '+70000000002' };
export const MIN = 60_000;
/** Понедельник 26.10.2026 12:00 по Екатеринбургу (UTC+5). */
export const T0 = Date.parse('2026-10-26T07:00:00Z');

export async function setup({ settings = {} } = {}) {
  const db = await createTestDatabase();
  await seedClubB(db.pool);
  const admin = db.pool;
  // Ключи устройств (light считает стол без ключа офлайн) и правила брони клуба.
  await admin.query("update bl.devices set device_key_enc = 'v1:test'");
  await admin.query('update bl.clubs set settings = settings || $2::jsonb where id = $1', [CLUB_A, JSON.stringify(settings)]);

  let nowMs = T0;
  const clock = { now: () => new Date(nowMs), set: (ms) => { nowMs = ms; }, add: (ms) => { nowMs += ms; } };
  const config = testConfig();
  const pool = appPool(db.url, { max: 20 });
  const log = memoryLog();
  const outbox = createOutbox({ pollMs: 50, clock });
  const sseEvents = [];
  // Хаб SSE в тесте проверяет канал и имя события так же, как настоящий (server/http/sse.mjs).
  const sse = {
    publish: (channel, event, data) => {
      if (!isChannel(channel) || !/^[a-z][a-z0-9_]{0,40}$/.test(event)) throw new Error(`sse: ${channel} ${event}`);
      sseEvents.push({ channel, event, data: JSON.parse(JSON.stringify(data)) });
    },
    closeAll() {},
    setLogger() {},
  };

  // money — настоящий модуль (server/payments) с эмулятором ЮKassa; вызовы брони — через шпиона
  // с журналом (moneyCalls), чтобы тесты видели аргументы.
  const SHOP = { shopId: '760001', secret: `test_bk_${randomBytes(8).toString('hex')}` };
  await provisionPayments({
    client: admin,
    env: { YOOKASSA_EMU_SHOP_ID: SHOP.shopId, YOOKASSA_EMU_SECRET: SHOP.secret, SECRETS_ENC_KEY: config.encKey.toString('base64') },
  });
  await admin.query('update bl.club_payment_settings set sbp_enabled = true, card_enabled = true where club_id = $1', [CLUB_A]);
  const emu = createEmulator({ shops: [SHOP], webhookRetries: 3, webhookRetryDelayMs: 50 });
  const emuAddr = await emu.listen(0);
  const emuBase = `http://127.0.0.1:${emuAddr.port}`;
  emu.config.publicUrl = emuBase;
  const moneyConfig = loadMoneyConfig({ YOOKASSA_API_URL: `${emuBase}/v3`, PUBLIC_HOST: 'bl.test', NODE_ENV: 'test' }, { encKey: config.encKey });
  const moneyCalls = [];
  const spy = (fn) => async (d, args) => {
    moneyCalls.push({ fn, args });
    return moneyApi[fn](d, args);
  };
  const money = Object.fromEntries(['createPrepayment', 'createBookingQuote', 'settlePrepayment', 'forfeitPrepayment', 'refund'].map((fn) => [fn, spy(fn)]));

  let lightService = null;
  const lightCalls = [];
  const lightHooks = { availabilityDuring: null, tournamentHolds: null };
  const setupModule = {
    async init(ctx) {
      lightService = createLightService({
        log,
        clock,
        getBridge: () => ({ deviceInfo: () => ({ online: true }) }),
        deps: {
          audit: ctx.audit,
          outbox: ctx.outbox,
          alarms: ctx.alarms,
          notify: ctx.notify,
          sse,
          tariffs: { amountFor, amountForActual, pricesAround },
          payments: { refund: money.refund },
          bookings: { nextBookingStart: (...a) => import('../../api.mjs').then((m) => m.nextBookingStart(...a)) },
        },
      });
      const light = {
        startFromBooking: (d, a) => {
          lightCalls.push({ fn: 'startFromBooking', args: a });
          return lightService.startFromBooking(d, a);
        },
        setReserved: (d, a) => {
          lightCalls.push({ fn: 'setReserved', args: a });
          return lightService.setReserved(d, a);
        },
        clearReserved: (d, a) => {
          lightCalls.push({ fn: 'clearReserved', args: a });
          return lightService.clearReserved(d, a);
        },
        getResourceStatus: (d, id, o) => lightService.resourceStatus(d, id, o),
        // История доступности стола (light, №128): настоящая, когда есть; тест может подменить.
        availabilityDuring: (d, a) => {
          lightCalls.push({ fn: 'availabilityDuring', args: a });
          if (lightHooks.availabilityDuring) return lightHooks.availabilityDuring(d, a);
          if (typeof lightService.availabilityDuring === 'function') return lightService.availabilityDuring(d, a);
          return { unavailable: false, reasons: [], intervals: [] };
        },
        holdPending: (d, a) => lightService.holdPending(d, a),
        releasePending: (d, a) => lightService.releasePending(d, a),
      };
      // money ходит в light через свой интерфейс §13 — тот же сервис на тех же часах.
      ctx.sessionsApi = {
        getResourceByCode: (d, code) => lightService.getResourceByCode(d, code),
        getResourceStatus: (d, id, o) => lightService.resourceStatus(d, id, o),
        holdPending: light.holdPending,
        releasePending: light.releasePending,
        getSessionForExtend: (d, a) => lightService.getSessionForExtend(d, a),
      };
      ctx.money = { config: moneyConfig };
      // Турниры (M4 №138) — тест подменяет интервалы блокировки столов.
      const tournaments = { tournamentHolds: async (d, a) => (lightHooks.tournamentHolds ? lightHooks.tournamentHolds(d, a) : []) };
      ctx.bookingDeps = { light, payments: money, tournaments };
      ctx.bookingsOptions = { tickMs: 0 };
      ctx.waitlistOptions = { tickMs: 0 };
    },
    async stop() {},
  };
  const routes = await loadRoutes({ config, only: ['auth.mjs', 'bookings.mjs', 'waitlist.mjs', 'quotes.mjs', 'payments.mjs', 'webhooks.mjs'] });
  const app = await createApp({
    config,
    log,
    pool,
    clock,
    modules: [
      { name: 'setup', module: setupModule },
      { name: 'money', module: moneyModule },
      { name: 'bookings', module: bookingsModule },
      { name: 'waitlist', module: waitlistModule },
    ],
    outbox,
    sse,
    routes,
  });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  emu.config.webhookUrl = `${base}/api/webhooks/yookassa/{club_id}`;

  async function request(method, path, { body, token, headers = {}, key, club } = {}) {
    // Свой адрес на каждый запрос (loopback — доверенный прокси): лимиты частоты маршрутов не мешают сценариям.
    const h = { 'x-forwarded-for': `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`, ...headers };
    if (method !== 'GET') {
      h['content-type'] = 'application/json';
      h.origin = ORIGIN;
    }
    if (token) h.authorization = `Bearer ${token}`;
    if (key) h['idempotency-key'] = key;
    if (club) h['x-club-id'] = club;
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
  async function login(phone) {
    if (tokens.has(phone)) return tokens.get(phone);
    const res = await request('POST', '/api/auth/dev', { body: { phone } });
    if (res.status !== 200) throw new Error(`login ${phone}: ${res.status}`);
    const c = await request('POST', '/api/auth/consent', { body: { version: config.consentVersion }, token: res.json.token });
    if (c.status !== 200) throw new Error(`consent ${phone}: ${c.status}`);
    const out = { token: res.json.token, id: res.json.user.id };
    tokens.set(phone, out);
    return out;
  }

  const q = async (sql, params) => (await admin.query(sql, params)).rows;

  return {
    db,
    admin,
    pool,
    app,
    base,
    log,
    clock,
    config,
    sseEvents,
    moneyCalls,
    lightCalls,
    lightHooks,
    request,
    login,
    q,
    light: () => lightService,
    /** Момент T0 + minutes в ISO. */
    at: (minutes) => new Date(T0 + minutes * MIN).toISOString(),
    async setSettings(s) {
      await admin.query('update bl.clubs set settings = settings || $2::jsonb where id = $1', [CLUB_A, JSON.stringify(s)]);
    },
    async code(resourceId) {
      return (await q('select code from bl.resources where id = $1', [resourceId]))[0].code;
    },
    async booking(id) {
      return (await q('select * from bl.bookings where id = $1', [id]))[0];
    },
    /** Событие outbox от имени соседа (money, light): как его пишет enqueue. */
    async emit(topic, payload, clubId = CLUB_A) {
      await admin.query('insert into bl.outbox (club_id, topic, payload) values ($1, $2, $3::jsonb)', [clubId, topic, JSON.stringify(payload)]);
    },
    emu,
    /** Гость оплатил платёж в ЮKassa (эмулятор): вебхук → money → outbox payment.confirmed. */
    async succeed(paymentId) {
      const [p] = await q('select provider_payment_id from bl.payments where id = $1', [paymentId]);
      const r = await fetch(`${emuBase}/__emu/payments/${p.provider_payment_id}/succeed?wait=1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (r.status !== 200) throw new Error(`emu succeed ${r.status}`);
      await emu.settle();
    },
    async payment(id) {
      return (await q('select * from bl.payments where id = $1', [id]))[0];
    },
    async refunds(paymentId) {
      return q("select * from bl.refunds where payment_id = $1 and status <> 'canceled'", [paymentId]);
    },
    /** Повтор события payment.confirmed (доставка «хотя бы один раз»). */
    async confirmPayment({ paymentId, bookingId, kind = 'booking', amount, quoteId = null, userId = null, resourceId = null }) {
      await this.emit('payment.confirmed', {
        payment_id: paymentId, club_id: CLUB_A, quote_id: quoteId, kind, booking_id: bookingId, session_id: null,
        resource_id: resourceId, user_id: userId, minutes: null, unlimited: false, amount_kopecks: amount, method: 'sbp',
      });
    },
    /** Идущая сессия стола (как после оплаты, light). */
    async session({ resourceId, payer, paidUntilMs, startedMs = nowMs }) {
      const id = randomUUID();
      await admin.query(
        `insert into bl.sessions (id, club_id, resource_id, status, payer_user_id, started_at, paid_until, created_at, updated_at)
         values ($1, $2, $3, 'active', $4, $5, $6, $5, $5)`,
        [id, CLUB_A, resourceId, payer, new Date(startedMs), new Date(paidUntilMs)],
      );
      await admin.query(
        `insert into bl.session_participants (session_id, club_id, user_id, role, ordinal, joined_at) values ($1, $2, $3, 'payer', 1, $4)`,
        [id, CLUB_A, payer, new Date(startedMs)],
      );
      return id;
    },
    /** Сессия закрыта (light): статус и outbox session.closed. */
    async closeSession(id) {
      const [s] = await q(
        `update bl.sessions set status = 'closed', ended_at = $2, close_reason = 'expired', updated_at = $2 where id = $1
         returning id, club_id, resource_id, paid_until`,
        [id, new Date(nowMs)],
      );
      await this.emit('session.closed', { session_id: s.id, club_id: s.club_id, resource_id: s.resource_id, paid_until: s.paid_until });
    },
    async outboxEvents(topic) {
      return q('select * from bl.outbox where topic = $1 order by id', [topic]);
    },
    async notifications(userId, kind) {
      return q('select * from bl.notifications where user_id = $1 and ($2::text is null or kind = $2) order by created_at', [userId, kind ?? null]);
    },
    async audit(action) {
      return q('select * from bl.audit_log where action = $1 order by club_id, seq', [action]);
    },
    async holds(resourceId) {
      return q('select * from bl.resource_holds where resource_id = $1 order by created_at', [resourceId]);
    },
    tick: () => bookingsModule.tick(),
    tickWaitlist: () => waitlistModule.tick(),
    /** Дождаться, пока outbox разберёт все события. */
    async drain(timeoutMs = 8_000) {
      await waitFor(async () => {
        const rows = await q(
          `select count(*)::int as n from bl.outbox o where o.processed_at is null and o.topic in
             ('payment.confirmed', 'session.closed', 'session.started', 'booking.expired', 'booking.canceled')`,
        );
        return rows[0].n === 0;
      }, { timeoutMs });
    },
    async close() {
      const closed = new Promise((r) => server.close(r));
      server.closeAllConnections();
      await closed;
      await emu.settle();
      await app.stop();
      await pool.end();
      await emu.close();
      await db.drop();
    },
  };
}

export async function waitFor(fn, { timeoutMs = 8_000, stepMs = 30 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor: не дождались');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
