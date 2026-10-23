// PoC M4 на поднятом стенде (https://localhost:8443). Только стол 8 (пул), игроки +7999 64x,
// турнир отменяется в конце. Пропускается без BL_LIVE=1.
//
//   BL_LIVE=1 NODE_EXTRA_CA_CERTS=<корень Caddy> BL_LIVE_DB_URL=<DATABASE_ADMIN_URL стенда, только чтение> \
//     node --test --test-concurrency=1 tests/security/m4/live_stand.test.mjs
//
// НАХОДКА M4-6 (низкая): лимит публичного API 120/мин с IP обходится через сайт. Сайт ходит в API
// из PUBLIC_API_TRUSTED_CIDRS без лимита (api/router.mjs ~стр. 266–271), а у самого сайта
// (web/site/server.mjs) ограничения частоты нет: каждый новый адрес /{город}/{клуб}/ — новый запрос
// к API и базе (кэш сайта — по пути). 130 запросов за секунды — ни одного 429/503.
//
// Выдержало: /api/public/* — без телефонов гостей, user_id и токенов; ответ с токеном тот же, что
// анонимный (me: null, кэш общий); публичный поток турнира — только события bracket/ready;
// турнир на столе 8: свет только командой сервера (session.start source tournament, device.cmd
// в журнале, команда в очереди устройства), QR и бронь на столе турнира — 409 reason tournament,
// отмена — причина, тревога manual_action владельцу, свет гаснет; журнал клуба сходится.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';

const LIVE = process.env.BL_LIVE === '1';
const BASE = process.env.BL_LIVE_BASE ?? 'https://localhost:8443';
const CLUB_A = 'c1000000-0000-4000-8000-000000000001';
const TABLE8 = 'e1000000-0000-4000-8000-000000000008';
const ORIGIN = BASE;

let db = null;
const t0 = Date.now();

