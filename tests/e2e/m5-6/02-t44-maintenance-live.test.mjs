// T44 «Обслуживание столов» вживую на стенде (решения №198, 206–211), на СВОЁМ клубе (test,
// 2 стола + 1 корт, управляющий и ресепшн по приглашению). Только API, без базы стенда.
// Касса управляющего не показывает записи is_test (№153), а свой клуб без контроллеров в live не
// перевести, — поэтому видимость расхода в кассе (T44-10) проверяется на клубе сида, стол 6, одним
// событием «сегодня» с исправлением без стоимости и затем «не было»: итог кассы сида не меняется
// (расход + сторно), счётчик стола 6 возвращается к «с начала учёта».
//
//   * событие со стоимостью → расход «Ремонт столов» в кассе управляющего, ссылка maintenance_event_id,
//     журнал maintenance.event + cashbook.entry;
//   * исправление — новая запись с причиной (без причины — reason_required): с явной стоимостью
//     replaced (сторно + новый расход), без стоимости — kept (касса не меняется), повтор — 409,
//     «не было» — reversed; после ручного сторно — none;
//   * проверки даты/вида/стоимости; событие на корте — 400; ресепшн — 403; чужой клуб — 403/404;
//   * пороги: GET/PUT, границы, смена управляющим (уведомление владельцу проверяется на своём
//     Postgres в 01 — на стенде у tester нет доступа к уведомлениям);
//   * счётчик без игр — 0 ч, since null; «Столы» дашборда — cloth_*; у корта cloth_* = null.
// Порог → уведомление (и лимит 5 в сутки) на стенде не проверить: новые столы tester без контроллеров
// не играют, а клуб сида не трогаем, — это 01 на своём Postgres.

import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { addDays, api, apiWait, CLUB_SEED, invite, loadState, login, newClub, saveState, SEED_PHONES, short, workingDay } from './lib.mjs';

const S = {};
const today = workingDay();

const post = (who, body) => api('POST', `/api/clubs/${S.club}/maintenance`, { token: S[who].token, club: S.club, body, idem: true });
const view = async (who = 'owner') => (await apiWait('GET', `/api/clubs/${S.club}/maintenance`, { token: S[who].token, club: S.club })).json;
const cashbook = async (from = addDays(today, -40)) => (await apiWait('GET', `/api/clubs/${S.club}/cashbook?from=${from}&to=${today}`, { token: S.manager.token, club: S.club })).json;
const audit = async (action) => (await apiWait('GET', `/api/clubs/${S.club}/audit?action=${encodeURIComponent(action)}&limit=200`, { token: S.owner.token, club: S.club })).json?.items ?? [];

before(async () => {
  const c = await newClub({ name: `E2E M5.6 Обслуживание ${Date.now() % 100000}`, tables: 2, courts: 1 });
  S.club = c.club;
  S.owner = c.owner;
  S.t1 = c.resources.find((r) => r.number === 1 && r.kind !== 'padel_court');
  S.t2 = c.resources.find((r) => r.number === 2 && r.kind !== 'padel_court');
  S.court = c.resources.find((r) => r.kind === 'padel_court');
  S.manager = await invite(S.club, S.owner.token, 'manager');
  S.reception = await invite(S.club, S.owner.token, 'reception');
  saveState({ maintClub: S.club, maintOwnerPhone: S.owner.phone, maintManagerPhone: S.manager.phone, maintReceptionPhone: S.reception.phone });
});

