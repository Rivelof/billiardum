// Расчёт одних рабочих суток клуба для дашборда (M5.2 №167–171). Одна функция для закрытых суток
// (планировщик пишет итог в bl.stats_daily и bl.stats_hourly) и для текущих (на лету): одна формула.
//
// * Деньги — те же запросы и та же свёртка, что у отчёта смены и утренней сводки
//   (server/reports/queries.mjs: shiftPayments, shiftRefunds, revenueOf, №168): выручка — платежи,
//   подтверждённые в сутках; возвраты уменьшают выручку в сутки возврата. Тестовые записи (is_test)
//   эти запросы не берут.
// * №187 (уточнение №167): игра (количество) — в сутках начала; часы игры и загрузка — фактические
//   минуты внутри каждых суток (игра 05:30–07:00 при начале суток 06:00: одна игра и 30 минут в
//   прошлых сутках, 60 минут — в следующих). Так же сервисный свет (число — по включению) и брони
//   (число — по началу). Те же правила у утренней сводки и отчёта смены (playStats).
// * Ёмкость (№170) — минуты, когда стол в работе и клуб открыт; стол, выведенный из работы, не входит
//   с момента вывода (журнал resource.activate/deactivate и manual.resource_add/remove). У текущих
//   суток ёмкость — до «сейчас».
// Все запросы — в транзакции с контекстом клуба (RLS отсекает чужое).

import { maskPhones } from '../notify/index.mjs';
import { manualActions, revenueOf, shiftLateRefunds, shiftPayments, shiftRefunds } from '../reports/queries.mjs';
import { dayBounds, localParts, openWindows, overlapMs, sliceByHour } from './time.mjs';

/**
 * Версия формул: закрытые сутки старой версии планировщик пересчитывает (порциями, вне часов пик —
 * server/dashboard/index.mjs). Поднимать при любой правке расчёта суток.
 *   1 — M5.2.
 *   2 — ёмкость округляется один раз на сутки (Н1, apportionMinutes): карта = кольцо.
 */
export const VERSION = 2;
export const TYPES = ['billiard_pyramid', 'billiard_pool', 'billiard_snooker'];
export const METHODS = ['cash', 'card_terminal', 'sbp', 'card'];
export const SOURCES = ['qr', 'booking', 'reception', 'staff', 'tournament'];
/** Команды, при которых свет над столом горит. */
export const LIGHT_CMDS = ['session.start', 'session.resume', 'session.extend', 'service.start'];
/** Тревога, принятая позже этого, — проблемная (№178). */
export const SLOW_ACK_MS = 10 * 60_000;
const MINUTE = 60_000;
const ITEMS_LIMIT = 200;
const ACTIVATE = new Set(['resource.activate', 'manual.resource_add']);
const DEACTIVATE = new Set(['resource.deactivate', 'manual.resource_remove']);
const STAFF_ROLES = ['owner', 'manager', 'reception', 'bar', 'installer'];

const min = (ms) => Math.round(ms / MINUTE);
const zero = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));
const iso = (d) => (d ? new Date(d).toISOString() : null);

/**
 * Интервалы «в работе» стола [{from, to}] (мс) с создания до horizon.
 * events — записи журнала стола по порядку (action, created_at).
 */
export function operationIntervals(resource, events, horizon) {
  const out = [];
  const start = new Date(resource.created_at).getTime();
  const list = events.filter((e) => ACTIVATE.has(e.action) || DEACTIVATE.has(e.action));
  // Состояние до первого события — противоположное ему; без событий — текущее.
  let active = list.length ? DEACTIVATE.has(list[0].action) : Boolean(resource.active);
  let since = start;
  for (const e of list) {
    const t = Math.max(start, new Date(e.created_at).getTime());
    const next = ACTIVATE.has(e.action);
    if (active && !next && t > since) out.push({ from: since, to: t });
    if (!active && next) since = t;
    active = next;
  }
  if (active && horizon > since) out.push({ from: since, to: horizon });
  return out;
}

function intersect(a, b) {
  const out = [];
  for (const x of a) {
    for (const y of b) {
      const lo = Math.max(x.from, y.from);
      const hi = Math.min(x.to, y.to);
      if (hi > lo) out.push({ from: lo, to: hi });
    }
  }
  return out;
}

function emptyResource(r) {
  return { number: r.number, title: r.title ?? null, type: r.type, games: 0, play_ms: 0, service_ms: 0, booking_ms: 0, capacity_ms: 0, revenue_kopecks: 0, refunds_kopecks: 0 };
}

