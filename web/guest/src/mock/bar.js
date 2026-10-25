/*
 * BL_MOCK_MARKER — заглушка бара гостя по контракту m2 §4–§5 и виду ответов backend-pos (server/orders/README.md),
 * только для разработки (VITE_MOCK=1). Меню гостя без алкоголя (№76): сервер его не отдаёт и заказ с ним — 404.
 */

const MIN = 60_000;
const uuid = () => globalThis.crypto.randomUUID();
const id = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;

const mod = (n, name, rub = 0, isDefault = false) => ({ id: id('a0000001', n), name, price_delta_kopecks: rub * 100, is_default: isDefault });
const VOL = { id: id('b0000001', 1), name: 'Объём', min_select: 1, max_select: 1, modifiers: [mod(1, '0,3 л', 0, true), mod(2, '0,4 л', 40)] };
const SUGAR = { id: id('b0000001', 2), name: 'Сахар', min_select: 1, max_select: 1, modifiers: [mod(3, 'Без сахара', 0, true), mod(4, '1 ложка'), mod(5, '2 ложки')] };
const MILK = { id: id('b0000001', 3), name: 'Молоко', min_select: 1, max_select: 1, modifiers: [mod(6, 'Обычное', 0, true), mod(7, 'Овсяное', 50)] };
const TEA = { id: id('b0000001', 4), name: 'Чайник', min_select: 1, max_select: 1, modifiers: [mod(8, '0,6 л', 0, true), mod(9, '1 л', 120)] };
const SAUCE = { id: id('b0000001', 5), name: 'Соус', min_select: 0, max_select: 2, modifiers: [mod(10, 'Кетчуп', 30), mod(11, 'Сырный', 40), mod(12, 'Чесночный', 40)] };

const p = (n, name, rub, groups = [], extra = {}) => ({ id: id('d0000001', n), name, description: null, price_kopecks: rub * 100, unit: 'шт', photo: null, available: true, stop_list: false, modifier_groups: groups, ...extra });

/** Меню гостя как menuFor(audience: guest) backend-pos: категории с товарами, без алкоголя и без остатков. */
export const GUEST_MENU = {
  club_id: '0b6b8c1e-5a7d-4f0e-9c3a-2d1e4f5a6b7c',
  audience: 'guest',
  alcohol_hidden: true,
  categories: [
    { id: id('c0000001', 1), name: 'Кофе и чай', products: [p(1, 'Американо', 180, [VOL, SUGAR]), p(2, 'Капучино', 220, [VOL, MILK, SUGAR]), p(3, 'Латте', 240, [VOL, MILK, SUGAR]), p(4, 'Эспрессо', 150, [SUGAR]), p(5, 'Чай чёрный', 250, [TEA]), p(6, 'Облепиховый чай', 320, [TEA])] },
    { id: id('c0000001', 2), name: 'Напитки', products: [p(7, 'Вода без газа, 0,5 л', 90), p(8, 'Кола, 0,33 л', 150), p(9, 'Морс клюквенный, 0,4 л', 160, [], { stop_list: true, available: false }), p(10, 'Лимонад домашний, 0,4 л', 220)] },
    { id: id('c0000001', 3), name: 'Еда', products: [p(11, 'Сэндвич с курицей', 320), p(12, 'Картофель фри', 250, [SAUCE]), p(13, 'Орешки солёные', 150), p(14, 'Чипсы', 160, [], { available: false }), p(15, 'Пицца «Маргарита»', 590)] },
    { id: id('c0000001', 5), name: 'Для игры', products: [p(19, 'Мел для кия', 100), p(20, 'Перчатка бильярдная', 450)] },
  ],
};
// Алкоголь клуба (виден только кассе): заказ со стола — 404 not_found (№76)
const ALCOHOL = new Set([id('d0000001', 16), id('d0000001', 17), id('d0000001', 18)]);

const PRODUCTS = new Map(GUEST_MENU.categories.flatMap((c) => c.products.map((x) => [x.id, x])));
const BY_NAME = new Map([...PRODUCTS.values()].map((x) => [x.name, x]));
const MOD_BY_NAME = new Map([VOL, SUGAR, MILK, TEA, SAUCE].flatMap((g) => g.modifiers.map((m) => [m.name, m])));

function line(product, qty, modIds) {
  const groups = product.modifier_groups;
  const picked = [];
  for (const g of groups) {
    let sel = g.modifiers.filter((m) => modIds.includes(m.id));
    if (!sel.length && g.min_select > 0) sel = g.modifiers.filter((m) => m.is_default);
    if (sel.length < g.min_select || sel.length > g.max_select) return null;
    picked.push(...sel);
  }
  const unit = product.price_kopecks + picked.reduce((s, m) => s + m.price_delta_kopecks, 0);
  // Имя для чека — с модификаторами, как server/catalog/api.mjs
  const name = [product.name, ...picked.map((m) => m.name)].join(', ').slice(0, 128);
  return { id: uuid(), product_id: product.id, product_name: product.name, name, qty, unit_price_kopecks: unit, amount_kopecks: unit * qty, modifiers: picked.map((m) => ({ id: m.id, name: m.name })) };
}

