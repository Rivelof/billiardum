// Клиент Telegram Bot API (вход через бота, уведомления). Только через прокси
// TELEGRAM_PROXY_URL: с сервера в РФ api.telegram.org закрыт (CLAUDE.md, PRODUCT §12).
// Токен бота не попадает в логи: в ошибках только метод и код.

import { httpRequest } from './http-client.mjs';

export const TELEGRAM_API = 'https://api.telegram.org';

export class TelegramError extends Error {
  constructor(code, method, status) {
    super(`telegram ${method}: ${code}`);
    this.name = 'TelegramError';
    this.code = code;
    this.method = method;
    this.status = status;
  }
}

/**
 * @param {{ token: string|null, proxyUrl: string|null, apiBase?: string, timeoutMs?: number,
 *           request?: typeof httpRequest }} options
 * apiBase и request подменяются в тестах; без прокси (proxyUrl пуст) клиент не настроен.
 */
export function createTelegramBot({ token, proxyUrl, apiBase = TELEGRAM_API, timeoutMs = 10_000, request = httpRequest, requireProxy = true }) {
  const configured = Boolean(token) && (Boolean(proxyUrl) || !requireProxy);
  return {
    configured,
    /**
     * Метод Bot API с JSON-параметрами. Ответ — result; ok:false — TelegramError.
     * @param {string} method
     * @param {object} params
     */
    async call(method, params = {}) {
      if (!configured) throw new TelegramError('not_configured', method, 0);
      if (!/^[A-Za-z]{1,40}$/.test(method)) throw new TelegramError('bad_method', method, 0);
      let res;
      try {
        res = await request(`${apiBase}/bot${token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
          proxyUrl: proxyUrl || null,
          timeoutMs,
        });
      } catch (err) {
        throw new TelegramError(err?.code ?? 'network', method, 0);
      }
      let json;
      try {
        json = JSON.parse(res.body.toString('utf8'));
      } catch {
        json = null;
      }
      if (res.status !== 200 || !json?.ok) {
        throw new TelegramError(json?.error_code ? `api_${json.error_code}` : `http_${res.status}`, method, res.status);
      }
      return json.result;
    },
  };
}
