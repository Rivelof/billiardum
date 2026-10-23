import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLUB_PLATFORM, CLUB_REQUEST, T_LIVE, mock, site } from './helpers.mjs';

const PAGES = ['/', '/ekaterinburg/', CLUB_PLATFORM, CLUB_REQUEST, '/turniry/', T_LIVE, '/rejting/', '/plus/', '/dlya-klubov/', '/dlya-biznesa/', '/zhurnal/', '/zhurnal/kak-igrat-po-qr/'];

test('все страницы §15 отдаются готовым HTML: lang=ru, один h1, канонический адрес, мета, OG', async () => {
  const { get } = site();
  for (const path of PAGES) {
    const r = await get(path);
    assert.equal(r.status, 200, path);
    assert.match(r.headers['content-type'], /text\/html/);
    const h = r.body;
    assert.match(h, /^<!doctype html>\n<html lang="ru">/, path);
    assert.equal((h.match(/<h1[\s>]/g) ?? []).length, 1, `${path}: один h1`);
    const canonical = new URL(path, 'https://billiardum.test').pathname;
    assert.ok(h.includes(`<link rel="canonical" href="https://billiardum.test${canonical}">`), `${path}: canonical`);
    assert.match(h, /<meta name="description" content="[^"]{20,}">/, path);
    assert.match(h, /<meta property="og:image" content="https:\/\/billiardum\.test\/og\/[^"]+\.png">/, path);
    assert.match(h, /<title>[^<]+<\/title>/);
    assert.doesNotMatch(h, /fonts\.googleapis|fonts\.gstatic|cdn\.|mc\.yandex|facebook|connect\.facebook/, `${path}: внешних ресурсов нет`);
    assert.doesNotMatch(h, / style="/, `${path}: без атрибутов style (CSP)`);
  }
});

test('CSP: без unsafe-inline, встроенные стиль и тема по хешам; тёмная тема по умолчанию', async () => {
  const { get } = site();
  const r = await get('/');
  const csp = r.headers['content-security-policy'];
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.match(csp, /style-src 'self' 'sha256-/);
  assert.match(csp, /script-src 'self' 'sha256-/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(r.body, /<html[^>]+data-theme/);
  assert.match(r.body, /localStorage\.getItem\('bl-theme'\)==='light'/);
});

test('заглушка видна: на демо-данных — плашка, в проде её нет', async () => {
  assert.match((await site().get('/')).body, /Демо-данные заглушки/);
  const empty = site({ fetchImpl: fakeApi({}) });
  assert.doesNotMatch((await empty.get('/')).body, /Демо-данные/);
});

test('404: неизвестный город, клуб, турнир, статья и мусор в адресе', async () => {
  const { get } = site();
  for (const p of ['/moskva/', '/ekaterinburg/net-kluba/', '/turniry/00000000-0000-4000-8000-000000000000/', '/turniry/abc/', '/zhurnal/net-stati/', '/a/b/c/', '/Ekaterinburg/']) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    assert.match(r.body, /Такой страницы нет/);
    assert.match(r.body, /<meta name="robots" content="noindex, nofollow">/);
  }
});

test('адрес без косой черты → 301, /t/{код} → приложение, неверный код → 404', async () => {
  const { get } = site();
  const a = await get('/ekaterinburg?d=pool');
  assert.equal(a.status, 301);
  assert.equal(a.headers.location, '/ekaterinburg/?d=pool');
  const t = await get('/t/abcdefghjk');
  assert.equal(t.status, 302);
  assert.equal(t.headers.location, '/app/t/ABCDEFGHJK');
  assert.equal((await get('/t/ABC')).status, 404);
  assert.equal((await get('/t/ABCDEFGHIK')).status, 404, 'I не бывает в коде');
});

test('фильтры каталога работают без JS: обычная форма GET и ответ сервера', async () => {
  const { get } = site();
  const all = (await get('/ekaterinburg/')).body;
  assert.match(all, /<form class="filters" method="get" action="\/ekaterinburg\/"/);
  assert.match(all, /Найдено 5 клубов/);
  const pool = (await get('/ekaterinburg/?d=pool')).body;
  assert.match(pool, /Найдено 3 клуба/);
  assert.match(pool, /<input type="checkbox" name="d" value="pool" checked/);
  assert.doesNotMatch(pool, />Абриколь</, 'в Абриколе только пирамида');
  const h24 = (await get('/ekaterinburg/?h24=1')).body;
  assert.match(h24, /Найдено 1 клуб</);
  assert.match(h24, />Абриколь</);
  assert.match(h24, /Сбросить фильтры/);
  const listed = (await get('/ekaterinburg/?d=snooker&d=pool&max=500')).body;
  assert.match(listed, /Дуплет/);
  const priced = (await get('/ekaterinburg/?sort=name&h=2')).body;
  assert.match(priced, /2 часа от/);
  const order = [...priced.matchAll(/class="club-row__name"><a href="[^"]+">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(order, [...order].sort((a, b) => a.localeCompare(b, 'ru')));
  // канонический адрес фильтров — страница города
  assert.match(pool, /<link rel="canonical" href="https:\/\/billiardum\.test\/ekaterinburg\/">/);
});

test('клуб на программе: план зала со статусами словами и бронь в приложении', async () => {
  const r = await site().get(CLUB_PLATFORM);
  const h = r.body;
  assert.match(h, /data-hall="true" data-src="\/api\/public\/clubs\/ekaterinburg\/svoyak"/);
  assert.equal((h.match(/class="plan-cell"/g) ?? []).length, 10);
  assert.match(h, /aria-label="Стол 1 [^"]+\. Забронировать"/);
  assert.match(h, /href="\/app\/book\/cccccccc-cccc-4ccc-8ccc-000000000001"/);
  assert.match(h, /<table class="ptable">/);
  assert.match(h, /Будни/);
  assert.match(h, /Отзывы/);
  assert.match(r.headers['set-cookie'], /^bl-city=ekaterinburg; Path=\/;/);
});

test('клуб без программы: «Бронь по заявке» ведёт в приложение, плана зала и отзывов нет', async () => {
  const h = (await site().get(CLUB_REQUEST)).body;
  assert.match(h, /Бронь по заявке/);
  assert.match(h, /href="\/app\/request\/11111111-1111-4111-8111-000000000004"/);
  assert.doesNotMatch(h, /data-hall/);
  assert.doesNotMatch(h, /\/app\/book\//);
});

test('турнир: сетка, матч в эфире на счётах, запись в приложении', async () => {
  const { get } = site();
  const h = (await get(T_LIVE)).body;
  assert.match(h, /class="bracket scroll-x"/);
  assert.match(h, /Четвертьфинал/);
  assert.match(h, /class="abacus"/);
  assert.match(h, /В эфире/);
  const reg = (await get('/turniry/22222222-2222-4222-8222-000000000002/')).body;
  assert.match(reg, /href="\/app\/tournaments\/22222222-2222-4222-8222-000000000002"/);
  assert.match(reg, /рейтинг до 1600|до 1600/);
});

test('рейтинг: фильтры формой GET, места 1–3 — шары с номером', async () => {
  const { get } = site();
  const h = (await get('/rejting/?discipline=pool&scope=city&city=ekaterinburg')).body;
  assert.match(h, /<form class="rfilters" method="get" action="\/rejting\/"/);
  assert.match(h, /<option value="city" selected>/);
  assert.match(h, /role="img" aria-label="1 место"/);
  assert.match(h, /aria-current="page">Пул</);
  const club = (await get('/rejting/?scope=club&city=ekaterinburg&club=svoyak')).body;
  assert.match(club, /клуб «Свояк»/);
});

test('журнал: в проде без статей — пустое состояние и noindex; демо-статьи только на заглушке', async () => {
  const prod = site({ fetchImpl: fakeApi({}) });
  const h = (await prod.get('/zhurnal/')).body;
  assert.match(h, /Статей пока нет/);
  assert.match(h, /noindex/);
  assert.equal((await prod.get('/zhurnal/kak-igrat-po-qr/')).status, 404);
  const demo = (await site().get('/zhurnal/kak-igrat-po-qr/')).body;
  assert.match(demo, /<ol><li>Отсканируйте QR-код/);
});

test('прод без клубов: пустые состояния, без выдуманных клубов и цифр', async () => {
  const { get } = site({ fetchImpl: fakeApi({}) });
  const home = (await get('/')).body;
  assert.match(home, /Каталог наполняется/);
  assert.match(home, /Турниров пока нет/);
  assert.doesNotMatch(home, /Свояк|Абриколь|Карамболь/);
  assert.match((await get('/turniry/')).body, /Турниров пока нет/);
  assert.match((await get('/rejting/')).body, /В этой таблице пока никого/);
});

test('API не отвечает: 503 со страницей «попробуйте через минуту»', async () => {
  const { get } = site({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  const r = await get('/');
  assert.equal(r.status, 503);
  assert.equal(r.headers['retry-after'], '60');
  assert.match(r.body, /Сервер клубов сейчас не отвечает/);
});

test('заявка клуба без JS: 303 на «спасибо», ошибка — та же страница с объяснением; с JS — JSON', async () => {
  const { post, get } = site({ now: () => 1_800_000_000_000 });
  const before = mock.sent.leads.length;
  const form = 'name=Иван&club_name=Свояк&city=Пермь&phone=%2B7+900+000-00-00&tables_count=8&consent=1&website=&t=1799999990000';
  const ok = await post('/dlya-klubov/zayavka/', form);
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.location, '/dlya-klubov/?zayavka=ok#zayavka');
  assert.equal(mock.sent.leads.length, before + 1);
  assert.match(mock.sent.leads.at(-1).phone, /\*\*\*$/, 'телефон в заглушке маскируется');
  assert.match((await get('/dlya-klubov/?zayavka=ok')).body, /Заявка у нас/);

  const noConsent = await post('/dlya-klubov/zayavka/', form.replace('&consent=1', ''));
  assert.equal(noConsent.status, 422);
  assert.match(noConsent.body, /Отметьте согласие/);
  assert.match(noConsent.body, /value="Иван"/, 'введённое не теряется');

  const json = await post('/dlya-klubov/zayavka/', form.replace('phone=%2B7+900+000-00-00', 'phone=12'), { accept: 'application/json' });
  assert.equal(json.status, 422);
  assert.equal(JSON.parse(json.body).ok, false);

  const bot = await post('/dlya-klubov/zayavka/', form.replace('website=', 'website=spam'), { accept: 'application/json' });
  assert.equal(JSON.parse(bot.body).ok, true);
  assert.equal(mock.sent.leads.length, before + 1, 'скрытое поле — в API не уходит');
});

test('заявка уходит в API с IP гостя и полями контракта', async () => {
  const calls = [];
  const { post } = site({ fetchImpl: fakeApi({}, calls), now: () => 1_800_000_000_000 });
  await post('/dlya-klubov/zayavka/', 'name=Иван&club_name=Клуб&city=Пермь&phone=%2B79000000000&consent=1&t=1799999990000');
  const call = calls.find((c) => c.url.endsWith('/api/leads'));
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['x-forwarded-for'], '203.0.113.5');
  assert.deepEqual(JSON.parse(call.init.body), { name: 'Иван', club_name: 'Клуб', city: 'Пермь', phone: '+79000000000', consent: true, website: '', elapsed_ms: 10000 });
});

test('Яндекс Метрика — только если задан номер, без Вебвизора; CSP открывает только mc.yandex.ru', async () => {
  const off = await site().get('/');
  assert.doesNotMatch(off.body, /metrika/);
  const on = await site({ env: { YANDEX_METRIKA_ID: '12345678' } }).get('/');
  assert.match(on.body, /mc\.yandex\.ru\/metrika\/tag\.js/);
  assert.match(on.body, /webvisor:false/);
  assert.match(on.headers['content-security-policy'], /script-src 'self' 'sha256-[^']+' 'sha256-[^']+' https:\/\/mc\.yandex\.ru/);
  const bad = await site({ env: { YANDEX_METRIKA_ID: '1;alert(1)' } }).get('/');
  assert.doesNotMatch(bad.body, /metrika/);
});

/** Поддельный API: пустой каталог или заданные ответы; calls — журнал запросов. */
export function fakeApi(responses, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    let body = responses[path];
    if (body === undefined) {
      if (path === '/api/public/cities' || path === '/api/public/tournaments') body = { items: [] };
      else if (path === '/api/public/rating') body = { items: [], me: null };
      else if (path === '/api/leads') return new Response(JSON.stringify({ ok: true }), { status: 201 });
      else return new Response('{"error":"not_found"}', { status: 404 });
    }
    return new Response(JSON.stringify(body), { status: 200 });
  };
}
