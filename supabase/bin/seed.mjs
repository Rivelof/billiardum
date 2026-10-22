#!/usr/bin/env node
// npm run db:seed — синтетические данные разработки: supabase/seed.sql, затем seed.d/*.sql
// по порядку имён (decisions №17, №21; контракт M1 §13).
// Повторный запуск ничего не дублирует. При NODE_ENV=production отказывает.

import { refuseInProduction, requireEnv, runCli, seed } from '../lib/db.mjs';

await runCli(async () => {
  // Сначала окружение (может подгрузить .env), затем проверка NODE_ENV.
  const connectionString = requireEnv('DATABASE_ADMIN_URL');
  refuseInProduction('сид');
  await seed({ connectionString });
});
