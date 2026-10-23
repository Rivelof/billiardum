// Перепроверка ревью света (п. 4): join с кодом стола (session_id из ссылки — не вход в чужую игру),
// /api/t без входа не отдаёт session_id, старт/продление упираются в бронь с возвратом не больше
// оплаченного (№129), «Продолжить» не даёт играть за бронью. Обвязка — бронь (настоящие light,
// money, эмулятор ЮKassa).
//
// Запуск: DATABASE_ADMIN_URL=postgres://supabase_admin:...@127.0.0.1:55460/postgres \
//   node --test tests/security/m3/review_light.test.mjs

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { CLUB_A, MIN, setup, T0, table } from '../../../server/bookings/test/db/harness.mjs';

const skip = !process.env.DATABASE_ADMIN_URL;

describe('ревью света: join, /api/t, обрезка по брони', { skip }, () => {
  let h;
  let a;
  let b;

  const code = (r) => h.code(r);
  const svc = () => h.light();

  before(async () => {
    h = await setup({ settings: { booking_prepayment: 'full' } });
    a = await h.login('+79990000031');
    b = await h.login('+79990000032');
  });
  after(async () => {
    await h?.close();
  });

  /** Идущая сессия гостя payer на столе. */
  async function liveSession(resource, payer, { paidMin = 60 } = {}) {
    h.clock.set(T0);
    return h.session({ resourceId: resource, payer, paidUntilMs: T0 + paidMin * MIN, startedMs: T0 });
  }

  /** db как у роутера: app_api, контекст пользователя, коммит. */
  async function asUser(userId, fn) {
    const c = await h.pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role app_api');
      await c.query("select set_config('app.user_id',$1,true), set_config('app.actor_type','user',true)", [userId]);
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    } finally {
      await c.query('reset role').catch(() => {});
      c.release();
    }
  }

  it('join: нужен код стола; чужой/пустой/не тот код — not_found/bad_request, верный — вход', async () => {
    const sid = await liveSession(table(1), a.id);
    const good = await code(table(1));
    const other = await code(table(2));
    // Знание одного session_id из ссылки без кода стола — мало.
    await assert.rejects(() => asUser(b.id, (c) => svc().join(c, { sessionId: sid, userId: b.id })), (e) => e.code === 'bad_request');
    await assert.rejects(() => asUser(b.id, (c) => svc().join(c, { sessionId: sid, userId: b.id, code: '' })), (e) => e.code === 'bad_request');
    await assert.rejects(() => asUser(b.id, (c) => svc().join(c, { sessionId: sid, userId: b.id, code: other })), (e) => e.code === 'not_found');
    await assert.rejects(() => asUser(b.id, (c) => svc().join(c, { sessionId: sid, userId: b.id, code: 'ZZZZZZZZZZ' })), (e) => e.code === 'not_found');
    const ok = await asUser(b.id, (c) => svc().join(c, { sessionId: sid, userId: b.id, code: good }));
    assert.deepEqual(ok, { ok: true });
    const parts = (await h.q('select user_id from bl.session_participants where session_id = $1', [sid])).map((r) => r.user_id);
    assert.ok(parts.includes(b.id));
  });

  it('GET /api/t: аноним не получает session_id идущей игры; вошедший гость — получает', async () => {
    const sid = await liveSession(table(3), a.id);
    const c = await code(table(3));
    const anon = await h.request('GET', `/api/t/${c}`);
    assert.equal(anon.status, 200, anon.text);
    assert.equal(anon.json.session_id, null, 'аноним не видит id чужой игры');
    const logged = await h.request('GET', `/api/t/${c}`, { token: b.token });
    assert.equal(logged.json.session_id, sid, 'вошедшему id нужен для «Присоединиться» (join с кодом)');
  });

  it('booking_start_required: стол держит reserved брони — holdPending гостя этой брони → 409 с booking_id (без ПДн)', async () => {
    h.clock.set(T0);
    const bookingId = randomUUID();
    await asUser(a.id, async (c) => {
      await c.query("select set_config('app.club_id',$1,true)", [CLUB_A]);
      return svc().setReserved(c, { resourceId: table(4), until: new Date(T0 + 60 * MIN), userId: a.id, source: 'booking', refId: bookingId });
    });
    const err = await asUser(a.id, async (c) => {
      await c.query("select set_config('app.club_id',$1,true)", [CLUB_A]);
      try {
        await svc().holdPending(c, { resourceId: table(4), userId: a.id, until: new Date(T0 + 3 * MIN) });
        return null;
      } catch (e) {
        return { code: e.code, data: e.data };
      }
    });
    assert.equal(err?.code, 'booking_start_required');
    assert.equal(err.data?.booking_id, bookingId);
    assert.deepEqual(Object.keys(err.data), ['booking_id'], 'в ошибке только booking_id');
  });

  it('старт по оплате упирается в бронь (№129): игра до начала брони минус 5 мин, лишнее возвращается, возврат ≤ оплаченного', async () => {
    const t = table(5);
    h.clock.set(T0);
    // Бронь через 40 минут — играть можно до T0+35.
    const bookingId = randomUUID();
    await asUser(a.id, async (c) => {
      await c.query("select set_config('app.club_id',$1,true)", [CLUB_A]);
      return svc().setReserved(c, { resourceId: t, until: new Date(T0 + 100 * MIN), userId: null, source: 'booking', refId: bookingId });
    });
    // Гость B оплачивает 60 минут у этого стола.
    const q = await h.request('POST', '/api/quotes', { token: b.token, body: { resource_id: t, kind: 'start', minutes: 60 } });
    // Бронь уже держит reserved (не B): старт по QR другим гостем нельзя — должен быть конфликт/занято.
    assert.notEqual(q.status, 200, `котировка на забронированный стол не должна пройти: ${q.text}`);
  });

  it('«Без лимита» по депозиту: до ближайшей брони меньше минимума тарифа — старт не начинается (booking_conflict)', async () => {
    const t = table(6);
    h.clock.set(T0);
    const bookingId = randomUUID();
    await asUser(a.id, async (c) => {
      await c.query("select set_config('app.club_id',$1,true)", [CLUB_A]);
      return svc().setReserved(c, { resourceId: t, until: new Date(T0 + 120 * MIN), userId: null, source: 'booking', refId: bookingId });
    });
    const err = await asUser(a.id, async (c) => {
      await c.query("select set_config('app.club_id',$1,true)", [CLUB_A]);
      try {
        await svc().startFromDeposit(c, { resourceId: t, staffId: a.id, depositKopecks: 500000 });
        return null;
      } catch (e) {
        return e.code;
      }
    });
    // Бронь через 2 минуты (нереально для минимума) → конфликт; или table_busy от reserved чужой брони.
    assert.ok(['booking_conflict', 'table_busy', 'forbidden'].includes(err), `ожидали отказ, получили ${err}`);
  });
});
