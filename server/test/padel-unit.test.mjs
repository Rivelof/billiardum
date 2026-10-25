// Падел-корт без базы (M5.8 №203–205): справочник видов ресурсов, минуты котировки корта (слоты,
// без «Без лимита» и баланса), слово «корт» в чеке, тревоге и отчёте смены, фильтр дашборда.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  familyOf, isSlotType, kindJson, kindsJson, KIND_TO_TYPE, maxPlayers, noun, resourceName, RESOURCE_TYPES, TABLE_KINDS, TYPE_TO_KIND, typesOfFamily,
} from '../lib/resource-kinds.mjs';
import { parseQuoteRequest, slotMinutesOptions } from '../payments/quotes.mjs';
import { itemDescription } from '../payments/receipt.mjs';
import { alarmText } from '../alarms/index.mjs';
import { reportText } from '../reports/shift-report.mjs';
import { matchKind, TYPES } from '../dashboard/day.mjs';

const RES = 'e1000000-0000-4000-8000-000000000101';
const SES = 'b5000000-0000-4000-8000-000000000001';

describe('справочник видов ресурсов (№203)', () => {
  it('корт — семья court, слоты, до 4 игроков; столы — table, почасово, 20', () => {
    assert.deepEqual(RESOURCE_TYPES, ['billiard_pyramid', 'billiard_pool', 'billiard_snooker', 'billiard_mixed', 'padel_court']);
    assert.deepEqual(TABLE_KINDS, ['pyramid', 'pool', 'snooker', 'mixed']);
    assert.equal(KIND_TO_TYPE.padel_court, 'padel_court');
    assert.equal(TYPE_TO_KIND.billiard_pool, 'pool');
    assert.deepEqual([familyOf('padel_court'), isSlotType('padel_court'), maxPlayers('padel_court')], ['court', true, 4]);
    assert.deepEqual([familyOf('billiard_mixed'), isSlotType('billiard_mixed'), maxPlayers('billiard_mixed')], ['table', false, 20]);
    assert.deepEqual(typesOfFamily('court'), ['padel_court']);
    assert.equal(familyOf('unknown'), 'table', 'неизвестный тип — как стол');
  });

  it('слова: «корт/корта/кортов», падежи; название ресурса', () => {
    assert.deepEqual(kindJson('padel_court').noun, { one: 'корт', few: 'корта', many: 'кортов', nom: 'корт', gen: 'корта', dat: 'корту', acc: 'корт', ins: 'кортом', pre: 'корте' });
    assert.equal(kindJson('billiard_pool').noun.many, 'столов');
    assert.equal(noun('padel_court', 'pre'), 'корте');
    assert.equal(resourceName('padel_court', 2), 'Корт 2');
    assert.equal(resourceName('billiard_pool', 6, { case: 'gen', capital: false }), 'стола 6');
    const all = kindsJson();
    assert.deepEqual(all.kinds.map((k) => [k.kind, k.family, k.label]), [
      ['pyramid', 'table', 'Пирамида'], ['pool', 'table', 'Пул'], ['snooker', 'table', 'Снукер'], ['mixed', 'table', 'Смешанный'], ['padel_court', 'court', 'Падел'],
    ]);
    assert.deepEqual(all.slot_minutes, [60, 90, 120]);
    assert.deepEqual(all.families.map((f) => f.family), ['table', 'court']);
  });
});

