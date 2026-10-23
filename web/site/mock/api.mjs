/**
 * Заглушка публичного API — те же адреса и формы ответов, что у сервера (server/directory/README.md,
 * docs/contracts/m4-api.md): /api/public/cities, /cities/{slug}, /clubs/{city}/{slug}, /listings/{id},
 * /tournaments, /tournaments/{id}, /rating, POST /api/leads. Включается, когда BL_API_URL не задан или «mock».
 * Демо-данные — mock/data.mjs (только для разработки).
 *
 *   handle({ method, path, query, body, now }) → { status, json }
 */
import { CITIES, CLUBS, PLAYERS, levelOf, liveStatus, tournaments } from './data.mjs';

const REGION = { ekaterinburg: 'Свердловская область', chelyabinsk: 'Челябинская область', perm: 'Пермский край' };
const DAYS = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function kindOf(type) {
  if (/pool/.test(type)) return 'pool';
  if (/snooker/.test(type)) return 'snooker';
  return 'pyramid';
}

function hoursText(club) {
  if (club.open_24h) return 'Круглосуточно';
  return club.hours
    .map((h) => {
      const d = h.days.length === 7 ? 'Ежедневно' : `${DAYS[h.days[0]]}–${DAYS[h.days.at(-1)]}`;
      return `${d} ${h.open}–${h.close}`;
    })
    .join(', ');
}

function summary(club, now) {
  const city = CITIES.find((c) => c.slug === club.city_slug);
  const platform = club.status === 'platform';
  const states = platform ? club.resources.map((r) => liveStatus(club, r, now)) : null;
  const rules = (club.prices ?? []).flatMap((p) => p.rules);
  const reviews = club.reviews ?? [];
  return {
    id: club.id,
    slug: club.slug,
    path: `/${city.slug}/${club.slug}/`,
    name: club.name,
    status: club.status,
    booking: platform ? 'online' : 'request',
    address: club.address,
    location: club.geo ? { lat: club.geo.lat, lng: club.geo.lon } : null,
    hours_text: hoursText(club),
    around_the_clock: club.open_24h,
    disciplines: platform ? [...new Set(club.resources.map((r) => kindOf(r.type)))] : (club.disciplines ?? []),
    tables_count: platform ? club.resources.length : (club.tables_count ?? null),
    free_now: platform ? states.filter((s) => s.status === 'free').length : null,
    price_from_kopecks: rules.length ? Math.min(...rules.map((r) => r.price_per_hour_kopecks)) : (club.price_day_kopecks ?? null),
    rating: {
      avg: reviews.length ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / reviews.length) * 10) / 10 : null,
      count: reviews.length,
    },
  };
}

function clubOf(t) {
  return CLUBS.find((c) => c.slug === t.club_slug);
}

function tView(t) {
  const club = clubOf(t);
  const city = CITIES.find((c) => c.slug === club.city_slug);
  return {
    id: t.id,
    title: t.title,
    description: t.rules ?? null,
    club: { id: club.club_id, name: club.name, city: city.name },
    discipline: t.discipline,
    format: t.format,
    race_to: t.race_to,
    rating_limit: t.rating_max ?? null,
    rating_min: null,
    fee_kopecks: t.entry_fee_kopecks,
    prize_text: t.prize_fund_kopecks ? `Призовой фонд ${t.prize_fund_kopecks / 100} ₽` : null,
    prize_kopecks: null,
    places: t.seats,
    entries_count: t.entries,
    starts_at: t.starts_at,
    ends_at: null,
    registration_closes_at: t.status === 'registration' ? new Date(Date.parse(t.starts_at) - 3_600_000).toISOString() : null,
    status: t.status,
  };
}

function bracketView(b) {
  if (!b) return { rounds: [], winner: null };
  return {
    rounds: b.rounds.map((r) => ({
      title: r.title,
      stage: 'playoff',
      matches: r.matches.map((m) => ({
        id: m.id, stage: 'playoff', table_number: m.table, a: m.a ? { nick: m.a.nick, seed: m.a.seed } : null,
        b: m.b ? { nick: m.b.nick, seed: m.b.seed } : null, score_a: m.score_a, score_b: m.score_b, status: m.status, winner: m.winner, bye: false,
      })),
    })),
    winner: null,
  };
}

function bad(code, status = 400) {
  return { status, json: { error: code } };
}

const leads = [];
/** Только для тестов: что ушло в заглушку. */
export const sent = { leads };

