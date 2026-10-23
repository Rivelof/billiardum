// Подключение клуба без выезда (M5.1 backend-A, №152–154, №160) на настоящем Postgres:
// создание клуба и лимит, режим и is_test, магазины test/live с проверкой /v3/me, проверочный
// платёж 1 ₽ и тревога вебхука, чек-лист и go-live с карточкой каталога, приостановка платформой,
// исключение тестовых записей из отчётов, нефискальный «ТЕСТ» на ККТ.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { asRole, tryQuery } from '../../../../supabase/tests/helpers.mjs';
import { withContext } from '../../../lib/store.mjs';
import { playStats, shiftPayments, shiftRefunds } from '../../../reports/queries.mjs';
import { applyResult, claimJob, ensureOp } from '../../../kkt/queue.mjs';
import { CLUB_A, CLUB_B, OWNER_A, SHOPS, setup } from './harness.mjs';

let h;
const MIN = 60_000;

before(async () => {
  h = await setup();
});
after(async () => {
  await h?.stop();
});

let phoneSeq = 0;
const newPhone = () => `+7999${String(Date.now() % 1_000_000).padStart(6, '0')}${String((phoneSeq += 1) % 10)}`;

async function newOwner() {
  return h.login(newPhone());
}

async function createClub(token, body = {}) {
  return h.request('POST', '/api/clubs', { token, body: { name: 'Клуб «Тест»', city_name: 'Пермь', timezone: 'Asia/Yekaterinburg', ...body } });
}

/** Стол клуба с контроллером (суперпользователь, как после мастера зала и привязки). */
async function addTable(clubId, number, { seen = true } = {}) {
  const resourceId = randomUUID();
  await h.admin.query("insert into bl.resources (id, club_id, type, number, title) values ($1, $2, 'billiard_pool', $3, $4)", [resourceId, clubId, number, `Стол ${number}`]);
  const deviceId = randomUUID();
  await h.admin.query('insert into bl.devices (id, club_id, resource_id, mqtt_username, last_seen_at) values ($1::uuid, $2, $3, $1::text, $4)', [
    deviceId,
    clubId,
    resourceId,
    seen ? new Date() : null,
  ]);
  return { resourceId, deviceId };
}

async function insertPayment(clubId, resourceId, userId, { provider = 'reception', method = 'cash', confirmedAt = new Date(), providerId = null } = {}) {
  const { rows } = await h.admin.query(
    `insert into bl.payments (club_id, resource_id, user_id, kind, provider, method, provider_payment_id, idempotence_key, status, amount_kopecks, confirmed_at)
     values ($1, $2, $3, 'start', $4, $5, $6, $7, 'succeeded', 50000, $8) returning id, is_test`,
    [clubId, resourceId, userId, provider, method, providerId, `t-${randomUUID()}`, confirmedAt],
  );
  return rows[0];
}