describe('котировка корта: только слоты (№204)', () => {
  const q = (body, opts) => parseQuoteRequest({ resource_id: RES, kind: 'start', ...body }, opts);
  const code = (fn) => {
    try {
      fn();
    } catch (err) {
      return [err.code, err.message];
    }
    return null;
  };

  it('1–4 слота, и для старта, и для продления; не кратно слоту — 400', () => {
    assert.deepEqual(slotMinutesOptions(90), [90, 180, 270, 360]);
    assert.deepEqual(slotMinutesOptions(null), []);
    assert.equal(q({ minutes: 90 }, { slotMinutes: 90 }).minutes, 90);
    assert.equal(parseQuoteRequest({ resource_id: RES, kind: 'extend', session_id: SES, minutes: 180 }, { slotMinutes: 90 }).minutes, 180);
    for (const m of [60, 120, 45, 450]) assert.equal(code(() => q({ minutes: m }, { slotMinutes: 90 }))?.[0], 'bad_request', String(m));
    assert.equal(q({ minutes: 120 }, { slotMinutes: 60 }).minutes, 120);
    // Стол как раньше: 30, 60, 120, 180.
    assert.equal(code(() => q({ minutes: 90 }))?.[0], 'bad_request');
  });

  it('«Без лимита» и баланс пакетов на корте — 400; форма без вида — пропускает минуты', () => {
    assert.equal(code(() => q({ minutes: null }, { slotMinutes: 90 }))?.[0], 'bad_request');
    assert.equal(code(() => q({ minutes: 90, use_balance: true }, { slotMinutes: 90 }))?.[0], 'bad_request');
    assert.equal(q({ minutes: 90 }, { anyMinutes: true }).minutes, 90);
    assert.equal(q({ minutes: null }, { anyMinutes: true }).minutes, null);
    // DEV_ALLOW_ANY_MINUTES (только разработка, №54) — любые минуты и у корта, точно.
    assert.equal(q({ minutes: 7 }, { slotMinutes: 90, devAllowAnyMinutes: true }).exact, true);
    assert.equal(q({ minutes: 180 }, { slotMinutes: 90, devAllowAnyMinutes: true }).exact, false);
  });
});

describe('слова «корт» и «стол» по виду ресурса (T48)', () => {
  it('чек 54-ФЗ, тревога', () => {
    assert.equal(itemDescription({ resourceNumber: 1, minutes: 90, resourceType: 'padel_court' }), 'Игра, корт 1, 1 ч 30 мин');
    assert.equal(itemDescription({ resourceNumber: 4, minutes: 120 }), 'Игра, стол 4, 2 ч', 'без вида — стол, как раньше');
    assert.equal(alarmText('device_offline', 2, 'padel_court').startsWith('Корт 2: '), true);
    assert.equal(alarmText('device_offline', 3).startsWith('Стол 3: '), true);
  });

  it('отчёт смены: строка по столам и кортам, если есть оба вида', () => {
    const base = {
      shift: { number: 7, timezone: 'Asia/Yekaterinburg' },
      period: { from: '2026-10-26T04:00:00Z', to: '2026-10-26T16:00:00Z' },
      revenue: { total_kopecks: 0, tables: { total_kopecks: 0 }, bar: { total_kopecks: 0 }, by_method: { cash: 0, card_terminal: 0, sbp: 0, card: 0 }, refunds: { total_kopecks: 0 } },
      manual_actions: { count: 0 },
      service_light: { total_minutes: 0 },
      cash: { discrepancy_kopecks: 0, actual_cash_kopecks: 0 },
      reconciliation: { kkt: { ok: true }, online: { status: 'skipped' } },
    };
    const two = reportText({
      ...base,
      play: {
        hours: 4.5, utilization_percent: 10,
        by_family: [
          { family: 'table', hours: 3, utilization_percent: 6.3, revenue_kopecks: 150000, refunds_kopecks: 0 },
          { family: 'court', hours: 1.5, utilization_percent: 6.3, revenue_kopecks: 240000, refunds_kopecks: 0 },
        ],
      },
    });
    assert.match(two, /Столы — 3 ч, загрузка 6,3 %, 1\s500\s₽; корты — 1,5 ч, загрузка 6,3 %, 2\s400\s₽\./u);
    const one = reportText({ ...base, play: { hours: 3, utilization_percent: 6, by_family: [{ family: 'table', hours: 3, utilization_percent: 6, revenue_kopecks: 0, refunds_kopecks: 0 }] } });
    assert.doesNotMatch(one, /корты/);
  });

  it('дашборд: kind — тип или семья (table, court)', () => {
    assert.ok(TYPES.includes('padel_court') && TYPES.includes('billiard_mixed'));
    assert.equal(matchKind('padel_court', 'court'), true);
    assert.equal(matchKind('billiard_pool', 'court'), false);
    assert.equal(matchKind('billiard_pool', 'table'), true);
    assert.equal(matchKind('billiard_pool', 'billiard_pool'), true);
    assert.equal(matchKind('padel_court', null), true);
  });
});
