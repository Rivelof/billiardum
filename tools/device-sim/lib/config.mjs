// Конфигурация симулятора: файл устройств (контракт M0 §4) и переменные окружения (§3).
// Ошибки не содержат значений секретов — только имена полей и номера записей.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBase64Strict, isUuid } from './command.mjs';
import { FAULTS, parseFaults } from './faults.mjs';
import { DEFAULT_CAPS } from './machine.mjs';
import { LEVELS } from './log.mjs';

export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(PACKAGE_DIR, '..', '..');
export const DEFAULT_DEVICES_FILE = 'deploy/dev/devices.json';
const KNOWN_CAPS = new Set(['relay', 'led', 'buzzer', 'current', 'dimmer']);

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const USAGE = `Симулятор контроллера стола (tools/device-sim)

  node index.mjs [--fault <режим>[@<стол>][:<мс>]]... [--tables 1,2,...] [--caps relay,led,...] [--help]

Переменные: SIM_DEVICES_FILE (по умолчанию ${DEFAULT_DEVICES_FILE}), MQTT_URL, MQTT_CA_FILE,
LOG_LEVEL (debug|info|warn|error), SIM_FAULTS, SIM_TABLES, SIM_CAPS — то же, что флаги;
SIM_NVS_DIR — NVS в файлах (перезапуск процесса = перезагрузка контроллера);
SIM_CONTROL_PORT — HTTP-управление для тестов (только разработка), SIM_CONTROL_HOST (по умолчанию 127.0.0.1).

Режимы сбоя (--fault; на ходу — POST /sim/tables/{стол}/fault):
${Object.entries(FAULTS).map(([name, text]) => `  ${name.padEnd(11)} ${text}`).join('\n')}`;

/**
 * Разбор аргументов командной строки.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const out = { help: false, faults: [], tables: null, caps: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      i += 1;
      if (i >= argv.length) throw new ConfigError(`флагу ${flag} нужно значение`);
      return argv[i];
    };
    switch (flag) {
      case '-h':
      case '--help':
        out.help = true;
        break;
      case '--fault':
        out.faults.push(value());
        break;
      case '--tables':
        out.tables = value();
        break;
      case '--caps':
        out.caps = value();
        break;
      default:
        throw new ConfigError(`неизвестный аргумент ${flag}`);
    }
  }
  return out;
}

function resolveExisting(p, bases) {
  if (path.isAbsolute(p)) return p;
  const candidates = bases.map((b) => path.resolve(b, p));
  return candidates.find((c) => existsSync(c)) ?? candidates[0];
}

function parseTables(spec) {
  if (spec === null || spec === undefined || spec === '') return null;
  const list = spec.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.some((s) => !/^[1-9][0-9]*$/.test(s))) throw new ConfigError('SIM_TABLES/--tables — номера столов через запятую');
  return new Set(list.map(Number));
}

function parseCaps(spec) {
  if (spec === null || spec === undefined || spec === '') return [...DEFAULT_CAPS];
  const list = [...new Set(spec.split(',').map((s) => s.trim()).filter(Boolean))];
  const unknown = list.filter((c) => !KNOWN_CAPS.has(c));
  if (unknown.length) throw new ConfigError(`неизвестные caps: ${unknown.join(', ')}; есть: ${[...KNOWN_CAPS].join(', ')}`);
  if (!list.includes('relay')) throw new ConfigError('caps без relay не бывает: реле обязательно (протокол §1)');
  return list;
}

function validateDevice(d, i) {
  const where = `devices[${i}]`;
  if (d === null || typeof d !== 'object') throw new ConfigError(`${where}: не объект`);
  if (!isUuid(d.device_id)) throw new ConfigError(`${where}.device_id: нужен UUID`);
  if (!isUuid(d.club_id)) throw new ConfigError(`${where}.club_id: нужен UUID`);
  if (d.resource_id !== undefined && d.resource_id !== null && !isUuid(d.resource_id)) {
    throw new ConfigError(`${where}.resource_id: нужен UUID`);
  }
  if (!Number.isSafeInteger(d.table_number) || d.table_number < 1) throw new ConfigError(`${where}.table_number: целое больше 0`);
  if (typeof d.mqtt_password !== 'string' || d.mqtt_password === '') throw new ConfigError(`${where}.mqtt_password: нужна непустая строка`);
  const key = decodeBase64Strict(d.device_key);
  if (!key || key.length !== 32) throw new ConfigError(`${where}.device_key: нужно base64 от 32 байт`);
  return {
    deviceId: d.device_id,
    clubId: d.club_id,
    resourceId: d.resource_id ?? null,
    table: d.table_number,
    mqttUsername: d.mqtt_username ?? null,
    mqttPassword: d.mqtt_password,
    deviceKey: key,
  };
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, argv?: string[], cwd?: string }} [options]
 */
