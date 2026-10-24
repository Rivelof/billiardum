// Модуль clubapi без базы (M5.7, T46): адреса SSRF, проверка адреса вебхука и IP при соединении
// (DNS rebinding), отказ от редиректов, подпись, расписание повторов, псевдоним игры, ключи.

import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { deliveryHeaders, errorCode, httpsSend, nextAttemptAt, RETRY_WINDOW_MS, sign } from '../deliver.mjs';
import { keyFromHeader, keyHash, keyPepper, newKey } from '../keys.mjs';
import { checkUrlSyntax, isPublicAddress, parseIPv6, safeLookup, validateWebhookUrl } from '../ssrf.mjs';
import { gameId, gamePepper } from '../webhooks.mjs';
import { badCursors, fakeLookup, HOOK_HOST, startReceiver } from './helpers.mjs';
import { decodeCursor, encodeCursor, isIsoTime } from '../cursor.mjs';

const BLOCKED = [
  '127.0.0.1', '127.255.255.254', '10.0.0.1', '10.255.1.2', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
  '100.64.0.1', '0.0.0.0', '0.1.2.3', '255.255.255.255', '224.0.0.1', '239.1.1.1', '240.0.0.1', '192.0.2.10', '198.51.100.7',
  '203.0.113.9', '198.18.0.1', '192.0.0.8', '192.88.99.1',
  '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '0:0:0:0:0:ffff:7f00:0001',
  '::127.0.0.1', '::ffff:0:7f00:1', '64:ff9b::7f00:1', '64:ff9b::808:808', '64:ff9b:1::1', 'fe80::1', 'fc00::1', 'fd12:3456::1',
  'fec0::1', 'ff02::1', '2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:db8::1', '2002:7f00:1::1', '3fff::1', '100::1',
];
const ALLOWED = ['8.8.8.8', '77.88.8.8', '5.255.255.242', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2a00:1450:4010:c05::64', '2606:4700::1111', '::ffff:8.8.8.8'];

describe('SSRF: адреса', () => {
  it('внутренние, локальные и зарезервированные IPv4 и IPv6 (в том числе IPv4 внутри IPv6) — не публичные', () => {
    for (const ip of BLOCKED) assert.equal(isPublicAddress(ip), false, ip);
    for (const ip of ALLOWED) assert.equal(isPublicAddress(ip), true, ip);
    for (const bad of ['', 'localhost', '1.2.3', '1.2.3.4.5', '01.2.3.4', '::g', 'fe80::1%eth0', '1::2::3']) assert.equal(isPublicAddress(bad), false, bad);
  });

  it('разбор IPv6 с хвостом IPv4 и сокращениями', () => {
    assert.deepEqual(parseIPv6('::ffff:127.0.0.1'), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    assert.deepEqual(parseIPv6('1:2:3:4:5:6:1.2.3.4'), [1, 2, 3, 4, 5, 6, 0x0102, 0x0304]);
    assert.deepEqual(parseIPv6('2001:db8::'), [0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
    assert.equal(parseIPv6('1:2:3:4:5:6:7:8:9'), null);
  });

  it('адрес вебхука: только https на 443, без учётных данных и фрагмента; IP и имена внутренних сетей — url_forbidden', () => {
    const code = (u) => {
      try {
        checkUrlSyntax(u);
        return 'ok';
      } catch (err) {
        return err.code;
      }
    };
    assert.equal(code('https://hooks.example.ru/bl?x=1'), 'ok');
    assert.equal(code('https://hooks.example.ru:443/'), 'ok');
    assert.equal(code('https://8.8.8.8/hook'), 'ok');
    assert.equal(code('http://hooks.example.ru/'), 'url_invalid');
    assert.equal(code('ftp://hooks.example.ru/'), 'url_invalid');
    assert.equal(code('https://user:pw@hooks.example.ru/'), 'url_invalid');
    assert.equal(code('https://hooks.example.ru:8443/'), 'url_invalid');
    assert.equal(code('https://hooks.example.ru:80/'), 'url_invalid');
    assert.equal(code('https://hooks.example.ru/#frag'), 'url_invalid');
    assert.equal(code('https://hooks.example.ru/ x'), 'url_invalid');
    assert.equal(code('https://intranet/'), 'url_invalid');
    for (const u of [
      'https://127.0.0.1/', 'https://10.1.2.3/', 'https://169.254.169.254/latest/meta-data/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/',
      'https://[::ffff:7f00:1]/', 'https://2130706433/', 'https://0x7f.0.0.1/', 'https://127.1/', 'https://0/', 'https://[fe80::1]/',
      'https://localhost/', 'https://api.localhost/', 'https://printer.local/', 'https://db.internal/', 'https://router.home.arpa/',
    ]) {
      assert.equal(code(u), 'url_forbidden', u);
    }
  });

  it('имя, резолвящееся во внутренний адрес (хотя бы один из списка), — url_forbidden; не резолвится — url_invalid', async () => {
    const lookup = fakeLookup({
      'hooks.example.ru': ['93.184.216.34'],
      'evil.example.ru': ['10.0.0.5'],
      'mixed.example.ru': ['93.184.216.34', '127.0.0.1'],
      'v6.example.ru': ['::ffff:169.254.169.254'],
      'meta.example.ru': ['169.254.169.254'],
    });
    assert.equal(await validateWebhookUrl('https://hooks.example.ru/bl', { lookup }), 'https://hooks.example.ru/bl');
    for (const h of ['evil', 'mixed', 'v6', 'meta']) {
      await assert.rejects(validateWebhookUrl(`https://${h}.example.ru/`, { lookup }), { code: 'url_forbidden' }, h);
    }
    await assert.rejects(validateWebhookUrl('https://nowhere.example.ru/', { lookup }), { code: 'url_invalid' });
  });

  it('safeLookup: внутренний адрес — отказ без адреса; all и family соблюдаются', async () => {
    const lk = safeLookup(fakeLookup({ 'a.example.ru': ['93.184.216.34', '2a00:1450:4010:c05::64'], 'b.example.ru': ['93.184.216.34', '10.0.0.1'] }));
    const call = (host, opts) => new Promise((resolve) => lk(host, opts, (err, a, f) => resolve({ err, a, f })));
    const one = await call('a.example.ru', {});
    assert.equal(one.a, '93.184.216.34');
    assert.equal(one.f, 4);
    const all = await call('a.example.ru', { all: true });
    assert.equal(all.a.length, 2);
    const v6 = await call('a.example.ru', { family: 6 });
    assert.equal(v6.a, '2a00:1450:4010:c05::64');
    const bad = await call('b.example.ru', { all: true });
    assert.equal(bad.err.code, 'url_forbidden');
    assert.equal(bad.a, undefined);
  });
});

describe('SSRF: соединение', () => {
  let rx;
  before(async () => {
    rx = await startReceiver({ replies: [200] });
  });
  after(async () => {
    await rx?.close();
  });
  const allowLocal = (ip) => ip === '127.0.0.1' || isPublicAddress(ip);

  it('IP-адрес 127.0.0.1 — отказ до соединения', async () => {
    const before = rx.connections;
    await assert.rejects(httpsSend({ url: `https://127.0.0.1:${rx.port}/`, body: '{}', headers: {}, ports: [rx.port], ca: rx.cert }), { code: 'url_forbidden' });
    assert.equal(rx.connections, before);
  });

  it('имя → 127.0.0.1 — отказ при соединении (проверка IP в lookup)', async () => {
    const before = rx.connections;
    const lookup = fakeLookup({ [HOOK_HOST]: ['127.0.0.1'] });
    await assert.rejects(httpsSend({ url: `https://${HOOK_HOST}:${rx.port}/`, body: '{}', headers: {}, ports: [rx.port], ca: rx.cert, lookup }), { code: 'url_forbidden' });
    assert.equal(rx.connections, before);
    assert.equal(rx.requests.length, 0);
  });

  it('DNS rebinding: при регистрации имя публичное, при доставке — внутреннее; соединение не открывается', async () => {
    const lookup = fakeLookup((host, n) => (n === 1 ? ['93.184.216.34'] : ['127.0.0.1']));
    const url = `https://${HOOK_HOST}/`;
    assert.equal(await validateWebhookUrl(url, { lookup }), url);
    const before = rx.connections;
    await assert.rejects(httpsSend({ url: `https://${HOOK_HOST}:${rx.port}/`, body: '{}', headers: {}, ports: [rx.port], ca: rx.cert, lookup }), { code: 'url_forbidden' });
    assert.equal(rx.connections, before);
  });

  it('разрешённый адрес (только тест: свой приёмник) — запрос с телом и заголовками, проверка сертификата', async () => {
    const lookup = fakeLookup({ [HOOK_HOST]: ['127.0.0.1'] });
    const body = JSON.stringify({ id: 'x', type: 'ping' });
    const res = await httpsSend({ url: `https://${HOOK_HOST}:${rx.port}/in?a=1`, body, headers: { 'x-test': '1' }, ports: [rx.port], ca: rx.cert, lookup, isAllowed: allowLocal });
    assert.equal(res.status, 200);
    const last = rx.requests.at(-1);
    assert.equal(last.method, 'POST');
    assert.equal(last.url, '/in?a=1');
    assert.equal(last.body, body);
    assert.equal(last.headers['x-test'], '1');
    // Чужой сертификат (без ca) — ошибка TLS.
    await assert.rejects(httpsSend({ url: `https://${HOOK_HOST}:${rx.port}/`, body, headers: {}, ports: [rx.port], lookup, isAllowed: allowLocal }), (err) => errorCode(err) === 'tls');
  });

  it('редирект не выполняется: 302 — ошибка redirect, второго запроса нет', async () => {
    const r2 = await startReceiver({ replies: [302], redirectTo: 'https://169.254.169.254/latest/meta-data/' });
    try {
      const lookup = fakeLookup({ [HOOK_HOST]: ['127.0.0.1'] });
      await assert.rejects(httpsSend({ url: `https://${HOOK_HOST}:${r2.port}/`, body: '{}', headers: {}, ports: [r2.port], ca: r2.cert, lookup, isAllowed: allowLocal }), (err) => err.code === 'redirect' && err.status === 302);
      assert.equal(r2.requests.length, 1);
    } finally {
      await r2.close();
    }
  });
});

describe('подпись и повторы', () => {
  it('подпись — HMAC-SHA256 `${t}.${body}` в hex, заголовки X-Bl-*', () => {
    const secret = 'whsec_test';
    const body = '{"id":"1","type":"ping"}';
    const t = 1_761_300_000;
    assert.equal(sign(secret, t, body), createHmac('sha256', secret).update(`${t}.${body}`).digest('hex'));
    const h = deliveryHeaders({ secret, timestamp: t, body, event: 'ping', eventId: 'e', deliveryId: 'd' });
    assert.equal(h['x-bl-timestamp'], String(t));
    assert.equal(h['x-bl-signature'], `v1=${sign(secret, t, body)}`);
    assert.equal(h['x-bl-event'], 'ping');
    // Пример проверки из docs/api/club-api-v1.md (Node): та же строка.
    const expected = createHmac('sha256', secret).update(`${h['x-bl-timestamp']}.${body}`).digest('hex');
    assert.equal(h['x-bl-signature'].slice(3), expected);
  });

  it('повторы с ростом паузы: 1, 5, 15, 30 мин, 1, 2, 4, 8, 12 ч, последняя — ровно в 24 ч, затем стоп', () => {
    const created = new Date('2026-10-24T00:00:00Z');
    let now = created;
    const delays = [];
    for (let n = 1; n < 20; n += 1) {
      const next = nextAttemptAt(n, created, now);
      if (!next) break;
      delays.push(Math.round((next - now) / 60_000));
      now = next;
    }
    assert.deepEqual(delays.slice(0, 9), [1, 5, 15, 30, 60, 120, 240, 480, 489]);
    assert.equal(now.getTime(), created.getTime() + RETRY_WINDOW_MS);
    assert.equal(nextAttemptAt(10, created, now), null);
  });
});

describe('ключи и псевдонимы', () => {
  it('ключ blk_ + 43 символа; заголовок только Bearer blk_…; хеш зависит от перца', () => {
    const k = newKey();
    assert.match(k, /^blk_[A-Za-z0-9_-]{43}$/);
    assert.equal(keyFromHeader(`Bearer ${k}`), k);
    assert.equal(keyFromHeader(k), null);
    assert.equal(keyFromHeader(`Bearer ${k.slice(0, -1)}`), null);
    assert.equal(keyFromHeader(`Bearer abc${k}`), null);
    const p1 = keyPepper(randomBytes(32));
    const p2 = keyPepper(randomBytes(32));
    assert.match(keyHash(p1, k), /^[0-9a-f]{64}$/);
    assert.notEqual(keyHash(p1, k), keyHash(p2, k));
  });

  it('game_id — стабильный UUID, не равен id игры и разный у клубов', () => {
    const p = gamePepper(randomBytes(32));
    const s = '5e000000-0000-4000-8000-000000000001';
    const a = gameId(p, 'c1000000-0000-4000-8000-000000000001', s);
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(a, gameId(p, 'c1000000-0000-4000-8000-000000000001', s));
    assert.notEqual(a, s);
    assert.notEqual(a, gameId(p, 'c2000000-0000-4000-8000-000000000002', s));
  });
});

describe('курсор страниц (Н-1, Н-2)', () => {
  it('свой курсор разбирается обратно; кривой — 400 bad_request', () => {
    const id = '0d1b2c3a-0000-4000-8000-0000000000aa';
    const at = new Date('2026-10-24T10:00:00.123Z');
    assert.deepEqual(decodeCursor(encodeCursor(at, id)), [at.toISOString(), id]);
    assert.equal(decodeCursor(undefined), null);
    assert.equal(decodeCursor(''), null);
    for (const [what, c] of badCursors()) {
      assert.throws(() => decodeCursor(c), (err) => err.status === 400 && err.code === 'bad_request', what);
    }
    assert.equal(isIsoTime('1'), false);
    assert.equal(isIsoTime('2026-02-30T00:00:00.000Z'), false);
    assert.equal(isIsoTime('2026-10-24T10:00:00Z'), false, 'только каноническая запись');
    assert.equal(isIsoTime('2026-10-24T10:00:00.000Z'), true);
  });
});
