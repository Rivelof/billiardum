// Тариф по слотам (M5.8 №204): корт играет блоками слота, цена за слот по расписанию в местном
// времени клуба. Общий путь с почасовым тарифом: минута слота стоит price_per_slot / slot_minutes,
// граница расписания внутри слота делит слот по минутам, сумма округляется один раз (№44).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { amountForMinutes, billedMinutes, compileRules, createCalendar, pricesAround, roundAmount, unitsDenominator } from '../engine.mjs';

const COURT = { id: 'e1000000-0000-4000-8000-000000000101', type: 'padel_court' };
const YEKT = 'Asia/Yekaterinburg'; // UTC+5
const MSK = 'Europe/Moscow'; // UTC+3

function slotRule(id, days, start, end, perSlot, slot = 90, extra = {}) {
  return {
    id, resource_type: 'padel_court', resource_id: null, days, start_local: start, end_local: end,
    price_per_hour: Math.round((perSlot * 60) / slot), price_per_slot: perSlot, slot_minutes: slot,
    step_minutes: slot, min_minutes: slot, priority: 0, active: true, ...extra,
  };
}

// Как в сиде: будни 06–17 — 2 400 ₽ за 90 минут, 17–06 — 3 600 ₽; выходные — 3 900 ₽.
const COURT_RULES = [
  slotRule('p1', [1, 2, 3, 4, 5], '06:00:00', '17:00:00', 240000),
  slotRule('p2', [1, 2, 3, 4, 5], '17:00:00', '06:00:00', 360000),
  slotRule('p3', [6, 7], '06:00:00', '06:00:00', 390000),
];

const ctx = (timezone = YEKT, rows = COURT_RULES, resource = COURT) => {
  const calendar = createCalendar({ timezone });
  return { calendar, rules: compileRules(rows, resource, calendar) };
};
// 26 октября 2026 — понедельник.
const at = (local, tz = YEKT) => new Date(`${local}${tz === YEKT ? '+05:00' : '+03:00'}`).getTime();

