import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorMessage } from '@billiardum/shared/errors';
import { formatMoney } from '@billiardum/shared/format';
import { ApiError } from '@billiardum/shared/api';
import {
  buildRules,
  defaultTariffForm,
  hallTypes,
  previewGrid,
  spanHours,
  spanText,
  tariffBands,
  tariffFormErrors,
  tariffsBody,
  weekCoverage,
  weekSummary,
  workMinute,
} from '../src/lib/tariffs.js';
import {
  clampCenter,
  footprint,
  hallFromMetres,
  kindOf,
  metres,
  moveTable,
  nextNumber,
  nextSpot,
  numberError,
  placeUnset,
  pxToCm,
  resourcePatch,
  rotateTable,
  tableAria,
} from '../src/lib/hallEditor.js';
import {
  STEPS,
  checklistView,
  guestTableUrl,
  inviteShare,
  kitLeadBody,
  nextStepOf,
  parseBld1,
  paymentCheckView,
  prevStepOf,
  secretMaskText,
  shopBody,
  shopErrors,
  shopView,
  stepsView,
  webhookUrl,
} from '../src/lib/onboarding.js';
import { approvedListings, cityList, clubStartBody, clubStartErrors, tzForCity } from '../src/lib/clubStart.js';
import { clubMode } from '../src/lib/auth.js';
import { createBackend } from '../src/mock/backend.js';

const memory = () => {
  let s = null;
  return { load: () => s, save: (v) => (s = structuredClone(v)) };
};
const req = (b, method, path, body) => b.handle(method, { href: `http://x${path}`, body });
const DEV = 'd1000000-0000-4000-8000-000000000101';

// ---------------- тарифы ----------------

test('тарифы: шаблон «Будни и выходные × день и вечер» → правила с разрезом в полночь, как в сиде', () => {
  const form = { ...defaultTariffForm('weekend_day_evening'), weekend: [5, 6, 7], prices: { wd_day: '500', wd_eve: '800', we_day: '600', we_eve: '1 000' } };
  assert.deepEqual(tariffFormErrors(form, ['billiard_pyramid']), {});
  const rules = buildRules(form, ['billiard_pyramid']);
  assert.equal(rules.length, 6, 'день + вечер до полуночи + ночь — для будней и выходных');
  const eve = rules.filter((r) => r.price_per_hour_kopecks === 80000);
  assert.deepEqual(eve.map((r) => [r.start_local, r.end_local]), [['17:00', '00:00'], ['00:00', '06:00']]);
  assert.deepEqual(eve[0].days, [1, 2, 3, 4]);
  assert.equal(rules[0].min_minutes, 30);
  assert.equal(rules[0].step_minutes, 1);
  const cov = weekCoverage(rules, 'billiard_pyramid');
  assert.equal(cov.gaps.length, 0);
  assert.equal(cov.overlaps.length, 0);
  // Ночь с пятницы на субботу — пятничная (№43): в пятницу 02:00 — цена выходного вечера
  assert.equal(cov.days[5].price[workMinute('02:00')], 100000);
  assert.equal(cov.days[4].price[workMinute('02:00')], 80000);
});

test('тарифы: ошибки формы словами — цена, граница вечера и ночи, выходные', () => {
  const f = { ...defaultTariffForm('day_evening_night'), evening: '06:00', night: '05:00', prices: { day: '0', eve: 'абв' } };
  const e = tariffFormErrors(f, ['billiard_pyramid']);
  assert.match(e.evening, /позже начала суток/);
  assert.match(e['price:day'], /от 1 ₽/);
  assert.ok(e['price:eve'] && e['price:night']);
  const w = tariffFormErrors({ ...defaultTariffForm('weekend'), weekend: [], prices: { wd: '1', we: '1' } }, ['billiard_pyramid']);
  assert.match(w.weekend, /хотя бы один/);
  const night = tariffFormErrors({ ...defaultTariffForm('day_evening_night'), evening: '20:00', night: '19:00', prices: { day: '1', eve: '1', night: '1' } }, ['billiard_pyramid']);
  assert.match(night.night, /позже вечера/);
});

