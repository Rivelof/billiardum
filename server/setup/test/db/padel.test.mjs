// Падел-корт в мастере зала и тарифов на временной базе (M5.8 №203–204, T47–T48): корт — вид ресурса
// padel_court со своей нумерацией и названием «Корт N», тариф по слотам (длина слота — настройка клуба
// в мастере тарифов), неделя корта проверяется отдельно, live — ручное действие, изоляция клубов.
// Клуб сида: столы 1–8 и корты 1–2 (seed.d/1300_padel.sql).

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { loadRoutes } from '../../../../api/router.mjs';
import { withContext } from '../../../lib/store.mjs';
import { amountFor } from '../../../tariffs/index.mjs';
import { CLUB_A, OWNER_A, startTestApp } from '../../../test/db/helpers.mjs';
import { applyTemplate } from '../../tariffs.mjs';
import { weekCoverage } from '../../index.mjs';

const SKIP = !process.env.DATABASE_ADMIN_URL;
const CLUB_X = 'c7000000-0000-4000-8000-000000000008';
const OWNER_X = 'a7000000-0000-4000-8000-000000000008';
const COURT_1 = 'e1000000-0000-4000-8000-000000000101';

let t;
let owner;
let manager;
let ownerX;

before(async () => {
  if (SKIP) return;
  const routes = await loadRoutes({ config: { publicHost: 'bl.test' }, only: ['auth.mjs', 'setup.mjs'] });
  t = await startTestApp({ routes, notifyWorker: false });
  await t.admin.query(`
    insert into bl.users (id, phone) values ('${OWNER_X}', '+70000000778');
    insert into bl.clubs (id, name, city, timezone) values ('${CLUB_X}', 'Клуб Икс', 'Пермь', 'Asia/Yekaterinburg');
    insert into bl.club_members (club_id, user_id, role) values ('${CLUB_X}', '${OWNER_X}', 'owner');
  `);
  owner = await t.login('+70000000001');
  manager = await t.login('+70000000003');
  ownerX = await t.login('+70000000778');
});

after(async () => {
  await t?.stop();
});

const api = (method, path, token, body) => t.request(method, path, { token, body });
const audit = async (action) => (await t.admin.query('select * from bl.audit_log where club_id = $1 and action = $2 order by seq', [CLUB_A, action])).rows;
const setMode = (mode) => t.admin.query('update bl.clubs set mode = $2, mode_before_suspend = null where id = $1', [CLUB_A, mode]);
const ALL = [1, 2, 3, 4, 5, 6, 7];
/** Полная неделя клуба: столы — одна цена, корт — будни день/вечер и выходные (слот 90). */
const fullWeek = ({ slot = 90, day = 240000 } = {}) => [
  ...applyTemplate('single', { price: 50000 }),
  { kind: 'padel_court', days: [1, 2, 3, 4, 5], from: '06:00', to: '17:00', slot_minutes: slot, price_per_slot_kopecks: day },
  { kind: 'padel_court', days: [1, 2, 3, 4, 5], from: '17:00', to: '06:00', slot_minutes: slot, price_per_slot_kopecks: 360000 },
  { kind: 'padel_court', days: [6, 7], from: '06:00', to: '06:00', slot_minutes: slot, price_per_slot_kopecks: 390000 },
];

describe('корт в зале (№203)', { skip: SKIP }, () => {
  it('справочник видов — без входа: слова «корт/корта/кортов»', async () => {
    const r = await t.request('GET', '/api/resource-kinds');
    assert.equal(r.status, 200);
    const court = r.json.kinds.find((k) => k.kind === 'padel_court');
    assert.deepEqual([court.family, court.billing, court.max_players, court.noun.one, court.noun.few, court.noun.many], ['court', 'slot', 4, 'корт', 'корта', 'кортов']);
    assert.deepEqual(r.json.slot_minutes, [60, 90, 120]);
  });

  it('список зала: столы и корты сида, у каждого kind и family', async () => {
    const list = await api('GET', `/api/clubs/${CLUB_A}/resources`, manager.token);
    assert.equal(list.status, 200);
    const courts = list.json.resources.filter((r) => r.family === 'court');
    assert.deepEqual(courts.map((r) => [r.number, r.kind, r.title]), [[1, 'padel_court', 'Корт 1'], [2, 'padel_court', 'Корт 2']]);
    assert.equal(list.json.resources.filter((r) => r.family === 'table').length, 8);
  });

  it('новый корт: своя нумерация (корт 3 рядом со столом 3), название «Корт 3», дубль номера корта — 409; стол ↔ корт — 400', async () => {
    await setMode('test');
    const r = await api('POST', `/api/clubs/${CLUB_A}/resources`, owner.token, { number: 3, kind: 'padel_court', plan_x: 2000, plan_y: 300 });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual([r.json.kind, r.json.type, r.json.family, r.json.title], ['padel_court', 'padel_court', 'court', 'Корт 3']);
    assert.equal((await audit('resource.create')).at(-1).data.kind, 'padel_court');
    assert.deepEqual(await api('POST', `/api/clubs/${CLUB_A}/resources`, owner.token, { number: 3, kind: 'padel_court' }).then((x) => [x.status, x.json]), [409, { error: 'duplicate' }]);
    const toTable = await api('PATCH', `/api/clubs/${CLUB_A}/resources/${r.json.id}`, owner.token, { kind: 'pool' });
    assert.deepEqual([toTable.status, toTable.json], [400, { error: 'bad_request' }]);
    // Номер корта 1 занят кортом, а не столом 1: стол 1 можно переименовать, корт 3 → 1 — нет.
    assert.equal((await api('PATCH', `/api/clubs/${CLUB_A}/resources/${r.json.id}`, owner.token, { number: 1 })).status, 409);
    // Чужой владелец не видит корт клуба A.
    assert.equal((await api('PATCH', `/api/clubs/${CLUB_X}/resources/${r.json.id}`, ownerX.token, { plan_x: 1 })).status, 404);
    assert.equal((await api('GET', `/api/clubs/${CLUB_A}/resources`, ownerX.token)).status, 403);
    // Вывести из работы — тариф корта не нужен.
    assert.equal((await api('PATCH', `/api/clubs/${CLUB_A}/resources/${r.json.id}`, owner.token, { active: false })).status, 200);
  });
});

