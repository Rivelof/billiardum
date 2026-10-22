import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canArrive, lanes, place, startOptions, timelineWindow } from '../src/lib/bookings.js';
import { lotRefundCall, lotView, maskTail, packageItems, packageLine, packagePerHour } from '../src/lib/packages.js';
import { alarmAction, alarmView } from '../src/lib/alarms.js';
import { saleBody, saleTotals } from '../src/lib/pos.js';
import { addFixed, emptyCart } from '@billiardum/shared/bar';
import { createBackend } from '../src/mock/backend.js';

const MIN = 60_000;
const T = Date.parse('2026-10-22T12:00:00Z'); // 17:00 по клубу
const iso = (x) => new Date(x).toISOString();

test('лента броней: окно по часам работы, положение брони в процентах', () => {
  const day = { open_at: iso(T - 5 * 60 * MIN), close_at: iso(T + 9 * 60 * MIN) };
  const win = timelineWindow(day, []);
  assert.equal(win.hours.length, 14);
  const p = place(win, iso(T), iso(T + 2 * 60 * MIN));
  assert.equal(Math.round(p.left * 100) / 100, Math.round((5 / 14) * 10000) / 100);
  assert.equal(Math.round(p.width * 100) / 100, Math.round((2 / 14) * 10000) / 100);
  assert.deepEqual(place(win, iso(T - 10 * 60 * MIN), iso(T - 6 * 60 * MIN)).width, 0, 'до открытия — не видно');
  const rows = lanes({ resources: [{ id: 'b', number: 2, busy: [{ kind: 'booking' }, { kind: 'session' }] }, { id: 'a', number: 1, busy: [] }] }, [{ id: 'x', resource: { id: 'b' }, status: 'confirmed', starts_at: iso(T) }, { id: 'y', resource: { id: 'b' }, status: 'canceled', starts_at: iso(T) }]);
  assert.deepEqual(rows.map((r) => r.resource.number), [1, 2]);
  assert.equal(rows[1].bookings.length, 1, 'отменённые не показываем');
  assert.deepEqual(rows[1].busy.map((x) => x.kind), ['session'], 'брони — отдельными блоками, не штриховкой');
  assert.ok(startOptions({ open_at: iso(T - 60 * MIN), close_at: iso(T + 3 * 60 * MIN), step_minutes: 30, min_minutes: 60 }, T).every((t) => t >= T));
});

test('«гость пришёл» — только бронь по телефону, пока держим стол; возврат пакета — только нетронутый целиком (№118)', () => {
  const phone = { status: 'confirmed', source: 'phone', prepayment_kopecks: 0, paid_kopecks: 0, hold_until: iso(T + 60 * MIN) };
  assert.equal(canArrive(phone, T), true);
  assert.equal(canArrive({ ...phone, source: 'app' }, T), false, 'гость приложения начинает сам по QR');
  assert.equal(canArrive(phone, T + 2 * 60 * MIN), false, 'удержание вышло');

  const app = { id: 'l1', source: 'app', minutes_total: 300, minutes_left: 300, refunded_at: null, price_kopecks: 300000 };
  assert.deepEqual(lotView(app), { refundable: true, word: 'Не тронут', why: null, via: 'app' });
  assert.equal(lotView({ ...app, minutes_left: 299 }).refundable, false, 'хоть минуту потратили — нельзя');
  assert.equal(lotView({ ...app, refunded_at: iso(T) }).word, 'Возвращён');
  assert.equal(lotView({ ...app, source: 'pos', sale_id: null, idx: null }).refundable, false, 'продажа не завершена');
  assert.deepEqual(lotRefundCall(app, 'Переезд'), { kind: 'lot', id: 'l1', body: { reason: 'Переезд' } });
  assert.deepEqual(lotRefundCall({ ...app, source: 'pos', sale_id: 's1', idx: 2 }, 'Переезд'), { kind: 'sale', id: 's1', body: { reason: 'Переезд', packages: [2] } });

  assert.equal(alarmView({ type: 'payment_not_found_at_provider', level: 'important', data: { action: 'canceled' } }).title, 'Платёж не найден в ЮKassa — отменён');
  assert.match(alarmView({ type: 'payment_not_found_at_provider', level: 'critical', data: { action: 'kept' } }).text, /проведён/);

  // Д2: действие тревоги — только известный вид адреса
  const rid = 'c1d2e3f4-0000-4000-8000-00000000d002';
  assert.deepEqual(alarmAction({ data: { action_id: 'retry', action_title: 'Повторить', action_url: `/api/receipts/${rid}/retry` } }), { id: 'retry', title: 'Повторить', receiptId: rid });
  assert.equal(alarmAction({ data: { action_id: 'retry', action_url: 'https://evil.example/api/receipts/x/retry' } }), null);
  assert.equal(alarmAction({ data: { action_id: 'retry', action_url: `/api/staff/${rid}/retry` } }), null);
  assert.equal(alarmAction({ type: 'bypass_detected' }), null);
  assert.equal(alarmAction({ type: 'settlement_receipt_failed', data: { code: 'not_found', receipt_id: rid } }).receiptId, rid, 'старая тревога без action_* — повтор по receipt_id');
});

