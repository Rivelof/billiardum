// Конфигурация сервера из окружения (контракт M0 §3). Значения секретов в ошибки не попадают.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { DEFAULT_TRUSTED_PROXY_CIDRS, parseCidrs } from '../http/request.mjs';
import { SERVER_CLIENT_ID } from './dynsec.mjs';
import { loadEncKey } from './secrets.mjs';

/** Версия текста согласия на обработку ПДн по умолчанию (docs/legal/consent.md). */
export const DEFAULT_CONSENT_VERSION = '2026-10-21';
const HOST = /^[A-Za-z0-9.-]+(:[0-9]{1,5})?$/;

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
  const nodeEnv = env.NODE_ENV || 'development';
  const production = nodeEnv === 'production';
  const publicHost = env.PUBLIC_HOST || 'localhost:8443';
  if (!HOST.test(publicHost)) throw new ConfigError('PUBLIC_HOST — хост[:порт] без схемы');
  const portSuffix = publicHost.includes(':') ? publicHost.slice(publicHost.indexOf(':')) : '';
  const allowedOrigins = [`https://${publicHost}`];
  if (!production && env.DEV_LAN_HOST && HOST.test(env.DEV_LAN_HOST)) allowedOrigins.push(`https://${env.DEV_LAN_HOST}${portSuffix}`);
  for (const o of (env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    if (!/^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(o)) throw new ConfigError('ALLOWED_ORIGINS — список origin через запятую');
    allowedOrigins.push(o);
  }
  const consentVersion = env.CONSENT_VERSION || DEFAULT_CONSENT_VERSION;
  if (!/^[0-9A-Za-z._-]{1,32}$/.test(consentVersion)) throw new ConfigError('CONSENT_VERSION');
  // Caddy: X-Forwarded-For принимается только с этих адресов (по умолчанию loopback и частные сети Docker).
  let trustedProxies;
  try {
    trustedProxies = parseCidrs(
      env.TRUSTED_PROXY_CIDRS ? env.TRUSTED_PROXY_CIDRS.split(',').map((x) => x.trim()).filter(Boolean) : DEFAULT_TRUSTED_PROXY_CIDRS,
    );
  } catch (err) {
    throw new ConfigError(`TRUSTED_PROXY_CIDRS: ${err.message}`);
  }
  const telegramUsername = env.TELEGRAM_BOT_USERNAME || null;
  if (telegramUsername && !/^[A-Za-z0-9_]{5,32}$/.test(telegramUsername)) throw new ConfigError('TELEGRAM_BOT_USERNAME — имя бота без @');
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET || null;
  if (webhookSecret && !/^[A-Za-z0-9_-]{16,256}$/.test(webhookSecret)) throw new ConfigError('TELEGRAM_WEBHOOK_SECRET — 16–256 символов A-Z a-z 0-9 _ -');
  const proxyUrl = env.TELEGRAM_PROXY_URL || null;
  if (proxyUrl && !/^(http|socks5h?):\/\//.test(proxyUrl)) throw new ConfigError('TELEGRAM_PROXY_URL — http:// или socks5://');
  const encKey = loadEncKey(env.SECRETS_ENC_KEY);
  return {
    port,
    logLevel: level,
    nodeEnv,
    production,
    databaseUrl: env.DATABASE_URL,
    mqtt: {
      url: env.MQTT_URL,
      caFile: repoPath(env.MQTT_CA_FILE),
      username: env.MQTT_SERVER_USER,
      password: env.MQTT_SERVER_PASSWORD,
      // Закреплён в Dynamic Security (provision:dev), другой client id брокер отвергнет.
      clientId: SERVER_CLIENT_ID,
    },
    encKey,
    // M1 (контракт §11).
    publicHost,
    allowedOrigins,
    // Вход для разработки — только не в production и только с явным флагом (контракт §4).
    allowDevLogin: !production && env.ALLOW_DEV_LOGIN === '1',
    devAllowAnyMinutes: !production && env.DEV_ALLOW_ANY_MINUTES === '1',
    consentVersion,
    trustedProxies,
    pinPepper: createHmac('sha256', encKey).update('bl.pin-pepper.v1').digest(),
    vapid: {
      publicKey: env.VAPID_PUBLIC_KEY || null,
      privateKey: env.VAPID_PRIVATE_KEY || null,
      subject: env.VAPID_SUBJECT || 'mailto:dev@localhost',
    },
    pushHosts: env.WEBPUSH_ALLOWED_HOSTS ? env.WEBPUSH_ALLOWED_HOSTS.split(',').map((x) => x.trim()).filter(Boolean) : undefined,
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN || null,
      botUsername: telegramUsername,
      webhookSecret,
      proxyUrl,
    },
    max: { botToken: env.MAX_BOT_TOKEN || null },
  };
}
