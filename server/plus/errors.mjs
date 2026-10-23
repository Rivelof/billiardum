// Ошибки модуля Бильярдум+: { status, code } → {"error": code} (контракт M1 §3, m4-api.md).

const STATUS = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  reason_required: 400,
  limit_exceeded: 429,
  not_configured: 501,
};

export class PlusError extends Error {
  /**
   * @param {string} code код ответа: словарь §3 и коды M4 (nick_taken, not_same_session, …)
   * @param {string} [detail] подробность только для лога
   * @param {number} [status] HTTP-статус; по умолчанию 409
   */
  constructor(code, detail, status) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'PlusError';
    this.code = code;
    this.status = status ?? STATUS[code] ?? 409;
  }
}

export function fail(code, detail, status) {
  throw new PlusError(code, detail, status);
}

/** Ошибка соседа (booking, light) с кодом и статусом 4xx. */
export function isClientError(err) {
  return Boolean(err) && Number.isInteger(err.status) && err.status >= 400 && err.status < 500 && typeof err.code === 'string';
}
