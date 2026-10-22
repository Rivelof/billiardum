// Конечный автомат одного контроллера стола, без MQTT — docs/protocol.md §3–§5.
// Вход: байты команды из `cmd`, ход часов, наличие связи, показания датчика тока.
// Выход: публикации и сигналы через `output()`.
//
// Модель времени — «сроки» (deadlines): автомат хранит абсолютные моменты (мс монотонных часов)
// следующих внутренних событий и держит один таймер на ближайший. Все события одного момента
// обрабатываются в постоянном порядке (#runDue). Прошивка (firmware/lib/logic/src/bl_machine.cpp)
// устроена так же: loop() зовёт tick(now), тест-раннер шагает по nextDeadline(). Поэтому общие
// сценарии tools/device-sim/scenarios/*.json дают одинаковый результат в обеих реализациях.

import { randomBytes } from 'node:crypto';
import { verifyCommand } from './command.mjs';
import { ackPayload, decideReplay } from './replay.mjs';
import { validateBody } from './body.mjs';
import { IDLE_MODES, ledFor, relayFor } from './modes.mjs';
import { EVENT_RING_CAPACITY, EventRing, MemoryNvs, NVS_KEYS } from './nvs.mjs';

export const STATE_PERIOD_MS = 60_000;
export const REJECT_EVENT_INTERVAL_MS = 10_000; // bad_sig, replayed_seq — не чаще раза в 10 с на тип
export const BOOT_WAIT_MS = 30_000; // §5 правило 4: ожидание session.resume после загрузки
export const SESSION_SAVE_MS = 60_000; // §5 правило 3: S — остаток в NVS раз в S
export const BLINK_OFF_MS = 300; // мигание лампой: выкл. 300 мс, вкл. 300 мс
export const WARN_BEEPS = 2; // T−5: 2 коротких сигнала
export const DEFAULT_CAPS = Object.freeze(['relay', 'led', 'buzzer', 'current']);
export const SIM_FW = '1.0.0-sim';
export const SIM_RSSI = -55;
export const SIM_LAMP_CURRENT_MA = 400;

// Значения config.set по умолчанию (§3.3; где протокол молчит — README «Где протокол оставляет выбор»).
export const DEFAULT_CONFIG = Object.freeze({
  led_brightness: 128,
  current_on_ma: 50,
  current_confirm_ms: 10_000,
  grace_dim: 30,
  grace_blink_s: 15,
});

const randomBootId = () => randomBytes(4).toString('hex');

/** Лампа исправна, обхода нет: ток пропорционален приглушению. */
export function defaultSensor({ lamp, dim }) {
  return lamp ? Math.round((SIM_LAMP_CURRENT_MA * dim) / 100) : 0;
}

