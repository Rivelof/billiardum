// Настройки денег клуба и клиент ЮKassa с ключами клуба (decisions №23, M5.1 №154).
//
// У клуба две пары магазина ЮKassa (bl.club_payment_settings, 1002):
//   live — shop_id, secret_key_enc (контекст шифрования yookassa_secret/<club_id>, как до M5.1);
//   test — test_shop_id, test_secret_key_enc (контекст yookassa_secret/<club_id>/test).
// Секрет расшифровывается только для запроса. Какая пара работает:
//   * новый платёж — по режиму клуба: test → тестовая, live → боевая; приостановленный клуб —
//     по режиму до приостановки (loadPaymentSettings без mode);
//   * всё про существующий платёж (вебхук, сверка, списание, возврат, чек зачёта) — по
//     payments.is_test этого платежа: loadPaymentSettings(db, clubId, { isTest }).

import { decryptSecret, encryptSecret } from '../lib/secrets.mjs';
import { MoneyError } from './errors.mjs';
import { createYooKassaClient } from './yookassa.mjs';

export const SHOP_MODES = Object.freeze(['test', 'live']);

export const DEFAULT_SETTINGS = Object.freeze({
  shop_id: null,
  secret_key_enc: null,
  test_shop_id: null,
  test_secret_key_enc: null,
  sbp_enabled: false,
  card_enabled: false,
  reception_enabled: true,
  vat_code: 1,
  tax_system_code: null,
  unlimited_hold_minutes: 120,
  sbp_block_minutes: 30,
  reception_request_minutes: 15,
});

/** Контекст шифрования секрета магазина: боевая пара — как до M5.1, тестовая — с суффиксом /test. */
export function yookassaSecretContext(clubId, mode = 'live') {
  return mode === 'test' ? `yookassa_secret/${clubId}/test` : `yookassa_secret/${clubId}`;
}

export function encryptShopSecret(secret, encKey, clubId, mode = 'live') {
  return encryptSecret(secret, encKey, yookassaSecretContext(clubId, mode));
}

export function decryptShopSecret(enc, encKey, clubId, mode = 'live') {
  return decryptSecret(enc, encKey, yookassaSecretContext(clubId, mode)).toString('utf8');
}

/** Пара магазина по режиму клуба: test (и приостановленный после test) — тестовая, иначе боевая. */
export function shopModeOfClub(mode, modeBeforeSuspend = null) {
  if (mode === 'test') return 'test';
  if (mode === 'suspended' && modeBeforeSuspend === 'test') return 'test';
  return 'live';
}

/** Пара магазина существующего платежа (возврата): по признаку is_test. */
export function shopModeOf(row) {
  return row?.is_test ? 'test' : 'live';
}

/**
 * Настройки клуба из контекста транзакции; без строки — по умолчанию (только ресепшн).
 * shop_id / secret_key_enc в ответе — выбранной пары (shop_mode).
 * @param {{ mode?: 'test'|'live', isTest?: boolean }} [options] пара явно (mode) или по платежу (isTest);
 *   без них — по режиму клуба.
 */
export async function loadPaymentSettings(db, clubId, options = {}) {
  const { rows } = await db.query(
    `select s.*, c.mode as club_mode, c.mode_before_suspend
       from bl.clubs c left join bl.club_payment_settings s on s.club_id = c.id
      where c.id = $1`,
    [clubId],
  );
  const row = rows[0] ?? {};
  const base = row.club_id ? { ...DEFAULT_SETTINGS, ...row } : { ...DEFAULT_SETTINGS, club_id: clubId };
  let shopMode;
  if (SHOP_MODES.includes(options.mode)) shopMode = options.mode;
  else if (typeof options.isTest === 'boolean') shopMode = options.isTest ? 'test' : 'live';
  else shopMode = shopModeOfClub(row.club_mode ?? 'live', row.mode_before_suspend ?? null);
  const pair = shopMode === 'test'
    ? { shop_id: base.test_shop_id ?? null, secret_key_enc: base.test_secret_key_enc ?? null }
    : { shop_id: base.shop_id ?? null, secret_key_enc: base.secret_key_enc ?? null };
  const s = { ...base, club_id: clubId, club_mode: row.club_mode ?? null, shop_mode: shopMode, ...pair };
  delete s.test_secret_key_enc;
  const online = Boolean(s.shop_id && s.secret_key_enc);
  return { ...s, online, sbp: online && s.sbp_enabled, card: online && s.card_enabled, reception: s.reception_enabled };
}

/** Клиент ЮKassa с ключами клуба выбранной пары. Нет магазина — payment_failed (метод недоступен). */
export function clientFor(settings, config, { fetch } = {}) {
  if (!settings.online) throw new MoneyError('payment_failed', 'у клуба нет магазина ЮKassa');
  if (!config.encKey) throw new Error('нет SECRETS_ENC_KEY для расшифровки ключа магазина');
  const secretKey = decryptShopSecret(settings.secret_key_enc, config.encKey, settings.club_id, settings.shop_mode ?? 'live');
  return createYooKassaClient({
    apiUrl: config.yookassaApiUrl,
    shopId: settings.shop_id,
    secretKey,
    timeoutMs: config.yookassaTimeoutMs,
    fetch: fetch ?? config.fetch,
  });
}
