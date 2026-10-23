// Турнир с настоящими соседями (сквозной сценарий T24 и §5 «турнир»): plus (рейтинг и ник),
// money (взнос kind tournament через эмулятор ЮKassa, вебхук → payment.confirmed, возврат),
// light (удержание source tournament и свет без оплаты, №143, без MQTT — команды в bl.device_commands),
// plus по outbox tournament.match_finished засчитывает турнирную партию (×1,5).
//
// Пропускается, если у соседей ещё нет нужных функций (параллельная разработка M4).

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../../../http/app.mjs';
import { createOutbox } from '../../../outbox.mjs';
import { loadRoutes } from '../../../../api/router.mjs';
import { appPool, memoryLog, ORIGIN, testConfig } from '../../../test/db/helpers.mjs';
import { CLUB_A, createDb, player, STAFF, table, waitFor } from './harness.mjs';

const lightSvc = await import('../../../sessions/service.mjs');
const tournamentsApi = await import('../../api.mjs');
const moneyApi = await import('../../../payments/api.mjs');
const plusApi = await import('../../../plus/api.mjs').catch(() => null);
const ready =
  typeof lightSvc.createLightService === 'function' &&
  typeof moneyApi.createTournamentFee === 'function' &&
  typeof moneyApi.refundTournamentFee === 'function' &&
  typeof plusApi?.ratingOf === 'function';

let h = null;

