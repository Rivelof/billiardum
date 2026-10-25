// Доработки после M5.5 и M5.8 (пакет «мелких доработок сервера»):
//   Н1 — таблица «Столы» (вкладка «Зал») показывает все ресурсы клуба в работе, даже без ёмкости, игр и
//        выручки за период («Сегодня» до открытия клуба): не пропадают cloth_hours и cloth_due (№198);
//   п. 10 — resource_type рядом с resource_number у ручных действий в отчёте смены.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { CORE_ROUTE_FILES, startTestApp } from '../../../test/db/helpers.mjs';
import { loadRoutes } from '../../../../api/router.mjs';
import { cache } from '../../../../api/routes/dashboard.mjs';
import { appendAudit } from '../../../lib/audit.mjs';
import { withContext } from '../../../lib/store.mjs';
import { buildShiftReport } from '../../../reports/shift-report.mjs';
import { addDays, workingDayOf, zonedTime } from '../../time.mjs';

const CLUB = 'c1000000-0000-4000-8000-000000000001';
const OWNER = 'a1000000-0000-4000-8000-000000000001';
const G1 = 'a9000000-0000-4000-8000-0000000000a1';
const TZ = 'Asia/Yekaterinburg';
const T = (n) => `e1000000-0000-4000-8000-00000000000${n}`;
const COURT_1 = 'e1000000-0000-4000-8000-000000000101';
// Сегодня по рабочим суткам клуба, но до открытия (часы работы 10:00–02:00): 09:30 местного.
const TODAY = workingDayOf(new Date(), TZ, '06:00');
const NOW = zonedTime(TODAY, '09:30', TZ);
const clock = { now: () => new Date(NOW) };
const SKIP = !process.env.DATABASE_ADMIN_URL;

let t;
let owner;

before(async () => {
  if (SKIP) return;
  t = await startTestApp({ routes: await loadRoutes({ only: [...CORE_ROUTE_FILES, 'dashboard.mjs', 'maintenance.mjs'] }), clock });
  const start = zonedTime(addDays(TODAY, -30), '12:00', TZ);
  await t.admin.query(`update bl.clubs set mode = 'live', created_at = $2, settings = settings || '{"open_hours": {"open": "10:00", "close": "02:00"}}'::jsonb where id = $1`, [CLUB, start]);
  await t.admin.query('update bl.resources set created_at = $2 where club_id = $1', [CLUB, start]);
  // Стол 8 выведен из работы: без активности за период в таблице его нет.
  await t.admin.query('update bl.resources set active = false where id = $1', [T(8)]);
  await t.admin.query("insert into bl.users (id, phone) values ($1, '+79990000001')", [G1]);
  // Стол 1: 3 часа игры вчера — за порогом сукна 2 ч; остальные столы не играли.
  const from = zonedTime(addDays(TODAY, -1), '15:00', TZ);
  await t.admin.query(
    `insert into bl.sessions (id, club_id, resource_id, status, source, payer_user_id, started_at, paid_until, ended_at, close_reason, created_at, updated_at)
     values ($1, $2, $3, 'closed', 'qr', $4, $5, $6, $6, 'expired', $5, $6)`,
    [randomUUID(), CLUB, T(1), G1, from, new Date(from.getTime() + 3 * 3600_000)],
  );
  owner = (await t.login('+70000000001')).token;
  const put = await t.request('PUT', `/api/clubs/${CLUB}/maintenance/thresholds`, { token: owner, body: { cloth: 2 } });
  assert.equal(put.status, 200, put.text);
});

after(async () => {
  await t?.stop();
});

