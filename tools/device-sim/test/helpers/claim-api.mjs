// Поддельный сервер привязки для тестов режима --claim. Повторяет правила
// server/devices/bind.mjs (решение №67), но своей реализацией — тесты не импортируют server/:
//   - bind открывает окно 30 минут, в окне — sha256(device_id:код); прежнее окно закрывается;
//   - claim без открытого окна — 403 forbidden, попытка не считается;
//   - неверный код — 403 forbidden, пятая неверная попытка закрывает окно;
//   - верный код — ключи один раз, код сгорает (окно claimed);
//   - формат неверный — 400 bad_request; лимит запросов — 429 rate_limited.

import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';

export const BIND_WINDOW_MS = 30 * 60_000;
export const MAX_CLAIM_ATTEMPTS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SERVER_CLAIM_CODE = /^[A-Za-z0-9-]{6,64}$/; // как CLAIM_CODE в server/devices/bind.mjs

const hash = (deviceId, code) => createHash('sha256').update(`${deviceId}:${code}`, 'utf8').digest('hex');

export class FakeClaimApi {
  now = 0;
  windows = new Map(); // device_id → окно
  issued = new Map(); // device_id → последние выданные ключи
  requests = [];
  rateLimitLeft = Infinity;

  constructor({ clubId = '0192f3c0-c1ab-7000-8000-000000000001', mqttUrl = 'mqtts://broker.test:8883' } = {}) {
    this.clubId = clubId;
    this.mqttUrl = mqttUrl;
  }

  /** Владелец: «Добавить контроллер» → QR → стол. */
  bind(deviceId, code) {
    const prev = this.windows.get(deviceId);
    if (prev && !prev.claimed) prev.closed = true;
    this.windows.set(deviceId, { hash: hash(deviceId, code), until: this.now + BIND_WINDOW_MS, failed: 0, closed: false, claimed: false });
  }

  window(deviceId) {
    return this.windows.get(deviceId) ?? null;
  }

  /** POST /api/devices/claim → { status, json }. */
  claim(body) {
    this.requests.push({ at: this.now, body: { ...body } });
    if (this.rateLimitLeft <= 0) return { status: 429, json: { error: 'rate_limited' } };
    this.rateLimitLeft -= 1;
    const { device_id: deviceId, claim_code: code } = body ?? {};
    if (typeof deviceId !== 'string' || !UUID.test(deviceId) || typeof code !== 'string' || !SERVER_CLAIM_CODE.test(code)) {
      return { status: 400, json: { error: 'bad_request' } };
    }
    const w = this.windows.get(deviceId);
    if (!w || w.closed || w.claimed || w.until <= this.now) return { status: 403, json: { error: 'forbidden' } };
    if (w.hash !== hash(deviceId, code)) {
      w.failed += 1;
      if (w.failed >= MAX_CLAIM_ATTEMPTS) w.closed = true;
      return { status: 403, json: { error: 'forbidden' } };
    }
    w.claimed = true;
    const creds = {
      mqtt_username: deviceId,
      mqtt_password: randomBytes(24).toString('base64url'),
      device_key: randomBytes(32).toString('base64'),
      mqtt_url: this.mqttUrl,
      club_id: this.clubId,
    };
    this.issued.set(deviceId, creds);
    return { status: 200, json: creds };
  }

  /** Для ClaimingDevice({ post }): тот же разбор ответа, что у postClaim, без HTTP. */
  post = async ({ deviceId, claimCode }) => {
    const { status, json } = this.claim({ device_id: deviceId, claim_code: claimCode });
    if (status === 200) return { ok: true, creds: json };
    return { ok: false, error: json.error, status };
  };

  /** Настоящий HTTP-сервер поверх claim (для postClaim). */
  async listen() {
    this.server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (req.method !== 'POST' || req.url !== '/api/devices/claim') {
          res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not_found"}');
          return;
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          body = null;
        }
        const { status, json } = this.claim(body);
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
      });
    });
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${this.server.address().port}`;
  }

  async close() {
    if (!this.server) return;
    this.server.closeAllConnections?.();
    await new Promise((r) => this.server.close(r));
  }
}
