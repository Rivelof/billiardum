// T45 «API клуба»: ключ (показ один раз, хеш, не больше 5), права (scopes), отзыв, лимиты 600/60,
// ответы без ПДн, только свой клуб, кривой курсор — 400 (docs/api/club-api-v1.md, решения №199–202).
// Вживую на стенде через Caddy, только API.
//
//   * свои клубы: A и A2 одного владельца, B другого (test, по 2 стола);
//   * клуб сида — один ключ на время теста (там есть брони, игры и продажи для проверки ПДн и
//     сверки продаж с выгрузкой дашборда), в конце отзывается.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { addDays, api, apiWait, CLUB_SEED, EKB_TZ, fullPhones, invite, login, newClub, saveState, SCOPES, SEED_PHONES, short, sleep, workingDay } from './lib.mjs';

const S = { keys: [] };
const v1 = (path, key, headers = {}) => api('GET', `/api/v1/club${path}`, { headers: { ...headers, ...(key ? { authorization: `Bearer ${key}` } : {}) } });
const mask = (k) => `${k.slice(0, 12)}…(${k.length})`;

async function createKey(club, token, body) {
  for (let i = 0; ; i += 1) {
    const r = await api('POST', `/api/clubs/${club}/api-keys`, { token, club, body });
    if (r.status === 429 && i < 6) {
      await sleep(Number(r.headers['retry-after'] ?? 10) * 1000 + 300);
      continue;
    }
    if (r.status === 201) S.keys.push({ club, token, id: r.json.key_id });
    return r;
  }
}
const revoke = (club, token, id) => apiWait('POST', `/api/clubs/${club}/api-keys/${id}/revoke`, { token, club, body: {} });

before(async () => {
  const a = await newClub({ name: `E2E M5.7 API A ${Date.now() % 100000}`, tables: 2 });
  S.A = a.club;
  S.ownerA = a.owner;
  S.resA = a.resources;
  const a2 = await api('POST', '/api/clubs', { token: S.ownerA.token, body: { name: `E2E M5.7 API A2 ${Date.now() % 100000}`, city_name: 'Екатеринбург', timezone: EKB_TZ } });
  assert.equal(a2.status, 201, short(a2));
  S.A2 = a2.json.club_id;
  await api('POST', `/api/clubs/${S.A2}/resources`, { token: S.ownerA.token, club: S.A2, body: { number: 7, kind: 'snooker' } });
  const b = await newClub({ name: `E2E M5.7 API B ${Date.now() % 100000}`, tables: 1 });
  S.B = b.club;
  S.ownerB = b.owner;
  S.managerA = await invite(S.A, S.ownerA.token, 'manager');
  S.receptionA = await invite(S.A, S.ownerA.token, 'reception');
  S.seedOwner = await login(SEED_PHONES.owner);
  S.seedManager = await login(SEED_PHONES.manager);
  saveState({ apiA: S.A, apiA2: S.A2, apiB: S.B, apiOwnerA: S.ownerA.phone, apiOwnerB: S.ownerB.phone });
});

after(async () => {
  // Уборка: все ключи, выпущенные тестом, отзываются (в т. ч. ключ клуба сида).
  for (const k of S.keys) await revoke(k.club, k.token, k.id);
});

