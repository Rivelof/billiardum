/*
 * BL_MOCK_MARKER — заглушка M5.2 «Дашборд владельца» (только VITE_MOCK=1), по docs/contracts/m5-2.md §4.
 * Формы ответов — допущения frontend (web/admin/README.md, раздел M5.2), пока backend не выложил примеры.
 *
 * Синтетические данные, детерминированные по дате: клуб на 8 столов (5 пирамид, 3 пула), работает 12:00–03:00,
 * сутки с 06:00; будни тише, пятница и суббота громче, днём в выходные больше игр, вечерний пик 20–22 ч;
 * бар ~25 % выручки; клуб растёт; история — 90 дней (`dashboard-year` — 400 дней, проверка графика на 366 дней).
 * Ручных действий пара за неделю, расхождение кассы 100 ₽ три дня назад, тревоги с разной реакцией.
 * `dashboard-empty` — клуб без игр: честные пустые состояния.
 */

import { addDays, eachDay, spanDays, weekday, workDate, comparePeriod } from '../lib/period.js';
import { toCsv, csvMoney, csvDate } from '../lib/export.js';
import { KIND_LABEL } from '../lib/dashboard.js';
import { resourceName } from '@billiardum/shared/resource';
import { ACTION_LABEL } from '../lib/audit.js';
import { FORECAST_MIN_DAYS, FORECAST_WEEKS, median, medianForecast } from '../lib/forecast.js';

const MIN = 60_000;
const DAY_START = '06:00';
const OPEN_HOURS = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2];
const HOUR_BASE = { 12: 0.18, 13: 0.2, 14: 0.22, 15: 0.25, 16: 0.32, 17: 0.42, 18: 0.58, 19: 0.74, 20: 0.85, 21: 0.89, 22: 0.83, 23: 0.66, 0: 0.48, 1: 0.3, 2: 0.15 };
const DOW_MUL = { 1: 0.78, 2: 0.8, 3: 0.86, 4: 0.92, 5: 1.12, 6: 1.2, 7: 1.0 };
const WORK_ORDER = Array.from({ length: 24 }, (_, i) => (6 + i) % 24);

export const CLUBS = [
  {
    id: '0b6b8c1e-5a7d-4f0e-9c3a-2d1e4f5a6b7c',
    name: 'Клуб для разработки',
    seed: 'dev',
    tables: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: `00000000-0000-4000-8000-00000000000${n}`, number: n, kind: n <= 5 ? 'pyramid' : 'pool' })),
    scale: 1,
  },
  {
    id: '0b6b8c1e-5a7d-4f0e-9c3a-2d1e4f5a6b8d',
    name: 'Второй клуб (заглушка)',
    seed: 'second',
    tables: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `00000000-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`, number: n, kind: n <= 4 ? 'pyramid' : 'snooker' })),
    scale: 0.8,
  },
];

/**
 * M5.8 (?mock=court…): в клубе разработки ещё два падел-корта — «Корт 1» и «Корт 2» (id как в зале заглушки).
 * Вид ресурса в заглушке — kind мастера: pyramid | pool | snooker | padel_court; тип сервера — typeOf.
 */
export const COURT_IDS = ['c0000000-0000-4000-8000-0000000000c1', 'c0000000-0000-4000-8000-0000000000c2'];
const COURT = 'padel_court';
const typeOf = (kind) => (kind === COURT ? COURT : `billiard_${kind}`);
/** Фильтр kind дашборда (тип ресурса или семья table | court, server/dashboard matchKind) → вид заглушки. */
const normKind = (k) => (!k ? null : k === 'table' || k === 'court' || k === COURT ? k : String(k).replace(/^billiard_/, ''));
const matchKind = (tk, kind) => !kind || tk === kind || (kind === 'table' && tk !== COURT) || (kind === 'court' && tk === COURT);
const nameOf = (t) => resourceName(t.kind === COURT ? 'court' : 'table', t.number);
export function clubsOf(scenario) {
  if (!String(scenario ?? '').startsWith('court')) return CLUBS;
  return [{ ...CLUBS[0], tables: [...CLUBS[0].tables, ...COURT_IDS.map((id, i) => ({ id, number: i + 1, kind: COURT }))] }, ...CLUBS.slice(1)];
}

/** Цена часа корта по тарифу заглушки: слот 1,5 ч — 2 400 ₽ днём, 3 000 ₽ вечером (1 600 и 2 000 ₽ в час). */
const courtHourPrice = (dow, hour) => (hour >= 18 || hour < 6 ? 200000 : 160000);

const STAFF = {
  owner: { id: 'u-owner-0001', name: 'Андрей', role: 'owner' },
  manager: { id: 'u-manager-0002', name: 'Ольга Р.', role: 'manager' },
  reception: { id: 'u-recept-0003', name: 'Анна К.', role: 'reception' },
  reception2: { id: 'u-recept-0004', name: 'Игорь П.', role: 'reception' },
};

