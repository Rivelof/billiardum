// T30 «Доступ» (docs/contracts/m5-2.md §6, §7, §8; №166, №171, №173–179).
//
//   * ресепшн и бар — 403 на дашборд (все вкладки, «сейчас», CSV), истории и их CSV, ведомость, список
//     смен и CSV, кассу управляющего (чтение, запись, сторно, статьи, CSV), «Кто играл», телефон гостя,
//     «Все мои клубы»;
//   * владелец чужого клуба — 403/404 по пути клуба сида, по объектам клуба сида под своим клубом и через
//     club=all (там только его клуб);
//   * владелец двух клубов (сид + клуб сценария M5.3) — «Все мои клубы» = сумма двух, CSV с колонкой «Клуб»,
//     owner.export в цепочке каждого клуба;
//   * управляющий двух клубов — видит оба, экспорта дашборда нет (истории и смены — можно), статьи — нет;
//   * полный телефон гостя — только владельцу с причиной; журнал guest.lookup без номера; уведомление;
//   * период 367 суток — 400 (366 — 200), прочие кривые параметры — 400;
//   * в ответах и CSV дашборда, историй, «Кто играл» нет телефонов и имён гостей.
// Нужен клуб сценария M5.3 (tests/e2e/m5-3/01, состояние E2E_M53_DIR) — иначе проверки «двух клубов» пропускаются.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  apiRaw,
  capi,
  CLUB_A,
  dash,
  fullPhones,
  get,
  guestPhone,
  loginWait,
  notificationsFor,
  parseCsv,
  short,
  sleep,
  tv,
  workingDay,
} from './helpers.mjs';

const M53 = (() => {
  try {
    return JSON.parse(readFileSync(path.join(process.env.E2E_M53_DIR || path.join(os.tmpdir(), 'bl-e2e-m53'), 'state.json'), 'utf8'));
  } catch {
    return {};
  }
})();
const CLUB_B = M53.live ? M53.club : null;
const S = {};
let db;
const today = workingDay();
const from = '2026-10-22';

before(async () => {
  db = await adminClient();
  S.owner = await loginWait('+70000000001');
  S.man = await loginWait('+70000000003');
  S.rec = await loginWait('+70000000004');
  const bar = await db.query("select m.active from bl.club_members m join bl.users u on u.id = m.user_id where u.phone = '+70000000005' and m.club_id = $1 and m.role = 'bar'", [CLUB_A]);
  if (bar.rows[0]?.active) S.bar = await loginWait('+70000000005');
  // Чужой владелец: новый пользователь со своим клубом (в test).
  S.otherPhone = `+7998${String(Date.now() % 10_000_000).padStart(7, '0')}`;
  S.other = await loginWait(S.otherPhone);
  const c = await capi('POST', '/api/clubs', { token: S.other.token, body: { name: `E2E M5.2 Чужой ${Date.now() % 100000}`, city_name: 'Екатеринбург', timezone: 'Asia/Yekaterinburg' } });
  assert.equal(c.status, 201, short(c));
  S.otherClub = c.json.club_id;
  S.session = (
    await db.query(
      "select s.id, s.resource_id from bl.sessions s where s.club_id = $1 and s.source = 'qr' and s.payer_user_id is not null and not s.is_test and s.status <> 'cancelled' order by s.started_at desc limit 1",
      [CLUB_A],
    )
  ).rows[0];
  S.cashEntry = (await db.query("select id from bl.cashbook_entries where club_id = $1 order by created_at limit 1", [CLUB_A]).catch(() => ({ rows: [] }))).rows[0]?.id ?? '00000000-0000-4000-8000-000000000000';
  S.cat = (await db.query("select id from bl.cashbook_categories where club_id = $1 limit 1", [CLUB_A]).catch(() => ({ rows: [] }))).rows[0]?.id ?? '00000000-0000-4000-8000-000000000000';
});

after(async () => db?.end());

