// Маршруты чтения публичного API клуба (M5.7 №200). Транзакция — READ ONLY в контексте клуба
// ключа (auth.mjs); RLS отсекает чужое. В ответах нет персональных данных гостей: ни телефонов,
// ни имён, ни user_id, ни идентификаторов игр плательщиков — только столы, время, статусы, деньги
// агрегатами. Расчёты не дублируются: продажи — свёртка дашборда (server/dashboard), свободные
// интервалы — модуль брони (server/bookings/availability.mjs), цены — server/tariffs.

import { HttpError } from '../http/errors.mjs';
import { isUuid } from '../lib/store.mjs';
import { availability as bookingAvailability } from '../bookings/availability.mjs';
import { collect, dailyRows, parseQuery } from '../dashboard/service.mjs';
import { bucketOf } from '../dashboard/now.mjs';
import { METHODS, TYPES } from '../dashboard/day.mjs';
import { loadClub as loadDashboardClub } from '../dashboard/store.mjs';
import { addDays, dayBounds, isDay, daysBetween, workingDayOf } from '../dashboard/time.mjs';
import * as tariffs from '../tariffs/index.mjs';
import * as engine from '../tariffs/engine.mjs';

const KINDS = [...TYPES, 'billiard_mixed'];
export const MAX_BOOKINGS_DAYS = 93;
export const MAX_BOOKINGS_LIMIT = 1000;
const OPEN_SESSION = ['active', 'ending', 'grace'];
const DEVICE_FRESH_MS = 150_000;
const iso = (d) => (d ? new Date(d).toISOString() : null);

function parseKind(raw) {
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || !KINDS.includes(raw)) throw new HttpError(400, 'bad_request', { detail: 'kind' });
  return raw;
}

async function clubOf(db, clubId) {
  const club = await loadDashboardClub(db, clubId);
  if (!club) throw new HttpError(404, 'not_found', { detail: 'club' });
  return club;
}

function clubJson(club) {
  return { id: club.id, name: club.name, timezone: club.timezone, day_start_local: club.day_start_local, mode: club.mode };
}

/** GET /api/v1/club/tables — столы клуба и статус сейчас. */
export async function tablesNow(ctx, query) {
  const db = ctx.db;
  const club = await clubOf(db, ctx.club);
  const kind = parseKind(query.kind);
  const now = ctx.clock.now();
  const { rows: resources } = await db.query(
    `select r.id, r.number, r.title, r.type, d.id as device_id, d.last_seen_at, (d.device_key_enc is not null) as has_key
       from bl.resources r left join bl.devices d on d.resource_id = r.id
      where r.club_id = $1 and r.active and ($2::text is null or r.type = $2)
      order by r.number`,
    [club.id, kind],
  );
  const { rows: sessions } = await db.query('select resource_id, status, paid_until from bl.sessions where club_id = $1 and status = any($2::text[])', [club.id, OPEN_SESSION]);
  const { rows: holds } = await db.query(
    `select distinct on (resource_id) resource_id, kind, until from bl.resource_holds
      where club_id = $1 and released_at is null and until > $2
      order by resource_id, case kind when 'service' then 0 when 'pending' then 1 else 2 end, created_at desc`,
    [club.id, now],
  );
  const sessionOf = new Map(sessions.map((s) => [s.resource_id, s]));
  const holdOf = new Map(holds.map((h) => [h.resource_id, h]));
  const bridge = ctx.bridge;
  const tables = resources.map((r) => {
    const info = r.device_id && typeof bridge?.deviceInfo === 'function' ? bridge.deviceInfo(r.device_id) ?? null : null;
    const online = Boolean(r.device_id && r.has_key) &&
      (info ? info.online === true : Boolean(r.last_seen_at) && now.getTime() - new Date(r.last_seen_at).getTime() <= DEVICE_FRESH_MS);
    const s = sessionOf.get(r.id);
    const h = holdOf.get(r.id);
    let status = 'free';
    if (!online) status = 'offline';
    else if (s) status = s.status;
    else if (h) status = h.kind;
    else if (info?.mode === 'fault') status = 'fault';
    return {
      resource_id: r.id,
      number: r.number,
      title: r.title,
      type: r.type,
      status: bucketOf(status),
      busy_until: s ? iso(s.paid_until) : null,
      hold_until: !s && h ? iso(h.until) : null,
    };
  });
  return { club: clubJson(club), at: iso(now), tables };
}

