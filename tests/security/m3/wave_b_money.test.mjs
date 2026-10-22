// Волна B M3 (деньги): return_url (открытый редирект через страницу оплаты ЮKassa),
// отмена платежей, которых нет в ЮKassa (404 → отмена), статус чужого платежа,
// GET /api/clubs/{club}/package-lots?phone= и bl.money_lot_guest (перечисление гостей, чужой клуб,
// лимит, маска телефона). Настоящий Postgres и эмулятор ЮKassa (supabase/tests/money_harness.mjs).
//
// Запуск: DATABASE_ADMIN_URL=postgres://supabase_admin:...@127.0.0.1:55460/postgres \
//   node --test tests/security/m3/wave_b_money.test.mjs

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { routes as quoteRoutes } from '../../../api/routes/quotes.mjs';
import { routes as packageRoutes } from '../../../api/routes/packages.mjs';
import { routes as paymentRoutes } from '../../../api/routes/payments.mjs';
import { routes as webhookRoutes } from '../../../api/routes/webhooks.mjs';
import { createPrepayment } from '../../../server/payments/api.mjs';
import { resolveDeps } from '../../../server/payments/deps.mjs';
import { tick } from '../../../server/payments/index.mjs';
import { NOT_FOUND_REASON, ownReturnUrl } from '../../../server/payments/pay.mjs';
import { withContext } from '../../../server/lib/store.mjs';
import { CLUB_A, CLUB_B, GUEST_1, GUEST_2, OWNER_A, OWNER_B, RECEPTION_A, setupMoney } from '../../../supabase/tests/money_harness.mjs';

const skip = !process.env.DATABASE_ADMIN_URL;
const route = (list, method, path) => list.find((r) => r.method === method && r.path === path);
const QUOTE = route(quoteRoutes, 'POST', '/api/quotes');
const PAY = route(quoteRoutes, 'POST', '/api/quotes/{id}/pay');
const BUY_PKG = route(packageRoutes, 'POST', '/api/packages/{id}/buy');
const LOTS = route(packageRoutes, 'GET', '/api/clubs/{club}/package-lots');
const PAY_STATUS = route(paymentRoutes, 'GET', '/api/payments/{id}');
const WEBHOOK = route(webhookRoutes, 'POST', '/api/webhooks/yookassa/{club_id}');
const MANAGER_A = 'a1000000-0000-4000-8000-000000000003';
const START = '2026-10-20T08:00:00.000Z';
const T = (n) => `e1000000-0000-4000-8000-00000000000${n}`;

const asAppApi = (pool, c, fn) =>
  withContext(pool, c, async (db) => {
    await db.query('set local role app_api');
    return fn(db);
  });

// Векторы открытого редиректа сверх тех, что проверяет backend (supabase/tests/money_m3.test.mjs).
const EVIL = [
  'https://billiardum.test.evil.example/app',
  'https://billiardum.test:443@evil.example/app',
  'https://billiardum.test%2F@evil.example/app',
  'HTTPS://evil.example/app',
  'https:/evil.example/app',
  'https:evil.example/app',
  ' https://billiardum.test/app',
  '/app\t/x',
  '/app\n',
  '/app x',
  '\\\\evil.example',
  '/\\evil.example',
  '/./../evil',
  'http://billiardum.test/app', // не тот протокол
  'https://billiardum.test', // без пути
  `/${'a'.repeat(400)}`,
  { toString: () => '/app' },
  ['/app'],
];