describe('создание клуба (№152)', () => {
  it('POST /api/clubs: клуб в test, пользователь — владелец, журнал club.create; /api/me отдаёт режим', async () => {
    const u = await newOwner();
    const r = await createClub(u.token);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.mode, 'test');
    const [c] = await h.q('select mode, created_by, city, timezone, city_id from bl.clubs where id = $1', [r.json.club_id]);
    assert.deepEqual([c.mode, c.created_by, c.city, c.timezone], ['test', u.id, 'Пермь', 'Asia/Yekaterinburg']);
    const m = await h.q('select role, active from bl.club_members where club_id = $1', [r.json.club_id]);
    assert.deepEqual(m, [{ role: 'owner', active: true }]);
    assert.equal((await h.q('select count(*)::int as n from bl.club_payment_settings where club_id = $1', [r.json.club_id]))[0].n, 1);
    const a = await h.q("select actor_id, data from bl.audit_log where club_id = $1 and action = 'club.create'", [r.json.club_id]);
    assert.equal(a[0].actor_id, u.id);
    const me = await h.request('GET', '/api/me', { token: u.token });
    assert.deepEqual(me.json.clubs.map((x) => [x.club_id, x.role, x.mode]), [[r.json.club_id, 'owner', 'test']]);
  });

  it('не больше 3 тестовых клубов: четвёртый — 409 clubs_limit; гонка не обходит лимит', async () => {
    const u = await newOwner();
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => createClub(u.token, { name: `Клуб ${i}` })));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 201, 201, 409, 409]);
    assert.ok(results.filter((r) => r.status === 409).every((r) => r.json.error === 'clubs_limit'));
    const again = await createClub(u.token);
    assert.equal(again.json.error, 'clubs_limit');
  });

  it('проверка данных: город, пояс, листинг только из своей одобренной заявки', async () => {
    const u = await newOwner();
    assert.equal((await createClub(u.token, { timezone: 'MSK' })).status, 400);
    assert.equal((await createClub(u.token, { name: '' })).status, 400);
    assert.equal((await createClub(u.token, { city_name: undefined })).status, 400);
    const anon = await h.request('POST', '/api/clubs', { body: { name: 'x', city_name: 'Пермь', timezone: 'UTC' } });
    assert.equal(anon.status, 401);
    // Карточка каталога и заявка «Подтвердить клуб» другого пользователя.
    const [city] = await h.q("insert into bl.cities (slug, name, timezone) values ('perm', 'Пермь', 'Asia/Yekaterinburg') on conflict (slug) do update set name = excluded.name returning id");
    const [card] = await h.q("insert into bl.club_public (city_id, slug, name, status) values ($1, 'piramida', 'Пирамида', 'claimed') returning id", [city.id]);
    const other = await newOwner();
    await h.admin.query("insert into bl.directory_claims (kind, card_id, user_id, status, created_at, updated_at) values ('claim', $1, $2, 'approved', now(), now())", [card.id, other.id]);
    const stolen = await createClub(u.token, { listing_id: card.id });
    assert.equal(stolen.status, 404);
    assert.deepEqual((await h.request('GET', '/api/clubs/claimable-listings', { token: u.token })).json.items, []);
    const offered = await h.request('GET', '/api/clubs/claimable-listings', { token: other.token });
    assert.deepEqual(offered.json.items.map((x) => [x.listing_id, x.name, x.city_id]), [[card.id, 'Пирамида', city.id]]);
    const own = await createClub(other.token, { listing_id: card.id, city_id: city.id, city_name: undefined, timezone: undefined });
    assert.equal(own.status, 201, own.text);
    const [c] = await h.q('select listing_id, city_id, timezone from bl.clubs where id = $1', [own.json.club_id]);
    assert.deepEqual([c.listing_id, c.city_id, c.timezone], [card.id, city.id, 'Asia/Yekaterinburg']);
    assert.equal((await createClub(other.token, { listing_id: card.id })).status, 404, 'карточка уже связана с клубом');
    assert.deepEqual((await h.request('GET', '/api/clubs/claimable-listings', { token: other.token })).json.items, []);
  });

  it('app_api не создаёт клубы и не меняет режим напрямую; create_club — только в личном контексте', async () => {
    await asRole(h.admin, 'app_api', { clubId: CLUB_A, userId: OWNER_A, actorType: 'user' }, async (c) => {
      assert.equal((await tryQuery(c, "update bl.clubs set mode = 'test' where id = $1", [CLUB_A]))?.code, '42501');
      assert.equal((await tryQuery(c, "insert into bl.clubs (name, city, timezone) values ('x', 'y', 'UTC')"))?.code, '42501');
      assert.equal(await tryQuery(c, "update bl.clubs set name = 'Тестовый клуб' where id = $1", [CLUB_A]), null);
      assert.equal((await tryQuery(c, "select bl.create_club('x', 'Пермь', null, 'UTC', null)"))?.code, '42501');
      assert.equal((await tryQuery(c, "select bl.club_suspend($1, 'x')", [CLUB_A]))?.code, '42501');
    });
    await asRole(h.admin, 'app_api', { clubId: null, userId: OWNER_A, actorType: 'system' }, async (c) => {
      assert.equal((await tryQuery(c, "select bl.create_club('x', 'Пермь', null, 'UTC', null)"))?.code, '42501');
    });
  });
});