/** Заказ для сценариев: [название, кол-во, [модификаторы]]. */
function seedOrder(state, { number, session, table, status, minAgo, pay, items, t, court = false }) {
  const lines = items.map(([name, qty, mods = []]) => line(BY_NAME.get(name), qty, mods.map((m) => MOD_BY_NAME.get(m).id)));
  const at = new Date(t - minAgo * MIN).toISOString();
  const o = {
    id: uuid(),
    number,
    source: 'qr',
    status,
    pay_mode: pay,
    paid: pay !== 'tab',
    awaiting_payment: false,
    session_id: session,
    resource: { id: id('00000000', table), number: table, ...(court ? { type: 'padel_court', family: 'court' } : {}) },
    items: lines,
    subtotal_kopecks: lines.reduce((s, l) => s + l.amount_kopecks, 0),
    comment: null,
    payment_id: null,
    sale_id: null,
    created_at: at,
    status_at: at,
    paid_at: pay === 'tab' ? null : at,
    canceled_at: null,
    committed_ms: t - minAgo * MIN,
    fixed: true, // статусы сценария не двигаются сами
  };
  state.bar.orders[o.id] = o;
  return o;
}

export function barSeed(state, name, t, sessionId) {
  state.bar = { orders: {}, next: 42 };
  if (name === 'barorders') {
    seedOrder(state, { number: 39, session: sessionId, table: 4, status: 'served', minAgo: 41, pay: 'tab', items: [['Кола, 0,33 л', 2], ['Орешки солёные', 1]], t });
    seedOrder(state, { number: 41, session: sessionId, table: 4, status: 'preparing', minAgo: 4, pay: 'tab', items: [['Капучино', 2, ['0,4 л', 'Овсяное', 'Без сахара']]], t });
    seedOrder(state, { number: 40, session: sessionId, table: 4, status: 'ready', minAgo: 9, pay: 'online', items: [['Чай чёрный', 1, ['1 л']], ['Сэндвич с курицей', 1]], t });
  }
  if (name === 'courtbar') {
    // Корт 1: заказы «в счёт корта» (Д2) — полоса бара в игре, счёт и корзина говорят «корт»
    seedOrder(state, { number: 39, session: sessionId, table: 1, status: 'served', minAgo: 41, pay: 'tab', items: [['Кола, 0,33 л', 2]], t, court: true });
    seedOrder(state, { number: 41, session: sessionId, table: 1, status: 'preparing', minAgo: 4, pay: 'tab', items: [['Капучино', 2, ['0,4 л', 'Овсяное', 'Без сахара']]], t, court: true });
  }
  if (name === 'closedtab') {
    seedOrder(state, { number: 33, session: sessionId, table: 4, status: 'served', minAgo: 70, pay: 'tab', items: [['Пицца «Маргарита»', 1], ['Вода без газа, 0,5 л', 2]], t });
    seedOrder(state, { number: 36, session: sessionId, table: 4, status: 'served', minAgo: 30, pay: 'tab', items: [['Лимонад домашний, 0,4 л', 2]], t });
  }
}

const view = ({ committed_ms: _c, fixed: _f, kind: _k, ...o }) => o;

/**
 * Маршруты бара гостя. ctx: { state(), now(), emit(sessionId, data, name), needUser(), sessionView(s), err, ok }.
 */
