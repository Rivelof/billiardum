// Цепочка хешей журнала (decisions №13): seq и хеш задаёт база, параллельные вставки
// без пропусков, подмену в обход триггеров выдаёт audit_verify.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { appendAudit, asRole, CLUB_A, CLUB_B, createTestDatabase, seedClubB, tryQuery } from './helpers.mjs';

let db;

before(async () => {
  db = await createTestDatabase();
  await seedClubB(db.pool);
});

after(async () => {
  await db?.drop();
});

const ZERO = '0'.repeat(64);

async function verify(clubId) {
  const { rows } = await db.pool.query('select * from bl.audit_verify($1)', [clubId]);
  return { ...rows[0], checked: Number(rows[0].checked), first_bad_seq: rows[0].first_bad_seq === null ? null : Number(rows[0].first_bad_seq) };
}

async function chain(clubId) {
  const { rows } = await db.pool.query(
    `select id, club_id, seq, created_at, actor_type, actor_id, action, object_type, object_id, reason, data::text as data,
            prev_hash, hash, (extract(epoch from created_at) * 1000000)::bigint::text as created_us
       from bl.audit_log where club_id is not distinct from $1 order by seq`,
    [clubId],
  );
  return rows;
}

/** Новый клуб для независимой цепочки. */
async function newClub(n) {
  const id = `c9000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  await db.pool.query("insert into bl.clubs (id, name, city, timezone) values ($1, 'Клуб теста', 'Пермь', 'Asia/Yekaterinburg')", [id]);
  return id;
}

/** Подмена суперпользователем в обход всех защит: снимает событийные триггеры и триггеры таблицы. */
async function tamper(sql, params) {
  const c = await db.pool.connect();
  try {
    await c.query('begin');
    await c.query('alter event trigger bl_audit_guard_ddl disable');
    await c.query('alter table bl.audit_log disable trigger audit_log_immutable_stmt, disable trigger audit_log_immutable_row');
    await c.query('set local session_replication_role = replica');
    await c.query(sql, params);
    await c.query('alter table bl.audit_log enable always trigger audit_log_immutable_stmt, enable always trigger audit_log_immutable_row');
    await c.query('alter event trigger bl_audit_guard_ddl enable always');
    await c.query('commit');
  } catch (err) {
    await c.query('rollback').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

describe('цепочка хешей audit_log', () => {
  it('seq, created_at, prev_hash, hash задаёт триггер и перезаписывает присланные', async () => {
    const club = await newClub(1);
    await asRole(db.pool, 'app_api', { clubId: club }, async (c) => {
      const { rows } = await c.query(
        `insert into bl.audit_log (club_id, action, seq, created_at, prev_hash, hash)
         values ($1, 'test.forged', 777, '2000-01-01', $2, $2)
         returning seq, created_at, prev_hash, hash, actor_type`,
        [club, 'f'.repeat(64)],
      );
      assert.equal(Number(rows[0].seq), 1);
      assert.equal(rows[0].prev_hash, ZERO);
      assert.notEqual(rows[0].hash, 'f'.repeat(64));
      assert.ok(rows[0].created_at > new Date('2020-01-01'));
      assert.equal(rows[0].actor_type, 'system', 'actor_type по умолчанию из app.actor_type');
    });
  });

  it('хеш воспроизводится по формуле из supabase/README.md', async () => {
    const club = await newClub(2);
    await appendAudit(db.pool, club, 'test.a', { amount: 149000, note: 'Стол 4 — «тест»', nested: { b: [1, 2], a: null } });
    await appendAudit(db.pool, club, 'test.b');
    const rows = await chain(club);
    let prev = ZERO;
    for (const r of rows) {
      const canonical = JSON.stringify([
        'bl.audit.v1',
        r.id,
        r.club_id,
        Number(r.seq),
        Number(r.created_us),
        r.actor_type,
        r.actor_id,
        r.action,
        r.object_type,
        r.object_id,
        r.reason,
        '__DATA__',
      ])
        .replace(/,/g, ', ')
        .replace('"__DATA__"', r.data);
      const expected = createHash('sha256').update(prev + canonical, 'utf8').digest('hex');
      assert.equal(r.prev_hash, prev);
      assert.equal(r.hash, expected, `seq ${r.seq}`);
      prev = r.hash;
    }
  });

  it('50 параллельных вставок в один клуб: seq 1…50 без пропусков, audit_verify — ok', async () => {
    const club = await newClub(3);
    const clients = await Promise.all(Array.from({ length: 50 }, () => db.pool.connect()));
    try {
      await Promise.all(
        clients.map(async (c) => {
          await c.query('begin');
          await c.query('set local role app_api');
          await c.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'system', true)", [club]);
        }),
      );
      await Promise.all(
        clients.map(async (c, i) => {
          await c.query("insert into bl.audit_log (club_id, action, data) values ($1, 'test.parallel', jsonb_build_object('i', $2::int))", [club, i]);
          await c.query('commit');
        }),
      );
    } finally {
      for (const c of clients) c.release();
    }
    const rows = await chain(club);
    assert.deepEqual(
      rows.map((r) => Number(r.seq)),
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
    assert.equal(new Set(rows.map((r) => JSON.parse(r.data).i)).size, 50);
    for (let i = 1; i < rows.length; i += 1) {
      assert.equal(rows[i].prev_hash, rows[i - 1].hash);
      assert.ok(rows[i].created_at >= rows[i - 1].created_at, 'created_at не убывает вместе с seq');
    }
    const v = await verify(club);
    assert.deepEqual(v, { ok: true, first_bad_seq: null, checked: 50, head_seq: '50', head_hash: rows.at(-1).hash });
  });

  it('у клубов и платформы — свои цепочки; параллельные вставки в разные клубы не мешают друг другу', async () => {
    const x = await newClub(4);
    const y = await newClub(5);
    await Promise.all([
      ...Array.from({ length: 10 }, () => appendAudit(db.pool, x, 'test.x')),
      ...Array.from({ length: 10 }, () => appendAudit(db.pool, y, 'test.y')),
      ...Array.from({ length: 3 }, () => appendAudit(db.pool, null, 'test.platform')),
    ]);
    for (const club of [x, y]) {
      const rows = await chain(club);
      assert.deepEqual(rows.map((r) => Number(r.seq)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      assert.equal(rows[0].prev_hash, ZERO);
      assert.equal((await verify(club)).ok, true);
    }
    const platform = await chain(null);
    assert.ok(platform.length >= 3);
    assert.equal(platform[0].prev_hash, ZERO);
    assert.equal((await verify(null)).ok, true);
  });

  it('пустая цепочка — ok, проверено 0', async () => {
    const club = await newClub(6);
    assert.deepEqual(await verify(club), { ok: true, first_bad_seq: null, checked: 0, head_seq: null, head_hash: null });
  });
});

describe('подмена в обход триггеров выдаётся audit_verify', () => {
  async function chainOf(n, count) {
    const club = await newClub(100 + n);
    for (let i = 0; i < count; i += 1) await appendAudit(db.pool, club, 'test.row', { i });
    assert.equal((await verify(club)).ok, true);
    return club;
  }

  it('одного session_replication_role = replica мало: UPDATE всё равно падает', async () => {
    const club = await chainOf(1, 3);
    await asRole(db.pool, null, { replica: true }, async (c) => {
      assert.match((await tryQuery(c, "update bl.audit_log set data = '{}' where club_id = $1", [club])).message, /append-only/);
    });
  });

  it('изменены данные записи 4 из 8 — первая испорченная 4', async () => {
    const club = await chainOf(2, 8);
    await tamper(`update bl.audit_log set data = '{"i": 999}' where club_id = $1 and seq = 4`, [club]);
    assert.deepEqual(await verify(club), { ok: false, first_bad_seq: 4, checked: 4, head_seq: null, head_hash: null });
  });

  it('запись 5 из 8 удалена — первая испорченная 5', async () => {
    const club = await chainOf(3, 8);
    await tamper('delete from bl.audit_log where club_id = $1 and seq = 5', [club]);
    const v = await verify(club);
    assert.equal(v.ok, false);
    assert.equal(v.first_bad_seq, 5);
  });

  it('запись 3 переписана вместе со своим хешем — цепь рвётся на 4', async () => {
    const club = await chainOf(4, 6);
    await tamper(
      `update bl.audit_log a
          set data = '{"i": 777}',
              hash = bl.audit_row_hash(a.prev_hash, a.id, a.club_id, a.seq, a.created_at, a.actor_type, a.actor_id,
                                       a.action, a.object_type, a.object_id, a.reason, '{"i": 777}'::jsonb)
        where club_id = $1 and seq = 3`,
      [club],
    );
    const v = await verify(club);
    assert.equal(v.ok, false);
    assert.equal(v.first_bad_seq, 4);
  });

  it('подмена в одном клубе не задевает цепочку другого', async () => {
    assert.equal((await verify(CLUB_B)).ok, true);
    assert.equal((await verify(CLUB_A)).ok, true);
  });
});

describe('audit_verify для app_api', () => {
  it('проверяет цепочку своего клуба, чужой — ошибка', async () => {
    await asRole(db.pool, 'app_api', { clubId: CLUB_B }, async (c) => {
      const { rows } = await c.query('select ok, checked from bl.audit_verify($1)', [CLUB_B]);
      assert.equal(rows[0].ok, true);
      assert.ok(Number(rows[0].checked) >= 1);
      const err = await tryQuery(c, 'select * from bl.audit_verify($1)', [CLUB_A]);
      assert.match(err?.message ?? '', /outside of the request context/);
    });
  });

  it('запись в цепочку платформы — только без контекста клуба и от system/support', async () => {
    await asRole(db.pool, 'app_api', { clubId: null, actorType: 'system' }, async (c) => {
      assert.equal(await tryQuery(c, "insert into bl.audit_log (club_id, action) values (null, 'test.platform_ok')"), null);
    });
    await asRole(db.pool, 'app_api', { clubId: null, actorType: 'user' }, async (c) => {
      assert.match((await tryQuery(c, "insert into bl.audit_log (club_id, action) values (null, 'test.platform_user')")).message, /row-level security/);
    });
    await asRole(db.pool, 'app_api', { clubId: CLUB_A, actorType: 'system' }, async (c) => {
      assert.match((await tryQuery(c, "insert into bl.audit_log (club_id, action) values (null, 'test.platform_ctx')")).message, /row-level security/);
    });
  });
});
