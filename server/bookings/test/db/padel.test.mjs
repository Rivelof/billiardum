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
});
