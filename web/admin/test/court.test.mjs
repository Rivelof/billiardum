// M5.8 «Падел-корт» в программе клуба: слова по виду ресурса, тариф по слотам, зал, ресепшн, дашборд, отчёт смены, заглушка.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorMessage } from '@billiardum/shared/errors';
import { formatMoney } from '@billiardum/shared/format';
import { createBackend } from '../src/mock/backend.js';
import {
  COURT_KIND,
  buildRules,
  courtRulesMissing,
  defaultTariffForm,
  hallHasCourts,
  hallTypes,
  isCourtRule,
  rulePrice,
  ruleKind,
  rulesSlot,
  tariffFormErrors,
  weekCoverage,
  weekSummary,
} from '../src/lib/tariffs.js';
import { familyChange, fitRotation, fitScale, fitsHall, oversizeHint, footprint, kindOf, kindsOfFamily, nextNumber, numberError, planTables, retireBusyText, tableAria } from '../src/lib/hallEditor.js';
import { courtFreeOptions, courtPlayers, needsSessionDetail, requestFamily, requestHallItem, requestLength, requestLine, requestSlot, sessionSlot } from '../src/lib/court.js';
import { dashboardQuery, familyTotals, kindCards, kindFamily, kindOptions, readFilters, tileViews } from '../src/lib/dashboard.js';
import { familyLine } from '../src/lib/shift.js';
import { placeColumnLabel, requestTitle, rowPlace, rowResource } from '../src/lib/words.js';
import { requestLine as posRequestLine, tabLine, tabsTitle } from '../src/lib/pos.js';
import { alarmView } from '../src/lib/alarms.js';
import { auditView } from '../src/lib/audit.js';
import { problemText } from '../src/lib/networks.js';
import { reactionView } from '../src/lib/dashboard.js';

const memory = () => {
  let v = null;
  return { load: () => v, save: (s) => (v = JSON.parse(JSON.stringify(s))) };
};
const NOW = Date.parse('2026-10-24T12:00:00Z');
const backend = (sc) => {
  const b = createBackend(memory(), () => NOW);
  b.scenario(sc);
  return (path, method = 'GET', body) => b.handle(method, { href: `http://x${path}`, body });
};
const CLUB = '0b6b8c1e-5a7d-4f0e-9c3a-2d1e4f5a6b7c';
const NBSP = ' ';

const priced = (extra = {}) => ({ ...defaultTariffForm('day_evening'), evening: '18:00', prices: { day: '500', eve: '800', ...extra } });

test('тариф: блок корта — правила слота по тем же полосам, kind: null только у столов (№212, №213)', () => {
  const form = { ...priced({ 'day:padel_court': '2400', 'eve:padel_court': '3000' }), slot_minutes: 90 };
  const rules = buildRules(form, ['pyramid', 'pool'], '06:00', true);
  const courts = rules.filter(isCourtRule);
  assert.equal(rules.filter((r) => !isCourtRule(r)).length, 2);
  assert.deepEqual(courts, [
    { kind: COURT_KIND, days: [1, 2, 3, 4, 5, 6, 7], from: '06:00', to: '18:00', slot_minutes: 90, price_per_slot_kopecks: 240000 },
    { kind: COURT_KIND, days: [1, 2, 3, 4, 5, 6, 7], from: '18:00', to: '06:00', slot_minutes: 90, price_per_slot_kopecks: 300000 },
  ]);
  // У правила корта нет цены часа, минимума и шага — их задаёт сервер (слот)
  assert.equal(courts[0].price_per_hour_kopecks, undefined);
  assert.equal(courts[0].min_minutes, undefined);
  // Без кортов — правил корта нет; offerCourts (шаблон сети) — по галочке
  assert.equal(buildRules(form, ['pyramid'], '06:00', false).some(isCourtRule), false);
  assert.equal(buildRules({ ...form, courts: true }, ['pyramid'], '06:00', false).filter(isCourtRule).length, 2);
  // Только корты — столовых правил нет
  assert.deepEqual(buildRules(form, [], '06:00', true).map((r) => r.kind), [COURT_KIND, COURT_KIND]);
  assert.equal(rulesSlot(rules), 90);
  assert.equal(ruleKind(courts[0]), COURT_KIND);
  assert.equal(ruleKind({ kind: null }), null);
  assert.equal(rulePrice(courts[0]), 240000);
});

