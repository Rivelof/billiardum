// Таблицы денег (0200, 0201): RLS по клубу, права app_api, неизменяемость платежа,
// узкие функции, праздники 2026–2027.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { asRole, CLUB_A, CLUB_B, createTestDatabase, OWNER_A, OWNER_B, seedClubB, tryQuery } from './helpers.mjs';

const MONEY_TABLES = ['club_payment_settings', 'quotes', 'payments', 'refunds', 'reception_requests', 'receipts', 'holidays'];
const TABLE_A = 'e1000000-0000-4000-8000-000000000001';
const TABLE_B = 'e2000000-0000-4000-8000-000000000001';
const ids = (club) => {
  const n = club === CLUB_A ? '1' : '2';
  return {
    quote: `c${n}100000-0000-4000-8000-0000000000aa`,
    payment: `c${n}200000-0000-4000-8000-0000000000aa`,
    refund: `c${n}300000-0000-4000-8000-0000000000aa`,
    request: `c${n}400000-0000-4000-8000-0000000000aa`,
    receipt: `c${n}500000-0000-4000-8000-0000000000aa`,
  };
};

let db;

async function seedMoney(club, table, user) {
  const i = ids(club);
  const q = (sql, p) => db.pool.query(sql, p);
    await q(`insert into bl.club_payment_settings (club_id, shop_id, secret_key_enc) values ($1, 'shop', 'v1:enc')
             on conflict (club_id) do update set shop_id = 'shop', secret_key_enc = 'v1:enc'`, [club]);
    await q(`insert into bl.quotes (id, club_id, resource_id, user_id, kind, minutes, from_at, amount_kopecks, valid_until, created_at)
             values ($1, $2, $3, $4, 'start', 60, now(), 50000, now() + interval '3 minutes', now())`, [i.quote, club, table, user]);
    await q(`insert into bl.payments (id, club_id, resource_id, user_id, quote_id, kind, provider, method, provider_payment_id,
                                      idempotence_key, status, amount_kopecks, minutes, created_at)
             values ($1, $2, $3, $4, $5, 'start', 'yookassa', 'sbp', $6, $6, 'pending', 50000, 60, now() - interval '5 minutes')`,
      [i.payment, club, table, user, i.quote, `yk-${i.payment}`]);
    await q(`insert into bl.refunds (id, club_id, payment_id, idempotence_key, amount_kopecks, status, reason)
             values ($1, $2, $3, $4, 100, 'pending', 'тест')`, [i.refund, club, i.payment, `r-${i.refund}`]);
    await q(`insert into bl.reception_requests (id, club_id, quote_id, resource_id, user_id, kind, minutes, amount_kopecks, expires_at)
             values ($1, $2, $3, $4, $5, 'start', 60, 50000, now() - interval '1 minute')`, [i.request, club, i.quote, table, user]);
    await q(`insert into bl.receipts (id, club_id, payment_id, kind, channel, status, amount_kopecks, items)
             values ($1, $2, $3, 'sale', 'yookassa', 'pending', 50000, '[]')`, [i.receipt, club, i.payment]);
    await q(`insert into bl.holidays (club_id, day, kind, title) values ($1, '2026-08-30', 'holiday', 'День клуба')`, [club]);
}

before(async () => {
  db = await createTestDatabase();
  await seedClubB(db.pool);
  await seedMoney(CLUB_A, TABLE_A, OWNER_A);
  await seedMoney(CLUB_B, TABLE_B, OWNER_B);
});

after(async () => {
  await db?.drop();
});

