// Исполнитель общих сценариев tools/device-sim/scenarios/*.json (формат — README, «Сценарии»).
// Те же файлы прогоняют нативные тесты прошивки (firmware/test/native/test_logic/test_scenarios.cpp);
// расхождение прошивки и симулятора — дефект.
//
// Сценарий идёт на ускоренных часах (FakeClock) и NVS в памяти; подпись — своя канонизация
// исполнителя (сортировка ключей), а не lib/canonical.mjs, чтобы не проверять код им же самим.

import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeClock } from './clock.mjs';
import { MemoryNvs } from './nvs.mjs';
import { DEFAULT_CAPS, SIM_LAMP_CURRENT_MA, TableMachine } from './machine.mjs';

export const SCENARIO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scenarios');
export const SCENARIO_KEY_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
export const OTHER_KEY_B64 = Buffer.alloc(32, 7).toString('base64');
export const SIM_BYPASS_CURRENT_MA = 380;
export const ISSUED_AT = 1792598400;

const STATE_FIELDS = ['mode', 'relay', 'dim', 'led', 'buzzer', 'remaining_ms', 'session_id', 'current_ma', 'last_seq', 'boot'];
const ACTIONS = ['cmd', 'raw', 'resend', 'advance_ms', 'reboot', 'net', 'fault', 'expect', 'events'];

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

/** Подписанная команда: тело в порядке сценария, подпись по сортированной записи. */
export function signScenarioCommand(cmd, keyB64) {
  const canonical = JSON.stringify(sortDeep(cmd));
  const sig = createHmac('sha256', Buffer.from(keyB64, 'base64')).update(canonical, 'utf8').digest('base64');
  return JSON.stringify({ ...cmd, sig });
}

export function scenarioCommandId(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** Датчик тока симулятора: лампа (с учётом приглушения), обход, неисправная лампа. */
export function simSensor(faults) {
  return ({ lamp, dim }) => {
    if (lamp) return faults.lampFault ? 0 : Math.round((SIM_LAMP_CURRENT_MA * dim) / 100);
    return faults.bypass ? SIM_BYPASS_CURRENT_MA : 0;
  };
}

// Частичное совпадение: ожидаемый объект — подмножество фактического; массивы и скаляры — точно.
function partialMismatch(expected, actual, where) {
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      return `${where}: ждали объект ${JSON.stringify(expected)}, есть ${JSON.stringify(actual)}`;
    }
    for (const [k, v] of Object.entries(expected)) {
      const m = partialMismatch(v, actual[k], `${where}.${k}`);
      if (m) return m;
    }
    return null;
  }
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    return `${where}: ждали ${JSON.stringify(expected)}, есть ${JSON.stringify(actual)}`;
  }
  return null;
}

/**
 * Прогоняет сценарий. Возвращает список расхождений (пустой — сценарий пройден).
 * @param {object} scenario разобранный JSON сценария
 * @returns {{ failures: string[], log: string[] }}
 */