/** Адреса M5.2 клуба club (GET и изменяющие). */
function urls(club, { resourceId, sessionId, entryId, catId }) {
  const q = `from=${from}&to=${today}`;
  return [
    ['GET', `/api/clubs/${club}/dashboard?${q}&tab=summary`],
    ['GET', `/api/clubs/${club}/dashboard?${q}&tab=money`],
    ['GET', `/api/clubs/${club}/dashboard?${q}&tab=hall`],
    ['GET', `/api/clubs/${club}/dashboard?${q}&tab=guests`],
    ['GET', `/api/clubs/${club}/dashboard?${q}&tab=control`],
    ['GET', `/api/clubs/${club}/dashboard/now`],
    ['GET', `/api/clubs/${club}/dashboard/export.csv?${q}&table=revenue_daily`],
    ['GET', `/api/clubs/${club}/history/orders?${q}`],
    ['GET', `/api/clubs/${club}/history/audits?${q}`],
    ['GET', `/api/clubs/${club}/history/writeoffs?${q}`],
    ['GET', `/api/clubs/${club}/history/arrivals?${q}`],
    ['GET', `/api/clubs/${club}/history/orders/export.csv?${q}`],
    ['GET', `/api/clubs/${club}/stock/sheet`],
    ['GET', `/api/clubs/${club}/shifts?${q}`],
    ['GET', `/api/clubs/${club}/shifts/export.csv?${q}`],
    ['GET', `/api/clubs/${club}/cashbook?${q}`],
    ['GET', `/api/clubs/${club}/cashbook/categories`],
    ['GET', `/api/clubs/${club}/cashbook/export.csv?${q}`],
    ['POST', `/api/clubs/${club}/cashbook`, { kind: 'expense', amount_kopecks: 100, category_id: catId, comment: 'e2e T30' }],
    ['POST', `/api/clubs/${club}/cashbook/${entryId}/storno`, { reason: 'e2e T30' }],
    ['POST', `/api/clubs/${club}/cashbook/categories`, { kind: 'expense', name: 'e2e T30' }],
    ['GET', `/api/clubs/${club}/resources/${resourceId}/sessions?${q}`],
    ['POST', `/api/clubs/${club}/sessions/${sessionId}/guest-phone`, { reason: 'e2e T30' }],
    ['GET', `/api/clubs/${club}/subscription`],
  ];
}

async function call(token, [method, p, body], club) {
  for (let i = 0; ; i += 1) {
    const r = await api(method, p, { token, body, idem: method === 'POST' ? true : undefined, headers: club ? { 'x-club-id': club } : {}, timeoutMs: 60_000 });
    if (r.status === 429 && i < 5) {
      await sleep(15_000);
      continue;
    }
    return r;
  }
}

test('T30: ресепшн и бар — 403 на дашборд, истории, ведомость, список смен, кассу управляющего, «Кто играл», телефон гостя', { timeout: 10 * 60_000 }, async (t) => {
  const list = urls(CLUB_A, { resourceId: S.session.resource_id, sessionId: S.session.id, entryId: S.cashEntry, catId: S.cat });
  const out = [];
  for (const [who, tok] of [['ресепшн', S.rec?.token], ['бар', S.bar?.token]]) {
    if (!tok) {
      out.push(`${who}: нет пользователя — пропуск`);
      continue;
    }
    const bad = [];
    for (const u of list) {
      const r = await call(tok, u, CLUB_A);
      if (r.status !== 403) bad.push(`${u[0]} ${u[1].replace(CLUB_A, '{A}')} → ${r.status}`);
    }
    const all = await call(tok, ['GET', `/api/clubs/all/dashboard?from=${from}&to=${today}`]);
    const allH = await call(tok, ['GET', `/api/clubs/all/history/orders?from=${from}&to=${today}`]);
    if (all.status !== 403) bad.push(`all/dashboard → ${all.status}`);
    if (allH.status !== 403) bad.push(`all/history → ${allH.status}`);
    assert.deepEqual(bad, [], `${who}: всё 403`);
    out.push(`${who}: ${list.length + 2} адресов — 403`);
  }
  t.diagnostic(out.join('; '));
});

