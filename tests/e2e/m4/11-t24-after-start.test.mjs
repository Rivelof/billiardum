// T24 после старта (№147, №149): окно и время матча обычной правкой — 409 tournament_started;
// продление POST …/extend с причиной (не дальше +12 ч), журнал manual.tournament_extend, тревога;
// возврат взноса одному игроку по объективной причине (health) с чеком возврата; напоминание
// организатору tournament.confirm_reminder через 15 минут после первого счёта без подтверждения;
// отмена после старта: по умолчанию без возврата; refund:'all' только с reason_code equipment|venue,
// возвраты с чеками, одна тревога manual_action.
//
// Столы: турнир A — 2 и 3 (пирамида), турнир B — 8 (пул). ~20 минут (ждёт напоминание).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  auditAny,
  brief2,
  CLUB_A,
  ensureFree,
  enterAndPay,
  MIN,
  newGuest,
  notificationsFor,
  ok,
  plusProfile,
  receiptsOf,
  refundsOf,
  RES,
  sim,
  staff,
  waitFor,
  waitNotification,
  waitSim,
} from './helpers.mjs';

const TABLES_A = (process.env.E2E_AFTER_TABLES || '2,3').split(',').map(Number);
const TABLE_B = Number(process.env.E2E_AFTER_TABLE_B || 8);
const MANAGER_ID = 'a1000000-0000-4000-8000-000000000003';
const OWNER_ID = 'a1000000-0000-4000-8000-000000000001';
let db;
let man;
let rec;
const made = [];

before(async () => {
  db = await adminClient();
  man = await staff('manager');
  rec = await staff('reception');
  for (const n of [...TABLES_A, TABLE_B]) await ensureFree(n);
});

after(async () => {
  for (const c of made) if (!c.closed) await api('POST', `/api/clubs/${CLUB_A}/tournaments/${c.id}/cancel`, { token: man.token, body: { reason: 'e2e: уборка' } });
  await db?.end();
});

const T = (id, tail = '') => `/api/clubs/${CLUB_A}/tournaments/${id}${tail}`;

async function setup({ title, discipline, tables, players, fee }) {
  const startsAt = new Date(Math.ceil((Date.now() + 65_000) / 1000) * 1000);
  const r = await api('POST', `/api/clubs/${CLUB_A}/tournaments`, {
    token: man.token,
    body: { title, discipline, format: 'single_elim', race_to: 2, fee_kopecks: fee, places: 8, match_minutes: 10, starts_at: startsAt.toISOString(), ends_at: new Date(startsAt.getTime() + 60 * MIN).toISOString(), resource_ids: tables.map(RES), publish: true },
  });
  assert.equal(r.status, 201, brief2(r));
  const c = { id: r.json.id, startsAt, P: [] };
  made.push(c);
  for (let i = 0; i < players; i += 1) {
    const g = await newGuest();
    await plusProfile(g);
    const e = await enterAndPay(g, c.id);
    assert.equal(e.r.status, 201);
    const { rows } = await db.query('select id from bl.payments where entry_id = $1', [e.entry.entry_id]);
    g.entryId = e.entry.entry_id;
    g.paymentId = rows[0].id;
    c.P.push(g);
  }
  return c;
}

async function refundDone(paymentId) {
  const refunds = await waitFor(
    async () => {
      const x = await refundsOf(db, paymentId);
      return x.length && x.every((y) => y.status === 'succeeded') ? x : null;
    },
    { timeoutMs: 40_000, intervalMs: 500, what: 'возврат взноса' },
  );
  const rc = await waitFor(
    async () => {
      const x = (await receiptsOf(db, paymentId)).filter((y) => y.kind === 'refund');
      return x.length && x.every((y) => y.status === 'succeeded') ? x : null;
    },
    { timeoutMs: 40_000, intervalMs: 500, what: 'чек возврата' },
  );
  return { refunds, rc };
}

/** После отмены турнира стол снова принимает игру по QR: статус и котировка гостя. */
async function freeAfterCancel(n) {
  const g = await newGuest();
  const st = await api('GET', `/api/t/TEST${String(n).padStart(6, '0')}`, { token: g.token });
  const q = await api('POST', '/api/quotes', { token: g.token, body: { resource_id: RES(n), kind: 'start', minutes: 30 } });
  if (q.status === 200) await api('POST', `/api/quotes/${q.json.quote_id}/cancel`, { token: g.token, body: {} }).catch(() => {});
  return { quote: q.status, text: `стол ${n} сразу после отмены: QR ${st.json?.status}${st.json?.busy_until ? ` до ${st.json.busy_until}` : ''}, котировка ${q.status} ${q.status === 200 ? '' : JSON.stringify(q.json)}` };
}

