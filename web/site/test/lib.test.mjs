import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyFilters, cityIn, daysLabel, disciplinesText, filtersQuery, hallLabel, hoursText, levelOf, parseFilters, planTotal, PLANS,
  priceGrid, publicTableState, seasonsList,
} from '../src/lib.mjs';

const clubs = [
  { name: 'Бета', status: 'platform', online_booking: true, open_24h: false, disciplines: ['pyramid', 'pool'], free_now: 2, price_from_kopecks: 45000, rating: { avg: 4.5, count: 2 } },
  { name: 'Альфа', status: 'platform', online_booking: true, open_24h: true, disciplines: ['pyramid'], free_now: 5, price_from_kopecks: 60000, rating: null },
  { name: 'Гамма', status: 'listed', online_booking: false, open_24h: false, disciplines: ['pool', 'snooker'], free_now: null, price_from_kopecks: 30000, rating: { avg: 5, count: 1 } },
  { name: 'Дельта', status: 'claimed', online_booking: false, open_24h: false, disciplines: ['pyramid'], free_now: null, price_from_kopecks: null, rating: null },
];
const names = (list) => list.map((c) => c.name);

test('фильтры из адреса: неизвестное отбрасывается, порядок в адресе один', () => {
  const f = parseFilters('d=pool&d=hack&d=pyramid&free=1&max=777&sort=evil&h=2');
  assert.deepEqual(f.d, ['pool', 'pyramid']);
  assert.equal(f.free, true);
  assert.equal(f.max, null);
  assert.equal(f.sort, 'recommended');
  assert.equal(f.h, 2);
  assert.equal(filtersQuery(f), '?d=pyramid&d=pool&free=1&h=2');
  assert.equal(filtersQuery(parseFilters('')), '');
});

test('каталог: дисциплины — все выбранные, «свободно сейчас» — только клубы на программе', () => {
  assert.deepEqual(names(applyFilters(clubs, parseFilters('d=pyramid&d=pool'))), ['Бета']);
  assert.deepEqual(names(applyFilters(clubs, parseFilters('d=pool'))), ['Бета', 'Гамма']);
  assert.deepEqual(names(applyFilters(clubs, parseFilters('free=1'))), ['Альфа', 'Бета']);
  assert.deepEqual(names(applyFilters(clubs, parseFilters('online=1&h24=1'))), ['Альфа']);
  assert.deepEqual(names(applyFilters(clubs, parseFilters('max=500'))), ['Бета', 'Гамма']);
});

test('каталог: сортировки', () => {
  assert.deepEqual(names(applyFilters(clubs, parseFilters(''))), ['Альфа', 'Бета', 'Гамма', 'Дельта']);
  assert.deepEqual(names(applyFilters(clubs, parseFilters('sort=price'))), ['Гамма', 'Бета', 'Альфа', 'Дельта']);
  assert.deepEqual(names(applyFilters(clubs, parseFilters('sort=rating'))), ['Гамма', 'Бета', 'Альфа', 'Дельта']);
  assert.deepEqual(names(applyFilters(clubs, parseFilters('sort=name'))), ['Альфа', 'Бета', 'Гамма', 'Дельта']);
});

test('сетка цен: столбцы по началу интервала, ночь после полуночи — после вечера, покрытие вечерним тарифом', () => {
  const g = priceGrid({
    type: 'pyramid',
    rules: [
      { days: [1, 2, 3, 4, 5], from: '17:00', to: '02:00', price_per_hour_kopecks: 70000 },
      { days: [1, 2, 3, 4, 5], from: '12:00', to: '17:00', price_per_hour_kopecks: 45000 },
      { days: [1, 2, 3, 4, 5], from: '02:00', to: '06:00', price_per_hour_kopecks: 50000 },
      { days: [6, 7], from: '12:00', to: '17:00', price_per_hour_kopecks: 60000 },
      { days: [7, 6], from: '17:00', to: '06:00', price_per_hour_kopecks: 80000 },
    ],
  });
  assert.equal(g.title, 'Русская пирамида');
  assert.deepEqual(g.cols.map((c) => c.label), ['12:00–17:00', 'с 17:00', '02:00–06:00']);
  assert.deepEqual(g.rows, [
    { label: 'Будни', cells: [45000, 70000, 50000] },
    { label: 'Выходные', cells: [60000, 80000, 80000] },
  ]);
});

