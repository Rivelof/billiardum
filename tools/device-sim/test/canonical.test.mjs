// Края правил §3 и §3.1 сверх общих векторов.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, hasDuplicateKey, LIMITS, parseStrict } from '../lib/canonical.mjs';
import { decodeSig, verifyCommand } from '../lib/command.mjs';
import { makeCommand, signed, testSig, TEST_KEY_B64 } from './helpers/sign.mjs';

const KEY = Buffer.from(TEST_KEY_B64, 'base64');
const ID = '0192f3c1-6d1a-7c3e-9b2a-00000000aaaa';

const check = (raw) => verifyCommand(Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8'), KEY);

test('ключи по возрастанию байтов: заглавные, подчёркивание, строчные', () => {
  const s = canonicalize({ b: 1, a: 2, B: 3, _: 4, a1: 5, A: 6, '': 7 });
  assert.equal(s, '{"":7,"A":6,"B":3,"_":4,"a":2,"a1":5,"b":1}');
});

test('вложенные объекты и массивы: порядок массива сохраняется', () => {
  assert.equal(canonicalize({ z: [3, { y: true, x: null }, 'q'], a: false }), '{"a":false,"z":[3,{"x":null,"y":true},"q"]}');
});

test('числа: границы ±(2^53−1) принимаются; -0, 2^53, 1E5, 0.0 — нет', () => {
  assert.equal(parseStrict('[9007199254740991,-9007199254740991,0,-1]').ok, true);
  assert.deepEqual(parseStrict('{"a":-0}'), { ok: false, reason: 'number_not_integer' });
  assert.deepEqual(parseStrict('[9007199254740992]'), { ok: false, reason: 'number_out_of_range' });
  assert.deepEqual(parseStrict('[-9007199254740992]'), { ok: false, reason: 'number_out_of_range' });
  assert.deepEqual(parseStrict('[1E5]'), { ok: false, reason: 'number_not_integer' });
  assert.deepEqual(parseStrict('[0.0]'), { ok: false, reason: 'number_not_integer' });
  assert.throws(() => canonicalize({ a: -0 }));
});

test('обратная косая черта где угодно — bad_format, даже если раскрывается в допустимый символ', () => {
  for (const text of ['{"a":"\\u0041"}', '{"a":"x\\/y"}', '{"\\u0061":1}', '{"a":"x\\\\y"}', '{"a":1}\\']) {
    assert.deepEqual(parseStrict(text), { ok: false, reason: 'backslash' }, text);
  }
});

test('строки: не-ASCII и управляющие символы — bad_format', () => {
  assert.equal(parseStrict('{"a":"é"}').ok, false);
  assert.equal(parseStrict('{"ключ":1}').ok, false);
  assert.equal(parseStrict('{"a":"x\ty"}').ok, false); // сырой таб в строке — не JSON
});

test('повторяющиеся ключи на любом уровне — bad_format; одинаковые ключи в разных объектах — можно', () => {
  assert.equal(hasDuplicateKey('{"a":1,"a":2}'), true);
  assert.equal(hasDuplicateKey('{"b":{"x":1,"y":[{"q":1}],"x":3}}'), true);
  assert.equal(hasDuplicateKey('{"a":{"a":1},"b":[{"a":1},{"a":2}],"c":"a"}'), false);
  assert.equal(hasDuplicateKey('{"a":"b","b":"a"}'), false);
  assert.equal(hasDuplicateKey('{ "a" : 1 , "a" : 1 }'), true);
  assert.equal(hasDuplicateKey('{"":1,"":2}'), true);
  assert.deepEqual(parseStrict('{"a":[1,{"k":1,"k":1}]}'), { ok: false, reason: 'duplicate_key' });
  const cmd = makeCommand({ seq: 11, id: ID, type: 'identify', body: { duration_ms: 1000 } });
  const raw = signed(cmd).replace('"duration_ms":1000', '"duration_ms":999999,"duration_ms":1000');
  assert.deepEqual([check(raw).status, check(raw).reason], ['bad_format', 'duplicate_key']);
});

test('sig вложенный где угодно, кроме верхнего уровня, — bad_format', () => {
  assert.deepEqual(parseStrict('{"sig":"x","b":{"a":[{"sig":1}]}}'), { ok: false, reason: 'nested_sig' });
  assert.equal(parseStrict('{"sig":"x","b":{"a":[{"sig2":1}]}}').ok, true);
});

test('предел вложенности', () => {
  let deep = '1';
  for (let i = 0; i < LIMITS.maxDepth + 1; i += 1) deep = `[${deep}]`;
  assert.deepEqual(parseStrict(deep), { ok: false, reason: 'too_deep' });
});

test('размер cmd: 2048 байт принимается, 2049 — bad_format', () => {
  const base = makeCommand({ seq: 3, id: ID, body: { pad: '' } });
  const fill = LIMITS.maxBytes - Buffer.byteLength(signed(base));
  const exact = makeCommand({ seq: 3, id: ID, body: { pad: 'x'.repeat(fill) } });
  assert.equal(Buffer.byteLength(signed(exact)), 2048);
  assert.equal(check(signed(exact)).status, 'ok');
  const over = makeCommand({ seq: 3, id: ID, body: { pad: 'x'.repeat(fill + 1) } });
  assert.deepEqual([check(signed(over)).status, check(signed(over)).reason], ['bad_format', 'too_large']);
});

test('корректная подписанная команда проходит; неизвестное поле верхнего уровня входит в подпись', () => {
  const cmd = { ...makeCommand({ seq: 7, id: ID }), extra: 'x' };
  assert.equal(check(signed(cmd)).status, 'ok');
  const tampered = JSON.stringify({ ...JSON.parse(signed(cmd)), extra: 'y' });
  assert.equal(check(tampered).status, 'bad_sig');
});

test('issued_at обязателен: целое ≥ 0', () => {
  const { issued_at: _drop, ...noIssued } = makeCommand({ seq: 8, id: ID });
  assert.equal(check(signed(noIssued)).reason, 'missing_issued_at');
  assert.equal(check(signed({ ...noIssued, issued_at: 0 })).status, 'ok');
  assert.equal(check(signed({ ...noIssued, issued_at: -1 })).reason, 'bad_issued_at');
  assert.equal(check(signed({ ...noIssued, issued_at: '1792598400' })).reason, 'bad_issued_at');
});

for (const [name, patch, reason] of [
  ['id не UUID', { id: 'abc' }, 'bad_id'],
  ['id в верхнем регистре', { id: ID.toUpperCase() }, 'bad_id'],
  ['seq = 0', { seq: 0 }, 'bad_seq'],
  ['seq < 0', { seq: -3 }, 'bad_seq'],
  ['seq строкой', { seq: '5' }, 'bad_seq'],
  ['type пустой', { type: '' }, 'bad_type'],
  ['type числом', { type: 1 }, 'bad_type'],
  ['body массивом', { body: [] }, 'bad_body_not_object'],
  ['body = null', { body: null }, 'bad_body_not_object'],
  ['v строкой', { v: '1' }, 'bad_v'],
]) {
  test(`bad_format: ${name}`, () => {
    const cmd = { ...makeCommand({ seq: 9, id: ID }), ...patch };
    const r = check(signed(cmd));
    assert.equal(r.status, 'bad_format');
    assert.equal(r.reason, reason);
  });
}

test('bad_format: верхний уровень не объект, нет body, не UTF-8, BOM', () => {
  assert.equal(check('[1,2]').reason, 'not_object');
  assert.equal(check('"x"').reason, 'not_object');
  const { body: _b, ...noBody } = makeCommand({ seq: 9, id: ID });
  assert.equal(check(signed(noBody)).reason, 'missing_body');
  assert.equal(check(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])).reason, 'not_utf8');
  assert.equal(check(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(signed(makeCommand({ seq: 1 })))])).status, 'bad_format');
});

