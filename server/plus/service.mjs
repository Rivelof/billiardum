// Сервис Бильярдум+ (контракт M4 §1 п. 7–10, §3, m4-api.md): профиль, партии и подтверждения,
// рейтинг, таблицы, друзья, «Ищу соперника», «Сыграем?», достижения.
//
// Все функции принимают db — клиента транзакции withContext. Контексты RLS:
//   * личный (app.club_id пуст, app.user_id — игрок): свой профиль, свои партии, друзья, приглашения;
//   * клуб (app.club_id): партии и подтверждения клуба — запись партии, подтверждение, спор,
//     решение управляющего идут в контексте клуба партии (журнал — в цепочку клуба);
//   * чужие профили, таблицы, кандидаты и «друзья в клубе» — только функции bl.plus_* (0850).
// Время — только из clock (параметром в базу), не now() базы.

import { setContext, afterCommit } from '../lib/store.mjs';
import { formatDate, formatTime } from '@billiardum/shared/format';
import {
  DISCIPLINES, DISCIPLINE_OF_TYPE, TYPE_OF_DISCIPLINE, TOURNAMENT_X10,
  isSeason, levelOf, nickValid, scoreValid, seasonOf,
} from './elo.mjs';
import { fail, isClientError } from './errors.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (v) => typeof v === 'string' && UUID.test(v);
export const MIN = 60_000;
/** Окно подтверждения партии и «сессия закрыта не более 30 минут назад» (T22). */
export const CONFIRM_MS = 30 * MIN;
export const SESSION_GRACE_MS = 30 * MIN;
export const INVITES_PER_DAY = 10;
export const FRIEND_REQUESTS_PER_DAY = 20;
export const LFG_MAX_AHEAD_MS = 14 * 24 * 60 * MIN;
const OPEN_SESSION = ['active', 'ending', 'grace'];
const PRIVACY = ['show_history', 'show_achievements', 'show_clubs', 'friends_see_in_club'];
export const ACHIEVEMENT_TEXT = {
  dry: '«Сухая» — победа 8:0 в пирамиде',
  regular: '«Завсегдатай» — 10 игр в одном клубе',
  night_shift: '«Ночная смена» — 5 игр, начатых после полуночи',
  tournament: '«Турнирный» — первый турнир',
  five_clubs: '«Пять клубов» — игры в пяти разных клубах',
};
const DISCIPLINE_WORD = { pyramid: 'пирамида', pool: 'пул', snooker: 'снукер' };

const iso = (v) => (v == null ? null : new Date(v).toISOString());
const ms = (v) => new Date(v).getTime();

function parseTime(v, name) {
  if (typeof v !== 'string' || v.length > 40) fail('bad_request', name);
  const t = Date.parse(v);
  if (!Number.isFinite(t)) fail('bad_request', name);
  return new Date(t);
}

function checkReason(reason, max = 500) {
  if (typeof reason !== 'string' || reason.trim() === '') fail('reason_required');
  const r = reason.trim();
  if (r.length > max) fail('bad_request', 'reason too long');
  return r;
}

/**
 * @param {{ deps: object, log: object, clock: { now(): Date }, config?: object }} options
 */
