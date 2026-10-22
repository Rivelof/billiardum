// Привязка контроллера (protocol v1 §7, контракт M1 §6). Логика — server/devices/bind.mjs.
//
// POST /api/clubs/{club}/devices/bind — владелец или монтажник, {device_id, resource_id, claim_code}:
//   claim_code с наклейки на корпусе (QR: device_id и код). В базе — только sha256.
// POST /api/devices/claim — контроллер без входа, {device_id, claim_code}: ключи один раз.

import { light } from '../../server/sessions/index.mjs';

export const routes = [
  {
    method: 'POST',
    path: '/api/clubs/{club}/devices/bind',
    auth: 'staff',
    roles: ['owner', 'installer'],
    async handler(ctx, req) {
      const { device_id: deviceId, resource_id: resourceId, claim_code: claimCode } = req.body ?? {};
      return {
        status: 200,
        json: await light().binding.bind(ctx.db, { clubId: req.params.club, userId: req.user?.id ?? null, deviceId, resourceId, claimCode }),
      };
    },
  },
  {
    method: 'POST',
    path: '/api/devices/claim',
    auth: 'none',
    rateLimit: { max: 10, windowMs: 60_000 },
    async handler(ctx, req) {
      const { device_id: deviceId, claim_code: claimCode } = req.body ?? {};
      return { status: 200, json: await light().binding.claim(ctx.db, { deviceId, claimCode }) };
    },
  },
];
