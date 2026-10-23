// T24: отмена турнира клубом с возвратом взносов и чеками возврата; продление игры гостя на столе
// турнира, когда окно турнира началось (№146): оплаченная игра доигрывается, продление — отказ или
// возврат; после отмены стол снова принимает продление. Стол E2E_CANCEL_TABLE (по умолчанию 3). ~3 минуты.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  auditAny,
  brief2,
  CLUB_A,
  emuSucceed,
  ensureFree,
  enterAndPay,
  MIN,
  newGuest,
  notificationsFor,
  ok,
  pay,
  plusProfile,
  providerId,
  quote,
  receiptsOf,
  refundsOf,
  RES,
  session,
  sim,
  sleep,
  staff,
  startGame,
  waitFor,
  waitSim,
} from './helpers.mjs';

const TABLE = Number(process.env.E2E_CANCEL_TABLE || 3);
const LEAD_MS = Number(process.env.E2E_CANCEL_LEAD_MS || 75_000);
let db;
let man;
let rec;
const P = {};
const ctx = {};

before(async () => {
  db = await adminClient();
  man = await staff('manager');
  rec = await staff('reception');
  await ensureFree(TABLE);
});

after(async () => {
  if (ctx.id && !ctx.canceled) await api('POST', `/api/clubs/${CLUB_A}/tournaments/${ctx.id}/cancel`, { token: man.token, body: { reason: 'e2e: уборка' } });
  if (ctx.game?.sessionId && !ctx.stopped) await api('POST', `/api/sessions/${ctx.game.sessionId}/stop`, { token: ctx.game.guest.token, body: {} });
  await db?.end();
});

async function extendTry(label) {
  const q = await quote(ctx.game.guest.token, { resourceId: RES(TABLE), kind: 'extend', minutes: 30, sessionId: ctx.game.sessionId });
  const out = { label, quote: q.status, quoteJson: q.json };
  if (q.status !== 200) return out;
  const before = (await session(ctx.game.guest.token, ctx.game.sessionId)).paid_until;
  const p = await ok(pay(ctx.game.guest.token, q.json.quote_id, 'sbp'));
  emuSucceed(providerId(p));
  await waitFor(
    async () => {
      const { rows } = await db.query("select outcome from bl.session_payments where payment_id = $1", [p.payment_id]);
      return rows[0] ?? null;
    },
    { timeoutMs: 20_000, intervalMs: 300, what: `${label}: оплата продления обработана` },
  );
  const { rows } = await db.query("select outcome from bl.session_payments where payment_id = $1", [p.payment_id]);
  const { rows: rj } = await db.query("select data from bl.audit_log where action = 'session.start_rejected' and data->>'payment_id' = $1", [p.payment_id]);
  const after2 = (await session(ctx.game.guest.token, ctx.game.sessionId)).paid_until;
  const refunds = await refundsOf(db, p.payment_id);
  return { ...out, payment_id: p.payment_id, outcome: rows[0]?.outcome, reject: rj[0]?.data?.reason ?? null, paid_until_before: before, paid_until_after: after2, refunds: refunds.map((x) => `${x.amount_kopecks}:${x.status}`) };
}

test('подготовка: гость играет на столе, клуб публикует турнир на этом столе через минуту; запись двух игроков', async (t) => {
  ctx.game = await startGame(TABLE, 30);
  await waitSim(TABLE, (x) => x.state?.relay === true, { what: 'свет гостя' });
  const startsAt = new Date(Math.ceil((Date.now() + LEAD_MS) / 1000) * 1000);
  const r = await api('POST', `/api/clubs/${CLUB_A}/tournaments`, {
    token: man.token,
    body: {
      title: `E2E Отмена ${String(Date.now()).slice(-5)}`,
      discipline: 'pyramid',
      format: 'single_elim',
      race_to: 1,
      fee_kopecks: 20_000,
      places: 4,
      starts_at: startsAt.toISOString(),
      ends_at: new Date(startsAt.getTime() + 60 * MIN).toISOString(),
      resource_ids: [RES(TABLE)],
      publish: true,
    },
  });
  assert.equal(r.status, 201, brief2(r));
  ctx.id = r.json.id;
  ctx.startsAt = startsAt;
  for (const k of ['a', 'b', 'c']) {
    P[k] = await newGuest();
    await plusProfile(P[k]);
  }
  for (const k of ['a', 'b']) {
    const e = await enterAndPay(P[k], ctx.id);
    assert.equal(e.r.status, 201);
    const { rows } = await db.query('select id from bl.payments where entry_id = $1', [e.entry.entry_id]);
    P[k].paymentId = rows[0].id;
  }
  const c = await enterAndPay(P.c, ctx.id, { pay: false });
  assert.equal(c.entry.status, 'pending_payment');
  const before = await extendTry('продление до окна (окно через ~1 мин)');
  ctx.beforeWindow = before;
  t.diagnostic(`игра гостя на столе ${TABLE} (сессия ${ctx.game.sessionId.slice(0, 8)}); турнир ${ctx.id.slice(0, 8)} с ${startsAt.toISOString()}; записи: 2 оплачены, 1 ждёт оплаты; продление до окна: ${JSON.stringify(before)}`);
});

