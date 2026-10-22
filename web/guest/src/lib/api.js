import { createClient, newIdempotencyKey, openStream } from '@billiardum/shared/api';
import { session } from './store.js';

/**
 * Вызовы API гостя по контракту M1 (§4–§7). Транспорт подменяется заглушкой в режиме VITE_MOCK.
 *
 * Вход: в PWA — cookie bl_session (Path=/api, сервер ставит её на всех входах, §14), токен из ответа не храним.
 * В мини-приложениях cookie в WebView ненадёжны — там Authorization: Bearer (токен в sessionStorage вкладки),
 * а для SSE — одноразовый токен потока (POST /api/stream/token, §14).
 */

const BEARER_KEY = 'bl-bearer';

let client = createClient({ token: () => session.get(BEARER_KEY) });
let EventSourceImpl = globalThis.EventSource;

/** Подменить fetch и EventSource (заглушка разработки, тесты). */
export function configureApi({ fetch, EventSource, onUnauthorized } = {}) {
  client = createClient({ fetch, token: () => session.get(BEARER_KEY), onUnauthorized });
  if (EventSource) EventSourceImpl = EventSource;
}

/**
 * Живые обновления сессии: SSE GET /api/stream?session={id}, событие `session` (контракт §7).
 * @param {string} id
 * @param {{ onEvent: (name: string, data: unknown) => void, onOpen?: () => void, onState?: (s: string) => void }} handlers
 */
export function streamSession(id, handlers) {
  // M2: в канале сессии ещё `order` — статус заказа бара (контракт m2 §5)
  const opts = { ...handlers, events: handlers.events ?? ['session'], EventSource: EventSourceImpl };
  if (!hasBearer()) return openStream(api.streamUrl(id), opts);
  // Мини-приложение: EventSource не передаёт Bearer — одноразовый токен потока на 60 с
  let inner = null;
  let closed = false;
  api
    .streamToken({ session: id })
    .then((t) => t?.token)
    .catch(() => null)
    .then((token) => {
      if (closed) return;
      const url = token ? `${api.streamUrl(id)}&token=${encodeURIComponent(token)}` : api.streamUrl(id);
      inner = openStream(url, opts);
    });
  return {
    close() {
      closed = true;
      inner?.close();
    },
  };
}

/** Токен для мини-приложений, где cookie в WebView ненадёжны. */
export function setBearer(token) {
  session.set(BEARER_KEY, token || null);
}

export function hasBearer() {
  return Boolean(session.get(BEARER_KEY));
}

// Ключ идемпотентности живёт, пока не пришёл ответ: повтор после обрыва связи не создаёт второй платёж
const payKeys = new Map();

/**
 * Ключ на одну попытку: тот же состав запроса до успешного ответа — тот же ключ (повтор после обрыва
 * не создаст второй заказ); после успеха ключ забывается — такой же заказ позже будет новым.
 */
async function once(map, fingerprint, run) {
  if (!map.has(fingerprint)) map.set(fingerprint, newIdempotencyKey());
  const res = await run(map.get(fingerprint));
  map.delete(fingerprint);
  return res;
}
const orderKeys = new Map();
const tabKeys = new Map();
const bookingKeys = new Map();
const moneyKeys = new Map();
const e = encodeURIComponent;

