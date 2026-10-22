/*
 * BL_MOCK_MARKER — заглушка M3 программы клуба только для разработки (VITE_MOCK=1). Вид ответов — как у сервера:
 * server/bookings (availability, брони клуба, бронь по телефону, отмена №115, «гость пришёл»), server/staff (персонал),
 * server/packages (пакеты, партии гостя по телефону и возврат №118), server/reception createDeposit (депозит наличными,
 * нужна смена). Волна B (№120): next_booking у стола в зале, can_cancel в брони, событие booking с полем type.
 */

const MIN = 60_000;
const uuid = () => globalThis.crypto.randomUUID();

const PACKAGES = [
  { id: 'p0000001-0000-4000-8000-000000000001', title: '5 часов', minutes: 300, price_kopecks: 300000, valid_days: 30, active: true },
  { id: 'p0000001-0000-4000-8000-000000000002', title: '10 часов', minutes: 600, price_kopecks: 550000, valid_days: 60, active: true },
  { id: 'p0000001-0000-4000-8000-000000000003', title: 'Утро, 8 часов', minutes: 480, price_kopecks: 320000, valid_days: 30, active: true },
];

/** Местная дата и полночь клуба (UTC+5) без Intl: заглушке хватает фиксированного смещения. */
const OFFSET = 5 * 60 * MIN;
const localDate = (t) => new Date(t + OFFSET).toISOString().slice(0, 10);
const atLocal = (date, minutes) => Date.parse(`${date}T00:00:00Z`) - OFFSET + minutes * MIN;

/** Состояние M3 при новом сценарии. */
export function m3State(scenario, t, hall) {
  const today = localDate(t);
  const round = (x) => Math.ceil(x / (30 * MIN)) * 30 * MIN;
  const rid = (n) => hall.find((x) => x.resource.number === n)?.resource.id;
  const bk = (n, starts, minutes, over = {}) => ({
    id: uuid(),
    resource_id: rid(n),
    starts,
    ends: starts + minutes * MIN,
    status: 'confirmed',
    source: 'app',
    guest: { name: null, phone_masked: '+7 *** ***-41-07', user: true },
    amount: Math.round((minutes / 60) * 80000),
    prepay: 0,
    paid: 0,
    created: t - 2 * 60 * MIN,
    ...over,
  });
  const empty = scenario === 'empty';
  const bookings = empty
    ? []
    : [
        bk(2, round(t + 40 * MIN), 120, { source: 'phone', guest: { name: 'Сергей', phone_masked: '+7 *** ***-12-90', user: false } }),
        bk(4, round(t + 3 * 60 * MIN), 180, { prepay: 240000, paid: 240000 }),
        bk(6, round(t - 20 * MIN), 120, { status: 'reserved', source: 'phone', guest: { name: 'Ольга, день рождения', phone_masked: '+7 *** ***-88-15', user: false } }),
        bk(1, atLocal(today, 22 * 60), 120, { source: 'app' }),
        bk(5, atLocal(today, 20 * 60), 90, { source: 'staff', guest: { name: 'Турнир клуба', phone_masked: '+7 *** ***-00-03', user: false } }),
        bk(3, round(t - 3 * 60 * MIN), 90, { status: 'completed', source: 'app' }),
        bk(7, atLocal(today, 23 * 60), 120, { status: 'pending_payment', prepay: 160000, guest: { name: null, phone_masked: '+7 *** ***-56-31', user: true } }),
      ];
  // Партии пакетов гостей (money: bl.balance_lots): из приложения и с кассы; телефон +79123456789 — у гостя три пакета
  const lot = (over) => ({ id: uuid(), package_id: PACKAGES[0].id, title: PACKAGES[0].title, source: 'app', sale_id: null, idx: null, price_kopecks: 300000, minutes_total: 300, minutes_left: 300, created: t - 3 * 24 * 60 * MIN, expires: t + 27 * 24 * 60 * MIN, refunded: null, phone: '+79123456789', name: 'Павел', ...over });
  const lots = empty
    ? []
    : [
        lot({}),
        lot({ package_id: PACKAGES[1].id, title: PACKAGES[1].title, price_kopecks: 550000, minutes_total: 600, minutes_left: 420, created: t - 10 * 24 * 60 * MIN, expires: t + 50 * 24 * 60 * MIN }),
        lot({ package_id: PACKAGES[2].id, title: PACKAGES[2].title, source: 'pos', sale_id: uuid(), idx: 0, price_kopecks: 320000, minutes_total: 480, minutes_left: 480, created: t - 26 * 60 * MIN, expires: t + 29 * 24 * 60 * MIN }),
      ];
  return {
    bookings,
    lots,
    packages: PACKAGES.map((p) => ({ ...p })),
    staff: [
      { user_id: 'u-owner-0001', name: 'Андрей', phone: '+79000000001', role: 'owner', active: true, pin_set: true },
      { user_id: 'u-manager-0002', name: 'Ольга Р.', phone: '+79000000002', role: 'manager', active: true, pin_set: true },
      { user_id: 'u-recept-0003', name: 'Анна К.', phone: '+79000000003', role: 'reception', active: true, pin_set: true },
      { user_id: 'u-recept-0004', name: 'Игорь П.', phone: '+79000000004', role: 'reception', active: true, pin_set: false },
      { user_id: 'u-bar-0005', name: 'Дима С.', phone: '+79000000005', role: 'bar', active: true, pin_set: true },
    ],
    invites: [{ id: uuid(), phone: '+79120004417', role: 'reception', created_at: t - 26 * 60 * MIN, expires_at: t + 6 * 24 * 60 * MIN - 26 * 60 * MIN }],
  };
}

