// Хранилище NVS. Интерфейс повторяет то, что прошивка делает с NVS ESP32:
// запись ключа целиком и атомарно (nvs_set_blob + nvs_commit), чтение копии.
// В M0 — память процесса (MemoryNvs). В M1 сюда добавится хранилище,
// которое переживает имитацию перезагрузки (тот же объект передаётся новой машине).
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
  replay: 'replay', // { seq, id, ack } последней принятой команды — одной записью, §3.2
  session: 'session', // M1: session_id, остаток, параметры сигналов, offline_resumes (§5 правило 3)
  config: 'config', // M1: config.set
  ringHead: 'ev_head', // индекс самого старого события
  ringCount: 'ev_count', // число событий в буфере
  ringDropped: 'ev_dropped', // сколько событий вытеснено при переполнении
  ringSlot: (i) => `ev_${i}`,
});

/**
 * Кольцевой буфер событий в NVS (§4: «события, накопленные без связи, хранятся
 * в кольцевом буфере в NVS и досылаются после восстановления»).
 * Каждый слот — отдельный ключ, чтобы добавление не переписывало весь буфер.
 * При переполнении вытесняется самое старое событие и растёт счётчик `ev_dropped`.
 */
export class EventRing {
  #nvs;
  #capacity;

  constructor(nvs, capacity = 32) {
    this.#nvs = nvs;
    this.#capacity = capacity;
  }

  get capacity() {
    return this.#capacity;
  }

  #head() {
    return this.#nvs.get(NVS_KEYS.ringHead) ?? 0;
  }

  #count() {
    return this.#nvs.get(NVS_KEYS.ringCount) ?? 0;
  }

  get size() {
    return this.#count();
  }

  get dropped() {
    return this.#nvs.get(NVS_KEYS.ringDropped) ?? 0;
  }

  /** @param {{ boot: number, n: number, payload: string }} entry */
  push(entry) {
    let head = this.#head();
    let count = this.#count();
    if (count === this.#capacity) {
      head = (head + 1) % this.#capacity;
      count -= 1;
      this.#nvs.set(NVS_KEYS.ringDropped, this.dropped + 1);
    }
    this.#nvs.set(NVS_KEYS.ringSlot((head + count) % this.#capacity), entry);
    this.#nvs.set(NVS_KEYS.ringHead, head);
    this.#nvs.set(NVS_KEYS.ringCount, count + 1);
  }

  /** События от старого к новому. */
  list() {
    const head = this.#head();
    const count = this.#count();
    const out = [];
    for (let i = 0; i < count; i += 1) {
      const entry = this.#nvs.get(NVS_KEYS.ringSlot((head + i) % this.#capacity));
      if (entry) out.push(entry);
    }
    return out;
  }

  /** Удаляет доставленное событие (после PUBACK). Доставка идёт по порядку, но допускается любой. */
  remove(boot, n) {
    const entries = this.list();
    const rest = entries.filter((e) => !(e.boot === boot && e.n === n));
    if (rest.length === entries.length) return false;
    const head = this.#head();
    if (entries[0].boot === boot && entries[0].n === n) {
      this.#nvs.delete(NVS_KEYS.ringSlot(head));
      this.#nvs.set(NVS_KEYS.ringHead, (head + 1) % this.#capacity);
      this.#nvs.set(NVS_KEYS.ringCount, rest.length);
      return true;
    }
    // Не самое старое: переписываем буфер по порядку (редкий случай).
    for (let i = 0; i < this.#capacity; i += 1) this.#nvs.delete(NVS_KEYS.ringSlot(i));
    rest.forEach((e, i) => this.#nvs.set(NVS_KEYS.ringSlot(i), e));
    this.#nvs.set(NVS_KEYS.ringHead, 0);
    this.#nvs.set(NVS_KEYS.ringCount, rest.length);
    return true;
  }
}
