// Взнос за участие в турнире (M4, контракт m4.md §1 п. 11, решение №138).
//
// * createTournamentFee — платёж ЮKassa kind tournament с чеком «полный расчёт» (услуга участия,
//   payment_subject service). Попытки оплаты одной записи: оплаченная — already_paid; брошенная
//   (pending) с той же суммой и способом — та же; иначе новая (id и ключ ЮKassa от записи и номера).
//   Подтверждение — общий путь (вебхук, сверка) → outbox payment.confirmed {kind: 'tournament',
//   tournament_id, entry_id, …}.
// * refundTournamentFee — возврат целиком по каждой оплаченной попытке записи с чеком возврата
//   (позиции — из чека продажи), ключ ЮKassa trn-<payment_id>: повтор не возвращает дважды.
//   Нечего возвращать — { status: 'not_paid' }. Правила «когда можно» (до начала, отмена клубом)
//   проверяет backend-tournaments.
// * refundTournamentFees — отмена турнира клубом: по событию outbox money.tournament_refund на
//   каждую оплаченную запись (сбой ЮKassa по одной записи не мешает остальным, outbox повторит).

import { MoneyError } from './errors.mjs';
import { enterClub } from './context.mjs';
import { createYooKassaPayment, ownReturnUrl, returnUrl } from './pay.mjs';
import { receiptPhone } from './receipt.mjs';
import { stableUuid } from './records.mjs';
import { loadPaymentSettings } from './settings.mjs';
import { formatValue } from './yookassa.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,189}\.[a-z]{2,24}$/i;

export const TOURNAMENT_REFUND_TOPIC = 'money.tournament_refund';

/** Покупатель для чека: { phone: '79…' } (из +7…) или { email }. */
function customerOf(customer) {
  if (customer && typeof customer.phone === 'string' && receiptPhone(customer.phone)) return { phone: receiptPhone(customer.phone) };
  if (customer && typeof customer.phone === 'string' && /^[1-9]\d{7,14}$/.test(customer.phone)) return { phone: customer.phone };
  if (customer && typeof customer.email === 'string' && customer.email.length <= 254 && EMAIL.test(customer.email)) return { email: customer.email };
  throw new MoneyError('bad_request', 'customer: телефон или почта для чека');
}

/** Позиция чека взноса (услуга участия в турнире). */
export function tournamentItem({ title, amountKopecks, vatCode, paymentMode = 'full_payment' }) {
  return {
    description: `Участие в турнире${title ? ` «${String(title).slice(0, 90)}»` : ''}`.slice(0, 128),
    quantity: 1,
    amount: { value: formatValue(amountKopecks), currency: 'RUB' },
    vat_code: vatCode,
    payment_mode: paymentMode,
    payment_subject: 'service',
  };
}

/**
 * @param {{ clubId, tournamentId, entryId, amountKopecks, customer: {phone}|{email}, returnUrl?, method?: 'sbp'|'card',
 *           userId?, title?, requestKey? }} args
 * @returns {Promise<{ payment, confirmation }>}
 */
export async function createTournamentFee(db, deps, config, args) {
  const { clubId, tournamentId, entryId, amountKopecks } = args;
  for (const [k, v] of [['clubId', clubId], ['tournamentId', tournamentId], ['entryId', entryId]]) {
    if (!UUID.test(v ?? '')) throw new MoneyError('bad_request', k);
  }
  if (args.userId != null && !UUID.test(args.userId)) throw new MoneyError('bad_request', 'userId');
  if (!Number.isSafeInteger(amountKopecks) || amountKopecks <= 0) throw new MoneyError('bad_request', 'amountKopecks');
  const method = args.method ?? 'sbp';
  if (method !== 'sbp' && method !== 'card') throw new MoneyError('bad_request', 'method');
  const customer = customerOf(args.customer);
  const ownUrl = ownReturnUrl(config, args.returnUrl);
  await enterClub(db, clubId);
  const settings = await loadPaymentSettings(db, clubId);
  if (!settings[method]) throw new MoneyError('bad_request', method === 'sbp' ? 'СБП недоступна' : 'карта недоступна');
  const { rows: tries } = await db.query(
    `select * from bl.payments where club_id = $1 and entry_id = $2 and kind = 'tournament' order by created_at, id for update`,
    [clubId, entryId],
  );
  if (tries.some((t) => t.tournament_id !== tournamentId)) throw new MoneyError('bad_request', 'запись другого турнира');
  if (tries.some((t) => t.status === 'succeeded')) {
    const { rows } = await db.query(
      `select coalesce(sum(f.amount_kopecks), 0)::bigint as refunded from bl.refunds f
        where f.payment_id = any($1::uuid[]) and f.status <> 'canceled'`,
      [tries.filter((t) => t.status === 'succeeded').map((t) => t.id)],
    );
    const paid = tries.filter((t) => t.status === 'succeeded').reduce((x, t) => x + Number(t.amount_kopecks), 0);
    if (Number(rows[0].refunded) < paid) throw new MoneyError('already_paid');
  }
  const same = tries.find((t) => t.status === 'pending' && Number(t.amount_kopecks) === amountKopecks && t.method === method);
  const n = tries.length;
  const paymentId = same ? same.id : stableUuid(`bl.payment/tournament/${entryId}/${n}`);
  const idempotenceKey = same ? same.idempotence_key : `trn-${entryId}-${n}`;
  const items = [tournamentItem({ title: args.title, amountKopecks, vatCode: settings.vat_code })];
  const receipt = { customer, items, ...(settings.tax_system_code != null ? { tax_system_code: settings.tax_system_code } : {}) };
  const out = await createYooKassaPayment(db, deps, config, {
    settings,
    clubId,
    paymentId,
    idempotenceKey,
    requestKey: args.requestKey ?? null,
    kind: 'tournament',
    method,
    amountKopecks,
    capture: true,
    receipt,
    confirmation: { type: 'redirect', returnUrl: ownUrl ?? returnUrl(config, paymentId) },
    description: String(items[0].description),
    metadata: { tournament_id: tournamentId, entry_id: entryId },
    tournamentId,
    entryId,
    userId: args.userId ?? null,
    phone: customer.phone ? `+${customer.phone}` : null,
    now: deps.clock.now(),
  });
  if (customer.email) {
    await db.query("update bl.receipts set customer_email = $2 where payment_id = $1 and kind = 'sale' and customer_email is null", [out.payment.id, customer.email]);
  }
  deps.log?.info?.('tournament_fee_created', { payment_id: out.payment.id, club_id: clubId, tournament_id: tournamentId, entry_id: entryId, amount_kopecks: amountKopecks });
  return out;
}

