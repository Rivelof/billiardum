// Ревью (уведомления, №130): доставка уведомлений — отдельная очередь, свет после оплаты не ждёт
// каналы.
//
// На стенде каналы не настроены (MAX — заглушка, Telegram без токена и прокси), подвесить канал у
// живого сервера нечем, а Web Push на настоящие сервисы (FCM и др.) тест не шлёт. Поэтому:
// 1. Живой стек: в очередь уведомлений разом ставится E2E_REVIEW_FLOOD (200) уведомлений гостю с
//    цепочкой max → telegram (настоящий send() сервера в закоммиченной транзакции), и сразу — серия
//    E2E_REVIEW_NOTIFY_N (8) оплат игры на столе E2E_REVIEW_NOTIFY_TABLE (6): время «Оплатить» →
//    свет в контроллере не растёт (p95 < 1,5 с), очередь уведомлений разбирается.
// 2. «Канал висит» — тест сервера server/test/db/notify-queue.test.mjs (временная база): канал
//    висит 10 с — payment.confirmed обработан < 1 с; прогон и результат — в отчёте.

import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { after, before, test } from 'node:test';
import { send } from '../../../server/notify/index.mjs';
import {
  adminClient,
  api,
  CLUB_A,
  emuSucceed,
  MIN,
  newGuest,
  ok,
  pay,
  percentile,
  providerId,
  quote,
  RES,
  sleep,
  table,
  waitFor,
  waitSim,
  waitTableFree,
} from '../m3/helpers.mjs';

const T = Number(process.env.E2E_REVIEW_NOTIFY_TABLE || 6);
const FLOOD = Number(process.env.E2E_REVIEW_FLOOD || 200);
const N = Number(process.env.E2E_REVIEW_NOTIFY_N || 8);
let db;
let flooded;

before(async () => {
  db = await adminClient();
  await waitTableFree(T);
});

after(async () => {
  if (flooded) await db.query('update bl.users set max_user_id = null, telegram_user_id = null where id = $1', [flooded.user.id]).catch(() => null);
  await db?.end();
});

test(`свет после оплаты не ждёт очередь уведомлений (${FLOOD} уведомлений, ${N} оплат, стол ${T})`, { timeout: 15 * MIN }, async (t) => {
  flooded = await newGuest();
  await db.query('update bl.users set max_user_id = $2, telegram_user_id = $3, channels_order = $4 where id = $1', [flooded.user.id, `e2e_flood_${randomInt(1e9)}`, 8_000_000_000 + randomInt(1e9), ['max', 'telegram']]);
  const since = new Date();
  await db.query('begin');
  try {
    await db.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'system', true)", [CLUB_A]);
    for (let i = 0; i < FLOOD; i += 1) await send(db, flooded.user.id, { kind: 'e2e.flood', text: `Проверка очереди уведомлений ${i + 1}`, level: i % 10 === 0 ? 'critical' : 'info' });
    await db.query('commit');
  } catch (err) {
    await db.query('rollback');
    throw err;
  }
  const lat = [];
  const tbl = await table(T);
  for (let i = 0; i < N; i += 1) {
    const g = await newGuest();
    const q = await ok(quote(g.token, { resourceId: RES(T), minutes: 1 }));
    const pr = await ok(pay(g.token, q.quote_id));
    const pid = providerId(pr);
    const t0 = Date.now();
    emuSucceed(pid, { wait: false });
    const on = await waitSim(T, (x) => x.state.relay === true, { timeoutMs: 15_000, intervalMs: 25, what: 'свет' });
    lat.push(Date.now() - t0);
    const { rows: queued } = await db.query("select count(*)::int as n from bl.notifications where user_id = $1 and status in ('queued', 'sending')", [flooded.user.id]);
    if (i === 0 || i === N - 1) t.diagnostic(`оплата ${i + 1}: свет через ${lat.at(-1)} мс; в очереди уведомлений ещё ${queued[0].n}`);
    await ok(api('POST', `/api/sessions/${on.state.session_id}/stop`, { token: g.token }));
    await waitSim(T, (x) => x.state.relay === false && x.state.mode === 'free', { timeoutMs: 10_000 });
    await sleep(300);
  }
  assert.ok(tbl.resource.id);
  const sorted = [...lat].sort((a, b) => a - b);
  const done = await waitFor(async () => {
    const { rows } = await db.query("select status, count(*)::int as n from bl.notifications where user_id = $1 and created_at >= $2 group by status", [flooded.user.id, since]);
    return rows.every((r) => !['queued', 'sending'].includes(r.status)) ? rows : null;
  }, { timeoutMs: 5 * MIN, intervalMs: 2000, what: 'очередь уведомлений разобрана' });
  const { rows: tries } = await db.query("select attempts from bl.notifications where user_id = $1 and created_at >= $2 limit 1", [flooded.user.id, since]);
  t.diagnostic(`свет после оплаты: ${sorted.join(', ')} мс; p50 ${percentile(sorted, 50)}, p95 ${percentile(sorted, 95)}, max ${sorted.at(-1)}; уведомления: ${JSON.stringify(done)}, попытки ${JSON.stringify(tries[0]?.attempts?.map((a) => `${a.channel}:${a.status}`))}`);
  assert.ok(percentile(sorted, 95) < 1500, 'p95 «оплатить → свет» < 1,5 с при загруженной очереди уведомлений');
});
