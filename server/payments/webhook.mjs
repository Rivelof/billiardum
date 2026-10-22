// Вебхук ЮKassa: POST /api/webhooks/yookassa/{club_id} (контракт M1 §5).
//
// * Телу не верим: из него берётся только object.id (и вид события — какой объект
//   перепроверять). Платёж запрашивается GET /v3/payments/{id} ключами клуба из пути;
//   сверяются сумма, валюта, metadata.club_id и metadata.quote_id (applyRemote).
// * Обработка один раз по provider_payment_id (уникальный индекс, confirmed_at ставится
//   один раз): повтор вебхука — 200 без действий.
// * ЮKassa недоступна или ответила 5xx — 503: ЮKassa повторит вебхук позже.
// * Ответ 200 — платёж обработан, уже был обработан или вебхук не наш (не повторять).
// * Платёж есть у магазина клуба с нашим metadata.payment_id, но строки ещё нет
//   (транзакция создания не закоммичена) — 503: ЮKassa повторит.

import { enterClub, isUuid } from './context.mjs';
import { MoneyError } from './errors.mjs';
import { applyRemote } from './pay.mjs';
import { amountKopecks, YooKassaError } from './yookassa.mjs';
import { clientFor, loadPaymentSettings } from './settings.mjs';

const OBJECT_ID = /^[0-9A-Za-z_-]{1,64}$/;
const OK = { status: 200, json: { ok: true } };
const RETRY = { status: 503, json: { error: 'payment_pending' } };

/**
 * @param {import('pg').PoolClient} db транзакция запроса
 * @returns {Promise<{ status: number, json: object }>}
 */
export async function handleWebhook(db, deps, config, { clubId, body }) {
  if (!isUuid(clubId)) throw new MoneyError('not_found', 'club');
  const objectId = body?.object?.id;
  const event = typeof body?.event === 'string' ? body.event : '';
  if (typeof objectId !== 'string' || !OBJECT_ID.test(objectId)) throw new MoneyError('bad_request', 'object.id');
  await enterClub(db, clubId);
  const settings = await loadPaymentSettings(db, clubId);
  if (!settings.online) throw new MoneyError('not_found', 'магазин клуба');
  const client = clientFor(settings, config);
  const log = deps.log;

  try {
    if (event.startsWith('refund.')) return await refundWebhook(db, deps, client, { clubId, objectId });
    return await paymentWebhook(db, deps, client, { clubId, objectId });
  } catch (err) {
    if (err instanceof YooKassaError) {
      log?.warn?.('webhook_provider_error', { club_id: clubId, status: err.status, code: err.code, retryable: err.retryable });
      if (err.retryable) return RETRY;
      // 404 у ЮKassa: такого объекта у магазина клуба нет — чужой или поддельный вебхук.
      if (err.status === 404) return OK;
      return RETRY;
    }
    throw err;
  }
}

async function paymentWebhook(db, deps, client, { clubId, objectId }) {
  const { rows } = await db.query('select * from bl.payments where provider_payment_id = $1', [objectId]);
  const payment = rows[0];
  if (!payment) {
    // Не наш платёж или наша запись ещё не закоммичена: проверим, есть ли он у магазина клуба.
    // Наш — metadata.club_id этого клуба и наш payment_id (стол и бар) или quote_id (M1):
    // запись ещё не дошла — 503, ЮKassa повторит вебхук.
    const remote = await client.getPayment(objectId);
    const meta = remote?.metadata ?? {};
    if (meta.club_id === clubId && (isUuid(meta.payment_id) || isUuid(meta.quote_id))) {
      deps.log?.warn?.('webhook_payment_not_recorded', { club_id: clubId, payment_id: isUuid(meta.payment_id) ? meta.payment_id : null });
      return RETRY;
    }
    deps.log?.warn?.('webhook_unknown_payment', { club_id: clubId });
    return OK;
  }
  if (payment.status === 'succeeded' && payment.confirmed_at && (payment.capture || payment.captured_at)) {
    return OK; // уже обработан: повтор вебхука без запросов к ЮKassa
  }
  if (payment.status === 'canceled') return OK;
  const remote = await client.getPayment(objectId);
  const r = await applyRemote(db, deps, payment, remote, { source: 'webhook' });
  deps.log?.info?.('webhook_payment', { club_id: clubId, payment_id: payment.id, result: r.result });
  return OK;
}

async function refundWebhook(db, deps, client, { clubId, objectId }) {
  const { rows } = await db.query(
    `select f.*, p.provider_payment_id from bl.refunds f join bl.payments p on p.id = f.payment_id
      where f.provider_refund_id = $1`,
    [objectId],
  );
  const refund = rows[0];
  if (!refund) {
    deps.log?.warn?.('webhook_unknown_refund', { club_id: clubId });
    return OK;
  }
  if (refund.status === 'succeeded' || refund.status === 'canceled') return OK;
  const remote = await client.getRefund(objectId);
  const amount = amountKopecks(remote?.amount);
  if (remote?.id !== objectId || remote?.payment_id !== refund.provider_payment_id || amount !== Number(refund.amount_kopecks)) {
    deps.log?.error?.('refund_mismatch', { club_id: clubId, refund_id: refund.id });
    await deps.alarms.raise(db, clubId, { type: 'refund_mismatch', level: 'critical', data: { refund_id: refund.id } });
    return OK;
  }
  const { applyRefundStatus } = await import('./api.mjs');
  await applyRefundStatus(db, deps, refund, remote.status);
  return OK;
}