test('T44-1: права — ресепшн 403 на всех маршрутах; чужой владелец (клуб сида) 403; стол чужого клуба — 404', async (t) => {
  const out = [];
  for (const [m, p, body] of [
    ['GET', 'maintenance'],
    ['POST', 'maintenance', { resource_id: S.t1.id, kind: 'cloth' }],
    ['GET', 'maintenance/thresholds'],
    ['PUT', 'maintenance/thresholds', { cloth: 10 }],
    ['GET', 'forecast'],
  ]) {
    const r = await api(m, `/api/clubs/${S.club}/${p}`, { token: S.reception.token, club: S.club, body, idem: m === 'POST' });
    assert.equal(r.status, 403, `${m} ${p}: ${short(r)}`);
    assert.deepEqual(Object.keys(r.json), ['error']);
    out.push(`${m} ${p} ${r.status} ${r.json.error}`);
  }
  const seedOwner = await login(SEED_PHONES.owner);
  const foreign = await api('GET', `/api/clubs/${S.club}/maintenance`, { token: seedOwner.token, club: S.club });
  assert.equal(foreign.status, 403, short(foreign));
  // Стол клуба сида в своём клубе.
  const seedRes = await api('GET', `/api/clubs/${CLUB_SEED}/resources`, { token: seedOwner.token, club: CLUB_SEED });
  const seedT1 = seedRes.json.resources.find((r) => r.number === 1).id;
  const x = await post('manager', { resource_id: seedT1, kind: 'cloth' });
  assert.deepEqual([x.status, x.json], [404, { error: 'not_found' }]);
  // И наоборот: владелец своего клуба в клуб сида.
  const y = await api('POST', `/api/clubs/${CLUB_SEED}/maintenance`, { token: S.owner.token, club: CLUB_SEED, body: { resource_id: seedT1, kind: 'cloth' }, idem: true });
  assert.equal(y.status, 403, short(y));
  t.diagnostic(`ресепшн: ${out.join('; ')}; владелец сида в мой клуб — ${foreign.status}; стол сида в моём клубе — 404 not_found; мой владелец в клуб сида — ${y.status}`);
});

test('T44-2: без игр — счётчики 0 ч, since null, пороги по умолчанию; корт без счётчиков; «Столы» дашборда — cloth_*', async (t) => {
  const v = await view('manager');
  assert.deepEqual(v.thresholds, { cloth: 1500, balls: 3000, cushions: 5000, leveling: null, other: null });
  assert.deepEqual(v.defaults, v.thresholds);
  assert.deepEqual(v.kinds.map((k) => k.label), ['Замена сукна', 'Замена шаров', 'Замена резины бортов', 'Выравнивание', 'Другое']);
  assert.deepEqual(v.counters.map((c) => c.number), [1, 2]);
  assert.ok(v.counters.every((c) => c.type !== 'padel_court'), 'корт не в счётчиках');
  for (const c of v.counters) {
    assert.equal(c.kinds.cloth.hours, 0);
    assert.equal(c.kinds.cloth.since, null);
    assert.equal(c.kinds.cloth.due, false);
  }
  const hall = await apiWait('GET', `/api/clubs/${S.club}/dashboard?tab=hall&compare=0`, { token: S.owner.token, club: S.club });
  assert.equal(hall.status, 200, short(hall));
  // Прогноз нового клуба (test, без истории) — «мало данных».
  assert.equal(hall.json.series.forecast?.status, 'insufficient_data');
  assert.equal(hall.json.series.forecast?.label, 'прогноз');
  assert.deepEqual(hall.json.hints, []);
  // «Столы» дашборда — cloth_* = счётчики (клуб сида: 8 столов и 2 корта).
  const seedOwner = await login(SEED_PHONES.owner);
  // Период 4 суток: в «Столах» — только ресурсы с ёмкостью или играми за период (M5.2); сразу после
  // 06:00 сегодняшних суток часть столов ещё «пустая» и в таблицу не попадает (замечание в отчёте).
  const d0 = workingDay();
  const sh = await apiWait('GET', `/api/clubs/${CLUB_SEED}/dashboard?tab=hall&compare=0&from=${addDays(d0, -3)}&to=${d0}`, { token: seedOwner.token, club: CLUB_SEED });
  const shToday = await apiWait('GET', `/api/clubs/${CLUB_SEED}/dashboard?tab=hall&compare=0`, { token: seedOwner.token, club: CLUB_SEED });
  S.todayRows = shToday.json.tables.by_resource.length;
  const sm = await apiWait('GET', `/api/clubs/${CLUB_SEED}/maintenance`, { token: seedOwner.token, club: CLUB_SEED });
  const rows = sh.json.tables.by_resource;
  assert.equal(rows.length, 10, 'сид: 10 ресурсов');
  const courts = rows.filter((x) => x.type === 'padel_court');
  assert.equal(courts.length, 2);
  for (const rc of courts) assert.deepEqual([rc.cloth_hours, rc.cloth_since, rc.cloth_threshold_hours, rc.cloth_due], [null, null, null, false]);
  assert.equal(sm.json.counters.length, 8, 'счётчики — только 8 столов');
  for (const c of sm.json.counters) {
    const r = rows.find((x) => x.resource_id === c.resource_id);
    assert.deepEqual([r.cloth_hours, r.cloth_since, r.cloth_threshold_hours, r.cloth_due], [c.kinds.cloth.hours, c.kinds.cloth.since, c.kinds.cloth.threshold_hours, c.kinds.cloth.due]);
  }
  S.seedCloth = rows.filter((x) => x.type !== 'padel_court').map((x) => `${x.number}:${x.cloth_hours}`).join(' ');
  t.diagnostic(`мой клуб: ${v.counters.map((c) => `№${c.number} ${c.type} сукно ${c.kinds.cloth.hours} ч`).join(', ')}, корта нет; прогноз ${hall.json.series.forecast?.status}; сид «Столы» за 4 суток: cloth_hours = счётчики (${S.seedCloth}), корты cloth_* null; за сегодня строк ${S.todayRows} из 10`);
});

