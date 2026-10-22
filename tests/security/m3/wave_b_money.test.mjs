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
      let out = null;
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

  it('НАХОДКА (низкая): pending отменён по 404 (not_found_at_provider), затем гость всё-таки оплатил — деньги списаны, игры нет, ни возврата, ни тревоги', async () => {
    const t = T(7);
    h.sessions.holds.delete(t);
    const q = await h.call(QUOTE, { user: GUEST_2, body: { resource_id: t, kind: 'start', minutes: 60 } });
    assert.equal(q.status, 200, JSON.stringify(q.json));
    const r = await h.call(PAY, { user: GUEST_2, params: { id: q.json.quote_id }, body: { method: 'sbp' }, idempotencyKey: randomUUID() });
    const id = r.json.payment_id;
    const realProviderId = (await payment(id)).provider_payment_id;
    // ЮKassa временно не знает платёж (смена ключей магазина, сбой) — больше часа.
    await h.pool.query('update bl.payments set provider_payment_id = $2 where id = $1', [id, `lost-${randomUUID().slice(0, 20)}`]);
    let shift = 0;
    try {
      const runTick = () => tick({ pool: h.pool, withContext: asAppApi, deps, config: h.config });
      h.clock.advance(5 * 60_000);
      shift += 5 * 60_000;
      await runTick();
      h.clock.advance(61 * 60_000);
      shift += 61 * 60_000;
      await runTick();
      await runTick();
      const canceled = await payment(id);
      assert.deepEqual([canceled.status, canceled.cancellation_reason], ['canceled', NOT_FOUND_REASON]);
      const alarmsBefore = h.alarms.items.length;

      // Платёж снова виден в ЮKassa, и гость его оплачивает (СБП в своём банке).
      await h.pool.query('update bl.payments set provider_payment_id = $2 where id = $1', [id, realProviderId]);
      const res = await fetch(`${h.emuBase}/__emu/payments/${realProviderId}/succeed?wait=1`, { method: 'POST' });
      assert.equal(res.status, 200);
      await h.emu.settle();
      const remote = await (await fetch(`${h.emuBase}/__emu/payments/${realProviderId}`)).json();
      assert.equal(remote.status, 'succeeded', 'в ЮKassa деньги списаны');

      const p = await payment(id);
      const refunds = await h.q("select * from bl.refunds where payment_id = $1 and status <> 'canceled'", [id]);
      const newAlarms = h.alarms.items.slice(alarmsBefore);
      // Фиксируем текущее поведение: локально canceled, без возврата и без тревоги.
      assert.equal(p.status, 'canceled', 'у нас платёж остался отменённым');
      assert.equal(p.session_id, null, 'игра не началась');
      assert.equal(refunds.length, 0, 'возврата нет');
      assert.equal(newAlarms.length, 0, 'тревоги нет — деньги гостя «зависли» молча');
    } finally {
      h.clock.advance(-shift);
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
