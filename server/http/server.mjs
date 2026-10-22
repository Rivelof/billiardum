// HTTP-обработчик сервера: GET /health (как в M0) и всё остальное — роутеру API.

import { createHandler as createHealthHandler, sendJson } from '../lib/http.mjs';

/**
 * @param {{ router: { handle: (req, res) => Promise<boolean> } | null, checkDb: () => Promise<void>,
 *           mqttConnected: () => boolean, log: any }} deps
 */
export function createHttpHandler({ router, checkDb, mqttConnected, log }) {
  const health = createHealthHandler({ checkDb, mqttConnected, log });
  return async function handler(req, res) {
    try {
      const pathname = (req.url ?? '/').split('?')[0];
      if (pathname === '/health') {
        await health(req, res);
        return;
      }
      if (!router) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      await router.handle(req, res);
    } catch (err) {
      log.error('http_unhandled', { error: err?.message });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
      else res.destroy();
    }
  };
}