test('тарифы: разные цены по типам столов — поле на тип, правила на каждый тип', () => {
  const types = ['billiard_pool', 'billiard_pyramid'];
  const f = { ...defaultTariffForm('flat'), perType: true, prices: { 'all:billiard_pool': '500' } };
  const e = tariffFormErrors(f, types);
  assert.ok(e['price:all:billiard_pyramid']);
  assert.equal(e['price:all:billiard_pool'], undefined);
  const rules = buildRules({ ...f, prices: { ...f.prices, 'all:billiard_pyramid': '700' } }, types);
  assert.deepEqual(rules.map((r) => [r.resource_type, r.price_per_hour_kopecks, r.start_local, r.end_local]), [
    ['billiard_pool', 50000, '06:00', '00:00'],
    ['billiard_pool', 50000, '00:00', '06:00'],
    ['billiard_pyramid', 70000, '06:00', '00:00'],
    ['billiard_pyramid', 70000, '00:00', '06:00'],
  ]);
  assert.deepEqual(hallTypes([{ resource: { type: 'billiard_pyramid' } }, { resource: { type: 'billiard_pool' } }, { resource: { type: 'x' } }]), ['billiard_pool', 'billiard_pyramid']);
  assert.deepEqual(hallTypes([]), ['billiard_pyramid']);
});

test('тарифы: дыры и пересечения недели; сетка по часам и подсветка ответа сервера', () => {
  const rules = [
    { resource_type: 'billiard_pyramid', days: [1, 2, 3, 4, 5, 6, 7], start_local: '06:00', end_local: '00:00', price_per_hour_kopecks: 50000 },
    { resource_type: 'billiard_pyramid', days: [1, 2, 3, 4, 5, 6], start_local: '00:00', end_local: '06:00', price_per_hour_kopecks: 80000 },
    { resource_type: 'billiard_pyramid', days: [2], start_local: '17:00', end_local: '18:00', price_per_hour_kopecks: 90000 },
  ];
  const cov = weekCoverage(rules, 'billiard_pyramid');
  assert.deepEqual(cov.gaps.map(({ weekday, from, to }) => ({ weekday, from, to })), [{ weekday: 7, from: '00:00', to: '06:00' }]);
  assert.deepEqual(cov.overlaps.map(({ weekday, from, to }) => ({ weekday, from, to })), [{ weekday: 2, from: '17:00', to: '18:00' }]);
  assert.equal(spanText(cov.gaps[0], 'gap'), 'В воскресенье с 00:00 до 06:00 нет цены.');
  assert.equal(spanText(cov.overlaps[0], 'overlap'), 'Во вторник с 17:00 до 18:00 задано две цены.');
  const grid = previewGrid(cov, '06:00', { weekday: 7, from: '00:00', to: '06:00' });
  assert.equal(grid.hours[0], '06:00');
  assert.equal(grid.rows.length, 24);
  assert.equal(grid.rows[18].hour, '00:00');
  assert.equal(grid.rows[18].cells[6].state, 'gap');
  assert.equal(grid.rows[18].cells[6].mark, true);
  assert.equal(grid.rows[11].cells[1].state, 'overlap');
  assert.equal(grid.rows[0].cells[0].price, 50000);
  assert.deepEqual([...spanHours({ weekday: 3, from: '17:30', to: '19:00' }).hours], [11, 12]);
  // интервал через начало суток клуба захватывает утро следующего дня
  const wrap = weekCoverage([{ days: [1], start_local: '04:00', end_local: '08:00', price_per_hour_kopecks: 1 }], null);
  assert.equal(wrap.days[1].count[workMinute('05:00')], 1);
  assert.equal(wrap.days[2].count[workMinute('07:00')], 1);
});

test('тарифы: неделя словами — одинаковые дни вместе; цена сервера из price_per_hour тоже читается', () => {
  const form = { ...defaultTariffForm('weekend'), prices: { wd: '500', we: '700' } };
  const lines = weekSummary(weekCoverage(buildRules(form, ['billiard_pyramid']), 'billiard_pyramid'));
  assert.deepEqual(lines, [
    { days: 'Пн–Пт', text: `круглые сутки — ${formatMoney(50000)} в час` },
    { days: 'Сб–Вс', text: `круглые сутки — ${formatMoney(70000)} в час` },
  ]);
  const legacy = weekCoverage([{ days: [1, 2, 3, 4, 5, 6, 7], start_local: '06:00', end_local: '06:00', price_per_hour: 40000 }], null);
  assert.equal(legacy.gaps.length, 0);
  assert.equal(legacy.days[3].price[0], 40000);
  assert.deepEqual(tariffBands({ ...defaultTariffForm('day_evening'), evening: '18:00' }).map((b) => b.time), ['06:00–18:00', '18:00–06:00']);
  assert.deepEqual(tariffsBody([], { live: true, reason: '  подняли цену  ' }), { rules: [], reason: 'подняли цену' });
  assert.deepEqual(tariffsBody([], { live: false, reason: 'x' }), { rules: [] });
});

