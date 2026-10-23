/**
 * Лимит запросов сайта по IP гостя (M4-6). Сайт ходит в публичный API из доверенной сети без лимита API,
 * поэтому ограничивает гостей сам: около 120 запросов в минуту с IP, IPv6 — по подсети /64.
 *
 * Считаются только запросы, которые идут в API: промах кэша (data.get) и заявка (data.post). Статика,
 * страницы из кэша и OG-картинки по закэшированным данным (картинки кэширует og.mjs) — бесплатно. Списание — одно на запрос сайта: первый
 * промах кэша берёт жетон, следующие промахи того же запроса — уже оплачены. Нет жетона — RateLimited,
 * сайт отвечает 429 со страницей и Retry-After.
 *
 *   const limiter = createRateLimiter({ perMinute: 120 });
 *   await budget.run(requestBudget(limiter, rateKey(ip)), () => route(ctx));   // внутри — charge()
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { ipBytes } from './net.mjs';

const MINUTE = 60_000;

export class RateLimited extends Error {
  /** @param {number} retryAfter секунды до следующего жетона, ≥ 1 */
  constructor(retryAfter) {
    super('rate_limited');
    this.name = 'RateLimited';
    this.retryAfter = retryAfter;
  }
}

/** Ключ лимита: IPv4 как есть, IPv6 — первые 64 бита (одна /64 — один гость). Нет адреса — общий ключ. */
export function rateKey(ip) {
  const b = ipBytes(ip);
  if (!b) return 'unknown';
  if (b.length === 4) return b.join('.');
  const groups = [];
  for (let i = 0; i < 8; i += 2) groups.push(((b[i] << 8) | b[i + 1]).toString(16));
  return `${groups.join(':')}::/64`;
}

/**
 * Ведро жетонов на ключ: ёмкость perMinute, пополнение perMinute в минуту (ровно, по миллисекундам).
 * Память ограничена maxKeys: сначала выбрасываются полные вёдра (гость давно не заходил), потом самые старые.
 * @param {{ perMinute?: number, now?: () => number, maxKeys?: number }} [opts]
 */
export function createRateLimiter({ perMinute = 120, now = () => Date.now(), maxKeys = 50_000 } = {}) {
  const rate = perMinute / MINUTE; // жетонов в миллисекунду
  const buckets = new Map(); // key → { tokens, at }

  function level(b, t) {
    return Math.min(perMinute, b.tokens + (t - b.at) * rate);
  }

  function prune(t) {
    for (const [k, b] of buckets) if (level(b, t) >= perMinute) buckets.delete(k);
    const target = Math.floor(maxKeys * 0.9);
    for (const k of buckets.keys()) {
      if (buckets.size <= target) break;
      buckets.delete(k);
    }
  }

  /** → { ok: true, left } | { ok: false, retryAfter } */
  function take(key) {
    const t = now();
    const b = buckets.get(key) ?? { tokens: perMinute, at: t };
    const tokens = level(b, t);
    buckets.delete(key); // в конец Map: порядок — по последнему обращению
    if (tokens < 1) {
      buckets.set(key, { tokens, at: t });
      return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - tokens) / rate / 1000)) };
    }
    buckets.set(key, { tokens: tokens - 1, at: t });
    if (buckets.size > maxKeys) prune(t);
    return { ok: true, left: Math.floor(tokens - 1) };
  }

  return { take, size: () => buckets.size, perMinute };
}

/** Бюджет текущего запроса сайта: data.mjs зовёт charge() перед походом в API. */
export const budget = new AsyncLocalStorage();

/**
 * @param {ReturnType<typeof createRateLimiter> | null} limiter
 * @param {string} key rateKey(ip)
 */
export function requestBudget(limiter, key) {
  let paid = false;
  let denied = null;
  return {
    charge() {
      if (!limiter || paid) return;
      if (denied) throw denied;
      const r = limiter.take(key);
      if (!r.ok) {
        denied = new RateLimited(r.retryAfter);
        throw denied;
      }
      paid = true;
    },
    /** Запрос упёрся в лимит (даже если страница поймала ошибку и дорисовалась без части данных). */
    get denied() {
      return denied;
    },
  };
}

/** Списать жетон за текущий запрос сайта; вне запроса (тесты, фоновые задачи) — ничего. */
export function charge() {
  budget.getStore()?.charge();
}
