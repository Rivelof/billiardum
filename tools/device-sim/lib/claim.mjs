// Режим «новый контроллер» (protocol §7, решения №67 и №159, контракт M5.1 §2).
// Контроллер стартует только с заводскими device_id и claim_code (наклейка, QR
// BLD1:{device_id}:{claim_code}), повторяет POST /api/devices/claim, пока владелец не начнёт
// привязку в программе клуба, сохраняет полученные ключи в свой файл и дальше работает как
// обычный стол (lib/device.mjs).
//
// Повторяет прошивку: firmware/lib/logic/src/bl_claim.cpp (разбор и задержки) и
// firmware/lib/platform/src/bl_provisioning.cpp (запрос, проверка ответа). Общие векторы —
// test/claim-vectors.json. Код привязки, пароль MQTT и device_key в лог не пишутся.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { decodeBase64Strict, isUuid } from './command.mjs';
import { FaultError, SimDevice } from './device.mjs';

export const CLAIM_QR_PREFIX = 'BLD1:';
export const CLAIM_RETRY_MIN_MS = 5000;
export const CLAIM_RETRY_MAX_MS = 30_000;
export const CLAIM_RATE_LIMITED_MS = 60_000;
export const CLAIM_TIMEOUT_MS = 15_000; // как cfg.timeout_ms в прошивке
const CLAIM_RESPONSE_MAX = 4096; // прошивка читает ответ не больше 4 КБ
const CLAIM_CODE = /^[A-Za-z0-9-]{8,63}$/;
const ERROR_CODE = /^[a-z0-9_]{1,32}$/;
const UUID_ANY_CASE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/** Код привязки: 8…63 символа [A-Za-z0-9-] — он же пароль WPA2 точки доступа. Регистр значим. */
export function isClaimCode(value) {
  return typeof value === 'string' && CLAIM_CODE.test(value);
}

/**
 * Аргументы консольной команды прошивки `factory`: [device_id, claim_code] или [строка QR].
 * device_id — UUID в любом регистре, возвращается строчными.
 * @param {string[]} args
 * @returns {{ deviceId: string, claimCode: string } | null}
 */
export function parseFactoryArgs(args) {
  if (!Array.isArray(args) || args.length === 0 || args.length > 2) return null;
  const [a, b = ''] = args;
  if (typeof a !== 'string' || typeof b !== 'string') return null;
  let id;
  let code;
  if (a.startsWith(CLAIM_QR_PREFIX)) {
    if (b !== '') return null;
    const sep = a.indexOf(':', CLAIM_QR_PREFIX.length);
    if (sep < 0) return null;
    id = a.slice(CLAIM_QR_PREFIX.length, sep);
    code = a.slice(sep + 1);
  } else {
    id = a;
    code = b;
  }
  if (!UUID_ANY_CASE.test(id) || !isClaimCode(code)) return null;
  return { deviceId: id.toLowerCase(), claimCode: code };
}

/**
 * Задержка перед следующей попыткой после failures неудач подряд — как bl::claimRetryDelayMs.
 * -1 — без автоматического повтора (сервер не примет данные с наклейки).
 */
export function claimRetryDelayMs(failures, error) {
  if (error === 'bad_request' || error === 'http_400') return -1;
  if (error === 'rate_limited' || error === 'http_429') return CLAIM_RATE_LIMITED_MS;
  let ms = CLAIM_RETRY_MIN_MS;
  for (let i = 1; i < failures && ms < CLAIM_RETRY_MAX_MS; i += 1) ms *= 2;
  return Math.min(ms, CLAIM_RETRY_MAX_MS);
}

/** Случайная добавка до 20 %, как esp_random() % (delay / 5 + 1) в прошивке. */
export function withJitter(ms, random = Math.random) {
  return ms + Math.floor(random() * (Math.floor(ms / 5) + 1));
}

/**
 * `--claim BLD1:{device_id}:{claim_code}[@номер]`. Номер — только для HTTP-управления и лога
 * симулятора, настоящий стол выбирает владелец при привязке. В сообщении об ошибке нет кода.
 * @returns {{ deviceId: string, claimCode: string, table: number | null }}
 */
