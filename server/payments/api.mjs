// Денежный API для light и кассы (контракт M1 §13, §14; M2 §5): возвраты, статус чеков,
// платежи бара и кассы.
//
//   refund(db, { paymentId, amountKopecks, reason, key?, items?, customer?, requestedBy?, description? })
//       → { refund_id, status, amount_kopecks }; у платежа бара items (позиции чека возврата) обязательны
//   receiptStatus(db, { paymentIds }) → { [paymentId]: 'pending' | 'succeeded' | 'receipt_pending'
//                                           | 'failed' | 'canceled' | 'none' }
//   createOnlinePayment(db, { clubId, saleId, method, amountKopecks, items, customer, ... })
//       → { payment, confirmation } — СБП или карта ЮKassa бара и кассы (kind bar)
//   recordOfflinePayment(db, { clubId, saleId, method, amountKopecks, receivedKopecks?, staffId, ... })
//       → payment — наличные или терминал на кассе (kind bar), сразу succeeded
//
// * db — транзакция вызывающего с контекстом клуба платежа.
// * Идемпотентно: ключ (key или хеш платежа, суммы и причины) хранится в bl.refunds
//   и уходит в ЮKassa как Idempotence-Key — повтор обработчика outbox не вернёт деньги дважды.
// * Сумма возвратов не больше оплаченного (у заморозки — списанного).
// * ЮKassa: POST /v3/refunds с чеком возврата 54-ФЗ. Заморозка, которая ещё не списана,
//   отменяется целиком (возврат всей суммы) или списывается за вычетом возврата.
// * Наличные и терминал: возврат «manual» (деньги отдаёт ресепшн) и задание на чек возврата
//   ККТ (receipt_pending, M2); владелец и ресепшн получают уведомление.
// * Журнал payment.refunded с причиной, outbox payment.refunded, уведомление владельцу (инвариант 8).

import { createHash } from 'node:crypto';
import { formatMoney as formatMoneyRu } from '../../shared/format.mjs';
import { moneyConfig } from './config.mjs';
import { resolveDeps } from './deps.mjs';
import { MoneyError } from './errors.mjs';
import { enterClub } from './context.mjs';
import { createYooKassaPayment } from './pay.mjs';
import { receiptPhone, yookassaReceipt, receiptItems } from './receipt.mjs';
import { insertReceipt, receiptPhoneOf, stableUuid } from './records.mjs';
import { refunded } from './refunded.mjs';
import { clientFor, loadPaymentSettings } from './settings.mjs';
import { YooKassaError, formatValue, parseValue } from './yookassa.mjs';

let runtime = null;

/** init(ctx) денежного модуля задаёт зависимости и настройки; без него — из окружения. */
export function setRuntime(rt) {
  runtime = rt;
}

async function rt() {
  if (runtime) return runtime;
  const deps = await resolveDeps({});
  return { deps, config: moneyConfig(undefined) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_RECEIPT_IDS = 200;

/**
 * Статус чека продажи по каждому платежу (чек сессии, light). db — транзакция с контекстом
 * клуба: чужие платежи RLS не покажет (для них — 'none'). Чек ККТ в статусе printed (пробит,
 * M2) отдаётся как succeeded — набор статусов для light не меняется.
 * Действующий чек — последний чек продажи, кроме отменённых (у заморозки чек на сумму
 * заморозки отменяется и заменяется чеком на фактическую сумму); все отменены — 'canceled';
 * чека нет — 'none'. Чеки возвратов сюда не входят.
 * @param {import('pg').ClientBase} db
 * @param {{ paymentIds: string[] }} args
 * @returns {Promise<Record<string, string>>}
 */
export async function receiptStatus(db, { paymentIds } = {}) {
  if (!Array.isArray(paymentIds)) throw new MoneyError('bad_request', 'paymentIds');
  const ids = [...new Set(paymentIds.filter((id) => typeof id === 'string' && UUID.test(id)))];
  if (ids.length > MAX_RECEIPT_IDS) throw new MoneyError('bad_request', 'paymentIds: слишком много');
  const out = Object.fromEntries(ids.map((id) => [id, 'none']));
  if (ids.length === 0) return out;
  const { rows } = await db.query(
    `select distinct on (payment_id) payment_id, status
       from bl.receipts
      where payment_id = any($1::uuid[]) and kind = 'sale'
      order by payment_id, (status = 'canceled'), created_at desc, id desc`,
    [ids],
  );
  // printed — чек пробит на ККТ клуба (M2, server/kkt): для чека сессии это успех, отдаём succeeded.
  for (const r of rows) out[r.payment_id] = r.status === 'printed' ? 'succeeded' : r.status;
  return out;
}

/** Позиции чека 54-ФЗ от вызывающего: формат ЮKassa, сумма (цена × количество) = amount. */
export function checkItems(items, amountKopecks) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) throw new MoneyError('bad_request', 'items');
  let milli = 0;
  for (const it of items) {
    const price = parseValue(it?.amount?.value);
    const qty = Number(it?.quantity);
    if (
      price === null || price <= 0 || it.amount.currency !== 'RUB' || !Number.isFinite(qty) || qty <= 0 ||
      typeof it.description !== 'string' || it.description.length < 1 || it.description.length > 128 ||
      !Number.isInteger(it.vat_code) || it.vat_code < 1 || it.vat_code > 12
    ) {
      throw new MoneyError('bad_request', 'позиция чека');
    }
    milli += Math.round(price * qty * 1000);
  }
  if (milli !== amountKopecks * 1000) throw new MoneyError('bad_request', 'сумма позиций чека не равна сумме');
  return items;
}

