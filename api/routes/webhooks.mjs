// Вебхук ЮKassa (контракт M1 §5, backend-money).
//   POST /api/webhooks/yookassa/{club_id} — без входа; телу не верим, платёж перепроверяется
//   GET /v3/payments/{id} ключами клуба. 200 — обработан или уже был; 503 — ЮKassa повторит.

import { handleWebhook } from '../../server/payments/webhook.mjs';
import { moneyRoute } from '../../server/payments/route.mjs';

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
];
