/**
 * Настройки сайта из окружения (.env, корень репозитория — devops). Секретов здесь нет.
 *
 *   PORT                 порт сервера сайта (по умолчанию 3100)
 *   BL_API_URL           адрес сервера API по внутренней сети, например http://server:3000;
 *                        пусто или «mock» — заглушка web/site/mock/ (только разработка)
 *   SITE_ORIGIN          публичный адрес сайта для канонических ссылок, sitemap и OG: https://billiardum.ru
 *   YANDEX_METRIKA_ID    номер счётчика Метрики; пусто — счётчика нет (решение №141)
 *   YANDEX_VERIFICATION  код подтверждения Яндекс Вебмастера (meta yandex-verification); пусто — нет
 *   BL_SITE_CACHE_MS     время жизни кэша ответов API, по умолчанию 60 000 мс
 *   BL_SITE_NOINDEX      1 — запретить индексацию (стенды): robots.txt Disallow: /, meta robots noindex
 *   SITE_TRUSTED_PROXIES доверенные прокси (CIDR через запятую): только от них сайт верит X-Forwarded-For;
 *                        по умолчанию 127.0.0.1/32,::1/128. В Compose — подсеть, откуда приходит Caddy
 *   BL_SITE_RATE_PER_MIN лимит запросов в API на IP гостя в минуту (IPv6 — на /64), по умолчанию 120;
 *                        0 — без лимита. Статика и страницы из кэша не считаются (M4-6)
 */

import process from 'node:process';
import { parseCidrs } from './net.mjs';

export function loadConfig(env = process.env) {
  const api = (env.BL_API_URL ?? '').trim();
  const mock = api === '' || api === 'mock';
  const origin = (env.SITE_ORIGIN ?? '').trim().replace(/\/+$/, '') || `http://localhost:${env.PORT || 3100}`;
  const metrika = /^\d{4,12}$/.test(env.YANDEX_METRIKA_ID ?? '') ? env.YANDEX_METRIKA_ID : null;
  const verification = /^[0-9a-f]{8,64}$/i.test(env.YANDEX_VERIFICATION ?? '') ? env.YANDEX_VERIFICATION : null;
  return Object.freeze({
    port: Number(env.PORT) || 3100,
    apiUrl: mock ? null : api.replace(/\/+$/, ''),
    mock,
    origin,
    metrika,
    verification,
    cacheMs: Number(env.BL_SITE_CACHE_MS) >= 0 && env.BL_SITE_CACHE_MS !== undefined && env.BL_SITE_CACHE_MS !== '' ? Number(env.BL_SITE_CACHE_MS) : 60_000,
    noindex: env.BL_SITE_NOINDEX === '1',
    trustedProxies: parseCidrs(env.SITE_TRUSTED_PROXIES?.trim() ? env.SITE_TRUSTED_PROXIES : '127.0.0.1/32,::1/128'),
    ratePerMinute: /^\d{1,6}$/.test(env.BL_SITE_RATE_PER_MIN ?? '') ? Number(env.BL_SITE_RATE_PER_MIN) : 120,
    dev: env.BL_SITE_DEV === '1',
  });
}
