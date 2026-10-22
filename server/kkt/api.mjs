// Интерфейс модуля ККТ для соседей (контракт M2 §5; M3 §1 п. 5, 10, 11).
//
//   enqueueReceipt(db, { clubId, kind: 'sell'|'sell_refund', lines, payments, operatorName, paymentId?, saleId?, refundId?,
//                        settlesPaymentId?, settlementKopecks?, customerUserId? })
//     → receipt_id. Строка bl.receipts (channel kkt, receipt_pending) в транзакции вызывающего;
//     мост пробьёт её, когда ККТ на связи. Задание проверяется сразу: неверная позиция или сумма
//     оплат ≠ сумме чека — 400 bad_request (продажа откатится вместе с чеком).
//   outbox receipt.printed { receipt_id, club_id, fd, fp } и receipt.failed { receipt_id, club_id, error }.
//
// lines: позиции в формате чека ЮKassa ({ description, quantity, amount: { value }, vat_code,
//        payment_mode, payment_subject }, как bl.receipts.items M1) или короткие
//        ({ name, price_kopecks, quantity = 1, vat_code?, payment_subject = 'commodity', payment_mode?, measure? });
//        цена — за единицу; ставка НДС по умолчанию — club_payment_settings.vat_code (money).
// payments: [{ method: 'cash' | 'card_terminal' (или 'electronically') | 'prepayment', amount_kopecks }] —
//        сумма равна сумме чека. prepayment — зачёт предоплаты (АТОЛ payments.type = prepaid): чек
//        зачёта брони, пакета часов, депозита (M3). Покрывает только позиции «полный расчёт».
// settlesPaymentId — платёж предоплаты, которую зачитывает чек (bl.receipts.settles_payment_id);
//        settlementKopecks — сумма зачёта (bl.receipts.settlement_kopecks), по умолчанию — сумма оплат
//        prepayment; оплата prepayment без settlesPaymentId — ошибка, и наоборот.
// operatorName — имя сотрудника смены (кассир в чеке, 54-ФЗ).
//
// Повтор (идемпотентность): тот же чек — тот же receipt_id. Ключ — клуб, вид (sale | refund),
// продажа (saleId) или платёж (paymentId), возврат (refundId) и зачитываемый платёж
// (settlesPaymentId). Поэтому у одного платежа различаются чек предоплаты (settles null),
// чек зачёта (settles = платёж предоплаты) и чек возврата (kind refund, refund_id).

import { afterCommit } from '../lib/store.mjs';
import { HttpError } from '../http/errors.mjs';
import { loadPaymentSettings } from '../payments/settings.mjs';
import { formatValue } from '../payments/yookassa.mjs';
import { lineAmount, operatorName as cleanOperator, parseRub, ReceiptDataError, receiptTask } from './atol-task.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KINDS = { sell: 'sale', sell_refund: 'refund' };
/**
 * Оплата чека ККТ: наличные, терминал банка (electronically — как тип оплаты АТОЛ) или зачёт
 * предоплаты (prepayment; АТОЛ prepaid).
 */
const KKT_METHODS = { cash: 'cash', card_terminal: 'card_terminal', electronically: 'card_terminal', prepayment: 'prepayment' };

let kickHook = null;
let clock = { now: () => new Date() };
/** init модуля задаёт, как разбудить очередь клуба после коммита, и часы сервера. */
export function setRuntime({ kick = null, clock: c = null } = {}) {
  kickHook = kick;
  if (c) clock = c;
}

function bad(detail) {
  return new HttpError(400, 'bad_request', { detail });
}

/**
 * Строка позиции → позиция чека в формате bl.receipts.items (как у ЮKassa). Принимается и сам
 * этот формат ({ description, quantity, amount: { value }, vat_code, payment_mode, payment_subject }),
 * и короткий ({ name, price_kopecks, quantity, vat_code?, payment_subject?, payment_mode?, measure? }).
 */
