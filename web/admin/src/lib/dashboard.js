/**
 * Дашборд владельца (M5.2, docs/contracts/m5-2.md §3–§4, №166–172, №177–178): плитки и их формулы словами,
 * ▲▼ к прошлому периоду, форматы значений, построение серий графиков, тепловой карты и кольца ёмкости.
 * Без JSX и DOM — тестируется в Node (test/dashboard.test.mjs).
 *
 * Деньги приходят копейками, время — минутами, доли — процентами (41.3 = 41,3 %); форматирует клиент (№168).
 */

import { formatMoney, plural } from '@billiardum/shared/format';
import { familyText } from '@billiardum/shared/resource';
import { dayStartMinutes, isYmd, periodError, PRESETS, presetRange, WEEKDAY_SHORT, WEEKDAY_LONG } from './period.js';

export const TABS = [
  { value: 'summary', label: 'Сводка' },
  { value: 'money', label: 'Деньги' },
  { value: 'hall', label: 'Зал' },
  { value: 'guests', label: 'Гости и брони' },
  { value: 'control', label: 'Контроль' },
];

/** Типы столов в фильтре вида (значение в адресе экрана — коротко, на сервер — тип ресурса, KIND_QUERY). */
export const KINDS = [
  { value: 'pyramid', label: 'Пирамида' },
  { value: 'pool', label: 'Пул' },
  { value: 'snooker', label: 'Снукер' },
  { value: 'mixed', label: 'Смешанный' },
];
/** M5.8: семьи в фильтре вида — «Столы» (все столы) и «Корты» (падел-корты). */
export const FAMILY_KINDS = [
  { value: 'table', label: 'Столы' },
  { value: 'court', label: 'Корты' },
];
/** Вид падел-корта в разрезах дашборда (by_type: type 'padel_court'). */
export const COURT_TYPE = 'padel_court';
export const KIND_LABEL = Object.freeze({ ...Object.fromEntries([...KINDS, ...FAMILY_KINDS].map((k) => [k.value, k.label])), [COURT_TYPE]: 'Падел-корт' });
/**
 * Фильтр kind сервера (server/dashboard: тип ресурса или семья table | court). До M5.8 экран слал 'pool' — сервер
 * такой код не принимает (400), поэтому тип столов уходит полным типом ресурса.
 */
export const KIND_QUERY = Object.freeze({ pyramid: 'billiard_pyramid', pool: 'billiard_pool', snooker: 'billiard_snooker', mixed: 'billiard_mixed', table: 'table', court: 'court' });
export const kindQuery = (kind) => KIND_QUERY[kind] ?? null;
/** Семья фильтра: 'court' — только корты, иначе 'table' (столы, тип стола или весь клуб). */
export const kindFamily = (kind) => (kind === 'court' ? 'court' : 'table');

/**
 * Варианты фильтра вида: «Все» (пусто), при кортах — «Столы» и «Корты», затем типы столов, если их больше одного
 * (или выбран сейчас).
 * @param {string[]} kinds виды в данных: 'pyramid' | 'pool' | … | 'padel_court'
 * @param {string} current
 * @returns {{ label: string, all: string, options: { value: string, label: string }[] }}
 */
export function kindOptions(kinds, current = '') {
  const courts = kinds.includes(COURT_TYPE) || ['court', 'table'].includes(current);
  const types = KINDS.filter((k) => kinds.includes(k.value) || k.value === current);
  const options = [...(courts ? FAMILY_KINDS : []), ...(types.length > 1 || !courts ? types : types.filter((k) => k.value === current))];
  return { label: courts ? 'Вид' : 'Тип стола', all: courts ? 'Все: столы и корты' : 'Все столы', options };
}

const GAMES = ['игра', 'игры', 'игр'];
const TABLES = ['стол', 'стола', 'столов'];
const HOURS = ['час', 'часа', 'часов'];
const TIMES = ['раз', 'раза', 'раз'];

/**
 * Плитки: подпись, единица, что считается хорошим (рост выручки — хорошо, рост ручных действий и
 * расхождений — плохо) и формула простыми словами для кнопки «i».
 * good: 'up' | 'down' | null (без оценки).
 */
