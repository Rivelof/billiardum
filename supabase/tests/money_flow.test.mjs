// Деньги M1 (контракт §5, §13) на настоящем Postgres и эмуляторе ЮKassa:
// стол, котировка и гонка двух гостей, оплата и идемпотентность, вебхук (подделка, повтор,
// неверная сумма, чужой клуб, недоступная ЮKassa), «Без лимита» (заморозка и списание),
// ресепшн (сдача, отказ, сгорание), возвраты, сверка зависших платежей.
// Соседи (light, core) — заглушки по контракту, см. money_harness.mjs.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { routes as quoteRoutes } from '../../api/routes/quotes.mjs';
import { routes as paymentRoutes } from '../../api/routes/payments.mjs';
import { routes as receptionRoutes } from '../../api/routes/reception.mjs';
import { routes as webhookRoutes } from '../../api/routes/webhooks.mjs';
import { receiptStatus, refund } from '../../server/payments/api.mjs';
import { onSessionClosed } from '../../server/payments/capture.mjs';
import { tick } from '../../server/payments/index.mjs';
import { resolveDeps } from '../../server/payments/deps.mjs';
import { withContext } from '../../server/lib/store.mjs';
import {
  CLUB_A,
  CLUB_B,
  GUEST_1,
  GUEST_2,
  GUEST_NO_CONSENT,
  GUEST_NO_PHONE,
  newKey,
  OWNER_A,
  RECEPTION_A,
  setupMoney,
  TABLE_1,
  TABLE_2,
} from './money_harness.mjs';

/** withContext под app_api (те же права и RLS, что у сервера). */
const asAppApi = (pool, c, fn) =>
  withContext(pool, c, async (db) => {
    await db.query('set local role app_api');
    return fn(db);
  });

const route = (list, method, path) => list.find((r) => r.method === method && r.path === path);
const TABLE_ROUTE = route(quoteRoutes, 'GET', '/api/t/{code}');
const QUOTE = route(quoteRoutes, 'POST', '/api/quotes');
const PAY = route(quoteRoutes, 'POST', '/api/quotes/{id}/pay');
const PAYMENT = route(paymentRoutes, 'GET', '/api/payments/{id}');
const LIST = route(receptionRoutes, 'GET', '/api/clubs/{club}/reception/requests');
const ACCEPT = route(receptionRoutes, 'POST', '/api/reception/requests/{id}/accept');
const DECLINE = route(receptionRoutes, 'POST', '/api/reception/requests/{id}/decline');
const GUEST_REQ = route(receptionRoutes, 'GET', '/api/reception/requests/{id}');
const WEBHOOK = route(webhookRoutes, 'POST', '/api/webhooks/yookassa/{club_id}');

// Вторник 20.10.2026, 13:00 в Екатеринбурге (08:00Z): 500 ₽/ч до 17:00.
const START = '2026-10-20T08:00:00.000Z';

let h;

before(async () => {
  h = await setupMoney({ start: START });
  h.setWebhookRoute(WEBHOOK);
});

after(async () => {
  await h?.close();
});

async function quote(user, body) {
  return h.call(QUOTE, { user, body });
}

async function pay(user, quoteId, method, key = newKey()) {
  return h.call(PAY, { user, params: { id: quoteId }, body: { method }, idempotencyKey: key });
}

async function freshTable(n) {
  // Свободный стол: сбросить pending заглушки и котировки по столу не нужно — новый стол на тест.
  h.sessions.holds.delete(n);
  return n;
}

async function payment(id) {
  return (await h.q('select * from bl.payments where id = $1', [id]))[0];
}

/** Подтвердить платёж в эмуляторе и дождаться доставки вебхука. */
async function emuSucceed(paymentId) {
  const p = await payment(paymentId);
  const res = await fetch(`${h.emuBase}/__emu/payments/${p.provider_payment_id}/succeed?wait=1`, { method: 'POST' });
  assert.equal(res.status, 200);
  await h.emu.settle();
  return p.provider_payment_id;
}

describe('стол по коду', () => {
  it('GET /api/t/{code}: клуб, стол, статус, цены сейчас и дальше, варианты', async () => {
    const r = await h.call(TABLE_ROUTE, { params: { code: 'TEST000001' } });
    assert.equal(r.status, 200);
    const t = r.json;
    assert.deepEqual(t.club, { id: CLUB_A, name: 'Тестовый клуб', timezone: 'Asia/Yekaterinburg' });
    assert.deepEqual(t.resource, { id: TABLE_1, number: 1, type: 'billiard_pyramid', title: 'Стол 1' });
    assert.equal(t.status, 'free');
    assert.equal(t.busy_until, null);
    assert.equal(t.price_now.price_per_hour_kopecks, 50000);
    assert.equal(t.price_now.until_local, '17:00');
    assert.deepEqual({ p: t.price_next.price_per_hour_kopecks, f: t.price_next.from_local }, { p: 80000, f: '17:00' });
    assert.deepEqual(t.options, [60, 120, 180, 'unlimited']);
    assert.equal(t.my_session_id, null);
  });

  it('неизвестный и кривой код — 404', async () => {
    assert.equal((await h.call(TABLE_ROUTE, { params: { code: 'ZZZZZZZZZZ' } })).status, 404);
    assert.equal((await h.call(TABLE_ROUTE, { params: { code: '../x' } })).status, 404);
  });

  it('маршрут объявляет ограничение 120 запросов в минуту с IP (§14, считает роутер)', () => {
    assert.deepEqual(TABLE_ROUTE.rateLimit, { max: 120, windowMs: 60_000 });
    assert.equal(TABLE_ROUTE.auth, 'none');
  });
});

