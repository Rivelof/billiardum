// Управление каталогом бара (управляющий и владелец, PRODUCT §2): категории, товары, группы
// модификаторов и модификаторы, импорт меню из CSV. Каждое изменение — запись журнала
// catalog.* (кто, что, было → стало). Удаления нет: снятие с продажи — active = false
// (на товары ссылаются строки заказов и движения склада).
//
// db — транзакция роутера с контекстом клуба; info = { userId, clubId, body, params }.

import { afterCommit } from '../lib/store.mjs';
import { PosError } from '../orders/errors.mjs';
import { csvToProducts, validPhoto } from './csv.mjs';
import { looksLikeZip, XLSX_MAX_FILE_BYTES, XLSX_MIME, XlsxError, xlsxToProducts } from './xlsx.mjs';
import { parseMultipart } from '../http/multipart.mjs';
import { isUuid } from './api.mjs';
import { balances, milliToNumber } from '../stock/api.mjs';

const UNITS = ['шт', 'порц', 'л', 'мл', 'кг', 'г'];
const SUBJECTS = ['commodity', 'excise', 'service', 'job', 'composite', 'another'];
const bad = (detail) => new PosError('bad_request', detail);

const str = (v, max, { min = 1 } = {}) => typeof v === 'string' && v.trim() === v && v.length >= min && v.length <= max;
const int = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
const sortOk = (v) => int(v, -1_000_000, 1_000_000);
const factorOk = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100 && Math.round(v * 1000) === v * 1000) ||
  (typeof v === 'string' && /^\d{1,3}(\.\d{1,3})?$/.test(v) && Number(v) > 0 && Number(v) <= 100);

function uniqueViolation(err) {
  if (err?.code === '23505') return new PosError('duplicate', err.constraint ?? 'unique', 409);
  if (err?.code === '23503') return new PosError('not_found', err.constraint ?? 'fk');
  return err;
}

async function audit(db, deps, info, action, objectType, objectId, data) {
  await deps.audit.appendAudit(db, { action, objectType, objectId, data, actorType: 'user', actorId: info.userId });
}

function now(deps) {
  return deps.clock.now();
}

// Каталог целиком -------------------------------------------------------------------------------

export async function fullCatalog(db, { clubId }) {
  const cats = (await db.query('select * from bl.product_categories where club_id = $1 order by sort, name, id', [clubId])).rows;
  const prods = (await db.query('select * from bl.products where club_id = $1 order by sort, name, id', [clubId])).rows;
  const groups = (await db.query('select * from bl.modifier_groups where club_id = $1 order by sort, name, id', [clubId])).rows;
  const mods = (await db.query('select *, stock_factor::text as stock_factor from bl.modifiers where club_id = $1 order by sort, name, id', [clubId])).rows;
  const links = (await db.query('select * from bl.product_modifier_groups where club_id = $1 and active order by sort', [clubId])).rows;
  const stock = await balances(db, {});
  return {
    categories: cats.map(categoryView),
    products: prods.map((p) => ({
      ...productView(p),
      modifier_group_ids: links.filter((l) => l.product_id === p.id).map((l) => l.group_id),
      stock_qty: p.track_stock ? milliToNumber(stock.get(p.id) ?? 0n) : null,
    })),
    modifier_groups: groups.map((g) => ({ ...groupView(g), modifiers: mods.filter((m) => m.group_id === g.id).map(modifierView) })),
  };
}

export function categoryView(c) {
  return { id: c.id, name: c.name, sort: c.sort, active: c.active };
}

export function productView(p) {
  return {
    id: p.id,
    category_id: p.category_id,
    name: p.name,
    description: p.description,
    sku: p.sku,
    price_kopecks: Number(p.price_kopecks),
    unit: p.unit,
    is_alcohol: p.is_alcohol,
    vat_code: p.vat_code,
    payment_subject: p.payment_subject,
    stop_list: p.stop_list,
    track_stock: p.track_stock,
    photo: p.photo,
    sort: p.sort,
    active: p.active,
  };
}

export function groupView(g) {
  return { id: g.id, name: g.name, min_select: g.min_select, max_select: g.max_select, sort: g.sort, active: g.active };
}

export function modifierView(m) {
  return {
    id: m.id,
    group_id: m.group_id,
    name: m.name,
    price_delta_kopecks: Number(m.price_delta_kopecks),
    stock_factor: Number(m.stock_factor),
    is_default: m.is_default,
    sort: m.sort,
    active: m.active,
  };
}

