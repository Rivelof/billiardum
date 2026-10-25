// PoC M5.8, заход 2 — Н-3: слово «корт» в описании платежей и возвратов ЮKassa и в позициях чека (bc51e24).
// Обвязка — server/bookings/test/db/harness.mjs (настоящие деньги, эмулятор ЮKassa); запросы к ЮKassa читаются из
// журнала эмулятора /__emu/requests: описание каждого POST /v3/payments и /v3/refunds и позиции чека.
// Проверяется: старт корта (котировка → оплата), предоплата брони, доплата при раннем приходе, отмена брони с
// возвратом; контроль — тот же набор для стола называет «Стол».
//
// Запуск (только свой Postgres на 127.0.0.1:55xxx!):
//   DATABASE_ADMIN_URL=postgres://postgres@127.0.0.1:55432/postgres node --test tests/security/m5-8/15-payment-labels.test.mjs

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import * as moneyApi from '../../../server/payments/api.mjs';
import { CLUB_A, MIN, setup, T0 } from '../../../server/bookings/test/db/harness.mjs';

const ADMIN = process.env.DATABASE_ADMIN_URL ?? '';
const SKIP = !/@(127\.0\.0\.1|localhost):55\d{3}\//.test(ADMIN);
if (SKIP) console.log('SKIP: задайте DATABASE_ADMIN_URL=postgres://postgres@127.0.0.1:55xxx/postgres (свой временный Postgres)');

const COURT_1 = 'e1000000-0000-4000-8000-000000000101';
const COURT_2 = 'e1000000-0000-4000-8000-000000000102';
const TABLE_3 = 'e1000000-0000-4000-8000-000000000003';
let h;
let n = 0;
const phone = () => `+7999600${String(7000 + (n += 1)).padStart(4, '0')}`;
/** Тексты ЮKassa, накопленные в эмуляторе: описания платежей и возвратов и позиции чеков (состояние в памяти процесса). */
const snapshot = () => {
  const out = [];
  for (const p of h.emu.state.payments.values()) {
    out.push(`payment ${p.id}: ${p.description ?? ''}`);
    for (const i of p.receipt?.items ?? []) out.push(`payment ${p.id} чек: ${i.description}`);
  }
  for (const r of h.emu.state.refunds.values()) {
    out.push(`refund ${r.id}: ${r.description ?? ''}`);
    for (const i of r.receipt?.items ?? []) out.push(`refund ${r.id} чек: ${i.description}`);
  }
  return out;
};
const fresh = (before) => snapshot().filter((t) => !before.has(t));

before(async () => {
  if (SKIP) return;
  h = await setup({ settings: { booking_prepayment: 'full' } });
});
after(async () => {
  await h?.close();
});

