// T6. Связь пропала, гость оплатил продление.
//   A. Связь вернулась до конца льготы → свет продлён (session.resume с остатком по paid_until).
//   B. Не вернулась → свет погас по локальному таймеру; после связи сессия interrupted, гость
//      видит выбор; «Продолжить игру» → свет на неотыгранное время.
//   C. То же, «Вернуть деньги за неотыгранное время» → возврат в ЮKassa (эмулятор) с чеком.
// Три прогона идут одновременно на разных столах (E2E_T6_TABLES, по умолчанию 1,2,4).
// Каждый: игра 2 мин, обрыв через 5 с, ждём, пока сервер увидит офлайн (Last Will ~45 с),
// продление по СБП без связи — команда ждёт в очереди (bl.device_commands), paid_until вырос.
// Около 6 минут.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  adminClient,
  api,
  brief,
  CLUB_A,
  emuPayment,
  extendGame,
  logLines,
  ok,
  SERVER_CONTAINER,
  session,
  sim,
  SIM_CONTAINER,
  simPost,
  sleep,
  startGame,
  waitFor,
  waitSim,
  waitTableFree,
} from './helpers.mjs';

const [TA, TB, TC] = (process.env.E2E_T6_TABLES || '1,2,4').split(',').map(Number);
let db;
const down = new Set();

before(async () => {
  db = await adminClient();
});

after(async () => {
  for (const n of down) await simPost(n, 'net', { up: true });
  await db?.end();
});

/** Общая часть: игра 2 мин, обрыв, сервер видит офлайн, продление без связи. */
async function offlineExtend(t, n, extendMin) {
  await waitTableFree(n);
  const since = new Date(Date.now() - 1000);
  const game = await startGame(n, 2);
  const on = await waitSim(n, (x) => x.state.relay === true && x.state.session_id === game.sessionId, { timeoutMs: 5000, intervalMs: 50 });
  const s0 = await session(game.guest.token, game.sessionId);
  await sleep(5000);
  await simPost(n, 'net', { up: false });
  down.add(n);
  const tDown = Date.now();
  const off = await waitFor(() => logLines(SERVER_CONTAINER, since, 'device_offline').find((l) => l.device_id === on.device_id), {
    timeoutMs: 90_000,
    intervalMs: 1000,
    what: 'сервер видит офлайн',
  });
  t.diagnostic(`стол ${n}: обрыв; сервер увидел офлайн через ${((new Date(off.t) - tDown) / 1000).toFixed(0)} с`);
  const localBefore = (await sim(n)).state.remaining_ms;
  const ext = await extendGame(game.guest, game.tbl.resource.id, game.sessionId, extendMin);
  const s1 = await waitFor(
    async () => {
      const s = await session(game.guest.token, game.sessionId);
      return new Date(s.paid_until) - new Date(s0.paid_until) === extendMin * 60_000 ? s : null;
    },
    { timeoutMs: 10_000, what: 'paid_until вырос' },
  );
  await sleep(1000);
  const { rows: cmds } = await db.query('select type, status, seq from bl.device_commands where session_id = $1 order by created_at', [game.sessionId]);
  const local = await sim(n);
  t.diagnostic(`стол ${n}: продление +${extendMin} мин оплачено без связи; paid_until ${s0.paid_until} → ${s1.paid_until}; команды: ${JSON.stringify(cmds)}; контроллер: ${brief(local)} (было ${localBefore})`);
  assert.equal(local.net_up, false);
  assert.ok(local.state.remaining_ms <= localBefore, 'контроллер сам не продлил (правило 2)');
  const extCmd = cmds.filter((c) => c.type === 'session.extend');
  assert.ok(extCmd.length >= 1 && extCmd.every((c) => c.status === 'queued'), 'session.extend ждёт в очереди');
  return { game, since, s0, s1, ext, deviceId: on.device_id, localEnd: new Date(s0.paid_until).getTime() };
}

