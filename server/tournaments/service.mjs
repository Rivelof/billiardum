// Турниры (backend-tournaments, контракт M4 §1 п. 11, §3, §4; решения №138, №143; PRODUCT §14).
//
// Все функции принимают db — клиента транзакции withContext. Контекст:
//   * клуб турнира — маршруты клуба, планировщик, outbox;
//   * без клуба (анонимный сайт, личный контекст гостя) — функции сами переходят в клуб турнира
//     (enterClub) после того, как нашли турнир по публичной политике или свой матч по политике self.
// Свет — только через light (удержание source tournament и старт без оплаты, №143); деньги — через money
// (взнос kind tournament, возврат); рейтинг и ник — через plus. Соседи — deps.mjs.

import { randomUUID } from 'node:crypto';
import { setContext, afterCommit } from '../lib/store.mjs';
import {
  defaultMatchMinutes,
  groupStandings,
  planElimination,
  qualifierSlots,
  roundRobin,
  seedOrder,
  splitGroups,
  validScore,
} from './bracket.mjs';
import { fail, TournamentError } from './errors.mjs';
import { bracketView, clubEntries, displayNick, matchStatus, publicEntries, tournamentView } from './view.mjs';

export const MINUTE = 60_000;
/** Сколько ждём взнос после записи (место держится). */
export const PAY_MINUTES = 15;
/** Продление удержания стола, если матч ещё идёт ближе этого к концу удержания. */
export const EXTEND_BEFORE_MS = 10 * MINUTE;
/** Кэш публичных ответов (контракт §4: кэш 60 с). */
export const PUBLIC_CACHE_MS = 60_000;

export const DISCIPLINES = ['pyramid', 'pool', 'snooker'];
export const FORMATS = ['single_elim', 'groups_playoff'];
const RESOURCE_TYPE = { pyramid: 'billiard_pyramid', pool: 'billiard_pool', snooker: 'billiard_snooker' };
const LIVE = ['playing', 'pending_confirm', 'disputed'];
const OPEN = ['registration', 'closed', 'running'];
export const ORGANIZER_ROLES = ['owner', 'manager'];
/** Причины возврата взноса: код → текст для журнала и чека возврата money. */
export const REFUND_REASONS = {
  player: 'Игрок отменил запись до закрытия записи',
  tournament_canceled: 'Турнир отменён клубом',
  duplicate: 'Повторная оплата взноса',
  full: 'Мест на турнир не осталось',
  late: 'Взнос оплачен после начала турнира',
  amount_mismatch: 'Сумма оплаты не совпала со взносом',
  not_confirmed: 'Запись не подтверждена к началу турнира',
  payment_timeout: 'Оплата после истечения срока записи',
  canceled: 'Запись отменена',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isUuid = (v) => typeof v === 'string' && UUID.test(v);
const iso = (d) => (d ? new Date(d).toISOString() : null);
const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function parseTime(v, field) {
  if (typeof v !== 'string' || v.length > 40) fail('bad_request', field);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) fail('bad_request', field);
  return d;
}

function cleanText(v, field, max, { required = false } = {}) {
  if (v === undefined || v === null) {
    if (required) fail('bad_request', field);
    return null;
  }
  if (typeof v !== 'string') fail('bad_request', field);
  const s = v.trim();
  if (s === '') {
    if (required) fail('bad_request', field);
    return null;
  }
  if (s.length > max) fail('bad_request', field);
  return s;
}

function cleanReason(v) {
  if (typeof v !== 'string' || v.trim() === '') fail('reason_required');
  const s = v.trim();
  if (s.length > 2000) fail('bad_request', 'reason');
  return s;
}

