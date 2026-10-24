// Время дашборда (M5.2 №167): рабочие сутки клуба с day_start_local в поясе IANA клуба, местные
// часы, часы работы клуба (№170). Без зависимостей: Intl и целые миллисекунды.

const MINUTE = 60_000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
export const DEFAULT_DAY_START = '06:00';

const fmtCache = new Map();
function formatter(timeZone) {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    fmtCache.set(timeZone, f);
  }
  return f;
}

/** Местные части момента: { date: 'YYYY-MM-DD', hour, minute, isoDow (1 = пн … 7 = вс) }. */
export function localParts(at, timeZone) {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(at).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return { date, hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second), isoDow: dow === 0 ? 7 : dow };
}

/** Смещение пояса в момент at, мс (местное − UTC). */
export function offsetMs(at, timeZone) {
  const p = localParts(at, timeZone);
  const [y, m, d] = p.date.split('-').map(Number);
  const asUtc = Date.UTC(y, m - 1, d, p.hour, p.minute, p.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Момент UTC для местной даты и времени (HH:MM) в поясе. */
export function zonedTime(date, hhmm, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  let t = naive - offsetMs(new Date(naive), timeZone);
  // Второй проход — на случай перехода смещения между naive и t.
  t = naive - offsetMs(new Date(t), timeZone);
  return new Date(t);
}

export function isDay(s) {
  if (typeof s !== 'string' || !DAY_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Дата на n дней позже (YYYY-MM-DD). */
export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Число дней от a до b включительно. */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;
}

export function eachDay(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** ISO день недели даты (1 = пн). */
export function isoDow(day) {
  const w = new Date(`${day}T00:00:00Z`).getUTCDay();
  return w === 0 ? 7 : w;
}

export function normalizeHhmm(v, fallback) {
  return typeof v === 'string' && HHMM.test(v) ? v : fallback;
}

/** Границы рабочих суток day: [from, to) в UTC. */
export function dayBounds(day, timeZone, dayStart = DEFAULT_DAY_START) {
  const ds = normalizeHhmm(dayStart, DEFAULT_DAY_START);
  return { from: zonedTime(day, ds, timeZone), to: zonedTime(addDays(day, 1), ds, timeZone) };
}

/** Рабочие сутки момента at (YYYY-MM-DD). */
export function workingDayOf(at, timeZone, dayStart = DEFAULT_DAY_START) {
  const ds = normalizeHhmm(dayStart, DEFAULT_DAY_START);
  const p = localParts(at, timeZone);
  const [h, m] = ds.split(':').map(Number);
  return p.hour * 60 + p.minute >= h * 60 + m ? p.date : addDays(p.date, -1);
}

/**
 * Разрезать интервал [from, to) по границам местных часов: [{ hour, from, to, ms }].
 * Пояса со смещением, кратным 15 минутам, режутся точно.
 */
export function sliceByHour(from, to, timeZone) {
  const out = [];
  let t = from.getTime();
  const end = to.getTime();
  let guard = 0;
  while (t < end && guard < 100_000) {
    guard += 1;
    const p = localParts(new Date(t), timeZone);
    const msIntoHour = (p.minute * 60 + p.second) * 1000 + (t % 1000);
    const next = Math.min(end, t - msIntoHour + 60 * MINUTE);
    out.push({ hour: p.hour, from: t, to: next, ms: next - t });
    t = next;
  }
  return out;
}

/**
 * Часы работы клуба в рабочие сутки (№170): clubs.settings.open_hours = { open: 'HH:MM', close: 'HH:MM',
 * days?: { '1'…'7': { open, close } | null } } — по ISO дню недели даты суток (null — выходной).
 * Нет настройки или open = close — круглосуточно. Возвращает интервалы [{from, to}] внутри суток.
 */
export function openWindows(day, timeZone, dayStart, settings) {
  const bounds = dayBounds(day, timeZone, dayStart);
  const oh = settings && typeof settings === 'object' ? settings.open_hours : null;
  if (!oh || typeof oh !== 'object') return [bounds];
  let spec = oh;
  const byDay = oh.days && typeof oh.days === 'object' ? oh.days : null;
  if (byDay && Object.prototype.hasOwnProperty.call(byDay, String(isoDow(day)))) {
    spec = byDay[String(isoDow(day))];
    if (spec === null) return [];
  }
  const open = normalizeHhmm(spec?.open, null);
  const close = normalizeHhmm(spec?.close, null);
  if (!open || !close || open === close) return [bounds];
  const ds = normalizeHhmm(dayStart, DEFAULT_DAY_START);
  // Открытие относится к местной дате суток, если оно не раньше начала суток, иначе — к следующей.
  const openDate = open >= ds ? day : addDays(day, 1);
  const start = zonedTime(openDate, open, timeZone);
  const end = zonedTime(close > open ? openDate : addDays(openDate, 1), close, timeZone);
  const from = new Date(Math.max(start.getTime(), bounds.from.getTime()));
  const to = new Date(Math.min(end.getTime(), bounds.to.getTime()));
  return to > from ? [{ from, to }] : [];
}

/** Пересечение интервалов: сумма мс пересечения [a1,a2) с набором [{from,to}]. */
export function overlapMs(a1, a2, windows) {
  let ms = 0;
  for (const w of windows) {
    const lo = Math.max(a1, w.from instanceof Date ? w.from.getTime() : w.from);
    const hi = Math.min(a2, w.to instanceof Date ? w.to.getTime() : w.to);
    if (hi > lo) ms += hi - lo;
  }
  return ms;
}

/** ДД.ММ.ГГГГ (№172). */
export function ruDate(day) {
  return `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`;
}