describe('котировка', () => {
  it('start на 1 час: 500 ₽, разбивка, 3 минуты, стол в pending за гостем', async () => {
    const t = await freshTable(TABLE_2);
    const r = await quote(GUEST_1, { resource_id: t, kind: 'start', minutes: 60 });
    assert.equal(r.status, 200);
    assert.equal(r.json.amount_kopecks, 50000);
    assert.equal(r.json.minutes, 60);
    assert.equal(r.json.valid_until, '2026-10-20T08:03:00.000Z');
    assert.deepEqual(r.json.breakdown, [{ from: START, to: '2026-10-20T09:00:00.000Z', price_per_hour_kopecks: 50000, amount_kopecks: 50000 }]);
    const hold = h.sessions.holds.get(t);
    assert.equal(hold.userId, GUEST_1);
    assert.equal(hold.until.toISOString(), '2026-10-20T08:03:00.000Z');
    const row = (await h.q('select * from bl.quotes where id = $1', [r.json.quote_id]))[0];
    assert.equal(row.club_id, CLUB_A);
    assert.equal(Number(row.amount_kopecks), 50000);
    assert.equal(row.used_at, null);
  });

  it('гонка двух гостей за свободный стол: один получает котировку, второй — 409 table_pending', async () => {
    const t = 'e1000000-0000-4000-8000-000000000003';
    const [a, b] = await Promise.all([
      quote(GUEST_1, { resource_id: t, kind: 'start', minutes: 60 }),
      quote(GUEST_2, { resource_id: t, kind: 'start', minutes: 120 }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const loser = a.status === 409 ? a : b;
    assert.deepEqual(loser.json, { error: 'table_pending' });
    const rows = await h.q('select user_id from bl.quotes where resource_id = $1', [t]);
    assert.equal(rows.length, 1, 'котировка проигравшего не записана');
    // Тот же гость может пересчитать цену (удержание продлевается).
    const winner = a.status === 200 ? GUEST_1 : GUEST_2;
    assert.equal((await quote(winner, { resource_id: t, kind: 'start', minutes: 180 })).status, 200);
  });

  it('неверные минуты, kind и стол — 400/404', async () => {
    assert.equal((await quote(GUEST_1, { resource_id: TABLE_2, kind: 'start', minutes: 45 })).json.error, 'bad_request');
    assert.equal((await quote(GUEST_1, { resource_id: TABLE_2, kind: 'start', minutes: 2 })).json.error, 'bad_request');
    assert.equal((await quote(GUEST_1, { resource_id: TABLE_2, kind: 'stop', minutes: 60 })).json.error, 'bad_request');
    assert.equal((await quote(GUEST_1, { resource_id: TABLE_2, kind: 'extend', minutes: 60 })).json.error, 'bad_request');
    assert.equal((await quote(GUEST_1, { resource_id: 'e9999999-0000-4000-8000-000000000000', kind: 'start', minutes: 60 })).status, 404);
  });

  it('без телефона — phone_required, без согласия — consent_required, без входа — unauthorized', async () => {
    assert.deepEqual((await quote(GUEST_NO_PHONE, { resource_id: TABLE_2, kind: 'start', minutes: 60 })).json, { error: 'phone_required' });
    assert.deepEqual((await quote(GUEST_NO_CONSENT, { resource_id: TABLE_2, kind: 'start', minutes: 60 })).json, { error: 'consent_required' });
    assert.deepEqual((await quote(null, { resource_id: TABLE_2, kind: 'start', minutes: 60 })).json, { error: 'unauthorized' });
  });

  it('DEV_ALLOW_ANY_MINUTES: 2 минуты без минимума — 17 ₽; в проде флаг не действует', async () => {
    const saved = h.ctx.money.config;
    h.ctx.money.config = { ...saved, devAllowAnyMinutes: true };
    try {
      const r = await quote(GUEST_1, { resource_id: 'e1000000-0000-4000-8000-000000000004', kind: 'start', minutes: 2 });
      assert.equal(r.status, 200);
      assert.equal(r.json.minutes, 2);
      assert.equal(r.json.amount_kopecks, 1700);
    } finally {
      h.ctx.money.config = saved;
    }
    const { loadMoneyConfig } = await import('../../server/payments/config.mjs');
    assert.equal(loadMoneyConfig({ NODE_ENV: 'production', DEV_ALLOW_ANY_MINUTES: '1' }).devAllowAnyMinutes, false);
    assert.throws(() => loadMoneyConfig({ NODE_ENV: 'production', YOOKASSA_API_URL: 'http://emu:8090/v3' }), /только https:\/\/api\.yookassa\.ru\/v3/);
  });

  it('«Без лимита»: заморозка за 2 часа и блок СБП 30 минут', async () => {
    const r = await quote(GUEST_1, { resource_id: 'e1000000-0000-4000-8000-000000000005', kind: 'start', minutes: null });
    assert.equal(r.status, 200);
    assert.equal(r.json.minutes, null);
    assert.equal(r.json.amount_kopecks, 100000);
    assert.deepEqual(r.json.unlimited, { hold_minutes: 120, hold_amount_kopecks: 100000, sbp_block_minutes: 30, sbp_block_amount_kopecks: 25000 });
  });

  it('продление: от paid_until, любой участник; чужой — 403, закрытая сессия — 409', async () => {
    const sid = 'b7000000-0000-4000-8000-000000000001';
    await h.pool.query(
      `insert into bl.sessions (id, club_id, resource_id, status, payer_user_id, started_at, paid_until, ended_at, created_at, updated_at)
       values ($1, $2, 'e1000000-0000-4000-8000-000000000006', 'closed', $3, $4, '2026-10-20T11:30:00Z', '2026-10-20T11:32:00Z', $4, $4)`,
      [sid, CLUB_A, GUEST_1, START],
    );
    h.sessions.sessions.set(sid, {
      id: sid,
      resource_id: 'e1000000-0000-4000-8000-000000000006',
      paid_until: new Date('2026-10-20T11:30:00Z'), // 16:30 местного
      status: 'active',
      participants: new Set([GUEST_1, GUEST_2]),
      payer: GUEST_1,
    });
    const r = await quote(GUEST_2, { resource_id: 'e1000000-0000-4000-8000-000000000006', kind: 'extend', minutes: 60, session_id: sid });
    assert.equal(r.status, 200);
    // 16:30–17:00 по 500 ₽ и 17:00–17:30 по 800 ₽ (пул: те же цены).
    assert.equal(r.json.amount_kopecks, 25000 + 40000);
    assert.equal(r.json.breakdown[0].from, '2026-10-20T11:30:00.000Z');
    // Заморозка «Без лимита» — только у сессии «Без лимита».
    assert.deepEqual((await quote(GUEST_1, { resource_id: 'e1000000-0000-4000-8000-000000000006', kind: 'extend', minutes: null, session_id: sid })).json, { error: 'bad_request' });
    const stranger = await quote(GUEST_NO_CONSENT, { resource_id: 'e1000000-0000-4000-8000-000000000006', kind: 'extend', minutes: 60, session_id: sid });
    assert.equal(stranger.json.error, 'consent_required');
    h.sessions.sessions.get(sid).participants.delete(GUEST_2);
    assert.deepEqual((await quote(GUEST_2, { resource_id: 'e1000000-0000-4000-8000-000000000006', kind: 'extend', minutes: 60, session_id: sid })).json, { error: 'forbidden' });
    h.sessions.sessions.get(sid).status = 'closed';
    assert.deepEqual((await quote(GUEST_1, { resource_id: 'e1000000-0000-4000-8000-000000000006', kind: 'extend', minutes: 60, session_id: sid })).json, { error: 'session_not_active' });
    const row = (await h.q('select kind, session_id, from_at from bl.quotes where id = $1', [r.json.quote_id]))[0];
    assert.deepEqual({ k: row.kind, s: row.session_id, f: row.from_at.toISOString() }, { k: 'extend', s: sid, f: '2026-10-20T11:30:00.000Z' });
  });
});

describe('оплата СБП и картой', () => {
  let q;
  let key;
  let paid;

  it('СБП: платёж ЮKassa с чеком 54-ФЗ, Idempotence-Key и return_url', async () => {
    const t = 'e1000000-0000-4000-8000-000000000007';
    q = (await quote(GUEST_1, { resource_id: t, kind: 'start', minutes: 120 })).json;
    key = newKey();
    const r = await pay(GUEST_1, q.quote_id, 'sbp', key);
    assert.equal(r.status, 200);
    paid = r.json;
    assert.equal(paid.status, 'pending');
    assert.equal(paid.confirmation.type, 'redirect');
    const p = await payment(paid.payment_id);
    assert.equal(paid.confirmation.url, `${h.emuBase}/pay/${p.provider_payment_id}`);
    assert.equal(p.method, 'sbp');
    assert.equal(Number(p.amount_kopecks), 100000);
    assert.equal(p.capture, true);
    assert.equal(p.minutes, 120);
    const emu = await (await fetch(`${h.emuBase}/__emu/payments/${p.provider_payment_id}`)).json();
    assert.deepEqual(emu.amount, { value: '1000.00', currency: 'RUB' });
    assert.equal(emu.capture, true);
    assert.equal(emu.payment_method.type, 'sbp');
    assert.deepEqual(emu.metadata, { club_id: CLUB_A, quote_id: q.quote_id, kind: 'start', payment_id: paid.payment_id });
    assert.deepEqual(emu.receipt, {
      customer: { phone: '79990000001' },
      items: [{ description: 'Игра, стол 7, 2 ч', quantity: 1, amount: { value: '1000.00', currency: 'RUB' }, vat_code: 1, payment_mode: 'full_payment', payment_subject: 'service' }],
      tax_system_code: 2,
    });
    const requests = await (await fetch(`${h.emuBase}/__emu/requests`)).json();
    const create = requests.filter((x) => x.path === '/v3/payments' && x.method === 'POST');
    assert.equal(create.at(-1).idempotence_key, `q-${q.quote_id}-sbp`);
    const receipt = (await h.q('select * from bl.receipts where payment_id = $1', [paid.payment_id]))[0];
    assert.equal(receipt.channel, 'yookassa');
    assert.equal(Number(receipt.amount_kopecks), 100000);
    assert.equal((await h.q('select used_at from bl.quotes where id = $1', [q.quote_id]))[0].used_at.toISOString(), START);
  });

  it('повтор с тем же Idempotency-Key — тот же платёж без второго запроса в ЮKassa', async () => {
    const before = (await (await fetch(`${h.emuBase}/__emu/requests`)).json()).length;
    const r = await pay(GUEST_1, q.quote_id, 'sbp', key);
    assert.equal(r.status, 200);
    assert.equal(r.json.payment_id, paid.payment_id);
    const afterN = (await (await fetch(`${h.emuBase}/__emu/requests`)).json()).length;
    assert.equal(afterN, before);
  });

  it('котировка одноразовая: другой ключ — quote_used, тот же ключ с другим способом — idempotency_conflict', async () => {
    assert.deepEqual((await pay(GUEST_1, q.quote_id, 'card')).json, { error: 'quote_used' });
    assert.deepEqual((await pay(GUEST_1, q.quote_id, 'card', key)).json, { error: 'idempotency_conflict' });
    assert.equal((await pay(GUEST_2, q.quote_id, 'sbp')).status, 404, 'чужая котировка не видна');
    assert.equal((await pay(GUEST_1, q.quote_id, 'cash')).json.error, 'bad_request');
    assert.equal((await h.call(PAY, { user: GUEST_1, params: { id: q.quote_id }, body: { method: 'sbp' } })).json.error, 'bad_request', 'без Idempotency-Key');
  });

  it('просроченная котировка — quote_expired, ЮKassa не вызывается', async () => {
    const q2 = (await quote(GUEST_2, { resource_id: 'e1000000-0000-4000-8000-000000000008', kind: 'start', minutes: 60 })).json;
    h.clock.advance(3 * 60_000);
    try {
      assert.deepEqual((await pay(GUEST_2, q2.quote_id, 'sbp')).json, { error: 'quote_expired' });
    } finally {
      h.clock.advance(-3 * 60_000);
    }
  });

  it('гость подтвердил: вебхук → перепроверка по API → succeeded, журнал, outbox payment.confirmed один раз', async () => {
    const before = (await h.outbox('payment.confirmed')).length;
    await emuSucceed(paid.payment_id);
    const p = await payment(paid.payment_id);
    assert.equal(p.status, 'succeeded');
    assert.ok(p.confirmed_at);
    const events = (await h.outbox('payment.confirmed')).slice(before);
    assert.equal(events.length, 1);
    assert.equal(events[0].club_id, CLUB_A);
    assert.deepEqual(events[0].payload, {
      payment_id: paid.payment_id,
      club_id: CLUB_A,
      quote_id: q.quote_id,
      kind: 'start',
      session_id: null,
      resource_id: 'e1000000-0000-4000-8000-000000000007',
      user_id: GUEST_1,
      minutes: 120,
      unlimited: false,
      amount_kopecks: 100000,
      method: 'sbp',
    });
    const audit = (await h.audit('payment.succeeded')).filter((a) => a.object_id === paid.payment_id);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].club_id, CLUB_A);
    assert.equal(audit[0].actor_type, 'system');
    assert.deepEqual(audit[0].data, { payment_id: paid.payment_id, method: 'sbp', amount_kopecks: 100000, status: 'succeeded', kind: 'start' });
    const receipt = (await h.q('select status from bl.receipts where payment_id = $1', [paid.payment_id]))[0];
    assert.equal(receipt.status, 'succeeded');
  });

  it('повтор вебхука 3 раза — 200 без действий', async () => {
    const before = (await h.outbox('payment.confirmed')).length;
    const p = await payment(paid.payment_id);
    const r = await (await fetch(`${h.emuBase}/__emu/payments/${p.provider_payment_id}/webhook?repeat=3`, { method: 'POST' })).json();
    assert.deepEqual(r.deliveries.map((d) => d.attempts.at(-1).status), [200, 200, 200]);
    assert.equal((await h.outbox('payment.confirmed')).length, before);
    assert.equal((await h.audit('payment.succeeded')).filter((a) => a.object_id === paid.payment_id).length, 1);
  });

  it('GET /api/payments/{id}: плательщику — статус и сессия; чужому — 404', async () => {
    await h.pool.query(
      `insert into bl.sessions (id, club_id, resource_id, status, payer_user_id, started_at, paid_until, created_at, updated_at)
       values ('b7000000-0000-4000-8000-000000000007', $1, 'e1000000-0000-4000-8000-000000000007', 'active', $2, $3, $4, $3, $3)`,
      [CLUB_A, GUEST_1, START, '2026-10-20T10:00:00Z'],
    );
    await h.pool.query(
      `insert into bl.session_payments (payment_id, club_id, session_id, kind, outcome, minutes, amount_kopecks, created_at)
       values ($1, $2, 'b7000000-0000-4000-8000-000000000007', 'start', 'applied', 120, 100000, $3)`,
      [paid.payment_id, CLUB_A, START],
    );
    const r = await h.call(PAYMENT, { user: GUEST_1, params: { id: paid.payment_id } });
    assert.deepEqual(r.json, { payment_id: paid.payment_id, status: 'succeeded', session_id: 'b7000000-0000-4000-8000-000000000007' });
    assert.equal((await h.call(PAYMENT, { user: GUEST_2, params: { id: paid.payment_id } })).status, 404);
  });

  it('отказ гостя: payment.canceled, pending снят со стола', async () => {
    const t = 'e1000000-0000-4000-8000-000000000002';
    h.sessions.holds.delete(t);
    const q3 = (await quote(GUEST_2, { resource_id: t, kind: 'start', minutes: 60 })).json;
    const r = await pay(GUEST_2, q3.quote_id, 'card');
    assert.ok(h.sessions.holds.get(t));
    const p = await payment(r.json.payment_id);
    await fetch(`${h.emuBase}/__emu/payments/${p.provider_payment_id}/cancel?wait=1`, { method: 'POST' });
    await h.emu.settle();
    const after = await payment(r.json.payment_id);
    assert.equal(after.status, 'canceled');
    assert.equal(after.cancellation_reason, 'general_decline');
    assert.equal(h.sessions.holds.get(t), undefined);
    assert.equal((await h.audit('payment.canceled')).filter((a) => a.object_id === p.id).length, 1);
    assert.equal((await h.outbox('payment.confirmed')).filter((e) => e.payload.payment_id === p.id).length, 0);
  });
});

describe('вебхук: телу не верим', () => {
  async function pendingPayment(resourceId, user = GUEST_2) {
    h.sessions.holds.delete(resourceId);
    const q = (await quote(user, { resource_id: resourceId, kind: 'start', minutes: 60 })).json;
    const r = await pay(user, q.quote_id, 'sbp');
    return payment(r.json.payment_id);
  }

  async function postWebhook(clubId, body) {
    return h.call(WEBHOOK, { params: { club_id: clubId }, body, actor: 'system' });
  }

  it('поддельное тело «succeeded» для платежа в pending — 200, но платёж не подтверждён', async () => {
    const p = await pendingPayment('e1000000-0000-4000-8000-000000000003');
    const r = await postWebhook(CLUB_A, { type: 'notification', event: 'payment.succeeded', object: { id: p.provider_payment_id, status: 'succeeded', paid: true, amount: { value: '1.00', currency: 'RUB' }, metadata: { club_id: CLUB_A } } });
    assert.equal(r.status, 200);
    assert.equal((await payment(p.id)).status, 'pending');
    assert.equal((await h.outbox('payment.confirmed')).filter((e) => e.payload.payment_id === p.id).length, 0);
    // Подмена тела вебхука эмулятором (pentester): сумма в теле игнорируется.
    await fetch(`${h.emuBase}/__emu/payments/${p.provider_payment_id}/webhook`, {
      method: 'POST',
      body: JSON.stringify({ event: 'payment.succeeded', override: { status: 'succeeded', amount: { value: '1.00', currency: 'RUB' } } }),
    });
    assert.equal((await payment(p.id)).status, 'pending');
  });

  it('неизвестный id и мусор — 200 или 400, ничего не меняется', async () => {
    assert.equal((await postWebhook(CLUB_A, { event: 'payment.succeeded', object: { id: '2f000000-000f-5000-8000-000000000000' } })).status, 200);
    assert.equal((await postWebhook(CLUB_A, { event: 'payment.succeeded', object: { id: "1' or 1=1" } })).status, 400);
    assert.equal((await postWebhook(CLUB_A, null)).status, 400);
    assert.equal((await postWebhook('c9999999-0000-4000-8000-000000000000', { object: { id: 'x' } })).status, 404);
  });

  it('неверная сумма в ЮKassa — тревога, платёж не подтверждён', async () => {
    const p = await pendingPayment('e1000000-0000-4000-8000-000000000004');
    h.emu.state.payments.get(p.provider_payment_id).amountKopecks = 100;
    await emuSucceed(p.id);
    const after = await payment(p.id);
    assert.equal(after.status, 'pending');
    assert.equal(after.confirmed_at, null);
    const alarm = h.alarms.items.find((a) => a.type === 'payment_mismatch' && a.data.payment_id === p.id);
    assert.ok(alarm);
    assert.deepEqual(alarm.data.problems, ['amount']);
    assert.equal(alarm.level, 'critical');
  });

  it('metadata.club_id чужого клуба — тревога, не подтверждён', async () => {
    const p = await pendingPayment('e1000000-0000-4000-8000-000000000005');
    h.emu.state.payments.get(p.provider_payment_id).metadata.club_id = CLUB_B;
    // Вебхук эмулятора уходит по metadata.club_id (клубу Б) — там платежа нет, 200 без действий.
    await emuSucceed(p.id);
    assert.equal((await payment(p.id)).status, 'pending');
    // Тот же вебхук на путь клуба А: перепроверка показывает чужой metadata.club_id.
    const url = `${h.emu.config.webhookUrl.replace('{club_id}', CLUB_A)}`;
    await fetch(`${h.emuBase}/__emu/payments/${p.provider_payment_id}/webhook`, { method: 'POST', body: JSON.stringify({ url }) });
    assert.equal((await payment(p.id)).status, 'pending');
    assert.ok(h.alarms.items.some((a) => a.data.payment_id === p.id && a.data.problems.includes('club')));
  });

  it('вебхук на путь чужого клуба: перепроверка ключами того клуба — 200, без действий', async () => {
    const p = await pendingPayment('e1000000-0000-4000-8000-000000000006');
    h.emu.state.payments.get(p.provider_payment_id).status = 'succeeded';
    const r = await postWebhook(CLUB_B, { event: 'payment.succeeded', object: { id: p.provider_payment_id } });
    assert.equal(r.status, 200);
    assert.equal((await payment(p.id)).status, 'pending');
    h.emu.state.payments.get(p.provider_payment_id).status = 'pending';
  });

  it('ЮKassa недоступна: 503, ЮKassa повторяет — платёж подтверждается со второй попытки', async () => {
    const p = await pendingPayment('e1000000-0000-4000-8000-000000000008', GUEST_1);
    // Следующий запрос к API (наша перепроверка) — 500.
    await fetch(`${h.emuBase}/__emu/config`, { method: 'POST', body: JSON.stringify({ fail_next: { count: 1, status: 500 } }) });
    await emuSucceed(p.id);
    const rec = h.emu.state.webhooks.filter((w) => w.object_id === p.provider_payment_id).at(-1);
    assert.deepEqual(rec.attempts.map((a) => a.status), [503, 200]);
    assert.equal((await payment(p.id)).status, 'succeeded');
    assert.equal((await h.outbox('payment.confirmed')).filter((e) => e.payload.payment_id === p.id).length, 1);
  });
});

describe('«Без лимита»', () => {
  it('карта: заморозка за 2 часа (capture=false), при закрытии — списание фактических минут с чеком', async () => {
    const t = 'e1000000-0000-4000-8000-000000000001';
    h.sessions.holds.delete(t);
    const q = (await quote(GUEST_1, { resource_id: t, kind: 'start', minutes: null })).json;
    const r = await pay(GUEST_1, q.quote_id, 'card');
    assert.equal(r.status, 200);
    let p = await payment(r.json.payment_id);
    assert.equal(p.capture, false);
    assert.equal(p.unlimited, true);
    assert.equal(p.minutes, 120);
    assert.equal(Number(p.amount_kopecks), 100000);
    const emuP = await (await fetch(`${h.emuBase}/__emu/payments/${p.provider_payment_id}`)).json();
    assert.equal(emuP.capture, false);
    assert.equal(emuP.receipt.items[0].description, 'Игра, стол 1, без лимита');
    await emuSucceed(p.id);
    p = await payment(p.id);
    assert.equal(p.status, 'waiting_for_capture');
    const ev = (await h.outbox('payment.confirmed')).find((e) => e.payload.payment_id === p.id);
    assert.equal(ev.payload.unlimited, true);
    assert.equal(ev.payload.minutes, 120);
    assert.equal(ev.payload.method, 'card');

    // Сессия (light): старт сейчас, гость остановил через 47 минут 20 секунд.
    const sid = 'b7000000-0000-4000-8000-000000000101';
    await h.pool.query(
      `insert into bl.sessions (id, club_id, resource_id, status, payer_user_id, unlimited, started_at, paid_until, ended_at, close_reason, created_at, updated_at)
       values ($1, $2, $3, 'closed', $4, true, $5, $6, $7, 'stopped', $5, $5)`,
      [sid, CLUB_A, t, GUEST_1, START, '2026-10-20T10:00:00Z', '2026-10-20T08:47:20Z'],
    );
    await h.pool.query(
      `insert into bl.session_payments (payment_id, club_id, session_id, kind, outcome, minutes, unlimited, amount_kopecks, created_at)
       values ($1, $2, $3, 'start', 'applied', 120, true, 100000, $4)`,
      [p.id, CLUB_A, sid, START],
    );
    const deps = await resolveDeps(h.ctx);
    const payload = { session_id: sid, club_id: CLUB_A, resource_id: t, paid_until: '2026-10-20T10:00:00.000Z' };
    const res = await withContext(h.pool, { clubId: CLUB_A, actorType: 'system' }, async (db) => {
      await db.query('set local role app_api');
      return onSessionClosed(db, deps, h.config, payload);
    });
    // 48 начатых минут по 500 ₽/ч = 400 ₽.
    assert.deepEqual(res, { captured: 40000, minutes: 48, amount_kopecks: 40000 });
    await h.emu.settle();
    p = await payment(p.id);
    assert.equal(p.status, 'succeeded');
    assert.equal(Number(p.captured_kopecks), 40000);
    const after = await (await fetch(`${h.emuBase}/__emu/payments/${p.provider_payment_id}`)).json();
    assert.equal(after.status, 'succeeded');
    assert.deepEqual(after.amount, { value: '400.00', currency: 'RUB' });
    assert.equal(after.receipt.items[0].description, 'Игра, стол 1, 48 мин');
    assert.deepEqual(after.receipt.items[0].amount, { value: '400.00', currency: 'RUB' });
    const receipts = await h.q('select status, amount_kopecks from bl.receipts where payment_id = $1 order by created_at', [p.id]);
    assert.deepEqual(receipts.map((x) => [x.status, Number(x.amount_kopecks)]), [['canceled', 100000], ['succeeded', 40000]]);
    assert.equal((await h.audit('payment.captured')).filter((a) => a.object_id === p.id).length, 1);

    // Повтор события session.closed — второго списания нет.
    const again = await withContext(h.pool, { clubId: CLUB_A, actorType: 'system' }, async (db) => {
      await db.query('set local role app_api');
      return onSessionClosed(db, deps, h.config, payload);
    });
    assert.deepEqual(again, { skipped: 'no_holds' });
    const caps = (await (await fetch(`${h.emuBase}/__emu/requests`)).json()).filter((x) => x.path.endsWith('/capture'));
    assert.equal(caps.length, 1);
  });

  it('карта: игра короче минимума (10 минут) — списание за 30 минут', async () => {
    const t = 'e1000000-0000-4000-8000-000000000002';
    h.sessions.holds.delete(t);
    const q = (await quote(GUEST_2, { resource_id: t, kind: 'start', minutes: null })).json;
    const r = await pay(GUEST_2, q.quote_id, 'card');
    await emuSucceed(r.json.payment_id);
    const sid = 'b7000000-0000-4000-8000-000000000102';
    await h.pool.query(
      `insert into bl.sessions (id, club_id, resource_id, status, payer_user_id, unlimited, started_at, paid_until, ended_at, close_reason, created_at, updated_at)
       values ($1, $2, $3, 'closed', $4, true, $5, $6, $7, 'stopped', $5, $5)`,
      [sid, CLUB_A, t, GUEST_2, START, '2026-10-20T10:00:00Z', '2026-10-20T08:10:00Z'],
    );
    await h.pool.query(
      `insert into bl.session_payments (payment_id, club_id, session_id, kind, outcome, minutes, unlimited, amount_kopecks, created_at)
       values ($1, $2, $3, 'start', 'applied', 120, true, 100000, $4)`,
      [r.json.payment_id, CLUB_A, sid, START],
    );
    const deps = await resolveDeps(h.ctx);
    const res = await withContext(h.pool, { clubId: CLUB_A, actorType: 'system' }, (db) =>
      onSessionClosed(db, deps, h.config, { session_id: sid, club_id: CLUB_A, resource_id: t, paid_until: '2026-10-20T10:00:00Z' }),
    );
    assert.deepEqual(res, { captured: 25000, minutes: 30, amount_kopecks: 25000 });
  });

  it('СБП: первый блок 30 минут, одностадийно', async () => {
    const t = 'e1000000-0000-4000-8000-000000000003';
    h.sessions.holds.delete(t);
    const q = (await quote(GUEST_1, { resource_id: t, kind: 'start', minutes: null })).json;
    const r = await pay(GUEST_1, q.quote_id, 'sbp');
    const p = await payment(r.json.payment_id);
    assert.equal(p.capture, true);
    assert.equal(p.minutes, 30);
    assert.equal(Number(p.amount_kopecks), 25000);
    assert.equal(p.unlimited, true);
    await emuSucceed(p.id);
    const ev = (await h.outbox('payment.confirmed')).find((e) => e.payload.payment_id === p.id);
    assert.deepEqual({ m: ev.payload.minutes, u: ev.payload.unlimited, a: ev.payload.amount_kopecks }, { m: 30, u: true, a: 25000 });
  });
});

describe('ресепшн', () => {
  let req;
  const t = 'e1000000-0000-4000-8000-000000000004';

  it('«Оплачу на ресепшене»: заявка на 15 минут, pending продлён, событие SSE клубу', async () => {
    h.sessions.holds.delete(t);
    const q = (await quote(GUEST_1, { resource_id: t, kind: 'start', minutes: 120 })).json;
    const key = newKey();
    const r = await pay(GUEST_1, q.quote_id, 'reception', key);
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'waiting_reception');
    req = r.json.reception_request_id;
    assert.equal(h.sessions.holds.get(t).until.toISOString(), '2026-10-20T08:15:00.000Z');
    const ev = h.sse.items.find((e) => e.event === 'reception_request' && e.data.id === req);
    assert.equal(ev.channel, `club:${CLUB_A}`);
    assert.equal(ev.data.resource_number, 4);
    assert.equal(ev.data.amount_kopecks, 100000);
    assert.equal(ev.data.guest_masked_phone, '+7999***0001');
    assert.equal((await pay(GUEST_1, q.quote_id, 'reception', key)).json.reception_request_id, req, 'повтор с тем же ключом');
  });

  it('список заявок для ресепшена — с маской телефона; гостю и чужому клубу — нет', async () => {
    const r = await h.call(LIST, { user: RECEPTION_A, club: CLUB_A, params: { club: CLUB_A } });
    assert.equal(r.status, 200);
    const item = r.json.find((x) => x.id === req);
    assert.deepEqual(
      { n: item.resource_number, m: item.minutes, a: item.amount_kopecks, p: item.guest_masked_phone },
      { n: 4, m: 120, a: 100000, p: '+7999***0001' },
    );
    assert.equal((await h.call(LIST, { user: GUEST_1, club: CLUB_A, params: { club: CLUB_A } })).json.error, 'forbidden');
    assert.equal((await h.call(LIST, { user: RECEPTION_A, club: CLUB_B, params: { club: CLUB_B } })).json.error, 'forbidden');
  });

  it('гость видит статус своей заявки', async () => {
    const r = await h.call(GUEST_REQ, { user: GUEST_1, params: { id: req } });
    assert.equal(r.json.status, 'waiting');
    assert.equal(r.json.expires_at, '2026-10-20T08:15:00.000Z');
    assert.equal((await h.call(GUEST_REQ, { user: GUEST_2, params: { id: req } })).status, 404);
  });

  it('гость не может принять заявку; наличных меньше суммы — bad_request', async () => {
    assert.equal((await h.call(ACCEPT, { user: GUEST_1, params: { id: req }, body: { method: 'cash', received_kopecks: 100000 }, idempotencyKey: newKey() })).json.error, 'forbidden');
    assert.equal((await h.call(ACCEPT, { user: RECEPTION_A, params: { id: req }, body: { method: 'cash', received_kopecks: 99900 }, idempotencyKey: newKey() })).json.error, 'bad_request');
  });

  it('наличные со сдачей: платёж, задание на чек ККТ (receipt_pending), журнал, outbox', async () => {
    const key = newKey();
    const r = await h.call(ACCEPT, { user: RECEPTION_A, params: { id: req }, body: { method: 'cash', received_kopecks: 150000 }, idempotencyKey: key });
    assert.equal(r.status, 200);
    assert.equal(r.json.change_kopecks, 50000);
    assert.equal(r.json.session_id, null);
    const p = await payment(r.json.payment_id);
    assert.deepEqual(
      { m: p.method, s: p.status, a: Number(p.amount_kopecks), rcv: Number(p.received_kopecks), ch: Number(p.change_kopecks), by: p.accepted_by },
      { m: 'cash', s: 'succeeded', a: 100000, rcv: 150000, ch: 50000, by: RECEPTION_A },
    );
    const receipt = (await h.q('select * from bl.receipts where payment_id = $1', [p.id]))[0];
    assert.equal(receipt.channel, 'kkt');
    assert.equal(receipt.status, 'receipt_pending');
    assert.equal(receipt.items[0].description, 'Игра, стол 4, 2 ч');
    const audit = (await h.audit('reception.accept')).find((a) => a.object_id === req);
    assert.equal(audit.actor_id, RECEPTION_A);
    assert.deepEqual(audit.data, { request_id: req, payment_id: p.id, method: 'cash', amount_kopecks: 100000, received_kopecks: 150000, change_kopecks: 50000 });
    const ev = (await h.outbox('payment.confirmed')).filter((e) => e.payload.payment_id === p.id);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].payload.method, 'cash');
    // Повтор тем же ключом — тот же ответ; другой ключ — заявка уже принята.
    assert.deepEqual((await h.call(ACCEPT, { user: RECEPTION_A, params: { id: req }, body: { method: 'cash', received_kopecks: 150000 }, idempotencyKey: key })).json, r.json);
    assert.equal((await h.call(ACCEPT, { user: RECEPTION_A, params: { id: req }, body: { method: 'cash', received_kopecks: 150000 }, idempotencyKey: newKey() })).json.error, 'quote_used');
    assert.equal((await h.outbox('payment.confirmed')).filter((e) => e.payload.payment_id === p.id).length, 1);
    assert.equal((await h.call(GUEST_REQ, { user: GUEST_1, params: { id: req } })).json.status, 'accepted');
  });

  it('карта через терминал и отказ с причиной (pending снят, журнал reception.decline)', async () => {
    const t2 = 'e1000000-0000-4000-8000-000000000005';
    const t3 = 'e1000000-0000-4000-8000-000000000006';
    h.sessions.holds.delete(t2);
    h.sessions.holds.delete(t3);
    const q2 = (await quote(GUEST_2, { resource_id: t2, kind: 'start', minutes: 60 })).json;
    const r2 = (await pay(GUEST_2, q2.quote_id, 'reception')).json;
    const a = await h.call(ACCEPT, { user: OWNER_A, params: { id: r2.reception_request_id }, body: { method: 'card_terminal' }, idempotencyKey: newKey() });
    assert.equal(a.json.change_kopecks, 0);
    assert.equal((await payment(a.json.payment_id)).method, 'card_terminal');

    const q3 = (await quote(GUEST_2, { resource_id: t3, kind: 'start', minutes: 60 })).json;
    const r3 = (await pay(GUEST_2, q3.quote_id, 'reception')).json;
    assert.equal((await h.call(DECLINE, { user: RECEPTION_A, params: { id: r3.reception_request_id }, body: {} })).json.error, 'reason_required');
    for (const bad of ['guest_gone', 'GUEST_LEFT', 'cleaning', 42]) {
      assert.equal((await h.call(DECLINE, { user: RECEPTION_A, params: { id: r3.reception_request_id }, body: { reason_code: bad } })).json.error, 'bad_request', String(bad));
    }
    assert.equal((await h.call(GUEST_REQ, { user: GUEST_2, params: { id: r3.reception_request_id } })).json.reason_code, null, 'пока ждёт — без причины');
    const d = await h.call(DECLINE, { user: RECEPTION_A, params: { id: r3.reception_request_id }, body: { reason_code: 'guest_left' } });
    assert.deepEqual(d.json, { ok: true });
    assert.equal(h.sessions.holds.get(t3), undefined);
    const audit = (await h.audit('reception.decline')).find((x) => x.object_id === r3.reception_request_id);
    assert.deepEqual(audit.data, { request_id: r3.reception_request_id, method: null, amount_kopecks: 50000, reason_code: 'guest_left' });
    const st = (await h.call(GUEST_REQ, { user: GUEST_2, params: { id: r3.reception_request_id } })).json;
    assert.deepEqual({ s: st.status, r: st.reason_code }, { s: 'declined', r: 'guest_left' });
    assert.equal((await h.call(ACCEPT, { user: RECEPTION_A, params: { id: r3.reception_request_id }, body: { method: 'card_terminal' }, idempotencyKey: newKey() })).json.error, 'quote_expired');
  });

  it('заявка сгорает через 15 минут: планировщик снимает pending, SSE; принять уже нельзя', async () => {
    const t4 = 'e1000000-0000-4000-8000-000000000007';
    h.sessions.holds.delete(t4);
    h.sessions.sessions.clear();
    const q = (await quote(GUEST_2, { resource_id: t4, kind: 'start', minutes: 60 })).json;
    const r = (await pay(GUEST_2, q.quote_id, 'reception')).json;
    h.clock.advance(15 * 60_000);
    try {
      const deps = await resolveDeps(h.ctx);
      const res = await tick({ pool: h.pool, withContext: asAppApi, deps, config: h.config });
      assert.ok(res.done >= 1);
      const row = (await h.q('select status from bl.reception_requests where id = $1', [r.reception_request_id]))[0];
      assert.equal(row.status, 'expired');
      assert.equal(h.sessions.holds.get(t4), undefined);
      assert.ok(h.sse.items.some((e) => e.data.id === r.reception_request_id && e.data.status === 'expired'));
      assert.equal((await h.call(ACCEPT, { user: RECEPTION_A, params: { id: r.reception_request_id }, body: { method: 'card_terminal' }, idempotencyKey: newKey() })).json.error, 'quote_expired');
    } finally {
      h.clock.advance(-15 * 60_000);
    }
  });
});