// ---------------- план зала ----------------

test('план зала: габарит с поворотом, стены, шаг 10 см, пиксели в сантиметры', () => {
  assert.deepEqual(footprint('pyramid', 0), { w: 212, h: 389 });
  assert.deepEqual(footprint('pyramid', 90), { w: 389, h: 212 });
  assert.deepEqual(footprint('pool', 0), { w: 157, h: 284 });
  const hall = { width: 1000, height: 800 };
  assert.deepEqual(clampCenter(0, 0, 'pyramid', 0, hall), { x: 106, y: 195 });
  assert.deepEqual(clampCenter(5000, 5000, 'pyramid', 90, hall), { x: 806, y: 694 });
  assert.deepEqual(clampCenter(10, 10, 'pyramid', 0, { width: 150, height: 300 }), { x: 75, y: 150 }, 'зал меньше стола — по центру');
  const t = { id: 'a', number: 1, kind: 'pyramid', plan_x: 500, plan_y: 400, plan_rotation: 0 };
  assert.deepEqual(moveTable(t, 13, -4, hall), { ...t, plan_x: 510, plan_y: 400 });
  const r = rotateTable({ ...t, plan_x: 120 }, 90, hall);
  assert.equal(r.plan_rotation, 90);
  assert.equal(r.plan_x, 195, 'повернули у стены — стол вернулся в зал');
  assert.equal(rotateTable(t, -90, hall).plan_rotation, 270);
  assert.equal(pxToCm(100, 500, hall), 200);
});

test('план зала: новое место без наложений, следующий номер, ошибки номера и размера зала', () => {
  const hall = { width: 1800, height: 1200 };
  const a = nextSpot([], hall, 'pyramid');
  assert.ok(a.x >= 206 && a.y >= 295, 'метр от стен');
  const placed = [{ number: 1, kind: 'pyramid', plan_x: a.x, plan_y: a.y, plan_rotation: 0 }];
  const b = nextSpot(placed, hall, 'pyramid');
  assert.ok(Math.abs(b.x - a.x) >= 212 + 120 || Math.abs(b.y - a.y) >= 389 + 120, 'с проходом 120 см');
  assert.equal(nextNumber([{ number: 1 }, { number: 3 }]), 2);
  assert.equal(numberError('2', [{ id: 'x', number: 2 }]), 'Стол 2 уже есть. Выберите другой номер.');
  assert.equal(numberError('2', [{ id: 'x', number: 2 }], 'x'), null);
  assert.match(numberError('0', []), /от 1 до 999/);
  assert.deepEqual(hallFromMetres('18', '12,5'), { hall: { width: 1800, height: 1250 }, errors: {} });
  assert.ok(hallFromMetres('2', 'x').errors.width && hallFromMetres('2', 'x').errors.height);
  assert.equal(metres(450), '4,5 м');
  assert.equal(kindOf({ type: 'billiard_pool' }), 'pool');
  assert.equal(kindOf({ kind: 'mixed', type: 'billiard_pyramid' }), 'mixed');
  assert.equal(tableAria({ number: 3, kind: 'pool', plan_x: 450, plan_y: 300, plan_rotation: 90 }), 'Стол 3, пул. 4,5 м от левой стены, 3 м от верхней, повёрнут на 90°.');
  const unset = placeUnset([{ id: 'a', number: 1, kind: 'pyramid', plan_x: 0, plan_y: 0, plan_rotation: 0 }], hall);
  assert.ok(unset[0].plan_x > 0 && unset[0].unset);
});

test('план зала: PATCH — только изменённые поля; вывод из работы с причиной', () => {
  const before = { number: 1, kind: 'pyramid', plan_x: 100, plan_y: 200, plan_rotation: 0 };
  assert.deepEqual(resourcePatch(before, { ...before, plan_x: 150 }), { plan_x: 150 });
  assert.deepEqual(resourcePatch(before, { ...before }), {});
  assert.deepEqual(resourcePatch(before, { active: false }, { reason: '  сукно порвано ' }), { active: false, reason: 'сукно порвано' });
});