/** Точка сохранения: ошибка соседа (light) не ломает транзакцию вызывающего. */
async function savepoint(db, fn) {
  const name = `tr_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await db.query(`savepoint ${name}`);
  try {
    const out = await fn();
    await db.query(`release savepoint ${name}`);
    return { ok: true, value: out };
  } catch (err) {
    await db.query(`rollback to savepoint ${name}`);
    return { ok: false, error: err };
  }
}

/**
 * @param {{ deps: object, log: any, clock: { now(): Date }, pool?: any, withContext?: Function,
 *           tv?: { publish(id, bracket): number }, publishDelayMs?: number }} options
 */
export function createTournamentService({ deps, log, clock, pool = null, withContext = null, tv = null, publishDelayMs = 50 }) {
  const now = () => clock.now();
  const cache = new Map();

  // --- Общие запросы -------------------------------------------------------------------------

  async function enterClub(db, clubId) {
    const cur = (await db.query('select bl.ctx_club_id() as c')).rows[0].c;
    if (cur === clubId) return;
    if (cur !== null) fail('forbidden', 'другой клуб в контексте');
    await setContext(db, { clubId });
  }

  /** Клуб опубликованного турнира (публичная политика) или своего (контекст клуба). */
  async function clubOf(db, tournamentId) {
    if (!isUuid(tournamentId)) fail('not_found');
    const { rows } = await db.query('select club_id from bl.tournaments where id = $1', [tournamentId]);
    if (rows.length === 0) fail('not_found', 'tournament');
    return rows[0].club_id;
  }

  async function loadT(db, id, { lock = false } = {}) {
    const { rows } = await db.query(`select * from bl.tournaments where id = $1 ${lock ? 'for update' : ''}`, [id]);
    if (rows.length === 0) fail('not_found', 'tournament');
    return rows[0];
  }

  async function entriesOf(db, tid) {
    return (await db.query('select * from bl.tournament_entries where tournament_id = $1 order by created_at, id', [tid])).rows;
  }

  async function matchesOf(db, tid) {
    return (
      await db.query(
        `select * from bl.tournament_matches where tournament_id = $1
          order by (stage = 'playoff'), round, coalesce(group_no, -1), position`,
        [tid],
      )
    ).rows;
  }

  async function tablesOf(db, tid) {
    return (
      await db.query(
        `select r.id, r.number from bl.tournament_resources tr join bl.resources r on r.club_id = tr.club_id and r.id = tr.resource_id
          where tr.tournament_id = $1 order by r.number`,
        [tid],
      )
    ).rows;
  }

  async function tableNumbers(db, clubId) {
    const { rows } = await db.query('select id, number from bl.resources where club_id = $1', [clubId]);
    return new Map(rows.map((r) => [r.id, r.number]));
  }

  async function audit(db, entry) {
    await deps.audit.appendAudit(db, entry);
  }

  // Необязательные вызовы соседей в транзакции — только в точке сохранения: ошибка SQL внутри
  // иначе оборвала бы транзакцию, и COMMIT молча откатил бы всё.
  async function notifyUser(db, userId, msg) {
    if (!userId) return;
    const r = await savepoint(db, () => deps.notify.send(db, userId, msg));
    if (!r.ok) log.warn('tournament_notify_failed', { kind: msg.kind, error: r.error?.message });
  }

  async function notifyOrganizers(db, clubId, msg, roles = ORGANIZER_ROLES) {
    if (!deps.notify.sendToClubStaff) return;
    const r = await savepoint(db, () => deps.notify.sendToClubStaff(db, clubId, roles, msg));
    if (!r.ok) log.warn('tournament_notify_failed', { kind: msg.kind, error: r.error?.message });
  }

  function userEvent(db, userId, data) {
    if (!userId) return Promise.resolve();
    return afterCommit(db, () => deps.sse.publish(`user:${userId}`, 'tournament', data));
  }

  // --- Публикация сетки (ТВ, программа клуба) и кэш ---------------------------------------------

  const pending = new Map();
  const inflight = new Set();

  function invalidate(tid) {
    cache.delete(`t:${tid}`);
    for (const k of [...cache.keys()]) if (k.startsWith('list:')) cache.delete(k);
  }

  async function publishNow(tid, clubId) {
    invalidate(tid);
    if (!pool || !withContext) return;
    try {
      const out = await withContext(pool, { clubId, actorType: 'system' }, async (db) => {
        const t = await loadT(db, tid);
        const bracket = bracketView(t, await entriesOf(db, tid), await matchesOf(db, tid), await tableNumbers(db, clubId));
        return { t, bracket };
      });
      if (out.t.status !== 'draft') tv?.publish(tid, out.bracket);
      deps.sse.publish(`club:${clubId}`, 'tournament', { type: 'tournament.updated', tournament_id: tid, status: out.t.status });
    } catch (err) {
      log.warn('tournament_publish_failed', { tournament_id: tid, error: err.message });
    }
  }

  function schedulePublish(tid, clubId) {
    invalidate(tid);
    if (pending.has(tid)) return;
    const p = new Promise((resolve) => {
      setTimeout(() => {
        pending.delete(tid);
        publishNow(tid, clubId).finally(resolve);
      }, publishDelayMs);
    });
    pending.set(tid, p);
    inflight.add(p);
    p.finally(() => inflight.delete(p));
  }

  /** Сетка изменилась: после коммита — ТВ и программе клуба (с задержкой, одно событие на пачку). */
  function changed(db, t) {
    return afterCommit(db, () => schedulePublish(t.id, t.club_id));
  }

  async function flush() {
    while (pending.size > 0 || inflight.size > 0) await Promise.all([...pending.values(), ...inflight]);
  }

  async function cached(key, fn) {
    const hit = cache.get(key);
    const t = Date.now();
    if (hit && t - hit.at < PUBLIC_CACHE_MS) return hit.value;
    const value = await fn();
    cache.set(key, { at: t, value });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return value;
  }

  // --- Клуб: создание, правка, публикация -----------------------------------------------------------

  async function checkTables(db, clubId, discipline, ids) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 32 || !ids.every(isUuid) || new Set(ids).size !== ids.length) {
      fail('bad_request', 'resource_ids');
    }
    const { rows } = await db.query('select id, type, active from bl.resources where club_id = $1 and id = any($2::uuid[])', [clubId, ids]);
    if (rows.length !== ids.length) fail('bad_request', 'resource_ids: не столы клуба');
    if (rows.some((r) => !r.active || r.type !== RESOURCE_TYPE[discipline])) fail('bad_request', 'resource_ids: тип стола');
  }

  async function setTables(db, t, ids) {
    await db.query('delete from bl.tournament_resources where tournament_id = $1', [t.id]);
    for (const id of ids) {
      await db.query('insert into bl.tournament_resources (club_id, tournament_id, resource_id) values ($1, $2, $3)', [t.club_id, t.id, id]);
    }
  }

  /** Поля турнира из тела запроса (создание — все; правка — только присланные). */
  function readFields(body, base) {
    const b = body ?? {};
    const out = {};
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    if (!base || has('title')) out.title = cleanText(b.title, 'title', 120, { required: true });
    if (has('description')) out.description = cleanText(b.description, 'description', 4000);
    if (!base || has('discipline')) {
      if (!DISCIPLINES.includes(b.discipline)) fail('bad_request', 'discipline');
      out.discipline = b.discipline;
    }
    if (!base || has('format')) {
      if (!FORMATS.includes(b.format)) fail('bad_request', 'format');
      out.format = b.format;
    }
    if (!base || has('race_to')) {
      if (!intIn(b.race_to, 1, 25)) fail('bad_request', 'race_to');
      out.race_to = b.race_to;
    }
    if (has('rating_limit')) {
      if (b.rating_limit !== null && !intIn(b.rating_limit, 0, 4000)) fail('bad_request', 'rating_limit');
      out.rating_max = b.rating_limit;
    }
    if (has('rating_min')) {
      if (b.rating_min !== null && !intIn(b.rating_min, 0, 4000)) fail('bad_request', 'rating_min');
      out.rating_min = b.rating_min;
    }
    if (!base || has('fee_kopecks')) {
      const fee = b.fee_kopecks ?? 0;
      if (!intIn(fee, 0, 100_000_000)) fail('bad_request', 'fee_kopecks');
      out.fee_kopecks = fee;
    }
    if (has('prize_text')) out.prize_text = cleanText(b.prize_text, 'prize_text', 2000);
    if (has('prize_kopecks')) {
      const p = b.prize_kopecks;
      if (p !== null && (!Array.isArray(p) || p.length < 1 || p.length > 16 || !p.every((x) => intIn(x, 0, 100_000_000)))) fail('bad_request', 'prize_kopecks');
      out.prize_kopecks = p;
    }
    if (!base || has('places')) {
      if (!intIn(b.places, 2, 128)) fail('bad_request', 'places');
      out.places = b.places;
    }
    if (has('group_count')) {
      if (b.group_count !== null && !intIn(b.group_count, 2, 16)) fail('bad_request', 'group_count');
      out.group_count = b.group_count;
    }
    if (has('advance_per_group')) {
      if (b.advance_per_group !== null && !intIn(b.advance_per_group, 1, 4)) fail('bad_request', 'advance_per_group');
      out.advance_per_group = b.advance_per_group;
    }
    if (has('match_minutes')) {
      if (b.match_minutes !== null && !intIn(b.match_minutes, 10, 600)) fail('bad_request', 'match_minutes');
      out.match_minutes = b.match_minutes;
    }
    if (!base || has('starts_at')) out.starts_at = parseTime(b.starts_at, 'starts_at');
    if (!base || has('ends_at')) out.ends_at = parseTime(b.ends_at, 'ends_at');
    if (has('registration_closes_at')) out.registration_closes_at = b.registration_closes_at === null ? null : parseTime(b.registration_closes_at, 'registration_closes_at');
    return out;
  }

  /** Итоговые значения: проверка связей полей. */
  function normalize(merged) {
    const m = { ...merged };
    if (m.format === 'groups_playoff') {
      if (m.group_count === null || m.group_count === undefined) fail('bad_request', 'group_count');
      m.advance_per_group ??= 2;
      if (m.group_count * 2 > m.places) fail('bad_request', 'group_count: в группе нужно ≥ 2 игроков');
      if (m.group_count * m.advance_per_group < 2) fail('bad_request', 'advance_per_group');
    } else {
      m.group_count = null;
      m.advance_per_group = null;
    }
    m.match_minutes ??= defaultMatchMinutes(m.race_to);
    m.registration_closes_at ??= m.starts_at;
    if (m.ends_at <= m.starts_at) fail('bad_request', 'ends_at');
    if (m.ends_at - m.starts_at > 14 * 24 * 3600_000) fail('bad_request', 'ends_at: не больше 14 дней');
    if (m.registration_closes_at > m.starts_at) fail('bad_request', 'registration_closes_at');
    if (m.rating_min !== null && m.rating_min !== undefined && m.rating_max !== null && m.rating_max !== undefined && m.rating_min > m.rating_max) {
      fail('bad_request', 'rating_min');
    }
    return m;
  }

  const COLUMNS = [
    'title', 'description', 'discipline', 'format', 'race_to', 'rating_min', 'rating_max', 'fee_kopecks', 'prize_text', 'prize_kopecks',
    'places', 'group_count', 'advance_per_group', 'match_minutes', 'starts_at', 'ends_at', 'registration_closes_at',
  ];

  async function create(db, { clubId, staffId, body }) {
    const t0 = now();
    const f = normalize({ rating_min: null, rating_max: null, description: null, prize_text: null, prize_kopecks: null, ...readFields(body, null) });
    if (f.starts_at <= t0) fail('bad_request', 'starts_at: в прошлом');
    await checkTables(db, clubId, f.discipline, body?.resource_ids);
    const publish = body?.publish === true;
    const id = randomUUID();
    const values = COLUMNS.map((c) => f[c] ?? null);
    await db.query(
      `insert into bl.tournaments (id, club_id, ${COLUMNS.join(', ')}, status, published_at, created_at, updated_at)
       values ($1, $2, ${COLUMNS.map((_, i) => `$${i + 3}`).join(', ')}, $${COLUMNS.length + 3}, $${COLUMNS.length + 4}, $${COLUMNS.length + 5}, $${COLUMNS.length + 5})`,
      [id, clubId, ...values, publish ? 'registration' : 'draft', publish ? t0 : null, t0],
    );
    const t = await loadT(db, id);
    await setTables(db, t, body.resource_ids);
    await audit(db, {
      action: 'tournament.create',
      objectType: 'tournament',
      objectId: id,
      actorType: 'user',
      actorId: staffId,
      data: { tournament_id: id, title: t.title, discipline: t.discipline, format: t.format, fee_kopecks: Number(t.fee_kopecks), places: t.places, status: t.status, resource_ids: body.resource_ids },
    });
    await changed(db, t);
    return clubDetail(db, { clubId, tournamentId: id });
  }

  /** Что можно менять в каком статусе. */
  function allowedFields(t, entriesExist) {
    if (t.status === 'draft') return new Set([...COLUMNS, 'resource_ids']);
    if (t.status === 'registration' || t.status === 'closed') {
      const s = new Set(['title', 'description', 'prize_text', 'prize_kopecks', 'places', 'match_minutes', 'starts_at', 'ends_at', 'registration_closes_at', 'resource_ids']);
      // Пока никто не записался — и условия участия.
      if (!entriesExist) for (const c of ['discipline', 'format', 'race_to', 'rating_min', 'rating_max', 'fee_kopecks', 'group_count', 'advance_per_group']) s.add(c);
      return s;
    }
    if (t.status === 'running') return new Set(['title', 'description', 'prize_text', 'prize_kopecks', 'match_minutes', 'ends_at', 'resource_ids']);
    return new Set(['description', 'prize_text', 'prize_kopecks']);
  }

  async function update(db, { clubId, staffId, tournamentId, body }) {
    const t = await loadT(db, tournamentId, { lock: true });
    if (t.club_id !== clubId) fail('not_found');
    const t0 = now();
    const b = body ?? {};
    const fields = readFields(b, t);
    const live = (await db.query("select count(*)::int as n from bl.tournament_entries where tournament_id = $1 and status <> 'canceled'", [t.id])).rows[0].n;
    const allowed = allowedFields(t, live > 0);
    for (const k of Object.keys(fields)) if (!allowed.has(k)) fail('bad_status', `поле ${k} в статусе ${t.status}`);
    if (b.resource_ids !== undefined && !allowed.has('resource_ids')) fail('bad_status', 'resource_ids');
    const merged = normalize({ ...Object.fromEntries(COLUMNS.map((c) => [c, t[c]])), ...fields });
    if (fields.places !== undefined && merged.places < t.entries_count) fail('bad_request', 'places: меньше записавшихся');
    let status = t.status;
    if (b.status !== undefined) {
      const moves = { draft: ['registration'], registration: ['closed'], closed: ['registration'] };
      if (b.status !== t.status && !(moves[t.status] ?? []).includes(b.status)) fail('bad_status', `${t.status} → ${b.status}`);
      status = b.status;
      if (status === 'registration' && merged.registration_closes_at <= t0) fail('bad_request', 'registration_closes_at: в прошлом');
    }
    const resourceIds = b.resource_ids;
    if (resourceIds !== undefined) await checkTables(db, clubId, merged.discipline, resourceIds);
    else if (fields.discipline && fields.discipline !== t.discipline) await checkTables(db, clubId, merged.discipline, (await tablesOf(db, t.id)).map((r) => r.id));
    const sets = COLUMNS.map((c, i) => `${c} = $${i + 2}`);
    await db.query(
      `update bl.tournaments set ${sets.join(', ')}, status = $${COLUMNS.length + 2},
              published_at = coalesce(published_at, case when $${COLUMNS.length + 2} = 'registration' then $${COLUMNS.length + 3}::timestamptz end),
              updated_at = $${COLUMNS.length + 3}
        where id = $1`,
      [t.id, ...COLUMNS.map((c) => merged[c] ?? null), status, t0],
    );
    if (resourceIds !== undefined) await setTables(db, t, resourceIds);
    const changedFields = [...Object.keys(fields).filter((k) => String(fields[k]) !== String(t[k])), ...(resourceIds !== undefined ? ['resource_ids'] : [])];
    await audit(db, {
      action: status !== t.status ? (status === 'registration' ? 'tournament.publish' : status === 'closed' ? 'tournament.close' : 'tournament.update') : 'tournament.update',
      objectType: 'tournament',
      objectId: t.id,
      actorType: 'user',
      actorId: staffId,
      data: { tournament_id: t.id, fields: changedFields, from: t.status, to: status },
    });
    await changed(db, t);
    return clubDetail(db, { clubId, tournamentId: t.id });
  }

  async function listClub(db, { clubId }) {
    const { rows } = await db.query('select * from bl.tournaments where club_id = $1 order by starts_at desc limit 200', [clubId]);
    return { items: rows.map((t) => tournamentView(t)) };
  }

  async function clubDetail(db, { clubId, tournamentId }) {
    const t = await loadT(db, tournamentId);
    if (t.club_id !== clubId) fail('not_found');
    const entries = await entriesOf(db, t.id);
    const matches = await matchesOf(db, t.id);
    const tables = await tablesOf(db, t.id);
    const nums = await tableNumbers(db, clubId);
    const bracket = bracketView(t, entries, matches, nums);
    // Организатору — и счета, внесённые игроками (спор).
    const reports = new Map(matches.map((m) => [m.id, { report_a: m.report_a ?? null, report_b: m.report_b ?? null }]));
    for (const r of bracket.rounds) for (const m of r.matches) Object.assign(m, reports.get(m.id));
    return {
      ...tournamentView(t),
      tables: tables.map((r) => ({ resource_id: r.id, number: r.number })),
      match_minutes: t.match_minutes,
      entries: clubEntries(entries),
      bracket,
    };
  }

  // --- Публичная афиша (сайт) ------------------------------------------------------------------------

  async function publicClubs(db) {
    const { rows } = await db.query('select id, name, city from bl.public_clubs()');
    return new Map(rows.map((c) => [c.id, c]));
  }

  /**
   * GET /api/public/tournaments: идущие и будущие (registration, closed, running) и завершённые
   * за 30 дней; фильтры city (название города клуба), club, discipline, status.
   */
  async function publicList(db, query = {}) {
    const discipline = DISCIPLINES.includes(query.discipline) ? query.discipline : null;
    const status = ['registration', 'closed', 'running', 'finished', 'canceled'].includes(query.status) ? query.status : null;
    const club = isUuid(query.club) ? query.club : null;
    const city = typeof query.city === 'string' && query.city.length <= 100 ? query.city.trim().toLowerCase() : null;
    const key = `list:${discipline}:${status}:${club}:${city}`;
    return cached(key, async () => {
      const clubs = await publicClubs(db);
      const t0 = now();
      const { rows } = await db.query(
        `select * from bl.tournaments
          where status <> 'draft'
            and ($1::text is null or discipline = $1)
            and ($3::uuid is null or club_id = $3)
            and (case when $2::text is not null then status = $2
                      else status in ('registration', 'closed', 'running')
                           or (status = 'finished' and finished_at > $4::timestamptz - interval '30 days') end)
          order by (status = 'finished'), starts_at
          limit 200`,
        [discipline, status, club, t0],
      );
      const items = rows
        .filter((t) => clubs.has(t.club_id))
        .filter((t) => !city || String(clubs.get(t.club_id).city ?? '').toLowerCase() === city)
        .map((t) => tournamentView(t, clubs.get(t.club_id)));
      return { items };
    });
  }

  /** GET /api/public/tournaments/{id}: T + участники (ник, посев, рейтинг) + сетка. Черновик — 404. */
  async function publicDetail(db, { tournamentId }) {
    if (!isUuid(tournamentId)) fail('not_found');
    return cached(`t:${tournamentId}`, async () => {
      const clubId = await clubOf(db, tournamentId);
      const clubs = await publicClubs(db);
      if (!clubs.has(clubId)) fail('not_found', 'club inactive');
      await enterClub(db, clubId);
      const t = await loadT(db, tournamentId);
      if (t.status === 'draft') fail('not_found');
      const entries = await entriesOf(db, t.id);
      const matches = await matchesOf(db, t.id);
      return {
        ...tournamentView(t, clubs.get(clubId)),
        entries: publicEntries(entries),
        bracket: bracketView(t, entries, matches, await tableNumbers(db, clubId)),
      };
    });
  }

  /** Сетка для ТВ (первое событие потока). */
  async function publicBracket(db, { tournamentId }) {
    const d = await publicDetail(db, { tournamentId });
    return d.bracket;
  }

  // --- Запись игрока (T24) ----------------------------------------------------------------------------

  async function liveEntryOf(db, tid, userId) {
    const { rows } = await db.query("select * from bl.tournament_entries where tournament_id = $1 and user_id = $2 and status <> 'canceled' for update", [tid, userId]);
    return rows[0] ?? null;
  }

  async function seatsTaken(db, tid, t0) {
    const { rows } = await db.query(
      `select count(*)::int as n from bl.tournament_entries
        where tournament_id = $1 and (status = 'confirmed' or (status = 'pending_payment' and pay_until > $2))`,
      [tid, t0],
    );
    return rows[0].n;
  }

  async function ratingFor(db, userId, discipline) {
    const r = await deps.plus.ratingOf(db, { userId, discipline });
    const rating = Math.round(Number(r?.rating));
    if (!Number.isFinite(rating)) fail('not_configured', 'plus.ratingOf: нет рейтинга', 501);
    return Math.max(0, Math.min(4000, rating));
  }

  async function nickFor(db, userId) {
    if (typeof deps.plus.playerCard !== 'function') return null;
    const r = await savepoint(db, () => deps.plus.playerCard(db, { userId, viewerId: userId }));
    if (!r.ok) {
      log.warn('tournament_nick_failed', { error: r.error?.message });
      return null;
    }
    const nick = typeof r.value?.nick === 'string' ? r.value.nick.trim() : '';
    return nick.length >= 1 && nick.length <= 32 ? nick : null;
  }

  async function bumpCount(db, tid, delta, t0) {
    await db.query('update bl.tournaments set entries_count = greatest(0, entries_count + $2), updated_at = $3 where id = $1', [tid, delta, t0]);
  }

  /** Запись: проверка рейтинга (T24), мест, взнос. → { entry_id, status, confirmation: { url } | null }. */
  async function enter(db, { tournamentId, userId, body = {}, requestKey = null }) {
    const clubId = await clubOf(db, tournamentId);
    // Телефон для чека 54-ФЗ — своя строка пользователя (личный контекст, до входа в клуб).
    const phone = (await db.query('select phone from bl.users where id = $1', [userId])).rows[0]?.phone ?? null;
    await enterClub(db, clubId);
    const t = await loadT(db, tournamentId, { lock: true });
    const t0 = now();
    if (t.status !== 'registration' || t0 >= t.registration_closes_at) fail('registration_closed');
    const returnUrl = body.return_url === undefined || body.return_url === null ? null : cleanText(body.return_url, 'return_url', 500);
    const method = body.method === undefined ? undefined : body.method;
    if (method !== undefined && method !== 'sbp' && method !== 'card') fail('bad_request', 'method');

    let entry = await liveEntryOf(db, t.id, userId);
    if (entry?.status === 'confirmed') fail('already_registered');
    if (entry && entry.pay_until <= t0) {
      // Брошенная оплата: место не держится; новая попытка — новой записью.
      await cancelEntryRow(db, entry, 'payment_timeout', t0);
      entry = null;
    }

    // Рейтинг дисциплины (T24): выше лимита — отказ с объяснением (limit, rating).
    const rating = await ratingFor(db, userId, t.discipline);
    if (t.rating_max !== null && rating > t.rating_max) fail('rating_above_limit', undefined, 409, { limit: t.rating_max, rating });
    if (t.rating_min !== null && rating < t.rating_min) fail('rating_below_limit', undefined, 409, { limit: t.rating_min, rating });

    if (!entry) {
      if ((await seatsTaken(db, t.id, t0)) >= t.places) fail('full');
      const nick = await nickFor(db, userId);
      const free = Number(t.fee_kopecks) === 0;
      const { rows } = await db.query(
        `insert into bl.tournament_entries (club_id, tournament_id, user_id, nick, rating, status, fee_kopecks, pay_until, confirmed_at, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) returning *`,
        [t.club_id, t.id, userId, nick, rating, free ? 'confirmed' : 'pending_payment', t.fee_kopecks, free ? null : new Date(t0.getTime() + PAY_MINUTES * MINUTE), free ? t0 : null, t0],
      );
      entry = rows[0];
      if (free) await bumpCount(db, t.id, 1, t0);
      await audit(db, {
        action: 'tournament.entry',
        objectType: 'tournament_entry',
        objectId: entry.id,
        actorType: 'user',
        actorId: userId,
        data: { tournament_id: t.id, entry_id: entry.id, rating, fee_kopecks: Number(t.fee_kopecks), status: entry.status },
      });
    }
    let confirmation = null;
    if (entry.status === 'pending_payment') {
      const res = await deps.payments.createTournamentFee(db, {
        clubId: t.club_id,
        tournamentId: t.id,
        entryId: entry.id,
        userId,
        amountKopecks: Number(entry.fee_kopecks),
        customer: phone ? { phone } : null,
        method,
        returnUrl,
        requestKey,
        title: t.title,
      });
      const paymentId = res?.payment?.id ?? res?.payment_id ?? null;
      const url = res?.confirmation?.url ?? res?.confirmation?.confirmation_url ?? null;
      if (paymentId && isUuid(paymentId) && paymentId !== entry.payment_id) {
        await db.query('update bl.tournament_entries set payment_id = $2, updated_at = $3 where id = $1', [entry.id, paymentId, t0]);
      }
      confirmation = url ? { url } : null;
    } else {
      await notifyUser(db, userId, {
        kind: 'tournament.entry',
        text: `Вы записаны на турнир «${t.title}»`,
        data: { tournament_id: t.id },
        actions: [{ id: 'open', title: 'Турнир', url: `/app/tournaments/${t.id}` }],
      });
    }
    await changed(db, t);
    return { entry_id: entry.id, status: entry.status, confirmation };
  }

  async function cancelEntryRow(db, entry, reason, t0) {
    await db.query(
      `update bl.tournament_entries set status = 'canceled', cancel_reason = $2, canceled_at = $3, updated_at = $3,
              refund_status = case when paid_kopecks > 0 then 'pending' else refund_status end
        where id = $1`,
      [entry.id, reason, t0],
    );
    if (entry.status === 'confirmed') await bumpCount(db, entry.tournament_id, -1, t0);
    if (Number(entry.paid_kopecks) > 0) {
      await deps.outbox.enqueue(db, 'tournament.refund', { entry_id: entry.id, payment_id: entry.payment_id, club_id: entry.club_id, reason });
      return true;
    }
    return false;
  }

  /** Отмена записи игроком: до закрытия записи — взнос целиком назад; после — 409 registration_closed. */
  async function withdraw(db, { tournamentId, userId }) {
    const clubId = await clubOf(db, tournamentId);
    await enterClub(db, clubId);
    const t = await loadT(db, tournamentId, { lock: true });
    const entry = await liveEntryOf(db, t.id, userId);
    if (!entry) fail('not_found', 'entry');
    const t0 = now();
    const open = t.status === 'registration' && t0 < t.registration_closes_at;
    // Неоплаченную запись можно снять, пока турнир не начался (денег нет).
    if (!open && !(entry.status === 'pending_payment' && ['registration', 'closed'].includes(t.status))) fail('registration_closed');
    const refunded = await cancelEntryRow(db, entry, 'player', t0);
    await audit(db, {
      action: 'tournament.entry_cancel',
      objectType: 'tournament_entry',
      objectId: entry.id,
      actorType: 'user',
      actorId: userId,
      data: { tournament_id: t.id, entry_id: entry.id, refund: refunded, paid_kopecks: Number(entry.paid_kopecks) },
    });
    await changed(db, t);
    return { entry_id: entry.id, status: 'canceled', refund: refunded };
  }

  /** GET /api/tournaments/{id}/me. */
  async function me(db, { tournamentId, userId }) {
    const clubId = await clubOf(db, tournamentId);
    await enterClub(db, clubId);
    const t = await loadT(db, tournamentId);
    const { rows } = await db.query(
      `select * from bl.tournament_entries where tournament_id = $1 and user_id = $2
        order by (status <> 'canceled') desc, created_at desc limit 1`,
      [t.id, userId],
    );
    const e = rows[0] ?? null;
    let match = null;
    if (e && e.status === 'confirmed') {
      const m = (
        await db.query(
          `select * from bl.tournament_matches where tournament_id = $1 and (entry_a = $2 or entry_b = $2) and not bye
            order by (status in ('playing', 'pending_confirm', 'disputed')) desc, (status = 'ready') desc, (status = 'done'), round desc limit 1`,
          [t.id, e.id],
        )
      ).rows[0];
      if (m && m.status !== 'waiting') {
        const sideMe = m.entry_a === e.id ? 'a' : 'b';
        const oppId = sideMe === 'a' ? m.entry_b : m.entry_a;
        const opp = oppId ? (await db.query('select * from bl.tournament_entries where id = $1', [oppId])).rows[0] : null;
        const nums = await tableNumbers(db, clubId);
        match = {
          id: m.id,
          side: sideMe,
          opponent_nick: displayNick(opp),
          score_a: m.score_a,
          score_b: m.score_b,
          status: matchStatus(m.status),
          table_number: m.resource_id ? (nums.get(m.resource_id) ?? null) : null,
          i_confirmed: Boolean(sideMe === 'a' ? m.report_a : m.report_b),
          my_report: (sideMe === 'a' ? m.report_a : m.report_b) ?? null,
          opponent_report: (sideMe === 'a' ? m.report_b : m.report_a) ?? null,
        };
      }
    }
    return {
      tournament: tournamentView(t),
      entry: e ? { id: e.id, status: e.status, seed: e.seed ?? null, paid: Number(e.paid_kopecks) > 0, refund_status: e.refund_status } : null,
      match,
    };
  }

  // --- Деньги: payment.confirmed {kind: 'tournament', entry_id} и возвраты -----------------------------

  async function onPaymentConfirmed(db, payload) {
    if (payload?.kind !== 'tournament') return;
    const entryId = payload.entry_id;
    const paymentId = payload.payment_id;
    if (!isUuid(entryId) || !isUuid(paymentId)) {
      log.warn('tournament_payment_bad_event', { payment_id: isUuid(paymentId) ? paymentId : null });
      return;
    }
    const { rows } = await db.query('select * from bl.tournament_entries where id = $1 for update', [entryId]);
    const e = rows[0];
    if (!e) {
      log.error('tournament_payment_unknown_entry', { payment_id: paymentId, entry_id: entryId });
      return;
    }
    const t0 = now();
    const amount = Number(payload.amount_kopecks ?? e.fee_kopecks);
    // Один раз по payment_id (уникальный ключ): повтор события — ничего.
    const ins = await db.query(
      `insert into bl.tournament_payments (payment_id, club_id, entry_id, outcome, amount_kopecks, created_at)
       values ($1, $2, $3, 'applied', $4, $5) on conflict (payment_id) do nothing returning payment_id`,
      [paymentId, e.club_id, e.id, amount, t0],
    );
    if (ins.rowCount === 0) return;
    const t = await loadT(db, e.tournament_id, { lock: true });
    let refundReason = null;
    if (e.status === 'confirmed') refundReason = e.payment_id === paymentId && Number(e.paid_kopecks) === 0 ? null : 'duplicate';
    else if (e.status === 'canceled') refundReason = REFUND_REASONS[e.cancel_reason] ? e.cancel_reason : 'canceled';
    else if (!['registration', 'closed'].includes(t.status)) refundReason = 'late';
    else if (amount < Number(e.fee_kopecks)) refundReason = 'amount_mismatch';
    else {
      const taken = await db.query(
        `select count(*)::int as n from bl.tournament_entries where tournament_id = $1 and id <> $2
           and (status = 'confirmed' or (status = 'pending_payment' and pay_until > $3))`,
        [t.id, e.id, t0],
      );
      if (taken.rows[0].n >= t.places) refundReason = 'full';
    }
    if (refundReason) {
      await db.query("update bl.tournament_payments set outcome = 'refunded' where payment_id = $1", [paymentId]);
      if (e.status === 'pending_payment') {
        await db.query(
          "update bl.tournament_entries set status = 'canceled', cancel_reason = $2, canceled_at = $3, updated_at = $3 where id = $1",
          [e.id, refundReason === 'full' ? 'full' : 'not_confirmed', t0],
        );
      }
      await deps.outbox.enqueue(db, 'tournament.refund', { entry_id: e.id, payment_id: paymentId, club_id: e.club_id, reason: refundReason });
      await audit(db, {
        action: 'tournament.payment_refund',
        objectType: 'tournament_entry',
        objectId: e.id,
        actorType: 'system',
        actorId: null,
        data: { tournament_id: t.id, entry_id: e.id, payment_id: paymentId, reason: refundReason, amount_kopecks: amount },
      });
      await notifyUser(db, e.user_id, {
        kind: 'tournament.refund',
        text: refundReason === 'full' ? `Мест на турнир «${t.title}» не осталось — взнос вернём` : `Взнос за турнир «${t.title}» вернём`,
        data: { tournament_id: t.id },
      });
      await changed(db, t);
      return;
    }
    await db.query(
      `update bl.tournament_entries set status = 'confirmed', payment_id = $2, paid_kopecks = $3, confirmed_at = $4, pay_until = null, updated_at = $4
        where id = $1`,
      [e.id, paymentId, amount, t0],
    );
    await bumpCount(db, t.id, 1, t0);
    await audit(db, {
      action: 'tournament.entry_paid',
      objectType: 'tournament_entry',
      objectId: e.id,
      actorType: 'system',
      actorId: null,
      data: { tournament_id: t.id, entry_id: e.id, payment_id: paymentId, amount_kopecks: amount },
    });
    await notifyUser(db, e.user_id, {
      kind: 'tournament.entry',
      text: `Взнос получен: вы записаны на турнир «${t.title}»`,
      data: { tournament_id: t.id },
      actions: [{ id: 'open', title: 'Турнир', url: `/app/tournaments/${t.id}` }],
    });
    await userEvent(db, e.user_id, { type: 'tournament.entry', tournament_id: t.id, entry_id: e.id, status: 'confirmed' });
    await changed(db, t);
  }

  /**
   * outbox tournament.refund: возврат взноса через money (идемпотентен у money: ключ trn-<payment_id>).
   * Лишняя оплата уже подтверждённой записи (duplicate) возвращается только этим платежом: общим
   * refund money с тем же ключом trn-<payment_id>, иначе refundTournamentFee вернул бы и основной взнос.
   */
  async function onRefund(db, payload) {
    if (!isUuid(payload?.entry_id)) return;
    const code = typeof payload.reason === 'string' && REFUND_REASONS[payload.reason] ? payload.reason : 'canceled';
    const paymentId = isUuid(payload.payment_id) ? payload.payment_id : null;
    let res;
    if (code === 'duplicate' && paymentId && typeof deps.payments.refund === 'function') {
      const amount = Number((await db.query('select amount_kopecks from bl.tournament_payments where payment_id = $1', [paymentId])).rows[0]?.amount_kopecks ?? 0);
      if (amount > 0) {
        res = await deps.payments.refund(db, { paymentId, amountKopecks: amount, reason: REFUND_REASONS[code], key: `trn-${paymentId}`, description: 'Возврат взноса за турнир' });
      }
    } else {
      res = await deps.payments.refundTournamentFee(db, { entryId: payload.entry_id, paymentId, reason: REFUND_REASONS[code], reasonCode: code });
    }
    await db.query(
      "update bl.tournament_entries set refund_status = 'done', updated_at = $2 where id = $1 and refund_status = 'pending'",
      [payload.entry_id, now()],
    );
    log.info('tournament_refund', { entry_id: payload.entry_id, refund_id: res?.refund_id ?? null });
  }

  // --- Старт: посев и сетка ------------------------------------------------------------------------------

  async function insertMatch(db, t, m, t0) {
    await db.query(
      `insert into bl.tournament_matches (id, club_id, tournament_id, stage, round, position, group_no, entry_a, entry_b, user_a, user_b,
                                          src_a, src_b, bye, next_match_id, next_slot, status, winner_entry_id, result_source, finished_at,
                                          created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $21)`,
      [
        m.id, t.club_id, t.id, m.stage, m.round, m.position, m.group_no ?? null, m.entry_a ?? null, m.entry_b ?? null, m.user_a ?? null,
        m.user_b ?? null, m.src_a ?? null, m.src_b ?? null, m.bye ?? false, m.next_match_id ?? null, m.next_slot ?? null, m.status,
        m.winner_entry_id ?? null, m.result_source ?? null, m.finished_at ?? null, t0,
      ],
    );
  }

  /** Олимпийская сетка: матчи от финала к первому раунду (ссылка на следующий уже существует). */
  async function insertElimination(db, t, plan, slotOf, t0) {
    const ids = new Map(plan.matches.map((m) => [`${m.round}:${m.position}`, randomUUID()]));
    const ordered = [...plan.matches].sort((a, b) => b.round - a.round || a.position - b.position);
    for (const pm of ordered) {
      const a = pm.a === null ? null : slotOf(pm.a);
      const b = pm.b === null ? null : slotOf(pm.b);
      await insertMatch(
        db,
        t,
        {
          id: ids.get(`${pm.round}:${pm.position}`),
          stage: 'playoff',
          round: pm.round,
          position: pm.position,
          entry_a: a?.entry?.id ?? null,
          entry_b: b?.entry?.id ?? null,
          user_a: a?.entry?.user_id ?? null,
          user_b: b?.entry?.user_id ?? null,
          src_a: a?.src ?? null,
          src_b: b?.src ?? null,
          bye: pm.bye,
          next_match_id: pm.next ? ids.get(`${pm.next.round}:${pm.next.position}`) : null,
          next_slot: pm.next?.slot ?? null,
          status: a?.entry && b?.entry ? 'ready' : 'waiting',
        },
        t0,
      );
    }
    return ids;
  }

  async function start(db, { clubId, staffId, tournamentId }) {
    const t = await loadT(db, tournamentId, { lock: true });
    if (t.club_id !== clubId) fail('not_found');
    if (!['registration', 'closed'].includes(t.status)) fail('bad_status', t.status);
    const t0 = now();
    // Неоплаченные к старту — снимаются (поздняя оплата вернётся, onPaymentConfirmed).
    await db.query(
      `update bl.tournament_entries set status = 'canceled', cancel_reason = 'not_confirmed', canceled_at = $2, updated_at = $2
        where tournament_id = $1 and status = 'pending_payment'`,
      [t.id, t0],
    );
    const confirmed = (await entriesOf(db, t.id)).filter((e) => e.status === 'confirmed');
    const need = t.format === 'groups_playoff' ? t.group_count * 2 : 2;
    if (confirmed.length < need) fail('too_few_entries', `${confirmed.length} < ${need}`);
    // Посев по свежему рейтингу дисциплины; plus недоступен — по рейтингу при записи.
    for (const e of confirmed) {
      const r = await savepoint(db, () => ratingFor(db, e.user_id, t.discipline));
      if (r.ok) e.rating = r.value;
      else log.warn('tournament_seed_rating_failed', { entry_id: e.id, error: r.error?.message });
    }
    const seeded = seedOrder(confirmed);
    for (let i = 0; i < seeded.length; i += 1) {
      seeded[i].seed = i + 1;
      await db.query('update bl.tournament_entries set seed = $2, rating = $3, updated_at = $4 where id = $1', [seeded[i].id, i + 1, seeded[i].rating, t0]);
    }
    if (t.format === 'single_elim') {
      await insertElimination(db, t, planElimination(seeded), (e) => ({ entry: e }), t0);
    } else {
      const groups = splitGroups(seeded, t.group_count);
      for (let g = 0; g < groups.length; g += 1) {
        for (const e of groups[g]) {
          e.group_no = g;
          await db.query('update bl.tournament_entries set group_no = $2 where id = $1', [e.id, g]);
        }
        const rounds = roundRobin(groups[g]);
        for (let r = 0; r < rounds.length; r += 1) {
          for (let p = 0; p < rounds[r].length; p += 1) {
            const [a, b] = rounds[r][p];
            await insertMatch(
              db,
              t,
              { id: randomUUID(), stage: 'group', round: r + 1, position: p, group_no: g, entry_a: a.id, entry_b: b.id, user_a: a.user_id, user_b: b.user_id, status: 'ready' },
              t0,
            );
          }
        }
      }
      const slots = qualifierSlots(t.group_count, t.advance_per_group);
      await insertElimination(db, t, planElimination(slots), (s) => ({ src: `g${s.group}p${s.place}` }), t0);
    }
    await db.query("update bl.tournaments set status = 'running', started_at = $2, updated_at = $2 where id = $1", [t.id, t0]);
    t.status = 'running';
    t.started_at = t0;
    await audit(db, {
      action: 'tournament.start',
      objectType: 'tournament',
      objectId: t.id,
      actorType: 'user',
      actorId: staffId,
      data: { tournament_id: t.id, entries: seeded.length, seeds: seeded.map((e) => e.id) },
    });
    // Проходы без игры (bye) первого раунда — сразу дальше.
    const byes = (await matchesOf(db, t.id)).filter((m) => m.bye && m.round === 1 && m.stage === 'playoff' && (m.entry_a || m.entry_b));
    for (const m of byes) await resolveBye(db, t, m, t0);
    for (const e of seeded) {
      await notifyUser(db, e.user_id, {
        kind: 'tournament.start',
        text: `Турнир «${t.title}» начался: ваш посев ${e.seed}`,
        data: { tournament_id: t.id },
        actions: [{ id: 'open', title: 'Сетка', url: `/app/tournaments/${t.id}` }],
      });
    }
    await schedule(db, t);
    await changed(db, t);
    return clubDetail(db, { clubId, tournamentId: t.id });
  }

  /** Следующий матч (через проходы без игры) уже идёт или сыгран. */
  function downstreamLocked(matches, nextId) {
    const next = nextId ? matches.find((x) => x.id === nextId) : null;
    if (!next) return false;
    if (next.bye) return downstreamLocked(matches, next.next_match_id);
    return LIVE.includes(next.status) || next.status === 'done';
  }

  /** Проход без игры: единственный участник пары — победитель (повтор с другим — замена дальше по сетке). */
  async function resolveBye(db, t, m, t0) {
    const winner = m.entry_a ?? m.entry_b;
    if (!winner || (m.status === 'done' && m.winner_entry_id === winner)) return;
    await db.query(
      `update bl.tournament_matches set status = 'done', winner_entry_id = $2, result_source = 'bye', finished_at = $3, updated_at = $3 where id = $1`,
      [m.id, winner, t0],
    );
    if (m.next_match_id) await placeInSlot(db, t, m.next_match_id, m.next_slot, winner, t0);
  }

  /** Победитель в слот следующего матча (замена, если организатор исправил результат). */
  async function placeInSlot(db, t, matchId, slot, entryId, t0) {
    const user = entryId ? (await db.query('select user_id from bl.tournament_entries where id = $1', [entryId])).rows[0]?.user_id ?? null : null;
    const col = slot === 'a' ? 'a' : 'b';
    const { rows } = await db.query(
      `update bl.tournament_matches set entry_${col} = $2, user_${col} = $3, updated_at = $4 where id = $1 returning *`,
      [matchId, entryId, user, t0],
    );
    const m = rows[0];
    if (m.bye && (m.entry_a || m.entry_b)) return resolveBye(db, t, m, t0);
    if (m.status === 'waiting' && m.entry_a && m.entry_b) {
      await db.query("update bl.tournament_matches set status = 'ready', updated_at = $2 where id = $1", [m.id, t0]);
      for (const u of [m.user_a, m.user_b]) {
        await userEvent(db, u, { type: 'tournament.match', tournament_id: t.id, match_id: m.id, status: 'scheduled' });
      }
    }
    return null;
  }

  /** Все матчи группы сыграны — места в плей-офф по таблицам групп. */
  async function maybeSeedPlayoff(db, t, t0) {
    const matches = await matchesOf(db, t.id);
    const group = matches.filter((m) => m.stage === 'group');
    if (group.length === 0 || group.some((m) => m.status !== 'done')) return;
    const playoff = matches.filter((m) => m.stage === 'playoff' && m.round === 1);
    if (playoff.some((m) => (m.src_a && m.entry_a) || (m.src_b && m.entry_b))) return;
    const entries = (await entriesOf(db, t.id)).filter((e) => e.status === 'confirmed');
    const places = new Map();
    for (let g = 0; g < t.group_count; g += 1) {
      const members = entries.filter((e) => e.group_no === g).map((e) => ({ id: e.id, seed: e.seed }));
      const table = groupStandings(members, group.filter((m) => m.group_no === g));
      for (const r of table) places.set(`g${g}p${r.place}`, r.id);
    }
    await audit(db, {
      action: 'tournament.groups_done',
      objectType: 'tournament',
      objectId: t.id,
      actorType: 'system',
      actorId: null,
      data: { tournament_id: t.id, qualified: Object.fromEntries([...places.entries()].filter(([k]) => Number(k.split('p')[1]) <= t.advance_per_group)) },
    });
    for (const m of playoff) {
      if (m.src_a) await placeInSlot(db, t, m.id, 'a', places.get(m.src_a) ?? null, t0);
      if (m.src_b) await placeInSlot(db, t, m.id, 'b', places.get(m.src_b) ?? null, t0);
    }
  }

  // --- Столы: удержание и свет (№138, №143) ---------------------------------------------------------------

  async function startLight(db, t, m) {
    const r = await savepoint(db, () => deps.light.startFromTournament(db, { resourceId: m.resource_id, matchId: m.id, system: true }));
    if (!r.ok) {
      log.warn('tournament_light_start_failed', { match_id: m.id, code: r.error?.code ?? null, error: r.error?.message });
      return null;
    }
    const sessionId = r.value?.session_id ?? null;
    if (isUuid(sessionId)) await db.query('update bl.tournament_matches set session_id = $2 where id = $1', [m.id, sessionId]);
    return sessionId;
  }

  async function stopLight(db, m) {
    if (!m.resource_id) return;
    if (m.session_id) {
      const r = await savepoint(db, () => deps.light.stopFromTournament(db, { resourceId: m.resource_id, matchId: m.id, system: true }));
      if (!r.ok) log.warn('tournament_light_stop_failed', { match_id: m.id, code: r.error?.code ?? null });
    }
    const c = await savepoint(db, () => deps.light.clearReserved(db, { resourceId: m.resource_id, source: 'tournament', refId: m.id }));
    if (!c.ok) log.warn('tournament_hold_clear_failed', { match_id: m.id, code: c.error?.code ?? null });
  }

  /** Стол матчу: удержание light (source tournament, refId = матч) и свет без оплаты. false — стол не дали. */
  async function assign(db, t, m, table, t0) {
    const until = new Date(t0.getTime() + t.match_minutes * MINUTE);
    const r = await savepoint(db, async () => {
      const out = await deps.light.setReserved(db, { resourceId: table.id, until: until.toISOString(), source: 'tournament', refId: m.id });
      if (out && out.applied === false && ['busy', 'service', 'pending', 'tournament'].includes(out.reason)) {
        throw new TournamentError('table_busy', out.reason);
      }
      return out;
    });
    if (!r.ok) {
      if (r.error?.code === 'not_configured') {
        log.warn('tournament_no_light', { match_id: m.id });
      } else {
        log.info('tournament_table_skipped', { match_id: m.id, resource_id: table.id, code: r.error?.code ?? null });
        return false;
      }
    }
    const { rows } = await db.query(
      `update bl.tournament_matches set resource_id = $2, status = 'playing', scheduled_at = $3, started_at = $3, hold_until = $4, updated_at = $3
        where id = $1 and status = 'ready' returning *`,
      [m.id, table.id, t0, until],
    );
    if (rows.length === 0) return false;
    const mm = rows[0];
    await audit(db, {
      action: 'tournament.match_start',
      objectType: 'tournament_match',
      objectId: m.id,
      actorType: 'system',
      actorId: null,
      data: { tournament_id: t.id, match_id: m.id, resource_id: table.id, hold_until: until.toISOString() },
    });
    await startLight(db, t, mm);
    for (const u of [mm.user_a, mm.user_b]) {
      await notifyUser(db, u, {
        kind: 'tournament.match',
        text: `Турнир «${t.title}»: ваш матч начинается, стол ${table.number}`,
        data: { tournament_id: t.id, match_id: m.id, table: table.number },
        actions: [{ id: 'open', title: 'Матч', url: `/app/tournaments/${t.id}` }],
      });
      await userEvent(db, u, { type: 'tournament.match', tournament_id: t.id, match_id: m.id, status: 'playing', table_number: table.number });
    }
    return true;
  }

  /** Готовым матчам — свободные столы турнира (игрок одновременно только в одном матче). */
  async function schedule(db, t) {
    if (t.status !== 'running') return 0;
    const t0 = now();
    const tables = await tablesOf(db, t.id);
    const matches = await matchesOf(db, t.id);
    const live = matches.filter((m) => LIVE.includes(m.status));
    const busyTables = new Set(live.map((m) => m.resource_id));
    const busyEntries = new Set(live.flatMap((m) => [m.entry_a, m.entry_b]));
    const skipped = new Set();
    let started = 0;
    for (const m of matches.filter((x) => x.status === 'ready')) {
      if (busyEntries.has(m.entry_a) || busyEntries.has(m.entry_b)) continue;
      const free = tables.filter((r) => !busyTables.has(r.id) && !skipped.has(r.id));
      if (free.length === 0) break;
      for (const table of free) {
        if (await assign(db, t, m, table, t0)) {
          busyTables.add(table.id);
          busyEntries.add(m.entry_a);
          busyEntries.add(m.entry_b);
          started += 1;
          break;
        }
        skipped.add(table.id);
      }
    }
    return started;
  }

  // --- Счёт ---------------------------------------------------------------------------------------------------

  async function matchClub(db, matchId) {
    if (!isUuid(matchId)) fail('not_found');
    const { rows } = await db.query('select club_id from bl.tournament_matches where id = $1', [matchId]);
    if (rows.length === 0) fail('not_found', 'match');
    return rows[0].club_id;
  }

  /** Блокировки всегда в порядке «турнир, затем матч» (как у планировщика): без взаимных блокировок. */
  async function lockTM(db, matchId) {
    const { rows } = await db.query('select tournament_id from bl.tournament_matches where id = $1', [matchId]);
    if (rows.length === 0) fail('not_found', 'match');
    const t = await loadT(db, rows[0].tournament_id, { lock: true });
    const m = await lockMatch(db, matchId);
    return { t, m };
  }

  async function lockMatch(db, matchId) {
    const { rows } = await db.query('select * from bl.tournament_matches where id = $1 for update', [matchId]);
    if (rows.length === 0) fail('not_found', 'match');
    return rows[0];
  }

  function readScore(body) {
    const a = body?.score_a;
    const b = body?.score_b;
    if (!Number.isInteger(a) || !Number.isInteger(b)) fail('bad_request', 'score');
    return { a, b };
  }

  /** Игрок вносит счёт. Совпал со счётом соперника — матч сыгран; расходится — спор организатору. */
  async function report(db, { matchId, userId, body }) {
    const clubId = await matchClub(db, matchId);
    await enterClub(db, clubId);
    const { t, m } = await lockTM(db, matchId);
    const sideMe = m.user_a === userId ? 'a' : m.user_b === userId ? 'b' : null;
    if (!sideMe) fail('forbidden', 'not_your_match');
    if (t.status !== 'running' || !LIVE.includes(m.status)) fail('bad_status', m.status);
    const { a, b } = readScore(body);
    if (!validScore(a, b, t.race_to)) fail('bad_score', `${a}:${b} до ${t.race_to}`);
    const t0 = now();
    const mine = { score_a: a, score_b: b, at: t0.toISOString() };
    const theirs = sideMe === 'a' ? m.report_b : m.report_a;
    await db.query(`update bl.tournament_matches set report_${sideMe} = $2::jsonb, updated_at = $3 where id = $1`, [m.id, JSON.stringify(mine), t0]);
    m[`report_${sideMe}`] = mine;
    await audit(db, {
      action: 'tournament.score_report',
      objectType: 'tournament_match',
      objectId: m.id,
      actorType: 'user',
      actorId: userId,
      data: { tournament_id: t.id, match_id: m.id, side: sideMe, score_a: a, score_b: b },
    });
    if (theirs && theirs.score_a === a && theirs.score_b === b) {
      await finalize(db, t, m, { a, b, source: 'players', t0, actorId: userId });
    } else if (theirs) {
      await dispute(db, t, m, t0);
    } else {
      await db.query("update bl.tournament_matches set status = 'pending_confirm', updated_at = $2 where id = $1", [m.id, t0]);
      const other = sideMe === 'a' ? m.user_b : m.user_a;
      await notifyUser(db, other, {
        kind: 'tournament.score',
        text: `Турнир «${t.title}»: соперник внёс счёт ${a}:${b} — подтвердите`,
        data: { tournament_id: t.id, match_id: m.id },
        actions: [{ id: 'open', title: 'Подтвердить', url: `/app/tournaments/${t.id}` }],
      });
      await userEvent(db, other, { type: 'tournament.match', tournament_id: t.id, match_id: m.id, status: 'pending_confirm' });
      await changed(db, t);
    }
    return matchState(db, m.id, userId);
  }

  /** Игрок подтверждает счёт соперника. */
  async function confirm(db, { matchId, userId }) {
    const clubId = await matchClub(db, matchId);
    await enterClub(db, clubId);
    const { t, m } = await lockTM(db, matchId);
    const sideMe = m.user_a === userId ? 'a' : m.user_b === userId ? 'b' : null;
    if (!sideMe) fail('forbidden', 'not_your_match');
    if (m.status === 'done') return matchState(db, m.id, userId);
    if (t.status !== 'running' || !LIVE.includes(m.status)) fail('bad_status', m.status);
    const theirs = sideMe === 'a' ? m.report_b : m.report_a;
    if (!theirs) fail('nothing_to_confirm');
    return report(db, { matchId, userId, body: { score_a: theirs.score_a, score_b: theirs.score_b } });
  }

  async function dispute(db, t, m, t0) {
    await db.query("update bl.tournament_matches set status = 'disputed', updated_at = $2 where id = $1", [m.id, t0]);
    const nums = await tableNumbers(db, t.club_id);
    await audit(db, {
      action: 'tournament.dispute',
      objectType: 'tournament_match',
      objectId: m.id,
      actorType: 'system',
      actorId: null,
      data: { tournament_id: t.id, match_id: m.id, report_a: m.report_a, report_b: m.report_b },
    });
    await notifyOrganizers(db, t.club_id, {
      kind: 'tournament.dispute',
      level: 'important',
      text: `Турнир «${t.title}»: игроки внесли разный счёт матча${m.resource_id ? ` на столе ${nums.get(m.resource_id) ?? ''}` : ''}. Решите в программе клуба.`,
      data: { tournament_id: t.id, match_id: m.id, url: `/club/tournaments/${t.id}` },
      actions: [{ id: 'open', title: 'Решить', url: `/club/tournaments/${t.id}` }],
    });
    for (const u of [m.user_a, m.user_b]) await userEvent(db, u, { type: 'tournament.match', tournament_id: t.id, match_id: m.id, status: 'disputed' });
    await changed(db, t);
  }

  /** Исправление организатора (управляющий, владелец) с причиной: журнал manual.tournament_score. */
  async function correct(db, { clubId, staffId, matchId, body }) {
    const reason = cleanReason(body?.reason);
    const { a, b } = readScore(body);
    const { t, m } = await lockTM(db, matchId);
    if (m.club_id !== clubId) fail('not_found');
    if (m.bye) fail('bad_status', 'bye');
    if (!['running', 'finished'].includes(t.status)) fail('bad_status', t.status);
    if (!LIVE.includes(m.status) && m.status !== 'done') fail('bad_status', m.status);
    if (!validScore(a, b, t.race_to)) fail('bad_score', `${a}:${b} до ${t.race_to}`);
    const t0 = now();
    const winner = a > b ? m.entry_a : m.entry_b;
    if (m.status === 'done') {
      const matches = await matchesOf(db, t.id);
      // Группа уже разведена по плей-офф — результат группы не меняется.
      if (m.stage === 'group' && matches.some((x) => x.stage === 'playoff' && ((x.src_a && x.entry_a) || (x.src_b && x.entry_b)))) fail('bracket_locked');
      // Победитель меняется, а следующий матч уже идёт или сыгран — сетку не переписываем.
      if (winner !== m.winner_entry_id && downstreamLocked(matches, m.next_match_id)) fail('bracket_locked');
    }
    await audit(db, {
      action: 'manual.tournament_score',
      objectType: 'tournament_match',
      objectId: m.id,
      actorType: 'user',
      actorId: staffId,
      reason,
      data: {
        tournament_id: t.id,
        match_id: m.id,
        before: { status: m.status, score_a: m.score_a, score_b: m.score_b, report_a: m.report_a, report_b: m.report_b },
        after: { score_a: a, score_b: b },
      },
    });
    await finalize(db, t, m, { a, b, source: 'organizer', t0, actorId: staffId });
    await notifyOrganizers(
      db,
      t.club_id,
      {
        kind: 'tournament.score_corrected',
        level: 'info',
        text: `Турнир «${t.title}»: организатор исправил счёт матча на ${a}:${b}`,
        data: { tournament_id: t.id, match_id: m.id, url: `/club/tournaments/${t.id}` },
      },
      ['owner'],
    );
    for (const u of [m.user_a, m.user_b]) {
      await notifyUser(db, u, { kind: 'tournament.score', text: `Турнир «${t.title}»: организатор установил счёт ${a}:${b}`, data: { tournament_id: t.id, match_id: m.id } });
    }
    return matchState(db, m.id, null);
  }

  /** Матч сыгран: счёт, свет, событие для рейтинга, продвижение по сетке, конец турнира. */
  async function finalize(db, t, m, { a, b, source, t0, actorId = null }) {
    const winner = a > b ? m.entry_a : m.entry_b;
    const loser = winner === m.entry_a ? m.entry_b : m.entry_a;
    const wasDone = m.status === 'done';
    const prevWinner = m.winner_entry_id;
    const revision = source === 'organizer' ? m.revision + 1 : m.revision;
    await db.query(
      `update bl.tournament_matches set score_a = $2, score_b = $3, winner_entry_id = $4, status = 'done', result_source = $5,
              revision = $6, finished_at = coalesce(finished_at, $7), updated_at = $7
        where id = $1`,
      [m.id, a, b, winner, source, revision, t0],
    );
    if (!wasDone) await stopLight(db, m);
    const users = new Map((await db.query('select id, user_id from bl.tournament_entries where id = any($1::uuid[])', [[winner, loser]])).rows.map((r) => [r.id, r.user_id]));
    await deps.outbox.enqueue(db, 'tournament.match_finished', {
      match_id: m.id,
      tournament_id: t.id,
      club_id: t.club_id,
      discipline: t.discipline,
      winner_id: users.get(winner) ?? null,
      loser_id: users.get(loser) ?? null,
      player_ids: [m.user_a, m.user_b],
      // Игроки сторон a и b (user_id): score_a — счёт player_a, score_b — счёт player_b.
      player_a: m.user_a,
      player_b: m.user_b,
      score: { winner: Math.max(a, b), loser: Math.min(a, b) },
      score_a: a,
      score_b: b,
      stage: m.stage,
      revision,
      // Исправление после «сыгран»: plus пересчитывает матч (идемпотентно по match_id и revision).
      corrected: wasDone,
      finished_at: iso(m.finished_at ?? t0),
    });
    await audit(db, {
      action: 'tournament.match_finished',
      objectType: 'tournament_match',
      objectId: m.id,
      actorType: actorId ? 'user' : 'system',
      actorId,
      data: { tournament_id: t.id, match_id: m.id, score_a: a, score_b: b, winner_entry_id: winner, source, revision },
    });
    for (const u of [m.user_a, m.user_b]) await userEvent(db, u, { type: 'tournament.match', tournament_id: t.id, match_id: m.id, status: 'done' });
    if (m.next_match_id && winner !== prevWinner) await placeInSlot(db, t, m.next_match_id, m.next_slot, winner, t0);
    if (m.stage === 'group') await maybeSeedPlayoff(db, t, t0);
    if (m.stage === 'playoff' && !m.next_match_id) await finish(db, t, winner, t0);
    await schedule(db, t);
    await changed(db, t);
  }

  async function finish(db, t, winnerEntryId, t0) {
    const first = t.status !== 'finished';
    await db.query(
      "update bl.tournaments set status = 'finished', winner_entry_id = $2, finished_at = coalesce(finished_at, $3), updated_at = $3 where id = $1",
      [t.id, winnerEntryId, t0],
    );
    t.status = 'finished';
    const entries = (await entriesOf(db, t.id)).filter((e) => e.status === 'confirmed');
    const winner = entries.find((e) => e.id === winnerEntryId);
    await audit(db, {
      action: first ? 'tournament.finish' : 'tournament.winner_corrected',
      objectType: 'tournament',
      objectId: t.id,
      actorType: 'system',
      actorId: null,
      data: { tournament_id: t.id, winner_entry_id: winnerEntryId },
    });
    if (first) {
      await deps.outbox.enqueue(db, 'tournament.finished', {
        tournament_id: t.id,
        club_id: t.club_id,
        discipline: t.discipline,
        winner_id: winner?.user_id ?? null,
        participants: entries.map((e) => e.user_id),
      });
    }
  }

  async function matchState(db, matchId, userId) {
    const m = (await db.query('select * from bl.tournament_matches where id = $1', [matchId])).rows[0];
    const nums = await tableNumbers(db, m.club_id);
    const entries = (await db.query('select * from bl.tournament_entries where id = any($1::uuid[])', [[m.entry_a, m.entry_b].filter(Boolean)])).rows;
    const byId = new Map(entries.map((e) => [e.id, e]));
    const sideMe = userId ? (m.user_a === userId ? 'a' : m.user_b === userId ? 'b' : null) : null;
    return {
      id: m.id,
      tournament_id: m.tournament_id,
      side: sideMe,
      a: byId.get(m.entry_a) ? { nick: displayNick(byId.get(m.entry_a)), seed: byId.get(m.entry_a).seed } : null,
      b: byId.get(m.entry_b) ? { nick: displayNick(byId.get(m.entry_b)), seed: byId.get(m.entry_b).seed } : null,
      table_number: m.resource_id ? (nums.get(m.resource_id) ?? null) : null,
      score_a: m.score_a,
      score_b: m.score_b,
      status: matchStatus(m.status),
      winner: m.winner_entry_id ? (m.winner_entry_id === m.entry_a ? 'a' : 'b') : null,
      report_a: m.report_a ?? null,
      report_b: m.report_b ?? null,
      i_confirmed: sideMe ? Boolean(m[`report_${sideMe}`]) : null,
      result_source: m.result_source,
      revision: m.revision,
    };
  }

  // --- Отмена турнира клубом -------------------------------------------------------------------------

  async function cancel(db, { clubId, staffId, tournamentId, reason: rawReason }) {
    const reason = cleanReason(rawReason);
    const t = await loadT(db, tournamentId, { lock: true });
    if (t.club_id !== clubId) fail('not_found');
    if (['finished', 'canceled'].includes(t.status)) fail('bad_status', t.status);
    const t0 = now();
    const live = (await db.query("select * from bl.tournament_entries where tournament_id = $1 and status <> 'canceled' for update", [t.id])).rows;
    let refunded = 0;
    for (const e of live) if (await cancelEntryRow(db, e, 'tournament_canceled', t0)) refunded += 1;
    for (const m of (await matchesOf(db, t.id)).filter((x) => LIVE.includes(x.status))) await stopLight(db, m);
    await db.query("update bl.tournaments set status = 'canceled', canceled_at = $2, entries_count = 0, updated_at = $2 where id = $1", [t.id, t0]);
    // Отмена — ручное действие (инвариант 8): причина в журнал, владельцу — сразу.
    await audit(db, {
      action: 'manual.tournament_cancel',
      objectType: 'tournament',
      objectId: t.id,
      actorType: 'user',
      actorId: staffId,
      reason,
      data: { tournament_id: t.id, from: t.status, entries: live.length, refunds: refunded },
    });
    const al = await savepoint(db, () =>
      deps.alarms.raise(db, t.club_id, {
        type: 'manual_action',
        level: 'important',
        manual: true,
        data: { tournament_id: t.id, action: 'tournament_cancel' },
        dedupeKey: `tournament_cancel:${t.id}`,
        text: `Турнир «${t.title}» отменён. Взносы вернутся участникам: ${refunded}`,
      }),
    );
    if (!al.ok) log.warn('tournament_alarm_failed', { error: al.error?.message });
    for (const e of live) {
      await notifyUser(db, e.user_id, {
        kind: 'tournament.canceled',
        level: 'important',
        text: Number(e.paid_kopecks) > 0 ? `Турнир «${t.title}» отменён клубом. Взнос вернём целиком` : `Турнир «${t.title}» отменён клубом`,
        data: { tournament_id: t.id },
      });
    }
    await changed(db, t);
    return { refunded };
  }

  // --- Планировщик -------------------------------------------------------------------------------------

  /** Один шаг по турниру (в контексте его клуба). */
  async function step(db, tournamentId) {
    const t = await loadT(db, tournamentId, { lock: true });
    const t0 = now();
    let touched = false;
    if (t.status === 'registration' && t0 >= t.registration_closes_at) {
      await db.query("update bl.tournaments set status = 'closed', updated_at = $2 where id = $1", [t.id, t0]);
      t.status = 'closed';
      await audit(db, { action: 'tournament.close', objectType: 'tournament', objectId: t.id, actorType: 'system', actorId: null, data: { tournament_id: t.id, auto: true } });
      touched = true;
    }
    const expired = await db.query(
      `update bl.tournament_entries set status = 'canceled', cancel_reason = 'payment_timeout', canceled_at = $2, updated_at = $2
        where tournament_id = $1 and status = 'pending_payment' and pay_until <= $2 returning id`,
      [t.id, t0],
    );
    if (expired.rowCount > 0) touched = true;
    if (t.status === 'running') {
      for (const m of (await matchesOf(db, t.id)).filter((x) => LIVE.includes(x.status))) {
        if (!m.session_id && m.hold_until && m.hold_until > t0 && m.status === 'playing') await startLight(db, t, m);
        // Матч ещё идёт у конца удержания — продлить (если light умеет).
        if (m.hold_until && m.hold_until.getTime() - t0.getTime() < EXTEND_BEFORE_MS) {
          const until = new Date(t0.getTime() + Math.max(15, Math.round(t.match_minutes / 2)) * MINUTE);
          if (typeof deps.light.extendFromTournament === 'function') {
            const r = await savepoint(db, () => deps.light.extendFromTournament(db, { resourceId: m.resource_id, matchId: m.id, until: until.toISOString() }));
            if (r.ok) await db.query('update bl.tournament_matches set hold_until = $2 where id = $1', [m.id, until]);
            else log.warn('tournament_extend_failed', { match_id: m.id, code: r.error?.code ?? null });
          } else if (m.hold_until > t0) {
            log.warn('tournament_extend_unavailable', { match_id: m.id });
          }
        }
      }
      if ((await schedule(db, t)) > 0) touched = true;
    }
    if (touched) await changed(db, t);
  }

  /**
   * Интервалы блокировки стола турниром (для броней и light, решение №146): всё окно турнира
   * (starts_at–ends_at) опубликованного турнира (registration, closed, running; черновик столы не держит)
   * на его столах и удержания идущих матчей (могут выйти за ends_at). [{ from, to, tournament_id, match_id? }].
   */
  async function holds(db, { resourceId, from, to }) {
    if (!isUuid(resourceId)) fail('bad_request', 'resourceId');
    const f = new Date(from);
    const u = new Date(to);
    if (Number.isNaN(f.getTime()) || Number.isNaN(u.getTime()) || u < f) fail('bad_request', 'interval');
    const { rows } = await db.query(
      `select t.id as tournament_id, null::uuid as match_id, t.starts_at as "from", t.ends_at as "to"
         from bl.tournaments t join bl.tournament_resources tr on tr.tournament_id = t.id
        where tr.resource_id = $1 and t.club_id = bl.ctx_club_id() and t.status in ('registration', 'closed', 'running')
          and t.starts_at < $3 and t.ends_at > $2
       union all
       select m.tournament_id, m.id, m.scheduled_at, m.hold_until
         from bl.tournament_matches m
        where m.resource_id = $1 and m.club_id = bl.ctx_club_id() and m.status in ('playing', 'pending_confirm', 'disputed')
          and m.scheduled_at < $3 and m.hold_until > $2
       order by 3`,
      [resourceId, f, u],
    );
    return rows.map((r) => ({ from: iso(r.from), to: iso(r.to), tournament_id: r.tournament_id, ...(r.match_id ? { match_id: r.match_id } : {}) }));
  }

  /**
   * Матч для рейтинга plus (×1,5): игроки (user_id), счёт, дисциплина. Только сыгранный матч с игрой
   * (не bye); иначе null. db — контекст клуба матча (обработчик outbox события турнира).
   */
  async function matchForRating(db, { matchId }) {
    if (!isUuid(matchId)) return null;
    const { rows } = await db.query(
      `select m.*, t.discipline from bl.tournament_matches m join bl.tournaments t on t.id = m.tournament_id
        where m.id = $1 and m.status = 'done' and not m.bye`,
      [matchId],
    );
    const m = rows[0];
    if (!m) return null;
    const winnerUser = m.winner_entry_id === m.entry_a ? m.user_a : m.user_b;
    return {
      match_id: m.id,
      tournament_id: m.tournament_id,
      club_id: m.club_id,
      discipline: m.discipline,
      player_a: m.user_a,
      player_b: m.user_b,
      score_a: m.score_a,
      score_b: m.score_b,
      winner_id: winnerUser,
      resource_id: m.resource_id,
      revision: m.revision,
      finished_at: iso(m.finished_at),
    };
  }

  return {
    matchForRating,
    clubOf,
    matchClub,
    enterClub,
    create,
    update,
    listClub,
    clubDetail,
    start,
    cancel,
    publicList,
    publicDetail,
    publicBracket,
    enter,
    withdraw,
    me,
    report,
    confirm,
    correct,
    onPaymentConfirmed,
    onRefund,
    step,
    holds,
    schedule,
    flush,
    OPEN,
  };
}
