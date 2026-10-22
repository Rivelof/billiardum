// Возврат проведён: журнал payment.refunded с причиной, outbox payment.refunded, уведомление
// владельцу (у возврата наличными — и ресепшену: деньги отдаёт кассир). Инвариант 8.

import { sessionIdOf } from './records.mjs';
import { formatValue } from './yookassa.mjs';

export async function refunded(db, deps, refund, now) {
  const { rows } = await db.query('select * from bl.payments where id = $1', [refund.payment_id]);
  const p = rows[0];
  const amount = Number(refund.amount_kopecks);
  await deps.audit.appendAudit(db, {
    action: 'payment.refunded',
    objectType: 'payment',
    objectId: p.id,
    reason: refund.reason,
    data: { payment_id: p.id, refund_id: refund.id, method: p.method, amount_kopecks: amount, status: refund.status },
  });
  const sessionId = await sessionIdOf(db, p);
  await deps.outbox.enqueue(db, 'payment.refunded', { payment_id: p.id, club_id: p.club_id, session_id: sessionId, amount_kopecks: amount });
  try {
    await deps.notify.sendToClubStaff(db, p.club_id, refund.status === 'manual' ? ['owner', 'manager', 'reception'] : ['owner'], {
      kind: 'refund',
      text:
        refund.status === 'manual'
          ? `Возврат ${formatValue(amount).replace('.', ',')} ₽ гостю на ресепшене: ${refund.reason}`
          : `Возврат ${formatValue(amount).replace('.', ',')} ₽: ${refund.reason}`,
      data: { payment_id: p.id, refund_id: refund.id, amount_kopecks: amount },
    });
  } catch (err) {
    deps.log?.warn?.('refund_notify_failed', { refund_id: refund.id, error: err.message });
  }
  deps.log?.info?.('payment_refunded', { payment_id: p.id, refund_id: refund.id, club_id: p.club_id, amount_kopecks: amount, at: now.toISOString() });
}
