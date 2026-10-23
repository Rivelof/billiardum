// Бильярдум+ (контракт M4 §4, m4-api.md). Логика — server/plus/service.mjs (backend-plus).
// Ошибки — PlusError и ошибки соседей { status, code } → {"error": code}.

import { plus } from '../../server/plus/index.mjs';

const svc = () => plus().service;
const userId = (req) => req.user?.id ?? null;
const MANAGER_UP = ['owner', 'manager'];

/** Партия в клубе из контекста — выбор клуба управляющего с несколькими клубами (findClub). */
async function matchInClub(db, req) {
  const { rows } = await db.query(
    "select 1 from bl.matches where id = $1 and club_id = nullif(current_setting('app.club_id', true), '')::uuid",
    [req.params.id],
  );
  return rows.length > 0;
}

export const routes = [
  // Профиль ----------------------------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/plus/me',
    auth: 'guest',
    handler: async (ctx, req) => ({ status: 200, json: await svc().me(ctx.db, { userId: userId(req) }) }),
  },
  {
    method: 'PATCH',
    path: '/api/plus/me',
    auth: 'guest',
    requires: ['consent'],
    rateLimit: { max: 30, windowMs: 60_000 },
    handler: async (ctx, req) => ({ status: 200, json: await svc().updateMe(ctx.db, { userId: userId(req), body: req.body }) }),
  },
  {
    method: 'GET',
    path: '/api/plus/players/{nick}',
    auth: 'guest',
    rateLimit: { max: 120, windowMs: 60_000 },
    handler: async (ctx, req) => ({ status: 200, json: await svc().player(ctx.db, { nick: req.params.nick }) }),
  },

  // Партии -----------------------------------------------------------------------------------
  {
    method: 'POST',
    path: '/api/plus/matches',
    auth: 'guest',
    requires: ['consent'],
    rateLimit: { max: 30, windowMs: 60_000 },
    handler: async (ctx, req) => ({ status: 201, json: await svc().createMatch(ctx.db, { userId: userId(req), body: req.body }) }),
  },
  {
    method: 'GET',
    path: '/api/plus/matches',
    auth: 'guest',
    handler: async (ctx, req) => ({ status: 200, json: await svc().listMatches(ctx.db, { userId: userId(req), sessionId: req.query.session_id }) }),
  },
  {
    method: 'POST',
    path: '/api/plus/matches/{id}/confirm',
    auth: 'guest',
    requires: ['consent'],
    // Тело { score_a, score_b } (необязательно) — счёт, который игрок видел: изменился — 409 score_changed.
    handler: async (ctx, req) => ({ status: 200, json: await svc().confirmMatch(ctx.db, { userId: userId(req), matchId: req.params.id, body: req.body }) }),
  },
  {
    method: 'POST',
    path: '/api/plus/matches/{id}/dispute',
    auth: 'guest',
    requires: ['consent'],
    handler: async (ctx, req) => ({
      status: 200,
      json: await svc().disputeMatch(ctx.db, { userId: userId(req), matchId: req.params.id, reason: req.body.reason }),
    }),
  },
  {
    method: 'POST',
    path: '/api/plus/matches/{id}/resolve',
    auth: 'staff',
    roles: MANAGER_UP,
    findClub: matchInClub,
    handler: async (ctx, req) => ({
      status: 200,
      json: await svc().resolveMatch(ctx.db, {
        userId: userId(req), clubId: ctx.club, matchId: req.params.id, result: req.body.result, reason: req.body.reason,
      }),
    }),
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/plus/disputes',
    auth: 'staff',
    roles: MANAGER_UP,
    handler: async (ctx, req) => ({ status: 200, json: await svc().disputes(ctx.db, { clubId: ctx.club, state: req.query.state }) }),
  },

  // Рейтинг ----------------------------------------------------------------------------------
  {
    // Без входа: кэш и лимит частоты — роутер (/api/public/*); me всегда null.
    method: 'GET',
    path: '/api/public/rating',
    auth: 'none',
    handler: async (ctx, req) => ({ status: 200, json: await svc().publicRating(ctx.db, { query: req.query, userId: null }) }),
  },
  {
    // Та же таблица для вошедшего игрока — с его местом (me).
    method: 'GET',
    path: '/api/plus/rating',
    auth: 'guest',
    rateLimit: { max: 120, windowMs: 60_000 },
    handler: async (ctx, req) => ({ status: 200, json: await svc().publicRating(ctx.db, { query: req.query, userId: userId(req) }) }),
  },

  // «Ищу соперника» и «Сыграем?» -------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/plus/lfg',
    auth: 'guest',
    handler: async (ctx, req) => ({ status: 200, json: await svc().getLfg(ctx.db, { userId: userId(req) }) }),
  },
  {
    method: 'POST',
    path: '/api/plus/lfg',
    auth: 'guest',
    requires: ['consent'],
    rateLimit: { max: 30, windowMs: 60_000 },
    handler: async (ctx, req) => ({ status: 200, json: await svc().postLfg(ctx.db, { userId: userId(req), body: req.body }) }),
  },
  {
    method: 'DELETE',
    path: '/api/plus/lfg',
    auth: 'guest',
    handler: async (ctx, req) => ({ status: 200, json: await svc().deleteLfg(ctx.db, { userId: userId(req) }) }),
  },
  {
    method: 'POST',
    path: '/api/plus/invites',
    auth: 'guest',
    requires: ['phone', 'consent'],
    rateLimit: { max: 30, windowMs: 60_000 },
    handler: async (ctx, req) => ({ status: 201, json: await svc().createInvite(ctx.db, { userId: userId(req), body: req.body }) }),
  },
  {
    method: 'GET',
    path: '/api/plus/invites',
    auth: 'guest',
    handler: async (ctx, req) => ({ status: 200, json: await svc().listInvites(ctx.db, { userId: userId(req) }) }),
  },
  {
    method: 'POST',
    path: '/api/plus/invites/{id}/accept',
    auth: 'guest',
    requires: ['consent'],
    handler: async (ctx, req) => ({ status: 200, json: await svc().acceptInvite(ctx.db, { userId: userId(req), inviteId: req.params.id }) }),
  },
  {
    method: 'POST',
    path: '/api/plus/invites/{id}/decline',
    auth: 'guest',
    handler: async (ctx, req) => ({ status: 200, json: await svc().declineInvite(ctx.db, { userId: userId(req), inviteId: req.params.id }) }),
  },

  // Друзья -----------------------------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/plus/friends',
    auth: 'guest',
    handler: async (ctx, req) => ({ status: 200, json: await svc().friends(ctx.db, { userId: userId(req) }) }),
  },
  {
    method: 'POST',
    path: '/api/plus/friends',
    auth: 'guest',
    requires: ['consent'],
    rateLimit: { max: 30, windowMs: 60_000 },
    handler: async (ctx, req) => ({ status: 200, json: await svc().addFriend(ctx.db, { userId: userId(req), nick: req.body.nick }) }),
  },
  {
    method: 'DELETE',
    path: '/api/plus/friends/{user_id}',
    auth: 'guest',
    handler: async (ctx, req) => ({ status: 200, json: await svc().removeFriend(ctx.db, { userId: userId(req), friendId: req.params.user_id }) }),
  },
];
