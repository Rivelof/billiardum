// Очередь уведомлений вне outbox и независимые очереди тем outbox (decisions №130).
// Канал «висит» — событие payment.confirmed всё равно обрабатывается сразу; повтор после
// сбоя процесса не шлёт второй раз в канал, где попытка уже была; общий бюджет времени.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { enqueue } from '../../outbox.mjs';
import { withContext } from '../../lib/store.mjs';
import { createNotifier, send } from '../../notify/index.mjs';
import { CLUB_A, startTestApp, waitFor } from './helpers.mjs';

let t;
const hanging = [];
const tgCalls = [];
let hold = true;
// Telegram приложения: пока hold, каждый вызов «висит» 10 с (или до отпускания).
const telegram = {
  configured: true,
  call(method, params) {
    tgCalls.push(params);
    if (!hold) return Promise.resolve({ ok: true });
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: true }), 10_000);
      hanging.push(() => {
        clearTimeout(timer);
        resolve({ ok: true });
      });
    });
  },
};

before(async () => {
  t = await startTestApp({ telegram, pollMs: 50 });
});

after(async () => {
  for (const release of hanging) release();
  await t?.stop();
});

const inClub = (fn) => withContext(t.pool, { clubId: CLUB_A, actorType: 'system' }, fn);

async function guest(phone, tgId) {
  const g = await t.login(phone);
  await t.admin.query("update bl.users set telegram_user_id = $2, channels_order = '{telegram}' where id = $1", [g.user.id, tgId]);
  return g;
}

describe('уведомления не задерживают outbox (№130)', () => {
  it('канал висит 10 с — payment.confirmed обработан < 1 с; медленная тема не держит другие', async () => {
    const seen = [];
    const offPay = t.outbox.subscribe('payment.confirmed', (p) => {
      seen.push({ topic: 'payment.confirmed', at: Date.now(), id: p.n });
    }, { name: 'test.payment_confirmed' });
    let releaseSlow;
    const offSlow = t.outbox.subscribe('test.slow', () => new Promise((r) => { releaseSlow = r; }), { name: 'test.slow' });
    try {
      // Пять уведомлений в зависший Telegram, медленное событие другой темы, затем оплата.
      const g = await guest('+79990013001', 4242001);
      await inClub(async (db) => {
        for (let i = 0; i < 5; i += 1) await send(db, g.user.id, { kind: 'info', text: `Сообщение ${i}`, level: 'important' });
        await enqueue(db, 'test.slow', { n: 0 });
      });
      await waitFor(() => tgCalls.length >= 4, { timeoutMs: 3_000 });
      const started = Date.now();
      await inClub((db) => enqueue(db, 'payment.confirmed', { n: 1 }));
      await waitFor(() => seen.length === 1, { timeoutMs: 1_000 });
      assert.ok(seen[0].at - started < 1_000, `payment.confirmed через ${seen[0].at - started} мс`);
      // Параллелизм воркера — 4: пятое уведомление ждёт свободного места.
      assert.equal(tgCalls.length, 4);
      const sending = await t.admin.query("select count(*)::int as n from bl.notifications where user_id = $1 and status = 'sending'", [g.user.id]);
      assert.equal(sending.rows[0].n, 4);
      releaseSlow();
      hold = false;
      for (const release of hanging.splice(0)) release();
      await waitFor(async () => (await t.admin.query("select count(*)::int as n from bl.notifications where user_id = $1 and status = 'sent'", [g.user.id])).rows[0].n === 5, { timeoutMs: 3_000 });
      assert.equal(tgCalls.length, 5, 'каждое уведомление — один вызов');
    } finally {
      offPay();
      offSlow();
    }
  });

  it('повтор после сбоя процесса: канал с начатой попыткой не повторяется; общий бюджет времени', async () => {
    await t.app.ctx.notify.stop(); // доставляет только notifier этой проверки
    const g = await guest('+79990013002', 4242002);
    await t.admin.query('update bl.users set max_user_id = $2, channels_order = null where id = $1', [g.user.id, 'm-4242002']);
    const calls = [];
    const fast = { configured: true, async call(m, p) { calls.push(p); return { ok: true }; } };
    const hang = { configured: true, call: () => new Promise(() => {}) };
    const notifier = createNotifier({ config: { vapid: {} }, log: t.log, telegram: fast, max: hang, deliveryTimeoutMs: 5_000, budgetMs: 200 });
    notifier.start({ pool: t.pool, withContext });
    try {
      // Сбой во время отправки в Telegram: захват устарел, попытка telegram «started».
      const a = await inClub((db) => send(db, g.user.id, { kind: 'info', text: 'Сбой' }));
      await t.admin.query(
        `update bl.notifications set status = 'sending', claimed_at = now() - interval '1 hour',
                attempts = '[{"channel":"max","status":"failed","code":"timeout","at":"2026-10-22T00:00:00Z"},{"channel":"telegram","status":"started","at":"2026-10-22T00:00:01Z"}]'::jsonb
          where id = $1`,
        [a.notification_id],
      );
      await notifier.deliverNow(a.notification_id);
      const n = (await t.admin.query('select status, attempts from bl.notifications where id = $1', [a.notification_id])).rows[0];
      assert.equal(calls.length, 0, 'в Telegram второй раз не шлём');
      assert.equal(n.status, 'failed');
      assert.deepEqual(n.attempts.map((x) => `${x.channel}:${x.status}`), ['max:failed', 'telegram:unknown']);

      // Бюджет 200 мс: MAX висит — тайм-аут по бюджету, на Telegram времени не осталось.
      const b = await inClub((db) => send(db, g.user.id, { kind: 'info', text: 'Бюджет' }));
      const started = Date.now();
      await notifier.deliverNow(b.notification_id);
      assert.ok(Date.now() - started < 2_000);
      const nb = (await t.admin.query('select status, attempts from bl.notifications where id = $1', [b.notification_id])).rows[0];
      assert.deepEqual(nb.attempts.map((x) => `${x.channel}:${x.status}:${x.code ?? ''}`), ['max:failed:timeout', 'telegram:failed:budget']);
      assert.equal(nb.status, 'failed');
      // Уже доставленное (или захваченное) не берётся повторно.
      await notifier.deliverNow(b.notification_id);
      assert.equal(calls.length, 0);
    } finally {
      await notifier.stop();
    }
  });
});
