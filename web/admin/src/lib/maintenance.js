/**
 * M5.6 «Обслуживание столов» (docs/contracts/m5-5-8.md, №198; формы — server/maintenance/README.md): события
 * (сукно, шары, резина бортов, выравнивание, другое), счётчики часов игры с последнего действующего события вида,
 * пороги клуба. Записи только добавляются: исправление — новое событие с corrects_id и причиной, void — «события не было».
 * Логика без JSX — тестируется в Node (test/forecast.test.mjs).
 */

import { formatMoney, plural } from '@billiardum/shared/format';
import { addDays, dayLong } from './period.js';
import { CASHBOOK_MAX_BACK_DAYS } from './reports.js';
import { kindOfType } from './dashboard.js';

/** Виды событий (server/maintenance KINDS). counter — столбец счётчика в списке столов. */
export const MAINT_KINDS = [
  { value: 'cloth', label: 'Замена сукна', short: 'Сукно', counter: true },
  { value: 'balls', label: 'Замена шаров', short: 'Шары', counter: true },
  { value: 'cushions', label: 'Замена резины бортов', short: 'Резина бортов', counter: true },
  { value: 'leveling', label: 'Выравнивание', short: 'Выравнивание', counter: false },
  { value: 'other', label: 'Другое', short: 'Другое', counter: false },
];
export const MAINT_KIND_LABEL = Object.fromEntries(MAINT_KINDS.map((k) => [k.value, k.label]));
export const ALL_KINDS = MAINT_KINDS.map((k) => k.value);
export const COUNTER_KINDS = MAINT_KINDS.filter((k) => k.counter).map((k) => k.value);
/** Пороги по умолчанию (№198, server/maintenance): сукно 1 500, шары 3 000, резина 5 000 ч; остальное — без порога. */
export const DEFAULT_THRESHOLDS = { cloth: 1500, balls: 3000, cushions: 5000, leveling: null, other: null };
/** «Скоро порог» — с 90 % порога (только подсветка экрана; уведомление шлёт сервер при достижении). */
export const NEAR_SHARE = 0.9;
export const THRESHOLD_MAX = 100000;
/** Дата события: без стоимости — до 366 суток назад, со стоимостью — не старше 35 суток (касса, №189). */
export const MAINT_MAX_BACK_DAYS = 366;
export const MAINT_COST_MAX_BACK_DAYS = CASHBOOK_MAX_BACK_DAYS;
export const COMMENT_MAX = 500;

/** «у 1 стола, у 2 столов, у 5 столов» — родительный падеж. */
const TABLES_GEN = ['стола', 'столов', 'столов'];
const HOURS = ['час', 'часа', 'часов'];
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const nbsp = (s) => s.replace(/[\u00a0\u202f]/g, ' ');

/** Часы целыми с пробелом тысяч: 1532.4 → «1 532 ч». */
export function hoursText(h) {
  const v = num(h);
  if (v === null) return '—';
  return `${nbsp(new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(v)))} ч`;
}

/** Порог: целые часы > 0 или null (без порога). */
function threshold(v) {
  const n = num(v);
  return n !== null && n > 0 ? Math.round(n) : null;
}

/**
 * Счётчик вида (counters[].kinds[k]: { hours, since, event_id, threshold_hours, due }) → вид экрана:
 * { hours, since, threshold, pct 0–100 (полоса), reached, near, state: none | ok | near | reached, stateWord, words, sinceWords }.
 */
export function counterView(c, thr) {
  const hours = num(c?.hours) ?? (num(c?.minutes) !== null ? c.minutes / 60 : 0);
  const t = threshold(c && 'threshold_hours' in c ? c.threshold_hours : thr);
  const since = typeof c?.since === 'string' ? c.since : null;
  const reached = t !== null && (c?.due === true || hours >= t);
  const near = !reached && t !== null && hours >= t * NEAR_SHARE;
  const state = t === null ? 'none' : reached ? 'reached' : near ? 'near' : 'ok';
  const pct = t === null ? null : Math.min(100, Math.round((hours / t) * 100));
  const stateWord = { none: 'без порога', ok: 'в норме', near: 'скоро порог', reached: 'порог достигнут' }[state];
  const words = t === null ? hoursText(hours) : `${hoursText(hours)} из ${hoursText(t)}`;
  const sinceWords = since ? `с ${dayLong(since)}` : 'замена не отмечена — с начала учёта';
  return { hours, since, threshold: t, pct, reached, near, state, stateWord, words, sinceWords };
}

/**
 * Ответ GET …/maintenance → вид экрана. Столы — по номеру (выведенные из работы — в конце, с пометкой),
 * события — новые сверху; у каждого — состояние: active (действует), corrected (исправлено, см. correctedBy),
 * correction (исправление другой записи), voided («события не было»).
 */
