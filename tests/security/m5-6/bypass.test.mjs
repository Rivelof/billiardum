// Безопасность M5.6, заход 2 (pentester). Обход исправления Н-1 другими путями:
// сторно сторно, инкассация смены, продажа/заказ с платежом, запрет смены is_test у кассы.
// Атакующий — ресепшн/управляющий, который хочет завысить боевую прибыль, перенеся тестовый
// минус (сторно) в боевую кассу после перехода клуба в live.
//
// Прогон (свой временный Postgres, НЕ база стенда):
//   DATABASE_ADMIN_URL=postgres://postgres@127.0.0.1:54329/postgres \
//     node --test --test-concurrency=1 tests/security/m5-6/bypass.test.mjs
//
// Каждый тест создаёт свою временную базу (template1 + миграции + сид) и удаляет её.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { startTestApp, CORE_ROUTE_FILES } from '../../../server/test/db/helpers.mjs';
import { loadRoutes } from '../../../api/router.mjs';
import { cache as dashCache } from '../../../api/routes/dashboard.mjs';
import { asRole, tryQuery } from '../../../supabase/tests/helpers.mjs';

const CLUB = 'c1000000-0000-4000-8000-000000000001';
const RECEPTION = 'a1000000-0000-4000-8000-000000000004';

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

// Коммит от имени app_api с контекстом клуба (asRole откатывает — здесь нужен коммит).
async function appApiCommit(clubId, userId, sql, params) {
  const c = await t.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local role app_api');
    await c.query("select set_config('app.club_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_type', 'user', true)", [clubId, userId]);
    const { rows } = await c.query(sql, params);
    await c.query('commit');
    return rows;
  } catch (err) {
    await c.query('rollback').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}
const mode = (m) => t.admin.query(`update bl.clubs set mode = $2, went_live_at = case when $2 = 'live' then now() else went_live_at end where id = $1`, [CLUB, m]);

// Боевые суммы кассы за всё время (как в плитке «Расходы» и книге: not is_test).
async function liveCash() {
  const { rows } = await t.admin.query(
    `select coalesce(sum(amount_kopecks) filter (where kind = 'income'), 0)::bigint as income,
            coalesce(sum(amount_kopecks) filter (where kind = 'collection'), 0)::bigint as collections,
            coalesce(sum(amount_kopecks) filter (where kind = 'expense'), 0)::bigint as expenses
       from bl.cashbook_entries where club_id = $1 and not is_test`,
    [CLUB],
  );
  return { income: Number(rows[0].income), collections: Number(rows[0].collections), expenses: Number(rows[0].expenses) };
}

describe('Н-1 заход 2: обход через сторно сторно', () => {
  it('сторно тестового расхода в live наследует is_test; сторно сторно запрещено (API 400 и триггер базы)', async () => {
    await mode('test');
    const cats = (await req('GET', `/api/clubs/${CLUB}/cashbook/categories`, 'owner')).json;
    const rent = cats.find((c) => c.name === 'Аренда') ?? cats.find((c) => c.kind === 'expense');
    // Тестовый расход 50 000 ₽.
    const exp = await req('POST', `/api/clubs/${CLUB}/cashbook`, 'manager', { kind: 'expense', amount_kopecks: 5_000_000, category_id: rent.category_id });
    assert.equal(exp.status, 201, exp.text);
    assert.equal(await isTest('cashbook_entries', exp.json.entry_id), true);

    await mode('live');
    const before = await liveCash();

    // Атака: сторно тестового расхода после go-live. Раньше (Н-1) сторно было боевым: −5 000 000.
    const st = await req('POST', `/api/clubs/${CLUB}/cashbook/${exp.json.entry_id}/storno`, 'owner', { reason: 'завысить прибыль' });
    assert.equal(st.status, 201, st.text);
    assert.equal(await isTest('cashbook_entries', st.json.entry_id), true, 'сторно наследует is_test исходной записи');

    // Повтор сторно той же записи — 409 (уникальный reverses_id), не второй минус.
    const dup = await req('POST', `/api/clubs/${CLUB}/cashbook/${exp.json.entry_id}/storno`, 'owner', { reason: 'ещё раз' });
    assert.equal(dup.status, 409, dup.text);

    // Атака: сторно самого сторно (создать ещё один минус). API — 400 'storno of storno'.
    const ss = await req('POST', `/api/clubs/${CLUB}/cashbook/${st.json.entry_id}/storno`, 'owner', { reason: 'минус на минус' });
    assert.equal(ss.status, 400, ss.text);
    assert.equal(ss.json.error, 'bad_request');

    // Та же атака в обход API — прямой insert сторно-на-сторно ролью app_api: триггер базы (cashbook_storno_check).
    await asRole(t.admin, 'app_api', { clubId: CLUB, userId: RECEPTION, actorType: 'user' }, async (c) => {
      const err = await tryQuery(
        c,
        `insert into bl.cashbook_entries (club_id, kind, amount_kopecks, category_id, occurred_on, reverses_id, reason, created_at)
         values ($1, 'expense', 5000000, $2, current_date, $3, 'минус на минус', now())`,
        [CLUB, rent.category_id, st.json.entry_id],
      );
      assert.ok(err, 'сторно сторно через app_api должно упасть');
      assert.match(String(err.message), /bad storno|storno|check/i);
    });

    // Боевая касса не изменилась: тестовый расход и его тестовое сторно не входят.
    const afterCash = await liveCash();
    assert.deepEqual(afterCash, before, 'боевые суммы кассы не изменились');
    assert.equal(afterCash.expenses, 0, 'боевых расходов нет (тестовый минус не стал боевым)');
  });
});

