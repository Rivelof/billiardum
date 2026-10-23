import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLUB_PLATFORM, CLUB_REQUEST, T_LIVE, jsonld, site } from './helpers.mjs';

const byType = (list, type) => list.find((x) => x['@type'] === type);

test('главная: Organization и WebSite', async () => {
  const ld = jsonld((await site().get('/')).body);
  assert.equal(byType(ld, 'Organization').name, 'Бильярдум');
  assert.equal(byType(ld, 'WebSite').inLanguage, 'ru-RU');
  for (const x of ld) assert.equal(x['@context'], 'https://schema.org');
});

test('клуб: SportsActivityLocation с адресом и оценкой, BreadcrumbList', async () => {
  const ld = jsonld((await site().get(CLUB_PLATFORM)).body);
  const club = byType(ld, 'SportsActivityLocation');
  assert.equal(club.name, 'Свояк');
  assert.equal(club.url, 'https://billiardum.test/ekaterinburg/svoyak/');
  assert.deepEqual(club.address, { '@type': 'PostalAddress', streetAddress: 'ул. Малышева, 51', addressLocality: 'Екатеринбург', addressCountry: 'RU', addressRegion: 'Свердловская область' });
  assert.equal(club.aggregateRating.reviewCount, 2);
  assert.equal(club.geo['@type'], 'GeoCoordinates');
  assert.match(club.priceRange, /^от \d+ ₽ в час$/);
  const crumbs = byType(ld, 'BreadcrumbList');
  assert.deepEqual(crumbs.itemListElement.map((i) => [i.position, i.name, i.item]), [
    [1, 'Главная', 'https://billiardum.test/'],
    [2, 'Екатеринбург', 'https://billiardum.test/ekaterinburg/'],
    [3, 'Свояк', 'https://billiardum.test/ekaterinburg/svoyak/'],
  ]);
});

test('клуб без отзывов: без aggregateRating; круглосуточный — часы работы', async () => {
  const listed = byType(jsonld((await site().get(CLUB_REQUEST)).body), 'SportsActivityLocation');
  assert.equal(listed.aggregateRating, undefined);
  const h24 = byType(jsonld((await site().get('/ekaterinburg/abrikol/')).body), 'SportsActivityLocation');
  assert.equal(h24.openingHoursSpecification[0].dayOfWeek.length, 7);
});

test('турнир: SportsEvent с местом, организатором и взносом', async () => {
  const ev = byType(jsonld((await site().get(T_LIVE)).body), 'SportsEvent');
  assert.equal(ev.name, 'Кубок «Свояка»: свободная пирамида');
  assert.equal(ev.sport, 'Русская пирамида');
  assert.equal(ev.location.url, 'https://billiardum.test/ekaterinburg/svoyak/');
  assert.equal(ev.offers.priceCurrency, 'RUB');
  assert.equal(ev.offers.price, '1000.00');
  assert.equal(ev.eventAttendanceMode, 'https://schema.org/OfflineEventAttendanceMode');
  assert.match(ev.startDate, /^\d{4}-\d{2}-\d{2}T/);
});

test('город: ItemList клубов и FAQPage на «Для клубов»', async () => {
  const list = byType(jsonld((await site().get('/ekaterinburg/')).body), 'ItemList');
  assert.equal(list.itemListElement.length, 5);
  assert.match(list.name, /Екатеринбурге/);
  const faq = byType(jsonld((await site().get('/dlya-klubov/')).body), 'FAQPage');
  assert.ok(faq.mainEntity.length >= 5);
});

test('JSON-LD не закрывает <script>: «</» экранируется', async () => {
  const h = (await site().get('/')).body;
  for (const m of h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) assert.doesNotMatch(m[1], /<\//);
});

test('sitemap.xml по данным API: статические страницы, города, клубы, турниры, статьи', async () => {
  const r = await site().get('/sitemap.xml');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /application\/xml/);
  const locs = [...r.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  for (const p of ['/', '/turniry/', '/rejting/', '/plus/', '/dlya-klubov/', '/dlya-biznesa/', '/zhurnal/', '/ekaterinburg/', '/chelyabinsk/', '/ekaterinburg/svoyak/', '/ekaterinburg/rezerv/', '/chelyabinsk/kiy/', '/turniry/22222222-2222-4222-8222-000000000001/', '/zhurnal/kak-igrat-po-qr/']) {
    assert.ok(locs.includes(`https://billiardum.test${p}`), p);
  }
  assert.equal(new Set(locs).size, locs.length, 'без повторов');
});

test('robots.txt: служебные разделы закрыты, sitemap указан; стенд — закрыт целиком', async () => {
  const r = (await site().get('/robots.txt')).body;
  for (const p of ['/app/', '/club/', '/api/', '/pay/', '/t/']) assert.match(r, new RegExp(`Disallow: ${p.replace(/\//g, '\\/')}`));
  assert.match(r, /Sitemap: https:\/\/billiardum\.test\/sitemap\.xml/);
  const stand = site({ env: { BL_SITE_NOINDEX: '1' } });
  assert.equal((await stand.get('/robots.txt')).body, 'User-agent: *\nDisallow: /\n');
  assert.match((await stand.get('/')).body, /<meta name="robots" content="noindex, nofollow">/);
});
