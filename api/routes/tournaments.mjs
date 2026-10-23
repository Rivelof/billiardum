// Турниры (контракт M4 §4, формы — docs/contracts/m4-api.md «Турниры»). Логика — server/tournaments/
// (backend-tournaments). Ошибки — TournamentError и ошибки соседей { status, code } → {"error": code}.

import { tournaments } from '../../server/tournaments/index.mjs';

const svc = () => tournaments().service;
const userId = (req) => req.user?.id ?? null;
const ORGANIZER = ['owner', 'manager'];
const CLUB_VIEW = ['owner', 'manager', 'reception'];
const PUBLIC_CACHE = { 'cache-control': 'public, max-age=60' };

/** Матч в клубе запроса — для выбора клуба персонала с несколькими клубами (findClub роутера). */
async function matchInClub(db, req) {
  const { rows } = await db.query(
    "select 1 from bl.tournament_matches where id = $1 and club_id = nullif(current_setting('app.club_id', true), '')::uuid",
    [req.params.id],
  );
  return rows.length > 0;
}

export const routes = [
  // --- Публичная афиша (сайт, без входа, кэш 60 с) ------------------------------------------------
  {
    method: 'GET',
    path: '/api/public/tournaments',
    auth: 'none',
    rateLimit: { max: 120, windowMs: 60_000 },
    async handler(ctx, req) {
      return { status: 200, headers: PUBLIC_CACHE, json: await svc().publicList(ctx.db, req.query) };
    },
  },
  {
    method: 'GET',
    path: '/api/public/tournaments/{id}',
    auth: 'none',
    rateLimit: { max: 120, windowMs: 60_000 },
    async handler(ctx, req) {
      return { status: 200, headers: PUBLIC_CACHE, json: await svc().publicDetail(ctx.db, { tournamentId: req.params.id }) };
    },
  },
  // ТВ-экран сетки: SSE tournament:{id}, событие bracket (полная сетка, только ники).
  {
    method: 'GET',
    path: '/api/public/tournaments/{id}/stream',
    auth: 'none',
    rateLimit: { max: 30, windowMs: 60_000 },
    async handler(ctx, req) {
      const bracket = await svc().publicBracket(ctx.db, { tournamentId: req.params.id });
      const tv = tournaments().tv;
      return {
        status: 200,
        stream: async (res) => {
          const out = tv.attach(res, { tournamentId: req.params.id, ip: req.ip, initial: bracket });
          if (!out.ok) {
            const text = JSON.stringify({ error: 'rate_limited' });
            res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
            res.end(text);
          }
        },
      };
    },
  },

  // --- Игрок -----------------------------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/tournaments/{id}/me',
    auth: 'guest',
    async handler(ctx, req) {
      return { status: 200, json: await svc().me(ctx.db, { tournamentId: req.params.id, userId: userId(req) }) };
    },
  },
  {
    method: 'POST',
    path: '/api/tournaments/{id}/entries',
    auth: 'guest',
    requires: ['phone', 'consent'],
    idempotent: true,
    rateLimit: { max: 30, windowMs: 60_000 },
    async handler(ctx, req) {
      const out = await svc().enter(ctx.db, { tournamentId: req.params.id, userId: userId(req), body: req.body, requestKey: ctx.idempotencyKey });
      return { status: 201, json: out };
    },
  },
  {
    method: 'DELETE',
    path: '/api/tournaments/{id}/entries/me',
    auth: 'guest',
    async handler(ctx, req) {
      return { status: 200, json: await svc().withdraw(ctx.db, { tournamentId: req.params.id, userId: userId(req) }) };
    },
  },
  {
    method: 'POST',
    path: '/api/tournaments/matches/{id}/score',
    auth: 'guest',
    rateLimit: { max: 30, windowMs: 60_000 },
    async handler(ctx, req) {
      return { status: 200, json: await svc().report(ctx.db, { matchId: req.params.id, userId: userId(req), body: req.body }) };
    },
  },
  {
    method: 'POST',
    path: '/api/tournaments/matches/{id}/confirm',
    auth: 'guest',
    rateLimit: { max: 30, windowMs: 60_000 },
    async handler(ctx, req) {
      return { status: 200, json: await svc().confirm(ctx.db, { matchId: req.params.id, userId: userId(req) }) };
    },
  },
  // Исправление организатора с причиной (журнал manual.tournament_score).
  {
    method: 'PATCH',
    path: '/api/tournaments/matches/{id}/score',
    auth: 'staff',
    roles: ORGANIZER,
    findClub: matchInClub,
    async handler(ctx, req) {
      return { status: 200, json: await svc().correct(ctx.db, { clubId: ctx.club, staffId: userId(req), matchId: req.params.id, body: req.body }) };
    },
  },

  // --- Клуб ------------------------------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/clubs/{club}/tournaments',
    auth: 'staff',
    roles: CLUB_VIEW,
    async handler(ctx) {
      return { status: 200, json: await svc().listClub(ctx.db, { clubId: ctx.club }) };
    },
  },
  {
    method: 'POST',
    path: '/api/clubs/{club}/tournaments',
    auth: 'staff',
    roles: ORGANIZER,
    async handler(ctx, req) {
      return { status: 201, json: await svc().create(ctx.db, { clubId: ctx.club, staffId: userId(req), body: req.body }) };
    },
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/tournaments/{id}',
    auth: 'staff',
    roles: CLUB_VIEW,
    async handler(ctx, req) {
      return { status: 200, json: await svc().clubDetail(ctx.db, { clubId: ctx.club, tournamentId: req.params.id }) };
    },
  },
  {
    method: 'PATCH',
    path: '/api/clubs/{club}/tournaments/{id}',
    auth: 'staff',
    roles: ORGANIZER,
    async handler(ctx, req) {
      return { status: 200, json: await svc().update(ctx.db, { clubId: ctx.club, staffId: userId(req), tournamentId: req.params.id, body: req.body }) };
    },
  },
  {
    method: 'POST',
    path: '/api/clubs/{club}/tournaments/{id}/start',
    auth: 'staff',
    roles: ORGANIZER,
    async handler(ctx, req) {
      return { status: 200, json: await svc().start(ctx.db, { clubId: ctx.club, staffId: userId(req), tournamentId: req.params.id }) };
    },
  },
  {
    method: 'POST',
    path: '/api/clubs/{club}/tournaments/{id}/cancel',
    auth: 'staff',
    roles: ORGANIZER,
    async handler(ctx, req) {
      return {
        status: 200,
        json: await svc().cancel(ctx.db, { clubId: ctx.club, staffId: userId(req), tournamentId: req.params.id, reason: req.body?.reason }),
      };
    },
  },
];
