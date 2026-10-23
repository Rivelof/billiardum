import { createClient, newIdempotencyKey, openStream } from '@billiardum/shared/api';
import { local } from './store.js';

/**
 * Вызовы API программы клуба по контракту M1 (§4–§7, §14).
 * Вход — cookie bl_session (Path=/api), её сервер ставит на всех входах, включая смену по PIN.
 * Клуб для маршрутов без {club} в пути — заголовок X-Club-Id (программа шлёт его всегда, §14).
 * Терминал ресепшена хранит terminal_token в localStorage и шлёт его как Authorization: Bearer
 * только в маршруты терминала (GET /api/staff/terminal, POST /api/staff/pin).
 */

export const TERMINAL_KEY = 'bl-terminal';

let clubId = null;
let doFetch;
let EventSourceImpl = globalThis.EventSource;

const clubHeader = (h) => {
  if (clubId) h['X-Club-Id'] = clubId;
};
let client = createClient({ headers: clubHeader });

export function configureApi({ fetch, EventSource } = {}) {
  doFetch = fetch;
  client = createClient({ fetch, headers: clubHeader });
  if (EventSource) EventSourceImpl = EventSource;
}

/** Текущий клуб экрана: уходит в X-Club-Id. */
export function setClub(id) {
  clubId = id || null;
}