test('T30: владелец чужого клуба — 403/404 по клубу сида, его объектам и через club=all', { timeout: 10 * 60_000 }, async (t) => {
  const tok = S.other.token;
  const list = urls(CLUB_A, { resourceId: S.session.resource_id, sessionId: S.session.id, entryId: S.cashEntry, catId: S.cat });
  const bad = [];
  const seen = new Set();
  for (const u of list) {
    for (const hdr of [CLUB_A, S.otherClub, null]) {
      const r = await call(tok, u, hdr);
      seen.add(r.status);
      if (![403, 404].includes(r.status)) bad.push(`${u[0]} ${u[1].replace(CLUB_A, '{A}')} [x-club-id ${hdr === CLUB_A ? 'A' : hdr ? 'свой' : 'нет'}] → ${r.status} ${r.text.slice(0, 80)}`);
    }
  }
  // Объекты клуба сида под путём своего клуба (IDOR): стол и игра сида — 404/403.
  const idor = [
    ['GET', `/api/clubs/${S.otherClub}/resources/${S.session.resource_id}/sessions?from=${from}&to=${today}`],
    ['POST', `/api/clubs/${S.otherClub}/sessions/${S.session.id}/guest-phone`, { reason: 'e2e T30 IDOR' }],
    ['POST', `/api/clubs/${S.otherClub}/cashbook/${S.cashEntry}/storno`, { reason: 'e2e T30 IDOR' }],
  ];
  for (const u of idor) {
    const r = await call(tok, u, S.otherClub);
    if (![403, 404].includes(r.status)) bad.push(`IDOR ${u[0]} ${u[1]} → ${r.status} ${r.text.slice(0, 80)}`);
  }
  // club=all — только свой клуб.
  const all = await call(tok, ['GET', `/api/clubs/all/dashboard?from=${from}&to=${today}`]);
  assert.equal(all.status, 200, all.text);
  assert.deepEqual(all.json.tables.clubs.map((c) => c.club_id), [S.otherClub], 'в «Все мои клубы» — только свой');
  assert.equal(tv(all.json, 'revenue'), 0);
  const allH = await call(tok, ['GET', `/api/clubs/all/history/orders?from=${from}&to=${today}`]);
  assert.equal(allH.status, 200);
  assert.ok(allH.json.items.every((i) => i.club_id === S.otherClub), 'история «все клубы» — только свой');
  const allCsv = await apiRaw('GET', `/api/clubs/all/dashboard/export.csv?from=${from}&to=${today}&table=revenue_daily`, { token: tok });
  assert.equal(allCsv.status, 200);
  assert.doesNotMatch(allCsv.buf.toString(), /Тестовый клуб/, 'в CSV «все клубы» нет клуба сида');
  // Не UUID — 404.
  const nu = await call(tok, ['GET', `/api/clubs/not-a-uuid/dashboard`]);
  assert.equal(nu.status, 404);
  assert.deepEqual(bad, [], 'чужой клуб — только 403/404');
  t.diagnostic(`${list.length} адресов × 3 варианта заголовка: статусы ${[...seen].sort().join(', ')}; IDOR ×${idor.length} — 403/404; club=all → только свой клуб (${all.json.tables.clubs.length}); не UUID — 404`);
});

test('T30: владелец двух клубов — «Все мои клубы» = сумма двух; CSV с колонкой «Клуб»; owner.export в обеих цепочках', { skip: CLUB_B ? false : 'нет клуба M5.3 (tests/e2e/m5-3/01)', timeout: 5 * 60_000 }, async (t) => {
  const q = { from, to: today };
  for (const tab of ['summary', 'money', 'hall', 'control']) {
    const all = await dash(S.owner.token, 'all', { ...q, tab });
    assert.equal(all.status, 200, all.text);
    const a = await dash(S.owner.token, CLUB_A, { ...q, tab });
    const b = await get(`/api/clubs/${CLUB_B}/dashboard?from=${q.from}&to=${q.to}&tab=${tab}`, S.owner.token, { 'x-club-id': CLUB_B });
    assert.equal(b.status, 200, b.text);
    assert.deepEqual(all.json.tables.clubs.map((c) => c.club_id).sort(), [CLUB_A, CLUB_B].sort(), 'два клуба');
    for (const id of ['revenue', 'revenue_total', 'refunds', 'games', 'manual_actions', 'alarms', 'expenses']) {
      if (tv(all.json, id) === null) continue;
      assert.equal(tv(all.json, id), tv(a.json, id) + tv(b.json, id), `${tab}/${id}: сумма двух`);
    }
    if (tab === 'summary') S.sum = { all: tv(all.json, 'revenue'), a: tv(a.json, 'revenue'), b: tv(b.json, 'revenue'), games: [tv(a.json, 'games'), tv(b.json, 'games')] };
  }
  assert.ok(S.sum.b > 0, 'у второго клуба есть выручка (игра гостя M5.3)');
  const since = new Date();
  const csv = await apiRaw('GET', `/api/clubs/all/dashboard/export.csv?from=${from}&to=${today}&table=revenue_daily`, { token: S.owner.token });
  assert.equal(csv.status, 200);
  const rows = parseCsv(csv.buf);
  assert.equal(rows[0][0], 'Клуб');
  const names = new Set(rows.slice(1).map((r) => r[0]));
  assert.equal(names.size, 2, 'строки обоих клубов');
  const au = await db.query("select club_id from bl.audit_log where action = 'owner.export' and created_at >= $1 and data->>'all' = 'true'", [since]);
  assert.deepEqual([...new Set(au.rows.map((r) => r.club_id))].sort(), [CLUB_A, CLUB_B].sort(), 'owner.export в цепочке каждого клуба');
  t.diagnostic(`выручка: все ${S.sum.all} = ${S.sum.a} + ${S.sum.b}; игр ${S.sum.games.join(' + ')}; CSV: ${[...names].join(' | ')}`);
});

