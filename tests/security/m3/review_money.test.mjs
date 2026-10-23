// Перепроверка ревью денег (0657): возврат балансом, отмена возврата (восстановление партии),
// очередь наличных без смены, сверка возврата. DB-уровень на своём Postgres.
//
// Запуск: DATABASE_ADMIN_URL=postgres://supabase_admin:...@127.0.0.1:55460/postgres \
//   node --test tests/security/m3/review_money.test.mjs

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { asRole, createTestDatabase, seedClubB, CLUB_A, CLUB_B, OWNER_A, OWNER_B } from '../../../supabase/tests/helpers.mjs';
import { restoreMinutes, restoreBalance } from '../../../server/packages/balance.mjs';

const RES_A = 'e1000000-0000-4000-8000-000000000001';
const T0 = new Date('2026-10-26T12:00:00Z');
let db;
let pool;

/** Через app_api с коммитом (функции с побочными эффектами). */
async function commitAs(fn, { clubId = CLUB_A, userId = OWNER_A } = {}) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role app_api');
    await c.query("select set_config('app.club_id',$1,true), set_config('app.user_id',$2,true), set_config('app.actor_type','user',true)", [clubId, userId]);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    await c.query('reset role').catch(() => {});
    c.release();
  }
}

/** Партия пакета и игровой платёж балансом со списанием debitMinutes минут. */
async function lotWithDebit({ club = CLUB_A, user = OWNER_A, total = 600, debitMinutes = 120, price = 600000, expiresDays = 30 } = {}) {
  const pkg = (await pool.query(`insert into bl.tariff_packages (club_id,title,minutes,price_kopecks,valid_days) values ($1,'П',$2,$3,30) returning id`, [club, total, price])).rows[0].id;
  const buy = (await pool.query(
    `insert into bl.payments (club_id,resource_id,user_id,kind,provider,method,idempotence_key,status,amount_kopecks,capture,package_id,provider_payment_id,confirmed_at,captured_at,created_at,updated_at)
     values ($1,null,$2,'package','yookassa','sbp',$3,'succeeded',$4,true,$5,$6,now(),now(),now(),now()) returning id`,
    [club, user, `pk-${randomUUID()}`, price, pkg, `yk-${randomUUID()}`],
  )).rows[0].id;
  const lot = (await pool.query(
    `insert into bl.balance_lots (club_id,user_id,package_id,payment_id,minutes_total,minutes_left,price_kopecks,expires_at,source_key,created_at)
     values ($1,$2,$3,$4,$5,$6,$7, now()+make_interval(days => $8),$9,now()) returning id`,
    [club, user, pkg, buy, total, total - debitMinutes, price, expiresDays, `${buy}:${pkg}:0`],
  )).rows[0].id;
  const game = (await pool.query(
    `insert into bl.payments (club_id,resource_id,user_id,session_id,kind,provider,method,idempotence_key,status,amount_kopecks,capture,minutes,balance_minutes,confirmed_at,captured_at,created_at,updated_at)
     values ($1,$2,$3,null,'extend','balance','balance',$4,'succeeded',0,true,$5,$5,now(),now(),now(),now()) returning id`,
    [club, RES_A, user, `bal-${randomUUID()}`, debitMinutes],
  )).rows[0].id;
  // Доля стоимости: цена × minutes / total.
  const value = Math.floor((price * debitMinutes * 2 + total) / (2 * total));
  await pool.query(
    `insert into bl.balance_debits (club_id,user_id,lot_id,payment_id,minutes,value_kopecks,created_at) values ($1,$2,$3,$4,$5,$6,now())`,
    [club, user, lot, game, debitMinutes, value],
  );
  return { pkg, lot, game, value, total };
}

const lotMinutes = async (lot) => (await pool.query('select minutes_left, minutes_total, expires_at from bl.balance_lots where id = $1', [lot])).rows[0];

before(async () => {
  db = await createTestDatabase();
  pool = db.pool;
  await seedClubB(pool);
});
after(async () => {
  await db?.drop();
});

test('restoreBalance: минуты возвращаются один раз; повтор ничего не добавляет (не вернуть дважды)', async () => {
  const { lot, game, total } = await lotWithDebit({ debitMinutes: 120 });
  const n1 = await commitAs((c) => restoreBalance(c, { paymentId: game, now: T0 }));
  assert.equal(n1, 120);
  assert.equal((await lotMinutes(lot)).minutes_left, total);
  const n2 = await commitAs((c) => restoreBalance(c, { paymentId: game, now: T0 }));
  assert.equal(n2, 0, 'повторный возврат не добавляет минут');
  assert.equal((await lotMinutes(lot)).minutes_left, total, 'не больше купленного');
});

test('restoreMinutes частично (LIFO): делит строку списания, возвращает ровно запрошенное и не больше списанного', async () => {
  const { lot, game } = await lotWithDebit({ debitMinutes: 120 });
  const r1 = await commitAs((c) => restoreMinutes(c, { paymentId: game, minutes: 30, now: T0 }));
  assert.equal(r1.minutes, 30);
  assert.equal((await lotMinutes(lot)).minutes_left, 600 - 120 + 30);
  // Остаток списания — 90; просим вернуть 1000 → вернётся только оставшееся 90.
  const r2 = await commitAs((c) => restoreMinutes(c, { paymentId: game, minutes: 1000, now: T0 }));
  assert.equal(r2.minutes, 90, 'не больше невозвращённого остатка');
  assert.equal((await lotMinutes(lot)).minutes_left, 600);
  const debitSum = (await pool.query('select coalesce(sum(minutes),0)::int s from bl.balance_debits where payment_id = $1 and restored_at is null', [game])).rows[0].s;
  assert.equal(debitSum, 0, 'все списания возвращены');
});

