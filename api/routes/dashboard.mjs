// Дашборд владельца (M5.2, docs/contracts/m5-2.md §4, решения №166–172).
//   GET /api/clubs/{club}/dashboard?from&to&kind&compare&tab   — владелец и управляющий клуба
//   GET /api/clubs/all/dashboard?…                              — «Все мои клубы»: клубы, где пользователь
//                                                                 владелец или управляющий (№166)
//   GET /api/clubs/{club|all}/dashboard/now                     — статус зала сейчас
//   GET /api/clubs/{club|all}/dashboard/export.csv?from&to&table — только владелец; журнал owner.export
// Ошибки: 400 bad_request (период, вкладка, тип стола), 401, 403 (ресепшн, бар, чужой клуб), 404.
// Кэш ответа процесса — 60 с на (клуб или пользователь «всех клубов», период, вкладка, тип, сравнение);
// период с текущими сутками — 15 с. Кэш — после проверки прав.

import { ROLES } from '../router.mjs';
import { HttpError } from '../../server/http/errors.mjs';
import { buildExport } from '../../server/dashboard/export.mjs';
import { clubNow } from '../../server/dashboard/now.mjs';
import { buildDashboard, parseQuery } from '../../server/dashboard/service.mjs';
import { clubScope } from '../../server/dashboard/scope.mjs';
import { workingDayOf } from '../../server/dashboard/time.mjs';

export const CACHE_TTL_MS = 60_000;
export const CACHE_LIVE_TTL_MS = 15_000;
export const CACHE_MAX = 500;
const RATE = { max: 60, windowMs: 60_000 };
const VIEW_ROLES = ['owner', 'manager'];

/** Кэш ответов процесса: ключ → { expires, json }. */
export const cache = new Map();

function cacheGet(key, nowMs) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires <= nowMs) {
    cache.delete(key);
    return null;
  }
  return hit.json;
}

function cachePut(key, json, ttl, nowMs) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { expires: nowMs + ttl, json });
}

async function scope(ctx, req, opts) {
  return clubScope(ctx, req, opts);
}

function todayOf(club, now) {
  return workingDayOf(now, club.timezone, club.day_start_local);
}

function dashboardHandler(all) {
  return async (ctx, req) => {
    // «Деньги» — способы оплаты: управляющему сети нет (M5.5 №192, как экспорт №166).
    const s = await scope(ctx, req, { all, roles: VIEW_ROLES, allowNetwork: req.query.tab !== 'money' });
    const now = ctx.clock.now();
    const q = parseQuery(req.query, { today: todayOf(s.clubs[0], now) });
    const key = `${s.key}|${q.from}|${q.to}|${q.tab}|${q.kind ?? ''}|${q.compare ? 1 : 0}`;
    const nowMs = now.getTime();
    const hit = cacheGet(key, nowMs);
    if (hit) return { json: hit, headers: { 'x-cache': 'hit' } };
    const json = await buildDashboard(ctx.db, { clubs: s.clubs, enter: s.enter, q, now, all: s.all });
    cachePut(key, json, json.period.includes_today || q.to >= json.period.today ? CACHE_LIVE_TTL_MS : CACHE_TTL_MS, nowMs);
    return { json };
  };
}

function nowHandler(all) {
  return async (ctx, req) => {
    const s = await scope(ctx, req, { all, roles: VIEW_ROLES });
    const now = ctx.clock.now();
    const key = `now|${s.key}`;
    const hit = cacheGet(key, now.getTime());
    if (hit) return { json: hit, headers: { 'x-cache': 'hit' } };
    const clubs = [];
    for (const c of s.clubs) {
      await s.enter(c);
      const one = await clubNow(ctx, ctx.db, c, now);
      // Управляющему сети — выручка без разбивки по способам оплаты (M5.5 №192).
      if (c.viaNetwork && one.revenue_today) one.revenue_today = { ...one.revenue_today, by_method: null };
      clubs.push({ name: c.name, ...one });
    }
    const json = all ? { at: now.toISOString(), clubs, totals: sumTotals(clubs) } : { at: now.toISOString(), ...clubs[0], name: undefined };
    cachePut(key, json, CACHE_LIVE_TTL_MS, now.getTime());
    return { json };
  };
}

function sumTotals(clubs) {
  const t = { total: 0, busy: 0, reserved: 0, service: 0, free: 0, offline: 0, fault: 0 };
  for (const c of clubs) for (const k of Object.keys(t)) t[k] += c.totals[k] ?? 0;
  t.utilization_now_pct = t.total ? Math.round((t.busy / t.total) * 1000) / 10 : null;
  return t;
}

function exportHandler(all) {
  return async (ctx, req) => {
    const s = await scope(ctx, req, { all, roles: ['owner'] });
    const now = ctx.clock.now();
    const q = parseQuery({ ...req.query, tab: 'summary', compare: '0' }, { today: todayOf(s.clubs[0], now) });
    const table = req.query.table;
    if (typeof table !== 'string') throw new HttpError(400, 'bad_request', { detail: 'table' });
    const out = await buildExport(ctx.db, { clubs: s.clubs, enter: s.enter, q, table, now, all: s.all });
    // Журнал owner.export (№172): что и за какой период — в цепочку каждого выгруженного клуба.
    for (const c of s.clubs) {
      await s.enter(c);
      await ctx.audit.appendAudit(ctx.db, {
        action: 'owner.export',
        objectType: 'club',
        objectId: c.id,
        data: { source: 'dashboard', table, from: q.from, to: q.to, kind: q.kind, rows: out.rows, all: s.all },
      });
    }
    return {
      status: 200,
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${out.filename}"` },
      body: out.body,
    };
  };
}

export const routes = [
  { method: 'GET', path: '/api/clubs/{club}/dashboard', auth: 'staff', roles: [...ROLES.MANAGER_UP], rateLimit: RATE, handler: dashboardHandler(false) },
  { method: 'GET', path: '/api/clubs/all/dashboard', auth: 'guest', rateLimit: RATE, handler: dashboardHandler(true) },
  { method: 'GET', path: '/api/clubs/{club}/dashboard/now', auth: 'staff', roles: [...ROLES.MANAGER_UP], rateLimit: RATE, handler: nowHandler(false) },
  { method: 'GET', path: '/api/clubs/all/dashboard/now', auth: 'guest', rateLimit: RATE, handler: nowHandler(true) },
  { method: 'GET', path: '/api/clubs/{club}/dashboard/export.csv', auth: 'staff', roles: [...ROLES.OWNER], rateLimit: RATE, handler: exportHandler(false) },
  { method: 'GET', path: '/api/clubs/all/dashboard/export.csv', auth: 'guest', rateLimit: RATE, handler: exportHandler(true) },
];