test('T44-3: событие со стоимостью — расход «Ремонт столов» в кассе управляющего, ссылка, журнал; счётчик с события', async (t) => {
  const D = addDays(today, -3);
  const r = await post('manager', { resource_id: S.t1.id, kind: 'cloth', date: D, comment: 'E2E сукно Simonis 760', cost_kopecks: 1_234_567 });
  assert.equal(r.status, 201, short(r));
  S.ev = r.json;
  assert.equal(S.ev.kind, 'cloth');
  assert.equal(S.ev.date, D);
  assert.equal(S.ev.resource_number, 1);
  assert.equal(S.ev.cost_kopecks, 1_234_567);
  assert.equal(S.ev.cashbook.action, 'created');
  assert.ok(S.ev.cashbook_entry_id);
  assert.equal(S.ev.created_by, S.manager.user.id);
  // Клуб в test: расход есть (cashbook_entry_id), но касса управляющего показывает только боевые (№153).
  const cb = await cashbook();
  assert.equal(cb.entries.find((x) => x.entry_id === S.ev.cashbook_entry_id), undefined, 'тестовый расход не в боевой кассе');
  const cat = cb.categories.filter((c) => c.name === 'Ремонт столов');
  assert.equal(cat.length, 1, 'статья «Ремонт столов» создана один раз');
  const ae = await audit('maintenance.event');
  assert.equal(ae.length, 1);
  assert.equal(ae[0].data.cashbook_entry_id, S.ev.cashbook_entry_id);
  assert.equal((await audit('cashbook.entry')).length, 1);
  // Статья «Ремонт столов» — из набора статей нового клуба или создана сервером (тогда category_create).
  assert.ok((await audit('cashbook.category_create')).length <= 1);
  const v = await view();
  const c = v.counters.find((x) => x.resource_id === S.t1.id).kinds.cloth;
  assert.deepEqual([c.since, c.event_id, c.hours], [D, S.ev.event_id, 0]);
  assert.equal(v.events[0].event_id, S.ev.event_id);
  assert.equal(v.events[0].created_by_name !== undefined, true);
  // Повтор с тем же ключом идемпотентности — тот же ответ, без второго расхода.
  const key = crypto.randomUUID();
  const a1 = await api('POST', `/api/clubs/${S.club}/maintenance`, { token: S.manager.token, club: S.club, body: { resource_id: S.t2.id, kind: 'balls', comment: 'E2E шары', cost_kopecks: 50_000 }, idem: key });
  const a2 = await api('POST', `/api/clubs/${S.club}/maintenance`, { token: S.manager.token, club: S.club, body: { resource_id: S.t2.id, kind: 'balls', comment: 'E2E шары', cost_kopecks: 50_000 }, idem: key });
  assert.equal(a1.status, 201, short(a1));
  assert.equal(a2.json?.event_id, a1.json.event_id, `повтор: ${short(a2)}`);
  S.balls = a1.json;
  assert.equal(a2.json?.cashbook_entry_id, a1.json.cashbook_entry_id, 'тот же расход');
  assert.equal((await audit('cashbook.entry')).length, 2, 'расходов два (сукно и шары), не три');
  t.diagnostic(`событие ${D} 12 345,67 ₽ → cashbook.action created, cashbook_entry_id есть; в кассе test-клуба не виден (is_test, №153); статья «Ремонт столов» создана; журнал maintenance.event, cashbook.entry, cashbook.category_create; повтор Idempotency-Key — ${a2.status}, тот же event_id и расход`);
});

