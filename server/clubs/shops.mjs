// Магазины ЮKassa клуба: тестовый и боевой (M5.1 №154).
//
// * GET/PUT /api/clubs/{club}/payment-settings/{test|live} — только владелец. Сохранение
//   проверяет пару запросом GET /v3/me: пара верная (account_id = shop_id), у test — test: true,
//   у live — test: false и fiscalization_enabled: true. Неверно — 400 shop_invalid,
//   shop_mode_mismatch, fiscalization_off; ЮKassa не ответила — 503 yookassa_unavailable;
//   ничего не сохраняется. Магазин платформы (PLATFORM_YOOKASSA_SHOP_ID) — 400 shop_invalid (№188).
//   Секрет — только зашифрованным (№23), наружу — маска
//   { last4, length }.
// * Клуб в боевом режиме (live, или приостановлен после live): изменение магазина — ручное
//   действие владельца: причина, журнал manual.payment_settings, тревога владельцу (инвариант 8).
//   В test — журнал club.payment_settings без причины.
// * Проверочный платёж 1 ₽ (POST …/payment-settings/{mode}/check): платёж в магазин пары с чеком
//   (ЮKassa формирует его сама, инвариант 7), после подтверждения — автоматический возврат с
//   чеком возврата. Статус — в GET …/onboarding (payment_checks). Вебхук отмечается
//   (onShopCheckWebhook); подтверждён сверкой, а вебхука нет 10 минут — тревога
//   yookassa_webhook_missing «вебхук ЮKassa не настроен».

import { randomUUID } from 'node:crypto';
import { HttpError } from '../http/errors.mjs';
import { appendAudit } from '../lib/audit.mjs';
import { isLiveClub } from '../lib/club-mode.mjs';
import { clientFor, decryptShopSecret, encryptShopSecret, loadPaymentSettings, SHOP_MODES } from '../payments/settings.mjs';
import { receiptPhone } from '../payments/receipt.mjs';
import { amountKopecks, createYooKassaClient, YooKassaError } from '../payments/yookassa.mjs';

export const CHECK_AMOUNT_KOPECKS = 100;
export const WEBHOOK_WAIT_MS = 10 * 60_000;
const SHOP_ID = /^[0-9A-Za-z_-]{1,64}$/;
/** Секретный ключ ЮKassa: печатные символы ASCII без пробелов (test_…, live_…). */
const SECRET = /^[\x21-\x7e]{8,200}$/;

const iso = (v) => (v instanceof Date ? v.toISOString() : (v ?? null));

/** Маска секрета: последние 4 символа и длина (№154). */
export function secretMask(secret) {
  if (typeof secret !== 'string' || secret.length === 0) return null;
  return { last4: secret.length > 4 ? secret.slice(-4) : '', length: secret.length };
}

export function parseMode(mode) {
  if (!SHOP_MODES.includes(mode)) throw new HttpError(404, 'not_found', { detail: 'mode' });
  return mode;
}

/** Клуб в боевом режиме для правил денег: live или приостановлен после live (общая функция). */
export { isLiveClub };

async function settingsRow(db, clubId) {
  const { rows } = await db.query(
    `select s.*, c.mode as club_mode, c.mode_before_suspend
       from bl.clubs c left join bl.club_payment_settings s on s.club_id = c.id where c.id = $1`,
    [clubId],
  );
  return rows[0] ?? null;
}

function pairOf(row, mode) {
  if (!row) return { shopId: null, enc: null };
  return mode === 'test' ? { shopId: row.test_shop_id ?? null, enc: row.test_secret_key_enc ?? null } : { shopId: row.shop_id ?? null, enc: row.secret_key_enc ?? null };
}

