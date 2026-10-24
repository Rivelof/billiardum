// Планировщик подписки (M5.3 №181–184). Проход раз в минуту по часам ctx.clock, контекст платформы.
//
// По каждому клубу в боевом режиме (bl.billing_clubs), в своей транзакции, подписка заблокирована:
//   1. подписки нет — создать с пробным периодом (bl.billing_ensure_subscription);
//   2. кончился пробный или оплаченный период и счёта нет — счёт на следующий месяц: столы в работе
//      × цена клуба на дату счёта (№182); сумма 0 — оплачен сразу (free);
//   3. открытый счёт, срок попытки наступил, автоплатёж настроен — списание по сохранённому способу
//      с ключом идемпотентности счёта и попытки; отказ — повтор через 1 и 3 дня после первой неудачи;
//      карты нет — счёт ждёт карту (last_error card_required), владельцу и управляющему уведомление;
//   4. до конца периода ≤ 7 дней, а автоплатёж не настроен — уведомление (один раз за период);
//   5. 14 дней после конца периода без оплаты — уведомление Андрею (один раз за счёт): он сам решает,
//      приостанавливать ли клуб.
// Ничего не отключается автоматически: режим клуба, свет и игры планировщик не трогает (№184,
// инвариант 3). Приостановленный и вернувшийся в test клуб — без счетов и списаний.
// Затем — сверка платежей платформы, по которым нет итога (вебхук не пришёл).

import { formatDate, plural } from '@billiardum/shared/format';
import { appendAudit } from '../lib/audit.mjs';
import { sendPlatform } from '../notify/index.mjs';
import { formatValue, YooKassaError } from '../payments/yookassa.mjs';
import {
  applyRemote,
  chargeKey,
  dayWord,
  decryptMethod,
  ensureSubscription,
  lockSubscription,
  notifyClub,
  planOf,
  platformClient,
  platformReceipt,
  recordFailure,
  rub,
  stableUuid,
  syncPayment,
} from './core.mjs';
import { autopayReady, DAY_MS, daysLeft, effectivePrice, MAX_ATTEMPTS, periodEnd, periodFrom, PLATFORM_NOTIFY_DAYS, REMIND_DAYS } from './period.mjs';

export const TICK_MS = 60_000;
/** Сверка платежа без итога: не раньше чем через столько после создания и прошлой сверки. */
export const SYNC_AFTER_MS = 30_000;
const SYNC_WINDOW_MS = 7 * DAY_MS;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;

const description = (inv) => `Подписка «Бильярдум» с ${inv.period_start} по ${inv.period_end}`.slice(0, 128);

/** Счёт за период, который начинается в конце текущего (или null, если уже есть). */
async function issueInvoice(db, deps, { club, sub, plan, now }) {
  const per = periodFrom(periodEnd(sub), sub.anchor_day, club.timezone);
  const price = effectivePrice(sub, plan);
  const tables = Number(club.tables);
  const { rows } = await db.query(
    `insert into bl.billing_invoices (club_id, period_start, period_end, period_start_at, period_end_at, tables, price_per_table_kopecks, amount_kopecks,
                                      next_attempt_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $9)
     on conflict (club_id, period_start) do nothing
     returning *`,
    [club.club_id, per.start, per.end, per.startAt, per.endAt, tables, price, tables * price, now],
  );
  const inv = rows[0];
  if (!inv) return null;
  await appendAudit(db, {
    action: 'billing.invoice_issued',
    objectType: 'billing_invoice',
    objectId: inv.id,
    data: { club_id: club.club_id, invoice_id: inv.id, period_start: per.start, period_end: per.end, tables, price_per_table_kopecks: price, amount_kopecks: tables * price },
  });
  deps.log?.info?.('billing_invoice_issued', { club_id: club.club_id, invoice_id: inv.id, amount_kopecks: tables * price });
  if (tables * price === 0) {
    await db.query("select bl.billing_settle_invoice($1, 'free', null, null, null, $2)", [inv.id, now]);
    await appendAudit(db, { action: 'billing.invoice_paid', objectType: 'billing_invoice', objectId: inv.id, data: { club_id: club.club_id, invoice_id: inv.id, via: 'free', amount_kopecks: 0 } });
    return null;
  }
  return inv;
}

/** Карты нет или автоплатёж выключен: счёт ждёт карту, уведомление — один раз на счёт. */
async function waitForCard(db, { club, inv, now }) {
  if (inv.last_error === 'card_required' && inv.next_attempt_at === null) return;
  await db.query("update bl.billing_invoices set last_error = 'card_required', next_attempt_at = null, updated_at = $2 where id = $1", [inv.id, now]);
  await notifyClub(db, club.club_id, {
    kind: 'billing.card_required',
    level: 'important',
    text: `Выставлен счёт за подписку «Бильярдум»: ${rub(inv.amount_kopecks)} за ${inv.tables} ${plural(inv.tables, ['стол', 'стола', 'столов'])} до ${formatDate(inv.period_end_at, club.timezone)}. Автоплатёж не настроен — оплатите картой в разделе «Подписка».`,
    data: { invoice_id: inv.id },
  });
}

