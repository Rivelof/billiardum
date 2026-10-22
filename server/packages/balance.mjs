// Баланс минут гостя в клубе (пакеты часов, decisions №112, контракт M3 §1 п. 10).
//
// * Покупка пакета — «партия» минут (bl.balance_lots) со сроком: N минут, цена, истекает через
//   valid_days. Источник — платёж покупки (ЮKassa в приложении или касса pos).
// * Списание — сначала партии, у которых раньше кончается срок; стоимость списанных минут —
//   доля цены партии нарастающим итогом (без потери копеек): она идёт в чек зачёта предоплаты.
// * Чек зачёта (позиции «полный расчёт», оплата «зачёт предоплаты») — по каждому платежу-источнику
//   партии, когда игра подтверждена (server/payments/settle.mjs). Отмена платежа игры
//   возвращает минуты в партии.
// db — транзакция с контекстом клуба.

import { formatMoney } from '../../shared/format.mjs';
import { MoneyError } from '../payments/errors.mjs';
import { receiptItems } from '../payments/receipt.mjs';
import { queueSettlementReceipt } from '../payments/settle.mjs';
import { loadPaymentSettings } from '../payments/settings.mjs';

const DAY_MS = 86_400_000;

/** round(price × used / total) «половина вверх», целые. */
function share(price, used, total) {
  return Math.floor((price * used * 2 + total) / (2 * total));
}

/** Остаток минут гостя: { minutes, lots: [{ id, minutes_left, expires_at, package_id }] }. */
export async function balanceOf(db, { clubId, userId, now }) {
  const { rows } = await db.query(
    `select id, package_id, minutes_left, minutes_total, expires_at from bl.balance_lots
      where club_id = $1 and user_id = $2 and minutes_left > 0 and expires_at > $3
      order by expires_at, created_at`,
    [clubId, userId, now],
  );
  return {
    minutes: rows.reduce((s, r) => s + r.minutes_left, 0),
    lots: rows.map((r) => ({ id: r.id, package_id: r.package_id, minutes_left: r.minutes_left, minutes_total: r.minutes_total, expires_at: new Date(r.expires_at).toISOString() })),
  };
}

/**
 * Начислить пакет по оплаченному платежу. Повтор — та же партия.
 * @param {{ payment: object, packageId?: string, userId?: string, index?: number, now: Date }} p
 *   payment — строка bl.payments (kind package — покупка в приложении; kind bar — касса pos)
 */
export async function creditPackage(db, deps, { payment, packageId = payment.package_id, userId = payment.user_id, index = 0, now }) {
  if (!packageId || !userId) throw new MoneyError('bad_request', 'пакет и гость обязательны');
  const sourceKey = `${payment.id}:${packageId}:${index}`;
  const prev = await db.query('select * from bl.balance_lots where source_key = $1', [sourceKey]);
  if (prev.rows[0]) return prev.rows[0];
  const { rows: pk } = await db.query('select * from bl.tariff_packages where id = $1', [packageId]);
  const pkg = pk[0];
  if (!pkg) throw new MoneyError('not_found', 'package');
  const price = payment.kind === 'package' ? Number(payment.amount_kopecks) : Number(pkg.price_kopecks);
  const { rows } = await db.query(
    `insert into bl.balance_lots (club_id, user_id, package_id, payment_id, minutes_total, minutes_left, price_kopecks, expires_at, source_key, created_at)
     values ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9) returning *`,
    [payment.club_id, userId, packageId, payment.id, pkg.minutes, price, new Date(now.getTime() + pkg.valid_days * DAY_MS), sourceKey, now],
  );
  await deps.audit.appendAudit(db, {
    action: 'package.credited',
    objectType: 'payment',
    objectId: payment.id,
    data: { payment_id: payment.id, package_id: packageId, lot_id: rows[0].id, minutes: pkg.minutes, user_id: userId },
    actorType: 'system',
  });
  return rows[0];
}

/**
 * Зарезервировать минуты (партии блокируются до конца транзакции).
 * @returns {Promise<{ minutes: number, valueKopecks: number, parts: { lot, minutes, value }[] }>}
 */
export async function planDebit(db, { clubId, userId, minutes, now }) {
  if (!Number.isInteger(minutes) || minutes < 1) throw new MoneyError('bad_request', 'minutes');
  const { rows } = await db.query(
    `select * from bl.balance_lots
      where club_id = $1 and user_id = $2 and minutes_left > 0 and expires_at > $3
      order by expires_at, created_at, id
      for update`,
    [clubId, userId, now],
  );
  const parts = [];
  let left = minutes;
  for (const lot of rows) {
    if (left === 0) break;
    const take = Math.min(left, lot.minutes_left);
    const total = lot.minutes_total;
    const price = Number(lot.price_kopecks);
    const usedBefore = total - lot.minutes_left;
    const value = share(price, usedBefore + take, total) - share(price, usedBefore, total);
    parts.push({ lot, minutes: take, value });
    left -= take;
  }
  if (left > 0) throw new MoneyError('limit_exceeded', 'на балансе меньше минут');
  return { minutes, valueKopecks: parts.reduce((s, x) => s + x.value, 0), parts };
}

