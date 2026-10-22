#!/usr/bin/env node
// Мост ККТ «Бильярдума» на ПК ресепшена (decisions №77, №85): исходящее WebSocket-соединение
// с сервером клуба и веб-сервер драйвера АТОЛ на этом ПК. Наружу ничего не слушает.
//
//   node index.mjs --config C:\kkt-bridge\kkt-bridge.json
//   KKT_BRIDGE_CONFIG=./kkt-bridge.json KKT_BRIDGE_TOKEN=… node index.mjs
//
// Настройки — tools/kkt-bridge/README.md. Лог — строки JSON в stdout, без токена.
// Своему CA (разработка) — NODE_EXTRA_CA_CERTS=путь_к_ca.pem.

import { loadConfig, ConfigError } from './lib/config.mjs';
import { createBridge, VERSION } from './lib/bridge.mjs';

function log(level, msg, fields = {}) {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields })}\n`);
}
const logger = {
  debug: () => {},
  info: (m, f) => log('info', m, f),
  warn: (m, f) => log('warn', m, f),
  error: (m, f) => log('error', m, f),
};

const args = process.argv.slice(2);
const at = args.indexOf('--config');
const file = at >= 0 ? args[at + 1] : process.env.KKT_BRIDGE_CONFIG || './kkt-bridge.json';

if (typeof globalThis.WebSocket !== 'function') {
  log('error', 'bridge_node_too_old', { node: process.version, need: '>=22' });
  process.exit(1);
}

let config;
try {
  config = loadConfig(file);
} catch (err) {
  log('error', 'bridge_config_error', { error: err instanceof ConfigError ? err.message : String(err.message) });
  process.exit(1);
}

const bridge = createBridge({ config, log: logger });
log('info', 'bridge_started', { version: VERSION, name: config.name, server: new URL(config.serverUrl).host, atol: config.atolUrl, atol_api: config.atolApi });
bridge.start();

async function shutdown(signal) {
  log('info', 'bridge_stopping', { signal });
  const force = setTimeout(() => process.exit(0), 15_000);
  force.unref();
  await bridge.stop();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
