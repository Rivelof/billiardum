// Вход без базы: initData Telegram (свои векторы, посчитаны openssl независимо от кода),
// PIN (scrypt), формат токенов и телефонов, вход для разработки не существует в проде.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { loadRoutes } from '../../api/router.mjs';
import { devLoginEnabled } from '../../api/routes/auth.mjs';
import { maskPhone, newToken, normalizePhone, tokenHash } from '../auth/index.mjs';
import { hashPin, verifyPin } from '../auth/pin.mjs';
import { dataCheckString, InitDataError, signInitData, verifyInitData, webAppSecret } from '../auth/telegram.mjs';
import { loadServerConfig } from '../lib/config.mjs';

// Вектор: openssl dgst -sha256 -mac HMAC -macopt key:WebAppData (токен) → секрет;
// openssl dgst -sha256 -mac HMAC -macopt hexkey:<секрет> (data_check_string) → hash.
const VECTOR = {
  token: '7000000001:AAF-test-vector-token_0123456789abcd',
  secretHex: 'c798abddab844c1adf103e15c909c550763ab0bce01005e27d136d7cfb0ef377',
  authDate: 1792540800,
  user: '{"id":279058397,"first_name":"Ваня","username":"vanya","language_code":"ru"}',
  hash: 'd9b88380c89a61434d32774f0d49bcca97aacfdac016785bcd139aee547c58cf',
};
const VECTOR_INIT_DATA =
  'query_id=AAHdF6IQAAAAAN0XohDhrOrc' +
  `&user=${encodeURIComponent(VECTOR.user)}` +
  `&auth_date=${VECTOR.authDate}` +
  `&hash=${VECTOR.hash}`;
const AT = new Date((VECTOR.authDate + 60) * 1000);

describe('initData Telegram', () => {
  it('секрет = HMAC-SHA256("WebAppData", токен) — как у openssl', () => {
    assert.equal(webAppSecret(VECTOR.token).toString('hex'), VECTOR.secretHex);
  });

  it('вектор: data_check_string по алфавиту и верный hash', () => {
    const { text, hash } = dataCheckString(VECTOR_INIT_DATA);
    assert.equal(text, `auth_date=${VECTOR.authDate}\nquery_id=AAHdF6IQAAAAAN0XohDhrOrc\nuser=${VECTOR.user}`);
    assert.equal(hash, VECTOR.hash);
    const { user, authDate } = verifyInitData(VECTOR_INIT_DATA, VECTOR.token, { now: AT });
    assert.equal(user.id, 279058397);
    assert.equal(user.first_name, 'Ваня');
    assert.equal(authDate, VECTOR.authDate);
  });

  it('подпись своим кодом совпадает с вектором', () => {
    const signed = signInitData({ auth_date: String(VECTOR.authDate), query_id: 'AAHdF6IQAAAAAN0XohDhrOrc', user: VECTOR.user }, VECTOR.token);
    assert.equal(new URLSearchParams(signed).get('hash'), VECTOR.hash);
  });

  const reason = (fn) => {
    try {
      fn();
    } catch (err) {
      assert.ok(err instanceof InitDataError);
      return err.reason;
    }
    return 'ok';
  };

  it('отказы: подмена поля, чужой токен, повтор ключа, нет hash, устарело, из будущего, нет user', () => {
    const tampered = VECTOR_INIT_DATA.replace('vanya', 'petya');
    assert.equal(reason(() => verifyInitData(tampered, VECTOR.token, { now: AT })), 'signature');
    assert.equal(reason(() => verifyInitData(VECTOR_INIT_DATA, '1:other', { now: AT })), 'signature');
    assert.equal(reason(() => verifyInitData(`${VECTOR_INIT_DATA}&auth_date=1`, VECTOR.token, { now: AT })), 'duplicate_key');
    assert.equal(reason(() => verifyInitData('auth_date=1&user=%7B%7D', VECTOR.token, { now: AT })), 'hash');
    assert.equal(reason(() => verifyInitData(VECTOR_INIT_DATA, VECTOR.token, { now: new Date((VECTOR.authDate + 86401) * 1000) })), 'expired');
    assert.equal(reason(() => verifyInitData(VECTOR_INIT_DATA, VECTOR.token, { now: new Date((VECTOR.authDate - 3600) * 1000) })), 'auth_date_future');
    const noUser = signInitData({ auth_date: String(VECTOR.authDate) }, VECTOR.token);
    assert.equal(reason(() => verifyInitData(noUser, VECTOR.token, { now: AT })), 'user');
    assert.equal(reason(() => verifyInitData('x'.repeat(5000), VECTOR.token, { now: AT })), 'format');
    assert.equal(reason(() => verifyInitData(VECTOR_INIT_DATA, '', { now: AT })), 'not_configured');
  });

  it('ровно 24 часа — ещё принимается, на секунду больше — нет', () => {
    assert.equal(reason(() => verifyInitData(VECTOR_INIT_DATA, VECTOR.token, { now: new Date((VECTOR.authDate + 86400) * 1000) })), 'ok');
  });
});

