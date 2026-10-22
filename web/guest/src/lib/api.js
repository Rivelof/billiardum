import { createClient, newIdempotencyKey, openStream } from '@billiardum/shared/api';
import { session } from './store.js';

/**
 * Вызовы API гостя по контракту M1 (§4–§7). Транспорт подменяется заглушкой в режиме VITE_MOCK.
 *
 * Вход: в PWA — cookie bl_session (сервер ставит её сам), в мини-приложениях — Authorization: Bearer
 * (токен хранится в sessionStorage вкладки, решение вынести в отчёт frontend M1).
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
  return openStream(api.streamUrl(id), { ...handlers, events: ['session'], EventSource: EventSourceImpl });
}

/** Токен для мини-приложений, где cookie в WebView ненадёжны. */
export function setBearer(token) {
  session.set(BEARER_KEY, token || null);
}

// Ключ идемпотентности живёт, пока не пришёл ответ: повтор после обрыва связи не создаёт второй платёж
const payKeys = new Map();

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
  // Нет в контракте M1: статус заявки на ресепшен для гостя (принята, отклонена, сгорела). Запрошено у backend-money.
  receptionRequest: (id) => client.get(`/reception/requests/${encodeURIComponent(id)}`),

  currentSessions: () => client.get('/sessions/current'),
  session: (id) => client.get(`/sessions/${encodeURIComponent(id)}`),
  join: (id) => client.post(`/sessions/${encodeURIComponent(id)}/join`),
  stop: (id) => client.post(`/sessions/${encodeURIComponent(id)}/stop`),
  resolve: (id, choice) => client.post(`/sessions/${encodeURIComponent(id)}/resolve`, { choice }),
  receipt: (id) => client.get(`/sessions/${encodeURIComponent(id)}/receipt`),

  // Нет в контракте M1: открытый ключ VAPID для подписки. Запрошено у backend-core.
  pushKey: () => client.get('/push/key'),
  pushSubscribe: (subscription) => client.post('/push/subscribe', { subscription }),

  streamUrl: (sessionId) => client.url('/stream', { session: sessionId }),
};
