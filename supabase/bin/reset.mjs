#!/usr/bin/env node
// npm run db:reset — стирает схему bl вместе с журналом, затем migrate и seed.
// Только разработка: при NODE_ENV=production отказывает. Роли кластера не удаляются.

import { dropSchema, migrate, refuseInProduction, requireEnv, runCli, seed } from '../lib/db.mjs';

await runCli(async () => {
  // Сначала окружение (может подгрузить .env), затем проверка NODE_ENV.
  const connectionString = requireEnv('DATABASE_ADMIN_URL');
  const appPassword = requireEnv('DB_APP_PASSWORD');
  refuseInProduction('сброс базы');
  await dropSchema({ connectionString });
  await migrate({ connectionString, appPassword });
  await seed({ connectionString });
});
