// API подписки (M5.3 §3, №185, №186). Функции работают в транзакции запроса (роутер):
//   * клуб — контекст клуба (владелец; управляющий — только состояние и плашка);
//   * платформа — контекст платформы (bl.ctx_platform_role()): оператор — чтение, Андрей — всё.
// Без пары ключей магазина платформы — 503 billing_unavailable.

import { randomUUID } from 'node:crypto';
import { formatDate } from '@billiardum/shared/format';
import { HttpError } from '../http/errors.mjs';
import { appendAudit } from '../lib/audit.mjs';
import { isLiveClub } from '../lib/club-mode.mjs';
import { manualReason } from '../lib/manual.mjs';
import { formatValue, YooKassaError } from '../payments/yookassa.mjs';
import {
  BIND_AMOUNT_KOPECKS,
  cardJson,
  defaultPlan,
  ensureSubscription,
  isUuid,
  notifyClub,
  openInvoice,
  planOf,
  platformClient,
  platformReceipt,
  rub,
  unavailable,
} from './core.mjs';
import { autopayReady, bannerFor, effectivePrice, localDate, periodEnd, subscriptionState } from './period.mjs';

const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,189}\.[^@\s]{1,63}$/;
const MAX_PRICE = 100_000_000;
/** Неоплаченная попытка владельца по счёту блокирует новую столько времени (страница ЮKassa). */
const OWNER_PAYMENT_WINDOW_MS = 60 * 60_000;
const iso = (v) => (v instanceof Date ? v.toISOString() : (v ?? null));
const dateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v ?? null));

function requireConfigured(config) {
  if (!config?.configured) throw unavailable();
}

function planJson(plan) {
  return { id: plan.id, code: plan.code, title: plan.title, price_per_table_kopecks: Number(plan.price_per_table_kopecks), trial_days: plan.trial_days, active: plan.active };
}

function invoiceBrief(inv) {
  if (!inv) return null;
  return {
    id: inv.id,
    period_start: dateStr(inv.period_start),
    period_end: dateStr(inv.period_end),
    amount_kopecks: Number(inv.amount_kopecks),
    attempts: inv.attempts,
    next_attempt_at: iso(inv.next_attempt_at),
    last_error: inv.last_error ?? null,
  };
}

async function clubInfo(db, clubId) {
  const { rows } = await db.query('select id, timezone, mode, mode_before_suspend from bl.clubs where id = $1', [clubId]);
  if (!rows[0]) throw new HttpError(404, 'not_found');
  return rows[0];
}

async function activeTables(db, clubId) {
  const { rows } = await db.query('select count(*)::integer as n from bl.resources where club_id = $1 and active', [clubId]);
  return rows[0].n;
}

// Клуб ---------------------------------------------------------------------------------------------

/**
 * GET /api/clubs/{club}/subscription. Владелец — всё (§3); управляющий — {mode, state, trial_until,
 * paid_until, banner}. Клуб в test — подписки ещё нет: state 'trial', trial_until null.
 */