test('T30: управляющий двух клубов — видит свои, экспорта дашборда нет; истории и смены — можно; статьи — нет', { skip: CLUB_B ? false : 'нет клуба M5.3', timeout: 5 * 60_000 }, async (t) => {
  const all = await dash(S.man.token, 'all', { from, to: today, tab: 'summary' });
  assert.equal(all.status, 200, all.text);
  assert.deepEqual(all.json.tables.clubs.map((c) => c.club_id).sort(), [CLUB_A, CLUB_B].sort());
  const ex = await apiRaw('GET', `/api/clubs/${CLUB_A}/dashboard/export.csv?from=${from}&to=${today}&table=revenue_daily`, { token: S.man.token, headers: { 'x-club-id': CLUB_A } });
  const exAll = await apiRaw('GET', `/api/clubs/all/dashboard/export.csv?from=${from}&to=${today}&table=revenue_daily`, { token: S.man.token });
  const exB = await apiRaw('GET', `/api/clubs/${CLUB_B}/dashboard/export.csv?from=${from}&to=${today}&table=tables`, { token: S.man.token, headers: { 'x-club-id': CLUB_B } });
  assert.equal(ex.status, 403, 'экспорт дашборда — только владелец');
  assert.equal(exAll.status, 403, 'экспорт «все клубы» — только владелец');
  assert.equal(exB.status, 403);
  const hx = await apiRaw('GET', `/api/clubs/${CLUB_A}/history/orders/export.csv?from=${from}&to=${today}`, { token: S.man.token, headers: { 'x-club-id': CLUB_A } });
  assert.equal(hx.status, 200, 'CSV истории — управляющему можно (§7)');
  const sx = await apiRaw('GET', `/api/clubs/${CLUB_A}/shifts/export.csv?from=${from}&to=${today}`, { token: S.man.token, headers: { 'x-club-id': CLUB_A } });
  assert.equal(sx.status, 200);
  const cat = await call(S.man.token, ['POST', `/api/clubs/${CLUB_A}/cashbook/categories`, { kind: 'expense', name: 'e2e T30 управляющий' }], CLUB_A);
  assert.equal(cat.status, 403, 'справочник статей — только владелец');
  const phone = await call(S.man.token, ['POST', `/api/clubs/${CLUB_A}/sessions/${S.session.id}/guest-phone`, { reason: 'e2e T30' }], CLUB_A);
  assert.equal(phone.status, 403, 'полный телефон — только владелец');
  const who = await call(S.man.token, ['GET', `/api/clubs/${CLUB_A}/resources/${S.session.resource_id}/sessions?from=${from}&to=${today}`], CLUB_A);
  assert.equal(who.status, 200, '«Кто играл» — управляющему можно');
  t.diagnostic(`all: ${all.json.tables.clubs.map((c) => c.name).join(', ')}; экспорт дашборда ${ex.status}/${exAll.status}/${exB.status}; CSV истории ${hx.status}, смен ${sx.status}; статья ${cat.status}; телефон ${phone.status}; «Кто играл» ${who.status}`);
});

