#!/usr/bin/env node
// План зала сида на существующей базе (приёмка M5.8, Д6): корт 10,6 × 20,6 м не помещался в зал сида 18 × 14 м.
// Новый сид (supabase/seed.sql, seed.d/1300_padel.sql) — зал 39 × 23,5 м, Корт 1 (2830, 600) и Корт 2 (2830, 1750)
// справа от столов, поворот 90°, без наложений. Столы 1–8 и все устройства не меняются.
//
// Скрипт идемпотентен и ничего не теряет: правит только значения старого сида (зал 1800 × 1400; корты в
// (1650, 750) и (1650, 1150)); если владелец уже менял размер зала или положение корта — строку не трогает.
// Повторный запуск ничего не меняет. Остальное в базе не затрагивается. Журнал не пишется (данные сида).
//
//   DATABASE_ADMIN_URL=postgres://… node scripts/db-fix-seed-hall.mjs [--dry-run]

import { connectAdmin, log, refuseInProduction, requireEnv, runCli } from '../supabase/lib/db.mjs';

const CLUB = 'c1000000-0000-4000-8000-000000000001';
const COURTS = [
  { id: 'e1000000-0000-4000-8000-000000000101', from: [1650, 750], to: [2830, 600] },
  { id: 'e1000000-0000-4000-8000-000000000102', from: [1650, 1150], to: [2830, 1750] },
];

export async function fixSeedHall(client, { dryRun = false } = {}) {
  const out = { plan: 0, courts: 0 };
  const OLD = '{"width_cm": 1800, "height_cm": 1400}';
  const plan = await client.query(
    dryRun
      ? "select id from bl.clubs where id = $1 and settings -> 'plan' = $2::jsonb"
      : `update bl.clubs set settings = jsonb_set(settings, '{plan}', '{"width_cm": 3900, "height_cm": 2350}'::jsonb)
          where id = $1 and settings -> 'plan' = $2::jsonb returning id`,
    [CLUB, OLD],
  );
  out.plan = plan.rowCount;
  for (const c of COURTS) {
    const r = await client.query(
      dryRun
        ? 'select id from bl.resources where id = $1 and club_id = $2 and plan_x = $3 and plan_y = $4'
        : 'update bl.resources set plan_x = $5, plan_y = $6 where id = $1 and club_id = $2 and plan_x = $3 and plan_y = $4 returning id',
      dryRun ? [c.id, CLUB, ...c.from] : [c.id, CLUB, ...c.from, ...c.to],
    );
    out.courts += r.rowCount;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runCli(async () => {
    const connectionString = requireEnv('DATABASE_ADMIN_URL');
    refuseInProduction('правка плана зала сида');
    const client = await connectAdmin(connectionString);
    try {
      const dryRun = process.argv.includes('--dry-run');
      const res = await fixSeedHall(client, { dryRun });
      log('info', dryRun ? 'seed_hall_would_change' : 'seed_hall_fixed', res);
    } finally {
      await client.end();
    }
  });
}