export async function getSubscription(db, { clubId, owner, now, config }) {
  requireConfigured(config);
  await ensureSubscription(db, clubId);
  const club = await clubInfo(db, clubId);
  const { rows } = await db.query('select * from bl.club_subscriptions where club_id = $1', [clubId]);
  const sub = rows[0] ?? null;
  const live = isLiveClub(club.mode, club.mode_before_suspend);
  const open = sub ? await openInvoice(db, clubId) : null;
  const state = sub ? subscriptionState(sub, { now, live, openInvoice: open }) : 'trial';
  const banner = sub ? bannerFor(sub, { now, live, openInvoice: open }) : null;
  const base = { mode: club.mode, state, trial_until: iso(sub?.trial_until), paid_until: iso(sub?.paid_until), banner };
  if (!owner) return base;

  const plan = sub ? await planOf(db, sub.plan_id) : await defaultPlan(db);
  const price = sub ? effectivePrice(sub, plan) : Number(plan.price_per_table_kopecks);
  const tables = await activeTables(db, clubId);
  let nextInvoice = null;
  if (open) nextInvoice = { date: dateStr(open.period_start), amount_kopecks: Number(open.amount_kopecks), invoice_id: open.id };
  else if (sub && live) nextInvoice = { date: localDate(periodEnd(sub), club.timezone), amount_kopecks: tables * price, invoice_id: null };
  const { rows: pending } = await db.query(
    "select purpose from bl.billing_payments where club_id = $1 and initiated_by = 'owner' and status in ('pending', 'waiting_for_capture') and created_at > $2 order by created_at desc limit 1",
    [clubId, new Date(now.getTime() - OWNER_PAYMENT_WINDOW_MS)],
  );
  return {
    ...base,
    plan: { id: plan.id, code: plan.code, title: plan.title },
    price_per_table_kopecks: price,
    personal_price: sub?.personal_price_kopecks != null,
    tables,
    trial_days: plan.trial_days,
    next_invoice: nextInvoice,
    open_invoice: invoiceBrief(open),
    card: cardJson(sub?.card ?? null),
    autopay: autopayReady(sub),
    receipt_email: sub?.receipt_email ?? null,
    card_pending: pending.length > 0,
  };
}

/** GET /api/clubs/{club}/subscription/invoices — владелец: история счетов с чеками. */
export async function listInvoices(db, { clubId, config }) {
  requireConfigured(config);
  const { rows } = await db.query(
    `select i.*, p.receipt_status, p.receipt_email
       from bl.billing_invoices i left join bl.billing_payments p on p.id = i.payment_id
      where i.club_id = $1
      order by i.period_start desc
      limit 120`,
    [clubId],
  );
  return {
    items: rows.map((r) => ({
      id: r.id,
      period_start: dateStr(r.period_start),
      period_end: dateStr(r.period_end),
      tables: r.tables,
      price_per_table_kopecks: Number(r.price_per_table_kopecks),
      amount_kopecks: Number(r.amount_kopecks),
      status: r.status,
      paid_at: iso(r.paid_at),
      paid_via: r.paid_via ?? null,
      receipt: r.paid_via === 'card' ? { status: r.receipt_status ?? 'pending', email: r.receipt_email ?? null } : null,
      document: r.paid_via === 'manual' ? r.manual_document : null,
      attempts: r.attempts,
      next_attempt_at: iso(r.next_attempt_at),
      last_error: r.last_error ?? null,
    })),
  };
}

function parseReturnUrl(value, config) {
  if (value === undefined || value === null) return config.returnUrl;
  if (typeof value !== 'string' || value.length > 2000) throw new HttpError(400, 'bad_request', { detail: 'return_url' });
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new HttpError(400, 'bad_request', { detail: 'return_url' });
  }
  // Только свой адрес: владельца не уведут после оплаты на чужой сайт.
  if (!config.returnOrigins.includes(u.origin) || u.username || u.password) throw new HttpError(400, 'bad_request', { detail: 'return_url' });
  return u.toString();
}

function parseEmail(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(400, 'bad_request', { detail: 'email' });
  const e = value.trim().toLowerCase();
  if (e.length > 254 || !EMAIL.test(e)) throw new HttpError(400, 'bad_request', { detail: 'email' });
  return e;
}

/**
 * POST /api/clubs/{club}/subscription/card {return_url?, email?} → {confirmation_url, payment_id, purpose, amount_kopecks}.
 * Владелец вводит карту на странице ЮKassa (save_payment_method, №183). Есть неоплаченный счёт —
 * это оплата счёта картой; нет — привязка карты 1 ₽ заморозкой (заморозка сразу снимается, денег
 * клуб не платит, чек не нужен). Email для чека обязателен, если не сохранён раньше.
 */