// Категории ----------------------------------------------------------------------------------

export async function createCategory(db, deps, info) {
  const { name, sort = 0 } = info.body ?? {};
  if (!str(name, 100)) throw bad('name');
  if (!sortOk(sort)) throw bad('sort');
  const t = now(deps);
  let row;
  try {
    row = (await db.query(
      `insert into bl.product_categories (club_id, name, sort, created_at, updated_at) values ($1, $2, $3, $4, $4) returning *`,
      [info.clubId, name, sort, t],
    )).rows[0];
  } catch (err) {
    throw uniqueViolation(err);
  }
  await audit(db, deps, info, 'catalog.category_create', 'product_category', row.id, { category_id: row.id, name });
  return categoryView(row);
}

export async function updateCategory(db, deps, info) {
  const id = info.params.id;
  const b = info.body ?? {};
  const { rows } = await db.query('select * from bl.product_categories where id = $1 for update', [id]);
  const cur = rows[0];
  if (!cur) throw new PosError('not_found', 'category');
  const next = { ...cur };
  if ('name' in b) {
    if (!str(b.name, 100)) throw bad('name');
    next.name = b.name;
  }
  if ('sort' in b) {
    if (!sortOk(b.sort)) throw bad('sort');
    next.sort = b.sort;
  }
  if ('active' in b) {
    if (typeof b.active !== 'boolean') throw bad('active');
    next.active = b.active;
  }
  const changes = diff(cur, next, ['name', 'sort', 'active']);
  if (Object.keys(changes).length === 0) return categoryView(cur);
  let row;
  try {
    row = (await db.query('update bl.product_categories set name = $2, sort = $3, active = $4, updated_at = $5 where id = $1 returning *', [
      id, next.name, next.sort, next.active, now(deps),
    ])).rows[0];
  } catch (err) {
    throw uniqueViolation(err);
  }
  await audit(db, deps, info, 'catalog.category_update', 'product_category', id, { category_id: id, changes });
  return categoryView(row);
}

function diff(a, b, fields) {
  const out = {};
  for (const f of fields) {
    const x = typeof a[f] === 'bigint' || (f.endsWith('_kopecks') && a[f] !== null) ? Number(a[f]) : a[f];
    const y = typeof b[f] === 'bigint' || (f.endsWith('_kopecks') && b[f] !== null) ? Number(b[f]) : b[f];
    if (JSON.stringify(x) !== JSON.stringify(y)) out[f] = [x ?? null, y ?? null];
  }
  return out;
}

// Товары -------------------------------------------------------------------------------------

const PRODUCT_FIELDS = ['category_id', 'name', 'description', 'sku', 'price_kopecks', 'unit', 'is_alcohol', 'vat_code', 'payment_subject',
  'stop_list', 'track_stock', 'photo', 'sort', 'active'];

/** Проверить поля товара из тела запроса (частично для PATCH). */
function productFields(b, { partial }) {
  const out = {};
  const has = (k) => k in b;
  const need = (k) => !partial || has(k);
  if (need('name')) {
    if (!str(b.name, 128)) throw bad('name');
    out.name = b.name;
  }
  if (need('price_kopecks')) {
    if (!int(b.price_kopecks, 1, 100_000_000)) throw bad('price_kopecks');
    out.price_kopecks = b.price_kopecks;
  }
  if (has('category_id')) {
    if (b.category_id !== null && !isUuid(b.category_id)) throw bad('category_id');
    out.category_id = b.category_id;
  }
  if (has('description')) {
    if (b.description !== null && !(typeof b.description === 'string' && b.description.length <= 500)) throw bad('description');
    out.description = b.description === '' ? null : b.description;
  }
  if (has('sku')) {
    if (b.sku !== null && !(typeof b.sku === 'string' && /^[0-9A-Za-z._/-]{1,64}$/.test(b.sku))) throw bad('sku');
    out.sku = b.sku;
  }
  if (has('unit')) {
    if (!UNITS.includes(b.unit)) throw bad('unit');
    out.unit = b.unit;
  }
  for (const k of ['is_alcohol', 'stop_list', 'track_stock', 'active']) {
    if (has(k)) {
      if (typeof b[k] !== 'boolean') throw bad(k);
      out[k] = b[k];
    }
  }
  if (has('vat_code')) {
    if (b.vat_code !== null && !int(b.vat_code, 1, 12)) throw bad('vat_code');
    out.vat_code = b.vat_code;
  }
  if (has('payment_subject')) {
    if (!SUBJECTS.includes(b.payment_subject)) throw bad('payment_subject');
    out.payment_subject = b.payment_subject;
  }
  if (has('photo')) {
    if (b.photo !== null && !validPhoto(b.photo)) throw bad('photo');
    out.photo = b.photo;
  }
  if (has('sort')) {
    if (!sortOk(b.sort)) throw bad('sort');
    out.sort = b.sort;
  }
  if (has('modifier_group_ids')) {
    const g = b.modifier_group_ids;
    if (!Array.isArray(g) || g.length > 10 || !g.every(isUuid) || new Set(g).size !== g.length) throw bad('modifier_group_ids');
  }
  return out;
}

