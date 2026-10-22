// Оплата котировки и подтверждение платежа (контракт M1 §5, §13; decisions №26, №48, №52).
//
// * POST /api/quotes/{id}/pay: sbp и card — платёж ЮKassa с чеком 54-ФЗ, ключом идемпотентности
//   и return_url на экран ожидания света; reception — заявка на ресепшен (server/reception/).
// * Idempotency-Key клиента хранится в строке платежа (request_key): повтор даёт тот же платёж.
//   Ключ ЮKassa детерминирован (q-<quote_id>-<method>): повтор после сбоя связи не создаёт
//   второй платёж в ЮKassa.
// * Подтверждение (вебхук, сверка по API, опрос гостя) — confirmPayment: в одной транзакции
//   статус, confirmed_at (ровно один раз), журнал payment.succeeded и outbox payment.confirmed.

import { formatDuration } from '../tariffs/engine.mjs';
import { enterObjectClub, isUuid, requireGuestReady, requireIdempotencyKey, requireUser } from './context.mjs';
import { MoneyError, fromNeighbor } from './errors.mjs';
import { yookassaReceipt } from './receipt.mjs';
import { confirmedPayload, insertReceipt, sessionIdOf, stableUuid } from './records.mjs';
import { clientFor, loadPaymentSettings } from './settings.mjs';
import { amountKopecks, YooKassaError } from './yookassa.mjs';
import { createReceptionRequest, receptionResponse } from '../reception/index.mjs';

export const METHODS = Object.freeze(['sbp', 'card', 'reception']);

export function returnUrl(config, paymentId) {
  return config.returnUrlTemplate.replaceAll('{payment_id}', paymentId);
}

/** Ответ на оплату картой или СБП. */
export function paymentResponse(p) {
  return {
    payment_id: p.id,
    status: p.status,
    ...(p.confirmation_url && p.status === 'pending' ? { confirmation: { type: 'redirect', url: p.confirmation_url } } : {}),
  };
}

/** Ошибка ЮKassa → ответ гостю (подробности — в лог). */
function providerFail(err, log, fields) {
  if (err instanceof YooKassaError) {
    log?.warn?.('yookassa_error', { ...fields, status: err.status, code: err.code, parameter: err.parameter, retryable: err.retryable });
    return new MoneyError('payment_failed', err.message, err.retryable ? 503 : 409);
  }
  return err;
}

async function loadQuote(db, quoteId, { lock = false } = {}) {
  const { rows } = await db.query(`select * from bl.quotes where id = $1 ${lock ? 'for update' : ''}`, [quoteId]);
  return rows[0] ?? null;
}

async function resourceNumber(db, resourceId) {
  const { rows } = await db.query('select number from bl.resources where id = $1', [resourceId]);
  return rows[0]?.number ?? null;
}

/** Что и за сколько платим по котировке и способу оплаты. */
export function payPlan(quote, method, settings) {
  const amount = Number(quote.amount_kopecks);
  if (!quote.unlimited) return { amount, minutes: quote.minutes, capture: true, unlimited: false };
  if (method === 'card') return { amount, minutes: quote.hold_minutes, capture: false, unlimited: true };
  if (method === 'sbp') return { amount: Number(quote.block_amount_kopecks), minutes: quote.block_minutes, capture: true, unlimited: true };
  // Ресепшн в M1: «Без лимита» — предоплата за время заморозки как обычное время
  // (депозит с возвратом остатка наличными — вместе с ККТ, M2).
  return { amount, minutes: quote.hold_minutes ?? settings.unlimited_hold_minutes, capture: true, unlimited: false };
}

/**
 * POST /api/quotes/{id}/pay.
 * @returns {{ status: number, json: object }}
 */
