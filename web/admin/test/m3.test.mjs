import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canArrive, canCancel, lanes, place, startOptions, timelineWindow, withNextBooking } from '../src/lib/bookings.js';
import { maskTail, packageItems, packageLine, packagePerHour } from '../src/lib/packages.js';
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

test('бронь на плане зала и права: ресепшн отменяет только свои брони по телефону без предоплаты (№115)', () => {
  const hall = [{ resource: { id: 'r1' }, status: 'free' }, { resource: { id: 'r2' }, status: 'busy' }];
  const bookings = [
    { id: 'late', resource: { id: 'r1' }, status: 'confirmed', starts_at: iso(T + 3 * 60 * MIN), ends_at: iso(T + 5 * 60 * MIN), hold_until: iso(T + 3.5 * 60 * MIN) },
    { id: 'soon', resource: { id: 'r1' }, status: 'confirmed', starts_at: iso(T + 60 * MIN), ends_at: iso(T + 2 * 60 * MIN), hold_until: iso(T + 75 * MIN) },
    { id: 'done', resource: { id: 'r2' }, status: 'started', starts_at: iso(T - 60 * MIN), ends_at: iso(T + 60 * MIN) },
  ];
  const out = withNextBooking(hall, bookings, T);
  assert.equal(out[0].next_booking.id, 'soon');
  assert.equal(out[1].next_booking, undefined, 'идущая бронь — уже игра');
  const phone = { status: 'confirmed', source: 'phone', prepayment_kopecks: 0, paid_kopecks: 0, hold_until: iso(T + 60 * MIN) };
  assert.equal(canCancel('reception', phone), true);
  assert.equal(canCancel('reception', { ...phone, source: 'app' }), false);
  assert.equal(canCancel('reception', { ...phone, prepayment_kopecks: 50000 }), false);
  assert.equal(canCancel('manager', { ...phone, source: 'app', paid_kopecks: 50000 }), true);
  assert.equal(canCancel('owner', { ...phone, status: 'started' }), false);
  assert.equal(canCancel('bar', phone), false);
  assert.equal(canArrive(phone, T), true);
  assert.equal(canArrive({ ...phone, source: 'app' }, T), false, 'гость приложения начинает сам по QR');
  assert.equal(canArrive(phone, T + 2 * 60 * MIN), false, 'удержание вышло');
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
});
