// Эло и уровни Бильярдум+ (PRODUCT §13, решение №136). Чистые функции — те же формулы, что
// в bl.plus_settle_match (миграция 0850): тест сверяет их с базой на случайных партиях.

export const START_RATING = 1200;
export const K_NEW = 40;
export const K_REGULAR = 20;
/** Сколько партий дисциплины игрок считается новичком (K = 40). */
export const NEW_GAMES = 20;
/** Множитель турнирной партии ×1,5 — в десятых (как multiplier_x10 в базе). */
export const TOURNAMENT_X10 = 15;
export const DISCIPLINES = Object.freeze(['pyramid', 'pool', 'snooker']);
/** Тип стола (resources.type) → дисциплина рейтинга. */
export const DISCIPLINE_OF_TYPE = Object.freeze({ billiard_pyramid: 'pyramid', billiard_pool: 'pool', billiard_snooker: 'snooker' });
export const TYPE_OF_DISCIPLINE = Object.freeze({ pyramid: 'billiard_pyramid', pool: 'billiard_pool', snooker: 'billiard_snooker' });

/** Уровни (любительские): нижняя граница рейтинга → код и название. */
export const LEVELS = Object.freeze([
  { code: 'novice', title: 'Новичок', min: -Infinity },
  { code: 'amateur', title: 'Любитель', min: 1200 },
  { code: 'experienced', title: 'Опытный', min: 1400 },
  { code: 'strong', title: 'Сильный', min: 1600 },
  { code: 'master', title: 'Мастер', min: 1800 },
]);

/** Ожидаемый результат игрока с рейтингом ra против rb. */
export function expected(ra, rb) {
  return 1 / (1 + 10 ** ((rb - ra) / 400));
}

/** K по числу сыгранных партий дисциплины до этой. */
export function kFactor(gamesBefore) {
  return gamesBefore < NEW_GAMES ? K_NEW : K_REGULAR;
}

/** Округление половины от нуля (как round(numeric) в Postgres). */
export function roundHalfAway(x) {
  return Math.sign(x) * Math.round(Math.abs(x));
}

/**
 * Изменение рейтинга одного игрока.
 * @param {{ rating: number, opponent: number, games: number, win: boolean, multiplierX10?: number }} a
 */
export function delta({ rating, opponent, games, win, multiplierX10 = 10 }) {
  const k = kFactor(games);
  const d = roundHalfAway((k * multiplierX10 * ((win ? 1 : 0) - expected(rating, opponent))) / 10);
  return d === 0 ? 0 : d; // без -0
}

/**
 * Пересчёт партии: a и b — { rating, games }, winner — 'a' | 'b'.
 * @returns {{ a: { delta, k, after }, b: { delta, k, after } }}
 */
export function applyElo(a, b, winner, { multiplierX10 = 10 } = {}) {
  const da = delta({ rating: a.rating, opponent: b.rating, games: a.games, win: winner === 'a', multiplierX10 });
  const db = delta({ rating: b.rating, opponent: a.rating, games: b.games, win: winner === 'b', multiplierX10 });
  return {
    a: { delta: da, k: kFactor(a.games), after: a.rating + da },
    b: { delta: db, k: kFactor(b.games), after: b.rating + db },
  };
}

export function levelOf(rating) {
  let out = LEVELS[0];
  for (const l of LEVELS) if (rating >= l.min) out = l;
  return out.code;
}

export function levelTitle(code) {
  return LEVELS.find((l) => l.code === code)?.title ?? null;
}

const MSK = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit' });

/** Сезон — календарный месяц по Москве: 'YYYY-MM'. */
export function seasonOf(date) {
  const parts = Object.fromEntries(MSK.formatToParts(new Date(date)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}`;
}

export function isSeason(s) {
  return s === 'all' || (typeof s === 'string' && /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(s));
}

/** Счёт партии: целые, без ничьей; в пирамиде — до 8 шаров (у победителя 8), иначе до 99. */
export function scoreValid(discipline, a, b) {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a === b) return false;
  if (discipline === 'pyramid') return Math.max(a, b) === 8 && Math.min(a, b) <= 7;
  return Math.max(a, b) <= 99;
}

/** Ник: 3–20 символов — латиница, кириллица, цифры, «_», «-»; цифр не больше 6 (не телефон). */
export function nickValid(nick) {
  return typeof nick === 'string' && /^[0-9A-Za-zА-ЯЁа-яё_-]{3,20}$/.test(nick) && nick.replace(/[^0-9]/g, '').length <= 6;
}