/** GET /api/v1/club/tariffs — правила по расписанию (местное время клуба) и цена сейчас по столам. */
export async function tariffsNow(ctx, query) {
  const db = ctx.db;
  const club = await clubOf(db, ctx.club);
  const kind = parseKind(query.kind);
  const now = ctx.clock.now();
  const settings = tariffs.clubTariffSettings(club.settings);
  const { rows: rules } = await db.query(
    `select t.id, t.resource_type, t.resource_id, t.days, to_char(t.start_local, 'HH24:MI') as start_local, to_char(t.end_local, 'HH24:MI') as end_local,
            t.price_per_hour, t.step_minutes, t.min_minutes, t.priority
       from bl.tariff_rules t
      where t.club_id = $1 and t.active
      order by t.priority desc, t.resource_type nulls last, t.start_local, t.id`,
    [club.id],
  );
  const { rows: resources } = await db.query(
    'select id, number, title, type from bl.resources where club_id = $1 and active and ($2::text is null or type = $2) order by number',
    [club.id, kind],
  );
  const today = workingDayOf(now, club.timezone, club.day_start_local);
  const { rows: holidays } = await db.query(
    `select to_char(day, 'YYYY-MM-DD') as day, kind from bl.holidays
      where day between $1::date and $2::date and (club_id is null or club_id = $3) order by day`,
    [today, addDays(today, 90), club.id],
  );
  const resourceIds = new Set(resources.map((r) => r.id));
  const items = [];
  for (const r of resources) {
    let prices = { price_now: null, price_next: null };
    try {
      prices = await tariffs.pricesAround(db, { resourceId: r.id, at: now });
    } catch (err) {
      if (!(err && typeof err.code === 'string')) throw err;
      ctx.log?.warn?.('clubapi_prices_failed', { resource_id: r.id, code: err.code });
    }
    items.push({ resource_id: r.id, number: r.number, title: r.title, type: r.type, price_now: prices.price_now, price_next: prices.price_next });
  }
  return {
    club: clubJson(club),
    at: iso(now),
    holiday_iso_day: settings.holidayIsoDay,
    rounding_kopecks: settings.rounding,
    holidays: holidays.map((h) => ({ date: h.day, kind: h.kind })),
    rules: rules
      .filter((t) => (kind ? t.resource_type === kind || resourceIds.has(t.resource_id) : true))
      .map((t) => ({
        rule_id: t.id,
        resource_type: t.resource_type,
        resource_id: t.resource_id,
        days: t.days.map(Number),
        start_local: t.start_local,
        end_local: t.end_local,
        price_per_hour_kopecks: Number(t.price_per_hour),
        step_minutes: t.step_minutes,
        min_minutes: t.min_minutes,
        priority: t.priority,
      })),
    tables: items,
  };
}

/** GET /api/v1/club/availability?date=&kind= — свободные интервалы для брони (как у страницы брони). */
export async function availabilityOf(ctx, query) {
  const kind = parseKind(query.kind);
  if (query.date !== undefined && !isDay(query.date)) throw new HttpError(400, 'bad_request', { detail: 'date' });
  const tournaments = ctx.modules?.tournaments ? await import('../tournaments/api.mjs').catch(() => null) : null;
  const deps = { tariffs, engine, ...(tournaments?.tournamentHolds ? { tournaments: { tournamentHolds: tournaments.tournamentHolds } } : {}) };
  const a = await bookingAvailability(ctx.db, { deps, clock: ctx.clock, log: ctx.log }, { clubId: ctx.club, date: query.date });
  return {
    club: { id: a.club.id, name: a.club.name, timezone: a.club.timezone },
    date: a.date,
    from: a.from,
    to: a.to,
    open_at: a.open_at,
    close_at: a.close_at,
    now: a.now,
    step_minutes: a.step_minutes,
    min_minutes: a.min_minutes,
    max_minutes: a.max_minutes,
    lead_minutes: a.lead_minutes,
    max_days: a.max_days,
    tables: a.resources
      .filter((r) => kind === null || r.type === kind)
      .map((r) => ({ resource_id: r.id, number: r.number, title: r.title, type: r.type, free: r.free, busy: r.busy, rates: r.rates })),
  };
}

/**
 * GET /api/v1/club/sales?from&to&kind — продажи по рабочим суткам клуба: та же свёртка и те же
 * столбцы, что CSV дашборда revenue_daily (server/dashboard/export.mjs), только числами (копейки).
 */
