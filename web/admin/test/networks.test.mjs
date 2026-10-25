import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from '../src/mock/backend.js';
import { NET_CLUBS, NET_ID, NET_MANAGER } from '../src/mock/networks.js';
import { can, isNetworkManager } from '../src/lib/auth.js';
import { navItems } from '../src/lib/nav.js';
import { TABS } from '../src/lib/dashboard.js';
import {
  addableClubs,
  clubMenuState,
  clubTariffState,
  clubsWord,
  duplicateError,
  exportAllowed,
  groupByCategory,
  managerStatusText,
  menuBody,
  moneyHiddenForAll,
  networkNameError,
  networkRights,
  networkSiblings,
  pickNetwork,
  problemText,
  productFormErrors,
  productFromForm,
  productToForm,
  reasonError,
  sectionsFor,
  showNetworkNav,
  tariffTouched,
  withReason,
} from '../src/lib/networks.js';
import { dashboardTabs, networkCompareView, tablesAvgWords } from '../src/lib/networkDashboard.js';

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
const TZ = 'Asia/Yekaterinburg';

test('числительные и слова сети', () => {
  assert.equal(clubsWord(1), '1 клуб');
  assert.equal(clubsWord(3), '3 клуба');
  assert.equal(clubsWord(11), '11 клубов');
  assert.equal(tablesAvgWords(6), '6 столов');
  assert.equal(tablesAvgWords(1.5), '1,5 стола');
  assert.equal(tablesAvgWords(null), null);
  assert.equal(managerStatusText({ status: 'invited', expires_at: '2026-10-31T10:00:00Z' }, TZ), 'Приглашён, ждём первого входа до 31 октября');
  assert.equal(managerStatusText({ status: 'active', accepted_at: '2026-10-13T10:00:00Z' }, TZ), 'Управляющий сети с 13 октября');
});

test('название сети и причина ручного действия', () => {
  assert.ok(networkNameError('   '));
  assert.ok(networkNameError('x'.repeat(101)));
  assert.equal(networkNameError('  Сеть   Урал '), null);
  assert.ok(reasonError(' ', true));
  assert.equal(reasonError('', false), null);
  assert.ok(reasonError('x'.repeat(501), false));
  assert.deepEqual(withReason({ rules: [] }, '  '), { rules: [] });
  assert.deepEqual(withReason({ rules: [] }, ' сезон '), { rules: [], reason: 'сезон' });
});

test('права: сеть только личным входом, управляющий сети читает; разделы', () => {
  assert.deepEqual(networkRights({ role: 'owner' }, 'session'), { pin: false, owner: true, edit: true });
  assert.deepEqual(networkRights({ role: 'owner' }, 'pin'), { pin: true, owner: true, edit: false });
  assert.equal(networkRights({ role: 'manager' }, 'session').edit, false);
  assert.deepEqual(sectionsFor('owner').map((s) => s.value), ['clubs', 'managers', 'tariffs', 'menu']);
  assert.deepEqual(sectionsFor('manager').map((s) => s.value), ['clubs', 'tariffs', 'menu']);
  const mgr = { club_id: 'a', role: 'manager', network_id: 'n1' };
  assert.equal(isNetworkManager(mgr), true);
  assert.equal(isNetworkManager({ role: 'manager' }), false);
  assert.equal(showNetworkNav({ role: 'owner' }, []), true);
  assert.equal(showNetworkNav(mgr, []), true);
  assert.equal(showNetworkNav({ role: 'manager' }, []), false);
  assert.equal(can.network('reception'), false);
  assert.ok(navItems('owner', 'c1').some((i) => i.key === 'network' && i.wideOnly));
  assert.ok(!navItems('manager', 'c1').some((i) => i.key === 'network'));
  assert.ok(navItems('manager', 'c1', { network: true }).some((i) => i.key === 'network'));
  assert.ok(!navItems('reception', 'c1', { network: true }).some((i) => i.key === 'network'));
});

test('управляющий сети: без «Денег», без выгрузок, переключатель клубов сети', () => {
  const values = (o) => dashboardTabs(TABS, o).map((t) => t.value);
  assert.deepEqual(values({ networkManager: true, hasNetwork: true }), ['summary', 'hall', 'guests', 'control', 'network']);
  assert.deepEqual(values({ networkManager: false, hasNetwork: true }), ['summary', 'money', 'hall', 'guests', 'control', 'network']);
  assert.deepEqual(values({}), TABS.map((t) => t.value));
  const clubs = [
    { club_id: 'a', role: 'manager', network_id: 'n1' },
    { club_id: 'b', role: 'manager', network_id: 'n1' },
    { club_id: 'c', role: 'owner' },
  ];
  assert.equal(moneyHiddenForAll(clubs), false);
  assert.equal(moneyHiddenForAll(clubs.slice(0, 2)), true);
  assert.equal(exportAllowed({ club: clubs[0] }), false);
  assert.equal(exportAllowed({ club: clubs[2] }), true);
  assert.equal(exportAllowed({ all: true, clubs }), true);
  assert.equal(exportAllowed({ all: true, clubs: clubs.slice(0, 2) }), false);
  assert.deepEqual(networkSiblings(clubs, clubs[0]).map((c) => c.club_id), ['a', 'b']);
  assert.deepEqual(networkSiblings(clubs, clubs[2]), []);
});