test('T45-1: выпуск — только владелец личным входом; ключ показан один раз, в списке и журнале его нет', async (t) => {
  for (const [who, tok] of [['управляющий', S.managerA.token], ['ресепшн', S.receptionA.token], ['владелец B', S.ownerB.token]]) {
    const r = await api('POST', `/api/clubs/${S.A}/api-keys`, { token: tok, club: S.A, body: { name: 'x', scopes: ['tables:read'] } });
    assert.equal(r.status, 403, `${who}: ${short(r)}`);
    const l = await api('GET', `/api/clubs/${S.A}/api-keys`, { token: tok, club: S.A });
    assert.equal(l.status, 403, `${who} список: ${short(l)}`);
  }
  const bad = [];
  for (const body of [{ name: '', scopes: ['tables:read'] }, { name: 'x', scopes: [] }, { name: 'x', scopes: ['tables:write'] }, { name: 'x' }, { name: 'я'.repeat(200), scopes: ['tables:read'] }]) {
    const r = await createKey(S.A, S.ownerA.token, body);
    bad.push(`${JSON.stringify(body).slice(0, 40)} ${r.status}`);
    assert.equal(r.status, 400, `${JSON.stringify(body).slice(0, 60)}: ${short(r)}`);
    assert.deepEqual(Object.keys(r.json), ['error']);
  }
  const r = await createKey(S.A, S.ownerA.token, { name: 'E2E CRM', scopes: SCOPES });
  assert.equal(r.status, 201, short(r));
  S.keyA = r.json.key;
  S.keyAId = r.json.key_id;
  assert.match(S.keyA, /^blk_[A-Za-z0-9_-]{43}$/);
  assert.equal(r.json.prefix, S.keyA.slice(0, 12));
  assert.deepEqual([...r.json.scopes].sort(), [...SCOPES].sort());
  assert.equal(r.json.active, true);
  assert.equal(r.headers['cache-control']?.includes('no-store'), true, `cache-control: ${r.headers['cache-control']}`);
  const list = await api('GET', `/api/clubs/${S.A}/api-keys`, { token: S.ownerA.token, club: S.A });
  assert.equal(list.status, 200);
  assert.equal(list.json.limit, 5);
  assert.equal(list.json.active, 1);
  assert.ok(!list.text.includes(S.keyA), 'ключа нет в списке');
  assert.ok(!list.text.includes(S.keyA.slice(12)), 'хвоста ключа нет в списке');
  assert.equal(list.json.items[0].key, undefined);
  assert.equal(list.json.items[0].key_hash, undefined);
  assert.deepEqual([...list.json.scopes].sort(), [...SCOPES].sort());
  const au = await api('GET', `/api/clubs/${S.A}/audit?action=api_key.*`, { token: S.ownerA.token, club: S.A });
  assert.equal(au.status, 200);
  assert.ok(au.json.items.some((x) => x.action === 'api_key.create' && x.data.prefix === r.json.prefix));
  assert.ok(!au.text.includes(S.keyA.slice(12)), 'ключа нет в журнале');
  // Одинаковые запросы выпуска — разные ключи (повтор ответа не хранится).
  const r2 = await createKey(S.A, S.ownerA.token, { name: 'E2E CRM', scopes: ['tables:read'] });
  assert.equal(r2.status, 201);
  assert.notEqual(r2.json.key, S.keyA);
  S.keyTablesOnly = r2.json.key;
  S.keyTablesOnlyId = r2.json.key_id;
  t.diagnostic(`управляющий/ресепшн/чужой владелец — 403 (выпуск и список); неверные тела: ${bad.join('; ')}; ключ ${mask(S.keyA)} формат blk_+43, prefix = 12 первых символов, Cache-Control ${r.headers['cache-control']}; в списке и журнале (api_key.create) ключа нет`);
});

test('T45-2: вход по ключу — без ключа, чужой, токен пользователя, cookie, не Bearer — 401; методы кроме GET — 405', async (t) => {
  const out = [];
  const cases = [
    ['без заголовка', {}],
    ['случайный blk_', { authorization: `Bearer blk_${'A'.repeat(43)}` }],
    ['обрезанный ключ', { authorization: `Bearer ${S.keyA.slice(0, -1)}` }],
    ['токен владельца', { authorization: `Bearer ${S.ownerA.token}` }],
    ['Basic', { authorization: `Basic ${Buffer.from(`${S.keyA}:`).toString('base64')}` }],
    ['ключ строчными Bearer', { authorization: `bearer ${S.keyA}` }],
    ['cookie сессии', { cookie: `bl_session=${S.ownerA.token}` }],
  ];
  for (const [name, h] of cases) {
    const r = await api('GET', '/api/v1/club/tables', { headers: h });
    out.push(`${name} ${r.status}`);
    if (name === 'ключ строчными Bearer') {
      assert.ok([200, 401].includes(r.status), name);
      continue;
    }
    assert.deepEqual([r.status, r.json], [401, { error: 'unauthorized' }], `${name}: ${short(r)}`);
  }
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const r = await api(m, '/api/v1/club/tables', { headers: { authorization: `Bearer ${S.keyA}` }, body: {} });
    out.push(`${m} ${r.status}`);
    assert.equal(r.status, 405, `${m}: ${short(r)}`);
  }
  const nf = await v1('/sessions', S.keyA);
  assert.equal(nf.status, 404, short(nf));
  t.diagnostic(out.join('; ') + `; /api/v1/club/sessions — ${nf.status}`);
});

