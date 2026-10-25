// Ответ дашборда (docs/contracts/m5-2.md §3, §4): плитки с прошлым периодом, серии и таблицы вкладок
// summary | money | hall | guests | control для одного клуба или «Все мои клубы».
//
// Сутки берутся из store.loadDays (закрытые — агрегаты, текущие — на лету), складываются здесь.
// Неаддитивное (гости за период: новые, повторные, потерянные) считается запросом за весь период.
// Деньги — копейки; проценты — с одним знаком; часы — с одним знаком.

import { HttpError } from '../http/errors.mjs';
import { KIND_FAMILIES, matchKind, median, METHODS, SOURCES, TYPES } from './day.mjs';
import { liveHourlyRows, loadDays, storedHourly } from './store.mjs';
import { addDays, dayBounds, daysBetween, isDay, isoDow, workingDayOf } from './time.mjs';
import { cashbookTotals } from './cashbook.mjs';
import { clubForecast } from './forecast.mjs';
import { counters as maintenanceCounters } from '../maintenance/service.mjs';

export const TABS = ['summary', 'money', 'hall', 'guests', 'control'];
export const MAX_PERIOD_DAYS = 366;
export const LOST_AFTER_DAYS = 60;
export const LOST_MIN_GAMES = 3;
const STAFF_ROLES = ['owner', 'manager', 'reception', 'bar', 'installer'];

const r1 = (x) => Math.round(x * 10) / 10;
const pct = (a, b) => (b > 0 ? r1((a / b) * 100) : null);
const div = (a, b) => (b > 0 ? Math.round(a / b) : null);
const hours = (minutes) => r1(minutes / 60);
const add = (o, k, v) => {
  o[k] = (o[k] ?? 0) + (v ?? 0);
};
const addAll = (dst, src) => {
  for (const [k, v] of Object.entries(src ?? {})) if (typeof v === 'number') add(dst, k, v);
};

/** Разобрать период и параметры запроса (400 bad_request при ошибке). */
export function parseQuery(query, { today }) {
  const from = query.from ?? today;
  const to = query.to ?? from;
  if (!isDay(from) || !isDay(to) || from > to) throw new HttpError(400, 'bad_request', { detail: 'period' });
  const days = daysBetween(from, to);
  if (days > MAX_PERIOD_DAYS) throw new HttpError(400, 'bad_request', { detail: 'period too long' });
  const tab = query.tab ?? 'summary';
  if (!TABS.includes(tab)) throw new HttpError(400, 'bad_request', { detail: 'tab' });
  const kind = query.kind === undefined || query.kind === '' ? null : query.kind;
  if (kind !== null && !TYPES.includes(kind) && !KIND_FAMILIES.includes(kind)) throw new HttpError(400, 'bad_request', { detail: 'kind' });
  if (query.compare !== undefined && !['0', '1'].includes(query.compare)) throw new HttpError(400, 'bad_request', { detail: 'compare' });
  const compare = query.compare !== '0';
  return { from, to, days, tab, kind, compare, prevFrom: addDays(from, -days), prevTo: addDays(from, -1) };
}

/** Пустая свёртка периода. */
function emptyAgg() {
  return {
    days: [],
    revenue: {
      total_kopecks: 0,
      net_kopecks: 0,
      by_method: Object.fromEntries(METHODS.map((m) => [m, 0])),
      structure: { tables: 0, deposits: 0, bar: 0, packages: 0, tournaments: 0, other: 0 },
      sources: { qr: 0, reception: 0, booking: 0, tournament: 0 },
      tables_kopecks: 0,
      holds_kopecks: 0,
      late_returned_kopecks: 0,
      refunds: { total_kopecks: 0, count: 0, by_method: Object.fromEntries(METHODS.map((m) => [m, 0])), tables_kopecks: 0, bar_kopecks: 0 },
      payments_count: 0,
      table_payments: 0,
      bar_sales: 0,
    },
    // Метрики столов (с фильтром типа — только столы этого типа).
    t: { games: 0, play_minutes: 0, capacity_minutes: 0, service_minutes: 0, booking_minutes: 0, table_days: 0, revenue_kopecks: 0, refunds_kopecks: 0 },
    games: { total: 0, by_source: Object.fromEntries(SOURCES.map((s) => [s, 0])), no_staff: 0 },
    resources: new Map(),
    types: new Map(),
    service: { count: 0, minutes: 0 },
    extensions: { paid: 0, from_app: 0, free: 0, total: 0 },
    bookings: { total: 0, came: 0, no_show: 0, canceled: 0, upcoming: 0, lead_minutes_sum: 0, lead_count: 0, minutes: 0 },
    waitlist: { offered: 0, accepted: 0 },
    packages: { sold: 0, sold_minutes: 0, used_minutes: 0 },
    tournaments: { fees_kopecks: 0, participants: 0 },
    plus: { matches_counted: 0 },
    guestsDaily: [],
    manual: { count: 0, by_action: {}, by_staff: new Map(), automatic: { count: 0, by_action: {} }, items: [] },
    alarms: { total: 0, by_level: { critical: 0, important: 0, info: 0 }, by_type: {}, by_staff: new Map(), problems: [] },
    shifts: [],
    pilot: { scan: [], lights_without_journal: 0, sessions_without_journal: 0 },
    missing_days: [],
  };
}