/** Ответ магазина пары: { mode, shop_id, secret_mask, verified_at, test, fiscalization, account_id }. */
export function shopJson(row, mode, encKey) {
  const { shopId, enc } = pairOf(row, mode);
  if (!shopId) return { mode, shop_id: null, secret_mask: null, verified_at: null, test: null, fiscalization: null, account_id: null };
  let mask;
  try {
    mask = encKey ? secretMask(decryptShopSecret(enc, encKey, row.club_id, mode)) : null;
  } catch {
    mask = null; // ключ шифрования сменился: магазин нужно сохранить заново
  }
  const me = row[`${mode}_me`] ?? null;
  return {
    mode,
    shop_id: shopId,
    secret_mask: mask,
    verified_at: iso(row[`${mode}_verified_at`]),
    test: typeof me?.test === 'boolean' ? me.test : null,
    fiscalization: typeof me?.fiscalization_enabled === 'boolean' ? me.fiscalization_enabled : null,
    account_id: typeof me?.account_id === 'string' ? me.account_id : null,
  };
}

/** GET …/payment-settings/{mode}. */
export async function getShop(db, { clubId, mode, encKey }) {
  return shopJson(await settingsRow(db, clubId), parseMode(mode), encKey);
}

/**
 * Проверка пары запросом GET /v3/me (без записи в базу).
 * @returns {Promise<{ account_id: string, test: boolean, fiscalization_enabled: boolean }>}
 */
export async function verifyPair({ shopId, secret, mode, config, fetch }) {
  let me;
  try {
    const client = createYooKassaClient({ apiUrl: config.yookassaApiUrl, shopId, secretKey: secret, timeoutMs: config.yookassaTimeoutMs, fetch: fetch ?? config.fetch });
    me = await client.getMe();
  } catch (err) {
    if (err instanceof YooKassaError && (err.retryable || err.status === 0)) throw new HttpError(503, 'yookassa_unavailable', { detail: err.code });
    if (err instanceof YooKassaError) throw new HttpError(400, 'shop_invalid', { detail: err.code });
    throw err;
  }
  const accountId = me?.account_id === undefined || me?.account_id === null ? null : String(me.account_id);
  if (accountId !== shopId) throw new HttpError(400, 'shop_invalid', { detail: 'account_id' });
  if (typeof me.test !== 'boolean') throw new HttpError(400, 'shop_invalid', { detail: 'test' });
  if ((mode === 'test') !== me.test) throw new HttpError(400, 'shop_mode_mismatch', { detail: `test=${me.test}` });
  if (mode === 'live' && me.fiscalization_enabled !== true) throw new HttpError(400, 'fiscalization_off');
  return { account_id: accountId, test: me.test, fiscalization_enabled: me.fiscalization_enabled === true };
}

/**
 * PUT …/payment-settings/{mode} {shop_id, secret_key?, reason?}. Без secret_key — прежний ключ этой
 * пары (тот же shop_id). Возвращает shopJson.
 * @param {{ clubId: string, userId: string, mode: string, body: object, config: object, now: Date,
 *           manual: (entry: object) => Promise<object>, fetch?: Function }} args
 */
