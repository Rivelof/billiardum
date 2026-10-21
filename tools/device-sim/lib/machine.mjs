// Конечный автомат одного контроллера стола, без MQTT.
// Вход: байты команды из `cmd`, ход часов. Выход: публикации через `output()`.
// Часы и NVS передаются снаружи — тесты гоняют время вперёд (FakeClock)
// и проверяют, что лежит в NVS. Повторяет логику прошивки (docs/protocol.md §3–§5).
//
// M0: исполняются `ping` и `identify`; остальные типы после проверки формата,
// подписи и seq отвечают `unknown_type`. Сессии, сигналы, правило 4, датчик тока — M1.

import { verifyCommand } from './command.mjs';
import { decideReplay } from './replay.mjs';
import { EXECUTED_IN_M0, ledFor, relayFor } from './modes.mjs';
import { EventRing, MemoryNvs, NVS_KEYS } from './nvs.mjs';

export const STATE_PERIOD_MS = 60_000;
export const DEFAULT_CAPS = Object.freeze(['relay', 'led', 'buzzer', 'current']);
export const SIM_FW = '0.1.0-sim';
export const SIM_RSSI = -55;
export const SIM_LAMP_CURRENT_MA = 400;

/**
 * Выходы автомата (поле kind):
 * - `state`   { payload, state, changed } — публикация в `state` (retained);
 * - `ack`     { payload } — публикация в `ack`;
 * - `event`   { entry } — событие положено в кольцевой буфер, его нужно дослать;
 * - `command` { info } — итог обработки команды, для лога.
 */
export class TableMachine {
  #key;
  #nvs;
  #clock;
  #caps;
  #fw;
  #output;
  #ring;

  #boot = 0;
  #eventN = 0;
  #bootAt = 0;
  #stateSeq = 0;
  #lastSeq = 0; // последний принятый seq (в NVS — вместе с id и ack)
  #lastKey = null;
  #periodicTimer = null;

  #mode = 'free';
  #session = null; // M1: { session_id, remaining_ms, warn_ms, grace_ms, buzzer }
  #identifyTimer = null;

  /**
   * @param {{
   *   deviceKey: Buffer,
   *   clock: { now(): number, setTimeout(fn: () => void, ms: number): unknown, clearTimeout(h: unknown): void },
   *   nvs?: MemoryNvs,
   *   caps?: string[],
   *   fw?: string,
   *   ringCapacity?: number,
   *   output?: (msg: object) => void,
   * }} options
   */
  constructor(options) {
    if (!Buffer.isBuffer(options.deviceKey) || options.deviceKey.length !== 32) {
      throw new TypeError('deviceKey — Buffer из 32 байт');
    }
    this.#key = options.deviceKey;
    this.#clock = options.clock;
    this.#nvs = options.nvs ?? new MemoryNvs();
    this.#caps = Object.freeze([...(options.caps ?? DEFAULT_CAPS)]);
    this.#fw = options.fw ?? SIM_FW;
    this.#output = options.output ?? (() => {});
    this.#ring = new EventRing(this.#nvs, options.ringCapacity ?? 32);
  }

  get boot() {
    return this.#boot;
  }

  get mode() {
    return this.#mode;
  }

  get caps() {
    return this.#caps;
  }

  uptimeMs() {
    return this.#clock.now() - this.#bootAt;
  }

  /**
   * Загрузка: свет выключен, `boot` + 1 в NVS, событие `boot`, первый `state`.
   * @param {{ resetReason?: string }} [options]
   */
  start(options = {}) {
    this.stop(); // после перезагрузки (M1) таймеры прошлой загрузки не живут
    this.#boot = (this.#nvs.get(NVS_KEYS.boot) ?? 0) + 1;
    this.#nvs.set(NVS_KEYS.boot, this.#boot);
    this.#eventN = 0;
    this.#bootAt = this.#clock.now();
    this.#lastSeq = this.#nvs.get(NVS_KEYS.replay)?.seq ?? 0;
    this.#stateSeq = 0;
    this.#lastKey = null;
    this.#mode = 'free';
    this.#session = null;

    // §5 правило 4 (M1): сессия из NVS, 30 с ожидания session.resume, offline_resumes.
    // В M0 сессий нет, NVS_KEYS.session не пишется — после загрузки всегда free.

    this.#emitEvent('boot', { fw: this.#fw, caps: [...this.#caps], reset_reason: options.resetReason ?? 'power_on' });
    this.#publishState({ force: true });
    this.#armPeriodic();
  }

  /** Останавливает таймеры (выход из процесса, конец теста). */
  stop() {
    this.#clock.clearTimeout(this.#periodicTimer);
    this.#clock.clearTimeout(this.#identifyTimer);
    this.#periodicTimer = null;
    this.#identifyTimer = null;
  }

