// Волна B M3: публичный GET /api/clubs (миграция 0703, bl.public_clubs, №120) и GET /api/me
// channels. Без входа отдаются только поля из белого списка (id, название, город, адрес, пояс,
// размеры плана) активных клубов: ни настроек, ни телефонов, ни ключей; канал Web Push — только
// признак, без endpoint и ключей подписки.
//
// Запуск: DATABASE_ADMIN_URL=postgres://supabase_admin:...@127.0.0.1:55460/postgres \
//   node --test tests/security/m3/wave_b_public.test.mjs

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { routes as ownerRoutes } from '../../../api/routes/owner.mjs';
import { userJson } from '../../../server/auth/index.mjs';
import { createTestDatabase, seedClubB, CLUB_A, CLUB_B, OWNER_A } from '../../../supabase/tests/helpers.mjs';

const skip = !process.env.DATABASE_ADMIN_URL;
const PUBLIC = ownerRoutes.find((r) => r.method === 'GET' && r.path === '/api/clubs');
let db;
let pool;

/** Транзакция как у анонимного маршрута: app_api, без клуба и пользователя. */
async function anon(fn, { userId = '' } = {}) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role app_api');
    await c.query("select set_config('app.club_id','',true), set_config('app.user_id',$1,true)", [userId]);
    return await fn(c);
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }
}

before(async () => {
  if (skip) return;
  db = await createTestDatabase();
  pool = db.pool;
  await seedClubB(pool);
  // В настройках клуба A — то, что наружу уйти не должно: телефон владельца, внутренние ключи, лишние поля плана.
  await pool.query(
    `update bl.clubs set address = 'ул. Пушкина, 1', settings = settings || $2::jsonb where id = $1`,
    [CLUB_A, JSON.stringify({ owner_phone: '+79170000001', secret_note: 'pin=1234', plan: { width_cm: 2000, height_cm: 1500, layers: [{ phone: '+79170000002' }] } })],
  );
  // Клуб B закрыт — его в списке быть не должно.
  await pool.query('update bl.clubs set active = false where id = $1', [CLUB_B]);
  await pool.query(`insert into bl.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, 'https://push.example/secret-endpoint', 'p256dh-secret', 'auth-secret')`, [OWNER_A]).catch(() => {});
});

after(async () => {
  await db?.drop();
});

test('GET /api/clubs: только белый список полей активных клубов, без настроек и телефонов', { skip }, async () => {
  const out = await anon((c) => PUBLIC.handler({ db: c }));
  assert.equal(out.status, 200);
  assert.ok(out.json.length >= 1);
  for (const club of out.json) {
    assert.deepEqual(Object.keys(club).sort(), ['address', 'city', 'id', 'name', 'plan', 'timezone']);
    if (club.plan) assert.deepEqual(Object.keys(club.plan).sort(), ['height_cm', 'width_cm']);
  }
  assert.ok(!out.json.some((c) => c.id === CLUB_B), 'закрытый клуб не показан');
  const s = JSON.stringify(out.json);
  for (const leak of ['79170000001', '79170000002', 'pin=1234', 'secret_note', 'owner_phone', 'layers']) assert.ok(!s.includes(leak), leak);
});

test('без входа таблица клубов под RLS не видна — только через bl.public_clubs; у public нет execute', { skip }, async () => {
  const direct = await anon((c) => c.query('select count(*)::int n from bl.clubs'));
  assert.equal(direct.rows[0].n, 0, 'прямой select из bl.clubs без контекста пуст');
  const r = await pool.query(
    "select has_function_privilege('public','bl.public_clubs()','execute') pub, has_function_privilege('app_api','bl.public_clubs()','execute') app",
  );
  assert.deepEqual(r.rows[0], { pub: false, app: true });
});

test('GET /api/me channels: только признаки подключения, без endpoint и ключей Web Push', { skip }, async () => {
  const u = await anon((c) => userJson(c, OWNER_A), { userId: OWNER_A });
  assert.deepEqual(Object.keys(u.channels).sort(), ['max', 'telegram', 'webpush']);
  for (const v of Object.values(u.channels)) assert.equal(typeof v, 'boolean');
  const s = JSON.stringify(u);
  for (const leak of ['secret-endpoint', 'p256dh-secret', 'auth-secret']) assert.ok(!s.includes(leak), leak);
});
