// Склад бара (decisions №80, контракт M2 §4; backend-pos). Клуб — X-Club-Id или единственный клуб сотрудника.
//   POST /api/stock/arrivals              — управляющий и выше: {items: [{product_id, qty, cost_kopecks | unit_cost_kopecks}], note?}
//   POST /api/stock/writeoffs             — управляющий и выше: {items: [{product_id, qty}], reason}
//   POST /api/stock/audits                — управляющий и выше: {items: [{product_id, actual_qty}], note?} — ревизия
//   GET  /api/stock/audits/{id}           — управляющий и выше
//   GET  /api/clubs/{club}/stock          — ресепшн и выше: остатки, средняя себестоимость, стоимость остатка
//   GET  /api/clubs/{club}/stock/movements — управляющий и выше: ?product_id&kind&before&limit

import { ROLES } from '../../server/orders/core.mjs';
import { inClub, posRoute } from '../../server/orders/route.mjs';
import { arrival, getAudit, movements, stockAudit, stockList, writeoff } from '../../server/stock/service.mjs';

const MANAGER = [...ROLES.MANAGER_UP];
const RECEPTION = [...ROLES.RECEPTION_UP];

export const routes = [
  {
    method: 'POST',
    path: '/api/stock/arrivals',
    auth: 'staff',
    roles: MANAGER,
    handler: posRoute(({ db, deps, info }) => arrival(db, deps, info), { status: 201 }),
  },
  {
    method: 'POST',
    path: '/api/stock/writeoffs',
    auth: 'staff',
    roles: MANAGER,
    handler: posRoute(({ db, deps, info }) => writeoff(db, deps, info), { status: 201 }),
  },
  {
    method: 'POST',
    path: '/api/stock/audits',
    auth: 'staff',
    roles: MANAGER,
    handler: posRoute(({ db, deps, info }) => stockAudit(db, deps, info), { status: 201 }),
  },
  {
    method: 'GET',
    path: '/api/stock/audits/{id}',
    auth: 'staff',
    roles: MANAGER,
    findClub: inClub('stock_audits'),
    handler: posRoute(({ db, info }) => getAudit(db, info)),
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/stock',
    auth: 'staff',
    roles: RECEPTION,
    handler: posRoute(({ db, info }) => stockList(db, { clubId: info.clubId })),
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/stock/movements',
    auth: 'staff',
    roles: MANAGER,
    handler: posRoute(({ db, info }) => movements(db, { clubId: info.clubId, query: info.query })),
  },
];
