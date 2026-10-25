/**
 * M5.6 (docs/contracts/m5-5-8.md, №196–197; формы — server/maintenance/README.md): прогноз загрузки на неделю и
 * подсказки по цене во вкладке «Зал» (series.forecast и hints ответа tab=hall). Прогноз считает сервер: медиана
 * загрузки ячейки «день недели × час» за 8 недель, праздники — днём holiday_iso_day клуба. Здесь — приведение ответа
 * к виду экрана, тексты окна и цифр подсказки и та же медиана для заглушки. Логика без JSX — test/forecast.test.mjs.
 */

import { plural } from '@billiardum/shared/format';
import { heatCells } from './dashboard.js';
import { dayLong } from './period.js';

/** Меньше 14 суток истории — прогноза нет (status: insufficient_data). */
export const FORECAST_MIN_DAYS = 14;
export const FORECAST_WEEKS = 8;

const WEEKS = ['неделя', 'недели', 'недель'];
const DAYS = ['день', 'дня', 'дней'];
const DAYS_GEN = ['дня', 'дней', 'дней'];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const ymd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Медиана списка чисел; пусто — null. Чётное число — среднее двух средних. */
export function median(list) {
  const xs = arr(list).filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}

/**
 * Медиана по образцам истории (заглушка и сверка с сервером): samples — [{dow 1–7, hour 0–23, pct | null}], по образцу
 * на каждые сутки. Закрытые часы (pct = null) в медиану не входят; ячейка без образцов — null.
 * → { pct: 7 × 24 (до 0,1), samples: 7 × 24 — сколько суток вошло }.
 */
export function medianForecast(samples) {
  const map = new Map();
  for (const s of arr(samples)) {
    if (!s || !(s.dow >= 1 && s.dow <= 7) || !(s.hour >= 0 && s.hour <= 23)) continue;
    const k = s.dow * 100 + s.hour;
    if (!map.has(k)) map.set(k, []);
    if (num(s.pct) !== null) map.get(k).push(s.pct);
  }
  const rows = [1, 2, 3, 4, 5, 6, 7];
  const cols = Array.from({ length: 24 }, (_, h) => h);
  return {
    pct: rows.map((d) =>
      cols.map((h) => {
        const m = median(map.get(d * 100 + h));
        return m === null ? null : Math.round(Math.min(100, Math.max(0, m)) * 10) / 10;
      }),
    ),
    samples: rows.map((d) => cols.map((h) => map.get(d * 100 + h)?.length ?? 0)),
  };
}

