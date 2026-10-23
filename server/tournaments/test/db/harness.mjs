// Обвязка тестов турниров на настоящем Postgres.
//
// * Временная база со всеми миграциями и сидом (как supabase/tests/helpers.mjs), второй клуб для RLS.
//   TOURNAMENT_TEST_MIGRATIONS_DIR / TOURNAMENT_TEST_SEED_DIR — другой каталог миграций и сида
//   (разработка, пока соседние миграции M4 не готовы); по умолчанию — supabase/migrations и seed.d.
// * Приложение — настоящий createApp (core): роутер, outbox, тревоги, уведомления, журнал, SSE;
//   маршруты: auth.mjs и tournaments.mjs. Модуль tournaments — настоящий.
// * Соседи — подделки с журналом вызовов: light (удержание, свет турнира), money (взнос, возврат),
//   plus (рейтинг и ник). Оплата — событие outbox payment.confirmed {kind: 'tournament'} (как его
//   пишет money после вебхука).
// * Часы — поддельные: T0 = понедельник 26.10.2026 12:00 по Екатеринбургу.

import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import { createApp } from '../../../http/app.mjs';
import { createSseHub } from '../../../http/sse.mjs';
import { createOutbox } from '../../../outbox.mjs';
import { loadRoutes } from '../../../../api/router.mjs';
import { appPool, memoryLog, ORIGIN, testConfig } from '../../../test/db/helpers.mjs';
import { seedClubB } from '../../../../supabase/tests/helpers.mjs';
import { migrate, MIGRATIONS_DIR, seed, SEED_DIR, SEED_FILE } from '../../../../supabase/lib/db.mjs';
import * as tournamentsModule from '../../index.mjs';

export const CLUB_A = 'c1000000-0000-4000-8000-000000000001';
export const CLUB_B = 'c2000000-0000-4000-8000-000000000002';
export const table = (n) => `e1000000-0000-4000-8000-00000000000${n}`;
export const TABLE_B = 'e2000000-0000-4000-8000-000000000001';
export const STAFF = { owner: '+70000000001', manager: '+70000000003', reception: '+70000000004', ownerB: '+70000000002' };
export const MIN = 60_000;
export const T0 = Date.parse('2026-10-26T07:00:00Z');
export const player = (n) => `+7999100${String(n).padStart(4, '0')}`;

function adminUrl() {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error('нужен DATABASE_ADMIN_URL');
  return url;
}

export async function createDb() {
  const name = `bl_test_${process.pid}_${randomBytes(3).toString('hex')}`;
  const root = new pg.Client({ connectionString: adminUrl() });
  await root.connect();
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await root.query(`create database ${name} template template1`);
        break;
      } catch (err) {
        if (err.code !== '55006' || attempt >= 20) throw err;
        await new Promise((r) => setTimeout(r, 100 + Math.floor(Math.random() * 200)));
      }
    }
  } finally {
    await root.end();
  }
  const u = new URL(adminUrl());
  u.pathname = `/${name}`;
  const url = u.toString();
  await migrate({ connectionString: url, quiet: true, dir: process.env.TOURNAMENT_TEST_MIGRATIONS_DIR || MIGRATIONS_DIR });
  await seed({ connectionString: url, quiet: true, file: SEED_FILE, dir: process.env.TOURNAMENT_TEST_SEED_DIR || SEED_DIR });
  const pool = new pg.Pool({ connectionString: url, max: 30 });
  pool.on('error', () => {});
  return {
    url,
    pool,
    async drop() {
      await pool.end();
      const c = new pg.Client({ connectionString: adminUrl() });
      await c.connect();
      try {
        await c.query(`drop database if exists ${name} with (force)`);
      } finally {
        await c.end();
      }
    },
  };
}