describe('режим клуба и is_test (№153)', () => {
  it('ctx.clubMode и app.club_mode в запросе; bl.public_clubs — только боевые', async () => {
    const u = await newOwner();
    const { json } = await createClub(u.token);
    const r = await h.request('GET', `/api/test/clubs/${json.club_id}/mode`, { token: u.token });
    assert.deepEqual(r.json, { mode: 'test', guc: 'test' });
    const owner = await h.login('+70000000001');
    assert.deepEqual((await h.request('GET', `/api/test/clubs/${CLUB_A}/mode`, { token: owner.token })).json, { mode: 'live', guc: 'live' });
    const pub = (await h.q('select id from bl.public_clubs()')).map((x) => x.id);
    assert.ok(pub.includes(CLUB_A));
    assert.ok(!pub.includes(json.club_id));
  });

  it('триггер ставит is_test по режиму клуба, наследует от платежа, менять нельзя', async () => {
    const u = await newOwner();
    const { json } = await createClub(u.token);
    const club = json.club_id;
    const { resourceId } = await addTable(club, 1);
    // Приложение просит is_test = false — база ставит по режиму клуба.
    const { rows } = await h.admin.query(
      `insert into bl.sessions (club_id, resource_id, status, payer_user_id, started_at, paid_until, ended_at, close_reason, created_at, updated_at, is_test)
       values ($1, $2, 'closed', $3, now() - interval '1 hour', now(), now(), 'expired', now(), now(), false) returning id, is_test`,
      [club, resourceId, u.id],
    );
    assert.equal(rows[0].is_test, true);
    const p = await insertPayment(club, resourceId, u.id);
    assert.equal(p.is_test, true);
    const live = await insertPayment(CLUB_A, 'e1000000-0000-4000-8000-000000000001', OWNER_A);
    assert.equal(live.is_test, false);
    // Клуб перешёл в live: новый платёж — боевой, возврат тестового платежа — тестовый.
    await h.admin.query("update bl.clubs set mode = 'live' where id = $1", [club]);
    assert.equal((await insertPayment(club, resourceId, u.id)).is_test, false);
    const [f] = await h.q(
      "insert into bl.refunds (club_id, payment_id, idempotence_key, amount_kopecks, status, reason) values ($1, $2, $3, 100, 'manual', 'тест') returning is_test",
      [club, p.id, `r-${randomUUID()}`],
    );
    assert.equal(f.is_test, true);
    await assert.rejects(h.admin.query('update bl.payments set is_test = false where id = $1', [p.id]), /is_test is set once/);
    await h.admin.query("update bl.clubs set mode = 'test' where id = $1", [club]);
  });

  it('тестовые записи не входят в отчёт смены и сводку (выручка, возвраты, часы игры)', async () => {
    const u = await newOwner();
    const { json } = await createClub(u.token);
    const club = json.club_id;
    const { resourceId } = await addTable(club, 1);
    const from = new Date(Date.now() - 2 * 3600_000);
    const to = new Date(Date.now() + 60_000);
    const p = await insertPayment(club, resourceId, u.id, { confirmedAt: new Date(Date.now() - 30 * MIN) });
    await h.admin.query("insert into bl.refunds (club_id, payment_id, idempotence_key, amount_kopecks, status, reason) values ($1, $2, $3, 100, 'manual', 'x')", [club, p.id, `r-${randomUUID()}`]);
    await h.admin.query(
      `insert into bl.sessions (club_id, resource_id, status, payer_user_id, started_at, paid_until, ended_at, close_reason, created_at, updated_at)
       values ($1, $2, 'closed', $3, now() - interval '1 hour', now(), now(), 'expired', now(), now())`,
      [club, resourceId, u.id],
    );
    await withContext(h.pool, { clubId: club, actorType: 'system' }, async (db) => {
      assert.deepEqual(await shiftPayments(db, { clubId: club, from, to }), []);
      assert.deepEqual(await shiftRefunds(db, { clubId: club, from, to }), []);
      const play = await playStats(db, { clubId: club, from, to });
      assert.equal(play.sessions, 0);
      assert.equal(play.minutes, 0);
    });
  });
});

