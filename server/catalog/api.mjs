// Каталог бара для заказов и кассы (контракт M2 §5, decisions №76).
//
//   menuFor(db, { clubId, audience: 'guest' | 'staff' }) → меню с остатками и стоп-листом.
//       Гостю — без товаров is_alcohol, пока в настройках платформы не включено
//       qr_alcohol_allowed (№76: алкоголь скрывает сервер, а не интерфейс). Персоналу — всё.
//   alcoholAllowedForGuests(db) → boolean (bl.platform_settings.qr_alcohol_allowed)
//   resolveItems(db, { clubId, items, audience, defaultVat }) → строки заказа со снимком цены:
//       товар активен и в активной категории; гостю алкоголь не продаётся (not_found — товара
//       для гостя нет); стоп-лист и «кончился» (pos_stop_at_zero) — stop_list; модификаторы —
//       только из групп товара, в пределах min/max (без выбора — модификаторы по умолчанию).
//
// db — транзакция с контекстом клуба clubId (RLS).

import { PosError } from '../orders/errors.mjs';
import { posSettings } from '../orders/settings.mjs';
import { balances, fromMilli, milliToNumber, toMilli } from '../stock/api.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (v) => typeof v === 'string' && UUID.test(v);
export const MAX_LINES = 50;
export const MAX_QTY = 100;
const MAX_FACTOR_MILLI = 1_000_000n * 1000n;

export async function alcoholAllowedForGuests(db) {
  const { rows } = await db.query("select value from bl.platform_settings where key = 'qr_alcohol_allowed'");
  return rows[0]?.value === true;
}

async function loadModifierGroups(db, productIds) {
  if (productIds.length === 0) return new Map();
  const { rows } = await db.query(
    `select pmg.product_id, g.id as group_id, g.name as group_name, g.min_select, g.max_select, pmg.sort as link_sort, g.sort as group_sort,
            m.id as modifier_id, m.name as modifier_name, m.price_delta_kopecks, m.stock_factor::text as stock_factor, m.is_default, m.sort as modifier_sort
       from bl.product_modifier_groups pmg
       join bl.modifier_groups g on g.id = pmg.group_id and g.active
       left join bl.modifiers m on m.group_id = g.id and m.active
      where pmg.active and pmg.product_id = any($1::uuid[])
      order by pmg.product_id, pmg.sort, g.sort, g.name, m.sort, m.name`,
    [productIds],
  );
  const byProduct = new Map();
  for (const r of rows) {
    const groups = byProduct.get(r.product_id) ?? new Map();
    byProduct.set(r.product_id, groups);
    let g = groups.get(r.group_id);
    if (!g) {
      g = { id: r.group_id, name: r.group_name, min_select: r.min_select, max_select: r.max_select, modifiers: [] };
      groups.set(r.group_id, g);
    }
    if (r.modifier_id) {
      g.modifiers.push({
        id: r.modifier_id,
        name: r.modifier_name,
        price_delta_kopecks: Number(r.price_delta_kopecks),
        stock_factor: r.stock_factor,
        is_default: r.is_default,
      });
    }
  }
  const out = new Map();
  for (const [pid, groups] of byProduct) out.set(pid, [...groups.values()]);
  return out;
}

function unavailable(p, { stopAtZero, stock }) {
  if (p.stop_list) return true;
  if (stopAtZero && p.track_stock) return (stock.get(p.id) ?? 0n) <= 0n;
  return false;
}

/**
 * Меню клуба.
 * @param {import('pg').ClientBase} db транзакция с контекстом клуба
 * @param {{ clubId: string, audience: 'guest'|'staff' }} args
 */
export async function menuFor(db, { clubId, audience }) {
  if (audience !== 'guest' && audience !== 'staff') throw new Error('menuFor: audience');
  const staff = audience === 'staff';
  const alcoholAllowed = await alcoholAllowedForGuests(db);
  const hideAlcohol = !staff && !alcoholAllowed;
  const settings = await posSettings(db, clubId);
  const { rows: cats } = await db.query(
    'select id, name, sort from bl.product_categories where club_id = $1 and active order by sort, name, id',
    [clubId],
  );
  const { rows: prods } = await db.query(
    `select p.* from bl.products p
       left join bl.product_categories c on c.id = p.category_id
      where p.club_id = $1 and p.active and (p.category_id is null or c.active)
        and ($2::boolean = false or not p.is_alcohol)
      order by p.sort, p.name, p.id`,
    [clubId, hideAlcohol],
  );
  const ids = prods.map((p) => p.id);
  const groups = await loadModifierGroups(db, ids);
  const stock = await balances(db, { productIds: ids.filter((id, i) => prods[i].track_stock) });
  const byCat = new Map(cats.map((c) => [c.id, { id: c.id, name: c.name, products: [] }]));
  const other = { id: null, name: 'Другое', products: [] };
  for (const p of prods) {
    const item = {
      id: p.id,
      name: p.name,
      description: p.description,
      price_kopecks: Number(p.price_kopecks),
      unit: p.unit,
      photo: p.photo,
      available: !unavailable(p, { stopAtZero: settings.stop_at_zero, stock }),
      stop_list: p.stop_list,
      modifier_groups: (groups.get(p.id) ?? []).map((g) => ({
        id: g.id,
        name: g.name,
        min_select: g.min_select,
        max_select: g.max_select,
        modifiers: g.modifiers.map((m) => ({ id: m.id, name: m.name, price_delta_kopecks: m.price_delta_kopecks, is_default: m.is_default })),
      })),
    };
    if (staff || alcoholAllowed) item.is_alcohol = p.is_alcohol;
    if (staff) {
      item.sku = p.sku;
      item.track_stock = p.track_stock;
      item.stock_qty = p.track_stock ? milliToNumber(stock.get(p.id) ?? 0n) : null;
    }
    (byCat.get(p.category_id) ?? other).products.push(item);
  }
  const categories = [...byCat.values()].filter((c) => c.products.length > 0);
  if (other.products.length > 0) categories.push(other);
  return { club_id: clubId, audience, alcohol_hidden: hideAlcohol, categories };
}