export async function payQuote(db, deps, info, config) {
  const quoteId = info.params.id;
  if (!isUuid(quoteId)) throw new MoneyError('not_found', 'quote');
  const method = info.body?.method;
  if (!METHODS.includes(method)) throw new MoneyError('bad_request', 'method');
  const key = requireIdempotencyKey(info);
  requireUser(info);
  const clubId = await enterObjectClub(db, 'quote', quoteId);
  const { userId, phone } = await requireGuestReady(db, info);
  const quote = await loadQuote(db, quoteId, { lock: true });
  if (!quote || quote.user_id !== userId) throw new MoneyError('not_found', 'quote');

  // Повтор с тем же ключом — тот же ответ; тот же ключ с другим запросом — конфликт.
  const prevPay = await db.query('select * from bl.payments where club_id = $1 and request_key = $2', [clubId, key]);
  if (prevPay.rowCount > 0) {
    const p = prevPay.rows[0];
    if (p.quote_id !== quoteId || p.method !== method || p.user_id !== userId) throw new MoneyError('idempotency_conflict');
    return { status: 200, json: paymentResponse(p) };
  }
  const prevReq = await db.query('select * from bl.reception_requests where club_id = $1 and request_key = $2', [clubId, key]);
  if (prevReq.rowCount > 0) {
    const r = prevReq.rows[0];
    if (r.quote_id !== quoteId || method !== 'reception' || r.user_id !== userId) throw new MoneyError('idempotency_conflict');
    return { status: 200, json: receptionResponse(r) };
  }

  const now = deps.clock.now();
  if (quote.used_at) throw new MoneyError('quote_used');
  if (new Date(quote.valid_until).getTime() <= now.getTime()) throw new MoneyError('quote_expired');

  const settings = await loadPaymentSettings(db, clubId);
  const number = await resourceNumber(db, quote.resource_id);
  const plan = payPlan(quote, method, settings);

  if (method === 'reception') {
    if (!settings.reception) throw new MoneyError('bad_request', 'ресепшн не принимает оплату');
    const r = await createReceptionRequest(db, deps, { quote, plan, settings, resourceNumber: number, userId, key, now });
    await db.query('update bl.quotes set used_at = $2 where id = $1', [quoteId, now]);
    return { status: 200, json: receptionResponse(r) };
  }

  if (method === 'sbp' && !settings.sbp) throw new MoneyError('bad_request', 'СБП недоступна');
  if (method === 'card' && !settings.card) throw new MoneyError('bad_request', 'карта недоступна');

  const paymentId = stableUuid(`bl.payment/${quoteId}/${method}`);
  const ykKey = `q-${quoteId}-${method}`;
  const receipt = yookassaReceipt({ phone, resourceNumber: number, minutes: plan.unlimited && plan.capture === false ? null : plan.minutes, amountKopecks: plan.amount, settings });
  const body = {
    amount: { value: (plan.amount / 100).toFixed(2), currency: 'RUB' },
    capture: plan.capture,
    confirmation: { type: 'redirect', return_url: returnUrl(config, paymentId) },
    payment_method_data: { type: method === 'sbp' ? 'sbp' : 'bank_card' },
    description: `Стол ${number}, ${plan.unlimited && !plan.capture ? 'без лимита' : formatDuration(plan.minutes)}`,
    metadata: { club_id: clubId, quote_id: quoteId, kind: quote.kind, payment_id: paymentId },
    receipt,
  };
  let remote;
  try {
    const client = clientFor(settings, config);
    remote = await client.createPayment(body, ykKey);
  } catch (err) {
    throw providerFail(err, deps.log, { quote_id: quoteId, method });
  }
  const remoteAmount = amountKopecks(remote?.amount);
  if (typeof remote?.id !== 'string' || remoteAmount !== plan.amount || !['pending', 'waiting_for_capture', 'succeeded', 'canceled'].includes(remote.status)) {
    deps.log?.error?.('yookassa_bad_create', { quote_id: quoteId, status: remote?.status });
    throw new MoneyError('payment_failed', 'ответ ЮKassa не совпал с запросом', 503);
  }
  const confirmationUrl = remote.confirmation?.confirmation_url ?? null;
  const ins = await db.query(
    `insert into bl.payments (id, club_id, resource_id, user_id, quote_id, session_id, kind, provider, method,
                              provider_payment_id, idempotence_key, request_key, status, amount_kopecks, capture,
                              minutes, unlimited, confirmation_url, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'yookassa', $8, $9, $10, $11, 'pending', $12, $13, $14, $15, $16, $17, $17)
     returning *`,
    [paymentId, clubId, quote.resource_id, userId, quoteId, quote.session_id, quote.kind, method, remote.id, ykKey, key,
      plan.amount, plan.capture, plan.minutes, plan.unlimited, confirmationUrl, now],
  );
  await db.query('update bl.quotes set used_at = $2 where id = $1', [quoteId, now]);
  // Чек продажи (у заморозки — на сумму заморозки; при списании меньшей суммы capture.mjs
  // заменяет его чеком на фактическую сумму, телефон берёт из этой строки).
  await insertReceipt(db, {
    clubId,
    paymentId,
    channel: 'yookassa',
    status: 'pending',
    amountKopecks: plan.amount,
    items: receipt.items,
    taxSystemCode: settings.tax_system_code,
    userId,
    phone,
    now,
  });
  let payment = ins.rows[0];
  // Платёж уже прошёл (ЮKassa вернула конечный статус сразу) — подтверждаем тем же путём.
  if (remote.status !== 'pending') payment = (await applyRemote(db, deps, payment, remote, { source: 'create' })).payment;
  deps.log?.info?.('payment_created', { payment_id: paymentId, club_id: clubId, method, amount_kopecks: plan.amount, capture: plan.capture });
  return { status: 200, json: paymentResponse(payment) };
}

