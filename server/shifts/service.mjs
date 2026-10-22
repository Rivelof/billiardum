// Смены клуба (decisions №81, №83; контракт M2 §1.6, §1.8).
//
// * Открыть: размен (наличные в кассе на начало). Одна открытая смена на клуб — иначе 409 shift_open.
// * Закрыть: только с фактом наличных. Ожидаемо = размен + наличные платежи клуба за время смены
//   (касса M2 и заявки стола M1, bl.payments method = cash) − наличные возвраты (bl.refunds по
//   наличным платежам). Расхождение = факт − ожидаемо; ≠ 0 — тревога владельцу сразу (critical).
// * Смена ККТ: при открытии и закрытии — задание мосту (open_shift, close_shift), если у клуба есть мост.
// * После закрытия — событие outbox shift.closed: отчёт смены уходит владельцу (server/reports/).
//
// Интервал смены — [opened_at, closed_at]; следующая смена открывается не раньше closed_at + 1 мс,
// поэтому платёж не попадёт в две смены.

import { formatMoney } from '@billiardum/shared/format';
import { afterCommit } from '../lib/store.mjs';
import { HttpError } from '../http/errors.mjs';
import { ensureOp } from '../kkt/queue.mjs';
import { serviceLight } from '../reports/queries.mjs';
import { currentShift } from './api.mjs';

export const MAX_FLOAT = 100_000_000;
export const MAX_CASH = 1_000_000_000;
export const DEFAULT_SERVICE_LIGHT_ALARM_MINUTES = 60;

const iso = (d) => (d ? new Date(d).toISOString() : null);

export function shiftView(s) {
  const closed = Boolean(s.closed_at);
  return {
    id: s.id,
    club_id: s.club_id,
    number: s.number,
    status: closed ? 'closed' : 'open',
    opened_at: iso(s.opened_at),
    opened_by: s.opened_by,
    opened_by_name: s.opened_by_name ?? null,
    float_kopecks: Number(s.float_kopecks),
    closed_at: iso(s.closed_at),
    closed_by: s.closed_by ?? null,
    closed_by_name: s.closed_by_name ?? null,
    cash_sales_kopecks: s.cash_sales_kopecks === null || s.cash_sales_kopecks === undefined ? null : Number(s.cash_sales_kopecks),
    cash_refunds_kopecks: s.cash_refunds_kopecks === null || s.cash_refunds_kopecks === undefined ? null : Number(s.cash_refunds_kopecks),
    expected_cash_kopecks: s.expected_cash_kopecks === null || s.expected_cash_kopecks === undefined ? null : Number(s.expected_cash_kopecks),
    actual_cash_kopecks: s.actual_cash_kopecks === null || s.actual_cash_kopecks === undefined ? null : Number(s.actual_cash_kopecks),
    discrepancy_kopecks: s.discrepancy_kopecks === null || s.discrepancy_kopecks === undefined ? null : Number(s.discrepancy_kopecks),
    close_comment: s.close_comment ?? null,
    report_sent_at: iso(s.report_sent_at),
  };
}

async function clubSettings(db, clubId) {
  const { rows } = await db.query('select settings, timezone from bl.clubs where id = $1', [clubId]);
  return { settings: rows[0]?.settings ?? {}, timezone: rows[0]?.timezone ?? 'Europe/Moscow' };
}

async function userName(db, userId) {
  const { rows } = await db.query('select name from bl.users where id = $1', [userId]);
  return rows[0]?.name ?? null;
}

async function hasBridge(db, clubId) {
  const { rows } = await db.query('select 1 from bl.kkt_bridges where club_id = $1 and revoked_at is null limit 1', [clubId]);
  return rows.length > 0;
}

/** Наличные за интервал: платежи и возвраты по наличным платежам. */
export async function cashTotals(db, { clubId, from, to }) {
  const sales = await db.query(
    `select coalesce(sum(amount_kopecks), 0)::bigint as total, count(*)::int as n
       from bl.payments
      where club_id = $1 and method = 'cash' and status = 'succeeded' and confirmed_at >= $2 and confirmed_at <= $3`,
    [clubId, from, to],
  );
  const refunds = await db.query(
    `select coalesce(sum(f.amount_kopecks), 0)::bigint as total, count(*)::int as n
       from bl.refunds f join bl.payments p on p.id = f.payment_id
      where f.club_id = $1 and p.method = 'cash' and f.status in ('manual', 'succeeded') and f.created_at >= $2 and f.created_at <= $3`,
    [clubId, from, to],
  );
  return {
    salesKopecks: Number(sales.rows[0].total),
    salesCount: sales.rows[0].n,
    refundsKopecks: Number(refunds.rows[0].total),
    refundsCount: refunds.rows[0].n,
  };
}

