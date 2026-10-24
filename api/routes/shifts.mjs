// Смены клуба (контракт M2 §4, backend-kkt; decisions №81, №83).
//   POST /api/clubs/{club}/shifts          — ресепшн и выше: {float_kopecks} — открыть смену с разменом (вторая — 409 shift_open)
//   GET  /api/clubs/{club}/shifts/current  — ресепшн и выше: {shift} — открытая смена или null; закрытие вслепую (№94):
//                                            ожидаемые наличные (expected_cash_kopecks, cash_sales_kopecks) — только
//                                            управляющему и владельцу
//   GET  /api/clubs/{club}/shifts          — управляющий и выше: ?from&to&staff&status&cursor&limit (M5.2 №176; before —
//                                            прежнее имя cursor) → {items, next_cursor}, у смены revenue_total_kopecks и state
//                                            (open | closed | discrepancy)
//   GET  /api/clubs/{club}/shifts/export.csv — управляющий и выше: те же фильтры, CSV (№172), журнал owner.export
//   GET  /api/shifts/{id}                  — ресепшн и выше: смена
//   POST /api/shifts/{id}/close            — ресепшн и выше: {actual_cash_kopecks, comment?} → смена с ожидаемыми
//                                            наличными и расхождением; уже закрыта — 409 shift_closed
// Расхождение ≠ 0 — тревога владельцу сразу; отчёт смены уходит владельцу после закрытия (outbox shift.closed).

import { ROLES } from '../router.mjs';
import { HttpError } from '../../server/http/errors.mjs';
import { kick } from '../../server/kkt/index.mjs';
import { closeShift, currentShiftFor, getShift, listShifts, openShift } from '../../server/shifts/service.mjs';
import { loadClub } from '../../server/dashboard/store.mjs';
import { dayBounds, daysBetween, isDay } from '../../server/dashboard/time.mjs';
import { rub, ruDateTime, toCsv } from '../../server/dashboard/csv.mjs';
import { isUuid } from '../../server/lib/store.mjs';
import { maskPhones } from '../../server/notify/index.mjs';

const SHIFT_STATES = ['open', 'closed', 'discrepancy'];
const STATE_LABELS = { open: 'идёт', closed: 'закрыта', discrepancy: 'с расхождением' };

/**
 * Фильтры списка смен (№176): from/to — рабочие сутки клуба (по открытию смены), staff — сотрудник
 * (открыл или закрыл), status — open | closed | discrepancy, cursor (или before) — номер смены, limit.
 */
async function shiftFilters(ctx, req, { limit } = {}) {
  const q = req.query;
  const cursor = q.cursor ?? q.before;
  const before = cursor === undefined ? null : Number(cursor);
  if (before !== null && !(Number.isInteger(before) && before > 0)) throw new HttpError(400, 'bad_request', { detail: 'cursor' });
  if (q.staff !== undefined && !isUuid(q.staff)) throw new HttpError(400, 'bad_request', { detail: 'staff' });
  if (q.status !== undefined && !SHIFT_STATES.includes(q.status)) throw new HttpError(400, 'bad_request', { detail: 'status' });
  let from = null;
  let to = null;
  if (q.from !== undefined || q.to !== undefined) {
    const club = await loadClub(ctx.db, ctx.club);
    const a = q.from ?? q.to;
    const b = q.to ?? q.from;
    if (!isDay(a) || !isDay(b) || a > b || daysBetween(a, b) > 366) throw new HttpError(400, 'bad_request', { detail: 'period' });
    from = dayBounds(a, club.timezone, club.day_start_local).from;
    to = dayBounds(b, club.timezone, club.day_start_local).to;
  }
  return { limit: limit ?? q.limit, before, from, to, staff: q.staff ?? null, status: q.status ?? null, fromDay: q.from ?? null, toDay: q.to ?? null };
}