async function linkGroups(db, clubId, productId, groupIds) {
  if (groupIds.length > 0) {
    const { rows } = await db.query('select id from bl.modifier_groups where id = any($1::uuid[])', [groupIds]);
    if (rows.length !== groupIds.length) throw new PosError('not_found', 'modifier_group');
  }
  await db.query('update bl.product_modifier_groups set active = false where product_id = $1 and not (group_id = any($2::uuid[]))', [productId, groupIds]);
  for (const [i, gid] of groupIds.entries()) {
    await db.query(
      `insert into bl.product_modifier_groups (club_id, product_id, group_id, sort, active) values ($1, $2, $3, $4, true)
       on conflict (product_id, group_id) do update set sort = excluded.sort, active = true`,
      [clubId, productId, gid, i],
    );
  }
}

export async function createProduct(db, deps, info) {
  const b = info.body ?? {};
  const f = productFields(b, { partial: false });
  const t = now(deps);
  const p = {
    category_id: null, description: null, sku: null, unit: 'шт', is_alcohol: false, vat_code: null,
    payment_subject: f.is_alcohol ? 'excise' : 'commodity', stop_list: false, track_stock: true, photo: null, sort: 0, active: true,
    ...f,
  };
  let row;
  try {
    row = (await db.query(
      `insert into bl.products (club_id, category_id, name, description, sku, price_kopecks, unit, is_alcohol, vat_code, payment_subject,
                                stop_list, track_stock, photo, sort, active, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16) returning *`,
      [info.clubId, p.category_id, p.name, p.description, p.sku, p.price_kopecks, p.unit, p.is_alcohol, p.vat_code, p.payment_subject,
        p.stop_list, p.track_stock, p.photo, p.sort, p.active, t],
    )).rows[0];
  } catch (err) {
    throw uniqueViolation(err);
  }
  const groupIds = b.modifier_group_ids ?? [];
  await linkGroups(db, info.clubId, row.id, groupIds);
  await audit(db, deps, info, 'catalog.product_create', 'product', row.id, {
    product_id: row.id, name: row.name, price_kopecks: Number(row.price_kopecks), is_alcohol: row.is_alcohol,
  });
  return { ...productView(row), modifier_group_ids: groupIds };
}

export async function updateProduct(db, deps, info) {
  const id = info.params.id;
  const b = info.body ?? {};
  const f = productFields(b, { partial: true });
  const { rows } = await db.query('select * from bl.products where id = $1 for update', [id]);
  const cur = rows[0];
  if (!cur) throw new PosError('not_found', 'product');
  const next = { ...cur, ...f };
  const changes = diff(cur, next, PRODUCT_FIELDS);
  let row = cur;
  if (Object.keys(changes).length > 0) {
    try {
      row = (await db.query(
        `update bl.products set category_id = $2, name = $3, description = $4, sku = $5, price_kopecks = $6, unit = $7, is_alcohol = $8,
                vat_code = $9, payment_subject = $10, stop_list = $11, track_stock = $12, photo = $13, sort = $14, active = $15, updated_at = $16
          where id = $1 returning *`,
        [id, next.category_id, next.name, next.description, next.sku, next.price_kopecks, next.unit, next.is_alcohol, next.vat_code,
          next.payment_subject, next.stop_list, next.track_stock, next.photo, next.sort, next.active, now(deps)],
      )).rows[0];
    } catch (err) {
      throw uniqueViolation(err);
    }
  }
  let groupIds;
  if ('modifier_group_ids' in b) {
    groupIds = b.modifier_group_ids;
    const before = (await db.query('select group_id from bl.product_modifier_groups where product_id = $1 and active order by sort', [id])).rows.map((r) => r.group_id);
    await linkGroups(db, cur.club_id, id, groupIds);
    if (JSON.stringify(before) !== JSON.stringify(groupIds)) changes.modifier_group_ids = [before, groupIds];
  } else {
    groupIds = (await db.query('select group_id from bl.product_modifier_groups where product_id = $1 and active order by sort', [id])).rows.map((r) => r.group_id);
  }
  if (Object.keys(changes).length > 0) {
    await audit(db, deps, info, 'catalog.product_update', 'product', id, { product_id: id, changes });
  }
  if (changes.stop_list || changes.active) await publishStopList(db, deps, row);
  return { ...productView(row), modifier_group_ids: groupIds };
}

