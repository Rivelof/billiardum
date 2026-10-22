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
  quote: (q) =>
    client.post('/quotes', {
      resource_id: q.resourceId,
      kind: q.kind,
      minutes: q.minutes,
      ...(q.sessionId ? { session_id: q.sessionId } : {}),
    }),
  /** @param {string} quoteId @param {'sbp' | 'card' | 'reception'} method */
  async pay(quoteId, method) {
    const k = `${quoteId}:${method}`;
    if (!payKeys.has(k)) payKeys.set(k, newIdempotencyKey());
    const res = await client.post(`/quotes/${encodeURIComponent(quoteId)}/pay`, { method }, { idempotencyKey: payKeys.get(k) });
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
};
