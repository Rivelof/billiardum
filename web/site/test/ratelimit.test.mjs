// M4-6: лимит сайта по IP гостя. Сайт ходит в API из доверенной сети без лимита API — ограничивает сам:
// около 120 походов в API в минуту с IP (IPv6 — по /64), статика и страницы из кэша не считаются,
// превышение — 429 со страницей сайта и Retry-After; 404 кэшируются ненадолго отдельно от живых страниц.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createSite } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { createData } from '../src/data.mjs';
import { createRateLimiter, rateKey } from '../src/ratelimit.mjs';
import { startServer } from '../server.mjs';

/** Поддельный API: города и турниры — пусто, клуб «svoyak» есть, остальное — 404. */
function api(calls = []) {
  return async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === '/api/public/cities' || path === '/api/public/tournaments') return new Response('{"items":[]}', { status: 200 });
    if (path === '/api/public/cities/ekaterinburg') return new Response(JSON.stringify({ city: { slug: 'ekaterinburg', name: 'Екатеринбург', timezone: 'Asia/Yekaterinburg' }, items: [] }), { status: 200 });
    if (path === '/api/public/clubs/ekaterinburg/svoyak') {
      return new Response(JSON.stringify({ club: { id: 'x', slug: 'svoyak', name: 'Свояк', status: 'listed', address: 'ул. Ленина, 1', city: { slug: 'ekaterinburg', name: 'Екатеринбург', timezone: 'Asia/Yekaterinburg' } } }), { status: 200 });
    }
    return new Response('{"error":"not_found"}', { status: 404 });
  };
}

function siteWith({ perMinute = 120, clock = () => 0, env = {} } = {}) {
  const calls = [];
  const cfg = loadConfig({ SITE_ORIGIN: 'https://billiardum.test', BL_API_URL: 'http://api', ...env });
  const data = createData({ apiUrl: 'http://api', mock: false, fetchImpl: api(calls), now: clock });
  const limiter = perMinute > 0 ? createRateLimiter({ perMinute, now: clock }) : null;
  const handle = createSite({ cfg, data, limiter, now: clock });
  const get = (url, ip, headers = {}) => handle({ method: 'GET', url, headers: { accept: 'text/html', ...headers }, ip });
  return { calls, get, handle };
}

