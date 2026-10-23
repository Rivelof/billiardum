// Привязка контроллера (protocol v1 §7, контракт M1 §6). Логика — server/devices/bind.mjs.
//
// POST /api/clubs/{club}/devices/bind — владелец или монтажник, {device_id, resource_id, claim_code}
//   или {qr: 'BLD1:{device_id}:{claim_code}', resource_id} (M5.1 №159; неверный QR — 400 qr_invalid):
//   claim_code с наклейки на корпусе. В базе — только sha256. Ответ {bind_until, device_id}.
// POST /api/devices/claim — контроллер без входа, {device_id, claim_code}: ключи один раз.
//   Лимиты: 60 в минуту с IP и 6 в минуту на device_id (429 rate_limited, Retry-After).

import { HttpError } from '../../server/http/errors.mjs';
import { createRateLimiter } from '../../server/http/rate-limit.mjs';
import { isUuid } from '../../server/lib/store.mjs';
import { light } from '../../server/sessions/index.mjs';

/** claim: с одного IP (NAT клуба) — 60 в минуту; на одно устройство — 6 в минуту (protocol §7). */
export const CLAIM_IP_LIMIT = Object.freeze({ max: 60, windowMs: 60_000 });
export const CLAIM_DEVICE_LIMIT = Object.freeze({ max: 6, windowMs: 60_000 });
const claimPerDevice = createRateLimiter();

export const routes = [
  {
    method: 'POST',
    path: '/api/clubs/{club}/devices/bind',
    auth: 'staff',
    roles: ['owner', 'installer'],
    async handler(ctx, req) {
      const { device_id: deviceId, resource_id: resourceId, claim_code: claimCode, qr } = req.body ?? {};
      const out = await light().binding.bind(ctx.db, { clubId: req.params.club, userId: req.user?.id ?? null, deviceId, resourceId, claimCode, qr });
      // Неверный код заводского устройства: 403 с фиксацией счётчика попыток (M5.1 №159).
      if (out?.__response) return out.__response;
      return { status: 200, json: out };
    },
  },
  {
    // Лимит по IP широкий: все контроллеры клуба выходят через один NAT, после сбоя питания
    // приходят разом. Перебор кода держат лимит по device_id и 5 неверных попыток на окно (№67).
    method: 'POST',
    path: '/api/devices/claim',
    auth: 'none',
    rateLimit: CLAIM_IP_LIMIT,
    async handler(ctx, req) {
      const { device_id: deviceId, claim_code: claimCode } = req.body ?? {};
      if (typeof deviceId === 'string' && isUuid(deviceId.toLowerCase())) {
        const hit = claimPerDevice.hit(`claim:${deviceId.toLowerCase()}`, CLAIM_DEVICE_LIMIT);
        if (!hit.ok) throw new HttpError(429, 'rate_limited', { headers: { 'retry-after': String(hit.retryAfterSec) }, detail: 'claim per device' });
      }
      return { status: 200, json: await light().binding.claim(ctx.db, { deviceId, claimCode }) };
    },
  },
];
