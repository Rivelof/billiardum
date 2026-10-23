// T24: турнир клуба на столах E2E_TOUR_TABLES (по умолчанию 4 и 5, пирамида), олимпийская система
// на 4 игрока, до 2 побед. Взнос через ЮKassa (эмулятор) с чеком; лимит рейтинга — 409
// rating_above_limit {limit, rating}; отмена записи игроком до закрытия — возврат с чеком возврата.
// Окно турнира (№146): QR, котировка, бронь на столах турнира — отказ; оплата, подтверждённая в
// окне, возвращается. Старт: посев, сетка, столы, свет матча без оплаты стола — подписанная
// команда с device.cmd в журнале; удержание матча продлевается (match_minutes 10). Счёт игроков,
// подтверждение, спор → организатор с причиной; исправление счёта сыгранного матча — пересчёт
// рейтинга записью-коррекцией (№146). Рейтинг турнирных партий ×1,5. ТВ-поток без входа и без ПДн.
// Финал → турнир finished, столы свободны.
//
// Столы: 4, 5 — турнир, 2 — короткая игра для игрока с рейтингом выше лимита. ~6 минут.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  auditAny,
  brief2,
  CLUB_A,
  createBooking,
  emu,
  emuSucceed,
  ensureFree,
  enterAndPay,
  flat,
  idsIn,
  MIN,
  newGuest,
  notificationsFor,
  ok,
  pay,
  phonesIn,
  plusMe,
  plusProfile,
  providerId,
  quote,
  ratingOf,
  receiptsOf,
  refundsOf,
  RES,
  sim,
  sleep,
  slotAfter,
  sseOpen,
  staff,
  startGame,
  table,
  tableCode,
  waitFor,
  waitNotification,
  waitSim,
} from './helpers.mjs';

const TABLES = (process.env.E2E_TOUR_TABLES || '4,5').split(',').map(Number);
const RATED_TABLE = Number(process.env.E2E_TOUR_RATED_TABLE || 2);
const LEAD_MS = Number(process.env.E2E_TOUR_LEAD_MS || 200_000);
const T0 = Date.now();
let db;
let man;
let rec;
const P = {};
const ctx = {};

async function detail() {
  return ok(api('GET', `/api/clubs/${CLUB_A}/tournaments/${ctx.id}`, { token: man.token }));
}

function allMatches(d) {
  return d.bracket.rounds.flatMap((r) => r.matches.map((m) => ({ ...m, round: r.title })));
}

async function matchRow(id) {
  const { rows } = await db.query('select * from bl.tournament_matches where id = $1', [id]);
  return rows[0];
}

function playerOf(userId) {
  return Object.values(P).find((p) => p.user?.id === userId);
}

before(async () => {
  db = await adminClient();
  man = await staff('manager');
  rec = await staff('reception');
  for (const n of [...TABLES, RATED_TABLE]) await ensureFree(n);
});

after(async () => {
  if (ctx.id && !ctx.finished) {
    const r = await api('POST', `/api/clubs/${CLUB_A}/tournaments/${ctx.id}/cancel`, { token: man.token, body: { reason: 'e2e: уборка после сбоя теста' } });
    console.log(`турнир не завершён — отмена: ${brief2(r)}`);
  }
  ctx.sse?.close();
  await db?.end();
});

test('подготовка: игроки с профилями, игрок с рейтингом 1220 (партия на столе 2)', async (t) => {
  for (const k of ['p1', 'p2', 'p3', 'p4', 'p6', 'hi', 'lo', 'q', 's']) P[k] = await newGuest();
  for (const k of ['p1', 'p2', 'p3', 'p4', 'p6', 'hi', 'lo']) await plusProfile(P[k]);
  const g = await startGame(RATED_TABLE, 30, { guest: P.hi });
  await ok(api('POST', `/api/sessions/${g.sessionId}/join`, { token: P.lo.token, body: { code: tableCode(RATED_TABLE) } }));
  const m = await ok(api('POST', '/api/plus/matches', { token: P.hi.token, body: { session_id: g.sessionId, discipline: 'pyramid', opponent_id: P.lo.user.id, my_score: 8, opponent_score: 0 } }), 201);
  const c = await ok(api('POST', `/api/plus/matches/${m.id}/confirm`, { token: P.lo.token, body: {} }));
  assert.equal(c.counted, true);
  await ok(api('POST', `/api/sessions/${g.sessionId}/stop`, { token: P.hi.token, body: {} }));
  assert.equal(ratingOf(await plusMe(P.hi)).rating, 1220);
  await waitSim(RATED_TABLE, (x) => x.state?.mode === 'free', { what: `стол ${RATED_TABLE} свободен` });
  t.diagnostic(`игроки ${['p1', 'p2', 'p3', 'p4'].map((k) => P[k].nick).join(', ')}; ${P.hi.nick} — 1220 (партия 8:0 «всухую»), ${P.lo.nick} — 1180`);
});