/** SSE stop_list в club:{id} после коммита — экраны бара и кассы (бармен получает только bar и stop_list). */
async function publishStopList(db, deps, p) {
  await afterCommit(db, () => {
    try {
      deps.sse.publish(`club:${p.club_id}`, 'stop_list', { product_id: p.id, stop_list: p.stop_list, active: p.active });
    } catch (err) {
      deps.log?.warn?.('sse_publish_failed', { error: err.message });
    }
  });
}

/**
 * Стоп-лист товара (decisions №88): ресепшн и выше — только этот флаг, без цены и состава.
 * POST /api/catalog/products/{id}/stop-list {stop_list: boolean}; журнал catalog.stop_list.
 */
export async function setStopList(db, deps, info) {
  const id = info.params.id;
  const v = info.body?.stop_list;
  if (typeof v !== 'boolean') throw bad('stop_list');
  const { rows } = await db.query('select * from bl.products where id = $1 for update', [id]);
  const cur = rows[0];
  if (!cur) throw new PosError('not_found', 'product');
  if (cur.stop_list === v) return productView(cur);
  const row = (await db.query('update bl.products set stop_list = $2, updated_at = $3 where id = $1 returning *', [id, v, now(deps)])).rows[0];
  await audit(db, deps, info, 'catalog.stop_list', 'product', id, { product_id: id, name: cur.name, stop_list: v });
  await publishStopList(db, deps, row);
  return productView(row);
}

// Модификаторы ---------------------------------------------------------------------------------

function modifierFields(b, { partial }) {
  const out = {};
  const has = (k) => k in b;
  if (!partial || has('name')) {
    if (!str(b.name, 64)) throw bad('modifier.name');
    out.name = b.name;
  }
  if (has('price_delta_kopecks')) {
    if (!int(b.price_delta_kopecks, -10_000_000, 10_000_000)) throw bad('price_delta_kopecks');
    out.price_delta_kopecks = b.price_delta_kopecks;
  }
  if (has('stock_factor')) {
    if (!factorOk(b.stock_factor)) throw bad('stock_factor');
    out.stock_factor = String(b.stock_factor);
  }
  for (const k of ['is_default', 'active']) {
    if (has(k)) {
      if (typeof b[k] !== 'boolean') throw bad(k);
      out[k] = b[k];
    }
  }
  if (has('sort')) {
    if (!sortOk(b.sort)) throw bad('sort');
    out.sort = b.sort;
  }
  return out;
}

async function insertModifier(db, clubId, groupId, m, t) {
  const { rows } = await db.query(
    `insert into bl.modifiers (club_id, group_id, name, price_delta_kopecks, stock_factor, is_default, sort, active, created_at, updated_at)
     values ($1, $2, $3, $4, $5::numeric, $6, $7, $8, $9, $9) returning *, stock_factor::text as stock_factor`,
    [clubId, groupId, m.name, m.price_delta_kopecks ?? 0, m.stock_factor ?? '1', m.is_default ?? false, m.sort ?? 0, m.active ?? true, t],
  );
  return rows[0];
}

