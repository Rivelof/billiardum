// Обвязка тестов бара и кассы (backend-pos) на настоящем Postgres и эмуляторе ЮKassa.
//
// * Временная база с миграциями и сидом (supabase/tests/helpers.mjs), второй клуб для изоляции.
// * Приложение — настоящий createApp (core): роутер, outbox, тревоги, уведомления, журнал;
//   маршруты: вход (auth.mjs), бар и касса (catalog, orders, pos, stock), ресепшн и вебхук money.
//   Модули: модуль заказов (server/orders/index.mjs) и подготовка контекста теста.
// * Соседи M2 — по контракту §5: currentShift — открытая смена из bl.shifts (таблица kkt),
//   enqueueReceipt — запись bl.receipts (receipt_pending) и журнал вызовов.
// * ЮKassa — эмулятор tools/yookassa-emu/ за прокси, который добавляет confirmation.type = qr
//   (эмулятор M1 знает только redirect: что добавить в эмулятор — в README модуля).

import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { createEmulator } from '../../../../tools/yookassa-emu/lib/emulator.mjs';
import { createApp } from '../../../http/app.mjs';
import { createOutbox } from '../../../outbox.mjs';
import { loadMoneyConfig } from '../../../payments/config.mjs';
import { provisionPayments } from '../../../payments/provision-dev.mjs';
import { loadRoutes } from '../../../../api/router.mjs';
import { appPool, memoryLog, ORIGIN, testConfig } from '../../../test/db/helpers.mjs';
import { createTestDatabase, seedClubB } from '../../../../supabase/tests/helpers.mjs';
import * as posModule from '../../index.mjs';
import { shiftLinkProblems } from '../../api.mjs';

export const CLUB_A = 'c1000000-0000-4000-8000-000000000001';
export const CLUB_B = 'c2000000-0000-4000-8000-000000000002';
export const TABLE_1 = 'e1000000-0000-4000-8000-000000000001';
export const TABLE_2 = 'e1000000-0000-4000-8000-000000000002';
export const TABLE_3 = 'e1000000-0000-4000-8000-000000000003';
/** Стол N тестового клуба (сид: 1–8). */
export const table = (n) => `e1000000-0000-4000-8000-00000000000${n}`;
export const PHONES = { owner: '+70000000001', manager: '+70000000003', reception: '+70000000004' };
export const P = {
  teaBlack: 'cb000000-0000-4000-8000-000000000001',
  americano: 'cb000000-0000-4000-8000-000000000003',
  cappuccino: 'cb000000-0000-4000-8000-000000000004',
  water: 'cb000000-0000-4000-8000-000000000005',
  sparkling: 'cb000000-0000-4000-8000-000000000006',
  chips: 'cb000000-0000-4000-8000-000000000007',
  nuts: 'cb000000-0000-4000-8000-000000000008',
  beer: 'cb000000-0000-4000-8000-000000000009',
};
export const M = { v03: 'cd000000-0000-4000-8000-000000000001', v04: 'cd000000-0000-4000-8000-000000000002', noSugar: 'cd000000-0000-4000-8000-000000000003', sugar: 'cd000000-0000-4000-8000-000000000004' };
const SHOP_A = { shopId: '710001', secret: `test_A_${randomBytes(8).toString('hex')}` };

export const newKey = () => randomUUID();

