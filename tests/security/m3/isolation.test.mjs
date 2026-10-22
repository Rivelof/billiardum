// PoC изоляции клубов (инвариант 5 CLAUDE.md) на новых таблицах M3: бронь, лист ожидания,
// пакеты часов, баланс минут, пакеты на кассе, приглашения персонала, сводки, уведомления.
//
// Проверяем: у каждой таблицы ENABLE + FORCE RLS и политика app_api по bl.ctx_club_id();
// под контекстом клуба A не видно ни строки клуба B; запись с чужим club_id отклоняется (42501);
// у app_api нет DELETE.
//
// Запуск: DATABASE_ADMIN_URL=postgres://supabase_admin:...@127.0.0.1:55460/postgres \
//   node --test tests/security/m3/isolation.test.mjs

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { asRole, createTestDatabase, seedClubB, CLUB_A, CLUB_B, OWNER_A, OWNER_B } from '../../../supabase/tests/helpers.mjs';

const RES_A = 'e1000000-0000-4000-8000-000000000001';
const RES_B = 'e2000000-0000-4000-8000-000000000001';

// Новые таблицы M3 с club_id (изоляция обязательна).
const M3_TABLES = [
  'bookings', 'waitlist', 'tariff_packages', 'balance_lots', 'balance_debits',
  'pos_sale_packages', 'staff_invites', 'club_summaries', 'notifications',
];

let db;
let pool;

/** Полный набор строк M3 для клуба (через суперпользователя — он обходит RLS). */
async function seedClubRows(club, res, user, tag) {
  const now = new Date();
  // Бронь по телефону (без учётки).
  const booking = (
    await pool.query(
      `insert into bl.bookings (club_id, resource_id, guest_name, guest_phone, source, starts_at, ends_at, status,
                                prepayment_mode, amount_kopecks, hold_minutes, created_at, updated_at)
       values ($1,$2,$3,'+79990000000','phone', now() + interval '2 hours', now() + interval '3 hours',
               'confirmed','none',150000,15,$4,$4) returning id`,
      [club, res, `Гость ${tag}`, now],
    )
  ).rows[0].id;
  // Лист ожидания.
  await pool.query(
    `insert into bl.waitlist (club_id, resource_id, user_id, status, created_at, updated_at) values ($1,$2,$3,'waiting',$4,$4)`,
    [club, res, user, now],
  );
  // Пакет часов.
  const pkg = (
    await pool.query(
      `insert into bl.tariff_packages (club_id, title, minutes, price_kopecks, valid_days) values ($1,$2,600,500000,30) returning id`,
      [club, `Пакет ${tag}`],
    )
  ).rows[0].id;
  // Платёж покупки пакета (ЮKassa), затем партия минут и списание.
  const payment = (
    await pool.query(
      `insert into bl.payments (club_id, resource_id, user_id, kind, provider, method, idempotence_key, status, amount_kopecks,
                                capture, package_id, provider_payment_id, confirmed_at, captured_at, created_at, updated_at)
       values ($1,null,$2,'package','yookassa','sbp',$3,'succeeded',500000,true,$4,$5,$6,$6,$6,$6) returning id`,
      [club, user, `pk-${tag}`, pkg, `yk-${tag}`, now],
    )
  ).rows[0].id;
  const lot = (
    await pool.query(
      `insert into bl.balance_lots (club_id, user_id, package_id, payment_id, minutes_total, minutes_left, price_kopecks,
                                    expires_at, source_key, created_at)
       values ($1,$2,$3,$4,600,600,500000, now() + interval '30 days', $5, now()) returning id`,
      [club, user, pkg, payment, `${payment}:${pkg}:0`],
    )
  ).rows[0].id;
  // Платёж игры балансом + списание минут.
  const gamePay = (
    await pool.query(
      `insert into bl.payments (club_id, resource_id, user_id, kind, provider, method, idempotence_key, status, amount_kopecks,
                                capture, balance_minutes, confirmed_at, captured_at, created_at, updated_at)
       values ($1,$2,$3,'extend','balance','balance',$4,'succeeded',0,true,60,$5,$5,$5,$5) returning id`,
      [club, res, user, `bal-${tag}`, now],
    )
  ).rows[0].id;
  await pool.query(
    `insert into bl.balance_debits (club_id, user_id, lot_id, payment_id, minutes, value_kopecks, created_at) values ($1,$2,$3,$4,60,50000,now())`,
    [club, user, lot, gamePay],
  );
  // Продажа на кассе с пакетом.
  const shift = (
    await pool.query(
      `insert into bl.shifts (club_id, number, opened_by, opened_at, float_kopecks) values ($1, floor(random()*1e9)::bigint, $2, now(), 0) returning id`,
      [club, user],
    )
  ).rows[0].id;
  const salePay = (
    await pool.query(
      `insert into bl.payments (club_id, resource_id, user_id, kind, provider, method, idempotence_key, status, amount_kopecks,
                                capture, received_kopecks, change_kopecks, accepted_by, confirmed_at, captured_at, created_at, updated_at)
       values ($1,null,$2,'bar','reception','cash',$3,'succeeded',500000,true,500000,0,$2,$4,$4,$4,$4) returning id`,
      [club, user, `bar-${tag}`, now],
    )
  ).rows[0].id;
  const sale = (
    await pool.query(
      `insert into bl.pos_sales (club_id, channel, method, status, payment_id, created_by, shift_id, bar_subtotal_kopecks,
                                 discount_kopecks, bar_total_kopecks, table_kopecks, package_kopecks, received_kopecks, change_kopecks,
                                 request_key, completed_at, created_at, updated_at)
       values ($1,'pos','cash','completed',$2,$3,$4,0,0,0,0,500000,500000,0,$5,$6,$6,$6) returning id`,
      [club, salePay, user, shift, randomUUID(), now],
    )
  ).rows[0].id;
  await pool.query(
    `insert into bl.pos_sale_packages (club_id, sale_id, idx, package_id, user_id, amount_kopecks, line, created_at)
     values ($1,$2,0,$3,$4,500000,'{"description":"pkg"}'::jsonb,now())`,
    [club, sale, pkg, user],
  );
  // Приглашение персонала.
  await pool.query(
    `insert into bl.staff_invites (club_id, phone, role, invited_by, expires_at) values ($1,$2,'reception',$3, now() + interval '7 days')`,
    [club, tag === 'A' ? '+79990000011' : '+79990000022', user],
  );
  // Сводка клуба.
  await pool.query(
    `insert into bl.club_summaries (club_id, kind, day, data, sent_at) values ($1,'morning', current_date - 1, '{}'::jsonb, now())`,
    [club],
  );
  // Уведомление гостю.
  await pool.query(
    `insert into bl.notifications (club_id, user_id, kind, level, text) values ($1,$2,'booking.confirmed','info',$3)`,
    [club, user, `Привет ${tag}`],
  );
  return { booking, pkg, lot, payment };
}

