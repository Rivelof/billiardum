// RLS и права новых таблиц M2 backend-pos (инвариант 5, decisions №12): ENABLE + FORCE RLS,
// клуб А не видит и не пишет строк клуба Б, без контекста — ничего; у app_api нет DELETE и
// TRUNCATE; движения склада, строки заказов и ревизии только дополняются; настройки
// платформы — только чтение; конечные состояния заказа и продажи защищены триггерами;
// платёж бара в bl.payments (0410) не ослабляет ограничения платежей стола; узкие функции.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { asRole, CLUB_A, CLUB_B, createTestDatabase, OWNER_A, OWNER_B, seedClubB, tryQuery } from '../../../../supabase/tests/helpers.mjs';

const SKIP = !process.env.DATABASE_ADMIN_URL;
const TABLES = [
  'product_categories', 'products', 'modifier_groups', 'modifiers', 'product_modifier_groups',
  'orders', 'order_items', 'pos_sales', 'pos_sale_items', 'pos_sale_requests', 'pos_refunds',
  'stock_movements', 'stock_audits', 'pos_discount_approvals',
];
const ID = {};
let db;

async function seedPosB(pool) {
  for (const k of ['cat', 'prod', 'grp', 'mod', 'order', 'item', 'pay', 'sale', 'saleItem', 'audit', 'refund', 'posRefund', 'quote', 'req', 'reqPay']) ID[k] = randomUUID();
  await pool.query(`
    insert into bl.product_categories (id, club_id, name) values ('${ID.cat}', '${CLUB_B}', 'Бар Б');
    insert into bl.products (id, club_id, category_id, name, price_kopecks) values ('${ID.prod}', '${CLUB_B}', '${ID.cat}', 'Чай Б', 10000);
    insert into bl.modifier_groups (id, club_id, name) values ('${ID.grp}', '${CLUB_B}', 'Объём Б');
    insert into bl.modifiers (id, club_id, group_id, name) values ('${ID.mod}', '${CLUB_B}', '${ID.grp}', 'Большой');
    insert into bl.product_modifier_groups (club_id, product_id, group_id) values ('${CLUB_B}', '${ID.prod}', '${ID.grp}');
    insert into bl.payments (id, club_id, kind, provider, method, idempotence_key, status, amount_kopecks, confirmed_at)
      values ('${ID.pay}', '${CLUB_B}', 'bar', 'reception', 'cash', 'bar-b', 'succeeded', 10000, now());
    insert into bl.orders (id, club_id, number, source, pay_mode, status, created_by, subtotal_kopecks, committed_at, status_at, created_at, updated_at)
      values ('${ID.order}', '${CLUB_B}', 1, 'pos', 'pos', 'served', '${OWNER_B}', 10000, now(), now(), now(), now());
    insert into bl.order_items (id, club_id, order_id, position, product_id, name, qty, unit_price_kopecks, amount_kopecks, track_stock, is_alcohol, vat_code, payment_subject, created_at)
      values ('${ID.item}', '${CLUB_B}', '${ID.order}', 0, '${ID.prod}', 'Чай Б', 1, 10000, 10000, true, false, 1, 'commodity', now());
    insert into bl.pos_sales (id, club_id, channel, method, status, payment_id, created_by, bar_subtotal_kopecks, bar_total_kopecks,
                              received_kopecks, change_kopecks, created_at, completed_at, updated_at)
      values ('${ID.sale}', '${CLUB_B}', 'pos', 'cash', 'completed', '${ID.pay}', '${OWNER_B}', 10000, 10000, 10000, 0, now(), now(), now());
    update bl.orders set paid_at = now(), sale_id = '${ID.sale}' where id = '${ID.order}';
    insert into bl.pos_sale_items (id, club_id, sale_id, order_id, order_item_id, qty, amount_kopecks, outcome)
      values ('${ID.saleItem}', '${CLUB_B}', '${ID.sale}', '${ID.order}', '${ID.item}', 1, 10000, 'paid');
    insert into bl.quotes (id, club_id, resource_id, user_id, kind, minutes, from_at, amount_kopecks, valid_until)
      values ('${ID.quote}', '${CLUB_B}', 'e2000000-0000-4000-8000-000000000001', '${OWNER_B}', 'start', 60, now(), 70000, now() + interval '3 minutes');
    insert into bl.payments (id, club_id, resource_id, user_id, quote_id, kind, provider, method, idempotence_key, status, amount_kopecks, minutes, confirmed_at)
      values ('${ID.reqPay}', '${CLUB_B}', 'e2000000-0000-4000-8000-000000000001', '${OWNER_B}', '${ID.quote}', 'start', 'reception', 'cash', 'rr-b', 'succeeded', 70000, 60, now());
    insert into bl.reception_requests (id, club_id, quote_id, resource_id, user_id, kind, minutes, amount_kopecks, status, expires_at, payment_id)
      values ('${ID.req}', '${CLUB_B}', '${ID.quote}', 'e2000000-0000-4000-8000-000000000001', '${OWNER_B}', 'start', 60, 70000, 'accepted', now(), '${ID.reqPay}');
    insert into bl.pos_sale_requests (sale_id, club_id, request_id, payment_id, amount_kopecks) values ('${ID.sale}', '${CLUB_B}', '${ID.req}', '${ID.reqPay}', 70000);
    insert into bl.refunds (id, club_id, payment_id, idempotence_key, amount_kopecks, status, reason) values ('${ID.refund}', '${CLUB_B}', '${ID.pay}', 'posr-b', 1000, 'manual', 'тест');
    insert into bl.pos_refunds (id, club_id, sale_id, refund_id, kind, amount_kopecks, reason, items, created_by, created_at)
      values ('${ID.posRefund}', '${CLUB_B}', '${ID.sale}', '${ID.refund}', 'staff', 1000, 'тест', '[]', '${OWNER_B}', now());
    insert into bl.stock_audits (id, club_id, created_by, lines, total_diff_kopecks, created_at) values ('${ID.audit}', '${CLUB_B}', '${OWNER_B}', '[]', 0, now());
    insert into bl.pos_discount_approvals (club_id, approver_id, requested_by, reason_code, reason_text, percent, expires_at, created_at)
      values ('${CLUB_B}', '${OWNER_B}', '${OWNER_B}', 'other', 'тест', 20, now() + interval '5 minutes', now());
    insert into bl.stock_movements (club_id, product_id, kind, qty, cost_kopecks, created_at) values ('${CLUB_B}', '${ID.prod}', 'arrival', 10, 50000, now());
    insert into bl.stock_movements (club_id, product_id, kind, qty, cost_kopecks, order_item_id, created_at) values ('${CLUB_B}', '${ID.prod}', 'sale', -1, -5000, '${ID.item}', now());
  `);
}

