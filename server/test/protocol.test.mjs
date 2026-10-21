import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  buildCommand,
  canonicalCommand,
  canonicalize,
  decodeBase64Strict,
  deviceTopic,
  parseDeviceTopic,
  parseStrict,
  ProtocolError,
  verifyCommand,
} from '../lib/protocol.mjs';

const vectorsFile = new URL('../../docs/protocol-vectors.json', import.meta.url);
const { vectors } = JSON.parse(readFileSync(vectorsFile, 'utf8'));

describe('docs/protocol-vectors.json', () => {
  it('файл содержит векторы всех трёх исходов (v1 — 38 векторов)', () => {
    const kinds = new Set(vectors.map((v) => v.expect));
    assert.deepEqual([...kinds].sort(), ['bad_format', 'bad_sig', 'ok']);
    assert.ok(vectors.length >= 38);
  });

  for (const v of vectors) {
    it(`${v.expect}: ${v.name}`, () => {
      const res = verifyCommand(v.raw, v.key_b64);
      assert.equal(res.result, v.expect);
      if (v.canonical !== undefined) assert.equal(res.canonical, v.canonical);
      if (v.expect === 'ok') {
        // Сервер сам собирает ту же команду и получает ту же подпись.
        const { v: _v, sig: _sig, ...fields } = res.cmd;
        const built = buildCommand(
          { id: fields.id, seq: fields.seq, type: fields.type, body: fields.body, issuedAt: fields.issued_at },
          v.key_b64,
        );
        assert.equal(built.canonical, v.canonical);
        assert.equal(built.cmd.sig, v.sig);
        assert.equal(verifyCommand(built.payload, v.key_b64).result, 'ok');
      }
    });
  }
});

describe('канонический JSON', () => {
  it('сортирует ключи на всех уровнях и не ставит пробелов', () => {
    assert.equal(canonicalize({ b: [3, { z: 1, a: null }], a: true }), '{"a":true,"b":[3,{"a":null,"z":1}]}');
  });

  it('отвергает дробные числа, -0, числа вне ±(2^53−1), не-ASCII, кавычку и обратную косую', () => {
    for (const bad of [1.5, -0, 2 ** 53, -(2 ** 53), 'уборка', 'a"b', 'a\\b', 'tab\t', undefined, () => 1]) {
      assert.throws(() => canonicalize({ x: bad }), (err) => err instanceof ProtocolError && err.code === 'bad_format');
    }
    assert.equal(canonicalize({ x: Number.MAX_SAFE_INTEGER, y: -Number.MAX_SAFE_INTEGER }), '{"x":9007199254740991,"y":-9007199254740991}');
  });

  it('проверяет запись чисел по исходному тексту', () => {
    for (const raw of ['{"a":1.0}', '{"a":1e3}', '{"a":-0}', '{"a":9007199254740992}', '{"a":-9007199254740993}', '{"a":1E2}']) {
      assert.throws(() => parseStrict(raw), (err) => err.code === 'bad_format', raw);
    }
    assert.deepEqual(parseStrict('{"a":-12,"b":0,"c":9007199254740991}'), { a: -12, b: 0, c: 9007199254740991 });
  });

  it('запрещает вложенное поле sig', () => {
    assert.throws(() => canonicalCommand({ v: 1, body: { sig: 'x' } }), (err) => err.code === 'bad_format');
    assert.throws(() => canonicalCommand({ v: 1, body: { list: [{ sig: 1 }] } }), (err) => err.code === 'bad_format');
    assert.equal(canonicalCommand({ v: 1, sig: 'x', body: {} }), '{"body":{},"v":1}');
  });
});

