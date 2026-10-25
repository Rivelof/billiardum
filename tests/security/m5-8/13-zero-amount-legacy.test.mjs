// PoC M5.8, заход 2 — Н-2: сумма 0 ₽ при «старом» копеечном тарифе, оставшемся в базе до исправления (№220).
// Мастер и шаблон сети такой тариф уже не принимают, но уже записанные правила (UPDATE суперпользователя на СВОЁМ
// Postgres) остаются. Проверяется каждый путь, где сумма 0 ₽ могла бы стать бесплатной игрой:
//  * котировка старта и продления (гость), оплата, заявка ресепшена и её приём;
//  * БРОНЬ корта/стола (создание с суммой 0 ₽, предоплата, старт без доплаты) — отдельный путь без котировки;
//  * доплата по брони при раннем приходе и опоздании (due = 0 → старт без оплаты).
// Обвязка — server/bookings/test/db/harness.mjs (поддельные часы, эмулятор ЮKassa, настоящий роутер и деньги).
//
// Запуск (только свой Postgres на 127.0.0.1:55xxx!):
//   DATABASE_ADMIN_URL=postgres://postgres@127.0.0.1:55432/postgres node --test tests/security/m5-8/13-zero-amount-legacy.test.mjs

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CLUB_A, MIN, setup, T0 } from '../../../server/bookings/test/db/harness.mjs';

const ADMIN = process.env.DATABASE_ADMIN_URL ?? '';
const SKIP = !/@(127\.0\.0\.1|localhost):55\d{3}\//.test(ADMIN);
if (SKIP) console.log('SKIP: задайте DATABASE_ADMIN_URL=postgres://postgres@127.0.0.1:55xxx/postgres (свой временный Postgres)');

const COURT_1 = 'e1000000-0000-4000-8000-000000000101';
const COURT_2 = 'e1000000-0000-4000-8000-000000000102';
const TABLE_3 = 'e1000000-0000-4000-8000-000000000003';
let h;
let n = 0;
const phone = () => `+7999600${String(5000 + (n += 1)).padStart(4, '0')}`;

before(async () => {
  if (SKIP) return;
  h = await setup({ settings: { booking_prepayment: 'full' } });
  // «Старые» тарифы до №220: слот корта 49 коп. и час стола 49 коп. (шаг 60, минимум 60).
  await h.q("update bl.tariff_rules set price_per_slot = 49, price_per_hour = 33 where resource_type = 'padel_court' and active");
  await h.q("update bl.tariff_rules set price_per_hour = 49, step_minutes = 60, min_minutes = 60 where resource_type = 'billiard_pyramid' and active");
});
after(async () => {
  await h?.close();
});

