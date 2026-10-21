// Конфигурация сервера из окружения (контракт M0 §3). Значения секретов в ошибки не попадают.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_CLIENT_ID } from './dynsec.mjs';
import { loadEncKey } from './secrets.mjs';

export const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(SERVER_DIR, '..');

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Относительный путь — от корня репозитория (как в .env: deploy/dev/certs/ca.crt). */
export function repoPath(p) {
  return path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p);
}

export function loadServerConfig(env = process.env) {
  const missing = ['DATABASE_URL', 'MQTT_URL', 'MQTT_CA_FILE', 'MQTT_SERVER_USER', 'MQTT_SERVER_PASSWORD', 'SECRETS_ENC_KEY'].filter(
    (k) => !env[k],
  );
  if (missing.length > 0) throw new ConfigError(`не заданы переменные окружения: ${missing.join(', ')}`);
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError('PORT — целое от 1 до 65535');
  const level = env.LOG_LEVEL || 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(level)) throw new ConfigError('LOG_LEVEL — debug, info, warn или error');
  return {
    port,
    logLevel: level,
    databaseUrl: env.DATABASE_URL,
    mqtt: {
      url: env.MQTT_URL,
      caFile: repoPath(env.MQTT_CA_FILE),
      username: env.MQTT_SERVER_USER,
      password: env.MQTT_SERVER_PASSWORD,
      // Закреплён в Dynamic Security (provision:dev), другой client id брокер отвергнет.
      clientId: SERVER_CLIENT_ID,
    },
    encKey: loadEncKey(env.SECRETS_ENC_KEY),
  };
}