export const api = {
  table: (code) => client.get(`/t/${encodeURIComponent(code)}`),
  me: () => client.get('/me'),

  devLogin: (phone) => client.post('/auth/dev', { phone }),
  botLink: (channel) => client.post('/auth/bot-link', { channel }),
  botLinkStatus: (nonce) => client.get(`/auth/bot-link/${encodeURIComponent(nonce)}`),
  telegramLogin: (initData) => client.post('/auth/telegram', { init_data: initData }),
  consent: (version) => client.post('/auth/consent', { version }),
  logout: () => client.post('/auth/logout'),

  /** @param {{ resourceId: string, kind: 'start' | 'extend', minutes: number | null, sessionId?: string }} q */
  /** M3: useBalance — часть минут оплатить часами пакета (ответ: balance_minutes, balance_available_minutes, доплата amount_kopecks). */
  quote: (q) =>
    client.post('/quotes', {
      resource_id: q.resourceId,
      kind: q.kind,
      minutes: q.minutes,
      ...(q.sessionId ? { session_id: q.sessionId } : {}),
      ...(q.useBalance ? { use_balance: true } : {}),
    }),
  /**
   * @param {string} quoteId
   * @param {'sbp' | 'card' | 'reception' | 'balance'} method
   * @param {{ rest_method?: 'sbp' | 'card' }} [extra] balance не покрыл всё — доплата остатка (M3, №112)
   */
  async pay(quoteId, method, extra = {}) {
    const k = `${quoteId}:${method}:${extra.rest_method ?? ''}`;
    if (!payKeys.has(k)) payKeys.set(k, newIdempotencyKey());
    const res = await client.post(`/quotes/${encodeURIComponent(quoteId)}/pay`, { method, ...extra }, { idempotencyKey: payKeys.get(k) });
    return res;
  },
  payment: (id) => client.get(`/payments/${encodeURIComponent(id)}`),
  // Статус заявки на ресепшен для гостя (решение №56): waiting | accepted | declined | expired
  receptionRequest: (id) => client.get(`/reception/requests/${encodeURIComponent(id)}`),

  currentSessions: () => client.get('/sessions/current'),
  session: (id) => client.get(`/sessions/${encodeURIComponent(id)}`),
  join: (id) => client.post(`/sessions/${encodeURIComponent(id)}/join`),
  stop: (id) => client.post(`/sessions/${encodeURIComponent(id)}/stop`),
  resolve: (id, choice) => client.post(`/sessions/${encodeURIComponent(id)}/resolve`, { choice }),
  receipt: (id) => client.get(`/sessions/${encodeURIComponent(id)}/receipt`),

  // §14: открытый ключ VAPID; подписка — PushSubscription.toJSON() как есть
  pushKey: () => client.get('/push/vapid-public-key'),
  pushSubscribe: (subscription) => client.post('/push/subscribe', subscription),
  streamToken: (query) => client.post('/stream/token', query),

  streamUrl: (sessionId) => client.url('/stream', { session: sessionId }),

  // ---------- M2: бар со стола (backend-pos, server/orders/README.md) ----------
  /** Меню гостя: алкоголь сервер не отдаёт (№76). */
  menu: (clubId) => client.get(`/clubs/${encodeURIComponent(clubId)}/menu`),
  /**
   * Заказ со стола: { session_id, items, pay: 'tab' | 'online', method?: 'sbp' | 'card', comment? } → { order, payment? }.
   * online — payment.confirmation.url (ЮKassa), return_url сервера — /app/orders/{id}.
   */
  createOrder: (body) => once(orderKeys, JSON.stringify(body), (key) => client.post('/orders', body, { idempotencyKey: key })),
  order: (id) => client.get(`/orders/${encodeURIComponent(id)}`),
  /** Счёт стола: { session_id, orders, total_kopecks, pending_payment } — живёт дольше сессии (№79). */
  tab: (sessionId) => client.get(`/sessions/${encodeURIComponent(sessionId)}/tab`),
  sessionOrders: (sessionId) => client.get(`/sessions/${encodeURIComponent(sessionId)}/orders`),
  /** Оплата счёта стола онлайн: { method } → { sale_id, payment_id, status, confirmation }; return_url — /app/sessions/{id}/tab. */
  payTab: (sessionId, method, total) =>
    once(tabKeys, `${sessionId}:${method}:${total}`, (key) => client.post(`/sessions/${encodeURIComponent(sessionId)}/tab/pay`, { method }, { idempotencyKey: key })),

  // ---------- M3: бронь, лист ожидания, пакеты часов, каналы уведомлений (docs/contracts/m3.md §4) ----------
  /** Клубы для брони — предложение frontend (GET /api/clubs); пока его нет, клуб берём со стола, где гость был. */
  clubs: () => client.get('/clubs'),
  /** Свободные интервалы столов на рабочий день клуба (без входа, server/bookings/availability.mjs). */
  availability: (clubId, date) => client.get(`/clubs/${e(clubId)}/availability`, { query: { date } }),
  /** { resource_id, starts_at, minutes } → бронь: pending_payment при предоплате, иначе confirmed. */
  createBooking: (body) => once(bookingKeys, JSON.stringify(body), (key) => client.post('/bookings', body, { idempotencyKey: key })),
  booking: (id) => client.get(`/bookings/${e(id)}`),
  myBookings: () => client.get('/me/bookings'),
  /** Предоплата брони: { method } → { booking, payment_id, confirmation }. */
  payBooking: (id, method) => once(moneyKeys, `booking:${id}:${method}`, (key) => client.post(`/bookings/${e(id)}/pay`, { method }, { idempotencyKey: key })),
  cancelBooking: (id) => client.post(`/bookings/${e(id)}/cancel`, {}),
  /**
   * Старт по брони у стола: { code } — код стола с QR (+ method для доплаты) →
   * { status: 'started', session_id } | { status: 'payment_required', amount_kopecks, confirmation | quote }.
   */
  startBooking: (id, code, method) => client.post(`/bookings/${e(id)}/start`, { code, ...(method ? { method } : {}) }),

  joinWaitlist: (resourceId) => client.post('/waitlist', { resource_id: resourceId }),
  /** Свои записи в очереди: [{ id, resource, status, position, offer_until, hold_until }]. */
  myWaitlist: () => client.get('/me/waitlist'),
  leaveWaitlist: (id) => client.request('DELETE', `/waitlist/${e(id)}`),
  /** Занять стол по предложению (5 минут, №109): стол держится за гостем 3 минуты, дальше — обычная котировка и оплата. */
  acceptWaitlist: (id) => client.post(`/waitlist/${e(id)}/accept`),

  /** Пакеты часов клуба: [{ id, title, hours, minutes, price_kopecks, valid_days, active }]. */
  packages: (clubId) => client.get(`/clubs/${e(clubId)}/packages`),
  /** Покупка пакета: { method } → { payment_id, status, confirmation }. */
  buyPackage: (id, method) => once(moneyKeys, `package:${id}:${method}`, (key) => client.post(`/packages/${e(id)}/buy`, { method }, { idempotencyKey: key })),
  /** Часы на балансе в клубе: { minutes, lots: [{ id, package_id, minutes_left, expires_at }] }. */
  balance: (clubId) => client.get(`/clubs/${e(clubId)}/balance`),

  /** Каналы уведомлений: { notify_channel, channels_order } — max | telegram | webpush (№110). */
  updateMe: (body) => client.request('PATCH', '/me', { body }),
};

