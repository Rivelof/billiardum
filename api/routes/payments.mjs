// Платёж гостя (контракт M1 §5, backend-money).
//   GET /api/payments/{id} — плательщик: {payment_id, status, session_id?}

import { paymentStatus } from '../../server/payments/pay.mjs';
import { moneyRoute } from '../../server/payments/route.mjs';

export const routes = [
  {
    method: 'GET',
    path: '/api/payments/{id}',
    auth: 'guest',
    handler: moneyRoute(({ db, deps, info, config }) => paymentStatus(db, deps, info, config)),
  },
];
