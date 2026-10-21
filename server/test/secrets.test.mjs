import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { decryptSecret, deviceKeyContext, encryptSecret, loadEncKey, SecretsError } from '../lib/secrets.mjs';

const key = randomBytes(32);
const devA = deviceKeyContext('d1000000-0000-4000-8000-000000000001');
const devB = deviceKeyContext('d1000000-0000-4000-8000-000000000002');

describe('secrets (AES-256-GCM, decisions №23)', () => {
  it('шифрует и расшифровывает, каждый раз с новым IV', () => {
    const secret = randomBytes(32);
    const a = encryptSecret(secret, key, devA);
    const b = encryptSecret(secret, key, devA);
    assert.notEqual(a, b);
    assert.match(a, /^v1:[A-Za-z0-9+/]+=*$/);
    assert.deepEqual(decryptSecret(a, key, devA), secret);
    assert.deepEqual(decryptSecret(b, key, devA), secret);
  });

  it('шифртекст не содержит открытый текст', () => {
    const enc = encryptSecret('super-secret-value', key, devA);
    assert.ok(!Buffer.from(enc.slice(3), 'base64').includes(Buffer.from('super-secret')));
  });

  it('другой ключ, другая запись (AAD) или подмена байта — ошибка', () => {
    const enc = encryptSecret(randomBytes(32), key, devA);
    assert.throws(() => decryptSecret(enc, randomBytes(32), devA), SecretsError);
    assert.throws(() => decryptSecret(enc, key, devB), SecretsError);
    const raw = Buffer.from(enc.slice(3), 'base64');
    raw[raw.length - 1] ^= 1;
    assert.throws(() => decryptSecret(`v1:${raw.toString('base64')}`, key, devA), SecretsError);
    assert.throws(() => decryptSecret('v2:abc', key, devA), SecretsError);
    assert.throws(() => decryptSecret('v1:AAAA', key, devA), SecretsError);
  });

  it('требует контекст и ключ ровно 32 байта', () => {
    assert.throws(() => encryptSecret('x', key, ''), SecretsError);
    assert.throws(() => encryptSecret('x', randomBytes(16), devA), SecretsError);
  });

  it('SECRETS_ENC_KEY — строго 32 байта в base64, значение не попадает в ошибку', () => {
    const b64 = randomBytes(32).toString('base64');
    assert.deepEqual(loadEncKey(b64), Buffer.from(b64, 'base64'));
    for (const bad of [undefined, '', randomBytes(16).toString('base64'), randomBytes(33).toString('base64'), 'x'.repeat(44)]) {
      assert.throws(
        () => loadEncKey(bad),
        (err) => err instanceof SecretsError && (!bad || !err.message.includes(bad)),
      );
    }
  });
});