/** Добавить сутки клуба d (data из stats_daily или computeDay) в свёртку a. */
export function addDay(a, d, { clubId, kind = null }) {
  a.days.push({ club_id: clubId, ...d });
  const v = d.revenue;
  add(a.revenue, 'total_kopecks', v.total_kopecks);
  add(a.revenue, 'net_kopecks', v.net_kopecks);
  addAll(a.revenue.by_method, v.by_method);
  addAll(a.revenue.structure, v.structure);
  addAll(a.revenue.sources, v.sources);
  for (const k of ['tables_kopecks', 'holds_kopecks', 'late_returned_kopecks', 'payments_count', 'table_payments', 'bar_sales']) add(a.revenue, k, v[k]);
  add(a.revenue.refunds, 'total_kopecks', v.refunds.total_kopecks);
  add(a.revenue.refunds, 'count', v.refunds.count);
  add(a.revenue.refunds, 'tables_kopecks', v.refunds.tables_kopecks);
  add(a.revenue.refunds, 'bar_kopecks', v.refunds.bar_kopecks);
  addAll(a.revenue.refunds.by_method, v.refunds.by_method);

  for (const [id, r] of Object.entries(d.resources ?? {})) {
    const key = `${clubId}|${id}`;
    const cur = a.resources.get(key) ?? { club_id: clubId, resource_id: id, number: r.number, title: r.title, type: r.type, games: 0, play_minutes: 0, service_minutes: 0, booking_minutes: 0, capacity_minutes: 0, revenue_kopecks: 0, refunds_kopecks: 0, days_in_operation: 0 };
    cur.number = r.number;
    cur.title = r.title;
    cur.type = r.type;
    for (const k of ['games', 'play_minutes', 'service_minutes', 'booking_minutes', 'capacity_minutes', 'revenue_kopecks', 'refunds_kopecks']) cur[k] += r[k] ?? 0;
    if ((r.capacity_minutes ?? 0) > 0) cur.days_in_operation += 1;
    a.resources.set(key, cur);
    const ty = a.types.get(r.type) ?? { type: r.type, games: 0, play_minutes: 0, service_minutes: 0, capacity_minutes: 0, revenue_kopecks: 0, refunds_kopecks: 0, table_days: 0, resources: new Set() };
    for (const k of ['games', 'play_minutes', 'service_minutes', 'capacity_minutes', 'revenue_kopecks', 'refunds_kopecks']) ty[k] += r[k] ?? 0;
    if ((r.capacity_minutes ?? 0) > 0) {
      ty.table_days += 1;
      ty.resources.add(key);
    }
    a.types.set(r.type, ty);
    if (matchKind(r.type, kind)) {
      a.t.games += r.games ?? 0;
      a.t.play_minutes += r.play_minutes ?? 0;
      a.t.capacity_minutes += r.capacity_minutes ?? 0;
      a.t.service_minutes += r.service_minutes ?? 0;
      a.t.booking_minutes += r.booking_minutes ?? 0;
      a.t.revenue_kopecks += r.revenue_kopecks ?? 0;
      a.t.refunds_kopecks += r.refunds_kopecks ?? 0;
      if ((r.capacity_minutes ?? 0) > 0) a.t.table_days += 1;
    }
  }
  if (kind === null) {
    // Без фильтра — точные итоги суток (минуты без накопленного округления по столам).
    a.t._exact_play = (a.t._exact_play ?? 0) + d.totals.play_minutes;
    a.t._exact_capacity = (a.t._exact_capacity ?? 0) + d.totals.capacity_minutes;
  }
  add(a.games, 'total', d.games.total);
  add(a.games, 'no_staff', d.games.no_staff);
  addAll(a.games.by_source, d.games.by_source);
  addAll(a.service, d.service);
  addAll(a.extensions, d.extensions);
  addAll(a.bookings, d.bookings);
  addAll(a.waitlist, d.waitlist);
  addAll(a.packages, d.packages);
  addAll(a.tournaments, d.tournaments);
  addAll(a.plus, d.plus);
  a.guestsDaily.push({ date: d.day, club_id: clubId, new: d.guests.new, active: d.guests.active });

  add(a.manual, 'count', d.manual.count);
  addAll(a.manual.by_action, d.manual.by_action);
  add(a.manual.automatic, 'count', d.manual.automatic.count);
  addAll(a.manual.automatic.by_action, d.manual.automatic.by_action);
  for (const [uid, s] of Object.entries(d.manual.by_staff ?? {})) {
    const key = `${clubId}|${uid}`;
    const cur = a.manual.by_staff.get(key) ?? { club_id: clubId, user_id: uid, count: 0, by_action: {} };
    cur.count += s.count;
    addAll(cur.by_action, s.by_action);
    a.manual.by_staff.set(key, cur);
  }
  for (const it of d.manual.items ?? []) a.manual.items.push({ club_id: clubId, ...it });

  const al = d.alarms;
  add(a.alarms, 'total', al.total);
  addAll(a.alarms.by_level, al.by_level);
  for (const [type, t] of Object.entries(al.by_type ?? {})) {
    const cur = (a.alarms.by_type[type] ??= { count: 0, acked: 0, react_ms_sum: 0, slow: 0, unacked: 0 });
    addAll(cur, t);
  }
  for (const [uid, s] of Object.entries(al.by_staff ?? {})) {
    const key = `${clubId}|${uid}`;
    const cur = a.alarms.by_staff.get(key) ?? { club_id: clubId, user_id: uid, count: 0, react_ms_sum: 0, slow: 0 };
    addAll(cur, s);
    a.alarms.by_staff.set(key, cur);
  }
  for (const p of al.problems ?? []) a.alarms.problems.push({ club_id: clubId, ...p });

  for (const s of d.shifts ?? []) if (s.closed_here || (d.live && s.closed_at === null && s.opened_here)) a.shifts.push({ club_id: clubId, ...s });
  if (d.shifts?.length) a._firstShift ??= { club_id: clubId, ...d.shifts.find((s) => s.opened_here) };

  for (const x of d.pilot.scan_to_light_sec ?? []) a.pilot.scan.push(x);
  a.pilot.lights_without_journal += d.pilot.lights_without_journal ?? 0;
  a.pilot.sessions_without_journal += d.pilot.sessions_without_journal ?? 0;
  return a;
}

