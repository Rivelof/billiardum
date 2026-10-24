// Настройки подписки клубов (M5.3 №183): магазин ЮKassa платформы — только из .env.
//
//   PLATFORM_YOOKASSA_SHOP_ID   магазин платформы (shopId); без пары модуль отвечает 503 billing_unavailable
//   PLATFORM_YOOKASSA_SECRET    секретный ключ магазина платформы (в лог и ответы не попадает)
//   PLATFORM_VAT_CODE           ставка НДС позиции чека «Подписка…» (1–12, по умолчанию 1 — без НДС)
//   PLATFORM_TAX_SYSTEM_CODE    система налогообложения платформы для чека (1–6, по желанию)
//   PLATFORM_BILLING_RETURN_URL куда ЮKassa вернёт владельца после оплаты (по умолчанию
//                               https://{PUBLIC_HOST}/club/subscription)
// Адрес API и таймаут — общие с деньгами гостей (YOOKASSA_API_URL, YOOKASSA_TIMEOUT_MS): в проде —
// только https://api.yookassa.ru/v3. Ключ шифрования способа оплаты — SECRETS_ENC_KEY.
//
// Секрет хранится в неперечисляемом поле: JSON.stringify(config) и лог объекта его не покажут.

import { moneyConfig } from '../payments/config.mjs';

const SHOP_ID = /^[0-9A-Za-z_-]{1,64}$/;
const SECRET = /^[\x21-\x7e]{8,200}$/;

export class BillingConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BillingConfigError';
  }
}

function intIn(value, min, max, name, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new BillingConfigError(`${name} — целое от ${min} до ${max}`);
  return n;
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {{ yookassaApiUrl: string, yookassaTimeoutMs: number, encKey: Buffer|null, publicHost?: string, production?: boolean }} money
 */
export function loadBillingConfig(env = process.env, money = {}) {
  const shopId = env.PLATFORM_YOOKASSA_SHOP_ID || null;
  const secret = env.PLATFORM_YOOKASSA_SECRET || null;
  if (shopId !== null && !SHOP_ID.test(shopId)) throw new BillingConfigError('PLATFORM_YOOKASSA_SHOP_ID — неверный вид');
  if (secret !== null && !SECRET.test(secret)) throw new BillingConfigError(`PLATFORM_YOOKASSA_SECRET — печатные символы ASCII, длина ${secret.length}`);
  const publicHost = money.publicHost ?? (env.PUBLIC_HOST || 'localhost:8443');
  const returnUrl = env.PLATFORM_BILLING_RETURN_URL || `https://${publicHost}/club/subscription`;
  let parsed;
  try {
    parsed = new URL(returnUrl);
  } catch {
    throw new BillingConfigError('PLATFORM_BILLING_RETURN_URL — неверный адрес');
  }
  if (parsed.protocol !== 'https:' && money.production) throw new BillingConfigError('PLATFORM_BILLING_RETURN_URL — только https');
  const config = {
    configured: Boolean(shopId && secret),
    shopId,
    apiUrl: money.yookassaApiUrl,
    timeoutMs: money.yookassaTimeoutMs ?? 10_000,
    encKey: money.encKey ?? null,
    vatCode: intIn(env.PLATFORM_VAT_CODE, 1, 12, 'PLATFORM_VAT_CODE', 1),
    taxSystemCode: intIn(env.PLATFORM_TAX_SYSTEM_CODE, 1, 6, 'PLATFORM_TAX_SYSTEM_CODE', null),
    returnUrl,
    returnOrigins: [parsed.origin, `https://${publicHost}`],
  };
  Object.defineProperty(config, 'secret', { value: secret, enumerable: false, writable: false });
  return config;
}

let cached = null;

/** Конфигурация модуля: ctx.billing.config (тесты, init) или окружение (один раз на процесс). */
export function billingConfig(ctx) {
  if (ctx?.billing?.config) return ctx.billing.config;
  cached ??= loadBillingConfig(process.env, { ...moneyConfig(ctx), publicHost: ctx?.config?.publicHost });
  return cached;
}
