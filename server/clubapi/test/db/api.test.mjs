// T45 (M5.7 №199, №200, №202): ключ API клуба — выпуск владельцем, показ один раз, права (scopes),
// отзыв, лимит 5 активных, лимиты 600 и 60 в минуту, только свой клуб, ответы без ПДн гостей,
// продажи = CSV дашборда, транзакция ключа — только чтение.

import assert from 'node:assert/strict';
import { badCursors } from '../helpers.mjs';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { cache as dashboardCache } from '../../../../api/routes/dashboard.mjs';
import { KEY_LIMIT, withApiContext } from '../../auth.mjs';
import { availability } from '../../../bookings/availability.mjs';
import { withContext } from '../../../lib/store.mjs';
import * as tariffs from '../../../tariffs/index.mjs';
import * as engine from '../../../tariffs/engine.mjs';
import { G1, G2, L, seedDataset } from '../../../dashboard/test/db/harness.mjs';
import { addDays } from '../../../dashboard/time.mjs';
import { allKeys, CLUB, CLUB_B, startClubApi, T } from './harness.mjs';

let t;
let data;
const clock = { now: () => new Date() };
const GUEST_PHONE = '+79995556677';
const GUEST_NAME = 'Пётр Телефонов';
let activeSession;

before(async () => {
  t = await startClubApi({ clock, dashboard: true });
  data = await seedDataset(t.admin, clock.now());
  const now = clock.now();
  // Сейчас: идёт игра на столе 1 (плательщик — гость с телефоном), контроллеры 1 и 2 на связи.
  activeSession = randomUUID();
  await t.admin.query(
    `insert into bl.sessions (id, club_id, resource_id, status, source, payer_user_id, started_at, paid_until, created_at, updated_at)
     values ($1, $2, $3, 'active', 'qr', $4, $5, $6, $5, $5)`,
    [activeSession, CLUB, T(1), G1, new Date(now.getTime() - 600_000), new Date(now.getTime() + 3600_000)],
  );
  await t.admin.query("update bl.devices set device_key_enc = 'v1:dGVzdGtleXRlc3RrZXk=', last_seen_at = now() where resource_id = any($1::uuid[])", [[T(1), T(2)]]);
  // Бронь по телефону на завтра (имя и телефон гостя в базе есть).
  const tomorrow = addDays(data.today, 1);
  await t.admin.query(
    `insert into bl.bookings (club_id, resource_id, guest_name, guest_phone, user_id, source, created_by, starts_at, ends_at, status, prepayment_mode, amount_kopecks, hold_minutes, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'phone', $6, $7, $8, 'confirmed', 'none', 80000, 15, now(), now())`,
    [CLUB, T(2), GUEST_NAME, GUEST_PHONE, G2, 'a1000000-0000-4000-8000-000000000004', L(tomorrow, '19:00'), L(tomorrow, '20:00')],
  );
});

after(async () => {
  await t?.stop();
});

// Лимиты маршрутов владельца по IP (все запросы теста — с 127.0.0.1) не мешают сценариям.
beforeEach(() => t.app.router.rateLimiter.clear());

