// Сети прокси стенда и доверенные адреса (замечание pentester M4-I4): сервер верит
// X-Forwarded-For только Caddy и сайту, публичный API без лимита — только сайту, сайт верит
// только Caddy. Адреса фиксированные и выводятся из подсетей .env (scripts/dev-net.mjs).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { ensureEnvFile } from './dev.mjs';
import { ENV_EXAMPLE, ROOT } from './dev-lib.mjs';
import { addrVar, checkNetworkEnv, DEV_NETWORKS, networkEnv, parseCidrEntry, trustDefaults } from './dev-net.mjs';

const compose = readFileSync(join(ROOT, 'deploy', 'dev', 'compose.yml'), 'utf8');
const caddyfile = readFileSync(join(ROOT, 'deploy', 'dev', 'Caddyfile'), 'utf8');
const ciCaddyWs = readFileSync(join(ROOT, 'scripts', 'ci-caddy-ws.mjs'), 'utf8');
const envExample = readFileSync(ENV_EXAMPLE, 'utf8');
const SERVICE = /\n {2}([a-z][a-z-]*):\n([\s\S]*?)(?=\n {2}[a-z][a-z-]*:\n|\n[a-z]+:\n)/g;
const services = Object.fromEntries([...compose.slice(compose.indexOf('\nservices:\n'), compose.indexOf('\nnetworks:\n') + '\nnetworks:\n'.length).matchAll(SERVICE)].map((m) => [m[1], m[2]]));

/** Подстановка Compose `${VAR:-по умолчанию}`, в том числе вложенная. */
function interpolate(text, env) {
  let prev;
  let out = text;
  do {
    prev = out;
    out = out.replace(/\$\{([A-Z0-9_]+):-([^${}]*)\}/g, (_, k, def) => env[k] || def);
  } while (out !== prev);
  return out;
}

const envOf = (service, key) => {
  const m = new RegExp(`\\n {6}${key}: (.*)\\n`).exec(services[service]);
  assert.ok(m, `${service}: нет ${key}`);
  return m[1];
};

test('compose: в сетях прокси ровно по два сервиса с фиксированными адресами из dev-net.mjs', () => {
  const defaults = networkEnv({});
  for (const [net, def] of Object.entries(DEV_NETWORKS)) {
    const inNet = Object.entries(services).filter(([, body]) => new RegExp(`\\n {6}${net}:`).test(body)).map(([name]) => name);
    assert.deepEqual(inNet.sort(), Object.keys(def.members).sort(), net);
    for (const service of Object.keys(def.members)) {
      const v = addrVar(net, service);
      const m = new RegExp(`\\n {6}${net}:\\n(?: {8}.*\\n)*? {8}ipv4_address: \\$\\{${v}:-([\\d.]+)\\}\\n`).exec(services[service]);
      assert.ok(m, `${service} в ${net}: ipv4_address \${${v}:-…}`);
      assert.equal(m[1], defaults[v], v);
    }
    assert.match(compose, new RegExp(`\\n {2}${net}:\\n {4}ipam:\\n {6}config:\\n {8}- subnet: \\$\\{${def.subnetVar}:-${def.subnet.replaceAll('.', '\\.').replace('/', '\\/')}\\}\\n`), net);
  }
  assert.deepEqual(defaults, {
    SERVER_WEB_SERVER_IP: '10.231.47.21', SERVER_WEB_CADDY_IP: '10.231.47.22',
    SITE_API_SERVER_IP: '10.231.47.5', SITE_API_SITE_IP: '10.231.47.6',
    SITE_WEB_CADDY_IP: '10.231.47.13', SITE_WEB_SITE_IP: '10.231.47.14',
  });
});

