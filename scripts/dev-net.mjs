// Сети стенда и доверенные прокси (deploy/dev/compose.yml; замечания pentester M1-L1, M4-I4).
// Только встроенные модули Node: dev.mjs проверяет .env до `npm install`.
//
// Кто кому верит X-Forwarded-For и кому публичный API без лимита, решают адреса. Поэтому
// у каждой пары сервисов своя маленькая сеть, а у каждого сервиса в ней фиксированный адрес:
// +5 и +6 от начала подсети. Шлюз сети (+1) — это хост: запросы с хоста на localhost:3000
// и localhost:3101 приходят с адреса шлюза, и в доверенные он не входит.
//
//   server-web  caddy → server (имя server-web): сервер верит X-Forwarded-For от Caddy;
//   site-api    site → server (имя server-api): сервер верит X-Forwarded-For от сайта
//               (IP гостя для лимита заявок), публичный API сайту — без лимита;
//   site-web    caddy → site: сайт верит X-Forwarded-For только от Caddy.
//
// Остальные контейнеры (default) в эти сети не входят: с их адресов X-Forwarded-For
// не принимается, лимиты действуют.
//
// Подсети меняются в .env (SERVER_WEB_SUBNET, SITE_API_SUBNET, SITE_WEB_SUBNET), адреса
// npm run dev выводит из них сам (networkEnv) и передаёт Compose; в .env их нет.

import { isIP } from 'node:net';

/** Сети стенда: переменная подсети, подсеть по умолчанию, участники и их смещения. */
export const DEV_NETWORKS = {
  'server-web': { subnetVar: 'SERVER_WEB_SUBNET', subnet: '10.231.47.16/29', members: { server: 5, caddy: 6 } },
  'site-api': { subnetVar: 'SITE_API_SUBNET', subnet: '10.231.47.0/29', members: { server: 5, site: 6 } },
  'site-web': { subnetVar: 'SITE_WEB_SUBNET', subnet: '10.231.47.8/29', members: { caddy: 5, site: 6 } },
};

/** Переменная Compose с адресом сервиса в сети: SITE_API_SITE_IP. */
export const addrVar = (network, service) => `${network}_${service}_ip`.replaceAll('-', '_').toUpperCase();

/** Переменные с адресами прокси и сайта, которые проверяет dev.mjs. */
export const TRUST_VARS = ['TRUSTED_PROXY_CIDRS', 'PUBLIC_API_TRUSTED_CIDRS', 'SITE_TRUSTED_PROXIES'];

/** Самые широкие сети в списках доверенных: шире — почти наверняка ошибка (M4-I4). */
const MIN_PREFIX = { 4: 24, 6: 120 };

function ipv4ToInt(text) {
  if (isIP(text) !== 4) return null;
  return text.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

const intToIpv4 = (n) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');

/** 'a.b.c.d/nn' → { base, bits }; не подсеть IPv4 — null. */
export function parseSubnet(text) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(text ?? ''));
  if (!m) return null;
  const base = ipv4ToInt(m[1]);
  const bits = Number(m[2]);
  if (base === null || bits > 32) return null;
  return { base, bits, size: 2 ** (32 - bits) };
}

/** Подсети сетей стенда с учётом .env. */
function subnets(env) {
  return Object.fromEntries(Object.entries(DEV_NETWORKS).map(([name, n]) => [name, env[n.subnetVar] || n.subnet]));
}

/**
 * Адреса сервисов в сетях стенда по подсетям из env: { SITE_API_SITE_IP: '10.231.47.6', … }.
 * npm run dev передаёт их Compose (ipv4_address и доверенные адреса по умолчанию).
 */
export function networkEnv(env = {}) {
  const out = {};
  for (const [name, subnet] of Object.entries(subnets(env))) {
    const s = parseSubnet(subnet);
    if (!s) continue;
    for (const [service, offset] of Object.entries(DEV_NETWORKS[name].members)) out[addrVar(name, service)] = intToIpv4(s.base + offset);
  }
  return out;
}

/** Доверенные адреса по умолчанию — те же, что в deploy/dev/compose.yml. */
export function trustDefaults(env = {}) {
  const a = networkEnv(env);
  return {
    TRUSTED_PROXY_CIDRS: `${a.SERVER_WEB_CADDY_IP}/32,${a.SITE_API_SITE_IP}/32`,
    PUBLIC_API_TRUSTED_CIDRS: `${a.SITE_API_SITE_IP}/32`,
    SITE_TRUSTED_PROXIES: `${a.SITE_WEB_CADDY_IP}/32`,
  };
}