describe('RLS таблиц денег', () => {
  it('ENABLE и FORCE ROW LEVEL SECURITY, владелец bl_owner', async () => {
    const { rows } = await db.pool.query(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) as owner
         from pg_class c where c.relnamespace = 'bl'::regnamespace and c.relname = any($1)`,
      [MONEY_TABLES],
    );
    assert.equal(rows.length, MONEY_TABLES.length);
    for (const r of rows) {
      assert.ok(r.relrowsecurity && r.relforcerowsecurity, r.relname);
      assert.equal(r.owner, 'bl_owner', r.relname);
    }
  });

  it('в контексте клуба А не видно строк клуба Б ни в одной таблице', async () => {
    await asRole(db.pool, 'app_api', { clubId: CLUB_A }, async (c) => {
      for (const t of MONEY_TABLES.filter((x) => x !== 'holidays')) {
        const { rows } = await c.query(`select distinct club_id from bl.${t}`);
        assert.deepEqual(rows.map((r) => r.club_id), [CLUB_A], t);
      }
      const hol = await c.query('select distinct club_id from bl.holidays');
      assert.deepEqual(hol.rows.map((r) => r.club_id).sort(), [CLUB_A, null].sort());
    });
  });

  it('без контекста клуба — ноль строк (кроме федеральных праздников)', async () => {
    await asRole(db.pool, 'app_api', { clubId: null }, async (c) => {
      for (const t of MONEY_TABLES.filter((x) => x !== 'holidays')) {
        assert.equal((await c.query(`select count(*)::int as n from bl.${t}`)).rows[0].n, 0, t);
      }
      const hol = await c.query('select count(*)::int as n, count(club_id)::int as clubbed from bl.holidays');
      assert.ok(hol.rows[0].n > 0);
      assert.equal(hol.rows[0].clubbed, 0);
    });
  });

  it('вставка строки клуба Б в контексте клуба А — отказ RLS', async () => {
    await asRole(db.pool, 'app_api', { clubId: CLUB_A }, async (c) => {
      const err = await tryQuery(
        c,
        `insert into bl.quotes (club_id, resource_id, user_id, kind, minutes, from_at, amount_kopecks, valid_until, created_at)
         values ($1, $2, $3, 'start', 60, now(), 1, now() + interval '1 minute', now())`,
        [CLUB_B, TABLE_B, OWNER_B],
      );
      assert.equal(err?.code, '42501');
      const err2 = await tryQuery(c, `insert into bl.club_payment_settings (club_id) values ($1)`, [CLUB_B]);
      assert.equal(err2?.code, '42501');
      const err3 = await tryQuery(c, `insert into bl.holidays (day, kind, title) values ('2026-09-01', 'holiday', 'x')`);
      assert.equal(err3?.code, '42501', 'праздники app_api не пишет');
    });
  });

  it('app_api: нет DELETE и TRUNCATE; сумму, клуб и способ платежа не изменить', async () => {
    await asRole(db.pool, 'app_api', { clubId: CLUB_A }, async (c) => {
      for (const t of MONEY_TABLES) {
        assert.equal((await tryQuery(c, `delete from bl.${t}`))?.code, '42501', `delete ${t}`);
        assert.equal((await tryQuery(c, `truncate bl.${t}`))?.code, '42501', `truncate ${t}`);
      }
      for (const col of ['amount_kopecks = 1', 'club_id = club_id', 'method = method', 'user_id = user_id', 'provider_payment_id = null', 'quote_id = null']) {
        assert.equal((await tryQuery(c, `update bl.payments set ${col}`))?.code, '42501', col);
      }
      assert.equal((await tryQuery(c, 'update bl.quotes set amount_kopecks = 1'))?.code, '42501');
      assert.equal((await tryQuery(c, 'update bl.reception_requests set amount_kopecks = 1'))?.code, '42501');
      assert.equal((await tryQuery(c, 'update bl.refunds set amount_kopecks = 1'))?.code, '42501');
      assert.equal(await tryQuery(c, "update bl.payments set status = 'waiting_for_capture'"), null);
    });
  });

  it('подтверждение один раз: confirmed_at не переписать, конечный статус не изменить', async () => {
    const p = ids(CLUB_A).payment;
    await asRole(db.pool, 'app_api', { clubId: CLUB_A }, async (c) => {
      await c.query("update bl.payments set status = 'succeeded', confirmed_at = now() where id = $1", [p]);
      assert.equal((await tryQuery(c, "update bl.payments set confirmed_at = now() + interval '1 second' where id = $1", [p]))?.code, '23514');
      assert.equal((await tryQuery(c, "update bl.payments set status = 'pending' where id = $1", [p]))?.code, '23514');
      assert.equal((await tryQuery(c, "update bl.payments set status = 'canceled' where id = $1", [p]))?.code, '23514');
    });
  });

  it('provider_payment_id уникален во всех клубах', async () => {
    await asRole(db.pool, null, {}, async (c) => {
      const err = await tryQuery(
        c,
        `insert into bl.payments (club_id, resource_id, user_id, kind, provider, method, provider_payment_id, idempotence_key, status, amount_kopecks)
         values ($1, $2, $3, 'start', 'yookassa', 'sbp', $4, 'other', 'pending', 1)`,
        [CLUB_B, TABLE_B, OWNER_B, `yk-${ids(CLUB_A).payment}`],
      );
      assert.equal(err?.code, '23505');
    });
  });
});

describe('узкие функции денег', () => {
  it('money_object_club находит клуб котировки, платежа, заявки любого клуба', async () => {
    await asRole(db.pool, 'app_api', { clubId: null }, async (c) => {
      for (const club of [CLUB_A, CLUB_B]) {
        const i = ids(club);
        for (const [kind, id] of [['quote', i.quote], ['payment', i.payment], ['reception_request', i.request]]) {
          const { rows } = await c.query('select bl.money_object_club($1, $2) as club', [kind, id]);
          assert.equal(rows[0].club, club, `${kind} ${club}`);
        }
      }
      assert.equal((await c.query("select bl.money_object_club('payment', 'c9999999-0000-4000-8000-000000000000') as club")).rows[0].club, null);
      assert.equal((await c.query("select bl.money_object_club('refund', $1) as club", [ids(CLUB_A).refund])).rows[0].club, null);
    });
  });

  it('money_due: сгоревшие заявки и зависшие платежи всех клубов, только id', async () => {
    await asRole(db.pool, 'app_api', { clubId: null }, async (c) => {
      const { rows, fields } = await c.query('select * from bl.money_due(now(), 100)');
      assert.deepEqual(fields.map((f) => f.name), ['club_id', 'kind', 'id']);
      const got = rows.map((r) => `${r.kind}:${r.id}`).sort();
      assert.ok(got.includes(`reception_expired:${ids(CLUB_A).request}`));
      assert.ok(got.includes(`reception_expired:${ids(CLUB_B).request}`));
      assert.ok(got.includes(`payment_stale:${ids(CLUB_B).payment}`));
    });
  });

  it('функции денег принадлежат bl_definer, search_path закреплён, EXECUTE только у app_api', async () => {
    const { rows } = await db.pool.query(
      `select p.proname, pg_get_userbyid(p.proowner) as owner, p.proconfig, p.prosecdef,
              has_function_privilege('anon', p.oid, 'execute') as anon_exec
         from pg_proc p where p.pronamespace = 'bl'::regnamespace and p.proname in ('money_object_club', 'money_due')`,
    );
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.owner, 'bl_definer');
      assert.ok(r.prosecdef);
      assert.ok(r.proconfig.some((s) => s.startsWith('search_path=pg_catalog')));
      assert.equal(r.anon_exec, false);
    }
  });

  it('bl_definer видит у платежей только id, club_id и поля планировщика', async () => {
    await asRole(db.pool, 'bl_definer', {}, async (c) => {
      assert.equal((await tryQuery(c, 'select amount_kopecks from bl.payments'))?.code, '42501');
      assert.equal((await tryQuery(c, 'select secret_key_enc from bl.club_payment_settings'))?.code, '42501');
      assert.equal(await tryQuery(c, 'select id, club_id, status from bl.payments'), null);
    });
  });
});

describe('праздники (0201)', () => {
  it('2026 и 2027: праздники ст. 112 ТК РФ и переносы', async () => {
    const { rows } = await db.pool.query(
      "select to_char(day, 'YYYY-MM-DD') as day, kind from bl.holidays where club_id is null order by day",
    );
    const days = rows.map((r) => r.day);
    assert.equal(days.filter((d) => d.startsWith('2026')).length, 18);
    assert.equal(days.filter((d) => d.startsWith('2027')).length, 20);
    for (const d of ['2026-01-09', '2026-03-09', '2026-05-11', '2026-12-31', '2027-02-22', '2027-05-03', '2027-05-10', '2027-06-14', '2027-11-05', '2027-12-31']) {
      assert.equal(rows.find((r) => r.day === d)?.kind, 'transfer', d);
    }
    for (const d of ['2026-01-07', '2026-02-23', '2026-11-04', '2027-03-08', '2027-06-12']) {
      assert.equal(rows.find((r) => r.day === d)?.kind, 'holiday', d);
    }
    assert.ok(!days.includes('2027-02-20'), 'рабочая суббота не хранится');
  });

  it('свой день клуба виден только клубу', async () => {
    await asRole(db.pool, 'app_api', { clubId: CLUB_A }, async (c) => {
      const { rows } = await c.query("select club_id from bl.holidays where day = '2026-08-30'");
      assert.deepEqual(rows.map((r) => r.club_id), [CLUB_A]);
    });
  });
});