test('compose: сервер верит X-Forwarded-For только Caddy и сайту, без лимита — только сайт, сайт верит только Caddy', () => {
  const custom = { SERVER_WEB_SUBNET: '10.50.0.16/29', SITE_API_SUBNET: '10.50.0.0/29', SITE_WEB_SUBNET: '10.50.0.8/29' };
  for (const env of [{}, custom]) {
    const want = trustDefaults(env);
    const derived = networkEnv(env);
    assert.equal(interpolate(envOf('server', 'TRUSTED_PROXY_CIDRS'), derived), want.TRUSTED_PROXY_CIDRS);
    assert.equal(interpolate(envOf('server', 'PUBLIC_API_TRUSTED_CIDRS'), derived), want.PUBLIC_API_TRUSTED_CIDRS);
    assert.equal(interpolate(envOf('site', 'SITE_TRUSTED_PROXIES'), derived), want.SITE_TRUSTED_PROXIES);
  }
  assert.equal(trustDefaults().TRUSTED_PROXY_CIDRS, '10.231.47.22/32,10.231.47.6/32');
  assert.equal(trustDefaults().PUBLIC_API_TRUSTED_CIDRS, '10.231.47.6/32');
  assert.equal(trustDefaults().SITE_TRUSTED_PROXIES, '10.231.47.13/32');
  assert.equal(interpolate(envOf('server', 'TRUSTED_PROXY_CIDRS'), { TRUSTED_PROXY_CIDRS: '10.0.0.5/32' }), '10.0.0.5/32', 'значение из .env главнее');
  // Частные сети целиком больше нигде не доверены.
  assert.doesNotMatch(compose, /10\.0\.0\.0\/8|172\.16\.0\.0\/12|192\.168\.0\.0\/16/);
});

test('Caddy ходит в сервер только по имени server-web (имя server есть и в default)', () => {
  const upstreams = [...caddyfile.matchAll(/reverse_proxy (\S+):3000/g)].map((m) => m[1]);
  assert.ok(upstreams.length >= 3);
  assert.deepEqual([...new Set(upstreams)], ['server-web']);
  assert.match(services.server, /\n {6}server-web:\n {8}aliases: \[server-web\]\n/);
  assert.match(ciCaddyWs, /'--network-alias', 'server-web'/, 'заглушка сервера в CI под тем же именем');
});

test('networkEnv: адреса +5 и +6 от начала подсети из .env', () => {
  const a = networkEnv({ SITE_API_SUBNET: '172.30.5.64/26', SITE_WEB_SUBNET: '', SERVER_WEB_SUBNET: '192.168.200.0/24' });
  assert.equal(a.SITE_API_SERVER_IP, '172.30.5.69');
  assert.equal(a.SITE_API_SITE_IP, '172.30.5.70');
  assert.equal(a.SITE_WEB_CADDY_IP, '10.231.47.13', 'пусто — подсеть по умолчанию');
  assert.equal(a.SERVER_WEB_SERVER_IP, '192.168.200.5');
  assert.equal(a.SERVER_WEB_CADDY_IP, '192.168.200.6');
});

test('checkNetworkEnv: подсети — IPv4 от /24 до /29, с начала сети, не пересекаются', () => {
  assert.deepEqual(checkNetworkEnv({}), { errors: [], warnings: [] });
  assert.deepEqual(checkNetworkEnv({ SITE_API_SUBNET: '10.50.0.0/29', SITE_WEB_SUBNET: '10.50.0.8/29', SERVER_WEB_SUBNET: '10.50.1.0/24' }).errors, []);
  const err = (env) => checkNetworkEnv(env).errors.join('\n');
  assert.match(err({ SITE_API_SUBNET: '10.50.0.0/30' }), /SITE_API_SUBNET.*от \/24 до \/29/);
  assert.match(err({ SERVER_WEB_SUBNET: '10.50.0.0/16' }), /SERVER_WEB_SUBNET/);
  assert.match(err({ SITE_WEB_SUBNET: '10.50.0.0' }), /SITE_WEB_SUBNET/);
  assert.match(err({ SITE_WEB_SUBNET: '10.50.0.300/29' }), /SITE_WEB_SUBNET/);
  assert.match(err({ SERVER_WEB_SUBNET: '10.50.0.3/29' }), /не начало подсети.*10\.50\.0\.0\/29/);
  assert.match(err({ SERVER_WEB_SUBNET: '10.231.47.0/24' }), /пересекаются/, 'пересечение с подсетями по умолчанию');
});

