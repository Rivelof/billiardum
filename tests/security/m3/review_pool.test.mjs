// НАХОДКА (ревью, низкая–средняя, доступность): обработчик, который держит соединение транзакции
// запроса и внутри берёт ЕЩЁ одно из того же пула, при параллельных запросах ≥ размера пула
// получает дедлок — каждый ждёт второе соединение, занятое соседом.
//
// Так устроен POST /api/staff/pin (api/routes/auth.mjs pinSwitch): есть ctx.db (соединение
// транзакции запроса от роутера), и внутри — checkStaffPin и terminalPinFailure, каждый через
// withContext(ctx.pool, …) берёт из того же пула ещё соединение. То же — одобрение скидки PIN
// (POST /api/pos/approvals → createApproval с pool). В проде пул 12 (2 заняты LISTEN outbox и
// light), connectionTimeoutMillis 5 с: ~10 параллельных PIN на время до таймаута кладут весь API
// (вход, оплата, свет по оплате). Лимит маршрута 20/мин на IP — две волны в минуту.
//
// PoC воспроизводит именно это: тот же продуктовый checkStaffPin под уже открытой транзакцией
// запроса, на пуле, который тест полностью контролирует и закрывает (без фоновых воркеров сервера).
//
// Запуск: DATABASE_ADMIN_URL=postgres://supabase_admin:...@127.0.0.1:55460/postgres \
//   node --test tests/security/m3/review_pool.test.mjs

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { checkStaffPin } from '../../../server/auth/pin.mjs';
import { createTestDatabase, CLUB_A } from '../../../supabase/tests/helpers.mjs';
const RECEPTION_A = 'a1000000-0000-4000-8000-000000000004';

const skip = !process.env.DATABASE_ADMIN_URL;
const POOL = 4;
let db;
let pool;

before(async () => {
  if (skip) return;
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: POOL });
  pool.on('connect', (c) => c.query('set role app_api').catch(() => {}));
  pool.on('error', () => {});
});

after(async () => {
  await pool?.end();
  await db?.drop();
});

/** Соединение транзакции запроса (как ctx.db у роутера): открыта транзакция, роль app_api. */
async function openRequestTx() {
  const c = await pool.connect();
  await c.query('begin');
  await c.query("select set_config('app.club_id', $1, true), set_config('app.user_id', '', true), set_config('app.actor_type', 'system', true)", [CLUB_A]);
  return c;
}

test('POST /api/staff/pin-паттерн: POOL параллельных запросов (каждый держит tx и зовёт checkStaffPin) дедлочат пул — ни один не отвечает', { skip }, async () => {
  const pepper = randomBytes(32);
  const outers = await Promise.all(Array.from({ length: POOL }, openRequestTx));
  // Каждый «запрос» уже держит соединение; теперь, как pinSwitch, берёт из пула ещё одно
  // (checkStaffPin → withContext(pool)). Свободных соединений в пуле нет — все ждут.
  let settled = 0;
  const inners = outers.map(() =>
    checkStaffPin({ pool, clubId: CLUB_A, userId: RECEPTION_A, pin: '4821', roles: ['reception'], pepper })
      .then((r) => ((settled += 1), r))
      .catch((e) => ((settled += 1), e)),
  );
  const raced = await Promise.race([
    Promise.allSettled(inners).then(() => 'done'),
    new Promise((r) => setTimeout(() => r('stuck'), 3000)),
  ]);
  assert.equal(raced, 'stuck', 'при POOL параллельных запросах вложенные соединения не получены — дедлок');
  assert.equal(settled, 0, 'ни один вложенный запрос не отработал, пока держатся транзакции');

  // Освободить «запросы» — пул снова работает, вложенные запросы проходят.
  for (const c of outers) {
    await c.query('rollback').catch(() => {});
    c.release();
  }
  const after = await Promise.race([
    Promise.allSettled(inners).then(() => 'done'),
    new Promise((r) => setTimeout(() => r('stuck'), 10000)),
  ]);
  assert.equal(after, 'done', 'после освобождения соединений вложенные запросы завершились');
});

test('контроль: при POOL-1 параллельных запросов (есть запас соединения) дедлока нет', { skip }, async () => {
  const pepper = randomBytes(32);
  const outers = await Promise.all(Array.from({ length: POOL - 1 }, openRequestTx));
  const inners = outers.map(() => checkStaffPin({ pool, clubId: CLUB_A, userId: RECEPTION_A, pin: '4821', roles: ['reception'], pepper }).catch((e) => e));
  const raced = await Promise.race([
    Promise.allSettled(inners).then(() => 'done'),
    new Promise((r) => setTimeout(() => r('stuck'), 4000)),
  ]);
  for (const c of outers) {
    await c.query('rollback').catch(() => {});
    c.release();
  }
  assert.equal(raced, 'done', 'один свободный слот — запросы проходят, дедлока нет');
});
