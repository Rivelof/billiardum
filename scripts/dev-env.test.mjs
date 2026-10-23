import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parseEnv } from 'node:util';

import { ensureEnvFile, parseDevArgs, vapidPublicKey, webBuildEnv } from './dev.mjs';
import { ENV_EXAMPLE } from './dev-lib.mjs';

const dir = mkdtempSync(join(tmpdir(), 'bl-env-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const envFile = join(dir, '.env');
const noVolumes = () => [];
const read = () => parseEnv(readFileSync(envFile, 'utf8'));

// Тихий лог: ensureEnvFile пишет через console.log.
const quiet = (fn) => {
  const orig = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = orig;
  }
};

test('.env.example без значений', () => {
  const values = Object.values(parseEnv(readFileSync(ENV_EXAMPLE, 'utf8')));
  assert.ok(values.length >= 30);
  assert.ok(values.every((v) => v === ''));
});

test('создаёт .env со всеми переменными контракта §3', () => {
  quiet(() => ensureEnvFile({ envFile, volumes: noVolumes }));
  const env = read();
  for (const key of [
    'POSTGRES_PASSWORD', 'DATABASE_ADMIN_URL', 'DB_APP_PASSWORD', 'DATABASE_URL', 'MQTT_URL', 'MQTT_CA_FILE',
    'MQTT_ADMIN_USER', 'MQTT_ADMIN_PASSWORD', 'MQTT_SERVER_USER', 'MQTT_SERVER_PASSWORD', 'SECRETS_ENC_KEY',
    'SIM_DEVICES_FILE', 'PORT', 'LOG_LEVEL',
  ]) {
    assert.ok(env[key], `${key} пуст`);
  }
  assert.equal(env.MQTT_ADMIN_USER, 'bl-admin');
  assert.equal(env.MQTT_SERVER_USER, 'bl-server');
  assert.equal(Buffer.from(env.SECRETS_ENC_KEY, 'base64').length, 32);
  assert.ok(env.MQTT_ADMIN_PASSWORD.length >= 12);
  assert.notEqual(env.POSTGRES_PASSWORD, env.DB_APP_PASSWORD);

  const admin = new URL(env.DATABASE_ADMIN_URL);
  assert.equal(admin.username, 'supabase_admin');
  assert.equal(admin.password, env.POSTGRES_PASSWORD);
  assert.equal(admin.port, '54322');
  const app = new URL(env.DATABASE_URL);
  assert.equal(app.username, 'app_api');
  assert.equal(app.password, env.DB_APP_PASSWORD);

  if (process.platform !== 'win32') assert.equal(statSync(envFile).mode & 0o777, 0o600);
});

test('переменные M1 §11: значения по умолчанию, ключи VAPID и пустые токены ботов', () => {
  const env = read();
  assert.equal(env.NODE_ENV, 'development');
  assert.equal(env.PUBLIC_HOST, 'localhost:8443');
  assert.equal(env.ALLOW_DEV_LOGIN, '1');
  assert.equal(env.DEV_ALLOW_ANY_MINUTES, '1');
  assert.equal(env.YOOKASSA_API_URL, 'http://yookassa-emu:8090/v3');
  assert.match(env.YOOKASSA_EMU_SHOP_ID, /^\d{6}$/);
  assert.match(env.YOOKASSA_EMU_SECRET, /^test_[A-Za-z0-9_-]{32}$/);
  assert.equal(env.VAPID_SUBJECT, 'mailto:dev@localhost');
  assert.match(env.TELEGRAM_WEBHOOK_SECRET, /^[A-Za-z0-9_-]{32,256}$/); // требование secret_token Telegram

  // Web Push: открытый ключ — точка P-256 без сжатия (65 байт), закрытый — 32 байта, base64url.
  const pub = Buffer.from(env.VAPID_PUBLIC_KEY, 'base64url');
  assert.equal(pub.length, 65);
  assert.equal(pub[0], 0x04);
  assert.equal(Buffer.from(env.VAPID_PRIVATE_KEY, 'base64url').length, 32);
  assert.doesNotMatch(env.VAPID_PUBLIC_KEY + env.VAPID_PRIVATE_KEY, /[+/=]/);
  assert.equal(vapidPublicKey(env.VAPID_PRIVATE_KEY), env.VAPID_PUBLIC_KEY);

  for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME', 'TELEGRAM_PROXY_URL', 'MAX_BOT_TOKEN', 'DEV_LAN_HOST']) {
    assert.equal(env[key], '', `${key} должен остаться пустым`);
  }
});

test('повторный запуск не меняет значения и дописывает пропавшие', () => {
  const before = read();
  const text = readFileSync(envFile, 'utf8').replace(/^MQTT_SERVER_PASSWORD=.*\n/m, '');
  writeFileSync(envFile, text);
  quiet(() => ensureEnvFile({ envFile, volumes: noVolumes }));
  const after = read();
  assert.ok(after.MQTT_SERVER_PASSWORD);
  assert.notEqual(after.MQTT_SERVER_PASSWORD, before.MQTT_SERVER_PASSWORD);
  for (const key of Object.keys(before).filter((k) => k !== 'MQTT_SERVER_PASSWORD')) assert.equal(after[key], before[key]);
});

