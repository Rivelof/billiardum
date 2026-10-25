// Загрузка суток: утренняя сводка = дашборд (№170, №187; приёмка M5.8, T29). Ёмкость суток — ресурсы «в работе» в эти
// сутки по созданию и журналу вывода: корт, появившийся позже, в прошлые сутки не входит ни в сводку, ни в дашборд;
// в сутки, когда корты есть, — общая ёмкость по всем ресурсам. Отчёт смены считает ёмкость окна так же. Плюс CSV tables =
// таблица «Столы» на экране (все ресурсы в работе, с нулями).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { CORE_ROUTE_FILES, startTestApp } from '../../../test/db/helpers.mjs';
import { loadRoutes } from '../../../../api/router.mjs';
import { cache } from '../../../../api/routes/dashboard.mjs';
import { withContext } from '../../../lib/store.mjs';
import { buildShiftReport } from '../../../reports/shift-report.mjs';
import { buildMorningSummary } from '../../../summaries/index.mjs';
import { addDays, workingDayOf, zonedTime } from '../../time.mjs';

const SKIP = !process.env.DATABASE_ADMIN_URL;
const CLUB = 'c1000000-0000-4000-8000-000000000001';
const OWNER = 'a1000000-0000-4000-8000-000000000001';
const G1 = 'a9000000-0000-4000-8000-0000000000a1';
const TZ = 'Asia/Yekaterinburg';
const T1 = 'e1000000-0000-4000-8000-000000000001';
const TODAY = workingDayOf(new Date(), TZ, '06:00');
const DAY = addDays(TODAY, -3); // закрытые сутки, когда корты ещё не существовали
const DAY2 = addDays(TODAY, -2); // сутки, когда корты уже были
let t;
let owner;

const tile = (json, id) => json.tiles.find((x) => x.id === id)?.value;
const dash = async (day, tab = 'summary') => {
  cache.clear();
  const r = await t.request('GET', `/api/clubs/${CLUB}/dashboard?from=${day}&to=${day}&tab=${tab}&compare=0`, { token: owner });
  assert.equal(r.status, 200, r.text);
  return r.json;
};
const summaryOf = (day) => withContext(t.pool, { clubId: CLUB, actorType: 'system' }, (db) => buildMorningSummary(db, { clubId: CLUB, day, timezone: TZ, dayStartLocal: '06:00', now: new Date() }));

async function game(resource, day, hhmm, minutes) {
  const from = zonedTime(day, hhmm, TZ);
  await t.admin.query(
    `insert into bl.sessions (id, club_id, resource_id, status, source, payer_user_id, started_at, paid_until, ended_at, close_reason, created_at, updated_at)
     values ($1, $2, $3, 'closed', 'qr', $4, $5, $6, $6, 'expired', $5, $6)`,
    [randomUUID(), CLUB, resource, G1, from, new Date(from.getTime() + minutes * 60_000)],
  );
}

before(async () => {
  if (SKIP) return;
  t = await startTestApp({ routes: await loadRoutes({ only: [...CORE_ROUTE_FILES, 'dashboard.mjs'] }) });
  const old = zonedTime(addDays(TODAY, -30), '12:00', TZ);
  // Клуб и столы 1–8 существуют давно; корты появились позже (создание — «сейчас»), как на стенде после M5.8.
  await t.admin.query('update bl.clubs set created_at = $2 where id = $1', [CLUB, old]);
  await t.admin.query("update bl.resources set created_at = $2 where club_id = $1 and type <> 'padel_court'", [CLUB, old]);
  await t.admin.query("update bl.resources set created_at = $2 where club_id = $1 and type = 'padel_court'", [CLUB, zonedTime(addDays(TODAY, -1), '09:00', TZ)]);
  await t.admin.query("insert into bl.users (id, phone) values ($1, '+79990000701')", [G1]);
  await game(T1, DAY, '12:00', 180);
  await game(T1, DAY2, '12:00', 180);
  owner = (await t.login('+70000000001')).token;
});
after(async () => {
  await t?.stop();
});

