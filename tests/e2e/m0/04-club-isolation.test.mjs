// Критерий 3: изоляция клубов (RLS по club_id).
// * С контекстом клуба (как сервер: set_config('app.club_id', …, true)) app_api видит только свой клуб.
// * Без контекста — ноль строк во всех таблицах.
// * Вставка и перенос строки с чужим club_id отвергаются.
// Второй клуб создаётся суперпользователем только внутри транзакции и откатывается (ROLLBACK);
// проверки от app_api в той же транзакции — через SET LOCAL ROLE app_api (те же права и RLS).
// Отдельно — настоящий вход app_api по DATABASE_URL на рабочих данных.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { adminClient, appClient, attempt, CLUB_A, setContext } from './helpers.mjs';

// Таблицы с club_id (для clubs — id); users — через участников клуба.
const CLUB_TABLES = { clubs: 'id', club_members: 'club_id', resources: 'club_id', devices: 'club_id', tariff_rules: 'club_id', audit_log: 'club_id' };

async function countsByClub(c) {
  const out = {};
  for (const [tbl, col] of Object.entries(CLUB_TABLES)) {
    const { rows } = await c.query(`select ${col}::text as club, count(*)::int as n from bl.${tbl} group by 1 order by 1`);
    out[tbl] = Object.fromEntries(rows.map((r) => [r.club, r.n]));
  }
  const { rows } = await c.query('select id::text from bl.users order by 1');
  out.users = rows.map((r) => r.id);
  return out;
}

