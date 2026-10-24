// Ядро подписки клубов (M5.3 №181–184): магазин ЮKassa платформы, чек, применение ответа ЮKassa
// к платежу, оплата счёта, неудача списания и уведомления.
//
// Контексты транзакций:
//   * вебхук и планировщик — контекст платформы (system без клуба, bl.ctx_is_platform()):
//     только он пишет итог платежа, карту и paid_until (через bl.billing_settle_invoice);
//   * уведомления персоналу клуба — на время отправки контекст клуба (setContext), затем обратно.
// Порядок блокировок везде один: подписка клуба → платёж → счёт (без взаимных блокировок вебхука
// и планировщика).

import { createHash } from 'node:crypto';
import { formatDate, formatMoney, plural } from '@billiardum/shared/format';
import { HttpError } from '../http/errors.mjs';
import { appendAudit } from '../lib/audit.mjs';
import { decryptSecret, encryptSecret } from '../lib/secrets.mjs';
import { setContext } from '../lib/store.mjs';
import { sendPlatform, sendToClubStaff } from '../notify/index.mjs';
import { amountKopecks, createYooKassaClient, formatValue, YooKassaError } from '../payments/yookassa.mjs';
import { nextAttemptAt } from './period.mjs';

export const RECEIPT_ITEM = 'Подписка на программу «Бильярдум»';
export const BIND_AMOUNT_KOPECKS = 100;
export const STAFF_ROLES = Object.freeze(['owner', 'manager']);
const STATUS = new Set(['pending', 'waiting_for_capture', 'succeeded', 'canceled']);
const RECEIPT_STATUS = new Set(['pending', 'succeeded', 'canceled']);
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (v) => typeof v === 'string' && UUID.test(v);
const iso = (v) => (v instanceof Date ? v.toISOString() : (v ?? null));

export const unavailable = () => new HttpError(503, 'billing_unavailable');

/** Клиент ЮKassa с ключами магазина платформы; пары нет — 503 billing_unavailable. */
export function platformClient(config, { fetch } = {}) {
  if (!config?.configured || !config.secret) throw unavailable();
  return createYooKassaClient({ apiUrl: config.apiUrl, shopId: config.shopId, secretKey: config.secret, timeoutMs: config.timeoutMs, fetch: fetch ?? config.fetch });
}

/** Чек 54-ФЗ платформы (№183): одна услуга «Подписка на программу „Бильярдум“», email владельца. */
export function platformReceipt({ email, amountKopecks: amount, config }) {
  if (typeof email !== 'string' || !email) throw new Error('нет email для чека подписки');
  const receipt = {
    customer: { email },
    items: [
      {
        description: RECEIPT_ITEM,
        quantity: 1,
        amount: { value: formatValue(amount), currency: 'RUB' },
        vat_code: config.vatCode ?? 1,
        payment_mode: 'full_payment',
        payment_subject: 'service',
      },
    ],
  };
  if (config.taxSystemCode != null) receipt.tax_system_code = config.taxSystemCode;
  return receipt;
}

