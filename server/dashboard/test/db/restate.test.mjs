// Д1 приёмки M5.2: сутки, посчитанные старой версией формул (до правки округления ёмкости Н1),
// планировщик пересчитывает сам — по всем клубам, порциями (бюджет на проход и на клуб, свежие
// сутки первыми), не в часы пик клуба. После пересчёта тепловая карта = кольцо.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startTestApp, CORE_ROUTE_FILES } from '../../../test/db/helpers.mjs';
import { loadRoutes } from '../../../../api/router.mjs';
import { cache } from '../../../../api/routes/dashboard.mjs';
import { seedClubB, CLUB_B } from '../../../../supabase/tests/helpers.mjs';
import { computeDay, VERSION } from '../../day.mjs';
import { inWindow, tick } from '../../index.mjs';
import { loadClub } from '../../store.mjs';
import { addDays, localParts } from '../../time.mjs';
import { CLUB, L, seedDataset, TZ } from './harness.mjs';

const NOW = new Date();
const clock = { now: () => NOW };
const hh = (h) => `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`;
const hour = localParts(NOW, TZ).hour;
/** Окно, в котором «сейчас» (часы пик), и окно без «сейчас». */
const PEAK_NOW = { from: hh(hour), to: hh(hour + 1) };
const PEAK_LATER = { from: hh(hour + 2), to: hh(hour + 3) };

let t;
let data;
let owner;

before(async () => {
  t = await startTestApp({ routes: await loadRoutes({ only: [...CORE_ROUTE_FILES, 'dashboard.mjs'] }), clock });
  data = await seedDataset(t.admin, NOW);
  await seedClubB(t.admin);
  // Клуб Б — в том же поясе (часы пик в тесте одни на оба клуба), с историей с D1 − 5.
  await t.admin.query('update bl.clubs set timezone = $2, created_at = $3 where id = $1', [CLUB_B, TZ, L(addDays(data.D1, -5), '12:00')]);
  await t.admin.query('update bl.resources set created_at = $2 where club_id = $1', [CLUB_B, L(addDays(data.D1, -5), '12:00')]);
  owner = (await t.login('+70000000001')).token;
});

after(async () => {
  await t?.stop();
});

const hall = async (day) => {
  cache.clear();
  const r = await t.request('GET', `/api/clubs/${CLUB}/dashboard?from=${day}&to=${day}&tab=hall`, { token: owner });
  assert.equal(r.status, 200);
  const cells = r.json.series.heatmap.capacity_minutes.flat().reduce((a, v) => a + (v ?? 0), 0);
  return { cells, ring: r.json.series.ring.capacity_minutes };
};

/** Сутки, где сумма часов (карта) не равна итогу суток (кольцо). */
const mismatched = async () =>
  (
    await t.admin.query(
      `select d.club_id, d.day::text from bl.stats_daily d
         left join (select club_id, day, sum(capacity_minutes)::int as cap from bl.stats_hourly group by 1, 2) h using (club_id, day)
        where coalesce(h.cap, 0) <> d.capacity_minutes`,
    )
  ).rows;

