// T3 + T4 на одной сессии и критерий «игра запускается, продлевается и завершается без единого
// действия в программе клуба». Только API гостя (токен гостя), маршрутов персонала нет.
//
// 1. Гость платит 6 минут (СБП) — свет.
// 2. T3: за 3 минуты до конца (контроллер в ending, yellow_blink) гость продлевает на 3 минуты:
//    новый остаток 6 мин в API и в контроллере, контроллер снова active, индикатор off,
//    сигналы конца игры сдвинулись (T−5 звучит второй раз — уже от нового конца).
// 3. T4: гость молчит. По контроллеру (опрос симулятора раз в 200 мс) и логу sim_signal:
//    T−5 ending + yellow_blink, T−1 двойное мигание (blink2), T−0 grace + red (льгота 2 мин),
//    T+2 мин свет гаснет (free, green_dim). Сервер: ending → grace → closed (expired).
//    Моменты сравниваются с paid_until сервера, допуск ±3 с.
// 4. Уведомления гостю (bl.notifications): t1, t0, closed. Журнал сессии: start, extend, close —
//    без действий сотрудников.
//
// Длится около 11 минут.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  brief,
  extendGame,
  logLines,
  session,
  sim,
  SIM_CONTAINER,
  sleep,
  startGame,
  waitFor,
  waitSim,
  waitTableFree,
} from './helpers.mjs';

const TABLE = Number(process.env.E2E_T4_TABLE || 6);
const TOL = 3000;
let db;
let game;
let since;
let paidUntil;
const timeline = {};

before(async () => {
  db = await adminClient();
  await waitTableFree(TABLE);
});

after(async () => {
  await db?.end();
});

test(`T1→T3: гость платит 6 мин (стол ${TABLE}), за 3 мин до конца продлевает на 3 мин`, { timeout: 6 * 60_000 }, async (t) => {
  since = new Date(Date.now() - 1000);
  game = await startGame(TABLE, 6);
  await waitSim(TABLE, (x) => x.state.relay === true && x.state.session_id === game.sessionId, { timeoutMs: 5000, intervalMs: 50 });
  t.diagnostic(`старт: сессия ${game.sessionId}, ${game.q.amount_kopecks} коп.`);

  // Ждём «за 3 минуты до конца»: остаток контроллера ≤ 180 с.
  const before3 = await waitSim(TABLE, (x) => x.state.remaining_ms !== null && x.state.remaining_ms <= 180_000, { timeoutMs: 4 * 60_000, intervalMs: 500, what: 'остаток ≤ 3 мин' });
  const s0 = await session(game.guest.token, game.sessionId);
  t.diagnostic(`за 3 мин до конца: контроллер ${brief(before3)} signals=${JSON.stringify(before3.signals)}; сервер status=${s0.status} remaining=${s0.remaining_ms} paid_until=${s0.paid_until}`);
  assert.equal(before3.state.mode, 'ending');
  assert.equal(before3.state.led, 'yellow_blink');
  assert.equal(s0.status, 'ending');
  const warnBefore = before3.signals.warn;

  const ext = await extendGame(game.guest, game.tbl.resource.id, game.sessionId, 3);
  t.diagnostic(`продление: котировка ${ext.q.minutes} мин, ${ext.q.amount_kopecks} коп., от ${ext.q.breakdown[0]?.from}`);
  const after3 = await waitSim(TABLE, (x) => x.state.remaining_ms > 300_000, { timeoutMs: 5000, intervalMs: 50, what: 'остаток контроллера вырос' });
  const s1 = await waitFor(
    async () => {
      const s = await session(game.guest.token, game.sessionId);
      return new Date(s.paid_until).getTime() === new Date(s0.paid_until).getTime() + 3 * 60_000 ? s : null;
    },
    { timeoutMs: 5000, what: 'paid_until + 3 мин' },
  );
  paidUntil = new Date(s1.paid_until).getTime();
  t.diagnostic(`после продления: контроллер ${brief(after3)}; сервер status=${s1.status} remaining=${s1.remaining_ms} paid_until=${s1.paid_until}`);
  assert.equal(after3.state.mode, 'active', 'сигналы сдвинулись: снова active');
  assert.equal(after3.state.led, 'off', 'индикатор погас');
  assert.ok(Math.abs(after3.state.remaining_ms - s1.remaining_ms) < TOL, 'остаток контроллера ≈ остатку сервера');
  assert.ok(Math.abs(s1.remaining_ms - 360_000) < 5000, 'новый остаток ≈ 6 мин');
  assert.equal(s1.status, 'active');
  timeline.warnBefore = warnBefore;
});

