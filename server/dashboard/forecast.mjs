// Прогноз загрузки и подсказки по цене (M5.6, docs/contracts/m5-5-8.md №196–197).
//
// * История — закрытые рабочие сутки клуба за последние FORECAST_WEEKS недель (по вчерашние) из
//   агрегатов дашборда bl.stats_hourly (минуты игры и ёмкость по столу и местному часу). Сутки без
//   агрегата (планировщик ещё не досчитал) не входят. Тестовые записи (is_test) в агрегатах не
//   учитываются уже при расчёте суток; кроме того, сутки до перехода клуба в live (went_live_at)
//   не входят, клуб, ни разу не бывший в live, прогноза не имеет.
// * Праздник клуба (bl.holidays: федеральный календарь и свои дни клуба) считается выходным, как у
//   тарифов: его сутки идут в день недели holiday_iso_day клуба (по умолчанию 7 — воскресенье), в
//   будни подсказок не входят. Прогноз на дату-праздник берётся из строки этого дня недели.
// * Прогноз ячейки (день недели × местный час) — медиана загрузки этой ячейки по суткам истории
//   (загрузка суток в часе = сыграно / ёмкость, до 100 %); часы, когда клуб закрыт (ёмкость 0), в
//   медиану не входят. Меньше MIN_HISTORY_DAYS суток истории — прогноза нет (status
//   insufficient_data, честное «мало данных»).
// * Подсказки — только текст, цены не меняются (№197). Пороги — HINTS (описание в README).
//
// Чистая логика (forecastFrom, hintsFrom, forecastForDate) — без базы, тестируется отдельно.

import { plural } from '@billiardum/shared/format';
import { clubTariffSettings } from '../tariffs/index.mjs';
import { firstDayOf } from './store.mjs';
import { addDays, daysBetween, isoDow, workingDayOf } from './time.mjs';

export const FORECAST_WEEKS = 8;
/** Меньше двух недель истории — прогноза и подсказок нет. */
export const MIN_HISTORY_DAYS = 14;
export const FORECAST_LABEL = 'прогноз';

/**
 * Пороги подсказок по цене (№197):
 *   LOW_PCT, LOW_MIN_HOURS — «дневная цена»: по будням загрузка часа ниже LOW_PCT % подряд не меньше
 *     LOW_MIN_HOURS часов;
 *   HIGH_PCT, HIGH_MIN_HOURS — «можно поднять цену»: в день недели загрузка часа выше HIGH_PCT % или
 *     очередь подряд не меньше HIGH_MIN_HOURS часов;
 *   QUEUE_SHARE — «очередь» в часе: гости вставали в лист ожидания не меньше чем в этой доле таких дней;
 *   MIN_WEEKS — час входит, только если данные по нему есть не меньше чем за столько разных недель;
 *   MAX_HINTS — не больше подсказок в ответе.
 */
export const HINTS = Object.freeze({ LOW_PCT: 20, LOW_MIN_HOURS: 3, HIGH_PCT: 85, HIGH_MIN_HOURS: 2, QUEUE_SHARE: 0.5, MIN_WEEKS: 4, MAX_HINTS: 10 });

const DOW_ACC = { 1: 'понедельник', 2: 'вторник', 3: 'среду', 4: 'четверг', 5: 'пятницу', 6: 'субботу', 7: 'воскресенье' };
const WEEKS_ACC = ['неделю', 'недели', 'недель'];
const DAYS_GEN = ['дня', 'дней', 'дней'];

const r1 = (x) => Math.round(x * 10) / 10;
const pad = (h) => String(h).padStart(2, '0');
const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const pctText = (x) => `${nf.format(x)} %`;
const weekOf = (day) => addDays(day, 1 - isoDow(day));

