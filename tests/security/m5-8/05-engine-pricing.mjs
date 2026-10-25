// PoC M5.8 / сценарий 5 — цена слота в боевом движке (деньги, инвариант 10, решения №44, №212).
//
// Запускается РЕАЛЬНЫЙ server/tariffs/index.mjs `amountFor` (тот же вызов, что котировка
// payments/quotes.mjs:262 и бронь bookings/service.mjs:288) на подменной базе: подменён только
// db.query, возвращающий строки клуба, ресурса и правил. Пояс клуба — Asia/Yekaterinburg (как у сида).
//
// Что проверяется:
//  * граница расписания внутри слота делит слот по минутам, дешевле «честной» цены не получить;
//  * слот в окне одной цены = цене слота; 4 слота = 4 × цена; больше и дробные минуты — ошибка;
//  * нет «дыры» между правилами, пояс клуба определяет тип дня (ночь с пятницы на субботу — пятничная);
//  * находки Н-1/Н-2 (заход 1) и их исправление (заход 2): опоздание/ранний приход считаются с exact, а копеечный
//    тариф останавливается выше движка.
//
// Запуск: node tests/security/m5-8/05-engine-pricing.mjs

import { amountFor } from '../../../server/tariffs/index.mjs';
import { runner } from './lib.mjs';

const r = runner('M5.8 / 5: движок цены слота');
const RID = 'e1000000-0000-4000-8000-000000000102';
const CID = 'c1000000-0000-4000-8000-000000000001';
const ALL = [1, 2, 3, 4, 5, 6, 7];

function rule(id, { days = ALL, from, to, slot = 90, perSlot, created = '2026-10-01T00:00:00Z' }) {
  return {
    id, resource_type: 'padel_court', resource_id: null, days, start_local: `${from}:00`, end_local: `${to}:00`,
    price_per_hour: Math.round((perSlot * 60) / slot), step_minutes: slot, min_minutes: slot, priority: 0, active: true,
    created_at: created, slot_minutes: slot, price_per_slot: perSlot,
  };
}

function fakeDb({ rules, timezone = 'Asia/Yekaterinburg', settings = {}, type = 'padel_court', hourly = null }) {
  return {
    async query(sql) {
      if (sql.includes('from bl.resources r join bl.clubs c')) {
        return { rows: [{ id: RID, club_id: CID, type, number: 2, title: 'Корт 2', active: true, timezone, settings, club_name: 'PoC' }] };
      }
      if (sql.includes('from bl.tariff_rules')) return { rows: hourly ?? rules };
      if (sql.includes('from bl.holidays')) return { rows: [] };
      throw new Error(`неожиданный запрос: ${sql.slice(0, 80)}`);
    },
  };
}

// Время в поясе клуба (UTC+5, без перехода на летнее): локальное → UTC.
const local = (date, hh, mm = 0) => Date.UTC(...date.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))), hh - 5, mm);
const price = (db, from, minutes, minimum = true) => amountFor(db, { resourceId: RID, from, minutes, minimum });

// Расписание: будни день 06:00–17:00 — 2 400 ₽/слот, будни вечер 17:00–06:00 — 3 600 ₽,
// выходные круглосуточно — 3 900 ₽ (как в сиде).
const rules = [
  rule('wd-day', { days: [1, 2, 3, 4, 5], from: '06:00', to: '17:00', perSlot: 240000 }),
  rule('wd-eve', { days: [1, 2, 3, 4, 5], from: '17:00', to: '06:00', perSlot: 360000 }),
  rule('we', { days: [6, 7], from: '06:00', to: '06:00', perSlot: 390000 }),
];
const db = fakeDb({ rules });
// 2026-10-26 — понедельник, 2026-10-30 — пятница, 2026-10-31 — суббота.
const MON = '2026-10-26';
const FRI = '2026-10-30';
const SAT = '2026-10-31';

// 1. Окно одной цены.
let x = await price(db, local(MON, 10, 0), 90);
r.check('1 слот в окне одной цены = 2 400 ₽', x.amount_kopecks === 240000 && x.minutes === 90 && x.slot_minutes === 90, `${x.amount_kopecks} / ${x.minutes} мин`);
x = await price(db, local(MON, 10, 0), 360);
r.check('4 слота = 4 × 2 400 ₽', x.amount_kopecks === 4 * 240000, `${x.amount_kopecks}`);

