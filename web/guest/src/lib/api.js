import { createClient, newIdempotencyKey, openStream } from '@billiardum/shared/api';
import { session } from './store.js';
import { BASE } from './env.js';

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
 * Поток SSE по каналу: { session: id } или { me: 1 }. В PWA — cookie; в мини-приложении EventSource не передаёт
 * Bearer — одноразовый токен потока на 60 с (POST /api/stream/token, §14).
 */
function streamChannel(query, tokenBody, opts) {
  const url = client.url('/stream', query);
  if (!hasBearer()) return openStream(url, opts);
  let inner = null;
  let closed = false;
  api
    .streamToken(tokenBody)
    .then((t) => t?.token)
    .catch(() => null)
    .then((token) => {
      if (closed) return;
      inner = openStream(token ? `${url}&token=${encodeURIComponent(token)}` : url, opts);
    });
  return {
    close() {
      closed = true;
      inner?.close();
    },
  };
}

/**
 * Живые обновления сессии: SSE GET /api/stream?session={id}, событие `session` (контракт §7).
 * @param {string} id
 * @param {{ onEvent: (name: string, data: unknown) => void, onOpen?: () => void, onState?: (s: string) => void }} handlers
 */
export function streamSession(id, handlers) {
  // M2: в канале сессии ещё `order` — статус заказа бара (контракт m2 §5)
  return streamChannel({ session: id }, { session: id }, { ...handlers, events: handlers.events ?? ['session'], EventSource: EventSourceImpl });
}

/**
 * Свой канал гостя без сессии (№120): GET /api/stream?me=1, события `booking` и `waitlist`, вид — в data.type
 * (booking.confirmed|reserved|started|expired|canceled; waitlist.offered|accepted|updated).
 * @param {{ onEvent: (name: string, data: any) => void, onOpen?: () => void, onState?: (s: string) => void }} handlers
 */
