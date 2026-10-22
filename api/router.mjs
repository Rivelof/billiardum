// Роутер API (контракт M1 §2.1, §3). Подключает все api/routes/*.mjs.
//
// Маршрут: { method, path, auth, roles?, handler, ...опции }
//   path      — '/api/clubs/{club}/audit'; параметры club, id и *_id проверяются как UUID (иначе 404);
//   auth      — 'none' | 'guest' (любой вошедший пользователь) | 'staff' (роль в клубе из roles)
//               | 'terminal' (токен терминала ресепшена) | 'any' (пользователь или терминал);
//   roles     — роли в клубе для 'staff': owner, manager, reception, installer, bar;
//   requires  — ['phone', 'consent']: без телефона — 403 phone_required, без согласия — 403 consent_required;
//   idempotent: true — заголовок Idempotency-Key (UUID) обязателен; повтор с тем же ключом
//               (пользователь, ключ, маршрут) 24 часа возвращает тот же ответ, с другим телом — 409;
//   rateLimit — { max, windowMs } на IP и маршрут (по умолчанию 600 в минуту);
//   actor     — 'system' для вебхуков: транзакция в контексте платформы (bl.ctx_is_platform());
//   clubFromBody — клуб берётся из body.club_id;
//   enabled   — (config) => boolean: маршрут не регистрируется, если false (вход для разработки в проде);
//   findClub  — async (db, req) => boolean: для 'staff' без клуба в запросе, когда у пользователя
//               несколько подходящих клубов, — есть ли объект в клубе из контекста;
//   queryAuth — async (app, token, query) => principal|null: вход по ?token= (одноразовый токен SSE);
//   db: false — auth 'none' или 'terminal': обработчик без транзакции запроса (ctx.db = null).
//               Сам открывает короткие транзакции ctx.withContext(ctx.pool, …) ПО ОЧЕРЕДИ:
//               обработчик не держит два соединения пула сразу (иначе параллельные запросы
//               числом с пул взаимно блокируют пул — pentester R-1). Для 'terminal' ctx.club —
//               клуб терминала; есть setCookie, нет afterCommit и useClub.
//
// Обработчик: async handler(ctx, req) → { status?, json?, headers?, body?, stream? }.
//   ctx = { ...общий контекст сервера, db, user, club, roles, principal, log, idempotencyKey,
//           useClub(clubId), setCookie(header), afterCommit(fn) };
//   req = { method, path, params, query, body, headers, ip, user, club, roles, idempotencyKey, raw };
//   stream: async (res) => {} — вызывается после коммита с сырым ответом (SSE).
// Исключение HttpError (или { status, code }) — откат и ответ { error: code }. Возвращённый
// ответ — коммит. Клуб запроса: {club} в пути → body.club_id (clubFromBody) → ?club= →
// заголовок X-Club-Id → клуб токена PIN или терминала → единственный клуб пользователя с ролью из roles.

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveToken, SESSION_COOKIE } from '../server/auth/index.mjs';
import { HttpError, toHttpError } from '../server/http/errors.mjs';
import { clientIp, originAllowed, parseCookies, readJsonBody } from '../server/http/request.mjs';
import { createRateLimiter, DEFAULT_LIMIT } from '../server/http/rate-limit.mjs';
import { afterCommit, isUuid, setContext, withContext } from '../server/lib/store.mjs';

export const ROUTES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'routes');
export const ROLES = Object.freeze({
  OWNER: Object.freeze(['owner']),
  MANAGER_UP: Object.freeze(['owner', 'manager']),
  RECEPTION_UP: Object.freeze(['owner', 'manager', 'reception']),
  INSTALLER: Object.freeze(['owner', 'installer']),
  // Бармен (№97): экран бара, статусы заказов, стоп-лист; без кассы, денег и зала.
  BAR: Object.freeze(['owner', 'manager', 'bar']),
});
export const ALL_ROLES = ['owner', 'manager', 'reception', 'installer', 'bar'];
export const IDEMPOTENCY_TTL_MS = 24 * 3600_000;

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const AUTH = new Set(['none', 'guest', 'staff', 'terminal', 'any']);
const UUID_PARAM = (name) => name === 'club' || name === 'id' || name.endsWith('_id') || name.endsWith('Id');

/** Заголовки безопасности всех ответов API (Caddy добавляет HSTS и свои). */
export const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'cross-origin-resource-policy': 'same-origin',
});

