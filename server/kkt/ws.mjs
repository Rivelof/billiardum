// WebSocket /api/kkt/ws для мостов ККТ (decisions №77): RFC 6455 — библиотека ws (MIT).
//
// Вход моста — заголовок Authorization: Bearer <токен моста>. Клуб — из токена, строка моста —
// по sha256 токена в контексте этого клуба (RLS); отозванный или неизвестный — 401 до апгрейда.
// Запрос с Origin (браузер) отклоняется: мост — не страница. Частота подключений — 30 в минуту
// с IP. Кадры — только текст JSON до 256 КБ, без сжатия.

import { WebSocketServer } from 'ws';
import { clientIp } from '../http/request.mjs';
import { createRateLimiter } from '../http/rate-limit.mjs';
import { bearerToken, clubOfToken, hashToken } from './tokens.mjs';

export const WS_PATH = '/api/kkt/ws';
export const MAX_PAYLOAD = 256 * 1024;
export const CONNECT_LIMIT = { max: 30, windowMs: 60_000 };

function reject(socket, status, code) {
  const text = JSON.stringify({ error: code });
  const reason = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 500: 'Internal Server Error' }[status] ?? 'Error';
  try {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`,
    );
  } catch {
    /* сокет уже закрыт */
  }
  socket.destroy();
}

/**
 * @param {{ service: object, pool: any, withContext: Function, log: any, config?: object, rateLimiter?: object }} deps
 */
export function createKktWs({ service, pool, withContext, log, config = {}, rateLimiter = createRateLimiter() }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false, clientTracking: false });

  async function findBridge(token) {
    const clubId = clubOfToken(token);
    if (!clubId) return null;
    return withContext(pool, { clubId, actorType: 'system' }, async (db) => {
      const { rows } = await db.query('select id, club_id, name, revoked_at from bl.kkt_bridges where token_hash = $1', [hashToken(token)]);
      const b = rows[0];
      return b && !b.revoked_at && b.club_id === clubId ? b : null;
    });
  }

  /**
   * Обработчик события upgrade HTTP-сервера. Возвращает false, если путь не наш
   * (тогда вызывающий закрывает сокет сам).
   */
  function handleUpgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return false;
    }
    if (url.pathname !== WS_PATH) return false;
    socket.on('error', () => {});
    const ip = clientIp(req, config.trustedProxies ? { trustedProxies: config.trustedProxies } : {});
    if (req.method !== 'GET' || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      reject(socket, 400, 'bad_request');
      return true;
    }
    if (req.headers.origin !== undefined) {
      log.warn('kkt_ws_origin_rejected', { ip });
      reject(socket, 403, 'forbidden');
      return true;
    }
    const hit = rateLimiter.hit(`kkt-ws|${ip}`, CONNECT_LIMIT);
    if (!hit.ok) {
      reject(socket, 429, 'rate_limited');
      return true;
    }
    const token = bearerToken(req.headers.authorization);
    if (!token) {
      reject(socket, 401, 'unauthorized');
      return true;
    }
    findBridge(token).then(
      (bridge) => {
        if (!bridge) {
          log.warn('kkt_ws_unauthorized', { ip });
          reject(socket, 401, 'unauthorized');
          return;
        }
        if (socket.destroyed) return;
        wss.handleUpgrade(req, socket, head, (ws) => service.attach(ws, bridge, { ip }));
      },
      (err) => {
        log.error('kkt_ws_auth_failed', { error: err.message });
        reject(socket, 500, 'internal');
      },
    );
    return true;
  }

  return { handleUpgrade, wss };
}
