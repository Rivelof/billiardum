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
  // Служебные: метод не тот (M0 /health), канал не настроен (MAX до документации),
  // внутренняя ошибка сервера.
  'method_not_allowed',
  'not_configured',
  'internal',
]);

const CODE = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * Ошибка для ответа клиенту. Бросается из обработчика маршрута: транзакция откатывается,
 * клиент получает { error: code } со статусом status.
 */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code код из словаря
   * @param {{ cause?: unknown, detail?: string, headers?: Record<string, string> }} [options]
   */
  constructor(status, code, { cause, detail, headers } = {}) {
    super(detail ? `${code}: ${detail}` : code, cause === undefined ? undefined : { cause });
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export const badRequest = (detail) => new HttpError(400, 'bad_request', { detail });
export const unauthorized = (detail) => new HttpError(401, 'unauthorized', { detail });
export const forbidden = (detail) => new HttpError(403, 'forbidden', { detail });
export const notFound = (detail) => new HttpError(404, 'not_found', { detail });

/**
 * Ошибка любого вида → { status, code }. Ошибки с полями status и code (HttpError
 * и ошибки модулей в том же виде) отдаются как есть, если код из словаря
 * или похож на код; всё остальное — 500 internal.
 */
export function toHttpError(err) {
  if (err && Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 && typeof err.code === 'string' && CODE.test(err.code)) {
    return { status: err.status, code: err.code, headers: err.headers };
  }
  return { status: 500, code: 'internal' };
}