/** '/api/clubs/{club}/audit' → { regex, names, statics }. */
export function compilePath(pattern) {
  if (typeof pattern !== 'string' || !pattern.startsWith('/')) throw new Error(`маршрут ${pattern}: путь`);
  const names = [];
  let statics = 0;
  const parts = pattern.split('/').map((seg) => {
    const m = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(seg);
    if (m) {
      if (names.includes(m[1])) throw new Error(`маршрут ${pattern}: повтор параметра`);
      names.push(m[1]);
      return '([^/]+)';
    }
    if (/[{}]/.test(seg)) throw new Error(`маршрут ${pattern}: параметр — сегмент целиком`);
    if (seg) statics += 1;
    return seg.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  });
  return { regex: new RegExp(`^${parts.join('/')}$`), names, statics, shape: pattern.replace(/\{[^}]+\}/g, '{}') };
}

function validateRoute(r, file) {
  const where = `${file}: ${r?.method} ${r?.path}`;
  if (!r || typeof r !== 'object') throw new Error(`${file}: маршрут не объект`);
  if (!METHODS.has(r.method)) throw new Error(`${where}: метод`);
  if (typeof r.handler !== 'function') throw new Error(`${where}: handler`);
  if (!AUTH.has(r.auth)) throw new Error(`${where}: auth — none | guest | staff | terminal | any`);
  if (r.auth === 'staff' && (!Array.isArray(r.roles) || r.roles.length === 0 || !r.roles.every((x) => ALL_ROLES.includes(x)))) {
    throw new Error(`${where}: roles`);
  }
  if (r.requires && !r.requires.every((x) => x === 'phone' || x === 'consent')) throw new Error(`${where}: requires`);
  if (r.actor && r.actor !== 'system' && r.actor !== 'user') throw new Error(`${where}: actor`);
  if (r.db === false && ((r.auth !== 'none' && r.auth !== 'terminal') || r.idempotent)) throw new Error(`${where}: db: false только для auth 'none' и 'terminal'`);
}

/**
 * Маршруты из api/routes/*.mjs: export const routes = [...] или export function routes(config).
 * Маршрут с enabled(config) === false не регистрируется.
 */
export async function loadRoutes({ dir = ROUTES_DIR, config = {}, only = null } = {}) {
  const files = (await readdir(dir))
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && (!only || only.includes(f)))
    .sort();
  const all = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(dir, file)).href);
    const list = typeof mod.routes === 'function' ? await mod.routes(config) : mod.routes;
    if (!Array.isArray(list)) throw new Error(`api/routes/${file}: нет export routes`);
    for (const r of list) all.push({ ...r, file });
  }
  return all;
}

function compileRoutes(routes, config) {
  const compiled = [];
  const seen = new Map();
  for (const r of routes) {
    validateRoute(r, r.file ?? 'routes');
    if (typeof r.enabled === 'function' && !r.enabled(config)) continue;
    const c = { ...r, ...compilePath(r.path) };
    const key = `${r.method} ${c.shape}`;
    if (seen.has(key)) throw new Error(`маршрут ${key} объявлен дважды: ${seen.get(key)} и ${r.file}`);
    seen.set(key, r.file ?? 'routes');
    compiled.push(c);
  }
  // Сначала маршруты с большим числом постоянных сегментов: /api/x/new раньше /api/x/{id}.
  compiled.sort((a, b) => b.statics - a.statics);
  return compiled;
}

function requestHash(method, routePath, params, body) {
  return createHash('sha256').update(JSON.stringify([method, routePath, params, body])).digest('hex');
}

function bearer(headers) {
  const h = headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(h.trim());
  return m ? m[1] : null;
}

/**
 * @param {object} app общий контекст сервера (контракт §2.1): { config, log, pool, clock, ... }
 * @param {{ routes: object[], rateLimiter?: ReturnType<typeof createRateLimiter>,
 *           resolvePrincipal?: (token: string) => Promise<object|null> }} options
 */
