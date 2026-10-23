// Обвязка тестов Бильярдум+ на настоящем Postgres.
//
// * Временная база со всеми миграциями и сидом (supabase/tests/helpers.mjs), второй клуб для RLS.
// * Приложение — настоящий createApp (core): роутер, outbox, уведомления, журнал; маршруты —
//   auth.mjs и plus.mjs; модуль plus. Пул — под ролью app_api (те же права и RLS, что у сервера).
// * light — настоящие sessionOf / sessionParticipants (server/sessions/api.mjs, автономный
//   экземпляр); сессии тест пишет в базу сам (как после оплаты).
// * bookings.createBooking — шпион: вызовы в bookingCalls, ответ задаёт тест (bookingImpl).
// * Часы — поддельные: тест двигает clock и зовёт tick().

import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { createApp } from '../../../http/app.mjs';
import { createOutbox } from '../../../outbox.mjs';
import { loadRoutes } from '../../../../api/router.mjs';
import { appPool, memoryLog, ORIGIN, testConfig } from '../../../test/db/helpers.mjs';
import { createTestDatabase, seedClubB } from '../../../../supabase/tests/helpers.mjs';
import * as plusModule from '../../index.mjs';

export const CLUB_A = 'c1000000-0000-4000-8000-000000000001';
export const CLUB_B = 'c2000000-0000-4000-8000-000000000002';
export const MANAGER_A = 'a1000000-0000-4000-8000-000000000003';
export const OWNER_B = 'a2000000-0000-4000-8000-000000000002';
export const table = (n) => `e1000000-0000-4000-8000-00000000000${n}`;
export const TABLE_B = 'e2000000-0000-4000-8000-000000000001';
export const PHONES = { owner: '+70000000001', manager: '+70000000003', reception: '+70000000004', ownerB: '+70000000002' };
export const MIN = 60_000;
/** Понедельник 26.10.2026 12:00 по Екатеринбургу (UTC+5). */
export const T0 = Date.parse('2026-10-26T07:00:00Z');

