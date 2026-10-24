#!/usr/bin/env node
// Учётная запись сервера в брокере прода: роль bl-server (bl/v1/#) и клиент MQTT_SERVER_USER
// с паролем MQTT_SERVER_PASSWORD и закреплённым client id bl-server (протокол §2).
// В разработке это делает provision:dev, в проде он запрещён — здесь только сервер, без
// устройств и без базы. Брокер не перезапускается.
//
//   … node deploy/prod/bin/mqtt-server-client.mjs --if-missing — только если клиента ещё нет
//       (deploy.sh при каждом выпуске: работающий сервер не трогается);
//   … node deploy/prod/bin/mqtt-server-client.mjs — роль, клиент и пароль из .env (ротация,
//       RUNBOOK §8). Внимание: modifyClient в Dynamic Security отключает подключённый сервер
//       («disconnected by administrative action»), поэтому сразу после — пересоздать server.
//
// Пример: deploy/prod/bin/compose.sh run --rm tools node deploy/prod/bin/mqtt-server-client.mjs
//
// Окружение: MQTT_URL, MQTT_CA_FILE, MQTT_ADMIN_USER, MQTT_ADMIN_PASSWORD, MQTT_SERVER_USER,
// MQTT_SERVER_PASSWORD. Пароли не печатаются.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import mqtt from 'mqtt';
import { createDynsec, ensureServerClient, SERVER_CLIENT_ID } from '../../../server/lib/dynsec.mjs';
import { createLogger } from '../../../server/lib/log.mjs';

const log = createLogger({ level: process.env.LOG_LEVEL || 'info' });

export async function main(env = process.env, argv = process.argv.slice(2)) {
  const ifMissing = argv.includes('--if-missing');
  const need = ['MQTT_URL', 'MQTT_CA_FILE', 'MQTT_ADMIN_USER', 'MQTT_ADMIN_PASSWORD', 'MQTT_SERVER_USER', 'MQTT_SERVER_PASSWORD'];
  const missing = need.filter((k) => !env[k]);
  if (missing.length > 0) throw new Error(`не заданы: ${missing.join(', ')}`);
  if (env.MQTT_SERVER_PASSWORD.length < 24) throw new Error('MQTT_SERVER_PASSWORD — от 24 символов');
  const client = await mqtt.connectAsync(env.MQTT_URL, {
    clientId: `bl-ops-${randomBytes(4).toString('hex')}`,
    username: env.MQTT_ADMIN_USER,
    password: env.MQTT_ADMIN_PASSWORD,
    ca: readFileSync(env.MQTT_CA_FILE),
    rejectUnauthorized: true,
    protocolVersion: 4,
    clean: true,
    reconnectPeriod: 0,
    connectTimeout: 10_000,
  });
  try {
    const dynsec = await createDynsec(client);
    if (ifMissing) {
      const got = await dynsec.run({ command: 'getClient', username: env.MQTT_SERVER_USER }, { allowErrors: ['Client not found'] });
      if (!got.error) {
        log.info('mqtt_server_client', { username: env.MQTT_SERVER_USER, clientid: SERVER_CLIENT_ID, result: 'exists' });
        return 'exists';
      }
    }
    const result = await ensureServerClient(dynsec, { username: env.MQTT_SERVER_USER, password: env.MQTT_SERVER_PASSWORD });
    log.info('mqtt_server_client', { username: env.MQTT_SERVER_USER, clientid: SERVER_CLIENT_ID, result, password_len: env.MQTT_SERVER_PASSWORD.length });
    return result;
  } finally {
    await client.endAsync();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    log.error('mqtt_server_client_failed', { error: err.message });
    process.exitCode = 1;
  });
}