// ---------------- мастер ----------------

test('мастер: 10 шагов, прогресс по серверу, «Клуб» сделан всегда, переходы', () => {
  assert.equal(STEPS.length, 10);
  const v = stepsView({ mode: 'test', steps: [{ id: 'hall', done: true }, { id: 'tariffs', done: false }] });
  assert.equal(v.done, 2);
  assert.equal(v.firstOpen, 'tariffs');
  assert.equal(stepsView({ mode: 'live', steps: [] }).steps.at(-1).done, true);
  assert.equal(nextStepOf('hall').id, 'tariffs');
  assert.equal(prevStepOf('club'), null);
  assert.equal(nextStepOf('go_live'), null);
});

test('чек-лист: известные пункты по порядку со ссылкой на шаг, 409 failed отмечает невыполненное', () => {
  const items = checklistView({ items: [{ id: 'shop_live', ok: true }, { id: 'tables', ok: true }, { id: 'new_thing', ok: false, detail: { x: 1 } }, { id: 'devices', ok: false, detail: 'Без связи: стол 8.' }] }, ['shop_live', 'stickers']);
  assert.deepEqual(items.map((i) => [i.id, i.ok]), [['tables', true], ['devices', false], ['shop_live', false], ['stickers', false], ['new_thing', false]]);
  assert.equal(items[1].step, 'devices');
  assert.equal(items[1].detail, 'Без связи: стол 8.');
  assert.equal(items[4].detail, null);
  assert.match(items[4].title, /new_thing/);
  assert.equal(checklistView({ items: [{ id: 'kkt', ok: false }] })[0].screen, 'kkt');
});

test('QR контроллера BLD1: разбор, мусор и чужие QR — null', () => {
  assert.deepEqual(parseBld1(` BLD1:${DEV.toUpperCase()}:AB12-cd34 `), { qr: `BLD1:${DEV}:AB12-cd34`, device_id: DEV, claim_code: 'AB12-cd34' });
  assert.equal(parseBld1('https://billiardum.ru/t/4K7P9QW2XM'), null);
  assert.equal(parseBld1(`BLD1:${DEV}`), null);
  assert.equal(parseBld1(`BLD1:not-a-uuid:CODE12`), null);
  assert.equal(parseBld1(`BLD1:${DEV}:x`), null, 'код короче 6 знаков');
  assert.equal(parseBld1(`BLD2:${DEV}:CODE1234`), null);
});

test('ЮKassa: маска секрета, отметки магазина словами, ошибки формы, тело запроса', () => {
  assert.equal(secretMaskText({ last4: '9f2c', length: 48 }), '•••• 9f2c, 48 знаков');
  assert.equal(secretMaskText('•••• 9f2c'), '•••• 9f2c');
  assert.equal(secretMaskText(null), null);
  const live = shopView({ shop_id: '1', verified_at: 'x', test: false, fiscalization: false }, 'live');
  assert.equal(live.ready, false);
  assert.deepEqual(live.flags.map((f) => [f.id, f.ok, f.text]), [
    ['verified', true, 'Проверен в ЮKassa'],
    ['test', true, 'Боевой магазин'],
    ['fiscal', false, 'Чеки по 54-ФЗ выключены'],
  ]);
  assert.equal(shopView({ shop_id: '1', verified_at: 'x', test: true, fiscalization: false }, 'test').ready, true);
  assert.equal(shopView(null, 'test').configured, false);
  assert.ok(shopErrors({ shop_id: 'abc', secret_key: '' }).shop_id);
  assert.ok(shopErrors({ shop_id: '506751', secret_key: '' }).secret_key);
  assert.deepEqual(shopErrors({ shop_id: '506751', secret_key: '' }, { hasSecret: true }), {});
  assert.ok(shopErrors({ shop_id: '506751', secret_key: 'test_1234567890' }, { live: true }).reason);
  assert.deepEqual(shopBody({ shop_id: ' 506751 ', secret_key: '' }), { shop_id: '506751' });
  assert.deepEqual(shopBody({ shop_id: '1', secret_key: 'k', reason: ' смена магазина ' }, { live: true }), { shop_id: '1', secret_key: 'k', reason: 'смена магазина' });
  assert.equal(webhookUrl('https://billiardum.ru/', 'c1'), 'https://billiardum.ru/api/webhooks/yookassa/c1');
  assert.equal(webhookUrl('https://x', 'c1', 'https://hooks.example/y'), 'https://hooks.example/y');
});