test('выбор сети и свои клубы для «Добавить клуб»', () => {
  const nets = [{ network_id: 'n1' }, { network_id: 'n2' }];
  assert.equal(pickNetwork(nets, null, 'n2').network_id, 'n2');
  assert.equal(pickNetwork(nets, { network_id: 'n2' }, 'zzz').network_id, 'n2');
  assert.equal(pickNetwork(nets, null, null).network_id, 'n1');
  assert.equal(pickNetwork([], null, null), null);
  const memberships = [
    { club_id: 'a', role: 'owner' },
    { club_id: 'b', role: 'owner' },
    { club_id: 'c', role: 'manager' },
    { club_id: 'd', role: 'manager', network_id: 'n9' },
  ];
  assert.deepEqual(addableClubs(memberships, { clubs: [{ club_id: 'a' }] }).map((c) => c.club_id), ['b']);
});

test('шаблон тарифов: кого коснётся, состояние клуба, проблема недели словами', () => {
  const clubs = [
    { club_id: 'a', mode: 'live', live: true, override: false },
    { club_id: 'b', mode: 'live', live: true, override: true },
    { club_id: 'c', mode: 'test', live: false, override: false },
  ];
  assert.deepEqual(tariffTouched(clubs, 'soft').map((c) => c.club_id), ['a', 'c']);
  assert.deepEqual(tariffTouched(clubs, 'hard').map((c) => c.club_id), ['a', 'b', 'c']);
  assert.equal(clubTariffState(clubs[1], 'soft').text, 'Изменено в клубе');
  assert.equal(clubTariffState(clubs[1], 'hard').text, 'По шаблону');
  assert.equal(clubTariffState({ problem: { type: 'gap' } }, 'soft').text, 'Неделя не покрыта');
  assert.equal(problemText({ type: 'gap', kind: 'snooker', weekday: 3, from: '02:00', to: '06:00' }), 'В среду с 02:00 до 06:00 нет цены · снукер.');
  assert.equal(problemText({ type: 'overlap', kind: null, weekday: 2, from: '17:00', to: '18:00' }), 'Во вторник с 17:00 до 18:00 задано две цены.');
  assert.equal(problemText({ type: 'gap', kind: 'pool', weekday: 1, from: '08:00', to: '08:00' }), 'В понедельник нет цены ни на один час · пул.');
  assert.equal(problemText(null), null);
});

test('шаблон меню: форма товара по правилам сервера, повторы, тело', () => {
  const f = productToForm({ id: 'p1', category: 'Пиво', name: 'Сидр', sku: 'BEER-CID', price_kopecks: 28050, unit: 'шт', is_alcohol: true, vat_code: 11 });
  assert.equal(f.price, '280,5');
  assert.equal(f.vat_code, '11');
  assert.deepEqual(productFormErrors(f), {});
  assert.ok(productFormErrors({ ...f, name: ' ' }).name);
  assert.ok(productFormErrors({ ...f, price: '0' }).price);
  assert.ok(productFormErrors({ ...f, sku: 'пиво 1' }).sku);
  assert.ok(productFormErrors({ ...f, category: 'x'.repeat(101) }).category);
  const p = productFromForm({ ...f, payment_subject: 'commodity' }, 4);
  assert.deepEqual(p, { id: 'p1', name: 'Сидр', price_kopecks: 28050, category: 'Пиво', sku: 'BEER-CID', unit: 'шт', is_alcohol: true, vat_code: 11, payment_subject: 'excise', description: null, sort: 4, active: true });
  const cola = productFromForm({ ...productToForm({ name: 'Кола', price_kopecks: 15000 }), payment_subject: 'excise' });
  assert.equal(cola.payment_subject, 'commodity');
  assert.equal(cola.id, undefined);
  assert.equal(cola.category, null);
  assert.match(duplicateError([f, { ...f, key: 'x', id: null, sku: '' }]), /повторяется/);
  assert.match(duplicateError([f, { ...f, key: 'x', name: 'Другой' }]), /Артикул BEER-CID/);
  assert.equal(duplicateError([f, { ...f, key: 'x', name: 'Другой', sku: '' }]), null);
  const body = menuBody([f], ' акция ');
  assert.equal(body.reason, 'акция');
  assert.equal(body.products[0].sort, 0);
  assert.deepEqual(groupByCategory([{ category: 'Б', sort: 2 }, { category: null, sort: 1 }, { category: 'Б', sort: 0 }]).map((g) => [g.name, g.items.length]), [['Б', 2], ['Без категории', 1]]);
  assert.equal(clubMenuState({ overrides: 2, applied_version: 3 }, 3).text, 'Изменено клубом: 2 товара');
  assert.equal(clubMenuState({ overrides: 0, applied_version: 2 }, 3).text, 'Ещё не получил новую версию');
  assert.equal(clubMenuState({ overrides: 0, applied_version: 3 }, 3).text, 'Как в сети');
});

