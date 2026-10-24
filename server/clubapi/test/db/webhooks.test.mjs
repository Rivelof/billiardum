// T46 (M5.7 №201): вебхуки клуба — регистрация владельцем (секрет один раз), SSRF-адреса
// отклоняются, события из outbox без ПДн, подпись HMAC-SHA256 `t.body`, повторы с ростом паузы
// до 24 часов и журнал доставок, DNS rebinding при доставке, выключение, тестовое событие,
// вебхуки не держат outbox (деньги и свет).

import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { formatTime } from '@billiardum/shared/format';
import { waitFor } from '../../../test/db/helpers.mjs';
import { httpsSend, RETRY_WINDOW_MS } from '../../deliver.mjs';
import { isPublicAddress } from '../../ssrf.mjs';
import { fakeLookup, HOOK_HOST, startReceiver } from '../helpers.mjs';
import { allKeys, CLUB, CLUB_B, startClubApi, T, testClock } from './harness.mjs';

const GUEST = 'a9000000-0000-4000-8000-0000000000f1';
const GUEST_PHONE = '+79991234567';
const GUEST_NAME = 'Иван Гостев';
const PUBLIC_IP = '93.184.216.34';

let t;
let rx;
const clock = testClock(new Date());
// Режим доставки теста: 'receiver' — на приёмник 127.0.0.1 (имя hooks.example.ru), 'real' — настоящая
// проверка IP при соединении (rebinding), 'hang' — получатель не отвечает.
let mode = 'receiver';
const hangs = [];
const lookup = fakeLookup((host) => {
  if (host === HOOK_HOST || host === 'rebind.example.ru') return [PUBLIC_IP];
  if (host === 'evil.example.ru') return ['10.0.0.5'];
  if (host === 'meta.example.ru') return ['169.254.169.254'];
  if (host === 'six.example.ru') return ['::1'];
  if (host === 'mapped.example.ru') return ['::ffff:127.0.0.1'];
  if (host === 'half.example.ru') return [PUBLIC_IP, '192.168.0.10'];
  return [];
});

async function send(args) {
  if (mode === 'hang') {
    return new Promise((resolve) => hangs.push(resolve));
  }
  if (mode === 'real') {
    // Имя при регистрации было публичным, при доставке — внутреннее: проверка в lookup соединения.
    return httpsSend({ ...args, lookup: fakeLookup({ 'rebind.example.ru': ['127.0.0.1'] }) });
  }
  const u = new URL(args.url);
  return httpsSend({
    ...args,
    url: `https://${HOOK_HOST}:${rx.port}${u.pathname}${u.search}`,
    ports: [rx.port],
    ca: rx.cert,
    lookup: fakeLookup({ [HOOK_HOST]: ['127.0.0.1'] }),
    // Только тест: свой приёмник на 127.0.0.1; в бою внутренние адреса не пускаются.
    isAllowed: (ip) => ip === '127.0.0.1' || isPublicAddress(ip),
  });
}

before(async () => {
  rx = await startReceiver({ replies: [200] });
  t = await startClubApi({ clock, lookup, send });
  await t.admin.query('insert into bl.users (id, phone, name) values ($1, $2, $3)', [GUEST, GUEST_PHONE, GUEST_NAME]);
});

after(async () => {
  mode = 'receiver';
  for (const h of hangs) h({ status: 200 });
  await t?.stop();
  await rx?.close();
});

beforeEach(() => {
  t.app.router.rateLimiter.clear();
  mode = 'receiver';
  rx.replies = [200];
});

async function createHook(events, url = `https://${HOOK_HOST}/bl/in?src=billiardum`, who = 'owner', club = CLUB) {
  const r = await t.as(who, 'POST', `/api/clubs/${club}/webhooks`, { url, events, description: 'CRM' });
  assert.equal(r.status, 201, r.text);
  return r.json;
}

/** Событие outbox клуба (как пишет модуль-источник) — от суперпользователя. */
async function emit(topic, payload, club = CLUB) {
  const { rows } = await t.admin.query('insert into bl.outbox (club_id, topic, payload) values ($1, $2, $3::jsonb) returning id', [club, topic, JSON.stringify({ club_id: club, ...payload })]);
  return Number(rows[0].id);
}

