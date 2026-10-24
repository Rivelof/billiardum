// Сутки дашборда: чтение закрытых суток из bl.stats_daily / bl.stats_hourly, расчёт недостающих и
// текущих на лету (той же computeDay), запись закрытых суток планировщиком (bl.stats_put_day).

import { computeDay, VERSION } from './day.mjs';
import { addDays, DEFAULT_DAY_START, eachDay, normalizeHhmm, workingDayOf } from './time.mjs';

/** Сколько закрытых суток без агрегата можно досчитать в одном запросе (остальное — missing_days). */
export const MAX_LIVE_DAYS = 14;

/** Клуб из контекста транзакции: { id, name, timezone, day_start_local, settings, created_at, mode, mode_before_suspend, went_live_at }. */
export async function loadClub(db, clubId) {
  const { rows } = await db.query('select id, name, timezone, settings, created_at, mode, mode_before_suspend, went_live_at from bl.clubs where id = $1', [clubId]);
  const c = rows[0];
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    timezone: c.timezone,
    settings: c.settings ?? {},
    day_start_local: normalizeHhmm(c.settings?.day_start_local, DEFAULT_DAY_START),
    created_at: c.created_at,
    mode: c.mode,
    // M5.6: история прогноза — с перехода в live (до него записи тестовые).
    mode_before_suspend: c.mode_before_suspend ?? null,
    went_live_at: c.went_live_at ?? null,
  };
}

/** Первые рабочие сутки клуба (создание клуба). */
export function firstDayOf(club) {
  return workingDayOf(new Date(club.created_at), club.timezone, club.day_start_local);
}

/**
 * Сутки периода [fromDay, toDay] клуба: закрытые — из агрегатов, текущие и недосчитанные — на лету.
 * @returns {Promise<{ days: object[], liveHourly: Map<string, object[]>, storedDays: string[], missingDays: string[], today: string }>}
 */
/** Тяжёлые части суток (списки), не нужные вне вкладки «Контроль»: при чтении агрегата отрезаются. */
export const HEAVY_PATHS = ['{manual,items}', '{alarms,problems}', '{pilot,scan_to_light_sec}'];

export async function loadDays(db, club, { fromDay, toDay, now, maxLive = MAX_LIVE_DAYS, light = false }) {
  const today = workingDayOf(now, club.timezone, club.day_start_local);
  const first = firstDayOf(club);
  const lo = fromDay > first ? fromDay : first;
  const hi = toDay < today ? toDay : today;
  const out = { days: [], liveHourly: new Map(), storedDays: [], missingDays: [], today };
  if (lo > hi) return out;
  const data = light ? `data ${HEAVY_PATHS.map((x) => `#- '${x}'`).join(' ')}` : 'data';
  const { rows } = await db.query(`select day::text as day, version, ${data} as data from bl.stats_daily where club_id = $1 and day >= $2 and day <= $3`, [club.id, lo, hi]);
  const stored = new Map(rows.map((r) => [r.day, r]));
  let budget = maxLive;
  for (const day of eachDay(lo, hi)) {
    const s = stored.get(day);
    if (day < today && s) {
      out.days.push(s.data);
      out.storedDays.push(day);
      continue;
    }
    if (day < today && budget <= 0) {
      out.missingDays.push(day);
      continue;
    }
    if (day < today) budget -= 1;
    const { daily, hourly } = await computeDay(db, { club, day, now });
    out.days.push(daily);
    out.liveHourly.set(day, hourly);
  }
  return out;
}

/**
 * Часы из агрегатов закрытых суток (days) с фильтром типа стола: строки (day, hour) с суммами.
 * @returns {Promise<{ day: string, hour: number, play_minutes: number, service_minutes: number, booking_minutes: number, capacity_minutes: number, games: number }[]>}
 */