/** Медиана (null у пустого), без округления. */
export function medianOf(list) {
  if (!list.length) return null;
  const a = [...list].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Порядок местных часов внутри рабочих суток (с часа начала суток). */
export function hourOrder(dayStartLocal = '06:00') {
  const h0 = Number(String(dayStartLocal).slice(0, 2)) || 0;
  return Array.from({ length: 24 }, (_, i) => (h0 + i) % 24);
}

/** День недели суток для прогноза: праздник — holidayIsoDay (как у тарифов). */
export function basisDow(day, holidays, holidayIsoDay = 7) {
  return holidays.has(day) ? holidayIsoDay : isoDow(day);
}

/**
 * Окно истории клуба: { from, to, today } (рабочие сутки) или null — клуб не был в live.
 * from — не раньше первых суток клуба и суток перехода в live.
 */
export function historyWindow(club, now) {
  const today = workingDayOf(now, club.timezone, club.day_start_local);
  const to = addDays(today, -1);
  let from = addDays(to, -(FORECAST_WEEKS * 7 - 1));
  const testOnly = club.mode === 'test' || (club.mode === 'suspended' && club.mode_before_suspend === 'test');
  if (testOnly) return null;
  const first = firstDayOf(club);
  if (first > from) from = first;
  if (club.went_live_at) {
    const live = workingDayOf(new Date(club.went_live_at), club.timezone, club.day_start_local);
    if (live > from) from = live;
  }
  return { from, to, today };
}

/**
 * История клуба из агрегатов: { window, days: [{ day, dow, holiday, hours: [{play, cap, queue}] × 24 }],
 * holidays: Map(day → title), holidayIsoDay, order }. kind — тип стола (null — все).
 */
export async function loadHistory(db, club, { now, kind = null }) {
  const settings = clubTariffSettings(club.settings);
  const order = hourOrder(club.day_start_local);
  const window = historyWindow(club, now);
  const out = { window, days: [], holidays: new Map(), holidayIsoDay: settings.holidayIsoDay, order };
  if (!window || window.from > window.to) return out;
  const hol = await db.query(
    `select day::text as day, title from bl.holidays where day between $1::date and $2::date and (club_id is null or club_id = $3) order by day, club_id nulls first`,
    [window.from, addDays(window.today, 400), club.id],
  );
  for (const h of hol.rows) out.holidays.set(h.day, h.title);
  const stored = await db.query('select day::text as day from bl.stats_daily where club_id = $1 and day between $2 and $3 order by day', [club.id, window.from, window.to]);
  const byDay = new Map();
  for (const r of stored.rows) {
    const d = { day: r.day, dow: basisDow(r.day, out.holidays, out.holidayIsoDay), holiday: out.holidays.has(r.day), hours: Array.from({ length: 24 }, () => ({ play: 0, cap: 0, queue: 0 })) };
    byDay.set(r.day, d);
    out.days.push(d);
  }
  if (out.days.length === 0) return out;
  const hourly = await db.query(
    `select h.day::text as day, h.hour, sum(h.play_minutes)::int as play, sum(h.capacity_minutes)::int as cap
       from bl.stats_hourly h join bl.resources r on r.id = h.resource_id and r.club_id = h.club_id
      where h.club_id = $1 and h.day between $2 and $3 and ($4::text is null or r.type = $4)
      group by h.day, h.hour`,
    [club.id, window.from, window.to, kind],
  );
  for (const r of hourly.rows) {
    const d = byDay.get(r.day);
    if (!d) continue;
    d.hours[r.hour].play += r.play;
    d.hours[r.hour].cap += r.cap;
  }
  // Очередь: гости, вставшие в лист ожидания (час постановки по местному времени).
  const wl = await db.query(
    `select w.created_at from bl.waitlist w join bl.resources r on r.id = w.resource_id and r.club_id = w.club_id
      where w.club_id = $1 and w.created_at >= $2 and w.created_at < $3 and ($4::text is null or r.type = $4)`,
    [club.id, new Date(now.getTime() - (daysBetween(window.from, window.today) + 2) * 86_400_000), now, kind],
  );
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: club.timezone, hour: '2-digit', hourCycle: 'h23' });
  for (const w of wl.rows) {
    const at = new Date(w.created_at);
    const d = byDay.get(workingDayOf(at, club.timezone, club.day_start_local));
    if (!d) continue;
    d.hours[Number(fmt.format(at))].queue += 1;
  }
  return out;
}

/**
 * Прогноз 7 × 24 из истории (№196). pct — медиана загрузки ячейки, samples — сколько суток вошло,
 * days_pct — медиана загрузки суток по дню недели.
 */
