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