export async function storedHourly(db, clubId, days, kind = null) {
  if (days.length === 0) return [];
  const { rows } = await db.query(
    `select h.day::text as day, h.hour, sum(h.play_minutes)::int as play_minutes, sum(h.service_minutes)::int as service_minutes,
            sum(h.booking_minutes)::int as booking_minutes, sum(h.capacity_minutes)::int as capacity_minutes, sum(h.games)::int as games
       from bl.stats_hourly h join bl.resources r on r.id = h.resource_id
      where h.club_id = $1 and h.day = any($2::date[]) and ($3::text is null or r.type = $3)
      group by h.day, h.hour order by h.day, h.hour`,
    [clubId, days, kind],
  );
  return rows;
}

/** Те же строки из часов, посчитанных на лету. */
export function liveHourlyRows(liveHourly, days, kind = null) {
  const out = [];
  for (const [day, rows] of liveHourly) {
    const d = days.find((x) => x.day === day);
    const acc = new Map();
    for (const h of rows) {
      if (kind && d?.resources?.[h.resource_id]?.type !== kind) continue;
      const a = acc.get(h.hour) ?? { day, hour: h.hour, play_minutes: 0, service_minutes: 0, booking_minutes: 0, capacity_minutes: 0, games: 0 };
      for (const k of ['play_minutes', 'service_minutes', 'booking_minutes', 'capacity_minutes', 'games']) a[k] += h[k];
      acc.set(h.hour, a);
    }
    out.push(...[...acc.values()].sort((a, b) => a.hour - b.hour));
  }
  return out;
}

/**
 * Посчитать и записать закрытые сутки (в транзакции планировщика: контекст клуба, actor system).
 * Отметку «грязных» снимает bl.stats_put_day, если её не обновили, пока шёл расчёт.
 */
export async function recomputeDay(db, club, day, now) {
  const g = await db.query('select gen from bl.stats_dirty where club_id = $1 and day = $2', [club.id, day]);
  const gen = g.rows[0] ? Number(g.rows[0].gen) : 0;
  const { daily, hourly } = await computeDay(db, { club, day, now });
  await db.query('select bl.stats_put_day($1::date, $2::bigint, $3::smallint, $4::jsonb, $5::jsonb)', [day, gen, VERSION, JSON.stringify(daily), JSON.stringify(hourly)]);
  return daily;
}

/**
 * Какие закрытые сутки клуба считать обязательно: нет агрегата (догоняем после простоя, не дальше
 * horizonDays) и отметка «грязные». lastClosed — последние закрытые сутки. Сутки старой версии
 * формул — отдельно (staleDays): их пересчёт ограничен бюджетом и не идёт в часы пик.
 */
export async function dueDays(db, club, { lastClosed, horizonDays = 400, limit = 31 }) {
  const first = firstDayOf(club);
  const horizon = addDays(lastClosed, -horizonDays);
  const lo = first > horizon ? first : horizon;
  if (lo > lastClosed) return [];
  const { rows } = await db.query(
    `select d::date::text as day from generate_series($2::date, $3::date, interval '1 day') d
      where not exists (select 1 from bl.stats_daily s where s.club_id = $1 and s.day = d::date)
     union
     select day::text from bl.stats_dirty where club_id = $1 and day <= $3 and day >= $2
     order by 1 limit $4`,
    [club.id, lo, lastClosed, limit],
  );
  return rows.map((r) => r.day);
}

/**
 * Закрытые сутки клуба с агрегатом старой версии формул (version < VERSION), свежие первыми: их
 * чаще смотрят. Без горизонта — пересчитываются все сохранённые сутки.
 */
export async function staleDays(db, club, { lastClosed, limit }) {
  if (!(limit > 0)) return [];
  const { rows } = await db.query(
    'select day::text as day from bl.stats_daily where club_id = $1 and version < $2 and day <= $3 order by day desc limit $4',
    [club.id, VERSION, lastClosed, limit],
  );
  return rows.map((r) => r.day);
}
