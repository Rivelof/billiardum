// Шаблоны тарифов и меню сети (M5.5 №191).
//
// Тарифы. Владелец сети ведёт шаблон правил в виде мастера тарифов (server/setup/tariffs.mjs:
// normalizeRules — те же поля и проверки, цена > 0 по №163). Шаблон записывается в правила
// каждого клуба (tariff_rules клуба, тем же replaceClubRules, что и мастер): движок тарифов не
// меняется, а время правил — местное, поэтому в каждом клубе правило действует по его поясу и
// рабочим суткам. Перед записью шаблон проверяется по неделе каждого клуба (его day_start_local и
// типы столов в работе): дыра или пересечение — 400 tariff_gap | tariff_overlap {club_id, …}.
// M5.8: правила корта (вид со слотом) — как в мастере: длина и цена слота. Шаблон заменяет все
// правила клуба, поэтому клубу с кортами в работе шаблон без правил корта не подходит —
// 400 tariff_gap {kind: 'padel_court', club_id} (корты не остаются без цены и не берут чужую).
//   * «жёсткий» (hard): шаблон применяется ко всем клубам, клуб тарифы не меняет (409 network_locked);
//   * «мягкий» (soft): клуб может сохранить свои тарифы — он «переопределил» шаблон, и изменения
//     шаблона его больше не меняют; POST /api/clubs/{club}/network/reset возвращает клуб к шаблону.
//
// Меню. Шаблон — список товаров (категория по имени, цена в копейках, алкоголь, НДС, предмет
// расчёта). В клубе товар шаблона — обычный товар (bl.products) со ссылкой network_product_id:
// касса, склад, стоп-лист и QR-меню работают как прежде; гостю алкоголь не показывается (№76).
// Товар клуба ищется по ссылке, иначе по артикулу, иначе по категории и названию; иначе создаётся.
// Пустые поля шаблона (описание, артикул, НДС, категория) не стирают значения клуба. Товар убран из
// шаблона — в клубе снимается с продажи. «Мягкий» шаблон: клуб может изменить товар шаблона — тот
// становится переопределённым (network_override); алкоголь шаблона клуб не снимает ни в каком режиме.
//
// Изменение шаблона, которое затрагивает клуб в боевом режиме (live или приостановлен после live,
// isLiveClub) — ручное действие: причина обязательна (400 reason_required), журнал manual.* в
// цепочке клуба и тревога manual_action владельцу (ctx.manual, инвариант 8). Клуб в test — журнал
// network.*_applied. Клуб, который шаблон не затронул (переопределил), — запись network.*_template.

import { plural } from '@billiardum/shared/format';
import { HttpError } from '../http/errors.mjs';
import { appendAudit } from '../lib/audit.mjs';
import { KIND_OF_TYPE } from '../setup/hall.mjs';
import { cleanReason, clubLive } from '../setup/mode.mjs';
import { checkClubRules, checkWeek, compactRules, getTariffs, normalizeRules, replaceClubRules } from '../setup/tariffs.mjs';
import { clubNetwork } from './lock.mjs';
import { enterNetworkClub, loadNetwork, networkAccess, networkClubs } from './service.mjs';

export const MAX_TEMPLATE_PRODUCTS = 300;
const UNITS = ['шт', 'порц', 'л', 'мл', 'кг', 'г'];
const SUBJECTS = ['commodity', 'excise', 'service', 'job', 'composite', 'another'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bad = (detail) => new HttpError(400, 'bad_request', { detail });
const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);
const dayStartOf = (settings) => (typeof settings?.day_start_local === 'string' && /^\d{2}:\d{2}$/.test(settings.day_start_local) ? settings.day_start_local : '06:00');
const ruleWord = (n) => `${n} ${plural(n, ['правило', 'правила', 'правил'])}`;

/**
 * Правило для хранения — в том виде, в каком его принимает мастер (normalizeRules): у вида со слотом
 * (корт, M5.8 №204) — длина и цена слота, у столов — цена часа, минимум и шаг. Повторный разбор
 * сохранённого правила даёт то же правило.
 */
