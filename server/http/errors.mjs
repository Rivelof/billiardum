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
  // M4 directory: для действия нужен город (409).
  'city_required',
  // M4 plus (409): нет профиля игрока, партия в турнирной сессии, партия не ждёт подтверждения
  // или не в споре, приглашение не ждёт ответа.
  'no_profile',
  'tournament_session',
  'match_not_pending',
  'match_not_disputed',
  'invite_not_pending',
  // M4-3 (турниры, plus): счёт соперника изменился после того, как игрок его увидел (409).
  'score_changed',
  // №147: турнир уже начался — окно и время матча меняются только через POST …/extend (409).
  'tournament_started',
  // №149: возврат взноса после старта — взнос не оплачен или уже возвращается (409).
  'not_paid',
  'already_refunded',
  // M5.1 backend-B (m5-1.md §4): тарифы не покрывают неделю или пересекаются (400, с {weekday, from, to, kind}),
  // файл .xlsx не разобран (400), QR с корпуса контроллера не BLD1 (400).
  'tariff_gap',
  'tariff_overlap',
  'xlsx_invalid',
  'qr_invalid',
  // M5.1 backend-A (m5-1.md §4): четвёртый тестовый клуб (409), чек-лист запуска не выполнен
  // (409 {failed: [...]}), клуб приостановлен платформой (409), магазин ЮKassa не принят при
  // проверке GET /v3/me: неверная пара (400), режим не тот (400), у боевого нет фискализации (400);
  // ЮKassa не ответила на проверку магазина (503).
  'clubs_limit',
  'checklist_incomplete',
  'club_suspended',
  'shop_invalid',
  'shop_mode_mismatch',
  'fiscalization_off',
  'yookassa_unavailable',
  // M5.3 backend-billing (m5-3.md §3): у клуба нет сохранённой карты (409), счёт подписки уже
  // оплачен (409), магазин ЮKassa платформы не настроен или клуб ещё в test (503 / 409).
  'card_required',
  'invoice_paid',
  'billing_unavailable',
  // M5.7 (m5-5-8.md №199–201): у ключа API нет права маршрута (403), уже 5 активных ключей (409),
  // уже 10 включённых вебхуков (409), адрес вебхука не https:443 или не разобран (400), ведёт во
  // внутреннюю сеть или локальное имя (400), тестовое событие на выключенный адрес (409).
  'scope_required',
  'api_keys_limit',
  'webhooks_limit',
  'url_invalid',
  'url_forbidden',
  'webhook_disabled',
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
  // Причина занятости и т. п. — только код из SAFE_REASONS (409 table_busy {reason:'tournament', busy_until}).
  'reason',
  // Статус заявки в клуб, на которую уже ответили — только из SAFE_STATUSES (409 request_closed {status}).
  'status',
  // M5.1 (400 tariff_gap / tariff_overlap): день недели ISO 1–7, местное время 'HH:MM', тип стола из SAFE_KINDS.
  'weekday',
  'from',
  'to',
  'kind',
  // M5.1 (409 checklist_incomplete): невыполненные пункты чек-листа запуска — только из SAFE_CHECKLIST.
  'failed',
]);
/** Допустимые значения reason в ошибке: закрытый список кодов, не свободный текст. */
export const SAFE_REASONS = new Set(['tournament', 'booking', 'service', 'pending', 'offline', 'busy', 'reserved', 'waitlist', 'session', 'maintenance', 'closed']);
/** Допустимые значения status в ошибке: статус закрытой заявки гостя в клуб (T25). */
export const SAFE_STATUSES = new Set(['accepted', 'declined', 'operator', 'closed']);
/** Допустимые значения kind в ошибке: тип стола (M5.1, tariff_gap). */
export const SAFE_KINDS = new Set(['pyramid', 'pool', 'snooker', 'mixed', 'padel_court']);
/** Пункты чек-листа запуска (№160) в поле failed ошибки checklist_incomplete. */
export const SAFE_CHECKLIST = new Set(['tables', 'devices', 'tariffs', 'shop_live', 'kkt', 'stickers', 'offer']);
/** Местное время 'HH:MM' (00:00–24:00) в полях from и to ошибки тарифа. */
const SAFE_HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const REASON_CODE = /^[a-z_]{1,32}$/;
const SAFE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Безопасные поля ошибки по белому списку (значение: UUID, время ISO, целое, логическое, null). */
export function safeErrorData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (!SAFE_ERROR_FIELDS.has(k) || k === 'error') continue;
    if (k === 'reason') {
      if (typeof v === 'string' && REASON_CODE.test(v) && SAFE_REASONS.has(v)) out[k] = v;
      continue;
    }
    if (k === 'status') {
      if (typeof v === 'string' && SAFE_STATUSES.has(v)) out[k] = v;
      continue;
    }
    if (k === 'kind') {
      if (typeof v === 'string' && SAFE_KINDS.has(v)) out[k] = v;
      continue;
    }
    if (k === 'failed') {
      if (Array.isArray(v) && v.length <= SAFE_CHECKLIST.size && v.every((x) => typeof x === 'string' && SAFE_CHECKLIST.has(x))) out[k] = [...new Set(v)];
      continue;
    }
    if ((k === 'from' || k === 'to') && typeof v === 'string' && SAFE_HHMM.test(v)) {
      out[k] = v;
      continue;
    }
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