export const TILES = {
  revenue: { label: 'Выручка', unit: 'kopecks', good: 'up', formula: 'Все оплаты за период — столы, бар и прочее (депозиты, пакеты часов, взносы турниров) — минус возвраты. Сутки — рабочие сутки клуба, как в отчётах смен и утренней сводке.' },
  revenue_total: { label: 'Оплаты до возвратов', unit: 'kopecks', good: 'up', formula: 'Все оплаты за период, ещё без вычета возвратов.' },
  refunds: { label: 'Возвраты', unit: 'kopecks', good: 'down', formula: 'Деньги, возвращённые гостям. Возврат уменьшает выручку в день возврата, а не в день оплаты — как в отчёте смены.' },
  cash_net: { label: 'Наличные', unit: 'kopecks', good: null, formula: 'Оплаты наличными за вычетом возвратов наличными.' },
  cashless_net: { label: 'Безнал', unit: 'kopecks', good: null, formula: 'СБП, карта онлайн и карта на терминале за вычетом возвратов.' },
  games: { label: 'Игр', unit: 'count', good: 'up', formula: 'Сколько игр началось за период. Игра относится к суткам, в которые началась, даже если закончилась после их конца.' },
  play_hours: { label: 'Часов игры', unit: 'hours', good: 'up', formula: 'Часы игр, начатых в периоде, целиком. Сервисный свет сюда не входит.' },
  utilization: { label: 'Загрузка', unit: 'pct', good: 'up', formula: 'Часы игры, делённые на ёмкость. Ёмкость — столы в работе, умноженные на часы работы клуба. Стол, выведенный из работы, в ёмкость не входит.' },
  capacity_hours: { label: 'Ёмкость', unit: 'hours', good: null, formula: 'Столы в работе, умноженные на часы работы клуба. Если часы работы не заданы — 24 часа в сутки.' },
  service_hours: { label: 'Сервисный свет', unit: 'hours', good: 'down', formula: 'Часы, когда свет горел без игры: уборка, ремонт, проверка.' },
  unrealized_hours: { label: 'Нереализовано', unit: 'hours', good: 'down', formula: 'Ёмкость минус часы игры и сервиса: столы стояли свободными в часы работы клуба.' },
  avg_check_game: { round: true, label: 'Средний чек игры', unit: 'kopecks', good: 'up', formula: 'Выручка столов, делённая на число игр. Продления входят в чек своей игры.' },
  avg_check_bar: { round: true, label: 'Средний чек бара', unit: 'kopecks', good: 'up', formula: 'Выручка бара, делённая на число продаж бара — через QR и на кассе.' },
  revenue_per_table_day: { round: true, label: 'Выручка со стола в день', unit: 'kopecks', good: 'up', formula: 'Вся выручка, делённая на столо-дни в работе: число столов × дни периода.' },
  // M5.5 (вкладка «Сеть», server/networks/README.md): выручка за период на средний стол в работе
  revenue_per_table: { round: true, label: 'Выручка со стола', unit: 'kopecks', good: 'up', formula: 'Вся выручка за период, делённая на среднее число столов в работе. Сравнивает клубы разного размера.' },
  avg_hour_price: { round: true, label: 'Средняя цена часа', unit: 'kopecks', good: 'up', formula: 'Выручка столов, делённая на часы игры. Показывает, сколько в среднем стоит час с учётом скидок, пакетов и вечерних цен.' },
  guests: { label: 'Гостей', unit: 'count', good: 'up', formula: 'Гости, которые играли или бронировали за период. Новый — первая игра или бронь в этом клубе за всё время, повторный — играл здесь раньше. Только количества, без имён и телефонов.' },
  guests_new: { label: 'Новых гостей', unit: 'count', good: 'up', formula: 'Первая игра или бронь в этом клубе за всё время пришлась на этот период.' },
  guests_repeat: { label: 'Повторных', unit: 'count', good: 'up', formula: 'Играли в периоде и уже играли здесь раньше.' },
  guests_lost: { label: 'Потерянных', unit: 'count', good: 'down', formula: 'Играли 3 раза и больше, но не приходили 60 дней до конца периода.' },
  bookings: { label: 'Броней', unit: 'count', good: 'up', formula: 'Брони, которые начинались в периоде.' },
  no_show: { label: 'Не пришли', unit: 'count', good: 'down', formula: 'Брони, на которые гость не пришёл.' },
  extensions_from_app_share: { label: 'Продлений из приложения', unit: 'pct', good: 'up', formula: 'Доля продлений, которые гость оплатил сам — по QR или пакетом, без ресепшена, среди всех продлений, включая бесплатные.' },
  no_staff_share: { label: 'Игр без персонала', unit: 'pct', good: 'up', formula: 'Доля игр, которые гость запустил сам — по QR или по брони, без кассы ресепшена. Турнирные не считаются.' },
  expenses: { label: 'Расходы', unit: 'kopecks', good: 'down', formula: 'Расходы из кассы управляющего за период по статьям: аренда, закупка, зарплата и другие. Сторно уменьшает расходы.' },
  profit: { label: 'Прибыль', unit: 'kopecks', good: 'up', formula: 'Выручка минус расходы из кассы управляющего. Это управленческий учёт для вас, не бухгалтерия и не налоги.' },
  manual_actions: { label: 'Ручных действий', unit: 'count', good: 'down', formula: 'Сервисный свет, бесплатные игры, скидки выше лимита, отмены, возвраты, продления без оплаты, изменения тарифа и удаления из чека. Каждое — с причиной и уведомлением владельцу.' },
  automatic_actions: { label: 'Действий системы', unit: 'count', good: null, formula: 'Что система сделала сама: автоматические возвраты, выравнивание счётчиков, повтор чеков. Для сведения.' },
  cash_discrepancy: { label: 'Расхождения касс', unit: 'kopecks', good: 'down', abs: true, formula: 'Сумма расхождений наличных при закрытии смен: недостача — минус, излишек — плюс.' },
  alarms: { label: 'Тревог', unit: 'count', good: 'down', formula: 'Сколько тревог поднялось за период: свет без оплаты, стол без связи, касса не на связи и другие.' },
  alarms_problem: { label: 'Тревог просрочено', unit: 'count', good: 'down', formula: 'Тревоги, которые приняли позже 10 минут или не приняли совсем.' },
  lights_without_journal: { label: 'Свет без журнала', unit: 'count', good: 'down', target: 0, formula: 'Включения света и игры без записи в журнале. Цель пилота — 0: любое число больше нуля нужно разобрать.' },
  scan_to_light_median_sec: { label: 'Скан → свет', unit: 'seconds', good: 'down', formula: 'Медиана времени от сканирования QR на столе до включения света у игр, оплаченных по QR. Время на форме оплаты входит. Цель — меньше 20 секунд.' },
};

/** Порядок плиток на вкладках — как отдаёт сервер (server/dashboard/README.md), №177: «Расходы» и «Прибыль». */
export const TAB_TILES = {
  summary: ['revenue', 'expenses', 'profit', 'games', 'play_hours', 'utilization', 'avg_check_game', 'avg_check_bar', 'revenue_per_table_day', 'avg_hour_price', 'guests', 'no_staff_share'],
  money: ['revenue', 'revenue_total', 'refunds', 'cash_net', 'cashless_net', 'avg_check_game', 'avg_check_bar', 'expenses', 'profit'],
  hall: ['utilization', 'play_hours', 'capacity_hours', 'service_hours', 'unrealized_hours', 'games'],
  guests: ['guests', 'guests_new', 'guests_repeat', 'guests_lost', 'bookings', 'no_show', 'extensions_from_app_share'],
  control: ['manual_actions', 'automatic_actions', 'cash_discrepancy', 'alarms', 'alarms_problem', 'lights_without_journal', 'scan_to_light_median_sec', 'no_staff_share'],
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });

/** Число по-русски: 12345 → '12 345', 4.25 → '4,3'. */
export function formatNumber(v, digits = 0) {
  const n = num(v);
  if (n === null) return '—';
  return (digits ? nf1 : nf0).format(n);
}

/** Процент: 41.25 → '41,3 %' (неразрывный пробел перед знаком). */
export function formatPct(v) {
  const n = num(v);
  if (n === null) return '—';
  return `${nf1.format(Math.round(n * 10) / 10)}\u00a0%`;
}

/** Минуты → часы: 7530 → '125,5 ч', 45 → '0,8 ч'; от 100 часов — целыми. */
export function formatHours(minutes) {
  const n = num(minutes);
  if (n === null) return '—';
  const h = n / 60;
  return `${h >= 100 ? nf0.format(Math.round(h)) : nf1.format(Math.round(h * 10) / 10)}\u00a0ч`;
}

