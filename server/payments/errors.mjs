// Ошибки денежного модуля: код из общего словаря контракта M1 §3 и HTTP-статус.
// Наружу уходит только {"error": code}; подробности — в лог.
// no_tariff — дополнение к словарю (на это время у клуба нет тарифа), см. README.

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
  quote_expired: 409,
  quote_used: 409,
  payment_failed: 409,
  payment_pending: 409,
  session_not_active: 409,
  consent_required: 403,
  phone_required: 403,
  idempotency_conflict: 409,
  limit_exceeded: 400,
  reason_required: 400,
  no_tariff: 409,
});

export class MoneyError extends Error {
  /**
   * @param {string} code код словаря §3
   * @param {string} [detail] только для лога
   * @param {number} [status] HTTP-статус, если не по словарю (ЮKassa недоступна — 503)
   */
  constructor(code, detail, status) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'MoneyError';
    this.code = code;
    this.status = status ?? STATUS_BY_CODE[code] ?? 400;
  }
}

export const fail = (code, detail, status) => {
  throw new MoneyError(code, detail, status);
};

const LIGHT_CODES = new Set(['table_busy', 'table_pending', 'table_offline', 'table_service', 'session_not_active', 'not_found', 'forbidden', 'not_payer', 'limit_exceeded']);

/**
 * Ошибка соседнего модуля (light: LightError с кодом словаря) → MoneyError того же кода.
 * Прочие ошибки пробрасываются как есть (500 у роутера).
 */
export function fromNeighbor(err) {
  const code = err?.code ?? err?.error;
  if (typeof code === 'string' && LIGHT_CODES.has(code)) return new MoneyError(code, err.message);
  return err;
}

/** Результат соседа вида { error: 'table_busy' } или true/ok. */
export function checkNeighborResult(result) {
  if (result && typeof result === 'object' && typeof result.error === 'string') {
    throw fromNeighbor({ code: result.error, message: result.error });
  }
  if (result === false) throw new MoneyError('table_busy', 'holdPending вернул false');
  return result;
}
