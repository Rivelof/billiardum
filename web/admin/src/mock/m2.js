/*
 * BL_MOCK_MARKER — заглушка API M2 (касса, бар, смены, склад, меню, ККТ) по docs/contracts/m2.md §4–§5,
 * только для разработки (VITE_MOCK=1). Вид ответов — как у backend-pos (server/orders, server/catalog) и
 * backend-kkt (server/kkt, server/shifts) на 22.10.2026; поля сверх их кода — предложение frontend (README).
 * Сценарии: pos (смена открыта), noshift (смены нет — касса не продаёт), kktoff (касса ККТ не на связи; kktoff-owner — вошёл владелец), bar (бармен).
 */

import { menuFromCsv } from '../lib/csv.js';

const MIN = 60_000;
const uuid = () => globalThis.crypto.randomUUID();
const id = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;

const CATEGORIES = [
  { id: id('c0000001', 1), name: 'Кофе и чай', sort: 1, active: true },
  { id: id('c0000001', 2), name: 'Напитки', sort: 2, active: true },
  { id: id('c0000001', 3), name: 'Еда', sort: 3, active: true },
  { id: id('c0000001', 4), name: 'Пиво и сидр', sort: 4, active: true },
  { id: id('c0000001', 5), name: 'Для игры', sort: 5, active: true },
];
const [C_COFFEE, C_DRINKS, C_FOOD, C_BEER, C_GAME] = CATEGORIES.map((c) => c.id);

const m = (n, name, rub = 0, extra = {}) => ({ id: id('a0000001', n), name, price_delta_kopecks: rub * 100, stock_factor: 1, is_default: false, sort: n, active: true, ...extra });
const GROUPS = [
  { id: id('b0000001', 1), name: 'Объём', min_select: 1, max_select: 1, sort: 1, active: true, modifiers: [m(1, '0,3 л', 0, { is_default: true }), m(2, '0,4 л', 40, { stock_factor: 1.3 })] },
  { id: id('b0000001', 2), name: 'Сахар', min_select: 1, max_select: 1, sort: 2, active: true, modifiers: [m(3, 'Без сахара', 0, { is_default: true }), m(4, '1 ложка'), m(5, '2 ложки')] },
  { id: id('b0000001', 3), name: 'Молоко', min_select: 1, max_select: 1, sort: 3, active: true, modifiers: [m(6, 'Обычное', 0, { is_default: true }), m(7, 'Овсяное', 50)] },
  { id: id('b0000001', 4), name: 'Чайник', min_select: 1, max_select: 1, sort: 4, active: true, modifiers: [m(8, '0,6 л', 0, { is_default: true }), m(9, '1 л', 120)] },
  { id: id('b0000001', 5), name: 'Соус', min_select: 0, max_select: 2, sort: 5, active: true, modifiers: [m(10, 'Кетчуп', 30), m(11, 'Сырный', 40), m(12, 'Чесночный', 40)] },
];
const [G_VOL, G_SUGAR, G_MILK, G_TEA, G_SAUCE] = GROUPS.map((g) => g.id);
export const MOD = Object.fromEntries(GROUPS.flatMap((g) => g.modifiers.map((x) => [x.name, x.id])));

// [n, категория, название, цена ₽, группы, остаток (null — не учитываем), себестоимость ₽, флаги]
const PRODUCTS = [
  [1, C_COFFEE, 'Американо', 180, [G_VOL, G_SUGAR], null, 38],
  [2, C_COFFEE, 'Капучино', 220, [G_VOL, G_MILK, G_SUGAR], null, 52],
  [3, C_COFFEE, 'Латте', 240, [G_VOL, G_MILK, G_SUGAR], null, 56],
  [4, C_COFFEE, 'Эспрессо', 150, [G_SUGAR], null, 30],
  [5, C_COFFEE, 'Чай чёрный', 250, [G_TEA], null, 25],
  [6, C_COFFEE, 'Облепиховый чай', 320, [G_TEA], 14, 70, { unit: 'порц' }],
  [7, C_DRINKS, 'Вода без газа, 0,5 л', 90, [], 24, 28],
  [8, C_DRINKS, 'Кола, 0,33 л', 150, [], 3, 55],
  [9, C_DRINKS, 'Морс клюквенный, 0,4 л', 160, [], 0, 35, { stop_list: true }],
  [10, C_DRINKS, 'Лимонад домашний, 0,4 л', 220, [], 12, 45, { unit: 'порц' }],
  [11, C_FOOD, 'Сэндвич с курицей', 320, [], 6, 140],
  [12, C_FOOD, 'Картофель фри', 250, [G_SAUCE], 30, 60, { unit: 'порц' }],
  [13, C_FOOD, 'Орешки солёные', 150, [], 14, 48],
  [14, C_FOOD, 'Чипсы', 160, [], 0, 62, { available: false }],
  [15, C_FOOD, 'Пицца «Маргарита»', 590, [], 5, 210],
  [16, C_BEER, 'Светлое разливное, 0,5 л', 290, [], 40, 95, { is_alcohol: true, payment_subject: 'excise', unit: 'порц' }],
  [17, C_BEER, 'Тёмное разливное, 0,5 л', 320, [], 25, 110, { is_alcohol: true, payment_subject: 'excise', unit: 'порц' }],
  [18, C_BEER, 'Сидр, 0,33 л', 280, [], 8, 120, { is_alcohol: true, payment_subject: 'excise' }],
  [19, C_GAME, 'Мел для кия', 100, [], 18, 35],
  [20, C_GAME, 'Перчатка бильярдная', 450, [], 4, 180],
];
export const PID = Object.fromEntries(PRODUCTS.map(([n, , name]) => [name, id('d0000001', n)]));

function catalogSeed() {
  return {
    categories: CATEGORIES.map((c) => ({ ...c })),
    modifier_groups: structuredClone(GROUPS),
    products: PRODUCTS.map(([n, category_id, name, rub, groups, stock, cost, flags = {}]) => ({
      id: id('d0000001', n),
      category_id,
      name,
      description: null,
      sku: null,
      price_kopecks: rub * 100,
      unit: 'шт',
      is_alcohol: false,
      vat_code: null,
      payment_subject: 'commodity',
      stop_list: false,
      track_stock: stock !== null,
      photo: null,
      sort: n,
      active: true,
      modifier_group_ids: groups,
      stock_qty: stock,
      // Поля заглушки (на сервере — движения склада): себестоимость и порог «мало»
      cost_kopecks: cost * 100,
      min_qty: stock === null ? null : 5,
      ...flags,
    })),
  };
}

function modsOf(cat, ids) {
  return cat.modifier_groups.flatMap((g) => g.modifiers.filter((x) => ids.includes(x.id)).map((x) => ({ id: x.id, name: x.name, price_delta_kopecks: x.price_delta_kopecks })));
}

function orderLine(cat, productId, qty, modIds = []) {
  const p = cat.products.find((x) => x.id === productId);
  const ms = modsOf(cat, modIds);
  const unit = p.price_kopecks + ms.reduce((s, x) => s + x.price_delta_kopecks, 0);
  // Имя для чека — с модификаторами, как server/catalog/api.mjs
  const name = [p.name, ...ms.map((x) => x.name)].join(', ').slice(0, 128);
  return { id: uuid(), product_id: p.id, product_name: p.name, name, qty, unit_price_kopecks: unit, amount_kopecks: unit * qty, modifiers: ms.map(({ id: mid, name: n }) => ({ id: mid, name: n })) };
}

/** Заказ в виде orderView backend-pos (server/orders/core.mjs). */
function makeOrder(cat, { number, session, table, status, minAgo, pay, items, comment = null, source = 'qr', paid }, t) {
  const list = items.map(([name, qty, mods = []]) => orderLine(cat, PID[name], qty, mods.map((x) => MOD[x])));
  const created = new Date(t - minAgo * MIN).toISOString();
  return {
    id: uuid(),
    number,
    source,
    status,
    pay_mode: pay,
    paid: paid ?? pay !== 'tab',
    awaiting_payment: false,
    session_id: session ?? null,
    resource: table ? { id: id('00000000', table), number: table } : null,
    items: list,
    subtotal_kopecks: list.reduce((s, i) => s + i.amount_kopecks, 0),
    comment,
    payment_id: pay === 'tab' ? null : uuid(),
    sale_id: null,
    created_at: created,
    status_at: new Date(t - Math.max(0, minAgo - 2) * MIN).toISOString(),
    paid_at: pay === 'tab' ? null : created,
    canceled_at: null,
  };
}

