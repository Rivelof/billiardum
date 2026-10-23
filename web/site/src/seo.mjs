/**
 * SEO (контракт M4 §1 п.15): schema.org JSON-LD (Organization, SportsActivityLocation, SportsEvent,
 * BreadcrumbList, ItemList), sitemap.xml по данным API, robots.txt. Основной поисковик — Яндекс.
 */
import { DISCIPLINES, cityUrl, tournamentUrl } from './lib.mjs';

const CTX = 'https://schema.org';
const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function organizationLd(origin) {
  return {
    '@context': CTX,
    '@type': 'Organization',
    name: 'Бильярдум',
    url: `${origin}/`,
    logo: `${origin}/og/site.png`,
  };
}

export function websiteLd(origin) {
  return { '@context': CTX, '@type': 'WebSite', name: 'Бильярдум', url: `${origin}/`, inLanguage: 'ru-RU' };
}

/** @param {{ name: string, path: string }[]} items */
export function breadcrumbsLd(origin, items) {
  return {
    '@context': CTX,
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: origin + it.path })),
  };
}

/** Клуб как SportsActivityLocation (PRODUCT §15). Оценка — только если есть отзывы гостей. */
export function clubLd(origin, { club, city, reviews }) {
  const url = origin + club.path;
  const ld = {
    '@context': CTX,
    '@type': 'SportsActivityLocation',
    '@id': `${url}#club`,
    name: club.name,
    url,
    address: { '@type': 'PostalAddress', streetAddress: club.address, addressLocality: city.name, addressCountry: 'RU' },
    image: `${origin}/og/club/${city.slug}/${club.slug}.png`,
  };
  if (city.region) ld.address.addressRegion = city.region;
  if (club.description) ld.description = club.description;
  if (club.phone) ld.telephone = club.phone;
  if (club.geo?.lat && club.geo?.lng) ld.geo = { '@type': 'GeoCoordinates', latitude: club.geo.lat, longitude: club.geo.lng };
  if (club.open_24h) {
    ld.openingHoursSpecification = [{ '@type': 'OpeningHoursSpecification', dayOfWeek: DAY_NAMES.slice(1), opens: '00:00', closes: '23:59' }];
  }
  if (club.price_from_kopecks) ld.priceRange = `от ${Math.round(club.price_from_kopecks / 100)} ₽ в час`;
  if (reviews?.count > 0 && reviews.avg) {
    ld.aggregateRating = { '@type': 'AggregateRating', ratingValue: reviews.avg, reviewCount: reviews.count, bestRating: 5, worstRating: 1 };
  }
  return ld;
}

const EVENT_STATUS = {
  cancelled: 'https://schema.org/EventCancelled',
};

/** Турнир как SportsEvent. */
export function tournamentLd(origin, t) {
  const ld = {
    '@context': CTX,
    '@type': 'SportsEvent',
    name: t.title,
    url: origin + tournamentUrl(t.id),
    startDate: t.starts_at,
    eventStatus: EVENT_STATUS[t.status] ?? 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    sport: DISCIPLINES[t.discipline] ?? t.discipline,
    image: `${origin}/og/turnir/${t.id}.png`,
    location: {
      '@type': 'SportsActivityLocation',
      name: t.club.name,
      address: { '@type': 'PostalAddress', streetAddress: t.club.address || t.club.name, addressLocality: t.club.city_name, addressCountry: 'RU' },
    },
    organizer: { '@type': 'Organization', name: t.club.name },
  };
  if (t.club.path) {
    ld.location.url = origin + t.club.path;
    ld.organizer.url = origin + t.club.path;
  }
  if (t.ends_at) ld.endDate = t.ends_at;
  if (t.rules) ld.description = t.rules;
  if (Number.isInteger(t.entry_fee_kopecks)) {
    ld.offers = {
      '@type': 'Offer',
      price: (t.entry_fee_kopecks / 100).toFixed(2),
      priceCurrency: 'RUB',
      url: origin + tournamentUrl(t.id),
      availability: t.status === 'registration' && t.entries < t.seats ? 'https://schema.org/InStock' : 'https://schema.org/SoldOut',
    };
  }
  return ld;
}

export function clubListLd(origin, city, clubs) {
  return {
    '@context': CTX,
    '@type': 'ItemList',
    name: `Бильярдные клубы ${city.name_in ?? city.name}`,
    itemListElement: clubs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, url: origin + c.path, name: c.name })),
  };
}

export function faqLd(items) {
  return {
    '@context': CTX,
    '@type': 'FAQPage',
    mainEntity: items.map((q) => ({ '@type': 'Question', name: q.q, acceptedAnswer: { '@type': 'Answer', text: q.a } })),
  };
}

// ---------- sitemap и robots ----------

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const STATIC_PATHS = ['/', '/turniry/', '/rejting/', '/plus/', '/dlya-klubov/', '/dlya-biznesa/', '/zhurnal/'];

/**
 * @param {string} origin
 * @param {{ cities: { slug }[], clubs: { city_slug, slug }[], tournaments: { id, status }[], articles: { slug, date? }[] }} data
 */
export function sitemapXml(origin, { cities = [], clubs = [], tournaments = [], articles = [] }) {
  const urls = [
    ...STATIC_PATHS.map((p) => ({ loc: p, freq: p === '/' ? 'hourly' : 'daily' })),
    ...cities.map((c) => ({ loc: cityUrl(c.slug), freq: 'hourly' })),
    ...clubs.map((c) => ({ loc: c.path, freq: 'daily' })),
    ...tournaments.filter((t) => t.status !== 'cancelled').map((t) => ({ loc: tournamentUrl(t.id), freq: t.status === 'finished' ? 'monthly' : 'daily' })),
    ...articles.map((a) => ({ loc: `/zhurnal/${a.slug}/`, freq: 'monthly', lastmod: a.date })),
  ];
  const seen = new Set();
  const body = urls
    .filter((u) => (seen.has(u.loc) ? false : seen.add(u.loc)))
    .map((u) => `  <url><loc>${xmlEsc(origin + u.loc)}</loc>${u.lastmod ? `<lastmod>${xmlEsc(u.lastmod)}</lastmod>` : ''}<changefreq>${u.freq}</changefreq></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

export function robotsTxt(origin, { noindex = false } = {}) {
  if (noindex) return 'User-agent: *\nDisallow: /\n';
  return [
    'User-agent: *',
    'Disallow: /app/',
    'Disallow: /club/',
    'Disallow: /api/',
    'Disallow: /pay/',
    'Disallow: /t/',
    'Allow: /',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n');
}