/** Списать зарезервированные минуты под платёж игры paymentId. */
export async function applyDebit(db, plan, { paymentId, userId, now }) {
  for (const part of plan.parts) {
    await db.query('update bl.balance_lots set minutes_left = minutes_left - $2 where id = $1', [part.lot.id, part.minutes]);
    await db.query(
      `insert into bl.balance_debits (club_id, user_id, lot_id, payment_id, minutes, value_kopecks, created_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [part.lot.club_id, userId, part.lot.id, paymentId, part.minutes, part.value, now],
    );
  }
}

/** Отмена платежа игры: минуты возвращаются в партии. */
export async function restoreBalance(db, { paymentId, now }) {
  const { rows } = await db.query(
    `update bl.balance_debits set restored_at = $2 where payment_id = $1 and restored_at is null returning lot_id, minutes`,
    [paymentId, now],
  );
  for (const d of rows) await db.query('update bl.balance_lots set minutes_left = minutes_left + $2 where id = $1', [d.lot_id, d.minutes]);
  return rows.reduce((s, d) => s + d.minutes, 0);
}

/** Чеки зачёта по списаниям платежа игры: один на каждый платёж-источник партий. */
export async function issueBalanceReceipts(db, deps, { paymentId, now }) {
  const { rows } = await db.query(
    `select l.payment_id as source_id, sum(d.minutes)::int as minutes, sum(d.value_kopecks)::bigint as value
       from bl.balance_debits d join bl.balance_lots l on l.id = d.lot_id
      where d.payment_id = $1 and d.restored_at is null
      group by l.payment_id order by l.payment_id`,
    [paymentId],
  );
  if (rows.length === 0) return [];
  const { rows: pr } = await db.query(
    'select p.*, r.number as resource_number from bl.payments p left join bl.resources r on r.id = p.resource_id where p.id = $1',
    [paymentId],
  );
  const game = pr[0];
  const settings = await loadPaymentSettings(db, game.club_id);
  const out = [];
  for (const r of rows) {
    const value = Number(r.value);
    if (value <= 0) continue;
    const source = (await db.query('select * from bl.payments where id = $1', [r.source_id])).rows[0];
    const items = receiptItems({ resourceNumber: game.resource_number, minutes: r.minutes, amountKopecks: value, vatCode: settings.vat_code });
    out.push(await queueSettlementReceipt(db, deps, { source, forPaymentId: paymentId, items, amountKopecks: value, now }));
  }
  return out;
}

/**
 * Отозвать партию минут (возврат пакета, decisions №118): только целиком и пока из неё ничего
 * не списано (package_used), один раз (already_refunded). Минуты обнуляются, журнал
 * manual.package_refund с причиной, тревога владельцу. Деньги здесь не возвращаются.
 * @returns {Promise<{ lot: object, payment: object }>}
 */
export async function revokeLot(db, deps, { lotId, reason, staffId, now }) {
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (!why) throw new MoneyError('reason_required');
  const { rows } = await db.query('select * from bl.balance_lots where id = $1 for update', [lotId]);
  const lot = rows[0];
  if (!lot) throw new MoneyError('not_found', 'lot');
  if (lot.revoked_at) throw new MoneyError('already_refunded');
  const used = await db.query('select 1 from bl.balance_debits where lot_id = $1 and restored_at is null limit 1', [lotId]);
  if (used.rowCount > 0 || lot.minutes_left !== lot.minutes_total) throw new MoneyError('package_used');
  await db.query('update bl.balance_lots set minutes_left = 0, revoked_at = $2, revoked_by = $3 where id = $1', [lotId, now, staffId]);
  const payment = (await db.query('select * from bl.payments where id = $1', [lot.payment_id])).rows[0];
  const data = { lot_id: lotId, payment_id: lot.payment_id, package_id: lot.package_id, minutes: lot.minutes_total, amount_kopecks: Number(lot.price_kopecks), user_id: lot.user_id };
  await deps.audit.appendAudit(db, { action: 'manual.package_refund', objectType: 'payment', objectId: lot.payment_id, reason: why, data, actorType: 'user', actorId: staffId });
  // Инвариант 8 (Д3): владелец сразу видит, что, кому, на сколько, кто и почему — как у отмены брони.
  await deps.alarms.raise(db, lot.club_id, {
    type: 'manual_action',
    level: 'critical',
    manual: true,
    data: { action: 'manual.package_refund', ...data, reason: why, staff_id: staffId ?? null },
    text: await packageRefundText(db, lot, { staffId, reason: why }),
  });
  return { lot: { ...lot, minutes_left: 0, revoked_at: now }, payment };
}

const ROLE_TITLE = { owner: 'владелец', manager: 'управляющий', reception: 'администратор' };

/** «Возврат пакета «10 часов» гостю +7999***0002 на 3 000 ₽ — Анна: причина» (телефон — маской). */
export async function packageRefundText(db, lot, { staffId, reason }) {
  const title = (await db.query('select title from bl.tariff_packages where id = $1', [lot.package_id])).rows[0]?.title ?? 'пакет';
  const masked = (await db.query('select phone_masked from bl.user_brief($1)', [lot.user_id])).rows[0]?.phone_masked ?? 'без телефона';
  let who = 'сотрудник';
  if (staffId) {
    const { rows } = await db.query(
      `select u.name, m.role from bl.club_members m join bl.users u on u.id = m.user_id
        where m.club_id = $1 and m.user_id = $2 order by m.active desc limit 1`,
      [lot.club_id, staffId],
    );
    who = rows[0]?.name?.trim() || ROLE_TITLE[rows[0]?.role] || who;
  }
  return `Возврат пакета «${title}» гостю ${masked} на ${formatMoney(Number(lot.price_kopecks))} — ${who}: ${reason}`;
}