export function forecastFrom(history) {
  const { window, days } = history;
  const base = {
    label: FORECAST_LABEL,
    weeks: FORECAST_WEEKS,
    from: window?.from ?? null,
    to: window?.to ?? null,
    history_days: days.length,
    history_weeks: Math.floor(days.length / 7),
    min_days: MIN_HISTORY_DAYS,
    holiday_iso_day: history.holidayIsoDay,
    rows: [1, 2, 3, 4, 5, 6, 7],
    cols: Array.from({ length: 24 }, (_, i) => i),
  };
  if (days.length < MIN_HISTORY_DAYS) return { ...base, status: 'insufficient_data', enough: false, pct: null, samples: null, days_pct: null };
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => []));
  const dayCells = Array.from({ length: 7 }, () => []);
  for (const d of days) {
    let p = 0;
    let c = 0;
    d.hours.forEach((x, h) => {
      if (x.cap <= 0) return;
      cells[d.dow - 1][h].push(Math.min(100, (x.play / x.cap) * 100));
      p += x.play;
      c += x.cap;
    });
    if (c > 0) dayCells[d.dow - 1].push(Math.min(100, (p / c) * 100));
  }
  const med = (l) => {
    const m = medianOf(l);
    return m === null ? null : r1(m);
  };
  return {
    ...base,
    status: 'ok',
    enough: true,
    pct: cells.map((row) => row.map(med)),
    samples: cells.map((row) => row.map((l) => l.length)),
    days_pct: dayCells.map(med),
  };
}

/** Прогноз на сутки date: строка дня недели (праздник — holiday_iso_day), часы в порядке суток. */
export function forecastForDate(forecast, { date, holidayTitle = null, order }) {
  const dow = holidayTitle !== null ? forecast.holiday_iso_day : isoDow(date);
  const ok = forecast.status === 'ok';
  return {
    date,
    iso_dow: isoDow(date),
    basis_dow: dow,
    holiday: holidayTitle !== null ? { title: holidayTitle } : null,
    label: forecast.label,
    status: forecast.status,
    enough: forecast.enough,
    history_days: forecast.history_days,
    history_weeks: forecast.history_weeks,
    min_days: forecast.min_days,
    window: { from: forecast.from, to: forecast.to },
    day_pct: ok ? forecast.days_pct[dow - 1] : null,
    hours: order.map((h) => ({ hour: h, pct: ok ? forecast.pct[dow - 1][h] : null, samples: ok ? forecast.samples[dow - 1][h] : 0 })),
  };
}

function hoursLabel(start, end) {
  return `${pad(start)}–${pad((end + 1) % 24)}`;
}

