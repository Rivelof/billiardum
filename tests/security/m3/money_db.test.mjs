// PoC денежных инвариантов M3 на уровне БД и функций (контракт M3 §1 п. 5, 10, 11; инвариант 7;
// decisions №108, №112, №113, №116, №118):
//   * createBookingQuote (№113): сумма не больше тарифа за это время — клиенту/соседу не верим;
//   * возврат пакета (№118): нетронутую партию отзывают один раз (already_refunded),
//     тронутую — нельзя (package_used); триггеры balance_lots/pos_sale_packages;
//   * ограничения bl.payments: суммы > 0 (кроме balance), форма депозита и зачёта.
//
// Запуск: DATABASE_ADMIN_URL=postgres://supabase_admin:...@127.0.0.1:55460/postgres \
//   node --test tests/security/m3/money_db.test.mjs

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { asRole, createTestDatabase, CLUB_A, OWNER_A } from '../../../supabase/tests/helpers.mjs';
import { revokeLot } from '../../../server/packages/balance.mjs';
import { createBookingQuote } from '../../../server/payments/prepayments.mjs';

const RES_A = 'e1000000-0000-4000-8000-000000000001';
const T0 = new Date('2026-10-26T12:00:00Z');
const stubDeps = { clock: { now: () => T0 }, log: { warn() {} }, audit: { appendAudit: async () => {} }, alarms: { raise: async () => {} } };

let db;
let pool;

async function tariff(price = 30000) {
  // Правило тарифа для стола: цена price коп./час, все дни и часы.
  await pool.query(
    `insert into bl.tariff_rules (club_id, resource_id, days, start_local, end_local, price_per_hour, step_minutes, min_minutes, priority, active)
     values ($1,$2,'{1,2,3,4,5,6,7}','00:00','24:00',$3,15,30,100,true)`,
    [CLUB_A, RES_A, price],
  );
}

/** Партия минут пакета (через платёж package). minutesLeft < total — «тронутая». */
async function makeLot({ minutesLeft = 600, revoked = false } = {}) {
  const user = OWNER_A;
  const pkg = (await pool.query(`insert into bl.tariff_packages (club_id,title,minutes,price_kopecks,valid_days) values ($1,'П',600,500000,30) returning id`, [CLUB_A])).rows[0].id;
  const pay = (
    await pool.query(
      `insert into bl.payments (club_id,resource_id,user_id,kind,provider,method,idempotence_key,status,amount_kopecks,capture,package_id,provider_payment_id,confirmed_at,captured_at,created_at,updated_at)
       values ($1,null,$2,'package','yookassa','sbp',$3,'succeeded',500000,true,$4,$5,now(),now(),now(),now()) returning id`,
      [CLUB_A, user, `pk-${randomUUID()}`, pkg, `yk-${randomUUID()}`],
    )
  ).rows[0].id;
  const lot = (
    await pool.query(
      `insert into bl.balance_lots (club_id,user_id,package_id,payment_id,minutes_total,minutes_left,price_kopecks,expires_at,source_key,created_at)
       values ($1,$2,$3,$4,600,$5,500000, now()+interval '30 days',$6,now()) returning id`,
      [CLUB_A, user, pkg, pay, minutesLeft, `${pay}:${pkg}:0`],
    )
  ).rows[0].id;
  if (revoked) await pool.query('update bl.balance_lots set minutes_left = 0, revoked_at = now(), revoked_by = $2 where id = $1', [lot, OWNER_A]);
  return { lot, pay, pkg };
}