test('ключ лимита: IPv4 — адрес, IPv6 — подсеть /64, IPv4-mapped — как IPv4', () => {
  assert.equal(rateKey('203.0.113.7'), '203.0.113.7');
  assert.equal(rateKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(rateKey('2001:db8:1:2::1'), rateKey('2001:db8:1:2:ffff:eeee:dddd:9'));
  assert.equal(rateKey('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.notEqual(rateKey('2001:db8:1:2::1'), rateKey('2001:db8:1:3::1'));
  assert.equal(rateKey(null), 'unknown');
  assert.equal(rateKey('мусор'), 'unknown');
});

test('ведро: 120 запросов подряд, 121-й — отказ с Retry-After; за полминуты набирается ещё 60', () => {
  let t = 0;
  const l = createRateLimiter({ perMinute: 120, now: () => t });
  for (let i = 0; i < 120; i += 1) assert.ok(l.take('a').ok, `запрос ${i + 1}`);
  const no = l.take('a');
  assert.equal(no.ok, false);
  assert.equal(no.retryAfter, 1, '2 жетона в секунду — следующий через секунду');
  assert.ok(l.take('b').ok, 'другой гость не страдает');
  t = 30_000;
  let n = 0;
  while (l.take('a').ok) n += 1;
  assert.equal(n, 60);
  // Ровный поток 2 запроса в секунду проходит бесконечно
  for (let i = 0; i < 300; i += 1) {
    t += 500;
    assert.ok(l.take('a').ok);
  }
});

test('память ограничена: тысячи адресов не раздувают таблицу вёдер', () => {
  let t = 0;
  const l = createRateLimiter({ perMinute: 120, now: () => t, maxKeys: 1000 });
  for (let i = 0; i < 5000; i += 1) {
    t += 1;
    l.take(`k${i}`);
  }
  assert.ok(l.size() <= 1000, String(l.size()));
});

test('PoC M4-6: 130 новых адресов клуба с одного IP — первые 120 доходят до API, дальше 429 со страницей сайта', async () => {
  const s = siteWith();
  const codes = {};
  let limited = null;
  for (let i = 0; i < 130; i += 1) {
    const r = await s.get(`/ekaterinburg/pentest-${i}/`, '203.0.113.10');
    codes[r.status] = (codes[r.status] ?? 0) + 1;
    if (r.status === 429) limited ??= r;
  }
  assert.equal(codes[404], 120);
  assert.equal(codes[429], 10);
  const clubCalls = s.calls.filter((p) => p.startsWith('/api/public/clubs/')).length;
  assert.equal(clubCalls, 120, 'после лимита в API не ходим');
  // 429 — страница сайта: язык, заголовок, тема, без кэша, с Retry-After
  assert.equal(limited.headers['retry-after'], '1');
  assert.equal(limited.headers['cache-control'], 'no-store');
  assert.match(limited.headers['content-type'], /text\/html/);
  assert.match(limited.body, /^<!doctype html>\n<html lang="ru">/);
  assert.match(limited.body, /Слишком много запросов с вашего адреса/);
  assert.match(limited.body, /Подождите 1 секунду и обновите страницу/);
  assert.match(limited.body, /<meta name="robots" content="noindex, nofollow">/);
  assert.equal((limited.body.match(/<h1[\s>]/g) ?? []).length, 1);
  assert.match(limited.headers['content-security-policy'], /default-src/);
  // Другой гость — как обычно
  assert.equal((await s.get('/ekaterinburg/pentest-x/', '198.51.100.20')).status, 404);
});

test('IPv6: адреса одной /64 делят лимит, соседняя /64 — нет', async () => {
  const s = siteWith({ perMinute: 3 });
  for (let i = 0; i < 3; i += 1) assert.equal((await s.get(`/ekaterinburg/v6-${i}/`, `2001:db8:5:6::${i + 1}`)).status, 404);
  assert.equal((await s.get('/ekaterinburg/v6-x/', '2001:db8:5:6:abcd::99')).status, 429);
  assert.equal((await s.get('/ekaterinburg/v6-y/', '2001:db8:5:7::1')).status, 404);
});

test('страницы из кэша не считаются: после лимита закэшированный клуб и повтор 404 открываются', async () => {
  const s = siteWith({ perMinute: 3 });
  const ip = '203.0.113.30';
  assert.equal((await s.get('/ekaterinburg/svoyak/', ip)).status, 200);
  assert.equal((await s.get('/ekaterinburg/net-1/', ip)).status, 404);
  assert.equal((await s.get('/ekaterinburg/net-2/', ip)).status, 404);
  assert.equal((await s.get('/ekaterinburg/net-3/', ip)).status, 429, 'новый адрес — поход в API, жетонов нет');
  const before = s.calls.length;
  assert.equal((await s.get('/ekaterinburg/svoyak/', ip)).status, 200, 'клуб из кэша');
  assert.equal((await s.get('/ekaterinburg/net-1/', ip)).status, 404, '404 из кэша');
  assert.equal((await s.get('/zhurnal/', ip)).status, 200, 'журнал без API');
  assert.equal((await s.get('/robots.txt', ip)).status, 200);
  assert.equal(s.calls.length, before, 'в API не ходили');
});

test('одна страница — один жетон, сколько бы запросов в API она ни сделала', async () => {
  const s = siteWith({ perMinute: 2 });
  const ip = '203.0.113.40';
  // Клуб: карточка клуба, город, турниры — несколько промахов кэша за один запрос
  assert.equal((await s.get('/ekaterinburg/svoyak/', ip)).status, 200);
  assert.ok(s.calls.length >= 2, `запросов в API: ${s.calls.length}`);
  assert.equal((await s.get('/ekaterinburg/net-1/', ip)).status, 404);
  assert.equal((await s.get('/ekaterinburg/net-2/', ip)).status, 429);
});

test('OG-картинка нового клуба — поход в API и жетон; заявка с JS после лимита — 429 в JSON', async () => {
  const s = siteWith({ perMinute: 2 });
  const ip = '203.0.113.50';
  assert.equal((await s.get('/og/club/ekaterinburg/svoyak.png', ip)).status, 200);
  assert.equal((await s.get('/og/club/ekaterinburg/net-1.png', ip)).status, 404);
  const r = await s.get('/og/club/ekaterinburg/net-2.png', ip);
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers['retry-after']) >= 1);
  assert.equal((await s.get('/og/club/ekaterinburg/svoyak.png', ip)).status, 200, 'картинка по данным из кэша');
  const lead = await s.handle({
    method: 'POST',
    url: '/dlya-klubov/zayavka/',
    headers: { accept: 'application/json' },
    body: new URLSearchParams({ name: 'Иван', club_name: 'Клуб', city: 'Пермь', phone: '+7 900 000-00-00', consent: '1' }).toString(),
    ip,
  });
  assert.equal(lead.status, 429);
  assert.equal(lead.headers['retry-after'] !== undefined, true);
  assert.equal(JSON.parse(lead.body).ok, false);
  assert.match(JSON.parse(lead.body).message, /Подождите минуту/);
});

test('404 кэшируются ненадолго (30 с) и не вытесняют живые страницы; HTTP-кэш 404 — 30 с', async () => {
  let t = 0;
  const calls = [];
  const data = createData({ apiUrl: 'http://api', mock: false, fetchImpl: api(calls), now: () => t });
  assert.ok(await data.get('/api/public/clubs/ekaterinburg/svoyak'));
  for (let i = 0; i < 3000; i += 1) assert.equal(await data.get(`/api/public/clubs/ekaterinburg/n${i}`), null);
  const n = calls.length;
  assert.ok(await data.get('/api/public/clubs/ekaterinburg/svoyak'), 'живая страница осталась в кэше');
  assert.equal(await data.get('/api/public/clubs/ekaterinburg/n2999'), null);
  assert.equal(calls.length, n, '404 из кэша');
  t = 30_000;
  assert.equal(await data.get('/api/public/clubs/ekaterinburg/n2999'), null);
  assert.equal(calls.length, n + 1, 'через 30 с — снова в API');

  const s = siteWith();
  const r = await s.get('/ekaterinburg/net-kluba/', '203.0.113.60');
  assert.equal(r.status, 404);
  assert.equal(r.headers['cache-control'], 'public, max-age=30');
  assert.equal((await s.get('/og/club/ekaterinburg/net.png', '203.0.113.60')).headers['cache-control'], 'public, max-age=30');
});

test('лимит из настроек: BL_SITE_RATE_PER_MIN (по умолчанию 120), 0 — без лимита', async () => {
  assert.equal(loadConfig({}).ratePerMinute, 120);
  assert.equal(loadConfig({ BL_SITE_RATE_PER_MIN: 'много' }).ratePerMinute, 120);
  assert.equal(loadConfig({ BL_SITE_RATE_PER_MIN: '0' }).ratePerMinute, 0);
  const run = async (rate) => {
    const cfg = loadConfig({ SITE_ORIGIN: 'https://billiardum.test', BL_API_URL: 'http://api', BL_SITE_RATE_PER_MIN: rate });
    const handle = createSite({ cfg, data: createData({ apiUrl: 'http://api', mock: false, fetchImpl: api() }) });
    const codes = new Set();
    for (let i = 0; i < 5; i += 1) codes.add((await handle({ method: 'GET', url: `/ekaterinburg/cfg-${i}/`, ip: '203.0.113.80' })).status);
    return [...codes].sort();
  };
  assert.deepEqual(await run('3'), [404, 429]);
  assert.deepEqual(await run('0'), [404]);
});

test('сервер: IP гостя — из X-Forwarded-For доверенного прокси; статика и /health без лимита', async () => {
  const cfg = { ...loadConfig({ BL_SITE_RATE_PER_MIN: '2', SITE_TRUSTED_PROXIES: '127.0.0.1/32,::1/128' }), port: 0 };
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  const server = startServer(cfg);
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (path, xff) => {
      const r = await fetch(base + path, { headers: { accept: 'text/html', ...(xff ? { 'x-forwarded-for': xff } : {}) } });
      await r.arrayBuffer();
      return r;
    };
    assert.equal((await get('/ekaterinburg/srv-1/', '203.0.113.70')).status, 404);
    assert.equal((await get('/ekaterinburg/srv-2/', '203.0.113.70')).status, 404);
    const r = await get('/ekaterinburg/srv-3/', '203.0.113.70');
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    // Подделанный левый адрес в цепочке не помогает: берётся первый недоверенный справа
    assert.equal((await get('/ekaterinburg/srv-4/', '1.2.3.4, 203.0.113.70')).status, 429);
    // Другой гость за тем же прокси
    assert.equal((await get('/ekaterinburg/srv-5/', '198.51.100.70')).status, 404);
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await get('/favicon.svg', '203.0.113.70')).status, 200);
      assert.equal((await get('/health', '203.0.113.70')).status, 200);
    }
  } finally {
    console.log = log;
    console.warn = warn;
    server.close();
  }
});