test('временный клуб B в транзакции: app_api видит только клуб из контекста, без контекста — ничего', async (t) => {
  const admin = await adminClient();
  const B = {
    club: randomUUID(),
    user: randomUUID(),
    resource: randomUUID(),
    device: randomUUID(),
    phone: `+7999${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
  };
  try {
    await admin.query('begin');
    await admin.query("set local lock_timeout = '5s'");
    // Клуб B со строкой в каждой таблице (суперпользователь, в обход RLS не нужен: он владелец схемы).
    await admin.query(`insert into bl.clubs (id, name, city, timezone) values ($1, 'E2E клуб B', 'Пермь', 'Asia/Yekaterinburg')`, [B.club]);
    await admin.query('insert into bl.users (id, phone) values ($1, $2)', [B.user, B.phone]);
    await admin.query(`insert into bl.club_members (club_id, user_id, role) values ($1, $2, 'owner')`, [B.club, B.user]);
    await admin.query(`insert into bl.resources (id, club_id, type, number, title) values ($1, $2, 'billiard_pool', 1, 'Стол B1')`, [B.resource, B.club]);
    await admin.query('insert into bl.devices (id, club_id, resource_id, mqtt_username) values ($1, $2, $3, $4)', [B.device, B.club, B.resource, B.device]);
    await admin.query(
      `insert into bl.tariff_rules (club_id, resource_type, days, start_local, end_local, price_per_hour)
       values ($1, 'billiard_pool', '{1,2,3,4,5,6,7}', '10:00', '17:00', 50000)`,
      [B.club],
    );
    await admin.query(`insert into bl.audit_log (club_id, actor_type, action) values ($1, 'system', 'e2e.isolation')`, [B.club]);

    const all = await countsByClub(admin);
    t.diagnostic(`суперпользователь видит клубы: ${JSON.stringify(all.clubs)}`);
    for (const tbl of Object.keys(CLUB_TABLES)) {
      assert.ok(all[tbl][CLUB_A] > 0, `нет строк клуба A в ${tbl}`);
      assert.ok(all[tbl][B.club] > 0, `нет строк клуба B в ${tbl}`);
    }

    await admin.query('set local role app_api');
    assert.equal((await admin.query('select current_user')).rows[0].current_user, 'app_api');

    // Контекст A: только A.
    await setContext(admin, CLUB_A);
    const seenA = await countsByClub(admin);
    for (const tbl of Object.keys(CLUB_TABLES)) {
      t.diagnostic(`контекст A, ${tbl}: ${JSON.stringify(seenA[tbl])}`);
      assert.deepEqual(Object.keys(seenA[tbl]), [CLUB_A], `${tbl}: с контекстом A видны чужие строки`);
      assert.equal(seenA[tbl][CLUB_A], all[tbl][CLUB_A], `${tbl}: видны не все строки своего клуба`);
    }
    assert.ok(!seenA.users.includes(B.user), 'пользователь клуба B виден из клуба A');
    t.diagnostic(`контекст A, users: ${seenA.users.length}`);

    // Чужой club_id: вставка и перенос — отказ RLS.
    const fakeDevice = randomUUID();
    const attacks = [
      ['club_members', 'insert into bl.club_members (club_id, user_id, role) values ($1, $2, \'manager\')', [B.club, B.user]],
      ['resources', "insert into bl.resources (club_id, type, number, title) values ($1, 'billiard_pool', 99, 'чужой')", [B.club]],
      ['devices', 'insert into bl.devices (id, club_id, mqtt_username) values ($1, $2, $3)', [fakeDevice, B.club, fakeDevice]],
      [
        'tariff_rules',
        "insert into bl.tariff_rules (club_id, resource_type, days, start_local, end_local, price_per_hour) values ($1, 'billiard_pool', '{1}', '10:00', '11:00', 1)",
        [B.club],
      ],
      ['audit_log', "insert into bl.audit_log (club_id, actor_type, action) values ($1, 'system', 'e2e.foreign')", [B.club]],
      ['audit_log (NULL-цепочка платформы с контекстом клуба)', "insert into bl.audit_log (club_id, actor_type, action) values (null, 'system', 'e2e.platform')", []],
      ['clubs', "insert into bl.clubs (name, city, timezone) values ('чужой', 'Пермь', 'Asia/Yekaterinburg')", []],
      ['resources: перенос своей строки в клуб B', 'update bl.resources set club_id = $1 where club_id = $2', [B.club, CLUB_A]],
      ['tariff_rules: перенос своей строки в клуб B', 'update bl.tariff_rules set club_id = $1 where club_id = $2', [B.club, CLUB_A]],
      ['clubs: правка чужого клуба', "update bl.clubs set name = 'взлом' where id = $1", [B.club]],
      ['audit_verify чужого клуба', 'select * from bl.audit_verify($1)', [B.club]],
    ];
    for (const [name, sql, params] of attacks) {
      const r = await attempt(admin, sql, params);
      const changed = r.ok && sql.startsWith('update') ? r.rowCount : null;
      t.diagnostic(`контекст A → ${name}: ${r.ok ? `прошло, строк ${r.rowCount}` : `${r.code} ${r.message}`}`);
      if (sql.startsWith('update bl.clubs')) {
        // Чужой клуб не виден — UPDATE затрагивает 0 строк.
        assert.ok(!r.ok || changed === 0, `${name}: изменена строка чужого клуба`);
      } else {
        assert.equal(r.ok, false, `${name}: прошло`);
      }
    }

    // Контекст B: только B.
    await setContext(admin, B.club);
    const seenB = await countsByClub(admin);
    for (const tbl of Object.keys(CLUB_TABLES)) {
      assert.deepEqual(Object.keys(seenB[tbl]), [B.club], `${tbl}: с контекстом B видны чужие строки`);
    }
    assert.deepEqual(seenB.users, [B.user], 'из клуба B видны пользователи клуба A');
    t.diagnostic(`контекст B: ${JSON.stringify(Object.fromEntries(Object.entries(seenB).map(([k, v]) => [k, Array.isArray(v) ? v.length : v])))}`);

    // Без контекста: ноль строк везде.
    await setContext(admin, null);
    const none = await countsByClub(admin);
    for (const tbl of Object.keys(CLUB_TABLES)) assert.deepEqual(none[tbl], {}, `${tbl}: без контекста видны строки`);
    assert.deepEqual(none.users, []);
    t.diagnostic('без контекста: 0 строк во всех таблицах (clubs, club_members, resources, devices, tariff_rules, audit_log, users)');
  } finally {
    await admin.query('rollback');
    // Клуб B не остался в базе.
    const { rows } = await admin.query('select count(*)::int as n from bl.clubs where id = $1', [B.club]);
    await admin.end();
    assert.equal(rows[0].n, 0, 'временный клуб B остался после ROLLBACK');
  }
});

test('app_api по DATABASE_URL (рабочие данные): свой клуб, без контекста — ноль, чужой club_id — отказ', async (t) => {
  const app = await appClient();
  const foreign = randomUUID();
  try {
    await app.query('begin');
    await setContext(app, CLUB_A);
    const a = await countsByClub(app);
    t.diagnostic(`контекст A: ${JSON.stringify(Object.fromEntries(Object.entries(a).map(([k, v]) => [k, Array.isArray(v) ? v.length : v])))}`);
    for (const tbl of Object.keys(CLUB_TABLES)) assert.deepEqual(Object.keys(a[tbl]), [CLUB_A], tbl);
    // С M5.8 (сид 1300_padel.sql): 8 столов и 2 корта, у каждого контроллер.
    assert.equal(a.resources[CLUB_A], 10, '10 ресурсов сида: столы 1–8 и 2 корта');
    assert.equal(a.devices[CLUB_A], 10, '10 устройств сида');
    // Расшифровка ключей в базе невозможна: device_key_enc — шифртекст v1:.
    const { rows: keys } = await app.query("select count(*)::int as n from bl.devices where device_key_enc like 'v1:%'");
    assert.equal(keys[0].n, 10);
    const r = await attempt(app, "insert into bl.resources (club_id, type, number, title) values ($1, 'billiard_pool', 77, 'x')", [foreign]);
    t.diagnostic(`вставка с чужим club_id: ${r.code} ${r.message}`);
    assert.equal(r.ok, false);
    assert.equal(r.code, '42501');
    await app.query('rollback');

    await app.query('begin');
    await setContext(app, null);
    const none = await countsByClub(app);
    for (const tbl of Object.keys(CLUB_TABLES)) assert.deepEqual(none[tbl], {}, `${tbl}: без контекста видны строки`);
    assert.deepEqual(none.users, []);
    const r2 = await attempt(app, "insert into bl.resources (club_id, type, number, title) values ($1, 'billiard_pool', 77, 'x')", [CLUB_A]);
    t.diagnostic(`без контекста вставка в клуб A: ${r2.code} ${r2.message}`);
    assert.equal(r2.ok, false);
    t.diagnostic('без контекста: 0 строк во всех таблицах');
    await app.query('rollback');

    // Служебная таблица миграций app_api недоступна.
    await app.query('begin');
    const r3 = await attempt(app, 'select count(*) from bl.schema_migrations');
    await app.query('rollback');
    assert.equal(r3.code, '42501');
  } finally {
    await app.query('rollback').catch(() => {});
    await app.end();
  }
});
