// Края правил §3.1, которых нет в общих векторах.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, LIMITS, parseStrict } from '../lib/canonical.mjs';
import { decodeBase64Strict, verifyCommand } from '../lib/command.mjs';
import { makeCommand, signed, testSig, TEST_KEY_B64 } from './helpers/sign.mjs';

const KEY = Buffer.from(TEST_KEY_B64, 'base64');
const ID = '0192f3c1-6d1a-7c3e-9b2a-00000000aaaa';

// Подписывает команду, затем подставляет сырой фрагмент вместо маркера.
function rawWith(body, marker, rawValue) {
  const cmd = makeCommand({ seq: 5, id: ID, type: 'ping', body });
  return signed(cmd).replace(`"${marker}"`, rawValue);
}

const status = (raw) => verifyCommand(Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8'), KEY);

test('ключи по возрастанию байтов: заглавные, подчёркивание, строчные', () => {
  const s = canonicalize({ b: 1, a: 2, B: 3, _: 4, a1: 5, A: 6, '': 7 });
  assert.equal(s, '{"":7,"A":6,"B":3,"_":4,"a":2,"a1":5,"b":1}');
});

test('вложенные объекты и массивы: порядок массива сохраняется', () => {
  assert.equal(canonicalize({ z: [3, { y: true, x: null }, 'q'], a: false }), '{"a":false,"z":[3,{"x":null,"y":true},"q"]}');
});

test('-0 разбирается как целое и канонизируется в 0', () => {
  const p = parseStrict('{"a":-0}');
  assert.equal(p.ok, true);
  assert.equal(canonicalize(p.value), '{"a":0}');
});

test('границы ±(2^53−1) принимаются, 2^53 и 1E5 — нет', () => {
  assert.equal(parseStrict('[9007199254740991,-9007199254740991]').ok, true);
  assert.deepEqual(parseStrict('[9007199254740992]'), { ok: false, reason: 'number_out_of_range' });
  assert.deepEqual(parseStrict('[-9007199254740992]'), { ok: false, reason: 'number_out_of_range' });
  assert.deepEqual(parseStrict('[1E5]'), { ok: false, reason: 'number_not_integer' });
  assert.deepEqual(parseStrict('[0.0]'), { ok: false, reason: 'number_not_integer' });
});

test('строки: управляющие символы, обратная косая и не-ASCII — bad_format', () => {
  assert.equal(parseStrict('{"a":"x\\ny"}').ok, false);
  assert.equal(parseStrict('{"a":"x\\\\y"}').ok, false);
  assert.equal(parseStrict('{"a":"\\u00e9"}').ok, false);
  assert.equal(parseStrict('{"a":"\\ud800"}').ok, false);
  assert.equal(parseStrict('{"ключ":1}').ok, false);
  assert.equal(parseStrict('{"a\\"b":1}').ok, false);
});

test('экранирование печатного символа (\\u0041) даёт обычную строку: проверяется разобранное значение', () => {
  const p = parseStrict('{"a":"\\u0041"}');
  assert.equal(p.ok, true);
  assert.equal(canonicalize(p.value), '{"a":"A"}');
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

test('корректная подписанная команда проходит; неизвестное поле верхнего уровня входит в подпись', () => {
  const cmd = { ...makeCommand({ seq: 7, id: ID }), extra: 'x' };
  assert.equal(status(signed(cmd)).status, 'ok');
  const tampered = JSON.stringify({ ...JSON.parse(signed(cmd)), extra: 'y' });
  assert.equal(status(tampered).status, 'bad_sig');
});

test('issued_at необязателен, но если есть — целое', () => {
  const { issued_at: _drop, ...noIssued } = makeCommand({ seq: 8, id: ID });
  assert.equal(status(signed(noIssued)).status, 'ok');
  assert.equal(status(signed({ ...noIssued, issued_at: '1792598400' })).reason, 'bad_issued_at');
});

for (const [name, patch, reason] of [
  ['id не UUID', { id: 'abc' }, 'bad_id'],
  ['seq = 0', { seq: 0 }, 'bad_seq'],
  ['seq < 0', { seq: -3 }, 'bad_seq'],
  ['seq строкой', { seq: '5' }, 'bad_seq'],
  ['type пустой', { type: '' }, 'bad_type'],
  ['type числом', { type: 1 }, 'bad_type'],
  ['body массивом', { body: [] }, 'bad_body'],
  ['body = null', { body: null }, 'bad_body'],
  ['v строкой', { v: '1' }, 'bad_v'],
]) {
  test(`bad_format: ${name}`, () => {
    const cmd = { ...makeCommand({ seq: 9, id: ID }), ...patch };
    const r = status(signed(cmd));
    assert.equal(r.status, 'bad_format');
    assert.equal(r.reason, reason);
  });
}

test('bad_format: верхний уровень не объект, нет body, не UTF-8, BOM, слишком длинное сообщение', () => {
  assert.equal(status('[1,2]').reason, 'not_object');
  assert.equal(status('"x"').reason, 'not_object');
  const { body: _b, ...noBody } = makeCommand({ seq: 9, id: ID });
  assert.equal(status(signed(noBody)).reason, 'missing_body');
  assert.equal(status(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])).reason, 'not_utf8');
  assert.equal(status(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(signed(makeCommand({ seq: 1 })))])).status, 'bad_format');
  const big = makeCommand({ seq: 9, id: ID, body: { pad: 'x'.repeat(LIMITS.maxBytes) } });
  assert.equal(status(signed(big)).reason, 'too_large');
});

