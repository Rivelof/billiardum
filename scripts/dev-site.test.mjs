// Публичный сайт web/site в окружении разработки и CI (контракт M4 §2, строка devops):
// сервис site в Compose, сеть site-api, маршруты Caddy, сборка на хосте, Lighthouse.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { NODE_IMAGE, SITE_NODE_IMAGE } from './ci.mjs';
import { evaluate, failedAudits, median, parseArgs, parseBrowsersOutput, pickPages } from './ci-lighthouse.mjs';
import { SERVICE_CODE } from './dev-code.mjs';
import { WEB_APPS } from './dev.mjs';
import { ROOT } from './dev-lib.mjs';

const compose = readFileSync(join(ROOT, 'deploy', 'dev', 'compose.yml'), 'utf8');
const caddyfile = readFileSync(join(ROOT, 'deploy', 'dev', 'Caddyfile'), 'utf8');
const envExample = readFileSync(join(ROOT, '.env.example'), 'utf8');
const serviceBlock = (name) => compose.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z-]*:\\n|\\n[a-z]+:\\n)`))?.[1] ?? '';

test('compose: site — сервис Node той же версии, API по сети site-api, healthcheck, кэш OG в томе', () => {
  const site = serviceBlock('site');
  assert.match(site, /<<: \*node-service/);
  assert.match(site, new RegExp(`image: ${SITE_NODE_IMAGE.replaceAll('.', '\\.')}\\n`));
  assert.equal(SITE_NODE_IMAGE.split('-')[0], NODE_IMAGE.split('-')[0], 'та же версия Node, что у остальных сервисов');
  assert.match(site, /command: \["node", "web\/site\/server\.mjs"\]/);
  assert.match(site, /BL_API_URL: http:\/\/server-api:3000\n/);
  assert.match(site, /YANDEX_METRIKA_ID: \$\{YANDEX_METRIKA_ID:-\}\n/, 'Метрика по умолчанию выключена');
  assert.match(site, /BL_SITE_RATE_PER_MIN: \$\{BL_SITE_RATE_PER_MIN:-120\}\n/, 'лимит гостя на стенде — 120 в минуту');
  assert.match(site, /PUBLIC_HOST: /);
  assert.match(site, /OG_CACHE_DIR: \/var\/cache\/site-og\n/);
  assert.match(site, /- site-og:\/var\/cache\/site-og\n/);
  assert.match(site, /- \.\.\/\.\.:\/repo:ro\n/);
  assert.match(site, /server:\n {8}condition: service_healthy/);
  assert.match(site, /127\.0\.0\.1:3100\/health/);
  assert.match(site, /networks:\n {6}site-web:\n {8}ipv4_address: .*\n {6}site-api:\n {8}ipv4_address: .*\n/, 'сайт не в default: имена caddy, site, server-api однозначны');
  assert.match(compose, /\nvolumes:\n[\s\S]*\n {2}site-og:\n/);
});

test('compose: в сети site-api только server (имя server-api) и site; сервер доверяет адресу сайта', () => {
  const inNet = [...compose.matchAll(/\n {2}([a-z][a-z-]*):\n[\s\S]*?(?=\n {2}[a-z][a-z-]*:\n|\n[a-z]+:\n)/g)]
    .filter((m) => /\n {6}site-api:/.test(m[0]))
    .map((m) => m[1]);
  assert.deepEqual(inNet.sort(), ['server', 'site']);
  const server = serviceBlock('server');
  assert.match(server, /site-api:\n(?: {8}#.*\n)* {8}aliases: \[server-api\]\n/);
  assert.match(server, /PUBLIC_API_TRUSTED_CIDRS: \$\{PUBLIC_API_TRUSTED_CIDRS:-\$\{SITE_API_SITE_IP:-10\.231\.47\.6\}\/32\}\n/);
  assert.match(compose, /\nnetworks:\n[\s\S]*?\n {2}site-api:\n {4}ipam:\n {6}config:\n {8}- subnet: \$\{SITE_API_SUBNET:-10\.231\.47\.0\/29\}\n/);
  // Caddy в site-api нет: иначе запросы браузеров шли бы с доверенного адреса без лимита.
  assert.doesNotMatch(serviceBlock('caddy'), /\n {6}site-api:/);
  const caddyDeps = serviceBlock('caddy');
  assert.match(caddyDeps, /site:\n {8}condition: service_healthy\n(?: {8}#.*\n)* {8}required: false\n/);
});

test('compose: в сети site-web только caddy и site; сайт верит X-Forwarded-For только адресу Caddy', () => {
  const inNet = [...compose.matchAll(/\n {2}([a-z][a-z-]*):\n[\s\S]*?(?=\n {2}[a-z][a-z-]*:\n|\n[a-z]+:\n)/g)]
    .filter((m) => /\n {6}site-web:/.test(m[0]))
    .map((m) => m[1]);
  assert.deepEqual(inNet.sort(), ['caddy', 'site']);
  assert.match(serviceBlock('site'), /SITE_TRUSTED_PROXIES: \$\{SITE_TRUSTED_PROXIES:-\$\{SITE_WEB_CADDY_IP:-10\.231\.47\.13\}\/32\}\n/);
  assert.match(serviceBlock('caddy'), /networks:\n(?: {6}#.*\n)* {6}default:\n {6}server-web:\n {8}ipv4_address: .*\n {6}site-web:\n {8}ipv4_address: .*\n/);
  assert.match(compose, /\n {2}site-web:\n {4}ipam:\n {6}config:\n {8}- subnet: \$\{SITE_WEB_SUBNET:-10\.231\.47\.8\/29\}\n/);
});

test('.env.example: переменные сайта без значений', () => {
  for (const k of ['SITE_ORIGIN', 'YANDEX_METRIKA_ID', 'YANDEX_VERIFICATION', 'BL_SITE_NOINDEX', 'SITE_API_SUBNET', 'PUBLIC_API_TRUSTED_CIDRS', 'SITE_WEB_SUBNET', 'SITE_TRUSTED_PROXIES', 'SERVER_WEB_SUBNET', 'BL_SITE_RATE_PER_MIN']) {
    assert.match(envExample, new RegExp(`^${k}=$`, 'm'), k);
  }
});

test('Caddy: / и прочее — сайт; /api/, /t/, /health — сервер; /app/, /club/, /pay/ — как раньше', () => {
  assert.doesNotMatch(caddyfile, /redir \/ \/app\//, '/ больше не ведёт в приложение гостя');
  assert.match(caddyfile, /@server path \/api\/\* \/t\/\* \/health\n/);
  assert.match(caddyfile, /handle_path \/app\/\* \{/);
  assert.match(caddyfile, /handle_path \/club\/\* \{/);
  assert.match(caddyfile, /handle \/pay\/\* \{/);
  // Последний handle сайта — после всех остальных маршрутов.
  const last = caddyfile.lastIndexOf('\n\thandle {');
  const block = caddyfile.slice(last, caddyfile.indexOf('\n\t}\n', last));
  assert.match(block, /reverse_proxy site:3100/);
  assert.match(block, /encode zstd gzip/);
  assert.match(block, /header \/assets\/\* \{\n\t+defer\n\t+Cache-Control "public, max-age=31536000, immutable"/);
  assert.match(block, /\?Content-Security-Policy/, 'CSP сайта главнее');
  for (const marker of ['handle @sse {', 'handle /api/kkt/ws {', 'handle @server {', 'handle /pay/* {', 'handle_path /app/* {', 'handle_path /club/* {']) {
    assert.ok(caddyfile.indexOf(marker) < last, marker);
  }
});

test('Caddy: SSE (/api/stream и публичный поток турнира /api/public/stream) — без буферизации', () => {
  assert.match(caddyfile, /@sse path \/api\/stream\* \/api\/public\/stream\*\n/);
  const block = caddyfile.match(/\thandle @sse \{\n([\s\S]*?)\n\t\}\n/)?.[1] ?? '';
  assert.match(block, /reverse_proxy server-web:3000 \{\n\t+flush_interval -1/);
  assert.ok(caddyfile.indexOf('handle @sse {') < caddyfile.indexOf('handle @server {'));
});

test('npm run dev: сайт собирается на хосте и перезапускается при изменении web/site и shared', () => {
  const site = WEB_APPS.find((a) => a.dir === 'web/site');
  assert.ok(site, 'web/site в WEB_APPS');
  assert.deepEqual(site.watch, ['scripts/build.mjs', '--watch']);
  assert.ok(SERVICE_CODE.site.includes('web/site'));
  assert.ok(SERVICE_CODE.site.includes('shared'));
});

test('ci-lighthouse: параметры, медиана, пороги', () => {
  assert.deepEqual(parseArgs([]), { runs: 3, urls: [] });
  assert.deepEqual(parseArgs(['--runs', '1', '--url', '/perm/']), { runs: 1, urls: ['/perm/'] });
  assert.throws(() => parseArgs(['--runs', '0']), /--runs/);
  assert.throws(() => parseArgs(['--url', 'perm']), /--url/);
  assert.throws(() => parseArgs(['--x']), /неизвестный параметр/);

  assert.equal(median([0.8, 0.95, 0.9]), 0.9);
  assert.equal(median([0.8, 1]), 0.9);
  assert.equal(median([null]), null);

  const r = evaluate([
    { performance: 0.85, accessibility: 1, seo: 0.92 },
    { performance: 0.93, accessibility: 1, seo: 0.92 },
    { performance: 0.91, accessibility: 1, seo: null },
  ]);
  assert.deepEqual(r.scores, { performance: 0.91, accessibility: 1, seo: 0.92 });
  assert.deepEqual(r.failed, []);
  assert.deepEqual(evaluate([{ performance: 0.89, accessibility: 0.9, seo: null }]).failed, ['performance', 'seo']);
});

test('ci-lighthouse: страницы — главная, город с наибольшим числом клубов, клуб на программе', () => {
  const cities = { items: [{ slug: 'perm', clubs: 0 }, { slug: 'ekaterinburg', clubs: 5 }] };
  const detail = { items: [{ slug: 'duplet', status: 'listed', path: '/ekaterinburg/duplet/' }, { slug: 'svoyak', status: 'platform', path: '/ekaterinburg/svoyak/' }] };
  assert.deepEqual(pickPages(cities, detail).map((p) => p.path), ['/', '/ekaterinburg/', '/ekaterinburg/svoyak/']);
  assert.equal(pickPages(cities, { items: [{ slug: 'duplet', status: 'listed' }] })[2].path, '/ekaterinburg/duplet/');
  assert.throws(() => pickPages({ items: [] }, null), /нет городов/);
  assert.throws(() => pickPages(cities, { items: [] }), /нет клубов/);
});

test('ci-lighthouse: путь Chrome из вывода @puppeteer/browsers и непройденные проверки', () => {
  assert.equal(parseBrowsersOutput('Downloading…\nchrome@155.0.8059.39 /home/u/.cache/chrome/linux-155/chrome-linux64/chrome\n'), '/home/u/.cache/chrome/linux-155/chrome-linux64/chrome');
  assert.equal(parseBrowsersOutput('ошибка'), null);
  const lhr = {
    categories: { seo: { auditRefs: [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }, { id: 'c', weight: 0 }] } },
    audits: { a: { id: 'a', title: 'Есть meta description', score: 0 }, b: { id: 'b', title: 'ok', score: 1 }, c: { id: 'c', title: 'вес 0', score: 0 } },
  };
  assert.deepEqual(failedAudits(lhr, 'seo'), ['a: Есть meta description']);
});
