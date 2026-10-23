// Очередь заданий ККТ клуба в базе (decisions №78, №84): чеки bl.receipts (channel = 'kkt',
// receipt_pending) — и кассы M2, и заявок стола M1 — и служебные задания bl.kkt_ops (смена ККТ).
//
// Одно задание клуба в работе («в полёте»): kkt_job.state = 'sent', привязано к мосту, которому
// отправлено. Пока исход неизвестен, задание повторяется только этому мосту с тем же UUID —
// мост сначала спрашивает АТОЛ о статусе UUID, второй чек не пробивается. Новый UUID (попытка + 1)
// — только после окончательной ошибки АТОЛ по прежнему UUID (документ не сформирован).
//
// Все функции — в транзакции с контекстом клуба (withContext), RLS отсекает чужое.

import { formatMoney } from '@billiardum/shared/format';
import { jobUuid, operatorName, ReceiptDataError, receiptTask, shiftTask, testReceiptTask, testShiftReportTask } from './atol-task.mjs';

/** Повтор задания «в полёте» тому же мосту, если результата нет столько времени. */
export const RESEND_MS = 30_000;
/** Ошибки ФН и прочие неизвестные: столько попыток, затем failed и тревога. */
export const MAX_SOFT_ERRORS = 5;
const RETRY_FOREVER = new Set(['connection', 'paper', 'shift_expired']);
const SOFT = new Set(['fn', 'unknown']);

/** Пауза перед повтором после errors ошибок: 5, 10, 20 … 60 с (retry — настройки для тестов). */
export function backoffMs(errors, retry = {}) {
  const base = retry?.baseMs ?? 5_000;
  const max = retry?.maxMs ?? 60_000;
  return Math.min(max, base * 2 ** Math.max(0, errors - 1));
}

const iso = (d) => (d instanceof Date ? d.toISOString() : d);

async function staffName(db, userId) {
  if (!userId) return null;
  const { rows } = await db.query('select name from bl.users where id = $1', [userId]);
  return rows[0]?.name ?? null;
}

/** Кассир чека: из задания, иначе принявший оплату, вернувший деньги или открывший смену. */
async function receiptOperator(db, r, payment) {
  if (r.kkt_job?.operator_name) return r.kkt_job.operator_name;
  let name = await staffName(db, payment?.accepted_by);
  if (!name && r.refund_id) {
    const { rows } = await db.query('select requested_by from bl.refunds where id = $1', [r.refund_id]);
    name = await staffName(db, rows[0]?.requested_by);
  }
  if (!name) {
    const { rows } = await db.query('select opened_by from bl.shifts where club_id = $1 and closed_at is null', [r.club_id]);
    name = await staffName(db, rows[0]?.opened_by);
  }
  return operatorName(name);
}

/** Оплаты чека: из задания (касса M2) или из платежа (заявка стола M1, возврат). */
async function receiptPayments(db, r) {
  let payment = null;
  if (r.payment_id) {
    const { rows } = await db.query('select id, method, accepted_by from bl.payments where id = $1', [r.payment_id]);
    payment = rows[0] ?? null;
  }
  if (Array.isArray(r.kkt_job?.payments) && r.kkt_job.payments.length > 0) return { payment, payments: r.kkt_job.payments };
  if (!payment) throw new ReceiptDataError('нет платежа чека');
  return { payment, payments: [{ method: payment.method, amount_kopecks: Number(r.amount_kopecks) }] };
}

/**
 * Собрать JSON-задание АТОЛ для чека. Чек тестового режима клуба (receipts.is_test, M5.1 №153) —
 * нефискальный документ «ТЕСТ» (testReceiptTask), мост получает test: true.
 */
export async function buildReceiptTask(db, r) {
  const { payment, payments } = await receiptPayments(db, r);
  const name = await receiptOperator(db, r, payment);
  if (r.is_test) {
    return { task: testReceiptTask({ kind: r.kind, items: r.items, amountKopecks: Number(r.amount_kopecks), operatorName: name }), payments, operatorName: name, test: true };
  }
  const task = receiptTask({
    kind: r.kind,
    items: r.items,
    amountKopecks: Number(r.amount_kopecks),
    taxSystemCode: r.tax_system_code,
    payments,
    operatorName: name,
  });
  return { task, payments, operatorName: name };
}

