/*
 * BL_MOCK_MARKER — заглушка M3 гостя только для разработки (VITE_MOCK=1). Вид ответов — как у сервера:
 * server/bookings (availability, бронь, старт), server/waitlist, server/packages (пакеты, баланс), server/payments/quotes.mjs
 * (use_balance, extend_limit_until), PATCH /api/me (notify_channel, channels_order), GET /api/clubs и поток гостя ?me=1
 * (№120: события booking и waitlist, вид — в data.type). Коды ошибок — серверные.
 *
 * Сценарии: book (брони и баланс) | mybooking (стол 4: ваша бронь через 10 минут) | early (бронь через 50 минут — ранний приход
 * с доплатой) | waitlist (стол 7 занят, вы в очереди — через 8 секунд предложение на 5 минут) | balance (5 часов на балансе)
 */

import { zonedMs, localDate, addDays } from '@billiardum/shared/booking';

const MIN = 60_000;
const uuid = () => globalThis.crypto.randomUUID();

/** Правила брони клуба (server/bookings/settings.mjs): полная предоплата, бесплатная отмена за 2 часа. */
const SETTINGS = { prepayment: 'full', deposit_kopecks: 0, forfeit_percent: 100, free_cancel_minutes: 120, hold_minutes: 15, hold_prepaid_minutes: 30, early_max_minutes: 120, early_free_minutes: 5 };
const PACKAGES = [
  { id: 'p0000001-0000-4000-8000-000000000001', title: '5 часов', minutes: 300, price_kopecks: 300000, valid_days: 30 },
  { id: 'p0000001-0000-4000-8000-000000000002', title: '10 часов', minutes: 600, price_kopecks: 550000, valid_days: 60 },
  { id: 'p0000001-0000-4000-8000-000000000003', title: 'Утро, 8 часов', minutes: 480, price_kopecks: 320000, valid_days: 30 },
];

/**
 * @param {{ state: () => object, now: () => number, club: object, tables: () => object[], resourceId: (n: number) => string,
 *   amountFor: (from: number, minutes: number) => { amount_kopecks: number }, createSession: (o: object) => string,
 *   err: Function, ok: Function, needUser: Function, emitMe: (name: string, data: object) => void }} ctx
 */
