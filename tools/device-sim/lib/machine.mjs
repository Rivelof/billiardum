// Конечный автомат одного контроллера стола, без MQTT.
// Вход: байты команды из `cmd`, ход часов, наличие связи. Выход: публикации через `output()`.
// Часы, NVS и источник случайности передаются снаружи — тесты гоняют время вперёд
// (FakeClock) и проверяют, что лежит в NVS. Повторяет логику прошивки (docs/protocol.md §3–§5).
//
// M0: исполняются `ping` и `identify`; остальные типы после проверки формата, подписи,
// seq и тела отвечают `unknown_type`. Сессии, сигналы, правило 4, датчик тока — M1.

import { randomBytes } from 'node:crypto';
import { verifyCommand } from './command.mjs';
import { ackPayload, decideReplay } from './replay.mjs';
import { validateBody } from './body.mjs';
import { EXECUTED_IN_M0, ledFor, relayFor } from './modes.mjs';
import { EVENT_RING_CAPACITY, EventRing, MemoryNvs, NVS_KEYS } from './nvs.mjs';

export const STATE_PERIOD_MS = 60_000;
export const REJECT_EVENT_INTERVAL_MS = 10_000; // bad_sig, replayed_seq — не чаще раза в 10 с на тип
export const DEFAULT_CAPS = Object.freeze(['relay', 'led', 'buzzer', 'current']);
export const SIM_FW = '0.1.0-sim';
export const SIM_RSSI = -55;
export const SIM_LAMP_CURRENT_MA = 400;

const randomBootId = () => randomBytes(4).toString('hex');