function nextUuid(row, job) {
  const attempt = Number(job.attempt ?? 0);
  // Задание с прежним UUID есть в АТОЛ и завершилось ошибкой — нужен новый UUID.
  if (attempt === 0) return { attempt: 1, uuid: jobUuid(row.id, 1) };
  if (job.state === 'retry' && job.task_created) return { attempt: attempt + 1, uuid: jobUuid(row.id, attempt + 1) };
  return { attempt, uuid: job.uuid ?? jobUuid(row.id, attempt) };
}

function jobMessage(source, row, job) {
  return {
    source,
    id: row.id,
    kind: source === 'op' ? row.kind : 'receipt',
    uuid: job.uuid,
    request: [job.task],
    bridgeId: job.bridge_id,
    attempt: job.attempt,
    // M5.1 №153: тестовый режим клуба — мост печатает только нефискальный документ.
    ...(row.is_test ? { test: true } : {}),
  };
}

async function inflight(db, clubId) {
  const ops = await db.query(
    `select 'op' as source, o.* from bl.kkt_ops o
      where o.club_id = $1 and o.status = 'pending' and o.kkt_job ->> 'state' = 'sent'
      order by o.created_at limit 1 for update`,
    [clubId],
  );
  if (ops.rows[0]) return ops.rows[0];
  const rec = await db.query(
    `select 'receipt' as source, r.* from bl.receipts r
      where r.club_id = $1 and r.channel = 'kkt' and r.status = 'receipt_pending' and r.kkt_job ->> 'state' = 'sent'
      order by r.created_at limit 1 for update`,
    [clubId],
  );
  return rec.rows[0] ?? null;
}

/**
 * Задание для моста: «в полёте» (повтор тому же мосту) или следующее из очереди.
 * @param {{ clubId: string, connected: string[], now: Date, deps: object }} args connected — мосты клуба на связи (первый — основной)
 * @returns {Promise<{ job: object } | { wait: string } | { none: true }>}
 */
