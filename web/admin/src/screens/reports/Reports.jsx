import { Shell } from '../../components/Shell.jsx';
import { BASE } from '../../lib/env.js';
import { linkHandler } from '../../lib/router.js';
import { REPORTS, REPORT_KEYS } from '../../lib/reports.js';
import { workDate } from '../../lib/period.js';
import { HistoryScreen } from './history.jsx';
import { ShiftsScreen } from './Shifts.jsx';
import { CashbookScreen } from './Cashbook.jsx';
import { PlayersScreen } from './Players.jsx';
import { AuditSheet } from './AuditSheet.jsx';
import { Lazy } from '../../components/Lazy.jsx';
import '../../styles/dashboard.css';
import '../../styles/reports.css';

/**
 * Отчёты (M5.2, №173–179): смены, истории заказов, ревизий, списаний и приходов, касса управляющего,
 * «Кто играл за столом», ведомость ревизии. Управляющий и владелец; отдельный чанк.
 */
export function Reports({ ctx }) {
  const { club, role, user, timeZone } = ctx;
  const key = REPORT_KEYS.has(ctx.id) ? ctx.id : 'shifts';
  const today = workDate(Date.now(), timeZone);
  const base = `${BASE}c/${encodeURIComponent(club.club_id)}/reports`;
  const meta = REPORTS.find((r) => r.key === key) ?? { title: 'Ведомость ревизии' };
  const sub = { ctx, today, base, title: meta.title };
  return (
    <Shell club={club} role={role} user={user} timeZone={timeZone} active="reports" title="Отчёты">
      <div class="page dash reports">
        <nav class="rnav no-print" aria-label="Отчёты">
          {REPORTS.map((r) => (
            <a key={r.key} class="rnav__item" href={`${base}/${r.key}`} onClick={linkHandler} aria-current={r.key === key || (key === 'audit-sheet' && r.key === 'audits') ? 'page' : undefined}>
              {r.label}
            </a>
          ))}
        </nav>
        {key === 'shifts' ? <ShiftsScreen key="shifts" {...sub} /> : null}
        {['orders', 'audits', 'writeoffs', 'arrivals'].includes(key) ? <HistoryScreen key={key} kind={key} {...sub} /> : null}
        {key === 'cashbook' ? <CashbookScreen key="cashbook" {...sub} /> : null}
        {key === 'players' ? <PlayersScreen key="players" {...sub} /> : null}
        {key === 'audit-sheet' ? <AuditSheet key="sheet" {...sub} /> : null}
        {key === 'maintenance' ? (
          <Lazy
            key="maintenance"
            chunk="maintenance"
            label="Открываем обслуживание столов…"
            fallback={
              <p class="muted loading" role="status">
                Открываем обслуживание столов…
              </p>
            }
            render={(m) => <m.MaintenanceScreen {...sub} />}
          />
        ) : null}
      </div>
    </Shell>
  );
}