function parseItems(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_LINES) throw new PosError('bad_request', 'items');
  return items.map((it, i) => {
    if (!it || typeof it !== 'object' || !isUuid(it.product_id)) throw new PosError('bad_request', `items[${i}].product_id`);
    if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > MAX_QTY) throw new PosError('bad_request', `items[${i}].qty`);
    const mods = it.modifier_ids ?? [];
    if (!Array.isArray(mods) || mods.length > 20 || !mods.every(isUuid) || new Set(mods).size !== mods.length) {
      throw new PosError('bad_request', `items[${i}].modifier_ids`);
    }
    return { product_id: it.product_id, qty: it.qty, modifier_ids: mods };
  });
}

function pickModifiers(product, groups, modifierIds) {
  const chosen = [];
  const wanted = new Set(modifierIds);
  for (const g of groups) {
    let sel = g.modifiers.filter((m) => wanted.has(m.id));
    for (const m of sel) wanted.delete(m.id);
    if (sel.length === 0 && g.min_select > 0) sel = g.modifiers.filter((m) => m.is_default);
    if (sel.length < g.min_select || sel.length > g.max_select) throw new PosError('bad_request', `модификаторы группы ${g.id}`);
    for (const m of sel) chosen.push({ ...m, group_id: g.id, group: g.name });
  }
  if (wanted.size > 0) throw new PosError('bad_request', `модификатор не из групп товара ${product.id}`);
  return chosen;
}

/**
 * Строки заказа по запросу клиента (снимок цены, модификаторов, НДС и предмета расчёта).
 * @param {{ clubId: string, items: any, audience: 'guest'|'staff', defaultVat: number }} args
 */
export async function resolveItems(db, { clubId, items, audience, defaultVat }) {
  const wanted = parseItems(items);
  const ids = [...new Set(wanted.map((w) => w.product_id))];
  const { rows } = await db.query(
    `select p.* from bl.products p left join bl.product_categories c on c.id = p.category_id
      where p.club_id = $1 and p.id = any($2::uuid[]) and p.active and (p.category_id is null or c.active)`,
    [clubId, ids],
  );
  const products = new Map(rows.map((p) => [p.id, p]));
  const alcoholAllowed = audience === 'staff' || (await alcoholAllowedForGuests(db));
  for (const id of ids) {
    const p = products.get(id);
    // Алкоголь гостю не продаётся: для гостя такого товара нет (№76), даже прямым запросом.
    if (!p || (p.is_alcohol && !alcoholAllowed)) throw new PosError('not_found', `product ${id}`);
  }
  const settings = await posSettings(db, clubId);
  const stock = await balances(db, { productIds: ids.filter((id) => products.get(id).track_stock) });
  const groups = await loadModifierGroups(db, ids);
  return wanted.map((w) => {
    const p = products.get(w.product_id);
    if (unavailable(p, { stopAtZero: settings.stop_at_zero, stock })) throw new PosError('stop_list', `product ${p.id}`);
    const mods = pickModifiers(p, groups.get(p.id) ?? [], w.modifier_ids);
    const unit = Number(p.price_kopecks) + mods.reduce((s, m) => s + m.price_delta_kopecks, 0);
    if (!Number.isSafeInteger(unit) || unit < 1) throw new PosError('bad_request', `цена ${p.id}`);
    let factor = 1000n;
    for (const m of mods) factor = (factor * toMilli(m.stock_factor) + 500n) / 1000n;
    if (factor < 1n || factor > MAX_FACTOR_MILLI) throw new PosError('bad_request', 'stock_factor');
    const name = [p.name, ...mods.map((m) => m.name)].join(', ').slice(0, 128);
    return {
      product_id: p.id,
      product_name: p.name,
      name,
      qty: w.qty,
      unit_price_kopecks: unit,
      amount_kopecks: unit * w.qty,
      modifiers: mods.map((m) => ({ id: m.id, group_id: m.group_id, group: m.group, name: m.name, price_delta_kopecks: m.price_delta_kopecks, stock_factor: m.stock_factor })),
      stock_factor: fromMilli(factor),
      track_stock: p.track_stock,
      is_alcohol: p.is_alcohol,
      vat_code: p.vat_code ?? defaultVat,
      payment_subject: p.payment_subject,
    };
  });
}
