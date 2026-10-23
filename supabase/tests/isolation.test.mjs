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
      // Видны только участники клуба A (владелец из seed.sql и персонал из seed.d), гостей и клуба B — нет.
      const members = (await db.pool.query('select distinct user_id from bl.club_members where club_id = $1 order by user_id', [CLUB_A])).rows.map((r) => r.user_id);
      assert.ok(members.includes(OWNER_A));
      const users = await c.query('select id from bl.users order by id');
      assert.deepEqual(users.rows.map((r) => r.id), members, 'видны только участники своего клуба');
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

  it('pos_guest: только поиск (учётку не создаёт), только id, только персоналу кассы клуба из контекста', async () => {
    const guest = 'a9000000-0000-4000-8000-0000000000dd';
    const noConsent = 'a9000000-0000-4000-8000-0000000000de';
    const reception = 'a1000000-0000-4000-8000-000000000004';
    await db.pool.query("insert into bl.users (id, phone) values ($1, '+79990004411'), ($2, '+79990004422') on conflict do nothing", [guest, noConsent]);
    await db.pool.query("insert into bl.consents (user_id, version, accepted_at) values ($1, '2026-10-21', now()) on conflict do nothing", [guest]);
    const users = async () => (await db.pool.query('select count(*)::int as n from bl.users')).rows[0].n;
    const before = await users();
    const find = (ctx, id, phone) => asRole(db.pool, 'app_api', ctx, async (c) => (await c.query('select bl.pos_guest($1, $2) as id', [id, phone])).rows);
    const staff = { clubId: CLUB_A, userId: reception, actorType: 'user' };
    assert.deepEqual(await find(staff, guest, null), [{ id: guest }]);
    assert.deepEqual(await find(staff, null, '+79990004411'), [{ id: guest }]);
    assert.deepEqual(await find(staff, noConsent, null), [{ id: null }], 'без согласия — нет');
    assert.deepEqual(await find(staff, null, '+79990004499'), [{ id: null }], 'нет учётки — не создаёт');
    assert.deepEqual(await find(staff, guest, '+79990004411'), [{ id: null }], 'id или телефон, не оба');
    assert.deepEqual(await find({ clubId: CLUB_A, actorType: 'system' }, guest, null), [{ id: null }], 'без сотрудника');
    assert.deepEqual(await find({ clubId: CLUB_B, userId: reception, actorType: 'user' }, guest, null), [{ id: null }], 'сотрудник другого клуба');
    assert.deepEqual(await find({ userId: guest, actorType: 'user' }, guest, null), [{ id: null }], 'без клуба');
    assert.equal(await users(), before);
  });

  it('функции закреплены: SECURITY DEFINER только у перечисленных, у всех — search_path', async () => {
    const { rows } = await db.pool.query(`
      select p.proname, p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig
        from pg_proc p where p.pronamespace = 'bl'::regnamespace and p.prosecdef order by 1`);
    assert.deepEqual(
      rows.map((r) => [r.proname, r.owner]),
      [
        // M0
        ['audit_log_chain', 'bl_audit_owner'],
        // M1 core (0103): вход и уведомления
        ['auth_attach_phone', 'bl_definer'],
        ['auth_resolve', 'bl_definer'],
        ['auth_user_for', 'bl_definer'],
        // M3 booking (0600): дела планировщика броней и листа ожидания
        ['booking_due', 'bl_definer'],
        // M5.1 backend-A (1000): переход в live владельцем, режим клуба, возобновление и приостановка платформой, создание клуба
        ['club_go_live', 'bl_definer'],
        ['club_mode', 'bl_definer'],
        ['club_resume', 'bl_definer'],
        ['club_suspend', 'bl_definer'],
        ['create_club', 'bl_definer'],
        // M4 core (0710): роль платформы из контекста, получатели уведомлений платформы
        ['ctx_platform_role', 'bl_definer'],
        // M1 light (0300–0320)
        ['device_bind_window', 'bl_definer'],
        // M0
        ['device_club', 'bl_definer'],
        // M5.1 backend-B (1051): заводской реестр контроллеров
        ['device_factory_check', 'bl_definer'],
        // M5.1 backend-B (1053, №162): есть ли устройство в реестре (без хеша и счётчиков)
        ['device_factory_known', 'bl_definer'],
        ['device_total', 'bl_definer'],
        // M2 kkt (0500): чеки ККТ, не пробитые дольше 10 минут
        ['kkt_due', 'bl_definer'],
        // M1 light
        ['light_open_sessions', 'bl_definer'],
        // M1 money (0200)
        ['money_due', 'bl_definer'],
        // M3 money (0654): гость с партиями пакета по точному телефону — управляющему (№118)
        ['money_lot_guest', 'bl_definer'],
        ['money_object_club', 'bl_definer'],
        // M1 core
        ['notify_route', 'bl_definer'],
        // M5.1 backend-A (1002): проверочные платежи и тревога «вебхук не настроен»
        ['onboarding_due', 'bl_definer'],
        // M4 core (0710)
        ['platform_recipients', 'bl_definer'],
        // M4 plus (0850): итог партии и Эло, публичные поля игроков, таблицы, друзья в клубе, соперники
        ['plus_briefs', 'bl_definer'],
        ['plus_card', 'bl_definer'],
        ['plus_correct_match', 'bl_definer'],
        ['plus_due', 'bl_definer'],
        ['plus_friends_in_club', 'bl_definer'],
        ['plus_lfg_candidates', 'bl_definer'],
        ['plus_rating_table', 'bl_definer'],
        ['plus_settle_match', 'bl_definer'],
        ['plus_user_by_nick', 'bl_definer'],
        // M2 pos (0420): продажи к завершению, клуб заказа и продажи
        ['pos_due', 'bl_definer'],
        // M3 pos (0481): поиск существующего гостя для пакета на кассе (без создания учётки)
        ['pos_guest', 'bl_definer'],
        ['pos_object_club', 'bl_definer'],
        // M3 core (0703): публичный список клубов
        ['public_clubs', 'bl_definer'],
        // M1 light
        ['resource_by_code', 'bl_definer'],
        ['resource_club', 'bl_definer'],
        ['session_club', 'bl_definer'],
        // M5.1 backend-A (1001): is_test новой записи по режиму клуба (триггер)
        ['set_is_test', 'bl_definer'],
        // M3 core (0701, 0702): сводки и персонал
        ['staff_accept_invites', 'bl_definer'],
        ['staff_revoke', 'bl_definer'],
        ['summary_clubs', 'bl_definer'],
        // M1 core
        ['user_brief', 'bl_definer'],
      ],
    );
    for (const r of rows) assert.ok(r.proconfig?.some((s) => s.startsWith('search_path=pg_catalog')), `${r.proname}: search_path`);
  });
});