const BAR_METHODS_ONLINE = ['sbp', 'card'];
const BAR_METHODS_OFFLINE = ['cash', 'card_terminal'];

/** id и ключ платежа продажи кассы (детерминированные: повтор продажи — тот же платёж). */
export const barPaymentId = (saleId) => stableUuid(`bl.payment/bar/${saleId}`);
export const barIdempotenceKey = (saleId) => `bar-${saleId}`;

/**
 * До какого момента может дойти игра на столе по тому, что ещё не подтверждено (для брони):
 * живая котировка старта или продления (не использована, не истекла), заявка ресепшена в ожидании
 * и неподтверждённый платёж старта или продления не старше часа. Старт отсчитывается от момента
 * подтверждения (не раньше конца жизни котировки или заявки), продление — от конца оплаченного
 * (from_at котировки); «Без лимита» — на время заморозки. Котировки старта по брони не в счёт.
 * @param {{ resourceId: string, now?: Date }} args
 * @returns {Promise<Date|null>}
 */
export async function pendingPlayUntil(db, { resourceId, now = new Date() }) {
  if (!UUID.test(resourceId ?? '')) throw new MoneyError('bad_request', 'resourceId');
  const { rows } = await db.query(
    `with q as (
       select q.*, make_interval(mins => coalesce(q.minutes, greatest(q.hold_minutes, q.block_minutes))) as span
         from bl.quotes q where q.resource_id = $1 and q.kind in ('start', 'extend')
     )
     select max(until) as until from (
       select case when q.kind = 'extend' then greatest(q.from_at, $2) else q.valid_until end + q.span as until
         from q where q.used_at is null and q.valid_until > $2
       union all
       select case when q.kind = 'extend' then greatest(q.from_at, $2) else greatest(rr.expires_at, $2) end + q.span
         from bl.reception_requests rr join q on q.id = rr.quote_id
        where rr.resource_id = $1 and rr.status = 'waiting' and rr.expires_at > $2
       union all
       select case when p.kind = 'extend' then greatest(coalesce(q.from_at, $2), $2) else $2 end
              + make_interval(mins => coalesce(p.minutes, q.minutes, greatest(q.hold_minutes, q.block_minutes), 0))
         from bl.payments p left join q on q.id = p.quote_id
        where p.resource_id = $1 and p.kind in ('start', 'extend') and p.status = 'pending' and p.confirmed_at is null
          and p.created_at > $2 - interval '1 hour'
     ) x`,
    [resourceId, now],
  );
  return rows[0]?.until ? new Date(rows[0].until) : null;
}

// M4: взнос за участие в турнире (контракт m4.md, решение №138) -----------------------------

/**
 * Платёж ЮKassa kind tournament с чеком «полный расчёт» (услуга участия).
 * { clubId, tournamentId, entryId, amountKopecks, customer: {phone}|{email}, returnUrl?, method?: 'sbp'|'card',
 *   userId?, title? } → { payment, confirmation }; подтверждение — outbox payment.confirmed
 * {kind: 'tournament', tournament_id, entry_id}.
 */
export async function createTournamentFee(db, args, injected) {
  const { deps, config } = injected ?? (await rt());
  const { createTournamentFee: impl } = await import('./tournaments.mjs');
  return impl(db, deps, config, args);
}

/** Возврат взноса записи целиком с чеком возврата; идемпотентно (ключ trn-<payment_id>). */
export async function refundTournamentFee(db, args, injected) {
  const inj = injected ?? (await rt());
  const { refundTournamentFee: impl } = await import('./tournaments.mjs');
  return impl(db, inj.deps, args, (d, a) => refund(d, a, inj));
}

/** Отмена турнира клубом: возврат каждой оплаченной записи — событием outbox (по одному на запись). */
export async function refundTournamentFees(db, args, injected) {
  const { deps } = injected ?? (await rt());
  const { refundTournamentFees: impl } = await import('./tournaments.mjs');
  return impl(db, deps, args);
}

/**
 * Доступен ли клубу онлайн-способ оплаты (без создания платежа; касса зовёт до поиска гостя):
 * есть магазин ЮKassa (shop_id и секрет) и способ включён в настройках клуба.
 * @param {{ clubId: string, method: 'sbp'|'card' }} args
 * @returns {Promise<boolean>} false и для неизвестного способа; bad_request — неверный clubId
 */
export async function onlineMethodAvailable(db, { clubId, method }) {
  if (!UUID.test(clubId ?? '')) throw new MoneyError('bad_request', 'clubId');
  if (!BAR_METHODS_ONLINE.includes(method)) return false;
  await enterClub(db, clubId);
  const settings = await loadPaymentSettings(db, clubId);
  return Boolean(settings[method]);
}

/**
 * Платёж ЮKassa бара и кассы (контракт M2 §5): СБП (на экране кассы — confirmation qr) или карта
 * (гостю — redirect). kind = 'bar'. Строки платежа и чека — в транзакции вызывающего (контекст клуба).
 * Подтверждение — общий путь money: вебхук или сверка → outbox payment.confirmed (kind bar);
 * отказ — outbox payment.canceled.
 * @param {{ clubId: string, saleId: string, method: 'sbp'|'card', amountKopecks: number, items: object[],
 *           customer: { phone: string } | { email: string }, phone?: string|null,
 *           confirmation: 'qr'|'redirect', returnUrl?: string, description: string, metadata?: object,
 *           requestKey?: string|null, userId?: string|null, resourceId?: string|null }} args
 */