export async function putShop(db, { clubId, userId, mode, body, config, now, manual, fetch }) {
  parseMode(mode);
  if (!config.encKey) throw new Error('нет SECRETS_ENC_KEY');
  const shopId = typeof body?.shop_id === 'string' ? body.shop_id.trim() : body?.shop_id;
  if (typeof shopId !== 'string' || !SHOP_ID.test(shopId)) throw new HttpError(400, 'bad_request', { detail: 'shop_id' });
  // №188: магазин клуба не может совпадать с магазином платформы (подписка клубов, M5.3) — деньги
  // гостей и деньги платформы не пересекаются.
  const platformShopId = config.platformShopId ?? process.env.PLATFORM_YOOKASSA_SHOP_ID ?? null;
  if (platformShopId && shopId === platformShopId) throw new HttpError(400, 'shop_invalid', { detail: 'platform shop' });
  const row = await settingsRow(db, clubId);
  if (!row) throw new HttpError(404, 'not_found');
  const live = isLiveClub(row.club_mode, row.mode_before_suspend);
  // Причина — до сети: без неё в live ничего не проверяем и не меняем.
  if (live && (typeof body?.reason !== 'string' || body.reason.trim() === '')) throw new HttpError(400, 'reason_required');
  let secret = body?.secret_key;
  const prev = pairOf(row, mode);
  if (secret === undefined || secret === null || secret === '') {
    if (!prev.enc || prev.shopId !== shopId) throw new HttpError(400, 'bad_request', { detail: 'secret_key' });
    secret = decryptShopSecret(prev.enc, config.encKey, clubId, mode);
  }
  if (typeof secret !== 'string' || !SECRET.test(secret)) throw new HttpError(400, 'bad_request', { detail: 'secret_key' });
  const me = await verifyPair({ shopId, secret, mode, config, fetch });
  const enc = encryptShopSecret(secret, config.encKey, clubId, mode);
  await db.query('insert into bl.club_payment_settings (club_id) values ($1) on conflict (club_id) do nothing', [clubId]);
  const cols = mode === 'test'
    ? 'test_shop_id = $2, test_secret_key_enc = $3, test_verified_at = $4, test_me = $5'
    : 'shop_id = $2, secret_key_enc = $3, live_verified_at = $4, live_me = $5';
  await db.query(`update bl.club_payment_settings set ${cols}, updated_at = $4 where club_id = $1`, [clubId, shopId, enc, now, JSON.stringify(me)]);
  const data = { mode, shop_id: shopId, previous_shop_id: prev.shopId, secret_changed: !prev.enc || body?.secret_key !== undefined, test: me.test, fiscalization: me.fiscalization_enabled };
  if (live) {
    await manual({
      action: 'manual.payment_settings',
      reason: body.reason,
      objectType: 'club',
      objectId: clubId,
      data,
      text: `Изменён ${mode === 'live' ? 'боевой' : 'тестовый'} магазин ЮKassa клуба (магазин ${shopId}).`,
    });
  } else {
    await appendAudit(db, { action: 'club.payment_settings', objectType: 'club', objectId: clubId, actorType: 'user', actorId: userId, data, reason: typeof body?.reason === 'string' ? body.reason : null });
  }
  return shopJson(await settingsRow(db, clubId), mode, config.encKey);
}

/** Общие настройки денег клуба для мастера: касса ресепшена, способы, НДС, СНО. */
export const GENERAL_FIELDS = Object.freeze({
  reception_enabled: (v) => typeof v === 'boolean',
  sbp_enabled: (v) => typeof v === 'boolean',
  card_enabled: (v) => typeof v === 'boolean',
  vat_code: (v) => Number.isInteger(v) && v >= 1 && v <= 12,
  tax_system_code: (v) => v === null || (Number.isInteger(v) && v >= 1 && v <= 6),
});

export function generalJson(row) {
  return {
    reception_enabled: row?.reception_enabled ?? true,
    sbp_enabled: row?.sbp_enabled ?? true,
    card_enabled: row?.card_enabled ?? true,
    vat_code: row?.vat_code ?? 1,
    tax_system_code: row?.tax_system_code ?? null,
  };
}

/** PATCH …/payment-settings {reception_enabled?, sbp_enabled?, card_enabled?, vat_code?, tax_system_code?, reason?}. */
export async function patchGeneral(db, { clubId, userId, body, now, manual }) {
  const fields = {};
  for (const [k, ok] of Object.entries(GENERAL_FIELDS)) {
    if (body?.[k] === undefined) continue;
    if (!ok(body[k])) throw new HttpError(400, 'bad_request', { detail: k });
    fields[k] = body[k];
  }
  const keys = Object.keys(fields);
  if (keys.length === 0) throw new HttpError(400, 'bad_request');
  const row = await settingsRow(db, clubId);
  if (!row) throw new HttpError(404, 'not_found');
  const live = isLiveClub(row.club_mode, row.mode_before_suspend);
  if (live && (typeof body?.reason !== 'string' || body.reason.trim() === '')) throw new HttpError(400, 'reason_required');
  await db.query('insert into bl.club_payment_settings (club_id) values ($1) on conflict (club_id) do nothing', [clubId]);
  await db.query(
    `update bl.club_payment_settings set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = $${keys.length + 2} where club_id = $1`,
    [clubId, ...keys.map((k) => fields[k]), now],
  );
  const before = generalJson(row);
  const data = { fields: keys, before: Object.fromEntries(keys.map((k) => [k, before[k]])), after: fields };
  if (live) {
    await manual({ action: 'manual.payment_settings', reason: body.reason, objectType: 'club', objectId: clubId, data, text: 'Изменены настройки оплаты клуба.' });
  } else {
    await appendAudit(db, { action: 'club.payment_settings', objectType: 'club', objectId: clubId, actorType: 'user', actorId: userId, data });
  }
  return generalJson(await settingsRow(db, clubId));
}

