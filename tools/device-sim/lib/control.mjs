// HTTP-управление симулятором для tester и pentester — только разработка (контракт M1 §9).
// Включается, только если задан SIM_CONTROL_PORT; при NODE_ENV=production не запускается (lib/config.mjs).
// Слушает 127.0.0.1 (в контейнере — SIM_CONTROL_HOST=0.0.0.0 внутри сети Docker,
// наружу devops публикует на 127.0.0.1:18080).
//
//   GET  /sim/tables                       состояние всех столов
//   GET  /sim/tables/{number}              один стол
//   POST /sim/tables/{number}/fault        {"name": "...", "on": true|false, "ms"?: n}
//   POST /sim/tables/{number}/reboot       {"down_ms"?: n, "reset_reason"?: "poweron"|"sw"|...}
//   POST /sim/tables/{number}/net          {"up": true|false}
//   POST /sim/tables/{number}/inject       {"raw": "строка команды"} — как пришедшая в cmd (T9)
//   POST /sim/tables/{number}/unclaim      {} — режим --claim: стереть ключи привязки, снова ждать привязки
//
// POST принимает только Content-Type: application/json: браузер не может отправить такой запрос
// на 127.0.0.1 с чужой страницы без CORS-preflight, а CORS здесь не разрешён.

import http from 'node:http';
import { FaultError } from './device.mjs';

const MAX_BODY = 16_384; // inject: команда до 2048 байт в строке JSON с экранированием
const RESET_REASONS = new Set(['poweron', 'sw', 'panic', 'int_wdt', 'task_wdt', 'wdt', 'deepsleep', 'brownout', 'sdio', 'unknown']);

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
      reject(new HttpError(415, 'json_required'));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text === '') {
        resolve({});
        return;
      }
      try {
        const v = JSON.parse(text);
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not object');
        resolve(v);
      } catch {
        reject(new HttpError(400, 'bad_json'));
      }
    });
    req.on('error', () => reject(new HttpError(400, 'bad_request')));
  });
}

/**
 * @param {{ devices: (import('./device.mjs').SimDevice | import('./claim.mjs').ClaimingDevice)[], port: number, host?: string, log: object }} options
 * @returns {Promise<{ server: http.Server, port: number, close(): Promise<void> }>}
 */
export async function startControl({ devices, port, host = '127.0.0.1', log }) {
  if (process.env.NODE_ENV === 'production') throw new Error('управление симулятором недоступно при NODE_ENV=production');
  const byTable = new Map(devices.map((d) => [d.table, d]));

  async function route(req) {
    const url = new URL(req.url, 'http://sim');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'sim' || parts[1] !== 'tables') throw new HttpError(404, 'not_found');

    if (parts.length === 2) {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
      return { status: 200, body: [...byTable.values()].map((d) => d.status()) };
    }
    if (!/^[1-9][0-9]{0,5}$/.test(parts[2] ?? '')) throw new HttpError(404, 'not_found');
    const device = byTable.get(Number(parts[2]));
    if (!device) throw new HttpError(404, 'table_not_found');

    if (parts.length === 3) {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
      return { status: 200, body: device.status() };
    }
    if (parts.length !== 4) throw new HttpError(404, 'not_found');
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
    const body = await readJson(req);

    switch (parts[3]) {
      case 'fault': {
        const ms = body.ms ?? null;
        const result = device.setFault(body.name, body.on, ms);
        return { status: 200, body: { ok: true, ...result, table: device.status() } };
      }
      case 'reboot': {
        const reason = body.reset_reason ?? 'poweron';
        if (!RESET_REASONS.has(reason)) throw new HttpError(400, 'bad_reset_reason');
        device.reboot({ downMs: body.down_ms ?? 0, resetReason: reason });
        return { status: 200, body: { ok: true, table: device.status() } };
      }
      case 'net':
        device.setNet(body.up);
        return { status: 200, body: { ok: true, table: device.status() } };
      case 'inject': {
        const result = device.inject(body.raw);
        return { status: 200, body: { ok: true, ...result, table: device.status() } };
      }
      case 'unclaim':
        if (typeof device.unclaim !== 'function') throw new HttpError(409, 'not_claim_mode');
        await device.unclaim();
        return { status: 200, body: { ok: true, table: device.status() } };
      default:
        throw new HttpError(404, 'not_found');
    }
  }

  const server = http.createServer((req, res) => {
    route(req).then(
      ({ status, body }) => send(res, status, body),
      (err) => {
        if (err instanceof HttpError) {
          send(res, err.status, { error: err.code });
        } else if (err instanceof FaultError) {
          const status = { too_large: 413, powered_off: 409, not_claimed: 409 }[err.message] ?? 400;
          send(res, status, { error: err.message });
        } else {
          log.error('sim_control_error', { error: err.message });
          send(res, 500, { error: 'internal' });
        }
      },
    );
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const actual = server.address().port;
  log.info('sim_control', { host, port: actual, note: 'управление симулятором, только разработка' });
  return {
    server,
    port: actual,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
