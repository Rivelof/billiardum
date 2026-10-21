// Изоляция клубов (инвариант 5, decisions №12, контракт M0 §5): app_api с контекстом
// клуба A не видит и не пишет строк клуба B; без контекста не видит ничего.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  asRole,
  CLUB_A,
  CLUB_B,
  CLUB_TABLES,
  createTestDatabase,
  OWNER_A,
  OWNER_B,
  seedClubB,
  tryQuery,
} from './helpers.mjs';

let db;

before(async () => {
  db = await createTestDatabase();
  await seedClubB(db.pool);
  // Журнал клуба A тоже не пуст.
  await db.pool.query("insert into bl.audit_log (club_id, actor_type, action) values ($1, 'system', 'test.club_a')", [CLUB_A]);
});

after(async () => {
  await db?.drop();
});

/** Строки клуба в таблице (как видит суперпользователь). */
async function countAll(table, column, clubId) {
  const { rows } = await db.pool.query(`select count(*)::int as n from bl.${table} where ${column} = $1`, [clubId]);
  return rows[0].n;
}

const NEW_ROW_FOR_B = {
  club_members: [`insert into bl.club_members (club_id, user_id, role) values ($1, '${OWNER_A}', 'manager')`],
  resources: [`insert into bl.resources (club_id, type, number, title) values ($1, 'billiard_pool', 99, 'Чужой')`],
  devices: [
    `insert into bl.devices (id, club_id, mqtt_username) values ('d9000000-0000-4000-8000-000000000099', $1, 'd9000000-0000-4000-8000-000000000099')`,
  ],
  tariff_rules: [
    `insert into bl.tariff_rules (club_id, resource_type, days, start_local, end_local, price_per_hour) values ($1, 'billiard_pool', '{1}', '10:00', '11:00', 1)`,
  ],
  audit_log: [`insert into bl.audit_log (club_id, action) values ($1, 'test.cross_club')`],
};

describe('два клуба', () => {
  it('в базе есть данные обоих клубов во всех таблицах', async () => {
    for (const club of [CLUB_A, CLUB_B]) {
      assert.equal(await countAll('clubs', 'id', club), 1);
      for (const table of CLUB_TABLES) assert.ok((await countAll(table, 'club_id', club)) >= 1, `${table} ${club}`);
    }
  });

  it('с контекстом клуба A app_api не видит ни одной строки клуба B ни в одной таблице', async () => {
    await asRole(db.pool, 'app_api', { clubId: CLUB_A }, async (c) => {
      const clubs = await c.query('select id from bl.clubs');
      assert.deepEqual(clubs.rows.map((r) => r.id), [CLUB_A]);
      for (const table of CLUB_TABLES) {
        const { rows } = await c.query(`select club_id, count(*)::int as n from bl.${table} group by club_id`);
        assert.deepEqual(rows.map((r) => r.club_id), [CLUB_A], table);
        assert.equal(rows[0].n, await countAll(table, 'club_id', CLUB_A), `${table}: видны все строки своего клуба`);
        const byId = await c.query(`select count(*)::int as n from bl.${table} where club_id = $1`, [CLUB_B]);
        assert.equal(byId.rows[0].n, 0, `${table}: строки B по прямому условию`);
      }
      const users = await c.query('select id from bl.users order by id');
      assert.deepEqual(users.rows.map((r) => r.id), [OWNER_A], 'виден только участник своего клуба');
    });
  });

  it('с контекстом клуба A app_api не может вставить строку с club_id клуба B', async () => {
    await asRole(db.pool, 'app_api', { clubId: CLUB_A }, async (c) => {
      for (const [table, [sql]] of Object.entries(NEW_ROW_FOR_B)) {
        const err = await tryQuery(c, sql, [CLUB_B]);
        assert.ok(err, `${table}: вставка в клуб B прошла`);
        assert.equal(err.code, '42501', `${table}: ${err.message}`);
        assert.match(err.message, /row-level security/, table);
      }
      // Та же вставка в свой клуб проходит — значит, отказ дал именно RLS, а не права.
      for (const [table, [sql]] of Object.entries(NEW_ROW_FOR_B)) {
        if (table === 'club_members') continue; // владелец уже участник клуба A
        assert.equal(await tryQuery(c, sql, [CLUB_A]), null, `${table}: вставка в свой клуб`);
      }
    });
  });

  it('с контекстом клуба A нельзя перенести строку в клуб B и изменить строку B', async () => {
    await asRole(db.pool, 'app_api', { clubId: CLUB_A }, async (c) => {
      for (const table of ['club_members', 'resources', 'tariff_rules']) {
        const move = await tryQuery(c, `update bl.${table} set club_id = $1`, [CLUB_B]);
        assert.ok(move, `${table}: перенос в B прошёл`);
        assert.match(move.message, /row-level security/);
      }
      const upd = await c.query("update bl.resources set title = 'взлом' where club_id = $1", [CLUB_B]);
      assert.equal(upd.rowCount, 0);
      const clubUpd = await c.query("update bl.clubs set name = 'взлом' where id = $1", [CLUB_B]);
      assert.equal(clubUpd.rowCount, 0);
      const dev = await tryQuery(c, 'update bl.devices set club_id = $1', [CLUB_B]);
      assert.ok(dev, 'club_id устройства менять нельзя');
    });
    assert.equal((await db.pool.query('select title from bl.resources where club_id = $1', [CLUB_B])).rows[0].title, 'Стол 1');
  });

  it('без контекста клуба app_api не видит ни одной строки', async () => {
    await asRole(db.pool, 'app_api', { clubId: null }, async (c) => {
      for (const table of ['clubs', 'users', ...CLUB_TABLES]) {
        const { rows } = await c.query(`select count(*)::int as n from bl.${table}`);
        assert.equal(rows[0].n, 0, table);
      }
    });
  });

  it('с контекстом пользователя без клуба виден только сам пользователь', async () => {
    await asRole(db.pool, 'app_api', { clubId: null, userId: OWNER_B, actorType: 'user' }, async (c) => {
      const { rows } = await c.query('select id from bl.users');
      assert.deepEqual(rows.map((r) => r.id), [OWNER_B]);
    });
  });

  it('неверный UUID в контексте — ошибка запроса, а не «все строки»', async () => {
    await asRole(db.pool, 'app_api', {}, async (c) => {
      await c.query("select set_config('app.club_id', 'not-a-uuid', true)");
      const err = await tryQuery(c, 'select count(*) from bl.resources');
      assert.equal(err?.code, '22P02');
    });
  });

  it('у app_api нет прав на schema_migrations, DELETE и TRUNCATE таблиц', async () => {
    await asRole(db.pool, 'app_api', { clubId: CLUB_A }, async (c) => {
      assert.equal((await tryQuery(c, 'select * from bl.schema_migrations'))?.code, '42501');
      for (const table of ['clubs', 'users', ...CLUB_TABLES]) {
        assert.equal((await tryQuery(c, `delete from bl.${table}`))?.code, '42501', `delete ${table}`);
        assert.equal((await tryQuery(c, `truncate bl.${table}`))?.code, '42501', `truncate ${table}`);
      }
    });
  });
});

