// Склад бара для управляющего (decisions №80, PRODUCT §5): приход с себестоимостью, списание
// с причиной, ревизия «факт против расчёта» с расхождением в деньгах по средней себестоимости,
// остатки и движения. Каждое действие — запись журнала stock.*.
//
// db — транзакция роутера с контекстом клуба; info = { userId, clubId, body, query }.
// Количество в API — число до тысячных (1.5), деньги — целые копейки.

import { PosError } from '../orders/errors.mjs';
import { avgCosts, balances, fromMilli, insertMovement, milliToNumber, movementCost, toMilli } from './api.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (v) => typeof v === 'string' && UUID.test(v);
const bad = (detail) => new PosError('bad_request', detail);
const MAX_ITEMS = 200;
const MAX_QTY_MILLI = 100_000_000n * 1000n;

/** Количество из API (число или строка, до тысячных) → тысячные; allowZero — для факта ревизии. */
export function parseQty(v, { allowZero = false } = {}) {
  let s;
  if (typeof v === 'number' && Number.isFinite(v)) s = String(v);
  else if (typeof v === 'string') s = v.trim();
  else return null;
  if (!/^\d{1,9}(\.\d{1,3})?$/.test(s)) return null;
  const m = toMilli(s);
  if (m > MAX_QTY_MILLI || (!allowZero && m <= 0n)) return null;
  return m;
}

function parseItems(items, { name }) {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) throw bad(name);
  const seen = new Set();
  return items.map((it, i) => {
    if (!it || !isUuid(it.product_id)) throw bad(`${name}[${i}].product_id`);
    if (seen.has(it.product_id)) throw bad(`${name}: повтор товара`);
    seen.add(it.product_id);
    return it;
  });
}

async function loadProducts(db, ids) {
  const { rows } = await db.query('select id, name, unit, track_stock from bl.products where id = any($1::uuid[])', [ids]);
  const map = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) if (!map.has(id)) throw new PosError('not_found', `product ${id}`);
  return map;
}

/** POST /api/stock/arrivals { items: [{ product_id, qty, cost_kopecks | unit_cost_kopecks }], note? } */
export async function arrival(db, deps, info) {
  const b = info.body ?? {};
  const items = parseItems(b.items, { name: 'items' });
  const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 2000) : null;
  const products = await loadProducts(db, items.map((i) => i.product_id));
  const at = deps.clock.now();
  const out = [];
  let total = 0;
  for (const [i, it] of items.entries()) {
    const q = parseQty(it.qty);
    if (q === null) throw bad(`items[${i}].qty`);
    let cost;
    if (it.cost_kopecks !== undefined) {
      if (!Number.isSafeInteger(it.cost_kopecks) || it.cost_kopecks < 0 || it.cost_kopecks > 10_000_000_000) throw bad(`items[${i}].cost_kopecks`);
      if (it.unit_cost_kopecks !== undefined) throw bad(`items[${i}]: cost_kopecks или unit_cost_kopecks`);
      cost = it.cost_kopecks;
    } else if (it.unit_cost_kopecks !== undefined) {
      if (!Number.isSafeInteger(it.unit_cost_kopecks) || it.unit_cost_kopecks < 0 || it.unit_cost_kopecks > 100_000_000) throw bad(`items[${i}].unit_cost_kopecks`);
      cost = Number((q * BigInt(it.unit_cost_kopecks) + 500n) / 1000n);
    } else {
      throw bad(`items[${i}]: нужна себестоимость`);
    }
    await insertMovement(db, { productId: it.product_id, kind: 'arrival', qtyMilli: q, cost, reason: note, userId: info.userId, at });
    total += cost;
    out.push({ product_id: it.product_id, name: products.get(it.product_id).name, qty: milliToNumber(q), cost_kopecks: cost });
  }
  await deps.audit.appendAudit(db, {
    action: 'stock.arrival',
    objectType: 'club',
    objectId: info.clubId,
    reason: note,
    data: { items: out.length, cost_kopecks: total, lines: out.slice(0, 50).map((l) => [l.product_id, l.qty, l.cost_kopecks]) },
    actorType: 'user',
    actorId: info.userId,
  });
  return { items: out, cost_kopecks: total };
}