test('пакет часов в чеке кассы: позиция с телефоном гостя, без скидки, items для сервера', () => {
  const p = { id: 'p1', title: '10 часов', hours: 10, minutes: 600, price_kopecks: 550000 };
  assert.equal(packagePerHour(p), 55000);
  assert.equal(maskTail('+79123456789'), '…67-89');
  let cart = addFixed(emptyCart(), packageLine(p, '+79123456789'));
  cart = addFixed(cart, { key: 'tab:s', kind: 'tab', session_id: 's', name: 'Счёт стола 1', amount_kopecks: 100000 });
  assert.deepEqual(packageItems(cart), [{ kind: 'package', package_id: 'p1', phone: '+79123456789' }]);
  const t = saleTotals(cart, { type: 'percent', value: 10 });
  assert.equal(t.base, 100000, 'скидка кассы на пакет не действует');
  assert.equal(t.total, 550000 + 100000 - 10000);
  const body = saleBody(cart, { method: 'cash', receivedKopecks: 700000, toBar: true });
  assert.deepEqual(body.items, [{ kind: 'package', package_id: 'p1', phone: '+79123456789' }]);
  assert.equal(body.to_bar, false, 'пакет в бар не уходит');
});

const memory = () => {
  let s = null;
  return { load: () => s, save: (v) => (s = structuredClone(v)) };
};
const req = (b, method, path, body) => b.handle(method, { href: `http://x${path}`, body });