/** Хеш строки → генератор псевдослучайных чисел [0, 1). */
export function rng(key) {
  let h = 1779033703 ^ key.length;
  for (let i = 0; i < key.length; i += 1) {
    h = Math.imul(h ^ key.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const between = (r, a, b) => a + (b - a) * r();

/** Цена часа как в тарифах клуба разработки: будни 500 / 800 ₽, выходные (пятница вечер, сб, вс) 600 / 1 000 ₽. */
function hourPrice(dow, hour) {
  const night = hour < 6;
  const evening = hour >= 18 || night;
  const weekend = dow === 6 || dow === 7 || (dow === 5 && evening);
  if (weekend) return evening ? 100000 : 60000;
  return evening ? 80000 : 50000;
}

export function createDashboardMock({ now, scenario }) {
  const empty = scenario === 'dashboard-empty';
  const CLUBS = clubsOf(scenario);
  // M5.6: forecast-empty — клуб работает 10 дней, истории для прогноза мало
  const historyDays = scenario === 'dashboard-year' ? 400 : scenario === 'forecast-empty' ? 10 : 90;
  const tz = 'Asia/Yekaterinburg';
  const cache = new Map();
  const today = () => workDate(now(), tz, DAY_START);
  /** Сколько рабочих часов текущих суток уже прошло (сутки с 06:00). */
  const elapsedHours = () => {
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date(now()));
    return (Number(local) - 6 + 24) % 24;
  };

  function day(club, date) {
    const key = `${club.seed}|${date}|${date === today() ? elapsedHours() : 'x'}`;
    if (cache.has(key)) return cache.get(key);
    const age = spanDays(date, today()) - 1; // 0 — сегодня
    const open = !empty && age >= 0 && age < historyDays;
    const dow = weekday(date);
    const r = rng(`${club.seed}:${date}`);
    const growth = 0.88 + 0.12 * (1 - age / historyDays);
    const isToday = age === 0;
    const limit = isToday ? elapsedHours() : 24;
    const tables = club.tables.map((t) => {
      const play = Array(24).fill(0);
      const service = Array(24).fill(0);
      let revenue = 0;
      if (open) {
        const factor = (t.kind === 'pyramid' ? 1 : t.kind === 'pool' ? 0.86 : t.kind === COURT ? 0.55 : 0.7) * club.scale;
        const price = t.kind === COURT ? courtHourPrice : hourPrice;
        for (const hour of OPEN_HOURS) {
          if (WORK_ORDER.indexOf(hour) >= limit) continue;
          let p = HOUR_BASE[hour] * DOW_MUL[dow] * growth * factor;
          if ((dow === 6 || dow === 7) && hour >= 12 && hour < 18) p *= 1.7;
          p += between(r, -0.18, 0.18);
          let minutes = r() < 0.12 * (1 - p) ? 0 : Math.max(0, Math.min(60, Math.round(60 * p)));
          if (r() < 0.012) {
            service[hour] = 20;
            minutes = Math.min(minutes, 40);
          }
          play[hour] = minutes;
          revenue += Math.round(((minutes / 60) * price(dow, hour)) / 100) * 100;
        }
        // Перетяжка сукна: стол 5, 33 дня назад — 4 часа сервиса днём
        if (club.seed === 'dev' && t.number === 5 && age === 33) {
          for (const h of [12, 13, 14, 15]) {
            revenue -= Math.round(((play[h] / 60) * hourPrice(dow, h)) / 100) * 100;
            play[h] = 0;
            service[h] = 60;
          }
        }
      }
      return { ...t, play, service, revenue, playTotal: play.reduce((s, v) => s + v, 0), serviceTotal: service.reduce((s, v) => s + v, 0) };
    });
    const playTotal = tables.reduce((s, t) => s + t.playTotal, 0);
    const tablesRevenue = tables.reduce((s, t) => s + t.revenue, 0);
    const games = open ? Math.round(playTotal / between(r, 84, 100)) : 0;
    const bar = open ? Math.round((tablesRevenue * between(r, 0.29, 0.37)) / 100) * 100 : 0;
    const barOrders = bar ? Math.max(1, Math.round(bar / between(r, 36000, 46000))) : 0;
    const deposits = open && r() < 0.3 ? 300000 : 0;
    const packages = open && r() < 0.22 ? 450000 : 0;
    const tParticipants = open && dow === 7 ? Math.round(between(r, 12, 16)) : 0;
    const tournaments = tParticipants * 50000;
    const refunds = club.seed === 'dev' && open && (age === 12 || age === 41) ? 80000 : 0;
    const other = deposits + packages + tournaments;
    const revenue = tablesRevenue + bar + other - refunds;
    const gross = tablesRevenue + bar + other;
    const rub = (v) => Math.round(v / 100) * 100;
    const sbp = rub(gross * between(r, 0.4, 0.48));
    const card = rub(gross * between(r, 0.12, 0.16));
    const cash = rub(gross * between(r, 0.2, 0.26));
    const cardTerminal = gross - sbp - card - cash;
    const online = rub(tablesRevenue * 0.06);
    const reception = cash + cardTerminal;
    const qr = Math.max(0, gross - reception - online - tournaments);
    const extensions = open ? Math.round(games * between(r, 0.25, 0.35)) : 0;
    const bookings = open ? Math.round(between(r, 2, 4) + 4 * (DOW_MUL[dow] - 0.7)) : 0;
    const noShow = open ? Math.round(bookings * between(r, 0.05, 0.14)) : 0;
    const canceled = open ? Math.round(bookings * between(r, 0, 0.08)) : 0;
    const d = {
      date,
      dow,
      open,
      tables,
      playTotal,
      serviceTotal: tables.reduce((s, t) => s + t.serviceTotal, 0),
      capacity: open ? club.tables.length * OPEN_HOURS.filter((h) => WORK_ORDER.indexOf(h) < limit).length * 60 : 0,
      tablesRevenue,
      bar,
      barOrders,
      deposits,
      packages,
      tournaments,
      tParticipants,
      other,
      refunds,
      refundCount: refunds ? 1 : 0,
      revenue,
      methods: { sbp, card, cash, card_terminal: cardTerminal },
      sources: { qr, reception, online_booking: online, tournament: tournaments },
      games,
      noStaffGames: Math.round(games * between(r, 0.58, 0.7)),
      scanToLight: open ? Math.round(between(r, 5, 9)) : null,
      guestsNew: open ? Math.round(between(r, 2, 6) * DOW_MUL[dow]) : 0,
      guestsReturning: open ? Math.round(games * between(r, 0.55, 0.7)) : 0,
      bookings,
      arrived: Math.max(0, bookings - noShow - canceled),
      noShow,
      canceled,
      leadMinutes: open ? Math.round(between(r, 140, 260)) : null,
      queueOffered: open && dow >= 5 ? Math.round(between(r, 1, 4)) : 0,
      extensions,
      extensionsApp: Math.round(extensions * between(r, 0.75, 0.88)),
      packagesSold: packages ? 1 : 0,
      packagesUsed: open ? Math.round(between(r, 0, 240)) : 0,
      plusGames: open ? Math.round(games * between(r, 0.08, 0.15)) : 0,
    };
    d.queueTaken = Math.round(d.queueOffered * 0.7);
    // Расходы кассы управляющего (№177): аренда 1-го числа, закупка бара по понедельникам, зарплата 5-го и 20-го
    d.expenses = [];
    if (open || (age >= 0 && age < historyDays && !empty)) {
      const dd = Number(date.slice(8));
      if (dd === 1) d.expenses.push({ category: 'Аренда', amount: 9000000 * club.scale });
      if (dow === 1) d.expenses.push({ category: 'Закупка', amount: Math.round(bar * 0.35 * 7 / 100) * 100 || 1500000 });
      if (dd === 5 || dd === 20) d.expenses.push({ category: 'Зарплата', amount: 4500000 * club.scale });
      if (dd === 10) d.expenses.push({ category: 'Коммунальные', amount: 1200000 * club.scale });
    }
    d.expenseTotal = d.expenses.reduce((s, e) => s + e.amount, 0);
    cache.set(key, d);
    return d;
  }

  /** События по клубу разработки: ручные действия, тревоги, смены с расхождением — относительно сегодняшнего дня. */
  function events(club, from, to) {
    if (empty || club.seed !== 'dev') return { manual: [], alarms: [] };
    const t = now();
    const at = (daysAgo, hour, min = 0) => {
      const date = addDays(today(), -daysAgo);
      // Местное время клуба (UTC+5) → ISO
      const h = hour < 6 ? hour + 24 : hour;
      return new Date(Date.parse(`${date}T00:00:00+05:00`) + (h * 60 + min) * MIN).toISOString();
    };
    const manual = [
      { id: 'ma-1', at: new Date(t - 3 * MIN).toISOString(), action: 'service.start', staff: STAFF.reception, resource_number: 5, reason: 'Протираем сукно после пролитого напитка' },
      { id: 'ma-2', at: at(1, 21, 40), action: 'manual.extend_free', staff: STAFF.manager, resource_number: 1, reason: 'Свет мигнул из-за сбоя питания, компенсировали 15 минут' },
      { id: 'ma-3', at: at(9, 19, 5), action: 'manual.discount', staff: STAFF.manager, resource_number: null, reason: 'Постоянный гость, день рождения', amount_kopecks: 45000 },
      { id: 'ma-4', at: at(23, 22, 15), action: 'pos.sale_canceled', staff: STAFF.reception2, resource_number: null, reason: 'Гость передумал, заказ не готовили', amount_kopecks: 32000 },
      { id: 'ma-5', at: at(41, 20, 30), action: 'payment.refunded', staff: STAFF.manager, resource_number: 3, reason: 'Не включился свет, вернули оплату', amount_kopecks: 80000 },
      { id: 'ma-6', at: at(56, 18, 0), action: 'manual.tariff_change', staff: STAFF.owner, resource_number: null, reason: 'Подняли вечернюю цену в выходные' },
    ];
    const alarms = [
      { id: 'al-1', type: 'bypass_detected', level: 'critical', resource_number: 2, raised_at: new Date(t - 6 * MIN).toISOString(), acked_at: null, acked_by_name: null },
      { id: 'al-2', type: 'device_offline', level: 'critical', resource_number: 8, raised_at: new Date(t - 14 * MIN).toISOString(), acked_at: null, acked_by_name: null },
      { id: 'al-3', type: 'device_offline', level: 'critical', resource_number: 8, raised_at: at(2, 20, 12), acked_at: at(2, 20, 16), acked_by_name: STAFF.reception.name },
      { id: 'al-4', type: 'kkt_offline', level: 'important', resource_number: null, raised_at: at(5, 19, 0), acked_at: at(5, 19, 18), acked_by_name: STAFF.reception2.name },
      { id: 'al-5', type: 'lamp_fault', level: 'important', resource_number: 4, raised_at: at(15, 22, 40), acked_at: at(15, 22, 42), acked_by_name: STAFF.manager.name },
      { id: 'al-6', type: 'bypass_detected', level: 'critical', resource_number: 6, raised_at: at(30, 23, 10), acked_at: at(30, 23, 17), acked_by_name: STAFF.manager.name },
      { id: 'al-7', type: 'shift_discrepancy', level: 'important', resource_number: null, raised_at: at(3, 3, 5), acked_at: at(3, 3, 40), acked_by_name: STAFF.owner.name },
      { id: 'al-8', type: 'receipt_stuck', level: 'important', resource_number: null, raised_at: at(61, 21, 0), acked_at: at(61, 21, 25), acked_by_name: STAFF.owner.name },
    ];
    const inPeriod = (iso) => {
      const d = workDate(Date.parse(iso), tz, DAY_START);
      return d >= from && d <= to;
    };
    return {
      manual: manual.filter((m) => inPeriod(m.at)).map(({ staff, ...m }) => ({ ...m, staff_id: staff.id, staff_name: staff.name, role: staff.role })),
      alarms: alarms.filter((a) => inPeriod(a.raised_at)),
    };
  }

  /** Сумма по периоду и типу стола. */
  function aggregate(clubs, from, to, kind) {
    const days = eachDay(from, to);
    const per = days.map((date) => {
      const ds = clubs.map((c) => day(c, date));
      const row = { date, tables: 0, bar: 0, other: 0, refunds: 0, games: 0, barOrders: 0, play: 0, service: 0, capacity: 0, byKind: {}, deposits: 0, packages: 0, tournaments: 0 };
      for (const d of ds) {
        const tbl = d.tables.filter((t) => matchKind(t.kind, kind));
        const share = d.tablesRevenue ? tbl.reduce((s, t) => s + t.revenue, 0) / d.tablesRevenue : kind ? 0 : 1;
        const tr = tbl.reduce((s, t) => s + t.revenue, 0);
        row.tables += tr;
        row.bar += Math.round(d.bar * share);
        row.barOrders += Math.round(d.barOrders * share);
        row.deposits += kind ? 0 : d.deposits;
        row.packages += kind ? 0 : d.packages;
        row.tournaments += kind ? 0 : d.tournaments;
        row.other += kind ? 0 : d.other;
        row.refunds += kind ? 0 : d.refunds;
        row.games += Math.round(d.games * share);
        row.play += tbl.reduce((s, t) => s + t.playTotal, 0);
        row.service += tbl.reduce((s, t) => s + t.serviceTotal, 0);
        const cap = d.capacity ? d.capacity / d.tables.length : 0;
        row.capacity += cap * tbl.length;
        for (const t of tbl) {
          const k = (row.byKind[t.kind] ??= { play: 0, capacity: 0, revenue: 0, tables: 0 });
          k.play += t.playTotal;
          k.capacity += cap;
          k.revenue += t.revenue;
          k.tables += 1;
        }
        row.share = share;
      }
      row.revenue = row.tables + row.bar + row.other - row.refunds;
      return { row, ds };
    });
    return { days, per };
  }

  function sumBy(per, fn) {
    return per.reduce((s, p) => s + p.ds.reduce((x, d) => x + (fn(d, p.row) ?? 0), 0), 0);
  }

  function totals(clubs, from, to, kind) {
    const { per } = aggregate(clubs, from, to, kind);
    const s = (k) => per.reduce((acc, p) => acc + p.row[k], 0);
    const n = per.length;
    const tablesInWork = clubs.reduce((acc, c) => acc + c.tables.filter((t) => matchKind(t.kind, kind)).length, 0);
    const games = s('games');
    const play = s('play');
    const capacity = s('capacity');
    const revenue = s('revenue');
    const share = kind ? (s('tables') / Math.max(1, sumBy(per, (d) => d.tablesRevenue))) : 1;
    const guestsNew = Math.round(sumBy(per, (d) => d.guestsNew) * share);
    const guestsRet = Math.round(sumBy(per, (d) => d.guestsReturning) * share * 0.55);
    const expense = kind ? null : sumBy(per, (d) => d.expenseTotal);
    const noStaff = sumBy(per, (d) => d.noStaffGames);
    const allGames = sumBy(per, (d) => d.games);
    const ev = clubs.map((c) => events(c, from, to));
    const manual = ev.flatMap((e) => e.manual);
    const alarms = ev.flatMap((e) => e.alarms);
    const discrepancy = clubs.some((c) => c.seed === 'dev') && !empty && addDays(today(), -3) >= from && addDays(today(), -3) <= to ? 10000 : 0;
    const extTotal = sumBy(per, (d) => d.extensions);
    const extApp = sumBy(per, (d) => d.extensionsApp);
    const scan = per.flatMap((p) => p.ds.map((d) => d.scanToLight)).filter((x) => x !== null).sort((a, b) => a - b);
    return {
      per,
      revenue,
      tables: s('tables'),
      bar: s('bar'),
      other: s('other'),
      refunds: s('refunds'),
      refundCount: sumBy(per, (d) => d.refundCount),
      deposits: s('deposits'),
      packages: s('packages'),
      tournaments: s('tournaments'),
      games,
      play,
      service: s('service'),
      capacity,
      load: capacity ? (play / capacity) * 100 : null,
      avgGame: games ? Math.round(s('tables') / games) : null,
      avgBar: s('barOrders') ? Math.round(s('bar') / s('barOrders')) : null,
      perTableDay: tablesInWork && n && revenue ? Math.round(revenue / tablesInWork / n) : revenue === 0 ? 0 : null,
      hourPrice: play ? Math.round(s('tables') / (play / 60)) : null,
      guests: guestsNew + guestsRet,
      guestsNew,
      guestsRet,
      noStaffShare: allGames ? (noStaff / allGames) * 100 : null,
      expense,
      profit: expense === null ? null : revenue - expense,
      manual,
      alarms,
      discrepancy,
      extTotal,
      extApp,
      scanMedian: scan.length ? scan[Math.floor(scan.length / 2)] : null,
      tablesInWork,
    };
  }

  const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
  const pctOf = (a, b) => (b ? r1((a / b) * 100) : 0);
  const tile = (id, unit, value, prev, extra = {}) => ({ id, value, unit, prev: prev === undefined ? null : prev, delta_pct: prev === undefined || prev === null || value === null ? null : prev === 0 ? (value === 0 ? 0 : null) : r1(((value - prev) / Math.abs(prev)) * 100), ...extra });

  function clubsFor(clubId, user) {
    // Как сервер: «все клубы» — клубы, где пользователь владелец или управляющий (в заглушке — оба клуба)
    if (clubId === 'all') return ['owner', 'manager'].includes(user?.role) ? CLUBS : null;
    const c = CLUBS.find((x) => x.id === clubId);
    return c ? [c] : null;
  }

  /** Ячейки тепловой карты (минуты игры и ёмкости по дню недели и часу). */
  function cellsOf(cur, kind) {
    const cells = new Map();
    for (const p of cur.per) {
      for (const d of p.ds) {
        if (!d.open) continue;
        for (const t of d.tables) {
          if (!matchKind(t.kind, kind)) continue;
          for (let h = 0; h < 24; h += 1) {
            const isOpen = OPEN_HOURS.includes(h) && (d.date !== today() || WORK_ORDER.indexOf(h) < elapsedHours());
            const k = d.dow * 100 + h;
            const c = cells.get(k) ?? { dow: d.dow, hour: h, play: 0, cap: 0 };
            c.play += t.play[h];
            c.cap += isOpen ? 60 : 0;
            cells.set(k, c);
          }
        }
      }
    }
    return cells;
  }

  function resourcesOf(clubs, from, to, kind) {
    return clubs.flatMap((c) =>
      c.tables
        .filter((t) => matchKind(t.kind, kind))
        .map((t) => {
          let play = 0;
          let revenue = 0;
          let capacity = 0;
          let service = 0;
          for (const date of eachDay(from, to)) {
            const d = day(c, date);
            const x = d.tables.find((y) => y.id === t.id);
            play += x.playTotal;
            service += x.serviceTotal;
            revenue += x.revenue;
            capacity += d.capacity ? d.capacity / d.tables.length : 0;
          }
          return { resource_id: t.id, number: t.number, title: nameOf(t), type: typeOf(t.kind), family: t.kind === COURT ? 'court' : 'table', club_name: clubs.length > 1 ? c.name : undefined, games: Math.round(play / 92), play_minutes: play, play_hours: r1(play / 60), service_minutes: service, revenue_kopecks: revenue, utilization_pct: capacity ? r1((play / capacity) * 100) : null, cloth_hours: null };
        }),
    );
  }

  /**
   * M5.6 (№196–197, server/maintenance/README.md): прогноз — медиана загрузки ячейки «день недели × час» по закрытым
   * суткам последних 8 недель (по вчера), меньше 14 суток — insufficient_data; подсказки — пороги сервера (HINTS).
   */
  function forecastOf(club, kind) {
    const t = today();
    const samples = [];
    const days = [];
    for (let i = 1; i <= FORECAST_WEEKS * 7; i += 1) {
      const date = addDays(t, -i);
      const d = day(club, date);
      if (!d.open) continue;
      const tbl = d.tables.filter((x) => matchKind(x.kind, kind));
      const hours = [];
      for (let h = 0; h < 24; h += 1) {
        const open = OPEN_HOURS.includes(h) && tbl.length > 0;
        const play = tbl.reduce((s, x) => s + x.play[h], 0);
        const cap = open ? tbl.length * 60 : 0;
        hours.push({ play, cap, queue: d.queueOffered > 0 && h >= 20 && h < 23 });
        samples.push({ dow: d.dow, hour: h, pct: cap ? Math.min(100, (play / cap) * 100) : null });
      }
      days.push({ date, dow: d.dow, week: Math.floor((i - 1) / 7), hours });
    }
    const weeks = Math.min(FORECAST_WEEKS, Math.ceil(days.length / 7));
    const base = { label: 'прогноз', weeks: FORECAST_WEEKS, from: addDays(t, -FORECAST_WEEKS * 7), to: addDays(t, -1), history_days: days.length, history_weeks: weeks, min_days: FORECAST_MIN_DAYS, holiday_iso_day: 7, rows: [1, 2, 3, 4, 5, 6, 7], cols: Array.from({ length: 24 }, (_, i) => i) };
    if (days.length < FORECAST_MIN_DAYS) return { forecast: { ...base, status: 'insufficient_data', enough: false, pct: null, samples: null, days_pct: null }, hints: [] };
    const m = medianForecast(samples);
    return { forecast: { ...base, status: 'ok', enough: true, pct: m.pct, samples: m.samples, days_pct: [1, 2, 3, 4, 5, 6, 7].map((d) => r1(median(days.filter((x) => x.dow === d).map((x) => (x.hours.reduce((a, y) => a + y.play, 0) / Math.max(1, x.hours.reduce((a, y) => a + y.cap, 0))) * 100)))) }, hints: mockHints(days, weeks) };
  }

  /** Подсказки по порогам сервера: будни < 20 % подряд ≥ 3 ч; день недели > 85 % или очередь в половине дней — ≥ 2 ч. */
  function mockHints(days, weeks) {
    const order = Array.from({ length: 24 }, (_, i) => (6 + i) % 24);
    const load = (list, h) => {
      const play = list.reduce((a, d) => a + d.hours[h].play, 0);
      const cap = list.reduce((a, d) => a + d.hours[h].cap, 0);
      return cap ? (play / cap) * 100 : null;
    };
    const runs = (test, min) => {
      const out = [];
      let cur = [];
      for (const h of [...order, null]) {
        if (h !== null && test(h)) cur.push(h);
        else {
          if (cur.length >= min) out.push(cur);
          cur = [];
        }
      }
      return out;
    };
    const span = (list, run) => {
      const play = run.reduce((a, h) => a + list.reduce((x, d) => x + d.hours[h].play, 0), 0);
      const cap = run.reduce((a, h) => a + list.reduce((x, d) => x + d.hours[h].cap, 0), 0);
      return cap ? r1((play / cap) * 100) : null;
    };
    const hints = [];
    const weekdays = days.filter((d) => d.dow <= 5);
    for (const run of runs((h) => (load(weekdays, h) ?? 100) < 20, 3)) {
      const pct = span(weekdays, run);
      const from = run[0];
      const to = (run.at(-1) + 1) % 24;
      hints.push({ id: `lower_price:1-5:${from}-${to}`, type: 'lower_price', days: [1, 2, 3, 4, 5], from_hour: from, to_hour: to, hours: run.length, utilization_pct: pct, queue_days: null, sample_days: null, weeks, text: `В будни ${from}–${to} загрузка ${String(pct).replace('.', ',')} % за ${weeks} недель — подумайте о дневной цене` });
    }
    for (const dow of [5, 6]) {
      const list = days.filter((d) => d.dow === dow);
      const queueDays = (h) => list.filter((d) => d.hours[h].queue).length;
      for (const run of runs((h) => (load(list, h) ?? 0) > 85 || queueDays(h) >= list.length / 2, 2)) {
        const pct = span(list, run);
        const from = run[0];
        const to = (run.at(-1) + 1) % 24;
        const q = Math.min(...run.map(queueDays));
        const word = dow === 5 ? 'В пятницу' : 'В субботу';
        hints.unshift({ id: `raise_price:${dow}:${from}-${to}`, type: 'raise_price', days: [dow], from_hour: from, to_hour: to, hours: run.length, utilization_pct: pct, queue_days: q, sample_days: list.length, weeks, text: q >= list.length / 2 ? `${word} ${from}–${to} очередь в ${q} из ${list.length} дней (загрузка ${String(pct).replace('.', ',')} %) — можно поднять цену` : `${word} ${from}–${to} загрузка ${String(pct).replace('.', ',')} % за ${weeks} недель — можно поднять цену` });
      }
    }
    return hints.slice(0, 10);
  }

  /** GET …/forecast?date&kind — прогноз на сутки (форма server/maintenance/README.md). */
  function forecastDayResponse(clubId, q, user) {
    const clubs = clubsFor(clubId, user);
    if (!clubs || clubId === 'all') return { status: clubs ? 400 : 404, body: { error: clubs ? 'bad_request' : 'not_found' } };
    const date = q.get('date') || today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Math.abs(spanDays(date, today())) > 367) return { status: 400, body: { error: 'bad_request' } };
    const { forecast: f } = forecastOf(clubs[0], normKind(q.get('kind')));
    const dow = weekday(date);
    const hours = WORK_ORDER.map((h) => ({ hour: h, pct: f.pct ? f.pct[dow - 1][h] : null, samples: f.samples ? f.samples[dow - 1][h] : 0 }));
    return { status: 200, body: { club_id: clubs[0].id, kind: q.get('kind') || null, date, iso_dow: dow, basis_dow: dow, holiday: null, label: 'прогноз', status: f.status, enough: f.enough, history_days: f.history_days, history_weeks: f.history_weeks, min_days: f.min_days, window: { from: f.from, to: f.to }, day_pct: f.days_pct ? f.days_pct[dow - 1] : null, hours, generated_at: new Date(now()).toISOString() } };
  }

  /** Часы игры стола клуба разработки с даты from (включительно) по сегодня — для счётчиков обслуживания (M5.6). */
  function playMinutesSince(resourceId, from) {
    let total = 0;
    const t = today();
    const start = from && from > addDays(t, -(historyDays - 1)) ? from : addDays(t, -(historyDays - 1));
    if (empty) return 0;
    for (const date of eachDay(start, t)) {
      const x = day(CLUBS[0], date).tables.find((y) => y.id === resourceId);
      total += x?.playTotal ?? 0;
    }
    return total;
  }

  /** Ответ в форме сервера (server/dashboard/README.md, «Формы ответов»). */
  function response(clubId, q, user) {
    const clubs = clubsFor(clubId, user);
    if (!clubs) return { status: 404, body: { error: 'not_found' } };
    const from = q.get('from');
    const to = q.get('to');
    const kind = normKind(q.get('kind'));
    const tab = q.get('tab') || 'summary';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? '') || from > to || spanDays(from, to) > 366) return { status: 400, body: { error: 'bad_request' } };
    if (!['summary', 'money', 'hall', 'guests', 'control'].includes(tab)) return { status: 400, body: { error: 'bad_request' } };
    const compare = q.get('compare') !== '0';
    const all = clubId === 'all';
    const cur = totals(clubs, from, to, kind);
    const isMonth = from.endsWith('-01') && from.slice(0, 7) === to.slice(0, 7) && spanDays(from, to) > 1;
    const cp = compare ? comparePeriod(from, to, isMonth ? 'month' : null) : null;
    const prev = cp ? totals(clubs, cp.from, cp.to, kind) : null;
    const P = (fn) => (prev ? fn(prev) : undefined);
    const kinds = [...new Set(clubs.flatMap((c) => c.tables.map((t) => t.kind)))];
    const base = {
      period: { from, to, days: spanDays(from, to), timezone: all ? null : tz, day_start_local: all ? null : DAY_START, today: today(), includes_today: to >= today(), missing_days: [] },
      compare_period: cp,
      club: all ? 'all' : { id: clubs[0].id, name: clubs[0].name, mode: 'live' },
      kind,
      tab,
      tiles: [],
      series: {},
      tables: {},
      generated_at: new Date(now()).toISOString(),
    };
    const gross = (t) => t.tables + t.bar + t.other;
    const hours = (m) => r1(m / 60);
    const cashOf = (t) => sumBy(t.per, (d) => d.methods.cash);
    const T = {
      revenue: () => tile('revenue', 'kopecks', cur.revenue, P((t) => t.revenue), kind ? {} : { parts: [{ id: 'tables', value: cur.tables + cur.deposits, pct: pctOf(cur.tables + cur.deposits, gross(cur)) }, { id: 'bar', value: cur.bar, pct: pctOf(cur.bar, gross(cur)) }, { id: 'other', value: cur.packages + cur.tournaments, pct: pctOf(cur.packages + cur.tournaments, gross(cur)) }] }),
      revenue_total: () => tile('revenue_total', 'kopecks', gross(cur), P(gross)),
      refunds: () => tile('refunds', 'kopecks', cur.refunds, P((t) => t.refunds)),
      cash_net: () => tile('cash_net', 'kopecks', cashOf(cur), P(cashOf)),
      cashless_net: () => tile('cashless_net', 'kopecks', gross(cur) - cashOf(cur) - cur.refunds, P((t) => gross(t) - cashOf(t) - t.refunds)),
      games: () => tile('games', 'count', cur.games, P((t) => t.games)),
      play_hours: () => tile('play_hours', 'hours', hours(cur.play), P((t) => hours(t.play))),
      utilization: () => tile('utilization', 'percent', r1(cur.load), P((t) => r1(t.load))),
      capacity_hours: () => tile('capacity_hours', 'hours', hours(cur.capacity), P((t) => hours(t.capacity))),
      service_hours: () => tile('service_hours', 'hours', hours(cur.service), P((t) => hours(t.service))),
      unrealized_hours: () => tile('unrealized_hours', 'hours', hours(Math.max(0, cur.capacity - cur.play - cur.service)), P((t) => hours(Math.max(0, t.capacity - t.play - t.service)))),
      avg_check_game: () => tile('avg_check_game', 'kopecks', cur.avgGame, P((t) => t.avgGame)),
      avg_check_bar: () => tile('avg_check_bar', 'kopecks', cur.avgBar, P((t) => t.avgBar)),
      revenue_per_table_day: () => tile('revenue_per_table_day', 'kopecks', cur.perTableDay, P((t) => t.perTableDay)),
      avg_hour_price: () => tile('avg_hour_price', 'kopecks', cur.hourPrice, P((t) => t.hourPrice)),
      guests: () => tile('guests', 'count', cur.guests, P((t) => t.guests), { parts: [{ id: 'new', value: cur.guestsNew, pct: pctOf(cur.guestsNew, cur.guests) }, { id: 'repeat', value: cur.guestsRet, pct: pctOf(cur.guestsRet, cur.guests) }] }),
      guests_new: () => tile('guests_new', 'count', cur.guestsNew, P((t) => t.guestsNew)),
      guests_repeat: () => tile('guests_repeat', 'count', cur.guestsRet, P((t) => t.guestsRet)),
      guests_lost: () => tile('guests_lost', 'count', empty ? 0 : 9 + Math.round(spanDays(from, to) / 30), prev ? 9 : undefined),
      bookings: () => tile('bookings', 'count', sumBy(cur.per, (d) => d.bookings), P((t) => sumBy(t.per, (d) => d.bookings))),
      no_show: () => tile('no_show', 'count', sumBy(cur.per, (d) => d.noShow), P((t) => sumBy(t.per, (d) => d.noShow))),
      extensions_from_app_share: () => tile('extensions_from_app_share', 'percent', cur.extTotal ? pctOf(cur.extApp, cur.extTotal) : null, P((t) => (t.extTotal ? pctOf(t.extApp, t.extTotal) : null))),
      no_staff_share: () => tile('no_staff_share', 'percent', r1(cur.noStaffShare), P((t) => r1(t.noStaffShare))),
      expenses: () => tile('expenses', 'kopecks', cur.expense ?? 0, P((t) => t.expense ?? 0)),
      profit: () => tile('profit', 'kopecks', cur.revenue - (cur.expense ?? 0), P((t) => t.revenue - (t.expense ?? 0))),
      manual_actions: () => tile('manual_actions', 'count', cur.manual.length, P((t) => t.manual.length)),
      automatic_actions: () => tile('automatic_actions', 'count', empty ? 0 : cur.refundCount, P((t) => t.refundCount)),
      cash_discrepancy: () => tile('cash_discrepancy', 'kopecks', -cur.discrepancy, P((t) => -t.discrepancy)),
      alarms: () => tile('alarms', 'count', cur.alarms.length, P((t) => t.alarms.length)),
      alarms_problem: () => tile('alarms_problem', 'count', cur.alarms.filter(isProblem).length, P((t) => t.alarms.filter(isProblem).length)),
      lights_without_journal: () => tile('lights_without_journal', 'count', 0, prev ? 0 : undefined),
      scan_to_light_median_sec: () => tile('scan_to_light_median_sec', 'seconds', cur.scanMedian, P((t) => t.scanMedian)),
    };
    const want = {
      summary: ['revenue', 'games', 'play_hours', 'utilization', 'avg_check_game', 'avg_check_bar', 'revenue_per_table_day', 'avg_hour_price', 'guests', 'no_staff_share', 'expenses', 'profit'],
      money: ['revenue', 'revenue_total', 'refunds', 'cash_net', 'cashless_net', 'avg_check_game', 'avg_check_bar', 'expenses', 'profit'],
      hall: ['utilization', 'play_hours', 'capacity_hours', 'service_hours', 'unrealized_hours', 'games'],
      guests: ['guests', 'guests_new', 'guests_repeat', 'guests_lost', 'bookings', 'no_show', 'extensions_from_app_share'],
      control: ['manual_actions', 'automatic_actions', 'cash_discrepancy', 'alarms', 'alarms_problem', 'lights_without_journal', 'scan_to_light_median_sec', 'no_staff_share'],
    }[tab];
    base.tiles = want.map((id) => T[id]());
    const daily = (row) => ({ date: row.date, total_kopecks: row.tables + row.bar + row.other, net_kopecks: row.revenue, tables_kopecks: row.tables + row.deposits, bar_kopecks: row.bar, other_kopecks: row.other - row.deposits, today: row.date === today() });
    if (all && tab === 'summary') {
      base.tables.clubs = clubs.map((c) => {
        const t = totals([c], from, to, kind);
        return { club_id: c.id, name: c.name, revenue_kopecks: t.revenue, games: t.games, play_hours: hours(t.play), utilization_pct: r1(t.load), guests: t.guests };
      });
    }
    if (tab === 'summary') base.series.revenue_daily = cur.per.map(({ row }) => daily(row));
    if (tab === 'money') {
      const sumD = (fn) => cur.per.reduce((acc, p) => acc + p.ds.reduce((x, d) => x + fn(d, p.row.share ?? 1), 0), 0);
      const g = gross(cur);
      base.tables.structure = [
        ['tables', cur.tables],
        ['deposits', cur.deposits],
        ['bar', cur.bar],
        ['packages', cur.packages],
        ['tournaments', cur.tournaments],
        ['other', 0],
      ].map(([id, v]) => ({ id, kopecks: v, pct: pctOf(v, g) }));
      base.tables.methods = ['cash', 'card_terminal', 'sbp', 'card'].map((m) => {
        const v = Math.round(sumD((d, sh) => d.methods[m] * (kind ? sh : 1)));
        return { id: m, kopecks: v, refunds_kopecks: m === 'sbp' ? cur.refunds : 0, pct: pctOf(v, g) };
      });
      base.tables.sources = [
        ['qr', 'qr'],
        ['reception', 'reception'],
        ['booking', 'online_booking'],
        ['tournament', 'tournament'],
      ].map(([id, k]) => {
        const v = Math.round(sumD((d, sh) => d.sources[k] * (kind ? sh : 1)));
        return { id, kopecks: v, pct: pctOf(v, g) };
      });
      base.tables.refunds = { count: cur.refundCount, total_kopecks: cur.refunds, by_method: { cash: 0, card_terminal: 0, sbp: cur.refunds, card: 0 }, tables_kopecks: cur.refunds, bar_kopecks: 0 };
      const cashIn = Math.round(sumD((d) => d.methods.cash));
      base.tables.cash = { start_kopecks: all || empty ? null : 300000, cash_sales_kopecks: cashIn, cash_refunds_kopecks: 0, collections_kopecks: Math.round((cashIn * 0.9) / 100) * 100, discrepancy_kopecks: -cur.discrepancy, shifts: shiftRef && cur.discrepancy ? [serverShift(shiftRef)] : [] };
      base.tables.daily = cur.per.map(({ row }) => ({ ...daily(row), refunds_kopecks: row.refunds, games: row.games, play_minutes: row.play, capacity_minutes: row.capacity, avg_check_game_kopecks: row.games ? Math.round(row.tables / row.games) : null, avg_check_bar_kopecks: row.barOrders ? Math.round(row.bar / row.barOrders) : null, utilization_pct: row.capacity ? r1((row.play / row.capacity) * 100) : null }));
      const from30 = addDays(to, -29);
      base.series.revenue_30d = totals(clubs, from30, to, kind).per.map(({ row }) => ({ date: row.date, total_kopecks: row.tables + row.bar + row.other, net_kopecks: row.revenue, today: row.date === today() }));
    }
    if (tab === 'hall') {
      const cells = cellsOf(cur, kind);
      const rows = [1, 2, 3, 4, 5, 6, 7];
      const cols = Array.from({ length: 24 }, (_, i) => i);
      const at = (d, h) => cells.get(d * 100 + h) ?? { play: 0, cap: 0 };
      base.series.heatmap = {
        rows,
        cols,
        pct: rows.map((d) => cols.map((h) => (at(d, h).cap ? Math.min(100, r1((at(d, h).play / at(d, h).cap) * 100)) : null))),
        play_minutes: rows.map((d) => cols.map((h) => at(d, h).play)),
        capacity_minutes: rows.map((d) => cols.map((h) => at(d, h).cap)),
      };
      // M5.6: прогноз (у «всех клубов» — null) и подсказки по цене (у «всех клубов» — с club_id и club_name)
      if (all) {
        base.series.forecast = null;
        base.hints = clubs.flatMap((c) => forecastOf(c, kind).hints.map((h) => ({ ...h, club_id: c.id, club_name: c.name })));
      } else {
        const fc = forecastOf(clubs[0], kind);
        base.series.forecast = fc.forecast;
        base.hints = fc.hints;
      }
      base.series.ring = { capacity_minutes: cur.capacity, played_minutes: cur.play, service_minutes: cur.service, unrealized_minutes: Math.max(0, cur.capacity - cur.play - cur.service) };
      const kk = kinds.filter((k) => matchKind(k, kind));
      base.series.utilization_daily = cur.per.map(({ row }) => ({ date: row.date, pct: row.capacity ? r1((row.play / row.capacity) * 100) : null, by_type: Object.fromEntries(kk.map((k) => [typeOf(k), row.byKind[k]?.capacity ? r1((row.byKind[k].play / row.byKind[k].capacity) * 100) : null])) }));
      const res = resourcesOf(clubs, from, to, kind);
      base.tables.by_type = kk.map((k) => {
        const list = res.filter((r) => r.type === typeOf(k));
        const play = list.reduce((a, r) => a + r.play_minutes, 0);
        const cap = cur.per.reduce((a, p) => a + (p.row.byKind[k]?.capacity ?? 0), 0);
        return { type: typeOf(k), tables: list.length, games: list.reduce((a, r) => a + r.games, 0), play_minutes: play, capacity_minutes: cap, service_minutes: list.reduce((a, r) => a + r.service_minutes, 0), utilization_pct: cap ? r1((play / cap) * 100) : null, revenue_kopecks: list.reduce((a, r) => a + r.revenue_kopecks, 0) };
      });
      base.tables.by_resource = res;
    }
    if (tab === 'guests') {
      const sh = kind ? cur.tables / Math.max(1, sumBy(cur.per, (d) => d.tablesRevenue)) : 1;
      const S = (fn) => Math.round(sumBy(cur.per, fn) * sh);
      const leads = cur.per.flatMap((p) => p.ds.map((d) => d.leadMinutes)).filter((x) => x !== null);
      const bt = S((d) => d.bookings);
      const came = S((d) => d.arrived);
      const ext = S((d) => d.extensions);
      const extApp = S((d) => d.extensionsApp);
      base.tables.guests = { total: cur.guests, new: cur.guestsNew, repeat: cur.guestsRet, lost: empty ? 0 : 9 + Math.round(spanDays(from, to) / 30), new_pct: pctOf(cur.guestsNew, cur.guests), repeat_pct: pctOf(cur.guestsRet, cur.guests) };
      base.tables.bookings = { total: bt, came, no_show: S((d) => d.noShow), canceled: S((d) => d.canceled), upcoming: 0, came_pct: pctOf(came, bt), lead_minutes_avg: leads.length ? Math.round(leads.reduce((a, b) => a + b, 0) / leads.length) : null };
      base.tables.waitlist = { offered: S((d) => d.queueOffered), accepted: S((d) => d.queueTaken) };
      base.tables.extensions = { paid: extApp, from_app: extApp, free: Math.max(0, ext - extApp), total: ext, from_app_pct: pctOf(extApp, ext) };
      base.tables.packages = { sold: kind ? 0 : sumBy(cur.per, (d) => d.packagesSold), sold_minutes: kind ? 0 : sumBy(cur.per, (d) => d.packagesSold) * 600, used_minutes: S((d) => d.packagesUsed) };
      base.tables.tournaments = { fees_kopecks: kind ? 0 : cur.tournaments, participants: kind ? 0 : sumBy(cur.per, (d) => d.tParticipants) };
      base.tables.plus = { matches_counted: S((d) => d.plusGames) };
      base.series.guests_daily = cur.per.map((p) => {
        const n = Math.round(p.ds.reduce((x, d) => x + d.guestsNew, 0) * sh);
        return { date: p.row.date, new: n, active: n + Math.round(p.ds.reduce((x, d) => x + d.guestsReturning, 0) * sh) };
      });
      base.series.bookings_daily = cur.per.map((p) => ({ date: p.row.date, total: p.ds.reduce((x, d) => x + d.bookings, 0), came: p.ds.reduce((x, d) => x + d.arrived, 0), no_show: p.ds.reduce((x, d) => x + d.noShow, 0), canceled: p.ds.reduce((x, d) => x + d.canceled, 0) }));
    }
    if (tab === 'control') {
      const items = cur.manual.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      base.tables.manual_items = items.map((m) => ({ at: m.at, action: m.action, kind: 'staff', actor_id: m.staff_id, actor_name: m.staff_name, reason: m.reason, resource_number: m.resource_number, amount_kopecks: m.amount_kopecks ?? null, ...(all ? { club_name: m.club_name } : {}) }));
      const byAction = new Map();
      const byStaff = new Map();
      for (const m of items) {
        byAction.set(m.action, (byAction.get(m.action) ?? 0) + 1);
        const e = byStaff.get(m.staff_id) ?? { user_id: m.staff_id, name: m.staff_name, count: 0, by_action: {} };
        e.count += 1;
        e.by_action[m.action] = (e.by_action[m.action] ?? 0) + 1;
        byStaff.set(m.staff_id, e);
      }
      base.tables.manual_by_action = [...byAction].map(([action, count]) => ({ action, count })).sort((a, b) => b.count - a.count);
      base.tables.manual_by_staff = [...byStaff.values()].sort((a, b) => b.count - a.count);
      base.tables.automatic = { count: empty ? 0 : cur.refundCount, by_action: cur.refundCount ? { 'payment.refunded': cur.refundCount } : {} };
      base.tables.shifts = shiftRef && cur.discrepancy ? [serverShift(shiftRef)] : [];
      base.tables.alarms = alarmsSummary(cur.alarms);
      base.tables.pilot = { lights_without_journal: { commands: 0, sessions: 0 }, scan_to_light: { median_sec: cur.scanMedian, count: Math.round(cur.games * 0.6), under_20_pct: cur.scanMedian === null ? null : 96.5 }, no_staff_share_pct: r1(cur.noStaffShare), extensions_from_app_pct: cur.extTotal ? pctOf(cur.extApp, cur.extTotal) : null, cash_discrepancy_kopecks: -cur.discrepancy };
    }
    return { status: 200, body: base };
  }

  const isProblem = (a) => !a.acked_at || Date.parse(a.acked_at) - Date.parse(a.raised_at) > 10 * MIN;

  /** Тревоги в форме сервера: сводки по видам и принявшим, проблемные списком. */
  function alarmsSummary(list) {
    const sec = (a) => (a.acked_at ? Math.round((Date.parse(a.acked_at) - Date.parse(a.raised_at)) / 1000) : null);
    const group = (keyOf, extra) => {
      const m = new Map();
      for (const a of list) {
        const k = keyOf(a);
        if (k === null) continue;
        const e = m.get(k) ?? { ...extra(a), count: 0, acked: 0, unacked: 0, slow: 0, secs: [] };
        e.count += 1;
        if (a.acked_at) {
          e.acked += 1;
          e.secs.push(sec(a));
          if (sec(a) > 600) e.slow += 1;
        } else e.unacked += 1;
        m.set(k, e);
      }
      return [...m.values()].map(({ secs, ...e }) => ({ ...e, avg_react_sec: secs.length ? Math.round(secs.reduce((x, y) => x + y, 0) / secs.length) : null, problem: e.slow + e.unacked > 0 }));
    };
    const byType = group((a) => a.type, (a) => ({ type: a.type }));
    const byStaff = group((a) => a.acked_by_name ?? null, (a) => ({ user_id: null, name: a.acked_by_name })).map(({ unacked: _u, acked: _a, ...e }) => e);
    const levels = { critical: 0, important: 0, info: 0 };
    for (const a of list) levels[a.level] = (levels[a.level] ?? 0) + 1;
    return {
      total: list.length,
      by_level: levels,
      slow_after_sec: 600,
      by_type: byType,
      by_staff: byStaff,
      problems: list.filter(isProblem).map((a) => ({ alarm_id: a.id, type: a.type, level: a.level, resource_number: a.resource_number, raised_at: a.raised_at, acked_at: a.acked_at, acked_by: null, acked_by_name: a.acked_by_name, react_sec: sec(a) })),
    };
  }

  const serverShift = (s) => ({ shift_id: s.shift_id, number: s.number, opened_at: s.opened_at, closed_at: s.closed_at, opened_by_name: s.staff_name, closed_by_name: s.staff_name, float_kopecks: 300000, expected_cash_kopecks: s.expected_kopecks, actual_cash_kopecks: s.actual_kopecks, discrepancy_kopecks: s.discrepancy_kopecks, close_comment: s.comment, status: 'discrepancy' });

  let shiftRef = null;

  /** Смена с расхождением 100 ₽ — её создаёт backend.js в данных M2, чтобы ссылка вела в настоящий отчёт заглушки. */
  function setDiscrepancyShift(s) {
    shiftRef = s
      ? { shift_id: s.id, number: s.number, opened_at: s.opened_at, closed_at: s.closed_at, staff_name: s.closed_by_name ?? s.opened_by_name, expected_kopecks: s.expected_cash_kopecks, actual_kopecks: s.actual_cash_kopecks, discrepancy_kopecks: s.discrepancy_kopecks, comment: s.close_comment }
      : null;
  }

  /** «Сейчас» в форме сервера: { totals, by_type, revenue_today, games_today, shift, tables }; у all — { clubs, totals }. */
  function nowResponse(clubId, hall, user) {
    const clubs = clubsFor(clubId, user);
    if (!clubs) return { status: 404, body: { error: 'not_found' } };
    const td = today();
    const one = (c) => {
      const items = c.seed === 'dev' ? (empty ? hall.map((it) => ({ ...it, status: 'free', session: null, until: null, hold: null })) : hall) : syntheticHall(c);
      const statusOf = (it) => (it.status === 'busy' || it.session ? 'busy' : it.status === 'pending' || it.status === 'reserved' ? 'reserved' : it.status === 'service' ? 'service' : it.status === 'offline' ? 'offline' : 'free');
      const by = new Map();
      for (const it of items) {
        const type = it.resource.type;
        const e = by.get(type) ?? { type, total: 0, busy: 0, reserved: 0, service: 0, free: 0, offline: 0, fault: 0 };
        e.total += 1;
        e[statusOf(it)] += 1;
        by.set(type, e);
      }
      const d = day(c, td);
      const list = [...by.values()].map((e) => ({ ...e, utilization_now_pct: pctOf(e.busy, e.total), utilization_day_pct: d.capacity ? pctOf(d.tables.filter((t) => typeOf(t.kind) === e.type).reduce((a, t) => a + t.playTotal, 0), (d.capacity / d.tables.length) * e.total) : 0 }));
      const total = items.length;
      const busy = list.reduce((a, e) => a + e.busy, 0);
      return {
        at: new Date(now()).toISOString(),
        club_id: c.id,
        name: c.name,
        day: td,
        totals: { total, busy, reserved: list.reduce((a, e) => a + e.reserved, 0), service: list.reduce((a, e) => a + e.service, 0), free: list.reduce((a, e) => a + e.free, 0), offline: list.reduce((a, e) => a + e.offline, 0), fault: 0, utilization_now_pct: pctOf(busy, total), utilization_day_pct: d.capacity ? pctOf(d.playTotal, d.capacity) : 0 },
        by_type: list,
        revenue_today: { total_kopecks: d.revenue + d.refunds, net_kopecks: d.revenue, by_method: d.methods },
        games_today: d.games,
        shift: empty ? null : { shift_id: null, number: 214, opened_at: new Date(Date.parse(`${td}T12:00:00+05:00`)).toISOString(), opened_by_name: c.seed === 'dev' ? STAFF.reception.name : 'Мария Л.' },
        tables: items.map((it) => ({ resource_id: it.resource.id, number: it.resource.number, title: resourceName(it.resource), type: it.resource.type, family: it.resource.family ?? (it.resource.type === COURT ? 'court' : 'table'), plan_x: it.resource.plan_x ?? null, plan_y: it.resource.plan_y ?? null, plan_rotation: it.resource.plan_rotation ?? 0, status: statusOf(it), busy_until: it.session?.paid_until ?? null, until: it.until ?? null })),
      };
    };
    if (clubs.length === 1) return { status: 200, body: one(clubs[0]) };
    const list = clubs.map(one);
    const sum = (k) => list.reduce((a, c) => a + c.totals[k], 0);
    return { status: 200, body: { at: new Date(now()).toISOString(), clubs: list, totals: { total: sum('total'), busy: sum('busy'), reserved: sum('reserved'), service: sum('service'), free: sum('free'), offline: sum('offline'), fault: 0, utilization_now_pct: pctOf(sum('busy'), sum('total')), utilization_day_pct: null } } };
  }

  function syntheticHall(club) {
    const r = rng(`${club.seed}:hall`);
    return club.tables.map((t, i) => ({
      resource: { id: t.id, number: t.number, type: typeOf(t.kind), family: t.kind === COURT ? 'court' : 'table', title: KIND_LABEL[t.kind] },
      status: empty ? 'free' : r() < 0.45 ? 'busy' : i === 2 ? 'service' : 'free',
      session: null,
      until: null,
      device: { online: true },
    }));
  }

  function exportCsv(clubId, q, user) {
    if (user?.role !== 'owner') return { status: 403, body: { error: 'forbidden' } };
    const table = q.get('table');
    const from = q.get('from');
    const to = q.get('to');
    const kind = normKind(q.get('kind'));
    const clubs = clubsFor(clubId, user);
    if (!clubs) return { status: 404, body: { error: 'not_found' } };
    if (!from || !to || from > to || spanDays(from, to) > 366) return { status: 400, body: { error: 'bad_request' } };
    const cur = totals(clubs, from, to, kind);
    let csv;
    if (table === 'revenue_daily') {
      csv = toCsv(['Дата', 'Выручка, ₽', 'Столы, ₽', 'Бар, ₽', 'Прочее, ₽', 'Возвраты, ₽', 'Игр', 'Средний чек игры, ₽', 'Средний чек бара, ₽'], cur.per.map(({ row }) => [csvDate(row.date), csvMoney(row.revenue), csvMoney(row.tables), csvMoney(row.bar), csvMoney(row.other), csvMoney(row.refunds), row.games, row.games ? csvMoney(Math.round(row.tables / row.games)) : '', row.barOrders ? csvMoney(Math.round(row.bar / row.barOrders)) : '']));
    } else if (table === 'tables') {
      const res = resourcesOf(clubs, from, to, kind);
      csv = toCsv(['Стол', 'Тип', 'Часов игры', 'Выручка, ₽', 'Загрузка, %', 'Часов с замены сукна'], res.map((t) => [t.title, KIND_LABEL[t.type.replace('billiard_', '')] ?? 'Падел-корт', t.play_hours, csvMoney(t.revenue_kopecks), t.utilization_pct, '']));
    } else if (table === 'hourly') {
      const cells = [...cellsOf(cur, kind).values()];
      const DOW = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
      csv = toCsv(['День недели', 'Час', 'Минут игры', 'Минут ёмкости', 'Загрузка, %'], cells.sort((a, b) => a.dow - b.dow || a.hour - b.hour).map((c) => [DOW[c.dow], `${String(c.hour).padStart(2, '0')}:00`, c.play, c.cap, c.cap ? Math.round((c.play / c.cap) * 1000) / 10 : '']));
    } else if (table === 'manual') {
      csv = toCsv(['Дата и время', 'Действие', 'Сотрудник', 'Стол', 'Причина'], cur.manual.map((m) => [csvDate(m.at, tz, true), ACTION_LABEL[m.action] ?? m.action, m.staff_name, m.resource_number ? `Стол ${m.resource_number}` : '', m.reason]));
    } else if (table === 'shifts') {
      const s = shiftRef && cur.discrepancy ? [shiftRef] : [];
      csv = toCsv(['Смена', 'Открыта', 'Закрыта', 'Сотрудник', 'Должно быть, ₽', 'Факт, ₽', 'Расхождение, ₽'], s.map((x) => [x.number, csvDate(x.opened_at, tz, true), csvDate(x.closed_at, tz, true), x.staff_name, csvMoney(x.expected_kopecks), csvMoney(x.actual_kopecks), csvMoney(x.discrepancy_kopecks)]));
    } else if (table === 'bookings') {
      csv = toCsv(['Дата', 'Броней', 'Пришли', 'Не пришли', 'Отменены', 'Новых гостей', 'Повторных гостей'], cur.per.map((p) => [csvDate(p.row.date), ...['bookings', 'arrived', 'noShow', 'canceled', 'guestsNew', 'guestsReturning'].map((k) => p.ds.reduce((x, d) => x + d[k], 0))]));
    } else return { status: 400, body: { error: 'bad_request' } };
    return { status: 200, csv, name: `dashboard-${table}-${from}-${to}.csv` };
  }

  /** Для отчётов M5.2 (истории, касса управляющего): день клуба разработки. */
  return { response, nowResponse, exportCsv, forecastDayResponse, playMinutesSince, setDiscrepancyShift, day: (date) => day(CLUBS[0], date), today, tz, empty, historyDays };
}

export const DASHBOARD_CLUBS = CLUBS;