export async function claimJob(db, { clubId, connected, now, deps }) {
  const cur = await inflight(db, clubId);
  if (cur) {
    const job = cur.kkt_job;
    if (!connected.includes(job.bridge_id)) return { wait: job.bridge_id };
    const next = { ...job, sent_at: iso(now) };
    if (cur.source === 'op') await db.query('update bl.kkt_ops set kkt_job = $2, updated_at = $3 where id = $1', [cur.id, next, now]);
    else await db.query('update bl.receipts set kkt_job = $2, attempts = attempts + 1, updated_at = $3 where id = $1', [cur.id, next, now]);
    return { job: jobMessage(cur.source, cur, next), resend: true };
  }
  if (connected.length === 0) return { none: true };
  const bridgeId = connected[0];

  for (let guard = 0; guard < 20; guard += 1) {
    // Служебные задания (смена ККТ) — раньше чеков: закрыть просроченную смену, иначе чек не пробить.
    const op = await db.query(
      `select 'op' as source, o.* from bl.kkt_ops o
        where o.club_id = $1 and o.status = 'pending' and coalesce(o.kkt_job ->> 'state', 'queued') not in ('sent', 'lost')
          and (o.next_attempt_at is null or o.next_attempt_at <= $2)
        order by o.created_at limit 1 for update skip locked`,
      [clubId, now],
    );
    let row = op.rows[0];
    if (!row) {
      const rec = await db.query(
        `select 'receipt' as source, r.* from bl.receipts r
          where r.club_id = $1 and r.channel = 'kkt' and r.status = 'receipt_pending'
            and coalesce(r.kkt_job ->> 'state', 'queued') not in ('sent', 'lost')
            and (r.next_attempt_at is null or r.next_attempt_at <= $2)
          order by r.created_at limit 1 for update skip locked`,
        [clubId, now],
      );
      row = rec.rows[0];
    }
    if (!row) return { none: true };
    const prev = row.kkt_job ?? {};
    const { attempt, uuid } = nextUuid(row, prev);
    let task;
    let extra = {};
    if (row.source === 'op' && row.is_test) {
      // Тестовый режим (M5.1 №153): смена ККТ не открывается; закрытие — нефискальный отчёт «ТЕСТ».
      if (row.kind !== 'close_shift') {
        await db.query(`update bl.kkt_ops set status = 'skipped', result = $2, done_at = $3, updated_at = $3 where id = $1`, [row.id, { test: true, outcome: 'skipped' }, now]);
        continue;
      }
      task = testShiftReportTask(await testShiftSummary(db, row));
      extra = { test: true };
    } else if (row.source === 'op') {
      task = shiftTask(row.kind, row.operator_name);
    } else {
      try {
        const built = await buildReceiptTask(db, row);
        task = built.task;
        extra = { payments: built.payments, operator_name: built.operatorName, ...(built.test ? { test: true } : {}) };
      } catch (err) {
        if (!(err instanceof ReceiptDataError)) throw err;
        deps.log?.warn?.('kkt_receipt_invalid', { receipt_id: row.id, error: err.message });
        await failReceipt(db, deps, row, { code: 'invalid_receipt', now });
        continue;
      }
    }
    const uuids = Array.isArray(prev.uuids) ? [...prev.uuids] : [];
    if (!uuids.includes(uuid)) uuids.push(uuid);
    const job = {
      v: 1,
      ...prev,
      ...extra,
      type: task.type,
      uuid,
      uuids,
      attempt,
      state: 'sent',
      task_created: prev.uuid === uuid ? Boolean(prev.task_created) : false,
      bridge_id: bridgeId,
      sent_at: iso(now),
      task,
    };
    if (row.source === 'op') {
      await db.query('update bl.kkt_ops set kkt_job = $2, attempts = attempts + 1, updated_at = $3 where id = $1', [row.id, job, now]);
    } else {
      await db.query('update bl.receipts set kkt_job = $2, attempts = attempts + 1, updated_at = $3 where id = $1', [row.id, job, now]);
    }
    return { job: jobMessage(row.source, row, job) };
  }
  return { none: true };
}

/** Чек не пробить без исправления: failed, событие receipt.failed, журнал, тревога. */
export async function failReceipt(db, deps, row, { code, now, description = null }) {
  const job = { ...(row.kkt_job ?? {}), state: 'failed', failed_at: iso(now) };
  await db.query(
    `update bl.receipts set status = 'failed', error = $2, kkt_job = $3, next_attempt_at = null, updated_at = $4
      where id = $1 and status = 'receipt_pending'`,
    [row.id, code, job, now],
  );
  await deps.outbox.enqueue(db, 'receipt.failed', { receipt_id: row.id, club_id: row.club_id, error: code });
  await deps.audit.appendAudit(db, {
    action: 'kkt.receipt_failed',
    objectType: 'receipt',
    objectId: row.id,
    actorType: 'system',
    actorId: null,
    data: { receipt_id: row.id, error: code, amount_kopecks: Number(row.amount_kopecks), ...(description ? { atol: String(description).slice(0, 120) } : {}) },
  });
  await deps.alarms.raise(db, row.club_id, {
    type: 'receipt_failed',
    level: 'important',
    data: { receipt_id: row.id, error: code },
    text: `Чек ККТ не пробит (${formatMoney(Number(row.amount_kopecks))}): ошибка ${code}. Проверьте ККТ и повторите в программе клуба`,
  });
}

function fiscalOf(msg) {
  const f = msg?.fiscal ?? {};
  const fd = Number(f.fd);
  if (!Number.isSafeInteger(fd) || fd <= 0) return null;
  return {
    fd,
    fp: typeof f.fp === 'string' && /^\d{1,10}$/.test(f.fp) ? f.fp : null,
    fn: typeof f.fn === 'string' && /^\d{16}$/.test(f.fn) ? f.fn : null,
    extra: {
      receipt_number: Number.isSafeInteger(f.receipt_number) ? f.receipt_number : null,
      shift_number: Number.isSafeInteger(f.shift_number) ? f.shift_number : null,
      registration_number: typeof f.registration_number === 'string' ? f.registration_number.slice(0, 20) : null,
      datetime: typeof f.datetime === 'string' ? f.datetime.slice(0, 40) : null,
      partial: Boolean(f.partial),
    },
  };
}

