// Мастер тарифов и зала для падел-корта без базы (M5.8 №203–204): правила слота, одна длина слота
// на вид, «все типы» — только столы, неделя корта проверяется своими правилами.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../../http/errors.mjs';
import { compileRules, createCalendar, ruleAt } from '../../tariffs/engine.mjs';
import { KINDS, KIND_OF_TYPE, resourceJson } from '../hall.mjs';
import { applyTemplate, checkWeek, hourlyOfSlot, normalizeRules, templatesJson } from '../tariffs.mjs';

const slot = (days, from, to, price = 240000, minutes = 90) => ({ kind: 'padel_court', days, from, to, slot_minutes: minutes, price_per_slot_kopecks: price });
const hourly = (days, from, to, price = 50000, kind = null) => ({ kind, days, from, to, price_per_hour_kopecks: price, min_minutes: 30, step_minutes: 1 });
const badDetail = (fn) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof HttpError, String(err));
    return [err.status, err.code, err.message.replace(/^bad_request: /, '')];
  }
  assert.fail('ожидалась ошибка');
};
const ALL = [1, 2, 3, 4, 5, 6, 7];

describe('вид padel_court в мастере зала', () => {
  it('kind padel_court ↔ тип padel_court; семья — court', () => {
    assert.equal(KINDS.padel_court, 'padel_court');
    assert.equal(KIND_OF_TYPE.padel_court, 'padel_court');
    assert.equal(KINDS.pyramid, 'billiard_pyramid');
    const j = resourceJson({ id: 'x', number: 1, type: 'padel_court', title: 'Корт 1', plan_x: 0, plan_y: 0, plan_rotation: 0, active: true });
    assert.deepEqual([j.kind, j.type, j.family], ['padel_court', 'padel_court', 'court']);
    assert.equal(resourceJson({ id: 'y', number: 2, type: 'billiard_pool', title: 'Стол 2' }).family, 'table');
  });
});

describe('правила слота', () => {
  it('разбор: цена за слот, минимум и шаг — слот, справочная цена часа', () => {
    const [r] = normalizeRules([slot(ALL, '06:00', '06:00', 240000, 90)]);
    assert.deepEqual(
      { kind: r.kind, slot: r.slot_minutes, price: r.price_per_slot_kopecks, hour: r.price_per_hour_kopecks, min: r.min_minutes, step: r.step_minutes },
      { kind: 'padel_court', slot: 90, price: 240000, hour: 160000, min: 90, step: 90 },
    );
    assert.equal(hourlyOfSlot(100000, 90), 66667, 'половина вверх');
    assert.equal(hourlyOfSlot(1, 120), 1, 'не меньше копейки');
    // Почасовое правило — без полей слота.
    const [h] = normalizeRules([hourly(ALL, '06:00', '06:00')]);
    assert.deepEqual([h.slot_minutes, h.price_per_slot_kopecks], [null, null]);
  });

  it('ошибки формы: длина слота, цена ≤ 0, почасовые поля у корта и слот у стола, разные длины', () => {
    assert.deepEqual(badDetail(() => normalizeRules([slot(ALL, '06:00', '06:00', 240000, 45)])), [400, 'bad_request', 'rules[0].slot_minutes']);
    assert.deepEqual(badDetail(() => normalizeRules([slot(ALL, '06:00', '06:00', 0)])), [400, 'bad_request', 'rules[0].price_per_slot_kopecks: must be > 0']);
    assert.deepEqual(badDetail(() => normalizeRules([{ ...slot(ALL, '06:00', '06:00'), price_per_hour_kopecks: 1 }])), [400, 'bad_request', 'rules[0].price_per_hour_kopecks: slot kind']);
    assert.deepEqual(badDetail(() => normalizeRules([{ ...slot(ALL, '06:00', '06:00'), min_minutes: 30 }])), [400, 'bad_request', 'rules[0].min_minutes: slot']);
    assert.deepEqual(badDetail(() => normalizeRules([{ ...hourly(ALL, '06:00', '06:00', 1, 'pool'), slot_minutes: 60 }])), [400, 'bad_request', 'rules[0].slot_minutes: hourly kind']);
    assert.deepEqual(
      badDetail(() => normalizeRules([slot([1, 2, 3, 4, 5], '06:00', '06:00', 1, 90), slot([6, 7], '06:00', '06:00', 1, 60)])),
      [400, 'bad_request', 'slot_minutes: one per kind'],
    );
  });

  it('неделя корта: «все типы» (kind null) корт не покрывает; свои правила — покрывают', () => {
    const tables = hourly(ALL, '06:00', '06:00');
    assert.deepEqual(checkWeek(normalizeRules([tables]), { dayStart: '06:00', activeKinds: ['pool', 'padel_court'] }), {
      type: 'gap', kind: 'padel_court', weekday: 1, from: '06:00', to: '06:00',
    });
    const court = [slot([1, 2, 3, 4, 5], '06:00', '17:00'), slot([1, 2, 3, 4, 5], '17:00', '06:00', 360000), slot([6, 7], '06:00', '06:00', 390000)];
    assert.equal(checkWeek(normalizeRules([tables, ...court]), { dayStart: '06:00', activeKinds: ['pool', 'padel_court'] }), null);
    // Пересечение у корта — с видом корта.
    const p = checkWeek(normalizeRules([tables, ...court, slot([3], '20:00', '21:00')]), { dayStart: '06:00', activeKinds: ['pool', 'padel_court'] });
    assert.deepEqual(p, { type: 'overlap', kind: 'padel_court', weekday: 3, from: '20:00', to: '21:00' });
  });

  it('шаблон для корта — цены параметров за слот; совпадает с движком по местному времени', () => {
    const rules = normalizeRules(applyTemplate('day_evening', { day: 240000, evening: 360000 }, { kind: 'padel_court', slot_minutes: 60 }));
    assert.ok(rules.every((r) => r.slot_minutes === 60 && r.min_minutes === 60 && r.step_minutes === 60));
    assert.equal(checkWeek(rules, { dayStart: '06:00', activeKinds: ['padel_court'] }), null);
    const calendar = createCalendar({ timezone: 'Asia/Yekaterinburg' });
    const rows = rules.map((r, i) => ({ id: `r${i}`, resource_type: 'padel_court', days: r.days, start_local: r.from, end_local: r.to, price_per_hour: r.price_per_hour_kopecks, price_per_slot: r.price_per_slot_kopecks, slot_minutes: r.slot_minutes, step_minutes: r.step_minutes, min_minutes: r.min_minutes }));
    const compiled = compileRules(rows, { id: 'c', type: 'padel_court' }, calendar);
    // «День и вечер»: день 06:00–18:00. 17:59 местного (UTC+5) — день, 18:00 — вечер.
    assert.equal(ruleAt(compiled, calendar, Date.parse('2026-10-26T12:59:00Z')).price, 240000);
    assert.equal(ruleAt(compiled, calendar, Date.parse('2026-10-26T13:00:00Z')).price, 360000);
    const json = templatesJson();
    assert.deepEqual(json.slot, { options: [60, 90, 120], default_minutes: 90 });
  });
});