/** Строки часов: ключ `${resource}|${hour}`. */
function addHour(hours, resourceId, hour, field, value) {
  const k = `${resourceId}|${hour}`;
  let h = hours.get(k);
  if (!h) {
    h = { resource_id: resourceId, hour, play_ms: 0, service_ms: 0, booking_ms: 0, capacity_ms: 0, games: 0 };
    hours.set(k, h);
  }
  h[field] += value;
}

/** Вывод столов из работы и возврат — журнал клуба; запоминается на минуту (догоняющий пересчёт суток). */
const eventsMemo = new Map();
const EVENTS_TTL_MS = 60_000;
async function resourceEvents(db, clubId, nowMs) {
  const hit = eventsMemo.get(clubId);
  if (hit && Math.abs(nowMs - hit.at) < EVENTS_TTL_MS && hit.realAt > Date.now() - EVENTS_TTL_MS) return hit;
  const { rows } = await db.query(
    `select object_id, action, created_at from bl.audit_log
      where club_id = $1 and object_type = 'resource'
        and action = any('{resource.activate,resource.deactivate,manual.resource_add,manual.resource_remove}'::text[])
      order by seq`,
    [clubId],
  );
  const out = { rows, at: nowMs, realAt: Date.now() };
  if (eventsMemo.size > 1000) eventsMemo.clear();
  eventsMemo.set(clubId, out);
  return out;
}

/**
 * Целые минуты по ячейкам так, чтобы сумма ячеек = округлению суммы (Н1 M5.2): округляется
 * накопленная сумма, ячейка — разность соседних округлений. Каждая ячейка отличается от точного
 * значения меньше чем на минуту. values — миллисекунды в фиксированном порядке.
 */
export function apportionMinutes(values) {
  let acc = 0;
  let prev = 0;
  return values.map((ms) => {
    acc += ms;
    const cur = min(acc);
    const out = cur - prev;
    prev = cur;
    return out;
  });
}

/** Источник денег (§3 «Деньги»): QR гостя, касса ресепшена, онлайн-бронь, турнир. */
export function sourceOf(p) {
  if (p.provider === 'reception') return 'reception';
  if (p.kind === 'booking') return 'booking';
  if (p.kind === 'tournament') return 'tournament';
  return 'qr';
}

/** Медиана массива чисел (null у пустого). */
export function median(list) {
  if (!list.length) return null;
  const a = [...list].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round(((a[m - 1] + a[m]) / 2) * 10) / 10;
}

/**
 * Сутки day клуба club = { id, timezone, day_start_local, settings }.
 * @returns {Promise<{ daily: object, hourly: object[] }>}
 */