/** Итоговые числа свёртки (основа плиток текущего и прошлого периода). */
export function metrics(a, { kind = null } = {}) {
  const t = a.t;
  const play = kind === null && t._exact_play !== undefined ? t._exact_play : t.play_minutes;
  const capacity = kind === null && t._exact_capacity !== undefined ? t._exact_capacity : t.capacity_minutes;
  const tablesGross = kind === null ? a.revenue.tables_kopecks : t.revenue_kopecks;
  const net = kind === null ? a.revenue.net_kopecks : t.revenue_kopecks - t.refunds_kopecks;
  const gamesNoTournament = a.games.total - (a.games.by_source.tournament ?? 0);
  return {
    revenue: net,
    revenue_total: kind === null ? a.revenue.total_kopecks : t.revenue_kopecks,
    refunds: kind === null ? a.revenue.refunds.total_kopecks : t.refunds_kopecks,
    games: t.games,
    play_minutes: play,
    play_hours: hours(play),
    capacity_minutes: capacity,
    service_minutes: t.service_minutes,
    unrealized_minutes: Math.max(0, capacity - play - t.service_minutes),
    utilization: pct(play, capacity),
    avg_check_game: div(tablesGross, t.games),
    avg_check_bar: div(a.revenue.structure.bar, a.revenue.bar_sales),
    revenue_per_table_day: div(net, t.table_days),
    avg_hour_price: play > 0 ? Math.round(tablesGross / (play / 60)) : null,
    no_staff_share: pct(a.games.no_staff, gamesNoTournament),
    cash_net: a.revenue.by_method.cash - a.revenue.refunds.by_method.cash,
    cashless_net: METHODS.filter((m) => m !== 'cash').reduce((s, m) => s + a.revenue.by_method[m] - a.revenue.refunds.by_method[m], 0),
    bookings: a.bookings.total,
    no_show: a.bookings.no_show,
    extensions_from_app_share: pct(a.extensions.from_app, a.extensions.total),
    manual_actions: a.manual.count,
    automatic_actions: a.manual.automatic.count,
    alarms: a.alarms.total,
    alarms_problem: Object.values(a.alarms.by_type).reduce((s, x) => s + x.slow + x.unacked, 0),
    cash_discrepancy: a.shifts.filter((s) => s.closed_here).reduce((s, x) => s + (x.discrepancy_kopecks ?? 0), 0),
    lights_without_journal: a.pilot.lights_without_journal + a.pilot.sessions_without_journal,
    scan_to_light_median_sec: median(a.pilot.scan),
  };
}

const UNITS = {
  revenue: 'kopecks',
  revenue_total: 'kopecks',
  refunds: 'kopecks',
  games: 'count',
  play_hours: 'hours',
  utilization: 'percent',
  avg_check_game: 'kopecks',
  avg_check_bar: 'kopecks',
  revenue_per_table_day: 'kopecks',
  avg_hour_price: 'kopecks',
  guests: 'count',
  guests_new: 'count',
  guests_repeat: 'count',
  guests_lost: 'count',
  no_staff_share: 'percent',
  cash_net: 'kopecks',
  cashless_net: 'kopecks',
  capacity_hours: 'hours',
  service_hours: 'hours',
  unrealized_hours: 'hours',
  bookings: 'count',
  no_show: 'count',
  extensions_from_app_share: 'percent',
  manual_actions: 'count',
  automatic_actions: 'count',
  alarms: 'count',
  alarms_problem: 'count',
  cash_discrepancy: 'kopecks',
  lights_without_journal: 'count',
  scan_to_light_median_sec: 'seconds',
  expenses: 'kopecks',
  profit: 'kopecks',
};

function deltaPct(value, prev) {
  if (value === null || prev === null || prev === undefined) return null;
  if (prev === 0) return value === 0 ? 0 : null;
  return r1(((value - prev) / Math.abs(prev)) * 100);
}

function tile(id, value, prev, extra = {}) {
  return { id, value, unit: UNITS[id], prev: prev === undefined ? null : prev, delta_pct: prev === undefined ? null : deltaPct(value, prev), ...extra };
}