test('T44-4: проверки — будущее, > 35 суток со стоимостью, > 366 без, вид, отрицательная, комментарий > 500, корт → 400', async (t) => {
  const cases = [
    ['завтра', { resource_id: S.t1.id, kind: 'cloth', date: addDays(today, 1) }],
    ['36 суток со стоимостью', { resource_id: S.t1.id, kind: 'cloth', date: addDays(today, -36), cost_kopecks: 100 }],
    ['367 суток', { resource_id: S.t1.id, kind: 'cloth', date: addDays(today, -367) }],
    ['вид chalk', { resource_id: S.t1.id, kind: 'chalk' }],
    ['стоимость −1', { resource_id: S.t1.id, kind: 'cloth', cost_kopecks: -1 }],
    ['стоимость 1.5', { resource_id: S.t1.id, kind: 'cloth', cost_kopecks: 1.5 }],
    ['комментарий 501', { resource_id: S.t1.id, kind: 'cloth', comment: 'я'.repeat(501) }],
    ['дата 2026-02-30', { resource_id: S.t1.id, kind: 'cloth', date: '2026-02-30' }],
    ['без стола', { kind: 'cloth' }],
    ['корт', { resource_id: S.court.id, kind: 'cloth' }],
    ['корт: другое', { resource_id: S.court.id, kind: 'other', cost_kopecks: 1000 }],
  ];
  const out = [];
  for (const [name, body] of cases) {
    const r = await post('owner', body);
    out.push(`${name} ${r.status}`);
    assert.deepEqual([r.status, r.json], [400, { error: 'bad_request' }], `${name}: ${short(r)}`);
  }
  // Без стоимости — можно до 366 суток назад (начальное состояние стола).
  const old = await post('owner', { resource_id: S.t2.id, kind: 'cushions', date: addDays(today, -366), comment: 'E2E исходное состояние' });
  assert.equal(old.status, 201, short(old));
  assert.equal(old.json.cashbook_entry_id, null);
  assert.equal(old.json.cashbook.action, 'none');
  const v = await view();
  assert.ok(v.counters.every((c) => c.type !== 'padel_court'));
  t.diagnostic(`${out.join('; ')}; 366 суток без стоимости — 201, касса none`);
});