test('тариф: цена корта обязательна при кортах, длина слота 60/90/120', () => {
  const errs = tariffFormErrors(priced(), ['pyramid'], '06:00', true);
  assert.equal(errs['price:day:padel_court'], 'Цена слота — от 1 ₽.');
  assert.equal(errs['price:eve:padel_court'], 'Цена слота — от 1 ₽.');
  assert.match(tariffFormErrors(priced({ 'day:padel_court': '0', 'eve:padel_court': '3000' }), ['pyramid'], '06:00', true)['price:day:padel_court'], /ручным действием/);
  assert.match(tariffFormErrors({ ...priced({ 'day:padel_court': '2400', 'eve:padel_court': '3000' }), slot_minutes: 45 }, ['pyramid'], '06:00', true).slot_minutes, /1 ч, 1,5 ч или 2 ч/);
  assert.deepEqual(tariffFormErrors(priced({ 'day:padel_court': '2400', 'eve:padel_court': '3000' }), ['pyramid'], '06:00', true), {});
  // Без кортов блок не проверяется
  assert.deepEqual(tariffFormErrors(priced(), ['pyramid'], '06:00', false), {});
});

test('тариф: неделя кортов отдельно от столов, словами — цена слота', () => {
  const form = { ...priced({ 'day:padel_court': '2400', 'eve:padel_court': '3000' }), slot_minutes: 90 };
  const rules = buildRules(form, ['pyramid'], '06:00', true);
  const tables = weekCoverage(rules, 'pyramid');
  const courts = weekCoverage(rules, COURT_KIND);
  assert.equal(tables.gaps.length + tables.overlaps.length, 0, 'правило корта не задевает неделю столов');
  assert.equal(courts.gaps.length + courts.overlaps.length, 0);
  assert.equal(courts.days[1].price[0], 240000);
  assert.deepEqual(weekSummary(courts, '06:00', 90)[0], { days: 'Пн–Вс', text: `06:00–18:00 — ${formatMoney(240000)} за 1,5${NBSP}ч; 18:00–06:00 — ${formatMoney(300000)} за 1,5${NBSP}ч` });
  // Корты есть, а правил корта нет: неделя кортов вся без цены — правило «все типы» к кортам не относится
  const only = buildRules(priced(), ['pyramid'], '06:00', false);
  assert.equal(weekCoverage(only, COURT_KIND).gaps.length, 7);
  assert.equal(courtRulesMissing(only, true), true);
  assert.equal(courtRulesMissing(rules, true), false);
  assert.equal(courtRulesMissing(only, false), false);
});

test('тариф: типы зала — корты отдельно, клуб только с кортами не просит цен столов', () => {
  const hall = [{ resource: { type: 'billiard_pool', family: 'table' } }, { resource: { type: 'padel_court', family: 'court' } }];
  assert.deepEqual(hallTypes(hall), ['pool']);
  assert.equal(hallHasCourts(hall), true);
  assert.deepEqual(hallTypes([{ kind: 'padel_court', type: 'padel_court', family: 'court' }]), []);
  assert.deepEqual(hallTypes([]), ['pyramid']);
  assert.equal(hallHasCourts([{ type: 'padel_court', active: false }]), false);
});