export function storedRule(r) {
  const head = { kind: r.kind, days: r.days, from: r.from, to: r.to };
  if (r.slot_minutes) return { ...head, slot_minutes: r.slot_minutes, price_per_slot_kopecks: r.price_per_slot_kopecks };
  return { ...head, price_per_hour_kopecks: r.price_per_hour_kopecks, min_minutes: r.min_minutes, step_minutes: r.step_minutes };
}

/** Цена правила для столбца базы: слота — у вида со слотом, иначе часа. */
const rulePrice = (r) => (r.slot_minutes ? r.price_per_slot_kopecks : r.price_per_hour_kopecks);

/** Сериализованный блокировщик шаблона сети (один запрос за раз). */
async function lockTemplate(db, networkId, kind) {
  await db.query("select pg_advisory_xact_lock(hashtextextended('bl.network.' || $2 || ':' || $1, 0))", [networkId, kind]);
}

async function reasonFor(liveTouched, body) {
  return liveTouched ? cleanReason(body?.reason) : typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;
}

// Тарифы ----------------------------------------------------------------------------------------------

/** Правила шаблона (в любом контексте, где сеть видна: личный — владелец и управляющие, клуб сети). */
export async function loadTariffTemplate(db, networkId) {
  const { rows } = await db.query('select rule from bl.network_tariff_rules where network_id = $1 and active order by ord', [networkId]);
  return rows.map((r) => r.rule);
}

/** Проблема недели шаблона в клубе из контекста (для экрана сети), null — покрыто. */
async function clubProblem(db, clubId, rules, dayStart) {
  const { rows } = await db.query('select distinct type from bl.resources where club_id = $1 and active', [clubId]);
  const p = checkWeek(rules, { dayStart, activeKinds: rows.map((r) => KIND_OF_TYPE[r.type]).filter(Boolean) });
  return p ? { type: p.type, kind: p.kind, weekday: p.weekday, from: p.from, to: p.to } : null;
}

/** GET /api/networks/{id}/tariffs — владелец и управляющие сети. */
export async function getTariffTemplate(ctx, networkId) {
  const access = await networkAccess(ctx, networkId);
  const n = await loadNetwork(ctx.db, networkId);
  const stored = await loadTariffTemplate(ctx.db, networkId);
  const clubs = await networkClubs(ctx.db, networkId);
  const rules = stored.length ? normalizeRules(stored) : [];
  const out = [];
  for (const c of clubs) {
    await enterNetworkClub(ctx, c.club_id);
    const { live } = await clubLive(ctx.db, c.club_id, ctx);
    out.push({
      club_id: c.club_id,
      name: c.name,
      timezone: c.timezone,
      day_start_local: dayStartOf(c.settings),
      mode: c.mode,
      live,
      override: n.tariffs_template && c.tariffs_override,
      applied_version: c.tariffs_version,
      // Покрывает ли шаблон неделю этого клуба (его сутки и типы столов) — null, если покрывает.
      problem: rules.length ? await clubProblem(ctx.db, c.club_id, rules, dayStartOf(c.settings)) : null,
    });
  }
  await ctx.useClub(null);
  return {
    network_id: networkId,
    role: access,
    mode: n.tariffs_mode,
    template: n.tariffs_template,
    version: n.tariffs_version,
    rules: stored.map((r) => ({ ...r, start_local: r.from, end_local: r.to })),
    clubs: out,
  };
}

/**
 * Записать правила в клубы targets (проверка недели каждого клуба, затем запись).
 * reset — клуб сам вернулся к шаблону (POST …/network/reset).
 */