export async function startCard(db, deps, config, { clubId, userId, body, now }) {
  requireConfigured(config);
  await ensureSubscription(db, clubId);
  const { rows } = await db.query('select * from bl.club_subscriptions where club_id = $1', [clubId]);
  const sub = rows[0];
  // Клуб в test подписки не платит (№181): карта — после перехода в боевой режим.
  if (!sub) throw new HttpError(409, 'billing_unavailable', { detail: 'club is not live' });
  const email = parseEmail(body?.email) ?? sub.receipt_email;
  if (!email) throw new HttpError(400, 'bad_request', { detail: 'email' });
  const returnUrl = parseReturnUrl(body?.return_url, config);
  const open = await openInvoice(db, clubId);
  if (open) {
    const busy = await db.query(
      "select 1 from bl.billing_payments where invoice_id = $1 and status in ('pending', 'waiting_for_capture') and (initiated_by = 'autopay' or created_at > $2) limit 1",
      [open.id, new Date(now.getTime() - OWNER_PAYMENT_WINDOW_MS)],
    );
    if (busy.rowCount > 0) throw new HttpError(409, 'payment_pending');
  }
  const purpose = open ? 'invoice' : 'bind';
  const amount = open ? Number(open.amount_kopecks) : BIND_AMOUNT_KOPECKS;
  const id = randomUUID();
  const key = `bl-sub-own-${id}`;
  const request = {
    amount: { value: formatValue(amount), currency: 'RUB' },
    capture: purpose === 'invoice',
    save_payment_method: true,
    payment_method_data: { type: 'bank_card' },
    confirmation: { type: 'redirect', return_url: returnUrl },
    description: purpose === 'invoice'
      ? `Подписка «Бильярдум» с ${dateStr(open.period_start)} по ${dateStr(open.period_end)}`
      : 'Привязка карты для автоплатежа подписки «Бильярдум» (1 ₽ вернётся сразу)',
    metadata: { kind: 'subscription', club_id: clubId, billing_payment_id: id, purpose, ...(open ? { invoice_id: open.id } : {}) },
    receipt: platformReceipt({ email, amountKopecks: amount, config }),
  };
  let remote;
  try {
    remote = await platformClient(config).createPayment(request, key);
  } catch (err) {
    if (err instanceof YooKassaError) {
      deps.log?.warn?.('billing_card_start_failed', { club_id: clubId, status: err.status, code: err.code });
      throw new HttpError(err.retryable ? 503 : 502, err.retryable ? 'yookassa_unavailable' : 'payment_failed', { detail: err.code });
    }
    throw err;
  }
  const confirmationUrl = typeof remote?.confirmation?.confirmation_url === 'string' ? remote.confirmation.confirmation_url : null;
  await db.query(
    `insert into bl.billing_payments (id, club_id, invoice_id, purpose, initiated_by, created_by, shop_id, provider_payment_id, idempotence_key,
                                      amount_kopecks, status, save_method, confirmation_url, receipt_email, created_at, updated_at)
     values ($1, $2, $3, $4, 'owner', $5, $6, $7, $8, $9, 'pending', true, $10, $11, $12, $12)`,
    [id, clubId, open?.id ?? null, purpose, userId, config.shopId, remote.id, key, amount, confirmationUrl, email, now],
  );
  await appendAudit(db, {
    action: 'billing.card_start',
    objectType: 'billing_payment',
    objectId: id,
    actorType: 'user',
    actorId: userId,
    data: { club_id: clubId, payment_id: id, purpose, invoice_id: open?.id ?? null, amount_kopecks: amount },
  });
  return { payment_id: id, purpose, amount_kopecks: amount, confirmation_url: confirmationUrl };
}