test('создание турнира: права, проверки, публикация; окно турнира не принимает игру', async (t) => {
  // Гость Q успевает получить котировку и открыть оплату на столе турнира до создания турнира.
  const tblQ = await table(TABLES[0], P.q.token);
  const qQ = await ok(quote(P.q.token, { resourceId: tblQ.resource.id, minutes: 60 }));
  ctx.payQ = await ok(pay(P.q.token, qQ.quote_id, 'sbp'));
  const startsAt = new Date(Math.ceil((Date.now() + LEAD_MS) / 1000) * 1000);
  const endsAt = new Date(startsAt.getTime() + 60 * MIN);
  const body = {
    title: `E2E Кубок ${P.p1.nick.slice(4, 9)}`,
    description: 'Синтетический турнир приёмки M4',
    discipline: 'pyramid',
    format: 'single_elim',
    race_to: 2,
    rating_limit: 1210,
    fee_kopecks: 30_000,
    prize_text: 'Кубок и грамота',
    places: 8,
    match_minutes: 10,
    starts_at: startsAt.toISOString(),
    ends_at: endsAt.toISOString(),
    resource_ids: TABLES.map(RES),
    publish: true,
  };
  const byRec = await api('POST', `/api/clubs/${CLUB_A}/tournaments`, { token: rec.token, body });
  assert.equal(byRec.status, 403);
  const past = await api('POST', `/api/clubs/${CLUB_A}/tournaments`, { token: man.token, body: { ...body, starts_at: new Date(Date.now() - MIN).toISOString() } });
  assert.equal(past.status, 400);
  const pool = await api('POST', `/api/clubs/${CLUB_A}/tournaments`, { token: man.token, body: { ...body, resource_ids: [RES(6)] } });
  assert.equal(pool.status, 400, 'стол пула в турнире по пирамиде — 400');
  const r = await api('POST', `/api/clubs/${CLUB_A}/tournaments`, { token: man.token, body });
  assert.equal(r.status, 201, brief2(r));
  ctx.id = r.json.id;
  ctx.startsAt = startsAt;
  ctx.endsAt = endsAt;
  assert.equal(r.json.status, 'registration');
  assert.equal(r.json.rating_limit, 1210);
  const pub = await ok(api('GET', `/api/public/tournaments/${ctx.id}`));
  assert.equal(pub.status, 'registration');
  assert.equal(pub.club.path, '/ekaterinburg/testovyy-klub/');
  // До окна: котировка на другом столе турнира принимается (котировка не знает о турнире), а оплата за 5 минут до окна — возврат.
  const tblS = await table(TABLES[1], P.s.token);
  const qS = await quote(P.s.token, { resourceId: tblS.resource.id, minutes: 60 });
  ctx.preWindowQuote = { status: qS.status, error: qS.json?.error, extend_limit_until: qS.json?.extend_limit_until };
  if (qS.status === 200) {
    const pS = await ok(pay(P.s.token, qS.json.quote_id, 'sbp'));
    emuSucceed(providerId(pS));
    const pay2 = await waitFor(
      async () => {
        const x = await api('GET', `/api/payments/${pS.payment_id}`, { token: P.s.token });
        return x.status === 200 && (x.json.session_id || ['refunded', 'refund_pending'].includes(x.json.status) || x.json.refund) ? x.json : null;
      },
      { timeoutMs: 20_000, intervalMs: 300, what: 'оплата перед окном турнира обработана' },
    ).catch(() => null);
    const { rows } = await db.query("select data from bl.audit_log where action = 'session.start_rejected' and data->>'payment_id' = $1", [pS.payment_id]).catch(() => ({ rows: [] }));
    ctx.preWindowPay = { payment_id: pS.payment_id, session_id: pay2?.session_id ?? null, status: pay2?.status, reject: rows[0]?.data?.reason ?? null, refunds: await refundsOf(db, pS.payment_id) };
  }
  t.diagnostic(`ресепшн — 403; начало в прошлом — 400; стол пула — 400; турнир ${ctx.id.slice(0, 8)} опубликован (${r.json.status}), окно ${startsAt.toISOString()}–${endsAt.toISOString()}, столы ${TABLES.join(', ')}; club.path ${pub.club.path}; котировка на столе ${TABLES[1]} за ${Math.round(LEAD_MS / 1000)} с до окна: ${JSON.stringify(ctx.preWindowQuote)}; оплата: ${JSON.stringify({ ...ctx.preWindowPay, refunds: ctx.preWindowPay?.refunds?.map((x) => `${x.amount_kopecks}:${x.status}`) })}`);
});

