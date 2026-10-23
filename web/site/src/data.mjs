/**
 * Данные сайта — только из публичного API сервера (контракт M4 §1 п.1, §4). В базу сайт не ходит.
 * Ответы GET кэшируются в памяти на cacheMs (60 с): одна страница — один запрос к API в минуту.
 * Если API недоступен, а в кэше есть устаревший ответ — отдаём его (до 10 минут), иначе ApiUnavailable.
 *
 *   const data = createData({ apiUrl, mock, cacheMs });
 *   await data.get('/api/public/cities')          → JSON | null (404)
 *   await data.post('/api/leads', body, { ip })   → { status, json }
 */

export class ApiUnavailable extends Error {
  constructor(cause) {
    super('api_unavailable');
    this.name = 'ApiUnavailable';
    this.cause = cause;
  }
}

const STALE_MS = 10 * 60_000;
const MAX_ENTRIES = 500;
const TIMEOUT_MS = 4000;

export function createData({ apiUrl = null, mock = !apiUrl, cacheMs = 60_000, fetchImpl = globalThis.fetch, mockApi = null, now = () => Date.now() } = {}) {
  const cache = new Map(); // path → { at, value }
  const inflight = new Map();
  let mockModule = mockApi;

  async function mockHandle(args) {
    if (!mockModule) mockModule = await import('../mock/api.mjs');
    return mockModule.handle(args);
  }

  async function request(method, path, body, headers = {}) {
    if (mock) {
      const url = new URL(path, 'http://mock');
      const res = await mockHandle({ method, path: url.pathname, query: url.searchParams, body });
      return { status: res.status, json: res.json };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(apiUrl + path, {
        method,
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  }

  async function load(path) {
    let res;
    try {
      res = await request('GET', path);
    } catch (err) {
      throw new ApiUnavailable(err);
    }
    if (res.status === 404) return null;
    if (res.status >= 500 || res.status === 429 || res.json === null) throw new ApiUnavailable(new Error(`status ${res.status}`));
    if (res.status >= 400) return null;
    return res.json;
  }

  async function get(path) {
    const hit = cache.get(path);
    const t = now();
    if (hit && t - hit.at < cacheMs) return hit.value;
    if (inflight.has(path)) return inflight.get(path);
    const p = load(path)
      .then((value) => {
        cache.delete(path);
        cache.set(path, { at: now(), value });
        if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
        return value;
      })
      .catch((err) => {
        if (hit && t - hit.at < STALE_MS) return hit.value;
        throw err;
      })
      .finally(() => inflight.delete(path));
    inflight.set(path, p);
    return p;
  }

  /** POST без кэша: заявки (leads, заявки гостей). IP гостя уходит в X-Forwarded-For для лимитов API. */
  async function post(path, body, { ip } = {}) {
    try {
      return await request('POST', path, body, ip ? { 'x-forwarded-for': ip } : {});
    } catch (err) {
      throw new ApiUnavailable(err);
    }
  }

  return { get, post, clear: () => cache.clear(), mock };
}
