// PoC M5.5, заход 2 — Н-3: фильтр hideMoneyMethods (№218). Полный обход GET-маршрутов API управляющим сети на СВОЁМ
// временном Postgres с настоящим роутером (обвязка server/orders/test/db/harness.mjs) и реальными данными:
// продажи наличными, картой терминала и СБП, возврат наличными, заявка ресепшена, заказ гостя онлайн, пакет часов,
// счёт стола, смена. Данные содержат «метки» — суммы, встречающиеся только у наличных/безналичных операций.
//
// Для каждого GET-маршрута (с подстановкой id из базы) сравнивается ответ владельца и управляющего сети:
//  * ключи из списка фильтра с не-null значением;
//  * значения-способы ('cash', 'card_terminal', 'sbp', 'card', 'reception', 'yookassa') в любом поле;
//  * суммы-метки в тексте ответа;
//  * слова «наличн», «карт», «СБП», «сдач» в строках (журнал, тревоги, комментарии);
//  * ключи с подозрительными именами (cash/card/sbp/tender/payment/paid/change/received/method) с не-null значением.
// Печатает таблицу находок (INFO) и проверяет итоговые утверждения.
//
// Запуск (только свой Postgres на 127.0.0.1:55xxx!):
//   DATABASE_ADMIN_URL=postgres://postgres@127.0.0.1:55432/postgres node --test tests/security/m5-5/16-method-filter-sweep.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { loadRoutes } from '../../../api/router.mjs';
import { CLUB_A, newKey, P, PHONES, setup } from '../../../server/orders/test/db/harness.mjs';

const ADMIN = process.env.DATABASE_ADMIN_URL ?? '';
const SKIP = !/@(127\.0\.0\.1|localhost):55\d{3}\//.test(ADMIN);
if (SKIP) console.log('SKIP: задайте DATABASE_ADMIN_URL=postgres://postgres@127.0.0.1:55xxx/postgres (свой временный Postgres)');

const BASE = ['auth.mjs', 'catalog.mjs', 'orders.mjs', 'pos.mjs', 'stock.mjs', 'reception.mjs', 'webhooks.mjs', 'payments.mjs'];
const ALL_FILES = fs.readdirSync(new URL('../../../api/routes/', import.meta.url)).filter((f) => f.endsWith('.mjs'));
const EXTRA = ALL_FILES.filter((f) => !BASE.includes(f));

const NM_PHONE = '+79990000401';
const HIDDEN_KEYS = new Set(['method', 'methods', 'payment_method', 'by_method', 'cash_sales_kopecks', 'cash_refunds_kopecks', 'received_kopecks', 'change_kopecks']);
const METHOD_VALUES = new Set(['cash', 'card_terminal', 'sbp', 'card', 'yookassa']);
const SUSPECT_KEY = /cash|card|sbp|tender|payment|paid|change|received|method|nal\b|terminal|provider|channel|acquir/i;
const WORDS = /налич|карт[аыуойе]\b|карточ|сбп|\bsbp\b|терминал|сдач|cash|tender/i;

let h;
let owner;
let manager;
let reception;
let nm;
let net;
const ctx = { marks: {}, ids: new Set() };

const req = (method, path, who, body, extra = {}) => h.request(method, path, { token: who.token, body, club: CLUB_A, ...extra });
const sale = (who, body) => h.request('POST', '/api/pos/sales', { token: who.token, body, key: newKey(), club: CLUB_A });

before(async () => {
  if (SKIP) return;
  h = await setup({ extraRoutes: EXTRA });
  owner = await h.login(PHONES.owner);
  manager = await h.login(PHONES.manager);
  reception = await h.login(PHONES.reception);
  await h.openShift();
  const created = await req('POST', '/api/networks', owner, { name: 'Сеть Ф' }, { club: undefined });
  net = created.json.id;
  assert.equal((await req('POST', `/api/networks/${net}/clubs`, owner, { club_id: CLUB_A }, { club: undefined })).status, 201);
  const inv = await req('POST', `/api/networks/${net}/managers`, owner, { phone: NM_PHONE }, { club: undefined });
  assert.equal(inv.status, 201, JSON.stringify(inv.json));
  nm = await h.login(NM_PHONE);
});
after(async () => {
  await h?.close();
});