describe('Н1: таблица «Столы» — все ресурсы в работе, независимо от периода', { skip: SKIP }, () => {
  it('«Сегодня» до открытия клуба: все столы и корты в работе, нули; cloth_due у тех, кто за порогом', async () => {
    cache.clear();
    const r = await t.request('GET', `/api/clubs/${CLUB}/dashboard?from=${TODAY}&to=${TODAY}&tab=hall&compare=0`, { token: owner });
    assert.equal(r.status, 200, r.text);
    const rows = r.json.tables.by_resource;
    // Сид: столы 1–8 и корты 1–2; стол 8 выведен — не показывается.
    assert.deepEqual(rows.map((x) => `${x.type}#${x.number}`), [
      ...[1, 2, 3, 4, 5, 6, 7].map((n) => `${rows.find((y) => y.number === n && y.type !== 'padel_court')?.type}#${n}`),
      'padel_court#1',
      'padel_court#2',
    ]);
    assert.equal(rows.length, 9);
    assert.ok(rows.every((x) => x.utilization_pct === null && x.games === 0 && x.revenue_kopecks === 0 && x.play_minutes === 0), 'до открытия — нули, ёмкости нет');
    assert.ok(!rows.some((x) => x.resource_id === T(8)));
    const t1 = rows.find((x) => x.resource_id === T(1));
    assert.ok(t1.cloth_hours >= 3, `часов ${t1.cloth_hours}`);
    assert.deepEqual([t1.cloth_threshold_hours, t1.cloth_due], [2, true]);
    const t2 = rows.find((x) => x.resource_id === T(2));
    assert.deepEqual([t2.cloth_hours, t2.cloth_due], [0, false]);
    const court = rows.find((x) => x.resource_id === COURT_1);
    assert.deepEqual([court.cloth_hours, court.cloth_due], [null, false], 'у корта нет сукна');
    // Фильтр вида — по-прежнему: только корты.
    cache.clear();
    const courts = await t.request('GET', `/api/clubs/${CLUB}/dashboard?from=${TODAY}&to=${TODAY}&tab=hall&compare=0&kind=court`, { token: owner });
    assert.deepEqual(courts.json.tables.by_resource.map((x) => x.type), ['padel_court', 'padel_court']);
  });

  it('прошлый период без активности: те же ресурсы в работе, с нулями; выведенный стол с игрой в периоде остаётся', async () => {
    cache.clear();
    const day = addDays(TODAY, -10);
    const r = await t.request('GET', `/api/clubs/${CLUB}/dashboard?from=${day}&to=${day}&tab=hall&compare=0`, { token: owner });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.tables.by_resource.length, 9 + (r.json.tables.by_resource.some((x) => x.resource_id === T(8)) ? 1 : 0));
    // Выведенный стол, игравший в периоде (вчера), остаётся в таблице.
    cache.clear();
    const y = addDays(TODAY, -1);
    await t.admin.query(
      `insert into bl.sessions (id, club_id, resource_id, status, source, payer_user_id, started_at, paid_until, ended_at, close_reason, created_at, updated_at)
       values ($1, $2, $3, 'closed', 'qr', $4, $5, $6, $6, 'expired', $5, $6)`,
      [randomUUID(), CLUB, T(8), G1, zonedTime(y, '16:00', TZ), zonedTime(y, '17:00', TZ)],
    );
    const withGame = await t.request('GET', `/api/clubs/${CLUB}/dashboard?from=${y}&to=${y}&tab=hall&compare=0`, { token: owner });
    const t8 = withGame.json.tables.by_resource.find((x) => x.resource_id === T(8));
    assert.ok(t8 && t8.games === 1, JSON.stringify(t8));
  });
});

describe('п. 10: resource_type у ручных действий в отчёте смены', { skip: SKIP }, () => {
  it('service.start на корте: resource_number и resource_type', async () => {
    const opened = new Date(Date.now() - 3600_000);
    const { rows } = await t.admin.query('insert into bl.shifts (club_id, number, opened_by, opened_at, float_kopecks) values ($1, 1, $2, $3, 0) returning id', [CLUB, OWNER, opened]);
    await withContext(t.pool, { clubId: CLUB, userId: OWNER, actorType: 'user' }, (db) =>
      appendAudit(db, { action: 'service.start', objectType: 'resource', objectId: COURT_1, reason: 'Проверка света', actorType: 'user', actorId: OWNER, data: { minutes: 10 } }),
    );
    const report = await withContext(t.pool, { clubId: CLUB, actorType: 'system' }, (db) =>
      buildShiftReport(db, { shiftId: rows[0].id, now: new Date(Date.now() + 3600_000), online: false }),
    );
    const item = report.manual_actions.items.find((x) => x.action === 'service.start');
    assert.ok(item, JSON.stringify(report.manual_actions));
    assert.deepEqual([item.resource_id, item.resource_number, item.resource_type], [COURT_1, 1, 'padel_court']);
  });
});
