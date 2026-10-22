import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from '../src/mock/backend.js';
import { startableBooking } from '../src/lib/booking.js';
import { durationsFor, boardSlots } from '@billiardum/shared/booking';
import { ROUTES } from '../src/lib/routes.js';

const MIN = 60_000;
const memory = () => {
  let s = null;
  return { load: () => s, save: (v) => (s = structuredClone(v)) };
};
const CLUB = '0b6b8c1e-5a7d-4f0e-9c3a-2d1e4f5a6b7c';

test('своя бронь у стола: за 2 часа до начала и до конца удержания, только живая', () => {
  const now = Date.parse('2026-10-22T15:00:00Z');
  const b = (over) => ({ id: 'b', resource: { id: 'r4' }, status: 'confirmed', starts_at: new Date(now + 30 * MIN).toISOString(), ends_at: new Date(now + 150 * MIN).toISOString(), hold_until: new Date(now + 60 * MIN).toISOString(), ...over });
  assert.equal(startableBooking([b()], 'r4', now).id, 'b');
  assert.equal(startableBooking([b()], 'r5', now), null, 'чужой стол');
  assert.equal(startableBooking([b({ starts_at: new Date(now + 3 * 60 * MIN).toISOString() })], 'r4', now), null, 'раньше чем за 2 часа');
  assert.equal(startableBooking([b({ status: 'pending_payment' })], 'r4', now), null, 'без предоплаты стол не держится');
  assert.equal(startableBooking([b({ hold_until: new Date(now - 1).toISOString() })], 'r4', now), null, 'удержание вышло');
  assert.equal(startableBooking(null, 'r4', now), null);
});

test('маршруты M3: бронь, мои брони, предложение очереди, профиль и уведомления', () => {
  const names = Object.fromEntries(ROUTES.map(([p, n]) => [n, p]));
  for (const n of ['book', 'bookclub', 'bookings', 'booking', 'waitlist', 'me', 'notify']) assert.ok(names[n], n);
  assert.equal(names.waitlist, 'waitlist/:id', 'ссылка из уведомления сервера /app/waitlist/{id}');
  assert.equal(names.booking, 'bookings/:id', 'кнопка «Моя бронь» — /app/bookings/{id}');
});

test('заглушка брони держит вид ответов server/bookings: доступность, бронь, предоплата, отмена, старт', async () => {
  let now = Date.parse('2026-10-22T08:00:00Z'); // 13:00 по клубу
  const b = createBackend({ ...memory(), now: () => now });
  b.scenario('user');
  const day = (await b.handle('GET', `/api/clubs/${CLUB}/availability`, undefined, new URLSearchParams('date=2026-10-22'))).body;
  for (const k of ['club', 'date', 'open_at', 'close_at', 'step_minutes', 'min_minutes', 'max_minutes', 'lead_minutes', 'max_days', 'rules', 'resources']) assert.ok(k in day, k);
  for (const k of ['id', 'number', 'busy', 'free', 'rates']) assert.ok(k in day.resources[0], `resources.${k}`);
  const r = day.resources.find((x) => x.number === 4);
  const slot = boardSlots(day, { resourceId: r.id, now }).find((s) => s.state === 'free');
  const minutes = durationsFor(day, r.id, slot.at)[0];
  const created = await b.handle('POST', '/api/bookings', { resource_id: r.id, starts_at: new Date(slot.at).toISOString(), minutes });
  assert.equal(created.status, 201);
  const bk = created.body;
  for (const k of ['id', 'club', 'resource', 'status', 'source', 'starts_at', 'ends_at', 'minutes', 'hold_until', 'amount_kopecks', 'prepayment_kopecks', 'paid_kopecks', 'pay_until', 'cancel']) assert.ok(k in bk, k);
  assert.equal(bk.status, 'pending_payment');
  assert.equal((await b.handle('POST', '/api/bookings', { resource_id: r.id, starts_at: bk.starts_at, minutes })).body.error, 'booking_conflict', 'пересечение — booking_conflict');
  assert.equal((await b.handle('POST', `/api/bookings/${bk.id}/pay`, { method: 'sbp', return_url: 'https://evil.example/x' })).status, 400, 'return_url — только путь /app/…');
  const pay = (await b.handle('POST', `/api/bookings/${bk.id}/pay`, { method: 'sbp', return_url: `/app/bookings/${bk.id}?paid=1` })).body;
  assert.ok(pay.booking && pay.payment_id && pay.confirmation.url, '{ booking, payment_id, confirmation }');
  assert.equal(b.payment(pay.payment_id).return_url, `/app/bookings/${bk.id}?paid=1`);
  // Поток гостя ?me=1 (№120): событие booking с type
  const events = [];
  const off = b.subscribe('me', (data, name) => events.push([name, data]));
  b.confirm(pay.payment_id, true);
  off();
  assert.deepEqual(events.map(([n, d]) => [n, d.type, d.id]), [['booking', 'booking.confirmed', bk.id]]);
  for (const k of ['status', 'starts_at', 'ends_at', 'resource']) assert.ok(k in events[0][1], `booking event ${k}`);
  const paid = (await b.handle('GET', `/api/bookings/${bk.id}`)).body;
  assert.equal(paid.status, 'confirmed');
  assert.equal(paid.paid_kopecks, paid.prepayment_kopecks);
  // Ранний приход за 3 часа — too_early; за час — доплата
  const code = '4K7P9QW2XM';
  assert.equal((await b.handle('POST', `/api/bookings/${bk.id}/start`, { code: 'XXXX' })).body.error, 'forbidden', 'код стола с QR');
  now = Date.parse(bk.starts_at) - 3 * 60 * MIN;
  assert.equal((await b.handle('POST', `/api/bookings/${bk.id}/start`, { code })).body.error, 'too_early');
  now = Date.parse(bk.starts_at) - 40 * MIN;
  const early = (await b.handle('POST', `/api/bookings/${bk.id}/start`, { code })).body;
  assert.equal(early.status, 'payment_required');
  assert.ok(early.amount_kopecks > 0);
  now = Date.parse(bk.starts_at);
  const started = (await b.handle('POST', `/api/bookings/${bk.id}/start`, { code })).body;
  assert.equal(started.status, 'started');
  assert.ok(started.session_id);
  const game = (await b.handle('GET', `/api/sessions/${started.session_id}`)).body;
  assert.equal(game.paid_until, bk.ends_at, '№123: игра по брони кончается ровно в конце брони');
  assert.equal((await b.handle('POST', `/api/bookings/${bk.id}/cancel`, {})).body.error, 'booking_not_active');
});