test('T30: полный телефон гостя — только владельцу с причиной; guest.lookup без номера; уведомление; no-store', async (t) => {
  const p = `/api/clubs/${CLUB_A}/sessions/${S.session.id}/guest-phone`;
  const noReason = await call(S.owner.token, ['POST', p, {}], CLUB_A);
  assert.equal(noReason.status, 400);
  assert.equal(noReason.json.error, 'reason_required');
  const since = new Date();
  const r = await call(S.owner.token, ['POST', p, { reason: 'Гость забыл кий, нужно связаться (тест e2e)' }], CLUB_A);
  assert.equal(r.status, 200, r.text);
  const payer = (await db.query('select u.phone from bl.sessions s join bl.users u on u.id = s.payer_user_id where s.id = $1', [S.session.id])).rows[0].phone;
  assert.equal(r.json.phone, payer, 'номер плательщика игры');
  assert.match(String(r.headers['cache-control'] ?? ''), /no-store/, 'ответ не кэшируется');
  const au = (await db.query("select reason, actor_id, data from bl.audit_log where club_id = $1 and action = 'guest.lookup' and created_at >= $2", [CLUB_A, since])).rows;
  assert.equal(au.length, 1);
  assert.ok(au[0].reason.includes('забыл кий'));
  assert.doesNotMatch(JSON.stringify(au[0]), new RegExp(payer.slice(-7)), 'в журнале нет номера');
  const n = await (async () => {
    for (let i = 0; i < 20; i += 1) {
      const x = (await notificationsFor(db, 'a1000000-0000-4000-8000-000000000001', { since })).filter((y) => /телефон гостя/i.test(y.text));
      if (x.length) return x;
      await sleep(500);
    }
    return [];
  })();
  assert.equal(n.length, 1, 'уведомление владельцу');
  assert.doesNotMatch(n[0].text, new RegExp(payer.slice(-7)), 'в уведомлении нет номера');
  // Повторный просмотр той же игры — снова журнал и уведомление (как у ручного действия).
  const since2 = new Date();
  const r2 = await call(S.owner.token, ['POST', p, { reason: 'Повторный звонок гостю (тест e2e)' }], CLUB_A);
  assert.equal(r2.status, 200);
  const au2 = (await db.query("select 1 from bl.audit_log where club_id = $1 and action = 'guest.lookup' and created_at >= $2", [CLUB_A, since2])).rowCount;
  await sleep(3000);
  const n2 = (await notificationsFor(db, 'a1000000-0000-4000-8000-000000000001', { since: since2 })).filter((y) => /телефон гостя/i.test(y.text));
  S.lookupRepeat = { audit: au2, notify: n2.length };
  assert.equal(au2, 1, 'повтор — журнал');
  t.diagnostic(`без причины ${JSON.stringify(noReason.json)}; телефон = плательщик, cache-control «${r.headers['cache-control']}»; журнал guest.lookup «${au[0].reason}» без номера; уведомление: «${n[0].text.replace(/\+7\d{10}/g, '+7***')}»; повтор той же игры: журнал ${au2}, уведомлений ${n2.length}`);
  if (n2.length !== 1) t.diagnostic('НАБЛЮДЕНИЕ: повторный просмотр телефона той же игры — без нового уведомления владельцу (dedupeKey guest.lookup:{session})');
});

test('T30: период 367 суток — 400, 366 — 200; кривые параметры — 400', async (t) => {
  const bad = [
    ['2025-10-23', '2026-10-24'],
    ['2026-10-24', '2026-10-22'],
    ['2026-13-01', '2026-13-02'],
    ['вчера', 'сегодня'],
  ];
  const codes = [];
  for (const [f, to] of bad) {
    const r = await get(`/api/clubs/${CLUB_A}/dashboard?from=${encodeURIComponent(f)}&to=${encodeURIComponent(to)}`, S.owner.token);
    codes.push(`${f}…${to}: ${r.status} ${r.text}`);
    assert.equal(r.status, 400, `${f}…${to}`);
    assert.deepEqual(r.json, { error: 'bad_request' }, 'наружу — только код');
  }
  for (const qs of ['tab=money2', 'kind=billiard_carom', 'compare=2']) {
    const r = await get(`/api/clubs/${CLUB_A}/dashboard?from=${from}&to=${today}&${qs}`, S.owner.token);
    assert.equal(r.status, 400, qs);
  }
  const csv367 = await apiRaw('GET', `/api/clubs/${CLUB_A}/dashboard/export.csv?from=2025-10-23&to=2026-10-24&table=revenue_daily`, { token: S.owner.token, headers: { 'x-club-id': CLUB_A } });
  assert.equal(csv367.status, 400, 'CSV 367 суток — 400');
  const h367 = await get(`/api/clubs/${CLUB_A}/history/orders?from=2025-10-23&to=2026-10-24`, S.owner.token);
  const w367 = await get(`/api/clubs/${CLUB_A}/resources/${S.session.resource_id}/sessions?from=2025-10-23&to=2026-10-24`, S.owner.token);
  const c367 = await get(`/api/clubs/${CLUB_A}/cashbook?from=2025-10-23&to=2026-10-24`, S.owner.token);
  const t0 = Date.now();
  const ok366 = await get(`/api/clubs/${CLUB_A}/dashboard?from=2025-10-24&to=2026-10-24&tab=summary`, S.owner.token);
  const ms = Date.now() - t0;
  assert.equal(ok366.status, 200);
  assert.equal(ok366.json.period.days, 366);
  t.diagnostic(`${codes.join('; ')}; CSV 367 — ${csv367.status}; история 367 — ${h367.status}; «Кто играл» 367 — ${w367.status}; касса 367 — ${c367.status}; 366 суток — 200 за ${ms} мс`);
  assert.equal(w367.status, 400, '«Кто играл» 367 — 400');
  assert.ok([400].includes(h367.status), `история 367 суток — ${h367.status}`);
});