test('T24: запись со взносом через ЮKassa и чеком; рейтинг выше лимита — отказ с объяснением', async (t) => {
  const t1 = Date.now();
  const hi = await api('POST', `/api/tournaments/${ctx.id}/entries`, { token: P.hi.token, body: {}, idem: true });
  assert.equal(hi.status, 409, brief2(hi));
  assert.deepEqual(hi.json, { error: 'rating_above_limit', limit: 1210, rating: 1220 });
  const noProfile = await newGuest();
  const np = await api('POST', `/api/tournaments/${ctx.id}/entries`, { token: noProfile.token, body: {}, idem: true });
  ctx.noProfileEntry = brief2(np);
  for (const k of ['p1', 'p2', 'p3', 'p4']) {
    const res = await enterAndPay(P[k], ctx.id);
    assert.equal(res.r.status, 201, `${k}: ${brief2(res.r)}`);
    P[k].entryId = res.entry.entry_id;
    P[k].pid = res.pid;
  }
  const dup = await api('POST', `/api/tournaments/${ctx.id}/entries`, { token: P.p1.token, body: {}, idem: true });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error, 'already_registered');
  // Платёж взноса и чек.
  const { rows: pays } = await db.query("select id, kind, status, amount_kopecks, tournament_id, entry_id, provider_payment_id from bl.payments where entry_id = $1", [P.p1.entryId]);
  assert.equal(pays.length, 1);
  assert.equal(pays[0].kind, 'tournament');
  assert.equal(pays[0].status, 'succeeded');
  assert.equal(Number(pays[0].amount_kopecks), 30_000);
  ctx.p1Payment = pays[0].id;
  const rc = await receiptsOf(db, pays[0].id);
  const emuP = emu(`/__emu/payments/${P.p1.pid}`);
  const emuReceipt = emuP.receipt ?? emuP.request?.receipt ?? null;
  assert.ok(rc.length >= 1 || emuReceipt, 'чек взноса есть (в базе или в запросе к ЮKassa)');
  const item = (rc[0]?.items ?? emuReceipt?.items ?? [])[0] ?? {};
  assert.equal(item.payment_mode ?? item.paymentMode, 'full_payment');
  const cust = flat(emuReceipt?.customer ?? rc[0]?.customer ?? {});
  const d = await detail();
  const conf = d.entries.filter((e) => e.status === 'confirmed');
  assert.equal(conf.length, 4, JSON.stringify(d.entries.map((e) => [e.nick, e.status, e.paid])));
  assert.ok(conf.every((e) => e.paid));
  ctx.entriesAfterReg = d.entries.map((e) => `${e.nick ?? '—'}:${e.status}${e.paid ? ':paid' : ''}`).join(', ');
  const au = await auditAny(db, { actions: ['tournament.entry', 'tournament.entry_paid'], since: t1 });
  t.diagnostic(`${P.hi.nick} (1220) — 409 ${JSON.stringify(hi.json)}; без профиля Бильярдум+ — ${ctx.noProfileEntry}; 4 записи оплачены: платёж kind=tournament 300 ₽ succeeded; чек: в базе ${rc.map((x) => `${x.kind}/${x.channel}/${x.status}`).join(', ') || 'нет строки'}, в ЮKassa ${emuReceipt ? `items ${emuReceipt.items?.length}, payment_mode ${item.payment_mode}, «${item.description}», customer ${cust.includes('+7') ? 'телефон' : cust}` : 'нет'}; повтор — 409 already_registered; журнал ${au.length} записей (${[...new Set(au.map((x) => x.action))].join(', ')}); записи клуба: ${ctx.entriesAfterReg}`);
});

test('отмена записи игроком до закрытия записи — взнос возвращён целиком с чеком возврата', async (t) => {
  const res = await enterAndPay(P.p6, ctx.id);
  assert.equal(res.r.status, 201);
  const w = await api('DELETE', `/api/tournaments/${ctx.id}/entries/me`, { token: P.p6.token });
  assert.equal(w.status, 200, brief2(w));
  assert.equal(w.json.status, 'canceled');
  assert.equal(w.json.refund, true);
  const { rows } = await db.query("select id from bl.payments where entry_id = $1 and status in ('succeeded','refunded','partially_refunded')", [res.entry.entry_id]);
  const refunds = await waitFor(
    async () => {
      const r = await refundsOf(db, rows[0].id);
      return r.length && r.every((x) => x.status === 'succeeded') ? r : null;
    },
    { timeoutMs: 30_000, intervalMs: 500, what: 'возврат взноса' },
  );
  assert.equal(refunds.reduce((s, x) => s + Number(x.amount_kopecks), 0), 30_000);
  const rc = await waitFor(
    async () => {
      const r = (await receiptsOf(db, rows[0].id)).filter((x) => x.kind === 'refund');
      return r.length ? r : null;
    },
    { timeoutMs: 30_000, intervalMs: 500, what: 'чек возврата' },
  );
  const me = await ok(api('GET', `/api/tournaments/${ctx.id}/me`, { token: P.p6.token }));
  t.diagnostic(`запись и оплата → DELETE entries/me: canceled, refund=true; возврат ${refunds.map((x) => `${x.amount_kopecks} ${x.status}`).join(', ')}; чек возврата ${rc.map((x) => `${x.kind}/${x.channel}/${x.status}`).join(', ')}; me.entry ${JSON.stringify(me.entry)}`);
});