export function m3Routes(ctx) {
  const { err, ok, now, club } = ctx;
  const S = () => {
    const st = ctx.state();
    st.m3 ??= { bookings: {}, waitlist: {}, lots: [] };
    return st.m3;
  };
  const tz = club.timezone;
  const iso = (t) => new Date(t).toISOString();
  const tableById = (id) => ctx.tables().find((t) => ctx.resourceId(t.number) === id);
  const userId = () => ctx.state().user?.id;

  // Рабочий день клуба: 12:00–02:00 по местному времени
  const dayBounds = (date) => ({ open: zonedMs(date, 12 * 60, tz), close: zonedMs(date, 26 * 60, tz) });
  const rates = (date) => [
    { from: iso(zonedMs(date, 12 * 60, tz)), to: iso(zonedMs(date, 17 * 60, tz)), per_hour_kopecks: 50000 },
    { from: iso(zonedMs(date, 17 * 60, tz)), to: iso(zonedMs(date, 24 * 60, tz)), per_hour_kopecks: 80000 },
    { from: iso(zonedMs(date, 24 * 60, tz)), to: iso(zonedMs(date, 26 * 60, tz)), per_hour_kopecks: 90000 },
  ];

  /** Чужие брони для живой борт-шкалы: по одной-две на стол каждый день. */
  function seededBusy(date, number) {
    const seed = [...date].reduce((a, c) => a + c.charCodeAt(0), 0) + number * 7;
    const at = (h) => zonedMs(date, h * 60, tz);
    const out = [];
    const h1 = 17 + (seed % 4);
    out.push({ from: iso(at(h1)), to: iso(at(h1 + 2)), kind: 'booking' });
    if (seed % 3 === 0) out.push({ from: iso(at(13 + (seed % 2))), to: iso(at(14.5 + (seed % 2))), kind: 'booking' });
    return out;
  }

  function busyFor(date, table) {
    const list = seededBusy(date, table.number);
    const { open, close } = dayBounds(date);
    if (table.busy_until && ['busy', 'service'].includes(table.status)) list.push({ from: iso(now() - 30 * MIN), to: iso(table.busy_until + 2 * MIN), kind: table.status === 'busy' ? 'session' : 'service' });
    if (table.status === 'pending') list.push({ from: iso(now()), to: iso(now() + 3 * MIN), kind: 'pending' });
    for (const b of Object.values(S().bookings)) {
      if (b.resource_id !== ctx.resourceId(table.number) || !['pending_payment', 'confirmed', 'reserved'].includes(b.status)) continue;
      list.push({ from: iso(b.starts), to: iso(b.ends), kind: 'booking' });
    }
    return list.filter((x) => Date.parse(x.to) > open && Date.parse(x.from) < close).sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
  }

  function cancelInfo(b) {
    const allowed = ['pending_payment', 'confirmed', 'reserved'].includes(b.status);
    const freeUntil = b.starts - SETTINGS.free_cancel_minutes * MIN;
    const p = now() <= freeUntil ? 0 : SETTINGS.forfeit_percent;
    const kept = Math.floor((b.paid * p * 2 + 100) / 200);
    return { allowed, refund_kopecks: allowed ? b.paid - kept : 0, free_until: b.paid > 0 ? iso(freeUntil) : null };
  }

  /** Событие брони гостю в потоке user:{id} (№120): { type: 'booking.<status>', id, status, starts_at, ends_at, resource }. */
  function bookingEvent(b) {
    const t = tableById(b.resource_id);
    ctx.emitMe('booking', { type: `booking.${b.status}`, id: b.id, status: b.status, starts_at: iso(b.starts), ends_at: iso(b.ends), resource: { id: b.resource_id, number: t.number } });
  }

  /** Бронь со временем: подтверждённая за 15 минут до начала — reserved, после удержания — expired. */
  function advance(b) {
    const was = b.status;
    if (b.status === 'confirmed' && now() >= b.starts - 15 * MIN) b.status = 'reserved';
    if (b.status === 'reserved' && now() > b.starts + b.hold * MIN) b.status = 'expired';
    if (b.status !== was && b.user_id) bookingEvent(b);
  }

  /** Бронь как view() server/bookings/service.mjs. */
  function view(b) {
    const t = tableById(b.resource_id);
    advance(b);
    return {
      id: b.id,
      club: { id: club.id, name: club.name, timezone: tz },
      resource: { id: b.resource_id, number: t.number, title: t.title, type: t.type },
      status: b.status,
      source: b.source ?? 'app',
      starts_at: iso(b.starts),
      ends_at: iso(b.ends),
      minutes: b.minutes,
      hold_until: iso(b.starts + b.hold * MIN),
      amount_kopecks: b.amount,
      prepayment_mode: SETTINGS.prepayment,
      prepayment_kopecks: b.prepay,
      paid_kopecks: b.paid,
      pay_until: b.status === 'pending_payment' ? iso(b.created + 15 * MIN) : null,
      payment_id: b.payment_id ?? null,
      session_id: b.session_id ?? null,
      expire_reason: b.status === 'expired' ? 'no_show' : null,
      created_at: iso(b.created),
      cancel: cancelInfo(b),
    };
  }

  function makeBooking(table, starts, minutes, over = {}) {
    const b = { id: uuid(), resource_id: ctx.resourceId(table.number), user_id: userId(), starts, ends: starts + minutes * MIN, minutes, status: 'confirmed', paid: 0, created: now(), ...over };
    b.amount = ctx.amountFor(b.starts, b.minutes).amount_kopecks;
    b.prepay = SETTINGS.prepayment === 'full' ? b.amount : 0;
    b.hold = b.prepay > 0 ? SETTINGS.hold_prepaid_minutes : SETTINGS.hold_minutes;
    if (over.status === undefined) b.paid = b.prepay;
    S().bookings[b.id] = b;
    return b;
  }

  function waitlistView(w) {
    if (w.status === 'offered' && now() > w.offer_until) {
      w.status = 'expired';
      const t = ctx.tables().find((x) => x.code === w.code);
      if (t?.pending_by === 'waitlist') Object.assign(t, { status: 'free', pending_by: null });
      ctx.emitMe('waitlist', { type: 'waitlist.updated', ...waitlistView(w) });
    }
    const t = ctx.tables().find((x) => x.code === w.code);
    return {
      id: w.id,
      club_id: club.id,
      resource: { id: ctx.resourceId(t.number), number: t.number, title: t.title },
      status: w.status,
      position: w.position,
      offer_until: w.status === 'offered' ? iso(w.offer_until) : null,
      hold_until: w.status === 'accepted' ? iso(w.hold_until) : null,
      created_at: iso(w.created),
    };
  }

  const wlResource = (w) => {
    const t = ctx.tables().find((x) => x.code === w.code);
    return { id: ctx.resourceId(t.number), number: t.number, title: t.title };
  };

  /** Стол освободился, очередь есть (T20): игра на нём закончилась, первому — предложение на 5 минут, стол держим за ним. */
  function tick() {
    for (const w of Object.values(S().waitlist)) {
      if (w.status === 'waiting' && w.offer_at && now() >= w.offer_at) {
        const t = ctx.tables().find((x) => x.code === w.code);
        const s = t.session_id && ctx.state().sessions[t.session_id];
        if (s) Object.assign(s, { status: 'closed', ended_at: now() });
        Object.assign(t, { status: 'pending', pending_by: 'waitlist', busy_until: null, session_id: null });
        Object.assign(w, { status: 'offered', position: 1, offer_until: now() + 5 * MIN });
        ctx.emitMe('waitlist', { type: 'waitlist.offered', offer_id: w.id, resource: wlResource(w), expires_at: iso(w.offer_until) });
      }
      if (w.status === 'waiting' && w.position > 1 && now() - w.created > 12_000) {
        w.position = 1;
        ctx.emitMe('waitlist', { type: 'waitlist.updated', ...waitlistView(w) });
      }
      if (w.status === 'offered') waitlistView(w);
    }
    for (const b of Object.values(S().bookings)) advance(b);
  }

  function balanceOf() {
    const lots = S().lots.filter((l) => l.minutes_left > 0 && l.expires > now()).sort((a, b) => a.expires - b.expires);
    return { minutes: lots.reduce((a, l) => a + l.minutes_left, 0), lots: lots.map((l) => ({ id: l.id, package_id: l.package_id, minutes_left: l.minutes_left, minutes_total: l.minutes_total, expires_at: iso(l.expires) })) };
  }

  function addLot(pk, t = now(), left = pk.minutes) {
    S().lots.push({ id: uuid(), package_id: pk.id, minutes_total: pk.minutes, minutes_left: left, expires: t + pk.valid_days * 24 * 60 * MIN });
  }

  // ---------- сценарии ----------
  function seed(name, t) {
    const st = ctx.state();
    st.m3 = { bookings: {}, waitlist: {}, lots: [] };
    const table = (code) => ctx.tables().find((x) => x.code === code);
    const today = localDate(t, tz);
    const round = (x) => Math.ceil(x / (30 * MIN)) * 30 * MIN;
    if (name === 'book') {
      makeBooking(table('4K7P9QW2XM'), round(t + 3 * 60 * MIN), 120);
      makeBooking(table('6C2J7MD5KT'), zonedMs(addDays(today, 2), 19 * 60, tz), 90);
      const gone = makeBooking(table('3B5R8WA2NP'), zonedMs(addDays(today, -3), 20 * 60, tz), 60);
      gone.status = 'expired';
      addLot(PACKAGES[0], t - 6 * 24 * 60 * MIN, 150);
      addLot(PACKAGES[1], t - 2 * 24 * 60 * MIN, 120);
    }
    if (name === 'mybooking') makeBooking(table('4K7P9QW2XM'), round(t + 10 * MIN), 120);
    if (name === 'early') makeBooking(table('4K7P9QW2XM'), round(t + 50 * MIN), 120);
    if (name === 'waitlist') {
      const w = { id: uuid(), code: '7H3D2RT9QF', status: 'waiting', position: 1, created: t - 4 * MIN, offer_at: t + 8000 };
      st.m3.waitlist[w.id] = w;
    }
    if (name === 'balance') addLot(PACKAGES[0], t);
  }

  // ---------- оплата (страница «ЮKassa» заглушки) ----------
  function confirm(p, success) {
    if (!success) {
      p.status = 'canceled';
      return;
    }
    Object.assign(p, { status: 'succeeded', paid_at: now() });
    if (p.kind === 'booking') {
      const b = S().bookings[p.booking_id];
      Object.assign(b, { status: 'confirmed', paid: b.prepay });
      bookingEvent(b);
    }
    if (p.kind === 'booking_start') {
      const b = S().bookings[p.booking_id];
      b.paid += p.amount_kopecks;
      startSession(b, p);
    }
    if (p.kind === 'package') addLot(PACKAGES.find((x) => x.id === p.package_id));
  }

  function startSession(b, p) {
    const table = tableById(b.resource_id);
    const minutes = Math.round((b.ends - Math.min(now(), b.starts)) / MIN);
    p.session_id = ctx.createSession({ code: table.code, minutes, unlimited: false, paymentId: p.id, amount: b.paid, method: p.method ?? 'booking' });
    Object.assign(b, { status: 'started', session_id: p.session_id });
    bookingEvent(b);
    return p.session_id;
  }

  const ownBooking = (id) => {
    const b = S().bookings[id];
    return b && b.user_id === userId() ? b : null;
  };

  /** return_url оплаты (№120): только путь своего сайта /app/…, иначе 400 — как ownReturnUrl сервера. */
  const ownPath = (v) => (v === undefined ? null : typeof v === 'string' && /^\/app\/[^\s<>"\\]*$/.test(v) && !v.includes('..') ? v : false);

  const routes = [
    // Публичный список клубов (№120): без входа и без персональных данных
    ['GET', /^\/api\/clubs$/, () => ok([{ id: club.id, name: club.name, city: 'Екатеринбург', address: 'ул. Малышева, 1 (разработка)', timezone: tz, plan: { width_cm: 1800, height_cm: 1200 } }])],
    ['GET', /^\/api\/clubs\/([^/]+)\/availability$/, (m, _b, q) => {
      const date = q?.get('date') || localDate(now(), tz);
      const { open, close } = dayBounds(date);
      return ok({
        club: { id: club.id, name: club.name, timezone: tz, plan: null },
        date,
        from: iso(zonedMs(date, 6 * 60, tz)),
        to: iso(zonedMs(date, 30 * 60, tz)),
        open_at: iso(open),
        close_at: iso(close),
        now: iso(now()),
        step_minutes: 30,
        min_minutes: 60,
        max_minutes: 240,
        lead_minutes: 15,
        max_days: 30,
        rules: { prepayment: SETTINGS.prepayment, deposit_kopecks: 0, hold_minutes: SETTINGS.hold_minutes, hold_prepaid_minutes: SETTINGS.hold_prepaid_minutes, free_cancel_minutes: SETTINGS.free_cancel_minutes },
        resources: ctx
          .tables()
          .filter((t) => t.status !== 'offline')
          .sort((a, b) => a.number - b.number)
          .map((t) => ({ id: ctx.resourceId(t.number), number: t.number, type: t.type, title: t.title, plan: { x: null, y: null, rotation: null }, busy: busyFor(date, t), free: [], rates: rates(date) })),
      });
    }],
    ['POST', /^\/api\/bookings$/, (_m, body) => {
      const u = ctx.needUser();
      if (u) return u;
      const table = tableById(body.resource_id);
      if (!table) return err(404, 'not_found');
      const starts = Date.parse(body.starts_at);
      if (!Number.isFinite(starts) || !Number.isInteger(body.minutes) || body.minutes < 60 || body.minutes > 240 || body.minutes % 30) return err(400, 'bad_request');
      if (starts < now() + 15 * MIN) return err(400, 'bad_request');
      const date = localDate(starts - 6 * 60 * MIN, tz);
      const clash = busyFor(date, table).some((x) => Date.parse(x.from) < starts + body.minutes * MIN && starts < Date.parse(x.to));
      if (clash) return err(409, 'booking_conflict');
      const b = makeBooking(table, starts, body.minutes, { status: SETTINGS.prepayment === 'none' ? 'confirmed' : 'pending_payment' });
      return { status: 201, body: view(b) };
    }],
    ['GET', /^\/api\/me\/bookings$/, () => ctx.needUser() ?? ok(Object.values(S().bookings).filter((b) => b.user_id === userId()).map(view))],
    ['GET', /^\/api\/bookings\/([^/]+)$/, (m) => {
      const b = ownBooking(m[1]);
      return b ? ok(view(b)) : err(404, 'not_found');
    }],
    ['POST', /^\/api\/bookings\/([^/]+)\/pay$/, (m, body) => {
      const b = ownBooking(m[1]);
      if (!b) return err(404, 'not_found');
      if (b.status !== 'pending_payment') return err(409, 'booking_not_active');
      if (!['sbp', 'card'].includes(body.method)) return err(400, 'bad_request');
      const back = ownPath(body.return_url);
      if (back === false) return err(400, 'bad_request');
      const id = uuid();
      b.payment_id = id;
      ctx.state().payments[id] = { id, kind: 'booking', booking_id: b.id, method: body.method, status: 'pending', amount_kopecks: b.prepay, return_url: back ?? `/app/wait/${id}` };
      return ok({ booking: view(b), payment_id: id, confirmation: { type: 'redirect', url: `/app/mock-pay/${id}` } });
    }],
    ['POST', /^\/api\/bookings\/([^/]+)\/cancel$/, (m) => {
      const b = ownBooking(m[1]);
      if (!b) return err(404, 'not_found');
      const c = cancelInfo(b);
      if (!c.allowed) return err(409, 'booking_not_active');
      b.status = 'canceled';
      bookingEvent(b);
      return ok({ ...view(b), refund_kopecks: c.refund_kopecks, money: { refunded_kopecks: c.refund_kopecks } });
    }],
    ['POST', /^\/api\/bookings\/([^/]+)\/start$/, (m, body) => {
      const b = ownBooking(m[1]);
      if (!b) return err(404, 'not_found');
      const table = tableById(b.resource_id);
      if (String(body?.code ?? '').toUpperCase() !== table.code) return err(403, 'forbidden');
      if (b.status === 'started') return ok({ status: 'started', session_id: b.session_id, booking: view(b) });
      const v = view(b);
      if (v.status === 'expired') return err(409, 'booking_expired');
      if (!['confirmed', 'reserved'].includes(v.status)) return err(409, 'booking_not_active');
      const t = now();
      if (t < b.starts - SETTINGS.early_max_minutes * MIN) return err(409, 'too_early');
      if (table.status === 'busy') return err(409, 'table_busy');
      if (table.status === 'service') return err(409, 'table_service');
      const early = t < b.starts - SETTINGS.early_free_minutes * MIN;
      const extra = early ? ctx.amountFor(t, Math.ceil((b.starts - t) / MIN)).amount_kopecks : 0;
      const due = Math.max(0, b.amount - b.paid) + extra;
      if (due === 0) return ok({ status: 'started', session_id: startSession(b, { id: uuid(), method: 'booking' }), booking: view(b) });
      const id = uuid();
      ctx.state().payments[id] = { id, kind: 'booking_start', booking_id: b.id, method: body?.method ?? 'sbp', status: 'pending', amount_kopecks: due };
      return ok({ status: 'payment_required', amount_kopecks: due, payment_id: id, confirmation: { type: 'redirect', url: `/app/mock-pay/${id}` }, booking: view(b) });
    }],

    // ---------- лист ожидания ----------
    ['POST', /^\/api\/waitlist$/, (_m, body) => {
      const u = ctx.needUser();
      if (u) return u;
      const table = tableById(body.resource_id);
      if (!table) return err(404, 'not_found');
      const mine = Object.values(S().waitlist).find((w) => w.code === table.code && ['waiting', 'offered'].includes(w.status));
      if (mine) return { status: 201, body: waitlistView(mine) };
      if (table.status === 'free') return err(409, 'table_free');
      const w = { id: uuid(), code: table.code, status: 'waiting', position: 2, created: now(), offer_at: now() + 25_000 };
      S().waitlist[w.id] = w;
      return { status: 201, body: waitlistView(w) };
    }],
    ['GET', /^\/api\/me\/waitlist$/, () => ctx.needUser() ?? ok(Object.values(S().waitlist).filter((w) => w.status !== 'canceled').map(waitlistView))],
    ['DELETE', /^\/api\/waitlist\/([^/]+)$/, (m) => {
      const w = S().waitlist[m[1]];
      if (!w) return err(404, 'not_found');
      w.status = 'canceled';
      const t = ctx.tables().find((x) => x.code === w.code);
      if (t?.pending_by === 'waitlist') Object.assign(t, { status: 'free', pending_by: null });
      ctx.emitMe('waitlist', { type: 'waitlist.updated', ...waitlistView(w) });
      return ok(waitlistView(w));
    }],
    ['POST', /^\/api\/waitlist\/([^/]+)\/accept$/, (m) => {
      const w = S().waitlist[m[1]];
      if (!w) return err(404, 'not_found');
      // Ответ сервера: { status: 'accepted', resource, resource_id, hold_until } — кода стола нет (№119)
      const accepted = () => ({ status: 'accepted', resource: wlResource(w), resource_id: wlResource(w).id, hold_until: iso(w.hold_until) });
      if (w.status === 'accepted' && w.hold_until > now()) return ok(accepted());
      if (waitlistView(w).status !== 'offered') return err(409, 'offer_expired');
      // Стол держится за гостем 3 минуты (как котировка), дальше — обычная котировка и оплата
      Object.assign(w, { status: 'accepted', hold_until: now() + 3 * MIN });
      const t = ctx.tables().find((x) => x.code === w.code);
      Object.assign(t, { status: 'pending', pending_by: userId(), pending_until: now() + 3 * MIN });
      ctx.emitMe('waitlist', { type: 'waitlist.accepted', offer_id: w.id, resource: wlResource(w), hold_until: iso(w.hold_until) });
      return ok(accepted());
    }],

    // ---------- пакеты часов и баланс ----------
    ['GET', /^\/api\/clubs\/([^/]+)\/packages$/, () => ok(PACKAGES.map((p) => ({ ...p, club_id: club.id, hours: p.minutes / 60, active: true })))],
    ['POST', /^\/api\/packages\/([^/]+)\/buy$/, (m, body) => {
      const u = ctx.needUser();
      if (u) return u;
      const pk = PACKAGES.find((x) => x.id === m[1]);
      if (!pk) return err(404, 'not_found');
      if (!['sbp', 'card'].includes(body.method)) return err(400, 'bad_request');
      const back = ownPath(body.return_url);
      if (back === false) return err(400, 'bad_request');
      const id = uuid();
      ctx.state().payments[id] = { id, kind: 'package', package_id: pk.id, method: body.method, status: 'pending', amount_kopecks: pk.price_kopecks, return_url: back ?? `/app/wait/${id}` };
      return ok({ payment_id: id, status: 'pending', confirmation: { type: 'redirect', url: `/app/mock-pay/${id}` } });
    }],
    ['GET', /^\/api\/clubs\/([^/]+)\/balance$/, () => ctx.needUser() ?? ok(balanceOf())],

    // ---------- каналы уведомлений (как PATCH /api/me core) ----------
    ['PATCH', /^\/api\/me$/, (_m, body) => {
      const u = ctx.needUser();
      if (u) return u;
      const user = ctx.state().user;
      const known = ['max', 'telegram', 'webpush'];
      if (body.notify_channel !== undefined) {
        if (body.notify_channel !== null && !known.includes(body.notify_channel)) return err(400, 'bad_request');
        user.notify_channel = body.notify_channel;
      }
      if (body.channels_order !== undefined) {
        const o = body.channels_order;
        if (o !== null && (!Array.isArray(o) || !o.length || o.length > 3 || new Set(o).size !== o.length || o.some((c) => !known.includes(c)))) return err(400, 'bad_request');
        user.channels_order = o;
      }
      return ok({ user: meView(user) });
    }],
  ];

  function meView(user) {
    return { ...user, notify_channel: user.notify_channel ?? null, channels_order: user.channels_order ?? null, channels: { max: user.max_linked !== false, telegram: Boolean(user.telegram_linked), webpush: Boolean(user.push_linked) } };
  }

  /** Котировка с use_balance (№112): balance_minutes покрыто балансом, amount_kopecks — доплата за остальное. */
  function quoteBalance(minutes, from) {
    const available = balanceOf().minutes;
    const covered = Math.min(available, minutes);
    const rest = minutes - covered;
    return { balance_minutes: covered, balance_available_minutes: available, amount_kopecks: rest === 0 ? 0 : ctx.amountFor(from + covered * MIN, rest).amount_kopecks };
  }

  /** Списать минуты с партий: сначала те, что сгорят раньше. */
  function debit(minutes) {
    let left = minutes;
    for (const l of S().lots.filter((x) => x.minutes_left > 0 && x.expires > now()).sort((a, b) => a.expires - b.expires)) {
      const take = Math.min(l.minutes_left, left);
      l.minutes_left -= take;
      left -= take;
      if (!left) break;
    }
  }

  return { routes, seed, tick, confirm, quoteBalance, debit, meView };
}
