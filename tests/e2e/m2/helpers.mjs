// Общее для сценариев приёмки M2 (tests/e2e/m2): касса, бар, смены, ККТ. Работают на поднятом
// `npm run dev` (проект Compose billiardum) поверх хелперов M1: API через Caddy, эмулятор ЮKassa
// и эмулятор АТОЛ — `docker exec` (управление /__emu/ наружу не опубликовано), база — чтение
// (DATABASE_ADMIN_URL), кроме синтетического бармена +70000000005 (ensureBarUser).
// Секреты не печатаются. Столы tester — 1–6 (7–8 у pentester). Смена одна на клуб: тест
// открывает свою смену, только когда открытой нет, и закрывает только свою (журнал смен —
// файл E2E_M2_STATE, по умолчанию $TMPDIR/bl-e2e-m2-shifts.json).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { api, BASE, CLUB_A, login, ok, sleep, waitFor } from '../m1/helpers.mjs';

export * from '../m1/helpers.mjs';

export const KKT_CONTAINER = process.env.E2E_KKT_CONTAINER || 'billiardum-kkt-emu-1';
export const STATE_FILE = process.env.E2E_M2_STATE || path.join(os.tmpdir(), 'bl-e2e-m2-shifts.json');
export const BAR_PHONE = '+70000000005';
export const BAR_USER_ID = 'a1000000-0000-4000-8000-000000000005';
export const BAR_MEMBER_ID = 'b1000000-0000-4000-8000-000000000005';
export const OWNER_ID = 'a1000000-0000-4000-8000-000000000001';
export const MANAGER_ID = 'a1000000-0000-4000-8000-000000000003';
export const RECEPTION_ID = 'a1000000-0000-4000-8000-000000000004';
export const PIN = process.env.E2E_STAFF_PIN || '1234';

// Товары сида (supabase/seed.d/0400_pos.sql).
export const P = {
  teaBlack: 'cb000000-0000-4000-8000-000000000001',
  teaGreen: 'cb000000-0000-4000-8000-000000000002',
  americano: 'cb000000-0000-4000-8000-000000000003',
  cappuccino: 'cb000000-0000-4000-8000-000000000004',
  waterStill: 'cb000000-0000-4000-8000-000000000005',
  waterSpark: 'cb000000-0000-4000-8000-000000000006',
  chips: 'cb000000-0000-4000-8000-000000000007',
  nuts: 'cb000000-0000-4000-8000-000000000008',
  beer: 'cb000000-0000-4000-8000-000000000009',
};
export const M = {
  v03: 'cd000000-0000-4000-8000-000000000001',
  v04: 'cd000000-0000-4000-8000-000000000002', // +40 ₽, stock_factor 1.3
  noSugar: 'cd000000-0000-4000-8000-000000000003',
  sugar: 'cd000000-0000-4000-8000-000000000004',
};

// Деньги: своя арифметика теста (независимо от сервера) --------------------------------------

/** Каталог из меню персонала: цены товаров и модификаторов, stock_factor — из базы. */
export async function catalog(db, token) {
  const menu = await ok(api('GET', `/api/clubs/${CLUB_A}/menu`, { token }));
  const products = new Map();
  const mods = new Map();
  for (const c of menu.categories) {
    for (const p of c.products) {
      products.set(p.id, { id: p.id, name: p.name, price: p.price_kopecks, alcohol: p.is_alcohol, track: p.track_stock });
      for (const g of p.modifier_groups ?? []) for (const m of g.modifiers) mods.set(m.id, { id: m.id, name: m.name, delta: m.price_delta_kopecks });
    }
  }
  const { rows } = await db.query('select id, stock_factor::text as f from bl.modifiers where club_id = $1', [CLUB_A]);
  for (const r of rows) if (mods.has(r.id)) mods.get(r.id).factor = Number(r.f);
  return { products, mods, menu };
}

/** Сумма строки корзины по своему каталогу: (цена + Σ надбавок) × qty. */
export function lineAmount(cat, item) {
  const p = cat.products.get(item.product_id);
  if (!p) throw new Error(`нет товара ${item.product_id}`);
  const delta = (item.modifier_ids ?? []).reduce((s, id) => s + cat.mods.get(id).delta, 0);
  return (p.price + delta) * item.qty;
}

