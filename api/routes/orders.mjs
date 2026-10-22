// Заказы бара со стола, экран бара и счёт стола (контракт M2 §4, §5; decisions №76, №79; backend-pos).
//   POST /api/orders                     — гость, участник идущей сессии, Idempotency-Key:
//                                          {session_id, items: [{product_id, qty, modifier_ids?}], pay: online|tab,
//                                           method?: sbp|card, comment?} → {order, payment?}
//   GET  /api/orders/{id}                — автор, участник сессии или персонал клуба
//   POST /api/orders/{id}/status         — бармен (bar), ресепшн и выше; отмена — ресепшн и выше: {status: preparing|ready|served|canceled, reason?}
//   GET  /api/clubs/{club}/bar/queue     — бармен, ресепшн и выше: очередь бара; живые изменения — SSE bar в club:{id}
//   GET  /api/clubs/{club}/tabs          — ресепшн и выше: открытые счета столов
//   GET  /api/sessions/{id}/tab          — участник или персонал: {orders, total_kopecks, pending_payment}
//   GET  /api/sessions/{id}/orders       — участник или персонал: все заказы сессии; SSE order в session:{id}
//   POST /api/sessions/{id}/tab/pay      — Idempotency-Key; гость: {method: sbp|card} → платёж ЮKassa;
//                                          ресепшн: {method: cash|card_terminal, received_kopecks?, discount?}
//                                          или {method: sbp, at_reception: true} — продажа кассы со счётом стола

import { ALL_ROLES } from '../router.mjs';
import { ROLES } from '../../server/orders/core.mjs';
import { inClub, posRoute } from '../../server/orders/route.mjs';
import { barQueue, createGuestOrder, getOrder, getTab, openTabs, payTab, sessionOrders, setOrderStatus } from '../../server/orders/service.mjs';

const RECEPTION = [...ROLES.RECEPTION_UP];
// Бармен (№97): экран бара, статусы, стоп-лист — когда роль bar есть у core (api/router.mjs ALL_ROLES).
const BAR = ALL_ROLES.includes('bar') ? [...RECEPTION, 'bar'] : RECEPTION;

export const routes = [
  {
    method: 'POST',
    path: '/api/orders',
    auth: 'guest',
    requires: ['phone', 'consent'],
    idempotent: true,
    rateLimit: { max: 60, windowMs: 60_000 },
    handler: posRoute(({ db, deps, info }) => createGuestOrder(db, deps, info), { status: 201 }),
  },
  {
    method: 'GET',
    path: '/api/orders/{id}',
    auth: 'guest',
    handler: posRoute(({ db, deps, info }) => getOrder(db, deps, info)),
  },
  {
    method: 'POST',
    path: '/api/orders/{id}/status',
    auth: 'staff',
    roles: BAR,
    findClub: inClub('orders'),
    handler: posRoute(({ db, deps, info }) => setOrderStatus(db, deps, info)),
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/bar/queue',
    auth: 'staff',
    roles: BAR,
    handler: posRoute(({ db, info }) => barQueue(db, { clubId: info.clubId })),
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/tabs',
    auth: 'staff',
    roles: RECEPTION,
    handler: posRoute(({ db, info }) => openTabs(db, { clubId: info.clubId })),
  },
  {
    method: 'GET',
    path: '/api/sessions/{id}/tab',
    auth: 'guest',
    handler: posRoute(({ db, deps, info }) => getTab(db, deps, info)),
  },
  {
    method: 'GET',
    path: '/api/sessions/{id}/orders',
    auth: 'guest',
    handler: posRoute(({ db, deps, info }) => sessionOrders(db, deps, info)),
  },
  {
    method: 'POST',
    path: '/api/sessions/{id}/tab/pay',
    auth: 'guest',
    idempotent: true,
    handler: posRoute(({ db, deps, info }) => payTab(db, deps, info)),
  },
];