describe('тексты денег корта', { skip: SKIP }, () => {
  it('старт корта: описание платежа и позиция чека — «Корт 1», не «Стол»', async () => {
    h.clock.set(T0);
    const g = await h.login(phone());
    const before = new Set(snapshot());
    const q = await h.request('POST', '/api/quotes', { token: g.token, body: { resource_id: COURT_1, kind: 'start', minutes: 90 } });
    assert.equal(q.status, 200, q.text);
    const p = await h.request('POST', `/api/quotes/${q.json.quote_id}/pay`, { token: g.token, key: crypto.randomUUID(), body: { method: 'sbp' } });
    assert.equal(p.status, 200, p.text);
    const all = fresh(before);
    console.log('INFO  ' + all.join('\n  '));
    assert.ok(all.length >= 1);
    assert.ok(all.every((t) => !/стол/i.test(t)), all.join(' | '));
    assert.ok(all.some((t) => /Корт 1/.test(t)), all.join(' | '));
  });

  it('предоплата брони, доплата за ранний приход, отмена с возвратом: везде «корт»', async () => {
    h.clock.set(T0);
    const g = await h.login(phone());
    const before = new Set(snapshot());
    const startMin = 2 * 1440 + 6 * 60;
    const b = await h.request('POST', '/api/bookings', { token: g.token, body: { resource_id: COURT_2, starts_at: h.at(startMin), minutes: 90 } });
    assert.equal(b.status, 201, b.text);
    const pay = await h.request('POST', `/api/bookings/${b.json.id}/pay`, { token: g.token, key: crypto.randomUUID(), body: { method: 'sbp' } });
    await h.succeed(pay.json.payment_id);
    await h.drain();
    // Ранний приход → доплата → оплата.
    h.clock.set(T0 + (startMin - 40) * MIN);
    const st = await h.request('POST', `/api/bookings/${b.json.id}/start`, { token: g.token, body: { code: await h.code(COURT_2) } });
    assert.equal(st.json.status, 'payment_required', st.text);
    const sp = await h.request('POST', `/api/quotes/${st.json.quote.quote_id}/pay`, { token: g.token, key: crypto.randomUUID(), body: { method: 'sbp' } });
    assert.equal(sp.status, 200, sp.text);
    // Вторая бронь: отмена заранее → возврат предоплаты.
    h.clock.set(T0);
    const g2 = await h.login(phone());
    const b2 = await h.request('POST', '/api/bookings', { token: g2.token, body: { resource_id: COURT_2, starts_at: h.at(5 * 1440 + 6 * 60), minutes: 90 } });
    const p2 = await h.request('POST', `/api/bookings/${b2.json.id}/pay`, { token: g2.token, key: crypto.randomUUID(), body: { method: 'sbp' } });
    await h.succeed(p2.json.payment_id);
    await h.drain();
    const cancel = await h.request('POST', `/api/bookings/${b2.json.id}/cancel`, { token: g2.token, body: {} });
    assert.equal(cancel.status, 200, cancel.text);
    await h.drain();
    const all = fresh(before);
    console.log('INFO  ' + all.join('\n  '));
    assert.ok(all.some((t) => /^refund /.test(t)), 'возврат дошёл до ЮKassa');
    assert.ok(all.every((t) => !/стол/i.test(t)), `слово «стол» в текстах корта: ${all.filter((t) => /стол/i.test(t)).join(' | ')}`);
    assert.ok(all.some((t) => /^refund [^:]+: .*корт 2/.test(t)), 'описание возврата называет «корт 2»');
  });

  it('контроль: стол называется «Стол»', async () => {
    h.clock.set(T0);
    const g = await h.login(phone());
    const before = new Set(snapshot());
    const q = await h.request('POST', '/api/quotes', { token: g.token, body: { resource_id: TABLE_3, kind: 'start', minutes: 60 } });
    assert.equal(q.status, 200, q.text);
    const p = await h.request('POST', `/api/quotes/${q.json.quote_id}/pay`, { token: g.token, key: crypto.randomUUID(), body: { method: 'sbp' } });
    assert.equal(p.status, 200, p.text);
    const all = fresh(before);
    assert.ok(all.some((t) => /Стол 3/.test(t)) && all.every((t) => !/корт/i.test(t)), all.join(' | '));
  });

  it('возврат игры на корте без явного описания (staff/автоматика): «Возврат: корт 1»; у стола — «Возврат: стол 3»', async () => {
    h.clock.set(T0 + 20 * 1440 * MIN); // удержания прежних проверок сгорели
    const out = [];
    for (const [resource, minutes, word] of [[COURT_1, 90, 'корт 1'], [TABLE_3, 60, 'стол 3']]) {
      const g = await h.login(phone());
      const before = new Set(snapshot());
      const q = await h.request('POST', '/api/quotes', { token: g.token, body: { resource_id: resource, kind: 'start', minutes } });
      assert.equal(q.status, 200, q.text);
      const p = await h.request('POST', `/api/quotes/${q.json.quote_id}/pay`, { token: g.token, key: crypto.randomUUID(), body: { method: 'sbp' } });
      assert.equal(p.status, 200, p.text);
      await h.succeed(p.json.payment_id);
      await h.drain().catch(() => {});
      const c = await h.pool.connect();
      try {
        await c.query('begin');
        await c.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'system', true)", [CLUB_A]);
        await moneyApi.refund(c, { paymentId: p.json.payment_id, amountKopecks: 10000, reason: 'проверка текста' });
        await c.query('commit');
      } catch (e) {
        await c.query('rollback').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
      await h.emu.settle();
      const refundTexts = fresh(before).filter((t) => /^refund /.test(t));
      out.push(`${word}: ${refundTexts.join(' | ')}`);
      assert.ok(refundTexts.some((t) => new RegExp(`Возврат: ${word}`).test(t)), refundTexts.join(' | '));
    }
    console.log('INFO  ' + out.join('\n  '));
  });
});
