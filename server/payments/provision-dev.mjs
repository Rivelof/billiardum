#!/usr/bin/env node
// Провижининг денег для разработки (контракт M1 §13): магазин ЮKassa тестового клуба
// указывает на эмулятор tools/yookassa-emu/. Только разработка: при NODE_ENV=production — отказ.
//
// shopId и секрет — из YOOKASSA_EMU_SHOP_ID и YOOKASSA_EMU_SECRET (те же, что у эмулятора);
// секрет шифруется SECRETS_ENC_KEY (AES-256-GCM, контекст yookassa_secret/<club_id>) и пишется
// в bl.club_payment_settings через DATABASE_ADMIN_URL. Значения секретов не печатаются.
// M5.1 №154: у клуба две пары магазина — тестовая (test_shop_id, test_secret_key_enc, контекст
// yookassa_secret/<club_id>/test) и боевая (shop_id, secret_key_enc). Магазин эмулятора кладётся
// в обе: клуб сида работает в live (как до M5.1), а при переводе в test (через платформу) —
// тестовой парой. Проверка GET /v3/me при этом не делается (отметки verified_at не ставятся).
//
// Вызывает server/bin/provision-dev.mjs (core): provisionPayments({ client, env, log }).
// Можно запустить отдельно: node server/payments/provision-dev.mjs

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { loadEncKey } from '../lib/secrets.mjs';
import { encryptShopSecret } from './settings.mjs';

export const DEV_CLUB_ID = 'c1000000-0000-4000-8000-000000000001';

/**
 * @param {{ client: import('pg').Client|import('pg').PoolClient, env?: NodeJS.ProcessEnv, log?: Function, clubId?: string }} opts
 *   client — подключение суперпользователя (DATABASE_ADMIN_URL), RLS не мешает.
 * @returns {Promise<{ status: 'ok'|'skipped', club_id?: string, reason?: string }>}
 */
export async function provisionPayments({ client, env = process.env, log = () => {}, clubId = DEV_CLUB_ID }) {
  if (env.NODE_ENV === 'production') throw new Error('provision-dev денег запрещён при NODE_ENV=production');
  const shopId = env.YOOKASSA_EMU_SHOP_ID;
  const secret = env.YOOKASSA_EMU_SECRET;
  if (!shopId || !secret) {
    log('warn', 'payments_provision_skipped', { reason: 'YOOKASSA_EMU_SHOP_ID и YOOKASSA_EMU_SECRET не заданы' });
    return { status: 'skipped', reason: 'no_emu_shop' };
  }
  if (!/^[0-9A-Za-z_-]{1,64}$/.test(shopId)) throw new Error('YOOKASSA_EMU_SHOP_ID — до 64 символов [0-9A-Za-z_-]');
  if (secret.length < 8) throw new Error('YOOKASSA_EMU_SECRET — не короче 8 символов');
  const encKey = loadEncKey(env.SECRETS_ENC_KEY);
  const enc = encryptShopSecret(secret, encKey, clubId, 'live');
  const encTest = encryptShopSecret(secret, encKey, clubId, 'test');
  const { rowCount } = await client.query('select 1 from bl.clubs where id = $1', [clubId]);
  if (rowCount === 0) {
    log('warn', 'payments_provision_skipped', { reason: 'нет клуба сида', club_id: clubId });
    return { status: 'skipped', reason: 'no_club' };
  }
  await client.query(
    `insert into bl.club_payment_settings (club_id, shop_id, secret_key_enc, test_shop_id, test_secret_key_enc,
                                           sbp_enabled, card_enabled, reception_enabled, vat_code, tax_system_code)
     values ($1, $2, $3, $2, $4, true, true, true, 1, 2)
     on conflict (club_id) do update
       set shop_id = excluded.shop_id, secret_key_enc = excluded.secret_key_enc,
           test_shop_id = excluded.test_shop_id, test_secret_key_enc = excluded.test_secret_key_enc,
           sbp_enabled = true, card_enabled = true, updated_at = now()`,
    [clubId, shopId, enc, encTest],
  );
  log('info', 'payments_provisioned', { club_id: clubId, shop_id: shopId, secret_length: secret.length });
  return { status: 'ok', club_id: clubId };
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const envFile = path.join(repoRoot, '.env');
  if (!process.env.DATABASE_ADMIN_URL && existsSync(envFile)) process.loadEnvFile(envFile);
  const log = (level, msg, fields = {}) => process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields })}\n`);
  if (!process.env.DATABASE_ADMIN_URL) throw new Error('не задан DATABASE_ADMIN_URL');
  const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL, application_name: 'bl-provision-money' });
  await client.connect();
  try {
    await provisionPayments({ client, log });
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), level: 'error', msg: 'payments_provision_failed', error: err.message })}\n`);
    process.exit(1);
  });
}