test('T44-5: исправление — причина обязательна; явная стоимость → replaced; повтор → 409; «не было» → reversed', async (t) => {
  const noReason = await post('owner', { corrects_id: S.ev.event_id, cost_kopecks: 1_000_000 });
  assert.deepEqual([noReason.status, noReason.json], [400, { error: 'reason_required' }]);
  const blank = await post('owner', { corrects_id: S.ev.event_id, reason: '   ', cost_kopecks: 1_000_000 });
  assert.deepEqual([blank.status, blank.json], [400, { error: 'reason_required' }], short(blank));
  const fix = await post('owner', { corrects_id: S.ev.event_id, reason: 'E2E опечатка в сумме', cost_kopecks: 1_000_000 });
  assert.equal(fix.status, 201, short(fix));
  assert.equal(fix.json.corrects_id, S.ev.event_id);
  assert.equal(fix.json.resource_id, S.t1.id);
  assert.equal(fix.json.date, S.ev.date);
  assert.equal(fix.json.comment, S.ev.comment, 'поля по умолчанию — из исправляемого');
  assert.equal(fix.json.cashbook.action, 'replaced');
  assert.equal(fix.json.cashbook.storno_entry_ids.length, 1);
  assert.ok(fix.json.cashbook.entry_id && fix.json.cashbook_entry_id === fix.json.cashbook.entry_id, 'новый расход');
  const again = await post('owner', { corrects_id: S.ev.event_id, reason: 'E2E ещё раз' });
  assert.deepEqual([again.status, again.json], [409, { error: 'duplicate' }]);
  const ac = await audit('maintenance.correct');
  assert.equal(ac[0].reason, 'E2E опечатка в сумме');
  const v = await view();
  assert.equal(v.events.find((x) => x.event_id === S.ev.event_id).corrected_by, fix.json.event_id);
  assert.equal(v.counters.find((x) => x.resource_id === S.t1.id).kinds.cloth.event_id, fix.json.event_id);
  const vd = await post('owner', { corrects_id: fix.json.event_id, reason: 'E2E не меняли', void: true });
  assert.equal(vd.status, 201, short(vd));
  assert.equal(vd.json.voided, true);
  assert.equal(vd.json.cashbook.action, 'reversed');
  assert.equal(vd.json.cashbook.storno_entry_ids.length, 1, 'сторно нового расхода');
  assert.equal(vd.json.cost_kopecks, 0);
  assert.equal((await audit('cashbook.storno')).length, 2, 'два сторно: replaced и reversed');
  const c = (await view()).counters.find((x) => x.resource_id === S.t1.id).kinds.cloth;
  assert.deepEqual([c.event_id, c.since], [null, null], 'счётчик — с начала учёта');
  t.diagnostic(`без причины и с пустой — reason_required; replaced: сторно ${fix.json.cashbook.storno_entry_ids.length} + новый, новый расход 10 000 ₽; повтор — 409 duplicate; «не было» — reversed (сторно 1); журнал maintenance.correct с причиной`);
});

test('T44-6: исправление без стоимости — kept; после ручного сторно — none (Н-3, №210)', async (t) => {
  const n0 = (await audit('cashbook.*')).length;
  const b = await post('manager', { corrects_id: S.balls.event_id, reason: 'E2E уточнил комментарий', comment: 'E2E шары Aramith' });
  assert.equal(b.status, 201, short(b));
  assert.equal(b.json.cost_kopecks, 0, 'стоимость не переносится');
  assert.equal(b.json.cashbook_entry_id, null);
  assert.deepEqual(b.json.cashbook, { action: 'kept', entry_id: null, storno_entry_ids: [], kept_entry_id: S.balls.cashbook_entry_id });
  assert.equal((await audit('cashbook.*')).length, n0, 'касса не тронута — новых записей журнала кассы нет');
  // Ручное сторно расхода в кассе — исправление без стоимости его не возвращает.
  const st = await api('POST', `/api/clubs/${S.club}/cashbook/${S.balls.cashbook_entry_id}/storno`, { token: S.manager.token, club: S.club, body: { reason: 'E2E ошибка' }, idem: true });
  assert.equal(st.status, 201, short(st));
  const c = await post('manager', { corrects_id: b.json.event_id, reason: 'E2E ещё комментарий', comment: 'E2E Aramith Pro' });
  assert.equal(c.status, 201, short(c));
  assert.deepEqual(c.json.cashbook, { action: 'none', entry_id: null, storno_entry_ids: [], kept_entry_id: null });
  assert.equal((await audit('cashbook.*')).length, n0 + 1, 'только ручное сторно');
  t.diagnostic(`kept: kept_entry_id = исходный расход, журнал кассы без новых записей; ручное сторно 201; затем исправление — none`);
});

test('T44-7: только добавление — у API нет PATCH/DELETE события; ресепшн не исправляет', async (t) => {
  const id = S.ev.event_id;
  const out = [];
  for (const m of ['PATCH', 'DELETE', 'PUT']) {
    const r = await api(m, `/api/clubs/${S.club}/maintenance/${id}`, { token: S.owner.token, club: S.club, body: { cost_kopecks: 0 } });
    out.push(`${m} ${r.status}`);
    assert.ok([404, 405].includes(r.status), `${m}: ${short(r)}`);
  }
  const rec = await post('reception', { corrects_id: id, reason: 'E2E', void: true });
  assert.equal(rec.status, 403);
  t.diagnostic(`${out.join(', ')}; ресепшн исправить — 403`);
});

