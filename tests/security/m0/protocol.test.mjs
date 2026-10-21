// PoC безопасности M0 — протокол v1 (объект атаки 4, docs/protocol.md §3, decisions №23).
// Атакующий: посторонний (без ключа) и устройство с украденной учёткой.
// Проверяется: канонизация сервера и симулятора совпадают (нет расхождения для обхода
// подписи); подделанная/искажённая команда → bad_sig; точный повтор не исполняется;
// device_key привязан к device_id (AAD) и к ключу шифрования.
//
// Запуск: node --test tests/security/m0/protocol.test.mjs

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import * as srv from '../../../server/lib/protocol.mjs';
import * as simCanon from '../../../tools/device-sim/lib/canonical.mjs';
import * as simCmd from '../../../tools/device-sim/lib/command.mjs';
import { decideReplay } from '../../../tools/device-sim/lib/replay.mjs';
import { decryptSecret, deviceKeyContext, encryptSecret, loadEncKey } from '../../../server/lib/secrets.mjs';
import { REPO_ROOT } from './_env.mjs';

const VECTORS = JSON.parse(readFileSync(path.join(REPO_ROOT, 'docs/protocol-vectors.json'), 'utf8'));
const vectors = Array.isArray(VECTORS) ? VECTORS : VECTORS.vectors;

test('канонизация сервера и симулятора совпадают на всех 38 векторах (нет расхождения для обхода подписи)', () => {
  for (const vec of vectors) {
    const key = Buffer.from(vec.key_b64, 'base64');
    const srvRes = srv.verifyCommand(Buffer.from(vec.raw, 'utf8'), key);
    const simRes = simCmd.verifyCommand(Buffer.from(vec.raw, 'utf8'), key);
    const srvStatus = srvRes.result;
    const simStatus = simRes.status;
    assert.equal(srvStatus, simStatus, `вектор ${vec.name}: сервер=${srvStatus} симулятор=${simStatus}`);
    assert.equal(srvStatus, vec.expect, `вектор ${vec.name}: ожидали ${vec.expect}, сервер дал ${srvStatus}`);
    if (vec.canonical !== undefined && (srvStatus === 'ok' || srvStatus === 'bad_sig')) {
      assert.equal(srvRes.canonical, vec.canonical, `вектор ${vec.name}: канон сервера расходится с эталоном`);
      assert.equal(simRes.canonical, vec.canonical, `вектор ${vec.name}: канон симулятора расходится с эталоном`);
    }
  }
});

test('фуззинг канонизации: сервер и симулятор дают одинаковую строку (нет щели для подмены)', () => {
  const rnd = mulberry32(0xC0FFEE);
  for (let i = 0; i < 3000; i += 1) {
    const obj = genObject(rnd, 0);
    let a; let b;
    try { a = srv.canonicalize(obj); } catch { a = 'ERR'; }
    try { b = simCanon.canonicalize(obj); } catch { b = 'ERR'; }
    assert.equal(a, b, `расхождение канонизации на ${JSON.stringify(obj)}`);
  }
});

test('команда с подделанной/изменённой подписью отвергается (bad_sig), верная — ok', () => {
  const key = randomBytes(32);
  const built = srv.buildCommand({ seq: 5, type: 'ping', body: {}, issuedAt: 1792598400 }, key);
  // Верная подпись — ok на обеих сторонах.
  assert.equal(srv.verifyCommand(built.payload, key).result, 'ok');
  assert.equal(simCmd.verifyCommand(Buffer.from(built.payload, 'utf8'), key).status, 'ok');

  // Чужой ключ (атакующий не знает device_key) — bad_sig.
  const otherKey = randomBytes(32);
  assert.equal(srv.verifyCommand(built.payload, otherKey).result, 'bad_sig');
  assert.equal(simCmd.verifyCommand(Buffer.from(built.payload, 'utf8'), otherKey).status, 'bad_sig');

  // Изменение тела при сохранённой подписи — bad_sig.
  const tampered = built.payload.replace('"seq":5', '"seq":6');
  assert.notEqual(tampered, built.payload);
  assert.equal(srv.verifyCommand(tampered, key).result, 'bad_sig');
  assert.equal(simCmd.verifyCommand(Buffer.from(tampered, 'utf8'), key).status, 'bad_sig');
});