test('окно турнира (№146): QR, котировка, бронь — отказ table_busy {reason: tournament}; оплата в окне возвращается', async (t) => {
  const wait = ctx.startsAt.getTime() + 3000 - Date.now();
  if (wait > 0) await sleep(wait);
  // Оплата Q, открытая до создания турнира, подтверждается в окне — возврат.
  emuSucceed(providerId(ctx.payQ));
  const rq = await waitFor(
    async () => {
      const { rows } = await db.query("select data from bl.audit_log where action = 'session.start_rejected' and data->>'payment_id' = $1", [ctx.payQ.payment_id]);
      return rows[0] ?? null;
    },
    { timeoutMs: 20_000, intervalMs: 300, what: 'оплата в окне турнира отклонена' },
  );
  const refQ = await waitFor(
    async () => {
      const r = await refundsOf(db, ctx.payQ.payment_id);
      return r.length && r.every((x) => x.status === 'succeeded') ? r : null;
    },
    { timeoutMs: 30_000, intervalMs: 500, what: 'возврат оплаты в окне турнира' },
  );
  const payQ = await ok(api('GET', `/api/payments/${ctx.payQ.payment_id}`, { token: P.q.token }));
  assert.equal(payQ.session_id ?? null, null, 'игра не началась');
  assert.equal(rq.data.reason, 'tournament');
  await sleep(1500);
  const nQ = (await notificationsFor(db, P.q.user.id, { since: T0 })).at(-1) ?? null;
  const alarmQ = (await db.query("select type, level, data from bl.alarms where data->>'payment_id' = $1", [ctx.payQ.payment_id])).rows[0];
  const s4 = await sim(TABLES[0]);
  assert.equal(s4.state.relay, false, 'свет не включился');

  const g = await newGuest();
  const st = await table(TABLES[1], g.token);
  assert.equal(st.status, 'reserved');
  assert.equal(st.hold_source ?? st.hold?.source ?? 'tournament', 'tournament');
  const q = await quote(g.token, { resourceId: st.resource.id, minutes: 60 });
  const bk = await createBooking(g.token, { table: TABLES[1], startsAt: slotAfter(30 * MIN, 30), minutes: 60 });
  ctx.bookingInWindow = { status: bk.status, json: bk.json };
  const late = await api('POST', `/api/tournaments/${ctx.id}/entries`, { token: g.token, body: {}, idem: true });
  const pub = await ok(api('GET', `/api/public/tournaments/${ctx.id}`));
  t.diagnostic(`оплата Q в окне: session.start_rejected reason=${rq.data.reason}, возврат ${refQ.map((x) => `${x.amount_kopecks} ${x.status}`).join(', ')}, сессии нет, свет стола ${TABLES[0]} relay=false; гостю ${nQ ? `${nQ.kind} «${nQ.text}»` : 'уведомлений нет'}; тревога ${alarmQ ? `${alarmQ.type}/${alarmQ.level}` : 'нет'}; QR стола ${TABLES[1]}: ${st.status}/${st.hold_source ?? '-'} до ${st.busy_until}; котировка — ${q.status} ${JSON.stringify(q.json)}; бронь в окне — ${bk.status} ${JSON.stringify(bk.json)}; запись после закрытия — ${late.status} ${late.json?.error}; статус турнира ${pub.status}`);
  assert.equal(late.status, 409);
  assert.equal(late.json.error, 'registration_closed');
  assert.equal(q.status, 409, brief2(q));
  assert.equal(q.json.error, 'table_busy');
  assert.equal(bk.status, 409, brief2(bk));
  assert.equal(q.json.reason, 'tournament', 'котировка в окне турнира: нет reason');
  assert.equal(new Date(q.json.busy_until).getTime(), ctx.endsAt.getTime(), 'котировка в окне турнира: нет busy_until');
  assert.equal(bk.json.error, 'table_busy', 'бронь в окне турнира: ожидали table_busy {reason: tournament}');
  assert.equal(bk.json.reason, 'tournament');
});

