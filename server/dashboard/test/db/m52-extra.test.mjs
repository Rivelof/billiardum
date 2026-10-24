// M5.2 §7–§8 (№173–179): истории заказов, ревизий, списаний, приходов; ведомость ревизии; список смен;
// касса управляющего (остатки, сторно вместо правки, инкассации из смен); «Кто играл за столом» и
// полный телефон только владельцу с причиной. Права: ресепшн — 403, чужой клуб — 403.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { startTestApp, CORE_ROUTE_FILES } from '../../../test/db/helpers.mjs';
import { loadRoutes } from '../../../../api/router.mjs';
import { cache } from '../../../../api/routes/dashboard.mjs';
import { seedClubB, CLUB_B } from '../../../../supabase/tests/helpers.mjs';
import { tick } from '../../index.mjs';
import { addDays, workingDayOf, zonedTime } from '../../time.mjs';

const CLUB = 'c1000000-0000-4000-8000-000000000001';
const OWNER = 'a1000000-0000-4000-8000-000000000001';
const MANAGER = 'a1000000-0000-4000-8000-000000000003';
const RECEPTION = 'a1000000-0000-4000-8000-000000000004';
const G1 = 'a9000000-0000-4000-8000-0000000000c1';
const G2 = 'a9000000-0000-4000-8000-0000000000c2';
const T1 = 'e1000000-0000-4000-8000-000000000001';
const TZ = 'Asia/Yekaterinburg';
const ROUTES = [...CORE_ROUTE_FILES, 'dashboard.mjs', 'history.mjs', 'cashbook.mjs', 'who-played.mjs', 'shifts.mjs'];

let t;
const tok = {};
const clock = { now: () => new Date() };
const today = () => workingDayOf(clock.now(), TZ, '06:00');
const L = (day, hhmm) => zonedTime(day, hhmm, TZ);
const ids = {};

