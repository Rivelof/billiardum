// Мастер тарифов без базы (M5.1 №156): шаблоны покрывают неделю, дыры и пересечения
// по рабочим суткам клуба (№43), разбор правил, согласие с движком тарифов.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compileRules, createCalendar, ruleAt } from '../../tariffs/engine.mjs';
import { applyTemplate, checkWeek, normalizeRules, TEMPLATES, templatesJson, weekProblem } from '../tariffs.mjs';
import { KINDS } from '../hall.mjs';

const rule = (days, from, to, price = 50000, kind = null) => ({ kind, days, from, to, price_per_hour_kopecks: price, min_minutes: 30, step_minutes: 1 });
const check = (rules, opts = {}) => checkWeek(normalizeRules(rules), { dayStart: '06:00', activeKinds: ['pyramid'], ...opts });

describe('шаблоны', () => {
  it('пять шаблонов из контракта; каждый покрывает неделю без дыр и пересечений', () => {
    assert.deepEqual(
      TEMPLATES.map((t) => t.title),
      ['Одна цена', 'Будни и выходные', 'День и вечер', 'День, вечер, ночь', 'Будни и выходные × день и вечер'],
    );
    for (const t of TEMPLATES) {
      const prices = Object.fromEntries(t.params.map((p, i) => [p.key, 40000 + i * 10000]));
      for (const dayStart of ['06:00', '00:00', '05:00', '08:30']) {
        assert.equal(checkWeek(normalizeRules(applyTemplate(t.id, prices)), { dayStart, activeKinds: ['pool', 'mixed'] }), null, `${t.id} ${dayStart}`);
      }
    }
    const json = templatesJson();
    assert.equal(json.templates.length, 5);
    assert.deepEqual(json.defaults, { min_minutes: 30, step_minutes: 1 });
    json.templates[0].rules[0].days.push(9);
    assert.deepEqual(TEMPLATES[0].rules[0].days, [1, 2, 3, 4, 5, 6, 7], 'ответ — копия');
  });

  it('«Будни и выходные»: ночь с пятницы на субботу — будняя цена (как в движке)', () => {
    const rules = normalizeRules(applyTemplate('weekdays_weekend', { weekday: 50000, weekend: 70000 }, { kind: 'pyramid' }));
    const rows = rules.map((r, i) => ({ id: `r${i}`, resource_type: KINDS.pyramid, days: r.days, start_local: r.from, end_local: r.to, price_per_hour: r.price_per_hour_kopecks, step_minutes: 1, min_minutes: 30 }));
    const cal = createCalendar({ timezone: 'Asia/Yekaterinburg' });
    const compiled = compileRules(rows, { id: 'x', type: KINDS.pyramid }, cal);
    // Сб 24.10.2026 02:00 в Екатеринбурге (UTC+5) = пт 21:00 UTC.
    assert.equal(ruleAt(compiled, cal, Date.parse('2026-10-23T21:00:00Z')).price, 50000);
    // Сб 24.10.2026 07:00 местного = 02:00 UTC.
    assert.equal(ruleAt(compiled, cal, Date.parse('2026-10-24T02:00:00Z')).price, 70000);
  });
});

describe('проверка недели', () => {
  it('дыра: день рабочих суток и местное время', () => {
    // Нет пятничной ночи 00:00–06:00 (рабочие сутки пятницы).
    const p = check([rule([1, 2, 3, 4, 5, 6, 7], '06:00', '00:00'), rule([1, 2, 3, 4, 6, 7], '00:00', '06:00')]);
    assert.deepEqual(p, { type: 'gap', kind: 'pyramid', weekday: 5, from: '00:00', to: '06:00' });
    const q = check([rule([1, 2, 3, 4, 5, 6, 7], '10:00', '02:00')]);
    assert.deepEqual(q, { type: 'gap', kind: 'pyramid', weekday: 1, from: '06:00', to: '10:00' });
    const r = check([rule([1, 2, 3, 4, 5, 6, 7], '06:00', '22:00')]);
    assert.deepEqual(r, { type: 'gap', kind: 'pyramid', weekday: 1, from: '22:00', to: '06:00' });
    const s = checkWeek(normalizeRules([rule([1, 2, 3, 4, 5, 6, 7], '00:00', '22:00')]), { dayStart: '00:00', activeKinds: [] });
    assert.deepEqual(s, { type: 'gap', kind: null, weekday: 1, from: '22:00', to: '24:00' });
  });

  it('пересечение важнее дыры; правило для всех типов и правило типа — пересечение', () => {
    const p = check([rule([1, 2, 3, 4, 5, 6, 7], '06:00', '06:00'), rule([6], '12:00', '13:00')]);
    assert.deepEqual(p, { type: 'overlap', kind: 'pyramid', weekday: 6, from: '12:00', to: '13:00' });
    const q = check([rule([1, 2, 3, 4, 5, 6, 7], '06:00', '06:00'), rule([1], '06:00', '07:00', 1, 'pyramid')]);
    assert.equal(q.type, 'overlap');
  });

  it('типы столов: у стола в работе без правил своего типа — дыра; правила только по типу — без пересечений между типами', () => {
    const p = check([rule([1, 2, 3, 4, 5, 6, 7], '06:00', '06:00', 1, 'pyramid')], { activeKinds: ['pyramid', 'pool'] });
    assert.deepEqual(p, { type: 'gap', kind: 'pool', weekday: 1, from: '06:00', to: '06:00' });
    const ok = check([rule([1, 2, 3, 4, 5, 6, 7], '06:00', '06:00', 1, 'pyramid'), rule([1, 2, 3, 4, 5, 6, 7], '06:00', '06:00', 2, 'pool')], {
      activeKinds: ['pyramid', 'pool'],
    });
    assert.equal(ok, null);
  });

  it('weekProblem на кольце недели: интервал с воскресенья через начало суток понедельника', () => {
    // Сутки с 00:00: правило вс 22:00–02:00 закрывает пн 00:00–02:00.
    const rules = normalizeRules([rule([1, 2, 3, 4, 5, 6], '02:00', '02:00'), rule([7], '02:00', '02:00')]);
    assert.equal(weekProblem(rules, 0), null);
  });
});