export function handle({ method = 'GET', path, query = new URLSearchParams(), body = null, now = Date.now() }) {
  let m;
  if (method === 'GET' && path === '/api/public/cities') {
    return {
      status: 200,
      json: {
        items: CITIES.map((c) => {
          const clubs = CLUBS.filter((k) => k.city_slug === c.slug);
          return { slug: c.slug, name: c.name, region: REGION[c.slug] ?? null, clubs: clubs.length, online_clubs: clubs.filter((k) => k.status === 'platform').length };
        }),
      },
    };
  }
  if (method === 'GET' && (m = /^\/api\/public\/cities\/([a-z0-9-]+)$/.exec(path))) {
    const city = CITIES.find((c) => c.slug === m[1]);
    if (!city) return bad('not_found', 404);
    const items = CLUBS.filter((k) => k.city_slug === city.slug).map((k) => summary(k, now));
    return {
      status: 200,
      json: {
        city: { slug: city.slug, name: city.name, region: REGION[city.slug] ?? null, timezone: city.timezone },
        filters: { disciplines: [], free_now: false, online: false, around_the_clock: false, price_max: null, sort: 'recommended' },
        updated_at: new Date(now).toISOString(),
        items,
      },
    };
  }
  if (method === 'GET' && (m = /^\/api\/public\/clubs\/([a-z0-9-]+)\/([a-z0-9-]+)$/.exec(path))) {
    const club = CLUBS.find((k) => k.city_slug === m[1] && k.slug === m[2]);
    if (!club) return bad('not_found', 404);
    const city = CITIES.find((c) => c.slug === club.city_slug);
    const platform = club.status === 'platform';
    const s = summary(club, now);
    const tables = platform
      ? club.resources.map((r) => {
          const st = liveStatus(club, r, now);
          return {
            id: r.id, number: r.number, title: r.title, discipline: kindOf(r.type), plan: { x: null, y: null, rotation: 0 },
            status: st.status, busy_until: st.status === 'busy' ? st.until : null,
          };
        })
      : null;
    return {
      status: 200,
      json: {
        club: {
          ...s,
          city: { slug: city.slug, name: city.name, timezone: city.timezone },
          club_id: platform ? club.club_id : null,
          phone: club.phone ?? null,
          url: null,
          max_url: null,
          telegram_url: null,
          description: club.description || null,
        },
        live: platform ? { updated_at: new Date(now).toISOString(), free_now: s.free_now, total: tables.length, plan: null, tables } : null,
        prices: platform
          ? club.prices.flatMap((p) => p.rules.map((r) => ({ discipline: p.type, days: r.days, from: r.from, to: r.to, price_per_hour_kopecks: r.price_per_hour_kopecks, min_minutes: 30 })))
          : [],
        tournaments: platform ? tournaments().filter((t) => t.club_slug === club.slug).map(tView) : [],
        reviews: {
          avg: s.rating.avg,
          count: s.rating.count,
          items: (club.reviews ?? []).map((r) => ({ id: r.id, rating: r.rating, text: r.text, author_nick: r.author, created_at: r.created_at, reply: r.reply ? { text: r.reply.text, at: r.reply.created_at } : null })),
        },
        updated_at: new Date(now).toISOString(),
      },
    };
  }
  if (method === 'GET' && (m = /^\/api\/public\/listings\/([0-9a-f-]{36})$/.exec(path))) {
    const club = CLUBS.find((k) => k.id === m[1]);
    if (!club) return bad('not_found', 404);
    return { status: 200, json: { id: club.id, name: club.name, city: CITIES.find((c) => c.slug === club.city_slug).name, address: club.address, status: club.status } };
  }
  if (method === 'GET' && path === '/api/public/tournaments') {
    const city = (query.get('city') ?? '').toLowerCase();
    let items = tournaments().map(tView);
    if (city) items = items.filter((t) => t.club.city.toLowerCase() === city);
    return { status: 200, json: { items } };
  }
  if (method === 'GET' && (m = /^\/api\/public\/tournaments\/([0-9a-f-]{36})$/.exec(path))) {
    const t = tournaments().find((x) => x.id === m[1]);
    if (!t) return bad('not_found', 404);
    const entries = t.status === 'registration' ? [] : PLAYERS.slice(0, t.entries).map((p, i) => ({ nick: p.nick, seed: i + 1, rating: p.rating }));
    return { status: 200, json: { ...tView(t), entries, bracket: bracketView(t.bracket) } };
  }
  if (method === 'GET' && path === '/api/public/rating') {
    const discipline = query.get('discipline') ?? 'pyramid';
    const scope = query.get('scope') ?? 'country';
    const season = query.get('season') ?? 'all';
    if (!['pyramid', 'pool', 'snooker'].includes(discipline) || !['country', 'city', 'club'].includes(scope)) return bad('bad_request');
    if (season !== 'all' && !/^\d{4}-\d{2}$/.test(season)) return bad('bad_request');
    let list = PLAYERS;
    if (scope === 'city') list = list.filter((p) => p.city_slug === query.get('city'));
    if (scope === 'club') {
      const club = CLUBS.find((c) => c.club_id === query.get('club'));
      if (!club) return bad('bad_request');
      list = list.filter((p) => p.club_slug === club.slug);
    }
    const shift = discipline === 'pyramid' ? 0 : discipline === 'pool' ? 140 : 260;
    const items = list
      .map((p) => ({ nick: p.nick, rating: p.rating - shift - (season === 'all' ? 0 : 35), games: Math.max(3, p.games - shift / 10 - (season === 'all' ? 0 : 100)) }))
      .filter((p) => discipline !== 'snooker' || p.games > 40)
      .sort((a, b) => b.rating - a.rating)
      .map((p, i) => ({ place: i + 1, nick: p.nick, level: levelOf(p.rating), rating: p.rating, games: p.games }));
    return { status: 200, json: { items, me: null } };
  }
  if (method === 'POST' && path === '/api/leads') {
    const b = body ?? {};
    if (b.website || (Number.isFinite(b.elapsed_ms) && b.elapsed_ms < 3000)) return { status: 201, json: { ok: true } };
    if (b.consent !== true) return bad('consent_required', 403);
    if (!b.name || !b.club_name || !b.city || !/^\+?[0-9 ()-]{10,20}$/.test(String(b.phone ?? '').trim())) return bad('bad_request');
    leads.push({ ...b, phone: `${String(b.phone).slice(0, 4)}***` });
    return { status: 201, json: { ok: true } };
  }
  return bad('not_found', 404);
}