test('старый .env (M0): дописываются только недостающие переменные, порядок как в .env.example', () => {
  const old = join(dir, 'm0.env');
  const m0 = 'POSTGRES_PASSWORD=p1\nDB_APP_PASSWORD=p2\nMQTT_ADMIN_USER=bl-admin\nMQTT_ADMIN_PASSWORD=012345678901\n' +
    'MQTT_SERVER_USER=bl-server\nMQTT_SERVER_PASSWORD=p3\nSECRETS_ENC_KEY=k\nMQTT_URL=mqtts://localhost:8883\n' +
    'MQTT_CA_FILE=deploy/dev/certs/ca.crt\nSIM_DEVICES_FILE=deploy/dev/devices.json\nPORT=3000\nLOG_LEVEL=debug\n' +
    'DATABASE_ADMIN_URL=postgres://a\nDATABASE_URL=postgres://b\nTELEGRAM_BOT_TOKEN=keep\n';
  writeFileSync(old, m0);
  quiet(() => ensureEnvFile({ envFile: old, volumes: noVolumes }));
  const text = readFileSync(old, 'utf8');
  assert.ok(text.startsWith(m0), 'прежние строки не тронуты');
  const env = parseEnv(text);
  assert.equal(env.LOG_LEVEL, 'debug');
  assert.equal(env.TELEGRAM_BOT_TOKEN, 'keep');
  assert.equal(env.NODE_ENV, 'development');
  const added = [...text.slice(m0.length).matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
  const exampleOrder = [...readFileSync(ENV_EXAMPLE, 'utf8').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
  assert.deepEqual(added, exampleOrder.filter((k) => added.includes(k)));
  assert.ok(!added.includes('TELEGRAM_BOT_TOKEN'));
});

test('ключи VAPID не от одной пары — понятная ошибка', () => {
  const bad = join(dir, 'vapid.env');
  const text = readFileSync(envFile, 'utf8').replace(/^VAPID_PUBLIC_KEY=.*$/m, `VAPID_PUBLIC_KEY=${vapidPublicKey(Buffer.alloc(32, 7).toString('base64url'))}`);
  writeFileSync(bad, text);
  assert.throws(() => quiet(() => ensureEnvFile({ envFile: bad, volumes: noVolumes })), /VAPID_PUBLIC_KEY/);
});

test('DEV_LAN_HOST и PUBLIC_HOST проверяются', () => {
  const lan = join(dir, 'lan.env');
  const base = readFileSync(envFile, 'utf8');
  writeFileSync(lan, base.replace(/^DEV_LAN_HOST=.*$/m, 'DEV_LAN_HOST=localhost'));
  assert.throws(() => quiet(() => ensureEnvFile({ envFile: lan, volumes: noVolumes })), /DEV_LAN_HOST/);
  writeFileSync(lan, base.replace(/^PUBLIC_HOST=.*$/m, 'PUBLIC_HOST=https://localhost:8443/'));
  assert.throws(() => quiet(() => ensureEnvFile({ envFile: lan, volumes: noVolumes })), /PUBLIC_HOST/);
  writeFileSync(lan, base.replace(/^DEV_LAN_HOST=.*$/m, 'DEV_LAN_HOST=192.168.1.10').replace(/^PUBLIC_HOST=.*$/m, 'PUBLIC_HOST=192.168.1.10:8443'));
  quiet(() => ensureEnvFile({ envFile: lan, volumes: noVolumes }));
});

test('BL_SITE_RATE_PER_MIN: целое число или пусто', () => {
  const f = join(dir, 'rate.env');
  const base = readFileSync(envFile, 'utf8');
  for (const bad of ['сто', '-1', '1.5', '1000000']) {
    writeFileSync(f, base.replace(/^BL_SITE_RATE_PER_MIN=.*$/m, `BL_SITE_RATE_PER_MIN=${bad}`));
    assert.throws(() => quiet(() => ensureEnvFile({ envFile: f, volumes: noVolumes })), /BL_SITE_RATE_PER_MIN/, bad);
  }
  for (const ok of ['', '0', '120', '600']) {
    writeFileSync(f, base.replace(/^BL_SITE_RATE_PER_MIN=.*$/m, `BL_SITE_RATE_PER_MIN=${ok}`));
    quiet(() => ensureEnvFile({ envFile: f, volumes: noVolumes }));
  }
});

test('сборка фронтенда: без секретов .env и NODE_ENV, вход для разработки по ALLOW_DEV_LOGIN', () => {
  const files = read();
  const env = webBuildEnv(files, { PATH: '/bin', NODE_ENV: 'development' });
  assert.equal(env.NODE_ENV, undefined);
  assert.equal(env.PATH, '/bin');
  assert.equal(env.VITE_DEV_LOGIN, '1');
  for (const key of ['POSTGRES_PASSWORD', 'SECRETS_ENC_KEY', 'VAPID_PRIVATE_KEY', 'YOOKASSA_EMU_SECRET']) assert.equal(env[key], undefined, key);
  assert.equal(webBuildEnv({ ...files, ALLOW_DEV_LOGIN: '0' }, {}).VITE_DEV_LOGIN, undefined);
});

test('параметры npm run dev', () => {
  assert.deepEqual(parseDevArgs([]), { watchWeb: false, restart: false, check: false });
  assert.deepEqual(parseDevArgs(['--watch-web']), { watchWeb: true, restart: false, check: false });
  assert.deepEqual(parseDevArgs(['--restart', '--watch-web']), { watchWeb: true, restart: true, check: false });
  assert.deepEqual(parseDevArgs(['--check']), { watchWeb: false, restart: false, check: true });
  assert.throws(() => parseDevArgs(['--watch']), /--watch-web.*--restart.*--check/);
  assert.throws(() => parseDevArgs(['--check', '--restart']), /--check/);
});

test('без .env, но с томами прошлого запуска — понятная ошибка', () => {
  const other = join(dir, 'other.env');
  assert.throws(() => ensureEnvFile({ envFile: other, volumes: () => ['billiardum_db-data'] }), /npm run down -- --volumes/);
});