export async function createGroup(db, deps, info) {
  const b = info.body ?? {};
  const { name, min_select: minSel = 0, max_select: maxSel = 1, sort = 0, modifiers = [] } = b;
  if (!str(name, 100)) throw bad('name');
  if (!int(minSel, 0, 10) || !int(maxSel, 1, 10) || minSel > maxSel) throw bad('select');
  if (!sortOk(sort)) throw bad('sort');
  if (!Array.isArray(modifiers) || modifiers.length > 30) throw bad('modifiers');
  const mods = modifiers.map((m) => modifierFields(m ?? {}, { partial: false }));
  const t = now(deps);
  const g = (await db.query(
    `insert into bl.modifier_groups (club_id, name, min_select, max_select, sort, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $6) returning *`,
    [info.clubId, name, minSel, maxSel, sort, t],
  )).rows[0];
  const out = [];
  for (const [i, m] of mods.entries()) out.push(await insertModifier(db, info.clubId, g.id, { sort: i, ...m }, t));
  await audit(db, deps, info, 'catalog.modifier_group_create', 'modifier_group', g.id, {
    group_id: g.id, name, modifiers: out.map((m) => [m.name, Number(m.price_delta_kopecks)]).slice(0, 20),
  });
  return { ...groupView(g), modifiers: out.map(modifierView) };
}

export async function updateGroup(db, deps, info) {
  const id = info.params.id;
  const b = info.body ?? {};
  const { rows } = await db.query('select * from bl.modifier_groups where id = $1 for update', [id]);
  const cur = rows[0];
  if (!cur) throw new PosError('not_found', 'modifier_group');
  const next = { ...cur };
  if ('name' in b) {
    if (!str(b.name, 100)) throw bad('name');
    next.name = b.name;
  }
  if ('min_select' in b) {
    if (!int(b.min_select, 0, 10)) throw bad('min_select');
    next.min_select = b.min_select;
  }
  if ('max_select' in b) {
    if (!int(b.max_select, 1, 10)) throw bad('max_select');
    next.max_select = b.max_select;
  }
  if (next.min_select > next.max_select) throw bad('select');
  if ('sort' in b) {
    if (!sortOk(b.sort)) throw bad('sort');
    next.sort = b.sort;
  }
  if ('active' in b) {
    if (typeof b.active !== 'boolean') throw bad('active');
    next.active = b.active;
  }
  const changes = diff(cur, next, ['name', 'min_select', 'max_select', 'sort', 'active']);
  let row = cur;
  if (Object.keys(changes).length > 0) {
    row = (await db.query(
      'update bl.modifier_groups set name = $2, min_select = $3, max_select = $4, sort = $5, active = $6, updated_at = $7 where id = $1 returning *',
      [id, next.name, next.min_select, next.max_select, next.sort, next.active, now(deps)],
    )).rows[0];
    await audit(db, deps, info, 'catalog.modifier_group_update', 'modifier_group', id, { group_id: id, changes });
  }
  const mods = (await db.query('select *, stock_factor::text as stock_factor from bl.modifiers where group_id = $1 order by sort, name', [id])).rows;
  return { ...groupView(row), modifiers: mods.map(modifierView) };
}

export async function createModifier(db, deps, info) {
  const groupId = info.params.id;
  const { rows } = await db.query('select id from bl.modifier_groups where id = $1', [groupId]);
  if (!rows[0]) throw new PosError('not_found', 'modifier_group');
  const m = modifierFields(info.body ?? {}, { partial: false });
  const row = await insertModifier(db, info.clubId, groupId, m, now(deps));
  await audit(db, deps, info, 'catalog.modifier_create', 'modifier', row.id, {
    modifier_id: row.id, group_id: groupId, name: row.name, price_delta_kopecks: Number(row.price_delta_kopecks),
  });
  return modifierView(row);
}

export async function updateModifier(db, deps, info) {
  const id = info.params.id;
  const f = modifierFields(info.body ?? {}, { partial: true });
  const { rows } = await db.query('select *, stock_factor::text as stock_factor from bl.modifiers where id = $1 for update', [id]);
  const cur = rows[0];
  if (!cur) throw new PosError('not_found', 'modifier');
  const next = { ...cur, ...f };
  const changes = diff({ ...cur, stock_factor: Number(cur.stock_factor) }, { ...next, stock_factor: Number(next.stock_factor) },
    ['name', 'price_delta_kopecks', 'stock_factor', 'is_default', 'sort', 'active']);
  if (Object.keys(changes).length === 0) return modifierView(cur);
  const row = (await db.query(
    `update bl.modifiers set name = $2, price_delta_kopecks = $3, stock_factor = $4::numeric, is_default = $5, sort = $6, active = $7, updated_at = $8
      where id = $1 returning *, stock_factor::text as stock_factor`,
    [id, next.name, next.price_delta_kopecks, String(next.stock_factor), next.is_default, next.sort, next.active, now(deps)],
  )).rows[0];
  await audit(db, deps, info, 'catalog.modifier_update', 'modifier', id, { modifier_id: id, changes });
  return modifierView(row);
}

