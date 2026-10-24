// Прод-конфиг (deploy/prod, docs/deploy/RUNBOOK.md): без эмуляторов и входа для разработки,
// NODE_ENV=production, доверенные прокси — только конкретные адреса Caddy и сайта (decisions №70),
// наружу только 443 и 8883, Postgres и сервисы Supabase не опубликованы, образы по дайджесту (№40).
//
// Статические проверки — всегда. `docker compose config` — если есть Docker Compose (демон не
// нужен); в GitHub Actions без него — ошибка. Скрипты bash — синтаксис и поведение защит
// (окно обслуживания, preflight, монитор) на заглушках: ничего не запускают и не деплоят.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import { DEFAULT_TRUSTED_PROXY_CIDRS, ipInCidrs, parseCidrs, tooWideCidrs } from '../server/http/request.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROD = join(ROOT, 'deploy', 'prod');
const COMPOSE = join(PROD, 'compose.yml');
const EXAMPLE = join(PROD, '.env.prod.example');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');
const composeText = read('deploy', 'prod', 'compose.yml');
const example = parseEnv(readFileSync(EXAMPLE, 'utf8'));
const tmp = mkdtempSync(join(tmpdir(), 'bl-prod-config-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Сервисы, которых в проде быть не должно, и следы разработки в командах и окружении. */
const FORBIDDEN_SERVICE = /emu|sim|mock|kkt-bridge|studio|kong|gotrue|auth|rest|realtime|storage|meta|imgproxy|supavisor|pgbouncer|inbucket|mail/i;
const FORBIDDEN_COMMAND = /yookassa-emu|device-sim|kkt-bridge|\/emu\/|dev-yookassa-emu|seed|provision-dev|provision:dev|db:reset|bin\/reset|--mode mock/;
const DEV_ENV = /^(ALLOW_DEV_LOGIN|DEV_ALLOW_ANY_MINUTES|DEV_LAN_HOST|BL_SITE_DEV|VITE_MOCK|VITE_DEV_LOGIN|DEV_STAFF_PIN|YOOKASSA_EMU_.*|ATOL_EMU_.*|SIM_.*|LIGHT_IT.*)$/;
/** Секреты: в образце пусто. */
const SECRETS = [
  'POSTGRES_PASSWORD', 'DB_APP_PASSWORD', 'MQTT_ADMIN_PASSWORD', 'MQTT_SERVER_PASSWORD', 'SECRETS_ENC_KEY',
  'VAPID_PRIVATE_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_PROXY_URL', 'MAX_BOT_TOKEN',
  'PLATFORM_YOOKASSA_SECRET', 'BACKUP_RESTORE_AGE_KEY', 'RCLONE_CONFIG_BLBACKUP_ACCESS_KEY_ID', 'RCLONE_CONFIG_BLBACKUP_SECRET_ACCESS_KEY',
];
/** Порты, которые наружу открывать нельзя: Postgres, сервисы Supabase, сервер и сайт напрямую, стенд. */
const CLOSED_PORTS = new Set([5432, 54322, 6543, 3000, 3100, 3101, 8000, 8443, 9999, 54321, 54323, 4000, 5000, 8080, 8090, 16732, 18080, 1883, 80]);

function compose(...args) {
  return spawnSync('docker', ['compose', '-p', 'billiardum-prod-ci', '-f', COMPOSE, '--env-file', EXAMPLE, ...args], {
    encoding: 'utf8',
    env: { ...process.env, BL_RELEASE: '' },
  });
}
const hasCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

function composeConfig() {
  const r = compose('--profile', 'release', 'config', '--format', 'json');
  assert.equal(r.status, 0, `docker compose config: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const ipOf = (svc, net) => svc.networks?.[net]?.ipv4_address;
const list = (v) => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/** Проверки доверенных прокси по окружению сервисов и их адресам в сетях. */
function assertTrustedProxies({ server, site, caddy }) {
  const caddyToServer = ipOf(caddy, 'server-web');
  const siteToServer = ipOf(site, 'site-api');
  const caddyToSite = ipOf(caddy, 'site-web');
  assert.ok(caddyToServer && siteToServer && caddyToSite, 'у Caddy и сайта фиксированные адреса в сетях server-web, site-api, site-web');
  const trusted = list(server.environment.TRUSTED_PROXY_CIDRS);
  assert.deepEqual([...trusted].sort(), [`${caddyToServer}/32`, `${siteToServer}/32`].sort(), 'TRUSTED_PROXY_CIDRS — ровно адреса Caddy и сайта /32');
  assert.deepEqual(list(server.environment.PUBLIC_API_TRUSTED_CIDRS), [`${siteToServer}/32`], 'PUBLIC_API_TRUSTED_CIDRS — только адрес сайта');
  assert.deepEqual(list(site.environment.SITE_TRUSTED_PROXIES), [`${caddyToSite}/32`], 'SITE_TRUSTED_PROXIES — только адрес Caddy');
  for (const [name, entries] of [['TRUSTED_PROXY_CIDRS', trusted], ['PUBLIC_API_TRUSTED_CIDRS', list(server.environment.PUBLIC_API_TRUSTED_CIDRS)], ['SITE_TRUSTED_PROXIES', list(site.environment.SITE_TRUSTED_PROXIES)]]) {
    assert.deepEqual(tooWideCidrs(entries, { 32: 32, 128: 128 }), [], `${name}: только отдельные адреса, без сетей`);
    for (const wide of DEFAULT_TRUSTED_PROXY_CIDRS) assert.ok(!entries.includes(wide), `${name}: без ${wide}`);
  }
}

// --- Образец настроек ---------------------------------------------------------------------

test('.env.prod.example: секретов нет, обязательные переменные есть, разработки нет', () => {
  for (const k of SECRETS) {
    assert.ok(k in example, `в образце нет ${k}`);
    assert.equal(example[k], '', `${k} в образце должна быть пустой`);
  }
  for (const k of ['TRUSTED_PROXY_CIDRS', 'PUBLIC_API_TRUSTED_CIDRS', 'SITE_TRUSTED_PROXIES', 'PLATFORM_YOOKASSA_SHOP_ID', 'PLATFORM_YOOKASSA_SECRET', 'PLATFORM_VAT_CODE', 'PLATFORM_TAX_SYSTEM_CODE', 'PLATFORM_BILLING_RETURN_URL', 'SECRETS_ENC_KEY', 'YANDEX_METRIKA_ID', 'BL_DOMAIN', 'MQTT_PUBLIC_URL', 'MAINTENANCE_WINDOW', 'BACKUP_AGE_RECIPIENTS', 'MONITOR_TELEGRAM_CHAT_IDS']) {
    assert.ok(k in example, `в образце нет ${k}`);
  }
  for (const k of Object.keys(example)) assert.doesNotMatch(k, DEV_ENV, `${k} — переменная разработки`);
  // Ключи магазинов ЮKassa клубов — в базе, не в .env (№154); адрес API задан в compose.yml.
  for (const k of Object.keys(example)) assert.doesNotMatch(k, /^YOOKASSA_(SHOP|SECRET|API_URL)/, `${k}: ключи ЮKassa клубов хранятся в базе`);
  assert.ok(!('NODE_ENV' in example), 'NODE_ENV задаётся в compose.yml, не в .env');
});

test('.env.prod.example: доверенные прокси — конкретные адреса /32 внутри своих сетей /29', () => {
  const e = example;
  assert.deepEqual(list(e.TRUSTED_PROXY_CIDRS).sort(), [`${e.SERVER_WEB_CADDY_IP}/32`, `${e.SITE_API_SITE_IP}/32`].sort());
  assert.deepEqual(list(e.PUBLIC_API_TRUSTED_CIDRS), [`${e.SITE_API_SITE_IP}/32`]);
  assert.deepEqual(list(e.SITE_TRUSTED_PROXIES), [`${e.SITE_WEB_CADDY_IP}/32`]);
  const inNet = (ip, net) => ipInCidrs(ip, parseCidrs([net]));
  for (const [ip, net] of [['SERVER_WEB_SERVER_IP', 'SERVER_WEB_SUBNET'], ['SERVER_WEB_CADDY_IP', 'SERVER_WEB_SUBNET'], ['SITE_API_SERVER_IP', 'SITE_API_SUBNET'], ['SITE_API_SITE_IP', 'SITE_API_SUBNET'], ['SITE_WEB_CADDY_IP', 'SITE_WEB_SUBNET'], ['SITE_WEB_SITE_IP', 'SITE_WEB_SUBNET']]) {
    assert.ok(inNet(e[ip], e[net]), `${ip} ${e[ip]} не в ${net} ${e[net]}`);
  }
  for (const k of ['SERVER_WEB_SUBNET', 'SITE_API_SUBNET', 'SITE_WEB_SUBNET']) assert.match(e[k], /\/29$/, `${k} — /29`);
});

test('compose.yml: каждая ${ПЕРЕМЕННАЯ} есть в образце, NODE_ENV не из .env', () => {
  const vars = new Set([...composeText.replaceAll('$$', '').matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]));
  for (const v of vars) assert.ok(v in example, `compose.yml ссылается на ${v}, а в .env.prod.example её нет`);
  assert.doesNotMatch(composeText, /\$\{NODE_ENV/);
  assert.doesNotMatch(composeText, /\$\{(ALLOW_DEV_LOGIN|DEV_ALLOW_ANY_MINUTES|DEV_LAN_HOST|YOOKASSA_API_URL)/);
});

test('preflight.sh требует только переменные из образца', () => {
  const pf = read('deploy', 'prod', 'bin', 'preflight.sh');
  const block = pf.match(/required=\(([\s\S]*?)\)/)[1];
  for (const v of block.split(/\s+/).filter(Boolean)) assert.ok(v in example, `preflight требует ${v}, а в образце её нет`);
});

// --- Caddy, Mosquitto, Dockerfile, образы ------------------------------------------------

test('Caddyfile прода: свой домен и настоящий TLS, без эмулятора и стенда', () => {
  const c = read('deploy', 'prod', 'caddy', 'Caddyfile');
  assert.match(c, /^\{\$BL_DOMAIN\} \{/m, 'сайт — на домене BL_DOMAIN');
  assert.doesNotMatch(c, /^\s*tls internal/m, 'без внутреннего CA');
  assert.doesNotMatch(c, /yookassa-emu|handle \/pay\/|DEV_LAN_HOST|localhost:8443|skip_install_trust/);
  assert.match(c, /Strict-Transport-Security "max-age=31536000"/);
  assert.match(c, /not remote_ip \{\$YOOKASSA_WEBHOOK_IPS\}/, 'вебхуки ЮKassa — только с её адресов');
  assert.match(c, /reverse_proxy server-web:3000/);
  assert.doesNotMatch(c, /reverse_proxy (db|mosquitto|server):/, 'к серверу — только по сети server-web');
});

test('mosquitto.conf прода: только TLS 8883, без анонимов, Dynamic Security', () => {
  const m = read('deploy', 'prod', 'mosquitto', 'mosquitto.conf');
  const active = m.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  assert.ok(active.includes('allow_anonymous false'));
  assert.deepEqual(active.filter((l) => l.startsWith('listener')), ['listener 8883']);
  assert.ok(active.includes('tls_version tlsv1.2'));
  assert.ok(active.some((l) => /^plugin .*mosquitto_dynamic_security\.so$/.test(l)));
  assert.ok(active.some((l) => l.startsWith('certfile ')) && active.some((l) => l.startsWith('keyfile ')));
  assert.ok(!active.some((l) => /^(password_file|acl_file)\b/.test(l)), 'доступ только через Dynamic Security');
});

test('образы: сторонние — по дайджесту, версии как в decisions №40; одинаковые везде', () => {
  const pinned = {
    'supabase/postgres': '15.8.1.085',
    'eclipse-mosquitto': '2.1.2-alpine',
    caddy: '2.11.7-alpine',
  };
  const images = [...composeText.matchAll(/^\s+image: (\S+)$/gm)].map((m) => m[1]);
  for (const img of images) {
    if (img.startsWith('billiardum-app:')) continue;
    const m = img.match(/^([a-z0-9/._-]+):([A-Za-z0-9._-]+)@sha256:[0-9a-f]{64}$/);
    assert.ok(m, `образ ${img} не закреплён по дайджесту`);
    assert.equal(pinned[m[1]], m[2], `${m[1]}: версия ${m[2]}, по №40 — ${pinned[m[1]]}`);
  }
  const db = images.find((i) => i.startsWith('supabase/postgres:'));
  assert.match(read('deploy', 'prod', 'bin', 'lib.sh'), new RegExp(`BL_PG_IMAGE='${db.replace(/[.]/g, '\\.')}'`), 'lib.sh: тот же образ базы, что у db');
  const dockerfile = read('deploy', 'prod', 'Dockerfile');
  const froms = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((m) => m[1]);
  assert.ok(froms.length >= 2);
  for (const f of froms) assert.match(f, /^node:22\.23\.4-bookworm-slim@sha256:[0-9a-f]{64}$/, `Dockerfile: ${f}`);
});

test('Dockerfile: фронтенд без заглушки и входа для разработки, в образе нет сида и эмуляторов', () => {
  const d = read('deploy', 'prod', 'Dockerfile');
  assert.match(d, /ENV VITE_MOCK= VITE_DEV_LOGIN=/);
  assert.match(d, /grep -rl BL_MOCK_MARKER web\/guest\/dist web\/admin\/dist/);
  assert.match(d, /rm -f \/out\/supabase\/bin\/seed\.mjs/);
  assert.match(d, /provision-dev\.mjs/);
  assert.match(d, /ENV NODE_ENV=production/);
  assert.match(d, /^USER node$/m);
  assert.doesNotMatch(d.split('AS app')[1], /tools\//, 'в итоговом образе нет tools/');
  const ignore = read('deploy', 'prod', 'Dockerfile.dockerignore');
  for (const p of ['**/.env', '**/.env.*', 'deploy/dev/certs', '.git']) assert.ok(ignore.split('\n').includes(p), `dockerignore: ${p}`);
});

test('.gitignore: образец прода в git, настоящие .env — нет', () => {
  const g = read('.gitignore').split('\n');
  assert.ok(g.includes('.env') && g.includes('.env.*') && g.includes('!.env.prod.example'));
});

test('systemd: юниты ссылаются на существующие скрипты, у служб есть тревога о сбое', () => {
  const dir = join(PROD, 'systemd');
  for (const f of readdirSync(dir)) {
    const u = readFileSync(join(dir, f), 'utf8');
    for (const m of u.matchAll(/ExecStart=\/opt\/billiardum\/(\S+)/g)) assert.ok(existsSync(join(ROOT, m[1])), `${f}: нет ${m[1]}`);
    if (f.endsWith('.service') && !f.startsWith('billiardum-alert@')) assert.match(u, /OnFailure=billiardum-alert@%n\.service/, f);
    if (f.endsWith('.timer')) assert.ok(existsSync(join(dir, f.replace(/\.timer$/, '.service'))), `${f}: нет службы`);
  }
});

// --- docker compose config ---------------------------------------------------------------

test('docker compose config с образцом: эмуляторов и входа для разработки нет, NODE_ENV=production', (t) => {
  if (!hasCompose) {
    if (process.env.GITHUB_ACTIONS === 'true') assert.fail('в CI нужен docker compose');
    t.skip('нет docker compose');
    return;
  }
  assert.equal(compose('config', '--quiet').status, 0, 'docker compose config --quiet');
  const cfg = composeConfig();
  const names = Object.keys(cfg.services);
  assert.deepEqual(names.filter((n) => FORBIDDEN_SERVICE.test(n)), [], 'сервисы эмуляторов, симулятора, моста ККТ или Supabase');
  assert.deepEqual([...names].sort(), ['caddy', 'db', 'migrate', 'mosquitto', 'server', 'site', 'tools', 'web-publish']);
  for (const [name, svc] of Object.entries(cfg.services)) {
    const cmd = [...(svc.entrypoint ?? []), ...(svc.command ?? [])].join(' ');
    assert.doesNotMatch(cmd, FORBIDDEN_COMMAND, `${name}: команда разработки «${cmd}»`);
    for (const k of Object.keys(svc.environment ?? {})) assert.doesNotMatch(k, DEV_ENV, `${name}: переменная разработки ${k}`);
    if (svc.image?.startsWith('billiardum-app:')) assert.equal(svc.environment?.NODE_ENV, 'production', `${name}: NODE_ENV`);
    assert.doesNotMatch(svc.image ?? '', /supabase\/(?!postgres)/, `${name}: сервис Supabase`);
  }
  assert.equal(cfg.services.server.environment.YOOKASSA_API_URL, 'https://api.yookassa.ru/v3');
  // Магазин платформы (M5.3) — только из .env, без значений эмулятора разработки по умолчанию.
  for (const k of ['PLATFORM_YOOKASSA_SHOP_ID', 'PLATFORM_YOOKASSA_SECRET']) {
    assert.ok(k in cfg.services.server.environment, `server: нет ${k}`);
    assert.doesNotMatch(String(cfg.services.server.environment[k]), /emu|dev_only|^8000/, `server: ${k} из эмулятора`);
  }
  assert.match(cfg.services.site.environment.BL_API_URL, /^http:\/\/server-api:3000$/, 'сайт — только на настоящем API (пустой включил бы заглушку)');
});

test('docker compose config: наружу только 443 (Caddy) и 8883 (брокер), база без портов и выхода наружу', (t) => {
  if (!hasCompose) {
    if (process.env.GITHUB_ACTIONS === 'true') assert.fail('в CI нужен docker compose');
    t.skip('нет docker compose');
    return;
  }
  const cfg = composeConfig();
  const published = [];
  for (const [name, svc] of Object.entries(cfg.services)) {
    for (const p of svc.ports ?? []) {
      const port = Number(p.published);
      assert.ok(!CLOSED_PORTS.has(port) && !CLOSED_PORTS.has(Number(p.target)), `${name}: порт ${p.published}:${p.target} наружу`);
      published.push(`${name}:${port}/${p.protocol}`);
    }
    if (svc.network_mode === 'host') assert.fail(`${name}: network_mode host`);
  }
  assert.deepEqual(published.sort(), ['caddy:443/tcp', 'mosquitto:8883/tcp']);
  assert.deepEqual(cfg.services.db.ports ?? [], []);
  for (const net of Object.keys(cfg.services.db.networks)) assert.equal(cfg.networks[net].internal, true, `сеть базы ${net} — internal`);
  for (const net of ['server-web', 'site-api', 'site-web']) assert.equal(cfg.networks[net].internal, true, `${net} — internal`);
  assert.ok(!('ports' in cfg.services.server) && !('ports' in cfg.services.site), 'server и site — только через Caddy');
});

test('docker compose config: доверенные прокси сервера и сайта — ровно адреса Caddy и сайта', (t) => {
  if (!hasCompose) {
    if (process.env.GITHUB_ACTIONS === 'true') assert.fail('в CI нужен docker compose');
    t.skip('нет docker compose');
    return;
  }
  const { services } = composeConfig();
  assertTrustedProxies(services);
});

test('проверка доверенных прокси ловит широкие сети и адрес Caddy в PUBLIC_API_TRUSTED_CIDRS', () => {
  const svc = (env, nets) => ({ environment: env, networks: nets });
  const base = () => ({
    server: svc({ TRUSTED_PROXY_CIDRS: '10.0.0.22/32,10.0.0.6/32', PUBLIC_API_TRUSTED_CIDRS: '10.0.0.6/32' }, {}),
    site: svc({ SITE_TRUSTED_PROXIES: '10.0.0.13/32' }, { 'site-api': { ipv4_address: '10.0.0.6' }, 'site-web': { ipv4_address: '10.0.0.14' } }),
    caddy: svc({}, { 'server-web': { ipv4_address: '10.0.0.22' }, 'site-web': { ipv4_address: '10.0.0.13' } }),
  });
  assertTrustedProxies(base());
  const wide = base();
  wide.server.environment.TRUSTED_PROXY_CIDRS = '10.0.0.0/8';
  assert.throws(() => assertTrustedProxies(wide));
  const caddyInPublic = base();
  caddyInPublic.server.environment.PUBLIC_API_TRUSTED_CIDRS = '10.0.0.6/32,10.0.0.22/32';
  assert.throws(() => assertTrustedProxies(caddyInPublic));
});

// --- Скрипты bash ------------------------------------------------------------------------

const hasBash = spawnSync('bash', ['--version']).status === 0;
const shellFiles = ['bin', 'backup', 'monitor'].flatMap((d) =>
  readdirSync(join(PROD, d)).filter((f) => f.endsWith('.sh')).map((f) => join(PROD, d, f)),
);

/** Файл настроек для скриптов: образец + тестовые секреты (права 0600). */
function testEnv(overrides = {}) {
  const e = { ...example };
  Object.assign(e, {
    BL_DOMAIN: 'billiardum.example', ACME_EMAIL: 'ops@billiardum.example', SITE_ORIGIN: 'https://billiardum.example',
    MQTT_PUBLIC_URL: 'mqtts://mqtt.billiardum.example:8883',
    POSTGRES_PASSWORD: 'p'.repeat(40), DB_APP_PASSWORD: 'a'.repeat(40),
    MQTT_ADMIN_PASSWORD: 'm'.repeat(32), MQTT_SERVER_PASSWORD: 's'.repeat(32),
    SECRETS_ENC_KEY: Buffer.alloc(32, 7).toString('base64'),
    VAPID_PUBLIC_KEY: 'B'.repeat(87), VAPID_PRIVATE_KEY: 'C'.repeat(43), VAPID_SUBJECT: 'mailto:ops@billiardum.example',
    BACKUP_AGE_RECIPIENTS: `age1${'q'.repeat(58)} age1${'p'.repeat(58)}`, BACKUP_ENV_AGE_RECIPIENT: `age1${'q'.repeat(58)}`,
    BACKUP_RESTORE_AGE_KEY: `AGE-SECRET-KEY-1${'Q'.repeat(58)}`, MONITOR_TELEGRAM_CHAT_IDS: '123456',
    BL_STATE_DIR: join(tmp, 'state'),
    ...overrides,
  });
  const file = join(tmp, `env-${Math.random().toString(36).slice(2)}`);
  writeFileSync(file, `${Object.entries(e).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
  chmodSync(file, 0o600);
  return file;
}

function bash(script, env = {}) {
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 30_000 });
}

test('скрипты прода: синтаксис bash', { skip: !hasBash && 'нет bash' }, () => {
  for (const f of shellFiles) {
    const r = spawnSync('bash', ['-n', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
  assert.ok(shellFiles.length >= 10);
});

test('окно обслуживания: внутри, вне, через полночь', { skip: !hasBash && 'нет bash' }, () => {
  const lib = join(PROD, 'bin', 'lib.sh');
  const at = (win, now) => bash(`. '${lib}'; date() { echo ${now}; }; MAINTENANCE_WINDOW=${win}; bl_in_window && echo in || echo out`).stdout.trim();
  assert.equal(at('06:00-10:00', '07:30'), 'in');
  assert.equal(at('06:00-10:00', '10:00'), 'out');
  assert.equal(at('06:00-10:00', '05:59'), 'out');
  assert.equal(at('23:00-04:00', '01:15'), 'in');
  assert.equal(at('23:00-04:00', '12:00'), 'out');
});

test('compose.sh: брокер и базу вне окна не перезапустить, остальное можно', { skip: !hasBash && 'нет bash' }, () => {
  const bin = join(tmp, 'fakebin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\necho "docker $*"\n');
  chmodSync(join(bin, 'docker'), 0o755);
  // 00:00-00:00 — окна нет никогда.
  const env = { BL_ENV_FILE: testEnv({ MAINTENANCE_WINDOW: '00:00-00:00' }), BL_ROOT: ROOT, PATH: `${bin}:${process.env.PATH}` };
  const run = (...args) => spawnSync(join(PROD, 'bin', 'compose.sh'), args, { encoding: 'utf8', env: { ...process.env, ...env } });
  for (const ok of [['ps'], ['up', '-d', '--no-deps', '--wait', 'server'], ['kill', '-s', 'HUP', 'mosquitto'], ['stop', 'site'], ['logs', 'mosquitto']]) {
    const r = run(...ok);
    assert.equal(r.status, 0, `${ok.join(' ')}: ${r.stderr}`);
    assert.match(r.stdout, /docker compose -p billiardum-prod/);
  }
  for (const bad of [['up', '-d'], ['up', '-d', 'server'], ['restart', 'mosquitto'], ['stop', 'db'], ['down'], ['rm', '-f', 'mosquitto'], ['kill', 'mosquitto']]) {
    const r = run(...bad);
    assert.notEqual(r.status, 0, `${bad.join(' ')} должен быть запрещён вне окна`);
    assert.match(r.stderr, /окне обслуживания/);
    assert.doesNotMatch(r.stdout, /docker compose/);
  }
});

test('preflight.sh --env-only: образец с секретами проходит, широкие прокси и dev-флаги — нет', { skip: !hasBash && 'нет bash' }, () => {
  const run = (overrides) => spawnSync(join(PROD, 'bin', 'preflight.sh'), ['--env-only'], {
    encoding: 'utf8',
    env: { ...process.env, BL_ENV_FILE: testEnv(overrides), BL_ROOT: ROOT },
  });
  const okRun = run({});
  assert.equal(okRun.status, 0, okRun.stdout + okRun.stderr);
  assert.doesNotMatch(okRun.stdout, /p{40}|m{32}/, 'значения секретов не печатаются');
  for (const bad of [
    { PLATFORM_YOOKASSA_SHOP_ID: '800010', PLATFORM_YOOKASSA_SECRET: 'test_emu_800010_platform_dev_only' },
    { PLATFORM_YOOKASSA_SHOP_ID: '123' },
    { TRUSTED_PROXY_CIDRS: '10.0.0.0/8' },
    { TRUSTED_PROXY_CIDRS: '10.231.48.16/29,10.231.48.0/29' },
    { PUBLIC_API_TRUSTED_CIDRS: '10.231.48.6/32,10.231.48.22/32' },
    { ALLOW_DEV_LOGIN: '1' },
    { NODE_ENV: 'development' },
    { SECRETS_ENC_KEY: 'c2hvcnQ=' },
    { POSTGRES_PASSWORD: 'short' },
  ]) {
    const r = run(bad);
    assert.equal(r.status, 1, `${JSON.stringify(bad)} должен не пройти:\n${r.stdout}`);
  }
});

test('монитор: показатели базы превращаются в тревоги (заглушка базы, без отправки)', { skip: !hasBash && 'нет bash' }, () => {
  const envFile = testEnv({ MONITOR_DEVICE_HOURS: '' });
  const fake = [
    'devices_total|8', 'devices_offline_10m|2', 'clubs_all_offline|0', 'outbox_due|3', 'outbox_oldest_due_s|900',
    'outbox_retrying|0', 'outbox_payment_due|1', 'notify_queued_10m|0', 'notify_failed_1h|0', 'receipts_stuck|2',
    'receipts_failed_24h|0', 'yookassa_alarms_15m|0', 'alarms_critical_open_30m|0', 'kkt_bridges_offline|0',
    'wal_archive_failing|0', 'wal_last_archived_s|60',
  ].join('\n');
  const r = bash(`. '${join(PROD, 'monitor', 'monitor.sh')}' --dry-run; bl_psql() { cat >/dev/null; printf '%s\\n' '${fake}'; }; check_db`, {
    BL_ENV_FILE: envFile,
    BL_ROOT: ROOT,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ПРОБЛЕМА \[warning\] devices_online: контроллеров на связи 75 %/);
  assert.match(r.stdout, /ПРОБЛЕМА \[critical\] outbox_payment/);
  assert.match(r.stdout, /ПРОБЛЕМА \[critical\] outbox_lag/);
  assert.match(r.stdout, /ПРОБЛЕМА \[warning\] receipts/);
  assert.match(r.stdout, /норма wal_archive/);
  assert.match(r.stdout, /норма club_offline/);
});

test('publish-web.sh: новые ассеты добавляются, старые хранятся, index.html заменяется', { skip: !hasBash && 'нет bash' }, () => {
  const src = join(tmp, 'pw-src');
  const dst = join(tmp, 'pw-dst');
  for (const app of ['guest', 'admin']) {
    mkdirSync(join(src, app, 'dist', 'assets'), { recursive: true });
    writeFileSync(join(src, app, 'dist', 'index.html'), `<script src="/assets/v1.js"></script>`);
    writeFileSync(join(src, app, 'dist', 'assets', 'v1.js'), 'v1');
  }
  const run = () => spawnSync('sh', [join(PROD, 'bin', 'publish-web.sh')], { encoding: 'utf8', env: { ...process.env, PUBLISH_SRC_ROOT: src, PUBLISH_DST_ROOT: dst } });
  assert.equal(run().status, 0);
  rmSync(join(src, 'guest', 'dist', 'assets', 'v1.js'));
  writeFileSync(join(src, 'guest', 'dist', 'assets', 'v2.js'), 'v2');
  writeFileSync(join(src, 'guest', 'dist', 'index.html'), `<script src="/assets/v2.js"></script>`);
  assert.equal(run().status, 0);
  assert.ok(existsSync(join(dst, 'guest', 'assets', 'v1.js')), 'старый ассет остался для открытых вкладок');
  assert.ok(existsSync(join(dst, 'guest', 'assets', 'v2.js')));
  assert.match(readFileSync(join(dst, 'guest', 'index.html'), 'utf8'), /v2\.js/);
});
