// M2 изоляция клубов и неизменяемость (инвариант 5, 2, 7; контракт M2 §3).
// Пентест: с контекстом клуба A роль app_api не видит и не пишет ни одной строки клуба B
// во всех таблицах M2 (касса, бар, склад, смены, ККТ, одобрения скидок); пробитый чек ККТ
// неизменяем; app_api не включает алкоголь (platform_settings только чтение) и не удаляет строки.
//
// Разрушающие доказательства — во временной базе bl_test_* (создаётся и удаляется тестом).
// Запуск: DATABASE_ADMIN_URL=… node --test tests/security/m2/isolation.test.mjs

import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  asRole,
  createTestDatabase,
  seedClubB,
  tryQuery,
  CLUB_A,
  CLUB_B,
  OWNER_A,
  OWNER_B,
} from '../../../supabase/tests/helpers.mjs';

// Таблицы M2 с club_id, которые должны быть изолированы RLS.
const M2_TABLES = [
  'product_categories',
  'products',
  'modifier_groups',
  'modifiers',
  'orders',
  'order_items',
  'pos_sales',
  'pos_sale_items',
  'pos_sale_requests',
  'pos_refunds',
  'pos_discount_approvals',
  'stock_movements',
  'stock_audits',
  'shifts',
  'receipts',
  'kkt_bridges',
  'kkt_ops',
];

let db;