describe('Н-3 (заход 2): данные для обхода', { skip: SKIP }, () => {
  it('наличные, терминал, СБП, возврат наличных, пакет, счёт стола, заявка ресепшена, заказ гостя онлайн', async () => {
    const guest = await h.login('+79990000412');
    // Наличные: метка «получено» 777 ₽ (77700 коп.), сдача — 77700 − 27000 = 50700.
    const cash = await sale(reception, { items: [{ product_id: P.water, qty: 3 }], method: 'cash', received_kopecks: 77700, comment: 'метка-нал' });
    assert.equal(cash.status, 201, JSON.stringify(cash.json));
    ctx.marks.cash = { total: cash.json.total_kopecks, received: 77700, change: 77700 - cash.json.total_kopecks, id: cash.json.sale_id };
    // Карта терминала: количество 7 — сумма-метка.
    const card = await sale(reception, { items: [{ product_id: P.chips, qty: 7 }], method: 'card_terminal' });
    assert.equal(card.status, 201, JSON.stringify(card.json));
    ctx.marks.card = { total: card.json.total_kopecks, id: card.json.sale_id };
    // СБП (QR ЮKassa на экране): подтверждение через эмулятор.
    const sbp = await sale(reception, { items: [{ product_id: P.nuts, qty: 4 }], method: 'sbp', customer_phone: '+79990000412' });
    assert.ok(sbp.status === 201 || sbp.status === 200, JSON.stringify(sbp.json));
    ctx.marks.sbp = { total: sbp.json.total_kopecks, id: sbp.json.sale_id };
    const pid = (await h.q('select provider_payment_id from bl.payments where id = (select payment_id from bl.pos_sales where id = $1)', [sbp.json.sale_id]))[0]?.provider_payment_id;
    if (pid) await h.emuSucceed(pid);
    await h.tick().catch(() => {});
    // Возврат наличных управляющим.
    const refund = await h.request('POST', `/api/pos/sales/${cash.json.sale_id}/refund`, { token: manager.token, body: { reason: 'вернули часть', items: [{ order_item_id: (await req('GET', `/api/pos/sales/${cash.json.sale_id}`, owner)).json.items[0].order_item_id, qty: 1 }] }, key: newKey(), club: CLUB_A });
    assert.equal(refund.status, 201, JSON.stringify(refund.json));
    // Пакет часов за наличные.
    const pkg = await req('POST', `/api/clubs/${CLUB_A}/packages`, manager, { title: 'Пакет Ф', hours: 3, price_kopecks: 123400, valid_days: 30, reason: 'проверка' });
    if (pkg.status === 201) {
      const ps = await sale(reception, { items: [{ kind: 'package', package_id: pkg.json.id, phone: '+79990000412' }], method: 'cash', received_kopecks: 200000 });
      ctx.marks.package = { status: ps.status, total: ps.json?.total_kopecks };
    }
    // Счёт стола и заказ гостя онлайн (карта/СБП).
    const sid = await h.session({ resourceId: 'e1000000-0000-4000-8000-000000000003', payer: guest.id });
    ctx.marks.session = sid;
    const o1 = await h.request('POST', '/api/orders', { token: guest.token, body: { session_id: sid, items: [{ product_id: P.teaBlack, qty: 2 }], pay: 'tab' }, key: newKey() });
    ctx.marks.tab = o1.status;
    const o2 = await h.request('POST', '/api/orders', { token: guest.token, body: { session_id: sid, items: [{ product_id: P.americano, qty: 3 }], pay: 'online' }, key: newKey() });
    ctx.marks.online = { status: o2.status, id: o2.json?.order?.id, payment: o2.json?.payment_id ?? o2.json?.payment?.id };
    const online = (await h.q("select provider_payment_id from bl.payments where provider = 'yookassa' and status = 'pending' order by created_at desc limit 1"))[0];
    if (online?.provider_payment_id) await h.emuSucceed(online.provider_payment_id);
    // Заявка ресепшена: принята наличными.
    const rid = await h.receptionRequest({ resourceId: 'e1000000-0000-4000-8000-000000000004', userId: guest.id, amount: 66600 });
    const acc = await h.request('POST', `/api/reception/requests/${rid}/accept`, { token: reception.token, body: { method: 'cash', received_kopecks: 70000 }, key: newKey(), club: CLUB_A });
    ctx.marks.request = { status: acc.status, id: rid, json: JSON.stringify(acc.json).slice(0, 200) };
    console.log('INFO  метки:', JSON.stringify(ctx.marks));
  });

  it('у владельца способы видны, у управляющего сети — нет в смене, списке продаж, продаже', async () => {
    const own = await req('GET', `/api/clubs/${CLUB_A}/pos/sales`, owner);
    const net_ = await req('GET', `/api/clubs/${CLUB_A}/pos/sales`, nm);
    const ownMethods = new Set((own.json.items ?? own.json).map((x) => x.method));
    assert.ok(ownMethods.has('cash') && ownMethods.has('card_terminal'), [...ownMethods].join());
    assert.ok((net_.json.items ?? net_.json).every((x) => x.method === null));
  });
});

