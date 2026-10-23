// Заявка гостя в клуб без программы (T25, M4 §1 п. 4, решение №133).
//
// Гость (вход, телефон, согласие) просит стол у клуба со статусом listed/claimed. Заявка уходит
// клубу в его канал — уведомление контакту карточки (владелец, подтвердивший или добавивший
// клуб) с кнопкой «Ответить» по одноразовой ссылке. Нет ответа 15 минут (или у карточки нет
// контакта) — заявка уходит оператору платформы (status operator). Клуб отвечает по ссылке или
// через программу (если клуб в ней есть); оператор — с экрана платформы. Гость видит статус:
// sent | accepted | declined | operator | closed.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { formatDate, formatTime } from '@billiardum/shared/format';
import { fail, iso, isUuid, maskPhone, notifyPlatform, notifyUser, text } from './common.mjs';

export const ESCALATE_MS = 15 * 60_000;
export const TOKEN_MS = 24 * 3600_000;
export const MAX_OPEN_PER_GUEST = 3;
const OPEN = ['sent', 'operator'];

const sha = (s) => createHash('sha256').update(s).digest('hex');

/**
 * @param {{ deps: object, log: object, clock: { now(): Date } }} opts
 */
export function createRequestsService({ deps, log, clock }) {
  const now = () => clock.now();

  async function load(db, id) {
    if (!isUuid(id)) return null;
    const { rows } = await db.query(
      `select r.*, p.name as club_name, p.contact_user_id, p.status as card_status, c.name as city_name, c.timezone
         from bl.club_requests r join bl.club_public p on p.id = r.card_id join bl.cities c on c.id = p.city_id
        where r.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  function guestView(r) {
    return {
      id: r.id,
      status: r.status,
      club: { name: r.club_name },
      starts_at: iso(r.starts_at),
      minutes: r.minutes,
      people: r.people,
      answer_text: r.answer_text ?? null,
      updated_at: iso(r.updated_at),
    };
  }

  const when = (r) => `${formatDate(r.starts_at, r.timezone)} в ${formatTime(r.starts_at, r.timezone)}`;

  /** POST /api/clubs/requests {listing_id, starts_at, minutes, people, comment} → {id, status}. */
  async function create(db, { userId, body }) {
    const cardId = body?.listing_id;
    if (!isUuid(cardId)) fail('bad_request', 'listing_id');
    const startsAt = new Date(body.starts_at);
    if (typeof body.starts_at !== 'string' || Number.isNaN(startsAt.getTime())) fail('bad_request', 'starts_at');
    const t = now();
    if (startsAt.getTime() < t.getTime() - 5 * 60_000 || startsAt.getTime() > t.getTime() + 30 * 24 * 3600_000) fail('bad_request', 'starts_at');
    const minutes = body.minutes;
    if (!Number.isInteger(minutes) || minutes < 30 || minutes > 720) fail('bad_request', 'minutes');
    const people = body.people ?? 2;
    if (!Number.isInteger(people) || people < 1 || people > 20) fail('bad_request', 'people');
    const comment = body.comment === undefined || body.comment === null || body.comment === '' ? null : text(body.comment, 500);
    if (body.comment && !comment) fail('bad_request', 'comment');
    const { rows: cards } = await db.query(
      `select p.id, p.status, p.club_id, p.contact_user_id, p.name, c.timezone from bl.club_public p join bl.cities c on c.id = p.city_id
        where p.id = $1 and p.visible`,
      [cardId],
    );
    const card = cards[0];
    if (!card) fail('not_found', 'listing');
    // Клуб в программе — онлайн-бронь, не заявка.
    if (card.status === 'platform') fail('online_booking');
    await db.query("select pg_advisory_xact_lock(hashtextextended('bl.club_request.guest:' || $1, 0))", [userId]);
    const { rows: open } = await db.query(
      'select count(*)::int as n from bl.club_requests where user_id = $1 and status = any($2::text[])',
      [userId, OPEN],
    );
    if (open[0].n >= MAX_OPEN_PER_GUEST) fail('limit_exceeded', 'открытых заявок гостя');
    const { rows: me } = await db.query('select phone from bl.users where id = $1', [userId]);
    const token = randomBytes(32).toString('base64url');
    const hasContact = isUuid(card.contact_user_id);
    const { rows } = await db.query(
      `insert into bl.club_requests (card_id, club_id, user_id, guest_phone, starts_at, minutes, people, comment, status, token_hash,
                                     token_until, escalate_at, created_at, updated_at)
       values ($1, $2, $3, $12, $4, $5, $6, $7, 'sent', $8, $9, $10, $11, $11) returning id`,
      [
        card.id, card.club_id, userId, startsAt, minutes, people, comment, sha(token), new Date(t.getTime() + TOKEN_MS),
        hasContact ? new Date(t.getTime() + ESCALATE_MS) : t, t, me[0]?.phone ?? null,
      ],
    );
    const id = rows[0].id;
    if (hasContact) {
      const r = { starts_at: startsAt, timezone: card.timezone };
      await notifyUser(db, deps, log, card.contact_user_id, {
        kind: 'club.request',
        level: 'important',
        text: `Гость просит стол: ${when(r)}, ${minutes} мин, ${people} чел. Ответьте в течение 15 минут — иначе заявку возьмёт оператор Бильярдума.`,
        data: { request_id: id, listing_id: card.id },
        actions: [{ id: 'answer', title: 'Ответить на заявку', url: `/app/club-request/${id}?t=${token}` }],
      });
    }
    log.info('club_request_created', { request_id: id, listing_id: card.id, contact: hasContact });
    return { id, status: 'sent' };
  }

  /** GET /api/clubs/requests/{id} — гость, своя заявка. */
  async function get(db, { userId, id }) {
    const r = await load(db, id);
    if (!r || r.user_id !== userId) fail('not_found', 'request');
    return guestView(r);
  }

  /** GET /api/clubs/requests — свои заявки гостя (последние 20). */
  async function listMine(db, { userId }) {
    const { rows } = await db.query('select id from bl.club_requests where user_id = $1 order by created_at desc limit 20', [userId]);
    const out = [];
    for (const x of rows) out.push(guestView(await load(db, x.id)));
    return { items: out };
  }

  /** POST /api/clubs/requests/{id}/cancel — гость отменяет свою открытую заявку. */
  async function cancel(db, { userId, id }) {
    const r = await load(db, id);
    if (!r || r.user_id !== userId) fail('not_found', 'request');
    if (!OPEN.includes(r.status)) return guestView(r);
    return guestView(await decide(db, r, { decision: 'close', via: 'guest' }));
  }

  /** Ответ клуба или оператора: accepted | declined | closed; гостю уведомление. */
  async function decide(db, r, { decision, answer, via, operatorId = null }) {
    const map = { accept: 'accepted', decline: 'declined', close: 'closed', accepted: 'accepted', declined: 'declined', closed: 'closed' };
    const status = map[decision];
    if (!status) fail('bad_request', 'decision');
    if (!OPEN.includes(r.status)) fail('request_closed');
    const t = now();
    const answerText = answer === undefined || answer === null || answer === '' ? null : text(answer, 500);
    if (answer && !answerText) fail('bad_request', 'text');
    await db.query(
      `update bl.club_requests set status = $2, answer_text = $3, answered_via = $4, answered_at = $5, operator_id = coalesce($6, operator_id),
              token_hash = null, token_until = null, updated_at = $5 where id = $1`,
      [r.id, status, answerText, via, t, operatorId],
    );
    const nr = await load(db, r.id);
    const words = { accepted: 'принял', declined: 'не может принять', closed: 'закрыл' };
    if (via !== 'guest') {
      await notifyUser(db, deps, log, r.user_id, {
        kind: 'club.request_answer',
        level: 'important',
        text: `Клуб «${r.club_name}» ${words[status]} заявку на ${when(r)}.${answerText ? ` ${answerText}` : ''}`,
        data: { request_id: r.id, status },
        actions: [{ id: 'open', title: 'Заявка', url: `/app/request/${r.card_id}?request=${r.id}` }],
      });
    }
    log.info('club_request_answered', { request_id: r.id, status, via });
    return nr;
  }

  /** Проверка одноразового токена ссылки клуба. */
  function tokenOk(r, token, t) {
    if (!r?.token_hash || typeof token !== 'string' || token.length < 20 || token.length > 100) return false;
    if (!r.token_until || new Date(r.token_until) <= t) return false;
    const a = Buffer.from(sha(token), 'hex');
    const b = Buffer.from(r.token_hash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * GET /api/clubs/requests/{id}/answer?t= — клуб по ссылке из уведомления (без входа, контекст
   * платформы): заявка с телефоном гостя — клубу нужно с ним связаться.
   */
  async function byToken(db, { id, token }) {
    const r = await load(db, id);
    if (!r || !tokenOk(r, token, now())) fail('not_found', 'request');
    return {
      id: r.id,
      status: r.status,
      club: { name: r.club_name },
      starts_at: iso(r.starts_at),
      minutes: r.minutes,
      people: r.people,
      comment: r.comment ?? null,
      guest_phone: r.guest_phone ?? null,
      created_at: iso(r.created_at),
    };
  }

  /** POST /api/clubs/requests/{id}/answer {t, decision: 'accept'|'decline', text?} — ответ клуба по ссылке. */
  async function answerByToken(db, { id, body }) {
    const r = await load(db, id);
    if (!r || !tokenOk(r, body?.t, now())) fail('not_found', 'request');
    if (!['accept', 'decline'].includes(body.decision)) fail('bad_request', 'decision');
    const nr = await decide(db, r, { decision: body.decision, answer: body.text, via: 'link' });
    await deps.audit.appendAudit(db, {
      action: 'directory.request_answer',
      objectType: 'club_request',
      objectId: r.id,
      actorType: 'system',
      data: { request_id: r.id, status: nr.status, via: 'link' },
    });
    return guestView(nr);
  }

  /** Клуб через программу: GET /api/clubs/{club}/requests, POST …/{id}/answer. */
  async function listClub(db, { clubId }) {
    const { rows } = await db.query('select id from bl.club_requests where club_id = $1 order by created_at desc limit 100', [clubId]);
    const items = [];
    for (const x of rows) {
      const r = await load(db, x.id);
      items.push({ ...guestView(r), comment: r.comment ?? null });
    }
    return { items };
  }

  async function answerByClub(db, { clubId, id, body }) {
    const r = await load(db, id);
    if (!r || r.club_id !== clubId) fail('not_found', 'request');
    if (!['accept', 'decline'].includes(body?.decision)) fail('bad_request', 'decision');
    const nr = await decide(db, r, { decision: body.decision, answer: body.text, via: 'program' });
    await deps.audit.appendAudit(db, { action: 'directory.request_answer', objectType: 'club_request', objectId: r.id, data: { request_id: r.id, status: nr.status, via: 'program' } });
    return guestView(nr);
  }

  // Оператор платформы ------------------------------------------------------------------------

  async function operatorView(db, r) {
    return {
      id: r.id,
      status: r.status,
      listing: { id: r.card_id, name: r.club_name, city: r.city_name, status: r.card_status },
      starts_at: iso(r.starts_at),
      minutes: r.minutes,
      people: r.people,
      comment: r.comment ?? null,
      guest: { phone: r.guest_phone ?? null, phone_masked: maskPhone(r.guest_phone) },
      answer_text: r.answer_text ?? null,
      answered_via: r.answered_via ?? null,
      escalated_at: iso(r.escalated_at),
      created_at: iso(r.created_at),
      updated_at: iso(r.updated_at),
    };
  }

  /** GET /api/platform/requests?status= → {items}. */
  async function listPlatform(db, { status }) {
    if (status !== undefined && !['sent', 'accepted', 'declined', 'operator', 'closed'].includes(status)) fail('bad_request', 'status');
    const { rows } = await db.query(
      `select id from bl.club_requests where ($1::text is null or status = $1) order by (status = 'operator') desc, created_at desc limit 200`,
      [status ?? null],
    );
    const items = [];
    for (const x of rows) items.push(await operatorView(db, await load(db, x.id)));
    return { items };
  }

  /** PATCH /api/platform/requests/{id} {status: accepted|declined|closed, reason} — оператор. */
  async function patchPlatform(db, { id, body, operatorId }) {
    const r = await load(db, id);
    if (!r) fail('not_found', 'request');
    const nr = await decide(db, r, { decision: body?.status ?? body?.action, answer: body?.reason ?? body?.answer_text, via: 'operator', operatorId });
    await deps.audit.appendAudit(db, {
      action: 'platform.request_answer',
      objectType: 'club_request',
      objectId: r.id,
      reason: body?.reason ?? null,
      data: { request_id: r.id, status: nr.status },
    });
    return operatorView(db, nr);
  }

  /** Планировщик (контекст платформы): без ответа 15 минут — оператору, гостю — статус. */
  async function escalateDue(db) {
    const t = now();
    const { rows } = await db.query(
      `select id from bl.club_requests where status = 'sent' and escalate_at <= $1 order by escalate_at limit 100 for update skip locked`,
      [t],
    );
    for (const x of rows) {
      const r = await load(db, x.id);
      await db.query(`update bl.club_requests set status = 'operator', escalated_at = $2, updated_at = $2 where id = $1 and status = 'sent'`, [r.id, t]);
      await notifyPlatform(db, deps, log, 'platform_operator', {
        kind: 'platform.club_request',
        level: 'important',
        text: `Заявка гостя в клуб «${r.club_name}» (${r.city_name}) на ${when(r)}: клуб не ответил${r.contact_user_id ? ' за 15 минут' : ' — нет контакта'}.`,
        data: { request_id: r.id },
        actions: [{ id: 'open', title: 'Заявки', url: '/club/platform/requests' }],
      });
      await notifyUser(db, deps, log, r.user_id, {
        kind: 'club.request_operator',
        text: `Клуб «${r.club_name}» пока не ответил — заявкой занялся оператор Бильярдума.`,
        data: { request_id: r.id, status: 'operator' },
      });
      await deps.audit.appendAudit(db, { action: 'directory.request_escalate', objectType: 'club_request', objectId: r.id, actorType: 'system', data: { request_id: r.id } });
      log.info('club_request_escalated', { request_id: r.id });
    }
    return rows.length;
  }

  return { create, get, listMine, cancel, decide, byToken, answerByToken, listClub, answerByClub, listPlatform, patchPlatform, escalateDue, guestView, load };
}
