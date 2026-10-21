#!/usr/bin/env node
// npm run db:migrate — применяет supabase/migrations/*.sql по порядку (учёт в bl.schema_migrations)
// и задаёт пароль роли app_api из DB_APP_PASSWORD. Подключение: DATABASE_ADMIN_URL (суперпользователь).

import { migrate, requireEnv, runCli } from '../lib/db.mjs';

await runCli(async () => {
  await migrate({
    connectionString: requireEnv('DATABASE_ADMIN_URL'),
    appPassword: requireEnv('DB_APP_PASSWORD'),
  });
});
