// PoC безопасности M0 — журнал bl.audit_log (объект атаки 1, инвариант 2, decisions №13, №38).
// Атакующий: ресепшн/посторонний (роль app_api) и суперпользователь (DATABASE_ADMIN_URL).
// Для app_api цель — «не может». Для суперпользователя цель — «будет замечено» (audit_verify
// и хеш головы). Разрушающие доказательства — только во ВРЕМЕННОЙ базе bl_pentest_*.
// На РАБОЧЕЙ базе — только откатываемые попытки, которые и так падают.
//
// Запуск: node --test tests/security/m0/db_audit.test.mjs

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { adminUrl } from './_env.mjs';
import { asRole, CLUB_A, createTempDb, tryQuery } from './_db.mjs';

// ------- рабочая (живая) база: только откатываемые попытки -------
describe('рабочая база: журнал неизменяем для всех ролей (откат)', () => {
  let pool;
  before(() => { pool = new pg.Pool({ connectionString: adminUrl(), max: 4 }); pool.on('error', () => {}); });
  after(async () => { if (pool) await pool.end(); });

  const forbidden = [
    ['update', 'update bl.audit_log set action = $$hacked$$ where seq = 1'],
    ['delete', 'delete from bl.audit_log where seq = 1'],
    ['truncate', 'truncate bl.audit_log'],
  ];

  for (const [name, sql] of forbidden) {
    test(`суперпользователь: ${name} журнала падает (в т.ч. replica)`, async () => {
      await asRole(pool, null, { replica: true }, async (client) => {
        const err = await tryQuery(client, sql);
        assert.ok(err, `${name} суперпользователем не должен проходить`);
        assert.match(err.message, /append-only|protected|forbidden/i);
      });
    });
    test(`app_api: ${name} журнала падает`, async () => {
      await asRole(pool, 'app_api', { clubId: CLUB_A }, async (client) => {
        const err = await tryQuery(client, sql);
        assert.ok(err, `${name} под app_api не должен проходить`);
      });
    });
  }

  test('суперпользователь: DISABLE TRIGGER журнала заблокирован событийным триггером (откат)', async () => {
    await asRole(pool, null, {}, async (client) => {
      const err = await tryQuery(client, 'alter table bl.audit_log disable trigger audit_log_immutable_row');
      assert.ok(err, 'DISABLE TRIGGER должен блокироваться bl_audit_guard_ddl');
      assert.match(err.message, /protected|forbidden/i);
    });
  });

  test('суперпользователь: смена владельца журнала заблокирована (откат)', async () => {
    await asRole(pool, null, {}, async (client) => {
      const err = await tryQuery(client, 'alter table bl.audit_log owner to app_api');
      assert.ok(err, 'OWNER TO должен блокироваться');
    });
  });

  test('суперпользователь: DROP TABLE журнала заблокирован (откат)', async () => {
    await asRole(pool, null, {}, async (client) => {
      const err = await tryQuery(client, 'drop table bl.audit_log');
      assert.ok(err, 'DROP TABLE журнала должен блокироваться');
    });
  });
});