// Импорт CSV -------------------------------------------------------------------------------------

/**
 * POST /api/clubs/{club}/catalog/import {csv, dry_run?}: атомарно — при любой ошибке строки
 * ничего не записывается. Обновление — по артикулу (sku), иначе по категории и названию.
 * @returns {{ applied: boolean, created: number, updated: number, unchanged: number, categories_created: string[], errors: object[] }}
 */
export async function importCsv(db, deps, info) {
  const { csv, dry_run: dryRun = false } = info.body ?? {};
  if (typeof csv !== 'string' || csv.length === 0 || csv.length > 60_000) throw bad('csv');
  if (typeof dryRun !== 'boolean') throw bad('dry_run');
  const { items, errors } = csvToProducts(csv);
  return applyImport(db, deps, info, { items, errors, dryRun, source: 'csv' });
}

/**
 * Предпросмотр импорта (M5.1 №157): при dry_run ответ несёт rows — все строки плана
 * { line, action: create|update, category, name, price_kopecks, unit, is_alcohol, sku } (до 5 000).
 */

/**
 * POST …/catalog/import файлом (M5.1 №157): тело application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
 * (или text/csv) с ?dry_run=1, либо multipart/form-data с частью file (и полем dry_run).
 * .xlsx узнаётся по сигнатуре zip; иначе — CSV в UTF-8. Ответ — как у importCsv.
 */
export async function importFile(db, deps, info, rawBody) {
  let data = rawBody.buffer;
  let dryRunText = info.query?.dry_run;
  let declared = rawBody.mime;
  if (rawBody.mime === 'multipart/form-data') {
    let parts;
    try {
      parts = parseMultipart(rawBody.buffer, rawBody.contentType);
    } catch {
      throw bad('multipart');
    }
    const file = parts.find((p) => p.name === 'file') ?? parts.find((p) => p.filename);
    if (!file || file.data.length === 0) throw bad('file');
    data = file.data;
    declared = file.contentType ?? (/\.xlsx$/i.test(file.filename ?? '') ? XLSX_MIME : /\.csv$/i.test(file.filename ?? '') ? 'text/csv' : null);
    const dr = parts.find((p) => p.name === 'dry_run');
    if (dr) dryRunText = dr.data.toString('utf8').trim();
  }
  if (data.length > XLSX_MAX_FILE_BYTES) throw new PosError('bad_request', 'file too large', 413);
  let dryRun = false;
  if (dryRunText !== undefined) {
    if (['1', 'true'].includes(String(dryRunText))) dryRun = true;
    else if (!['0', 'false', ''].includes(String(dryRunText))) throw bad('dry_run');
  }
  let parsed;
  let source;
  if (looksLikeZip(data)) {
    source = 'xlsx';
    try {
      parsed = xlsxToProducts(data);
    } catch (err) {
      if (err instanceof XlsxError) throw new PosError('xlsx_invalid', err.code, 400);
      throw err;
    }
  } else {
    if (declared === XLSX_MIME) throw new PosError('xlsx_invalid', 'not zip', 400);
    source = 'csv';
    const text = data.toString('utf8');
    if (text.includes('\uFFFD')) throw bad('csv encoding');
    parsed = csvToProducts(text);
  }
  return applyImport(db, deps, info, { ...parsed, dryRun, source });
}