export function cartAmount(cat, items) {
  return items.reduce((s, i) => s + lineAmount(cat, i), 0);
}

/** Списание склада строки: qty × Π stock_factor модификаторов. */
export function stockUse(cat, item) {
  const f = (item.modifier_ids ?? []).reduce((x, id) => x * (cat.mods.get(id).factor ?? 1), 1);
  return item.qty * f;
}

/** Скидка процентом: round(subtotal × p / 100), «половина вверх» (decisions №82, README кассы). */
export function percentOf(subtotal, p) {
  return Math.floor((subtotal * p * 2 + 100) / 200);
}

export function rub(k) {
  const s = (Math.abs(k) / 100).toFixed(2).replace('.', ',');
  return `${k < 0 ? '−' : ''}${s} ₽`;
}

// Склад ---------------------------------------------------------------------------------------

/** Остаток товара — сумма движений (decisions №80), из базы. */
export async function stockOf(db, productId) {
  const { rows } = await db.query('select coalesce(sum(qty), 0)::text as q from bl.stock_movements where product_id = $1', [productId]);
  return Number(rows[0].q);
}

/**
 * Пополнить склад приходом (управляющий, POST /api/stock/arrivals), если остаток ниже нужного:
 * стоп при нулевом остатке (pos_stop_at_zero) иначе остановит сценарий. → [{product_id, qty}]
 */
export async function ensureStock(db, man, need) {
  const items = [];
  for (const [productId, min] of Object.entries(need)) {
    const have = await stockOf(db, productId);
    if (have < min) items.push({ product_id: productId, qty: Math.ceil(min - have) + 20, unit_cost_kopecks: 5000 });
  }
  if (items.length === 0) return [];
  const r = await api('POST', '/api/stock/arrivals', { token: man.token, body: { items, note: 'e2e: пополнение для сценария' } });
  if (r.status !== 201) throw new Error(`приход не записан: ${r.status} ${r.text}`);
  return items.map((i) => ({ product_id: i.product_id, qty: i.qty }));
}

export async function stockApi(token) {
  const list = await ok(api('GET', `/api/clubs/${CLUB_A}/stock`, { token }));
  return new Map(list.map((x) => [x.product_id, Number(x.qty)]));
}

// Эмулятор АТОЛ -------------------------------------------------------------------------------

/** Управление эмулятором АТОЛ изнутри контейнера (wget). */
export function kkt(pathname, { body } = {}) {
  const args = ['exec', KKT_CONTAINER, 'wget', '-qO-', '--header=Content-Type: application/json'];
  if (body !== undefined) args.push(`--post-data=${JSON.stringify(body)}`);
  args.push(`http://127.0.0.1:16732${pathname}`);
  const res = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`эмулятор АТОЛ ${pathname}: ${res.stderr.trim()}`);
  try {
    return JSON.parse(res.stdout);
  } catch {
    return res.stdout;
  }
}

export const kktState = () => kkt('/__emu/state');
export const kktDocs = () => kkt('/__emu/documents');
export const kktPower = (on, mode) => kkt('/__emu/power', { body: mode ? { on, mode } : { on } });

/** Документы эмулятора по UUID заданий чека (все попытки kkt_job.uuids). */
export function docsFor(docs, receipt) {
  const uuids = new Set([receipt.id, ...(receipt.kkt_job?.uuids ?? [])]);
  return docs.filter((d) => d.uuid && uuids.has(d.uuid));
}

export async function receiptRow(db, id) {
  const { rows } = await db.query('select id, kind, channel, status, amount_kopecks, payment_id, sale_id, refund_id, fd, fp, fn, printed_at, kkt_job, error, items from bl.receipts where id = $1', [id]);
  return rows[0] ?? null;
}

export async function waitReceiptsPrinted(db, ids, { timeoutMs = 60_000 } = {}) {
  const list = [].concat(ids).filter(Boolean);
  return waitFor(
    async () => {
      const { rows } = await db.query('select id, status, fd, fp from bl.receipts where id = any($1::uuid[])', [list]);
      return rows.length === list.length && rows.every((r) => r.status === 'printed') ? rows : null;
    },
    { timeoutMs, intervalMs: 300, what: `чеки ККТ printed (${list.length})` },
  );
}

