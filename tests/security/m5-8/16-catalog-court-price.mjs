// PoC M5.8, заход 2 — Н-4: фильтр цены каталога при «только падел» берёт цену слота корта, а не часа стола (№221).
// Только чтение публичного API стенда (без входа). Клуб сида: стол от 500 ₽, корт от 2 400 ₽ за слот.
//   price_max=100000 (1 000 ₽) с disciplines=padel: клуб не должен проходить (цена корта 2 400 ₽ > 1 000 ₽);
//   price_max=300000: проходит; сортировка по цене и «свободно сейчас» считаются по кортам; мусорные значения — 400;
//   со смешанными дисциплинами (padel и стол) фильтр остаётся по столам (контроль: ничего не ломается).
//
// Запуск: node tests/security/m5-8/16-catalog-court-price.mjs

import { api, runner } from './lib.mjs';

const r = runner('M5.8 / 16: цена каталога по кортам');
const get = (q) => api('GET', `/api/public/cities/ekaterinburg?${q}`);
const seed = (res) => (res.json?.items ?? []).find((c) => c.name === 'Тестовый клуб');

const base = await get('disciplines=padel');
const club = seed(base);
r.check('в каталоге «только падел» есть клуб сида с кортами', Boolean(club && club.court_price_from_kopecks > 0), `${club?.court_price_from_kopecks}`);
const courtPrice = club?.court_price_from_kopecks ?? 0;
const tablePrice = club?.price_from_kopecks ?? 0;
r.check('цена стола ниже цены корта (проверка осмысленна)', tablePrice > 0 && tablePrice < courtPrice, `стол ${tablePrice} < корт ${courtPrice}`);

const cheap = await get(`disciplines=padel&price_max=${tablePrice + 1}`);
r.check('padel, price_max между ценой стола и корта: клуб отсечён (цена корта выше)', cheap.status === 200 && !seed(cheap), `status=${cheap.status} клубов=${cheap.json?.items?.length}`);
const edge = await get(`disciplines=padel&price_max=${courtPrice}`);
r.check('padel, price_max = цена корта: клуб проходит (граница включительно)', Boolean(seed(edge)));
const below = await get(`disciplines=padel&price_max=${courtPrice - 1}`);
r.check('padel, price_max = цена корта − 1 коп.: клуб не проходит', !seed(below));
const wide = await get(`disciplines=padel&price_max=${courtPrice * 10}`);
r.check('padel, большой price_max: клуб проходит', Boolean(seed(wide)));

// Смешанные дисциплины и без дисциплин: по-прежнему цена стола.
for (const q of ['disciplines=padel,pyramid', 'disciplines=pyramid', '']) {
  const x = await get(`${q}${q ? '&' : ''}price_max=${tablePrice + 1}`);
  r.check(`контроль «${q || 'без дисциплин'}», price_max по столу: клуб проходит`, x.status === 200 && Boolean(seed(x)), `status=${x.status}`);
}

// Сортировка по цене и «свободно сейчас» у padel.
const byPrice = await get('disciplines=padel&sort=price');
r.check('padel, sort=price: 200 и массив', byPrice.status === 200 && Array.isArray(byPrice.json?.items), `${byPrice.status}`);
const prices = (byPrice.json?.items ?? []).map((c) => c.court_price_from_kopecks ?? Infinity);
r.check('padel, sort=price: цены кортов по возрастанию', prices.every((p, i) => i === 0 || prices[i - 1] <= p), prices.join(','));
const free = await get('disciplines=padel&free_now=1');
r.check('padel, free_now: клуб с свободными кортами остаётся, фильтр по кортам', free.status === 200 && (free.json.items ?? []).every((c) => (c.courts_free_now ?? 0) > 0), `${free.json?.items?.map((c) => c.courts_free_now)}`);

// Мусор.
const junk = [];
for (const q of ['price_max=abc', 'price_max=-1', 'price_max=1e999', 'price_max=0', 'price_max=99999999999999999999', 'price_max[]=1', 'disciplines=padel&price_max=']) {
  const x = await get(q);
  junk.push(`${q}→${x.status}`);
}
r.check('мусорные price_max: нет 500', junk.every((j) => !j.endsWith('→500')), junk.join(' '));
r.done();