test('точный повтор (тот же seq и id) не исполняется, а чужой id/меньший seq — replayed', () => {
  const saved = { seq: 10, id: '0192f3c1-6d1a-7c3e-9b2a-1f0e5d4c3b2a' };
  assert.equal(decideReplay(saved, 11, 'any'), 'execute');
  assert.equal(decideReplay(saved, 10, saved.id), 'resend'); // точный повтор: отдать сохранённый ack, не исполнять
  assert.equal(decideReplay(saved, 10, '0192f3c1-6d1a-7c3e-9b2a-ffffffffffff'), 'replayed');
  assert.equal(decideReplay(saved, 9, saved.id), 'replayed');
});

test('device_key: шифртекст одного устройства не расшифровывается в контексте другого (AAD)', () => {
  const encKey = loadEncKey(randomBytes(32).toString('base64'));
  const devA = 'd1000000-0000-4000-8000-000000000001';
  const devB = 'd1000000-0000-4000-8000-000000000002';
  const deviceKey = randomBytes(32);
  const enc = encryptSecret(deviceKey, encKey, deviceKeyContext(devA));
  // Правильный контекст — расшифровывается.
  assert.deepEqual(decryptSecret(enc, encKey, deviceKeyContext(devA)), deviceKey);
  // Контекст другого устройства — отказ (AAD-привязка к device_id).
  assert.throws(() => decryptSecret(enc, encKey, deviceKeyContext(devB)), /не расшифровыва/);
  // Другой ключ шифрования (дамп базы без .env) — отказ.
  const otherEncKey = loadEncKey(randomBytes(32).toString('base64'));
  assert.throws(() => decryptSecret(enc, otherEncKey, deviceKeyContext(devA)), /не расшифровыва/);
});

test('подмена одного байта шифртекста device_key ломает GCM-тег (нет тихой подмены)', () => {
  const encKey = loadEncKey(randomBytes(32).toString('base64'));
  const ctx = deviceKeyContext('d1000000-0000-4000-8000-000000000001');
  const enc = encryptSecret(randomBytes(32), encKey, ctx);
  const raw = Buffer.from(enc.slice('v1:'.length), 'base64');
  raw[raw.length - 1] ^= 0x01;
  const tampered = `v1:${raw.toString('base64')}`;
  assert.throws(() => decryptSecret(tampered, encKey, ctx), /не расшифровыва/);
});

// ---- генераторы фуззинга ----
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function genKey(rnd) {
  const alpha = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.';
  const n = 1 + Math.floor(rnd() * 6);
  let s = '';
  for (let i = 0; i < n; i += 1) s += alpha[Math.floor(rnd() * alpha.length)];
  return s;
}
function genScalar(rnd) {
  const k = Math.floor(rnd() * 5);
  if (k === 0) return null;
  if (k === 1) return rnd() < 0.5;
  if (k === 2) return Math.floor((rnd() - 0.5) * 2 * 9007199254740990);
  if (k === 3) return genKey(rnd);
  return [];
}
function genObject(rnd, depth) {
  if (depth >= 4 || rnd() < 0.3) return genScalar(rnd);
  const asArray = rnd() < 0.3;
  if (asArray) {
    const n = Math.floor(rnd() * 4);
    return Array.from({ length: n }, () => genObject(rnd, depth + 1));
  }
  const n = Math.floor(rnd() * 5);
  const o = {};
  for (let i = 0; i < n; i += 1) o[genKey(rnd)] = genObject(rnd, depth + 1);
  return o;
}
