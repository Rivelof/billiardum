// Ошибки денежного модуля: код из общего словаря контракта M1 §3 и HTTP-статус.
// Наружу уходит только {"error": code}; подробности — в лог.
// no_tariff — дополнение к словарю (на это время у клуба нет тарифа), см. README;
// shift_closed — нет открытой смены (M2, decisions №83, №93); booking_conflict — продление
// упирается в бронь (M3, №106).

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
  shift_closed: 409,
  booking_conflict: 409,
  already_paid: 409,
  package_used: 409,
  already_refunded: 409,
  // Стол ждёт брони этого же гостя (light, M3): ответ 409 {error, booking_id}.
  booking_start_required: 409,
});

/**
 * Поля err.data, которые можно отдать клиенту рядом с кодом (без персональных данных).
 * Форма для роутера (core): ошибка с полем data — объект только из этих полей;
 * ответ { error: code, ...data }.
 */
export const PUBLIC_DATA_FIELDS = Object.freeze(['booking_id', 'reason', 'busy_until']);

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Только разрешённые поля: booking_id — UUID или короткий код; reason — код причины занятости
 * стола (light: 'tournament' и т. п.); busy_until — время ISO (M4-I1: 409 table_busy
 * {reason: 'tournament', busy_until} на столе турнира). Роутер core ещё раз фильтрует по своему списку.
 */
export function publicData(data) {
  if (!data || typeof data !== 'object') return undefined;
  const out = {};
  for (const k of PUBLIC_DATA_FIELDS) {
    const v = data[k];
    if (v === undefined) continue;
    if (k === 'reason') {
      if (typeof v === 'string' && /^[a-z_]{1,32}$/.test(v)) out[k] = v;
    } else if (k === 'busy_until') {
      if (v === null || (typeof v === 'string' && ISO_TIME.test(v))) out[k] = v;
    } else if (v === null || (typeof v === 'string' && /^[0-9a-z_-]{1,64}$/i.test(v)) || Number.isSafeInteger(v)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export class MoneyError extends Error {
  /**
   * @param {string} code код словаря §3
   * @param {string} [detail] только для лога
   * @param {number} [status] HTTP-статус, если не по словарю (ЮKassa недоступна — 503)
   * @param {object} [data] безопасные поля для клиента (PUBLIC_DATA_FIELDS), например booking_id
   */
  constructor(code, detail, status, data) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'MoneyError';
    this.code = code;
    const pub = publicData(data);
    if (pub) this.data = pub;
    this.status = status ?? STATUS_BY_CODE[code] ?? 400;
  }
}

export const fail = (code, detail, status) => {
  throw new MoneyError(code, detail, status);
};

const LIGHT_CODES = new Set(['booking_start_required', 'bad_request', 'shift_closed', 'table_busy', 'table_pending', 'table_offline', 'table_service', 'session_not_active', 'not_found', 'forbidden', 'not_payer', 'limit_exceeded']);

/**
 * Ошибка соседнего модуля (light: LightError с кодом словаря) → MoneyError того же кода.
 * Прочие ошибки пробрасываются как есть (500 у роутера).
 */
export function fromNeighbor(err) {
  const code = err?.code ?? err?.error;
  if (typeof code === 'string' && LIGHT_CODES.has(code)) return new MoneyError(code, err.message, undefined, err.data);
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