export function streamMe(handlers) {
  return streamChannel({ me: 1 }, { me: true }, { ...handlers, events: ['booking', 'waitlist'], EventSource: EventSourceImpl });
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
  /** Способы входа, настроенные на сервере (U1): { methods: ['telegram', 'max', 'dev'] }. */
  authMethods: () => client.get('/auth/methods'),
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
  /** «Я играю за этим столом»: код стола из QR подтверждает, что гость у стола (без него — 400 bad_request). */
  join: (id, code) => client.post(`/sessions/${encodeURIComponent(id)}/join`, { code }),
  stop: (id) => client.post(`/sessions/${encodeURIComponent(id)}/stop`),
  resolve: (id, choice) => client.post(`/sessions/${encodeURIComponent(id)}/resolve`, { choice }),
  receipt: (id) => client.get(`/sessions/${encodeURIComponent(id)}/receipt`),

  // §14: открытый ключ VAPID; подписка — PushSubscription.toJSON() как есть
  pushKey: () => client.get('/push/vapid-public-key'),
  pushSubscribe: (subscription) => client.post('/push/subscribe', subscription),
  streamToken: (query) => client.post('/stream/token', query),

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
  /** Клубы (без входа, №120): [{ id, name, city, address, timezone, plan }]. */
  clubs: () => client.get('/clubs'),
  /** Свободные интервалы столов на рабочий день клуба (без входа, server/bookings/availability.mjs). */
  availability: (clubId, date) => client.get(`/clubs/${e(clubId)}/availability`, { query: { date } }),
  /** { resource_id, starts_at, minutes } → бронь: pending_payment при предоплате, иначе confirmed. */
  createBooking: (body) => once(bookingKeys, JSON.stringify(body), (key) => client.post('/bookings', body, { idempotencyKey: key })),
  booking: (id) => client.get(`/bookings/${e(id)}`),
  myBookings: () => client.get('/me/bookings'),
  /** Предоплата брони: { method, return_url } → { booking, payment_id, confirmation }; с ЮKassa — обратно на экран брони. */
  payBooking: (id, method) =>
    once(moneyKeys, `booking:${id}:${method}`, (key) => client.post(`/bookings/${e(id)}/pay`, { method, return_url: `${BASE}bookings/${e(id)}?paid=1` }, { idempotencyKey: key })),
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
  /**
   * Занять стол по предложению (5 минут, №109) → { status: 'accepted', resource, resource_id, hold_until }: стол держится
   * за гостем 3 минуты; кода стола нет (№119) — игра начинается сканированием QR.
   */
  acceptWaitlist: (id) => client.post(`/waitlist/${e(id)}/accept`),

  /** Пакеты часов клуба: [{ id, title, hours, minutes, price_kopecks, valid_days, active }]. */
  packages: (clubId) => client.get(`/clubs/${e(clubId)}/packages`),
  /** Покупка пакета: { method, return_url } → { payment_id, status, confirmation }; с ЮKassa — в профиль. */
  buyPackage: (id, method) =>
    once(moneyKeys, `package:${id}:${method}`, (key) => client.post(`/packages/${e(id)}/buy`, { method, return_url: `${BASE}me?paid=package` }, { idempotencyKey: key })),
  /** Часы на балансе в клубе: { minutes, lots: [{ id, package_id, minutes_left, expires_at }] }. */
  balance: (clubId) => client.get(`/clubs/${e(clubId)}/balance`),

  /** Каналы уведомлений: { notify_channel, channels_order } — max | telegram | webpush (№110). */
  updateMe: (body) => client.request('PATCH', '/me', { body }),

  // ---------- M4: Бильярдум+ (контракт m4 §4; формы — в mock/m4.js) ----------
  /** Профиль: { nick, ratings, achievements, history, privacy }. */
  plusMe: () => client.get('/plus/me'),
  /** { nick?, privacy? }; 409 nick_taken. */
  updatePlus: (body) => client.request('PATCH', '/plus/me', { body }),
  /** Карточка игрока с учётом его приватности. */
  player: (nick) => client.get(`/plus/players/${e(nick)}`),
  /** Партии: свои, или партии сессии — { items: [match] }. */
  matches: (sessionId) => client.get('/plus/matches', { query: sessionId ? { session_id: sessionId } : undefined }),
  /** Одна партия (ссылка из уведомления): отдельного GET нет — ищем в своих партиях. */
  match: async (id) => {
    const res = await client.get('/plus/matches');
    const m = (res?.items ?? []).find((x) => x.id === id);
    if (!m) throw Object.assign(new Error('not_found'), { code: 'not_found' });
    return m;
  },
  /** Внести партию: { session_id, discipline, opponent_id, my_score, opponent_score } → match (ждёт подтверждения соперника 30 минут). */
  addMatch: (body) => client.post('/plus/matches', body),
  confirmMatch: (id) => client.post(`/plus/matches/${e(id)}/confirm`),
  disputeMatch: (id, reason) => client.post(`/plus/matches/${e(id)}/dispute`, { reason }),
  /**
   * Таблица: { discipline, scope: club|city|country, club?, city?, season: YYYY-MM|all } → { items, me }.
   * Вошедшему — /api/plus/rating (отдаёт своё место me, №144), без входа — публичная, me: null.
   */
  rating: (query, signedIn = false) => client.get(signedIn ? '/plus/rating' : '/public/rating', { query }),
  lfg: () => client.get('/plus/lfg'),
  startLfg: (body) => client.post('/plus/lfg', body),
  stopLfg: () => client.request('DELETE', '/plus/lfg'),
  invites: () => client.get('/plus/invites'),
  /** «Сыграем?»: { to_user_id, discipline, club_id, starts_at, minutes }; лимит 10 в день. */
  invite: (body) => client.post('/plus/invites', body),
  answerInvite: (id, accept) => client.post(`/plus/invites/${e(id)}/${accept ? 'accept' : 'decline'}`),
  friends: () => client.get('/plus/friends'),
  addFriend: (nick) => client.post('/plus/friends', { nick }),
  removeFriend: (userId) => client.request('DELETE', `/plus/friends/${e(userId)}`),

  // ---------- M4: турниры ----------
  tournaments: (query) => client.get('/public/tournaments', { query }),
  tournament: (id) => client.get(`/public/tournaments/${e(id)}`),
  /** Моя запись и текущий матч: { entry, match }. */
  myTournament: (id) => client.get(`/tournaments/${e(id)}/me`),
  /** Запись со взносом: → { entry_id, status, confirmation }; 409 rating_above_limit { limit, rating } (T24). */
  enterTournament: (id) =>
    once(moneyKeys, `tournament:${id}`, (key) => client.post(`/tournaments/${e(id)}/entries`, { return_url: `${BASE}tournaments/${e(id)}?paid=1` }, { idempotencyKey: key })),
  leaveTournament: (id) => client.request('DELETE', `/tournaments/${e(id)}/entries/me`),
  tournamentScore: (matchId, scoreA, scoreB) => client.post(`/tournaments/matches/${e(matchId)}/score`, { score_a: scoreA, score_b: scoreB }),
  confirmTournamentScore: (matchId) => client.post(`/tournaments/matches/${e(matchId)}/confirm`),

  // ---------- M4: отзывы и заявка в клуб без программы (T25) ----------
  myReview: (clubId) => client.get('/reviews/mine', { query: { club_id: clubId } }),
  /** { club_id, rating 1–5, text ≤ 1000 }; 403 review_not_allowed — нет игры или брони за 90 дней. */
  review: (body) => client.post('/reviews', body),
  listing: (id) => client.get(`/public/listings/${e(id)}`),
  /** { listing_id, starts_at, minutes, people, comment } → { id, status }. */
  clubRequest: (body) => client.post('/clubs/requests', body),
  clubRequestStatus: (id) => client.get(`/clubs/requests/${e(id)}`),
  cancelClubRequest: (id) => client.post(`/clubs/requests/${e(id)}/cancel`),
  /** «Добавить клуб» (с сайта): { city, name, address, phone?, hours_text?, disciplines?, tables_count?, comment? } → { id, status: 'new' }. */
  directoryAdd: (body) => client.post('/directory/add', body),
  /** «Подтвердить клуб»: { listing_id, comment? } → { id, status: 'new' }; 409 already_claimed. */
  directoryClaim: (listingId, comment) => client.post('/directory/claim', { listing_id: listingId, ...(comment ? { comment } : {}) }),
};

/** Сетка турнира вживую: SSE GET /api/public/tournaments/{id}/stream, событие `bracket` = { rounds } (без ПДн). */
export function streamTournament(id, handlers) {
  return openStream(client.url(`/public/tournaments/${encodeURIComponent(id)}/stream`), { ...handlers, events: ['bracket'], EventSource: EventSourceImpl });
}