export function maintenanceView(res) {
  const r = res && typeof res === 'object' ? res : {};
  const t = r.thresholds && typeof r.thresholds === 'object' ? r.thresholds : {};
  const thresholds = Object.fromEntries(ALL_KINDS.map((k) => [k, k in t ? threshold(t[k]) : DEFAULT_THRESHOLDS[k]]));
  const d = r.defaults && typeof r.defaults === 'object' ? r.defaults : {};
  const defaults = Object.fromEntries(ALL_KINDS.map((k) => [k, k in d ? threshold(d[k]) : DEFAULT_THRESHOLDS[k]]));
  const labels = { ...MAINT_KIND_LABEL, ...Object.fromEntries(arr(r.kinds).filter((k) => k?.kind && k.label).map((k) => [k.kind, k.label])) };
  const resources = arr(r.counters)
    .map((x) => {
      const counters = Object.fromEntries(COUNTER_KINDS.map((k) => [k, counterView(x.kinds?.[k], thresholds[k])]));
      return {
        id: x.resource_id,
        number: num(x.number),
        title: x.title ?? (num(x.number) !== null ? `Стол ${x.number}` : 'Стол'),
        kind: kindOfType(x.type),
        active: x.active !== false,
        counters,
        reached: x.active === false ? [] : COUNTER_KINDS.filter((k) => counters[k].reached),
        near: COUNTER_KINDS.filter((k) => counters[k].near),
      };
    })
    .sort((a, b) => (a.active === b.active ? (a.number ?? 0) - (b.number ?? 0) : a.active ? -1 : 1));
  const byId = new Map(resources.map((x) => [x.id, x]));
  const events = arr(r.events)
    .map((e) => {
      const voided = e.voided === true;
      const corrects = e.corrects_id ?? null;
      const correctedBy = e.corrected_by ?? null;
      return {
        id: e.event_id,
        resourceId: e.resource_id,
        number: num(e.resource_number) ?? byId.get(e.resource_id)?.number ?? null,
        kind: e.kind,
        kindLabel: labels[e.kind] ?? e.kind,
        date: e.date,
        cost: num(e.cost_kopecks) ?? 0,
        comment: typeof e.comment === 'string' && e.comment.trim() ? e.comment.trim() : null,
        reason: typeof e.reason === 'string' && e.reason.trim() ? e.reason.trim() : null,
        corrects,
        correctedBy,
        voided,
        state: correctedBy ? 'corrected' : voided ? 'voided' : corrects ? 'correction' : 'active',
        by: e.created_by_name ?? null,
        at: e.created_at ?? null,
        cashbookEntryId: e.cashbook_entry_id ?? null,
      };
    })
    .sort((a, b) => (a.date === b.date ? String(b.at ?? '').localeCompare(String(a.at ?? '')) : a.date < b.date ? 1 : -1));
  return { thresholds, defaults, labels, resources, events, reachedCount: resources.filter((x) => x.reached.length).length };
}

/** Состояние записи истории словом: исправление и «не было» — с причиной. */
export function eventStateWords(e) {
  if (e.state === 'corrected') return 'Исправлено — см. запись выше';
  if (e.state === 'voided') return `События не было${e.reason ? `: ${e.reason}` : ''}`;
  if (e.state === 'correction') return `Исправление${e.reason ? `: ${e.reason}` : ''}`;
  return null;
}

/** Можно исправить: действующая запись (не исправленная и не «не было»). */
export const canCorrect = (e) => e.state === 'active' || e.state === 'correction';

/** Сводка «порог достигнут»: «Порог достигнут у 2 столов: стол 1 — сукно; стол 4 — шары.» */
export function reachedText(view) {
  const list = view.resources.filter((x) => x.reached.length);
  if (!list.length) return null;
  const parts = list.map((x) => `стол ${x.number} — ${x.reached.map((k) => MAINT_KINDS.find((m) => m.value === k).short.toLowerCase()).join(', ')}`);
  return `Порог достигнут у ${list.length} ${plural(list.length, TABLES_GEN)}: ${parts.join('; ')}.`;
}

export const eventMinDate = (today) => addDays(today, -MAINT_MAX_BACK_DAYS);
export const costMinDate = (today) => addDays(today, -MAINT_COST_MAX_BACK_DAYS);

/**
 * Проверка формы события (и исправления): стол, вид, дата не позже сегодня и не раньше 366 суток; стоимость — от 0
 * (пусто — без расхода), со стоимостью дата не старше 35 суток. cost — копейки, null (пусто) или NaN (не разобрали).
 * correction — нужна причина.
 */
