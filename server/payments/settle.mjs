// Чек зачёта предоплаты (54-ФЗ; decisions №52, №108, №112).
//
// Предоплата (бронь, пакет часов, депозит) пробивается чеком «предоплата 100 %» в момент оплаты;
// когда услуга оказана (игра началась, минуты пакета списаны, сессия по депозиту закрыта),
// нужен второй чек — позиции «полный расчёт» и оплата «зачёт предоплаты».
//
// * Предоплата через ЮKassa → строка bl.receipts (channel yookassa, receipt_pending) и событие
//   outbox money.receipt_settle; обработчик отправляет POST /v3/receipts по платежу предоплаты
//   (type payment, settlements [{type: prepayment}]) с ключом идемпотентности st-<receipt_id>.
//   Сбой ЮKassa — повтор outbox; отказ — статус failed и тревога владельцу.
// * Предоплата наличными или картой через терминал (депозит, пакет на кассе) → задание ККТ
//   (server/kkt enqueueReceipt) с оплатой «предоплата» (АТОЛ prepaid).
// Поля /v3/receipts, в которых нет уверенности, перечислены в server/payments/README.md.

import { enterClub } from './context.mjs';
import { receiptPhone } from './receipt.mjs';
import { receiptPhoneOf } from './records.mjs';
import { clientFor, loadPaymentSettings } from './settings.mjs';
import { formatValue, YooKassaError } from './yookassa.mjs';

export const SETTLE_TOPIC = 'money.receipt_settle';

/**
 * Поставить чек зачёта предоплаты source на сумму amountKopecks.
 * @param {object} p
 * @param {object} p.source строка bl.payments — платёж предоплаты
 * @param {string} p.forPaymentId платёж, к которому относится чек (bl.receipts.payment_id)
 * @param {object[]} p.items позиции «полный расчёт» (формат ЮKassa), Σ = amountKopecks
 * @param {string} [p.operatorName] кассир (чек ККТ)
 * @returns {Promise<string|null>} id чека или null, если сумма 0
 */
export async function queueSettlementReceipt(db, deps, { source, forPaymentId, items, amountKopecks, operatorName = null, now }) {
  if (!(amountKopecks > 0)) return null;
  const prev = await db.query(
    `select id from bl.receipts where club_id = $1 and payment_id = $2 and settles_payment_id = $3 and kind = 'sale' limit 1`,
    [source.club_id, forPaymentId, source.id],
  );
  if (prev.rows[0]) return prev.rows[0].id;
  const settings = await loadPaymentSettings(db, source.club_id);
  if (source.provider === 'yookassa') {
    const phone = await receiptPhoneOf(db, source.id);
    const { rows } = await db.query(
      `insert into bl.receipts (club_id, payment_id, kind, channel, status, amount_kopecks, items, tax_system_code,
                                customer_user_id, customer_phone, settles_payment_id, settlement_kopecks, created_at, updated_at)
       values ($1, $2, 'sale', 'yookassa', 'receipt_pending', $3, $4::jsonb, $5, $6, $7, $8, $3, $9, $9)
       returning id`,
      [source.club_id, forPaymentId, amountKopecks, JSON.stringify(items), settings.tax_system_code, source.user_id, phone, source.id, now],
    );
    await deps.outbox.enqueue(db, SETTLE_TOPIC, { receipt_id: rows[0].id, club_id: source.club_id });
    return rows[0].id;
  }
  // Наличные и терминал — ККТ клуба, оплата «предоплата» (зачёт аванса); server/kkt сам пишет
  // settles_payment_id и settlement_kopecks и отличает чек зачёта от чека предоплаты при повторе.
  return deps.kkt.enqueueReceipt(db, {
    clubId: source.club_id,
    kind: 'sell',
    lines: items,
    payments: [{ method: 'prepayment', amount_kopecks: amountKopecks }],
    operatorName: operatorName ?? 'Кассир',
    paymentId: forPaymentId,
    settlesPaymentId: source.id,
    settlementKopecks: amountKopecks,
    customerUserId: source.user_id ?? null,
    now,
  });
}

/** Обработчик outbox money.receipt_settle: отправить чек зачёта в ЮKassa. */
export async function sendSettlementReceipt(db, deps, config, payload) {
  await enterClub(db, payload.club_id);
  const { rows } = await db.query(
    `select r.*, p.provider_payment_id as source_provider_id
       from bl.receipts r join bl.payments p on p.id = r.settles_payment_id
      where r.id = $1 for update of r`,
    [payload.receipt_id],
  );
  const r = rows[0];
  if (!r || r.channel !== 'yookassa' || r.provider_receipt_id || r.status !== 'receipt_pending') return { result: 'skipped' };
  const settings = await loadPaymentSettings(db, r.club_id);
  const phone = receiptPhone(r.customer_phone);
  const now = deps.clock.now();
  const fail = async (code) => {
    await db.query(`update bl.receipts set status = 'failed', updated_at = $2 where id = $1`, [r.id, now]);
    deps.log?.error?.('settlement_receipt_failed', { receipt_id: r.id, club_id: r.club_id, code });
    await deps.alarms.raise(db, r.club_id, { type: 'settlement_receipt_failed', level: 'important', data: { receipt_id: r.id, code } });
    return { result: 'failed' };
  };
  if (!phone) return fail('no_customer');
  const body = {
    type: 'payment',
    payment_id: r.source_provider_id,
    send: true,
    customer: { phone },
    items: r.items,
    settlements: [{ type: 'prepayment', amount: { value: formatValue(Number(r.settlement_kopecks)), currency: 'RUB' } }],
    ...(settings.tax_system_code != null ? { tax_system_code: settings.tax_system_code } : {}),
  };
  let remote;
  try {
    remote = await clientFor(settings, config).createReceipt(body, `st-${r.id}`);
  } catch (err) {
    if (err instanceof YooKassaError && !err.retryable) return fail(err.code);
    throw err; // сеть или 5xx — outbox повторит тем же ключом
  }
  const status = { succeeded: 'succeeded', pending: 'pending', canceled: 'failed' }[remote?.status] ?? 'pending';
  await db.query(`update bl.receipts set provider_receipt_id = $2, status = $3, updated_at = $4 where id = $1`, [r.id, remote.id, status, now]);
  return { result: status, provider_receipt_id: remote.id };
}