describe('возвраты (refund для light)', () => {
  async function paidSbp(resourceId, user = GUEST_1) {
    h.sessions.holds.delete(resourceId);
    const q = (await quote(user, { resource_id: resourceId, kind: 'start', minutes: 60 })).json;
    const r = await pay(user, q.quote_id, 'sbp');
    await emuSucceed(r.json.payment_id);
    return payment(r.json.payment_id);
  }

  it('СБП: возврат с чеком, журнал с причиной, outbox payment.refunded, владельцу уведомление; повтор не возвращает дважды', async () => {
    const p = await paidSbp('e1000000-0000-4000-8000-000000000008');
    const deps = await resolveDeps(h.ctx);
    const args = { paymentId: p.id, amountKopecks: 20000, reason: 'Стол не включился: недоиграно 24 минуты' };
    const run = () =>
      withContext(h.pool, { clubId: CLUB_A, actorType: 'system' }, async (db) => {
        await db.query('set local role app_api');
        return refund(db, args, { deps, config: h.config });
      });
    const r = await run();
    assert.equal(r.status, 'succeeded');
    assert.equal(r.amount_kopecks, 20000);
    const again = await run();
    assert.equal(again.refund_id, r.refund_id);
    const emuP = await (await fetch(`${h.emuBase}/__emu/payments/${p.provider_payment_id}`)).json();
    assert.deepEqual(emuP.refunded_amount, { value: '200.00', currency: 'RUB' });
    const refundReceipt = emuP.receipts.find((x) => x.kind === 'refund');
    assert.equal(refundReceipt.receipt.items[0].amount.value, '200.00');
    const audit = (await h.audit('payment.refunded')).filter((a) => a.object_id === p.id);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].reason, args.reason);
    const ev = (await h.outbox('payment.refunded')).filter((e) => e.payload.payment_id === p.id);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].payload.amount_kopecks, 20000);
    assert.ok(h.notes.items.some((n) => n.kind === 'refund' && n.roles.includes('owner')));
    // Больше оплаченного — limit_exceeded.
    await assert.rejects(
      withContext(h.pool, { clubId: CLUB_A, actorType: 'system' }, (db) => refund(db, { paymentId: p.id, amountKopecks: 40000, reason: 'ещё' }, { deps, config: h.config })),
      (err) => err.code === 'limit_exceeded',
    );
    await assert.rejects(
      withContext(h.pool, { clubId: CLUB_A, actorType: 'system' }, (db) => refund(db, { paymentId: p.id, amountKopecks: 100, reason: ' ' }, { deps, config: h.config })),
      (err) => err.code === 'reason_required',
    );
  });

  it('наличные: возврат «manual» и задание на чек возврата ККТ', async () => {
    const cash = (await h.q("select * from bl.payments where method = 'cash' limit 1"))[0];
    const deps = await resolveDeps(h.ctx);
    const r = await withContext(h.pool, { clubId: CLUB_A, actorType: 'system' }, (db) =>
      refund(db, { paymentId: cash.id, amountKopecks: 30000, reason: 'Свет не включился' }, { deps, config: h.config }),
    );
    assert.equal(r.status, 'manual');
    const rec = (await h.q("select * from bl.receipts where refund_id = $1", [r.refund_id]))[0];
    assert.deepEqual({ k: rec.kind, c: rec.channel, s: rec.status }, { k: 'refund', c: 'kkt', s: 'receipt_pending' });
    assert.ok(h.notes.items.some((n) => n.kind === 'refund' && n.roles.includes('reception')));
  });
});

