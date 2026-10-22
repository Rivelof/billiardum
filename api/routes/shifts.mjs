// Смены клуба (контракт M2 §4, backend-kkt; decisions №81, №83).
//   POST /api/clubs/{club}/shifts          — ресепшн и выше: {float_kopecks} — открыть смену с разменом (вторая — 409 shift_open)
//   GET  /api/clubs/{club}/shifts/current  — ресепшн и выше: {shift} — открытая смена или null; закрытие вслепую (№94):
//                                            ожидаемые наличные (expected_cash_kopecks, cash_sales_kopecks) — только
//                                            управляющему и владельцу
//   GET  /api/clubs/{club}/shifts          — управляющий и выше: ?limit&before (номер смены) → {items, next_cursor},
//                                            у смены revenue_total_kopecks
//   GET  /api/shifts/{id}                  — ресепшн и выше: смена
//   POST /api/shifts/{id}/close            — ресепшн и выше: {actual_cash_kopecks, comment?} → смена с ожидаемыми
//                                            наличными и расхождением; уже закрыта — 409 shift_closed
// Расхождение ≠ 0 — тревога владельцу сразу; отчёт смены уходит владельцу после закрытия (outbox shift.closed).

import { ROLES } from '../router.mjs';
import { HttpError } from '../../server/http/errors.mjs';
import { kick } from '../../server/kkt/index.mjs';
import { closeShift, currentShiftFor, getShift, listShifts, openShift } from '../../server/shifts/service.mjs';

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
    handler: async (ctx, req) => {
      const before = req.query.before === undefined ? null : Number(req.query.before);
      if (before !== null && !(Number.isInteger(before) && before > 0)) throw new HttpError(400, 'bad_request', { detail: 'before' });
      return { json: await listShifts(ctx.db, { clubId: ctx.club, limit: req.query.limit, before, now: ctx.clock.now() }) };
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
