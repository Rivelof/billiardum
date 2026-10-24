#!/usr/bin/env node
// npm run provision:dev — только разработка (контракт M0 §1, §4).
//
// 1. Через bl-admin в Dynamic Security: роль и клиент bl-server (bl/v1/#) с паролем из .env
//    и закреплённым client id bl-server.
// 2. Только устройства клуба сида (server/devices/provision-dev.mjs, дефект Н1): не привязанные
//    через bind/claim и не из заводского реестра bl.device_factory. Остальные контроллеры
//    скрипт не читает и не трогает. Каждому — device_key (32 байта) и пароль MQTT, роль
//    с точными топиками протокола §2, клиент (логин и client id = device_id).
// 3. device_key — в bl.devices.device_key_enc (AES-256-GCM, SECRETS_ENC_KEY).
// 4. deploy/dev/devices.json (или SIM_DEVICES_FILE) для симулятора, права 0600, только сид.
// 5. PIN персонала сида без PIN (владелец, управляющий, ресепшн тестового клуба) — DEV_STAFF_PIN
//    (по умолчанию 1234): хеш зависит от SECRETS_ENC_KEY, поэтому его ставит провижининг, а не сид.
// 6. Деньги: server/payments/provision-dev.mjs (backend-money) — магазин ЮKassa тестового
//    клуба на эмуляторе, если модуль есть.
// Повторный запуск оставляет ключ и пароль устройства, если ключ в базе совпадает с прежним
// devices.json (работающий симулятор не отключается); иначе или с --rotate — новые, согласованно
// в базе, брокере и файле. Секреты не печатаются.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import mqtt from 'mqtt';
import pg from 'pg';
import { REPO_ROOT, repoPath } from '../lib/config.mjs';
import { createDynsec, ensureServerClient, SERVER_CLIENT_ID } from '../lib/dynsec.mjs';
import { createLogger } from '../lib/log.mjs';
import { loadEncKey } from '../lib/secrets.mjs';
import { hashPin, PIN, pinPepper } from '../auth/pin.mjs';
import { provisionSeedDevices, SEED_CLUB_ID } from '../devices/provision-dev.mjs';

const DEV_CLUB_ID = SEED_CLUB_ID;
const DEV_STAFF = ['a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000004'];

const log = createLogger({ level: process.env.LOG_LEVEL || 'info' });

function env(name, fallback) {
  if (!process.env[name] && fallback === undefined) {
    const envFile = path.join(REPO_ROOT, '.env');
    if (existsSync(envFile)) process.loadEnvFile(envFile);
  }
  const value = process.env[name] || fallback;
  if (!value) throw new Error(`не задана переменная окружения ${name}`);
  return value;
}

/** Модуль соседа, если он уже есть (параллельная разработка). */
async function importOptional(spec) {
  const url = new URL(spec, import.meta.url);
  try {
    return await import(url.href);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(url.pathname)) return null;
    throw err;
  }
}

/** PIN персонала сида, у кого его ещё нет. */
async function setDevPins(db, encKey) {
  const pin = process.env.DEV_STAFF_PIN || '1234';
  if (!PIN.test(pin)) throw new Error('DEV_STAFF_PIN — 4–6 цифр');
  const pepper = pinPepper(encKey);
  const { rows } = await db.query(
    'select id from bl.club_members where club_id = $1 and user_id = any($2::uuid[]) and pin_hash is null',
    [DEV_CLUB_ID, DEV_STAFF],
  );
  for (const r of rows) {
    await db.query('update bl.club_members set pin_hash = $2, pin_set_at = now(), pin_failed_count = 0, pin_locked_until = null where id = $1', [
      r.id,
      await hashPin(pin, pepper),
    ]);
  }
  log.info('provision_dev_pins', { set: rows.length });
}

/** После устройств: PIN персонала и деньги (backend-money). */
async function provisionAfterDevices(databaseUrl, encKey) {
  const db = new pg.Client({ connectionString: databaseUrl, application_name: 'bl-provision-dev' });
  await db.connect();
  try {
    await setDevPins(db, encKey);
    const payments = await importOptional('../payments/provision-dev.mjs');
    if (typeof payments?.provisionPayments === 'function') {
      const res = await payments.provisionPayments({
        client: db,
        env: process.env,
        log: (level, msg, fields) => (log[level] ?? log.info)(msg, fields),
      });
      log.info('provision_payments', { status: res?.status ?? null });
    } else {
      log.warn('provision_payments_missing', {});
    }
  } finally {
    await db.end();
  }
}

async function main() {
  const databaseUrl = env('DATABASE_ADMIN_URL');
  if (process.env.NODE_ENV === 'production') throw new Error('provision:dev запрещён при NODE_ENV=production');
  const mqttUrl = env('MQTT_URL');
  const caFileEnv = env('MQTT_CA_FILE');
  const adminUser = env('MQTT_ADMIN_USER');
  const adminPassword = env('MQTT_ADMIN_PASSWORD');
  const serverUser = env('MQTT_SERVER_USER');
  const serverPassword = env('MQTT_SERVER_PASSWORD');
  const encKey = loadEncKey(env('SECRETS_ENC_KEY'));
  const devicesFile = repoPath(process.env.SIM_DEVICES_FILE || 'deploy/dev/devices.json');

  const rotate = process.argv.includes('--rotate');

  const client = await mqtt.connectAsync(mqttUrl, {
    clientId: `bl-provision-${randomBytes(4).toString('hex')}`,
    username: adminUser,
    password: adminPassword,
    ca: readFileSync(repoPath(caFileEnv)),
    rejectUnauthorized: true,
    protocolVersion: 4,
    clean: true,
    reconnectPeriod: 0,
    connectTimeout: 10_000,
  });
  const db = new pg.Client({ connectionString: databaseUrl, application_name: 'bl-provision-dev' });
  try {
    const dynsec = await createDynsec(client);

    const serverClient = await ensureServerClient(dynsec, { username: serverUser, password: serverPassword });
    log.info('provision_server', { username: serverUser, clientid: SERVER_CLIENT_ID, client: serverClient });

    await db.connect();
    const res = await provisionSeedDevices({ db, dynsec, encKey, devicesFile, mqttUrl, caFile: caFileEnv, rotate, log });
    await db.end().catch(() => {});
    log.info('provision_done', { ...res, rotate, file: path.relative(REPO_ROOT, devicesFile) });
    await provisionAfterDevices(databaseUrl, encKey);
  } finally {
    await db.end().catch(() => {});
    await client.endAsync();
  }
}

main().catch((err) => {
  log.error('provision_failed', { error: err.message });
  process.exitCode = 1;
});