function verify(req, secret) {
  const t0 = req.headers['x-bl-timestamp'];
  const sig = req.headers['x-bl-signature'];
  const expected = createHmac('sha256', secret).update(`${t0}.${req.body}`).digest('hex');
  return sig === `v1=${expected}`;
}

async function deliveriesOf(hookId) {
  const r = await t.as('owner', 'GET', `/api/clubs/${CLUB}/webhooks/${hookId}/deliveries`);
  assert.equal(r.status, 200);
  return r.json.items;
}

describe('T46: регистрация и SSRF', () => {
  it('только владелец с личным входом; секрет показывается один раз; журнал без секрета', async () => {
    for (const who of ['manager', 'reception', 'ownerB']) {
      const r = await t.as(who, 'POST', `/api/clubs/${CLUB}/webhooks`, { url: `https://${HOOK_HOST}/x`, events: ['shift.closed'] });
      assert.equal(r.status, 403, who);
    }
    const h = await createHook(['shift.closed']);
    assert.match(h.secret, /^whsec_[A-Za-z0-9_-]{43}$/);
    assert.equal(h.host, HOOK_HOST);
    const list = await t.as('owner', 'GET', `/api/clubs/${CLUB}/webhooks`);
    assert.equal(list.status, 200);
    assert.ok(!list.text.includes(h.secret));
    assert.ok(!allKeys(list.json).has('secret') && !allKeys(list.json).has('secret_enc'));
    assert.deepEqual(list.json.events, ['session.started', 'session.ended', 'booking.created', 'booking.canceled', 'shift.closed']);
    const row = (await t.admin.query('select secret_enc from bl.webhooks where id = $1', [h.webhook_id])).rows[0];
    assert.ok(row.secret_enc.startsWith('v1:') && !row.secret_enc.includes(h.secret.slice(6)));
    const audit = (await t.admin.query("select data from bl.audit_log where action = 'webhook.create' and object_id = $1", [h.webhook_id])).rows;
    assert.deepEqual(audit[0].data, { webhook_id: h.webhook_id, host: HOOK_HOST, events: ['shift.closed'] });
    assert.ok(!JSON.stringify(audit).includes(h.secret.slice(6)));
    assert.equal((await t.as('owner', 'POST', `/api/clubs/${CLUB}/webhooks`, { url: `https://${HOOK_HOST}/x`, events: ['payment.confirmed'] })).status, 400);
    await t.as('owner', 'POST', `/api/clubs/${CLUB}/webhooks/${h.webhook_id}/disable`);
  });

  it('внутренние, локальные и зарезервированные адреса — 400 url_forbidden; не https:443 — url_invalid', async () => {
    const forbidden = [
      'https://127.0.0.1/hook', 'https://10.0.0.1/hook', 'https://10.255.255.1/', 'https://172.16.5.4/', 'https://192.168.1.1/',
      'https://169.254.169.254/latest/meta-data/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[::ffff:a9fe:a9fe]/',
      'https://[fd00::1]/', 'https://[fe80::1]/', 'https://0.0.0.0/', 'https://2130706433/', 'https://localhost/', 'https://db.internal/',
      'https://evil.example.ru/', 'https://meta.example.ru/', 'https://six.example.ru/', 'https://mapped.example.ru/', 'https://half.example.ru/',
    ];
    for (const url of forbidden) {
      t.app.router.rateLimiter.clear();
      const r = await t.as('owner', 'POST', `/api/clubs/${CLUB}/webhooks`, { url, events: ['shift.closed'] });
      assert.equal(r.status, 400, url);
      assert.deepEqual(r.json, { error: 'url_forbidden' }, url);
    }
    for (const url of ['http://hooks.example.ru/', `https://${HOOK_HOST}:8443/`, `https://${HOOK_HOST}:22/`, `https://user:pass@${HOOK_HOST}/`, 'https://nowhere.example.ru/', 'not a url', 'https:///x']) {
      t.app.router.rateLimiter.clear();
      const r = await t.as('owner', 'POST', `/api/clubs/${CLUB}/webhooks`, { url, events: ['shift.closed'] });
      assert.equal(r.status, 400, url);
      assert.deepEqual(r.json, { error: 'url_invalid' }, url);
    }
    assert.equal((await t.admin.query("select count(*)::int as n from bl.webhooks where club_id = $1 and url !~ $2", [CLUB, `^https://${HOOK_HOST.replace(/\./g, '\\.')}/`])).rows[0].n, 0);
  });
});