describe('загрузка суток: сводка = дашборд', { skip: SKIP }, () => {
  it('сутки до появления кортов: ёмкость — 8 столов, сводка и дашборд совпадают (1,6 %)', async () => {
    const s = await summaryOf(DAY);
    const d = await dash(DAY);
    assert.equal(s.play.utilization_percent, tile(d, 'utilization'));
    // 180 минут / (8 столов × 1 440 минут) = 1,5625 % → 1,6.
    assert.equal(s.play.utilization_percent, 1.6);
    assert.equal(s.play.resources, 8, 'ресурсов в работе в эти сутки — 8');
    assert.equal(s.play.sessions, tile(d, 'games'));
    assert.equal(s.play.hours, tile(d, 'play_hours'));
  });

  it('сутки, когда корты уже есть: общая ёмкость по всем ресурсам (10); сводка = дашборд', async () => {
    // Корты созданы вчера в 09:00 — к DAY2 их ещё нет; проверим сутки вчера: ёмкость 8 × 1 440 + 2 × (с 09:00 до конца суток).
    const yesterday = addDays(TODAY, -1);
    const s = await summaryOf(yesterday);
    const d = await dash(yesterday);
    assert.equal(s.play.utilization_percent, tile(d, 'utilization'));
    assert.equal(s.play.resources, 10);
    const ring = (await dash(yesterday, 'hall')).series.ring;
    assert.ok(ring.capacity_minutes > 8 * 1440 && ring.capacity_minutes < 10 * 1440, `ёмкость ${ring.capacity_minutes}`);
  });

  it('часы работы клуба: ёмкость — в часы работы, сводка по-прежнему = дашборд', async () => {
    await t.admin.query(`update bl.clubs set settings = settings || '{"open_hours": {"open": "10:00", "close": "02:00"}}'::jsonb where id = $1`, [CLUB]);
    const s = await summaryOf(DAY2);
    const d = await dash(DAY2);
    assert.equal(s.play.utilization_percent, tile(d, 'utilization'));
    // 180 / (8 × 16 ч) = 2,3 %.
    assert.equal(s.play.utilization_percent, 2.3);
    await t.admin.query("update bl.clubs set settings = settings - 'open_hours' where id = $1", [CLUB]);
  });

  it('свежая сводка за незаконченные сутки: идущая игра считается до «сейчас», как на дашборде (часы совпадают)', async () => {
    const dayStartMs = zonedTime(workingDayOf(new Date(), TZ, '06:00'), '06:00', TZ).getTime();
    const started = new Date(Math.max(Date.now() - 90 * 60_000, dayStartMs + 60_000));
    await t.admin.query(
      `insert into bl.sessions (id, club_id, resource_id, status, source, payer_user_id, started_at, paid_until, created_at, updated_at)
       values ($1, $2, $3, 'active', 'qr', $4, $5, $6, $5, $5)`,
      [randomUUID(), CLUB, T1, G1, started, new Date(Date.now() + 3600_000)],
    );
    const day = workingDayOf(new Date(), TZ, '06:00');
    const s = await summaryOf(day);
    const d = await dash(day);
    assert.equal(s.play.hours, tile(d, 'play_hours'));
    assert.ok(s.play.minutes >= 1 && s.play.minutes <= 91, `минут ${s.play.minutes}`);
    await t.admin.query("delete from bl.sessions where club_id = $1 and status = 'active'", [CLUB]).catch(() => {});
  });

  it('отчёт смены: ёмкость окна — ресурсы в работе в нём (корты не входят в смену до их появления)', async () => {
    const from = zonedTime(DAY, '10:00', TZ);
    const to = zonedTime(DAY, '22:00', TZ);
    const { rows } = await t.admin.query('insert into bl.shifts (club_id, number, opened_by, opened_at, closed_at, closed_by, float_kopecks, actual_cash_kopecks, expected_cash_kopecks, discrepancy_kopecks) values ($1, 1, $2, $3, $4, $2, 0, 0, 0, 0) returning id', [CLUB, OWNER, from, to]);
    const r = await withContext(t.pool, { clubId: CLUB, actorType: 'system' }, (db) => buildShiftReport(db, { shiftId: rows[0].id, now: new Date(), online: false }));
    assert.equal(r.play.resources, 8);
    assert.equal(r.play.capacity_minutes, 8 * 720);
    // 180 / (8 × 720) = 3,125 % → 3,1.
    assert.equal(r.play.utilization_percent, 3.1);
    assert.ok(!r.play.by_resource.some((x) => x.family === 'court' && x.utilization_percent > 0));
  });
});

describe('CSV tables = таблица «Столы»', { skip: SKIP }, () => {
  it('в CSV те же строки, что на экране: все ресурсы в работе, в том числе корт без игр, со словом вида', async () => {
    const day = addDays(TODAY, -3);
    const hall = await dash(day, 'hall');
    cache.clear();
    const csv = await t.request('GET', `/api/clubs/${CLUB}/dashboard/export.csv?from=${day}&to=${day}&table=tables`, { token: owner, raw: true });
    assert.equal(csv.status, 200);
    const lines = csv.text.replace(/^\uFEFF/, '').trim().split('\r\n').map((l) => l.split(';'));
    const body = lines.slice(1);
    assert.equal(body.length, hall.tables.by_resource.length);
    assert.ok(body.some((l) => l[1] === 'Корт 1'), 'Корт 1 в CSV');
    for (const r of hall.tables.by_resource) {
      const line = body.find((l) => l[0] === String(r.number) && l[1] === (r.title ?? ''));
      assert.ok(line, `${r.title} в CSV`);
      assert.equal(line.at(-1), r.family === 'court' ? 'Корт' : 'Стол');
    }
    assert.ok(hall.tables.by_resource.every((x) => x.family));
  });
});
