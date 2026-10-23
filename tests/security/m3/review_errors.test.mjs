// Перепроверка ревью п. 5: ошибки API несут только безопасные поля по белому списку —
// никаких ПДн (имя, телефон) и произвольных полей рядом с { error }.
// server/http/errors.mjs (safeErrorData, toHttpError), server/payments/errors.mjs (publicData),
// server/sessions/errors.mjs и server/bookings/errors.mjs.
//
// Запуск (без БД): node --test tests/security/m3/review_errors.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError, safeErrorData, toHttpError } from '../../../server/http/errors.mjs';
import { MoneyError, publicData } from '../../../server/payments/errors.mjs';
import { LightError, errorResponse } from '../../../server/sessions/errors.mjs';

const UUID = '11111111-2222-4333-8444-555555555555';

test('safeErrorData пропускает только поля белого списка и безопасные значения', () => {
  const out = safeErrorData({
    booking_id: UUID,
    session_id: UUID,
    resource_id: UUID,
    busy_until: '2026-10-26T12:00:00.000Z',
    retry_after_sec: 30,
    minutes_left: 0,
    // Всё ниже должно быть отброшено:
    guest_name: 'Иван Тайный',
    guest_phone: '+79991234567',
    phone: '+79991234567',
    error: 'spoofed',
    sql: 'select 1',
    nested: { a: 1 },
    arr: [1, 2],
    html: '<script>',
  });
  assert.deepEqual(Object.keys(out).sort(), ['booking_id', 'busy_until', 'minutes_left', 'resource_id', 'retry_after_sec', 'session_id']);
  assert.ok(!JSON.stringify(out).includes('Иван') && !JSON.stringify(out).includes('7999'));
});

test('safeErrorData отбрасывает значения не того вида в разрешённых полях', () => {
  assert.equal(safeErrorData({ booking_id: 'не-uuid' }), null);
  assert.equal(safeErrorData({ booking_id: "'; drop table" }), null);
  assert.equal(safeErrorData({ session_id: { toString: () => UUID } }), null);
  assert.equal(safeErrorData({ busy_until: 'вчера' }), null);
  assert.equal(safeErrorData({ minutes_left: 1.5 }), null);
  assert.equal(safeErrorData({ minutes_left: '5' }), null);
  assert.deepEqual(safeErrorData({ booking_id: UUID, extra: 1 }), { booking_id: UUID });
  assert.equal(safeErrorData(null), null);
  assert.equal(safeErrorData([1, 2]), null);
  assert.equal(safeErrorData('строка'), null);
});

test('toHttpError отдаёт data только для 4xx и только безопасные поля; на 5xx — без данных', () => {
  const e4 = toHttpError(new HttpError(409, 'booking_conflict', { data: { booking_id: UUID, guest_phone: '+70001112233' } }));
  assert.equal(e4.status, 409);
  assert.equal(e4.code, 'booking_conflict');
  assert.deepEqual(e4.data, { booking_id: UUID });
  // 5xx не несёт данных, даже если их подложили.
  const e5 = toHttpError(Object.assign(new Error('x'), { status: 500, code: 'internal', data: { booking_id: UUID } }));
  assert.equal(e5.status, 500);
  assert.equal(e5.data, undefined, '5xx не несёт data');
  // Поле error в data не перетирает код ответа.
  const e = toHttpError(new HttpError(400, 'bad_request', { data: { error: 'hacked', booking_id: UUID } }));
  assert.equal(e.code, 'bad_request');
  assert.ok(!('error' in (e.data ?? {})));
});

test('MoneyError.publicData: только booking_id и только короткий код/uuid; телефон отбрасывается', () => {
  const e = new MoneyError('booking_start_required', 'detail', undefined, { booking_id: UUID, guest_phone: '+79990001122', secret: 'x' });
  assert.deepEqual(e.data, { booking_id: UUID });
  assert.equal(publicData({ guest_phone: '+79990001122' }), undefined);
  assert.equal(publicData({ booking_id: 'has space' }), undefined, 'пробел в значении — отброшено');
  assert.equal(publicData({}), undefined);
  // moneyRoute без роутера отдаёт { error, ...data }.
  const { errorResponse: moneyErrResp } = { errorResponse: (err) => ({ status: err.status, json: { error: err.code, ...(err.data ?? {}) } }) };
  assert.deepEqual(moneyErrResp(e), { status: 409, json: { error: 'booking_start_required', booking_id: UUID } });
});

test('LightError.errorResponse: безопасное поле booking_id отдаётся, ничего лишнего', () => {
  const ok = errorResponse(new LightError('booking_start_required', 'booking', { booking_id: UUID }));
  assert.deepEqual(ok, { status: 409, json: { error: 'booking_start_required', booking_id: UUID } });
  const plain = errorResponse(new LightError('table_busy', 'идёт игра'));
  assert.deepEqual(plain, { status: 409, json: { error: 'table_busy' } });
  // Ошибка не LightError пробрасывается (роутер отдаст 500 без данных).
  assert.throws(() => errorResponse(new Error('boom')), /boom/);
});
