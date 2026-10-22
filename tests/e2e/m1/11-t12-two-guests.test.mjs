// T12. Два гостя одновременно на свободный стол → первый удерживает стол 3 минуты, второй видит отказ.
//
// Гости A и B одновременно (Promise.all) запрашивают котировку start: ровно один получает 200,
// второй — 409 table_pending. Стол для всех pending (симулятор: white_blink), повтор B — тот же
// отказ. Текст для второго гостя — в браузерном тесте 12-browser (экран стола). Через 3 минуты
// (valid_until котировки) удержание снимается: стол free, B получает котировку. В конце B
// оплачивает и сразу «Закончить игру», чтобы освободить стол.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { adminClient, api, brief, emuSucceed, newGuest, ok, pay, providerId, quote, table, tableCode, waitFor, waitPaymentSession, waitSim, waitTableFree } from './helpers.mjs';

const TABLE = Number(process.env.E2E_T12_TABLE || 6);
let db;

before(async () => {
  db = await adminClient();
  await waitTableFree(TABLE);
});

after(async () => {
  await db?.end();
});

test(`T12: стол ${TABLE} — два гостя одновременно: первый удерживает 3 мин, второй — table_pending`, { timeout: 6 * 60_000 }, async (t) => {
  const [a, b] = await Promise.all([newGuest(), newGuest()]);
  const rid = (await table(TABLE)).resource.id;
  const [ra, rb] = await Promise.all([quote(a.token, { resourceId: rid, minutes: 60 }), quote(b.token, { resourceId: rid, minutes: 60 })]);
  t.diagnostic(`одновременно: A → HTTP ${ra.status} ${ra.json?.error ?? `quote ${ra.json?.quote_id?.slice(0, 8)} до ${ra.json?.valid_until}`}; B → HTTP ${rb.status} ${rb.json?.error ?? `quote ${rb.json?.quote_id?.slice(0, 8)}`}`);
  const okOnes = [ra, rb].filter((r) => r.status === 200);
  const refused = [ra, rb].filter((r) => r.status !== 200);
  assert.equal(okOnes.length, 1, 'ровно один удерживает стол');
  assert.equal(refused[0].status, 409);
  assert.equal(refused[0].json.error, 'table_pending');
  const [first, second] = ra.status === 200 ? [a, b] : [b, a];
  const q = okOnes[0].json;

  const x = await waitSim(TABLE, (y) => y.state.mode === 'pending', { timeoutMs: 5000 });
  const seenBySecond = await ok(api('GET', `/api/t/${tableCode(TABLE)}`, { token: second.token }));
  const again = await quote(second.token, { resourceId: rid, minutes: 120 });
  const firstAgain = await quote(first.token, { resourceId: rid, minutes: 120 });
  t.diagnostic(`симулятор: ${brief(x)}; второй видит status=${seenBySecond.status} busy_until=${seenBySecond.busy_until}; повтор второго → ${again.status} ${again.text}; первый снова → ${firstAgain.status} ${firstAgain.json?.error ?? 'ok'}`);
  assert.equal(x.state.led, 'white_blink');
  assert.equal(seenBySecond.status, 'pending');
  assert.equal(again.json?.error, 'table_pending');
  const { rows: holds } = await db.query("select kind, until, released_at from bl.resource_holds where resource_id = $1 and kind = 'pending' and created_at > now() - interval '1 minute' order by created_at desc limit 1", [rid]);
  const holdMs = new Date(holds[0].until) - new Date(q.valid_until);
  t.diagnostic(`удержание: until ${new Date(holds[0].until).toISOString()}, котировка до ${q.valid_until} (разница ${holdMs} мс), ${((new Date(holds[0].until) - Date.now()) / 1000).toFixed(0)} с осталось`);

  // Удержание истекает через 3 минуты.
  const holdUntil = Math.max(new Date(holds[0].until).getTime(), new Date(firstAgain.json?.valid_until ?? 0).getTime());
  const freeAt = await waitFor(
    async () => {
      const r = await api('GET', `/api/t/${tableCode(TABLE)}`);
      return r.json?.status === 'free' ? Date.now() : null;
    },
    { timeoutMs: 4 * 60_000, intervalMs: 1000, what: 'стол снова free' },
  );
  const simFree = await waitSim(TABLE, (y) => y.state.mode === 'free', { timeoutMs: 10_000 });
  t.diagnostic(`стол освободился через ${((freeAt - holdUntil) / 1000).toFixed(1)} с после конца удержания; симулятор: ${brief(simFree)}`);
  assert.ok(freeAt - holdUntil > -1500, 'не раньше конца удержания');
  assert.ok(freeAt - holdUntil < 35_000, 'удержание снято');

  const qb = await ok(quote(second.token, { resourceId: rid, minutes: 60 }));
  const old = await pay(first.token, q.quote_id, 'sbp');
  t.diagnostic(`второй теперь получил котировку ${qb.quote_id.slice(0, 8)}; оплата истёкшей котировки первого → HTTP ${old.status} ${old.text}`);
  assert.ok(old.status >= 400, 'истёкшая котировка не оплачивается');

  const pr = await ok(pay(second.token, qb.quote_id, 'sbp'));
  emuSucceed(providerId(pr));
  const p = await waitPaymentSession(second.token, pr.payment_id);
  await waitSim(TABLE, (y) => y.state.relay === true, { timeoutMs: 5000 });
  await ok(api('POST', `/api/sessions/${p.session_id}/stop`, { token: second.token, body: {} }));
  await waitSim(TABLE, (y) => y.state.mode === 'free', { timeoutMs: 5000 });
});
