// PoC M5.5 — обход GET-маршрутов клуба для роли manager: что видит управляющий сети из денег по способам оплаты
// (№192, №214, №218; «без денег по способам оплаты», как №166). Заход 2: после bc51e24 сценарий должен быть зелёным.
//
// Метод: в тестовом клубе сети владелец открывает смену и делает продажи наличными и картой терминала, возврат
// наличных; затем те же GET-маршруты вызывают управляющий сети, управляющий клуба и владелец. Структурная проверка
// ответа: ключи фильтра (method, methods, payment_method, by_method, cash_sales_kopecks, cash_refunds_kopecks,
// received_kopecks, change_kopecks) обязаны быть null, значения-способы ('cash', 'card_terminal', 'sbp', 'card')
// не встречаются в строках. Управляющий клуба и владелец — способы видны (фильтр не ломает работу). Остаются итоги,
// размен, «ожидалось» наличных (по решению №218) — это оценивается в 16-method-filter-sweep как остаточный риск.
//
// Запуск: node tests/security/m5-5/11-network-manager-money-sweep.test.mjs

import { loadRoutes } from '../../../api/router.mjs';
import { addClub, api, check, createClub, createNetwork, login, phone2, RUN, summary } from './_helpers.mjs';

const results = [];
const A = await login(phone2());
const club = await createClub(A.token, { name: `S1 ${RUN}` });
const club2 = await createClub(A.token, { name: `S2 ${RUN}` });
const NA = await createNetwork(A.token, `NS ${RUN}`);
await addClub(A.token, NA, club);
await addClub(A.token, NA, club2);

const mPhone = phone2();
await api('POST', `/api/networks/${NA}/managers`, { token: A.token, body: { phone: mPhone } });
const M = await login(mPhone);

// Управляющий клуба (прямой) в том же клубе.
const cPhone = phone2();
await api('POST', `/api/clubs/${club}/staff`, { token: A.token, headers: { 'x-club-id': club }, body: { phone: cPhone, role: 'manager' } });
const C = await login(cPhone);

const hdr = { 'x-club-id': club };
const prod = await api('POST', `/api/clubs/${club}/catalog/products`, { token: A.token, headers: hdr, body: { name: 'Чай', price_kopecks: 15000 } });
await api('POST', `/api/clubs/${club}/shifts`, { token: A.token, headers: hdr, body: { float_kopecks: 100_000 } });
const s1 = await api('POST', '/api/pos/sales', { token: A.token, headers: hdr, idem: true, body: { items: [{ product_id: prod.json.id, qty: 2 }], method: 'cash', received_kopecks: 50_000 } });
const s2 = await api('POST', '/api/pos/sales', { token: A.token, headers: hdr, idem: true, body: { items: [{ product_id: prod.json.id, qty: 1 }], method: 'card_terminal' } });
check(results, 'подготовка: две продажи (наличные, карта терминала)', s1.status === 201 && s2.status === 201, `${s1.status}/${s2.status}`);
const sale1 = await api('GET', `/api/pos/sales/${s1.json.sale_id}`, { token: A.token, headers: hdr });
const rf = await api('POST', `/api/pos/sales/${s1.json.sale_id}/refund`, { token: A.token, headers: hdr, idem: true, body: { reason: 'тест', items: [{ order_item_id: sale1.json.items[0].order_item_id, qty: 1 }] } });
check(results, 'подготовка: возврат одной штуки наличными', rf.status === 201, `status=${rf.status}`);

const HIDDEN = new Set(['method', 'methods', 'payment_method', 'by_method', 'cash_sales_kopecks', 'cash_refunds_kopecks', 'received_kopecks', 'change_kopecks']);
const VALUES = new Set(['cash', 'card_terminal', 'sbp', 'card']);
/** Нарушения фильтра: не-null ключи из списка и значения-способы. */
function violations(v, path = '', out = []) {
  if (Array.isArray(v)) v.forEach((x, i) => violations(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (HIDDEN.has(k) && x !== null) out.push(`${path}.${k}`);
      else violations(x, `${path}.${k}`, out);
    }
  } else if (typeof v === 'string' && VALUES.has(v)) out.push(`${path}=${v}`);
  return out;
}

// GET-маршруты клуба для роли manager.
const routes = (await loadRoutes()).filter(
  (r) => r.method === 'GET' && r.auth === 'staff' && r.roles?.includes('manager') && /\{club\}/.test(r.path) && !/\{(?!club\})/.test(r.path) && !r.stream && r.networkManager !== false,
);
const leaks = [];
const ownerHas = [];
const clubMgrHas = [];
for (const r of routes) {
  const path = r.path.replace('{club}', club);
  const own = await api('GET', path, { token: A.token });
  const net = await api('GET', path, { token: M.token });
  const cm = await api('GET', path, { token: C.token });
  if (own.status === 200 && violations(own.json).length) ownerHas.push(r.path);
  if (cm.status === 200 && violations(cm.json).length) clubMgrHas.push(r.path);
  if (net.status === 200) {
    const v = violations(net.json);
    if (v.length) leaks.push(`${r.path} [${v.slice(0, 3).join(', ')}]`);
  }
}
console.log(`INFO  маршрутов обойдено: ${routes.length}; способы видны у владельца в ${ownerHas.length}, у управляющего клуба в ${clubMgrHas.length}`);
check(results, 'управляющий сети: ни один из обойдённых GET-маршрутов не отдаёт способ оплаты (ключи фильтра = null, значений-способов нет)', leaks.length === 0, leaks.join('; ') || 'чисто');
check(results, 'владелец и управляющий клуба: способы видны (фильтр не ломает работу)', ownerHas.length >= 3 && clubMgrHas.length >= 3 && clubMgrHas.length === ownerHas.length, `${ownerHas.length}/${clubMgrHas.length}`);