export async function salesOf(ctx, query) {
  const db = ctx.db;
  const club = await clubOf(db, ctx.club);
  const now = ctx.clock.now();
  const today = workingDayOf(now, club.timezone, club.day_start_local);
  const q = parseQuery({ from: query.from, to: query.to, kind: query.kind }, { today });
  const res = await collect(db, [club], { fromDay: q.from, toDay: q.to, now, kind: q.kind, enter: async () => {}, wantHourly: false, light: true });
  const byDay = new Map(res.agg.days.map((d) => [d.day, d]));
  const days = dailyRows(res.agg, { kind: q.kind, today }).map((d) => {
    const raw = byDay.get(d.date);
    return {
      date: d.date,
      today: d.today,
      total_kopecks: d.total_kopecks,
      refunds_kopecks: d.refunds_kopecks,
      net_kopecks: d.net_kopecks,
      tables_kopecks: d.tables_kopecks,
      bar_kopecks: d.bar_kopecks,
      other_kopecks: d.other_kopecks,
      by_method: Object.fromEntries(METHODS.map((m) => [m, raw?.revenue?.by_method?.[m] ?? 0])),
      games: d.games,
      avg_check_game_kopecks: d.avg_check_game_kopecks,
      avg_check_bar_kopecks: d.avg_check_bar_kopecks,
      utilization_pct: d.utilization_pct,
    };
  });
  const sum = (f) => days.reduce((acc, d) => acc + f(d), 0);
  return {
    club: clubJson(club),
    period: { from: q.from, to: q.to, today, includes_today: q.from <= today && today <= q.to, missing_days: res.agg.missing_days.map((m) => m.day) },
    kind: q.kind,
    totals: {
      total_kopecks: sum((d) => d.total_kopecks),
      refunds_kopecks: sum((d) => d.refunds_kopecks),
      net_kopecks: sum((d) => d.net_kopecks),
      tables_kopecks: sum((d) => d.tables_kopecks),
      bar_kopecks: sum((d) => d.bar_kopecks),
      other_kopecks: sum((d) => d.other_kopecks),
      by_method: Object.fromEntries(METHODS.map((m) => [m, sum((d) => d.by_method[m])])),
      games: sum((d) => d.games),
    },
    days,
  };
}

function decodeCursor(raw) {
  if (raw === undefined || raw === '') return null;
  try {
    const v = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && !Number.isNaN(Date.parse(v[0])) && isUuid(v[1])) return v;
  } catch {
    // ниже — 400
  }
  throw new HttpError(400, 'bad_request', { detail: 'cursor' });
}

/**
 * GET /api/v1/club/bookings?from&to&kind&status&limit&cursor — брони без ПДн: время, стол, статус,
 * источник. Период — рабочие сутки клуба по дате начала брони, не больше 93 суток.
 */
export async function bookingsOf(ctx, query) {
  const db = ctx.db;
  const club = await clubOf(db, ctx.club);
  const now = ctx.clock.now();
  const today = workingDayOf(now, club.timezone, club.day_start_local);
  const from = query.from ?? today;
  const to = query.to ?? from;
  if (!isDay(from) || !isDay(to) || from > to) throw new HttpError(400, 'bad_request', { detail: 'period' });
  if (daysBetween(from, to) > MAX_BOOKINGS_DAYS) throw new HttpError(400, 'bad_request', { detail: 'period too long' });
  const kind = parseKind(query.kind);
  const STATUSES = ['pending_payment', 'confirmed', 'reserved', 'started', 'expired', 'canceled', 'completed'];
  const status = query.status === undefined || query.status === '' ? null : query.status;
  if (status !== null && !STATUSES.includes(status)) throw new HttpError(400, 'bad_request', { detail: 'status' });
  const limit = query.limit === undefined ? 500 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BOOKINGS_LIMIT) throw new HttpError(400, 'bad_request', { detail: 'limit' });
  const cursor = decodeCursor(query.cursor);
  const lo = dayBounds(from, club.timezone, club.day_start_local).from;
  const hi = dayBounds(to, club.timezone, club.day_start_local).to;
  const { rows } = await db.query(
    `select b.id, b.resource_id, r.number, r.type, b.starts_at, b.ends_at, b.status, b.source, b.created_at, b.canceled_at, b.is_test
       from bl.bookings b join bl.resources r on r.id = b.resource_id
      where b.club_id = $1 and b.starts_at >= $2 and b.starts_at < $3
        and ($4::text is null or r.type = $4) and ($5::text is null or b.status = $5)
        and ($6::timestamptz is null or (b.starts_at, b.id) > ($6::timestamptz, $7::uuid))
      order by b.starts_at, b.id
      limit $8`,
    [club.id, lo, hi, kind, status, cursor ? cursor[0] : null, cursor ? cursor[1] : null, limit + 1],
  );
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    club: clubJson(club),
    period: { from, to },
    items: page.map((b) => ({
      booking_id: b.id,
      resource_id: b.resource_id,
      resource_number: b.number,
      resource_type: b.type,
      starts_at: iso(b.starts_at),
      ends_at: iso(b.ends_at),
      status: b.status,
      source: b.source,
      created_at: iso(b.created_at),
      canceled_at: iso(b.canceled_at),
      test: b.is_test,
    })),
    next_cursor: more ? Buffer.from(JSON.stringify([iso(last.starts_at), last.id])).toString('base64url') : null,
  };
}
