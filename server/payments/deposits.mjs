// Депозит наличными для «Без лимита» (контракт M3 §1 п. 11; decisions №87, №112).
//
// Сессию по депозиту начинает light (startFromDeposit: paid_until — сколько минут покрывает
// депозит по тарифу; «Без лимита» по депозиту сам не продлевается). Деньги — здесь:
//
//   takeDeposit(db, { clubId, sessionId, amountKopecks, staffId, receivedKopecks? })
//       → { payment_id, session_id, change_kopecks, receipt_id } — только в открытую смену
//         (shift_closed); платёж cash (deposit, settlement open) без payment.confirmed (сессия уже
//         идёт); чек ККТ «предоплата 100 %» на сумму депозита; журнал reception.deposit.
//   settleDeposit(db, { sessionId, usedKopecks? }) → { used_kopecks, refunded_kopecks, refund_id }
//       — сессия закрыта (outbox session.closed с deposit_kopecks и used_kopecks): чек ККТ зачёта
//         предоплаты на сыгранное, остаток — возврат наличными из кассы (bl.refunds manual) с
//         чеком возврата предоплаты; ресепшн и владелец получают уведомление. Идемпотентно по сессии.
// Смена сходится: наличные смены = размен + депозит − возврат остатка (server/shifts cashTotals).

import { queueCashRefund } from './cash-refunds.mjs';
import { amountForActual } from '../tariffs/index.mjs';
import { enterClub } from './context.mjs';
import { MoneyError } from './errors.mjs';
import { refunded } from './refunded.mjs';
import { queueSettlementReceipt } from './settle.mjs';
import { loadPaymentSettings } from './settings.mjs';
import { formatValue } from './yookassa.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function line(description, amountKopecks, vatCode, paymentMode) {
  return {
    description: description.slice(0, 128),
    quantity: 1,
    amount: { value: formatValue(amountKopecks), currency: 'RUB' },
    vat_code: vatCode,
    payment_mode: paymentMode,
    payment_subject: 'service',
  };
}

async function sessionRow(db, sessionId) {
  const { rows } = await db.query(
    `select s.id, s.club_id, s.resource_id, s.payer_user_id, s.started_at, s.paid_until, s.ended_at, r.number
       from bl.sessions s join bl.resources r on r.id = s.resource_id where s.id = $1`,
    [sessionId],
  );
  return rows[0] ?? null;
}

async function staffName(db, userId) {
  if (!userId) return null;
  const { rows } = await db.query('select name from bl.users where id = $1', [userId]);
  return rows[0]?.name ?? null;
}

export async function takeDeposit(db, deps, { clubId, sessionId, amountKopecks, staffId, receivedKopecks = null, requestKey = null }) {
  if (!UUID.test(sessionId ?? '') || !UUID.test(staffId ?? '')) throw new MoneyError('bad_request', 'sessionId, staffId');
  if (!Number.isSafeInteger(amountKopecks) || amountKopecks <= 0 || amountKopecks > 100_000_000) throw new MoneyError('bad_request', 'amountKopecks');
  const received = receivedKopecks ?? amountKopecks;
  if (!Number.isSafeInteger(received) || received < amountKopecks || received > amountKopecks + 10_000_000) {
    throw new MoneyError('bad_request', 'receivedKopecks');
  }
  await enterClub(db, clubId);
  const key = `dep-${sessionId}`;
  const prev = (await db.query('select * from bl.payments where club_id = $1 and idempotence_key = $2', [clubId, key])).rows[0];
  if (prev) {
    if (Number(prev.amount_kopecks) !== amountKopecks) throw new MoneyError('idempotency_conflict');
    const r = await db.query("select id from bl.receipts where payment_id = $1 and channel = 'kkt' and kind = 'sale' and settles_payment_id is null limit 1", [prev.id]);
    return { payment_id: prev.id, session_id: sessionId, change_kopecks: Number(prev.change_kopecks ?? 0), receipt_id: r.rows[0]?.id ?? null };
  }
  // Наличные — только в открытую смену (decisions №83, №93).
  const shift = await deps.shifts.currentShift(db, clubId, { forUpdate: true });
  if (!shift) throw new MoneyError('shift_closed');
  const s = await sessionRow(db, sessionId);
  if (!s) throw new MoneyError('not_found', 'session');
  const now = deps.clock.now();
  const minutes = Math.min(10080, Math.max(1, Math.round((new Date(s.paid_until) - new Date(s.started_at)) / 60_000)));
  const change = received - amountKopecks;
  const { rows } = await db.query(
    `insert into bl.payments (club_id, resource_id, user_id, session_id, kind, provider, method, idempotence_key, request_key, status,
                              amount_kopecks, capture, minutes, unlimited, deposit, received_kopecks, change_kopecks, accepted_by,
                              settlement_status, confirmed_at, captured_at, created_at, updated_at)
     values ($1, $2, $3, $4, 'start', 'reception', 'cash', $5, $6, 'succeeded', $7, true, $8, true, true, $9, $10, $11, 'open', $12, $12, $12, $12)
     returning *`,
    [clubId, s.resource_id, s.payer_user_id, sessionId, key, requestKey, amountKopecks, minutes, received, change, staffId, now],
  );
  const p = rows[0];
  const settings = await loadPaymentSettings(db, clubId);
  const receiptId = await deps.kkt.enqueueReceipt(db, {
    clubId,
    kind: 'sell',
    lines: [line(`Депозит за игру, стол ${s.number}`, amountKopecks, settings.vat_code, 'full_prepayment')],
    payments: [{ method: 'cash', amount_kopecks: amountKopecks }],
    operatorName: (await staffName(db, staffId)) ?? shift.opened_by_name ?? 'Кассир',
    paymentId: p.id,
    customerUserId: s.payer_user_id,
    now,
  });
  await deps.audit.appendAudit(db, {
    action: 'reception.deposit',
    objectType: 'session',
    objectId: sessionId,
    data: { session_id: sessionId, payment_id: p.id, amount_kopecks: amountKopecks, received_kopecks: received, change_kopecks: change, shift_id: shift.id },
    actorType: 'user',
    actorId: staffId,
  });
  return { payment_id: p.id, session_id: sessionId, change_kopecks: change, receipt_id: receiptId };
}

