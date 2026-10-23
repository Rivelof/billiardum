// Перепроверка ревью п. 6: очередь уведомлений (0705) — RLS и отсутствие утечек между
// пользователями. Гость видит только свои уведомления; менять их (claimed_at, status, attempts)
// может только платформенный контекст (воркер доставки), не гость и не персонал.
//
// Запуск: DATABASE_ADMIN_URL=postgres://supabase_admin:...@127.0.0.1:55460/postgres \
//   node --test tests/security/m3/review_notify.test.mjs

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { asRole, createTestDatabase, seedClubB, CLUB_A, CLUB_B, OWNER_A, OWNER_B } from '../../../supabase/tests/helpers.mjs';

let db;
let pool;
let guestA;
let guestB;

/** Уведомление гостю в клубе (как notify.send: club_id из контекста). */
async function note(clubId, userId, text) {
  const id = randomUUID();
  await pool.query(
    `insert into bl.notifications (id, club_id, user_id, kind, level, text) values ($1,$2,$3,'booking.confirmed','info',$4)`,
    [id, clubId, userId, text],
  );
  return id;
}

before(async () => {
  db = await createTestDatabase();
  pool = db.pool;
  await seedClubB(pool);
  guestA = randomUUID();
  guestB = randomUUID();
  await pool.query('insert into bl.users (id, phone) values ($1,$2),($3,$4)', [guestA, '+79990000a1'.replace('a', '0'), guestB, '+79990000b2'.replace('b', '0')]);
});
after(async () => {
  await db?.drop();
});

test('гость видит только свои уведомления (в нейтральном контексте), ни клубные, ни чужих гостей', async () => {
  const mine = await note(CLUB_A, guestA, 'Привет A');
  await note(CLUB_A, guestB, 'Привет B');
  await note(CLUB_A, OWNER_A, 'Персоналу');
  await asRole(pool, 'app_api', { clubId: null, userId: guestA }, async (c) => {
    const rows = (await c.query('select id, user_id from bl.notifications')).rows;
    assert.ok(rows.length >= 1);
    for (const r of rows) assert.equal(r.user_id, guestA, 'видны только свои');
    assert.ok(rows.some((r) => r.id === mine));
  });
});

test('гость не видит и не меняет уведомление другого гостя (по id)', async () => {
  const forB = await note(CLUB_A, guestB, 'Секрет B');
  await asRole(pool, 'app_api', { clubId: null, userId: guestA }, async (c) => {
    assert.equal((await c.query('select 1 from bl.notifications where id = $1', [forB])).rowCount, 0, 'чужое не видно');
  });
  // Попытка захватить/прочитать чужое уведомление обновлением (claimed_at) — 0 строк (RLS update по платформе).
  await asRole(pool, 'app_api', { clubId: null, userId: guestA }, async (c) => {
    const upd = await c.query('update bl.notifications set claimed_at = now() where id = $1', [forB]);
    assert.equal(upd.rowCount, 0, 'чужое уведомление не изменить');
  });
});

test('менять статус/claimed_at/attempts может только платформенный воркер, не гость и не персонал', async () => {
  const n = await note(CLUB_A, guestA, 'Для A');
  // Сам адресат в личном контексте не трогает доставку.
  await asRole(pool, 'app_api', { clubId: null, userId: guestA }, async (c) => {
    assert.equal((await c.query("update bl.notifications set status = 'sent' where id = $1", [n])).rowCount, 0, 'гость не меняет статус');
    assert.equal((await c.query('update bl.notifications set claimed_at = now() where id = $1', [n])).rowCount, 0, 'гость не захватывает');
  });
  // Персонал клуба (контекст клуба) тоже не меняет доставку: update-политика только по платформе.
  await asRole(pool, 'app_api', { clubId: CLUB_A, userId: OWNER_A }, async (c) => {
    assert.equal((await c.query("update bl.notifications set status = 'sent' where id = $1", [n])).rowCount, 0, 'персонал не меняет статус');
  });
  // Платформенный воркер (actor_type system, без клуба и пользователя) — меняет.
  await asRole(pool, 'app_api', { clubId: null, userId: null, actorType: 'system' }, async (c) => {
    const upd = await c.query("update bl.notifications set status = 'sending', claimed_at = now() where id = $1", [n]);
    assert.equal(upd.rowCount, 1, 'воркер доставки захватывает уведомление');
  });
});

test('вставить уведомление на чужой клуб нельзя (RLS insert по ctx_club_id)', async () => {
  await assert.rejects(
    () => asRole(pool, 'app_api', { clubId: CLUB_A, userId: OWNER_A }, (c) =>
      c.query(`insert into bl.notifications (club_id, user_id, kind, level, text) values ($1,$2,'x','info','t')`, [CLUB_B, guestB])),
    (e) => e.code === '42501',
  );
  // Платформенный контекст пишет уведомление с club_id (как notify.send в контексте клуба) —
  // но под платформой ctx_club_id null, поэтому club_id тоже должен быть null (политика insert).
  await asRole(pool, 'app_api', { clubId: CLUB_B, userId: OWNER_B }, async (c) => {
    assert.equal((await c.query('select count(*)::int n from bl.notifications where club_id = $1', [CLUB_A])).rows[0].n, 0, 'клуб B не видит уведомления клуба A');
  });
});

test('у app_api нет DELETE на уведомлениях (очередь только дополняется и закрывается статусом)', async () => {
  const n = await note(CLUB_A, guestA, 'Удалить?');
  await assert.rejects(
    () => asRole(pool, 'app_api', { clubId: null, userId: null, actorType: 'system' }, (c) => c.query('delete from bl.notifications where id = $1', [n])),
    (e) => e.code === '42501',
  );
});