async function applyTariffs(ctx, { n, rules, version, targets, body, reset = false }) {
  const now = ctx.clock.now();
  // Проход 1: неделя каждого клуба и боевой режим (в live нужна причина).
  const live = new Map();
  for (const c of targets) {
    await enterNetworkClub(ctx, c.club_id, ['owner', ...(reset ? ['manager'] : [])]);
    await checkClubRules(ctx.db, c.club_id, rules, { club_id: c.club_id });
    live.set(c.club_id, (await clubLive(ctx.db, c.club_id, ctx)).live);
  }
  const reason = await reasonFor([...live.values()].some(Boolean), body);
  // Проход 2: запись и журнал в каждом клубе.
  for (const c of targets) {
    await enterNetworkClub(ctx, c.club_id, ['owner', ...(reset ? ['manager'] : [])]);
    const before = await replaceClubRules(ctx.db, c.club_id, rules, now);
    await ctx.db.query('update bl.network_clubs set tariffs_override = false, tariffs_version = $2, updated_at = $3 where club_id = $1 and active', [c.club_id, version, now]);
    const data = { network_id: n.id, version, mode: n.tariffs_mode, reset, before: compactRules(before.rules), before_resource_rules: before.resourceRules.length, after: compactRules(rules) };
    if (live.get(c.club_id)) {
      await ctx.manual({
        action: 'manual.network_tariff_change',
        reason,
        objectType: 'club',
        objectId: c.club_id,
        data,
        text: reset ? `Клуб вернулся к тарифу сети «${n.name}» (${ruleWord(rules.length)})` : `Изменён тариф сети «${n.name}» (${ruleWord(rules.length)})`,
      });
    } else {
      await appendAudit(ctx.db, { action: 'network.tariffs_applied', objectType: 'club', objectId: c.club_id, actorType: 'user', actorId: ctx.user.id, reason, data });
    }
  }
  return { applied: targets.length };
}

/**
 * PUT /api/networks/{id}/tariffs {rules, reason?} — владелец сети. Новая версия шаблона: «жёсткий» —
 * во все клубы сети, «мягкий» — в клубы без своих тарифов (и во все при первом шаблоне).
 */
export async function putTariffTemplate(ctx, networkId, body) {
  await networkAccess(ctx, networkId, { want: 'owner' });
  const rules = normalizeRules(body?.rules);
  await lockTemplate(ctx.db, networkId, 'tariffs');
  const n = await loadNetwork(ctx.db, networkId);
  const clubs = await networkClubs(ctx.db, networkId);
  const version = n.tariffs_version + 1;
  const targets = clubs.filter((c) => n.tariffs_mode === 'hard' || !n.tariffs_template || !c.tariffs_override);
  const skipped = clubs.filter((c) => !targets.includes(c));
  // Шаблон — в личном контексте владельца (RLS: только владелец сети пишет шаблон).
  await ctx.useClub(null);
  await ctx.db.query('update bl.network_tariff_rules set active = false where network_id = $1 and active', [networkId]);
  for (const [i, r] of rules.entries()) {
    await ctx.db.query(
      'insert into bl.network_tariff_rules (network_id, version, ord, rule, price_per_hour, created_by) values ($1, $2, $3, $4::jsonb, $5, $6)',
      [networkId, version, i, JSON.stringify(storedRule(r)), rulePrice(r), ctx.user.id],
    );
  }
  await ctx.db.query('update bl.networks set tariffs_template = true, tariffs_version = $2, updated_at = $3 where id = $1', [networkId, version, ctx.clock.now()]);
  await applyTariffs(ctx, { n, rules, version, targets, body });
  for (const c of skipped) {
    await enterNetworkClub(ctx, c.club_id, ['owner']);
    await appendAudit(ctx.db, {
      action: 'network.tariffs_template',
      objectType: 'network',
      objectId: networkId,
      actorType: 'user',
      actorId: ctx.user.id,
      data: { network_id: networkId, version, applied: false, override: true },
    });
  }
  await ctx.useClub(null);
  ctx.log?.info?.('network_tariffs_template', { network_id: networkId, version, applied: targets.length, skipped: skipped.length });
  return getTariffTemplate(ctx, networkId);
}