function shiftsCsv(items, tz) {
  const at = (v) => {
    const t = ruDateTime(v, tz);
    return v ? `${t.date} ${t.time}` : '';
  };
  return toCsv(
    ['Смена', 'Открыта', 'Открыл', 'Закрыта', 'Закрыл', 'Статус', 'Размен, ₽', 'Выручка, ₽', 'Ожидалось наличных, ₽', 'Факт, ₽', 'Расхождение, ₽', 'Комментарий'],
    items.map((s) => [s.number, at(s.opened_at), s.opened_by_name ?? '', at(s.closed_at), s.closed_by_name ?? '', STATE_LABELS[s.state], rub(s.float_kopecks), rub(s.revenue_total_kopecks), rub(s.expected_cash_kopecks), rub(s.actual_cash_kopecks), rub(s.discrepancy_kopecks), s.close_comment ? maskPhones(s.close_comment) : '']),
  );
}

async function shiftInClub(db, req) {
  const { rowCount } = await db.query('select 1 from bl.shifts where id = $1', [req.params.id]);
  return rowCount > 0;
}

function deps(ctx) {
  return { audit: ctx.audit, alarms: ctx.alarms, outbox: ctx.outbox, sse: ctx.sse, log: ctx.log, kick };
}

export const routes = [
  {
    method: 'POST',
    path: '/api/clubs/{club}/shifts',
    auth: 'staff',
    roles: [...ROLES.RECEPTION_UP],
    handler: async (ctx, req) => ({
      status: 201,
      json: await openShift(ctx.db, deps(ctx), { clubId: ctx.club, userId: req.user.id, floatKopecks: req.body?.float_kopecks, now: ctx.clock.now() }),
    }),
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/shifts/current',
    auth: 'staff',
    roles: [...ROLES.RECEPTION_UP],
    handler: async (ctx) => ({ json: { shift: await currentShiftFor(ctx.db, { clubId: ctx.club, roles: ctx.roles, now: ctx.clock.now() }) } }),
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/shifts',
    auth: 'staff',
    roles: [...ROLES.MANAGER_UP],
    handler: async (ctx, req) => ({ json: await listShifts(ctx.db, { clubId: ctx.club, now: ctx.clock.now(), ...(await shiftFilters(ctx, req)) }) }),
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/shifts/export.csv',
    auth: 'staff',
    roles: [...ROLES.MANAGER_UP],
    handler: async (ctx, req) => {
      const f = await shiftFilters(ctx, req, { limit: 500 });
      const club = await loadClub(ctx.db, ctx.club);
      const items = [];
      let before = null;
      // Все смены периода страницами по 500 (до 20 000).
      for (let i = 0; i < 40; i += 1) {
        const page = await listShifts(ctx.db, { clubId: ctx.club, now: ctx.clock.now(), ...f, before });
        items.push(...page.items);
        if (!page.next_cursor) break;
        before = page.next_cursor;
      }
      const out = shiftsCsv(items, club.timezone);
      await ctx.audit.appendAudit(ctx.db, {
        action: 'owner.export',
        objectType: 'club',
        objectId: ctx.club,
        data: { source: 'shifts', table: 'shifts', from: f.fromDay, to: f.toDay, rows: items.length },
      });
      return {
        status: 200,
        headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="shifts-${f.fromDay ?? 'all'}-${f.toDay ?? 'all'}.csv"` },
        body: out,
      };
    },
  },
  {
    method: 'GET',
    path: '/api/shifts/{id}',
    auth: 'staff',
    roles: [...ROLES.RECEPTION_UP],
    findClub: shiftInClub,
    handler: async (ctx, req) => {
      const s = await getShift(ctx.db, req.params.id);
      if (!s) throw new HttpError(404, 'not_found');
      return { json: s };
    },
  },
  {
    method: 'POST',
    path: '/api/shifts/{id}/close',
    auth: 'staff',
    roles: [...ROLES.RECEPTION_UP],
    findClub: shiftInClub,
    handler: async (ctx, req) => ({
      json: await closeShift(ctx.db, deps(ctx), {
        shiftId: req.params.id,
        userId: req.user.id,
        actualCashKopecks: req.body?.actual_cash_kopecks,
        comment: req.body?.comment ?? null,
        now: ctx.clock.now(),
      }),
    }),
  },
];