test('зал: вид «Падел-корт», нумерация своя у семьи, стол и корт друг в друга не превращаются', () => {
  const list = planTables([
    { id: 'c1', number: 1, type: 'padel_court', family: 'court' },
    { id: 't2', number: 2, type: 'billiard_pool' },
    { id: 't1', number: 1, kind: 'pyramid' },
  ]);
  assert.deepEqual(list.map((t) => [t.id, t.kind, t.family]), [['t1', 'pyramid', 'table'], ['t2', 'pool', 'table'], ['c1', 'padel_court', 'court']]);
  assert.equal(kindOf({ type: 'padel_court' }), 'padel_court');
  assert.equal(nextNumber(list, 'table'), 3);
  assert.equal(nextNumber(list, 'court'), 2);
  // «Корт 1» и «Стол 1» — разные: номер 1 корту занят только кортом
  assert.equal(numberError('1', list, null, 'court'), 'Корт 1 уже есть. Выберите другой номер.');
  assert.equal(numberError('2', list, null, 'court'), null);
  assert.equal(numberError('2', list, null, 'table'), 'Стол 2 уже есть. Выберите другой номер.');
  assert.deepEqual(kindsOfFamily('court').map((k) => k.id), ['padel_court']);
  assert.equal(kindsOfFamily('table').length, 4);
  assert.equal(familyChange({ kind: 'pool' }, { kind: 'padel_court' }), true);
  assert.equal(familyChange({ kind: 'pool' }, { kind: 'snooker' }), false);
  // Корт в настоящем размере: 10,6 × 20,6 м со стенами
  assert.deepEqual(footprint('padel_court', 0), { w: 1060, h: 2060 });
  assert.equal(fitsHall('padel_court', { width: 1800, height: 1400 }), false);
  assert.equal(fitsHall('padel_court', { width: 2400, height: 1200 }), true);
  assert.equal(fitRotation('padel_court', { width: 2400, height: 1200 }), 90);
  assert.equal(fitRotation('padel_court', { width: 1200, height: 2400 }), 0);
  assert.equal(retireBusyText('session', 1, 'court'), 'Корт 1: идёт игра. Вывести корт можно после неё.');
  assert.equal(retireBusyText('booking', 2, 'court'), 'У корта 2 есть бронь впереди. Сначала отмените её на экране «Брони».');
  assert.match(tableAria({ number: 1, kind: 'padel_court', plan_x: 600, plan_y: 2600, plan_rotation: 0 }), /^Корт 1, падел-корт\./);
});

test('ресепшн: «Корт 1» из family, слоты, игроки «2 из 4», продление без оплаты — слотами', () => {
  const req = { id: 'r', resource_id: 'c2', resource_number: 2, resource_type: 'padel_court', resource_family: 'court', minutes: 180, amount_kopecks: 480000 };
  assert.equal(requestFamily(req), 'court');
  assert.equal(requestTitle(req), `Корт 2 · 3 ч · ${formatMoney(480000)}`);
  assert.equal(requestLength(req, 90), `2 слота · 3${NBSP}ч`);
  assert.equal(requestLength(req, 120), '3 ч', 'не делится на слот — часами');
  assert.equal(requestLine(req, 90), `Корт 2 · 2 слота · 3${NBSP}ч · ${formatMoney(480000)}`);
  assert.equal(requestTitle({ resource_number: 4, minutes: 120, amount_kopecks: 160000 }), `Стол 4 · 2 ч · ${formatMoney(160000)}`);
  // Номер 2 есть и у стола, и у корта: заявку ищем по id, иначе внутри семьи
  const hall = [{ resource: { id: 't2', number: 2, family: 'table' } }, { resource: { id: 'c2', number: 2, family: 'court' } }];
  assert.equal(requestHallItem(req, hall).resource.id, 'c2');
  assert.equal(requestHallItem({ ...req, resource_id: undefined }, hall).resource.id, 'c2');
  assert.equal(requestHallItem({ resource_number: 2 }, hall).resource.id, 't2');
  const session = { resource: { family: 'court', max_players: 4, slot_minutes: 90 }, participants: [{}, {}] };
  assert.deepEqual(courtPlayers(session), { count: 2, max: 4, full: false, text: 'Игроки 2 из 4' });
  assert.equal(courtPlayers({ ...session, participants: [{}, {}, {}, {}] }).full, true);
  assert.equal(courtPlayers(null), null);
  assert.equal(sessionSlot(session), 90);
  assert.deepEqual(courtFreeOptions(90).map((o) => o.minutes), [90, 180], 'не дальше 240 минут сервера');
  assert.equal(courtFreeOptions(60)[0].label, `1 слот · 1${NBSP}ч`);
  assert.deepEqual(courtFreeOptions(null).map((o) => o.minutes), [60, 90, 120]);
  // Касса: заявка и счёт корта
  assert.equal(posRequestLine(req).name, 'Корт 2 · 3 ч');
  assert.equal(posRequestLine(req).sub, 'Время корта');
  assert.equal(tabLine({ session_id: 's', resource: { number: 1, family: 'court' }, orders: 1, total_kopecks: 100 }).name, 'Счёт корта 1');
  assert.equal(tabLine({ session_id: 's', resource: { number: 3 }, orders: 1, total_kopecks: 100 }).name, 'Счёт стола 3');
});

