// Пункты чек-листа запуска, которые считает backend-B (контракт m5-1.md §3): зал, тарифы, наклейки.
//
//   resources.activeCount(db, clubId) → число столов в работе;
//   tariffs.coversWeek(db, clubId)    → { ok: boolean, gap?: { weekday, from, to, kind } } (или boolean);
//   qr.printedAt(db, clubId)          → Date | null — когда наклейки печатали в последний раз.
//
// Функции берутся из модуля backend-B server/setup/index.mjs (экспорт resources, tariffs, qr или
// одноимённые функции), если он есть. Пока его нет — запасные реализации ниже.
// TODO(backend-B): заменить запасные tariffs.coversWeek и qr.printedAt на функции server/setup —
// здесь ничего не менять, достаточно экспорта в server/setup/index.mjs.

import { TYPE_TO_KIND } from '../lib/resource-kinds.mjs';

/** Импорт модуля соседа; нет файла — null (как importOptional в server/http/app.mjs). */
async function importOptional(spec, base) {
  const url = new URL(spec, base);
  try {
    return await import(url.href);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(url.pathname)) return null;
    throw err;
  }
}

/** Столы в работе. */
async function activeCountFallback(db, clubId) {
  const { rows } = await db.query('select count(*)::int as n from bl.resources where club_id = $1 and active', [clubId]);
  return rows[0].n;
}

/**
 * TODO(backend-B): заглушка покрытия недели. Проверяет только, что у каждого типа столов в работе
 * есть хотя бы одно действующее правило тарифа на каждый день недели; дыры и пересечения внутри дня
 * проверяет tariffs.coversWeek backend-B (400 tariff_gap / tariff_overlap).
 */
async function coversWeekFallback(db, clubId) {
  const { rows } = await db.query(
    `select r.type, d.day
       from (select distinct type from bl.resources where club_id = $1 and active) r
       cross join generate_series(1, 7) as d(day)
      where not exists (
        select 1 from bl.tariff_rules t
         where t.club_id = $1 and t.active and d.day = any(t.days)
           and (t.resource_type = r.type or t.resource_id in (select x.id from bl.resources x where x.club_id = $1 and x.type = r.type)))
      order by d.day limit 1`,
    [clubId],
  );
  if (rows.length === 0) {
    const any = await db.query('select 1 from bl.tariff_rules where club_id = $1 and active limit 1', [clubId]);
    return { ok: any.rowCount > 0, stub: true };
  }
  return { ok: false, stub: true, gap: { weekday: rows[0].day, from: '00:00', to: '24:00', kind: TYPE_TO_KIND[rows[0].type] ?? String(rows[0].type).replace('billiard_', '') } };
}

/** TODO(backend-B): наклейки — resources.sticker_printed_at (1050), если столбец уже есть; иначе null. */
async function printedAtFallback(db, clubId) {
  const { rows: col } = await db.query(
    "select exists (select 1 from information_schema.columns where table_schema = 'bl' and table_name = 'resources' and column_name = 'sticker_printed_at') as ok",
  );
  if (!col[0].ok) return null;
  const { rows } = await db.query('select max(sticker_printed_at) as at from bl.resources where club_id = $1', [clubId]);
  return rows[0].at ?? null;
}

export const FALLBACK = Object.freeze({
  resources: { activeCount: activeCountFallback },
  tariffs: { coversWeek: coversWeekFallback },
  qr: { printedAt: printedAtFallback },
});

function pick(mod, group, fn) {
  const f = mod?.[group]?.[fn] ?? mod?.[fn];
  return typeof f === 'function' ? f : null;
}

/**
 * Функции соседей: overrides (тесты) → server/setup/index.mjs → запасные.
 * @param {{ resources?: object, tariffs?: object, qr?: object }} [overrides]
 */
export async function resolveNeighbors(overrides = {}, { spec = '../setup/index.mjs' } = {}) {
  let mod;
  try {
    mod = await importOptional(spec, import.meta.url);
  } catch {
    mod = null; // модуль соседа есть, но не загрузился — запасные функции
  }
  return {
    resources: { activeCount: overrides.resources?.activeCount ?? pick(mod, 'resources', 'activeCount') ?? activeCountFallback },
    tariffs: { coversWeek: overrides.tariffs?.coversWeek ?? pick(mod, 'tariffs', 'coversWeek') ?? coversWeekFallback },
    qr: { printedAt: overrides.qr?.printedAt ?? pick(mod, 'qr', 'printedAt') ?? printedAtFallback },
  };
}