function errorOf(msg) {
  const e = msg?.error ?? {};
  const code = typeof e.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(e.code) ? e.code : 'kkt_error';
  const category = ['connection', 'paper', 'fn', 'shift_expired', 'invalid', 'unknown'].includes(e.category) ? e.category : 'unknown';
  return { code, category, description: typeof e.description === 'string' ? e.description.slice(0, 200) : null };
}

/**
 * Результат моста. db — транзакция в контексте клуба моста.
 * @returns {Promise<{ ack: boolean, done: boolean, retry?: boolean, category?: string, source?: string, id?: string }>}
 *   ack — подтвердить мосту (результат записан или устарел); done — задание «в полёте» завершено.
 */
export async function applyResult(db, deps, { clubId, bridgeId, msg, now }) {
  const uuid = msg.uuid;
  const rec = await db.query(
    `select * from bl.receipts
      where club_id = $1 and channel = 'kkt' and kkt_job -> 'uuids' @> jsonb_build_array($2::text)
      for update`,
    [clubId, uuid],
  );
  if (rec.rows[0]) return applyReceiptResult(db, deps, rec.rows[0], { bridgeId, msg, now });
  const op = await db.query(
    `select * from bl.kkt_ops where club_id = $1 and kkt_job -> 'uuids' @> jsonb_build_array($2::text) for update`,
    [clubId, uuid],
  );
  if (op.rows[0]) return applyOpResult(db, deps, op.rows[0], { bridgeId, msg, now });
  deps.log?.warn?.('kkt_result_unknown_uuid', { club_id: clubId, bridge_id: bridgeId });
  return { ack: true, done: false };
}