export function eventFormErrors({ resourceId, kind, date, cost, comment, reason, voided }, today, { correction = false } = {}) {
  const e = {};
  if (correction && !String(reason ?? '').trim()) e.reason = 'Напишите причину исправления: она попадёт в журнал и владельцу.';
  if (correction && voided) return e;
  if (!resourceId) e.resource = 'Выберите стол.';
  if (!MAINT_KINDS.some((k) => k.value === kind)) e.kind = 'Выберите, что сделали.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) e.date = 'Укажите дату.';
  else if (today && date > today) e.date = 'Дата не может быть позже сегодняшней.';
  else if (today && date < eventMinDate(today)) e.date = `Событие можно отметить не раньше ${dayLong(eventMinDate(today))} — это ${MAINT_MAX_BACK_DAYS} дней назад.`;
  if (cost !== null && cost !== undefined && (!Number.isSafeInteger(cost) || cost < 0)) e.cost = 'Введите стоимость в рублях, например 18 000 или 18 000,50. Без стоимости — оставьте поле пустым.';
  else if (cost > 0 && today && !e.date && date < costMinDate(today)) e.cost = `Расход в кассу можно записать не раньше ${dayLong(costMinDate(today))}. Замену раньше этой даты отметьте без стоимости.`;
  if (String(comment ?? '').trim().length > COMMENT_MAX) e.comment = `Комментарий — не длиннее ${COMMENT_MAX} знаков.`;
  return e;
}

/** Тело POST …/maintenance — новое событие. */
export function eventBody({ resourceId, kind, date, cost, comment }) {
  const c = typeof comment === 'string' ? comment.trim() : '';
  return { resource_id: resourceId, kind, date, cost_kopecks: Number.isSafeInteger(cost) && cost > 0 ? cost : 0, ...(c ? { comment: c } : {}) };
}

/**
 * Тело исправления: только изменённые поля (остальное сервер берёт из исправляемого), причина обязательна;
 * voided — «события не было» ({corrects_id, reason, void: true}).
 */
export function correctionBody(orig, { resourceId, kind, date, cost, comment, reason, voided }) {
  const body = { corrects_id: orig.id, reason: String(reason ?? '').trim() };
  if (voided) return { ...body, void: true };
  if (resourceId && resourceId !== orig.resourceId) body.resource_id = resourceId;
  if (kind && kind !== orig.kind) body.kind = kind;
  if (date && date !== orig.date) body.date = date;
  const c = Number.isSafeInteger(cost) && cost > 0 ? cost : 0;
  if (c !== orig.cost) body.cost_kopecks = c;
  const cm = typeof comment === 'string' ? comment.trim() : '';
  if (cm !== (orig.comment ?? '')) body.comment = cm;
  return body;
}

/** Ошибка сервера при записи события → поле формы (по коду ответа). */
export function eventServerError(err) {
  if (err?.code === 'reason_required') return { reason: 'Без причины исправление не записать. Напишите, что было не так.' };
  if (err?.code === 'duplicate') return { form: 'Эта запись уже исправлена. Обновите список и исправляйте последнюю версию.' };
  if (err?.code === 'not_found') return { form: 'Стол или исправляемая запись не найдены в этом клубе. Обновите страницу.' };
  return null;
}

/** Что произойдёт после записи — для подсказки. */
export function eventEffect({ kind, cost, number }) {
  const parts = [];
  const k = MAINT_KINDS.find((m) => m.value === kind);
  if (k?.counter && number !== null && number !== undefined) parts.push(`Счётчик «${k.short}» стола ${number} начнётся заново с этой даты.`);
  if (cost > 0) parts.push(`${formatMoney(cost)} уйдут расходом в кассу управляющего (статья «Ремонт столов») этой датой.`);
  return parts;
}

/**
 * Проверка порогов: строки из полей → { values (null — без порога), errors }. Целые часы от 1 до 100 000; пусто —
 * без порога. В PUT уходят только изменённые виды (changed).
 */
export function parseThresholds(raw, current = {}) {
  const values = {};
  const errors = {};
  for (const k of ALL_KINDS) {
    if (!(k in (raw ?? {}))) continue;
    const s = String(raw[k] ?? '').replace(/[\s\u00a0]/g, '');
    if (!s) {
      values[k] = null;
      continue;
    }
    if (!/^\d+$/.test(s) || Number(s) < 1 || Number(s) > THRESHOLD_MAX) {
      errors[k] = `Целое число часов от 1 до ${nbsp(THRESHOLD_MAX.toLocaleString('ru-RU'))}, например 1 500. Без порога — оставьте поле пустым.`;
      continue;
    }
    values[k] = Number(s);
  }
  const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => (current[k] ?? null) !== v));
  return { values, changed, errors };
}

/** Часы для диктора: 1532 → «1 532 часа». */
export function hoursWords(h) {
  const v = Math.round(num(h) ?? 0);
  return `${hoursText(v).replace(' ч', '')} ${plural(v, HOURS)}`;
}

/** Строка таблицы «По столам» дашборда: cloth_hours, cloth_since, cloth_threshold_hours, cloth_due. */
export function clothView(r) {
  const h = num(r?.cloth_hours);
  if (h === null) return null;
  const thr = threshold(r.cloth_threshold_hours);
  return { hours: Math.round(h), since: typeof r.cloth_since === 'string' ? r.cloth_since : null, threshold: thr, due: r.cloth_due === true || (thr !== null && h >= thr) };
}