test('тревоги и журнал: «Корт 1» и слово «корт» в тексте', () => {
  const a = alarmView({ type: 'lamp_fault', level: 'important', resource_number: 1, resource_type: 'padel_court' });
  assert.equal(a.table, 'Корт 1');
  assert.match(a.text, /другой корт/);
  assert.equal(alarmView({ type: 'lamp_fault', resource_number: 4 }).table, 'Стол 4');
  const tables = new Map([['c1', { number: 1, family: 'court' }], ['t1', 1]]);
  assert.equal(auditView({ action: 'session.start', resource_id: 'c1', created_at: '2026-10-24T12:00:00Z' }, 'Asia/Yekaterinburg', { tables }).table, 'Корт 1');
  // Д4: подпись действия — по виду ресурса записи
  const cmd = (id, action) => auditView({ action, resource_id: id, created_at: '2026-10-24T12:00:00Z' }, 'Asia/Yekaterinburg', { tables }).title;
  assert.equal(cmd('c1', 'device.cmd'), 'Команда корту');
  assert.equal(cmd('c1', 'order.create'), 'Заказ с корта');
  assert.equal(cmd('t1', 'device.cmd'), 'Команда столу');
  assert.equal(cmd('t1', 'order.create'), 'Заказ со стола');
  assert.equal(cmd(undefined, 'order.create'), 'Заказ со стола', 'без ресурса — как раньше');
  // Д3: заголовок открытых счетов кассы
  assert.equal(tabsTitle([{ resource: { family: 'court' } }]), 'Счета кортов');
  assert.equal(tabsTitle([{ resource: { family: 'court' } }, { resource: { family: 'table' } }]), 'Счета столов и кортов');
  assert.equal(tabsTitle([{ resource: { family: 'table' } }]), 'Счета столов');
  assert.equal(auditView({ action: 'session.start', resource_id: 't1', created_at: '2026-10-24T12:00:00Z' }, 'Asia/Yekaterinburg', { tables }).table, 'Стол 1');
});

test('дашборд: фильтр «Все / Столы / Корты» и типы, запрос — тип ресурса или семья', () => {
  const k = kindOptions(['pyramid', 'pool', 'padel_court']);
  assert.equal(k.label, 'Вид');
  assert.deepEqual(k.options.map((o) => o.value), ['table', 'court', 'pyramid', 'pool']);
  assert.equal(k.all, 'Все: столы и корты');
  // Без кортов — как раньше: «Тип стола»
  assert.deepEqual(kindOptions(['pyramid', 'pool']).options.map((o) => o.value), ['pyramid', 'pool']);
  // Корты и один тип столов — «Столы» уже и есть этот тип
  assert.deepEqual(kindOptions(['pyramid', 'padel_court']).options.map((o) => o.value), ['table', 'court']);
  const f = readFilters('?kind=court&tab=hall', '2026-10-24');
  assert.equal(f.kind, 'court');
  assert.equal(dashboardQuery(f).kind, 'court');
  assert.equal(dashboardQuery({ ...f, kind: 'pool' }).kind, 'billiard_pool');
  assert.equal(dashboardQuery({ ...f, kind: '' }).kind, undefined);
  assert.equal(readFilters('?kind=padel', '2026-10-24').kind, '');
  assert.equal(kindFamily('court'), 'court');
  assert.equal(kindFamily('pool'), 'table');
  const byKind = [
    { kind: 'pyramid', total: 5, busy: 3 },
    { kind: 'pool', total: 3, busy: 1 },
    { kind: 'padel_court', total: 2, busy: 1 },
  ];
  assert.equal(kindCards(byKind)[2].label, 'Падел-корт');
  assert.deepEqual(familyTotals(byKind).map((x) => `${x.label}: ${x.words}`), ['Столы: занято 4 из 8', 'Корты: занято 1 из 2']);
  assert.deepEqual(familyTotals(byKind.slice(0, 2)), []);
  const [tile] = tileViews([{ id: 'revenue_per_table_day', value: 120000 }], ['revenue_per_table_day'], { family: 'court' });
  assert.equal(tile.label, 'Выручка с корта в день');
});

