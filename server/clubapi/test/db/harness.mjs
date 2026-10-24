// Стенд тестов clubapi на базе: временная база (миграции и сид), клуб Б, приложение с маршрутами
// core, clubapi (и дашборда — для сверки продаж), модуль clubapi с подменным DNS и доставкой.

import { CORE_ROUTE_FILES, startTestApp } from '../../../test/db/helpers.mjs';
import { loadRoutes } from '../../../../api/router.mjs';
import { seedClubB } from '../../../../supabase/tests/helpers.mjs';
import * as clubapiModule from '../../index.mjs';

export const CLUB = 'c1000000-0000-4000-8000-000000000001';
export const CLUB_B = 'c2000000-0000-4000-8000-000000000002';
export const OWNER = 'a1000000-0000-4000-8000-000000000001';
export const OWNER_B = 'a2000000-0000-4000-8000-000000000002';
export const T = (n) => `e1000000-0000-4000-8000-00000000000${n}`;

/** Изменяемые часы: now() и сдвиг. */
export function testClock(start = new Date()) {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    set: (d) => {
      t = new Date(d).getTime();
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

/**
 * @param {{ clock?: object, lookup?: Function, send?: Function, dashboard?: boolean, pollMs?: number }} [options]
 */
export async function startClubApi({ clock, lookup, send, dashboard = false, pollMs = 0 } = {}) {
  const routes = await loadRoutes({ only: [...CORE_ROUTE_FILES, 'clubapi.mjs', ...(dashboard ? ['dashboard.mjs'] : [])] });
  const t = await startTestApp({ routes, ...(clock ? { clock } : {}) });
  await seedClubB(t.admin);
  t.app.ctx.clubapiOptions = { ...(lookup ? { lookup } : {}), ...(send ? { send } : {}), pollMs };
  const mod = await clubapiModule.init(t.app.ctx);
  const tokens = {};
  for (const [k, phone] of Object.entries({ owner: '+70000000001', ownerB: '+70000000002', manager: '+70000000003', reception: '+70000000004' })) {
    tokens[k] = (await t.login(phone)).token;
  }
  /** Запрос владельца (или другого входа) к маршрутам программы клуба. */
  const as = (who, method, path, body) => t.request(method, path, { token: tokens[who], body });
  /** Запрос по ключу API; адрес IP — свой на каждый запрос, лимиты IP не мешают. */
  const api = (key, path, headers = {}) =>
    t.request('GET', path, { token: key, headers: { 'x-forwarded-for': `10.9.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`, ...headers } });
  async function newKey(scopes, who = 'owner', club = CLUB, name = 'Интеграция') {
    const r = await as(who, 'POST', `/api/clubs/${club}/api-keys`, { name, scopes });
    if (r.status !== 201) throw new Error(`api key: ${r.status} ${r.text}`);
    return r.json;
  }
  return {
    ...t,
    tokens,
    as,
    api,
    newKey,
    worker: mod.worker,
    async stop() {
      await clubapiModule.stop();
      await t.stop();
    },
  };
}

/** Все ключи объекта JSON (рекурсивно). */
export function allKeys(v, out = new Set()) {
  if (Array.isArray(v)) for (const x of v) allKeys(x, out);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      allKeys(x, out);
    }
  }
  return out;
}