export function parseClaimSpec(spec) {
  if (typeof spec !== 'string') throw new TypeError('--claim: нужна строка QR');
  const at = spec.lastIndexOf('@');
  const qr = at >= 0 ? spec.slice(0, at) : spec;
  const num = at >= 0 ? spec.slice(at + 1) : null;
  if (!qr.startsWith(CLAIM_QR_PREFIX)) throw new TypeError(`--claim: строка QR начинается с ${CLAIM_QR_PREFIX}`);
  const factory = parseFactoryArgs([qr]);
  if (!factory) {
    throw new TypeError('--claim: нужно BLD1:{device_id}:{claim_code}[@номер], device_id — UUID, код — 8…63 символа [A-Za-z0-9-]');
  }
  if (num !== null && !/^[1-9][0-9]{0,5}$/.test(num)) throw new TypeError('--claim: номер после @ — целое 1…999999');
  return { ...factory, table: num === null ? null : Number(num) };
}

/**
 * Проверка ответа 200 так же, как claimDevice в прошивке.
 * @returns {{ club_id, mqtt_url, mqtt_username, mqtt_password, device_key } | null}
 */
export function validateClaimResponse(json) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return null;
  const { mqtt_username: user, mqtt_password: pass, device_key: key, mqtt_url: url, club_id: club } = json;
  if (typeof user !== 'string' || typeof pass !== 'string' || pass === '') return null;
  const keyBytes = decodeBase64Strict(key);
  if (!keyBytes || keyBytes.length !== 32) return null;
  if (typeof url !== 'string' || !url.startsWith('mqtts://')) return null;
  if (!isUuid(club)) return null;
  return { club_id: club, mqtt_url: url, mqtt_username: user, mqtt_password: pass, device_key: key };
}

/**
 * Один POST {apiUrl}/api/devices/claim {device_id, claim_code}.
 * @returns {Promise<{ ok: true, creds: object } | { ok: false, error: string, status: number }>}
 *   error — код сервера ([a-z0-9_]), иначе network, bad_response или http_<статус>.
 */
export function postClaim({ apiUrl, ca = null, deviceId, claimCode, timeoutMs = CLAIM_TIMEOUT_MS }) {
  const url = new URL(`${apiUrl.replace(/\/+$/, '')}/api/devices/claim`);
  const body = JSON.stringify({ device_id: deviceId, claim_code: claimCode });
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    const req = mod.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: timeoutMs,
      ...(url.protocol === 'https:' ? { ca: ca ?? undefined, rejectUnauthorized: true } : {}),
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        if (size < CLAIM_RESPONSE_MAX) chunks.push(c);
        size += c.length;
      });
      res.on('error', () => finish({ ok: false, error: 'network', status: 0 }));
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        let json = null;
        if (size <= CLAIM_RESPONSE_MAX) {
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            json = null;
          }
        }
        if (status !== 200) {
          const code = json && typeof json.error === 'string' && ERROR_CODE.test(json.error) ? json.error : `http_${status}`;
          finish({ ok: false, error: code, status });
          return;
        }
        const creds = validateClaimResponse(json);
        finish(creds ? { ok: true, creds } : { ok: false, error: 'bad_response', status });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => finish({ ok: false, error: 'network', status: 0 }));
    req.end(body);
  });
}

/**
 * Ключи привязки: файл `<device_id>.keys.json` (0600) в папке 0700 — как раздел bl_keys прошивки.
 * В нём секреты (пароль MQTT, device_key), поэтому он отдельно от NVS `<device_id>.json`.
 */
export class ClaimStore {
  #dir;

  constructor(dir) {
    this.#dir = dir;
  }

  get dir() {
    return this.#dir;
  }

  file(deviceId) {
    if (!isUuid(deviceId)) throw new TypeError('device_id — UUID');
    return path.join(this.#dir, `${deviceId}.keys.json`);
  }

  /** @returns {object | null} ключи или null, если привязки нет или файл не годится. */
  load(deviceId) {
    const file = this.file(deviceId);
    if (!existsSync(file)) return null;
    let data;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
    if (data?.device_id !== deviceId) return null;
    return validateClaimResponse(data);
  }

  save(deviceId, creds) {
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const file = this.file(deviceId);
    const tmp = `${file}.tmp`;
    const data = { v: 1, device_id: deviceId, ...creds };
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  }

  delete(deviceId) {
    rmSync(this.file(deviceId), { force: true });
  }
}

/**
 * Новый контроллер: ждёт привязки, затем — обычный SimDevice. Интерфейс для lib/control.mjs
 * тот же (table, status, setFault, setNet, reboot, inject, stop) плюс unclaim — как консольная
 * команда прошивки `unclaim`.
 */
export class ClaimingDevice {
  #o;
  #log;
  #store;
  #post;
  #schedule;
  #random;
  #inner = null;
  #timer = null;
  #stopped = false;
  #netUp = true;
  #inflight = false;
  #gen = 0; // поколение цикла привязки: ответ старой попытки после reboot/unclaim не учитывается
  #claim = { state: 'idle', attempts: 0, failures: 0, last_error: null, next_attempt_at: null, claimed_at: null, source: null };

