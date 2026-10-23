// Заявки клубов на программу (M4 §1 п. 6, §4) и заказ комплекта контроллеров (kind: 'kit', M5.1 №159). Логика — server/directory/leads.mjs (backend-directory).
// POST без входа: пишет в контексте платформы (actor: system), антиспам — лимит по IP (роутер и
// база), скрытое поле и время заполнения. Экран воронки — оператор и администратор платформы.

import { directory } from '../../server/directory/index.mjs';

const OPERATOR = ['platform_operator', 'platform_admin'];

export const routes = [
  {
    method: 'POST',
    path: '/api/leads',
    auth: 'none',
    actor: 'system',
    rateLimit: { max: 5, windowMs: 10 * 60_000 },
    async handler(ctx, req) {
      return { status: 201, json: await directory().leads.create(ctx.db, { body: req.body, ip: req.ip }) };
    },
  },
  {
    method: 'GET',
    path: '/api/platform/leads',
    auth: 'platform',
    roles: OPERATOR,
    async handler(ctx, req) {
      return { status: 200, json: await directory().leads.list(ctx.db, { status: req.query.status, kind: req.query.kind }) };
    },
  },
  {
    method: 'PATCH',
    path: '/api/platform/leads/{id}',
    auth: 'platform',
    roles: OPERATOR,
    async handler(ctx, req) {
      return { status: 200, json: await directory().leads.patch(ctx.db, { id: req.params.id, body: req.body, operatorId: req.user?.id ?? null }) };
    },
  },
];