/** DELETE /api/networks/{id}/tariffs — владелец: шаблона больше нет, тарифы клубов остаются как есть. */
export async function deleteTariffTemplate(ctx, networkId) {
  await networkAccess(ctx, networkId, { want: 'owner' });
  await lockTemplate(ctx.db, networkId, 'tariffs');
  const n = await loadNetwork(ctx.db, networkId);
  if (!n.tariffs_template) return getTariffTemplate(ctx, networkId);
  const now = ctx.clock.now();
  await ctx.db.query('update bl.network_tariff_rules set active = false where network_id = $1 and active', [networkId]);
  await ctx.db.query('update bl.networks set tariffs_template = false, updated_at = $2 where id = $1', [networkId, now]);
  for (const c of await networkClubs(ctx.db, networkId)) {
    await enterNetworkClub(ctx, c.club_id, ['owner']);
    await ctx.db.query('update bl.network_clubs set tariffs_override = false, updated_at = $2 where club_id = $1 and active', [c.club_id, now]);
    await appendAudit(ctx.db, { action: 'network.tariffs_template_removed', objectType: 'network', objectId: networkId, actorType: 'user', actorId: ctx.user.id, data: { network_id: networkId } });
  }
  await ctx.useClub(null);
  return getTariffTemplate(ctx, networkId);
}

/** Клубы с переопределёнными тарифами — к шаблону (сеть стала «жёсткой»). */
export async function enforceTariffs(ctx, networkId, body) {
  const n = await loadNetwork(ctx.db, networkId);
  const stored = await loadTariffTemplate(ctx.db, networkId);
  if (!n.tariffs_template || stored.length === 0) return { applied: 0 };
  const targets = (await networkClubs(ctx.db, networkId)).filter((c) => c.tariffs_override);
  const out = await applyTariffs(ctx, { n, rules: normalizeRules(stored), version: n.tariffs_version, targets, body });
  await ctx.useClub(null);
  return out;
}

/** POST /api/clubs/{club}/network/reset {scope: 'tariffs'} — клуб (владелец, управляющий) к шаблону сети. */
async function resetClubTariffs(ctx, clubId, body) {
  const net = await clubNetwork(ctx.db, clubId);
  if (!net?.tariffs_template) throw new HttpError(404, 'not_found', { detail: 'network tariffs template' });
  const stored = await loadTariffTemplate(ctx.db, net.network_id);
  const n = { id: net.network_id, name: net.name, tariffs_mode: net.tariffs_mode };
  await applyTariffs(ctx, { n, rules: normalizeRules(stored), version: net.network_tariffs_version, targets: [{ club_id: clubId }], body, reset: true });
  return getTariffs(ctx.db, { clubId });
}

// Меню ------------------------------------------------------------------------------------------------

const str = (v, max) => typeof v === 'string' && v.trim() === v && v.length >= 1 && v.length <= max;

/** Товары шаблона из тела запроса → нормализованные; ошибка — 400 bad_request. */
export function normalizeProducts(input) {
  if (!Array.isArray(input)) throw bad('products');
  if (input.length > MAX_TEMPLATE_PRODUCTS) throw bad('products: too many');
  const seen = new Set();
  return input.map((p, i) => {
    const at = `products[${i}]`;
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw bad(at);
    if (p.id !== undefined && p.id !== null && !(typeof p.id === 'string' && UUID.test(p.id))) throw bad(`${at}.id`);
    if (!str(p.name, 128)) throw bad(`${at}.name`);
    const category = p.category === undefined || p.category === null || p.category === '' ? null : p.category;
    if (category !== null && !str(category, 100)) throw bad(`${at}.category`);
    // Цена — целые копейки строго больше нуля (как у товара клуба).
    if (!Number.isSafeInteger(p.price_kopecks) || p.price_kopecks < 1 || p.price_kopecks > 100_000_000) throw bad(`${at}.price_kopecks`);
    const unit = p.unit ?? 'шт';
    if (!UNITS.includes(unit)) throw bad(`${at}.unit`);
    const isAlcohol = p.is_alcohol ?? false;
    if (typeof isAlcohol !== 'boolean') throw bad(`${at}.is_alcohol`);
    const vat = p.vat_code ?? null;
    if (vat !== null && !(Number.isInteger(vat) && vat >= 1 && vat <= 12)) throw bad(`${at}.vat_code`);
    const subject = p.payment_subject ?? (isAlcohol ? 'excise' : 'commodity');
    if (!SUBJECTS.includes(subject)) throw bad(`${at}.payment_subject`);
    const sku = p.sku ?? null;
    if (sku !== null && !(typeof sku === 'string' && /^[0-9A-Za-z._/-]{1,64}$/.test(sku))) throw bad(`${at}.sku`);
    const description = p.description === undefined || p.description === '' ? null : p.description;
    if (description !== null && !(typeof description === 'string' && description.length <= 500)) throw bad(`${at}.description`);
    const sort = p.sort ?? 0;
    if (!Number.isSafeInteger(sort) || sort < -1_000_000 || sort > 1_000_000) throw bad(`${at}.sort`);
    const active = p.active ?? true;
    if (typeof active !== 'boolean') throw bad(`${at}.active`);
    const key = `${(category ?? '').toLowerCase()}|${p.name.toLowerCase()}`;
    if (active) {
      if (seen.has(key) || (sku && seen.has(`sku:${sku}`))) throw bad(`${at}: duplicate`);
      seen.add(key);
      if (sku) seen.add(`sku:${sku}`);
    }
    return { id: p.id ?? null, category, name: p.name, sku, price_kopecks: p.price_kopecks, unit, is_alcohol: isAlcohol, vat_code: vat, payment_subject: subject, description, sort, active, key };
  });
}

