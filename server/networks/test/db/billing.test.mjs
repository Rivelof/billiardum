// T42, подписка «Сеть» (M5.5 №194, M5.3 №180): план «Сеть» в базе планов, цену задаёт Андрей
// (platform_admin); включается клубам сети из двух и более клубов, вне сети — «Клуб». Логика счетов
// M5.3 не меняется: счёт = столы × цена плана клуба на дату счёта.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { deactivateSeedCourts, tryQuery } from '../../../../supabase/tests/helpers.mjs';
import { CLUB_A, PHONES, PLAN_CLUB, setup } from '../../../billing/test/db/harness.mjs';

const SKIP = !process.env.DATABASE_ADMIN_URL;
const PLAN_NETWORK = 'bf000000-0000-4000-8000-000000000002';
const CLUB_C = 'c5500000-0000-4000-8000-0000000000c1';
const MIN = 60_000;

let h;
let ownerA;
let andrey;
let net;

before(async () => {
  if (SKIP) return;
  h = await setup();
  // Корты сида (M5.8) — вне работы: счёт считаем по 8 столам клуба A (как в тестах M5.3).
  await deactivateSeedCourts(h.admin);
  ownerA = await h.login(PHONES.ownerA);
  andrey = await h.login(PHONES.andrey);
  await h.admin.query(`
    insert into bl.clubs (id, name, city, timezone) values ('${CLUB_C}', 'Клуб Самара', 'Самара', 'Europe/Samara');
    insert into bl.club_members (club_id, user_id, role) values ('${CLUB_C}', '${ownerA.id}', 'owner');
    insert into bl.resources (club_id, type, number, title) values ('${CLUB_C}', 'billiard_pool', 1, 'Стол 1'), ('${CLUB_C}', 'billiard_pool', 2, 'Стол 2');
  `);
});

after(async () => {
  await h?.stop();
});

const sub = async (club) => (await h.q('select s.*, p.code from bl.club_subscriptions s join bl.billing_plans p on p.id = s.plan_id where s.club_id = $1', [club]))[0];
const asOwner = (fn) => h.asApp({ userId: ownerA.id, actorType: 'user' }, fn);

describe('T42. Подписка «Сеть» (№194)', { skip: SKIP }, () => {
  it('план «Сеть» — строка базы планов; клуб в сети из одного клуба остаётся на «Клубе»', async () => {
    const plans = await h.q("select code, title, price_per_table_kopecks, trial_days, active from bl.billing_plans where code = 'network'");
    assert.deepEqual(plans.map((p) => [p.code, p.title, Number(p.price_per_table_kopecks), p.trial_days, p.active]), [['network', 'Сеть', 119000, 60, true]]);
    assert.equal((await h.request('GET', `/api/clubs/${CLUB_A}/subscription`, { token: ownerA.token })).status, 200);
    assert.equal((await sub(CLUB_A)).code, 'club');
    net = await asOwner(async (c) => {
      const id = (await c.query("select bl.network_create('Сеть Урал') as id")).rows[0].id;
      await c.query('select bl.network_add_club($1, $2)', [id, CLUB_A]);
      return id;
    });
    assert.equal((await sub(CLUB_A)).code, 'club', 'сеть из одного клуба — без плана «Сеть»');
  });

  it('второй клуб в сети: оба клуба — на «Сети» (и подписка, созданная позже); счёт — столы × цена «Сети»', async () => {
    await asOwner((c) => c.query('select bl.network_add_club($1, $2)', [net, CLUB_C]));
    assert.equal((await sub(CLUB_A)).code, 'network');
    const r = await h.request('GET', `/api/clubs/${CLUB_A}/subscription`, { token: ownerA.token });
    assert.deepEqual(r.json.plan, { id: PLAN_NETWORK, code: 'network', title: 'Сеть' });
    assert.equal(r.json.price_per_table_kopecks, 119000);
    assert.equal(r.json.next_invoice.amount_kopecks, 8 * 119000);
    // Подписка клуба C создаётся при первом обращении (клуб в live) — сразу с планом «Сеть».
    const c = await h.request('GET', `/api/clubs/${CLUB_C}/subscription`, { token: ownerA.token });
    assert.equal(c.status, 200, c.text);
    assert.equal(c.json.plan.code, 'network');
    assert.equal(c.json.next_invoice.amount_kopecks, 2 * 119000);
  });

  it('цену «Сети» задаёт только Андрей; новая цена — в следующем счёте', async () => {
    const path = `/api/platform/plans/${PLAN_NETWORK}`;
    assert.equal((await h.request('PUT', path, { token: ownerA.token, body: { price_per_table_kopecks: 1 } })).status, 403);
    const p = await h.request('PUT', path, { token: andrey.token, body: { price_per_table_kopecks: 99000, reason: 'Цена сети с ноября' } });
    assert.equal(p.status, 200, p.text);
    // Клуб сам план не меняет.
    await h.asApp({ clubId: CLUB_A, userId: ownerA.id, actorType: 'user' }, async (c) => {
      assert.equal((await tryQuery(c, 'update bl.club_subscriptions set plan_id = $2 where club_id = $1', [CLUB_A, PLAN_CLUB]))?.code, '42501');
      assert.equal((await tryQuery(c, 'select bl.network_sync_billing($1)', [net]))?.code, '42501');
    });
    const s = await sub(CLUB_A);
    h.setNow(s.trial_until.getTime() + MIN);
    const out = await h.tick();
    assert.equal(out.errors, 0);
    const [inv] = await h.q('select * from bl.billing_invoices where club_id = $1 order by period_start', [CLUB_A]);
    assert.deepEqual([inv.tables, Number(inv.price_per_table_kopecks), Number(inv.amount_kopecks)], [8, 99000, 8 * 99000]);
    h.setNow(Date.now());
  });

  it('клуб вышел из сети — снова «Клуб» (и у оставшегося одного клуба); персональная цена главнее плана', async () => {
    await asOwner((c) => c.query('select bl.network_remove_club($1, $2)', [net, CLUB_C]));
    assert.equal((await sub(CLUB_C)).code, 'club');
    assert.equal((await sub(CLUB_A)).code, 'club', 'в сети один клуб — план «Клуб»');
    await asOwner((c) => c.query('select bl.network_add_club($1, $2)', [net, CLUB_C]));
    assert.equal((await sub(CLUB_C)).code, 'network');
    const price = await h.request('PUT', `/api/platform/subscriptions/${CLUB_C}/price`, { token: andrey.token, body: { price_per_table_kopecks: 50000, reason: 'Пилот сети' } });
    assert.equal(price.status, 200, price.text);
    assert.equal(price.json.price_per_table_kopecks, 50000);
    const list = await h.request('GET', '/api/platform/subscriptions', { token: andrey.token });
    assert.ok(list.json.plans.some((p) => p.code === 'network'));
    assert.equal(list.json.items.find((i) => i.club_id === CLUB_C).plan.code, 'network');
  });
});
