// Настройки денег клуба и клиент ЮKassa с ключами клуба (decisions №23).
// Секрет магазина хранится в bl.club_payment_settings.secret_key_enc (AES-256-GCM, контекст
// yookassa_secret/<club_id>) и расшифровывается только для запроса.

import { decryptSecret, encryptSecret } from '../lib/secrets.mjs';
import { MoneyError } from './errors.mjs';
import { createYooKassaClient } from './yookassa.mjs';

export const DEFAULT_SETTINGS = Object.freeze({
  shop_id: null,
  secret_key_enc: null,
  sbp_enabled: false,
  card_enabled: false,
  reception_enabled: true,
  vat_code: 1,
  tax_system_code: null,
  unlimited_hold_minutes: 120,
  sbp_block_minutes: 30,
  reception_request_minutes: 15,
});

export function yookassaSecretContext(clubId) {
  return `yookassa_secret/${clubId}`;
}

export function encryptShopSecret(secret, encKey, clubId) {
  return encryptSecret(secret, encKey, yookassaSecretContext(clubId));
}

/** Настройки клуба из контекста транзакции; без строки — по умолчанию (только ресепшн). */
export async function loadPaymentSettings(db, clubId) {
  const { rows } = await db.query('select * from bl.club_payment_settings where club_id = $1', [clubId]);
  const s = rows[0] ? { ...DEFAULT_SETTINGS, ...rows[0] } : { ...DEFAULT_SETTINGS, club_id: clubId };
  const online = Boolean(s.shop_id && s.secret_key_enc);
  return { ...s, online, sbp: online && s.sbp_enabled, card: online && s.card_enabled, reception: s.reception_enabled };
}

/** Клиент ЮKassa с ключами клуба. Нет магазина — payment_failed (метод недоступен). */
export function clientFor(settings, config, { fetch } = {}) {
  if (!settings.online) throw new MoneyError('payment_failed', 'у клуба нет магазина ЮKassa');
  if (!config.encKey) throw new Error('нет SECRETS_ENC_KEY для расшифровки ключа магазина');
  const secretKey = decryptSecret(settings.secret_key_enc, config.encKey, yookassaSecretContext(settings.club_id)).toString('utf8');
  return createYooKassaClient({
    apiUrl: config.yookassaApiUrl,
    shopId: settings.shop_id,
    secretKey,
    timeoutMs: config.yookassaTimeoutMs,
    fetch: fetch ?? config.fetch,
  });
}