test('T44-8: пороги — GET/PUT, только переданные виды, границы 1–100 000 и null, лишний вид — 400, ресепшн — 403', async (t) => {
  const thr = (who, body) => apiWait('PUT', `/api/clubs/${S.club}/maintenance/thresholds`, { token: S[who].token, club: S.club, body });
  const r = await thr('manager', { cloth: 1000, cushions: null });
  assert.equal(r.status, 200, short(r));
  assert.deepEqual(r.json.thresholds, { cloth: 1000, balls: 3000, cushions: null, leveling: null, other: null });
  const g = await api('GET', `/api/clubs/${S.club}/maintenance/thresholds`, { token: S.owner.token, club: S.club });
  assert.deepEqual(g.json.thresholds, r.json.thresholds);
  const bad = [];
  for (const body of [{ cloth: 0 }, { cloth: 100_001 }, { cloth: 1.5 }, { cloth: '10' }, { chalk: 10 }, { cloth: -5 }]) {
    const x = await thr('owner', body);
    bad.push(`${JSON.stringify(body)} ${x.status}`);
    assert.deepEqual([x.status, x.json], [400, { error: 'bad_request' }], JSON.stringify(body));
  }
  assert.equal((await thr('owner', { cloth: 100_000, balls: 1 })).status, 200);
  assert.equal((await thr('reception', { cloth: 5 })).status, 403);
  const au = await audit('maintenance.thresholds_update');
  assert.ok(au.length >= 2);
  const first = au.at(-1);
  assert.equal(first.data.before.cloth, 1500);
  assert.equal(first.data.after.cloth, 1000);
  // Вернуть по умолчанию.
  assert.equal((await thr('owner', { cloth: 1500, balls: 3000, cushions: 5000 })).status, 200);
  t.diagnostic(`управляющий: сукно 1 000, резина без порога — 200, остальные без изменений; ${bad.join('; ')}; 100 000 и 1 — 200; ресепшн 403; журнал thresholds_update {before, after}`);
});

test('T44-9: ответы без лишнего — в событиях нет телефонов; ошибки только кодом', async () => {
  const v = await apiWait('GET', `/api/clubs/${S.club}/maintenance?limit=200`, { token: S.owner.token, club: S.club });
  assert.equal(v.status, 200);
  assert.doesNotMatch(v.text, /\+?799\d{8}/, 'нет телефонов');
  const l = await api('GET', `/api/clubs/${S.club}/maintenance?limit=201`, { token: S.owner.token, club: S.club });
  assert.deepEqual([l.status, l.json], [400, { error: 'bad_request' }]);
  const k = await api('GET', `/api/clubs/${S.club}/maintenance?resource_id=xyz`, { token: S.owner.token, club: S.club });
  assert.deepEqual([k.status, k.json], [400, { error: 'bad_request' }]);
});

