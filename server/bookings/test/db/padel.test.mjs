// Бронь падел-корта на настоящем Postgres (M5.8 №204, T47): бронь блоками слота (90 минут из тарифа
// клуба), цена за слот по расписанию, доступность корта (слот и цена слота), старт по брони у корта,
// тексты «корт». Корты сида: e1…101, e1…102 (seed.d/1300_padel.sql). T0 — пн 26.10.2026 12:00 местного.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CLUB_A, MIN, setup, T0, waitFor } from './harness.mjs';

const skip = !process.env.DATABASE_ADMIN_URL;
const COURT_1 = 'e1000000-0000-4000-8000-000000000101';
const COURT_2 = 'e1000000-0000-4000-8000-000000000102';

describe('бронь корта по слотам', { skip }, () => {
  let h;
  let guest;

  before(async () => {
    h = await setup({ settings: { booking_prepayment: 'full' } });
    guest = await h.login('+79996000001');
  });
  after(async () => {
    await h?.close();
  });

  const book = (who, body) => h.request('POST', '/api/bookings', { token: who.token, body });

  it('длительность — 1…N слотов: 90 и 180 — да; 60, 120 и больше предела брони — 400', async () => {
    h.clock.set(T0);
    for (const minutes of [60, 120, 270]) {
      const r = await book(guest, { resource_id: COURT_1, starts_at: h.at(120), minutes });
      assert.deepEqual([r.status, r.json], [400, { error: 'bad_request' }], String(minutes));
    }
    // 14:00–15:30 местного: дневная цена слота.
    const one = await book(guest, { resource_id: COURT_1, starts_at: h.at(120), minutes: 90 });
    assert.equal(one.status, 201, one.text);
    assert.deepEqual([one.json.minutes, one.json.amount_kopecks, one.json.prepayment_kopecks], [90, 240000, 240000]);
    assert.deepEqual([one.json.resource.type, one.json.resource.number], ['padel_court', 1]);
  });

  it('цена слота по расписанию: бронь 16:30–19:30 — 30 минут дня, 150 минут вечера', async () => {
    const r = await book(guest, { resource_id: COURT_2, starts_at: h.at(4 * 60 + 30), minutes: 180 });
    assert.equal(r.status, 201, r.text);
    // 2 400 ₽ × 30/90 + 3 600 ₽ × 150/90 = 800 ₽ + 6 000 ₽.
    assert.equal(r.json.amount_kopecks, 80000 + 600000);
    // Начало — по сетке брони клуба (30 минут), не по слоту.
    const off = await book(guest, { resource_id: COURT_2, starts_at: h.at(8 * 60 + 10), minutes: 90 });
    assert.equal(off.json.error, 'bad_request');
  });

  it('доступность: у корта семья court, слот 90 и цена слота; у стола слота нет', async () => {
    const r = await h.request('GET', `/api/clubs/${CLUB_A}/availability`);
    assert.equal(r.status, 200, r.text);
    const court = r.json.resources.find((x) => x.id === COURT_1);
    assert.deepEqual([court.kind, court.family, court.slot_minutes], ['padel_court', 'court', 90]);
    const day = court.rates.find((x) => x.per_slot_kopecks === 240000);
    assert.ok(day, JSON.stringify(court.rates));
    assert.deepEqual([day.per_hour_kopecks, day.slot_minutes], [160000, 90]);
    assert.ok(court.busy.some((b) => b.kind === 'booking'), 'бронь корта видна как занятость');
    const table = r.json.resources.find((x) => x.number === 1 && x.family === 'table');
    assert.deepEqual([table.kind, table.slot_minutes], ['pyramid', null]);
    assert.ok(table.rates.every((x) => !('per_slot_kopecks' in x)));
    // Столы раньше кортов.
    const fam = r.json.resources.map((x) => x.family);
    assert.equal(fam.lastIndexOf('table') < fam.indexOf('court'), true);
  });

  it('оплата и старт по брони у корта: код корта, сессия до конца брони, уведомление «корт 1»', async () => {
    const r = await book(guest, { resource_id: COURT_1, starts_at: h.at(6 * 60), minutes: 90 });
    assert.equal(r.status, 201, r.text);
    const pay = await h.request('POST', `/api/bookings/${r.json.id}/pay`, { token: guest.token, key: crypto.randomUUID(), body: { method: 'sbp' } });
    assert.equal(pay.status, 200, pay.text);
    await h.succeed(pay.json.payment_id);
    await h.drain();
    assert.equal((await h.booking(r.json.id)).status, 'confirmed');
    const note = (await h.notifications(guest.id, 'booking.confirmed')).at(-1);
    assert.match(note.text, /корт 1/);
    assert.doesNotMatch(note.text, /стол/);
    const start = T0 + 6 * 60 * MIN;
    h.clock.set(start - 2 * MIN);
    const ok = await h.request('POST', `/api/bookings/${r.json.id}/start`, { token: guest.token, body: { code: await h.code(COURT_1) } });
    assert.equal(ok.status, 200, ok.text);
    const [s] = await h.q('select * from bl.sessions where id = $1', [ok.json.session_id]);
    assert.equal(s.resource_id, COURT_1);
    assert.equal(new Date(s.paid_until).getTime(), start + 90 * MIN);
  });

  it('очередь на корт: GET /api/me/waitlist и предложение — resource с type padel_court и family court, текст «Корт 2»', async () => {
    const t = T0 + 9 * 60 * MIN;
    h.clock.set(t);
    const payer = await h.login('+79996000002');
    const waiter = await h.login('+79996000003');
    const sid = await h.session({ resourceId: COURT_2, payer: payer.id, startedMs: t, paidUntilMs: t + 30 * MIN });
    const j = await h.request('POST', '/api/waitlist', { token: waiter.token, body: { resource_id: COURT_2 } });
    assert.equal(j.status, 201, j.text);
    const mine = await h.request('GET', '/api/me/waitlist', { token: waiter.token });
    assert.equal(mine.status, 200, mine.text);
    assert.deepEqual(mine.json[0].resource, { id: COURT_2, number: 2, title: 'Корт 2', type: 'padel_court', family: 'court' });
    h.clock.set(t + 32 * MIN);
    await h.closeSession(sid);
    await waitFor(async () => (await h.q('select status from bl.waitlist where id = $1', [j.json.id]))[0].status === 'offered');
    const note = (await h.notifications(waiter.id, 'waitlist.offer')).at(-1);
    assert.match(note.text, /^Корт 2 свободен — он ваш на 5 минут\. Нажмите «Занять корт»\.$/);
    const offered = h.sseEvents.find((e) => e.channel === `user:${waiter.id}` && e.event === 'waitlist' && e.data.type === 'waitlist.offered');
    assert.deepEqual([offered.data.resource.type, offered.data.resource.family], ['padel_court', 'court']);
  });
  // Н-1 pentester M5.8: неполный слот корта при раннем приходе и опоздании — по минутам (№113, №44),
  // сама бронь и обычный старт — целыми слотами. Слот 90 минут за 2 400 ₽ днём, округление до рубля.
  async function paidBooking(court, startMin, who) {
    const r = await book(who, { resource_id: court, starts_at: h.at(startMin), minutes: 90 });
    assert.equal(r.status, 201, r.text);
    const pay = await h.request('POST', `/api/bookings/${r.json.id}/pay`, { token: who.token, key: crypto.randomUUID(), body: { method: 'sbp' } });
    assert.equal(pay.status, 200, pay.text);
    await h.succeed(pay.json.payment_id);
    await h.drain();
    return r.json.id;
  }

  it('ранний приход по брони корта: 61 минута до начала — 61/90 слота (1 627 ₽), 20 минут — 533 ₽, а не целый слот', async () => {
    const day = 24 * 60; // вторник, 12:00 местного
    h.clock.set(T0 + day * MIN);
    const g1 = await h.login('+79996000021');
    const g2 = await h.login('+79996000022');
    const a = await paidBooking(COURT_2, day + 120, g1);
    h.clock.set(T0 + (day + 60) * MIN);
    const b = await paidBooking(COURT_2, day + 24 * 60 + 120, g2);
    // 14:00 бронь; приходим в 12:59 — раньше на 61 минуту (раньше 5 бесплатных).
    h.clock.set(T0 + (day + 59) * MIN);
    const early61 = await h.request('POST', `/api/bookings/${a}/start`, { token: g1.token, body: { code: await h.code(COURT_2) } });
    assert.equal(early61.status, 200, early61.text + JSON.stringify(early61.json));
    assert.equal(early61.json.status, 'payment_required');
    // 2 400 ₽ × 61/90 = 1 626,67 ₽ → 1 627 ₽ (одно округление до рубля); раньше — целый слот 2 400 ₽.
    assert.equal(early61.json.amount_kopecks, 162700);
    assert.equal(early61.json.quote.amount_kopecks, 162700);
    h.clock.set(T0 + (day + 24 * 60 + 100) * MIN);
    const early20 = await h.request('POST', `/api/bookings/${b}/start`, { token: g2.token, body: { code: await h.code(COURT_2) } });
    assert.equal(early20.json.status, 'payment_required', early20.text);
    // 2 400 ₽ × 20/90 = 533,33 ₽ → 533 ₽.
    assert.equal(early20.json.amount_kopecks, 53300);
  });
});