test('T30: в ответах и CSV дашборда, историй, «Кто играл» нет телефонов и имён гостей', { timeout: 10 * 60_000 }, async (t) => {
  // Имена гостей: у синтетических гостей имён нет, кроме броней по телефону («Гость e2e …»).
  const guestNames = (await db.query("select distinct guest_name as name from bl.bookings where club_id = $1 and guest_name is not null", [CLUB_A]).catch(() => ({ rows: [] }))).rows.map((r) => r.name).filter((n) => n && n.length > 3);
  const seen = [];
  const check = (label, text) => {
    const ph = fullPhones(text);
    assert.deepEqual(ph.map((x) => x.replace(/\d{7}$/, '*******')), [], `${label}: нет полных телефонов`);
    for (const n of guestNames) assert.ok(!text.includes(n), `${label}: нет имени гостя «${n}»`);
    seen.push(label);
  };
  for (const tab of ['summary', 'money', 'hall', 'guests', 'control']) {
    const r = await dash(S.owner.token, CLUB_A, { from, to: today, tab });
    check(`dashboard/${tab}`, r.text);
  }
  check('dashboard/now', (await get(`/api/clubs/${CLUB_A}/dashboard/now`, S.owner.token)).text);
  for (const table of ['revenue_daily', 'tables', 'hourly', 'manual', 'shifts', 'bookings']) {
    const r = await apiRaw('GET', `/api/clubs/${CLUB_A}/dashboard/export.csv?from=${from}&to=${today}&table=${table}`, { token: S.owner.token, headers: { 'x-club-id': CLUB_A } });
    assert.equal(r.status, 200, table);
    check(`csv/${table}`, r.buf.toString('utf8'));
  }
  for (const kind of ['orders', 'audits', 'writeoffs', 'arrivals']) {
    const r = await get(`/api/clubs/${CLUB_A}/history/${kind}?from=${from}&to=${today}&limit=200`, S.owner.token);
    assert.equal(r.status, 200, kind);
    check(`history/${kind}`, r.text);
    const c = await apiRaw('GET', `/api/clubs/${CLUB_A}/history/${kind}/export.csv?from=${from}&to=${today}`, { token: S.owner.token, headers: { 'x-club-id': CLUB_A } });
    assert.equal(c.status, 200);
    check(`history/${kind}.csv`, c.buf.toString('utf8'));
    if (kind === 'orders') {
      const guests = r.json.items.map((i) => i.guest).filter(Boolean);
      assert.ok(guests.every((g) => g.nick || /^\+7\d{3}\*{3}\d{4}$/.test(g.phone_masked ?? '')), 'гость — ник или маска +7999***4567');
      S.orderGuests = guests.length;
    }
  }
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const rid = `e1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const r = await get(`/api/clubs/${CLUB_A}/resources/${rid}/sessions?from=${from}&to=${today}`, S.owner.token);
    assert.equal(r.status, 200);
    check(`who-played/${n}`, r.text);
    assert.ok(r.json.items.every((i) => i.guest === null || i.guest.nick || /^\+7\d{3}\*{3}\d{4}$/.test(i.guest.phone_masked ?? '')), `стол ${n}: гость — ник или маска`);
  }
  check('shifts', (await get(`/api/clubs/${CLUB_A}/shifts?from=${from}&to=${today}`, S.owner.token)).text);
  check('cashbook', (await get(`/api/clubs/${CLUB_A}/cashbook?from=${from}&to=${today}`, S.owner.token)).text);
  t.diagnostic(`проверено ${seen.length} ответов и файлов; имён гостей в базе броней: ${guestNames.length}; гостей в истории заказов: ${S.orderGuests}`);
});

export { guestPhone };
