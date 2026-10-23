// Формы ответов турниров (docs/contracts/m4-api.md, раздел «Турниры»). Без ПДн: участник наружу —
// ник (снимок при записи), посев и рейтинг; телефона, имени и user_id в публичных формах нет.

import { GROUP_LETTERS, groupStandings, groupTitle, roundTitle } from './bracket.mjs';

const iso = (d) => (d ? new Date(d).toISOString() : null);

/** Статус матча наружу: waiting/ready → scheduled. */
export function matchStatus(s) {
  if (s === 'waiting' || s === 'ready') return 'scheduled';
  return s;
}

export function displayNick(entry) {
  if (!entry) return null;
  if (entry.nick) return entry.nick;
  return entry.seed ? `Участник ${entry.seed}` : 'Участник';
}

/** Турнир T (публичная часть). club — { id, name, city } из bl.public_clubs() или null. */
export function tournamentView(t, club = null) {
  return {
    id: t.id,
    title: t.title,
    description: t.description ?? null,
    club: club
      ? { id: club.id, name: club.name, city: club.city ?? null, timezone: club.timezone ?? null, path: club.path ?? null }
      : { id: t.club_id, name: null, city: null, timezone: null, path: null },
    discipline: t.discipline,
    format: t.format,
    race_to: t.race_to,
    rating_limit: t.rating_max ?? null,
    rating_min: t.rating_min ?? null,
    fee_kopecks: Number(t.fee_kopecks),
    prize_text: t.prize_text ?? null,
    prize_kopecks: t.prize_kopecks ? t.prize_kopecks.map(Number) : null,
    places: t.places,
    entries_count: t.entries_count,
    group_count: t.group_count ?? null,
    advance_per_group: t.advance_per_group ?? null,
    starts_at: iso(t.starts_at),
    ends_at: iso(t.ends_at),
    registration_closes_at: iso(t.registration_closes_at),
    refund_rules: refundRules(t),
    status: t.status,
  };
}

export function refundRules(t) {
  const until = iso(t.registration_closes_at);
  return {
    // Игрок отменяет запись до закрытия записи — взнос возвращается целиком (№138).
    player_cancel_until: until,
    player_cancel_refund: 'full',
    // Турнир отменён клубом — взнос возвращается всем целиком.
    club_cancel_refund: 'full',
    // После закрытия записи и после старта — без возврата.
    after_start_refund: 'none',
  };
}

/** Участники наружу: подтверждённые, по посеву (до посева — по рейтингу). */
export function publicEntries(entries) {
  return entries
    .filter((e) => e.status === 'confirmed')
    .sort((x, y) => (x.seed ?? 999) - (y.seed ?? 999) || y.rating - x.rating || (String(x.id) < String(y.id) ? -1 : 1))
    .map((e) => ({ nick: displayNick(e), seed: e.seed ?? null, rating: e.rating }));
}

/** Участники для организатора (клуб): с id записи и оплатой, без телефона. */
export function clubEntries(entries) {
  return entries
    .slice()
    .sort((x, y) => (x.seed ?? 999) - (y.seed ?? 999) || new Date(x.created_at) - new Date(y.created_at))
    .map((e) => ({
      entry_id: e.id,
      nick: displayNick(e),
      rating: e.rating,
      seed: e.seed ?? null,
      group: e.group_no === null || e.group_no === undefined ? null : GROUP_LETTERS[e.group_no],
      status: e.status,
      paid: e.status !== 'canceled' && Number(e.paid_kopecks) > 0,
      paid_kopecks: Number(e.paid_kopecks),
      refund_status: e.refund_status,
      cancel_reason: e.cancel_reason ?? null,
    }));
}

function side(entry) {
  return entry ? { nick: displayNick(entry), seed: entry.seed ?? null } : null;
}

export function matchView(m, byId, tableNumbers) {
  return {
    id: m.id,
    stage: m.stage,
    round: m.round,
    group: m.group_no === null ? null : GROUP_LETTERS[m.group_no],
    table_number: m.resource_id ? (tableNumbers.get(m.resource_id) ?? null) : null,
    a: side(byId.get(m.entry_a)),
    b: side(byId.get(m.entry_b)),
    score_a: m.score_a ?? null,
    score_b: m.score_b ?? null,
    status: matchStatus(m.status),
    winner: m.winner_entry_id ? (m.winner_entry_id === m.entry_a ? 'a' : 'b') : null,
    bye: m.bye,
    scheduled_at: iso(m.scheduled_at),
    finished_at: iso(m.finished_at),
  };
}

/**
 * Сетка: { rounds: [{ title, stage, group?, matches, standings? }] }.
 * Группы — по одной «колонке» на группу (с таблицей), затем раунды плей-офф.
 */
export function bracketView(t, entries, matches, tableNumbers = new Map()) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const rounds = [];
  const groups = matches.filter((m) => m.stage === 'group');
  const groupNos = [...new Set(groups.map((m) => m.group_no))].sort((a, b) => a - b);
  for (const g of groupNos) {
    const list = groups.filter((m) => m.group_no === g).sort((x, y) => x.round - y.round || x.position - y.position);
    const members = entries.filter((e) => e.group_no === g && e.status === 'confirmed').map((e) => ({ id: e.id, seed: e.seed ?? 999 }));
    const table = groupStandings(members, list.filter((m) => m.status === 'done' && !m.bye));
    rounds.push({
      title: groupTitle(g),
      stage: 'group',
      group: GROUP_LETTERS[g],
      matches: list.map((m) => matchView(m, byId, tableNumbers)),
      standings: table.map((r) => ({
        place: r.place,
        nick: displayNick(byId.get(r.id)),
        seed: byId.get(r.id)?.seed ?? null,
        played: r.played,
        wins: r.wins,
        losses: r.losses,
        frames_for: r.frames_for,
        frames_against: r.frames_against,
      })),
    });
  }
  const playoff = matches.filter((m) => m.stage === 'playoff');
  const total = playoff.reduce((acc, m) => Math.max(acc, m.round), 0);
  for (let r = 1; r <= total; r += 1) {
    const list = playoff.filter((m) => m.round === r).sort((x, y) => x.position - y.position);
    rounds.push({ title: roundTitle(r, total), stage: 'playoff', matches: list.map((m) => matchView(m, byId, tableNumbers)) });
  }
  const winner = t.winner_entry_id ? byId.get(t.winner_entry_id) : null;
  return { rounds, winner: winner ? { nick: displayNick(winner), seed: winner.seed ?? null } : null };
}
