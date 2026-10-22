import { formatTime } from '@billiardum/shared/format';
import { durationWords } from './words.js';

/** За 5 минут до конца таймер янтарный (DESIGN §4, PRODUCT §7). */
export const WARN_MS = 5 * 60 * 1000;
/** Льгота после конца оплаченного времени, если сервер ещё не прислал grace_until (PRODUCT §3, п. 7). */
export const GRACE_MS = 2 * 60 * 1000;

/**
 * Разница часов сервера и устройства: на телефоне часы бывают сбиты на минуты, а таймер должен совпадать со столом.
 * Сервер присылает remaining_ms на момент ответа, поэтому «сейчас на сервере» = paid_until − remaining_ms.
 * @param {{ status?: string, paid_until?: string, remaining_ms?: number } | null} session
 * @param {number} receivedAt Date.now() в момент получения ответа
 * @returns {number} мс, которые нужно прибавить к Date.now()
 */
export function clockSkew(session, receivedAt) {
  if (!session || typeof session.remaining_ms !== 'number' || !session.paid_until) return 0;
  if (!['active', 'ending'].includes(session.status)) return 0;
  const paidUntil = Date.parse(session.paid_until);
  if (Number.isNaN(paidUntil)) return 0;
  const skew = paidUntil - session.remaining_ms - receivedAt;
  // Больше суток — явно не сбитые часы, а ошибка данных
  return Math.abs(skew) > 86_400_000 ? 0 : skew;
}

/**
 * Состояние экрана «Игра» по сессии и текущему времени (уже с поправкой clockSkew).
 *
 * phase:
 *  - 'play'        — идёт игра, больше 5 минут;
 *  - 'warn'        — меньше 5 минут (или сервер сказал ending): таймер янтарный;
 *  - 'grace'       — оплаченное время вышло, идёт льгота: таймер красный, счёт до grace_until;
 *  - 'over'        — льгота кончилась, ждём закрытия от сервера;
 *  - 'unlimited'   — «Без лимита»: считаем вверх от started_at. Оплачено до paid_until (заморозка по карте
 *                    или блок СБП, extend_limit_until): за 5 минут до него — 'warn', после — 'grace', как у обычной игры;
 *  - 'interrupted' — свет погас без связи, а оплачено больше (выбор «Продолжить» или «Вернуть деньги»);
 *  - 'closed', 'cancelled'.
 *
 * @param {object} session объект session из API (контракт §6)
 * @param {number} now мс
 * @returns {{ phase: string, ms: number, until: number | null }}
 */
export function gameView(session, now) {
  const status = session?.status;
  if (status === 'interrupted') return { phase: 'interrupted', ms: Math.max(0, session.remaining_ms ?? 0), until: null };
  if (status === 'closed') return { phase: 'closed', ms: 0, until: null };
  if (status === 'cancelled') return { phase: 'cancelled', ms: 0, until: null };

  const paidUntil = Date.parse(session?.paid_until);
  if (session?.unlimited) {
    const started = Date.parse(session.started_at);
    const elapsed = Number.isNaN(started) ? 0 : Math.max(0, now - started);
    const nearLimit = !Number.isNaN(paidUntil) && (status === 'grace' || status === 'ending' || paidUntil - now <= WARN_MS);
    if (!nearLimit) return { phase: 'unlimited', ms: elapsed, until: Number.isNaN(paidUntil) ? null : paidUntil };
  }

  if (Number.isNaN(paidUntil)) return { phase: 'play', ms: 0, until: null };
  const graceUntil = session.grace_until ? Date.parse(session.grace_until) : paidUntil + GRACE_MS;

  if (status === 'grace' || now >= paidUntil) {
    if (now >= graceUntil) return { phase: 'over', ms: 0, until: graceUntil };
    return { phase: 'grace', ms: graceUntil - now, until: graceUntil };
  }
  const left = paidUntil - now;
  if (left <= WARN_MS || status === 'ending') return { phase: 'warn', ms: left, until: paidUntil };
  return { phase: 'play', ms: left, until: paidUntil };
}

/**
 * Подписи таймера словами. Статус не передаётся только цветом: у каждого состояния своя подпись.
 * @param {{ phase: string, ms: number, until: number | null }} view
 * @param {{ timeZone: string, startedAt?: string, unlimited?: boolean }} ctx
 * @returns {{ label: string, note: string, aria: string }}
 */
export function timerTexts(view, ctx) {
  const t = (ms) => formatTime(ms, ctx.timeZone);
  switch (view.phase) {
    case 'play':
      return { label: 'Осталось', note: view.until ? `Игра до ${t(view.until)}` : '', aria: `Осталось ${durationWords(view.ms)}` };
    case 'warn':
      return {
        label: 'Меньше 5 минут',
        note: ctx.unlimited ? 'Оплаченный блок кончается: продлите, чтобы игра не прервалась' : 'Продлите, чтобы игра не прервалась',
        aria: `Меньше 5 минут: осталось ${durationWords(view.ms)}`,
      };
    case 'grace':
      return {
        label: 'Время вышло, льгота',
        note: view.until ? `Продлите до ${t(view.until)}, иначе свет погаснет` : 'Продлите, иначе свет погаснет',
        aria: `Время вышло. Льгота: ${durationWords(view.ms)}`,
      };
    case 'over':
      return { label: 'Игра завершена', note: 'Свет гаснет. Чек будет готов через минуту', aria: 'Игра завершена' };
    case 'unlimited':
      return {
        label: 'Без лимита, играете',
        note: [ctx.startedAt ? `С ${t(ctx.startedAt)}` : '', view.until ? `оплачено до ${t(view.until)}` : 'оплата по фактическим минутам']
          .filter(Boolean)
          .join(', '),
        aria: `Без лимита, играете ${durationWords(view.ms)}`,
      };
    default:
      return { label: '', note: '', aria: '' };
  }
}

/**
 * Можно ли продлить на столько минут: перед бронью продление ограничено (extend_limit_until, ROADMAP T19).
 * @returns {number | null} максимум минут или null, если ограничения нет
 */
export function maxExtendMinutes(session) {
  // У «Без лимита» extend_limit_until — предел оплаченной заморозки или блока СБП (backend-light), не бронь
  if (session?.unlimited || !session?.extend_limit_until || !session.paid_until) return null;
  const limit = Date.parse(session.extend_limit_until);
  const from = Date.parse(session.paid_until);
  if (Number.isNaN(limit) || Number.isNaN(from)) return null;
  return Math.max(0, Math.floor((limit - from) / 60000));
}

/** Свет над столом на экране: горит в игре, приглушён в льготу (как лампа на столе), выключен в остальном. */
export function lampState(phase) {
  if (phase === 'play' || phase === 'warn' || phase === 'unlimited') return 'true';
  if (phase === 'grace') return 'dim';
  return 'false';
}

/** За 10 минут до конца лампа мягко пульсирует (DESIGN §6); в «Без лимита» — нет. */
export function pulseLamp(view, session) {
  if (!view || session?.unlimited) return false;
  return (view.phase === 'play' || view.phase === 'warn') && view.ms <= 10 * 60 * 1000;
}

/**
 * Доля оставшегося оплаченного времени для кольца на столе (0…1): от начала игры до paid_until.
 * В «Без лимита» и вне игры кольца нет — null.
 */
export function timeLeftShare(view, session) {
  if (!view || session?.unlimited || !['play', 'warn'].includes(view.phase)) return null;
  const start = Date.parse(session?.started_at ?? '');
  const end = Date.parse(session?.paid_until ?? '');
  if (!(end > start)) return null;
  return Math.min(1, Math.max(0, view.ms / (end - start)));
}