test('T45-3: ключ — только свой клуб; X-Club-Id, ?club= и ?club_id= не подменяют; у владельца двух клубов ключ A не видит A2', async (t) => {
  const r = await v1('/tables', S.keyA);
  assert.equal(r.status, 200, short(r));
  assert.equal(r.json.club.id, S.A);
  assert.deepEqual(r.json.tables.map((x) => x.resource_id).sort(), S.resA.map((x) => x.id).sort());
  for (const [name, path, h] of [
    ['X-Club-Id A2', '/tables', { 'x-club-id': S.A2 }],
    ['X-Club-Id сида', '/tables', { 'x-club-id': CLUB_SEED }],
    ['?club=A2', `/tables?club=${S.A2}`, {}],
    ['?club_id=сид', `/tables?club_id=${CLUB_SEED}`, {}],
  ]) {
    const x = await v1(path, S.keyA, h);
    if (x.status === 400) continue; // неизвестный параметр — тоже честно
    assert.equal(x.status, 200, `${name}: ${short(x)}`);
    assert.equal(x.json.club.id, S.A, name);
  }
  // Ключ сида для данных и ПДн.
  const k = await createKey(CLUB_SEED, S.seedOwner.token, { name: 'E2E M5.7 tester (отзывается в конце)', scopes: SCOPES });
  assert.equal(k.status, 201, short(k));
  S.keySeed = k.json.key;
  S.keySeedId = k.json.key_id;
  const s = await v1('/tables', S.keySeed);
  assert.equal(s.json.club.id, CLUB_SEED);
  assert.equal(s.json.tables.length, 10, 'у сида 10 ресурсов (столы 1–8 и 2 корта)');
  assert.ok(!s.json.tables.some((x) => S.resA.some((y) => y.id === x.resource_id)));
  const ka = (await v1('/tables', S.keyA)).json.tables.map((x) => x.resource_id);
  assert.ok(!ka.some((id) => s.json.tables.some((x) => x.resource_id === id)), 'ключ A не видит столы сида');
  t.diagnostic(`ключ A: клуб A, ${r.json.tables.length} стола; подмена клуба заголовком и параметром — тот же клуб A; ключ сида ${mask(S.keySeed)}: 10 ресурсов (${s.json.tables.map((x) => `${x.number}:${x.type.replace('billiard_', '')}`).join(' ')})`);
});

test('T45-4: права — без scope 403 scope_required, с ним 200; на всех 5 маршрутах', async (t) => {
  const paths = { 'tables:read': '/tables', 'tariffs:read': '/tariffs', 'availability:read': '/availability', 'sales:read': '/sales', 'bookings:read': '/bookings' };
  const out = [];
  for (const [scope, path] of Object.entries(paths)) {
    const ok = await v1(path, S.keyA);
    assert.equal(ok.status, 200, `${path} с правом: ${short(ok)}`);
    const only = await v1(path, S.keyTablesOnly);
    if (scope === 'tables:read') assert.equal(only.status, 200);
    else assert.deepEqual([only.status, only.json], [403, { error: 'scope_required' }], `${path}: ${short(only)}`);
    out.push(`${path} ${ok.status}/${only.status}`);
  }
  t.diagnostic(`всё / только tables:read: ${out.join(', ')}`);
});

