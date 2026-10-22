// Web Push без сети: шифрование по тестовому вектору RFC 8291 (приложение A), расшифровка,
// VAPID ES256 (RFC 8292) — подпись проверяется открытым ключом, разрешённые адреса подписок.

import assert from 'node:assert/strict';
import { createECDH, createPublicKey, verify } from 'node:crypto';
import { describe, it } from 'node:test';
import { decryptPayload, encryptPayload, endpointAllowed, loadVapid, p256Scalar, sendPush, vapidJwt } from '../notify/webpush.mjs';
import { channelChain, cleanData, maskPhones, pushTitle } from '../notify/index.mjs';
import { createStreamTokens, streamTarget } from '../http/stream-tokens.mjs';

// RFC 8291, приложение A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

describe('Web Push: RFC 8291', () => {
  it('тестовый вектор RFC 8291: тело совпадает байт в байт (144 байта)', () => {
    const body = encryptPayload(
      Buffer.from(RFC.plaintext),
      { p256dh: RFC.uaPublic, auth: RFC.auth },
      { salt: Buffer.from(RFC.salt, 'base64url'), asPrivateKey: Buffer.from(RFC.asPrivate, 'base64url') },
    );
    assert.equal(body.length, 144);
    assert.equal(body.toString('base64url'), RFC.body);
  });

  it('расшифровка вектора закрытым ключом подписки', () => {
    const plain = decryptPayload(Buffer.from(RFC.body, 'base64url'), { uaPrivateKey: Buffer.from(RFC.uaPrivate, 'base64url'), auth: RFC.auth });
    assert.equal(plain.toString(), RFC.plaintext);
  });

  it('случайные ключ и соль: туда и обратно, с дополнением; неверные ключи подписки — ошибка', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = Buffer.alloc(16, 3).toString('base64url');
    const msg = Buffer.from(JSON.stringify({ text: 'Стол 4: осталось 10 минут' }));
    const a = encryptPayload(msg, { p256dh: ua.getPublicKey().toString('base64url'), auth }, { padding: 32 });
    const b = encryptPayload(msg, { p256dh: ua.getPublicKey().toString('base64url'), auth });
    assert.notEqual(a.subarray(0, 16).toString('hex'), b.subarray(0, 16).toString('hex'));
    assert.deepEqual(decryptPayload(a, { uaPrivateKey: ua.getPrivateKey(), auth }), msg);
    assert.throws(() => encryptPayload(msg, { p256dh: 'AAAA', auth }));
    assert.throws(() => encryptPayload(msg, { p256dh: ua.getPublicKey().toString('base64url'), auth: 'AAAA' }));
    assert.throws(() => encryptPayload(Buffer.alloc(5000), { p256dh: ua.getPublicKey().toString('base64url'), auth }));
  });
});

describe('VAPID: RFC 8292', () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const keys = { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: p256Scalar(ecdh.getPrivateKey()).toString('base64url'), subject: 'mailto:ops@bl.test' };

  it('JWT ES256: aud — origin push-сервиса, exp ≤ 24 ч, подпись проверяется открытым ключом', () => {
    const vapid = loadVapid(keys);
    const now = new Date('2026-10-21T12:00:00Z');
    const jwt = vapidJwt(vapid, 'https://fcm.googleapis.com/fcm/send/abc', { now });
    const [h, c, s] = jwt.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(Buffer.from(c, 'base64url'));
    assert.equal(claims.aud, 'https://fcm.googleapis.com');
    assert.equal(claims.sub, 'mailto:ops@bl.test');
    assert.ok(claims.exp - now.getTime() / 1000 <= 24 * 3600);
    const pub = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: ecdh.getPublicKey().subarray(1, 33).toString('base64url'), y: ecdh.getPublicKey().subarray(33).toString('base64url') },
      format: 'jwk',
    });
    assert.equal(Buffer.from(s, 'base64url').length, 64);
    assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  });

  it('ключи из .env проверяются: длина, пара, subject', () => {
    assert.throws(() => loadVapid({ ...keys, publicKey: 'AAAA' }));
    const other = createECDH('prime256v1');
    other.generateKeys();
    assert.throws(() => loadVapid({ ...keys, publicKey: other.getPublicKey().toString('base64url') }), /не от этого/);
    assert.throws(() => loadVapid({ ...keys, subject: 'ops@bl.test' }));
    assert.throws(() => loadVapid({ ...keys, privateKey: Buffer.alloc(33, 1).toString('base64url') }), /32 байта/);
  });

  it('закрытый ключ с ведущим нулём: 31 байт (как отдаёт ECDH.getPrivateKey) добивается до 32', () => {
    const d = Buffer.concat([Buffer.alloc(1), Buffer.alloc(31, 0x11)]);
    const e = createECDH('prime256v1');
    e.setPrivateKey(d);
    assert.equal(e.getPrivateKey().length, 31); // Node отбрасывает ведущий ноль — причина плавающего сбоя
    assert.deepEqual(p256Scalar(e.getPrivateKey()), d);
    const pub = e.getPublicKey().toString('base64url');
    const short = loadVapid({ publicKey: pub, privateKey: e.getPrivateKey().toString('base64url'), subject: 'mailto:ops@bl.test' });
    const full = loadVapid({ publicKey: pub, privateKey: d.toString('base64url'), subject: 'mailto:ops@bl.test' });
    assert.equal(short.key.export({ format: 'jwk' }).d, d.toString('base64url'));
    assert.equal(full.key.export({ format: 'jwk' }).d, d.toString('base64url'));
    const [h, c, s] = vapidJwt(short, 'https://fcm.googleapis.com/fcm/send/x').split('.');
    assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: createPublicKey(full.key), dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  });

  it('sendPush: заголовки RFC 8030/8291/8292; 201 — sent, 410 — gone, адрес не push-сервиса — без запроса', async () => {
    const vapid = loadVapid(keys);
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const sub = { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/x', p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') };
    const seen = [];
    const request = async (url, opts) => {
      seen.push({ url, opts });
      return { status: seen.length === 1 ? 201 : 410, headers: {}, body: Buffer.alloc(0) };
    };
    assert.deepEqual(await sendPush(sub, { text: 'Стол 1' }, { vapid, request, urgency: 'high' }), { status: 'sent', code: 'http_201' });
    const h = seen[0].opts.headers;
    assert.equal(h['content-encoding'], 'aes128gcm');
    assert.equal(h.ttl, '3600');
    assert.equal(h.urgency, 'high');
    assert.match(h.authorization, new RegExp(`^vapid t=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+, k=${keys.publicKey}$`));
    assert.equal((await sendPush(sub, { text: 'x' }, { vapid, request })).status, 'gone');
    const before = seen.length;
    assert.equal((await sendPush({ ...sub, endpoint: 'https://127.0.0.1/x' }, { text: 'x' }, { vapid, request })).code, 'endpoint_not_allowed');
    assert.equal(seen.length, before);
  });
});