// Подтверждение ---------------------------------------------------------------------------

/**
 * Ровно один раз: статус, confirmed_at, журнал payment.succeeded, outbox payment.confirmed.
 * @returns {Promise<{ payment: object, confirmed: boolean }>}
 */
export async function confirmPayment(db, deps, payment, { status, now, actorType = 'system', actorId = null }) {
  const { rows } = await db.query(
    `update bl.payments set status = $2, confirmed_at = $3, updated_at = $3, checked_at = $3
      where id = $1 and confirmed_at is null and status in ('pending', 'waiting_for_capture', 'succeeded')
      returning *`,
    [payment.id, status, now],
  );
  if (rows.length === 0) return { payment, confirmed: false };
  const p = rows[0];
  await deps.audit.appendAudit(db, {
    action: 'payment.succeeded',
    objectType: 'payment',
    objectId: p.id,
    data: { payment_id: p.id, method: p.method, amount_kopecks: Number(p.amount_kopecks), status: p.status, kind: p.kind },
    actorType,
    actorId,
  });
  await deps.outbox.enqueue(db, 'payment.confirmed', confirmedPayload(p));
  deps.log?.info?.('payment_confirmed', { payment_id: p.id, club_id: p.club_id, method: p.method, status: p.status });
  return { payment: p, confirmed: true };
}

/**
 * Применить состояние платежа из ЮKassa (уже перепроверенное по API ключом клуба).
 * Сверяет id, сумму, валюту и metadata; расхождение — тревога и никаких действий.
 * @returns {Promise<{ result: 'confirmed'|'already'|'pending'|'canceled'|'captured'|'mismatch', payment: object }>}
 */
export async function applyRemote(db, deps, payment, remote, { source = 'webhook' } = {}) {
  const now = deps.clock.now();
  const amount = amountKopecks(remote?.amount);
  const meta = remote?.metadata ?? {};
  const authorized = Number(payment.amount_kopecks);
  const amountOk = payment.capture
    ? amount === authorized
    : amount !== null && amount > 0 && amount <= authorized && (remote.status === 'succeeded' || amount === authorized);
  const problems = [];
  if (remote?.id !== payment.provider_payment_id) problems.push('id');
  if (!amountOk) problems.push('amount');
  if (remote?.amount?.currency !== 'RUB') problems.push('currency');
  if (meta.club_id !== payment.club_id) problems.push('club');
  if (payment.quote_id && meta.quote_id !== payment.quote_id) problems.push('quote');
  if (payment.capture && remote?.status === 'waiting_for_capture') problems.push('unexpected_hold');
  if (problems.length > 0) {
    deps.log?.error?.('payment_mismatch', { payment_id: payment.id, club_id: payment.club_id, source, problems });
    await deps.alarms.raise(db, payment.club_id, {
      type: 'payment_mismatch',
      level: 'critical',
      resourceId: payment.resource_id,
      data: { payment_id: payment.id, problems },
    });
    return { result: 'mismatch', payment };
  }

  await db.query('update bl.payments set checked_at = $2 where id = $1', [payment.id, now]);
  await updateReceiptStatus(db, payment.id, remote.receipt_registration, now);

  switch (remote.status) {
    case 'pending':
      return { result: 'pending', payment };
    case 'waiting_for_capture':
    case 'succeeded': {
      if (!payment.confirmed_at) {
        const r = await confirmPayment(db, deps, payment, { status: remote.status, now });
        if (r.confirmed) payment = r.payment;
        else payment = (await db.query('select * from bl.payments where id = $1', [payment.id])).rows[0];
        if (r.confirmed) return { result: 'confirmed', payment };
      }
      if (remote.status === 'succeeded' && payment.status === 'waiting_for_capture') {
        // Заморозка списана (наш capture или повторная сверка).
        const { rows } = await db.query(
          `update bl.payments set status = 'succeeded', captured_kopecks = $2, captured_at = coalesce(captured_at, $3), updated_at = $3
            where id = $1 and status = 'waiting_for_capture' returning *`,
          [payment.id, amount, now],
        );
        if (rows[0]) return { result: 'captured', payment: rows[0] };
      }
      return { result: 'already', payment };
    }
    case 'canceled':
      return cancelLocal(db, deps, payment, { reason: remote.cancellation_details?.reason ?? null, now });
    default:
      deps.log?.warn?.('payment_unknown_status', { payment_id: payment.id });
      return { result: 'pending', payment };
  }
}

