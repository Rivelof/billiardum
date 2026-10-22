// Отчёт смены (PRODUCT §4.2): выручка столов и бара по способам оплаты, часы игры, загрузка,
// ручные действия, минуты сервисного света по сотрудникам и столам (№71), касса и сверка
// (чеки ККТ против продаж, онлайн против ЮKassa). Уходит владельцу при закрытии смены
// (событие outbox shift.closed → уведомление через notify core) и отдаётся
// GET /api/shifts/{id}/report.

import { formatDate, formatMoney, formatTime, plural } from '@billiardum/shared/format';
import { sendToClubStaff } from '../notify/index.mjs';
import { shiftView } from '../shifts/service.mjs';
import { manualActions, playStats, revenueOf, serviceLight, shiftPayments, shiftRefunds } from './queries.mjs';
import { reconcileKkt, reconcileOnline } from './reconcile.mjs';

export const DEFAULT_SERVICE_LIGHT_ALARM_MINUTES = 60;

async function loadShift(db, id, { forUpdate = false } = {}) {
  const { rows } = await db.query(
    `select s.*, c.timezone, c.settings as club_settings,
            (select u.name from bl.users u where u.id = s.opened_by) as opened_by_name,
            (select u.name from bl.users u where u.id = s.closed_by) as closed_by_name
       from bl.shifts s join bl.clubs c on c.id = s.club_id
      where s.id = $1 ${forUpdate ? 'for update of s' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Собрать отчёт смены.
 * @param {import('pg').ClientBase} db транзакция в контексте клуба смены
 * @param {{ shiftId: string, now: Date, online?: boolean, moneyConfig?: object|null, fetch?: Function }} args
 *   online — сверять онлайн-оплаты с ЮKassa (запросы к API); без moneyConfig — status skipped
 */
export async function buildShiftReport(db, { shiftId, now, online = true, moneyConfig = null, fetch }) {
  const s = await loadShift(db, shiftId);
  if (!s) return null;
  const clubId = s.club_id;
  const from = new Date(s.opened_at);
  const to = s.closed_at ? new Date(s.closed_at) : now;
  const payments = await shiftPayments(db, { clubId, from, to });
  const refunds = await shiftRefunds(db, { clubId, from, to });
  const revenue = revenueOf(payments, refunds);
  const play = await playStats(db, { clubId, from, to });
  const light = await serviceLight(db, { clubId, from, to });
  const limit = Number.isInteger(s.club_settings?.service_light_alarm_minutes) ? s.club_settings.service_light_alarm_minutes : DEFAULT_SERVICE_LIGHT_ALARM_MINUTES;
  const manual = await manualActions(db, { clubId, from, to });
  const kkt = await reconcileKkt(db, { clubId, payments, refunds });
  let onlineCheck;
  if (!online) onlineCheck = { ok: null, status: 'skipped' };
  else if (!moneyConfig) onlineCheck = { ok: null, status: 'not_configured' };
  else {
    try {
      onlineCheck = await reconcileOnline(db, { clubId, payments, refunds, moneyConfig, fetch });
    } catch (err) {
      onlineCheck = { ok: false, status: 'unavailable', error: String(err.code ?? 'error').slice(0, 40) };
    }
  }
  const shift = shiftView(s);
  const cash = {
    float_kopecks: Number(s.float_kopecks),
    cash_sales_kopecks: revenue.by_method.cash,
    cash_refunds_kopecks: revenue.refunds.by_method.cash,
    expected_cash_kopecks: s.closed_at ? Number(s.expected_cash_kopecks) : Number(s.float_kopecks) + revenue.by_method.cash - revenue.refunds.by_method.cash,
    actual_cash_kopecks: shift.actual_cash_kopecks,
    discrepancy_kopecks: shift.discrepancy_kopecks,
  };
  return {
    shift: { ...shift, timezone: s.timezone },
    period: { from: from.toISOString(), to: to.toISOString(), live: !s.closed_at },
    revenue,
    play,
    service_light: {
      total_minutes: light.totalMinutes,
      count: light.count,
      threshold_minutes: limit,
      exceeded: limit > 0 && light.totalMinutes > limit,
      by_staff: light.byStaff,
      by_resource: light.byResource,
    },
    manual_actions: manual,
    cash,
    reconciliation: { kkt, online: onlineCheck },
    generated_at: now.toISOString(),
  };
}

/** Текст отчёта владельцу (без персональных данных: имена персонала не нужны). */
export function reportText(r) {
  const tz = r.shift.timezone;
  const from = new Date(r.period.from);
  const to = new Date(r.period.to);
  const v = r.revenue;
  const lines = [
    `Смена №${r.shift.number} закрыта: ${formatDate(from, tz)}, ${formatTime(from, tz)}–${formatTime(to, tz)}.`,
    `Выручка ${formatMoney(v.total_kopecks)}: столы ${formatMoney(v.tables.total_kopecks)}, бар ${formatMoney(v.bar.total_kopecks)}.`,
    `Наличные ${formatMoney(v.by_method.cash)}, терминал ${formatMoney(v.by_method.card_terminal)}, СБП ${formatMoney(v.by_method.sbp)}, карта онлайн ${formatMoney(v.by_method.card)}.`,
  ];
  if (v.refunds.total_kopecks > 0) lines.push(`Возвраты ${formatMoney(v.refunds.total_kopecks)}.`);
  lines.push(`Игра ${String(r.play.hours).replace('.', ',')} ч, загрузка ${String(r.play.utilization_percent).replace('.', ',')} %.`);
  const m = r.manual_actions.count;
  lines.push(m > 0 ? `Ручных действий: ${m}.` : 'Ручных действий нет.');
  if (r.service_light.total_minutes > 0) {
    lines.push(`Сервисный свет: ${r.service_light.total_minutes} ${plural(r.service_light.total_minutes, ['минута', 'минуты', 'минут'])}${r.service_light.exceeded ? ' — больше порога' : ''}.`);
  }
  const c = r.cash;
  if (c.discrepancy_kopecks === 0) lines.push(`Касса сошлась: ${formatMoney(c.actual_cash_kopecks)}.`);
  else if (c.discrepancy_kopecks !== null) {
    lines.push(`Касса: ожидалось ${formatMoney(c.expected_cash_kopecks)}, в кассе ${formatMoney(c.actual_cash_kopecks)}, расхождение ${formatMoney(c.discrepancy_kopecks)}.`);
  }
  const k = r.reconciliation.kkt;
  lines.push(k.ok ? 'Чеки ККТ сходятся с продажами.' : `Чеки ККТ: расхождение ${formatMoney(k.diff_kopecks)}, без чека — ${k.missing_count}.`);
  const o = r.reconciliation.online;
  if (o.status === 'checked') lines.push(o.ok ? 'Онлайн-оплаты сходятся с ЮKassa.' : `Онлайн-оплаты: расхождение с ЮKassa ${formatMoney(o.diff_kopecks ?? 0)}.`);
  else if (o.status === 'unavailable') lines.push('ЮKassa не ответила — сверка онлайн-оплат позже в программе клуба.');
  return lines.join('\n');
}

/**
 * Обработчик outbox shift.closed: снимок отчёта в смене и уведомление владельцам (один раз).
 * Сбой ЮKassa не держит отчёт: сверка онлайн помечается unavailable.
 */
export async function onShiftClosed(db, deps, payload) {
  const s = await loadShift(db, payload.shift_id, { forUpdate: true });
  if (!s || !s.closed_at || s.report_sent_at) return;
  const now = deps.clock.now();
  const report = await buildShiftReport(db, { shiftId: s.id, now, online: true, moneyConfig: deps.moneyConfig ?? null, fetch: deps.fetch });
  await db.query('update bl.shifts set report = $2, report_sent_at = $3, updated_at = $3 where id = $1', [s.id, report, now]);
  await (deps.sendToClubStaff ?? sendToClubStaff)(db, s.club_id, ['owner'], {
    kind: 'shift.report',
    level: 'info',
    text: reportText(report),
    data: { shift_id: s.id, number: s.number, url: '/club/' },
  });
  deps.log?.info?.('shift_report_sent', { shift_id: s.id, club_id: s.club_id, kkt_ok: report.reconciliation.kkt.ok, online: report.reconciliation.online.status });
}