test('заглушка M3 программы клуба: брони дня, бронь по телефону, отмена №115, персонал, пакеты, депозит', async () => {
  const now = T;
  const b = createBackend(memory(), () => now);
  b.scenario('pos');
  const list = (await req(b, 'GET', '/api/clubs/c/bookings')).body;
  for (const k of ['date', 'from', 'to', 'bookings']) assert.ok(k in list, k);
  assert.ok(list.bookings[0].guest && 'phone_masked' in list.bookings[0].guest);
  // №115 решает сервер — can_cancel для запрашивающего (ресепшн: phone/staff без предоплаты)
  for (const x of list.bookings) assert.equal(typeof x.can_cancel, 'boolean');
  assert.ok(list.bookings.some((x) => x.source === 'phone' && x.can_cancel));
  assert.ok(list.bookings.filter((x) => x.source === 'app').every((x) => !x.can_cancel));
  // next_booking у стола в зале (№120)
  const hall = (await req(b, 'GET', '/api/clubs/c/hall')).body;
  assert.ok(hall.every((h) => 'next_booking' in h));
  const nb = hall.find((h) => h.next_booking)?.next_booking;
  for (const k of ['id', 'starts_at', 'ends_at', 'source', 'status']) assert.ok(k in nb, `next_booking.${k}`);
  const day = (await req(b, 'GET', '/api/clubs/c/availability')).body;
  const r8 = day.resources.find((r) => r.number === 8);
  const created = await req(b, 'POST', '/api/clubs/c/bookings', { resource_id: r8.id, starts_at: day.close_at.replace(/T.*/, 'T15:00:00.000Z'), minutes: 60, name: 'Павел', phone: '+79123456789', source: 'phone' });
  assert.equal(created.status, 201);
  assert.equal(created.body.guest.phone_masked, '+7 *** ***-67-89');
  assert.equal((await req(b, 'POST', `/api/bookings/${created.body.id}/cancel`, {})).body.error, 'reason_required');
  const app = list.bookings.find((x) => x.source === 'app' && ['confirmed', 'reserved'].includes(x.status));
  assert.equal((await req(b, 'POST', `/api/bookings/${app.id}/cancel`, { reason: 'Гость позвонил' })).body.error, 'forbidden', 'ресепшн не отменяет бронь из приложения');
  assert.equal((await req(b, 'POST', `/api/bookings/${created.body.id}/cancel`, { reason: 'Гость позвонил' })).body.status, 'canceled');
  const phoneBk = list.bookings.find((x) => x.source === 'phone' && ['confirmed', 'reserved'].includes(x.status));
  assert.equal((await req(b, 'POST', `/api/bookings/${phoneBk.id}/arrive`)).body.status, 'started');

  // Депозит: смена есть — свет, сдача; без смены — shift_closed
  const r2 = day.resources.find((r) => r.number === 2);
  const dep = await req(b, 'POST', '/api/reception/deposits', { resource_id: r2.id, amount_kopecks: 200000, received_kopecks: 500000 });
  assert.equal(dep.status, 201);
  assert.equal(dep.body.change_kopecks, 300000);
  assert.ok(dep.body.session_id && dep.body.paid_until);

  b.scenario('owner');
  const staff = (await req(b, 'GET', '/api/clubs/c/staff')).body;
  assert.ok(Array.isArray(staff.staff) && Array.isArray(staff.invites));
  assert.equal((await req(b, 'POST', '/api/clubs/c/staff', { phone: '+79000000003', role: 'bar' })).body.error, 'duplicate');
  const inv = await req(b, 'POST', '/api/clubs/c/staff', { phone: '+79120001122', role: 'bar' });
  assert.equal(inv.status, 201);
  assert.equal(inv.body.phone_masked, '+7 *** ***-11-22');
  const anna = staff.staff.find((s) => s.role === 'reception');
  assert.equal((await req(b, 'PATCH', `/api/clubs/c/staff/${anna.user_id}`, { role: 'manager' })).body.role, 'manager');
  assert.equal((await req(b, 'DELETE', `/api/clubs/c/staff/${staff.staff.find((s) => s.role === 'owner').user_id}`)).body.error, 'forbidden', 'себя и владельца — нельзя');
  assert.ok((await req(b, 'DELETE', `/api/clubs/c/staff/${anna.user_id}`)).body.ok);

  assert.equal((await req(b, 'POST', '/api/clubs/c/packages', { title: 'x', hours: 5, price_kopecks: 300000, valid_days: 30 })).body.error, 'reason_required');
  const pk = await req(b, 'POST', '/api/clubs/c/packages', { title: '3 часа', hours: 3, price_kopecks: 180000, valid_days: 14, reason: 'Акция' });
  assert.equal(pk.status, 201);
  assert.equal((await req(b, 'POST', `/api/packages/${pk.body.id}/archive`, { reason: 'Закончилась акция' })).body.ok, true);
  assert.ok(!(await req(b, 'GET', '/api/clubs/c/packages')).body.some((p) => p.id === pk.body.id), 'снятый с продажи не в списке');

  // Возврат пакета (№118): партии по точному телефону, приложение и касса
  assert.equal((await req(b, 'GET', '/api/clubs/c/package-lots?phone=89123456789')).status, 400, 'только +7XXXXXXXXXX');
  const lots = (await req(b, 'GET', '/api/clubs/c/package-lots?phone=%2B79123456789')).body;
  for (const k of ['id', 'title', 'source', 'sale_id', 'idx', 'price_kopecks', 'minutes_total', 'minutes_left', 'created_at', 'expires_at', 'refunded_at', 'guest']) assert.ok(k in lots[0], k);
  assert.equal(lots[0].guest.phone_masked, '+7 *** ***-67-89');
  const used = lots.find((l) => l.minutes_left < l.minutes_total);
  assert.equal((await req(b, 'POST', `/api/packages/lots/${used.id}/refund`, { reason: 'Просит' })).body.error, 'package_used');
  const fresh = lots.find((l) => l.source === 'app' && l.minutes_left === l.minutes_total);
  assert.equal((await req(b, 'POST', `/api/packages/lots/${fresh.id}/refund`, {})).body.error, 'reason_required');
  assert.equal((await req(b, 'POST', `/api/packages/lots/${fresh.id}/refund`, { reason: 'Просит' })).body.amount_kopecks, fresh.price_kopecks);
  assert.equal((await req(b, 'POST', `/api/packages/lots/${fresh.id}/refund`, { reason: 'Просит' })).body.error, 'already_refunded');
  const pos = lots.find((l) => l.source === 'pos');
  const call = lotRefundCall(pos, 'Передумал');
  assert.equal((await req(b, 'POST', `/api/pos/sales/${call.id}/refund`, call.body)).status, 201);
  b.scenario('pos');
  assert.equal((await req(b, 'GET', '/api/clubs/c/package-lots?phone=%2B79123456789')).body.error, 'forbidden', 'ресепшн — 403');
  assert.equal((await req(b, 'POST', '/api/receipts/c1d2e3f4-0000-4000-8000-00000000d002/retry', { reason: 'x' })).body.error, 'forbidden', 'повтор чека — управляющий+');

  // №122: стол предложен из очереди — ресепшн снимает удержание с причиной
  b.scenario('waitlist');
  const held = (await req(b, 'GET', '/api/clubs/c/hall')).body.find((h) => h.hold?.source === 'waitlist');
  assert.ok(held.hold.offer_id && held.hold.until);
  assert.equal((await req(b, 'POST', `/api/waitlist/offers/${held.hold.offer_id}/release`, {})).body.error, 'reason_required');
  assert.equal((await req(b, 'POST', `/api/waitlist/offers/${held.hold.offer_id}/release`, { reason: 'Гость у стойки' })).status, 200);
  assert.equal((await req(b, 'POST', `/api/waitlist/offers/${held.hold.offer_id}/release`, { reason: 'Гость у стойки' })).body.error, 'offer_expired', 'повтор');
  assert.equal((await req(b, 'GET', '/api/clubs/c/hall')).body.find((h) => h.resource.id === held.resource.id).status, 'free');
});