/**
 * Возврат взноса записи целиком (каждая оплаченная попытка), с чеком возврата.
 * @param {{ entryId: string, paymentId?: string, reason: string, reasonCode?: string, requestedBy?: string }} args
 *   paymentId — вернуть только эту попытку (лишняя повторная оплата); reasonCode — код причины
 *   tournaments (в лог; текст причины — reason, в журнал и чек)
 * @param {Function} refund api.mjs refund (ЮKassa, лимит, журнал, outbox payment.refunded)
 * @returns {Promise<{ entry_id, status: 'refunded'|'not_paid', refunds: { payment_id, refund_id, status, amount_kopecks }[], amount_kopecks }>}
 */
export async function refundTournamentFee(db, deps, args, refund) {
  const { entryId } = args;
  if (!UUID.test(entryId ?? '')) throw new MoneyError('bad_request', 'entryId');
  const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
  if (!reason || reason.length > 2000) throw new MoneyError('reason_required');
  if (args.paymentId != null && !UUID.test(args.paymentId)) throw new MoneyError('bad_request', 'paymentId');
  if (args.reasonCode != null && !/^[a-z][a-z0-9_]{0,31}$/.test(args.reasonCode)) throw new MoneyError('bad_request', 'reasonCode');
  // paymentId — только эта попытка (лишняя повторная оплата записи); иначе все оплаченные попытки.
  if (args.paymentId) {
    const { rows } = await db.query("select 1 from bl.payments where id = $1 and entry_id = $2 and kind = 'tournament'", [args.paymentId, entryId]);
    if (rows.length === 0) throw new MoneyError('not_found', 'платёж записи');
  }
  const { rows: paid } = await db.query(
    `select * from bl.payments where entry_id = $1 and kind = 'tournament' and status = 'succeeded'
        and ($2::uuid is null or id = $2) order by created_at, id for update`,
    [entryId, args.paymentId ?? null],
  );
  if (paid.length === 0) return { entry_id: entryId, status: 'not_paid', refunds: [], amount_kopecks: 0 };
  const out = [];
  for (const p of paid) {
    const { rows: sale } = await db.query(
      `select items, customer_phone, customer_email from bl.receipts
        where payment_id = $1 and channel = 'yookassa' and kind = 'sale' order by created_at limit 1`,
      [p.id],
    );
    const items = sale[0]?.items ?? [tournamentItem({ amountKopecks: Number(p.amount_kopecks), vatCode: 1 })];
    const customer = receiptPhone(sale[0]?.customer_phone) ? { phone: receiptPhone(sale[0].customer_phone) } : sale[0]?.customer_email ? { email: sale[0].customer_email } : undefined;
    const r = await refund(db, {
      paymentId: p.id,
      amountKopecks: Number(p.amount_kopecks),
      reason,
      key: `trn-${p.id}`,
      items,
      ...(customer ? { customer } : {}),
      requestedBy: args.requestedBy,
      description: 'Возврат взноса за турнир',
    });
    out.push({ payment_id: p.id, refund_id: r.refund_id, status: r.status, amount_kopecks: Number(p.amount_kopecks) });
  }
  deps.log?.info?.('tournament_fee_refunded', { entry_id: entryId, payment_id: args.paymentId ?? null, reason_code: args.reasonCode ?? null, refunds: out.length });
  return { entry_id: entryId, status: 'refunded', refunds: out, amount_kopecks: out.reduce((x, r) => x + r.amount_kopecks, 0) };
}

/**
 * Отмена турнира клубом: на каждую запись с оплаченным взносом — событие money.tournament_refund
 * (по одному на запись; обработчик — refundTournamentFee, повтор безопасен).
 * @param {{ tournamentId: string, reason: string, requestedBy?: string }} args
 * @returns {Promise<{ tournament_id, entries: string[] }>}
 */
export async function refundTournamentFees(db, deps, args) {
  if (!UUID.test(args.tournamentId ?? '')) throw new MoneyError('bad_request', 'tournamentId');
  const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
  if (!reason || reason.length > 2000) throw new MoneyError('reason_required');
  const { rows } = await db.query(
    `select distinct club_id, entry_id from bl.payments where tournament_id = $1 and kind = 'tournament' and status = 'succeeded' order by entry_id`,
    [args.tournamentId],
  );
  for (const r of rows) {
    await deps.outbox.enqueue(db, TOURNAMENT_REFUND_TOPIC, {
      club_id: r.club_id,
      tournament_id: args.tournamentId,
      entry_id: r.entry_id,
      reason,
      requested_by: UUID.test(args.requestedBy ?? '') ? args.requestedBy : null,
    });
  }
  deps.log?.info?.('tournament_refunds_queued', { tournament_id: args.tournamentId, entries: rows.length });
  return { tournament_id: args.tournamentId, entries: rows.map((r) => r.entry_id) };
}