/** DELETE /api/clubs/{club}/subscription/autopay {reason?} — владелец; карты нет — 409 card_required. */
export async function disableAutopay(db, deps, config, { clubId, userId, body, now }) {
  requireConfigured(config);
  let reason = null;
  if (body?.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== 'string' || body.reason.length > 2000) throw new HttpError(400, 'bad_request', { detail: 'reason' });
    reason = body.reason.trim() || null;
  }
  let had;
  try {
    had = (await db.query('select bl.billing_disable_autopay($1, $2) as had', [clubId, now])).rows[0].had;
  } catch (err) {
    if (err.code === '42501') throw new HttpError(403, 'forbidden');
    throw err;
  }
  if (!had) throw new HttpError(409, 'card_required');
  await appendAudit(db, { action: 'billing.autopay_off', objectType: 'club', objectId: clubId, actorType: 'user', actorId: userId, reason, data: { club_id: clubId } });
  deps.log?.info?.('billing_autopay_off', { club_id: clubId });
  return { autopay: false, card: null };
}

// Платформа ----------------------------------------------------------------------------------------

/** Начало текущего месяца по Москве (оплаты за месяц, №186). */
function monthStart(now) {
  const d = localDate(now, 'Europe/Moscow').slice(0, 8);
  return new Date(`${d}01T00:00:00+03:00`);
}

/**
 * GET /api/platform/subscriptions — оператор и Андрей: состояние каждого клуба, долг, MRR,
 * оплаты за месяц, планы.
 */
export async function platformList(db, { now, config }) {
  requireConfigured(config);
  const { rows: clubs } = await db.query('select * from bl.billing_clubs()');
  for (const c of clubs) await ensureSubscription(db, c.club_id);
  const { rows: subs } = await db.query('select * from bl.club_subscriptions');
  const { rows: plans } = await db.query('select * from bl.billing_plans order by code');
  const { rows: open } = await db.query(
    "select club_id, count(*)::integer as n, sum(amount_kopecks)::bigint as debt, min(period_start) as since from bl.billing_invoices where status = 'open' group by club_id",
  );
  const { rows: opened } = await db.query("select distinct on (club_id) * from bl.billing_invoices where status = 'open' order by club_id, period_start");
  const { rows: paid } = await db.query(
    "select coalesce(sum(amount_kopecks), 0)::bigint as total, count(*)::integer as n from bl.billing_invoices where status = 'paid' and paid_via <> 'free' and paid_at >= $1",
    [monthStart(now)],
  );
  const subOf = new Map(subs.map((s) => [s.club_id, s]));
  const planById = new Map(plans.map((p) => [p.id, p]));
  const debtOf = new Map(open.map((r) => [r.club_id, r]));
  const firstOpen = new Map(opened.map((r) => [r.club_id, r]));
  const counts = { trial: 0, active: 0, past_due: 0, unpaid: 0, canceled: 0 };
  let mrr = 0;
  let debtTotal = 0;
  const items = clubs.map((c) => {
    const sub = subOf.get(c.club_id) ?? null;
    const plan = sub ? planById.get(sub.plan_id) : plans.find((p) => p.code === 'club');
    const live = isLiveClub(c.mode, c.mode_before_suspend);
    const state = sub ? subscriptionState(sub, { now, live, openInvoice: firstOpen.get(c.club_id) ?? null }) : 'trial';
    counts[state] += 1;
    const price = sub ? effectivePrice(sub, plan) : Number(plan.price_per_table_kopecks);
    const monthly = c.tables * price;
    if (c.mode === 'live' && ['active', 'past_due', 'unpaid'].includes(state)) mrr += monthly;
    const debt = Number(debtOf.get(c.club_id)?.debt ?? 0);
    debtTotal += debt;
    return {
      club_id: c.club_id,
      name: c.name,
      city: c.city,
      mode: c.mode,
      state,
      plan: plan ? { id: plan.id, code: plan.code, title: plan.title } : null,
      price_per_table_kopecks: price,
      personal_price: sub?.personal_price_kopecks != null,
      personal_price_reason: sub?.personal_price_reason ?? null,
      tables: c.tables,
      monthly_kopecks: monthly,
      went_live_at: iso(c.went_live_at),
      trial_until: iso(sub?.trial_until),
      paid_until: iso(sub?.paid_until),
      debt_kopecks: debt,
      open_invoice: invoiceBrief(firstOpen.get(c.club_id) ?? null),
      autopay: autopayReady(sub),
      card: Boolean(sub?.card),
    };
  });
  return {
    items,
    plans: plans.map(planJson),
    totals: {
      mrr_kopecks: mrr,
      paid_this_month_kopecks: Number(paid[0].total),
      payments_this_month: paid[0].n,
      debt_kopecks: debtTotal,
      clubs: counts,
    },
  };
}