/** Автосписание по сохранённому способу (№183): ключ идемпотентности — счёт и номер попытки. */
async function charge(db, deps, config, { club, sub, inv, now }) {
  const attempt = inv.attempts + 1;
  const id = stableUuid(`${inv.id}:${attempt}`);
  const key = chargeKey(inv.id, attempt);
  const existing = await db.query('select status from bl.billing_payments where id = $1', [id]);
  if (existing.rows[0]) return 'exists';
  const client = platformClient(config);
  const methodId = decryptMethod(sub.payment_method_enc, config.encKey, club.club_id);
  const amount = Number(inv.amount_kopecks);
  const email = sub.receipt_email;
  const body = {
    amount: { value: formatValue(amount), currency: 'RUB' },
    capture: true,
    payment_method_id: methodId,
    description: description(inv),
    metadata: { kind: 'subscription', club_id: club.club_id, billing_payment_id: id, purpose: 'invoice', invoice_id: inv.id },
    receipt: platformReceipt({ email, amountKopecks: amount, config }),
  };
  let remote;
  try {
    remote = await client.createPayment(body, key);
  } catch (err) {
    if (!(err instanceof YooKassaError)) throw err;
    if (err.retryable) {
      // Сбой сети или 5xx: попытка не засчитана, следующий проход повторит тем же ключом.
      deps.log?.warn?.('billing_charge_retry', { club_id: club.club_id, invoice_id: inv.id, attempt, code: err.code });
      return 'retry';
    }
    const error = CODE.test(err.code ?? '') ? err.code : 'declined';
    await db.query(
      `insert into bl.billing_payments (id, club_id, invoice_id, purpose, initiated_by, attempt, shop_id, idempotence_key, amount_kopecks, status, error, receipt_email, created_at, updated_at)
       values ($1, $2, $3, 'invoice', 'autopay', $4, $5, $6, $7, 'canceled', $8, $9, $10, $10)`,
      [id, club.club_id, inv.id, attempt, config.shopId, key, amount, error, email, now],
    );
    await recordFailure(db, deps, { invoice: inv, attempt, error, now });
    return 'failed';
  }
  const { rows } = await db.query(
    `insert into bl.billing_payments (id, club_id, invoice_id, purpose, initiated_by, attempt, created_by, shop_id, provider_payment_id, idempotence_key,
                                      amount_kopecks, status, receipt_email, created_at, updated_at)
     values ($1, $2, $3, 'invoice', 'autopay', $4, $5, $6, $7, $8, $9, 'pending', $10, $11, $11)
     returning *`,
    [id, club.club_id, inv.id, attempt, sub.card_saved_by, config.shopId, remote.id, key, amount, email, now],
  );
  await appendAudit(db, { action: 'billing.charge', objectType: 'billing_payment', objectId: id, data: { club_id: club.club_id, invoice_id: inv.id, attempt, amount_kopecks: amount } });
  return applyRemote(db, deps, config, rows[0], remote, { via: 'create', now, client });
}

async function openInvoices(db, clubId) {
  const { rows } = await db.query("select * from bl.billing_invoices where club_id = $1 and status = 'open' order by period_start", [clubId]);
  return rows;
}

/**
 * Приостановка и возобновление (№188): пока клуб приостановлен, счета не выставляются и не
 * списываются; при возобновлении срок сдвигается на время приостановки (bl.billing_resume), а если
 * он кончился ещё до приостановки — следующий счёт с даты возобновления, прежний долг остаётся.
 * @returns {Promise<object>} подписка после возобновления (или та же)
 */
async function suspension(db, deps, { club, sub, now }) {
  if (club.mode === 'suspended') {
    if (!sub.suspended_since) {
      // Начало — по часам планировщика (как и возобновление): погрешность — один проход.
      const since = now;
      await db.query('update bl.club_subscriptions set suspended_since = $2, updated_at = $3 where club_id = $1', [club.club_id, since, now]);
      await appendAudit(db, { action: 'billing.suspended', objectType: 'club', objectId: club.club_id, data: { club_id: club.club_id, since: new Date(since).toISOString() } });
    }
    return sub;
  }
  if (club.mode !== 'live' || !sub.suspended_since) return sub;
  const { rows } = await db.query('select bl.billing_resume($1, $2) as r', [club.club_id, now]);
  const r = rows[0].r;
  if (r) {
    await appendAudit(db, { action: 'billing.resumed', objectType: 'club', objectId: club.club_id, data: { club_id: club.club_id, ...r, suspended_since: new Date(sub.suspended_since).toISOString() } });
    deps.log?.info?.('billing_resumed', { club_id: club.club_id, kind: r.kind });
  }
  return lockSubscription(db, club.club_id);
}

