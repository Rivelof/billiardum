// Стол и котировка (контракт M1 §5, backend-money).
//   GET  /api/t/{code}        — без входа, не больше 120 запросов в минуту с IP (§14, №61)
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
    // 120 запросов в минуту с IP (§14, №61): гости клуба выходят через общий NAT;
    // от перебора защищает длина кода (50 бит, №47). Считает роутер.
    rateLimit: { max: 120, windowMs: 60_000 },
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
