import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditView, groupByDate, ACTION_LABEL, ACTION_GROUPS, MANUAL_ACTIONS } from '../src/lib/audit.js';
import { zoneOffsetMinutes, startOfLocalDay, periodRange } from '../src/lib/zone.js';
import { alarmView, sortAlarms } from '../src/lib/alarms.js';
import { mergeHall } from '../src/lib/hall.js';
import { minutesShort, requestTitle, agoWords } from '../src/lib/words.js';
import { CHIME } from '../src/lib/sound.js';

const TZ = 'Asia/Yekaterinburg';

test('все действия журнала M1 (контракт §8) подписаны словами', () => {
  const m1 = ['device.cmd', 'device.event', 'session.start', 'session.extend', 'session.stop', 'session.close', 'session.interrupted', 'session.resolve',
    'payment.succeeded', 'payment.canceled', 'payment.refunded', 'reception.accept', 'reception.decline', 'service.start', 'service.stop',
    'manual.extend_free', 'alarm.raised', 'alarm.ack', 'device.bind', 'device.claim', 'auth.staff_login', 'auth.pin_switch'];
  for (const a of m1) assert.ok(ACTION_LABEL[a], a);
  for (const g of ACTION_GROUPS.slice(1)) assert.match(g.value, /^[a-z_.*,]+$/);
  assert.ok(MANUAL_ACTIONS.has('manual.extend_free') && MANUAL_ACTIONS.has('service.start'));
});

test('запись журнала для экрана: время клуба, стол, детали, причина, ручное действие', () => {
  const v = auditView({
    id: 'a', seq: 1283, created_at: '2026-10-21T16:18:00Z', action: 'service.start', actor_type: 'staff', actor_name: 'Анна К.',
    resource_number: 5, reason: 'Протираем сукно', data: { minutes: 30, reason_code: 'cleaning' }, hash: 'eb852fc9aa',
  }, TZ);
  assert.equal(v.time, '21:18');
  assert.equal(v.date, '21 октября');
  assert.equal(v.title, 'Сервисный свет включён');
  assert.equal(v.table, 'Стол 5');
  assert.deepEqual(v.details, ['30 минут', 'Уборка']);
  assert.equal(v.reason, 'Протираем сукно');
  assert.equal(v.manual, true);
  assert.equal(v.hash, 'eb852fc9…');
  const pay = auditView({ seq: 1, created_at: '2026-10-21T16:00:00Z', action: 'payment.succeeded', actor_type: 'guest', data: { method: 'sbp', amount_kopecks: 80000 } }, TZ);
  assert.deepEqual(pay.details, ['800 ₽', 'СБП']);
  assert.equal(pay.actor, 'Гость');
  assert.equal(auditView({ action: 'x.unknown', created_at: '2026-10-21T16:00:00Z' }, TZ).title, 'x.unknown');
  const groups = groupByDate([v, pay, { ...pay, date: '20 октября' }]);
  assert.deepEqual(groups.map((g) => [g.date, g.items.length]), [['21 октября', 2], ['20 октября', 1]]);
});

test('сутки клуба по его поясу, а не по поясу устройства (инвариант 10)', () => {
  const now = Date.parse('2026-10-21T20:30:00Z'); // 01:30 22 октября в Екатеринбурге
  assert.equal(zoneOffsetMinutes(now, TZ), 300);
  assert.equal(zoneOffsetMinutes(now, 'Europe/Moscow'), 180);
  assert.equal(new Date(startOfLocalDay(now, TZ)).toISOString(), '2026-10-21T19:00:00.000Z');
  assert.equal(new Date(startOfLocalDay(now, TZ, 1)).toISOString(), '2026-10-20T19:00:00.000Z');
  assert.deepEqual(periodRange('yesterday', now, TZ), { from: '2026-10-20T19:00:00.000Z', to: '2026-10-21T19:00:00.000Z' });
  assert.equal(periodRange('week', now, TZ).from, '2026-10-15T19:00:00.000Z');
  assert.deepEqual(periodRange('today', now, TZ), { from: '2026-10-21T19:00:00.000Z', to: '2026-10-21T20:30:00.000Z' });
  // пояс с переходом на летнее время
  assert.equal(new Date(startOfLocalDay(Date.parse('2026-03-29T12:00:00Z'), 'Europe/Berlin')).toISOString(), '2026-03-28T23:00:00.000Z');
});

test('тревоги: текст, уровень словом, сначала критичные', () => {
  const v = alarmView({ type: 'bypass_detected', level: 'critical', resource_number: 2 });
  assert.equal(v.title, 'Свет горит без оплаты');
  assert.equal(v.levelWord, 'Критично');
  assert.equal(v.table, 'Стол 2');
  assert.match(alarmView({ type: 'new_kind', level: 'weird' }).text, /new_kind/);
  assert.equal(alarmView({ type: 'new_kind', level: 'weird' }).level, 'important');
  const sorted = sortAlarms([
    { id: 1, level: 'info', created_at: '2026-10-21T16:00:00Z' },
    { id: 2, level: 'critical', created_at: '2026-10-21T15:00:00Z' },
    { id: 3, level: 'critical', created_at: '2026-10-21T16:30:00Z' },
  ]);
  assert.deepEqual(sorted.map((a) => a.id), [3, 2, 1]);
});

test('событие hall: один стол или весь зал', () => {
  const hall = [{ resource: { id: 'a' }, status: 'free' }, { resource: { id: 'b' }, status: 'busy' }];
  assert.equal(mergeHall(hall, { resource: { id: 'a' }, status: 'service' })[0].status, 'service');
  assert.equal(mergeHall(hall, { resource: { id: 'c' }, status: 'free' }).length, 3);
  assert.equal(mergeHall(hall, [{ resource: { id: 'z' } }]).length, 1);
  assert.equal(mergeHall(hall, { nothing: true }), hall);
  assert.equal(mergeHall(null, { resource: { id: 'a' } }), null);
});

test('плитка ресепшена «Стол 4 · 2 ч · 1 600 ₽» (контракт §10)', () => {
  assert.equal(requestTitle({ resource_number: 4, minutes: 120, amount_kopecks: 160000 }), 'Стол 4 · 2 ч · 1 600 ₽');
  assert.equal(minutesShort(90), '1 ч 30 мин');
  assert.equal(minutesShort(30), '30 мин');
  assert.equal(minutesShort(null), 'без лимита');
  assert.equal(agoWords(20_000), 'только что');
  assert.equal(agoWords(2 * 60_000), '2 минуты назад');
  assert.equal(agoWords(5 * 60_000), '5 минут назад');
  assert.equal(agoWords(61 * 60_000), '1 час назад');
});

test('звук заявки синтезируется, без файлов', () => {
  assert.ok(CHIME.length >= 2);
  for (const [f, d, dur, vol] of CHIME) {
    assert.ok(f > 200 && f < 4000 && d >= 0 && dur > 0 && dur < 2 && vol > 0 && vol <= 0.5);
  }
});
