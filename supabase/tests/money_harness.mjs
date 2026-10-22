// Обвязка тестов денег (backend-money) на настоящем Postgres и эмуляторе ЮKassa.
//
// * Временная база с миграциями и сидом (helpers.createTestDatabase).
// * Эмулятор tools/yookassa-emu/ в процессе на свободном порту; его вебхуки приходят
//   на маленький HTTP-сервер, который вызывает маршрут вебхука так же, как роутер.
// * Соседи заменены заглушками по контракту §13: API сессий light (pending в памяти),
//   outbox — запись в bl.outbox в транзакции вызывающего, журнал — настоящий INSERT,
//   SSE, тревоги и уведомления — запись в массивы. Часы — управляемые.
// * call(route, …) повторяет роутер: транзакция app_api с контекстом пользователя
//   (SET LOCAL ROLE app_api — те же права и RLS), коммит, если обработчик не бросил.

import { randomBytes } from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import { createEmulator } from '../../tools/yookassa-emu/lib/emulator.mjs';
import { appendAuditDirect } from '../../server/payments/deps.mjs';
import { loadMoneyConfig } from '../../server/payments/config.mjs';
import { provisionPayments } from '../../server/payments/provision-dev.mjs';
import { createTestDatabase, CLUB_A, CLUB_B, OWNER_A, OWNER_B, seedClubB } from './helpers.mjs';

export { CLUB_A, CLUB_B, OWNER_A, OWNER_B };
export const RECEPTION_A = 'a1000000-0000-4000-8000-000000000004'; // seed.d/0100_core.sql
export const GUEST_1 = 'a9000000-0000-4000-8000-000000000001';
export const GUEST_2 = 'a9000000-0000-4000-8000-000000000002';
export const GUEST_NO_PHONE = 'a9000000-0000-4000-8000-000000000003';
export const GUEST_NO_CONSENT = 'a9000000-0000-4000-8000-000000000004';
export const TABLE_1 = 'e1000000-0000-4000-8000-000000000001';
export const TABLE_2 = 'e1000000-0000-4000-8000-000000000002';
export const TABLE_B = 'e2000000-0000-4000-8000-000000000001';
export const SHOP_A = { shopId: '700001', secret: `test_A_${randomBytes(8).toString('hex')}` };
export const SHOP_B = { shopId: '700002', secret: `test_B_${randomBytes(8).toString('hex')}` };

/** Заглушка API сессий light (§13): pending и сессии в памяти. */
export function createSessionsStub(clock) {
  const holds = new Map(); // resourceId → { userId, until }
  const sessions = new Map(); // sessionId → { id, resource_id, paid_until, status, participants:Set, payer, unlimited }
  const calls = [];
  const err = (code) => Object.assign(new Error(code), { code });
  const activeHold = (resourceId) => {
    const h = holds.get(resourceId);
    return h && h.until.getTime() > clock.now().getTime() ? h : null;
  };
  const openSession = (resourceId) => [...sessions.values()].find((s) => s.resource_id === resourceId && ['active', 'ending', 'grace'].includes(s.status));
  return {
    holds,
    sessions,
    calls,
    async getResourceByCode(db, code) {
      calls.push(['getResourceByCode', code]);
      const { rows } = await db.query('select resource_id, club_id from bl.resource_by_code($1)', [String(code).toUpperCase()]);
      if (!rows[0]) return null;
      return { resource: { id: rows[0].resource_id }, club: { id: rows[0].club_id } };
    },
    async getResourceStatus(_db, resourceId) {
      const s = openSession(resourceId);
      if (s) return { status: 'busy', busy_until: s.paid_until.toISOString(), session_id: s.id };
      if (activeHold(resourceId)) return { status: 'pending', busy_until: null, session_id: null };
      return { status: 'free', busy_until: null, session_id: null };
    },
    async holdPending(_db, { resourceId, userId, until }) {
      calls.push(['holdPending', resourceId, userId, until.toISOString()]);
      if (openSession(resourceId)) throw err('table_busy');
      const h = activeHold(resourceId);
      if (h && h.userId !== userId) throw err('table_pending');
      holds.set(resourceId, { userId, until });
      return { ok: true };
    },
    async releasePending(_db, { resourceId, userId }) {
      calls.push(['releasePending', resourceId, userId]);
      const h = holds.get(resourceId);
      if (h && h.userId === userId) holds.delete(resourceId);
      return { ok: true };
    },
    async getSessionForExtend(_db, { sessionId, userId }) {
      const s = sessions.get(sessionId);
      if (!s) return null;
      return {
        id: s.id,
        resource_id: s.resource_id,
        paid_until: s.paid_until,
        status: s.status,
        is_participant: s.participants.has(userId),
        is_payer: s.payer === userId,
        unlimited: Boolean(s.unlimited),
      };
    },
  };
}