describe('опоздание по брони корта с предоплатой-депозитом: цена оставшихся минут', { skip }, () => {
  let h;
  let guest;

  before(async () => {
    h = await setup({ settings: { booking_prepayment: 'deposit', booking_deposit_kopecks: 50000 } });
    guest = await h.login('+79996000011');
  });
  after(async () => {
    await h?.close();
  });

  async function paid(court, startMin) {
    const r = await h.request('POST', '/api/bookings', { token: guest.token, body: { resource_id: court, starts_at: h.at(startMin), minutes: 90 } });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.amount_kopecks, 240000, 'бронь — целым слотом');
    const pay = await h.request('POST', `/api/bookings/${r.json.id}/pay`, { token: guest.token, key: crypto.randomUUID(), body: { method: 'sbp' } });
    assert.equal(pay.status, 200, pay.text);
    await h.succeed(pay.json.payment_id);
    await h.drain();
    return r.json.id;
  }

  it('пришёл через 10 минут после начала: 80 минут из 90 — 2 133 ₽ минус депозит 500 ₽ = 1 633 ₽; пришёл вовремя — 2 400 ₽ минус депозит', async () => {
    h.clock.set(T0);
    const late = await paid(COURT_1, 120);
    const onTime = await paid(COURT_2, 120);
    h.clock.set(T0 + 120 * MIN);
    const r2 = await h.request('POST', `/api/bookings/${onTime}/start`, { token: guest.token, body: { code: await h.code(COURT_2) } });
    assert.equal(r2.json.status, 'payment_required', r2.text);
    assert.equal(r2.json.amount_kopecks, 190000);
    h.clock.set(T0 + 130 * MIN);
    const r = await h.request('POST', `/api/bookings/${late}/start`, { token: guest.token, body: { code: await h.code(COURT_1) } });
    assert.equal(r.json.status, 'payment_required', r.text);
    // 2 400 ₽ × 80/90 = 2 133,33 ₽ → 2 133 ₽; раньше — целый слот 2 400 ₽ − 500 ₽ = 1 900 ₽.
    assert.equal(r.json.amount_kopecks, 163300);
  });
});