/** Полный набор строк клуба (суперпользователь, в обход RLS): цепочка каталог→заказ→продажа→чек. */
async function seedClubRows(pool, { clubId, owner, resourceId }) {
  const q = (sql, params) => pool.query(sql, params);
  const cat = (await q(`insert into bl.product_categories (club_id, name, sort) values ($1, 'Бар', 10) returning id`, [clubId])).rows[0].id;
  const prod = (await q(
    `insert into bl.products (club_id, category_id, name, sku, price_kopecks, unit, is_alcohol, payment_subject, track_stock, sort)
     values ($1, $2, 'Кола', $3, 12000, 'шт', false, 'commodity', true, 10) returning id`,
    [clubId, cat, `COLA-${clubId.slice(0, 4)}`],
  )).rows[0].id;
  const grp = (await q(`insert into bl.modifier_groups (club_id, name, min_select, max_select, sort) values ($1, 'Лёд', 0, 1, 10) returning id`, [clubId])).rows[0].id;
  await q(`insert into bl.modifiers (club_id, group_id, name, price_delta_kopecks, stock_factor, is_default, sort) values ($1, $2, 'Со льдом', 0, 1, true, 10)`, [clubId, grp]);
  await q(`insert into bl.stock_movements (club_id, product_id, kind, qty, cost_kopecks, reason, created_by, created_at) values ($1, $2, 'arrival', 100, 500000, 'сид', $3, now())`, [clubId, prod, owner]);
  const audit = (await q(`insert into bl.stock_audits (club_id, created_by, lines, total_diff_kopecks, created_at) values ($1, $2, '[]'::jsonb, 0, now()) returning id`, [clubId, owner])).rows[0].id;
  await q(`insert into bl.stock_movements (club_id, product_id, kind, qty, cost_kopecks, audit_id, created_by, created_at) values ($1, $2, 'audit', 1, 0, $3, $4, now())`, [clubId, prod, audit, owner]);
  const shift = (await q(`insert into bl.shifts (club_id, number, opened_by, opened_at, float_kopecks) values ($1, 1, $2, now(), 500000) returning id`, [clubId, owner])).rows[0].id;
  // Заказ (касса) → продажа (только бар, наличные) → строка продажи.
  const order = (await q(
    `insert into bl.orders (club_id, number, source, pay_mode, status, created_by, subtotal_kopecks, status_at, created_at, updated_at)
     values ($1, 1, 'pos', 'pos', 'served', $2, 12000, now(), now(), now()) returning id`,
    [clubId, owner],
  )).rows[0].id;
  const oi = (await q(
    `insert into bl.order_items (club_id, order_id, position, product_id, name, qty, unit_price_kopecks, amount_kopecks, track_stock, is_alcohol, vat_code, payment_subject, created_at)
     values ($1, $2, 0, $3, 'Кола', 1, 12000, 12000, true, false, 1, 'commodity', now()) returning id`,
    [clubId, order, prod],
  )).rows[0].id;
  // Платёж бара (наличные) — чтобы продажа имела payment_id и чек.
  const pay = (await q(
    `insert into bl.payments (club_id, kind, provider, method, idempotence_key, status, amount_kopecks, capture, confirmed_at, created_at, updated_at)
     values ($1, 'bar', 'reception', 'cash', $2, 'succeeded', 12000, true, now(), now(), now()) returning id`,
    [clubId, `bar-${clubId.slice(0, 8)}`],
  )).rows[0].id;
  const sale = (await q(
    `insert into bl.pos_sales (club_id, channel, method, status, payment_id, created_by, shift_id, bar_subtotal_kopecks, bar_total_kopecks, received_kopecks, change_kopecks, completed_at, created_at, updated_at)
     values ($1, 'pos', 'cash', 'completed', $2, $3, $4, 12000, 12000, 12000, 0, now(), now(), now()) returning id`,
    [clubId, pay, owner, shift],
  )).rows[0].id;
  await q(`update bl.orders set paid_at = now(), sale_id = $2, committed_at = now() where id = $1`, [order, sale]);
  await q(
    `insert into bl.pos_sale_items (club_id, sale_id, order_id, order_item_id, qty, amount_kopecks, outcome) values ($1, $2, $3, $4, 1, 12000, 'paid')`,
    [clubId, sale, order, oi],
  );
  await q(`insert into bl.stock_movements (club_id, product_id, kind, qty, cost_kopecks, order_item_id, sale_id, created_by, created_at) values ($1, $2, 'sale', -1, -5000, $3, $4, $5, now())`, [clubId, prod, oi, sale, owner]);
  // Одобрение скидки.
  await q(
    `insert into bl.pos_discount_approvals (club_id, approver_id, requested_by, reason_code, reason_text, percent, expires_at, created_at)
     values ($1, $2, $2, 'promo', 'акция', 50, now() + interval '5 minutes', now())`,
    [clubId, owner],
  );
  // Чек ККТ (пробитый).
  await q(
    `insert into bl.receipts (club_id, sale_id, kind, channel, status, amount_kopecks, items, fd, fp, fn, printed_at, created_at, updated_at)
     values ($1, $2, 'sale', 'kkt', 'printed', 12000, '[]'::jsonb, 777, '1234567890', '0000000000000001', now(), now(), now()) returning id`,
    [clubId, sale],
  );
  // Заявка стола M1 в составе продажи кассы (pos_sale_requests): котировка → заявка → платёж.
  const quote = (await q(
    `insert into bl.quotes (club_id, resource_id, user_id, kind, minutes, from_at, amount_kopecks, valid_until, used_at)
     values ($1, $2, $3, 'start', 60, now(), 50000, now() + interval '3 minutes', now()) returning id`,
    [clubId, resourceId, owner],
  )).rows[0].id;
  const req = (await q(
    `insert into bl.reception_requests (club_id, quote_id, resource_id, user_id, kind, minutes, amount_kopecks, status, expires_at, created_at)
     values ($1, $2, $3, $4, 'start', 60, 50000, 'waiting', now() + interval '15 minutes', now()) returning id`,
    [clubId, quote, resourceId, owner],
  )).rows[0].id;
  const reqPay = (await q(
    `insert into bl.payments (club_id, resource_id, user_id, quote_id, kind, provider, method, idempotence_key, status, amount_kopecks, capture, confirmed_at, created_at, updated_at)
     values ($1, $2, $3, $4, 'start', 'reception', 'cash', $5, 'succeeded', 50000, true, now(), now(), now()) returning id`,
    [clubId, resourceId, owner, quote, `rr-${clubId.slice(0, 8)}`],
  )).rows[0].id;
  await q(`insert into bl.pos_sale_requests (sale_id, club_id, request_id, payment_id, amount_kopecks) values ($1, $2, $3, $4, 50000)`, [sale, clubId, req, reqPay]);
  // Возврат бара (pos_refunds): строка bl.refunds + pos_refunds.
  const refund = (await q(
    `insert into bl.refunds (club_id, payment_id, idempotence_key, amount_kopecks, status, reason, created_at, updated_at)
     values ($1, $2, $3, 12000, 'manual', 'тест', now(), now()) returning id`,
    [clubId, pay, `rf-${clubId.slice(0, 8)}`],
  )).rows[0].id;
  await q(
    `insert into bl.pos_refunds (club_id, sale_id, refund_id, kind, amount_kopecks, reason, items, created_by, created_at)
     values ($1, $2, $3, 'staff', 12000, 'тест', '[]'::jsonb, $4, now())`,
    [clubId, sale, refund, owner],
  );
  // Мост ККТ и служебное задание смены.
  const hash = clubId.replace(/-/g, '').padEnd(64, '0');
  await q(`insert into bl.kkt_bridges (club_id, name, token_hash, created_by) values ($1, 'Ресепшн', $2, $3)`, [clubId, hash, owner]);
  await q(`insert into bl.kkt_ops (club_id, shift_id, kind, status, operator_name) values ($1, $2, 'open_shift', 'pending', 'Кассир')`, [clubId, shift]);
  return { sale, prod };
}