test('проверочный платёж 1 ₽: ждём, нет уведомления, всё хорошо, отмена', () => {
  const t = Date.parse('2026-10-23T12:00:00Z');
  const at = new Date(t - 60_000).toISOString();
  assert.equal(paymentCheckView(null), null);
  assert.equal(paymentCheckView({ payment_id: 'p', status: 'pending', created_at: at }, t).polling, true);
  assert.equal(paymentCheckView({ payment_id: 'p', status: 'succeeded', created_at: at }, t).tone, 'warn');
  const late = paymentCheckView({ payment_id: 'p', status: 'succeeded', created_at: new Date(t - 11 * 60_000).toISOString() }, t);
  assert.equal(late.tone, 'bad');
  assert.match(late.text, /адрес для уведомлений/);
  assert.equal(paymentCheckView({ payment_id: 'p', status: 'succeeded', webhook_at: at, refunded: true }, t).tone, 'ok');
  assert.equal(paymentCheckView({ payment_id: 'p', status: 'canceled' }, t).tone, 'bad');
});

test('приглашение ссылкой, ссылка «как гость», заявка на комплект', () => {
  assert.deepEqual(inviteShare({ invite_text: ' Вас пригласили… ', invite_url: 'https://b.ru/club/' }), { text: 'Вас пригласили…', url: 'https://b.ru/club/' });
  assert.deepEqual(inviteShare({ invite_url: 'https://b.ru/club/' }), { text: 'https://b.ru/club/', url: 'https://b.ru/club/' });
  assert.equal(inviteShare({ invite_url: 'javascript:alert(1)' }), null);
  assert.equal(inviteShare({ id: 'x' }), null);
  assert.equal(guestTableUrl('https://b.ru', '4K7P9QW2XM'), 'https://b.ru/app/t/4K7P9QW2XM');
  const lead = kitLeadBody({ name: ' Андрей ', phone: '+79000000001', count: '4', comment: '', consent: true }, { clubId: 'c', clubName: 'Клуб', city: 'Пермь', elapsedMs: 9000 });
  assert.equal(lead.kind, 'kit');
  assert.equal(lead.tables_count, 4);
  assert.equal(lead.name, 'Андрей');
  assert.equal(lead.comment, undefined);
  assert.equal(lead.website, '');
});

test('«Подключить клуб»: города, пояс по городу, карточки, ошибки и тело запроса', () => {
  const cities = cityList({ items: [{ id: 'e1', slug: 'ekb', name: 'Екатеринбург', timezone: 'Asia/Yekaterinburg' }, { slug: 'perm', name: 'Пермь' }, { name: '' }] });
  assert.equal(cities.length, 2);
  assert.equal(tzForCity('екатеринбург', cities), 'Asia/Yekaterinburg');
  assert.equal(tzForCity('г. Пермь', cities), 'Asia/Yekaterinburg', 'справочник без пояса — таблица крупных городов');
  assert.equal(tzForCity('Новосибирск'), 'Asia/Novosibirsk');
  assert.equal(tzForCity('Урюпинск'), null);
  assert.deepEqual(clubStartBody({ name: ' Свояк ', city: 'Екатеринбург', timezone: 'Asia/Yekaterinburg' }, cities), { name: 'Свояк', timezone: 'Asia/Yekaterinburg', city_id: 'e1' });
  assert.deepEqual(clubStartBody({ name: 'Свояк', city: 'Урюпинск', timezone: 'Europe/Volgograd', listing_id: 'l1' }, cities), { name: 'Свояк', timezone: 'Europe/Volgograd', city_name: 'Урюпинск', listing_id: 'l1' });
  const e = clubStartErrors({ name: 'К', city: '', timezone: 'Europe/London' });
  assert.ok(e.name && e.city && e.timezone);
  const listings = approvedListings({ items: [{ status: 'approved', listing: { id: 'l1', name: 'Свояк', city: 'Екатеринбург' } }, { status: 'new', listing: { id: 'l2' } }, { status: 'approved', listing: { id: 'l3', club_id: 'c' } }] });
  assert.deepEqual(listings.map((l) => l.id), ['l1']);
  assert.equal(clubMode({ mode: 'test' }), 'test');
  assert.equal(clubMode({}), 'live', 'сервер не прислал режим — плашки нет');
});

