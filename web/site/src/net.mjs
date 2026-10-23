/**
 * IP гостя за прокси. X-Forwarded-For верим только от доверенного прокси (Caddy): адрес сокета
 * должен входить в SITE_TRUSTED_PROXIES. Тогда идём по X-Forwarded-For справа налево, пропуская
 * доверенные адреса, и берём первый недоверенный — его дописал наш прокси. Иначе — адрес сокета.
 * IP уходит в API (X-Forwarded-For) только для лимитов заявок; в лог сайта не пишется.
 */
import { isIP } from 'node:net';

/** '10.0.0.0/8' | '::1/128' | '127.0.0.1' → { bytes, bits }; неверное — null. */
export function parseCidr(text) {
  const [addr, len] = String(text).trim().split('/');
  const bytes = ipBytes(addr);
  if (!bytes) return null;
  const max = bytes.length * 8;
  const bits = len === undefined ? max : Number(len);
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null;
  return { bytes, bits };
}

/** IPv4 и IPv6 (в том числе ::ffff:a.b.c.d) → байты; IPv4-mapped сводится к IPv4. */
export function ipBytes(ip) {
  const s = String(ip ?? '').trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const v = isIP(s);
  if (v === 4) return s.split('.').map(Number);
  if (v !== 6) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (mapped) return ipBytes(mapped[1]);
  let head = s;
  let tail4 = [];
  const m4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m4) {
    head = m4[1].endsWith('::') ? m4[1] : m4[1].slice(0, -1);
    tail4 = ipBytes(m4[2]);
  }
  const [l, r] = head.split('::');
  const left = l ? l.split(':') : [];
  const right = r ? r.split(':') : [];
  const groups = 8 - tail4.length / 2;
  const fill = head.includes('::') ? Array(groups - left.length - right.length).fill('0') : [];
  const all = [...left, ...fill, ...right];
  if (all.length !== groups) return null;
  const out = [];
  for (const g of all) {
    const n = parseInt(g || '0', 16);
    out.push(n >> 8, n & 0xff);
  }
  return [...out, ...tail4];
}

export function parseCidrs(list) {
  return String(list ?? '').split(',').map(parseCidr).filter(Boolean);
}

export function inCidrs(ip, cidrs) {
  const b = ipBytes(ip);
  if (!b) return false;
  return cidrs.some((c) => {
    if (c.bytes.length !== b.length) return false;
    let left = c.bits;
    for (let i = 0; left > 0; i += 1, left -= 8) {
      const mask = left >= 8 ? 0xff : (0xff << (8 - left)) & 0xff;
      if ((b[i] & mask) !== (c.bytes[i] & mask)) return false;
    }
    return true;
  });
}

/**
 * @param {string | undefined} socketAddr адрес, с которого пришло соединение
 * @param {string | undefined} xff заголовок X-Forwarded-For
 * @param {object[]} trusted parseCidrs(SITE_TRUSTED_PROXIES)
 */
export function clientIp(socketAddr, xff, trusted) {
  const sock = ipBytes(socketAddr) ? String(socketAddr).replace(/^::ffff:(?=\d+\.)/i, '') : null;
  if (!sock || !inCidrs(sock, trusted)) return sock;
  const chain = String(xff ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    if (!ipBytes(chain[i])) return sock;
    if (!inCidrs(chain[i], trusted)) return chain[i].replace(/^::ffff:(?=\d+\.)/i, '');
  }
  return sock;
}
