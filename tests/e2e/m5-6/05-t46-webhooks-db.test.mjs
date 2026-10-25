// T46 «Вебхуки»: настоящая доставка, подпись по примерам документации (Node.js и Python — дословно
// из docs/api/club-api-v1.md), повторы с ростом паузы до 24 часов и журнал доставок, без ПДн.
// Локально, на СВОЁМ временном Postgres: на стенде внешнего DNS нет, а внутренний адрес приёмника
// отклоняется по замыслу (SSRF).
//
// Приложение — настоящие маршруты core + clubapi и модуль clubapi (outbox → очередь → воркер) с
// подставными часами. Подменены только: DNS при регистрации (имя → публичный адрес) и адрес
// соединения при доставке — на свой HTTPS-приёмник 127.0.0.1 (как в server/clubapi/test/db).
//
//   DATABASE_ADMIN_URL=postgres://postgres@127.0.0.1:<порт>/postgres \
//     node --test --test-concurrency=1 tests/e2e/m5-6/05-t46-webhooks-db.test.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const SKIP = process.env.DATABASE_ADMIN_URL ? false : 'нужен DATABASE_ADMIN_URL своего временного Postgres';
const HOST = 'crm.e2e-club.ru';
const PUBLIC_IP = '95.213.4.4';
const GUEST = 'a9000000-0000-4000-8000-0000000000c7';
const GUEST_PHONE = '+79997654321';
const GUEST_NAME = 'Пётр Секретов';

let t;
let H; // модули
let rx;
const clock = { ms: Date.now(), now: () => new Date(clock.ms), advance: (d) => (clock.ms += d), set: (d) => (clock.ms = new Date(d).getTime()) };