/** Идущий турнир заглушки M4 (mock/m4.js «Вечерний пул») — переход из отчёта смены. */
const LIVE_TOURNAMENT = 'd4000000-0000-4000-8000-000000000003';
const STAFF_NAMES = { reception: 'Анна К.', reception2: 'Игорь П.', manager: 'Ольга Р.', owner: 'Андрей' };
/** Доля часов игры по столам 1–8 в отчёте заглушки: один стол почти не играл. */
const PLAY_SHARE = [0.19, 0.17, 0.16, 0.14, 0.13, 0.11, 0.08, 0.02];

/** Отчёт смены как buildShiftReport backend-kkt (server/reports/shift-report.mjs): числа сходятся до копейки. */
function reportSeed(shift, x) {
  const opened = Date.parse(shift.opened_at);
  const closed = shift.closed_at ? Date.parse(shift.closed_at) : opened + 6 * 60 * MIN;
  const shiftMinutes = Math.round((closed - opened) / MIN);
  const bm = (cash, terminal, sbp, card) => ({ cash, card_terminal: terminal, sbp, card });
  const total = (o) => Object.values(o).reduce((a, v) => a + v, 0);
  const tables = bm(x.tablesCash, x.tablesTerminal, x.tablesSbp, x.tablesCard);
  const bar = bm(x.barCash, x.barTerminal, x.barSbp, x.barCard);
  const byMethod = Object.fromEntries(Object.keys(tables).map((k) => [k, tables[k] + bar[k]]));
  const kktSales = byMethod.cash + byMethod.card_terminal;
  const online = byMethod.sbp + byMethod.card;
  const pendingK = x.kktPending ?? 0;
  const svcByStaff = ['reception', 'reception2']
    .map((who) => ({ user_id: who, name: STAFF_NAMES[who], count: x.service.filter((v) => v.who === who).length, minutes: x.service.filter((v) => v.who === who).reduce((a, v) => a + v.minutes, 0) }))
    .filter((v) => v.minutes > 0);
  const svcTotal = x.service.reduce((a, v) => a + v.minutes, 0);
  const items = [
    { at: new Date(opened + 95 * MIN).toISOString(), action: 'service.start', actor_id: null, actor_name: STAFF_NAMES.reception, reason: 'Протираем сукно после пролитого напитка', resource_id: null, amount_kopecks: null },
    { at: new Date(opened + 210 * MIN).toISOString(), action: 'manual.extend_free', actor_id: null, actor_name: STAFF_NAMES.manager, reason: 'Свет мигнул из-за сбоя питания, компенсировали 15 минут', resource_id: null, amount_kopecks: null },
    { at: new Date(opened + 300 * MIN).toISOString(), action: 'manual.discount', actor_id: null, actor_name: STAFF_NAMES.manager, reason: 'Постоянный гость, турнир клуба', resource_id: null, amount_kopecks: 18000 },
    // M4 (№147): исправление счёта турнира и решение спора по партии — ручные строки
    // Строки несут data (server/reports DETAIL_ACTIONS): было → стало и tournament_id для перехода
    { at: new Date(opened + 330 * MIN).toISOString(), action: 'manual.tournament_score', actor_id: null, actor_name: STAFF_NAMES.manager, reason: 'Игроки внесли счёт наоборот', resource_id: id('00000000', 7), resource_number: 7, amount_kopecks: null, data: { tournament_id: LIVE_TOURNAMENT, match_id: null, before: '2:3', after: '3:2' } },
    { at: new Date(opened + 345 * MIN).toISOString(), action: 'plus.match_resolve', actor_id: null, actor_name: STAFF_NAMES.manager, reason: 'Посмотрели запись камеры: последний шар забит', resource_id: id('00000000', 3), resource_number: 3, amount_kopecks: null, data: { match_id: null, result: 'a', before: '8:7', after: '8:7' } },
    // M4 (№147, №149): продление турнира и возврат взноса одному игроку
    { at: new Date(opened + 352 * MIN).toISOString(), action: 'manual.tournament_extend', actor_id: null, actor_name: STAFF_NAMES.manager, reason: 'Полуфиналы затянулись', resource_id: null, resource_number: null, amount_kopecks: null, data: { tournament_id: LIVE_TOURNAMENT, before: { ends_at: new Date(opened + 360 * MIN).toISOString(), match_minutes: 90, light_until: new Date(opened + 450 * MIN).toISOString() }, after: { ends_at: new Date(opened + 420 * MIN).toISOString(), match_minutes: 90, light_until: new Date(opened + 510 * MIN).toISOString() } } },
    { at: new Date(opened + 358 * MIN).toISOString(), action: 'manual.tournament_refund', actor_id: null, actor_name: STAFF_NAMES.manager, reason: 'Травма руки во втором матче', resource_id: null, resource_number: null, amount_kopecks: 50000, data: { tournament_id: LIVE_TOURNAMENT, entry_id: null, scope: 'entry', reason_code: 'health', refunds: null } },
  ];
  return {
    shift: { ...shift, timezone: 'Asia/Yekaterinburg' },
    period: { from: shift.opened_at, to: new Date(closed).toISOString(), live: !shift.closed_at },
    revenue: {
      tables: { by_method: tables, total_kopecks: total(tables) },
      bar: { by_method: bar, total_kopecks: total(bar) },
      other: { by_method: bm(0, 0, 0, 0), total_kopecks: 0 },
      by_method: byMethod,
      total_kopecks: total(byMethod),
      refunds: { by_method: bm(0, 0, 0, 0), tables_kopecks: 0, bar_kopecks: 0, count: 0, total_kopecks: 0 },
      holds_kopecks: 0,
      payments_count: x.sessions + 31,
      net_kopecks: total(byMethod),
    },
    play: {
      sessions: x.sessions,
      minutes: x.playMinutes,
      hours: Math.round((x.playMinutes / 60) * 10) / 10,
      resources: 8,
      shift_minutes: shiftMinutes,
      utilization_percent: Math.round((x.playMinutes / (8 * shiftMinutes)) * 1000) / 10,
      // Как server/reports/queries.mjs: по столам — игры, минуты, выручка, загрузка от времени смены
      by_resource: PLAY_SHARE.map((share, i) => {
        const minutes = Math.round(x.playMinutes * share);
        const sessions = Math.max(0, Math.round(x.sessions * share));
        return { resource_id: id('00000000', i + 1), number: i + 1, title: null, sessions, minutes, hours: Math.round((minutes / 60) * 10) / 10, revenue_kopecks: Math.round((total(tables) * share) / 100) * 100, refunds_kopecks: 0, utilization_percent: Math.round((minutes / shiftMinutes) * 1000) / 10 };
      }),
    },
    service_light: {
      total_minutes: svcTotal,
      count: x.service.length,
      threshold_minutes: 60,
      exceeded: svcTotal > 60,
      by_staff: svcByStaff,
      by_resource: [...new Set(x.service.map((v) => v.table))].map((n) => ({ resource_id: id('00000000', n), number: n, count: x.service.filter((v) => v.table === n).length, minutes: x.service.filter((v) => v.table === n).reduce((a, v) => a + v.minutes, 0) })),
    },
    // №125: ручные и действия персонала — общим списком с kind; действия системы — automatic отдельно
    manual_actions: {
      count: items.length,
      by_action: { 'service.start': 1, 'manual.extend_free': 1, 'manual.discount': 1, 'manual.tournament_score': 1, 'plus.match_resolve': 1, 'manual.tournament_extend': 1, 'manual.tournament_refund': 1 },
      items: items.map((it) => ({ kind: it.action.startsWith('manual.') ? 'manual' : 'staff', linked: [], ...it })),
      // Действия гостей (отмена брони гостем с возвратом) — отдельно, свёрнуто
      guests: {
        count: 1,
        by_action: { 'booking.cancel': 1 },
        items: [{ at: new Date(opened + 180 * MIN).toISOString(), action: 'booking.cancel', kind: 'guest', actor_id: null, actor_name: null, reason: 'Бронь отменена гостем поздно', resource_id: id('00000000', 4), resource_number: 4, amount_kopecks: 31500, linked: ['payment.refunded'] }],
      },
      automatic: {
        count: 2,
        by_action: { 'payment.forfeited': 1, 'payment.refunded': 1 },
        items: [
          { at: new Date(opened + 140 * MIN).toISOString(), action: 'payment.forfeited', kind: 'automatic', actor_id: null, actor_name: null, reason: 'Гость не пришёл по брони', resource_id: id('00000000', 3), resource_number: 3, amount_kopecks: 120000 },
          { at: new Date(opened + 260 * MIN).toISOString(), action: 'payment.refunded', kind: 'automatic', actor_id: null, actor_name: null, reason: 'Оплата пришла на занятый стол', resource_id: id('00000000', 5), resource_number: 5, amount_kopecks: 80000 },
        ],
      },
    },
    cash: {
      float_kopecks: shift.float_kopecks,
      cash_sales_kopecks: shift.cash_sales_kopecks,
      cash_refunds_kopecks: 0,
      expected_cash_kopecks: shift.expected_cash_kopecks,
      actual_cash_kopecks: shift.actual_cash_kopecks,
      discrepancy_kopecks: shift.discrepancy_kopecks,
    },
    reconciliation: {
      kkt: {
        ok: pendingK === 0,
        system_kopecks: kktSales,
        kkt_kopecks: kktSales - pendingK,
        diff_kopecks: pendingK,
        receipts: { printed: { count: 47, amount_kopecks: kktSales - pendingK }, pending: { count: pendingK ? 2 : 0, amount_kopecks: pendingK }, unknown: { count: 0, amount_kopecks: 0 }, failed: { count: 0, amount_kopecks: 0 } },
        missing_count: pendingK ? 2 : 0,
      },
      online: { ok: true, status: 'checked', system_kopecks: online, system_refunds_kopecks: 0, payments: 23, refunds: 0, yookassa_kopecks: online, yookassa_refunds_kopecks: 0, diff_kopecks: 0, mismatches: [] },
    },
    generated_at: new Date(closed).toISOString(),
  };
}

