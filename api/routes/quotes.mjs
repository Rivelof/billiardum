// Стол и котировка (контракт M1 §5, backend-money).
//   GET  /api/t/{code}        — без входа, не больше 30 запросов в минуту с IP (decisions №47)
//   POST /api/quotes          — гость: котировка на 3 минуты, start ставит столу pending
//   POST /api/quotes/{id}/pay — гость, Idempotency-Key: sbp, card (ЮKassa) или reception

import { createQuote, tableByCode } from '../../server/payments/quotes.mjs';
import { payQuote } from '../../server/payments/pay.mjs';
import { moneyRoute } from '../../server/payments/route.mjs';

export const routes = [
  {
    method: 'GET',
    path: '/api/t/{code}',
    auth: 'none',
    // Перебор кодов столов (decisions №47): 30 запросов в минуту с IP, считает роутер.
    rateLimit: { max: 30, windowMs: 60_000 },
    handler: moneyRoute(({ db, deps, info }) => tableByCode(db, deps, { code: info.params.code, userId: info.userId })),
  },
  {
    method: 'POST',
    path: '/api/quotes',
    auth: 'guest',
    requires: ['phone', 'consent'],
    handler: moneyRoute(({ db, deps, info, config }) => createQuote(db, deps, info, config)),
  },
  {
    method: 'POST',
    path: '/api/quotes/{id}/pay',
    auth: 'guest',
    requires: ['phone', 'consent'],
    idempotent: true,
    handler: moneyRoute(({ db, deps, info, config }) => payQuote(db, deps, info, config)),
  },
];