export function lineToItem(line, defaultVat) {
  if (!line || typeof line !== 'object') throw bad('lines');
  const yk = typeof line.description === 'string' && line.amount && typeof line.amount === 'object';
  const name = (yk ? line.description : typeof line.name === 'string' ? line.name : '').trim();
  if (name.length < 1 || name.length > 128) throw bad('lines.name');
  let price;
  if (yk) {
    if (line.amount.currency !== undefined && line.amount.currency !== 'RUB') throw bad('lines.amount.currency');
    try {
      price = parseRub(line.amount.value);
    } catch {
      throw bad('lines.amount.value');
    }
  } else {
    price = line.price_kopecks;
  }
  if (!Number.isSafeInteger(price) || price < 0 || price > 100_000_000) throw bad('lines.price');
  const quantity = line.quantity ?? 1;
  if (typeof quantity !== 'number' || !(quantity > 0) || quantity > 100000 || Math.round(quantity * 1000) !== quantity * 1000) throw bad('lines.quantity');
  if (!yk && line.amount_kopecks !== undefined && line.amount_kopecks !== lineAmount(price, quantity)) throw bad('lines.amount_kopecks');
  const item = {
    description: name,
    quantity,
    amount: { value: formatValue(price), currency: 'RUB' },
    vat_code: line.vat_code ?? defaultVat,
    payment_mode: line.payment_mode ?? 'full_payment',
    payment_subject: line.payment_subject ?? 'commodity',
  };
  if (line.measure !== undefined) item.measure = line.measure;
  return item;
}

/**
 * Поставить чек ККТ в очередь (контракт M2 §5).
 * @param {import('pg').ClientBase} db транзакция вызывающего в контексте клуба clubId
 * @returns {Promise<string>} receipt_id
 */
export async function enqueueReceipt(
  db,
  {
    clubId, kind, lines, payments, operatorName, paymentId = null, saleId = null, refundId = null, settlesPaymentId = null,
    settlementKopecks = null, customerUserId = null, at = null, now = at ? new Date(at) : clock.now(),
  },
) {
  if (typeof clubId !== 'string' || !UUID.test(clubId)) throw bad('clubId');
  const ctxClub = (await db.query('select bl.ctx_club_id() as club_id')).rows[0].club_id;
  if (ctxClub !== clubId) throw new Error('enqueueReceipt: транзакция не в контексте клуба чека');
  const rkind = KINDS[kind];
  if (!rkind) throw bad('kind');
  const ids = [['paymentId', paymentId], ['saleId', saleId], ['refundId', refundId], ['settlesPaymentId', settlesPaymentId], ['customerUserId', customerUserId]];
  for (const [k, v] of ids) {
    if (v !== null && v !== undefined && !(typeof v === 'string' && UUID.test(v))) throw bad(k);
  }
  paymentId ??= null;
  saleId ??= null;
  refundId ??= null;
  settlesPaymentId ??= null;
  if (!paymentId && !saleId && !refundId) throw bad('paymentId, saleId или refundId');
  if (rkind === 'refund' && !refundId && !saleId) throw bad('чек возврата: refundId или saleId');
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 100) throw bad('lines');
  if (!Array.isArray(payments) || payments.length === 0 || payments.length > 5) throw bad('payments');
  for (const p of payments) {
    if (!p || !KKT_METHODS[p.method] || !Number.isSafeInteger(p.amount_kopecks) || p.amount_kopecks <= 0) throw bad('payments');
  }
  // Зачёт предоплаты: оплата prepayment ⇔ settlesPaymentId; сумма зачёта = сумме оплат prepayment.
  const prepaid = payments.reduce((a, p) => (KKT_METHODS[p.method] === 'prepayment' ? a + p.amount_kopecks : a), 0);
  if ((prepaid > 0) !== (settlesPaymentId !== null)) throw bad('оплата prepayment и settlesPaymentId — только вместе');
  if (settlesPaymentId !== null) {
    if (rkind !== 'sale') throw bad('зачёт предоплаты — только в чеке прихода');
    if (settlementKopecks === null || settlementKopecks === undefined) settlementKopecks = prepaid;
    if (!Number.isSafeInteger(settlementKopecks) || settlementKopecks !== prepaid) throw bad('settlementKopecks');
  } else if (settlementKopecks !== null && settlementKopecks !== undefined) {
    throw bad('settlementKopecks без settlesPaymentId');
  } else {
    settlementKopecks = null;
  }

  // Повтор: тот же чек продажи (или платежа) того же вида, того же возврата и того же зачёта.
  const prev = saleId
    ? await db.query(
        `select id from bl.receipts
          where club_id = $1 and channel = 'kkt' and sale_id = $2 and kind = $3
            and refund_id is not distinct from $4::uuid and settles_payment_id is not distinct from $5::uuid
          order by created_at, id limit 1`,
        [clubId, saleId, rkind, refundId, settlesPaymentId],
      )
    : await db.query(
        `select id from bl.receipts
          where club_id = $1 and channel = 'kkt' and payment_id = $2 and kind = $3
            and refund_id is not distinct from $4::uuid and settles_payment_id is not distinct from $5::uuid
          order by created_at, id limit 1`,
        [clubId, paymentId, rkind, refundId, settlesPaymentId],
      );
  if (prev.rows[0]) return prev.rows[0].id;

  if (settlesPaymentId !== null) {
    // Зачитываемый платёж — в этом клубе (RLS) и оплачен.
    const { rows: src } = await db.query('select status from bl.payments where id = $1', [settlesPaymentId]);
    if (!src[0]) throw bad('settlesPaymentId');
    if (src[0].status !== 'succeeded') throw bad('settlesPaymentId: предоплата не оплачена');
  }

  const settings = await loadPaymentSettings(db, clubId);
  const items = lines.map((l) => lineToItem(l, settings.vat_code));
  const amount = items.reduce((a, it) => a + lineAmount(parseRub(it.amount.value), it.quantity), 0);
  const op = cleanOperator(operatorName);
  const pays = payments.map((p) => ({ method: KKT_METHODS[p.method], amount_kopecks: p.amount_kopecks }));
  try {
    receiptTask({ kind: rkind, items, amountKopecks: amount, taxSystemCode: settings.tax_system_code, payments: pays, operatorName: op });
  } catch (err) {
    if (err instanceof ReceiptDataError) throw bad(err.message);
    throw err;
  }
  if (amount <= 0) throw bad('сумма чека');
  const job = { v: 1, state: 'queued', type: rkind === 'refund' ? 'sellReturn' : 'sell', operator_name: op, payments: pays };
  const { rows } = await db.query(
    `insert into bl.receipts (club_id, payment_id, refund_id, sale_id, kind, channel, status, amount_kopecks, items, tax_system_code,
                              customer_user_id, kkt_job, settles_payment_id, settlement_kopecks, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'kkt', 'receipt_pending', $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $13)
     returning id`,
    [clubId, paymentId, refundId, saleId, rkind, amount, JSON.stringify(items), settings.tax_system_code, customerUserId, job, settlesPaymentId, settlementKopecks, now],
  );
  const id = rows[0].id;
  await afterCommit(db, () => kickHook?.(clubId));
  return id;
}