describe('статус чеков (receiptStatus для light, §14)', () => {
  it('по каждому платежу — действующий чек продажи; чужой клуб и неизвестный — none', async () => {
    const pick = async (sql) => (await h.q(sql))[0]?.id;
    const sbp = await pick("select p.id from bl.payments p where p.method = 'sbp' and p.status = 'succeeded' and p.capture and p.unlimited = false order by p.created_at limit 1");
    const cash = await pick("select id from bl.payments where method = 'cash' limit 1");
    const captured = await pick("select id from bl.payments where capture = false and status = 'succeeded' and captured_kopecks = 40000 limit 1");
    const pending = await pick("select id from bl.payments where provider = 'yookassa' and status = 'pending' order by created_at limit 1");
    const canceled = await pick("select id from bl.payments where status = 'canceled' and cancellation_reason = 'general_decline' limit 1");
    for (const id of [sbp, cash, captured, pending, canceled]) assert.ok(id);
    const foreign = 'c9999999-0000-4000-8000-000000000001';
    const res = await h.tx({ clubId: CLUB_A, actorType: 'system' }, (db) =>
      receiptStatus(db, { paymentIds: [sbp, cash, captured, pending, canceled, foreign, 'not-a-uuid', sbp] }),
    );
    assert.deepEqual(res, {
      [sbp]: 'succeeded',
      [cash]: 'receipt_pending',
      [captured]: 'succeeded',
      [pending]: 'pending',
      [canceled]: 'canceled',
      [foreign]: 'none',
    });
    // В контексте клуба Б платежи клуба А не видны.
    const other = await h.tx({ clubId: CLUB_B, actorType: 'system' }, (db) => receiptStatus(db, { paymentIds: [sbp, cash] }));
    assert.deepEqual(other, { [sbp]: 'none', [cash]: 'none' });
    assert.deepEqual(await h.tx({ clubId: CLUB_A }, (db) => receiptStatus(db, { paymentIds: [] })), {});
    await assert.rejects(h.tx({ clubId: CLUB_A }, (db) => receiptStatus(db, { paymentIds: 'x' })), (e) => e.code === 'bad_request');
  });
});