async function alarmsOf(tid) {
  const { rows } = await db.query("select type, level, count, dedupe_key, data from bl.alarms where club_id = $1 and (data->>'tournament_id' = $2 or dedupe_key like '%' || $2) order by raised_at", [CLUB_A, tid]);
  return rows;
}

test('B: отмена после старта с возвратом всем — только при поломке или аварии; чеки возврата; одна тревога', async (t) => {
  const c = await setup({ title: 'E2E После старта B', discipline: 'pool', tables: [TABLE_B], players: 2, fee: 15_000 });
  await ok(api('POST', T(c.id, '/start'), { token: man.token, body: {} }));
  await waitSim(TABLE_B, (x) => x.state?.relay === true, { what: 'свет матча B' });
  const t1 = Date.now();
  const noCode = await api('POST', T(c.id, '/cancel'), { token: man.token, body: { reason: 'Сломался кий-машина', refund: 'all' } });
  const health = await api('POST', T(c.id, '/cancel'), { token: man.token, body: { reason: 'Игрок заболел', refund: 'all', reason_code: 'health' } });
  assert.equal(noCode.status, 400, brief2(noCode));
  assert.equal(health.status, 400, brief2(health));
  const r = await api('POST', T(c.id, '/cancel'), { token: man.token, body: { reason: 'Порвалось сукно на столе 8', refund: 'all', reason_code: 'equipment' } });
  assert.equal(r.status, 200, brief2(r));
  assert.deepEqual(r.json, { refunded: 2 });
  c.closed = true;
  const res = [];
  for (const g of c.P) {
    const { refunds, rc } = await refundDone(g.paymentId);
    res.push(`${refunds.map((x) => x.amount_kopecks).join('+')} ${refunds[0].status}, чек ${rc[0].kind}/${rc[0].status}`);
  }
  await waitSim(TABLE_B, (x) => x.state?.relay === false, { what: 'свет матча B погас после отмены' });
  const afterCancel = await freeAfterCancel(TABLE_B);
  const au = await auditAny(db, { actions: ['manual.tournament_cancel', 'manual.tournament_refund'], since: t1, like: c.id });
  const al = (await alarmsOf(c.id)).filter((a) => a.type === 'manual_action');
  t.diagnostic(`${afterCancel.text}; без reason_code — 400, health — 400; equipment → ${JSON.stringify(r.json)}; возвраты: ${res.join('; ')}; свет погас; журнал ${au.map((x) => `${x.action}${x.data?.scope ? `/${x.data.scope}` : ''}${x.data?.refund ? `/${x.data.refund}` : ''}`).join(', ')}; тревог manual_action ${al.length} (${al.map((a) => `${a.data.action}/${a.data.refund}/${a.data.reason_code} count ${a.count}`).join(', ')})`);
  assert.equal(al.length, 1);
  assert.equal(al[0].count, 1);
  assert.equal(afterCancel.quote, 200, `после отмены турнира стол ${TABLE_B} не принимает игру: ${afterCancel.text}`);
  assert.ok(au.some((x) => x.action === 'manual.tournament_refund' && x.data.scope === 'all'));
});

