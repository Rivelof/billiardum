// Платёж оплачен в ЮKassa после того, как мы его отменили (находка pentester B-L1, 0655).
//
// Так бывает, когда отмена у нас локальная: ЮKassa не знала платёж (404, not_found_at_provider),
// заявка сгорела, вебхук пришёл после таймаута. Игру или бронь по такому платежу уже не запускаем
// (статус canceled окончательный, payments_guard), а деньги гостя возвращаем сами:
// * succeeded — возврат ЮKassa на всю сумму с чеком возврата (позиции — из чека продажи), строка
//   bl.refunds kind late (оплата в выручку не входила — возврат тоже не входит, ревью п. 8), ключ
//   идемпотентности late-<payment_id>: повтор вебхука или сверки возврат не дублирует;
// * waiting_for_capture — отмена заморозки (ключ late-rel-<payment_id>).
// Тревога владельцу (critical) и уведомление гостю «Платёж вернётся» — один раз (payments.late_paid_at).
// ЮKassa недоступна (сеть, 5xx) — ошибка наверх: откат, вебхук или сверка повторят. Отказ ЮKassa
// (4xx) — тревога с action refund_failed (тоже один раз), деньги возвращает владелец вручную;
// следующий вебхук или сверка попробуют вернуть ещё раз.

import { applyRefundStatus } from './api.mjs';
import { receiptPhone, yookassaReceipt } from './receipt.mjs';
import { insertReceipt, receiptPhoneOf } from './records.mjs';
import { loadPaymentSettings } from './settings.mjs';
import { amountKopecks, formatValue, YooKassaError } from './yookassa.mjs';

export const LATE_REASON = 'Платёж прошёл после отмены: игра не началась, деньги возвращаются автоматически';

/**
 * @param {object} payment строка bl.payments со статусом canceled
 * @param {object} remote платёж из ЮKassa (succeeded или waiting_for_capture), уже сверенный applyRemote
 * @param {{ client: object, source?: string }} opts клиент ЮKassa магазина клуба
 * @returns {Promise<{ result: 'late_refund'|'late_released'|'late_failed'|'already', payment: object }>}
 */
export async function handleLatePayment(db, deps, payment, remote, { client, source = 'webhook' }) {
  const now = deps.clock.now();
  const { rows } = await db.query('select * from bl.payments where id = $1 for update', [payment.id]);
  const p = rows[0];
  if (!p || p.status !== 'canceled') return { result: 'already', payment: p ?? payment };
  const first = !p.late_paid_at;
  if (first) await db.query('update bl.payments set late_paid_at = $2 where id = $1', [p.id, now]);
  const amount = amountKopecks(remote.amount) ?? Number(p.amount_kopecks);
  let action;
  let refundId = null;
  try {
    if (remote.status === 'waiting_for_capture') {
      await client.cancelPayment(p.provider_payment_id, `late-rel-${p.id}`);
      action = 'released';
    } else {
      refundId = await lateRefund(db, deps, client, p, amount, now);
      action = 'refunded';
    }
  } catch (err) {
    if (!(err instanceof YooKassaError) || err.retryable) throw err; // откат: вебхук или сверка повторят
    deps.log?.error?.('late_payment_refund_failed', { payment_id: p.id, club_id: p.club_id, code: err.code, status: err.status });
    action = 'refund_failed';
  }
  if (first) {
    deps.log?.error?.('payment_paid_after_cancel', { payment_id: p.id, club_id: p.club_id, provider_status: remote.status, action, source });
    await deps.alarms.raise(db, p.club_id, {
      type: 'payment_paid_after_cancel',
      level: 'critical',
      resourceId: p.resource_id ?? null,
      data: {
        payment_id: p.id,
        kind: p.kind,
        amount_kopecks: amount,
        provider_status: remote.status,
        cancellation_reason: p.cancellation_reason,
        action,
        refund_id: refundId,
      },
    });
  }
  if (first && action !== 'refund_failed' && p.user_id) {
    try {
      await deps.notify.send(db, p.user_id, {
        kind: 'payment_returned',
        level: 'important',
        text: `Платёж ${formatValue(amount).replace('.', ',')} ₽ прошёл после отмены. Игра не началась, деньги вернутся на карту или счёт в течение нескольких дней.`,
        data: { payment_id: p.id, amount_kopecks: amount },
      });
    } catch (err) {
      deps.log?.warn?.('late_payment_notify_failed', { payment_id: p.id, error: err.message });
    }
  }
  const result = { refunded: 'late_refund', released: 'late_released', refund_failed: 'late_failed' }[action];
  return { result, payment: (await db.query('select * from bl.payments where id = $1', [p.id])).rows[0] };
}

/** Возврат всей суммы с чеком возврата — тем же путём, что refund (api.mjs), но для отменённого у нас платежа. */
async function lateRefund(db, deps, client, p, amount, now) {
  const key = `late-${p.id}`;
  const prev = await db.query('select * from bl.refunds where club_id = $1 and idempotence_key = $2', [p.club_id, key]);
  if (prev.rows[0]) return prev.rows[0].id;
  const settings = await loadPaymentSettings(db, p.club_id, { isTest: p.is_test });
  const phone = await receiptPhoneOf(db, p.id);
  // Чек возврата повторяет чек продажи (предмет и способ расчёта те же); нет его — «Игра, стол N».
  const { rows: sale } = await db.query(
    `select items, amount_kopecks from bl.receipts
      where payment_id = $1 and channel = 'yookassa' and kind = 'sale' order by created_at desc limit 1`,
    [p.id],
  );
  let receipt;
  if (sale[0] && Number(sale[0].amount_kopecks) === amount && receiptPhone(phone)) {
    receipt = { customer: { phone: receiptPhone(phone) }, items: sale[0].items, ...(settings.tax_system_code != null ? { tax_system_code: settings.tax_system_code } : {}) };
  } else {
    const { rows: res } = await db.query('select number from bl.resources where id = $1', [p.resource_id]);
    receipt = yookassaReceipt({ phone, resourceNumber: res[0]?.number, minutes: p.minutes, amountKopecks: amount, settings });
  }
  // Сначала ЮKassa (ключ идемпотентен: повтор после отката вернёт тот же возврат), потом строка.
  const remote = await client.createRefund(
    {
      payment_id: p.provider_payment_id,
      amount: { value: formatValue(amount), currency: 'RUB' },
      description: 'Возврат: платёж прошёл после отмены',
      receipt,
    },
    key,
  );
  const { rows: ins } = await db.query(
    `insert into bl.refunds (club_id, payment_id, provider_refund_id, idempotence_key, amount_kopecks, status, reason, kind, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'pending', $6, 'late', $7, $7) returning *`,
    [p.club_id, p.id, remote.id, key, amount, LATE_REASON, now],
  );
  await insertReceipt(db, {
    clubId: p.club_id,
    paymentId: p.id,
    refundId: ins[0].id,
    kind: 'refund',
    channel: 'yookassa',
    status: remote.receipt_registration === 'succeeded' ? 'succeeded' : 'pending',
    amountKopecks: amount,
    items: receipt.items,
    taxSystemCode: settings.tax_system_code,
    userId: p.user_id,
    phone,
    now,
  });
  await applyRefundStatus(db, deps, ins[0], remote.status, { now });
  return ins[0].id;
}