/** Управляемые часы. */
export function createClock(start) {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    set: (d) => {
      t = new Date(d).getTime();
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

function recorder() {
  const items = [];
  return { items };
}

/**
 * Поднять базу, эмулятор, вебхук-приёмник и контекст модуля.
 * @param {{ start: string|Date, configOverrides?: object }} opts
 */
export async function setupMoney({ start, configOverrides = {} } = {}) {
  const db = await createTestDatabase();
  await seedClubB(db.pool);
  const encKey = randomBytes(32);
  const env = { YOOKASSA_EMU_SHOP_ID: SHOP_A.shopId, YOOKASSA_EMU_SECRET: SHOP_A.secret, SECRETS_ENC_KEY: encKey.toString('base64') };
  const admin = await db.pool.connect();
  try {
    await provisionPayments({ client: admin, env });
    await provisionPayments({ client: admin, env: { ...env, YOOKASSA_EMU_SHOP_ID: SHOP_B.shopId, YOOKASSA_EMU_SECRET: SHOP_B.secret }, clubId: CLUB_B });
    await admin.query(`
      insert into bl.users (id, phone) values
        ('${GUEST_1}', '+79990000001'), ('${GUEST_2}', '+79990000002'), ('${GUEST_NO_CONSENT}', '+79990000004');
      insert into bl.users (id) values ('${GUEST_NO_PHONE}');
      insert into bl.consents (user_id, version) values
        ('${GUEST_1}', '2026-10-21'), ('${GUEST_2}', '2026-10-21'), ('${GUEST_NO_PHONE}', '2026-10-21');
    `);
  } finally {
    admin.release();
  }

  const clock = createClock(start);
  const sessions = createSessionsStub(clock);
  const sse = recorder();
  const alarms = recorder();
  const notes = recorder();
  const logs = [];
  const log = {
    debug() {},
    info: (msg, f) => logs.push({ level: 'info', msg, ...f }),
    warn: (msg, f) => logs.push({ level: 'warn', msg, ...f }),
    error: (msg, f) => logs.push({ level: 'error', msg, ...f }),
  };

  // Вебхуки эмулятора → маршрут вебхука (как роутер: транзакция с контекстом платформы).
  let webhookRoute = null;
  const hookServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const m = /^\/api\/webhooks\/yookassa\/([^/]+)$/.exec(req.url);
    let status = 404;
    let json = { error: 'not_found' };
    if (m && webhookRoute) {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        body = null;
      }
      try {
        const out = await harness.call(webhookRoute, { params: { club_id: m[1] }, body, actor: 'system' });
        status = out.status;
        json = out.json;
      } catch (err) {
        status = 500;
        json = { error: 'internal' };
        log.error('test_webhook_failed', { error: err.message });
      }
    }
    const text = JSON.stringify(json);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(text);
  });
  await new Promise((r) => hookServer.listen(0, '127.0.0.1', r));
  const hookBase = `http://127.0.0.1:${hookServer.address().port}`;

  const emu = createEmulator({
    shops: [SHOP_A, SHOP_B],
    webhookUrl: `${hookBase}/api/webhooks/yookassa/{club_id}`,
    webhookRetries: 3,
    webhookRetryDelayMs: 20,
  });
  const emuAddr = await emu.listen(0);
  const emuBase = `http://127.0.0.1:${emuAddr.port}`;
  emu.config.publicUrl = emuBase;

  const config = {
    ...loadMoneyConfig({ YOOKASSA_API_URL: `${emuBase}/v3`, PUBLIC_HOST: 'billiardum.test', NODE_ENV: 'test' }, { encKey }),
    ...configOverrides,
  };

  const ctx = {
    log,
    clock,
    pool: db.pool,
    sessionsApi: sessions,
    audit: { appendAudit: appendAuditDirect },
    outbox: {
      async enqueue(client, topic, payload) {
        await client.query('insert into bl.outbox (club_id, topic, payload) values (bl.ctx_club_id(), $1, $2::jsonb)', [topic, JSON.stringify(payload)]);
      },
      subscribe() {},
    },
    sse: { publish: (channel, event, data) => sse.items.push({ channel, event, data }) },
    alarms: {
      async raise(_db, clubId, a) {
        alarms.items.push({ clubId, ...a });
        return null;
      },
    },
    notify: {
      async send(_db, userId, msg) {
        notes.items.push({ userId, ...msg });
        return { notification_id: null };
      },
      async sendToClubStaff(_db, clubId, roles, msg) {
        notes.items.push({ clubId, roles, ...msg });
      },
    },
    money: { config },
  };

  /** Транзакция как у роутера: app_api, контекст пользователя (или платформы). */
  async function tx({ clubId = null, userId = null, actorType = 'user' } = {}, fn) {
    const client = await db.pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role app_api');
      await client.query(
        "select set_config('app.club_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_type', $3, true)",
        [clubId ?? '', userId ?? '', actorType],
      );
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  const harness = {
    db,
    pool: db.pool,
    emu,
    emuBase,
    clock,
    sessions,
    sse,
    alarms,
    notes,
    logs,
    ctx,
    config,
    encKey,
    tx,
    setWebhookRoute(route) {
      webhookRoute = route;
    },
    /** Вызвать маршрут: { user, club, params, query, body, headers, idempotencyKey, actor } → { status, json }. */
    async call(route, { user = null, club = null, params = {}, query = {}, body = null, headers = {}, idempotencyKey = null, ip = '203.0.113.1', actor = 'user', roles = null } = {}) {
      const userObj = user ? { id: user } : null;
      return tx({ clubId: club, userId: actor === 'system' ? null : user, actorType: actor }, (client) =>
        route.handler(
          { ...ctx, db: client, user: userObj, club, roles, idempotencyKey },
          { params, query, body, headers, ip, user: userObj, club, roles, idempotencyKey },
        ),
      );
    },
    /** Суперпользователем: строки без RLS. */
    async q(sql, params) {
      return (await db.pool.query(sql, params)).rows;
    },
    async outbox(topic) {
      return (await db.pool.query('select * from bl.outbox where topic = $1 order by id', [topic])).rows;
    },
    async audit(action) {
      return (await db.pool.query('select * from bl.audit_log where action = $1 order by club_id, seq', [action])).rows;
    },
    async close() {
      await emu.settle();
      await emu.close();
      await new Promise((r) => hookServer.close(r));
      await db.drop();
    },
  };
  return harness;
}

/** Ключ идемпотентности. */
export function newKey() {
  const h = randomBytes(16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export { pg };
