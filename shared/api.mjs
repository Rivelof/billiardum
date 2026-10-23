/**
 * Бильярдум — клиент API по контракту (docs/contracts/m1.md §3). Без зависимостей, работает в браузере и в Node.
 *
 *   const api = createClient({ token: () => sessionToken });
 *   const table = await api.get(`/t/${code}`);
 *   await api.post('/quotes', { resource_id, kind: 'start', minutes: 60 });
 *   await api.post(`/quotes/${id}/pay`, { method: 'sbp' }, { idempotencyKey: newIdempotencyKey() });
 *
 * Любая ошибка — ApiError с кодом из общего словаря (`{"error":"table_busy"}` → err.code === 'table_busy').
 * Нет связи — код `network`, ответ 5xx без кода — `server_error`. Текст для человека — errorMessage() из errors.mjs.
 */

export class ApiError extends Error {
  /**
   * @param {string} code код из словаря контракта или `network`, `server_error`, `unknown`
   * @param {{ status?: number, cause?: unknown, data?: Record<string, unknown> | null, retryAfterSec?: number | null }} [options]
   */
  constructor(code, { status = 0, cause, data = null, retryAfterSec = null } = {}) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    // Безопасные поля рядом с кодом (сервер отдаёт по белому списку): { booking_id, busy_until, … }
    this.data = data;
    // 429: через сколько секунд повторить (заголовок Retry-After); нет заголовка — null
    this.retryAfterSec = retryAfterSec;
  }
}

/** Поля ошибки, которые клиент берёт из тела рядом с { error } (идентификаторы, время, счётчики). */
export const ERROR_FIELDS = Object.freeze([
  'booking_id',
  'session_id',
  'resource_id',
  'offer_id',
  'payment_id',
  'busy_until',
  'limit_until',
  'extend_limit_until',
  'available_from',
  'retry_after_sec',
  'minutes_left',
]);

const CODE_RE = /^[a-z][a-z0-9_]{1,63}$/;

const BY_STATUS = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  429: 'rate_limited',
};

/**
 * Код ошибки из ответа: `{"error":"code"}`; если тела нет или оно чужое — по HTTP-статусу.
 * @param {{ status: number, json?: () => Promise<unknown>, text?: () => Promise<string> }} res
 * @returns {Promise<string>}
 */
export async function readErrorCode(res) {
  return (await readError(res)).code;
}

/**
 * Код и безопасные поля ошибки: `{"error":"booking_start_required","booking_id":"…"}` →
 * { code: 'booking_start_required', data: { booking_id: '…' } }. Поля только из ERROR_FIELDS,
 * значения — строка, число, логическое или null.
 * @returns {Promise<{ code: string, data: Record<string, string | number | boolean | null> | null }>}
 */