/** POST /api/stock/writeoffs { items: [{ product_id, qty }], reason } — причина обязательна. */
export async function writeoff(db, deps, info) {
  const b = info.body ?? {};
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (!reason) throw new PosError('reason_required');
  if (reason.length > 2000) throw bad('reason');
  const items = parseItems(b.items, { name: 'items' });
  const products = await loadProducts(db, items.map((i) => i.product_id));
  const avg = await avgCosts(db, items.map((i) => i.product_id));
  const at = deps.clock.now();
  const out = [];
  let total = 0;
  for (const [i, it] of items.entries()) {
    const q = parseQty(it.qty);
    if (q === null) throw bad(`items[${i}].qty`);
    const cost = movementCost(avg.get(it.product_id), q);
    await insertMovement(db, { productId: it.product_id, kind: 'writeoff', qtyMilli: -q, cost: -cost, reason, userId: info.userId, at });
    total += cost;
    out.push({ product_id: it.product_id, name: products.get(it.product_id).name, qty: milliToNumber(q), cost_kopecks: cost });
  }
  await deps.audit.appendAudit(db, {
    action: 'stock.writeoff',
    objectType: 'club',
    objectId: info.clubId,
    reason,
    data: { items: out.length, cost_kopecks: total, lines: out.slice(0, 50).map((l) => [l.product_id, l.qty, l.cost_kopecks]) },
    actorType: 'user',
    actorId: info.userId,
  });
  return { items: out, cost_kopecks: total };
}

/**
 * POST /api/stock/audits { items: [{ product_id, actual_qty }], note? } — ревизия: расчёт
 * (сумма движений) против факта; поправка kind audit на разницу; расхождение в деньгах —
 * разница × средняя себестоимость по приходам (до копейки, со знаком: недостача < 0).
 */
export async function stockAudit(db, deps, info) {
  const b = info.body ?? {};
  const items = parseItems(b.items, { name: 'items' });
  const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 2000) : null;
  const ids = items.map((i) => i.product_id);
  // Блокировка товаров ревизии: продажа того же товара в это время ждёт (расчёт не уплывает).
  await db.query('select id from bl.products where id = any($1::uuid[]) order by id for update', [ids]);
  const products = await loadProducts(db, ids);
  const stock = await balances(db, { productIds: ids });
  const avg = await avgCosts(db, ids);
  const at = deps.clock.now();
  const lines = [];
  for (const [i, it] of items.entries()) {
    const actual = parseQty(it.actual_qty, { allowZero: true });
    if (actual === null) throw bad(`items[${i}].actual_qty`);
    const expected = stock.get(it.product_id) ?? 0n;
    const diffMilli = actual - expected;
    const a = avg.get(it.product_id);
    const unitCost = movementCost(a, 1000n);
    const sign = diffMilli < 0n ? -1 : 1;
    const diffCost = diffMilli === 0n ? 0 : sign * movementCost(a, diffMilli < 0n ? -diffMilli : diffMilli);
    lines.push({
      product_id: it.product_id,
      name: products.get(it.product_id).name,
      unit: products.get(it.product_id).unit,
      expected_qty: milliToNumber(expected),
      actual_qty: milliToNumber(actual),
      diff_qty: milliToNumber(diffMilli),
      unit_cost_kopecks: unitCost,
      diff_kopecks: diffCost,
      _diff: diffMilli,
    });
  }
  const total = lines.reduce((s, l) => s + l.diff_kopecks, 0);
  const clean = lines.map(({ _diff, ...l }) => l);
  const { rows } = await db.query(
    `insert into bl.stock_audits (club_id, created_by, note, lines, total_diff_kopecks, created_at)
     values ($1, $2, $3, $4::jsonb, $5, $6) returning id`,
    [info.clubId, info.userId, note, JSON.stringify(clean), total, at],
  );
  const auditId = rows[0].id;
  for (const l of lines) {
    if (l._diff === 0n) continue;
    await insertMovement(db, { productId: l.product_id, kind: 'audit', qtyMilli: l._diff, cost: l.diff_kopecks, auditId, reason: note, userId: info.userId, at });
  }
  await deps.audit.appendAudit(db, {
    action: 'stock.audit',
    objectType: 'stock_audit',
    objectId: auditId,
    reason: note,
    data: { audit_id: auditId, items: lines.length, mismatches: lines.filter((l) => l._diff !== 0n).length, total_diff_kopecks: total },
    actorType: 'user',
    actorId: info.userId,
  });
  return { audit_id: auditId, lines: clean, total_diff_kopecks: total, created_at: at.toISOString() };
}

