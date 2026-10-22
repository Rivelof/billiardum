// Отчёт смены (контракт M2 §4, PRODUCT §4.2, backend-kkt).
//   GET /api/shifts/{id}/report?online=0 — владелец, управляющий: выручка столов и бара по способам оплаты,
//       часы игры, загрузка, ручные действия, сервисный свет по сотрудникам и столам, касса и сверка
//       (чеки ККТ против продаж, онлайн против ЮKassa; online=0 — без запросов к ЮKassa).
// Открытая смена — отчёт «на сейчас» (period.live = true).

import { ROLES } from '../router.mjs';
import { HttpError } from '../../server/http/errors.mjs';
import { reportsMoneyConfig } from '../../server/kkt/index.mjs';
import { loadMoneyConfig } from '../../server/payments/config.mjs';
import { buildShiftReport } from '../../server/reports/shift-report.mjs';

async function shiftInClub(db, req) {
  const { rowCount } = await db.query('select 1 from bl.shifts where id = $1', [req.params.id]);
  return rowCount > 0;
}

function moneyConfigOf(ctx) {
  if (ctx.money?.config) return ctx.money.config;
  const fromModule = reportsMoneyConfig();
  if (fromModule) return fromModule;
  try {
    return loadMoneyConfig(process.env, ctx.config ?? {});
  } catch {
    return null;
  }
}

export const routes = [
  {
    method: 'GET',
    path: '/api/shifts/{id}/report',
    auth: 'staff',
    roles: [...ROLES.MANAGER_UP],
    findClub: shiftInClub,
    handler: async (ctx, req) => {
      const online = req.query.online !== '0';
      const report = await buildShiftReport(ctx.db, { shiftId: req.params.id, now: ctx.clock.now(), online, moneyConfig: moneyConfigOf(ctx), fetch: ctx.kkt?.fetch });
      if (!report) throw new HttpError(404, 'not_found');
      return { json: report };
    },
  },
];
