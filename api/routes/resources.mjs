// Стол: сервисный свет, «найти стол», зал (контракт M1 §6). Логика — server/sessions (light).
// Клуб ресурса — по его id (bl.resource_club); роли перепроверяются в клубе ресурса.

import { light } from '../../server/sessions/index.mjs';

const svc = () => light().service;
const userId = (req) => req.user?.id ?? null;

export const routes = [
  {
    // Ручное действие: reason_code и reason_text обязательны (reason_required), предел минут —
    // clubs.settings.service_max_minutes (по умолчанию 30), журнал service.start, тревога владельцу.
    method: 'POST',
    path: '/api/resources/{id}/service',
    auth: 'staff',
    roles: ['owner', 'manager', 'reception'],
    async handler(ctx, req) {
      const { minutes, reason_code: reasonCode, reason_text: reasonText } = req.body ?? {};
      return {
        status: 200,
        json: await svc().serviceStart(ctx.db, { resourceId: req.params.id, userId: userId(req), minutes, reasonCode, reasonText }),
      };
    },
  },
  {
    method: 'POST',
    path: '/api/resources/{id}/service/stop',
    auth: 'staff',
    roles: ['owner', 'manager', 'reception'],
    async handler(ctx, req) {
      const reasonText = req.body?.reason_text ?? null;
      return { status: 200, json: await svc().serviceStop(ctx.db, { resourceId: req.params.id, userId: userId(req), reasonText }) };
    },
  },
  {
    method: 'POST',
    path: '/api/resources/{id}/identify',
    auth: 'staff',
    roles: ['owner', 'installer', 'manager'],
    async handler(ctx, req) {
      return { status: 200, json: await svc().identify(ctx.db, { resourceId: req.params.id, userId: userId(req), seconds: req.body?.seconds }) };
    },
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/hall',
    auth: 'staff',
    roles: ['owner', 'manager', 'reception', 'installer'],
    async handler(ctx, req) {
      return { status: 200, json: await svc().hall(ctx.db, { clubId: req.params.club, userId: userId(req) }) };
    },
  },
];