describe('сверка зависших платежей', () => {
  it('вебхук потерялся: через минуту планировщик сверяет платёж по API и подтверждает', async () => {
    const t = 'e1000000-0000-4000-8000-000000000003';
    h.sessions.holds.delete(t);
    const q = (await quote(GUEST_2, { resource_id: t, kind: 'start', minutes: 60 })).json;
    const r = await pay(GUEST_2, q.quote_id, 'sbp');
    const p = await payment(r.json.payment_id);
    // Вебхук уходит в никуда.
    const savedShopHook = h.emu.config.webhookUrl;
    await fetch(`${h.emuBase}/__emu/config`, { method: 'POST', body: JSON.stringify({ webhook_url: 'http://127.0.0.1:9/' }) });
    try {
      await fetch(`${h.emuBase}/__emu/payments/${p.provider_payment_id}/succeed?wait=1`, { method: 'POST' });
      assert.equal((await payment(p.id)).status, 'pending');
      h.clock.advance(2 * 60_000);
      const deps = await resolveDeps(h.ctx);
      const res = await tick({ pool: h.pool, withContext: asAppApi, deps, config: h.config });
      assert.ok(res.due >= 1);
      assert.equal((await payment(p.id)).status, 'succeeded');
      assert.equal((await h.outbox('payment.confirmed')).filter((e) => e.payload.payment_id === p.id).length, 1);
    } finally {
      h.clock.advance(-2 * 60_000);
      h.emu.config.webhookUrl = savedShopHook;
    }
  });

  it('гость опрашивает платёж: давно в pending — сверка по API', async () => {
    const t = 'e1000000-0000-4000-8000-000000000006';
    h.sessions.holds.delete(t);
    h.sessions.sessions.clear();
    const q = (await quote(GUEST_1, { resource_id: t, kind: 'start', minutes: 60 })).json;
    const r = await pay(GUEST_1, q.quote_id, 'card');
    const p = await payment(r.json.payment_id);
    h.emu.state.payments.get(p.provider_payment_id).status = 'succeeded';
    h.emu.state.payments.get(p.provider_payment_id).paid = true;
    assert.equal((await h.call(PAYMENT, { user: GUEST_1, params: { id: p.id } })).json.status, 'pending', 'сразу — без сверки');
    h.clock.advance(15_000);
    try {
      const after = await h.call(PAYMENT, { user: GUEST_1, params: { id: p.id } });
      assert.equal(after.json.status, 'succeeded');
    } finally {
      h.clock.advance(-15_000);
    }
  });
});