// 2. Минуты не кратные слоту: движок округляет вверх до слота (минимум и шаг — слот), дешевле нельзя.
for (const [m, expected] of [[1, 90], [45, 90], [89, 90], [91, 180], [100, 180]]) {
  x = await price(db, local(MON, 10, 0), m, true);
  r.check(`движок: ${m} мин при старте → оплачивается ${expected} мин (не дешевле слота)`, x.minutes === expected && x.amount_kopecks >= 240000, `${x.minutes} мин, ${x.amount_kopecks}`);
}
for (const bad of [0, -90, 1.5, NaN, 7 * 1440 + 1, Number.MAX_SAFE_INTEGER, '90']) {
  const rejected = await price(db, local(MON, 10, 0), bad).then(() => false, (e) => e.code === 'bad_tariff');
  r.check(`движок: minutes=${String(bad)} — bad_tariff`, rejected);
}

// 3. Граница расписания внутри слота: поминутная прората (решение №212).
//    Старт 16:30: 30 мин по 2 400 ₽/слот и 60 мин по 3 600 ₽/слот → 800 + 2 400 = 3 200 ₽.
x = await price(db, local(MON, 16, 30), 90);
r.check('граница 17:00 внутри слота: 30 мин дневных + 60 мин вечерних = 3 200 ₽', x.amount_kopecks === 320000, `${x.amount_kopecks}`);
r.check('в разбивке два отрезка с ценой слота', x.breakdown.length === 2 && x.breakdown.every((b) => b.slot_minutes === 90), JSON.stringify(x.breakdown.map((b) => [b.minutes, b.amount_kopecks])));
r.check('сумма разбивки = итог', x.breakdown.reduce((a, b) => a + b.amount_kopecks, 0) === x.amount_kopecks);
// Сдвиг начала раньше 17:00 на m минут даёт m дешёвых минут: цена не растёт и не опускается ниже
// слота дешёвого окна (2 400 ₽) — «дешевле слота» не получить ни одним началом.
let prev = Infinity;
let monotone = true;
let floor = Infinity;
for (let m = 0; m <= 90; m += 5) {
  const y = await price(db, local(MON, 17, 0) - m * 60_000, 90);
  if (y.amount_kopecks > prev) monotone = false;
  prev = y.amount_kopecks;
  floor = Math.min(floor, y.amount_kopecks);
}
r.check('сдвиг начала к дешёвому окну цену не повышает (монотонно)', monotone);
r.check('ни одно начало на границе не дешевле слота дешёвого окна', floor >= 240000, `минимум ${floor}`);
// Любая цена слота не ниже слота дешёвого окна и не выше слота дорогого.
r.check('цена слота на границе между дешёвым и дорогим окнами', x.amount_kopecks > 240000 && x.amount_kopecks < 360000);

// 4. Пояс и рабочие сутки клуба: ночь с пятницы на субботу — пятничная (вечерняя) цена, суббота с 06:00 — выходная.
x = await price(db, local(SAT, 1, 0), 90);
r.check('суббота 01:00–02:30 — пятничная вечерняя цена 3 600 ₽ (рабочие сутки, №43)', x.amount_kopecks === 360000, `${x.amount_kopecks}`);
x = await price(db, local(SAT, 5, 0), 90);
r.check('суббота 05:00–06:30: 60 мин пятничных (вечер) + 30 мин выходных = 2 400 + 1 300 = 3 700 ₽', x.amount_kopecks === 370000, `${x.amount_kopecks}`);
x = await price(db, local(FRI, 23, 0), 90);
r.check('пятница 23:00–00:30 — вечерняя цена 3 600 ₽', x.amount_kopecks === 360000, `${x.amount_kopecks}`);
// Тот же миг, другой пояс клуба — другая цена (дыра в поясе клуба недопустима).
const dbMsk = fakeDb({ rules, timezone: 'Europe/Moscow' });
x = await price(dbMsk, local(MON, 10, 0), 90); // 10:00 по Екатеринбургу = 08:00 по Москве, днём
r.check('пояс клуба меняет окно цены (Москва, тот же миг: ещё дневное окно)', x.amount_kopecks === 240000);
x = await price(dbMsk, local(MON, 20, 0), 90); // 20:00 по Екатеринбургу = 18:00 по Москве — вечер
r.check('пояс клуба: вечернее окно в Москве', x.amount_kopecks === 360000);

