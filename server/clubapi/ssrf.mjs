// Защита исходящих вебхуков от SSRF (M5.7 №201): адрес только https на стандартном порту, без
// учётных данных в адресе; имя резолвится, и каждый адрес должен быть публичным (не внутренним,
// не локальным, не зарезервированным, в том числе IPv6, IPv4 внутри IPv6, NAT64, 6to4, Teredo).
// Проверка IP — при каждом соединении (safeLookup в https.request): ответ DNS, сменившийся после
// регистрации адреса (DNS rebinding), не пускает соединение во внутреннюю сеть. Редиректы
// не выполняются (deliver.mjs).

import dns from 'node:dns';
import net from 'node:net';

export const MAX_URL_LENGTH = 2048;
export const DEFAULT_PORTS = Object.freeze([443]);

export class UrlError extends Error {
  /** @param {'url_invalid'|'url_forbidden'} code @param {string} detail только для лога */
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'UrlError';
    this.code = code;
    this.status = 400;
  }
}

/** Строгий разбор IPv4 a.b.c.d → [a, b, c, d] или null. */
export function parseIPv4(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((x) => x > 255)) return null;
  if (m.slice(1).some((x) => x.length > 1 && x.startsWith('0'))) return null;
  return parts;
}

/** Разбор IPv6 (в том числе :: и хвост a.b.c.d) → 8 чисел по 16 бит или null. Зона (%eth0) — null. */
export function parseIPv6(input) {
  if (typeof input !== 'string' || input.length === 0 || input.length > 45 || input.includes('%')) return null;
  let s = input.toLowerCase();
  let tail = [];
  const lastColon = s.lastIndexOf(':');
  if (s.includes('.')) {
    const v4 = parseIPv4(s.slice(lastColon + 1));
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    // «::1.2.3.4» → «::», «::ffff:1.2.3.4» → «::ffff», «1:2:3:4:5:6:1.2.3.4» → «1:2:3:4:5:6».
    s = s.slice(0, lastColon + 1);
    if (!s.endsWith('::')) s = s.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const group = (x) => (x === '' ? [] : x.split(':'));
  const head = group(halves[0]);
  const rest = halves.length === 2 ? group(halves[1]) : [];
  const valid = (g) => /^[0-9a-f]{1,4}$/.test(g);
  if (![...head, ...rest].every(valid)) return null;
  const known = head.length + rest.length + tail.length;
  let groups;
  if (halves.length === 2) {
    if (known > 7) return null;
    groups = [...head.map((g) => parseInt(g, 16)), ...Array(8 - known).fill(0), ...rest.map((g) => parseInt(g, 16)), ...tail];
  } else {
    if (known !== 8) return null;
    groups = [...head.map((g) => parseInt(g, 16)), ...tail];
  }
  return groups.length === 8 ? groups : null;
}

// Внутренние, локальные и зарезервированные сети IPv4 (RFC 6890 и IANA special-purpose).
const V4_BLOCKED = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].map(([a, bits]) => {
  const p = parseIPv4(a);
  return { base: ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3], bits };
});

function v4Num(p) {
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

/** Публичный ли адрес IPv4 (массив из 4 чисел). */
export function isPublicIPv4(p) {
  const n = v4Num(p);
  for (const { base, bits } of V4_BLOCKED) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((n & mask) >>> 0) === ((base & mask) >>> 0)) return false;
  }
  return true;
}

/** Публичный ли адрес IPv6 (8 групп): только глобальный unicast 2000::/3 без особых сетей. */
export function isPublicIPv6(g) {
  // IPv4 внутри IPv6: ::ffff:a.b.c.d (mapped) — по адресу IPv4; ::a.b.c.d (compatible),
  // ::ffff:0:a.b.c.d (translated) — отказ.
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return isPublicIPv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
  }
  if ((g[0] & 0xe000) !== 0x2000) return false; // ::/3 (::, ::1, совместимые, NAT64 64:ff9b::), fc00::/7, fe80::/10, ff00::/8 …
  if (g[0] === 0x2001 && g[1] < 0x0200) return false; // 2001::/23 — IETF: Teredo 2001::/32, ORCHID, бенчмарк
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // документация
  if (g[0] === 0x2002) return false; // 6to4 — внутри может быть внутренний IPv4
  if ((g[0] & 0xfff0) === 0x3ff0) return false; // 3fff::/20 — документация
  return true;
}