export async function createOnlinePayment(db, args, injected) {
  const { deps, config } = injected ?? (await rt());
  const { clubId, saleId, method, amountKopecks } = args;
  if (!UUID.test(saleId ?? '')) throw new MoneyError('bad_request', 'saleId');
  if (!BAR_METHODS_ONLINE.includes(method)) throw new MoneyError('bad_request', 'method');
  if (!Number.isSafeInteger(amountKopecks) || amountKopecks <= 0) throw new MoneyError('bad_request', 'amountKopecks');
  if (args.confirmation !== 'qr' && args.confirmation !== 'redirect') throw new MoneyError('bad_request', 'confirmation');
  if (args.confirmation === 'qr' && method !== 'sbp') throw new MoneyError('bad_request', 'QR — только СБП');
  if (args.confirmation === 'redirect' && !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(args.returnUrl ?? '')) {
    throw new MoneyError('bad_request', 'returnUrl');
  }
  const customer = args.customer;
  if (!customer || (!customer.phone && !customer.email)) throw new MoneyError('bad_request', 'customer');
  const items = checkItems(args.items, amountKopecks);
  await enterClub(db, clubId);
  const settings = await loadPaymentSettings(db, clubId);
  if (method === 'sbp' && !settings.sbp) throw new MoneyError('bad_request', 'СБП недоступна');
  if (method === 'card' && !settings.card) throw new MoneyError('bad_request', 'карта недоступна');
  const receipt = { customer, items, ...(settings.tax_system_code != null ? { tax_system_code: settings.tax_system_code } : {}) };
  return createYooKassaPayment(db, deps, config, {
    settings,
    clubId,
    paymentId: barPaymentId(saleId),
    idempotenceKey: barIdempotenceKey(saleId),
    requestKey: args.requestKey ?? null,
    kind: 'bar',
    method,
    amountKopecks,
    capture: true,
    receipt,
    confirmation: args.confirmation === 'qr' ? { type: 'qr' } : { type: 'redirect', returnUrl: args.returnUrl },
    description: args.description ?? 'Бар',
    metadata: { ...(args.metadata ?? {}), sale_id: saleId },
    userId: args.userId ?? null,
    resourceId: args.resourceId ?? null,
    phone: args.phone ?? null,
    now: deps.clock.now(),
  });
}

/**
 * Наличные или терминал на кассе (kind bar): платёж сразу succeeded, confirmed_at ставится
 * один раз; outbox payment.confirmed нет (это не игра — продажу завершает касса), чек ККТ
 * ставит касса (server/kkt). Повтор с тем же saleId возвращает тот же платёж.
 * @param {{ clubId: string, saleId: string, method: 'cash'|'card_terminal', amountKopecks: number,
 *           receivedKopecks?: number|null, staffId: string, requestKey?: string|null, userId?: string|null }} args
 */
export async function recordOfflinePayment(db, args, injected) {
  const { deps } = injected ?? (await rt());
  const { clubId, saleId, method, amountKopecks } = args;
  if (!UUID.test(saleId ?? '')) throw new MoneyError('bad_request', 'saleId');
  if (!BAR_METHODS_OFFLINE.includes(method)) throw new MoneyError('bad_request', 'method');
  if (!Number.isSafeInteger(amountKopecks) || amountKopecks <= 0) throw new MoneyError('bad_request', 'amountKopecks');
  if (!UUID.test(args.staffId ?? '')) throw new MoneyError('bad_request', 'staffId');
  let received = null;
  let change = 0;
  if (method === 'cash') {
    received = args.receivedKopecks ?? amountKopecks;
    if (!Number.isSafeInteger(received) || received < amountKopecks || received > amountKopecks + 10_000_000) {
      throw new MoneyError('bad_request', 'receivedKopecks');
    }
    change = received - amountKopecks;
  }
  await enterClub(db, clubId);
  const id = barPaymentId(saleId);
  const prev = (await db.query('select * from bl.payments where id = $1', [id])).rows[0];
  if (prev) {
    if (prev.method !== method || Number(prev.amount_kopecks) !== amountKopecks) throw new MoneyError('idempotency_conflict');
    return prev;
  }
  const now = deps.clock.now();
  const { rows } = await db.query(
    `insert into bl.payments (id, club_id, resource_id, user_id, kind, provider, method, idempotence_key, request_key, status,
                              amount_kopecks, capture, received_kopecks, change_kopecks, accepted_by, confirmed_at, captured_at,
                              created_at, updated_at)
     values ($1, $2, null, $3, 'bar', 'reception', $4, $5, $6, 'succeeded', $7, true, $8, $9, $10, $11, $11, $11, $11)
     returning *`,
    [id, clubId, args.userId ?? null, method, barIdempotenceKey(saleId), args.requestKey ?? null, amountKopecks, received, change, args.staffId, now],
  );
  return rows[0];
}

function refundKey({ paymentId, amountKopecks, reason, key }) {
  if (key) return String(key).slice(0, 64);
  return `r-${createHash('sha256').update(`${paymentId}|${amountKopecks}|${reason}`).digest('hex').slice(0, 40)}`;
}