async function applyReceiptResult(db, deps, r, { bridgeId, msg, now }) {
  const job = r.kkt_job ?? {};
  const current = job.uuid === msg.uuid;
  const fromSender = job.bridge_id === bridgeId;
  if (r.status === 'printed') return { ack: true, done: current, source: 'receipt', id: r.id };

  if (msg.outcome === 'done' && r.is_test) return applyTestReceiptResult(db, deps, r, { bridgeId, msg, now, current });

  if (msg.outcome === 'done') {
    const f = fiscalOf(msg);
    if (!f) {
      deps.log?.warn?.('kkt_result_no_fiscal', { receipt_id: r.id });
      return { ack: false, done: false };
    }
    if (!fromSender) deps.log?.warn?.('kkt_result_other_bridge', { receipt_id: r.id, bridge_id: bridgeId });
    // Пара (ФН, ФД) уже у другого чека клуба: ККТ или драйвер сброшены (замена ФН, эмулятор начал
    // счёт заново). Чек откладывается с неизвестным исходом и критичной тревогой, очередь идёт дальше.
    const dup = await db.query(
      `select id from bl.receipts where club_id = $1 and coalesce(fn, '') = coalesce($2, '') and fd = $3 and id <> $4 limit 1`,
      [r.club_id, f.fn, f.fd, r.id],
    );
    if (dup.rows[0]) {
      if (job.state === 'lost' && job.conflict?.uuid === msg.uuid) return { ack: true, done: current, source: 'receipt', id: r.id };
      const conflict = { uuid: msg.uuid, fd: f.fd, fn: f.fn, other_receipt_id: dup.rows[0].id, bridge_id: bridgeId };
      await db.query(`update bl.receipts set error = 'fd_conflict', next_attempt_at = null, kkt_job = $2, updated_at = $3 where id = $1`, [
        r.id,
        { ...job, state: 'lost', task_created: true, conflict, last_error: { code: 'fd_conflict', category: 'unknown' } },
        now,
      ]);
      await deps.audit.appendAudit(db, {
        action: 'kkt.receipt_conflict',
        objectType: 'receipt',
        objectId: r.id,
        actorType: 'system',
        actorId: null,
        data: { receipt_id: r.id, fd: f.fd, fn: f.fn, other_receipt_id: dup.rows[0].id, amount_kopecks: Number(r.amount_kopecks) },
      });
      await deps.alarms.raise(db, r.club_id, {
        type: 'receipt_fd_conflict',
        level: 'critical',
        data: { receipt_id: r.id, fd: f.fd, other_receipt_id: dup.rows[0].id },
        text: `ККТ вернула номер ФД ${f.fd}, который уже есть у другого чека: проверьте ККТ (замена ФН, переустановка драйвера). Чек на ${formatMoney(Number(r.amount_kopecks))} отложен, остальные пробиваются`,
      });
      deps.log?.error?.('kkt_receipt_fd_conflict', { receipt_id: r.id, club_id: r.club_id, fd: f.fd, other_receipt_id: dup.rows[0].id });
      return { ack: true, done: true, source: 'receipt', id: r.id, conflict: true };
    }
    if (!current && job.state === 'sent') {
      // Пробит по прежнему UUID, а новое задание уже отправлено: возможен второй чек.
      await deps.alarms.raise(db, r.club_id, {
        type: 'receipt_double',
        level: 'critical',
        data: { receipt_id: r.id },
        text: `Возможен второй чек на ККТ (${formatMoney(Number(r.amount_kopecks))}): проверьте последние чеки`,
      });
    }
    const fiscal = { ...(r.fiscal ?? {}), kkt: { ...f.extra, bridge_id: bridgeId, uuid: msg.uuid } };
    await db.query(
      `update bl.receipts
          set status = 'printed', fd = $2, fp = $3, fn = $4, printed_at = $5, fiscal = $6, error = null,
              next_attempt_at = null, kkt_job = $7, updated_at = $5
        where id = $1`,
      [r.id, f.fd, f.fp, f.fn, now, fiscal, { ...job, state: 'done', task_created: true, done_uuid: msg.uuid }],
    );
    await deps.outbox.enqueue(db, 'receipt.printed', { receipt_id: r.id, club_id: r.club_id, fd: f.fd, fp: f.fp });
    await deps.audit.appendAudit(db, {
      action: 'kkt.receipt_printed',
      objectType: 'receipt',
      objectId: r.id,
      actorType: 'system',
      actorId: null,
      data: {
        receipt_id: r.id,
        kind: r.kind,
        payment_id: r.payment_id ?? null,
        sale_id: r.sale_id ?? null,
        amount_kopecks: Number(r.amount_kopecks),
        fd: f.fd,
        fp: f.fp,
        fn: f.fn,
        attempt: job.attempt ?? null,
      },
    });
    deps.log?.info?.('kkt_receipt_printed', { receipt_id: r.id, club_id: r.club_id, fd: f.fd, attempt: job.attempt ?? null });
    return { ack: true, done: true, printed: true, source: 'receipt', id: r.id };
  }

  if (!current || job.state !== 'sent') return { ack: true, done: false };

  if (msg.outcome === 'in_progress') {
    const e = msg.error ? errorOf(msg) : null;
    await db.query('update bl.receipts set kkt_job = $2, updated_at = $3 where id = $1', [
      r.id,
      { ...job, progress_at: iso(now), task_created: Boolean(msg.task_created) || Boolean(job.task_created), ...(e ? { last_error: e } : {}) },
      now,
    ]);
    return { ack: false, done: false, category: e?.category };
  }

  if (msg.outcome === 'unknown') {
    const e = errorOf(msg);
    await db.query(`update bl.receipts set error = $2, kkt_job = $3, updated_at = $4 where id = $1`, [
      r.id,
      e.code,
      { ...job, state: 'lost', task_created: true, last_error: e },
      now,
    ]);
    await deps.audit.appendAudit(db, {
      action: 'kkt.receipt_unknown',
      objectType: 'receipt',
      objectId: r.id,
      actorType: 'system',
      actorId: null,
      data: { receipt_id: r.id, error: e.code, amount_kopecks: Number(r.amount_kopecks) },
    });
    await deps.alarms.raise(db, r.club_id, {
      type: 'receipt_unknown',
      level: 'critical',
      data: { receipt_id: r.id, error: e.code },
      text: `Исход чека на ККТ неизвестен (${formatMoney(Number(r.amount_kopecks))}): проверьте ККТ и отметьте чек в программе клуба`,
    });
    return { ack: true, done: true, source: 'receipt', id: r.id };
  }

  // outcome error: документ не сформирован.
  const e = errorOf(msg);
  const errors = Number(job.errors ?? 0) + 1;
  if (e.category === 'invalid' || (SOFT.has(e.category) && errors >= MAX_SOFT_ERRORS)) {
    await failReceipt(db, deps, { ...r, kkt_job: { ...job, errors, last_error: e, task_created: Boolean(msg.task_created) } }, { code: e.code, now, description: e.description });
    return { ack: true, done: true, failed: true, source: 'receipt', id: r.id, category: e.category };
  }
  const next = new Date(now.getTime() + backoffMs(errors, deps.retry));
  await db.query(
    `update bl.receipts set error = $2, next_attempt_at = $3, kkt_job = $4, updated_at = $5 where id = $1`,
    [r.id, e.code, next, { ...job, state: 'retry', errors, last_error: e, task_created: Boolean(msg.task_created) }, now],
  );
  if (e.category === 'shift_expired') await ensureOp(db, { clubId: r.club_id, kind: 'close_shift', operatorName: job.operator_name ?? null, auto: true, now });
  deps.log?.info?.('kkt_receipt_retry', { receipt_id: r.id, error: e.code, category: e.category, errors, retry_in_ms: next.getTime() - now.getTime() });
  return { ack: true, done: true, retry: true, source: 'receipt', id: r.id, category: e.category };
}

