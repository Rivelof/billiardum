// Вход сервера «Бильярдума» (контракт M1 §2.1): HTTP на PORT (GET /health и api/routes/*.mjs),
// модули core → light → money через init(ctx)/stop(). Модуля нет — сервер работает без него;
// пока нет модуля light, мост MQTT создаётся как в M0.
// Конфигурация — переменные окружения (контракты M0 §3, M1 §11). Завершение — SIGTERM/SIGINT.

import http from 'node:http';
import pg from 'pg';
import { createApp } from './http/app.mjs';
import { hub } from './http/sse.mjs';
import { loadServerConfig } from './lib/config.mjs';
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
hub.setLogger?.(log);

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  // Одно соединение держит LISTEN outbox, ещё одно — LISTEN модуля light.
  max: 12,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  application_name: 'bl-server',
});
pool.on('error', (err) => log.error('db_pool_error', { error: err.message }));

/** Мост MQTT M0 — только если модуль light не создал свой. */
async function fallbackBridge() {
  const { connectMqtt, createBridge } = await import('./mqtt.mjs');
  const client = connectMqtt(config.mqtt);
  const bridge = createBridge({ client, store: createStore(pool), encKey: config.encKey, log });
  await bridge.start();
  log.warn('bridge_fallback_m0', {});
  return {
    fallback: true,
    isConnected: () => bridge.isConnected(),
    command: (...args) => bridge.command(...args),
    async stopFallback() {
      await bridge.stop();
      await new Promise((resolve) => client.end(false, {}, resolve));
    },
  };
}

let app;
try {
  app = await createApp({ config, log, pool, fallbackBridge });
} catch (err) {
  log.error('startup_failed', { error: err.message });
  await pool.end().catch(() => {});
  process.exit(1);
}

const server = http.createServer(app.handler);
// WebSocket моста ККТ (/api/kkt/ws, модуль kkt); остальные upgrade закрываются.
server.on('upgrade', (req, socket, head) => app.upgrade(req, socket, head));
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;
server.listen(config.port, () => log.info('server_started', { port: config.port, env: config.nodeEnv, dev_login: config.allowDevLogin }));

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
  // Новые соединения не принимаются; потоки SSE и мосты ККТ закрываются, чтобы close() не ждал их.
  await app.shutdown(server, { timeoutMs: SHUTDOWN_TIMEOUT_MS - 2_000 });
  await pool.end();
  log.info('server_stopped', {});
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
