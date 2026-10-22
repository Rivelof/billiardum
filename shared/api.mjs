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
   * @param {{ status?: number, cause?: unknown }} [options]
   */
  constructor(code, { status = 0, cause } = {}) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

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
  let body;
  try {
    const text = typeof res.text === 'function' ? await res.text() : '';
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const code = body && typeof body === 'object' ? body.error : undefined;
  if (typeof code === 'string' && CODE_RE.test(code)) return code;
  if (BY_STATUS[res.status]) return BY_STATUS[res.status];
  if (res.status >= 500) return 'server_error';
  return 'unknown';
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
      const err = new ApiError(await readErrorCode(res), { status: res.status });
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