/** Один клуб: транзакция в контексте платформы. */
export async function processClub(db, deps, config, club, now) {
  await ensureSubscription(db, club.club_id);
  let sub = await lockSubscription(db, club.club_id);
  if (!sub) return 'skip';
  sub = await suspension(db, deps, { club, sub, now });
  if (club.mode !== 'live') return 'skip';
  const plan = await planOf(db, sub.plan_id);
  // Счёт за период с конца текущего (один на период: повтор — on conflict).
  if (now.getTime() >= periodEnd(sub).getTime()) {
    await issueInvoice(db, deps, { club, sub, plan, now });
    sub = await lockSubscription(db, club.club_id);
  }
  // Списание: старейший открытый счёт, срок попытки которого наступил (не больше одного за проход).
  for (const inv of await openInvoices(db, club.club_id)) {
    if (Number(inv.amount_kopecks) === 0 || inv.attempts >= MAX_ATTEMPTS) continue;
    if (inv.next_attempt_at === null || new Date(inv.next_attempt_at).getTime() > now.getTime()) continue;
    const pending = await db.query("select 1 from bl.billing_payments where invoice_id = $1 and status in ('pending', 'waiting_for_capture') limit 1", [inv.id]);
    if (pending.rowCount > 0) continue;
    if (!autopayReady(sub)) {
      await waitForCard(db, { club, inv, now });
      continue;
    }
    await charge(db, deps, config, { club, sub, inv, now });
    break;
  }
  const open = await openInvoices(db, club.club_id);
  sub = await lockSubscription(db, club.club_id);

  // За 7 дней до конца периода, если автоплатёж не сработает сам (№184) — один раз за период.
  const end = periodEnd(sub);
  const left = end.getTime() - now.getTime();
  if (open.length === 0 && left > 0 && left <= REMIND_DAYS * DAY_MS && !autopayReady(sub) && new Date(sub.reminder_for ?? 0).getTime() !== end.getTime()) {
    await db.query('update bl.club_subscriptions set reminder_for = $2, updated_at = $3 where club_id = $1', [club.club_id, end, now]);
    const n = daysLeft(end, now);
    const what = sub.paid_until ? 'Оплаченный период подписки «Бильярдум»' : 'Пробный период «Бильярдум»';
    await notifyClub(db, club.club_id, {
      kind: 'billing.reminder',
      level: 'important',
      text: `${what} истекает через ${dayWord(n)}, ${formatDate(end, club.timezone)}. Привяжите карту для автоплатежа в разделе «Подписка».`,
    });
  }

  // 14 дней без оплаты — Андрею (№184), один раз на счёт; приостановка — только его решением.
  for (const inv of open) {
    if (inv.platform_notified_at || now.getTime() - new Date(inv.period_start_at).getTime() < PLATFORM_NOTIFY_DAYS * DAY_MS) continue;
    await db.query('update bl.billing_invoices set platform_notified_at = $2, updated_at = $2 where id = $1', [inv.id, now]);
    await appendAudit(db, { action: 'billing.overdue', objectType: 'billing_invoice', objectId: inv.id, data: { club_id: club.club_id, invoice_id: inv.id, amount_kopecks: Number(inv.amount_kopecks) } });
    await sendPlatform(db, {
      role: 'platform_admin',
      kind: 'platform.billing_overdue',
      level: 'important',
      text: `Клуб «${club.name}», ${club.city}: подписка не оплачена ${dayWord(PLATFORM_NOTIFY_DAYS)} (счёт ${rub(inv.amount_kopecks)}). Клуб работает как обычно; приостановить его можно в «Клубах и подписках».`,
      data: { club_id: club.club_id, invoice_id: inv.id },
    });
  }
  return 'done';
}

/**
 * Один проход планировщика (экспортирован для тестов с подставными часами).
 * @returns {Promise<{ clubs: number, synced: number, errors: number }>}
 */
export async function tick({ pool, withContext, deps, config, limit = 200 }) {
  if (!config?.configured) return { clubs: 0, synced: 0, errors: 0, skipped: 'billing_unavailable' };
  const now = deps.clock.now();
  const system = { clubId: null, actorType: 'system' };
  const { rows: clubs } = await withContext(pool, system, (db) => db.query('select * from bl.billing_clubs()'));
  let errors = 0;
  for (const club of clubs) {
    try {
      await withContext(pool, system, (db) => processClub(db, deps, config, club, now));
    } catch (err) {
      errors += 1;
      deps.log?.error?.('billing_club_failed', { club_id: club.club_id, error: err.code ?? err.message });
    }
  }
  const { rows: open } = await withContext(pool, system, (db) =>
    db.query(
      `select id from bl.billing_payments
        where status in ('pending', 'waiting_for_capture') and provider_payment_id is not null
          and created_at <= $1::timestamptz - $2 * interval '1 millisecond' and created_at > $1::timestamptz - $3 * interval '1 millisecond'
          and (checked_at is null or checked_at <= $1::timestamptz - $2 * interval '1 millisecond')
        order by created_at limit $4`,
      [now, SYNC_AFTER_MS, SYNC_WINDOW_MS, limit],
    ),
  );
  let synced = 0;
  for (const p of open) {
    try {
      await withContext(pool, system, (db) => syncPayment(db, deps, config, p.id, { via: 'sync', now }));
      synced += 1;
    } catch (err) {
      errors += 1;
      deps.log?.warn?.('billing_sync_failed', { payment_id: p.id, error: err.code ?? err.message });
    }
  }
  return { clubs: clubs.length, synced, errors };
}
