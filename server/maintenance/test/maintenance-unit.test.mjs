// Обслуживание столов (M5.6 №198): пороги, момент начала счётчика, план подсчёта часов.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countPlan, DEFAULT_THRESHOLDS, eventMoment, thresholdsOf } from '../service.mjs';
import { dayBounds, zonedTime } from '../../dashboard/time.mjs';

const club = { timezone: 'Asia/Yekaterinburg', day_start_local: '06:00' };
const L = (day, hhmm) => zonedTime(day, hhmm, club.timezone);

describe('пороги', () => {
  it('по умолчанию сукно 1 500 ч, шары 3 000 ч, резина 5 000 ч; неверное — по умолчанию; null — без порога', () => {
    assert.deepEqual(thresholdsOf({}), { cloth: 1500, balls: 3000, cushions: 5000, leveling: null, other: null });
    assert.deepEqual(thresholdsOf({ maintenance_thresholds: { cloth: 1200, balls: null, cushions: 'x', leveling: 0, other: 10 } }), {
      cloth: 1200,
      balls: null,
      cushions: DEFAULT_THRESHOLDS.cushions,
      leveling: null,
      other: 10,
    });
  });
});

describe('момент начала счётчика', () => {
  it('отмечено в свои сутки — с момента отметки; задним числом — с начала следующих суток', () => {
    const at = L('2026-10-20', '15:00');
    assert.equal(eventMoment({ day: '2026-10-20', created_at: at }, club), at.getTime());
    // Ночью 02:00 21-го — ещё сутки 20-го.
    const night = L('2026-10-21', '02:00');
    assert.equal(eventMoment({ day: '2026-10-20', created_at: night }, club), night.getTime());
    assert.equal(eventMoment({ day: '2026-10-18', created_at: at }, club), dayBounds('2026-10-19', club.timezone).from.getTime());
  });

  it('план: агрегаты закрытых суток, сессии — сутки отметки, недосчитанные и текущие', () => {
    const now = L('2026-10-24', '12:00');
    const stored = new Set(['2026-10-20', '2026-10-21', '2026-10-23']);
    const t0 = L('2026-10-20', '15:00').getTime();
    const p = countPlan(club, t0, { stored, now, firstDay: '2026-10-01' });
    assert.equal(p.statsFrom, '2026-10-21');
    assert.deepEqual(p.intervals, [
      { lo: t0, hi: dayBounds('2026-10-20', club.timezone).to.getTime() },
      { lo: dayBounds('2026-10-22', club.timezone).from.getTime(), hi: dayBounds('2026-10-22', club.timezone).to.getTime() },
      { lo: dayBounds('2026-10-24', club.timezone).from.getTime(), hi: now.getTime() },
    ]);
    // Без событий — с первых суток клуба; соседние недосчитанные сутки склеиваются.
    const q = countPlan(club, null, { stored: new Set(), now, firstDay: '2026-10-23' });
    assert.equal(q.statsFrom, '2026-10-23');
    assert.deepEqual(q.intervals, [{ lo: dayBounds('2026-10-23', club.timezone).from.getTime(), hi: now.getTime() }]);
  });
});