describe('разбор правил', () => {
  it('№163: цена 0 ₽/ч — 400 bad_request с полем цены; 1 копейка — можно', () => {
    for (const price of [0, -0]) {
      assert.throws(
        () => normalizeRules([rule([1, 2, 3, 4, 5, 6, 7], '06:00', '06:00'), rule([1], '06:00', '07:00', price, 'pool')]),
        (e) => e.status === 400 && e.code === 'bad_request' && e.message.includes('rules[1].price_per_hour_kopecks'),
      );
    }
    assert.equal(normalizeRules([rule([1], '06:00', '07:00', 1)])[0].price_per_hour_kopecks, 1);
  });

  it('ошибки формы — 400 bad_request; 24:00 и from = to — сутки', () => {
    const bad = (rules) => assert.throws(() => normalizeRules(rules), (e) => e.status === 400 && e.code === 'bad_request');
    bad([]);
    bad('x');
    bad([{ ...rule([1], '06:00', '07:00'), days: [] }]);
    bad([{ ...rule([1], '06:00', '07:00'), days: [1, 1] }]);
    bad([{ ...rule([1], '06:00', '07:00'), days: [8] }]);
    bad([rule([1], '6:00', '07:00')]);
    bad([rule([1], '06:00', '24:30')]);
    bad([{ ...rule([1], '06:00', '07:00'), price_per_hour_kopecks: 1.5 }]);
    bad([{ ...rule([1], '06:00', '07:00'), price_per_hour_kopecks: -1 }]);
    bad([{ ...rule([1], '06:00', '07:00'), min_minutes: undefined }]);
    bad([{ ...rule([1], '06:00', '07:00'), step_minutes: 0 }]);
    bad([rule([1], '06:00', '07:00', 1, 'billiard_carom')]);
    assert.equal(normalizeRules([rule([1], '06:00', '07:00', 1, 'billiard_pool')])[0].kind, 'pool');
    bad(Array.from({ length: 101 }, () => rule([1], '06:00', '07:00')));
    const [r] = normalizeRules([rule([3, 1], '18:00', '24:00')]);
    assert.deepEqual([r.days, r.from, r.to, r.len], [[1, 3], '18:00', '00:00', 360]);
    assert.equal(normalizeRules([rule([1], '06:00', '06:00')])[0].len, 1440);
  });
});

describe('формат frontend (resource_type, start_local, end_local)', () => {
  it('правила в виде столбцов базы, разрезанные в полночь, принимаются', () => {
    const fe = (type, days, s, e, price) => ({ resource_type: type, days, start_local: s, end_local: e, price_per_hour_kopecks: price, step_minutes: 1, min_minutes: 30 });
    const rules = [];
    for (const type of ['billiard_pyramid', 'billiard_pool']) {
      rules.push(fe(type, [1, 2, 3, 4, 5, 6, 7], '06:00', '17:00', 50000), fe(type, [1, 2, 3, 4, 5, 6, 7], '17:00', '00:00', 80000), fe(type, [1, 2, 3, 4, 5, 6, 7], '00:00:00', '06:00', 90000));
    }
    const n = normalizeRules(rules);
    assert.deepEqual([n[0].kind, n[2].from], ['pyramid', '00:00']);
    assert.equal(checkWeek(n, { dayStart: '06:00', activeKinds: ['pyramid', 'pool'] }), null);
    assert.deepEqual(checkWeek(n, { dayStart: '06:00', activeKinds: ['pyramid', 'pool', 'mixed'] }), { type: 'gap', kind: 'mixed', weekday: 1, from: '06:00', to: '06:00' });
  });
});