/** Статус возврата из ЮKassa; succeeded — журнал, outbox, уведомление (один раз). */
export async function applyRefundStatus(db, deps, refund, status, { now = deps.clock.now() } = {}) {
  const map = { succeeded: 'succeeded', canceled: 'canceled', pending: 'pending' };
  const next = map[status];
  if (!next || next === refund.status) return refund;
  const { rows } = await db.query(
    `update bl.refunds set status = $2, updated_at = $3 where id = $1 and status in ('pending') returning *`,
    [refund.id, next, now],
  );
  if (rows.length === 0) return refund;
  if (next === 'succeeded') await refunded(db, deps, rows[0], now);
  if (next === 'canceled') await refundCanceled(db, deps, rows[0]);
  return rows[0];
}

/**
 * ЮKassa отменила возврат (п. 4): деньги гостю не ушли. outbox payment.refund_canceled
 * {refund_id, payment_id, club_id, amount_kopecks, pos_refund_id?} — касса (pos) откатывает учёт
 * возврата продажи; критичная тревога владельцу.
 */
async function refundCanceled(db, deps, f) {
  let posRefundId = null;
  await db.query('savepoint money_pos_refund');
  try {
    posRefundId = (await db.query('select id from bl.pos_refunds where refund_id = $1 limit 1', [f.id])).rows[0]?.id ?? null;
    await db.query('release savepoint money_pos_refund');
  } catch {
    await db.query('rollback to savepoint money_pos_refund'); // без таблицы кассы — без pos_refund_id
  }
  const amount = Number(f.amount_kopecks);
  const lotsRestored = await restoreRevokedLots(db, deps, f, posRefundId);
  await deps.outbox.enqueue(db, 'payment.refund_canceled', {
    refund_id: f.id,
    payment_id: f.payment_id,
    club_id: f.club_id,
    amount_kopecks: amount,
    ...(posRefundId ? { pos_refund_id: posRefundId } : {}),
    lots_restored: lotsRestored,
  });
  deps.log?.error?.('refund_canceled', { refund_id: f.id, payment_id: f.payment_id, club_id: f.club_id, amount_kopecks: amount });
  await deps.alarms.raise(db, f.club_id, {
    type: 'refund_canceled',
    level: 'critical',
    data: { refund_id: f.id, payment_id: f.payment_id, amount_kopecks: amount, lots_restored: lotsRestored.length, ...(posRefundId ? { pos_refund_id: posRefundId } : {}) },
    text: `ЮKassa отменила возврат ${formatMoneyRu(amount)}: деньги гостю не вернулись — верните вручную${lotsRestored.length > 0 ? '; пакет часов снова действует' : ''}`,
  });
}

/**
 * Возврат пакета часов отменён ЮKassa — партия снова действует (отозвана только нетронутая, так что
 * возвращаются все её минуты). Пакет из приложения — ключ возврата pkr-<lot>; пакет с кассы —
 * pos_sale_packages этого возврата кассы. Журнал package.restored.
 * @returns {Promise<string[]>} id восстановленных партий
 */
async function restoreRevokedLots(db, deps, f, posRefundId) {
  const ids = [];
  const m = /^pkr-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-\d+)?$/.exec(f.idempotence_key ?? '');
  if (m) ids.push(m[1]);
  if (posRefundId) {
    await db.query('savepoint money_pos_lots');
    try {
      const { rows } = await db.query('select lot_id from bl.pos_sale_packages where pos_refund_id = $1 and lot_id is not null', [posRefundId]);
      ids.push(...rows.map((r) => r.lot_id));
      await db.query('release savepoint money_pos_lots');
    } catch {
      await db.query('rollback to savepoint money_pos_lots');
    }
  }
  const restored = [];
  for (const id of ids) {
    const { rows } = await db.query(
      `update bl.balance_lots set minutes_left = minutes_total, revoked_at = null, revoked_by = null
        where id = $1 and revoked_at is not null returning id, payment_id, minutes_total, user_id`,
      [id],
    );
    if (!rows[0]) continue;
    restored.push(id);
    await deps.audit.appendAudit(db, {
      action: 'package.restored',
      objectType: 'payment',
      objectId: rows[0].payment_id,
      data: { lot_id: id, refund_id: f.id, minutes: rows[0].minutes_total, user_id: rows[0].user_id },
      actorType: 'system',
    });
  }
  return restored;
}

/** Сверка зависшего возврата ЮKassa (планировщик, money_due refund_stale). */
export async function syncRefund(db, deps, config, refundId) {
  const { rows } = await db.query(
    `select f.*, p.provider_payment_id from bl.refunds f join bl.payments p on p.id = f.payment_id where f.id = $1 for update of f`,
    [refundId],
  );
  const f = rows[0];
  if (!f || f.status !== 'pending' || !f.provider_refund_id) return { result: 'skipped' };
  const now = deps.clock.now();
  await db.query('update bl.refunds set checked_at = $2 where id = $1', [f.id, now]);
  const settings = await loadPaymentSettings(db, f.club_id, { isTest: f.is_test });
  const remote = await clientFor(settings, config).getRefund(f.provider_refund_id);
  if (remote?.id !== f.provider_refund_id || remote?.payment_id !== f.provider_payment_id) {
    deps.log?.error?.('refund_mismatch', { club_id: f.club_id, refund_id: f.id });
    await deps.alarms.raise(db, f.club_id, { type: 'refund_mismatch', level: 'critical', data: { refund_id: f.id } });
    return { result: 'mismatch' };
  }
  const out = await applyRefundStatus(db, deps, f, remote.status, { now });
  return { result: out.status };
}


