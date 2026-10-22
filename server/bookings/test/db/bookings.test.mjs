// Бронь на настоящем Postgres (контракт M3 §1 п. 1–5, §3, §4): создание и пересечения, гонки,
// предоплата, T18 (удержание 30 минут и сгорание на ускоренных часах), T19 (предел продления
// перед бронью — котировкой money), старт по брони, ранний приход, отмена, бронь по телефону.
// Без DATABASE_ADMIN_URL тесты пропускаются.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CLUB_A, MIN, PHONES, setup, T0, table, waitFor } from './harness.mjs';

const skip = !process.env.DATABASE_ADMIN_URL;

describe('бронь', { skip }, () => {
  let h;
  let guest;
  let guest2;
  let owner;
  let manager;
  let reception;

  before(async () => {
    h = await setup({ settings: { booking_prepayment: 'full' } });
    guest = await h.login('+79990000001');
    guest2 = await h.login('+79990000002');
    owner = await h.login(PHONES.owner);
    manager = await h.login(PHONES.manager);
    reception = await h.login(PHONES.reception);
  });
  after(async () => {
    await h?.close();
  });

  const book = (who, body) => h.request('POST', '/api/bookings', { token: who.token, body });

  /** Бронь с подтверждённой предоплатой. */
  async function paidBooking(who, { resource, startMin, minutes = 60 }) {
    const r = await book(who, { resource_id: resource, starts_at: h.at(startMin), minutes });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.status, 'pending_payment');
    const pay = await h.request('POST', `/api/bookings/${r.json.id}/pay`, { token: who.token, key: crypto.randomUUID(), body: { method: 'sbp' } });
    assert.equal(pay.status, 200, pay.text);
    await h.succeed(pay.json.payment_id);
    await waitFor(async () => (await h.booking(r.json.id)).status === 'confirmed');
    return { id: r.json.id, paymentId: pay.json.payment_id, amount: r.json.prepayment_kopecks, view: r.json };
  }

  it('создание: предоплата, оплата через money, подтверждение по payment.confirmed, уведомление', async () => {
    h.clock.set(T0);
    const r = await book(guest, { resource_id: table(1), starts_at: h.at(8 * 60), minutes: 120 });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.status, 'pending_payment');
    // Пн 20:00–22:00 по клубу, 800 ₽/ч пирамида.
    assert.equal(r.json.amount_kopecks, 160_000);
    assert.equal(r.json.prepayment_kopecks, 160_000);
    assert.equal(r.json.resource.number, 1);
    assert.equal(r.json.hold_until, h.at(8 * 60 + 30));
    assert.ok(!('guest' in r.json));

    // return_url — только путь своего сайта.
    for (const bad of ['https://evil.example/x', '//evil.example', '/app/../x']) {
      const res = await h.request('POST', `/api/bookings/${r.json.id}/pay`, { token: guest.token, key: crypto.randomUUID(), body: { return_url: bad } });
      assert.equal(res.status, 400, bad);
    }
    const key = crypto.randomUUID();
    const pay = await h.request('POST', `/api/bookings/${r.json.id}/pay`, { token: guest.token, key, body: { return_url: '/app/bookings?paid=1' } });
    assert.equal(pay.status, 200, pay.text);
    assert.ok(pay.json.confirmation.url);
    const call = h.moneyCalls.find((c) => c.fn === 'createPrepayment' && c.args.bookingId === r.json.id);
    assert.equal(call.args.amountKopecks, 160_000);
    assert.equal(call.args.clubId, CLUB_A);
    assert.equal(call.args.returnUrl, 'https://bl.test/app/bookings?paid=1');
    // Повтор с тем же ключом — тот же ответ без второго платежа.
    const again = await h.request('POST', `/api/bookings/${r.json.id}/pay`, { token: guest.token, key, body: { return_url: '/app/bookings?paid=1' } });
    assert.equal(again.json.payment_id, pay.json.payment_id);

    const pm = await h.payment(pay.json.payment_id);
    assert.equal(pm.kind, 'booking');
    assert.equal(pm.booking_id, r.json.id);
    assert.equal(Number(pm.amount_kopecks), 160_000);
    await h.succeed(pay.json.payment_id);
    await waitFor(async () => (await h.booking(r.json.id)).status === 'confirmed');
    const b = await h.booking(r.json.id);
    assert.equal(Number(b.prepaid_kopecks), 160_000);
    assert.equal(b.hold_minutes, 30);
    assert.equal((await h.notifications(guest.id, 'booking.confirmed')).length, 1);
    assert.equal((await h.outboxEvents('booking.confirmed')).filter((e) => e.payload.booking_id === b.id).length, 1);
    // Повтор события — без изменений, без возврата.
    await h.confirmPayment({ paymentId: pay.json.payment_id, bookingId: r.json.id, amount: 160_000 });
    await h.drain();
    assert.equal((await h.notifications(guest.id, 'booking.confirmed')).length, 1);
    assert.equal((await h.refunds(pay.json.payment_id)).length, 0);
    // SSE гостю (№120): booking.confirmed.
    await waitFor(() => h.sseEvents.some((e) => e.channel === `user:${guest.id}` && e.data.type === 'booking.confirmed' && e.data.id === b.id));
    const ev = h.sseEvents.find((e) => e.channel === `user:${guest.id}` && e.data.type === 'booking.confirmed' && e.data.id === b.id);
    assert.equal(ev.event, 'booking');
    assert.equal(ev.data.status, 'confirmed');
    assert.equal(ev.data.starts_at, h.at(8 * 60));

    const mine = await h.request('GET', '/api/me/bookings', { token: guest.token });
    assert.equal(mine.status, 200);
    assert.ok(mine.json.some((x) => x.id === b.id && x.paid_kopecks === 160_000 && x.club.timezone === 'Asia/Yekaterinburg'));
  });

  it('пересечение с живой бронью — booking_conflict; стык интервалов — можно', async () => {
    h.clock.set(T0);
    const a = await book(guest, { resource_id: table(2), starts_at: h.at(6 * 60), minutes: 60 });
    assert.equal(a.status, 201);
    const clash = await book(guest2, { resource_id: table(2), starts_at: h.at(6 * 60 + 30), minutes: 60 });
    assert.equal(clash.status, 409);
    assert.equal(clash.json.error, 'booking_conflict');
    const next = await book(guest2, { resource_id: table(2), starts_at: h.at(7 * 60), minutes: 60 });
    assert.equal(next.status, 201, next.text);
    // Другой стол то же время — можно.
    const other = await book(guest2, { resource_id: table(3), starts_at: h.at(6 * 60), minutes: 60 });
    assert.equal(other.status, 201);
  });

  it('гонка: 6 одновременных броней одного интервала — ровно одна', async () => {
    h.clock.set(T0);
    const users = [];
    for (let i = 0; i < 6; i += 1) users.push(await h.login(`+7999100000${i}`));
    const results = await Promise.all(users.map((u) => book(u, { resource_id: table(4), starts_at: h.at(9 * 60), minutes: 90 })));
    const ok = results.filter((r) => r.status === 201);
    assert.equal(ok.length, 1, results.map((r) => r.status).join(','));
    assert.ok(results.filter((r) => r.status === 409).every((r) => r.json.error === 'booking_conflict'));
  });

  it('база сама запрещает пересечение (exclude using gist), отменённая бронь интервал не держит', async () => {
    const [b] = await h.q("select * from bl.bookings where resource_id = $1 and status <> 'canceled' limit 1", [table(4)]);
    const ins = (status) =>
      h.admin.query(
        `insert into bl.bookings (club_id, resource_id, guest_name, guest_phone, source, starts_at, ends_at, status, prepayment_mode,
                                  amount_kopecks, hold_minutes, created_at, updated_at, canceled_at)
         values ($1, $2, 'Иван', '+79120000000', 'phone', $3, $4, $5, 'none', 0, 15, now(), now(), now())`,
        [CLUB_A, table(4), new Date(new Date(b.starts_at).getTime() + 10 * MIN), b.ends_at, status],
      );
    await assert.rejects(ins('confirmed'), (err) => err.code === '23P01');
    await ins('canceled');
  });

  it('проверки: шаг, длительность, прошлое, лимит броней гостя, нет телефона', async () => {
    h.clock.set(T0);
    assert.equal((await book(guest2, { resource_id: table(5), starts_at: h.at(60 + 10), minutes: 60 })).json.error, 'bad_request');
    assert.equal((await book(guest2, { resource_id: table(5), starts_at: h.at(60), minutes: 45 })).json.error, 'bad_request');
    assert.equal((await book(guest2, { resource_id: table(5), starts_at: h.at(-60), minutes: 60 })).json.error, 'bad_request');
    assert.equal((await book(guest2, { resource_id: table(5), starts_at: h.at(60 * 24 * 40), minutes: 60 })).json.error, 'bad_request');
    // У guest2 уже 3 живые брони (столы 2, 3 и одна в гонке — нет; добьём до предела).
    const u = await h.login('+79992000000');
    for (const n of [5, 6, 7]) assert.equal((await book(u, { resource_id: table(n), starts_at: h.at(3 * 60), minutes: 60 })).status, 201);
    const over = await book(u, { resource_id: table(8), starts_at: h.at(3 * 60), minutes: 60 });
    assert.equal(over.status, 409);
    assert.equal(over.json.error, 'limit_exceeded');
  });

  it('стол занят игрой на время брони — table_busy', async () => {
    h.clock.set(T0);
    const s = await h.session({ resourceId: table(8), payer: guest2.id, paidUntilMs: T0 + 90 * MIN });
    const r = await book(guest, { resource_id: table(8), starts_at: h.at(60), minutes: 60 });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'table_busy');
    const later = await book(guest, { resource_id: table(8), starts_at: h.at(120), minutes: 60 });
    assert.equal(later.status, 201, later.text);
    await h.closeSession(s);
    await h.drain();
    await h.request('POST', `/api/bookings/${later.json.id}/cancel`, { token: guest.token, body: {} });
  });

  it('T18: предоплата, гость не пришёл — reserved за 15 минут, удержание 30 минут, сгорание, предоплата по правилам клуба', async () => {
    h.clock.set(T0 + 24 * 60 * MIN); // вторник 12:00
    const start = T0 + 24 * 60 * MIN + 180 * MIN; // 15:00
    const u = await h.login('+79993000000');
    const r = await book(u, { resource_id: table(1), starts_at: new Date(start).toISOString(), minutes: 60 });
    assert.equal(r.status, 201, r.text);
    const pay = await h.request('POST', `/api/bookings/${r.json.id}/pay`, { token: u.token, key: crypto.randomUUID(), body: {} });
    await h.succeed(pay.json.payment_id);
    await waitFor(async () => (await h.booking(r.json.id)).status === 'confirmed');

    // За час — напоминание.
    h.clock.set(start - 60 * MIN);
    await h.tick();
    const n1 = await h.notifications(u.id, 'booking.reminder');
    assert.equal(n1.length, 1);
    assert.match(n1[0].text, /Через час бронь: стол 1, 15:00/);
    assert.equal(n1[0].actions?.[0]?.url ?? `/app/bookings/${r.json.id}`, `/app/bookings/${r.json.id}`);
    await h.tick();
    assert.equal((await h.notifications(u.id, 'booking.reminder')).length, 1, 'напоминание один раз');

    // За 15 минут — reserved (light: удержание и state.reserved), напоминание.
    h.clock.set(start - 15 * MIN);
    await h.tick();
    let b = await h.booking(r.json.id);
    assert.equal(b.status, 'reserved');
    const hold = (await h.holds(table(1))).find((x) => x.kind === 'reserved' && !x.released_at);
    assert.ok(hold);
    assert.equal(new Date(hold.until).getTime(), start + 30 * MIN);
    assert.equal(hold.user_id, u.id);
    const cmds = await h.q("select type from bl.device_commands where device_id = 'd1000000-0000-4000-8000-000000000001' and type = 'state.reserved'");
    assert.ok(cmds.length >= 1);
    assert.equal((await h.notifications(u.id, 'booking.soon')).length, 1);
    assert.equal((await h.outboxEvents('booking.reserved')).filter((e) => e.payload.booking_id === b.id).length, 1);

    // 29 минут после начала — ещё ждём.
    h.clock.set(start + 29 * MIN);
    await h.tick();
    assert.equal((await h.booking(r.json.id)).status, 'reserved');

    // 30 минут — сгорела: forfeitPrepayment (percent — настройка клуба у money), reserved снят.
    h.clock.set(start + 30 * MIN);
    await h.tick();
    b = await h.booking(r.json.id);
    assert.equal(b.status, 'expired');
    assert.equal(b.expire_reason, 'no_show');
    assert.equal(b.forfeit_percent, 100);
    const f = h.moneyCalls.filter((c) => c.fn === 'forfeitPrepayment' && c.args.paymentId === pay.json.payment_id);
    assert.equal(f.length, 1);
    assert.equal(f[0].args.percent, undefined);
    assert.ok(f[0].args.reason);
    // money: удержано 100 % (настройка клуба по умолчанию), возврата нет.
    const pm = await h.payment(pay.json.payment_id);
    assert.equal(pm.settlement_status, 'forfeited');
    assert.equal(Number(pm.settled_kopecks), r.json.prepayment_kopecks);
    assert.equal((await h.refunds(pay.json.payment_id)).length, 0);
    // Удержания больше нет: снято или истекло к этому моменту.
    assert.ok((await h.holds(table(1))).filter((x) => x.kind === 'reserved').every((x) => x.released_at || new Date(x.until).getTime() <= start + 30 * MIN));
    assert.equal((await h.outboxEvents('booking.expired')).filter((e) => e.payload.booking_id === b.id).length, 1);
    for (const type of ['booking.confirmed', 'booking.reserved', 'booking.expired']) {
      assert.ok(h.sseEvents.some((e) => e.channel === `user:${u.id}` && e.event === 'booking' && e.data.type === type && e.data.id === b.id), type);
    }
    const n = await h.notifications(u.id, 'booking.expired');
    assert.equal(n.length, 1);
    assert.match(n[0].text, /сгорела/);
    assert.equal((await h.audit('booking.expire')).filter((a) => a.object_id === b.id).length, 1);
    // Повтор планировщика — ничего.
    await h.tick();
    assert.equal(h.moneyCalls.filter((c) => c.fn === 'forfeitPrepayment' && c.args.paymentId === pay.json.payment_id).length, 1);
    // Интервал освобождён: та же бронь по времени больше не мешает (exclude держит только живые).
    await h.admin.query(
      `insert into bl.bookings (club_id, resource_id, guest_name, guest_phone, source, starts_at, ends_at, status, prepayment_mode,
                                amount_kopecks, hold_minutes, created_at, updated_at)
       values ($1, $2, 'Иван', '+79120000000', 'phone', $3, $4, 'completed', 'none', 0, 15, now(), now())`,
      [CLUB_A, table(1), new Date(start), new Date(start + 60 * MIN)],
    );
  });

  it('T19: игра перед бронью продлевается только до начала брони минус 5 минут (котировка money)', async () => {
    const { bookingLimit } = await import('../../../payments/quotes.mjs');
    const api = await import('../../api.mjs');
    h.clock.set(T0 + 2 * 24 * 60 * MIN); // среда 12:00
    const start = T0 + 2 * 24 * 60 * MIN + 9 * 60 * MIN; // 21:00 по клубу
    const u = await h.login('+79994000000');
    const r = await book(u, { resource_id: table(2), starts_at: new Date(start).toISOString(), minutes: 60 });
    assert.equal(r.status, 201);
    const client = await h.pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'system', true)", [CLUB_A]);
      // Игра до 20:30, продление с 20:30.
      const next = await api.nextBookingStart(client, { resourceId: table(2), after: new Date(start - 30 * MIN) });
      assert.equal(next.toISOString(), new Date(start).toISOString());
      const deps = { bookings: api };
      const lim = await bookingLimit(client, deps, { resourceId: table(2), from: new Date(start - 30 * MIN) });
      assert.equal(lim.limitUntil.toISOString(), new Date(start - 5 * MIN).toISOString()); // «можно продлить до 20:55»
      assert.equal(lim.maxMinutes, 25);
      await assert.rejects(bookingLimit(client, deps, { resourceId: table(2), from: new Date(start - 4 * MIN) }), (e) => e.code === 'booking_conflict');
      // Бронь в удержании (началась, гость не пришёл) — чужую игру не начать.
      await assert.rejects(bookingLimit(client, deps, { resourceId: table(2), from: new Date(start + 10 * MIN) }), (e) => e.code === 'booking_conflict');
      // nextBooking — та же бронь целиком, без ПДн; nextBookingStart выражен через неё.
      const nb = await api.nextBooking(client, { resourceId: table(2), after: new Date(start - 30 * MIN) });
      assert.deepEqual(Object.keys(nb).sort(), ['ends_at', 'id', 'source', 'starts_at', 'status']);
      assert.deepEqual(nb, { id: r.json.id, starts_at: new Date(start).toISOString(), ends_at: new Date(start + 60 * MIN).toISOString(), source: 'app', status: 'pending_payment' });
      assert.equal(await api.nextBooking(client, { resourceId: table(2), after: new Date(start + 60 * MIN) }), null);
      // Другой стол — без предела.
      assert.equal(await api.nextBookingStart(client, { resourceId: table(6), after: new Date(start) }), null);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  it('старт по брони у стола: код стола, сессия light, чек зачёта, повтор безопасен', async () => {
    h.clock.set(T0 + 3 * 24 * 60 * MIN); // четверг 12:00
    const start = T0 + 3 * 24 * 60 * MIN + 120 * MIN;
    const u = await h.login('+79995000000');
    const p = await paidBooking(u, { resource: table(3), startMin: 3 * 24 * 60 + 120, minutes: 60 });
    h.clock.set(start - 3 * MIN);
    const code = await h.code(table(3));
    // Чужой гость — не найдено; не тот код — forbidden.
    assert.equal((await h.request('POST', `/api/bookings/${p.id}/start`, { token: guest2.token, body: { code } })).status, 404);
    const wrong = await h.request('POST', `/api/bookings/${p.id}/start`, { token: u.token, body: { code: await h.code(table(4)) } });
    assert.equal(wrong.status, 403);
    const ok = await h.request('POST', `/api/bookings/${p.id}/start`, { token: u.token, body: { code: code.toLowerCase() } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.status, 'started');
    const [s] = await h.q('select * from bl.sessions where id = $1', [ok.json.session_id]);
    assert.equal(s.source, 'booking');
    assert.equal(s.booking_id, p.id);
    assert.equal(s.payer_user_id, u.id);
    assert.equal(new Date(s.paid_until).getTime(), start + 60 * MIN);
    const settle = h.moneyCalls.filter((c) => c.fn === 'settlePrepayment' && c.args.paymentId === p.paymentId);
    assert.equal(settle.length, 1);
    assert.equal(settle[0].args.sessionId, s.id);
    assert.equal((await h.payment(p.paymentId)).settlement_status, 'settled');
    assert.equal((await h.booking(p.id)).status, 'started');
    assert.equal((await h.outboxEvents('booking.started')).filter((e) => e.payload.booking_id === p.id).length, 1);
    // Повтор — та же сессия, без второго чека.
    const again = await h.request('POST', `/api/bookings/${p.id}/start`, { token: u.token, body: { code } });
    assert.equal(again.json.session_id, s.id);
    assert.equal(h.moneyCalls.filter((c) => c.fn === 'settlePrepayment' && c.args.paymentId === p.paymentId).length, 1);
    // Сессия закрылась — бронь завершена.
    await h.closeSession(s.id);
    await waitFor(async () => (await h.booking(p.id)).status === 'completed');
  });

  it('ранний приход при свободном столе — доплата котировкой money, старт по её оплате', async () => {
    h.clock.set(T0 + 4 * 24 * 60 * MIN); // пятница 12:00
    const start = T0 + 4 * 24 * 60 * MIN + 120 * MIN; // 14:00, 600 ₽/ч
    const u = await h.login('+79996000000');
    const p = await paidBooking(u, { resource: table(5), startMin: 4 * 24 * 60 + 120, minutes: 60 });
    h.clock.set(start - 60 * MIN);
    const code = await h.code(table(5));
    const r = await h.request('POST', `/api/bookings/${p.id}/start`, { token: u.token, body: { code } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'payment_required');
    assert.equal(r.json.amount_kopecks, 60_000);
    assert.equal(r.json.quote.amount_kopecks, 60_000);
    const q = h.moneyCalls.filter((c) => c.fn === 'createBookingQuote' && c.args.bookingId === p.id).at(-1);
    assert.equal(q.args.amountKopecks, 60_000);
    assert.equal(q.args.minutes, 120);
    assert.equal(q.args.earlyMinutes, 60);
    // Слишком рано (больше 2 часов) — too_early.
    h.clock.set(start - 3 * 60 * MIN);
    assert.equal((await h.request('POST', `/api/bookings/${p.id}/start`, { token: u.token, body: { code } })).json.error, 'too_early');
    // Котировка жила 3 минуты от start - 60: оплачиваем сразу (часы — назад к её моменту).
    h.clock.set(start - 59 * MIN);
    const qp = await h.request('POST', `/api/quotes/${r.json.quote.quote_id}/pay`, { token: u.token, key: crypto.randomUUID(), body: { method: 'sbp' } });
    assert.equal(qp.status, 200, qp.text);
    const extraId = qp.json.payment_id;
    assert.equal((await h.payment(extraId)).kind, 'booking_start');
    await h.succeed(extraId);
    await waitFor(async () => (await h.booking(p.id)).status === 'started');
    const b = await h.booking(p.id);
    const [s] = await h.q('select * from bl.sessions where id = $1', [b.session_id]);
    assert.equal(new Date(s.paid_until).getTime(), start + 60 * MIN);
    assert.equal(h.moneyCalls.filter((c) => c.fn === 'settlePrepayment' && c.args.paymentId === p.paymentId).length, 1);
    assert.deepEqual((await h.q('select payment_id from bl.session_payments where session_id = $1 order by payment_id', [s.id])).map((x) => x.payment_id).sort(), [p.paymentId, extraId].sort());
    await h.closeSession(s.id);
    await h.drain();
  });

  it('бронь без предоплаты: оплата при приходе тем же платежом брони, старт по подтверждению', async () => {
    await h.setSettings({ booking_prepayment: 'none' });
    try {
      h.clock.set(T0 + 5 * 24 * 60 * MIN); // суббота 12:00
      const start = T0 + 5 * 24 * 60 * MIN + 60 * MIN;
      const u = await h.login('+79997000000');
      const r = await book(u, { resource_id: table(6), starts_at: new Date(start).toISOString(), minutes: 60 });
      assert.equal(r.status, 201);
      assert.equal(r.json.status, 'confirmed');
      assert.equal(r.json.prepayment_kopecks, 0);
      assert.equal((await h.booking(r.json.id)).hold_minutes, 15);
      h.clock.set(start);
      const code = await h.code(table(6));
      const st = await h.request('POST', `/api/bookings/${r.json.id}/start`, { token: u.token, body: { code } });
      assert.equal(st.status, 200, st.text);
      assert.equal(st.json.status, 'payment_required');
      assert.equal(st.json.amount_kopecks, 60_000);
      assert.equal(h.moneyCalls.filter((c) => c.fn === 'createPrepayment' && c.args.bookingId === r.json.id).length, 0);
      const qp = await h.request('POST', `/api/quotes/${st.json.quote.quote_id}/pay`, { token: u.token, key: crypto.randomUUID(), body: { method: 'card' } });
      assert.equal(qp.status, 200, qp.text);
      await h.succeed(qp.json.payment_id);
      await waitFor(async () => (await h.booking(r.json.id)).status === 'started');
      const b = await h.booking(r.json.id);
      assert.ok(b.session_id);
      assert.equal(h.moneyCalls.filter((c) => c.fn === 'settlePrepayment' && c.args.bookingId === r.json.id).length, 0);
    } finally {
      await h.setSettings({ booking_prepayment: 'full' });
    }
  });

  it('отмена гостем: вовремя — вернуть всё, поздно — удержание по правилам; повторная — booking_not_active', async () => {
    h.clock.set(T0 + 6 * 24 * 60 * MIN); // воскресенье 12:00
    const u = await h.login('+79998000000');
    const early = await paidBooking(u, { resource: table(7), startMin: 6 * 24 * 60 + 300, minutes: 60 });
    const c1 = await h.request('POST', `/api/bookings/${early.id}/cancel`, { token: u.token, body: {} });
    assert.equal(c1.status, 200, c1.text);
    assert.equal(c1.json.status, 'canceled');
    assert.equal(c1.json.refund_kopecks, early.amount);
    assert.equal(h.moneyCalls.filter((c) => c.fn === 'forfeitPrepayment' && c.args.paymentId === early.paymentId)[0].args.percent, 0);
    assert.equal((await h.refunds(early.paymentId)).reduce((x, y) => x + Number(y.amount_kopecks), 0), early.amount);

    const late = await paidBooking(u, { resource: table(7), startMin: 6 * 24 * 60 + 60, minutes: 60 });
    const v = await h.request('GET', `/api/bookings/${late.id}`, { token: u.token });
    assert.equal(v.json.cancel.allowed, true);
    assert.equal(v.json.cancel.refund_kopecks, 0);
    const c2 = await h.request('POST', `/api/bookings/${late.id}/cancel`, { token: u.token, body: {} });
    assert.equal(c2.json.refund_kopecks, 0);
    assert.equal(h.moneyCalls.filter((c) => c.fn === 'forfeitPrepayment' && c.args.paymentId === late.paymentId)[0].args.percent, 100);
    assert.equal((await h.refunds(late.paymentId)).length, 0);
    assert.equal((await h.request('POST', `/api/bookings/${late.id}/cancel`, { token: u.token, body: {} })).json.error, 'booking_not_active');
    assert.equal((await h.outboxEvents('booking.canceled')).filter((e) => [early.id, late.id].includes(e.payload.booking_id)).length, 2);
  });

  it('отмена управляющим — только с причиной, ручное действие: журнал manual.*, тревога владельцу, полный возврат', async () => {
    h.clock.set(T0 + 7 * 24 * 60 * MIN);
    const u = await h.login('+79998100000');
    const p = await paidBooking(u, { resource: table(8), startMin: 7 * 24 * 60 + 60, minutes: 60 });
    // Ресепшн бронь из приложения с предоплатой не отменяет (№115); без клуба — не найдено.
    const rec = await h.request('POST', `/api/bookings/${p.id}/cancel`, { token: reception.token, club: CLUB_A, body: { reason: 'x' } });
    assert.equal(rec.status, 403);
    assert.equal((await h.request('POST', `/api/bookings/${p.id}/cancel`, { token: manager.token, body: { reason: 'x' } })).status, 404);
    // can_cancel по роли запрашивающего (№115).
    assert.equal((await h.request('GET', `/api/bookings/${p.id}`, { token: reception.token, club: CLUB_A })).json.can_cancel, false);
    assert.equal((await h.request('GET', `/api/bookings/${p.id}`, { token: manager.token, club: CLUB_A })).json.can_cancel, true);
    assert.ok(!('can_cancel' in (await h.request('GET', `/api/bookings/${p.id}`, { token: u.token })).json));
    const noReason = await h.request('POST', `/api/bookings/${p.id}/cancel`, { token: manager.token, club: CLUB_A, body: {} });
    assert.equal(noReason.json.error, 'reason_required');
    const ok = await h.request('POST', `/api/bookings/${p.id}/cancel`, { token: manager.token, club: CLUB_A, body: { reason: 'Стол на ремонте' } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.refund_kopecks, p.amount);
    assert.equal(h.moneyCalls.filter((c) => c.fn === 'forfeitPrepayment' && c.args.paymentId === p.paymentId)[0].args.percent, 0);
    assert.equal((await h.refunds(p.paymentId)).reduce((x, y) => x + Number(y.amount_kopecks), 0), p.amount);
    const a = (await h.audit('manual.booking_cancel')).filter((x) => x.object_id === p.id);
    assert.equal(a.length, 1);
    assert.equal(a[0].reason, 'Стол на ремонте');
    const alarm = await h.q("select * from bl.alarms where type = 'manual_action' and data->>'booking_id' = $1", [p.id]);
    assert.equal(alarm.length, 1);
    assert.ok((await h.notifications(owner.id)).some((n) => /Отмена брони/.test(n.text)));
    assert.equal((await h.notifications(u.id, 'booking.canceled')).length, 1);
  });

  it('ресепшн отменяет бронь по телефону без предоплаты: причина, manual.booking_cancel, тревога владельцу (№115)', async () => {
    h.clock.set(T0 + 7 * 24 * 60 * MIN);
    const r = await h.request('POST', `/api/clubs/${CLUB_A}/bookings`, {
      token: reception.token,
      body: { resource_id: table(7), starts_at: h.at(7 * 24 * 60 + 240), minutes: 60, name: 'Анна', phone: '+79123334455' },
    });
    assert.equal(r.status, 201, r.text);
    assert.equal((await h.request('POST', `/api/bookings/${r.json.id}/cancel`, { token: reception.token, club: CLUB_A, body: {} })).json.error, 'reason_required');
    const c = await h.request('POST', `/api/bookings/${r.json.id}/cancel`, { token: reception.token, club: CLUB_A, body: { reason: 'Гость позвонил' } });
    assert.equal(c.status, 200, c.text);
    assert.equal(c.json.status, 'canceled');
    assert.equal((await h.audit('manual.booking_cancel')).filter((x) => x.object_id === r.json.id).length, 1);
    assert.equal((await h.q("select * from bl.alarms where type = 'manual_action' and data->>'booking_id' = $1", [r.json.id])).length, 1);
    assert.equal(h.moneyCalls.filter((x) => x.fn === 'forfeitPrepayment' && x.args.reason?.includes('Гость позвонил')).length, 0);
  });

  it('опоздавший гость брони без предоплаты платит только с прихода до конца брони (№113)', async () => {
    await h.setSettings({ booking_prepayment: 'none' });
    try {
      h.clock.set(T0 + 10 * 24 * 60 * MIN); // четверг 12:00
      const start = T0 + 10 * 24 * 60 * MIN + 60 * MIN; // 13:00, 500 ₽/ч
      const u = await h.login('+79997100000');
      const r = await book(u, { resource_id: table(3), starts_at: new Date(start).toISOString(), minutes: 60 });
      assert.equal(r.json.amount_kopecks, 50_000);
      h.clock.set(start + 12 * MIN);
      const st = await h.request('POST', `/api/bookings/${r.json.id}/start`, { token: u.token, body: { code: await h.code(table(3)) } });
      assert.equal(st.status, 200, st.text);
      assert.equal(st.json.status, 'payment_required');
      assert.equal(st.json.amount_kopecks, 40_000); // 48 минут по 500 ₽/ч
      const call = h.moneyCalls.filter((x) => x.fn === 'createBookingQuote' && x.args.bookingId === r.json.id).at(-1);
      assert.equal(call.args.amountKopecks, 40_000);
      assert.equal(call.args.minutes, 48);
      assert.equal(st.json.quote.amount_kopecks, 40_000);
    } finally {
      await h.setSettings({ booking_prepayment: 'full' });
    }
  });

  it('котировка старта money: без функции — 501 not_configured, с ней — функция money', async () => {
    const { resolveDeps } = await import('../../deps.mjs');
    const money = await import('../../../payments/api.mjs');
    const deps = await resolveDeps({ outbox: { enqueue() {}, subscribe() {} } }, null);
    if (typeof money.createBookingQuote === 'function') {
      assert.equal(deps.payments.createBookingQuote, money.createBookingQuote);
    } else {
      await assert.rejects(deps.payments.createBookingQuote(null, {}), (e) => e.status === 501 && e.code === 'not_configured');
    }
  });

  it('две оплаченные попытки предоплаты: бронь берёт первую, лишнюю возвращает целиком (№116)', async () => {
    h.clock.set(T0 + 8 * 24 * 60 * MIN);
    const u = await h.login('+79998300000');
    const r = await book(u, { resource_id: table(5), starts_at: h.at(8 * 24 * 60 + 300), minutes: 60 });
    assert.equal(r.status, 201, r.text);
    const p1 = await h.request('POST', `/api/bookings/${r.json.id}/pay`, { token: u.token, key: crypto.randomUUID(), body: { method: 'sbp' } });
    const p2 = await h.request('POST', `/api/bookings/${r.json.id}/pay`, { token: u.token, key: crypto.randomUUID(), body: { method: 'card' } });
    assert.equal(p2.status, 200, p2.text);
    assert.notEqual(p1.json.payment_id, p2.json.payment_id);
    await h.succeed(p1.json.payment_id);
    await waitFor(async () => (await h.booking(r.json.id)).status === 'confirmed');
    await h.succeed(p2.json.payment_id);
    await h.drain();
    const b = await h.booking(r.json.id);
    assert.equal(b.status, 'confirmed');
    assert.equal(b.prepayment_id, p1.json.payment_id);
    assert.equal(Number(b.prepaid_kopecks), r.json.prepayment_kopecks);
    assert.equal((await h.refunds(p1.json.payment_id)).length, 0);
    assert.equal((await h.refunds(p2.json.payment_id)).reduce((x, y) => x + Number(y.amount_kopecks), 0), r.json.prepayment_kopecks);
    // Третья попытка — уже оплачено.
    const p3 = await h.request('POST', `/api/bookings/${r.json.id}/pay`, { token: u.token, key: crypto.randomUUID(), body: {} });
    assert.equal(p3.status, 409);
    assert.equal(p3.json.error, 'already_paid');
  });

  it('неоплаченная бронь сгорает через 15 минут; поздняя оплата возвращается целиком', async () => {
    h.clock.set(T0 + 8 * 24 * 60 * MIN);
    const u = await h.login('+79998200000');
    const r = await book(u, { resource_id: table(1), starts_at: h.at(8 * 24 * 60 + 240), minutes: 60 });
    assert.equal(r.status, 201, r.text);
    const pay = await h.request('POST', `/api/bookings/${r.json.id}/pay`, { token: u.token, key: crypto.randomUUID(), body: {} });
    h.clock.add(14 * MIN);
    await h.tick();
    assert.equal((await h.booking(r.json.id)).status, 'pending_payment');
    h.clock.add(MIN);
    await h.tick();
    const b = await h.booking(r.json.id);
    assert.equal(b.status, 'expired');
    assert.equal(b.expire_reason, 'unpaid');
    assert.equal((await h.request('POST', `/api/bookings/${r.json.id}/pay`, { token: u.token, key: crypto.randomUUID(), body: {} })).json.error, 'booking_expired');
    await h.succeed(pay.json.payment_id);
    await h.drain();
    const f = h.moneyCalls.filter((c) => c.fn === 'forfeitPrepayment' && c.args.paymentId === pay.json.payment_id);
    assert.equal(f.length, 1);
    assert.equal(f[0].args.percent, 0);
    assert.equal((await h.refunds(pay.json.payment_id)).reduce((x, y) => x + Number(y.amount_kopecks), 0), r.json.prepayment_kopecks);
    assert.equal((await h.booking(r.json.id)).status, 'expired');
  });

  it('бронь по телефону: ресепшн заводит, телефон маской, список дня, «гость пришёл»', async () => {
    h.clock.set(T0 + 9 * 24 * 60 * MIN);
    const r = await h.request('POST', `/api/clubs/${CLUB_A}/bookings`, {
      token: reception.token,
      body: { resource_id: table(2), starts_at: h.at(9 * 24 * 60 + 60), minutes: 120, name: 'Сергей', phone: '+7 (912) 345-67-89' },
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.source, 'phone');
    assert.equal(r.json.status, 'confirmed');
    assert.equal(r.json.guest.phone_masked, '+7912***6789');
    assert.ok(!r.text.includes('3456789'));
    // Гостю маршрут персонала недоступен.
    assert.equal((await h.request('POST', `/api/clubs/${CLUB_A}/bookings`, { token: guest.token, body: {} })).status, 403);
    const day = new Date(T0 + 9 * 24 * 60 * MIN).toISOString().slice(0, 10);
    const list = await h.request('GET', `/api/clubs/${CLUB_A}/bookings?date=${day}`, { token: reception.token });
    assert.equal(list.status, 200, list.text);
    const item = list.json.bookings.find((x) => x.id === r.json.id);
    assert.equal(item.guest.name, 'Сергей');
    assert.equal(item.can_cancel, true);
    assert.equal(r.json.can_cancel, true);
    assert.ok(!list.text.includes('3456789'));
    // Журнал без телефона.
    assert.ok((await h.audit('booking.create')).filter((a) => a.object_id === r.json.id).every((a) => !JSON.stringify(a.data).includes('3456789')));

    h.clock.set(T0 + 9 * 24 * 60 * MIN + 50 * MIN);
    await h.tick();
    assert.equal((await h.booking(r.json.id)).status, 'reserved');
    const hold = (await h.holds(table(2))).find((x) => x.kind === 'reserved' && !x.released_at);
    assert.equal(hold.user_id, null);
    const arrive = await h.request('POST', `/api/bookings/${r.json.id}/arrive`, { token: reception.token, club: CLUB_A, body: {} });
    assert.equal(arrive.status, 200, arrive.text);
    assert.equal(arrive.json.status, 'started');
    assert.ok((await h.holds(table(2))).filter((x) => x.kind === 'reserved').every((x) => x.released_at));
    // Конец брони — завершена (сессии нет).
    h.clock.set(T0 + 9 * 24 * 60 * MIN + 180 * MIN);
    await h.tick();
    assert.equal((await h.booking(r.json.id)).status, 'completed');
  });
});
