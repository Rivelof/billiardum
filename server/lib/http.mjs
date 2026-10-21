// HTTP сервера: обработчики (req, res) без фреймворков. Ошибки наружу — только кодом.

const HEALTH_TIMEOUT_MS = 2_000;

export function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    }),
  ]);
}

/**
 * GET /health → 200 {"ok":true,"db":true,"mqtt":true}; если зависимость недоступна — 503 того же вида.
 * @param {{ checkDb: () => Promise<void>, mqttConnected: () => boolean, log?: any }} deps
 */
export function createHandler({ checkDb, mqttConnected, log }) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/health') {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    let db = true;
    try {
      await withTimeout(checkDb(), HEALTH_TIMEOUT_MS);
    } catch (err) {
      db = false;
      log?.warn('health_db_failed', { error: err.message });
    }
    const mqtt = Boolean(mqttConnected());
    const ok = db && mqtt;
    sendJson(res, ok ? 200 : 503, { ok, db, mqtt });
  };
}