/** Публичный ли адрес (строка IPv4 или IPv6, без скобок). Не адрес — false. */
export function isPublicAddress(address) {
  if (typeof address !== 'string') return false;
  const kind = net.isIP(address);
  if (kind === 4) {
    const p = parseIPv4(address);
    return Boolean(p) && isPublicIPv4(p);
  }
  if (kind === 6) {
    const g = parseIPv6(address);
    return Boolean(g) && isPublicIPv6(g);
  }
  return false;
}

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.intranet', '.lan', '.home', '.corp', '.home.arpa', '.arpa', '.onion', '.test', '.invalid', '.example'];
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Синтаксис адреса вебхука → { url: URL, host, ip: string|null }. Ошибка — UrlError:
 * url_invalid (не https, порт, учётные данные, фрагмент, имя) или url_forbidden (адрес-IP не публичный,
 * локальное имя).
 * @param {string} raw
 * @param {{ ports?: readonly number[] }} [options] ports — разрешённые порты (по умолчанию только 443)
 */
export function checkUrlSyntax(raw, { ports = DEFAULT_PORTS } = {}) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) throw new UrlError('url_invalid', 'length');
  // eslint-disable-next-line no-control-regex -- управляющие символы в адресе запрещены
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) throw new UrlError('url_invalid', 'whitespace');
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new UrlError('url_invalid', 'parse');
  }
  if (u.protocol !== 'https:') throw new UrlError('url_invalid', 'scheme');
  if (u.username || u.password) throw new UrlError('url_invalid', 'credentials');
  if (u.hash || raw.includes('#')) throw new UrlError('url_invalid', 'fragment');
  const port = u.port === '' ? 443 : Number(u.port);
  if (!ports.includes(port)) throw new UrlError('url_invalid', 'port');
  let host = u.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host) throw new UrlError('url_invalid', 'host');
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw new UrlError('url_forbidden', 'ip literal');
    return { url: u, host, port, ip: host };
  }
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  if (name === 'localhost' || BLOCKED_SUFFIXES.some((s) => name.endsWith(s))) throw new UrlError('url_forbidden', 'local name');
  const labels = name.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels[labels.length - 1])) throw new UrlError('url_invalid', 'host');
  return { url: u, host: name, port, ip: null };
}

/**
 * Все адреса имени: lookup в виде dns.lookup(host, { all: true, verbatim: true }, cb).
 * @returns {Promise<{ address: string, family: number }[]>}
 */
export function resolveAll(host, lookup = dns.lookup) {
  return new Promise((resolve, reject) => {
    lookup(host, { all: true, verbatim: true }, (err, list) => {
      if (err) reject(err);
      else resolve(Array.isArray(list) ? list : []);
    });
  });
}

/**
 * Проверка адреса вебхука при регистрации: синтаксис и все адреса имени публичные.
 * @returns {Promise<string>} нормализованный адрес
 */
export async function validateWebhookUrl(raw, { lookup = dns.lookup, ports = DEFAULT_PORTS, isAllowed = isPublicAddress } = {}) {
  const { url, host, ip } = checkUrlSyntax(raw, { ports });
  if (!ip) {
    let list;
    try {
      list = await resolveAll(host, lookup);
    } catch {
      throw new UrlError('url_invalid', 'dns');
    }
    if (list.length === 0) throw new UrlError('url_invalid', 'dns empty');
    if (!list.every((a) => isAllowed(a.address))) throw new UrlError('url_forbidden', 'resolves to blocked address');
  }
  return url.href;
}

/**
 * lookup для https.request: адреса имени проверяются при каждом соединении; хотя бы один
 * непубличный — отказ (код url_forbidden), соединение не открывается.
 */
export function safeLookup(baseLookup = dns.lookup, isAllowed = isPublicAddress) {
  return function lookup(hostname, options, callback) {
    const opts = typeof options === 'function' ? {} : options ?? {};
    const cb = typeof options === 'function' ? options : callback;
    baseLookup(hostname, { all: true, verbatim: true }, (err, list) => {
      if (err) return cb(err);
      const all = Array.isArray(list) ? list : [];
      if (all.length === 0) return cb(Object.assign(new Error('no address'), { code: 'ENOTFOUND' }));
      if (!all.every((a) => isAllowed(a.address))) return cb(Object.assign(new Error('blocked address'), { code: 'url_forbidden' }));
      const wanted = opts.family === 4 || opts.family === 6 ? all.filter((a) => a.family === opts.family) : all;
      if (wanted.length === 0) return cb(Object.assign(new Error('no address of family'), { code: 'ENOTFOUND' }));
      if (opts.all) return cb(null, wanted);
      return cb(null, wanted[0].address, wanted[0].family);
    });
  };
}
