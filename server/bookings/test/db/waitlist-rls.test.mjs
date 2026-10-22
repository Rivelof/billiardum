// Лист ожидания (T20), доступность без входа и без ПДн, RLS броней и очереди.
// Без DATABASE_ADMIN_URL тесты пропускаются.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { asRole, tryQuery } from '../../../../supabase/tests/helpers.mjs';
import { CLUB_A, CLUB_B, MIN, PHONES, setup, T0, TABLE_B, table, waitFor } from './harness.mjs';

const skip = !process.env.DATABASE_ADMIN_URL;

describe('лист ожидания, доступность, RLS', { skip }, () => {
  let h;
  let a;
  let b;
  let c;
  let ownerB;

  before(async () => {
    h = await setup({ settings: { booking_prepayment: 'full' } });
    a = await h.login('+79990000011');
    b = await h.login('+79990000012');
    c = await h.login('+79990000013');
    ownerB = await h.login(PHONES.ownerB);
  });
  after(async () => {
    await h?.close();
  });

  it('T20: стол освободился — первому предложение на 5 минут, не ответил — следующему, принял — стол удержан', async () => {
    h.clock.set(T0);
    const s = await h.session({ resourceId: table(1), payer: c.id, paidUntilMs: T0 + 30 * MIN });
    const ja = await h.request('POST', '/api/waitlist', { token: a.token, body: { resource_id: table(1) } });
    assert.equal(ja.status, 201, ja.text);
    assert.equal(ja.json.status, 'waiting');
    assert.equal(ja.json.position, 1);
    const jb = await h.request('POST', '/api/waitlist', { token: b.token, body: { resource_id: table(1) } });
    assert.equal(jb.json.position, 2);
    // Повтор — та же запись; свободный стол — table_free.
    assert.equal((await h.request('POST', '/api/waitlist', { token: a.token, body: { resource_id: table(1) } })).json.id, ja.json.id);
    const free = await h.request('POST', '/api/waitlist', { token: a.token, body: { resource_id: table(2) } });
    assert.equal(free.status, 409);
    assert.equal(free.json.error, 'table_free');

    h.clock.set(T0 + 32 * MIN);
    await h.closeSession(s);
    await waitFor(async () => (await h.q('select status from bl.waitlist where id = $1', [ja.json.id]))[0].status === 'offered');
    const na = await h.notifications(a.id, 'waitlist.offer');
    assert.equal(na.length, 1);
    assert.match(na[0].text, /Стол 1 свободен — он ваш на 5 минут/);
    assert.equal(na[0].actions?.[0]?.url, `/app/waitlist/${ja.json.id}`);
    assert.equal((await h.outboxEvents('waitlist.offered')).length, 1);
    assert.ok(h.sseEvents.some((e) => e.channel === `user:${a.id}` && e.event === 'waitlist' && e.data.status === 'offered'));
    const mineA = await h.request('GET', '/api/me/waitlist', { token: a.token });
    assert.equal(mineA.json[0].status, 'offered');
    assert.equal(mineA.json[0].offer_until, new Date(T0 + 37 * MIN).toISOString());

    // 4 минуты — ещё за A; 5 минут — A истёк, B получил предложение.
    h.clock.set(T0 + 36 * MIN);
    await h.tickWaitlist();
    assert.equal((await h.q('select status from bl.waitlist where id = $1', [jb.json.id]))[0].status, 'waiting');
    h.clock.set(T0 + 37 * MIN);
    await h.tickWaitlist();
    assert.equal((await h.q('select status from bl.waitlist where id = $1', [ja.json.id]))[0].status, 'expired');
    assert.equal((await h.q('select status from bl.waitlist where id = $1', [jb.json.id]))[0].status, 'offered');
    // A опоздал — offer_expired.
    assert.equal((await h.request('POST', `/api/waitlist/${ja.json.id}/accept`, { token: a.token, body: {} })).json.error, 'offer_expired');
    // Чужую запись не принять.
    assert.equal((await h.request('POST', `/api/waitlist/${jb.json.id}/accept`, { token: a.token, body: {} })).status, 404);

    h.clock.set(T0 + 38 * MIN);
    const acc = await h.request('POST', `/api/waitlist/${jb.json.id}/accept`, { token: b.token, body: {} });
    assert.equal(acc.status, 200, acc.text);
    assert.equal(acc.json.status, 'accepted');
    assert.equal(acc.json.resource_id, table(1));
    const hold = (await h.holds(table(1))).find((x) => x.kind === 'pending' && !x.released_at);
    assert.equal(hold.user_id, b.id);
    assert.equal(new Date(hold.until).getTime(), T0 + 41 * MIN);
    assert.equal((await h.outboxEvents('waitlist.accepted')).length, 1);
    // Повтор принятия — тот же ответ.
    assert.equal((await h.request('POST', `/api/waitlist/${jb.json.id}/accept`, { token: b.token, body: {} })).status, 200);
    // Отказ после принятия — удержание снято.
    await h.request('DELETE', `/api/waitlist/${jb.json.id}`, { token: b.token, body: {} });
    assert.ok((await h.holds(table(1))).filter((x) => x.kind === 'pending').every((x) => x.released_at));
  });

  it('стол заняли до принятия — запись возвращается в очередь, 409 table_busy', async () => {
    h.clock.set(T0 + 120 * MIN);
    const s = await h.session({ resourceId: table(3), payer: c.id, paidUntilMs: T0 + 130 * MIN });
    const j = await h.request('POST', '/api/waitlist', { token: a.token, body: { resource_id: table(3) } });
    h.clock.set(T0 + 132 * MIN);
    await h.closeSession(s);
    await waitFor(async () => (await h.q('select status from bl.waitlist where id = $1', [j.json.id]))[0].status === 'offered');
    await h.session({ resourceId: table(3), payer: c.id, paidUntilMs: T0 + 200 * MIN });
    const acc = await h.request('POST', `/api/waitlist/${j.json.id}/accept`, { token: a.token, body: {} });
    assert.equal(acc.status, 409);
    assert.equal(acc.json.error, 'table_busy');
    const [w] = await h.q('select status, missed from bl.waitlist where id = $1', [j.json.id]);
    assert.equal(w.status, 'waiting');
    assert.equal(w.missed, 1);
  });

  it('бронь сгорела или отменена — очередь получает стол; бронь ближе 30 минут — предложения нет', async () => {
    h.clock.set(T0 + 240 * MIN);
    const s = await h.session({ resourceId: table(4), payer: c.id, paidUntilMs: T0 + 250 * MIN });
    const r = await h.request('POST', '/api/bookings', { token: b.token, body: { resource_id: table(4), starts_at: h.at(270), minutes: 60 } });
    assert.equal(r.status, 201, r.text);
    const j = await h.request('POST', '/api/waitlist', { token: a.token, body: { resource_id: table(4) } });
    h.clock.set(T0 + 252 * MIN);
    await h.closeSession(s);
    await h.drain();
    // До брони 18 минут — не предлагаем.
    assert.equal((await h.q('select status from bl.waitlist where id = $1', [j.json.id]))[0].status, 'waiting');
    await h.request('POST', `/api/bookings/${r.json.id}/cancel`, { token: b.token, body: {} });
    await waitFor(async () => (await h.q('select status from bl.waitlist where id = $1', [j.json.id]))[0].status === 'offered');
  });

  it('доступность: без входа, рабочие сутки клуба, занятость без ПДн, цены, чужой клуб — свой', async () => {
    h.clock.set(T0 + 24 * 60 * MIN);
    const day = '2026-10-27';
    const s = await h.session({ resourceId: table(5), payer: c.id, paidUntilMs: T0 + 24 * 60 * MIN + 60 * MIN });
    const r = await h.request('POST', '/api/bookings', { token: c.token, body: { resource_id: table(6), starts_at: h.at(24 * 60 + 480), minutes: 120 } });
    assert.equal(r.status, 201, r.text);
    const res = await h.request('GET', `/api/clubs/${CLUB_A}/availability?date=${day}`);
    assert.equal(res.status, 200, res.text);
    const d = res.json;
    assert.equal(d.club.timezone, 'Asia/Yekaterinburg');
    assert.equal(d.from, '2026-10-27T01:00:00.000Z'); // 06:00 по клубу
    assert.equal(d.to, '2026-10-28T01:00:00.000Z');
    assert.equal(d.resources.length, 8);
    const t5 = d.resources.find((x) => x.number === 5);
    assert.deepEqual(t5.busy.find((x) => x.kind === 'session'), {
      from: h.at(24 * 60), to: new Date(T0 + 24 * 60 * MIN + 60 * MIN + 120_000).toISOString(), kind: 'session',
    });
    const t6 = d.resources.find((x) => x.number === 6);
    assert.deepEqual(t6.busy.filter((x) => x.kind === 'booking'), [{ from: h.at(24 * 60 + 480), to: h.at(24 * 60 + 600), kind: 'booking' }]);
    assert.equal(t6.free[0].from, d.now);
    assert.ok(t6.rates.some((x) => x.per_hour_kopecks === 80_000));
    // Нет ПДн: ни id пользователей, ни телефонов, ни броней.
    for (const id of [c.id, r.json.id, s]) assert.ok(!res.text.includes(id), id);
    assert.ok(!/\+7\d/.test(res.text));
    // Неверная дата, дата в прошлом.
    assert.equal((await h.request('GET', `/api/clubs/${CLUB_A}/availability?date=2026-13-40`)).status, 400);
    assert.equal((await h.request('GET', `/api/clubs/${CLUB_A}/availability?date=2026-10-01`)).status, 400);
    // Не UUID и несуществующий клуб.
    assert.ok([400, 404].includes((await h.request('GET', '/api/clubs/abc/availability')).status));
    assert.equal((await h.request('GET', '/api/clubs/c9000000-0000-4000-8000-000000000009/availability')).status, 404);
    // Клуб Б — только его стол.
    const other = await h.request('GET', `/api/clubs/${CLUB_B}/availability?date=2026-10-27`);
    assert.equal(other.status, 200, other.text);
    assert.deepEqual(other.json.resources.map((x) => x.id), [TABLE_B]);
  });

  it('RLS: клуб видит только свои брони и очередь, гость — свои, app_api не удаляет', async () => {
    const [bk] = await h.q('select id, user_id from bl.bookings limit 1');
    await asRole(h.admin, 'app_api', { clubId: CLUB_B }, async (cl) => {
      assert.equal((await cl.query('select count(*)::int as n from bl.bookings')).rows[0].n, 0);
      assert.equal((await cl.query('select count(*)::int as n from bl.waitlist')).rows[0].n, 0);
      const up = await cl.query(`update bl.bookings set status = 'canceled', canceled_at = now() where id = $1`, [bk.id]);
      assert.equal(up.rowCount, 0);
    });
    await asRole(h.admin, 'app_api', { clubId: CLUB_A }, async (cl) => {
      assert.ok((await cl.query('select count(*)::int as n from bl.bookings')).rows[0].n > 0);
      assert.equal((await tryQuery(cl, 'delete from bl.bookings where id = $1', [bk.id]))?.code, '42501');
      assert.equal((await tryQuery(cl, 'update bl.bookings set amount_kopecks = 1 where id = $1', [bk.id]))?.code, '42501');
      // Вставка в чужой клуб — отказ политики.
      const ins = await tryQuery(
        cl,
        `insert into bl.bookings (club_id, resource_id, guest_name, guest_phone, source, starts_at, ends_at, status, prepayment_mode,
                                  amount_kopecks, hold_minutes, created_at, updated_at)
         values ($1, $2, 'X', '+79120000000', 'phone', now(), now() + interval '1 hour', 'confirmed', 'none', 0, 15, now(), now())`,
        [CLUB_B, TABLE_B],
      );
      assert.equal(ins?.code, '42501');
    });
    // Личный контекст: только свои брони.
    await asRole(h.admin, 'app_api', { userId: bk.user_id }, async (cl) => {
      const { rows } = await cl.query('select distinct user_id from bl.bookings');
      assert.deepEqual(rows.map((x) => x.user_id), [bk.user_id]);
    });
    await asRole(h.admin, 'app_api', { userId: a.id }, async (cl) => {
      const { rows } = await cl.query('select count(*)::int as n from bl.bookings where id = $1', [bk.id]);
      assert.equal(rows[0].n, bk.user_id === a.id ? 1 : 0);
    });
    // Чужая бронь по API — не найдено; владелец клуба Б не видит брони клуба А.
    const foreign = bk.user_id === a.id ? b : a;
    assert.equal((await h.request('GET', `/api/bookings/${bk.id}`, { token: foreign.token })).status, 404);
    assert.equal((await h.request('GET', `/api/bookings/${bk.id}`, { token: ownerB.token, club: CLUB_B })).status, 404);
    assert.equal((await h.request('GET', `/api/clubs/${CLUB_A}/bookings`, { token: ownerB.token })).status, 403);
  });

  it('bl.booking_due — SECURITY DEFINER, владелец bl_definer, видит только поля планировщика', async () => {
    const [f] = await h.q(`select pg_get_userbyid(proowner) as owner, prosecdef, proconfig from pg_proc where proname = 'booking_due'`);
    assert.equal(f.owner, 'bl_definer');
    assert.equal(f.prosecdef, true);
    assert.ok(f.proconfig.some((x) => x.startsWith('search_path=pg_catalog')));
    await asRole(h.admin, 'bl_definer', {}, async (cl) => {
      assert.equal((await tryQuery(cl, 'select guest_phone from bl.bookings'))?.code, '42501');
      assert.equal((await tryQuery(cl, 'select user_id from bl.waitlist'))?.code, '42501');
      assert.equal(await tryQuery(cl, 'select id, club_id, status, starts_at from bl.bookings'), null);
    });
  });
});