test('отчёт смены: строка «Столы — …; корты — …» из by_family', () => {
  const play = {
    by_family: [
      { family: 'court', hours: 6, utilization_percent: 25, revenue_kopecks: 960000, refunds_kopecks: 0 },
      { family: 'table', hours: 24.3, utilization_percent: 41.3, revenue_kopecks: 1200000, refunds_kopecks: 20000 },
    ],
  };
  assert.equal(familyLine(play), `Столы — 24,3${NBSP}ч, загрузка 41,3${NBSP}%, ${formatMoney(1180000)}; корты — 6${NBSP}ч, загрузка 25${NBSP}%, ${formatMoney(960000)}.`);
  assert.equal(familyLine({ by_family: [play.by_family[1]] }), null);
  assert.equal(familyLine(null), null);
});

test('тексты ошибок: tariff_gap корта и стол ↔ корт', () => {
  const m = errorMessage({ code: 'tariff_gap', data: { kind: 'padel_court', weekday: 1, from: '06:00', to: '06:00' } }, { audience: 'staff' });
  assert.equal(m.title, 'Корты: в понедельник с 06:00 до 06:00 нет цены.');
  assert.match(m.action, /цены кортов за слот/);
  const net = errorMessage({ code: 'tariff_gap', data: { kind: 'padel_court', weekday: 2, from: '06:00', to: '18:00', club_id: 'x' } }, { audience: 'staff', clubName: 'Клуб на Ленина' });
  assert.equal(net.title, '«Клуб на Ленина»: корты: во вторник с 06:00 до 18:00 нет цены.');
  assert.match(errorMessage({ code: 'family_change' }, { audience: 'staff' }).title, /Стол не может стать кортом/);
  assert.equal(problemText({ type: 'gap', kind: 'padel_court', weekday: 1, from: '06:00', to: '06:00' }), 'В понедельник нет цены ни на один час · корты.');
});

test('заглушка ?mock=court: зал со столами и кортами, заявка корта по resource_id, игроки корта', async () => {
  const call = backend('court');
  const hall = (await call(`/api/clubs/${CLUB}/hall`)).body;
  const courts = hall.filter((h) => h.resource.family === 'court');
  assert.deepEqual(courts.map((h) => h.resource.number), [1, 2]);
  assert.equal(hall.filter((h) => h.resource.family === 'table').length, 8);
  const reqs = (await call(`/api/clubs/${CLUB}/reception/requests`)).body;
  const cr = reqs.find((r) => r.resource_family === 'court');
  assert.equal(cr.minutes, 90);
  await call(`/api/reception/requests/${cr.id}/accept`, 'POST', { method: 'card_terminal' });
  const after = (await call(`/api/clubs/${CLUB}/hall`)).body;
  assert.equal(after.find((h) => h.resource.id === cr.resource_id).status, 'busy', 'свет на корте 2, а не на столе 2');
  assert.notEqual(after.find((h) => h.resource.family === 'table' && h.resource.number === 2).status, 'busy');
  const busy = after.find((h) => h.resource.family === 'court' && h.resource.number === 1);
  const s = (await call(`/api/sessions/${busy.session.id}`)).body;
  assert.equal(courtPlayers(s).text, 'Игроки 3 из 4');
  assert.equal(sessionSlot(s), 90);
  // «Без лимита» у корта нет
  const dep = await call('/api/reception/deposits', 'POST', { resource_id: courts[1].resource.id, amount_kopecks: 200000 });
  assert.equal(dep.status, 400);
});

