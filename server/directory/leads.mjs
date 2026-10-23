// Заявки клубов на программу (`leads`, M4 §1 п. 6, решение №135): форма /dlya-klubov/ без входа →
// запись, уведомление Андрею (platform_admin) по цепочке уведомлений; статус воронки — оператор и
// администратор. Защита от спама без внешних капч: лимит по IP (маршрут и база — по хешу IP),
// скрытое поле и время заполнения формы. IP не хранится — только sha256 с секретом сервера.

import { createHash } from 'node:crypto';
import { plural } from '@billiardum/shared/format';
import { fail, iso, isUuid, notifyPlatform, phone, text } from './common.mjs';

export const MIN_FILL_MS = 3_000;
export const IP_DAY_LIMIT = 5;
const STATUSES = ['new', 'contacted', 'demo', 'won', 'lost', 'spam'];
/** Вид заявки: program — на программу (сайт, M4), kit — заказ комплекта контроллеров (мастер, M5.1 №159). */
export const LEAD_KINDS = ['program', 'kit'];

/**
 * @param {{ deps: object, log: object, clock: { now(): Date }, config: object }} opts
 */
export function createLeadsService({ deps, log, clock, config }) {
  const pepper = config?.encKey ? Buffer.from(config.encKey).toString('hex') : 'bl-leads';
  const ipHash = (ip) => createHash('sha256').update(`bl.leads:${pepper}:${ip ?? ''}`).digest('hex');

  /**
   * POST /api/leads {kind?: 'program'|'kit', name, club_name, city, phone, tables_count?, comment?, consent: true,
   *                  website (скрытое поле, пустое), elapsed_ms (сколько заполняли форму)} → 201 {ok: true}.
   * kind 'kit' — «Заказать комплект» из мастера подключения: tables_count — сколько столов оснастить.
   * Бот (заполнено скрытое поле, форма заполнена быстрее 3 с) получает тот же ответ, запись не делается.
   */
  async function create(db, { body, ip }) {
    const b = body ?? {};
    const kind = b.kind === undefined || b.kind === null ? 'program' : b.kind;
    if (!LEAD_KINDS.includes(kind)) fail('bad_request', 'kind');
    if (b.consent !== true) fail('consent_required', 'согласие', 403);
    const honeypot = typeof b.website === 'string' && b.website.trim() !== '';
    const elapsed = Number(b.elapsed_ms);
    if (honeypot || !Number.isFinite(elapsed) || elapsed < MIN_FILL_MS) {
      log.info('lead_spam_dropped', { reason: honeypot ? 'honeypot' : 'too_fast' });
      return { ok: true };
    }
    const name = text(b.name, 100);
    const clubName = text(b.club_name, 200);
    const city = text(b.city, 100);
    const tel = phone(b.phone);
    if (!name) fail('bad_request', 'name');
    if (!clubName) fail('bad_request', 'club_name');
    if (!city) fail('bad_request', 'city');
    if (!tel) fail('bad_request', 'phone');
    const tables = b.tables_count === undefined || b.tables_count === null ? null : b.tables_count;
    if (tables !== null && (!Number.isInteger(tables) || tables < 1 || tables > 200)) fail('bad_request', 'tables_count');
    const comment = b.comment ? text(b.comment, 1000) : null;
    if (b.comment && !comment) fail('bad_request', 'comment');
    const t = clock.now();
    const hash = ipHash(ip);
    const { rows: recent } = await db.query(
      'select count(*)::int as n from bl.leads where ip_hash = $1 and created_at > $2',
      [hash, new Date(t.getTime() - 24 * 3600_000)],
    );
    if (recent[0].n >= IP_DAY_LIMIT) fail('rate_limited', 'заявок с IP за сутки', 429);
    const { rows } = await db.query(
      `insert into bl.leads (kind, name, club_name, city, phone, tables_count, comment, consent_version, ip_hash, status, created_at, updated_at)
       values ($10, $1, $2, $3, $4, $5, $6, $7, $8, 'new', $9, $9) returning id`,
      [name, clubName, city, tel, tables, comment, config?.consentVersion ?? 'site', hash, t, kind],
    );
    await deps.audit.appendAudit(db, { action: 'platform.lead_create', objectType: 'lead', objectId: rows[0].id, actorType: 'system', data: { lead_id: rows[0].id, city, kind } });
    const what = kind === 'kit' ? 'Заказ комплекта контроллеров' : 'Заявка на программу';
    // Андрею: без телефона в тексте (маскируется core), телефон — на экране оператора.
    await notifyPlatform(db, deps, log, 'platform_admin', {
      kind: 'platform.lead',
      level: 'important',
      // Без сокращения «ст.» и точки после имени: иначе «8 ст..» и «Иван И..» (Д10 приёмки M4).
      text: `${what}: «${clubName}», ${city}${tables ? `, ${tables} ${plural(tables, ['стол', 'стола', 'столов'])}` : ''}. Контакт — ${name.replace(/[.\s]+$/u, '')}.`,
      data: { lead_id: rows[0].id },
      actions: [{ id: 'open', title: 'Заявки клубов', url: '/club/platform/leads' }],
    });
    log.info('lead_created', { lead_id: rows[0].id, kind });
    return { ok: true };
  }

  function view(l) {
    return {
      id: l.id,
      kind: l.kind ?? 'program',
      name: l.name,
      club_name: l.club_name,
      city: l.city,
      phone: l.phone,
      tables_count: l.tables_count,
      comment: l.comment,
      status: l.status,
      note: l.note,
      created_at: iso(l.created_at),
      updated_at: iso(l.updated_at),
    };
  }

  /** GET /api/platform/leads?status=&kind= → {items}. */
  async function list(db, { status, kind }) {
    if (status !== undefined && !STATUSES.includes(status)) fail('bad_request', 'status');
    if (kind !== undefined && !LEAD_KINDS.includes(kind)) fail('bad_request', 'kind');
    const { rows } = await db.query(
      `select * from bl.leads where ($1::text is null or status = $1) and ($2::text is null or kind = $2) order by created_at desc limit 300`,
      [status ?? null, kind ?? null],
    );
    return { items: rows.map(view) };
  }

  /** PATCH /api/platform/leads/{id} {status, reason|note}. */
  async function patch(db, { id, body }) {
    if (!isUuid(id)) fail('not_found', 'lead');
    const status = body?.status;
    if (status !== undefined && !STATUSES.includes(status)) fail('bad_request', 'status');
    const note = body?.note ?? body?.reason;
    const n = note === undefined ? undefined : note === null || note === '' ? null : text(note, 2000);
    if (note && !n) fail('bad_request', 'note');
    const { rows } = await db.query(
      `update bl.leads set status = coalesce($2, status), note = case when $4 then $3 else note end, updated_at = $5 where id = $1 returning *`,
      [id, status ?? null, n ?? null, n !== undefined, clock.now()],
    );
    if (!rows[0]) fail('not_found', 'lead');
    await deps.audit.appendAudit(db, {
      action: 'platform.lead_update', objectType: 'lead', objectId: id, data: { lead_id: id, status: rows[0].status },
    });
    return view(rows[0]);
  }

  return { create, list, patch };
}
