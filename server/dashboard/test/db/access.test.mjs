// Права дашборда (M5.2 №166, T30): ресепшн и бар — 403; чужой клуб — 403/404 и не попадает в «Все
// мои клубы»; управляющий видит только свои клубы и не экспортирует; период 367 дней — 400.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startTestApp, CORE_ROUTE_FILES } from '../../../test/db/helpers.mjs';
import { loadRoutes } from '../../../../api/router.mjs';
import { cache } from '../../../../api/routes/dashboard.mjs';
import { seedClubB, CLUB_B } from '../../../../supabase/tests/helpers.mjs';
import { addDays, workingDayOf } from '../../time.mjs';

const CLUB = 'c1000000-0000-4000-8000-000000000001';
const BAR = 'a1000000-0000-4000-8000-0000000000b1';
let t;
const tokens = {};

before(async () => {
  t = await startTestApp({ routes: await loadRoutes({ only: [...CORE_ROUTE_FILES, 'dashboard.mjs'] }) });
  await seedClubB(t.admin);
  await t.admin.query("insert into bl.users (id, phone) values ($1, '+70000000011')", [BAR]);
  await t.admin.query("insert into bl.club_members (club_id, user_id, role) values ($1, $2, 'bar')", [CLUB, BAR]);
  for (const [k, phone] of Object.entries({ owner: '+70000000001', ownerB: '+70000000002', manager: '+70000000003', reception: '+70000000004', bar: '+70000000011' })) {
    tokens[k] = (await t.login(phone)).token;
  }
});

after(async () => {
  await t?.stop();
});

const get = (path, who) => {
  cache.clear();
  return t.request('GET', path, { token: tokens[who] });
};

describe('доступ к дашборду', () => {
  it('ресепшн и бар — 403 на дашборд, статус зала и экспорт', async () => {
    for (const who of ['reception', 'bar']) {
      for (const p of ['dashboard', 'dashboard/now', 'dashboard/export.csv?table=revenue_daily']) {
        assert.equal((await get(`/api/clubs/${CLUB}/${p}`, who)).status, 403, `${who} ${p}`);
      }
      assert.equal((await get('/api/clubs/all/dashboard', who)).status, 403, `${who} all`);
    }
  });

  it('без входа — 401', async () => {
    const r = await t.request('GET', `/api/clubs/${CLUB}/dashboard`);
    assert.equal(r.status, 401);
  });

  it('владелец и управляющий видят свой клуб; управляющему экспорт — 403', async () => {
    assert.equal((await get(`/api/clubs/${CLUB}/dashboard`, 'owner')).status, 200);
    assert.equal((await get(`/api/clubs/${CLUB}/dashboard?tab=control`, 'manager')).status, 200);
    assert.equal((await get(`/api/clubs/${CLUB}/dashboard/now`, 'manager')).status, 200);
    assert.equal((await get(`/api/clubs/${CLUB}/dashboard/export.csv?table=revenue_daily`, 'manager')).status, 403);
    assert.equal((await get('/api/clubs/all/dashboard/export.csv?table=revenue_daily', 'manager')).status, 403);
    assert.equal((await get(`/api/clubs/${CLUB}/dashboard/export.csv?table=revenue_daily`, 'owner')).status, 200);
  });

  it('чужой клуб — 403 (UUID) или 404 (не UUID); «Все мои клубы» не показывает чужое', async () => {
    assert.equal((await get(`/api/clubs/${CLUB_B}/dashboard`, 'owner')).status, 403);
    assert.equal((await get(`/api/clubs/${CLUB}/dashboard`, 'ownerB')).status, 403);
    assert.equal((await get(`/api/clubs/${CLUB}/dashboard/export.csv?table=tables`, 'ownerB')).status, 403);
    assert.equal((await get('/api/clubs/not-a-club/dashboard', 'owner')).status, 404);
    assert.equal((await get('/api/clubs/c9000000-0000-4000-8000-000000000009/dashboard', 'owner')).status, 403);
    const b = await get('/api/clubs/all/dashboard', 'ownerB');
    assert.equal(b.status, 200);
    assert.deepEqual(b.json.tables.clubs.map((c) => c.club_id), [CLUB_B]);
    const a = await get('/api/clubs/all/dashboard', 'manager');
    assert.deepEqual(a.json.tables.clubs.map((c) => c.club_id), [CLUB]);
    // ?club= у «всех клубов» не подменяет список.
    const c = await get(`/api/clubs/all/dashboard?club=${CLUB}`, 'ownerB');
    assert.deepEqual(c.json.tables.clubs.map((x) => x.club_id), [CLUB_B]);
    const n = await get('/api/clubs/all/dashboard/now', 'ownerB');
    assert.deepEqual(n.json.clubs.map((x) => x.club_id), [CLUB_B]);
  });

  it('период больше 366 дней — 400; 366 — можно; неверная вкладка — 400', async () => {
    const today = workingDayOf(new Date(), 'Asia/Yekaterinburg', '06:00');
    assert.equal((await get(`/api/clubs/${CLUB}/dashboard?from=${addDays(today, -366)}&to=${today}`, 'owner')).status, 400);
    assert.deepEqual((await get(`/api/clubs/${CLUB}/dashboard?from=${addDays(today, -366)}&to=${today}`, 'owner')).json, { error: 'bad_request' });
    assert.equal((await get(`/api/clubs/${CLUB}/dashboard?from=${addDays(today, -365)}&to=${today}`, 'owner')).status, 200);
    assert.equal((await get(`/api/clubs/${CLUB}/dashboard/export.csv?from=${addDays(today, -366)}&to=${today}&table=tables`, 'owner')).status, 400);
    assert.equal((await get(`/api/clubs/${CLUB}/dashboard?tab=x`, 'owner')).status, 400);
    assert.equal((await get(`/api/clubs/${CLUB}/dashboard/export.csv?table=guests`, 'owner')).status, 400);
  });

  it('пустой клуб — честные нули без выдуманных цифр', async () => {
    const r = await get(`/api/clubs/${CLUB}/dashboard`, 'owner');
    const v = Object.fromEntries(r.json.tiles.map((x) => [x.id, x.value]));
    assert.equal(v.revenue, 0);
    assert.equal(v.games, 0);
    assert.equal(v.avg_check_game, null);
    assert.equal(v.scan_to_light_median_sec, undefined);
  });
});