test('A: после старта — 409 tournament_started; продление с причиной; возврат одному игроку; напоминание; отмена без возврата', { timeout: 30 * MIN }, async (t) => {
  const c = await setup({ title: 'E2E После старта A', discipline: 'pyramid', tables: TABLES_A, players: 4, fee: 20_000 });
  const early = await api('POST', T(c.id, `/entries/${c.P[3].entryId}/refund`), { token: man.token, body: { reason_code: 'health', comment: 'до старта' } });
  assert.equal(early.status, 409, `возврат по причине до старта: ${brief2(early)}`);
  const st = await ok(api('POST', T(c.id, '/start'), { token: man.token, body: {} }));
  const d0 = await ok(api('GET', T(c.id), { token: man.token }));
  const out = [`до старта refund — 409 ${early.json.error}`, `старт ${st.status}`];
  // Окно и время матча обычной правкой не меняются.
  for (const body of [{ ends_at: new Date(Date.now() + 5 * 3600_000).toISOString() }, { starts_at: new Date(Date.now() + 2 * MIN).toISOString() }, { match_minutes: 60 }, { registration_closes_at: new Date(Date.now() + MIN).toISOString() }]) {
    const p = await api('PATCH', T(c.id), { token: man.token, body });
    assert.equal(p.status, 409, `${Object.keys(body)[0]}: ${brief2(p)}`);
    assert.equal(p.json.error, 'tournament_started');
  }
  out.push('PATCH ends_at/starts_at/match_minutes/registration_closes_at — 409 tournament_started');
  // Продление.
  const t1 = Date.now();
  const byRec = await api('POST', T(c.id, '/extend'), { token: rec.token, body: { ends_at: new Date(Date.now() + 2 * 3600_000).toISOString(), reason: 'x' } });
  const noReason = await api('POST', T(c.id, '/extend'), { token: man.token, body: { ends_at: new Date(Date.now() + 2 * 3600_000).toISOString() } });
  const tooFar = await api('POST', T(c.id, '/extend'), { token: man.token, body: { ends_at: new Date(Date.now() + 13 * 3600_000).toISOString(), reason: 'Финал перенесли' } });
  const tooLong = await api('POST', T(c.id, '/extend'), { token: man.token, body: { match_minutes: 300, reason: 'Длинные партии' } });
  assert.equal(byRec.status, 403);
  assert.equal(noReason.status, 400);
  assert.equal(noReason.json.error, 'reason_required');
  assert.equal(tooFar.status, 409);
  assert.equal(tooFar.json.error, 'limit_exceeded');
  assert.ok(tooFar.json.extend_limit_until, 'extend_limit_until в ответе');
  const newEnds = new Date(new Date(d0.ends_at).getTime() + 30 * MIN);
  const ext = await api('POST', T(c.id, '/extend'), { token: man.token, body: { ends_at: newEnds.toISOString(), match_minutes: 15, reason: 'Матчи затянулись, продлеваем на 30 минут' } });
  assert.equal(ext.status, 200, brief2(ext));
  assert.equal(new Date(ext.json.ends_at).getTime(), newEnds.getTime());
  assert.equal(ext.json.match_minutes, 15);
  const auE = await auditAny(db, { actions: ['manual.tournament_extend'], since: t1, like: c.id });
  assert.equal(auE.length, 1);
  assert.equal(auE[0].reason, 'Матчи затянулись, продлеваем на 30 минут');
  const alE = (await alarmsOf(c.id)).filter((a) => /tournament_extend/.test(a.data.action ?? ''));
  out.push(`extend: ресепшн 403, без причины 400, +13 ч — 409 limit_exceeded (extend_limit_until ${tooFar.json.extend_limit_until}), матч 300 мин — ${tooLong.status} ${tooLong.json?.error}; +30 мин и матч 15 — 200; журнал manual.tournament_extend (before ${JSON.stringify(auE[0].data.before)} → after ${JSON.stringify(auE[0].data.after)}); тревога ${alE.map((a) => `${a.type}/${a.level} «${a.data.before} → ${a.data.after}»`).join(', ') || 'НЕТ'}`);
  assert.equal(alE.length, 1, 'тревога владельцу за продление');
  // Возврат одному игроку.
  const g = c.P[3];
  const t2 = Date.now();
  const personal = await api('POST', T(c.id, `/entries/${g.entryId}/refund`), { token: man.token, body: { reason_code: 'personal', comment: 'Передумал' } });
  const noComment = await api('POST', T(c.id, `/entries/${g.entryId}/refund`), { token: man.token, body: { reason_code: 'health' } });
  const recRefund = await api('POST', T(c.id, `/entries/${g.entryId}/refund`), { token: rec.token, body: { reason_code: 'health', comment: 'x' }, headers: { 'x-club-id': CLUB_A } });
  assert.equal(personal.status, 400);
  assert.equal(noComment.status, 400);
  assert.equal(noComment.json.error, 'reason_required');
  assert.equal(recRefund.status, 403);
  const rf = await api('POST', T(c.id, `/entries/${g.entryId}/refund`), { token: man.token, body: { reason_code: 'health', comment: 'Травма руки, справка' } });
  assert.equal(rf.status, 200, brief2(rf));
  assert.equal(rf.json.amount_kopecks, 20_000);
  const { refunds, rc } = await refundDone(g.paymentId);
  const again = await api('POST', T(c.id, `/entries/${g.entryId}/refund`), { token: man.token, body: { reason_code: 'health', comment: 'ещё раз' } });
  assert.equal(again.status, 409);
  assert.equal(again.json.error, 'already_refunded');
  const auR = await auditAny(db, { actions: ['manual.tournament_refund'], since: t2, like: g.entryId });
  const alR = (await alarmsOf(c.id)).filter((a) => /tournament_refund/.test(a.data.action ?? '') || a.data.entry_id === g.entryId);
  const gN = (await notificationsFor(db, g.user.id, { since: t2 })).map((n) => n.text);
  const d1 = await ok(api('GET', T(c.id), { token: man.token }));
  const e1 = d1.entries.find((e) => e.entry_id === g.entryId);
  out.push(`возврат одному: personal — 400, без комментария — 400 reason_required, ресепшн — 403; health → ${JSON.stringify(rf.json)}; возврат ${refunds.map((x) => `${x.amount_kopecks} ${x.status}`).join(', ')}, чек ${rc[0].kind}/${rc[0].status}; повтор — 409 already_refunded; журнал ${auR.map((x) => `${x.action}/${x.data.scope}/${x.data.reason_code}`).join(', ')}; тревога ${alR.map((a) => `${a.type}/${a.level}`).join(', ') || 'НЕТ'}; игроку «${gN.join(' | ')}»; запись в сетке: ${e1.status}/${e1.refund_status}`);
  assert.equal(auR.length, 1);
  assert.ok(alR.length >= 1, 'тревога владельцу за возврат');
  // Напоминание: счёт внесён одним, второй молчит 15 минут.
  const live = (await db.query("select id, user_a, user_b, resource_id from bl.tournament_matches where tournament_id = $1 and status = 'playing' order by position", [c.id])).rows;
  const m = live[0];
  const a = c.P.find((x) => x.user.id === m.user_a);
  const tr = Date.now();
  await ok(api('POST', `/api/tournaments/matches/${m.id}/score`, { token: a.token, body: { score_a: 2, score_b: 0 } }));
  const tn = TABLES_A.find((n) => RES(n) === m.resource_id);
  await waitSim(tn, (x) => x.state?.relay === false, { timeoutMs: 7 * MIN, intervalMs: 2000, what: 'свет погас через 5 минут после счёта' });
  const offAfter = Math.round((Date.now() - tr) / 1000);
  const rem = await waitNotification(db, MANAGER_ID, 'tournament.confirm_reminder', { since: tr, timeoutMs: 17 * MIN });
  const remAfter = Math.round((new Date(rem.created_at).getTime() - tr) / 1000);
  const remOwner = (await notificationsFor(db, OWNER_ID, { kinds: ['tournament.confirm_reminder'], since: tr })).length;
  out.push(`матч на столе ${tn}: счёт одного игрока → свет погас через ${offAfter} с; напоминание управляющему через ${remAfter} с «${rem.text}», владельцу ${remOwner}`);
  assert.ok(remAfter >= 900 && remAfter < 990, `напоминание через ${remAfter} с`);
  // Отмена после старта без кода — без возврата.
  const t3 = Date.now();
  const cn = await api('POST', T(c.id, '/cancel'), { token: man.token, body: { reason: 'Игроки разошлись, доигрывать некому' } });
  assert.equal(cn.status, 200, brief2(cn));
  assert.deepEqual(cn.json, { refunded: 0 });
  c.closed = true;
  const d2 = await ok(api('GET', T(c.id), { token: man.token }));
  const statuses = d2.entries.map((e) => `${e.status}/${e.refund_status}`);
  const newRefunds = (await Promise.all(c.P.slice(0, 3).map((p) => refundsOf(db, p.paymentId)))).flat();
  const alC = (await alarmsOf(c.id)).filter((x) => /tournament_cancel/.test(x.data.action ?? ''));
  const auC = await auditAny(db, { actions: ['manual.tournament_cancel'], since: t3, like: c.id });
  for (const n of TABLES_A) await waitSim(n, (x) => x.state?.relay === false, { what: `стол ${n} погас после отмены` });
  const fa = await freeAfterCancel(TABLES_A[1]);
  out.push(fa.text);
  out.push(`отмена после старта без кода → ${JSON.stringify(cn.json)}; записи ${statuses.join(', ')}; новых возвратов ${newRefunds.length}; журнал ${auC.map((x) => `${x.action} refund=${x.data.refund}`).join(', ')}; тревог отмены ${alC.length} (${alC.map((x) => `${x.data.refund}, ${x.data.staff_name}: ${x.data.reason}`).join('; ')}); свет столов ${TABLES_A.join(', ')} погас; ${(await sim(TABLES_A[0])).state.mode}`);
  t.diagnostic(out.join('; '));
  assert.equal(newRefunds.length, 0, 'после старта без кода — без возврата');
  assert.equal(alC.length, 1);
});