/**
 * Возврат денег гостю.
 * @param {import('pg').PoolClient} db транзакция с контекстом клуба
 * @param {{ paymentId: string, amountKopecks: number, reason: string, key?: string }} args
 */
export async function refund(db, args, injected) {
  const { deps, config } = injected ?? (await rt());
  const { paymentId, amountKopecks, reason } = args;
  if (!Number.isSafeInteger(amountKopecks) || amountKopecks <= 0) throw new MoneyError('bad_request', 'amountKopecks');
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 2000) throw new MoneyError('reason_required');
  const now = deps.clock.now();
  const { rows } = await db.query('select * from bl.payments where id = $1 for update', [paymentId]);
  const p = rows[0];
  if (!p) throw new MoneyError('not_found', 'payment');
  const key = refundKey({ ...args, amountKopecks });
  const prev = await db.query('select * from bl.refunds where club_id = $1 and idempotence_key = $2', [p.club_id, key]);
  if (prev.rowCount > 0) {
    const f = prev.rows[0];
    return { refund_id: f.id, status: f.status, amount_kopecks: Number(f.amount_kopecks) };
  }
  const queued = await db.query('select * from bl.cash_refunds_pending where club_id = $1 and idempotence_key = $2', [p.club_id, key]);
  if (queued.rowCount > 0) {
    const q = queued.rows[0];
    return { refund_id: q.refund_id, status: q.done_at ? 'manual' : 'queued', amount_kopecks: Number(q.amount_kopecks), pending_id: q.id };
  }
  // Игра минутами баланса (пакеты часов): деньги не двигались — минуты возвращаются в партии (п. 2).
  if (p.provider === 'balance') return refundBalance(db, deps, p, { key, amountKopecks, reason, args, now });

  const settings = await loadPaymentSettings(db, p.club_id, { isTest: p.is_test });
  const { rows: res } = await db.query('select number, type from bl.resources where id = $1', [p.resource_id]);
  const number = res[0]?.number;
  const resourceType = res[0]?.type ?? null;
  // Позиции чека возврата: у бара — от кассы (что именно возвращается), у стола — «Игра, стол N».
  const items = args.items === undefined ? null : checkItems(args.items, amountKopecks);
  if (p.kind === 'bar' && !items) throw new MoneyError('bad_request', 'items: позиции чека возврата бара');
  const requestedBy = UUID.test(args.requestedBy ?? '') ? args.requestedBy : null;

  // Заморозка ещё не списана: отменить целиком или списать за вычетом возврата.
  if (p.status === 'waiting_for_capture') {
    if (amountKopecks > Number(p.amount_kopecks)) throw new MoneyError('limit_exceeded', 'возврат больше заморозки');
    const { captureOrRelease } = await import('./capture.mjs');
    await captureOrRelease(db, deps, config, p, { amountKopecks: Number(p.amount_kopecks) - amountKopecks, number, settings, now });
    const { rows: f } = await db.query(
      `insert into bl.refunds (club_id, payment_id, idempotence_key, amount_kopecks, status, reason, kind, created_at, updated_at)
       values ($1, $2, $3, $4, 'succeeded', $5, 'release', $6, $6) returning *`,
      [p.club_id, p.id, key, amountKopecks, reason, now],
    );
    await refunded(db, deps, f[0], now);
    return { refund_id: f[0].id, status: 'succeeded', amount_kopecks: amountKopecks };
  }

  if (p.status !== 'succeeded') throw new MoneyError('payment_pending', `платёж в статусе ${p.status}`);
  const base = p.capture ? Number(p.amount_kopecks) : Number(p.captured_kopecks ?? 0);
  const already = await refundedSoFar(db, p.id);
  if (already + amountKopecks > base) throw new MoneyError('limit_exceeded', 'возврат больше оплаченного');

  if (p.provider === 'reception') {
    // Наличные без открытой смены — ждут смены (п. 7): выдаются и попадают в её сверку.
    if (p.method === 'cash' && !(await deps.shifts.currentShift(db, p.club_id))) {
      const { queueCashRefund } = await import('./cash-refunds.mjs');
      const lines = items ?? receiptItems({ resourceNumber: number, resourceType, minutes: p.minutes, amountKopecks, vatCode: settings.vat_code });
      const { pending } = await queueCashRefund(db, deps, { clubId: p.club_id, payment: p, key, amountKopecks, reason, lines, requestedBy, now });
      return { refund_id: null, status: 'queued', amount_kopecks: amountKopecks, pending_id: pending.id };
    }
    const { rows: f } = await db.query(
      `insert into bl.refunds (club_id, payment_id, idempotence_key, amount_kopecks, status, reason, requested_by, created_at, updated_at)
       values ($1, $2, $3, $4, 'manual', $5, $7, $6, $6) returning *`,
      [p.club_id, p.id, key, amountKopecks, reason, now, requestedBy],
    );
    await insertReceipt(db, {
      clubId: p.club_id,
      paymentId: p.id,
      refundId: f[0].id,
      kind: 'refund',
      channel: 'kkt',
      status: 'receipt_pending',
      amountKopecks,
      items: items ?? receiptItems({ resourceNumber: number, resourceType, minutes: p.minutes, amountKopecks, vatCode: settings.vat_code }),
      taxSystemCode: settings.tax_system_code,
      userId: p.user_id,
      now,
    });
    await refunded(db, deps, f[0], now);
    return { refund_id: f[0].id, status: 'manual', amount_kopecks: amountKopecks };
  }

  const phone = await receiptPhoneOf(db, p.id);
  let receipt;
  if (items) {
    const customer = args.customer ?? (receiptPhone(phone) ? { phone: receiptPhone(phone) } : null);
    if (!customer) throw new MoneyError('bad_request', 'нет контакта покупателя для чека возврата');
    receipt = { customer, items, ...(settings.tax_system_code != null ? { tax_system_code: settings.tax_system_code } : {}) };
  } else {
    receipt = yookassaReceipt({ phone, resourceNumber: number, resourceType, minutes: p.minutes, amountKopecks, settings });
  }
  const { rows: ins } = await db.query(
    `insert into bl.refunds (club_id, payment_id, idempotence_key, amount_kopecks, status, reason, requested_by, created_at, updated_at)
     values ($1, $2, $3, $4, 'pending', $5, $7, $6, $6) returning *`,
    [p.club_id, p.id, key, amountKopecks, reason, now, requestedBy],
  );
  let f = ins[0];
  let remote;
  try {
    const client = clientFor(settings, config);
    remote = await client.createRefund(
      {
        payment_id: p.provider_payment_id,
        amount: { value: formatValue(amountKopecks), currency: 'RUB' },
        description: String(args.description ?? (p.kind === 'bar' ? 'Возврат: бар' : `Возврат: стол ${number}`)).slice(0, 128),
        receipt,
      },
      key,
    );
  } catch (err) {
    if (err instanceof YooKassaError) {
      deps.log?.warn?.('refund_provider_error', { payment_id: p.id, status: err.status, code: err.code, retryable: err.retryable });
      throw new MoneyError('payment_failed', err.message, err.retryable ? 503 : 409);
    }
    throw err;
  }
  await db.query('update bl.refunds set provider_refund_id = $2, updated_at = $3 where id = $1', [f.id, remote.id, now]);
  await insertReceipt(db, {
    clubId: p.club_id,
    paymentId: p.id,
    refundId: f.id,
    kind: 'refund',
    channel: 'yookassa',
    status: remote.receipt_registration === 'succeeded' ? 'succeeded' : 'pending',
    amountKopecks,
    items: receipt.items,
    taxSystemCode: settings.tax_system_code,
    userId: p.user_id,
    phone,
    now,
  });
  f = await applyRefundStatus(db, deps, { ...f, provider_refund_id: remote.id }, remote.status, { now });
  // Смешанная оплата (карта + минуты баланса): та же доля минут возвращается на баланс (п. 2).
  const minutesBack = p.balance_minutes > 0 ? await restoreBalanceShare(db, deps, p, { amountKopecks, base, already, now }) : 0;
  return { refund_id: f.id, status: f.status, amount_kopecks: amountKopecks, ...(minutesBack > 0 ? { minutes_restored: minutesBack } : {}) };
}