test('ack после bad_format не повторяет неверные id и seq', () => {
  const r = status(signed({ ...makeCommand({ seq: 9 }), id: 'не-uuid', seq: 1.5 }));
  assert.equal(r.status, 'bad_format');
  assert.deepEqual([r.echo.cmdId, r.echo.seq], [null, null]);
});

test('sig: строгий base64 из 32 байт, иначе bad_sig; не-ASCII в sig — bad_format', () => {
  const cmd = makeCommand({ seq: 10, id: ID });
  const good = testSig(cmd);
  assert.equal(status(JSON.stringify({ ...cmd, sig: good })).status, 'ok');

  // Неканоническая запись тех же байт: последний символ с ненулевыми хвостовыми битами.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const last = good[good.length - 2];
  const twin = alphabet[alphabet.indexOf(last) ^ 1];
  const noncanonical = `${good.slice(0, -2)}${twin}=`;
  assert.deepEqual(Buffer.from(noncanonical, 'base64'), Buffer.from(good, 'base64'));
  assert.equal(decodeBase64Strict(noncanonical), null);
  assert.equal(status(JSON.stringify({ ...cmd, sig: noncanonical })).reason, 'sig_not_base64');

  assert.equal(status(JSON.stringify({ ...cmd, sig: good.slice(0, -1) })).reason, 'sig_not_base64');
  assert.equal(status(JSON.stringify({ ...cmd, sig: Buffer.alloc(16).toString('base64') })).reason, 'sig_mismatch');
  assert.equal(status(JSON.stringify({ ...cmd, sig: 12345 })).reason, 'sig_not_base64');
  assert.equal(status(JSON.stringify({ ...cmd, sig: null })).reason, 'sig_not_base64');
  assert.equal(status(JSON.stringify({ ...cmd, sig: 'подпись' })).status, 'bad_format');
});

test('повторяющийся ключ: как у JSON.parse, побеждает последний, подпись — по разобранному объекту', () => {
  // Протокол поведение не задаёт (замечание в ревью M0). Подменить значение так нельзя:
  // если подписан другой объект, проверка даёт bad_sig.
  const cmd = makeCommand({ seq: 11, id: ID, type: 'identify', body: { duration_ms: 1000 } });
  const raw = signed(cmd).replace('"duration_ms":1000', '"duration_ms":999999,"duration_ms":1000');
  assert.equal(status(raw).status, 'ok');
  const raw2 = signed(cmd).replace('"duration_ms":1000', '"duration_ms":1000,"duration_ms":999999');
  assert.equal(status(raw2).status, 'bad_sig');
});

test('пробелы и переносы в сыром сообщении не влияют на подпись', () => {
  const cmd = makeCommand({ seq: 12, id: ID, type: 'identify', body: { duration_ms: 5 } });
  const pretty = JSON.stringify({ ...cmd, sig: testSig(cmd) }, null, 3);
  assert.equal(status(pretty).status, 'ok');
  assert.equal(status(rawWith({ n: 1 }, 'n', '"n" ')).status, 'ok');
});
