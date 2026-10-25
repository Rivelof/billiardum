// Сети клубов (M5.5, docs/contracts/m5-5-8.md №190–193) на временной базе:
//   T41 — шаблон тарифов и меню сети в клубах с разными поясами, переопределение по правилам шаблона
//         (мягкий / жёсткий), журнал в каждом клубе и уведомления владельцу;
//   T42 — управляющий сети (как управляющий, без экспорта и денег по способам оплаты), вкладка «Сеть»
//         (сравнение и рейтинг), изоляция чужой сети; подписка «Сеть» — billing.test.mjs;
//   плюс: чужой клуб в сеть, клуб во вторую сеть, RLS таблиц сети, права app_api.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { loadRoutes } from '../../../../api/router.mjs';
import { cache as dashboardCache } from '../../../../api/routes/dashboard.mjs';
import { CLUB_B, OWNER_B, seedClubB, tryQuery } from '../../../../supabase/tests/helpers.mjs';
import { withContext } from '../../../lib/store.mjs';
import { amountFor } from '../../../tariffs/index.mjs';
import { applyTemplate } from '../../../setup/tariffs.mjs';
import { CLUB_A, OWNER_A, startTestApp } from '../../../test/db/helpers.mjs';

const SKIP = !process.env.DATABASE_ADMIN_URL;
const CLUB_K = 'c5500000-0000-4000-8000-000000000001'; // Калининград, UTC+2, live
const CLUB_T = 'c5500000-0000-4000-8000-000000000002'; // Владивосток, UTC+10, test
const K1 = 'e5500000-0000-4000-8000-000000000001';
const K2 = 'e5500000-0000-4000-8000-000000000002';
const T1 = 'e5500000-0000-4000-8000-000000000003';
const A_PYR = 'e1000000-0000-4000-8000-000000000001';
const A_POOL = 'e1000000-0000-4000-8000-000000000006';
const RECEPTION_A = 'a1000000-0000-4000-8000-000000000004';
const NM_PHONE = '+70000000020';
const ROUTES = ['auth.mjs', 'owner.mjs', 'stream.mjs', 'staff.mjs', 'setup.mjs', 'catalog.mjs', 'dashboard.mjs', 'history.mjs', 'shifts.mjs', 'cashbook.mjs', 'networks.mjs'];

let t;
const tok = {};
let net; // сеть владельца A: клубы A, K, T
let netB; // сеть владельца B: клуб B
let nmUser; // управляющий сети
let memberId; // его строка network_members

const api = (method, path, who, body) => {
  dashboardCache.clear();
  return t.request(method, path, { token: tok[who], body });
};
const audit = async (club, action) => (await t.admin.query('select * from bl.audit_log where club_id = $1 and action = $2 order by seq', [club, action])).rows;
const inClub = (club, fn) => withContext(t.pool, { clubId: club, actorType: 'system' }, fn);
const rulesOf = async (club) =>
  (await t.admin.query('select resource_type, days, start_local::text, end_local::text, price_per_hour from bl.tariff_rules where club_id = $1 and active order by resource_type, start_local', [club])).rows;
const product = async (club, name) => (await t.admin.query('select * from bl.products where club_id = $1 and name = $2', [club, name])).rows[0];
const alarmsFor = async (club, action) =>
  (await t.admin.query("select * from bl.alarms where club_id = $1 and type = 'manual_action' and data->>'action' = $2", [club, action])).rows;
const notesFor = async (alarmId) => (await t.admin.query("select user_id, text from bl.notifications where kind = 'alarm' and data->>'alarm_id' = $1", [alarmId])).rows;

/** Транзакция под app_api (коммит) с контекстом: так, как зовёт сервер. */
async function asApp({ clubId = null, userId = null, actorType = 'user' }, fn) {
  const c = await t.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local role app_api');
    await c.query("select set_config('app.club_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_type', $3, true)", [clubId ?? '', userId ?? '', actorType]);
    return await fn(c);
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }
}

before(async () => {
  if (SKIP) return;
  const config = { publicHost: 'bl.test' };
  t = await startTestApp({ routes: await loadRoutes({ config, only: ROUTES }), config, notifyWorker: false });
  await seedClubB(t.admin);
  await t.admin.query(`
    insert into bl.clubs (id, name, city, timezone) values ('${CLUB_K}', 'Клуб Калининград', 'Калининград', 'Europe/Kaliningrad');
    insert into bl.clubs (id, name, city, timezone, mode) values ('${CLUB_T}', 'Клуб Тест', 'Владивосток', 'Asia/Vladivostok', 'test');
    insert into bl.club_members (club_id, user_id, role) values ('${CLUB_K}', '${OWNER_A}', 'owner'), ('${CLUB_T}', '${OWNER_A}', 'owner');
    insert into bl.resources (id, club_id, type, number, title) values
      ('${K1}', '${CLUB_K}', 'billiard_pool', 1, 'Стол 1'), ('${K2}', '${CLUB_K}', 'billiard_pool', 2, 'Стол 2'),
      ('${T1}', '${CLUB_T}', 'billiard_pyramid', 1, 'Стол 1');
  `);
  for (const [k, phone] of Object.entries({ owner: '+70000000001', ownerB: '+70000000002', manager: '+70000000003', reception: '+70000000004' })) {
    tok[k] = (await t.login(phone)).token;
  }
});

after(async () => {
  await t?.stop();
});

