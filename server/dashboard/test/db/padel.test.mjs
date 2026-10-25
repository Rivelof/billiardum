// T47 на уровне сервера (M5.8): клуб со столами и кортами — отчёт смены и дашборд в разрезе видов
// ресурсов. Отчёт смены: play.by_type (пирамида, падел-корт…) и play.by_family (столы, корты), строка
// «Столы — …; корты — …» в тексте владельцу. Дашборд: kind — тип (padel_court) или семья (court, table),
// разрез by_type с кортом. Сумма видов = итог (те же данные, №168).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { CORE_ROUTE_FILES, startTestApp } from '../../../test/db/helpers.mjs';
import { loadRoutes } from '../../../../api/router.mjs';
import { cache } from '../../../../api/routes/dashboard.mjs';
import { buildShiftReport, reportText } from '../../../reports/shift-report.mjs';
import { withContext } from '../../../lib/store.mjs';

const CLUB = 'c1000000-0000-4000-8000-000000000001';
const RECEPTION = 'a1000000-0000-4000-8000-000000000004';
const GUEST = 'a9000000-0000-4000-8000-0000000000c1';
const TABLE_1 = 'e1000000-0000-4000-8000-000000000001';
const COURT_1 = 'e1000000-0000-4000-8000-000000000101';
// Вторник 27.10.2026, 17:00 в Екатеринбурге.
const NOW = new Date('2026-10-27T12:00:00.000Z');
const DAY = '2026-10-27';
const clock = { now: () => new Date(NOW) };

let t;
let owner;
let shiftId;

async function game(admin, { resource, from, to, amount, minutes }) {
  const sid = randomUUID();
  await admin.query(
    `insert into bl.sessions (id, club_id, resource_id, status, source, payer_user_id, unlimited, started_at, paid_until, ended_at, close_reason, created_at, updated_at)
     values ($1, $2, $3, 'closed', 'qr', $4, false, $5, $6, $6, 'expired', $5, $6)`,
    [sid, CLUB, resource, GUEST, from, to],
  );
  await admin.query(
    `insert into bl.payments (id, club_id, resource_id, user_id, session_id, kind, provider, method, provider_payment_id, idempotence_key,
                              status, amount_kopecks, capture, minutes, unlimited, confirmed_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'start', 'yookassa', 'sbp', $6, $7, 'succeeded', $8, true, $9, false, $10, $10, $10)`,
    [randomUUID(), CLUB, resource, GUEST, sid, `yk-${randomUUID()}`, `idem-${randomUUID()}`, amount, minutes, from],
  );
}

before(async () => {
  t = await startTestApp({ routes: await loadRoutes({ only: [...CORE_ROUTE_FILES, 'dashboard.mjs'] }), clock });
  await t.admin.query("update bl.clubs set mode = 'live', created_at = '2026-10-01T00:00:00Z' where id = $1", [CLUB]);
  await t.admin.query("update bl.resources set created_at = '2026-10-01T00:00:00Z' where club_id = $1", [CLUB]);
  await t.admin.query("insert into bl.users (id, phone) values ($1, '+79990000701')", [GUEST]);
  // Смена с 12:00 местного; корт 13:00–14:30 (слот, 2 400 ₽), стол 1 14:00–15:00 (500 ₽).
  const { rows } = await t.admin.query(
    `insert into bl.shifts (club_id, number, opened_by, opened_at, float_kopecks) values ($1, 1, $2, '2026-10-27T07:00:00Z', 0) returning id`,
    [CLUB, RECEPTION],
  );
  shiftId = rows[0].id;
  await game(t.admin, { resource: COURT_1, from: new Date('2026-10-27T08:00:00Z'), to: new Date('2026-10-27T09:30:00Z'), amount: 240000, minutes: 90 });
  await game(t.admin, { resource: TABLE_1, from: new Date('2026-10-27T09:00:00Z'), to: new Date('2026-10-27T10:00:00Z'), amount: 50000, minutes: 60 });
  owner = (await t.login('+70000000001')).token;
});

after(async () => {
  await t?.stop();
});

const get = async (path) => {
  cache.clear();
  return t.request('GET', path, { token: owner });
};
const tile = (json, id) => json.tiles.find((x) => x.id === id)?.value;