test('старт: посев, сетка, столы турнира, свет матча — подписанная команда с device.cmd', async (t) => {
  const tStart = Date.now();
  const byRec = await api('POST', `/api/clubs/${CLUB_A}/tournaments/${ctx.id}/start`, { token: rec.token, body: {} });
  assert.equal(byRec.status, 403);
  const r = await api('POST', `/api/clubs/${CLUB_A}/tournaments/${ctx.id}/start`, { token: man.token, body: {} });
  assert.equal(r.status, 200, brief2(r));
  assert.equal(r.json.status, 'running');
  ctx.sse = sseOpen(`/api/public/tournaments/${ctx.id}/stream`);
  const ready = await ctx.sse.ready;
  assert.equal(ready.status, 200, 'ТВ-поток без входа');
  const seeds = r.json.entries.filter((e) => e.status === 'confirmed').map((e) => e.seed).sort();
  assert.deepEqual(seeds, [1, 2, 3, 4]);
  const ms = allMatches(r.json);
  const semis = ms.filter((m) => m.a && m.b);
  assert.equal(semis.length, 2);
  const pairs = semis.map((m) => [m.a.seed, m.b.seed].sort().join('-')).sort();
  assert.deepEqual(pairs, ['1-4', '2-3'], 'посев 1–4, 2–3');
  const rows = await waitFor(
    async () => {
      const x = await Promise.all(semis.map((m) => matchRow(m.id)));
      return x.every((m) => m.resource_id) ? x : null;
    },
    { timeoutMs: 60_000, intervalMs: 1000, what: 'полуфиналам даны столы' },
  );
  const used = rows.map((m) => m.resource_id).sort();
  assert.deepEqual(used, TABLES.map(RES).sort(), 'полуфиналы на столах турнира');
  ctx.semis = rows;
  for (const n of TABLES) await waitSim(n, (x) => x.state?.relay === true && x.state?.mode !== 'free', { what: `свет матча на столе ${n}` });
  const { rows: sess } = await db.query("select id, source, payer_user_id, match_id, paid_until from bl.sessions where match_id = any($1::uuid[])", [rows.map((m) => m.id)]);
  assert.equal(sess.length, 2);
  assert.ok(sess.every((s) => s.source === 'tournament' && s.payer_user_id === null));
  const { rows: cmds } = await db.query(
    `select c.id::text, c.type, c.status, r.number from bl.device_commands c join bl.devices d on d.id = c.device_id join bl.resources r on r.id = d.resource_id
      where c.created_at >= $1 and r.number = any($2::int[]) and c.type = 'session.start'`,
    [new Date(tStart), TABLES],
  );
  const { rows: au } = await db.query("select data->>'cmd_id' as id from bl.audit_log where action = 'device.cmd' and data->>'cmd_id' = any($1::text[])", [cmds.map((c) => c.id)]);
  assert.equal(cmds.length, 2);
  assert.equal(au.length, 2, 'у каждой команды session.start есть device.cmd');
  const { rows: starts } = await db.query("select action, actor_type, data from bl.audit_log where action = 'session.start' and data->>'match_id' = any($1::text[])", [rows.map((m) => m.id)]);
  assert.equal(starts.length, 2);
  assert.ok(starts.every((x) => x.data.source === 'tournament'));
  const { rows: manual } = await db.query("select count(*)::int as n from bl.audit_log where action like 'manual.%' and created_at >= $1 and club_id = $2", [new Date(tStart), CLUB_A]);
  const ev = await ctx.sse.waitEvent((e) => e.event === 'bracket', { what: 'событие bracket на ТВ' });
  const evText = ev.raw;
  const ids = Object.values(P).map((p) => p.user?.id);
  assert.deepEqual(phonesIn(evText), []);
  assert.deepEqual(idsIn(evText, ids), [], 'в ТВ-потоке нет user_id');
  const pub = await ok(api('GET', `/api/public/tournaments/${ctx.id}`));
  assert.deepEqual(idsIn(flat(pub), ids), []);
  assert.deepEqual(phonesIn(flat(pub)), []);
  assert.ok(pub.entries.every((e) => Object.keys(e).sort().join() === 'nick,rating,seed'));
  t.diagnostic(`ресепшн start — 403; running; посев ${pairs.join(', ')}; полуфиналы на столах ${TABLES.join(', ')}; свет relay=true на обоих; сессии source=tournament без плательщика; session.start ×2 с device.cmd ×2; журнал session.start source=tournament ×2; ручных действий за старт ${manual[0].n}; ТВ без входа: bracket за ${ev.at - tStart} мс, без телефонов и user_id; публичный турнир: entries {nick, seed, rating}`);
});