export async function setup() {
  const db = await createTestDatabase();
  await seedClubB(db.pool);
  const admin = db.pool;

  let nowMs = T0;
  const clock = { now: () => new Date(nowMs), set: (ms) => { nowMs = ms; }, add: (ms) => { nowMs += ms; } };
  const config = testConfig();
  const pool = appPool(db.url, { max: 20 });
  const log = memoryLog();
  const outbox = createOutbox({ pollMs: 50, clock });
  const sseEvents = [];
  const sse = {
    publish: (channel, event, data) => sseEvents.push({ channel, event, data }),
    closeAll() {},
    setLogger() {},
  };
  const bookingCalls = [];
  const hooks = {
    bookingImpl: async (_db, args) => ({ id: randomUUID(), status: 'confirmed', resource_id: args.resourceId }),
  };
  const setupModule = {
    async init(ctx) {
      ctx.plusDeps = {
        bookings: {
          createBooking: async (d, args) => {
            bookingCalls.push(args);
            return hooks.bookingImpl(d, args);
          },
        },
      };
      ctx.plusOptions = { tickMs: 0 };
    },
    async stop() {},
  };
  const routes = await loadRoutes({ config, only: ['auth.mjs', 'plus.mjs'] });
  const app = await createApp({
    config,
    log,
    pool,
    clock,
    modules: [
      { name: 'setup', module: setupModule },
      { name: 'plus', module: plusModule },
    ],
    outbox,
    sse,
    routes,
  });
  await app.ctx.notify.stop();
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, path, { body, token, headers = {}, club } = {}) {
    const h = { 'x-forwarded-for': `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`, ...headers };
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

  let phoneN = 0;
  /** Новый игрок с профилем (ник) — { token, id, nick }. */
  async function player(nick, { profile = true } = {}) {
    phoneN += 1;
    const u = await login(`+7999100${String(phoneN).padStart(4, '0')}`);
    if (profile) {
      const r = await request('PATCH', '/api/plus/me', { token: u.token, body: { nick } });
      if (r.status !== 200) throw new Error(`profile ${nick}: ${r.status} ${r.text}`);
    }
    return { ...u, nick };
  }

  const q = async (sql, params) => (await admin.query(sql, params)).rows;

  /** Сессия стола с участниками (как после оплаты, light). status closed — с ended_at. */
  async function session({ resourceId = table(1), clubId = CLUB_A, players, status = 'active', startedMs = nowMs, endedMs = null }) {
    const id = randomUUID();
    const ended = status === 'closed' ? new Date(endedMs ?? nowMs) : null;
    // Одна идущая сессия на стол: прежнюю (из другого теста) закрываем.
    await admin.query(
      `update bl.sessions set status = 'closed', ended_at = greatest(started_at, $2), close_reason = 'expired', updated_at = greatest(started_at, $2)
        where resource_id = $1 and status in ('active', 'ending', 'grace')`,
      [resourceId, new Date(nowMs)],
    );
    await admin.query(
      `insert into bl.sessions (id, club_id, resource_id, status, payer_user_id, started_at, paid_until, ended_at, close_reason, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $6, $6)`,
      [id, clubId, resourceId, status, players[0], new Date(startedMs), new Date(startedMs + 60 * MIN), ended, ended ? 'expired' : null],
    );
    let n = 0;
    for (const uid of players) {
      n += 1;
      await admin.query(
        'insert into bl.session_participants (session_id, club_id, user_id, role, ordinal, joined_at) values ($1, $2, $3, $4, $5, $6)',
        [id, clubId, uid, n === 1 ? 'payer' : 'player', n, new Date(startedMs)],
      );
    }
    return id;
  }

  async function emit(topic, payload, clubId = CLUB_A) {
    await admin.query('insert into bl.outbox (club_id, topic, payload) values ($1, $2, $3::jsonb)', [clubId, topic, JSON.stringify(payload)]);
  }

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
    bookingCalls,
    hooks,
    request,
    login,
    player,
    session,
    emit,
    q,
    /** Партия: создать (a) и подтвердить (b). */
    async play(a, b, sessionId, { my = 8, opp = 5, discipline = 'pyramid', confirm = true } = {}) {
      const c = await request('POST', '/api/plus/matches', {
        token: a.token,
        body: { session_id: sessionId, discipline, opponent_id: b.id, my_score: my, opponent_score: opp },
      });
      if (c.status !== 201) throw new Error(`match: ${c.status} ${c.text}`);
      if (!confirm) return c.json;
      const r = await request('POST', `/api/plus/matches/${c.json.id}/confirm`, { token: b.token });
      if (r.status !== 200) throw new Error(`confirm: ${r.status} ${r.text}`);
      return r.json;
    },
    async rating(userId, discipline = 'pyramid', season = 'all') {
      return (await q('select rating, games, wins from bl.ratings where user_id = $1 and discipline = $2 and season = $3', [userId, discipline, season]))[0] ?? null;
    },
    async notifications(userId, kind) {
      return q('select * from bl.notifications where user_id = $1 and ($2::text is null or kind = $2) order by created_at', [userId, kind ?? null]);
    },
    async audit(action) {
      return q('select * from bl.audit_log where action = $1 order by club_id, seq', [action]);
    },
    tick: () => plusModule.tick(),
    /** Дождаться, пока outbox разберёт события тем topics. */
    async drain(topics = ['session.closed', 'tournament.match_finished'], timeoutMs = 8_000) {
      await waitFor(async () => {
        const rows = await q('select count(*)::int as n from bl.outbox where processed_at is null and topic = any ($1::text[])', [topics]);
        return rows[0].n === 0;
      }, { timeoutMs });
    },
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

export async function waitFor(fn, { timeoutMs = 8_000, stepMs = 30 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor: не дождались');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