export function loadConfig(options = {}) {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv.slice(2);
  const cwd = options.cwd ?? process.cwd();
  const args = parseArgs(argv);
  if (args.help) return { help: true };

  // npm запускает скрипты пакета из его папки; INIT_CWD — откуда npm вызвали.
  const base = env.INIT_CWD || cwd;
  const devicesFile = resolveExisting(env.SIM_DEVICES_FILE || DEFAULT_DEVICES_FILE, [base, REPO_ROOT]);
  if (!existsSync(devicesFile)) {
    throw new ConfigError(`нет файла устройств ${devicesFile}: его создаёт npm run provision:dev, путь — SIM_DEVICES_FILE`);
  }

  let file;
  try {
    file = JSON.parse(readFileSync(devicesFile, 'utf8'));
  } catch {
    throw new ConfigError(`файл устройств ${devicesFile} не читается как JSON`);
  }
  if (!file || !Array.isArray(file.devices) || file.devices.length === 0) {
    throw new ConfigError(`в ${devicesFile} нет списка devices`);
  }

  const devices = file.devices.map(validateDevice);
  const ids = new Set(devices.map((d) => d.deviceId));
  if (ids.size !== devices.length) throw new ConfigError('device_id повторяется');
  const tables = new Set(devices.map((d) => d.table));
  if (tables.size !== devices.length) throw new ConfigError('table_number повторяется');

  const mqttUrl = env.MQTT_URL || file.mqtt_url;
  if (!mqttUrl) throw new ConfigError('не задан адрес брокера: MQTT_URL или mqtt_url в файле устройств');
  let protocol;
  try {
    protocol = new URL(mqttUrl).protocol;
  } catch {
    throw new ConfigError('MQTT_URL/mqtt_url: неверный URL');
  }
  if (!['mqtts:', 'mqtt:'].includes(protocol)) throw new ConfigError('MQTT_URL/mqtt_url: схема mqtts:// (или mqtt:// для тестов)');
  const tls = protocol === 'mqtts:';

  let caFile = null;
  let ca = null;
  const caSpec = env.MQTT_CA_FILE || file.ca_file;
  if (tls) {
    if (!caSpec) throw new ConfigError('для mqtts:// нужен CA: MQTT_CA_FILE или ca_file в файле устройств');
    caFile = resolveExisting(caSpec, [base, path.dirname(devicesFile), REPO_ROOT]);
    if (!existsSync(caFile)) throw new ConfigError(`нет файла CA ${caFile}`);
    ca = readFileSync(caFile);
  }

  const logLevel = env.LOG_LEVEL && Object.hasOwn(LEVELS, env.LOG_LEVEL) ? env.LOG_LEVEL : 'info';
  const logLevelInvalid = Boolean(env.LOG_LEVEL) && logLevel !== env.LOG_LEVEL;

  const faultSpecs = [...(env.SIM_FAULTS ? [env.SIM_FAULTS] : []), ...args.faults];
  let faults;
  try {
    faults = parseFaults(faultSpecs);
  } catch (err) {
    throw new ConfigError(err.message);
  }

  const only = parseTables(args.tables ?? env.SIM_TABLES);
  const selected = only ? devices.filter((d) => only.has(d.table)) : devices;
  if (selected.length === 0) throw new ConfigError('после фильтра --tables/SIM_TABLES не осталось столов');

  let controlPort = null;
  if (env.SIM_CONTROL_PORT) {
    if (!/^[1-9][0-9]{0,4}$/.test(env.SIM_CONTROL_PORT) || Number(env.SIM_CONTROL_PORT) > 65535) {
      throw new ConfigError('SIM_CONTROL_PORT — порт 1…65535');
    }
    if (env.NODE_ENV === 'production') throw new ConfigError('SIM_CONTROL_PORT недоступен при NODE_ENV=production');
    controlPort = Number(env.SIM_CONTROL_PORT);
  }
  const controlHost = env.SIM_CONTROL_HOST || '127.0.0.1';
  const nvsDir = env.SIM_NVS_DIR ? resolveExisting(env.SIM_NVS_DIR, [base]) : null;

  return {
    help: false,
    controlPort,
    controlHost,
    nvsDir,
    devicesFile,
    mqttUrl,
    tls,
    caFile,
    ca,
    logLevel,
    logLevelInvalid,
    faults,
    caps: parseCaps(args.caps ?? env.SIM_CAPS),
    devices: selected,
  };
}
