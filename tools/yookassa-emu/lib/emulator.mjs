// Эмулятор ЮKassa API v3 для разработки и тестов (контракт M1 §5, decisions №55).
//
// Подмножество API: POST /v3/payments, GET /v3/payments/{id}, POST /v3/payments/{id}/capture,
// POST /v3/payments/{id}/cancel, POST /v3/refunds, GET /v3/refunds/{id}. Basic shopId:secretKey,
// M5.3: save_payment_method (способ сохраняется после подтверждения) и платёж по payment_method_id
// без подтверждения (автоплатёж); режим «отказ списания» для тестов (decline_recurring).
// заголовок Idempotence-Key на каждый POST. Форма объектов и статусы — как у ЮKassa.
// Платёж и возврат без чека или с суммой позиций, не равной сумме, — 400 (магазин клуба
// работает с чеками 54-ФЗ, инвариант 7).
//
// Страница подтверждения GET /pay/{id} («Оплатить», «Отказ») меняет статус и отправляет
// вебхук на адрес клуба. Управление для тестов — /__emu/... Всё хранится в памяти.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { EmuError, checkDescription, checkMetadata, checkReceipt, formatValue, parseAmount } from './validate.mjs';

const MAX_BODY = 64 * 1024;
const HOLD_DAYS = 7;