/** Смена в виде shiftView backend-kkt (server/shifts/service.mjs). */
function shiftRow({ opened, closed = null, float, cash, by, closer = null, actual = null, comment = null, number }) {
  const expected = float + cash;
  return {
    id: uuid(),
    club_id: '0b6b8c1e-5a7d-4f0e-9c3a-2d1e4f5a6b7c',
    number,
    status: closed ? 'closed' : 'open',
    opened_at: new Date(opened).toISOString(),
    opened_by: by,
    opened_by_name: STAFF_NAMES[by] ?? null,
    float_kopecks: float,
    closed_at: closed ? new Date(closed).toISOString() : null,
    closed_by: closer,
    closed_by_name: closer ? STAFF_NAMES[closer] : null,
    cash_sales_kopecks: cash,
    cash_refunds_kopecks: 0,
    expected_cash_kopecks: expected,
    actual_cash_kopecks: actual,
    discrepancy_kopecks: actual === null ? null : actual - expected,
    close_comment: comment,
    report_sent_at: closed ? new Date(closed + 1000).toISOString() : null,
  };
}

export function m2State(scenario, t, hall) {
  const cat = catalogSeed();
  const sess = (n) => hall.find((x) => x.resource.number === n)?.session?.id ?? null;
  const closedSession = `5e550000-0000-4000-8000-${String(Math.floor(t / 1000) % 1e12).padStart(12, '0')}`;
  const orders = [
    makeOrder(cat, { number: 41, session: sess(1), table: 1, status: 'new', minAgo: 3, pay: 'tab', items: [['Капучино', 2, ['0,4 л', 'Овсяное', 'Без сахара']], ['Картофель фри', 1, ['Сырный']]], comment: 'Принесите, пожалуйста, побольше салфеток' }, t),
    makeOrder(cat, { number: 40, session: sess(7), table: 7, status: 'preparing', minAgo: 11, pay: 'online', items: [['Чай чёрный', 1, ['1 л']], ['Сэндвич с курицей', 1]] }, t),
    makeOrder(cat, { number: 39, session: sess(3), table: 3, status: 'ready', minAgo: 23, pay: 'tab', items: [['Лимонад домашний, 0,4 л', 2]] }, t),
    makeOrder(cat, { number: 38, status: 'preparing', minAgo: 6, pay: 'pos', source: 'pos', items: [['Американо', 1, ['0,3 л', '1 ложка']]] }, t),
    makeOrder(cat, { number: 37, session: sess(1), table: 1, status: 'served', minAgo: 52, pay: 'tab', items: [['Кола, 0,33 л', 2], ['Орешки солёные', 1]] }, t),
    makeOrder(cat, { number: 33, session: closedSession, table: 2, status: 'served', minAgo: 96, pay: 'tab', items: [['Пицца «Маргарита»', 1], ['Вода без газа, 0,5 л', 1]] }, t),
  ];
  const day = 24 * 60 * MIN;
  const current = scenario === 'noshift' ? null : shiftRow({ opened: t - 5 * 60 * MIN - 12 * MIN, float: 300000, cash: 1248000, by: 'reception', number: 214 });
  const closedShift = (daysAgo, discrepancy, by, closer, number) => {
    const opened = t - daysAgo * day - 6 * 60 * MIN;
    const cash = 1530000 - daysAgo * 70000;
    return shiftRow({ opened, closed: opened + 12 * 60 * MIN, float: 300000, cash, by, closer, actual: 300000 + cash + discrepancy, comment: discrepancy ? 'Пересчитали дважды, не хватает одной купюры' : null, number });
  };
  const history = [closedShift(1, -50000, 'reception2', 'reception2', 213), closedShift(2, 0, 'reception', 'reception', 212), closedShift(3, 0, 'reception2', 'reception', 211)];
  const seeds = [
    { tablesCash: 960000, tablesTerminal: 640000, tablesSbp: 1780000, tablesCard: 480000, barCash: 500000, barTerminal: 214000, barSbp: 96000, barCard: 61000, playMinutes: 3380, sessions: 38, service: [{ who: 'reception2', table: 5, minutes: 45 }, { who: 'reception2', table: 2, minutes: 30 }] },
    { tablesCash: 880000, tablesTerminal: 560000, tablesSbp: 1690000, tablesCard: 420000, barCash: 580000, barTerminal: 190000, barSbp: 88000, barCard: 42000, playMinutes: 3120, sessions: 35, service: [{ who: 'reception', table: 5, minutes: 20 }] },
    { tablesCash: 790000, tablesTerminal: 600000, tablesSbp: 1510000, tablesCard: 380000, barCash: 530000, barTerminal: 160000, barSbp: 70000, barCard: 30000, playMinutes: 2890, sessions: 33, service: [{ who: 'reception2', table: 6, minutes: 15 }] },
  ];
  const reports = {};
  history.forEach((s, i) => (reports[s.id] = reportSeed(s, seeds[i])));
  return {
    catalog: cat,
    settings: { discount_limit_percent: 10, stop_at_zero: false, tab_limit_kopecks: null },
    orders,
    nextOrderNumber: 42,
    sessionInfo: { [closedSession]: { resource_number: 2, session_status: 'closed' } },
    shift: current,
    shifts: history,
    reports,
    sales: {},
    approvals: {},
    bridges: [
      {
        id: uuid(),
        name: 'ПК ресепшена',
        kkt_model: 'АТОЛ 30Ф',
        bridge_version: '0.1.0',
        created_at: new Date(t - 9 * day).toISOString(),
        last_seen_at: new Date(scenario?.startsWith('kktoff') ? t - 14 * MIN : t - 20_000).toISOString(),
        last_status: null,
        online: !scenario?.startsWith('kktoff'),
        revoked_at: null,
      },
    ],
    pendingReceipts: 0,
    // Чеки ККТ в работе (вид receiptView backend-kkt): касса не на связи — один в очереди и один «исход неизвестен»
    receipts:
      scenario?.startsWith('kktoff')
        ? [
            { id: uuid(), kind: 'sale', status: 'unknown', amount_kopecks: 64000, payment_id: uuid(), sale_id: null, refund_id: null, created_at: new Date(t - 16 * MIN).toISOString(), attempts: 1, error: null, next_attempt_at: null, fd: null, fp: null, fn: null, printed_at: null, operator_name: 'Анна К.' },
            { id: uuid(), kind: 'sale', status: 'pending', amount_kopecks: 44000, payment_id: uuid(), sale_id: null, refund_id: null, created_at: new Date(t - 12 * MIN).toISOString(), attempts: 3, error: null, next_attempt_at: new Date(t + MIN).toISOString(), fd: null, fp: null, fn: null, printed_at: null, operator_name: 'Анна К.' },
          ]
        : [],
    nextQrOrderAt: t + 70_000,
  };
}

