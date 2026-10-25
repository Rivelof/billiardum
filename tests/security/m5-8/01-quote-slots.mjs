// PoC M5.8 / сценарий 1 — «корт дешевле слота» (деньги, инварианты 4 и 10).
//
// Атакующий: гость, который хочет сыграть на корте дешевле или вне правил слота.
// Цель: доказать, что продуктовый путь котировки (server/payments/quotes.mjs) в
// БОЕВОЙ конфигурации (devAllowAnyMinutes = false) принимает для корта только
// 1…4 слота и отвергает «Без лимита» и баланс, а движок тарифов
// (server/tariffs/engine.mjs) считает слот строго по правилу решения №212.
//
// Почему unit, а не стенд: на стенде включён DEV_ALLOW_ANY_MINUTES (dev-флаг, №54),
// поэтому там котировка принимает любые 1…1440 минут. В проде флаг принудительно
// выключен (server/lib/config.mjs:112 `!production && …`). Здесь вызывается тот же
// самый parseQuoteRequest с боевым параметром devAllowAnyMinutes = false — это и есть
// код, который исполняется в проде.
//
// Запуск:  node --test tests/security/m5-8/quote-slots.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseQuoteRequest, slotMinutesOptions, MAX_SLOTS } from '../../../server/payments/quotes.mjs';
import { compileRules, createCalendar, amountForMinutes, billedMinutes } from '../../../server/tariffs/engine.mjs';

const RID = '14e6ef0d-18db-41cc-b335-ae41b1f1712e';
const SID = '0192f3c0-0000-7000-8000-000000000001';
const SLOT = 90;

// Боевая конфигурация котировки: dev-флаг выключен (как при NODE_ENV=production).
const prod = { devAllowAnyMinutes: false, slotMinutes: SLOT };

function rejects(body, label) {
  assert.throws(
    () => parseQuoteRequest(body, prod),
    (e) => e?.code === 'bad_request',
    `должно отклоняться (bad_request): ${label}`,
  );
}

test('старт корта: только 1…4 слота, всё остальное — bad_request', () => {
  // Валидные: ровно 1…4 слота.
  for (const slots of [1, 2, 3, 4]) {
    const m = SLOT * slots;
    const r = parseQuoteRequest({ resource_id: RID, kind: 'start', minutes: m }, prod);
    assert.equal(r.minutes, m, `слот ×${slots}`);
    assert.equal(r.exact, false, 'exact не ставится в проде');
  }
  assert.deepEqual(slotMinutesOptions(SLOT), [90, 180, 270, 360]);
  assert.equal(MAX_SLOTS, 4);

  // Невалидные минуты: не кратно слоту, почасовые кнопки стола, 0, 5+ слотов,
  // дробные, огромные, отрицательные.
  for (const m of [1, 30, 45, 60, 89, 91, 100, 120, 180.5, 89.5, 0, -90, 5 * SLOT, 6 * SLOT, 999999, 86_400_000]) {
    rejects({ resource_id: RID, kind: 'start', minutes: m }, `minutes=${m}`);
  }
});

test('корт: «Без лимита» (minutes=null) и баланс пакетов запрещены', () => {
  rejects({ resource_id: RID, kind: 'start', minutes: null }, 'minutes=null (без лимита)');
  rejects({ resource_id: RID, kind: 'start', minutes: 90, use_balance: true }, 'use_balance на корте');
});

test('продление корта: тоже только слотами (шаг — слот, №204)', () => {
  for (const slots of [1, 2, 3, 4]) {
    const r = parseQuoteRequest({ resource_id: RID, kind: 'extend', session_id: SID, minutes: SLOT * slots }, prod);
    assert.equal(r.minutes, SLOT * slots);
    assert.equal(r.kind, 'extend');
  }
  for (const m of [1, 45, 100, 5 * SLOT, 30]) {
    rejects({ resource_id: RID, kind: 'extend', session_id: SID, minutes: m }, `extend minutes=${m}`);
  }
});

// --- Движок: цена слота строго по №212 ------------------------------------------------

const calendar = createCalendar({ timezone: 'Europe/Moscow', dayStartLocal: '06:00' });
const ALL = [1, 2, 3, 4, 5, 6, 7];

function slotRule({ id, from, to, slotMin, pricePerSlot, days = ALL }) {
  return {
    id,
    resource_type: 'padel_court',
    resource_id: null,
    days,
    start_local: from,
    end_local: to,
    price_per_hour: Math.round((pricePerSlot * 60) / slotMin),
    slot_minutes: slotMin,
    price_per_slot: pricePerSlot,
    step_minutes: slotMin,
    min_minutes: slotMin,
    priority: 0,
    active: true,
    created_at: '2026-10-01T00:00:00Z',
  };
}

test('движок: один слот в одном правиле = цене слота (кратной округлению)', () => {
  const rows = [slotRule({ id: 'r1', from: '06:00', to: '06:00', slotMin: 90, pricePerSlot: 900_000 })];
  const rules = compileRules(rows, { id: RID, type: 'padel_court' }, calendar);
  // 1 января 2026 12:00 MSK = 09:00 UTC — будний день, одно правило.
  const from = Date.UTC(2026, 0, 1, 9, 0, 0);
  const billed = billedMinutes(90, { step: rules[0].step, min: rules[0].min });
  assert.equal(billed, 90, 'минимум и шаг — слот');
  const r = amountForMinutes({ rules, calendar, from, minutes: billed, rounding: 100 });
  assert.equal(r.amount_kopecks, 900_000, 'ровно цена слота');
  // 4 слота = 4× цены слота.
  const r4 = amountForMinutes({ rules, calendar, from, minutes: 360, rounding: 100 });
  assert.equal(r4.amount_kopecks, 3_600_000);
});

test('движок №212: граница расписания внутри слота делит слот по минутам — не дешевле прораты', () => {
  // День 06:00–18:00 слот 9000 ₽; вечер 18:00–06:00 слот 12000 ₽.
  const rows = [
    slotRule({ id: 'day', from: '06:00', to: '18:00', slotMin: 90, pricePerSlot: 900_000 }),
    slotRule({ id: 'eve', from: '18:00', to: '06:00', slotMin: 90, pricePerSlot: 1_200_000 }),
  ];
  const rules = compileRules(rows, { id: RID, type: 'padel_court' }, calendar);
  // Старт 17:30 MSK (14:30 UTC): 30 мин день + 60 мин вечер.
  const from = Date.UTC(2026, 0, 1, 14, 30, 0);
  const r = amountForMinutes({ rules, calendar, from, minutes: 90, rounding: 100 });
  // Прората: 30·(900000/90) + 60·(1200000/90) = 300000 + 800000 = 1 100 000.
  assert.equal(r.amount_kopecks, 1_100_000, 'слот через границу = поминутная прората');
  // Проверка, что это дороже чисто дневного и дешевле чисто вечернего — цена честная,
  // гонять границу ради скидки смысла нет (минута дня дешевле минуты вечера, но каждая
  // минута оплачена по своему правилу).
  assert.ok(r.amount_kopecks > 900_000 && r.amount_kopecks < 1_200_000);
});