async function start() {
  const { amountFor, amountForActual, pricesAround } = await import('../../../tariffs/index.mjs');
  const { createEmulator } = await import('../../../../tools/yookassa-emu/lib/emulator.mjs');
  const { loadMoneyConfig } = await import('../../../payments/config.mjs');
  const moneyModule = await import('../../../payments/index.mjs');
  const { provisionPayments } = await import('../../../payments/provision-dev.mjs');
  const plusModule = await import('../../../plus/index.mjs');
  const tournamentsModule = await import('../../index.mjs');

  const db = await createDb();
  const admin = db.pool;
  await admin.query("update bl.devices set device_key_enc = 'v1:test', last_seen_at = now()");
  const clock = { now: () => new Date() };
  const config = testConfig();
  const pool = appPool(db.url, { max: 20 });
  const log = memoryLog();
  const outbox = createOutbox({ pollMs: 50, clock });
  const sse = { publish() {}, closeAll() {}, setLogger() {} };

  const SHOP = { shopId: '760002', secret: `test_tr_${randomBytes(8).toString('hex')}` };
  await provisionPayments({
    client: admin,
    env: { YOOKASSA_EMU_SHOP_ID: SHOP.shopId, YOOKASSA_EMU_SECRET: SHOP.secret, SECRETS_ENC_KEY: config.encKey.toString('base64') },
  });
  await admin.query('update bl.club_payment_settings set sbp_enabled = true, card_enabled = true where club_id = $1', [CLUB_A]);
  const emu = createEmulator({ shops: [SHOP], webhookRetries: 3, webhookRetryDelayMs: 50 });
  const emuAddr = await emu.listen(0);
  const emuBase = `http://127.0.0.1:${emuAddr.port}`;
  emu.config.publicUrl = emuBase;
  const moneyConfig = loadMoneyConfig({ YOOKASSA_API_URL: `${emuBase}/v3`, PUBLIC_HOST: 'bl.test', NODE_ENV: 'test' }, { encKey: config.encKey });

  let light = null;
  const setupModule = {
    async init(ctx) {
      light = lightSvc.createLightService({
        log,
        clock,
        getBridge: () => ({ deviceInfo: () => ({ online: true }) }),
        deps: {
          audit: ctx.audit,
          outbox: ctx.outbox,
          alarms: ctx.alarms,
          notify: ctx.notify,
          sse,
          tariffs: { amountFor, amountForActual, pricesAround },
          payments: { refund: moneyApi.refund },
          bookings: { nextBookingStart: async () => null, nextBooking: async () => null },
          tournaments: { tournamentHolds: tournamentsApi.tournamentHolds, matchLightWindow: tournamentsApi.matchLightWindow },
        },
      });
      ctx.sessionsApi = {
        getResourceByCode: (d, code) => light.getResourceByCode(d, code),
        getResourceStatus: (d, id, o) => light.resourceStatus(d, id, o),
        holdPending: (d, a) => light.holdPending(d, a),
        releasePending: (d, a) => light.releasePending(d, a),
        getSessionForExtend: (d, a) => light.getSessionForExtend(d, a),
      };
      ctx.money = { config: moneyConfig };
      ctx.plusOptions = { tickMs: 0 };
      ctx.tournamentsOptions = { tickMs: 0, publishDelayMs: 10 };
      ctx.tournamentDeps = {
        light: {
          setReserved: (d, a) => light.setReserved(d, a),
          clearReserved: (d, a) => light.clearReserved(d, a),
          startFromTournament: (d, a) => light.startFromTournament(d, a),
          stopFromTournament: (d, a) => light.stopFromTournament(d, a),
        },
      };
    },
    async stop() {},
  };
  const routes = await loadRoutes({ config, only: ['auth.mjs', 'tournaments.mjs', 'payments.mjs', 'webhooks.mjs', 'quotes.mjs'] });
  const app = await createApp({
    config,
    log,
    pool,
    clock,
    modules: [
      { name: 'setup', module: setupModule },
      { name: 'money', module: moneyModule },
      { name: 'plus', module: plusModule },
      { name: 'tournaments', module: tournamentsModule },
    ],
    outbox,
    sse,
    routes,
  });
  await app.ctx.notify.stop?.();
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  emu.config.webhookUrl = `${base}/api/webhooks/yookassa/{club_id}`;

  async function request(method, path, { body, token, key } = {}) {
    const hd = { 'x-forwarded-for': `10.1.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}` };
    if (method !== 'GET') {
      hd['content-type'] = 'application/json';
      hd.origin = ORIGIN;
    }
    if (token) hd.authorization = `Bearer ${token}`;
    if (key) hd['idempotency-key'] = key;
    const res = await fetch(`${base}${path}`, { method, headers: hd, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, text };
  }
  const tokens = new Map();
  async function login(phone) {
    if (tokens.has(phone)) return tokens.get(phone);
    const r = await request('POST', '/api/auth/dev', { body: { phone } });
    assert.equal(r.status, 200, r.text);
    const c = await request('POST', '/api/auth/consent', { body: { version: config.consentVersion }, token: r.json.token });
    assert.equal(c.status, 200);
    const out = { token: r.json.token, id: r.json.user.id };
    tokens.set(phone, out);
    // Профиль Бильярдум+ (ник) — запись на турнир только с ним (№150).
    const nick = `${phone.startsWith('+7999') ? 'Игрок' : 'Штат'}${phone.slice(-4)}`;
    await admin.query('insert into bl.players (user_id, nick, created_at, updated_at) values ($1, $2, now(), now()) on conflict do nothing', [out.id, nick]);
    return out;
  }
  async function loginNoProfile(phone) {
    const r = await request('POST', '/api/auth/dev', { body: { phone } });
    assert.equal(r.status, 200, r.text);
    const c = await request('POST', '/api/auth/consent', { body: { version: config.consentVersion }, token: r.json.token });
    assert.equal(c.status, 200);
    return { token: r.json.token, id: r.json.user.id };
  }
  const q = async (sql, params) => (await admin.query(sql, params)).rows;
  return {
    request,
    login,
    loginNoProfile,
    q,
    async succeed(paymentId) {
      const [p] = await q('select provider_payment_id from bl.payments where id = $1', [paymentId]);
      const r = await fetch(`${emuBase}/__emu/payments/${p.provider_payment_id}/succeed?wait=1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 200);
      await emu.settle();
    },
    async drain() {
      await waitFor(async () => (await q("select count(*)::int as n from bl.outbox where processed_at is null and topic in ('payment.confirmed', 'tournament.refund', 'tournament.match_finished', 'money.tournament_refund')"))[0].n === 0, { timeoutMs: 15_000 });
    },
    async close() {
      await tournamentsModule.tournaments().service.flush().catch(() => {});
      const closed = new Promise((r) => server.close(r));
      server.closeAllConnections();
      await closed;
      await emu.settle();
      await app.stop();
      await pool.end();
      await emu.close();
      await db.drop();
    },
  };
}

describe('турнир с настоящими plus, money и light', { skip: ready ? false : 'соседи M4 ещё без нужных функций' }, () => {
  before(async () => {
    h = await start();
  });
  after(async () => {
    await h?.close();
  });

  it('T24 по настоящему рейтингу plus; взнос через ЮKassa; свет матча без оплаты; рейтинг ×1,5', async () => {
    const manager = await h.login(STAFF.manager);
    const now = Date.now();
    const body = {
      title: 'Кубок',
      discipline: 'pyramid',
      format: 'single_elim',
      race_to: 2,
      fee_kopecks: 50_000,
      places: 8,
      starts_at: new Date(now + 2 * 3600_000).toISOString(),
      ends_at: new Date(now + 8 * 3600_000).toISOString(),
      resource_ids: [table(1)],
      publish: true,
    };
    // T24: стартовый рейтинг plus 1 200 выше лимита 1 100.
    const limited = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments`, { token: manager.token, body: { ...body, title: 'До 1100', rating_limit: 1100 } });
    assert.equal(limited.status, 201, limited.text);
    const p1 = await h.login(player(1));
    let r = await h.request('POST', `/api/tournaments/${limited.json.id}/entries`, { token: p1.token, key: randomUUID(), body: {} });
    assert.equal(r.status, 409);
    assert.deepEqual(r.json, { error: 'rating_above_limit', limit: 1100, rating: 1200 });

    const t = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments`, { token: manager.token, body });
    assert.equal(t.status, 201, t.text);
    const tid = t.json.id;
    const players = [p1, await h.login(player(2)), await h.login(player(3))];
    const entries = [];
    for (const p of players) {
      r = await h.request('POST', `/api/tournaments/${tid}/entries`, { token: p.token, key: randomUUID(), body: { return_url: '/app/tournaments' } });
      assert.equal(r.status, 201, r.text);
      assert.equal(r.json.status, 'pending_payment');
      assert.ok(r.json.confirmation?.url);
      const [e] = await h.q('select * from bl.tournament_entries where id = $1', [r.json.entry_id]);
      const [pay] = await h.q("select * from bl.payments where entry_id = $1 and kind = 'tournament'", [e.id]);
      assert.equal(Number(pay.amount_kopecks), 50_000);
      assert.equal(pay.id, e.payment_id);
      await h.succeed(pay.id);
      entries.push(e.id);
    }
    await h.drain();
    const rows = await h.q('select status, paid_kopecks from bl.tournament_entries where tournament_id = $1 order by created_at', [tid]);
    assert.deepEqual(rows.map((x) => [x.status, Number(x.paid_kopecks)]), [
      ['confirmed', 50_000],
      ['confirmed', 50_000],
      ['confirmed', 50_000],
    ]);
    // Чек 54-ФЗ на взнос.
    const receipts = await h.q("select count(*)::int as n from bl.receipts r join bl.payments p on p.id = r.payment_id where p.tournament_id = $1 and r.kind = 'sale'", [tid]);
    assert.equal(receipts[0].n, 3);

    // Третий отменяет запись до закрытия — возврат целиком через money.
    r = await h.request('DELETE', `/api/tournaments/${tid}/entries/me`, { token: players[2].token });
    assert.equal(r.status, 200, r.text);
    await h.drain();
    const refunds = await h.q("select f.amount_kopecks from bl.refunds f join bl.payments p on p.id = f.payment_id where p.entry_id = $1 and f.status <> 'canceled'", [entries[2]]);
    assert.deepEqual(refunds.map((x) => Number(x.amount_kopecks)), [50_000]);

    // Старт: двое → финал на столе 1, удержание турнира и свет без платежа.
    r = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments/${tid}/start`, { token: manager.token });
    assert.equal(r.status, 200, r.text);
    const [m] = await h.q('select * from bl.tournament_matches where tournament_id = $1', [tid]);
    assert.equal(m.status, 'playing');
    assert.ok(m.session_id, 'свет матча включён');
    const [s] = await h.q('select * from bl.sessions where id = $1', [m.session_id]);
    assert.equal(s.source, 'tournament');
    assert.equal(s.match_id, m.id);
    assert.equal(s.payer_user_id, null);
    const cmds = await h.q("select type from bl.device_commands where club_id = $1 and type = 'session.start' order by created_at desc limit 1", [CLUB_A]);
    assert.equal(cmds[0]?.type, 'session.start');

    // Счёт: оба игрока, затем свет гаснет и plus засчитывает партию турнира.
    const byId = new Map(players.map((p) => [p.id, p]));
    r = await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: byId.get(m.user_a).token, body: { score_a: 2, score_b: 0 } });
    assert.equal(r.status, 200, r.text);
    r = await h.request('POST', `/api/tournaments/matches/${m.id}/confirm`, { token: byId.get(m.user_b).token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'done');
    await h.drain();
    const [s2] = await h.q('select status from bl.sessions where id = $1', [m.session_id]);
    assert.equal(s2.status, 'closed');
    const [tt] = await h.q('select status from bl.tournaments where id = $1', [tid]);
    assert.equal(tt.status, 'finished');
    const plusMatch = await h.q("select * from bl.matches where tournament_match_id = $1", [m.id]);
    assert.equal(plusMatch.length, 1);
    assert.equal(plusMatch[0].source, 'tournament');
    assert.equal(plusMatch[0].multiplier_x10, 15);
    const rA = await plusApi.ratingOf({ query: (...a) => h.q(...a).then((rows) => ({ rows })) }, { userId: m.user_a, discipline: 'pyramid' }).catch(() => null);
    if (rA) assert.ok(rA.rating > 1200, 'победитель получил рейтинг');
  });

  it('№150: без профиля Бильярдум+ — 409 no_profile по настоящему plus', async () => {
    const manager = await h.login(STAFF.manager);
    const now = Date.now();
    const t = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments`, {
      token: manager.token,
      body: { title: 'Без ника нельзя', discipline: 'pyramid', format: 'single_elim', race_to: 2, fee_kopecks: 0, places: 4, starts_at: new Date(now + 26 * 3600_000).toISOString(), ends_at: new Date(now + 30 * 3600_000).toISOString(), resource_ids: [table(3)], publish: true },
    });
    assert.equal(t.status, 201, t.text);
    const u = await h.loginNoProfile(player(9));
    const r = await h.request('POST', `/api/tournaments/${t.json.id}/entries`, { token: u.token, key: randomUUID(), body: {} });
    assert.deepEqual([r.status, r.json], [409, { error: 'no_profile' }]);
  });

  it('Д2: после отмены идущего турнира стол свободен сразу — QR даёт котировку', async () => {
    const manager = await h.login(STAFF.manager);
    const now = Date.now();
    const t = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments`, {
      token: manager.token,
      body: { title: 'Отменят', discipline: 'pyramid', format: 'single_elim', race_to: 2, fee_kopecks: 0, places: 2, match_minutes: 60, starts_at: new Date(now + 2 * 3600_000).toISOString(), ends_at: new Date(now + 6 * 3600_000).toISOString(), resource_ids: [table(2)], publish: true },
    });
    assert.equal(t.status, 201, t.text);
    const tid = t.json.id;
    for (const n of [11, 12]) {
      const p = await h.login(player(n));
      const r = await h.request('POST', `/api/tournaments/${tid}/entries`, { token: p.token, key: randomUUID(), body: {} });
      assert.equal(r.status, 201, r.text);
    }
    let r = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments/${tid}/start`, { token: manager.token });
    assert.equal(r.status, 200, r.text);
    const [m] = await h.q('select * from bl.tournament_matches where tournament_id = $1', [tid]);
    assert.equal(m.status, 'playing');
    assert.equal(m.resource_id, table(2));
    // В сиде у будней нет тарифа 06:00–12:00: тест идёт по настоящим часам — дополнить.
    await h.q(
      `insert into bl.tariff_rules (club_id, resource_type, days, start_local, end_local, price_per_hour, step_minutes, min_minutes, priority)
       select $1, 'billiard_pyramid', '{1,2,3,4,5,6,7}', '06:00', '12:00', 50000, 1, 30, 0
        where not exists (select 1 from bl.tariff_rules where club_id = $1 and resource_type = 'billiard_pyramid' and start_local = '06:00')`,
      [CLUB_A],
    );
    const guest = await h.login(player(13));
    const quote = () => h.request('POST', '/api/quotes', { token: guest.token, body: { resource_id: table(2), kind: 'start', minutes: 60 } });
    r = await quote();
    assert.equal(r.status, 409, 'матч идёт — стол турнира');
    assert.equal(r.json.error, 'table_busy');
    assert.equal(r.json.reason, 'tournament');
    r = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments/${tid}/cancel`, { token: manager.token, body: { reason: 'Отменили' } });
    assert.equal(r.status, 200, r.text);
    const [m2] = await h.q('select status from bl.tournament_matches where id = $1', [m.id]);
    assert.equal(m2.status, 'canceled');
    const [s] = await h.q('select status from bl.sessions where id = $1', [m.session_id]);
    assert.equal(s.status, 'closed', 'свет матча погашен');
    const holds = await h.q("select count(*)::int as n from bl.resource_holds where resource_id = $1 and released_at is null and until > now() and source = 'tournament'", [table(2)]);
    assert.equal(holds[0].n, 0, 'удержание турнира снято');
    r = await quote();
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.quote_id);
    assert.equal(r.json.extend_limit_until, null);
  });
});