// SSE -----------------------------------------------------------------------------------------

let caCache;
function caddyCa() {
  if (caCache) return caCache;
  const res = spawnSync('docker', ['exec', process.env.E2E_CADDY_CONTAINER || 'billiardum-caddy-1', 'cat', '/data/caddy/pki/authorities/local/root.crt'], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error('корень CA Caddy не прочитан');
  caCache = res.stdout;
  return caCache;
}

/**
 * Подписка на поток событий /api/stream (SSE). → { events, waitEvent(pred), close() }
 * events — [{ at, event, data }].
 */
export function sse(query, token) {
  const url = new URL(`/api/stream?${query}`, BASE);
  const events = [];
  let req;
  let status = null;
  const ready = new Promise((resolve, reject) => {
    req = https.request(url, { method: 'GET', headers: { accept: 'text/event-stream', authorization: `Bearer ${token}` }, ca: caddyCa() }, (res) => {
      status = res.statusCode;
      if (res.statusCode !== 200) {
        let t = '';
        res.on('data', (c) => (t += c));
        res.on('end', () => resolve({ status: res.statusCode, text: t }));
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let event = 'message';
          const data = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
          if (!data.length) continue;
          let parsed;
          try {
            parsed = JSON.parse(data.join('\n'));
          } catch {
            parsed = data.join('\n');
          }
          events.push({ at: Date.now(), event, data: parsed });
        }
      });
      res.on('error', () => {});
      resolve({ status: 200 });
    });
    req.on('error', (e) => {
      if (status === null) reject(e);
    });
    req.end();
  });
  return {
    events,
    ready,
    async waitEvent(pred, { timeoutMs = 10_000, what = 'событие SSE' } = {}) {
      return waitFor(() => events.find(pred) ?? null, { timeoutMs, intervalMs: 50, what });
    },
    close() {
      req?.destroy();
    },
  };
}

// Персонал ------------------------------------------------------------------------------------

/**
 * Синтетический бармен +70000000005 (decisions №97): в сиде его нет, управления персоналом —
 * M3 (№99). Вставка в bl.users / bl.club_members под DATABASE_ADMIN_URL, повтор ничего не меняет.
 */
export async function ensureBarUser(db) {
  await db.query("insert into bl.users (id, phone, name) values ($1, $2, 'Бармен (тест e2e)') on conflict do nothing", [BAR_USER_ID, BAR_PHONE]);
  const { rows } = await db.query('select id from bl.users where phone = $1', [BAR_PHONE]);
  const uid = rows[0].id;
  await db.query(
    "insert into bl.club_members (id, club_id, user_id, role) values ($1, $2, $3, 'bar') on conflict do nothing",
    [BAR_MEMBER_ID, CLUB_A, uid],
  );
  const m = await db.query('select role, active from bl.club_members where club_id = $1 and user_id = $2', [CLUB_A, uid]);
  return { userId: uid, member: m.rows[0] };
}

export async function barStaff() {
  return login(BAR_PHONE, { consent: false });
}

// Смена ---------------------------------------------------------------------------------------

function readState() {
  try {
    return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { mine: [] };
  } catch {
    return { mine: [] };
  }
}

function remember(shiftId) {
  const s = readState();
  s.mine = [...new Set([...(s.mine ?? []), shiftId])].slice(-200);
  writeFileSync(STATE_FILE, JSON.stringify(s));
}

export function isMine(shiftId) {
  return (readState().mine ?? []).includes(shiftId);
}

export async function currentShift(token) {
  return (await ok(api('GET', `/api/clubs/${CLUB_A}/shifts/current`, { token }))).shift;
}

/**
 * Открыть свою смену: ждать, пока чужая (pentester) закроется; свою оставшуюся от сбоя —
 * закрыть честно (факт = ожидаемое по данным управляющего). → shift
 */
