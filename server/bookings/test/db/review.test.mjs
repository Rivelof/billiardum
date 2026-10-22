// Правки по независимому ревью брони и очереди (решения №128–129): котировка на столе, стол
// недоступен в окне удержания, «гость пришёл» только для брони по телефону, лишняя доплата,
// очередь после принятия без оплаты, удержание не длиннее брони, лимит броней гостя в гонке,
// «ядовитая» бронь в планировщике. Без DATABASE_ADMIN_URL тесты пропускаются.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import * as moneyApi from '../../../payments/api.mjs';
import { CLUB_A, MIN, PHONES, setup, T0, table, waitFor } from './harness.mjs';

const skip = !process.env.DATABASE_ADMIN_URL;
const DAY = 24 * 60 * MIN;

describe('ревью брони и очереди', { skip }, () => {
  let h;
  let reception;
  let other;

  before(async () => {
    h = await setup({ settings: { booking_prepayment: 'full' } });
    reception = await h.login(PHONES.reception);
    other = await h.login('+79995550000');
  });
  after(async () => {
    await h?.close();
  });

  const book = (who, body) => h.request('POST', '/api/bookings', { token: who.token, body });

  async function paid(who, resource, startMs, minutes = 60) {
    const r = await book(who, { resource_id: resource, starts_at: new Date(startMs).toISOString(), minutes });
    assert.equal(r.status, 201, r.text);
    const pay = await h.request('POST', `/api/bookings/${r.json.id}/pay`, { token: who.token, key: randomUUID(), body: {} });
    assert.equal(pay.status, 200, pay.text);
    await h.succeed(pay.json.payment_id);
    await waitFor(async () => (await h.booking(r.json.id)).status === 'confirmed');
    return { id: r.json.id, paymentId: pay.json.payment_id, amount: r.json.prepayment_kopecks };
  }

  it('1 (№129): бронь не принимается, пока на столе ждёт оплаты котировка, заходящая в её интервал', async () => {
    h.clock.set(T0);
    const q = await h.request('POST', '/api/quotes', { token: other.token, body: { resource_id: table(1), kind: 'start', minutes: 180 } });
    assert.equal(q.status, 200, q.text);
    const u = await h.login('+79995550001');
    // Котировка до 15:03 (3 минуты на оплату + 3 часа): бронь на 14:00 и 15:00 — конфликт, 15:30 — можно.
    for (const m of [120, 180]) {
      const r = await book(u, { resource_id: table(1), starts_at: h.at(m), minutes: 60 });
      assert.equal(r.status, 409, `${m}: ${r.text}`);
      assert.equal(r.json.error, 'booking_conflict');
    }
    const ok = await book(u, { resource_id: table(1), starts_at: h.at(210), minutes: 60 });
    assert.equal(ok.status, 201, ok.text);
    // Котировка истекла — стол снова можно бронить раньше.
    h.clock.set(T0 + 4 * MIN);
    const later = await book(u, { resource_id: table(1), starts_at: h.at(60), minutes: 60 });
    assert.equal(later.status, 201, later.text);
  });

  it('2 (№128): стол занят в окне удержания — бронь закрывается table_unavailable, предоплата целиком, тревога', async () => {
    h.clock.set(T0 + DAY);
    const start = T0 + DAY + 120 * MIN;
    const u = await h.login('+79995550002');
    const p = await paid(u, table(2), start);
    // Чужая игра идёт до start + 40 минут.
    const s = await h.session({ resourceId: table(2), payer: other.id, paidUntilMs: start + 40 * MIN, startedMs: start - 30 * MIN });
    h.clock.set(start - 15 * MIN);
    await h.tick();
    // Стол не показал бронь — reserved не ставится, повтор на следующих тиках.
    let b = await h.booking(p.id);
    assert.equal(b.status, 'confirmed');
    assert.ok(!b.notified.reserved_hold);
    h.clock.set(start + 5 * MIN);
    await h.tick();
    b = await h.booking(p.id);
    assert.ok(b.notified.unavailable);
    h.clock.set(start + 30 * MIN);
    await h.tick();
    b = await h.booking(p.id);
    assert.equal(b.status, 'expired');
    assert.equal(b.expire_reason, 'table_unavailable');
    assert.equal(b.forfeit_percent, 0);
    const f = h.moneyCalls.filter((c) => c.fn === 'forfeitPrepayment' && c.args.paymentId === p.paymentId);
    assert.equal(f.length, 1);
    assert.equal(f[0].args.percent, 0);
    assert.equal((await h.refunds(p.paymentId)).reduce((x, y) => x + Number(y.amount_kopecks), 0), p.amount);
    assert.equal((await h.q("select * from bl.alarms where type = 'booking_table_unavailable' and data->>'booking_id' = $1", [p.id])).length, 1);
    assert.match((await h.notifications(u.id, 'booking.expired'))[0].text, /стол был недоступен/);
    // clearReserved — только своё удержание (источник и ссылка).
    const cr = h.lightCalls.filter((c) => c.fn === 'clearReserved' && c.args.refId === p.id);
    assert.ok(cr.length >= 1);
    assert.equal(cr[0].args.source, 'booking');
    await h.closeSession(s);
    await h.drain();
  });

  it('2б (№128): игра в окне удержания между тиками — по истории, тоже table_unavailable', async () => {
    h.clock.set(T0 + 2 * DAY);
    const start = T0 + 2 * DAY + 120 * MIN;
    const u = await h.login('+79995550003');
    const p = await paid(u, table(3), start);
    // Контроль: стол свободен всё окно — обычное сгорание с удержанием.
    const u2 = await h.login('+79995550004');
    const p2 = await paid(u2, table(4), start);
    h.clock.set(start - 15 * MIN);
    await h.tick();
    assert.equal((await h.booking(p.id)).status, 'reserved');
    assert.equal((await h.booking(p2.id)).status, 'reserved');
    // Чужая игра с 10-й по 12-ю минуту окна (без тика планировщика в это время).
    const s = await h.session({ resourceId: table(3), payer: other.id, paidUntilMs: start + 12 * MIN, startedMs: start + 10 * MIN });
    await h.admin.query("update bl.sessions set status = 'closed', ended_at = $2, close_reason = 'expired' where id = $1", [s, new Date(start + 12 * MIN)]);
    h.clock.set(start + 30 * MIN);
    await h.tick();
    const b = await h.booking(p.id);
    assert.equal(b.expire_reason, 'table_unavailable');
    assert.equal((await h.booking(p2.id)).expire_reason, 'no_show');
  });

  it('3: «гость пришёл» — только бронь по телефону без предоплаты и только в окне прихода', async () => {
    h.clock.set(T0 + 3 * DAY);
    const start = T0 + 3 * DAY + 180 * MIN;
    const u = await h.login('+79995550005');
    const app = await paid(u, table(5), start);
    const a1 = await h.request('POST', `/api/bookings/${app.id}/arrive`, { token: reception.token, club: CLUB_A, body: {} });
    assert.equal(a1.status, 403);
    assert.equal((await h.booking(app.id)).status, 'confirmed');
    const ph = await h.request('POST', `/api/clubs/${CLUB_A}/bookings`, {
      token: reception.token,
      body: { resource_id: table(6), starts_at: new Date(start).toISOString(), minutes: 60, name: 'Ольга', phone: '+79120001122' },
    });
    assert.equal(ph.status, 201, ph.text);
    // Слишком рано (больше 2 часов до начала).
    h.clock.set(start - 150 * MIN);
    assert.equal((await h.request('POST', `/api/bookings/${ph.json.id}/arrive`, { token: reception.token, club: CLUB_A, body: {} })).status, 403);
    h.clock.set(start - 10 * MIN);
    const ok = await h.request('POST', `/api/bookings/${ph.json.id}/arrive`, { token: reception.token, club: CLUB_A, body: {} });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.status, 'started');
  });

  it('4: повтор старта даёт ту же котировку; вторая оплаченная доплата при идущей игре возвращается целиком', async () => {
    await h.setSettings({ booking_prepayment: 'none' });
    try {
      h.clock.set(T0 + 4 * DAY);
      const start = T0 + 4 * DAY + 60 * MIN;
      const u = await h.login('+79995550006');
      const r = await book(u, { resource_id: table(7), starts_at: new Date(start).toISOString(), minutes: 60 });
      assert.equal(r.status, 201, r.text);
      h.clock.set(start);
      const code = await h.code(table(7));
      const s1 = await h.request('POST', `/api/bookings/${r.json.id}/start`, { token: u.token, body: { code } });
      const s2 = await h.request('POST', `/api/bookings/${r.json.id}/start`, { token: u.token, body: { code } });
      assert.equal(s1.json.quote.quote_id, s2.json.quote.quote_id);
      assert.equal(h.moneyCalls.filter((c) => c.fn === 'createBookingQuote' && c.args.bookingId === r.json.id).length, 1);
      // Вторая котировка той же брони (другая вкладка, старый клиент) — оплачивается тоже.
      const client = await h.pool.connect();
      let q2;
      try {
        await client.query('begin');
        await client.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'system', true)", [CLUB_A]);
        q2 = await moneyApi.createBookingQuote(client, {
          clubId: CLUB_A, bookingId: r.json.id, resourceId: table(7), userId: u.id, from: new Date(start), minutes: 60, amountKopecks: 60_000, earlyMinutes: 0,
        });
        await client.query('commit');
      } finally {
        client.release();
      }
      const pay1 = await h.request('POST', `/api/quotes/${s1.json.quote.quote_id}/pay`, { token: u.token, key: randomUUID(), body: { method: 'sbp' } });
      const pay2 = await h.request('POST', `/api/quotes/${q2.quote_id}/pay`, { token: u.token, key: randomUUID(), body: { method: 'sbp' } });
      assert.equal(pay1.status, 200, pay1.text);
      assert.equal(pay2.status, 200, pay2.text);
      // Пока первая доплата не подтверждена — повтор старта: payment_pending, новой котировки нет.
      assert.equal((await h.request('POST', `/api/bookings/${r.json.id}/start`, { token: u.token, body: { code } })).json.error, 'payment_pending');
      await h.succeed(pay1.json.payment_id);
      await waitFor(async () => (await h.booking(r.json.id)).status === 'started');
      await h.succeed(pay2.json.payment_id);
      await h.drain();
      assert.equal((await h.refunds(pay2.json.payment_id)).reduce((x, y) => x + Number(y.amount_kopecks), 0), 60_000);
      assert.equal((await h.refunds(pay1.json.payment_id)).length, 0);
      assert.equal((await h.audit('booking.extra_refund')).filter((a) => a.object_id === r.json.id).length, 1);
      assert.ok((await h.notifications(u.id, 'booking.refund')).some((n) => /лишняя оплата/.test(n.text)));
    } finally {
      await h.setSettings({ booking_prepayment: 'full' });
    }
  });

  it('6: принял предложение и не оплатил — запись истекает, стол предлагается следующему; очередь без события тоже двигается', async () => {
    h.clock.set(T0 + 5 * DAY);
    const a = await h.login('+79995550007');
    const b = await h.login('+79995550008');
    const s = await h.session({ resourceId: table(8), payer: other.id, paidUntilMs: T0 + 5 * DAY + 10 * MIN });
    const ja = await h.request('POST', '/api/waitlist', { token: a.token, body: { resource_id: table(8) } });
    const jb = await h.request('POST', '/api/waitlist', { token: b.token, body: { resource_id: table(8) } });
    // Сессия закрыта без события session.closed (сбой, ручная правка) — очередь двигает планировщик.
    h.clock.set(T0 + 5 * DAY + 13 * MIN);
    await h.admin.query("update bl.sessions set status = 'closed', ended_at = $2, close_reason = 'expired' where id = $1", [s, h.clock.now()]);
    await h.tickWaitlist();
    assert.equal((await h.q('select status from bl.waitlist where id = $1', [ja.json.id]))[0].status, 'offered');
    const acc = await h.request('POST', `/api/waitlist/${ja.json.id}/accept`, { token: a.token, body: {} });
    assert.equal(acc.status, 200, acc.text);
    // Удержание оплаты (3 минуты) кончилось без игры.
    h.clock.add(3 * MIN);
    await h.tickWaitlist();
    const [wa] = await h.q('select status, close_reason from bl.waitlist where id = $1', [ja.json.id]);
    assert.deepEqual(wa, { status: 'expired', close_reason: 'expired' });
    assert.equal((await h.q('select status from bl.waitlist where id = $1', [jb.json.id]))[0].status, 'offered');
  });

  it('8: удержание не длиннее брони; после конца брони старт — booking_expired', async () => {
    await h.setSettings({ booking_min_minutes: 30, booking_hold_prepaid_minutes: 45 });
    try {
      h.clock.set(T0 + 6 * DAY);
      const u = await h.login('+79995550009');
      const r = await book(u, { resource_id: table(1), starts_at: h.at(6 * 24 * 60 + 120), minutes: 30 });
      assert.equal(r.status, 201, r.text);
      assert.equal((await h.booking(r.json.id)).hold_minutes, 30);
      assert.equal(r.json.hold_until, h.at(6 * 24 * 60 + 150));
    } finally {
      await h.setSettings({ booking_min_minutes: 60, booking_hold_prepaid_minutes: 30 });
    }
  });

  it('10: лимит живых броней гостя держится и при параллельных запросах', async () => {
    h.clock.set(T0 + 7 * DAY);
    const u = await h.login('+79995550010');
    const res = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => book(u, { resource_id: table(n), starts_at: h.at(7 * 24 * 60 + 300), minutes: 60 })));
    assert.equal(res.filter((r) => r.status === 201).length, 3, res.map((r) => r.status).join(','));
    assert.ok(res.filter((r) => r.status !== 201).every((r) => r.json.error === 'limit_exceeded'));
  });

  it('12: «ядовитая» бронь не держит планировщик — пауза и тревога после 5 неудач подряд', async () => {
    h.clock.set(T0 + 8 * DAY);
    const start = T0 + 8 * DAY + 60 * MIN;
    // Бронь с предоплатой, которой нет у money: сгорание падает на forfeitPrepayment.
    const [bad] = await h.q(
      `insert into bl.bookings (club_id, resource_id, user_id, source, starts_at, ends_at, status, prepayment_mode, amount_kopecks,
                                prepayment_kopecks, prepaid_kopecks, prepayment_id, hold_minutes, created_at, updated_at)
       values ($1, $2, $3, 'app', $4, $5, 'confirmed', 'full', 50000, 50000, 50000, $6, 30, $7, $7) returning id`,
      [CLUB_A, table(2), other.id, new Date(start), new Date(start + 60 * MIN), randomUUID(), new Date(start - 120 * MIN)],
    );
    const good = await paid(await h.login('+79995550011'), table(3), start);
    h.clock.set(start + 31 * MIN);
    for (let i = 0; i < 5; i += 1) {
      await h.tick();
      h.clock.add(11 * MIN); // больше паузы
    }
    assert.equal((await h.booking(bad.id)).status, 'confirmed');
    assert.equal((await h.booking(good.id)).status, 'expired', 'соседняя бронь обработана');
    assert.equal((await h.q("select * from bl.alarms where type = 'booking_step_failed' and data->>'booking_id' = $1", [bad.id])).length, 1);
  });
});