/** Все пути (глубина) значений, где фильтр пропустил способ оплаты. */
function scan(value, path = '', out = { keys: [], values: [], suspect: [], words: [] }) {
  if (Array.isArray(value)) {
    value.forEach((x, i) => scan(x, `${path}[${i}]`, out));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const at = `${path}.${k}`;
      if (HIDDEN_KEYS.has(k) && v !== null) out.keys.push(at);
      else if (SUSPECT_KEY.test(k) && v !== null && v !== undefined && typeof v !== 'object') out.suspect.push(`${at}=${JSON.stringify(v)}`);
      scan(v, at, out);
    }
    return out;
  }
  if (typeof value === 'string') {
    if (METHOD_VALUES.has(value)) out.values.push(`${path}=${value}`);
    else if (WORDS.test(value)) out.words.push(`${path}=${value.slice(0, 90)}`);
  }
  return out;
}

describe('Н-3 (заход 2): обход всех GET-маршрутов', { skip: SKIP }, () => {
  it('сбор id, обход, сравнение владельца и управляющего сети', async () => {
    // Пул id из базы.
    const tables = ['pos_sales', 'shifts', 'payments', 'pos_refunds', 'orders', 'sessions', 'reception_requests', 'resources', 'products', 'receipts', 'bookings', 'refunds', 'tariff_package_lots', 'quotes', 'stock_audits', 'webhooks', 'alarms', 'audit_log'];
    const pool = new Set();
    for (const t of tables) {
      const rows = await h.q(`select id::text from bl.${t} limit 15`).catch(() => []);
      rows.forEach((r) => /^[0-9a-f-]{36}$/.test(r.id) && pool.add(r.id));
    }
    pool.add(net);
    const routes = (await loadRoutes({ config: h.config, only: ALL_FILES })).filter(
      (r) => r.method === 'GET' && (r.auth === 'staff' || r.auth === 'guest') && !r.stream && r.path !== '/api/stream' && r.networkManager !== false,
    );
    const KINDS = ['sales', 'payments', 'refunds', 'shifts', 'cash', 'orders', 'sessions', 'bookings', 'requests'];
    const findings = [];
    let reached = 0;
    let ownerSeen = 0;
    const perRoute = [];
    for (const r of routes) {
      const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((p) => p !== 'club');
      const candidates = [];
      if (params.length === 0) candidates.push(r.path.replace('{club}', CLUB_A));
      else if (params.length === 1 && params[0] === 'kind') for (const k of KINDS) candidates.push(r.path.replace('{club}', CLUB_A).replace('{kind}', k));
      else if (params.length === 1 && (params[0] === 'id' || params[0].endsWith('_id'))) for (const id of pool) candidates.push(r.path.replace('{club}', CLUB_A).replace(`{${params[0]}}`, id));
      else continue;
      for (const path of candidates) {
        if (/^\/api\/networks/.test(path)) continue; // маршруты сети — в 02/08/12 первого захода
        const o = await req('GET', path, owner);
        if (o.status !== 200) continue;
        ownerSeen += 1;
        const n = await req('GET', path, nm);
        if (n.status !== 200) {
          perRoute.push(`${r.path} → NM ${n.status}`);
          continue;
        }
        reached += 1;
        const s = scan(n.json);
        const raw = JSON.stringify(n.json);
        const markHits = [];
        for (const [name, m] of Object.entries(ctx.marks)) {
          for (const key of ['received', 'change']) if (m && typeof m === 'object' && m[key] && raw.includes(`:${m[key]},`) || (m?.[key] && raw.includes(`:${m[key]}}`))) markHits.push(`${name}.${key}`);
        }
        if (s.keys.length || s.values.length || s.suspect.length || s.words.length || markHits.length) {
          findings.push({ route: r.path, path, keys: s.keys.slice(0, 5), values: s.values.slice(0, 5), suspect: s.suspect.slice(0, 8), words: s.words.slice(0, 5), marks: markHits });
        }
      }
    }
    for (const line of perRoute.slice(0, 20)) console.log('INFO  не 200 у управляющего сети:', line);
    console.log(`INFO  маршрутов: ${routes.length}; ответов владельца 200: ${ownerSeen}; тех же ответов управляющему сети 200: ${reached}`);
    for (const f of findings) console.log('FINDING', JSON.stringify(f));
    ctx.findings = findings;
    assert.ok(reached >= 30, `обойдено ${reached}`);
  });

  it('никаких ключей из списка фильтра с не-null значением и значений-способов у управляющего сети', () => {
    const bad = (ctx.findings ?? []).filter((f) => f.keys.length || f.values.length || f.marks.length);
    assert.deepEqual(bad, []);
  });
});

