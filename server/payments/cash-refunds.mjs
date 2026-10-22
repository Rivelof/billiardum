// Возврат наличных без открытой смены (ревью денег п. 7, 0657).
//
// Наличные гостю выдаёт кассир из кассы смены, и возврат должен попасть в сверку кассы. Если смены
// нет (депозит «Без лимита» закрылся ночью, возврат по заявке ресепшена после закрытия смены),
// возврат ждёт в bl.cash_refunds_pending: тревога владельцу и управляющему, уведомление ресепшену.
// Планировщик (money_due cash_refund_queued, раз в минуту) после открытия смены проводит его:
// строка bl.refunds manual (создана в новой смене — попадает в её отчёт и сверку), задание на чек
// возврата ККТ, журнал payment.refunded, уведомление ресепшену «выдайте гостю».

import { formatMoney } from '../../shared/format.mjs';
import { refunded } from './refunded.mjs';

/** Поставить возврат наличных в ожидание смены (повтор с тем же ключом — та же строка). */
export async function queueCashRefund(db, deps, { clubId, payment, key, amountKopecks, reason, lines, requestedBy = null, now }) {
  const { rows } = await db.query(
    `insert into bl.cash_refunds_pending (club_id, payment_id, idempotence_key, amount_kopecks, reason, lines, requested_by, created_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     on conflict (club_id, idempotence_key) do nothing returning *`,
    [clubId, payment.id, key, amountKopecks, reason, JSON.stringify(lines), requestedBy, now],
  );
  if (!rows[0]) {
    const prev = (await db.query('select * from bl.cash_refunds_pending where club_id = $1 and idempotence_key = $2', [clubId, key])).rows[0];
    return { pending: prev, created: false };
  }
  const q = rows[0];
  const sum = formatMoney(amountKopecks);
  await deps.alarms.raise(db, clubId, {
    type: 'cash_refund_awaiting_shift',
    level: 'important',
    data: { pending_id: q.id, payment_id: payment.id, amount_kopecks: amountKopecks },
    dedupeKey: `cash_refund:${q.id}`,
    text: `Возврат ${sum} наличными ждёт открытия смены: ${reason}`,
  });
  try {
    await deps.notify.sendToClubStaff(db, clubId, ['reception'], {
      kind: 'cash_refund',
      level: 'important',
      text: `Гостю нужно вернуть ${sum} наличными — после открытия смены. Причина: ${reason}`,
      data: { pending_id: q.id, payment_id: payment.id, amount_kopecks: amountKopecks },
    });
  } catch (err) {
    deps.log?.warn?.('cash_refund_notify_failed', { pending_id: q.id, error: err.message });
  }
  deps.log?.warn?.('cash_refund_queued', { pending_id: q.id, payment_id: payment.id, club_id: clubId, amount_kopecks: amountKopecks });
  return { pending: q, created: true };
}

/**
 * Провести отложенный возврат, если смена открыта (планировщик). Без смены — отметка checked_at.
 * @returns {Promise<{ result: 'issued'|'waiting'|'already', refund_id?: string }>}
 */
export async function issueQueuedCashRefund(db, deps, pendingId) {
  const { rows } = await db.query('select * from bl.cash_refunds_pending where id = $1 for update', [pendingId]);
  const q = rows[0];
  if (!q || q.done_at) return { result: 'already' };
  const now = deps.clock.now();
  const shift = await deps.shifts.currentShift(db, q.club_id);
  if (!shift) {
    await db.query('update bl.cash_refunds_pending set checked_at = $2 where id = $1', [q.id, now]);
    return { result: 'waiting' };
  }
  const p = (await db.query('select * from bl.payments where id = $1', [q.payment_id])).rows[0];
  const { rows: f } = await db.query(
    `insert into bl.refunds (club_id, payment_id, idempotence_key, amount_kopecks, status, reason, requested_by, created_at, updated_at)
     values ($1, $2, $3, $4, 'manual', $5, $6, $7, $7) returning *`,
    [q.club_id, q.payment_id, q.idempotence_key, q.amount_kopecks, q.reason, q.requested_by, now],
  );
  await deps.kkt.enqueueReceipt(db, {
    clubId: q.club_id,
    kind: 'sell_refund',
    lines: q.lines,
    payments: [{ method: 'cash', amount_kopecks: Number(q.amount_kopecks) }],
    operatorName: shift.opened_by_name ?? 'Кассир',
    paymentId: q.payment_id,
    refundId: f[0].id,
    customerUserId: p?.user_id ?? null,
    now,
  });
  await db.query('update bl.cash_refunds_pending set done_at = $2, refund_id = $3, checked_at = $2 where id = $1', [q.id, now, f[0].id]);
  await refunded(db, deps, f[0], now);
  try {
    await deps.notify.sendToClubStaff(db, q.club_id, ['reception'], {
      kind: 'cash_refund',
      level: 'important',
      text: `Выдайте гостю ${formatMoney(Number(q.amount_kopecks))} наличными (отложенный возврат). Причина: ${q.reason}`,
      data: { pending_id: q.id, refund_id: f[0].id, amount_kopecks: Number(q.amount_kopecks) },
    });
  } catch (err) {
    deps.log?.warn?.('cash_refund_notify_failed', { pending_id: q.id, error: err.message });
  }
  return { result: 'issued', refund_id: f[0].id };
}