describe('T45: ключи API', () => {
  it('выпуск — только владелец: ключ показывается один раз, в базе и журнале его нет', async () => {
    for (const who of ['manager', 'reception']) {
      assert.equal((await t.as(who, 'POST', `/api/clubs/${CLUB}/api-keys`, { name: 'x', scopes: ['tables:read'] })).status, 403, who);
      assert.equal((await t.as(who, 'GET', `/api/clubs/${CLUB}/api-keys`)).status, 403, who);
    }
    assert.equal((await t.as('ownerB', 'POST', `/api/clubs/${CLUB}/api-keys`, { name: 'x', scopes: ['tables:read'] })).status, 403);
    assert.equal((await t.as('owner', 'POST', `/api/clubs/${CLUB}/api-keys`, { name: 'x', scopes: ['admin'] })).status, 400);
    assert.equal((await t.as('owner', 'POST', `/api/clubs/${CLUB}/api-keys`, { name: '', scopes: ['tables:read'] })).status, 400);
    const k = await t.newKey(['tables:read', 'sales:read']);
    assert.match(k.key, /^blk_[A-Za-z0-9_-]{43}$/);
    assert.equal(k.prefix, k.key.slice(0, 12));
    assert.deepEqual(k.scopes, ['tables:read', 'sales:read']);
    const list = await t.as('owner', 'GET', `/api/clubs/${CLUB}/api-keys`);
    assert.equal(list.status, 200);
    assert.ok(!list.text.includes(k.key), 'список без ключа');
    assert.ok(!allKeys(list.json).has('key') && !allKeys(list.json).has('key_hash'));
    const item = list.json.items.find((x) => x.key_id === k.key_id);
    assert.equal(item.prefix, k.prefix);
    assert.equal(item.active, true);
    // В базе — только HMAC; ключа нет ни в одной таблице с текстом (ключи, журнал, идемпотентность).
    const row = (await t.admin.query('select key_hash from bl.api_keys where id = $1', [k.key_id])).rows[0];
    assert.match(row.key_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(row.key_hash, k.key);
    for (const [table, col] of [['api_keys', 'key_hash'], ['audit_log', 'data'], ['idempotency_keys', 'response_body']]) {
      const n = (await t.admin.query(`select count(*)::int as n from bl.${table} where ${col}::text like '%' || $1 || '%'`, [k.key.slice(4)])).rows[0].n;
      assert.equal(n, 0, table);
    }
    const audit = (await t.admin.query("select actor_type, actor_id, data from bl.audit_log where action = 'api_key.create' and object_id = $1", [k.key_id])).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_type, 'user');
    assert.deepEqual(audit[0].data, { key_id: k.key_id, name: 'Интеграция', prefix: k.prefix, scopes: ['tables:read', 'sales:read'] });
  });

  it('вход: без ключа, с чужим, с токеном пользователя или cookie — 401; ключ — только свой клуб', async () => {
    const k = await t.newKey(['tables:read']);
    const kb = await t.newKey(['tables:read'], 'ownerB', CLUB_B);
    assert.equal((await t.request('GET', '/api/v1/club/tables')).status, 401);
    assert.deepEqual((await t.request('GET', '/api/v1/club/tables')).json, { error: 'unauthorized' });
    assert.equal((await t.api(`blk_${'A'.repeat(43)}`, '/api/v1/club/tables')).status, 401);
    assert.equal((await t.api(t.tokens.owner, '/api/v1/club/tables')).status, 401, 'токен сотрудника — не ключ');
    assert.equal((await t.request('GET', '/api/v1/club/tables', { cookie: `bl_session=${t.tokens.owner}` })).status, 401, 'cookie не читается');
    const a = await t.api(k.key, '/api/v1/club/tables');
    assert.equal(a.status, 200);
    assert.equal(a.json.club.id, CLUB);
    assert.equal(a.json.tables.length, 8);
    // Клуб в запросе ключ не подменяет.
    const spoof = await t.api(k.key, `/api/v1/club/tables?club=${CLUB_B}`, { 'x-club-id': CLUB_B });
    assert.equal(spoof.json.club.id, CLUB);
    assert.deepEqual(spoof.json.tables.map((x) => x.resource_id), a.json.tables.map((x) => x.resource_id));
    const b = await t.api(kb.key, '/api/v1/club/tables');
    assert.equal(b.json.club.id, CLUB_B);
    assert.deepEqual(b.json.tables.map((x) => x.resource_id), ['e2000000-0000-4000-8000-000000000001']);
    // Ключ не даёт прав сотрудника и маршрутов программы клуба.
    assert.equal((await t.api(k.key, `/api/clubs/${CLUB}/dashboard`)).status, 401);
    assert.equal((await t.api(k.key, `/api/clubs/${CLUB}/api-keys`)).status, 401);
    // Чужой клуб владельцем — 403, отзыв чужого ключа — 404.
    assert.equal((await t.as('owner', 'POST', `/api/clubs/${CLUB}/api-keys/${kb.key_id}/revoke`)).status, 404);
  });

  it('права: без scope — 403 scope_required, с ним — 200', async () => {
    const k = await t.newKey(['tables:read']);
    for (const p of ['tariffs', 'availability', 'sales', 'bookings']) {
      const r = await t.api(k.key, `/api/v1/club/${p}`);
      assert.equal(r.status, 403, p);
      assert.deepEqual(r.json, { error: 'scope_required' });
    }
    assert.equal((await t.api(k.key, '/api/v1/club/tables')).status, 200);
    // Только GET; изменяющих маршрутов нет.
    const post = await t.request('POST', '/api/v1/club/tables', { token: k.key, body: {}, origin: null });
    assert.equal(post.status, 405);
  });

  it('отзыв: ключ сразу перестаёт работать, повтор отзыва — тот же ответ, журнал без ключа', async () => {
    const k = await t.newKey(['tables:read']);
    assert.equal((await t.api(k.key, '/api/v1/club/tables')).status, 200);
    const r = await t.as('owner', 'POST', `/api/clubs/${CLUB}/api-keys/${k.key_id}/revoke`);
    assert.equal(r.status, 200);
    assert.equal(r.json.active, false);
    assert.ok(r.json.revoked_at);
    assert.equal((await t.api(k.key, '/api/v1/club/tables')).status, 401);
    const again = await t.as('owner', 'POST', `/api/clubs/${CLUB}/api-keys/${k.key_id}/revoke`);
    assert.equal(again.json.revoked_at, r.json.revoked_at);
    const audit = (await t.admin.query("select data from bl.audit_log where action = 'api_key.revoke' and object_id = $1", [k.key_id])).rows;
    assert.equal(audit.length, 1);
    assert.ok(!JSON.stringify(audit[0].data).includes(k.key.slice(4)));
    // Менеджер ключ не отзывает.
    const k2 = await t.newKey(['tables:read']);
    assert.equal((await t.as('manager', 'POST', `/api/clubs/${CLUB}/api-keys/${k2.key_id}/revoke`)).status, 403);
    await t.as('owner', 'POST', `/api/clubs/${CLUB}/api-keys/${k2.key_id}/revoke`);
  });

  it('не больше 5 активных ключей: шестой — 409 api_keys_limit, после отзыва — можно', async () => {
    const active = (await t.as('owner', 'GET', `/api/clubs/${CLUB}/api-keys`)).json.items.filter((x) => x.active);
    for (const x of active) await t.as('owner', 'POST', `/api/clubs/${CLUB}/api-keys/${x.key_id}/revoke`);
    const made = [];
    for (let i = 0; i < 5; i += 1) made.push(await t.newKey(['tables:read'], 'owner', CLUB, `k${i}`));
    const sixth = await t.as('owner', 'POST', `/api/clubs/${CLUB}/api-keys`, { name: 'k6', scopes: ['tables:read'] });
    assert.equal(sixth.status, 409);
    assert.deepEqual(sixth.json, { error: 'api_keys_limit' });
    const list = await t.as('owner', 'GET', `/api/clubs/${CLUB}/api-keys`);
    assert.equal(list.json.active, 5);
    assert.equal(list.json.limit, 5);
    await t.as('owner', 'POST', `/api/clubs/${CLUB}/api-keys/${made[0].key_id}/revoke`);
    assert.equal((await t.as('owner', 'POST', `/api/clubs/${CLUB}/api-keys`, { name: 'k6', scopes: ['tables:read'] })).status, 201);
    // Лимит клуба Б — свой.
    assert.equal((await t.as('ownerB', 'POST', `/api/clubs/${CLUB_B}/api-keys`, { name: 'b', scopes: ['tables:read'] })).status, 201);
    for (const x of (await t.as('owner', 'GET', `/api/clubs/${CLUB}/api-keys`)).json.items.filter((y) => y.active)) {
      await t.as('owner', 'POST', `/api/clubs/${CLUB}/api-keys/${x.key_id}/revoke`);
    }
  });

  it('лимиты: 600 в минуту на ключ, 60 в минуту на продажи; у другого ключа — свои', async () => {
    const k = await t.newKey(['tables:read', 'sales:read']);
    const k2 = await t.newKey(['tables:read']);
    // Окно ключа заполнено до 599 — 600-й запрос проходит, 601-й — 429 с Retry-After.
    for (let i = 0; i < KEY_LIMIT.max - 1; i += 1) t.app.router.rateLimiter.hit(`api_key|${k.key_id}`, KEY_LIMIT);
    assert.equal((await t.api(k.key, '/api/v1/club/tables')).status, 200);
    const over = await t.api(k.key, '/api/v1/club/tables');
    assert.equal(over.status, 429);
    assert.deepEqual(over.json, { error: 'rate_limited' });
    assert.ok(Number(over.headers.get('retry-after')) >= 1);
    assert.equal((await t.api(k2.key, '/api/v1/club/tables')).status, 200, 'другой ключ');
    // Продажи: 60 запросов настоящих, 61-й — 429; таблицы тем же ключом — по общему лимиту.
    const k3 = await t.newKey(['tables:read', 'sales:read']);
    for (let i = 0; i < 60; i += 1) {
      const r = await t.api(k3.key, '/api/v1/club/sales');
      assert.equal(r.status, 200, `sales ${i}`);
    }
    assert.equal((await t.api(k3.key, '/api/v1/club/sales')).status, 429);
    assert.equal((await t.api(k3.key, '/api/v1/club/tables')).status, 200);
    for (const x of [k, k2, k3]) await t.as('owner', 'POST', `/api/clubs/${CLUB}/api-keys/${x.key_id}/revoke`);
  });
});