async function updateReceiptStatus(db, paymentId, registration, now) {
  const status = { pending: 'pending', succeeded: 'succeeded', canceled: 'canceled' }[registration];
  if (!status) return;
  await db.query(
    `update bl.receipts set status = $2, updated_at = $3
      where payment_id = $1 and channel = 'yookassa' and kind = 'sale' and status = 'pending' and $2 <> 'pending'`,
    [paymentId, status, now],
  );
}

/** Платёж отменён в ЮKassa: статус, журнал payment.canceled, снять pending со стола (start). */
export async function cancelLocal(db, deps, payment, { reason, now }) {
  const { rows } = await db.query(
    `update bl.payments set status = 'canceled', canceled_at = $3, cancellation_reason = $2, updated_at = $3, checked_at = $3
      where id = $1 and status in ('pending', 'waiting_for_capture') returning *`,
    [payment.id, typeof reason === 'string' ? reason.slice(0, 200) : null, now],
  );
  if (rows.length === 0) return { result: 'already', payment };
  const p = rows[0];
  await deps.audit.appendAudit(db, {
    action: 'payment.canceled',
    objectType: 'payment',
    objectId: p.id,
    data: { payment_id: p.id, method: p.method, amount_kopecks: Number(p.amount_kopecks), reason: p.cancellation_reason },
    actorType: 'system',
  });
  if (payment.status === 'pending' && p.kind === 'start') {
    try {
      await deps.sessions.releasePending(db, { resourceId: p.resource_id, userId: p.user_id });
    } catch (err) {
      deps.log?.warn?.('release_pending_failed', { payment_id: p.id, error: fromNeighbor(err).message });
    }
  }
  deps.log?.info?.('payment_canceled', { payment_id: p.id, club_id: p.club_id, reason: p.cancellation_reason });
  return { result: 'canceled', payment: p };
}

/** Перепроверить платёж по API ЮKassa и применить (опрос гостя, планировщик). */
export async function syncPayment(db, deps, config, payment, { source = 'sync' } = {}) {
  if (payment.provider !== 'yookassa') return { result: 'already', payment };
  const settings = await loadPaymentSettings(db, payment.club_id);
  const client = clientFor(settings, config);
  const remote = await client.getPayment(payment.provider_payment_id);
  return applyRemote(db, deps, payment, remote, { source });
}

/** GET /api/payments/{id}: статус для плательщика; давно в pending — сверка по API. */
export async function paymentStatus(db, deps, info, config) {
  const id = info.params.id;
  if (!isUuid(id)) throw new MoneyError('not_found', 'payment');
  const userId = requireUser(info);
  await enterObjectClub(db, 'payment', id);
  let payment = (await db.query('select * from bl.payments where id = $1', [id])).rows[0];
  if (!payment || payment.user_id !== userId) throw new MoneyError('not_found', 'payment');
  const now = deps.clock.now().getTime();
  const lastCheck = new Date(payment.checked_at ?? payment.created_at).getTime();
  if (payment.status === 'pending' && payment.provider === 'yookassa' && now - lastCheck >= 10_000) {
    try {
      payment = (await syncPayment(db, deps, config, payment, { source: 'poll' })).payment;
    } catch (err) {
      deps.log?.warn?.('payment_poll_failed', { payment_id: id, error: err.message });
    }
  }
  const sessionId = payment.status === 'pending' || payment.status === 'canceled' ? null : await sessionIdOf(db, payment);
  return { payment_id: payment.id, status: payment.status, session_id: sessionId };
}

