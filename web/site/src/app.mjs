/**
 * Маршруты сайта (контракт M4 §1 п.2) без HTTP-обвязки: handle({ method, url, headers, body, ip }) → ответ.
 * server.mjs отдаёт статику и сжимает ответы; тесты зовут handle напрямую.
 */
import { formatDate, formatMoney, formatTime } from '@billiardum/shared/format';
import { createApi } from './api.mjs';
import { ApiUnavailable } from './data.mjs';
import { renderDocument } from './document.mjs';
import { listArticles } from './journal.mjs';
import { DISCIPLINE_SHORT, RESERVED, SLUG, TABLE_CODE, UUID, tablesWord } from './lib.mjs';
import { ogImage } from './og.mjs';
import { robotsTxt, sitemapXml } from './seo.mjs';
import { homePage } from './pages/home.mjs';
import { cityPage } from './pages/city.mjs';
import { clubPage } from './pages/club.mjs';
import { tournamentPage, tournamentsPage } from './pages/tournaments.mjs';
import { plusPage, ratingPage } from './pages/plus.mjs';
import { ownersPage } from './pages/owners.mjs';
import { articlePage, businessPage, journalPage, notFoundPage, unavailablePage } from './pages/misc.mjs';

const HTML_CACHE = 'public, max-age=60';

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // битая cookie — пропускаем
    }
  }
  return out;
}

function text(status, body, type, extra = {}) {
  return { status, headers: { 'content-type': type, ...extra }, body };
}

function redirect(location, status = 302) {
  return { status, headers: { location, 'cache-control': 'no-store' }, body: '' };
}

/** Ошибки заявки клуба (POST /api/leads) — что случилось и что делать. */
export const LEAD_MESSAGES = {
  bad_request: 'Проверьте поля: имя, клуб, город и телефон в формате +7 900 000-00-00.',
  consent_required: 'Отметьте согласие на обработку данных — без него мы не можем принять заявку.',
  rate_limited: 'С этого адреса уже отправили несколько заявок. Попробуйте позже или напишите нам снова завтра.',
  unavailable: 'Сервер не ответил, заявка не отправлена. Попробуйте через минуту.',
};

function checkLead(v) {
  for (const k of ['name', 'club_name', 'city', 'phone']) if (!String(v[k] ?? '').trim()) return LEAD_MESSAGES.bad_request;
  const digits = String(v.phone).replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return LEAD_MESSAGES.bad_request;
  if (v.tables_count !== undefined && v.tables_count !== '') {
    const n = Number(v.tables_count);
    if (!Number.isInteger(n) || n < 1 || n > 200) return 'Число столов — от 1 до 200.';
  }
  if (v.consent !== '1') return LEAD_MESSAGES.consent_required;
  return null;
}

