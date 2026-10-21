#!/usr/bin/env node
// npm run provision:dev — только разработка (контракт M0 §1, §4).
//
// 1. Через bl-admin в Dynamic Security: роль и клиент bl-server (bl/v1/#) с паролем из .env.
// 2. Для каждого устройства в базе: новый device_key (32 байта) и пароль MQTT, роль
//    с точными топиками протокола §2, клиент (логин и client id = device_id).
// 3. device_key — в bl.devices.device_key_enc (AES-256-GCM, SECRETS_ENC_KEY).
// 4. deploy/dev/devices.json (или SIM_DEVICES_FILE) для симулятора, права 0600.
// Повторный запуск выдаёт новые ключи и пароли и согласованно обновляет брокер, базу и файл.
// Секреты не печатаются.

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import mqtt from 'mqtt';
import pg from 'pg';
import { REPO_ROOT, repoPath } from '../lib/config.mjs';
import { createDynsec, deviceRoleAcls, deviceRoleName, serverRoleAcls } from '../lib/dynsec.mjs';
import { createLogger } from '../lib/log.mjs';
import { deviceKeyContext, encryptSecret, loadEncKey } from '../lib/secrets.mjs';

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

async function loadDevices(databaseUrl) {
  const db = new pg.Client({ connectionString: databaseUrl, application_name: 'bl-provision-dev' });
  await db.connect();
  try {
    const { rows } = await db.query(`
      select d.id, d.club_id, d.resource_id, r.number as table_number
        from bl.devices d
        left join bl.resources r on r.id = d.resource_id
       order by d.club_id, r.number nulls last, d.id`);
    return rows;
  } finally {
    await db.end();
  }
}

async function saveKeys(databaseUrl, devices, encKey) {
  const db = new pg.Client({ connectionString: databaseUrl, application_name: 'bl-provision-dev' });
  await db.connect();
  try {
    await db.query('begin');
    for (const d of devices) {
      const enc = encryptSecret(d.keyBytes, encKey, deviceKeyContext(d.id));
      await db.query('update bl.devices set device_key_enc = $2, mqtt_username = $1::text where id = $1', [d.id, enc]);
    }
    await db.query('commit');
  } catch (err) {
    await db.query('rollback').catch(() => {});
    throw err;
  } finally {
    await db.end();
  }
}

function writeDevicesFile(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
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

  const rows = await loadDevices(databaseUrl);
  if (rows.length === 0) throw new Error('в bl.devices нет устройств: сначала npm run db:seed');

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
  try {
    const dynsec = await createDynsec(client);

    await dynsec.ensureRole('bl-server', serverRoleAcls(), 'Сервер Бильярдума: bl/v1/#');
    const serverClient = await dynsec.ensureClient({
      username: serverUser,
      password: serverPassword,
      rolename: 'bl-server',
      textname: 'Сервер Бильярдума',
    });
    log.info('provision_server', { username: serverUser, client: serverClient });

    const devices = rows.map((r) => ({
      id: r.id,
      clubId: r.club_id,
      resourceId: r.resource_id,
      tableNumber: r.table_number,
      keyBytes: randomBytes(32),
      password: randomBytes(24).toString('base64url'),
    }));

    // База первой: сервер подписывает новым ключом, как только он записан.
    await saveKeys(databaseUrl, devices, encKey);

    for (const d of devices) {
      const rolename = deviceRoleName(d.id);
      await dynsec.ensureRole(rolename, deviceRoleAcls(d.clubId, d.id), `Стол ${d.tableNumber ?? '—'}`);
      const state = await dynsec.ensureClient({
        username: d.id,
        password: d.password,
        clientid: d.id,
        rolename,
        textname: `Контроллер стола ${d.tableNumber ?? '—'}`,
      });
      log.info('provision_device', { device_id: d.id, table: d.tableNumber, client: state });
    }

    writeDevicesFile(devicesFile, {
      mqtt_url: mqttUrl,
      ca_file: caFileEnv,
      devices: devices.map((d) => ({
        device_id: d.id,
        club_id: d.clubId,
        resource_id: d.resourceId,
        table_number: d.tableNumber,
        mqtt_username: d.id,
        mqtt_password: d.password,
        device_key: d.keyBytes.toString('base64'),
      })),
    });
    log.info('provision_done', { devices: devices.length, file: path.relative(REPO_ROOT, devicesFile) });
  } finally {
    await client.endAsync();
  }
}

main().catch((err) => {
  log.error('provision_failed', { error: err.message });
  process.exitCode = 1;
});