describe('Н-5 pentester M5.8: бронь на 0 ₽', { skip }, () => {
  let h;
  let guest;

  before(async () => {
    h = await setup({ settings: { booking_prepayment: 'none' } });
    guest = await h.login('+79996000031');
  });
  after(async () => {
    await h?.close();
  });

  it('тариф даёт 0 ₽ (копеечный, записанный до №220): бронь гостем и ресепшном — 400, брони нет', async () => {
    await h.q("update bl.tariff_rules set price_per_slot = 49, price_per_hour = 33 where resource_type = 'padel_court' and active");
    h.clock.set(T0);
    const r = await h.request('POST', '/api/bookings', { token: guest.token, body: { resource_id: COURT_1, starts_at: h.at(120), minutes: 90 } });
    assert.deepEqual([r.status, r.json], [400, { error: 'bad_request' }]);
    const staff = await h.login('+70000000004');
    const byStaff = await h.request('POST', `/api/clubs/${CLUB_A}/bookings`, { token: staff.token, club: CLUB_A, body: { resource_id: COURT_1, starts_at: h.at(120), minutes: 90, name: 'Иван', phone: '+79996000099' } });
    assert.deepEqual([byStaff.status, byStaff.json], [400, { error: 'bad_request' }]);
    assert.equal((await h.q('select count(*)::int as n from bl.bookings'))[0].n, 0);
  });

  it('бронь на 0 ₽, созданная раньше: старт — 400, сессии и света нет; обычная бронь стартует', async () => {
    await h.q("update bl.tariff_rules set price_per_slot = 240000, price_per_hour = 160000 where resource_type = 'padel_court' and active");
    h.clock.set(T0);
    const ok = await h.request('POST', '/api/bookings', { token: guest.token, body: { resource_id: COURT_1, starts_at: h.at(120), minutes: 90 } });
    assert.equal(ok.status, 201, ok.text);
    await h.q('update bl.bookings set amount_kopecks = 0 where id = $1', [ok.json.id]);
    h.clock.set(T0 + 120 * MIN);
    const start = await h.request('POST', `/api/bookings/${ok.json.id}/start`, { token: guest.token, body: { code: await h.code(COURT_1) } });
    assert.deepEqual([start.status, start.json], [400, { error: 'bad_request' }]);
    assert.equal((await h.q('select count(*)::int as n from bl.sessions where resource_id = $1', [COURT_1]))[0].n, 0);
    // Норма: сумма брони больше нуля — старт без доплаты, когда предоплата покрывает (см. тест оплаты и старта выше).
    await h.q('update bl.bookings set amount_kopecks = 240000 where id = $1', [ok.json.id]);
    const again = await h.request('POST', `/api/bookings/${ok.json.id}/start`, { token: guest.token, body: { code: await h.code(COURT_1) } });
    assert.equal(again.status, 200, again.text);
  });
});