function templateProductJson(r) {
  return {
    id: r.id,
    category: r.category,
    name: r.name,
    sku: r.sku,
    price_kopecks: Number(r.price_kopecks),
    unit: r.unit,
    is_alcohol: r.is_alcohol,
    vat_code: r.vat_code,
    payment_subject: r.payment_subject,
    description: r.description,
    sort: r.sort,
    active: r.active,
    updated_at: iso(r.updated_at),
  };
}

/** Все товары шаблона сети (и снятые) — для применения; в контексте, где сеть видна. */
async function loadMenuTemplate(db, networkId) {
  return (await db.query('select * from bl.network_products where network_id = $1 order by sort, lower(name), id', [networkId])).rows;
}

/**
 * Применить шаблон меню к клубу из контекста. force — переопределённые клубом товары тоже
 * возвращаются к шаблону («жёсткий» шаблон, сброс клуба).
 * @returns {Promise<{ created: number, updated: number, deactivated: number, price_changes: number, skipped_override: number }>}
 */
export async function applyMenuToClub(db, clubId, template, { force, now }) {
  const stats = { created: 0, updated: 0, deactivated: 0, price_changes: 0, skipped_override: 0 };
  const ids = new Set(template.map((t) => t.id));
  const cats = (await db.query('select id, name from bl.product_categories where club_id = $1 and active', [clubId])).rows;
  const catByName = new Map(cats.map((c) => [c.name.toLowerCase(), c.id]));
  const prods = (await db.query('select * from bl.products where club_id = $1 order by created_at, id for update', [clubId])).rows;
  const linked = new Map(prods.filter((p) => p.network_product_id && ids.has(p.network_product_id)).map((p) => [p.network_product_id, p]));
  const free = prods.filter((p) => !p.network_product_id || !ids.has(p.network_product_id));
  const categoryId = async (name) => {
    if (name === null) return undefined;
    const k = name.toLowerCase();
    if (!catByName.has(k)) {
      const { rows } = await db.query('insert into bl.product_categories (club_id, name, sort, created_at, updated_at) values ($1, $2, 0, $3, $3) returning id', [clubId, name, now]);
      catByName.set(k, rows[0].id);
    }
    return catByName.get(k);
  };
  for (const t of template) {
    let cur = linked.get(t.id) ?? null;
    if (!cur && t.active) {
      const catId = t.category ? catByName.get(t.category.toLowerCase()) ?? null : null;
      const i = free.findIndex((p) => (t.sku && p.sku === t.sku) || (p.active && (p.category_id ?? null) === catId && p.name.toLowerCase() === t.name.toLowerCase() && (t.category === null || catId !== null)));
      if (i >= 0) {
        cur = free[i];
        free.splice(i, 1);
      }
    }
    if (!cur) {
      if (!t.active) continue;
      const catId = (await categoryId(t.category)) ?? null;
      try {
        await db.query(
          `insert into bl.products (club_id, category_id, name, description, sku, price_kopecks, unit, is_alcohol, vat_code, payment_subject,
                                    stop_list, track_stock, photo, sort, active, created_at, updated_at, network_product_id, network_override)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, true, null, $11, true, $12, $12, $13, false)`,
          [clubId, catId, t.name, t.description, t.sku, t.price_kopecks, t.unit, t.is_alcohol, t.vat_code, t.payment_subject, t.sort, now, t.id],
        );
      } catch (err) {
        if (err?.code === '23505') throw new HttpError(409, 'duplicate', { detail: `club ${clubId}: ${err.constraint}`, data: { club_id: clubId } });
        throw err;
      }
      stats.created += 1;
      continue;
    }
    const keep = cur.network_override && !force && cur.network_product_id === t.id;
    const next = { ...cur };
    if (keep) {
      // Переопределённый товар шаблон не меняет — кроме признака алкоголя (№76).
      stats.skipped_override += 1;
      if (!(t.is_alcohol && !cur.is_alcohol)) continue;
      next.is_alcohol = true;
    } else {
      const catId = await categoryId(t.category);
      if (catId !== undefined) next.category_id = catId;
      next.name = t.name;
      if (t.description !== null) next.description = t.description;
      if (t.sku !== null) next.sku = t.sku;
      next.price_kopecks = t.price_kopecks;
      next.unit = t.unit;
      next.is_alcohol = t.is_alcohol;
      if (t.vat_code !== null) next.vat_code = t.vat_code;
      next.payment_subject = t.payment_subject;
      next.active = t.active;
      next.network_product_id = t.id;
      next.network_override = false;
    }
    const fields = ['category_id', 'name', 'description', 'sku', 'price_kopecks', 'unit', 'is_alcohol', 'vat_code', 'payment_subject', 'active', 'network_product_id', 'network_override'];
    const changed = fields.filter((f) => String(cur[f] ?? '') !== String(next[f] ?? ''));
    if (changed.length === 0) continue;
    try {
      await db.query(
        `update bl.products set category_id = $2, name = $3, description = $4, sku = $5, price_kopecks = $6, unit = $7, is_alcohol = $8, vat_code = $9,
                payment_subject = $10, active = $11, network_product_id = $12, network_override = $13, updated_at = $14
          where id = $1`,
        [cur.id, next.category_id, next.name, next.description, next.sku, next.price_kopecks, next.unit, next.is_alcohol, next.vat_code, next.payment_subject,
          next.active, next.network_product_id, next.network_override, now],
      );
    } catch (err) {
      if (err?.code === '23505') throw new HttpError(409, 'duplicate', { detail: `club ${clubId}: ${err.constraint}`, data: { club_id: clubId } });
      throw err;
    }
    if (changed.includes('price_kopecks')) stats.price_changes += 1;
    if (cur.active && !next.active) stats.deactivated += 1;
    else stats.updated += 1;
  }
  return stats;
}