export async function readError(res) {
  let body;
  try {
    const text = typeof res.text === 'function' ? await res.text() : '';
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const obj = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  let data = null;
  if (obj && res.status < 500) {
    for (const k of ERROR_FIELDS) {
      const v = obj[k];
      if (v === null || typeof v === 'boolean' || typeof v === 'number' || (typeof v === 'string' && v.length <= 64)) (data ??= {})[k] = v;
    }
  }
  const code = obj?.error;
  if (typeof code === 'string' && CODE_RE.test(code)) return { code, data };
  if (BY_STATUS[res.status]) return { code: BY_STATUS[res.status], data };
  if (res.status >= 500) return { code: 'server_error', data: null };
  return { code: 'unknown', data };
}

/** UUID для заголовка Idempotency-Key (денежные операции, §3). */
export function newIdempotencyKey() {
  return globalThis.crypto.randomUUID();
}

function buildQuery(query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

/**
 * @param {object} [options]
 * @param {string} [options.base] префикс API, по умолчанию '/api'
 * @param {typeof fetch} [options.fetch] своя реализация fetch (заглушка разработки, тесты)
 * @param {() => string | null | undefined} [options.token] токен для `Authorization: Bearer` (мини-приложения, терминал)
 * @param {(headers: Record<string, string>) => void} [options.headers] добавить свои заголовки
 * @param {(err: ApiError) => void} [options.onUnauthorized] вызывается на 401
 */
export function createClient(options = {}) {
  const base = (options.base ?? '/api').replace(/\/$/, '');
  const doFetch = options.fetch ?? ((...args) => globalThis.fetch(...args));

  const url = (path, query) => `${base}${path.startsWith('/') ? path : `/${path}`}${buildQuery(query)}`;

  /**
   * @param {'GET' | 'POST'} method
   * @param {string} path путь без префикса: '/t/4K7P9QW2XM'
   * @param {{ body?: unknown, query?: Record<string, unknown>, idempotencyKey?: string, signal?: AbortSignal, raw?: boolean }} [opts]
   */
  async function request(method, path, opts = {}) {
    const headers = { Accept: 'application/json' };
    // Контракт §3: у изменяющих запросов Content-Type: application/json обязателен, даже без тела
    const hasBody = method !== 'GET' && method !== 'HEAD';
    if (hasBody) headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    const token = options.token?.();
    if (token) headers.Authorization = `Bearer ${token}`;
    options.headers?.(headers);

    let res;
    try {
      res = await doFetch(url(path, opts.query), {
        method,
        headers,
        body: hasBody ? JSON.stringify(opts.body ?? {}) : undefined,
        credentials: 'same-origin',
        signal: opts.signal,
      });
    } catch (cause) {
      if (cause?.name === 'AbortError') throw cause;
      throw new ApiError('network', { cause });
    }

    if (!res.ok) {
      const { code, data } = await readError(res);
      const ra = Number.parseInt(res.headers?.get?.('retry-after') ?? '', 10);
      const err = new ApiError(code, { status: res.status, data, retryAfterSec: Number.isSafeInteger(ra) && ra >= 0 ? ra : null });
      if (err.code === 'unauthorized') options.onUnauthorized?.(err);
      throw err;
    }
    if (opts.raw) return res;
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new ApiError('server_error', { status: res.status, cause });
    }
  }

  return {
    url,
    request,
    get: (path, opts) => request('GET', path, opts),
    post: (path, body, opts) => request('POST', path, { ...opts, body }),
  };
}

/**
 * Поток Server-Sent Events (§7, `GET /api/stream`). Сам переподключается с паузой 1–15 с;
 * после каждого (пере)подключения зовёт onOpen — экран перечитывает данные, чтобы не потерять события из разрыва.
 *
 * @param {string} url полный путь: '/api/stream?session=…'
 * @param {object} handlers
 * @param {string[]} handlers.events имена событий: ['session'] или ['hall', 'reception_request', 'alarm']
 * @param {(name: string, data: unknown) => void} handlers.onEvent
 * @param {() => void} [handlers.onOpen]
 * @param {(state: 'open' | 'reconnecting') => void} [handlers.onState]
 * @param {typeof EventSource} [handlers.EventSource]
 * @returns {{ close(): void }}
 */
export function openStream(url, handlers) {
  const ES = handlers.EventSource ?? globalThis.EventSource;
  let source = null;
  let closed = false;
  let retry = 0;
  let timer = null;

  const connect = () => {
    if (closed) return;
    source = new ES(url, { withCredentials: true });
    source.onopen = () => {
      retry = 0;
      handlers.onState?.('open');
      handlers.onOpen?.();
    };
    source.onerror = () => {
      handlers.onState?.('reconnecting');
      // EventSource переподключается сам, пока не закрыт окончательно (например, 401 или 5xx)
      if (source.readyState === 2 /* CLOSED */) {
        source.close();
        const delay = Math.min(15000, 1000 * 2 ** retry);
        retry += 1;
        timer = setTimeout(connect, delay);
      }
    };
    for (const name of handlers.events) {
      source.addEventListener(name, (e) => {
        let data;
        try {
          data = e.data ? JSON.parse(e.data) : null;
        } catch {
          return;
        }
        handlers.onEvent(name, data);
      });
    }
  };

  connect();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      source?.close();
    },
  };
}

/** Способы входа, которые клиент умеет показывать. */
export const LOGIN_METHODS = Object.freeze(['max', 'telegram', 'dev']);

/**
 * Ответ GET /api/auth/methods → список способов входа (U1): только настроенные на сервере.
 * Принимает { methods: ['telegram', …] } и, на случай другой формы, [{ id | method | channel }].
 * Порядок — как у клиента (MAX первым), неизвестные способы отбрасываются. Не разобрали — null:
 * экран входа показывает кнопки как раньше, а не пустое состояние.
 * @returns {string[] | null}
 */
export function loginMethods(body) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.methods) ? body.methods : null;
  if (!list) return null;
  const ids = new Set(list.map((m) => (typeof m === 'string' ? m : (m?.id ?? m?.method ?? m?.channel))).filter((m) => typeof m === 'string'));
  return LOGIN_METHODS.filter((m) => ids.has(m));
}

/**
 * Что показать на экране входа (U1): кнопки мессенджеров, форму входа по номеру для разработки
 * или пустое состояние «вход временно недоступен».
 * @param {string[] | null} methods из loginMethods(); null — ответ не получили, показываем оба мессенджера
 * @param {{ devBuild?: boolean, unavailable?: string[] }} [options] devBuild — сборка с входом по номеру;
 *   unavailable — мессенджеры, на которые сервер уже ответил not_configured
 * @returns {{ channels: ('max' | 'telegram')[], dev: boolean, empty: boolean }}
 */
export function loginChoice(methods, { devBuild = false, unavailable = [] } = {}) {
  const known = methods ?? ['max', 'telegram', 'dev'];
  const channels = ['max', 'telegram'].filter((m) => known.includes(m) && !unavailable.includes(m));
  const dev = Boolean(devBuild) && known.includes('dev');
  return { channels, dev, empty: channels.length === 0 && !dev };
}