describe('правило слота', () => {
  it('минимум и шаг — слот; цена — за слот, справочная цена часа отдельно', () => {
    const { rules } = ctx();
    const p1 = rules.find((r) => r.id === 'p1');
    assert.deepEqual([p1.step, p1.min, p1.unit, p1.slot, p1.price, p1.hourly], [90, 90, 90, 90, 240000, 160000]);
    // Старт: меньше слота — слот; продление (без минимума) — вверх до слота.
    assert.equal(billedMinutes(60, { step: p1.step, min: p1.min }), 90);
    assert.equal(billedMinutes(91, { step: p1.step, min: p1.min }), 180);
    assert.equal(billedMinutes(1, { step: p1.step, min: p1.min, applyMinimum: false }), 90);
  });

  it('слот внутри одного правила — ровно цена слота; два слота — вдвое', () => {
    const { calendar, rules } = ctx();
    const one = amountForMinutes({ rules, calendar, from: at('2026-10-26T10:00:00'), minutes: 90 });
    assert.equal(one.amount_kopecks, 240000);
    assert.deepEqual(one.breakdown, [
      { from: '2026-10-26T05:00:00.000Z', to: '2026-10-26T06:30:00.000Z', price_per_hour_kopecks: 160000, price_per_slot_kopecks: 240000, slot_minutes: 90, minutes: 90, amount_kopecks: 240000 },
    ]);
    assert.equal(amountForMinutes({ rules, calendar, from: at('2026-10-26T10:00:00'), minutes: 180 }).amount_kopecks, 480000);
  });

  it('граница расписания внутри слота: 16:30–18:00 — 30 минут дневной цены и 60 минут вечерней', () => {
    const { calendar, rules } = ctx();
    const r = amountForMinutes({ rules, calendar, from: at('2026-10-26T16:30:00'), minutes: 90 });
    // 2 400 ₽ × 30/90 + 3 600 ₽ × 60/90 = 800 ₽ + 2 400 ₽.
    assert.equal(r.amount_kopecks, 320000);
    assert.deepEqual(r.breakdown.map((b) => [b.price_per_slot_kopecks, b.minutes, b.amount_kopecks]), [[240000, 30, 80000], [360000, 60, 240000]]);
    assert.equal(r.breakdown.reduce((s, b) => s + b.amount_kopecks, 0), r.amount_kopecks, 'части в сумме дают итог');
  });

  it('пояс клуба: тот же момент UTC в Москве — дневная цена целиком, в Екатеринбурге — с вечерней', () => {
    const utc = Date.parse('2026-10-26T11:30:00Z');
    const yekt = ctx(YEKT);
    const msk = ctx(MSK);
    assert.equal(amountForMinutes({ ...yekt, from: utc, minutes: 90 }).amount_kopecks, 320000); // 16:30 местного
    assert.equal(amountForMinutes({ ...msk, from: utc, minutes: 90 }).amount_kopecks, 240000); // 14:30 местного
  });

  it('рабочие сутки (№43): ночь пятницы — будняя вечерняя цена, с субботы 06:00 — выходная', () => {
    const { calendar, rules } = ctx();
    // Суббота 31 октября 05:00 местного: 60 минут ночи пятницы (3 600 ₽/слот) + 30 минут субботы (3 900 ₽/слот).
    const r = amountForMinutes({ rules, calendar, from: at('2026-10-31T05:00:00'), minutes: 90 });
    assert.equal(r.amount_kopecks, 240000 + 130000);
  });

  it('цена сейчас и следующая — за слот и до какого местного времени', () => {
    const { calendar, rules } = ctx();
    const p = pricesAround({ rules, calendar, at: at('2026-10-26T15:00:00') });
    assert.deepEqual(p.price_now, { price_per_hour_kopecks: 160000, price_per_slot_kopecks: 240000, slot_minutes: 90, until_local: '17:00', until: '2026-10-26T12:00:00.000Z' });
    assert.deepEqual(p.price_next, { price_per_hour_kopecks: 240000, price_per_slot_kopecks: 360000, slot_minutes: 90, from_local: '17:00', from: '2026-10-26T12:00:00.000Z' });
  });

  it('свои правила корта главнее правил вида; почасовое и слот вместе — общий знаменатель', () => {
    const rows = [...COURT_RULES, { id: 'own', resource_type: null, resource_id: COURT.id, days: [1], start_local: '10:00:00', end_local: '10:30:00', price_per_hour: 60000, step_minutes: 1, min_minutes: 0, priority: 0, active: true }];
    const { calendar, rules } = ctx(YEKT, rows);
    assert.equal(unitsDenominator(rules), 180);
    // 10:00–10:30 — 600 ₽/ч (300 ₽), 10:30–11:30 — 2 400 ₽ за 90 минут (1 600 ₽).
    const r = amountForMinutes({ rules, calendar, from: at('2026-10-26T10:00:00'), minutes: 90 });
    assert.equal(r.amount_kopecks, 30000 + 160000);
    assert.deepEqual(r.breakdown.map((b) => [b.price_per_hour_kopecks, b.price_per_slot_kopecks ?? null, b.minutes]), [[60000, null, 30], [160000, 240000, 60]]);
  });

  it('округление одно на сумму: цена слота не делится на минуты нацело', () => {
    const rows = [slotRule('odd', [1, 2, 3, 4, 5, 6, 7], '06:00:00', '06:00:00', 100001, 60)];
    const { calendar, rules } = ctx(YEKT, rows);
    // 1 000,01 ₽ за 60 минут; 45 минут = 750,0075 ₽ → 750 ₽ при округлении до рубля (по умолчанию 100 коп.).
    assert.equal(amountForMinutes({ rules, calendar, from: at('2026-10-26T10:00:00'), minutes: 45 }).amount_kopecks, 75000);
    assert.equal(amountForMinutes({ rules, calendar, from: at('2026-10-26T10:00:00'), minutes: 45, rounding: 1 }).amount_kopecks, 75001);
    assert.equal(roundAmount(100001 * 45, 1, 60), 75001);
    assert.equal(roundAmount(29, 1, 2), 15, 'половина вверх');
  });

  it('почасовое правило не изменилось: знаменатель 60, цена за час', () => {
    const rows = [{ id: 'h', resource_type: 'billiard_pyramid', resource_id: null, days: [1, 2, 3, 4, 5, 6, 7], start_local: '06:00:00', end_local: '06:00:00', price_per_hour: 50000, step_minutes: 1, min_minutes: 30, priority: 0, active: true }];
    const calendar = createCalendar({ timezone: YEKT });
    const rules = compileRules(rows, { id: 't', type: 'billiard_pyramid' }, calendar);
    assert.equal(unitsDenominator(rules), 60);
    const r = amountForMinutes({ rules, calendar, from: at('2026-10-26T10:00:00'), minutes: 47, rounding: 1 });
    assert.equal(r.amount_kopecks, Math.floor((50000 * 47 + 30) / 60));
    assert.deepEqual(Object.keys(r.breakdown[0]), ['from', 'to', 'price_per_hour_kopecks', 'minutes', 'amount_kopecks']);
  });
});