test('заглушка ?mock=court-owner: стол ↔ корт — 400, номера по семьям, тарифы со слотом', async () => {
  const call = backend('court-owner');
  const res = (await call(`/api/clubs/${CLUB}/resources`)).body.resources;
  const court = res.find((r) => r.family === 'court');
  assert.equal(court.kind, 'padel_court');
  assert.equal((await call(`/api/clubs/${CLUB}/resources/${court.id}`, 'PATCH', { kind: 'pool', reason: 'тест' })).status, 400);
  // Корт 3 можно, хотя стол 3 есть; корт 1 — дубль
  assert.equal((await call(`/api/clubs/${CLUB}/resources`, 'POST', { number: 1, kind: 'padel_court', plan_x: 600, plan_y: 2600, reason: 'тест' })).status, 409);
  assert.equal((await call(`/api/clubs/${CLUB}/resources`, 'POST', { number: 3, kind: 'padel_court', plan_x: 600, plan_y: 2600, reason: 'тест' })).status, 201);
  const t = (await call(`/api/clubs/${CLUB}/tariffs`)).body;
  assert.equal(t.slots.padel_court, 90);
  assert.equal(t.rules.filter((r) => r.kind === 'padel_court').length, 4);
  // Правила без корта — tariff_gap { kind: 'padel_court' }
  const tablesOnly = t.rules.filter((r) => r.kind !== 'padel_court');
  const gap = await call(`/api/clubs/${CLUB}/tariffs`, 'PUT', { rules: tablesOnly, reason: 'тест' });
  assert.equal(gap.status, 400);
  assert.equal(gap.body.error, 'tariff_gap');
  assert.equal(gap.body.kind, 'padel_court');
  // Две длины слота — 400
  const two = t.rules.map((r, i) => (r.kind === 'padel_court' && i % 2 ? { ...r, slot_minutes: 60 } : r)).map(({ min_minutes, step_minutes, price_per_hour_kopecks, ...r }) => (r.kind === 'padel_court' ? r : { ...r, min_minutes, step_minutes, price_per_hour_kopecks }));
  assert.equal((await call(`/api/clubs/${CLUB}/tariffs`, 'PUT', { rules: two, reason: 'тест' })).status, 400);
});

test('заглушка ?mock=court-owner-gap: у кортов нет цены — неделя кортов не покрыта', async () => {
  const call = backend('court-owner-gap');
  const t = (await call(`/api/clubs/${CLUB}/tariffs`)).body;
  assert.equal(t.rules.some((r) => r.kind === 'padel_court'), false);
  assert.equal(t.coverage.problem.kind, 'padel_court');
});