// Проверка подписи — ДОСЛОВНО пример Node.js из docs/api/club-api-v1.md («Проверка подписи»),
// SECRET и Date.now() — параметрами (в примере — из окружения и часов процесса).
function docVerify(SECRET, headers, rawBody, now = Date.now()) {
  const t = headers['x-bl-timestamp'];
  const sig = String(headers['x-bl-signature'] ?? '');
  if (!/^\d+$/.test(t ?? '') || Math.abs(now / 1000 - Number(t)) > 300) return false;
  const expected = `v1=${createHmac('sha256', SECRET).update(`${t}.${rawBody}`).digest('hex')}`;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Пример Python из документации — дословно функция verify; time.time() подменяется временем подписи.
const PY = `
import hashlib
import hmac
import json
import os
import sys
import time

SECRET = os.environ["BL_WEBHOOK_SECRET"].encode()  # whsec_…


def verify(headers: dict, raw_body: bytes) -> bool:
    t = headers.get("X-Bl-Timestamp", "")
    sig = headers.get("X-Bl-Signature", "")
    if not t.isdigit() or abs(time.time() - int(t)) > 300:
        return False
    mac = hmac.new(SECRET, t.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, "v1=" + mac)


cases = json.load(open(sys.argv[1]))
out = []
for c in cases:
    _now = c["now"]
    time.time = lambda: _now
    out.append(verify(c["headers"], c["body"].encode()))
print(json.dumps(out))
`;

/** Свой приёмник HTTPS: отвечает по очереди replies, пишет сырые запросы. */
async function receiver() {
  const tls = H.selfSigned(HOST);
  const st = { requests: [], replies: [200] };
  const srv = https.createServer(tls, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      st.requests.push({ at: clock.ms, method: req.method, url: req.url, headers: req.headers, raw: Buffer.concat(chunks) });
      const s = st.replies.length > 1 ? st.replies.shift() : st.replies[0];
      res.writeHead(s);
      res.end('ok');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return Object.assign(st, { port: srv.address().port, cert: tls.cert, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) });
}

before(async () => {
  if (SKIP) return;
  H = {
    ...(await import('../../../server/clubapi/test/db/harness.mjs')),
    ...(await import('../../../server/clubapi/test/helpers.mjs')),
    ...(await import('../../../server/clubapi/deliver.mjs')),
    ...(await import('../../../server/clubapi/ssrf.mjs')),
    waitFor: (await import('../../../server/test/db/helpers.mjs')).waitFor,
  };
  rx = await receiver();
  const lookup = H.fakeLookup((host) => (host === HOST ? [PUBLIC_IP] : []));
  const send = (args) => {
    const u = new URL(args.url);
    assert.equal(u.hostname, HOST, 'доставка — на зарегистрированный адрес');
    return H.httpsSend({
      ...args,
      url: `https://${HOST}:${rx.port}${u.pathname}${u.search}`,
      ports: [rx.port],
      ca: rx.cert,
      lookup: H.fakeLookup({ [HOST]: ['127.0.0.1'] }),
      isAllowed: (ip) => ip === '127.0.0.1' || H.isPublicAddress(ip), // только тест: свой приёмник
    });
  };
  t = await H.startClubApi({ clock, lookup, send });
  await t.admin.query('insert into bl.users (id, phone, name) values ($1, $2, $3)', [GUEST, GUEST_PHONE, GUEST_NAME]);
});

after(async () => {
  await t?.stop();
  await rx?.close();
});

const deliveries = async (hookId) => (await t.as('owner', 'GET', `/api/clubs/${H.CLUB}/webhooks/${hookId}/deliveries?limit=200`)).json.items;
async function hook(events, suffix = 'in') {
  t.app.router.rateLimiter.clear();
  const r = await t.as('owner', 'POST', `/api/clubs/${H.CLUB}/webhooks`, { url: `https://${HOST}/bl/${suffix}?token=rcv-path-secret`, events, description: 'E2E CRM' });
  assert.equal(r.status, 201, r.text);
  return r.json;
}
async function emit(topic, payload) {
  const { rows } = await t.admin.query('insert into bl.outbox (club_id, topic, payload) values ($1, $2, $3::jsonb) returning id', [H.CLUB, topic, JSON.stringify({ club_id: H.CLUB, ...payload })]);
  return Number(rows[0].id);
}
function pyVerify(secret, cases) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bl-e2e-py-'));
  try {
    writeFileSync(path.join(dir, 'verify.py'), PY);
    writeFileSync(path.join(dir, 'cases.json'), JSON.stringify(cases));
    const out = execFileSync('python3', ['-I', path.join(dir, 'verify.py'), path.join(dir, 'cases.json')], { env: { BL_WEBHOOK_SECRET: secret, PATH: process.env.PATH }, encoding: 'utf8' });
    return JSON.parse(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
/** Заголовки как у Flask request.headers (с большой буквы) для примера Python. */
const flask = (h) => ({ 'X-Bl-Timestamp': h['x-bl-timestamp'], 'X-Bl-Signature': h['x-bl-signature'] });

describe('T46: доставка, подпись по документации, без ПДн', { skip: SKIP }, () => {
  it('события игры, брони, смены и ping доходят; подпись сходится с примерами Node.js и Python; подделки — нет', async (tt) => {
    const h = await hook(['session.started', 'session.ended', 'booking.created', 'booking.canceled', 'shift.closed']);
    const secret = h.secret;
    const sid = randomUUID();
    const started = new Date(clock.ms - 30 * 60_000);
    await t.admin.query(
      `insert into bl.sessions (id, club_id, resource_id, status, source, payer_user_id, started_at, paid_until, ended_at, close_reason, created_at, updated_at)
       values ($1, $2, $3, 'closed', 'qr', $4, $5, $6, $6, 'stopped', $5, $6)`,
      [sid, H.CLUB, H.T(3), GUEST, started, new Date(clock.ms)],
    );
    // Своя бронь (с именем и телефоном гостя) и своя закрытая смена (комментарий с именем гостя).
    const bk = randomUUID();
    await t.admin.query(
      `insert into bl.bookings (id, club_id, resource_id, user_id, guest_name, guest_phone, source, starts_at, ends_at, status, prepayment_mode, amount_kopecks, hold_minutes, created_at, updated_at, canceled_at, canceled_by, cancel_reason)
       values ($1, $2, $3, $4, $5, $6, 'app', $7, $8, 'canceled', 'none', 120000, 15, $9, $9, $9, $10, $11)`,
      [bk, H.CLUB, H.T(5), GUEST, GUEST_NAME, GUEST_PHONE, new Date(clock.ms + 2 * 86400_000), new Date(clock.ms + 2 * 86400_000 + 5400_000), new Date(clock.ms), GUEST, `передумал ${GUEST_PHONE}`],
    );
    const sh = randomUUID();
    await t.admin.query(
      `insert into bl.shifts (id, club_id, number, opened_by, opened_at, float_kopecks, closed_by, closed_at, cash_sales_kopecks, cash_refunds_kopecks, expected_cash_kopecks, actual_cash_kopecks, discrepancy_kopecks, close_comment)
       values ($1, $2, 901, $3, $4, 200000, $3, $5, 0, 0, 200000, 199500, -500, $6)`,
      [sh, H.CLUB, 'a1000000-0000-4000-8000-000000000004', new Date(clock.ms - 6 * 3600_000), new Date(clock.ms), `гость ${GUEST_NAME} ${GUEST_PHONE}`],
    );
    const before = rx.requests.length;
    // Полезные нагрузки как у модулей-источников — с ПДн, которые не должны дойти.
    await emit('session.started', { session_id: sid, user_id: GUEST, phone: GUEST_PHONE, name: GUEST_NAME, paid_until: new Date(clock.ms).toISOString() });
    await emit('session.closed', { session_id: sid, user_id: GUEST, phone: GUEST_PHONE, reason: 'stopped', ended_at: new Date(clock.ms).toISOString() });
    if (bk) {
      await emit('booking.created', { booking_id: bk, user_id: GUEST, phone: GUEST_PHONE, guest_name: GUEST_NAME });
      await emit('booking.canceled', { booking_id: bk, by: 'guest', user_id: GUEST, phone: GUEST_PHONE });
    }
    if (sh) await emit('shift.closed', { shift_id: sh, user_id: GUEST });
    await emit('payment.confirmed', { payment_id: randomUUID(), user_id: GUEST }); // не событие вебхука
    const want = 2 + (bk ? 2 : 0) + (sh ? 1 : 0);
    await H.waitFor(async () => (await deliveries(h.webhook_id)).length >= want, { timeoutMs: 10_000 });
    t.app.router.rateLimiter.clear();
    const p = await t.as('owner', 'POST', `/api/clubs/${H.CLUB}/webhooks/${h.webhook_id}/test`);
    assert.equal(p.status, 202, p.text);
    await t.worker.tick();
    await H.waitFor(() => rx.requests.length - before >= want + 1, { timeoutMs: 10_000 });
    const got = rx.requests.slice(before);
    assert.equal(got.length, want + 1);
    const types = got.map((r) => r.headers['x-bl-event']).sort();
    assert.deepEqual(types, [...['session.started', 'session.ended', 'ping'], ...(bk ? ['booking.created', 'booking.canceled'] : []), ...(sh ? ['shift.closed'] : [])].sort());
    const pyCases = [];
    for (const r of got) {
      const raw = r.raw.toString('utf8');
      const body = JSON.parse(raw);
      const ts = Number(r.headers['x-bl-timestamp']);
      assert.equal(r.method, 'POST');
      assert.equal(r.url, '/bl/in?token=rcv-path-secret', 'путь и запрос адреса — как зарегистрированы');
      assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(r.headers['x-bl-event'], body.type);
      assert.equal(r.headers['x-bl-event-id'], body.id);
      assert.match(r.headers['x-bl-delivery'], /^[0-9a-f-]{36}$/);
      assert.match(r.headers['x-bl-signature'], /^v1=[0-9a-f]{64}$/);
      assert.equal(body.club_id, H.CLUB);
      assert.equal(typeof body.test, 'boolean');
      assert.ok(docVerify(secret, r.headers, raw, ts * 1000), `подпись ${body.type} — пример Node.js`);
      assert.ok(!docVerify(secret, r.headers, raw.replace('"club_id"', '"club_ld"'), ts * 1000), 'изменённое тело');
      assert.ok(!docVerify(secret, { ...r.headers, 'x-bl-timestamp': String(ts - 1) }, raw, ts * 1000), 'чужое время');
      assert.ok(!docVerify(`${secret}x`, r.headers, raw, ts * 1000), 'чужой секрет');
      assert.ok(!docVerify(secret, r.headers, raw, (ts + 301) * 1000), 'старше 5 минут');
      assert.ok(!raw.includes(GUEST_PHONE) && !raw.includes(GUEST_PHONE.slice(2)) && !raw.includes(GUEST_NAME) && !raw.includes(GUEST), `без ПДн: ${raw}`);
      assert.ok(!raw.includes(sid), 'без id игры');
      assert.ok(!JSON.stringify(r.headers).includes(secret.slice(6)), 'секрет не в заголовках');
      pyCases.push({ headers: flask(r.headers), body: raw, now: ts }, { headers: flask(r.headers), body: `${raw} `, now: ts }, { headers: flask(r.headers), body: raw, now: ts + 400 });
    }
    const py = pyVerify(secret, pyCases);
    assert.deepEqual(py, got.flatMap(() => [true, false, false]), 'пример Python: подлинные — True, изменённое тело и старое время — False');
    const st = got.find((r) => r.headers['x-bl-event'] === 'session.started');
    const en = got.find((r) => r.headers['x-bl-event'] === 'session.ended');
    const sb = JSON.parse(st.raw);
    const eb = JSON.parse(en.raw);
    assert.equal(sb.data.game_id, eb.data.game_id, 'game_id одной игры совпадает');
    assert.notEqual(sb.data.game_id, sid);
    assert.deepEqual(Object.keys(eb.data).sort(), ['booking_id', 'ended_at', 'game_id', 'played_minutes', 'reason', 'resource_id', 'resource_number', 'source', 'started_at', 'unlimited'].sort());
    assert.equal(eb.data.played_minutes, 30);
    assert.equal(eb.data.reason, 'stopped');
    const bc = JSON.parse(got.find((r) => r.headers['x-bl-event'] === 'booking.canceled').raw).data;
    assert.deepEqual([bc.booking_id, bc.canceled_by, bc.source, bc.resource_number, bc.status], [bk, 'guest', 'app', 5, 'canceled']);
    const sc = JSON.parse(got.find((r) => r.headers['x-bl-event'] === 'shift.closed').raw).data;
    assert.deepEqual(Object.keys(sc).sort(), ['closed_at', 'discrepancy_kopecks', 'number', 'opened_at', 'shift_id']);
    assert.deepEqual([sc.number, sc.discrepancy_kopecks], [901, -500]);
    for (const r of got) assert.ok(!r.raw.toString().includes('a1000000-0000-4000-8000-000000000004'), 'без id сотрудника');
    // Все попытки — в журнале доставок со статусом delivered.
    const ds = await deliveries(h.webhook_id);
    assert.ok(ds.every((d) => d.status === 'delivered' && d.attempts === 1 && d.http_status === 200));
    tt.diagnostic(`доставлено ${got.length}: ${types.join(', ')}; подпись: Node.js-пример — ок, Python-пример (python3) — ${py.filter(Boolean).length} из ${got.length} подлинных True, ${py.length - got.length} подделок False; ПДн гостя, user_id и session_id в телах нет; game_id начала = конца; payment.confirmed не шлётся`);
  });
});

describe('T46: повторы с ростом паузы до 24 часов, журнал, уведомление владельцу', { skip: SKIP }, () => {
  it('500, 503, 200: повтор через 1 и 5 минут, каждая попытка подписана своим временем, один X-Bl-Event-Id', async (tt) => {
    const h = await hook(['shift.closed'], 'retry');
    rx.replies = [500, 503, 200];
    const before = rx.requests.length;
    t.app.router.rateLimiter.clear();
    const p = await t.as('owner', 'POST', `/api/clubs/${H.CLUB}/webhooks/${h.webhook_id}/test`);
    assert.equal(p.status, 202);
    await t.worker.tick();
    let d = (await deliveries(h.webhook_id))[0];
    assert.deepEqual([d.status, d.attempts, d.http_status, d.error], ['pending', 1, 500, 'http']);
    assert.equal(new Date(d.next_attempt_at) - new Date(d.last_attempt_at), 60_000);
    clock.advance(30_000);
    await t.worker.tick();
    assert.equal(rx.requests.length - before, 1, 'до срока повтора — тихо');
    clock.advance(31_000);
    await t.worker.tick();
    d = (await deliveries(h.webhook_id))[0];
    assert.deepEqual([d.attempts, d.http_status], [2, 503]);
    assert.equal(new Date(d.next_attempt_at) - new Date(d.last_attempt_at), 5 * 60_000);
    clock.advance(5 * 60_000);
    await t.worker.tick();
    d = (await deliveries(h.webhook_id))[0];
    assert.equal(d.status, 'delivered');
    assert.deepEqual(d.log.map((x) => [x.attempt, x.http_status, x.error]), [[1, 500, 'http'], [2, 503, 'http'], [3, 200, null]]);
    const reqs = rx.requests.slice(before);
    assert.equal(new Set(reqs.map((r) => r.headers['x-bl-event-id'])).size, 1);
    assert.equal(new Set(reqs.map((r) => r.headers['x-bl-delivery'])).size, 1);
    assert.equal(new Set(reqs.map((r) => r.headers['x-bl-timestamp'])).size, 3);
    assert.ok(reqs.every((r) => docVerify(h.secret, r.headers, r.raw.toString('utf8'), Number(r.headers['x-bl-timestamp']) * 1000)));
    rx.replies = [200];
    tt.diagnostic(`журнал: ${d.log.map((x) => `#${x.attempt} ${x.http_status}`).join(', ')}; паузы 1 и 5 мин; подпись каждой попытки сходится, X-Bl-Timestamp свой, X-Bl-Event-Id один`);
  });

  it('получатель всегда 500: попытки через 1, 5, 15, 30 мин, 1, 2, 4, 8 ч и последняя ровно через 24 ч, затем failed; владельцу одно уведомление без пути адреса', async (tt) => {
    const h = await hook(['shift.closed'], 'dead');
    rx.replies = [500];
    const before = rx.requests.length;
    t.app.router.rateLimiter.clear();
    const created = clock.ms;
    await t.as('owner', 'POST', `/api/clubs/${H.CLUB}/webhooks/${h.webhook_id}/test`);
    await t.worker.tick();
    for (let i = 0; i < 30; i += 1) {
      const d = (await deliveries(h.webhook_id))[0];
      if (d.status !== 'pending') break;
      clock.set(d.next_attempt_at);
      await t.worker.tick();
    }
    const d = (await deliveries(h.webhook_id))[0];
    assert.equal(d.status, 'failed');
    const offs = rx.requests.slice(before).map((r) => Math.round((r.at - created) / 60_000));
    assert.deepEqual(offs, [0, 1, 6, 21, 51, 111, 231, 471, 951, 1440], `минуты попыток от события: ${offs.join(', ')}`);
    assert.equal(d.attempts, 10);
    assert.equal(d.log.length, 10);
    const notes = (await t.admin.query("select user_id, level, text, data from bl.notifications where kind = 'webhook.failing' and data->>'webhook_id' = $1", [h.webhook_id])).rows;
    assert.equal(notes.length, 1, 'одно уведомление');
    assert.equal(notes[0].level, 'important');
    assert.ok(notes[0].text.includes(HOST), notes[0].text);
    assert.ok(!notes[0].text.includes('rcv-path-secret') && !notes[0].text.includes('/bl/dead'), 'без пути и запроса адреса');
    const alarms = (await t.admin.query("select count(*)::int as n from bl.alarms where club_id = $1 and type like 'webhook%'", [H.CLUB])).rows[0].n;
    assert.equal(alarms, 0, 'не тревога');
    rx.replies = [200];
    tt.diagnostic(`попытки (мин от события): ${offs.join(', ')} → failed; уведомление владельцу 1 (important): «${notes[0].text}»`);
  });
});