const touched = (s) => s.created + s.updated + s.deactivated > 0;

/** Применить шаблон меню к клубам targets; журнал в каждом. */
async function applyMenu(ctx, { n, template, version, targets, body, force, reset = false }) {
  const now = ctx.clock.now();
  const results = [];
  for (const c of targets) {
    await enterNetworkClub(ctx, c.club_id, ['owner', ...(reset ? ['manager'] : [])]);
    const stats = await applyMenuToClub(ctx.db, c.club_id, template, { force: force || n.menu_mode === 'hard', now });
    await ctx.db.query('update bl.network_clubs set menu_version = $2, updated_at = $3 where club_id = $1 and active', [c.club_id, version, now]);
    const { live } = await clubLive(ctx.db, c.club_id, ctx);
    results.push({ club_id: c.club_id, live, stats });
  }
  const reason = await reasonFor(results.some((r) => r.live && touched(r.stats)), body);
  for (const r of results) {
    await enterNetworkClub(ctx, r.club_id, ['owner', ...(reset ? ['manager'] : [])]);
    const data = { network_id: n.id, version, mode: n.menu_mode, reset, ...r.stats };
    if (r.live && touched(r.stats)) {
      await ctx.manual({
        action: 'manual.network_menu_change',
        reason,
        objectType: 'club',
        objectId: r.club_id,
        data,
        text: reset
          ? `Меню клуба возвращено к меню сети «${n.name}»`
          : `Изменено меню сети «${n.name}»: новых ${r.stats.created}, изменено ${r.stats.updated}, снято ${r.stats.deactivated}, цен ${r.stats.price_changes}`,
      });
    } else {
      await appendAudit(ctx.db, { action: touched(r.stats) ? 'network.menu_applied' : 'network.menu_template', objectType: 'club', objectId: r.club_id, actorType: 'user', actorId: ctx.user.id, reason, data });
    }
  }
  return results;
}

