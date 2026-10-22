import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinErrorKind, pinMinLength, pinValid, sortTerminals, terminalState } from '../src/lib/terminals.js';
import { alarmView } from '../src/lib/alarms.js';
import { refundDoneText } from '../src/lib/packages.js';
import { createBackend } from '../src/mock/backend.js';

const MIN = 60_000;
const T = Date.parse('2026-10-22T12:00:00Z');
const iso = (x) => new Date(x).toISOString();
const memory = () => {
  let s = null;
  return { load: () => s, save: (v) => (s = structuredClone(v)) };
};
const req = (b, method, path, body) => b.handle(method, { href: `http://x${path}`, body });

test('PIN: владелец и управляющий — ровно 6 цифр, остальные — 4–6 (ревью входа п. 5)', () => {
  assert.equal(pinMinLength('owner'), 6);
  assert.equal(pinMinLength('manager'), 6);
  assert.equal(pinMinLength('reception'), 4);
  assert.equal(pinValid('1234', 'owner'), false);
  assert.equal(pinValid('123456', 'owner'), true);
  assert.equal(pinValid('1234', 'bar'), true);
  assert.equal(pinValid('1234567', 'bar'), false);
  assert.equal(pinValid('12a4', 'bar'), false);
});

test('ошибка PIN: 401 — неверный, 429 с Retry-After — PIN заблокирован, без — заблокирован терминал', () => {
  assert.equal(pinErrorKind({ code: 'unauthorized' }), 'pin_wrong');
  assert.equal(pinErrorKind({ code: 'rate_limited', retryAfterSec: 840 }), 'pin_locked');
  assert.equal(pinErrorKind({ code: 'rate_limited', retryAfterSec: null }), 'terminal_locked');
  const other = { code: 'network' };
  assert.equal(pinErrorKind(other), other);
});

test('терминалы: состояние и порядок — заблокированные сверху, отозванные внизу', () => {
  const base = { created_at: iso(T - 10 * MIN), expires_at: iso(T + 60 * MIN), revoked_at: null, locked_at: null };
  assert.equal(terminalState(base, T).state, 'active');
  assert.equal(terminalState({ ...base, locked_at: iso(T - MIN) }, T).canUnlock, true);
  assert.equal(terminalState({ ...base, revoked_at: iso(T - MIN), locked_at: iso(T - MIN) }, T).state, 'revoked');
  assert.equal(terminalState({ ...base, expires_at: iso(T - MIN) }, T).state, 'expired');
  const list = sortTerminals(
    [
      { ...base, id: 'r', revoked_at: iso(T - MIN) },
      { ...base, id: 'a' },
      { ...base, id: 'l', locked_at: iso(T - MIN) },
    ],
    T,
  );
  assert.deepEqual(list.map((x) => x.id), ['l', 'a', 'r']);
});

test('новые тревоги — словами, с суммой из data', () => {
  for (const type of ['refund_canceled', 'cash_refund_awaiting_shift', 'terminal_locked', 'booking_table_unavailable', 'booking_step_failed', 'club_timezone_invalid', 'pos_refund_canceled']) {
    const v = alarmView({ type, level: 'important', data: {} });
    assert.ok(!v.text.includes('Тип:'), `${type}: свой текст`);
  }
  assert.match(alarmView({ type: 'refund_canceled', data: { amount_kopecks: 150000, lots_restored: 1 } }).title, /1\s500\s₽/);
  assert.match(alarmView({ type: 'refund_canceled', data: { amount_kopecks: 150000, lots_restored: 1 } }).text, /Пакет часов снова действует/);
  assert.match(alarmView({ type: 'pos_refund_canceled', data: { amount_kopecks: 32000, packages_lost: 1 } }).text, /начислите гостю заново/);
  assert.match(alarmView({ type: 'cash_refund_awaiting_shift', data: { amount_kopecks: 50000 } }).title, /при открытии смены/);
});

test('возврат наличными без смены — «Вернём наличными при открытии смены»', () => {
  const q = refundDoneText({ title: '5 часов', amount: 300000, via: 'pos', status: 'queued' });
  assert.equal(q.queued, true);
  assert.match(q.title, /вернём 3\s000\s₽ наличными при открытии смены/);
  assert.equal(refundDoneText({ title: '5 часов', amount: 300000, via: 'app', status: 'succeeded' }).queued, false);
});

test('заглушка: терминалы владельца — список, разблокировка, отзыв; PIN 6 цифр у владельца', async () => {
  const b = createBackend(memory(), () => T);
  b.scenario('owner');
  const list = (await req(b, 'GET', '/api/clubs/c/terminals')).body;
  assert.ok(Array.isArray(list) && list.length === 3);
  for (const k of ['id', 'name', 'created_by', 'created_at', 'expires_at', 'last_used_at', 'revoked_at', 'locked_at']) assert.ok(k in list[0], k);
  const locked = list.find((x) => x.locked_at);
  assert.equal((await req(b, 'POST', `/api/clubs/c/terminals/${locked.id}/unlock`)).status, 200);
  assert.equal((await req(b, 'GET', '/api/clubs/c/terminals')).body.find((x) => x.id === locked.id).locked_at, null);
  assert.equal((await req(b, 'DELETE', `/api/clubs/c/terminals/${locked.id}`)).status, 200);
  assert.ok((await req(b, 'GET', '/api/clubs/c/terminals')).body.find((x) => x.id === locked.id).revoked_at);
  assert.equal((await req(b, 'PUT', '/api/staff/pin', { club_id: 'c', pin: '1234' })).body.error, 'bad_request');
  assert.equal((await req(b, 'PUT', '/api/staff/pin', { club_id: 'c', pin: '123456' })).status, 200);
  b.scenario('pos');
  assert.equal((await req(b, 'GET', '/api/clubs/c/terminals')).body.error, 'forbidden');
});
