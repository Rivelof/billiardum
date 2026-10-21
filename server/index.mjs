// Вход сервера «Бильярдума»: HTTP на PORT (GET /health) и мост MQTT.
// Конфигурация — переменные окружения (контракт M0 §3). Завершение — по SIGTERM/SIGINT.

import http from 'node:http';
import pg from 'pg';
import { connectMqtt, createBridge } from './mqtt.mjs';
import { loadServerConfig } from './lib/config.mjs';
import { createHandler } from './lib/http.mjs';
import { createLogger } from './lib/log.mjs';
import { createStore } from './lib/store.mjs';

const SHUTDOWN_TIMEOUT_MS = 10_000;

let config;
try {
  config = loadServerConfig();
} catch (err) {
  createLogger().error('config_error', { error: err.message });
  process.exit(1);
}

const log = createLogger({ level: config.logLevel });

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 5,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  application_name: 'bl-server',
});
pool.on('error', (err) => log.error('db_pool_error', { error: err.message }));

const store = createStore(pool);
let client;
try {
  client = connectMqtt(config.mqtt);
} catch (err) {
  log.error('config_error', { error: `MQTT: ${err.message}` });
  process.exit(1);
}
const bridge = createBridge({ client, store, encKey: config.encKey, log });
bridge.start();

const server = http.createServer(
  createHandler({
    checkDb: () => store.ping(),
    mqttConnected: () => bridge.isConnected(),
    log,
  }),
);
server.listen(config.port, () => log.info('server_started', { port: config.port }));

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info('server_stopping', { signal });
  const force = setTimeout(() => {
    log.error('server_stop_timeout', {});
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  force.unref();
  await new Promise((resolve) => server.close(resolve));
  await bridge.stop();
  await new Promise((resolve) => client.end(false, {}, resolve));
  await pool.end();
  log.info('server_stopped', {});
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