describe('T46: события, подпись, без ПДн', () => {
  it('session.started, session.ended, booking.created, booking.canceled, shift.closed — подписаны, без ПДн', async () => {
    const h = await createHook(['session.started', 'session.ended', 'booking.created', 'booking.canceled', 'shift.closed']);
    const now = clock.now();
    const sessionId = randomUUID();
    await t.admin.query(
      `insert into bl.sessions (id, club_id, resource_id, status, source, payer_user_id, started_at, paid_until, ended_at, close_reason, created_at, updated_at)
       values ($1, $2, $3, 'closed', 'qr', $4, $5, $6, $6, 'expired', $5, $6)`,
      [sessionId, CLUB, T(3), GUEST, new Date(now.getTime() - 3600_000), now],
    );
    const bookingId = randomUUID();
    await t.admin.query(
      `insert into bl.bookings (id, club_id, resource_id, user_id, guest_name, guest_phone, source, starts_at, ends_at, status, prepayment_mode, amount_kopecks, hold_minutes, created_at, updated_at, canceled_at, canceled_by, cancel_reason)
       values ($1, $2, $3, $4, $5, $6, 'phone', $7, $8, 'canceled', 'none', 80000, 15, $9, $9, $9, $10, $11)`,
      [bookingId, CLUB, T(4), GUEST, GUEST_NAME, GUEST_PHONE, new Date(now.getTime() + 86400_000), new Date(now.getTime() + 90000_000), now, 'a1000000-0000-4000-8000-000000000001', `звонил ${GUEST_PHONE}`],
    );
    const shiftId = randomUUID();
    await t.admin.query(
      `insert into bl.shifts (id, club_id, number, opened_by, opened_at, float_kopecks, closed_by, closed_at, cash_sales_kopecks, cash_refunds_kopecks, expected_cash_kopecks, actual_cash_kopecks, discrepancy_kopecks, close_comment)
       values ($1, $2, 77, $3, $4, 100000, $3, $5, 0, 0, 100000, 90000, -10000, $6)`,
      [shiftId, CLUB, 'a1000000-0000-4000-8000-000000000004', new Date(now.getTime() - 8 * 3600_000), now, `недостача, гость ${GUEST_NAME}`],
    );
    // Полезные нагрузки outbox как у модулей-источников (с user_id) — в вебхук не попадают.
    await emit('session.started', { session_id: sessionId, resource_id: T(3), paid_until: now.toISOString(), user_id: GUEST });
    await emit('session.closed', { session_id: sessionId, resource_id: T(3), started_at: new Date(now.getTime() - 3600_000).toISOString(), ended_at: now.toISOString(), reason: 'expired', unlimited: false, payer_user_id: GUEST });
    await emit('booking.created', { booking_id: bookingId, resource_id: T(4), user_id: GUEST, status: 'confirmed' });
    await emit('booking.canceled', { booking_id: bookingId, resource_id: T(4), user_id: GUEST, status: 'canceled', by: 'staff' });
    await emit('shift.closed', { shift_id: shiftId, number: 77, discrepancy_kopecks: -10000 });
    await waitFor(() => rx.requests.length >= 5, { timeoutMs: 10_000 });
    const got = Object.fromEntries(rx.requests.slice(-5).map((r) => [r.headers['x-bl-event'], r]));
    assert.deepEqual(Object.keys(got).sort(), ['booking.canceled', 'booking.created', 'session.ended', 'session.started', 'shift.closed']);
    for (const [event, req] of Object.entries(got)) {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/bl/in?src=billiardum');
      assert.equal(req.headers['content-type'], 'application/json; charset=utf-8');
      assert.ok(verify(req, h.secret), `${event}: подпись`);
      assert.ok(!verify(req, 'whsec_other'), `${event}: чужой секрет`);
      assert.ok(Math.abs(Number(req.headers['x-bl-timestamp']) - clock.now().getTime() / 1000) < 60);
      const body = JSON.parse(req.body);
      assert.equal(body.type, event);
      assert.equal(body.club_id, CLUB);
      assert.equal(body.id, req.headers['x-bl-event-id']);
      for (const s of [GUEST, GUEST_PHONE, GUEST_NAME, sessionId, '79991234567', 'a1000000-0000-4000-8000-000000000004', 'a1000000-0000-4000-8000-000000000001']) {
        assert.ok(!req.body.includes(s), `${event}: в теле ${s}`);
      }
      const keys = allKeys(body);
      for (const k of ['user_id', 'payer_user_id', 'session_id', 'guest_name', 'guest_phone', 'phone', 'name', 'cancel_reason', 'close_comment', 'opened_by', 'closed_by']) {
        assert.ok(!keys.has(k), `${event}: поле ${k}`);
      }
    }
    const started = JSON.parse(got['session.started'].body).data;
    const ended = JSON.parse(got['session.ended'].body).data;
    assert.equal(started.game_id, ended.game_id, 'одна игра — один game_id');
    assert.equal(started.resource_number, 3);
    assert.equal(ended.reason, 'expired');
    assert.equal(ended.played_minutes, 60);
    const canceled = JSON.parse(got['booking.canceled'].body).data;
    assert.deepEqual({ id: canceled.booking_id, by: canceled.canceled_by, source: canceled.source, n: canceled.resource_number }, { id: bookingId, by: 'staff', source: 'phone', n: 4 });
    const shift = JSON.parse(got['shift.closed'].body).data;
    assert.deepEqual({ n: shift.number, d: shift.discrepancy_kopecks }, { n: 77, d: -10000 });
    // Журнал доставок: доставлено с первой попытки.
    const items = await deliveriesOf(h.webhook_id);
    assert.equal(items.length, 5);
    assert.ok(items.every((d) => d.status === 'delivered' && d.attempts === 1 && d.http_status === 200 && d.log.length === 1));
    await t.as('owner', 'POST', `/api/clubs/${CLUB}/webhooks/${h.webhook_id}/disable`);
  });

  it('события чужого клуба и не выбранные события на адрес не идут', async () => {
    const h = await createHook(['shift.closed']);
    const hb = await createHook(['shift.closed'], `https://${HOOK_HOST}/club-b`, 'ownerB', CLUB_B);
    const before = rx.requests.length;
    const shiftB = randomUUID();
    await t.admin.query(
      `insert into bl.shifts (id, club_id, number, opened_by, opened_at, float_kopecks, closed_by, closed_at, cash_sales_kopecks, cash_refunds_kopecks, expected_cash_kopecks, actual_cash_kopecks, discrepancy_kopecks)
       values ($1, $2, 5, $3, now(), 0, $3, now(), 0, 0, 0, 0, 0)`,
      [shiftB, CLUB_B, 'a2000000-0000-4000-8000-000000000002'],
    );
    await emit('shift.closed', { shift_id: shiftB }, CLUB_B);
    await emit('booking.created', { booking_id: randomUUID() });
    await waitFor(() => rx.requests.length >= before + 1, { timeoutMs: 10_000 });
    await new Promise((r) => setTimeout(r, 500));
    const fresh = rx.requests.slice(before);
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].url, '/club-b');
    assert.equal(JSON.parse(fresh[0].body).club_id, CLUB_B);
    assert.equal((await deliveriesOf(h.webhook_id)).length, 0);
    // Журнал доставок клуба Б владельцу А не виден.
    assert.equal((await t.as('owner', 'GET', `/api/clubs/${CLUB}/webhooks/${hb.webhook_id}/deliveries`)).status, 404);
    assert.equal((await t.as('owner', 'GET', `/api/clubs/${CLUB_B}/webhooks/${hb.webhook_id}/deliveries`)).status, 403);
    await t.as('owner', 'POST', `/api/clubs/${CLUB}/webhooks/${h.webhook_id}/disable`);
    await t.as('ownerB', 'POST', `/api/clubs/${CLUB_B}/webhooks/${hb.webhook_id}/disable`);
  });

  it('тестовое событие ping: та же подпись, журнал доставок; на выключенный адрес — 409', async () => {
    const h = await createHook(['shift.closed']);
    const before = rx.requests.length;
    const r = await t.as('owner', 'POST', `/api/clubs/${CLUB}/webhooks/${h.webhook_id}/test`);
    assert.equal(r.status, 202);
    await waitFor(() => rx.requests.length > before, { timeoutMs: 10_000 });
    const req = rx.requests.at(-1);
    assert.equal(req.headers['x-bl-event'], 'ping');
    assert.equal(req.headers['x-bl-delivery'], r.json.delivery_id);
    assert.ok(verify(req, h.secret));
    const d = await waitFor(async () => (await deliveriesOf(h.webhook_id)).find((x) => x.delivery_id === r.json.delivery_id && x.status === 'delivered'));
    assert.equal(d.event, 'ping');
    await t.as('owner', 'POST', `/api/clubs/${CLUB}/webhooks/${h.webhook_id}/disable`);
    const again = await t.as('owner', 'POST', `/api/clubs/${CLUB}/webhooks/${h.webhook_id}/test`);
    assert.deepEqual([again.status, again.json], [409, { error: 'webhook_disabled' }]);
    assert.equal((await t.as('manager', 'POST', `/api/clubs/${CLUB}/webhooks/${h.webhook_id}/test`)).status, 403);
  });
});