describe('PIN', () => {
  const pepper = randomBytes(32);

  it('scrypt-хеш с солью: верный PIN проходит, неверный — нет, другой перец — нет', async () => {
    const h = await hashPin('4821', pepper);
    assert.match(h, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]{43}$/);
    assert.notEqual(h, await hashPin('4821', pepper), 'соль случайная');
    assert.equal(await verifyPin('4821', h, pepper), true);
    assert.equal(await verifyPin('4822', h, pepper), false);
    assert.equal(await verifyPin('4821', h, randomBytes(32)), false);
    assert.equal(await verifyPin('4821', 'plain', pepper), false);
  });

  it('PIN — только 4–6 цифр', async () => {
    for (const bad of ['123', '1234567', '12a4', '', ' 1234']) await assert.rejects(hashPin(bad, pepper));
    assert.equal(await verifyPin('12345678', 'scrypt$16384$8$1$AA$AA', pepper), false);
  });
});

describe('токены и телефоны', () => {
  it('токен — 32 байта base64url, в базу — sha256', () => {
    const t = newToken();
    assert.match(t, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(t, 'base64url').length, 32);
    assert.match(tokenHash(t), /^[0-9a-f]{64}$/);
  });

  it('телефон контакта → E.164; маска', () => {
    assert.equal(normalizePhone('79991234567'), '+79991234567');
    assert.equal(normalizePhone('+7 (999) 123-45-67'), '+79991234567');
    assert.equal(normalizePhone('abc'), null);
    assert.equal(maskPhone('+79991234567'), '+7999***4567');
    assert.equal(maskPhone(null), null);
  });
});

describe('вход для разработки в проде не существует', () => {
  const base = {
    DATABASE_URL: 'postgres://x',
    MQTT_URL: 'mqtts://x',
    MQTT_CA_FILE: 'x',
    MQTT_SERVER_USER: 'x',
    MQTT_SERVER_PASSWORD: 'x',
    SECRETS_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
  };

  it('NODE_ENV=production и ALLOW_DEV_LOGIN=1 — флаг выключен, маршрут не регистрируется', async () => {
    const prod = loadServerConfig({ ...base, NODE_ENV: 'production', ALLOW_DEV_LOGIN: '1' });
    assert.equal(prod.allowDevLogin, false);
    assert.equal(devLoginEnabled(prod), false);
    assert.equal(devLoginEnabled({ nodeEnv: 'production', allowDevLogin: true }), false, 'даже при ошибочно включённом флаге');
    const routes = await loadRoutes({ config: prod, only: ['auth.mjs'] });
    const { createRouter } = await import('../../api/router.mjs');
    const router = createRouter({ config: prod, log: { info() {}, warn() {}, error() {}, debug() {} } }, { routes });
    assert.equal(
      router.routes.some((r) => r.path === '/api/auth/dev'),
      false,
    );
    assert.deepEqual(router.match('POST', '/api/auth/dev').error.status, 404);
  });

  it('разработка без ALLOW_DEV_LOGIN — тоже нет; с ALLOW_DEV_LOGIN=1 — есть', async () => {
    const { createRouter } = await import('../../api/router.mjs');
    const silent = { info() {}, warn() {}, error() {}, debug() {} };
    for (const [env, expected] of [
      [{ NODE_ENV: 'development' }, false],
      [{ NODE_ENV: 'development', ALLOW_DEV_LOGIN: '1' }, true],
    ]) {
      const config = loadServerConfig({ ...base, ...env });
      const router = createRouter({ config, log: silent }, { routes: await loadRoutes({ config, only: ['auth.mjs'] }) });
      assert.equal(
        router.routes.some((r) => r.path === '/api/auth/dev'),
        expected,
      );
    }
  });
});
