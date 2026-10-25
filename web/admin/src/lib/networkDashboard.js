/**
 * M5.5 вкладка «Сеть» дашборда (№193, server/networks/README.md «Вкладка «Сеть»»): сравнение клубов по плиткам,
 * рейтинг по загрузке и выручке со стола, клубы в тесте — вне рейтинга. Без JSX и DOM — тестируется в Node.
 */

import { plural } from '@billiardum/shared/format';
import { formatValue, TILES, deltaOf } from './dashboard.js';

/** Столбцы сравнения клубов — плитки ответа (server/networks/compare.mjs NETWORK_TILES). */
export const COMPARE_TILES = Object.freeze(['revenue', 'utilization', 'revenue_per_table', 'revenue_per_table_day', 'games', 'play_hours', 'avg_check_game', 'avg_check_bar', 'avg_hour_price', 'guests', 'no_staff_share']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);

function tileMap(tiles, compare) {
  const out = {};
  for (const t of arr(tiles)) {
    const def = TILES[t?.id];
    if (!def) continue;
    out[t.id] = {
      value: num(t.value),
      text: formatValue(def.unit, t.value, def),
      delta: compare ? deltaOf({ value: t.value, prev: t.prev, unit: def.unit, good: def.good }) : null,
    };
  }
  return out;
}

/**
 * Ответ GET /api/networks/{id}/dashboard → вид вкладки: клубы в рейтинге (по месту загрузки), клубы в тесте отдельно,
 * итог сети, два рейтинга словами.
 */
export function networkCompareView(res, { compare = true } = {}) {
  const clubs = arr(res?.clubs).map((c) => ({
    id: c.club_id,
    name: c.name ?? 'Клуб',
    mode: c.mode ?? null,
    timezone: c.timezone ?? null,
    dayStart: c.day_start_local ?? '06:00',
    today: c.today ?? null,
    includesToday: Boolean(c.includes_today),
    ranked: c.ranked === true,
    tablesAvg: num(c.tables_avg),
    tiles: tileMap(c.tiles, compare),
    placeUtil: num(c.place_utilization),
    placeRevenue: num(c.place_revenue_per_table_day),
  }));
  const byPlace = (a, b) => (a.placeUtil ?? 1e9) - (b.placeUtil ?? 1e9) || a.name.localeCompare(b.name, 'ru');
  const rankList = (list, unit) =>
    arr(list).map((x) => ({ id: x.club_id, name: x.name ?? 'Клуб', place: num(x.place), text: formatValue(unit, x.value, { round: unit === 'kopecks' }) }));
  const zones = new Set(clubs.map((c) => `${c.timezone}|${c.dayStart}`));
  return {
    network: res?.network ?? null,
    period: res?.period ?? null,
    compare: res?.compare_period ?? null,
    ranked: clubs.filter((c) => c.ranked).sort(byPlace),
    outside: clubs.filter((c) => !c.ranked),
    totals: res?.totals ? { tablesAvg: num(res.totals.tables_avg), tiles: tileMap(res.totals.tiles, compare) } : null,
    ranking: { utilization: rankList(res?.ranking?.utilization, 'pct'), revenue: rankList(res?.ranking?.revenue_per_table_day, 'kopecks') },
    missing: arr(res?.missing_days),
    mixedDays: zones.size > 1,
    empty: clubs.length === 0,
  };
}

/** Место словами для диктора: «1 место из 3». */
export const placeWords = (place, of) => (place ? `${place} место${of ? ` из ${of}` : ''}` : 'вне рейтинга');

/**
 * Вкладки дашборда: управляющему сети — без «Денег» (№192); «Сеть» — если у человека есть сеть (№193).
 * @param {Array<{ value: string, label: string }>} tabs TABS из lib/dashboard.js
 */
export function dashboardTabs(tabs, { networkManager = false, hasNetwork = false } = {}) {
  const list = tabs.filter((t) => !(networkManager && t.value === 'money'));
  return hasNetwork ? [...list, { value: 'network', label: 'Сеть' }] : list;
}

const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
/** Среднее число столов: 6 → «6 столов», 1,5 → «1,5 стола» (дробное — родительный падеж единственного числа). */
export function tablesAvgWords(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const forms = ['стол', 'стола', 'столов'];
  return `${nf1.format(n)} ${Number.isInteger(n) ? plural(n, forms) : forms[1]}`;
}
/** «Цифры за 3 дня»: дни без пересчёта. */
export const daysWords = (n) => `${n} ${plural(n, ['день', 'дня', 'дней'])}`;
