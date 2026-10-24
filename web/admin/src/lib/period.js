/**
 * Периоды по рабочим суткам клуба (M5.2, №167): даты — местные сутки клуба 'YYYY-MM-DD', сутки начинаются
 * в day_start_local (по умолчанию 06:00). Игра в 05:30 относится к прошлым суткам. Без зависимостей, тестируется в Node.
 */

export const MAX_DAYS = 366;
export const DEFAULT_DAY_START = '06:00';

export const PRESETS = [
  { value: 'today', label: 'Сегодня' },
  { value: 'yesterday', label: 'Вчера' },
  { value: '7d', label: '7 дней' },
  { value: '30d', label: '30 дней' },
  { value: 'month', label: 'Месяц' },
  { value: 'custom', label: 'Свой период' },
];

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY = 86_400_000;

/** Строка 'YYYY-MM-DD' — настоящая дата. */
export function isYmd(s) {
  const m = YMD.exec(String(s ?? ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

const toUtc = (ymd) => {
  const m = YMD.exec(ymd);
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
};
const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);

/** '2026-10-24' + 1 → '2026-10-25'. */
export function addDays(ymd, n) {
  return fromUtc(toUtc(ymd) + n * DAY);
}

/** Число дней от a до b включительно: ('2026-10-01', '2026-10-07') → 7. */
export function spanDays(from, to) {
  return Math.round((toUtc(to) - toUtc(from)) / DAY) + 1;
}

/** Все даты периода по порядку. */
export function eachDay(from, to) {
  const out = [];
  for (let t = toUtc(from), end = toUtc(to); t <= end; t += DAY) out.push(fromUtc(t));
  return out;
}

/** День недели: 1 — понедельник … 7 — воскресенье. */
export function weekday(ymd) {
  const d = new Date(toUtc(ymd)).getUTCDay();
  return d === 0 ? 7 : d;
}

const partsCache = new Map();
function localParts(ms, timeZone) {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    partsCache.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** '06:00' → 360; неверное — 360. */
export function dayStartMinutes(dayStart = DEFAULT_DAY_START) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(dayStart ?? ''));
  if (!m || +m[1] > 23 || +m[2] > 59) return 360;
  return +m[1] * 60 + +m[2];
}

/**
 * Рабочие сутки клуба, к которым относится момент: 24.10 05:30 при начале суток 06:00 → '2026-10-23'.
 * @param {number | Date} now
 * @param {string} timeZone IANA
 * @param {string} [dayStart] 'HH:MM'
 */
export function workDate(now, timeZone, dayStart = DEFAULT_DAY_START) {
  const { ymd, minutes } = localParts(+now, timeZone);
  return minutes < dayStartMinutes(dayStart) ? addDays(ymd, -1) : ymd;
}

/** Последний день месяца даты. */
function monthEnd(ymd) {
  const [y, m] = ymd.split('-').map(Number);
  return fromUtc(Date.UTC(y, m, 0));
}

/**
 * Период пресета относительно «сегодня» (рабочие сутки клуба).
 * @returns {{ from: string, to: string }}
 */
export function presetRange(preset, today) {
  switch (preset) {
    case 'yesterday':
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case '7d':
      return { from: addDays(today, -6), to: today };
    case '30d':
      return { from: addDays(today, -29), to: today };
    case 'month':
      return { from: `${today.slice(0, 8)}01`, to: today };
    default:
      return { from: today, to: today };
  }
}

/**
 * Прошлый период для сравнения: столько же дней сразу перед текущим. «Месяц» — те же числа прошлого месяца
 * (1–24 октября → 1–24 сентября; 1–31 марта → 1–28 февраля).
 */
export function comparePeriod(from, to, preset) {
  if (preset === 'month' && from.endsWith('-01')) {
    const prevFrom = `${addDays(from, -1).slice(0, 8)}01`;
    const end = monthEnd(prevFrom);
    const day = Math.min(Number(to.slice(8)), Number(end.slice(8)));
    return { from: prevFrom, to: `${prevFrom.slice(0, 8)}${String(day).padStart(2, '0')}` };
  }
  const n = spanDays(from, to);
  return { from: addDays(from, -n), to: addDays(from, -1) };
}

/**
 * Ошибка периода словами или null (сервер ответит 400 bad_request на то же, §4).
 * @param {string} from
 * @param {string} to
 * @param {string} [today] позже сегодняшних суток период не заканчивается
 */
export function periodError(from, to, today) {
  if (!isYmd(from) || !isYmd(to)) return 'Укажите обе даты периода.';
  if (from > to) return 'Начало периода позже конца. Поменяйте даты местами.';
  if (today && to > today) return 'Период не может заканчиваться позже сегодняшнего дня.';
  if (spanDays(from, to) > MAX_DAYS) return `Период — не больше ${MAX_DAYS} дней. Сократите его или смотрите по частям.`;
  return null;
}

/** Текущий месяц до сегодня — период историй по умолчанию (№173). */
export function monthToDate(today) {
  return presetRange('month', today);
}

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
export const WEEKDAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
export const WEEKDAY_LONG = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];

/** '2026-10-21' → '21 октября'. */
export function dayLong(ymd) {
  const [, m, d] = ymd.split('-').map(Number);
  return `${d} ${MONTHS_GEN[m - 1]}`;
}

/** '2026-10-21' → '21 окт' (подписи оси). */
export function dayShort(ymd) {
  const [, m, d] = ymd.split('-').map(Number);
  return `${d} ${MONTHS_SHORT[m - 1]}`;
}

/** '2026-10-21' → '21.10.2026' (CSV и печать, №172). */
export function dayDots(ymd) {
  const [y, m, d] = ymd.split('-');
  return `${d}.${m}.${y}`;
}

/** Период словами: «21 октября», «1–24 октября», «28 сентября — 4 октября», с годом, если он не текущий. */
export function periodWords(from, to, today) {
  const year = (ymd) => (today && ymd.slice(0, 4) !== today.slice(0, 4) ? ` ${ymd.slice(0, 4)}` : '');
  if (from === to) return `${dayLong(from)}${year(from)}`;
  if (from.slice(0, 7) === to.slice(0, 7)) return `${Number(from.slice(8))}–${dayLong(to)}${year(to)}`;
  const fy = from.slice(0, 4) !== to.slice(0, 4) ? ` ${from.slice(0, 4)}` : '';
  return `${dayLong(from)}${fy} — ${dayLong(to)}${year(to)}`;
}