/** Набор плиток вкладки по числам m (и прошлого периода p). */
function tilesFor(tab, m, p, extra) {
  const pv = (k) => (p ? p[k] : undefined);
  const x = (id, k = id, more = {}) => tile(id, m[k], pv(k), more);
  const g = extra.guests;
  const gp = extra.prevGuests;
  const total = m.revenue_total || 0;
  const parts = (s) => [
    { id: 'tables', value: s.tables + s.deposits, pct: pct(s.tables + s.deposits, total) },
    { id: 'bar', value: s.bar, pct: pct(s.bar, total) },
    { id: 'other', value: s.packages + s.tournaments + s.other, pct: pct(s.packages + s.tournaments + s.other, total) },
  ];
  const guestsTile = () =>
    tile('guests', g.total, gp?.total, {
      parts: [
        { id: 'new', value: g.new, pct: pct(g.new, g.total) },
        { id: 'repeat', value: g.repeat, pct: pct(g.repeat, g.total) },
      ],
    });
  const money = () => [tile('expenses', extra.cashbook.expenses_kopecks, extra.prevCashbook?.expenses_kopecks), tile('profit', m.revenue - extra.cashbook.expenses_kopecks, p ? p.revenue - (extra.prevCashbook?.expenses_kopecks ?? 0) : undefined)];
  switch (tab) {
    case 'summary':
      return [
        x('revenue', 'revenue', { parts: extra.kind ? undefined : parts(extra.structure) }),
        x('games'),
        x('play_hours'),
        x('utilization'),
        x('avg_check_game'),
        x('avg_check_bar'),
        x('revenue_per_table_day'),
        x('avg_hour_price'),
        guestsTile(),
        x('no_staff_share'),
        ...money(),
      ];
    case 'money':
      return [x('revenue'), x('revenue_total'), x('refunds'), x('cash_net'), x('cashless_net'), x('avg_check_game'), x('avg_check_bar'), ...money()];
    case 'hall':
      return [
        x('utilization'),
        x('play_hours'),
        tile('capacity_hours', hours(m.capacity_minutes), p ? hours(p.capacity_minutes) : undefined),
        tile('service_hours', hours(m.service_minutes), p ? hours(p.service_minutes) : undefined),
        tile('unrealized_hours', hours(m.unrealized_minutes), p ? hours(p.unrealized_minutes) : undefined),
        x('games'),
      ];
    case 'guests':
      return [
        guestsTile(),
        tile('guests_new', g.new, gp?.new),
        tile('guests_repeat', g.repeat, gp?.repeat),
        tile('guests_lost', g.lost, gp?.lost),
        x('bookings'),
        x('no_show'),
        x('extensions_from_app_share'),
      ];
    case 'control':
      return [
        x('manual_actions'),
        x('automatic_actions'),
        x('cash_discrepancy'),
        x('alarms'),
        x('alarms_problem'),
        x('lights_without_journal'),
        x('scan_to_light_median_sec'),
        x('no_staff_share'),
      ];
    default:
      return [];
  }
}

/**
 * Гости за период (№171): только количества. Гость — участник игры или автор брони, не сотрудник.
 * total — играли в периоде или впервые пришли (игра или бронь) в периоде; new — первая игра или
 * бронь в клубе за всё время — в периоде; repeat — играли в периоде и играли раньше периода;
 * lost — 3+ игры за всё время и последняя раньше конца периода − 60 дней.
 */
export async function periodGuests(db, clubId, from, to) {
  const lostBefore = new Date(to.getTime() - LOST_AFTER_DAYS * 86_400_000);
  const { rows } = await db.query(
    `with staff as (select user_id from bl.club_members where club_id = $1 and role = any($5::text[])),
     games as (
       select sp.user_id, s.started_at
         from bl.session_participants sp join bl.sessions s on s.id = sp.session_id
        where s.club_id = $1 and s.status <> 'cancelled' and not s.is_test and s.started_at < $3
          and sp.user_id not in (select user_id from staff)
     ),
     books as (
       select b.user_id, b.created_at
         from bl.bookings b
        where b.club_id = $1 and b.user_id is not null and not b.is_test and b.created_at < $3
          and b.status <> 'pending_payment' and not (b.status = 'expired' and b.expire_reason = 'unpaid')
          and b.user_id not in (select user_id from staff)
     ),
     firsts as (
       select user_id, min(at) as first_at from (select user_id, started_at as at from games union all select user_id, created_at from books) x group by user_id
     ),
     played as (select distinct user_id from games where started_at >= $2),
     played_before as (select distinct user_id from games where started_at < $2),
     newcomers as (select user_id from firsts where first_at >= $2),
     stats as (select user_id, count(*) as n, max(started_at) as last_at from games group by user_id)
     select (select count(*) from (select user_id from played union select user_id from newcomers) u)::int as total,
            (select count(*) from newcomers)::int as new,
            (select count(*) from played p where p.user_id in (select user_id from played_before))::int as repeat,
            (select count(*) from stats where n >= $6 and last_at < $4)::int as lost`,
    [clubId, from, to, lostBefore, STAFF_ROLES, LOST_MIN_GAMES],
  );
  return rows[0];
}

/** Имена сотрудников клуба (только блок «Контроль», №171): user_id → имя. */
async function staffNames(db, ids) {
  if (ids.length === 0) return new Map();
  const { rows } = await db.query(
    'select u.id, u.name from bl.users u where u.id = any($1::uuid[]) and exists (select 1 from bl.club_members m where m.user_id = u.id)',
    [ids],
  );
  return new Map(rows.map((r) => [r.id, r.name ?? null]));
}

