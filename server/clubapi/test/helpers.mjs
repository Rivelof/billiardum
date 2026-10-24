// Общее для тестов clubapi: приёмник вебхуков на HTTPS 127.0.0.1 с самоподписанным сертификатом
// (имя hooks.example.ru) и подменный DNS.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const HOOK_HOST = 'hooks.example.ru';

/** Самоподписанный сертификат на HOOK_HOST: { key, cert } (нужен openssl). */
export function selfSigned(host = HOOK_HOST) {
  const dir = mkdtempSync(join(tmpdir(), 'bl-clubapi-cert-'));
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '2',
      '-subj', `/CN=${host}`, '-addext', `subjectAltName=DNS:${host}`,
    ], { stdio: 'ignore' });
    return { key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Приёмник: отвечает по очереди статусами из replies (последний — дальше), записывает запросы.
 * @returns {Promise<{ port: number, cert: Buffer, requests: object[], connections: number, replies: number[], close(): Promise<void> }>}
 */
export async function startReceiver({ replies = [200], redirectTo = null } = {}) {
  const tls = selfSigned();
  const state = { requests: [], connections: 0, replies: [...replies] };
  const server = https.createServer(tls, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      state.requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      const status = state.replies.length > 1 ? state.replies.shift() : state.replies[0];
      const headers = status >= 300 && status < 400 && redirectTo ? { location: redirectTo } : {};
      res.writeHead(status, headers);
      res.end('ok');
    });
  });
  server.on('secureConnection', () => {
    state.connections += 1;
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return Object.assign(state, {
    port: server.address().port,
    cert: tls.cert,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  });
}

/** Подменный dns.lookup: имя → список адресов (или функция имени → список); нет имени — ENOTFOUND. */
export function fakeLookup(table) {
  const calls = [];
  const lookup = (host, options, cb) => {
    const callback = typeof options === 'function' ? options : cb;
    calls.push(host);
    const v = typeof table === 'function' ? table(host, calls.filter((h) => h === host).length) : table[host];
    if (!v || v.length === 0) {
      setImmediate(() => callback(Object.assign(new Error('not found'), { code: 'ENOTFOUND' })));
      return;
    }
    const list = v.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    setImmediate(() => callback(null, list));
  };
  lookup.calls = calls;
  return lookup;
}

/**
 * Кривые курсоры страниц (Н-1, Н-2 pentester M5.7): каждый — 400 bad_request, не 500.
 * [описание, значение параметра cursor].
 */
export function badCursors() {
  const b = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
  const id = '00000000-0000-4000-8000-000000000000';
  const at = '2026-10-24T10:00:00.000Z';
  return [
    ['время "1"', b(['1', id])],
    ['месяц 13', b(['2026-13-01T00:00:00.000Z', id])],
    ['дата без времени', b(['2026-10-24', id])],
    ['время числом', b([1761300000000, id])],
    ['не массив', b({ at, id })],
    ['лишний элемент', b([at, id, 1])],
    ['один элемент', b([at])],
    ['36 дефисов', b([at, '-'.repeat(36)])],
    ['не JSON', b('not json')],
    ['не base64', '@@@!'],
    ['base64 с паддингом', `${b([at, id])}=`],
  ];
}