describe('Н-1 заход 2: триггер запрета смены is_test у записей кассы', () => {
  it('app_api не навязывает is_test при вставке и не может его изменить (нет UPDATE; append-only; is_test_guard)', async () => {
    await mode('test');
    const cat = (await t.admin.query(`select id from bl.cashbook_categories where club_id = $1 and kind = 'expense' limit 1`, [CLUB])).rows[0].id;
    // Атака при вставке: прислать is_test = false в тестовом клубе — триггер set_is_test перезапишет на true (коммит).
    const forged = (await appApiCommit(
      CLUB,
      RECEPTION,
      `insert into bl.cashbook_entries (club_id, kind, amount_kopecks, category_id, occurred_on, is_test, created_at)
       values ($1, 'expense', 100000, $2, current_date, false, now()) returning id, is_test`,
      [CLUB, cat],
    ))[0];
    assert.equal(forged.is_test, true, 'присланный is_test=false перезаписан триггером на true (режим клуба)');

    // После go-live запись остаётся тестовой; изменить is_test нельзя.
    await mode('live');
    // (1) app_api: нет права UPDATE на cashbook_entries вообще → permission denied (42501).
    await asRole(t.admin, 'app_api', { clubId: CLUB, userId: RECEPTION, actorType: 'user' }, async (c) => {
      const err = await tryQuery(c, 'update bl.cashbook_entries set is_test = false where id = $1', [forged.id]);
      assert.ok(err, 'UPDATE ролью app_api должен упасть');
      assert.equal(err.code, '42501', `ожидали permission denied, получили ${err.code}: ${err.message}`);
    });
    // (2) RLS FORCE: ни app_api, ни владелец таблицы bl_owner строку даже не видят для UPDATE
    //     (политики UPDATE нет → 0 строк, построчный триггер не срабатывает).
    const seenByOwner = await asRole(t.admin, 'bl_owner', { clubId: CLUB }, async (c) =>
      Number((await c.query('select count(*)::int n from bl.cashbook_entries where id = $1', [forged.id])).rows[0].n),
    );
    assert.equal(seenByOwner, 0, 'владелец таблицы под FORCE RLS строку не видит');
    // (3) суперпользователь (в обход RLS, строка найдена) — упирается в триггер enable always
    //     (is_test_guard / append-only): даже прямой UPDATE не меняет признак.
    await assert.rejects(
      t.admin.query('update bl.cashbook_entries set is_test = false where id = $1', [forged.id]),
      /append-only|is_test/i,
      'даже суперпользователь не меняет is_test (триггер enable always)',
    );
    assert.equal(await isTest('cashbook_entries', forged.id), true, 'запись осталась тестовой');
  });
});

