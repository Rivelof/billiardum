// «Статус зала» сейчас (GET …/dashboard/now, контракт §3 «Зал» и §4): поверх зала модуля light —
// по типам столов «занято X/Y, бронь, сервис», текущая загрузка и средняя за текущие сутки, кто в
// смене и с какого времени, схема зала без данных гостей.

import { currentShift } from '../shifts/api.mjs';
import { computeDay, TYPES } from './day.mjs';
import { workingDayOf } from './time.mjs';

const BUSY = new Set(['active', 'ending', 'grace']);
const r1 = (x) => Math.round(x * 10) / 10;

/** Состояние стола для дашборда: busy | reserved | service | free | offline | fault. */
export function bucketOf(status) {
  if (BUSY.has(status)) return 'busy';
  if (status === 'reserved' || status === 'pending') return 'reserved';
  if (status === 'service') return 'service';
  if (status === 'offline') return 'offline';
  if (status === 'fault') return 'fault';
  return 'free';
}

async function hallOf(ctx, db, club) {
  const service = ctx.modules?.light?.light?.()?.service;
  if (typeof service?.hall === 'function') return service.hall(db, { clubId: club.id, userId: ctx.user.id });
  const { rows } = await db.query('select id, number, type, title, plan_x, plan_y, plan_rotation from bl.resources where club_id = $1 and active order by bl.resource_family(type) desc, number', [club.id]);
  return rows.map((r) => ({ resource: r, status: 'unknown', busy_until: null, until: null }));
}

function emptyType(type) {
  return { type, total: 0, busy: 0, reserved: 0, service: 0, free: 0, offline: 0, fault: 0 };
}

/** Статус зала одного клуба (контекст клуба уже выставлен). */
export async function clubNow(ctx, db, club, now) {
  const hall = await hallOf(ctx, db, club);
  const types = new Map();
  const total = emptyType(null);
  const tables = [];
  for (const h of hall) {
    const b = bucketOf(h.status);
    const t = types.get(h.resource.type) ?? emptyType(h.resource.type);
    t.total += 1;
    t[b] = (t[b] ?? 0) + 1;
    total.total += 1;
    total[b] = (total[b] ?? 0) + 1;
    types.set(h.resource.type, t);
    tables.push({
      resource_id: h.resource.id,
      number: h.resource.number,
      title: h.resource.title,
      type: h.resource.type,
      plan_x: h.resource.plan_x ?? null,
      plan_y: h.resource.plan_y ?? null,
      plan_rotation: h.resource.plan_rotation ?? null,
      status: b,
      busy_until: h.busy_until ?? null,
      until: h.until ?? null,
    });
  }
  const today = workingDayOf(now, club.timezone, club.day_start_local);
  const { daily } = await computeDay(db, { club, day: today, now });
  const shift = await currentShift(db, club.id);
  const byType = TYPES.filter((t) => types.has(t)).map((t) => {
    const x = types.get(t);
    let play = 0;
    let cap = 0;
    for (const r of Object.values(daily.resources)) {
      if (r.type !== t) continue;
      play += r.play_minutes;
      cap += r.capacity_minutes;
    }
    return { ...x, utilization_now_pct: x.total ? r1((x.busy / x.total) * 100) : null, utilization_day_pct: cap ? r1((play / cap) * 100) : null };
  });
  return {
    club_id: club.id,
    day: today,
    totals: {
      ...total,
      type: undefined,
      utilization_now_pct: total.total ? r1((total.busy / total.total) * 100) : null,
      utilization_day_pct: daily.totals.capacity_minutes ? r1((daily.totals.play_minutes / daily.totals.capacity_minutes) * 100) : null,
    },
    by_type: byType,
    revenue_today: { total_kopecks: daily.revenue.total_kopecks, net_kopecks: daily.revenue.net_kopecks, by_method: daily.revenue.by_method },
    games_today: daily.games.total,
    shift: shift ? { shift_id: shift.id, number: shift.number, opened_at: shift.opened_at, opened_by_name: shift.opened_by_name } : null,
    tables,
  };
}
