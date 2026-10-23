// T27 «Тестовые данные не смешиваются с боевыми» (docs/contracts/m5-1.md §5; №153, №160).
//
// Клуб из 01 (E2E_M5_DIR/state.json), режим test:
//   * касса ресепшена: мост ККТ клуба на хосте (эмулятор АТОЛ на своём порту, по умолчанию 16733,
//     мост — wss://localhost:8443/api/kkt/ws, как на ПК ресепшена); смена в test — без открытия смены
//     ККТ; продажа — нефискальный «ТЕСТ» без ФД; отчёт смены, «Сейчас» владельца — без тестовых записей;
//   * партия Бильярдум+ в тестовой сессии — confirmed без Эло; клуба нет в каталоге; утренняя сводка
//     клубу в test не уходит (настоящий планировщик tick() с подставными часами, транзакция с ROLLBACK);
//   * go-live при невыполненном чек-листе — 409 checklist_incomplete {failed}; после исправления —
//     live, журнал club.go_live, уведомление Андрею, плашки нет, карточка в каталоге связана с клубом;
//   * в live: тариф и стол — только с причиной, журнал manual.* и тревога владельцу; позиция — журнал;
//     боевые записи (игра по боевому магазину, смена ККТ, фискальный чек) — в отчётах, тестовые — нет.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { tick } from '../../../server/summaries/index.mjs';
import {
  adminClient,
  alarmsOf,
  ANDREY_ID,
  api,
  capi,
  clubAudit,
  clubCmdsWithAudit,
  emu,
  emuSucceed,
  hostKkt,
  loadState,
  loginRetry,
  newGuest,
  notificationsFor,
  plusMe,
  plusProfile,
  providerId,
  saveState,
  SHOPS,
  short,
  sleep,
  startHostKkt,
  stopProcess,
  waitClaimSim,
  waitFor,
  waitPaymentSession,
} from './helpers.mjs';

const KKT_PORT = Number(process.env.E2E_M5_KKT_PORT || 16733);
const st = loadState();
const skip = !st.club || !st.tables?.[0]?.device_id ? 'нет клуба из 01 (E2E_M5_DIR/state.json)' : false;
const PORT = st.port ?? 18081;
const S = {};
let db;

before(async () => {
  if (skip) return;
  db = await adminClient();
  S.owner = await loginRetry(st.ownerPhone, { consent: false });
  S.rec = await loginRetry(st.recPhone, { consent: false });
  const { rows } = await db.query('select id, name from bl.products where club_id = $1', [st.club]);
  S.products = Object.fromEntries(rows.map((r) => [r.name, r.id]));
});

after(async () => {
  if (skip) return;
  if (S.liveGame) await api('POST', `/api/sessions/${S.liveGame.sessionId}/stop`, { token: S.liveGame.guest.token, body: {} }).catch(() => {});
  if (!process.env.E2E_M5_KEEP_KKT && S.kkt) {
    stopProcess(S.kkt.bridgePid);
    stopProcess(S.kkt.emuPid);
  }
  await db?.end();
});

const C = () => st.club;
const own = (method, p, body) => capi(method, p, { token: S.owner.token, club: C(), body });
const onboarding = async () => (await own('GET', `/api/clubs/${C()}/onboarding`)).json;

/** Настоящий планировщик сводок с подставными часами в транзакции с ROLLBACK. → { sent, data } */
async function summaryAt(at) {
  const withContext = async (_pool, { clubId, userId = null, actorType }, fn) => {
    await db.query('savepoint e2e_ctx');
    try {
      await db.query("select set_config('app.club_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_type', $3, true)", [clubId ?? '', userId ?? '', actorType]);
      const r = await fn(db);
      await db.query('release savepoint e2e_ctx');
      return r;
    } catch (err) {
      await db.query('rollback to savepoint e2e_ctx');
      throw err;
    }
  };
  await db.query('begin');
  try {
    const errors = [];
    const { sent } = await tick({ pool: null, withContext, clock: { now: () => at }, log: { info() {}, warn() {}, error: (m, f) => errors.push(`${m} ${JSON.stringify(f)}`) } });
    const mine = sent.filter((s) => s.club_id === C());
    let data = null;
    if (mine.length) {
      const { rows } = await db.query("select data from bl.club_summaries where club_id = $1 and kind = 'morning' and day = $2", [C(), mine[0].day]);
      data = rows[0]?.data ?? null;
    }
    return { sent: mine, data, errors };
  } finally {
    await db.query('rollback');
  }
}