describe('Н-1 заход 2: инкассация смены и продажа/заказ с платежом', () => {
  it('after go-live: инкассация тестовой смены и продажа по тестовому платежу остаются тестовыми даже при подложном is_test=false', async () => {
    await mode('test');
    const pay = randomUUID();
    await t.admin.query(
      `insert into bl.payments (id, club_id, kind, provider, method, idempotence_key, status, amount_kopecks, capture, confirmed_at, created_at, updated_at, accepted_by, received_kopecks, change_kopecks)
       values ($1, $2, 'bar', 'reception', 'cash', $3, 'succeeded', 10000, true, now(), now(), now(), $4, 10000, 0)`,
      [pay, CLUB, `idem-${pay}`, RECEPTION],
    );
    const shift = randomUUID();
    await t.admin.query(
      `insert into bl.shifts (id, club_id, number, opened_by, opened_at, float_kopecks, closed_by, closed_at, cash_sales_kopecks, cash_refunds_kopecks, expected_cash_kopecks, actual_cash_kopecks, discrepancy_kopecks)
       values ($1, $2, 950, $3, now() - interval '2 hours', 0, $3, now() - interval '1 hour', 10000, 0, 10000, 10000, 0)`,
      [shift, CLUB, RECEPTION],
    );
    assert.equal(await isTest('payments', pay), true);
    assert.equal(await isTest('shifts', shift), true);

    await mode('live');
    const before = await liveCash();

    // Атака 1: внести инкассацию тестовой смены как БОЕВУЮ (подложный is_test=false) через app_api.
    const coll = (await appApiCommit(
      CLUB, RECEPTION,
      `insert into bl.cashbook_entries (club_id, kind, amount_kopecks, occurred_on, shift_id, is_test, comment, created_at)
       values ($1, 'collection', 10000, current_date, $2, false, 'Смена №950', now()) returning id, is_test`,
      [CLUB, shift],
    ))[0];
    assert.equal(coll.is_test, true, 'инкассация наследует is_test смены (подлог is_test=false перезаписан)');

    // Атака 2: продажа по тестовому платежу с подложным is_test=false.
    const sale = randomUUID();
    const saleRow = (await appApiCommit(
      CLUB, RECEPTION,
      `insert into bl.pos_sales (id, club_id, channel, method, status, payment_id, created_by, bar_subtotal_kopecks, bar_total_kopecks, package_kopecks, received_kopecks, change_kopecks, is_test, created_at, completed_at, updated_at)
       values ($1, $2, 'pos', 'cash', 'completed', $3, $4, 10000, 10000, 0, 10000, 0, false, now(), now(), now()) returning is_test`,
      [sale, CLUB, pay, RECEPTION],
    ))[0];
    assert.equal(saleRow.is_test, true, 'продажа наследует is_test платежа (подлог перезаписан)');

    // Боевая касса не изменилась: тестовая инкассация не вошла.
    assert.deepEqual(await liveCash(), before, 'тестовая инкассация не стала боевой');

    // Контроль: платёж/смена без родителя создаются по режиму клуба (в live — боевые).
    const liveShift = randomUUID();
    await t.admin.query(
      `insert into bl.shifts (id, club_id, number, opened_by, opened_at, float_kopecks, closed_by, closed_at, cash_sales_kopecks, cash_refunds_kopecks, expected_cash_kopecks, actual_cash_kopecks, discrepancy_kopecks)
       values ($1, $2, 951, $3, now() - interval '2 hours', 0, $3, now() - interval '1 hour', 10000, 0, 10000, 10000, 0)`,
      [liveShift, CLUB, RECEPTION],
    );
    assert.equal(await isTest('shifts', liveShift), false, 'смена, открытая в live, — боевая');
    const liveColl = (await appApiCommit(
      CLUB, RECEPTION,
      `insert into bl.cashbook_entries (club_id, kind, amount_kopecks, occurred_on, shift_id, comment, created_at)
       values ($1, 'collection', 10000, current_date, $2, 'Смена №951', now()) returning is_test`,
      [CLUB, liveShift],
    ))[0];
    assert.equal(liveColl.is_test, false, 'инкассация боевой смены — боевая');
  });
});