describe('адреса подписок и цепочка каналов', () => {
  it('только https известных push-сервисов, без IP, логина и чужого порта', () => {
    for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://web.push.apple.com/x', 'https://updates.push.services.mozilla.com/x', 'https://wns2-db5p.notify.windows.com/w/?token=x']) {
      assert.equal(endpointAllowed(ok), true, ok);
    }
    for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.com/x', 'https://push.apple.com.evil.com/x', 'https://user:p@fcm.googleapis.com/x', 'https://10.0.0.1/x', 'https://fcm.googleapis.com:444/x', 'nonsense']) {
      assert.equal(endpointAllowed(bad), false, bad);
    }
  });

  it('цепочка: основной канал первым, затем max → telegram → webpush из доступных', () => {
    assert.deepEqual(channelChain({ notify_channel: 'webpush', telegram_user_id: 1, max_user_id: 'm' }, true), ['webpush', 'max', 'telegram']);
    assert.deepEqual(channelChain({ notify_channel: 'max', telegram_user_id: 1, max_user_id: null }, true), ['telegram', 'webpush']);
    assert.deepEqual(channelChain(null, false), []);
  });

  it('маска телефонов в тексте: 10+ цифр — ***, даты и суммы остаются', () => {
    assert.equal(maskPhones('Звонок +7 (999) 123-45-67 в 21:30'), 'Звонок *** в 21:30');
    assert.equal(maskPhones('Карта 2200 1234 5678 9012'), 'Карта ***');
    assert.equal(maskPhones('21.10.2026, 2026-10-21, 1 490 ₽'), '21.10.2026, 2026-10-21, 1 490 ₽');
  });
});

describe('данные уведомления и одноразовые токены SSE', () => {
  it('data: массивы коротких значений сохраняются, вложенные объекты и длинные массивы — нет, телефоны — ***', () => {
    assert.deepEqual(cleanData({ actions: ['extend', 'stop'], n: 3, nested: { a: 1 }, big: Array(21).fill(1), phone: '+79991234567', Bad: 1 }), {
      actions: ['extend', 'stop'],
      n: 3,
      phone: '***',
    });
    assert.equal(pushTitle('alarm'), 'Тревога в клубе');
    assert.equal(pushTitle('session.t10'), 'Игра');
  });

  it('токен SSE: 60 с, один раз, только свой канал', () => {
    let now = 1_000_000;
    const store = createStreamTokens({ now: () => now });
    const club = 'c1000000-0000-4000-8000-000000000001';
    const p = { userId: 'a1000000-0000-4000-8000-000000000001', tokenId: 't', kind: 'session' };
    const a = store.issue(p, streamTarget({ club }));
    assert.equal(a.expiresAt.getTime(), now + 60_000);
    assert.equal(store.consume(a.token, streamTarget({ session: club })), null, 'другой канал');
    const b = store.issue(p, streamTarget({ club }));
    assert.equal(store.consume(b.token, streamTarget({ club })).userId, p.userId);
    assert.equal(store.consume(b.token, streamTarget({ club })), null, 'второй раз');
    const c = store.issue(p, streamTarget({ club }));
    now += 60_001;
    assert.equal(store.consume(c.token, streamTarget({ club })), null, 'истёк');
    assert.equal(streamTarget({ club, session: club }), null);
    assert.equal(streamTarget({ club: 'x' }), null);
    for (let i = 0; i < 20; i += 1) store.issue(p, streamTarget({ club }));
    assert.equal(store.issue(p, streamTarget({ club })), null, 'не больше 20 на пользователя');
  });
});