/** Завтра 10:00 по Екатеринбургу (UTC+5): сводка за сегодняшние рабочие сутки (с 06:00). */
function tomorrow10() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 1, 0, 0));
  if (now < start) start.setUTCDate(start.getUTCDate() - 1);
  return new Date(start.getTime() + 28 * 3600_000);
}

test('T27-1: go-live при невыполненном чек-листе — 409 checklist_incomplete со списком пунктов', { skip }, async (t) => {
  const r = await own('POST', `/api/clubs/${C()}/go-live`, { accept_offer: false });
  assert.equal(r.status, 409, short(r));
  assert.equal(r.json.error, 'checklist_incomplete');
  assert.deepEqual([...r.json.failed].sort(), ['kkt', 'offer', 'shop_live']);
  const rec = await capi('POST', `/api/clubs/${C()}/go-live`, { token: S.rec.token, club: C(), body: { accept_offer: true } });
  assert.equal(rec.status, 403, 'ресепшн не переводит клуб');
  const { rows } = await db.query('select mode from bl.clubs where id = $1', [C()]);
  assert.equal(rows[0].mode, 'test');
  t.diagnostic(`409 ${JSON.stringify(r.json)}; ресепшн — 403; режим test`);
});

test('T27-2: касса в test — мост ККТ клуба, смена без смены ККТ, продажа — нефискальный «ТЕСТ»', { skip }, async (t) => {
  const reg = await own('POST', `/api/clubs/${C()}/kkt/bridges`, { name: 'Ресепшн e2e M5' });
  assert.equal(reg.status, 201, short(reg));
  S.kkt = startHostKkt({ token: reg.json.token, port: KKT_PORT, tag: C().slice(0, 8) });
  saveState({ kkt: { emuPid: S.kkt.emuPid, bridgePid: S.kkt.bridgePid, port: KKT_PORT } });
  const br = await waitFor(
    async () => {
      const r = await own('GET', `/api/clubs/${C()}/kkt/bridges`);
      const b = r.json?.find?.((x) => x.id === reg.json.bridge.id) ?? r.json?.items?.find?.((x) => x.id === reg.json.bridge.id);
      return b?.online && b?.last_status?.fiscal === true ? b : null;
    },
    { timeoutMs: 45_000, intervalMs: 1000, what: 'мост ККТ клуба на связи, ККТ фискальная' },
  );
  const emu0 = await hostKkt(KKT_PORT, '/__emu/state');
  const sh = await capi('POST', `/api/clubs/${C()}/shifts`, { token: S.rec.token, club: C(), body: { float_kopecks: 100_000 } });
  assert.equal(sh.status, 201, short(sh));
  S.testShift = sh.json.id;
  const { rows: srow } = await db.query('select is_test from bl.shifts where id = $1', [S.testShift]);
  assert.equal(srow[0].is_test, true, 'смена тестовая');
  const water = S.products['Вода e2e'];
  const tea = S.products['Чай e2e'];
  const a = await capi('POST', '/api/pos/sales', { token: S.rec.token, club: C(), body: { items: [{ product_id: water, qty: 2 }], method: 'cash', received_kopecks: 50_000 }, idem: true });
  assert.ok([200, 201].includes(a.status), short(a));
  const b = await capi('POST', '/api/pos/sales', { token: S.rec.token, club: C(), body: { items: [{ product_id: tea, qty: 1 }], method: 'card_terminal' }, idem: true });
  assert.ok([200, 201].includes(b.status), short(b));
  S.testSales = [a.json.id ?? a.json.sale_id ?? a.json.sale?.id, b.json.id ?? b.json.sale_id ?? b.json.sale?.id];
  // Ждём, пока оба документа «ТЕСТ» напечатаны и сервер получил ответ моста (чек закрыт или застрял).
  const rcpt = async () =>
    (
      await db.query(
        `select r.id, r.is_test, r.status, r.fiscal, r.fd, r.fp, r.error, r.kkt_job->>'state' as job_state, (r.kkt_job->>'test')::boolean as job_test
           from bl.receipts r join bl.pos_sales s on s.receipt_id = r.id where s.id = any($1::uuid[])`,
        [S.testSales],
      )
    ).rows;
  await waitFor(async () => {
    const rows = await rcpt();
    return rows.length === 2 && rows.every((r) => r.status === 'printed' || r.error) ? rows : null;
  }, { timeoutMs: 60_000, intervalMs: 1000, what: 'ответ моста по тестовым чекам' });
  const printed = await rcpt();
  const docs = await hostKkt(KKT_PORT, '/__emu/documents');
  const emu1 = await hostKkt(KKT_PORT, '/__emu/state');
  const nonFiscal = docs.filter((d) => d.kind === 'nonFiscal');
  const fiscal = docs.filter((d) => d.fd !== null && d.fd !== undefined);
  const { rows: sales } = await db.query('select id, is_test, status from bl.pos_sales where id = any($1::uuid[])', [S.testSales]);
  assert.ok(sales.every((s) => s.is_test), 'продажи тестовые');
  const au = await clubAudit(db, C(), { actions: ['kkt.receipt_test_printed'] });
  const al = await alarmsOf(db, C(), { type: 'receipt_unknown' });
  t.diagnostic(`мост ${br.id.slice(0, 8)} online, fiscal=true; смена is_test=true; ККТ: смена ${JSON.stringify(emu0.shift?.state ?? emu0.shift)} → ${JSON.stringify(emu1.shift?.state ?? emu1.shift)}; документы эмулятора: ${docs.map((d) => `${d.kind ?? 'fiscal'}${d.fd ? ` ФД ${d.fd}` : ''}`).join(', ')}; строки: «${nonFiscal[0]?.lines.slice(0, 4).join(' | ')}»; чеки: ${printed.map((r) => `${r.status} test=${r.is_test} fd=${r.fd} error=${r.error} job_state=${r.job_state} job.test=${r.job_test}`).join('; ')}; журнал kkt.receipt_test_printed ×${au.length}; тревоги receipt_unknown: ${al.map((a) => `${a.level} ${a.data.error}`).join(', ') || 'нет'}`);
  assert.equal(nonFiscal.length, 2, 'два нефискальных документа');
  assert.ok(nonFiscal.every((d) => d.lines.some((l) => /ТЕСТ/.test(l))), 'в документе «ТЕСТ»');
  assert.equal(fiscal.length, 0, 'ни одного фискального документа');
  assert.equal(emu1.shift?.state ?? emu1.shift, emu0.shift?.state ?? emu0.shift, 'смена ККТ не открывалась');
  assert.ok(printed.every((r) => r.is_test && r.fd === null && r.fp === null), 'без фискальных реквизитов');
  assert.deepEqual(al, [], 'тревог «исход чека неизвестен» нет');
  assert.ok(printed.every((r) => r.status === 'printed'), `тестовые чеки закрыты printed (нефискальный «ТЕСТ»): ${printed.map((r) => `${r.status}/${r.error}`).join(', ')}`);
  assert.equal(au.length, 2, 'журнал kkt.receipt_test_printed по каждому');
});