describe('T47: отчёт смены по видам ресурсов', () => {
  it('play.by_type и by_family: столы и корты отдельно, сумма = итог; в тексте — строка по семьям', async () => {
    const r = await withContext(t.pool, { clubId: CLUB, actorType: 'system' }, (db) => buildShiftReport(db, { shiftId, now: NOW, online: false }));
    const fam = Object.fromEntries(r.play.by_family.map((x) => [x.family, x]));
    assert.deepEqual([fam.court.sessions, fam.court.minutes, fam.court.revenue_kopecks, fam.court.resources], [1, 90, 240000, 2]);
    assert.deepEqual([fam.table.sessions, fam.table.minutes, fam.table.revenue_kopecks, fam.table.resources], [1, 60, 50000, 8]);
    assert.equal(fam.court.minutes + fam.table.minutes, r.play.minutes);
    const padel = r.play.by_type.find((x) => x.type === 'padel_court');
    assert.deepEqual([padel.kind, padel.family, padel.sessions, padel.revenue_kopecks], ['padel_court', 'court', 1, 240000]);
    const court = r.play.by_resource.find((x) => x.resource_id === COURT_1);
    assert.deepEqual([court.type, court.family, court.number, court.minutes], ['padel_court', 'court', 1, 90]);
    // Столы раньше кортов в разбивке по ресурсам.
    const families = r.play.by_resource.map((x) => x.family);
    assert.ok(families.lastIndexOf('table') < families.indexOf('court'));
    assert.match(reportText(r), /Столы — 1 ч, .*; корты — 1,5 ч, .*2\s400\s₽\./u);
  });
});

describe('T47: дашборд по видам ресурсов', () => {
  it('kind: тип или семья — выручка и игры своего вида; без фильтра — сумма', async () => {
    const all = await get(`/api/clubs/${CLUB}/dashboard?from=${DAY}&to=${DAY}&tab=money`);
    assert.equal(all.status, 200, all.text);
    const court = await get(`/api/clubs/${CLUB}/dashboard?from=${DAY}&to=${DAY}&tab=money&kind=court`);
    const padel = await get(`/api/clubs/${CLUB}/dashboard?from=${DAY}&to=${DAY}&tab=money&kind=padel_court`);
    const tables = await get(`/api/clubs/${CLUB}/dashboard?from=${DAY}&to=${DAY}&tab=money&kind=table`);
    assert.equal(court.status, 200, court.text);
    assert.equal(tile(court.json, 'revenue'), 240000);
    assert.equal(tile(padel.json, 'revenue'), 240000);
    assert.equal(tile(tables.json, 'revenue'), 50000);
    assert.equal(tile(all.json, 'revenue'), 290000);
    assert.equal((await get(`/api/clubs/${CLUB}/dashboard?from=${DAY}&to=${DAY}&kind=tennis`)).status, 400);
  });

  it('вкладка зала: by_type с падел-кортом, by_resource корта — тип padel_court', async () => {
    const r = await get(`/api/clubs/${CLUB}/dashboard?from=${DAY}&to=${DAY}&tab=hall`);
    assert.equal(r.status, 200, r.text);
    const padel = r.json.tables.by_type.find((x) => x.type === 'padel_court');
    assert.ok(padel, JSON.stringify(r.json.tables.by_type.map((x) => x.type)));
    assert.deepEqual([padel.tables, padel.games, padel.play_minutes, padel.revenue_kopecks], [2, 1, 90, 240000]);
    // Приёмка M5.8: число ресурсов вида — resources (tables — прежнее имя), семья вида — family.
    assert.deepEqual([padel.resources, padel.family], [2, 'court']);
    assert.deepEqual(r.json.tables.by_type.filter((x) => x.family === 'table').map((x) => x.resources === x.tables), [true, true]);
    const c = r.json.tables.by_resource.find((x) => x.resource_id === COURT_1);
    assert.deepEqual([c.type, c.family, c.games, c.play_minutes], ['padel_court', 'court', 1, 90]);
    assert.ok(r.json.tables.by_resource.filter((x) => x.type !== 'padel_court').every((x) => x.family === 'table'));
    const onlyCourts = await get(`/api/clubs/${CLUB}/dashboard?from=${DAY}&to=${DAY}&tab=hall&kind=court`);
    assert.ok(onlyCourts.json.tables.by_resource.every((x) => x.type === 'padel_court'));
  });
});
