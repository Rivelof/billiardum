// Карта «Без лимита»: списание фактической суммы при закрытии сессии (PRODUCT §3, №45).
//
// Подписка на outbox session.closed: заморозки сессии (capture = false, waiting_for_capture)
// списываются на сумму amountForActual(started_at, конец игры) с чеком на фактическую сумму;
// остаток размораживается (ЮKassa), лишние заморозки отменяются. Обработчик идемпотентен:
// уже списанные заморозки учитываются, ключи ЮKassa детерминированы (cap-/rel-<payment_id>).
// Конец игры — ended_at сессии, но не позже paid_until (льгота не оплачивается).

import { amountForActual } from '../tariffs/index.mjs';
import { enterClub, isUuid } from './context.mjs';
import { yookassaReceipt } from './receipt.mjs';
import { insertReceipt, receiptPhoneOf } from './records.mjs';
import { clientFor, loadPaymentSettings, shopModeOf } from './settings.mjs';
import { formatValue } from './yookassa.mjs';
import { applyRemote } from './pay.mjs';

/**
 * Списать amountKopecks с заморозки (0 — отменить заморозку). Чек — на списанную сумму.
 * @returns {Promise<{ captured: number }>}
 */
export async function captureOrRelease(db, deps, config, payment, { amountKopecks, number, settings: given, minutes = null, now }) {
  // Пара магазина — по самому платежу (M5.1 №154): заморозка тестового режима списывается тестовым магазином.
  const settings = given?.shop_mode === shopModeOf(payment) ? given : await loadPaymentSettings(db, payment.club_id, { isTest: payment.is_test });
  const client = clientFor(settings, config);
  const cancelHoldReceipt = () =>
    db.query(`update bl.receipts set status = 'canceled', updated_at = $2 where payment_id = $1 and kind = 'sale' and status = 'pending'`, [
      payment.id,
      now,
    ]);
  if (amountKopecks <= 0) {
    const remote = await client.cancelPayment(payment.provider_payment_id, `rel-${payment.id}`);
    await cancelHoldReceipt();
    await applyRemote(db, deps, payment, remote, { source: 'release' });
    return { captured: 0 };
  }
  const phone = await receiptPhoneOf(db, payment.id);
  const receipt = yookassaReceipt({ phone, resourceNumber: number, minutes, amountKopecks, settings });
  const remote = await client.capturePayment(
    payment.provider_payment_id,
    { amount: { value: formatValue(amountKopecks), currency: 'RUB' }, receipt },
    `cap-${payment.id}`,
  );
  // Чек заморозки заменён чеком на фактическую сумму (до applyRemote: тот обновит статус нового).
  await cancelHoldReceipt();
  await insertReceipt(db, {
    clubId: payment.club_id,
    paymentId: payment.id,
    channel: 'yookassa',
    status: 'pending',
    amountKopecks,
    items: receipt.items,
    taxSystemCode: settings.tax_system_code,
    userId: payment.user_id,
    phone,
    now,
  });
  const r = await applyRemote(db, deps, payment, remote, { source: 'capture' });
  if (r.result === 'mismatch') throw new Error(`списание заморозки ${payment.id}: ответ ЮKassa не сошёлся`);
  await deps.audit.appendAudit(db, {
    action: 'payment.captured',
    objectType: 'payment',
    objectId: payment.id,
    data: { payment_id: payment.id, method: payment.method, amount_kopecks: amountKopecks, authorized_kopecks: Number(payment.amount_kopecks) },
    actorType: 'system',
  });
  return { captured: amountKopecks };
}

/** Заморозки сессии: связь light (session_payments) или своя колонка (продление). */
async function sessionHolds(db, sessionId) {
  const { rows } = await db.query(
    `select p.* from bl.payments p
      where p.capture = false and p.provider = 'yookassa'
        and (p.session_id = $1 or p.id in (select sp.payment_id from bl.session_payments sp where sp.session_id = $1))
      order by p.created_at, p.id
      for update of p`,
    [sessionId],
  );
  return rows;
}

/**
 * Обработчик outbox session.closed.
 * payload: { session_id, club_id, resource_id, paid_until, started_at?, ended_at? }
 */
export async function onSessionClosed(db, deps, config, payload) {
  if (!isUuid(payload?.session_id) || !isUuid(payload?.club_id)) return { skipped: 'payload' };
  await enterClub(db, payload.club_id);
  const holds = await sessionHolds(db, payload.session_id);
  const waiting = holds.filter((h) => h.status === 'waiting_for_capture');
  if (waiting.length === 0) return { skipped: 'no_holds' };

  const { rows } = await db.query('select resource_id, started_at, paid_until, ended_at from bl.sessions where id = $1', [payload.session_id]);
  const s = rows[0] ?? {};
  const resourceId = payload.resource_id ?? s.resource_id;
  const from = new Date(payload.started_at ?? s.started_at ?? waiting[0].confirmed_at);
  const paidUntil = new Date(payload.paid_until ?? s.paid_until ?? deps.clock.now());
  const ended = new Date(payload.ended_at ?? s.ended_at ?? paidUntil);
  const to = new Date(Math.min(ended.getTime(), paidUntil.getTime()));
  const actual = await amountForActual(db, { resourceId, from, to: to < from ? from : to });

  const already = holds.filter((h) => h.status === 'succeeded').reduce((sum, h) => sum + Number(h.captured_kopecks ?? 0), 0);
  let remaining = Math.max(0, actual.amount_kopecks - already);
  const settings = await loadPaymentSettings(db, payload.club_id, { isTest: waiting[0].is_test });
  const { rows: res } = await db.query('select number from bl.resources where id = $1', [resourceId]);
  const number = res[0]?.number;
  const now = deps.clock.now();
  const single = holds.length === 1;
  let captured = 0;
  for (const h of waiting) {
    const amount = Math.min(remaining, Number(h.amount_kopecks));
    const r = await captureOrRelease(db, deps, config, h, { amountKopecks: amount, number, settings, minutes: single ? actual.minutes : null, now });
    captured += r.captured;
    remaining -= r.captured;
  }
  if (remaining > 0) {
    deps.log?.warn?.('unlimited_overrun', { session_id: payload.session_id, club_id: payload.club_id, uncovered_kopecks: remaining });
    await deps.alarms.raise(db, payload.club_id, {
      type: 'unlimited_overrun',
      level: 'important',
      resourceId,
      data: { session_id: payload.session_id, uncovered_kopecks: remaining },
    });
  }
  deps.log?.info?.('unlimited_captured', { session_id: payload.session_id, club_id: payload.club_id, amount_kopecks: captured, minutes: actual.minutes });
  return { captured, minutes: actual.minutes, amount_kopecks: actual.amount_kopecks };
}
