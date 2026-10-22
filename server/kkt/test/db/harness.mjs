// Обвязка тестов ККТ, смен и отчётов на настоящем Postgres (npm run test:db -w @billiardum/server).
//
// * Временная база с миграциями и сидом (supabase/tests/helpers.mjs), второй клуб — seedClubB.
// * Сервер как в бою: createApp с модулем kkt и маршрутами core + kkt, shifts, reports; пул под app_api
//   (те же права и RLS); WebSocket /api/kkt/ws — через событие upgrade HTTP-сервера.
// * Эмулятор веб-сервера АТОЛ и настоящий мост tools/kkt-bridge (исходящее WebSocket).
// * По желанию — эмулятор ЮKassa и магазин клуба A (сверка онлайн-оплат).

import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRoutes } from '../../../../api/router.mjs';
import { createTestDatabase, seedClubB, CLUB_B, OWNER_B } from '../../../../supabase/tests/helpers.mjs';
import { createAtolEmulator } from '../../../../tools/kkt-bridge/emu/emulator.mjs';
import { createBridge } from '../../../../tools/kkt-bridge/lib/bridge.mjs';
import { parseConfig } from '../../../../tools/kkt-bridge/lib/config.mjs';
import { createEmulator as createYooKassaEmulator } from '../../../../tools/yookassa-emu/lib/emulator.mjs';
import { createApp } from '../../../http/app.mjs';
import { hub } from '../../../http/sse.mjs';
import { withContext } from '../../../lib/store.mjs';
import { createOutbox } from '../../../outbox.mjs';
import { loadMoneyConfig } from '../../../payments/config.mjs';
import { provisionPayments } from '../../../payments/provision-dev.mjs';
import { insertReceipt } from '../../../payments/records.mjs';
import { receiptItems } from '../../../payments/receipt.mjs';
import { appPool, memoryLog, ORIGIN, testConfig, waitFor } from '../../../test/db/helpers.mjs';
import * as kkt from '../../index.mjs';

export { CLUB_B, OWNER_B, waitFor };
export const CLUB_A = 'c1000000-0000-4000-8000-000000000001';
export const OWNER_A = 'a1000000-0000-4000-8000-000000000001';
export const MANAGER_A = 'a1000000-0000-4000-8000-000000000003';
export const RECEPTION_A = 'a1000000-0000-4000-8000-000000000004';
export const TABLE_1 = 'e1000000-0000-4000-8000-000000000001';
export const TABLE_2 = 'e1000000-0000-4000-8000-000000000002';
export const TABLE_B = 'e2000000-0000-4000-8000-000000000001';
export const GUEST = 'a9000000-0000-4000-8000-0000000000aa';
export const PHONES = { owner: '+70000000001', ownerB: '+70000000002', manager: '+70000000003', reception: '+70000000004' };
export const SHOP_A = { shopId: '710001', secret: `kkt_test_${randomBytes(8).toString('hex')}` };

/**
 * @param {{ yookassa?: boolean, kkt?: object }} [options] kkt — настройки сервиса (паузы для тестов)
 */