export function createSite({ cfg, data, now: clock = () => Date.now(), mockApi = null }) {
  const api = createApi(data);

  function respondPage(p) {
    const { html, csp } = renderDocument({ cfg, ...p });
    const ok = !p.status || p.status === 200;
    const headers = {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': csp,
      'cache-control': !ok ? 'no-store' : p.vary || p.cookie ? 'private, max-age=60' : HTML_CACHE,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
    };
    if (p.vary) headers.vary = p.vary;
    if (p.cookie) headers['set-cookie'] = p.cookie;
    return { status: p.status ?? 200, headers, body: html };
  }

  async function notFound() {
    const cities = await api.cities().catch(() => []);
    return respondPage({ ...notFoundPage(), cities });
  }

  async function og(kind, params) {
    let card = null;
    if (kind === 'site') {
      card = { kicker: 'Каталог бильярдных клубов', title: 'Свободные столы сейчас', subtitle: 'Клубы, бронь, турниры и рейтинг игроков', facts: [] };
    } else if (kind === 'club') {
      const res = await api.club(params.city, params.club);
      if (!res) return null;
      const c = res.club;
      const disc = (c.disciplines ?? []).map((d) => DISCIPLINE_SHORT[d]?.toLowerCase()).filter(Boolean).join(', ');
      card = {
        kicker: `Бильярдный клуб, ${res.city.name}`,
        title: c.name,
        subtitle: c.address,
        facts: [
          c.tables_count ? `${c.tables_count} ${tablesWord(c.tables_count)}${disc ? `: ${disc}` : ''}` : disc,
          c.price_from_kopecks ? `от ${formatMoney(c.price_from_kopecks)} в час` : c.status === 'platform' ? '' : 'Бронь по заявке',
        ].filter(Boolean),
      };
    } else if (kind === 'turnir') {
      const res = await api.tournament(params.id);
      if (!res) return null;
      const t = res.tournament;
      card = {
        kicker: `Турнир${t.club.city_name ? `, ${t.club.city_name}` : ''}`,
        title: t.title,
        subtitle: [t.club.name, t.club.address].filter(Boolean).join(', '),
        facts: [`${formatDate(t.starts_at, t.timezone)}, ${formatTime(t.starts_at, t.timezone)}`, t.entry_fee_kopecks ? `Взнос ${formatMoney(t.entry_fee_kopecks)}` : 'Без взноса'],
      };
    }
    const img = await ogImage(card);
    return { status: 200, headers: { 'content-type': img.type, 'cache-control': 'public, max-age=86400' }, body: img.body };
  }

  async function sitemap() {
    const cities = await api.cities();
    const clubs = [];
    for (const c of cities) {
      const res = await api.city(c.slug);
      for (const k of res?.clubs ?? []) clubs.push({ path: k.path });
    }
    const tournaments = await api.tournaments();
    const articles = listArticles({ mock: cfg.mock });
    return text(200, sitemapXml(cfg.origin, { cities, clubs, tournaments, articles }), 'application/xml; charset=utf-8', { 'cache-control': 'public, max-age=600' });
  }

  /**
   * Заявка клуба на программу (/dlya-klubov/): форма уходит на сайт, сайт — в POST /api/leads с IP гостя.
   * Без JS — 303 на страницу с ?zayavka=ok, с JS (Accept: application/json) — JSON.
   * Антиспам — на сервере API (скрытое поле website и elapsed_ms); сайт только не шлёт заполненное скрытое поле.
   */
  async function submitLead(ctx) {
    const v = Object.fromEntries(new URLSearchParams(ctx.body ?? ''));
    const wantsJson = /application\/json/.test(ctx.headers.accept ?? '');
    const now = clock();
    let error = checkLead(v);
    if (!error && !v.website) {
      const tables = v.tables_count ? Number(v.tables_count) : undefined;
      const payload = {
        name: String(v.name).trim().slice(0, 80),
        club_name: String(v.club_name).trim().slice(0, 120),
        city: String(v.city).trim().slice(0, 80),
        phone: String(v.phone).trim(),
        ...(tables ? { tables_count: tables } : {}),
        ...(v.comment?.trim() ? { comment: v.comment.trim().slice(0, 1000) } : {}),
        consent: true,
        website: '',
        elapsed_ms: Number.isFinite(Number(v.t)) ? Math.max(0, now - Number(v.t)) : null,
      };
      try {
        const res = await data.post('/api/leads', payload, { ip: ctx.ip });
        if (res.status >= 300) error = res.status === 429 ? LEAD_MESSAGES.rate_limited : LEAD_MESSAGES[res.json?.error] ?? LEAD_MESSAGES.bad_request;
      } catch (err) {
        if (!(err instanceof ApiUnavailable)) throw err;
        error = LEAD_MESSAGES.unavailable;
      }
    }
    if (wantsJson) {
      return text(error ? 422 : 200, JSON.stringify(error ? { ok: false, message: error } : { ok: true }), 'application/json; charset=utf-8', { 'cache-control': 'no-store' });
    }
    if (!error) return redirect('/dlya-klubov/?zayavka=ok#zayavka', 303);
    return respondPage(await ownersPage({ ...ctx, api, form: { error, values: v } }));
  }

  async function mockApiRoute(ctx) {
    const mod = mockApi ?? (await import('../mock/api.mjs'));
    let body = null;
    if (ctx.method === 'POST') {
      try {
        body = JSON.parse(ctx.body || 'null');
      } catch {
        body = null;
      }
    }
    const res = mod.handle({ method: ctx.method, path: ctx.url.pathname, query: ctx.url.searchParams, body, now: clock() });
    return text(res.status, JSON.stringify(res.json), 'application/json; charset=utf-8', { 'cache-control': 'no-store' });
  }

  async function route(ctx) {
    const { method, url } = ctx;
    const path = url.pathname;
    const seg = path.split('/').filter(Boolean);

    // Заглушка API только в разработке: острова (план зала) ходят в /api/public/* того же адреса
    if (cfg.mock && (path.startsWith('/api/public/') || path === '/api/leads')) return mockApiRoute(ctx);

    if (method === 'POST') {
      if (path === '/dlya-klubov/zayavka/') return submitLead(ctx);
      return text(405, 'Метод не поддерживается', 'text/plain; charset=utf-8', { allow: 'GET, HEAD' });
    }
    if (method !== 'GET' && method !== 'HEAD') return text(405, 'Метод не поддерживается', 'text/plain; charset=utf-8', { allow: 'GET, HEAD, POST' });

    if (path === '/robots.txt') return text(200, robotsTxt(cfg.origin, { noindex: cfg.noindex }), 'text/plain; charset=utf-8', { 'cache-control': 'public, max-age=3600' });
    if (path === '/sitemap.xml') return sitemap();

    // Вход со стола: /t/{код} → приложение гостя (как короткая ссылка сервера, api/routes/owner.mjs)
    if (seg[0] === 't' && seg.length === 2) {
      const code = seg[1].toUpperCase();
      if (!TABLE_CODE.test(code)) return notFound();
      return redirect(`/app/t/${code}`, 302);
    }

    if (seg[0] === 'og') {
      let res = null;
      if (path === '/og/site.png') res = await og('site');
      else if (seg[1] === 'club' && seg.length === 4 && SLUG.test(seg[2]) && /^[a-z0-9-]+\.png$/.test(seg[3])) res = await og('club', { city: seg[2], club: seg[3].slice(0, -4) });
      else if (seg[1] === 'turnir' && seg.length === 3 && seg[2].endsWith('.png') && UUID.test(seg[2].slice(0, -4))) res = await og('turnir', { id: seg[2].slice(0, -4) });
      return res ?? text(404, 'Не найдено', 'text/plain; charset=utf-8');
    }

    // Страницы — с косой чертой на конце
    if (!path.endsWith('/')) {
      if (seg.length <= 3 && seg.every((s) => /^[a-z0-9-]+$/.test(s))) return redirect(`${path}/${url.search}`, 301);
      return notFound();
    }

    const c = { ...ctx, api };
    let p = null;
    if (seg.length === 0) p = await homePage(c);
    else if (seg[0] === 'turniry' && seg.length === 1) p = await tournamentsPage(c);
    else if (seg[0] === 'turniry' && seg.length === 2) p = await tournamentPage({ ...c, params: { id: seg[1] } });
    else if (seg[0] === 'rejting' && seg.length === 1) p = await ratingPage(c);
    else if (seg[0] === 'plus' && seg.length === 1) p = await plusPage(c);
    else if (seg[0] === 'dlya-klubov' && seg.length === 1) p = await ownersPage(c);
    else if (seg[0] === 'dlya-biznesa' && seg.length === 1) p = await businessPage(c);
    else if (seg[0] === 'zhurnal' && seg.length === 1) p = await journalPage(c);
    else if (seg[0] === 'zhurnal' && seg.length === 2) p = await articlePage({ ...c, params: { slug: seg[1] } });
    else if (seg.length === 1 && SLUG.test(seg[0]) && !RESERVED.has(seg[0])) p = await cityPage({ ...c, params: { city: seg[0] } });
    else if (seg.length === 2 && SLUG.test(seg[0]) && SLUG.test(seg[1]) && !RESERVED.has(seg[0])) p = await clubPage({ ...c, params: { city: seg[0], club: seg[1] } });
    if (!p) return notFound();
    return respondPage(p);
  }

  /** @param {{ method: string, url: string | URL, headers?: object, body?: string, ip?: string }} req */
  return async function handle(req) {
    const url = req.url instanceof URL ? req.url : new URL(req.url, 'http://site');
    const headers = req.headers ?? {};
    const ctx = { method: req.method ?? 'GET', url, headers, body: req.body ?? '', ip: req.ip ?? null, cfg, data, now: clock(), cookies: parseCookies(headers.cookie) };
    try {
      return await route(ctx);
    } catch (err) {
      if (err instanceof ApiUnavailable) {
        const res = respondPage(unavailablePage());
        res.headers['retry-after'] = '60';
        return res;
      }
      throw err;
    }
  };
}