test('restoreMinutes в истёкшую партию продлевает срок на сутки (минуты за неоказанную услугу не пропадают)', async () => {
  const { lot, game } = await lotWithDebit({ debitMinutes: 60, expiresDays: -1 }); // партия уже истекла
  const before = new Date((await lotMinutes(lot)).expires_at).getTime();
  assert.ok(before < T0.getTime(), 'партия истекла');
  await commitAs((c) => restoreMinutes(c, { paymentId: game, minutes: null, now: T0 }));
  const after = new Date((await lotMinutes(lot)).expires_at).getTime();
  assert.ok(after >= T0.getTime() + 23 * 3600_000, 'срок продлён примерно на сутки');
});

test('отмена возврата пакета: партия восстанавливается один раз (повтор restore — no-op)', async () => {
  // Нетронутая партия отозвана (возврат), затем ЮKassa отменила возврат — партия снова действует.
  const pkg = (await pool.query(`insert into bl.tariff_packages (club_id,title,minutes,price_kopecks,valid_days) values ($1,'П',600,500000,30) returning id`, [CLUB_A])).rows[0].id;
  const buy = (await pool.query(
    `insert into bl.payments (club_id,resource_id,user_id,kind,provider,method,idempotence_key,status,amount_kopecks,capture,package_id,provider_payment_id,confirmed_at,captured_at,created_at,updated_at)
     values ($1,null,$2,'package','yookassa','sbp',$3,'succeeded',500000,true,$4,$5,now(),now(),now(),now()) returning id`,
    [CLUB_A, OWNER_A, `pk-${randomUUID()}`, pkg, `yk-${randomUUID()}`],
  )).rows[0].id;
  const lot = (await pool.query(
    `insert into bl.balance_lots (club_id,user_id,package_id,payment_id,minutes_total,minutes_left,price_kopecks,expires_at,source_key,created_at,revoked_at,revoked_by)
     values ($1,$2,$3,$4,600,0,500000, now()+interval '30 days',$5,now(),now(),$2) returning id`,
    [CLUB_A, OWNER_A, pkg, buy, `${buy}:${pkg}:0`],
  )).rows[0].id;
  // Повторяет restoreRevokedLots: вернуть только отозванную партию.
  const restore = (c) => c.query(
    `update bl.balance_lots set minutes_left = minutes_total, revoked_at = null, revoked_by = null where id = $1 and revoked_at is not null returning id`,
    [lot],
  );
  const first = await commitAs(async (c) => (await restore(c)).rowCount);
  assert.equal(first, 1);
  assert.equal((await lotMinutes(lot)).minutes_left, 600);
  const second = await commitAs(async (c) => (await restore(c)).rowCount);
  assert.equal(second, 0, 'повторное восстановление ничего не делает (нет двойных минут)');
});

test('cash_refunds_pending: RLS изоляция клубов и уникальный ключ (нет двойной выдачи наличных)', async () => {
  const mkPay = async (club, user) => (await pool.query(
    `insert into bl.payments (club_id,resource_id,user_id,kind,provider,method,idempotence_key,status,amount_kopecks,capture,received_kopecks,change_kopecks,accepted_by,confirmed_at,captured_at,created_at,updated_at)
     values ($1,null,$2,'bar','reception','cash',$3,'succeeded',100000,true,100000,0,$2,now(),now(),now(),now()) returning id`,
    [club, user, `bar-${randomUUID()}`],
  )).rows[0].id;
  const payA = await mkPay(CLUB_A, OWNER_A);
  const key = randomUUID();
  const insert = (c, club, payment) => c.query(
    `insert into bl.cash_refunds_pending (club_id,payment_id,idempotence_key,amount_kopecks,reason,lines,created_at)
     values ($1,$2,$3,50000,'возврат','[]'::jsonb,now()) on conflict (club_id, idempotence_key) do nothing returning id`,
    [club, payment, key],
  );
  const first = await commitAs((c) => insert(c, CLUB_A, payA));
  assert.equal(first.rowCount, 1);
  const dup = await commitAs((c) => insert(c, CLUB_A, payA));
  assert.equal(dup.rowCount, 0, 'тот же ключ — не вторая строка (нет двойной выдачи)');
  // Клуб B не видит очередь клуба A и не вставит строку с чужим club_id.
  await asRole(pool, 'app_api', { clubId: CLUB_B, userId: OWNER_B }, async (c) => {
    const seen = await c.query('select count(*)::int n from bl.cash_refunds_pending');
    assert.equal(seen.rows[0].n, 0, 'очередь наличных клуба A не видна клубу B');
  });
  const payB = await mkPay(CLUB_B, OWNER_B);
  await assert.rejects(
    () => commitAs((c) => c.query(
      `insert into bl.cash_refunds_pending (club_id,payment_id,idempotence_key,amount_kopecks,reason,lines,created_at) values ($1,$2,$3,1000,'x','[]'::jsonb,now())`,
      [CLUB_B, payB, randomUUID()],
    ), { clubId: CLUB_A, userId: OWNER_A }),
    (e) => e.code === '42501',
    'строку очереди с чужим club_id не вставить',
  );
});

test('money_due доступна только app_api (планировщик); public лишён execute', async () => {
  const r = await pool.query(
    "select has_function_privilege('public','bl.money_due(timestamptz,integer)','execute') pub, has_function_privilege('app_api','bl.money_due(timestamptz,integer)','execute') app",
  );
  assert.deepEqual(r.rows[0], { pub: false, app: true });
});
