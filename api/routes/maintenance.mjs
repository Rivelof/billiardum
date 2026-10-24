// Обслуживание столов (M5.6 №198) — владелец и управляющий; ресепшн и бар — 403.
//   GET  /api/clubs/{club}/maintenance?resource_id&kind&limit   → { thresholds, defaults, kinds, counters, events }
//   POST /api/clubs/{club}/maintenance                           {resource_id, kind, date?, comment?, cost_kopecks?,
//                                                                 corrects_id?, reason?, void?} → событие (201), Idempotency-Key
//   GET  /api/clubs/{club}/maintenance/thresholds                → { thresholds, defaults }
//   PUT  /api/clubs/{club}/maintenance/thresholds                {cloth?, balls?, cushions?, leveling?, other?} → { thresholds, defaults }
// Ошибки: 400 bad_request (поле — в логе), 400 reason_required (исправление без причины), 401, 403, 404 (стол или
// исправляемое событие не этого клуба), 409 duplicate (событие уже исправлено).

import { ROLES } from '../router.mjs';
import { HttpError } from '../../server/http/errors.mjs';
import { loadClub } from '../../server/dashboard/store.mjs';
import { addEvent, DEFAULT_THRESHOLDS, maintenanceView, setThresholds, thresholdsOf } from '../../server/maintenance/service.mjs';

const MANAGER = [...ROLES.MANAGER_UP];
const RATE = { max: 120, windowMs: 60_000 };

async function club(ctx) {
  const c = await loadClub(ctx.db, ctx.club);
  if (!c) throw new HttpError(404, 'not_found');
  return c;
}

export const routes = [
  {
    method: 'GET',
    path: '/api/clubs/{club}/maintenance',
    auth: 'staff',
    roles: MANAGER,
    rateLimit: RATE,
    handler: async (ctx, req) => ({ json: await maintenanceView(ctx.db, await club(ctx), { query: req.query, now: ctx.clock.now() }) }),
  },
  {
    method: 'POST',
    path: '/api/clubs/{club}/maintenance',
    auth: 'staff',
    roles: MANAGER,
    idempotent: true,
    rateLimit: RATE,
    handler: async (ctx, req) => ({ status: 201, json: await addEvent(ctx.db, { club: await club(ctx), userId: req.user.id, body: req.body, now: ctx.clock.now() }) }),
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/maintenance/thresholds',
    auth: 'staff',
    roles: MANAGER,
    rateLimit: RATE,
    handler: async (ctx) => ({ json: { thresholds: thresholdsOf((await club(ctx)).settings), defaults: { ...DEFAULT_THRESHOLDS } } }),
  },
  {
    method: 'PUT',
    path: '/api/clubs/{club}/maintenance/thresholds',
    auth: 'staff',
    roles: MANAGER,
    rateLimit: { max: 30, windowMs: 60_000 },
    handler: async (ctx, req) => ({ json: await setThresholds(ctx.db, { club: await club(ctx), userId: req.user.id, body: req.body }) }),
  },
];