/**
 * Нефискальный «ТЕСТ» напечатан (M5.1 №153): чек тестового режима закрыт без фискальных реквизитов
 * (fd, fp, fn пустые; fiscal.test = true). Фискального документа нет — сверка ФД не нужна.
 */
async function applyTestReceiptResult(db, deps, r, { bridgeId, msg, now, current }) {
  const job = r.kkt_job ?? {};
  const fiscal = { ...(r.fiscal ?? {}), test: true, kkt: { bridge_id: bridgeId, uuid: msg.uuid, non_fiscal: true } };
  await db.query(
    `update bl.receipts set status = 'printed', printed_at = $2, fiscal = $3, error = null, next_attempt_at = null, kkt_job = $4, updated_at = $2
      where id = $1`,
    [r.id, now, fiscal, { ...job, state: 'done', task_created: true, done_uuid: msg.uuid }],
  );
  await deps.outbox.enqueue(db, 'receipt.printed', { receipt_id: r.id, club_id: r.club_id, fd: null, fp: null, test: true });
  await deps.audit.appendAudit(db, {
    action: 'kkt.receipt_test_printed',
    objectType: 'receipt',
    objectId: r.id,
    actorType: 'system',
    actorId: null,
    data: { receipt_id: r.id, kind: r.kind, payment_id: r.payment_id ?? null, sale_id: r.sale_id ?? null, amount_kopecks: Number(r.amount_kopecks), test: true },
  });
  deps.log?.info?.('kkt_receipt_test_printed', { receipt_id: r.id, club_id: r.club_id });
  return { ack: true, done: current, printed: true, test: true, source: 'receipt', id: r.id };
}

/** Номер смены, кассир и тестовые продажи наличными и терминалом за смену — для отчёта «ТЕСТ». */
async function testShiftSummary(db, op) {
  if (!op.shift_id) return { operatorName: op.operator_name };
  const { rows } = await db.query('select number, opened_at, closed_at from bl.shifts where id = $1', [op.shift_id]);
  const s = rows[0];
  if (!s) return { operatorName: op.operator_name };
  const { rows: p } = await db.query(
    `select count(*)::int as n, coalesce(sum(amount_kopecks), 0)::bigint as k from bl.payments
      where club_id = $1 and is_test and status = 'succeeded' and method in ('cash', 'card_terminal')
        and confirmed_at >= $2 and confirmed_at <= coalesce($3, now())`,
    [op.club_id, s.opened_at, s.closed_at],
  );
  return { number: s.number, operatorName: op.operator_name, sales: { count: p[0].n, kopecks: Number(p[0].k) } };
}