export function createPlusService({ deps, log, clock }) {
  const now = () => clock.now();

  // Контекст транзакции ----------------------------------------------------------------------

  async function ctxOf(db) {
    const { rows } = await db.query(
      "select nullif(current_setting('app.club_id', true), '') as club_id, nullif(current_setting('app.user_id', true), '') as user_id",
    );
    return rows[0];
  }

  async function enterClub(db, clubId) {
    if (!isUuid(clubId)) fail('not_found', 'club');
    const c = await ctxOf(db);
    if (c.club_id !== clubId) await setContext(db, { clubId });
  }

  /**
   * Личный контекст игрока userId на время fn (свои строки: достижения, участие в сессиях),
   * затем прежний контекст. Ошибка внутри — откат до точки сохранения, контекст восстановлен.
   */
  async function asUser(db, userId, fn) {
    await db.query('savepoint bl_plus_as_user');
    let c = null;
    try {
      c = await ctxOf(db);
      await setContext(db, { clubId: null, userId });
      const out = await fn();
      await db.query('release savepoint bl_plus_as_user');
      return out;
    } catch (err) {
      await db.query('rollback to savepoint bl_plus_as_user');
      throw err;
    } finally {
      // Откат до точки сохранения возвращает и set_config(…, true); восстанавливаем явно.
      if (c) await setContext(db, { clubId: c.club_id, userId: c.user_id });
    }
  }

  function publish(channel, event, data) {
    try {
      deps.sse.publish(channel, event, data);
    } catch (err) {
      log.warn('plus_sse_failed', { error: err.message });
    }
  }

  async function notify(db, userId, msg) {
    if (!userId) return;
    await deps.notify.send(db, userId, msg);
  }

  // Клубы (публичный список bl.public_clubs: имя, город, пояс) — кэш 60 с.
  let clubsCache = null;
  async function clubs(db) {
    const t = Date.now();
    if (clubsCache && t - clubsCache.at < 60_000) return clubsCache.map;
    const { rows } = await db.query('select id, name, city, timezone from bl.public_clubs()');
    const map = new Map(rows.map((r) => [r.id, r]));
    clubsCache = { at: t, map };
    return map;
  }

  function when(date, tz) {
    try {
      return `${formatDate(date, tz)}, ${formatTime(date, tz)}`;
    } catch {
      return iso(date);
    }
  }

  // Игроки ---------------------------------------------------------------------------------

  /** Ник и общий рейтинг по дисциплинам: Map user_id → { nick, ratings }. */
  async function briefs(db, ids) {
    const list = [...new Set(ids.filter(isUuid))];
    if (list.length === 0) return new Map();
    const { rows } = await db.query('select user_id, nick, ratings from bl.plus_briefs($1::uuid[])', [list]);
    return new Map(rows.map((r) => [r.user_id, { nick: r.nick, ratings: r.ratings ?? {} }]));
  }

  function ratingIn(brief, discipline) {
    const r = brief?.ratings?.[discipline];
    return { rating: r?.rating ?? 1200, games: r?.games ?? 0 };
  }

  /** Уровень игрока для списков — по лучшей дисциплине (без партий — по стартовому 1 200). */
  function bestLevel(brief) {
    const played = Object.values(brief?.ratings ?? {}).filter((r) => r.games > 0).map((r) => r.rating);
    return levelOf(played.length ? Math.max(...played) : 1200);
  }

  async function ownPlayer(db, userId) {
    const { rows } = await db.query('select * from bl.players where user_id = $1', [userId]);
    return rows[0] ?? null;
  }

  async function requireProfile(db, userId) {
    const p = await ownPlayer(db, userId);
    if (!p) fail('no_profile', 'own');
    return p;
  }

  async function userByNick(db, nick) {
    if (typeof nick !== 'string' || nick.length < 1 || nick.length > 20) return null;
    const { rows } = await db.query('select bl.plus_user_by_nick($1) as id', [nick]);
    return rows[0].id ?? null;
  }

  // Профиль ----------------------------------------------------------------------------------

  function ratingsView(list) {
    return (list ?? []).map((r) => ({
      discipline: r.discipline,
      rating: r.rating,
      games: r.games,
      level: levelOf(r.rating),
      season_rating: r.season_rating,
    }));
  }

  async function card(db, { userId = null, nick = null }) {
    const { rows } = await db.query('select * from bl.plus_card($1, $2, $3)', [userId, nick, seasonOf(now())]);
    return rows[0] ?? null;
  }

  /** GET /api/plus/me */
  async function me(db, { userId }) {
    if (!isUuid(userId)) fail('unauthorized');
    const c = await card(db, { userId });
    if (c && c.is_self) {
      return {
        nick: c.nick,
        ratings: ratingsView(c.ratings),
        achievements: c.achievements ?? [],
        history: c.history ?? [],
        privacy: c.privacy,
      };
    }
    // Профиля ещё нет: рейтинг (мог появиться в турнире) и достижения — свои строки.
    const season = seasonOf(now());
    const { rows } = await db.query('select discipline, season, rating, games from bl.ratings where user_id = $1', [userId]);
    const ach = await db.query('select code, earned_at from bl.achievements where user_id = $1 order by earned_at, code', [userId]);
    return {
      nick: null,
      ratings: DISCIPLINES.map((d) => {
        const all = rows.find((r) => r.discipline === d && r.season === 'all');
        const s = rows.find((r) => r.discipline === d && r.season === season);
        return { discipline: d, rating: all?.rating ?? 1200, games: all?.games ?? 0, level: levelOf(all?.rating ?? 1200), season_rating: s?.rating ?? 1200 };
      }),
      achievements: ach.rows.map((a) => ({ code: a.code, earned_at: iso(a.earned_at) })),
      history: [],
      privacy: Object.fromEntries(PRIVACY.map((k) => [k, false])),
    };
  }

  /** PATCH /api/plus/me { nick?, privacy? } — создаёт профиль (ник обязателен) или меняет. */
  async function updateMe(db, { userId, body }) {
    if (!isUuid(userId)) fail('unauthorized');
    if (!body || typeof body !== 'object') fail('bad_request');
    for (const k of Object.keys(body)) if (k !== 'nick' && k !== 'privacy') fail('bad_request', k);
    const nick = body.nick;
    if (nick !== undefined && !nickValid(nick)) fail('bad_request', 'nick');
    const privacy = {};
    if (body.privacy !== undefined) {
      if (!body.privacy || typeof body.privacy !== 'object' || Array.isArray(body.privacy)) fail('bad_request', 'privacy');
      for (const [k, v] of Object.entries(body.privacy)) {
        if (!PRIVACY.includes(k) || typeof v !== 'boolean') fail('bad_request', `privacy.${k}`);
        privacy[k] = v;
      }
    }
    const t = now();
    const cur = await ownPlayer(db, userId);
    if (!cur && nick === undefined) fail('bad_request', 'nick required');
    await db.query('savepoint bl_plus_nick');
    try {
      if (!cur) {
        await db.query(
          `insert into bl.players (user_id, nick, show_history, show_achievements, show_clubs, friends_see_in_club, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $7)`,
          [userId, nick, privacy.show_history ?? false, privacy.show_achievements ?? false, privacy.show_clubs ?? false, privacy.friends_see_in_club ?? false, t],
        );
      } else {
        await db.query(
          `update bl.players set nick = coalesce($2, nick),
                  show_history = coalesce($3, show_history), show_achievements = coalesce($4, show_achievements),
                  show_clubs = coalesce($5, show_clubs), friends_see_in_club = coalesce($6, friends_see_in_club),
                  updated_at = $7
            where user_id = $1`,
          [userId, nick ?? null, privacy.show_history ?? null, privacy.show_achievements ?? null, privacy.show_clubs ?? null, privacy.friends_see_in_club ?? null, t],
        );
      }
      await db.query('release savepoint bl_plus_nick');
    } catch (err) {
      await db.query('rollback to savepoint bl_plus_nick');
      if (err.code === '23505') fail('nick_taken');
      if (err.code === '23514') fail('bad_request', 'nick');
      throw err;
    }
    log.info('plus_profile_saved', { user_id: userId, created: !cur });
    return me(db, { userId });
  }

  /** GET /api/plus/players/{nick} — профиль без скрытых игроком полей. */
  async function player(db, { nick }) {
    if (typeof nick !== 'string' || nick.length > 20) fail('not_found');
    const c = await card(db, { nick });
    if (!c) fail('not_found', 'nick');
    const out = { nick: c.nick, ratings: ratingsView(c.ratings) };
    if (c.achievements) out.achievements = c.achievements;
    if (c.history) out.history = c.history;
    return out;
  }

  // Партии -----------------------------------------------------------------------------------

  /** Вид партии (m4-api.md). */
  async function matchViews(db, rows, { extra = null } = {}) {
    if (rows.length === 0) return [];
    const ids = rows.map((m) => m.id);
    const conf = await db.query('select match_id, user_id, decision from bl.match_confirmations where match_id = any ($1::uuid[])', [ids]);
    const hist = await db.query("select match_id, user_id, delta, revision from bl.rating_history where match_id = any ($1::uuid[]) and kind = 'match'", [ids]);
    const b = await briefs(db, rows.flatMap((m) => [m.player_a, m.player_b]));
    const t = ms(now());
    return rows.map((m) => {
      const confirmed = (uid) => conf.rows.some((c) => c.match_id === m.id && c.user_id === uid && c.decision === 'confirm');
      const deltas = hist.rows.filter((h) => h.match_id === m.id && h.revision === (m.revision ?? 0));
      let status;
      let counted = null;
      let reason = null;
      if (m.status === 'pending') {
        if (ms(m.confirm_until) < t) {
          status = 'expired';
          counted = false;
          reason = 'confirm_timeout';
        } else status = 'pending';
      } else if (m.status === 'disputed') status = 'disputed';
      else if (m.status === 'confirmed') status = m.resolution ? 'resolved' : 'confirmed';
      else if (m.status === 'counted') {
        status = m.resolution ? 'resolved' : 'confirmed';
        counted = true;
      } else {
        counted = false;
        reason = m.reject_reason;
        status = m.reject_reason === 'confirm_timeout' ? 'expired' : m.resolution ? 'resolved' : 'confirmed';
      }
      const view = {
        id: m.id,
        session_id: m.session_id,
        discipline: m.discipline,
        players: [
          { user_id: m.player_a, nick: b.get(m.player_a)?.nick ?? null, score: m.score_a, confirmed: confirmed(m.player_a) },
          { user_id: m.player_b, nick: b.get(m.player_b)?.nick ?? null, score: m.score_b, confirmed: confirmed(m.player_b) },
        ],
        status,
        counted,
        not_counted_reason: reason,
        confirm_until: iso(m.confirm_until),
        rating_delta: deltas.length ? Object.fromEntries(deltas.map((h) => [h.user_id, h.delta])) : null,
        tournament: m.source === 'tournament',
        played_at: iso(m.played_at),
      };
      return extra ? { ...view, ...extra(m) } : view;
    });
  }

  async function matchView(db, m) {
    return (await matchViews(db, [m]))[0];
  }

  async function loadMatch(db, id, { lock = false } = {}) {
    const { rows } = await db.query(`select * from bl.matches where id = $1${lock ? ' for update' : ''}`, [id]);
    return rows[0] ?? null;
  }

  /** Партия игрока: найти в личном контексте, перейти в клуб партии, заблокировать строку. */
  async function playerMatch(db, { matchId, userId, lock = true }) {
    if (!isUuid(matchId)) fail('not_found');
    const { rows } = await db.query('select club_id from bl.matches where id = $1 and (player_a = $2 or player_b = $2)', [matchId, userId]);
    if (!rows[0]) fail('not_found', 'match');
    await enterClub(db, rows[0].club_id);
    const m = await loadMatch(db, matchId, { lock });
    if (!m || (m.player_a !== userId && m.player_b !== userId)) fail('not_found', 'match');
    return m;
  }

  function sessionFresh(s, t) {
    if (OPEN_SESSION.includes(s.status)) return true;
    const ended = s.ended_at ?? s.closed_at ?? null;
    return s.status === 'closed' && ended != null && t - ms(ended) <= SESSION_GRACE_MS;
  }

  async function participantIds(db, sessionId) {
    const list = await deps.light.sessionParticipants(db, { sessionId });
    return new Set((list ?? []).map((p) => p.user_id));
  }

  /** POST /api/plus/matches { session_id, discipline, opponent_id, my_score, opponent_score } */
  async function createMatch(db, { userId, body }) {
    if (!isUuid(userId)) fail('unauthorized');
    const { session_id: sessionId, discipline, opponent_id: opponentId, my_score: myScore, opponent_score: oppScore } = body ?? {};
    if (!isUuid(sessionId)) fail('bad_request', 'session_id');
    if (!DISCIPLINES.includes(discipline)) fail('bad_request', 'discipline');
    if (!isUuid(opponentId) || opponentId === userId) fail('bad_request', 'opponent_id');
    if (!scoreValid(discipline, myScore, oppScore)) fail('bad_request', 'score');
    const t = now();
    const s = await deps.light.sessionOf(db, { sessionId });
    if (!s) fail('not_found', 'session');
    await enterClub(db, s.club_id);
    const players = await participantIds(db, sessionId);
    if (!players.has(userId)) fail('not_found', 'session');
    if (s.source === 'tournament') fail('tournament_session');
    if (!sessionFresh(s, ms(t))) fail('session_not_active');
    const { rows: res } = await db.query('select type from bl.resources where id = $1', [s.resource_id]);
    const tableDiscipline = DISCIPLINE_OF_TYPE[res[0]?.type];
    if (tableDiscipline && tableDiscipline !== discipline) fail('bad_request', 'discipline of table');
    const b = await briefs(db, [userId, opponentId]);
    if (!b.get(userId)?.nick) fail('no_profile', 'own');
    if (!b.get(opponentId)?.nick) fail('no_profile', 'opponent');
    // Одна неподтверждённая партия пары в сессии: повторное нажатие не плодит записи.
    await db.query("select pg_advisory_xact_lock(hashtextextended('bl.plus.session_pair:' || $1 || ':' || $2, 0))", [
      sessionId,
      [userId, opponentId].sort().join(':'),
    ]);
    const dup = await db.query(
      `select 1 from bl.matches where session_id = $1 and status = 'pending' and confirm_until >= $3
          and least(player_a, player_b) = least($2::uuid, $4::uuid) and greatest(player_a, player_b) = greatest($2::uuid, $4::uuid)`,
      [sessionId, userId, t, opponentId],
    );
    if (dup.rows.length) fail('duplicate', 'pending match of pair');
    const sameSession = players.has(opponentId);
    const { rows } = await db.query(
      `insert into bl.matches (club_id, source, session_id, resource_id, discipline, player_a, player_b, score_a, score_b,
                               status, reject_reason, played_at, confirm_until, created_by, created_at, updated_at)
       values ($1, 'session', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $5, $11, $11)
       returning *`,
      [s.club_id, sessionId, s.resource_id, discipline, userId, opponentId, myScore, oppScore,
        sameSession ? 'pending' : 'rejected', sameSession ? null : 'not_same_session', t, new Date(ms(t) + CONFIRM_MS)],
    );
    const m = rows[0];
    await db.query(
      "insert into bl.match_confirmations (match_id, club_id, user_id, decision, created_at) values ($1, $2, $3, 'confirm', $4)",
      [m.id, m.club_id, userId, t],
    );
    log.info('plus_match_created', { match_id: m.id, club_id: m.club_id, session_id: sessionId, same_session: sameSession });
    if (sameSession) {
      const tn = s.resource_number ? `, стол ${s.resource_number}` : '';
      await notify(db, opponentId, {
        kind: 'plus.match_confirm',
        text: `Подтвердите партию${tn}: ${b.get(userId).nick} — ${myScore}, вы — ${oppScore}. На подтверждение 30 минут.`,
        data: { match_id: m.id },
        actions: [{ id: 'open', title: 'Подтвердить', url: `/app/plus/matches/${m.id}` }],
      });
      await afterCommit(db, () => publish(`user:${opponentId}`, 'plus_match', { match_id: m.id }));
    }
    return matchView(db, m);
  }

  /** Обе подтвердили: проверка сессии, лимит пары и Эло (bl.plus_settle_match). */
  async function finalize(db, m) {
    const t = now();
    await db.query("update bl.matches set status = 'confirmed', updated_at = $2 where id = $1", [m.id, t]);
    if (m.source === 'session' && !m.resolution) {
      const players = await participantIds(db, m.session_id);
      if (!players.has(m.player_a) || !players.has(m.player_b)) {
        await db.query("update bl.matches set status = 'rejected', reject_reason = 'not_same_session', updated_at = $2 where id = $1", [m.id, t]);
        return loadMatch(db, m.id);
      }
    }
    return settle(db, m.id);
  }

  /** Итог партии и Эло — один раз (bl.plus_settle_match), затем уведомления и достижения. */
  async function settle(db, matchId) {
    const t = now();
    const { rows } = await db.query('select status, reject_reason, applied from bl.plus_settle_match($1, $2)', [matchId, t]);
    const r = rows[0] ?? null;
    const m = await loadMatch(db, matchId);
    if (r?.applied) await afterCounted(db, m);
    else if (r?.status === 'rejected' && r.reject_reason === 'pair_daily_limit') {
      log.info('plus_match_rejected', { match_id: m.id, reason: 'pair_daily_limit' });
      for (const uid of [m.player_a, m.player_b]) {
        await notify(db, uid, {
          kind: 'plus.match_not_counted',
          text: 'Партия записана, но в рейтинг не засчитана: это 4-я партия пары за сутки.',
          data: { match_id: m.id },
        });
      }
    }
    return m;
  }

  async function afterCounted(db, m, { corrected = false } = {}) {
    const { rows } = await db.query(
      "select user_id, delta, rating_after from bl.rating_history where match_id = $1 and revision = $2 and kind = 'match'",
      [m.id, m.revision ?? 0],
    );
    const deltas = Object.fromEntries(rows.map((h) => [h.user_id, h.delta]));
    await deps.audit.appendAudit(db, {
      action: 'plus.match_counted',
      objectType: 'match',
      objectId: m.id,
      data: { match_id: m.id, discipline: m.discipline, source: m.source, revision: m.revision ?? 0, score_a: m.score_a, score_b: m.score_b, multiplier_x10: m.multiplier_x10, ...(rows.length === 2 ? { delta_a: deltas[m.player_a], delta_b: deltas[m.player_b] } : {}) },
    });
    await deps.outbox.enqueue(db, 'plus.match_counted', { match_id: m.id, club_id: m.club_id, discipline: m.discipline, source: m.source, revision: m.revision ?? 0, corrected, player_ids: [m.player_a, m.player_b], winner_id: m.winner_id, deltas });
    log.info('plus_match_counted', { match_id: m.id, club_id: m.club_id, source: m.source });
    for (const h of rows) {
      const d = h.delta > 0 ? `+${h.delta}` : `${h.delta}`;
      await notify(db, h.user_id, {
        kind: 'plus.rating',
        text: corrected
          ? `Организатор исправил счёт матча (${m.score_a}:${m.score_b}): рейтинг пересчитан, за матч ${d}, теперь ${h.rating_after}.`
          : `Партия засчитана: рейтинг ${d}, теперь ${h.rating_after} (${DISCIPLINE_WORD[m.discipline]}).`,
        data: { match_id: m.id, delta: h.delta, rating: h.rating_after },
      });
      await afterCommit(db, () => publish(`user:${h.user_id}`, 'plus_match', { match_id: m.id }));
    }
    for (const uid of [m.player_a, m.player_b]) await checkAchievementsSafe(db, uid);
  }

  /** POST /api/plus/matches/{id}/confirm — второй игрок подтверждает; повтор безопасен. */
  async function confirmMatch(db, { userId, matchId }) {
    let m = await playerMatch(db, { matchId, userId });
    const t = now();
    const { rows: mine } = await db.query('select decision from bl.match_confirmations where match_id = $1 and user_id = $2', [m.id, userId]);
    if (mine[0]?.decision === 'confirm') return matchView(db, m);
    if (mine[0]) fail('match_not_pending', 'disputed by me');
    if (m.status !== 'pending') fail('match_not_pending', m.status);
    if (ms(m.confirm_until) < ms(t)) {
      await expire(db, m);
      return matchView(db, await loadMatch(db, m.id));
    }
    await db.query(
      "insert into bl.match_confirmations (match_id, club_id, user_id, decision, created_at) values ($1, $2, $3, 'confirm', $4)",
      [m.id, m.club_id, userId, t],
    );
    const { rows } = await db.query("select count(*)::int as n from bl.match_confirmations where match_id = $1 and decision = 'confirm'", [m.id]);
    if (rows[0].n >= 2) m = await finalize(db, m);
    return matchView(db, m);
  }

  async function expire(db, m) {
    const r = await db.query(
      "update bl.matches set status = 'rejected', reject_reason = 'confirm_timeout', updated_at = $2 where id = $1 and status = 'pending' returning id",
      [m.id, now()],
    );
    if (r.rowCount) {
      log.info('plus_match_rejected', { match_id: m.id, reason: 'confirm_timeout' });
      await notify(db, m.created_by ?? m.player_a, {
        kind: 'plus.match_not_counted',
        text: 'Партия не засчитана: соперник не подтвердил результат за 30 минут.',
        data: { match_id: m.id },
      });
    }
  }

  /** POST /api/plus/matches/{id}/dispute { reason } — спор → управляющему клуба. */
  async function disputeMatch(db, { userId, matchId, reason }) {
    const why = checkReason(reason, 500);
    const m = await playerMatch(db, { matchId, userId });
    const t = now();
    const { rows: mine } = await db.query('select decision from bl.match_confirmations where match_id = $1 and user_id = $2', [m.id, userId]);
    if (m.status === 'disputed' && mine[0]?.decision === 'dispute') return matchView(db, m);
    if (m.status !== 'pending' || mine[0]) fail('match_not_pending', m.status);
    if (ms(m.confirm_until) < ms(t)) {
      await expire(db, m);
      return matchView(db, await loadMatch(db, m.id));
    }
    await db.query(
      "insert into bl.match_confirmations (match_id, club_id, user_id, decision, reason, created_at) values ($1, $2, $3, 'dispute', $4, $5)",
      [m.id, m.club_id, userId, why, t],
    );
    const { rows } = await db.query(
      "update bl.matches set status = 'disputed', dispute_by = $2, dispute_reason = $3, disputed_at = $4, updated_at = $4 where id = $1 returning *",
      [m.id, userId, why, t],
    );
    await deps.audit.appendAudit(db, {
      action: 'plus.match_dispute',
      objectType: 'match',
      objectId: m.id,
      reason: why,
      data: { match_id: m.id, resource_id: m.resource_id, score_a: m.score_a, score_b: m.score_b },
    });
    const { rows: tbl } = await db.query('select number from bl.resources where id = $1', [m.resource_id]);
    const table = tbl[0]?.number ? ` на столе ${tbl[0].number}` : '';
    await deps.notify.sendToClubStaff(db, m.club_id, ['owner', 'manager'], {
      kind: 'plus.dispute',
      level: 'important',
      text: `Спор по партии${table}: игроки не согласны со счётом. Решите в программе клуба.`,
      data: { match_id: m.id },
      actions: [{ id: 'open', title: 'Споры', url: '/club/plus/disputes' }],
    });
    const other = m.player_a === userId ? m.player_b : m.player_a;
    await notify(db, other, { kind: 'plus.match_disputed', text: 'Соперник не согласен со счётом партии — решит управляющий клуба.', data: { match_id: m.id } });
    log.info('plus_match_disputed', { match_id: m.id, club_id: m.club_id });
    return matchView(db, rows[0]);
  }

  /** POST /api/plus/matches/{id}/resolve { result: a|b|annul, reason } — управляющий клуба партии. */
  async function resolveMatch(db, { userId, clubId, matchId, result, reason }) {
    const why = checkReason(reason, 2000);
    if (!['a', 'b', 'annul'].includes(result)) fail('bad_request', 'result');
    if (!isUuid(matchId)) fail('not_found');
    await enterClub(db, clubId);
    const m = await loadMatch(db, matchId, { lock: true });
    if (!m || m.club_id !== clubId) fail('not_found', 'match');
    if (m.status !== 'disputed') fail('match_not_disputed', m.status);
    const t = now();
    let next;
    if (result === 'annul') {
      const { rows } = await db.query(
        `update bl.matches set status = 'rejected', reject_reason = 'annulled', resolution = 'annul', resolved_by = $2,
                resolved_reason = $3, resolved_at = $4, updated_at = $4 where id = $1 returning *`,
        [m.id, userId, why, t],
      );
      next = rows[0];
    } else {
      // Победитель по решению: счёт тот же, если совпадает, иначе стороны счёта меняются местами.
      const aWins = m.score_a > m.score_b;
      const swap = (result === 'a') !== aWins;
      const { rows } = await db.query(
        `update bl.matches set status = 'confirmed', score_a = $5, score_b = $6, resolution = $7, resolved_by = $2,
                resolved_reason = $3, resolved_at = $4, updated_at = $4 where id = $1 returning *`,
        [m.id, userId, why, t, swap ? m.score_b : m.score_a, swap ? m.score_a : m.score_b, result],
      );
      next = rows[0];
    }
    await deps.audit.appendAudit(db, {
      action: 'plus.match_resolve',
      objectType: 'match',
      objectId: m.id,
      reason: why,
      data: { match_id: m.id, result, score_a: next.score_a, score_b: next.score_b, resource_id: m.resource_id },
    });
    if (result !== 'annul') next = await settle(db, m.id);
    const text = result === 'annul'
      ? 'Управляющий клуба отменил результат спорной партии — в рейтинг она не засчитана.'
      : `Управляющий клуба решил спор по партии: счёт ${next.score_a}:${next.score_b}.`;
    for (const uid of [m.player_a, m.player_b]) await notify(db, uid, { kind: 'plus.match_resolved', text, data: { match_id: m.id } });
    log.info('plus_match_resolved', { match_id: m.id, club_id: clubId, result });
    return matchView(db, next);
  }

  /** GET /api/plus/matches?session_id= — партии сессии (участнику); без сессии — свои последние. */
  async function listMatches(db, { userId, sessionId }) {
    if (!isUuid(userId)) fail('unauthorized');
    if (sessionId !== undefined) {
      if (!isUuid(sessionId)) fail('bad_request', 'session_id');
      const s = await deps.light.sessionOf(db, { sessionId });
      if (!s) fail('not_found', 'session');
      await enterClub(db, s.club_id);
      const players = await participantIds(db, sessionId);
      if (!players.has(userId)) fail('not_found', 'session');
      const { rows } = await db.query('select * from bl.matches where session_id = $1 order by played_at, id', [sessionId]);
      return { items: await matchViews(db, rows) };
    }
    const { rows } = await db.query(
      `select * from bl.matches where player_a = $1 or player_b = $1
        order by (status in ('pending', 'disputed')) desc, played_at desc limit 30`,
      [userId],
    );
    return { items: await matchViews(db, rows) };
  }

  /** GET /api/clubs/{club}/plus/disputes — споры клуба (управляющий). ?state=all — и решённые. */
  async function disputes(db, { clubId, state }) {
    await enterClub(db, clubId);
    const all = state === 'all';
    const { rows } = await db.query(
      `select m.*, r.number as table_number from bl.matches m left join bl.resources r on r.id = m.resource_id
        where m.club_id = $1 and ${all ? 'm.dispute_by is not null' : "m.status = 'disputed'"}
        order by m.disputed_at desc limit 100`,
      [clubId],
    );
    return { items: await matchViews(db, rows, { extra: (m) => ({ dispute_reason: m.dispute_reason, table_number: m.table_number, disputed_at: iso(m.disputed_at) }) }) };
  }

  /** Планировщик: партии без подтверждения за 30 минут → rejected (confirm_timeout). */
  async function expireDue(db, matchId) {
    const m = await loadMatch(db, matchId, { lock: true });
    if (!m || m.status !== 'pending' || ms(m.confirm_until) >= ms(now())) return false;
    await expire(db, m);
    return true;
  }

  // Рейтинг для соседей ---------------------------------------------------------------------

  /** ratingOf(db, { userId, discipline }) → { rating, games, level } (контракт §3). */
  async function ratingOf(db, { userId, discipline }) {
    if (!isUuid(userId) || !DISCIPLINES.includes(discipline)) fail('bad_request', 'ratingOf');
    const r = ratingIn((await briefs(db, [userId])).get(userId), discipline);
    return { rating: r.rating, games: r.games, level: levelOf(r.rating) };
  }

  /** nicksOf(db, { userIds }) → { [user_id]: nick | null } (light: участники сессии). */
  async function nicksOf(db, { userIds }) {
    const ids = (userIds ?? []).filter(isUuid);
    const b = await briefs(db, ids);
    return Object.fromEntries(ids.map((id) => [id, b.get(id)?.nick ?? null]));
  }

  /** playerCard(db, { userId, viewerId }) — зритель — пользователь контекста (приватность в базе). */
  async function playerCard(db, { userId }) {
    if (!isUuid(userId)) return null;
    const c = await card(db, { userId });
    if (!c) return null;
    const out = { user_id: c.user_id, nick: c.nick, ratings: ratingsView(c.ratings) };
    if (c.achievements) out.achievements = c.achievements;
    if (c.history) out.history = c.history;
    return out;
  }

  /** applyMatch(db, { matchId }) — засчитать подтверждённую партию и пересчитать Эло (идемпотентно). */
  async function applyMatch(db, { matchId }) {
    if (!isUuid(matchId)) fail('bad_request', 'matchId');
    const m = await settle(db, matchId);
    return m ? { status: m.status, reject_reason: m.reject_reason } : null;
  }

  // Турниры ----------------------------------------------------------------------------------

  function scorePair(payload, aId) {
    const s = payload.score;
    if (Number.isInteger(payload.score_a) && Number.isInteger(payload.score_b)) return [payload.score_a, payload.score_b];
    if (s && typeof s === 'object') {
      if (Number.isInteger(s.a) && Number.isInteger(s.b)) return [s.a, s.b];
      if (Number.isInteger(s.winner) && Number.isInteger(s.loser)) return payload.winner_id === aId ? [s.winner, s.loser] : [s.loser, s.winner];
    }
    if (typeof s === 'string' && /^\d{1,2}:\d{1,2}$/.test(s)) return s.split(':').map(Number);
    return null;
  }

  /**
   * outbox tournament.match_finished { match_id, tournament_id, winner_id, score, … } → партия
   * турнира (×1,5) и рейтинг. Игроки и дисциплина — из tournaments.matchForRating или из события
   * (player_ids | loser_id, discipline). Повтор события ничего не меняет.
   */
  async function onTournamentMatchFinished(db, payload) {
    if (!payload || !isUuid(payload.match_id)) return;
    let info = null;
    if (typeof deps.tournaments?.matchForRating === 'function') {
      // Необязательный вызов соседа — в точке сохранения: его ошибка не обрывает транзакцию.
      await db.query('savepoint bl_plus_tournament_match');
      try {
        info = await deps.tournaments.matchForRating(db, { matchId: payload.match_id });
        await db.query('release savepoint bl_plus_tournament_match');
      } catch (err) {
        await db.query('rollback to savepoint bl_plus_tournament_match');
        log.warn('plus_tournament_lookup_failed', { match_id: payload.match_id, error: err.code ?? err.message });
      }
    }
    const clubId = info?.club_id ?? payload.club_id ?? (await ctxOf(db)).club_id;
    let a = info?.player_a ?? payload.player_ids?.[0] ?? payload.winner_id;
    let b = info?.player_b ?? payload.player_ids?.[1] ?? payload.loser_id;
    if (a === b && isUuid(payload.loser_id)) b = payload.loser_id;
    if (b === payload.winner_id && a !== payload.winner_id && !info && !payload.player_ids) [a, b] = [b, a];
    const discipline = info?.discipline ?? payload.discipline;
    let scores = info && Number.isInteger(info.score_a) ? [info.score_a, info.score_b] : scorePair(payload, a);
    if (!isUuid(clubId) || !isUuid(a) || !isUuid(b) || a === b || !DISCIPLINES.includes(discipline) || !isUuid(payload.tournament_id ?? info?.tournament_id)) {
      log.warn('plus_tournament_match_skipped', { match_id: payload.match_id, reason: 'payload' });
      return;
    }
    const winner = payload.winner_id ?? info?.winner_id;
    if (!scores || scores[0] === scores[1] || scores.some((x) => !Number.isInteger(x) || x < 0 || x > 99)) scores = winner === b ? [0, 1] : [1, 0];
    // Счёт должен совпадать с победителем из события.
    if (winner === a && scores[0] < scores[1]) scores = [scores[1], scores[0]];
    if (winner === b && scores[1] < scores[0]) scores = [scores[1], scores[0]];
    await enterClub(db, clubId);
    const t = now();
    const playedAt = info?.finished_at ?? payload.finished_at ?? t;
    // Исправление счёта организатором (№146): та же партия с revision > 0.
    const revision = Number.isSafeInteger(payload.revision) && payload.revision > 0 ? payload.revision : 0;
    const ins = await db.query(
      `insert into bl.matches (club_id, source, tournament_id, tournament_match_id, resource_id, discipline, player_a, player_b,
                               score_a, score_b, status, multiplier_x10, played_at, revision, created_at, updated_at)
       values ($1, 'tournament', $2, $3, $4, $5, $6, $7, $8, $9, 'confirmed', $10, $11, $12, $13, $13)
       on conflict (tournament_match_id) do nothing returning id`,
      [clubId, payload.tournament_id ?? info.tournament_id, payload.match_id, isUuid(info?.resource_id) ? info.resource_id : null, discipline, a, b, scores[0], scores[1], TOURNAMENT_X10, new Date(playedAt), revision, t],
    );
    if (ins.rows[0]) {
      await settle(db, ins.rows[0].id);
      return;
    }
    const { rows: ex } = await db.query('select * from bl.matches where tournament_match_id = $1', [payload.match_id]);
    const m = ex[0];
    if (!m) return;
    if (revision <= m.revision) {
      // Повтор или старая ревизия: ничего не меняем (досчитываем, если партия ещё не засчитана).
      await settle(db, m.id);
      return;
    }
    // Счёт — в сторонах сохранённой партии (a, b), победитель — из события.
    let [sa, sb] = m.player_a === a ? scores : [scores[1], scores[0]];
    if (winner === m.player_a && sa < sb) [sa, sb] = [sb, sa];
    if (winner === m.player_b && sb < sa) [sa, sb] = [sb, sa];
    const { rows: res } = await db.query('select status, reject_reason, applied from bl.plus_correct_match($1, $2, $3, $4, $5)', [m.id, revision, sa, sb, t]);
    if (!res[0]?.applied) return;
    const next = await loadMatch(db, m.id);
    const { rows: rev } = await db.query(
      "select user_id, delta from bl.rating_history where match_id = $1 and revision = $2 and kind = 'reversal'",
      [m.id, revision],
    );
    await deps.audit.appendAudit(db, {
      action: 'plus.match_corrected',
      objectType: 'match',
      objectId: m.id,
      data: {
        match_id: m.id, tournament_match_id: payload.match_id, revision, score_a: sa, score_b: sb,
        previous_score_a: m.score_a, previous_score_b: m.score_b, reverted: rev.length,
      },
    });
    log.info('plus_match_corrected', { match_id: m.id, revision });
    await afterCounted(db, next, { corrected: true });
  }

  // Достижения ------------------------------------------------------------------------------

  /** Проверка достижений игрока по данным (PRODUCT §13); каждое — один раз, с уведомлением. */
  async function checkAchievements(db, userId) {
    return asUser(db, userId, async () => {
      const { rows } = await db.query(
        `with own as (
           select s.id, s.club_id, s.started_at from bl.sessions s
            where s.status = 'closed' and exists (select 1 from bl.session_participants p where p.session_id = s.id and p.user_id = $1)
         ), tz as (select id, timezone from bl.public_clubs())
         select
           exists (select 1 from bl.matches m where m.status = 'counted' and m.source = 'session' and m.discipline = 'pyramid'
                     and m.winner_id = $1 and greatest(m.score_a, m.score_b) = 8 and least(m.score_a, m.score_b) = 0) as dry,
           exists (select 1 from bl.matches m where m.status = 'counted' and m.source = 'tournament' and $1 in (m.player_a, m.player_b)) as tournament,
           coalesce((select max(n) from (select count(*) as n from own group by club_id) x), 0) >= 10 as regular,
           (select count(distinct club_id) from own) >= 5 as five_clubs,
           (select count(*) from own o join tz on tz.id = o.club_id
             where extract(hour from o.started_at at time zone tz.timezone) < 6) >= 5 as night_shift`,
        [userId],
      );
      const got = Object.entries(rows[0]).filter(([, v]) => v).map(([k]) => k);
      if (got.length === 0) return [];
      const t = now();
      const ins = await db.query(
        `insert into bl.achievements (user_id, code, earned_at)
         select $1, c, $3 from unnest($2::text[]) as c
         on conflict (user_id, code) do nothing returning code`,
        [userId, got, t],
      );
      for (const r of ins.rows) {
        await notify(db, userId, { kind: 'plus.achievement', text: `Новое достижение: ${ACHIEVEMENT_TEXT[r.code] ?? r.code}.`, data: { code: r.code } });
      }
      if (ins.rows.length) log.info('plus_achievements', { user_id: userId, codes: ins.rows.map((r) => r.code) });
      return ins.rows.map((r) => r.code);
    });
  }

  async function checkAchievementsSafe(db, userId) {
    try {
      return await checkAchievements(db, userId);
    } catch (err) {
      log.warn('plus_achievements_failed', { user_id: userId, error: err.code ?? err.message });
      return [];
    }
  }

  /** outbox session.closed → достижения участников. */
  async function onSessionClosed(db, payload) {
    if (!payload || !isUuid(payload.session_id)) return;
    const { rows } = await db.query('select user_id from bl.session_participants where session_id = $1', [payload.session_id]);
    for (const r of rows) await checkAchievementsSafe(db, r.user_id);
  }

  // Публичный рейтинг -----------------------------------------------------------------------

  async function cityClubIds(db, city) {
    const ids = new Set();
    await db.query('savepoint bl_plus_city');
    try {
      const { rows } = await db.query(
        `select cp.club_id from bl.club_public cp join bl.cities ci on ci.id = cp.city_id
          where ci.slug = $1 and cp.club_id is not null`,
        [city],
      );
      for (const r of rows) ids.add(r.club_id);
      await db.query('release savepoint bl_plus_city');
    } catch {
      await db.query('rollback to savepoint bl_plus_city');
    }
    for (const c of (await clubs(db)).values()) if (c.city && c.city.toLowerCase() === city.toLowerCase()) ids.add(c.id);
    return [...ids];
  }

  /**
   * GET /api/public/rating (без входа, кэш роутера 60 с, me = null) и GET /api/plus/rating (игрок, с me):
   * ?discipline&scope=club|city|country&club&city&season=YYYY-MM|all&limit&offset
   */
  async function publicRating(db, { query = {}, userId = null }) {
    const discipline = query.discipline ?? 'pyramid';
    if (!DISCIPLINES.includes(discipline)) fail('bad_request', 'discipline');
    const scope = query.scope ?? (query.club ? 'club' : query.city ? 'city' : 'country');
    if (!['club', 'city', 'country'].includes(scope)) fail('bad_request', 'scope');
    const season = query.season ?? 'all';
    if (!isSeason(season)) fail('bad_request', 'season');
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    const offset = query.offset === undefined ? 0 : Number(query.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('bad_request', 'limit');
    if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) fail('bad_request', 'offset');
    let clubIds = null;
    if (scope === 'club') {
      if (!isUuid(query.club)) fail('bad_request', 'club');
      clubIds = [query.club];
    } else if (scope === 'city') {
      if (typeof query.city !== 'string' || query.city.length < 1 || query.city.length > 100) fail('bad_request', 'city');
      clubIds = await cityClubIds(db, query.city);
    }
    let rows = [];
    if (!clubIds || clubIds.length) {
      ({ rows } = await db.query('select place, user_id, nick, rating, games from bl.plus_rating_table($1, $2, $3::uuid[], $4, $5)', [
        discipline, season, clubIds, limit, offset,
      ]));
    }
    const items = rows
      .filter((r) => Number(r.place) > offset && Number(r.place) <= offset + limit)
      .map((r) => ({ place: Number(r.place), nick: r.nick, level: levelOf(r.rating), rating: r.rating, games: r.games }));
    const mine = userId ? rows.find((r) => r.user_id === userId) : null;
    return { items, me: mine ? { place: Number(mine.place), rating: mine.rating } : null };
  }

  // Друзья -------------------------------------------------------------------------------------

  /** GET /api/plus/friends */
  async function friends(db, { userId }) {
    if (!isUuid(userId)) fail('unauthorized');
    const { rows: fr } = await db.query('select friend_id from bl.friendships where user_id = $1 order by created_at', [userId]);
    const { rows: req } = await db.query(
      "select from_user, to_user from bl.friend_requests where status = 'pending' and (from_user = $1 or to_user = $1) order by created_at",
      [userId],
    );
    const { rows: here } = await db.query('select friend_id, club_name, since from bl.plus_friends_in_club()');
    const b = await briefs(db, [...fr.map((r) => r.friend_id), ...req.flatMap((r) => [r.from_user, r.to_user])]);
    const inClub = new Map(here.map((r) => [r.friend_id, { club_name: r.club_name, since: iso(r.since) }]));
    return {
      friends: fr.map((r) => ({ user_id: r.friend_id, nick: b.get(r.friend_id)?.nick ?? null, level: bestLevel(b.get(r.friend_id)), in_club_now: inClub.get(r.friend_id) ?? null })),
      incoming: req.filter((r) => r.to_user === userId).map((r) => ({ user_id: r.from_user, nick: b.get(r.from_user)?.nick ?? null })),
      outgoing: req.filter((r) => r.from_user === userId).map((r) => ({ user_id: r.to_user, nick: b.get(r.to_user)?.nick ?? null })),
    };
  }

  /** POST /api/plus/friends { nick } — заявка; встречная заявка — сразу дружба. */
  async function addFriend(db, { userId, nick }) {
    const me = await requireProfile(db, userId);
    const target = await userByNick(db, nick);
    if (!target) fail('not_found', 'nick');
    if (target === userId) fail('bad_request', 'self');
    const t = now();
    await db.query("select pg_advisory_xact_lock(hashtextextended('bl.plus.friend:' || $1, 0))", [[userId, target].sort().join(':')]);
    const { rows: already } = await db.query('select 1 from bl.friendships where user_id = $1 and friend_id = $2', [userId, target]);
    if (already.length) return friends(db, { userId });
    const { rows: incoming } = await db.query(
      "update bl.friend_requests set status = 'accepted', updated_at = $3 where from_user = $2 and to_user = $1 and status = 'pending' returning id",
      [userId, target, t],
    );
    if (incoming.length) {
      await db.query(
        'insert into bl.friendships (user_id, friend_id, created_at) values ($1, $2, $3), ($2, $1, $3) on conflict do nothing',
        [userId, target, t],
      );
      await notify(db, target, { kind: 'plus.friend_accepted', text: `${me.nick} теперь у вас в друзьях.`, actions: [{ id: 'open', title: 'Друзья', url: '/app/plus/friends' }] });
      return friends(db, { userId });
    }
    const { rows: out } = await db.query("select 1 from bl.friend_requests where from_user = $1 and to_user = $2 and status = 'pending'", [userId, target]);
    if (out.length) return friends(db, { userId });
    await db.query("select pg_advisory_xact_lock(hashtextextended('bl.plus.friend_rate:' || $1, 0))", [userId]);
    const { rows: cnt } = await db.query(
      "select count(*)::int as n from bl.friend_requests where from_user = $1 and created_at > $2::timestamptz - interval '24 hours'",
      [userId, t],
    );
    if (cnt[0].n >= FRIEND_REQUESTS_PER_DAY) fail('limit_exceeded', 'friend requests', 429);
    await db.query(
      "insert into bl.friend_requests (from_user, to_user, status, created_at, updated_at) values ($1, $2, 'pending', $3, $3)",
      [userId, target, t],
    );
    await notify(db, target, { kind: 'plus.friend_request', text: `${me.nick} хочет добавить вас в друзья.`, actions: [{ id: 'open', title: 'Ответить', url: '/app/plus/friends' }] });
    return friends(db, { userId });
  }

  /** DELETE /api/plus/friends/{user_id} — удалить из друзей, отозвать или отклонить заявку. */
  async function removeFriend(db, { userId, friendId }) {
    if (!isUuid(userId)) fail('unauthorized');
    if (!isUuid(friendId)) fail('not_found');
    const t = now();
    await db.query('delete from bl.friendships where (user_id = $1 and friend_id = $2) or (user_id = $2 and friend_id = $1)', [userId, friendId]);
    await db.query("update bl.friend_requests set status = 'canceled', updated_at = $3 where from_user = $1 and to_user = $2 and status = 'pending'", [userId, friendId, t]);
    await db.query("update bl.friend_requests set status = 'declined', updated_at = $3 where from_user = $2 and to_user = $1 and status = 'pending'", [userId, friendId, t]);
    return friends(db, { userId });
  }

  // «Ищу соперника» ------------------------------------------------------------------------

  async function lfgView(db, userId, l) {
    if (!l) return { lfg: null, candidates: [] };
    const cl = await clubs(db);
    const mine = ratingIn((await briefs(db, [userId])).get(userId), l.discipline);
    const { rows } = await db.query('select user_id, nick, rating, club_ids from bl.plus_lfg_candidates($1, $2, $3, $4::uuid[], $5, $6)', [
      l.discipline, l.from_at, l.to_at, l.club_ids, mine.rating, now(),
    ]);
    return {
      lfg: {
        id: l.id,
        discipline: l.discipline,
        from: iso(l.from_at),
        to: iso(l.to_at),
        club_ids: l.club_ids,
        clubs: l.club_ids.map((id) => ({ id, name: cl.get(id)?.name ?? null })),
      },
      candidates: rows.map((r) => ({
        user_id: r.user_id,
        nick: r.nick,
        level: levelOf(r.rating),
        rating: r.rating,
        clubs: r.club_ids.map((id) => cl.get(id)?.name).filter(Boolean),
      })),
    };
  }

  async function openLfg(db, userId) {
    const { rows } = await db.query("select * from bl.lfg where user_id = $1 and status = 'open' and to_at > $2", [userId, now()]);
    return rows[0] ?? null;
  }

  /** GET /api/plus/lfg */
  async function getLfg(db, { userId }) {
    if (!isUuid(userId)) fail('unauthorized');
    return lfgView(db, userId, await openLfg(db, userId));
  }

  /** POST /api/plus/lfg { discipline, from, to, club_ids } — одна открытая заявка игрока. */
  async function postLfg(db, { userId, body }) {
    await requireProfile(db, userId);
    const { discipline, club_ids: clubIds } = body ?? {};
    if (!DISCIPLINES.includes(discipline)) fail('bad_request', 'discipline');
    const from = parseTime(body.from, 'from');
    const to = parseTime(body.to, 'to');
    const t = ms(now());
    if (ms(to) <= ms(from) || ms(to) - ms(from) > 24 * 60 * MIN || ms(to) <= t || ms(from) > t + LFG_MAX_AHEAD_MS) fail('bad_request', 'from/to');
    if (!Array.isArray(clubIds) || clubIds.length < 1 || clubIds.length > 10 || !clubIds.every(isUuid) || new Set(clubIds).size !== clubIds.length) fail('bad_request', 'club_ids');
    const cl = await clubs(db);
    if (!clubIds.every((id) => cl.has(id))) fail('bad_request', 'club_ids');
    const nowD = now();
    await db.query("update bl.lfg set status = 'closed', updated_at = $2 where user_id = $1 and status = 'open'", [userId, nowD]);
    const { rows } = await db.query(
      `insert into bl.lfg (user_id, discipline, from_at, to_at, club_ids, status, created_at, updated_at)
       values ($1, $2, $3, $4, $5::uuid[], 'open', $6, $6) returning *`,
      [userId, discipline, from, to, clubIds, nowD],
    );
    return lfgView(db, userId, rows[0]);
  }

  /** DELETE /api/plus/lfg */
  async function deleteLfg(db, { userId }) {
    if (!isUuid(userId)) fail('unauthorized');
    await db.query("update bl.lfg set status = 'closed', updated_at = $2 where user_id = $1 and status = 'open'", [userId, now()]);
    return { lfg: null, candidates: [] };
  }

  // «Сыграем?» ---------------------------------------------------------------------------------

  async function inviteViews(db, rows) {
    const b = await briefs(db, rows.flatMap((r) => [r.from_user, r.to_user]));
    const cl = await clubs(db);
    const t = ms(now());
    return rows.map((r) => ({
      id: r.id,
      from: { user_id: r.from_user, nick: b.get(r.from_user)?.nick ?? null },
      to: { user_id: r.to_user, nick: b.get(r.to_user)?.nick ?? null },
      discipline: r.discipline,
      club: { id: r.club_id, name: cl.get(r.club_id)?.name ?? null },
      starts_at: iso(r.starts_at),
      minutes: r.minutes,
      status: r.status === 'pending' && ms(r.starts_at) <= t ? 'expired' : r.status === 'canceled' ? 'declined' : r.status,
      booking_id: r.booking_id ?? null,
    }));
  }

  /** POST /api/plus/invites { to_user_id, discipline, club_id, starts_at, minutes } — не больше 10 в сутки. */
  async function createInvite(db, { userId, body }) {
    const me = await requireProfile(db, userId);
    const { to_user_id: to, discipline, club_id: clubId, minutes } = body ?? {};
    if (!isUuid(to) || to === userId) fail('bad_request', 'to_user_id');
    if (!DISCIPLINES.includes(discipline)) fail('bad_request', 'discipline');
    if (!isUuid(clubId)) fail('bad_request', 'club_id');
    if (!Number.isInteger(minutes) || minutes < 30 || minutes > 360) fail('bad_request', 'minutes');
    const startsAt = parseTime(body.starts_at, 'starts_at');
    const t = now();
    if (ms(startsAt) <= ms(t) + 5 * MIN || ms(startsAt) > ms(t) + LFG_MAX_AHEAD_MS) fail('bad_request', 'starts_at');
    const cl = await clubs(db);
    const club = cl.get(clubId);
    if (!club) fail('bad_request', 'club_id');
    const target = (await briefs(db, [to])).get(to);
    if (!target?.nick) fail('no_profile', 'opponent');
    await db.query("select pg_advisory_xact_lock(hashtextextended('bl.plus.invite:' || $1, 0))", [userId]);
    const { rows: cnt } = await db.query(
      "select count(*)::int as n from bl.invites where from_user = $1 and created_at > $2::timestamptz - interval '24 hours'",
      [userId, t],
    );
    if (cnt[0].n >= INVITES_PER_DAY) fail('limit_exceeded', 'invites per day', 429);
    const { rows: dup } = await db.query("select 1 from bl.invites where from_user = $1 and to_user = $2 and status = 'pending' and starts_at > $3", [userId, to, t]);
    if (dup.length) fail('duplicate', 'pending invite');
    // Просроченное «pending» той же пары не мешает новому приглашению.
    await db.query("update bl.invites set status = 'canceled', updated_at = $3 where from_user = $1 and to_user = $2 and status = 'pending'", [userId, to, t]);
    const { rows } = await db.query(
      `insert into bl.invites (from_user, to_user, discipline, club_id, starts_at, minutes, status, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, 'pending', $7, $7) returning *`,
      [userId, to, discipline, clubId, startsAt, minutes, t],
    );
    await notify(db, to, {
      kind: 'plus.invite',
      text: `«Сыграем?» — ${me.nick} зовёт на ${DISCIPLINE_WORD[discipline]}: ${club.name}, ${when(startsAt, club.timezone)}, ${minutes} мин.`,
      data: { invite_id: rows[0].id },
      actions: [{ id: 'open', title: 'Ответить', url: '/app/plus/invites' }],
    });
    await afterCommit(db, () => publish(`user:${to}`, 'plus_invite', { invite_id: rows[0].id }));
    return (await inviteViews(db, rows))[0];
  }

  /** GET /api/plus/invites → { incoming, outgoing } */
  async function listInvites(db, { userId }) {
    if (!isUuid(userId)) fail('unauthorized');
    const inc = await db.query('select * from bl.invites where to_user = $1 order by created_at desc limit 50', [userId]);
    const out = await db.query('select * from bl.invites where from_user = $1 order by created_at desc limit 50', [userId]);
    return { incoming: await inviteViews(db, inc.rows), outgoing: await inviteViews(db, out.rows) };
  }

  async function myIncomingInvite(db, userId, inviteId) {
    if (!isUuid(inviteId)) fail('not_found');
    const { rows } = await db.query('select * from bl.invites where id = $1 and to_user = $2 for update', [inviteId, userId]);
    if (!rows[0]) fail('not_found', 'invite');
    return rows[0];
  }

  /**
   * POST /api/plus/invites/{id}/accept — общая бронь (bookings.createBooking): владелец брони —
   * пригласивший (платит и отменяет), принявший — участник. Стол — первый свободный нужного типа.
   */
  async function acceptInvite(db, { userId, inviteId }) {
    const inv = await myIncomingInvite(db, userId, inviteId);
    const t = now();
    if (inv.status === 'accepted') return (await inviteViews(db, [inv]))[0];
    if (inv.status !== 'pending' || ms(inv.starts_at) <= ms(t)) fail('invite_not_pending', inv.status);
    await enterClub(db, inv.club_id);
    const { rows: tables } = await db.query('select id from bl.resources where club_id = $1 and type = $2 and active order by number', [
      inv.club_id, TYPE_OF_DISCIPLINE[inv.discipline],
    ]);
    let booking = null;
    let lastErr = null;
    for (const r of tables) {
      await db.query('savepoint bl_plus_invite_booking');
      try {
        booking = await deps.bookings.createBooking(db, {
          userId: inv.from_user, resourceId: r.id, startsAt: inv.starts_at, minutes: inv.minutes, participants: [userId],
        });
        await db.query('release savepoint bl_plus_invite_booking');
        break;
      } catch (err) {
        await db.query('rollback to savepoint bl_plus_invite_booking');
        if (!isClientError(err) || err.status !== 409) throw err;
        lastErr = err;
      }
    }
    if (!booking) {
      log.info('plus_invite_no_table', { invite_id: inv.id, club_id: inv.club_id, last: lastErr?.code ?? null });
      fail('booking_conflict', 'no free table');
    }
    const bookingId = booking.id ?? booking.booking_id;
    const { rows } = await db.query(
      "update bl.invites set status = 'accepted', booking_id = $2, responded_at = $3, updated_at = $3 where id = $1 returning *",
      [inv.id, bookingId, t],
    );
    const nick = (await briefs(db, [userId])).get(userId)?.nick ?? 'Соперник';
    const pay = booking.status === 'pending_payment' ? ' Оплатите бронь, чтобы она не сгорела.' : '';
    await notify(db, inv.from_user, {
      kind: 'plus.invite_accepted',
      text: `${nick} принял приглашение «Сыграем?» — стол забронирован.${pay}`,
      data: { invite_id: inv.id, booking_id: bookingId },
      actions: [{ id: 'open', title: 'Бронь', url: `/app/bookings/${bookingId}` }],
    });
    log.info('plus_invite_accepted', { invite_id: inv.id, booking_id: bookingId });
    return (await inviteViews(db, rows))[0];
  }

  /** POST /api/plus/invites/{id}/decline */
  async function declineInvite(db, { userId, inviteId }) {
    const inv = await myIncomingInvite(db, userId, inviteId);
    if (inv.status === 'declined') return (await inviteViews(db, [inv]))[0];
    if (inv.status !== 'pending') fail('invite_not_pending', inv.status);
    const { rows } = await db.query(
      "update bl.invites set status = 'declined', responded_at = $2, updated_at = $2 where id = $1 returning *",
      [inv.id, now()],
    );
    const nick = (await briefs(db, [userId])).get(userId)?.nick ?? 'Соперник';
    await notify(db, inv.from_user, { kind: 'plus.invite_declined', text: `${nick} не сможет сыграть в это время.`, data: { invite_id: inv.id } });
    return (await inviteViews(db, rows))[0];
  }

  return {
    // профиль
    me, updateMe, player,
    // партии
    createMatch, confirmMatch, disputeMatch, resolveMatch, listMatches, disputes, expireDue,
    // рейтинг
    ratingOf, nicksOf, playerCard, applyMatch, publicRating,
    // события
    onTournamentMatchFinished, onSessionClosed, checkAchievements,
    // друзья, соперники, приглашения
    friends, addFriend, removeFriend, getLfg, postLfg, deleteLfg, createInvite, listInvites, acceptInvite, declineInvite,
  };
}