/**
 * Выходы автомата (поле kind):
 * - `state`   { payload, state, changed } — публикация в `state` (retained);
 * - `ack`     { payload, cmd_id } — публикация в `ack`;
 * - `event`   { entry } — новое событие; отправлять то, что вернёт outbox();
 * - `command` { info } — итог обработки команды, для лога;
 * - `signal`  { name, beeps } — сигнал у стола: warn (T−5), blink2 (T−1), grace (начало льготы), grace_blink;
 * - `relay`   { on: true, cmd_id, type } — свет включён командой session.start/session.resume (метрика);
 * - `ota`     { url, version, sha256, image_sig } — платформе начать обновление;
 * - `ota_abort` {} — платформе прервать загрузку (стол занят командой сервера).
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
  #sensor;
  #timer = null;

  #t = 0; // время обработки: момент срока или команды; не убывает
  #boot = 0;
  #bootId = '';
  #eventN = 0;
  #bootAt = 0;
  #stateSeq = 0;
  #lastSeq = 0; // последний принятый seq (в NVS — блоком вместе с id и ack)
  #lastKey = null;
  #periodicAt = null;
  #online = false;
  #droppedEvent = null; // events_dropped, ещё не доставленное
  #droppedPersisted = false;
  #rejects = new Map(); // тип события → { at, suppressed }
  #config = { ...DEFAULT_CONFIG };

  #mode = 'free'; // базовое состояние; `fault` накладывается поверх free/pending/reserved
  #session = null; // { id, endAt, warn: [w0, w1], grace, buzzer, signaled, graceEndAt, offlineResumes }
  #bootPending = null; // сессия из NVS, ждёт ответа сервера (правило 4)
  #bootWindowAt = null;
  #serviceEndAt = null;
  #holdEndAt = null; // pending / reserved
  #identifyEndAt = null;
  #checkpointAt = null;
  #pulses = []; // [{ at, on }] — шаги мигания лампой
  #lampOff = false; // лампа погашена миганием при включённом реле
  #graceBlinkAt = null;
  #otaBusy = false;
  #otaVersion = null;
  #currentMa = null;
  #bypass = { since: null, latched: false };
  #lampFault = { since: null, latched: false };
  #signals = { warn: 0, beep: 0, blink2: 0, grace: 0, grace_blink: 0 };

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
   *   sensor?: (lamp: { lamp: boolean, dim: number }) => number,
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
    this.#sensor = options.sensor ?? defaultSensor;
    this.#ring = new EventRing(this.#nvs, options.ringCapacity ?? EVENT_RING_CAPACITY);
  }

  get boot() {
    return this.#boot;
  }

  get bootId() {
    return this.#bootId;
  }

  /** Состояние для `state.mode` (с наложенным `fault`). */
  get mode() {
    return this.#reportedMode();
  }

  get caps() {
    return this.#caps;
  }

  /** Лампа горит физически: реле включено и не погашено миганием. */
  get lamp() {
    return this.#lampOn();
  }

  /** Счётчики сигналов после загрузки. */
  get signals() {
    return { ...this.#signals };
  }

  get config() {
    return { ...this.#config };
  }

  /** Сессия в NVS (для тестов и /sim/tables). */
  get nvsSession() {
    return this.#nvs.get(NVS_KEYS.session) ?? null;
  }

  /** Ждёт ли автомат ответа сервера после загрузки (правило 4). */
  get bootWaiting() {
    return this.#bootPending !== null;
  }

  uptimeMs() {
    return this.#clock.now() - this.#bootAt;
  }

  /**
   * Загрузка: свет выключен, `boot` + 1 в NVS, новый `boot_id`, событие `boot`, первый `state`.
   * Сессия из NVS ждёт ответа сервера BOOT_WAIT_MS (§5 правило 4).
   * @param {{ resetReason?: string }} [options] reset_reason по §4 (`poweron`, `sw`, …)
   */
  start(options = {}) {
    this.stop();
    const now = this.#clock.now();
    this.#t = now;
    this.#boot = (this.#nvs.get(NVS_KEYS.boot) ?? 0) + 1;
    this.#nvs.set(NVS_KEYS.boot, this.#boot);
    this.#bootId = this.#newBootId();
    this.#eventN = 0;
    this.#bootAt = now;
    this.#lastSeq = this.#nvs.get(NVS_KEYS.replay)?.seq ?? 0;
    this.#stateSeq = 0;
    this.#lastKey = null;
    this.#online = false;
    this.#rejects.clear();
    this.#droppedEvent = this.#nvs.get(NVS_KEYS.droppedEvent) ?? null;
    this.#droppedPersisted = this.#droppedEvent !== null;
    this.#config = { ...DEFAULT_CONFIG, ...(this.#nvs.get(NVS_KEYS.config) ?? {}) };
    this.#mode = 'free';
    this.#session = null;
    this.#serviceEndAt = null;
    this.#holdEndAt = null;
    this.#identifyEndAt = null;
    this.#checkpointAt = null;
    this.#pulses = [];
    this.#lampOff = false;
    this.#graceBlinkAt = null;
    this.#otaBusy = false;
    this.#bypass = { since: null, latched: false };
    this.#lampFault = { since: null, latched: false };
    this.#signals = { warn: 0, beep: 0, blink2: 0, grace: 0, grace_blink: 0 };

    const saved = this.#nvs.get(NVS_KEYS.session) ?? null;
    this.#bootPending = saved;
    this.#bootWindowAt = saved ? now + BOOT_WAIT_MS : null;

    this.#emitEvent('boot', { fw: this.#fw, caps: [...this.#caps], reset_reason: options.resetReason ?? 'poweron' });
    this.#evaluateSensor(now);
    this.#periodicAt = now + STATE_PERIOD_MS;
    this.#publishState({ force: true });
    this.#arm();
  }

  /** Останавливает таймер (выход из процесса, перезагрузка, конец теста). */
  stop() {
    this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  /**
   * Связь с брокером есть или нет. Без связи недоставленные события пишутся в NVS
   * (§4: «в NVS пишутся только недоставленные»).
   */
  setOnline(online) {
    this.#online = online;
    if (!online) this.#persistEvents();
  }

  /** Показания датчика тока изменились (симулятор: включили или сняли сбой). */
  sensorChanged() {
    const now = this.#sync();
    this.#evaluateSensor(now);
    this.#publishState();
    this.#arm();
  }

  /** Итог обновления от платформы: ok — после загрузки новой прошивки и подключения к брокеру. */
  otaResult(ok, version, error = null) {
    this.#sync();
    if (!ok && !this.#otaBusy) return; // обновление уже прервано командой (ota_failed: aborted)
    this.#otaBusy = false;
    if (ok) this.#emitEvent('ota_ok', { version, error: null });
    else this.#emitEvent('ota_failed', { version, error: error ?? 'unknown' });
    this.#arm();
  }

  /** Текущее состояние в формате `state` (§4). */
  snapshot() {
    return this.#snapshotAt(Math.max(this.#clock.now(), this.#t));
  }

  #snapshotAt(now) {
    const mode = this.#reportedMode();
    const relay = this.#relayOn();
    const s = this.#session;
    let remaining = null;
    if (s) remaining = this.#mode === 'grace' ? 0 : Math.max(0, s.endAt - now);
    else if (this.#mode === 'service') remaining = Math.max(0, this.#serviceEndAt - now);
    return {
      v: 1,
      state_seq: this.#stateSeq,
      mode,
      session_id: s?.id ?? null,
      remaining_ms: remaining,
      relay,
      dim: this.#dimLevel(),
      led: this.#identifyEndAt !== null ? 'identify' : ledFor(mode),
      buzzer: s?.buzzer ?? false,
      current_ma: this.#caps.includes('current') ? this.#currentMa : null,
      caps: [...this.#caps],
      fw: this.#fw,
      boot: this.#boot,
      rssi: SIM_RSSI,
      uptime_s: Math.floor((now - this.#bootAt) / 1000),
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

  /** Публикует `state` без изменения (после подключения к брокеру): остаток — на сейчас. */
  publishState() {
    this.#sync();
    this.#publishState({ force: true });
    this.#arm();
  }

  /**
   * Обработка байтов из топика `cmd`: §3.1 (формат, подпись), §3.2 (повтор), §3.3 (тип и тело).
   * @returns {{ result: string, reason?: string }}
   */
  handleCommand(payload) {
    const now = this.#sync();
    try {
      return this.#handleCommand(payload, now);
    } finally {
      this.#arm();
    }
  }

  #handleCommand(payload, now) {
    const checked = verifyCommand(payload, this.#key);
    const { cmdId, seq, type } = checked.echo;

    if (checked.status !== 'ok') {
      // bad_format: cmd_id и seq — null (§4); bad_sig: из разобранной команды.
      this.#sendAck(ackPayload({ id: cmdId, seq, ok: false, error: checked.status, state_seq: this.#stateSeq }), cmdId);
      if (checked.status === 'bad_sig') this.#emitRejectEvent('bad_sig', { cmd_id: cmdId, seq });
      return this.#report({ result: checked.status, reason: checked.reason, cmd_id: cmdId, seq, type });
    }

    const cmd = checked.cmd;
    const saved = this.#nvs.get(NVS_KEYS.replay) ?? null;
    const decision = decideReplay(saved, cmd.seq, cmd.id);

    if (decision === 'resend') {
      this.#sendAck(ackPayload(saved), cmd.id);
      return this.#report({ result: 'resend', cmd_id: cmd.id, seq: cmd.seq, type: cmd.type });
    }
    if (decision === 'replayed') {
      this.#sendAck(ackPayload({ id: cmd.id, seq: cmd.seq, ok: false, error: 'replayed_seq', state_seq: this.#stateSeq }), cmd.id);
      this.#emitRejectEvent('replayed_seq', { cmd_id: cmd.id, seq: cmd.seq });
      return this.#report({ result: 'replayed_seq', cmd_id: cmd.id, seq: cmd.seq, type: cmd.type });
    }

    // С шага 4 seq принят: исполнить → записать блок в NVS → опубликовать ack (§3.2).
    // state уходит до ack, поэтому ack.state_seq указывает на уже опубликованный state.
    this.#lastSeq = cmd.seq;
    const { ok, error, field, force } = this.#execute(cmd, now);
    this.#evaluateSensor(now);
    this.#publishState({ force: Boolean(force) });
    const record = { seq: cmd.seq, id: cmd.id, ok, error: ok ? null : error, state_seq: this.#stateSeq };
    this.#nvs.set(NVS_KEYS.replay, record);
    this.#sendAck(ackPayload(record), cmd.id);
    return this.#report({ result: ok ? 'ok' : error, cmd_id: cmd.id, seq: cmd.seq, type: cmd.type, ...(field ? { reason: field } : {}) });
  }

  // Шаг 4 §3.1: тип, тело, исполнение (таблица переходов — lib/modes.mjs).
  #execute(cmd, now) {
    const checked = validateBody(cmd.type, cmd.body);
    if (!checked.ok) return { ok: false, error: checked.error, field: checked.field };
    const body = checked.body;
    const OK = { ok: true, error: null };
    const fail = (error) => ({ ok: false, error });

    switch (cmd.type) {
      case 'ping':
        return { ...OK, force: true };

      case 'identify':
        if (!this.#caps.includes('led')) return fail('hw_fault');
        this.#identifyEndAt = now + body.duration_ms;
        return OK;

      case 'config.set':
        this.#config = { ...this.#config, ...body };
        this.#nvs.set(NVS_KEYS.config, this.#config);
        return OK;

      case 'ota.start':
        if (this.#reportedMode() !== 'free' || this.#bootPending || this.#otaBusy) return fail('busy_ota');
        this.#otaBusy = true;
        this.#otaVersion = body.version;
        this.#output({ kind: 'ota', url: body.url, version: body.version, sha256: body.sha256, image_sig: body.image_sig });
        return OK;

      case 'session.start':
      case 'session.resume': {
        const wasOn = this.#relayOn();
        this.#abortOta();
        this.#resolveBootWait();
        const p = {
          id: body.session_id, remaining: body.remaining_ms, warn: body.warn_ms, grace: body.grace_ms, buzzer: body.buzzer,
        };
        if (this.#session?.id === p.id) {
          this.#continueSession(now, p);
        } else {
          this.#leaveCurrent(now);
          this.#beginSession(now, p, 0);
        }
        if (!wasOn && this.#relayOn()) this.#output({ kind: 'relay', on: true, cmd_id: cmd.id, type: cmd.type });
        return OK;
      }

      case 'session.extend': {
        const s = this.#session;
        if (!s || s.id !== body.session_id) return fail('wrong_session');
        s.endAt = now + body.remaining_ms;
        s.buzzer = body.buzzer;
        s.graceEndAt = null;
        this.#graceBlinkAt = null;
        this.#applyPhase(now, true);
        this.#saveSession(now);
        return OK;
      }

      case 'session.stop': {
        const s = this.#session;
        if (s && s.id === body.session_id) {
          this.#endSession(now, false);
          return OK;
        }
        if (!s && this.#bootPending?.session_id === body.session_id) {
          this.#resolveBootWait(); // сессия из NVS стирается
          return OK;
        }
        return fail('wrong_session');
      }

      case 'service.start':
        if (this.#session) return fail('wrong_session');
        this.#abortOta();
        this.#resolveBootWait();
        this.#leaveCurrent(now);
        this.#mode = 'service';
        this.#serviceEndAt = now + body.duration_ms;
        return OK;

      case 'service.stop':
        if (this.#mode === 'service') this.#toFree();
        return OK;

      case 'state.free':
        this.#resolveBootWait();
        this.#leaveCurrent(now);
        this.#toFree();
        return OK;

      case 'state.pending':
      case 'state.reserved':
        if (this.#session || this.#mode === 'service') return fail('wrong_session');
        this.#abortOta();
        this.#resolveBootWait();
        this.#leaveCurrent(now);
        this.#mode = cmd.type === 'state.pending' ? 'pending' : 'reserved';
        this.#holdEndAt = now + body.until_ms;
        return OK;

      default:
        return fail('unknown_type');
    }
  }

  // Обновление идёт только в free: команда, занимающая стол, прерывает его,
  // иначе контроллер перезагрузился бы в новую прошивку посреди игры.
  #abortOta() {
    if (!this.#otaBusy) return;
    this.#otaBusy = false;
    this.#output({ kind: 'ota_abort' });
    this.#emitEvent('ota_failed', { version: this.#otaVersion, error: 'aborted' });
  }

  // ——— Сессия и сигналы (§5) ———

  // Команда сервера, задающая состояние, закрывает окно ожидания после загрузки:
  // сессия из NVS либо заменяется новой, либо стирается.
  #resolveBootWait() {
    if (!this.#bootPending) return;
    this.#bootPending = null;
    this.#bootWindowAt = null;
    this.#nvs.delete(NVS_KEYS.session);
  }

  // Снимает текущее состояние перед новым: сессия (без offline_session_finished), сервис, pending/reserved.
  #leaveCurrent(now) {
    if (this.#session) this.#endSession(now, false);
    this.#toFree();
  }

  #toFree() {
    this.#mode = 'free';
    this.#serviceEndAt = null;
    this.#holdEndAt = null;
  }

  #beginSession(now, p, offlineResumes) {
    this.#mode = 'active';
    this.#session = {
      id: p.id, endAt: now + p.remaining, warn: [...p.warn], grace: p.grace, buzzer: p.buzzer,
      signaled: 0, graceEndAt: null, offlineResumes,
    };
    this.#applyPhase(now, true);
    this.#saveSession(now);
  }

  /**
   * session.start / session.resume той же сессии (возврат онлайн, перезапуск сервера, сверка):
   * остаток и параметры заменяются, а фаза и прозвучавшие сигналы сохраняются — сигнал только при
   * переходе в другую фазу, как у session.extend (§5: команда в пределах той же фазы сигнала не даёт).
   */
  #continueSession(now, p) {
    const s = this.#session;
    s.endAt = now + p.remaining;
    s.warn = [...p.warn];
    s.grace = p.grace;
    s.buzzer = p.buzzer;
    s.graceEndAt = null;
    s.offlineResumes = 0; // §5 правило 4: сервер ответил — offline_resumes = 0
    this.#graceBlinkAt = null;
    this.#applyPhase(now, true);
    this.#saveSession(now);
  }

  // Фаза по остатку: 0 — больше warn[0], 1 — до warn[1], 2 — до нуля, 3 — льгота.
  #phaseAt(now) {
    const s = this.#session;
    const r = s.endAt - now;
    if (r <= 0) return 3;
    if (r <= s.warn[1]) return 2;
    if (r <= s.warn[0]) return 1;
    return 0;
  }

  /**
   * Режим и сигналы по остатку. byCommand — остаток задан командой: сигнал текущей фазы
   * звучит один раз сразу, если он ещё не звучал в этой фазе; остаток выше порога взводит
   * сигналы заново. По времени фаза только растёт, сигнал — при пересечении порога.
   */
  #applyPhase(now, byCommand) {
    const s = this.#session;
    const p = this.#phaseAt(now);
    if (p === 3) {
      this.#enterGrace(now);
      return;
    }
    if (s.signaled === 3) this.#stopPulses(); // выход из льготы продлением
    this.#mode = p === 0 ? 'active' : 'ending';
    if (p === 0) {
      s.signaled = 0;
    } else if (byCommand ? p !== s.signaled : p > s.signaled) {
      s.signaled = p;
      this.#fireSignal(now, p);
    }
  }

  #fireSignal(now, phase) {
    if (phase === 1) {
      const beeps = this.#session.buzzer && this.#caps.includes('buzzer') ? WARN_BEEPS : 0;
      this.#signals.warn += 1;
      this.#signals.beep += beeps;
      this.#output({ kind: 'signal', name: 'warn', beeps });
    } else if (phase === 2) {
      // Лампа дважды мигает: выкл. 300, вкл. 300, выкл. 300, вкл.
      this.#startPulses(now, 2);
      this.#signals.blink2 += 1;
      this.#output({ kind: 'signal', name: 'blink2', beeps: 0 });
    }
  }

  #enterGrace(now) {
    const s = this.#session;
    if (s.grace === 0) {
      this.#endSession(now, true);
      return;
    }
    this.#mode = 'grace';
    s.signaled = 3;
    s.graceEndAt = s.endAt + s.grace;
    this.#stopPulses();
    this.#signals.grace += 1;
    this.#output({ kind: 'signal', name: 'grace', beeps: 0 });
    if (!this.#caps.includes('dimmer')) this.#graceBlink(now);
    this.#saveSession(now);
  }

  #graceBlink(now) {
    this.#startPulses(now, 1);
    this.#graceBlinkAt = now + this.#config.grace_blink_s * 1000;
    this.#signals.grace_blink += 1;
    this.#output({ kind: 'signal', name: 'grace_blink', beeps: 0 });
  }

  // count погасаний лампы по BLINK_OFF_MS с паузой BLINK_OFF_MS; первое — сейчас.
  #startPulses(now, count) {
    this.#lampOff = true;
    this.#pulses = [];
    for (let i = 0; i < count; i += 1) {
      const off = now + 2 * i * BLINK_OFF_MS;
      if (i > 0) this.#pulses.push({ at: off, on: false });
      this.#pulses.push({ at: off + BLINK_OFF_MS, on: true });
    }
  }

  #stopPulses() {
    this.#pulses = [];
    this.#lampOff = false;
    this.#graceBlinkAt = null;
  }

  /** Конец сессии. natural — доиграна до конца льготы (не командой). */
  #endSession(now, natural) {
    const s = this.#session;
    this.#session = null;
    this.#mode = 'free';
    this.#stopPulses();
    this.#checkpointAt = null;
    this.#nvs.delete(NVS_KEYS.session);
    if (natural && !this.#online) {
      this.#emitEvent('offline_session_finished', { session_id: s.id, finished_uptime_ms: now - this.#bootAt });
    }
  }

  // Сессия в NVS: при каждом изменении остатка командой, в начале льготы (остаток 0) и раз в S.
  #saveSession(now) {
    const s = this.#session;
    const remaining = this.#mode === 'grace' ? 0 : Math.max(0, s.endAt - now);
    this.#nvs.set(NVS_KEYS.session, {
      session_id: s.id, remaining_ms: remaining, warn_ms: [...s.warn], grace_ms: s.grace, buzzer: s.buzzer,
      offline_resumes: s.offlineResumes,
    });
    this.#checkpointAt = this.#mode === 'grace' ? null : now + SESSION_SAVE_MS;
  }

  // §5 правило 4: сервер не ответил за BOOT_WAIT_MS.
  #bootWaitExpired(now) {
    const saved = this.#bootPending;
    this.#bootPending = null;
    this.#bootWindowAt = null;
    if (!saved) return;
    if (saved.offline_resumes >= 1) {
      this.#nvs.delete(NVS_KEYS.session);
      this.#emitEvent('offline_resume_denied', { session_id: saved.session_id });
      return;
    }
    const resumed = saved.remaining_ms - SESSION_SAVE_MS;
    if (resumed <= 0) {
      this.#nvs.delete(NVS_KEYS.session);
      return;
    }
    this.#beginSession(now, {
      id: saved.session_id, remaining: resumed, warn: saved.warn_ms, grace: saved.grace_ms, buzzer: saved.buzzer,
    }, 1);
    this.#emitEvent('offline_resume', { session_id: saved.session_id, saved_ms: saved.remaining_ms, resumed_ms: resumed });
  }

  // ——— Выходы ———

  #relayOn() {
    return relayFor(this.#mode);
  }

  #lampOn() {
    return this.#relayOn() && !this.#lampOff;
  }

  #dimLevel() {
    if (!this.#relayOn()) return 0;
    if (this.#mode === 'grace' && this.#caps.includes('dimmer')) return this.#config.grace_dim;
    return 100;
  }

  #faulty() {
    return this.#bypass.latched || this.#lampFault.latched;
  }

  #reportedMode() {
    if (IDLE_MODES.has(this.#mode) && this.#faulty()) return 'fault';
    return this.#mode;
  }

  // ——— Датчик тока (§5 правило 5) ———

  #evaluateSensor(now) {
    if (!this.#caps.includes('current')) return;
    const lamp = this.#lampOn();
    const dim = this.#dimLevel();
    const ma = Math.max(0, Math.round(this.#sensor({ lamp, dim })));
    this.#currentMa = ma;
    const onMa = this.#config.current_on_ma;
    track(this.#bypass, !this.#relayOn() && ma >= onMa, now);
    track(this.#lampFault, lamp && dim === 100 && ma < onMa, now);
  }

  #sensorDue(now) {
    const confirm = this.#config.current_confirm_ms;
    for (const [state, type] of [[this.#bypass, 'bypass_detected'], [this.#lampFault, 'lamp_fault']]) {
      if (state.since !== null && !state.latched && state.since + confirm <= now) {
        state.latched = true;
        this.#emitEvent(type, { current_ma: this.#currentMa });
      }
    }
  }

  // ——— Сроки ———

  #sessionDeadline() {
    const s = this.#session;
    if (!s) return null;
    if (this.#mode === 'grace') return s.graceEndAt;
    if (s.signaled === 0) return s.endAt - s.warn[0];
    if (s.signaled === 1) return s.endAt - s.warn[1];
    return s.endAt;
  }

  #sensorDeadline() {
    const confirm = this.#config.current_confirm_ms;
    const ds = [this.#bypass, this.#lampFault].filter((x) => x.since !== null && !x.latched).map((x) => x.since + confirm);
    return ds.length ? Math.min(...ds) : null;
  }

  #nextDeadline() {
    const all = [
      this.#bootWindowAt,
      this.#sessionDeadline(),
      this.#pulses[0]?.at ?? null,
      this.#graceBlinkAt,
      this.#serviceEndAt,
      this.#holdEndAt,
      this.#identifyEndAt,
      this.#checkpointAt,
      this.#sensorDeadline(),
      this.#periodicAt,
    ].filter((d) => d !== null);
    return all.length ? Math.min(...all) : null;
  }

  // Все события момента t — в постоянном порядке (тот же порядок в прошивке).
  #runDue(t) {
    if (this.#bootWindowAt !== null && this.#bootWindowAt <= t) this.#bootWaitExpired(t);
    for (let guard = 0; guard < 8; guard += 1) {
      const d = this.#sessionDeadline();
      if (d === null || d > t) break;
      if (this.#mode === 'grace') this.#endSession(t, true);
      else this.#applyPhase(t, false);
    }
    while (this.#pulses.length && this.#pulses[0].at <= t) this.#lampOff = !this.#pulses.shift().on;
    if (this.#graceBlinkAt !== null && this.#graceBlinkAt <= t) this.#graceBlink(t);
    if (this.#serviceEndAt !== null && this.#serviceEndAt <= t) this.#toFree();
    if (this.#holdEndAt !== null && this.#holdEndAt <= t) this.#toFree();
    if (this.#identifyEndAt !== null && this.#identifyEndAt <= t) this.#identifyEndAt = null;
    if (this.#checkpointAt !== null && this.#checkpointAt <= t) this.#saveSession(t);
    this.#evaluateSensor(t);
    this.#sensorDue(t);
    let periodic = false;
    if (this.#periodicAt !== null && this.#periodicAt <= t) {
      periodic = true;
      this.#periodicAt = t + STATE_PERIOD_MS;
    }
    this.#publishState({ force: periodic });
  }

  // Сроки до now — по порядку, каждый в свой момент; время обработки не идёт назад
  // (срок в прошлом, например после уменьшения current_confirm_ms, срабатывает сейчас).
  #advanceTo(now) {
    for (let guard = 0; guard < 10_000; guard += 1) {
      const d = this.#nextDeadline();
      if (d === null || d > now) return;
      this.#t = Math.max(d, this.#t);
      this.#runDue(this.#t);
    }
    throw new Error('автомат не сходится: сроки не убывают');
  }

  // Вход снаружи (команда, датчик, OTA): догнать сроки до текущего времени.
  #sync() {
    const now = Math.max(this.#clock.now(), this.#t);
    this.#advanceTo(now);
    this.#t = now;
    return now;
  }

  #arm() {
    this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    const d = this.#nextDeadline();
    if (d === null) return;
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null;
      this.#advanceTo(this.#clock.now());
      this.#arm();
    }, Math.max(0, d - this.#clock.now()));
  }

  // ——— Публикации и события ———

  #sendAck(payload, cmdId) {
    this.#output({ kind: 'ack', payload, cmd_id: cmdId });
  }

  #report(info) {
    this.#output({ kind: 'command', info });
    return { result: info.result, reason: info.reason };
  }

  #makeEvent(type, data) {
    this.#eventN += 1;
    const event = { v: 1, boot: this.#boot, boot_id: this.#bootId, n: this.#eventN, type, at_uptime_ms: this.#t - this.#bootAt, data };
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
    const now = this.#t - this.#bootAt;
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
    const s = this.#snapshotAt(this.#t);
    return JSON.stringify([s.mode, s.session_id, s.relay, s.dim, s.led, s.buzzer, s.caps]);
  }

  #publishState({ force = false } = {}) {
    const key = this.#changeKey();
    const changed = key !== this.#lastKey;
    if (!changed && !force) return;
    this.#lastKey = key;
    this.#stateSeq += 1;
    const state = this.#snapshotAt(this.#t);
    this.#output({ kind: 'state', payload: JSON.stringify(state), state, changed });
  }
}

function track(state, cond, now) {
  if (cond) {
    if (state.since === null) state.since = now;
  } else {
    state.since = null;
    state.latched = false;
  }
}