test('тексты новых кодов: clubs_limit и дыра в тарифе — по-человечески', () => {
  assert.match(errorMessage('clubs_limit', { audience: 'staff' }).title, /три клуба/);
  assert.equal(errorMessage(new ApiError('tariff_gap', { status: 400, data: { weekday: 1, from: '02:00', to: '06:00' } }), { audience: 'staff' }).title, 'В понедельник с 02:00 до 06:00 нет цены.');
});

// ---------------- заглушка: сценарий onboarding ----------------

test('заглушка onboarding: новый пользователь без клубов → клуб в тесте, владелец; четвёртый — clubs_limit', async () => {
  const b = createBackend(memory());
  b.scenario('onboarding');
  assert.deepEqual((await req(b, 'GET', '/api/me')).body.clubs, []);
  const claims = (await req(b, 'GET', '/api/directory/claims/mine')).body;
  const listing = claims.items[0].listing.id;
  const c = await req(b, 'POST', '/api/clubs', { name: 'Тест', city_name: 'Пермь', timezone: 'Asia/Yekaterinburg', listing_id: listing });
  assert.equal(c.status, 201);
  assert.equal(c.body.mode, 'test');
  const me = (await req(b, 'GET', '/api/me')).body;
  assert.deepEqual(me.clubs.map((x) => [x.club_id, x.role, x.mode]), [[c.body.club_id, 'owner', 'test']]);
  assert.equal(approvedListings((await req(b, 'GET', '/api/directory/claims/mine')).body).length, 0, 'карточка уже связана');
  await req(b, 'POST', '/api/clubs', { name: 'Тест 2', city_name: 'Пермь', timezone: 'Asia/Yekaterinburg' });
  await req(b, 'POST', '/api/clubs', { name: 'Тест 3', city_name: 'Пермь', timezone: 'Asia/Yekaterinburg' });
  assert.equal((await req(b, 'POST', '/api/clubs', { name: 'Тест 4', city_name: 'Пермь', timezone: 'Asia/Yekaterinburg' })).body.error, 'clubs_limit');
  const ob = (await req(b, 'GET', `/api/clubs/${c.body.club_id}/onboarding`)).body;
  assert.equal(ob.steps.length, 10);
  assert.equal(stepsView(ob).firstOpen, 'hall');
});