test('T27-3: тестовая игра и партия Бильярдум+ — партия confirmed без Эло, рейтинга нет', { skip }, async (t) => {
  const tb = st.tables.find((x) => x.kind === 'pyramid');
  const A = await newGuest();
  const B = await newGuest();
  await plusProfile(A);
  await plusProfile(B);
  const ra0 = (await plusMe(A)).ratings;
  const tbl = (await capi('GET', `/api/t/${tb.code}`, { token: A.token })).json;
  assert.equal(tbl.club.mode, 'test');
  const q = await capi('POST', '/api/quotes', { token: A.token, body: { resource_id: tb.id, kind: 'start', minutes: 30 } });
  assert.equal(q.status, 200, short(q));
  const pay = await capi('POST', `/api/quotes/${q.json.quote_id}/pay`, { token: A.token, body: { method: 'sbp' }, idem: true });
  const pid = providerId(pay.json);
  assert.equal(emu(`/__emu/payments/${pid}`).shop_id, SHOPS.test.shop_id);
  emuSucceed(pid);
  const p = await waitPaymentSession(A.token, pay.json.payment_id);
  S.testGame = { guest: A, sessionId: p.session_id };
  await waitClaimSim(PORT, tb.sim, (x) => x.state?.relay === true, { what: 'свет тестовой игры' });
  await capi('POST', `/api/sessions/${p.session_id}/join`, { token: B.token, body: { code: tb.code } });
  const m = await capi('POST', '/api/plus/matches', { token: A.token, body: { session_id: p.session_id, discipline: 'pyramid', opponent_id: B.user.id, my_score: 8, opponent_score: 5 } });
  assert.equal(m.status, 201, short(m));
  const c = await capi('POST', `/api/plus/matches/${m.json.id}/confirm`, { token: B.token, body: { score_a: 8, score_b: 5 } });
  assert.equal(c.status, 200, short(c));
  const { rows: mr } = await db.query('select is_test, status from bl.matches where id = $1', [m.json.id]);
  const { rows: rh } = await db.query('select count(*)::int as n from bl.rating_history where match_id = $1', [m.json.id]);
  const ra1 = (await plusMe(A)).ratings;
  assert.equal(mr[0].is_test, true);
  assert.equal(mr[0].status, 'confirmed');
  assert.equal(rh[0].n, 0, 'в рейтинг не идёт');
  assert.deepEqual(ra1, ra0, 'рейтинг игрока не изменился');
  assert.notEqual(c.json.counted, true);
  // «Закончить игру» — свет гаснет.
  const stop = await capi('POST', `/api/sessions/${p.session_id}/stop`, { token: A.token, body: {} });
  assert.equal(stop.status, 200, short(stop));
  await waitClaimSim(PORT, tb.sim, (x) => x.state?.relay === false && x.state?.mode === 'free', { what: 'свет погас после «Закончить»' });
  S.testGame = null;
  t.diagnostic(`партия ${m.json.id.slice(0, 8)}: is_test=${mr[0].is_test}, status=${mr[0].status}, counted=${c.json.counted}, rating_delta=${JSON.stringify(c.json.rating_delta ?? null)}; rating_history 0; рейтинг A до/после: ${JSON.stringify(ra0)} / ${JSON.stringify(ra1)}; стоп — свет погас`);
});

