// Ошибки турниров: { status, code, data? } → {"error": code, …безопасные поля} (контракт M1 §3).
// data наружу отдаёт роутер только для полей из белого списка core (server/http/errors.mjs):
// rating_above_limit несёт limit и rating (контракт m4-api.md).

const STATUS = {
  bad_request: 400,
  reason_required: 400,
  unauthorized: 401,
  forbidden: 403,
  phone_required: 403,
  not_found: 404,
  not_configured: 501,
};

export class TournamentError extends Error {
  /**
   * @param {string} code код ответа: bad_request, not_found, forbidden, full, rating_above_limit,
   *   rating_below_limit, registration_closed, already_registered, bad_status, bad_score, not_your_match,
   *   bracket_locked, too_few_entries, not_configured …
   * @param {string} [detail] подробность только для лога
   * @param {number} [status] HTTP-статус; по умолчанию 409
   * @param {object} [data] безопасные поля ответа
   */
  constructor(code, detail, status, data) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'TournamentError';
    this.code = code;
    this.status = status ?? STATUS[code] ?? 409;
    if (data) this.data = data;
  }
}

export function fail(code, detail, status, data) {
  throw new TournamentError(code, detail, status, data);
}
