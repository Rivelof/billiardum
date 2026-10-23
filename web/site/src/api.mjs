/**
 * Публичный API сервера → модели страниц сайта. Формы ответов — server/directory/README.md и
 * docs/contracts/m4-api.md; здесь они переводятся в один вид, чтобы страницы не зависели от мелких
 * правок бэкенда. Все запросы идут через data.get (кэш 60 с).
 */
import { cityIn } from './lib.mjs';

const FALLBACK_TZ = 'Europe/Moscow';

function card(s, city) {
  return {
    id: s.id,
    slug: s.slug,
    path: s.path ?? `/${city?.slug}/${s.slug}/`,
    name: s.name,
    status: s.status,
    online_booking: s.booking === 'online',
    address: s.address ?? '',
    geo: s.location ? { lat: s.location.lat, lng: s.location.lng } : null,
    hours_text: s.hours_text ?? '',
    open_24h: Boolean(s.around_the_clock),
    disciplines: s.disciplines ?? [],
    tables_count: s.tables_count ?? null,
    free_now: Number.isInteger(s.free_now) ? s.free_now : null,
    price_from_kopecks: Number.isInteger(s.price_from_kopecks) ? s.price_from_kopecks : null,
    rating: s.rating?.count > 0 && s.rating.avg !== null ? { avg: s.rating.avg, count: s.rating.count } : null,
  };
}

function cityModel(c) {
  return { slug: c.slug, name: c.name, region: c.region ?? null, name_in: cityIn(c.name), timezone: c.timezone ?? FALLBACK_TZ };
}

const TSTATUS = { running: 'live', canceled: 'cancelled' };
// Матчи отменённого турнира — canceled (Д2): «Отменён», без стола
const MSTATUS = { playing: 'live', pending_confirm: 'live', disputed: 'live', done: 'finished', canceled: 'canceled' };