test('T27-4: отчёт смены, «Сейчас», каталог и утренняя сводка — без тестовых записей; смена закрыта «ТЕСТ»-отчётом', { skip }, async (t) => {
  const rep = await own('GET', `/api/shifts/${S.testShift}/report?online=0`);
  assert.equal(rep.status, 200, short(rep));
  const rv = rep.json.revenue;
  const now = await own('GET', `/api/clubs/${C()}/now`);
  const totalNow = Object.values(now.json.revenue_today_kopecks).reduce((a, b) => a + b, 0);
  const { rows: tp } = await db.query("select count(*)::int as n, coalesce(sum(amount_kopecks), 0)::int as k from bl.payments where club_id = $1 and is_test and status = 'succeeded'", [C()]);
  assert.ok(tp[0].n >= 2, 'тестовые платежи есть');
  assert.equal(rv.total_kopecks ?? rv.total, 0, `выручка смены без тестовых: ${JSON.stringify(rv)}`);
  assert.equal(rep.json.play.sessions, 0, 'тестовые игры не в отчёте смены');
  assert.equal(totalNow, 0, '«Сейчас» без тестовых платежей');
  // Каталог: только live.
  const pub = (await api('GET', '/api/clubs')).json;
  assert.ok(!pub.some((x) => x.id === C()), 'нет в /api/clubs');
  const city = (await api('GET', '/api/public/cities/ekaterinburg')).json;
  assert.ok(!city.items.some((x) => x.club_id === C()), 'нет в каталоге города');
  const { rows: cards } = await db.query('select count(*)::int as n from bl.club_public where club_id = $1', [C()]);
  assert.equal(cards[0].n, 0, 'карточки нет');
  // Сводка: клубу в test не уходит.
  const sum = await summaryAt(tomorrow10());
  assert.deepEqual(sum.sent, [], 'клубу в test сводка не отправляется');
  assert.deepEqual(sum.errors, []);
  // Закрыть смену: ожидаемое — только размен.
  const cur = (await own('GET', `/api/clubs/${C()}/shifts/current`)).json.shift;
  const close = await capi('POST', `/api/shifts/${S.testShift}/close`, { token: S.rec.token, club: C(), body: { actual_cash_kopecks: cur.expected_cash_kopecks } });
  assert.equal(close.status, 200, short(close));
  const z = await waitFor(async () => {
    const docs = await hostKkt(KKT_PORT, '/__emu/documents');
    return docs.length >= 3 ? docs : null;
  }, { timeoutMs: 30_000, what: 'отчёт закрытия тестовой смены на ККТ' });
  const st2 = await hostKkt(KKT_PORT, '/__emu/state');
  assert.ok(z.every((d) => d.kind === 'nonFiscal'), 'и отчёт закрытия — нефискальный');
  const au = await clubAudit(db, C(), { actions: ['kkt.shift_close', 'kkt.shift_open'] });
  const { rows: ops } = await db.query("select kind, status, is_test, kkt_job->'last_error'->>'code' as err from bl.kkt_ops where club_id = $1 and shift_id = $2", [C(), S.testShift]);
  S.testShiftOps = ops;
  t.diagnostic(`тестовых платежей ${tp[0].n} на ${tp[0].k / 100} ₽; отчёт смены: выручка ${JSON.stringify(rv).slice(0, 200)}, игр ${rep.json.play.sessions}; «Сейчас» ${JSON.stringify(now.json.revenue_today_kopecks)}; /api/clubs и каталог города — клуба нет, карточек 0; сводка tick(${tomorrow10().toISOString()}) — клубу не отправлена; ожидаемые наличные смены ${cur.expected_cash_kopecks / 100} ₽ (= размен); закрытие — документы ККТ: ${z.map((d) => d.kind).join(', ')}, смена ККТ ${JSON.stringify(st2.shift?.state ?? st2.shift)}; журнал ${au.map((x) => `${x.action}${x.data?.test ? '(test)' : ''}`).join(', ') || 'нет'}; операции ККТ смены: ${ops.map((o) => `${o.kind}/${o.status}${o.err ? `/${o.err}` : ''}`).join(', ')}`);
  assert.ok(ops.every((o) => o.kind === 'close_shift' && o.status === 'done'), `закрытие тестовой смены — «ТЕСТ»-отчёт, операция done: ${JSON.stringify(ops)}`);
});

