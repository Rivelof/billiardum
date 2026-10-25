// Н-1 pentester M5.6: is_test обратных и связанных записей — от родителя (миграция 1251).
// Клуб в test → расход кассы и обслуживание со стоимостью → клуб в live → сторно и исправление не
// попадают в боевые отчёты (касса управляющего, плитка «Расходы» дашборда); продажа с тестовым
// платежом и инкассация тестовой смены — тестовые.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { startTestApp, CORE_ROUTE_FILES } from '../../../test/db/helpers.mjs';
import { loadRoutes } from '../../../../api/router.mjs';
import { cache as dashCache } from '../../../../api/routes/dashboard.mjs';

const CLUB = 'c1000000-0000-4000-8000-000000000001';
const RECEPTION = 'a1000000-0000-4000-8000-000000000004';
const T1 = 'e1000000-0000-4000-8000-000000000001';
let t;
const tokens = {};

before(async () => {
  t = await startTestApp({ routes: await loadRoutes({ only: [...CORE_ROUTE_FILES, 'dashboard.mjs', 'maintenance.mjs', 'cashbook.mjs'] }) });
  for (const [k, phone] of Object.entries({ owner: '+70000000001', manager: '+70000000003' })) tokens[k] = (await t.login(phone)).token;
});

after(async () => {
  await t?.stop();
});

const req = (method, path, who, body) => {
  dashCache.clear();
  return t.request(method, path, { token: tokens[who], body, headers: method === 'POST' ? { 'idempotency-key': randomUUID() } : {} });
};
const isTest = async (table, id) => (await t.admin.query(`select is_test from bl.${table} where id = $1`, [id])).rows[0].is_test;
const mode = (m) => t.admin.query(`update bl.clubs set mode = $2, went_live_at = case when $2 = 'live' then now() else went_live_at end where id = $1`, [CLUB, m]);

