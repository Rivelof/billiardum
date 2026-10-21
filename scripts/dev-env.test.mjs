import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parseEnv } from 'node:util';

import { ensureEnvFile } from './dev.mjs';
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
  assert.ok(values.length >= 14);
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

test('без .env, но с томами прошлого запуска — понятная ошибка', () => {
  const other = join(dir, 'other.env');
  assert.throws(() => ensureEnvFile({ envFile: other, volumes: () => ['billiardum_db-data'] }), /npm run down -- --volumes/);
});