/** UTC-границы периода клуба: начало первых суток и конец последних (или «сейчас»). */
function periodBounds(club, fromDay, toDay, now) {
  const a = dayBounds(fromDay, club.timezone, club.day_start_local).from;
  const b = dayBounds(toDay, club.timezone, club.day_start_local).to;
  return { from: a, to: new Date(Math.min(b.getTime(), now.getTime())) };
}

function heatmap(rows) {
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ play: 0, cap: 0 })));
  for (const r of rows) {
    const c = cells[isoDow(r.day) - 1][r.hour];
    c.play += r.play_minutes;
    c.cap += r.capacity_minutes;
  }
  return {
    rows: [1, 2, 3, 4, 5, 6, 7],
    cols: Array.from({ length: 24 }, (_, i) => i),
    pct: cells.map((row) => row.map((c) => (c.cap > 0 ? Math.min(100, r1((c.play / c.cap) * 100)) : null))),
    play_minutes: cells.map((row) => row.map((c) => c.play)),
    capacity_minutes: cells.map((row) => row.map((c) => c.cap)),
  };
}

export function dailyRows(a, { kind, today }) {
  const byDate = new Map();
  for (const d of a.days) {
    const cur = byDate.get(d.day) ?? { date: d.day, total_kopecks: 0, net_kopecks: 0, refunds_kopecks: 0, tables_kopecks: 0, bar_kopecks: 0, other_kopecks: 0, games: 0, bar_sales: 0, play_minutes: 0, capacity_minutes: 0, today: d.day === today };
    cur.total_kopecks += d.revenue.total_kopecks;
    cur.net_kopecks += d.revenue.net_kopecks;
    cur.refunds_kopecks += d.revenue.refunds.total_kopecks;
    cur.tables_kopecks += d.revenue.tables_kopecks;
    cur.bar_kopecks += d.revenue.structure.bar;
    cur.other_kopecks += d.revenue.structure.packages + d.revenue.structure.tournaments + d.revenue.structure.other;
    cur.bar_sales += d.revenue.bar_sales;
    for (const r of Object.values(d.resources ?? {})) {
      if (!matchKind(r.type, kind)) continue;
      cur.games += r.games;
      cur.play_minutes += r.play_minutes;
      cur.capacity_minutes += r.capacity_minutes;
    }
    byDate.set(d.day, cur);
  }
  return [...byDate.values()]
    .sort((x, y) => (x.date < y.date ? -1 : 1))
    .map(({ bar_sales: bs, ...r }) => ({
      ...r,
      avg_check_game_kopecks: div(r.tables_kopecks, r.games),
      avg_check_bar_kopecks: div(r.bar_kopecks, bs),
      utilization_pct: pct(r.play_minutes, r.capacity_minutes),
    }));
}

/**
 * Свёртка периода по клубам: { agg, hourlyRows, guests, perClub }.
 * clubs — [{ club (loadClub), db-контекст уже выставлен вызывающим через enter(club) }].
 */
export async function collect(db, clubs, { fromDay, toDay, now, kind, enter, wantHourly, light = false, alsoKinds = [] }) {
  const agg = emptyAgg();
  const hourlyRows = [];
  const guests = { total: 0, new: 0, repeat: 0, lost: 0 };
  const perClub = [];
  // M5.5 × M5.8: те же сутки ещё и с фильтром вида или семьи (вкладка «Сеть»: столы и корты отдельно).
  const byKind = Object.fromEntries(alsoKinds.map((k) => [k, emptyAgg()]));
  for (const club of clubs) {
    await enter(club);
    const loaded = await loadDays(db, club, { fromDay, toDay, now, light });
    const one = emptyAgg();
    const oneByKind = Object.fromEntries(alsoKinds.map((k) => [k, emptyAgg()]));
    for (const d of loaded.days) {
      addDay(agg, d, { clubId: club.id, kind });
      addDay(one, d, { clubId: club.id, kind });
      for (const k of alsoKinds) {
        addDay(byKind[k], d, { clubId: club.id, kind: k });
        addDay(oneByKind[k], d, { clubId: club.id, kind: k });
      }
    }
    agg.missing_days.push(...loaded.missingDays.map((day) => ({ club_id: club.id, day })));
    if (wantHourly) {
      hourlyRows.push(...(await storedHourly(db, club.id, loaded.storedDays, kind)).map((r) => ({ club_id: club.id, ...r })));
      hourlyRows.push(...liveHourlyRows(loaded.liveHourly, loaded.days, kind).map((r) => ({ club_id: club.id, ...r })));
    }
    const b = periodBounds(club, fromDay, toDay, now);
    const g = b.to > b.from ? await periodGuests(db, club.id, b.from, b.to) : { total: 0, new: 0, repeat: 0, lost: 0 };
    for (const k of Object.keys(guests)) guests[k] += g[k];
    const cb = await cashbookTotals(db, club, { fromDay, toDay });
    agg.cashbook = agg.cashbook ?? { expenses_kopecks: 0, income_kopecks: 0, collections_kopecks: 0 };
    agg.cashbook.expenses_kopecks += cb.expenses_kopecks;
    agg.cashbook.income_kopecks += cb.income_kopecks;
    agg.cashbook.collections_kopecks += cb.collections_kopecks;
    perClub.push({ club, agg: one, byKind: oneByKind, guests: g, today: loaded.today });
  }
  agg.cashbook ??= { expenses_kopecks: 0, income_kopecks: 0, collections_kopecks: 0 };
  return { agg, byKind, hourlyRows, guests, perClub };
}

