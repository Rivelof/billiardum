/**
 * Бильярдум+ и турниры (M4, PRODUCT §13–14, решения №131–142): дисциплины, уровни, достижения, причины
 * «не засчитана», форматы и статусы турниров, разбор сетки. Без зависимостей — работает в браузере и в Node.
 */

export const DISCIPLINES = Object.freeze(['pyramid', 'pool', 'snooker']);
export const DISCIPLINE_WORD = Object.freeze({ pyramid: 'Пирамида', pool: 'Пул', snooker: 'Снукер' });

/** Уровни (любительские, не разряды): нижняя граница рейтинга. */
export const LEVELS = Object.freeze([
  { code: 'novice', title: 'Новичок', from: -Infinity },
  { code: 'amateur', title: 'Любитель', from: 1200 },
  { code: 'experienced', title: 'Опытный', from: 1400 },
  { code: 'strong', title: 'Сильный', from: 1600 },
  { code: 'master', title: 'Мастер', from: 1800 },
]);

/** Уровень по рейтингу (сервер может прислать свой — тогда берём его). */
export function levelOf(rating) {
  const r = Number(rating);
  if (!Number.isFinite(r)) return LEVELS[1];
  let out = LEVELS[0];
  for (const l of LEVELS) if (r >= l.from) out = l;
  return out;
}

/** Название уровня: код или рейтинг → «Любитель». */
export function levelTitle(level, rating) {
  return LEVELS.find((l) => l.code === level || l.title === level)?.title ?? levelOf(rating).title;
}

/** До следующего уровня: { next, left } или null у мастера. */
export function nextLevel(rating) {
  const r = Number(rating);
  const next = LEVELS.find((l) => l.from > r);
  return next ? { next: next.title, left: Math.ceil(next.from - r) } : null;
}

/** Достижения — только проверяемые по данным (PRODUCT §13). */
export const ACHIEVEMENTS = Object.freeze({
  dry: { title: 'Сухая', text: 'Победа 8:0 в пирамиде' },
  regular: { title: 'Завсегдатай', text: '10 игр в одном клубе' },
  night_shift: { title: 'Ночная смена', text: '5 игр, начатых после полуночи' },
  tournament: { title: 'Турнирный', text: 'Первый турнир' },
  five_clubs: { title: 'Пять клубов', text: 'Игры в пяти разных клубах' },
  // В M4 «Камбэк» не выдаётся (№145): нет счёта по ходу партии — показываем, только если уже получено
  comeback: { title: 'Камбэк', text: 'Победа после счёта 3:7', soon: true },
});

/** Почему партия не попала в рейтинг (T23 и правила №137). */
export const NOT_COUNTED = Object.freeze({
  pair_daily_limit: 'в рейтинг не засчитана — 4-я партия пары за сутки',
  // №148: у игрока не больше 6 засчитанных партий в сутки клуба
  player_daily_limit: 'в рейтинг не засчитана — лимит партий за сутки',
  not_same_session: 'в рейтинг не засчитана — игроки не за одним столом',
  confirm_timeout: 'в рейтинг не засчитана — соперник не подтвердил за 30 минут',
  annulled: 'в рейтинг не засчитана — управляющий отменил результат',
});

export function notCountedText(reason) {
  if (!reason) return null;
  return NOT_COUNTED[reason] ?? 'в рейтинг не засчитана';
}

/** Статус партии для игрока: слово и тон бейджа. */
export function matchState(match, meId) {
  const me = match?.players?.find((p) => p.user_id === meId);
  const s = match?.status;
  if (s === 'pending') return me?.confirmed ? { word: 'Ждём соперника', tone: 'pending', canConfirm: false } : { word: 'Подтвердите счёт', tone: 'play', canConfirm: true };
  if (s === 'disputed') return { word: 'Спор у управляющего', tone: 'alert', canConfirm: false };
  if (s === 'expired') return { word: 'Не подтверждена', tone: 'off', canConfirm: false };
  if (s === 'confirmed' || s === 'resolved') return match.counted === false ? { word: 'Не в рейтинге', tone: 'off', canConfirm: false } : { word: 'В рейтинге', tone: 'free', canConfirm: false };
  return { word: 'Партия', tone: 'off', canConfirm: false };
}

/** Счёт партии корректен: целые, не отрицательные, не ничья; в пирамиде — до 8 шаров. */
export function scoreValid(discipline, a, b) {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a === b) return false;
  if (discipline === 'pyramid') return Math.max(a, b) === 8 && Math.min(a, b) <= 7;
  return Math.max(a, b) <= 99;
}

/** Счёт матча турнира до N побед: у победителя ровно N, у проигравшего меньше. */
export function raceScoreValid(raceTo, a, b) {
  return Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= 0 && Math.max(a, b) === raceTo && Math.min(a, b) < raceTo;
}

export const FORMAT_WORD = Object.freeze({ single_elim: 'Олимпийская система', groups_playoff: 'Группы и плей-офф' });
export const TOURNAMENT_STATUS = Object.freeze({
  draft: { word: 'Черновик', tone: 'off' },
  registration: { word: 'Идёт запись', tone: 'free' },
  closed: { word: 'Запись закрыта', tone: 'pending' },
  running: { word: 'Идёт турнир', tone: 'play' },
  finished: { word: 'Завершён', tone: 'off' },
  canceled: { word: 'Отменён', tone: 'alert' },
});

export const BRACKET_MATCH = Object.freeze({
  scheduled: 'Ждёт стола',
  playing: 'Играют',
  pending_confirm: 'Ждёт подтверждения',
  disputed: 'Спор у организатора',
  done: 'Сыгран',
  // После отмены идущего турнира матчи canceled, стол свободен сразу (Д2)
  canceled: 'Отменён',
});

/** Название раунда олимпийской системы по числу матчей: финал, полуфинал, 1/4… */
export function roundTitle(matchesInRound) {
  if (matchesInRound === 1) return 'Финал';
  if (matchesInRound === 2) return 'Полуфинал';
  return `1/${matchesInRound}`;
}

/** Причина отказа в записи по рейтингу (T24). */
export function ratingLimitText(data, discipline, below = false) {
  const limit = Number(data?.limit);
  const rating = Number(data?.rating);
  const d = DISCIPLINE_WORD[discipline]?.toLowerCase() ?? 'дисциплине';
  if (below) {
    if (!Number.isFinite(limit) || !Number.isFinite(rating)) return 'Ваш рейтинг ниже порога турнира — записаться нельзя.';
    return `Турнир для игроков с рейтингом от ${limit}, а ваш рейтинг в дисциплине «${d}» — ${rating}. Сыграйте партии в рейтинг или выберите другой турнир.`;
  }
  if (!Number.isFinite(limit) || !Number.isFinite(rating)) return 'Ваш рейтинг выше лимита турнира — записаться нельзя.';
  return `Турнир для игроков с рейтингом до ${limit}, а ваш рейтинг в дисциплине «${d}» — ${rating}. Так турнир остаётся честным для новичков: выберите турнир без лимита или с лимитом выше.`;
}

/** Ник как у сервера (№145): латиница, кириллица, цифры, «_» и «-», 3–20 символов, не больше 6 цифр. */
export function nickValid(nick) {
  return typeof nick === 'string' && /^[A-Za-zА-Яа-яЁё0-9_-]{3,20}$/.test(nick) && (nick.match(/\d/g) ?? []).length <= 6;
}
