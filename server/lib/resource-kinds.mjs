// Виды ресурсов (PRODUCT §1 «универсальное ядро», M5.8 №203–205): справочник без базы.
//
// В модели и API — resource и его тип (bl.resources.type); слово в интерфейсе берётся из семьи
// вида: столы бильярда — «стол», падел-корт — «корт». Код вида в API (kind) — как в мастере зала:
// pyramid | pool | snooker | mixed | padel_court.
//
// * billing: 'hourly' — тариф за час, поминутно (№43, №44); 'slot' — игра и бронь блоками слота
//   (№204), цена за слот по расписанию, шаг продления — слот. Длина слота — из тарифа клуба.
// * max_players — сколько гостей может быть в одной игре («Я играю», №205): у корта 4.
// * Нумерация ресурсов — своя у каждой семьи: «Стол 1…8» и «Корт 1…2» в одном клубе (миграция 1300).

export const RESOURCE_TYPES = Object.freeze(['billiard_pyramid', 'billiard_pool', 'billiard_snooker', 'billiard_mixed', 'padel_court']);
export const TABLE_TYPES = Object.freeze(['billiard_pyramid', 'billiard_pool', 'billiard_snooker', 'billiard_mixed']);
export const SLOT_MINUTES = Object.freeze([60, 90, 120]);
/** Длина слота, которую мастер тарифов предлагает по умолчанию (падел — обычно полтора часа). */
export const DEFAULT_SLOT_MINUTES = 90;
/** Игроков в игре стола: прежний предел «Я играю за этим столом» (light, M1). */
export const TABLE_MAX_PLAYERS = 20;
export const COURT_MAX_PLAYERS = 4;

/** Слово семьи по падежам и числам (plural: одна, две, пять). */
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

const INFO = Object.freeze({
  billiard_pyramid: Object.freeze({ type: 'billiard_pyramid', kind: 'pyramid', family: 'table', label: 'Пирамида', billing: 'hourly', max_players: TABLE_MAX_PLAYERS, discipline: 'pyramid' }),
  billiard_pool: Object.freeze({ type: 'billiard_pool', kind: 'pool', family: 'table', label: 'Пул', billing: 'hourly', max_players: TABLE_MAX_PLAYERS, discipline: 'pool' }),
  billiard_snooker: Object.freeze({ type: 'billiard_snooker', kind: 'snooker', family: 'table', label: 'Снукер', billing: 'hourly', max_players: TABLE_MAX_PLAYERS, discipline: 'snooker' }),
  billiard_mixed: Object.freeze({ type: 'billiard_mixed', kind: 'mixed', family: 'table', label: 'Смешанный', billing: 'hourly', max_players: TABLE_MAX_PLAYERS, discipline: null }),
  padel_court: Object.freeze({ type: 'padel_court', kind: 'padel_court', family: 'court', label: 'Падел', billing: 'slot', max_players: COURT_MAX_PLAYERS, discipline: 'padel' }),
});

/** kind (API) → type (база) и обратно. */
export const KIND_TO_TYPE = Object.freeze(Object.fromEntries(Object.values(INFO).map((i) => [i.kind, i.type])));
export const TYPE_TO_KIND = Object.freeze(Object.fromEntries(Object.values(INFO).map((i) => [i.type, i.kind])));
export const TABLE_KINDS = Object.freeze(TABLE_TYPES.map((t) => INFO[t].kind));

/** Сведения о типе; неизвестный тип — как стол (старые строки, чужие модули). */
export function typeInfo(type) {
  return INFO[type] ?? { type, kind: null, family: 'table', label: String(type ?? ''), billing: 'hourly', max_players: TABLE_MAX_PLAYERS, discipline: null };
}

export const isResourceType = (type) => Object.hasOwn(INFO, type);
export const familyOf = (type) => typeInfo(type).family;
export const isCourt = (type) => familyOf(type) === 'court';
export const isSlotType = (type) => typeInfo(type).billing === 'slot';
export const maxPlayers = (type) => typeInfo(type).max_players;
export const typesOfFamily = (family) => RESOURCE_TYPES.filter((t) => INFO[t].family === family);

/** Слово ресурса: noun('padel_court', 'gen') → «корта». */
export function noun(type, grammaticalCase = 'nom') {
  const f = FAMILIES[familyOf(type)];
  return f.cases[grammaticalCase] ?? f.cases.nom;
}

const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Название ресурса в тексте: resourceName('padel_court', 2) → «Корт 2»,
 * resourceName('billiard_pool', 6, { case: 'gen', capital: false }) → «стола 6».
 */
export function resourceName(type, number, { case: grammaticalCase = 'nom', capital: cap = true } = {}) {
  const word = noun(type, grammaticalCase);
  const n = number === null || number === undefined || number === '' ? '' : ` ${number}`;
  return `${cap ? capital(word) : word}${n}`;
}

/** Вид ресурса для API: код, семья, подпись и слова. */
export function kindJson(type) {
  const i = typeInfo(type);
  const f = FAMILIES[i.family];
  return {
    kind: i.kind,
    type: i.type,
    family: i.family,
    label: i.label,
    billing: i.billing,
    max_players: i.max_players,
    noun: { one: f.plural[0], few: f.plural[1], many: f.plural[2], ...f.cases },
  };
}

/** GET /api/resource-kinds: справочник видов и семей (публичный, без данных клубов). */
export function kindsJson() {
  return {
    kinds: RESOURCE_TYPES.map(kindJson),
    families: Object.values(FAMILIES).map((f) => ({ family: f.family, noun: { one: f.plural[0], few: f.plural[1], many: f.plural[2], ...f.cases } })),
    slot_minutes: [...SLOT_MINUTES],
    default_slot_minutes: DEFAULT_SLOT_MINUTES,
  };
}