export function createRouter(app, { routes, rateLimiter = createRateLimiter(), resolvePrincipal } = {}) {
  const config = app.config ?? {};
  const compiled = compileRoutes(routes, config);
  const resolve = resolvePrincipal ?? ((token) => resolveToken(app.pool, token));
  const allowedOrigins = (config.allowedOrigins ?? []).map((o) => o.toLowerCase());
  const consentVersion = config.consentVersion;
  // ctx.withContext — подпись M0: withContext(pool, { clubId, userId, actorType }, fn, options).
  const runInContext = (opts, fn, o) => (app.withContext ?? withContext)(app.pool, opts, fn, o);

  function match(method, pathname) {
    let methodMismatch = false;
    for (const r of compiled) {
      const m = r.regex.exec(pathname);
      if (!m) continue;
      if (r.method !== method) {
        methodMismatch = true;
        continue;
      }
      const params = {};
      for (let i = 0; i < r.names.length; i += 1) {
        let v;
        try {
          v = decodeURIComponent(m[i + 1]);
        } catch {
          return { error: new HttpError(404, 'not_found') };
        }
        if (UUID_PARAM(r.names[i])) {
          v = v.toLowerCase();
          if (!isUuid(v)) return { error: new HttpError(404, 'not_found') };
        }
        params[r.names[i]] = v;
      }
      return { route: r, params };
    }
    return { error: methodMismatch ? new HttpError(405, 'method_not_allowed') : new HttpError(404, 'not_found') };
  }

  function send(res, status, json, headers = {}, cookies = []) {
    const text = JSON.stringify(json);
    const h = { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers };
    if (cookies.length) h['set-cookie'] = cookies;
    res.writeHead(status, h);
    res.end(text);
  }

  async function rolesIn(db, clubId, userId) {
    if (!clubId || !userId) return [];
    const { rows } = await db.query('select role from bl.club_members where club_id = $1 and user_id = $2 and active', [clubId, userId]);
    return rows.map((r) => r.role);
  }

  /**
   * Обработать запрос. Возвращает false, если путь не наш (не начинается ни с одного маршрута)
   * — тогда вызывающий отвечает 404 сам.
   */
  async function handle(req, res) {
    const started = process.hrtime.bigint();
    const cookies = [];
    let route = null;
    let principal = null;
    let status = 500;
    try {
      let url;
      try {
        url = new URL(req.url ?? '/', 'http://localhost');
      } catch {
        throw new HttpError(400, 'bad_request');
      }
      const method = req.method ?? 'GET';
      const found = match(method, url.pathname);
      if (found.error) throw found.error;
      route = found.route;
      const { params } = found;
      const ip = clientIp(req, config.trustedProxies ? { trustedProxies: config.trustedProxies } : {});

      const limit = route.rateLimit ?? DEFAULT_LIMIT;
      const hit = rateLimiter.hit(`${ip}|${route.method} ${route.path}`, limit);
      if (!hit.ok) throw new HttpError(429, 'rate_limited', { headers: { 'retry-after': String(hit.retryAfterSec) } });

      // Кто делает запрос.
      const bearerToken = bearer(req.headers);
      const cookieJar = parseCookies(req.headers.cookie);
      const token = bearerToken ?? cookieJar[SESSION_COOKIE] ?? null;
      const tokenSource = bearerToken ? 'bearer' : token ? 'cookie' : null;

      // CSRF: изменяющий запрос с cookie — только со своего Origin; чужой Origin — всегда отказ.
      const mutating = MUTATING.has(method);
      if (mutating) {
        const origin = req.headers.origin;
        if (origin !== undefined && !originAllowed(origin, allowedOrigins)) throw new HttpError(403, 'forbidden', { detail: 'origin' });
        if (tokenSource === 'cookie' && origin === undefined) throw new HttpError(403, 'forbidden', { detail: 'origin required' });
      }
      const body = mutating ? await readJsonBody(req) : {};
      const query = {};
      for (const [k, v] of url.searchParams) if (!(k in query)) query[k] = v;

      if (token) principal = await resolve(token);
      // Токен в адресе — только у маршрутов с queryAuth (одноразовый токен SSE, §14).
      if (!principal && !token && typeof route.queryAuth === 'function' && typeof query.token === 'string') {
        principal = (await route.queryAuth(app, query.token, query)) ?? null;
      }
      const isUser = principal && (principal.kind === 'session' || principal.kind === 'pin');
      const isTerminal = principal && principal.kind === 'terminal';
      if (route.auth === 'guest' || route.auth === 'staff') {
        if (!isUser) throw new HttpError(401, 'unauthorized');
      } else if (route.auth === 'terminal') {
        if (!isTerminal) throw new HttpError(401, 'unauthorized');
      } else if (route.auth === 'any') {
        if (!principal) throw new HttpError(401, 'unauthorized');
      } else if (!isUser && !isTerminal) {
        principal = null;
      }
      if (route.requires?.includes('phone') && !principal?.hasPhone) throw new HttpError(403, 'phone_required');
      if (route.requires?.includes('consent') && !principal?.consents?.includes(consentVersion)) throw new HttpError(403, 'consent_required');

      // Клуб запроса. Анонимным маршрутам — только из пути (или ctx.useClub в обработчике).
      let club = params.club ?? null;
      const bound = route.auth !== 'none' && principal?.clubId ? principal.clubId : null;
      if (route.auth !== 'none') {
        if (!club && route.clubFromBody && body.club_id !== undefined) {
          if (!isUuid(body.club_id)) throw new HttpError(400, 'bad_request', { detail: 'club_id' });
          club = body.club_id;
        }
        if (!club && query.club !== undefined) {
          if (!isUuid(query.club)) throw new HttpError(400, 'bad_request', { detail: 'club' });
          club = query.club;
        }
        const headerClub = req.headers['x-club-id'];
        if (!club && typeof headerClub === 'string') {
          if (!isUuid(headerClub)) throw new HttpError(400, 'bad_request', { detail: 'x-club-id' });
          club = headerClub;
        }
        if (bound) {
          // Токен PIN и терминал действуют только в своём клубе.
          if (club && club !== bound) throw new HttpError(403, 'forbidden', { detail: 'token club' });
          club = bound;
        }
      }

      let idempotencyKey = null;
      const rawKey = req.headers['idempotency-key'];
      if (rawKey !== undefined) {
        if (typeof rawKey !== 'string' || !isUuid(rawKey.toLowerCase())) throw new HttpError(400, 'bad_request', { detail: 'idempotency-key' });
        idempotencyKey = rawKey.toLowerCase();
      }
      if (route.idempotent && (!idempotencyKey || !isUser)) {
        throw new HttpError(isUser ? 400 : 401, isUser ? 'bad_request' : 'unauthorized', { detail: 'idempotency-key required' });
      }

      const userId = isUser ? principal.userId : null;
      const actorType = route.actor === 'system' ? 'system' : 'user';
      const log = app.log;
      const reqInfo = {
        method,
        path: url.pathname,
        params,
        query,
        body,
        headers: req.headers,
        ip,
        user: isUser ? { id: principal.userId, hasPhone: principal.hasPhone, consents: principal.consents, tokenKind: principal.kind } : null,
        club: null,
        roles: [],
        idempotencyKey,
        principal,
        raw: req,
      };

      const result = route.db === false
        ? await (async () => {
            const own = route.auth === 'terminal' ? club : null;
            reqInfo.club = own;
            const out =
              (await route.handler(
                { ...app, db: null, log, principal, user: reqInfo.user, club: own, roles: [], setCookie: (header) => cookies.push(header) },
                reqInfo,
              )) ?? { status: 204 };
            if (Array.isArray(out.cookies)) cookies.push(...out.cookies);
            return { status: out.status ?? 200, json: out.json, headers: out.headers ?? {}, body: out.body, stream: out.stream };
          })()
        : await runInContext(
        { clubId: club, userId: route.actor === 'system' ? null : userId, actorType },
        async (db) => {
          const ctx = {
            ...app,
            db,
            log,
            principal,
            user: reqInfo.user,
            club,
            roles: [],
            idempotencyKey,
            setCookie: (header) => cookies.push(header),
            afterCommit: (fn) => afterCommit(db, fn),
            /** Перейти в контекст клуба внутри транзакции; возвращает роли пользователя в нём. */
            async useClub(clubId) {
              if (clubId !== null && !isUuid(clubId)) throw new Error('useClub: clubId');
              if (bound && clubId !== bound) throw new HttpError(403, 'forbidden', { detail: 'token club' });
              await setContext(db, { clubId });
              // Токен PIN даёт роли только в клубе своего терминала.
              const roles = principal?.clubId && principal.clubId !== clubId ? [] : await rolesIn(db, clubId, userId);
              ctx.club = clubId;
              ctx.roles = roles;
              reqInfo.club = clubId;
              reqInfo.roles = roles;
              return roles;
            },
          };
          if (club) {
            ctx.roles = principal?.clubId && principal.clubId !== club ? [] : await rolesIn(db, club, userId);
          } else if (route.auth === 'staff') {
            // Клуб не указан: единственный клуб пользователя с подходящей ролью.
            const { rows } = await db.query('select club_id, role from bl.club_members where user_id = $1 and active', [userId]);
            const eligible = rows.filter((r) => route.roles.includes(r.role));
            if (eligible.length === 0) throw new HttpError(403, 'forbidden');
            let chosen = eligible.length === 1 ? eligible[0] : null;
            if (!chosen && typeof route.findClub === 'function') {
              // Несколько клубов: объект ищется в каждом по очереди (RLS — только в своём клубе).
              for (const candidate of eligible) {
                await setContext(db, { clubId: candidate.club_id });
                if (await route.findClub(db, reqInfo)) {
                  chosen = candidate;
                  break;
                }
              }
              if (!chosen) throw new HttpError(404, 'not_found');
            }
            if (!chosen) throw new HttpError(400, 'bad_request', { detail: 'club required' });
            await setContext(db, { clubId: chosen.club_id });
            ctx.club = chosen.club_id;
            ctx.roles = [chosen.role];
          }
          reqInfo.club = ctx.club;
          reqInfo.roles = ctx.roles;
          if (route.auth === 'staff' && !ctx.roles.some((r) => route.roles.includes(r))) throw new HttpError(403, 'forbidden');

          // Идемпотентность: строка ключа вставляется первой; параллельный повтор ждёт коммита первого.
          let idem = null;
          if (route.idempotent) {
            idem = { route: `${route.method} ${route.path}`, hash: requestHash(method, route.path, params, body) };
            const ins = await db.query(
              `insert into bl.idempotency_keys (user_id, key, route, request_hash, created_at, expires_at)
               values ($1, $2, $3, $4, $5, $6)
               on conflict (user_id, key, route) do update
                 set request_hash = excluded.request_hash, response_status = null, response_body = null,
                     created_at = excluded.created_at, expires_at = excluded.expires_at
                 where bl.idempotency_keys.expires_at <= excluded.created_at
               returning 1`,
              [userId, idempotencyKey, idem.route, idem.hash, app.clock.now(), new Date(app.clock.now().getTime() + IDEMPOTENCY_TTL_MS)],
            );
            if (ins.rowCount === 0) {
              const prev = await db.query(
                'select request_hash, response_status, response_body from bl.idempotency_keys where user_id = $1 and key = $2 and route = $3',
                [userId, idempotencyKey, idem.route],
              );
              const p = prev.rows[0];
              if (!p || p.request_hash !== idem.hash || p.response_status === null) throw new HttpError(409, 'idempotency_conflict');
              return { status: p.response_status, json: p.response_body, headers: { 'idempotent-replayed': 'true' }, replayed: true };
            }
          }

          const out = (await route.handler(ctx, reqInfo)) ?? { status: 204 };
          const normalized = { status: out.status ?? 200, json: out.json, headers: out.headers ?? {}, body: out.body, stream: out.stream };
          if (idem && !normalized.stream && normalized.body === undefined) {
            await db.query(
              'update bl.idempotency_keys set response_status = $4, response_body = $5::jsonb where user_id = $1 and key = $2 and route = $3',
              [userId, idempotencyKey, idem.route, normalized.status, JSON.stringify(normalized.json ?? null)],
            );
          }
          if (Array.isArray(out.cookies)) cookies.push(...out.cookies);
          return normalized;
        },
        { onHookError: (err) => app.log.error('after_commit_failed', { route: route.path, error: err.message }) },
      );

      status = result.status;
      if (result.stream) {
        await result.stream(res, reqInfo);
        return true;
      }
      if (result.body !== undefined) {
        const h = { ...SECURITY_HEADERS, ...result.headers };
        if (cookies.length) h['set-cookie'] = cookies;
        res.writeHead(result.status, h);
        res.end(result.body);
      } else if (result.status === 204 || result.json === undefined) {
        const h = { ...SECURITY_HEADERS, ...result.headers };
        if (cookies.length) h['set-cookie'] = cookies;
        res.writeHead(result.status, h);
        res.end();
      } else {
        send(res, result.status, result.json, result.headers, cookies);
      }
      return true;
    } catch (err) {
      const e = toHttpError(err);
      status = e.status;
      if (e.status >= 500) {
        app.log.error('http_error', { route: route?.path ?? null, error: err?.message, code: err?.code });
      } else if (err?.message && err.message !== e.code) {
        app.log.debug('http_reject', { route: route?.path ?? null, code: e.code, detail: err.message });
      }
      if (!res.headersSent) send(res, e.status, { error: e.code, ...(e.data ?? {}) }, e.headers ?? {}, []);
      else res.destroy();
      return true;
    } finally {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      app.log.info('http', {
        method: req.method,
        route: route ? route.path : null,
        status,
        ms: Math.round(ms * 10) / 10,
        user_id: principal?.userId ?? null,
      });
    }
  }

  return { handle, routes: compiled, match, rateLimiter };
}