async function applyImport(db, deps, info, { items, errors, dryRun, source }) {
  const clubId = info.clubId;
  const cats = (await db.query('select id, name from bl.product_categories where club_id = $1 and active', [clubId])).rows;
  const catByName = new Map(cats.map((c) => [c.name.toLowerCase(), c.id]));
  const prods = (await db.query('select * from bl.products where club_id = $1', [clubId])).rows;
  const bySku = new Map(prods.filter((p) => p.sku).map((p) => [p.sku, p]));
  const byKey = new Map(prods.filter((p) => p.active).map((p) => [`${p.category_id ?? ''}|${p.name.toLowerCase()}`, p]));
  const newCats = [];
  const seen = new Set();
  const plan = [];
  for (const it of items) {
    const catKey = it.category ? it.category.toLowerCase() : null;
    if (catKey && !catByName.has(catKey) && !newCats.some((c) => c.toLowerCase() === catKey)) newCats.push(it.category);
    const catId = catKey ? catByName.get(catKey) ?? `new:${catKey}` : null;
    const key = it.sku ? `sku:${it.sku}` : `${catId ?? ''}|${it.name.toLowerCase()}`;
    if (seen.has(key)) {
      errors.push({ line: it.line, field: it.sku ? 'sku' : 'name', code: 'duplicate_row' });
      continue;
    }
    seen.add(key);
    const existing = it.sku ? bySku.get(it.sku) : catId && catId.startsWith('new:') ? null : byKey.get(`${catId ?? ''}|${it.name.toLowerCase()}`);
    plan.push({ it, catKey, existing });
  }
  errors.sort((a, b) => a.line - b.line);
  const created = plan.filter((p) => !p.existing).length;
  const rows = plan.map(({ it, existing }) => ({
    line: it.line,
    action: existing ? 'update' : 'create',
    category: it.category,
    name: it.name,
    price_kopecks: it.price_kopecks,
    unit: it.unit,
    is_alcohol: it.is_alcohol,
    sku: it.sku,
  }));
  const summary = { source, total: plan.length, created, updated: 0, unchanged: 0, categories_created: newCats, errors, ...(dryRun ? { rows } : {}) };
  if (errors.length > 0 || dryRun) {
    summary.updated = plan.length - created;
    return { applied: false, ...summary };
  }
  const t = now(deps);
  for (const name of newCats) {
    const row = (await db.query(
      'insert into bl.product_categories (club_id, name, sort, created_at, updated_at) values ($1, $2, 0, $3, $3) returning id',
      [clubId, name, t],
    )).rows[0];
    catByName.set(name.toLowerCase(), row.id);
  }
  let updated = 0;
  let unchanged = 0;
  let priceChanges = 0;
  for (const { it, catKey, existing } of plan) {
    const catId = catKey ? catByName.get(catKey) : null;
    const fields = {
      category_id: catId, name: it.name, description: it.description, sku: it.sku, price_kopecks: it.price_kopecks, unit: it.unit,
      is_alcohol: it.is_alcohol, vat_code: it.vat_code, payment_subject: it.payment_subject, stop_list: it.stop_list,
      track_stock: it.track_stock, photo: it.photo, sort: existing?.sort ?? 0, active: true,
    };
    try {
      if (existing) {
        const changes = diff(existing, { ...existing, ...fields }, PRODUCT_FIELDS);
        if (Object.keys(changes).length === 0) {
          unchanged += 1;
          continue;
        }
        if (changes.price_kopecks) priceChanges += 1;
        await db.query(
          `update bl.products set category_id = $2, name = $3, description = $4, sku = $5, price_kopecks = $6, unit = $7, is_alcohol = $8,
                  vat_code = $9, payment_subject = $10, stop_list = $11, track_stock = $12, photo = $13, active = true, updated_at = $14
            where id = $1`,
          [existing.id, fields.category_id, fields.name, fields.description, fields.sku, fields.price_kopecks, fields.unit, fields.is_alcohol,
            fields.vat_code, fields.payment_subject, fields.stop_list, fields.track_stock, fields.photo, t],
        );
        updated += 1;
      } else {
        await db.query(
          `insert into bl.products (club_id, category_id, name, description, sku, price_kopecks, unit, is_alcohol, vat_code, payment_subject,
                                    stop_list, track_stock, photo, sort, active, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0, true, $14, $14)`,
          [clubId, fields.category_id, fields.name, fields.description, fields.sku, fields.price_kopecks, fields.unit, fields.is_alcohol,
            fields.vat_code, fields.payment_subject, fields.stop_list, fields.track_stock, fields.photo, t],
        );
      }
    } catch (err) {
      throw uniqueViolation(err);
    }
  }
  await deps.audit.appendAudit(db, {
    action: 'catalog.import',
    objectType: 'club',
    objectId: clubId,
    data: { created, updated, unchanged, categories_created: newCats.length, price_changes: priceChanges, rows: items.length, source },
    actorType: 'user',
    actorId: info.userId,
  });
  return { applied: true, source, total: plan.length, created, updated, unchanged, categories_created: newCats, errors: [] };
}