export function createApi(data) {
  async function cities() {
    const res = await data.get('/api/public/cities');
    return (res?.items ?? []).map((c) => ({ ...cityModel(c), clubs: c.clubs ?? 0, online_clubs: c.online_clubs ?? 0 }));
  }

  async function city(slug) {
    const res = await data.get(`/api/public/cities/${slug}`);
    if (!res?.city) return null;
    const c = cityModel(res.city);
    return { city: c, clubs: (res.items ?? []).map((s) => card(s, c)) };
  }

  async function club(citySlug, slug) {
    const res = await data.get(`/api/public/clubs/${citySlug}/${slug}`);
    if (!res?.club) return null;
    const c = cityModel({ ...(res.club.city ?? { slug: citySlug, name: citySlug }) });
    const k = {
      ...card(res.club, c),
      club_id: res.club.club_id ?? null,
      phone: res.club.phone ?? null,
      url: res.club.url ?? null,
      max_url: res.club.max_url ?? null,
      telegram_url: res.club.telegram_url ?? null,
      description: res.club.description ?? null,
      timezone: c.timezone,
    };
    const hall = res.live?.tables?.length
      ? {
          updated_at: res.live.updated_at,
          resources: res.live.tables.map((t) => ({
            id: t.id,
            number: t.number,
            title: t.title,
            type: `billiard_${t.discipline ?? 'pyramid'}`,
            status: t.status,
            until: t.busy_until ?? null,
          })),
        }
      : null;
    // Цены: правила по дисциплинам → блоки «дни × часы»
    const blocks = new Map();
    for (const r of res.prices ?? []) {
      if (!blocks.has(r.discipline)) blocks.set(r.discipline, { type: r.discipline, rules: [] });
      blocks.get(r.discipline).rules.push({ days: r.days, from: r.from, to: r.to, price_per_hour_kopecks: r.price_per_hour_kopecks, min_minutes: r.min_minutes ?? null });
    }
    const index = await clubIndexFrom([{ club: k, city: c }]);
    const reviews = res.reviews ?? { avg: null, count: 0, items: [] };
    return {
      club: k,
      city: c,
      hall,
      prices: [...blocks.values()],
      tournaments: (res.tournaments ?? []).map((t) => tournamentModel(t, index)),
      reviews: {
        avg: reviews.avg,
        count: reviews.count ?? 0,
        items: (reviews.items ?? []).map((r) => ({
          id: r.id,
          rating: r.rating,
          text: r.text,
          author: r.author_nick || 'Гость клуба',
          created_at: r.created_at,
          reply: r.reply ? { text: r.reply.text, created_at: r.reply.at } : null,
        })),
      },
    };
  }

  function clubIndexFrom(list) {
    const map = new Map();
    for (const { club: k, city: c } of list) {
      if (k.club_id) map.set(k.club_id, { name: k.name, slug: k.slug, path: k.path, address: k.address, city_slug: c.slug, city_name: c.name, timezone: c.timezone });
    }
    return map;
  }

  /**
   * Клубы в программе по club_id (bl.clubs) → адрес страницы и часовой пояс. Турниры и рейтинг знают
   * только club_id и название города, а сайту нужны ссылки на клуб и время по поясу клуба.
   */
  let indexMemo = null;
  async function clubIndex() {
    if (indexMemo && Date.now() - indexMemo.at < 60_000) return indexMemo.map;
    const list = [];
    for (const c of await cities()) {
      const res = await city(c.slug);
      for (const k of res?.clubs ?? []) {
        if (k.status !== 'platform') continue;
        const detail = await club(c.slug, k.slug).catch(() => null);
        if (detail) list.push({ club: detail.club, city: detail.city });
      }
    }
    const map = clubIndexFrom(list);
    indexMemo = { at: Date.now(), map };
    return map;
  }

  function tournamentModel(t, index) {
    const k = index.get(t.club?.id) ?? null;
    return {
      id: t.id,
      title: t.title,
      discipline: t.discipline,
      format: t.format,
      race_to: t.race_to,
      starts_at: t.starts_at,
      ends_at: t.ends_at ?? null,
      registration_closes_at: t.registration_closes_at ?? null,
      timezone: k?.timezone ?? FALLBACK_TZ,
      status: TSTATUS[t.status] ?? t.status,
      entry_fee_kopecks: Number.isInteger(t.fee_kopecks) ? t.fee_kopecks : 0,
      prize_text: t.prize_text ?? null,
      seats: t.places ?? 0,
      entries: t.entries_count ?? 0,
      rating_max: t.rating_limit ?? null,
      rules: t.description ?? null,
      club: {
        id: t.club?.id ?? null,
        name: t.club?.name ?? k?.name ?? 'Клуб',
        slug: k?.slug ?? null,
        path: k?.path ?? null,
        city_slug: k?.city_slug ?? null,
        city_name: t.club?.city ?? k?.city_name ?? '',
        address: k?.address ?? '',
      },
    };
  }

  async function tournaments({ cityName } = {}) {
    const res = await data.get(`/api/public/tournaments${cityName ? `?city=${encodeURIComponent(cityName.toLowerCase())}` : ''}`);
    const items = res?.items ?? [];
    if (!items.length) return [];
    const index = await clubIndex();
    return items.map((t) => tournamentModel(t, index));
  }

  async function tournament(id) {
    const res = await data.get(`/api/public/tournaments/${id}`);
    if (!res?.id) return null;
    const index = await clubIndex();
    const bracket = res.bracket?.rounds?.length
      ? {
          rounds: res.bracket.rounds.map((r) => ({
            title: r.title,
            standings: r.standings ?? null,
            matches: (r.matches ?? []).map((m) => ({
              id: m.id,
              a: m.a,
              b: m.b,
              score_a: m.score_a ?? 0,
              score_b: m.score_b ?? 0,
              status: MSTATUS[m.status] ?? 'scheduled',
              winner: m.winner ?? null,
              table: m.table_number ?? null,
            })),
          })),
          winner: res.bracket.winner ?? null,
        }
      : null;
    return { tournament: tournamentModel(res, index), entries: res.entries ?? [], bracket };
  }

  async function rating(params) {
    const res = await data.get(`/api/public/rating?${params}`);
    return { rows: res?.items ?? [] };
  }

  return { cities, city, club, clubIndex, tournaments, tournament, rating };
}