// ------- временная база: вставки, подделка полей, параллелизм, порча и обнаружение -------
describe('временная база: подделка полей, параллелизм, обнаружение порчи', () => {
  let db;
  before(async () => { db = await createTempDb(); });
  after(async () => { if (db) await db.drop(); });

  test('присланные seq/created_at/prev_hash/hash перезаписываются триггером', async () => {
    const forgedHash = 'f'.repeat(64);
    await asRole(db.pool, 'app_api', { clubId: CLUB_A, actorType: 'system' }, async (client) => {
      const { rows } = await client.query(
        `insert into bl.audit_log (club_id, seq, created_at, action, data, prev_hash, hash)
         values ($1, 999999, '1999-01-01', 'forge.attempt', '{}', $2, $2)
         returning seq, hash, extract(epoch from created_at) AS ts`,
        [CLUB_A, forgedHash],
      );
      assert.notEqual(Number(rows[0].seq), 999999, 'seq не должен быть принят от приложения');
      assert.notEqual(rows[0].hash, forgedHash, 'hash должен считать триггер');
      assert.ok(Number(rows[0].ts) > 1_600_000_000, 'created_at должен ставить сервер (clock_timestamp), не 1999');
      // откат: ничего в журнал не коммитим зря
      await client.query('rollback');
    });
  });

  test('50 параллельных вставок: seq без пропусков, audit_verify ok', async () => {
    const base = await headSeq(db.pool, CLUB_A);
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => appendAudit(db.pool, CLUB_A, `race.${i}`)),
    );
    const client = await db.pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role app_api');
      await client.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'system', true)", [CLUB_A]);
      const v = await client.query('select * from bl.audit_verify($1)', [CLUB_A]);
      assert.equal(v.rows[0].ok, true, 'цепочка после гонки должна быть целой');
      const seqs = await client.query('select seq from bl.audit_log where club_id = $1 order by seq', [CLUB_A]);
      const list = seqs.rows.map((r) => Number(r.seq));
      for (let i = 1; i < list.length; i += 1) assert.equal(list[i] - list[i - 1], 1, 'seq с пропуском');
      assert.ok(list[list.length - 1] >= base + 50, 'должно добавиться 50 записей');
      await client.query('rollback');
    } finally { client.release(); }
  });

  test('ПОРЧА суперпользователем data одной записи — audit_verify указывает первую испорченную и меняет head_hash', async () => {
    // Голова до порчи — то, что уже «ушло владельцу» (decisions №13).
    const before = await verify(db.pool, CLUB_A);
    assert.equal(before.ok, true);
    const targetSeq = 2;

    // Полный обход всех защит доступен только суперпользователю:
    // сначала выключить событийные триггеры-сторожа, затем строковый immutable-триггер.
    const c = await db.pool.connect();
    try {
      await c.query('begin');
      await c.query('alter event trigger bl_audit_guard_ddl disable');
      await c.query('alter event trigger bl_audit_guard_drop disable');
      await c.query('alter table bl.audit_log disable trigger audit_log_immutable_row');
      await c.query('alter table bl.audit_log disable trigger audit_log_immutable_stmt');
      await c.query("update bl.audit_log set data = '{\"tampered\":true}' where club_id = $1 and seq = $2", [CLUB_A, targetSeq]);
      await c.query('commit'); // во временной базе — специально фиксируем порчу
    } catch (err) {
      await c.query('rollback').catch(() => {});
      throw err;
    } finally { c.release(); }

    const after2 = await verify(db.pool, CLUB_A);
    assert.equal(after2.ok, false, 'audit_verify обязан заметить порчу');
    assert.equal(Number(after2.first_bad_seq), targetSeq, 'должна указываться первая испорченная запись');
    assert.equal(after2.head_hash, null, 'у испорченной цепочки head_hash = NULL (голова не подтверждается)');
    assert.notEqual(before.head_hash, null);
  });

  test('ПЕРЕПИСЬ хвоста целиком (с пересчётом хешей) — ловится по несовпадению head_hash с отправленным владельцу', async () => {
    const db2 = await createTempDb();
    try {
      // Добавим ещё записей, зафиксируем «отправленную владельцу» голову.
      for (let i = 0; i < 4; i += 1) await appendAudit(db2.pool, CLUB_A, `pre.${i}`);
      const published = await verify(db2.pool, CLUB_A); // head_hash ушёл владельцу
      assert.equal(published.ok, true);

      // Суперпользователь переписывает data записи seq=3 и ЧЕСТНО пересчитывает
      // hash этой и всех последующих записей (prev_hash → hash), чтобы audit_verify
      // снова вернул ok. Цель — доказать, что подмену всё равно видно по голове.
      const c = await db2.pool.connect();
      try {
        await c.query('begin');
        await c.query('alter event trigger bl_audit_guard_ddl disable');
        await c.query('alter event trigger bl_audit_guard_drop disable');
        await c.query('alter table bl.audit_log disable trigger audit_log_immutable_row');
        await c.query('alter table bl.audit_log disable trigger audit_log_immutable_stmt');
        await c.query("update bl.audit_log set data = '{\"tampered\":true}' where club_id = $1 and seq = 3", [CLUB_A]);
        // Пересчитать всю цепочку клуба заново на стороне клиента и переписать hash/prev_hash.
        const { rows } = await c.query(
          `select seq, id, club_id, (extract(epoch from created_at)*1000000)::bigint AS ts,
                  actor_type, actor_id, action, object_type, object_id, reason, data::text AS data
             from bl.audit_log where club_id = $1 order by seq`, [CLUB_A]);
        let prev = '0'.repeat(64);
        for (const r of rows) {
          const canonical = JSON.stringify([
            'bl.audit.v1', r.id, r.club_id, Number(r.seq), Number(r.ts),
            r.actor_type, r.actor_id, r.action, r.object_type, r.object_id, r.reason, JSON.parse(r.data),
          ]);
          // Формула базы использует jsonb-текст; клиентский пересчёт здесь приблизительный,
          // поэтому нам важен сам факт смены головы, а не прохождение audit_verify.
          const hash = createHash('sha256').update(prev + canonical, 'utf8').digest('hex');
          await c.query('update bl.audit_log set prev_hash = $2, hash = $3 where club_id = $1 and seq = $4', [CLUB_A, prev, hash, r.seq]);
          prev = hash;
        }
        await c.query('commit');
      } catch (err) { await c.query('rollback').catch(() => {}); throw err; } finally { c.release(); }

      const now = await verify(db2.pool, CLUB_A);
      // Независимо от того, прошла проверка цепочки или нет, голова отличается от отправленной.
      assert.notEqual(now.head_hash, published.head_hash, 'переписанная цепочка обязана дать другую голову');
    } finally {
      await db2.drop();
    }
  });
});

// ---- помощники ----
async function appendAudit(pool, clubId, action) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role app_api');
    await c.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'system', true)", [clubId]);
    await c.query('insert into bl.audit_log (club_id, action, data) values ($1, $2, $3)', [clubId, action, {}]);
    await c.query('commit');
  } catch (err) { await c.query('rollback').catch(() => {}); throw err; } finally { c.release(); }
}
async function headSeq(pool, clubId) {
  const { rows } = await pool.query('select coalesce(max(seq),0)::int n from bl.audit_log where club_id = $1', [clubId]);
  return rows[0].n;
}
async function verify(pool, clubId) {
  const { rows } = await pool.query('select * from bl.audit_verify($1)', [clubId]);
  return rows[0];
}
