// Карточки клубов (M4 §1 п. 3, решение №132): «Подтвердить клуб», «Добавить клуб» → оператору;
// карточка клуба в программе (GET/PATCH /api/clubs/{club}/listing); экран оператора: заявки на
// карточки и сами карточки. Наполнение только владельцами и командой с согласия клуба.

import { fail, iso, isUuid, loadCard, maskPhone, notifyPlatform, notifyUser, phone, text } from './common.mjs';
import { slugify, uniqueSlug } from './slug.mjs';

const URL_RE = /^https:\/\/[^\s<>"]{3,300}$/;
const TG_RE = /^https:\/\/t\.me\/[A-Za-z0-9_]{3,64}$/;
const DISC = ['pyramid', 'pool', 'snooker'];

/** Описательные поля карточки из тела запроса (клуб, оператор, «Добавить клуб»). */
export function cardFields(body = {}, { partial = true } = {}) {
  const out = {};
  const str = (k, max) => {
    if (body[k] === undefined) return;
    if (body[k] === null || body[k] === '') {
      out[k] = null;
      return;
    }
    const v = text(body[k], max);
    if (!v) fail('bad_request', k);
    out[k] = v;
  };
  if (body.name !== undefined) {
    const v = text(body.name, 200);
    if (!v) fail('bad_request', 'name');
    out.name = v;
  } else if (!partial) fail('bad_request', 'name');
  str('address', 300);
  str('hours_text', 300);
  str('description', 2000);
  if (body.phone !== undefined) {
    if (body.phone === null || body.phone === '') out.phone = null;
    else {
      out.phone = phone(body.phone);
      if (!out.phone) fail('bad_request', 'phone');
    }
  }
  for (const [k, re] of [['url', URL_RE], ['max_url', URL_RE], ['telegram_url', TG_RE]]) {
    if (body[k] === undefined) continue;
    if (body[k] === null || body[k] === '') out[k] = null;
    else if (typeof body[k] === 'string' && re.test(body[k])) out[k] = body[k];
    else fail('bad_request', k);
  }
  if (body.around_the_clock !== undefined) {
    if (typeof body.around_the_clock !== 'boolean') fail('bad_request', 'around_the_clock');
    out.around_the_clock = body.around_the_clock;
  }
  if (body.disciplines !== undefined) {
    if (!Array.isArray(body.disciplines) || body.disciplines.length > 3 || !body.disciplines.every((d) => DISC.includes(d))) fail('bad_request', 'disciplines');
    out.disciplines = [...new Set(body.disciplines)];
  }
  if (body.tables_count !== undefined) {
    if (body.tables_count !== null && (!Number.isInteger(body.tables_count) || body.tables_count < 1 || body.tables_count > 200)) fail('bad_request', 'tables_count');
    out.tables_count = body.tables_count;
  }
  if (body.price_from_kopecks !== undefined) {
    if (body.price_from_kopecks !== null && (!Number.isSafeInteger(body.price_from_kopecks) || body.price_from_kopecks < 0)) fail('bad_request', 'price_from_kopecks');
    out.price_from_kopecks = body.price_from_kopecks;
  }
  for (const k of ['lat', 'lng']) {
    if (body[k] === undefined) continue;
    const lim = k === 'lat' ? 90 : 180;
    if (body[k] !== null && (typeof body[k] !== 'number' || Math.abs(body[k]) > lim)) fail('bad_request', k);
    out[k] = body[k];
  }
  return out;
}

/**
 * @param {{ deps: object, log: object, clock: { now(): Date } }} opts
 */
export function createListingsService({ deps, log, clock, cities }) {
  const now = () => clock.now();

  function listingView(card) {
    return {
      id: card.id,
      status: card.status,
      name: card.name,
      city: card.city_name,
      city_slug: card.city_slug,
      slug: card.slug,
      path: `/${card.city_slug}/${card.slug}/`,
      address: card.address,
      phone: card.phone,
      description: card.description,
      hours_text: card.hours_text,
      around_the_clock: card.around_the_clock,
      url: card.url,
      max_url: card.max_url,
      telegram_url: card.telegram_url,
      disciplines: card.disciplines,
      tables_count: card.tables_count,
      price_from_kopecks: card.price_from_kopecks === null ? null : Number(card.price_from_kopecks),
      visible: card.visible,
      club_id: card.club_id,
      updated_at: iso(card.updated_at),
    };
  }

  async function updateCard(db, id, fields) {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    await db.query(
      `update bl.club_public set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = $${keys.length + 2} where id = $1`,
      [id, ...keys.map((k) => fields[k]), now()],
    );
  }

  // Клуб в программе ---------------------------------------------------------------------------

  async function clubCard(db, clubId) {
    const { rows } = await db.query('select id from bl.club_public where club_id = $1', [clubId]);
    return rows[0] ? loadCard(db, rows[0].id) : null;
  }

  /** GET /api/clubs/{club}/listing — владелец, управляющий. */
  async function getClubListing(db, { clubId }) {
    const card = await clubCard(db, clubId);
    if (!card) fail('not_found', 'listing');
    return listingView(card);
  }

  /** PATCH /api/clubs/{club}/listing {name, address, phone, description, hours_text, url, …}. */
  async function patchClubListing(db, { clubId, body }) {
    const card = await clubCard(db, clubId);
    if (!card) fail('not_found', 'listing');
    const fields = cardFields(body);
    delete fields.price_from_kopecks; // у клуба в программе цены — из тарифов
    await updateCard(db, card.id, fields);
    await deps.audit.appendAudit(db, { action: 'directory.listing_update', objectType: 'club_public', objectId: card.id, data: { fields: Object.keys(fields) } });
    return listingView(await loadCard(db, card.id));
  }

  // «Подтвердить клуб», «Добавить клуб» --------------------------------------------------------

  async function cityBySlugOrName(db, v) {
    if (typeof v !== 'string' || v.length > 100) return null;
    const { rows } = await db.query('select id, slug, name, timezone from bl.cities where active and (slug = $1 or lower(name) = lower($1)) limit 1', [v.trim()]);
    return rows[0] ?? null;
  }

  /** POST /api/directory/claim {listing_id, comment} → {id, status} — гость (владелец клуба). */
  async function claim(db, { userId, body }) {
    const card = await loadCard(db, body?.listing_id);
    if (!card || !card.visible) fail('not_found', 'listing');
    if (card.status !== 'listed') fail('already_claimed');
    const comment = body.comment ? text(body.comment, 1000) : null;
    if (body.comment && !comment) fail('bad_request', 'comment');
    const t = now();
    const { rows: prev } = await db.query(
      "select id from bl.directory_claims where kind = 'claim' and card_id = $1 and user_id = $2 and status = 'new'",
      [card.id, userId],
    );
    if (prev[0]) return { id: prev[0].id, status: 'new' };
    const { rows } = await db.query(
      `insert into bl.directory_claims (kind, card_id, user_id, user_phone, payload, status, created_at, updated_at)
       values ('claim', $1, $2, (select phone from bl.users where id = $2), $3::jsonb, 'new', $4, $4) returning id`,
      [card.id, userId, JSON.stringify({ comment }), t],
    );
    await notifyPlatform(db, deps, log, 'platform_operator', {
      kind: 'platform.listing_claim',
      text: `Подтвердить клуб: «${card.name}», ${card.city_name}.`,
      data: { claim_id: rows[0].id, listing_id: card.id },
      actions: [{ id: 'open', title: 'Карточки', url: '/club/platform/listings' }],
    });
    return { id: rows[0].id, status: 'new' };
  }

  /** POST /api/directory/add {city, name, address, phone, hours_text, url, disciplines, tables_count, comment}. */
  async function add(db, { userId, body }) {
    const fields = cardFields(body, { partial: false });
    const city = text(body?.city, 100);
    if (!city) fail('bad_request', 'city');
    if (!fields.address) fail('bad_request', 'address');
    const comment = body.comment ? text(body.comment, 1000) : null;
    const t = now();
    const { rows: mine } = await db.query(
      "select count(*)::int as n from bl.directory_claims where user_id = $1 and status = 'new'",
      [userId],
    );
    if (mine[0].n >= 5) fail('limit_exceeded', 'открытых заявок на карточки');
    const { rows } = await db.query(
      `insert into bl.directory_claims (kind, user_id, user_phone, payload, status, created_at, updated_at)
       values ('add', $1, (select phone from bl.users where id = $1), $2::jsonb, 'new', $3, $3) returning id`,
      [userId, JSON.stringify({ ...fields, city, comment }), t],
    );
    await notifyPlatform(db, deps, log, 'platform_operator', {
      kind: 'platform.listing_add',
      text: `Добавить клуб: «${fields.name}», ${city}.`,
      data: { claim_id: rows[0].id },
      actions: [{ id: 'open', title: 'Карточки', url: '/club/platform/listings' }],
    });
    return { id: rows[0].id, status: 'new' };
  }

  // Оператор платформы -----------------------------------------------------------------------

  async function claimView(db, c) {
    const card = c.card_id ? await loadCard(db, c.card_id) : null;
    return {
      id: c.id,
      kind: c.kind,
      status: c.status,
      listing: card ? { id: card.id, name: card.name, city: card.city_name, status: card.status, path: `/${card.city_slug}/${card.slug}/` } : null,
      payload: c.payload,
      user: { id: c.user_id, phone: c.user_phone ?? null, phone_masked: maskPhone(c.user_phone) },
      reason: c.reason ?? null,
      created_at: iso(c.created_at),
      updated_at: iso(c.updated_at),
    };
  }

  /** GET /api/platform/listings?status=new|approved|rejected → {items}. */
  async function listPlatform(db, { status }) {
    if (status !== undefined && !['new', 'approved', 'rejected'].includes(status)) fail('bad_request', 'status');
    const { rows } = await db.query(
      `select * from bl.directory_claims where ($1::text is null or status = $1) order by (status = 'new') desc, created_at desc limit 200`,
      [status ?? null],
    );
    const items = [];
    for (const c of rows) items.push(await claimView(db, c));
    return { items };
  }

  /** Причина автоматического отказа остальным заявкам на карточку, которую подтвердили (M4-4). */
  const CLAIMED_BY_OTHER = 'Права на этот клуб подтверждены другому заявителю.';

  /**
   * PATCH /api/platform/listings/{id} {action: 'approve'|'reject', reason, city_slug?, new_city?} — оператор.
   * Города нет в справочнике — 409 city_required (или new_city: {name, name_in, timezone, region?, slug?}).
   * claim → карточка claimed, контакт для заявок — заявитель; add → новая карточка listed.
   * Одобрить claim можно только пока карточка listed, иначе 409 already_claimed (M4-4); при одобрении
   * остальные открытые заявки claim на эту карточку отклоняются с причиной, заявителям — уведомление.
   */
  async function patchPlatform(db, { id, body, operatorId }) {
    if (!isUuid(id)) fail('not_found', 'claim');
    const { rows } = await db.query('select * from bl.directory_claims where id = $1 for update', [id]);
    const c = rows[0];
    if (!c) fail('not_found', 'claim');
    if (c.status !== 'new') fail('already_decided');
    const action = body?.action ?? body?.status;
    if (!['approve', 'reject', 'approved', 'rejected'].includes(action)) fail('bad_request', 'action');
    const reason = body.reason ? text(body.reason, 2000) : null;
    const t = now();
    let cardId = c.card_id;
    const approve = action === 'approve' || action === 'approved';
    let othersRejected = [];
    if (approve && c.kind === 'claim') {
      // Карточка — под блокировкой: два оператора не одобрят две заявки на одну карточку.
      const { rows: locked } = await db.query('select id, status from bl.club_public where id = $1 for update', [c.card_id]);
      const card = locked[0];
      if (!card) fail('not_found', 'listing');
      if (card.status !== 'listed') fail('already_claimed', card.status);
      await updateCard(db, card.id, { status: 'claimed', contact_user_id: c.user_id });
      const { rows: others } = await db.query(
        `update bl.directory_claims set status = 'rejected', operator_id = $3, reason = $4, updated_at = $5
          where kind = 'claim' and card_id = $1 and status = 'new' and id <> $2
          returning id, user_id`,
        [card.id, c.id, operatorId, CLAIMED_BY_OTHER, t],
      );
      othersRejected = others;
    }
    if (approve && c.kind === 'add') {
      const p = c.payload ?? {};
      let city = await cityBySlugOrName(db, body.city_slug ?? p.city);
      // Новый город: оператор создаёт его здесь же — {new_city: {name, name_in, timezone, region?, slug?}}.
      if (!city && body.new_city && cities) {
        const made = await cities.create(db, { body: body.new_city });
        city = await cityBySlugOrName(db, made.slug);
      }
      if (!city) fail('city_required', 'город не в справочнике: city_slug или new_city');
      const fields = cardFields(p, { partial: false });
      const slug = await uniqueSlug(fields.name, async (s) => (await db.query('select 1 from bl.club_public where city_id = $1 and slug = $2', [city.id, s])).rowCount > 0);
      const keys = Object.keys(fields);
      const ins = await db.query(
        `insert into bl.club_public (city_id, slug, status, contact_user_id, created_by, created_at, updated_at, ${keys.join(', ')})
         values ($1, $2, 'listed', $3, $3, $4, $4, ${keys.map((_, i) => `$${i + 5}`).join(', ')}) returning id`,
        [city.id, slug, c.user_id, t, ...keys.map((k) => fields[k])],
      );
      cardId = ins.rows[0].id;
    }
    await db.query(
      `update bl.directory_claims set status = $2, operator_id = $3, reason = $4, card_id = coalesce(card_id, $5), updated_at = $6 where id = $1`,
      [c.id, approve ? 'approved' : 'rejected', operatorId, reason, cardId, t],
    );
    await deps.audit.appendAudit(db, {
      action: approve ? 'platform.listing_approve' : 'platform.listing_reject',
      objectType: 'directory_claim',
      objectId: c.id,
      reason,
      data: { claim_id: c.id, kind: c.kind, listing_id: cardId },
    });
    await notifyUser(db, deps, log, c.user_id, {
        kind: 'directory.claim_decision',
        text: approve
          ? c.kind === 'claim' ? 'Права на карточку клуба подтверждены: заявки гостей будут приходить вам.' : 'Клуб добавлен в каталог Бильярдума.'
          : `Заявка на карточку клуба отклонена.${reason ? ` ${reason}` : ''}`,
        data: { claim_id: c.id, listing_id: cardId },
    });
    for (const o of othersRejected) {
      await deps.audit.appendAudit(db, {
        action: 'platform.listing_reject',
        objectType: 'directory_claim',
        objectId: o.id,
        reason: CLAIMED_BY_OTHER,
        data: { claim_id: o.id, kind: 'claim', listing_id: cardId, auto: true, approved_claim_id: c.id },
      });
      await notifyUser(db, deps, log, o.user_id, {
        kind: 'directory.claim_decision',
        text: `Заявка на карточку клуба отклонена. ${CLAIMED_BY_OTHER} Если это ваш клуб — напишите в поддержку Бильярдума.`,
        data: { claim_id: o.id, listing_id: cardId },
      });
    }
    const { rows: after } = await db.query('select * from bl.directory_claims where id = $1', [c.id]);
    return claimView(db, after[0]);
  }

  /**
   * POST /api/platform/cards — оператор заводит карточку с согласия клуба; PATCH /api/platform/cards/{id}
   * — поля, видимость, статус и привязка клуба программы (status platform, club_id).
   */
  async function createCard(db, { body, operatorId }) {
    const city = await cityBySlugOrName(db, body?.city_slug);
    if (!city) fail('bad_request', 'city_slug');
    const fields = cardFields(body, { partial: false });
    const slug = body.slug ?? (await uniqueSlug(fields.name, async (s) => (await db.query('select 1 from bl.club_public where city_id = $1 and slug = $2', [city.id, s])).rowCount > 0));
    if (typeof slug !== 'string' || slug !== slugify(slug, 80)) fail('bad_request', 'slug');
    const status = body.status ?? 'listed';
    if (!['listed', 'claimed', 'platform'].includes(status)) fail('bad_request', 'status');
    if (status === 'platform' && !isUuid(body.club_id)) fail('bad_request', 'club_id');
    const t = now();
    const keys = Object.keys(fields);
    let ins;
    try {
      ins = await db.query(
        `insert into bl.club_public (city_id, slug, status, club_id, created_by, created_at, updated_at, ${keys.join(', ')})
         values ($1, $2, $3, $4, $5, $6, $6, ${keys.map((_, i) => `$${i + 7}`).join(', ')}) returning id`,
        [city.id, slug, status, body.club_id ?? null, operatorId, t, ...keys.map((k) => fields[k])],
      );
    } catch (err) {
      if (err.code === '23505') fail('duplicate', 'slug или клуб');
      throw err;
    }
    await deps.audit.appendAudit(db, {
      action: 'platform.card_create', objectType: 'club_public', objectId: ins.rows[0].id,
      data: { listing_id: ins.rows[0].id, status, city: city.slug, slug },
    });
    return listingView(await loadCard(db, ins.rows[0].id));
  }

  async function patchCard(db, { id, body }) {
    const card = await loadCard(db, id);
    if (!card) fail('not_found', 'listing');
    const fields = cardFields(body);
    if (body.visible !== undefined) {
      if (typeof body.visible !== 'boolean') fail('bad_request', 'visible');
      fields.visible = body.visible;
    }
    if (body.status !== undefined) {
      if (!['listed', 'claimed', 'platform'].includes(body.status)) fail('bad_request', 'status');
      fields.status = body.status;
    }
    if (body.club_id !== undefined) {
      if (body.club_id !== null && !isUuid(body.club_id)) fail('bad_request', 'club_id');
      fields.club_id = body.club_id;
    }
    if ((fields.status ?? card.status) === 'platform' && !(fields.club_id ?? card.club_id)) fail('bad_request', 'club_id');
    try {
      await updateCard(db, card.id, fields);
    } catch (err) {
      if (err.code === '23505') fail('duplicate', 'клуб уже привязан');
      throw err;
    }
    await deps.audit.appendAudit(db, {
      action: 'platform.card_update', objectType: 'club_public', objectId: card.id,
      reason: body.reason ? String(body.reason).slice(0, 2000) : null,
      data: { listing_id: card.id, fields: Object.keys(fields) },
    });
    return listingView(await loadCard(db, card.id));
  }

  return { getClubListing, patchClubListing, claim, add, listPlatform, patchPlatform, createCard, patchCard, listingView };
}