/** Сумма возвратов платежа в лимите: деньги гостю (без снятой заморозки) и ждущие смены наличные. */
async function refundedSoFar(db, paymentId) {
  const { rows } = await db.query(
    `select (select coalesce(sum(amount_kopecks), 0) from bl.refunds where payment_id = $1 and status <> 'canceled' and kind <> 'release')
          + (select coalesce(sum(amount_kopecks), 0) from bl.cash_refunds_pending where payment_id = $1 and done_at is null) as total`,
    [paymentId],
  );
  return Number(rows[0].total);
}

/**
 * Доля минут баланса к возврату: весь остаток, если возвращается всё оплаченное, иначе
 * balance_minutes × amount / base (округление вниз, не меньше 1 минуты при ненулевой доле).
 */
async function restoreBalanceShare(db, deps, p, { amountKopecks, base, already, now }) {
  const { restoreMinutes } = await import('../packages/balance.mjs');
  const full = already + amountKopecks >= base;
  const minutes = full ? null : Math.max(1, Math.floor((p.balance_minutes * amountKopecks) / base));
  const r = await restoreMinutes(db, { paymentId: p.id, minutes, now });
  if (r.minutes > 0) await notifyBalanceBack(db, deps, p, r.minutes);
  return r.minutes;
}

async function notifyBalanceBack(db, deps, p, minutes) {
  if (!p.user_id) return;
  try {
    await deps.notify.send(db, p.user_id, {
      kind: 'balance_returned',
      level: 'info',
      text: `Вернули ${minutes} мин на баланс клуба: игра не состоялась или прервалась.`,
      data: { payment_id: p.id, minutes },
    });
  } catch (err) {
    deps.log?.warn?.('balance_notify_failed', { payment_id: p.id, error: err.message });
  }
}

/**
 * Возврат по платежу минутами баланса (provider balance): минуты обратно в партии (с учётом срока —
 * balance.mjs restoreMinutes), строка bl.refunds kind balance (деньги не двигались, в выручку и
 * сверки не входит), журнал payment.refunded с причиной, outbox payment.refunded, уведомления.
 * Чек зачёта по таким минутам пробивается при закрытии сессии только за оставшиеся (README).
 */