function receiptView(r) {
  const job = r.kkt_job ?? {};
  return {
    id: r.id,
    kind: r.kind,
    status: r.status === 'receipt_pending' && job.state === 'lost' ? 'unknown' : r.status,
    amount_kopecks: Number(r.amount_kopecks),
    payment_id: r.payment_id ?? null,
    sale_id: r.sale_id ?? null,
    refund_id: r.refund_id ?? null,
    settles_payment_id: r.settles_payment_id ?? null,
    settlement_kopecks: r.settlement_kopecks === null || r.settlement_kopecks === undefined ? null : Number(r.settlement_kopecks),
    created_at: new Date(r.created_at).toISOString(),
    attempts: r.attempts,
    error: r.error ?? null,
    next_attempt_at: r.next_attempt_at ? new Date(r.next_attempt_at).toISOString() : null,
    fd: r.fd === null || r.fd === undefined ? null : Number(r.fd),
    fp: r.fp ?? null,
    fn: r.fn ?? null,
    printed_at: r.printed_at ? new Date(r.printed_at).toISOString() : null,
    operator_name: job.operator_name ?? null,
  };
}

/** Чек ККТ по id (для маршрутов и соседей). */
export async function getReceipt(db, id) {
  const { rows } = await db.query(`select * from bl.receipts where id = $1 and channel = 'kkt'`, [id]);
  return rows[0] ? receiptView(rows[0]) : null;
}

/** Чеки ККТ клуба: pending (в очереди), unknown (исход неизвестен), failed, printed. */
export async function listReceipts(db, { clubId, status = 'open', limit = 100 }) {
  const where = {
    open: `status in ('receipt_pending', 'failed')`,
    pending: `status = 'receipt_pending' and coalesce(kkt_job ->> 'state', '') <> 'lost'`,
    unknown: `status = 'receipt_pending' and kkt_job ->> 'state' = 'lost'`,
    failed: `status = 'failed'`,
    printed: `status = 'printed'`,
  }[status];
  if (!where) throw bad('status');
  const { rows } = await db.query(
    `select * from bl.receipts where club_id = $1 and channel = 'kkt' and ${where} order by created_at desc limit $2`,
    [clubId, Math.min(Math.max(Number(limit) || 100, 1), 500)],
  );
  return rows.map(receiptView);
}

/**
 * Повторить чек: failed (после исправления) или «исход неизвестен» (проверили — на ККТ его нет).
 * Новое задание получает новый UUID. Причина обязательна, журнал; при неизвестном исходе —
 * уведомление владельцу (риск второго чека).
 */