export async function setup() {
  const db = await createDb();
  await seedClubB(db.pool);
  const admin = db.pool;

  let nowMs = T0;
  const clock = { now: () => new Date(nowMs), set: (ms) => { nowMs = ms; }, add: (ms) => { nowMs += ms; } };
  const config = testConfig();
  const pool = appPool(db.url, { max: 20 });
  const log = memoryLog();
  const outbox = createOutbox({ pollMs: 50, clock });
  // Хаб SSE core (настоящий): события клуба и игрока записываются для проверок.
  const hub = createSseHub();
  const sseEvents = [];
  const sse = {
    ...hub,
    publish(channel, event, data) {
      sseEvents.push({ channel, event, data: JSON.parse(JSON.stringify(data)) });
      return hub.publish(channel, event, data);
    },
  };

  // --- Подделки соседей -------------------------------------------------------------------------
  const calls = { light: [], money: [], plus: [] };
  const ratings = new Map();
  const nicks = new Map();
  const lightHooks = { setReserved: null, startFromTournament: null };
  let payN = 0;
  const light = {
    async setReserved(_db, args) {
      calls.light.push({ fn: 'setReserved', args });
      if (lightHooks.setReserved) return lightHooks.setReserved(args);
      return { ok: true, applied: true, until: args.until };
    },
    async clearReserved(_db, args) {
      calls.light.push({ fn: 'clearReserved', args });
      return { ok: true, released: true };
    },
    async startFromTournament(_db, args) {
      calls.light.push({ fn: 'startFromTournament', args });
      if (lightHooks.startFromTournament) return lightHooks.startFromTournament(args);
      return { session_id: randomUUID(), paid_until: new Date(nowMs + 60 * MIN).toISOString() };
    },
    async extendFromTournament(_db, args) {
      calls.light.push({ fn: 'extendFromTournament', args });
      return { ok: true, paid_until: args.until };
    },
    async stopFromTournament(_db, args) {
      calls.light.push({ fn: 'stopFromTournament', args });
      return { ok: true, stopped: true };
    },
  };
  const payments = {
    async createTournamentFee(_db, args) {
      calls.money.push({ fn: 'createTournamentFee', args });
      payN += 1;
      const id = randomUUID();
      return { payment: { id, status: 'pending', amount_kopecks: args.amountKopecks }, confirmation: { type: 'redirect', url: `https://yookassa.test/pay/${payN}` } };
    },
    async refund(_db, args) {
      calls.money.push({ fn: 'refund', args });
      return { refund_id: randomUUID(), status: 'succeeded', amount_kopecks: args.amountKopecks };
    },
    async refundTournamentFee(_db, args) {
      calls.money.push({ fn: 'refundTournamentFee', args });
      return { refund_id: randomUUID(), status: 'succeeded' };
    },
  };
  const plus = {
    async ratingOf(_db, { userId, discipline }) {
      calls.plus.push({ fn: 'ratingOf', userId, discipline });
      return { rating: ratings.get(userId) ?? 1200, games: 10, level: 'amateur' };
    },
    async playerCard(_db, { userId }) {
      return { nick: nicks.get(userId) ?? null, level: 'amateur' };
    },
  };

  const setupModule = {
    async init(ctx) {
      ctx.tournamentDeps = { light, payments, plus };
      ctx.tournamentsOptions = { tickMs: 0, publishDelayMs: 10 };
    },
    async stop() {},
  };
  const routes = await loadRoutes({ config, only: ['auth.mjs', 'tournaments.mjs'] });
  const app = await createApp({
    config,
    log,
    pool,
    clock,
    modules: [
      { name: 'setup', module: setupModule },
      { name: 'tournaments', module: tournamentsModule },
    ],
    outbox,
    sse,
    routes,
  });
  await app.ctx.notify.stop?.();
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, path, { body, token, headers = {}, key } = {}) {
    const h = { 'x-forwarded-for': `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`, ...headers };
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
    return { status: res.status, json, text, headers: res.headers };
  }

  const tokens = new Map();
  async function login(phone, { rating, nick } = {}) {
    let out = tokens.get(phone);
    if (!out) {
      const res = await request('POST', '/api/auth/dev', { body: { phone } });
      if (res.status !== 200) throw new Error(`login ${phone}: ${res.status} ${res.text}`);
      const c = await request('POST', '/api/auth/consent', { body: { version: config.consentVersion }, token: res.json.token });
      if (c.status !== 200) throw new Error(`consent ${phone}: ${c.status}`);
      out = { token: res.json.token, id: res.json.user.id, phone };
      tokens.set(phone, out);
    }
    if (rating !== undefined) ratings.set(out.id, rating);
    // Запись на турнир — только с ником (№150): по умолчанию у игрока есть профиль; nick: null — нет.
    if (nick !== undefined) nicks.set(out.id, nick);
    else if (!nicks.has(out.id)) nicks.set(out.id, `Игрок${phone.slice(-4)}`);
    return out;
  }

  const q = async (sql, params) => (await admin.query(sql, params)).rows;

  const h = {
    db,
    admin,
    pool,
    app,
    base,
    log,
    clock,
    config,
    calls,
    ratings,
    nicks,
    lightHooks,
    sseEvents,
    request,
    login,
    q,
    at: (minutes) => new Date(T0 + minutes * MIN).toISOString(),
    service: () => tournamentsModule.tournaments().service,
    tick: () => tournamentsModule.tick(),
    flush: () => tournamentsModule.tournaments().service.flush(),
    /** Событие outbox от имени money: взнос оплачен. */
    async pay(entryId, { amount, paymentId } = {}) {
      const [e] = await q('select * from bl.tournament_entries where id = $1', [entryId]);
      const pid = paymentId ?? e.payment_id ?? randomUUID();
      await admin.query('insert into bl.outbox (club_id, topic, payload) values ($1, $2, $3::jsonb)', [
        e.club_id,
        'payment.confirmed',
        JSON.stringify({ payment_id: pid, club_id: e.club_id, kind: 'tournament', entry_id: entryId, amount_kopecks: amount ?? Number(e.fee_kopecks), method: 'sbp' }),
      ]);
      await h.drain();
      return pid;
    },
    async drain(timeoutMs = 8_000) {
      await waitFor(async () => {
        const rows = await q(
          "select count(*)::int as n from bl.outbox where processed_at is null and topic in ('payment.confirmed', 'tournament.refund')",
        );
        return rows[0].n === 0;
      }, { timeoutMs });
    },
    async outboxEvents(topic) {
      return q('select * from bl.outbox where topic = $1 order by id', [topic]);
    },
    async audit(action) {
      return q('select * from bl.audit_log where action = $1 order by club_id, seq', [action]);
    },
    async notifications(userId, kind) {
      return q('select * from bl.notifications where user_id = $1 and ($2::text is null or kind = $2) order by created_at', [userId, kind ?? null]);
    },
    async entry(id) {
      return (await q('select * from bl.tournament_entries where id = $1', [id]))[0];
    },
    async tournament(id) {
      return (await q('select * from bl.tournaments where id = $1', [id]))[0];
    },
    async matches(tid) {
      return q("select * from bl.tournament_matches where tournament_id = $1 order by (stage = 'playoff'), round, coalesce(group_no, -1), position", [tid]);
    },
    /** Турнир клуба A через API управляющего. */
    async createTournament(body = {}, { publish = true } = {}) {
      const manager = await login(STAFF.manager);
      const res = await request('POST', `/api/clubs/${CLUB_A}/tournaments`, {
        token: manager.token,
        body: {
          title: 'Кубок клуба',
          discipline: 'pyramid',
          format: 'single_elim',
          race_to: 2,
          fee_kopecks: 100_000,
          prize_text: 'Кубок и 10 000 ₽',
          places: 16,
          starts_at: h.at(24 * 60),
          ends_at: h.at(24 * 60 + 8 * 60),
          resource_ids: [table(1), table(2), table(3), table(4)],
          publish,
          ...body,
        },
      });
      if (res.status !== 201) throw new Error(`create: ${res.status} ${res.text}`);
      return res.json;
    },
    /** Записать игроков (рейтинг, ник) и оплатить; возвращает [{ user, entry_id }]. */
    async enroll(tid, list) {
      const out = [];
      for (const p of list) {
        const user = await login(p.phone, { rating: p.rating, nick: p.nick });
        const res = await request('POST', `/api/tournaments/${tid}/entries`, { token: user.token, key: randomUUID(), body: { return_url: '/app/tournaments' } });
        if (res.status !== 201) throw new Error(`enroll ${p.phone}: ${res.status} ${res.text}`);
        if (res.json.status === 'pending_payment') await h.pay(res.json.entry_id);
        out.push({ user, entry_id: res.json.entry_id });
      }
      return out;
    },
    async close() {
      await tournamentsModule.tournaments().service.flush().catch(() => {});
      hub.closeAll();
      const closed = new Promise((r) => server.close(r));
      server.closeAllConnections();
      await closed;
      await app.stop();
      await pool.end();
      await db.drop();
    },
  };
  return h;
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
