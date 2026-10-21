// Часы для конечного автомата: монотонное время в мс и таймеры.
// Настоящие часы — для запуска, FakeClock — для тестов с ускоренным временем.
//
// interface Clock {
//   now(): number                          // монотонные мс (как esp_timer_get_time()/1000)
//   setTimeout(fn: () => void, ms: number): unknown
//   clearTimeout(handle: unknown): void
// }

import { performance } from 'node:perf_hooks';

const MAX_DELAY = 2 ** 31 - 1; // предел setTimeout в Node

export class RealClock {
  now() {
    return Math.floor(performance.now());
  }

  setTimeout(fn, ms) {
    const handle = { timer: null };
    const due = this.now() + Math.max(0, ms);
    const arm = () => {
      const left = due - this.now();
      if (left <= 0) {
        handle.timer = null;
        fn();
        return;
      }
      handle.timer = setTimeout(arm, Math.min(left, MAX_DELAY));
      handle.timer.unref?.();
    };
    arm();
    return handle;
  }

  clearTimeout(handle) {
    if (handle?.timer) clearTimeout(handle.timer);
    if (handle) handle.timer = null;
  }
}

export class FakeClock {
  #now;
  #timers = [];
  #nextId = 1;

  constructor(start = 0) {
    this.#now = start;
  }

  now() {
    return this.#now;
  }

  setTimeout(fn, ms) {
    const timer = { id: this.#nextId++, due: this.#now + Math.max(0, ms), fn };
    this.#timers.push(timer);
    return timer;
  }

  clearTimeout(handle) {
    this.#timers = this.#timers.filter((t) => t !== handle);
  }

  get pending() {
    return this.#timers.length;
  }

  /** Сдвигает время на ms, по пути исполняя таймеры по порядку срока. */
  advance(ms) {
    const target = this.#now + ms;
    for (;;) {
      const next = this.#timers
        .filter((t) => t.due <= target)
        .sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (!next) break;
      this.#timers = this.#timers.filter((t) => t !== next);
      this.#now = next.due;
      next.fn();
    }
    this.#now = target;
  }
}
