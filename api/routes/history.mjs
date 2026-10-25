// Истории программы клуба (M5.2 §7, решения №173–175) — управляющий и владелец (экспорт — тоже:
// это рабочие ведомости). «Все мои клубы» — как у дашборда.
//   GET /api/clubs/{club|all}/history/{orders|audits|writeoffs|arrivals}?from&to&q&status&sort&cursor&limit
//       → { period, items, next_cursor, totals }
//   GET /api/clubs/{club|all}/history/{kind}/export.csv?from&to&q&status&sort — журнал owner.export
// status: у заказов — new|preparing|ready|served|canceled, у списаний — источник pos|program|audit.
// sort: поле или -поле (по умолчанию -created_at). Ведомость ревизии (№174) — GET /api/clubs/{club}/stock/sheet.

import { ROLES } from '../router.mjs';
import { clubScope } from '../../server/dashboard/scope.mjs';
import { historyCsv } from '../../server/history/export.mjs';
import { clubToday, history, historyAll, parseHistoryQuery } from '../../server/history/service.mjs';
import { stockSheet } from '../../server/history/sheet.mjs';

const ROLES_VIEW = ['owner', 'manager'];
const RATE = { max: 120, windowMs: 60_000 };

function listHandler(all) {
  return async (ctx, req) => {
    const s = await clubScope(ctx, req, { all, roles: ROLES_VIEW });
    const p = parseHistoryQuery(req.params.kind, req.query, { today: clubToday(s.clubs[0], ctx.clock.now()) });
    return { json: await history(ctx.db, { clubs: s.clubs, enter: s.enter, p, all: s.all }) };
  };
}

function exportHandler(all) {
  return async (ctx, req) => {
    // Экспорт — не управляющему сети (M5.5 №192).
    const s = await clubScope(ctx, req, { all, roles: ROLES_VIEW, allowNetwork: false });
    const p = parseHistoryQuery(req.params.kind, { ...req.query, cursor: undefined, limit: undefined }, { today: clubToday(s.clubs[0], ctx.clock.now()) });
    const page = await historyAll(ctx.db, { clubs: s.clubs, enter: s.enter, p, all: s.all });
    const out = historyCsv(p.kind, page, { clubs: s.clubs, all: s.all, from: p.from, to: p.to });
    for (const c of s.clubs) {
      await s.enter(c);
      await ctx.audit.appendAudit(ctx.db, {
        action: 'owner.export',
        objectType: 'club',
        objectId: c.id,
        data: { source: 'history', table: p.kind, from: p.from, to: p.to, rows: out.rows, all: s.all },
      });
    }
    return { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${out.filename}"` }, body: out.body };
  };
}

export const routes = [
  { method: 'GET', path: '/api/clubs/{club}/history/{kind}', auth: 'staff', roles: [...ROLES.MANAGER_UP], rateLimit: RATE, handler: listHandler(false) },
  { method: 'GET', path: '/api/clubs/all/history/{kind}', auth: 'guest', rateLimit: RATE, handler: listHandler(true) },
  { method: 'GET', path: '/api/clubs/{club}/history/{kind}/export.csv', auth: 'staff', roles: [...ROLES.MANAGER_UP], networkManager: false, rateLimit: RATE, handler: exportHandler(false) },
  { method: 'GET', path: '/api/clubs/all/history/{kind}/export.csv', auth: 'guest', rateLimit: RATE, handler: exportHandler(true) },
  {
    method: 'GET',
    path: '/api/clubs/{club}/stock/sheet',
    auth: 'staff',
    roles: [...ROLES.MANAGER_UP],
    handler: async (ctx, req) => ({ json: await stockSheet(ctx.db, { clubId: ctx.club, blind: req.query.blind === '1', now: ctx.clock.now() }) }),
  },
];