/** Прокси перед эмулятором: confirmation.type = qr (контракт M2 §5) поверх redirect эмулятора. */
async function startQrProxy(emuBase) {
  const qrIds = new Set();
  // Сбой «ЮKassa выполнила, ответ потерян»: следующие count запросов на path уходят в эмулятор, а
  // клиенту — 503 (retryable). created — id объектов, созданных через прокси (POST), по путям.
  const faults = { loseResponse: null };
  const created = new Map();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
    let qr = false;
    if (req.method === 'POST' && req.url === '/v3/payments' && body) {
      const json = JSON.parse(body);
      if (json?.confirmation?.type === 'qr') {
        qr = true;
        json.confirmation = { type: 'redirect', return_url: 'https://bl.test/qr' };
        body = JSON.stringify(json);
      }
    }
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    const r = await fetch(`${emuBase}${req.url}`, { method: req.method, headers, body });
    let text = await r.text();
    try {
      const json = JSON.parse(text);
      if (req.method === 'POST' && json?.id && r.status < 300) {
        const list = created.get(req.url) ?? new Set();
        list.add(json.id);
        created.set(req.url, list);
      }
      if (qr && json?.id) qrIds.add(json.id);
      const id = json?.id ?? null;
      if (id && qrIds.has(id) && json.confirmation) {
        json.confirmation = { type: 'qr', confirmation_data: `https://qr.nspk.ru/TEST${id.replace(/-/g, '').slice(0, 20)}` };
        text = JSON.stringify(json);
      }
    } catch {
      // не JSON — как есть
    }
    const lose = faults.loseResponse;
    if (lose && lose.count > 0 && req.method === 'POST' && req.url === lose.path) {
      lose.count -= 1;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', code: 'internal_server_error', description: 'proxy: ответ потерян' }));
      return;
    }
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(text);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}`, faults, created };
}

/** @param {{ poolMax?: number }} [options] poolMax — размер пула app_api (тест R-1 — маленький пул) */
export async function setup({ poolMax = 20 } = {}) {
  const db = await createTestDatabase();
  await seedClubB(db.pool);
  const config = testConfig();
  const admin = db.pool;
  await provisionPayments({
    client: admin,
    env: { YOOKASSA_EMU_SHOP_ID: SHOP_A.shopId, YOOKASSA_EMU_SECRET: SHOP_A.secret, SECRETS_ENC_KEY: config.encKey.toString('base64') },
  });
  await admin.query('update bl.club_payment_settings set sbp_enabled = true, card_enabled = true where club_id = $1', [CLUB_A]);

  const emu = createEmulator({ shops: [SHOP_A], webhookRetries: 3, webhookRetryDelayMs: 50 });
  const emuAddr = await emu.listen(0);
  const emuBase = `http://127.0.0.1:${emuAddr.port}`;
  emu.config.publicUrl = emuBase;
  const proxy = await startQrProxy(emuBase);
  const moneyConfig = { ...loadMoneyConfig({ YOOKASSA_API_URL: `${proxy.base}/v3`, PUBLIC_HOST: 'bl.test', NODE_ENV: 'test' }, { encKey: config.encKey }) };

  const pool = appPool(db.url, { max: poolMax });
  const log = memoryLog();
  const outbox = createOutbox({ pollMs: 100 });
  const sseEvents = [];
  const sse = { publish: (channel, event, data) => sseEvents.push({ channel, event, data }), closeAll() {}, setLogger() {} };
  const kktCalls = [];
  const kktApi = {
    async enqueueReceipt(client, args) {
      kktCalls.push(args);
      const total = args.payments.reduce((s, p) => s + p.amount_kopecks, 0);
      const { rows } = await client.query(
        `insert into bl.receipts (club_id, payment_id, refund_id, kind, channel, status, amount_kopecks, items, sale_id)
         values ($1, $2, $3, $4, 'kkt', 'receipt_pending', $5, $6::jsonb, $7) returning id`,
        [args.clubId, args.paymentId ?? null, args.refundId ?? null, args.kind === 'sell_refund' ? 'refund' : 'sale', total, JSON.stringify(args.lines), args.saleId ?? null],
      );
      return rows[0].id;
    },
  };
  const shiftsApi = {
    async currentShift(client, clubId, { forUpdate = false } = {}) {
      const { rows } = await client.query(`select * from bl.shifts where club_id = $1 and closed_at is null ${forUpdate ? 'for update' : ''}`, [clubId]);
      return rows[0] ?? null;
    },
  };
  const setupModule = {
    async init(ctx) {
      ctx.money = { config: moneyConfig };
      ctx.kktApi = kktApi;
      ctx.shiftsApi = shiftsApi;
      ctx.pos = { tickMs: 200 };
    },
    async stop() {},
  };
  const routes = await loadRoutes({
    config,
    only: ['auth.mjs', 'catalog.mjs', 'orders.mjs', 'pos.mjs', 'stock.mjs', 'reception.mjs', 'webhooks.mjs', 'payments.mjs'],
  });
  const app = await createApp({
    config,
    log,
    pool,
    modules: [{ name: 'setup', module: setupModule }, { name: 'pos', module: posModule }],
    outbox,
    sse,
    routes,
  });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  emu.config.webhookUrl = `${base}/api/webhooks/yookassa/{club_id}`;

  async function request(method, path, { body, token, headers = {}, key, club } = {}) {
    const h = { ...headers };
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
    return { status: res.status, json, headers: res.headers };
  }

  const tokens = new Map();
  async function login(phone, { consent = true } = {}) {
    if (tokens.has(phone)) return tokens.get(phone);
    const res = await request('POST', '/api/auth/dev', { body: { phone } });
    if (res.status !== 200) throw new Error(`login ${phone}: ${res.status}`);
    if (consent) {
      const c = await request('POST', '/api/auth/consent', { body: { version: config.consentVersion }, token: res.json.token });
      if (c.status !== 200) throw new Error(`consent ${phone}: ${c.status}`);
    }
    const out = { token: res.json.token, id: res.json.user.id };
    tokens.set(phone, out);
    return out;
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
    sseEvents,
    kktCalls,
    config,
    request,
    login,
    /** Строки суперпользователем (в обход RLS). */
    async q(sql, params) {
      return (await admin.query(sql, params)).rows;
    },
    /** Открыть смену клуба (таблица kkt 0510). */
    async openShift(clubId = CLUB_A, openedBy = 'a1000000-0000-4000-8000-000000000004') {
      const { rows } = await admin.query(
        `insert into bl.shifts (club_id, number, opened_by, opened_at, float_kopecks)
         values ($1, coalesce((select max(number) from bl.shifts where club_id = $1), 0) + 1, $2, now(), 500000) returning id`,
        [clubId, openedBy],
      );
      return rows[0].id;
    },
    async closeShift(clubId = CLUB_A) {
      await admin.query(
        `update bl.shifts set closed_at = now(), closed_by = opened_by, actual_cash_kopecks = 0, expected_cash_kopecks = 0, discrepancy_kopecks = 0
          where club_id = $1 and closed_at is null`,
        [clubId],
      );
    },
    /** Идущая сессия стола с участниками (как после оплаты, light). */
    async session({ resourceId, payer, players = [], status = 'active' }) {
      const id = randomUUID();
      await admin.query(
        `insert into bl.sessions (id, club_id, resource_id, status, payer_user_id, started_at, paid_until, ended_at, created_at, updated_at)
         values ($1, $2, $3, $4, $5, now(), now() + interval '2 hours', $6, now(), now())`,
        [id, CLUB_A, resourceId, status, payer, status === 'closed' ? new Date() : null],
      );
      const all = [payer, ...players];
      for (const [i, u] of all.entries()) {
        await admin.query(
          `insert into bl.session_participants (session_id, club_id, user_id, role, ordinal, joined_at) values ($1, $2, $3, $4, $5, now())`,
          [id, CLUB_A, u, i === 0 ? 'payer' : 'player', i + 1],
        );
      }
      return id;
    },
    async closeSession(id) {
      await admin.query("update bl.sessions set status = 'closed', ended_at = now(), close_reason = 'expired', updated_at = now() where id = $1", [id]);
    },
    /** Заявка «Оплачу на ресепшене» (как после котировки, money). */
    async receptionRequest({ resourceId, userId, amount = 50000, minutes = 60 }) {
      const { rows: q } = await admin.query(
        `insert into bl.quotes (club_id, resource_id, user_id, kind, minutes, from_at, amount_kopecks, valid_until, used_at)
         values ($1, $2, $3, 'start', $4, now(), $5, now() + interval '3 minutes', now()) returning id`,
        [CLUB_A, resourceId, userId, minutes, amount],
      );
      const { rows } = await admin.query(
        `insert into bl.reception_requests (club_id, quote_id, resource_id, user_id, kind, minutes, amount_kopecks, status, expires_at)
         values ($1, $2, $3, $4, 'start', $5, $6, 'waiting', now() + interval '15 minutes') returning id`,
        [CLUB_A, q[0].id, resourceId, userId, minutes, amount],
      );
      return rows[0].id;
    },
    /** Следующие count POST на path (например /v3/refunds) выполнятся в эмуляторе, а ответ — 503. */
    loseResponses(path, count = 1) {
      proxy.faults.loseResponse = { path, count };
    },
    /** id объектов, созданных в ЮKassa через прокси по пути (например /v3/refunds). */
    createdAt(path) {
      return [...(proxy.created.get(path) ?? [])];
    },
    async emuSucceed(providerId) {
      const r = await fetch(`${emuBase}/__emu/payments/${providerId}/succeed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (r.status !== 200) throw new Error(`emu succeed ${r.status}`);
      await emu.settle();
    },
    async emuCancel(providerId) {
      const r = await fetch(`${emuBase}/__emu/payments/${providerId}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (r.status !== 200) throw new Error(`emu cancel ${r.status}`);
      await emu.settle();
    },
    async providerId(paymentId) {
      return (await admin.query('select provider_payment_id from bl.payments where id = $1', [paymentId])).rows[0]?.provider_payment_id;
    },
    async stock(productId) {
      const { rows } = await admin.query('select coalesce(sum(qty), 0)::text as q from bl.stock_movements where product_id = $1', [productId]);
      return Number(rows[0].q);
    },
    async outboxEvents(topic) {
      return (await admin.query('select * from bl.outbox where topic = $1 order by id', [topic])).rows;
    },
    async audit(action) {
      return (await admin.query('select * from bl.audit_log where action = $1 order by club_id, seq', [action])).rows;
    },
    async alarms(type) {
      return (await admin.query('select * from bl.alarms where type = $1 order by raised_at', [type])).rows;
    },
    /** Сверка №92 под app_api с контекстом клуба: shift_id продаж и возвратов — существующие смены клуба. */
    async shiftLinks(clubId = CLUB_A) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'system', true)", [clubId]);
        return await shiftLinkProblems(client, { clubId });
      } finally {
        await client.query('rollback').catch(() => {});
        client.release();
      }
    },
    async tick() {
      return posModule.tick({ pool, deps: await (await import('../../deps.mjs')).resolveDeps(app.ctx) });
    },
    async close() {
      await emu.settle();
      const closed = new Promise((r) => server.close(r));
      server.closeAllConnections();
      await closed;
      await app.stop();
      await pool.end();
      await emu.close();
      await new Promise((r) => proxy.server.close(r));
      await db.drop();
    },
  };
}

/** Ждать условие до timeoutMs. */
export async function waitFor(fn, { timeoutMs = 8_000, stepMs = 30 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor: не дождались');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