describe('магазины ЮKassa test и live (№154)', () => {
  let owner;
  let club;
  before(async () => {
    owner = await newOwner();
    club = (await createClub(owner.token)).json.club_id;
  });

  it('PUT test: проверка /v3/me, секрет — только маской; GET тот же вид', async () => {
    const r = await h.request('PUT', `/api/clubs/${club}/payment-settings/test`, { token: owner.token, body: { shop_id: SHOPS.test.shopId, secret_key: SHOPS.test.secret } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.shop_id, SHOPS.test.shopId);
    assert.deepEqual(r.json.secret_mask, { last4: SHOPS.test.secret.slice(-4), length: SHOPS.test.secret.length });
    assert.equal(r.json.test, true);
    assert.ok(r.json.verified_at);
    assert.ok(!r.text.includes(SHOPS.test.secret));
    const g = await h.request('GET', `/api/clubs/${club}/payment-settings/test`, { token: owner.token });
    assert.deepEqual(g.json, r.json);
    const all = await h.request('GET', `/api/clubs/${club}/payment-settings`, { token: owner.token });
    assert.ok(!all.text.includes(SHOPS.test.secret));
    const [row] = await h.q('select test_shop_id, test_secret_key_enc, shop_id from bl.club_payment_settings where club_id = $1', [club]);
    assert.ok(row.test_secret_key_enc.startsWith('v1:'));
    assert.equal(row.shop_id, null);
    const a = await h.q("select action, reason from bl.audit_log where club_id = $1 and action like '%payment_settings'", [club]);
    assert.deepEqual(a.map((x) => x.action), ['club.payment_settings']);
    // Без нового ключа — тот же сохранённый ключ (перепроверка).
    assert.equal((await h.request('PUT', `/api/clubs/${club}/payment-settings/test`, { token: owner.token, body: { shop_id: SHOPS.test.shopId } })).status, 200);
  });

  it('неверные пары не принимаются и ничего не меняют', async () => {
    const put = (mode, shop, extra = {}) => h.request('PUT', `/api/clubs/${club}/payment-settings/${mode}`, { token: owner.token, body: { shop_id: shop.shopId, secret_key: shop.secret, ...extra } });
    assert.equal((await put('test', SHOPS.live)).json.error, 'shop_mode_mismatch');
    assert.equal((await put('live', SHOPS.test)).json.error, 'shop_mode_mismatch');
    assert.equal((await put('live', SHOPS.liveNoFiscal)).json.error, 'fiscalization_off');
    assert.equal((await put('live', { shopId: SHOPS.live.shopId, secret: 'live_wrong_secret' })).json.error, 'shop_invalid');
    assert.equal((await put('live', { shopId: '12', secret: 'short' })).status, 400);
    assert.equal((await h.request('PUT', `/api/clubs/${club}/payment-settings/prod`, { token: owner.token, body: {} })).status, 404);
    h.emu.config.down = true;
    try {
      const down = await put('live', SHOPS.live);
      assert.equal(down.status, 503);
      assert.equal(down.json.error, 'yookassa_unavailable');
    } finally {
      h.emu.config.down = false;
    }
    const [row] = await h.q('select shop_id, live_verified_at from bl.club_payment_settings where club_id = $1', [club]);
    assert.deepEqual([row.shop_id, row.live_verified_at], [null, null]);
  });

  it('ресепшн и управляющий не видят магазины; чужой владелец — тоже', async () => {
    const staff = await h.login(newPhone());
    await h.admin.query("insert into bl.club_members (club_id, user_id, role) values ($1, $2, 'reception')", [club, staff.id]);
    const mgr = await h.login(newPhone());
    await h.admin.query("insert into bl.club_members (club_id, user_id, role) values ($1, $2, 'manager')", [club, mgr.id]);
    for (const t of [staff.token, mgr.token]) {
      assert.equal((await h.request('GET', `/api/clubs/${club}/payment-settings/test`, { token: t })).status, 403);
      assert.equal((await h.request('POST', `/api/clubs/${club}/go-live`, { token: t, body: { accept_offer: true } })).status, 403);
    }
    assert.equal((await h.request('GET', `/api/clubs/${club}/onboarding`, { token: staff.token })).status, 403);
    const mob = await h.request('GET', `/api/clubs/${club}/onboarding`, { token: mgr.token });
    assert.equal(mob.status, 200);
    assert.equal(mob.json.shops, null, 'управляющему магазины не отдаются');
    assert.ok(!mob.text.includes(SHOPS.test.shopId));
    const stranger = await newOwner();
    assert.equal((await h.request('GET', `/api/clubs/${club}/payment-settings/test`, { token: stranger.token })).status, 403);
  });

  it('в live правка магазина — ручное действие: причина, manual.payment_settings, тревога владельцу', async () => {
    const a = await h.login('+70000000001');
    const no = await h.request('PUT', `/api/clubs/${CLUB_A}/payment-settings/live`, { token: a.token, body: { shop_id: SHOPS.live.shopId, secret_key: SHOPS.live.secret } });
    assert.equal(no.json.error, 'reason_required');
    const r = await h.request('PUT', `/api/clubs/${CLUB_A}/payment-settings/live`, { token: a.token, body: { shop_id: SHOPS.live.shopId, secret_key: SHOPS.live.secret, reason: 'Новый магазин клуба' } });
    assert.equal(r.status, 200, r.text);
    const [audit] = await h.q("select reason, actor_id from bl.audit_log where club_id = $1 and action = 'manual.payment_settings'", [CLUB_A]);
    assert.deepEqual([audit.reason, audit.actor_id], ['Новый магазин клуба', OWNER_A]);
    const [alarm] = await h.q("select level, data from bl.alarms where club_id = $1 and type = 'manual_action' order by raised_at desc limit 1", [CLUB_A]);
    assert.equal(alarm.data.action, 'manual.payment_settings');
    const n = await h.q("select text from bl.notifications where user_id = $1 and kind = 'alarm' order by created_at desc limit 1", [OWNER_A]);
    assert.match(n[0].text, /магазин ЮKassa.*Причина: Новый магазин клуба/);
  });

  it('ctx.manual: без причины — 400 reason_required, с причиной — журнал и тревога', async () => {
    const a = await h.login('+70000000001');
    assert.equal((await h.request('POST', `/api/test/clubs/${CLUB_A}/manual`, { token: a.token, body: {} })).json.error, 'reason_required');
    const r = await h.request('POST', `/api/test/clubs/${CLUB_A}/manual`, { token: a.token, body: { reason: 'праздник' } });
    assert.equal(r.status, 200, r.text);
    assert.equal((await h.q("select count(*)::int as n from bl.audit_log where club_id = $1 and action = 'manual.tariff_change' and reason = 'праздник'", [CLUB_A]))[0].n, 1);
  });
});

describe('проверочный платёж 1 ₽ и вебхук (№154)', () => {
  let owner;
  let club;
  before(async () => {
    owner = await newOwner();
    club = (await createClub(owner.token)).json.club_id;
    const r = await h.request('PUT', `/api/clubs/${club}/payment-settings/test`, { token: owner.token, body: { shop_id: SHOPS.test.shopId, secret_key: SHOPS.test.secret } });
    assert.equal(r.status, 200, r.text);
  });

  it('платёж → вебхук → возврат 1 ₽; статус в onboarding, шаг «ЮKassa» выполнен', async () => {
    const r = await h.request('POST', `/api/clubs/${club}/payment-settings/test/check`, { token: owner.token });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.status, 'pending');
    assert.match(r.json.confirmation_url, /\/pay\//);
    const [c] = await h.q('select provider_payment_id from bl.shop_checks where id = $1', [r.json.payment_id]);
    const pay = await fetch(`${h.emuBase}/__emu/payments/${c.provider_payment_id}/succeed?wait=1`, { method: 'POST' });
    assert.equal(pay.status, 200);
    const done = await h.waitFor(async () => {
      const [x] = await h.q('select * from bl.shop_checks where id = $1', [r.json.payment_id]);
      return x.refund_status === 'succeeded' ? x : null;
    });
    assert.equal(done.status, 'succeeded');
    assert.equal(done.confirmed_via, 'webhook');
    assert.ok(done.webhook_at);
    const emuPay = await (await fetch(`${h.emuBase}/__emu/payments/${c.provider_payment_id}`)).json();
    assert.equal(emuPay.refunded_amount?.value, '1.00');
    assert.ok(emuPay.receipt, 'чек продажи 54-ФЗ');
    const ob = await h.request('GET', `/api/clubs/${club}/onboarding`, { token: owner.token });
    assert.equal(ob.json.payment_checks.test.status, 'succeeded');
    assert.equal(ob.json.payment_checks.test.refunded, true);
    assert.ok(ob.json.payment_checks.test.webhook_at);
    assert.equal(ob.json.steps.find((s) => s.id === 'payments').done, true);
    assert.equal(ob.json.webhook_url, `https://bl.test/api/webhooks/yookassa/${club}`);
  });

  it('без вебхука: сверка подтверждает и возвращает, через 10 минут — тревога «вебхук не настроен»', async () => {
    h.emu.config.webhookUrl = null;
    try {
      const r = await h.request('POST', `/api/clubs/${club}/payment-settings/test/check`, { token: owner.token });
      const [c] = await h.q('select provider_payment_id from bl.shop_checks where id = $1', [r.json.payment_id]);
      await fetch(`${h.emuBase}/__emu/payments/${c.provider_payment_id}/succeed`, { method: 'POST' });
      h.clock.offsetMs = 30_000;
      await h.tick();
      const [x] = await h.q('select * from bl.shop_checks where id = $1', [r.json.payment_id]);
      assert.deepEqual([x.status, x.confirmed_via, x.refund_status, x.webhook_at], ['succeeded', 'sync', 'succeeded', null]);
      await h.tick();
      assert.equal((await h.q("select count(*)::int as n from bl.alarms where club_id = $1 and type = 'yookassa_webhook_missing'", [club]))[0].n, 0);
      h.clock.offsetMs = 11 * MIN;
      await h.tick();
      const alarms = await h.q("select data, dedupe_key from bl.alarms where club_id = $1 and type = 'yookassa_webhook_missing'", [club]);
      assert.equal(alarms.length, 1);
      assert.equal(alarms[0].data.mode, 'test');
      await h.tick();
      assert.equal((await h.q("select count from bl.alarms where club_id = $1 and type = 'yookassa_webhook_missing'", [club]))[0].count, 1, 'одна тревога, без повторов');
    } finally {
      h.clock.offsetMs = 0;
      h.emu.config.webhookUrl = `${h.base}/api/webhooks/yookassa/{club_id}`;
    }
  });

  it('платёж гостя подтверждён сверкой, вебхука нет 10 минут — тревога; с вебхуком — нет', async () => {
    const { resourceId } = await addTable(CLUB_B, 9);
    const silent = await insertPayment(CLUB_B, resourceId, 'a2000000-0000-4000-8000-000000000002', { provider: 'yookassa', method: 'sbp', providerId: `p-${randomUUID()}`, confirmedAt: new Date(Date.now() - 12 * MIN) });
    const heard = await insertPayment(CLUB_B, resourceId, 'a2000000-0000-4000-8000-000000000002', { provider: 'yookassa', method: 'sbp', providerId: `p-${randomUUID()}`, confirmedAt: new Date(Date.now() - 12 * MIN) });
    await h.admin.query('update bl.payments set webhook_at = now() where id = $1', [heard.id]);
    await h.tick();
    const [a] = await h.q("select data from bl.alarms where club_id = $1 and type = 'yookassa_webhook_missing'", [CLUB_B]);
    assert.equal(a.data.payment_id, silent.id);
    assert.equal(a.data.mode, 'live');
    const rows = await h.q('select id, webhook_alarm_at from bl.payments where id = any($1::uuid[])', [[silent.id, heard.id]]);
    assert.ok(rows.find((x) => x.id === silent.id).webhook_alarm_at);
    assert.equal(rows.find((x) => x.id === heard.id).webhook_alarm_at, null);
  });
});

describe('чек-лист и переход в боевой режим (№160)', () => {
  let owner;
  let club;
  before(async () => {
    owner = await newOwner();
    club = (await createClub(owner.token, { name: 'Бильярд «Луза»' })).json.club_id;
  });

  it('пока пункты не выполнены — 409 checklist_incomplete {failed}', async () => {
    const r = await h.request('POST', `/api/clubs/${club}/go-live`, { token: owner.token, body: {} });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'checklist_incomplete');
    assert.deepEqual(r.json.failed, ['tables', 'devices', 'tariffs', 'shop_live', 'kkt', 'stickers', 'offer']);
    const ob = await h.request('GET', `/api/clubs/${club}/onboarding`, { token: owner.token });
    assert.equal(ob.json.mode, 'test');
    assert.equal(ob.json.checklist.ready, false);
    assert.deepEqual(ob.json.steps.map((s) => s.id), ['club', 'hall', 'tariffs', 'menu', 'staff', 'payments', 'devices', 'stickers', 'test', 'go_live']);
    assert.equal(ob.json.checklist.items.find((i) => i.id === 'tariffs').detail, 'Нет тарифа: сб 00:00–12:00, пул');
    assert.equal((await h.q("select count(*)::int as n from bl.audit_log where club_id = $1 and action = 'club.go_live'", [club]))[0].n, 0);
  });

  it('контроллер не на связи 10 минут — пункт devices не выполнен', async () => {
    await addTable(club, 1);
    const t2 = await addTable(club, 2, { seen: false });
    let ob = await h.request('GET', `/api/clubs/${club}/onboarding`, { token: owner.token });
    const dev = ob.json.checklist.items.find((i) => i.id === 'devices');
    assert.deepEqual([dev.ok, dev.detail], [false, 'Не на связи столы №2']);
    await h.admin.query('update bl.devices set last_seen_at = now() where id = $1', [t2.deviceId]);
    ob = await h.request('GET', `/api/clubs/${club}/onboarding`, { token: owner.token });
    assert.equal(ob.json.checklist.items.find((i) => i.id === 'devices').ok, true);
    assert.equal(ob.json.steps.find((s) => s.id === 'hall').done, true);
  });

  it('касса ресепшена: мост на связи и ККТ фискальная — или касса выключена', async () => {
    const [b] = await h.q(
      `insert into bl.kkt_bridges (club_id, name, token_hash, last_seen_at, last_status) values ($1, 'Ресепшн', $2, now(), '{"online": true, "fiscal": false}') returning id`,
      [club, 'a'.repeat(64)],
    );
    let ob = await h.request('GET', `/api/clubs/${club}/onboarding`, { token: owner.token });
    assert.deepEqual(ob.json.checklist.items.find((i) => i.id === 'kkt'), { id: 'kkt', ok: false, detail: 'ККТ не фискальная или не ответила' });
    await h.admin.query(`update bl.kkt_bridges set last_status = '{"online": true, "fiscal": true}' where id = $1`, [b.id]);
    ob = await h.request('GET', `/api/clubs/${club}/onboarding`, { token: owner.token });
    assert.equal(ob.json.checklist.items.find((i) => i.id === 'kkt').ok, true);
    const off = await h.request('PATCH', `/api/clubs/${club}/payment-settings`, { token: owner.token, body: { reception_enabled: false } });
    assert.equal(off.json.reception_enabled, false);
    ob = await h.request('GET', `/api/clubs/${club}/onboarding`, { token: owner.token });
    assert.deepEqual([ob.json.kkt_enabled, ob.json.checklist.items.find((i) => i.id === 'kkt').ok], [false, true]);
  });

  it('все пункты выполнены: live, журнал club.go_live, уведомление платформе, карточка каталога', async () => {
    const admin = await h.login(newPhone());
    await h.admin.query("insert into bl.platform_members (user_id, role) values ($1, 'platform_admin')", [admin.id]);
    await h.admin.query("insert into bl.cities (slug, name, timezone) values ('perm', 'Пермь', 'Asia/Yekaterinburg') on conflict (slug) do nothing");
    const put = await h.request('PUT', `/api/clubs/${club}/payment-settings/live`, { token: owner.token, body: { shop_id: SHOPS.live.shopId, secret_key: SHOPS.live.secret } });
    assert.equal(put.status, 200, put.text);
    h.fake.state.covers = true;
    h.fake.state.printedAt = new Date();
    try {
      const noOffer = await h.request('POST', `/api/clubs/${club}/go-live`, { token: owner.token, body: {} });
      assert.deepEqual(noOffer.json.failed, ['offer']);
      // Фискализацию в магазине выключили после сохранения — переход перепроверяет /v3/me.
      h.emu.config.down = true;
      const down = await h.request('POST', `/api/clubs/${club}/go-live`, { token: owner.token, body: { accept_offer: true } });
      assert.deepEqual(down.json.failed, ['shop_live']);
      h.emu.config.down = false;
      const r = await h.request('POST', `/api/clubs/${club}/go-live`, { token: owner.token, body: { accept_offer: true } });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.mode, 'live');
      const [c] = await h.q('select mode, went_live_at, offer_version, offer_accepted_by from bl.clubs where id = $1', [club]);
      assert.deepEqual([c.mode, Boolean(c.went_live_at), c.offer_version, c.offer_accepted_by], ['live', true, '2026-10-23', owner.id]);
      assert.equal((await h.q("select count(*)::int as n from bl.audit_log where club_id = $1 and action = 'club.go_live' and actor_id = $2", [club, owner.id]))[0].n, 1);
      const n = await h.q("select text from bl.notifications where user_id = $1 and kind = 'platform.club_live'", [admin.id]);
      assert.equal(n.length, 1);
      assert.match(n[0].text, /Луза.*боевой режим/);
      // Повтор — без изменений.
      assert.equal((await h.request('POST', `/api/clubs/${club}/go-live`, { token: owner.token, body: { accept_offer: true } })).json.mode, 'live');
      // Outbox: карточка каталога связана с клубом (status platform).
      const card = await h.waitFor(async () => (await h.q("select * from bl.club_public where club_id = $1 and status = 'platform'", [club]))[0]);
      assert.equal(card.name, 'Бильярд «Луза»');
      assert.equal(card.tables_count, 2);
      assert.deepEqual(card.disciplines, ['pool']);
      assert.ok((await h.q('select id from bl.public_clubs()')).some((x) => x.id === club));
      // Тестовые записи после перехода остаются тестовыми; новые — боевые.
      const [res] = await h.q('select id from bl.resources where club_id = $1 order by number limit 1', [club]);
      assert.equal((await insertPayment(club, res.id, owner.id)).is_test, false);
    } finally {
      h.emu.config.down = false;
    }
  });

  it('приостановка платформой: новая игра — 409 club_suspended; возобновление; не администратор — 403', async () => {
    const admin = await h.login(newPhone());
    await h.admin.query("insert into bl.platform_members (user_id, role) values ($1, 'platform_admin')", [admin.id]);
    const operator = await h.login(newPhone());
    await h.admin.query("insert into bl.platform_members (user_id, role) values ($1, 'platform_operator')", [operator.id]);
    assert.equal((await h.request('POST', `/api/platform/clubs/${club}/suspend`, { token: operator.token, body: { reason: 'x' } })).status, 403);
    assert.equal((await h.request('POST', `/api/platform/clubs/${club}/suspend`, { token: owner.token, body: { reason: 'x' } })).status, 403);
    assert.equal((await h.request('POST', `/api/platform/clubs/${club}/suspend`, { token: admin.token, body: {} })).json.error, 'reason_required');
    const s = await h.request('POST', `/api/platform/clubs/${club}/suspend`, { token: admin.token, body: { reason: 'Нарушение оферты' } });
    assert.equal(s.status, 200, s.text);
    assert.equal(s.json.mode, 'suspended');
    const [a] = await h.q("select actor_type, actor_id, reason from bl.audit_log where club_id = $1 and action = 'club.suspend'", [club]);
    assert.deepEqual([a.actor_type, a.actor_id, a.reason], ['support', admin.id, 'Нарушение оферты']);
    assert.equal((await h.q("select count(*)::int as n from bl.notifications where user_id = $1 and kind = 'club.suspended'", [owner.id]))[0].n, 1);
    // Гость не начинает новую игру.
    const guest = await h.login(newPhone());
    const [res] = await h.q('select id from bl.resources where club_id = $1 order by number limit 1', [club]);
    const q = await h.request('POST', '/api/quotes', { token: guest.token, body: { resource_id: res.id, kind: 'start', minutes: 60 } });
    assert.equal(q.status, 409);
    assert.equal(q.json.error, 'club_suspended');
    assert.ok(!(await h.q('select id from bl.public_clubs()')).some((x) => x.id === club));
    // Повтор — без изменений; возобновление — в прежний режим.
    assert.equal((await h.request('POST', `/api/platform/clubs/${club}/suspend`, { token: admin.token, body: { reason: 'ещё' } })).json.changed, false);
    const back = await h.request('POST', `/api/platform/clubs/${club}/resume`, { token: admin.token, body: { reason: 'Исправлено' } });
    assert.equal(back.json.mode, 'live');
    // Обратно в test — только через платформу.
    await h.request('POST', `/api/platform/clubs/${club}/suspend`, { token: admin.token, body: { reason: 'Перенастройка' } });
    const toTest = await h.request('POST', `/api/platform/clubs/${club}/resume`, { token: admin.token, body: { reason: 'Повторная проверка', mode: 'test' } });
    assert.equal(toTest.json.mode, 'test');
  });
});