async function refundBalance(db, deps, p, { key, amountKopecks, reason, args, now }) {
  if (p.status !== 'succeeded') throw new MoneyError('payment_pending', `платёж в статусе ${p.status}`);
  const base = Number(p.amount_kopecks);
  const already = await refundedSoFar(db, p.id);
  if (already + amountKopecks > base) throw new MoneyError('limit_exceeded', 'возврат больше оплаченного');
  const requestedBy = UUID.test(args.requestedBy ?? '') ? args.requestedBy : null;
  const { restoreMinutes } = await import('../packages/balance.mjs');
  const full = already + amountKopecks >= base;
  const r = await restoreMinutes(db, { paymentId: p.id, minutes: full ? null : Math.max(1, Math.floor((p.balance_minutes * amountKopecks) / base)), now });
  const { rows: f } = await db.query(
    `insert into bl.refunds (club_id, payment_id, idempotence_key, amount_kopecks, status, reason, requested_by, kind, created_at, updated_at)
     values ($1, $2, $3, $4, 'succeeded', $5, $6, 'balance', $7, $7) returning *`,
    [p.club_id, p.id, key, amountKopecks, reason, requestedBy, now],
  );
  await refunded(db, deps, f[0], now);
  if (r.minutes > 0) await notifyBalanceBack(db, deps, p, r.minutes);
  return { refund_id: f[0].id, status: 'succeeded', amount_kopecks: amountKopecks, minutes_restored: r.minutes };
}

// M3: предоплата брони, баланс пакетов, депозит (контракт m3.md §3) ----------------------------
// Обёртки с зависимостями модуля (init) — сигнатуры контракта: функция(db, args).

/** Предоплата брони: платёж ЮKassa kind booking с чеком full_prepayment → { payment, confirmation }. */
export async function createPrepayment(db, args, injected) {
  const { deps, config } = injected ?? (await rt());
  const { createPrepayment: impl } = await import('./prepayments.mjs');
  return impl(db, deps, config, args);
}

/** Котировка старта по брони (доплата при приходе, №113, №116) → { quote_id, amount_kopecks, minutes, valid_until, ... }. */
export async function createBookingQuote(db, args, injected) {
  const { deps } = injected ?? (await rt());
  const { createBookingQuote: impl } = await import('./prepayments.mjs');
  return impl(db, deps, args);
}

/** Игра по брони началась: чек зачёта предоплаты. */
export async function settlePrepayment(db, args, injected) {
  const { deps } = injected ?? (await rt());
  const { settlePrepayment: impl } = await import('./prepayments.mjs');
  return impl(db, deps, args);
}

/** Бронь сгорела или отменена: удержать percent % (по умолчанию — настройка клуба), остальное вернуть. */
export async function forfeitPrepayment(db, args, injected) {
  const inj = injected ?? (await rt());
  const { forfeitPrepayment: impl } = await import('./prepayments.mjs');
  return impl(db, inj.deps, inj.config, args, refund);
}

/**
 * Списать минуты баланса гостя (пакеты часов) — для соседей (бронь, light):
 * { userId, clubId, minutes, sessionId, paymentId? } → { payment_id, minutes, value_kopecks }.
 * Без paymentId создаётся платёж balance (kind extend по сессии), подтверждённый сразу, но без
 * outbox payment.confirmed: время сессии назначает вызывающий. Чеки зачёта — сразу.
 */
export async function debitBalance(db, args, injected) {
  const { deps } = injected ?? (await rt());
  const { planDebit, applyDebit, issueBalanceReceipts } = await import('../packages/balance.mjs');
  const { clubId, userId, minutes, sessionId = null } = args;
  if (!UUID.test(clubId ?? '') || !UUID.test(userId ?? '')) throw new MoneyError('bad_request', 'clubId, userId');
  const { enterClub } = await import('./context.mjs');
  await enterClub(db, clubId);
  const now = deps.clock.now();
  const plan = await planDebit(db, { clubId, userId, minutes, now });
  let paymentId = args.paymentId ?? null;
  if (!paymentId) {
    if (!UUID.test(sessionId ?? '')) throw new MoneyError('bad_request', 'sessionId');
    const { rows: s } = await db.query('select resource_id from bl.sessions where id = $1', [sessionId]);
    if (!s[0]) throw new MoneyError('not_found', 'session');
    const { rows } = await db.query(
      `insert into bl.payments (club_id, resource_id, user_id, session_id, kind, provider, method, idempotence_key, status,
                                amount_kopecks, capture, minutes, balance_minutes, confirmed_at, captured_at, created_at, updated_at)
       values ($1, $2, $3, $4, 'extend', 'balance', 'balance', $5, 'succeeded', $6, true, $7, $7, $8, $8, $8, $8) returning id`,
      [clubId, s[0].resource_id, userId, sessionId, `bal-${stableUuid(`${sessionId}/${now.toISOString()}/${minutes}`)}`.slice(0, 64), plan.valueKopecks, minutes, now],
    );
    paymentId = rows[0].id;
  }
  await applyDebit(db, plan, { paymentId, userId, now });
  // Контракт M3 §3: чек зачёта — сразу (время сессии назначает вызывающий; возврат минут по такому
  // платежу — через refund, чек за уже начисленное время остаётся).
  await issueBalanceReceipts(db, deps, { paymentId, now });
  return { payment_id: paymentId, minutes, value_kopecks: plan.valueKopecks };
}

/** Остаток минут гостя в клубе. */
export async function balance(db, { clubId, userId }, injected) {
  const { deps } = injected ?? (await rt());
  const { balanceOf } = await import('../packages/balance.mjs');
  return balanceOf(db, { clubId, userId, now: deps.clock.now() });
}

