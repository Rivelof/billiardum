#!/usr/bin/env node
// Мост ККТ тестового клуба для разработки (контракт M2 §6; вызывает scripts/dev.mjs после provision:dev).
//
// * Только разработка: при NODE_ENV=production — отказ.
// * Окружение — переменные процесса, недостающие — из .env в корне: DATABASE_ADMIN_URL
//   (суперпользователь, как у server/bin/provision-dev.mjs) и KKT_BRIDGE_TOKEN_FILE (куда писать токен).
// * Регистрирует мост «Ресепшн (разработка)» клуба c1000000-…-000000000001 с новым токеном; прежние
//   мосты разработки этого клуба отзываются (журнал kkt.bridge_revoke, kkt.bridge_register).
// * В файл пишется только токен (права 0600, атомарно); в базе — sha256. Ничего не печатает;
//   при ошибке — код ошибки в stderr без секретов и выход 1.

import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { appendAudit } from '../../lib/audit.mjs';
import { REPO_ROOT } from '../../lib/config.mjs';
import { newBridgeToken } from '../tokens.mjs';

export const DEV_CLUB_ID = 'c1000000-0000-4000-8000-000000000001';
export const DEV_BRIDGE_NAME = 'Ресепшн (разработка)';

/**
 * Зарегистрировать мост разработки. client — подключение суперпользователя (вне транзакции).
 * @returns {Promise<{ bridgeId: string, token: string, revoked: number }>}
 */
export async function provisionKktBridge({ client, clubId = DEV_CLUB_ID, name = DEV_BRIDGE_NAME, now = new Date() }) {
  await client.query('begin');
  try {
    await client.query(
      "select set_config('app.club_id', $1, true), set_config('app.user_id', '', true), set_config('app.actor_type', 'system', true)",
      [clubId],
    );
    const club = await client.query('select 1 from bl.clubs where id = $1', [clubId]);
    if (club.rowCount === 0) throw Object.assign(new Error('нет тестового клуба (db:seed)'), { code: 'no_dev_club' });
    const old = await client.query(
      `update bl.kkt_bridges set revoked_at = $3, updated_at = $3
        where club_id = $1 and name = $2 and revoked_at is null returning id`,
      [clubId, name, now],
    );
    for (const r of old.rows) {
      await appendAudit(client, { action: 'kkt.bridge_revoke', objectType: 'kkt_bridge', objectId: r.id, actorType: 'system', actorId: null, data: { bridge_id: r.id, dev: true } });
    }
    const { token, hash } = newBridgeToken(clubId);
    const ins = await client.query(
      `insert into bl.kkt_bridges (club_id, name, token_hash, kkt_model, created_at, updated_at)
       values ($1, $2, $3, 'АТОЛ (эмулятор)', $4, $4) returning id`,
      [clubId, name, hash, now],
    );
    const bridgeId = ins.rows[0].id;
    await appendAudit(client, { action: 'kkt.bridge_register', objectType: 'kkt_bridge', objectId: bridgeId, actorType: 'system', actorId: null, data: { bridge_id: bridgeId, dev: true } });
    await client.query('commit');
    return { bridgeId, token, revoked: old.rowCount };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  }
}

/** Записать токен в файл атомарно, права 0600. */
export function writeTokenFile(file, token) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

function env(name) {
  if (!process.env[name]) {
    const envFile = path.join(REPO_ROOT, '.env');
    if (existsSync(envFile)) process.loadEnvFile(envFile);
  }
  const value = process.env[name];
  if (!value) throw Object.assign(new Error(`не задана переменная окружения ${name}`), { code: 'env_missing' });
  return value;
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw Object.assign(new Error('только разработка: NODE_ENV=production'), { code: 'production' });
  const tokenFile = path.resolve(env('KKT_BRIDGE_TOKEN_FILE'));
  const client = new pg.Client({ connectionString: env('DATABASE_ADMIN_URL'), application_name: 'bl-kkt-provision-dev' });
  await client.connect();
  try {
    const { token } = await provisionKktBridge({ client });
    writeTokenFile(tokenFile, token);
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), level: 'error', msg: 'kkt_provision_failed', error: err.code ?? err.message })}\n`);
    process.exit(1);
  });
}