test('T44-10: клуб сида (live), стол 6 — расход в кассе управляющего со ссылкой; исправление без стоимости касса не меняет; «не было» — сторно, итог 0', async (t) => {
  const owner = await login(SEED_PHONES.owner);
  const manager = await login(SEED_PHONES.manager);
  const res = await api('GET', `/api/clubs/${CLUB_SEED}/resources`, { token: owner.token, club: CLUB_SEED });
  const t6 = res.json.resources.find((r) => r.number === 6 && r.kind !== 'padel_court');
  const day = workingDay();
  const cb = async () => (await apiWait('GET', `/api/clubs/${CLUB_SEED}/cashbook?from=${day}&to=${day}`, { token: manager.token, club: CLUB_SEED })).json;
  const before = await cb();
  const c0 = (await apiWait('GET', `/api/clubs/${CLUB_SEED}/maintenance?resource_id=${t6.id}`, { token: manager.token, club: CLUB_SEED })).json.counters.find((x) => x.resource_id === t6.id).kinds.cloth;
  const p = (body) => api('POST', `/api/clubs/${CLUB_SEED}/maintenance`, { token: manager.token, club: CLUB_SEED, body, idem: true });
  const ev = await p({ resource_id: t6.id, kind: 'cloth', comment: 'E2E M5.6 проверка кассы', cost_kopecks: 432_100 });
  assert.equal(ev.status, 201, short(ev));
  saveState({ seedEvent: ev.json.event_id });
  let last = ev.json.event_id;
  try {
    assert.equal(ev.json.date, day, 'событие — сегодняшние рабочие сутки');
    const a = await cb();
    const e = a.entries.find((x) => x.entry_id === ev.json.cashbook_entry_id);
    assert.ok(e, 'расход виден в кассе управляющего');
    assert.deepEqual([e.kind, e.amount_kopecks, e.category, e.maintenance_event_id, e.date], ['expense', 432_100, 'Ремонт столов', ev.json.event_id, day]);
    assert.equal(a.expenses_kopecks - before.expenses_kopecks, 432_100);
    assert.equal(a.closing_kopecks - before.closing_kopecks, -432_100);
    const c1 = (await apiWait('GET', `/api/clubs/${CLUB_SEED}/maintenance?resource_id=${t6.id}`, { token: manager.token, club: CLUB_SEED })).json.counters.find((x) => x.resource_id === t6.id).kinds.cloth;
    assert.equal(c1.event_id, ev.json.event_id);
    assert.equal(c1.since, day);
    assert.ok(c1.minutes <= c0.minutes, `счётчик с момента отметки: ${c0.minutes} → ${c1.minutes}`);
    const kept = await p({ corrects_id: ev.json.event_id, reason: 'E2E уточнил комментарий', comment: 'E2E M5.6 комментарий' });
    assert.equal(kept.status, 201, short(kept));
    last = kept.json.event_id;
    assert.equal(kept.json.cashbook.action, 'kept');
    const b = await cb();
    assert.equal(b.entries.length, a.entries.length, 'касса не изменилась');
    assert.equal(b.closing_kopecks, a.closing_kopecks);
    const vd = await p({ corrects_id: kept.json.event_id, reason: 'E2E M5.6 события не было', void: true });
    assert.equal(vd.status, 201, short(vd));
    assert.equal(vd.json.cashbook.action, 'reversed');
    last = null;
    saveState({ seedEvent: null });
    const z = await cb();
    assert.equal(z.closing_kopecks, before.closing_kopecks, 'итог кассы сида как до теста');
    const st = z.entries.find((x) => vd.json.cashbook.storno_entry_ids.includes(x.entry_id));
    assert.ok(st, 'сторно в кассе');
    const c2 = (await apiWait('GET', `/api/clubs/${CLUB_SEED}/maintenance?resource_id=${t6.id}`, { token: manager.token, club: CLUB_SEED })).json.counters.find((x) => x.resource_id === t6.id).kinds.cloth;
    assert.deepEqual([c2.event_id, c2.since], [c0.event_id, c0.since], 'счётчик как до теста');
    t.diagnostic(`сид, стол 6: расход 4 321 ₽ «Ремонт столов» в кассе ${day}, ссылка maintenance_event_id; счётчик сукна ${c0.minutes} → ${c1.minutes} мин (since ${c1.since}); исправление без стоимости — kept, касса та же (${b.entries.length} записей); «не было» — reversed, итог кассы ${before.closing_kopecks} = ${z.closing_kopecks}`);
  } finally {
    // Уборка: событие на столе сида не должно остаться действующим.
    if (last) {
      const u = await p({ corrects_id: last, reason: 'E2E M5.6 события не было (уборка после теста)', void: true });
      t.diagnostic(`уборка: «не было» для ${last.slice(0, 8)} — ${u.status}`);
      if (u.status === 201) saveState({ seedEvent: null });
    }
    if (loadStateSafe().seedEvent) t.diagnostic('ВНИМАНИЕ: событие на столе 6 сида не отменено — см. state.json');
  }
});

function loadStateSafe() {
  try {
    return loadState();
  } catch {
    return {};
  }
}
