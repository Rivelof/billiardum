// T32 «Безопасность денег платформы» (docs/contracts/m5-3.md §4; №183, №188) — только API.
// Клуб сценария и платежи — из 01 (E2E_M53_DIR/state.json).
//   * подделанный вебхук платформы (чужой id, подмена статуса отклонённого списания, мусор) — счёт не
//     оплачивается: сервер перепроверяет платёж в магазине платформы;
//   * двойной (тройной) вебхук успешного списания — один счёт оплачен один раз, paid_until не растёт;
//   * платёж гостя на адрес платформы и платёж платформы на адрес клуба — без действий; деньги гостей
//     только в магазине клуба, платформы — только в 800010;
//   * клуб не меняет себе цену, paid_until, статус счёта (ни API, ни базой app_api);
//   * чужой клуб, ресепшн — не видят подписку; оператор — только чтение;
//   * секрет магазина платформы нигде не выводится: ответы API, журнал, уведомления, лог сервера.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  appClient,
  BASE,
  billingAt,
  capi,
  CLUB_A,
  DAY,
  emu,
  loadState,
  loginWait,
  PLATFORM_SHOP,
  platformSecret,
  SHOPS,
  short,
  sleep,
} from './helpers.mjs';

const st = loadState();
const skip = !st.club || !st.inv1 ? 'нет клуба и счетов из 01 (E2E_M53_DIR)' : false;
const S = {};
let db;

before(async () => {
  if (skip) return;
  db = await adminClient();
  S.owner = await loginWait(st.ownerPhone);
  S.rec = await loginWait('+70000000004');
  S.andrey = await loginWait('+70000000009');
  S.operator = await loginWait('+70000000010');
  S.secret = platformSecret();
});
after(async () => db?.end());

const C = () => st.club;
const inv = async (id) => (await db.query('select * from bl.billing_invoices where id = $1', [id])).rows[0];
const subRow = async () => (await db.query('select * from bl.club_subscriptions where club_id = $1', [C()])).rows[0];
const hook = (body, path = '/api/webhooks/yookassa-platform') => api('POST', path, { body, timeoutMs: 20_000 });

test('T32-1: подделанный вебхук платформы не оплачивает счёт (перепроверка в магазине платформы)', { skip, timeout: 3 * 60_000 }, async (t) => {
  // Открытый счёт: автоплатёж выключен в 01 — следующий период ждёт карту.
  const sub = await subRow();
  const at = new Date(new Date(sub.paid_until).getTime() + 2 * 60_000);
  billingAt('process', C(), at);
  const open = (await db.query("select * from bl.billing_invoices where club_id = $1 and status = 'open' order by period_start desc limit 1", [C()])).rows[0];
  assert.ok(open, 'открытый счёт для проверки');
  S.open = open.id;
  const since = new Date();
  const forged = {
    type: 'notification',
    event: 'payment.succeeded',
    object: {
      id: '2f7e0000-000f-5000-9000-00000000e2e1',
      status: 'succeeded',
      paid: true,
      amount: { value: (Number(open.amount_kopecks) / 100).toFixed(2), currency: 'RUB' },
      metadata: { kind: 'subscription', club_id: C(), invoice_id: open.id, billing_payment_id: '00000000-0000-4000-8000-0000000000e2', purpose: 'invoice' },
    },
  };
  const r1 = await hook(forged);
  const r2 = await hook({ object: { id: "x'; drop table bl.billing_invoices; --", status: 'succeeded' } });
  const r3 = await api('POST', '/api/webhooks/yookassa-platform', { body: 'not json', headers: { 'content-type': 'application/json' } }).catch((e) => ({ status: e.message }));
  // Подмена статуса настоящего отклонённого списания (эмулятор шлёт вебхук с override).
  const canceled = (await db.query("select provider_payment_id from bl.billing_payments where club_id = $1 and status = 'canceled' and provider_payment_id is not null limit 1", [C()])).rows[0];
  let r4 = null;
  if (canceled) r4 = emu(`/__emu/payments/${canceled.provider_payment_id}/webhook?repeat=1&event=payment.succeeded`, { post: true, body: { override: { status: 'succeeded', paid: true } } });
  await sleep(3000);
  const after1 = await inv(open.id);
  assert.equal(after1.status, 'open', 'счёт не оплачен подделкой');
  const paidAudit = (await db.query("select count(*)::int as n from bl.audit_log where action = 'billing.invoice_paid' and created_at >= $1 and data->>'club_id' = $2", [since, C()])).rows[0].n;
  assert.equal(paidAudit, 0, 'нет billing.invoice_paid');
  assert.equal(new Date((await subRow()).paid_until).toISOString(), new Date(sub.paid_until).toISOString(), 'paid_until не изменился');
  assert.ok([200, 400, 404].includes(r1.status), `подделка: ${r1.status}`);
  t.diagnostic(`подделка (чужой id) → ${r1.status} ${r1.text.slice(0, 80)}; кривой id → ${r2.status}; не JSON → ${r3.status}; подмена статуса отклонённого списания: ${r4 ? JSON.stringify(r4).slice(0, 120) : 'нет'}; счёт ${open.id.slice(0, 8)} — ${after1.status}`);
});