describe('T45: данные по ключу', () => {
  let key;
  before(async () => {
    key = (await t.newKey(['tables:read', 'tariffs:read', 'availability:read', 'sales:read', 'bookings:read'], 'owner', CLUB, 'Все права')).key;
  });

  it('ответы всех маршрутов — без телефонов, имён гостей, user_id и id игр', async () => {
    const tomorrow = addDays(data.today, 1);
    const paths = [
      '/api/v1/club/tables',
      '/api/v1/club/tariffs',
      `/api/v1/club/availability?date=${tomorrow}`,
      `/api/v1/club/sales?from=${data.D1}&to=${data.today}`,
      `/api/v1/club/bookings?from=${data.D1}&to=${tomorrow}`,
    ];
    const { rows: guests } = await t.admin.query('select id, phone, name from bl.users where id = any($1::uuid[])', [[G1, G2, 'a9000000-0000-4000-8000-0000000000a3']]);
    const { rows: sessions } = await t.admin.query('select id from bl.sessions where club_id = $1', [CLUB]);
    const secrets = [GUEST_PHONE, GUEST_NAME, ...guests.flatMap((g) => [g.id, g.phone, g.name].filter(Boolean)), ...sessions.map((s) => s.id), '79995556677', '+7999'];
    for (const p of paths) {
      const r = await t.api(key, p);
      assert.equal(r.status, 200, `${p}: ${r.text}`);
      for (const s of secrets) assert.ok(!r.text.includes(s), `${p}: в ответе ${s}`);
      const keys = allKeys(r.json);
      for (const k of ['user_id', 'session_id', 'payer_user_id', 'guest_name', 'guest_phone', 'phone', 'phone_masked', 'name_guest', 'guest', 'created_by', 'staff_name', 'opened_by_name']) {
        assert.ok(!keys.has(k), `${p}: поле ${k}`);
      }
    }
  });

  it('столы: статус сейчас (игра, свободен, нет связи), фильтр по типу', async () => {
    const r = await t.api(key, '/api/v1/club/tables');
    const by = Object.fromEntries(r.json.tables.map((x) => [x.number, x]));
    assert.equal(by[1].status, 'busy');
    assert.ok(by[1].busy_until);
    assert.equal(by[2].status, 'free');
    assert.equal(by[3].status, 'offline');
    const pool = await t.api(key, '/api/v1/club/tables?kind=billiard_pool');
    assert.deepEqual(pool.json.tables.map((x) => x.number), [6, 7, 8]);
    assert.equal((await t.api(key, '/api/v1/club/tables?kind=chess')).status, 400);
  });

  it('тарифы: правила по местному времени клуба и цена сейчас по столам', async () => {
    const r = await t.api(key, '/api/v1/club/tariffs');
    assert.equal(r.json.club.timezone, 'Asia/Yekaterinburg');
    assert.ok(r.json.rules.length >= 12);
    assert.ok(r.json.rules.every((x) => Number.isSafeInteger(x.price_per_hour_kopecks) && /^\d{2}:\d{2}$/.test(x.start_local)));
    const rule = r.json.rules.find((x) => x.rule_id === 'f1000000-0000-4000-8000-000000000002');
    assert.deepEqual({ days: rule.days, start: rule.start_local, end: rule.end_local, price: rule.price_per_hour_kopecks }, { days: [1, 2, 3, 4], start: '17:00', end: '00:00', price: 80000 });
    assert.equal(r.json.tables.length, 8);
    assert.ok(r.json.tables.every((x) => 'price_now' in x && 'price_next' in x));
  });

  it('свободные интервалы = страница брони (тот же расчёт), фильтр по типу', async () => {
    const tomorrow = addDays(data.today, 1);
    const pub = await withContext(t.pool, { clubId: CLUB, actorType: 'user' }, (db) => availability(db, { deps: { tariffs, engine }, clock, log: t.log }, { clubId: CLUB, date: tomorrow }));
    const r = await t.api(key, `/api/v1/club/availability?date=${tomorrow}&kind=billiard_pyramid`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.tables.map((x) => x.number), [1, 2, 3, 4, 5]);
    for (const x of r.json.tables) {
      const p = pub.resources.find((y) => y.id === x.resource_id);
      assert.deepEqual({ free: x.free, busy: x.busy, rates: x.rates }, { free: p.free, busy: p.busy, rates: p.rates });
    }
    // Стол 2 занят бронью завтра 19:00–20:00.
    const t2 = r.json.tables.find((x) => x.number === 2);
    assert.ok(t2.busy.some((b) => b.kind === 'booking' && b.from === L(tomorrow, '19:00').toISOString()));
    assert.equal((await t.api(key, '/api/v1/club/availability?date=2026-13-40')).status, 400);
  });

  it('продажи = CSV дашборда revenue_daily по суткам до копейки; тестовый клуб не входит', async () => {
    const from = data.D1;
    const to = data.today;
    const r = await t.api(key, `/api/v1/club/sales?from=${from}&to=${to}`);
    assert.equal(r.status, 200);
    dashboardCache.clear();
    const csv = await t.as('owner', 'GET', `/api/clubs/${CLUB}/dashboard/export.csv?table=revenue_daily&from=${from}&to=${to}`);
    assert.equal(csv.status, 200);
    const lines = csv.text.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
    const head = lines[0].split(';');
    const kop = (s) => Math.round(Number(String(s).replace(/\s/g, '').replace(',', '.')) * 100);
    const rows = lines.slice(1).map((l) => l.split(';'));
    assert.equal(rows.length, r.json.days.length);
    for (const [i, d] of r.json.days.entries()) {
      const c = rows[i];
      const col = (name) => c[head.indexOf(name)];
      assert.equal(col('Дата'), d.date.split('-').reverse().join('.'));
      assert.equal(kop(col('Выручка, ₽')), d.total_kopecks, d.date);
      assert.equal(kop(col('Возвраты, ₽')), d.refunds_kopecks, d.date);
      assert.equal(kop(col('Чистая выручка, ₽')), d.net_kopecks, d.date);
      assert.equal(kop(col('Столы, ₽')), d.tables_kopecks, d.date);
      assert.equal(kop(col('Бар, ₽')), d.bar_kopecks, d.date);
      assert.equal(kop(col('Прочее, ₽')), d.other_kopecks, d.date);
      assert.equal(kop(col('Наличные, ₽')), d.by_method.cash, d.date);
      assert.equal(kop(col('Карта на кассе, ₽')), d.by_method.card_terminal, d.date);
      assert.equal(kop(col('СБП, ₽')), d.by_method.sbp, d.date);
      assert.equal(kop(col('Карта онлайн, ₽')), d.by_method.card, d.date);
      assert.equal(Number(col('Игр')), d.games, d.date);
    }
    assert.ok(r.json.totals.total_kopecks > 0);
    assert.equal(r.json.totals.total_kopecks, r.json.days.reduce((a, d) => a + d.total_kopecks, 0));
    // 777 700 тестового клуба нигде нет.
    assert.ok(!r.text.includes('777700'));
    assert.equal((await t.api(key, `/api/v1/club/sales?from=${addDays(to, -366)}&to=${to}`)).status, 400);
    assert.equal((await t.api(key, '/api/v1/club/sales?from=2026-10-24&to=2026-10-01')).status, 400);
  });

  it('брони: время, стол, статус, источник; период и курсор', async () => {
    const tomorrow = addDays(data.today, 1);
    const r = await t.api(key, `/api/v1/club/bookings?from=${data.D1}&to=${tomorrow}`);
    assert.equal(r.status, 200);
    const phone = r.json.items.find((b) => b.source === 'phone');
    assert.deepEqual(Object.keys(phone).sort(), ['booking_id', 'canceled_at', 'created_at', 'ends_at', 'resource_id', 'resource_number', 'resource_type', 'source', 'starts_at', 'status', 'test'].sort());
    assert.equal(phone.resource_number, 2);
    assert.equal(phone.status, 'confirmed');
    const page1 = await t.api(key, `/api/v1/club/bookings?from=${data.D1}&to=${tomorrow}&limit=1`);
    assert.equal(page1.json.items.length, 1);
    assert.ok(page1.json.next_cursor);
    const page2 = await t.api(key, `/api/v1/club/bookings?from=${data.D1}&to=${tomorrow}&limit=100&cursor=${page1.json.next_cursor}`);
    assert.deepEqual([...page1.json.items, ...page2.json.items].map((b) => b.booking_id), r.json.items.map((b) => b.booking_id));
    assert.equal((await t.api(key, `/api/v1/club/bookings?from=${data.D1}&to=${addDays(data.D1, 94)}`)).status, 400);
    assert.equal((await t.api(key, '/api/v1/club/bookings?cursor=zzz')).status, 400);
    // Кривой курсор (Н-1, Н-2): строгое ISO-время и UUID — 400, а не 500 на ::timestamptz и ::uuid.
    for (const id of ['-'.repeat(36), '0123456789abcdef0123456789abcdef----', 'g'.repeat(36)]) {
      const bad = Buffer.from(JSON.stringify([new Date().toISOString(), id])).toString('base64url');
      const r = await t.api(key, `/api/v1/club/bookings?cursor=${bad}`);
      assert.deepEqual([r.status, r.json], [400, { error: 'bad_request' }], id);
    }
    for (const [what, cursor] of badCursors()) {
      const r = await t.api(key, `/api/v1/club/bookings?cursor=${encodeURIComponent(cursor)}`);
      assert.deepEqual([r.status, r.json], [400, { error: 'bad_request' }], what);
    }
    // Ключ клуба Б броней клуба А не видит.
    const kb = await t.newKey(['bookings:read'], 'ownerB', CLUB_B);
    const b = await t.api(kb.key, `/api/v1/club/bookings?from=${data.D1}&to=${tomorrow}`);
    assert.equal(b.status, 200);
    assert.deepEqual(b.json.items, []);
  });

  it('транзакция ключа — только чтение и без пользователя: запись отклоняет база', async () => {
    await withApiContext(t.pool, CLUB, async (db) => {
      const ctx = await db.query("select current_setting('app.actor_type') as a, nullif(current_setting('app.user_id', true), '') as u, current_setting('transaction_read_only') as ro");
      assert.deepEqual(ctx.rows[0], { a: 'api', u: null, ro: 'on' });
      await db.query('savepoint s');
      await assert.rejects(db.query("update bl.resources set title = 'x' where id = $1", [T(1)]), { code: '25006' });
      await db.query('rollback to savepoint s');
      await assert.rejects(db.query("insert into bl.audit_log (club_id, action) values ($1, 'test.api')", [CLUB]), { code: '25006' });
    });
  });
});
