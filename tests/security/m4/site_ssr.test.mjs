// PoC M4: сайт-агрегатор (web/site, SSR) — XSS через данные API, JSON-LD, OG-картинки, X-Forwarded-For.
//
// Выдержало: данные карточек, отзывов, турниров и рейтинга с разметкой (<img onerror>, </script>,
// "><svg onload>) экранируются Preact в HTML и < в JSON-LD; OG-SVG экранирует текст и обрезает
// длину (≤ 3 строки заголовка); IP гостя берётся из X-Forwarded-For только от SITE_TRUSTED_PROXIES,
// справа налево до первого недоверенного — подделка левых адресов не помогает.
//
// Запуск: node --test tests/security/m4/site_ssr.test.mjs   (без базы)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSite } from '../../../web/site/src/app.mjs';
import { loadConfig } from '../../../web/site/src/config.mjs';
import { createData } from '../../../web/site/src/data.mjs';
import { clientIp, parseCidrs } from '../../../web/site/src/net.mjs';
import { ogSvg } from '../../../web/site/src/og.mjs';
import * as mock from '../../../web/site/mock/api.mjs';

const XSS = '"><img src=x onerror=alert(1)></script><script>alert(2)</script><svg onload=alert(3)>';
const KEYS = new Set(['name', 'title', 'text', 'address', 'description', 'prize_text', 'nick', 'author_nick', 'hours_text', 'region', 'comment']);

function poison(v) {
  if (Array.isArray(v)) return v.map(poison);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' && KEYS.has(k) ? `${x}${XSS}` : poison(x)]));
  return v;
}

function poisonedSite() {
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const res = mock.handle({ method: init.method ?? 'GET', path: u.pathname, query: u.searchParams, body: init.body ? JSON.parse(init.body) : null, now: Date.now() });
    const body = JSON.stringify(poison(res.json));
    return { status: res.status, text: async () => body };
  };
  const cfg = loadConfig({ SITE_ORIGIN: 'https://billiardum.test', BL_API_URL: 'http://api' });
  const data = createData({ apiUrl: 'http://api', mock: false, fetchImpl });
  const handle = createSite({ cfg, data, mockApi: mock });
  return (url) => handle({ method: 'GET', url, headers: {} });
}

test('выдержало: SSR экранирует данные API на всех страницах; JSON-LD не закрывает <script>', async () => {
  const get = poisonedSite();
  const pages = ['/', '/ekaterinburg/', '/ekaterinburg/svoyak/', '/ekaterinburg/rezerv/', '/turniry/', '/turniry/22222222-2222-4222-8222-000000000001/', '/rejting/'];
  let checked = 0;
  for (const p of pages) {
    const r = await get(p);
    if (r.status !== 200) continue;
    checked += 1;
    const html = String(r.body);
    assert.ok(!html.includes('<img src=x'), `${p}: сырая <img>`);
    assert.ok(!html.includes('<svg onload'), `${p}: сырая <svg onload>`);
    assert.ok(!/<script>alert/.test(html), `${p}: сырой <script>`);
    for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      assert.ok(!m[1].includes('</'), `${p}: JSON-LD без </`);
      JSON.parse(m[1]);
    }
    assert.match(r.headers['content-security-policy'], /script-src 'self'/, `${p}: CSP без inline`);
  }
  assert.ok(checked >= 5, `проверено страниц: ${checked}`);
  // Payload реально дошёл до страниц (экранированным).
  const club = String((await get('/ekaterinburg/svoyak/')).body);
  assert.ok(club.includes('&lt;img src=x') || club.includes('&lt;/script&gt;'), 'полезная нагрузка видна как текст');
});

test('выдержало: OG-SVG экранирует текст и ограничивает длину', () => {
  const svg = ogSvg({ title: `${'Очень длинное название клуба '.repeat(200)}${XSS}`, subtitle: XSS.repeat(50), facts: [XSS, XSS, XSS], kicker: XSS });
  assert.ok(!svg.includes('<img') && !svg.includes('<script') && !svg.includes('<svg onload'));
  assert.ok(svg.length < 20_000, `размер SVG ${svg.length}`);
  assert.ok((svg.match(/font-family="Dela Gothic One" font-size="(58|68)"/g) ?? []).length <= 3, 'заголовок не больше 3 строк');
});

test('выдержало: IP гостя на сайте — подделка X-Forwarded-For не помогает', () => {
  const trusted = parseCidrs('10.231.47.8/29');
  // Прямо к сайту (не через Caddy) — заголовок игнорируется.
  assert.equal(clientIp('203.0.113.9', '1.1.1.1', trusted), '203.0.113.9');
  // Через Caddy: злоумышленник подставил адрес слева, Caddy дописал настоящий справа.
  assert.equal(clientIp('10.231.47.10', '10.231.47.9, 198.51.100.7', trusted), '198.51.100.7');
  assert.equal(clientIp('10.231.47.10', '1.2.3.4, 198.51.100.7', trusted), '198.51.100.7');
  // Мусор в цепочке — адрес сокета.
  assert.equal(clientIp('10.231.47.10', 'evil, 198.51.100.7', trusted), '198.51.100.7');
  assert.equal(clientIp('10.231.47.10', '198.51.100.7, evil', trusted), '10.231.47.10');
});
