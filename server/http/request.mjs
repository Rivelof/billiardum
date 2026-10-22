// Разбор запроса: тело JSON до 64 КБ, cookie, адрес клиента, Origin.

import { isIP } from 'node:net';
import { HttpError } from './errors.mjs';

export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Тело JSON-объекта. Content-Type обязан быть application/json (контракт §3).
 * Пустое тело — {}. Больше 64 КБ — 413, не JSON или не объект — 400.
 */
export async function readJsonBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
  const type = String(req.headers['content-type'] ?? '').toLowerCase();
  const mime = type.split(';')[0].trim();
  if (mime !== 'application/json') throw new HttpError(415, 'bad_request', { detail: 'content-type' });
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume();
    throw new HttpError(413, 'bad_request', { detail: 'body too large' });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      req.resume();
      throw new HttpError(413, 'bad_request', { detail: 'body too large' });
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_request', { detail: 'json' });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'bad_request', { detail: 'json object expected' });
  }
  return value;
}

/** Cookie запроса: имя → значение (первое вхождение). */
export function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string' || header.length > 8192) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Set-Cookie. По умолчанию HttpOnly, Secure, SameSite=Lax (контракт §3).
 * @param {string} name
 * @param {string} value
 * @param {{ maxAgeSec?: number, path?: string, httpOnly?: boolean, secure?: boolean, sameSite?: 'Lax'|'Strict'|'None' }} [options]
 */
export function serializeCookie(name, value, { maxAgeSec, path = '/', httpOnly = true, secure = true, sameSite = 'Lax' } = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('bad cookie name');
  if (!/^[A-Za-z0-9_.~-]*$/.test(value)) throw new Error('bad cookie value');
  const parts = [`${name}=${value}`, `Path=${path}`];
  if (maxAgeSec !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  parts.push(`SameSite=${sameSite}`);
  return parts.join('; ');
}

/** Сети, из которых принимается X-Forwarded-For по умолчанию: loopback и частные сети (Docker). */
export const DEFAULT_TRUSTED_PROXY_CIDRS = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '::1/128', 'fc00::/7'];

function stripMapped(ip) {
  return typeof ip === 'string' && ip.toLowerCase().startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

/** Адрес → BigInt и разрядность (32 или 128); не адрес — null. */
function ipToBigInt(ip) {
  const a = stripMapped(ip);
  const kind = isIP(a);
  if (kind === 4) {
    return { bits: 32, value: a.split('.').reduce((acc, part) => (acc << 8n) + BigInt(Number(part)), 0n) };
  }
  if (kind !== 6) return null;
  let text = a.toLowerCase().split('%')[0];
  // Хвост в виде IPv4 (::ffff:1.2.3.4 уже снят, но бывает 64:ff9b::1.2.3.4).
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const n = v4[1].split('.').map(Number);
    text = `${text.slice(0, -v4[1].length)}${((n[0] << 8) | n[1]).toString(16)}:${((n[2] << 8) | n[3]).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8) return null;
  return { bits: 128, value: groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g || '0', 16)), 0n) };
}

/** 'адрес/маска' → проверка принадлежности; разбор один раз. */
export function parseCidrs(list) {
  return list.map((cidr) => {
    const [addr, lenText] = String(cidr).trim().split('/');
    const ip = ipToBigInt(addr);
    if (!ip) throw new Error(`CIDR ${cidr}: адрес`);
    const len = lenText === undefined ? ip.bits : Number(lenText);
    if (!Number.isInteger(len) || len < 0 || len > ip.bits) throw new Error(`CIDR ${cidr}: длина маски`);
    const shift = BigInt(ip.bits - len);
    return { bits: ip.bits, shift, prefix: ip.value >> shift };
  });
}

export function ipInCidrs(ip, cidrs) {
  const v = ipToBigInt(ip);
  if (!v) return false;
  return cidrs.some((c) => c.bits === v.bits && v.value >> c.shift === c.prefix);
}

const DEFAULT_CIDRS = parseCidrs(DEFAULT_TRUSTED_PROXY_CIDRS);

/**
 * Адрес клиента. X-Forwarded-For принимается, только если соединение пришло с адреса
 * доверенного прокси (Caddy: сеть Compose, loopback; TRUSTED_PROXY_CIDRS) — тогда берётся
 * последний адрес цепочки: его записал сам Caddy. Иначе — адрес сокета: подделанный
 * X-Forwarded-For с внешнего адреса ничего не меняет (ограничение частоты не обойти).
 * @param {import('node:http').IncomingMessage} req
 * @param {{ trustedProxies?: ReturnType<typeof parseCidrs> }} [options]
 */
export function clientIp(req, { trustedProxies = DEFAULT_CIDRS } = {}) {
  const peer = stripMapped(req.socket?.remoteAddress ?? '');
  if (ipInCidrs(peer, trustedProxies)) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length <= 2048) {
      const last = xff.split(',').map((s) => s.trim()).filter(Boolean).pop();
      if (last && isIP(stripMapped(last))) return stripMapped(last);
    }
  }
  return peer;
}

/** Origin разрешён: точное совпадение схемы, хоста и порта со списком. */
export function originAllowed(origin, allowed) {
  if (typeof origin !== 'string' || origin === 'null') return false;
  return allowed.includes(origin.toLowerCase());
}