test('checkNetworkEnv: доверенные адреса — конкретные, не частные сети (M4-I4)', () => {
  const err = (env) => checkNetworkEnv(env).errors.join('\n');
  for (const k of ['TRUSTED_PROXY_CIDRS', 'PUBLIC_API_TRUSTED_CIDRS', 'SITE_TRUSTED_PROXIES']) {
    assert.match(err({ [k]: '10.0.0.0/8' }), new RegExp(`${k}.*сеть шире /24`), k);
    assert.match(err({ [k]: '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16' }), new RegExp(k));
    assert.match(err({ [k]: 'caddy' }), /не адрес/);
    assert.match(err({ [k]: '10.231.47.22/33' }), /неверная маска/);
    assert.match(err({ [k]: '10.231.47.22/32/1' }), /не адрес/);
    assert.match(err({ [k]: '10.231.47.22/32,' }), /не адрес/, 'пустой элемент');
    assert.match(err({ [k]: 'fc00::/7' }), /сеть шире \/120/);
  }
  assert.deepEqual(parseCidrEntry('::1'), { family: 6, addr: '::1', bits: 128 });
  assert.equal(parseCidrEntry('10.231.47.0/24').bits, 24);
  // Как в проде: конкретные адреса Caddy и сайта.
  assert.deepEqual(checkNetworkEnv({ ...trustDefaults(), TRUSTED_PROXY_CIDRS: '10.231.47.22/32,10.231.47.6,::1' }), { errors: [], warnings: [] });
});

test('checkNetworkEnv: Caddy в PUBLIC_API_TRUSTED_CIDRS — ошибка; прокси без Caddy или сайта — предупреждение', () => {
  assert.match(checkNetworkEnv({ PUBLIC_API_TRUSTED_CIDRS: '10.231.47.6/32,10.231.47.22/32' }).errors.join(), /PUBLIC_API_TRUSTED_CIDRS.*Caddy/);
  assert.match(checkNetworkEnv({ PUBLIC_API_TRUSTED_CIDRS: '10.231.47.0/24' }).errors.join(), /адрес Caddy/, 'подсеть, где есть Caddy');
  assert.match(
    checkNetworkEnv({ SITE_WEB_SUBNET: '10.60.0.0/29', PUBLIC_API_TRUSTED_CIDRS: '10.60.0.5' }).errors.join(),
    /Caddy/,
    'адрес Caddy в сети site-web из .env',
  );
  const w = checkNetworkEnv({ TRUSTED_PROXY_CIDRS: '10.231.47.6/32', SITE_TRUSTED_PROXIES: '127.0.0.1/32' }).warnings.join('\n');
  assert.match(w, /TRUSTED_PROXY_CIDRS.*Caddy.*10\.231\.47\.22/);
  assert.match(w, /SITE_TRUSTED_PROXIES.*Caddy.*10\.231\.47\.13/);
  assert.match(checkNetworkEnv({ TRUSTED_PROXY_CIDRS: '10.231.47.22/32' }).warnings.join(), /сайта.*10\.231\.47\.6/);
});

test('npm run dev отказывается стартовать с частными сетями в доверенных адресах', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bl-net-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const envFile = join(dir, '.env');
  const orig = console.log;
  console.log = () => {};
  try {
    ensureEnvFile({ envFile, volumes: () => [] });
    const base = readFileSync(envFile, 'utf8');
    const withValue = (k, v) => base.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`);
    writeFileSync(envFile, withValue('TRUSTED_PROXY_CIDRS', '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16'));
    assert.throws(() => ensureEnvFile({ envFile, volumes: () => [] }), /TRUSTED_PROXY_CIDRS.*сеть шире \/24/);
    writeFileSync(envFile, withValue('PUBLIC_API_TRUSTED_CIDRS', '10.231.47.22/32'));
    assert.throws(() => ensureEnvFile({ envFile, volumes: () => [] }), /PUBLIC_API_TRUSTED_CIDRS/);
    writeFileSync(envFile, withValue('SERVER_WEB_SUBNET', '10.231.47.16/30'));
    assert.throws(() => ensureEnvFile({ envFile, volumes: () => [] }), /SERVER_WEB_SUBNET/);
    writeFileSync(envFile, withValue('TRUSTED_PROXY_CIDRS', '10.231.47.22/32,10.231.47.6/32'));
    ensureEnvFile({ envFile, volumes: () => [] });
  } finally {
    console.log = orig;
  }
});

test('.env.example: подсеть server-web без значения, адреса *_IP не в .env (их выводит npm run dev)', () => {
  assert.match(envExample, /^SERVER_WEB_SUBNET=$/m);
  for (const v of Object.keys(networkEnv({}))) assert.doesNotMatch(envExample, new RegExp(`^${v}=`, 'm'), v);
  assert.doesNotMatch(envExample, /Пусто — частные сети/);
});