/** Тестовый режим для задания смены: по смене клуба, без смены — по режиму клуба (как триггер bl.set_is_test). */
async function opIsTest(db, clubId, shiftId) {
  if (shiftId) {
    const { rows } = await db.query('select is_test from bl.shifts where id = $1', [shiftId]);
    if (rows[0]) return rows[0].is_test;
  }
  const { rows } = await db.query('select bl.club_mode($1) as m, (select mode_before_suspend from bl.clubs where id = $1) as b', [clubId]);
  return rows[0].m === 'test' || (rows[0].m === 'suspended' && rows[0].b === 'test');
}

/**
 * Служебное задание смены ККТ, если такого же ещё нет в очереди. Тестовый режим клуба (M5.1 №153):
 * open_shift не создаётся (null) — смена ККТ не открывается; close_shift — нефискальный отчёт «ТЕСТ».
 */
export async function ensureOp(db, { clubId, kind, shiftId = null, operatorName: name = null, auto = false, now }) {
  if (kind === 'open_shift' && (await opIsTest(db, clubId, shiftId))) return null;
  const { rows } = await db.query(`select id from bl.kkt_ops where club_id = $1 and kind = $2 and status = 'pending' limit 1`, [clubId, kind]);
  if (rows[0]) return rows[0].id;
  const ins = await db.query(
    `insert into bl.kkt_ops (club_id, shift_id, kind, operator_name, result, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $6) returning id`,
    [clubId, shiftId, kind, name ? operatorName(name) : null, auto ? { auto: true } : null, now],
  );
  return ins.rows[0].id;
}

async function applyOpResult(db, deps, o, { bridgeId, msg, now }) {
  const job = o.kkt_job ?? {};
  if (o.status !== 'pending') return { ack: true, done: job.uuid === msg.uuid };
  if (job.uuid !== msg.uuid || job.state !== 'sent') return { ack: true, done: false };
  if (msg.outcome === 'in_progress') return { ack: false, done: false };
  if (msg.outcome === 'done' || msg.outcome === 'skipped') {
    const f = msg.outcome === 'done' ? fiscalOf(msg) : null;
    const result = { ...(o.result ?? {}), outcome: msg.outcome, bridge_id: bridgeId, ...(f ? { fd: f.fd, fp: f.fp, ...f.extra } : {}), ...(msg.shift ? { shift: msg.shift } : {}) };
    await db.query(
      `update bl.kkt_ops set status = $2, result = $3, kkt_job = $4, error = null, done_at = $5, updated_at = $5 where id = $1`,
      [o.id, msg.outcome === 'done' ? 'done' : 'skipped', result, { ...job, state: 'done' }, now],
    );
    await deps.audit.appendAudit(db, {
      action: o.kind === 'open_shift' ? 'kkt.shift_open' : 'kkt.shift_close',
      objectType: 'kkt_op',
      objectId: o.id,
      actorType: 'system',
      actorId: null,
      data: { op_id: o.id, shift_id: o.shift_id ?? null, outcome: msg.outcome, fd: f?.fd ?? null, kkt_shift_number: f?.extra.shift_number ?? null, auto: Boolean(o.result?.auto), ...(o.is_test ? { test: true } : {}) },
    });
    return { ack: true, done: true, source: 'op', id: o.id };
  }
  const e = errorOf(msg);
  const errors = Number(job.errors ?? 0) + 1;
  if (msg.outcome === 'unknown' || e.category === 'invalid' || (!RETRY_FOREVER.has(e.category) && errors >= MAX_SOFT_ERRORS)) {
    await db.query(`update bl.kkt_ops set status = 'failed', error = $2, kkt_job = $3, done_at = $4, updated_at = $4 where id = $1`, [
      o.id,
      e.code,
      { ...job, state: 'failed', errors, last_error: e },
      now,
    ]);
    await deps.alarms.raise(db, o.club_id, {
      type: 'kkt_shift_failed',
      level: 'important',
      data: { op_id: o.id, error: e.code },
      text: `ККТ: не удалось ${o.kind === 'open_shift' ? 'открыть' : 'закрыть'} смену (ошибка ${e.code}). Проверьте ККТ`,
    });
    return { ack: true, done: true, failed: true, source: 'op', id: o.id };
  }
  const next = new Date(now.getTime() + backoffMs(errors, deps.retry));
  await db.query(`update bl.kkt_ops set error = $2, next_attempt_at = $3, kkt_job = $4, updated_at = $5 where id = $1`, [
    o.id,
    e.code,
    next,
    { ...job, state: 'retry', errors, last_error: e, task_created: Boolean(msg.task_created) },
    now,
  ]);
  return { ack: true, done: true, retry: true, source: 'op', id: o.id, category: e.category };
}

