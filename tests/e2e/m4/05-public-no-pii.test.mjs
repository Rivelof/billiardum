// Публичный API сайта и сам сайт без входа: нет ПДн (телефонов гостей, id пользователей, данных
// сессий и броней), кэш 60 с, только GET; страницы сайта — 200, lang="ru", canonical, JSON-LD
// (SportsActivityLocation, SportsEvent, BreadcrumbList, Organization) разбирается, sitemap.xml и
// robots.txt. Телефон клуба в карточке — публичный контакт клуба, это не ПДн гостя.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { adminClient, api, BASE, CLUB_A, DEMO_LISTING, flat, phonesIn } from './helpers.mjs';

let db;
let userIds = [];
let guestPhones = [];
let tid = null;

before(async () => {
  db = await adminClient();
  const { rows } = await db.query('select id::text, phone from bl.users');
  userIds = rows.map((r) => r.id);
  guestPhones = rows.map((r) => r.phone).filter(Boolean);
  const t = await db.query("select id from bl.tournaments where club_id = $1 and status in ('finished','running','registration','closed') order by created_at desc limit 1", [CLUB_A]);
  tid = t.rows[0]?.id ?? null;
});

after(async () => {
  await db?.end();
});

/** Ответ без телефонов гостей и без id пользователей. Телефоны клубов (поле phone карточки) разрешены. */
function leaks(body) {
  const s = typeof body === 'string' ? body : JSON.stringify(body);
  const ids = userIds.filter((id) => s.includes(id));
  const phones = guestPhones.filter((p) => s.includes(p) || s.includes(p.slice(1)));
  return { ids, phones };
}

const CLUB_PHONES = ['+70000000099', '+70000000098'];

test('публичный API: без ПДн, кэш 60 с, только GET', async (t) => {
  const paths = [
    '/api/public/cities',
    '/api/public/cities/ekaterinburg',
    '/api/public/cities/ekaterinburg?free_now=1&sort=free',
    '/api/public/clubs/ekaterinburg/testovyy-klub',
    '/api/public/clubs/ekaterinburg/demo-bez-programmy',
    `/api/public/listings/${DEMO_LISTING}`,
    '/api/public/tournaments',
    '/api/public/rating?discipline=pyramid&scope=country&season=all',
    '/api/public/rating?discipline=pyramid&scope=city&city=ekaterinburg&season=all',
    ...(tid ? [`/api/public/tournaments/${tid}`] : []),
  ];
  const out = [];
  for (const p of paths) {
    const r = await api('GET', p);
    assert.equal(r.status, 200, `${p}: ${r.status}`);
    const l = leaks(r.json);
    const phones = phonesIn(flat(r.json)).filter((x) => !CLUB_PHONES.some((c) => x.replace(/\D/g, '').endsWith(c.slice(2))));
    assert.deepEqual(l.ids, [], `${p}: id пользователей`);
    assert.deepEqual(l.phones, [], `${p}: телефоны пользователей`);
    assert.deepEqual(phones, [], `${p}: номера в тексте`);
    assert.match(r.headers['cache-control'] ?? '', /public, max-age=60/, `${p}: cache-control`);
    for (const bad of ['session_id', 'booking_id', 'payer', 'guest_phone', 'user_id', 'contact_user_id', 'email']) {
      assert.ok(!flat(r.json).includes(`"${bad}"`), `${p}: поле ${bad}`);
    }
    out.push(`${p.replace('/api/public', '')} ${Buffer.byteLength(r.text)} Б`);
  }
  const club = (await api('GET', '/api/public/clubs/ekaterinburg/testovyy-klub')).json;
  assert.ok(club.live && Array.isArray(club.live.tables) && club.live.tables.length >= 6, 'план зала вживую у клуба на программе');
  assert.ok(club.live.tables.every((x) => ['free', 'busy', 'reserved', 'unavailable'].includes(x.status)));
  const demo = (await api('GET', '/api/public/clubs/ekaterinburg/demo-bez-programmy')).json;
  assert.equal(demo.live, null);
  assert.equal(demo.club.booking, 'request');
  for (const m of ['POST', 'PATCH', 'DELETE']) {
    const r = await api(m, '/api/public/cities', { body: {} });
    assert.ok([404, 405].includes(r.status), `${m} /api/public/cities → ${r.status}`);
  }
  const nf = await api('GET', '/api/public/clubs/ekaterinburg/net-takogo');
  assert.equal(nf.status, 404);
  t.diagnostic(`${out.join('; ')}; клуб на программе: live.tables ${club.live.tables.length} (${[...new Set(club.live.tables.map((x) => x.status))].join('/')}), free_now ${club.live.free_now}; без программы: live=null, booking=request; POST/PATCH/DELETE — 404/405; нет клуба — 404`);
});