test('после bad_format cmd_id и seq в ack — null, даже если id и seq разобрались', () => {
  const r = check(signed({ ...makeCommand({ seq: 9, id: ID }), v: 2 }));
  assert.equal(r.status, 'bad_format');
  assert.deepEqual([r.echo.cmdId, r.echo.seq], [null, null]);
});

test('sig: ровно 44 символа base64 от 32 байт с одним =, иначе bad_sig; не-ASCII в sig — bad_format', () => {
  const cmd = makeCommand({ seq: 10, id: ID });
  const good = testSig(cmd);
  assert.equal(check(JSON.stringify({ ...cmd, sig: good })).status, 'ok');

  // Неканоническая запись тех же байт: ненулевые хвостовые биты последнего символа.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const twin = alphabet[alphabet.indexOf(good[42]) ^ 1];
  const noncanonical = `${good.slice(0, 42)}${twin}=`;
  assert.deepEqual(Buffer.from(noncanonical, 'base64'), Buffer.from(good, 'base64'));
  assert.equal(decodeSig(noncanonical), null);
  assert.equal(check(JSON.stringify({ ...cmd, sig: noncanonical })).reason, 'sig_format');

  for (const sig of [good.slice(0, -1), `${good}=`, `${good.slice(0, 43)}A`, Buffer.alloc(16).toString('base64'), 12345, null, '']) {
    assert.equal(check(JSON.stringify({ ...cmd, sig })).reason, 'sig_format', String(sig));
  }
  assert.equal(check(JSON.stringify({ ...cmd, sig: Buffer.alloc(32).toString('base64') })).reason, 'sig_mismatch');
  assert.equal(check(JSON.stringify({ ...cmd, sig: 'подпись' })).status, 'bad_format');
});

test('пробелы и переносы в сыром сообщении не влияют на подпись', () => {
  const cmd = makeCommand({ seq: 12, id: ID, type: 'identify', body: { duration_ms: 5 } });
  const pretty = JSON.stringify({ ...cmd, sig: testSig(cmd) }, null, 3);
  assert.equal(check(pretty).status, 'ok');
});
