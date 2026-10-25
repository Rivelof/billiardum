/**
 * Бильярдум — вид ресурса в интерфейсе (M5.8, решения №203–205): слово «стол» или «корт» по семье вида,
 * падежи, «за столом» / «на корте», длина слота словами. Без зависимостей, кроме plural.
 *
 * В модели и API — resource (CLAUDE.md); слово интерфейса берётся из семьи вида ресурса, а не пишется
 * «стол» напрямую. Справочник слов — тот же, что у сервера (server/lib/resource-kinds.mjs и
 * GET /api/resource-kinds); тест сверяет их.
 *
 *   familyOf({ family: 'court' })                  → 'court'
 *   familyOf({ type: 'padel_court' })              → 'court' (старый ответ без family)
 *   nounOf('court').pre                            → 'корте'
 *   nounOf(resource).atThis                        → 'на этом корте' | 'за этим столом'
 *   resourceName(resource)                         → 'Корт 2'
 *   resourceName('table', 6, { case: 'gen', capital: false }) → 'стола 6'
 *   countText(3, 'court')                          → '3 корта'
 *   slotLabel(90)                                  → '1,5 ч'
 *   slotOptions(90)                                → [90, 180, 270, 360]
 *   familyText('Стол уже занят. Выберите другой стол.', 'court') → 'Корт уже занят. Выберите другой корт.'
 */
import { plural } from './format.mjs';

/** Слово семьи по падежам и числам — как FAMILIES в server/lib/resource-kinds.mjs. */
export const FAMILIES = Object.freeze({
  table: Object.freeze({
    family: 'table',
    plural: Object.freeze(['стол', 'стола', 'столов']),
    cases: Object.freeze({ nom: 'стол', gen: 'стола', dat: 'столу', acc: 'стол', ins: 'столом', pre: 'столе' }),
  }),
  court: Object.freeze({
    family: 'court',
    plural: Object.freeze(['корт', 'корта', 'кортов']),
    cases: Object.freeze({ nom: 'корт', gen: 'корта', dat: 'корту', acc: 'корт', ins: 'кортом', pre: 'корте' }),
  }),
});

/** Где играют: «за столом», но «на корте». */
const PLACE = Object.freeze({
  table: Object.freeze({ at: 'за столом', atThis: 'за этим столом' }),
  court: Object.freeze({ at: 'на корте', atThis: 'на этом корте' }),
});

/** Виды со слотами (№204) — коды kind и type API. */
const COURT_KINDS = new Set(['padel_court']);

/** Длины слота, которые разрешает сервер (60, 90, 120 минут). */
export const SLOT_MINUTES = Object.freeze([60, 90, 120]);
/** Сколько слотов можно взять за раз — старт и продление корта (server/payments/quotes.mjs MAX_SLOTS). */
export const MAX_SLOTS = 4;
/** Игроков в одной игре корта (№205). */
export const COURT_MAX_PLAYERS = 4;

/**
 * Семья вида: 'table' или 'court'. Принимает семью строкой, ресурс из API ({ family, kind, type })
 * или код вида/типа. Неизвестное — стол (старые ответы, чужие модули).
 * @param {string | { family?: string, kind?: string, type?: string } | null | undefined} x
 * @returns {'table' | 'court'}
 */
export function familyOf(x) {
  if (x === 'court' || x === 'table') return x;
  if (typeof x === 'string') return COURT_KINDS.has(x) ? 'court' : 'table';
  if (!x || typeof x !== 'object') return 'table';
  if (x.family === 'court' || x.family === 'table') return x.family;
  if (COURT_KINDS.has(x.kind) || COURT_KINDS.has(x.type)) return 'court';
  return 'table';
}

export const isCourt = (x) => familyOf(x) === 'court';

const capital = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * Слова ресурса: падежи (nom, gen, dat, acc, ins, pre), формы после числа (one, few, many), «за столом» /
 * «на корте» (at, atThis) и они же с заглавной (Nom, At, AtThis). Если у ресурса есть noun справочника
 * сервера (kindJson: { one, few, many, nom, … }) — берём его.
 * @param {Parameters<typeof familyOf>[0]} x
 */
export function nounOf(x) {
  const family = familyOf(x);
  const f = FAMILIES[family];
  const server = x && typeof x === 'object' && x.noun && typeof x.noun === 'object' ? x.noun : null;
  const pick = (k, fallback) => (server && typeof server[k] === 'string' && server[k] ? server[k] : fallback);
  const cases = Object.fromEntries(Object.entries(f.cases).map(([k, v]) => [k, pick(k, v)]));
  const place = PLACE[family];
  return Object.freeze({
    family,
    one: pick('one', f.plural[0]),
    few: pick('few', f.plural[1]),
    many: pick('many', f.plural[2]),
    ...cases,
    at: place.at,
    atThis: place.atThis,
    Nom: capital(cases.nom),
    At: capital(place.at),
    AtThis: capital(place.atThis),
  });
}

