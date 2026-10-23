/*
 * BL_MOCK_MARKER — заглушка M4 гостя только для разработки (VITE_MOCK=1): Бильярдум+ (профиль, партии и подтверждение
 * T22/T23, рейтинг, «Ищу соперника», приглашения, друзья), турниры (афиша, запись со взносом и отказ T24, сетка, счёт
 * матча), отзыв о клубе, заявка в клуб без программы (T25). Формы ответов — как в письме координатору (контракт M4 §4).
 *
 * Сценарии: plus (профиль и история) | plusnew (ника ещё нет) | plusgame (игра на столе 4 с Андреем: три партии пары
 * уже засчитаны сегодня, четвёртая не попадёт в рейтинг — T23) | plusrace (игра на столе 4: Андрей внёс счёт и переписывает
 * его, пока вы подтверждаете — 409 score_changed, M4-3) | pluslimit (игра на столе 4 с Андреем: у гостя уже 6 засчитанных
 * партий за сутки — следующая не попадёт в рейтинг, №148, и обоим уходит plus.match_not_counted) | tour (турниры: запись, лимит рейтинга, мой матч)
 * | clubrequest (заявки гостей в клуб без программы — ответ клуба по ссылке без входа, Д1; ссылки — CLUB_REQUEST_LINKS)
 */

import { levelOf } from '@billiardum/shared/plus';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const uuid = () => globalThis.crypto.randomUUID();

/** Игроки заглушки: id, ник, рейтинги по дисциплинам. «Андрей К.» и «Мария С.» — участники сессий сида. */
const PLAYERS = [
  { id: 'b0000000-0000-4000-8000-0000000000a2', session_nick: 'Андрей К.', nick: 'Андрей_К', pyramid: 1388, pool: 1240, games: 64 },
  { id: 'b0000000-0000-4000-8000-0000000000a3', session_nick: 'Мария С.', nick: 'Мария_С', pyramid: 1290, pool: 1455, games: 41 },
  { id: 'b0000000-0000-4000-8000-0000000000a4', nick: 'Shark77', pyramid: 1712, pool: 1630, games: 212 },
  { id: 'b0000000-0000-4000-8000-0000000000a5', nick: 'Ольга_8', pyramid: 1405, pool: 1180, games: 33 },
  { id: 'b0000000-0000-4000-8000-0000000000a6', nick: 'Борт', pyramid: 1201, pool: 1199, games: 12 },
  { id: 'b0000000-0000-4000-8000-0000000000a7', nick: 'Свояк', pyramid: 1834, pool: 1500, games: 330 },
  { id: 'b0000000-0000-4000-8000-0000000000a8', nick: 'Лузер_нет', pyramid: 1150, pool: 1100, games: 8 },
];

/** Ссылки «Ответить на заявку» сценария clubrequest: /app/club-request/{id}?t={token}. */
const CLUB_REQUEST_LINKS = [
  { id: 'c3000000-0000-4000-8000-000000000001', token: 'mock-answer-token-0123456789', status: 'sent' },
  { id: 'c3000000-0000-4000-8000-000000000002', token: 'mock-answer-token-operator-01', status: 'operator' },
];

const LISTINGS = [
  { id: 'c1000000-0000-4000-8000-000000000001', name: 'Бильярдная «Абриколь»', city: 'Екатеринбург', address: 'ул. Малышева, 51', status: 'listed', timezone: 'Asia/Yekaterinburg' },
  { id: 'c1000000-0000-4000-8000-000000000002', name: 'Клуб «Свояк»', city: 'Екатеринбург', address: 'пр. Ленина, 24', status: 'claimed', timezone: 'Asia/Yekaterinburg' },
];

/**
 * @param {{ state: () => object, now: () => number, club: object, tables: () => object[], resourceId: (n: number) => string,
 *   err: Function, ok: Function, needUser: Function, meId: () => string | undefined, sessions: () => object, emitTournament?: Function }} ctx
 */