/**
 * Ответ GET …/dashboard.
 * @param {import('pg').ClientBase} db
 * @param {{ clubs: object[], enter: (club) => Promise<void>, q: ReturnType<typeof parseQuery>, now: Date, all: boolean }} args
 *   enter(club) — выставить контекст клуба в транзакции (RLS) перед его запросами
 */
export async function buildDashboard(db, { clubs, enter, q, now, all }) {
  const { tab, kind } = q;
  const wantHourly = tab === 'hall';
  // Списки (ручные действия, проблемные тревоги, скан → свет) нужны только «Контролю».
  const light = tab !== 'control';
  const cur = await collect(db, clubs, { fromDay: q.from, toDay: q.to, now, kind, enter, wantHourly, light });
  const prev = q.compare ? await collect(db, clubs, { fromDay: q.prevFrom, toDay: q.prevTo, now, kind, enter, wantHourly: false, light }) : null;
  const m = metrics(cur.agg, { kind });
  const p = prev ? metrics(prev.agg, { kind }) : null;
  const first = clubs[0];
  const today = cur.perClub[0]?.today ?? (first ? workingDayOf(now, first.timezone, first.day_start_local) : null);
  const out = {
    period: {
      from: q.from,
      to: q.to,
      days: q.days,
      timezone: all ? null : first?.timezone ?? null,
      day_start_local: all ? null : first?.day_start_local ?? null,
      today,
      includes_today: q.from <= today && today <= q.to,
      missing_days: cur.agg.missing_days,
    },
    compare_period: q.compare ? { from: q.prevFrom, to: q.prevTo } : null,
    club: all ? 'all' : { id: first.id, name: first.name, mode: first.mode },
    kind,
    tab,
    tiles: tilesFor(tab, m, p, {
      kind,
      structure: cur.agg.revenue.structure,
      guests: cur.guests,
      prevGuests: prev?.guests ?? null,
      cashbook: cur.agg.cashbook,
      prevCashbook: prev?.agg.cashbook ?? null,
    }),
    series: {},
    tables: {},
    generated_at: now.toISOString(),
  };
  const daily = dailyRows(cur.agg, { kind, today });
  if (all) {
    out.tables.clubs = cur.perClub.map(({ club, agg, guests }) => {
      const cm = metrics(agg, { kind });
      return { club_id: club.id, name: club.name, revenue_kopecks: cm.revenue, games: cm.games, play_hours: cm.play_hours, utilization_pct: cm.utilization, guests: guests.total };
    });
  }

  if (tab === 'summary') {
    out.series.revenue_daily = daily.map((d) => ({ date: d.date, total_kopecks: d.total_kopecks, net_kopecks: d.net_kopecks, tables_kopecks: d.tables_kopecks, bar_kopecks: d.bar_kopecks, other_kopecks: d.other_kopecks, today: d.today }));
  }

  if (tab === 'money') {
    const v = cur.agg.revenue;
    const total = v.total_kopecks;
    out.tables.structure = Object.entries(v.structure).map(([id, k]) => ({ id, kopecks: k, pct: pct(k, total) }));
    out.tables.methods = METHODS.map((id) => ({ id, kopecks: v.by_method[id], refunds_kopecks: v.refunds.by_method[id], pct: pct(v.by_method[id], total) }));
    out.tables.sources = Object.entries(v.sources).map(([id, k]) => ({ id, kopecks: k, pct: pct(k, total) }));
    out.tables.refunds = { count: v.refunds.count, total_kopecks: v.refunds.total_kopecks, by_method: v.refunds.by_method, tables_kopecks: v.refunds.tables_kopecks, bar_kopecks: v.refunds.bar_kopecks };
    const closed = cur.agg.shifts.filter((s) => s.closed_here);
    const firstShift = cur.agg.days.flatMap((d) => (d.shifts ?? []).filter((s) => s.opened_here)).sort((x, y) => (x.opened_at < y.opened_at ? -1 : 1))[0] ?? null;
    const names = await namesFor(db, clubs, enter, cur.agg.shifts.flatMap((s) => [`${s.club_id}|${s.opened_by}`, `${s.club_id}|${s.closed_by}`]));
    out.tables.cash = {
      start_kopecks: all ? null : firstShift?.float_kopecks ?? null,
      cash_sales_kopecks: v.by_method.cash,
      cash_refunds_kopecks: v.refunds.by_method.cash,
      // Инкассации — записи кассы управляющего (из закрытых смен, №177).
      collections_kopecks: cur.agg.cashbook.collections_kopecks,
      discrepancy_kopecks: closed.reduce((s, x) => s + (x.discrepancy_kopecks ?? 0), 0),
      shifts: cur.agg.shifts.map((s) => shiftRow(s, names)),
    };
    out.tables.daily = daily;
    // Выручка за 30 дней по конец периода, текущий день выделен.
    const end = q.to < today ? q.to : today;
    const from30 = addDays(end, -29);
    const r30 = from30 >= q.from ? { agg: cur.agg } : await collect(db, clubs, { fromDay: from30, toDay: end, now, kind, enter, wantHourly: false, light: true });
    out.series.revenue_30d = dailyRows(r30.agg, { kind, today })
      .filter((d) => d.date >= from30 && d.date <= end)
      .map((d) => ({ date: d.date, total_kopecks: d.total_kopecks, net_kopecks: d.net_kopecks, today: d.today }));
  }

  if (tab === 'hall') {
    out.series.heatmap = heatmap(cur.hourlyRows);
    // M5.6 (№196–198): прогноз 7 × 24 и подсказки по цене — по последним 8 неделям, не по периоду;
    // у «всех клубов» прогноза нет (у каждого клуба свои сутки), подсказки — по каждому клубу.
    // Часы с замены сукна — текущий счётчик стола (обслуживание).
    out.series.forecast = null;
    out.hints = [];
    const cloth = new Map();
    for (const c of clubs) {
      await enter(c);
      const f = await clubForecast(db, c, { now, kind });
      if (!all) out.series.forecast = f.forecast;
      out.hints.push(...f.hints.map((h) => (all ? { club_id: c.id, club_name: c.name, ...h } : h)));
      for (const row of await maintenanceCounters(db, c, { now, kinds: ['cloth'] })) cloth.set(row.resource_id, row.kinds.cloth);
    }
    out.series.ring = { capacity_minutes: m.capacity_minutes, played_minutes: m.play_minutes, service_minutes: m.service_minutes, unrealized_minutes: m.unrealized_minutes };
    const byDayType = new Map();
    for (const d of cur.agg.days) {
      for (const r of Object.values(d.resources ?? {})) {
        const k = `${d.day}|${r.type}`;
        const x = byDayType.get(k) ?? { play: 0, cap: 0 };
        x.play += r.play_minutes;
        x.cap += r.capacity_minutes;
        byDayType.set(k, x);
      }
    }
    out.series.utilization_daily = daily.map((d) => ({
      date: d.date,
      pct: d.utilization_pct,
      by_type: Object.fromEntries(TYPES.map((t) => {
        const x = byDayType.get(`${d.date}|${t}`);
        return [t, x ? pct(x.play, x.cap) : null];
      })),
    }));
    out.tables.by_type = TYPES.filter((t) => cur.agg.types.has(t)).map((t) => {
      const x = cur.agg.types.get(t);
      return { type: t, tables: x.resources.size, games: x.games, play_minutes: x.play_minutes, capacity_minutes: x.capacity_minutes, service_minutes: x.service_minutes, utilization_pct: pct(x.play_minutes, x.capacity_minutes), revenue_kopecks: x.revenue_kopecks - x.refunds_kopecks };
    });
    out.tables.by_resource = [...cur.agg.resources.values()]
      .filter((r) => matchKind(r.type, kind) && (r.capacity_minutes > 0 || r.games > 0 || r.revenue_kopecks > 0))
      .sort((x, y) => (x.club_id === y.club_id ? x.number - y.number : x.club_id < y.club_id ? -1 : 1))
      .map((r) => ({
        ...(all ? { club_id: r.club_id } : {}),
        resource_id: r.resource_id,
        number: r.number,
        title: r.title,
        type: r.type,
        games: r.games,
        play_minutes: r.play_minutes,
        play_hours: hours(r.play_minutes),
        service_minutes: r.service_minutes,
        revenue_kopecks: r.revenue_kopecks - r.refunds_kopecks,
        utilization_pct: pct(r.play_minutes, r.capacity_minutes),
        // Часы игры с последней замены сукна (M5.6 №198), сутки последней замены (null — с начала учёта).
        cloth_hours: cloth.get(r.resource_id)?.hours ?? null,
        cloth_since: cloth.get(r.resource_id)?.since ?? null,
        cloth_threshold_hours: cloth.get(r.resource_id)?.threshold_hours ?? null,
        cloth_due: cloth.get(r.resource_id)?.due ?? false,
      }));
  }

  if (tab === 'guests') {
    const g = cur.guests;
    const b = cur.agg.bookings;
    out.tables.guests = { ...g, new_pct: pct(g.new, g.total), repeat_pct: pct(g.repeat, g.total) };
    out.tables.bookings = { total: b.total, came: b.came, no_show: b.no_show, canceled: b.canceled, upcoming: b.upcoming, came_pct: pct(b.came, b.total), lead_minutes_avg: div(b.lead_minutes_sum, b.lead_count) };
    out.tables.waitlist = cur.agg.waitlist;
    out.tables.extensions = { ...cur.agg.extensions, from_app_pct: pct(cur.agg.extensions.from_app, cur.agg.extensions.total) };
    out.tables.packages = cur.agg.packages;
    out.tables.tournaments = cur.agg.tournaments;
    out.tables.plus = cur.agg.plus;
    const byDate = new Map();
    for (const x of cur.agg.guestsDaily) {
      const c = byDate.get(x.date) ?? { date: x.date, new: 0, active: 0 };
      c.new += x.new;
      c.active += x.active;
      byDate.set(x.date, c);
    }
    out.series.guests_daily = [...byDate.values()].sort((x, y) => (x.date < y.date ? -1 : 1));
    out.series.bookings_daily = bookingsDaily(cur.agg);
  }

  if (tab === 'control') {
    const a = cur.agg;
    const keys = [
      ...[...a.manual.by_staff.values()].map((s) => `${s.club_id}|${s.user_id}`),
      ...a.manual.items.map((i) => `${i.club_id}|${i.actor_id}`),
      ...[...a.alarms.by_staff.values()].map((s) => `${s.club_id}|${s.user_id}`),
      ...a.alarms.problems.map((x) => `${x.club_id}|${x.acked_by}`),
      ...a.shifts.flatMap((s) => [`${s.club_id}|${s.opened_by}`, `${s.club_id}|${s.closed_by}`]),
    ];
    const names = await namesFor(db, clubs, enter, keys);
    const nm = (clubId, uid) => (uid ? names.get(`${clubId}|${uid}`) ?? null : null);
    out.tables.manual_by_action = Object.entries(a.manual.by_action).map(([action, count]) => ({ action, count })).sort((x, y) => y.count - x.count);
    out.tables.manual_by_staff = [...a.manual.by_staff.values()]
      .map((s) => ({ ...(all ? { club_id: s.club_id } : {}), user_id: s.user_id, name: nm(s.club_id, s.user_id), count: s.count, by_action: s.by_action }))
      .sort((x, y) => y.count - x.count);
    out.tables.manual_items = a.manual.items
      .sort((x, y) => (x.at < y.at ? 1 : -1))
      .slice(0, 100)
      .map((i) => ({ ...(all ? { club_id: i.club_id } : {}), at: i.at, action: i.action, kind: i.kind, actor_id: i.actor_id, actor_name: nm(i.club_id, i.actor_id), reason: i.reason, resource_number: i.resource_number, amount_kopecks: i.amount_kopecks }));
    out.tables.automatic = a.manual.automatic;
    out.tables.shifts = a.shifts.filter((s) => s.closed_here).map((s) => shiftRow(s, names));
    out.tables.alarms = {
      total: a.alarms.total,
      by_level: a.alarms.by_level,
      slow_after_sec: 600,
      by_type: Object.entries(a.alarms.by_type)
        .map(([type, t]) => ({ type, count: t.count, acked: t.acked, unacked: t.unacked, slow: t.slow, avg_react_sec: t.acked ? Math.round(t.react_ms_sum / t.acked / 1000) : null, problem: t.slow + t.unacked > 0 }))
        .sort((x, y) => y.count - x.count),
      by_staff: [...a.alarms.by_staff.values()]
        .map((s) => ({ ...(all ? { club_id: s.club_id } : {}), user_id: s.user_id, name: nm(s.club_id, s.user_id), count: s.count, slow: s.slow, avg_react_sec: s.count ? Math.round(s.react_ms_sum / s.count / 1000) : null, problem: s.slow > 0 }))
        .sort((x, y) => y.count - x.count),
      problems: a.alarms.problems
        .sort((x, y) => (x.raised_at < y.raised_at ? 1 : -1))
        .slice(0, 100)
        .map(({ club_id: cid, ...x }) => ({ ...(all ? { club_id: cid } : {}), ...x, acked_by_name: nm(cid, x.acked_by) })),
    };
    out.tables.pilot = {
      lights_without_journal: { commands: a.pilot.lights_without_journal, sessions: a.pilot.sessions_without_journal },
      scan_to_light: { median_sec: median(a.pilot.scan), count: a.pilot.scan.length, under_20_pct: pct(a.pilot.scan.filter((x) => x < 20).length, a.pilot.scan.length) },
      no_staff_share_pct: m.no_staff_share,
      extensions_from_app_pct: m.extensions_from_app_share,
      cash_discrepancy_kopecks: m.cash_discrepancy,
    };
  }
  return out;
}

