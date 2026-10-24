// Эмулятор ЮKassa: API v3, чек обязателен, страница подтверждения, вебхуки, управление.

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createEmulator } from '../lib/emulator.mjs';

const SHOP = { shopId: '500001', secret: 'test_secret_key_A' };
const SHOP_B = { shopId: '500002', secret: 'test_secret_key_B' };
const CLUB = 'c1000000-0000-4000-8000-000000000001';

let emu;
let base;
let hook;
let hookUrl;
const received = [];
let hookStatus = [];

function auth(shop = SHOP) {
  return `Basic ${Buffer.from(`${shop.shopId}:${shop.secret}`).toString('base64')}`;
}

async function api(method, path, { body, key, shop = SHOP, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(shop ? { authorization: auth(shop) } : {}),
      ...(key ? { 'idempotence-key': key } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

function receipt(value, { qty = 1, phone = '79990000001' } = {}) {
  return {
    customer: { phone },
    items: [{ description: 'Игра, стол 4, 2 ч', quantity: qty, amount: { value, currency: 'RUB' }, vat_code: 1, payment_mode: 'full_payment', payment_subject: 'service' }],
    tax_system_code: 2,
  };
}

function payment(value = '1600.00', extra = {}) {
  return {
    amount: { value, currency: 'RUB' },
    capture: true,
    confirmation: { type: 'redirect', return_url: 'https://billiardum.test/app/pay/x' },
    payment_method_data: { type: 'sbp' },
    description: 'Стол 4, 2 ч',
    metadata: { club_id: CLUB, quote_id: 'q1', kind: 'start' },
    receipt: receipt(value),
    ...extra,
  };
}

let keyN = 0;
const key = () => `k-${process.pid}-${(keyN += 1)}`;

before(async () => {
  hook = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    received.push({ url: req.url, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(hookStatus.shift() ?? 200);
    res.end('ok');
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${hook.address().port}/api/webhooks/yookassa/{club_id}`;
  emu = createEmulator({ shops: [SHOP, SHOP_B], webhookUrl: hookUrl, webhookRetries: 3, webhookRetryDelayMs: 5 });
  const addr = await emu.listen(0);
  base = `http://127.0.0.1:${addr.port}`;
  emu.config.publicUrl = base;
});

after(async () => {
  await emu.settle();
  await emu.close();
  await new Promise((r) => hook.close(r));
});

beforeEach(() => {
  received.length = 0;
  hookStatus = [];
});

describe('API v3: платёж', () => {
  it('без авторизации и с неверным ключом — 401', async () => {
    assert.equal((await api('GET', '/v3/payments/x', { shop: null })).status, 401);
    const r = await api('GET', '/v3/payments/x', { shop: { shopId: SHOP.shopId, secret: 'wrong' } });
    assert.equal(r.status, 401);
    assert.equal(r.json.type, 'error');
    assert.equal(r.json.code, 'invalid_credentials');
  });

  it('без Idempotence-Key — 400', async () => {
    const r = await api('POST', '/v3/payments', { body: payment() });
    assert.equal(r.status, 400);
    assert.equal(r.json.parameter, 'Idempotence-Key');
  });

  it('без чека — 400 (инвариант 7)', async () => {
    const body = payment();
    delete body.receipt;
    const r = await api('POST', '/v3/payments', { body, key: key() });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'invalid_request');
    assert.equal(r.json.parameter, 'receipt');
  });

  it('сумма позиций не равна сумме платежа — 400', async () => {
    const r = await api('POST', '/v3/payments', { body: payment('1600.00', { receipt: receipt('1500.00') }), key: key() });
    assert.equal(r.status, 400);
    assert.equal(r.json.parameter, 'receipt.items');
  });

  it('сумма позиций с количеством считается как цена × количество', async () => {
    const r = await api('POST', '/v3/payments', { body: payment('1600.00', { receipt: receipt('800.00', { qty: '2.00' }) }), key: key() });
    assert.equal(r.status, 200);
  });

  it('чек без контакта покупателя и с телефоном с «+» — 400', async () => {
    const noCustomer = payment();
    delete noCustomer.receipt.customer;
    assert.equal((await api('POST', '/v3/payments', { body: noCustomer, key: key() })).status, 400);
    const plus = payment('1600.00', { receipt: receipt('1600.00', { phone: '+79990000001' }) });
    assert.equal((await api('POST', '/v3/payments', { body: plus, key: key() })).json.parameter, 'receipt.customer.phone');
  });

  it('неверная сумма и валюта — 400', async () => {
    assert.equal((await api('POST', '/v3/payments', { body: payment('16.001'), key: key() })).status, 400);
    const usd = payment();
    usd.amount.currency = 'USD';
    assert.equal((await api('POST', '/v3/payments', { body: usd, key: key() })).json.parameter, 'amount.currency');
  });

  it('СБП с capture=false — 400 (допущение decisions №26)', async () => {
    const r = await api('POST', '/v3/payments', { body: payment('1600.00', { capture: false }), key: key() });
    assert.equal(r.status, 400);
    assert.equal(r.json.parameter, 'capture');
  });

  it('создание: форма объекта ЮKassa, GET того же магазина, чужой магазин — 404', async () => {
    const r = await api('POST', '/v3/payments', { body: payment(), key: key() });
    assert.equal(r.status, 200);
    const p = r.json;
    assert.match(p.id, /^[0-9a-f]{8}-000f-5000-[89ab]000-[0-9a-f]{12}$/);
    assert.equal(p.status, 'pending');
    assert.equal(p.paid, false);
    assert.deepEqual(p.amount, { value: '1600.00', currency: 'RUB' });
    assert.equal(p.confirmation.type, 'redirect');
    assert.equal(p.confirmation.confirmation_url, `${base}/pay/${p.id}`);
    assert.equal(p.payment_method.type, 'sbp');
    assert.deepEqual(p.metadata, { club_id: CLUB, quote_id: 'q1', kind: 'start' });
    assert.equal(p.receipt_registration, 'pending');
    assert.equal(p.refundable, false);
    assert.ok(Date.parse(p.created_at));
    const g = await api('GET', `/v3/payments/${p.id}`);
    assert.deepEqual(g.json, p);
    assert.equal((await api('GET', `/v3/payments/${p.id}`, { shop: SHOP_B })).status, 404);
  });

  it('Idempotence-Key: тот же запрос — тот же платёж, другой запрос — 400', async () => {
    const k = key();
    const a = await api('POST', '/v3/payments', { body: payment(), key: k });
    const b = await api('POST', '/v3/payments', { body: payment(), key: k });
    assert.equal(a.json.id, b.json.id);
    const c = await api('POST', '/v3/payments', { body: payment('800.00'), key: k });
    assert.equal(c.status, 400);
    assert.equal(c.json.parameter, 'Idempotence-Key');
    // Тот же ключ у другого магазина — независим.
    const d = await api('POST', '/v3/payments', { body: payment('800.00'), key: k, shop: SHOP_B });
    assert.equal(d.status, 200);
  });
});

describe('страница подтверждения и вебхуки', () => {
  it('«Оплатить»: 303 на return_url, succeeded, вебхук payment.succeeded на адрес клуба', async () => {
    const p = (await api('POST', '/v3/payments', { body: payment(), key: key() })).json;
    const page = await fetch(`${base}/pay/${p.id}`);
    const html = await page.text();
    assert.match(html, /Оплатить/);
    assert.match(html, /Отказ/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    const res = await fetch(`${base}/pay/${p.id}/confirm`, { method: 'POST', redirect: 'manual' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), 'https://billiardum.test/app/pay/x');
    await emu.settle();
    const g = (await api('GET', `/v3/payments/${p.id}`)).json;
    assert.equal(g.status, 'succeeded');
    assert.equal(g.paid, true);
    assert.equal(g.refundable, true);
    assert.ok(g.captured_at);
    assert.equal(g.confirmation, undefined);
    assert.equal(received.length, 1);
    assert.equal(received[0].url, `/api/webhooks/yookassa/${CLUB}`);
    const n = JSON.parse(received[0].body);
    assert.equal(n.type, 'notification');
    assert.equal(n.event, 'payment.succeeded');
    assert.equal(n.object.id, p.id);
  });

  it('«Отказ»: canceled с cancellation_details и вебхук payment.canceled', async () => {
    const p = (await api('POST', '/v3/payments', { body: payment(), key: key() })).json;
    await fetch(`${base}/pay/${p.id}/decline`, { method: 'POST', redirect: 'manual' });
    await emu.settle();
    const g = (await api('GET', `/v3/payments/${p.id}`)).json;
    assert.equal(g.status, 'canceled');
    assert.deepEqual(g.cancellation_details, { party: 'payment_network', reason: 'general_decline' });
    assert.equal(JSON.parse(received[0].body).event, 'payment.canceled');
  });

  it('вебхук повторяется, пока клуб не ответит 200', async () => {
    hookStatus = [500, 503];
    const p = (await api('POST', '/v3/payments', { body: payment(), key: key() })).json;
    await api('POST', `/__emu/payments/${p.id}/succeed`, { shop: null });
    await emu.settle();
    assert.equal(received.length, 3);
    const rec = emu.state.webhooks.at(-1);
    assert.equal(rec.delivered, true);
    assert.deepEqual(rec.attempts.map((a) => a.status), [500, 503, 200]);
  });
});

describe('QR на экране кассы (confirmation qr, контракт M2 §5)', () => {
  it('СБП с confirmation qr: confirmation_data, без return_url; подтверждение — succeeded и вебхук', async () => {
    const body = payment('350.00', { confirmation: { type: 'qr' } });
    const r = await api('POST', '/v3/payments', { body, key: key() });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.confirmation, { type: 'qr', confirmation_data: `${base}/pay/${r.json.id}` });
    assert.equal(r.json.payment_method.type, 'sbp');
    const page = await fetch(`${base}/pay/${r.json.id}`);
    assert.match(await page.text(), /Оплатить/);
    const res = await fetch(`${base}/pay/${r.json.id}/confirm`, { method: 'POST', redirect: 'manual' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `/pay/${r.json.id}`);
    await emu.settle();
    const g = (await api('GET', `/v3/payments/${r.json.id}`)).json;
    assert.equal(g.status, 'succeeded');
    assert.equal(g.confirmation, undefined);
    assert.equal(JSON.parse(received.at(-1).body).event, 'payment.succeeded');
    assert.match(await (await fetch(`${base}/pay/${r.json.id}`)).text(), /Оплачено/);
  });

  it('QR без способа оплаты — СБП; QR для карты — 400', async () => {
    const noMethod = payment('350.00', { confirmation: { type: 'qr' } });
    delete noMethod.payment_method_data;
    assert.equal((await api('POST', '/v3/payments', { body: noMethod, key: key() })).json.payment_method.type, 'sbp');
    const card = payment('350.00', { confirmation: { type: 'qr' }, payment_method_data: { type: 'bank_card' } });
    const r = await api('POST', '/v3/payments', { body: card, key: key() });
    assert.equal(r.status, 400);
    assert.equal(r.json.parameter, 'confirmation.type');
    const other = payment('350.00', { confirmation: { type: 'embedded' } });
    assert.equal((await api('POST', '/v3/payments', { body: other, key: key() })).json.parameter, 'confirmation');
  });
});

describe('двухстадийный платёж (карта «Без лимита»)', () => {
  async function hold(value = '1600.00') {
    const body = payment(value, { capture: false, payment_method_data: { type: 'bank_card' } });
    const p = (await api('POST', '/v3/payments', { body, key: key() })).json;
    await api('POST', `/__emu/payments/${p.id}/succeed?wait=1`, { shop: null });
    return p;
  }

  it('подтверждение гостем — waiting_for_capture и вебхук', async () => {
    const p = await hold();
    const g = (await api('GET', `/v3/payments/${p.id}`)).json;
    assert.equal(g.status, 'waiting_for_capture');
    assert.equal(g.paid, true);
    assert.ok(g.expires_at);
    assert.equal(g.payment_method.type, 'bank_card');
    assert.equal(JSON.parse(received.at(-1).body).event, 'payment.waiting_for_capture');
  });

  it('списание меньшей суммы: без чека — 400, с чеком на новую сумму — succeeded', async () => {
    const p = await hold();
    const noReceipt = await api('POST', `/v3/payments/${p.id}/capture`, { body: { amount: { value: '900.00', currency: 'RUB' } }, key: key() });
    assert.equal(noReceipt.status, 400);
    const wrong = await api('POST', `/v3/payments/${p.id}/capture`, { body: { amount: { value: '900.00', currency: 'RUB' }, receipt: receipt('1600.00') }, key: key() });
    assert.equal(wrong.json.parameter, 'receipt.items');
    const more = await api('POST', `/v3/payments/${p.id}/capture`, { body: { amount: { value: '1700.00', currency: 'RUB' }, receipt: receipt('1700.00') }, key: key() });
    assert.equal(more.json.parameter, 'amount');
    const ok = await api('POST', `/v3/payments/${p.id}/capture`, { body: { amount: { value: '900.00', currency: 'RUB' }, receipt: receipt('900.00') }, key: key() });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.status, 'succeeded');
    assert.deepEqual(ok.json.amount, { value: '900.00', currency: 'RUB' });
    const again = await api('POST', `/v3/payments/${p.id}/capture`, { body: {}, key: key() });
    assert.equal(again.status, 400);
  });

  it('отмена заморозки — canceled_by_merchant', async () => {
    const p = await hold();
    const r = await api('POST', `/v3/payments/${p.id}/cancel`, { body: {}, key: key() });
    assert.equal(r.json.status, 'canceled');
    assert.deepEqual(r.json.cancellation_details, { party: 'merchant', reason: 'canceled_by_merchant' });
  });
});

describe('возвраты', () => {
  it('без чека — 400; с чеком — succeeded и вебхук refund.succeeded; сверх остатка — 400', async () => {
    const p = (await api('POST', '/v3/payments', { body: payment(), key: key() })).json;
    await api('POST', `/__emu/payments/${p.id}/succeed?wait=1`, { shop: null });
    const noReceipt = await api('POST', '/v3/refunds', { body: { payment_id: p.id, amount: { value: '400.00', currency: 'RUB' } }, key: key() });
    assert.equal(noReceipt.status, 400);
    const r = await api('POST', '/v3/refunds', { body: { payment_id: p.id, amount: { value: '400.00', currency: 'RUB' }, receipt: receipt('400.00') }, key: key() });
    assert.equal(r.status, 200);
    assert.match(r.json.id, /-0015-5000-/);
    assert.equal(r.json.status, 'succeeded');
    assert.equal(r.json.payment_id, p.id);
    await emu.settle();
    assert.equal(JSON.parse(received.at(-1).body).event, 'refund.succeeded');
    assert.deepEqual((await api('GET', `/v3/refunds/${r.json.id}`)).json, r.json);
    const g = (await api('GET', `/v3/payments/${p.id}`)).json;
    assert.deepEqual(g.refunded_amount, { value: '400.00', currency: 'RUB' });
    const over = await api('POST', '/v3/refunds', { body: { payment_id: p.id, amount: { value: '1300.00', currency: 'RUB' }, receipt: receipt('1300.00') }, key: key() });
    assert.equal(over.json.parameter, 'amount');
    assert.equal((await api('GET', `/v3/refunds/${r.json.id}`, { shop: SHOP_B })).status, 404);
  });
});

describe('чек зачёта предоплаты (POST /v3/receipts)', () => {
  async function prepaid(value = '1000.00') {
    const body = payment(value, { receipt: { ...receipt(value), items: [{ ...receipt(value).items[0], description: 'Предоплата брони, стол 4', payment_mode: 'full_prepayment' }] } });
    const p = (await api('POST', '/v3/payments', { body, key: key() })).json;
    await api('POST', `/__emu/payments/${p.id}/succeed?wait=1`, { shop: null });
    return p;
  }
  const settle = (p, value, extra = {}) => ({
    type: 'payment',
    payment_id: p.id,
    send: true,
    customer: { phone: '79990000001' },
    items: [{ description: 'Игра, стол 4, 2 ч', quantity: 1, amount: { value, currency: 'RUB' }, vat_code: 1, payment_mode: 'full_payment', payment_subject: 'service' }],
    settlements: [{ type: 'prepayment', amount: { value, currency: 'RUB' } }],
    tax_system_code: 2,
    ...extra,
  });

  it('зачёт по платежу предоплаты: чек succeeded с фискальными данными; повтор ключа — тот же чек', async () => {
    const p = await prepaid();
    const k = key();
    const r = await api('POST', '/v3/receipts', { body: settle(p, '1000.00'), key: k });
    assert.equal(r.status, 200);
    assert.match(r.json.id, /^rt_/);
    assert.equal(r.json.type, 'payment');
    assert.equal(r.json.payment_id, p.id);
    assert.equal(r.json.status, 'succeeded');
    assert.ok(r.json.fiscal_document_number);
    assert.deepEqual(r.json.settlements, [{ type: 'prepayment', amount: { value: '1000.00', currency: 'RUB' } }]);
    assert.equal((await api('POST', '/v3/receipts', { body: settle(p, '1000.00'), key: k })).json.id, r.json.id);
    assert.deepEqual((await api('GET', `/v3/receipts/${r.json.id}`)).json, r.json);
    assert.equal((await api('GET', `/v3/receipts/${r.json.id}`, { shop: SHOP_B })).status, 404);
  });

  it('проверки: сумма позиций = сумме расчётов, зачёт не больше предоплаты, позиции full_payment, send, payment_id', async () => {
    const p = await prepaid('600.00');
    const bad = async (body) => (await api('POST', '/v3/receipts', { body, key: key() })).json.parameter;
    assert.equal(await bad({ ...settle(p, '600.00'), settlements: [{ type: 'prepayment', amount: { value: '500.00', currency: 'RUB' } }] }), 'receipt.items');
    assert.equal(await bad(settle(p, '700.00')), 'settlements');
    assert.equal(await bad({ ...settle(p, '600.00'), items: [{ ...settle(p, '600.00').items[0], payment_mode: 'full_prepayment' }] }), 'items[0].payment_mode');
    assert.equal(await bad({ ...settle(p, '600.00'), send: false }), 'send');
    assert.equal(await bad({ ...settle(p, '600.00'), settlements: [{ type: 'barter', amount: { value: '600.00', currency: 'RUB' } }] }), 'settlements[0].type');
    assert.equal(await bad({ ...settle(p, '600.00'), payment_id: 'nope' }), undefined);
    const pending = (await api('POST', '/v3/payments', { body: payment('600.00'), key: key() })).json;
    assert.equal(await bad(settle(pending, '600.00')), 'payment_id');
    // Частями: 400 + 200 — можно, ещё 1 ₽ — нет.
    assert.equal((await api('POST', '/v3/receipts', { body: settle(p, '400.00'), key: key() })).status, 200);
    assert.equal((await api('POST', '/v3/receipts', { body: settle(p, '200.00'), key: key() })).status, 200);
    assert.equal(await bad(settle(p, '1.00')), 'settlements');
  });
});

describe('управление /__emu', () => {
  it('повтор вебхука N раз, подмена полей и сырое тело', async () => {
    const p = (await api('POST', '/v3/payments', { body: payment(), key: key() })).json;
    await api('POST', `/__emu/payments/${p.id}/succeed?wait=1`, { shop: null });
    received.length = 0;
    const r = await api('POST', `/__emu/payments/${p.id}/webhook?repeat=3`, { shop: null, body: {} });
    assert.equal(r.json.deliveries.length, 3);
    assert.equal(received.length, 3);
    await api('POST', `/__emu/payments/${p.id}/webhook`, { shop: null, body: { override: { amount: { value: '1.00', currency: 'RUB' } } } });
    assert.equal(JSON.parse(received.at(-1).body).object.amount.value, '1.00');
    await api('POST', `/__emu/payments/${p.id}/webhook`, { shop: null, body: { raw: '{"event":"payment.succeeded","object":{"id":"forged"}}' } });
    assert.equal(received.at(-1).body, '{"event":"payment.succeeded","object":{"id":"forged"}}');
    // Сам платёж не изменился.
    assert.equal((await api('GET', `/v3/payments/${p.id}`)).json.amount.value, '1600.00');
  });

  it('сбой API: fail_next и down', async () => {
    await api('POST', '/__emu/config', { shop: null, body: { fail_next: { count: 2, status: 500 } } });
    assert.equal((await api('GET', '/v3/payments/x')).status, 500);
    assert.equal((await api('GET', '/v3/payments/x')).status, 500);
    assert.equal((await api('GET', '/v3/payments/x')).status, 404);
    await api('POST', '/__emu/config', { shop: null, body: { down: true } });
    assert.equal((await api('GET', '/v3/payments/x')).status, 503);
    await api('POST', '/__emu/config', { shop: null, body: { down: false } });
    assert.equal((await api('GET', '/v3/payments/x')).status, 404);
  });

  it('lose_next_response: операция выполнена, ответ потерян (500); повтор тем же ключом — сохранённый результат', async () => {
    await api('POST', '/__emu/config', { shop: null, body: { lose_next_response: 1 } });
    const k = key();
    const before = (await api('GET', '/__emu/payments', { shop: null })).json.length;
    const lost = await api('POST', '/v3/payments', { body: payment(), key: k });
    assert.equal(lost.status, 500);
    const all = (await api('GET', '/__emu/payments', { shop: null })).json;
    assert.equal(all.length, before + 1, 'платёж создан');
    const again = await api('POST', '/v3/payments', { body: payment(), key: k });
    assert.equal(again.status, 200);
    assert.equal(again.json.id, all.at(-1).id, 'тот же платёж');
    assert.equal((await api('GET', '/__emu/payments', { shop: null })).json.length, before + 1, 'второго платежа нет');
    const log = (await api('GET', '/__emu/requests', { shop: null })).json.filter((e) => e.idempotence_key === k);
    assert.deepEqual(log.map((e) => [e.status, Boolean(e.lost)]), [[500, true], [200, false]]);
    // GET ответы не теряются; счётчик исчерпан.
    assert.equal((await api('POST', '/v3/payments', { body: payment(), key: key() })).status, 200);
  });

  it('lose_next_response по пути: возврат выполнен, соединение оборвано (reset); другие запросы не затронуты; повтор — тот же возврат', async () => {
    const p = (await api('POST', '/v3/payments', { body: payment(), key: key() })).json;
    await api('POST', `/__emu/payments/${p.id}/succeed?wait=1`, { shop: null });
    await api('POST', '/__emu/config', { shop: null, body: { lose_next_response: { path: '/v3/refunds', count: 1, mode: 'reset' } } });
    // Платёж (другой путь) отвечает как обычно.
    assert.equal((await api('POST', '/v3/payments', { body: payment(), key: key() })).status, 200);
    const k = key();
    const body = { payment_id: p.id, amount: { value: '100.00', currency: 'RUB' }, receipt: receipt('100.00') };
    await assert.rejects(api('POST', '/v3/refunds', { body, key: k }), 'соединение оборвано');
    assert.equal((await api('GET', `/v3/payments/${p.id}`)).json.refunded_amount.value, '100.00', 'возврат проведён');
    const again = await api('POST', '/v3/refunds', { body, key: k });
    assert.equal(again.status, 200);
    assert.equal((await api('GET', `/v3/refunds/${again.json.id}`)).json.amount.value, '100.00');
    assert.equal((await api('GET', `/v3/payments/${p.id}`)).json.refunded_amount.value, '100.00', 'второго возврата нет');
    const bad = await api('POST', '/__emu/config', { shop: null, body: { lose_next_response: { path: '/x' } } });
    assert.equal(bad.status, 400);
  });

  it('задержка вебхука', async () => {
    await api('POST', '/__emu/config', { shop: null, body: { webhook_delay_ms: 150 } });
    const p = (await api('POST', '/v3/payments', { body: payment(), key: key() })).json;
    const t0 = Date.now();
    await api('POST', `/__emu/payments/${p.id}/succeed?wait=1`, { shop: null });
    assert.ok(Date.now() - t0 >= 140);
    await api('POST', '/__emu/config', { shop: null, body: { webhook_delay_ms: 0 } });
  });

  it('новый магазин со своим адресом вебхука; журнал запросов с Idempotence-Key', async () => {
    await api('POST', '/__emu/shops', { shop: null, body: { shop_id: '500003', secret: 's3', webhook_url: hookUrl.replace('{club_id}', 'fixed') } });
    const shop3 = { shopId: '500003', secret: 's3' };
    const k = key();
    const p = (await api('POST', '/v3/payments', { body: payment(), key: k, shop: shop3 })).json;
    await api('POST', `/__emu/payments/${p.id}/succeed?wait=1`, { shop: null });
    assert.equal(received.at(-1).url, '/api/webhooks/yookassa/fixed');
    const log = (await api('GET', '/__emu/requests', { shop: null })).json;
    assert.ok(log.some((e) => e.idempotence_key === k && e.path === '/v3/payments' && e.status === 200));
    const state = (await api('GET', `/__emu/payments/${p.id}`, { shop: null })).json;
    assert.equal(state.receipt.items[0].description, 'Игра, стол 4, 2 ч');
  });

  it('токен управления, если задан', async () => {
    emu.config.controlToken = 'tok';
    assert.equal((await api('GET', '/__emu/payments', { shop: null })).status, 401);
    assert.equal((await api('GET', '/__emu/payments', { shop: null, headers: { 'x-emu-token': 'tok' } })).status, 200);
    emu.config.controlToken = null;
  });
});

describe('M5.3: сохранённый способ оплаты и автоплатёж', () => {
  const card = (value = '1.00', extra = {}) =>
    payment(value, { capture: false, save_payment_method: true, payment_method_data: { type: 'bank_card' }, metadata: { club_id: CLUB, kind: 'subscription' }, ...extra });

  async function savedMethod() {
    const p = (await api('POST', '/v3/payments', { body: card(), key: key() })).json;
    assert.equal(p.payment_method.saved, false, 'до подтверждения не сохранён');
    await api('POST', `/__emu/payments/${p.id}/succeed?wait=1`, { shop: null });
    const after = (await api('GET', `/v3/payments/${p.id}`)).json;
    assert.equal(after.status, 'waiting_for_capture');
    assert.equal(after.payment_method.saved, true);
    return after.payment_method.id;
  }

  const recurring = (methodId, value = '6320.00', extra = {}) => {
    const body = { ...payment(value, { payment_method_id: methodId, ...extra }) };
    delete body.confirmation;
    delete body.payment_method_data;
    return body;
  };

  it('save_payment_method: способ сохраняется после подтверждения; СБП не сохраняется', async () => {
    const id = await savedMethod();
    const methods = (await api('GET', '/__emu/payment-methods', { shop: null })).json;
    assert.ok(methods.some((m) => m.id === id && m.shop_id === SHOP.shopId && m.card.last4 === '4477'));
    const sbp = await api('POST', '/v3/payments', { body: payment('1.00', { save_payment_method: true }), key: key() });
    assert.equal(sbp.status, 400);
    assert.equal(sbp.json.parameter, 'save_payment_method');
    assert.equal((await api('POST', '/v3/payments', { body: card('1.00', { save_payment_method: 'yes' }), key: key() })).status, 400);
  });

  it('платёж по payment_method_id — без подтверждения, сразу succeeded и вебхук; чек обязателен', async () => {
    const id = await savedMethod();
    received.length = 0;
    const r = await api('POST', '/v3/payments', { body: recurring(id), key: key() });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'succeeded');
    assert.equal(r.json.confirmation, undefined);
    assert.equal(r.json.payment_method.id, id);
    await emu.settle();
    assert.ok(received.some((w) => JSON.parse(w.body).event === 'payment.succeeded' && JSON.parse(w.body).object.id === r.json.id));
    const noReceipt = recurring(id);
    delete noReceipt.receipt;
    assert.equal((await api('POST', '/v3/payments', { body: noReceipt, key: key() })).json.parameter, 'receipt');
  });

  it('чужой или неизвестный payment_method_id — 400; вместе с save_payment_method — 400', async () => {
    const id = await savedMethod();
    assert.equal((await api('POST', '/v3/payments', { body: recurring(id), key: key(), shop: SHOP_B })).json.parameter, 'payment_method_id');
    assert.equal((await api('POST', '/v3/payments', { body: recurring('nope'), key: key() })).status, 400);
    assert.equal((await api('POST', '/v3/payments', { body: recurring(id, '1.00', { save_payment_method: true }), key: key() })).status, 400);
  });

  it('режим «отказ списания»: count и reason, затем снова проходит; отозванный способ — permission_revoked', async () => {
    const id = await savedMethod();
    await api('POST', '/__emu/config', { shop: null, body: { decline_recurring: { count: 1, reason: 'card_expired' } } });
    const bad = (await api('POST', '/v3/payments', { body: recurring(id), key: key() })).json;
    assert.equal(bad.status, 'canceled');
    assert.deepEqual(bad.cancellation_details, { party: 'payment_network', reason: 'card_expired' });
    assert.equal((await api('POST', '/v3/payments', { body: recurring(id), key: key() })).json.status, 'succeeded');
    await api('POST', '/__emu/config', { shop: null, body: { decline_recurring: true } });
    assert.equal((await api('POST', '/v3/payments', { body: recurring(id), key: key() })).json.cancellation_details.reason, 'insufficient_funds');
    assert.equal((await api('POST', '/v3/payments', { body: recurring(id), key: key() })).json.status, 'canceled');
    await api('POST', '/__emu/config', { shop: null, body: { decline_recurring: false } });
    await api('POST', `/__emu/payment-methods/${id}/revoke`, { shop: null });
    assert.equal((await api('POST', '/v3/payments', { body: recurring(id), key: key() })).json.cancellation_details.reason, 'permission_revoked');
  });

  it('повтор с тем же Idempotence-Key — тот же платёж, второго списания нет', async () => {
    const id = await savedMethod();
    const k = key();
    const a = (await api('POST', '/v3/payments', { body: recurring(id), key: k })).json;
    const b = (await api('POST', '/v3/payments', { body: recurring(id), key: k })).json;
    assert.equal(a.id, b.id);
    const all = (await api('GET', '/__emu/payments', { shop: null })).json.filter((p) => p.payment_method?.id === id && p.status === 'succeeded');
    assert.equal(all.length, 1);
  });

  it('/__emu/reset забывает способы и снимает режим отказа', async () => {
    await savedMethod();
    await api('POST', '/__emu/config', { shop: null, body: { decline_recurring: true } });
    await api('POST', '/__emu/reset', { shop: null });
    assert.deepEqual((await api('GET', '/__emu/payment-methods', { shop: null })).json, []);
    assert.equal(emu.config.declineRecurring.count, 0);
  });
});
