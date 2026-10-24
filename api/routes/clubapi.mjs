// Публичный API клуба (M5.7 №199–202): маршруты по ключу API (/api/v1/club/…, только чтение)
// и маршруты владельца — ключи и вебхуки. Логика — server/clubapi.
//
// auth 'api_key' — отдельный путь роутера (server/clubapi/auth.mjs): Authorization: Bearer blk_…,
// контекст клуба ключа без пользователя, транзакция READ ONLY, право scope, 600 запросов в минуту
// на ключ (keyRateLimit — ещё свой лимит маршрута).

import dns from 'node:dns';
import { HttpError } from '../../server/http/errors.mjs';
import { pepperFrom, SALES_LIMIT } from '../../server/clubapi/auth.mjs';
import { clubapi } from '../../server/clubapi/index.mjs';
import { createKey, listKeys, revokeKey } from '../../server/clubapi/keys.mjs';
import { availabilityOf, bookingsOf, salesOf, tablesNow, tariffsNow } from '../../server/clubapi/read.mjs';
import { DEFAULT_PORTS } from '../../server/clubapi/ssrf.mjs';
import { createWebhook, disableWebhook, listDeliveries, listWebhooks, testWebhook } from '../../server/clubapi/webhooks.mjs';

const OWNER = ['owner'];

/** Выпуск ключей и адресов — только личный вход владельца (не PIN на терминале ресепшена). */
function personal(ctx) {
  if (ctx.principal?.kind !== 'session') throw new HttpError(403, 'forbidden', { detail: 'personal login required' });
}

const read = (scope, fn, extra = {}) => ({
  method: 'GET',
  auth: 'api_key',
  scope,
  ...extra,
  handler: async (ctx, req) => ({ status: 200, json: await fn(ctx, req.query) }),
});

export const routes = [
  // По ключу API ---------------------------------------------------------------------------------
  { path: '/api/v1/club/tables', ...read('tables:read', tablesNow) },
  { path: '/api/v1/club/tariffs', ...read('tariffs:read', tariffsNow) },
  { path: '/api/v1/club/availability', ...read('availability:read', availabilityOf) },
  { path: '/api/v1/club/sales', ...read('sales:read', salesOf, { keyRateLimit: SALES_LIMIT }) },
  { path: '/api/v1/club/bookings', ...read('bookings:read', bookingsOf) },

  // Владелец: ключи ------------------------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/clubs/{club}/api-keys',
    auth: 'staff',
    roles: OWNER,
    handler: async (ctx) => ({ status: 200, json: await listKeys(ctx.db, ctx.club) }),
  },
  {
    method: 'POST',
    path: '/api/clubs/{club}/api-keys',
    auth: 'staff',
    roles: OWNER,
    rateLimit: { max: 20, windowMs: 60_000 },
    async handler(ctx, req) {
      personal(ctx);
      const json = await createKey(ctx.db, { clubId: ctx.club, userId: ctx.user.id, body: req.body, pepper: pepperFrom(ctx.config), audit: ctx.audit, now: ctx.clock.now() });
      return { status: 201, json };
    },
  },
  {
    method: 'POST',
    path: '/api/clubs/{club}/api-keys/{id}/revoke',
    auth: 'staff',
    roles: OWNER,
    handler: async (ctx, req) => ({ status: 200, json: await revokeKey(ctx.db, { clubId: ctx.club, userId: ctx.user.id, keyId: req.params.id, audit: ctx.audit, now: ctx.clock.now() }) }),
  },

  // Владелец: вебхуки ----------------------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/clubs/{club}/webhooks',
    auth: 'staff',
    roles: OWNER,
    handler: async (ctx) => ({ status: 200, json: await listWebhooks(ctx.db, ctx.club) }),
  },
  {
    method: 'POST',
    path: '/api/clubs/{club}/webhooks',
    auth: 'staff',
    roles: OWNER,
    rateLimit: { max: 20, windowMs: 60_000 },
    async handler(ctx, req) {
      personal(ctx);
      const s = clubapi();
      const json = await createWebhook(ctx.db, {
        clubId: ctx.club,
        userId: ctx.user.id,
        body: req.body,
        encKey: ctx.config.encKey,
        audit: ctx.audit,
        lookup: s?.lookup ?? dns.lookup,
        ports: s?.ports ?? DEFAULT_PORTS,
      });
      return { status: 201, json };
    },
  },
  {
    method: 'POST',
    path: '/api/clubs/{club}/webhooks/{id}/disable',
    auth: 'staff',
    roles: OWNER,
    handler: async (ctx, req) => ({ status: 200, json: await disableWebhook(ctx.db, { clubId: ctx.club, userId: ctx.user.id, webhookId: req.params.id, audit: ctx.audit, now: ctx.clock.now() }) }),
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/webhooks/{id}/deliveries',
    auth: 'staff',
    roles: OWNER,
    handler: async (ctx, req) => ({ status: 200, json: await listDeliveries(ctx.db, { clubId: ctx.club, webhookId: req.params.id, query: req.query }) }),
  },
  {
    method: 'POST',
    path: '/api/clubs/{club}/webhooks/{id}/test',
    auth: 'staff',
    roles: OWNER,
    rateLimit: { max: 10, windowMs: 60_000 },
    async handler(ctx, req) {
      const json = await testWebhook(ctx.db, { clubId: ctx.club, webhookId: req.params.id, now: ctx.clock.now() });
      ctx.afterCommit(() => clubapi()?.kick());
      return { status: 202, json };
    },
  },
];
