// Настройки денежного модуля из окружения (контракт M1 §5, §2.3, §11).
//
//   YOOKASSA_API_URL       адрес API ЮKassa, по умолчанию https://api.yookassa.ru/v3;
//                          в разработке — эмулятор tools/yookassa-emu/. При NODE_ENV=production
//                          допускается только https://api.yookassa.ru/v3.
//   YOOKASSA_TIMEOUT_MS    таймаут запроса к ЮKassa, по умолчанию 10000
//   PUBLIC_HOST            хост приложения гостя для return_url (https://{PUBLIC_HOST}/app/wait/{payment_id})
//   PAYMENT_RETURN_URL     шаблон return_url целиком, {payment_id} подставляется (необязательно)
//   DEV_ALLOW_ANY_MINUTES  1 — любые минуты в котировке (только не в проде, decisions №54)
//   SECRETS_ENC_KEY        ключ расшифровки секрета магазина (берётся из ctx.config.encKey)

import { loadEncKey } from '../lib/secrets.mjs';

export const PROD_YOOKASSA_URL = 'https://api.yookassa.ru/v3';

export class MoneyConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MoneyConfigError';
  }
}

export function loadMoneyConfig(env = process.env, base = {}) {
  const production = base.production ?? env.NODE_ENV === 'production';
  const apiUrl = (env.YOOKASSA_API_URL || PROD_YOOKASSA_URL).replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new MoneyConfigError('YOOKASSA_API_URL — неверный адрес');
  }
  if (production && apiUrl !== PROD_YOOKASSA_URL) {
    throw new MoneyConfigError(`при NODE_ENV=production YOOKASSA_API_URL — только ${PROD_YOOKASSA_URL}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new MoneyConfigError('YOOKASSA_API_URL — http(s)');
  const timeoutMs = Number(env.YOOKASSA_TIMEOUT_MS || 10_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 60_000) throw new MoneyConfigError('YOOKASSA_TIMEOUT_MS — от 500 до 60000');
  const publicHost = base.publicHost ?? (env.PUBLIC_HOST || 'localhost:8443');
  const returnUrlTemplate = env.PAYMENT_RETURN_URL || `https://${publicHost}/app/wait/{payment_id}`;
  if (!returnUrlTemplate.includes('{payment_id}')) throw new MoneyConfigError('PAYMENT_RETURN_URL должен содержать {payment_id}');
  const encKey = base.encKey ?? (env.SECRETS_ENC_KEY ? loadEncKey(env.SECRETS_ENC_KEY) : null);
  return {
    production,
    yookassaApiUrl: apiUrl,
    yookassaTimeoutMs: timeoutMs,
    returnUrlTemplate,
    publicHost,
    // Ускоренное время — никогда в проде (§2.3).
    devAllowAnyMinutes: !production && (base.devAllowAnyMinutes ?? env.DEV_ALLOW_ANY_MINUTES === '1'),
    encKey,
  };
}

let cached = null;

/** Конфигурация модуля: ctx.money.config (тесты, init) или окружение (один раз на процесс). */
export function moneyConfig(ctx) {
  if (ctx?.money?.config) return ctx.money.config;
  cached ??= loadMoneyConfig(process.env, ctx?.config ?? {});
  return cached;
}