function daysLabel(dows) {
  const names = dows.map((d) => DOW_ACC[d]);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} и ${names.at(-1)}`;
  return `${dows[0] === 2 ? 'Во' : 'В'} ${list}`;
}

/** Подряд идущие (в порядке суток) часы, где flag(h) истинно: [[h…], …]. */
function runs(order, flag) {
  const out = [];
  let cur = [];
  for (const h of order) {
    if (flag(h)) cur.push(h);
    else {
      if (cur.length) out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Подсказки по цене (№197) из истории: [{ id, type: lower_price|raise_price, days, from_hour, to_hour,
 * hours, utilization_pct, queue_days, sample_days, weeks, text }].
 */
export function hintsFrom(history, thresholds = HINTS) {
  const t = { ...HINTS, ...thresholds };
  const { days, order } = history;
  if (days.length < MIN_HISTORY_DAYS) return [];
  // Ячейки: часы × набор суток.
  const stat = (filter) =>
    Array.from({ length: 24 }, (_, h) => {
      const s = { play: 0, cap: 0, n: 0, queueDays: 0, weeks: new Set() };
      for (const d of days) {
        if (!filter(d)) continue;
        const x = d.hours[h];
        if (x.cap <= 0) continue;
        s.play += x.play;
        s.cap += x.cap;
        s.n += 1;
        if (x.queue > 0) s.queueDays += 1;
        s.weeks.add(weekOf(d.day));
      }
      return s;
    });
  const sum = (cells, hours) => {
    const s = { play: 0, cap: 0, n: 0, queueDays: 0, weeks: new Set() };
    for (const h of hours) {
      const c = cells[h];
      s.play += c.play;
      s.cap += c.cap;
      s.n = Math.max(s.n, c.n);
      s.queueDays = Math.max(s.queueDays, c.queueDays);
      for (const w of c.weeks) s.weeks.add(w);
    }
    return s;
  };
  const out = [];

  // Будни (праздники — выходные): долгая низкая загрузка — «дневная цена».
  const wd = stat((d) => d.dow <= 5);
  for (const run of runs(order, (h) => wd[h].cap > 0 && wd[h].weeks.size >= t.MIN_WEEKS && (wd[h].play / wd[h].cap) * 100 < t.LOW_PCT)) {
    if (run.length < t.LOW_MIN_HOURS) continue;
    const s = sum(wd, run);
    const u = r1((s.play / s.cap) * 100);
    const weeks = s.weeks.size;
    const win = hoursLabel(run[0], run.at(-1));
    out.push({
      id: `lower_price:1-5:${run[0]}-${run.at(-1)}`,
      type: 'lower_price',
      days: [1, 2, 3, 4, 5],
      from_hour: run[0],
      to_hour: (run.at(-1) + 1) % 24,
      hours: run.length,
      utilization_pct: u,
      queue_days: null,
      sample_days: null,
      weeks,
      text: `В будни ${win} загрузка ${pctText(u)} за ${weeks} ${plural(weeks, WEEKS_ACC)} — подумайте о дневной цене`,
    });
  }

  // Каждый день недели: высокая загрузка или очередь — «можно поднять цену». Одинаковые окна разных
  // дней объединяются в одну подсказку.
  const high = new Map();
  for (let dow = 1; dow <= 7; dow += 1) {
    const cells = stat((d) => d.dow === dow);
    const flagged = (h) => {
      const c = cells[h];
      if (c.cap <= 0 || c.weeks.size < t.MIN_WEEKS) return false;
      return (c.play / c.cap) * 100 > t.HIGH_PCT || c.queueDays / c.n >= t.QUEUE_SHARE;
    };
    for (const run of runs(order, flagged)) {
      if (run.length < t.HIGH_MIN_HOURS) continue;
      const key = `${run[0]}-${run.at(-1)}`;
      const g = high.get(key) ?? { run, dows: [], play: 0, cap: 0, queueDays: 0, n: 0, weeks: new Set() };
      const s = sum(cells, run);
      g.dows.push(dow);
      g.play += s.play;
      g.cap += s.cap;
      g.queueDays += s.queueDays;
      g.n += s.n;
      for (const w of s.weeks) g.weeks.add(w);
      high.set(key, g);
    }
  }
  for (const g of high.values()) {
    const u = r1((g.play / g.cap) * 100);
    const weeks = g.weeks.size;
    const win = hoursLabel(g.run[0], g.run.at(-1));
    const queue = g.queueDays / g.n >= t.QUEUE_SHARE;
    const busy = u > t.HIGH_PCT;
    let what;
    if (busy && queue) what = `загрузка ${pctText(u)}, очередь в ${g.queueDays} из ${g.n} ${plural(g.n, DAYS_GEN)}`;
    else if (queue) what = `очередь в ${g.queueDays} из ${g.n} ${plural(g.n, DAYS_GEN)} (загрузка ${pctText(u)})`;
    else what = `загрузка ${pctText(u)} за ${weeks} ${plural(weeks, WEEKS_ACC)}`;
    out.push({
      id: `raise_price:${g.dows.join('')}:${g.run[0]}-${g.run.at(-1)}`,
      type: 'raise_price',
      days: g.dows,
      from_hour: g.run[0],
      to_hour: (g.run.at(-1) + 1) % 24,
      hours: g.run.length,
      utilization_pct: u,
      queue_days: g.queueDays,
      sample_days: g.n,
      weeks,
      text: `${daysLabel(g.dows)} ${win} ${what} — можно поднять цену`,
    });
  }
  const pos = (h) => order.indexOf(h);
  out.sort((a, b) => (a.type === b.type ? a.days[0] - b.days[0] || pos(a.from_hour) - pos(b.from_hour) : a.type === 'raise_price' ? -1 : 1));
  return out.slice(0, t.MAX_HINTS);
}

/** Прогноз и подсказки клуба (в контексте клуба): { forecast, hints, history }. */
export async function clubForecast(db, club, { now, kind = null }) {
  const history = await loadHistory(db, club, { now, kind });
  return { forecast: forecastFrom(history), hints: hintsFrom(history), history };
}