// Проверочный платёж 1 ₽ ----------------------------------------------------------------------

const STATUS = { pending: 'pending', waiting_for_capture: 'pending', succeeded: 'succeeded', canceled: 'canceled' };

/** Вид проверочного платежа для мастера (payment_checks[mode]). */
export function checkJson(c) {
  if (!c) return null;
  return {
    payment_id: c.id,
    status: c.status,
    refunded: c.refund_status === 'succeeded',
    refund_status: c.refund_status ?? null,
    webhook_at: iso(c.webhook_at),
    confirmed_at: iso(c.confirmed_at),
    confirmed_via: c.confirmed_via ?? null,
    confirmation_url: c.status === 'pending' ? (c.confirmation_url ?? null) : null,
    created_at: iso(c.created_at),
  };
}

/** Последний проверочный платёж по каждой паре: { test, live }. */
export async function lastChecks(db, clubId) {
  const { rows } = await db.query(
    `select distinct on (mode) * from bl.shop_checks where club_id = $1 order by mode, created_at desc, id desc`,
    [clubId],
  );
  const out = { test: null, live: null };
  for (const r of rows) out[r.mode] = checkJson(r);
  return out;
}

function checkReceipt({ phone, settings }) {
  const receipt = {
    customer: { phone },
    items: [
      {
        description: 'Проверка подключения магазина',
        quantity: 1,
        amount: { value: '1.00', currency: 'RUB' },
        vat_code: settings.vat_code ?? 1,
        payment_mode: 'full_payment',
        payment_subject: 'service',
      },
    ],
  };
  if (settings.tax_system_code != null) receipt.tax_system_code = settings.tax_system_code;
  return receipt;
}

function providerError(err) {
  if (err instanceof YooKassaError && err.retryable) return new HttpError(503, 'yookassa_unavailable', { detail: err.code });
  if (err instanceof YooKassaError && (err.status === 401 || err.status === 403)) return new HttpError(400, 'shop_invalid', { detail: err.code });
  if (err instanceof YooKassaError) return new HttpError(409, 'payment_failed', { detail: err.code });
  return err;
}

/**
 * POST …/payment-settings/{mode}/check → { payment_id, status, confirmation_url }.
 * Платёж 1 ₽ в магазин пары; чек — на телефон владельца, который запустил проверку.
 */