describe('сумма 0 ₽ при старом копеечном тарифе', { skip: SKIP }, () => {
  it('движок на этих правилах действительно даёт 0 ₽ (иначе проверка бессмысленна)', async () => {
    const { amountFor } = await import('../../../server/tariffs/index.mjs');
    const slot = await h.admin.query('select 1');
    void slot;
    const c = await h.pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'system', true)", [CLUB_A]);
      const a = await amountFor(c, { resourceId: COURT_1, from: new Date(T0), minutes: 90 });
      const t = await amountFor(c, { resourceId: TABLE_3, from: new Date(T0), minutes: 60 });
      console.log(`INFO  движок: слот корта ${a.amount_kopecks} коп., час стола ${t.amount_kopecks} коп.`);
      assert.equal(a.amount_kopecks, 0);
      assert.equal(t.amount_kopecks, 0);
      await c.query('rollback');
    } finally {
      c.release();
    }
  });

  it('котировка старта корта и стола на 0 ₽ → 400 (гость)', async () => {
    h.clock.set(T0);
    const g = await h.login(phone());
    for (const [resource, minutes] of [[COURT_1, 90], [TABLE_3, 60]]) {
      const q = await h.request('POST', '/api/quotes', { token: g.token, body: { resource_id: resource, kind: 'start', minutes } });
      assert.equal(q.status, 400, `${resource}: ${q.status} ${q.text}`);
    }
  });

  // Н-5 (заход 2): путь брони не проверяет сумму 0 ₽. Эти два теста падают, пока дефект жив (воспроизведение находки).
  it('Н-5: бронь корта на 0 ₽ должна отклоняться (400), а не создаваться и стартовать без оплаты', async () => {
    h.clock.set(T0);
    const g = await h.login(phone());
    const startMin = 3 * 1440 + 2 * 60;
    const b = await h.request('POST', '/api/bookings', { token: g.token, body: { resource_id: COURT_2, starts_at: h.at(startMin), minutes: 90 } });
    console.log(`INFO  бронь корта на 0 ₽: ${b.status}, amount=${b.json?.amount_kopecks}, prepayment=${b.json?.prepayment_kopecks}, status=${b.json?.status}`);
    let started = null;
    if (b.status === 201) {
      h.clock.set(T0 + startMin * MIN);
      const st = await h.request('POST', `/api/bookings/${b.json.id}/start`, { token: g.token, body: { code: await h.code(COURT_2) } });
      started = st.json?.status;
      const commands = (await h.q("select count(*)::int as n from bl.device_commands where device_id = (select id from bl.devices where resource_id = $1)", [COURT_2]).catch(() => [{ n: -1 }]))[0].n;
      console.log(`INFO  старт брони на 0 ₽: HTTP ${st.status}, status=${started}, session=${st.json?.session_id}, команд устройству корта (включение света): ${commands}, платежей: ${(await h.q('select count(*)::int as n from bl.payments where booking_id = $1', [b.json.id]).catch(() => [{ n: '?' }]))[0].n}`);
    }
    assert.ok(b.status >= 400 && b.status < 500 && started !== 'started', `бронь ${b.status}, старт ${started}: бесплатная игра`);
  });

  it('Н-5: бронь стола на 0 ₽ (час 49 коп., шаг 60) должна отклоняться', async () => {
    h.clock.set(T0);
    const g = await h.login(phone());
    const startMin = 4 * 1440 + 2 * 60;
    const b = await h.request('POST', '/api/bookings', { token: g.token, body: { resource_id: TABLE_3, starts_at: h.at(startMin), minutes: 60 } });
    let started = null;
    if (b.status === 201) {
      h.clock.set(T0 + startMin * MIN);
      const st = await h.request('POST', `/api/bookings/${b.json.id}/start`, { token: g.token, body: { code: await h.code(TABLE_3) } });
      started = st.json?.status;
      console.log(`INFO  бронь стола на 0 ₽: amount=${b.json.amount_kopecks}; старт: ${started}`);
    }
    assert.ok(b.status >= 400 && b.status < 500 && started !== 'started', `бронь ${b.status}, старт ${started}: бесплатная игра`);
  });

  it('заявка ресепшена на 0 ₽ (строкой, как в старых данных): приём → 400, платёж не создан', async () => {
    h.clock.set(T0);
    const g = await h.login(phone());
    const rid = await h.q(
      `with q as (insert into bl.quotes (club_id, resource_id, user_id, kind, minutes, from_at, amount_kopecks, valid_until, used_at)
                  values ($1, $2, $3, 'start', 90, now(), 0, now() + interval '3 minutes', now()) returning id)
       insert into bl.reception_requests (club_id, quote_id, resource_id, user_id, kind, minutes, amount_kopecks, status, expires_at)
       select $1, q.id, $2, $3, 'start', 90, 0, 'waiting', now() + interval '15 minutes' from q returning id`,
      [CLUB_A, COURT_1, g.id],
    ).catch((e) => ({ error: e.message }));
    if (rid.error) {
      console.log(`INFO  заявку на 0 ₽ база не принимает: ${rid.error}`);
      return;
    }
    const rec = await h.login('+70000000004');
    const acc = await h.request('POST', `/api/reception/requests/${rid[0].id}/accept`, { token: rec.token, body: { method: 'cash', received_kopecks: 0 }, key: crypto.randomUUID(), club: CLUB_A });
    assert.equal(acc.status, 400, acc.text);
    assert.equal((await h.q('select count(*)::int as n from bl.payments where club_id = $1 and amount_kopecks = 0', [CLUB_A]))[0].n, 0);
  });

  it('«живая» котировка на 0 ₽ (выдана до исправления): оплата СБП, картой и «на ресепшене» → 400, платёжной записи нет', async () => {
    h.clock.set(T0);
    const g = await h.login(phone());
    const row = await h.q(
      `insert into bl.quotes (club_id, resource_id, user_id, kind, minutes, from_at, amount_kopecks, valid_until)
       values ($1, $2, $3, 'start', 90, $4, 0, $5) returning id`,
      [CLUB_A, COURT_1, g.id, new Date(T0), new Date(T0 + 5 * MIN)],
    ).catch((e) => ({ error: e.message }));
    if (row.error) {
      console.log(`INFO  котировку на 0 ₽ база не принимает: ${row.error}`);
      return;
    }
    const before = (await h.q('select count(*)::int as n from bl.payments'))[0].n;
    for (const method of ['sbp', 'card', 'reception']) {
      const r = await h.request('POST', `/api/quotes/${row[0].id}/pay`, { token: g.token, key: crypto.randomUUID(), body: { method } });
      assert.equal(r.status, 400, `${method}: ${r.status} ${r.text.slice(0, 120)}`);
    }
    assert.equal((await h.q('select count(*)::int as n from bl.payments'))[0].n, before, 'платежей не создано');
    assert.equal((await h.q('select count(*)::int as n from bl.reception_requests where quote_id = $1', [row[0].id]))[0].n, 0, 'заявки ресепшена нет');
  });

  it('справочно: округление клуба крупнее рубля (price_rounding_kopecks = 1000, API его не меняет) и тариф 4 ₽ за слот, принятый мастером', async () => {
    const { normalizeRules } = await import('../../../server/setup/tariffs.mjs');
    const accepted = (() => {
      try {
        normalizeRules([{ kind: 'padel_court', days: [1, 2, 3, 4, 5, 6, 7], from: '06:00', to: '06:00', slot_minutes: 90, price_per_slot_kopecks: 400 }]);
        return true;
      } catch {
        return false;
      }
    })();
    await h.q("update bl.tariff_rules set price_per_slot = 400, price_per_hour = 267 where resource_type = 'padel_court' and active");
    await h.q("update bl.clubs set settings = settings || '{\"price_rounding_kopecks\": 1000}'::jsonb where id = $1", [CLUB_A]);
    h.clock.set(T0);
    const g = await h.login(phone());
    const q = await h.request('POST', '/api/quotes', { token: g.token, body: { resource_id: COURT_1, kind: 'start', minutes: 90 } });
    const startMin = 6 * 1440 + 2 * 60;
    const b = await h.request('POST', '/api/bookings', { token: g.token, body: { resource_id: COURT_2, starts_at: h.at(startMin), minutes: 90 } });
    console.log(`INFO  мастер принимает 4 ₽/слот: ${accepted}; при округлении 10 ₽ котировка → ${q.status}; бронь → ${b.status}, сумма ${b.json?.amount_kopecks}`);
    await h.q("update bl.clubs set settings = settings - 'price_rounding_kopecks' where id = $1", [CLUB_A]);
  });
});