export async function computeDay(db, { club, day, now }) {
  const tz = club.timezone;
  const { from, to: toExcl } = dayBounds(day, tz, club.day_start_local);
  const nowMs = now.getTime();
  const live = nowMs < toExcl.getTime();
  const cut = Math.min(nowMs, toExcl.getTime());
  // Конец интервала выборок — включительно, как у утренней сводки (конец суток − 1 мс) или «сейчас».
  const to = new Date(Math.max(from.getTime(), cut - (live ? 0 : 1)));
  const clubId = club.id;

  // Деньги — формулы отчёта смены (№168).
  const payments = await shiftPayments(db, { clubId, from, to });
  const refunds = await shiftRefunds(db, { clubId, from, to });
  const late = await shiftLateRefunds(db, { clubId, from, to });
  const rev = revenueOf(payments, refunds, late);
  const structure = { tables: 0, deposits: 0, bar: rev.bar.total_kopecks, packages: rev.packages.total_kopecks, tournaments: rev.tournaments.total_kopecks, other: rev.other.total_kopecks };
  const sources = zero(['qr', 'reception', 'booking', 'tournament']);
  let barCount = 0;
  let tablePayments = 0;
  for (const p of payments) {
    if (!METHODS.includes(p.method) || p.counted_kopecks <= 0) continue;
    sources[sourceOf(p)] += p.counted_kopecks;
    if (p.category === 'tables') {
      tablePayments += 1;
      if (p.deposit) structure.deposits += p.counted_kopecks;
    }
    if (p.kind === 'bar' && p.counted_kopecks - (p.package_kopecks ?? 0) > 0) barCount += 1;
  }
  structure.tables = rev.tables.total_kopecks - structure.deposits;

  // Столы: в работе, ёмкость по часам.
  const res = await db.query('select id, number, title, type, active, created_at from bl.resources where club_id = $1 order by number', [clubId]);
  const ev = await resourceEvents(db, clubId, nowMs);
  const byResEvents = new Map();
  for (const e of ev.rows) {
    if (!byResEvents.has(e.object_id)) byResEvents.set(e.object_id, []);
    byResEvents.get(e.object_id).push(e);
  }
  const resources = {};
  const hours = new Map();
  const windows = openWindows(day, tz, club.day_start_local, club.settings ?? {}).map((w) => ({ from: w.from.getTime(), to: Math.min(w.to.getTime(), cut) }));
  const slots = sliceByHour(from, new Date(cut), tz);
  let tablesInOperation = 0;
  const tablesByType = zero(TYPES);
  for (const r of res.rows) {
    const op = intersect(operationIntervals(r, byResEvents.get(r.id) ?? [], cut), windows);
    let cap = 0;
    for (const s of slots) {
      const ms = overlapMs(s.from, s.to, op.map((x) => ({ from: x.from, to: x.to })));
      if (ms > 0) {
        addHour(hours, r.id, s.hour, 'capacity_ms', ms);
        cap += ms;
      }
    }
    resources[r.id] = emptyResource(r);
    resources[r.id].capacity_ms = cap;
    if (cap > 0) {
      tablesInOperation += 1;
      if (r.type in tablesByType) tablesByType[r.type] += 1;
    }
  }
  const resOf = (id) => resources[id] ?? null;

  // №187: игра (количество) — в сутках начала; минуты игры, сервиса и брони — фактические минуты
  // внутри суток (до «сейчас» у текущих), в местных часах своего времени. Так же считают утренняя
  // сводка и отчёт смены (playStats).
  const lo = from.getTime();
  const clip = (a1, a2) => [Math.max(a1, lo), Math.min(a2, cut)];
  const ss = await db.query(
    `select s.id, s.resource_id, s.source, s.started_at, coalesce(s.ended_at, s.interrupted_at) as end_at
       from bl.sessions s
      where s.club_id = $1 and s.started_at < $3 and coalesce(s.ended_at, s.interrupted_at, $3) > $2
        and s.status <> 'cancelled' and not s.is_test
      order by s.started_at`,
    [clubId, from, new Date(cut)],
  );
  const bySource = zero(SOURCES);
  let playMs = 0;
  let games = 0;
  for (const s of ss.rows) {
    const r = resOf(s.resource_id);
    if (!r) continue;
    const st = new Date(s.started_at);
    if (st >= from && st <= to) {
      games += 1;
      r.games += 1;
      if (s.source in bySource) bySource[s.source] += 1;
      addHour(hours, s.resource_id, localParts(st, tz).hour, 'games', 1);
    }
    const [c1, c2] = clip(st.getTime(), Math.min(s.end_at ? new Date(s.end_at).getTime() : nowMs, nowMs));
    if (c2 > c1) {
      for (const sl of sliceByHour(new Date(c1), new Date(c2), tz)) addHour(hours, s.resource_id, sl.hour, 'play_ms', sl.ms);
      r.play_ms += c2 - c1;
      playMs += c2 - c1;
    }
  }

  // Выручка и возвраты столов по столам.
  for (const p of payments) if (p.category === 'tables' && p.resource_id && resOf(p.resource_id)) resOf(p.resource_id).revenue_kopecks += p.counted_kopecks;
  for (const f of refunds) if (f.category === 'tables' && f.resource_id && resOf(f.resource_id)) resOf(f.resource_id).refunds_kopecks += f.amount_kopecks;

  // Сервисный свет: число — включённые в сутках, минуты — внутри суток.
  const sv = await db.query(
    `select h.resource_id, h.created_at, coalesce(h.released_at, h.until) as end_at
       from bl.resource_holds h
      where h.club_id = $1 and h.kind = 'service' and h.created_at < $3 and coalesce(h.released_at, h.until) > $2`,
    [clubId, from, new Date(cut)],
  );
  let serviceMs = 0;
  let serviceCount = 0;
  for (const h of sv.rows) {
    const r = resOf(h.resource_id);
    if (!r) continue;
    const st = new Date(h.created_at);
    if (st >= from && st <= to) serviceCount += 1;
    const [c1, c2] = clip(st.getTime(), new Date(h.end_at).getTime());
    if (c2 <= c1) continue;
    for (const sl of sliceByHour(new Date(c1), new Date(c2), tz)) addHour(hours, h.resource_id, sl.hour, 'service_ms', sl.ms);
    r.service_ms += c2 - c1;
    serviceMs += c2 - c1;
  }

  // Брони: количества — по началу брони, минуты удержания стола — внутри суток.
  const bk = await db.query(
    `select b.resource_id, b.status, b.expire_reason, b.starts_at, b.ends_at, b.created_at, b.user_id
       from bl.bookings b
      where b.club_id = $1 and b.starts_at < $3 and b.ends_at > $2 and not b.is_test`,
    [clubId, from, toExcl],
  );
  const bookings = { total: 0, came: 0, no_show: 0, canceled: 0, upcoming: 0, lead_minutes_sum: 0, lead_count: 0, minutes: 0 };
  for (const b of bk.rows) {
    if (b.status === 'pending_payment' || (b.status === 'expired' && b.expire_reason === 'unpaid')) continue;
    const st = new Date(b.starts_at);
    const mine = st >= from && st <= to;
    const held = ['confirmed', 'reserved', 'started', 'completed'].includes(b.status) || (b.status === 'expired' && b.expire_reason === 'no_show');
    if (mine) {
      bookings.total += 1;
      if (b.status === 'started' || b.status === 'completed') {
        bookings.came += 1;
        bookings.lead_minutes_sum += Math.max(0, min(st - new Date(b.created_at)));
        bookings.lead_count += 1;
      } else if (b.status === 'expired' && b.expire_reason === 'no_show') bookings.no_show += 1;
      else if (b.status === 'canceled') bookings.canceled += 1;
      else if (b.status === 'confirmed' || b.status === 'reserved') bookings.upcoming += 1;
    }
    const r = resOf(b.resource_id);
    if (held && r) {
      // Бронь — плановое удержание: минуты внутри суток (в том числе будущие часы текущих суток).
      const c1 = Math.max(st.getTime(), lo);
      const c2 = Math.min(new Date(b.ends_at).getTime(), toExcl.getTime());
      if (c2 > c1) {
        for (const sl of sliceByHour(new Date(c1), new Date(c2), tz)) addHour(hours, b.resource_id, sl.hour, 'booking_ms', sl.ms);
        r.booking_ms += c2 - c1;
      }
    }
  }
  bookings.minutes = min(Object.values(resources).reduce((a, r) => a + r.booking_ms, 0));

  // Лист ожидания: предложено, занято.
  const wl = await db.query(
    `select count(*) filter (where offered_at >= $2 and offered_at <= $3)::int as offered,
            count(*) filter (where accepted_at >= $2 and accepted_at <= $3)::int as accepted
       from bl.waitlist where club_id = $1 and (offered_at >= $2 or accepted_at >= $2)`,
    [clubId, from, to],
  );

  // Продления: оплаченные (в том числе пакетом минут) и без оплаты (ручное действие).
  const ex = await db.query(
    `select provider, count(*)::int as n from bl.payments
      where club_id = $1 and kind = 'extend' and status = 'succeeded' and confirmed_at >= $2 and confirmed_at <= $3 and not is_test
      group by provider`,
    [clubId, from, to],
  );
  const extensions = { paid: 0, from_app: 0, free: 0, total: 0 };
  for (const r of ex.rows) {
    extensions.paid += r.n;
    if (r.provider === 'yookassa' || r.provider === 'balance') extensions.from_app += r.n;
  }

  // Пакеты часов: продано (партии минут по покупкам), использовано (списания минут без возврата).
  const pk = await db.query(
    `select (select count(*)::int from bl.balance_lots l join bl.payments p on p.id = l.payment_id
              where l.club_id = $1 and l.created_at >= $2 and l.created_at <= $3 and not p.is_test) as sold,
            (select coalesce(sum(l.minutes_total), 0)::int from bl.balance_lots l join bl.payments p on p.id = l.payment_id
              where l.club_id = $1 and l.created_at >= $2 and l.created_at <= $3 and not p.is_test) as sold_minutes,
            (select coalesce(sum(d.minutes), 0)::int from bl.balance_debits d join bl.payments p on p.id = d.payment_id
              where d.club_id = $1 and d.created_at >= $2 and d.created_at <= $3 and d.restored_at is null and not p.is_test) as used_minutes`,
    [clubId, from, to],
  );

  // Турниры и Бильярдум+.
  const tr = await db.query(
    `select (select count(*)::int from bl.tournament_entries e
              where e.club_id = $1 and e.status = 'confirmed' and e.confirmed_at >= $2 and e.confirmed_at <= $3 and not e.is_test) as participants,
            (select count(*)::int from bl.matches m
              where m.club_id = $1 and m.status = 'counted' and m.counted_at >= $2 and m.counted_at <= $3 and not m.is_test) as matches`,
    [clubId, from, to],
  );

  // Гости (№171): только количества. Гость — участник игры или автор брони, не сотрудник клуба.
  const gq = await db.query(
    `with acts as (
       select sp.user_id, s.started_at as at, true as game
         from bl.session_participants sp join bl.sessions s on s.id = sp.session_id
        where s.club_id = $1 and s.started_at >= $2 and s.started_at <= $3 and s.status <> 'cancelled' and not s.is_test
       union all
       select b.user_id, b.created_at, false
         from bl.bookings b
        where b.club_id = $1 and b.user_id is not null and b.created_at >= $2 and b.created_at <= $3 and not b.is_test
          and b.status <> 'pending_payment' and not (b.status = 'expired' and b.expire_reason = 'unpaid')
     ), guests as (
       select a.user_id, bool_or(a.game) as played
         from acts a
        where not exists (select 1 from bl.club_members m where m.club_id = $1 and m.user_id = a.user_id and m.role = any($4::text[]))
        group by a.user_id
     )
     select count(*) filter (where g.played)::int as active,
            count(*) filter (where not exists (
              select 1 from bl.session_participants sp join bl.sessions s on s.id = sp.session_id
               where sp.user_id = g.user_id and s.club_id = $1 and s.started_at < $2 and s.status <> 'cancelled' and not s.is_test)
              and not exists (
              select 1 from bl.bookings b where b.user_id = g.user_id and b.club_id = $1 and b.created_at < $2 and not b.is_test
                 and b.status <> 'pending_payment' and not (b.status = 'expired' and b.expire_reason = 'unpaid')))::int as new
       from guests g`,
    [clubId, from, to, STAFF_ROLES],
  );

  // Ручные действия (инвариант 8, №125): формулы отчёта смены; имена — при чтении.
  const manual = await manualActions(db, { clubId, from, to, limit: 100_000 });
  const byStaff = {};
  for (const it of manual.items) {
    if (!it.actor_id) continue;
    const s = (byStaff[it.actor_id] ??= { count: 0, by_action: {} });
    s.count += 1;
    s.by_action[it.action] = (s.by_action[it.action] ?? 0) + 1;
  }
  extensions.free = manual.by_action['manual.extend_free'] ?? 0;
  extensions.total = extensions.paid + extensions.free;

  // Тревоги и реакция на них (№178).
  const al = await db.query(
    `select a.id, a.type, a.level, a.raised_at, a.acked_at, a.acked_by, r.number as resource_number
       from bl.alarms a left join bl.resources r on r.id = a.resource_id
      where a.club_id = $1 and a.raised_at >= $2 and a.raised_at <= $3
      order by a.raised_at`,
    [clubId, from, to],
  );
  const alarms = { total: 0, by_level: zero(['critical', 'important', 'info']), by_type: {}, by_staff: {}, problems: [] };
  for (const a of al.rows) {
    alarms.total += 1;
    if (a.level in alarms.by_level) alarms.by_level[a.level] += 1;
    const t = (alarms.by_type[a.type] ??= { count: 0, acked: 0, react_ms_sum: 0, slow: 0, unacked: 0 });
    t.count += 1;
    const react = a.acked_at ? Math.max(0, new Date(a.acked_at) - new Date(a.raised_at)) : null;
    if (react === null) t.unacked += 1;
    else {
      t.acked += 1;
      t.react_ms_sum += react;
      if (react > SLOW_ACK_MS) t.slow += 1;
      if (a.acked_by) {
        const s = (alarms.by_staff[a.acked_by] ??= { count: 0, react_ms_sum: 0, slow: 0 });
        s.count += 1;
        s.react_ms_sum += react;
        if (react > SLOW_ACK_MS) s.slow += 1;
      }
    }
    if ((react === null || react > SLOW_ACK_MS) && alarms.problems.length < ITEMS_LIMIT) {
      alarms.problems.push({
        alarm_id: a.id,
        type: a.type,
        level: a.level,
        resource_number: a.resource_number ?? null,
        raised_at: iso(a.raised_at),
        acked_at: iso(a.acked_at),
        acked_by: a.acked_by ?? null,
        react_sec: react === null ? null : Math.round(react / 1000),
      });
    }
  }

  // Смены, закрытые в сутках (у текущих — и открытая): касса и расхождения.
  const sh = await db.query(
    `select id, number, opened_at, opened_by, closed_at, closed_by, float_kopecks, cash_sales_kopecks, cash_refunds_kopecks,
            expected_cash_kopecks, actual_cash_kopecks, discrepancy_kopecks
       from bl.shifts
      where club_id = $1 and not is_test
        and ((closed_at >= $2 and closed_at <= $3) or (opened_at >= $2 and opened_at <= $3) or ($4 and closed_at is null))
      order by opened_at`,
    [clubId, from, to, live],
  );
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  const shifts = sh.rows.map((s) => ({
    shift_id: s.id,
    number: s.number,
    opened_at: iso(s.opened_at),
    closed_at: iso(s.closed_at),
    opened_by: s.opened_by,
    closed_by: s.closed_by ?? null,
    float_kopecks: num(s.float_kopecks),
    cash_sales_kopecks: num(s.cash_sales_kopecks),
    cash_refunds_kopecks: num(s.cash_refunds_kopecks),
    expected_cash_kopecks: num(s.expected_cash_kopecks),
    actual_cash_kopecks: num(s.actual_cash_kopecks),
    discrepancy_kopecks: num(s.discrepancy_kopecks),
    // Закрыта в этих сутках: расхождение относится к ним.
    closed_here: s.closed_at !== null && new Date(s.closed_at) >= from && new Date(s.closed_at) <= to,
    opened_here: new Date(s.opened_at) >= from && new Date(s.opened_at) <= to,
  }));

  // Метрики пилота (PRODUCT §21).
  // Скан → свет: котировка гостя по QR (первое действие сервера после скана) → ack контроллера на
  // session.start этой игры; только игры по QR с оплатой ЮKassa.
  const sl = await db.query(
    `select extract(epoch from (c.acked_at - q.created_at))::float8 as sec
       from bl.sessions s
       join bl.payments p on p.session_id = s.id and p.kind = 'start' and p.provider = 'yookassa'
       join bl.quotes q on q.id = p.quote_id
       join lateral (select min(dc.acked_at) as acked_at from bl.device_commands dc
                      where dc.session_id = s.id and dc.type = 'session.start' and dc.status = 'acked') c on c.acked_at is not null
      where s.club_id = $1 and s.source = 'qr' and s.started_at >= $2 and s.started_at <= $3 and not s.is_test`,
    [clubId, from, to],
  );
  const scan = sl.rows.map((r) => Math.max(0, Math.round(r.sec))).filter((x) => Number.isFinite(x));
  // Свет без журнала: команда включения ушла контроллеру (sent/acked), а записи device.cmd с её id нет;
  // игра без записи session.start. Цель — 0.
  // Один проход по журналу клуба (хеш-антисоединение), а не подзапрос на каждую команду и игру.
  const lj = await db.query(
    `with cmds as (
       select c.id::text as id from bl.device_commands c
        where c.club_id = $1 and c.type = any($4::text[]) and c.status in ('sent', 'acked') and c.created_at >= $2 and c.created_at <= $3
     ), games as (
       select s.id from bl.sessions s
        where s.club_id = $1 and s.started_at >= $2 and s.started_at <= $3 and s.status <> 'cancelled' and not s.is_test
     ), logged as (
       select a.action, a.object_id, a.data->>'cmd_id' as cmd_id from bl.audit_log a
        where a.club_id = $1 and a.action in ('device.cmd', 'session.start') and a.created_at >= $2::timestamptz - interval '1 day'
          and (exists (select 1 from cmds) or exists (select 1 from games))
     )
     select (select count(*)::int from cmds where id not in (select cmd_id from logged where action = 'device.cmd' and cmd_id is not null)) as commands,
            (select count(*)::int from games where id not in (select object_id from logged where action = 'session.start' and object_id is not null)) as sessions`,
    [clubId, from, to, LIGHT_CMDS],
  );

  // Итог.
  // Ёмкость округляется один раз: по ячейкам стола и часа накопленной суммой (столы по номеру, часы
  // по порядку); стол и итог — суммы своих ячеек. Сумма тепловой карты = кольцу (Н1 M5.2).
  const hourList = [...hours.values()];
  const capMinutes = apportionMinutes(hourList.map((h) => h.capacity_ms));
  const capByResource = new Map();
  hourList.forEach((h, i) => {
    h.capacity_minutes = capMinutes[i];
    capByResource.set(h.resource_id, (capByResource.get(h.resource_id) ?? 0) + capMinutes[i]);
  });
  const resourcesOut = {};
  for (const [id, r] of Object.entries(resources)) {
    resourcesOut[id] = {
      number: r.number,
      title: r.title,
      type: r.type,
      games: r.games,
      play_minutes: min(r.play_ms),
      service_minutes: min(r.service_ms),
      booking_minutes: min(r.booking_ms),
      capacity_minutes: capByResource.get(id) ?? 0,
      revenue_kopecks: r.revenue_kopecks,
      refunds_kopecks: r.refunds_kopecks,
    };
  }
  const capacityMinutes = capMinutes.reduce((a, x) => a + x, 0);
  const hourly = hourList
    .map((h) => ({
      resource_id: h.resource_id,
      hour: h.hour,
      play_minutes: min(h.play_ms),
      service_minutes: min(h.service_ms),
      booking_minutes: min(h.booking_ms),
      capacity_minutes: h.capacity_minutes,
      games: h.games,
    }))
    .filter((h) => h.play_minutes || h.service_minutes || h.booking_minutes || h.capacity_minutes || h.games)
    .sort((a, b) => (a.resource_id < b.resource_id ? -1 : a.resource_id > b.resource_id ? 1 : a.hour - b.hour));

  const daily = {
    v: VERSION,
    day,
    from: from.toISOString(),
    to: toExcl.toISOString(),
    live,
    totals: {
      revenue_total_kopecks: rev.total_kopecks,
      refunds_kopecks: rev.refunds.total_kopecks,
      net_kopecks: rev.net_kopecks,
      games,
      play_minutes: min(playMs),
      capacity_minutes: capacityMinutes,
    },
    revenue: {
      total_kopecks: rev.total_kopecks,
      net_kopecks: rev.net_kopecks,
      by_method: rev.by_method,
      structure,
      sources,
      tables_kopecks: rev.tables.total_kopecks,
      holds_kopecks: rev.holds_kopecks,
      late_returned_kopecks: rev.late_returned.total_kopecks,
      refunds: {
        total_kopecks: rev.refunds.total_kopecks,
        count: rev.refunds.count,
        by_method: rev.refunds.by_method,
        tables_kopecks: rev.refunds.tables_kopecks,
        bar_kopecks: rev.refunds.bar_kopecks,
      },
      payments_count: rev.payments_count,
      table_payments: tablePayments,
      bar_sales: barCount,
    },
    resources: resourcesOut,
    tables_in_operation: tablesInOperation,
    tables_by_type: tablesByType,
    games: { total: games, by_source: bySource, no_staff: bySource.qr + bySource.booking },
    service: { count: serviceCount, minutes: min(serviceMs) },
    extensions,
    bookings,
    waitlist: { offered: wl.rows[0].offered, accepted: wl.rows[0].accepted },
    packages: { sold: pk.rows[0].sold, sold_minutes: pk.rows[0].sold_minutes, used_minutes: pk.rows[0].used_minutes },
    tournaments: { fees_kopecks: rev.tournaments.total_kopecks, participants: tr.rows[0].participants },
    plus: { matches_counted: tr.rows[0].matches },
    guests: { active: gq.rows[0].active, new: gq.rows[0].new },
    manual: {
      count: manual.count,
      by_action: manual.by_action,
      by_staff: byStaff,
      automatic: { count: manual.automatic.count, by_action: manual.automatic.by_action },
      items: manual.items.slice(0, ITEMS_LIMIT).map((it) => ({
        at: it.at,
        action: it.action,
        kind: it.kind,
        actor_id: it.actor_id,
        // Причина — текст сотрудника: номера телефонов маскируются.
        reason: it.reason ? maskPhones(it.reason) : null,
        resource_number: it.resource_number,
        amount_kopecks: it.amount_kopecks,
      })),
    },
    alarms,
    shifts,
    pilot: { scan_to_light_sec: scan, lights_without_journal: lj.rows[0].commands, sessions_without_journal: lj.rows[0].sessions },
  };
  return { daily, hourly };
}