export async function createCheck(db, { clubId, userId, mode, config, now, returnUrl, fetch }) {
  parseMode(mode);
  const settings = await loadPaymentSettings(db, clubId, { mode });
  if (!settings.online) throw new HttpError(409, 'not_configured', { detail: `магазин ${mode} не задан` });
  const { rows: u } = await db.query('select phone from bl.users where id = $1', [userId]);
  const phone = receiptPhone(u[0]?.phone);
  if (!phone) throw new HttpError(403, 'phone_required');
  const id = randomUUID();
  const key = `chk-${id}`;
  const body = {
    amount: { value: '1.00', currency: 'RUB' },
    capture: true,
    confirmation: { type: 'redirect', return_url: returnUrl },
    description: 'Проверочный платёж Бильярдума (вернётся автоматически)',
    metadata: { club_id: clubId, shop_check_id: id, kind: 'shop_check' },
    receipt: checkReceipt({ phone, settings }),
  };
  let remote;
  try {
    remote = await clientFor(settings, config, { fetch }).createPayment(body, key);
  } catch (err) {
    throw providerError(err);
  }
  const status = STATUS[remote?.status] ?? 'pending';
  await db.query(
    `insert into bl.shop_checks (id, club_id, mode, shop_id, provider_payment_id, idempotence_key, status, confirmation_url, created_by, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
    [id, clubId, mode, settings.shop_id, remote.id, key, status, remote?.confirmation?.confirmation_url ?? null, userId, now],
  );
  await appendAudit(db, { action: 'club.shop_check', objectType: 'shop_check', objectId: id, actorType: 'user', actorId: userId, data: { check_id: id, mode, shop_id: settings.shop_id } });
  return { payment_id: id, status, confirmation_url: remote?.confirmation?.confirmation_url ?? null };
}

/**
 * Применить состояние платежа ЮKassa к проверочному платежу и, если он прошёл, оформить возврат.
 * via — 'webhook' | 'sync'. Возвращает обновлённую строку.
 */
async function applyCheck(db, deps, config, c, { via, now }) {
  const settings = await loadPaymentSettings(db, c.club_id, { mode: c.mode });
  if (!settings.online || settings.shop_id !== c.shop_id) {
    // Пару сменили: старый платёж этой парой не проверить — только отметить вебхук.
    await db.query('update bl.shop_checks set checked_at = $2, error = $3, updated_at = $2 where id = $1', [c.id, now, 'shop_changed']);
    return c;
  }
  const client = clientFor(settings, config);
  const remote = await client.getPayment(c.provider_payment_id);
  const meta = remote?.metadata ?? {};
  if (remote?.id !== c.provider_payment_id || meta.shop_check_id !== c.id || amountKopecks(remote?.amount) !== CHECK_AMOUNT_KOPECKS) {
    deps.log?.error?.('shop_check_mismatch', { club_id: c.club_id, check_id: c.id });
    await db.query('update bl.shop_checks set checked_at = $2, error = $3, updated_at = $2 where id = $1', [c.id, now, 'mismatch']);
    return c;
  }
  const status = STATUS[remote.status] ?? 'pending';
  let row;
  if (status !== c.status && c.status === 'pending') {
    const { rows } = await db.query(
      `update bl.shop_checks
          set status = $2, confirmed_at = case when $2 = 'succeeded' then $3 else confirmed_at end,
              confirmed_via = case when $2 = 'succeeded' then $4 else confirmed_via end, checked_at = $3, updated_at = $3
        where id = $1 returning *`,
      [c.id, status, now, via],
    );
    row = rows[0];
    deps.log?.info?.('shop_check_status', { club_id: c.club_id, check_id: c.id, status, via });
  } else {
    const { rows } = await db.query('update bl.shop_checks set checked_at = $2, updated_at = $2 where id = $1 returning *', [c.id, now]);
    row = rows[0];
  }
  if (row.status === 'succeeded' && row.refund_status !== 'succeeded' && row.refund_status !== 'canceled') row = await refundCheck(db, deps, client, row, { now });
  return row;
}

/** Возврат 1 ₽ (ключ chk-ref-<id>: повтор не делает второго возврата) с чеком возврата. */
async function refundCheck(db, deps, client, c, { now }) {
  const { rows: u } = await db.query('select phone from bl.users where id = $1', [c.created_by]);
  const phone = receiptPhone(u[0]?.phone);
  const settings = await loadPaymentSettings(db, c.club_id, { mode: c.mode });
  let remote;
  try {
    if (c.refund_provider_id) remote = await client.getRefund(c.refund_provider_id);
    else {
      remote = await client.createRefund(
        { payment_id: c.provider_payment_id, amount: { value: '1.00', currency: 'RUB' }, description: 'Возврат проверочного платежа', receipt: checkReceipt({ phone, settings }) },
        `chk-ref-${c.id}`,
      );
    }
  } catch (err) {
    deps.log?.warn?.('shop_check_refund_failed', { club_id: c.club_id, check_id: c.id, code: err.code ?? null });
    return c;
  }
  const refundStatus = ['pending', 'succeeded', 'canceled'].includes(remote?.status) ? remote.status : 'pending';
  const { rows } = await db.query(
    `update bl.shop_checks set refund_provider_id = $2, refund_status = $3, refunded_at = case when $3 = 'succeeded' then $4 else refunded_at end, updated_at = $4
      where id = $1 returning *`,
    [c.id, remote?.id ?? null, refundStatus, now],
  );
  if (refundStatus === 'succeeded' && c.refund_status !== 'succeeded') {
    await appendAudit(db, { action: 'club.shop_check_refunded', objectType: 'shop_check', objectId: c.id, actorType: 'system', actorId: null, data: { check_id: c.id, mode: c.mode } });
  }
  return rows[0];
}

/**
 * Вебхук ЮKassa по проверочному платежу (server/payments/webhook.mjs). Транзакция — в контексте клуба.
 * true — обработан (200), false — повторить позже (503).
 */
export async function onShopCheckWebhook(db, deps, config, c) {
  const now = deps.clock.now();
  if (!c.webhook_at) await db.query('update bl.shop_checks set webhook_at = $2, updated_at = $2 where id = $1', [c.id, now]);
  try {
    await applyCheck(db, deps, config, { ...c, webhook_at: c.webhook_at ?? now }, { via: 'webhook', now });
    return true;
  } catch (err) {
    if (err instanceof YooKassaError && err.retryable) return false;
    if (err instanceof YooKassaError && err.status === 404) return true;
    throw err;
  }
}

/** Планировщик: сверить ожидающий проверочный платёж или дооформить возврат. */
export async function syncCheck(db, deps, config, checkId) {
  const { rows } = await db.query('select * from bl.shop_checks where id = $1 for update', [checkId]);
  const c = rows[0];
  if (!c) return null;
  return applyCheck(db, deps, config, c, { via: 'sync', now: deps.clock.now() });
}

const WEBHOOK_TEXT = (mode) =>
  `Вебхук ЮKassa не настроен: ${mode === 'test' ? 'тестовый' : 'боевой'} магазин принял платёж, а уведомления нет больше 10 минут. Укажите адрес уведомлений в кабинете ЮKassa.`;

/** Тревога «вебхук ЮKassa не настроен» по паре клуба (одна открытая на пару). */
async function raiseWebhookMissing(db, deps, { clubId, mode, data }) {
  await deps.alarms.raise(db, clubId, {
    type: 'yookassa_webhook_missing',
    level: 'important',
    data: { mode, ...data },
    dedupeKey: `yookassa_webhook:${mode}`,
    text: WEBHOOK_TEXT(mode),
  });
  deps.log?.warn?.('yookassa_webhook_missing', { club_id: clubId, mode });
}

/** Проверочный платёж подтверждён сверкой, вебхука нет 10 минут. */
export async function checkWebhookMissing(db, deps, checkId) {
  const now = deps.clock.now();
  const { rows } = await db.query('select * from bl.shop_checks where id = $1 for update', [checkId]);
  const c = rows[0];
  if (!c || c.webhook_at || c.alarmed_at || c.status !== 'succeeded' || !c.confirmed_at) return false;
  if (now.getTime() - new Date(c.confirmed_at).getTime() < WEBHOOK_WAIT_MS) return false;
  await db.query('update bl.shop_checks set alarmed_at = $2, updated_at = $2 where id = $1', [c.id, now]);
  await raiseWebhookMissing(db, deps, { clubId: c.club_id, mode: c.mode, data: { check_id: c.id } });
  return true;
}

/** Платёж гостя подтверждён сверкой, вебхука нет 10 минут. */
export async function paymentWebhookMissing(db, deps, paymentId) {
  const now = deps.clock.now();
  const { rows } = await db.query('select id, club_id, is_test, confirmed_at, webhook_at, webhook_alarm_at from bl.payments where id = $1 for update', [paymentId]);
  const p = rows[0];
  if (!p || p.webhook_at || p.webhook_alarm_at || !p.confirmed_at) return false;
  if (now.getTime() - new Date(p.confirmed_at).getTime() < WEBHOOK_WAIT_MS) return false;
  await db.query('update bl.payments set webhook_alarm_at = $2 where id = $1', [p.id, now]);
  await raiseWebhookMissing(db, deps, { clubId: p.club_id, mode: p.is_test ? 'test' : 'live', data: { payment_id: p.id } });
  return true;
}