export async function setupKkt({ yookassa = false, kkt: kktOptions = {} } = {}) {
  const db = await createTestDatabase();
  await seedClubB(db.pool);
  await db.pool.query(`insert into bl.users (id, phone) values ('${GUEST}', '+79990000099') on conflict do nothing`);
  const encKey = randomBytes(32);
  const config = testConfig({ encKey });
  const log = memoryLog();
  const pool = appPool(db.url, { max: 20 });
  const outbox = createOutbox({ pollMs: 100 });
  hub.setLogger(log);

  let yk = null;
  let moneyConfig = null;
  if (yookassa) {
    yk = createYooKassaEmulator({ shops: [SHOP_A] });
    const addr = await yk.listen(0);
    yk.url = `http://127.0.0.1:${addr.port}`;
    const admin = await db.pool.connect();
    try {
      await provisionPayments({ client: admin, env: { YOOKASSA_EMU_SHOP_ID: SHOP_A.shopId, YOOKASSA_EMU_SECRET: SHOP_A.secret, SECRETS_ENC_KEY: encKey.toString('base64') } });
    } finally {
      admin.release();
    }
    moneyConfig = loadMoneyConfig({ YOOKASSA_API_URL: `${yk.url}/v3`, YOOKASSA_TIMEOUT_MS: '3000' }, { encKey, production: false });
  }

  const options = { resendMs: 400, tickMs: 100, alarmTickMs: 3600_000, pingMs: 2_000, retryBaseMs: 150, retryMaxMs: 600, ...kktOptions };
  const module = {
    init: (ctx) => kkt.init({ ...ctx, kkt: options, money: moneyConfig ? { config: moneyConfig } : undefined }),
    stop: () => kkt.stop(),
  };
  const routes = await loadRoutes({ config, only: ['auth.mjs', 'owner.mjs', 'stream.mjs', 'kkt.mjs', 'shifts.mjs', 'reports.mjs'] });
  const app = await createApp({ config, log, pool, modules: [{ name: 'kkt', module }], outbox, sse: hub, routes, listen: true });
  const server = http.createServer(app.handler);
  server.on('upgrade', (req, socket, head) => {
    if (!kkt.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/api/kkt/ws`;

  const emu = createAtolEmulator({ recoverMs: 50 });
  await emu.listen(0);
  const dataDir = mkdtempSync(join(tmpdir(), 'kkt-db-test-'));
  const bridges = [];

  async function request(method, path, { body, token, origin = ORIGIN, headers = {} } = {}) {
    const h = { ...headers };
    if (method !== 'GET') h['content-type'] = 'application/json';
    if (token) h.authorization = `Bearer ${token}`;
    if (origin && method !== 'GET') h.origin = origin;
    const res = await fetch(`${base}${path}`, { method, headers: h, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  const tokens = new Map();
  async function login(who) {
    const phone = PHONES[who] ?? who;
    if (tokens.has(phone)) return tokens.get(phone);
    const res = await request('POST', '/api/auth/dev', { body: { phone }, origin: null });
    if (res.status !== 200) throw new Error(`login ${who}: ${res.status}`);
    tokens.set(phone, res.json.token);
    return res.json.token;
  }

  /** Транзакция app_api в контексте клуба (коммит). */
  const asClub = (clubId, fn) => withContext(pool, { clubId, actorType: 'system' }, fn);

  /** Зарегистрировать мост клуба через API владельцем. */
  async function registerBridge(who = 'owner', clubId = CLUB_A, name = 'Ресепшн') {
    const res = await request('POST', `/api/clubs/${clubId}/kkt/bridges`, { token: await login(who), body: { name } });
    if (res.status !== 201) throw new Error(`register bridge: ${res.status} ${JSON.stringify(res.json)}`);
    return res.json;
  }

  function startBridge(token, overrides = {}) {
    const b = createBridge({
      config: parseConfig(
        {
          server_url: wsUrl,
          token,
          atol_url: emu.url,
          name: 'Ресепшн',
          data_dir: join(dataDir, `b${bridges.length}`),
          job_timeout_ms: 1500,
          poll_ms: 20,
          status_poll_ms: 100,
          reconnect_min_ms: 30,
          reconnect_max_ms: 300,
          ...overrides,
        },
        { env: {} },
      ),
    });
    bridges.push(b);
    b.start();
    return b;
  }

  /** Платёж ресепшена M1 (заявка стола) и задание на чек ККТ — как server/reception (money). */
  async function receptionPayment({ clubId = CLUB_A, resourceId = TABLE_1, number = 1, method = 'cash', amount = 80000, minutes = 60, acceptedBy = RECEPTION_A, at = new Date() } = {}) {
    return asClub(clubId, async (dbc) => {
      const { rows } = await dbc.query(
        `insert into bl.payments (club_id, resource_id, user_id, kind, provider, method, idempotence_key, status, amount_kopecks, capture,
                                  minutes, received_kopecks, change_kopecks, accepted_by, confirmed_at, captured_at, created_at, updated_at)
         values ($1, $2, $3, 'start', 'reception', $4, $5, 'succeeded', $6, true, $7, $8, $9, $10, $11, $11, $11, $11) returning *`,
        [clubId, resourceId, GUEST, method, `rr-${randomUUID()}`, amount, minutes, method === 'cash' ? amount : null, method === 'cash' ? 0 : null, acceptedBy, at],
      );
      const p = rows[0];
      const receiptId = await insertReceipt(dbc, {
        clubId,
        paymentId: p.id,
        channel: 'kkt',
        status: 'receipt_pending',
        amountKopecks: amount,
        items: receiptItems({ resourceNumber: number, minutes, amountKopecks: amount, vatCode: 1 }),
        taxSystemCode: null,
        userId: GUEST,
        now: at,
      });
      return { paymentId: p.id, receiptId };
    });
  }

  /** Продажа бара на кассе (как backend-pos: платёж kind bar и enqueueReceipt). */
  async function barSale({ clubId = CLUB_A, method = 'cash', lines = [{ name: 'Чай', price_kopecks: 15000, quantity: 2 }], operatorName = 'Ресепшн (тест)', at = new Date() } = {}) {
    const { enqueueReceipt } = await import('../../api.mjs');
    return asClub(clubId, async (dbc) => {
      const amount = lines.reduce((a, l) => a + l.price_kopecks * (l.quantity ?? 1), 0);
      const { rows } = await dbc.query(
        `insert into bl.payments (club_id, kind, provider, method, idempotence_key, status, amount_kopecks, capture, confirmed_at, captured_at, created_at, updated_at)
         values ($1, 'bar', 'reception', $2, $3, 'succeeded', $4, true, $5, $5, $5, $5) returning id`,
        [clubId, method, `pos-${randomUUID()}`, amount, at],
      );
      const paymentId = rows[0].id;
      const receiptId = await enqueueReceipt(dbc, {
        clubId,
        kind: 'sell',
        lines,
        payments: [{ method, amount_kopecks: amount }],
        operatorName,
        paymentId,
        saleId: randomUUID(),
        at,
      });
      return { paymentId, receiptId, amount };
    });
  }

  /** Онлайн-оплата ЮKassa (эмулятор): платёж в эмуляторе, succeeded, строка bl.payments. */
  async function onlinePayment({ method = 'sbp', amount = 90000, kind = 'start', recordedAmount = amount, at = new Date() } = {}) {
    const auth = `Basic ${Buffer.from(`${SHOP_A.shopId}:${SHOP_A.secret}`).toString('base64')}`;
    const value = `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')}`;
    const res = await fetch(`${yk.url}/v3/payments`, {
      method: 'POST',
      headers: { authorization: auth, 'idempotence-key': randomUUID(), 'content-type': 'application/json' },
      body: JSON.stringify({
        amount: { value, currency: 'RUB' },
        capture: true,
        confirmation: { type: 'redirect', return_url: 'https://bl.test/app/wait' },
        payment_method_data: { type: method === 'sbp' ? 'sbp' : 'bank_card' },
        description: 'Тест',
        metadata: { club_id: CLUB_A },
        receipt: { customer: { phone: '79990000099' }, items: [{ description: 'Игра', quantity: 1, amount: { value, currency: 'RUB' }, vat_code: 1, payment_mode: 'full_payment', payment_subject: 'service' }] },
      }),
    });
    const remote = await res.json();
    if (res.status !== 200) throw new Error(`yookassa emu: ${res.status} ${JSON.stringify(remote)}`);
    await fetch(`${yk.url}/__emu/payments/${remote.id}/succeed`, { method: 'POST' });
    return asClub(CLUB_A, async (dbc) => {
      const { rows } = await dbc.query(
        `insert into bl.payments (club_id, resource_id, user_id, kind, provider, method, provider_payment_id, idempotence_key, status, amount_kopecks,
                                  capture, minutes, confirmed_at, captured_at, created_at, updated_at)
         values ($1, $2, $3, $4, 'yookassa', $5, $6, $7, 'succeeded', $8, true, $9, $10, $10, $10, $10) returning id`,
        [CLUB_A, kind === 'bar' ? null : TABLE_2, GUEST, kind, method, remote.id, `q-${randomUUID()}`, recordedAmount, kind === 'bar' ? null : 60, at],
      );
      return { paymentId: rows[0].id, providerId: remote.id };
    });
  }

  /** Возврат наличными на ресепшене с чеком возврата ККТ — как refund() money для reception. */
  async function cashRefund({ paymentId, amount, number = 1, at = new Date() }) {
    return asClub(CLUB_A, async (dbc) => {
      const { rows } = await dbc.query(
        `insert into bl.refunds (club_id, payment_id, idempotence_key, amount_kopecks, status, reason, requested_by, created_at, updated_at)
         values ($1, $2, $3, $4, 'manual', 'Гость ушёл', $5, $6, $6) returning id`,
        [CLUB_A, paymentId, `r-${randomUUID()}`, amount, MANAGER_A, at],
      );
      const refundId = rows[0].id;
      const receiptId = await insertReceipt(dbc, {
        clubId: CLUB_A,
        paymentId,
        refundId,
        kind: 'refund',
        channel: 'kkt',
        status: 'receipt_pending',
        amountKopecks: amount,
        items: receiptItems({ resourceNumber: number, minutes: 60, amountKopecks: amount, vatCode: 1 }),
        now: at,
      });
      return { refundId, receiptId };
    });
  }

  async function receipt(id) {
    const { rows } = await db.pool.query('select * from bl.receipts where id = $1', [id]);
    return rows[0];
  }

  async function waitPrinted(ids, timeoutMs = 15_000) {
    const list = Array.isArray(ids) ? ids : [ids];
    await waitFor(
      async () => {
        const { rows } = await db.pool.query(`select count(*)::int as n from bl.receipts where id = any($1::uuid[]) and status = 'printed'`, [list]);
        return rows[0].n === list.length;
      },
      { timeoutMs, stepMs: 50 },
    );
  }

  return {
    db,
    admin: db.pool,
    pool,
    log,
    config,
    outbox,
    app,
    base,
    wsUrl,
    emu,
    yk,
    moneyConfig,
    request,
    login,
    asClub,
    registerBridge,
    startBridge,
    receptionPayment,
    barSale,
    onlinePayment,
    cashRefund,
    receipt,
    waitPrinted,
    service: () => kkt.kktService(),
    async stopBridges() {
      for (const b of bridges.splice(0)) await b.stop();
    },
    async stop() {
      for (const b of bridges.splice(0)) await b.stop();
      kkt.closeConnections();
      hub.closeAll();
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
      await app.stop();
      await pool.end();
      await emu.close();
      if (yk) await yk.close();
      await db.drop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