/**
 * Маршруты M2 поверх заглушки M1. ctx: { state(), now(), emit(name, data), save(), me(), audit(action, extra), err, ok, byNumber(n), staffById(id), approvers() }.
 */
export function m2Routes(ctx) {
  const { err, ok } = ctx;
  const S = () => ctx.state().m2;
  const now = () => ctx.now();
  const role = () => ctx.me()?.role;
  const can = (...roles) => roles.includes(role());
  const isStaff = () => can('owner', 'manager', 'reception', 'bar');
  const cat = () => S().catalog;
  const product = (pid) => cat().products.find((p) => p.id === pid);
  const kktOnline = () => S().bridges.some((b) => b.online && !b.revoked_at);

  const sessionInfo = (sid) => {
    const t = ctx.state().hall.find((x) => x.session?.id === sid);
    if (t) return { resource_number: t.resource.number, session_status: t.session.status ?? 'active' };
    return S().sessionInfo[sid] ?? null;
  };

  function openTabs() {
    const by = new Map();
    for (const o of S().orders) {
      if (o.pay_mode !== 'tab' || o.paid || o.status === 'canceled' || !o.session_id) continue;
      if (!by.has(o.session_id)) by.set(o.session_id, []);
      by.get(o.session_id).push(o);
    }
    return [...by.entries()]
      .map(([sid, list]) => {
        const info = sessionInfo(sid) ?? { resource_number: list[0].resource?.number, session_status: 'closed' };
        return {
          session_id: sid,
          session_status: info.session_status,
          resource: { id: id('00000000', info.resource_number), number: info.resource_number },
          orders: list.length,
          total_kopecks: list.reduce((s, o) => s + o.subtotal_kopecks, 0),
          since: list[0].created_at,
        };
      })
      .sort((a, b) => a.resource.number - b.resource.number);
  }

  /** Меню как menuFor backend-pos: товары внутри категорий; гостю — без алкоголя (№76). */
  function menuView(audience) {
    const c = cat();
    const staff = audience === 'staff';
    const groups = new Map(c.modifier_groups.map((g) => [g.id, g]));
    const cats = c.categories.filter((x) => x.active !== false).map((x) => ({ id: x.id, name: x.name, products: [] }));
    const other = { id: null, name: 'Другое', products: [] };
    for (const p of c.products) {
      if (p.active === false || (!staff && p.is_alcohol)) continue;
      const item = {
        id: p.id,
        name: p.name,
        description: p.description,
        price_kopecks: p.price_kopecks,
        unit: p.unit,
        photo: p.photo,
        available: !p.stop_list && p.available !== false,
        stop_list: p.stop_list,
        modifier_groups: p.modifier_group_ids
          .map((gid) => groups.get(gid))
          .filter(Boolean)
          .map((g) => ({ id: g.id, name: g.name, min_select: g.min_select, max_select: g.max_select, modifiers: g.modifiers.filter((x) => x.active !== false).map((x) => ({ id: x.id, name: x.name, price_delta_kopecks: x.price_delta_kopecks, is_default: x.is_default })) })),
      };
      if (staff) Object.assign(item, { is_alcohol: p.is_alcohol, sku: p.sku, track_stock: p.track_stock, stock_qty: p.track_stock ? p.stock_qty : null });
      (cats.find((x) => x.id === p.category_id) ?? other).products.push(item);
    }
    const categories = cats.filter((x) => x.products.length);
    if (other.products.length) categories.push(other);
    return { club_id: '0b6b8c1e-5a7d-4f0e-9c3a-2d1e4f5a6b7c', audience, alcohol_hidden: !staff, categories };
  }

  /** Сводка кассы ККТ как statusOf backend-kkt (server/kkt/service.mjs). */
  function kktStatus() {
    const online = S().bridges.filter((b) => b.online && !b.revoked_at);
    const open = S().receipts ?? [];
    const pending = open.filter((r) => r.status !== 'failed').length + Object.values(S().sales).filter((x) => x.receipt_status === 'receipt_pending').length;
    return {
      state: online.length ? 'online' : 'offline',
      reason: online.length ? null : 'no_bridge',
      bridges: online.map((b) => ({ id: b.id, name: b.name, kkt: { online: true, model: b.kkt_model } })),
      queue: { pending, pending_kopecks: pending * 32000, oldest_pending_at: pending ? new Date(now() - 12 * MIN).toISOString() : null, unknown: open.filter((r) => r.status === 'unknown').length, failed: open.filter((r) => r.status === 'failed').length },
    };
  }

  /** Вид продажи как saleView backend-pos (server/orders/pos.mjs). */
  function saleView(sale) {
    if (sale.status === 'pending' && now() - Date.parse(sale.created_at) > 9000) completeSale(sale);
    if (sale.receipt_status === 'receipt_pending' && kktOnline() && now() - Date.parse(sale.completed_at) > 2500) {
      sale.receipt_status = 'printed';
      sale.receipt_fd = String(4800 + Math.floor(Math.random() * 400));
      sale.receipt_fp = String(Math.floor(1e9 + Math.random() * 8e9));
      ctx.emit('kkt', kktStatus());
    }
    const { lines: _l, request_ids: _r, to_bar: _b, tabs: _t, confirmation, ...view } = sale;
    return sale.status === 'pending' ? { ...view, confirmation } : view;
  }

  function completeSale(sale) {
    const st = ctx.state();
    sale.status = 'completed';
    sale.completed_at = new Date(now()).toISOString();
    if (sale.method !== 'sbp') {
      sale.receipt_id = uuid();
      sale.receipt_status = 'receipt_pending';
    }
    for (const l of sale.lines) {
      const p = product(l.product_id);
      if (p?.track_stock) p.stock_qty = Math.max(0, p.stock_qty - l.qty);
    }
    for (const rid of sale.request_ids) {
      const r = st.requests.find((x) => x.id === rid);
      if (!r) continue;
      st.requests = st.requests.filter((x) => x !== r);
      const table = ctx.byNumber(r.resource_number);
      const s = { id: uuid(), status: 'active', started_at: new Date(now()).toISOString(), paid_until: new Date(now() + (r.minutes ?? 120) * MIN).toISOString(), unlimited: r.minutes === null };
      Object.assign(table, { status: 'busy', session: s });
      ctx.emit('hall', table);
      ctx.emit('reception_request', { state: 'accepted' });
    }
    for (const o of S().orders) if (sale.tabs.includes(o.session_id) && o.pay_mode === 'tab' && !o.paid) Object.assign(o, { paid: true, paid_at: sale.completed_at, sale_id: sale.sale_id });
    if (sale.method === 'cash' && S().shift) S().shift.cash_sales_kopecks += sale.total_kopecks;
    st.revenue[sale.method] = (st.revenue[sale.method] ?? 0) + sale.total_kopecks;
    if (sale.lines.length) {
      const order = {
        ...makeOrder(cat(), { number: S().nextOrderNumber++, status: sale.to_bar ? 'new' : 'served', minAgo: 0, pay: 'pos', source: 'pos', items: [] }, now()),
        items: sale.lines.map((l) => ({ ...l })),
        subtotal_kopecks: sale.lines.reduce((s, l) => s + l.amount_kopecks, 0),
        sale_id: sale.sale_id,
      };
      S().orders.push(order);
      if (sale.to_bar) ctx.emit('bar', order);
    }
    ctx.audit('pos.sale', { data: { method: sale.method, amount_kopecks: sale.total_kopecks } });
    ctx.emit('pos_sale', { sale_id: sale.sale_id, status: 'completed', method: sale.method, total_kopecks: sale.total_kopecks });
    ctx.emit('kkt', kktStatus());
  }

  function liveShift() {
    const s = S().shift;
    return s ? { ...s, expected_cash_kopecks: s.float_kopecks + s.cash_sales_kopecks - s.cash_refunds_kopecks } : null;
  }

  function liveReport() {
    const s = liveShift();
    const cash = s.cash_sales_kopecks;
    const tablesCash = Math.round((cash * 0.62) / 100) * 100;
    const pendingK = (S().receipts ?? []).filter((r) => r.status !== 'printed').reduce((a, r) => a + r.amount_kopecks, 0);
    return reportSeed(s, { tablesCash, tablesTerminal: 480000, tablesSbp: 1248000, tablesCard: 486000, barCash: cash - tablesCash, barTerminal: 160000, barSbp: 52000, barCard: 31000, playMinutes: 1460, sessions: 17, service: [{ who: 'reception', table: 5, minutes: 30 }], kktPending: pendingK });
  }

  const totalOf = (r) => r?.revenue?.total_kopecks ?? 0;

  function stockList() {
    return cat()
      .products.filter((p) => p.track_stock && p.active !== false)
      .map((p) => ({ product_id: p.id, name: p.name, unit: p.unit, category_id: p.category_id, active: p.active, stop_list: p.stop_list, qty: p.stock_qty, avg_cost_kopecks: p.cost_kopecks, value_kopecks: Math.round(Math.max(0, p.stock_qty) * p.cost_kopecks), min_qty: p.min_qty }));
  }

  function validateProduct(p) {
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 128) return err(400, 'bad_request');
    if (!Number.isSafeInteger(p.price_kopecks) || p.price_kopecks <= 0) return err(400, 'bad_request');
    if (p.category_id !== null && !cat().categories.some((c) => c.id === p.category_id)) return err(400, 'bad_request');
    if (p.vat_code !== null && p.vat_code !== undefined && !(Number.isInteger(p.vat_code) && p.vat_code >= 1 && p.vat_code <= 12)) return err(400, 'bad_request');
    return null;
  }

  const staffOnly = (fn) => (mm, b, q) => (isStaff() ? fn(mm, b, q) : err(ctx.me() ? 403 : 401, ctx.me() ? 'forbidden' : 'unauthorized'));
  const managerOnly = (fn) => (mm, b, q) => (can('owner', 'manager') ? fn(mm, b, q) : err(403, 'forbidden'));

  return [
    // ---------- меню, касса ----------
    ['GET', /^\/api\/clubs\/([^/]+)\/menu$/, staffOnly(() => ok(menuView('staff')))],
    ['GET', /^\/api\/clubs\/([^/]+)\/catalog$/, managerOnly(() => ok(cat()))],
    ['GET', /^\/api\/clubs\/([^/]+)\/pos\/settings$/, staffOnly(() => ok(S().settings))],
    ['GET', /^\/api\/clubs\/([^/]+)\/tabs$/, staffOnly(() => ok(openTabs()))],
    ['GET', /^\/api\/clubs\/([^/]+)\/kkt\/status$/, staffOnly(() => ok(kktStatus()))],
    ['GET', /^\/api\/clubs\/([^/]+)\/staff\/approvers$/, staffOnly(() => ok(ctx.approvers()))],
    ['POST', /^\/api\/pos\/discount-approvals$/, staffOnly((_m, b) => {
      // Как server/orders/approvals.mjs: ровно одно из percent | amount_kopecks, причина, PIN управляющего; 5 минут, одноразовое
      const hasP = b.percent !== undefined && b.percent !== null;
      const hasA = b.amount_kopecks !== undefined && b.amount_kopecks !== null;
      if (typeof b.pin !== 'string' || !/^\d{4,6}$/.test(b.pin) || hasP === hasA) return err(400, 'bad_request');
      if (hasP && (!Number.isInteger(b.percent) || b.percent < 1 || b.percent > 100)) return err(400, 'bad_request');
      if (!b.reason_code || !String(b.reason_text ?? '').trim()) return err(400, 'reason_required');
      // №100: подтверждение привязано к сумме бара в чеке
      if (!Number.isSafeInteger(b.subtotal_kopecks) || b.subtotal_kopecks < 1) return err(400, 'bad_request');
      if (hasA && b.amount_kopecks > b.subtotal_kopecks) return err(400, 'bad_request');
      const maxDiscount = hasP ? Math.floor((b.subtotal_kopecks * b.percent * 2 + 100) / 200) : b.amount_kopecks;
      const u = ctx.staffById(b.user_id);
      if (!u || !['manager', 'owner'].includes(u.role)) return err(403, 'forbidden');
      if (b.pin !== '1234') return err(401, 'unauthorized');
      const aid = uuid();
      S().approvals[aid] = { id: aid, percent: hasP ? b.percent : null, amount_kopecks: hasA ? b.amount_kopecks : null, subtotal_kopecks: b.subtotal_kopecks, max_discount_kopecks: maxDiscount, by: u.name, used: false, expires: now() + 5 * MIN };
      return ok({ approval_id: aid, expires_at: new Date(now() + 5 * MIN).toISOString(), subtotal_kopecks: b.subtotal_kopecks, max_discount_kopecks: maxDiscount });
    })],
    ['POST', /^\/api\/pos\/sales$/, (_m, b) => {
      if (!can('reception', 'manager', 'owner')) return err(403, 'forbidden');
      if (!['cash', 'card_terminal', 'sbp'].includes(b.method)) return err(400, 'bad_request');
      const all = Array.isArray(b.items) ? b.items : [];
      // M3 (№112, №117): пакет часов — { kind: 'package', package_id, phone }; гость должен уже входить в приложение
      const packs = all.filter((i) => i.kind === 'package');
      const items = all.filter((i) => i.kind !== 'package');
      for (const pk of packs) {
        if (!pk.phone && !pk.user_id) return err(400, 'guest_required');
        if (String(pk.phone ?? '').endsWith('0000')) return err(409, 'guest_not_found');
        if (!(ctx.packages?.() ?? []).some((x) => x.id === pk.package_id && x.active)) return err(404, 'not_found');
      }
      const packageTotal = packs.reduce((a, pk) => a + ctx.packages().find((x) => x.id === pk.package_id).price_kopecks, 0);
      const tabs = Array.isArray(b.tabs) ? b.tabs : [];
      const requests = Array.isArray(b.requests) ? b.requests : [];
      if (!all.length && !tabs.length && !requests.length) return err(400, 'bad_request');
      if (b.method === 'sbp' && requests.length) return err(400, 'bad_request');
      if (!S().shift) return err(409, 'shift_closed');
      const lines = [];
      for (const it of items) {
        const p = product(it.product_id);
        if (!p) return err(404, 'not_found');
        if (p.stop_list || p.available === false) return err(409, 'stop_list');
        lines.push(orderLine(cat(), p.id, it.qty, it.modifier_ids ?? []));
      }
      const open = openTabs();
      for (const sid of tabs) if (!open.some((x) => x.session_id === sid)) return err(409, 'already_paid');
      const tabTotal = open.filter((x) => tabs.includes(x.session_id)).reduce((s, x) => s + x.total_kopecks, 0);
      let tableTotal = 0;
      for (const rid of requests) {
        const r = ctx.state().requests.find((x) => x.id === rid);
        if (!r) return err(404, 'not_found');
        tableTotal += r.amount_kopecks;
      }
      const barSubtotal = lines.reduce((s, l) => s + l.amount_kopecks, 0) + tabTotal;
      let discount = 0;
      if (b.discount) {
        const d = b.discount;
        if (Number.isInteger(d.percent) && d.percent >= 0 && d.percent <= 100) discount = Math.floor((barSubtotal * d.percent * 2 + 100) / 200);
        else if (Number.isSafeInteger(d.amount_kopecks) && d.amount_kopecks >= 0 && d.amount_kopecks <= barSubtotal) discount = d.amount_kopecks;
        else return err(400, 'bad_request');
        if (discount * 100 > S().settings.discount_limit_percent * barSubtotal) {
          if (can('manager', 'owner')) {
            if (!String(d.reason ?? '').trim()) return err(400, 'reason_required');
          } else {
            if (d.approval_id == null) return err(403, 'limit_exceeded');
            const a = S().approvals[d.approval_id];
            const same = a && (a.percent !== null ? d.percent === a.percent && d.amount_kopecks == null : d.amount_kopecks === a.amount_kopecks && d.percent == null);
            if (!a || a.used || a.expires <= now() || !same) return err(403, 'forbidden');
            if (barSubtotal > a.subtotal_kopecks || discount > a.max_discount_kopecks) return err(403, 'forbidden');
            a.used = true;
          }
          ctx.state().alarms.unshift({ id: uuid(), type: 'discount_over_limit', level: 'important', created_at: new Date(now()).toISOString() });
        }
      }
      const barTotal = barSubtotal - discount;
      if (barSubtotal > 0 && barTotal <= 0) return err(400, 'bad_request');
      const total = barTotal + tableTotal + packageTotal;
      if (b.method === 'cash' && !(Number.isSafeInteger(b.received_kopecks) && b.received_kopecks >= total)) return err(400, 'bad_request');
      const sid = uuid();
      const sale = {
        sale_id: sid,
        channel: 'pos',
        status: 'pending',
        method: b.method,
        payment_id: uuid(),
        session_id: tabs.length === 1 ? tabs[0] : null,
        shift_id: S().shift.id,
        bar_subtotal_kopecks: barSubtotal,
        discount_kopecks: discount,
        bar_kopecks: barTotal,
        package_kopecks: packageTotal,
        packages: packs.map((pk) => ({ package_id: pk.package_id, title: ctx.packages().find((x) => x.id === pk.package_id).title, amount_kopecks: ctx.packages().find((x) => x.id === pk.package_id).price_kopecks })),
        table_kopecks: tableTotal,
        total_kopecks: total,
        received_kopecks: b.method === 'cash' ? b.received_kopecks : null,
        change_kopecks: b.method === 'cash' ? b.received_kopecks - total : null,
        refunded_kopecks: 0,
        receipt_id: null,
        receipt_status: null,
        items: lines.map((l) => ({ id: uuid(), order_id: null, order_item_id: l.id, product_id: l.product_id, product_name: l.product_name, name: l.name, qty: l.qty, amount_kopecks: l.amount_kopecks, discount_kopecks: 0, outcome: null, refunded_qty: 0, refunded_kopecks: 0 })),
        table_payments: requests.map((rid) => ({ request_id: rid, payment_id: uuid(), amount_kopecks: ctx.state().requests.find((x) => x.id === rid).amount_kopecks })),
        created_at: new Date(now()).toISOString(),
        completed_at: null,
        canceled_at: null,
        // внутреннее заглушки
        lines,
        tabs,
        request_ids: requests,
        to_bar: b.to_bar === true,
      };
      S().sales[sid] = sale;
      if (b.method === 'sbp') sale.confirmation = { type: 'qr', confirmation_data: `https://qr.nspk.ru/AD10006M8KH0K9KP8OQB0JMRL3KT7TB1?type=02&bank=100000000111&sum=${total}&cur=RUB&crc=AB75` };
      else completeSale(sale);
      return ok(saleView(sale));
    }],
    ['GET', /^\/api\/pos\/sales\/([^/]+)$/, staffOnly((mm) => (S().sales[mm[1]] ? ok(saleView(S().sales[mm[1]])) : err(404, 'not_found')))],
    ['POST', /^\/api\/pos\/sales\/([^/]+)\/cancel$/, staffOnly((mm) => {
      const sale = S().sales[mm[1]];
      if (!sale) return err(404, 'not_found');
      if (sale.status !== 'pending') return err(409, 'already_paid');
      Object.assign(sale, { status: 'canceled', canceled_at: new Date(now()).toISOString() });
      ctx.emit('pos_sale', { sale_id: sale.sale_id, status: 'canceled', method: sale.method });
      return ok(saleView(sale));
    })],

    // ---------- бар ----------
    ['GET', /^\/api\/clubs\/([^/]+)\/bar\/queue$/, staffOnly(() => ok(S().orders.filter((o) => ['new', 'preparing', 'ready'].includes(o.status))))],
    ['POST', /^\/api\/orders\/([^/]+)\/status$/, staffOnly((mm, b) => {
      const o = S().orders.find((x) => x.id === mm[1]);
      if (!o) return err(404, 'not_found');
      const forward = { new: ['preparing', 'ready', 'served'], preparing: ['ready', 'served'], ready: ['served'] };
      if (!['preparing', 'ready', 'served', 'canceled'].includes(b.status)) return err(400, 'bad_request');
      if (o.status === b.status) return ok(o);
      if (!forward[o.status]) return err(409, 'order_closed');
      if (!forward[o.status].includes(b.status)) return err(400, 'bad_request');
      Object.assign(o, { status: b.status, status_at: new Date(now()).toISOString() });
      ctx.audit('order.status', { resource_number: o.resource?.number ?? null, data: {} });
      ctx.emit('bar', o);
      return ok(o);
    })],

    // ---------- смены ----------
    // Как у backend-kkt: { shift }; expected_cash_kopecks и cash_sales_kopecks в открытой смене — предложение frontend
    // Как server/shifts/service.mjs currentShiftFor: ресепшну — вслепую, без ожидаемых наличных; управляющему — с ними
    ['GET', /^\/api\/clubs\/([^/]+)\/shifts\/current$/, staffOnly(() => {
      const s = liveShift();
      if (!s || can('manager', 'owner')) return ok({ shift: s });
      const { expected_cash_kopecks: _e, cash_sales_kopecks: _c, cash_refunds_kopecks: _r, ...blind } = s;
      return ok({ shift: blind });
    })],
    ['GET', /^\/api\/clubs\/([^/]+)\/shifts$/, managerOnly(() => {
      const list = S().shifts.map((s) => ({ ...s, revenue_total_kopecks: totalOf(S().reports[s.id]) }));
      const cur = liveShift();
      return ok({ items: cur ? [{ ...cur, revenue_total_kopecks: totalOf(liveReport()) }, ...list] : list, next_cursor: null });
    })],
    ['POST', /^\/api\/clubs\/([^/]+)\/shifts$/, staffOnly((_m, b) => {
      if (S().shift) return err(409, 'shift_open');
      if (!Number.isSafeInteger(b.float_kopecks) || b.float_kopecks < 0) return err(400, 'bad_request');
      S().shift = shiftRow({ opened: now(), float: b.float_kopecks, cash: 0, by: ctx.me()?.id ?? null, number: 215 });
      Object.assign(S().shift, { opened_by_name: ctx.me()?.name ?? null, expected_cash_kopecks: null });
      ctx.audit('shift.open', { data: { amount_kopecks: b.float_kopecks } });
      ctx.emit('shift', liveShift());
      return ok(liveShift());
    })],
    ['POST', /^\/api\/shifts\/([^/]+)\/close$/, staffOnly((mm, b) => {
      const s = S().shift;
      if (!s || s.id !== mm[1]) return err(409, 'shift_closed');
      if (!Number.isSafeInteger(b.actual_cash_kopecks) || b.actual_cash_kopecks < 0) return err(400, 'bad_request');
      const live = liveShift();
      const closed = {
        ...live,
        status: 'closed',
        closed_at: new Date(now()).toISOString(),
        closed_by: ctx.me()?.id ?? null,
        closed_by_name: ctx.me()?.name ?? null,
        actual_cash_kopecks: b.actual_cash_kopecks,
        discrepancy_kopecks: b.actual_cash_kopecks - live.expected_cash_kopecks,
        close_comment: b.comment ?? null,
        report_sent_at: new Date(now()).toISOString(),
      };
      S().reports[closed.id] = { ...liveReport(), shift: closed };
      S().shifts.unshift(closed);
      S().shift = null;
      if (closed.discrepancy_kopecks !== 0) ctx.state().alarms.unshift({ id: uuid(), type: 'shift_discrepancy', level: 'critical', created_at: closed.closed_at, data: { amount_kopecks: closed.discrepancy_kopecks } });
      ctx.audit('shift.close', { data: { amount_kopecks: closed.discrepancy_kopecks } });
      ctx.emit('shift', null);
      return ok(closed);
    })],
    ['GET', /^\/api\/shifts\/([^/]+)\/report$/, managerOnly((mm) => {
      if (S().shift?.id === mm[1]) return ok(liveReport());
      return S().reports[mm[1]] ? ok(S().reports[mm[1]]) : err(404, 'not_found');
    })],

    // ---------- склад ----------
    ['GET', /^\/api\/clubs\/([^/]+)\/stock$/, managerOnly(() => ok(stockList()))],
    ['POST', /^\/api\/stock\/arrivals$/, managerOnly((_m, b) => {
      const items = Array.isArray(b.items) ? b.items : [];
      if (!items.length || items.some((i) => !product(i.product_id) || !(i.qty > 0) || !Number.isSafeInteger(i.unit_cost_kopecks))) return err(400, 'bad_request');
      for (const i of items) {
        const p = product(i.product_id);
        const old = Math.max(0, p.stock_qty ?? 0);
        p.cost_kopecks = Math.round((old * (p.cost_kopecks ?? 0) + i.qty * i.unit_cost_kopecks) / (old + i.qty));
        p.stock_qty = Math.round((old + i.qty) * 1000) / 1000;
        p.track_stock = true;
      }
      const cost = items.reduce((s, i) => s + Math.round(i.qty * i.unit_cost_kopecks), 0);
      ctx.audit('stock.arrival', { data: { amount_kopecks: cost } });
      return ok({ items: stockList().filter((x) => items.some((i) => i.product_id === x.product_id)), cost_kopecks: cost });
    })],
    ['POST', /^\/api\/stock\/writeoffs$/, managerOnly((_m, b) => {
      const items = Array.isArray(b.items) ? b.items : [];
      if (!String(b.reason ?? '').trim()) return err(400, 'reason_required');
      if (!items.length || items.some((i) => !product(i.product_id) || !(i.qty > 0))) return err(400, 'bad_request');
      if (items.some((i) => product(i.product_id).stock_qty < i.qty)) return err(409, 'out_of_stock');
      for (const i of items) product(i.product_id).stock_qty = Math.round((product(i.product_id).stock_qty - i.qty) * 1000) / 1000;
      const amount = items.reduce((s, i) => s + Math.round(i.qty * product(i.product_id).cost_kopecks), 0);
      ctx.audit('stock.writeoff', { reason: b.reason, data: { amount_kopecks: amount } });
      return ok({ items, cost_kopecks: amount });
    })],
    ['POST', /^\/api\/stock\/audits$/, managerOnly((_m, b) => {
      const items = Array.isArray(b.items) ? b.items : [];
      if (!items.length || items.some((i) => !product(i.product_id) || !(i.actual_qty >= 0))) return err(400, 'bad_request');
      const lines = items.map((i) => {
        const p = product(i.product_id);
        const expected = p.stock_qty ?? 0;
        const diff = Math.round((i.actual_qty - expected) * 1000) / 1000;
        return { product_id: p.id, name: p.name, expected_qty: expected, actual_qty: i.actual_qty, diff_qty: diff, diff_kopecks: Math.round(diff * p.cost_kopecks) };
      });
      for (const l of lines) product(l.product_id).stock_qty = l.actual_qty;
      const net = lines.reduce((s, l) => s + l.diff_kopecks, 0);
      ctx.audit('stock.audit', { data: { amount_kopecks: net } });
      return ok({ audit_id: uuid(), lines, total_diff_kopecks: net, created_at: new Date(now()).toISOString() });
    })],

    // ---------- меню (управляющий) ----------
    ['POST', /^\/api\/clubs\/([^/]+)\/catalog\/products$/, managerOnly((_m, b) => {
      const v = validateProduct({ category_id: null, ...b });
      if (v) return v;
      const p = { id: uuid(), category_id: null, description: null, sku: null, unit: 'шт', is_alcohol: false, vat_code: null, payment_subject: 'commodity', stop_list: false, track_stock: false, photo: null, sort: cat().products.length + 1, active: true, modifier_group_ids: [], stock_qty: null, cost_kopecks: 0, min_qty: null, ...b };
      if (p.track_stock && p.stock_qty === null) p.stock_qty = 0;
      cat().products.push(p);
      ctx.audit('menu.product', { data: {} });
      return ok(p);
    })],
    ['PATCH', /^\/api\/catalog\/products\/([^/]+)$/, managerOnly((mm, b) => {
      const p = product(mm[1]);
      if (!p) return err(404, 'not_found');
      const v = validateProduct({ ...p, ...b });
      if (v) return v;
      Object.assign(p, b);
      if (p.track_stock && p.stock_qty === null) p.stock_qty = 0;
      ctx.audit(b.stop_list !== undefined && Object.keys(b).length === 1 ? 'menu.stop_list' : 'menu.product', { data: {} });
      return ok(p);
    })],
    ['POST', /^\/api\/clubs\/([^/]+)\/catalog\/modifier-groups$/, managerOnly((_m, b) => {
      if (!String(b.name ?? '').trim() || !Array.isArray(b.modifiers) || !b.modifiers.length) return err(400, 'bad_request');
      const g = { id: uuid(), name: b.name, min_select: b.min_select ?? 0, max_select: b.max_select ?? 1, sort: cat().modifier_groups.length + 1, active: true, modifiers: b.modifiers.map((x, i) => ({ id: uuid(), name: x.name, price_delta_kopecks: x.price_delta_kopecks ?? 0, stock_factor: 1, is_default: i === 0 && (b.min_select ?? 0) > 0, sort: i, active: true })) };
      cat().modifier_groups.push(g);
      return ok(g);
    })],
    ['PATCH', /^\/api\/catalog\/modifier-groups\/([^/]+)$/, managerOnly((mm, b) => {
      const g = cat().modifier_groups.find((x) => x.id === mm[1]);
      if (!g) return err(404, 'not_found');
      for (const k of ['name', 'min_select', 'max_select', 'active']) if (b[k] !== undefined) g[k] = b[k];
      if (g.min_select > g.max_select) return err(400, 'bad_request');
      return ok(g);
    })],
    ['POST', /^\/api\/catalog\/modifier-groups\/([^/]+)\/modifiers$/, managerOnly((mm, b) => {
      const g = cat().modifier_groups.find((x) => x.id === mm[1]);
      if (!g) return err(404, 'not_found');
      if (!String(b.name ?? '').trim()) return err(400, 'bad_request');
      const mod = { id: uuid(), group_id: g.id, name: b.name, price_delta_kopecks: b.price_delta_kopecks ?? 0, stock_factor: 1, is_default: false, sort: g.modifiers.length, active: true };
      g.modifiers.push(mod);
      return ok(mod);
    })],
    ['PATCH', /^\/api\/catalog\/modifiers\/([^/]+)$/, managerOnly((mm, b) => {
      const mod = cat().modifier_groups.flatMap((g) => g.modifiers).find((x) => x.id === mm[1]);
      if (!mod) return err(404, 'not_found');
      for (const k of ['name', 'price_delta_kopecks', 'active', 'is_default']) if (b[k] !== undefined) mod[k] = b[k];
      return ok(mod);
    })],
    ['POST', /^\/api\/clubs\/([^/]+)\/catalog\/import$/, managerOnly((_m, b, q) => {
      // M5.1: файл телом запроса (.xlsx или .csv), предпросмотр — ?dry_run=1
      if (b.__raw) return ctx.importFile(b, q?.get('dry_run') === '1');
      if (typeof b.csv !== 'string' || !b.csv) return err(400, 'bad_request');
      const parsed = menuFromCsv(b.csv);
      if (parsed.errors.length) return ok({ applied: false, created: 0, updated: 0, unchanged: 0, categories_created: [], errors: parsed.errors.map((e) => ({ line: e.line, field: null, code: 'bad_name' })) });
      let created = 0;
      let updated = 0;
      const newCats = [];
      for (const r of parsed.rows) {
        let c = r.category ? cat().categories.find((x) => x.name.toLowerCase() === r.category.toLowerCase()) : null;
        if (r.category && !c && !b.dry_run) {
          c = { id: uuid(), name: r.category, sort: cat().categories.length + 1, active: true };
          cat().categories.push(c);
          newCats.push(r.category);
        }
        const existing = cat().products.find((p) => p.name.toLowerCase() === r.name.toLowerCase() && (p.category_id ?? null) === (c?.id ?? null));
        if (existing) {
          updated += 1;
          if (!b.dry_run) Object.assign(existing, { price_kopecks: r.price_kopecks, unit: r.unit, is_alcohol: r.is_alcohol, vat_code: r.vat_code });
        } else {
          created += 1;
          if (!b.dry_run) cat().products.push({ id: uuid(), category_id: c?.id ?? null, name: r.name, description: null, sku: null, price_kopecks: r.price_kopecks, unit: r.unit, is_alcohol: r.is_alcohol, vat_code: r.vat_code, payment_subject: r.is_alcohol ? 'excise' : 'commodity', stop_list: false, track_stock: true, photo: null, sort: cat().products.length + 1, active: true, modifier_group_ids: [], stock_qty: 0, cost_kopecks: 0, min_qty: null });
        }
      }
      return ok({ applied: !b.dry_run, created, updated, unchanged: 0, categories_created: newCats, errors: [], rows: b.dry_run ? parsed.rows : undefined });
    })],

    // ---------- стоп-лист: бармен, ресепшн и выше (№88, №97); SSE stop_list в канал клуба ----------
    ['POST', /^\/api\/catalog\/products\/([^/]+)\/stop-list$/, (mm, b) => {
      if (!can('bar', 'reception', 'manager', 'owner')) return err(403, 'forbidden');
      const p = product(mm[1]);
      if (!p) return err(404, 'not_found');
      if (typeof b.stop_list !== 'boolean') return err(400, 'bad_request');
      p.stop_list = b.stop_list;
      ctx.audit('catalog.stop_list', { data: { product_id: p.id } });
      ctx.emit('stop_list', { product_id: p.id, stop_list: p.stop_list, active: p.active !== false });
      return ok(p);
    }],

    // ---------- чеки ККТ, как server/kkt/api.mjs ----------
    ['GET', /^\/api\/clubs\/([^/]+)\/kkt\/receipts$/, staffOnly((_m, _b, q) => {
      const st = q.get('status') ?? 'open';
      const fromSales = Object.values(S().sales)
        .filter((x) => x.receipt_status === 'receipt_pending')
        .map((x) => ({ id: x.receipt_id, kind: 'sale', status: 'pending', amount_kopecks: x.total_kopecks, payment_id: x.payment_id, sale_id: x.sale_id, refund_id: null, created_at: x.completed_at, attempts: 1, error: null, next_attempt_at: null, fd: null, fp: null, fn: null, printed_at: null, operator_name: ctx.me()?.name ?? null }));
      const all = [...(S().receipts ?? []), ...fromSales];
      const pick = { open: ['pending', 'unknown', 'failed'], pending: ['pending'], unknown: ['unknown'], failed: ['failed'], printed: ['printed'] }[st];
      if (!pick) return err(400, 'bad_request');
      return ok(all.filter((r) => pick.includes(r.status)));
    })],
    ['POST', /^\/api\/kkt\/receipts\/([^/]+)\/retry$/, managerOnly((mm, b) => {
      const r = (S().receipts ?? []).find((x) => x.id === mm[1]);
      if (!r) return err(404, 'not_found');
      if (!String(b.reason ?? '').trim()) return err(400, 'reason_required');
      if (!['failed', 'unknown'].includes(r.status)) return err(409, 'receipt_not_failed');
      Object.assign(r, { status: 'pending', attempts: r.attempts + 1 });
      ctx.audit('kkt.receipt_retry', { reason: b.reason, data: { amount_kopecks: r.amount_kopecks } });
      ctx.emit('kkt', kktStatus());
      return ok(r);
    })],
    ['POST', /^\/api\/kkt\/receipts\/([^/]+)\/mark-printed$/, managerOnly((mm, b) => {
      const r = (S().receipts ?? []).find((x) => x.id === mm[1]);
      if (!r) return err(404, 'not_found');
      if (!String(b.reason ?? '').trim()) return err(400, 'reason_required');
      if (r.status !== 'unknown') return err(409, 'receipt_not_unknown');
      if (!Number.isInteger(b.fd) || !/^\d{1,10}$/.test(String(b.fp ?? ''))) return err(400, 'bad_request');
      Object.assign(r, { status: 'printed', fd: b.fd, fp: String(b.fp), printed_at: new Date(now()).toISOString() });
      ctx.audit('kkt.receipt_mark_printed', { reason: b.reason, data: { amount_kopecks: r.amount_kopecks } });
      ctx.emit('kkt', kktStatus());
      return ok(r);
    })],

    // ---------- ККТ, как server/kkt/bridges.mjs: список — управляющий и выше, регистрация и отзыв — владелец ----------
    ['GET', /^\/api\/clubs\/([^/]+)\/kkt\/bridges$/, managerOnly(() => ok(S().bridges))],
    ['POST', /^\/api\/clubs\/([^/]+)\/kkt\/bridges$/, (_m, b) => {
      if (!can('owner')) return err(403, 'forbidden');
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (!name || name.length > 100) return err(400, 'bad_request');
      if (S().bridges.filter((x) => !x.revoked_at).length >= 10) return err(409, 'limit_exceeded');
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
      const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const bridge = { id: uuid(), name, kkt_model: null, bridge_version: null, created_at: new Date(now()).toISOString(), last_seen_at: null, last_status: null, online: false, revoked_at: null };
      S().bridges.push(bridge);
      ctx.audit('kkt.bridge_register', { data: {} });
      // Мост «выходит на связь» через 6 секунд — экран видит это по SSE kkt и опросу
      const timer = setTimeout(() => {
        Object.assign(bridge, { online: true, last_seen_at: new Date(now()).toISOString(), kkt_model: 'АТОЛ 30Ф', bridge_version: '0.1.0' });
        ctx.save();
        ctx.emit('kkt', kktStatus());
      }, 6000);
      timer?.unref?.();
      return ok({ bridge, token });
    }],
    ['POST', /^\/api\/kkt\/bridges\/([^/]+)\/revoke$/, (mm) => {
      if (!can('owner')) return err(403, 'forbidden');
      const bridge = S().bridges.find((x) => x.id === mm[1] && !x.revoked_at);
      if (!bridge) return err(404, 'not_found');
      Object.assign(bridge, { revoked_at: new Date(now()).toISOString(), online: false });
      ctx.audit('kkt.bridge_revoke', { data: {} });
      ctx.emit('kkt', kktStatus());
      return ok({ ...bridge });
    }],
  ];
}

/** Новые заказы со столов приходят сами — чтобы слышать звук экрана бара. */
export function m2Tick(ctx) {
  const S = ctx.state().m2;
  if (!S?.catalog || !ctx.state().user || ctx.state().scenario === 'empty') return;
  if (ctx.now() < S.nextQrOrderAt) return;
  S.nextQrOrderAt = ctx.now() + 75_000;
  const busy = ctx.state().hall.filter((x) => x.session && x.status === 'busy');
  if (!busy.length || S.orders.filter((o) => o.status === 'new').length >= 4) return;
  const table = busy[S.nextOrderNumber % busy.length];
  const order = makeOrder(S.catalog, { number: S.nextOrderNumber++, session: table.session.id, table: table.resource.number, status: 'new', minAgo: 0, pay: 'tab', items: [['Американо', 1, ['0,3 л', '1 ложка']], ['Мел для кия', 1]] }, ctx.now());
  S.orders.push(order);
  ctx.emit('bar', order);
}