/** Депозит наличными по сессии «Без лимита» (сессию уже начал light startFromDeposit). */
export async function takeDeposit(db, args, injected) {
  const { deps } = injected ?? (await rt());
  const { takeDeposit: impl } = await import('./deposits.mjs');
  return impl(db, deps, args);
}

/** Закрытие депозитной сессии: зачёт сыгранного, возврат остатка наличными с чеком. */
export async function settleDeposit(db, args, injected) {
  const { deps } = injected ?? (await rt());
  const { settleDeposit: impl } = await import('./deposits.mjs');
  return impl(db, deps, args);
}

/**
 * Касса pos (M3): позиция чека пакета часов (предоплата 100 %) и начисление после оплаты продажи.
 *   packageSaleLine(db, { packageId }) → { line, amount_kopecks, package }
 *   creditPackageForSale(db, { payment, packageId, userId, index? }) → партия минут (повтор — та же)
 */
export async function packageSaleLine(db, { packageId }) {
  if (!UUID.test(packageId ?? '')) throw new MoneyError('bad_request', 'packageId');
  const { rows } = await db.query('select * from bl.tariff_packages where id = $1 and active', [packageId]);
  const pkg = rows[0];
  if (!pkg) throw new MoneyError('not_found', 'package');
  const settings = await loadPaymentSettings(db, pkg.club_id);
  const { packageItem } = await import('../packages/service.mjs');
  return { line: packageItem(pkg, settings.vat_code), amount_kopecks: Number(pkg.price_kopecks), package: pkg };
}

export async function creditPackageForSale(db, { payment, packageId, userId, index = 0 }, injected) {
  const { deps } = injected ?? (await rt());
  const { creditPackage } = await import('../packages/balance.mjs');
  if (payment?.status !== 'succeeded') throw new MoneyError('payment_pending', 'продажа не оплачена');
  return creditPackage(db, deps, { payment, packageId, userId, index, now: deps.clock.now() });
}

/**
 * Возврат пакета часов из приложения (decisions №118): партия отзывается целиком (если не тронута)
 * и деньги возвращаются через ЮKassa с чеком возврата предоплаты.
 * { lotId, reason, staffId } → { lot_id, payment_id, amount_kopecks, refund_id };
 * 409 package_used — из партии уже списано; already_refunded — уже отозвана;
 * пакет, проданный на кассе (платёж kind bar), — bad_request: его деньги возвращает pos, партию — revokeLotOnly.
 */
export async function revokePackageLot(db, args, injected) {
  const inj = injected ?? (await rt());
  const { revokeLot } = await import('../packages/balance.mjs');
  const { packageItem } = await import('../packages/service.mjs');
  if (!UUID.test(args.lotId ?? '') || !UUID.test(args.staffId ?? '')) throw new MoneyError('bad_request', 'lotId, staffId');
  const { rows } = await db.query('select p.kind from bl.balance_lots l join bl.payments p on p.id = l.payment_id where l.id = $1', [args.lotId]);
  if (!rows[0]) throw new MoneyError('not_found', 'lot');
  if (rows[0].kind !== 'package') throw new MoneyError('bad_request', 'пакет продан на кассе: возврат — через кассу (pos)');
  const now = inj.deps.clock.now();
  const { lot, payment } = await revokeLot(db, inj.deps, { ...args, now });
  const { rows: pk } = await db.query('select * from bl.tariff_packages where id = $1', [lot.package_id]);
  const settings = await loadPaymentSettings(db, lot.club_id, { isTest: payment.is_test });
  const amount = Number(lot.price_kopecks);
  // Ключ pkr-<lot>; после возврата, отменённого ЮKassa (партия восстановлена), — pkr-<lot>-<n>.
  const { rows: tries } = await db.query("select count(*)::int as n from bl.refunds where payment_id = $1 and idempotence_key like $2 and status = 'canceled'", [payment.id, `pkr-${lot.id}%`]);
  const key = tries[0].n > 0 ? `pkr-${lot.id}-${tries[0].n}` : `pkr-${lot.id}`;
  const r = await refund(
    db,
    {
      paymentId: payment.id,
      amountKopecks: amount,
      reason: args.reason,
      key,
      items: [packageItem({ ...pk[0], price_kopecks: amount }, settings.vat_code)],
      requestedBy: args.staffId,
      description: `Возврат пакета часов «${pk[0].title}»`,
    },
    inj,
  );
  return { lot_id: lot.id, payment_id: payment.id, amount_kopecks: amount, refund_id: r.refund_id };
}

/**
 * Только отозвать партию (пакет, проданный на кассе): деньги возвращает pos в своём возврате.
 * { lotId, reason, staffId } → { lot_id, payment_id, amount_kopecks }; те же 409, журнал и тревога.
 */
export async function revokeLotOnly(db, args, injected) {
  const { deps } = injected ?? (await rt());
  const { revokeLot } = await import('../packages/balance.mjs');
  if (!UUID.test(args.lotId ?? '') || !UUID.test(args.staffId ?? '')) throw new MoneyError('bad_request', 'lotId, staffId');
  const { lot, payment } = await revokeLot(db, deps, { ...args, now: deps.clock.now() });
  return { lot_id: lot.id, payment_id: payment.id, amount_kopecks: Number(lot.price_kopecks) };
}