/** Ждать, пока контроллер без связи доиграет и погасит свет; затем вернуть связь. */
async function playOutAndReconnect(t, n, ctx) {
  const x = await waitSim(n, (y) => y.state.mode === 'free' && y.state.relay === false, { timeoutMs: 5 * 60_000, intervalMs: 500, what: 'свет погас без связи' });
  const offRel = (Date.now() - ctx.localEnd) / 1000;
  t.diagnostic(`стол ${n}: без связи свет погас через ${offRel.toFixed(1)} с после локального конца (льгота 120 с); outbox=${JSON.stringify(x.outbox.map((e) => e.type))}`);
  assert.ok(Math.abs(offRel - 120) < 3, 'погас по локальному таймеру (конец + льгота), а не по оплате');
  assert.ok(x.outbox.some((e) => e.type === 'offline_session_finished'));
  await simPost(n, 'net', { up: true });
  down.delete(n);
  const s = await waitFor(
    async () => {
      const r = await api('GET', `/api/sessions/${ctx.game.sessionId}`, { token: ctx.game.guest.token });
      return r.json?.status === 'interrupted' ? r.json : null;
    },
    { timeoutMs: 20_000, what: 'сессия interrupted' },
  );
  const cur = await ok(api('GET', '/api/sessions/current', { token: ctx.game.guest.token }));
  const { rows: notes } = await db.query("select kind, status, text from bl.notifications where user_id = $1 and kind like 'session.interrupt%'", [ctx.game.guest.user.id]);
  const lit = await sim(n);
  t.diagnostic(`стол ${n}: после связи сессия ${s.status}, неотыгранное ${s.remaining_ms} мс, is_payer=${s.is_payer}; в /sessions/current: ${cur.some((c) => c.id === s.id && c.status === 'interrupted')}; уведомление: ${JSON.stringify(notes)}; контроллер: ${brief(lit)}`);
  assert.ok(Math.abs(s.remaining_ms - (new Date(ctx.s1.paid_until) - ctx.localEnd)) < 5000, 'неотыгранное = оплачено − доиграно');
  assert.ok(cur.some((c) => c.id === s.id && c.status === 'interrupted'), 'гость видит выбор');
  assert.equal(lit.state.relay, false, 'свет сам не возвращается');
  return s;
}