test('T32-2: тройной вебхук успешного списания — счёт оплачен один раз, paid_until не растёт', { skip, timeout: 2 * 60_000 }, async (t) => {
  const pay = (await db.query("select provider_payment_id from bl.billing_payments where invoice_id = $1 and status = 'succeeded'", [st.inv1])).rows[0];
  assert.ok(pay);
  const before = await subRow();
  const auditBefore = (await db.query("select count(*)::int as n from bl.audit_log where action = 'billing.invoice_paid' and object_id = $1", [st.inv1])).rows[0].n;
  const r = emu(`/__emu/payments/${pay.provider_payment_id}/webhook?repeat=3`, { post: true });
  await sleep(4000);
  const after = await subRow();
  const auditAfter = (await db.query("select count(*)::int as n from bl.audit_log where action = 'billing.invoice_paid' and object_id = $1", [st.inv1])).rows[0].n;
  const settle = (await db.query("select count(*)::int as n from bl.audit_log where action = 'billing.double_payment' and data->>'invoice_id' = $1", [st.inv1])).rows[0].n;
  assert.equal(new Date(after.paid_until).toISOString(), new Date(before.paid_until).toISOString(), 'paid_until тот же');
  assert.equal(auditAfter, auditBefore, 'billing.invoice_paid не повторился');
  assert.equal(settle, 0, 'повтор вебхука — не «двойная оплата»');
  assert.equal((await inv(st.inv1)).status, 'paid');
  const n = (await db.query("select count(*)::int as n from bl.billing_payments where invoice_id = $1 and status = 'succeeded'", [st.inv1])).rows[0].n;
  assert.equal(n, 1, 'одно списание');
  t.diagnostic(`вебхук ×3: ${JSON.stringify(r).slice(0, 120)}; billing.invoice_paid ${auditBefore} → ${auditAfter}; списаний succeeded ${n}; paid_until ${new Date(after.paid_until).toISOString()}`);
});

test('T32-3: платёж гостя на адрес платформы и платёж платформы на адрес клуба — без действий; магазины не смешиваются', { skip, timeout: 2 * 60_000 }, async (t) => {
  const guestPid = st.guestPid;
  const platPid = (await db.query("select provider_payment_id from bl.billing_payments where invoice_id = $1 and status = 'succeeded'", [st.inv1])).rows[0].provider_payment_id;
  const bpBefore = (await db.query('select count(*)::int as n from bl.billing_payments where club_id = $1', [C()])).rows[0].n;
  const pBefore = (await db.query('select count(*)::int as n from bl.payments where club_id = $1', [C()])).rows[0].n;
  const a = guestPid ? emu(`/__emu/payments/${guestPid}/webhook?repeat=1`, { post: true, body: { url: 'http://server:3000/api/webhooks/yookassa-platform' } }) : null;
  const b = emu(`/__emu/payments/${platPid}/webhook?repeat=1`, { post: true, body: { url: `http://server:3000/api/webhooks/yookassa/${C()}` } });
  const c = emu(`/__emu/payments/${platPid}/webhook?repeat=1`, { post: true, body: { url: `http://server:3000/api/webhooks/yookassa/${CLUB_A}` } });
  await sleep(3000);
  assert.equal((await db.query('select count(*)::int as n from bl.billing_payments where club_id = $1', [C()])).rows[0].n, bpBefore, 'платежи платформы не появились');
  assert.equal((await db.query('select count(*)::int as n from bl.payments where club_id = $1', [C()])).rows[0].n, pBefore, 'платежи гостей не появились');
  assert.equal((await db.query('select count(*)::int as n from bl.payments where provider_payment_id = $1', [platPid])).rows[0].n, 0, 'платёж платформы не стал платежом гостя');
  // Эмулятор: в магазине платформы — только подписка; деньги гостей клуба — в его магазине.
  const all = emu('/__emu/payments');
  const list = Array.isArray(all) ? all : all.items ?? all.payments ?? [];
  const shopOf = (p) => p.shop_id ?? p.recipient?.account_id ?? null;
  const plat = list.filter((p) => shopOf(p) === PLATFORM_SHOP);
  const wrong = plat.filter((p) => p.metadata?.kind !== 'subscription');
  assert.deepEqual(wrong.map((p) => p.id), [], 'в магазине платформы — только платежи подписки');
  const clubInPlat = list.filter((p) => shopOf(p) !== PLATFORM_SHOP && p.metadata?.kind === 'subscription');
  assert.deepEqual(clubInPlat.map((p) => p.id), [], 'платежи подписки — только в магазине платформы');
  if (guestPid) assert.equal(shopOf(list.find((p) => p.id === guestPid)), SHOPS.live.shop_id, 'деньги гостя — в магазин клуба');
  assert.ok(plat.length >= 5, 'платежи платформы опознаны по магазину');
  t.diagnostic(`гость → адрес платформы: ${JSON.stringify(a).slice(0, 100)}; платформа → адрес клуба: ${JSON.stringify(b).slice(0, 100)}; → адрес клуба сида: ${JSON.stringify(c).slice(0, 60)}; в эмуляторе: платежей платформы ${plat.length} (все subscription), подписки вне 800010: ${clubInPlat.length}`);
});

