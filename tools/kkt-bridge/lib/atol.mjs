// Клиент веб-сервера драйвера ККТ АТОЛ (ДТО 10): «АТОЛ. Web Requests» (/api/v2/…) и старый
// веб-сервер ДТО 10 (/requests). Только то, что нужно мосту: поставить задание по UUID,
// узнать его результат, спросить состояние ККТ без очереди.
//
// Ответы обоих форматов приводятся к одному виду:
//   { status, code, description, result }  — по каждой задаче задания.

import { randomUUID } from 'node:crypto';
import { OPEN_STATUSES } from './codes.mjs';

export class AtolUnreachable extends Error {
  constructor(message) {
    super(message);
    this.name = 'AtolUnreachable';
    this.code = 'atol_unreachable';
  }
}

/** Результат задачи в общем виде (Web Requests: error {code, description}; старый: errorCode, errorDescription). */
export function normalizeResult(r) {
  const code = Number.isInteger(r?.error?.code) ? r.error.code : Number.isInteger(r?.errorCode) ? r.errorCode : 0;
  const description = typeof r?.error?.description === 'string' ? r.error.description : typeof r?.errorDescription === 'string' ? r.errorDescription : '';
  return { status: typeof r?.status === 'string' ? r.status : 'unknown', code, description, result: r?.result ?? null };
}

/** Задание завершено: ни одна задача не ждёт, не выполняется и не заблокирована. */
export function isFinal(results) {
  return results.length > 0 && results.every((r) => !OPEN_STATUSES.has(r.status));
}

/**
 * @param {{ baseUrl: string, api?: 'v2'|'legacy', deviceId?: string|null, auth?: { user: string, password: string }|null,
 *           timeoutMs?: number, fetch?: typeof fetch }} options
 */
export function createAtolClient({ baseUrl, api = 'v2', deviceId = null, auth = null, timeoutMs = 10_000, fetch: doFetch = globalThis.fetch }) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const prefix = api === 'legacy' ? '' : '/api/v2';
  const query = deviceId ? `?deviceID=${encodeURIComponent(deviceId)}` : '';
  const headers = { accept: 'application/json' };
  if (auth?.user) headers.authorization = `Basic ${Buffer.from(`${auth.user}:${auth.password ?? ''}`).toString('base64')}`;

  async function call(method, path, body) {
    let res;
    try {
      res = await doFetch(`${base}${path}${query}`, {
        method,
        headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json; charset=utf-8' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      throw new AtolUnreachable(err?.name === 'TimeoutError' ? 'таймаут веб-сервера АТОЛ' : 'веб-сервер АТОЛ недоступен');
    }
    const text = await res.text().catch(() => '');
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const description = typeof json?.error?.description === 'string' ? json.error.description : typeof json?.errorDescription === 'string' ? json.errorDescription : '';
    return { status: res.status, json, description };
  }

  return {
    api,
    /**
     * Поставить задание. → { ok: true } | { ok: false, kind: 'duplicate'|'rejected'|'bad_request'|'unauthorized'|'error', status, description }
     * 409 — либо задание с таким UUID уже есть, либо ККТ не подключена: различает вызывающий,
     * спросив результат по UUID.
     */
    async addRequest(uuid, tasks) {
      const r = await call('POST', `${prefix}/requests`, { uuid, request: tasks });
      if (r.status === 201 || r.status === 200) return { ok: true, status: r.status, queue: r.json };
      const kind = r.status === 409 ? 'conflict' : r.status === 400 ? 'bad_request' : r.status === 401 || r.status === 403 ? 'unauthorized' : 'error';
      return { ok: false, kind, status: r.status, description: r.description };
    },

    /** Результат задания по UUID. → { found: false } | { found: true, results: [...] } */
    async getRequest(uuid) {
      const r = await call('GET', `${prefix}/requests/${encodeURIComponent(uuid)}`);
      if (r.status === 404) return { found: false };
      if (r.status !== 200 || !Array.isArray(r.json?.results)) {
        return { found: false, error: { status: r.status, description: r.description } };
      }
      return { found: true, results: r.json.results.map(normalizeResult) };
    },

    /**
     * Синхронный запрос без очереди (Web Requests: /api/v2/operations/queryDeviceStatus и др.).
     * → { ok: true, json } | { ok: false, status, unsupported: boolean, description }
     */
    async operation(name) {
      if (api === 'legacy') return { ok: false, status: 404, unsupported: true, description: '' };
      const r = await call('POST', `${prefix}/operations/${name}`, {});
      if (r.status === 200) return { ok: true, json: r.json };
      return { ok: false, status: r.status, unsupported: r.status === 404 || r.status === 501, description: r.description };
    },

    /**
     * Состояние смены ККТ: через operations/queryShiftStatus, а без него — заданием getShiftStatus
     * со своим UUID. → { state: 'opened'|'closed'|'expired', number } | null
     */
    async shiftStatus({ pollMs = 200, timeoutMs: limit = 10_000, sleep } = {}) {
      const op = await this.operation('queryShiftStatus').catch(() => null);
      const fromJson = (j) => {
        const s = j?.shiftStatus ?? j;
        return typeof s?.state === 'string' ? { state: s.state, number: Number.isInteger(s.number) ? s.number : null } : null;
      };
      if (op?.ok) return fromJson(op.json);
      const uuid = randomUUID();
      const added = await this.addRequest(uuid, [{ type: 'getShiftStatus' }]);
      if (!added.ok) return null;
      const until = Date.now() + limit;
      const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
      while (Date.now() < until) {
        const got = await this.getRequest(uuid);
        if (got.found && isFinal(got.results)) {
          const first = got.results[0];
          return first.status === 'ready' ? fromJson(first.result) : null;
        }
        await wait(pollMs);
      }
      return null;
    },
  };
}
