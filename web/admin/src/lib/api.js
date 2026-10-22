import { createClient, newIdempotencyKey, openStream } from '@billiardum/shared/api';
import { session, local } from './store.js';

/**
 * Вызовы API программы клуба по контракту M1 (§4–§7).
 * Вход — cookie bl_session; после быстрой смены по PIN на терминале — Authorization: Bearer (токен смены во вкладке).
 * Терминал ресепшена хранит свой terminal_token в localStorage и шлёт его заголовком X-Bl-Terminal
 * только в маршруты терминала (имя заголовка запрошено у backend-core).
 */

const BEARER_KEY = 'bl-staff-bearer';
export const TERMINAL_KEY = 'bl-terminal';

const tokenFn = () => session.get(BEARER_KEY);
let doFetch;
let client = createClient({ token: tokenFn });
let EventSourceImpl = globalThis.EventSource;

export function configureApi({ fetch, EventSource } = {}) {
  doFetch = fetch;
  client = createClient({ fetch, token: tokenFn });
  if (EventSource) EventSourceImpl = EventSource;
}

export function setStaffBearer(token) {
  session.set(BEARER_KEY, token || null);
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

const terminalClient = () =>
  createClient({
    fetch: doFetch,
    headers: (h) => {
      const t = getTerminal();
      if (t?.token) h['X-Bl-Terminal'] = t.token;
    },
  });

const e = encodeURIComponent;
const acceptKeys = new Map();

export const api = {
  me: () => client.get('/me'),
  devLogin: (phone) => client.post('/auth/dev', { phone }),
  botLink: (channel) => client.post('/auth/bot-link', { channel }),
  botLinkStatus: (nonce) => client.get(`/auth/bot-link/${e(nonce)}`),
  logout: () => client.post('/auth/logout'),

  registerTerminal: (clubId, name) => client.post('/staff/terminal', { club_id: clubId, name }),
  // Нет в контракте M1: список сотрудников для экрана PIN на терминале. Запрошено у backend-core.
  terminalUsers: () => terminalClient().get('/staff/terminal/users'),
  pin: (userId, pin) => terminalClient().post('/staff/pin', { user_id: userId, pin }),

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

  now: (club) => client.get(`/clubs/${e(club)}/now`),
  audit: (club, query) => client.get(`/clubs/${e(club)}/audit`, { query }),
  verify: (club) => client.get(`/clubs/${e(club)}/audit/verify`),
  alarms: (club) => client.get(`/clubs/${e(club)}/alarms`, { query: { state: 'open' } }),
  ack: (id) => client.post(`/alarms/${e(id)}/ack`),
  /** PDF наклеек: Response, чтобы забрать Blob. */
  qrStickers: (club) => client.request('GET', `/clubs/${e(club)}/qr-stickers.pdf`, { raw: true }),
};

/**
 * Живые обновления клуба: SSE /api/stream?club={id}, события hall, reception_request, alarm (контракт §7).
 */
export function streamClub(club, handlers) {
  return openStream(client.url('/stream', { club }), {
    ...handlers,
    events: ['hall', 'reception_request', 'alarm', 'session'],
    EventSource: EventSourceImpl,
  });
}