export async function retryReceipt(db, deps, { id, userId, reason, now }) {
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (!why) throw new HttpError(400, 'reason_required');
  if (why.length > 500) throw bad('reason');
  const { rows } = await db.query(`select * from bl.receipts where id = $1 and channel = 'kkt' for update`, [id]);
  const r = rows[0];
  if (!r) throw new HttpError(404, 'not_found');
  const job = r.kkt_job ?? {};
  const lost = r.status === 'receipt_pending' && job.state === 'lost';
  if (r.status !== 'failed' && !lost) throw new HttpError(409, 'receipt_not_failed', { detail: 'чек не в ошибке' });
  await db.query(
    `update bl.receipts set status = 'receipt_pending', error = null, next_attempt_at = $2, alarmed_at = null,
            kkt_job = $3, updated_at = $2 where id = $1`,
    [id, now, { ...job, state: 'retry', task_created: true, errors: 0, retried_by: userId, retried_at: now.toISOString() }],
  );
  await deps.audit.appendAudit(db, {
    action: 'kkt.receipt_retry',
    objectType: 'receipt',
    objectId: id,
    reason: why,
    actorType: 'user',
    actorId: userId,
    data: { receipt_id: id, from: lost ? 'unknown' : 'failed', amount_kopecks: Number(r.amount_kopecks) },
  });
  if (lost) {
    await deps.alarms.raise(db, r.club_id, {
      type: 'manual_action',
      level: 'critical',
      manual: true,
      data: { receipt_id: id, action: 'receipt_retry' },
      text: `Чек с неизвестным исходом отправлен на ККТ повторно (${formatValue(Number(r.amount_kopecks)).replace('.', ',')} ₽): ${why}`,
    });
  }
  await afterCommit(db, () => kickHook?.(r.club_id));
  return receiptView({ ...r, status: 'receipt_pending', error: null, kkt_job: { ...job, state: 'retry' } });
}

/**
 * Чек с неизвестным исходом оказался пробит (нашли на ККТ): ФД и ФП вводятся руками.
 * Ручное действие: причина, журнал, уведомление владельцу.
 */
export async function markPrinted(db, deps, { id, userId, reason, fd, fp, fn = null, now }) {
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (!why) throw new HttpError(400, 'reason_required');
  if (why.length > 500) throw bad('reason');
  if (!Number.isSafeInteger(fd) || fd <= 0) throw bad('fd');
  if (typeof fp !== 'string' || !/^\d{1,10}$/.test(fp)) throw bad('fp');
  if (fn !== null && (typeof fn !== 'string' || !/^\d{16}$/.test(fn))) throw bad('fn');
  const { rows } = await db.query(`select * from bl.receipts where id = $1 and channel = 'kkt' for update`, [id]);
  const r = rows[0];
  if (!r) throw new HttpError(404, 'not_found');
  const job = r.kkt_job ?? {};
  if (!(r.status === 'receipt_pending' && job.state === 'lost')) throw new HttpError(409, 'receipt_not_unknown', { detail: 'исход чека известен' });
  // ФН не введён — ФН из ответа ККТ при конфликте (ФН, ФД).
  fn = fn ?? job.conflict?.fn ?? null;
  const dup = await db.query(`select 1 from bl.receipts where club_id = $1 and coalesce(fn, '') = coalesce($2, '') and fd = $3 and id <> $4`, [r.club_id, fn, fd, id]);
  if (dup.rowCount > 0) throw new HttpError(409, 'fd_conflict', { detail: 'ФД уже у другого чека' });
  await db.query(
    `update bl.receipts set status = 'printed', fd = $2, fp = $3, fn = $4, printed_at = $5, error = null, next_attempt_at = null,
            fiscal = coalesce(fiscal, '{}'::jsonb) || $6::jsonb, kkt_job = $7, updated_at = $5 where id = $1`,
    [id, fd, fp, fn, now, { kkt: { manual: true, marked_by: userId } }, { ...job, state: 'done', manual: true }],
  );
  await deps.outbox.enqueue(db, 'receipt.printed', { receipt_id: id, club_id: r.club_id, fd, fp });
  await deps.audit.appendAudit(db, {
    action: 'manual.receipt_mark_printed',
    objectType: 'receipt',
    objectId: id,
    reason: why,
    actorType: 'user',
    actorId: userId,
    data: { receipt_id: id, fd, fp, amount_kopecks: Number(r.amount_kopecks) },
  });
  await deps.alarms.raise(db, r.club_id, {
    type: 'manual_action',
    level: 'critical',
    manual: true,
    data: { receipt_id: id, action: 'receipt_mark_printed' },
    text: `Чек отмечен пробитым вручную (ФД ${fd}): ${why}`,
  });
  return receiptView({ ...r, status: 'printed', fd, fp, fn, printed_at: now });
}