test('T32-4: клуб не меняет себе цену, paid_until и статус счёта — ни через API, ни базой', { skip }, async (t) => {
  const out = [];
  for (const [m, p, body] of [
    ['PUT', `/api/platform/subscriptions/${C()}/price`, { price_per_table_kopecks: 1, reason: 'x' }],
    ['POST', `/api/platform/subscriptions/${C()}/mark-paid`, { invoice_id: S.open, reason: 'x', document: '1' }],
    ['PUT', '/api/platform/plans/bf000000-0000-4000-8000-000000000001', { price_per_table_kopecks: 1, reason: 'x' }],
  ]) {
    const r = await capi(m, p, { token: S.owner.token, club: C(), body });
    out.push(`${m} ${p.replace(C(), '{club}')} → ${r.status}`);
    assert.equal(r.status, 403, `${m} ${p}`);
  }
  const app = await appClient();
  try {
    for (const sql of [
      ['update bl.club_subscriptions set paid_until = now() + interval \'10 years\' where club_id = $1', [C()]],
      ['update bl.club_subscriptions set personal_price_kopecks = 1 where club_id = $1', [C()]],
      ["update bl.billing_invoices set status = 'paid' where id = $1", [S.open]],
      ["select bl.billing_settle_invoice($1, 'manual', null, 'x', 'x', now())", [S.open]],
      ['update bl.billing_plans set price_per_table_kopecks = 1', []],
      [
        `insert into bl.billing_payments (club_id, invoice_id, purpose, initiated_by, attempt, shop_id, idempotence_key, amount_kopecks, status, created_at, updated_at)
         values ($1, $2, 'invoice', 'owner', 1, '800010', 'e2e-forged-' || gen_random_uuid(), 1, 'succeeded', now(), now())`,
        [C(), S.open],
      ],
    ]) {
      await app.query('begin');
      await app.query("select set_config('app.club_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_type', 'user', true)", [C(), st.ownerId]);
      let res;
      try {
        const r = await app.query(sql[0], sql[1]);
        res = `выполнено, строк ${r.rowCount}`;
      } catch (e) {
        res = `отказ ${e.code}${['42501', '23514', 'P0001'].includes(e.code) ? '' : ` (${e.message.slice(0, 60)})`}`;
      }
      await app.query('rollback');
      out.push(`${sql[0].slice(0, 60)} → ${res}`);
      assert.ok(/отказ|строк 0/.test(res), `${sql[0]}: ${res}`);
    }
  } finally {
    await app.end();
  }
  assert.equal((await inv(S.open)).status, 'open');
  t.diagnostic(out.join('; '));
});

