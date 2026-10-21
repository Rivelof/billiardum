// Общее для сценариев приёмки M0 (tests/e2e/m0). Работают на поднятом `npm run dev`:
// читают .env и deploy/dev/devices.json, секреты не печатают, данные не меняют
// (кроме попыток внутри транзакций с ROLLBACK).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mqtt from 'mqtt';
import pg from 'pg';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const envFile = path.join(REPO_ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

/** Переменная окружения (или из .env); значение в сообщения не попадает. */
export function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`нет переменной ${name} (ни в окружении, ни в .env)`);
  return value;
}

export function repoPath(p) {
  return path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
}

export const CLUB_A = 'c1000000-0000-4000-8000-000000000001'; // клуб сида
export const SERVER_CONTAINER = process.env.E2E_SERVER_CONTAINER || 'billiardum-server-1';
export const SIM_CONTAINER = process.env.E2E_SIM_CONTAINER || 'billiardum-device-sim-1';
export const CADDY_CONTAINER = process.env.E2E_CADDY_CONTAINER || 'billiardum-caddy-1';

/** deploy/dev/devices.json (контракт M0 §4). */
export function loadDevices() {
  const file = repoPath(process.env.SIM_DEVICES_FILE || 'deploy/dev/devices.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  return data.devices.slice().sort((a, b) => a.table_number - b.table_number);
}

export function caCert() {
  return readFileSync(repoPath(env('MQTT_CA_FILE')));
}

/** Адрес брокера с хоста: MQTT_URL из .env (mqtts://localhost:8883). */
export function mqttUrl() {
  return env('MQTT_URL');
}

export function topic(clubId, deviceId, kind) {
  return `bl/v1/${clubId}/${deviceId}/${kind}`;
}

// База ----------------------------------------------------------------------------

export async function adminClient() {
  const c = new pg.Client({ connectionString: env('DATABASE_ADMIN_URL'), application_name: 'bl-e2e' });
  await c.connect();
  return c;
}

export async function appClient() {
  const c = new pg.Client({ connectionString: env('DATABASE_URL'), application_name: 'bl-e2e' });
  await c.connect();
  return c;
}

/** Выполнить запрос внутри SAVEPOINT; вернуть { ok, rows, rowCount } или { ok:false, code, message }. */
export async function attempt(client, sql, params = []) {
  await client.query('savepoint e2e_try');
  try {
    const res = await client.query(sql, params);
    await client.query('release savepoint e2e_try');
    return { ok: true, rows: res.rows, rowCount: res.rowCount };
  } catch (err) {
    await client.query('rollback to savepoint e2e_try');
    return { ok: false, code: err.code, message: err.message };
  }
}

export async function setContext(client, clubId, { userId = null, actorType = 'system' } = {}) {
  await client.query(
    "select set_config('app.club_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_type', $3, true)",
    [clubId ?? '', userId ?? '', actorType],
  );
}

// Логи контейнеров -------------------------------------------------------------------

/** Строки JSON из `docker logs`; since — Date или ISO-строка. */
export function containerLog(container, { since } = {}) {
  const args = ['logs'];
  if (since) args.push('--since', new Date(since).toISOString());
  args.push(container);
  const res = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`docker logs ${container}: ${res.stderr.trim()}`);
  const out = [];
  for (const line of `${res.stdout}\n${res.stderr}`.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // не JSON — пропускаем
    }
  }
  return out.sort((a, b) => String(a.t).localeCompare(String(b.t)));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ждать, пока fn() вернёт истинное значение; вернуть его или бросить по таймауту. */
export async function waitFor(fn, { timeoutMs = 30_000, intervalMs = 500, what = 'условие' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`не дождались: ${what} (${timeoutMs} мс)`);
    await sleep(intervalMs);
  }
}

/** Сервер снова видит 8/8 после момента since (симулятор восстановился). */
export async function waitAllOnline(since, total, { timeoutMs = 45_000 } = {}) {
  return waitFor(
    () => {
      const lines = containerLog(SERVER_CONTAINER, { since }).filter((l) => l.msg === 'devices_online');
      const last = lines.at(-1);
      return last && last.online === total && last.total === total ? last : null;
    },
    { timeoutMs, intervalMs: 1000, what: `devices_online ${total}/${total} в логе сервера` },
  );
}

// MQTT -------------------------------------------------------------------------------

/** Подключение без автопереподключения. */
export function connectMqtt({ clientId, username, password, protocolVersion = 4, will } = {}) {
  return mqtt.connectAsync(mqttUrl(), {
    clientId,
    username,
    password,
    ca: caCert(),
    rejectUnauthorized: true,
    protocolVersion,
    clean: true,
    keepalive: 30,
    reconnectPeriod: 0,
    connectTimeout: 10_000,
    ...(will ? { will } : {}),
  });
}

/**
 * Свидетель под учёткой администратора брокера (MQTT_ADMIN_USER: роль Dynamic Security
 * читает #) со своим client id. Учётка сервера bl-server привязана к client id 'bl-server' —
 * под ней не подключаемся, чтобы не выбить живой сервер.
 */
export async function connectObserver() {
  const client = await connectMqtt({
    clientId: `bl-e2e-observer-${randomBytes(4).toString('hex')}`,
    username: env('MQTT_ADMIN_USER'),
    password: env('MQTT_ADMIN_PASSWORD'),
  });
  const messages = [];
  client.on('message', (t, payload, packet) => {
    messages.push({ at: Date.now(), topic: t, payload: payload.toString('utf8'), retain: Boolean(packet.retain) });
  });
  return { client, messages };
}

/** Коды SUBACK по каждому фильтру отдельно (одна подписка — один SUBSCRIBE). */
export async function subscribeEach(client, filters) {
  const result = {};
  for (const f of filters) {
    try {
      const granted = await client.subscribeAsync(f, { qos: 1 });
      result[f] = granted[0]?.qos;
    } catch (err) {
      // mqtt.js отдаёт отказ ошибкой с пакетом SUBACK: берём код из него.
      result[f] = err.packet?.granted?.[0] ?? `error:${err.message}`;
    }
  }
  return result;
}

/** Публикация QoS 1; вернуть код PUBACK (MQTT 5) или 0 / ошибку. */
export function publishQos1(client, t, payload, { retain = false } = {}) {
  return new Promise((resolve) => {
    client.publish(t, payload, { qos: 1, retain }, (err, packet) => {
      if (err) resolve({ ok: false, code: err.code ?? null, message: err.message });
      else resolve({ ok: true, code: packet?.reasonCode ?? 0 });
    });
  });
}

// Протокол v1: независимая от server/ и tools/device-sim/ реализация канонизации ----------

/** Каноническая строка §3.1 для значений из целых, ASCII-строк, bool, null, массивов, объектов. */
export function canonical(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error('не целое число');
    return String(value);
  }
  if (typeof value === 'string') {
    if (!/^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/.test(value)) throw new Error('строка вне печатного ASCII');
    return `"${value}"`;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return `{${keys.map((k) => `${canonical(k)}:${canonical(value[k])}`).join(',')}}`;
}

export function signCommand(cmd, keyB64) {
  const { sig: _sig, ...rest } = cmd;
  const text = canonical(rest);
  const sig = createHmac('sha256', Buffer.from(keyB64, 'base64')).update(text, 'utf8').digest('base64');
  return { canonical: text, sig };
}

export function verifySig(cmd, keyB64) {
  if (typeof cmd.sig !== 'string' || cmd.sig.length !== 44) return false;
  const { sig } = signCommand(cmd, keyB64);
  return timingSafeEqual(Buffer.from(sig), Buffer.from(cmd.sig));
}
