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
  /** PDF наклеек: Response, чтобы забрать Blob. */
  qrStickers: (club) => client.request('GET', `/clubs/${e(club)}/qr-stickers.pdf`, { raw: true }),

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
  /** Пригласить по телефону (+7…) с ролью manager | reception | installer | bar; приглашение на 7 дней (№111). */
  inviteStaff: (club, phone, role) => client.post(`/clubs/${e(club)}/staff`, { phone, role }),
  setStaffRole: (club, userId, role) => client.request('PATCH', `/clubs/${e(club)}/staff/${e(userId)}`, { body: { role } }),
  /** Отозвать доступ в один шаг: членство, PIN и все токены сотрудника. */
  revokeStaff: (club, userId) => client.request('DELETE', `/clubs/${e(club)}/staff/${e(userId)}`),
  revokeInvite: (club, inviteId) => client.request('DELETE', `/clubs/${e(club)}/staff/invites/${e(inviteId)}`),

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

  /** Депозит наличными для «Без лимита» (№87, №112): { resource_id, amount_kopecks, received_kopecks? } → { session_id, change_kopecks, paid_until }. */
  deposit: (body, idempotencyKey) => client.post('/reception/deposits', body, { idempotencyKey }),
};

export { newIdempotencyKey };

/**
 * Живые обновления клуба: SSE /api/stream?club={id}. M1: hall, reception_request, alarm, session (контракт §7);
 * M2: bar (заказ бара целиком, m2 §5), stop_list ({ product_id, stop_list }), pos_sale (продажа кассы: оплата СБП прошла
 * или отменена), shift, kkt (состояние кассы ККТ и очередь чеков). Бармену сервер шлёт из канала клуба только bar и stop_list (№97).
 */
export function streamClub(club, handlers) {
  return openStream(client.url('/stream', { club }), {
    ...handlers,
    events: handlers.events ?? ['hall', 'reception_request', 'alarm', 'session', 'bar', 'stop_list', 'pos_sale', 'shift', 'kkt', 'booking'],
    EventSource: EventSourceImpl,
  });
}
