// Исходящие HTTP(S)-запросы сервера, в том числе через прокси (Telegram: с сервера в РФ
// api.telegram.org закрыт, контракт M1 §11). Прокси — http://[логин:пароль@]хост:порт
// (туннель CONNECT) или socks5://[логин:пароль@]хост:порт (RFC 1928, вход RFC 1929).
// Без внешних пакетов. Ответ читается не больше maxBytes.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 1024 * 1024;

export class HttpClientError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'HttpClientError';
    this.code = code;
  }
}

function targetPort(url) {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

/** Читает из сокета ровно n байт (для рукопожатия SOCKS5). */
function reader(socket) {
  let buf = Buffer.alloc(0);
  let waiting = null;
  let failed = null;
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    pump();
  };
  const onEnd = () => {
    failed = new HttpClientError('proxy_closed', 'прокси закрыл соединение');
    pump();
  };
  const onError = (err) => {
    failed = err;
    pump();
  };
  function pump() {
    if (!waiting) return;
    if (buf.length >= waiting.n) {
      const out = buf.subarray(0, waiting.n);
      buf = buf.subarray(waiting.n);
      const { resolve } = waiting;
      waiting = null;
      resolve(out);
    } else if (failed) {
      const { reject } = waiting;
      waiting = null;
      reject(failed);
    }
  }
  socket.on('data', onData);
  socket.on('end', onEnd);
  socket.on('error', onError);
  return {
    read(n) {
      return new Promise((resolve, reject) => {
        waiting = { n, resolve, reject };
        pump();
      });
    },
    detach() {
      socket.removeListener('data', onData);
      socket.removeListener('end', onEnd);
      socket.removeListener('error', onError);
      if (buf.length > 0) socket.unshift(buf);
    },
  };
}

async function socks5Tunnel(proxy, host, port, timeoutMs) {
  const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port || 1080) });
  socket.setTimeout(timeoutMs, () => socket.destroy(new HttpClientError('timeout', 'прокси: таймаут')));
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const r = reader(socket);
  try {
    const user = decodeURIComponent(proxy.username);
    const pass = decodeURIComponent(proxy.password);
    const methods = user ? [0x00, 0x02] : [0x00];
    socket.write(Buffer.from([0x05, methods.length, ...methods]));
    const [ver, method] = await r.read(2);
    if (ver !== 0x05) throw new HttpClientError('proxy_protocol', 'SOCKS5: неверная версия');
    if (method === 0x02) {
      const u = Buffer.from(user, 'utf8');
      const p = Buffer.from(pass, 'utf8');
      if (u.length > 255 || p.length > 255) throw new HttpClientError('proxy_auth', 'SOCKS5: длинный логин');
      socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
      const [, status] = await r.read(2);
      if (status !== 0x00) throw new HttpClientError('proxy_auth', 'SOCKS5: вход отклонён');
    } else if (method !== 0x00) {
      throw new HttpClientError('proxy_auth', 'SOCKS5: способ входа не принят');
    }
    const h = Buffer.from(host, 'utf8');
    if (h.length > 255) throw new HttpClientError('proxy_protocol', 'SOCKS5: длинное имя хоста');
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, Buffer.from([port >> 8, port & 0xff])]));
    const head = await r.read(4);
    if (head[0] !== 0x05 || head[1] !== 0x00) throw new HttpClientError('proxy_refused', `SOCKS5: отказ ${head[1]}`);
    const atyp = head[3];
    if (atyp === 0x01) await r.read(4 + 2);
    else if (atyp === 0x04) await r.read(16 + 2);
    else if (atyp === 0x03) {
      const [len] = await r.read(1);
      await r.read(len + 2);
    } else throw new HttpClientError('proxy_protocol', 'SOCKS5: неизвестный тип адреса');
  } catch (err) {
    socket.destroy();
    throw err;
  } finally {
    r.detach();
  }
  socket.setTimeout(0);
  return socket;
}

function connectTunnel(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const headers = { host: `${host}:${port}` };
    if (proxy.username) {
      const cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers['proxy-authorization'] = `Basic ${Buffer.from(cred, 'utf8').toString('base64')}`;
    }
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
      agent: false,
      timeout: timeoutMs,
    });
    req.on('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new HttpClientError('proxy_refused', `CONNECT: ${res.statusCode}`));
        return;
      }
      if (head && head.length > 0) socket.unshift(head);
      resolve(socket);
    });
    req.on('timeout', () => req.destroy(new HttpClientError('timeout', 'прокси: таймаут')));
    req.on('error', reject);
    req.end();
  });
}

/** Сокет до цели через прокси; для https — уже с TLS и проверкой сертификата цели. */
async function tunnel(proxyUrl, url, timeoutMs) {
  const proxy = new URL(proxyUrl);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = targetPort(url);
  let socket;
  if (proxy.protocol === 'http:') socket = await connectTunnel(proxy, host, port, timeoutMs);
  else if (proxy.protocol === 'socks5:' || proxy.protocol === 'socks5h:') socket = await socks5Tunnel(proxy, host, port, timeoutMs);
  else throw new HttpClientError('proxy_unsupported', 'прокси: только http:// и socks5://');
  if (url.protocol !== 'https:') return socket;
  const secure = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, ALPNProtocols: ['http/1.1'] });
  await new Promise((resolve, reject) => {
    secure.once('secureConnect', resolve);
    secure.once('error', reject);
  });
  return secure;
}

/**
 * HTTP(S)-запрос. body — Buffer или строка.
 * @param {string} urlText
 * @param {{ method?: string, headers?: Record<string,string>, body?: Buffer|string, proxyUrl?: string|null,
 *           timeoutMs?: number, maxBytes?: number }} [options]
 * @returns {Promise<{ status: number, headers: Record<string, string|string[]>, body: Buffer }>}
 */
export async function httpRequest(urlText, { method = 'GET', headers = {}, body, proxyUrl = null, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const url = new URL(urlText);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpClientError('bad_url', 'только http и https');
  const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const lib = url.protocol === 'https:' ? https : http;
  const deadline = AbortSignal.timeout(timeoutMs);
  const socket = proxyUrl ? await tunnel(proxyUrl, url, timeoutMs) : null;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: targetPort(url),
        path: `${url.pathname}${url.search}`,
        method,
        headers: { ...headers, ...(payload ? { 'content-length': String(payload.length) } : {}) },
        agent: false,
        signal: deadline,
        ...(socket ? { createConnection: () => socket } : {}),
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new HttpClientError('too_large', 'ответ больше предела'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('error', (err) => {
      socket?.destroy();
      reject(err?.name === 'AbortError' ? new HttpClientError('timeout', 'таймаут запроса') : err);
    });
    if (payload) req.write(payload);
    req.end();
  });
}