test('публичный поток турнира без входа: только сетка, без ПДн', async (t) => {
  if (!tid) return t.skip('нет опубликованного турнира');
  const { sseOpen } = await import('./helpers.mjs');
  const s = sseOpen(`/api/public/tournaments/${tid}/stream`);
  const ready = await s.ready;
  assert.equal(ready.status, 200);
  const ev = await s.waitEvent((e) => e.event === 'bracket');
  s.close();
  const l = leaks(ev.raw);
  assert.deepEqual(l, { ids: [], phones: [] });
  const s2 = sseOpen(`/api/public/stream?tournament=${tid}`);
  const r2 = await s2.ready;
  s2.close();
  const other = sseOpen(`/api/public/stream?club=${CLUB_A}`);
  const r3 = await other.ready;
  other.close();
  t.diagnostic(`/api/public/tournaments/{id}/stream: 200, bracket ${ev.raw.length} симв., без id и телефонов; /api/public/stream?tournament= — ${r2.status}; канал клуба без входа — ${r3.status}`);
  assert.ok(r3.status >= 400, 'канал клуба без входа закрыт');
});

const PAGES = ['/', '/ekaterinburg/', '/ekaterinburg/testovyy-klub/', '/ekaterinburg/demo-bez-programmy/', '/turniry/', '/rejting/', '/plus/', '/dlya-klubov/', '/dlya-biznesa/', '/zhurnal/'];

test('сайт: страницы 200, lang=ru, canonical, мета-описание, JSON-LD разбирается, без ПДн', async (t) => {
  const pages = [...PAGES, ...(tid ? [`/turniry/${tid}/`] : [])];
  const out = [];
  for (const p of pages) {
    const r = await api('GET', p, { headers: { accept: 'text/html' } });
    assert.equal(r.status, 200, `${p}: ${r.status}`);
    const html = r.text;
    assert.match(html, /<html[^>]*lang="ru"/, `${p}: lang`);
    const canon = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1];
    assert.ok(canon, `${p}: canonical`);
    assert.match(html, /<meta name="description" content="[^"]{20,}"/, `${p}: description`);
    const types = [];
    for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      const j = JSON.parse(m[1]);
      for (const x of [].concat(j['@graph'] ?? j)) types.push(x['@type']);
    }
    const l = leaks(html);
    assert.deepEqual(l, { ids: [], phones: [] }, `${p}: ПДн`);
    assert.ok(!/mc\.yandex|googletagmanager|facebook|connect\.facebook/.test(html), `${p}: внешние счётчики`);
    const ext = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith(BASE) && !/^https:\/\/(localhost|billiardum)/.test(u) && !/schema\.org/.test(u));
    out.push(`${p} ${Math.round(r.text.length / 1024)} КБ [${types.join(',')}]${ext.length ? ` внешние: ${ext.slice(0, 3).join(' ')}` : ''}`);
  }
  const sm = await api('GET', '/sitemap.xml', { headers: { accept: 'application/xml' } });
  assert.equal(sm.status, 200);
  assert.match(sm.text, /<urlset/);
  const rb = await api('GET', '/robots.txt', { headers: { accept: 'text/plain' } });
  assert.equal(rb.status, 200);
  assert.match(rb.text, /Sitemap:/);
  const nf = await api('GET', '/net-takogo-goroda/', { headers: { accept: 'text/html' } });
  t.diagnostic(`${out.join('; ')}; sitemap ${(sm.text.match(/<loc>/g) ?? []).length} адресов; robots: ${rb.text.replace(/\n/g, ' | ').slice(0, 160)}; неизвестный город — ${nf.status}`);
  assert.equal(nf.status, 404);
  const club = await api('GET', '/ekaterinburg/testovyy-klub/', { headers: { accept: 'text/html' } });
  assert.match(club.text, /SportsActivityLocation/);
  assert.match(club.text, /BreadcrumbList/);
});