export function bookingsDaily(a) {
  const byDate = new Map();
  for (const d of a.days) {
    const c = byDate.get(d.day) ?? { date: d.day, total: 0, came: 0, no_show: 0, canceled: 0 };
    for (const k of ['total', 'came', 'no_show', 'canceled']) c[k] += d.bookings[k];
    byDate.set(d.day, c);
  }
  return [...byDate.values()].sort((x, y) => (x.date < y.date ? -1 : 1));
}

export function shiftRow(s, names) {
  const nm = (uid) => (uid ? names.get(`${s.club_id}|${uid}`) ?? null : null);
  return {
    club_id: s.club_id,
    shift_id: s.shift_id,
    number: s.number,
    opened_at: s.opened_at,
    closed_at: s.closed_at,
    opened_by_name: nm(s.opened_by),
    closed_by_name: nm(s.closed_by),
    float_kopecks: s.float_kopecks,
    expected_cash_kopecks: s.expected_cash_kopecks,
    actual_cash_kopecks: s.actual_cash_kopecks,
    discrepancy_kopecks: s.discrepancy_kopecks,
    status: s.closed_at === null ? 'open' : s.discrepancy_kopecks ? 'discrepancy' : 'closed',
  };
}

/** Имена сотрудников по ключам `${club}|${user}` — в контексте каждого клуба. */
export async function namesFor(db, clubs, enter, keys) {
  const byClub = new Map();
  for (const k of keys) {
    const [club, uid] = k.split('|');
    if (!uid || uid === 'null' || uid === 'undefined') continue;
    if (!byClub.has(club)) byClub.set(club, new Set());
    byClub.get(club).add(uid);
  }
  const out = new Map();
  for (const club of clubs) {
    const ids = byClub.get(club.id);
    if (!ids) continue;
    await enter(club);
    for (const [id, name] of await staffNames(db, [...ids])) out.set(`${club.id}|${id}`, name);
  }
  return out;
}

