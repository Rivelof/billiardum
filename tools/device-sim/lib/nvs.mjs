// Хранилище NVS. Интерфейс повторяет то, что прошивка делает с NVS ESP32:
// запись ключа целиком и атомарно (nvs_set_blob + nvs_commit), чтение копии.
// В M0 — память процесса (MemoryNvs). В M1 сюда добавится хранилище в файле (SIM_NVS_DIR),
// а имитация перезагрузки передаст тот же объект новой загрузке автомата.
//
// interface Nvs {
//   get(key: string): unknown | undefined   // копия значения
//   set(key: string, value: unknown): void   // одна атомарная запись
//   delete(key: string): void
//   readonly writes: number                  // счётчик записей (для оценки износа флеша)
// }

export class MemoryNvs {
  #map = new Map();
  #writes = 0;

  get(key) {
    const value = this.#map.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  set(key, value) {
    this.#map.set(key, structuredClone(value));
    this.#writes += 1;
  }

  delete(key) {
    if (this.#map.delete(key)) this.#writes += 1;
  }

  get writes() {
    return this.#writes;
  }
}

// Ключи NVS (до 15 символов, как в ESP-IDF).
export const NVS_KEYS = Object.freeze({
  boot: 'boot', // счётчик загрузок, u32
  replay: 'replay', // { seq, id, ok, error, state_seq } последней принятой команды — одним блоком, §3.2
  session: 'session', // M1: session_id, остаток, параметры сигналов, offline_resumes (§5 правило 3)
  config: 'config', // M1: config.set
  ringMeta: 'ev_meta', // { head, count, dropped } кольцевого буфера
  ringSlot: (i) => `ev_${i}`,
  droppedEvent: 'ev_drop', // недоставленное событие events_dropped
});

export const EVENT_RING_CAPACITY = 64;

/**
 * Кольцевой буфер событий (§4): 64 события, при переполнении вытесняется самое старое
 * и растёт счётчик `dropped` (по нему автомат отправляет `events_dropped`).
 * Буфер живёт в памяти; в NVS пишутся только недоставленные — `persist()` вызывается,
 * когда связи нет. Каждый слот — отдельный ключ, чтобы запись не переписывала весь буфер.
 */
export class EventRing {
  #nvs;
  #capacity;
  #slots;
  #persisted;
  #head = 0;
  #count = 0;
  #dropped = 0;
  #metaDirty = false;

  constructor(nvs, capacity = EVENT_RING_CAPACITY) {
    this.#nvs = nvs;
    this.#capacity = capacity;
    this.#slots = new Array(capacity).fill(null);
    this.#persisted = new Array(capacity).fill(false);
    const meta = nvs.get(NVS_KEYS.ringMeta);
    if (meta) {
      // После перезагрузки (M1): недоставленные события из NVS. Слот без записи — дыра,
      // событие было в полёте и в NVS не попало.
      this.#head = meta.head;
      this.#count = meta.count;
      this.#dropped = meta.dropped;
      for (let i = 0; i < meta.count; i += 1) {
        const idx = (meta.head + i) % capacity;
        this.#slots[idx] = nvs.get(NVS_KEYS.ringSlot(idx)) ?? null;
        this.#persisted[idx] = this.#slots[idx] !== null;
      }
    }
  }

  get capacity() {
    return this.#capacity;
  }

  get size() {
    return this.list().length;
  }

  get dropped() {
    return this.#dropped;
  }

  /** @param {{ boot: number, boot_id: string, n: number, type: string, payload: string }} entry */
  push(entry) {
    if (this.#count === this.#capacity) {
      this.#clearSlot(this.#head);
      this.#head = (this.#head + 1) % this.#capacity;
      this.#count -= 1;
      this.#dropped += 1;
    }
    const idx = (this.#head + this.#count) % this.#capacity;
    this.#slots[idx] = entry;
    this.#persisted[idx] = false;
    this.#count += 1;
    this.#metaDirty = true;
  }

  /** Сколько событий вытеснено; счётчик обнуляется (событие events_dropped создано). */
  takeDropped() {
    const n = this.#dropped;
    if (n > 0) {
      this.#dropped = 0;
      this.#metaDirty = true;
    }
    return n;
  }

  /** События от старого к новому. */
  list() {
    const out = [];
    for (let i = 0; i < this.#count; i += 1) {
      const entry = this.#slots[(this.#head + i) % this.#capacity];
      if (entry) out.push(entry);
    }
    return out;
  }

  /** Связи нет: недоставленные события и состояние буфера — в NVS. */
  persist() {
    for (let i = 0; i < this.#count; i += 1) {
      const idx = (this.#head + i) % this.#capacity;
      if (this.#slots[idx] && !this.#persisted[idx]) {
        this.#nvs.set(NVS_KEYS.ringSlot(idx), this.#slots[idx]);
        this.#persisted[idx] = true;
        this.#metaDirty = true;
      }
    }
    if (this.#metaDirty) this.#writeMeta();
  }

  /** Брокер подтвердил событие (PUBACK) — убрать. NVS трогается, только если событие там было. */
  remove(bootId, n) {
    let at = -1;
    for (let i = 0; i < this.#count; i += 1) {
      const e = this.#slots[(this.#head + i) % this.#capacity];
      if (e && e.boot_id === bootId && e.n === n) {
        at = i;
        break;
      }
    }
    if (at < 0) return false;
    const idx = (this.#head + at) % this.#capacity;
    const wasPersisted = this.#persisted[idx];
    this.#clearSlot(idx);
    // Снимаем дыры с головы: доставка обычно идёт по порядку.
    while (this.#count > 0 && this.#slots[this.#head] === null) {
      this.#head = (this.#head + 1) % this.#capacity;
      this.#count -= 1;
    }
    if (this.#count === 0) this.#head = 0;
    this.#metaDirty = true;
    if (wasPersisted) this.#writeMeta();
    return true;
  }

  #clearSlot(idx) {
    if (this.#persisted[idx]) this.#nvs.delete(NVS_KEYS.ringSlot(idx));
    this.#slots[idx] = null;
    this.#persisted[idx] = false;
  }

  #writeMeta() {
    this.#nvs.set(NVS_KEYS.ringMeta, { head: this.#head, count: this.#count, dropped: this.#dropped });
    this.#metaDirty = false;
  }
}