/** Зарегистрированный терминал: { token, name, club_id } или null. */
export function getTerminal() {
  try {
    const raw = local.get(TERMINAL_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setTerminal(value) {
  local.set(TERMINAL_KEY, value ? JSON.stringify(value) : null);
}

const terminalClient = () => createClient({ fetch: doFetch, token: () => getTerminal()?.token ?? null });

const e = encodeURIComponent;
const acceptKeys = new Map();

export const api = {
  me: () => client.get('/me'),
  /** Персонал задаёт себе имя: PATCH /api/me {name} (§14). */
  updateMe: (body) => client.request('PATCH', '/me', { body }),
  devLogin: (phone) => client.post('/auth/dev', { phone }),
  /** Способы входа, настроенные на сервере (U1): { methods: ['telegram', 'max', 'dev'] }. */
  authMethods: () => client.get('/auth/methods'),
  botLink: (channel) => client.post('/auth/bot-link', { channel }),
  botLinkStatus: (nonce) => client.get(`/auth/bot-link/${e(nonce)}`),
  logout: () => client.post('/auth/logout'),

  registerTerminal: (club, name) => client.post('/staff/terminal', { club_id: club, name }),
  /** Терминал и персонал для выбора перед PIN: { terminal, staff: [{ user_id, role, phone_masked, pin_set }] } */
  terminalInfo: () => terminalClient().get('/staff/terminal'),
  pin: (userId, pin) => terminalClient().post('/staff/pin', { user_id: userId, pin }),
  /** Сотрудник задаёт себе PIN для терминала (PUT /api/staff/pin, §14). */
  setPin: (club, pin) => client.request('PUT', '/staff/pin', { body: { club_id: club, pin } }),

  hall: (club) => client.get(`/clubs/${e(club)}/hall`),
  requests: (club) => client.get(`/clubs/${e(club)}/reception/requests`),
  /** @param {{ method: 'cash' | 'card_terminal', received_kopecks?: number }} body */
  accept(id, body) {
    const k = `${id}:${body.method}:${body.received_kopecks ?? ''}`;
    if (!acceptKeys.has(k)) acceptKeys.set(k, newIdempotencyKey());
    return client.post(`/reception/requests/${e(id)}/accept`, body, { idempotencyKey: acceptKeys.get(k) });
  },
  decline: (id, reasonCode) => client.post(`/reception/requests/${e(id)}/decline`, { reason_code: reasonCode }),

  serviceStart: (resourceId, body) => client.post(`/resources/${e(resourceId)}/service`, body),
  serviceStop: (resourceId) => client.post(`/resources/${e(resourceId)}/service/stop`),
  extendFree: (sessionId, body) => client.post(`/sessions/${e(sessionId)}/extend-free`, body),

  /** Контроллеры: окно привязки 30 минут по коду с наклейки (№67), «Подсветить стол». */
  bindDevice: (club, body) => client.post(`/clubs/${e(club)}/devices/bind`, body),
  identify: (resourceId, seconds = 30) => client.post(`/resources/${e(resourceId)}/identify`, { seconds }),

  now: (club) => client.get(`/clubs/${e(club)}/now`),
  audit: (club, query) => client.get(`/clubs/${e(club)}/audit`, { query }),
  verify: (club) => client.get(`/clubs/${e(club)}/audit/verify`),
  alarms: (club) => client.get(`/clubs/${e(club)}/alarms`, { query: { state: 'open' } }),
  ack: (id) => client.post(`/alarms/${e(id)}/ack`),
  /** PDF наклеек: Response, чтобы забрать Blob. M5.1: resources — только выбранные столы (id через запятую). */
  qrStickers: (club, resourceIds) =>
    client.request('GET', `/clubs/${e(club)}/qr-stickers.pdf`, { raw: true, query: resourceIds?.length ? { resources: resourceIds.join(',') } : undefined }),

  // ---------- M2: касса POS (docs/contracts/m2.md §4) ----------
  /** Меню персонала: с алкоголем, стоп-листом, остатками; settings.discount_limit_percent — лимит скидки (№82). */
  menu: (club) => client.get(`/clubs/${e(club)}/menu`),
  /** Открытые счета столов (№79): [{ session_id, resource_number, orders_count, total_kopecks, session_status }]. */
  tabs: (club) => client.get(`/clubs/${e(club)}/tabs`),
  /** Продажа: ключ идемпотентности живёт одну попытку оплаты чека — повтор после обрыва не пробьёт второй чек. */
  sale: (body, idempotencyKey) => client.post('/pos/sales', body, { idempotencyKey }),
  saleStatus: (id) => client.get(`/pos/sales/${e(id)}`),
  /** Снять QR неоплаченной СБП-продажи (№98): { reason? }; уже оплачено — 409 already_paid. */
  cancelSale: (id, reason) => client.post(`/pos/sales/${e(id)}/cancel`, reason ? { reason } : {}),
  /** Кто может подтвердить скидку выше лимита: [{ user_id, name, role }] — управляющие и владелец клуба. */
  approvers: (club) => client.get(`/clubs/${e(club)}/staff/approvers`),
  /**
   * Подтверждение скидки выше лимита PIN управляющего на этом терминале (№95):
   * { user_id, pin, reason_code, reason_text, percent | amount_kopecks } → { approval_id, expires_at }; 401 PIN, 403 не управляющий, 429 блок.
   */
  approveDiscount: (body) => client.post('/pos/discount-approvals', body),
  /** Касса ККТ: { state: online | warning | offline, reason, bridges, queue: { pending, failed } } (backend-kkt). */
  kktStatus: (club) => client.get(`/clubs/${e(club)}/kkt/status`),
  /** Настройки кассы клуба: { discount_limit_percent, stop_at_zero, tab_limit_kopecks } (backend-pos). */
  posSettings: (club) => client.get(`/clubs/${e(club)}/pos/settings`),
  /** Каталог управляющего целиком: категории, товары с modifier_group_ids, группы модификаторов. */
  catalog: (club) => client.get(`/clubs/${e(club)}/catalog`),

  // ---------- M2: бар ----------
  barQueue: (club) => client.get(`/clubs/${e(club)}/bar/queue`),
  setOrderStatus: (id, status) => client.post(`/orders/${e(id)}/status`, { status }),

  // ---------- M2: смены ----------
  currentShift: (club) => client.get(`/clubs/${e(club)}/shifts/current`),
  shifts: (club, query) => client.get(`/clubs/${e(club)}/shifts`, { query }),
  openShift: (club, floatKopecks, idempotencyKey) => client.post(`/clubs/${e(club)}/shifts`, { float_kopecks: floatKopecks }, { idempotencyKey }),
  closeShift: (id, body, idempotencyKey) => client.post(`/shifts/${e(id)}/close`, body, { idempotencyKey }),
  shiftReport: (id) => client.get(`/shifts/${e(id)}/report`),

  // ---------- M2: склад и меню (управляющий) ----------
  stock: (club) => client.get(`/clubs/${e(club)}/stock`),
  arrival: (body, idempotencyKey) => client.post('/stock/arrivals', body, { idempotencyKey }),
  writeoff: (body, idempotencyKey) => client.post('/stock/writeoffs', body, { idempotencyKey }),
  stockAudit: (body, idempotencyKey) => client.post('/stock/audits', body, { idempotencyKey }),
  // Каталог управляющего (api/routes/catalog.mjs backend-pos)
  createProduct: (club, body) => client.post(`/clubs/${e(club)}/catalog/products`, body),
  updateProduct: (id, body) => client.request('PATCH', `/catalog/products/${e(id)}`, { body }),
  /** Группа с вариантами сразу: { name, min_select, max_select, modifiers: [{ name, price_delta_kopecks }] }. */
  createGroup: (club, body) => client.post(`/clubs/${e(club)}/catalog/modifier-groups`, body),
  /** Группа без вариантов: { name, min_select, max_select, active }; варианты — addModifier и updateModifier. */
  updateGroup: (id, body) => client.request('PATCH', `/catalog/modifier-groups/${e(id)}`, { body }),
  /** Стоп-лист — ресепшн и выше (№88): только флаг, без цен и состава. */
  setStopList: (id, stopList) => client.post(`/catalog/products/${e(id)}/stop-list`, { stop_list: stopList }),
  addModifier: (groupId, body) => client.post(`/catalog/modifier-groups/${e(groupId)}/modifiers`, body),
  updateModifier: (id, body) => client.request('PATCH', `/catalog/modifiers/${e(id)}`, { body }),
  /** Импорт CSV как есть: { csv, dry_run } → { applied, created, updated, unchanged, categories_created, errors: [{ line, field, code }] }. */
  importMenu: (club, csv, dryRun = false) => client.post(`/clubs/${e(club)}/catalog/import`, { csv, dry_run: dryRun }),

  // ---------- M2: ККТ клуба (владелец) ----------
  kktBridges: (club) => client.get(`/clubs/${e(club)}/kkt/bridges`),
  /** Регистрация моста: { bridge, token } — токен виден только в этом ответе (в базе — хеш, №77). */
  registerBridge: (club, name) => client.post(`/clubs/${e(club)}/kkt/bridges`, { name }),
  revokeBridge: (id) => client.post(`/kkt/bridges/${e(id)}/revoke`),
  /** Чеки ККТ: status open (в очереди, исход неизвестен, не пробились) | pending | unknown | failed | printed. */
  kktReceipts: (club, status = 'open') => client.get(`/clubs/${e(club)}/kkt/receipts`, { query: { status } }),
  /** Управляющий: повторить чек (failed или исход неизвестен — проверили, на ККТ его нет), причина обязательна. */
  retryReceipt: (id, reason) => client.post(`/kkt/receipts/${e(id)}/retry`, { reason }),
  /** Управляющий: исход неизвестен, а чек на ленте есть — ФД и ФП с ленты, причина; ручное действие. */
  markPrinted: (id, body) => client.post(`/kkt/receipts/${e(id)}/mark-printed`, body),

  // ---------- M3: брони, персонал, пакеты часов, депозит (docs/contracts/m3.md §4, server/bookings/README.md) ----------
  /** Брони клуба на рабочий день: { date, from, to, bookings: [бронь + guest: { name, phone_masked, user }] }. */
  bookings: (club, date) => client.get(`/clubs/${e(club)}/bookings`, { query: { date } }),
  /** Столы и занятость дня (без входа): для ленты броней — игры, сервис, закрытые часы. */
  availability: (club, date) => client.get(`/clubs/${e(club)}/availability`, { query: { date } }),
  /** Бронь по телефону: { resource_id, starts_at, minutes, name, phone, source: 'phone' | 'staff' } → confirmed. */
  createPhoneBooking: (club, body) => client.post(`/clubs/${e(club)}/bookings`, body),
  /** Отмена с причиной: ресепшн — только брони phone/staff без предоплаты (№115). */
  cancelBooking: (id, reason) => client.post(`/bookings/${e(id)}/cancel`, { reason }),
  /** «Гость пришёл» для брони по телефону: бронь started, стол — дальше обычной оплатой на ресепшене. */
  arriveBooking: (id) => client.post(`/bookings/${e(id)}/arrive`),

  /** Персонал (владелец): { staff: [{ user_id, name, phone_masked, role, active, pin_set }], invites: [{ id, phone_masked, role, expires_at }] }. */
  staff: (club) => client.get(`/clubs/${e(club)}/staff`),
  /**
   * Пригласить по телефону (+7…) с ролью manager | reception | installer | bar; приглашение на 7 дней (№111).
   * M5.1 (№158): POST …/staff/invites → ещё { invite_text, invite_url }. Пока сервер его не знает (404, 405) —
   * прежний POST …/staff (ответ без текста приглашения).
   */
  async inviteStaff(club, phone, role) {
    try {
      return await client.post(`/clubs/${e(club)}/staff/invites`, { phone, role });
    } catch (err) {
      if (err?.status !== 404 && err?.status !== 405) throw err;
      return client.post(`/clubs/${e(club)}/staff`, { phone, role });
    }
  },
  setStaffRole: (club, userId, role) => client.request('PATCH', `/clubs/${e(club)}/staff/${e(userId)}`, { body: { role } }),
  /** Отозвать доступ в один шаг: членство, PIN и все токены сотрудника. */
  revokeStaff: (club, userId) => client.request('DELETE', `/clubs/${e(club)}/staff/${e(userId)}`),
  revokeInvite: (club, inviteId) => client.request('DELETE', `/clubs/${e(club)}/staff/invites/${e(inviteId)}`),
  /** Терминалы ресепшена (владелец): [{ id, name, created_by: { user_id, name }, created_at, expires_at, last_used_at, revoked_at, locked_at }]. */
  terminals: (club) => client.get(`/clubs/${e(club)}/terminals`),
  /** Отзыв терминала: PIN-входы на нём гаснут сразу. */
  revokeTerminal: (club, id) => client.request('DELETE', `/clubs/${e(club)}/terminals/${e(id)}`),
  /** Снять блокировку после 10 неверных PIN за час. */
  unlockTerminal: (club, id) => client.post(`/clubs/${e(club)}/terminals/${e(id)}/unlock`),

  // ---------- M4: турниры клуба (контракт m4 §4; формы — в mock/m4.js) ----------
  tournaments: (club) => client.get(`/clubs/${e(club)}/tournaments`),
  /** { title, discipline, format, race_to, rating_limit, fee_kopecks, prize_text, places, starts_at, ends_at, resource_ids } */
  createTournament: (club, body) => client.post(`/clubs/${e(club)}/tournaments`, body),
  tournament: (club, id) => client.get(`/clubs/${e(club)}/tournaments/${e(id)}`),
  updateTournament: (club, id, body) => client.request('PATCH', `/clubs/${e(club)}/tournaments/${e(id)}`, { body }),
  startTournament: (club, id) => client.post(`/clubs/${e(club)}/tournaments/${e(id)}/start`),
  /**
   * Отмена: { reason } до старта (взносы всем, №138); после старта { reason, refund: 'none' } или
   * { reason, refund: 'all', reason_code: 'equipment' | 'venue' } (№149) → { refunded }. Строка — прежний вид { reason }.
   */
  cancelTournament: (club, id, body) => client.post(`/clubs/${e(club)}/tournaments/${e(id)}/cancel`, typeof body === 'string' ? { reason: body } : body),
  /** Продление идущего турнира (№147): { ends_at?, match_minutes?, reason } → детали; 409 limit_exceeded { extend_limit_until }. */
  extendTournament: (club, id, body) => client.post(`/clubs/${e(club)}/tournaments/${e(id)}/extend`, body),
  /** Возврат взноса одному игроку после старта (№149): { reason_code, comment } → { entry_id, refund_status, reason_code, amount_kopecks }. */
  refundEntry: (club, id, entryId, body) => client.post(`/clubs/${e(club)}/tournaments/${e(id)}/entries/${e(entryId)}/refund`, body),
  /** Исправление счёта организатором — с причиной, в журнал. */
  fixScore: (matchId, scoreA, scoreB, reason) => client.request('PATCH', `/tournaments/matches/${e(matchId)}/score`, { body: { score_a: scoreA, score_b: scoreB, reason } }),
  /** ТВ-экран: публичный турнир без ПДн. */
  publicTournament: (id) => client.get(`/public/tournaments/${e(id)}`),

  // ---------- M4: споры по партиям, карточка клуба, отзывы ----------
  disputes: (club) => client.get(`/clubs/${e(club)}/plus/disputes`),
  /** { result: 'a' | 'b' | 'annul', reason } — решение в журнал. */
  resolveMatch: (id, result, reason) => client.post(`/plus/matches/${e(id)}/resolve`, { result, reason }),
  listing: (club) => client.get(`/clubs/${e(club)}/listing`),
  updateListing: (club, body) => client.request('PATCH', `/clubs/${e(club)}/listing`, { body }),
  reviews: (club) => client.get(`/clubs/${e(club)}/reviews`),
  replyReview: (id, text) => client.post(`/reviews/${e(id)}/reply`, { text }),
  reportReview: (id, reason) => client.post(`/reviews/${e(id)}/report`, { reason }),

  // ---------- M4: оператор платформы (platform_operator, platform_admin) ----------
  /** kind: requests | leads | listings | reports → { items }. */
  platformList: (kind) => client.get(`/platform/${e(kind)}`),
  platformUpdate: (kind, id, body) => client.request('PATCH', `/platform/${e(kind)}/${e(id)}`, { body }),
  /** Справочник городов: { name, name_in, timezone, region?, slug?, active? }; slug после создания не меняется. */
  createCity: (body) => client.post('/platform/cities', body),

  /** Пакеты часов: [{ id, title, hours, minutes, price_kopecks, valid_days, active }]. */
  packages: (club) => client.get(`/clubs/${e(club)}/packages`),
  /** { title, hours, price_kopecks, valid_days, reason } — управляющий, владельцу уходит уведомление. */
  createPackage: (club, body) => client.post(`/clubs/${e(club)}/packages`, body),
  archivePackage: (id, reason) => client.post(`/packages/${e(id)}/archive`, { reason }),
  /**
   * Партии пакетов гостя в клубе по точному телефону (управляющий+, money):
   * [{ id, package_id, title, source: 'app' | 'pos', sale_id, idx, price_kopecks, minutes_total, minutes_left, created_at, expires_at, refunded_at, guest: { name, phone_masked } }].
   */
  packageLots: (club, phone) => client.get(`/clubs/${e(club)}/package-lots`, { query: { phone } }),
  /** Возврат пакета из приложения целиком (№118): { reason } → { lot_id, payment_id, amount_kopecks, refund_id }; 409 package_used, already_refunded. */
  refundLot: (id, reason, idempotencyKey) => client.post(`/packages/lots/${e(id)}/refund`, { reason }, { idempotencyKey }),
  /** Возврат по продаже кассы: { reason, items?, packages?: [idx] } (управляющий+, №118) → { pos_refund_id, amount_kopecks, status, receipt_status, … }. */
  refundSale: (id, body, idempotencyKey) => client.post(`/pos/sales/${e(id)}/refund`, body, { idempotencyKey }),

  /** Снять удержание стола предложением из очереди (№122, ресепшн+): { reason } → запись очереди; 409 offer_expired. */
  releaseOffer: (id, reason) => client.post(`/waitlist/offers/${e(id)}/release`, { reason }),
  /** Действие тревоги «Повторить» чек зачёта (Д2, управляющий+): { reason } → { receipt_id, status, retried }. */
  retryReceiptSettle: (id, reason, idempotencyKey) => client.post(`/receipts/${e(id)}/retry`, { reason }, { idempotencyKey }),

  // ---------- M5.1: подключение клуба без выезда (docs/contracts/m5-1.md §4) ----------
  /** Создать клуб (№152): { name, city_id | city_name, timezone, listing_id? } → { club_id, mode: 'test' }; 409 clubs_limit. */
  createClub: (body) => client.post('/clubs', body),
  /** Справочник городов каталога: { items: [{ slug, name, … }] }. */
  cities: () => client.get('/public/cities'),
  /** Карточки, которые можно связать с новым клубом (одобренная «Подтвердить клуб»): { items: [{ listing_id, name, address, city, city_id, timezone }] }. */
  claimableListings: () => client.get('/clubs/claimable-listings'),
  /** Мастер: { mode, steps: [{ id, done }], checklist: { items, ready }, hall?, payment_checks?, … }. */
  onboarding: (club) => client.get(`/clubs/${e(club)}/onboarding`),
  /** Перейти в боевой режим (№160) → { mode: 'live' }; 409 checklist_incomplete { failed }. */
  goLive: (club) => client.post(`/clubs/${e(club)}/go-live`, { accept_offer: true }),
  /** Настройки оплаты клуба: { settings: { reception_enabled, sbp_enabled, card_enabled, vat_code, tax_system_code }, shops }. */
  clubPaymentSettings: (club) => client.get(`/clubs/${e(club)}/payment-settings`),
  /** { reception_enabled?, …, reason? } → settings; в live причина обязательна (ручное действие). Пункт чек-листа kkt. */
  updateClubPaymentSettings: (club, body) => client.request('PATCH', `/clubs/${e(club)}/payment-settings`, { body }),
  /** Магазин ЮKassa (№154): mode test | live → { shop_id, secret_mask, verified_at, test, fiscalization }. */
  paymentSettings: (club, mode) => client.get(`/clubs/${e(club)}/payment-settings/${e(mode)}`),
  /** { shop_id, secret_key?, reason? }; 400 shop_invalid, shop_mode_mismatch, fiscalization_off. */
  savePaymentSettings: (club, mode, body) => client.request('PUT', `/clubs/${e(club)}/payment-settings/${e(mode)}`, { body }),
  /** Проверочный платёж 1 ₽ с возвратом → { payment_id }; статус — в onboarding.payment_checks. */
  checkPayment: (club, mode, idempotencyKey) => client.post(`/clubs/${e(club)}/payment-settings/${e(mode)}/check`, {}, { idempotencyKey }),
  /**
   * Столы и план (№155): { plan: { width_cm, height_cm }, resources: [{ id, number, kind, type, title, code, plan_x, plan_y,
   * plan_rotation, active, sticker_printed_at }] } — и выведенные из работы.
   */
  resources: (club) => client.get(`/clubs/${e(club)}/resources`),
  /** Стол (№155): { number, kind, plan_x, plan_y, plan_rotation, reason? } → стол; в live — причина обязательна. */
  createResource: (club, body) => client.post(`/clubs/${e(club)}/resources`, body),
  /** { number?, kind?, plan_x?, plan_y?, plan_rotation?, active?, reason? }. */
  updateResource: (club, id, body) => client.request('PATCH', `/clubs/${e(club)}/resources/${e(id)}`, { body }),
  /** Размер зала в сантиметрах: { width, height }. */
  saveHall: (club, body) => client.request('PUT', `/clubs/${e(club)}/hall`, { body }),
  /** Текущие правила тарифа — допущение M5.1: GET → { rules: [...] } (форма как у PUT). */
  tariffs: (club) => client.get(`/clubs/${e(club)}/tariffs`),
  /** { rules, reason? } → 400 tariff_gap | tariff_overlap { weekday, from, to }. */
  saveTariffs: (club, body) => client.request('PUT', `/clubs/${e(club)}/tariffs`, { body }),
  /** Импорт меню файлом (.xlsx или .csv) телом запроса с его типом; предпросмотр — ?dry_run=1 (допущение). */
  importMenuFile: (club, file, type, dryRun) =>
    client.request('POST', `/clubs/${e(club)}/catalog/import`, { rawBody: file, contentType: type, query: dryRun ? { dry_run: 1 } : undefined }),
  /** Привязка по QR с корпуса (№159): { qr: 'BLD1:…', resource_id } → { bind_until }; 400 qr_invalid. */
  bindByQr: (club, qr, resourceId) => client.post(`/clubs/${e(club)}/devices/bind`, { qr, resource_id: resourceId }),
  /** Заявка «Заказать комплект» (№159): { kind: 'kit', … } — в форме лида M4. */
  kitLead: (body) => client.post('/leads', body),

  /** Депозит наличными для «Без лимита» (№87, №112): { resource_id, amount_kopecks, received_kopecks? } → { session_id, change_kopecks, paid_until }. */
  deposit: (body, idempotencyKey) => client.post('/reception/deposits', body, { idempotencyKey }),
};

export { newIdempotencyKey };

/**
 * Живые обновления клуба: SSE /api/stream?club={id}. M1: hall, reception_request, alarm, session (контракт §7);
 * M2: bar (заказ бара целиком, m2 §5), stop_list ({ product_id, stop_list }), pos_sale (продажа кассы: оплата СБП прошла
 * или отменена), shift, kkt (состояние кассы ККТ и очередь чеков). Бармену сервер шлёт из канала клуба только bar и stop_list (№97).
 */
/** ТВ-сетка: SSE GET /api/public/tournaments/{id}/stream, событие `bracket` = { rounds } (без ПДн). */
export function streamTournament(id, handlers) {
  return openStream(client.url(`/public/tournaments/${encodeURIComponent(id)}/stream`), { ...handlers, events: ['bracket'], EventSource: EventSourceImpl });
}

export function streamClub(club, handlers) {
  return openStream(client.url('/stream', { club }), {
    ...handlers,
    events: handlers.events ?? ['hall', 'reception_request', 'alarm', 'session', 'bar', 'stop_list', 'pos_sale', 'shift', 'kkt', 'booking'],
    EventSource: EventSourceImpl,
  });
}