  /**
   * @param {{
   *   factory: { deviceId: string, claimCode: string, table: number },
   *   apiUrl: string, apiCa?: Buffer | null, store: ClaimStore,
   *   mqttUrl?: string | null, ca?: Buffer | null, caps?: string[], faults?: object[],
   *   nvsDir?: string | null, nvs?: object, clock?: object, connect?: Function, reconnectMs?: number,
   *   log: object,
   *   post?: (req: { apiUrl, ca, deviceId, claimCode }) => Promise<object>,
   *   schedule?: (fn: () => void, ms: number) => { cancel(): void },
   *   random?: () => number,
   *   now?: () => number,
   * }} options
   */
  constructor(options) {
    this.#o = options;
    this.#store = options.store;
    this.#post = options.post ?? postClaim;
    this.#schedule = options.schedule ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(t) };
    });
    this.#random = options.random ?? Math.random;
    this.#log = options.log.child({ device_id: options.factory.deviceId, table: options.factory.table });
  }

  get table() {
    return this.#o.factory.table;
  }

  get deviceId() {
    return this.#o.factory.deviceId;
  }

  /** SimDevice после привязки, иначе null. */
  get device() {
    return this.#inner;
  }

  get claim() {
    return { ...this.#claim };
  }

  start() {
    const saved = this.#store.load(this.deviceId);
    if (saved) {
      this.#run(saved, 'stored');
      return;
    }
    this.#log.info('sim_claim_wait', { note: 'новый контроллер: ждёт привязки в программе клуба (QR BLD1)' });
    this.#claim = { ...this.#claim, state: 'waiting', source: null };
    this.#attemptSoon(0);
  }

  async stop() {
    this.#stopped = true;
    this.#cancel();
    await this.#inner?.stop();
  }

  status() {
    if (this.#inner) return { ...this.#inner.status(), claim: this.#claimStatus() };
    return {
      table: this.table,
      device_id: this.deviceId,
      club_id: null,
      powered: !this.#stopped,
      online: false,
      net_up: this.#netUp,
      faults: null,
      state: null,
      lamp: false,
      signals: null,
      boot_waiting: false,
      nvs_session: null,
      config: null,
      outbox: [],
      claim: this.#claimStatus(),
    };
  }

  setFault(name, on, ms = null) {
    if (this.#inner) return this.#inner.setFault(name, on, ms);
    if (name === 'net-drop') {
      this.setNet(!on);
      return { fault: name, on };
    }
    if (name === 'reboot') {
      if (on) this.reboot({ downMs: ms ?? 0 });
      return { fault: name, on };
    }
    throw new FaultError('not_claimed');
  }

  setNet(up) {
    if (this.#inner) {
      this.#inner.setNet(up);
      return;
    }
    if (typeof up !== 'boolean') throw new FaultError('bad_up');
    if (up === this.#netUp) return;
    this.#netUp = up;
    this.#log.warn('sim_net', { up });
    if (up && this.#claim.state === 'waiting') this.#attemptSoon(0); // как переподключение Wi-Fi
  }

  reboot({ downMs = 0, resetReason = 'poweron' } = {}) {
    if (this.#inner) {
      this.#inner.reboot({ downMs, resetReason });
      return;
    }
    if (!Number.isSafeInteger(downMs) || downMs < 0) throw new FaultError('bad_ms');
    // Перезагрузка непривязанного контроллера: цикл привязки с начала, счётчик неудач — с нуля.
    this.#log.warn('sim_reboot', { down_ms: downMs, reset_reason: resetReason, claim: this.#claim.state });
    this.#gen += 1;
    this.#cancel();
    this.#inflight = false;
    this.#claim = { ...this.#claim, state: 'waiting', failures: 0, last_error: null };
    this.#attemptSoon(downMs);
  }

  inject(raw) {
    if (!this.#inner) throw new FaultError('not_claimed');
    return this.#inner.inject(raw);
  }

  /** Сброс привязки (консоль прошивки `unclaim`): ключи стираются, контроллер снова ждёт привязки. */
  async unclaim() {
    this.#gen += 1;
    this.#cancel();
    this.#inflight = false;
    const inner = this.#inner;
    this.#inner = null;
    await inner?.stop();
    this.#store.delete(this.deviceId);
    this.#log.warn('sim_unclaim', { note: 'ключи привязки стёрты, контроллер ждёт новой привязки' });
    this.#claim = { state: 'waiting', attempts: 0, failures: 0, last_error: null, next_attempt_at: null, claimed_at: null, source: null };
    if (!this.#stopped) this.#attemptSoon(0);
  }

  // ——— Цикл привязки ———

  #claimStatus() {
    const c = this.#claim;
    const now = this.#now();
    return {
      state: c.state,
      attempts: c.attempts,
      failures: c.failures,
      last_error: c.last_error,
      next_attempt_in_ms: c.next_attempt_at === null ? null : Math.max(0, c.next_attempt_at - now),
      source: c.source,
    };
  }

  #now() {
    return this.#o.now ? this.#o.now() : Date.now();
  }

  #cancel() {
    this.#timer?.cancel();
    this.#timer = null;
    this.#claim.next_attempt_at = null;
  }

  #attemptSoon(ms) {
    this.#cancel();
    if (this.#stopped) return;
    this.#claim.next_attempt_at = this.#now() + ms;
    const gen = this.#gen;
    this.#timer = this.#schedule(() => {
      this.#timer = null;
      if (gen === this.#gen) this.#attempt();
    }, ms);
  }

  async #attempt() {
    if (this.#stopped || this.#inner || this.#inflight) return;
    this.#claim.next_attempt_at = null;
    if (!this.#netUp) {
      // Wi-Fi нет: код не тратим, ждём связи (как прошивка — раз в секунду проверяет Wi-Fi).
      this.#claim.last_error = 'network';
      return;
    }
    const gen = this.#gen;
    this.#inflight = true;
    this.#claim.attempts += 1;
    let res;
    try {
      res = await this.#post({ apiUrl: this.#o.apiUrl, ca: this.#o.apiCa ?? null, deviceId: this.deviceId, claimCode: this.#o.factory.claimCode });
    } catch {
      res = { ok: false, error: 'network', status: 0 };
    }
    if (gen !== this.#gen) return;
    this.#inflight = false;
    if (this.#stopped || this.#inner) return;
    if (res.ok) {
      this.#store.save(this.deviceId, res.creds);
      this.#claim = { ...this.#claim, state: 'claimed', last_error: null, claimed_at: this.#now() };
      this.#log.info('sim_claimed', { club_id: res.creds.club_id, attempts: this.#claim.attempts });
      this.#run(res.creds, 'claimed');
      return;
    }
    this.#claim.failures += 1;
    this.#claim.last_error = res.error;
    const base = claimRetryDelayMs(this.#claim.failures, res.error);
    if (base < 0) {
      this.#claim.state = 'failed';
      this.#log.error('sim_claim_failed', {
        error: res.error, failures: this.#claim.failures, retry_ms: -1,
        note: 'сервер не принял данные с наклейки; повтор — POST /sim/tables/{номер}/reboot',
      });
      return;
    }
    const delay = withJitter(base, this.#random);
    this.#log.warn('sim_claim_failed', { error: res.error, failures: this.#claim.failures, retry_ms: delay });
    this.#attemptSoon(delay);
  }

  #run(creds, source) {
    const o = this.#o;
    this.#claim = { ...this.#claim, state: 'claimed', source, next_attempt_at: null };
    const key = decodeBase64Strict(creds.device_key);
    this.#inner = new SimDevice({
      device: {
        deviceId: this.deviceId,
        clubId: creds.club_id,
        table: this.table,
        mqttUsername: creds.mqtt_username,
        mqttPassword: creds.mqtt_password,
        deviceKey: key,
      },
      mqttUrl: o.mqttUrl || creds.mqtt_url,
      ca: o.ca ?? null,
      caps: o.caps,
      faults: o.faults,
      nvsDir: o.nvsDir ?? null,
      nvs: o.nvs,
      clock: o.clock,
      connect: o.connect,
      reconnectMs: o.reconnectMs,
      log: o.log,
    });
    if (!this.#netUp) this.#inner.setNet(false);
    this.#inner.start();
    if (source === 'stored') this.#log.info('sim_claim_stored', { club_id: creds.club_id, note: 'ключи привязки из файла, claim не нужен' });
  }
}