export function m4Routes(ctx) {
  const { err, ok, now, club } = ctx;
  const iso = (t) => new Date(t).toISOString();
  const S = () => {
    const st = ctx.state();
    st.m4 ??= freshM4(now(), null);
    return st.m4;
  };
  const me = () => ctx.meId();
  const player = (id) => S().players[id];
  const byNick = (nick) => Object.values(S().players).find((p) => p.nick === nick);

  function freshM4(t, scenario) {
    const players = {};
    for (const p of PLAYERS) {
      players[p.id] = {
        id: p.id,
        nick: p.nick,
        session_nick: p.session_nick ?? null,
        ratings: { pyramid: { rating: p.pyramid, games: p.games, season_rating: p.pyramid - 12 }, pool: { rating: p.pool, games: Math.round(p.games / 2), season_rating: p.pool + 8 } },
        privacy: { show_history: true, show_achievements: true, show_clubs: false, friends_see_in_club: true },
        achievements: p.games > 100 ? [{ code: 'regular', earned_at: iso(t - 40 * DAY) }, { code: 'five_clubs', earned_at: iso(t - 12 * DAY) }] : [],
      };
    }
    return { players, matches: {}, invites: {}, lfg: null, friends: [], incoming: [], outgoing: [], tournaments: seedTournaments(t), entries: {}, reviews: {}, requests: {}, scenario };
  }

  function seedMe(t, scenario) {
    const id = me();
    if (!id) return;
    const p = {
      id,
      nick: scenario === 'plusnew' ? null : 'Кий_Мастер',
      ratings: { pyramid: { rating: 1352, games: 27, season_rating: 1371 }, pool: { rating: 1210, games: 6, season_rating: 1210 } },
      privacy: { show_history: true, show_achievements: true, show_clubs: false, friends_see_in_club: false },
      achievements: [
        { code: 'dry', earned_at: iso(t - 9 * DAY) },
        { code: 'night_shift', earned_at: iso(t - 3 * DAY) },
      ],
    };
    S().players[id] = p;
    // В идущем «Вечернем пуле» гость — участник (матч с Андреем на столе 6)
    const live = S().tournaments['d4000000-0000-4000-8000-000000000003'];
    if (live && !live.entrants.includes(id)) live.entrants.push(id);
    const andrey = PLAYERS[0].id;
    const shark = PLAYERS[2].id;
    const hist = [
      [andrey, 'pyramid', 8, 5, t - 2 * DAY, +14, true, null],
      [shark, 'pyramid', 3, 8, t - 3 * DAY, -6, true, null],
      [PLAYERS[3].id, 'pool', 5, 3, t - 5 * DAY, +18, true, null],
      [andrey, 'pyramid', 8, 0, t - 9 * DAY, +16, true, null],
      [PLAYERS[1].id, 'pyramid', 6, 8, t - 11 * DAY, null, false, 'confirm_timeout'],
    ];
    for (const [opp, d, a, b, at, delta, counted, reason] of hist) addMatch({ a: id, b: opp, discipline: d, sa: a, sb: b, at, status: counted ? 'confirmed' : 'expired', counted, reason, delta });
    S().friends = [
      { user_id: andrey, since: t - 30 * DAY },
      { user_id: PLAYERS[1].id, since: t - 10 * DAY },
      { user_id: PLAYERS[3].id, since: t - 4 * DAY },
    ];
    S().incoming = [PLAYERS[4].id];
    S().outgoing = [PLAYERS[6].id];
    S().invites = {};
    const inv = { id: uuid(), from: shark, to: id, discipline: 'pyramid', club_id: club.id, starts_at: Math.ceil((t + 26 * 60 * MIN) / (30 * MIN)) * 30 * MIN, minutes: 120, status: 'pending', booking_id: null, created: t - 40 * MIN };
    S().invites[inv.id] = inv;
    if (scenario === 'plusrace') {
      // M4-3: Андрей внёс 8:5 в свою пользу и ждёт подтверждения; при первом «Подтвердить» он уже переписал на 8:3
      addMatch({ a: andrey, b: id, discipline: 'pyramid', sa: 8, sb: 5, at: t - 3 * MIN, status: 'pending', counted: null, reason: null, delta: null, session_id: ctx.sessionId, confirmedA: true, confirmedB: false }).race = { sa: 8, sb: 3 };
    }
    if (scenario === 'pluslimit') {
      // №148: у гостя уже 6 засчитанных партий за сутки с разными соперниками — партия с Андреем не попадёт в рейтинг
      const opps = [PLAYERS[1], PLAYERS[2], PLAYERS[3], PLAYERS[4], PLAYERS[5], PLAYERS[6]];
      opps.forEach((o, i) => addMatch({ a: id, b: o.id, discipline: 'pyramid', sa: i % 2 ? 5 : 8, sb: i % 2 ? 8 : 4, at: t - (300 - i * 40) * MIN, status: 'confirmed', counted: true, reason: null, delta: i % 2 ? -8 : 10 }));
    }
    if (scenario === 'plusgame') {
      // T23: с Андреем уже три засчитанные партии за эти сутки клуба
      const sid = ctx.sessionId;
      for (let i = 0; i < 3; i += 1) addMatch({ a: id, b: andrey, discipline: 'pyramid', sa: i === 1 ? 5 : 8, sb: i === 1 ? 8 : 4, at: t - (50 - i * 12) * MIN, status: 'confirmed', counted: true, reason: null, delta: i === 1 ? -9 : 11, session_id: sid });
    }
  }

  /** Тело подтверждения со счётом, который видел игрок, не совпадает с текущим (M4-3). Без счёта — как раньше. */
  function scoreChanged(body, sa, sb) {
    if (!body || (body.score_a === undefined && body.score_b === undefined)) return false;
    return body.score_a !== sa || body.score_b !== sb;
  }

  function addMatch({ a, b, discipline, sa, sb, at, status, counted, reason, delta, session_id = null, confirmedA = true, confirmedB = true }) {
    const m = { id: uuid(), session_id, discipline, a, b, sa, sb, at, status, counted, reason, delta, ca: confirmedA, cb: confirmedB, club_name: club.name, dispute: null };
    S().matches[m.id] = m;
    return m;
  }

  function seedTournaments(t) {
    const day = (n, h) => Math.floor((t + n * DAY) / (60 * MIN)) * 60 * MIN + h * 60 * MIN;
    const base = { club: { id: club.id, name: club.name, city: 'Екатеринбург' }, format: 'single_elim', prize_text: '', status: 'registration' };
    const list = [
      { ...base, id: 'd4000000-0000-4000-8000-000000000001', title: 'Кубок «Новичок»', discipline: 'pyramid', race_to: 3, rating_limit: 1300, fee_kopecks: 50000, prize_text: 'Кий в подарок победителю', places: 16, starts_at: iso(day(3, 0)), ends_at: iso(day(3, 6)), entrants: PLAYERS.slice(3, 6).map((p) => p.id) },
      { ...base, id: 'd4000000-0000-4000-8000-000000000002', title: 'Субботняя пирамида', discipline: 'pyramid', race_to: 4, rating_limit: null, fee_kopecks: 100000, prize_text: '1 место — 10 000 ₽, 2 место — 5 000 ₽', places: 32, starts_at: iso(day(5, 0)), ends_at: iso(day(5, 8)), entrants: PLAYERS.map((p) => p.id) },
      { ...base, id: 'd4000000-0000-4000-8000-000000000003', title: 'Вечерний пул', discipline: 'pool', race_to: 3, rating_limit: null, fee_kopecks: 0, places: 8, starts_at: iso(t - 90 * MIN), ends_at: iso(t + 4 * 60 * MIN), status: 'running', entrants: PLAYERS.slice(0, 7).map((p) => p.id) },
      { ...base, id: 'd4000000-0000-4000-8000-000000000004', title: 'Осенний кубок клуба', discipline: 'pyramid', race_to: 5, rating_limit: null, fee_kopecks: 150000, prize_text: 'Призовой фонд 30 000 ₽', places: 16, starts_at: iso(t - 12 * DAY), ends_at: iso(t - 12 * DAY + 8 * 60 * MIN), status: 'finished', entrants: PLAYERS.slice(0, 4).map((p) => p.id) },
    ];
    return Object.fromEntries(list.map((x) => [x.id, x]));
  }

  // ---------- представления ----------

  const ratingsView = (p) =>
    Object.entries(p.ratings).map(([discipline, r]) => ({ discipline, rating: r.rating, games: r.games, level: levelOf(r.rating).code, season_rating: r.season_rating ?? r.rating }));

  function historyOf(id) {
    return Object.values(S().matches)
      .filter((m) => (m.a === id || m.b === id) && m.status !== 'pending')
      .sort((x, y) => y.at - x.at)
      .slice(0, 20)
      .map((m) => {
        const mine = m.a === id;
        const opp = player(mine ? m.b : m.a);
        const my = mine ? m.sa : m.sb;
        const their = mine ? m.sb : m.sa;
        return {
          match_id: m.id,
          discipline: m.discipline,
          opponent_nick: opp?.nick ?? opp?.session_nick ?? 'Игрок',
          my_score: my,
          opponent_score: their,
          result: my > their ? 'win' : 'loss',
          delta: m.counted ? (mine ? m.delta : -m.delta) : null,
          counted: m.counted === true,
          not_counted_reason: m.counted === false ? m.reason : null,
          at: iso(m.at),
          club_name: m.club_name,
          tournament: Boolean(m.tournament),
        };
      });
  }

  function card(p, viewer) {
    const self = viewer === p.id;
    const out = { user_id: p.id, nick: p.nick, ratings: ratingsView(p) };
    if (self || p.privacy.show_achievements) out.achievements = p.achievements;
    if (self || p.privacy.show_history) out.history = historyOf(p.id);
    if (self) out.privacy = p.privacy;
    return out;
  }

  function matchView(m) {
    const pa = player(m.a);
    const pb = player(m.b);
    return {
      id: m.id,
      session_id: m.session_id,
      discipline: m.discipline,
      players: [
        { user_id: m.a, nick: pa?.nick ?? pa?.session_nick ?? 'Игрок', score: m.sa, confirmed: m.ca },
        { user_id: m.b, nick: pb?.nick ?? pb?.session_nick ?? 'Игрок', score: m.sb, confirmed: m.cb },
      ],
      status: m.status,
      counted: m.status === 'pending' || m.status === 'disputed' ? null : m.counted,
      not_counted_reason: m.counted === false ? m.reason : null,
      confirm_until: iso(m.at + 30 * MIN),
      rating_delta: m.counted ? { [m.a]: m.delta, [m.b]: -m.delta } : null,
      created_at: iso(m.at),
    };
  }

  /** Третья засчитанная партия пары за сутки — последняя (T23). */
  function pairCountToday(a, b, t) {
    return Object.values(S().matches).filter((m) => m.counted && ((m.a === a && m.b === b) || (m.a === b && m.b === a)) && t - m.at < DAY).length;
  }

  /** №148: засчитанных партий игрока за сутки (по всем соперникам). */
  function playerCountToday(id, t) {
    return Object.values(S().matches).filter((m) => m.counted && (m.a === id || m.b === id) && t - m.at < DAY).length;
  }

  /** Как server/plus: обоим игрокам уведомление plus.match_not_counted с причиной (лимит пары или игрока). */
  function notCounted(m, reason) {
    Object.assign(m, { counted: false, reason, delta: null });
    const why = reason === 'player_daily_limit' ? 'лимит партий за сутки — не больше 6 засчитанных у игрока' : 'это 4-я партия пары за сутки';
    S().notifications ??= [];
    for (const uid of [m.a, m.b]) S().notifications.push({ user_id: uid, kind: 'plus.match_not_counted', text: `Партия записана, но в рейтинг не засчитана: ${why}.`, data: { match_id: m.id, reason } });
  }

  function settle(m) {
    if (m.status !== 'pending' || !(m.ca && m.cb)) return;
    m.status = 'confirmed';
    if (pairCountToday(m.a, m.b, m.at) >= 3) return notCounted(m, 'pair_daily_limit');
    if (playerCountToday(m.a, m.at) >= 6 || playerCountToday(m.b, m.at) >= 6) return notCounted(m, 'player_daily_limit');
    const pa = player(m.a).ratings[m.discipline] ?? { rating: 1200, games: 0 };
    const pb = player(m.b).ratings[m.discipline] ?? { rating: 1200, games: 0 };
    const ea = 1 / (1 + 10 ** ((pb.rating - pa.rating) / 400));
    const k = pa.games < 20 ? 40 : 20;
    const delta = Math.round(k * ((m.sa > m.sb ? 1 : 0) - ea));
    Object.assign(m, { counted: true, delta });
    pa.rating += delta;
    pa.games += 1;
    pb.rating -= delta;
    pb.games += 1;
    player(m.a).ratings[m.discipline] = pa;
    player(m.b).ratings[m.discipline] = pb;
  }

  function tick() {
    const t = now();
    for (const m of Object.values(S().matches)) {
      // Соперник в заглушке подтверждает свою сторону через 4 секунды
      if (m.status === 'pending' && !m.cb && t - m.at > 4000 && m.b !== me()) {
        m.cb = true;
        settle(m);
      }
      if (m.status === 'pending' && t - m.at > 30 * MIN) Object.assign(m, { status: 'expired', counted: false, reason: 'confirm_timeout' });
    }
    for (const r of Object.values(S().requests)) {
      if (r.status === 'sent' && t - r.created > 15 * MIN) Object.assign(r, { status: 'operator', updated: t });
    }
  }

  function tournamentView(x) {
    return {
      id: x.id,
      title: x.title,
      club: x.club,
      discipline: x.discipline,
      format: x.format,
      race_to: x.race_to,
      rating_limit: x.rating_limit,
      fee_kopecks: x.fee_kopecks,
      prize_text: x.prize_text,
      places: x.places,
      entries_count: x.entrants.length,
      starts_at: x.starts_at,
      ends_at: x.ends_at,
      status: x.status,
    };
  }

  function bracketOf(x) {
    if (!['running', 'finished'].includes(x.status)) return null;
    const ids = [...x.entrants];
    const seeded = ids
      .map((id) => ({ id, rating: player(id)?.ratings[x.discipline]?.rating ?? 1200 }))
      .sort((a, b) => b.rating - a.rating)
      .map((p, i) => ({ ...p, seed: i + 1 }));
    let size = 1;
    while (size < seeded.length) size *= 2;
    const slots = Array.from({ length: size }, (_, i) => seeded[i] ?? null);
    const pairs = [];
    for (let i = 0; i < size / 2; i += 1) pairs.push([slots[i], slots[size - 1 - i]]);
    const side = (p) => (p ? { nick: player(p.id)?.nick ?? 'Игрок', seed: p.seed } : null);
    const rounds = [];
    let current = pairs;
    let r = 0;
    while (current.length) {
      const matches = current.map(([a, b], i) => {
        const key = `${x.id}:${r}:${i}`;
        const st = S().tmatches?.[key];
        let status = 'scheduled';
        let sa = null;
        let sb = null;
        let winner = null;
        if (!a || !b) {
          // Свободный проход — только в первом круге; дальше пустая сторона — соперник ещё не определился
          winner = r === 0 ? (a ? 'a' : b ? 'b' : null) : null;
          status = r === 0 && (a || b) ? 'done' : 'scheduled';
        } else if (x.status === 'finished' || (r === 0 && a.id !== me() && b.id !== me() && !st)) {
          sa = x.race_to;
          sb = (i + r) % x.race_to;
          winner = 'a';
          status = 'done';
        } else if (st) {
          ({ sa, sb, status } = st);
          winner = status === 'done' ? (sa > sb ? 'a' : 'b') : null;
        } else if (r === 0) status = 'playing';
        return { id: key, table_number: r === 0 ? 6 + (i % 3) : null, a: side(a), b: side(b), a_id: a?.id ?? null, b_id: b?.id ?? null, score_a: sa, score_b: sb, status, winner };
      });
      rounds.push({ title: matches.length === 1 ? 'Финал' : matches.length === 2 ? 'Полуфинал' : `1/${matches.length}`, matches });
      if (current.length === 1) break;
      const next = [];
      for (let i = 0; i < matches.length; i += 2) {
        const w = (m) => (m.winner === 'a' ? (m.a_id ? { id: m.a_id, seed: m.a.seed } : null) : m.winner === 'b' ? (m.b_id ? { id: m.b_id, seed: m.b.seed } : null) : null);
        next.push([w(matches[i]), w(matches[i + 1])]);
      }
      current = next;
      r += 1;
    }
    return { rounds: rounds.map((rd) => ({ title: rd.title, matches: rd.matches.map(({ a_id: _a, b_id: _b, ...m }) => m) })), _raw: rounds };
  }

  function publicTournament(x) {
    const b = bracketOf(x);
    return {
      ...tournamentView(x),
      entries: x.entrants
        .map((id) => ({ nick: player(id)?.nick ?? 'Игрок', rating: player(id)?.ratings[x.discipline]?.rating ?? 1200 }))
        .sort((p, q) => q.rating - p.rating)
        .map((p, i) => ({ ...p, seed: i + 1 })),
      bracket: b ? { rounds: b.rounds } : null,
    };
  }

  function myMatch(x) {
    const b = bracketOf(x);
    if (!b) return null;
    for (const rd of b._raw) {
      for (const m of rd.matches) {
        if (m.status === 'done' || !m.a || !m.b) continue;
        const side = m.a_id === me() ? 'a' : m.b_id === me() ? 'b' : null;
        if (!side) continue;
        const st = S().tmatches?.[m.id];
        const rep = st ? { score_a: st.sa, score_b: st.sb, at: new Date(now()).toISOString() } : null;
        const mineRep = st?.by === me();
        return { id: m.id, side, opponent_nick: side === 'a' ? m.b.nick : m.a.nick, score_a: m.score_a, score_b: m.score_b, status: m.status, i_confirmed: mineRep, my_report: mineRep ? rep : null, opponent_report: !mineRep ? rep : null, race_to: x.race_to, table_number: m.table_number };
      }
    }
    return null;
  }

  // ---------- маршруты ----------

  const routes = [
    // Бильярдум+: профиль
    ['GET', /^\/api\/plus\/me$/, () => ctx.needUser() ?? ok(card(player(me()) ?? ensureMe(), me()))],
    ['PATCH', /^\/api\/plus\/me$/, (_m, b) => {
      const u = ctx.needUser();
      if (u) return u;
      const p = player(me()) ?? ensureMe();
      if (b?.nick !== undefined) {
        if (!/^[\p{L}\p{N}_-]{3,20}$/u.test(b.nick ?? '')) return err(400, 'bad_request');
        if (byNick(b.nick) && byNick(b.nick).id !== p.id) return err(409, 'nick_taken');
        p.nick = b.nick;
      }
      if (b?.privacy) p.privacy = { ...p.privacy, ...b.privacy };
      return ok(card(p, me()));
    }],
    ['GET', /^\/api\/plus\/players\/([^/]+)$/, (m) => {
      const p = byNick(decodeURIComponent(m[1]));
      return p ? ok(card(p, me())) : err(404, 'not_found');
    }],
    // Партии
    ['GET', /^\/api\/plus\/matches$/, (_m, _b, q) => {
      const u = ctx.needUser();
      if (u) return u;
      const sid = q?.get?.('session_id') || null;
      return ok({ items: Object.values(S().matches).filter((x) => (!sid || x.session_id === sid) && (x.a === me() || x.b === me())).sort((x, y) => y.at - x.at).map(matchView) });
    }],
    ['POST', /^\/api\/plus\/matches$/, (_m, b) => {
      const u = ctx.needUser();
      if (u) return u;
      const s = ctx.sessions()[b?.session_id];
      if (!s) return err(404, 'not_found');
      if (!player(b.opponent_id) && !ctx.participantId?.(b.opponent_id)) return err(409, 'match_not_participant');
      if (!['pyramid', 'pool', 'snooker'].includes(b.discipline) || !Number.isInteger(b.my_score) || !Number.isInteger(b.opponent_score) || b.my_score === b.opponent_score) return err(400, 'bad_request');
      const m = addMatch({ a: me(), b: b.opponent_id, discipline: b.discipline, sa: b.my_score, sb: b.opponent_score, at: now(), status: 'pending', counted: null, reason: null, delta: null, session_id: s.id, confirmedA: true, confirmedB: false });
      return { status: 201, body: matchView(m) };
    }],
    ['POST', /^\/api\/plus\/matches\/([^/]+)\/confirm$/, (m, b) => {
      const x = S().matches[m[1]];
      if (!x) return err(404, 'not_found');
      if (x.status !== 'pending') return err(409, 'match_closed');
      if (x.a !== me() && x.b !== me()) return err(403, 'match_not_participant');
      // Сценарий plusrace: соперник переписывает счёт, пока игрок смотрит на старый (M4-3)
      if (x.race) Object.assign(x, { race: false, ...x.race });
      // Подтверждается показанный счёт { score_a, score_b }; переписан — 409 score_changed, как у backend-plus
      if (scoreChanged(b, x.sa, x.sb)) return err(409, 'score_changed');
      if (x.a === me()) x.ca = true;
      else x.cb = true;
      settle(x);
      return ok(matchView(x));
    }],
    ['POST', /^\/api\/plus\/matches\/([^/]+)\/dispute$/, (m, b) => {
      const x = S().matches[m[1]];
      if (!x) return err(404, 'not_found');
      if (!['pending', 'confirmed'].includes(x.status)) return err(409, 'match_closed');
      if (!String(b?.reason ?? '').trim()) return err(400, 'reason_required');
      Object.assign(x, { status: 'disputed', dispute: String(b.reason).slice(0, 300) });
      return ok(matchView(x));
    }],
    // Рейтинг
    ['GET', /^\/api\/(public|plus)\/rating$/, (m0, _b, q) => {
      const qd = q?.get?.('discipline');
      const d = ['pyramid', 'pool', 'snooker'].includes(qd) ? qd : 'pyramid';
      const season = Boolean(q?.get?.('season')) && q.get('season') !== 'all';
      const all = Object.values(S().players)
        .filter((p) => p.nick && p.ratings[d])
        .map((p) => ({ id: p.id, nick: p.nick, rating: season ? p.ratings[d].season_rating ?? p.ratings[d].rating : p.ratings[d].rating, games: p.ratings[d].games }))
        .sort((a, b) => b.rating - a.rating)
        .map((p, i) => ({ ...p, place: i + 1, level: levelOf(p.rating).code }));
      const sc = q?.get?.('scope');
      // Клуб и город: игроки с show_clubs=false не показываются (№145)
      const visible = sc === 'club' || sc === 'city' ? all.filter((p) => S().players[p.id]?.privacy?.show_clubs !== false || p.id !== me()) : all;
      const items = (sc === 'club' ? visible.filter((_p, i) => i % 3 !== 2) : visible).map((p, i) => ({ place: i + 1, nick: p.nick, level: p.level, rating: p.rating, games: p.games, id: p.id }));
      const mine = items.find((p) => p.id === me());
      // Публичная таблица — без «моего места» (№144)
      return ok({ items: items.map(({ id: _id, ...p }) => p), me: m0[1] === 'plus' && mine ? { place: mine.place, rating: mine.rating } : null });
    }],
    // Ищу соперника
    ['GET', /^\/api\/plus\/lfg$/, () => ctx.needUser() ?? ok(lfgView())],
    ['POST', /^\/api\/plus\/lfg$/, (_m, b) => {
      const u = ctx.needUser();
      if (u) return u;
      if (!['pyramid', 'pool', 'snooker'].includes(b?.discipline)) return err(400, 'bad_request');
      S().lfg = { discipline: b.discipline, from: b.from, to: b.to, club_ids: b.club_ids ?? [club.id], created_at: iso(now()) };
      return ok(lfgView());
    }],
    ['DELETE', /^\/api\/plus\/lfg$/, () => {
      S().lfg = null;
      return ok(lfgView());
    }],
    ['GET', /^\/api\/plus\/invites$/, () => {
      const u = ctx.needUser();
      if (u) return u;
      const all = Object.values(S().invites);
      return ok({ incoming: all.filter((i) => i.to === me()).map(inviteView), outgoing: all.filter((i) => i.from === me()).map(inviteView) });
    }],
    ['POST', /^\/api\/plus\/invites$/, (_m, b) => {
      const u = ctx.needUser();
      if (u) return u;
      const sent = Object.values(S().invites).filter((i) => i.from === me() && now() - i.created < DAY).length;
      if (sent >= 10) return err(429, 'invite_limit');
      if (!player(b?.to_user_id)) return err(404, 'not_found');
      const inv = { id: uuid(), from: me(), to: b.to_user_id, discipline: b.discipline, club_id: b.club_id ?? club.id, starts_at: Date.parse(b.starts_at), minutes: b.minutes ?? 60, status: 'pending', booking_id: null, created: now() };
      S().invites[inv.id] = inv;
      return { status: 201, body: inviteView(inv) };
    }],
    ['POST', /^\/api\/plus\/invites\/([^/]+)\/(accept|decline)$/, (m) => {
      const inv = S().invites[m[1]];
      if (!inv || inv.to !== me()) return err(404, 'not_found');
      if (inv.status !== 'pending') return err(409, 'match_closed');
      inv.status = m[2] === 'accept' ? 'accepted' : 'declined';
      if (inv.status === 'accepted') inv.booking_id = uuid();
      return ok(inviteView(inv));
    }],
    // Друзья
    ['GET', /^\/api\/plus\/friends$/, () => ctx.needUser() ?? ok(friendsView())],
    ['POST', /^\/api\/plus\/friends$/, (_m, b) => {
      const u = ctx.needUser();
      if (u) return u;
      const p = byNick(String(b?.nick ?? '').trim());
      if (!p || p.id === me()) return err(404, 'not_found');
      const st = S();
      if (st.incoming.includes(p.id)) {
        st.incoming = st.incoming.filter((x) => x !== p.id);
        st.friends.push({ user_id: p.id, since: now() });
      } else if (!st.friends.some((f) => f.user_id === p.id) && !st.outgoing.includes(p.id)) st.outgoing.push(p.id);
      return ok(friendsView());
    }],
    ['DELETE', /^\/api\/plus\/friends\/([^/]+)$/, (m) => {
      const st = S();
      st.friends = st.friends.filter((f) => f.user_id !== m[1]);
      st.incoming = st.incoming.filter((x) => x !== m[1]);
      st.outgoing = st.outgoing.filter((x) => x !== m[1]);
      return ok(friendsView());
    }],
    // Турниры
    ['GET', /^\/api\/public\/tournaments$/, () => ok({ items: Object.values(S().tournaments).sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at)).map(tournamentView) })],
    ['GET', /^\/api\/public\/tournaments\/([^/]+)$/, (m) => (S().tournaments[m[1]] ? ok(publicTournament(S().tournaments[m[1]])) : err(404, 'not_found'))],
    ['GET', /^\/api\/tournaments\/([^/]+)\/me$/, (m) => {
      const u = ctx.needUser();
      if (u) return u;
      const x = S().tournaments[m[1]];
      if (!x) return err(404, 'not_found');
      const e = S().entries[x.id];
      const entered = x.entrants.includes(me());
      return ok({ entry: e ?? (entered ? { id: `e-${x.id}`, status: 'confirmed' } : null), match: myMatch(x) });
    }],
    ['POST', /^\/api\/tournaments\/([^/]+)\/entries$/, (m, b) => {
      const u = ctx.needUser();
      if (u) return u;
      const x = S().tournaments[m[1]];
      if (!x) return err(404, 'not_found');
      if (x.status !== 'registration') return err(409, 'registration_closed');
      // №150: запись только с ником Бильярдум+
      if (!player(me())?.nick) return err(409, 'no_profile');
      if (x.entrants.includes(me()) || S().entries[x.id]?.status === 'confirmed') return err(409, 'already_entered');
      if (x.entrants.length >= x.places) return err(409, 'tournament_full');
      const rating = player(me())?.ratings[x.discipline]?.rating ?? 1200;
      if (x.rating_limit && rating > x.rating_limit) return { status: 409, body: { error: 'rating_above_limit', limit: x.rating_limit, rating } };
      const id = uuid();
      if (!x.fee_kopecks) {
        x.entrants.push(me());
        S().entries[x.id] = { id, status: 'confirmed' };
        return { status: 201, body: { entry_id: id, status: 'confirmed', confirmation: null } };
      }
      S().entries[x.id] = { id, status: 'pending_payment' };
      const pid = uuid();
      ctx.state().payments[pid] = { id: pid, kind: 'tournament', tournament_id: x.id, entry_id: id, status: 'pending', amount_kopecks: x.fee_kopecks, return_url: b?.return_url ?? `/app/tournaments/${x.id}?paid=1` };
      return { status: 201, body: { entry_id: id, status: 'pending_payment', confirmation: { type: 'redirect', url: `/app/mock-pay/${pid}` } } };
    }],
    ['DELETE', /^\/api\/tournaments\/([^/]+)\/entries\/me$/, (m) => {
      const x = S().tournaments[m[1]];
      if (!x) return err(404, 'not_found');
      if (x.status !== 'registration') return err(409, 'registration_closed');
      x.entrants = x.entrants.filter((id) => id !== me());
      const was = S().entries[x.id];
      S().entries[x.id] = was ? { ...was, status: 'canceled' } : null;
      return ok({ refund_kopecks: was?.status === 'confirmed' ? x.fee_kopecks : 0 });
    }],
    ['POST', /^\/api\/tournaments\/matches\/([^/]+)\/(score|confirm)$/, (m, b) => {
      const key = decodeURIComponent(m[1]);
      S().tmatches ??= {};
      const st = S().tmatches[key];
      if (m[2] === 'score') {
        if (!Number.isInteger(b?.score_a) || !Number.isInteger(b?.score_b)) return err(400, 'bad_request');
        S().tmatches[key] = { sa: b.score_a, sb: b.score_b, status: 'pending_confirm', by: me() };
      } else {
        if (!st) return err(409, 'match_closed');
        if (scoreChanged(b, st.sa, st.sb)) return err(409, 'score_changed');
        st.status = 'done';
      }
      const x = S().tournaments[key.split(':')[0]];
      ctx.emitTournament?.(x.id, { rounds: bracketOf(x).rounds });
      return ok({ id: key, ...S().tmatches[key] });
    }],
    // Отзывы
    ['GET', /^\/api\/reviews\/mine$/, (_m, _b, q) => ctx.needUser() ?? ok(S().reviews[q?.get?.('club_id')] ?? null)],
    ['POST', /^\/api\/reviews$/, (_m, b) => {
      const u = ctx.needUser();
      if (u) return u;
      if (S().scenario === 'noreview') return err(403, 'review_not_allowed');
      if (!(b?.rating >= 1 && b.rating <= 5) || String(b.text ?? '').length > 1000) return err(400, 'bad_request');
      const r = { id: S().reviews[b.club_id]?.id ?? uuid(), club_id: b.club_id, rating: b.rating, text: String(b.text ?? '').replace(/\+?\d[\d\s()-]{8,}\d/g, '***'), created_at: iso(now()), reply: null };
      S().reviews[b.club_id] = r;
      return { status: 201, body: r };
    }],
    // Заявка в клуб без программы (T25)
    ['GET', /^\/api\/public\/listings\/([^/]+)$/, (m) => {
      const l = LISTINGS.find((x) => x.id === m[1]);
      return l ? ok(l) : err(404, 'not_found');
    }],
    ['POST', /^\/api\/clubs\/requests$/, (_m, b) => {
      const u = ctx.needUser();
      if (u) return u;
      const l = LISTINGS.find((x) => x.id === b?.listing_id);
      if (!l) return err(404, 'not_found');
      if (!b.starts_at || !(b.minutes > 0) || !(b.people >= 1 && b.people <= 20)) return err(400, 'bad_request');
      const r = { id: uuid(), listing: l, starts_at: b.starts_at, minutes: b.minutes, people: b.people, comment: String(b.comment ?? '').slice(0, 300), status: 'sent', created: now(), updated: now(), answer_text: null };
      S().requests[r.id] = r;
      return { status: 201, body: requestView(r) };
    }],
    ['POST', /^\/api\/clubs\/requests\/([^/]+)\/cancel$/, (m) => {
      const r = S().requests[m[1]];
      if (!r) return err(404, 'not_found');
      if (['sent', 'operator'].includes(r.status)) Object.assign(r, { status: 'closed', updated: now() });
      return ok(requestView(r));
    }],
    // «Добавить» и «Подтвердить клуб» — заявки оператору
    ['POST', /^\/api\/directory\/add$/, (_m, b) => {
      const u = ctx.needUser();
      if (u) return u;
      if (!String(b?.city ?? '').trim() || !String(b?.name ?? '').trim() || !String(b?.address ?? '').trim()) return err(400, 'bad_request');
      return { status: 201, body: { id: uuid(), status: 'new' } };
    }],
    ['POST', /^\/api\/directory\/claim$/, (_m, b) => {
      const u = ctx.needUser();
      if (u) return u;
      const l = LISTINGS.find((x) => x.id === b?.listing_id);
      if (!l) return err(404, 'not_found');
      if (l.status !== 'listed') return err(409, 'already_claimed');
      return { status: 201, body: { id: uuid(), status: 'new' } };
    }],
    ['GET', /^\/api\/clubs\/requests\/([^/]+)$/, (m) => (S().requests[m[1]] ? ok(requestView(S().requests[m[1]])) : err(404, 'not_found'))],
    // Ответ клуба по ссылке из уведомления — без входа, токен на 24 часа; решённая заявка — 409 request_closed {status}
    // (как server/directory/requests.mjs)
    ['GET', /^\/api\/clubs\/requests\/([^/]+)\/answer$/, (m, _b, q) => {
      const r = byToken(m[1], q?.get?.('t'));
      if (!r) return err(404, 'not_found');
      if (!['sent', 'operator'].includes(r.status)) return { status: 409, body: { error: 'request_closed', status: r.status } };
      const tz = r.listing.timezone;
      return ok({ id: r.id, status: r.status, timezone: tz, club: { name: r.listing.name, timezone: tz }, starts_at: r.starts_at, minutes: r.minutes, people: r.people, comment: r.comment || null, guest_phone: r.guest_phone ?? null, created_at: iso(r.created) });
    }],
    ['POST', /^\/api\/clubs\/requests\/([^/]+)\/answer$/, (m, b) => {
      const r = byToken(m[1], b?.t);
      if (!r) return err(404, 'not_found');
      if (!['sent', 'operator'].includes(r.status)) return { status: 409, body: { error: 'request_closed', status: r.status } };
      if (!['accept', 'decline'].includes(b.decision)) return err(400, 'bad_request');
      const text = String(b.text ?? '').trim().slice(0, 500);
      Object.assign(r, { status: b.decision === 'accept' ? 'accepted' : 'declined', answer_text: text || null, updated: now() });
      return ok(requestView(r));
    }],
  ];

  function byToken(id, token) {
    const r = S().requests[id];
    return r?.token && typeof token === 'string' && token === r.token && r.token_until > now() ? r : null;
  }

  function ensureMe() {
    seedMe(now(), S().scenario);
    return player(me());
  }

  function lfgView() {
    const mine = player(me())?.ratings[S().lfg?.discipline ?? 'pyramid']?.rating ?? 1200;
    const d = S().lfg?.discipline ?? 'pyramid';
    const candidates = S().lfg
      ? Object.values(S().players)
          .filter((p) => p.id !== me() && p.nick && Math.abs((p.ratings[d]?.rating ?? 1200) - mine) <= 150)
          .map((p) => ({ user_id: p.id, nick: p.nick, rating: p.ratings[d]?.rating ?? 1200, level: levelOf(p.ratings[d]?.rating ?? 1200).code, clubs: [club.name] }))
      : [];
    return { lfg: S().lfg, candidates };
  }

  function inviteView(i) {
    return { id: i.id, from: { user_id: i.from, nick: player(i.from)?.nick ?? 'Игрок' }, to: { user_id: i.to, nick: player(i.to)?.nick ?? 'Игрок' }, discipline: i.discipline, club: { id: club.id, name: club.name }, starts_at: iso(i.starts_at), minutes: i.minutes, status: i.status, booking_id: i.booking_id };
  }

  function friendsView() {
    const st = S();
    const short = (id) => ({ user_id: id, nick: player(id)?.nick ?? 'Игрок', level: levelOf(player(id)?.ratings.pyramid?.rating ?? 1200).code });
    return {
      friends: st.friends.map((f, i) => ({
        ...short(f.user_id),
        rating: player(f.user_id)?.ratings.pyramid?.rating ?? null,
        in_club_now: i === 0 && player(f.user_id)?.privacy.friends_see_in_club ? { club_name: club.name, since: iso(now() - 35 * MIN) } : null,
      })),
      incoming: st.incoming.map(short),
      outgoing: st.outgoing.map(short),
    };
  }

  function requestView(r) {
    return { id: r.id, status: r.status, club: { name: r.listing.name, city: r.listing.city, address: r.listing.address }, starts_at: r.starts_at, minutes: r.minutes, people: r.people, comment: r.comment, answer_text: r.answer_text, updated_at: iso(r.updated), timezone: r.listing.timezone };
  }

  /**
   * Сценарий clubrequest (Д1): две заявки гостей в «Абриколь» (клуб без программы) — ответ клуба по ссылке без входа.
   * Ссылки — в CLUB_REQUEST_LINKS; демо-телефон гостя — только заглушка.
   */
  function seedClubRequests(t) {
    const at = Math.ceil((t + 26 * 60 * MIN) / (60 * MIN)) * 60 * MIN;
    for (const [i, x] of CLUB_REQUEST_LINKS.entries()) {
      S().requests[x.id] = {
        id: x.id, listing: LISTINGS[0], starts_at: iso(at + i * 2 * 60 * MIN), minutes: i ? 90 : 120, people: i ? 2 : 4,
        comment: i ? '' : 'Стол под пирамиду, если можно — у окна', guest_phone: '+79990001122', status: x.status,
        created: t - (i ? 20 : 2) * MIN, updated: t - (i ? 5 : 2) * MIN, answer_text: null, token: x.token, token_until: t + 24 * 60 * MIN,
      };
    }
  }

  /** Оплата взноса в заглушке ЮKassa. */
  function confirm(p, success) {
    const x = S().tournaments[p.tournament_id];
    if (!success) {
      p.status = 'canceled';
      S().entries[x.id] = { id: p.entry_id, status: 'canceled' };
      return;
    }
    Object.assign(p, { status: 'succeeded', paid_at: now() });
    S().entries[x.id] = { id: p.entry_id, status: 'confirmed' };
    if (!x.entrants.includes(me())) x.entrants.push(me());
  }

  /** Участник сессии для выбора соперника: user_id по имени в сессии. */
  function userIdOf(nick) {
    if (nick === ctx.state().user?.nick) return me();
    return PLAYERS.find((p) => p.session_nick === nick)?.id ?? null;
  }

  /** Ник Бильярдум+ участника сессии (light, M4): у кого ника нет — null, экран покажет label «Игрок N». */
  function plusNick(nick) {
    const id = userIdOf(nick);
    return id ? (player(id)?.nick ?? null) : null;
  }

  return {
    routes,
    tick,
    confirm,
    userIdOf,
    plusNick,
    seed(name, t) {
      ctx.state().m4 = freshM4(t, name);
      seedMe(t, name);
      if (name === 'clubrequest') seedClubRequests(t);
    },
    tournamentBracket: (id) => (S().tournaments[id] ? bracketOf(S().tournaments[id])?.rounds : null),
  };
}

export { LISTINGS, CLUB_REQUEST_LINKS };
