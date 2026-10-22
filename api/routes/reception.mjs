// Ресепшн (контракт M1 §5, backend-money).
//   GET  /api/clubs/{club}/reception/requests       — ресепшн и выше: заявки, которые ждут
//   POST /api/reception/requests/{id}/accept        — ресепшн и выше, Idempotency-Key: {method, received_kopecks?}
//   POST /api/reception/requests/{id}/decline       — ресепшн и выше: {reason_code} (guest_left, guest_cancelled,
//                                                     payment_failed, table_problem, other)
//   GET  /api/reception/requests/{id}               — гость, автор заявки: статус, у отклонённой — reason_code
// Роли проверяет и сам маршрут: клуб заявки находится по её id.

import { acceptRequest, declineRequest, guestRequestStatus, listRequests, STAFF_ROLES } from '../../server/reception/index.mjs';
import { moneyRoute } from '../../server/payments/route.mjs';

/** У сотрудника несколько клубов: роутер ищет заявку в каждом (RLS — только в своём). */
async function requestInClub(db, req) {
  const { rowCount } = await db.query('select 1 from bl.reception_requests where id = $1', [req.params.id]);
  return rowCount > 0;
}

export const routes = [
  {
    method: 'GET',
    path: '/api/clubs/{club}/reception/requests',
    auth: 'staff',
    roles: [...STAFF_ROLES],
    handler: moneyRoute(({ db, deps, info }) => listRequests(db, deps, info)),
  },
  {
    method: 'POST',
    path: '/api/reception/requests/{id}/accept',
    auth: 'staff',
    roles: [...STAFF_ROLES],
    idempotent: true,
    findClub: requestInClub,
    handler: moneyRoute(({ db, deps, info }) => acceptRequest(db, deps, info)),
  },
  {
    method: 'POST',
    path: '/api/reception/requests/{id}/decline',
    auth: 'staff',
    roles: [...STAFF_ROLES],
    findClub: requestInClub,
    handler: moneyRoute(({ db, deps, info }) => declineRequest(db, deps, info)),
  },
  {
    method: 'GET',
    path: '/api/reception/requests/{id}',
    auth: 'guest',
    handler: moneyRoute(({ db, deps, info }) => guestRequestStatus(db, deps, info)),
  },
];