test('вкладка «Сеть»: клубы в тесте — отдельно, рейтинг местами, плитки форматом дашборда', () => {
  const tile = (id, value, prev = null) => ({ id, value, prev, unit: 'x' });
  const v = networkCompareView({
    network: { id: 'n', name: 'Сеть Урал' },
    period: { from: '2026-10-01', to: '2026-10-24', days: 24 },
    clubs: [
      { club_id: 'b', name: 'Б', timezone: 'Europe/Kaliningrad', day_start_local: '08:00', mode: 'live', ranked: true, tables_avg: 6, tiles: [tile('revenue', 100000, 80000), tile('utilization', 32)], place_utilization: 2, place_revenue_per_table: 1 },
      { club_id: 'a', name: 'А', timezone: TZ, day_start_local: '06:00', mode: 'live', ranked: true, tables_avg: 8, tiles: [tile('revenue', 200000), tile('utilization', 42.4)], place_utilization: 1, place_revenue_per_table: 2 },
      { club_id: 'c', name: 'В', timezone: TZ, day_start_local: '06:00', mode: 'test', ranked: false, tables_avg: 4, tiles: [tile('revenue', 0)], place_utilization: null, place_revenue_per_table: null },
    ],
    totals: { tables_avg: 14, tiles: [tile('revenue', 300000)] },
    ranking: { utilization: [{ club_id: 'a', name: 'А', value: 42.4, place: 1 }, { club_id: 'b', name: 'Б', value: 32, place: 2 }], revenue_per_table: [{ club_id: 'b', name: 'Б', value: 727612, place: 1 }] },
    missing_days: [],
  });
  assert.deepEqual(v.ranked.map((c) => c.id), ['a', 'b']);
  assert.deepEqual(v.outside.map((c) => c.id), ['c']);
  assert.equal(v.ranked[0].tiles.utilization.text, '42,4 %');
  assert.equal(v.ranked[1].tiles.revenue.text, '1 000 ₽');
  assert.equal(v.ranked[1].tiles.revenue.delta.dir, 'up');
  assert.equal(v.ranking.utilization[0].text, '42,4 %');
  assert.equal(v.ranking.revenue[0].text, '7 276 ₽');
  assert.equal(v.mixedDays, true);
  assert.equal(v.totals.tiles.revenue.text, '3 000 ₽');
  assert.equal(networkCompareView({ clubs: [] }).empty, true);
});