/** ККТ снова на связи: повторы по связи и бумаге — сейчас, а не по паузе. */
export async function expediteRetries(db, { clubId, now }) {
  const r = await db.query(
    `update bl.receipts set next_attempt_at = $2
      where club_id = $1 and channel = 'kkt' and status = 'receipt_pending' and kkt_job ->> 'state' = 'retry'
        and kkt_job -> 'last_error' ->> 'category' in ('connection', 'paper') and next_attempt_at > $2`,
    [clubId, now],
  );
  const o = await db.query(
    `update bl.kkt_ops set next_attempt_at = $2
      where club_id = $1 and status = 'pending' and kkt_job ->> 'state' = 'retry' and next_attempt_at > $2`,
    [clubId, now],
  );
  return r.rowCount + o.rowCount;
}

/** Мост отозван: задания «в полёте» на нём — исход неизвестен (проверить руками). */
export async function markBridgeLost(db, deps, { clubId, bridgeId, now }) {
  const { rows } = await db.query(
    `select * from bl.receipts where club_id = $1 and channel = 'kkt' and status = 'receipt_pending'
        and kkt_job ->> 'state' = 'sent' and kkt_job ->> 'bridge_id' = $2 for update`,
    [clubId, bridgeId],
  );
  for (const r of rows) {
    await applyReceiptResult(db, deps, r, {
      bridgeId,
      msg: { uuid: r.kkt_job.uuid, outcome: 'unknown', error: { code: 'bridge_revoked', category: 'unknown' } },
      now,
    });
  }
  await db.query(
    `update bl.kkt_ops set kkt_job = kkt_job || '{"state":"retry","task_created":true}'::jsonb, next_attempt_at = $3, updated_at = $3
      where club_id = $1 and status = 'pending' and kkt_job ->> 'state' = 'sent' and kkt_job ->> 'bridge_id' = $2`,
    [clubId, bridgeId, now],
  );
  return rows.length;
}

/** Сводка очереди клуба для ресепшена и SSE. */
export async function queueSummary(db, clubId) {
  const { rows } = await db.query(
    `select count(*) filter (where status = 'receipt_pending')::int as pending,
            coalesce(sum(amount_kopecks) filter (where status = 'receipt_pending'), 0)::bigint as pending_kopecks,
            min(created_at) filter (where status = 'receipt_pending') as oldest_pending_at,
            count(*) filter (where status = 'receipt_pending' and kkt_job ->> 'state' = 'lost')::int as unknown,
            count(*) filter (where status = 'failed')::int as failed
       from bl.receipts where club_id = $1 and channel = 'kkt' and status in ('receipt_pending', 'failed')`,
    [clubId],
  );
  const s = rows[0];
  return {
    pending: s.pending,
    pending_kopecks: Number(s.pending_kopecks),
    oldest_pending_at: s.oldest_pending_at ? new Date(s.oldest_pending_at).toISOString() : null,
    unknown: s.unknown,
    failed: s.failed,
  };
}