async function loadShift(db, id, { forUpdate = false } = {}) {
  const { rows } = await db.query(
    `select s.*, (select u.name from bl.users u where u.id = s.opened_by) as opened_by_name,
            (select u.name from bl.users u where u.id = s.closed_by) as closed_by_name
       from bl.shifts s where s.id = $1 ${forUpdate ? 'for update of s' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

export async function getShift(db, id) {
  const s = await loadShift(db, id);
  return s ? shiftView(s) : null;
}

export async function listShifts(db, { clubId, limit = 30, before = null }) {
  const lim = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const { rows } = await db.query(
    `select s.*, (select u.name from bl.users u where u.id = s.opened_by) as opened_by_name,
            (select u.name from bl.users u where u.id = s.closed_by) as closed_by_name
       from bl.shifts s
      where s.club_id = $1 and ($2::integer is null or s.number < $2)
      order by s.number desc limit $3`,
    [clubId, before, lim],
  );
  return { items: rows.map(shiftView), next_cursor: rows.length === lim ? rows[rows.length - 1].number : null };
}

function publishShift(db, deps, clubId, data) {
  return afterCommit(db, () => {
    try {
      deps.sse?.publish(`club:${clubId}`, 'shift', data);
    } catch (err) {
      deps.log?.warn?.('sse_publish_failed', { error: err.message });
    }
    deps.kick?.(clubId);
  });
}

/**
 * Открыть смену. → shiftView
 * @param {{ clubId: string, userId: string, floatKopecks: number, now: Date }} args
 */
export async function openShift(db, deps, { clubId, userId, floatKopecks, now }) {
  if (!Number.isSafeInteger(floatKopecks) || floatKopecks < 0 || floatKopecks > MAX_FLOAT) throw new HttpError(400, 'bad_request', { detail: 'float_kopecks' });
  if (await currentShift(db, clubId)) throw new HttpError(409, 'shift_open');
  const { rows: last } = await db.query('select max(number) as number, max(closed_at) as closed_at from bl.shifts where club_id = $1', [clubId]);
  const prevClosed = last[0].closed_at ? new Date(last[0].closed_at).getTime() : 0;
  const openedAt = new Date(Math.max(now.getTime(), prevClosed + 1));
  const number = Number(last[0].number ?? 0) + 1;
  let row;
  try {
    await db.query('savepoint shift_open');
    const ins = await db.query(
      `insert into bl.shifts (club_id, number, opened_by, opened_at, float_kopecks, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $6) returning *`,
      [clubId, number, userId, openedAt, floatKopecks, now],
    );
    await db.query('release savepoint shift_open');
    row = ins.rows[0];
  } catch (err) {
    if (err.code === '23505') {
      await db.query('rollback to savepoint shift_open');
      throw new HttpError(409, 'shift_open');
    }
    throw err;
  }
  const name = await userName(db, userId);
  await deps.audit.appendAudit(db, {
    action: 'shift.open',
    objectType: 'shift',
    objectId: row.id,
    actorType: 'user',
    actorId: userId,
    data: { shift_id: row.id, number, float_kopecks: floatKopecks },
  });
  const { settings } = await clubSettings(db, clubId);
  if (settings.kkt_shift_sync !== false && (await hasBridge(db, clubId))) {
    await ensureOp(db, { clubId, kind: 'open_shift', shiftId: row.id, operatorName: name, now });
  }
  await publishShift(db, deps, clubId, { id: row.id, number, status: 'open' });
  deps.log?.info?.('shift_opened', { shift_id: row.id, club_id: clubId, number, float_kopecks: floatKopecks });
  return shiftView({ ...row, opened_by_name: name });
}

/**
 * Закрыть смену с фактом наличных. → shiftView (с ожидаемыми наличными и расхождением)
 * @param {{ shiftId: string, userId: string, actualCashKopecks: number, comment?: string|null, now: Date }} args
 */
export async function closeShift(db, deps, { shiftId, userId, actualCashKopecks, comment = null, now }) {
  const s = await loadShift(db, shiftId, { forUpdate: true });
  if (!s) throw new HttpError(404, 'not_found');
  if (s.closed_at) throw new HttpError(409, 'shift_closed');
  // Закрыть смену без факта наличных нельзя (№81).
  if (!Number.isSafeInteger(actualCashKopecks) || actualCashKopecks < 0 || actualCashKopecks > MAX_CASH) {
    throw new HttpError(400, 'bad_request', { detail: 'actual_cash_kopecks' });
  }
  let note = null;
  if (comment !== null && comment !== undefined) {
    if (typeof comment !== 'string' || comment.length > 500) throw new HttpError(400, 'bad_request', { detail: 'comment' });
    note = comment.trim() || null;
  }
  const clubId = s.club_id;
  const closedAt = new Date(Math.max(now.getTime(), new Date(s.opened_at).getTime()));
  const cash = await cashTotals(db, { clubId, from: s.opened_at, to: closedAt });
  const expected = Number(s.float_kopecks) + cash.salesKopecks - cash.refundsKopecks;
  const discrepancy = actualCashKopecks - expected;
  const { rows } = await db.query(
    `update bl.shifts
        set closed_by = $2, closed_at = $3, cash_sales_kopecks = $4, cash_refunds_kopecks = $5, expected_cash_kopecks = $6,
            actual_cash_kopecks = $7, discrepancy_kopecks = $8, close_comment = $9, updated_at = $10
      where id = $1 returning *`,
    [s.id, userId, closedAt, cash.salesKopecks, cash.refundsKopecks, expected, actualCashKopecks, discrepancy, note, now],
  );
  const row = rows[0];
  const name = await userName(db, userId);
  await deps.audit.appendAudit(db, {
    action: 'shift.close',
    objectType: 'shift',
    objectId: s.id,
    reason: note,
    actorType: 'user',
    actorId: userId,
    data: {
      shift_id: s.id,
      number: s.number,
      float_kopecks: Number(s.float_kopecks),
      cash_sales_kopecks: cash.salesKopecks,
      cash_refunds_kopecks: cash.refundsKopecks,
      expected_cash_kopecks: expected,
      actual_cash_kopecks: actualCashKopecks,
      discrepancy_kopecks: discrepancy,
    },
  });

  // Расхождение кассы — критично, сразу (PRODUCT §8).
  if (discrepancy !== 0) {
    const sign = discrepancy < 0 ? 'недостача' : 'излишек';
    await deps.alarms.raise(db, clubId, {
      type: 'cash_discrepancy',
      level: 'critical',
      manual: true,
      data: { shift_id: s.id, number: s.number, discrepancy_kopecks: discrepancy, expected_cash_kopecks: expected, actual_cash_kopecks: actualCashKopecks },
      text: `Смена №${s.number}: расхождение кассы ${formatMoney(discrepancy)} (${sign}). Ожидалось ${formatMoney(expected)}, в кассе ${formatMoney(actualCashKopecks)}`,
    });
  }

  // Минуты сервисного света за смену выше порога клуба — тревога (№71).
  const { settings } = await clubSettings(db, clubId);
  const limit = Number.isInteger(settings.service_light_alarm_minutes) ? settings.service_light_alarm_minutes : DEFAULT_SERVICE_LIGHT_ALARM_MINUTES;
  const light = await serviceLight(db, { clubId, from: s.opened_at, to: closedAt });
  if (limit > 0 && light.totalMinutes > limit) {
    await deps.alarms.raise(db, clubId, {
      type: 'service_light_threshold',
      level: 'important',
      data: { shift_id: s.id, minutes: light.totalMinutes, threshold_minutes: limit },
      text: `Смена №${s.number}: сервисный свет ${light.totalMinutes} мин — больше порога ${limit} мин`,
    });
  }

  if (settings.kkt_shift_sync !== false && (await hasBridge(db, clubId))) {
    await ensureOp(db, { clubId, kind: 'close_shift', shiftId: s.id, operatorName: name, now });
  }
  await deps.outbox.enqueue(db, 'shift.closed', { shift_id: s.id, club_id: clubId, number: s.number, discrepancy_kopecks: discrepancy });
  await publishShift(db, deps, clubId, { id: s.id, number: s.number, status: 'closed' });
  deps.log?.info?.('shift_closed', { shift_id: s.id, club_id: clubId, number: s.number, discrepancy_kopecks: discrepancy });
  return shiftView({ ...row, opened_by_name: s.opened_by_name, closed_by_name: name });
}
