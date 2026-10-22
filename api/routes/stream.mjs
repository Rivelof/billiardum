// Реальное время (decisions №50, контракт M1 §7, §14): GET /api/stream?club={club} или ?session={id};
// мини-приложениям — одноразовый токен POST /api/stream/token и GET /api/stream?...&token=.
// Поток Server-Sent Events: события hall, session, reception_request, alarm.
// Канал клуба — персоналу клуба (ресепшн и выше); канал сессии — участнику или персоналу
// клуба сессии. Свой канал user:{id} подключается всегда. Раз в минуту поток проверяет,
// что токен не отозван и права на клуб не отняты; иначе закрывается.

import { HttpError } from '../../server/http/errors.mjs';
import { hub } from '../../server/http/sse.mjs';
import { streamTarget, streamTokens as defaultTokens } from '../../server/http/stream-tokens.mjs';
import { isUuid, withContext } from '../../server/lib/store.mjs';

const CLUB_ROLES = ['owner', 'manager', 'reception'];
/** Бармену (№97) из канала клуба — только события бара: без кассы, денег и зала. */
export const BAR_EVENTS = ['bar', 'stop_list'];

async function stream(ctx, req) {
  const userId = ctx.user.id;
  const channels = [`user:${userId}`];
  const sessionId = req.query.session;
  if (req.query.club === undefined && sessionId === undefined) throw new HttpError(400, 'bad_request');
  let club = null;
  let only = null;
  let barOnly = false;
  if (req.query.club !== undefined) {
    if (!ctx.roles.some((r) => CLUB_ROLES.includes(r))) {
      if (!ctx.roles.includes('bar')) throw new HttpError(403, 'forbidden');
      barOnly = true;
    }
    club = ctx.club;
    channels.push(`club:${club}`);
    if (barOnly) only = { [`club:${club}`]: BAR_EVENTS };
  }
  if (sessionId !== undefined) {
    if (!isUuid(sessionId)) throw new HttpError(400, 'bad_request');
    const hasFn = (await ctx.db.query("select to_regprocedure('bl.session_club(uuid)') is not null as ok")).rows[0].ok;
    if (!hasFn) throw new HttpError(404, 'not_found');
    const sessionClub = (await ctx.db.query('select bl.session_club($1) as club_id', [sessionId])).rows[0].club_id;
    if (!sessionClub) throw new HttpError(404, 'not_found');
    if (club && club !== sessionClub) throw new HttpError(403, 'forbidden');
    const mine = await ctx.db.query('select 1 from bl.session_participants where session_id = $1 and user_id = $2', [sessionId, userId]);
    if (mine.rowCount === 0) {
      const roles = await ctx.useClub(sessionClub);
      if (!roles.some((r) => CLUB_ROLES.includes(r))) throw new HttpError(403, 'forbidden');
    }
    channels.push(`session:${sessionId}`);
  }
  const tokenId = ctx.principal.tokenId;
  const pool = ctx.pool;
  const revalidate = () =>
    withContext(pool, { clubId: club, userId, actorType: 'user' }, async (db) => {
      const t = await db.query('select 1 from bl.auth_tokens where id = $1 and revoked_at is null and expires_at > now()', [tokenId]);
      if (t.rowCount === 0) return false;
      if (!club) return true;
      const r = await db.query('select role from bl.club_members where club_id = $1 and user_id = $2 and active', [club, userId]);
      return r.rows.some((x) => CLUB_ROLES.includes(x.role) || (barOnly && x.role === 'bar'));
    });
  const sse = ctx.sse ?? hub;
  return {
    status: 200,
    stream: async (res) => {
      const attached = sse.attach(res, { channels, userId, revalidate, only });
      if (!attached.ok) {
        const text = JSON.stringify({ error: 'rate_limited' });
        res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
        res.end(text);
      }
    },
  };
}

/** POST /api/stream/token {club} | {session} → {token, expires_at}: одноразовый, 60 с (§14). */
async function issueToken(ctx, req) {
  const target = streamTarget(req.body);
  if (!target) throw new HttpError(400, 'bad_request');
  const issued = (ctx.streamTokens ?? defaultTokens).issue(ctx.principal, target);
  if (!issued) throw new HttpError(429, 'rate_limited');
  return { status: 200, json: { token: issued.token, expires_at: issued.expiresAt.toISOString() } };
}

export const routes = [
  {
    method: 'GET',
    path: '/api/stream',
    auth: 'guest',
    rateLimit: { max: 60, windowMs: 60_000 },
    // ?token= — одноразовый токен из POST /api/stream/token для того же канала.
    queryAuth: async (app, token, query) => (app.streamTokens ?? defaultTokens).consume(token, streamTarget(query)),
    handler: stream,
  },
  { method: 'POST', path: '/api/stream/token', auth: 'guest', rateLimit: { max: 60, windowMs: 60_000 }, handler: issueToken },
];
