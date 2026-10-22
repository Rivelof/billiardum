// Инструменты базы «Бильярдума»: миграции, сид, сброс. Используются bin/*.mjs и тестами.
// Подключение — суперпользователь (DATABASE_ADMIN_URL). Секреты не печатаются.

import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(PACKAGE_DIR, '..');
export const MIGRATIONS_DIR = path.join(PACKAGE_DIR, 'migrations');
export const SEED_FILE = path.join(PACKAGE_DIR, 'seed.sql');
/** Добавки сида модулей M1 (контракт M1 §13): 0100_core.sql, 0200_money.sql, 0300_light.sql. */
export const SEED_DIR = path.join(PACKAGE_DIR, 'seed.d');
const SEED_D_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

const MIGRATION_FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const MIGRATE_LOCK = 'bl.migrate';

/** Строка лога JSON без персональных данных. */
export function log(level, msg, fields = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

/**
 * Берёт переменную окружения; если её нет — читает .env из корня репозитория
 * (значения окружения главнее файла) и пробует ещё раз.
 */
export function requireEnv(name) {
  if (!process.env[name]) {
    const envFile = path.join(REPO_ROOT, '.env');
    if (existsSync(envFile)) process.loadEnvFile(envFile);
  }
  const value = process.env[name];
  if (!value) throw new Error(`не задана переменная окружения ${name}`);
  return value;
}

export function refuseInProduction(what) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`${what} запрещён при NODE_ENV=production`);
  }
}

/** sha256 содержимого без учёта CRLF/LF, чтобы checkout на Windows не ломал учёт. */
export function checksum(text) {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** Миграции по порядку версий. */
export function listMigrations(dir = MIGRATIONS_DIR) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const out = [];
  const seen = new Set();
  for (const file of files) {
    const m = MIGRATION_FILE.exec(file);
    if (!m) throw new Error(`имя миграции ${file} не по шаблону NNNN_name.sql`);
    if (seen.has(m[1])) throw new Error(`две миграции с версией ${m[1]}`);
    seen.add(m[1]);
    const sql = readFileSync(path.join(dir, file), 'utf8');
    out.push({ version: m[1], name: file, sql, checksum: checksum(sql) });
  }
  return out;
}

/** Ключи SCRAM-SHA-256 (RFC 5802/7677) для пароля в UTF-8. */
export function scramKeys(password, salt, iterations) {
  const salted = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return { storedKey, serverKey };
}

/**
 * Хеш SCRAM-SHA-256 в формате pg_authid. Пароль уходит в базу только хешем:
 * его не видно ни в логах Postgres, ни в pg_stat_statements.
 * Пароль — печатный ASCII без пробелов (SASLprep для него ничего не меняет).
 */
