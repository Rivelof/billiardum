// GET /api/clubs/{club}/availability?date= — без входа, без персональных данных (контракт M3 §4).
//
// Рабочие сутки клуба (№43) по местной дате: [date day_start, date+1 day_start). По каждому
// активному столу — занятые интервалы { from, to, kind } (session — идёт игра до paid_until +
// льгота; service — сервисный свет; pending — гость платит; booking — живая бронь; closed —
// нет тарифа, клуб закрыт) и свободные { from, to } от «сейчас», плюс цены по тарифу (rates)
// для расчёта цены брони на клиенте (shared/booking.mjs: bookingPrice). Окончательную цену
// считает сервер при брони.

import { BookingError } from './errors.mjs';
import { LIVE, loadClub, SESSION_OPEN, workdayAt, workdayWindow } from './queries.mjs';
import { bookingSettings } from './settings.mjs';

const MIN = 60_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const iso = (d) => new Date(d).toISOString();

/** Слить пересекающиеся интервалы [{from, to}] (мс). */
export function mergeIntervals(list) {
  const sorted = list.filter((x) => x.to > x.from).sort((a, b) => a.from - b.from);
  const out = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && x.from <= last.to) last.to = Math.max(last.to, x.to);
    else out.push({ from: x.from, to: x.to });
  }
  return out;
}

/** Свободные интервалы окна [from, to) за вычетом занятых. */
export function freeIntervals(from, to, busy) {
  const out = [];
  let cur = from;
  for (const b of mergeIntervals(busy)) {
    if (b.to <= cur) continue;
    if (b.from >= to) break;
    if (b.from > cur) out.push({ from: cur, to: Math.min(b.from, to) });
    cur = Math.max(cur, b.to);
    if (cur >= to) break;
  }
  if (cur < to) out.push({ from: cur, to });
  return out;
}

/**
 * Цены стола по минутам окна: [{ from, to, per_hour_kopecks }] (мс); минуты без правила — пропуск.
 * tariffs — server/tariffs (tariffContext) и engine (ruleAt) money.
 */
async function ratesFor(db, deps, resourceId, fromMs, toMs) {
  const t = await deps.tariffs.tariffContext(db, { resourceId, fromMs, toMs });
  const out = [];
  for (let m = fromMs; m < toMs; m += MIN) {
    const rule = deps.engine.ruleAt(t.rules, t.calendar, m);
    const last = out[out.length - 1];
    if (!rule) continue;
    if (last && last.to === m && last.per_hour_kopecks === rule.price) last.to = m + MIN;
    else out.push({ from: m, to: m + MIN, per_hour_kopecks: rule.price });
  }
  return out;
}

/**
 * @param {import('pg').ClientBase} db транзакция с контекстом клуба (маршрут без входа, клуб из пути)
 * @param {{ deps: object, clock: { now(): Date }, log: object }} env
 */
export async function availability(db, { deps, clock, log }, { clubId, date }) {
  const club = await loadClub(db, clubId);
  if (!club) throw new BookingError('not_found', 'club');
  const settings = bookingSettings(club.settings);
  const now = clock.now();
  const today = (await workdayAt(db, clubId, now)).date;
  const d = date ?? today;
  if (typeof d !== 'string' || !DATE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) throw new BookingError('bad_request', 'date');
  const diff = Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / (1440 * MIN));
  if (diff < 0 || diff > settings.maxDays) throw new BookingError('bad_request', 'date вне окна брони');
  const w = await workdayWindow(db, clubId, d);
  const fromMs = new Date(w.from).getTime();
  const toMs = new Date(w.to).getTime();
  const nowMs = now.getTime();

  const { rows: resources } = await db.query(
    'select id, number, type, title, plan_x, plan_y, plan_rotation from bl.resources where active order by number',
  );
  const { rows: sessions } = await db.query(
    `select resource_id, started_at, paid_until, grace_ms from bl.sessions where status = any($1::text[])`,
    [SESSION_OPEN],
  );
  const { rows: holds } = await db.query(
    `select resource_id, kind, created_at, until from bl.resource_holds
      where released_at is null and until > $1 and kind in ('service', 'pending')`,
    [now],
  );
  const { rows: bookings } = await db.query(
    `select resource_id, starts_at, ends_at from bl.bookings
      where status = any($1::text[]) and period && tstzrange($2, $3, '[)')`,
    [LIVE, w.from, w.to],
  );

  let openAt = null;
  let closeAt = null;
  const out = [];
  for (const r of resources) {
    const busy = [];
    for (const s of sessions.filter((x) => x.resource_id === r.id)) {
      busy.push({ from: Math.max(fromMs, new Date(s.started_at).getTime()), to: new Date(s.paid_until).getTime() + Number(s.grace_ms ?? 0), kind: 'session' });
    }
    for (const h of holds.filter((x) => x.resource_id === r.id)) {
      busy.push({ from: Math.max(fromMs, new Date(h.created_at).getTime()), to: new Date(h.until).getTime(), kind: h.kind });
    }
    for (const b of bookings.filter((x) => x.resource_id === r.id)) {
      busy.push({ from: new Date(b.starts_at).getTime(), to: new Date(b.ends_at).getTime(), kind: 'booking' });
    }
    let rates = [];
    try {
      rates = await ratesFor(db, deps, r.id, fromMs, toMs);
    } catch (err) {
      log?.warn?.('availability_rates_failed', { resource_id: r.id, error: err.message });
    }
    // Минуты без тарифа — клуб закрыт.
    const closed = freeIntervals(fromMs, toMs, rates.map((x) => ({ from: x.from, to: x.to })));
    for (const c of closed) busy.push({ ...c, kind: 'closed' });
    if (rates.length > 0) {
      openAt = Math.min(openAt ?? Infinity, rates[0].from);
      closeAt = Math.max(closeAt ?? -Infinity, rates[rates.length - 1].to);
    }
    const clipped = busy
      .map((b) => ({ ...b, from: Math.max(b.from, fromMs), to: Math.min(b.to, toMs) }))
      .filter((b) => b.to > b.from)
      .sort((a, b) => a.from - b.from || a.to - b.to);
    const free = freeIntervals(Math.max(fromMs, nowMs), toMs, clipped);
    out.push({
      id: r.id,
      number: r.number,
      type: r.type,
      title: r.title,
      plan: { x: r.plan_x, y: r.plan_y, rotation: r.plan_rotation },
      busy: clipped.map((b) => ({ from: iso(b.from), to: iso(b.to), kind: b.kind })),
      free: free.map((f) => ({ from: iso(f.from), to: iso(f.to) })),
      rates: rates.map((x) => ({ from: iso(x.from), to: iso(x.to), per_hour_kopecks: x.per_hour_kopecks })),
    });
  }
  return {
    club: { id: club.id, name: club.name, timezone: club.timezone, plan: club.settings?.plan ?? null },
    date: d,
    from: iso(fromMs),
    to: iso(toMs),
    open_at: iso(openAt ?? fromMs),
    close_at: iso(closeAt ?? toMs),
    now: iso(nowMs),
    step_minutes: settings.stepMinutes,
    min_minutes: settings.minMinutes,
    max_minutes: settings.maxMinutes,
    lead_minutes: settings.leadMinutes,
    max_days: settings.maxDays,
    rules: {
      prepayment: settings.prepayment,
      deposit_kopecks: settings.prepayment === 'deposit' ? settings.depositKopecks : 0,
      hold_minutes: settings.holdMinutes,
      hold_prepaid_minutes: settings.holdPrepaidMinutes,
      free_cancel_minutes: settings.freeCancelMinutes,
    },
    resources: out,
  };
}