describe('T6: связь пропала, гость оплатил продление', { concurrency: true, timeout: 12 * 60_000 }, () => {
  it(`A (стол ${TA}): связь вернулась до конца льготы — свет продлён`, async (t) => {
    // +3 мин: новый paid_until на минуту позже старого конца льготы — видно, что свет продлён.
    const ctx = await offlineExtend(t, TA, 3);
    // Ждём локальный конец (контроллер в льготе), затем ещё 20 с — и возвращаем связь.
    const g = await waitSim(TA, (x) => x.state.mode === 'grace', { timeoutMs: 3 * 60_000, intervalMs: 500, what: 'льгота по локальному таймеру' });
    t.diagnostic(`стол ${TA}: без связи — льгота: ${brief(g)}`);
    await sleep(20_000);
    const tUp = new Date();
    await simPost(TA, 'net', { up: true });
    down.delete(TA);
    const x = await waitSim(TA, (y) => y.online && y.state.mode !== 'grace' && y.state.relay === true && y.state.remaining_ms > 0, { timeoutMs: 20_000, intervalMs: 100, what: 'свет продлён' });
    const resume = logLines(SIM_CONTAINER, tUp, 'sim_cmd').filter((l) => l.table === TA).map((l) => `${l.type}:${l.result}`);
    const expected = new Date(ctx.s1.paid_until) - Date.now();
    t.diagnostic(`стол ${TA}: связь вернулась через ${((tUp - ctx.localEnd) / 1000).toFixed(0)} с после локального конца → ${brief(x)}; ожидаемый остаток ${expected}; команды после связи: ${resume.join(', ')}`);
    assert.ok(Math.abs(x.state.remaining_ms - expected) < 3000, 'остаток по paid_until');
    const { rows: cmds } = await db.query('select type, status from bl.device_commands where session_id = $1 order by created_at', [ctx.game.sessionId]);
    t.diagnostic(`стол ${TA}: команды сессии: ${JSON.stringify(cmds)}`);
    // Старый локальный конец (+ льгота) прошёл — свет горит.
    const wait = ctx.localEnd + 120_000 + 3000 - Date.now();
    if (wait > 0) await sleep(wait);
    const later = await sim(TA);
    t.diagnostic(`стол ${TA}: после старого конца льготы: ${brief(later)}`);
    assert.equal(later.state.relay, true, 'свет не погас по старому таймеру');
    assert.ok(['active', 'ending'].includes(later.state.mode), 'контроллер играет по новому остатку');
    const s = await session(ctx.game.guest.token, ctx.game.sessionId);
    t.diagnostic(`стол ${TA}: сервер status=${s.status} remaining=${s.remaining_ms}`);
    assert.ok(['active', 'ending'].includes(s.status));
    assert.ok(Math.abs(later.state.remaining_ms - s.remaining_ms) < 3000);
    await ok(api('POST', `/api/sessions/${ctx.game.sessionId}/stop`, { token: ctx.game.guest.token, body: {} }));
    await waitSim(TA, (y) => y.state.mode === 'free', { timeoutMs: 5000 });
  });

  it(`B (стол ${TB}): связь не вернулась — свет погас, interrupted, «Продолжить игру»`, async (t) => {
    const ctx = await offlineExtend(t, TB, 3);
    const s = await playOutAndReconnect(t, TB, ctx);
    const r = await api('POST', `/api/sessions/${ctx.game.sessionId}/resolve`, { token: ctx.game.guest.token, body: { choice: 'continue' } });
    t.diagnostic(`стол ${TB}: «Продолжить» → HTTP ${r.status} status=${r.json?.status} remaining=${r.json?.remaining_ms}`);
    assert.equal(r.status, 200);
    const x = await waitSim(TB, (y) => y.state.relay === true && y.state.session_id === ctx.game.sessionId, { timeoutMs: 5000, intervalMs: 50, what: 'свет после «Продолжить»' });
    t.diagnostic(`стол ${TB}: ${brief(x)}; неотыгранное было ${s.remaining_ms}`);
    assert.ok(Math.abs(x.state.remaining_ms - s.remaining_ms) < 5000, 'остаток = неотыгранное');
    const { rows: au } = await db.query("select action, data from bl.audit_log where club_id = $1 and action = 'session.resolve' and data->>'session_id' = $2", [CLUB_A, ctx.game.sessionId]);
    t.diagnostic(`журнал session.resolve: ${JSON.stringify(au.map((a) => a.data))}`);
    assert.equal(au.length, 1);
    await ok(api('POST', `/api/sessions/${ctx.game.sessionId}/stop`, { token: ctx.game.guest.token, body: {} }));
    await waitSim(TB, (y) => y.state.mode === 'free', { timeoutMs: 5000 });
  });

  it(`C (стол ${TC}): связь не вернулась — interrupted, «Вернуть деньги за неотыгранное время»`, async (t) => {
    const ctx = await offlineExtend(t, TC, 3);
    const s = await playOutAndReconnect(t, TC, ctx);
    const r = await api('POST', `/api/sessions/${ctx.game.sessionId}/resolve`, { token: ctx.game.guest.token, body: { choice: 'refund' } });
    t.diagnostic(`стол ${TC}: «Вернуть деньги» → HTTP ${r.status} status=${r.json?.status} close_reason=${r.json?.close_reason}`);
    assert.equal(r.status, 200);
    const refunds = await waitFor(
      async () => {
        const { rows } = await db.query(
          'select r.amount_kopecks, r.status, r.provider_refund_id, p.provider_payment_id from bl.refunds r join bl.payments p on p.id = r.payment_id where p.session_id = $1',
          [ctx.game.sessionId],
        );
        return rows.length && rows.every((x) => x.status === 'succeeded') ? rows : null;
      },
      { timeoutMs: 15_000, what: 'возврат succeeded' },
    );
    const total = refunds.reduce((a, x) => a + Number(x.amount_kopecks), 0);
    t.diagnostic(`стол ${TC}: bl.refunds ${JSON.stringify(refunds.map((x) => ({ amount_kopecks: x.amount_kopecks, status: x.status })))}; неотыгранное ${s.remaining_ms} мс; продление стоило ${ctx.ext.q.amount_kopecks} коп.`);
    assert.ok(Math.abs(total - ctx.ext.q.amount_kopecks) <= 100, 'вернули стоимость неотыгранных 3 минут (±1 ₽)');
    for (const x of refunds) {
      const p = emuPayment(x.provider_payment_id);
      const refundReceipts = (p.receipts ?? []).filter((rc) => rc.kind === 'refund');
      t.diagnostic(`эмулятор: платёж refunded_amount=${p.refunded_amount?.value} status=${p.status}; чеков возврата: ${refundReceipts.length} на ${refundReceipts.map((rc) => rc.amount_kopecks).join(',')} коп.`);
      assert.ok(Number(p.refunded_amount?.value ?? 0) * 100 >= Number(x.amount_kopecks) - 1, 'возврат в ЮKassa');
      assert.ok(refundReceipts.length >= 1, 'чек возврата');
    }
    const fin = await session(ctx.game.guest.token, ctx.game.sessionId);
    const { rows: au } = await db.query("select action from bl.audit_log where club_id = $1 and created_at >= $2 and (data->>'session_id' = $3 or action = 'payment.refunded' and data->>'payment_id' = any($4::text[])) order by seq", [CLUB_A, ctx.since, ctx.game.sessionId, [ctx.ext.payResp.payment_id, ctx.game.payResp.payment_id]]);
    t.diagnostic(`стол ${TC}: сессия ${fin.status} (${fin.close_reason}); журнал: ${au.map((a) => a.action).join(', ')}`);
    assert.ok(au.some((a) => a.action === 'payment.refunded'), 'payment.refunded в журнале');
    assert.equal((await sim(TC)).state.relay, false);
  });
});