// 5. Нет правила на минуту слота — no_tariff, а не бесплатная минута.
const holey = fakeDb({ rules: [rule('only-day', { from: '06:00', to: '17:00', perSlot: 240000 })] });
const noTariff = await price(holey, local(MON, 16, 30), 90).then(() => false, (e) => e.code === 'no_tariff');
r.check('слот выходит за последнее правило — no_tariff (минуты без правила не бесплатны)', noTariff);

// --- Находки (заход 1) и их исправление (заход 2, bc51e24) ----------------------------------------------------
// Н-1. Старт по брони корта: опоздавший гость и ранний приход. Движок без exact округляет остаток ВВЕРХ до слота
// (шаг = минимум = слот) — это поведение движка осталось (обычный старт и продление — целыми слотами). Исправление
// — в bookings/service.mjs: priceOf(..., exact = isSlotType) передаёт exact: минуты как есть. Здесь оба вызова.
x = await price(db, local(MON, 10, 30), 60, false);
const prorata = Math.round((60 * 240000) / 90);
r.check('движок без exact: 60 оставшихся минут корта = целый слот (обычное поведение движка, для брони не используется)', x.minutes === 90 && x.amount_kopecks === 240000, `${x.minutes} мин, ${x.amount_kopecks / 100} ₽`);
x = await amountFor(db, { resourceId: RID, from: local(MON, 10, 30), minutes: 60, minimum: false, exact: true });
r.check('Н-1 исправлено: опоздание на 30 минут из 90 — 60 минут по минутам = 1 600 ₽ (exact)', x.minutes === 60 && x.amount_kopecks === prorata, `${x.minutes} мин, ${x.amount_kopecks / 100} ₽ (ждали ${prorata / 100} ₽)`);
x = await amountFor(db, { resourceId: RID, from: local(MON, 9, 40), minutes: 20, minimum: false, exact: true });
r.check('Н-1 исправлено: ранний приход за 20 минут = 533 ₽ по минутам, не целый слот', x.minutes === 20 && x.amount_kopecks === Math.round((20 * 240000) / 90 / 100) * 100, `${x.minutes} мин, ${x.amount_kopecks / 100} ₽`);
// Для сравнения — стол: тот же вызов даёт цену по минутам с шагом тарифа.
const tableRules = [{ id: 't', resource_type: 'billiard_pool', resource_id: null, days: ALL, start_local: '06:00:00', end_local: '06:00:00', price_per_hour: 60000, step_minutes: 15, min_minutes: 30, priority: 0, active: true, created_at: '2026-10-01T00:00:00Z', slot_minutes: null, price_per_slot: null }];
const tdb = fakeDb({ rules: tableRules, type: 'billiard_pool' });
x = await price(tdb, local(MON, 10, 30), 60, false);
r.check('контроль: стол, остаток 60 минут = 600 ₽ по минутам (шаг 15)', x.minutes === 60 && x.amount_kopecks === 60000, `${x.minutes} мин, ${x.amount_kopecks}`);

// Н-2. Копеечная цена слота: движок по-прежнему считает 0 ₽ (округление до рубля, №44), но мастер и шаблон сети
// такой тариф больше не принимают (12-min-price-validation.mjs), а котировка и приём на ресепшене отклоняют 0 ₽
// (13-zero-amount-legacy.test.mjs). Тут — только факт: защита стоит выше движка.
const tiny = fakeDb({ rules: [rule('tiny', { from: '06:00', to: '06:00', perSlot: 49 })] });
x = await price(tiny, local(MON, 10, 0), 90);
r.check('движок на старом тарифе 49 коп.: 0 ₽ (защита выше — мастер, котировка, ресепшн)', x.amount_kopecks === 0, `${x.amount_kopecks} коп.`);
const tinyHourly = fakeDb({ rules: [{ ...tableRules[0], price_per_hour: 49 }], type: 'billiard_pool' });
x = await price(tinyHourly, local(MON, 10, 0), 60);
r.check('движок на старом тарифе стола 49 коп./ч: 0 ₽ (то же)', x.amount_kopecks === 0, `${x.amount_kopecks} коп.`);

r.done();
