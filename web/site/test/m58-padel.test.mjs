// M5.8 «Падел-корт» (№203–205, T48): фильтр «Падел», корты отдельно от столов, цена корта за слот, план зала
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyFilters, courtPriceText, filtersQuery, hallKey, hallLabel, padelOnly, parseFilters, priceGrid, publicTableState } from '../src/lib.mjs';
import { site } from './helpers.mjs';

const CLUBS = [
  { name: 'Бильярд', status: 'platform', online_booking: true, disciplines: ['pyramid'], free_now: 3, courts_free_now: null, price_from_kopecks: 40000 },
  { name: 'Сетка', status: 'platform', online_booking: true, disciplines: ['pyramid', 'padel'], free_now: 0, courts_free_now: 1, price_from_kopecks: 45000 },
  { name: 'Падел-клуб', status: 'platform', online_booking: true, disciplines: ['padel'], free_now: 0, courts_free_now: 0, price_from_kopecks: null },
];

test('фильтр «Падел»: из адреса, обратно в адрес, только клубы с кортами; «свободно сейчас» — по кортам', () => {
  const f = parseFilters('?d=padel&free=1');
  assert.deepEqual(f.d, ['padel']);
  assert.equal(padelOnly(f), true);
  assert.equal(filtersQuery(f), '?d=padel&free=1');
  assert.deepEqual(applyFilters(CLUBS, parseFilters('?d=padel')).map((c) => c.name).sort(), ['Падел-клуб', 'Сетка']);
  assert.deepEqual(applyFilters(CLUBS, f).map((c) => c.name), ['Сетка'], 'свободный корт только в «Сетке»');
  // С пирамидой — «свободно сейчас» по столам, как раньше
  assert.deepEqual(applyFilters(CLUBS, parseFilters('?d=pyramid&free=1')).map((c) => c.name), ['Бильярд']);
  assert.equal(padelOnly(parseFilters('?d=padel&d=pyramid')), false);
});

test('цена корта — за слот, сетка цен корта — цены слота', () => {
  assert.equal(courtPriceText({ court_price_from_kopecks: 240000, slot_minutes: 90 }), 'от 2\u00a0400\u00a0₽ за 1,5\u00a0ч');
  assert.equal(courtPriceText({ court_price_from_kopecks: null, slot_minutes: null }), null);
  const g = priceGrid({
    type: 'padel',
    rules: [
      { days: [1, 2, 3, 4, 5], from: '06:00', to: '17:00', price_per_hour_kopecks: 160000, price_per_slot_kopecks: 240000, slot_minutes: 90 },
      { days: [1, 2, 3, 4, 5], from: '17:00', to: '06:00', price_per_hour_kopecks: 240000, price_per_slot_kopecks: 360000, slot_minutes: 90 },
    ],
  });
  assert.equal(g.title, 'Падел');
  assert.equal(g.slot_minutes, 90);
  assert.deepEqual(g.rows[0].cells, [240000, 360000]);
});

test('корт на плане: «Корт 1», свой ключ — номера столов и кортов не путаются', () => {
  const court = { number: 1, family: 'court', status: 'free' };
  const st = publicTableState(court, 'Asia/Yekaterinburg');
  assert.equal(hallLabel(court, st), 'Корт 1 Свободен');
  assert.equal(hallKey(court), 'court-1');
  assert.equal(hallKey({ number: 1, type: 'billiard_pool' }), 'table-1');
});

test('сайт: город с фильтром «Падел», клуб с кортами — план, цены за слот, бронь корта', async () => {
  const { get } = site();
  const city = await get('/perm/?d=padel');
  assert.equal(city.status, 200);
  assert.match(city.body, /<input type="checkbox" name="d" value="padel" checked/);
  assert.match(city.body, />Сетка</);
  assert.match(city.body, /2 корта/);
  assert.match(city.body, /Падел: от 2\u00a0400\u00a0₽ за 1,5\u00a0ч/);
  assert.match(city.body, /<link rel="canonical" href="https:\/\/billiardum\.test\/perm\/">/, 'канонический адрес фильтров — страница города');
  assert.match((await get('/ekaterinburg/?d=padel')).body, /Ничего не нашлось/, 'в Екатеринбурге кортов нет');

  const club = await get('/perm/setka/');
  assert.equal(club.status, 200);
  assert.match(club.body, /4 стола, 2 корта для падела/);
  assert.match(club.body, /Забронировать стол или корт/);
  assert.match(club.body, />Падел-корты</);
  assert.match(club.body, /data-n="court-1"/);
  assert.match(club.body, /data-n="table-1"/);
  assert.match(club.body, /class="ta ta--court"/);
  assert.match(club.body, /\/app\/book\/cccccccc-cccc-4ccc-8ccc-000000000007\?family=court/);
  assert.match(club.body, /Падел, ₽ за 1,5\u00a0ч/);
  assert.match(club.body, /aria-label="Корт 1 /);
  assert.doesNotMatch(club.body, /Стол 5/, 'корты не нумеруются как столы');
});
