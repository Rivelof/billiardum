/*
 * BL_MOCK_MARKER — заглушка API программы клуба по контракту M1 (§4–§7), только для разработки (VITE_MOCK=1).
 * Сценарии: ?mock=reception (по умолчанию) | owner | manager | anon | empty | broken | terminal;
 * M2 (mock/m2.js): pos | noshift (смены нет) | kktoff (касса ККТ не на связи) | bar (бармен);
 * M3 (mock/m3.js): брони, персонал, пакеты и депозит — в каждом сценарии (empty — без броней)
 */

import { m2Routes, m2State, m2Tick } from './m2.js';
import { m3Routes, m3State } from './m3.js';

const MIN = 60_000;
const CLUB_ID = '0b6b8c1e-5a7d-4f0e-9c3a-2d1e4f5a6b7c';
const TZ = 'Asia/Yekaterinburg';
const rid = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const uuid = () => globalThis.crypto.randomUUID();

const STAFF = {
  owner: { id: 'u-owner-0001', name: 'Андрей', phone_masked: '+7 *** ***-00-01', role: 'owner' },
  manager: { id: 'u-manager-0002', name: 'Ольга Р.', phone_masked: '+7 *** ***-00-02', role: 'manager' },
  reception: { id: 'u-recept-0003', name: 'Анна К.', phone_masked: '+7 *** ***-00-03', role: 'reception' },
  reception2: { id: 'u-recept-0004', name: 'Игорь П.', phone_masked: '+7 *** ***-00-04', role: 'reception' },
  bar: { id: 'u-bar-0005', name: 'Дима С.', phone_masked: '+7 *** ***-00-05', role: 'bar' },
};

const TYPES = { pyramid: ['billiard_pyramid', 'Пирамида 12 футов'], pool: ['billiard_pool', 'Пул 9 футов'] };

function freshState(scenario, t) {
  const table = (n, kind, status, extra = {}) => ({
    resource: { id: rid(n), number: n, type: TYPES[kind][0], title: TYPES[kind][1] },
    status,
    session: null,
    until: null,
    ...extra,
    device: { id: `d1000000-0000-4000-8000-00000000000${n}`, online: true, rssi: -55 - n * 2, fw: '1.0.0', caps: ['relay', 'led', 'buzzer', 'current'], ...extra.device },
  });
  const session = (n, startMin, leftMin, over = {}) => ({
    id: `s-${n}-${uuid().slice(0, 8)}`,
    status: leftMin !== null && leftMin <= 5 ? 'ending' : 'active',
    started_at: new Date(t - startMin * MIN).toISOString(),
    paid_until: new Date(t + (leftMin ?? 120) * MIN).toISOString(),
    unlimited: leftMin === null,
    ...over,
  });
  const empty = scenario === 'empty';
  const hall = [
    table(1, 'pyramid', 'busy', { session: session(1, 80, 40) }),
    table(2, 'pyramid', 'free'),
    table(3, 'pyramid', 'busy', { session: session(3, 116, 4) }),
    table(4, 'pyramid', empty ? 'free' : 'pending'),
    table(5, 'pyramid', 'service', { until: new Date(t + 20 * MIN).toISOString() }),
    table(6, 'pool', empty ? 'free' : 'pending', { device: { online: true, rssi: -67, fw: '1.0.0', caps: ['relay', 'led'] } }),
    table(7, 'pool', 'busy', { session: session(7, 35, null) }),
    table(8, 'pool', 'offline', { device: { online: false, rssi: null, fw: '1.0.0', caps: ['relay', 'led', 'buzzer', 'current'] } }),
  ];
  const requests = empty
    ? []
    : [
        { id: uuid(), status: 'waiting', kind: 'start', resource_number: 6, minutes: 60, amount_kopecks: 80000, created_at: new Date(t - 9 * MIN).toISOString(), expires_at: new Date(t + 6 * MIN).toISOString(), guest_masked_phone: '+7 *** ***-71-08' },
        { id: uuid(), status: 'waiting', kind: 'start', resource_number: 4, minutes: 120, amount_kopecks: 160000, created_at: new Date(t - 2 * MIN).toISOString(), expires_at: new Date(t + 13 * MIN).toISOString(), guest_masked_phone: '+7 *** ***-45-12' },
      ];
  const alarms = [
    { id: uuid(), type: 'bypass_detected', level: 'critical', resource_number: 2, created_at: new Date(t - 6 * MIN).toISOString() },
    { id: uuid(), type: 'device_offline', level: 'critical', resource_number: 8, created_at: new Date(t - 14 * MIN).toISOString() },
    { id: uuid(), type: 'manual_action', level: 'important', resource_number: 5, created_at: new Date(t - 3 * MIN).toISOString() },
  ];
  // Роль — по сценарию; «kktoff-owner» — касса не на связи, вошёл владелец
  const asRole = scenario?.split('-')[1];
  const role = ['owner', 'manager', 'bar'].includes(scenario) ? scenario : ['owner', 'manager'].includes(asRole) ? asRole : 'reception';
  return {
    scenario,
    user: scenario === 'anon' ? null : { ...STAFF[role] },
    hall,
    requests,
    alarms,
    audit: makeAudit(t),
    revenue: { sbp: 1248000, card: 486000, cash: 320000, card_terminal: 160000 },
    nextRequestAt: t + 45_000,
    m2: m2State(scenario, t, hall),
    m3: m3State(scenario, t, hall),
  };
}