function ykId(kind) {
  // Вид идентификаторов ЮKassa: 2f3e1a5c-000f-5000-8000-1d2c3b4a5f6e.
  const hex = randomBytes(10).toString('hex');
  return `${hex.slice(0, 8)}-${kind}-5000-${['8', '9', 'a', 'b'][randomBytes(1)[0] & 3]}000-${hex.slice(8, 20)}`;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function rub(kopecks) {
  const nbsp = '\u00a0';
  const r = Math.floor(kopecks / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, nbsp);
  const k = kopecks % 100;
  return k === 0 ? `${r}${nbsp}₽` : `${r},${String(k).padStart(2, '0')}${nbsp}₽`;
}

/**
 * @param {object} opts
 * @param {Array<{shopId: string, secret: string, webhookUrl?: string, test?: boolean, fiscalization?: boolean}>} [opts.shops]
 *   test — тестовый магазин (GET /v3/me, поле test платежей; по умолчанию true), fiscalization —
 *   включена отправка чеков (GET /v3/me fiscalization_enabled; по умолчанию true). M5.1 №154.
 * @param {string} [opts.webhookUrl] адрес вебхука по умолчанию; {club_id} заменяется на metadata.club_id
 * @param {string} [opts.publicUrl] внешний адрес эмулятора для confirmation_url
 * @param {number} [opts.webhookDelayMs] задержка перед отправкой вебхука
 * @param {number} [opts.webhookRetries] попыток доставки (ЮKassa повторяет при ответе не 200)
 * @param {number} [opts.webhookRetryDelayMs]
 * @param {string} [opts.controlToken] если задан — /__emu/* только с заголовком X-Emu-Token
 * @param {typeof fetch} [opts.fetch]
 * @param {{ now(): Date }} [opts.clock]
 * @param {{ info: Function, warn: Function }} [opts.log]
 */
export function createEmulator(opts = {}) {
  const clock = opts.clock ?? { now: () => new Date() };
  const doFetch = opts.fetch ?? globalThis.fetch;
  const log = opts.log ?? { info() {}, warn() {} };
  const shops = new Map();
  const state = {
    payments: new Map(),
    refunds: new Map(),
    receipts: new Map(),
    // M5.3: сохранённые способы оплаты (id → { shopId, type, card, title, revoked }).
    methods: new Map(),
    idempotence: new Map(),
    webhooks: [],
    requests: [],
    pending: new Set(),
  };
  const config = {
    publicUrl: (opts.publicUrl ?? 'http://localhost:8090').replace(/\/+$/, ''),
    webhookUrl: opts.webhookUrl ?? null,
    webhookDelayMs: opts.webhookDelayMs ?? 0,
    webhookRetries: opts.webhookRetries ?? 3,
    webhookRetryDelayMs: opts.webhookRetryDelayMs ?? 500,
    controlToken: opts.controlToken ?? null,
    failNext: { count: 0, status: 500 },
    // «Операция выполнена, ответ потерян»: следующие N изменяющих запросов (POST) выполняются,
    // результат сохраняется под Idempotence-Key, а клиент получает 500 или обрыв соединения.
    loseNext: { count: 0, path: null, method: 'POST', mode: 'error' },
    // M5.3: «отказ списания» — следующие count платежей по payment_method_id отклоняются
    // (count: -1 — все, пока режим не снят); reason — cancellation_details.reason.
    declineRecurring: { count: 0, reason: 'insufficient_funds' },
    down: false,
  };

  function addShop({ shopId, secret, webhookUrl = null, test = true, fiscalization = true }) {
    if (!/^[0-9A-Za-z_-]{1,64}$/.test(String(shopId)) || typeof secret !== 'string' || secret.length < 1) {
      throw new EmuError(400, 'invalid_request', 'shop_id и secret обязательны', 'shop_id');
    }
    shops.set(String(shopId), { shopId: String(shopId), secret, webhookUrl, test: test !== false, fiscalization: fiscalization !== false });
  }

  /** GET /v3/me — сведения о магазине (M5.1 №154: сервер проверяет пару при сохранении). */
  function meView(shop) {
    return {
      account_id: shop.shopId,
      test: shop.test,
      fiscalization_enabled: shop.fiscalization,
      payment_methods: ['bank_card', 'sbp'],
      status: 'enabled',
    };
  }
  for (const s of opts.shops ?? []) addShop(s);

  const nowIso = () => clock.now().toISOString();

  // Аутентификация ---------------------------------------------------------------------------

  function authenticate(req) {
    const h = req.headers.authorization ?? '';
    const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(h);
    if (!m) throw new EmuError(401, 'invalid_credentials', 'Нужна авторизация Basic shopId:secretKey');
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    const shop = i > 0 ? shops.get(decoded.slice(0, i)) : undefined;
    if (!shop || !safeEqual(decoded.slice(i + 1), shop.secret)) {
      throw new EmuError(401, 'invalid_credentials', 'Неверный shopId или секретный ключ');
    }
    return shop;
  }

  // Объекты ----------------------------------------------------------------------------------

  /** Публичный вид платежа (как в ответе API). */
  function view(p) {
    const o = {
      id: p.id,
      status: p.status,
      paid: p.paid,
      amount: { value: formatValue(p.amountKopecks), currency: 'RUB' },
      ...(p.status === 'succeeded' ? { income_amount: { value: formatValue(p.amountKopecks - Math.round(p.amountKopecks * 0.035)), currency: 'RUB' } } : {}),
      ...(p.description !== undefined ? { description: p.description } : {}),
      recipient: { account_id: p.shopId, gateway_id: '100500' },
      payment_method: p.paymentMethod,
      ...(p.capturedAt ? { captured_at: p.capturedAt } : {}),
      created_at: p.createdAt,
      ...(p.status === 'waiting_for_capture' ? { expires_at: p.expiresAt } : {}),
      ...(p.status === 'pending' ? { confirmation: confirmationView(p) } : {}),
      test: shops.get(p.shopId)?.test ?? true,
      ...(p.refundedKopecks > 0 ? { refunded_amount: { value: formatValue(p.refundedKopecks), currency: 'RUB' } } : {}),
      refundable: p.status === 'succeeded' && p.refundedKopecks < p.amountKopecks,
      ...(p.receipt ? { receipt_registration: p.receiptRegistration } : {}),
      metadata: { ...p.metadata },
      ...(p.cancellation ? { cancellation_details: { ...p.cancellation } } : {}),
    };
    return o;
  }

  /**
   * confirmation платежа в pending: redirect — страница подтверждения; qr — данные QR-кода
   * (у ЮKassa для СБП — ссылка НСПК; эмулятор кладёт в QR ссылку на свою страницу
   * подтверждения, чтобы в разработке его можно было отсканировать телефоном).
   */
  function confirmationView(p) {
    if (p.confirmationType === 'qr') return { type: 'qr', confirmation_data: `${config.publicUrl}/pay/${p.id}` };
    return { type: 'redirect', confirmation_url: `${config.publicUrl}/pay/${p.id}`, return_url: p.returnUrl };
  }

  function refundView(r) {
    return {
      id: r.id,
      payment_id: r.paymentId,
      status: r.status,
      created_at: r.createdAt,
      amount: { value: formatValue(r.amountKopecks), currency: 'RUB' },
      ...(r.description !== undefined ? { description: r.description } : {}),
      ...(r.receipt ? { receipt_registration: 'succeeded' } : {}),
    };
  }

  function getPayment(shop, id) {
    const p = state.payments.get(id);
    if (!p || (shop && p.shopId !== shop.shopId)) throw new EmuError(404, 'not_found', 'Платёж не найден');
    return p;
  }

  // Вебхуки ----------------------------------------------------------------------------------

  function webhookUrlFor(p) {
    const shop = shops.get(p.shopId);
    const tpl = shop?.webhookUrl ?? config.webhookUrl;
    if (!tpl) return null;
    return tpl.replaceAll('{club_id}', encodeURIComponent(p.metadata?.club_id ?? ''));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Доставка вебхука с повторами; тело — объект или готовая строка (подмена для pentester). */
  function deliver(url, body, { event, objectId, delayMs = config.webhookDelayMs, retries = config.webhookRetries } = {}) {
    const record = { id: randomUUID(), event, object_id: objectId, url, attempts: [], delivered: false, created_at: nowIso() };
    state.webhooks.push(record);
    if (state.webhooks.length > 1000) state.webhooks.shift();
    if (!url) {
      record.attempts.push({ error: 'no_webhook_url' });
      return Promise.resolve(record);
    }
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const task = (async () => {
      if (delayMs > 0) await sleep(delayMs);
      for (let i = 0; i < Math.max(1, retries); i += 1) {
        try {
          const res = await doFetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'user-agent': 'YooKassa-Emulator/1.0' },
            body: text,
            signal: AbortSignal.timeout(5_000),
          });
          await res.arrayBuffer().catch(() => {});
          record.attempts.push({ status: res.status, at: nowIso() });
          if (res.status === 200) {
            record.delivered = true;
            break;
          }
        } catch (err) {
          record.attempts.push({ error: err.name === 'TimeoutError' ? 'timeout' : 'network', at: nowIso() });
        }
        if (i + 1 < retries) await sleep(config.webhookRetryDelayMs * (i + 1));
      }
      log.info('webhook', { event, object_id: objectId, delivered: record.delivered, attempts: record.attempts.length });
      return record;
    })();
    state.pending.add(task);
    task.finally(() => state.pending.delete(task));
    return task;
  }

  function notifyPayment(p, event = eventFor(p)) {
    return deliver(webhookUrlFor(p), { type: 'notification', event, object: view(p) }, { event, objectId: p.id });
  }

  function eventFor(p) {
    return {
      succeeded: 'payment.succeeded',
      waiting_for_capture: 'payment.waiting_for_capture',
      canceled: 'payment.canceled',
      pending: 'payment.pending',
    }[p.status];
  }

  // Переходы платежа ------------------------------------------------------------------------

  /** Способ оплаты платежа с save_payment_method сохраняется после подтверждения (M5.3). */
  function saveMethod(p) {
    if (!p.savePaymentMethod || p.paymentMethod.type !== 'bank_card') return;
    p.paymentMethod = { ...p.paymentMethod, saved: true };
    state.methods.set(p.paymentMethod.id, { id: p.paymentMethod.id, shopId: p.shopId, type: p.paymentMethod.type, title: p.paymentMethod.title, card: p.paymentMethod.card, revoked: false });
  }

  function confirm(p) {
    if (p.status !== 'pending') throw new EmuError(400, 'invalid_request', `Платёж в статусе ${p.status}`, 'status');
    p.paid = true;
    saveMethod(p);
    if (p.capture) {
      p.status = 'succeeded';
      p.capturedAt = nowIso();
      p.receiptRegistration = 'succeeded';
    } else {
      p.status = 'waiting_for_capture';
      p.expiresAt = new Date(clock.now().getTime() + HOLD_DAYS * 86_400_000).toISOString();
    }
    return notifyPayment(p);
  }

  function decline(p, reason = 'general_decline', party = 'payment_network') {
    if (!['pending', 'waiting_for_capture'].includes(p.status)) throw new EmuError(400, 'invalid_request', `Платёж в статусе ${p.status}`, 'status');
    p.status = 'canceled';
    p.paid = false;
    p.cancellation = { party, reason };
    if (p.receipt) p.receiptRegistration = 'canceled';
    return notifyPayment(p);
  }

  // API v3 -------------------------------------------------------------------------------------

  function idempotent(shop, req, route, body, fn) {
    const key = req.headers['idempotence-key'];
    if (typeof key !== 'string' || key.length < 1 || key.length > 64) {
      throw new EmuError(400, 'invalid_request', 'Нужен заголовок Idempotence-Key (до 64 символов)', 'Idempotence-Key');
    }
    const storeKey = `${shop.shopId}|${key}`;
    const hash = sha256(`${route}\n${JSON.stringify(body)}`);
    const prev = state.idempotence.get(storeKey);
    if (prev) {
      if (prev.hash !== hash) throw new EmuError(400, 'invalid_request', 'Idempotence-Key уже использован с другим запросом', 'Idempotence-Key');
      return { ...prev.response, replayed: true };
    }
    let response;
    try {
      response = { status: 200, body: fn() };
    } catch (err) {
      if (!(err instanceof EmuError) || err.status >= 500) throw err;
      response = { status: err.status, body: errorBody(err) };
    }
    state.idempotence.set(storeKey, { hash, response });
    return response;
  }

  /** Отказ списания по сохранённому способу (режим теста или отозванное разрешение): причина или null. */
  function recurringDecline(method) {
    if (method.revoked) return 'permission_revoked';
    const d = config.declineRecurring;
    if (d.count === 0) return null;
    if (d.count > 0) d.count -= 1;
    return d.reason;
  }

  /** Платёж по payment_method_id (автоплатёж, M5.3): без подтверждения, сразу итог и вебхук. */
  function createRecurringPayment(shop, body) {
    const amountKopecks = parseAmount(body.amount);
    const capture = body.capture === undefined ? false : body.capture;
    if (typeof capture !== 'boolean') throw new EmuError(400, 'invalid_request', 'capture — true или false', 'capture');
    if (body.payment_method_data !== undefined || body.save_payment_method !== undefined) {
      throw new EmuError(400, 'invalid_request', 'payment_method_id нельзя вместе с payment_method_data и save_payment_method', 'payment_method_id');
    }
    const method = state.methods.get(body.payment_method_id);
    if (!method || method.shopId !== shop.shopId) throw new EmuError(400, 'invalid_request', 'Неизвестный или чужой payment_method_id', 'payment_method_id');
    const description = checkDescription(body.description);
    const metadata = checkMetadata(body.metadata);
    checkReceipt(body.receipt, amountKopecks);
    const id = ykId('000f');
    const p = {
      id,
      shopId: shop.shopId,
      status: 'pending',
      paid: false,
      amountKopecks,
      authorizedKopecks: amountKopecks,
      capture,
      description,
      metadata,
      confirmationType: null,
      returnUrl: null,
      paymentMethod: { type: method.type, id: method.id, saved: true, title: method.title, card: method.card },
      recurring: true,
      createdAt: nowIso(),
      receipt: body.receipt,
      receiptRegistration: 'pending',
      receipts: [{ kind: 'payment', receipt: body.receipt, amount_kopecks: amountKopecks }],
      refundedKopecks: 0,
    };
    state.payments.set(id, p);
    const reason = recurringDecline(method);
    if (reason) decline(p, reason, reason === 'permission_revoked' ? 'yoo_money' : 'payment_network');
    else confirm(p);
    return view(p);
  }

  function createPayment(shop, body) {
    if (body.payment_method_id !== undefined) {
      if (typeof body.payment_method_id !== 'string' || !/^[\w-]{1,64}$/.test(body.payment_method_id)) {
        throw new EmuError(400, 'invalid_request', 'Неверный payment_method_id', 'payment_method_id');
      }
      return createRecurringPayment(shop, body);
    }
    const amountKopecks = parseAmount(body.amount);
    const capture = body.capture === undefined ? false : body.capture;
    if (typeof capture !== 'boolean') throw new EmuError(400, 'invalid_request', 'capture — true или false', 'capture');
    const savePaymentMethod = body.save_payment_method === undefined ? false : body.save_payment_method;
    if (typeof savePaymentMethod !== 'boolean') throw new EmuError(400, 'invalid_request', 'save_payment_method — true или false', 'save_payment_method');
    const conf = body.confirmation;
    const methodType = body.payment_method_data?.type ?? (conf?.type === 'qr' ? 'sbp' : 'bank_card');
    if (savePaymentMethod && methodType !== 'bank_card') throw new EmuError(400, 'invalid_request', 'Эмулятор сохраняет только bank_card', 'save_payment_method');
    if (!['bank_card', 'sbp'].includes(methodType)) throw new EmuError(400, 'invalid_request', 'Эмулятор знает bank_card и sbp', 'payment_method_data.type');
    if (conf?.type === 'qr') {
      // QR на экране кассы (контракт M2 §5): эмулятор принимает его только для СБП.
      if (methodType !== 'sbp') throw new EmuError(400, 'invalid_request', 'confirmation qr — только для СБП', 'confirmation.type');
      if (conf.return_url !== undefined && (typeof conf.return_url !== 'string' || !/^https?:\/\//.test(conf.return_url) || conf.return_url.length > 2048)) {
        throw new EmuError(400, 'invalid_request', 'Неверный return_url', 'confirmation.return_url');
      }
    } else if (!conf || conf.type !== 'redirect' || typeof conf.return_url !== 'string' || !/^https?:\/\//.test(conf.return_url) || conf.return_url.length > 2048) {
      throw new EmuError(400, 'invalid_request', 'confirmation: type redirect и return_url или type qr', 'confirmation');
    }
    // Допущение decisions №26: СБП — только одностадийная оплата.
    if (methodType === 'sbp' && !capture) throw new EmuError(400, 'invalid_request', 'СБП не поддерживает capture=false', 'capture');
    const description = checkDescription(body.description);
    const metadata = checkMetadata(body.metadata);
    checkReceipt(body.receipt, amountKopecks);
    const id = ykId('000f');
    const p = {
      id,
      shopId: shop.shopId,
      status: 'pending',
      paid: false,
      amountKopecks,
      authorizedKopecks: amountKopecks,
      capture,
      description,
      metadata,
      confirmationType: conf.type,
      returnUrl: conf.return_url ?? null,
      savePaymentMethod,
      paymentMethod: methodType === 'sbp'
        ? { type: 'sbp', id: randomUUID(), saved: false }
        : { type: 'bank_card', id: randomUUID(), saved: false, title: 'Bank card *4477', card: { first6: '555555', last4: '4477', expiry_year: '2030', expiry_month: '12', card_type: 'MasterCard' } },
      createdAt: nowIso(),
      receipt: body.receipt,
      receiptRegistration: 'pending',
      receipts: [{ kind: 'payment', receipt: body.receipt, amount_kopecks: amountKopecks }],
      refundedKopecks: 0,
    };
    state.payments.set(id, p);
    return view(p);
  }

  function capturePayment(shop, id, body) {
    const p = getPayment(shop, id);
    if (p.status !== 'waiting_for_capture') throw new EmuError(400, 'invalid_request', `Подтвердить можно только waiting_for_capture, сейчас ${p.status}`, 'status');
    let amount = p.amountKopecks;
    if (body.amount !== undefined) {
      amount = parseAmount(body.amount);
      if (amount > p.authorizedKopecks) throw new EmuError(400, 'invalid_request', 'Сумма больше замороженной', 'amount');
    }
    if (body.receipt !== undefined || amount !== p.authorizedKopecks) {
      checkReceipt(body.receipt, amount);
      p.receipt = body.receipt;
      p.receipts.push({ kind: 'capture', receipt: body.receipt, amount_kopecks: amount });
    }
    p.amountKopecks = amount;
    p.status = 'succeeded';
    p.capturedAt = nowIso();
    p.receiptRegistration = 'succeeded';
    notifyPayment(p);
    return view(p);
  }

  function cancelPayment(shop, id) {
    const p = getPayment(shop, id);
    if (p.status !== 'waiting_for_capture') throw new EmuError(400, 'invalid_request', `Отменить можно только waiting_for_capture, сейчас ${p.status}`, 'status');
    decline(p, 'canceled_by_merchant', 'merchant');
    return view(p);
  }

  function createRefund(shop, body) {
    if (typeof body.payment_id !== 'string') throw new EmuError(400, 'invalid_request', 'Нет payment_id', 'payment_id');
    const p = getPayment(shop, body.payment_id);
    if (p.status !== 'succeeded') throw new EmuError(400, 'invalid_request', 'Вернуть можно только succeeded', 'payment_id');
    const amount = parseAmount(body.amount);
    if (amount > p.amountKopecks - p.refundedKopecks) throw new EmuError(400, 'invalid_request', 'Сумма возврата больше остатка платежа', 'amount');
    checkReceipt(body.receipt, amount);
    const r = {
      id: ykId('0015'),
      paymentId: p.id,
      shopId: shop.shopId,
      status: 'succeeded',
      createdAt: nowIso(),
      amountKopecks: amount,
      description: checkDescription(body.description),
      receipt: body.receipt,
    };
    state.refunds.set(r.id, r);
    p.refundedKopecks += amount;
    p.receipts.push({ kind: 'refund', receipt: body.receipt, amount_kopecks: amount, refund_id: r.id });
    deliver(webhookUrlFor(p), { type: 'notification', event: 'refund.succeeded', object: refundView(r) }, { event: 'refund.succeeded', objectId: r.id });
    return refundView(r);
  }

  // Отдельные чеки (POST /v3/receipts): чек зачёта предоплаты — позиции full_payment и расчёт
  // settlements [{type: 'prepayment', amount}] по платежу предоплаты (decisions №108, №112).
  const SETTLEMENT_TYPES = ['cashless', 'prepayment', 'postpayment', 'consideration'];

  function createReceipt(shop, body) {
    const type = body.type;
    if (type !== 'payment' && type !== 'refund') throw new EmuError(400, 'invalid_request', 'type — payment или refund', 'type');
    if (body.send !== true) throw new EmuError(400, 'invalid_request', 'send должен быть true', 'send');
    let payment = null;
    if (type === 'payment') {
      if (typeof body.payment_id !== 'string') throw new EmuError(400, 'invalid_request', 'Нет payment_id', 'payment_id');
      payment = getPayment(shop, body.payment_id);
      if (payment.status !== 'succeeded') throw new EmuError(400, 'invalid_request', 'Платёж не succeeded', 'payment_id');
    } else {
      const r = state.refunds.get(body.refund_id);
      if (!r || r.shopId !== shop.shopId) throw new EmuError(400, 'invalid_request', 'Нет refund_id', 'refund_id');
    }
    const settlements = body.settlements;
    if (!Array.isArray(settlements) || settlements.length === 0 || settlements.length > 10) {
      throw new EmuError(400, 'invalid_request', 'Нужны settlements', 'settlements');
    }
    let total = 0;
    let prepaid = 0;
    settlements.forEach((st, i) => {
      if (!st || !SETTLEMENT_TYPES.includes(st.type)) throw new EmuError(400, 'invalid_request', 'Неверный тип расчёта', `settlements[${i}].type`);
      const a = parseAmount(st.amount, `settlements[${i}].amount`);
      total += a;
      if (st.type === 'prepayment') prepaid += a;
    });
    checkReceipt({ customer: body.customer, items: body.items, tax_system_code: body.tax_system_code }, total);
    if (prepaid > 0) {
      // Зачёт предоплаты — позиции полного или частичного расчёта, не больше оплаченного по платежу.
      for (const [i, it] of body.items.entries()) {
        if (!['full_payment', 'partial_payment'].includes(it.payment_mode)) {
          throw new EmuError(400, 'invalid_request', 'Зачёт предоплаты: payment_mode full_payment или partial_payment', `items[${i}].payment_mode`);
        }
      }
      if (payment) {
        const used = payment.prepaymentSettled ?? 0;
        if (used + prepaid > payment.amountKopecks - payment.refundedKopecks) {
          throw new EmuError(400, 'invalid_request', 'Зачёт больше остатка предоплаты', 'settlements');
        }
        payment.prepaymentSettled = used + prepaid;
      }
    }
    const rec = {
      id: `rt_${randomUUID()}`,
      type,
      ...(payment ? { payment_id: payment.id } : { refund_id: body.refund_id }),
      status: 'succeeded',
      fiscal_document_number: String(1000 + state.receipts.size),
      fiscal_storage_number: '9999078900004792',
      fiscal_attribute: String(1000000000 + state.receipts.size),
      registered_at: nowIso(),
      fiscal_provider_id: 'emu',
      items: body.items,
      settlements,
      ...(body.tax_system_code !== undefined ? { tax_system_code: body.tax_system_code } : {}),
      shopId: shop.shopId,
      customer: body.customer,
    };
    state.receipts.set(rec.id, rec);
    if (payment) payment.receipts.push({ kind: 'settlement', receipt: { customer: body.customer, items: body.items, settlements }, amount_kopecks: total, receipt_id: rec.id });
    return receiptView(rec);
  }

  function receiptView(r) {
    const { shopId: _shop, customer: _customer, ...rest } = r;
    return { ...rest };
  }

  function getReceiptObject(shop, id) {
    const r = state.receipts.get(id);
    if (!r || r.shopId !== shop.shopId) throw new EmuError(404, 'not_found', 'Чек не найден');
    return receiptView(r);
  }

  function getRefund(shop, id) {
    const r = state.refunds.get(id);
    if (!r || r.shopId !== shop.shopId) throw new EmuError(404, 'not_found', 'Возврат не найден');
    return refundView(r);
  }

  // HTTP ------------------------------------------------------------------------------------

  function errorBody(err) {
    return { type: 'error', id: randomUUID(), code: err.code, description: err.message, ...(err.parameter ? { parameter: err.parameter } : {}) };
  }

  function send(res, status, body, headers = {}) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(text);
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new EmuError(413, 'invalid_request', 'Слишком большое тело запроса');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function readJson(req, { optional = false } = {}) {
    const text = await readBody(req);
    if (text.trim() === '') {
      if (optional) return {};
      throw new EmuError(400, 'invalid_request', 'Пустое тело запроса');
    }
    try {
      const v = JSON.parse(text);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not object');
      return v;
    } catch {
      throw new EmuError(400, 'invalid_request', 'Тело — объект JSON');
    }
  }

  /** decline_recurring: true (все, пока не снят) | false | N | { count?, reason? } (M5.3). */
  function parseDecline(v) {
    const reasonOf = (r) => (typeof r === 'string' && /^[a-z_]{1,64}$/.test(r) ? r : 'insufficient_funds');
    if (v === true) return { count: -1, reason: 'insufficient_funds' };
    if (v === false || v === null) return { count: 0, reason: 'insufficient_funds' };
    if (typeof v === 'number') return { count: Math.max(-1, Math.floor(v) || 0), reason: 'insufficient_funds' };
    if (typeof v === 'object') return { count: v.count === undefined ? -1 : Math.max(-1, Math.floor(Number(v.count)) || 0), reason: reasonOf(v.reason) };
    throw new EmuError(400, 'invalid_request', 'decline_recurring — true, false, число или объект', 'decline_recurring');
  }

  /** lose_next_response: N | { path?, method?, count?, mode?: 'error' | 'reset' }. */
  function parseLoseNext(v) {
    if (typeof v === 'number') return { count: Math.max(0, Math.floor(v) || 0), path: null, method: 'POST', mode: 'error' };
    if (!v || typeof v !== 'object') throw new EmuError(400, 'invalid_request', 'lose_next_response — число или объект', 'lose_next_response');
    const method = typeof v.method === 'string' ? v.method.toUpperCase() : 'POST';
    const path = typeof v.path === 'string' && v.path.startsWith('/v3/') ? v.path : null;
    if (v.path !== undefined && path === null) throw new EmuError(400, 'invalid_request', 'path — путь API /v3/…', 'lose_next_response.path');
    const mode = v.mode === 'reset' ? 'reset' : 'error';
    return { count: Math.max(0, Math.floor(Number(v.count ?? 1)) || 0), path, method, mode };
  }

  /** Потерять этот ответ? path совпадает точно или как префикс (/v3/payments — и /v3/payments/{id}/capture). */
  function shouldLose(req, path) {
    const l = config.loseNext;
    if (l.count <= 0 || req.method !== l.method) return false;
    if (l.path && path !== l.path && !path.startsWith(`${l.path.replace(/\/+$/, '')}/`)) return false;
    l.count -= 1;
    return true;
  }

  /** Ответ изменяющей операции: результат уже сохранён (idempotent), поэтому его можно «потерять». */
  function respond(req, res, path, r) {
    if (shouldLose(req, path)) {
      res.lostResponse = true;
      if (config.loseNext.mode === 'reset') {
        req.socket.destroy();
        return;
      }
      throw new EmuError(500, 'internal_server_error', 'Эмулятор: операция выполнена, ответ потерян (lose_next_response)');
    }
    send(res, r.status, r.body);
  }

  async function handleApi(req, res, path) {
    if (config.down) throw new EmuError(503, 'internal_server_error', 'Эмулятор: API недоступен (down)');
    if (config.failNext.count > 0) {
      config.failNext.count -= 1;
      throw new EmuError(config.failNext.status, 'internal_server_error', 'Эмулятор: сбой по запросу теста');
    }
    const shop = authenticate(req);
    let m;
    if (req.method === 'GET' && path === '/v3/me') return send(res, 200, meView(shop));
    if (req.method === 'POST' && path === '/v3/payments') {
      const body = await readJson(req);
      const r = idempotent(shop, req, 'payments', body, () => createPayment(shop, body));
      return respond(req, res, path, r);
    }
    if (req.method === 'GET' && (m = /^\/v3\/payments\/([\w-]{1,64})$/.exec(path))) {
      return send(res, 200, view(getPayment(shop, m[1])));
    }
    if (req.method === 'POST' && (m = /^\/v3\/payments\/([\w-]{1,64})\/capture$/.exec(path))) {
      const body = await readJson(req, { optional: true });
      const r = idempotent(shop, req, `capture/${m[1]}`, body, () => capturePayment(shop, m[1], body));
      return respond(req, res, path, r);
    }
    if (req.method === 'POST' && (m = /^\/v3\/payments\/([\w-]{1,64})\/cancel$/.exec(path))) {
      const body = await readJson(req, { optional: true });
      const r = idempotent(shop, req, `cancel/${m[1]}`, body, () => cancelPayment(shop, m[1]));
      return respond(req, res, path, r);
    }
    if (req.method === 'POST' && path === '/v3/receipts') {
      const body = await readJson(req);
      const r = idempotent(shop, req, 'receipts', body, () => createReceipt(shop, body));
      return respond(req, res, path, r);
    }
    if (req.method === 'GET' && (m = /^\/v3\/receipts\/([\w-]{1,64})$/.exec(path))) {
      return send(res, 200, getReceiptObject(shop, m[1]));
    }
    if (req.method === 'POST' && path === '/v3/refunds') {
      const body = await readJson(req);
      const r = idempotent(shop, req, 'refunds', body, () => createRefund(shop, body));
      return respond(req, res, path, r);
    }
    if (req.method === 'GET' && (m = /^\/v3\/refunds\/([\w-]{1,64})$/.exec(path))) {
      return send(res, 200, getRefund(shop, m[1]));
    }
    throw new EmuError(404, 'not_found', 'Метод не поддерживается эмулятором');
  }

  function payPage(p) {
    const title = p.status === 'pending' ? 'Подтверждение оплаты' : 'Платёж';
    const statusText = {
      pending: '',
      succeeded: 'Оплачено',
      waiting_for_capture: 'Сумма заморожена',
      canceled: 'Платёж отклонён',
    }[p.status];
    const method = p.paymentMethod.type === 'sbp' ? 'СБП' : 'Банковская карта';
    const buttons = p.status === 'pending'
      ? `<form method="post" action="/pay/${p.id}/confirm"><button class="ok" type="submit">Оплатить</button></form>
         <form method="post" action="/pay/${p.id}/decline"><button class="no" type="submit">Отказ</button></form>`
      : `<p class="st">${escapeHtml(statusText)}</p>${p.returnUrl ? `<p><a href="${escapeHtml(p.returnUrl)}">Вернуться</a></p>` : ''}`;
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — эмулятор ЮKassa</title>
<style>body{font:16px/1.4 system-ui,sans-serif;margin:0;padding:24px;background:#f4f5f7;color:#1b1f27}
main{max-width:420px;margin:0 auto;background:#fff;border-radius:12px;padding:24px}
.sum{font-size:32px;font-weight:700;margin:8px 0}.muted{color:#5b6475;font-size:14px}
form{margin:12px 0 0}button{width:100%;padding:14px;font-size:17px;border-radius:10px;border:0;cursor:pointer}
.ok{background:#1a7a4d;color:#fff}.no{background:#e7e9ee;color:#1b1f27}.st{font-weight:700}</style></head>
<body><main><p class="muted">Эмулятор ЮKassa · тестовый платёж</p>
<p>${escapeHtml(p.description ?? 'Оплата')}</p><p class="sum">${rub(p.amountKopecks)}</p>
<p class="muted">${method}${p.capture ? '' : ' · сумма будет заморожена'}</p>${buttons}</main></body></html>`;
  }

  async function handlePay(req, res, path) {
    let m;
    if (req.method === 'GET' && (m = /^\/pay\/([\w-]{1,64})$/.exec(path))) {
      const p = getPayment(null, m[1]);
      const ret = p.returnUrl ? ` ${new URL(p.returnUrl).origin}` : '';
      return send(res, 200, payPage(p), {
        'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${ret}; frame-ancestors 'none'; base-uri 'none'`,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
    }
    if (req.method === 'POST' && (m = /^\/pay\/([\w-]{1,64})\/(confirm|decline)$/.exec(path))) {
      await readBody(req);
      const p = getPayment(null, m[1]);
      if (p.status === 'pending') {
        if (m[2] === 'confirm') confirm(p);
        else decline(p);
      }
      // QR без return_url: гость платил с телефона, возвращаться некуда — страница со статусом.
      res.writeHead(303, { location: p.returnUrl ?? `/pay/${p.id}`, 'cache-control': 'no-store' });
      return res.end();
    }
    throw new EmuError(404, 'not_found', 'Страница не найдена');
  }

  async function handleControl(req, res, path, url) {
    if (config.controlToken && !safeEqual(req.headers['x-emu-token'] ?? '', config.controlToken)) {
      throw new EmuError(401, 'invalid_credentials', 'Нужен X-Emu-Token');
    }
    let m;
    if (req.method === 'POST' && path === '/__emu/reset') {
      await readBody(req);
      state.payments.clear();
      state.refunds.clear();
      state.receipts.clear();
      state.methods.clear();
      state.idempotence.clear();
      state.webhooks.length = 0;
      state.requests.length = 0;
      config.failNext = { count: 0, status: 500 };
      config.loseNext = { count: 0, path: null, method: 'POST', mode: 'error' };
      config.declineRecurring = { count: 0, reason: 'insufficient_funds' };
      config.down = false;
      config.webhookDelayMs = opts.webhookDelayMs ?? 0;
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/__emu/shops') {
      const b = await readJson(req);
      addShop({ shopId: b.shop_id, secret: b.secret, webhookUrl: b.webhook_url ?? null, test: b.test, fiscalization: b.fiscalization_enabled });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/__emu/config') {
      const b = await readJson(req);
      if (b.webhook_delay_ms !== undefined) config.webhookDelayMs = Math.max(0, Number(b.webhook_delay_ms) || 0);
      if (b.webhook_retries !== undefined) config.webhookRetries = Math.max(1, Math.min(20, Number(b.webhook_retries) || 1));
      if (b.webhook_retry_delay_ms !== undefined) config.webhookRetryDelayMs = Math.max(0, Number(b.webhook_retry_delay_ms) || 0);
      if (b.fail_next !== undefined) config.failNext = { count: Math.max(0, Number(b.fail_next.count ?? 1)), status: Number(b.fail_next.status ?? 500) };
      if (b.lose_next_response !== undefined) config.loseNext = parseLoseNext(b.lose_next_response);
      if (b.decline_recurring !== undefined) config.declineRecurring = parseDecline(b.decline_recurring);
      if (b.down !== undefined) config.down = Boolean(b.down);
      if (b.webhook_url !== undefined) config.webhookUrl = b.webhook_url;
      return send(res, 200, { ok: true, config: { ...config, controlToken: undefined } });
    }
    if (req.method === 'GET' && path === '/__emu/payments') {
      return send(res, 200, [...state.payments.values()].map((p) => ({ ...view(p), receipts: p.receipts })));
    }
    if (req.method === 'GET' && (m = /^\/__emu\/payments\/([\w-]{1,64})$/.exec(path))) {
      const p = getPayment(null, m[1]);
      return send(res, 200, { ...view(p), receipt: p.receipt, receipts: p.receipts, capture: p.capture, shop_id: p.shopId });
    }
    if (req.method === 'POST' && (m = /^\/__emu\/payments\/([\w-]{1,64})\/(succeed|cancel)$/.exec(path))) {
      await readBody(req);
      const p = getPayment(null, m[1]);
      const delivery = m[2] === 'succeed' ? confirm(p) : decline(p, p.status === 'waiting_for_capture' ? 'expired_on_capture' : 'general_decline');
      if (url.searchParams.get('wait') === '1') await delivery;
      return send(res, 200, view(p));
    }
    if (req.method === 'POST' && (m = /^\/__emu\/payments\/([\w-]{1,64})\/webhook$/.exec(path))) {
      // Повтор вебхука N раз; override — подмена полей объекта; raw — тело как есть (pentester).
      const b = await readJson(req, { optional: true });
      const p = getPayment(null, m[1]);
      const repeat = Math.max(1, Math.min(50, Number(url.searchParams.get('repeat') ?? b.repeat ?? 1) || 1));
      const event = url.searchParams.get('event') ?? b.event ?? eventFor(p);
      const target = b.url ?? webhookUrlFor(p);
      const deliveries = [];
      for (let i = 0; i < repeat; i += 1) {
        const body = typeof b.raw === 'string' ? b.raw : { type: 'notification', event, object: { ...view(p), ...(b.override ?? {}) } };
        deliveries.push(deliver(target, body, { event, objectId: p.id, retries: b.retries ?? 1 }));
      }
      const results = url.searchParams.get('wait') === '0' ? [] : await Promise.all(deliveries);
      return send(res, 200, { ok: true, deliveries: results.map((r) => ({ delivered: r.delivered, attempts: r.attempts })) });
    }
    if (req.method === 'GET' && path === '/__emu/payment-methods') return send(res, 200, [...state.methods.values()].map((m) => ({ ...m, shop_id: m.shopId, shopId: undefined })));
    if (req.method === 'POST' && (m = /^\/__emu\/payment-methods\/([\w-]{1,64})\/revoke$/.exec(path))) {
      await readBody(req);
      const method = state.methods.get(m[1]);
      if (!method) throw new EmuError(404, 'not_found', 'Способ оплаты не найден');
      method.revoked = true;
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && path === '/__emu/webhooks') return send(res, 200, state.webhooks);
    if (req.method === 'GET' && path === '/__emu/receipts') return send(res, 200, [...state.receipts.values()]);
    if (req.method === 'GET' && path === '/__emu/requests') return send(res, 200, state.requests);
    throw new EmuError(404, 'not_found', 'Неизвестная команда эмулятора');
  }

  async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://emu');
    const path = url.pathname;
    const entry = { method: req.method, path, idempotence_key: req.headers['idempotence-key'] ?? null, at: nowIso(), status: null };
    if (path.startsWith('/v3/')) {
      state.requests.push(entry);
      if (state.requests.length > 2000) state.requests.shift();
    }
    try {
      if (path.startsWith('/v3/')) await handleApi(req, res, path);
      else if (path.startsWith('/pay/')) await handlePay(req, res, path);
      else if (path.startsWith('/__emu/')) await handleControl(req, res, path, url);
      else if (path === '/health') send(res, 200, { ok: true });
      else throw new EmuError(404, 'not_found', 'Не найдено');
      entry.status = res.lostResponse ? 'reset' : res.statusCode;
      if (res.lostResponse) entry.lost = true;
    } catch (err) {
      const e = err instanceof EmuError ? err : new EmuError(500, 'internal_server_error', 'Внутренняя ошибка эмулятора');
      if (!(err instanceof EmuError)) log.warn('emu_error', { error: err.message });
      entry.status = e.status;
      if (res.lostResponse) entry.lost = true;
      if (!res.headersSent) send(res, e.status, errorBody(e));
      else res.end();
    }
  }

  const server = http.createServer(handler);

  return {
    handler,
    server,
    state,
    config,
    addShop,
    /** Дождаться всех вебхуков в полёте (тесты). */
    async settle() {
      while (state.pending.size > 0) await Promise.allSettled([...state.pending]);
    },
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