describe('узкие функции SECURITY DEFINER', () => {
  it('device_club находит клуб любого устройства, device_total считает все устройства', async () => {
    await asRole(db.pool, 'app_api', { clubId: null }, async (c) => {
      const a = await c.query("select bl.device_club('d1000000-0000-4000-8000-000000000003') as club");
      const b = await c.query("select bl.device_club('d2000000-0000-4000-8000-000000000001') as club");
      const none = await c.query("select bl.device_club('d9999999-0000-4000-8000-000000000000') as club");
      const total = await c.query('select bl.device_total()::int as n');
      assert.equal(a.rows[0].club, CLUB_A);
      assert.equal(b.rows[0].club, CLUB_B);
      assert.equal(none.rows[0].club, null);
      assert.equal(total.rows[0].n, 9);
    });
  });

  it('владелец функций видит только devices(id, club_id), ключи — нет', async () => {
    await asRole(db.pool, 'bl_definer', {}, async (c) => {
      assert.equal((await tryQuery(c, 'select device_key_enc from bl.devices'))?.code, '42501');
      assert.equal((await tryQuery(c, 'select * from bl.clubs'))?.code, '42501');
      assert.equal(await tryQuery(c, 'select id, club_id from bl.devices'), null);
    });
  });

  it('функции закреплены: SECURITY DEFINER только у перечисленных, у всех — search_path', async () => {
    const { rows } = await db.pool.query(`
      select p.proname, p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig
        from pg_proc p where p.pronamespace = 'bl'::regnamespace and p.prosecdef order by 1`);
    assert.deepEqual(
      rows.map((r) => [r.proname, r.owner]),
      [
        ['audit_log_chain', 'bl_audit_owner'],
        ['device_club', 'bl_definer'],
        ['device_total', 'bl_definer'],
      ],
    );
    for (const r of rows) assert.ok(r.proconfig?.some((s) => s.startsWith('search_path=pg_catalog')), `${r.proname}: search_path`);
  });
});