describe('T46: повторы и журнал доставок', () => {
  it('500, 500, 200: повторы через 1 и 5 минут, каждая попытка подписана заново, журнал попыток', async () => {
    const h = await createHook(['shift.closed']);
    rx.replies = [500, 503, 200];
    const before = rx.requests.length;
    const r = await t.as('owner', 'POST', `/api/clubs/${CLUB}/webhooks/${h.webhook_id}/test`);
    await waitFor(async () => (await deliveriesOf(h.webhook_id)).find((x) => x.attempts === 1));
    let d = (await deliveriesOf(h.webhook_id)).find((x) => x.delivery_id === r.json.delivery_id);
    assert.equal(d.status, 'pending');
    assert.equal(d.http_status, 500);
    assert.equal(new Date(d.next_attempt_at).getTime() - new Date(d.last_attempt_at).getTime(), 60_000);
    // До срока повтора — ничего.
    await t.worker.tick();
    assert.equal(rx.requests.length, before + 1);
    clock.advance(61_000);
    await t.worker.tick();
    d = (await deliveriesOf(h.webhook_id)).find((x) => x.delivery_id === r.json.delivery_id);
    assert.equal(d.attempts, 2);
    assert.equal(d.http_status, 503);
    assert.equal(new Date(d.next_attempt_at).getTime() - new Date(d.last_attempt_at).getTime(), 5 * 60_000);
    clock.advance(5 * 60_000);
    await t.worker.tick();
    d = (await deliveriesOf(h.webhook_id)).find((x) => x.delivery_id === r.json.delivery_id);
    assert.equal(d.status, 'delivered');
    assert.deepEqual(d.log.map((a) => a.http_status), [500, 503, 200]);
    const reqs = rx.requests.slice(before);
    assert.equal(reqs.length, 3);
    assert.ok(reqs.every((q) => verify(q, h.secret)));
    assert.equal(new Set(reqs.map((q) => q.headers['x-bl-event-id'])).size, 1, 'одно событие');
    assert.equal(new Set(reqs.map((q) => q.headers['x-bl-timestamp'])).size, 3, 'подпись с новым временем');
    await t.as('owner', 'POST', `/api/clubs/${CLUB}/webhooks/${h.webhook_id}/disable`);
  });

  it('получатель не отвечает 2xx — повторы с ростом паузы до 24 часов, затем failed', async () => {
    const h = await createHook(['shift.closed']);
    rx.replies = [500];
    const start = clock.now().getTime();
    const r = await t.as('owner', 'POST', `/api/clubs/${CLUB}/webhooks/${h.webhook_id}/test`);
    await waitFor(async () => (await deliveriesOf(h.webhook_id)).find((x) => x.attempts === 1));
    for (let i = 0; i < 20; i += 1) {
      const d = (await deliveriesOf(h.webhook_id)).find((x) => x.delivery_id === r.json.delivery_id);
      if (d.status !== 'pending') break;
      clock.set(d.next_attempt_at);
      await t.worker.tick();
    }
    const d = (await deliveriesOf(h.webhook_id)).find((x) => x.delivery_id === r.json.delivery_id);
    assert.equal(d.status, 'failed');
    assert.equal(d.attempts, 10);
    assert.equal(d.next_attempt_at, null);
    const gaps = d.log.slice(1).map((a, i) => Math.round((new Date(a.at) - new Date(d.log[i].at)) / 60_000));
    assert.deepEqual(gaps, [1, 5, 15, 30, 60, 120, 240, 480, 489]);
    assert.equal(new Date(d.log.at(-1).at).getTime() - start, RETRY_WINDOW_MS);
    const list = await t.as('owner', 'GET', `/api/clubs/${CLUB}/webhooks`);
    const item = list.json.items.find((x) => x.webhook_id === h.webhook_id);
    assert.equal(item.failed, 1);
    assert.equal(item.last_delivery.status, 'failed');
    await t.as('owner', 'POST', `/api/clubs/${CLUB}/webhooks/${h.webhook_id}/disable`);
  });

  it('вебхук перешёл в failed — одно уведомление владельцу со ссылкой на журнал, повтор не раньше чем через сутки', async () => {
    const h = await createHook(['shift.closed']);
    rx.replies = [500];
    const notes = async () => (await t.admin.query("select user_id, kind, level, text, data, actions from bl.notifications where kind = 'webhook.failing' and data->>'webhook_id' = $1 order by created_at", [h.webhook_id])).rows;
    const exhaust = async (ids) => {
      for (let i = 0; i < 30; i += 1) {
        const items = (await deliveriesOf(h.webhook_id)).filter((x) => ids.includes(x.delivery_id));
        const pending = items.filter((x) => x.status === 'pending' && x.attempts > 0);
        if (items.every((x) => x.status === 'failed')) return;
        if (pending.length === items.length) {
          clock.set(Math.max(...pending.map((x) => new Date(x.next_attempt_at).getTime())));
        }
        await t.worker.tick();
      }
      throw new Error('доставки не дошли до failed');
    };
    // Два события одновременно — оба failed в один момент: уведомление одно.
    const a = await t.as('owner', 'POST', `/api/clubs/${CLUB}/webhooks/${h.webhook_id}/test`);
    const b = await t.as('owner', 'POST', `/api/clubs/${CLUB}/webhooks/${h.webhook_id}/test`);
    const since = clock.now();
    await waitFor(async () => (await deliveriesOf(h.webhook_id)).filter((x) => x.attempts >= 1).length === 2);
    await exhaust([a.json.delivery_id, b.json.delivery_id]);
    let n = await notes();
    assert.equal(n.length, 1);
    assert.equal(n[0].user_id, 'a1000000-0000-4000-8000-000000000001');
    assert.equal(n[0].level, 'important');
    assert.ok(n[0].text.startsWith(`Вебхук ${HOOK_HOST} не принимает события с `), n[0].text);
    assert.ok(n[0].text.includes(formatTime(since, 'Asia/Yekaterinburg')), n[0].text);
    assert.ok(!n[0].text.includes('/bl/in'), 'путь адреса (возможные токены) — не в тексте');
    assert.deepEqual(n[0].actions, [{ id: 'open', title: 'Журнал доставок', url: `/club/api/webhooks/${h.webhook_id}` }]);
    assert.equal((await t.admin.query("select count(*)::int as n from bl.alarms where type like 'webhook%'")).rows[0].n, 0, 'не тревога');
    // Через сутки после первого уведомления — следующее.
    const c = await t.as('owner', 'POST', `/api/clubs/${CLUB}/webhooks/${h.webhook_id}/test`);
    await waitFor(async () => (await deliveriesOf(h.webhook_id)).find((x) => x.delivery_id === c.json.delivery_id && x.attempts >= 1));
    await exhaust([c.json.delivery_id]);
    n = await notes();
    assert.equal(n.length, 2);
    await t.as('owner', 'POST', `/api/clubs/${CLUB}/webhooks/${h.webhook_id}/disable`);
  });

  it('DNS rebinding: адрес был публичным при регистрации — при доставке внутренний, соединения нет (url_forbidden)', async () => {
    const h = await createHook(['shift.closed'], 'https://rebind.example.ru/hook');
    mode = 'real';
    const before = rx.connections;
    const r = await t.as('owner', 'POST', `/api/clubs/${CLUB}/webhooks/${h.webhook_id}/test`);
    const d = await waitFor(async () => (await deliveriesOf(h.webhook_id)).find((x) => x.delivery_id === r.json.delivery_id && x.attempts === 1));
    assert.equal(d.error, 'url_forbidden');
    assert.equal(d.http_status, null);
    assert.equal(d.status, 'pending');
    assert.equal(rx.connections, before);
    await t.as('owner', 'POST', `/api/clubs/${CLUB}/webhooks/${h.webhook_id}/disable`);
  });

  it('выключение адреса отменяет доставки в очереди; повтор выключения — тот же ответ', async () => {
    const h = await createHook(['shift.closed']);
    rx.replies = [500];
    const r = await t.as('owner', 'POST', `/api/clubs/${CLUB}/webhooks/${h.webhook_id}/test`);
    await waitFor(async () => (await deliveriesOf(h.webhook_id)).find((x) => x.attempts === 1));
    const off = await t.as('owner', 'POST', `/api/clubs/${CLUB}/webhooks/${h.webhook_id}/disable`);
    assert.equal(off.status, 200);
    assert.equal(off.json.active, false);
    const d = (await deliveriesOf(h.webhook_id)).find((x) => x.delivery_id === r.json.delivery_id);
    assert.equal(d.status, 'canceled');
    const again = await t.as('owner', 'POST', `/api/clubs/${CLUB}/webhooks/${h.webhook_id}/disable`);
    assert.equal(again.json.disabled_at, off.json.disabled_at);
    assert.equal((await t.admin.query("select count(*)::int as n from bl.audit_log where action = 'webhook.disable' and object_id = $1", [h.webhook_id])).rows[0].n, 1);
  });

  it('зависший получатель не держит outbox: событие обработано сразу, доставка ждёт в своей очереди', async () => {
    const h = await createHook(['shift.closed']);
    mode = 'hang';
    const shiftId = randomUUID();
    await t.admin.query('insert into bl.shifts (id, club_id, number, opened_by, opened_at, float_kopecks, closed_by, closed_at, cash_sales_kopecks, cash_refunds_kopecks, expected_cash_kopecks, actual_cash_kopecks, discrepancy_kopecks) values ($1, $2, 88, $3, now(), 0, $3, now(), 0, 0, 0, 0, 0)', [shiftId, CLUB, 'a1000000-0000-4000-8000-000000000004']);
    const id1 = await emit('shift.closed', { shift_id: shiftId });
    await waitFor(() => hangs.length >= 1, { timeoutMs: 10_000 });
    const id2 = await emit('shift.closed', { shift_id: shiftId });
    const id3 = await emit('session.started', { session_id: randomUUID() });
    await waitFor(async () => (await t.admin.query('select count(*)::int as n from bl.outbox where id = any($1::bigint[]) and processed_at is not null', [[id1, id2, id3]])).rows[0].n === 3, { timeoutMs: 10_000 });
    mode = 'receiver';
    await t.as('owner', 'POST', `/api/clubs/${CLUB}/webhooks/${h.webhook_id}/disable`);
    for (const resolve of hangs.splice(0)) resolve({ status: 200 });
  });
});
