// Вкладка «Сеть» дашборда (M5.5 №193): клубы сети по ключевым плиткам и рейтинг по загрузке и
// выручке со стола.
//
// Числа — те же, что у дашборда клуба (server/dashboard/service.mjs: collect и metrics над
// stats_daily / stats_hourly и текущими сутками на лету): сутки и часы — по местному времени и
// рабочим суткам каждого клуба (№167), записи is_test не входят никуда. Денег по способам оплаты
// во вкладке нет (управляющий сети их не видит, №192). Клубы в тестовом режиме показываются, но в
// рейтинг не входят (у них нет боевых денег и игр).
//
// Видят владелец сети и управляющие сети; в каждый клуб сервер входит ctx.useClub (RLS по club_id).

import { isLiveClub } from '../lib/club-mode.mjs';
import { collect, metrics, parseQuery } from '../dashboard/service.mjs';
import { loadClub } from '../dashboard/store.mjs';
import { workingDayOf } from '../dashboard/time.mjs';
import { enterNetworkClub, loadNetwork, networkAccess, networkClubs } from './service.mjs';

/** Плитки клуба и итога сети (без денег по способам оплаты). */
export const NETWORK_TILES = Object.freeze([
  ['revenue', 'kopecks'],
  ['games', 'count'],
  ['play_hours', 'hours'],
  ['utilization', 'percent'],
  ['avg_check_game', 'kopecks'],
  ['avg_check_bar', 'kopecks'],
  ['revenue_per_table_day', 'kopecks'],
  ['revenue_per_table', 'kopecks'],
  ['avg_hour_price', 'kopecks'],
  ['guests', 'count'],
  ['no_staff_share', 'percent'],
]);

const r1 = (x) => Math.round(x * 10) / 10;

function deltaPct(value, prev) {
  if (value === null || prev === null || prev === undefined) return null;
  if (prev === 0) return value === 0 ? 0 : null;
  return r1(((value - prev) / Math.abs(prev)) * 100);
}

/** Числа клуба (или итога сети) по свёртке периода. */
function numbers(agg, guests, days) {
  const m = metrics(agg);
  const avgTables = days > 0 ? agg.t.table_days / days : 0;
  return {
    revenue: m.revenue,
    games: m.games,
    play_hours: m.play_hours,
    utilization: m.utilization,
    avg_check_game: m.avg_check_game,
    avg_check_bar: m.avg_check_bar,
    revenue_per_table_day: m.revenue_per_table_day,
    // Выручка со стола за период: выручка / среднее число столов в работе.
    revenue_per_table: avgTables > 0 ? Math.round(m.revenue / avgTables) : null,
    avg_hour_price: m.avg_hour_price,
    guests: guests.total,
    no_staff_share: m.no_staff_share,
    tables_avg: r1(avgTables),
  };
}

function tiles(cur, prev) {
  return NETWORK_TILES.map(([id, unit]) => ({ id, value: cur[id], unit, prev: prev ? prev[id] : null, delta_pct: prev ? deltaPct(cur[id], prev[id]) : null }));
}

/** Места рейтинга: по убыванию; null — в конце без места; равные — одно место. */
function rank(rows, key) {
  const ranked = rows.filter((r) => r.ranked && r.numbers[key] !== null).sort((a, b) => b.numbers[key] - a.numbers[key]);
  const out = [];
  let place = 0;
  let last = null;
  ranked.forEach((r, i) => {
    if (r.numbers[key] !== last) {
      place = i + 1;
      last = r.numbers[key];
    }
    out.push({ club_id: r.club.id, name: r.club.name, value: r.numbers[key], place });
  });
  return out;
}

/**
 * GET /api/networks/{id}/dashboard?from&to&compare — владелец и управляющие сети.
 * Период — рабочие сутки каждого клуба (даты одинаковые, границы суток — по поясу клуба).
 */
export async function networkDashboard(ctx, networkId, query) {
  const access = await networkAccess(ctx, networkId);
  const n = await loadNetwork(ctx.db, networkId);
  const list = await networkClubs(ctx.db, networkId);
  const now = ctx.clock.now();
  const clubs = [];
  for (const c of list) {
    await enterNetworkClub(ctx, c.club_id);
    const club = await loadClub(ctx.db, c.club_id);
    if (club) clubs.push(club);
  }
  if (clubs.length === 0) {
    await ctx.useClub(null);
    const today = workingDayOf(now, 'Europe/Moscow', '06:00');
    const q = parseQuery({ ...query, tab: 'summary', kind: undefined }, { today });
    return { network: { id: n.id, name: n.name }, role: access, period: { from: q.from, to: q.to, days: q.days }, compare_period: null, clubs: [], totals: null, ranking: { utilization: [], revenue_per_table: [] }, missing_days: [], generated_at: now.toISOString() };
  }
  const today = workingDayOf(now, clubs[0].timezone, clubs[0].day_start_local);
  const q = parseQuery({ ...query, tab: 'summary', kind: undefined }, { today });
  const enter = async (club) => {
    await enterNetworkClub(ctx, club.id);
  };
  const cur = await collect(ctx.db, clubs, { fromDay: q.from, toDay: q.to, now, kind: null, enter, wantHourly: false, light: true });
  const prev = q.compare ? await collect(ctx.db, clubs, { fromDay: q.prevFrom, toDay: q.prevTo, now, kind: null, enter, wantHourly: false, light: true }) : null;
  await ctx.useClub(null);
  const prevBy = new Map((prev?.perClub ?? []).map((p) => [p.club.id, p]));
  const rows = cur.perClub.map(({ club, agg, guests, today: clubToday }) => {
    const p = prevBy.get(club.id);
    const numbersNow = numbers(agg, guests, q.days);
    const numbersPrev = p ? numbers(p.agg, p.guests, q.days) : null;
    return { club, today: clubToday, numbers: numbersNow, prev: numbersPrev, ranked: isLiveClub(club.mode, club.mode_before_suspend) };
  });
  const ranking = { utilization: rank(rows, 'utilization'), revenue_per_table: rank(rows, 'revenue_per_table_day') };
  const placeOf = (list, id) => list.find((x) => x.club_id === id)?.place ?? null;
  const totalNow = numbers(cur.agg, cur.guests, q.days);
  const totalPrev = prev ? numbers(prev.agg, prev.guests, q.days) : null;
  return {
    network: { id: n.id, name: n.name },
    role: access,
    period: { from: q.from, to: q.to, days: q.days },
    compare_period: q.compare ? { from: q.prevFrom, to: q.prevTo } : null,
    clubs: rows.map((r) => ({
      club_id: r.club.id,
      name: r.club.name,
      timezone: r.club.timezone,
      day_start_local: r.club.day_start_local,
      mode: r.club.mode,
      today: r.today,
      includes_today: q.from <= r.today && r.today <= q.to,
      ranked: r.ranked,
      tables_avg: r.numbers.tables_avg,
      tiles: tiles(r.numbers, r.prev),
      place_utilization: placeOf(ranking.utilization, r.club.id),
      place_revenue_per_table: placeOf(ranking.revenue_per_table, r.club.id),
    })),
    totals: { tables_avg: totalNow.tables_avg, tiles: tiles(totalNow, totalPrev) },
    ranking,
    missing_days: cur.agg.missing_days,
    generated_at: now.toISOString(),
  };
}