export function scramVerifier(password, { salt = randomBytes(16), iterations = 4096 } = {}) {
  if (typeof password !== 'string' || !/^[\x21-\x7e]{12,256}$/.test(password)) {
    throw new Error('пароль должен быть печатным ASCII без пробелов, от 12 до 256 символов');
  }
  const { storedKey, serverKey } = scramKeys(password, salt, iterations);
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

export async function connectAdmin(connectionString) {
  const client = new pg.Client({ connectionString, application_name: 'bl-db-tools' });
  client.on('notice', (n) => log('info', 'db_notice', { notice: n.message }));
  await client.connect();
  const { rows } = await client.query('select rolsuper from pg_roles where rolname = current_user');
  if (!rows[0]?.rolsuper) {
    await client.end();
    throw new Error('миграции, сид и сброс выполняет суперпользователь (DATABASE_ADMIN_URL)');
  }
  return client;
}

async function appliedMigrations(client) {
  const { rows } = await client.query("select to_regclass('bl.schema_migrations') is not null as present");
  if (!rows[0].present) return new Map();
  const res = await client.query('select version, name, checksum from bl.schema_migrations order by version');
  return new Map(res.rows.map((r) => [r.version, r]));
}

/**
 * Применяет новые миграции, каждую в своей транзакции, под блокировкой.
 * appPassword задан — ставит пароль app_api (хешем SCRAM); не задан — пароль не трогает
 * (так работают тесты базы, чтобы не ломать вход работающему серверу).
 */
export async function migrate({ connectionString, appPassword, dir = MIGRATIONS_DIR, quiet = false }) {
  const migrations = listMigrations(dir);
  const verifier = appPassword === undefined ? null : scramVerifier(appPassword);
  const client = await connectAdmin(connectionString);
  let applied = 0;
  try {
    await client.query('select pg_advisory_lock(hashtextextended($1, 0))', [MIGRATE_LOCK]);
    const done = await appliedMigrations(client);
    for (const version of done.keys()) {
      if (!migrations.some((m) => m.version === version)) {
        throw new Error(`в базе применена миграция ${version}, которой нет в ${path.relative(REPO_ROOT, dir)}`);
      }
    }
    for (const m of migrations) {
      const prev = done.get(m.version);
      if (prev) {
        if (prev.checksum !== m.checksum || prev.name !== m.name) {
          throw new Error(`миграция ${m.name} изменена после применения: новые изменения — только новой миграцией`);
        }
        continue;
      }
      await client.query('begin');
      try {
        await client.query(m.sql);
        await client.query('insert into bl.schema_migrations (version, name, checksum) values ($1, $2, $3)', [
          m.version,
          m.name,
          m.checksum,
        ]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback').catch(() => {});
        err.message = `${m.name}: ${err.message}`;
        throw err;
      }
      applied += 1;
      if (!quiet) log('info', 'migration_applied', { version: m.version, name: m.name });
    }
    if (verifier) {
      await client.query(`alter role app_api password ${client.escapeLiteral(verifier)}`);
    }
    if (!quiet) {
      log('info', 'migrate_done', { applied, total: migrations.length, app_password_set: Boolean(verifier) });
    }
    return { applied, total: migrations.length };
  } finally {
    await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [MIGRATE_LOCK]).catch(() => {});
    await client.end();
  }
}

/** Файлы seed.d по порядку имён (NNNN_name.sql); каталога нет — пусто. */
export function listSeedFiles(dir = SEED_DIR) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (!SEED_D_FILE.test(f)) throw new Error(`имя файла сида ${f} не по шаблону NNNN_name.sql`);
  }
  return files.map((f) => path.join(dir, f));
}

/**
 * Применяет supabase/seed.sql, затем seed.d/*.sql по порядку — всё в одной транзакции:
 * ошибка в любом файле не оставляет половины сида. Сид идемпотентен.
 */
export async function seed({ connectionString, file = SEED_FILE, dir = SEED_DIR, quiet = false }) {
  const files = [file, ...listSeedFiles(dir)];
  const client = await connectAdmin(connectionString);
  try {
    await client.query('begin');
    for (const f of files) {
      try {
        await client.query(readFileSync(f, 'utf8'));
      } catch (err) {
        err.message = `${path.relative(REPO_ROOT, f)}: ${err.message}`;
        throw err;
      }
    }
    await client.query('commit');
    if (!quiet) log('info', 'seed_done', { files: files.map((f) => path.relative(REPO_ROOT, f)) });
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

/**
 * Стирает схемы bl (вместе с журналом) и bl_guard. Только разработка: событийные
 * триггеры защиты журнала снимаются явно, роли кластера остаются.
 */
export async function dropSchema({ connectionString, quiet = false }) {
  const client = await connectAdmin(connectionString);
  try {
    await client.query('begin');
    await client.query('drop event trigger if exists bl_audit_guard_ddl');
    await client.query('drop event trigger if exists bl_audit_guard_drop');
    await client.query('drop schema if exists bl cascade');
    await client.query('drop schema if exists bl_guard cascade');
    await client.query('commit');
    if (!quiet) log('info', 'schema_dropped', { schema: 'bl' });
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

/** Запуск CLI: ошибки — одной строкой JSON и код 1. */
export async function runCli(main) {
  try {
    await main();
  } catch (err) {
    log('error', 'failed', { error: err.message, code: err.code });
    process.exitCode = 1;
  }
}
