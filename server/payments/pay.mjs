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
import { amountKopecks, formatValue, YooKassaError } from './yookassa.mjs';
import { createReceptionRequest, receptionResponse } from '../reception/index.mjs';
import { applyDebit, creditPackage, issueBalanceReceipts, planDebit, restoreBalance } from '../packages/balance.mjs';

export const METHODS = Object.freeze(['sbp', 'card', 'reception', 'balance']);

export function returnUrl(config, paymentId) {
  return config.returnUrlTemplate.replaceAll('{payment_id}', paymentId);
}

/** Путь своего сайта (как return_url брони и действия уведомлений core): «/app/…», без хоста и схемы. */
export function localPath(v) {
  return typeof v === 'string' && v.length <= 300 && /^\/[^/\\]/.test(v) && !/[\s<>"\\]/.test(v) && !v.includes('..') ? v : null;
}

/**
 * return_url от гостя или соседнего модуля: путь своего сайта («/app/…») или полный адрес на своём
 * хосте (PUBLIC_HOST или хост PAYMENT_RETURN_URL) с таким же путём. Иначе — bad_request
 * (открытый редирект через страницу оплаты ЮKassa не допускаем). Нет значения — null.
 */
export function ownReturnUrl(config, value) {
  if (value === undefined || value === null) return null;
  const base = new URL(returnUrl(config, 'x')).origin;
  const origins = [base, ...(config.publicHost ? [`https://${config.publicHost}`] : [])];
  let path = value;
  if (typeof value === 'string' && !value.startsWith('/')) {
    const origin = origins.find((o) => value.startsWith(`${o}/`));
    if (!origin) throw new MoneyError('bad_request', 'return_url');
    path = value.slice(origin.length);
  }
  if (!localPath(path)) throw new MoneyError('bad_request', 'return_url');
  return `${base}${path}`;
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
  const balanceMinutes = quote.balance_minutes ?? 0;

  // Часть или всё время — балансом пакетов (№112).
  if (method === 'balance') {
    if (balanceMinutes === 0 || Number(quote.amount_kopecks) !== 0) throw new MoneyError('bad_request', 'балансом не покрыто всё время');
    return { status: 200, json: await payByBalance(db, deps, { quote, userId, key, now }) };
  }
  if (balanceMinutes > 0 && method === 'reception') throw new MoneyError('bad_request', 'остаток при оплате балансом — СБП или картой');
  // Доплата при старте по брони (№116) — СБП или картой; на ресепшене бронь начинает «гость пришёл».
  if (quote.kind === 'booking_start' && method === 'reception') throw new MoneyError('bad_request', 'доплата по брони — СБП или картой');
  if (balanceMinutes > 0 && Number(quote.amount_kopecks) === 0) throw new MoneyError('bad_request', 'всё время покрыто балансом: method balance');
  const debit = balanceMinutes > 0 ? await planDebit(db, { clubId, userId, minutes: balanceMinutes, now }) : null;

  if (method === 'reception') {
    if (!settings.reception) throw new MoneyError('bad_request', 'ресепшн не принимает оплату');
    const r = await createReceptionRequest(db, deps, { quote, plan, settings, resourceNumber: number, userId, key, now });
    await db.query('update bl.quotes set used_at = $2 where id = $1', [quoteId, now]);
    return { status: 200, json: receptionResponse(r) };
  }

  if (method === 'sbp' && !settings.sbp) throw new MoneyError('bad_request', 'СБП недоступна');
  if (method === 'card' && !settings.card) throw new MoneyError('bad_request', 'карта недоступна');

  const paymentId = stableUuid(`bl.payment/${quoteId}/${method}`);
  const paidMinutes = plan.minutes === null ? null : plan.minutes - balanceMinutes;
  const receipt = yookassaReceipt({ phone, resourceNumber: number, minutes: plan.unlimited && plan.capture === false ? null : paidMinutes, amountKopecks: plan.amount, settings });
  const { payment } = await createYooKassaPayment(db, deps, config, {
    settings,
    clubId,
    paymentId,
    idempotenceKey: `q-${quoteId}-${method}`,
    requestKey: key,
    kind: quote.kind,
    method,
    amountKopecks: plan.amount,
    capture: plan.capture,
    receipt,
    confirmation: { type: 'redirect', returnUrl: returnUrl(config, paymentId) },
    description: `${quote.kind === 'booking_start' ? 'Бронь, стол' : 'Стол'} ${number}, ${plan.unlimited && !plan.capture ? 'без лимита' : formatDuration(plan.minutes)}`,
    metadata: { quote_id: quoteId, ...(quote.booking_id ? { booking_id: quote.booking_id } : {}) },
    bookingId: quote.booking_id ?? null,
    quoteId,
    sessionId: quote.session_id,
    resourceId: quote.resource_id,
    userId,
    minutes: plan.minutes,
    unlimited: plan.unlimited,
    balanceMinutes,
    phone,
    now,
  });
  // Минуты баланса списываются сразу (резерв): отмена платежа вернёт их, подтверждение даст чек зачёта.
  if (debit) await applyDebit(db, debit, { paymentId: payment.id, userId, now });
  await db.query('update bl.quotes set used_at = $2 where id = $1', [quoteId, now]);
  return { status: 200, json: paymentResponse(payment) };
}

/** Всё время котировки — балансом: платёж balance (стоимость — доля цены пакетов), сразу подтверждён. */
async function payByBalance(db, deps, { quote, userId, key, now }) {
  const plan = await planDebit(db, { clubId: quote.club_id, userId, minutes: quote.balance_minutes, now });
  const paymentId = stableUuid(`bl.payment/${quote.id}/balance`);
  const { rows } = await db.query(
    `insert into bl.payments (id, club_id, resource_id, user_id, quote_id, session_id, kind, provider, method, idempotence_key,
                              request_key, status, amount_kopecks, capture, minutes, unlimited, balance_minutes, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'balance', 'balance', $8, $9, 'pending', $10, true, $11, false, $12, $13, $13)
     returning *`,
    [paymentId, quote.club_id, quote.resource_id, userId, quote.id, quote.session_id, quote.kind, `q-${quote.id}-balance`, key,
      plan.valueKopecks, quote.minutes, quote.balance_minutes, now],
  );
  await applyDebit(db, plan, { paymentId, userId, now });
  await db.query('update bl.quotes set used_at = $2 where id = $1', [quote.id, now]);
  const r = await confirmPayment(db, deps, rows[0], { status: 'succeeded', now, actorType: 'user', actorId: userId });
  deps.log?.info?.('payment_balance', { payment_id: paymentId, club_id: quote.club_id, minutes: quote.balance_minutes });
  return { payment_id: r.payment.id, status: r.payment.status };
}

/**
 * Платёж ЮKassa — общий путь стола (payQuote) и бара (api.mjs createOnlinePayment).
 * Ключ ЮKassa и id платежа даёт вызывающий (детерминированные: повтор после сбоя связи
 * получает тот же платёж ЮKassa). Строка платежа и чек продажи пишутся в транзакции
 * вызывающего; уже записанный платёж с этим id возвращается как есть.
 * metadata ЮKassa: club_id, kind, payment_id и поля вызывающего (quote_id, sale_id).
 * confirmation: { type: 'redirect', returnUrl } или { type: 'qr' } (СБП на экране кассы);
 * в confirmation_url хранится адрес страницы оплаты или данные QR.
 * @returns {Promise<{ payment: object, confirmation: { type: 'redirect', url } | { type: 'qr', confirmation_data } | null }>}
 */
export async function createYooKassaPayment(db, deps, config, spec) {
  const { settings, clubId, paymentId, idempotenceKey, kind, method, amountKopecks: amount, capture = true, receipt, confirmation, now } = spec;
  const existing = (await db.query('select * from bl.payments where id = $1', [paymentId])).rows[0];
  if (existing) return { payment: existing, confirmation: confirmationOf(existing, confirmation.type) };
  const body = {
    amount: { value: formatValue(amount), currency: 'RUB' },
    capture,
    confirmation: confirmation.type === 'qr' ? { type: 'qr' } : { type: 'redirect', return_url: confirmation.returnUrl },
    payment_method_data: { type: method === 'sbp' ? 'sbp' : 'bank_card' },
    description: String(spec.description).slice(0, 128),
    metadata: { ...(spec.metadata ?? {}), club_id: clubId, kind, payment_id: paymentId },
    receipt,
  };
  let remote;
  try {
    remote = await clientFor(settings, config).createPayment(body, idempotenceKey);
  } catch (err) {
    throw providerFail(err, deps.log, { payment_id: paymentId, method });
  }
  const remoteAmount = amountKopecks(remote?.amount);
  if (typeof remote?.id !== 'string' || remoteAmount !== amount || !['pending', 'waiting_for_capture', 'succeeded', 'canceled'].includes(remote.status)) {
    deps.log?.error?.('yookassa_bad_create', { payment_id: paymentId, status: remote?.status });
    throw new MoneyError('payment_failed', 'ответ ЮKassa не совпал с запросом', 503);
  }
  const conf = remote.confirmation ?? null;
  if (remote.status === 'pending' && confirmation.type === 'qr' && (conf?.type !== 'qr' || typeof conf.confirmation_data !== 'string')) {
    deps.log?.error?.('yookassa_no_qr', { payment_id: paymentId });
    throw new MoneyError('payment_failed', 'ЮKassa не вернула QR', 503);
  }
  const stored = conf?.type === 'qr' ? conf.confirmation_data : conf?.confirmation_url ?? null;
  const ins = await db.query(
    `insert into bl.payments (id, club_id, resource_id, user_id, quote_id, session_id, kind, provider, method,
                              provider_payment_id, idempotence_key, request_key, status, amount_kopecks, capture,
                              minutes, unlimited, confirmation_url, booking_id, package_id, balance_minutes, settlement_status,
                              created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'yookassa', $8, $9, $10, $11, 'pending', $12, $13, $14, $15, $16, $18, $19, $20, $21, $17, $17)
     returning *`,
    [paymentId, clubId, spec.resourceId ?? null, spec.userId ?? null, spec.quoteId ?? null, spec.sessionId ?? null, kind, method,
      remote.id, idempotenceKey, spec.requestKey ?? null, amount, capture, spec.minutes ?? null, Boolean(spec.unlimited),
      typeof stored === 'string' && stored.length <= 2000 ? stored : null, now,
      spec.bookingId ?? null, spec.packageId ?? null, spec.balanceMinutes ?? 0, kind === 'booking' ? 'open' : null],
  );
  // Чек продажи (у заморозки — на сумму заморозки; при списании меньшей суммы capture.mjs
  // заменяет его чеком на фактическую сумму, телефон берёт из этой строки).
  await insertReceipt(db, {
    clubId,
    paymentId,
    channel: 'yookassa',
    status: 'pending',
    amountKopecks: amount,
    items: receipt.items,
    taxSystemCode: settings.tax_system_code,
    userId: spec.userId ?? null,
    phone: spec.phone ?? null,
    now,
  });
  let payment = ins.rows[0];
  // Платёж уже прошёл (ЮKassa вернула конечный статус сразу) — подтверждаем тем же путём.
  if (remote.status !== 'pending') payment = (await applyRemote(db, deps, payment, remote, { source: 'create' })).payment;
  deps.log?.info?.('payment_created', { payment_id: paymentId, club_id: clubId, kind, method, amount_kopecks: amount, capture });
  return { payment, confirmation: confirmationOf(payment, confirmation.type) };
}

/** confirmation для ответа: только пока платёж ждёт гостя. */
function confirmationOf(p, type) {
  if (p.status !== 'pending' || !p.confirmation_url) return null;
  return type === 'qr' ? { type: 'qr', confirmation_data: p.confirmation_url } : { type: 'redirect', url: p.confirmation_url };
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
  // M3: покупка пакета — минуты на баланс гостя; игра частично балансом — чеки зачёта (в той же транзакции).
  if (p.kind === 'package') await creditPackage(db, deps, { payment: p, now });
  if (p.balance_minutes > 0) await issueBalanceReceipts(db, deps, { paymentId: p.id, now });
  await deps.outbox.enqueue(db, 'payment.confirmed', confirmedPayload(p));
  deps.log?.info?.('payment_confirmed', { payment_id: p.id, club_id: p.club_id, method: p.method, status: p.status });
  return { payment: p, confirmed: true };
}

/**
 * Применить состояние платежа из ЮKassa (уже перепроверенное по API ключом клуба).
 * Сверяет id, сумму, валюту и metadata; расхождение — тревога и никаких действий.
 * @returns {Promise<{ result: 'confirmed'|'already'|'pending'|'canceled'|'captured'|'mismatch', payment: object }>}
 */
export async function applyRemote(db, deps, payment, remote, { source = 'webhook', client = null } = {}) {
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

  // B-L1: у нас платёж отменён, а у ЮKassa оплачен — игру не запускаем, деньги возвращаем (late.mjs).
  if (payment.status === 'canceled' && (remote.status === 'succeeded' || remote.status === 'waiting_for_capture')) {
    const { handleLatePayment } = await import('./late.mjs');
    if (client) return handleLatePayment(db, deps, payment, remote, { client, source });
    deps.log?.error?.('payment_paid_after_cancel_no_client', { payment_id: payment.id, source });
    return { result: 'already', payment };
  }

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
        // B-R1: строка вызывающего устарела — платёж уже отменён у нас (параллельная сверка).
        if (payment.status === 'canceled') return applyRemote(db, deps, payment, remote, { source, client });
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

/**
 * Событие outbox payment.canceled (M2: касса узнаёт об отмене СБП по QR без своего опроса).
 * previous_status: pending — гость не оплатил; waiting_for_capture — заморозка снята.
 */
export function canceledPayload(p, previousStatus) {
  return {
    payment_id: p.id,
    club_id: p.club_id,
    kind: p.kind,
    method: p.method,
    quote_id: p.quote_id ?? null,
    resource_id: p.resource_id ?? null,
    user_id: p.user_id ?? null,
    amount_kopecks: Number(p.amount_kopecks),
    reason: p.cancellation_reason ?? null,
    previous_status: previousStatus,
  };
}

/** Платёж отменён в ЮKassa: статус, журнал и outbox payment.canceled, снять pending со стола (start). */
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
  await deps.outbox.enqueue(db, 'payment.canceled', canceledPayload(p, payment.status));
  if (p.balance_minutes > 0) await restoreBalance(db, { paymentId: p.id, now });
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
  let remote;
  try {
    remote = await client.getPayment(payment.provider_payment_id);
  } catch (err) {
    if (err instanceof YooKassaError && err.status === 404) return onProviderNotFound(db, deps, payment, { source, client });
    throw err;
  }
  return applyRemote(db, deps, payment, remote, { source, client });
}

/** Через сколько pending-платёж, которого ЮKassa не знает, отменяется. */
export const NOT_FOUND_CANCEL_AFTER_MS = 60 * 60 * 1000;
export const NOT_FOUND_REASON = 'not_found_at_provider';

/**
 * ЮKassa ответила 404 на GET платежа: сбой при создании, чужой магазин, перезапущенный эмулятор.
 * * Первый 404 — отметка provider_missing_at и одна запись в логе (дальше сверка молчит).
 * * pending старше часа — повторный запрос; снова 404 — отмена (причина not_found_at_provider): payment.canceled, pending со стола
 *   снимается, сессия и бронь не запускаются; тревога владельцу один раз.
 * * Платёж у нас уже оплачен (succeeded / waiting_for_capture) — не трогаем, только тревога (один раз).
 */
export async function onProviderNotFound(db, deps, payment, { source = 'reconcile', client = null } = {}) {
  const now = deps.clock.now();
  const { rows } = await db.query('select * from bl.payments where id = $1 for update', [payment.id]);
  const p = rows[0];
  if (!p) return { result: 'already', payment };
  const first = !p.provider_missing_at;
  await db.query('update bl.payments set provider_missing_at = coalesce(provider_missing_at, $2), checked_at = $2 where id = $1', [p.id, now]);
  const alarm = (level, action) =>
    deps.alarms.raise(db, p.club_id, {
      type: 'payment_not_found_at_provider',
      level,
      resourceId: p.resource_id ?? undefined,
      data: { payment_id: p.id, kind: p.kind, status: p.status, amount_kopecks: Number(p.amount_kopecks), action },
    });
  if (p.status !== 'pending') {
    if (first && (p.status === 'succeeded' || p.status === 'waiting_for_capture')) {
      deps.log?.error?.('payment_not_found_at_provider', { payment_id: p.id, club_id: p.club_id, status: p.status, source });
      await alarm('critical', 'kept');
    }
    return { result: 'already', payment: p };
  }
  if (first) deps.log?.warn?.('payment_not_found_at_provider', { payment_id: p.id, club_id: p.club_id, status: p.status, source });
  if (now.getTime() - new Date(p.created_at).getTime() < NOT_FOUND_CANCEL_AFTER_MS) return { result: 'pending', payment: p };
  // Перед отменой — ещё один запрос (B-L1): платёж мог найтись (сбой ЮKassa, смена ключей).
  // Нашёлся — обычный путь applyRemote; снова 404 — отменяем; другой сбой — откат, сверка повторит.
  if (client) {
    try {
      const remote = await client.getPayment(p.provider_payment_id);
      return applyRemote(db, deps, p, remote, { source: `${source}_recheck`, client });
    } catch (err) {
      if (!(err instanceof YooKassaError && err.status === 404)) throw err;
    }
  }
  const r = await cancelLocal(db, deps, p, { reason: NOT_FOUND_REASON, now });
  if (r.result === 'canceled') await alarm('important', 'canceled');
  return r;
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

