/*
 * BL_MOCK_MARKER — заглушка API гостя по контракту M1 (§4–§7) только для разработки (VITE_MOCK=1).
 * В обычную сборку не попадает: scripts/size.mjs проверяет, что этой метки нет в dist.
 *
 * Состояние живёт в sessionStorage вкладки, поэтому переход на «страницу ЮKassa» и обратно его не теряет.
 * Сценарии для проверки глазами: ?mock=user | fresh | anon | game | warn | grace | unlimited | interrupted | closed | notpayer | decline;
 * M2 (mock/bar.js): barorders (игра, заказы бара и счёт стола) | closedtab (игра закончилась, счёт не оплачен);
 * M3 (mock/m3.js): book | mybooking | early | waitlist | balance; limit — продление ограничено бронью в 21:00 (№106)
 * M5.1: testclub — клуб в тестовом режиме (плашка на столе, оплате и игре), testgame — то же с идущей игрой
 * M5.8 (падел-корт, слоты по 90 минут): court — корт 1 свободен (/app/t/TESTC00001), корт 2 занят;
 *   courtgame — идёт игра на корте 1 (продление слотом); courtfull — на корте 2 уже 4 игрока (пятый «Я играю» — limit_exceeded);
 *   courtbook — бронь в клубе со столами и кортами
 */

import { barRoutes, barSeed } from './bar.js';
import { m3Routes } from './m3.js';
import { m4Routes } from './m4.js';

const CLUB = { id: '0b6b8c1e-5a7d-4f0e-9c3a-2d1e4f5a6b7c', name: 'Клуб для разработки', timezone: 'Asia/Yekaterinburg' };
const SESSION_ID = '6f1c2a9e-0d4b-4c7e-9a51-3b2f8e7d4c10';
const MIN = 60_000;

// Коды столов — Crockford Base32, 10 символов (решение №47); номера и типы — как в сиде (5 пирамид, 3 пула)
const TABLES = [
  { code: '4K7P9QW2XM', number: 4, type: 'billiard_pyramid', title: 'Пирамида 12 футов', status: 'free' },
  { code: '7H3D2RT9QF', number: 7, type: 'billiard_pool', title: 'Пул 9 футов', status: 'busy', busyMin: 47 },
  { code: '2M8X4KZ6CB', number: 2, type: 'billiard_pyramid', title: 'Пирамида 12 футов', status: 'pending' },
  { code: '5S9N3VJ7AE', number: 5, type: 'billiard_pyramid', title: 'Пирамида 12 футов', status: 'service', busyMin: 25 },
  { code: '8F6T1YH4RD', number: 8, type: 'billiard_pool', title: 'Пул 9 футов', status: 'offline' },
  { code: '3B5R8WA2NP', number: 3, type: 'billiard_pyramid', title: 'Пирамида 12 футов', status: 'reserved' },
  { code: '6C2J7MD5KT', number: 6, type: 'billiard_pool', title: 'Пул 9 футов', status: 'free' },
];

const resourceId = (n) => `00000000-0000-4000-8000-00000000000${n}`;
/** id ресурса заглушки: у корта свой (номера кортов — своя нумерация, M5.8), у стола — по номеру. */
const ridOf = (t) => t.id ?? resourceId(t.number);

// M5.8: падел-корты — как в сиде 1300_padel.sql (коды TESTC00001, TESTC00002, слот 90 минут)
const COURTS = [
  { code: 'TESTC00001', id: 'e1000000-0000-4000-8000-000000000101', number: 1, type: 'padel_court', title: 'Корт 1', status: 'free' },
  { code: 'TESTC00002', id: 'e1000000-0000-4000-8000-000000000102', number: 2, type: 'padel_court', title: 'Корт 2', status: 'busy', busyMin: 52 },
];
const SLOT = 90;
const isCourtT = (t) => t?.type === 'padel_court';
// Цена слота (как сид): будни 06–17 — 2 400 ₽, 17–06 — 3 600 ₽ (заглушка не различает выходные)
const SLOT_BANDS = [
  [0, 6, 360000],
  [6, 17, 240000],
  [17, 24, 360000],
];

// Тарифы для разработки (PRODUCT §9, будни): 06–12 и 12–17 — 500 ₽/ч, 17–24 — 800 ₽/ч, 00–06 — 900 ₽/ч
const BANDS = [
  [0, 6, 90000],
  [6, 17, 50000],
  [17, 24, 80000],
];

function localParts(ms) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: CLUB.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const [h, m] = f.format(ms).split(':').map(Number);
  return { h, m };
}

function bandAt(ms) {
  const { h } = localParts(ms);
  return BANDS.find(([from, to]) => h >= from && h < to);
}

const pad = (n) => String(n).padStart(2, '0');