const mask = (phone) => `+7 *** ***-${phone.slice(-4, -2)}-${phone.slice(-2)}`;

/** @param {{ state: () => object, now: () => number, me: () => object, err: Function, ok: Function, emit: Function, audit: Function }} ctx */
export function m3Routes(ctx) {
  const { err, ok, now } = ctx;
  const S = () => ctx.state().m3;
  const can = (...roles) => roles.includes(ctx.me()?.role);
  const iso = (x) => new Date(x).toISOString();
  const hall = () => ctx.state().hall;
  const byRid = (id) => hall().find((x) => x.resource.id === id);

  /** Может ли запрашивающий отменить (№115) — как can_cancel сервера: управляющий и владелец — любую живую, ресепшн — phone/staff без предоплаты. */
  function canCancel(b) {
    if (!['pending_payment', 'confirmed', 'reserved'].includes(b.status)) return false;
    if (can('owner', 'manager')) return true;
    return can('reception') && ['phone', 'staff'].includes(b.source) && !(b.prepay > 0) && !(b.paid > 0);
  }

  function view(b) {
    const t = byRid(b.resource_id);
    if (b.status === 'confirmed' && now() >= b.starts - 15 * MIN) b.status = 'reserved';
    const hold = b.prepay ? 30 : 15;
    if (b.status === 'reserved' && now() > b.starts + hold * MIN) b.status = 'expired';
    const allowed = ['pending_payment', 'confirmed', 'reserved'].includes(b.status);
    return {
      id: b.id,
      club: { id: '0b6b8c1e-5a7d-4f0e-9c3a-2d1e4f5a6b7c', name: 'Клуб для разработки', timezone: 'Asia/Yekaterinburg' },
      resource: { id: b.resource_id, number: t?.resource.number, title: t?.resource.title, type: t?.resource.type },
      status: b.status,
      source: b.source,
      starts_at: iso(b.starts),
      ends_at: iso(b.ends),
      minutes: Math.round((b.ends - b.starts) / MIN),
      hold_until: iso(b.starts + hold * MIN),
      amount_kopecks: b.amount,
      prepayment_mode: b.prepay ? 'full' : 'none',
      prepayment_kopecks: b.prepay,
      paid_kopecks: b.paid,
      pay_until: b.status === 'pending_payment' ? iso(b.created + 15 * MIN) : null,
      payment_id: null,
      session_id: null,
      expire_reason: b.status === 'expired' ? 'no_show' : null,
      created_at: iso(b.created),
      cancel: { allowed, refund_kopecks: allowed ? b.paid : 0, free_until: b.paid ? iso(b.starts - 120 * MIN) : null },
      guest: b.guest,
      created_by: null,
      cancel_reason: b.cancel_reason ?? null,
      can_cancel: canCancel(b),
    };
  }

  /** Зал с ближайшей живой бронью стола (server/bookings nextBooking): { id, starts_at, ends_at, source, status } | null. */
  function withNextBooking(items) {
    return items.map((h) => {
      const next = S()
        .bookings.filter((b) => b.resource_id === h.resource.id && ['pending_payment', 'confirmed', 'reserved'].includes(b.status) && b.ends > now())
        .sort((a, b) => a.starts - b.starts)[0];
      return { ...h, next_booking: next ? { id: next.id, starts_at: iso(next.starts), ends_at: iso(next.ends), source: next.source, status: next.status } : null };
    });
  }

  const bookingEvent = (b, type) => ctx.emit('booking', { type, booking_id: b.id, resource_id: b.resource_id, status: b.status, starts_at: iso(b.starts), ends_at: iso(b.ends) });

  function lotView(l) {
    return {
      id: l.id,
      package_id: l.package_id,
      title: l.title,
      source: l.source,
      sale_id: l.sale_id,
      idx: l.idx,
      price_kopecks: l.price_kopecks,
      minutes_total: l.minutes_total,
      minutes_left: l.minutes_left,
      created_at: iso(l.created),
      expires_at: iso(l.expires),
      refunded_at: l.refunded ? iso(l.refunded) : null,
      guest: { name: l.name ?? null, phone_masked: mask(l.phone) },
    };
  }

  /** Отзыв партии (№118): только целиком и нетронутую; журнал manual.package_refund, тревога владельцу. */
  function revokeLot(l, reason) {
    if (l.refunded) return err(409, 'already_refunded');
    if (l.minutes_left < l.minutes_total) return err(409, 'package_used');
    l.refunded = now();
    ctx.audit('manual.package_refund', { reason, data: { lot_id: l.id, amount_kopecks: l.price_kopecks } });
    return null;
  }

  /** Рабочий день клуба 12:00–02:00, занятость — игры и сервис зала, брони, закрытые часы. */
  function availability(date) {
    const open = atLocal(date, 12 * 60);
    const close = atLocal(date, 26 * 60);
    return {
      club: { id: '0b6b8c1e-5a7d-4f0e-9c3a-2d1e4f5a6b7c', name: 'Клуб для разработки', timezone: 'Asia/Yekaterinburg', plan: null },
      date,
      from: iso(atLocal(date, 6 * 60)),
      to: iso(atLocal(date, 30 * 60)),
      open_at: iso(open),
      close_at: iso(close),
      now: iso(now()),
      step_minutes: 30,
      min_minutes: 60,
      max_minutes: 240,
      lead_minutes: 15,
      max_days: 30,
      rules: { prepayment: 'none', deposit_kopecks: 0, hold_minutes: 15, hold_prepaid_minutes: 30, free_cancel_minutes: 120 },
      resources: hall().map((h) => {
        const busy = [];
        if (h.session && date === localDate(now())) busy.push({ from: h.session.started_at, to: h.session.unlimited ? iso(now() + 60 * MIN) : iso(Date.parse(h.session.paid_until) + 2 * MIN), kind: 'session' });
        if (h.status === 'service' && h.until && date === localDate(now())) busy.push({ from: iso(now() - 10 * MIN), to: h.until, kind: 'service' });
        for (const b of S().bookings) {
          if (b.resource_id !== h.resource.id || !['pending_payment', 'confirmed', 'reserved', 'started'].includes(b.status)) continue;
          if (b.ends <= open || b.starts >= close) continue;
          busy.push({ from: iso(b.starts), to: iso(b.ends), kind: 'booking' });
        }
        return {
          id: h.resource.id,
          number: h.resource.number,
          type: h.resource.type,
          title: h.resource.title,
          plan: { x: null, y: null, rotation: null },
          busy: busy.sort((a, b) => Date.parse(a.from) - Date.parse(b.from)),
          free: [],
          rates: [{ from: iso(open), to: iso(close), per_hour_kopecks: 80000 }],
        };
      }),
    };
  }

  const staffOnly = (fn) => (m, b, q) => (can('owner', 'manager', 'reception') ? fn(m, b, q) : err(ctx.me() ? 403 : 401, ctx.me() ? 'forbidden' : 'unauthorized'));
  const ownerOnly = (fn) => (m, b, q) => (can('owner') ? fn(m, b, q) : err(403, 'forbidden'));
  const managerOnly = (fn) => (m, b, q) => (can('owner', 'manager') ? fn(m, b, q) : err(403, 'forbidden'));

  const routes = [
    ['GET', /^\/api\/clubs\/([^/]+)\/availability$/, (_m, _b, q) => ok(availability(q.get('date') || localDate(now())))],
    ['GET', /^\/api\/clubs\/([^/]+)\/bookings$/, staffOnly((_m, _b, q) => {
      const date = q.get('date') || localDate(now());
      const from = atLocal(date, 6 * 60);
      const to = atLocal(date, 30 * 60);
      return ok({ date, from: iso(from), to: iso(to), bookings: S().bookings.filter((b) => b.ends > from && b.starts < to).map(view) });
    })],
    ['POST', /^\/api\/clubs\/([^/]+)\/bookings$/, staffOnly((_m, b) => {
      const t = byRid(b.resource_id);
      if (!t) return err(400, 'bad_request');
      if (!String(b.name ?? '').trim() || !/^\+7\d{10}$/.test(b.phone ?? '')) return err(400, 'bad_request');
      const starts = Date.parse(b.starts_at);
      if (!Number.isFinite(starts) || ![60, 90, 120, 180, 240].includes(b.minutes)) return err(400, 'bad_request');
      const ends = starts + b.minutes * MIN;
      const day = availability(localDate(starts - 6 * 60 * MIN));
      const clash = day.resources.find((r) => r.id === b.resource_id).busy.some((x) => Date.parse(x.from) < ends && starts < Date.parse(x.to));
      if (clash) return err(409, 'booking_conflict');
      const nb = { id: uuid(), resource_id: b.resource_id, starts, ends, status: 'confirmed', source: b.source ?? 'phone', guest: { name: b.name.trim(), phone_masked: mask(b.phone), user: false }, amount: Math.round((b.minutes / 60) * 80000), prepay: 0, paid: 0, created: now() };
      S().bookings.push(nb);
      ctx.audit('booking.create', { resource_number: t.resource.number, data: { source: nb.source } });
      bookingEvent(nb, 'booking.created');
      return { status: 201, body: view(nb) };
    })],
    ['POST', /^\/api\/bookings\/([^/]+)\/cancel$/, staffOnly((m, b) => {
      const bk = S().bookings.find((x) => x.id === m[1]);
      if (!bk) return err(404, 'not_found');
      if (!String(b.reason ?? '').trim()) return err(400, 'reason_required');
      if (!['pending_payment', 'confirmed', 'reserved'].includes(view(bk).status)) return err(409, 'booking_not_active');
      // №115: ресепшн — только брони phone/staff без предоплаты
      if (!canCancel(bk)) return err(403, 'forbidden');
      const refund = bk.paid;
      Object.assign(bk, { status: 'canceled', cancel_reason: b.reason.trim() });
      ctx.audit('manual.booking_cancel', { resource_number: byRid(bk.resource_id)?.resource.number, reason: b.reason.trim() });
      bookingEvent(bk, 'booking.canceled');
      return ok({ ...view(bk), refund_kopecks: refund });
    })],
    ['POST', /^\/api\/bookings\/([^/]+)\/arrive$/, staffOnly((m) => {
      const bk = S().bookings.find((x) => x.id === m[1]);
      if (!bk) return err(404, 'not_found');
      const v = view(bk);
      if (v.status === 'expired') return err(409, 'booking_expired');
      if (!['confirmed', 'reserved'].includes(v.status)) return err(409, 'booking_not_active');
      bk.status = 'started';
      ctx.audit('booking.arrive', { resource_number: byRid(bk.resource_id)?.resource.number });
      bookingEvent(bk, 'booking.started');
      return ok(view(bk));
    })],

    // ---------- персонал (владелец, №111) ----------
    ['GET', /^\/api\/clubs\/([^/]+)\/staff$/, ownerOnly(() => {
      const t = now();
      return ok({
        staff: S().staff.map((s) => ({ user_id: s.user_id, name: s.name, phone_masked: mask(s.phone), role: s.role, active: s.active, pin_set: s.pin_set })),
        invites: S().invites.filter((i) => i.expires_at > t && !i.revoked).map((i) => ({ id: i.id, phone_masked: mask(i.phone), role: i.role, created_at: iso(i.created_at), expires_at: iso(i.expires_at) })),
      });
    })],
    ['POST', /^\/api\/clubs\/([^/]+)\/staff$/, ownerOnly((_m, b) => {
      if (!/^\+7\d{10}$/.test(b.phone ?? '')) return err(400, 'bad_request');
      if (!['manager', 'reception', 'installer', 'bar'].includes(b.role)) return err(400, 'bad_request');
      if (S().staff.some((s) => s.active && s.phone === b.phone)) return err(409, 'duplicate');
      let inv = S().invites.find((i) => i.phone === b.phone && !i.revoked);
      if (inv) Object.assign(inv, { role: b.role, expires_at: now() + 7 * 24 * 60 * MIN });
      else {
        inv = { id: uuid(), phone: b.phone, role: b.role, created_at: now(), expires_at: now() + 7 * 24 * 60 * MIN };
        S().invites.unshift(inv);
      }
      ctx.audit('staff.invite', { data: { role: b.role } });
      return { status: 201, body: { id: inv.id, phone_masked: mask(inv.phone), role: inv.role, created_at: iso(inv.created_at), expires_at: iso(inv.expires_at) } };
    })],
    ['PATCH', /^\/api\/clubs\/([^/]+)\/staff\/([^/]+)$/, ownerOnly((m, b) => {
      const s = S().staff.find((x) => x.user_id === m[2] && x.active);
      if (!s) return err(404, 'not_found');
      if (!['manager', 'reception', 'installer', 'bar'].includes(b.role)) return err(400, 'bad_request');
      if (s.role === 'owner' || s.user_id === ctx.me()?.id) return err(403, 'forbidden');
      s.role = b.role;
      ctx.audit('staff.role', { data: { role: b.role } });
      return ok({ ok: true, user_id: s.user_id, role: s.role });
    })],
    ['DELETE', /^\/api\/clubs\/([^/]+)\/staff\/invites\/([^/]+)$/, ownerOnly((m) => {
      const i = S().invites.find((x) => x.id === m[2]);
      if (!i) return err(404, 'not_found');
      i.revoked = true;
      ctx.audit('staff.invite_revoked', {});
      return ok({ ok: true });
    })],
    ['DELETE', /^\/api\/clubs\/([^/]+)\/staff\/([^/]+)$/, ownerOnly((m) => {
      const s = S().staff.find((x) => x.user_id === m[2] && x.active);
      if (!s) return err(404, 'not_found');
      if (s.role === 'owner' || s.user_id === ctx.me()?.id) return err(403, 'forbidden');
      Object.assign(s, { active: false, pin_set: false });
      ctx.audit('staff.revoke', {});
      return ok({ ok: true, tokens_revoked: 2 });
    })],

    // ---------- пакеты часов (управляющий, №112) ----------
    ['GET', /^\/api\/clubs\/([^/]+)\/packages$/, () => ok(S().packages.filter((p) => p.active).map((p) => ({ ...p, club_id: '0b6b8c1e-5a7d-4f0e-9c3a-2d1e4f5a6b7c', hours: p.minutes / 60 })))],
    ['POST', /^\/api\/clubs\/([^/]+)\/packages$/, managerOnly((_m, b) => {
      if (!String(b.reason ?? '').trim()) return err(400, 'reason_required');
      const title = String(b.title ?? '').trim();
      if (!title || title.length > 100 || !Number.isInteger(b.hours) || b.hours < 1 || !Number.isSafeInteger(b.price_kopecks) || b.price_kopecks < 100 || !Number.isInteger(b.valid_days) || b.valid_days < 1 || b.valid_days > 730) return err(400, 'bad_request');
      const p = { id: uuid(), title, minutes: b.hours * 60, price_kopecks: b.price_kopecks, valid_days: b.valid_days, active: true };
      S().packages.push(p);
      ctx.audit('tariff.package_created', { reason: b.reason.trim(), data: { title } });
      return { status: 201, body: { ...p, hours: b.hours } };
    })],
    ['POST', /^\/api\/packages\/([^/]+)\/archive$/, managerOnly((m, b) => {
      if (!String(b.reason ?? '').trim()) return err(400, 'reason_required');
      const p = S().packages.find((x) => x.id === m[1] && x.active);
      if (!p) return err(404, 'not_found');
      p.active = false;
      ctx.audit('tariff.package_archived', { reason: b.reason.trim(), data: { title: p.title } });
      return ok({ ok: true });
    })],

    // ---------- возврат пакета (№118): партии по точному телефону, из приложения — /lots/{id}/refund, с кассы — возврат продажи
    ['GET', /^\/api\/clubs\/([^/]+)\/package-lots$/, managerOnly((_m, _b, q) => {
      const phone = q.get('phone') ?? '';
      if (!/^\+7\d{10}$/.test(phone)) return err(400, 'bad_request');
      return ok(S().lots.filter((l) => l.phone === phone).sort((a, b) => b.created - a.created).map(lotView));
    })],
    ['POST', /^\/api\/packages\/lots\/([^/]+)\/refund$/, managerOnly((m, b) => {
      const l = S().lots.find((x) => x.id === m[1]);
      if (!l) return err(404, 'not_found');
      if (!String(b.reason ?? '').trim()) return err(400, 'reason_required');
      if (l.source !== 'app') return err(400, 'bad_request');
      const bad = revokeLot(l, b.reason.trim());
      if (bad) return bad;
      return ok({ lot_id: l.id, payment_id: uuid(), amount_kopecks: l.price_kopecks, refund_id: uuid() });
    })],
    ['POST', /^\/api\/pos\/sales\/([^/]+)\/refund$/, managerOnly((m, b) => {
      if (!String(b.reason ?? '').trim()) return err(400, 'reason_required');
      const picked = (b.packages ?? []).map((idx) => S().lots.find((x) => x.sale_id === m[1] && x.idx === idx));
      if (!picked.length || picked.some((x) => !x)) return err(404, 'not_found');
      for (const l of picked) {
        const bad = revokeLot(l, b.reason.trim());
        if (bad) return bad;
      }
      const amount = picked.reduce((a, l) => a + l.price_kopecks, 0);
      if (ctx.state().m2.shift) ctx.state().m2.shift.cash_refunds_kopecks += amount;
      return { status: 201, body: { pos_refund_id: uuid(), sale_id: m[1], refund_id: uuid(), status: 'succeeded', amount_kopecks: amount, items: picked.map((l) => ({ idx: l.idx, package_id: l.package_id, lot_id: l.id, amount_kopecks: l.price_kopecks })), receipt_id: uuid(), receipt_status: 'pending', created_at: iso(now()) } };
    })],

    // ---------- депозит наличными для «Без лимита» (№87, №112) ----------
    ['POST', /^\/api\/reception\/deposits$/, staffOnly((_m, b) => {
      const t = byRid(b.resource_id);
      if (!t) return err(404, 'not_found');
      if (!Number.isSafeInteger(b.amount_kopecks) || b.amount_kopecks <= 0) return err(400, 'bad_request');
      if (!ctx.state().m2.shift) return err(409, 'shift_closed');
      if (t.status !== 'free' || t.session) return err(409, 'table_busy');
      const received = b.received_kopecks ?? b.amount_kopecks;
      if (received < b.amount_kopecks) return err(400, 'bad_request');
      // Игра до исчерпания депозита по тарифу 800 ₽/ч
      const minutes = Math.floor((b.amount_kopecks / 80000) * 60);
      const s = { id: uuid(), status: 'active', started_at: iso(now()), paid_until: iso(now() + minutes * MIN), unlimited: true, deposit_kopecks: b.amount_kopecks };
      Object.assign(t, { status: 'busy', session: s });
      ctx.state().m2.shift.cash_sales_kopecks += b.amount_kopecks;
      ctx.audit('reception.deposit', { resource_number: t.resource.number, data: { amount_kopecks: b.amount_kopecks } });
      ctx.emit('hall', t);
      return { status: 201, body: { payment_id: uuid(), session_id: s.id, change_kopecks: received - b.amount_kopecks, receipt_id: uuid(), paid_until: s.paid_until, minutes } };
    })],
  ];

  return { routes, packages: () => S().packages, withNextBooking };
}
