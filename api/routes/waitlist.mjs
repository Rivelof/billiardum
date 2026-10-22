// Лист ожидания (контракт M3 §4, решение №109). Логика — server/waitlist/service.mjs (backend-booking).

import { waitlist } from '../../server/waitlist/index.mjs';

const svc = () => waitlist().service;
const userId = (req) => req.user?.id ?? null;

export const routes = [
  {
    method: 'POST',
    path: '/api/waitlist',
    auth: 'guest',
    requires: ['consent'],
    rateLimit: { max: 30, windowMs: 60_000 },
    async handler(ctx, req) {
      return { status: 201, json: await svc().join(ctx.db, { userId: userId(req), body: req.body }) };
    },
  },
  {
    method: 'GET',
    path: '/api/me/waitlist',
    auth: 'guest',
    async handler(ctx, req) {
      return { status: 200, json: await svc().listMine(ctx.db, { userId: userId(req) }) };
    },
  },
  {
    method: 'DELETE',
    path: '/api/waitlist/{id}',
    auth: 'guest',
    async handler(ctx, req) {
      return { status: 200, json: await svc().leave(ctx.db, { userId: userId(req), id: req.params.id }) };
    },
  },
  {
    method: 'POST',
    path: '/api/waitlist/{id}/accept',
    auth: 'guest',
    requires: ['consent'],
    async handler(ctx, req) {
      return svc().accept(ctx.db, { userId: userId(req), id: req.params.id });
    },
  },
];