/** Вид ресурса в ответах (как server/lib/resource-kinds.mjs kindJson). */
function kindFields(t, { withSlot = true } = {}) {
  if (isCourtT(t)) return { kind: 'padel_court', family: 'court', max_players: 4, ...(withSlot ? { billing: 'slot', slot_minutes: SLOT } : {}) };
  return { kind: t.type.replace('billiard_', ''), family: 'table', max_players: 20, ...(withSlot ? { billing: 'hourly', slot_minutes: null } : {}) };
}

function slotBandAt(ms) {
  const { h } = localParts(ms);
  return SLOT_BANDS.find(([from, to]) => h >= from && h < to);
}

function courtPricesAround(ms) {
  const [, to, price] = slotBandAt(ms);
  const next = SLOT_BANDS.find(([from]) => from === to % 24) ?? SLOT_BANDS[0];
  const ref = (k) => Math.round((k * 60) / SLOT);
  return {
    price_now: { price_per_hour_kopecks: ref(price), price_per_slot_kopecks: price, slot_minutes: SLOT, until_local: `${pad(to % 24)}:00` },
    price_next: next[2] === price ? null : { price_per_hour_kopecks: ref(next[2]), price_per_slot_kopecks: next[2], slot_minutes: SLOT, from_local: `${pad(to % 24)}:00` },
  };
}

/** Корт: минута стоит цену слота / 90, точно в целых, один раз до рублей «половина вверх» (как сервер). */
function courtAmountFor(from, minutes) {
  const parts = [];
  let num = 0;
  for (let i = 0; i < minutes; i += 1) {
    const t = from + i * MIN;
    const price = slotBandAt(t)[2];
    const last = parts[parts.length - 1];
    if (last && last.price === price) {
      last.to = t + MIN;
      last.num += price;
    } else parts.push({ from: t, to: t + MIN, price, num: price });
    num += price;
  }
  const round = (n) => Math.floor((n * 2 + SLOT * 100) / (2 * SLOT * 100)) * 100;
  let cum = 0;
  let prev = 0;
  return {
    amount_kopecks: round(num),
    breakdown: parts.map((b) => {
      cum += b.num;
      const r = round(cum);
      const amount = r - prev;
      prev = r;
      return {
        from: new Date(b.from).toISOString(),
        to: new Date(b.to).toISOString(),
        price_per_hour_kopecks: Math.round((b.price * 60) / SLOT),
        price_per_slot_kopecks: b.price,
        slot_minutes: SLOT,
        amount_kopecks: amount,
      };
    }),
  };
}

function pricesAround(ms) {
  const [, to, price] = bandAt(ms);
  const next = BANDS.find(([from]) => from === to % 24) ?? BANDS[0];
  return {
    price_now: { price_per_hour_kopecks: price, until_local: `${pad(to % 24)}:00` },
    price_next: next[2] === price ? null : { price_per_hour_kopecks: next[2], from_local: `${pad(to % 24)}:00` },
  };
}

/** Поминутно по тарифу, округление один раз до рублей «половина вверх» (решение №44). Корт — по цене слота. */
function amountFor(from, minutes, table) {
  if (isCourtT(table)) return courtAmountFor(from, minutes);
  const breakdown = [];
  let exact = 0;
  for (let i = 0; i < minutes; i += 1) {
    const t = from + i * MIN;
    const price = bandAt(t)[2];
    const last = breakdown[breakdown.length - 1];
    if (last && last.price_per_hour_kopecks === price) {
      last.to = t + MIN;
      last.exact += price / 60;
    } else {
      breakdown.push({ from: t, to: t + MIN, price_per_hour_kopecks: price, exact: price / 60 });
    }
    exact += price / 60;
  }
  const round = (k) => Math.floor(k / 100 + 0.5) * 100;
  return {
    amount_kopecks: round(exact),
    breakdown: breakdown.map((b) => ({
      from: new Date(b.from).toISOString(),
      to: new Date(b.to).toISOString(),
      price_per_hour_kopecks: b.price_per_hour_kopecks,
      amount_kopecks: round(b.exact),
    })),
  };
}

const uuid = () => globalThis.crypto.randomUUID();

function freshState() {
  return {
    user: null,
    bearer: null,
    tables: Object.fromEntries(TABLES.map((t) => [t.code, { ...t, busy_until: t.busyMin ? Date.now() + t.busyMin * MIN : null }])),
    quotes: {},
    payments: {},
    requests: {},
    sessions: {},
    links: {},
    scenario: null,
    bar: { orders: {}, next: 42 },
  };
}

const USER = { id: 'a1b2c3d4-0000-4000-8000-000000000001', nick: 'Игрок 1', phone_masked: '+7 *** ***-12-34' };

/**
 * @param {{ load: () => object | null, save: (s: object) => void, now?: () => number }} storage
 */
