// Денежный модуль без базы: клиент ЮKassa (на эмуляторе), чек 54-ФЗ, настройки,
// разбор котировки, план оплаты, провижининг.

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { randomBytes } from 'node:crypto';
import { createEmulator } from '../../../tools/yookassa-emu/lib/emulator.mjs';
import { decryptSecret } from '../../lib/secrets.mjs';
import { loadMoneyConfig, PROD_YOOKASSA_URL } from '../config.mjs';
import { MoneyError, fromNeighbor, checkNeighborResult } from '../errors.mjs';
import { payPlan, returnUrl } from '../pay.mjs';
import { provisionPayments } from '../provision-dev.mjs';
import { parseQuoteRequest } from '../quotes.mjs';
import { DECLINE_REASONS } from '../../reception/index.mjs';
import { itemDescription, receiptPhone, yookassaReceipt } from '../receipt.mjs';
import { stableUuid } from '../records.mjs';
import { clientFor, yookassaSecretContext, encryptShopSecret } from '../settings.mjs';
import { amountKopecks, createYooKassaClient, formatValue, parseValue, YooKassaError } from '../yookassa.mjs';

const SHOP = { shopId: '600001', secret: 'unit_secret' };
const RES = 'e1000000-0000-4000-8000-000000000001';
let emu;
let apiUrl;

before(async () => {
  emu = createEmulator({ shops: [SHOP] });
  const a = await emu.listen(0);
  apiUrl = `http://127.0.0.1:${a.port}/v3`;
});

after(async () => {
  await emu.close();
});

function body(value = '800.00') {
  return {
    amount: { value, currency: 'RUB' },
    capture: true,
    confirmation: { type: 'redirect', return_url: 'https://billiardum.test/app/wait/x' },
    payment_method_data: { type: 'bank_card' },
    metadata: { club_id: 'c1' },
    receipt: yookassaReceipt({ phone: '+79990000001', resourceNumber: 4, minutes: 60, amountKopecks: parseValue(value), settings: { vat_code: 1, tax_system_code: 2 } }),
  };
}

describe('деньги в формате ЮKassa', () => {
  it('копейки ↔ строка', () => {
    assert.equal(formatValue(160000), '1600.00');
    assert.equal(formatValue(5), '0.05');
    assert.equal(formatValue(0), '0.00');
    assert.throws(() => formatValue(1.5), RangeError);
    assert.throws(() => formatValue(-1), RangeError);
    assert.equal(parseValue('1600.00'), 160000);
    assert.equal(parseValue('1600'), 160000);
    assert.equal(parseValue('0.5'), 50);
    assert.equal(parseValue('1.234'), null);
    assert.equal(parseValue('-1.00'), null);
    assert.equal(parseValue('01.00'), null);
    assert.equal(parseValue(100), null);
    assert.equal(amountKopecks({ value: '10.00', currency: 'RUB' }), 1000);
    assert.equal(amountKopecks({ value: '10.00', currency: 'USD' }), null);
    assert.equal(amountKopecks(null), null);
  });
});

