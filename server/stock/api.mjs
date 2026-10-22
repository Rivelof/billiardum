// Склад бара (decisions №80, контракт M2 §3): остаток — сумма движений, себестоимость — средняя
// по приходам. Функции для заказов и кассы (server/orders) и для маршрутов склада.
//
//   balances(db, { productIds? })                  → Map<product_id, qty (число, до тысячных)>
//   avgCosts(db, productIds)                       → Map<product_id, { cost: bigint, qtyMilli: bigint }>
//   recordSales(db, { items, saleId?, at, userId }) — kind sale, один раз на строку заказа
//   recordReturns(db, { items, refundId?, at, userId, reason }) — kind return (отмена или возврат)
//   movementCost(avg, qtyMilli)                    → копейки себестоимости (со знаком qty)
//
// db — транзакция с контекстом клуба (RLS). Количество — тысячные доли единицы (qtyMilli),
// себестоимость — BigInt без плавающей точки, «половина вверх».

import { mulDivRound } from '../orders/money.mjs';

/** '1.500' → 1500n (тысячные). */
export function toMilli(value) {
  const s = String(value).trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) throw new RangeError(`количество: ${s}`);
  const n = BigInt(m[2]) * 1000n + BigInt((m[3] ?? '').padEnd(3, '0'));
  return m[1] ? -n : n;
}

/** 1500n → '1.500'. */
export function fromMilli(milli) {
  const n = BigInt(milli);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  return `${neg ? '-' : ''}${abs / 1000n}.${String(abs % 1000n).padStart(3, '0')}`;
}

/** Число для API: 1500n → 1.5. */
export const milliToNumber = (milli) => Number(fromMilli(milli));

/** Себестоимость движения qtyMilli по средней (cost / qtyMilli приходов); приходов нет — 0. */
export function movementCost(avg, qtyMilli) {
  if (!avg || avg.qtyMilli <= 0n) return 0;
  return Number(mulDivRound(qtyMilli, avg.cost, avg.qtyMilli));
}

export async function balances(db, { productIds = null } = {}) {
  const { rows } = await db.query(
    `select product_id, sum(qty)::text as qty from bl.stock_movements
      where ($1::uuid[] is null or product_id = any($1::uuid[]))
      group by product_id`,
    [productIds],
  );
  const out = new Map();
  for (const r of rows) out.set(r.product_id, toMilli(r.qty));
  return out;
}

export async function avgCosts(db, productIds) {
  const out = new Map();
  if (!productIds || productIds.length === 0) return out;
  const { rows } = await db.query(
    `select product_id, sum(cost_kopecks)::text as cost, sum(qty)::text as qty
       from bl.stock_movements where kind = 'arrival' and product_id = any($1::uuid[])
      group by product_id`,
    [productIds],
  );
  for (const r of rows) out.set(r.product_id, { cost: BigInt(r.cost), qtyMilli: toMilli(r.qty) });
  return out;
}

async function insertMovement(db, m) {
  const { rows } = await db.query(
    `insert into bl.stock_movements (club_id, product_id, kind, qty, cost_kopecks, order_item_id, sale_id, refund_id, audit_id,
                                     reason, created_by, created_at)
     values (bl.ctx_club_id(), $1, $2, $3::numeric, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict do nothing
     returning id`,
    [m.productId, m.kind, fromMilli(m.qtyMilli), m.cost, m.orderItemId ?? null, m.saleId ?? null, m.refundId ?? null, m.auditId ?? null,
      m.reason ?? null, m.userId ?? null, m.at],
  );
  return rows[0]?.id ?? null;
}

/** Количество движения строки заказа: единицы × множитель модификаторов (тысячные). */
export function itemQtyMilli(units, stockFactor) {
  return BigInt(units) * toMilli(stockFactor);
}

/**
 * Продажа строк заказа: kind sale (qty < 0). Строки без учёта склада пропускаются; повтор
 * по той же строке ничего не добавляет (уникальный индекс).
 * @param {{ order_item_id: string, product_id: string, qty: number, stock_factor: string|number, track_stock: boolean }[]} items
 */
export async function recordSales(db, { items, saleId = null, at, userId = null }) {
  const tracked = items.filter((i) => i.track_stock);
  if (tracked.length === 0) return 0;
  const avg = await avgCosts(db, [...new Set(tracked.map((i) => i.product_id))]);
  let n = 0;
  for (const i of tracked) {
    const q = itemQtyMilli(i.qty, i.stock_factor);
    const id = await insertMovement(db, {
      productId: i.product_id,
      kind: 'sale',
      qtyMilli: -q,
      cost: -movementCost(avg.get(i.product_id), q),
      orderItemId: i.order_item_id,
      saleId,
      userId,
      at,
    });
    if (id) n += 1;
  }
  return n;
}

/**
 * Возврат на склад (kind return, qty > 0): отмена заказа (refundId = null, один раз на строку)
 * или возврат продажи (один раз на возврат и строку). Только строки, которые были списаны.
 * @param {{ order_item_id: string, product_id: string, qty: number, stock_factor: string|number, track_stock: boolean }[]} items
 */
export async function recordReturns(db, { items, refundId = null, at, userId = null, reason = null }) {
  const tracked = items.filter((i) => i.track_stock && i.qty > 0);
  if (tracked.length === 0) return 0;
  const { rows } = await db.query(
    "select order_item_id from bl.stock_movements where kind = 'sale' and order_item_id = any($1::uuid[])",
    [tracked.map((i) => i.order_item_id)],
  );
  const sold = new Set(rows.map((r) => r.order_item_id));
  const avg = await avgCosts(db, [...new Set(tracked.map((i) => i.product_id))]);
  let n = 0;
  for (const i of tracked) {
    if (!sold.has(i.order_item_id)) continue;
    const q = itemQtyMilli(i.qty, i.stock_factor);
    const id = await insertMovement(db, {
      productId: i.product_id,
      kind: 'return',
      qtyMilli: q,
      cost: movementCost(avg.get(i.product_id), q),
      orderItemId: i.order_item_id,
      refundId,
      reason,
      userId,
      at,
    });
    if (id) n += 1;
  }
  return n;
}

export { insertMovement };