  /** Текущее состояние в формате `state` (§4). */
  snapshot() {
    const relay = relayFor(this.#mode);
    const hasCurrent = this.#caps.includes('current');
    return {
      v: 1,
      state_seq: this.#stateSeq,
      mode: this.#mode,
      session_id: this.#session?.session_id ?? null,
      remaining_ms: this.#session?.remaining_ms ?? null,
      relay,
      dim: relay ? 100 : 0,
      led: this.#identifyTimer ? 'identify' : ledFor(this.#mode),
      buzzer: this.#session?.buzzer ?? false,
      current_ma: hasCurrent ? (relay ? SIM_LAMP_CURRENT_MA : 0) : null,
      caps: [...this.#caps],
      fw: this.#fw,
      boot: this.#boot,
      rssi: SIM_RSSI,
      uptime_s: Math.floor(this.uptimeMs() / 1000),
      last_seq: this.#lastSeq,
    };
  }

  /** События в буфере, ещё не подтверждённые брокером (PUBACK). */
  pendingEvents() {
    return this.#ring.list();
  }

  /** Брокер подтвердил событие — убрать из буфера. */
  eventDelivered(boot, n) {
    return this.#ring.remove(boot, n);
  }

  /** Публикует `state` без изменения (после подключения к брокеру). */
  publishState() {
    this.#publishState({ force: true });
  }

  /**
   * Обработка байтов из топика `cmd`: §3.1 (формат, подпись), §3.2 (повтор), §3.3 (тип).
   * @returns {{ result: string, reason?: string }}
   */
  handleCommand(payload) {
    const checked = verifyCommand(payload, this.#key);
    const { cmdId, seq, type } = checked.echo;

    if (checked.status !== 'ok') {
      this.#sendAck(this.#ackPayload(cmdId, seq, false, checked.status));
      if (checked.status === 'bad_sig') this.#emitEvent('bad_sig', { cmd_id: cmdId, seq });
      return this.#report({ result: checked.status, reason: checked.reason, cmd_id: cmdId, seq, type });
    }

    const cmd = checked.cmd;
    const saved = this.#nvs.get(NVS_KEYS.replay) ?? null;
    const decision = decideReplay(saved, cmd.seq, cmd.id);

    if (decision === 'resend') {
      this.#sendAck(saved.ack);
      return this.#report({ result: 'resend', cmd_id: cmd.id, seq: cmd.seq, type: cmd.type });
    }
    if (decision === 'replayed') {
      this.#sendAck(this.#ackPayload(cmd.id, cmd.seq, false, 'replayed_seq'));
      this.#emitEvent('replayed_seq', { cmd_id: cmd.id, seq: cmd.seq });
      return this.#report({ result: 'replayed_seq', cmd_id: cmd.id, seq: cmd.seq, type: cmd.type });
    }

    this.#lastSeq = cmd.seq;
    const { ok, error } = this.#execute(cmd);
    const ack = this.#ackPayload(cmd.id, cmd.seq, ok, error);
    // seq, id и ack — одной записью: после сбоя питания не бывает seq без ack.
    this.#nvs.set(NVS_KEYS.replay, { seq: cmd.seq, id: cmd.id, ack });
    this.#sendAck(ack);
    return this.#report({ result: ok ? 'ok' : error, cmd_id: cmd.id, seq: cmd.seq, type: cmd.type });
  }

  // Шаг 4 §3.1: тип и тело. Состояние публикуется до ack, чтобы ack.state_seq
  // указывал на уже отправленный state.
  #execute(cmd) {
    if (!EXECUTED_IN_M0.has(cmd.type)) return { ok: false, error: 'unknown_type' };
    switch (cmd.type) {
      case 'ping':
        this.#publishState({ force: true });
        return { ok: true, error: null };
      case 'identify': {
        const duration = cmd.body.duration_ms;
        if (!Number.isSafeInteger(duration) || duration < 1) return { ok: false, error: 'bad_format' };
        if (!this.#caps.includes('led')) return { ok: false, error: 'hw_fault' };
        this.#clock.clearTimeout(this.#identifyTimer);
        this.#identifyTimer = this.#clock.setTimeout(() => {
          this.#identifyTimer = null;
          this.#publishState();
        }, duration);
        this.#publishState();
        return { ok: true, error: null };
      }
      default:
        return { ok: false, error: 'unknown_type' };
    }
  }

  #ackPayload(cmdId, seq, ok, error) {
    return JSON.stringify({ v: 1, cmd_id: cmdId, seq, ok, error: ok ? null : error, state_seq: this.#stateSeq });
  }

  #sendAck(payload) {
    this.#output({ kind: 'ack', payload });
  }

  #report(info) {
    this.#output({ kind: 'command', info });
    return { result: info.result, reason: info.reason };
  }

  #emitEvent(type, data) {
    this.#eventN += 1;
    const event = { v: 1, boot: this.#boot, n: this.#eventN, type, at_uptime_ms: this.uptimeMs(), data };
    const entry = { boot: this.#boot, n: this.#eventN, type, payload: JSON.stringify(event) };
    this.#ring.push(entry);
    this.#output({ kind: 'event', entry });
  }

  // «Изменение» — смена видимого состояния; остаток, uptime и last_seq сюда не входят.
  #changeKey() {
    const s = this.snapshot();
    return JSON.stringify([s.mode, s.session_id, s.relay, s.dim, s.led, s.buzzer]);
  }

  #publishState({ force = false } = {}) {
    const key = this.#changeKey();
    const changed = key !== this.#lastKey;
    if (!changed && !force) return;
    this.#lastKey = key;
    this.#stateSeq += 1;
    const state = this.snapshot();
    this.#output({ kind: 'state', payload: JSON.stringify(state), state, changed });
  }

  #armPeriodic() {
    this.#clock.clearTimeout(this.#periodicTimer);
    this.#periodicTimer = this.#clock.setTimeout(() => {
      this.#publishState({ force: true });
      this.#armPeriodic();
    }, STATE_PERIOD_MS);
  }
}