test('заглушка: очередь на занятый стол, предложение на 5 минут, пакеты и баланс в котировке', async () => {
  let now = Date.parse('2026-10-22T12:00:00Z');
  const b = createBackend({ ...memory(), now: () => now });
  b.scenario('user');
  const clubs = (await b.handle('GET', '/api/clubs')).body;
  for (const k of ['id', 'name', 'city', 'address', 'timezone', 'plan']) assert.ok(k in clubs[0], `clubs.${k}`);
  const events = [];
  b.subscribe('me', (data, name) => events.push([name, data]));
  const busy = (await b.handle('GET', '/api/t/7H3D2RT9QF')).body;
  const free = (await b.handle('GET', '/api/t/4K7P9QW2XM')).body;
  assert.equal((await b.handle('POST', '/api/waitlist', { resource_id: free.resource.id })).body.error, 'table_free');
  const w = (await b.handle('POST', '/api/waitlist', { resource_id: busy.resource.id })).body;
  assert.equal(w.status, 'waiting');
  assert.equal((await b.handle('POST', '/api/waitlist', { resource_id: busy.resource.id })).body.id, w.id, 'повтор — та же запись');
  now += 30_000;
  const mine = (await b.handle('GET', '/api/me/waitlist')).body.find((x) => x.id === w.id);
  assert.equal(mine.status, 'offered');
  assert.ok(Date.parse(mine.offer_until) - now <= 5 * MIN);
  const offered = events.find(([n, d]) => n === 'waitlist' && d.type === 'waitlist.offered')?.[1];
  assert.equal(offered.offer_id, w.id);
  // №122: предложение держит стол — гость «с улицы» получает table_busy
  assert.equal((await b.handle('GET', '/api/t/7H3D2RT9QF')).body.status, 'reserved');
  assert.ok(offered.resource.number && offered.expires_at);
  const acc = (await b.handle('POST', `/api/waitlist/${w.id}/accept`)).body;
  assert.equal(acc.status, 'accepted');
  assert.ok(acc.hold_until && acc.resource_id && acc.resource.number);
  assert.ok(!('code' in acc) && !('code' in acc.resource), 'кода стола нет (№119)');
  assert.ok(events.some(([n, d]) => n === 'waitlist' && d.type === 'waitlist.accepted'));
  assert.ok('close_reason' in mine, 'причина закрытия в записи очереди');

  // Пакет: покупка, баланс партиями, котировка use_balance, оплата balance
  await b.handle('POST', '/api/auth/consent', { version: 'x' });
  const packs = (await b.handle('GET', `/api/clubs/${CLUB}/packages`)).body;
  for (const k of ['id', 'title', 'hours', 'minutes', 'price_kopecks', 'valid_days', 'active']) assert.ok(k in packs[0], k);
  const buy = (await b.handle('POST', `/api/packages/${packs[0].id}/buy`, { method: 'sbp', return_url: '/app/me?paid=package' })).body;
  assert.equal(b.payment(buy.payment_id).return_url, '/app/me?paid=package');
  b.confirm(buy.payment_id, true);
  const bal = (await b.handle('GET', `/api/clubs/${CLUB}/balance`)).body;
  assert.equal(bal.minutes, packs[0].minutes);
  assert.equal(bal.lots.length, 1);
  const q = (await b.handle('POST', '/api/quotes', { resource_id: free.resource.id, kind: 'start', minutes: 120, use_balance: true })).body;
  assert.equal(q.balance_minutes, 120);
  assert.equal(q.amount_kopecks, 0, 'всё балансом — доплаты нет');
  const p = (await b.handle('POST', `/api/quotes/${q.quote_id}/pay`, { method: 'balance' })).body;
  assert.equal(p.status, 'succeeded');
  assert.equal((await b.handle('GET', `/api/clubs/${CLUB}/balance`)).body.minutes, packs[0].minutes - 120);

  // Каналы уведомлений (PATCH /api/me core): max | telegram | webpush
  assert.equal((await b.handle('PATCH', '/api/me', { channels_order: ['push'] })).status, 400);
  const me = (await b.handle('PATCH', '/api/me', { notify_channel: 'webpush', channels_order: ['webpush', 'max', 'telegram'] })).body.user;
  assert.equal(me.notify_channel, 'webpush');
  assert.deepEqual(Object.keys(me.channels).sort(), ['max', 'telegram', 'webpush']);
  assert.deepEqual(me.channels_available, ['telegram', 'webpush'], '№126: MAX на сервере не настроен');
  assert.equal(me.channels.max, false);
  assert.deepEqual(me.channels_order, ['webpush', 'max', 'telegram']);
});
