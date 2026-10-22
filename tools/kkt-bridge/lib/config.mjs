// Файл настроек моста ККТ (JSON) и переменные окружения.
//
//   {
//     "server_url": "wss://bl.example.ru/api/kkt/ws",  адрес сервера (только wss://; ws:// — только
//                                                      localhost или allow_insecure для разработки)
//     "token_file": "C:\\kkt-bridge\\token.txt",       токен моста (выдаёт владелец в программе клуба);
//                                                      или переменная KKT_BRIDGE_TOKEN; "token" в самом файле — можно, но хуже
//     "atol_url": "http://127.0.0.1:16732",            веб-сервер драйвера АТОЛ на этом ПК
//     "atol_api": "v2",                                v2 — «АТОЛ. Web Requests» (/api/v2), legacy — старый веб-сервер ДТО 10 (/requests)
//     "atol_device_id": null,                          ?deviceID= — ККТ на веб-сервере, если их несколько
//     "atol_user": "", "atol_password": "",            Basic-вход веб-сервера АТОЛ, если включён
//     "name": "Ресепшн",                               имя кассы (ПК) — в программе клуба
//     "data_dir": "./kkt-bridge-data",                 журнал моста (UUID отправленных заданий)
//     "job_timeout_ms": 60000, "poll_ms": 500, "status_poll_ms": 15000,
//     "reconnect_min_ms": 1000, "reconnect_max_ms": 60000
//   }

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const TOKEN = /^[A-Za-z0-9_-]{40,128}$/;

const DEFAULTS = {
  atol_url: 'http://127.0.0.1:16732',
  atol_api: 'v2',
  atol_device_id: null,
  atol_user: '',
  atol_password: '',
  name: 'Ресепшн',
  data_dir: './kkt-bridge-data',
  job_timeout_ms: 60_000,
  poll_ms: 500,
  status_poll_ms: 15_000,
  reconnect_min_ms: 1_000,
  reconnect_max_ms: 60_000,
  allow_insecure: false,
};

function int(raw, name, min, max) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} — целое от ${min} до ${max}`);
  return n;
}

function isLocalHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/**
 * Проверить и дополнить настройки. raw — объект файла; env — окружение; baseDir — каталог файла.
 * @returns {object} настройки моста (токен — в поле token, в лог не выводится)
 */
export function parseConfig(raw, { env = process.env, baseDir = process.cwd() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('настройки — объект JSON');
  const c = { ...DEFAULTS, ...raw };
  let server;
  try {
    server = new URL(String(c.server_url ?? ''));
  } catch {
    throw new ConfigError('server_url — адрес вида wss://{host}/api/kkt/ws');
  }
  if (server.protocol !== 'wss:' && !(server.protocol === 'ws:' && (c.allow_insecure === true || isLocalHost(server.hostname)))) {
    throw new ConfigError('server_url — только wss:// (ws:// — только localhost или allow_insecure для разработки)');
  }
  if (server.username || server.password) throw new ConfigError('server_url без логина и пароля: токен — в token_file');
  let atol;
  try {
    atol = new URL(String(c.atol_url));
  } catch {
    throw new ConfigError('atol_url — адрес веб-сервера АТОЛ, например http://127.0.0.1:16732');
  }
  if (!['http:', 'https:'].includes(atol.protocol)) throw new ConfigError('atol_url — http(s)');
  if (!['v2', 'legacy'].includes(c.atol_api)) throw new ConfigError('atol_api — v2 или legacy');
  if (typeof c.name !== 'string' || c.name.trim() === '' || c.name.length > 100) throw new ConfigError('name — от 1 до 100 символов');

  let token = env.KKT_BRIDGE_TOKEN || null;
  if (!token && c.token_file) {
    const p = isAbsolute(c.token_file) ? c.token_file : resolve(baseDir, c.token_file);
    try {
      token = readFileSync(p, 'utf8').trim();
    } catch (err) {
      throw new ConfigError(`token_file не читается: ${err.code ?? err.message}`);
    }
  }
  if (!token && typeof c.token === 'string') token = c.token.trim();
  if (!token) throw new ConfigError('нет токена моста: KKT_BRIDGE_TOKEN, token_file или token');
  if (!TOKEN.test(token)) throw new ConfigError(`токен моста неверного вида (длина ${token.length})`);

  return {
    serverUrl: server.toString(),
    token,
    atolUrl: atol.toString().replace(/\/+$/, ''),
    atolApi: c.atol_api,
    atolDeviceId: c.atol_device_id ? String(c.atol_device_id) : null,
    atolAuth: c.atol_user ? { user: String(c.atol_user), password: String(c.atol_password ?? '') } : null,
    name: c.name.trim(),
    dataDir: c.data_dir === null ? null : isAbsolute(c.data_dir) ? c.data_dir : resolve(baseDir, c.data_dir),
    jobTimeoutMs: int(c.job_timeout_ms, 'job_timeout_ms', 100, 600_000),
    pollMs: int(c.poll_ms, 'poll_ms', 10, 10_000),
    statusPollMs: int(c.status_poll_ms, 'status_poll_ms', 100, 600_000),
    reconnectMinMs: int(c.reconnect_min_ms, 'reconnect_min_ms', 10, 60_000),
    reconnectMaxMs: int(c.reconnect_max_ms, 'reconnect_max_ms', 100, 600_000),
  };
}

/** Убрать BOM (U+FEFF) в начале текста. */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Прочитать файл настроек. */
export function loadConfig(file, { env = process.env } = {}) {
  let raw;
  try {
    // «Блокнот» Windows сохраняет UTF-8 с BOM: JSON.parse его не принимает.
    raw = JSON.parse(stripBom(readFileSync(file, 'utf8')));
  } catch (err) {
    throw new ConfigError(`файл настроек ${file}: ${err.code ?? err.message}`);
  }
  return parseConfig(raw, { env, baseDir: dirname(resolve(file)) });
}