export function createBackend(storage) {
  const now = storage.now ?? (() => Date.now());
  let state = storage.load() ?? freshState();
  const listeners = new Map(); // sessionId → Set(fn)

  const save = () => storage.save(state);
  // M5.1: клуб в тестовом режиме (?mock=testclub, testgame) — гость видит плашку «деньги не списываются»
  const clubView = () => ({ ...CLUB, mode: state.testMode ? 'test' : 'live' });
  const tableBy = (pred) => Object.values(state.tables).find(pred);

  function sessionView(s) {
    const t = now();
    let status = s.status;
    if (['active', 'ending', 'grace'].includes(status) && !s.unlimited) {
      if (t >= s.paid_until + 2 * MIN) {
        status = 'closed';
        s.status = 'closed';
        s.ended_at = s.paid_until + 2 * MIN;
        const table = tableBy((x) => x.session_id === s.id);
        if (table) Object.assign(table, { status: 'free', busy_until: null, session_id: null });
      } else if (t >= s.paid_until) status = 'grace';
      else if (s.paid_until - t <= 5 * MIN) status = 'ending';
      else status = 'active';
    }
    const table = state.tables[s.code];
    return {
      id: s.id,
      // Как server/sessions/view.mjs: kind, family, max_players; длины слота в сессии нет (её берут из флоу или доступности)
      resource: { id: ridOf(table), number: table.number, type: table.type, title: table.title, ...kindFields(table, { withSlot: false }) },
      club: clubView(),
      status,
      started_at: new Date(s.started_at).toISOString(),
      paid_until: new Date(s.paid_until).toISOString(),
      grace_until: status === 'grace' ? new Date(s.paid_until + 2 * MIN).toISOString() : null,
      remaining_ms: status === 'interrupted' ? s.unplayed_ms : Math.max(0, s.paid_until - t),
      unlimited: Boolean(s.unlimited),
      is_payer: s.is_payer !== false,
      // M4: user_id участника — для выбора соперника в «Партии» (Бильярдум+)
      participants: s.participants.map((p, i) => ({ user_id: p.user_id ?? m4.userIdOf(p.nick), ...p, nick: m4.plusNick(p.nick) ?? null, label: `Игрок ${i + 1}` })),
      extend_limit_until: s.extend_limit_until ? new Date(s.extend_limit_until).toISOString() : null,
      // M3 (№106): начало брони после этой игры — «Стол забронирован на 21:00, можно продлить до 20:55»
      next_booking_at: s.next_booking_at ? new Date(s.next_booking_at).toISOString() : null,
    };
  }

  function emit(id, data, name = 'session') {
    if (name === 'session') {
      const s = state.sessions[id];
      if (!s) return;
      data = sessionView(s);
    }
    for (const fn of listeners.get(id) ?? []) fn(data, name);
  }

  function createSession({ code, minutes, unlimited, paymentId, amount, method }) {
    const t = now();
    const id = state.scenario === 'paid-demo' ? SESSION_ID : uuid();
    const table = state.tables[code];
    state.sessions[id] = {
      id,
      code,
      status: 'active',
      started_at: t,
      paid_until: unlimited ? t + (method === 'sbp' ? 30 : 120) * MIN : t + minutes * MIN,
      unlimited,
      is_payer: true,
      participants: [{ nick: state.user?.nick ?? 'Игрок 1', is_payer: true }],
      payments: [{ payment_id: paymentId, method, amount_kopecks: amount, minutes, at: t }],
    };
    Object.assign(table, { status: 'busy', session_id: id, busy_until: state.sessions[id].paid_until, pending_by: null });
    return id;
  }

  function applyPayment(p) {
    const q = state.quotes[p.quote_id];
    if (q.kind === 'extend') {
      const s = state.sessions[q.session_id];
      s.paid_until += (q.minutes ?? (p.method === 'sbp' ? 30 : 120)) * MIN;
      s.status = 'active';
      s.payments.push({ payment_id: p.id, method: p.method, amount_kopecks: q.amount_kopecks, minutes: q.minutes, at: now() });
      state.tables[s.code].busy_until = s.paid_until;
      p.session_id = s.id;
      emit(s.id);
    } else {
      p.session_id = createSession({
        code: q.code,
        minutes: q.minutes,
        unlimited: q.minutes === null,
        paymentId: p.id,
        amount: q.amount_kopecks,
        method: p.method,
      });
    }
  }

  // ---------- сценарии для проверки глазами ----------

  function scenario(name) {
    state = freshState();
    state.scenario = name;
    state.testMode = name === 'testclub' || name === 'testgame';
    // M5.8: корты есть только в сценариях court* — остальные проверки видят прежний зал из 7 столов
    if (name?.startsWith('court')) {
      for (const c of COURTS) state.tables[c.code] = { ...c, busy_until: c.busyMin ? now() + c.busyMin * MIN : null };
    }
    // nologin — боты не настроены (U1), tgonly — только Telegram: оба без входа; nobots — вошёл, ботов нет
    if (['anon', 'nologin', 'tgonly'].includes(name)) return save();
    state.user = { ...USER, consent_version: name === 'fresh' ? null : 'draft-2026-10' };
    const t = now();
    const mk = (over) => {
      const table = state.tables['4K7P9QW2XM'];
      const s = {
        id: SESSION_ID,
        code: table.code,
        status: 'active',
        started_at: t - 55 * MIN,
        paid_until: t + 65 * MIN,
        unlimited: false,
        is_payer: true,
        participants: [{ nick: 'Игрок 1', is_payer: true }, { nick: 'Андрей К.' }],
        payments: [{ payment_id: uuid(), method: 'sbp', amount_kopecks: 160000, minutes: 120, at: t - 55 * MIN }],
        ...over,
      };
      state.sessions[s.id] = s;
      Object.assign(table, { status: 'busy', session_id: s.id, busy_until: s.paid_until });
    };
    if (name === 'game' || name === 'testgame') mk({});
    if (name === 'notpayer') mk({ is_payer: false, participants: [{ nick: 'Андрей К.', is_payer: true }, { nick: 'Игрок 1' }] });
    if (name === 'warn') mk({ started_at: t - 115 * MIN, paid_until: t + 299_900 });
    if (name === 'grace') mk({ started_at: t - 120 * MIN, paid_until: t - 18 * 1000 });
    if (name === 'unlimited') mk({ started_at: t - 72 * MIN, paid_until: t + 48 * MIN, unlimited: true, payments: [{ payment_id: uuid(), method: 'card', amount_kopecks: 160000, minutes: null, at: t - 72 * MIN }] });
    if (name === 'interrupted') mk({ status: 'interrupted', started_at: t - 102 * MIN, paid_until: t - 2 * MIN, unplayed_ms: 18 * MIN });
    if (name === 'closed') {
      mk({ status: 'closed', started_at: t - 125 * MIN, paid_until: t - 5 * MIN, ended_at: t - 3 * MIN });
      state.sessions[SESSION_ID].payments.push({ payment_id: uuid(), method: 'cash', amount_kopecks: 40000, minutes: 30, at: t - 30 * MIN });
      Object.assign(state.tables['4K7P9QW2XM'], { status: 'free', session_id: null, busy_until: null });
    }
    if (name === 'courtgame' || name === 'courtfull') {
      const court = state.tables.TESTC00001;
      const s = {
        id: SESSION_ID,
        code: court.code,
        status: 'active',
        started_at: t - 25 * MIN,
        paid_until: t + 65 * MIN,
        unlimited: false,
        is_payer: true,
        participants: [{ nick: 'Игрок 1', is_payer: true }, { nick: 'Андрей К.' }],
        payments: [{ payment_id: uuid(), method: 'sbp', amount_kopecks: 240000, minutes: SLOT, at: t - 25 * MIN }],
      };
      state.sessions[s.id] = s;
      Object.assign(court, { status: 'busy', session_id: s.id, busy_until: s.paid_until });
    }
    if (name === 'courtfull') {
      // Чужая игра на корте 2: уже 4 игрока — пятому «Я играю на этом корте» сервер отвечает 400 limit_exceeded
      const court = state.tables.TESTC00002;
      const id = 'b7e1d2c3-0000-4000-8000-0000000000c2';
      state.sessions[id] = {
        id, code: court.code, status: 'active', started_at: t - 40 * MIN, paid_until: court.busy_until, unlimited: false, is_payer: false,
        participants: [{ nick: 'Мария С.', is_payer: true }, { nick: 'Олег' }, { nick: 'Ника' }, { nick: 'Тимур' }], payments: [],
      };
      court.session_id = id;
      delete state.sessions[SESSION_ID];
      Object.assign(state.tables.TESTC00001, { status: 'free', session_id: null, busy_until: null });
    }
    if (name === 'limit') mk({ extend_limit_until: t + 65 * MIN + 40 * MIN, next_booking_at: t + 65 * MIN + 45 * MIN });
    // M4 (№146): на столе турнир через 45 минут после конца оплаты — предел продления без next_booking_at
    if (name === 'tourlimit') mk({ extend_limit_until: t + 65 * MIN + 40 * MIN, tournament_at: t + 65 * MIN + 45 * MIN, tournament_until: t + 65 * MIN + 6 * 60 * MIN });
    // M2: бар — заказы и счёт стола
    if (name === 'barorders') mk({});
    if (name === 'closedtab') {
      mk({ status: 'closed', started_at: t - 125 * MIN, paid_until: t - 5 * MIN, ended_at: t - 3 * MIN });
      Object.assign(state.tables['4K7P9QW2XM'], { status: 'free', session_id: null, busy_until: null });
    }
    barSeed(state, name, t, SESSION_ID);
    m3.seed(name, t);
    if (name === 'plusgame' || name === 'plusrace' || name === 'pluslimit') mk({ participants: [{ nick: 'Игрок 1', is_payer: true }, { nick: 'Андрей К.' }] });
    m4.seed(name, t);
    save();
  }

  // ---------- маршруты ----------

  const err = (status, code) => ({ status, body: { error: code } });
  const ok = (body) => ({ status: 200, body });
  const needUser = () => (state.user ? null : err(401, 'unauthorized'));

  const routes = [
    ['GET', /^\/api\/t\/([^/]+)$/, (m) => {
      const table = state.tables[decodeURIComponent(m[1]).toUpperCase()];
      if (!table) return err(404, 'not_found');
      if (table.status === 'pending' && table.pending_until && table.pending_until < now()) Object.assign(table, { status: 'free', pending_by: null });
      const mine = table.session_id && state.sessions[table.session_id];
      const mineView = mine && sessionView(mine);
      const isMine = Boolean(state.user && mineView && !['closed', 'cancelled'].includes(mineView.status) && mine.participants.some((p) => p.nick === state.user.nick));
      const status = mineView && ['closed', 'cancelled'].includes(mineView.status) ? 'free' : table.status;
      const court = isCourtT(table);
      return ok({
        club: clubView(),
        // M5.8: вид ресурса — kind, family, billing, slot_minutes, max_players (server/payments/quotes.mjs tableByCode)
        resource: { id: ridOf(table), number: table.number, type: table.type, title: table.title, ...kindFields(table) },
        status,
        busy_until: ['busy', 'service', 'reserved'].includes(status) && table.busy_until ? new Date(table.busy_until).toISOString() : null,
        ...(court ? courtPricesAround(now()) : pricesAround(now())),
        // Корт — три варианта слотов, без «Без лимита»
        options: court ? [SLOT, 2 * SLOT, 3 * SLOT] : [60, 120, 180, 'unlimited'],
        my_session_id: isMine ? table.session_id : null,
        // id чужой сессии для «Я играю за этим столом» — только вошедшим (f1052c2)
        session_id: status === 'busy' && state.user ? table.session_id ?? 'b7e1d2c3-0000-4000-8000-0000000000aa' : null,
      });
    }],
    // Как у core (§14): consent {version, accepted}
    ['GET', /^\/api\/me$/, () => needUser() ?? ok({ user: { ...m3.meView(state.user), consent: { version: 'draft-2026-10', accepted: Boolean(state.user.consent_version) } }, clubs: [] })],
    ['POST', /^\/api\/auth\/dev$/, (_m, body) => {
      if (!/^\+7\d{10}$/.test(body?.phone ?? '')) return err(400, 'bad_request');
      state.user = { ...USER, phone_masked: `+7 *** ***-${body.phone.slice(-4, -2)}-${body.phone.slice(-2)}`, consent_version: null };
      return ok({ token: 'mock-token', user: state.user });
    }],
    // U1: только настроенные способы входа
    ['GET', /^\/api\/auth\/methods$/, () => ok({ methods: ['nologin', 'nobots'].includes(state.scenario) ? [] : state.scenario === 'tgonly' ? ['telegram'] : ['max', 'telegram', 'dev'] })],
    ['POST', /^\/api\/auth\/bot-link$/, (_m, body) => {
      const nonce = uuid().replace(/-/g, '').slice(0, 16);
      state.links[nonce] = { created: now(), channel: body.channel };
      const deep = body.channel === 'telegram' ? `https://t.me/billiardum_bot?start=${nonce}` : `https://max.ru/billiardum_bot?start=${nonce}`;
      return ok({ nonce, deep_link: deep, code: '482913', expires_at: new Date(now() + 10 * MIN).toISOString() });
    }],
    ['GET', /^\/api\/auth\/bot-link\/([^/]+)$/, (m) => {
      const link = state.links[m[1]];
      if (!link) return err(404, 'not_found');
      // Гость «поделился контактом» через 4 секунды
      if (now() - link.created > 4000) {
        state.user = { ...USER, consent_version: null };
        return ok({ status: 'done', token: 'mock-token' });
      }
      return ok({ status: 'pending' });
    }],
    ['POST', /^\/api\/auth\/consent$/, () => {
      if (!state.user) return err(401, 'unauthorized');
      state.user.consent_version = 'draft-2026-10';
      return ok({ ok: true });
    }],
    ['POST', /^\/api\/auth\/logout$/, () => {
      state.user = null;
      return ok({ ok: true });
    }],
    ['POST', /^\/api\/quotes$/, (_m, body) => {
      const u = needUser();
      if (u) return u;
      if (!state.user.consent_version) return err(403, 'consent_required');
      const table = tableBy((t) => ridOf(t) === body.resource_id);
      if (!table) return err(404, 'not_found');
      const t = now();
      // Корт (M5.8): 1…4 слота, без «Без лимита» и часов пакета — иначе 400 bad_request
      if (isCourtT(table) && (body.minutes === null || body.use_balance === true || ![1, 2, 3, 4].map((k) => k * SLOT).includes(body.minutes))) return err(400, 'bad_request');
      let from = t;
      if (body.kind === 'start') {
        if (table.status === 'pending' && table.pending_by !== state.user.id) return err(409, 'table_pending');
        // Стол держат за другим гостем (бронь, предложение из очереди №122) — table_busy
        if (table.status === 'busy' || table.status === 'reserved') return err(409, 'table_busy');
        if (table.status === 'offline') return err(409, 'table_offline');
        if (table.status === 'service') return err(409, 'table_service');
        Object.assign(table, { status: 'pending', pending_by: state.user.id, pending_until: t + 3 * MIN });
      } else {
        const s = state.sessions[body.session_id];
        if (!s || ['closed', 'cancelled'].includes(sessionView(s).status)) return err(409, 'session_not_active');
        from = Math.max(s.paid_until, t);
        // M3 (№106): перед бронью продлить можно до её начала минус 5 минут
        if (s.extend_limit_until && !s.unlimited && body.minutes !== null && from + body.minutes * MIN > s.extend_limit_until) {
          // Окно турнира — как у server/payments/quotes.mjs: 409 table_busy {reason: 'tournament', busy_until}
          if (s.tournament_at) return { status: 409, body: { error: 'table_busy', reason: 'tournament', busy_until: new Date(s.tournament_until).toISOString() } };
          return err(409, 'booking_conflict');
        }
      }
      const minutes = body.minutes === null ? 120 : body.minutes;
      const { amount_kopecks, breakdown } = amountFor(from, minutes, table);
      const id = uuid();
      state.quotes[id] = { id, code: table.code, kind: body.kind, minutes: body.minutes, session_id: body.session_id, amount_kopecks, valid_until: t + 3 * MIN, used: false };
      const out = { quote_id: id, amount_kopecks, minutes: body.minutes, valid_until: new Date(t + 3 * MIN).toISOString(), breakdown };
      if (isCourtT(table)) Object.assign(out, { slot_minutes: SLOT, slots: body.minutes / SLOT });
      // Блок «Без лимита» как у backend-money: заморозка за 2 часа по карте, блоки по 30 минут по СБП
      if (body.minutes === null) out.unlimited = { hold_minutes: 120, hold_amount_kopecks: amount_kopecks, sbp_block_minutes: 30, sbp_block_amount_kopecks: amountFor(from, 30).amount_kopecks };
      // M3 (№112): use_balance — часть минут часами пакета, amount_kopecks — доплата
      if (body.use_balance === true) {
        if (body.minutes === null) return err(400, 'bad_request');
        const b = m3.quoteBalance(body.minutes, from);
        Object.assign(out, b);
        Object.assign(state.quotes[id], { amount_kopecks: b.amount_kopecks, balance_minutes: b.balance_minutes });
        if (b.balance_minutes > 0) out.breakdown = [];
      }
      const sess = body.kind === 'extend' ? state.sessions[body.session_id] : null;
      out.extend_limit_until = sess?.extend_limit_until && !sess.unlimited ? new Date(sess.extend_limit_until).toISOString() : null;
      return ok(out);
    }],
    ['POST', /^\/api\/quotes\/([^/]+)\/pay$/, (m, body) => {
      const q = state.quotes[m[1]];
      if (!q) return err(404, 'not_found');
      if (q.valid_until < now()) return err(409, 'quote_expired');
      if (q.used) return err(409, 'quote_used');
      if (body.method === 'balance') {
        // Всё балансом (доплата 0): платёж сразу подтверждён, без ЮKassa
        if (!q.balance_minutes || q.amount_kopecks > 0) return err(400, 'bad_request');
        q.used = true;
        m3.debit(q.balance_minutes);
        const id = uuid();
        state.payments[id] = { id, quote_id: q.id, method: 'balance', status: 'succeeded', paid_at: now(), amount_kopecks: 0 };
        return ok({ payment_id: id, status: 'succeeded' });
      }
      if (q.balance_minutes) m3.debit(q.balance_minutes);
      q.used = true;
      if (body.method === 'reception') {
        const id = uuid();
        const declining = state.scenario === 'decline';
        state.requests[id] = { id, quote_id: q.id, created: now(), status: 'waiting', decide_at: now() + (declining ? 5000 : 8000), declining };
        return ok({ reception_request_id: id, status: 'waiting_reception' });
      }
      const id = uuid();
      state.payments[id] = { id, quote_id: q.id, method: body.method, status: 'pending', amount_kopecks: q.amount_kopecks };
      return ok({ payment_id: id, status: 'pending', confirmation: { type: 'redirect', url: `/app/mock-pay/${id}` } });
    }],
    ['GET', /^\/api\/payments\/([^/]+)$/, (m) => {
      const p = state.payments[m[1]];
      if (!p) return err(404, 'not_found');
      // Свет: сессия появляется через ~1,5 с после подтверждения оплаты (outbox → контроллер)
      if (p.status === 'succeeded' && !p.session_id && now() - p.paid_at > 1500) applyPayment(p);
      return ok({ payment_id: p.id, status: p.status, ...(p.session_id ? { session_id: p.session_id } : {}) });
    }],
    ['GET', /^\/api\/reception\/requests\/([^/]+)$/, (m) => {
      const r = state.requests[m[1]];
      if (!r) return err(404, 'not_found');
      const q = state.quotes[r.quote_id];
      if (r.status === 'waiting' && now() > r.decide_at) {
        if (r.declining) Object.assign(r, { status: 'declined', reason_code: 'guest_left' });
        else {
          const p = { id: uuid(), quote_id: q.id, method: 'cash', status: 'succeeded' };
          state.payments[p.id] = p;
          applyPayment(p);
          Object.assign(r, { status: 'accepted', session_id: p.session_id });
        }
        if (r.status === 'declined' && q.kind === 'start') Object.assign(state.tables[q.code], { status: 'free', pending_by: null });
      }
      return ok({
        id: r.id,
        status: r.status,
        amount_kopecks: q.amount_kopecks,
        minutes: q.minutes,
        expires_at: new Date(r.created + 15 * MIN).toISOString(),
        ...(r.session_id ? { session_id: r.session_id } : {}),
        ...(r.reason_code ? { reason_code: r.reason_code } : {}),
      });
    }],
    ['GET', /^\/api\/sessions\/current$/, () => {
      const u = needUser();
      if (u) return u;
      return ok(Object.values(state.sessions).map(sessionView).filter((s) => !['closed', 'cancelled'].includes(s.status)));
    }],
    ['GET', /^\/api\/sessions\/([^/]+)$/, (m) => {
      const s = state.sessions[m[1]];
      return s ? ok(sessionView(s)) : err(404, 'not_found');
    }],
    ['POST', /^\/api\/sessions\/([^/]+)\/join$/, (m, body) => {
      const u = needUser();
      if (u) return u;
      // Код стола из QR обязателен (b97e2c4): без него 400, чужой стол — 404
      if (typeof body?.code !== 'string' || !body.code) return err(400, 'bad_request');
      let s = state.sessions[m[1]];
      if (!s) {
        // чужая сессия стола 7 из сида заглушки
        const table = state.tables['7H3D2RT9QF'];
        const t = now();
        s = { id: m[1], code: table.code, status: 'active', started_at: t - 13 * MIN, paid_until: table.busy_until, unlimited: false, is_payer: false, participants: [{ nick: 'Мария С.', is_payer: true }], payments: [] };
        state.sessions[s.id] = s;
        table.session_id = s.id;
      }
      // Корт (M5.8 №205): до 4 игроков в одной игре
      const court = isCourtT(state.tables[s.code]);
      if (court && !s.participants.some((p) => p.nick === state.user.nick) && s.participants.length >= 4) return err(400, 'limit_exceeded');
      if (!s.participants.some((p) => p.nick === state.user.nick)) s.participants.push({ nick: state.user.nick });
      s.is_payer = s.participants.find((p) => p.nick === state.user.nick)?.is_payer === true;
      emit(s.id);
      return ok({ ok: true });
    }],
    ['POST', /^\/api\/sessions\/([^/]+)\/stop$/, (m) => {
      const s = state.sessions[m[1]];
      if (!s) return err(404, 'not_found');
      if (s.is_payer === false) return err(403, 'not_payer');
      Object.assign(s, { status: 'closed', ended_at: now() });
      Object.assign(state.tables[s.code], { status: 'free', session_id: null, busy_until: null });
      emit(s.id);
      return ok(sessionView(s));
    }],
    ['POST', /^\/api\/sessions\/([^/]+)\/resolve$/, (m, body) => {
      const s = state.sessions[m[1]];
      if (!s) return err(404, 'not_found');
      if (s.status !== 'interrupted') return err(409, 'session_not_active');
      if (body.choice === 'continue') Object.assign(s, { status: 'active', paid_until: now() + s.unplayed_ms });
      else Object.assign(s, { status: 'closed', ended_at: now(), refunded_kopecks: Math.round((s.unplayed_ms / MIN) * (80000 / 60) / 100) * 100 });
      emit(s.id);
      return ok(sessionView(s));
    }],
    ['GET', /^\/api\/sessions\/([^/]+)\/receipt$/, (m) => {
      const s = state.sessions[m[1]];
      if (!s) return err(404, 'not_found');
      const lines = s.payments.map((p, i) => ({
        title: p.minutes ? `${i === 0 ? 'Игра' : 'Продление'}, ${[Math.floor(p.minutes / 60) ? `${Math.floor(p.minutes / 60)} ч` : '', p.minutes % 60 ? `${p.minutes % 60} мин` : ''].filter(Boolean).join(' ')}` : 'Игра без лимита',
        amount_kopecks: p.amount_kopecks,
        from: new Date(p.at).toISOString(),
        to: new Date(p.at + (p.minutes ?? 72) * MIN).toISOString(),
      }));
      if (s.refunded_kopecks) lines.push({ title: 'Возврат за неотыгранное время', amount_kopecks: -s.refunded_kopecks });
      const total = lines.reduce((a, l) => a + l.amount_kopecks, 0);
      return ok({ lines, total_kopecks: total, payments: s.payments.map((p) => ({ method: p.method, amount_kopecks: p.amount_kopecks, payment_id: p.payment_id })), receipt_status: s.payments.some((p) => p.method === 'cash') ? 'receipt_pending' : 'sent' });
    }],
    ['GET', /^\/api\/push\/vapid-public-key$/, () => ok({ public_key: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' })],
    ['POST', /^\/api\/push\/subscribe$/, () => {
      // M3: подписка Web Push подключает канал «Уведомления браузера»
      if (state.user) state.user.push_linked = true;
      return ok({ ok: true });
    }],
  ];

  const bar = barRoutes({ state: () => state, now, emit, needUser, sessionView, err, ok });
  routes.unshift(...bar.routes);
  const m3 = m3Routes({
    state: () => state,
    now,
    club: clubView(),
    tables: () => Object.values(state.tables),
    resourceId,
    ridOf,
    kindFields,
    amountFor,
    createSession,
    err,
    ok,
    needUser,
    // Свой канал гостя user:{id} (№120): GET /api/stream?me=1
    emitMe: (name, data) => emit('me', data, name),
  });
  routes.unshift(...m3.routes);
  const m4 = m4Routes({
    state: () => state,
    now,
    club: clubView(),
    tables: () => Object.values(state.tables),
    resourceId,
    ridOf,
    err,
    ok,
    needUser,
    meId: () => (state.user ? USER.id : undefined),
    sessions: () => state.sessions,
    sessionId: SESSION_ID,
    // ТВ и страница турнира: канал tournament:{id}, событие bracket
    emitTournament: (id, data) => {
      for (const fn of listeners.get(`tournament:${id}`) ?? []) fn(data, 'bracket');
    },
  });
  routes.unshift(...m4.routes);

  async function handle(method, path, body, query) {
    bar.tick();
    m3.tick();
    m4.tick();
    for (const [m, re, fn] of routes) {
      if (m !== method) continue;
      const match = re.exec(path);
      if (match) {
        const res = fn(match, body, query);
        save();
        return res;
      }
    }
    return err(404, 'not_found');
  }

  return {
    handle,
    scenario,
    reset() {
      state = freshState();
      save();
    },
    /** Страница «ЮKassa» заглушки: оплатить или отказаться. */
    confirm(paymentId, success) {
      const p = state.payments[paymentId];
      if (!p) return false;
      if (p.kind === 'tournament') {
        m4.confirm(p, success);
        save();
        return true;
      }
      if (['booking', 'booking_start', 'package'].includes(p.kind)) {
        m3.confirm(p, success);
        save();
        return true;
      }
      if (p.kind === 'order' || p.kind === 'tab') {
        bar.confirm(p, success);
        save();
        return true;
      }
      if (success) Object.assign(p, { status: 'succeeded', paid_at: now() });
      else {
        p.status = 'canceled';
        const q = state.quotes[p.quote_id];
        if (q.kind === 'start') Object.assign(state.tables[q.code], { status: 'free', pending_by: null });
      }
      save();
      return true;
    },
    payment: (id) => state.payments[id] && { ...state.payments[id], ...(state.quotes[state.payments[id].quote_id] ? { amount_kopecks: state.quotes[state.payments[id].quote_id].amount_kopecks } : {}) },
    subscribe(sessionId, fn) {
      if (!listeners.has(sessionId)) listeners.set(sessionId, new Set());
      listeners.get(sessionId).add(fn);
      return () => listeners.get(sessionId)?.delete(fn);
    },
    get state() {
      return state;
    },
  };
}