export async function openMyShift({ rec, man, floatKopecks, log = () => {}, waitMs = 20 * 60_000 }) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const cur = await currentShift(man.token);
    if (!cur) break;
    if (isMine(cur.id)) {
      log(`осталась своя смена №${cur.number} — закрываю честно (${cur.expected_cash_kopecks} коп.)`);
      await ok(api('POST', `/api/shifts/${cur.id}/close`, { token: rec.token, body: { actual_cash_kopecks: cur.expected_cash_kopecks, comment: 'e2e: закрытие своей смены после сбоя' } }));
      continue;
    }
    if (Date.now() > deadline) throw new Error(`открыта чужая смена №${cur.number} — не дождались закрытия`);
    log(`открыта чужая смена №${cur.number} (${cur.opened_by_name}) — жду закрытия`);
    await sleep(15_000);
  }
  const r = await api('POST', `/api/clubs/${CLUB_A}/shifts`, { token: rec.token, body: { float_kopecks: floatKopecks } });
  if (r.status === 409) return openMyShift({ rec, man, floatKopecks, log, waitMs: Math.max(0, deadline - Date.now()) });
  if (r.status !== 201) throw new Error(`смена не открыта: ${r.status} ${r.text}`);
  remember(r.json.id);
  return r.json;
}

/** Закрыть свою смену; actual по умолчанию — ожидаемое по данным управляющего (честно). */
export async function closeMyShift({ rec, man, shiftId, actual, comment }) {
  if (!isMine(shiftId)) throw new Error('не своя смена');
  let fact = actual;
  if (fact === undefined) {
    const cur = await currentShift(man.token);
    if (!cur || cur.id !== shiftId) return null;
    fact = cur.expected_cash_kopecks;
  }
  return ok(api('POST', `/api/shifts/${shiftId}/close`, { token: rec.token, body: { actual_cash_kopecks: fact, ...(comment ? { comment } : {}) } }));
}

// Касса ---------------------------------------------------------------------------------------

/** Продажа на кассе. → ответ API { status, json, text } */
export function posSale(token, body, idem = true) {
  return api('POST', '/api/pos/sales', { token, body, idem });
}

/** Ждать завершения продажи и пробития чека ККТ (или чека ЮKassa). */
export async function waitSale(token, saleId, { printed = true, timeoutMs = 60_000 } = {}) {
  return waitFor(
    async () => {
      const r = await api('GET', `/api/pos/sales/${saleId}`, { token });
      if (r.status !== 200) return null;
      const s = r.json;
      if (s.status !== 'completed') return null;
      if (printed && s.receipt_id && !['printed', 'succeeded'].includes(s.receipt_status)) return null;
      return s;
    },
    { timeoutMs, intervalMs: 300, what: `продажа ${saleId} завершена${printed ? ' и чек пробит' : ''}` },
  );
}

/** id платежа ЮKassa из confirmation (redirect url или QR confirmation_data). */
export function ykId(confirmation) {
  const u = confirmation?.url ?? confirmation?.confirmation_url ?? confirmation?.confirmation_data ?? '';
  const m = /\/pay\/([^/?#]+)/.exec(u);
  if (!m) throw new Error(`нет id платежа ЮKassa в ${JSON.stringify(confirmation)}`);
  return m[1];
}

/**
 * Убрать свои заказы с экрана бара: «выдан» (как бармен после выдачи). Заказы продаж и сессий
 * теста; уже выданные и отменённые пропускаются. → число выданных.
 */
export async function serveOrders(db, token, { saleIds = [], sessionIds = [] } = {}) {
  const { rows } = await db.query(
    `select distinct o.id from bl.orders o left join bl.pos_sale_items si on si.order_id = o.id
      where o.status in ('new', 'preparing', 'ready') and o.committed_at is not null
        and (si.sale_id = any($1::uuid[]) or o.session_id = any($2::uuid[]))`,
    [saleIds.filter(Boolean), sessionIds.filter(Boolean)],
  );
  let n = 0;
  for (const r of rows) {
    const res = await api('POST', `/api/orders/${r.id}/status`, { token, body: { status: 'served' } });
    if (res.status === 200) n += 1;
  }
  return n;
}

/** Журнал по объекту (база, чтение). */
export async function auditFor(db, objectId, actions) {
  const params = [CLUB_A, objectId];
  let where = 'club_id = $1 and (object_id = $2 or data::text like $3)';
  params.push(`%${objectId}%`);
  if (actions) {
    params.push([].concat(actions));
    where += ` and action = any($${params.length}::text[])`;
  }
  const { rows } = await db.query(`select seq, action, object_type, object_id, reason, actor_type, actor_id, data, created_at from bl.audit_log where ${where} order by seq`, params);
  return rows;
}