test('заглушка onboarding: зал, тариф с дырой (400 tariff_gap с днём и часами), магазины, QR, наклейки, запуск', async () => {
  let t = Date.parse('2026-10-23T12:00:00Z');
  const b = createBackend(memory(), () => t);
  b.scenario('onboarding');
  const club = (await req(b, 'POST', '/api/clubs', { name: 'Тест', city_name: 'Пермь', timezone: 'Asia/Yekaterinburg' })).body.club_id;
  const base = `/api/clubs/${club}`;
  assert.equal((await req(b, 'PUT', `${base}/hall`, { width: 1800, height: 1200 })).status, 200);
  const t1 = (await req(b, 'POST', `${base}/resources`, { number: 1, kind: 'pyramid', plan_x: 300, plan_y: 300, plan_rotation: 0 })).body;
  assert.equal((await req(b, 'POST', `${base}/resources`, { number: 1, kind: 'pool', plan_x: 900, plan_y: 300, plan_rotation: 0 })).body.error, 'duplicate');
  assert.equal((await req(b, 'PATCH', `${base}/resources/${t1.id}`, { plan_x: 400, plan_rotation: 90 })).body.plan_rotation, 90);

  const gap = await req(b, 'PUT', `${base}/tariffs`, { rules: [{ resource_type: 'billiard_pyramid', days: [1, 2, 3, 4, 5, 6, 7], start_local: '06:00', end_local: '00:00', price_per_hour_kopecks: 50000, step_minutes: 1, min_minutes: 30 }] });
  assert.equal(gap.status, 400);
  assert.deepEqual([gap.body.error, gap.body.weekday, gap.body.from, gap.body.to], ['tariff_gap', 1, '00:00', '06:00']);
  const rules = buildRules({ ...defaultTariffForm('flat'), prices: { all: '500' } }, ['billiard_pyramid']);
  assert.equal((await req(b, 'PUT', `${base}/tariffs`, { rules })).status, 200);

  assert.equal((await req(b, 'POST', `${base}/catalog/import?dry_run=1`, { __raw: new Uint8Array([1, 2]), __type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })).body.error, 'xlsx_invalid');
  const dry = (await req(b, 'POST', `${base}/catalog/import?dry_run=1`, { __raw: new Uint8Array([0x50, 0x4b, 3, 4]), __type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })).body;
  assert.equal(dry.applied, false);
  assert.ok(dry.rows.length >= 3);
  assert.equal((await req(b, 'POST', `${base}/catalog/import`, { __raw: new Uint8Array([0x50, 0x4b, 3, 4]), __type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })).body.applied, true);

  const inv = (await req(b, 'POST', `${base}/staff/invites`, { phone: '+79120001122', role: 'reception' })).body;
  assert.ok(inviteShare(inv).text.includes('/club/'));

  assert.equal((await req(b, 'PUT', `${base}/payment-settings/test`, { shop_id: '506751', secret_key: 'live_abcdefgh' })).body.error, 'shop_mode_mismatch');
  const shop = (await req(b, 'PUT', `${base}/payment-settings/test`, { shop_id: '506751', secret_key: 'test_abcdefgh1234' })).body;
  assert.deepEqual(shop.secret_mask, { last4: '1234', length: 17 });
  assert.equal(JSON.stringify(shop).includes('test_abcdefgh1234'), false, 'секрет целиком не возвращается');
  assert.equal((await req(b, 'PUT', `${base}/payment-settings/live`, { shop_id: '506750', secret_key: 'live_abcdefgh1234' })).body.error, 'fiscalization_off');
  await req(b, 'POST', `${base}/payment-settings/test/check`, {});
  t += 8000;
  const check = (await req(b, 'GET', `${base}/onboarding`)).body.payment_checks.test;
  assert.equal(paymentCheckView(check, t).tone, 'ok');

  assert.equal((await req(b, 'POST', `${base}/devices/bind`, { qr: 'BLD1:мусор', resource_id: t1.id })).body.error, 'qr_invalid');
  assert.ok((await req(b, 'POST', `${base}/devices/bind`, { qr: `BLD1:${DEV}:CODE123`, resource_id: t1.id })).body.bind_until);
  t += 6000;
  const hall = (await req(b, 'GET', `${base}/hall`)).body;
  assert.equal(hall[0].device.online, true);

  const fail = await req(b, 'POST', `${base}/go-live`, { accept_offer: true });
  assert.equal(fail.status, 409);
  assert.deepEqual(fail.body.failed, ['shop_live', 'stickers']);
  assert.equal((await req(b, 'GET', `${base}/qr-stickers.pdf?resources=${t1.id}`)).status, 200);
  await req(b, 'PUT', `${base}/payment-settings/live`, { shop_id: '506751', secret_key: 'live_abcdefgh1234' });
  assert.equal((await req(b, 'POST', `${base}/go-live`, { accept_offer: true })).body.mode, 'live');
  assert.equal((await req(b, 'GET', '/api/me')).body.clubs[0].mode, 'live');
  // В боевом режиме тариф и вывод стола — только с причиной
  assert.equal((await req(b, 'PUT', `${base}/tariffs`, { rules })).body.error, 'reason_required');
  assert.equal((await req(b, 'PATCH', `${base}/resources/${t1.id}`, { active: false })).body.error, 'reason_required');
  assert.equal((await req(b, 'PATCH', `${base}/resources/${t1.id}`, { active: false, reason: 'Ремонт' })).body.active, false);
});

test('заглушка: ресепшн не видит мастер, магазины и чек-лист (T28)', async () => {
  const b = createBackend(memory());
  b.scenario('testmode');
  const me = (await req(b, 'GET', '/api/me')).body;
  assert.equal(me.clubs[0].role, 'reception');
  assert.equal(me.clubs[0].mode, 'test');
  for (const [m, p] of [['GET', '/onboarding'], ['GET', '/payment-settings/live'], ['POST', '/go-live']]) {
    assert.equal((await req(b, m, `/api/clubs/c${p}`, {})).body.error, 'forbidden', p);
  }
});