/** GET /api/networks/{id}/menu — владелец и управляющие. */
export async function getMenuTemplate(ctx, networkId) {
  const access = await networkAccess(ctx, networkId);
  const n = await loadNetwork(ctx.db, networkId);
  const rows = (await loadMenuTemplate(ctx.db, networkId)).filter((r) => r.active);
  const clubs = [];
  for (const c of await networkClubs(ctx.db, networkId)) {
    await enterNetworkClub(ctx, c.club_id);
    const o = await ctx.db.query('select count(*)::int as n from bl.products where club_id = $1 and network_product_id is not null and network_override', [c.club_id]);
    clubs.push({ club_id: c.club_id, name: c.name, mode: c.mode, applied_version: c.menu_version, overrides: n.menu_template ? o.rows[0].n : 0 });
  }
  await ctx.useClub(null);
  return { network_id: networkId, role: access, mode: n.menu_mode, template: n.menu_template, version: n.menu_version, products: rows.map(templateProductJson), clubs };
}

/**
 * PUT /api/networks/{id}/menu {products, reason?} — владелец: весь шаблон целиком. Товар с id — тот же
 * товар шаблона; без id — ищется по артикулу, затем по категории и названию; не попавший в список — снят.
 */
export async function putMenuTemplate(ctx, networkId, body) {
  await networkAccess(ctx, networkId, { want: 'owner' });
  const items = normalizeProducts(body?.products);
  await lockTemplate(ctx.db, networkId, 'menu');
  const n = await loadNetwork(ctx.db, networkId);
  const now = ctx.clock.now();
  const existing = (await loadMenuTemplate(ctx.db, networkId)).filter((r) => r.active);
  const byId = new Map(existing.map((r) => [r.id, r]));
  const bySku = new Map(existing.filter((r) => r.sku).map((r) => [r.sku, r]));
  const byKey = new Map(existing.map((r) => [`${(r.category ?? '').toLowerCase()}|${r.name.toLowerCase()}`, r]));
  const used = new Set();
  const writes = [];
  for (const it of items) {
    let cur;
    if (it.id) {
      cur = byId.get(it.id) ?? null;
      if (!cur) throw bad('products: unknown id');
    } else {
      cur = (it.sku && bySku.get(it.sku)) || byKey.get(it.key) || null;
    }
    if (cur && used.has(cur.id)) throw bad('products: duplicate');
    if (cur) used.add(cur.id);
    writes.push({ it, cur });
  }
  // Сначала снять лишнее (уникальность названия и артикула — среди активных).
  for (const r of existing) {
    if (!used.has(r.id)) await ctx.db.query('update bl.network_products set active = false, updated_by = $2, updated_at = $3 where id = $1', [r.id, ctx.user.id, now]);
  }
  for (const { cur } of writes) {
    if (cur) await ctx.db.query('update bl.network_products set active = false, updated_by = $2, updated_at = $3 where id = $1', [cur.id, ctx.user.id, now]);
  }
  for (const { it, cur } of writes) {
    if (cur) {
      await ctx.db.query(
        `update bl.network_products set category = $2, name = $3, description = $4, sku = $5, price_kopecks = $6, unit = $7, is_alcohol = $8, vat_code = $9,
                payment_subject = $10, sort = $11, active = $12, updated_by = $13, updated_at = $14 where id = $1`,
        [cur.id, it.category, it.name, it.description, it.sku, it.price_kopecks, it.unit, it.is_alcohol, it.vat_code, it.payment_subject, it.sort, it.active, ctx.user.id, now],
      );
    } else {
      await ctx.db.query(
        `insert into bl.network_products (network_id, category, name, description, sku, price_kopecks, unit, is_alcohol, vat_code, payment_subject, sort, active, updated_by, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)`,
        [networkId, it.category, it.name, it.description, it.sku, it.price_kopecks, it.unit, it.is_alcohol, it.vat_code, it.payment_subject, it.sort, it.active, ctx.user.id, now],
      );
    }
  }
  const version = n.menu_version + 1;
  await ctx.db.query('update bl.networks set menu_template = true, menu_version = $2, updated_at = $3 where id = $1', [networkId, version, now]);
  const template = await loadMenuTemplate(ctx.db, networkId);
  const clubs = await networkClubs(ctx.db, networkId);
  await applyMenu(ctx, { n, template, version, targets: clubs, body, force: false });
  await ctx.useClub(null);
  ctx.log?.info?.('network_menu_template', { network_id: networkId, version, products: items.length, clubs: clubs.length });
  return getMenuTemplate(ctx, networkId);
}

