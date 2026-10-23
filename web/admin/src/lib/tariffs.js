import { formatMoney } from '@billiardum/shared/format';
import { parseRubles } from './cash.js';

/**
 * Мастер тарифов (M5.1, №156): шаблон → цены → предпросмотр недели по часам. Чистые функции, без DOM.
 *
 * Время — местное время клуба (инвариант 10). Сутки клуба начинаются в day_start_local (по умолчанию 06:00, №43):
 * ночь с пятницы на субботу 00:00–06:00 — пятничная. Поэтому шаблоны считают минуты от начала суток клуба
 * («рабочие минуты», 0…1440); интервал правила может переходить через полночь (18:00–06:00), from = to — сутки.
 *
 * Правило мастера (server/setup/tariffs.mjs): { kind: pyramid | pool | snooker | mixed | null (все типы столов),
 * days: [1…7], from: 'HH:MM', to: 'HH:MM', price_per_hour_kopecks, step_minutes, min_minutes }.
 * Читаем и старую форму: resource_type 'billiard_*', start_local, end_local, price_per_hour. День недели: 1 — пн.
 */

export const DAY_MIN = 1440;
export const WEEKDAYS = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
export const WEEKDAY_SHORT = Object.freeze(['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']);
export const WEEKDAY_LONG = Object.freeze(['', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье']);
const ON_WEEKDAY = ['', 'в понедельник', 'во вторник', 'в среду', 'в четверг', 'в пятницу', 'в субботу', 'в воскресенье'];

/** Типы столов в тарифе (kind) и их названия; порядок — как в редакторе зала. */
export const TYPE_WORD = Object.freeze({ pyramid: 'Пирамида', pool: 'Пул', snooker: 'Снукер', mixed: 'Пирамида и пул' });
const KIND_ORDER = Object.keys(TYPE_WORD);

/** Тип столов из 'billiard_*' (старые ответы, resource.type). */
export function kindOfType(type) {
  const m = /^billiard_(pyramid|pool|snooker|mixed)$/.exec(String(type ?? ''));
  return m ? m[1] : null;
}

/** Тип столов правила: kind (null — все типы), иначе resource_type. */
export function ruleKind(r) {
  if (r?.kind !== undefined) return TYPE_WORD[r.kind] ? r.kind : null;
  return kindOfType(r?.resource_type);
}
const ruleFrom = (r) => r?.from ?? r?.start_local;
const ruleTo = (r) => r?.to ?? r?.end_local;

/** 'HH:MM' → минуты от полуночи; не время — null. '24:00' — 0. */
export function toMinutes(hhmm) {
  const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(String(hhmm ?? ''));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59 || (h === 24 && mi !== 0)) return null;
  return (h * 60 + mi) % DAY_MIN;
}

/** Минуты от полуночи → 'HH:MM'. */
export function hhmm(minutes) {
  const m = ((minutes % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Местное время → минуты от начала суток клуба. */
export function workMinute(local, dayStart = '06:00') {
  const t = toMinutes(local);
  const s = toMinutes(dayStart) ?? 360;
  return t === null ? null : (t - s + DAY_MIN) % DAY_MIN;
}

/** Минуты от начала суток клуба → местное 'HH:MM'. */
export function localOf(work, dayStart = '06:00') {
  return hhmm((toMinutes(dayStart) ?? 360) + work);
}

const ALL = [1, 2, 3, 4, 5, 6, 7];

/**
 * Шаблоны (№156). bands(form) — полосы цены: { key, label, days, from, to } в рабочих минутах.
 * Ключ полосы — имя поля цены в форме.
 */
export const TEMPLATES = Object.freeze([
  {
    id: 'flat',
    title: 'Одна цена',
    about: 'Одна цена в любой день и час.',
    bands: () => [{ key: 'all', label: 'Все дни, круглые сутки', days: ALL, from: 0, to: DAY_MIN }],
  },
  {
    id: 'weekend',
    title: 'Будни и выходные',
    about: 'В выходные дороже, внутри дня цена одна.',
    bands: (f) => [
      { key: 'wd', label: 'Будни', days: weekdaysOf(f), from: 0, to: DAY_MIN },
      { key: 'we', label: 'Выходные', days: weekendOf(f), from: 0, to: DAY_MIN },
    ],
  },
  {
    id: 'day_evening',
    title: 'День и вечер',
    about: 'Вечером и ночью дороже, дни недели не различаются.',
    bands: (f) => [
      { key: 'day', label: 'День', days: ALL, from: 0, to: f.eveningW },
      { key: 'eve', label: 'Вечер и ночь', days: ALL, from: f.eveningW, to: DAY_MIN },
    ],
  },
  {
    id: 'day_evening_night',
    title: 'День, вечер, ночь',
    about: 'Три цены за сутки: днём, вечером и ночью.',
    bands: (f) => [
      { key: 'day', label: 'День', days: ALL, from: 0, to: f.eveningW },
      { key: 'eve', label: 'Вечер', days: ALL, from: f.eveningW, to: f.nightW },
      { key: 'night', label: 'Ночь', days: ALL, from: f.nightW, to: DAY_MIN },
    ],
  },
  {
    id: 'weekend_day_evening',
    title: 'Будни и выходные × день и вечер',
    about: 'Четыре цены: днём и вечером, отдельно в будни и в выходные.',
    bands: (f) => [
      { key: 'wd_day', label: 'Будни, день', days: weekdaysOf(f), from: 0, to: f.eveningW },
      { key: 'wd_eve', label: 'Будни, вечер и ночь', days: weekdaysOf(f), from: f.eveningW, to: DAY_MIN },
      { key: 'we_day', label: 'Выходные, день', days: weekendOf(f), from: 0, to: f.eveningW },
      { key: 'we_eve', label: 'Выходные, вечер и ночь', days: weekendOf(f), from: f.eveningW, to: DAY_MIN },
    ],
  },
]);

export const templateById = (id) => TEMPLATES.find((t) => t.id === id) ?? null;
/** Нужны ли шаблону граница вечера, ночи и выбор выходных. */
export const templateNeeds = (id) => ({
  evening: ['day_evening', 'day_evening_night', 'weekend_day_evening'].includes(id),
  night: id === 'day_evening_night',
  weekend: ['weekend', 'weekend_day_evening'].includes(id),
});

function weekendOf(f) {
  return ALL.filter((d) => (f.weekend ?? [6, 7]).includes(d));
}
function weekdaysOf(f) {
  return ALL.filter((d) => !(f.weekend ?? [6, 7]).includes(d));
}

/** Форма мастера по умолчанию. */
export function defaultTariffForm(template = 'weekend_day_evening') {
  return { template, evening: '17:00', night: '00:00', weekend: [6, 7], perType: false, prices: {}, min_minutes: 30, step_minutes: 1 };
}

/** Форма с рабочими минутами границ. */
function withWork(form, dayStart) {
  return { ...form, eveningW: workMinute(form.evening, dayStart), nightW: workMinute(form.night, dayStart) || DAY_MIN };
}

/** Полосы шаблона с подписью времени: «День, 06:00–17:00». */
export function tariffBands(form, dayStart = '06:00') {
  const t = templateById(form.template);
  if (!t) return [];
  const f = withWork(form, dayStart);
  return t.bands(f).map((b) => ({
    ...b,
    time: b.from === 0 && b.to === DAY_MIN ? 'круглые сутки' : `${localOf(b.from, dayStart)}–${localOf(b.to, dayStart)}`,
  }));
}

/** Ключ поля цены: полоса и, если цены по типам столов, тип. */
export const priceKey = (band, type) => (type ? `${band}:${type}` : band);

/**
 * Ошибки формы словами по полям: price:<ключ>, evening, night, weekend, min_minutes, step_minutes.
 * @param {object} form
 * @param {string[]} types типы столов клуба (resource_type)
 */
export function tariffFormErrors(form, types, dayStart = '06:00') {
  const errors = {};
  const t = templateById(form.template);
  if (!t) return { template: 'Выберите шаблон.' };
  const need = templateNeeds(form.template);
  const eve = workMinute(form.evening, dayStart);
  const night = workMinute(form.night, dayStart) || DAY_MIN;
  if (need.evening && (eve === null || eve === 0)) errors.evening = `Вечер должен начинаться позже начала суток клуба (${dayStart}).`;
  if (need.night && (night === null || eve === null || night <= eve)) errors.night = 'Ночь должна начинаться позже вечера.';
  if (need.weekend && (!form.weekend?.length || form.weekend.length >= 7)) errors.weekend = 'Отметьте выходные дни — хотя бы один, но не все.';
  if (!Number.isInteger(form.min_minutes) || form.min_minutes < 0 || form.min_minutes > 1440) errors.min_minutes = 'Минимум — от 0 до 1440 минут.';
  if (!Number.isInteger(form.step_minutes) || form.step_minutes < 1 || form.step_minutes > 60) errors.step_minutes = 'Шаг — от 1 до 60 минут.';
  const typeList = form.perType ? types : [null];
  for (const b of tariffBands(form, dayStart)) {
    for (const type of typeList) {
      const key = priceKey(b.key, type);
      const kop = parseRubles(String(form.prices?.[key] ?? ''));
      if (kop === null || kop < 100) errors[`price:${key}`] = 'Цена за час — от 1 ₽.';
      else if (kop > 10_000_000) errors[`price:${key}`] = 'Слишком большая цена: не больше 100 000 ₽ за час.';
    }
  }
  return errors;
}

/**
 * Правила тарифа из формы: одна цена на все типы столов — правила с kind: null (подходят и к смешанному столу);
 * разные цены — по правилу на каждый тип столов клуба. Интервал — по полосе шаблона, через полночь не режется.
 * @returns {{ kind: string | null, days: number[], from: string, to: string, price_per_hour_kopecks: number, step_minutes: number, min_minutes: number }[]}
 */
export function buildRules(form, types, dayStart = '06:00') {
  const rules = [];
  for (const kind of form.perType ? types : [null]) {
    for (const b of tariffBands(form, dayStart)) {
      if (!b.days.length || b.to <= b.from) continue;
      const price = parseRubles(String(form.prices?.[priceKey(b.key, kind)] ?? ''));
      rules.push({
        kind,
        days: [...b.days],
        from: localOf(b.from, dayStart),
        to: localOf(b.to, dayStart),
        price_per_hour_kopecks: price ?? 0,
        step_minutes: form.step_minutes,
        min_minutes: form.min_minutes,
      });
    }
  }
  return rules;
}

/** Цена правила в копейках: сервер может прислать price_per_hour_kopecks или price_per_hour (как столбец базы). */
export const rulePrice = (r) => Number(r?.price_per_hour_kopecks ?? r?.price_per_hour ?? 0);

/**
 * Покрытие недели правилами одного типа столов по минутам суток клуба.
 * Интервал, который пересекает начало суток (04:00–08:00), принадлежит суткам, где начался, и захватывает начало следующих.
 * @returns {{ days: Record<number, { count: Int16Array, price: Int32Array }>, gaps: Span[], overlaps: Span[] }}
 *   Span — { weekday, from: 'HH:MM', to: 'HH:MM' } местного времени.
 */
export function weekCoverage(rules, type, dayStart = '06:00') {
  const days = {};
  for (const d of ALL) days[d] = { count: new Int16Array(DAY_MIN), price: new Int32Array(DAY_MIN).fill(-1) };
  const mark = (d, from, to, price) => {
    const day = days[d];
    for (let m = from; m < to; m += 1) {
      day.count[m] += 1;
      if (day.price[m] < 0) day.price[m] = price;
    }
  };
  for (const r of rules ?? []) {
    const k = ruleKind(r);
    if (type && k && k !== type) continue;
    const s = workMinute(ruleFrom(r), dayStart);
    let e = workMinute(ruleTo(r), dayStart);
    if (s === null || e === null) continue;
    if (e <= s) e += DAY_MIN;
    for (const d of r.days ?? []) {
      if (!days[d]) continue;
      mark(d, s, Math.min(e, DAY_MIN), rulePrice(r));
      if (e > DAY_MIN) mark((d % 7) + 1, 0, e - DAY_MIN, rulePrice(r));
    }
  }
  const spans = (test) => {
    const out = [];
    for (const d of ALL) {
      let start = null;
      for (let m = 0; m <= DAY_MIN; m += 1) {
        const hit = m < DAY_MIN && test(days[d].count[m]);
        if (hit && start === null) start = m;
        if (!hit && start !== null) {
          out.push({ weekday: d, from: localOf(start, dayStart), to: localOf(m, dayStart), fromW: start, toW: m });
          start = null;
        }
      }
    }
    return out;
  };
  return { days, gaps: spans((c) => c === 0), overlaps: spans((c) => c > 1) };
}

/**
 * Сетка предпросмотра: 7 дней × 24 часа от начала суток клуба. Ячейка — { hour: 'HH:MM', price, state }:
 * state 'ok' | 'gap' (нет цены хотя бы минуту) | 'overlap' (две цены) | 'split' (цена меняется внутри часа),
 * mark — часы, которые подсветил сервер (tariff_gap | tariff_overlap).
 */
export function previewGrid(coverage, dayStart = '06:00', highlight = null) {
  const hours = [];
  for (let h = 0; h < 24; h += 1) hours.push(localOf(h * 60, dayStart));
  const hl = highlight ? spanHours(highlight, dayStart) : null;
  const rows = hours.map((hour, h) => ({
    hour,
    cells: ALL.map((d) => {
      const day = coverage.days[d];
      let gap = false;
      let overlap = false;
      const prices = new Set();
      for (let m = h * 60; m < h * 60 + 60; m += 1) {
        if (day.count[m] === 0) gap = true;
        else if (day.count[m] > 1) overlap = true;
        if (day.price[m] >= 0) prices.add(day.price[m]);
      }
      const price = day.price[h * 60] >= 0 ? day.price[h * 60] : null;
      const state = gap ? 'gap' : overlap ? 'overlap' : prices.size > 1 ? 'split' : 'ok';
      return { weekday: d, price, state, mark: Boolean(hl && hl.weekday === d && hl.hours.has(h)) };
    }),
  }));
  return { hours, rows };
}

/** Часы сетки, которые задел интервал { weekday, from, to } ответа сервера. */
export function spanHours(span, dayStart = '06:00') {
  const s = workMinute(span.from, dayStart);
  let e = workMinute(span.to, dayStart);
  const hours = new Set();
  if (s === null) return { weekday: span.weekday, hours };
  if (e === null || e <= s) e = DAY_MIN;
  for (let h = 0; h < 24; h += 1) if (h * 60 < e && h * 60 + 60 > s) hours.add(h);
  return { weekday: span.weekday, hours };
}

/** Различимые цены недели по возрастанию — для легенды и оттенков сетки (не больше 6 оттенков). */
export function priceLevels(coverage) {
  const set = new Set();
  for (const d of ALL) for (const p of coverage.days[d].price) if (p >= 0) set.add(p);
  return [...set].sort((a, b) => a - b);
}

/**
 * Неделя словами для экранного диктора и для тех, кто не смотрит на сетку:
 * «Пн–Чт: 06:00–17:00 — 500 ₽ в час; 17:00–06:00 — 800 ₽ в час». Дни с одинаковым расписанием идут вместе.
 */
export function weekSummary(coverage, dayStart = '06:00') {
  const daySegs = (d) => {
    const segs = [];
    const day = coverage.days[d];
    let start = 0;
    for (let m = 1; m <= DAY_MIN; m += 1) {
      const same = m < DAY_MIN && day.price[m] === day.price[start] && (day.count[m] > 1) === (day.count[start] > 1);
      if (!same) {
        segs.push({ from: start, to: m, price: day.price[start], overlap: day.count[start] > 1 });
        start = m;
      }
    }
    return segs;
  };
  const text = (segs) =>
    segs
      .map((s) => {
        const span = s.from === 0 && s.to === DAY_MIN ? 'круглые сутки' : `${localOf(s.from, dayStart)}–${localOf(s.to, dayStart)}`;
        if (s.price < 0) return `${span} — нет цены`;
        return `${span} — ${formatMoney(s.price)} в час${s.overlap ? ' (две цены)' : ''}`;
      })
      .join('; ');
  const lines = [];
  let group = null;
  for (const d of ALL) {
    const t = text(daySegs(d));
    if (group && group.text === t) group.to = d;
    else {
      group = { from: d, to: d, text: t };
      lines.push(group);
    }
  }
  return lines.map((g) => ({
    days: g.from === g.to ? WEEKDAY_SHORT[g.from] : `${WEEKDAY_SHORT[g.from]}–${WEEKDAY_SHORT[g.to]}`,
    text: g.text,
  }));
}

/** Проблема недели словами: «В среду с 02:00 до 06:00 нет цены». */
export function spanText(span, kind = 'gap') {
  const day = ON_WEEKDAY[span.weekday] ?? '';
  const what = kind === 'gap' ? 'нет цены' : 'задано две цены';
  const s = `${day} с ${span.from} до ${span.to} ${what}`;
  return `${s[0].toUpperCase()}${s.slice(1)}.`;
}

/**
 * Типы столов клуба в работе (kind) из зала или списка столов: resource.kind, иначе resource.type 'billiard_*'.
 * Пусто — пирамида (ещё нет столов).
 */
export function hallTypes(hall) {
  const kinds = new Set();
  for (const t of hall ?? []) {
    const r = t.resource ?? t;
    if (r.active === false) continue;
    const k = TYPE_WORD[r.kind] ? r.kind : kindOfType(r.type);
    if (k) kinds.add(k);
  }
  return kinds.size ? KIND_ORDER.filter((k) => kinds.has(k)) : ['pyramid'];
}

/** Тело PUT /api/clubs/{club}/tariffs: в боевом режиме — с причиной (инвариант 8). */
export function tariffsBody(rules, { live = false, reason = '' } = {}) {
  return live ? { rules, reason: reason.trim() } : { rules };
}