test('T27-5: исправить чек-лист — боевой магазин 800002, оферта — live, журнал, уведомление Андрею, карточка', { skip }, async (t) => {
  const put = await own('PUT', `/api/clubs/${C()}/payment-settings/live`, SHOPS.live);
  assert.equal(put.status, 200, short(put));
  assert.equal(put.json.test, false);
  assert.equal(put.json.fiscalization, true);
  const noOffer = await own('POST', `/api/clubs/${C()}/go-live`, {});
  assert.equal(noOffer.status, 409);
  assert.deepEqual(noOffer.json.failed, ['offer']);
  const t0 = new Date();
  const r = await own('POST', `/api/clubs/${C()}/go-live`, { accept_offer: true });
  assert.equal(r.status, 200, short(r));
  assert.equal(r.json.mode, 'live');
  const again = await own('POST', `/api/clubs/${C()}/go-live`, { accept_offer: true });
  assert.equal(again.status, 200);
  const au = await clubAudit(db, C(), { actions: ['club.go_live'] });
  assert.equal(au.length, 1, 'одна запись club.go_live');
  const note = await waitFor(async () => (await notificationsFor(db, ANDREY_ID, { kinds: ['platform.club_live'], since: t0 })).find((n) => n.data?.club_id === C()), { what: 'уведомление Андрею' });
  const card = await waitFor(async () => {
    const { rows } = await db.query('select id, status, club_id, city_id, slug from bl.club_public where club_id = $1', [C()]);
    return rows[0]?.status === 'platform' ? rows[0] : null;
  }, { timeoutMs: 30_000, what: 'карточка каталога связана с клубом' });
  const linked = await clubAudit(db, C(), { actions: ['club.card_linked'] });
  const tbl = (await api('GET', `/api/t/${st.tables[0].code}`)).json;
  assert.equal(tbl.club.mode, 'live', 'плашки «Тестовый режим» нет');
  const o = await onboarding();
  assert.equal(o.mode, 'live');
  assert.equal(o.steps.find((s) => s.id === 'go_live').done, true);
  const pub = await waitFor(async () => ((await api('GET', '/api/clubs')).json.some((x) => x.id === C()) ? true : null), { timeoutMs: 90_000, intervalMs: 5000, what: 'клуб в /api/clubs (кэш 60 с)' });
  const item = await waitFor(async () => (await api('GET', '/api/public/cities/ekaterinburg')).json.items.find((x) => x.club_id === C()) ?? null, {
    timeoutMs: 120_000,
    intervalMs: 5000,
    what: 'клуб в каталоге города (кэш)',
  });
  // Старые записи остаются тестовыми.
  const { rows: old } = await db.query('select count(*)::int as n from bl.sessions where club_id = $1 and not is_test', [C()]);
  assert.equal(old[0].n, 0, 'прежние сессии — is_test');
  saveState({ live: true, cardId: card.id });
  t.diagnostic(`live-магазин: test=false, fiscalization=true; без оферты — 409 ${JSON.stringify(noOffer.json)}; go-live → ${JSON.stringify(r.json)}; повтор 200; club.go_live ×1; Андрею: «${note.text}»; карточка ${card.slug} status=${card.status}, журнал ${linked.map((x) => `${x.action}:${x.data.result}`).join(', ')}; /api/t mode=live; /api/clubs — есть (${pub}); в городе: ${item ? `${item.name} ${item.status} ${item.path}` : 'НЕТ'}; небоевых сессий после live 0`);
});