function makeAudit(t) {
  const items = [];
  let seq = 1284;
  const push = (minAgo, action, extra = {}) => {
    items.push({
      id: uuid(),
      seq: seq--,
      created_at: new Date(t - minAgo * MIN).toISOString(),
      action,
      actor_type: extra.actor_type ?? 'system',
      actor_id: extra.actor?.id ?? null,
      actor_name: extra.actor?.name ?? null,
      resource_number: extra.n ?? null,
      reason: extra.reason ?? null,
      data: extra.data ?? {},
      hash: Array.from({ length: 64 }, (_, i) => '0123456789abcdef'[(seq * 7 + i * 13) % 16]).join(''),
    });
  };
  push(2, 'reception.accept', { actor_type: 'staff', actor: STAFF.reception, n: 3, data: { method: 'cash', amount_kopecks: 40000 } });
  push(3, 'service.start', { actor_type: 'staff', actor: STAFF.reception, n: 5, reason: 'Протираем сукно после пролитого напитка', data: { minutes: 30, reason_code: 'cleaning' } });
  push(6, 'alarm.raised', { n: 2, data: { type: 'bypass_detected' } });
  push(9, 'session.extend', { actor_type: 'guest', n: 1, data: { paid_until: new Date(t + 40 * MIN).toISOString() } });
  push(9, 'payment.succeeded', { actor_type: 'guest', n: 1, data: { method: 'sbp', amount_kopecks: 80000 } });
  push(14, 'alarm.raised', { n: 8, data: { type: 'device_offline' } });
  push(21, 'manual.extend_free', { actor_type: 'staff', actor: STAFF.manager, n: 1, reason: 'Свет мигнул из-за сбоя питания, компенсировали 15 минут', data: { minutes: 15 } });
  push(35, 'session.start', { actor_type: 'system', n: 7, data: { paid_until: new Date(t + 85 * MIN).toISOString() } });
  push(35, 'payment.succeeded', { actor_type: 'guest', n: 7, data: { method: 'card', amount_kopecks: 160000 } });
  push(48, 'reception.decline', { actor_type: 'staff', actor: STAFF.reception, n: 2, data: { reason_code: 'guest_left', amount_kopecks: 80000 } });
  push(62, 'auth.pin_switch', { actor_type: 'staff', actor: STAFF.reception });
  push(80, 'session.start', { n: 1, data: { paid_until: new Date(t + 25 * MIN).toISOString() } });
  push(80, 'payment.succeeded', { actor_type: 'guest', n: 1, data: { method: 'sbp', amount_kopecks: 120000 } });
  push(95, 'service.stop', { actor_type: 'staff', actor: STAFF.reception2, n: 6, data: { reason_code: 'repair' } });
  push(116, 'session.start', { n: 3, data: { paid_until: new Date(t + 4 * MIN).toISOString() } });
  push(116, 'reception.accept', { actor_type: 'staff', actor: STAFF.reception2, n: 3, data: { method: 'card_terminal', amount_kopecks: 160000 } });
  push(140, 'device.event', { actor_type: 'device', n: 4, data: { type: 'boot' } });
  push(180, 'auth.staff_login', { actor_type: 'staff', actor: STAFF.reception2 });
  return items;
}

const PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';