/** Формы после числа: ['корт', 'корта', 'кортов']. */
export function pluralForms(x) {
  const n = nounOf(x);
  return [n.one, n.few, n.many];
}

/** «3 корта», «1 стол», «0 столов». */
export function countText(count, x) {
  return `${count} ${plural(count, pluralForms(x))}`;
}

/**
 * Название ресурса в тексте: «Корт 2», «Стол 4»; без номера — просто слово.
 * resourceName(resource) берёт номер из resource.number.
 * @param {Parameters<typeof familyOf>[0]} x
 * @param {number | string | null} [number]
 * @param {{ case?: 'nom' | 'gen' | 'dat' | 'acc' | 'ins' | 'pre', capital?: boolean }} [options]
 */
export function resourceName(x, number, options = {}) {
  const n = number === undefined && x && typeof x === 'object' ? x.number : number;
  const word = nounOf(x)[options.case ?? 'nom'] ?? nounOf(x).nom;
  const w = options.capital === false ? word : capital(word);
  return n === null || n === undefined || n === '' ? w : `${w} ${n}`;
}

/**
 * Длина слота ресурса в минутах или null (стол, корт без тарифа). У корта — resource.slot_minutes
 * (GET /api/t/{code}, availability), в котировке — quote.slot_minutes.
 */
export function slotMinutesOf(x) {
  const m = Number(x?.slot_minutes);
  return Number.isInteger(m) && m > 0 ? m : null;
}

/** Ресурс по слотам (№204): billing 'slot' или задан slot_minutes. */
export function isSlot(x) {
  return x?.billing === 'slot' || slotMinutesOf(x) !== null;
}

/**
 * Длительность слота словами коротко: 60 → '1 ч', 90 → '1,5 ч', 120 → '2 ч', 270 → '4,5 ч';
 * не кратное получасу — '1 ч 40 мин', меньше часа — '45 мин'.
 * @param {number} minutes
 */
export function slotLabel(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m < 60) return `${m}\u00a0мин`;
  if (m % 30 === 0) {
    const h = m / 60;
    return `${Number.isInteger(h) ? h : String(h).replace('.', ',')}\u00a0ч`;
  }
  return `${Math.floor(m / 60)}\u00a0ч ${m % 60}\u00a0мин`;
}

/** «1 слот», «3 слота». */
export function slotsText(count) {
  return `${count} ${plural(count, ['слот', 'слота', 'слотов'])}`;
}

/** Варианты корта: 1…max слотов в минутах — [90, 180, 270, 360]. Нет слота — []. */
export function slotOptions(slotMinutes, max = MAX_SLOTS) {
  const s = Number(slotMinutes);
  if (!Number.isInteger(s) || s <= 0) return [];
  return Array.from({ length: max }, (_, i) => s * (i + 1));
}

/** Цена слота словами: «2 400 ₽ за 1,5 ч». formatMoney передаётся, чтобы модуль не тянул Intl денег. */
export function slotPriceText(perSlotKopecks, slotMinutes, formatMoney) {
  return `${formatMoney(perSlotKopecks)} за ${slotLabel(slotMinutes)}`;
}

const LETTER = 'А-Яа-яЁё';
/** «за этим столом» → «на этом корте»: местоимение — в предложный падеж. */
const PREP = Object.freeze({ этим: 'этом', тем: 'том', своим: 'своём', моим: 'моём', вашим: 'вашем' });

/**
 * Готовый текст про стол → про корт (для словаря ошибок и общих подсказок): «Стол занят» → «Корт занят»,
 * «за этим столом» → «на этом корте», «со стола» → «с корта». Оба слова мужского рода, поэтому
 * прилагательные («другой», «свободен») не меняются. Для стола текст не меняется.
 * @param {string} text
 * @param {Parameters<typeof familyOf>[0]} x
 */
export function familyText(text, x) {
  if (typeof text !== 'string' || familyOf(x) !== 'court') return text;
  // Без ретроспективных проверок (?<!…): их нет в старых Safari — граница слова захватывается группой b
  return text
    .replace(new RegExp(`(^|[^${LETTER}])([Зз])а (?:(этим|тем|своим|моим|вашим) )?столом(?![${LETTER}])`, 'g'), (_, b, z, mid) => `${b}${z === 'З' ? 'Н' : 'н'}а ${mid ? `${PREP[mid]} ` : ''}корте`)
    .replace(new RegExp(`(^|[^${LETTER}])([Сс])о (?=стол)`, 'g'), '$1$2 ')
    .replace(new RegExp(`(^|[^${LETTER}])([Сс])тол(ами|ам|ах|ом|ов|а|у|е|ы)?(?![${LETTER}])`, 'g'), (_, b, c, end = '') => `${b}${c === 'С' ? 'К' : 'к'}орт${end}`);
}
