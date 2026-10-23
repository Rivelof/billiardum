// Обвязка тестов каталога (backend-directory, M4) на настоящем Postgres.
//
// * Временная база со всеми миграциями и сидом (города, карточка тестового клуба в программе,
//   демо-карточка без программы), второй клуб для RLS.
// * Приложение — настоящий createApp (core): роутер с /api/public/* (кэш 60 с, лимиты), роли
//   платформы, outbox, уведомления, журнал. Маршруты: вход, directory.mjs, leads.mjs. Модуль directory.
// * light — настоящий сервис сессий без MQTT (статус стола), контроллеры «на связи».
// * Часы — поддельные: планировщик передачи заявок оператору гоняется вручную (tick).

import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { createApp } from '../../../http/app.mjs';
import { createOutbox } from '../../../outbox.mjs';
import { loadRoutes } from '../../../../api/router.mjs';
import { appPool, memoryLog, ORIGIN, testConfig } from '../../../test/db/helpers.mjs';
import { createTestDatabase, seedClubB } from '../../../../supabase/tests/helpers.mjs';
import { createLightService } from '../../../sessions/service.mjs';
import { amountFor, amountForActual, pricesAround } from '../../../tariffs/index.mjs';
import * as directoryModule from '../../index.mjs';

export const CLUB_A = 'c1000000-0000-4000-8000-000000000001';
export const CLUB_B = 'c2000000-0000-4000-8000-000000000002';
export const CARD_A = 'cb100000-0000-4000-8000-000000000001';
export const CARD_DEMO = 'cb100000-0000-4000-8000-000000000002';
export const table = (n) => `e1000000-0000-4000-8000-00000000000${n}`;
export const PHONES = { owner: '+70000000001', manager: '+70000000003', reception: '+70000000004', ownerB: '+70000000002' };
export const MIN = 60_000;
export const T0 = Date.parse('2026-10-26T07:00:00Z');

export async function setup() {
  const db = await createTestDatabase();
  await seedClubB(db.pool);
  const admin = db.pool;
  await admin.query("update bl.devices set device_key_enc = 'v1:test'");
  let nowMs = T0;
  const clock = { now: () => new Date(nowMs), set: (ms) => { nowMs = ms; }, add: (ms) => { nowMs += ms; } };
  const config = testConfig();
  const pool = appPool(db.url, { max: 20 });
  const log = memoryLog();
  const outbox = createOutbox({ pollMs: 50, clock });
  const sse = { publish() {}, closeAll() {}, setLogger() {} };

  const setupModule = {
    async init(ctx) {
      const light = createLightService({
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
          payments: { refund: async () => ({}) },
          bookings: { nextBookingStart: async () => null },
        },
      });
      ctx.directoryDeps = { sessions: { getResourceStatus: (d, id, o) => light.resourceStatus(d, id, o) } };
      ctx.directoryOptions = { tickMs: 0 };
    },
    async stop() {},
  };
  const routes = await loadRoutes({ config, only: ['auth.mjs', 'directory.mjs', 'leads.mjs'] });
  const app = await createApp({
    config,
    log,
    pool,
    clock,
    modules: [{ name: 'setup', module: setupModule }, { name: 'directory', module: directoryModule }],
    outbox,
    sse,
    routes,
  });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, path, { body, token, headers = {}, club, ip } = {}) {
    const h = { 'x-forwarded-for': ip ?? `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`, ...headers };
    if (method !== 'GET') {
      h['content-type'] = 'application/json';
      h.origin = ORIGIN;
    }
    if (token) h.authorization = `Bearer ${token}`;
    if (club) h['x-club-id'] = club;
    const res = await fetch(`${base}${path}`, { method, headers: h, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  const tokens = new Map();
  async function login(phone) {
    if (tokens.has(phone)) return tokens.get(phone);
    const res = await request('POST', '/api/auth/dev', { body: { phone } });
    if (res.status !== 200) throw new Error(`login ${phone}: ${res.status}`);
    const c = await request('POST', '/api/auth/consent', { body: { version: config.consentVersion }, token: res.json.token });
    if (c.status !== 200) throw new Error(`consent ${phone}: ${c.status}`);
    const out = { token: res.json.token, id: res.json.user.id, phone };
    tokens.set(phone, out);
    return out;
  }

  const q = async (sql, params) => (await admin.query(sql, params)).rows;

  return {
    db,
    admin,
    pool,
    app,
    log,
    clock,
    config,
    request,
    login,
    q,
    async platformMember(userId, role) {
      await admin.query(
        'insert into bl.platform_members (user_id, role) values ($1, $2) on conflict (user_id) do update set role = excluded.role, active = true',
        [userId, role],
      );
    },
    async session({ resourceId, payer, startedMs = nowMs, paidUntilMs = nowMs + 60 * MIN, status = 'active', clubId = CLUB_A }) {
      const id = randomUUID();
      await admin.query(
        `insert into bl.sessions (id, club_id, resource_id, status, payer_user_id, started_at, paid_until, ended_at, close_reason, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $6, $6)`,
        [id, clubId, resourceId, status, payer, new Date(startedMs), new Date(paidUntilMs), status === 'closed' ? new Date(paidUntilMs) : null, status === 'closed' ? 'expired' : null],
      );
      await admin.query(
        `insert into bl.session_participants (session_id, club_id, user_id, role, ordinal, joined_at) values ($1, $2, $3, 'payer', 1, $4)`,
        [id, clubId, payer, new Date(startedMs)],
      );
      return id;
    },
    async notifications(userId, kind) {
      return q('select * from bl.notifications where user_id = $1 and ($2::text is null or kind = $2) order by created_at', [userId, kind ?? null]);
    },
    async audit(action) {
      return q('select * from bl.audit_log where action = $1 order by seq', [action]);
    },
    tick: () => directoryModule.tick(),
    async close() {
      const closed = new Promise((r) => server.close(r));
      server.closeAllConnections();
      await closed;
      await app.stop();
      await pool.end();
      await db.drop();
    },
  };
}