test('T27-6: в live тариф и стол — только с причиной: журнал manual.* и тревога владельцу; позиция — только журнал', { skip }, async (t) => {
  const t0 = new Date();
  const cur = (await own('GET', `/api/clubs/${C()}/tariffs`)).json;
  const rules = cur.rules.map((r) => ({ kind: r.kind, days: r.days, from: r.from, to: r.to, price_per_hour_kopecks: r.price_per_hour_kopecks + 5_000, min_minutes: r.min_minutes, step_minutes: r.step_minutes }));
  const noReason = await own('PUT', `/api/clubs/${C()}/tariffs`, { rules });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.json.error, 'reason_required');
  const withReason = await own('PUT', `/api/clubs/${C()}/tariffs`, { rules, reason: 'e2e: новые цены с ноября' });
  assert.equal(withReason.status, 200, short(withReason));
  const addNo = await own('POST', `/api/clubs/${C()}/resources`, { number: 3, kind: 'snooker', plan_x: 600, plan_y: 650 });
  assert.equal(addNo.status, 400);
  assert.equal(addNo.json.error, 'reason_required');
  const add = await own('POST', `/api/clubs/${C()}/resources`, { number: 3, kind: 'snooker', plan_x: 600, plan_y: 650, reason: 'e2e: поставили снукер' });
  assert.equal(add.status, 201, short(add));
  const move = await own('PATCH', `/api/clubs/${C()}/resources/${add.json.id}`, { plan_x: 640 });
  assert.equal(move.status, 200, 'позиция — без причины');
  const offNo = await own('PATCH', `/api/clubs/${C()}/resources/${add.json.id}`, { active: false });
  assert.equal(offNo.status, 400);
  assert.equal(offNo.json.error, 'reason_required');
  const off = await own('PATCH', `/api/clubs/${C()}/resources/${add.json.id}`, { active: false, reason: 'e2e: снукер увезли' });
  assert.equal(off.status, 200, short(off));
  const shopNo = await own('PUT', `/api/clubs/${C()}/payment-settings/live`, { shop_id: SHOPS.live.shop_id });
  assert.equal(shopNo.json?.error, 'reason_required', `магазин в live без причины: ${short(shopNo)}`);
  // Тип стола (цена по типу) в live — без причины?
  const kindChange = await own('PATCH', `/api/clubs/${C()}/resources/${st.tables[1].id}`, { kind: 'snooker' });
  const kindBack = await own('PATCH', `/api/clubs/${C()}/resources/${st.tables[1].id}`, { kind: 'pool' });
  await sleep(500);
  const au = await clubAudit(db, C(), { since: t0 });
  const manual = au.filter((x) => x.action.startsWith('manual.'));
  const al = await alarmsOf(db, C(), { since: t0, type: 'manual_action' });
  const { rows: ownerRow } = await db.query("select user_id from bl.club_members where club_id = $1 and role = 'owner'", [C()]);
  const notes = await notificationsFor(db, ownerRow[0].user_id, { since: t0 });
  assert.deepEqual(manual.map((x) => x.action).sort(), ['manual.resource_add', 'manual.resource_remove', 'manual.tariff_change'].sort());
  assert.ok(manual.every((x) => x.reason && x.reason.startsWith('e2e:')), 'причина в журнале');
  const manualNotes = notes.filter((n) => n.kind === 'alarm' && /Причина: e2e:/.test(n.text));
  assert.equal(al.reduce((a, x) => a + Number(x.count ?? 1), 0), 3, 'три срабатывания тревоги manual_action');
  assert.equal(manualNotes.length, 3, `уведомление владельцу на каждое действие: ${notes.map((n) => n.kind).join(', ')}`);
  assert.ok(au.some((x) => x.action === 'resource.update' && x.data.changed?.plan_x), 'позиция — resource.update');
  t.diagnostic(`тариф без причины — 400 reason_required, с причиной — 200; стол без причины — 400, с причиной — 201; позиция — 200 без причины (resource.update); вывод без причины — 400, с причиной — 200; магазин без причины — ${shopNo.status} ${shopNo.json?.error}; журнал: ${au.map((x) => `${x.action}${x.reason ? ` «${x.reason}»` : ''}`).join(', ')}; тревоги: ${al.map((a) => `${a.level} ${a.data.action}×${a.count}`).join(', ')}; уведомления владельцу: ${manualNotes.map((n) => `«${n.text}»`).join(' | ')}; смена типа стола в live без причины: ${kindChange.status}/${kindBack.status}`);
  S.kindChange = kindChange.status;
});