describe('ККТ в тестовом режиме: нефискальный «ТЕСТ» (№153)', () => {
  it('чек тестового клуба уходит мосту с test: true и закрывается без ФД', async () => {
    const owner = await newOwner();
    const club = (await createClub(owner.token)).json.club_id;
    const { resourceId } = await addTable(club, 1);
    const p = await insertPayment(club, resourceId, owner.id);
    const items = [{ description: 'Игра, стол 1, 1 ч', quantity: 1, amount: { value: '500.00', currency: 'RUB' }, vat_code: 1, payment_mode: 'full_payment', payment_subject: 'service' }];
    const [r] = await h.q(
      `insert into bl.receipts (club_id, payment_id, kind, channel, status, amount_kopecks, items) values ($1, $2, 'sale', 'kkt', 'receipt_pending', 50000, $3::jsonb) returning id, is_test`,
      [club, p.id, JSON.stringify(items)],
    );
    assert.equal(r.is_test, true);
    const deps = { audit: h.app.ctx.audit, alarms: h.app.ctx.alarms, outbox: { enqueue: async () => {} }, log: h.log };
    const claimed = await withContext(h.pool, { clubId: club, actorType: 'system' }, (db) => claimJob(db, { clubId: club, connected: ['b1'], now: new Date(), deps }));
    assert.equal(claimed.job.test, true);
    assert.equal(claimed.job.request[0].type, 'nonFiscal');
    const res = await withContext(h.pool, { clubId: club, actorType: 'system' }, (db) =>
      applyResult(db, deps, { clubId: club, bridgeId: 'b1', msg: { uuid: claimed.job.uuid, outcome: 'done', test: true, fiscal: null }, now: new Date() }),
    );
    assert.equal(res.test, true);
    const [after] = await h.q('select status, fd, fiscal from bl.receipts where id = $1', [r.id]);
    assert.deepEqual([after.status, after.fd, after.fiscal.test], ['printed', null, true]);
    // Фискальные реквизиты у тестового чека невозможны.
    await assert.rejects(h.admin.query('update bl.receipts set fd = 1 where id = $1', [r.id]), /receipts_test_nonfiscal_check|fd is set once/);
  });

  it('смена ККТ в test не открывается; закрытие смены — нефискальный отчёт «ТЕСТ»', async () => {
    const owner = await newOwner();
    const club = (await createClub(owner.token)).json.club_id;
    const { resourceId } = await addTable(club, 1);
    const [shift] = await h.q(
      `insert into bl.shifts (club_id, number, opened_by, opened_at, float_kopecks) values ($1, 1, $2, now() - interval '2 hours', 0) returning id, is_test`,
      [club, owner.id],
    );
    assert.equal(shift.is_test, true);
    const p = await insertPayment(club, resourceId, owner.id, { confirmedAt: new Date(Date.now() - 30 * MIN) });
    assert.equal(p.is_test, true);
    const deps = { audit: h.app.ctx.audit, alarms: h.app.ctx.alarms, outbox: { enqueue: async () => {} }, log: h.log };
    const inClub = (fn) => withContext(h.pool, { clubId: club, actorType: 'system' }, fn);
    assert.equal(await inClub((db) => ensureOp(db, { clubId: club, kind: 'open_shift', shiftId: shift.id, operatorName: 'Анна', now: new Date() })), null);
    assert.equal((await h.q('select count(*)::int as n from bl.kkt_ops where club_id = $1', [club]))[0].n, 0, 'открытия смены ККТ нет');
    await h.admin.query(
      'update bl.shifts set closed_at = now(), closed_by = $2, actual_cash_kopecks = 0, expected_cash_kopecks = 0, discrepancy_kopecks = 0 where id = $1',
      [shift.id, owner.id],
    );
    const opId = await inClub((db) => ensureOp(db, { clubId: club, kind: 'close_shift', shiftId: shift.id, operatorName: 'Анна', now: new Date() }));
    assert.equal((await h.q('select is_test from bl.kkt_ops where id = $1', [opId]))[0].is_test, true);
    const claimed = await inClub((db) => claimJob(db, { clubId: club, connected: ['b1'], now: new Date(), deps }));
    assert.equal(claimed.job.kind, 'close_shift');
    assert.equal(claimed.job.test, true);
    const task = claimed.job.request[0];
    assert.equal(task.type, 'nonFiscal');
    const lines = task.items.map((x) => x.text);
    assert.equal(lines[0], 'ТЕСТ');
    assert.ok(lines.includes('Отчёт о закрытии смены. Не фискальный'));
    assert.ok(lines.includes('Смена №1'));
    assert.ok(lines.includes('Тестовых продаж: 1 на 500,00 ₽'));
    const res = await inClub((db) => applyResult(db, deps, { clubId: club, bridgeId: 'b1', msg: { uuid: claimed.job.uuid, outcome: 'done', test: true, fiscal: null }, now: new Date() }));
    assert.equal(res.done, true);
    const [op] = await h.q('select status, result from bl.kkt_ops where id = $1', [opId]);
    assert.equal(op.status, 'done');
    assert.equal(op.result.fd, undefined);
    const [a] = await h.q("select data from bl.audit_log where club_id = $1 and action = 'kkt.shift_close'", [club]);
    assert.equal(a.data.test, true);
    assert.equal(a.data.fd, null);
    // Задание открытия смены, оставшееся в очереди тестового клуба, не уходит на ККТ.
    await h.admin.query("insert into bl.kkt_ops (club_id, kind) values ($1, 'open_shift')", [club]);
    const none = await inClub((db) => claimJob(db, { clubId: club, connected: ['b1'], now: new Date(), deps }));
    assert.equal(none.none, true);
    assert.deepEqual((await h.q("select status from bl.kkt_ops where club_id = $1 and kind = 'open_shift'", [club])).map((x) => x.status), ['skipped']);
  });
});