/** UUID из строки (одинаковый при повторе): платёж автосписания — по счёту и номеру попытки. */
export function stableUuid(seed) {
  const h = createHash('sha256').update(`bl.billing/${seed}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Ключ идемпотентности ЮKassa автосписания: счёт и попытка (повтор после сбоя — тот же ключ). */
export const chargeKey = (invoiceId, attempt) => `bl-sub-${invoiceId}-${attempt}`;

// Способ оплаты (№23: id способа ЮKassa — только зашифрованным) ----------------------------------

export const methodContext = (clubId) => `billing_method/${clubId}`;

export function encryptMethod(methodId, encKey, clubId) {
  if (!encKey) throw new Error('нет SECRETS_ENC_KEY для способа оплаты подписки');
  return encryptSecret(methodId, encKey, methodContext(clubId));
}

export function decryptMethod(enc, encKey, clubId) {
  if (!encKey) throw new Error('нет SECRETS_ENC_KEY для способа оплаты подписки');
  return decryptSecret(enc, encKey, methodContext(clubId)).toString('utf8');
}

/** Маска карты из payment_method ЮKassa: только последние 4 цифры, тип, срок. */
export function cardOf(method) {
  const c = method?.card ?? {};
  const last4 = typeof c.last4 === 'string' && /^\d{4}$/.test(c.last4) ? c.last4 : null;
  return {
    last4,
    card_type: typeof c.card_type === 'string' ? c.card_type.slice(0, 40) : null,
    expiry_month: typeof c.expiry_month === 'string' && /^\d{2}$/.test(c.expiry_month) ? c.expiry_month : null,
    expiry_year: typeof c.expiry_year === 'string' && /^\d{4}$/.test(c.expiry_year) ? c.expiry_year : null,
  };
}

/** Карта в ответе API: {mask: '•• 4477', type, expiry: '12/30'} или null. */
export function cardJson(card) {
  if (!card) return null;
  return {
    mask: card.last4 ? `•• ${card.last4}` : '••',
    type: card.card_type ?? null,
    expiry: card.expiry_month && card.expiry_year ? `${card.expiry_month}/${card.expiry_year.slice(2)}` : null,
  };
}

// Чтение ------------------------------------------------------------------------------------------

export async function lockSubscription(db, clubId) {
  const { rows } = await db.query('select * from bl.club_subscriptions where club_id = $1 for update', [clubId]);
  return rows[0] ?? null;
}

export async function ensureSubscription(db, clubId) {
  await db.query('select bl.billing_ensure_subscription($1)', [clubId]);
}

export async function planOf(db, planId) {
  const { rows } = await db.query('select * from bl.billing_plans where id = $1', [planId]);
  return rows[0] ?? null;
}

export async function defaultPlan(db) {
  const { rows } = await db.query("select * from bl.billing_plans where code = 'club'");
  return rows[0];
}

export async function openInvoice(db, clubId) {
  const { rows } = await db.query("select * from bl.billing_invoices where club_id = $1 and status = 'open' order by period_start limit 1", [clubId]);
  return rows[0] ?? null;
}

/** Клуб для подписки (контекст платформы): название, город, пояс, режим, столы в работе. */
export async function billingClub(db, clubId) {
  const { rows } = await db.query('select * from bl.billing_clubs() where club_id = $1', [clubId]);
  return rows[0] ?? null;
}

// Уведомления -------------------------------------------------------------------------------------

/** Уведомление владельцу и управляющему клуба (в контексте клуба на время отправки). */
export async function notifyClub(db, clubId, msg, { roles = STAFF_ROLES, restore = null } = {}) {
  await setContext(db, { clubId });
  try {
    await sendToClubStaff(db, clubId, roles, { level: 'important', ...msg, data: { club_id: clubId, url: '/club/subscription', ...(msg.data ?? {}) } });
  } finally {
    await setContext(db, { clubId: restore });
  }
}

export const rub = (kopecks) => formatMoney(Number(kopecks));
export const dayWord = (n) => `${n} ${plural(n, ['день', 'дня', 'дней'])}`;

// Применение ответа ЮKassa к платежу платформы ---------------------------------------------------

function errorCode(remote) {
  const reason = remote?.cancellation_details?.reason;
  return typeof reason === 'string' && CODE.test(reason) ? reason : 'declined';
}

/** Сохранить способ оплаты из платежа: автоплатёж включён, карта — маской (контекст платформы). */
async function saveMethod(db, deps, config, pay, remote, now) {
  const method = remote?.payment_method;
  if (!method?.saved || typeof method.id !== 'string' || !/^[0-9A-Za-z_-]{1,64}$/.test(method.id)) return false;
  const card = cardOf(method);
  await db.query(
    `update bl.club_subscriptions
        set autopay = true, payment_method_enc = $2, card = $3::jsonb, card_saved_at = $4, card_saved_by = $5,
            receipt_email = coalesce($6, receipt_email), updated_at = $4
      where club_id = $1`,
    [pay.club_id, encryptMethod(method.id, config.encKey, pay.club_id), JSON.stringify(card), now, pay.created_by, pay.receipt_email],
  );
  await db.query('update bl.billing_payments set method_saved = true, updated_at = $2 where id = $1', [pay.id, now]);
  // Счёт без попытки из-за отсутствия карты — списать в ближайший проход планировщика.
  await db.query(
    "update bl.billing_invoices set next_attempt_at = $2, last_error = null, updated_at = $2 where club_id = $1 and status = 'open' and next_attempt_at is null and last_error = 'card_required'",
    [pay.club_id, now],
  );
  await appendAudit(db, { action: 'billing.card_saved', objectType: 'club', objectId: pay.club_id, data: { club_id: pay.club_id, payment_id: pay.id, last4: card.last4 } });
  deps.log?.info?.('billing_card_saved', { club_id: pay.club_id, payment_id: pay.id });
  return card;
}

/**
 * Неудачная попытка автосписания n: повтор через 1 и 3 дня после первой неудачи (№184),
 * плашка и уведомление владельцу и управляющему. Отзыв разрешения на списание — карта забывается.
 */
export async function recordFailure(db, deps, { invoice, attempt, error, now }) {
  const first = invoice.first_failed_at ?? now;
  const next = nextAttemptAt(first, attempt);
  await db.query(
    'update bl.billing_invoices set attempts = $2, first_failed_at = $3, next_attempt_at = $4, last_error = $5, updated_at = $6 where id = $1',
    [invoice.id, attempt, first, next, error, now],
  );
  if (error === 'permission_revoked') {
    await db.query(
      'update bl.club_subscriptions set autopay = false, payment_method_enc = null, card = null, card_saved_at = null, card_saved_by = null, updated_at = $2 where club_id = $1',
      [invoice.club_id, now],
    );
  }
  await appendAudit(db, {
    action: 'billing.payment_failed',
    objectType: 'billing_invoice',
    objectId: invoice.id,
    data: { club_id: invoice.club_id, invoice_id: invoice.id, attempt, error, next_attempt_at: iso(next) },
  });
  const club = await billingClub(db, invoice.club_id);
  const tz = club?.timezone ?? 'Europe/Moscow';
  const sum = rub(invoice.amount_kopecks);
  const text = next
    ? `Не удалось списать ${sum} за подписку «Бильярдум». Повторим ${formatDate(next, tz)}. Проверьте карту или привяжите другую в разделе «Подписка».`
    : `Не удалось списать ${sum} за подписку «Бильярдум». Автоматических попыток больше не будет — оплатите счёт картой в разделе «Подписка». Свет и игры работают как обычно.`;
  await notifyClub(db, invoice.club_id, { kind: 'billing.payment_failed', level: 'important', text, data: { invoice_id: invoice.id } });
  deps.log?.warn?.('billing_payment_failed', { club_id: invoice.club_id, invoice_id: invoice.id, attempt, error });
}

/** Счёт оплачен: paid_until продлён (один раз), журнал платформы, уведомление владельцу. */
async function invoicePaid(db, deps, { pay, now }) {
  const { rows } = await db.query('select bl.billing_settle_invoice($1, $2, $3, null, null, $4) as done', [pay.invoice_id, 'card', pay.id, now]);
  const { rows: inv } = await db.query('select * from bl.billing_invoices where id = $1', [pay.invoice_id]);
  const invoice = inv[0];
  if (!rows[0].done) {
    // Счёт уже оплачен другим платежом (или вручную): деньги пришли дважды — вернуть решает Андрей.
    deps.log?.error?.('billing_double_payment', { club_id: pay.club_id, invoice_id: pay.invoice_id, payment_id: pay.id });
    await appendAudit(db, { action: 'billing.double_payment', objectType: 'billing_payment', objectId: pay.id, data: { club_id: pay.club_id, invoice_id: pay.invoice_id, amount_kopecks: Number(pay.amount_kopecks) } });
    await sendPlatform(db, {
      role: 'platform_admin',
      kind: 'platform.billing_double_payment',
      level: 'important',
      text: `Подписка: счёт клуба уже был оплачен, а пришла ещё одна оплата ${rub(pay.amount_kopecks)}. Проверьте и при необходимости верните деньги в кабинете ЮKassa.`,
      data: { club_id: pay.club_id, invoice_id: pay.invoice_id },
    });
    return false;
  }
  await appendAudit(db, {
    action: 'billing.invoice_paid',
    objectType: 'billing_invoice',
    objectId: invoice.id,
    data: { club_id: invoice.club_id, invoice_id: invoice.id, payment_id: pay.id, via: 'card', amount_kopecks: Number(invoice.amount_kopecks), period_start: invoice.period_start, period_end: invoice.period_end },
  });
  const club = await billingClub(db, invoice.club_id);
  const tz = club?.timezone ?? 'Europe/Moscow';
  await notifyClub(db, invoice.club_id, {
    kind: 'billing.payment_succeeded',
    level: 'info',
    text: `Подписка «Бильярдум» оплачена: ${rub(invoice.amount_kopecks)}, до ${formatDate(invoice.period_end_at, tz)}. Чек отправлен на почту.`,
    data: { invoice_id: invoice.id },
  }, { roles: ['owner'] });
  deps.log?.info?.('billing_invoice_paid', { club_id: invoice.club_id, invoice_id: invoice.id, via: 'card' });
  return true;
}

/**
 * Применить состояние платежа в магазине платформы к нашей записи (контекст платформы, строка
 * платежа заблокирована). Сверяются id, наш billing_payment_id и клуб в metadata, сумма и магазин:
 * чужой или подменённый платёж ничего не меняет. Итог применяется один раз.
 * @returns {Promise<string>} 'pending' | 'succeeded' | 'canceled' | 'bound' | 'already' | 'mismatch'
 */
export async function applyRemote(db, deps, config, pay, remote, { via, now, client }) {
  const meta = remote?.metadata ?? {};
  const recipient = remote?.recipient?.account_id;
  if (
    remote?.id !== pay.provider_payment_id || meta.billing_payment_id !== pay.id || meta.club_id !== pay.club_id ||
    amountKopecks(remote?.amount) !== Number(pay.amount_kopecks) || (recipient !== undefined && recipient !== config.shopId) || !STATUS.has(remote?.status)
  ) {
    deps.log?.error?.('billing_payment_mismatch', { club_id: pay.club_id, payment_id: pay.id });
    await db.query('update bl.billing_payments set checked_at = $2, updated_at = $2 where id = $1', [pay.id, now]);
    return 'mismatch';
  }
  const receipt = RECEIPT_STATUS.has(remote.receipt_registration) ? remote.receipt_registration : null;
  if (pay.status === 'succeeded' || pay.status === 'canceled') {
    await db.query('update bl.billing_payments set receipt_status = coalesce($2, receipt_status), checked_at = $3, updated_at = $3 where id = $1', [pay.id, receipt, now]);
    return 'already';
  }
  const status = remote.status;
  if (status === 'pending' || (status === 'waiting_for_capture' && pay.purpose === 'invoice')) {
    await db.query('update bl.billing_payments set checked_at = $2, updated_at = $2 where id = $1', [pay.id, now]);
    return 'pending';
  }

  if (pay.purpose === 'bind') {
    if (status === 'canceled') {
      await db.query("update bl.billing_payments set status = 'canceled', error = $2, checked_at = $3, updated_at = $3 where id = $1", [pay.id, errorCode(remote), now]);
      return 'canceled';
    }
    // Карта подтверждена (1 ₽ заморожен): сохранить способ, заморозку снять.
    if (!pay.method_saved) await saveMethod(db, deps, config, pay, remote, now);
    if (status === 'waiting_for_capture') {
      try {
        await client.cancelPayment(remote.id, `bl-sub-cancel-${pay.id}`);
      } catch (err) {
        if (!(err instanceof YooKassaError)) throw err;
        deps.log?.warn?.('billing_hold_cancel_failed', { club_id: pay.club_id, payment_id: pay.id, code: err.code });
        await db.query("update bl.billing_payments set status = 'waiting_for_capture', checked_at = $2, updated_at = $2 where id = $1", [pay.id, now]);
        return 'bound';
      }
    }
    await db.query(
      "update bl.billing_payments set status = 'canceled', confirmed_at = coalesce(confirmed_at, $2), confirmed_via = coalesce(confirmed_via, $3), hold_canceled_at = $2, checked_at = $2, updated_at = $2 where id = $1",
      [pay.id, now, via],
    );
    const { rows } = await db.query('select card from bl.club_subscriptions where club_id = $1', [pay.club_id]);
    const last4 = rows[0]?.card?.last4;
    await notifyClub(db, pay.club_id, {
      kind: 'billing.card_saved',
      level: 'info',
      text: `Карта${last4 ? ` •• ${last4}` : ''} привязана: оплата подписки «Бильярдум» будет списываться автоматически.`,
    }, { roles: ['owner'] });
    return 'bound';
  }

  // Оплата счёта.
  if (status === 'canceled') {
    const error = errorCode(remote);
    await db.query("update bl.billing_payments set status = 'canceled', error = $2, receipt_status = coalesce($3, receipt_status), checked_at = $4, updated_at = $4 where id = $1", [pay.id, error, receipt, now]);
    if (pay.initiated_by === 'autopay') {
      const { rows } = await db.query('select * from bl.billing_invoices where id = $1 for update', [pay.invoice_id]);
      const invoice = rows[0];
      if (invoice?.status === 'open' && invoice.attempts < pay.attempt) await recordFailure(db, deps, { invoice, attempt: pay.attempt, error, now });
    }
    return 'canceled';
  }
  await db.query(
    "update bl.billing_payments set status = 'succeeded', confirmed_at = $2, confirmed_via = $3, receipt_status = coalesce($4, receipt_status), checked_at = $2, updated_at = $2 where id = $1",
    [pay.id, now, via, receipt],
  );
  const fresh = { ...pay, status: 'succeeded' };
  if (pay.save_method && !pay.method_saved) await saveMethod(db, deps, config, fresh, remote, now);
  await invoicePaid(db, deps, { pay: fresh, now });
  return 'succeeded';
}

/**
 * Перепроверить платёж в магазине платформы и применить (вебхук, сверка планировщика).
 * Блокировки: подписка клуба → платёж. Возвращает итог applyRemote или 'unknown'.
 */
export async function syncPayment(db, deps, config, paymentId, { via, now, webhook = false }) {
  const { rows: head } = await db.query('select club_id from bl.billing_payments where id = $1', [paymentId]);
  if (!head[0]) return 'unknown';
  await lockSubscription(db, head[0].club_id);
  const { rows } = await db.query('select * from bl.billing_payments where id = $1 for update', [paymentId]);
  const pay = rows[0];
  if (webhook && !pay.webhook_at) await db.query('update bl.billing_payments set webhook_at = $2 where id = $1', [pay.id, now]);
  // Итог уже применён (оплачен, отклонён или заморозка привязки снята) — без запросов к ЮKassa.
  if (pay.status === 'succeeded' || pay.status === 'canceled') {
    if (!webhook) await db.query('update bl.billing_payments set checked_at = $2 where id = $1', [pay.id, now]);
    return 'already';
  }
  if (!pay.provider_payment_id) return 'unknown';
  const client = platformClient(config);
  const remote = await client.getPayment(pay.provider_payment_id);
  return applyRemote(db, deps, config, pay, remote, { via, now, client });
}