describe('Н-1: test → live → сторно не попадает в боевые отчёты', () => {
  it('ручной расход и расход обслуживания: сторно и исправление наследуют is_test; новый расход по явной стоимости — боевой', async () => {
    await mode('test');
    const cats = (await req('GET', `/api/clubs/${CLUB}/cashbook/categories`, 'owner')).json;
    const rent = cats.find((c) => c.name === 'Аренда');
    const manual = await req('POST', `/api/clubs/${CLUB}/cashbook`, 'manager', { kind: 'expense', amount_kopecks: 700_000, category_id: rent.category_id });
    assert.equal(manual.status, 201, manual.text);
    const ev = await req('POST', `/api/clubs/${CLUB}/maintenance`, 'manager', { resource_id: T1, kind: 'cloth', cost_kopecks: 1_500_000 });
    assert.equal(ev.status, 201, ev.text);
    assert.equal(await isTest('cashbook_entries', manual.json.entry_id), true);
    assert.equal(await isTest('cashbook_entries', ev.json.cashbook_entry_id), true);

    await mode('live');
    // Ручное сторно тестового расхода в live — тестовое (раньше: боевое +7 000 ₽ к прибыли).
    const st = await req('POST', `/api/clubs/${CLUB}/cashbook/${manual.json.entry_id}/storno`, 'owner', { reason: 'проверка' });
    assert.equal(st.status, 201, st.text);
    assert.equal(await isTest('cashbook_entries', st.json.entry_id), true);
    // Исправление без стоимости кассу не трогает.
    const c1 = await req('POST', `/api/clubs/${CLUB}/maintenance`, 'owner', { corrects_id: ev.json.event_id, reason: 'комментарий', comment: 'Сукно' });
    assert.equal(c1.json.cashbook.action, 'kept');
    // С явной стоимостью: сторно тестового расхода — тестовое, новый расход — боевой.
    const c2 = await req('POST', `/api/clubs/${CLUB}/maintenance`, 'owner', { corrects_id: c1.json.event_id, reason: 'реальный счёт', cost_kopecks: 900_000 });
    assert.equal(c2.status, 201, c2.text);
    assert.equal(c2.json.cashbook.action, 'replaced');
    assert.equal(await isTest('cashbook_entries', c2.json.cashbook.storno_entry_ids[0]), true);
    assert.equal(await isTest('cashbook_entries', c2.json.cashbook_entry_id), false);

    // Боевые отчёты: только новый расход 9 000 ₽.
    const cb = (await req('GET', `/api/clubs/${CLUB}/cashbook`, 'owner')).json;
    assert.equal(cb.expenses_kopecks, 900_000);
    assert.equal(cb.closing_kopecks - cb.opening_kopecks, -900_000);
    assert.deepEqual(cb.entries.map((e) => e.signed_kopecks), [-900_000]);
    const dash = (await req('GET', `/api/clubs/${CLUB}/dashboard?compare=0`, 'owner')).json;
    const tile = Object.fromEntries(dash.tiles.map((x) => [x.id, x.value]));
    assert.equal(tile.expenses, 900_000);
  });

  it('продажа и заказ с тестовым платежом, инкассация тестовой смены — тестовые и после перехода в live', async () => {
    await mode('test');
    const pay = randomUUID();
    await t.admin.query(
      `insert into bl.payments (id, club_id, kind, provider, method, idempotence_key, status, amount_kopecks, capture, confirmed_at, created_at, updated_at,
                                accepted_by, received_kopecks, change_kopecks)
       values ($1, $2, 'bar', 'reception', 'cash', $3, 'succeeded', 10000, true, now(), now(), now(), $4, 10000, 0)`,
      [pay, CLUB, `idem-${pay}`, RECEPTION],
    );
    const shift = randomUUID();
    await t.admin.query(
      `insert into bl.shifts (id, club_id, number, opened_by, opened_at, float_kopecks, closed_by, closed_at, cash_sales_kopecks, cash_refunds_kopecks,
                              expected_cash_kopecks, actual_cash_kopecks, discrepancy_kopecks)
       values ($1, $2, 901, $3, now() - interval '2 hours', 0, $3, now() - interval '1 hour', 10000, 0, 10000, 10000, 0)`,
      [shift, CLUB, RECEPTION],
    );
    assert.equal(await isTest('payments', pay), true);
    await mode('live');
    const sale = randomUUID();
    await t.admin.query(
      `insert into bl.pos_sales (id, club_id, channel, method, status, payment_id, created_by, bar_subtotal_kopecks, bar_total_kopecks, package_kopecks,
                                 received_kopecks, change_kopecks, created_at, completed_at, updated_at)
       values ($1, $2, 'pos', 'cash', 'completed', $3, $4, 10000, 10000, 0, 10000, 0, now(), now(), now())`,
      [sale, CLUB, pay, RECEPTION],
    );
    assert.equal(await isTest('pos_sales', sale), true, 'продажа — по платежу');
    const refund = randomUUID();
    await t.admin.query(
      `insert into bl.refunds (id, club_id, payment_id, idempotence_key, amount_kopecks, status, reason, requested_by, created_at, updated_at, kind)
       values ($1, $2, $3, $4, 10000, 'manual', 'возврат', $5, now(), now(), 'refund')`,
      [refund, CLUB, pay, `rf-${refund}`, RECEPTION],
    );
    assert.equal(await isTest('refunds', refund), true, 'возврат — по платежу');
    const coll = (await t.admin.query(
      `insert into bl.cashbook_entries (club_id, kind, amount_kopecks, occurred_on, shift_id, comment, created_at) values ($1, 'collection', 10000, current_date, $2, 'Смена №901', now()) returning id`,
      [CLUB, shift],
    )).rows[0].id;
    assert.equal(await isTest('cashbook_entries', coll), true, 'инкассация — по смене');
    // Без родителя — по режиму клуба: боевая.
    const live = randomUUID();
    await t.admin.query(
      `insert into bl.payments (id, club_id, kind, provider, method, idempotence_key, status, amount_kopecks, capture, confirmed_at, created_at, updated_at,
                                accepted_by, received_kopecks, change_kopecks)
       values ($1, $2, 'bar', 'reception', 'cash', $3, 'succeeded', 10000, true, now(), now(), now(), $4, 10000, 0)`,
      [live, CLUB, `idem-${live}`, RECEPTION],
    );
    assert.equal(await isTest('payments', live), false);
    await assert.rejects(t.admin.query('update bl.cashbook_entries set is_test = false where id = $1', [coll]), /append-only|is_test/);
  });
});