test('T4: гость молчит — T−5, T−1, льгота 2 мин, свет гаснет, сессия закрыта', { timeout: 10 * 60_000 }, async (t) => {
  assert.ok(paidUntil, 'T3 не прошёл');
  const seen = {};
  const serverSeen = {};
  let lastServer = 0;
  const deadline = paidUntil + 120_000 + 30_000;
  for (;;) {
    const now = Date.now();
    const x = await sim(TABLE);
    const s = x.state;
    const mark = (k, cond) => {
      if (cond && seen[k] === undefined) seen[k] = { at: now, state: brief(x), signals: { ...x.signals } };
    };
    mark('ending', s.mode === 'ending' && s.led === 'yellow_blink');
    mark('grace', s.mode === 'grace' && s.led === 'red' && s.relay === true);
    mark('free', s.mode === 'free' && s.relay === false);
    if (now - lastServer > 1000) {
      lastServer = now;
      const ss = await api('GET', `/api/sessions/${game.sessionId}`, { token: game.guest.token });
      if (ss.status === 200 && serverSeen[ss.json.status] === undefined) serverSeen[ss.json.status] = { at: now, grace_until: ss.json.grace_until, close_reason: ss.json.close_reason };
    }
    if (seen.free && serverSeen.closed) break;
    if (now > deadline) break;
    await sleep(200);
  }
  const rel = (v) => (v === undefined ? 'нет' : `${((v.at - paidUntil) / 1000).toFixed(1)} с`);
  t.diagnostic(`контроллер относительно paid_until: ending/yellow_blink ${rel(seen.ending)}, grace/red ${rel(seen.grace)}, free ${rel(seen.free)}`);
  t.diagnostic(`сервер: ${Object.entries(serverSeen).map(([k, v]) => `${k} ${((v.at - paidUntil) / 1000).toFixed(1)} с`).join(', ')}; grace_until=${serverSeen.grace?.grace_until}; close_reason=${serverSeen.closed?.close_reason}`);

  const sig = logLines(SIM_CONTAINER, since, 'sim_signal').filter((l) => l.table === TABLE);
  const sigRel = sig.map((l) => `${l.signal}${l.beeps ? `(${l.beeps})` : ''}@${((new Date(l.t) - paidUntil) / 1000).toFixed(1)}с`);
  t.diagnostic(`sim_signal (от paid_until): ${sigRel.join(', ')}`);

  assert.ok(seen.ending, 'T−5: ending + yellow_blink');
  assert.ok(Math.abs(seen.ending.at - (paidUntil - 300_000)) < TOL, 'T−5 вовремя');
  const warns = sig.filter((l) => l.signal === 'warn' && new Date(l.t) > paidUntil - 360_000);
  assert.ok(warns.length >= 1 && Math.abs(new Date(warns[0].t) - (paidUntil - 300_000)) < TOL, 'T−5 сигнал (второй раз — от нового конца)');
  const blink = sig.filter((l) => l.signal === 'blink2' && new Date(l.t) > paidUntil - 120_000);
  assert.ok(blink.length >= 1 && Math.abs(new Date(blink[0].t) - (paidUntil - 60_000)) < TOL, 'T−1 двойное мигание');
  assert.ok(seen.grace && Math.abs(seen.grace.at - paidUntil) < TOL, 'T−0: льгота, red');
  assert.ok(seen.free && Math.abs(seen.free.at - (paidUntil + 120_000)) < TOL, 'свет гаснет через 2 мин льготы');
  assert.ok(serverSeen.grace, 'сервер видел grace');
  assert.ok(serverSeen.closed, 'сессия закрыта');
  assert.equal(serverSeen.closed.close_reason, 'expired');
  assert.ok(Math.abs(serverSeen.closed.at - (paidUntil + 120_000)) < TOL + 1000, 'закрыта в конце льготы');
  const fin = await sim(TABLE);
  assert.equal(fin.state.led, 'green_dim');
});

test('T4: уведомления гостю и журнал — без действий сотрудников («без единого действия в программе клуба»)', async (t) => {
  assert.ok(game);
  const { rows: notes } = await db.query('select kind, status, text, created_at from bl.notifications where user_id = $1 and created_at >= $2 order by created_at', [game.guest.user.id, since]);
  t.diagnostic(`уведомления гостю: ${notes.map((n) => `${n.kind}[${n.status}] «${n.text}» ${((new Date(n.created_at) - paidUntil) / 1000).toFixed(1)}с`).join('; ')}`);
  const kinds = notes.map((n) => n.kind);
  for (const k of ['session.t1', 'session.t0', 'session.closed']) assert.ok(kinds.includes(k), `уведомление ${k}`);

  const { rows: au } = await db.query(
    `select action, actor_type, actor_id, data->>'type' as type from bl.audit_log
      where club_id = $1 and created_at >= $2 and (data->>'session_id' = $3 or data->>'payment_id' = any($4::text[]))
      order by seq`,
    [game.tbl.club.id, since, game.sessionId, [game.payResp.payment_id]],
  );
  t.diagnostic(`журнал сессии: ${au.map((r) => `${r.action}${r.type ? `(${r.type})` : ''}/${r.actor_type}`).join(', ')}`);
  const acts = au.map((r) => r.action);
  for (const a of ['session.start', 'session.extend', 'session.close']) assert.ok(acts.includes(a), `в журнале ${a}`);
  const staffIds = (await db.query("select user_id from bl.club_members where club_id = $1", [game.tbl.club.id]).catch(() => ({ rows: [] }))).rows.map((r) => r.user_id);
  const byStaff = au.filter((r) => r.actor_id && staffIds.includes(r.actor_id));
  t.diagnostic(`записей от сотрудников клуба: ${byStaff.length} (сотрудников в клубе: ${staffIds.length})`);
  assert.equal(byStaff.length, 0, 'ни одного действия сотрудника');
  assert.ok(au.every((r) => r.actor_id === null || r.actor_id === game.guest.user.id || r.actor_type !== 'user'), 'действуют только гость и система');
});
