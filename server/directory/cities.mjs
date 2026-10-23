// Справочник городов (оператор платформы, M4): GET/POST/PATCH /api/platform/cities.
// Слаг — транслит (уникален, после создания не меняется: адреса сайта /{город}/ в поиске),
// название в предложном падеже с предлогом (name_in, «в Екатеринбурге») — обязательно, пояс —
// IANA, который знает Intl (server/lib/timezone.mjs). Действия — в журнал платформы.

import { isValidTimeZone } from '../lib/timezone.mjs';
import { fail, iso, isUuid, text } from './common.mjs';
import { SLUG, slugify } from './slug.mjs';

/**
 * @param {{ deps: object, log: object, clock: { now(): Date } }} opts
 */
export function createCitiesService({ deps, log }) {
  function view(c) {
    return {
      id: c.id,
      slug: c.slug,
      name: c.name,
      name_in: c.name_in,
      region: c.region,
      timezone: c.timezone,
      active: c.active,
      clubs: c.clubs ?? 0,
      created_at: iso(c.created_at),
    };
  }

  async function load(db, id) {
    const { rows } = await db.query(
      `select c.*, (select count(*)::int from bl.club_public p where p.city_id = c.id) as clubs from bl.cities c where c.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  function fields(body = {}, { create }) {
    const out = {};
    if (body.name !== undefined || create) {
      out.name = text(body.name, 100);
      if (!out.name) fail('bad_request', 'name');
    }
    if (body.name_in !== undefined || create) {
      out.name_in = text(body.name_in, 120);
      if (!out.name_in || out.name_in.length < 3 || !/^(в|во|на)\s/i.test(out.name_in)) fail('bad_request', 'name_in');
    }
    if (body.region !== undefined) {
      out.region = body.region === null || body.region === '' ? null : text(body.region, 100);
      if (body.region && !out.region) fail('bad_request', 'region');
    }
    if (body.timezone !== undefined || create) {
      if (!isValidTimeZone(body.timezone)) fail('bad_request', 'timezone');
      out.timezone = body.timezone;
    }
    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') fail('bad_request', 'active');
      out.active = body.active;
    }
    return out;
  }

  /** GET /api/platform/cities → {items:[city]} (и неактивные). */
  async function list(db) {
    const { rows } = await db.query(
      `select c.*, (select count(*)::int from bl.club_public p where p.city_id = c.id) as clubs from bl.cities c order by c.active desc, c.name`,
    );
    return { items: rows.map(view) };
  }

  /** POST /api/platform/cities {slug?, name, name_in, region?, timezone, active?} → city. */
  async function create(db, { body }) {
    const f = fields(body, { create: true });
    const slug = body?.slug === undefined || body.slug === null || body.slug === '' ? slugify(f.name, 60) : body.slug;
    if (typeof slug !== 'string' || !SLUG.test(slug) || slug.length > 60) fail('bad_request', 'slug');
    const keys = Object.keys(f);
    let rows;
    try {
      ({ rows } = await db.query(
        `insert into bl.cities (slug, ${keys.join(', ')}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}) returning id`,
        [slug, ...keys.map((k) => f[k])],
      ));
    } catch (err) {
      if (err.code === '23505') fail('duplicate', 'slug города');
      throw err;
    }
    await deps.audit.appendAudit(db, { action: 'platform.city_create', objectType: 'city', objectId: rows[0].id, data: { city_id: rows[0].id, slug, name: f.name } });
    log.info('city_created', { city_id: rows[0].id, slug });
    return view(await load(db, rows[0].id));
  }

  /** PATCH /api/platform/cities/{id} {name?, name_in?, region?, timezone?, active?} — слаг не меняется. */
  async function patch(db, { id, body }) {
    if (!isUuid(id)) fail('not_found', 'city');
    if (body?.slug !== undefined) fail('bad_request', 'slug не меняется');
    const before = await load(db, id);
    if (!before) fail('not_found', 'city');
    const f = fields(body, { create: false });
    const keys = Object.keys(f);
    if (keys.length > 0) {
      await db.query(`update bl.cities set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1`, [id, ...keys.map((k) => f[k])]);
    }
    await deps.audit.appendAudit(db, { action: 'platform.city_update', objectType: 'city', objectId: id, data: { city_id: id, fields: keys } });
    return view(await load(db, id));
  }

  return { list, create, patch, load };
}