describe('Н-3 (заход 2): разность полей — наличные по способам из оставшихся итогов', { skip: SKIP }, () => {
  it('expected_cash − размен = наличные − возвраты; итог выручки − наличные = безналичные (оценка: остаточный риск №218)', async () => {
    const cur = await req('GET', `/api/clubs/${CLUB_A}/shifts/current`, nm);
    const ownCur = await req('GET', `/api/clubs/${CLUB_A}/shifts/current`, owner);
    const shiftId = cur.json.shift.id;
    const rep = await req('GET', `/api/shifts/${shiftId}/report?online=0`, nm);
    const ownRep = await req('GET', `/api/shifts/${shiftId}/report?online=0`, owner);
    console.log('INFO  смена (управляющий сети):', JSON.stringify(cur.json.shift));
    console.log('INFO  отчёт: revenue =', JSON.stringify(rep.json.revenue), ' cash =', JSON.stringify(rep.json.cash));
    const float = cur.json.shift.float_kopecks;
    const derivedCashNet = cur.json.shift.expected_cash_kopecks - float;
    const trueCashNet = ownCur.json.shift.cash_sales_kopecks - ownCur.json.shift.cash_refunds_kopecks;
    const total = rep.json.revenue.total_kopecks;
    console.log(`INFO  выведено без поля способа: наличные нетто = ${derivedCashNet} (истина у владельца ${trueCashNet}); итого выручка = ${total}; безналичные ≈ ${total - derivedCashNet}`);
    console.log('INFO  у владельца отчёт:', JSON.stringify(ownRep.json.revenue?.by_method));
    assert.equal(derivedCashNet, trueCashNet, 'разность выдаёт наличные точно');
  });
});

describe('Н-3 (заход 2): поля, из которых можно вывести способ (справочно)', { skip: SKIP }, () => {
  it('kkt/receipts, история, заявки, аудит: что видит управляющий сети', async () => {
    const show = async (label, path, pick) => {
      const own = await req('GET', path, owner);
      const n = await req('GET', path, nm);
      const arr = (v) => (Array.isArray(v) ? v : v?.items ?? v?.entries ?? []);
      const a = arr(n.json);
      console.log(`INFO  ${label}: NM ${n.status}, записей ${a.length}, владелец ${own.status}`);
      for (const x of a.slice(0, 40)) if (!pick || pick(x)) { console.log(`INFO    ключи: ${Object.keys(x).join(',')}`); break; }
      return n;
    };
    const rec = await show('kkt/receipts', `/api/clubs/${CLUB_A}/kkt/receipts`);
    const cats = new Set((rec.json.items ?? rec.json).map((x) => `${x.channel ?? ''}/${x.kind ?? ''}/${x.status ?? ''}`));
    console.log('INFO  kkt/receipts channel/kind/status у управляющего сети:', [...cats].join(' | '));
    const hist = await show('history/orders', `/api/clubs/${CLUB_A}/history/orders`);
    console.log('INFO  history/orders[0]:', JSON.stringify((hist.json.items ?? [])[0]).slice(0, 500));
    await show('reception/requests', `/api/clubs/${CLUB_A}/reception/requests`);
    const aud = await req('GET', `/api/clubs/${CLUB_A}/audit?limit=100`, nm);
    const ownAud = await req('GET', `/api/clubs/${CLUB_A}/audit?limit=100`, owner);
    const pick = (r, a) => (r.json.items ?? []).filter((i) => i.action === a).map((i) => JSON.stringify(i.data).slice(0, 220));
    for (const a of ['pos.sale', 'payment.succeeded', 'pos.refund', 'order.paid', 'reception.accept']) {
      console.log(`INFO  audit ${a}: NM ${pick(aud, a)[0] ?? '—'}\n INFO    владелец ${pick(ownAud, a)[0] ?? '—'}`);
    }
  });
});
