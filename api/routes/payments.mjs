// Платёж гостя (контракт M1 §5, backend-money).
//   GET /api/payments/{id} — плательщик: {payment_id, status, session_id?}
//   POST /api/receipts/{id}/retry — управляющий и выше, Idempotency-Key, {reason}: повтор чека зачёта
//     предоплаты после отказа ЮKassa (дефект Д2) → {receipt_id, status, retried}

import { paymentStatus } from '../../server/payments/pay.mjs';
import { moneyRoute } from '../../server/payments/route.mjs';
import { retryReceipt } from '../../server/payments/receipts-retry.mjs';

export const routes = [
  {
    method: 'GET',
    path: '/api/payments/{id}',
    auth: 'guest',
    handler: moneyRoute(({ db, deps, info, config }) => paymentStatus(db, deps, info, config)),
  },
  {
    method: 'POST',
    path: '/api/receipts/{id}/retry',
    auth: 'staff',
    roles: ['owner', 'manager'],
    idempotent: true,
    findClub: async (db, req) => (await db.query('select 1 from bl.receipts where id = $1', [req.params.id])).rowCount > 0,
    handler: moneyRoute(({ db, deps, info }) => retryReceipt(db, deps, info)),
  },
];