before(async () => {
  db = await createTestDatabase();
  await seedClubB(db.pool);
  await seedClubRows(db.pool, { clubId: CLUB_B, owner: OWNER_B, resourceId: 'e2000000-0000-4000-8000-000000000001' });
  // Клуб A тоже с данными M2 (его товары уже в сиде; добавим продажу и чек).
  await seedClubRows(db.pool, { clubId: CLUB_A, owner: OWNER_A, resourceId: 'e1000000-0000-4000-8000-000000000001' });
});

after(async () => {
  await db?.drop();
});

/** Строки клуба в таблице (как видит суперпользователь). */
async function countAll(table, clubId) {
  const { rows } = await db.pool.query(`select count(*)::int as n from bl.${table} where club_id = $1`, [clubId]);
  return rows[0].n;
}

describe('M2: изоляция клубов (инвариант 5)', () => {
  it('в базе есть строки M2 обоих клубов', async () => {
    for (const club of [CLUB_A, CLUB_B]) {
      for (const t of M2_TABLES) assert.ok((await countAll(t, club)) >= 1, `${t} клуб ${club}`);
    }
  });

  it('контекст клуба A: ни одной строки клуба B во всех таблицах M2', async () => {
    await asRole(db.pool, 'app_api', { clubId: CLUB_A }, async (c) => {
      for (const t of M2_TABLES) {
        const seen = await c.query(`select club_id, count(*)::int as n from bl.${t} group by club_id`);
        assert.deepEqual(seen.rows.map((r) => r.club_id), [CLUB_A], `${t}: видны только строки A`);
        assert.equal(seen.rows[0].n, await countAll(t, CLUB_A), `${t}: видны все строки A`);
        const b = await c.query(`select count(*)::int as n from bl.${t} where club_id = $1`, [CLUB_B]);
        assert.equal(b.rows[0].n, 0, `${t}: строки B по прямому условию`);
      }
    });
  });

  it('контекст клуба A: нельзя записать строку с club_id клуба B (RLS)', async () => {
    await asRole(db.pool, 'app_api', { clubId: CLUB_A }, async (c) => {
      const inserts = {
        product_categories: `insert into bl.product_categories (club_id, name, sort) values ('${CLUB_B}', 'x', 1)`,
        shifts: `insert into bl.shifts (club_id, number, opened_by, opened_at, float_kopecks) values ('${CLUB_B}', 99, '${OWNER_B}', now(), 0)`,
        kkt_bridges: `insert into bl.kkt_bridges (club_id, name, token_hash) values ('${CLUB_B}', 'x', '${'a'.repeat(64)}')`,
        kkt_ops: `insert into bl.kkt_ops (club_id, kind, status) values ('${CLUB_B}', 'open_shift', 'pending')`,
        stock_audits: `insert into bl.stock_audits (club_id, created_by, lines, total_diff_kopecks, created_at) values ('${CLUB_B}', '${OWNER_B}', '[]'::jsonb, 0, now())`,
        pos_discount_approvals: `insert into bl.pos_discount_approvals (club_id, approver_id, requested_by, reason_code, reason_text, percent, expires_at, created_at) values ('${CLUB_B}', '${OWNER_B}', '${OWNER_B}', 'promo', 'x', 50, now() + interval '5 min', now())`,
      };
      for (const [t, sql] of Object.entries(inserts)) {
        const err = await tryQuery(c, sql, []);
        assert.ok(err, `${t}: вставка в клуб B прошла (не должна)`);
        assert.equal(err.code, '42501', `${t}: ожидалась ошибка RLS, получили ${err.code} ${err.message}`);
      }
    });
  });

  it('контекст клуба A: app_api не удаляет строки M2 (нет DELETE)', async () => {
    await asRole(db.pool, 'app_api', { clubId: CLUB_A }, async (c) => {
      for (const t of ['pos_sales', 'orders', 'order_items', 'stock_movements', 'shifts', 'receipts', 'pos_discount_approvals', 'kkt_bridges']) {
        const err = await tryQuery(c, `delete from bl.${t} where club_id = $1`, [CLUB_A]);
        assert.ok(err, `${t}: DELETE прошёл (не должен)`);
        assert.equal(err.code, '42501', `${t}: ожидался отказ прав на DELETE, получили ${err.code}`);
      }
    });
  });

  it('пробитый чек ККТ неизменяем (триггер receipts_kkt_guard)', async () => {
    const { rows } = await db.pool.query(`select id from bl.receipts where club_id = $1 and status = 'printed' limit 1`, [CLUB_A]);
    const id = rows[0].id;
    await asRole(db.pool, 'app_api', { clubId: CLUB_A }, async (c) => {
      for (const col of ['fd = 1', `fp = '9'`, `fn = '0000000000000009'`, `printed_at = now()`]) {
        const err = await tryQuery(c, `update bl.receipts set ${col} where id = $1`, [id]);
        assert.ok(err, `изменение ${col} прошло (не должно)`);
      }
    });
    const after = (await db.pool.query('select fd, fp from bl.receipts where id = $1', [id])).rows[0];
    assert.equal(Number(after.fd), 777, 'ФД пробитого чека не изменился');
  });

  it('app_api не включает алкоголь: platform_settings только чтение', async () => {
    await asRole(db.pool, 'app_api', { clubId: CLUB_A }, async (c) => {
      const read = await c.query(`select value from bl.platform_settings where key = 'qr_alcohol_allowed'`);
      assert.equal(read.rows[0].value, false, 'по умолчанию алкоголь выключен');
      const err = await tryQuery(c, `update bl.platform_settings set value = 'true'::jsonb where key = 'qr_alcohol_allowed'`, []);
      assert.ok(err, 'UPDATE platform_settings прошёл (не должен)');
      assert.equal(err.code, '42501', `ожидался отказ прав, получили ${err.code}`);
      const ins = await tryQuery(c, `insert into bl.platform_settings (key, value) values ('x', 'true'::jsonb)`, []);
      assert.ok(ins, 'INSERT platform_settings прошёл (не должен)');
    });
    const v = (await db.pool.query(`select value from bl.platform_settings where key = 'qr_alcohol_allowed'`)).rows[0].value;
    assert.equal(v, false, 'алкоголь так и выключен');
  });

  it('узкие функции SECURITY DEFINER M2 на месте и принадлежат bl_definer', async () => {
    const { rows } = await db.pool.query(
      `select p.proname, r.rolname as owner, p.prosecdef
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner
        where n.nspname = 'bl' and p.proname in ('pos_object_club', 'pos_due', 'kkt_due')
        order by p.proname`,
    );
    const names = rows.map((r) => r.proname);
    for (const fn of ['kkt_due', 'pos_due', 'pos_object_club']) assert.ok(names.includes(fn), `нет функции ${fn}`);
    for (const r of rows) {
      assert.equal(r.prosecdef, true, `${r.proname} не SECURITY DEFINER`);
      assert.equal(r.owner, 'bl_definer', `${r.proname} владелец ${r.owner}, не bl_definer`);
    }
  });
});
