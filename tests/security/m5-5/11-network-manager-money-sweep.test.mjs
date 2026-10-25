// PoC M5.5 — обход всех GET-маршрутов клуба, доступных роли manager: что видит управляющий сети
// из денег по способам оплаты (№192: «без денег по способам оплаты и экспорта», как №166).
//
// Метод: в тестовом клубе сети владелец открывает смену и делает продажи наличными и картой через
// терминал; затем те же GET-маршруты вызывает управляющий сети. Ответ, где встречается способ
// оплаты (cash, card_terminal, sbp, card, by_method) или ожидаемые/фактические наличные смены, —
// утечка. Маршруты берутся из api/routes/*.mjs (auth 'staff', роли с manager, без параметров кроме
// {club}); POST/DELETE не вызываются.
//
// Запуск: node tests/security/m5-5/11-network-manager-money-sweep.test.mjs

import { loadRoutes } from '../../../api/router.mjs';
import { addClub, api, check, createClub, createNetwork, login, phone, RUN, summary } from './_helpers.mjs';

const results = [];
const A = await login(phone());
const club = await createClub(A.token, { name: `S1 ${RUN}` });
const club2 = await createClub(A.token, { name: `S2 ${RUN}` });
const NA = await createNetwork(A.token, `NS ${RUN}`);
await addClub(A.token, NA, club);
await addClub(A.token, NA, club2);

const mPhone = phone();
await api('POST', `/api/networks/${NA}/managers`, { token: A.token, body: { phone: mPhone } });
const M = await login(mPhone);

// Контроль: обычный управляющий клуба (в club2 не сети) — чтобы отличать «так задумано» от «сети».
const cPhone = phone();
await api('POST', `/api/clubs/${club2}/staff`, { token: A.token, body: { phone: cPhone, role: 'manager' } });
const C = await login(cPhone);

// Данные: товар, смена, продажи наличными и картой (терминал).
const hdr = { 'x-club-id': club };
const prod = await api('POST', `/api/clubs/${club}/catalog/products`, { token: A.token, headers: hdr, body: { name: 'Чай', price_kopecks: 15000 } });
await api('POST', `/api/clubs/${club}/shifts`, { token: A.token, headers: hdr, body: { float_kopecks: 100_000 } });
const s1 = await api('POST', '/api/pos/sales', { token: A.token, headers: hdr, idem: true, body: { items: [{ product_id: prod.json.id, qty: 2 }], method: 'cash', received_kopecks: 50_000 } });
const s2 = await api('POST', '/api/pos/sales', { token: A.token, headers: hdr, idem: true, body: { items: [{ product_id: prod.json.id, qty: 1 }], method: 'card_terminal' } });
check(results, 'подготовка: две продажи (наличные, карта терминала)', s1.status === 201 && s2.status === 201, `${s1.status}/${s2.status}`);

// GET-маршруты клуба для роли manager.
const routes = (await loadRoutes()).filter(
  (r) => r.method === 'GET' && r.auth === 'staff' && r.roles?.includes('manager') && /\{club\}/.test(r.path) && !/\{(?!club\})/.test(r.path) && !r.stream && r.networkManager !== false,
);
// by_method:null — это как раз скрытое поле (безопасно); by_method:{…} или значение — утечка.
const MONEY = /"(cash|card_terminal|sbp|card|expected_cash_kopecks|actual_cash_kopecks|cash_sales_kopecks|cash_refunds_kopecks|discrepancy_kopecks)"|"by_method":\{|"method":"(cash|card|sbp|card_terminal)"/;
const leaks = [];
const ownerHas = [];
for (const r of routes) {
  const path = r.path.replace('{club}', club);
  const own = await api('GET', path, { token: A.token });
  const net = await api('GET', path, { token: M.token });
  if (own.status === 200 && MONEY.test(own.text)) ownerHas.push(r.path);
  if (net.status === 200 && MONEY.test(net.text)) leaks.push(`${r.path} [${(net.text.match(MONEY) ?? [''])[0].slice(0, 40)}]`);
}
console.log(`INFO  маршрутов обойдено: ${routes.length}; у владельца деньги по способам видны в: ${ownerHas.length}`);
check(results, 'управляющий сети: ни один из обойдённых GET-маршрутов не отдаёт деньги по способам оплаты', leaks.length === 0, leaks.join('; ') || 'чисто');

// Детали по самым вероятным: смена и продажи кассы.
{
  const cur = await api('GET', `/api/clubs/${club}/shifts/current`, { token: M.token });
  const list = await api('GET', `/api/clubs/${club}/shifts`, { token: M.token });
  const sales = await api('GET', `/api/clubs/${club}/pos/sales`, { token: M.token });
  const sale = await api('GET', `/api/pos/sales/${s1.json?.sale_id}`, { token: M.token, headers: hdr });
  console.log(`INFO  shifts/current=${cur.status} shifts=${list.status} pos/sales=${sales.status} pos/sales/{id}=${sale.status}`);
  const shiftId = cur.json?.shift?.id ?? list.json?.items?.[0]?.id;
  const rep = shiftId ? await api('GET', `/api/shifts/${shiftId}/report?online=0`, { token: M.token, headers: hdr }) : { status: 0, text: '' };
  const one = shiftId ? await api('GET', `/api/shifts/${shiftId}`, { token: M.token, headers: hdr }) : { status: 0, text: '' };
  console.log(`INFO  shifts/{id}/report=${rep.status} shifts/{id}=${one.status}`);
  const probes = { 'shifts/current': cur, 'shifts (список)': list, 'pos/sales (список)': sales, 'pos/sales/{id}': sale, 'shifts/{id}/report': rep, 'shifts/{id}': one };
  const bad = Object.entries(probes).filter(([, r]) => r.status === 200 && MONEY.test(r.text)).map(([k, r]) => `${k}: ${(r.text.match(MONEY) ?? [''])[0].slice(0, 40)}`);
  check(results, 'смена, список продаж, продажа, отчёт смены: без денег по способам для управляющего сети', bad.length === 0, bad.join('; ') || 'чисто');
}

// Контроль: обычный управляющий клуба (вне сети) — те же маршруты; так задумано (№166).
{
  const cur = await api('GET', `/api/clubs/${club2}/shifts/current`, { token: C.token });
  console.log(`INFO  контроль: управляющий клуба вне сети: shifts/current=${cur.status}`);
}

process.exit(summary(results).length ? 1 : 0);