export function runScenario(scenario) {
  const failures = [];
  const log = [];
  const keyB64 = scenario.key_b64 ?? SCENARIO_KEY_B64;
  const caps = scenario.caps ?? [...DEFAULT_CAPS];
  const clock = new FakeClock(0);
  const nvs = new MemoryNvs();
  const faults = { bypass: false, lampFault: false };
  const signals = { warn: 0, beep: 0, blink2: 0, grace: 0, grace_blink: 0 };
  const events = []; // созданные с прошлой проверки `events`
  const labels = new Map();
  let online = scenario.online ?? true;
  let boots = 0;
  let cmdCount = 0;
  let nextSeq = 1;
  let lastAck = null;
  let machine = null;

  const output = (m) => {
    if (m.kind === 'ack') lastAck = m.payload;
    if (m.kind === 'event') events.push(JSON.parse(m.entry.payload));
    if (m.kind === 'signal') {
      signals[m.name] += 1;
      signals.beep += m.beeps;
    }
  };
  const deliver = () => {
    if (!online) return;
    for (const e of machine.outbox()) machine.eventDelivered(e.boot_id, e.n);
  };
  const boot = (resetReason) => {
    boots += 1;
    machine = new TableMachine({
      deviceKey: Buffer.from(keyB64, 'base64'),
      clock,
      nvs,
      caps,
      bootId: () => `b00000${String(boots).padStart(2, '0')}`,
      output,
      sensor: simSensor(faults),
    });
    machine.start({ resetReason });
    machine.setOnline(online);
    deliver();
  };
  const feed = (raw) => {
    lastAck = null;
    machine.handleCommand(Buffer.from(raw, 'utf8'));
    deliver();
    return lastAck;
  };
  const checkAck = (i, ackRaw, expected) => {
    if (ackRaw === null) {
      failures.push(`шаг ${i}: нет ack`);
      return;
    }
    const ack = JSON.parse(ackRaw);
    const got = ack.ok ? 'ok' : ack.error;
    if (got !== expected) failures.push(`шаг ${i}: ack ${got}, ждали ${expected}`);
  };

  boot('poweron');
  scenario.steps.forEach((step, idx) => {
    const i = idx + 1;
    const action = ACTIONS.filter((a) => Object.hasOwn(step, a));
    if (action.length !== 1) {
      failures.push(`шаг ${i}: нужно ровно одно действие из ${ACTIONS.join(', ')}`);
      return;
    }
    switch (action[0]) {
      case 'cmd': {
        cmdCount += 1;
        const seq = step.seq ?? nextSeq;
        nextSeq = Math.max(nextSeq, seq + 1);
        const cmd = { v: 1, id: step.id ?? scenarioCommandId(cmdCount), seq, type: step.cmd, issued_at: ISSUED_AT, body: step.body ?? {} };
        const raw = signScenarioCommand(cmd, step.key === 'other' ? OTHER_KEY_B64 : keyB64);
        const ack = feed(raw);
        checkAck(i, ack, step.ack ?? 'ok');
        if (step.label) labels.set(step.label, { raw, ack });
        log.push(`${i} ${step.cmd} seq=${seq} → ${ack}`);
        break;
      }
      case 'raw': {
        const ack = feed(step.raw);
        checkAck(i, ack, step.ack ?? 'bad_format');
        break;
      }
      case 'resend': {
        const prev = labels.get(step.resend);
        if (!prev) {
          failures.push(`шаг ${i}: нет метки ${step.resend}`);
          break;
        }
        const ack = feed(prev.raw);
        if (step.ack_same && ack !== prev.ack) failures.push(`шаг ${i}: ack повтора ${ack} ≠ ${prev.ack}`);
        if (step.ack) checkAck(i, ack, step.ack);
        break;
      }
      case 'advance_ms':
        clock.advance(step.advance_ms);
        deliver();
        break;
      case 'reboot': {
        const opts = step.reboot === true ? {} : step.reboot;
        machine.stop();
        if (opts.down_ms) clock.advance(opts.down_ms);
        boot(opts.reset_reason ?? 'poweron');
        break;
      }
      case 'net':
        online = step.net;
        machine.setOnline(online);
        deliver();
        break;
      case 'fault':
        if (step.fault === 'bypass') faults.bypass = step.on;
        else if (step.fault === 'lamp-fault') faults.lampFault = step.on;
        else failures.push(`шаг ${i}: неизвестный сбой ${step.fault}`);
        machine.sensorChanged();
        deliver();
        break;
      case 'expect': {
        const want = step.expect;
        const snap = machine.snapshot();
        for (const f of STATE_FIELDS) {
          if (!Object.hasOwn(want, f)) continue;
          const m = partialMismatch(want[f], snap[f], f);
          if (m) failures.push(`шаг ${i}: ${m}`);
        }
        const extra = {
          lamp: () => machine.lamp,
          signals: () => signals,
          nvs_session: () => machine.nvsSession,
          outbox: () => machine.outbox().map((e) => e.type),
          config: () => machine.config,
        };
        for (const [f, get] of Object.entries(extra)) {
          if (!Object.hasOwn(want, f)) continue;
          const m = partialMismatch(want[f], get(), f);
          if (m) failures.push(`шаг ${i}: ${m}`);
        }
        const unknown = Object.keys(want).filter((f) => !STATE_FIELDS.includes(f) && !Object.hasOwn(extra, f));
        if (unknown.length) failures.push(`шаг ${i}: неизвестные поля expect: ${unknown.join(', ')}`);
        break;
      }
      case 'events': {
        const want = step.events.map((e) => (typeof e === 'string' ? { type: e } : e));
        const got = events.splice(0);
        if (want.length !== got.length) {
          failures.push(`шаг ${i}: события ${JSON.stringify(got.map((e) => e.type))}, ждали ${JSON.stringify(want.map((e) => e.type))}`);
          break;
        }
        want.forEach((w, k) => {
          const m = partialMismatch(w, got[k], `events[${k}]`);
          if (m) failures.push(`шаг ${i}: ${m}`);
        });
        break;
      }
      default:
        break;
    }
  });
  machine.stop();
  return { failures, log };
}

/** Все сценарии из папки: [{ file, scenario }]. */
export function loadScenarios(dir = SCENARIO_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({ file, scenario: JSON.parse(readFileSync(path.join(dir, file), 'utf8')) }));
}