describe('волна B: деньги', { skip }, () => {
  let h;
  let deps;
  const payment = async (id) => (await h.q('select * from bl.payments where id = $1', [id]))[0];

  before(async () => {
    h = await setupMoney({ start: START });
    h.setWebhookRoute(WEBHOOK);
    h.ctx.bookingsApi = { async nextBookingStart() { return null; }, async nextBooking() { return null; } };
    deps = await resolveDeps(h.ctx);
  });
  after(async () => {
    await h?.close();
  });

  it('ownReturnUrl: любой обход даёт bad_request, а принятый адрес всегда на нашем хосте', () => {
    for (const v of EVIL) {
      let out;
      try {
        out = ownReturnUrl(h.config, v);
      } catch (e) {
        assert.equal(e.code, 'bad_request', JSON.stringify(String(v)));
        continue;
      }
      // Если что-то прошло — это должен быть наш хост (иначе открытый редирект).
      assert.equal(new URL(out).origin, 'https://billiardum.test', `прошло ${JSON.stringify(String(v))} → ${out}`);
    }
    // Закодированные обходы — остаются путём на нашем хосте.
    for (const v of ['/%2F%2Fevil.example', '/%5Cevil.example', '/@evil.example', '/app?next=https://evil.example']) {
      assert.equal(new URL(ownReturnUrl(h.config, v)).host, 'billiardum.test', v);
    }
  });

  it('POST /api/packages/{id}/buy и createPrepayment отвергают чужие return_url (в ЮKassa уходит только наш хост)', async () => {
    const pkg = (await h.q(`insert into bl.tariff_packages (club_id,title,minutes,price_kopecks,valid_days) values ($1,'Пентест',600,300000,30) returning id`, [CLUB_A]))[0].id;
    for (const bad of EVIL.slice(0, 15)) {
      const r = await h.call(BUY_PKG, { user: GUEST_2, params: { id: pkg }, body: { method: 'sbp', return_url: bad }, idempotencyKey: randomUUID() });
      assert.deepEqual([r.status, r.json], [400, { error: 'bad_request' }], JSON.stringify(bad));
      await assert.rejects(
        h.tx({ clubId: CLUB_A, userId: GUEST_1 }, (db) => createPrepayment(db, { clubId: CLUB_A, bookingId: randomUUID(), resourceId: T(3), userId: GUEST_1, amountKopecks: 10000, returnUrl: bad }, { deps, config: h.config })),
        (e) => e.code === 'bad_request',
        JSON.stringify(bad),
      );
    }
    // Ни у одного платежа эмулятора нет return_url на чужом хосте.
    const rows = await h.q("select provider_payment_id from bl.payments where provider = 'yookassa'");
    for (const r of rows) {
      const p = await (await fetch(`${h.emuBase}/__emu/payments/${r.provider_payment_id}`)).json();
      const u = p.confirmation?.return_url;
      if (u) assert.equal(new URL(u).host, 'billiardum.test', u);
    }
  });

  it('GET /api/payments/{id}: чужой гость получает 404 и не запускает сверку (нельзя «уронить» чужой платёж в 404-отмену)', async () => {
    h.sessions.holds.delete(T(4));
    const q = await h.call(QUOTE, { user: GUEST_1, body: { resource_id: T(4), kind: 'start', minutes: 60 } });
    assert.equal(q.status, 200, JSON.stringify(q.json));
    const r = await h.call(PAY, { user: GUEST_1, params: { id: q.json.quote_id }, body: { method: 'sbp' }, idempotencyKey: randomUUID() });
    const before = await payment(r.json.payment_id);
    h.clock.advance(5 * 60_000);
    try {
      const other = await h.call(PAY_STATUS, { user: GUEST_2, params: { id: r.json.payment_id } });
      assert.deepEqual([other.status, other.json], [404, { error: 'not_found' }]);
      const p = await payment(r.json.payment_id);
      assert.equal(String(p.checked_at), String(before.checked_at), 'сверка по чужому запросу не запускалась');
      assert.equal(p.status, 'pending');
    } finally {
      h.clock.advance(-5 * 60_000);
    }
  });

  it('404 у ЮKassa не отменяет оплаченный платёж (succeeded не трогается)', async () => {
    h.sessions.holds.delete(T(6));
    const q = await h.call(QUOTE, { user: GUEST_2, body: { resource_id: T(6), kind: 'start', minutes: 60 } });
    const r = await h.call(PAY, { user: GUEST_2, params: { id: q.json.quote_id }, body: { method: 'sbp' }, idempotencyKey: randomUUID() });
    const p0 = await payment(r.json.payment_id);
    await fetch(`${h.emuBase}/__emu/payments/${p0.provider_payment_id}/succeed?wait=1`, { method: 'POST' });
    await h.emu.settle();
    assert.equal((await payment(p0.id)).status, 'succeeded');
    await h.pool.query('update bl.payments set provider_payment_id = $2 where id = $1', [p0.id, `lost-${randomUUID().slice(0, 20)}`]);
    const out = await h.tx({ clubId: CLUB_A, actorType: 'system' }, async (db) => {
      const { syncPayment } = await import('../../../server/payments/pay.mjs');
      return syncPayment(db, deps, h.config, await payment(p0.id), { source: 'pentest' });
    });
    assert.equal(out.result, 'already');
    assert.equal((await payment(p0.id)).status, 'succeeded', 'оплаченный платёж не отменён');
  });

  /** Платёж старта, отменённый у нас по 404 (not_found_at_provider); возвращает { id, providerId }. */
  async function canceledBy404(t, user = GUEST_2) {
    h.sessions.holds.delete(t);
    const q = await h.call(QUOTE, { user, body: { resource_id: t, kind: 'start', minutes: 60 } });
    assert.equal(q.status, 200, JSON.stringify(q.json));
    const r = await h.call(PAY, { user, params: { id: q.json.quote_id }, body: { method: 'sbp' }, idempotencyKey: randomUUID() });
    const id = r.json.payment_id;
    const providerId = (await payment(id)).provider_payment_id;
    await h.pool.query('update bl.payments set provider_payment_id = $2 where id = $1', [id, `lost-${randomUUID().slice(0, 20)}`]);
    const runTick = () => tick({ pool: h.pool, withContext: asAppApi, deps, config: h.config });
    h.clock.advance(5 * 60_000);
    await runTick();
    h.clock.advance(61 * 60_000);
    await runTick();
    await runTick();
    h.clock.advance(-66 * 60_000);
    const p = await payment(id);
    assert.deepEqual([p.status, p.cancellation_reason], ['canceled', NOT_FOUND_REASON]);
    await h.pool.query('update bl.payments set provider_payment_id = $2 where id = $1', [id, providerId]);
    return { id, providerId };
  }
  const lateAlarms = (id) => h.alarms.items.filter((x) => x.type === 'payment_paid_after_cancel' && x.data.payment_id === id);
  const refundsOf = (id) => h.q("select * from bl.refunds where payment_id = $1 and status <> 'canceled'", [id]);
  const webhook = (providerId) =>
    h.call(WEBHOOK, { params: { club_id: CLUB_A }, body: { event: 'payment.succeeded', object: { id: providerId } }, actor: 'system' });

  it('B-L1 исправлено: отменён по 404, затем оплачен — один полный возврат с чеком, одна тревога, статус canceled, игры нет, payment.confirmed не шлётся', async () => {
    const { id, providerId } = await canceledBy404(T(7));
    const confirmedBefore = (await h.outbox('payment.confirmed')).filter((e) => e.payload.payment_id === id).length;
    const res = await fetch(`${h.emuBase}/__emu/payments/${providerId}/succeed?wait=1`, { method: 'POST' });
    assert.equal(res.status, 200);
    await h.emu.settle();
    const p = await payment(id);
    assert.equal(p.status, 'canceled');
    assert.equal(p.session_id, null, 'игра не началась');
    assert.ok(p.late_paid_at, 'отмечено late_paid_at');
    const refunds = await refundsOf(id);
    assert.equal(refunds.length, 1, 'один возврат');
    assert.equal(Number(refunds[0].amount_kopecks), Number(p.amount_kopecks), 'возврат на всю сумму');
    const receipts = await h.q("select * from bl.receipts where refund_id = $1 and kind = 'refund'", [refunds[0].id]);
    assert.equal(receipts.length, 1, 'чек возврата (54-ФЗ)');
    assert.equal(lateAlarms(id).length, 1, 'одна критичная тревога');
    assert.equal(lateAlarms(id)[0].level, 'critical');
    assert.equal((await h.outbox('payment.confirmed')).filter((e) => e.payload.payment_id === id).length, confirmedBefore, 'payment.confirmed не отправлен');
  });

  it('обход 1: повтор вебхука (5 раз) и сверка — по-прежнему один возврат и одна тревога', async () => {
    const { id, providerId } = await canceledBy404(T(8));
    await fetch(`${h.emuBase}/__emu/payments/${providerId}/succeed?wait=1`, { method: 'POST' });
    await h.emu.settle();
    for (let i = 0; i < 5; i += 1) assert.equal((await webhook(providerId)).status, 200);
    await tick({ pool: h.pool, withContext: asAppApi, deps, config: h.config });
    assert.equal((await refundsOf(id)).length, 1);
    assert.equal(lateAlarms(id).length, 1);
    // ЮKassa (эмулятор) тоже видит ровно один возврат: ключ идемпотентности late-<id>.
    const remote = await (await fetch(`${h.emuBase}/__emu/payments/${providerId}`)).json();
    assert.ok(!remote.refunded_amount || Number(remote.refunded_amount.value) * 100 === Number((await payment(id)).amount_kopecks), JSON.stringify(remote.refunded_amount));
  });

  it('обход 2: параллельные вебхуки — один возврат', async () => {
    const { id, providerId } = await canceledBy404(T(5));
    await fetch(`${h.emuBase}/__emu/payments/${providerId}/succeed?wait=1`, { method: 'POST' });
    await h.emu.settle();
    await Promise.all(Array.from({ length: 6 }, () => webhook(providerId).catch((e) => e)));
    assert.equal((await refundsOf(id)).length, 1);
    assert.equal(lateAlarms(id).length, 1);
  });

  it('обход 3: другая сумма у ЮKassa — не возврат «по телу», а payment_mismatch (критичная тревога), деньги не уходят', async () => {
    const { id, providerId } = await canceledBy404(T(6));
    const p = await payment(id);
    const remote = { id: providerId, status: 'succeeded', amount: { value: '1.00', currency: 'RUB' }, metadata: { club_id: CLUB_A, quote_id: p.quote_id } };
    const { applyRemote } = await import('../../../server/payments/pay.mjs');
    const out = await h.tx({ clubId: CLUB_A, actorType: 'system' }, (db) => applyRemote(db, deps, p, remote, { source: 'pentest', client: {} }));
    assert.equal(out.result, 'mismatch');
    assert.equal((await refundsOf(id)).length, 0);
    assert.ok(h.alarms.items.some((x) => x.type === 'payment_mismatch' && x.data.payment_id === id));
  });

  it('B-R1 исправлено: гонка вебхука со сверкой — устаревшая строка pending всё равно уходит в автовозврат и тревогу', async () => {
    // Вебхук теперь берёт строку FOR UPDATE, а applyRemote после неудачного confirmPayment перечитывает
    // строку: устаревший payment.status 'pending' при canceled в базе ведёт в тот же автовозврат.
    const { id, providerId } = await canceledBy404(T(3));
    const fresh = await payment(id);
    const stale = { ...fresh, status: 'pending', canceled_at: null, cancellation_reason: null, checked_at: null };
    const remote = {
      id: providerId, status: 'succeeded', amount: { value: (Number(fresh.amount_kopecks) / 100).toFixed(2), currency: 'RUB' },
      metadata: { club_id: CLUB_A, quote_id: fresh.quote_id }, receipt_registration: 'succeeded',
    };
    const calls = [];
    const client = { createRefund: async (body, key) => (calls.push({ key, value: body.amount.value }), { id: `rf-${randomUUID().slice(0, 8)}`, status: 'succeeded', receipt_registration: 'succeeded' }) };
    const { applyRemote } = await import('../../../server/payments/pay.mjs');
    const raced = await h.tx({ clubId: CLUB_A, actorType: 'system' }, (db) => applyRemote(db, deps, stale, remote, { source: 'race', client }));
    assert.equal(raced.result, 'late_refund', 'устаревшая строка — автовозврат');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].key, `late-${id}`);
    assert.equal(lateAlarms(id).length, 1, 'одна тревога');
    // Повтор той же гонки (вторая устаревшая копия) — без второго возврата и тревоги.
    const again = await h.tx({ clubId: CLUB_A, actorType: 'system' }, (db) => applyRemote(db, deps, stale, remote, { source: 'race2', client }));
    assert.ok(['late_refund', 'already'].includes(again.result));
    assert.equal(calls.length, 1, 'возврат в ЮKassa не повторён');
    assert.equal((await refundsOf(id)).length, 1);
    assert.equal(lateAlarms(id).length, 1);
    assert.equal((await payment(id)).status, 'canceled');
  });

  it('B-R1: вебхук блокирует строку платежа (FOR UPDATE) — параллельная транзакция ждёт', async () => {
    const { id, providerId } = await canceledBy404(T(2));
    const locker = await h.pool.connect();
    try {
      await locker.query('begin');
      await locker.query('select 1 from bl.payments where id = $1 for update', [id]);
      let done = false;
      const wh = webhook(providerId).then((r) => ((done = true), r));
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(done, false, 'вебхук ждёт блокировку строки платежа');
      await locker.query('rollback');
      assert.equal((await wh).status, 200);
    } finally {
      locker.release();
    }
  });

  describe('GET /api/clubs/{club}/package-lots?phone= и bl.money_lot_guest', () => {
    const GUEST_1_PHONE = '+79990000001';
    const GUEST_2_PHONE = '+79990000002';
    const call = (user, { phone, roles = null, club = CLUB_A, trusted = true }) =>
      h.call(LOTS, { user, club: trusted ? club : null, roles: trusted ? roles : null, params: { club }, query: { phone } });

    before(async () => {
      // Партия GUEST_1 в клубе A, партия GUEST_2 только в клубе B.
      for (const [club, user] of [[CLUB_A, GUEST_1], [CLUB_B, GUEST_2]]) {
        const pkg = (await h.q(`insert into bl.tariff_packages (club_id,title,minutes,price_kopecks,valid_days) values ($1,'Лоты',600,500000,30) returning id`, [club]))[0].id;
        const pay = (await h.q(
          `insert into bl.payments (club_id,resource_id,user_id,kind,provider,method,idempotence_key,status,amount_kopecks,capture,package_id,provider_payment_id,confirmed_at,captured_at,created_at,updated_at)
           values ($1,null,$2,'package','yookassa','sbp',$3,'succeeded',500000,true,$4,$5,now(),now(),now(),now()) returning id`,
          [club, user, `pk-${randomUUID()}`, pkg, `yk-${randomUUID()}`],
        ))[0].id;
        await h.q(
          `insert into bl.balance_lots (club_id,user_id,package_id,payment_id,minutes_total,minutes_left,price_kopecks,expires_at,source_key,created_at)
           values ($1,$2,$3,$4,600,600,500000, now()+interval '30 days',$5,now())`,
          [club, user, pkg, pay, `${pay}:${pkg}:0`],
        );
      }
    });

    it('управляющий своего клуба находит партии гостя по точному телефону; телефон — только маской', async () => {
      const r = await call(MANAGER_A, { phone: GUEST_1_PHONE, roles: ['manager'] });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.length, 1);
      assert.ok(!JSON.stringify(r.json).includes(GUEST_1_PHONE), 'полного телефона нет в ответе');
      assert.ok(!JSON.stringify(r.json).includes('79990000001'));
      const log = h.logs.filter((l) => l.msg === 'package_lots_lookup').at(-1);
      assert.ok(log && !JSON.stringify(log).includes('79990000001'), 'в логе — маска');
    });

    it('гость с партиями только в чужом клубе не находится (нет межклубного оракула)', async () => {
      const r = await call(MANAGER_A, { phone: GUEST_2_PHONE, roles: ['manager'] });
      assert.deepEqual([r.status, r.json], [200, []]);
      // Прямой вызов функции: пусто для чужого клуба и для гостя без партий.
      const rows = await h.tx({ clubId: CLUB_A, userId: MANAGER_A }, async (db) => (await db.query('select * from bl.money_lot_guest($1)', [GUEST_2_PHONE])).rows);
      assert.deepEqual(rows, []);
    });

    it('частичный телефон, маска или мусор — bad_request (без перечисления по префиксу)', async () => {
      for (const phone of ['+7999', '+7999000000%', '7999', "+7999' or 1=1--", '+79990000001,+79990000002', '', undefined, '+7 (999) 000-00-0%']) {
        const r = await call(OWNER_A, { phone, roles: ['owner'] });
        assert.deepEqual([r.status, r.json], [400, { error: 'bad_request' }], String(phone));
      }
    });

    it('ресепшн — 403; владелец другого клуба по пути клуба A — 403; функция не-управляющему пуста', async () => {
      const rec = await call(RECEPTION_A, { phone: GUEST_1_PHONE, roles: ['reception'] });
      assert.equal(rec.status, 403);
      const foreign = await call(OWNER_B, { phone: GUEST_1_PHONE, trusted: false });
      assert.equal(foreign.status, 403);
      for (const userId of [RECEPTION_A, OWNER_B, GUEST_1]) {
        const rows = await h.tx({ clubId: CLUB_A, userId }, async (db) => (await db.query('select * from bl.money_lot_guest($1)', [GUEST_1_PHONE])).rows);
        assert.deepEqual(rows, [], userId);
      }
    });

    it('лимит 30 поисков в минуту на сотрудника (перебор телефонов упирается в rate_limited)', async () => {
      let limited = 0;
      for (let i = 0; i < 40; i += 1) {
        const r = await call(OWNER_A, { phone: `+7999111${String(i).padStart(4, '0')}`, roles: ['owner'] });
        if (r.status === 429) limited += 1;
      }
      assert.ok(limited >= 10, `ограничено ${limited} из 40`);
    });
  });
});
