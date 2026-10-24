import { formatDateShort, plural } from '@billiardum/shared/format';
import { api } from './api.js';
import { createStore } from './store.js';

/**
 * Плашка подписки в программе клуба (M5.3, №184, №188) — по полю `banner` ответа GET /api/clubs/{club}/subscription.
 * Этот модуль входит в первую загрузку программы (каркас Shell), поэтому маленький: тексты плашки, «скрыть до завтра»
 * и кэш ответа. Экран «Подписка» и экран платформы — в своих чанках (lib/billing.js).
 *
 * Подписка не трогает свет и игры ни в каком состоянии (№184, инвариант 3) — тексты не пугают отключением.
 */

const DAY_FORMS = ['день', 'дня', 'дней'];

/** «5 дней», «1 день», «22 дня». */
export function dayWord(n) {
  const v = Math.max(0, Math.trunc(Number(n) || 0));
  return `${v} ${plural(v, DAY_FORMS)}`;
}

/** Причина неудачного списания словами (cancellation_details.reason ЮKassa или код планировщика). */
const FAILURE = {
  insufficient_funds: 'на карте не хватило денег',
  card_expired: 'срок действия карты истёк',
  permission_revoked: 'банк отозвал разрешение на автоплатёж',
  card_required: 'карта не привязана',
  yookassa_unavailable: 'ЮKassa не ответила, попробуем снова',
  '3d_secure_failed': 'банк не подтвердил списание',
  fraud_suspected: 'банк заподозрил мошенничество и отклонил списание',
};

/** @param {string | null | undefined} code @returns {string | null} */
export function failureText(code) {
  if (!code) return null;
  return FAILURE[code] ?? 'банк отклонил списание';
}

/** Дата списания «24.10» по поясу клуба; нет даты или она кривая — null. */
function chargeDay(banner, timeZone) {
  const at = banner.next_attempt_at ?? banner.until;
  if (!at || Number.isNaN(new Date(at).getTime())) return null;
  return formatDateShort(at, timeZone || 'Europe/Moscow');
}

/**
 * Вид плашки: { kind, strong, text, short, link } или null.
 * strong — при неуспешной оплате (заметнее); short — для кассы и ресепшена (компактная строка);
 * link — подпись ссылки владельца на экран «Подписка» (полная и короткая).
 *
 * Виды (server/billing/period.mjs bannerFor):
 *   trial_ending, period_ending — до конца периода ≤ 7 дней, автоплатёж не настроен;
 *   invoice_due — счёт выставлен, списание ещё не пробовали или оно идёт (до первой неудачи): дата — next_attempt_at,
 *     иначе until, по поясу клуба;
 *   payment_failed — только после реального отказа списания (или карты нет).
 * @param {{ kind: string, days_left?: number, days_overdue?: number, until?: string, next_attempt_at?: string, last_error?: string | null } | null} banner
 * @param {string} [timeZone] пояс клуба (IANA) — для даты списания
 */
export function bannerView(banner, timeZone) {
  if (!banner || typeof banner !== 'object') return null;
  const pay = { full: 'Перейти к оплате', short: 'Оплатить' };
  if (banner.kind === 'invoice_due') {
    const day = chargeDay(banner, timeZone);
    const text = day ? `Счёт за подписку будет списан ${day}.` : 'Счёт за подписку скоро будет списан с карты.';
    return { kind: banner.kind, strong: false, text, short: day ? `Подписка: списание ${day}` : 'Подписка: скоро списание', link: { full: 'Открыть подписку', short: 'Подписка' } };
  }
  if (banner.kind === 'trial_ending' || banner.kind === 'period_ending') {
    const left = Math.max(0, Math.trunc(Number(banner.days_left) || 0));
    const when = left > 0 ? `через ${dayWord(left)}` : 'сегодня';
    const text = banner.kind === 'trial_ending' ? `Пробный период заканчивается ${when}.` : `Оплаченный период истекает ${when}.`;
    const short = left > 0 ? `Подписка: осталось ${dayWord(left)}` : 'Подписка: последний день';
    return { kind: banner.kind, strong: false, text, short, link: pay };
  }
  if (banner.kind === 'payment_failed') {
    const why = failureText(banner.last_error);
    const over = Math.max(0, Math.trunc(Number(banner.days_overdue) || 0));
    let text = why ? `Оплата подписки не прошла: ${why}.` : 'Счёт за подписку ещё не оплачен.';
    if (over > 0) text += ` Просрочка — ${dayWord(over)}.`;
    return { kind: banner.kind, strong: true, text, short: 'Подписка не оплачена', link: pay };
  }
  return null;
}

/** Местная дата клуба 'YYYY-MM-DD' — «скрыть до завтра» считается по суткам клуба. */
export function localDay(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** sessionStorage: клуб, с которого владелец ушёл на страницу ЮKassa, — по возврату на /club/subscription он попадёт в него. */
export const SUB_RETURN_KEY = 'bl-sub-return';

/** Ключ localStorage: крестик скрывает плашку этого клуба до завтра (удобство одного браузера). */
export const bannerHideKey = (clubId) => `bl-sub-banner:${clubId}`;

/** Значение для хранения: сутки клуба и вид плашки. */
export const bannerHideValue = (banner, today) => `${today}|${banner?.kind ?? ''}`;

/**
 * Скрыта ли плашка: тот же день клуба и тот же вид. Новый день или плашка стала заметнее
 * (срок → неуспешная оплата) — показываем снова.
 */
export function bannerHidden(saved, banner, today) {
  if (!saved || !banner) return false;
  const [day, kind] = String(saved).split('|');
  return day === today && kind === banner.kind;
}

// ---------- кэш ответа подписки: плашка на каждом экране не шлёт запрос заново ----------

const TTL = 5 * 60_000;

/** clubId → { at, data, error }. data — ответ GET …/subscription; error — код (billing_unavailable, forbidden …). */
export const subscriptions = createStore({});
const inflight = new Map();

export function putSubscription(clubId, data) {
  subscriptions.set({ [clubId]: { at: Date.now(), data, error: null } });
}

/**
 * Загрузить подписку клуба (не чаще раза в 5 минут, если не force). Ошибку не бросает: плашка без данных
 * просто не показывается (503 billing_unavailable — подписка не подключена, это не ошибка).
 */
export function loadSubscription(clubId, { force = false } = {}) {
  const have = subscriptions.get()[clubId];
  if (!force && have && Date.now() - have.at < TTL) return Promise.resolve(have.data);
  if (inflight.has(clubId)) return inflight.get(clubId);
  const p = api
    .subscription(clubId)
    .then((data) => {
      putSubscription(clubId, data);
      return data;
    })
    .catch((err) => {
      subscriptions.set({ [clubId]: { at: Date.now(), data: null, error: err?.code ?? 'unknown' } });
      return null;
    })
    .finally(() => inflight.delete(clubId));
  inflight.set(clubId, p);
  return p;
}