export async function settleDeposit(db, deps, { sessionId, usedKopecks = null }) {
  if (!UUID.test(sessionId ?? '')) throw new MoneyError('bad_request', 'sessionId');
  const { rows: deposits } = await db.query(
    'select * from bl.payments where session_id = $1 and deposit order by created_at, id for update',
    [sessionId],
  );
  if (deposits.length === 0) return { skipped: 'no_deposit' };
  const open = deposits.filter((d) => d.settlement_status === 'open');
  const refundOf = async (d) => (await db.query('select * from bl.refunds where payment_id = $1 and idempotence_key = $2', [d.id, `depr-${d.id}`])).rows[0] ?? null;
  if (open.length === 0) {
    const refunds = (await Promise.all(deposits.map(refundOf))).filter(Boolean);
    return {
      used_kopecks: deposits.reduce((x, d) => x + Number(d.settled_kopecks), 0),
      refunded_kopecks: refunds.reduce((x, f) => x + Number(f.amount_kopecks), 0),
      refund_id: refunds[0]?.id ?? null,
    };
  }
  const s = await sessionRow(db, sessionId);
  const clubId = deposits[0].club_id;
  const total = open.reduce((x, d) => x + Number(d.amount_kopecks), 0);
  let used = usedKopecks;
  let minutes = null;
  if (!Number.isSafeInteger(used) || used < 0) {
    const end = new Date(Math.min(new Date(s.ended_at ?? s.paid_until).getTime(), new Date(s.paid_until).getTime()));
    const actual = await amountForActual(db, { resourceId: s.resource_id, from: s.started_at, to: end < new Date(s.started_at) ? s.started_at : end });
    used = actual.amount_kopecks;
    minutes = actual.minutes;
  }
  used = Math.min(used, total);
  if (minutes === null) {
    const end = new Date(Math.min(new Date(s.ended_at ?? s.paid_until).getTime(), new Date(s.paid_until).getTime()));
    minutes = Math.max(1, Math.ceil((end - new Date(s.started_at)) / 60_000));
  }
  const now = deps.clock.now();
  const settings = await loadPaymentSettings(db, clubId);
  const shift = await deps.shifts.currentShift(db, clubId);
  const operatorName = shift?.opened_by_name ?? 'Кассир';
  let left = used;
  let refundedTotal = 0;
  let refundId = null;
  let queuedTotal = 0;
  let pendingId = null;
  for (const d of open) {
    const part = Math.min(left, Number(d.amount_kopecks));
    left -= part;
    const rest = Number(d.amount_kopecks) - part;
    if (part > 0) {
      await queueSettlementReceipt(db, deps, {
        source: d,
        forPaymentId: d.id,
        items: [line(`Игра, стол ${s.number}, без лимита (${minutes} мин)`, part, settings.vat_code, 'full_payment')],
        amountKopecks: part,
        operatorName,
        now,
      });
    }
    if (rest > 0 && !shift) {
      // Смены нет — наличные выдаст кассир следующей смены (ревью п. 7, cash-refunds.mjs).
      const lines = [line(`Депозит за игру, стол ${s.number}`, rest, settings.vat_code, 'full_prepayment')];
      const { pending } = await queueCashRefund(db, deps, { clubId, payment: d, key: `depr-${d.id}`, amountKopecks: rest, reason: 'Возврат остатка депозита', lines, now });
      queuedTotal += rest;
      pendingId ??= pending.id;
    } else if (rest > 0) {
      const reason = 'Возврат остатка депозита';
      const { rows: f } = await db.query(
        `insert into bl.refunds (club_id, payment_id, idempotence_key, amount_kopecks, status, reason, created_at, updated_at)
         values ($1, $2, $3, $4, 'manual', $5, $6, $6) returning *`,
        [clubId, d.id, `depr-${d.id}`, rest, reason, now],
      );
      await deps.kkt.enqueueReceipt(db, {
        clubId,
        kind: 'sell_refund',
        lines: [line(`Депозит за игру, стол ${s.number}`, rest, settings.vat_code, 'full_prepayment')],
        payments: [{ method: 'cash', amount_kopecks: rest }],
        operatorName,
        paymentId: d.id,
        refundId: f[0].id,
        customerUserId: d.user_id,
        now,
      });
      await refunded(db, deps, f[0], now);
      refundedTotal += rest;
      refundId ??= f[0].id;
    }
    await db.query(
      `update bl.payments set settlement_status = 'settled', settled_kopecks = $2, settled_at = $3, updated_at = $3 where id = $1`,
      [d.id, part, now],
    );
  }
  await deps.audit.appendAudit(db, {
    action: 'reception.deposit_settled',
    objectType: 'session',
    objectId: sessionId,
    data: { session_id: sessionId, deposit_kopecks: total, used_kopecks: used, refunded_kopecks: refundedTotal, refund_id: refundId, queued_kopecks: queuedTotal },
    actorType: 'system',
  });
  return { used_kopecks: used, refunded_kopecks: refundedTotal, refund_id: refundId, ...(queuedTotal > 0 ? { queued_kopecks: queuedTotal, pending_id: pendingId } : {}) };
}