// Детали по смене и продажам.
{
  const cur = await api('GET', `/api/clubs/${club}/shifts/current`, { token: M.token });
  const list = await api('GET', `/api/clubs/${club}/shifts`, { token: M.token });
  const sales = await api('GET', `/api/clubs/${club}/pos/sales`, { token: M.token });
  const sale = await api('GET', `/api/pos/sales/${s1.json?.sale_id}`, { token: M.token, headers: hdr });
  const shiftId = cur.json?.shift?.id ?? list.json?.items?.[0]?.id;
  const rep = shiftId ? await api('GET', `/api/shifts/${shiftId}/report?online=0`, { token: M.token, headers: hdr }) : { status: 0, text: '', json: null };
  const one = shiftId ? await api('GET', `/api/shifts/${shiftId}`, { token: M.token, headers: hdr }) : { status: 0, text: '', json: null };
  const audit = await api('GET', `/api/clubs/${club}/audit?limit=100`, { token: M.token });
  console.log(`INFO  shifts/current=${cur.status} shifts=${list.status} pos/sales=${sales.status} pos/sales/{id}=${sale.status} report=${rep.status} shifts/{id}=${one.status} audit=${audit.status}`);
  const probes = { 'shifts/current': cur, 'shifts (список)': list, 'pos/sales (список)': sales, 'pos/sales/{id}': sale, 'shifts/{id}/report': rep, 'shifts/{id}': one, audit };
  const bad = Object.entries(probes).filter(([, r]) => r.status === 200 && violations(r.json).length).map(([k, r]) => `${k}: ${violations(r.json).slice(0, 3).join(',')}`);
  check(results, 'смена, список продаж, продажа, отчёт смены, журнал: способы скрыты для управляющего сети', bad.length === 0 && [cur, sales, sale, rep, audit].every((r) => r.status === 200), bad.join('; ') || 'чисто');
  check(results, 'сверка кассы остаётся (ожидалось наличных есть) — решение №218', typeof cur.json?.shift?.expected_cash_kopecks === 'number', `expected=${cur.json?.shift?.expected_cash_kopecks}`);
  // У управляющего клуба и владельца — наличные видны.
  const cCur = await api('GET', `/api/clubs/${club}/shifts/current`, { token: C.token });
  const oCur = await api('GET', `/api/clubs/${club}/shifts/current`, { token: A.token });
  // Тестовый клуб на стенде не считает наличные в сменах (is_test): поле есть (число, не null), сумма — в 16-method-filter-sweep.
  check(results, 'управляющий клуба и владелец видят поле наличных смены (число), у управляющего сети — null', typeof cCur.json?.shift?.cash_sales_kopecks === 'number' && typeof oCur.json?.shift?.cash_sales_kopecks === 'number' && cur.json?.shift?.cash_sales_kopecks === null, `${cCur.json?.shift?.cash_sales_kopecks}/${oCur.json?.shift?.cash_sales_kopecks}/${cur.json?.shift?.cash_sales_kopecks}`);
  const cSales = await api('GET', `/api/clubs/${club}/pos/sales`, { token: C.token });
  check(results, 'управляющий клуба видит способ в списке продаж', (cSales.json.items ?? cSales.json).some((x) => x.method === 'cash'), '');
}

// «Все клубы» и вкладка «Деньги»: параметры-обходы.
{
  const tricks = [
    `/api/clubs/${club}/dashboard?tab=money`,
    `/api/clubs/${club}/dashboard?tab=Money`,
    `/api/clubs/${club}/dashboard?tab=%6Doney`,
    `/api/clubs/${club}/dashboard?tab=money&tab=summary`,
    `/api/clubs/${club}/dashboard?tab=summary&tab=money`,
    `/api/clubs/${club}/dashboard?tab[]=money`,
    `/api/clubs/${club}/dashboard?tab=%20money`,
    `/api/clubs/all/dashboard?tab=money`,
    `/api/clubs/all/dashboard?tab=money&tab=summary`,
    `/api/clubs/${club}/dashboard/export.csv?table=summary`,
    `/api/clubs/all/dashboard/export.csv?table=summary`,
    `/api/clubs/${club}/history/orders/export.csv`,
    `/api/clubs/all/history/orders/export.csv`,
    `/api/clubs/${club}/shifts/export.csv`,
    `/api/clubs/${club}/cashbook/export.csv`,
  ];
  const odd = [];
  for (const t of tricks) {
    const r = await api('GET', t, { token: M.token });
    // Допустимо: 403/400/404; недопустимо: 200 с денежной вкладкой или CSV.
    const moneyBody = r.status === 200 && (/cash_net|cashless_net|"methods"|"by_method":\{/.test(r.text) || /csv/.test(r.headers['content-type'] ?? ''));
    if (moneyBody) odd.push(`${t} → ${r.status}`);
  }
  check(results, 'обходы вкладки «Деньги» и экспорта (регистр, дубли tab, %-кодирование, all): ни одного 200 с деньгами/CSV', odd.length === 0, odd.join('; ') || `${tricks.length} запросов`);
}

process.exit(summary(results).length ? 1 : 0);
