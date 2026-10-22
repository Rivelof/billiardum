// Ограничение частоты в памяти процесса: окно фиксированной длины на ключ (IP и маршрут).
// Один процесс сервера (M1): общий счётчик между процессами не нужен.

export const DEFAULT_LIMIT = { max: 600, windowMs: 60_000 };
const MAX_KEYS = 100_000;

/**
 * @param {{ now?: () => number, maxKeys?: number }} [options]
 */
export function createRateLimiter({ now = Date.now, maxKeys = MAX_KEYS } = {}) {
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const windows = new Map();

  function sweep(t) {
    for (const [key, w] of windows) if (w.resetAt <= t) windows.delete(key);
  }

  return {
    /**
     * Учесть запрос. Возвращает { ok, retryAfterSec }.
     * @param {string} key
     * @param {{ max: number, windowMs: number }} limit
     */
    hit(key, { max, windowMs } = DEFAULT_LIMIT) {
      const t = now();
      let w = windows.get(key);
      if (!w || w.resetAt <= t) {
        if (windows.size >= maxKeys) {
          sweep(t);
          // Всё ещё переполнено (атака с множества адресов): забываем самые старые окна.
          if (windows.size >= maxKeys) {
            let drop = Math.ceil(maxKeys / 10);
            for (const k of windows.keys()) {
              windows.delete(k);
              if (--drop <= 0) break;
            }
          }
        }
        w = { count: 0, resetAt: t + windowMs };
        windows.delete(key);
        windows.set(key, w);
      }
      w.count += 1;
      if (w.count > max) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((w.resetAt - t) / 1000)) };
      return { ok: true, retryAfterSec: 0 };
    },
    sweep() {
      sweep(now());
    },
    get size() {
      return windows.size;
    },
  };
}
