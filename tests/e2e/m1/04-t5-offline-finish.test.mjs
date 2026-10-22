// T5. Связь с контроллером пропала посреди игры → контроллер доигрывает время и гаснет сам;
// после возвращения связи — событие offline_session_finished в журнале.
//
// Гость платит 2 минуты; через ~20 с у симулятора обрыв связи без DISCONNECT (net up:false,
// брокер публикует Last Will). Опрос симулятора: свет горит до paid_until, льгота 2 мин,
// затем free — всё без связи. Сервер за это время видит офлайн (тревога device_offline после
// 120 с офлайна во время сессии). Связь возвращается → offline_session_finished доходит до
// сервера: bl.device_events и журнал device.event; сессия закрыта (оплаченное отыграно, не
// interrupted). Около 5 минут.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { adminClient, api, brief, CLUB_A, logLines, SERVER_CONTAINER, sim, simPost, sleep, startGame, waitFor, waitSim, waitTableFree, staff } from './helpers.mjs';

const TABLE = Number(process.env.E2E_T5_TABLE || 5);
let db;
let netDown = false;

before(async () => {
  db = await adminClient();
  await waitTableFree(TABLE);
});

after(async () => {
  if (netDown) await simPost(TABLE, 'net', { up: true });
  await db?.end();
});

test(`T5: стол ${TABLE} — обрыв связи посреди игры, контроллер доигрывает сам, offline_session_finished после связи`, { timeout: 8 * 60_000 }, async (t) => {
  const since = new Date(Date.now() - 1000);
  const game = await startGame(TABLE, 2);
  await waitSim(TABLE, (x) => x.state.relay === true && x.state.session_id === game.sessionId, { timeoutMs: 5000, intervalMs: 50 });
  const s0 = await (await api('GET', `/api/sessions/${game.sessionId}`, { token: game.guest.token })).json;
  const paidUntil = new Date(s0.paid_until).getTime();
  await sleep(20_000);

  const r = await simPost(TABLE, 'net', { up: false });
  netDown = true;
  const tDown = Date.now();
  t.diagnostic(`обрыв связи через ${((tDown - new Date(s0.started_at)) / 1000).toFixed(0)} с игры: ${brief(r.json.table)}`);
  assert.equal(r.json.table.net_up, false);

  // Без связи: свет до конца оплаты, льгота, затем гаснет сам.
  let lastOn = null;
  let offAt;
  let sawGrace = null;
  let serverOffline = null;
  for (;;) {
    const x = await sim(TABLE);
    const now = Date.now();
    assert.equal(x.net_up, false);
    if (x.state.relay) lastOn = now;
    if (x.state.mode === 'grace' && !sawGrace) sawGrace = now;
    if (!serverOffline) {
      const off = logLines(SERVER_CONTAINER, since, 'device_offline').find((l) => l.device_id === x.device_id);
      if (off) serverOffline = off;
    }
    if (x.state.mode === 'free' && !x.state.relay) {
      offAt = now;
      t.diagnostic(`без связи: ${brief(x)}; outbox=${JSON.stringify(x.outbox.map((e) => e.type))}`);
      assert.ok(x.outbox.some((e) => e.type === 'offline_session_finished'), 'событие ждёт отправки');
      break;
    }
    if (now > paidUntil + 180_000) assert.fail('свет не погас без связи');
    await sleep(250);
  }
  const rel = (v) => `${((v - paidUntil) / 1000).toFixed(1)} с`;
  t.diagnostic(`относительно paid_until: grace ${rel(sawGrace)}, последний раз свет горел ${rel(lastOn)}, погас ${rel(offAt)}`);
  t.diagnostic(`сервер увидел офлайн: ${serverOffline ? `${serverOffline.t} (${((new Date(serverOffline.t) - tDown) / 1000).toFixed(0)} с после обрыва)` : 'нет'}`);
  assert.ok(Math.abs(sawGrace - paidUntil) < 3000, 'льгота с конца оплаты');
  assert.ok(Math.abs(offAt - (paidUntil + 120_000)) < 3000, 'погас в конце льготы');

  const { rows: al } = await db.query("select type, level, raised_at from bl.alarms where club_id = $1 and type = 'device_offline' and resource_id = $2 and last_raised_at >= $3", [CLUB_A, game.tbl.resource.id, since]);
  t.diagnostic(`тревога офлайна: ${JSON.stringify(al)}`);

  // Связь вернулась.
  const tUp = new Date();
  await simPost(TABLE, 'net', { up: true });
  netDown = false;
  const ev = await waitFor(
    async () => {
      const { rows } = await db.query("select type, data, received_at from bl.device_events where club_id = $1 and type = 'offline_session_finished' and data->>'session_id' = $2", [CLUB_A, game.sessionId]);
      return rows[0];
    },
    { timeoutMs: 20_000, what: 'offline_session_finished у сервера' },
  );
  const { rows: au } = await db.query("select action, data from bl.audit_log where club_id = $1 and action = 'device.event' and data->>'type' = 'offline_session_finished' and created_at >= $2", [CLUB_A, tUp]);
  t.diagnostic(`после связи: device_events ${JSON.stringify(ev)}; журнал device.event: ${au.length}`);
  assert.ok(au.length >= 1, 'offline_session_finished в журнале');

  const s = await waitFor(
    async () => {
      const x = await api('GET', `/api/sessions/${game.sessionId}`, { token: game.guest.token });
      return ['closed', 'interrupted'].includes(x.json?.status) ? x.json : null;
    },
    { timeoutMs: 15_000, what: 'сессия закрыта' },
  );
  t.diagnostic(`сессия: status=${s.status} close_reason=${s.close_reason} remaining_ms=${s.remaining_ms}`);
  assert.equal(s.status, 'closed', 'оплаченное отыграно — не interrupted');
  const fin = await waitSim(TABLE, (x) => x.online && x.state.mode === 'free', { timeoutMs: 15_000 });
  t.diagnostic(`стол после связи: ${brief(fin)}`);
  const owner = await staff('owner');
  const alarms = await api('GET', `/api/clubs/${CLUB_A}/alarms?state=open`, { token: owner.token });
  const mine = (alarms.json ?? []).filter((a) => a.resource_id === game.tbl.resource.id || a.resource?.id === game.tbl.resource.id);
  t.diagnostic(`открытые тревоги по столу: ${JSON.stringify(mine.map((a) => ({ type: a.type, level: a.level, count: a.count })))}`);
});