/**
 * Выходы автомата (поле kind):
 * - `state`   { payload, state, changed } — публикация в `state` (retained);
 * - `ack`     { payload } — публикация в `ack`;
 * - `event`   { entry } — новое событие; отправлять то, что вернёт outbox();
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
  #newBootId;

  #boot = 0;
  #bootId = '';
  #eventN = 0;
  #bootAt = 0;
  #stateSeq = 0;
  #lastSeq = 0; // последний принятый seq (в NVS — блоком вместе с id и ack)
  #lastKey = null;
  #periodicTimer = null;
  #online = false;
  #droppedEvent = null; // events_dropped, ещё не доставленное
  #droppedPersisted = false;
  #rejects = new Map(); // тип события → { at, suppressed }

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
   *   bootId?: () => string,
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
    this.#newBootId = options.bootId ?? randomBootId;
    this.#ring = new EventRing(this.#nvs, options.ringCapacity ?? EVENT_RING_CAPACITY);
  }

  get boot() {
    return this.#boot;
  }

  get bootId() {
    return this.#bootId;
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
   * Загрузка: свет выключен, `boot` + 1 в NVS, новый `boot_id`, событие `boot`, первый `state`.
   * @param {{ resetReason?: string }} [options] reset_reason по §4 (`poweron`, `sw`, …)
   */
  start(options = {}) {
    this.stop(); // после перезагрузки (M1) таймеры прошлой загрузки не живут
    this.#boot = (this.#nvs.get(NVS_KEYS.boot) ?? 0) + 1;
    this.#nvs.set(NVS_KEYS.boot, this.#boot);
    this.#bootId = this.#newBootId();
    this.#eventN = 0;
    this.#bootAt = this.#clock.now();
    this.#lastSeq = this.#nvs.get(NVS_KEYS.replay)?.seq ?? 0;
    this.#stateSeq = 0;
    this.#lastKey = null;
    this.#online = false;
    this.#rejects.clear();
    this.#droppedEvent = this.#nvs.get(NVS_KEYS.droppedEvent) ?? null;
    this.#droppedPersisted = this.#droppedEvent !== null;
    this.#mode = 'free';
    this.#session = null;

    // §5 правило 4 (M1): сессия из NVS, 30 с ожидания session.resume от загрузки, offline_resumes.
    // В M0 сессий нет, NVS_KEYS.session не пишется — после загрузки всегда free.

    this.#emitEvent('boot', { fw: this.#fw, caps: [...this.#caps], reset_reason: options.resetReason ?? 'poweron' });
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

  /**
   * Связь с брокером есть или нет. Без связи недоставленные события пишутся в NVS
   * (§4: «в NVS пишутся только недоставленные»).
   */
  setOnline(online) {
    this.#online = online;
    if (!online) this.#persistEvents();
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

  /**
   * Что отправить в `event`: сначала `events_dropped`, если буфер переполнялся,
   * затем буфер от старого к новому. Из буфера событие уходит по eventDelivered().
   */
  outbox() {
    if (!this.#droppedEvent) {
      const count = this.#ring.takeDropped();
      if (count > 0) {
        this.#droppedEvent = this.#makeEvent('events_dropped', { count });
        this.#droppedPersisted = false;
      }
    }
    return [...(this.#droppedEvent ? [this.#droppedEvent] : []), ...this.#ring.list()];
  }

  /** Брокер подтвердил событие (PUBACK) — убрать из буфера. */
  eventDelivered(bootId, n) {
    const d = this.#droppedEvent;
    if (d && d.boot_id === bootId && d.n === n) {
      this.#droppedEvent = null;
      if (this.#droppedPersisted) this.#nvs.delete(NVS_KEYS.droppedEvent);
      this.#droppedPersisted = false;
      return true;
    }
    return this.#ring.remove(bootId, n);
  }

  /** Публикует `state` без изменения (после подключения к брокеру). */
  publishState() {
    this.#publishState({ force: true });
  }

  /**
   * Обработка байтов из топика `cmd`: §3.1 (формат, подпись), §3.2 (повтор), §3.3 (тип и тело).
   * @returns {{ result: string, reason?: string }}
   */
  handleCommand(payload) {
    const checked = verifyCommand(payload, this.#key);
    const { cmdId, seq, type } = checked.echo;

    if (checked.status !== 'ok') {
      // bad_format: cmd_id и seq — null (§4); bad_sig: из разобранной команды.
      this.#sendAck(ackPayload({ id: cmdId, seq, ok: false, error: checked.status, state_seq: this.#stateSeq }));
      if (checked.status === 'bad_sig') this.#emitRejectEvent('bad_sig', { cmd_id: cmdId, seq });
      return this.#report({ result: checked.status, reason: checked.reason, cmd_id: cmdId, seq, type });
    }

    const cmd = checked.cmd;
    const saved = this.#nvs.get(NVS_KEYS.replay) ?? null;
    const decision = decideReplay(saved, cmd.seq, cmd.id);

    if (decision === 'resend') {
      this.#sendAck(ackPayload(saved));
      return this.#report({ result: 'resend', cmd_id: cmd.id, seq: cmd.seq, type: cmd.type });
    }
    if (decision === 'replayed') {
      this.#sendAck(ackPayload({ id: cmd.id, seq: cmd.seq, ok: false, error: 'replayed_seq', state_seq: this.#stateSeq }));
      this.#emitRejectEvent('replayed_seq', { cmd_id: cmd.id, seq: cmd.seq });
      return this.#report({ result: 'replayed_seq', cmd_id: cmd.id, seq: cmd.seq, type: cmd.type });
    }

    // С шага 4 seq принят: исполнить → записать блок в NVS → опубликовать ack (§3.2).
    this.#lastSeq = cmd.seq;
    const { ok, error, field } = this.#execute(cmd);
    const record = { seq: cmd.seq, id: cmd.id, ok, error: ok ? null : error, state_seq: this.#stateSeq };
    this.#nvs.set(NVS_KEYS.replay, record);
    this.#sendAck(ackPayload(record));
    return this.#report({ result: ok ? 'ok' : error, cmd_id: cmd.id, seq: cmd.seq, type: cmd.type, ...(field ? { reason: field } : {}) });
  }

  // Шаг 4 §3.1: тип, тело, исполнение. Состояние публикуется до ack,
  // чтобы ack.state_seq указывал на уже отправленный state.
  #execute(cmd) {
    const checked = validateBody(cmd.type, cmd.body);
    if (!checked.ok) return { ok: false, error: checked.error, field: checked.field };
    if (!EXECUTED_IN_M0.has(cmd.type)) return { ok: false, error: 'unknown_type' };
    const body = checked.body;
    switch (cmd.type) {
      case 'ping':
        this.#publishState({ force: true });
        return { ok: true, error: null };
      case 'identify': {
        if (!this.#caps.includes('led')) return { ok: false, error: 'hw_fault' };
        this.#clock.clearTimeout(this.#identifyTimer);
        this.#identifyTimer = this.#clock.setTimeout(() => {
          this.#identifyTimer = null;
          this.#publishState();
        }, body.duration_ms);
        this.#publishState();
        return { ok: true, error: null };
      }
      default:
        return { ok: false, error: 'unknown_type' };
    }
  }

  #sendAck(payload) {
    this.#output({ kind: 'ack', payload });
  }

  #report(info) {
    this.#output({ kind: 'command', info });
    return { result: info.result, reason: info.reason };
  }

  #makeEvent(type, data) {
    this.#eventN += 1;
    const event = { v: 1, boot: this.#boot, boot_id: this.#bootId, n: this.#eventN, type, at_uptime_ms: this.uptimeMs(), data };
    return { boot: this.#boot, boot_id: this.#bootId, n: this.#eventN, type, payload: JSON.stringify(event) };
  }

  #emitEvent(type, data) {
    const entry = this.#makeEvent(type, data);
    this.#ring.push(entry);
    if (!this.#online) this.#persistEvents();
    this.#output({ kind: 'event', entry });
  }

  // bad_sig и replayed_seq — не чаще одного каждого типа за 10 с; пропущенные — в data.suppressed следующего.
  #emitRejectEvent(type, data) {
    const now = this.uptimeMs();
    const r = this.#rejects.get(type) ?? { at: null, suppressed: 0 };
    if (r.at !== null && now - r.at < REJECT_EVENT_INTERVAL_MS) {
      r.suppressed += 1;
      this.#rejects.set(type, r);
      return;
    }
    this.#emitEvent(type, r.suppressed > 0 ? { ...data, suppressed: r.suppressed } : data);
    this.#rejects.set(type, { at: now, suppressed: 0 });
  }

  #persistEvents() {
    this.#ring.persist();
    if (this.#droppedEvent && !this.#droppedPersisted) {
      this.#nvs.set(NVS_KEYS.droppedEvent, this.#droppedEvent);
      this.#droppedPersisted = true;
    }
  }

  // «Изменение» по §4: mode, session_id, relay, dim, led, buzzer, caps.
  #changeKey() {
    const s = this.snapshot();
    return JSON.stringify([s.mode, s.session_id, s.relay, s.dim, s.led, s.buzzer, s.caps]);
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
