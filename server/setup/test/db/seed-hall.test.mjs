// План зала сида (приёмка M5.8, Д6): столы 1–8 и корты 101/102 помещаются в зал сида без наложений
// (корт 10,6 × 20,6 м как рисует shared/hall.mjs); скрипт scripts/db-fix-seed-hall.mjs приводит к этому
// существующий сид идемпотентно и не трогает то, что владелец уже менял.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { TABLE_SIZES } from '../../../../shared/hall.mjs';
import { fixSeedHall } from '../../../../scripts/db-fix-seed-hall.mjs';
import { loadRoutes } from '../../../../api/router.mjs';
import { CLUB_A, startTestApp } from '../../../test/db/helpers.mjs';

const SKIP = !process.env.DATABASE_ADMIN_URL;
const COURT_1 = 'e1000000-0000-4000-8000-000000000101';
const COURT_2 = 'e1000000-0000-4000-8000-000000000102';
let t;

before(async () => {
  if (SKIP) return;
  t = await startTestApp({ routes: await loadRoutes({ config: { publicHost: 'bl.test' }, only: ['auth.mjs'] }), notifyWorker: false });
});
after(async () => {
  await t?.stop();
});

const kindOf = (type) => (type === 'padel_court' ? 'court' : type === 'billiard_pool' ? 'pool' : 'pyramid');
/** Описанный прямоугольник с поворотом, сантиметры: как footprint() в web/admin/src/lib/hallEditor.js. */
function box(r) {
  const s = TABLE_SIZES[kindOf(r.type)];
  const w = s.outerShort / 10;
  const h = s.outerLong / 10;
  const a = (r.plan_rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(a));
  const si = Math.abs(Math.sin(a));
  const fw = w * c + h * si;
  const fh = w * si + h * c;
  return { x1: r.plan_x - fw / 2, x2: r.plan_x + fw / 2, y1: r.plan_y - fh / 2, y2: r.plan_y + fh / 2 };
}

async function layout() {
  const { rows } = await t.admin.query('select number, type, plan_x, plan_y, plan_rotation from bl.resources where club_id = $1 and active order by type, number', [CLUB_A]);
  const plan = (await t.admin.query("select settings -> 'plan' as plan from bl.clubs where id = $1", [CLUB_A])).rows[0].plan;
  return { rows, plan };
}

describe('сид: план зала', { skip: SKIP }, () => {
  it('10 ресурсов целиком внутри зала, без наложений', async () => {
    const { rows, plan } = await layout();
    assert.equal(rows.length, 10);
    const boxes = rows.map((r) => ({ r, ...box(r) }));
    for (const b of boxes) {
      assert.ok(b.x1 >= 0 && b.y1 >= 0 && b.x2 <= plan.width_cm && b.y2 <= plan.height_cm, `${b.r.type} ${b.r.number} вне зала ${plan.width_cm} × ${plan.height_cm}`);
    }
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        const overlap = a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
        assert.ok(!overlap, `${a.r.type} ${a.r.number} пересекается с ${b.r.type} ${b.r.number}`);
      }
    }
  });

  it('скрипт: старый сид (зал 18 × 14, корты в 1650) приводится к новому; повтор и правки владельца не затрагиваются', async () => {
    const { rows: before } = await layout();
    const tables = before.filter((r) => r.type !== 'padel_court');
    // Откат к старому сиду.
    await t.admin.query(`update bl.clubs set settings = jsonb_set(settings, '{plan}', '{"width_cm": 1800, "height_cm": 1400}') where id = $1`, [CLUB_A]);
    await t.admin.query('update bl.resources set plan_x = 1650, plan_y = 750 where id = $1', [COURT_1]);
    await t.admin.query('update bl.resources set plan_x = 1650, plan_y = 1150 where id = $1', [COURT_2]);
    assert.deepEqual(await fixSeedHall(t.admin, { dryRun: true }), { plan: 1, courts: 2 });
    assert.deepEqual(await fixSeedHall(t.admin), { plan: 1, courts: 2 });
    const { rows, plan } = await layout();
    assert.deepEqual(plan, { width_cm: 3900, height_cm: 2350 });
    assert.deepEqual(rows.filter((r) => r.type !== 'padel_court'), tables, 'столы не тронуты');
    assert.deepEqual(rows.filter((r) => r.type === 'padel_court').map((r) => [r.number, r.plan_x, r.plan_y, r.plan_rotation]), [[1, 2830, 600, 90], [2, 2830, 1750, 90]]);
    assert.deepEqual(await fixSeedHall(t.admin), { plan: 0, courts: 0 }, 'повтор ничего не меняет');
    // Владелец сам передвинул корт и изменил зал — скрипт этого не трогает.
    await t.admin.query(`update bl.clubs set settings = jsonb_set(settings, '{plan}', '{"width_cm": 5000, "height_cm": 3000}') where id = $1`, [CLUB_A]);
    await t.admin.query('update bl.resources set plan_x = 1650, plan_y = 750 where id = $1', [COURT_1]);
    await t.admin.query('update bl.resources set plan_x = 2000, plan_y = 900 where id = $1', [COURT_2]);
    assert.deepEqual(await fixSeedHall(t.admin), { plan: 0, courts: 1 });
    assert.equal((await t.admin.query('select plan_x from bl.resources where id = $1', [COURT_2])).rows[0].plan_x, 2000);
  });
});