before(async () => {
  db = await createTestDatabase();
  pool = db.pool;
  await seedClubB(pool);
  await seedClubRows(CLUB_A, RES_A, OWNER_A, 'A');
  await seedClubRows(CLUB_B, RES_B, OWNER_B, 'B');
});

after(async () => {
  await db?.drop();
});

test('у всех новых таблиц M3 включён и форсирован RLS с политикой по ctx_club_id', async () => {
  for (const t of M3_TABLES) {
    const { rows } = await pool.query(
      `select c.relrowsecurity rls, c.relforcerowsecurity force from pg_class c
         join pg_namespace n on n.oid = c.relnamespace where n.nspname='bl' and c.relname=$1`,
      [t],
    );
    assert.equal(rows[0].rls, true, `${t}: RLS включён`);
    assert.equal(rows[0].force, true, `${t}: RLS форсирован (FORCE)`);
    const pol = await pool.query(
      `select 1 from pg_policies where schemaname='bl' and tablename=$1 and 'app_api' = any(roles)
         and (qual like '%ctx_club_id%')`,
      [t],
    );
    assert.ok(pol.rowCount > 0, `${t}: есть политика app_api по ctx_club_id`);
  }
});

test('под контекстом клуба A не видно ни одной строки клуба B', async () => {
  await asRole(pool, 'app_api', { clubId: CLUB_A, userId: OWNER_A }, async (c) => {
    for (const t of M3_TABLES) {
      const own = await c.query(`select count(*)::int n from bl.${t} where club_id = $1`, [CLUB_A]);
      const other = await c.query(`select count(*)::int n from bl.${t} where club_id = $1`, [CLUB_B]);
      const all = await c.query(`select count(*)::int n from bl.${t}`);
      assert.ok(own.rows[0].n >= 1, `${t}: свои строки видны`);
      assert.equal(other.rows[0].n, 0, `${t}: строки клуба B не видны по club_id`);
      // Даже без фильтра — ни одной строки чужого клуба (всё, что видно, принадлежит A).
      assert.equal(all.rows[0].n, own.rows[0].n, `${t}: всего видно только своё`);
    }
  });
});

