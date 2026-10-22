// Ошибки модуля light: код из общего словаря контракта M1 §3 и HTTP-статус.
// Наружу уходит только {"error": code}; подробности — в лог.

export const STATUS_BY_CODE = Object.freeze({
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_payer: 403,
  not_found: 404,
  rate_limited: 429,
  table_busy: 409,
  table_pending: 409,
  table_offline: 409,
  table_service: 409,
  session_not_active: 409,
  reason_required: 400,
  limit_exceeded: 400,
  booking_conflict: 409,
  booking_start_required: 409,
});

export class LightError extends Error {
  /** @param {string} code код из словаря §3 @param {string} [detail] только для лога */
  /** @param {object} [data] поля ответа рядом с error (например, booking_id) */
  constructor(code, detail, data = null) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'LightError';
    this.code = code;
    this.status = STATUS_BY_CODE[code] ?? 400;
    if (data) this.data = data;
  }
}

export const fail = (code, detail) => {
  throw new LightError(code, detail);
};

/** Ответ маршрута по ошибке модуля; прочие ошибки пробрасываются (500 у роутера). */
export function errorResponse(err) {
  if (err instanceof LightError) return { status: err.status, json: { error: err.code, ...(err.data ?? {}) } };
  throw err;
}