/**
 * POST /api/platform/subscriptions/{club}/mark-paid {invoice_id, reason, document} — Андрей:
 * юрлицо оплатило счёт с расчётного счёта (№183). Ручное действие платформы: причина, номер
 * платёжки, журнал платформы manual.billing_mark_paid, уведомление владельцу.
 */
export async function markPaid(db, deps, config, { clubId, body, now }) {
  requireConfigured(config);
  const reason = manualReason(body?.reason);
  const document = typeof body?.document === 'string' ? body.document.trim() : '';
  if (!document || document.length > 200) throw new HttpError(400, 'bad_request', { detail: 'document' });
  if (!isUuid(body?.invoice_id)) throw new HttpError(400, 'bad_request', { detail: 'invoice_id' });
  const { rows } = await db.query('select * from bl.billing_invoices where id = $1 and club_id = $2', [body.invoice_id, clubId]);
  const inv = rows[0];
  if (!inv) throw new HttpError(404, 'not_found');
  if (inv.status === 'paid') throw new HttpError(409, 'invoice_paid');
  let done;
  try {
    done = (await db.query("select bl.billing_settle_invoice($1, 'manual', null, $2, $3, $4) as done", [inv.id, reason, document, now])).rows[0].done;
  } catch (err) {
    if (err.code === '42501') throw new HttpError(403, 'forbidden');
    if (err.code === '22023') throw new HttpError(400, 'bad_request', { detail: err.message });
    throw err;
  }
  if (!done) throw new HttpError(409, 'invoice_paid');
  await appendAudit(db, {
    action: 'manual.billing_mark_paid',
    objectType: 'billing_invoice',
    objectId: inv.id,
    reason,
    data: { club_id: clubId, invoice_id: inv.id, amount_kopecks: Number(inv.amount_kopecks), document, period_start: dateStr(inv.period_start), period_end: dateStr(inv.period_end) },
  });
  const { rows: s } = await db.query('select paid_until from bl.club_subscriptions where club_id = $1', [clubId]);
  const { rows: c } = await db.query('select timezone from bl.billing_clubs() where club_id = $1', [clubId]);
  await notifyClub(db, clubId, {
    kind: 'billing.payment_succeeded',
    level: 'info',
    text: `Платформа «Бильярдум» отметила оплату подписки по счёту: ${rub(inv.amount_kopecks)}, оплачено до ${formatDate(s[0].paid_until, c[0]?.timezone ?? 'Europe/Moscow')}.`,
    data: { invoice_id: inv.id },
  }, { roles: ['owner'] });
  deps.log?.info?.('billing_mark_paid', { club_id: clubId, invoice_id: inv.id });
  return { invoice_id: inv.id, status: 'paid', paid_via: 'manual', paid_until: iso(s[0].paid_until) };
}

/**
 * PUT /api/platform/subscriptions/{club}/price {price_per_table_kopecks | null, reason} — Андрей:
 * персональная цена клуба с причиной (№180); null — цена плана. Журнал платформы manual.billing_price.
 * Действует со следующего счёта.
 */