before(async () => {
  if (SKIP) return;
  db = await createTestDatabase();
  await seedClubB(db.pool);
  await seedPosB(db.pool);
});

after(async () => {
  await db?.drop();
});

describe('RLS новых таблиц', { skip: SKIP }, () => {
  it('ENABLE и FORCE ROW LEVEL SECURITY на всех таблицах и platform_settings', async () => {
    const { rows } = await db.pool.query(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
        where relnamespace = 'bl'::regnamespace and relname = any($1::text[])`,
      [[...TABLES, 'platform_settings']],
    );
    assert.equal(rows.length, TABLES.length + 1);
    for (const r of rows) assert.ok(r.relrowsecurity && r.relforcerowsecurity, r.relname);
  });

  it('клуб А не видит ни одной строки клуба Б; без контекста — ноль строк', async () => {
    await asRole(db.pool, 'app_api', { clubId: CLUB_A }, async (c) => {
      for (const t of TABLES) {
        const { rows } = await c.query(`select count(*)::int as n from bl.${t} where club_id = $1`, [CLUB_B]);
        assert.equal(rows[0].n, 0, t);
      }
    });
    await asRole(db.pool, 'app_api', { clubId: CLUB_B }, async (c) => {
      for (const t of TABLES) {
        const { rows } = await c.query(`select count(*)::int as n from bl.${t}`);
        assert.ok(rows[0].n >= 1, `${t}: свой клуб видит`);
      }
    });
    await asRole(db.pool, 'app_api', { clubId: null }, async (c) => {
      for (const t of TABLES) assert.equal((await c.query(`select count(*)::int as n from bl.${t}`)).rows[0].n, 0, t);
    });
  });

  it('вставка строки клуба Б из контекста клуба А — отказ RLS', async () => {
    await asRole(db.pool, 'app_api', { clubId: CLUB_A }, async (c) => {
      const cases = {
        product_categories: [`insert into bl.product_categories (club_id, name) values ($1, 'Чужая')`],
        products: [`insert into bl.products (club_id, name, price_kopecks) values ($1, 'Чужой', 100)`],
        modifier_groups: [`insert into bl.modifier_groups (club_id, name) values ($1, 'Чужая')`],
        stock_audits: [`insert into bl.stock_audits (club_id, created_by, lines, total_diff_kopecks, created_at) values ($1, '${OWNER_A}', '[]', 0, now())`],
      };
      for (const [t, [sql]] of Object.entries(cases)) {
        const err = await tryQuery(c, sql, [CLUB_B]);
        assert.equal(err?.code, '42501', t);
        assert.match(err.message, /row-level security/, t);
      }
      const upd = await c.query('update bl.products set price_kopecks = 1 where id = $1', [ID.prod]);
      assert.equal(upd.rowCount, 0, 'чужой товар не меняется');
    });
  });

  it('у app_api нет DELETE и TRUNCATE; журнал склада, строки заказов и ревизии не меняются', async () => {
    await asRole(db.pool, 'app_api', { clubId: CLUB_B }, async (c) => {
      for (const t of [...TABLES, 'platform_settings']) {
        assert.equal((await tryQuery(c, `delete from bl.${t}`))?.code, '42501', `delete ${t}`);
        assert.equal((await tryQuery(c, `truncate bl.${t}`))?.code, '42501', `truncate ${t}`);
      }
      assert.equal((await tryQuery(c, 'update bl.stock_movements set qty = 100'))?.code, '42501');
      assert.equal((await tryQuery(c, 'update bl.order_items set unit_price_kopecks = 1, amount_kopecks = 1'))?.code, '42501');
      assert.equal((await tryQuery(c, 'update bl.stock_audits set total_diff_kopecks = 0'))?.code, '42501');
      assert.equal((await tryQuery(c, 'update bl.pos_refunds set amount_kopecks = 1'))?.code, '42501');
      assert.equal((await tryQuery(c, 'update bl.orders set subtotal_kopecks = 1'))?.code, '42501', 'сумма заказа неизменна');
      assert.equal((await tryQuery(c, 'update bl.pos_sales set bar_total_kopecks = 1'))?.code, '42501', 'сумма продажи неизменна');
      assert.equal((await tryQuery(c, "update bl.platform_settings set value = 'true'"))?.code, '42501', 'настройки платформы — только чтение');
      assert.equal((await c.query("select value from bl.platform_settings where key = 'qr_alcohol_allowed'")).rows[0].value, false);
    });
  });

  it('триггеры: оплаченный заказ не отменяется, завершённая продажа не возвращается в pending', async () => {
    await asRole(db.pool, 'app_api', { clubId: CLUB_B }, async (c) => {
      const cancel = await tryQuery(c, "update bl.orders set status = 'canceled', canceled_at = now() where id = $1", [ID.order]);
      assert.equal(cancel?.code, '23514');
      const unpay = await tryQuery(c, 'update bl.orders set paid_at = null, sale_id = null where id = $1', [ID.order]);
      assert.ok(unpay, 'оплата заказа не снимается');
      const back = await tryQuery(c, "update bl.pos_sales set status = 'pending' where id = $1", [ID.sale]);
      assert.equal(back?.code, '23514');
      const shrink = await tryQuery(c, 'update bl.pos_sales set refunded_kopecks = 0 where id = $1', [ID.sale]);
      assert.equal(shrink, null, 'refunded_kopecks = 0 → 0 допустимо');
    });
  });

  it('bl.payments (0410): у платежа бара нет стола; у платежа игры стол и гость обязательны', async () => {
    await asRole(db.pool, 'app_api', { clubId: CLUB_B }, async (c) => {
      const noTable = await tryQuery(
        c,
        `insert into bl.payments (club_id, kind, provider, method, idempotence_key, status, amount_kopecks)
         values ($1, 'start', 'reception', 'cash', 'x-1', 'succeeded', 100)`,
        [CLUB_B],
      );
      assert.equal(noTable?.code, '23514');
      const barMinutes = await tryQuery(
        c,
        `insert into bl.payments (club_id, kind, provider, method, idempotence_key, status, amount_kopecks, minutes)
         values ($1, 'bar', 'reception', 'cash', 'x-2', 'succeeded', 100, 60)`,
        [CLUB_B],
      );
      assert.equal(barMinutes?.code, '23514');
      const other = await tryQuery(c, `insert into bl.payments (club_id, kind, provider, method, idempotence_key, status, amount_kopecks) values ($1, 'gift', 'reception', 'cash', 'x-3', 'succeeded', 100)`, [CLUB_B]);
      assert.equal(other?.code, '23514');
    });
  });

  it('узкие функции: pos_object_club находит клуб заказа и продажи, pos_due — только id', async () => {
    await asRole(db.pool, 'app_api', { clubId: null }, async (c) => {
      assert.equal((await c.query("select bl.pos_object_club('order', $1) as c", [ID.order])).rows[0].c, CLUB_B);
      assert.equal((await c.query("select bl.pos_object_club('sale', $1) as c", [ID.sale])).rows[0].c, CLUB_B);
      assert.equal((await c.query("select bl.pos_object_club('order', $1) as c", [randomUUID()])).rows[0].c, null);
      assert.equal((await c.query("select bl.pos_object_club('product', $1) as c", [ID.prod])).rows[0].c, null);
      const due = await c.query('select * from bl.pos_due(10)');
      assert.deepEqual(due.fields.map((f) => f.name), ['club_id', 'sale_id']);
    });
    const { rows } = await db.pool.query(
      `select p.proname, pg_get_userbyid(p.proowner) as owner, p.proconfig from pg_proc p
        where p.pronamespace = 'bl'::regnamespace and p.prosecdef and p.proname like 'pos\\_%' order by 1`,
    );
    assert.deepEqual(rows.map((r) => [r.proname, r.owner]), [['pos_due', 'bl_definer'], ['pos_object_club', 'bl_definer']]);
    for (const r of rows) assert.ok(r.proconfig.some((s) => s.startsWith('search_path=pg_catalog')));
    await asRole(db.pool, 'bl_definer', {}, async (c) => {
      assert.equal((await tryQuery(c, 'select subtotal_kopecks from bl.orders'))?.code, '42501');
      assert.equal((await tryQuery(c, 'select bar_total_kopecks from bl.pos_sales'))?.code, '42501');
    });
  });
});