export async function getAudit(db, info) {
  const { rows } = await db.query('select * from bl.stock_audits where id = $1', [info.params.id]);
  const a = rows[0];
  if (!a) throw new PosError('not_found', 'audit');
  return { audit_id: a.id, lines: a.lines, total_diff_kopecks: Number(a.total_diff_kopecks), note: a.note, created_by: a.created_by, created_at: new Date(a.created_at).toISOString() };
}

/** GET /api/clubs/{club}/stock — остатки, средняя себестоимость и стоимость остатка. */
export async function stockList(db, { clubId }) {
  const { rows } = await db.query(
    'select id, name, unit, category_id, active, stop_list from bl.products where club_id = $1 and track_stock order by name, id',
    [clubId],
  );
  const ids = rows.map((r) => r.id);
  const stock = await balances(db, { productIds: ids });
  const avg = await avgCosts(db, ids);
  return rows.map((p) => {
    const q = stock.get(p.id) ?? 0n;
    const a = avg.get(p.id);
    return {
      product_id: p.id,
      name: p.name,
      unit: p.unit,
      category_id: p.category_id,
      active: p.active,
      stop_list: p.stop_list,
      qty: milliToNumber(q),
      avg_cost_kopecks: a && a.qtyMilli > 0n ? movementCost(a, 1000n) : 0,
      value_kopecks: q > 0n ? movementCost(a, q) : 0,
    };
  });
}

/** GET /api/clubs/{club}/stock/movements?product_id&kind&before&limit */
export async function movements(db, { clubId, query = {} }) {
  const limit = Math.min(Math.max(Number.parseInt(query.limit ?? '100', 10) || 100, 1), 500);
  const productId = isUuid(query.product_id) ? query.product_id : null;
  const kind = ['sale', 'arrival', 'writeoff', 'audit', 'return'].includes(query.kind) ? query.kind : null;
  let before = null;
  if (query.before) {
    const d = new Date(query.before);
    if (Number.isNaN(d.getTime())) throw bad('before');
    before = d;
  }
  const { rows } = await db.query(
    `select m.*, m.qty::text as qty, p.name from bl.stock_movements m join bl.products p on p.id = m.product_id
      where m.club_id = $1 and ($2::uuid is null or m.product_id = $2) and ($3::text is null or m.kind = $3)
        and ($4::timestamptz is null or m.created_at < $4)
      order by m.created_at desc, m.id limit $5`,
    [clubId, productId, kind, before, limit],
  );
  return rows.map((m) => ({
    id: m.id,
    product_id: m.product_id,
    name: m.name,
    kind: m.kind,
    qty: Number(m.qty),
    cost_kopecks: Number(m.cost_kopecks),
    order_item_id: m.order_item_id,
    sale_id: m.sale_id,
    audit_id: m.audit_id,
    reason: m.reason,
    created_by: m.created_by,
    created_at: new Date(m.created_at).toISOString(),
  }));
}

export { fromMilli };