test('удержание матча продлевается у конца (match_minutes 10, №146) — свет не гаснет', async (t) => {
  const m = ctx.semis[0];
  const before = new Date(m.hold_until).getTime();
  const ext = await waitFor(
    async () => {
      const x = await matchRow(m.id);
      return new Date(x.hold_until).getTime() > before ? x : null;
    },
    { timeoutMs: 60_000, intervalMs: 1000, what: 'hold_until продлён' },
  ).catch(() => null);
  const { rows } = await db.query("select data, created_at from bl.audit_log where action = 'session.extend' and data->>'match_id' = $1", [m.id]);
  const n = TABLES[ctx.semis[0].resource_id === RES(TABLES[0]) ? 0 : 1];
  const s = await sim(n);
  t.diagnostic(`hold_until ${new Date(before).toISOString()} → ${ext ? new Date(ext.hold_until).toISOString() : 'не продлён за 60 с'}; session.extend source=tournament ×${rows.length}; симулятор стола ${n}: relay=${s.state.relay}, remaining ${Math.round(s.state.remaining_ms / 1000)} с`);
  assert.ok(ext, 'удержание матча продлено');
  assert.ok(rows.length >= 1);
});

test('счёт: игрок вносит, соперник подтверждает; чужой — 403; неверный счёт — 409 bad_score; стол гаснет', async (t) => {
  const m = ctx.semis[0];
  const a = playerOf(m.user_a);
  const b = playerOf(m.user_b);
  const stranger = playerOf(ctx.semis[1].user_a);
  const n = Number(Object.entries({ [TABLES[0]]: RES(TABLES[0]), [TABLES[1]]: RES(TABLES[1]) }).find(([, id]) => id === m.resource_id)[0]);
  ctx.semi1Table = n;
  const bad = await api('POST', `/api/tournaments/matches/${m.id}/score`, { token: a.token, body: { score_a: 3, score_b: 0 } });
  assert.equal(bad.status, 409);
  assert.equal(bad.json.error, 'bad_score');
  const foreign = await api('POST', `/api/tournaments/matches/${m.id}/score`, { token: stranger.token, body: { score_a: 2, score_b: 0 } });
  assert.ok([403, 404].includes(foreign.status), `чужой матч: ${foreign.status}`);
  const nothing = await api('POST', `/api/tournaments/matches/${m.id}/confirm`, { token: b.token, body: {} });
  assert.equal(nothing.status, 409);
  assert.equal(nothing.json.error, 'nothing_to_confirm');
  const r1 = await ok(api('POST', `/api/tournaments/matches/${m.id}/score`, { token: a.token, body: { score_a: 2, score_b: 0 } }));
  assert.equal(r1.status, 'pending_confirm');
  const meB = await ok(api('GET', `/api/tournaments/${ctx.id}/me`, { token: b.token }));
  assert.equal(meB.match.id, m.id);
  assert.equal(meB.match.i_confirmed, false);
  // M4-3: подтверждение со счётом, который видел игрок; соперник переписал — 409 score_changed.
  await ok(api('POST', `/api/tournaments/matches/${m.id}/score`, { token: a.token, body: { score_a: 2, score_b: 1 } }));
  const stale = await api('POST', `/api/tournaments/matches/${m.id}/confirm`, { token: b.token, body: { score_a: 2, score_b: 0 } });
  assert.equal(stale.status, 409, brief2(stale));
  assert.equal(stale.json.error, 'score_changed');
  await ok(api('POST', `/api/tournaments/matches/${m.id}/score`, { token: a.token, body: { score_a: 2, score_b: 0 } }));
  const c = await ok(api('POST', `/api/tournaments/matches/${m.id}/confirm`, { token: b.token, body: { score_a: 2, score_b: 0 } }));
  assert.equal(c.status, 'done');
  assert.equal(c.winner, 'a');
  await waitSim(n, (x) => x.state?.relay === false, { what: `стол ${n} погас после матча` });
  const st = await table(n, a.token);
  t.diagnostic(`счёт 3:0 при «до 2» — 409 bad_score; чужой — ${foreign.status}; подтверждать нечего — 409 nothing_to_confirm; ${a.nick} внёс 2:0 → pending_confirm, переписал на 2:1 и обратно; подтверждение со старым счётом — 409 score_changed; ${b.nick} видит в /me i_confirmed=false, подтвердил с показанным счётом → done, победитель a; стол ${n} погас; QR стола между матчами: ${st.status}/${st.hold_source ?? '-'} (окно турнира)`);
  assert.equal(st.status, 'reserved', 'между матчами стол турнира не принимает игру (№146)');
});