export function barRoutes(ctx) {
  const { err, ok } = ctx;
  const B = () => {
    ctx.state().bar ??= { orders: {}, next: 42 };
    return ctx.state().bar;
  };
  const orders = (sid) => Object.values(B().orders).filter((o) => o.session_id === sid);
  const openTab = (sid) => orders(sid).filter((o) => o.pay_mode === 'tab' && !o.paid && o.status !== 'canceled' && !o.awaiting_payment);

  /** Бар готовит сам: через 20 с — «Готовится», через минуту — «Готов», через 2,5 — «Выдан». */
  function tick() {
    const t = ctx.now();
    for (const o of Object.values(B().orders)) {
      if (o.fixed || o.awaiting_payment || o.status === 'canceled' || o.status === 'served') continue;
      const age = t - o.committed_ms;
      const next = age >= 150_000 ? 'served' : age >= 60_000 ? 'ready' : age >= 20_000 ? 'preparing' : 'new';
      if (next !== o.status) {
        Object.assign(o, { status: next, status_at: new Date(t).toISOString() });
        ctx.emit(o.session_id, view(o), 'order');
      }
    }
  }

  const pending = (sid) => Object.values(ctx.state().payments).find((x) => x.kind === 'tab' && x.session_id === sid && x.status === 'pending') ?? null;

  const routes = [
    ['GET', /^\/api\/clubs\/([^/]+)\/menu$/, () => ok(GUEST_MENU)],
    ['POST', /^\/api\/orders$/, (_m, b) => {
      const u = ctx.needUser();
      if (u) return u;
      const s = ctx.state().sessions[b.session_id];
      if (!s) return err(404, 'not_found');
      if (!['active', 'ending', 'grace'].includes(ctx.sessionView(s).status)) return err(409, 'session_not_active');
      if (!['tab', 'online'].includes(b.pay)) return err(400, 'bad_request');
      if (!Array.isArray(b.items) || !b.items.length) return err(400, 'bad_request');
      const lines = [];
      for (const it of b.items) {
        if (ALCOHOL.has(it.product_id)) return err(404, 'not_found');
        const prod = PRODUCTS.get(it.product_id);
        if (!prod) return err(404, 'not_found');
        if (prod.stop_list || prod.available === false) return err(409, 'stop_list');
        const l = line(prod, it.qty, it.modifier_ids ?? []);
        if (!l) return err(400, 'bad_request');
        lines.push(l);
      }
      const t = ctx.now();
      const table = ctx.sessionView(s).resource.number;
      const o = {
        id: uuid(),
        number: B().next++,
        source: 'qr',
        status: 'new',
        pay_mode: b.pay,
        paid: false,
        awaiting_payment: b.pay === 'online',
        session_id: s.id,
        resource: { id: id('00000000', table), number: table },
        items: lines,
        subtotal_kopecks: lines.reduce((acc, l) => acc + l.amount_kopecks, 0),
        comment: b.comment ?? null,
        payment_id: null,
        sale_id: null,
        created_at: new Date(t).toISOString(),
        status_at: new Date(t).toISOString(),
        paid_at: null,
        canceled_at: null,
        committed_ms: t,
      };
      B().orders[o.id] = o;
      if (b.pay === 'tab') {
        ctx.emit(s.id, view(o), 'order');
        return { status: 201, body: { order: view(o) } };
      }
      const pid = uuid();
      o.payment_id = pid;
      ctx.state().payments[pid] = { id: pid, kind: 'order', order_id: o.id, method: b.method ?? 'sbp', status: 'pending', amount_kopecks: o.subtotal_kopecks, return_url: `/app/orders/${o.id}` };
      return { status: 201, body: { order: view(o), payment: { payment_id: pid, sale_id: uuid(), status: 'pending', confirmation: { type: 'redirect', url: `/app/mock-pay/${pid}` } } } };
    }],
    ['GET', /^\/api\/orders\/([^/]+)$/, (m) => (B().orders[m[1]] ? ok(view(B().orders[m[1]])) : err(404, 'not_found'))],
    ['GET', /^\/api\/sessions\/([^/]+)\/orders$/, (m) => ok(orders(m[1]).map(view))],
    ['GET', /^\/api\/sessions\/([^/]+)\/tab$/, (m) => {
      const list = openTab(m[1]);
      const pay = pending(m[1]);
      return ok({ session_id: m[1], orders: list.map(view), total_kopecks: list.reduce((s, o) => s + o.subtotal_kopecks, 0), pending_payment: pay ? { sale_id: pay.id, payment_id: pay.id, total_kopecks: pay.amount_kopecks, confirmation: { type: 'redirect', url: `/app/mock-pay/${pay.id}` } } : null });
    }],
    ['POST', /^\/api\/sessions\/([^/]+)\/tab\/pay$/, (m, b) => {
      const u = ctx.needUser();
      if (u) return u;
      const list = openTab(m[1]);
      if (!list.length) return err(409, 'already_paid');
      const total = list.reduce((s, o) => s + o.subtotal_kopecks, 0);
      const pid = pending(m[1])?.id ?? uuid();
      ctx.state().payments[pid] = { id: pid, kind: 'tab', session_id: m[1], order_ids: list.map((o) => o.id), method: b.method ?? 'sbp', status: 'pending', amount_kopecks: total, return_url: `/app/sessions/${m[1]}/tab` };
      return ok({ sale_id: pid, payment_id: pid, status: 'pending', total_kopecks: total, confirmation: { type: 'redirect', url: `/app/mock-pay/${pid}` } });
    }],
  ];

  /** Подтверждение со страницы «ЮKassa» заглушки для платежей бара. */
  function confirm(payment, success) {
    const t = ctx.now();
    if (payment.kind === 'order') {
      const o = B().orders[payment.order_id];
      if (success) Object.assign(o, { awaiting_payment: false, paid: true, paid_at: new Date(t).toISOString(), committed_ms: t });
      else Object.assign(o, { status: 'canceled', awaiting_payment: false, canceled_at: new Date(t).toISOString() });
      ctx.emit(o.session_id, view(o), 'order');
    } else if (payment.kind === 'tab' && success) {
      for (const oid of payment.order_ids) Object.assign(B().orders[oid], { paid: true, paid_at: new Date(t).toISOString() });
      ctx.emit(payment.session_id, view(B().orders[payment.order_ids[0]]), 'order');
    }
    payment.status = success ? 'succeeded' : 'canceled';
  }

  return { routes, tick, confirm };
}