test('заглушка: сеть владельца, PIN — 403, управляющий — только чтение, шаблоны и блокировки', async () => {
  const api = backend('network');
  const me = await api('/api/me');
  assert.equal(me.body.networks[0].network_id, NET_ID);
  assert.equal(me.body.networks[0].role, 'owner');
  const n = await api(`/api/networks/${NET_ID}`);
  assert.equal(n.body.clubs.length, 3);
  assert.equal(n.body.plan.applies, true);
  // Четвёртый клуб — свой, добавляется; второй раз в другую сеть — 409
  const add = await api(`/api/networks/${NET_ID}/clubs`, 'POST', { club_id: NET_CLUBS.fourth });
  assert.equal(add.status, 201);
  const other = await api('/api/networks', 'POST', { name: 'Вторая' });
  assert.equal(other.status, 201);
  assert.equal((await api(`/api/networks/${other.body.id}/clubs`, 'POST', { club_id: NET_CLUBS.fourth })).body.error, 'club_in_network');
  // Шаблон тарифов: у второго клуба снукер — неделя не покрыта; без причины в боевых — reason_required
  const t = await api(`/api/networks/${NET_ID}/tariffs`);
  assert.equal(t.body.clubs.find((c) => c.club_id === NET_CLUBS.second).problem.kind, 'snooker');
  const gap = await api(`/api/networks/${NET_ID}/tariffs`, 'PUT', { rules: t.body.rules });
  assert.equal(gap.body.error, 'tariff_gap');
  assert.equal(gap.body.club_id, NET_CLUBS.second);
  const allDay = [{ kind: null, days: [1, 2, 3, 4, 5, 6, 7], from: '06:00', to: '06:00', price_per_hour_kopecks: 50000, min_minutes: 30, step_minutes: 1 }];
  assert.equal((await api(`/api/networks/${NET_ID}/tariffs`, 'PUT', { rules: allDay })).body.error, 'reason_required');
  const saved = await api(`/api/networks/${NET_ID}/tariffs`, 'PUT', { rules: allDay, reason: 'Единая цена' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.version, 3);
  // Клуб: мягкий шаблон меню, «Капучино» изменён в клубе; алкоголь сети не снять
  const cn = await api(`/api/clubs/${NET_CLUBS.dev}/network`);
  assert.equal(cn.body.network.menu.overrides, 1);
  assert.equal(cn.body.network.tariffs.locked, false);
  const cat = await api(`/api/clubs/${NET_CLUBS.dev}/catalog`);
  const beer = cat.body.products.find((p) => p.name.startsWith('Светлое'));
  assert.ok(beer.network_product_id);
  assert.equal((await api(`/api/catalog/products/${beer.id}`, 'PATCH', { is_alcohol: false })).body.error, 'network_locked');
  const reset = await api(`/api/clubs/${NET_CLUBS.dev}/network/reset`, 'POST', { scope: 'menu', reason: 'Вернуть цены сети' });
  assert.equal(reset.body.scope, 'menu');
  assert.equal((await api(`/api/clubs/${NET_CLUBS.dev}/network`)).body.network.menu.overrides, 0);
  // Приглашение управляющего: текст и ссылка; свой номер — duplicate
  const inv = await api(`/api/networks/${NET_ID}/managers`, 'POST', { phone: '+79120001122' });
  assert.equal(inv.status, 201);
  assert.match(inv.body.invite_text, /Сеть Урал/);
  assert.doesNotMatch(inv.body.invite_text, /9120001122/);
  assert.equal((await api(`/api/networks/${NET_ID}/managers`, 'POST', { phone: '+79000000001' })).body.error, 'duplicate');
  // Персонал клуба: управляющий сети с network_id, клуб его не меняет
  const staff = await api(`/api/clubs/${NET_CLUBS.dev}/staff`);
  assert.equal(staff.body.staff.find((s) => s.user_id === NET_MANAGER.id).network_id, NET_ID);
  assert.equal((await api(`/api/clubs/${NET_CLUBS.dev}/staff/${NET_MANAGER.id}`, 'DELETE')).body.error, 'network_locked');
  // Вкладка «Сеть»: тестовый клуб вне рейтинга
  const d = await api(`/api/networks/${NET_ID}/dashboard?from=2026-10-01&to=2026-10-24&compare=1`);
  assert.equal(d.body.clubs.find((c) => c.club_id === NET_CLUBS.third).ranked, false);
  assert.ok(d.body.ranking.utilization.every((x) => x.club_id !== NET_CLUBS.third));
});

test('заглушка: жёсткий шаблон, управляющий сети, PIN', async () => {
  const hard = backend('network-hard');
  assert.equal((await hard(`/api/clubs/${NET_CLUBS.dev}/tariffs`, 'PUT', { rules: [] })).body.error, 'network_locked');
  const net = await hard(`/api/clubs/${NET_CLUBS.dev}/network`);
  assert.equal(net.body.network.tariffs.locked, true);
  assert.equal(net.body.network.menu.locked, true);

  const mgr = backend('network-manager');
  const me = await mgr('/api/me');
  assert.ok(me.body.clubs.every((c) => c.network_id === NET_ID && c.role === 'manager'));
  assert.equal(me.body.networks[0].role, 'manager');
  assert.equal((await mgr(`/api/networks/${NET_ID}/managers`)).status, 403);
  assert.equal((await mgr(`/api/networks/${NET_ID}/tariffs`)).status, 200);
  assert.equal((await mgr(`/api/clubs/${NET_CLUBS.dev}/dashboard?tab=money&from=2026-10-18&to=2026-10-24`)).status, 403);
  assert.equal((await mgr(`/api/clubs/${NET_CLUBS.dev}/shifts/export.csv`)).status, 403);

  const pin = backend('network-pin');
  const pme = await pin('/api/me');
  assert.deepEqual(pme.body.networks, []);
  assert.equal(pme.body.session.kind, 'pin');
  assert.equal((await pin(`/api/networks/${NET_ID}`)).status, 403);
  assert.equal((await pin(`/api/clubs/${NET_CLUBS.dev}/network`)).body.network.name, 'Сеть Урал');

  const empty = backend('network-empty');
  assert.deepEqual((await empty('/api/me')).body.networks, []);
});