test('исправление счёта сыгранного матча организатором (№146): причина, журнал, пересчёт рейтинга записью-коррекцией', async (t) => {
  const m = ctx.semis[0];
  const ra = playerOf(m.user_a);
  const rb = playerOf(m.user_b);
  const hist0 = await waitFor(
    async () => {
      const { rows } = await db.query("select user_id, delta, kind, revision, multiplier_x10, rating_before, k from bl.rating_history where match_id in (select id from bl.matches where tournament_match_id = $1) order by created_at", [m.id]);
      return rows.length === 2 ? rows : null;
    },
    { timeoutMs: 30_000, intervalMs: 500, what: 'рейтинг полуфинала применён' },
  );
  assert.ok(hist0.every((h) => h.multiplier_x10 === 15), 'турнирная партия ×1,5');
  const exp = Math.round(40 * 1.5 * (1 - 1 / (1 + 10 ** ((hist0.find((h) => h.user_id === rb.user.id).rating_before - hist0.find((h) => h.user_id === ra.user.id).rating_before) / 400))));
  assert.equal(Number(hist0.find((h) => h.user_id === ra.user.id).delta), exp);
  const ratingA0 = ratingOf(await plusMe(ra)).rating;
  const ratingB0 = ratingOf(await plusMe(rb)).rating;
  const noReason = await api('PATCH', `/api/tournaments/matches/${m.id}/score`, { token: man.token, body: { score_a: 0, score_b: 2 } });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.json.error, 'reason_required');
  const byRec = await api('PATCH', `/api/tournaments/matches/${m.id}/score`, { token: rec.token, body: { score_a: 0, score_b: 2, reason: 'x' }, headers: { 'x-club-id': CLUB_A } });
  assert.equal(byRec.status, 403);
  const t1 = Date.now();
  const r = await api('PATCH', `/api/tournaments/matches/${m.id}/score`, { token: man.token, body: { score_a: 0, score_b: 2, reason: 'Судья: перепутали стороны при вводе' } });
  assert.equal(r.status, 200, brief2(r));
  assert.equal(r.json.winner, 'b');
  assert.equal(r.json.revision, 1);
  const au = await auditAny(db, { actions: ['manual.tournament_score'], since: t1, like: m.id });
  assert.equal(au.length, 1);
  assert.equal(au[0].reason, 'Судья: перепутали стороны при вводе');
  assert.deepEqual(au[0].data.after, { score_a: 0, score_b: 2 });
  const hist = await waitFor(
    async () => {
      const { rows } = await db.query("select user_id, delta, kind, revision from bl.rating_history where match_id in (select id from bl.matches where tournament_match_id = $1) order by created_at", [m.id]);
      return rows.length >= 6 ? rows : null;
    },
    { timeoutMs: 30_000, intervalMs: 500, what: 'коррекция рейтинга' },
  );
  const sumA = hist.filter((h) => h.user_id === ra.user.id).reduce((s, h) => s + Number(h.delta), 0);
  const ratingA1 = ratingOf(await plusMe(ra)).rating;
  const ratingB1 = ratingOf(await plusMe(rb)).rating;
  const ownerNote = await waitNotification(db, 'a1000000-0000-4000-8000-000000000001', 'tournament.score_corrected', { since: t1 }).catch(() => null);
  const d = await detail();
  const fin = allMatches(d).find((x) => x.round && x.a && x.b === null ? false : x.id !== m.id && x.id !== ctx.semis[1].id);
  t.diagnostic(`исходно Δ ${hist0.map((h) => `${h.kind}:${h.delta} (k ${h.k} ×${h.multiplier_x10 / 10})`).join(', ')} — по формуле ${exp}; без причины — 400; ресепшн — 403; исправление 0:2 → winner b, revision 1, журнал manual.tournament_score (до/после, причина); rating_history: ${hist.map((h) => `${h.kind}/r${h.revision}:${h.delta}`).join(', ')}; A ${ratingA0} → ${ratingA1}, B ${ratingB0} → ${ratingB1}; владельцу ${ownerNote ? `«${ownerNote.text}»` : 'нет уведомления'}; финал ждёт: ${fin ? `${fin.a?.nick ?? '—'} – ${fin.b?.nick ?? '—'}` : '?'}`);
  assert.ok(hist.some((h) => h.kind === 'reversal'), 'есть запись-коррекция');
  assert.equal(ratingA1, 1200 + sumA, 'рейтинг A = старт + сумма всех записей');
  assert.ok(ratingA1 < ratingA0 && ratingB1 > ratingB0);
});