/** Секунды: 7 → '7 с', 95 → '1 мин 35 с'. */
export function formatSeconds(sec) {
  const n = num(sec);
  if (n === null) return '—';
  const s = Math.round(n);
  if (s < 60) return `${s}\u00a0с`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}\u00a0мин ${s % 60}\u00a0с` : `${m}\u00a0мин`;
}

/** Минуты коротко: 125 → '2 ч 5 мин', 12 → '12 мин'. */
export function formatMinutesShort(minutes) {
  const n = num(minutes);
  if (n === null) return '—';
  const m = Math.round(n);
  const h = Math.floor(m / 60);
  if (!h) return `${m}\u00a0мин`;
  return m % 60 ? `${h}\u00a0ч ${m % 60}\u00a0мин` : `${h}\u00a0ч`;
}

/**
 * Значение плитки по единице. null — «—» (нет данных, например средний чек без игр).
 * round — средние (чеки, цена часа) показываются целыми рублями: копейки в среднем — шум.
 */
export function formatValue(unit, v, { round = false } = {}) {
  const n = num(v);
  if (n === null) return '—';
  switch (unit) {
    case 'kopecks':
      return formatMoney(round ? Math.round(n / 100) * 100 : Math.round(n));
    case 'pct':
      return formatPct(n);
    case 'minutes':
      return formatHours(n);
    case 'hours':
      return formatHours(n * 60);
    case 'seconds':
      return formatSeconds(n);
    default:
      return formatNumber(n);
  }
}

/**
 * Изменение к прошлому периоду.
 * - Деньги и количества — в процентах от прошлого значения: «▲ 12 %», меньше 10 % — с десятыми.
 * - Доли (pct) — в процентных пунктах: 38 % → 41 % = «▲ 3 п. п.», а не «▲ 7,9 %».
 * - Было 0, стало больше — «▲ было 0» (процент от нуля не считается).
 * Тон — по смыслу плитки: рост выручки хороший, рост расхождений плохой.
 * @returns {null | { dir: 'up' | 'down' | 'flat', text: string, tone: 'good' | 'bad' | 'neutral', spoken: string }}
 */
export function deltaOf({ value, prev, unit, good }) {
  const v = num(value);
  const p = num(prev);
  if (v === null || p === null) return null;
  if (v === 0 && p === 0) return null; // оба периода пустые — сравнивать нечего
  let diff;
  let text;
  if (unit === 'pct') {
    diff = Math.round((v - p) * 10) / 10;
    text = `${nf1.format(Math.abs(diff))}\u00a0п.\u00a0п.`;
  } else if (p === 0) {
    diff = v;
    text = v === 0 ? '' : 'было 0';
  } else {
    const pct = ((v - p) / Math.abs(p)) * 100;
    diff = Math.abs(pct) < 0.05 ? 0 : pct;
    const abs = Math.abs(diff);
    text = `${abs < 10 ? nf1.format(Math.round(abs * 10) / 10) : nf0.format(Math.round(abs))}\u00a0%`;
  }
  if (diff === 0) return { dir: 'flat', text: 'без изменений', tone: 'neutral', spoken: 'Как в прошлом периоде.' };
  const dir = diff > 0 ? 'up' : 'down';
  const better = good === 'up' ? dir === 'up' : good === 'down' ? dir === 'down' : null;
  const tone = better === null ? 'neutral' : better ? 'good' : 'bad';
  const word = dir === 'up' ? 'Больше' : 'Меньше';
  const how = text === 'было 0' ? 'чем в прошлом периоде, там было 0' : `на ${text.replace(/\u00a0/g, ' ')}, чем в прошлом периоде`;
  const verdict = tone === 'good' ? ' Это хорошо.' : tone === 'bad' ? ' Это плохо.' : '';
  return { dir, text: `${dir === 'up' ? '▲' : '▼'} ${text}`, tone, spoken: `${word} ${how}.${verdict}` };
}

/** Доля от целого в процентах, без деления на ноль. */
export function share(part, total) {
  const a = num(part);
  const b = num(total);
  if (a === null || !b) return null;
  return (a / b) * 100;
}

/**
 * Плитки ответа в вид для экрана: известные — со своей подписью и формулой, неизвестные — пропускаются.
 * @param {Array<{ id: string, value: number | null, unit?: string, prev?: number | null, parts?: object }>} tiles
 * @param {string[]} order
 * @param {{ compare: boolean }} opts
 */
export function tileViews(tiles, order, { compare = true, family = 'table' } = {}) {
  const byId = new Map((Array.isArray(tiles) ? tiles : []).filter((t) => t && TILES[t.id]).map((t) => [t.id, t]));
  return order
    .filter((id) => byId.has(id))
    .map((id) => {
      const def = TILES[id];
      const t = byId.get(id);
      const unit = def.unit;
      return {
        id,
        // M5.8: фильтр «Корты» — те же плитки со словом «корт» («Выручка с корта в день»)
        label: family === 'court' ? familyText(def.label, 'court') : def.label,
        formula: family === 'court' ? familyText(def.formula, 'court') : def.formula,
        unit,
        value: num(t.value),
        text: formatValue(unit, t.value, def),
        prevText: compare && num(t.prev) !== null ? formatValue(unit, t.prev, def) : null,
        delta: compare ? deltaOf({ value: t.value, prev: t.prev, unit, good: def.good }) : null,
        parts: partsOf(id, t.parts),
        target: def.target ?? null,
        offTarget: def.target !== undefined && num(t.value) !== null && t.value !== def.target,
      };
    });
}

const PART_LABEL = { tables: 'Столы', bar: 'Бар', other: 'Прочее', new: 'Новые', repeat: 'Повторные' };

/**
 * Разбивка под значением (сервер: parts: [{ id, value, pct }]): выручка — столы / бар / прочее с долей
 * от выручки до возвратов, гости — новые / повторные с долей.
 */
function partsOf(id, parts) {
  if (!Array.isArray(parts) || !parts.length) return null;
  const list = parts.filter((p) => p && PART_LABEL[p.id]);
  const total = list.reduce((acc, p) => acc + (num(p.value) ?? 0), 0);
  return list.map((p) => {
    const v = num(p.value) ?? 0;
    const pc = num(p.pct) ?? (total ? share(v, total) : null);
    return { key: p.id, label: PART_LABEL[p.id], text: id === 'revenue' ? formatMoney(Math.round(v / 100) * 100) : formatNumber(v), pct: pc === null ? null : `${Math.round(pc)}\u00a0%` };
  });
}

// ---------- шкалы и подписи графиков ----------

/** «Красивый» шаг шкалы: 1, 2, 2,5, 5 × 10^k. */
function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  const k = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return k * pow;
}

/**
 * Деления оси от 0 до округлённого максимума: (13 700) → [0, 5 000, 10 000, 15 000].
 * @returns {{ max: number, ticks: number[] }}
 */
export function niceTicks(maxValue, count = 4) {
  const m = num(maxValue);
  if (!m || m <= 0) return { max: 1, ticks: [0] };
  const step = niceStep(m / count);
  const max = Math.ceil(m / step - 1e-9) * step;
  const ticks = [];
  for (let v = 0; v <= max + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return { max, ticks };
}

/** Деньги на оси коротко: 90000 коп. → '900 ₽', 1 250 000 → '12,5 тыс. ₽', 120 000 000 → '1,2 млн ₽'. */
export function compactMoney(kopecks) {
  const r = Math.round((num(kopecks) ?? 0) / 100);
  if (Math.abs(r) < 1000) return `${nf0.format(r)}\u00a0₽`;
  if (Math.abs(r) < 1_000_000) return `${nf1.format(Math.round(r / 100) / 10)}\u00a0тыс.\u00a0₽`;
  return `${nf1.format(Math.round(r / 100_000) / 10)}\u00a0млн\u00a0₽`;
}

/** Сколько подписей дат поместится: каждая ~52 px. Возвращает шаг (каждая n-я). */
export function labelEvery(count, widthPx, labelPx = 52) {
  if (count <= 0 || widthPx <= 0) return 1;
  const fit = Math.max(1, Math.floor(widthPx / labelPx));
  return Math.max(1, Math.ceil(count / fit));
}

/**
 * Столбцы с разбивкой: [{date, tables, bar, other}] → строки с суммой, максимум и признак «сегодня».
 * Пропущенные дни периода дополняются нулями — у каждого дня свой столбец.
 * @param {Array<Record<string, unknown>>} rows
 * @param {string[]} keys ключи серий по порядку снизу вверх
 * @param {{ days?: string[], today?: string }} [opts]
 */
export function stackedRows(rows, keys, { days, today } = {}) {
  const byDate = new Map((Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.date === 'string').map((r) => [r.date, r]));
  const dates = days ?? [...byDate.keys()].sort();
  let max = 0;
  let any = false;
  const out = dates.map((date) => {
    const r = byDate.get(date) ?? {};
    const values = keys.map((k) => Math.max(0, num(r[k]) ?? 0));
    const total = values.reduce((s, v) => s + v, 0);
    if (total > max) max = total;
    if (total > 0) any = true;
    return { date, values, total, today: date === today };
  });
  return { rows: out, max, empty: !any };
}

/**
 * Линии: [{date, a, b}] → точки по сериям; null — разрыв линии (нет игр — нет среднего чека).
 * @returns {{ dates: string[], series: Array<{ key: string, points: Array<number | null> }>, max: number, empty: boolean }}
 */
export function lineSeries(rows, keys, { days } = {}) {
  const byDate = new Map((Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.date === 'string').map((r) => [r.date, r]));
  const dates = days ?? [...byDate.keys()].sort();
  let max = 0;
  let any = false;
  const series = keys.map((key) => ({
    key,
    points: dates.map((d) => {
      const v = num(byDate.get(d)?.[key]);
      if (v === null) return null;
      any = true;
      if (v > max) max = v;
      return v;
    }),
  }));
  return { dates, series, max, empty: !any };
}

/** Часы суток по порядку рабочего дня: начало 06:00 → [6, 7, …, 23, 0, …, 5]. */
export function workHours(dayStart) {
  const start = Math.floor(dayStartMinutes(dayStart) / 60);
  return Array.from({ length: 24 }, (_, i) => (start + i) % 24);
}

/** Уровень тепловой карты 0–5: 0 — ни минуты, дальше по 20 %. null — клуб закрыт (нет ёмкости). */
export function heatLevel(pct) {
  const p = num(pct);
  if (p === null) return null;
  if (p <= 0) return 0;
  return Math.min(5, Math.ceil(p / 20));
}

export const HEAT_LEGEND = ['0 %', 'до 20 %', '21–40 %', '41–60 %', '61–80 %', '81–100 %'];

/**
 * Тепловая карта «день недели × час»: ячейки [{dow 1–7, hour 0–23, play_minutes, capacity_minutes}] →
 * 7 строк по 24 часа в порядке рабочих суток. Загрузка ячейки = сыграно / ёмкость. Ёмкости нет — клуб закрыт.
 */
export function heatmapMatrix(cells, dayStart) {
  const hours = workHours(dayStart);
  const key = (d, h) => d * 100 + h;
  const map = new Map();
  for (const c of Array.isArray(cells) ? cells : []) {
    if (!c || !(c.dow >= 1 && c.dow <= 7) || !(c.hour >= 0 && c.hour <= 23)) continue;
    const prev = map.get(key(c.dow, c.hour)) ?? { play: 0, capacity: 0 };
    map.set(key(c.dow, c.hour), { play: prev.play + (num(c.play_minutes) ?? 0), capacity: prev.capacity + (num(c.capacity_minutes) ?? 0) });
  }
  let any = false;
  let peak = null;
  const rows = [1, 2, 3, 4, 5, 6, 7].map((dow) => ({
    dow,
    label: WEEKDAY_SHORT[dow - 1],
    long: WEEKDAY_LONG[dow - 1],
    cells: hours.map((hour) => {
      const v = map.get(key(dow, hour));
      const pct = v && v.capacity > 0 ? Math.min(100, (v.play / v.capacity) * 100) : null;
      if (v?.play > 0) any = true;
      if (pct !== null && (!peak || pct > peak.pct)) peak = { dow, hour, pct };
      return { hour, pct, level: heatLevel(pct), play: v?.play ?? 0, capacity: v?.capacity ?? 0 };
    }),
  }));
  return { hours, rows, empty: !any, peak };
}

/** Часы ячейки словами: 21 → '21:00–22:00'. */
export function hourSpan(h) {
  const pad = (x) => String(x).padStart(2, '0');
  return `${pad(h)}:00–${pad((h + 1) % 24)}:00`;
}

/**
 * Кольцо «Загрузка в часах» (№170): ёмкость, сыграно, сервис, нереализовано = ёмкость − сыграно − сервис.
 * @returns {null | { capacity: number, segments: Array<{ key: string, label: string, minutes: number, pct: number }> }}
 */
export function capacityRing(cap) {
  const capacity = num(cap?.capacity_minutes);
  if (!capacity || capacity <= 0) return null;
  const played = Math.max(0, num(cap.played_minutes) ?? 0);
  const service = Math.max(0, num(cap.service_minutes) ?? 0);
  const unrealized = Math.max(0, capacity - played - service);
  return {
    capacity,
    segments: [
      { key: 'played', label: 'Сыграно', minutes: played, pct: share(played, capacity) },
      { key: 'service', label: 'Сервис', minutes: service, pct: share(service, capacity) },
      { key: 'unrealized', label: 'Нереализовано', minutes: unrealized, pct: share(unrealized, capacity) },
    ],
  };
}

/**
 * Дуги кольца: доли → углы в радианах от 12 часов по часовой; между дугами — зазор gap (радианы).
 * @param {number[]} values
 */
export function ringArcs(values, gap = 0.035) {
  const total = values.reduce((s, v) => s + Math.max(0, v), 0);
  if (!total) return [];
  const visible = values.filter((v) => v > 0).length;
  const free = Math.PI * 2 - (visible > 1 ? gap * visible : 0);
  let a = 0;
  return values.map((v) => {
    const len = (Math.max(0, v) / total) * free;
    const arc = { start: a, end: a + len, value: v };
    a += len + (v > 0 && visible > 1 ? gap : 0);
    return arc;
  });
}

/** SVG-путь дуги кольца толщиной (R − r). */
export function arcPath(cx, cy, R, r, a0, a1) {
  if (a1 - a0 <= 0) return '';
  const full = a1 - a0 >= Math.PI * 2 - 1e-6;
  const end = full ? a1 - 1e-4 : a1;
  const p = (rad, ang) => [cx + rad * Math.sin(ang), cy - rad * Math.cos(ang)].map((x) => Math.round(x * 100) / 100);
  const large = end - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = p(R, a0);
  const [x1, y1] = p(R, end);
  const [x2, y2] = p(r, end);
  const [x3, y3] = p(r, a0);
  return `M${x0} ${y0}A${R} ${R} 0 ${large} 1 ${x1} ${y1}L${x2} ${y2}A${r} ${r} 0 ${large} 0 ${x3} ${y3}Z`;
}

// ---------- зал сейчас ----------

/**
 * Карточки типов столов «Сейчас» (как «Статус зала» у LANGAME): занято X / Y, бронь, сервис, загрузка %.
 * @param {Array<{ kind: string, total: number, busy: number, booked?: number, service?: number, revenue_today_kopecks?: number }>} byKind
 */
export function kindCards(byKind) {
  return (Array.isArray(byKind) ? byKind : [])
    .filter((k) => k && num(k.total) > 0)
    .map((k) => ({
      kind: k.kind,
      label: KIND_LABEL[k.kind] ?? 'Другие столы',
      family: k.kind === COURT_TYPE ? 'court' : 'table',
      total: k.total,
      busy: Math.max(0, num(k.busy) ?? 0),
      booked: Math.max(0, num(k.booked) ?? 0),
      service: Math.max(0, num(k.service) ?? 0),
      pct: share(num(k.busy) ?? 0, k.total),
      revenue: num(k.revenue_today_kopecks ?? k.revenue),
      words: `занято ${num(k.busy) ?? 0} из ${k.total}`,
    }));
}

/**
 * «Сейчас» у клуба со столами и кортами: итог отдельно по семьям — «Столы: занято 5 из 8», «Корты: занято 1 из 2».
 * @returns {{ family: 'table' | 'court', label: string, total: number, busy: number, pct: number | null, words: string }[]}
 */
export function familyTotals(byKind) {
  const cards = kindCards(byKind);
  if (!cards.some((c) => c.family === 'court')) return [];
  return ['table', 'court']
    .map((family) => {
      const list = cards.filter((c) => c.family === family);
      const total = list.reduce((s, c) => s + c.total, 0);
      const busy = list.reduce((s, c) => s + c.busy, 0);
      return { family, label: family === 'court' ? 'Корты' : 'Столы', total, busy, pct: share(busy, total), words: `занято ${busy} из ${total}` };
    })
    .filter((f) => f.total > 0);
}

/** Итог по всем типам: «занято 7 / 32». */
export function hallTotals(byKind) {
  const cards = kindCards(byKind);
  const total = cards.reduce((s, c) => s + c.total, 0);
  const busy = cards.reduce((s, c) => s + c.busy, 0);
  return { total, busy, booked: cards.reduce((s, c) => s + c.booked, 0), service: cards.reduce((s, c) => s + c.service, 0), pct: share(busy, total) };
}

// ---------- контроль ----------

export const MANUAL_KIND_LABEL = {
  service_light: 'Сервисный свет',
  free_game: 'Бесплатная игра',
  discount_over_limit: 'Скидка выше лимита',
  cancel: 'Отмена',
  refund: 'Возврат',
  extend_free: 'Продление без оплаты',
  tariff_change: 'Изменение тарифа',
  receipt_line_delete: 'Удаление из чека',
};

/** Действия журнала каждого вида ручного действия — для ссылки «Открыть в журнале». */
export const MANUAL_KIND_ACTIONS = {
  service_light: 'service.start',
  free_game: 'manual.free_game',
  discount_over_limit: 'manual.discount,pos.discount_approval',
  cancel: 'pos.sale_canceled,order.cancel,manual.booking_cancel',
  refund: 'payment.refunded,pos.refund',
  extend_free: 'manual.extend_free',
  tariff_change: 'tariff.update',
  receipt_line_delete: 'pos.line_removed',
};

export const REACTION_LIMIT_MIN = 10;

function mean(list) {
  return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
}

function median(list) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Реакция на тревоги (№178): минуты от тревоги до «Принято» (acked_at − raised_at). Не принятые и принятые
 * позже 10 минут — проблемные. Сводка по видам и по сотрудникам, кто принял.
 * @param {Array<{ id: string, type: string, raised_at: string, acked_at?: string | null, acked_by_name?: string | null }>} items
 */
export function alarmReaction(items, { limit = REACTION_LIMIT_MIN } = {}) {
  const rows = (Array.isArray(items) ? items : [])
    .filter((a) => a && Date.parse(a.raised_at))
    .map((a) => {
      const raised = Date.parse(a.raised_at);
      const acked = a.acked_at ? Date.parse(a.acked_at) : NaN;
      const minutes = Number.isFinite(acked) ? Math.max(0, (acked - raised) / 60000) : null;
      return { ...a, minutes, problem: minutes === null || minutes > limit, by: a.acked_by_name ?? null };
    })
    .sort((a, b) => Date.parse(b.raised_at) - Date.parse(a.raised_at));
  const group = (keyOf) => {
    const map = new Map();
    for (const r of rows) {
      const k = keyOf(r);
      if (k === null) continue;
      const g = map.get(k) ?? { key: k, count: 0, problems: 0, unacked: 0, times: [] };
      g.count += 1;
      if (r.problem) g.problems += 1;
      if (r.minutes === null) g.unacked += 1;
      else g.times.push(r.minutes);
      map.set(k, g);
    }
    return [...map.values()].map(({ times, ...g }) => ({ ...g, median: median(times), avg: mean(times), max: times.length ? Math.max(...times) : null })).sort((a, b) => b.problems - a.problems || b.count - a.count);
  };
  return {
    rows,
    byType: group((r) => r.type),
    byStaff: group((r) => r.by),
    problems: rows.filter((r) => r.problem).length,
    median: median(rows.filter((r) => r.minutes !== null).map((r) => r.minutes)),
    avg: mean(rows.filter((r) => r.minutes !== null).map((r) => r.minutes)),
  };
}

/** «3 игры», «1 час», «2 раза» — для текстов экрана. */
export const words = {
  games: (n) => `${formatNumber(n)} ${plural(n, GAMES)}`,
  tables: (n) => `${formatNumber(n)} ${plural(n, TABLES)}`,
  hours: (n) => `${formatNumber(n)} ${plural(n, HOURS)}`,
  times: (n) => `${formatNumber(n)} ${plural(n, TIMES)}`,
};

/** Пустой ли период: ни выручки, ни игр. */
export function isEmptyPeriod(data) {
  const tiles = Array.isArray(data?.tiles) ? data.tiles : [];
  const v = (id) => num(tiles.find((t) => t.id === id)?.value) ?? 0;
  const ids = ['revenue', 'revenue_total', 'games', 'play_hours'].filter((id) => tiles.some((t) => t.id === id));
  return ids.length > 0 && ids.every((id) => v(id) === 0);
}

/**
 * Параметры запроса дашборда (§4) из состояния экрана.
 * @param {{ from: string, to: string, kind?: string, compare?: boolean, tab: string }} s
 */
export function dashboardQuery(s) {
  const q = { from: s.from, to: s.to, tab: s.tab };
  if (kindQuery(s.kind)) q.kind = kindQuery(s.kind);
  q.compare = s.compare === false ? 0 : 1;
  return q;
}

/**
 * Состояние фильтров из адреса (?tab=money&p=30d&kind=pool&cmp=0&all=1, свой период — &from=&to=).
 * tabs — вкладки, доступные человеку (M5.5: без «Денег» у управляющего сети, с «Сетью» у участника сети).
 */
export function readFilters(search, today, tabs = TABS) {
  const q = new URLSearchParams(search);
  const tab = tabs.some((t) => t.value === q.get('tab')) ? q.get('tab') : 'summary';
  let preset = PRESETS.some((p) => p.value === q.get('p')) ? q.get('p') : '7d';
  let range = presetRange(preset, today);
  if (preset === 'custom') {
    const from = q.get('from');
    const to = q.get('to');
    if (isYmd(from) && isYmd(to) && !periodError(from, to, today)) range = { from, to };
    else preset = '7d';
  }
  if (preset !== 'custom') range = presetRange(preset, today);
  const kind = KIND_QUERY[q.get('kind')] ? q.get('kind') : '';
  return { tab, preset, ...range, kind, compare: q.get('cmp') !== '0', all: q.get('all') === '1' };
}

export function writeFilters(f) {
  const q = new URLSearchParams();
  if (f.tab !== 'summary') q.set('tab', f.tab);
  if (f.preset !== '7d') q.set('p', f.preset);
  if (f.preset === 'custom') {
    q.set('from', f.from);
    q.set('to', f.to);
  }
  if (f.kind) q.set('kind', f.kind);
  if (!f.compare) q.set('cmp', '0');
  if (f.all) q.set('all', '1');
  const s = q.toString();
  return s ? `?${s}` : '';
}


// ---------- ответы сервера → вид экрана (server/dashboard/README.md) ----------

const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
/** Тип стола сервера → вид: 'billiard_pyramid' → 'pyramid'. */
export const kindOfType = (type) => String(type ?? '').replace(/^billiard_/, '') || 'pyramid';

/** Тепловая карта сервера { rows, cols, pct, play_minutes, capacity_minutes } (матрицы 7 × 24) → ячейки. */
export function heatCells(h) {
  if (Array.isArray(h)) return h;
  const rows = arr(h?.rows);
  const cols = arr(h?.cols);
  const out = [];
  rows.forEach((dow, i) =>
    cols.forEach((hour, j) => {
      const play = num(h.play_minutes?.[i]?.[j]);
      const cap = num(h.capacity_minutes?.[i]?.[j]);
      const pct = num(h.pct?.[i]?.[j]);
      // Без минут — по проценту: ёмкость 100, сыграно = процент
      if (cap === null) out.push({ dow, hour, play_minutes: pct ?? 0, capacity_minutes: pct === null ? 0 : 100 });
      else out.push({ dow, hour, play_minutes: play ?? 0, capacity_minutes: cap });
    }),
  );
  return out;
}

/**
 * Реакция на тревоги в одном виде: сервер отдаёт сводку { by_type, by_staff, problems, slow_after_sec },
 * заглушка или старый ответ — список тревог (считаем сами alarmReaction).
 */
export function reactionView(alarms) {
  if (Array.isArray(alarms)) {
    const r = alarmReaction(alarms);
    return {
      total: r.rows.length,
      problems: r.problems,
      limitMin: REACTION_LIMIT_MIN,
      avg: r.avg,
      byType: r.byType.map((g) => ({ key: g.key, count: g.count, problems: g.problems, unacked: g.unacked, avg: g.avg, problem: g.problems > 0 })),
      byStaff: r.byStaff.map((g) => ({ key: g.key, count: g.count, problems: g.problems, avg: g.avg, problem: g.problems > 0 })),
      rows: r.rows,
    };
  }
  const a = obj(alarms);
  const min = (sec) => (num(sec) === null ? null : sec / 60);
  const rows = arr(a.problems).map((p) => ({ id: p.alarm_id ?? p.id, type: p.type, level: p.level, resource_number: p.resource_number ?? null, raised_at: p.raised_at, acked_at: p.acked_at ?? null, by: p.acked_by_name ?? null, minutes: min(p.react_sec), problem: true }));
  const byType = arr(a.by_type);
  const acked = byType.reduce((acc, g) => acc + (num(g.acked) ?? 0), 0);
  const avgAll = acked ? byType.reduce((acc, g) => acc + (num(g.avg_react_sec) ?? 0) * (num(g.acked) ?? 0), 0) / acked / 60 : null;
  return {
    total: num(a.total) ?? 0,
    problems: rows.length,
    limitMin: num(a.slow_after_sec) ? a.slow_after_sec / 60 : REACTION_LIMIT_MIN,
    avg: avgAll,
    byType: arr(a.by_type).map((g) => ({ key: g.type, count: g.count ?? 0, problems: (g.slow ?? 0) + (g.unacked ?? 0), unacked: g.unacked ?? 0, avg: min(g.avg_react_sec), problem: Boolean(g.problem) })),
    byStaff: arr(a.by_staff).map((g) => ({ key: g.name ?? 'Сотрудник', count: g.count ?? 0, problems: g.slow ?? 0, avg: min(g.avg_react_sec), problem: Boolean(g.problem) })),
    rows,
  };
}

/** Ответ GET …/dashboard → вид экрана; пустые и неизвестные поля — честные пустые значения. */
export function dashboardView(res) {
  const p = obj(res?.period);
  const s = obj(res?.series);
  const t = obj(res?.tables);
  const byType = arr(t.by_type);
  const util = arr(s.utilization_daily);
  const kinds = [...new Set([...byType.map((x) => kindOfType(x.type)), ...util.flatMap((d) => Object.keys(obj(d.by_type)).map(kindOfType)), ...arr(p.kinds)])];
  const cash = t.cash && typeof t.cash === 'object' ? t.cash : null;
  const shifts = arr(cash?.shifts ?? t.shifts);
  const ctlShifts = arr(t.shifts);
  const g = obj(t.guests);
  const b = obj(t.bookings);
  const w = obj(t.waitlist);
  const ex = obj(t.extensions);
  const pk = obj(t.packages);
  const tr = obj(t.tournaments);
  const pl = obj(t.pilot);
  const lights = pl.lights_without_journal;
  return {
    period: { from: p.from, to: p.to, today: p.today ?? null, timezone: p.timezone ?? null, dayStart: p.day_start_local ?? DEFAULT_DAY_START_LOCAL, missing: arr(p.missing_days), kinds },
    compare: res?.compare_period ?? null,
    tiles: arr(res?.tiles),
    clubs: arr(t.clubs),
    revenueDaily: arr(s.revenue_daily).map((r) => ({ date: r.date, tables: num(r.tables_kopecks) ?? 0, bar: num(r.bar_kopecks) ?? 0, other: num(r.other_kopecks) ?? 0, net: num(r.net_kopecks), today: Boolean(r.today) })),
    revenue30: arr(s.revenue_30d).map((r) => ({ date: r.date, net: Math.max(0, num(r.net_kopecks) ?? num(r.total_kopecks) ?? 0), today: Boolean(r.today) })),
    money: {
      structure: arr(t.structure).map((x) => ({ id: x.id, amount: num(x.kopecks) ?? 0, pct: num(x.pct) })),
      methods: arr(t.methods).map((x) => ({ id: x.id, amount: num(x.kopecks) ?? 0, refunds: num(x.refunds_kopecks) ?? 0, pct: num(x.pct) })),
      sources: arr(t.sources).map((x) => ({ id: x.id, amount: num(x.kopecks) ?? 0, pct: num(x.pct) })),
      refunds: { count: num(t.refunds?.count) ?? 0, amount: num(t.refunds?.total_kopecks) ?? 0 },
      cash: cash ? { start: num(cash.start_kopecks), sales: num(cash.cash_sales_kopecks), refunds: num(cash.cash_refunds_kopecks), collections: num(cash.collections_kopecks), discrepancy: num(cash.discrepancy_kopecks) ?? 0 } : null,
      shifts,
      daily: arr(t.daily).map((d) => ({ date: d.date, revenue: num(d.net_kopecks) ?? num(d.total_kopecks) ?? 0, tables: num(d.tables_kopecks), bar: num(d.bar_kopecks), games: num(d.games) ?? 0, avg_check_game: num(d.avg_check_game_kopecks), avg_check_bar: num(d.avg_check_bar_kopecks), utilization: num(d.utilization_pct), today: Boolean(d.today) })),
      expenses: arr(t.expenses ?? t.expenses_by_category).map((e) => ({ name: e.name ?? e.category, amount: num(e.amount_kopecks) ?? 0 })),
    },
    hall: {
      cells: heatCells(s.heatmap),
      ring: s.ring ?? t.capacity ?? null,
      loadDaily: util.map((d) => {
        const o = { date: d.date, total: num(d.pct) };
        for (const [k, v] of Object.entries(obj(d.by_type))) o[kindOfType(k)] = num(v);
        return o;
      }),
      byKind: byType.map((x) => ({ kind: kindOfType(x.type), tables: num(x.tables) ?? 0, games: num(x.games), play_minutes: num(x.play_minutes) ?? 0, revenue: num(x.revenue_kopecks), load: num(x.utilization_pct) })),
      resources: arr(t.by_resource).map((r) => ({ id: r.resource_id, number: r.number, title: r.title ?? null, kind: kindOfType(r.type), family: r.family === 'court' || r.type === COURT_TYPE ? 'court' : 'table', club: r.club_name ?? null, games: num(r.games), play_minutes: num(r.play_minutes) ?? (num(r.play_hours) ?? 0) * 60, revenue: num(r.revenue_kopecks), load: num(r.utilization_pct), cloth_hours: num(r.cloth_hours), cloth_since: r.cloth_since ?? null, cloth_threshold_hours: num(r.cloth_threshold_hours), cloth_due: r.cloth_due === true })),
      // M5.6 (server/maintenance/README.md): прогноз 7 × 24 рядом с тепловой картой и подсказки по цене;
      // у «всех клубов» forecast: null, подсказки — с club_id и club_name
      forecast: s.forecast && typeof s.forecast === 'object' ? s.forecast : null,
      hints: arr(res?.hints ?? s.hints ?? t.hints),
    },
    guests: {
      new: num(g.new) ?? 0,
      repeat: num(g.repeat) ?? 0,
      lost: num(g.lost) ?? 0,
      newPct: num(g.new_pct),
      repeatPct: num(g.repeat_pct),
      bookings: { total: num(b.total) ?? 0, came: num(b.came) ?? 0, noShow: num(b.no_show) ?? 0, canceled: num(b.canceled) ?? 0, upcoming: num(b.upcoming) ?? 0, lead: num(b.lead_minutes_avg) },
      waitlist: { offered: num(w.offered) ?? 0, accepted: num(w.accepted) ?? 0 },
      extensions: { total: num(ex.total) ?? 0, fromApp: num(ex.from_app) ?? 0, free: num(ex.free) ?? 0, pct: num(ex.from_app_pct) },
      packages: { sold: num(pk.sold) ?? 0, soldMinutes: num(pk.sold_minutes), usedMinutes: num(pk.used_minutes) },
      tournaments: { fees: num(tr.fees_kopecks) ?? 0, participants: num(tr.participants) ?? 0 },
      plus: num(obj(t.plus).matches_counted) ?? 0,
      daily: arr(s.guests_daily).map((d) => ({ date: d.date, new: num(d.new) ?? 0, returning: Math.max(0, (num(d.active) ?? 0) - (num(d.new) ?? 0)) })),
    },
    control: {
      manual: arr(t.manual_items).map((m, i) => ({ id: m.id ?? `${m.at}-${i}`, at: m.at, action: m.action, staff_id: m.actor_id ?? null, staff_name: m.actor_name ?? null, resource_number: m.resource_number ?? null, reason: m.reason ?? null, amount_kopecks: num(m.amount_kopecks), club_name: m.club_name ?? null })),
      byAction: arr(t.manual_by_action).map((x) => ({ action: x.action, count: num(x.count) ?? 0 })),
      byStaff: arr(t.manual_by_staff).map((x) => ({ id: x.user_id ?? null, name: x.name ?? 'Сотрудник', count: num(x.count) ?? 0, actions: Object.entries(obj(x.by_action)) })),
      automatic: num(obj(t.automatic).count) ?? 0,
      shifts: ctlShifts.filter((x) => x.status === 'discrepancy' || (num(x.discrepancy_kopecks) ?? 0) !== 0).map((x) => ({ id: x.shift_id ?? x.id, number: x.number ?? null, opened_at: x.opened_at ?? null, closed_at: x.closed_at ?? null, staff: x.closed_by_name ?? x.opened_by_name ?? null, discrepancy: num(x.discrepancy_kopecks) ?? 0, comment: x.close_comment ?? null, club: x.club_name ?? null })),
      shiftsTotal: ctlShifts.length,
      reaction: reactionView(t.alarms),
      pilot: {
        lights: typeof lights === 'number' ? lights : lights ? (num(lights.commands) ?? 0) + (num(lights.sessions) ?? 0) : null,
        lightsDetail: lights && typeof lights === 'object' ? { commands: num(lights.commands) ?? 0, sessions: num(lights.sessions) ?? 0 } : null,
        scanMedian: num(obj(pl.scan_to_light).median_sec),
        scanCount: num(obj(pl.scan_to_light).count),
        scanUnder20: num(obj(pl.scan_to_light).under_20_pct),
        noStaffPct: num(pl.no_staff_share_pct),
        extAppPct: num(pl.extensions_from_app_pct),
      },
    },
  };
}

const DEFAULT_DAY_START_LOCAL = '06:00';

/**
 * Ответ GET …/dashboard/now → вид: по типам столов «занято X / Y», итог, кто в смене, выручка сегодня.
 * У «всех клубов» — { clubs: [{ name, … }], totals }: типы складываются, смены — по клубам.
 */
export function nowView(res) {
  const r = obj(res);
  const clubs = Array.isArray(r.clubs) ? r.clubs : [r];
  const byKind = new Map();
  const onShift = [];
  let revenue = 0;
  let hasRevenue = false;
  for (const c of clubs) {
    for (const x of arr(c.by_type)) {
      const k = kindOfType(x.type);
      const e = byKind.get(k) ?? { kind: k, total: 0, busy: 0, booked: 0, service: 0, offline: 0 };
      e.total += num(x.total) ?? 0;
      e.busy += num(x.busy) ?? 0;
      e.booked += num(x.reserved) ?? 0;
      e.service += num(x.service) ?? 0;
      e.offline += (num(x.offline) ?? 0) + (num(x.fault) ?? 0);
      byKind.set(k, e);
    }
    if (c.shift) onShift.push({ name: c.shift.opened_by_name ?? null, since: c.shift.opened_at ?? null, number: c.shift.number ?? null, club: clubs.length > 1 ? (c.name ?? null) : null });
    const net = num(c.revenue_today?.net_kopecks);
    if (net !== null) {
      revenue += net;
      hasRevenue = true;
    }
  }
  const totals = obj(r.totals);
  return {
    byKind: [...byKind.values()],
    loadNow: num(totals.utilization_now_pct),
    loadDay: num(totals.utilization_day_pct),
    onShift,
    revenueToday: hasRevenue ? revenue : null,
    gamesToday: num(r.games_today),
  };
}

/**
 * «Все мои клубы» (№166): у владельца нескольких клубов и у управляющего двух и более клубов — только клубы,
 * где он владелец или управляющий. Экспорт сводки — только если во всех этих клубах он владелец.
 * @param {Array<{ club_id: string, role: string }>} clubs членства из GET /api/me
 */
export function allClubsScope(clubs) {
  const mine = (Array.isArray(clubs) ? clubs : []).filter((c) => c.role === 'owner' || c.role === 'manager');
  return { canAll: mine.length > 1, count: mine.length, exportAll: mine.length > 1 && mine.every((c) => c.role === 'owner') };
}
