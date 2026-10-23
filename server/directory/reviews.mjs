// Отзывы о клубах (M4 §1 п. 12, решение №139). Оставить — только гость, у которого была игра
// (участник сессии) или бронь (начатая или завершённая) в этом клубе за последние 90 дней; один
// отзыв на гостя и клуб (повтор — изменение). Оценка 1–5, текст до 1 000 символов; телефоны и
// другие длинные номера в тексте маскируются (как в уведомлениях core). Клуб отвечает; жалоба —
// оператору платформы, он скрывает отзыв или оставляет.

import { maskPhones } from '../notify/index.mjs';
import { enterClub, fail, iso, isUuid, notifyPlatform, notifyUser, safely, text } from './common.mjs';

export const REVIEW_WINDOW_MS = 90 * 24 * 3600_000;

/**
 * @param {{ deps: object, log: object, clock: { now(): Date } }} opts
 */
export function createReviewsService({ deps, log, clock }) {
  const now = () => clock.now();

  async function nickOf(db, userId) {
    if (typeof deps.plus?.playerCard !== 'function') return null;
    return safely(db, async () => (await deps.plus.playerCard(db, { userId, viewerId: null }))?.nick ?? null, { log, what: 'plus.playerCard' });
  }

  /** Была ли у гостя игра или бронь в клубе за 90 дней (в контексте клуба). */
  async function eligible(db, clubId, userId, t) {
    const since = new Date(t.getTime() - REVIEW_WINDOW_MS);
    const { rows: s } = await db.query(
      `select 1 from bl.session_participants p join bl.sessions s on s.id = p.session_id
        where s.club_id = $1 and p.user_id = $2 and s.started_at >= $3 limit 1`,
      [clubId, userId, since],
    );
    if (s.length > 0) return true;
    const { rows: b } = await db.query(
      `select 1 from bl.bookings where club_id = $1 and (user_id = $2 or $2 = any (participants))
          and status in ('started', 'completed') and starts_at >= $3 limit 1`,
      [clubId, userId, since],
    );
    return b.length > 0;
  }

  function mine(r) {
    return r
      ? { id: r.id, club_id: r.club_id, rating: r.rating, text: r.text, status: r.status, created_at: iso(r.created_at), updated_at: iso(r.updated_at), reply: r.reply_text ? { text: r.reply_text, at: iso(r.replied_at) } : null }
      : null;
  }

  /** POST /api/reviews {club_id, rating, text} → review; 403 review_not_allowed. */
  async function upsert(db, { userId, body }) {
    const clubId = body?.club_id;
    if (!isUuid(clubId)) fail('bad_request', 'club_id');
    const rating = body.rating;
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) fail('bad_request', 'rating');
    let txt = null;
    if (body.text !== undefined && body.text !== null && body.text !== '') {
      txt = text(body.text, 1000);
      if (!txt) fail('bad_request', 'text');
      txt = maskPhones(txt).slice(0, 1000);
    }
    const { rows: c } = await db.query('select id, club_id from bl.club_public where club_id = $1', [clubId]);
    if (!c[0]) fail('not_found', 'club');
    await enterClub(db, clubId);
    const t = now();
    if (!(await eligible(db, clubId, userId, t))) fail('review_not_allowed', 'нет игры или брони за 90 дней', 403);
    const { rows } = await db.query(
      `insert into bl.reviews (card_id, club_id, user_id, rating, text, status, created_at, updated_at)
       values ($1, $2, $3, $4, $5, 'published', $6, $6)
       on conflict (club_id, user_id) do update set rating = excluded.rating, text = excluded.text, updated_at = excluded.updated_at
       returning *`,
      [c[0].id, clubId, userId, rating, txt, t],
    );
    await deps.audit.appendAudit(db, { action: 'review.save', objectType: 'review', objectId: rows[0].id, data: { review_id: rows[0].id, rating } });
    return mine(rows[0]);
  }

  /** GET /api/reviews/mine?club_id= → review | null. */
  async function getMine(db, { userId, clubId }) {
    if (!isUuid(clubId)) fail('bad_request', 'club_id');
    const { rows } = await db.query('select * from bl.reviews where club_id = $1 and user_id = $2', [clubId, userId]);
    return mine(rows[0] ?? null);
  }

  /** GET /api/clubs/{club}/reviews → {items:[{id, rating, text, author_nick, created_at, reply, reported, status}]}. */
  async function listClub(db, { clubId }) {
    const { rows } = await db.query(
      `select r.*, exists (select 1 from bl.review_reports x where x.review_id = r.id and x.status = 'new') as reported
         from bl.reviews r where r.club_id = $1 order by r.created_at desc limit 300`,
      [clubId],
    );
    const items = [];
    for (const r of rows) {
      items.push({
        id: r.id,
        rating: r.rating,
        text: r.text,
        author_nick: await nickOf(db, r.user_id),
        created_at: iso(r.created_at),
        reply: r.reply_text ? { text: r.reply_text, at: iso(r.replied_at) } : null,
        reported: r.reported,
        status: r.status,
      });
    }
    return { items };
  }

  /** POST /api/reviews/{id}/reply {text} — владелец или управляющий клуба (контекст клуба). */
  async function reply(db, { id, clubId, userId, body }) {
    if (!isUuid(id)) fail('not_found', 'review');
    const { rows } = await db.query('select * from bl.reviews where id = $1 and club_id = $2', [id, clubId]);
    const r = rows[0];
    if (!r) fail('not_found', 'review');
    if (r.user_id === userId) fail('forbidden', 'ответ на свой отзыв');
    let txt = null;
    if (body?.text !== null && body?.text !== '') {
      txt = text(body?.text, 1000);
      if (!txt) fail('bad_request', 'text');
      txt = maskPhones(txt).slice(0, 1000);
    }
    const t = now();
    const { rows: up } = await db.query(
      'update bl.reviews set reply_text = $2, replied_by = $3, replied_at = $4, updated_at = $4 where id = $1 returning *',
      [id, txt, txt ? userId : null, txt ? t : null],
    );
    await deps.audit.appendAudit(db, { action: 'review.reply', objectType: 'review', objectId: id, data: { review_id: id, removed: !txt } });
    if (txt) await notifyUser(db, deps, log, r.user_id, { kind: 'review.reply', text: 'Клуб ответил на ваш отзыв.', data: { review_id: id, club_id: clubId } });
    return { ...mine(up[0]), author_nick: await nickOf(db, r.user_id) };
  }

  /** POST /api/reviews/{id}/report {reason} — любой вошедший; контекст платформы (маршрут actor: system). */
  async function report(db, { id, reporterId, body }) {
    if (!isUuid(id)) fail('not_found', 'review');
    const reason = text(body?.reason, 1000);
    if (!reason) fail('reason_required');
    const { rows } = await db.query('select r.id, r.club_id, p.name from bl.reviews r join bl.club_public p on p.id = r.card_id where r.id = $1', [id]);
    if (!rows[0]) fail('not_found', 'review');
    const t = now();
    const ins = await db.query(
      `insert into bl.review_reports (review_id, club_id, reporter_id, reason, status, created_at, updated_at)
       values ($1, $2, $3, $4, 'new', $5, $5) on conflict do nothing returning id`,
      [id, rows[0].club_id, reporterId ?? null, maskPhones(reason), t],
    );
    if (ins.rows[0]) {
      await notifyPlatform(db, deps, log, 'platform_operator', {
        kind: 'platform.review_report',
        text: `Жалоба на отзыв о клубе «${rows[0].name}».`,
        data: { report_id: ins.rows[0].id, review_id: id },
        actions: [{ id: 'open', title: 'Жалобы', url: '/club/platform/reports' }],
      });
    }
    return { ok: true };
  }

  /** GET /api/platform/reports?status=new|hidden|kept → {items}. */
  async function listReports(db, { status }) {
    if (status !== undefined && !['new', 'hidden', 'kept'].includes(status)) fail('bad_request', 'status');
    const { rows } = await db.query(
      `select x.*, r.rating, r.text, r.status as review_status, r.reply_text, p.name as club_name
         from bl.review_reports x join bl.reviews r on r.id = x.review_id join bl.club_public p on p.id = r.card_id
        where ($1::text is null or x.status = $1) order by (x.status = 'new') desc, x.created_at desc limit 300`,
      [status ?? null],
    );
    return {
      items: rows.map((x) => ({
        id: x.id,
        status: x.status,
        reason: x.reason,
        review: { id: x.review_id, rating: x.rating, text: x.text, status: x.review_status, reply: x.reply_text, club: { id: x.club_id, name: x.club_name } },
        decision_reason: x.decision_reason ?? null,
        created_at: iso(x.created_at),
      })),
    };
  }

  /** PATCH /api/platform/reports/{id} {action: 'hide'|'keep', reason} — оператор. */
  async function patchReport(db, { id, body, operatorId }) {
    if (!isUuid(id)) fail('not_found', 'report');
    const action = body?.action ?? body?.status;
    if (!['hide', 'keep', 'hidden', 'kept'].includes(action)) fail('bad_request', 'action');
    const hide = action === 'hide' || action === 'hidden';
    const reason = body.reason ? text(body.reason, 2000) : null;
    if (hide && !reason) fail('reason_required');
    const { rows } = await db.query('select * from bl.review_reports where id = $1 for update', [id]);
    if (!rows[0]) fail('not_found', 'report');
    const t = now();
    await db.query(
      `update bl.review_reports set status = $2, operator_id = $3, decision_reason = $4, updated_at = $5
        where review_id = $1 and status = 'new'`,
      [rows[0].review_id, hide ? 'hidden' : 'kept', operatorId, reason, t],
    );
    await db.query('update bl.reviews set status = $2, updated_at = $3 where id = $1', [rows[0].review_id, hide ? 'hidden' : 'published', t]);
    await deps.audit.appendAudit(db, {
      action: hide ? 'platform.review_hide' : 'platform.review_keep',
      objectType: 'review',
      objectId: rows[0].review_id,
      reason,
      data: { review_id: rows[0].review_id, report_id: id },
    });
    return (await listReports(db, {})).items.find((x) => x.id === id);
  }

  return { upsert, getMine, listClub, reply, report, listReports, patchReport, eligible };
}
