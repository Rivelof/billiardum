import { createSite } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { createData } from '../src/data.mjs';
import * as mock from '../mock/api.mjs';

/** Сайт на заглушке (демо-данные) или на поддельном API (fetchImpl). */
export function site({ env = {}, fetchImpl = null, now } = {}) {
  const cfg = loadConfig({ SITE_ORIGIN: 'https://billiardum.test', ...(fetchImpl ? { BL_API_URL: 'http://api' } : {}), ...env });
  const data = fetchImpl ? createData({ apiUrl: 'http://api', mock: false, fetchImpl }) : createData({ mock: true, mockApi: mock });
  const handle = createSite({ cfg, data, now, mockApi: mock });
  return { cfg, handle, get: (url, headers = {}) => handle({ method: 'GET', url, headers }), post: (url, body, headers = {}) => handle({ method: 'POST', url, body, headers, ip: '203.0.113.5' }) };
}

/** JSON-LD страницы. */
export function jsonld(htmlText) {
  return [...htmlText.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
}

export { mock };

export const CLUB_PLATFORM = '/ekaterinburg/svoyak/';
export const CLUB_REQUEST = '/ekaterinburg/rezerv/';
export const T_LIVE = '/turniry/22222222-2222-4222-8222-000000000001/';