const ISO_DOW_ACC = ['', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу', 'воскресенье'];

/**
 * series.forecast → вид экрана: { status, enough, weeks, days, minDays, window {from, to}, holidayDow, cells }.
 * null (у «всех клубов») → null. Мало данных — status insufficient_data, enough: false, pct: null.
 */
export function forecastView(f) {
  if (!f || typeof f !== 'object') return null;
  const days = num(f.history_days);
  const weeks = num(f.history_weeks ?? f.weeks) ?? 0;
  const minDays = num(f.min_days) ?? FORECAST_MIN_DAYS;
  const enough = f.status === 'insufficient_data' ? false : typeof f.enough === 'boolean' ? f.enough : Array.isArray(f.pct);
  return {
    status: f.status ?? (enough ? 'ok' : 'insufficient_data'),
    enough: enough && Array.isArray(f.pct),
    weeks,
    days,
    minDays,
    label: typeof f.label === 'string' && f.label ? f.label : 'прогноз',
    window: ymd(f.from) && ymd(f.to) ? { from: f.from, to: f.to } : ymd(f.window?.from) && ymd(f.window?.to) ? { from: f.window.from, to: f.window.to } : null,
    holidayDow: Number.isInteger(f.holiday_iso_day) && f.holiday_iso_day >= 1 && f.holiday_iso_day <= 7 ? f.holiday_iso_day : null,
    cells: enough && Array.isArray(f.pct) ? heatCells({ rows: f.rows, cols: f.cols, pct: f.pct }) : [],
  };
}

/** «Мало истории для прогноза — нужно 14 дней, сейчас 10 дней». */
export function notEnoughText(view) {
  const need = view?.minDays ?? FORECAST_MIN_DAYS;
  const have = num(view?.days);
  const left = have !== null ? Math.max(1, need - have) : null;
  return `Мало истории для прогноза — нужно ${need} ${plural(need, DAYS)}${have !== null ? `, сейчас ${have} ${plural(have, DAYS)}` : ''}. Прогноз и подсказки по цене появятся сами${left !== null ? ` примерно через ${left} ${plural(left, DAYS)}` : ''}.`;
}

/** Основа прогноза: «медиана за 8 недель (29 августа – 23 октября)». */
export function basisText(view) {
  const w = Math.min(FORECAST_WEEKS, Math.max(0, Math.round(view?.weeks ?? 0)));
  const range = rangeWords(view?.window);
  return `${w ? `медиана за ${w} ${plural(w, WEEKS)}` : 'медиана прошлых недель'}${range ? ` (${range})` : ''}`;
}

/** Праздники клуба в прогнозе: «Праздники клуба считаются как воскресенье». */
export function holidayText(view) {
  return view?.holidayDow ? `Праздники клуба считаются как ${ISO_DOW_ACC[view.holidayDow]}, как в тарифах.` : null;
}

/** Даты словами: «25–31 октября», через месяц — «29 августа – 23 октября». */
export function rangeWords(r) {
  if (!ymd(r?.from) || !ymd(r?.to)) return null;
  const a = dayLong(r.from);
  const b = dayLong(r.to);
  if (r.from === r.to) return a;
  return r.from.slice(0, 7) === r.to.slice(0, 7) ? `${a.split(' ')[0]}–${b}` : `${a} – ${b}`;
}

// ---------- подсказки по цене (№197) ----------

const DOW_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const DOW_IN = ['В понедельник', 'Во вторник', 'В среду', 'В четверг', 'В пятницу', 'В субботу', 'В воскресенье'];
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const cleanDays = (days) => [...new Set(arr(days).filter((x) => Number.isInteger(x) && x >= 1 && x <= 7))].sort((a, b) => a - b);

/** Дни подсказки: [1..5] → «В будни», [6, 7] → «В выходные», [5] → «В пятницу», [5, 6] → «В пятницу и субботу». */
export function daysWords(days) {
  const d = cleanDays(days);
  const key = d.join();
  if (!d.length) return '';
  if (key === '1,2,3,4,5,6,7') return 'Каждый день';
  if (key === '1,2,3,4,5') return 'В будни';
  if (key === '6,7') return 'В выходные';
  if (d.length === 1) return DOW_IN[d[0] - 1];
  if (d.length === 2) return `${DOW_IN[d[0] - 1]} и ${DOW_IN[d[1] - 1].replace(/^Во? /, '').toLowerCase()}`;
  return cap(daysShort(d));
}

/** Дни коротко: [1..5] → «пн–пт», [1, 3, 5] → «пн, ср, пт», [1, 2, 3, 5] → «пн–ср, пт». */
export function daysShort(days) {
  const runs = [];
  for (const x of cleanDays(days)) {
    const last = runs.at(-1);
    if (last && x === last[1] + 1) last[1] = x;
    else runs.push([x, x]);
  }
  return runs.map(([a, b]) => (a === b ? DOW_SHORT[a - 1] : b === a + 1 ? `${DOW_SHORT[a - 1]}, ${DOW_SHORT[b - 1]}` : `${DOW_SHORT[a - 1]}–${DOW_SHORT[b - 1]}`)).join(', ');
}

const pad = (h) => `${String(h).padStart(2, '0')}:00`;
const hourOk = (h) => Number.isInteger(h) && h >= 0 && h <= 23;

/** Окно часов: 20–23 → «20–23»; to_hour 0 — полночь, «20–24»; через полночь — «23–02». */
export function hoursShort(from, to) {
  if (!hourOk(from) || !hourOk(to)) return '';
  return `${from}–${to === 0 ? 24 : String(to).padStart(from > to ? 2 : 1, '0')}`;
}

/** Окно подсказки полностью: «Пн–пт, 14:00–17:00». */
export function windowWords(days, from, to) {
  const d = daysShort(days);
  const t = hourOk(from) && hourOk(to) ? `${pad(from)}–${pad(to)}` : '';
  return cap([d, t].filter(Boolean).join(', '));
}

const pctWords = (v) => `${String(Math.round(v * 10) / 10).replace('.', ',')} %`;

/**
 * Подсказка сервера → карточка. Форма: { id, type: raise_price | lower_price, days, from_hour, to_hour, hours,
 * utilization_pct, queue_days, sample_days, weeks, text, club_id?, club_name? }. Текст — сервера (как в №197);
 * без текста собираем сами. tone: raise — можно поднять цену, lower — подумать о дневной цене. Цены сами не меняются.
 */
export function hintView(h) {
  if (!h || typeof h !== 'object') return null;
  const tone = h.type === 'raise_price' ? 'raise' : h.type === 'lower_price' ? 'lower' : null;
  if (!tone) return null;
  const load = num(h.utilization_pct);
  const weeks = num(h.weeks) ?? FORECAST_WEEKS;
  const queue = num(h.queue_days);
  const sample = num(h.sample_days);
  const when = `${daysWords(h.days)} ${hoursShort(h.from_hour, h.to_hour)}`.trim();
  const own = tone === 'lower' ? `${when} загрузка ${load !== null ? pctWords(load) : '—'} за ${weeks} ${plural(weeks, WEEKS)} — подумайте о дневной цене` : queue ? `${when} очередь в ${queue} из ${sample ?? '?'} ${plural(sample ?? 0, DAYS_GEN)} — можно поднять цену` : `${when} загрузка ${load !== null ? pctWords(load) : '—'} за ${weeks} ${plural(weeks, WEEKS)} — можно поднять цену`;
  const text = typeof h.text === 'string' && h.text.trim() ? h.text.trim() : when ? own : null;
  if (!text) return null;
  const numbers = [];
  if (load !== null) numbers.push({ key: 'load', label: 'Загрузка', value: pctWords(load) });
  if (queue) numbers.push({ key: 'queue', label: 'Очередь', value: `в ${queue} из ${sample ?? '?'} ${plural(sample ?? 0, DAYS_GEN)}` });
  numbers.push({ key: 'basis', label: 'По данным', value: `${weeks} ${plural(weeks, WEEKS)}` });
  return {
    id: String(h.id ?? `${h.type}:${h.days}:${h.from_hour}`) + (h.club_id ? `@${h.club_id}` : ''),
    tone,
    tag: tone === 'raise' ? 'Можно поднять цену' : 'Можно снизить цену днём',
    text,
    window: windowWords(h.days, h.from_hour, h.to_hour),
    numbers,
    clubId: typeof h.club_id === 'string' ? h.club_id : null,
    clubName: typeof h.club_name === 'string' ? h.club_name : null,
  };
}

export const hintsView = (list) => arr(list).map(hintView).filter(Boolean);
