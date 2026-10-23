// Ошибки API: наружу только HTTP-статус и код из словаря (контракт M1 §3), подробности — в лог.

/** Общий словарь контракта §3 и служебные коды ядра. */
export const ERROR_CODES = new Set([
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'rate_limited',
  'table_busy',
  'table_pending',
  'table_offline',
  'table_service',
  'quote_expired',
  'quote_used',
  'payment_failed',
  'payment_pending',
  'session_not_active',
  'not_payer',
  'reason_required',
  'limit_exceeded',
  'consent_required',
  'phone_required',
  'idempotency_conflict',
  // Деньги (backend-money): для стола нет тарифа на это время — 409.
  'no_tariff',
  // M2 (контракт m2.md): касса, бар, смены, ККТ.
  'shift_closed',
  'shift_open',
  'stop_list',
  'already_paid',
  'duplicate',
  'receipt_not_failed',
  'receipt_not_unknown',
  // M3: бронь, лист ожидания, касса (коды модулей booking, money, kkt).
  'booking_conflict',
  'booking_expired',
  'booking_not_active',
  'too_early',
  'table_free',
  'offer_expired',
  'fd_conflict',
  // M3 light: стол ждёт брони этого гостя — оплата через старт брони (с booking_id).
  'booking_start_required',
  // M4 (m4-api.md): рейтинг выше лимита турнира (с limit и rating), ник занят, отзыв недоступен.
  'rating_above_limit',
  'nick_taken',
  'review_not_allowed',
  // M4 directory: клуб бронирует онлайн (заявка не нужна), карточка уже подтверждена,
  // заявка уже решена или закрыта (409; duplicate — выше).
  'online_booking',
  'already_claimed',
  'already_decided',
  'request_closed',
  // M4 plus (409): нет профиля игрока, партия в турнирной сессии, партия не ждёт подтверждения
  // или не в споре, приглашение не ждёт ответа.
  'no_profile',
  'tournament_session',
  'match_not_pending',
  'match_not_disputed',
  'invite_not_pending',
  // Служебные: метод не тот (M0 /health), канал не настроен (MAX до документации),
  // внутренняя ошибка сервера.
  'method_not_allowed',
  'not_configured',
  'internal',
]);

const CODE = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * Поля, которые ошибка может отдать рядом с { error } (err.data): только идентификаторы,
 * время и счётчики — без персональных данных. Прочие поля и значения не того вида
 * отбрасываются.
 */
export const SAFE_ERROR_FIELDS = new Set([
  'booking_id',
  'session_id',
  'resource_id',
  'offer_id',
  'payment_id',
  'busy_until',
  'limit_until',
  'extend_limit_until',
  'available_from',
  'retry_after_sec',
  'minutes_left',
  // M4: 409 rating_above_limit — лимит турнира и рейтинг игрока (целые).
  'limit',
  'rating',
]);
const SAFE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Безопасные поля ошибки по белому списку (значение: UUID, время ISO, целое, логическое, null). */
export function safeErrorData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (!SAFE_ERROR_FIELDS.has(k) || k === 'error') continue;
    if (v === null || typeof v === 'boolean' || Number.isSafeInteger(v)) out[k] = v;
    else if (v instanceof Date && !Number.isNaN(v.getTime())) out[k] = v.toISOString();
    else if (typeof v === 'string' && (SAFE_ID.test(v) || SAFE_TIME.test(v))) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Ошибка для ответа клиенту. Бросается из обработчика маршрута: транзакция откатывается,
 * клиент получает { error: code } со статусом status.
 */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code код из словаря
   * @param {{ cause?: unknown, detail?: string, headers?: Record<string, string>, data?: object }} [options]
   *   data — поля ответа рядом с error (только SAFE_ERROR_FIELDS)
   */
  constructor(status, code, { cause, detail, headers, data } = {}) {
    super(detail ? `${code}: ${detail}` : code, cause === undefined ? undefined : { cause });
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers;
    if (data) this.data = data;
  }
}

export const badRequest = (detail) => new HttpError(400, 'bad_request', { detail });
export const unauthorized = (detail) => new HttpError(401, 'unauthorized', { detail });
export const forbidden = (detail) => new HttpError(403, 'forbidden', { detail });
export const notFound = (detail) => new HttpError(404, 'not_found', { detail });

/**
 * Ошибка любого вида → { status, code, data? }. Ошибки с полями status и code (HttpError
 * и ошибки модулей в том же виде) отдаются как есть, если код из словаря
 * или похож на код; err.data — только безопасные поля (safeErrorData); всё остальное —
 * 500 internal без данных.
 */
export function toHttpError(err) {
  if (err && Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 && typeof err.code === 'string' && CODE.test(err.code)) {
    const data = err.status < 500 ? safeErrorData(err.data) : null;
    return { status: err.status, code: err.code, headers: err.headers, ...(data ? { data } : {}) };
  }
  return { status: 500, code: 'internal' };
}
