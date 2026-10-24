// Вебхук магазина ЮKassa платформы: POST /api/webhooks/yookassa-platform (M5.3 №183).
//
// * Телу не верим: из него берётся только object.id. Платёж запрашивается GET /v3/payments/{id}
//   ключами магазина платформы и сверяется с нашей записью (applyRemote: id, billing_payment_id
//   и клуб в metadata, сумма, магазин). Поддельный вебхук ничего не меняет.
// * Обработка один раз по provider_payment_id (уникальный индекс): итог платежа применяется
//   один раз, счёт оплачивается один раз (bl.billing_settle_invoice) — двойной вебхук даёт одно
//   списание и одно продление.
// * Магазин платформы не знает платежей гостей и наоборот: платёж гостя по этому адресу — 404 у
//   магазина платформы → 200 без действий; платёж платформы по адресу клуба — 404 у магазина клуба.
// * 503 — ЮKassa повторит: магазин платформы не ответил, или наша запись ещё не закоммичена.

import { platformClient, isUuid, syncPayment } from './core.mjs';
import { YooKassaError } from '../payments/yookassa.mjs';

const OBJECT_ID = /^[0-9A-Za-z_-]{1,64}$/;
const OK = { status: 200, json: { ok: true } };
const RETRY = { status: 503, json: { error: 'payment_pending' } };

/**
 * @param {import('pg').PoolClient} db транзакция запроса в контексте платформы (actor system)
 * @returns {Promise<{ status: number, json: object }>}
 */
export async function handlePlatformWebhook(db, deps, config, { body }) {
  if (!config?.configured) return { status: 503, json: { error: 'billing_unavailable' } };
  const objectId = body?.object?.id;
  const event = typeof body?.event === 'string' ? body.event : '';
  if (typeof objectId !== 'string' || !OBJECT_ID.test(objectId)) return { status: 400, json: { error: 'bad_request' } };
  // Возвратов платформа не делает: событие возврата — не наше.
  if (!event.startsWith('payment.')) return OK;
  const now = deps.clock.now();
  try {
    const { rows } = await db.query('select id from bl.billing_payments where provider_payment_id = $1', [objectId]);
    if (!rows[0]) {
      // Нашей записи нет: платёж магазина платформы с нашим billing_payment_id — запись ещё не
      // закоммичена (503, ЮKassa повторит); иначе — не наш платёж.
      const remote = await platformClient(config).getPayment(objectId);
      const meta = remote?.metadata ?? {};
      if (meta.kind === 'subscription' && isUuid(meta.billing_payment_id)) {
        deps.log?.warn?.('billing_webhook_not_recorded', { payment_id: meta.billing_payment_id });
        return RETRY;
      }
      deps.log?.warn?.('billing_webhook_unknown', {});
      return OK;
    }
    const result = await syncPayment(db, deps, config, rows[0].id, { via: 'webhook', now, webhook: true });
    deps.log?.info?.('billing_webhook', { payment_id: rows[0].id, result });
    return OK;
  } catch (err) {
    if (err instanceof YooKassaError) {
      deps.log?.warn?.('billing_webhook_provider_error', { status: err.status, code: err.code, retryable: err.retryable });
      // 404: у магазина платформы такого платежа нет — чужой или поддельный вебхук.
      if (err.status === 404) return OK;
      return RETRY;
    }
    throw err;
  }
}