describe('тариф корта по слотам (№204)', { skip: SKIP }, () => {
  it('без правил корта неделя не покрыта; правило «все типы» корт не покрывает — 400 tariff_gap с kind padel_court', async () => {
    const r = await api('PUT', `/api/clubs/${CLUB_A}/tariffs`, owner.token, { rules: applyTemplate('single', { price: 50000 }) });
    assert.deepEqual([r.status, r.json], [400, { error: 'tariff_gap', kind: 'padel_court', weekday: 1, from: '06:00', to: '06:00' }]);
  });

  it('сохранение: столы почасово, корт — слоты 90 минут; GET отдаёт slots и правила с ценой слота; движок считает по слоту', async () => {
    const r = await api('PUT', `/api/clubs/${CLUB_A}/tariffs`, manager.token, { rules: fullWeek() });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.slots, { padel_court: 90 });
    assert.equal(r.json.coverage.ok, true);
    const court = r.json.rules.filter((x) => x.kind === 'padel_court');
    assert.equal(court.length, 3);
    assert.deepEqual(
      court.map((x) => [x.from, x.to, x.slot_minutes, x.price_per_slot_kopecks, x.min_minutes, x.step_minutes]),
      [['06:00', '17:00', 90, 240000, 90, 90], ['17:00', '06:00', 90, 360000, 90, 90], ['06:00', '06:00', 90, 390000, 90, 90]],
    );
    assert.ok(r.json.rules.some((x) => x.kind === null && x.price_per_hour_kopecks === 50000), 'столы — одно правило «все типы»');
    const [a] = await audit('tariff.update').then((x) => x.slice(-1));
    assert.ok(a.data.after.some((x) => x.kind === 'padel_court' && x.slot === 90 && x.slot_price === 240000));
    const cov = await withContext(t.pool, { clubId: CLUB_A, actorType: 'system' }, (db) => weekCoverage(db, CLUB_A));
    assert.equal(cov.ok, true);
    // Вторник 27.10.2026 16:30 местного (11:30Z): 30 минут дня + 60 минут вечера.
    const q = await withContext(t.pool, { clubId: CLUB_A, actorType: 'system' }, (db) => amountFor(db, { resourceId: COURT_1, from: new Date('2026-10-27T11:30:00Z'), minutes: 90 }));
    assert.equal(q.amount_kopecks, 80000 + 240000);
  });

  it('разная длина слота у корта — 400; почасовые поля у корта — 400; ничего не меняется', async () => {
    const mixed = fullWeek();
    mixed[mixed.length - 1] = { ...mixed[mixed.length - 1], slot_minutes: 60 };
    assert.deepEqual(await api('PUT', `/api/clubs/${CLUB_A}/tariffs`, owner.token, { rules: mixed }).then((x) => [x.status, x.json]), [400, { error: 'bad_request' }]);
    const hourlyCourt = [...applyTemplate('single', { price: 50000 }), { kind: 'padel_court', days: ALL, from: '06:00', to: '06:00', price_per_hour_kopecks: 100000, min_minutes: 60, step_minutes: 1 }];
    assert.equal((await api('PUT', `/api/clubs/${CLUB_A}/tariffs`, owner.token, { rules: hourlyCourt })).status, 400);
    const g = await api('GET', `/api/clubs/${CLUB_A}/tariffs`, owner.token);
    assert.deepEqual(g.json.slots, { padel_court: 90 });
  });

  it('live: смена длины слота (настройка клуба) — изменение тарифа с причиной и тревогой владельцу', async () => {
    await setMode('live');
    try {
      assert.deepEqual(await api('PUT', `/api/clubs/${CLUB_A}/tariffs`, owner.token, { rules: fullWeek({ slot: 60, day: 160000 }) }).then((x) => [x.status, x.json]), [400, { error: 'reason_required' }]);
      const r = await api('PUT', `/api/clubs/${CLUB_A}/tariffs`, owner.token, { rules: fullWeek({ slot: 60, day: 160000 }), reason: 'Слоты по часу' });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json.slots, { padel_court: 60 });
      const [m] = (await audit('manual.tariff_change')).slice(-1);
      assert.equal(m.reason, 'Слоты по часу');
      assert.equal(m.actor_id, OWNER_A);
      assert.ok(m.data.before.some((x) => x.kind === 'padel_court' && x.slot === 90));
      assert.ok(m.data.after.some((x) => x.kind === 'padel_court' && x.slot === 60));
      const alarms = (await t.admin.query("select id from bl.alarms where club_id = $1 and type = 'manual_action' and data->>'action' = 'manual.tariff_change'", [CLUB_A])).rows;
      assert.ok(alarms.length >= 1);
    } finally {
      await setMode('test');
    }
  });
});
