// ККТ клуба (контракт M2 §4, backend-kkt; decisions №77, №78, №84).
//   POST /api/clubs/{club}/kkt/bridges          — владелец: {name, kkt_model?} → {bridge, token} (токен один раз)
//   GET  /api/clubs/{club}/kkt/bridges          — владелец, управляющий: мосты клуба
//   POST /api/kkt/bridges/{id}/revoke           — владелец: токен перестаёт действовать, соединение закрывается
//   GET  /api/clubs/{club}/kkt/status           — ресепшн и выше: {state, reason, bridges, queue} (то же — SSE kkt)
//   GET  /api/clubs/{club}/kkt/receipts?status= — ресепшн и выше: open | pending | unknown | failed | printed
//   POST /api/kkt/receipts/{id}/retry           — управляющий и выше: {reason} — чек с ошибкой или с неизвестным исходом снова в очередь
//   POST /api/kkt/receipts/{id}/mark-printed    — управляющий и выше: {fd, fp, fn?, reason} — чек с неизвестным исходом нашли на ККТ
// WebSocket /api/kkt/ws (мост) — не маршрут роутера: событие upgrade HTTP-сервера, server/kkt/ws.mjs.

import { ROLES } from '../router.mjs';
import { getReceipt, listReceipts, markPrinted, retryReceipt } from '../../server/kkt/api.mjs';
import { listBridges, registerBridge, revokeBridge } from '../../server/kkt/bridges.mjs';
import { kick, kktService } from '../../server/kkt/index.mjs';
import { queueSummary } from '../../server/kkt/queue.mjs';
import { HttpError } from '../../server/http/errors.mjs';

const exists = (table) => async (db, req) => {
  const { rowCount } = await db.query(`select 1 from bl.${table} where id = $1`, [req.params.id]);
  return rowCount > 0;
};

function deps(ctx) {
  return { audit: ctx.audit, alarms: ctx.alarms, outbox: ctx.outbox, log: ctx.log, clock: ctx.clock };
}

export const routes = [
  {
    method: 'POST',
    path: '/api/clubs/{club}/kkt/bridges',
    auth: 'staff',
    roles: [...ROLES.OWNER],
    handler: async (ctx, req) => ({
      status: 201,
      json: await registerBridge(ctx.db, deps(ctx), { clubId: ctx.club, userId: req.user.id, body: req.body, now: ctx.clock.now() }),
    }),
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/kkt/bridges',
    auth: 'staff',
    roles: [...ROLES.MANAGER_UP],
    handler: async (ctx) => ({ json: await listBridges(ctx.db, { clubId: ctx.club, isOnline: (id) => Boolean(kktService()?.isOnline(id)) }) }),
  },
  {
    method: 'POST',
    path: '/api/kkt/bridges/{id}/revoke',
    auth: 'staff',
    roles: [...ROLES.OWNER],
    findClub: exists('kkt_bridges'),
    handler: async (ctx, req) => {
      const out = await revokeBridge(ctx.db, deps(ctx), { bridgeId: req.params.id, userId: req.user.id, now: ctx.clock.now() });
      ctx.afterCommit(() => {
        kktService()?.disconnectBridge(req.params.id, 4001);
        kick(ctx.club);
      });
      return { json: out };
    },
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/kkt/status',
    auth: 'staff',
    roles: [...ROLES.RECEPTION_UP],
    handler: async (ctx) => {
      const service = kktService();
      if (service) return { json: await service.statusOf(ctx.db, ctx.club) };
      return { json: { state: 'offline', reason: 'not_running', bridges: [], queue: await queueSummary(ctx.db, ctx.club) } };
    },
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/kkt/receipts',
    auth: 'staff',
    roles: [...ROLES.RECEPTION_UP],
    handler: async (ctx, req) => ({ json: await listReceipts(ctx.db, { clubId: ctx.club, status: req.query.status ?? 'open', limit: req.query.limit }) }),
  },
  {
    method: 'POST',
    path: '/api/kkt/receipts/{id}/retry',
    auth: 'staff',
    roles: [...ROLES.MANAGER_UP],
    findClub: exists('receipts'),
    handler: async (ctx, req) => {
      if (!(await getReceipt(ctx.db, req.params.id))) throw new HttpError(404, 'not_found');
      return { json: await retryReceipt(ctx.db, deps(ctx), { id: req.params.id, userId: req.user.id, reason: req.body?.reason, now: ctx.clock.now() }) };
    },
  },
  {
    method: 'POST',
    path: '/api/kkt/receipts/{id}/mark-printed',
    auth: 'staff',
    roles: [...ROLES.MANAGER_UP],
    findClub: exists('receipts'),
    handler: async (ctx, req) => {
      const b = req.body ?? {};
      if (!(await getReceipt(ctx.db, req.params.id))) throw new HttpError(404, 'not_found');
      return {
        json: await markPrinted(ctx.db, deps(ctx), { id: req.params.id, userId: req.user.id, reason: b.reason, fd: b.fd, fp: b.fp, fn: b.fn ?? null, now: ctx.clock.now() }),
      };
    },
  },
];