describe('сеть: создание и состав (№190)', { skip: SKIP }, () => {
  it('владелец создаёт сеть и добавляет свои клубы; журнал network.club_added в клубе', async () => {
    const r = await api('POST', '/api/networks', 'owner', { name: 'Сеть Урал' });
    assert.equal(r.status, 201, r.text);
    net = r.json.id;
    assert.deepEqual([r.json.role, r.json.tariffs_mode, r.json.menu_mode, r.json.clubs], ['owner', 'soft', 'soft', []]);
    for (const club of [CLUB_A, CLUB_K, CLUB_T]) {
      const a = await api('POST', `/api/networks/${net}/clubs`, 'owner', { club_id: club });
      assert.equal(a.status, 201, a.text);
    }
    const again = await api('POST', `/api/networks/${net}/clubs`, 'owner', { club_id: CLUB_A });
    assert.equal(again.status, 200, 'повтор — без изменений');
    assert.equal(again.json.clubs.length, 3);
    assert.equal(again.json.plan.code, 'network');
    assert.equal(again.json.plan.applies, true);
    const [rec] = await audit(CLUB_K, 'network.club_added');
    assert.equal(rec.object_id, net);
    assert.equal(rec.actor_id, OWNER_A);
    const list = await api('GET', '/api/networks', 'owner');
    assert.deepEqual(list.json.items.map((x) => [x.network_id, x.role, x.clubs]), [[net, 'owner', 3]]);
  });

  it('чужой клуб — 403; клуб во вторую сеть — 409 club_in_network; база проверяет владение сама', async () => {
    assert.equal((await api('POST', `/api/networks/${net}/clubs`, 'owner', { club_id: CLUB_B })).status, 403);
    const second = await api('POST', '/api/networks', 'owner', { name: 'Вторая сеть' });
    assert.equal(second.status, 201);
    const dup = await api('POST', `/api/networks/${second.json.id}/clubs`, 'owner', { club_id: CLUB_A });
    assert.deepEqual([dup.status, dup.json], [409, { error: 'club_in_network' }]);
    // Владелец B: своя сеть, чужой клуб A — 403; чужая сеть — 404.
    const b = await api('POST', '/api/networks', 'ownerB', { name: 'Сеть Б' });
    netB = b.json.id;
    assert.equal((await api('POST', `/api/networks/${netB}/clubs`, 'ownerB', { club_id: CLUB_B })).status, 201);
    assert.equal((await api('POST', `/api/networks/${netB}/clubs`, 'ownerB', { club_id: CLUB_A })).status, 403);
    assert.equal((await api('POST', `/api/networks/${net}/clubs`, 'ownerB', { club_id: CLUB_B })).status, 404);
    // Управляющий клуба A не создаёт сеть из клуба A (не владелец клуба).
    const m = await api('POST', '/api/networks', 'manager', { name: 'Сеть управляющего' });
    assert.equal((await api('POST', `/api/networks/${m.json.id}/clubs`, 'manager', { club_id: CLUB_A })).status, 403);
    // База: узкая функция сама проверяет владение и одну сеть; прямой записи у app_api нет.
    await asApp({ userId: OWNER_B }, async (c) => {
      assert.equal((await tryQuery(c, 'select bl.network_add_club($1, $2)', [netB, CLUB_A]))?.code, 'BLN01');
      assert.equal((await tryQuery(c, 'select bl.network_add_club($1, $2)', [net, CLUB_B]))?.code, 'BLN03');
      assert.equal((await tryQuery(c, 'insert into bl.network_clubs (network_id, club_id, added_by) values ($1, $2, $3)', [netB, CLUB_A, OWNER_B]))?.code, '42501');
      assert.equal((await tryQuery(c, 'update bl.network_clubs set active = false where club_id = $1', [CLUB_B]))?.code, '42501');
    });
    await asApp({ userId: OWNER_A }, async (c) => {
      assert.equal((await tryQuery(c, 'select bl.network_add_club($1, $2)', [second.json.id, CLUB_K]))?.code, 'BLN02');
    });
    // Клуб — не больше чем в одной сети: уникальный индекс базы.
    const e = await t.admin.query('insert into bl.network_clubs (network_id, club_id, added_by) values ($1, $2, $3)', [second.json.id, CLUB_A, OWNER_A]).catch((x) => x);
    assert.equal(e.code, '23505');
    assert.equal((await api('DELETE', `/api/networks/${second.json.id}`, 'owner')).status, 200);
    assert.equal((await api('DELETE', `/api/networks/${m.json.id}`, 'manager')).status, 200);
  });
});