export async function setPrice(db, deps, config, { clubId, body, now }) {
  requireConfigured(config);
  const reason = manualReason(body?.reason);
  const price = body?.price_per_table_kopecks;
  if (price !== null && (!Number.isSafeInteger(price) || price < 0 || price > MAX_PRICE)) throw new HttpError(400, 'bad_request', { detail: 'price_per_table_kopecks' });
  await ensureSubscription(db, clubId);
  let old;
  try {
    old = (await db.query('select bl.billing_set_price($1, $2, $3, $4) as old', [clubId, price, reason, now])).rows[0].old;
  } catch (err) {
    if (err.code === 'P0002') throw new HttpError(404, 'not_found');
    if (err.code === '42501') throw new HttpError(403, 'forbidden');
    if (err.code === '22023') throw new HttpError(400, 'bad_request', { detail: err.message });
    throw err;
  }
  const { rows } = await db.query('select s.*, p.price_per_table_kopecks as plan_price from bl.club_subscriptions s join bl.billing_plans p on p.id = s.plan_id where s.club_id = $1', [clubId]);
  const sub = rows[0];
  const effective = effectivePrice(sub, { price_per_table_kopecks: sub.plan_price });
  await appendAudit(db, {
    action: 'manual.billing_price',
    objectType: 'club',
    objectId: clubId,
    reason,
    data: { club_id: clubId, from: old === null ? null : Number(old), to: price, plan_price_kopecks: Number(sub.plan_price) },
  });
  await notifyClub(db, clubId, {
    kind: 'billing.price',
    level: 'info',
    text: `Цена подписки «Бильярдум» для клуба: ${rub(effective)} за стол в месяц со следующего счёта.`,
  }, { roles: ['owner'] });
  deps.log?.info?.('billing_price_set', { club_id: clubId, personal: price !== null });
  return { club_id: clubId, price_per_table_kopecks: effective, personal_price: price !== null };
}

/**
 * PUT /api/platform/plans/{id} {title?, price_per_table_kopecks?, active?, reason?} — Андрей (№180).
 * Новая цена действует со следующих счетов клубов на этом плане без персональной цены.
 */
export async function updatePlan(db, deps, config, { planId, userId, body, now }) {
  requireConfigured(config);
  const sets = [];
  const params = [planId];
  const changes = {};
  if (body?.title !== undefined) {
    const t = typeof body.title === 'string' ? body.title.trim() : '';
    if (!t || t.length > 100) throw new HttpError(400, 'bad_request', { detail: 'title' });
    params.push(t);
    sets.push(`title = $${params.length}`);
    changes.title = t;
  }
  if (body?.price_per_table_kopecks !== undefined) {
    const p = body.price_per_table_kopecks;
    if (!Number.isSafeInteger(p) || p < 0 || p > MAX_PRICE) throw new HttpError(400, 'bad_request', { detail: 'price_per_table_kopecks' });
    params.push(p);
    sets.push(`price_per_table_kopecks = $${params.length}`);
    changes.price_per_table_kopecks = p;
  }
  if (body?.active !== undefined) {
    if (typeof body.active !== 'boolean') throw new HttpError(400, 'bad_request', { detail: 'active' });
    params.push(body.active);
    sets.push(`active = $${params.length}`);
    changes.active = body.active;
  }
  if (sets.length === 0) throw new HttpError(400, 'bad_request', { detail: 'nothing to change' });
  let reason = null;
  if (body?.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== 'string' || body.reason.length > 2000) throw new HttpError(400, 'bad_request', { detail: 'reason' });
    reason = body.reason.trim() || null;
  }
  const before = await planOf(db, planId);
  if (!before) throw new HttpError(404, 'not_found');
  params.push(now, userId);
  const { rows } = await db.query(
    `update bl.billing_plans set ${sets.join(', ')}, updated_at = $${params.length - 1}, updated_by = $${params.length} where id = $1 returning *`,
    params,
  );
  if (!rows[0]) throw new HttpError(403, 'forbidden');
  await appendAudit(db, {
    action: 'billing.plan_update',
    objectType: 'billing_plan',
    objectId: planId,
    reason,
    data: { plan_id: planId, from: { title: before.title, price_per_table_kopecks: Number(before.price_per_table_kopecks), active: before.active }, to: changes },
  });
  deps.log?.info?.('billing_plan_updated', { plan_id: planId });
  return planJson(rows[0]);
}