before(async () => {
  t = await startTestApp({ routes: await loadRoutes({ only: ROUTES }), clock });
  await seedClubB(t.admin);
  const q = (sql, p) => t.admin.query(sql, p);
  const D = addDays(today(), -1);
  ids.D = D;
  await q('update bl.clubs set created_at = $2 where id = $1', [CLUB, L(addDays(D, -3), '12:00')]);
  await q('update bl.resources set created_at = $2 where club_id = $1', [CLUB, L(addDays(D, -3), '12:00')]);
  await q(`insert into bl.users (id, phone) values ($1, '+79991110001'), ($2, '+79991110002')`, [G1, G2]);
  await q(`insert into bl.players (user_id, nick, created_at, updated_at) values ($1, 'Кий_мастер', now(), now())`, [G2]);
  await q(`update bl.users set name = 'Анна' where id = $1`, [RECEPTION]);
  // Каталог и склад.
  const cat = randomUUID();
  await q(`insert into bl.product_categories (id, club_id, name, sort) values ($1, $2, 'Напитки', 1)`, [cat, CLUB]);
  ids.beer = randomUUID();
  ids.chips = randomUUID();
  await q(`insert into bl.products (id, club_id, category_id, name, price_kopecks, vat_code) values ($1, $3, $4, 'Пиво', 25000, 1), ($2, $3, null, 'Чипсы', 15000, 1)`, [ids.beer, ids.chips, CLUB, cat]);
  const mv = (kind, product, qty, cost, extra = {}) =>
    q(`insert into bl.stock_movements (club_id, product_id, kind, qty, cost_kopecks, reason, created_by, created_at, audit_id, refund_id) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [CLUB, product, kind, qty, cost, extra.reason ?? null, extra.by ?? MANAGER, extra.at ?? L(D, '11:00'), extra.audit ?? null, extra.refund ?? null]);
  await mv('arrival', ids.beer, 24, 240000, { reason: 'поставка' });
  await mv('arrival', ids.chips, 10, 50000);
  await mv('writeoff', ids.beer, -2, -20000, { reason: 'бой бутылок', at: L(D, '12:00') });
  ids.audit = randomUUID();
  await q(
    `insert into bl.stock_audits (id, club_id, created_by, note, lines, total_diff_kopecks, created_at) values ($1, $2, $3, 'ревизия', $4, -10000, $5)`,
    [ids.audit, CLUB, MANAGER, JSON.stringify([
      { product_id: ids.beer, name: 'Пиво', unit: 'шт', expected_qty: 22, actual_qty: 21, diff_qty: -1, unit_cost_kopecks: 10000, diff_kopecks: -10000 },
      { product_id: ids.chips, name: 'Чипсы', unit: 'шт', expected_qty: 10, actual_qty: 10, diff_qty: 0, unit_cost_kopecks: 5000, diff_kopecks: 0 },
    ]), L(D, '13:00')],
  );
  await mv('audit', ids.beer, -1, -10000, { audit: ids.audit, at: L(D, '13:00') });
  // Заказы: со стола (гость с телефоном), со стола (гость с ником), отменённый с кассы.
  const sess = randomUUID();
  ids.session = sess;
  await q(
    `insert into bl.sessions (id, club_id, resource_id, status, source, payer_user_id, started_at, paid_until, ended_at, close_reason, created_at, updated_at)
     values ($1, $2, $3, 'closed', 'qr', $4, $5, $6, $6, 'expired', $5, $6)`,
    [sess, CLUB, T1, G1, L(D, '14:00'), L(D, '15:00')],
  );
  await q(`insert into bl.session_participants (session_id, club_id, user_id, role, ordinal, joined_at) values ($1, $2, $3, 'payer', 1, $4)`, [sess, CLUB, G1, L(D, '14:00')]);
  await q(
    `insert into bl.payments (club_id, resource_id, user_id, session_id, kind, provider, method, provider_payment_id, idempotence_key, status, amount_kopecks, minutes, confirmed_at, created_at, updated_at)
     values ($1, $2, $3, $4, 'start', 'yookassa', 'sbp', 'yk-who-1', 'k-who-1', 'succeeded', 50000, 60, $5, $5, $5)`,
    [CLUB, T1, G1, sess, L(D, '14:00')],
  );
  const sess2 = randomUUID();
  await q(
    `insert into bl.sessions (id, club_id, resource_id, status, source, payer_user_id, started_at, paid_until, ended_at, close_reason, created_at, updated_at)
     values ($1, $2, $3, 'closed', 'qr', $4, $5, $6, $6, 'expired', $5, $6)`,
    [sess2, CLUB, T1, G2, L(D, '16:00'), L(D, '17:00')],
  );
  const order = async (o) => {
    const id = randomUUID();
    await q(
      `insert into bl.orders (id, club_id, number, source, pay_mode, status, session_id, resource_id, user_id, created_by, subtotal_kopecks, status_at, created_at, updated_at, canceled_at, canceled_by, cancel_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $12, $13, $14, $15)`,
      [id, CLUB, o.number, o.source, o.source === 'qr' ? 'tab' : 'pos', o.status, o.session ?? null, o.session ? T1 : null, o.user ?? null, o.source === 'pos' ? RECEPTION : null, o.amount, o.at, o.canceled ?? null, o.canceled ? RECEPTION : null, o.canceled ? 'гость передумал, звонил +7 999 555-44-33' : null],
    );
    for (const [i, it] of o.items.entries()) {
      await q(
        `insert into bl.order_items (club_id, order_id, position, product_id, name, qty, unit_price_kopecks, amount_kopecks, track_stock, is_alcohol, vat_code, payment_subject, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, true, false, 1, 'commodity', $9)`,
        [CLUB, id, i, it.product, it.name, it.qty, it.price, it.qty * it.price, o.at],
      );
    }
    return id;
  };
  await order({ number: 1, source: 'qr', status: 'served', session: sess, user: G1, amount: 50000, at: L(D, '14:10'), items: [{ product: ids.beer, name: 'Пиво', qty: 2, price: 25000 }] });
  await order({ number: 2, source: 'qr', status: 'served', session: sess2, user: G2, amount: 15000, at: L(D, '16:10'), items: [{ product: ids.chips, name: 'Чипсы', qty: 1, price: 15000 }] });
  await order({ number: 3, source: 'pos', status: 'canceled', amount: 25000, at: L(D, '18:00'), canceled: L(D, '18:05'), items: [{ product: ids.beer, name: 'Пиво', qty: 1, price: 25000 }] });
  // Смены: закрыта с расхождением, закрыта ровно (инкассация 120 000), открыта.
  await q(
    `insert into bl.shifts (club_id, number, opened_by, opened_at, float_kopecks, closed_by, closed_at, cash_sales_kopecks, cash_refunds_kopecks, expected_cash_kopecks, actual_cash_kopecks, discrepancy_kopecks)
     values ($1, 1, $2, $3, 100000, $2, $4, 0, 0, 100000, 90000, -10000),
            ($1, 2, $5, $6, 100000, $5, $7, 120000, 0, 220000, 220000, 0)`,
    [CLUB, RECEPTION, L(addDays(D, -1), '10:00'), L(addDays(D, -1), '23:00'), MANAGER, L(D, '10:00'), L(D, '23:00')],
  );
  await q(`insert into bl.shifts (club_id, number, opened_by, opened_at, float_kopecks) values ($1, 3, $2, $3, 100000)`, [CLUB, RECEPTION, new Date(L(today(), '06:00').getTime() + 1000)]);
  for (const [k, phone] of Object.entries({ owner: '+70000000001', manager: '+70000000003', reception: '+70000000004', ownerB: '+70000000002' })) tok[k] = (await t.login(phone)).token;
});

after(async () => {
  await t?.stop();
});

const get = (path, who = 'owner') => {
  cache.clear();
  return t.request('GET', path, { token: tok[who] });
};
const post = (path, body, who = 'owner', idem = true) => t.request('POST', path, { token: tok[who], body, headers: idem ? { 'idempotency-key': randomUUID() } : {} });

describe('истории (№173–175)', () => {
  it('заказы гостей: маска телефона или ник, состав, итоги, фильтр, сортировка, курсор', async () => {
    const r = await get(`/api/clubs/${CLUB}/history/orders?from=${ids.D}&to=${ids.D}`, 'manager');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.items.map((o) => o.number), [3, 2, 1], 'по умолчанию — новые сверху');
    const o1 = r.json.items.find((o) => o.number === 1);
    assert.deepEqual(o1.guest, { nick: null, phone_masked: '+7999***0001' });
    assert.deepEqual(o1.lines, [{ name: 'Пиво', qty: 2, unit_price_kopecks: 25000, amount_kopecks: 50000, modifiers: [] }]);
    assert.equal(o1.resource_number, 1);
    assert.deepEqual(r.json.items.find((o) => o.number === 2).guest, { nick: 'Кий_мастер', phone_masked: null });
    const o3 = r.json.items.find((o) => o.number === 3);
    assert.equal(o3.status, 'canceled');
    assert.doesNotMatch(o3.cancel_reason, /555-44-33/);
    assert.deepEqual(r.json.totals, { count: 3, amount_kopecks: 65000, canceled: 1 });
    assert.doesNotMatch(r.text, /\+79991110001|\+79991110002/);
    const page = await get(`/api/clubs/${CLUB}/history/orders?from=${ids.D}&to=${ids.D}&sort=amount&limit=2`, 'owner');
    assert.deepEqual(page.json.items.map((o) => o.amount_kopecks), [15000, 25000]);
    assert.equal(page.json.next_cursor, '2');
    const next = await get(`/api/clubs/${CLUB}/history/orders?from=${ids.D}&to=${ids.D}&sort=amount&limit=2&cursor=2`, 'owner');
    assert.deepEqual(next.json.items.map((o) => o.number), [1]);
    assert.equal(next.json.next_cursor, null);
    const canceled = await get(`/api/clubs/${CLUB}/history/orders?from=${ids.D}&to=${ids.D}&status=canceled`);
    assert.deepEqual(canceled.json.items.map((o) => o.number), [3]);
    const search = await get(`/api/clubs/${CLUB}/history/orders?from=${ids.D}&to=${ids.D}&q=чипс`);
    assert.deepEqual(search.json.items.map((o) => o.number), [2]);
  });

  it('ревизии, списания, приходы совпадают с движениями склада', async () => {
    const a = await get(`/api/clubs/${CLUB}/history/audits?from=${ids.D}&to=${ids.D}`);
    assert.equal(a.json.items.length, 1);
    assert.deepEqual([a.json.items[0].items, a.json.items[0].mismatches, a.json.items[0].diff_qty, a.json.items[0].diff_kopecks], [2, 1, -1, -10000]);
    assert.equal(a.json.items[0].lines[0].expected_qty, 22);
    assert.deepEqual(a.json.totals, { count: 1, diff_kopecks: -10000, shortage_kopecks: -10000, surplus_kopecks: 0 });
    const w = await get(`/api/clubs/${CLUB}/history/writeoffs?from=${ids.D}&to=${ids.D}&sort=created_at`);
    assert.deepEqual(w.json.items.map((x) => [x.source, x.product, x.qty, x.cost_kopecks]), [['program', 'Пиво', 2, 20000], ['audit', 'Пиво', 1, 10000]]);
    const mv = await t.admin.query("select -sum(cost_kopecks)::int as c from bl.stock_movements where club_id = $1 and (kind = 'writeoff' or (kind = 'audit' and qty < 0))", [CLUB]);
    assert.equal(w.json.totals.cost_kopecks, mv.rows[0].c);
    const onlyAudit = await get(`/api/clubs/${CLUB}/history/writeoffs?from=${ids.D}&to=${ids.D}&status=audit`);
    assert.equal(onlyAudit.json.items.length, 1);
    const ar = await get(`/api/clubs/${CLUB}/history/arrivals?from=${ids.D}&to=${ids.D}&sort=product`);
    assert.deepEqual(ar.json.items.map((x) => [x.product, x.qty, x.unit_cost_kopecks, x.cost_kopecks, x.supplier]), [['Пиво', 24, 10000, 240000, null], ['Чипсы', 10, 5000, 50000, null]]);
    assert.deepEqual(ar.json.totals, { count: 2, cost_kopecks: 290000 });
  });

  it('CSV историй: BOM, «;», маска телефона, журнал owner.export; управляющему можно', async () => {
    for (const kind of ['orders', 'audits', 'writeoffs', 'arrivals']) {
      const r = await get(`/api/clubs/${CLUB}/history/${kind}/export.csv?from=${ids.D}&to=${ids.D}`, 'manager');
      assert.equal(r.status, 200, kind);
      assert.deepEqual([...r.buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      assert.doesNotMatch(r.text, /79991110001|555-44-33/, kind);
    }
    const o = await get(`/api/clubs/${CLUB}/history/orders/export.csv?from=${ids.D}&to=${ids.D}`, 'manager');
    assert.match(o.text, /'\+7999\*\*\*0001/);
    assert.match(o.text, /Пиво × 2/);
    const audit = await t.admin.query("select count(*)::int as n from bl.audit_log where club_id = $1 and action = 'owner.export' and data->>'source' = 'history'", [CLUB]);
    assert.equal(audit.rows[0].n, 5);
  });

  it('права: ресепшн — 403, чужой клуб — 403, «все мои клубы» — только свои; неверный вид — 404', async () => {
    assert.equal((await get(`/api/clubs/${CLUB}/history/orders`, 'reception')).status, 403);
    assert.equal((await get(`/api/clubs/${CLUB}/history/orders/export.csv`, 'reception')).status, 403);
    assert.equal((await get(`/api/clubs/${CLUB}/history/orders`, 'ownerB')).status, 403);
    assert.equal((await get(`/api/clubs/${CLUB_B}/history/orders`, 'owner')).status, 403);
    assert.equal((await get(`/api/clubs/${CLUB}/history/sales`, 'owner')).status, 404);
    const all = await get(`/api/clubs/all/history/orders?from=${ids.D}&to=${ids.D}`, 'ownerB');
    assert.deepEqual(all.json.items, []);
    const mine = await get(`/api/clubs/all/history/orders?from=${ids.D}&to=${ids.D}`, 'owner');
    assert.equal(mine.json.items.length, 3);
    assert.ok(mine.json.items.every((x) => x.club_id === CLUB));
  });

  it('ведомость ревизии (№174): товары по группам, остаток по системе, «слепая» — без него', async () => {
    const r = await get(`/api/clubs/${CLUB}/stock/sheet`, 'manager');
    assert.equal(r.status, 200, r.text);
    const groups = new Map(r.json.groups.map((g) => [g.name, g.items.map((i) => [i.name, i.system_qty, i.actual_qty])]));
    assert.deepEqual(groups.get('Напитки'), [['Пиво', 21, null]], 'приход 24 − списание 2 − недостача 1');
    assert.deepEqual(groups.get('Без группы'), [['Чипсы', 10, null]]);
    assert.equal(r.json.groups.at(-1).name, 'Без группы');
    const blind = await get(`/api/clubs/${CLUB}/stock/sheet?blind=1`, 'manager');
    assert.ok(blind.json.groups.every((g) => g.items.every((i) => i.system_qty === null)));
    assert.equal(blind.json.blind, true);
    assert.equal((await get(`/api/clubs/${CLUB}/stock/sheet`, 'reception')).status, 403);
  });
});

describe('список смен (№176)', () => {
  it('фильтры: период, сотрудник, статус; CSV', async () => {
    const all = await get(`/api/clubs/${CLUB}/shifts`, 'manager');
    assert.deepEqual(all.json.items.map((s) => [s.number, s.state]), [[3, 'open'], [2, 'closed'], [1, 'discrepancy']]);
    const disc = await get(`/api/clubs/${CLUB}/shifts?status=discrepancy`, 'manager');
    assert.deepEqual(disc.json.items.map((s) => s.number), [1]);
    const byStaff = await get(`/api/clubs/${CLUB}/shifts?staff=${MANAGER}`, 'manager');
    assert.deepEqual(byStaff.json.items.map((s) => s.number), [2]);
    const period = await get(`/api/clubs/${CLUB}/shifts?from=${ids.D}&to=${ids.D}`, 'manager');
    assert.deepEqual(period.json.items.map((s) => s.number), [2]);
    const page = await get(`/api/clubs/${CLUB}/shifts?limit=1`, 'manager');
    assert.equal(page.json.next_cursor, 3);
    const p2 = await get(`/api/clubs/${CLUB}/shifts?limit=1&cursor=3`, 'manager');
    assert.deepEqual(p2.json.items.map((s) => s.number), [2]);
    assert.equal((await get(`/api/clubs/${CLUB}/shifts?status=bad`, 'manager')).status, 400);
    const csv = await get(`/api/clubs/${CLUB}/shifts/export.csv`, 'manager');
    assert.equal(csv.status, 200);
    assert.match(csv.text, /с расхождением/);
    assert.equal((await get(`/api/clubs/${CLUB}/shifts`, 'reception')).status, 403);
  });
});

describe('касса управляющего (№177)', () => {
  it('инкассации из смен — автоматически и один раз; доходы и расходы по статьям; остатки сходятся', async () => {
    await tick({ pool: t.pool, clock, log: t.log });
    await tick({ pool: t.pool, clock, log: t.log });
    const col = await t.admin.query("select shift_id, amount_kopecks, occurred_on::text as day from bl.cashbook_entries where club_id = $1 and kind = 'collection'", [CLUB]);
    assert.deepEqual(col.rows.map((r) => [Number(r.amount_kopecks), r.day]), [[120000, ids.D]], 'смена 2: 220 000 − размен 100 000; смена 1 — меньше размена');
    const cats = await get(`/api/clubs/${CLUB}/cashbook/categories`, 'manager');
    assert.ok(cats.json.some((c) => c.kind === 'expense' && c.name === 'Аренда'));
    const rent = cats.json.find((c) => c.name === 'Аренда').category_id;
    const start = cats.json.find((c) => c.name === 'Начальный остаток').category_id;
    const D0 = addDays(ids.D, -2);
    assert.equal((await post(`/api/clubs/${CLUB}/cashbook`, { kind: 'income', amount_kopecks: 1000000, category_id: start, date: D0 })).status, 201);
    const e1 = await post(`/api/clubs/${CLUB}/cashbook`, { kind: 'expense', amount_kopecks: 300000, category_id: rent, date: ids.D, comment: 'аренда октябрь' }, 'manager');
    assert.equal(e1.status, 201, e1.text);
    assert.equal((await post(`/api/clubs/${CLUB}/cashbook`, { kind: 'income', amount_kopecks: 1, category_id: rent, date: ids.D })).status, 400, 'статья не того вида');
    assert.equal((await post(`/api/clubs/${CLUB}/cashbook`, { kind: 'expense', amount_kopecks: 1, category_id: rent, date: addDays(today(), 1) })).status, 400, 'будущая дата');
    const v = await get(`/api/clubs/${CLUB}/cashbook?from=${ids.D}&to=${ids.D}`, 'manager');
    assert.equal(v.json.opening_kopecks, 1000000);
    assert.equal(v.json.collections_kopecks, 120000);
    assert.equal(v.json.expenses_kopecks, 300000);
    assert.equal(v.json.closing_kopecks, v.json.opening_kopecks + v.json.income_kopecks + v.json.collections_kopecks - v.json.expenses_kopecks);
    assert.equal(v.json.closing_kopecks, 820000);
    // Дашборд: «Расходы» и «Прибыль = выручка − расходы».
    const d = await get(`/api/clubs/${CLUB}/dashboard?from=${ids.D}&to=${ids.D}&tab=money`);
    const tiles = Object.fromEntries(d.json.tiles.map((x) => [x.id, x.value]));
    assert.equal(tiles.expenses, 300000);
    assert.equal(tiles.profit, tiles.revenue - 300000);
    assert.equal(d.json.tables.cash.collections_kopecks, 120000);
    ids.rentEntry = e1.json.entry_id;
  });

  it('сторно вместо правки: история не меняется, второе сторно — 409; UPDATE и DELETE запрещены', async () => {
    const s = await post(`/api/clubs/${CLUB}/cashbook/${ids.rentEntry}/storno`, { reason: 'ошиблись суммой' }, 'manager');
    assert.equal(s.status, 201, s.text);
    assert.equal(s.json.amount_kopecks, -300000);
    assert.equal(s.json.reverses_id, ids.rentEntry);
    assert.equal((await post(`/api/clubs/${CLUB}/cashbook/${ids.rentEntry}/storno`, { reason: 'ещё раз' }, 'manager')).status, 409);
    assert.equal((await post(`/api/clubs/${CLUB}/cashbook/${s.json.entry_id}/storno`, { reason: 'сторно сторно' })).status, 400);
    assert.equal((await post(`/api/clubs/${CLUB}/cashbook/${ids.rentEntry}/storno`, {})).status, 400);
    // Прошлый день не изменился: исходная запись на месте, сторно — датой сегодня.
    const past = await get(`/api/clubs/${CLUB}/cashbook?from=${ids.D}&to=${ids.D}`, 'manager');
    assert.equal(past.json.expenses_kopecks, 300000);
    assert.equal(past.json.entries.find((e) => e.entry_id === ids.rentEntry).reversed_by, s.json.entry_id);
    const now = await get(`/api/clubs/${CLUB}/cashbook?from=${today()}&to=${today()}`, 'manager');
    assert.equal(now.json.expenses_kopecks, -300000);
    assert.equal(now.json.closing_kopecks, 1120000);
    for (const sql of ["update bl.cashbook_entries set amount_kopecks = 1 where club_id = $1", 'delete from bl.cashbook_entries where club_id = $1']) {
      await assert.rejects(t.admin.query(sql, [CLUB]), /append-only/);
    }
    const j = await t.admin.query("select action, reason from bl.audit_log where club_id = $1 and action like 'cashbook.%' order by seq", [CLUB]);
    assert.deepEqual(j.rows.map((r) => r.action), ['cashbook.collection', 'cashbook.entry', 'cashbook.entry', 'cashbook.storno']);
    assert.equal(j.rows[3].reason, 'ошиблись суммой');
  });

  it('справочник — владелец; ресепшн кассу не видит; CSV', async () => {
    assert.equal((await post(`/api/clubs/${CLUB}/cashbook/categories`, { kind: 'expense', name: 'Реклама' }, 'manager')).status, 403);
    const c = await post(`/api/clubs/${CLUB}/cashbook/categories`, { kind: 'expense', name: 'Реклама' });
    assert.equal(c.status, 201);
    assert.equal((await post(`/api/clubs/${CLUB}/cashbook/categories`, { kind: 'expense', name: 'реклама' })).status, 409);
    const off = await t.request('PATCH', `/api/clubs/${CLUB}/cashbook/categories/${c.json.category_id}`, { token: tok.owner, body: { active: false } });
    assert.equal(off.status, 200);
    assert.equal(off.json.active, false);
    assert.equal((await get(`/api/clubs/${CLUB}/cashbook`, 'reception')).status, 403);
    assert.equal((await post(`/api/clubs/${CLUB}/cashbook`, { kind: 'expense', amount_kopecks: 1, category_id: c.json.category_id }, 'reception')).status, 403);
    const csv = await get(`/api/clubs/${CLUB}/cashbook/export.csv?from=${addDays(ids.D, -2)}&to=${today()}`, 'manager');
    assert.equal(csv.status, 200);
    assert.match(csv.text, /Остаток на конец;;11200,00/);
    assert.match(csv.text, /;-3000,00;/, 'отрицательная сумма — числом');
  });
});

describe('«Кто играл за столом» (№179)', () => {
  it('игры стола: время, сумма, способ, гость маской или ником', async () => {
    const r = await get(`/api/clubs/${CLUB}/resources/${T1}/sessions?from=${ids.D}&to=${ids.D}`, 'manager');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.items.map((x) => [x.guest, x.amount_kopecks, x.methods]), [
      [{ nick: 'Кий_мастер', phone_masked: null }, 0, []],
      [{ nick: null, phone_masked: '+7999***0001' }, 50000, ['sbp']],
    ]);
    assert.doesNotMatch(r.text, /79991110001/);
    assert.equal((await get(`/api/clubs/${CLUB}/resources/${T1}/sessions`, 'reception')).status, 403);
    assert.equal((await get(`/api/clubs/${CLUB}/resources/${T1}/sessions`, 'ownerB')).status, 403);
  });

  it('полный телефон — только владельцу с причиной; журнал guest.lookup без номера и уведомление', async () => {
    const path = `/api/clubs/${CLUB}/sessions/${ids.session}/guest-phone`;
    assert.equal((await post(path, { reason: 'забыл телефон' }, 'manager', false)).status, 403);
    assert.equal((await post(path, { reason: 'забыл телефон' }, 'reception', false)).status, 403);
    assert.equal((await post(path, {}, 'owner', false)).status, 400);
    const r = await post(path, { reason: 'гость забыл кий' }, 'owner', false);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { session_id: ids.session, phone: '+79991110001' });
    const j = await t.admin.query("select reason, data, actor_id from bl.audit_log where club_id = $1 and action = 'guest.lookup'", [CLUB]);
    assert.equal(j.rowCount, 1);
    assert.equal(j.rows[0].reason, 'гость забыл кий');
    assert.equal(j.rows[0].actor_id, OWNER);
    assert.doesNotMatch(JSON.stringify(j.rows[0].data), /79991110001/);
    const al = await t.admin.query("select data from bl.alarms where club_id = $1 and type = 'manual_action' and data->>'action' = 'guest.lookup'", [CLUB]);
    assert.equal(al.rowCount, 1);
    const n = await t.admin.query("select text from bl.notifications where club_id = $1 and text like 'Просмотрен телефон гостя%'", [CLUB]);
    assert.ok(n.rowCount >= 1, 'уведомление владельцу');
    assert.doesNotMatch(n.rows[0].text, /79991110001/);
    // Чужой клуб не отдаст телефон и через функцию базы.
    const c = await t.pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.club_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_type', 'user', true)", [CLUB_B, 'a2000000-0000-4000-8000-000000000002']);
      assert.equal((await c.query('select bl.guest_phone($1, $2) as p', [ids.session, G1])).rows[0].p, null);
      await c.query("select set_config('app.club_id', $1, true), set_config('app.user_id', $2, true)", [CLUB, MANAGER]);
      assert.equal((await c.query('select bl.guest_phone($1, $2) as p', [ids.session, G1])).rows[0].p, null, 'управляющему — нет');
      await c.query('rollback');
    } finally {
      c.release();
    }
  });
});