test('спор по счёту: разный счёт игроков → организаторам, исправление с причиной; финал → турнир finished, столы свободны', async (t) => {
  const m = ctx.semis[1];
  const a = playerOf(m.user_a);
  const b = playerOf(m.user_b);
  const t1 = Date.now();
  await ok(api('POST', `/api/tournaments/matches/${m.id}/score`, { token: a.token, body: { score_a: 2, score_b: 1 } }));
  const d1 = await ok(api('POST', `/api/tournaments/matches/${m.id}/score`, { token: b.token, body: { score_a: 1, score_b: 2 } }));
  assert.equal(d1.status, 'disputed');
  const note = await waitNotification(db, 'a1000000-0000-4000-8000-000000000003', 'tournament.dispute', { since: t1 });
  assert.equal(note.level, 'important');
  // №147: счёт внесён — свет не продлевается и гаснет через 5 минут после первого внесённого счёта.
  const tn = TABLES.find((n) => RES(n) === m.resource_id);
  const off = await waitSim(tn, (x) => x.state?.relay === false, { timeoutMs: 7 * MIN, intervalMs: 2000, what: `стол ${tn} погас через 5 мин после счёта` });
  const offAfter = Math.round((Date.now() - t1) / 1000);
  const { rows: ss } = await db.query("select status, close_reason, ended_at from bl.sessions where match_id = $1", [m.id]);
  ctx.tail = `спорный матч на столе ${tn}: свет погас через ${offAfter} с после первого счёта (sim ${off.state.mode}), сессия ${ss[0]?.status}/${ss[0]?.close_reason}`;
  assert.ok(offAfter >= 290 && offAfter <= 400, `свет погас через ${offAfter} с`);
  const fix = await ok(api('PATCH', `/api/tournaments/matches/${m.id}/score`, { token: man.token, body: { score_a: 2, score_b: 1, reason: 'По видео: 2:1' } }));
  assert.equal(fix.status, 'done');
  const { rows: ma } = await db.query("select type, level, data->>'reason' as reason from bl.alarms where club_id = $1 and type = 'manual_action' and data->>'match_id' = $2", [CLUB_A, m.id]);
  ctx.tail += `; тревога за исправление: ${ma.map((x) => `${x.type}/${x.level} «${x.reason}»`).join(', ') || 'нет'}`;
  // Финал: оба полуфинала сыграны — стол и свет.
  const d = await waitFor(
    async () => {
      const x = await detail();
      const f = allMatches(x).find((y) => y.a && y.b && ![ctx.semis[0].id, ctx.semis[1].id].includes(y.id));
      return f && f.status === 'playing' ? { x, f } : null;
    },
    { timeoutMs: 40_000, intervalMs: 1000, what: 'финал начался' },
  );
  const f = await matchRow(d.f.id);
  const fn = TABLES.find((n) => RES(n) === f.resource_id);
  await waitSim(fn, (x) => x.state?.relay === true, { what: `свет финала на столе ${fn}` });
  const fa = playerOf(f.user_a);
  const fb = playerOf(f.user_b);
  await ok(api('POST', `/api/tournaments/matches/${f.id}/score`, { token: fb.token, body: { score_a: 1, score_b: 2 } }));
  const done = await ok(api('POST', `/api/tournaments/matches/${f.id}/confirm`, { token: fa.token, body: { score_a: 1, score_b: 2 } }));
  assert.equal(done.status, 'done');
  const pub = await waitFor(
    async () => {
      const x = await api('GET', `/api/clubs/${CLUB_A}/tournaments/${ctx.id}`, { token: man.token });
      return x.json?.status === 'finished' ? x.json : null;
    },
    { timeoutMs: 20_000, intervalMs: 500, what: 'турнир finished' },
  );
  ctx.finished = true;
  await waitSim(fn, (x) => x.state?.relay === false, { what: 'финал: свет погас' });
  const free = [];
  for (const n of TABLES) free.push((await table(n, a.token)).status);
  const ev = ctx.sse.events.filter((e) => e.event === 'bracket');
  const last = ev.at(-1)?.data;
  const fHist = await waitFor(
    async () => {
      const { rows } = await db.query("select delta, multiplier_x10 from bl.rating_history where match_id in (select id from bl.matches where tournament_match_id = $1)", [f.id]);
      return rows.length === 2 ? rows : null;
    },
    { timeoutMs: 30_000, intervalMs: 500, what: 'рейтинг финала' },
  );
  const fin = await auditAny(db, { actions: ['tournament.finish', 'tournament.dispute', 'manual.tournament_score'], since: t1 });
  t.diagnostic(`${ctx.tail}; разный счёт → disputed, управляющему (${note.level}) «${note.text}»; исправление 2:1 с причиной → done; финал ${fa.nick} – ${fb.nick} на столе ${fn}, свет включён; B внёс 1:2, A подтвердил → done; турнир ${pub.status}, победитель ${fb.nick}; рейтинг финала ${fHist.map((h) => `${h.delta}×${h.multiplier_x10 / 10}`).join(', ')}; свет погас; QR столов ${TABLES.join(', ')} после турнира: ${free.join(', ')}; ТВ получил ${ev.length} событий bracket, последнее — ${last?.winner ? `winner ${JSON.stringify(last.winner)}` : 'без победителя'}; журнал ${fin.map((x) => x.action).join(', ')}`);
  assert.deepEqual(free, TABLES.map(() => 'free'), 'после турнира столы свободны');
});