test('T45-5: ответы без ПДн (клуб сида): нет телефонов, имён гостей, user_id, id игр; поля — по белому списку', async (t) => {
  const day = workingDay();
  const paths = ['/tables', '/tariffs', `/availability?date=${day}`, `/sales?from=${addDays(day, -4)}&to=${day}`, `/bookings?from=${addDays(day, -30)}&to=${addDays(day, 30)}&limit=1000`];
  const keys = new Set();
  const walk = (v, p = '') => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, `${p}[]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
      keys.add(`${p}.${k}`.replace(/^\./, ''));
      walk(x, `${p}.${k}`);
    }
  };
  const texts = [];
  for (const p of paths) {
    const r = await apiWait('GET', `/api/v1/club${p}`, { headers: { authorization: `Bearer ${S.keySeed}` } });
    assert.equal(r.status, 200, `${p}: ${short(r)}`);
    walk(r.json, p.split('?')[0]);
    texts.push(r.text);
  }
  const all = texts.join('\n');
  assert.deepEqual(fullPhones(all), [], 'телефонов нет');
  assert.doesNotMatch(all, /\+7\d{3}\*{3}\d{4}|\*\*\*/, 'масок телефонов нет');
  const bad = [...keys].filter((k) => /phone|user|guest|payer|player|session|email|nick|first_name|last_name|members|staff|actor|created_by|comment|note/i.test(k));
  assert.deepEqual(bad, [], `запрещённые поля: ${bad.join(', ')}`);
  const names = [...keys].filter((k) => /(^|\.)name$/.test(k));
  assert.deepEqual(names.map((k) => k.replace(/^\/\w+\./, '')).filter((k) => k !== 'club.name'), [], `name только у клуба: ${names.join(', ')}`);
  // Имена гостей сида («Гость …») и сотрудников — нигде.
  assert.doesNotMatch(all, /Гость|Владелец \(тест\)|Управляющий|Ресепшн/);
  const b = JSON.parse(texts[4]);
  const bk = new Set(b.items.flatMap((x) => Object.keys(x)));
  assert.deepEqual([...bk].sort(), ['booking_id', 'canceled_at', 'created_at', 'ends_at', 'resource_id', 'resource_number', 'resource_type', 'source', 'starts_at', 'status', 'test'].sort());
  t.diagnostic(`маршрутов ${paths.length}, полей ${keys.size}, броней ${b.items.length}; телефонов, масок, имён гостей и персонала, user_id/session_id нет; поля брони: ${[...bk].sort().join(', ')}`);
});

test('T45-6: продажи по ключу = выгрузка дашборда revenue_daily до копейки (клуб сида, 4 суток)', async (t) => {
  const day = workingDay();
  const from = addDays(day, -4);
  const to = addDays(day, -1);
  const s = await apiWait('GET', `/api/v1/club/sales?from=${from}&to=${to}`, { headers: { authorization: `Bearer ${S.keySeed}` } });
  assert.equal(s.status, 200, short(s));
  const csv = await apiWait('GET', `/api/clubs/${CLUB_SEED}/dashboard/export.csv?table=revenue_daily&from=${from}&to=${to}`, { token: S.seedOwner.token, club: CLUB_SEED });
  assert.equal(csv.status, 200, short(csv));
  const lines = csv.text.replace(/^\uFEFF/, '').trim().split(/\r?\n/).map((l) => l.split(';'));
  const head = lines[0];
  const rub = (x) => Math.round(Number(String(x).replace(/\s/g, '').replace(',', '.')) * 100);
  const col = (re) => head.findIndex((h) => re.test(h));
  const iDate = col(/дата|сутки/i);
  const iTotal = col(/^выручка/i);
  assert.ok(iDate >= 0 && iTotal >= 0, `столбцы CSV: ${head.join(' | ')}`);
  const out = [];
  for (const d of s.json.days) {
    const ddmmyyyy = `${d.date.slice(8, 10)}.${d.date.slice(5, 7)}.${d.date.slice(0, 4)}`;
    const row = lines.find((l) => l[iDate] === ddmmyyyy || l[iDate] === d.date);
    assert.ok(row, `строка ${d.date} в CSV`);
    assert.equal(d.total_kopecks, rub(row[iTotal]), `${d.date}: ${d.total_kopecks} vs ${row[iTotal]}`);
    out.push(`${d.date} ${d.total_kopecks}`);
  }
  assert.equal(s.json.totals.total_kopecks, s.json.days.reduce((a, d) => a + d.total_kopecks, 0));
  assert.equal(s.json.totals.net_kopecks, s.json.totals.total_kopecks - s.json.totals.refunds_kopecks);
  const bm = s.json.totals.by_method;
  assert.equal(bm.cash + bm.card_terminal + bm.sbp + bm.card, s.json.totals.total_kopecks, 'сумма способов = выручка');
  // Период > 366 суток, перевёрнутый, кривые даты — 400.
  for (const q of [`from=${addDays(day, -400)}&to=${day}`, `from=${day}&to=${addDays(day, -2)}`, 'from=2026-13-01', 'kind=padel', 'from=2026-10-01&to=2026-10-02x']) {
    const x = await apiWait('GET', `/api/v1/club/sales?${q}`, { headers: { authorization: `Bearer ${S.keySeed}` } });
    assert.deepEqual([x.status, x.json], [400, { error: 'bad_request' }], `${q}: ${short(x)}`);
  }
  t.diagnostic(`CSV «${head[iTotal]}» = sales.days.total_kopecks: ${out.join(', ')}; итог ${s.json.totals.total_kopecks}, способы сходятся; плохие периоды — 400`);
});

test('T45-7: брони — курсор: страницы по 1 без повторов; кривой курсор — 400; лимит > 1000 и период > 93 — 400', async (t) => {
  const day = workingDay();
  const q = `from=${addDays(day, -30)}&to=${addDays(day, 30)}`;
  const full = await apiWait('GET', `/api/v1/club/bookings?${q}&limit=1000`, { headers: { authorization: `Bearer ${S.keySeed}` } });
  assert.equal(full.status, 200);
  const n = Math.min(full.json.items.length, 6);
  const seen = [];
  let cursor = null;
  for (let i = 0; i < n; i += 1) {
    const r = await apiWait('GET', `/api/v1/club/bookings?${q}&limit=1${cursor ? `&cursor=${cursor}` : ''}`, { headers: { authorization: `Bearer ${S.keySeed}` } });
    assert.equal(r.status, 200, short(r));
    assert.equal(r.json.items.length, 1);
    seen.push(r.json.items[0].booking_id);
    cursor = r.json.next_cursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, full.json.items.slice(0, seen.length).map((x) => x.booking_id), 'страницы = полный список по порядку');
  assert.equal(new Set(seen).size, seen.length);
  const good = cursor ?? Buffer.from(JSON.stringify([new Date().toISOString(), '00000000-0000-4000-8000-000000000000'])).toString('base64url');
  const crooked = [
    ['мусор', 'abc$%'],
    ['не base64url', 'eyJ!!'],
    ['JSON не массив', Buffer.from('{"a":1}').toString('base64url')],
    ['время не ISO', Buffer.from(JSON.stringify(['1', '00000000-0000-4000-8000-000000000000'])).toString('base64url')],
    ['не UUID', Buffer.from(JSON.stringify([new Date().toISOString(), "x' or 1=1"])).toString('base64url')],
    ['три элемента', Buffer.from(JSON.stringify([new Date().toISOString(), '00000000-0000-4000-8000-000000000000', 1])).toString('base64url')],
    ['хвост к хорошему', `${good}A`],
    ['паддинг', `${good}==`],
    ['длинный', 'A'.repeat(600)],
  ];
  const out = [];
  for (const [name, c] of crooked) {
    const r = await apiWait('GET', `/api/v1/club/bookings?${q}&cursor=${encodeURIComponent(c)}`, { headers: { authorization: `Bearer ${S.keySeed}` } });
    out.push(`${name} ${r.status}`);
    assert.deepEqual([r.status, r.json], [400, { error: 'bad_request' }], `${name}: ${short(r)}`);
  }
  for (const qq of [`${q}&limit=1001`, `${q}&limit=0`, `from=${addDays(day, -100)}&to=${day}`, `${q}&status=lost`, `${q}&kind=x`]) {
    const r = await apiWait('GET', `/api/v1/club/bookings?${qq}`, { headers: { authorization: `Bearer ${S.keySeed}` } });
    assert.deepEqual([r.status, r.json], [400, { error: 'bad_request' }], `${qq}: ${short(r)}`);
  }
  t.diagnostic(`броней в периоде ${full.json.items.length}, страниц по 1: ${seen.length} без повторов и пропусков; кривые курсоры: ${out.join('; ')}; limit 1001/0, 100 суток, status/kind — 400`);
});

test('T45-8: не больше 5 активных ключей: шестой — 409 api_keys_limit; после отзыва — можно', async (t) => {
  const list = async () => (await apiWait('GET', `/api/clubs/${S.B}/api-keys`, { token: S.ownerB.token, club: S.B })).json;
  const made = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await createKey(S.B, S.ownerB.token, { name: `E2E B ${i}`, scopes: ['tables:read'] });
    assert.equal(r.status, 201, short(r));
    made.push(r.json);
  }
  assert.equal((await list()).active, 5);
  const sixth = await createKey(S.B, S.ownerB.token, { name: 'E2E B 6', scopes: ['tables:read'] });
  assert.deepEqual([sixth.status, sixth.json], [409, { error: 'api_keys_limit' }]);
  // Параллельно два выпуска при 4 активных — проходит ровно один.
  const rv = await revoke(S.B, S.ownerB.token, made[0].key_id);
  assert.equal(rv.status, 200);
  const both = await Promise.all([createKey(S.B, S.ownerB.token, { name: 'E2E B p1', scopes: ['tables:read'] }), createKey(S.B, S.ownerB.token, { name: 'E2E B p2', scopes: ['tables:read'] })]);
  const st = both.map((x) => x.status).sort();
  assert.deepEqual(st, [201, 409], `гонка: ${both.map(short).join(' | ')}`);
  assert.equal((await list()).active, 5);
  t.diagnostic(`5 × 201, шестой 409 api_keys_limit; после отзыва два параллельных выпуска — ${st.join(' и ')}; активных 5`);
});

test('T45-9: отзыв — ключ сразу 401; повтор отзыва — тот же ответ; журнал api_key.revoke без ключа; чужой отозвать нельзя', async (t) => {
  assert.equal((await v1('/tables', S.keyTablesOnly)).status, 200);
  const foreign = await api('POST', `/api/clubs/${S.B}/api-keys/${S.keyTablesOnlyId}/revoke`, { token: S.ownerB.token, club: S.B, body: {} });
  assert.equal(foreign.status, 404, `ключ A через клуб B: ${short(foreign)}`);
  const foreign2 = await api('POST', `/api/clubs/${S.A}/api-keys/${S.keyTablesOnlyId}/revoke`, { token: S.ownerB.token, club: S.A, body: {} });
  assert.equal(foreign2.status, 403, short(foreign2));
  const mgr = await api('POST', `/api/clubs/${S.A}/api-keys/${S.keyTablesOnlyId}/revoke`, { token: S.managerA.token, club: S.A, body: {} });
  assert.equal(mgr.status, 403);
  assert.equal((await v1('/tables', S.keyTablesOnly)).status, 200, 'ключ жив после чужих попыток');
  const r = await revoke(S.A, S.ownerA.token, S.keyTablesOnlyId);
  assert.equal(r.status, 200, short(r));
  assert.equal(r.json.active, false);
  const x = await v1('/tables', S.keyTablesOnly);
  assert.deepEqual([x.status, x.json], [401, { error: 'unauthorized' }]);
  const again = await revoke(S.A, S.ownerA.token, S.keyTablesOnlyId);
  assert.equal(again.status, 200);
  assert.equal(again.json.revoked_at, r.json.revoked_at);
  const au = await apiWait('GET', `/api/clubs/${S.A}/audit?action=api_key.revoke`, { token: S.ownerA.token, club: S.A });
  assert.equal(au.json.items.length, 1, 'одна запись отзыва');
  assert.ok(!au.text.includes(S.keyTablesOnly.slice(12)));
  t.diagnostic(`чужой владелец — 404/403, управляющий — 403, ключ жив; отзыв — 200 active:false, следующий запрос 401; повтор — тот же revoked_at; журнал api_key.revoke — 1, без ключа`);
});

test('T45-10: лимиты — 600 в минуту на ключ (по всем маршрутам), 60 на продажи; у другого ключа свои', async (t) => {
  // Новое минутное окно для свежих ключей.
  const k1 = (await createKey(S.A, S.ownerA.token, { name: 'E2E лимит 1', scopes: SCOPES })).json;
  const k2 = (await createKey(S.A, S.ownerA.token, { name: 'E2E лимит 2', scopes: SCOPES })).json;
  assert.ok(k1?.key && k2?.key, 'ключи выпущены');
  // Продажи: 60 проходят, 61-й — 429 с Retry-After; у второго ключа продажи работают.
  let sales200 = 0;
  let sales429 = null;
  for (let i = 0; i < 61; i += 1) {
    const r = await v1('/sales', k1.key);
    if (r.status === 200) sales200 += 1;
    else {
      sales429 = r;
      break;
    }
  }
  assert.equal(sales200, 60, `продаж до отказа: ${sales200}`);
  assert.deepEqual([sales429?.status, sales429?.json], [429, { error: 'rate_limited' }]);
  assert.ok(Number(sales429.headers['retry-after']) > 0, 'Retry-After');
  assert.equal((await v1('/sales', k2.key)).status, 200, 'у второго ключа продажи свои');
  assert.equal((await v1('/tables', k1.key)).status, 200, 'другие маршруты ключа работают');
  // Общий лимит ключа: 600 в минуту по маршрутам вместе (60 продаж + 2 столов уже); добираем
  // параллельно по tables/tariffs/bookings — чтобы не упереться в лимит роутера по IP и маршруту (600).
  const routes = ['/tables', '/tariffs', '/bookings'];
  let n200 = 62;
  let first429 = null;
  const t0 = Date.now();
  for (let batch = 0; batch < 40 && !first429; batch += 1) {
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => v1(routes[(batch * 20 + i) % 3], k1.key)));
    for (const r of rs) {
      if (r.status === 200) n200 += 1;
      else if (r.status === 429 && !first429) first429 = r;
      else if (r.status !== 429) assert.fail(`неожиданный ответ ${short(r)}`);
    }
  }
  const secs = (Date.now() - t0) / 1000;
  assert.ok(first429, 'дошли до 429');
  assert.equal(n200, 600, `успешных за минуту: ${n200}`);
  assert.deepEqual(first429.json, { error: 'rate_limited' });
  const other = await v1('/tables', k2.key);
  assert.equal(other.status, 200, 'второй ключ работает');
  t.diagnostic(`продажи: 60 × 200, 61-й 429 rate_limited, Retry-After ${sales429.headers['retry-after']} с; второй ключ — 200. Общий: 600 × 200 за ${secs.toFixed(1)} с, затем 429 (Retry-After ${first429.headers['retry-after']}); второй ключ — 200`);
});

test('T45-11: транзакция ключа только для чтения: last_used_at обновляется, лишних записей журнала нет', async (t) => {
  const before = (await apiWait('GET', `/api/clubs/${S.A}/audit?limit=200`, { token: S.ownerA.token, club: S.A })).json.items.length;
  await v1('/tables', S.keyA);
  await v1('/bookings', S.keyA);
  const after = (await apiWait('GET', `/api/clubs/${S.A}/audit?limit=200`, { token: S.ownerA.token, club: S.A })).json.items.length;
  assert.equal(after, before, 'запросы по ключу не пишут журнал');
  const list = (await apiWait('GET', `/api/clubs/${S.A}/api-keys`, { token: S.ownerA.token, club: S.A })).json;
  const k = list.items.find((x) => x.key_id === S.keyAId);
  assert.ok(k.last_used_at, 'last_used_at есть');
  t.diagnostic(`журнал клуба A: ${before} → ${after}; last_used_at ${k.last_used_at}`);
});

test('T45-12: отзыв ключа сида и остальных — в конце (after); ключ сида не работает', async () => {
  const r = await revoke(CLUB_SEED, S.seedOwner.token, S.keySeedId);
  assert.equal(r.status, 200);
  assert.equal((await v1('/tables', S.keySeed)).status, 401);
  const l = (await apiWait('GET', `/api/clubs/${CLUB_SEED}/api-keys`, { token: S.seedOwner.token, club: CLUB_SEED })).json;
  assert.equal(l.active, 0, 'у сида не осталось активных ключей');
});

