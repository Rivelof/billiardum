// Вебхук ЮKassa (контракт M1 §5, backend-money).
//   POST /api/webhooks/yookassa/{club_id} — без входа; телу не верим, платёж перепроверяется
//   GET /v3/payments/{id} ключами клуба. 200 — обработан или уже был; 503 — ЮKassa повторит.
//   POST /api/webhooks/yookassa-platform — магазин платформы (подписка клубов, M5.3 №183):
//   перепроверка ключами платформы из .env (server/billing/webhook.mjs).

import { handleWebhook } from '../../server/payments/webhook.mjs';
import { moneyRoute } from '../../server/payments/route.mjs';
import { billingConfig } from '../../server/billing/config.mjs';
import { handlePlatformWebhook } from '../../server/billing/webhook.mjs';

export const routes = [
  {
    method: 'POST',
    path: '/api/webhooks/yookassa/{club_id}',
    auth: 'none',
    // Контекст платформы: клуб — из пути, после перепроверки магазина клуба.
    actor: 'system',
    handler: moneyRoute(({ db, deps, info, config }) =>
      handleWebhook(db, deps, config, { clubId: info.params.club_id, body: info.body }),
    ),
  },
  {
    method: 'POST',
    path: '/api/webhooks/yookassa-platform',
    auth: 'none',
    // Контекст платформы (system без клуба): итог платежа и paid_until пишет только он.
    actor: 'system',
    handler: (ctx, req) => handlePlatformWebhook(ctx.db, { log: ctx.log, clock: ctx.clock }, billingConfig(ctx), { body: req.body }),
  },
];