describe('строгий JSON и форматы полей v1 (§3, §3.1)', () => {
  const key = Buffer.alloc(32, 9);
  const good = () => buildCommand({ id: '0192f3c1-6d1a-7c3e-9b2a-1f0e5d4c3b2a', seq: 5, type: 'ping', issuedAt: 10 }, key);

  it('повторяющийся ключ на любом уровне и с пробелами перед двоеточием — bad_format', () => {
    for (const raw of ['{"a":1,"b":{"x":1,"x":2}}', '{"a" :1, "a":2}', '{"l":[{"k":1},{"k":2,"k":3}]}']) {
      assert.throws(() => parseStrict(raw), (err) => err.code === 'bad_format', raw);
    }
    assert.deepEqual(parseStrict('{"l":[{"k":1},{"k":2}],"k":{"k":0}}'), { l: [{ k: 1 }, { k: 2 }], k: { k: 0 } });
  });

  it('обратная косая черта где угодно — bad_format, в том числе в ключе', () => {
    for (const raw of ['{"a":"\\u0041"}', '{"a\\/b":1}', '{"a":"x\\\\y"}']) {
      assert.throws(() => parseStrict(raw), (err) => err.code === 'bad_format', raw);
    }
  });

  it('команда длиннее 2048 байт — bad_format при проверке и при сборке', () => {
    const { payload } = good();
    const padded = `${payload.slice(0, -1)}${' '.repeat(2049 - payload.length)}}`;
    assert.equal(Buffer.byteLength(padded), 2049);
    assert.equal(verifyCommand(padded, key).result, 'bad_format');
    assert.equal(verifyCommand(padded.replace(/ +}$/, '}'), key).result, 'ok');
    assert.throws(() => buildCommand({ seq: 1, type: 'ota.start', body: { url: 'x'.repeat(2100) } }, key), (err) => err.code === 'bad_format');
  });

  it('sig: неканонический хвост base64, лишний символ, не строка — bad_sig', () => {
    const { cmd } = good();
    const last = cmd.sig[42];
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const twin = alphabet[alphabet.indexOf(last) ^ 1]; // те же 32 байта, другие «лишние» биты
    for (const sig of [`${cmd.sig.slice(0, 42)}${twin}=`, `${cmd.sig}=`, `${cmd.sig.slice(0, -1)}`, 42, null]) {
      assert.equal(verifyCommand(JSON.stringify({ ...cmd, sig }), key).result, 'bad_sig', String(sig));
    }
  });

  it('сервер не собирает команду с неверным id, issued_at или body', () => {
    assert.throws(() => buildCommand({ id: '0192F3C1-6D1A-7C3E-9B2A-1F0E5D4C3B2A', seq: 1, type: 'ping' }, key));
    assert.throws(() => buildCommand({ seq: 1, type: 'ping', issuedAt: -1 }, key));
    assert.throws(() => buildCommand({ seq: 1, type: 'ping', body: [] }, key));
    assert.throws(() => buildCommand({ seq: 1, type: '' }, key));
  });
});

describe('подпись и сборка команды', () => {
  const key = Buffer.alloc(32, 7);

  it('подписанная команда проходит проверку, подмена любого поля — bad_sig', () => {
    const { payload, cmd } = buildCommand({ seq: 42, type: 'ping', body: {}, issuedAt: 1792598400 }, key);
    assert.equal(verifyCommand(payload, key).result, 'ok');
    const tampered = JSON.stringify({ ...cmd, seq: 43 });
    assert.equal(verifyCommand(tampered, key).result, 'bad_sig');
    assert.equal(verifyCommand(payload, Buffer.alloc(32, 8)).result, 'bad_sig');
  });

  it('JSON для публикации — каноническая строка и sig последним полем', () => {
    const { payload, canonical } = buildCommand({ id: '0192f3c1-6d1a-7c3e-9b2a-1f0e5d4c3b2a', seq: 1, type: 'ping', issuedAt: 1 }, key);
    assert.ok(payload.startsWith(canonical.slice(0, -1)));
    assert.match(payload, /,"sig":"[A-Za-z0-9+/]{43}="\}$/);
  });

  it('не собирает команду с seq < 1, дробным seq или ключом не из 32 байт', () => {
    assert.throws(() => buildCommand({ seq: 0, type: 'ping' }, key));
    assert.throws(() => buildCommand({ seq: 1.5, type: 'ping' }, key));
    assert.throws(() => buildCommand({ seq: 1, type: 'ping' }, Buffer.alloc(16)));
  });

  it('строгий base64', () => {
    assert.equal(decodeBase64Strict('!!not-base64!!'), null);
    assert.deepEqual(decodeBase64Strict('YWJj'), Buffer.from('abc'));
    assert.equal(decodeBase64Strict('YWJjZA'), null);
    assert.deepEqual(decodeBase64Strict('YWJjZA=='), Buffer.from('abcd'));
  });
});

describe('топики', () => {
  const club = 'c1000000-0000-4000-8000-000000000001';
  const dev = 'd1000000-0000-4000-8000-000000000001';

  it('собирает и разбирает топик устройства', () => {
    assert.equal(deviceTopic(club, dev, 'cmd'), `bl/v1/${club}/${dev}/cmd`);
    assert.deepEqual(parseDeviceTopic(`bl/v1/${club}/${dev}/state`), { clubId: club, deviceId: dev, kind: 'state' });
  });

  it('отвергает чужие и кривые топики', () => {
    for (const t of [`bl/v2/${club}/${dev}/state`, `bl/v1/${club}/${dev}/other`, `bl/v1/x/${dev}/state`, `bl/v1/${club}/${dev}/state/x`, '$SYS/broker']) {
      assert.equal(parseDeviceTopic(t), null, t);
    }
  });
});