describe('пересчёт суток старой версии формул (Д1 M5.2)', () => {
  it('часы пик: окно через полночь и обычное', () => {
    const at = (hhmm) => L('2026-10-21', hhmm);
    assert.equal(inWindow({ from: '17:00', to: '02:00' }, at('21:30'), TZ), true);
    assert.equal(inWindow({ from: '17:00', to: '02:00' }, at('01:59'), TZ), true);
    assert.equal(inWindow({ from: '17:00', to: '02:00' }, at('02:00'), TZ), false);
    assert.equal(inWindow({ from: '17:00', to: '02:00' }, at('16:59'), TZ), false);
    assert.equal(inWindow({ from: '09:00', to: '12:00' }, at('10:00'), TZ), true);
    assert.equal(inWindow({ from: '09:00', to: '12:00' }, at('12:00'), TZ), false);
    assert.equal(inWindow({ from: 'xx', to: '12:00' }, at('10:00'), TZ), false, 'неверное окно — не пик');
    assert.equal(inWindow(null, at('10:00'), TZ), false);
  });

  it('сутки старой версии: в часы пик не трогаются, вне пика — порциями по всем клубам, свежие первыми; потом карта = кольцо', async () => {
    assert.ok(VERSION >= 2, 'версия формул поднята после правки округления ёмкости');
    // Обычный проход: все закрытые сутки обоих клубов посчитаны текущей версией.
    const first = await tick({ pool: t.pool, clock, log: t.log, restate: { peak: null } });
    assert.ok(first.computed.some((x) => x.club_id === CLUB) && first.computed.some((x) => x.club_id === CLUB_B));
    assert.deepEqual(first.restated, [], 'старых суток ещё нет');
    assert.deepEqual(await mismatched(), []);

    // Агрегаты «старой формулы»: версия 1 и часы, округлённые поячеечно (сумма ячеек ушла от итога на 2).
    await t.admin.query(`update bl.stats_daily set version = 1, data = jsonb_set(data, '{v}', '1')`);
    await t.admin.query(
      `update bl.stats_hourly h set capacity_minutes = h.capacity_minutes + 2
         from (select distinct on (club_id, day) club_id, day, resource_id, hour from bl.stats_hourly
                where capacity_minutes > 0 order by club_id, day, resource_id, hour) x
        where h.club_id = x.club_id and h.day = x.day and h.resource_id = x.resource_id and h.hour = x.hour`,
    );
    const stale = (await t.admin.query('select club_id, day::text from bl.stats_daily where version < $1', [VERSION])).rows;
    const staleA = stale.filter((r) => r.club_id === CLUB).map((r) => r.day).sort();
    assert.ok(staleA.includes(data.D1) && stale.some((r) => r.club_id === CLUB_B), 'старые сутки у обоих клубов');
    const before1 = await hall(data.D1);
    assert.equal(before1.cells, before1.ring + 2, 'до пересчёта: карта ≠ кольцо (как 1 360 и 1 358 на стенде)');

    // Часы пик клуба: старые сутки не пересчитываются, обязательных нет — проход пустой.
    const peak = await tick({ pool: t.pool, clock, log: t.log, restate: { peak: PEAK_NOW } });
    assert.deepEqual(peak.computed, []);
    assert.deepEqual(peak.restated, []);
    assert.equal((await t.admin.query('select count(*)::int as n from bl.stats_daily where version < $1', [VERSION])).rows[0].n, stale.length);

    // Вне пика — порциями: не больше 3 суток за проход, не больше 2 на клуб; у клуба — свежие первыми.
    const restated = [];
    for (let i = 0; i < 50; i += 1) {
      const r = await tick({ pool: t.pool, clock, log: t.log, restate: { perTick: 3, perClub: 2, peak: PEAK_LATER } });
      if (r.restated.length === 0) break;
      assert.ok(r.restated.length <= 3, `проход ${i}: не больше 3 суток`);
      for (const c of [CLUB, CLUB_B]) assert.ok(r.restated.filter((x) => x.club_id === c).length <= 2, `проход ${i}: не больше 2 на клуб`);
      assert.deepEqual(r.computed, r.restated, 'других суток нет');
      restated.push(...r.restated);
    }
    assert.equal(restated.length, stale.length, 'пересчитаны все старые сутки, каждые один раз');
    const orderA = restated.filter((x) => x.club_id === CLUB).map((x) => x.day);
    assert.deepEqual(orderA, [...staleA].reverse(), 'свежие сутки первыми');
    assert.ok(restated.some((x) => x.club_id === CLUB_B), 'второй клуб тоже');
    assert.equal((await t.admin.query('select count(*)::int as n from bl.stats_daily where version < $1', [VERSION])).rows[0].n, 0);
    assert.deepEqual(await mismatched(), [], 'у всех суток сумма часов = итог');

    // Экран: карта = кольцо = свежий расчёт.
    const club = await loadClub(t.admin, CLUB);
    for (const day of [data.D1, data.D2, data.D3]) {
      const { cells, ring } = await hall(day);
      const { daily } = await computeDay(t.admin, { club, day, now: NOW });
      assert.equal(cells, ring, `${day}: карта = кольцо`);
      assert.equal(ring, daily.totals.capacity_minutes, `${day}: кольцо = расчёт текущей версии`);
    }

    // Повтор — ничего.
    const again = await tick({ pool: t.pool, clock, log: t.log, restate: { peak: null } });
    assert.deepEqual(again.computed, []);
  });
});