test('дни недели словами', () => {
  assert.equal(daysLabel([1, 2, 3, 4, 5]), 'Будни');
  assert.equal(daysLabel([6, 7]), 'Выходные');
  assert.equal(daysLabel([7, 1, 2, 3, 4, 5, 6]), 'Каждый день');
  assert.equal(daysLabel([1, 2, 3, 4]), 'Пн–Чт');
  assert.equal(daysLabel([5]), 'Пт');
});

test('часы работы и дисциплины словами', () => {
  assert.deepEqual(hoursText({ open_24h: true, hours_text: 'что угодно' }), ['Круглосуточно']);
  assert.deepEqual(hoursText({ open_24h: false, hours_text: 'Ежедневно 12:00–04:00' }), ['Ежедневно 12:00–04:00']);
  assert.deepEqual(hoursText({ open_24h: false, hours_text: '' }), []);
  assert.equal(disciplinesText(['pyramid', 'pool', 'snooker']), 'Пирамида, пул, снукер');
});

test('город в предложном падеже: неразрывный пробел после предлога', () => {
  const nb = (s) => s.replace(/\u00a0/g, ' ');
  assert.equal(nb(cityIn('Екатеринбург')), 'в Екатеринбурге');
  assert.equal(nb(cityIn('Пермь')), 'в Перми');
  assert.equal(nb(cityIn('Уфа')), 'в Уфе');
  assert.equal(nb(cityIn('Владимир')), 'во Владимире');
  assert.equal(nb(cityIn('Волгоград')), 'в Волгограде');
  assert.equal(nb(cityIn('Сочи')), 'в Сочи');
  assert.equal(nb(cityIn('Нижний Новгород')), 'в Нижнем Новгороде');
  assert.equal(nb(cityIn('Новый Уренгой')), 'в городе Новый Уренгой');
  assert.match(cityIn('Тула'), /^в\u00a0/);
});

test('стол на плане: статус словами, подпись начинается с видимого текста', () => {
  const tz = 'Asia/Yekaterinburg';
  const busy = publicTableState({ number: 4, status: 'busy', until: '2026-10-23T16:40:00Z' }, tz);
  assert.equal(busy.tone, 'play');
  assert.equal(busy.lit, true);
  assert.equal(busy.word, 'До 21:40');
  assert.equal(hallLabel({ number: 4 }, busy), 'Стол 4 До 21:40, идёт игра до 21:40');
  const free = publicTableState({ number: 1, status: 'free' }, tz);
  assert.equal(free.tone, 'free');
  assert.equal(hallLabel({ number: 1 }, free), 'Стол 1 Свободен');
  assert.equal(publicTableState({ number: 2, status: 'unavailable' }, tz).word, 'Недоступен');
  assert.equal(publicTableState({ number: 3, status: 'reserved' }, tz).tone, 'reserved');
});

test('уровни Бильярдум+ по PRODUCT §13', () => {
  assert.equal(levelOf(1199), 'Новичок');
  assert.equal(levelOf(1200), 'Любитель');
  assert.equal(levelOf(1400), 'Опытный');
  assert.equal(levelOf(1799), 'Сильный');
  assert.equal(levelOf(1800), 'Мастер');
});

test('сезоны рейтинга: всё время и три последних месяца по Москве', () => {
  assert.deepEqual(seasonsList(Date.parse('2026-01-15T00:00:00Z')), ['all', '2026-01', '2025-12', '2025-11']);
  // 31 декабря 22:00 UTC — в Москве уже январь
  assert.equal(seasonsList(Date.parse('2026-12-31T22:00:00Z'))[1], '2027-01');
});

test('тарифы для клубов: цена за стол × число столов, в копейках', () => {
  assert.equal(planTotal(PLANS[0], 10), 790_000);
  assert.equal(planTotal(PLANS[1], 3), 357_000);
  assert.equal(planTotal(PLANS[0], 0), 79_000);
});
