// Ошибки модулей бара и кассы (backend-pos): код словаря (контракт M1 §3) и HTTP-статус.
// Наружу уходит только {"error": code}; подробности — в лог. Роутер (api/router.mjs) отдаёт
// любую ошибку с полями status и code как есть и откатывает транзакцию.
//
// Коды M2 вне словаря M1: shift_closed (касса без открытой смены, контракт M2 §1.8),
// stop_list (товар в стоп-листе или кончился), already_paid (счёт или заказ уже оплачен).
// Коды M3: guest_required (пакет часов в корзине кассы без гостя: нужен user_id или телефон),
// guest_not_found (такого гостя нет: учётку заводит только сам гость входом и согласием, №117).

export const STATUS_BY_CODE = Object.freeze({
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  reason_required: 400,
  limit_exceeded: 400,
  phone_required: 403,
  consent_required: 403,
  payment_failed: 409,
  payment_pending: 409,
  session_not_active: 409,
  idempotency_conflict: 409,
  shift_closed: 409,
  stop_list: 409,
  already_paid: 409,
  guest_required: 400,
  guest_not_found: 409,
  rate_limited: 429,
  package_used: 409,
  already_refunded: 409,
});

export class PosError extends Error {
  /**
   * @param {string} code код словаря
   * @param {string} [detail] только для лога
   * @param {number} [status] HTTP-статус, если не по словарю
   */
  constructor(code, detail, status) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'PosError';
    this.code = code;
    this.status = status ?? STATUS_BY_CODE[code] ?? 400;
  }
}

export const fail = (code, detail, status) => {
  throw new PosError(code, detail, status);
};