describe('клиент ЮKassa API v3 (проверено на эмуляторе)', () => {
  const client = () => createYooKassaClient({ apiUrl, shopId: SHOP.shopId, secretKey: SHOP.secret, timeoutMs: 2000 });

  it('создание и чтение платежа: Basic и Idempotence-Key', async () => {
    const p = await client().createPayment(body(), 'unit-key-1');
    assert.equal(p.status, 'pending');
    assert.match(p.confirmation.confirmation_url, /\/pay\//);
    const again = await client().createPayment(body(), 'unit-key-1');
    assert.equal(again.id, p.id);
    assert.deepEqual(await client().getPayment(p.id), p);
    const req = emu.state.requests.filter((r) => r.idempotence_key === 'unit-key-1');
    assert.equal(req.length, 2);
  });

  it('без ключа идемпотентности POST не уходит', async () => {
    await assert.rejects(client().createPayment(body(), ''), (e) => e instanceof YooKassaError && e.code === 'bad_idempotence_key');
    await assert.rejects(client().createPayment(body(), 'x'.repeat(65)), (e) => e.code === 'bad_idempotence_key');
  });

  it('400 ЮKassa — не повторять: код и параметр', async () => {
    const b = body();
    delete b.receipt;
    await assert.rejects(client().createPayment(b, 'unit-key-2'), (e) => e.status === 400 && e.code === 'invalid_request' && e.parameter === 'receipt' && !e.retryable);
  });

  it('401 — неверный ключ магазина', async () => {
    const bad = createYooKassaClient({ apiUrl, shopId: SHOP.shopId, secretKey: 'wrong' });
    await assert.rejects(bad.getPayment('abc'), (e) => e.status === 401 && e.code === 'invalid_credentials' && !e.retryable);
  });

  it('5xx — повторить позже', async () => {
    emu.config.failNext = { count: 1, status: 502 };
    await assert.rejects(client().getPayment('abc'), (e) => e.status === 502 && e.retryable);
  });

  it('таймаут и недоступный адрес — повторить позже', async () => {
    const slow = http.createServer(() => {});
    await new Promise((r) => slow.listen(0, '127.0.0.1', r));
    try {
      const c = createYooKassaClient({ apiUrl: `http://127.0.0.1:${slow.address().port}/v3`, shopId: 's', secretKey: 'k', timeoutMs: 500 });
      await assert.rejects(c.getPayment('abc'), (e) => e.code === 'timeout' && e.retryable);
    } finally {
      slow.closeAllConnections();
      await new Promise((r) => slow.close(r));
    }
    const down = createYooKassaClient({ apiUrl: 'http://127.0.0.1:9/v3', shopId: 's', secretKey: 'k', timeoutMs: 500 });
    await assert.rejects(down.getPayment('abc'), (e) => e.code === 'network' && e.retryable);
  });

  it('id объекта проверяется до запроса (нет подстановки пути)', async () => {
    await assert.rejects(client().getPayment('../refunds'), (e) => e.code === 'bad_id');
    await assert.rejects(client().capturePayment('a/b', {}, 'k'), (e) => e.code === 'bad_id');
  });

  it('секрет магазина не попадает в текст ошибки', async () => {
    const c = createYooKassaClient({ apiUrl, shopId: SHOP.shopId, secretKey: 'super-secret-value' });
    try {
      await c.getPayment('abc');
    } catch (e) {
      assert.ok(!String(e.message).includes('super-secret-value'));
      assert.ok(!JSON.stringify(e).includes('super-secret-value'));
    }
  });

  it('clientFor: секрет расшифровывается ключом SECRETS_ENC_KEY с контекстом клуба', async () => {
    const key = randomBytes(32);
    const club = 'c1000000-0000-4000-8000-000000000001';
    const settings = { club_id: club, online: true, shop_id: SHOP.shopId, secret_key_enc: encryptShopSecret(SHOP.secret, key, club) };
    const c = clientFor(settings, { encKey: key, yookassaApiUrl: apiUrl, yookassaTimeoutMs: 2000 });
    await assert.rejects(c.getPayment('nope'), (e) => e.status === 404);
    // Шифртекст другого клуба не расшифруется.
    assert.throws(() => clientFor({ ...settings, club_id: 'c2000000-0000-4000-8000-000000000002' }, { encKey: key, yookassaApiUrl: apiUrl }));
    assert.throws(() => clientFor({ ...settings, online: false }, { encKey: key }), (e) => e instanceof MoneyError && e.code === 'payment_failed');
  });
});

describe('чек 54-ФЗ', () => {
  it('позиция «Игра, стол N, X ч»', () => {
    assert.equal(itemDescription({ resourceNumber: 4, minutes: 120 }), 'Игра, стол 4, 2 ч');
    assert.equal(itemDescription({ resourceNumber: 4, minutes: 107 }), 'Игра, стол 4, 1 ч 47 мин');
    assert.equal(itemDescription({ resourceNumber: 12, minutes: 30 }), 'Игра, стол 12, 30 мин');
    assert.equal(itemDescription({ resourceNumber: 1, minutes: null }), 'Игра, стол 1, без лимита');
  });

  it('телефон гостя без «+», признаки расчёта, НДС и СНО клуба', () => {
    assert.equal(receiptPhone('+79990000001'), '79990000001');
    assert.equal(receiptPhone('79990000001'), null);
    assert.equal(receiptPhone(null), null);
    const r = yookassaReceipt({ phone: '+79990000001', resourceNumber: 4, minutes: 60, amountKopecks: 80000, settings: { vat_code: 4, tax_system_code: 1 } });
    assert.deepEqual(r, {
      customer: { phone: '79990000001' },
      items: [{ description: 'Игра, стол 4, 1 ч', quantity: 1, amount: { value: '800.00', currency: 'RUB' }, vat_code: 4, payment_mode: 'full_payment', payment_subject: 'service' }],
      tax_system_code: 1,
    });
    const noTax = yookassaReceipt({ phone: '+79990000001', resourceNumber: 4, minutes: 60, amountKopecks: 80000, settings: { vat_code: 1, tax_system_code: null } });
    assert.equal('tax_system_code' in noTax, false);
    assert.throws(() => yookassaReceipt({ phone: null, resourceNumber: 4, minutes: 60, amountKopecks: 1, settings: { vat_code: 1 } }));
  });
});

describe('настройки', () => {
  it('по умолчанию — боевой адрес ЮKassa, return_url на экран ожидания', () => {
    const c = loadMoneyConfig({});
    assert.equal(c.yookassaApiUrl, PROD_YOOKASSA_URL);
    assert.equal(returnUrl(c, 'p1'), 'https://localhost:8443/app/wait/p1');
    assert.equal(returnUrl(loadMoneyConfig({ PUBLIC_HOST: 'billiardum.ru' }), 'p1'), 'https://billiardum.ru/app/wait/p1');
    assert.equal(c.devAllowAnyMinutes, false);
  });

  it('в проде — только api.yookassa.ru и без DEV_ALLOW_ANY_MINUTES', () => {
    assert.throws(() => loadMoneyConfig({ NODE_ENV: 'production', YOOKASSA_API_URL: 'http://yookassa-emu:8090/v3' }));
    assert.equal(loadMoneyConfig({ NODE_ENV: 'production', DEV_ALLOW_ANY_MINUTES: '1' }).devAllowAnyMinutes, false);
    assert.equal(loadMoneyConfig({}, { production: true, devAllowAnyMinutes: true }).devAllowAnyMinutes, false);
    assert.equal(loadMoneyConfig({ DEV_ALLOW_ANY_MINUTES: '1' }).devAllowAnyMinutes, true);
  });

  it('неверные значения — ошибка', () => {
    assert.throws(() => loadMoneyConfig({ YOOKASSA_API_URL: 'ftp://x' }));
    assert.throws(() => loadMoneyConfig({ YOOKASSA_TIMEOUT_MS: '10' }));
    assert.throws(() => loadMoneyConfig({ PAYMENT_RETURN_URL: 'https://x/app' }));
  });
});

describe('котировка и план оплаты', () => {
  it('разбор запроса котировки', () => {
    assert.deepEqual(parseQuoteRequest({ resource_id: RES, kind: 'start', minutes: 60 }), { resourceId: RES, kind: 'start', minutes: 60, sessionId: null, exact: false, useBalance: false });
    assert.equal(parseQuoteRequest({ resource_id: RES, kind: 'start', minutes: null }).minutes, null);
    for (const bad of [null, {}, { resource_id: 'x', kind: 'start', minutes: 60 }, { resource_id: RES, kind: 'start', minutes: 90 }, { resource_id: RES, kind: 'start', minutes: '60' }, { resource_id: RES, kind: 'start' }]) {
      assert.throws(() => parseQuoteRequest(bad), (e) => e.code === 'bad_request', JSON.stringify(bad));
    }
    assert.equal(parseQuoteRequest({ resource_id: RES, kind: 'start', minutes: 7 }, { devAllowAnyMinutes: true }).exact, true);
    assert.equal(parseQuoteRequest({ resource_id: RES, kind: 'start', minutes: 60 }, { devAllowAnyMinutes: true }).exact, false);
    assert.throws(() => parseQuoteRequest({ resource_id: RES, kind: 'start', minutes: 0 }, { devAllowAnyMinutes: true }));
  });

  it('«Без лимита»: карта — заморозка, СБП — блок, ресепшн — предоплата как обычное время', () => {
    const q = { amount_kopecks: '100000', minutes: null, unlimited: true, hold_minutes: 120, block_minutes: 30, block_amount_kopecks: '25000' };
    assert.deepEqual(payPlan(q, 'card', {}), { amount: 100000, minutes: 120, capture: false, unlimited: true });
    assert.deepEqual(payPlan(q, 'sbp', {}), { amount: 25000, minutes: 30, capture: true, unlimited: true });
    assert.deepEqual(payPlan(q, 'reception', {}), { amount: 100000, minutes: 120, capture: true, unlimited: false });
    assert.deepEqual(payPlan({ amount_kopecks: '80000', minutes: 60, unlimited: false }, 'card', {}), { amount: 80000, minutes: 60, capture: true, unlimited: false });
  });

  it('id платежа детерминирован (повтор после сбоя — тот же return_url и ключ ЮKassa)', () => {
    const a = stableUuid('bl.payment/q/sbp');
    assert.equal(a, stableUuid('bl.payment/q/sbp'));
    assert.notEqual(a, stableUuid('bl.payment/q/card'));
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('коды отклонения заявки ресепшена — строго по §14', () => {
    assert.deepEqual([...DECLINE_REASONS], ['guest_left', 'guest_cancelled', 'payment_failed', 'table_problem', 'other']);
  });

  it('ошибки light переводятся в коды словаря', () => {
    assert.equal(fromNeighbor(Object.assign(new Error('x'), { code: 'table_pending' })).code, 'table_pending');
    const other = new Error('db down');
    assert.equal(fromNeighbor(other), other);
    assert.throws(() => checkNeighborResult({ error: 'table_busy' }), (e) => e.code === 'table_busy');
    assert.deepEqual(checkNeighborResult({ ok: true }), { ok: true });
  });

  it('M4-I1: стол турнира — table_busy с reason и busy_until доходит до QR; лишнее и не того вида отбрасывается', () => {
    const busy = '2026-10-26T09:00:00.000Z';
    const light = Object.assign(new Error('table_busy: tournament'), { code: 'table_busy', data: { reason: 'tournament', busy_until: busy } });
    const e = fromNeighbor(light);
    assert.ok(e instanceof MoneyError);
    assert.deepEqual([e.status, e.code, e.data], [409, 'table_busy', { reason: 'tournament', busy_until: busy }]);
    const dirty = fromNeighbor(Object.assign(new Error('x'), { code: 'table_busy', data: { reason: 'Турнир до 14:00', busy_until: 'завтра', phone: '+79991234567' } }));
    assert.equal(dirty.data, undefined, 'свободный текст, не время и чужие поля не уходят клиенту');
    const booking = fromNeighbor(Object.assign(new Error('x'), { code: 'booking_start_required', data: { booking_id: RES } }));
    assert.deepEqual(booking.data, { booking_id: RES });
  });
});

describe('провижининг разработки', () => {
  function fakeClient() {
    const queries = [];
    return {
      queries,
      async query(sql, params) {
        queries.push({ sql, params });
        if (/from bl\.clubs/.test(sql)) return { rowCount: 1, rows: [{}] };
        return { rowCount: 1, rows: [] };
      },
    };
  }

  it('в проде — отказ; без переменных эмулятора — пропуск', async () => {
    await assert.rejects(provisionPayments({ client: fakeClient(), env: { NODE_ENV: 'production' } }));
    assert.deepEqual(await provisionPayments({ client: fakeClient(), env: {} }), { status: 'skipped', reason: 'no_emu_shop' });
  });

  it('секрет пишется зашифрованным (AES-256-GCM, контекст клуба), в лог — только длина', async () => {
    const key = randomBytes(32);
    const c = fakeClient();
    const logs = [];
    const r = await provisionPayments({
      client: c,
      env: { YOOKASSA_EMU_SHOP_ID: '700001', YOOKASSA_EMU_SECRET: 'emu-secret-123', SECRETS_ENC_KEY: key.toString('base64') },
      log: (...a) => logs.push(a),
    });
    assert.equal(r.status, 'ok');
    const ins = c.queries.find((q) => /club_payment_settings/.test(q.sql));
    assert.equal(ins.params[1], '700001');
    assert.ok(ins.params[2].startsWith('v1:'));
    assert.ok(!ins.params[2].includes('emu-secret-123'));
    assert.equal(decryptSecret(ins.params[2], key, yookassaSecretContext(r.club_id)).toString(), 'emu-secret-123');
    assert.ok(!JSON.stringify(logs).includes('emu-secret-123'));
  });
});