test('заглушка ?mock=network-court: шаблон сети без цен кортов — tariff_gap с клубом', async () => {
  const call = backend('network-court');
  const nets = (await call('/api/networks')).body.items;
  const id = nets[0].network_id;
  const cur = (await call(`/api/networks/${id}/tariffs`)).body;
  // В клубе с кортами шаблон без цен кортов — проблема недели «корты»
  assert.equal(cur.clubs.find((c) => c.problem?.kind === 'padel_court')?.mode, 'test');
  // Снукер второго клуба покрыт ценами пирамиды — остаётся только дыра кортов
  const base = cur.rules.map(({ start_local: _s, end_local: _e, ...r }) => r);
  const tables = [...base, ...base.filter((r) => r.kind === 'pyramid').map((r) => ({ ...r, kind: 'snooker' }))];
  const bad = await call(`/api/networks/${id}/tariffs`, 'PUT', { rules: tables, reason: 'тест' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.kind, 'padel_court');
  assert.ok(bad.body.club_id);
  const withCourt = [...tables, { kind: 'padel_court', days: [1, 2, 3, 4, 5, 6, 7], from: '06:00', to: '06:00', slot_minutes: 90, price_per_slot_kopecks: 240000 }];
  const okRes = await call(`/api/networks/${id}/tariffs`, 'PUT', { rules: withCourt, reason: 'тест' });
  assert.equal(okRes.status, 200, JSON.stringify(okRes.body));
});

test('заглушка: отчёт смены с кортами — by_family, сумма видов = итог', async () => {
  const call = backend('court-owner');
  const shifts = (await call(`/api/clubs/${CLUB}/shifts`)).body;
  const list = Array.isArray(shifts) ? shifts : (shifts.items ?? shifts.shifts ?? []);
  const closed = list.find((x) => x.closed_at);
  const r = (await call(`/api/shifts/${closed.id ?? closed.shift_id}/report`)).body;
  assert.deepEqual(r.play.by_family.map((f) => f.family), ['table', 'court']);
  assert.equal(r.play.by_family.reduce((a, f) => a + f.minutes, 0), r.play.minutes);
  assert.match(familyLine(r.play), /^Столы — .*; корты — .*\.$/);
});

test('M5.8: заявка корта — «1 слот · 1,5 ч» из slot_minutes и billing заявки, без запроса тарифа', () => {
  const court = { id: 'r', resource_number: 1, resource_type: 'padel_court', resource_family: 'court', billing: 'slot', slot_minutes: 90, minutes: 90, amount_kopecks: 240000 };
  assert.equal(requestSlot(court), 90);
  assert.equal(requestLength(court), `1 слот · 1,5${NBSP}ч`);
  assert.equal(requestLine(court), `Корт 1 · 1 слот · 1,5${NBSP}ч · ${formatMoney(240000)}`);
  assert.equal(requestLength({ ...court, minutes: 180 }), `2 слота · 3${NBSP}ч`);
  assert.equal(requestLength({ ...court, minutes: 100 }), '1 ч 40 мин', 'не делится на слот — часами');
  // Касса: плитка и строка чека
  assert.equal(posRequestLine(court).name, `Корт 1 · 1 слот · 1,5${NBSP}ч`);
  // Стол: hourly, slot_minutes null — минуты как раньше
  const table = { resource_number: 4, resource_type: 'billiard_pool', resource_family: 'table', billing: 'hourly', slot_minutes: null, minutes: 120, amount_kopecks: 160000 };
  assert.equal(requestSlot(table), null);
  assert.equal(requestLength(table), '2 ч');
  assert.equal(posRequestLine(table).name, 'Стол 4 · 2 ч');
  // Явный слот важнее заявки; без данных — как раньше
  assert.equal(requestLength(court, 60), '1 ч 30 мин', 'явный слот важнее заявки; 90 не делится на 60 — часами');
  assert.equal(requestSlot({ ...court, billing: 'hourly' }), null);
  assert.equal(requestSlot(null), null);
});

test('M5.8: окно корта берёт слот из session зала; GET /api/sessions/{id} — только за недостающим', () => {
  const hallSession = { id: 's1', status: 'active', billing: 'slot', slot_minutes: 90 };
  assert.equal(sessionSlot(hallSession), 90);
  assert.equal(needsSessionDetail(hallSession), true, 'игроков в зале нет — запрос остаётся');
  const full = { ...hallSession, participants: [{}, {}, {}] };
  assert.equal(needsSessionDetail(full), false, 'слот и игроки есть — запрос не нужен');
  assert.equal(needsSessionDetail({ ...full, slot_minutes: null }), true);
  assert.equal(needsSessionDetail(null), false);
  assert.equal(courtPlayers({ ...full, resource: { family: 'court' } }).text, 'Игроки 3 из 4');
});

test('M5.8: заказ бара, история, журнал и отчёт смены — «Корт 1» по resource.family/type и resource_type', () => {
  assert.equal(rowPlace({ resource: { number: 1, type: 'padel_court', family: 'court' } }), 'Корт 1');
  assert.equal(rowPlace({ resource: { number: 1, type: 'billiard_pool', family: 'table' } }), 'Стол 1');
  assert.equal(rowPlace({ resource_number: 2, resource_type: 'padel_court' }), 'Корт 2');
  assert.equal(rowPlace({ resource_number: 4 }), 'Стол 4');
  assert.equal(rowPlace({ resource_number: 1, resource_type: 'padel_court' }, { case: 'gen', capital: false }), 'корта 1');
  assert.equal(rowPlace({ resource_number: null }), null);
  assert.equal(rowPlace({}), null);
  assert.equal(rowResource({}), 'table');
  assert.equal(placeColumnLabel([{ resource_number: 1 }, { resource_number: 2, resource_type: 'padel_court' }]), 'Стол или корт');
  assert.equal(placeColumnLabel([{ resource_number: 1, resource_type: 'billiard_pool' }]), 'Стол');
  assert.equal(placeColumnLabel(null), 'Стол');
  const log = auditView({ action: 'manual.extend_free', resource_number: 1, resource_type: 'padel_court', created_at: '2026-10-24T12:00:00Z' }, 'Asia/Yekaterinburg');
  assert.equal(log.table, 'Корт 1');
});

test('заглушка ?mock=court: заявки с billing и slot_minutes, зал с billing, заказ бара с корта, отчёт смены с resource_type', async () => {
  const call = backend('court');
  const reqs = (await call(`/api/clubs/${CLUB}/reception/requests`)).body;
  const cr = reqs.find((r) => r.resource_family === 'court');
  assert.deepEqual([cr.billing, cr.slot_minutes, cr.resource_type], ['slot', 90, 'padel_court']);
  assert.equal(requestLine(cr), `Корт 2 · 1 слот · 1,5${NBSP}ч · ${formatMoney(240000)}`);
  const tr = reqs.find((r) => r.resource_family === 'table');
  assert.deepEqual([tr.billing, tr.slot_minutes], ['hourly', null]);
  const hall = (await call(`/api/clubs/${CLUB}/hall`)).body;
  const busy = hall.find((h) => h.resource.family === 'court' && h.session);
  assert.deepEqual([busy.session.billing, busy.session.slot_minutes], ['slot', 90]);
  assert.equal(hall.find((h) => h.resource.number === 1 && h.resource.family === 'table').session.billing, 'hourly');
  const queue = (await call(`/api/clubs/${CLUB}/bar/queue`)).body;
  const orders = Array.isArray(queue) ? queue : (queue.orders ?? queue.items ?? []);
  const co = orders.find((o) => o.resource?.family === 'court');
  assert.ok(co, 'в очереди бара есть заказ с корта');
  assert.equal(rowPlace(co), 'Корт 1');
  assert.equal(co.resource.type, 'padel_court');
});

test('дашборд «Контроль»: тревога и ручное действие несут resource_type — «Корт 1»', () => {
  const v = reactionView({ problems: [{ alarm_id: 'a1', type: 'lamp_fault', level: 'important', resource_number: 1, resource_type: 'padel_court', raised_at: '2026-10-22T15:00:00Z', acked_at: null, react_sec: null }] });
  assert.equal(v.rows[0].resource_type, 'padel_court');
  assert.equal(rowPlace(v.rows[0]), 'Корт 1');
});

test('план зала: корт больше зала уменьшается до стен, подсказка «увеличьте зал»', () => {
  const hall = { width: 1800, height: 1400 };
  // корт 10,6 × 20,6 м в зале 18 × 14 м: по высоте 1400 / 2060
  assert.ok(Math.abs(fitScale('padel_court', 0, hall) - 1400 / 2060) < 1e-9);
  // повёрнутый: 20,6 м по ширине 18 м — ещё меньше
  assert.ok(Math.abs(fitScale('padel_court', 90, hall) - 1800 / 2060) < 1e-9);
  assert.equal(fitScale('padel_court', 90, { width: 2400, height: 1200 }), 1, 'поперёк в широком зале помещается');
  assert.equal(fitScale('pyramid', 0, hall), 1, 'стол помещается — без уменьшения');
  assert.equal(fitScale('padel_court', 0, { width: 2200, height: 2200 }), 1);
  assert.equal(oversizeHint([{ kind: 'pyramid', number: 1 }], hall), null);
  assert.equal(
    oversizeHint([{ kind: 'padel_court', number: 2, plan_rotation: 0 }], hall),
    'Корт 2 не помещается в зал 18 м на 14 м, поэтому на плане уменьшен. Увеличьте зал: нужно не меньше 10,6 м на 20,6 м.',
  );
});