export function createBackend(storage, now = () => Date.now()) {
  let state = storage.load() ?? freshState('reception', now());
  // Состояние из sessionStorage до M2 — дополняем данными кассы, бара и смен
  if (!state.m2?.catalog) state.m2 = m2State(state.scenario, now(), state.hall);
  if (!state.m3?.lots) state.m3 = m3State(state.scenario, now(), state.hall);
  const listeners = new Set();
  const save = () => storage.save(state);
  const emit = (name, data) => {
    for (const fn of listeners) fn(name, data);
  };
  const err = (status, code) => ({ status, body: { error: code } });
  const ok = (body) => ({ status: 200, body });
  const me = () => state.user;
  const table = (id) => state.hall.find((x) => x.resource.id === id);
  const byNumber = (n) => state.hall.find((x) => x.resource.number === n);
  const audit = (action, extra) => {
    const head = state.audit[0]?.seq ?? 0;
    state.audit.unshift({ id: uuid(), seq: head + 1, created_at: new Date(now()).toISOString(), action, actor_type: 'staff', actor_id: me()?.id, actor_name: me()?.name, hash: uuid().replace(/-/g, ''), data: {}, ...extra });
  };

  // Новые заявки приходят сами, чтобы слышать звук очереди
  function tick() {
    m2Tick(m2ctx);
    if (state.scenario === 'empty' || !state.user) return;
    if (now() < state.nextRequestAt) return;
    const free = state.hall.find((x) => x.status === 'free' && !x.session);
    state.nextRequestAt = now() + 60_000;
    if (!free || state.requests.length >= 4) return;
    free.status = 'pending';
    state.requests.push({ id: uuid(), status: 'waiting', kind: 'start', resource_number: free.resource.number, minutes: 120, amount_kopecks: 160000, created_at: new Date(now()).toISOString(), expires_at: new Date(now() + 15 * MIN).toISOString(), guest_masked_phone: '+7 *** ***-30-55' });
    save();
    emit('hall', free);
    emit('reception_request', { state: 'new' });
  }

  const routes = [
    ['GET', /^\/api\/me$/, () => (me() ? ok({ user: me(), clubs: [{ club_id: CLUB_ID, role: me().role, name: 'Клуб для разработки', timezone: TZ }] }) : err(401, 'unauthorized'))],
    ['POST', /^\/api\/auth\/dev$/, (_m, b) => {
      if (!/^\+7\d{10}$/.test(b?.phone ?? '')) return err(400, 'bad_request');
      const role = b.phone.endsWith('01') ? 'owner' : b.phone.endsWith('02') ? 'manager' : b.phone.endsWith('05') ? 'bar' : 'reception';
      state.user = { ...STAFF[role] };
      return ok({ token: 'mock-staff', user: state.user });
    }],
    ['POST', /^\/api\/auth\/bot-link$/, (_m, b) => ok({ nonce: 'n1', deep_link: b.channel === 'telegram' ? 'https://t.me/billiardum_bot?start=n1' : 'https://max.ru/billiardum_bot?start=n1', expires_at: new Date(now() + 5 * MIN).toISOString() })],
    ['GET', /^\/api\/auth\/bot-link\/(.+)$/, () => {
      state.user = { ...STAFF.reception };
      return ok({ status: 'done' });
    }],
    ['POST', /^\/api\/auth\/logout$/, () => {
      state.user = null;
      return ok({ ok: true });
    }],
    ['POST', /^\/api\/staff\/terminal$/, (_m, b) => (me() && ['owner', 'manager'].includes(me().role) && b.club_id === CLUB_ID ? ok({ terminal_token: `term-${uuid()}` }) : err(403, 'forbidden'))],
    // Как у core (§14): GET /api/staff/terminal → [{ user_id, name, role, phone_masked, pin_set }]
    ['GET', /^\/api\/staff\/terminal$/, () => ok([STAFF.reception, STAFF.reception2, STAFF.bar, STAFF.manager, STAFF.owner].map((u) => ({ user_id: u.id, name: u.name, role: u.role, phone_masked: u.phone_masked, pin_set: true })))],
    ['PUT', /^\/api\/staff\/pin$/, (_m, b) => (/^\d{4,6}$/.test(b.pin ?? '') ? ok({ ok: true }) : err(400, 'bad_request'))],
    ['PATCH', /^\/api\/me$/, (_m, b) => {
      if (!me()) return err(401, 'unauthorized');
      if (typeof b.name === 'string') state.user.name = b.name.slice(0, 60);
      return ok({ user: me() });
    }],
    ['POST', /^\/api\/resources\/([^/]+)\/identify$/, (m) => (table(m[1]) ? ok({ ok: true }) : err(404, 'not_found'))],
    ['POST', /^\/api\/clubs\/([^/]+)\/devices\/bind$/, (_m, b) => {
      if (!['owner', 'installer'].includes(me()?.role)) return err(403, 'forbidden');
      if (!/^[0-9a-f-]{36}$/.test(b.device_id ?? '') || !/^[A-Za-z0-9-]{6,64}$/.test(b.claim_code ?? '')) return err(400, 'bad_request');
      return ok({ bind_until: new Date(now() + 30 * MIN).toISOString() });
    }],
    ['POST', /^\/api\/staff\/pin$/, (_m, b) => {
      if (b.pin !== '1234') return err(401, 'unauthorized');
      const u = Object.values(STAFF).find((x) => x.id === b.user_id);
      if (!u) return err(404, 'not_found');
      state.user = { ...u };
      audit('auth.pin_switch', {});
      return ok({ token: 'mock-pin' });
    }],
    // next_booking у стола (№120) — ближайшая живая бронь, как в ответе зала сервера
    ['GET', /^\/api\/clubs\/([^/]+)\/hall$/, () => (me() ? ok(m3.withNextBooking(state.hall)) : err(401, 'unauthorized'))],
    ['GET', /^\/api\/clubs\/([^/]+)\/reception\/requests$/, () => (me() ? ok(state.requests) : err(401, 'unauthorized'))],
    ['POST', /^\/api\/reception\/requests\/([^/]+)\/accept$/, (m, b) => {
      const r = state.requests.find((x) => x.id === m[1]);
      if (!r) return err(404, 'not_found');
      if (b.method === 'cash' && !(b.received_kopecks >= r.amount_kopecks)) return err(400, 'bad_request');
      // M2 (№83): без открытой смены наличные не принимаются; наличные заявки — в ожидаемую сумму смены
      if (b.method === 'cash' && !state.m2.shift) return err(409, 'shift_closed');
      if (b.method === 'cash') state.m2.shift.cash_sales_kopecks += r.amount_kopecks;
      state.requests = state.requests.filter((x) => x !== r);
      const t = byNumber(r.resource_number);
      const s = { id: uuid(), status: 'active', started_at: new Date(now()).toISOString(), paid_until: new Date(now() + (r.minutes ?? 120) * MIN).toISOString(), unlimited: r.minutes === null };
      Object.assign(t, { status: 'busy', session: s });
      state.revenue[b.method] += r.amount_kopecks;
      audit('reception.accept', { resource_number: r.resource_number, data: { method: b.method, amount_kopecks: r.amount_kopecks } });
      emit('hall', t);
      return ok({ payment_id: uuid(), change_kopecks: b.method === 'cash' ? b.received_kopecks - r.amount_kopecks : 0, session_id: s.id });
    }],
    ['POST', /^\/api\/reception\/requests\/([^/]+)\/decline$/, (m, b) => {
      const r = state.requests.find((x) => x.id === m[1]);
      if (!r) return err(404, 'not_found');
      if (!b.reason_code) return err(400, 'reason_required');
      state.requests = state.requests.filter((x) => x !== r);
      const t = byNumber(r.resource_number);
      Object.assign(t, { status: 'free', session: null });
      audit('reception.decline', { resource_number: r.resource_number, data: { reason_code: b.reason_code, amount_kopecks: r.amount_kopecks } });
      emit('hall', t);
      return ok({ ok: true });
    }],
    ['POST', /^\/api\/resources\/([^/]+)\/service$/, (m, b) => {
      const t = table(m[1]);
      if (!t) return err(404, 'not_found');
      if (!b.reason_text || !b.reason_code) return err(400, 'reason_required');
      if (t.status !== 'free') return err(409, 'table_busy');
      if (t.device?.online === false) return err(409, 'table_offline');
      const until = new Date(now() + b.minutes * MIN).toISOString();
      Object.assign(t, { status: 'service', until });
      audit('service.start', { resource_number: t.resource.number, reason: b.reason_text, data: { minutes: b.minutes, reason_code: b.reason_code } });
      emit('hall', t);
      return ok({ ok: true, until });
    }],
    ['POST', /^\/api\/resources\/([^/]+)\/service\/stop$/, (m) => {
      const t = table(m[1]);
      if (!t) return err(404, 'not_found');
      Object.assign(t, { status: 'free', until: null });
      audit('service.stop', { resource_number: t.resource.number });
      emit('hall', t);
      return ok({ ok: true });
    }],
    ['POST', /^\/api\/sessions\/([^/]+)\/extend-free$/, (m, b) => {
      if (!['owner', 'manager'].includes(me()?.role)) return err(403, 'forbidden');
      if (!b.reason_text) return err(400, 'reason_required');
      const t = state.hall.find((x) => x.session?.id === m[1]);
      if (!t) return err(404, 'not_found');
      t.session.paid_until = new Date(Date.parse(t.session.paid_until) + b.minutes * MIN).toISOString();
      t.session.status = 'active';
      audit('manual.extend_free', { resource_number: t.resource.number, reason: b.reason_text, data: { minutes: b.minutes } });
      emit('hall', t);
      return ok(t.session);
    }],
    ['GET', /^\/api\/clubs\/([^/]+)\/now$/, () => ok({ hall: m3.withNextBooking(state.hall), revenue_today_kopecks: state.revenue, alarms_open: state.alarms.length })],
    ['GET', /^\/api\/clubs\/([^/]+)\/alarms$/, () => ok(state.alarms)],
    ['POST', /^\/api\/alarms\/([^/]+)\/ack$/, (m) => {
      const a = state.alarms.find((x) => x.id === m[1]);
      if (!a) return err(404, 'not_found');
      state.alarms = state.alarms.filter((x) => x !== a);
      audit('alarm.ack', { resource_number: a.resource_number, data: { type: a.type } });
      return ok({ ok: true });
    }],
    ['GET', /^\/api\/clubs\/([^/]+)\/audit\/verify$/, () => {
      if (me()?.role !== 'owner') return err(403, 'forbidden');
      if (state.scenario === 'broken') return ok({ ok: false, broken_seq: 512, head_hash: state.audit[0].hash, count: 1284 });
      return ok({ ok: true, broken_seq: null, head_hash: state.audit[0].hash, count: state.audit[0].seq });
    }],
    ['GET', /^\/api\/clubs\/([^/]+)\/audit$/, (_m, _b, q) => {
      let list = state.audit;
      const from = q.get('from');
      const to = q.get('to');
      if (from) list = list.filter((x) => x.created_at >= from);
      if (to) list = list.filter((x) => x.created_at <= to);
      const action = q.get('action');
      if (action) {
        const pats = action.split(',');
        list = list.filter((x) => pats.some((p) => (p.endsWith('*') ? x.action.startsWith(p.slice(0, -1)) : x.action === p)));
      }
      const res = q.get('resource');
      if (res) list = list.filter((x) => rid(x.resource_number) === res);
      const actor = q.get('actor');
      if (actor) list = list.filter((x) => x.actor_id === actor);
      const start = Number(q.get('cursor') ?? 0);
      const page = list.slice(start, start + 12);
      return ok({ items: page, next_cursor: start + 12 < list.length ? String(start + 12) : null });
    }],
  ];

  const m2ctx = {
    state: () => state,
    now,
    emit,
    save,
    me,
    err,
    ok,
    byNumber,
    audit,
    staffById: (id) => Object.values(STAFF).find((u) => u.id === id),
    approvers: () => [STAFF.manager, STAFF.owner].map((u) => ({ user_id: u.id, name: u.name, role: u.role })),
    packages: () => state.m3.packages,
  };
  routes.push(...m2Routes(m2ctx));
  const m3 = m3Routes({ state: () => state, now, me, err, ok, emit, audit });
  routes.push(...m3.routes);

  async function handle(method, url) {
    tick();
    const u = new URL(url.href);
    for (const [m, re, fn] of routes) {
      if (m !== method) continue;
      const match = re.exec(u.pathname);
      if (match) {
        const res = fn(match, url.body ?? {}, u.searchParams);
        save();
        return res;
      }
    }
    if (method === 'GET' && /\/qr-stickers\.pdf$/.test(u.pathname)) return { status: 200, pdf: PDF };
    return err(404, 'not_found');
  }

  return {
    handle,
    scenario(name) {
      state = freshState(name, now());
      save();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    tick,
    get state() {
      return state;
    },
  };
}