// Каждый отклоняемый запрос — в своей транзакции: первая же ошибка отравляет транзакцию Postgres.
async function rejectsInОwnTx(fn, predicate, msg) {
  await assert.rejects(() => asRole(pool, 'app_api', { clubId: CLUB_A, userId: OWNER_A }, fn), predicate, msg);
}

test('вставка строки с чужим club_id отклоняется (RLS WITH CHECK, 42501)', async () => {
  await rejectsInОwnTx(
    (c) => c.query(`insert into bl.tariff_packages (club_id, title, minutes, price_kopecks, valid_days) values ($1,'чужой',600,100000,30)`, [CLUB_B]),
    (e) => e.code === '42501',
    'tariff_packages: чужой club_id',
  );
  await rejectsInОwnTx(
    (c) => c.query(`insert into bl.notifications (club_id, user_id, kind, level, text) values ($1,$2,'x','info','t')`, [CLUB_B, OWNER_B]),
    (e) => e.code === '42501',
    'notifications: чужой club_id',
  );
  await rejectsInОwnTx(
    (c) => c.query(`insert into bl.staff_invites (club_id, phone, role, invited_by, expires_at) values ($1,'+79995550000','reception',$2, now()+interval '7 days')`, [CLUB_B, OWNER_A]),
    (e) => e.code === '42501',
    'staff_invites: чужой club_id',
  );
  await rejectsInОwnTx(
    (c) => c.query(`insert into bl.bookings (club_id, resource_id, guest_name, guest_phone, source, starts_at, ends_at, status, prepayment_mode, amount_kopecks, hold_minutes, created_at, updated_at) values ($1,$2,'x','+79990000000','phone', now()+interval '2 hours', now()+interval '3 hours','confirmed','none',1000,15,now(),now())`, [CLUB_B, RES_B]),
    (e) => e.code === '42501',
    'bookings: чужой club_id',
  );
});

test('у app_api нет права DELETE на новых таблицах (журнал/деньги только дополняются)', async () => {
  for (const t of M3_TABLES) {
    await rejectsInОwnTx(
      (c) => c.query(`delete from bl.${t} where club_id = $1`, [CLUB_A]),
      (e) => e.code === '42501',
      `${t}: DELETE запрещён app_api`,
    );
  }
});

test('гость видит свою бронь в чужом клубе только через self-политику (user_id), но не чужие', async () => {
  // Бронь гостя-владельца A в клубе A.
  const mine = (
    await pool.query(
      `insert into bl.bookings (club_id, resource_id, user_id, source, starts_at, ends_at, status, prepayment_mode,
                                amount_kopecks, hold_minutes, created_at, updated_at)
       values ($1,$2,$3,'app', now()+interval '5 hours', now()+interval '6 hours','confirmed','none',100000,15,now(),now()) returning id`,
      [CLUB_A, RES_A, OWNER_A],
    )
  ).rows[0].id;
  // Нейтральный контекст (как /api/me/bookings, клуб не выбран): через self-политику гость видит
  // только свои брони и ни одной чужой (ни клуба B, ни других гостей).
  await asRole(pool, 'app_api', { clubId: null, userId: OWNER_A }, async (c) => {
    const visible = await c.query('select club_id, user_id from bl.bookings');
    assert.ok(visible.rowCount >= 1, 'своя бронь видна');
    for (const r of visible.rows) {
      assert.equal(r.user_id, OWNER_A, 'видны только брони самого гостя');
    }
    const self = await c.query('select 1 from bl.bookings where id = $1', [mine]);
    assert.equal(self.rowCount, 1, 'своя конкретная бронь видна по self-политике');
  });
});