test('T27-7: боевая игра (магазин 800002) и боевая смена с фискальным чеком — в отчётах; тестовые — нет', { skip }, async (t) => {
  const tb = st.tables.find((x) => x.kind === 'pyramid');
  const guest = await newGuest();
  const tbl = (await capi('GET', `/api/t/${tb.code}`, { token: guest.token })).json;
  assert.equal(tbl.club.mode, 'live');
  const q = await capi('POST', '/api/quotes', { token: guest.token, body: { resource_id: tb.id, kind: 'start', minutes: 30 } });
  assert.equal(q.status, 200, short(q));
  const pay = await capi('POST', `/api/quotes/${q.json.quote_id}/pay`, { token: guest.token, body: { method: 'card' }, idem: true });
  const pid = providerId(pay.json);
  const ep = emu(`/__emu/payments/${pid}`);
  assert.equal(ep.shop_id, SHOPS.live.shop_id, 'боевой магазин');
  const tPaid = Date.now();
  emuSucceed(pid);
  const p = await waitPaymentSession(guest.token, pay.json.payment_id);
  S.liveGame = { guest, sessionId: p.session_id };
  await waitClaimSim(PORT, tb.sim, (x) => x.state?.relay === true, { what: 'свет боевой игры' });
  const { rows: pr } = await db.query('select is_test, amount_kopecks from bl.payments where id = $1', [pay.json.payment_id]);
  assert.equal(pr[0].is_test, false);
  const { missing, cmds } = await clubCmdsWithAudit(db, C(), [tb.device_id], new Date(tPaid - 5000));
  assert.deepEqual(missing, []);
  await capi('POST', `/api/sessions/${p.session_id}/stop`, { token: guest.token, body: {} });
  await waitClaimSim(PORT, tb.sim, (x) => x.state?.relay === false, { what: 'свет погас' });
  S.liveGame = null;
  // Боевая смена: смена ККТ открывается, чек фискальный.
  const sh = await capi('POST', `/api/clubs/${C()}/shifts`, { token: S.rec.token, club: C(), body: { float_kopecks: 100_000 } });
  assert.equal(sh.status, 201, short(sh));
  const { rows: srow } = await db.query('select is_test from bl.shifts where id = $1', [sh.json.id]);
  assert.equal(srow[0].is_test, false);
  const sale = await capi('POST', '/api/pos/sales', { token: S.rec.token, club: C(), body: { items: [{ product_id: S.products['Вода e2e'], qty: 1 }], method: 'cash', received_kopecks: 20_000 }, idem: true });
  assert.ok([200, 201].includes(sale.status), short(sale));
  const saleId = sale.json.id ?? sale.json.sale_id ?? sale.json.sale?.id;
  const rc = await waitFor(async () => {
    const { rows } = await db.query('select r.is_test, r.status, r.fiscal, r.fd from bl.receipts r join bl.pos_sales s on s.receipt_id = r.id where s.id = $1', [saleId]);
    return rows[0]?.status === 'printed' ? rows[0] : null;
  }, { timeoutMs: 60_000, what: 'фискальный чек боевой продажи' });
  const docs = await hostKkt(KKT_PORT, '/__emu/documents');
  const kst = await hostKkt(KKT_PORT, '/__emu/state');
  assert.equal(rc.is_test, false);
  assert.ok(rc.fd, 'у боевого чека есть ФД');
  assert.ok(docs.some((d) => d.fd), 'фискальный документ есть');
  const rep = (await own('GET', `/api/shifts/${sh.json.id}/report?online=0`)).json;
  const now = (await own('GET', `/api/clubs/${C()}/now`)).json;
  const cur = (await own('GET', `/api/clubs/${C()}/shifts/current`)).json.shift;
  const close = await capi('POST', `/api/shifts/${sh.json.id}/close`, { token: S.rec.token, club: C(), body: { actual_cash_kopecks: cur.expected_cash_kopecks } });
  assert.equal(close.status, 200, short(close));
  const sum = await summaryAt(tomorrow10());
  assert.equal(sum.sent.length, 1, 'клубу в live сводка уходит');
  const d = sum.data;
  const liveRevenue = Number(pr[0].amount_kopecks) + 12_000;
  assert.equal(d.play.sessions, 1, `в сводке только боевая игра: ${JSON.stringify(d.play)}`);
  assert.equal(d.revenue.total_kopecks, liveRevenue, `выручка сводки = боевая игра + боевая продажа: ${JSON.stringify(d.revenue)}`);
  t.diagnostic(`боевая игра: магазин ${ep.shop_id}, платёж is_test=false ${pr[0].amount_kopecks / 100} ₽, команды ${cmds.map((c) => c.type).join(', ')} — все с device.cmd; смена is_test=false, чек ${rc.status} ФД ${rc.fd}; ККТ: смена ${JSON.stringify(kst.shift?.state ?? kst.shift)}, документов ${docs.length} (${docs.map((x) => (x.fd ? `ФД${x.fd}` : x.kind)).join(', ')}); отчёт боевой смены: выручка ${JSON.stringify(rep.revenue).slice(0, 220)}; «Сейчас» ${JSON.stringify(now.revenue_today_kopecks)}; сводка: выручка ${d.revenue.total_kopecks / 100} ₽ (ожидали ${liveRevenue / 100}), игр ${d.play.sessions}`);
});