async function call(method, path, { body, token, headers = {} } = {}) {
  const h = { accept: 'application/json', ...headers };
  if (method !== 'GET') {
    h['content-type'] = 'application/json';
    h.origin = ORIGIN;
  }
  if (token) h.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function login(phone) {
  const r = await call('POST', '/api/auth/dev', { body: { phone } });
  assert.equal(r.status, 200, r.text);
  const token = r.json.token;
  const v = process.env.BL_LIVE_CONSENT ?? '2026-10-21';
  const c = await call('POST', '/api/auth/consent', { token, body: { version: v } });
  assert.equal(c.status, 200, c.text);
  return { token, id: r.json.user.id, phone };
}

before(async () => {
  if (!LIVE) return;
  if (process.env.BL_LIVE_DB_URL) {
    db = new pg.Client({ connectionString: process.env.BL_LIVE_DB_URL });
    await db.connect();
  }
});
after(async () => {
  await db?.end();
});

const PHONE_RE = /\+?7[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/;

function scan(v, path, out, { allowPhone = false } = {}) {
  if (Array.isArray(v)) v.forEach((x, i) => scan(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (['user_id', 'guest_phone', 'token', 'email', 'payer_user_id', 'contact_user_id', 'created_by'].includes(k)) out.push(`${path}.${k}`);
      scan(x, `${path}.${k}`, out, { allowPhone: k === 'phone' && /\.club$/.test(path) });
    }
  } else if (typeof v === 'string' && PHONE_RE.test(v) && !allowPhone) out.push(`${path}=${v}`);
}

test('выдержало: /api/public/* без ПДн; ответ с токеном — общий анонимный', { skip: !LIVE }, async () => {
  const paths = ['/api/public/cities', '/api/public/cities/ekaterinburg', '/api/public/clubs/ekaterinburg/testovyy-klub', '/api/public/tournaments'];
  for (const d of ['pyramid', 'pool', 'snooker']) for (const s of ['country', 'city&city=ekaterinburg', `club&club=${CLUB_A}`]) paths.push(`/api/public/rating?discipline=${d}&scope=${s}`);
  const list = (await call('GET', '/api/public/tournaments')).json?.items ?? [];
  for (const t of list.slice(0, 5)) paths.push(`/api/public/tournaments/${t.id}`);
  const bad = [];
  for (const p of paths) {
    const r = await call('GET', p);
    assert.equal(r.status, 200, `${p}: ${r.status}`);
    assert.match(r.headers.get('cache-control') ?? '', /public, max-age=60/, p);
    scan(r.json, p, bad);
  }
  assert.deepEqual(bad, [], 'нет user_id, телефонов гостей и токенов');
  // С токеном — тот же общий ответ (токен не читается), me: null.
  const g = await login('+79996400001');
  const anon = await call('GET', `/api/public/rating?discipline=pool&scope=country&x=${t0}`);
  const auth = await call('GET', `/api/public/rating?discipline=pool&scope=country&x=${t0}`, { token: g.token });
  assert.equal(auth.json.me, null);
  assert.equal(auth.text, anon.text);
});

test('НАХОДКА M4-6 (низкая): через сайт публичный API без лимита — 130 новых адресов подряд без 429/503', { skip: !LIVE }, async () => {
  const codes = {};
  const started = Date.now();
  for (let i = 0; i < 130; i += 1) {
    const r = await fetch(`${BASE}/ekaterinburg/pentest-${t0}-${i}/`, { headers: { accept: 'text/html' } });
    await r.arrayBuffer();
    codes[r.status] = (codes[r.status] ?? 0) + 1;
  }
  console.log(`  130 запросов к сайту за ${Date.now() - started} мс: ${JSON.stringify(codes)}`);
  assert.equal(codes[404], 130, 'каждый — запрос в API, лимита нет');
  assert.equal(codes[429] ?? 0, 0);
  assert.equal(codes[503] ?? 0, 0, 'API не ограничил сайт');
});

test('выдержало: публичный поток турнира — только события сетки; лишние параметры — 400', { skip: !LIVE }, async () => {
  const list = (await call('GET', '/api/public/tournaments')).json?.items ?? [];
  const id = list[0]?.id ?? randomUUID();
  assert.equal((await call('GET', `/api/public/stream?tournament=${id}&channel=club:${CLUB_A}`)).status, 400);
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/public/stream?tournament=${id}`, { signal: ctrl.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  let text = '';
  const stop = setTimeout(() => ctrl.abort(), 1500);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
  } catch {
    // abort
  } finally {
    clearTimeout(stop);
  }
  const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
  assert.ok(events.every((e) => ['ready', 'bracket', 'tournament', 'match'].includes(e)), events.join(','));
  assert.ok(!PHONE_RE.test(text) && !text.includes('user_id'));
});

test('выдержало: турнир на столе 8 — свет только командой сервера, QR и бронь заблокированы, отмена с тревогой', { skip: !LIVE }, async () => {
  const busy = db ? (await db.query("select count(*)::int as n from bl.sessions where resource_id = $1 and status in ('active','ending','grace','interrupted')", [TABLE8])).rows[0].n : 0;
  assert.equal(busy, 0, 'стол 8 свободен');
  const manager = await login('+70000000003');
  const created = Date.now();
  const starts = new Date(created + 60_000);
  const ends = new Date(created + 180 * 60_000);
  const c = await call('POST', `/api/clubs/${CLUB_A}/tournaments`, {
    token: manager.token,
    body: { title: `Pentest M4 ${t0}`, discipline: 'pool', format: 'single_elim', race_to: 2, fee_kopecks: 0, places: 2, starts_at: starts.toISOString(), ends_at: ends.toISOString(), resource_ids: [TABLE8], publish: true },
  });
  assert.equal(c.status, 201, c.text);
  const tid = c.json.id;
  let canceled;
  try {
    const players = [await login('+79996400011'), await login('+79996400012')];
    for (const [i, p] of players.entries()) {
      await call('PATCH', '/api/plus/me', { token: p.token, body: { nick: `Pentest${t0 % 100000}${i}` } });
      const e = await call('POST', `/api/tournaments/${tid}/entries`, { token: p.token, headers: { 'idempotency-key': randomUUID() }, body: {} });
      assert.equal(e.status, 201, e.text);
      assert.equal(e.json.status, 'confirmed');
    }
    // Бронь на стол 8 внутри окна турнира (слот кратен 30 минутам UTC, через ≥ 20 минут) — отказ.
    const guest = await login('+79996400013');
    const slot = new Date(Math.ceil((Date.now() + 20 * 60_000) / (30 * 60_000)) * 30 * 60_000);
    const b = await call('POST', '/api/bookings', { token: guest.token, body: { resource_id: TABLE8, starts_at: slot.toISOString(), minutes: 60 } });
    console.log(`  бронь в окне турнира: ${b.status} ${b.text}`);
    assert.equal(b.status, 409, 'бронь не принята');
    // Окно турнира началось, матчей ещё нет — QR на столе турнира: 409 table_busy.
    await new Promise((r) => setTimeout(r, Math.max(0, starts.getTime() + 3000 - Date.now())));
    const q = await call('POST', '/api/quotes', { token: guest.token, body: { resource_id: TABLE8, kind: 'start', minutes: 60 } });
    console.log(`  QR-котировка на столе турнира между матчами: ${q.status} ${q.text}`);
    assert.equal(q.status, 409);
    assert.equal(q.json.error, 'table_busy');
    // Замечание (не безопасность): reason 'tournament' в ответе котировки теряется (MoneyError без data).
    // Старт турнира: матч на стол 8, свет по команде сервера.
    const s = await call('POST', `/api/clubs/${CLUB_A}/tournaments/${tid}/start`, { token: manager.token });
    assert.equal(s.status, 200, s.text);
    if (db) {
      await new Promise((r) => setTimeout(r, 1500));
      const [sess] = (await db.query("select id, source, payer_user_id, match_id from bl.sessions where resource_id = $1 and source = 'tournament' and status in ('active','ending','grace') order by started_at desc limit 1", [TABLE8])).rows;
      assert.ok(sess, 'сессия матча');
      assert.equal(sess.payer_user_id, null);
      const au = (await db.query("select action, actor_type from bl.audit_log where club_id = $1 and object_id = $2 order by seq", [CLUB_A, sess.id])).rows;
      assert.ok(au.some((a) => a.action === 'session.start'), 'session.start в журнале');
      const cmds = (await db.query(
        "select a.data->>'type' as type from bl.audit_log a where a.club_id = $1 and a.action = 'device.cmd' and a.created_at > now() - interval '5 minutes' and a.data->>'type' = 'session.start'",
        [CLUB_A],
      )).rows;
      console.log(`  журнал матча: ${au.map((a) => `${a.action}/${a.actor_type}`).join(', ')}; device.cmd session.start за 5 мин: ${cmds.length}`);
      assert.ok(cmds.length >= 1, 'подписанная команда записана в журнал');
    }
    // Игрок не может отменить чужой турнир, ресепшн — тоже.
    const reception = await login('+70000000004');
    assert.equal((await call('POST', `/api/clubs/${CLUB_A}/tournaments/${tid}/cancel`, { token: reception.token, body: { reason: 'x' } })).status, 403);
    assert.equal((await call('POST', `/api/clubs/${CLUB_A}/tournaments/${tid}/cancel`, { token: players[0].token, body: { reason: 'x' } })).status, 403);
    assert.equal((await call('POST', `/api/clubs/${CLUB_A}/tournaments/${tid}/cancel`, { token: manager.token, body: {} })).json.error, 'reason_required');
  } finally {
    const r = await call('POST', `/api/clubs/${CLUB_A}/tournaments/${tid}/cancel`, { token: manager.token, body: { reason: 'pentest M4: проверка завершена' } });
    canceled = r.status === 200;
    console.log(`  отмена турнира: ${r.status}`);
  }
  assert.ok(canceled);
  if (db) {
    await new Promise((r) => setTimeout(r, 1500));
    const open = (await db.query("select count(*)::int as n from bl.sessions where resource_id = $1 and source = 'tournament' and status in ('active','ending','grace')", [TABLE8])).rows[0].n;
    assert.equal(open, 0, 'свет матча погашен');
    const al = (await db.query("select type, level from bl.alarms where club_id = $1 and data->>'tournament_id' = $2", [CLUB_A, tid])).rows;
    assert.ok(al.some((a) => a.type === 'manual_action'), 'тревога владельцу');
    const v = (await db.query('select * from bl.audit_verify($1)', [CLUB_A])).rows[0];
    console.log(`  audit_verify клуба A: ok=${v.ok}, проверено ${v.checked}`);
    assert.equal(v.ok, true);
    const p = (await db.query('select * from bl.audit_verify(null)')).rows[0];
    console.log(`  audit_verify платформы: ok=${p.ok}, проверено ${p.checked}`);
    assert.equal(p.ok, true);
  }
});
