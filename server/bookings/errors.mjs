// Ошибки модулей брони и листа ожидания: { status, code } → {"error": code} (контракт M1 §3).

const STATUS = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  reason_required: 400,
  not_configured: 501,
};

export class BookingError extends Error {
  /**
   * @param {string} code код ответа (словарь §3 и коды M3: booking_conflict, booking_expired, …)
   * @param {string} [detail] подробность только для лога
   * @param {number} [status] HTTP-статус; по умолчанию 409 для конфликтов
   * @param {object} [data] безопасные поля ответа (роутер core фильтрует по белому списку):
   *   стол турнира — { reason: 'tournament', busy_until }
   */
  constructor(code, detail, status, data) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'BookingError';
    this.code = code;
    this.status = status ?? STATUS[code] ?? 409;
    if (data) this.data = data;
  }
}

export function fail(code, detail, status, data) {
  throw new BookingError(code, detail, status, data);
}

/** Ошибка соседа (light, money, tariffs) с кодом и статусом — как есть; no_tariff тарифов — 409. */
export function isConflict(err) {
  return Boolean(err) && Number.isInteger(err.status) && err.status >= 400 && err.status < 500 && typeof err.code === 'string';
}
