// Сессии гостя и персонала (контракт M1 §6). Логика — server/sessions/service.mjs (light).
// Клуб сессии определяется по её id (bl.session_club) в транзакции запроса; права —
// участник сессии или персонал клуба. Ошибки — LightError { status, code } → {"error": code}.

import { light } from '../../server/sessions/index.mjs';

const svc = () => light().service;
const userId = (req) => req.user?.id ?? null;

export const routes = [
  {
    method: 'GET',
    path: '/api/sessions/current',
    auth: 'guest',
    async handler(ctx, req) {
      return { status: 200, json: await svc().listCurrent(ctx.db, { userId: userId(req) }) };
    },
  },
  {
    method: 'GET',
    path: '/api/sessions/{id}',
    auth: 'guest',
    async handler(ctx, req) {
      return { status: 200, json: await svc().getSession(ctx.db, { sessionId: req.params.id, userId: userId(req) }) };
    },
  },
  {
    method: 'POST',
    path: '/api/sessions/{id}/join',
    auth: 'guest',
    async handler(ctx, req) {
      // Тело: { code } — код стола из QR (без него session_id из ссылки давал бы вход в чужую игру).
      return { status: 200, json: await svc().join(ctx.db, { sessionId: req.params.id, userId: userId(req), code: req.body?.code }) };
    },
  },
  {
    method: 'POST',
    path: '/api/sessions/{id}/stop',
    auth: 'guest',
    async handler(ctx, req) {
      return { status: 200, json: await svc().stop(ctx.db, { sessionId: req.params.id, userId: userId(req) }) };
    },
  },
  {
    method: 'POST',
    path: '/api/sessions/{id}/resolve',
    auth: 'guest',
    async handler(ctx, req) {
      const choice = req.body?.choice;
      return { status: 200, json: await svc().resolve(ctx.db, { sessionId: req.params.id, userId: userId(req), choice }) };
    },
  },
  {
    method: 'GET',
    path: '/api/sessions/{id}/receipt',
    auth: 'guest',
    async handler(ctx, req) {
      return { status: 200, json: await svc().receipt(ctx.db, { sessionId: req.params.id, userId: userId(req) }) };
    },
  },
  {
    // Ручное действие: причина обязательна, журнал manual.extend_free, тревога владельцу сразу.
    method: 'POST',
    path: '/api/sessions/{id}/extend-free',
    auth: 'staff',
    roles: ['owner', 'manager'],
    async handler(ctx, req) {
      const { minutes, reason_text: reasonText } = req.body ?? {};
      return { status: 200, json: await svc().extendFree(ctx.db, { sessionId: req.params.id, userId: userId(req), minutes, reasonText }) };
    },
  },
];
