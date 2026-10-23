// Реальное время (decisions №50, контракт M1 §7, §14): GET /api/stream?club={club}, ?session={id}
// или ?me=1 (только свой канал user:{id}: waitlist.*, booking.* гостя, №120);
// мини-приложениям — одноразовый токен POST /api/stream/token и GET /api/stream?...&token=.
// Поток Server-Sent Events: события hall, session, reception_request, alarm.
// Канал клуба — персоналу клуба (ресепшн и выше); канал сессии — участнику или персоналу
// клуба сессии. Свой канал user:{id} подключается всегда. Раз в минуту поток перепроверяет
// токен через bl.auth_resolve (отзыв, срок, отзыв терминала у PIN) и роль персонала в клубе
// канала (club: или session: по правам персонала); иначе закрывается.

import { HttpError } from '../../server/http/errors.mjs';
import { hub, TOURNAMENT_EVENTS } from '../../server/http/sse.mjs';
import { streamTarget, streamTokens as defaultTokens } from '../../server/http/stream-tokens.mjs';
import { isUuid, withContext } from '../../server/lib/store.mjs';
import { publicTournamentExists } from '../../server/tournaments/api.mjs';

const CLUB_ROLES = ['owner', 'manager', 'reception'];
/** Бармену (№97) из канала клуба — только события бара: без кассы, денег и зала. */
export const BAR_EVENTS = ['bar', 'stop_list'];

async function stream(ctx, req) {
  const userId = ctx.user.id;
  const channels = [`user:${userId}`];
  const sessionId = req.query.session;
  // ?me=1 — только свой канал user:{id} (гость без сессии: лист ожидания, брони; №120).
  const given = [req.query.club, sessionId, req.query.me].filter((x) => x !== undefined).length;
  if (given !== 1 || (req.query.me !== undefined && req.query.me !== '1')) throw new HttpError(400, 'bad_request');
  let club = null;
  let only = null;
  let barOnly = false;
  let staffClub = null;
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
      // Канал сессии по правам персонала — роль перепроверяется в клубе сессии.
      staffClub = sessionClub;
    }
    channels.push(`session:${sessionId}`);
  }
  const { tokenId, tokenHash: hash } = ctx.principal;
  const pool = ctx.pool;
  // Раз в минуту: токен — тем же bl.auth_resolve, что и при входе (отзыв, срок, отзыв терминала
  // у токена PIN, влитая учётка); роль персонала — в клубе канала (club: или session:).
  const revalidate = async () => {
    const t = await pool.query('select token_id, club_id from bl.auth_resolve($1)', [hash]);
    if (t.rowCount !== 1 || t.rows[0].token_id !== tokenId) return false;
    const roleClub = club ?? staffClub;
    if (!roleClub) return true;
    // Токен PIN действует только в клубе своего терминала.
    if (t.rows[0].club_id && t.rows[0].club_id !== roleClub) return false;
    return withContext(pool, { clubId: roleClub, userId, actorType: 'user' }, async (db) => {
      const r = await db.query('select role from bl.club_members where club_id = $1 and user_id = $2 and active', [roleClub, userId]);
      return r.rows.some((x) => CLUB_ROLES.includes(x.role) || (barOnly && x.role === 'bar'));
    });
  };
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

/**
 * GET /api/public/stream?tournament={id} — публичный поток турнира без входа (M4, ТВ-экран
 * и страница турнира): только канал tournament:{id}, только TOURNAMENT_EVENTS без ПДн;
 * только опубликованный турнир (не черновик) действующего клуба, иначе 404 (M4-7);
 * не больше 10 потоков с одного источника (IPv4 — адрес, IPv6 — сеть /64), анонимные потоки —
 * не больше четверти хаба (server/http/sse.mjs).
 */
async function publicStream(ctx, req) {
  const id = typeof req.query.tournament === 'string' ? req.query.tournament.toLowerCase() : '';
  if (!isUuid(id) || Object.keys(req.query).some((k) => k !== 'tournament')) throw new HttpError(400, 'bad_request');
  if (!(await publicTournamentExists(ctx.db, { tournamentId: id }))) throw new HttpError(404, 'not_found');
  const sse = ctx.sse ?? hub;
  const channel = `tournament:${id}`;
  return {
    status: 200,
    stream: async (res) => {
      const attached = sse.attach(res, { channels: [channel], key: `ip:${req.ip}`, only: { [channel]: [...TOURNAMENT_EVENTS] } });
      if (!attached.ok) {
        const text = JSON.stringify({ error: 'rate_limited' });
        res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
        res.end(text);
      }
    },
  };
}

export const routes = [
  { method: 'GET', path: '/api/public/stream', auth: 'none', stream: true, rateLimit: { max: 60, windowMs: 60_000 }, handler: publicStream },
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