describe('T41. Шаблон тарифов сети (№191)', { skip: SKIP }, () => {
  const dayEvening = applyTemplate('day_evening', { day: 50000, evening: 70000 });

  it('в live без причины — reason_required; цена 0 — 400; дыра в неделе клуба — 400 tariff_gap {club_id}', async () => {
    const r = await api('PUT', `/api/networks/${net}/tariffs`, 'owner', { rules: dayEvening });
    assert.deepEqual([r.status, r.json], [400, { error: 'reason_required' }]);
    const zero = await api('PUT', `/api/networks/${net}/tariffs`, 'owner', { rules: applyTemplate('single', { price: 0 }), reason: 'x' });
    assert.equal(zero.status, 400);
    // Только пирамида: в клубе K (только пул) и A (есть пул) неделя пула не покрыта.
    const pyr = applyTemplate('single', { price: 50000 }, { kind: 'pyramid' });
    const gap = await api('PUT', `/api/networks/${net}/tariffs`, 'owner', { rules: pyr, reason: 'x' });
    assert.equal(gap.status, 400);
    assert.equal(gap.json.error, 'tariff_gap');
    assert.ok([CLUB_A, CLUB_K].includes(gap.json.club_id), gap.text);
    assert.equal(gap.json.kind, 'pool');
    assert.equal((await t.admin.query('select count(*)::int as n from bl.network_tariff_rules')).rows[0].n, 0, 'ничего не записано');
    // База: цена шаблона > 0 (№163).
    const db0 = await t.admin.query(
      `insert into bl.network_tariff_rules (network_id, version, ord, rule, price_per_hour, created_by) values ($1, 1, 0, '{"price_per_hour_kopecks": 0}', 0, $2)`, [net, OWNER_A],
    ).catch((x) => x);
    assert.equal(db0.code, '23514');
    // Управляющий клуба (не владелец сети) шаблон не меняет: сети не видит.
    assert.equal((await api('PUT', `/api/networks/${net}/tariffs`, 'manager', { rules: dayEvening, reason: 'x' })).status, 404);
  });

  it('шаблон применяется в клубах с разными поясами: цена по местному времени каждого клуба; журнал и уведомления', async () => {
    const r = await api('PUT', `/api/networks/${net}/tariffs`, 'owner', { rules: dayEvening, reason: 'Единый прайс сети' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.version, 1);
    assert.equal(r.json.template, true);
    assert.deepEqual(r.json.clubs.map((c) => [c.club_id, c.override, c.applied_version, c.problem]).sort(), [[CLUB_A, false, 1, null], [CLUB_K, false, 1, null], [CLUB_T, false, 1, null]].sort());
    for (const club of [CLUB_A, CLUB_K, CLUB_T]) {
      const rules = await rulesOf(club);
      assert.ok(rules.length >= 2, club);
      assert.ok(rules.every((x) => [50000, 70000].includes(Number(x.price_per_hour))), club);
    }
    // Один и тот же момент 2026-10-26 14:00 UTC (понедельник): в Екатеринбурге 19:00 — вечер, в Калининграде 16:00 — день.
    const at = new Date('2026-10-26T14:00:00Z');
    const a = await inClub(CLUB_A, (db) => amountFor(db, { resourceId: A_POOL, from: at, minutes: 60 }));
    const k = await inClub(CLUB_K, (db) => amountFor(db, { resourceId: K1, from: at, minutes: 60 }));
    assert.equal(a.amount_kopecks, 70000);
    assert.equal(k.amount_kopecks, 50000);
    // Владивосток (UTC+10): 06:00Z — 16:00 местного (день), 10:00Z — 20:00 (вечер).
    const vlDay = await inClub(CLUB_T, (db) => amountFor(db, { resourceId: T1, from: new Date('2026-10-26T06:00:00Z'), minutes: 60 }));
    const vlEve = await inClub(CLUB_T, (db) => amountFor(db, { resourceId: T1, from: new Date('2026-10-26T10:00:00Z'), minutes: 60 }));
    assert.deepEqual([vlDay.amount_kopecks, vlEve.amount_kopecks], [50000, 70000]);
    // Журнал в каждом клубе: live — ручное действие с причиной и тревога владельцу, test — network.tariffs_applied.
    for (const club of [CLUB_A, CLUB_K]) {
      const [m] = await audit(club, 'manual.network_tariff_change');
      assert.ok(m, club);
      assert.equal(m.reason, 'Единый прайс сети');
      assert.equal(m.actor_id, OWNER_A);
      assert.equal(m.data.network_id, net);
      assert.equal(m.data.version, 1);
      const [alarm] = await alarmsFor(club, 'manual.network_tariff_change');
      assert.ok(alarm, `тревога ${club}`);
      const notes = await notesFor(alarm.id);
      assert.ok(notes.some((n) => n.user_id === OWNER_A && n.text.includes('Единый прайс сети')), JSON.stringify(notes));
    }
    assert.equal((await audit(CLUB_T, 'manual.network_tariff_change')).length, 0);
    assert.equal((await audit(CLUB_T, 'network.tariffs_applied')).length, 1);
  });

  it('мягкий шаблон: клуб переопределяет тарифы, следующая версия его не меняет; сброс возвращает к шаблону', async () => {
    const own = applyTemplate('single', { price: 40000 });
    const r = await api('PUT', `/api/clubs/${CLUB_K}/tariffs`, 'owner', { rules: own, reason: 'Свой прайс Калининграда' });
    assert.equal(r.status, 200, r.text);
    const st = await api('GET', `/api/clubs/${CLUB_K}/network`, 'owner');
    assert.equal(st.json.network.id, net);
    assert.deepEqual([st.json.network.tariffs.locked, st.json.network.tariffs.override], [false, true]);
    const [m] = await audit(CLUB_K, 'manual.tariff_change');
    assert.equal(m.data.network_override, true);
    // Версия 2: A и T меняются, K — нет (журнал network.tariffs_template, applied: false).
    const v2 = applyTemplate('day_evening', { day: 55000, evening: 75000 });
    const p = await api('PUT', `/api/networks/${net}/tariffs`, 'owner', { rules: v2, reason: 'Индексация' });
    assert.equal(p.status, 200, p.text);
    assert.ok((await rulesOf(CLUB_K)).every((x) => Number(x.price_per_hour) === 40000));
    assert.ok((await rulesOf(CLUB_A)).every((x) => [55000, 75000].includes(Number(x.price_per_hour))));
    const [skip] = await audit(CLUB_K, 'network.tariffs_template');
    assert.deepEqual([skip.data.applied, skip.data.version], [false, 2]);
    assert.equal((await audit(CLUB_K, 'manual.network_tariff_change')).length, 1, 'K затронут только версией 1');
    // Сброс клубом: в live — с причиной.
    assert.equal((await api('POST', `/api/clubs/${CLUB_K}/network/reset`, 'owner', { scope: 'tariffs' })).status, 400);
    const reset = await api('POST', `/api/clubs/${CLUB_K}/network/reset`, 'owner', { scope: 'tariffs', reason: 'Вернуться к сети' });
    assert.equal(reset.status, 200, reset.text);
    assert.ok((await rulesOf(CLUB_K)).every((x) => [55000, 75000].includes(Number(x.price_per_hour))));
    const last = (await audit(CLUB_K, 'manual.network_tariff_change')).at(-1);
    assert.deepEqual([last.reason, last.data.reset, last.data.version], ['Вернуться к сети', true, 2]);
    assert.equal((await api('GET', `/api/clubs/${CLUB_K}/network`, 'owner')).json.network.tariffs.override, false);
  });

  it('жёсткий шаблон: переход возвращает переопределивших к шаблону (с причиной); клуб тарифы не меняет — 409', async () => {
    assert.equal((await api('PUT', `/api/clubs/${CLUB_K}/tariffs`, 'owner', { rules: applyTemplate('single', { price: 45000 }), reason: 'Снова свой' })).status, 200);
    const noReason = await api('PATCH', `/api/networks/${net}`, 'owner', { tariffs_mode: 'hard' });
    assert.deepEqual([noReason.status, noReason.json], [400, { error: 'reason_required' }]);
    assert.equal((await t.admin.query('select tariffs_mode from bl.networks where id = $1', [net])).rows[0].tariffs_mode, 'soft', 'откат целиком');
    const hard = await api('PATCH', `/api/networks/${net}`, 'owner', { tariffs_mode: 'hard', reason: 'Единые цены во всех клубах' });
    assert.equal(hard.status, 200, hard.text);
    assert.equal(hard.json.tariffs_mode, 'hard');
    assert.ok((await rulesOf(CLUB_K)).every((x) => [55000, 75000].includes(Number(x.price_per_hour))));
    const [upd] = await audit(CLUB_A, 'network.updated');
    assert.deepEqual(upd.data.changes.tariffs_mode, ['soft', 'hard']);
    for (const who of ['owner', 'manager']) {
      const r = await api('PUT', `/api/clubs/${CLUB_A}/tariffs`, who, { rules: applyTemplate('single', { price: 45000 }), reason: 'x' });
      assert.deepEqual([r.status, r.json.error, r.json.network_id], [409, 'network_locked', net], who);
    }
    // Шаблон меняет только владелец сети.
    assert.equal((await api('PATCH', `/api/networks/${net}`, 'manager', { tariffs_mode: 'soft' })).status, 404);
  });
});

describe('T41. Шаблон меню сети (№191)', { skip: SKIP }, () => {
  let tea;
  let beer;
  const tpl = (over = {}) => [
    { category: 'Напитки', name: 'Чай', price_kopecks: over.tea ?? 15000, unit: 'шт', sku: 'TEA-1' },
    { category: 'Бар', name: 'Пиво', price_kopecks: 25000, unit: 'шт', is_alcohol: true, sku: 'BEER-1' },
  ];

  it('шаблон в клубах: товары с копейками, алкоголь гостю в QR-меню не виден; live — с причиной и уведомлением', async () => {
    const no = await api('PUT', `/api/networks/${net}/menu`, 'owner', { products: tpl() });
    assert.deepEqual([no.status, no.json], [400, { error: 'reason_required' }]);
    const bad = await api('PUT', `/api/networks/${net}/menu`, 'owner', { products: [{ name: 'Чай', price_kopecks: 0 }], reason: 'x' });
    assert.equal(bad.status, 400);
    const r = await api('PUT', `/api/networks/${net}/menu`, 'owner', { products: tpl(), reason: 'Единое меню' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.version, 1);
    tea = r.json.products.find((p) => p.name === 'Чай').id;
    beer = r.json.products.find((p) => p.name === 'Пиво').id;
    assert.equal(r.json.products.find((p) => p.id === beer).payment_subject, 'excise');
    for (const club of [CLUB_A, CLUB_K, CLUB_T]) {
      const t1 = await product(club, 'Чай');
      const b1 = await product(club, 'Пиво');
      assert.deepEqual([t1.network_product_id, Number(t1.price_kopecks), b1.network_product_id, b1.is_alcohol], [tea, 15000, beer, true], club);
      // QR-меню гостя: без алкоголя (№76, CLAUDE.md); персонал видит всё.
      const guest = await t.request('GET', `/api/clubs/${club}/menu`);
      assert.equal(guest.status, 200);
      const names = JSON.stringify(guest.json);
      assert.ok(names.includes('Чай') && !names.includes('Пиво'), club);
    }
    const staff = await api('GET', `/api/clubs/${CLUB_A}/menu`, 'owner');
    assert.ok(JSON.stringify(staff.json).includes('Пиво'));
    for (const club of [CLUB_A, CLUB_K]) {
      const [m] = await audit(club, 'manual.network_menu_change');
      assert.deepEqual([m.reason, m.data.created, m.data.version], ['Единое меню', 2, 1], club);
      const [alarm] = await alarmsFor(club, 'manual.network_menu_change');
      assert.ok((await notesFor(alarm.id)).some((n) => n.user_id === OWNER_A));
    }
    assert.equal((await audit(CLUB_T, 'network.menu_applied'))[0].data.created, 2);
  });

  it('мягкий: клуб меняет цену — переопределение, шаблон её не трогает; алкоголь шаблона клуб не снимает', async () => {
    const tA = await product(CLUB_A, 'Чай');
    const p = await api('PATCH', `/api/catalog/products/${tA.id}`, 'manager', { price_kopecks: 16000 });
    assert.equal(p.status, 200, p.text);
    assert.deepEqual([p.json.price_kopecks, p.json.network_override, p.json.network_product_id], [16000, true, tea]);
    const bA = await product(CLUB_A, 'Пиво');
    const alc = await api('PATCH', `/api/catalog/products/${bA.id}`, 'manager', { is_alcohol: false });
    assert.deepEqual([alc.status, alc.json.error], [409, 'network_locked']);
    // Стоп-лист — всегда клубу.
    assert.equal((await api('POST', `/api/catalog/products/${bA.id}/stop-list`, 'reception', { stop_list: true })).status, 200);
    const v2 = await api('PUT', `/api/networks/${net}/menu`, 'owner', { products: tpl({ tea: 17000 }), reason: 'Новая цена чая' });
    assert.equal(v2.status, 200, v2.text);
    assert.equal(Number((await product(CLUB_A, 'Чай')).price_kopecks), 16000, 'переопределённый товар не меняется');
    assert.equal(Number((await product(CLUB_K, 'Чай')).price_kopecks), 17000);
    assert.equal((await product(CLUB_A, 'Пиво')).stop_list, true, 'стоп-лист клуба шаблон не трогает');
    const mA = (await audit(CLUB_A, 'network.menu_template')).at(-1);
    assert.deepEqual([mA.data.skipped_override, mA.data.updated], [1, 0]);
    const st = await api('GET', `/api/clubs/${CLUB_A}/network`, 'manager');
    assert.equal(st.json.network.menu.overrides, 1);
  });

  it('жёсткий: переопределения возвращаются к шаблону; клуб не меняет товар шаблона (и импортом); убранный товар снят', async () => {
    const hard = await api('PATCH', `/api/networks/${net}`, 'owner', { menu_mode: 'hard', reason: 'Единое меню без исключений' });
    assert.equal(hard.status, 200, hard.text);
    const tA = await product(CLUB_A, 'Чай');
    assert.deepEqual([Number(tA.price_kopecks), tA.network_override], [17000, false]);
    const [m] = (await audit(CLUB_A, 'manual.network_menu_change')).slice(-1);
    assert.equal(m.reason, 'Единое меню без исключений');
    const p = await api('PATCH', `/api/catalog/products/${tA.id}`, 'owner', { price_kopecks: 18000 });
    assert.deepEqual([p.status, p.json.error], [409, 'network_locked']);
    // Поля клуба (порядок) у товара шаблона и свои товары клуба — можно.
    assert.equal((await api('PATCH', `/api/catalog/products/${tA.id}`, 'owner', { sort: 5 })).status, 200);
    const own = await api('POST', `/api/clubs/${CLUB_A}/catalog/products`, 'manager', { name: 'Сэндвич', price_kopecks: 30000 });
    assert.equal(own.status, 201, own.text);
    const csv = 'категория;название;цена;артикул\nНапитки;Чай;190;TEA-1\nЗакуски сети;Сухарики;150;RUSK-1\n';
    const preview = await api('POST', `/api/clubs/${CLUB_A}/catalog/import`, 'owner', { csv, dry_run: true });
    assert.deepEqual([preview.json.applied, preview.json.errors.map((e) => [e.line, e.code])], [false, [[2, 'network_template']]]);
    const imp = await api('POST', `/api/clubs/${CLUB_A}/catalog/import`, 'owner', { csv });
    assert.equal(imp.status, 200, imp.text);
    assert.deepEqual([imp.json.applied, imp.json.errors[0]?.code], [false, 'network_template']);
    assert.equal((await t.admin.query("select count(*)::int as n from bl.product_categories where club_id = $1 and name = 'Закуски сети'", [CLUB_A])).rows[0].n, 0, 'импорт целиком не применён');
    // Убрать «Пиво» из шаблона — в клубах снимается с продажи.
    const v3 = await api('PUT', `/api/networks/${net}/menu`, 'owner', { products: tpl({ tea: 17000 }).filter((x) => x.name !== 'Пиво'), reason: 'Без пива' });
    assert.equal(v3.status, 200, v3.text);
    for (const club of [CLUB_A, CLUB_K, CLUB_T]) assert.equal((await product(club, 'Пиво')).active, false, club);
    assert.equal((await product(CLUB_A, 'Сэндвич')).active, true);
  });
});

describe('T42. Управляющий сети (№192)', { skip: SKIP }, () => {
  it('приглашение по телефону, привязка при входе: управляющий во всех клубах сети; журнал в каждом клубе', async () => {
    const r = await api('POST', `/api/networks/${net}/managers`, 'owner', { phone: NM_PHONE });
    assert.equal(r.status, 201, r.text);
    memberId = r.json.id;
    assert.ok(r.json.phone_masked.includes('***'));
    assert.match(r.json.invite_text, /управляющим сети клубов «Сеть Урал»/);
    assert.ok(!r.json.invite_text.includes(NM_PHONE.slice(2)), 'телефона в тексте нет');
    assert.equal((await api('POST', `/api/networks/${net}/managers`, 'manager', { phone: NM_PHONE })).status, 404);
    assert.equal((await api('POST', `/api/networks/${net}/managers`, 'owner', { phone: '+70000000001' })).status, 409, 'себя — нет');
    const login = await t.login(NM_PHONE);
    tok.nm = login.token;
    nmUser = login.user.id;
    const me = await api('GET', '/api/me', 'nm');
    assert.deepEqual(me.json.networks.map((n) => [n.network_id, n.role]), [[net, 'manager']]);
    assert.deepEqual(me.json.clubs.map((c) => [c.club_id, c.role, c.network_id]).sort(), [[CLUB_A, 'manager', net], [CLUB_K, 'manager', net], [CLUB_T, 'manager', net]].sort());
    for (const club of [CLUB_A, CLUB_K, CLUB_T]) assert.equal((await audit(club, 'network.manager_added')).length, 1, club);
    const list = await api('GET', `/api/networks/${net}/managers`, 'owner');
    assert.deepEqual(list.json.items.map((x) => [x.id, x.status, x.user_id]), [[memberId, 'active', nmUser]]);
    assert.equal((await api('GET', `/api/networks/${net}/managers`, 'nm')).status, 403);
    const n = await api('GET', `/api/networks/${net}`, 'nm');
    assert.deepEqual([n.status, n.json.role, n.json.clubs.length], [200, 'manager', 3]);
  });

  it('управляет клубами сети как управляющий; шаблоны и состав сети — нет', async () => {
    assert.equal((await api('GET', `/api/clubs/${CLUB_K}/resources`, 'nm')).status, 200);
    const add = await api('POST', `/api/clubs/${CLUB_K}/resources`, 'nm', { number: 3, kind: 'pool', reason: 'Новый стол' });
    assert.equal(add.status, 201, add.text);
    assert.equal((await api('GET', `/api/clubs/${CLUB_A}/catalog`, 'nm')).status, 200);
    assert.equal((await api('GET', `/api/clubs/${CLUB_A}/staff`, 'nm')).status, 403, 'персонал — владелец');
    assert.equal((await api('GET', `/api/networks/${net}/tariffs`, 'nm')).status, 200);
    assert.equal((await api('PUT', `/api/networks/${net}/tariffs`, 'nm', { rules: applyTemplate('single', { price: 1000 }), reason: 'x' })).status, 403);
    assert.equal((await api('PUT', `/api/networks/${net}/menu`, 'nm', { products: [], reason: 'x' })).status, 403);
    assert.equal((await api('POST', `/api/networks/${net}/clubs`, 'nm', { club_id: CLUB_B })).status, 403);
    assert.equal((await api('PATCH', `/api/networks/${net}`, 'nm', { name: 'Моя сеть' })).status, 403);
  });

  it('экспорт и деньги по способам оплаты — 403; в статусе зала — без способов', async () => {
    assert.equal((await api('GET', `/api/clubs/${CLUB_A}/dashboard`, 'nm')).status, 200);
    assert.equal((await api('GET', `/api/clubs/${CLUB_A}/dashboard?tab=hall`, 'nm')).status, 200);
    assert.equal((await api('GET', `/api/clubs/${CLUB_A}/dashboard?tab=money`, 'nm')).status, 403);
    assert.equal((await api('GET', `/api/clubs/${CLUB_A}/dashboard?tab=money`, 'manager')).status, 200, 'управляющий клуба — как раньше');
    assert.equal((await api('GET', '/api/clubs/all/dashboard?tab=money', 'nm')).status, 403);
    const all = await api('GET', '/api/clubs/all/dashboard', 'nm');
    assert.equal(all.status, 200);
    assert.equal(all.json.tables.clubs.length, 3);
    const now = await api('GET', `/api/clubs/${CLUB_A}/dashboard/now`, 'nm');
    assert.equal(now.status, 200);
    assert.equal(now.json.revenue_today.by_method, null);
    const ownerNow = await api('GET', `/api/clubs/${CLUB_A}/dashboard/now`, 'owner');
    assert.ok(ownerNow.json.revenue_today.by_method, 'владельцу — со способами (кэш не общий)');
    for (const path of [
      `/api/clubs/${CLUB_A}/dashboard/export.csv?table=revenue_daily`,
      '/api/clubs/all/dashboard/export.csv?table=revenue_daily',
      `/api/clubs/${CLUB_A}/history/orders/export.csv`,
      '/api/clubs/all/history/orders/export.csv',
      `/api/clubs/${CLUB_A}/shifts/export.csv`,
      `/api/clubs/${CLUB_A}/cashbook/export.csv`,
    ]) {
      assert.equal((await api('GET', path, 'nm')).status, 403, path);
    }
    assert.equal((await api('GET', `/api/clubs/${CLUB_A}/history/orders/export.csv`, 'manager')).status, 200, 'управляющему клуба экспорт историй — как раньше');
    assert.equal((await api('GET', `/api/clubs/${CLUB_A}/history/orders`, 'nm')).status, 200);
  });

  it('клуб не меняет и не отзывает управляющего сети; app_api не выдаёт такой доступ сам', async () => {
    const role = await api('PATCH', `/api/clubs/${CLUB_A}/staff/${nmUser}`, 'owner', { role: 'reception' });
    assert.deepEqual([role.status, role.json.error], [409, 'network_locked']);
    assert.equal((await api('DELETE', `/api/clubs/${CLUB_A}/staff/${nmUser}`, 'owner')).status, 409);
    const staff = await api('GET', `/api/clubs/${CLUB_A}/staff`, 'owner');
    assert.equal(staff.json.staff.find((s) => s.user_id === nmUser).network_id, net);
    await asApp({ clubId: CLUB_A, userId: OWNER_A }, async (c) => {
      assert.equal((await tryQuery(c, 'update bl.club_members set active = false where user_id = $1', [nmUser]))?.code, 'BLN10');
      assert.equal((await tryQuery(c, 'update bl.club_members set network_id = $2 where user_id = $1', [RECEPTION_A, net]))?.code, 'BLN10');
      assert.equal((await tryQuery(c, "insert into bl.club_members (club_id, user_id, role, network_id) values ($1, $2, 'manager', $3)", [CLUB_A, OWNER_B, net]))?.code, 'BLN10');
      // PIN своей строки — можно (не роль и не активность).
      assert.equal(await tryQuery(c, 'update bl.club_members set pin_failed_count = 1 where user_id = $1', [nmUser]), null);
    });
  });
});

describe('T42. Вкладка «Сеть»: сравнение и рейтинг (№193)', { skip: SKIP }, () => {
  before(async () => {
    if (SKIP) return;
    // Клубы и столы работают 10 дней (ёмкость периода). Игра и оплата 2 часа назад: 100 000 в A
    // (8 столов), 60 000 в K (3 стола), 777 700 в тестовом T (is_test).
    await t.admin.query("update bl.clubs set created_at = now() - interval '10 days' where id = any($1)", [[CLUB_A, CLUB_K, CLUB_T]]);
    await t.admin.query("update bl.resources set created_at = now() - interval '10 days' where club_id = any($1)", [[CLUB_A, CLUB_K, CLUB_T]]);
    const at = new Date(Date.now() - 2 * 3600_000);
    const to = new Date(at.getTime() + 3600_000);
    for (const [club, res, amount] of [[CLUB_A, A_PYR, 100000], [CLUB_K, K1, 60000], [CLUB_T, T1, 777700]]) {
      const sid = randomUUID();
      const pid = randomUUID();
      await t.admin.query(
        `insert into bl.sessions (id, club_id, resource_id, status, source, payer_user_id, started_at, paid_until, ended_at, close_reason, created_at, updated_at)
         values ($1, $2, $3, 'closed', 'qr', $4, $5, $6, $6, 'expired', $5, $6)`,
        [sid, club, res, OWNER_B, at, to],
      );
      await t.admin.query(
        `insert into bl.payments (id, club_id, resource_id, user_id, session_id, kind, provider, method, idempotence_key, status, amount_kopecks, capture, minutes,
                                  confirmed_at, created_at, updated_at, provider_payment_id)
         values ($1, $2, $3, $4, $5, 'start', 'yookassa', 'sbp', $6, 'succeeded', $7, true, 60, $8, $8, $8, $9)`,
        [pid, club, res, OWNER_B, sid, `idem-${pid}`, amount, at, `yk-${pid}`],
      );
    }
  });

  it('клубы сети по плиткам (как дашборд клуба), рейтинг по загрузке и выручке со стола; тестовый клуб — без рейтинга', async () => {
    // Период — с позавчера по завтра (UTC): сутки каждого клуба по его поясу целиком внутри.
    const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const period = `from=${day(-2)}&to=${day(1)}&compare=0`;
    for (const who of ['owner', 'nm']) {
      const r = await api('GET', `/api/networks/${net}/dashboard?${period}`, who);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.clubs.length, 3);
      const text = JSON.stringify(r.json);
      assert.ok(!text.includes('by_method') && !text.includes('methods') && !text.includes('cash_net'), 'без денег по способам оплаты');
      const row = (id) => r.json.clubs.find((c) => c.club_id === id);
      const tile = (id, tileId) => row(id).tiles.find((x) => x.id === tileId).value;
      assert.equal(tile(CLUB_A, 'revenue'), 100000);
      assert.equal(tile(CLUB_K, 'revenue'), 60000);
      assert.equal(tile(CLUB_T, 'revenue'), 0, 'тестовые деньги не входят');
      assert.deepEqual([row(CLUB_A).ranked, row(CLUB_K).ranked, row(CLUB_T).ranked], [true, true, false]);
      // Выручка со стола: K (60 000 / 3 стола) выше A (100 000 / 8 столов).
      assert.deepEqual(r.json.ranking.revenue_per_table.map((x) => x.club_id), [CLUB_K, CLUB_A]);
      assert.deepEqual([row(CLUB_K).place_revenue_per_table, row(CLUB_A).place_revenue_per_table, row(CLUB_T).place_revenue_per_table], [1, 2, null]);
      assert.equal(r.json.ranking.utilization.length, 2);
      assert.equal(r.json.totals.tiles.find((x) => x.id === 'revenue').value, 160000);
      // Совпадает с дашбордом клуба (те же агрегаты и сутки клуба).
      const dash = await api('GET', `/api/clubs/${CLUB_K}/dashboard?${period}`, who);
      assert.equal(dash.json.tiles.find((x) => x.id === 'revenue').value, tile(CLUB_K, 'revenue'));
      assert.equal(dash.json.tiles.find((x) => x.id === 'utilization').value, tile(CLUB_K, 'utilization'));
      assert.equal(row(CLUB_K).timezone, 'Europe/Kaliningrad');
    }
    assert.equal((await api('GET', `/api/networks/${net}/dashboard?from=2026-01-01&to=2027-12-31`, 'owner')).status, 400);
  });

  it('изоляция чужой сети: владелец и управляющий другой сети не видят ни сеть, ни сравнение, ни клубы', async () => {
    for (const path of [`/api/networks/${net}`, `/api/networks/${net}/dashboard`, `/api/networks/${net}/tariffs`, `/api/networks/${net}/menu`]) {
      assert.equal((await api('GET', path, 'ownerB')).status, 404, path);
    }
    for (const path of [`/api/networks/${netB}`, `/api/networks/${netB}/dashboard`]) assert.equal((await api('GET', path, 'nm')).status, 404, path);
    assert.equal((await api('GET', `/api/clubs/${CLUB_B}/dashboard`, 'nm')).status, 403);
    assert.equal((await api('GET', `/api/clubs/${CLUB_A}/network`, 'ownerB')).status, 403);
    const b = await api('GET', `/api/networks/${netB}/dashboard`, 'ownerB');
    assert.deepEqual(b.json.clubs.map((c) => c.club_id), [CLUB_B]);
    const mine = await api('GET', '/api/networks', 'ownerB');
    assert.deepEqual(mine.json.items.map((x) => x.network_id), [netB]);
  });
});

describe('RLS таблиц сети', { skip: SKIP }, () => {
  it('личный контекст: только своя сеть; контекст клуба: только свой клуб и его сеть; без контекста — ничего', async () => {
    const tables = ['networks', 'network_clubs', 'network_members', 'network_tariff_rules', 'network_products'];
    const count = async (c, table, where = 'true', params = []) => (await c.query(`select count(*)::int as n from bl.${table} where ${where}`, params)).rows[0].n;
    await asApp({ userId: OWNER_B }, async (c) => {
      for (const table of tables.slice(1)) assert.equal(await count(c, table, 'network_id = $1', [net]), 0, table);
      assert.equal(await count(c, 'networks', 'id = $1', [net]), 0);
      assert.equal(await count(c, 'networks', 'id = $1', [netB]), 1);
      // Чужой шаблон и чужую сеть не записать.
      assert.equal((await tryQuery(c, "insert into bl.network_products (network_id, name, price_kopecks, updated_by) values ($1, 'X', 100, $2)", [net, OWNER_B]))?.code, '42501');
      assert.equal((await c.query('update bl.network_products set price_kopecks = 1 where network_id = $1', [net])).rowCount, 0);
      assert.equal((await c.query('update bl.networks set name = $2 where id = $1', [net, 'Взлом'])).rowCount, 0);
    });
    await asApp({ userId: nmUser }, async (c) => {
      assert.equal(await count(c, 'networks', 'id = $1', [net]), 1, 'управляющий видит свою сеть');
      assert.equal(await count(c, 'network_members', 'network_id = $1', [net]), 1, 'только свою строку');
      assert.equal((await c.query('update bl.networks set name = $2 where id = $1', [net, 'Моя'])).rowCount, 0, 'менять — только владелец');
      assert.equal(
        (await tryQuery(c, `insert into bl.network_tariff_rules (network_id, version, ord, rule, price_per_hour, created_by) values ($1, 9, 0, '{"price_per_hour_kopecks": 100}', 100, $2)`, [net, nmUser]))?.code,
        '42501',
      );
    });
    await asApp({ clubId: CLUB_B, userId: OWNER_B }, async (c) => {
      assert.equal(await count(c, 'network_clubs'), 1, 'только строка своего клуба');
      assert.equal(await count(c, 'network_clubs', 'club_id = $1', [CLUB_A]), 0);
      assert.equal(await count(c, 'networks', 'id = $1', [net]), 0);
      assert.equal(await count(c, 'network_products', 'network_id = $1', [net]), 0);
      assert.equal(await count(c, 'network_members'), 0);
      assert.equal((await c.query('update bl.network_clubs set tariffs_override = true where club_id = $1', [CLUB_A])).rowCount, 0);
    });
    await asApp({ clubId: CLUB_A, userId: OWNER_A }, async (c) => {
      assert.equal(await count(c, 'network_clubs'), 1);
      assert.equal(await count(c, 'networks', 'id = $1', [net]), 1);
      assert.ok((await count(c, 'network_products', 'network_id = $1', [net])) > 0, 'клуб сети читает шаблон');
      assert.equal(await count(c, 'network_members'), 0, 'телефоны управляющих клубу не видны');
    });
    await asApp({ actorType: 'system' }, async (c) => {
      for (const table of tables) assert.equal(await count(c, table), 0, table);
    });
    const rls = (await t.admin.query("select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace = 'bl'::regnamespace and relname = any($1)", [tables])).rows;
    assert.equal(rls.length, tables.length);
    for (const r of rls) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity], [true, true], r.relname);
  });

  it('вывод клуба из сети и отзыв управляющего снимают доступ сразу', async () => {
    const out = await api('DELETE', `/api/networks/${net}/clubs/${CLUB_K}`, 'owner');
    assert.equal(out.status, 200, out.text);
    assert.equal((await api('GET', `/api/clubs/${CLUB_K}/dashboard`, 'nm')).status, 403);
    assert.equal((await api('GET', `/api/clubs/${CLUB_A}/dashboard`, 'nm')).status, 200);
    assert.ok((await rulesOf(CLUB_K)).length > 0, 'тарифы клуба остаются');
    assert.equal((await api('GET', `/api/clubs/${CLUB_K}/network`, 'owner')).json.network, null);
    assert.equal((await audit(CLUB_K, 'network.club_removed')).length, 1);
    // Клуб вне сети снова ведёт тарифы сам.
    assert.equal((await api('PUT', `/api/clubs/${CLUB_K}/tariffs`, 'owner', { rules: applyTemplate('single', { price: 41000 }), reason: 'Сам по себе' })).status, 200);
    const rv = await api('DELETE', `/api/networks/${net}/managers/${memberId}`, 'owner');
    assert.equal(rv.status, 200, rv.text);
    assert.equal((await api('GET', `/api/clubs/${CLUB_A}/dashboard`, 'nm')).status, 403);
    assert.equal((await api('GET', `/api/networks/${net}`, 'nm')).status, 404);
    const me = await api('GET', '/api/me', 'nm');
    assert.deepEqual([me.json.clubs, me.json.networks], [[], []]);
    assert.equal((await audit(CLUB_A, 'network.manager_revoked')).length, 1);
  });
});
