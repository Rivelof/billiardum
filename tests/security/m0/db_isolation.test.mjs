// PoC безопасности M0 — изоляция клубов RLS (объект атаки 2, инвариант 5, contracts/m0.md §5).
// Атакующий: посторонний/другой клуб под ролью app_api. Проверяется во ВРЕМЕННОЙ базе
// (CREATE DATABASE bl_pentest_*): с контекстом клуба A не видно и не пишется клуб B;
// пустой/битый контекст закрывает всё; узкие функции SECURITY DEFINER отдают только club_id.
//
// Запуск: node --test tests/security/m0/db_isolation.test.mjs

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ALL_CLUB_TABLES, asRole, CLUB_A, CLUB_B, createTempDb, DEV_B, tryQuery } from './_db.mjs';

let db;
before(async () => { db = await createTempDb(); });
after(async () => { if (db) await db.drop(); });

test('с контекстом клуба A не видно ни одной строки клуба B', async () => {
  await asRole(db.pool, 'app_api', { clubId: CLUB_A }, async (client) => {
    for (const table of ALL_CLUB_TABLES) {
      const col = table === 'clubs' ? 'id' : 'club_id';
      const { rows } = await client.query(`select count(*)::int n from bl.${table} where ${col} = $1`, [CLUB_B]);
      assert.equal(rows[0].n, 0, `клуб A видит строки клуба B в ${table}`);
    }
    // При этом свои строки видны (RLS не ломает нормальную работу).
    const own = await client.query('select count(*)::int n from bl.resources where club_id = $1', [CLUB_A]);
    assert.ok(own.rows[0].n >= 8, 'клуб A должен видеть свои 8 столов');
  });
});

test('app_api с контекстом клуба A не может вставить строку в клуб B', async () => {
  await asRole(db.pool, 'app_api', { clubId: CLUB_A }, async (client) => {
    const err = await tryQuery(
      client,
      "insert into bl.resources (club_id, type, number, title) values ($1, 'billiard_pool', 99, 'взлом')",
      [CLUB_B],
    );
    assert.ok(err, 'вставка в чужой клуб должна падать на RLS with check');
    assert.match(err.message, /row-level security|policy/i);
  });
});

test('app_api с контекстом клуба A не может перенести свой стол в клуб B', async () => {
  await asRole(db.pool, 'app_api', { clubId: CLUB_A }, async (client) => {
    const { rows } = await client.query('select id from bl.resources where club_id = $1 limit 1', [CLUB_A]);
    const err = await tryQuery(client, 'update bl.resources set club_id = $2 where id = $1', [rows[0].id, CLUB_B]);
    assert.ok(err, 'перенос строки в чужой клуб должен падать');
  });
});

test('пустой контекст клуба — ноль строк в каждой таблице', async () => {
  await asRole(db.pool, 'app_api', { clubRaw: '' }, async (client) => {
    for (const table of ALL_CLUB_TABLES) {
      const { rows } = await client.query(`select count(*)::int n from bl.${table}`);
      assert.equal(rows[0].n, 0, `без контекста видны строки ${table}`);
    }
  });
});

test('битый контекст (не UUID) закрывает доступ ошибкой, а не открывает всё', async () => {
  for (const bad of ['not-a-uuid', '   ', "c1000000-0000-4000-8000-000000000001' or '1'='1", '00000000']) {
    await asRole(db.pool, 'app_api', { clubRaw: bad }, async (client) => {
      const err = await tryQuery(client, 'select count(*) from bl.resources');
      assert.ok(err, `битый app.club_id (${JSON.stringify(bad)}) должен давать ошибку, а не данные`);
    });
  }
});

test('контекст клуба B показывает только клуб B — переключение не протекает', async () => {
  await asRole(db.pool, 'app_api', { clubId: CLUB_B }, async (client) => {
    const a = await client.query('select count(*)::int n from bl.resources where club_id = $1', [CLUB_A]);
    const b = await client.query('select count(*)::int n from bl.resources where club_id = $1', [CLUB_B]);
    assert.equal(a.rows[0].n, 0, 'контекст B не должен видеть A');
    assert.equal(b.rows[0].n, 1, 'контекст B видит свой стол');
  });
});

test('audit_verify чужого клуба под app_api — ошибка (не читает чужую цепочку)', async () => {
  await asRole(db.pool, 'app_api', { clubId: CLUB_A }, async (client) => {
    const err = await tryQuery(client, 'select * from bl.audit_verify($1)', [CLUB_B]);
    assert.ok(err, 'app_api не должен проверять цепочку чужого клуба');
    assert.match(err.message, /context|outside/i);
  });
});

test('узкие SECURITY DEFINER отдают только club_id/счётчик (документируем кросс-клубную выдачу)', async () => {
  await asRole(db.pool, 'app_api', { clubId: CLUB_A }, async (client) => {
    // device_club резолвит устройство любого клуба в его club_id — это нужно мосту MQTT
    // (клуб устройства до контекста). Утечки строки нет: функция возвращает только club_id.
    const dc = await client.query('select bl.device_club($1) AS club', [DEV_B]);
    assert.equal(dc.rows[0].club, CLUB_B, 'device_club резолвит клуб чужого устройства (ожидаемо, узкая функция)');
    // Но прочитать строку чужого устройства напрямую нельзя.
    const direct = await client.query('select count(*)::int n from bl.devices where id = $1', [DEV_B]);
    assert.equal(direct.rows[0].n, 0, 'строка чужого устройства по RLS невидима');
    // device_total — счётчик по всем клубам (лог devices_online), не раскрывает строк.
    const dt = await client.query('select bl.device_total() AS total');
    assert.ok(Number(dt.rows[0].total) >= 9, 'device_total считает устройства всех клубов');
  });
});

test('в схеме bl нет лишних функций SECURITY DEFINER (только три разрешённые)', async () => {
  const { rows } = await db.pool.query(`
    select n.nspname||'.'||p.proname AS fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'bl' and p.prosecdef
     order by 1`);
  const got = rows.map((r) => r.fn).sort();
  // Разрешены: device_club, device_total (bl_definer) и audit_log_chain (bl_audit_owner).
  assert.deepEqual(got, ['bl.audit_log_chain', 'bl.device_club', 'bl.device_total']);
});