/** Выполнить как app_api с контекстом и коммитом (для функций с побочными эффектами). */
async function commitAs({ clubId = CLUB_A, userId = OWNER_A }, fn) {
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

before(async () => {
  db = await createTestDatabase();
  pool = db.pool;
  await tariff(30000);
});

after(async () => {
  await db?.drop();
});

// ── createBookingQuote (№113): не больше тарифа ──────────────────────────────────────────────

test('createBookingQuote не берёт больше тарифа за это время, даже если сосед просит больше', async () => {
  const out = await asRole(pool, 'app_api', { clubId: CLUB_A, userId: OWNER_A }, async (c) => {
    return createBookingQuote(c, stubDeps, {
      clubId: CLUB_A, bookingId: randomUUID(), resourceId: RES_A, userId: OWNER_A,
      from: T0, minutes: 60, amountKopecks: 1_000_000_000, // явно больше тарифа
    });
  });
  assert.equal(out.tariff_kopecks, 30000, 'тариф за 60 минут = 30000 коп.');
  assert.equal(out.amount_kopecks, 30000, 'сумма срезана до тарифа');
  assert.ok(out.amount_kopecks < 1_000_000_000, 'завышенная сумма не прошла');
});

test('createBookingQuote: amountKopecks <= 0 — bad_request (нечего оплачивать)', async () => {
  await assert.rejects(
    () => asRole(pool, 'app_api', { clubId: CLUB_A, userId: OWNER_A }, (c) =>
      createBookingQuote(c, stubDeps, { clubId: CLUB_A, bookingId: randomUUID(), resourceId: RES_A, userId: OWNER_A, from: T0, minutes: 60, amountKopecks: 0 })),
    (e) => e.code === 'bad_request',
  );
});

// ── возврат пакета (№118): один раз, только нетронутый ───────────────────────────────────────

test('revokeLot отзывает нетронутую партию один раз; повтор — already_refunded', async () => {
  const { lot } = await makeLot({ minutesLeft: 600 });
  const r = await commitAs({}, (c) => revokeLot(c, stubDeps, { lotId: lot, reason: 'ошибка продажи', staffId: OWNER_A, now: T0 }));
  assert.equal(r.lot.minutes_left, 0, 'минуты обнулены');
  const after = await pool.query('select minutes_left, revoked_at from bl.balance_lots where id = $1', [lot]);
  assert.equal(after.rows[0].minutes_left, 0);
  assert.ok(after.rows[0].revoked_at, 'revoked_at выставлен (сохранилось)');
  // Повторный отзыв (напр. второй раз через кассу) — already_refunded.
  await assert.rejects(
    () => commitAs({}, (c) => revokeLot(c, stubDeps, { lotId: lot, reason: 'ещё раз', staffId: OWNER_A, now: T0 })),
    (e) => e.code === 'already_refunded',
    'двойной возврат пакета заблокирован',
  );
});

test('revokeLot: тронутую партию вернуть нельзя (package_used)', async () => {
  const { lot } = await makeLot({ minutesLeft: 540 }); // 60 минут уже списано
  await assert.rejects(
    () => commitAs({}, (c) => revokeLot(c, stubDeps, { lotId: lot, reason: 'нельзя', staffId: OWNER_A, now: T0 })),
    (e) => e.code === 'package_used',
  );
});

test('balance_lots: revoked_at допустим только при minutes_left = 0 (нельзя «отозвать», оставив минуты)', async () => {
  const { lot } = await makeLot({ minutesLeft: 600 });
  await assert.rejects(
    pool.query('update bl.balance_lots set revoked_at = now() where id = $1', [lot]),
    (e) => e.code === '23514',
  );
});

// ── триггеры неизменности ────────────────────────────────────────────────────────────────────

test('pos_sale_packages: lot_id ставится один раз, возврат финален (триггеры)', async () => {
  const user = OWNER_A;
  const pkg = (await pool.query(`insert into bl.tariff_packages (club_id,title,minutes,price_kopecks,valid_days) values ($1,'П',600,500000,30) returning id`, [CLUB_A])).rows[0].id;
  const salePay = (await pool.query(`insert into bl.payments (club_id,resource_id,user_id,kind,provider,method,idempotence_key,status,amount_kopecks,capture,received_kopecks,change_kopecks,accepted_by,confirmed_at,captured_at,created_at,updated_at) values ($1,null,$2,'bar','reception','cash',$3,'succeeded',500000,true,500000,0,$2,now(),now(),now(),now()) returning id`, [CLUB_A, user, `bar-${randomUUID()}`])).rows[0].id;
  const shift = (await pool.query(`insert into bl.shifts (club_id,number,opened_by,opened_at,float_kopecks) values ($1, floor(random()*1e9)::bigint,$2,now(),0) returning id`, [CLUB_A, user])).rows[0].id;
  const sale = (await pool.query(`insert into bl.pos_sales (club_id,channel,method,status,payment_id,created_by,shift_id,bar_subtotal_kopecks,discount_kopecks,bar_total_kopecks,table_kopecks,package_kopecks,received_kopecks,change_kopecks,request_key,completed_at,created_at,updated_at) values ($1,'pos','cash','completed',$2,$3,$4,0,0,0,0,500000,500000,0,$5,now(),now(),now()) returning id`, [CLUB_A, salePay, user, shift, randomUUID()])).rows[0].id;
  const sp = (await pool.query(`insert into bl.pos_sale_packages (club_id,sale_id,idx,package_id,user_id,amount_kopecks,line,created_at) values ($1,$2,0,$3,$4,500000,'{}'::jsonb,now()) returning id`, [CLUB_A, sale, pkg, user])).rows[0].id;
  const lotA = (await makeLot()).lot;
  const lotB = (await makeLot()).lot;
  await pool.query('update bl.pos_sale_packages set lot_id = $2 where id = $1', [sp, lotA]);
  await assert.rejects(pool.query('update bl.pos_sale_packages set lot_id = $2 where id = $1', [sp, lotB]), (e) => e.code === '23514', 'lot_id перезаписать нельзя');
  // Возврат финален.
  const refundId = randomUUID();
  await pool.query('update bl.pos_sale_packages set refunded_at = now(), pos_refund_id = $2 where id = $1', [sp, refundId]);
  await assert.rejects(pool.query('update bl.pos_sale_packages set refunded_at = now(), pos_refund_id = $2 where id = $1', [sp, randomUUID()]), (e) => e.code === '23514', 'возврат пакета финален');
});

// ── ограничения bl.payments (деньги целыми копейками, суммы > 0) ─────────────────────────────

test('bl.payments: amount_kopecks должен быть > 0 (кроме provider balance), отрицательный — отказ', async () => {
  await assert.rejects(
    () => asRole(pool, 'app_api', { clubId: CLUB_A, userId: OWNER_A }, (c) =>
      c.query(`insert into bl.payments (club_id,resource_id,user_id,kind,provider,method,idempotence_key,status,amount_kopecks,capture,confirmed_at,captured_at,created_at,updated_at)
               values ($1,$2,$3,'start','yookassa','sbp',$4,'succeeded',-100,true,now(),now(),now(),now())`, [CLUB_A, RES_A, OWNER_A, randomUUID()])),
    (e) => e.code === '23514',
    'отрицательная сумма платежа',
  );
});

test('bl.payments: депозит только наличными в reception и для «Без лимита»; booking/package требуют своей ссылки', async () => {
  // Депозит картой через ЮKassa — нарушение формы депозита.
  await assert.rejects(
    () => asRole(pool, 'app_api', { clubId: CLUB_A, userId: OWNER_A }, (c) =>
      c.query(`insert into bl.payments (club_id,resource_id,user_id,kind,provider,method,idempotence_key,status,amount_kopecks,capture,deposit,unlimited,settlement_status,confirmed_at,captured_at,created_at,updated_at)
               values ($1,$2,$3,'start','yookassa','card',$4,'succeeded',100000,true,true,true,'open',now(),now(),now(),now())`, [CLUB_A, RES_A, OWNER_A, randomUUID()])),
    (e) => e.code === '23514',
    'депозит не наличными',
  );
  // kind booking без booking_id — нарушение.
  await assert.rejects(
    () => asRole(pool, 'app_api', { clubId: CLUB_A, userId: OWNER_A }, (c) =>
      c.query(`insert into bl.payments (club_id,resource_id,user_id,kind,provider,method,idempotence_key,status,amount_kopecks,capture,settlement_status,confirmed_at,captured_at,created_at,updated_at)
               values ($1,$2,$3,'booking','yookassa','sbp',$4,'succeeded',100000,true,'open',now(),now(),now(),now())`, [CLUB_A, RES_A, OWNER_A, randomUUID()])),
    (e) => e.code === '23514',
    'booking без booking_id',
  );
});
