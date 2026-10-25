// Публичный API сайта-агрегатора (M4 §1 п. 1–3, §3, §4): города, каталог города с фильтрами,
// страница клуба. Без входа и без персональных данных: только данные карточек, план зала и
// «свободно сейчас» (light), цены из тарифов (клубы в программе), турниры, опубликованные отзывы
// без авторов-людей (ник Бильярдум+, если есть). Ответы /api/public/* кэширует роутер на 60 с
// (сайт тоже кэширует 60 с, №131).

import { DISCIPLINES, enterClub, fail, iso, RESOURCE_DISCIPLINE, safely } from './common.mjs';
import { familyOf, TYPE_TO_KIND } from '../lib/resource-kinds.mjs';
import { SLUG } from './slug.mjs';

const SORTS = ['recommended', 'free', 'price', 'rating', 'name'];

const hhmm = (t) => String(t).slice(0, 5);

/**
 * @param {{ deps: object, log: object, clock: { now(): Date } }} opts
 */
export function createPublicService({ deps, log, clock }) {
  // Кэш ответов /api/public/* на 60 с держит роутер (core): один ответ всем анонимным GET.
  const cached = (_key, fn) => fn();

  // Живые данные клуба в программе (контекст клуба на время запроса) -------------------------

  /** Столы клуба: план и статус без ПДн. Вызывается в контексте клуба. */
  async function liveTables(db, clubId) {
    const { rows: res } = await db.query(
      `select id, number, type, title, plan_x, plan_y, plan_rotation from bl.resources where club_id = $1 and active order by bl.resource_family(type) desc, number`,
      [clubId],
    );
    const tables = [];
    for (const r of res) {
      const st = (typeof deps.sessions?.getResourceStatus === 'function'
        ? await safely(db, () => deps.sessions.getResourceStatus(db, r.id), { log, what: 'light.getResourceStatus' })
        : null) ?? { status: 'unknown', busy_until: null };
      let status = 'unavailable';
      if (st.status === 'free') status = 'free';
      else if (st.status === 'busy') status = 'busy';
      else if (st.status === 'reserved' || st.status === 'pending') status = 'reserved';
      tables.push({
        id: r.id,
        number: r.number,
        title: r.title,
        discipline: RESOURCE_DISCIPLINE[r.type] ?? null,
        // Вид ресурса (M5.8 T48): «Стол 3» или «Корт 1» на плане зала сайта.
        kind: TYPE_TO_KIND[r.type] ?? null,
        family: familyOf(r.type),
        plan: { x: r.plan_x, y: r.plan_y, rotation: r.plan_rotation },
        status,
        busy_until: status === 'busy' ? iso(st.busy_until) : null,
      });
    }
    return tables;
  }

  /** Цены клуба по тарифам: по дисциплинам, дням (ISO 1–7) и часам местного времени. */
  async function clubPrices(db, clubId) {
    const { rows } = await db.query(
      `select r.resource_type, r.days, r.start_local::text as start_local, r.end_local::text as end_local, r.price_per_hour,
              r.min_minutes, r.slot_minutes, r.price_per_slot
         from bl.tariff_rules r
        where r.club_id = $1 and r.active and r.resource_type is not null
          and exists (select 1 from bl.resources x where x.club_id = r.club_id and x.active and x.type = r.resource_type)
        order by r.resource_type, r.days[1], r.start_local`,
      [clubId],
    );
    return rows.map((r) => ({
      discipline: RESOURCE_DISCIPLINE[r.resource_type],
      days: r.days.map(Number),
      from: hhmm(r.start_local),
      to: hhmm(r.end_local),
      price_per_hour_kopecks: Number(r.price_per_hour),
      min_minutes: r.min_minutes,
      // Корт (M5.8 №204): цена за слот; price_per_hour_kopecks у него справочная.
      ...(r.slot_minutes === null ? {} : { slot_minutes: r.slot_minutes, price_per_slot_kopecks: Number(r.price_per_slot) }),
    }));
  }

  /**
   * Свободно сейчас и план зала клуба в программе (контракт §3: clubLiveStatus). Переводит
   * транзакцию в контекст клуба и обратно в прежний.
   */
  async function clubLiveStatus(db, { clubId }) {
    const { rows: cur } = await db.query("select nullif(current_setting('app.club_id', true), '') as c");
    await enterClub(db, clubId);
    try {
      const tables = await liveTables(db, clubId);
      const { rows } = await db.query('select settings from bl.clubs where id = $1', [clubId]);
      const plan = rows[0]?.settings?.plan;
      // Столы и корты (M5.8): free_now и total — как раньше по столам бильярда; корты — отдельно.
      const isTable = (x) => x.family !== 'court';
      return {
        updated_at: iso(clock.now()),
        free_now: tables.filter((x) => isTable(x) && x.status === 'free').length,
        total: tables.filter(isTable).length,
        courts_free_now: tables.filter((x) => !isTable(x) && x.status === 'free').length,
        courts_total: tables.filter((x) => !isTable(x)).length,
        plan: plan && typeof plan === 'object' ? { width_cm: plan.width_cm ?? null, height_cm: plan.height_cm ?? null } : null,
        tables,
      };
    } finally {
      await enterClub(db, cur[0].c);
    }
  }

  async function ratingsOf(db, cardIds) {
    if (cardIds.length === 0) return new Map();
    const { rows } = await db.query(
      `select card_id, round(avg(rating)::numeric, 1)::float as avg, count(*)::int as n
         from bl.reviews where card_id = any($1::uuid[]) and status = 'published' group by card_id`,
      [cardIds],
    );
    return new Map(rows.map((r) => [r.card_id, { avg: r.avg, count: r.n }]));
  }

  /**
   * Карточка клуба в программе с живыми данными: status platform и клуб в боевом режиме (M5.1 №153:
   * тестовый или приостановленный клуб на публичных страницах — как карточка без программы).
   */
  const onPlatform = (card) => card.status === 'platform' && Boolean(card.club_id) && card.club_mode === 'live';
  const publicStatus = (card) => (card.status === 'platform' && !onPlatform(card) ? 'claimed' : card.status);

  /** Краткая карточка для каталога города. */
  async function summary(db, card, rating) {
    let live = null;
    let priceFrom = card.price_from_kopecks === null ? null : Number(card.price_from_kopecks);
    let disciplines = card.disciplines;
    let courtPriceFrom = null;
    let slotMinutes = null;
    if (onPlatform(card)) {
      live = await clubLiveStatus(db, { clubId: card.club_id });
      await enterClub(db, card.club_id);
      try {
        const prices = await clubPrices(db, card.club_id);
        // «Цена от» — за час стола; у кортов — своя «от» за слот (M5.8).
        const hourly = prices.filter((p) => !p.slot_minutes);
        const slots = prices.filter((p) => p.slot_minutes);
        if (hourly.length > 0) priceFrom = Math.min(...hourly.map((p) => p.price_per_hour_kopecks));
        if (slots.length > 0) {
          courtPriceFrom = Math.min(...slots.map((p) => p.price_per_slot_kopecks));
          slotMinutes = slots[0].slot_minutes;
        }
        const ds = [...new Set(live.tables.map((x) => x.discipline).filter(Boolean))];
        if (ds.length > 0) disciplines = ds;
      } finally {
        await enterClub(db, null);
      }
    }
    return {
      id: card.id,
      slug: card.slug,
      path: `/${card.city_slug}/${card.slug}/`,
      name: card.name,
      status: publicStatus(card),
      // Клуб программы (рейтинг клуба, бронь в приложении); у карточки без программы — null.
      club_id: onPlatform(card) ? card.club_id : null,
      booking: onPlatform(card) ? 'online' : 'request',
      address: card.address,
      location: card.lat === null ? null : { lat: Number(card.lat), lng: Number(card.lng) },
      hours_text: card.hours_text,
      around_the_clock: card.around_the_clock,
      disciplines,
      // Столы и корты отдельно (M5.8): tables_count — столы бильярда, courts_count — падел-корты.
      tables_count: live ? live.total : card.tables_count,
      courts_count: live ? live.courts_total : null,
      free_now: live ? live.free_now : null,
      courts_free_now: live ? live.courts_free_now : null,
      price_from_kopecks: priceFrom,
      court_price_from_kopecks: courtPriceFrom,
      slot_minutes: slotMinutes,
      rating: rating ?? { avg: null, count: 0 },
    };
  }

  // Маршруты --------------------------------------------------------------------------------

  /**
   * GET /api/public/cities → { items: [{ slug, name, name_in, region, clubs, online_clubs, free_now }] }.
   * free_now — свободные столы сейчас во всех клубах города на программе (light).
   */
  async function cities(db) {
    return cached('cities', async () => {
      const { rows } = await db.query(
        `select c.slug, c.name, c.name_in, c.region,
                count(p.id)::int as clubs,
                count(p.id) filter (where p.status = 'platform' and bl.club_mode(p.club_id) = 'live')::int as online_clubs,
                coalesce(array_agg(p.club_id) filter (where p.status = 'platform' and p.club_id is not null and bl.club_mode(p.club_id) = 'live'), '{}') as club_ids
           from bl.cities c left join bl.club_public p on p.city_id = c.id and p.visible
          where c.active
          group by c.id order by count(p.id) desc, c.name`,
      );
      const items = [];
      for (const { club_ids: clubIds, ...c } of rows) {
        let free = 0;
        for (const clubId of clubIds) free += (await clubLiveStatus(db, { clubId })).free_now;
        items.push({ ...c, free_now: free });
      }
      return { items };
    });
  }

  function parseFilters(q = {}) {
    const f = {};
    if (q.disciplines !== undefined) {
      const list = String(q.disciplines).split(',').map((s) => s.trim()).filter(Boolean);
      if (list.length > DISCIPLINES.length || !list.every((d) => DISCIPLINES.includes(d))) fail('bad_request', 'disciplines');
      f.disciplines = [...new Set(list)].sort();
    }
    for (const k of ['free_now', 'online', 'around_the_clock']) {
      if (q[k] === undefined) continue;
      if (!['1', 'true', '0', 'false'].includes(String(q[k]))) fail('bad_request', k);
      f[k] = ['1', 'true'].includes(String(q[k]));
    }
    if (q.price_max !== undefined) {
      const n = Number(q.price_max);
      if (!Number.isSafeInteger(n) || n < 0 || n > 100_000_000) fail('bad_request', 'price_max');
      f.price_max = n;
    }
    f.sort = q.sort === undefined ? 'recommended' : String(q.sort);
    if (!SORTS.includes(f.sort)) fail('bad_request', 'sort');
    return f;
  }

  /**
   * GET /api/public/cities/{slug}?disciplines=pyramid,pool&free_now=1&online=1&around_the_clock=1&price_max=&sort=
   * → { city, filters, items: [summary] }.
   */
  async function city(db, { slug, query }) {
    if (typeof slug !== 'string' || !SLUG.test(slug) || slug.length > 60) fail('not_found', 'city');
    const f = parseFilters(query);
    const key = `city:${slug}:${JSON.stringify(f)}`;
    return cached(key, async () => {
      const { rows: c } = await db.query('select id, slug, name, region, timezone from bl.cities where slug = $1 and active', [slug]);
      if (!c[0]) fail('not_found', 'city');
      const { rows: cards } = await db.query(
        `select p.*, $2::text as city_slug, bl.club_mode(p.club_id) as club_mode from bl.club_public p where p.city_id = $1 and p.visible order by p.name limit 500`,
        [c[0].id, slug],
      );
      const ratings = await ratingsOf(db, cards.map((x) => x.id));
      let items = [];
      for (const card of cards) items.push(await summary(db, card, ratings.get(card.id)));
      if (f.disciplines) items = items.filter((x) => f.disciplines.every((d) => x.disciplines.includes(d)));
      // «Свободно сейчас» с фильтром только «падел» — свободные корты, иначе — столы (M5.8).
      const padelOnly = f.disciplines?.length > 0 && f.disciplines.every((d) => d === 'padel');
      if (f.free_now) items = items.filter((x) => ((padelOnly ? x.courts_free_now : x.free_now) ?? 0) > 0);
      if (f.online) items = items.filter((x) => x.booking === 'online');
      if (f.around_the_clock) items = items.filter((x) => x.around_the_clock);
      if (f.price_max !== undefined) items = items.filter((x) => x.price_from_kopecks !== null && x.price_from_kopecks <= f.price_max);
      const byName = (a, b) => a.name.localeCompare(b.name, 'ru');
      const sorters = {
        recommended: (a, b) => (b.booking === 'online') - (a.booking === 'online') || (b.free_now ?? -1) - (a.free_now ?? -1) || byName(a, b),
        free: (a, b) => (b.free_now ?? -1) - (a.free_now ?? -1) || byName(a, b),
        price: (a, b) => (a.price_from_kopecks ?? Infinity) - (b.price_from_kopecks ?? Infinity) || byName(a, b),
        rating: (a, b) => (b.rating.avg ?? 0) - (a.rating.avg ?? 0) || b.rating.count - a.rating.count || byName(a, b),
        name: byName,
      };
      items.sort(sorters[f.sort]);
      return {
        city: { slug: c[0].slug, name: c[0].name, region: c[0].region, timezone: c[0].timezone },
        filters: f,
        updated_at: iso(clock.now()),
        items,
      };
    });
  }

  async function authorNick(db, userId) {
    if (typeof deps.plus?.playerCard !== 'function') return null;
    return safely(db, async () => (await deps.plus.playerCard(db, { userId, viewerId: null }))?.nick ?? null, { log, what: 'plus.playerCard' });
  }

  /** Опубликованные отзывы карточки: без пользователей, ник Бильярдум+ — если есть. */
  async function publicReviews(db, cardId, limit = 20) {
    const { rows } = await db.query(
      `select id, user_id, rating, text, reply_text, replied_at, created_at from bl.reviews
        where card_id = $1 and status = 'published' order by created_at desc limit $2`,
      [cardId, limit],
    );
    const items = [];
    for (const r of rows) {
      items.push({
        id: r.id,
        rating: r.rating,
        text: r.text,
        author_nick: await authorNick(db, r.user_id),
        created_at: iso(r.created_at),
        reply: r.reply_text ? { text: r.reply_text, at: iso(r.replied_at) } : null,
      });
    }
    return items;
  }

  /**
   * GET /api/public/clubs/{city}/{slug} → { club, live, prices, tournaments, reviews } (контракт §3: publicClub).
   */
  async function club(db, { city: citySlug, slug }) {
    if (typeof citySlug !== 'string' || !SLUG.test(citySlug) || typeof slug !== 'string' || !SLUG.test(slug)) fail('not_found', 'club');
    return cached(`club:${citySlug}:${slug}`, async () => {
      const { rows } = await db.query(
        `select p.*, c.slug as city_slug, c.name as city_name, c.timezone as city_timezone, bl.club_mode(p.club_id) as club_mode
           from bl.club_public p join bl.cities c on c.id = p.city_id
          where c.slug = $1 and p.slug = $2 and p.visible and c.active`,
        [citySlug, slug],
      );
      const card = rows[0];
      if (!card) fail('not_found', 'club');
      const ratings = await ratingsOf(db, [card.id]);
      const base = await summary(db, card, ratings.get(card.id));
      let live = null;
      let prices = [];
      let tournaments = [];
      if (onPlatform(card)) {
        live = await clubLiveStatus(db, { clubId: card.club_id });
        await enterClub(db, card.club_id);
        try {
          prices = await clubPrices(db, card.club_id);
          if (typeof deps.tournaments?.publicTournaments === 'function') {
            tournaments = (await safely(db, () => deps.tournaments.publicTournaments(db, { clubId: card.club_id }), { log, what: 'tournaments.publicTournaments' })) ?? [];
          }
        } finally {
          await enterClub(db, null);
        }
      }
      return {
        club: {
          ...base,
          city: { slug: card.city_slug, name: card.city_name, timezone: card.city_timezone },
          club_id: onPlatform(card) ? card.club_id : null,
          phone: card.phone,
          url: card.url,
          max_url: card.max_url,
          telegram_url: card.telegram_url,
          description: card.description,
        },
        live,
        prices,
        tournaments,
        reviews: { ...(ratings.get(card.id) ?? { avg: null, count: 0 }), items: await publicReviews(db, card.id) },
        updated_at: iso(clock.now()),
      };
    });
  }

  /** GET /api/public/listings/{id} → { id, name, city, address, status } (m4-api: заявка T25). */
  async function listing(db, { id }) {
    const { rows } = await db.query(
      `select p.id, p.name, c.name as city, p.address,
              case when p.status = 'platform' and bl.club_mode(p.club_id) is distinct from 'live' then 'claimed' else p.status end as status
         from bl.club_public p join bl.cities c on c.id = p.city_id
        where p.id = $1 and p.visible`,
      [id],
    );
    if (!rows[0]) fail('not_found', 'listing');
    return rows[0];
  }

  return { cities, city, club, listing, clubLiveStatus, clubPrices, publicReviews };
}