/** DELETE /api/networks/{id}/menu — владелец: шаблона нет, товары клубов остаются своими товарами клуба. */
export async function deleteMenuTemplate(ctx, networkId) {
  await networkAccess(ctx, networkId, { want: 'owner' });
  await lockTemplate(ctx.db, networkId, 'menu');
  const n = await loadNetwork(ctx.db, networkId);
  if (!n.menu_template) return getMenuTemplate(ctx, networkId);
  const now = ctx.clock.now();
  await ctx.db.query('update bl.networks set menu_template = false, updated_at = $2 where id = $1', [networkId, now]);
  const ids = (await loadMenuTemplate(ctx.db, networkId)).map((r) => r.id);
  for (const c of await networkClubs(ctx.db, networkId)) {
    await enterNetworkClub(ctx, c.club_id, ['owner']);
    await ctx.db.query('update bl.products set network_product_id = null, network_override = false, updated_at = $3 where club_id = $1 and network_product_id = any($2::uuid[])', [c.club_id, ids, now]);
    await appendAudit(ctx.db, { action: 'network.menu_template_removed', objectType: 'network', objectId: networkId, actorType: 'user', actorId: ctx.user.id, data: { network_id: networkId } });
  }
  await ctx.useClub(null);
  return getMenuTemplate(ctx, networkId);
}

/** Переопределённые товары клубов — к шаблону (сеть стала «жёсткой»). */
export async function enforceMenu(ctx, networkId, body) {
  const n = await loadNetwork(ctx.db, networkId);
  if (!n.menu_template) return [];
  const template = await loadMenuTemplate(ctx.db, networkId);
  const out = await applyMenu(ctx, { n, template, version: n.menu_version, targets: await networkClubs(ctx.db, networkId), body, force: true });
  await ctx.useClub(null);
  return out;
}

/** PATCH сети в «жёсткий»: шаблоны — во все клубы (service.updateNetwork). */
export async function enforceTemplates(ctx, networkId, { tariffs, menu, reason }) {
  const body = { reason };
  if (tariffs) await enforceTariffs(ctx, networkId, body);
  if (menu) await enforceMenu(ctx, networkId, body);
}

async function resetClubMenu(ctx, clubId, body) {
  const net = await clubNetwork(ctx.db, clubId);
  if (!net?.menu_template) throw new HttpError(404, 'not_found', { detail: 'network menu template' });
  const template = await loadMenuTemplate(ctx.db, net.network_id);
  const n = { id: net.network_id, name: net.name, menu_mode: net.menu_mode };
  const [r] = await applyMenu(ctx, { n, template, version: net.network_menu_version, targets: [{ club_id: clubId }], body, force: true, reset: true });
  return { scope: 'menu', ...r.stats };
}

/** POST /api/clubs/{club}/network/reset {scope: 'tariffs'|'menu', reason?} — вернуть клуб к шаблону сети. */
export async function resetClub(ctx, clubId, body) {
  const scope = body?.scope;
  if (scope === 'tariffs') return { scope, tariffs: await resetClubTariffs(ctx, clubId, body) };
  if (scope === 'menu') return resetClubMenu(ctx, clubId, body);
  throw bad('scope');
}
