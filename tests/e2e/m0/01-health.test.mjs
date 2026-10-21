// Критерий 6: /health сервера напрямую и через Caddy (TLS внутреннего CA Caddy).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import https from 'node:https';
import { test } from 'node:test';
import { CADDY_CONTAINER } from './helpers.mjs';

function caddyRootCa() {
  const res = spawnSync('docker', ['exec', CADDY_CONTAINER, 'cat', '/data/caddy/pki/authorities/local/root.crt'], {
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`корень CA Caddy не прочитан: ${res.stderr.trim()}`);
  return res.stdout;
}

function httpsGet(url, ca) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { ca, timeout: 10_000 }, (res) => {
      const protocol = res.socket.getProtocol();
      const cert = res.socket.getPeerCertificate();
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, protocol, cert }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

test('GET http://localhost:3000/health → 200 {ok,db,mqtt}', async (t) => {
  const res = await fetch('http://localhost:3000/health');
  const body = await res.json();
  t.diagnostic(`HTTP ${res.status} ${JSON.stringify(body)}`);
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true, db: true, mqtt: true });
});

test('GET https://localhost:8443/health через Caddy с проверкой сертификата', async (t) => {
  const ca = caddyRootCa();
  const res = await httpsGet('https://localhost:8443/health', ca);
  t.diagnostic(`HTTPS ${res.status} ${res.protocol} issuer=${res.cert?.issuer?.CN} ${res.body}`);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, db: true, mqtt: true });
});

test('без CA Caddy TLS не доверяется (сертификат не публичный, проверка не отключена)', async () => {
  await assert.rejects(httpsGet('https://localhost:8443/health', undefined), /self[- ]signed|unable to verify|certificate/i);
});

test('неизвестный путь → 404 {"error":"not_found"} (ошибки только кодом)', async () => {
  const res = await fetch('http://localhost:3000/no-such-path');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
});