test('T32-5: чужой клуб и ресепшн не видят подписку; оператор — только чтение', { skip }, async (t) => {
  const other = await loginWait(`+7998${String((Date.now() + 7) % 10_000_000).padStart(7, '0')}`);
  const oc = await capi('POST', '/api/clubs', { token: other.token, body: { name: `E2E M5.3 Чужой ${Date.now() % 100000}`, city_name: 'Екатеринбург', timezone: 'Asia/Yekaterinburg' } });
  assert.equal(oc.status, 201);
  const res = [];
  for (const [m, p, hdr] of [
    ['GET', `/api/clubs/${C()}/subscription`, C()],
    ['GET', `/api/clubs/${C()}/subscription`, oc.json.club_id],
    ['GET', `/api/clubs/${C()}/subscription/invoices`, C()],
    ['POST', `/api/clubs/${C()}/subscription/card`, C()],
    ['DELETE', `/api/clubs/${C()}/subscription/autopay`, C()],
  ]) {
    const r = await api(m, p, { token: other.token, body: m === 'GET' ? undefined : { email: 'x@x.ru' }, headers: { 'x-club-id': hdr } });
    res.push(`чужой ${m} ${p.split('/').slice(-1)[0]} → ${r.status}`);
    assert.ok([403, 404].includes(r.status), `${m} ${p}: ${r.status}`);
  }
  const plat = await api('GET', '/api/platform/subscriptions', { token: other.token });
  assert.ok([401, 403].includes(plat.status), 'платформа — не владельцу');
  for (const p of [`/api/clubs/${CLUB_A}/subscription`, `/api/clubs/${CLUB_A}/subscription/invoices`]) {
    const r = await api('GET', p, { token: S.rec.token, headers: { 'x-club-id': CLUB_A } });
    res.push(`ресепшн ${p.split('/').slice(-1)[0]} → ${r.status}`);
    assert.equal(r.status, 403);
  }
  const op = await api('GET', '/api/platform/subscriptions', { token: S.operator.token });
  assert.equal(op.status, 200);
  const opw = await api('PUT', `/api/platform/plans/bf000000-0000-4000-8000-000000000001`, { token: S.operator.token, body: { title: 'x', reason: 'x' } });
  assert.equal(opw.status, 403);
  t.diagnostic(`${res.join('; ')}; /api/platform/subscriptions владельцу — ${plat.status}; оператор: список ${op.status}, план ${opw.status}`);
});

test('T32-6: секрет магазина платформы нигде не выводится (API, журнал, уведомления, лог сервера)', { skip }, async (t) => {
  assert.ok(S.secret.length >= 8, 'секрет прочитан из окружения контейнера');
  const texts = [];
  const add = (label, text) => texts.push([label, String(text ?? '')]);
  add('subscription owner', (await capi('GET', `/api/clubs/${C()}/subscription`, { token: S.owner.token, club: C() })).text);
  add('invoices', (await capi('GET', `/api/clubs/${C()}/subscription/invoices`, { token: S.owner.token, club: C() })).text);
  add('platform list', (await api('GET', '/api/platform/subscriptions', { token: S.andrey.token })).text);
  add('card', (await capi('POST', `/api/clubs/${C()}/subscription/card`, { token: S.owner.token, club: C(), body: { email: 'owner-e2e@billiardum.test' } })).text);
  add('health', (await api('GET', '/health')).text);
  const au = (await db.query("select data::text as d, coalesce(reason, '') as r from bl.audit_log where action like 'billing.%' or action like 'manual.billing%'")).rows;
  add('audit', au.map((x) => x.d + x.r).join('\n'));
  const nt = (await db.query("select text || coalesce(data::text, '') as t from bl.notifications where kind like 'billing.%' or kind like 'platform.billing%'")).rows;
  add('notifications', nt.map((x) => x.t).join('\n'));
  const logs = spawnSync('docker', ['logs', '--since', '6h', 'billiardum-server-1'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  add('server log', logs.stdout + logs.stderr);
  const enc = (await db.query('select payment_method_enc::text as e from bl.club_subscriptions where club_id = $1', [C()])).rows[0]?.e ?? '';
  add('payment_method_enc', enc);
  const hits = texts.filter(([, x]) => x.includes(S.secret)).map(([l]) => l);
  assert.deepEqual(hits, [], 'секрет не найден');
  t.diagnostic(`секрет длиной ${S.secret.length}: проверено ${texts.map(([l, x]) => `${l} (${x.length})`).join(', ')} — вхождений нет; base: ${BASE}`);
});

test('T32-7: наличие открытого счёта и любое состояние подписки не трогают режим клуба и чужие клубы', { skip }, async (t) => {
  const mode = (await db.query('select mode from bl.clubs where id = $1', [C()])).rows[0].mode;
  assert.equal(mode, 'live');
  const seed = (await db.query("select count(*)::int as n from bl.billing_invoices where club_id = $1 and created_at > now() - interval '1 day'", [CLUB_A])).rows[0].n;
  // Подставные часы в 01–02 — только для клуба сценария: клубу сида счета не выставлены.
  assert.equal(seed, 0, 'клубу сида счетов подставными часами не выставлено');
  void DAY;
  t.diagnostic(`режим клуба сценария ${mode}; счетов клуба сида за сутки ${seed}`);
});