/** 'адрес[/маска]' → { family, addr, bits, base? }; неверное — строка с причиной. */
export function parseCidrEntry(text) {
  const [addr, len, extra] = String(text).split('/');
  const family = isIP(addr);
  if (!family || extra !== undefined) return 'не адрес IPv4 или IPv6';
  const max = family === 4 ? 32 : 128;
  if (len !== undefined && !/^\d{1,3}$/.test(len)) return 'неверная маска';
  const bits = len === undefined ? max : Number(len);
  if (bits > max) return 'неверная маска';
  if (bits < MIN_PREFIX[family]) return `сеть шире /${MIN_PREFIX[family]}`;
  return family === 4 ? { family, addr, bits, base: ipv4ToInt(addr) } : { family, addr, bits };
}

/** Адрес IPv4 входит в разобранный CIDR. */
function covers(cidr, ip) {
  if (cidr.family !== 4) return false;
  const n = ipv4ToInt(ip);
  const size = 2 ** (32 - cidr.bits);
  return n !== null && Math.floor(n / size) === Math.floor(cidr.base / size);
}

/**
 * Проверка сетей и доверенных адресов в .env: { errors, warnings }. Ошибки — значения, с
 * которыми стенд не поднимется или лимиты снимутся (широкая сеть, Caddy в адресах сайта);
 * предупреждения — значения, с которыми все гости окажутся за одним IP.
 */
export function checkNetworkEnv(env) {
  const errors = [];
  const warnings = [];
  const parsed = {};
  for (const n of Object.values(DEV_NETWORKS)) {
    const text = env[n.subnetVar];
    if (!text) continue;
    const s = parseSubnet(text);
    if (!s || s.bits < 24 || s.bits > 29) {
      errors.push(`${n.subnetVar} в .env — подсеть IPv4 от /24 до /29, например ${n.subnet}.`);
    } else if (s.base % s.size !== 0) {
      errors.push(`${n.subnetVar} в .env — ${text} не начало подсети: адрес должен делиться на размер сети (например ${intToIpv4(s.base - (s.base % s.size))}/${s.bits}).`);
    } else {
      parsed[n.subnetVar] = s;
    }
  }
  const all = Object.values(DEV_NETWORKS).map((n) => ({ name: n.subnetVar, s: parsed[n.subnetVar] ?? parseSubnet(n.subnet) }));
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const [a, b] = [all[i], all[j]];
      if (a.s.base < b.s.base + b.s.size && b.s.base < a.s.base + a.s.size) {
        errors.push(`подсети ${a.name} и ${b.name} пересекаются (с учётом значений по умолчанию) — задайте непересекающиеся.`);
      }
    }
  }

  const lists = {};
  for (const k of TRUST_VARS) {
    if (!env[k]) continue;
    const entries = env[k].split(',');
    const bad = entries.map((e) => [e, parseCidrEntry(e)]).filter(([, r]) => typeof r === 'string');
    if (bad.length > 0) {
      const [e, why] = bad[0];
      errors.push(
        `${k} в .env — адреса через запятую без пробелов, IPv4 с маской от /24 или IPv6 от /120, например 10.231.47.22/32 ` +
          `(«${e}»: ${why}). Доверять можно только конкретным адресам Caddy и сайта, не частным сетям целиком.`,
      );
      continue;
    }
    lists[k] = entries.map(parseCidrEntry);
  }

  const a = networkEnv(env);
  const caddyAddrs = [a.SERVER_WEB_CADDY_IP, a.SITE_WEB_CADDY_IP].filter(Boolean);
  const publicList = lists.PUBLIC_API_TRUSTED_CIDRS;
  if (publicList && caddyAddrs.some((ip) => publicList.some((c) => covers(c, ip)))) {
    errors.push('PUBLIC_API_TRUSTED_CIDRS в .env включает адрес Caddy: лимит публичного API снимется для всех браузеров. Оставьте только адрес сайта.');
  }
  const proxies = lists.TRUSTED_PROXY_CIDRS;
  if (proxies && a.SERVER_WEB_CADDY_IP && !proxies.some((c) => covers(c, a.SERVER_WEB_CADDY_IP))) {
    warnings.push(`TRUSTED_PROXY_CIDRS в .env без адреса Caddy в сети server-web (${a.SERVER_WEB_CADDY_IP}): сервер не увидит IP гостей, у всех браузеров будет общий лимит.`);
  }
  if (proxies && a.SITE_API_SITE_IP && !proxies.some((c) => covers(c, a.SITE_API_SITE_IP))) {
    warnings.push(`TRUSTED_PROXY_CIDRS в .env без адреса сайта в сети site-api (${a.SITE_API_SITE_IP}): лимит заявок с сайта будет общим для всех гостей.`);
  }
  const siteProxies = lists.SITE_TRUSTED_PROXIES;
  if (siteProxies && a.SITE_WEB_CADDY_IP && !siteProxies.some((c) => covers(c, a.SITE_WEB_CADDY_IP))) {
    warnings.push(`SITE_TRUSTED_PROXIES в .env без адреса Caddy в сети site-web (${a.SITE_WEB_CADDY_IP}): сайт не увидит IP гостей.`);
  }
  return { errors, warnings };
}