test('окно турнира началось: игра гостя доигрывается, продление — отказ table_busy {reason: tournament} или возврат', async (t) => {
  const wait = ctx.startsAt.getTime() + 3000 - Date.now();
  if (wait > 0) await sleep(wait);
  const s = await sim(TABLE);
  assert.equal(s.state.relay, true, 'оплаченная игра не обрывается окном турнира');
  const ses = await session(ctx.game.guest.token, ctx.game.sessionId);
  const ext = await extendTry('продление в окне турнира');
  ctx.inWindow = ext;
  t.diagnostic(`в окне: свет гостя relay=${s.state.relay}, сессия ${ses.status} до ${ses.paid_until}, extend_limit_until ${ses.extend_limit_until ?? null}; продление: ${JSON.stringify(ext)}`);
  assert.ok(ext.quote === 409 || ext.reject === 'tournament', 'продление в окне не проходит');
  if (ext.quote === 200) assert.equal(ext.paid_until_after, ext.paid_until_before, 'время не добавлено');
  assert.equal(ext.quote, 409, `котировка продления в окне турнира: ожидали 409 table_busy {reason: tournament}, пришло ${ext.quote}`);
  assert.equal(ext.quoteJson.reason, 'tournament');
});

test('отмена турнира клубом: причина обязательна, взносы возвращены с чеками возврата, тревога владельцу, журнал', async (t) => {
  const t1 = Date.now();
  const byRec = await api('POST', `/api/clubs/${CLUB_A}/tournaments/${ctx.id}/cancel`, { token: rec.token, body: { reason: 'x' } });
  assert.equal(byRec.status, 403);
  const noReason = await api('POST', `/api/clubs/${CLUB_A}/tournaments/${ctx.id}/cancel`, { token: man.token, body: {} });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.json.error, 'reason_required');
  const r = await api('POST', `/api/clubs/${CLUB_A}/tournaments/${ctx.id}/cancel`, { token: man.token, body: { reason: 'Мало участников, перенос на неделю' } });
  assert.equal(r.status, 200, brief2(r));
  assert.deepEqual(r.json, { refunded: 2 });
  ctx.canceled = true;
  const again = await api('POST', `/api/clubs/${CLUB_A}/tournaments/${ctx.id}/cancel`, { token: man.token, body: { reason: 'ещё раз' } });
  assert.equal(again.status, 409);
  const res = [];
  for (const k of ['a', 'b']) {
    const refunds = await waitFor(
      async () => {
        const x = await refundsOf(db, P[k].paymentId);
        return x.length && x.every((y) => y.status === 'succeeded') ? x : null;
      },
      { timeoutMs: 40_000, intervalMs: 500, what: `возврат взноса ${k}` },
    );
    const rc = await waitFor(
      async () => {
        const x = (await receiptsOf(db, P[k].paymentId)).filter((y) => y.kind === 'refund');
        return x.length && x.every((y) => y.status === 'succeeded') ? x : null;
      },
      { timeoutMs: 40_000, intervalMs: 500, what: `чек возврата ${k}` },
    );
    assert.equal(refunds.reduce((s, x) => s + Number(x.amount_kopecks), 0), 20_000);
    const me = await ok(api('GET', `/api/tournaments/${ctx.id}/me`, { token: P[k].token }));
    const n = (await notificationsFor(db, P[k].user.id, { kinds: ['tournament.canceled'], since: t1 }))[0];
    res.push(`${k}: возврат ${refunds.map((x) => x.amount_kopecks).join('+')} ${refunds[0].status}, чек ${rc[0].kind}/${rc[0].channel}/${rc[0].status}, запись ${me.entry?.status}/${me.entry?.refund_status}, «${n?.text}»`);
  }
  const { rows: pend } = await db.query("select status, cancel_reason, refund_status from bl.tournament_entries where tournament_id = $1 and user_id = $2", [ctx.id, P.c.user.id]);
  const au = await auditAny(db, { actions: ['manual.tournament_cancel'], since: t1, like: ctx.id });
  assert.equal(au.length, 1);
  assert.equal(au[0].reason, 'Мало участников, перенос на неделю');
  const { rows: al } = await db.query("select type, level, data from bl.alarms where club_id = $1 and type = 'manual_action' and data->>'tournament_id' = $2", [CLUB_A, ctx.id]);
  assert.equal(al.length, 1);
  const ownerN = (await notificationsFor(db, 'a1000000-0000-4000-8000-000000000001', { since: t1 })).find((n) => /отменён/.test(n.text));
  const club = await ok(api('GET', `/api/clubs/${CLUB_A}/tournaments/${ctx.id}`, { token: man.token }));
  assert.equal(club.status, 'canceled');
  // Публичная афиша кэшируется на 60 с (контракт §1 п. 1) — ждём обновления.
  const pub = await waitFor(
    async () => {
      const x = await api('GET', `/api/public/tournaments/${ctx.id}`);
      return x.json?.status === 'canceled' ? x.json : null;
    },
    { timeoutMs: 75_000, intervalMs: 3000, what: 'публичный статус canceled' },
  );
  t.diagnostic(`ресепшн — 403; без причины — 400 reason_required; отмена → ${JSON.stringify(r.json)}; повтор — 409 ${again.json.error}; ${res.join('; ')}; неоплаченная: ${JSON.stringify(pend[0])}; журнал manual.tournament_cancel (причина); тревога ${al[0].type}/${al[0].level}; владельцу «${ownerN?.text}»; публично ${pub.status}`);
  assert.equal(pub.status, 'canceled');
});

test('после отмены стол снова принимает продление; гость завершает игру', async (t) => {
  const ext = await extendTry('продление после отмены турнира');
  assert.equal(ext.quote, 200, JSON.stringify(ext));
  assert.equal(ext.outcome, 'applied');
  assert.ok(new Date(ext.paid_until_after) > new Date(ext.paid_until_before));
  await ok(api('POST', `/api/sessions/${ctx.game.sessionId}/stop`, { token: ctx.game.guest.token, body: {} }));
  ctx.stopped = true;
  await waitSim(TABLE, (x) => x.state?.mode === 'free' && x.state?.relay === false, { what: 'стол свободен' });
  t.diagnostic(`продление после отмены: ${JSON.stringify(ext)}; игра завершена, стол свободен`);
});
