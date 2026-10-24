/*
 * BL_MOCK_MARKER — заглушка M5.3 «Подписка клубов» (только VITE_MOCK=1). Формы ответов — server/billing/README.md.
 *
 * Сценарии ?mock=: billing — пробный период, осталось 5 дней, карты нет (плашка «Пробный период заканчивается…»);
 * billing-active — оплачено, карта и автоплатёж, история счетов; billing-overdue — списание не прошло
 * (на карте не хватило денег), плашка заметнее; billing-manager — то же у управляющего (только состояние);
 * billing-off — ключей магазина платформы нет (503 billing_unavailable);
 * platform-billing — администратор платформы (он же владелец клуба разработки): «Клубы и подписки», клубы-заглушки;
 * platform-billing-operator — оператор платформы, только чтение.
 * В остальных сценариях — пробный период, до конца 40 дней: плашки нет.
 *
 * Страница ЮKassa не открывается: confirmation_url ведёт на /club/subscription, через 5 с карта «привязана»
 * (MasterCard •• 4477), открытый счёт оплачен.
 */

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const OFFSET = 5 * 60 * MIN; // Asia/Yekaterinburg, без перехода на летнее время
const uuid = () => globalThis.crypto.randomUUID();
const iso = (t) => (t === null || t === undefined ? null : new Date(t).toISOString());
/** Местная полночь клуба через n суток от t. */
const midnight = (t, n = 0) => Math.floor((t + OFFSET) / DAY) * DAY - OFFSET + n * DAY;
const dateOf = (t) => new Date(t + OFFSET).toISOString().slice(0, 10);
const addMonth = (t) => {
  const d = new Date(t + OFFSET);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime() - OFFSET;
};

const PLAN = { id: 'bf000000-0000-4000-8000-000000000001', code: 'club', title: 'Клуб', price_per_table_kopecks: 79000, trial_days: 60, active: true };
const CARD = { mask: '•• 4477', type: 'MasterCard', expiry: '12/30' };

function invoice(start, tables, price, extra = {}) {
  const end = addMonth(start);
  return {
    id: uuid(),
    period_start_at: start,
    period_start: dateOf(start),
    period_end: dateOf(end),
    period_end_at: end,
    tables,
    price_per_table_kopecks: price,
    amount_kopecks: tables * price,
    status: 'paid',
    paid_at: start + 3 * MIN,
    paid_via: 'card',
    receipt: { status: 'succeeded', email: 'owner@club.example' },
    document: null,
    attempts: 1,
    next_attempt_at: null,
    last_error: null,
    ...extra,
  };
}

/** Подписка клуба: { trial_until, paid_until, card, autopay, receipt_email, personal, invoices, pending }. */
function sub(t, kind, tables = 8) {
  const price = PLAN.price_per_table_kopecks;
  if (kind === 'trial') return { trial_until: midnight(t, 5), paid_until: null, card: null, autopay: false, receipt_email: null, personal: null, invoices: [], pending: null };
  if (kind === 'trial-long') return { trial_until: midnight(t, 40), paid_until: null, card: null, autopay: false, receipt_email: null, personal: null, invoices: [], pending: null };
  if (kind === 'trial-card') return { trial_until: midnight(t, 30), paid_until: null, card: { ...CARD, mask: '•• 1024', type: 'Mir' }, autopay: true, receipt_email: 'club3@club.example', personal: null, invoices: [], pending: null };
  if (kind === 'active') {
    const p2 = midnight(t, -10);
    const p1 = midnight(p2 - 20 * DAY, 0) - 10 * DAY;
    const i1 = invoice(p1, tables - 1, price);
    const i2 = invoice(i1.period_end_at, tables, price);
    return { trial_until: p1, paid_until: i2.period_end_at, card: { ...CARD }, autopay: true, receipt_email: 'owner@club.example', personal: null, invoices: [i2, i1], pending: null };
  }
  if (kind === 'overdue') {
    const due = midnight(t, -4);
    const prevStart = due - 30 * DAY;
    const paid = invoice(prevStart, tables, price);
    paid.period_end_at = due;
    paid.period_end = dateOf(due);
    const open = invoice(due, tables, price, { status: 'open', paid_at: null, paid_via: null, receipt: null, attempts: 2, next_attempt_at: t + 2 * DAY + 3 * 60 * MIN, last_error: 'insufficient_funds' });
    return { trial_until: prevStart, paid_until: due, card: { ...CARD }, autopay: true, receipt_email: 'owner@club.example', personal: null, invoices: [open, paid], pending: null };
  }
  if (kind === 'unpaid') {
    const due = midnight(t, -18);
    const open = invoice(due, tables, 59000, { status: 'open', paid_at: null, paid_via: null, receipt: null, attempts: 0, next_attempt_at: null, last_error: 'card_required' });
    return { trial_until: due, paid_until: null, card: null, autopay: false, receipt_email: null, personal: { price: 59000, reason: 'Пилотный клуб' }, invoices: [open], pending: null };
  }
  if (kind === 'manual') {
    const start = midnight(t, -8);
    const i1 = invoice(start, tables, price, { paid_via: 'manual', receipt: null, document: '1842', paid_at: start + DAY });
    return { trial_until: start, paid_until: i1.period_end_at, card: null, autopay: false, receipt_email: null, personal: null, invoices: [i1], pending: null };
  }
  // canceled: клуб вернулся в тестовый режим
  return { trial_until: midnight(t, -3), paid_until: null, card: null, autopay: false, receipt_email: null, personal: null, invoices: [], pending: null };
}

export function billingState(scenario, t) {
  const sc = String(scenario ?? '');
  const kind = sc === 'billing' ? 'trial' : sc === 'billing-active' ? 'active' : ['billing-overdue', 'billing-manager', 'platform-billing', 'platform-billing-operator'].includes(sc) ? 'overdue' : 'trial-long';
  const platform = sc.startsWith('platform-billing');
  return {
    off: sc === 'billing-off',
    dev: sub(t, kind),
    // Клубы-заглушки только для экрана платформы (в проде — реальные клубы)
    others: platform
      ? [
          { club_id: 'bc000000-0000-4000-8000-000000000002', name: 'Второй клуб (заглушка)', city: 'Пермь', mode: 'live', tables: 6, sub: sub(t, 'active', 6) },
          { club_id: 'bc000000-0000-4000-8000-000000000003', name: 'Третий клуб (заглушка)', city: 'Екатеринбург', mode: 'live', tables: 4, sub: sub(t, 'trial-card', 4) },
          { club_id: 'bc000000-0000-4000-8000-000000000004', name: 'Четвёртый клуб (заглушка)', city: 'Москва', mode: 'live', tables: 10, sub: sub(t, 'unpaid', 10) },
          { club_id: 'bc000000-0000-4000-8000-000000000005', name: 'Пятый клуб (заглушка)', city: 'Пермь', mode: 'live', tables: 3, sub: sub(t, 'manual', 3) },
          { club_id: 'bc000000-0000-4000-8000-000000000006', name: 'Шестой клуб (заглушка)', city: 'Екатеринбург', mode: 'test', tables: 5, sub: sub(t, 'canceled', 5) },
        ]
      : [],
  };
}

/** Состояние подписки, как server/billing/period.mjs: пробный, активна, просрочена, не оплачена (14+ дней), отключена. */
export function stateOf(s, { now, live, canceled = false }) {
  if (canceled) return 'canceled';
  if (!live) return 'trial';
  const open = s.invoices.find((i) => i.status === 'open') ?? null;
  const end = s.paid_until ?? s.trial_until;
  const due = open ? open.period_start_at : end;
  if (!open && now < due) return s.paid_until ? 'active' : 'trial';
  return now - due >= 14 * DAY ? 'unpaid' : 'past_due';
}

/** Плашка (№184, №188): ≤ 7 дней без автоплатежа; при неуспешной оплате — всегда. */
export function bannerOf(s, { now, live }) {
  if (!live) return null;
  const open = s.invoices.find((i) => i.status === 'open') ?? null;
  const end = s.paid_until ?? s.trial_until;
  if (open || now >= end) {
    const since = open ? open.period_start_at : end;
    return { kind: 'payment_failed', days_left: 0, days_overdue: Math.max(0, Math.floor((now - since) / DAY)), until: iso(since), last_error: open?.last_error ?? null };
  }
  const left = Math.ceil((end - now) / DAY);
  if (left <= 7 && !(s.autopay && s.card)) return { kind: s.paid_until ? 'period_ending' : 'trial_ending', days_left: left, days_overdue: 0, until: iso(end), last_error: null };
  return null;
}

const brief = (i) => (i ? { id: i.id, period_start: i.period_start, period_end: i.period_end, amount_kopecks: i.amount_kopecks, attempts: i.attempts, next_attempt_at: iso(i.next_attempt_at), last_error: i.last_error } : null);
const priceOf = (s) => s.personal?.price ?? PLAN.price_per_table_kopecks;

export function billingRoutes(ctx) {
  const { now, me, err, ok } = ctx; // журнал платформы заглушка не ведёт
  const B = () => {
    const st = ctx.state();
    if (!st.billing) st.billing = billingState(st.scenario, now());
    return st.billing;
  };
  const role = () => me()?.role;
  const platformRole = () => me()?.platform_role ?? null;
  const devTables = () => ctx.state().hall.length;
  const devMode = () => ctx.mode();
  const unavailable = () => ({ status: 503, body: { error: 'billing_unavailable' } });

  /** Списание и чек через 5 с после «страницы ЮKassa». */
  function advance() {
    const st = ctx.state();
    if (!st?.billing) return;
    const s = st.billing.dev;
    if (!s.pending || now() < s.pending.until) return;
    s.card = { ...CARD };
    s.autopay = true;
    s.receipt_email = s.pending.email ?? s.receipt_email;
    const open = s.invoices.find((i) => i.status === 'open');
    if (s.pending.purpose === 'invoice' && open) settle(s, open, 'card');
    s.pending = null;
  }

  function settle(s, inv, via, extra = {}) {
    Object.assign(inv, { status: 'paid', paid_via: via, paid_at: now(), next_attempt_at: null, last_error: null, receipt: via === 'card' ? { status: 'succeeded', email: s.receipt_email } : null, ...extra });
    if (!s.paid_until || inv.period_end_at > s.paid_until) s.paid_until = inv.period_end_at;
  }

  function full(s, { live, tables, mode }) {
    const t = now();
    const open = s.invoices.find((i) => i.status === 'open') ?? null;
    const end = s.paid_until ?? s.trial_until;
    const price = priceOf(s);
    return {
      mode,
      state: stateOf(s, { now: t, live }),
      trial_until: mode === 'test' ? null : iso(s.trial_until),
      paid_until: iso(s.paid_until),
      banner: bannerOf(s, { now: t, live }),
      plan: { id: PLAN.id, code: PLAN.code, title: PLAN.title },
      price_per_table_kopecks: price,
      personal_price: Boolean(s.personal),
      tables,
      trial_days: PLAN.trial_days,
      next_invoice: open ? { date: open.period_start, amount_kopecks: open.amount_kopecks, invoice_id: open.id } : live ? { date: dateOf(end), amount_kopecks: tables * price, invoice_id: null } : null,
      open_invoice: brief(open),
      card: s.card ? { ...s.card } : null,
      autopay: Boolean(s.autopay && s.card),
      receipt_email: s.receipt_email,
      card_pending: Boolean(s.pending),
    };
  }

  const invoiceJson = (i) => ({
    id: i.id,
    period_start: i.period_start,
    period_end: i.period_end,
    tables: i.tables,
    price_per_table_kopecks: i.price_per_table_kopecks,
    amount_kopecks: i.amount_kopecks,
    status: i.status,
    paid_at: iso(i.paid_at),
    paid_via: i.paid_via,
    receipt: i.receipt,
    document: i.document,
    attempts: i.attempts,
    next_attempt_at: iso(i.next_attempt_at),
    last_error: i.last_error,
  });

  const clubGuard = (fn, { ownerOnly = false } = {}) => (m, b, q) => {
    if (!me()) return err(401, 'unauthorized');
    if (ownerOnly ? role() !== 'owner' : !['owner', 'manager'].includes(role())) return err(403, 'forbidden');
    if (B().off) return unavailable();
    return fn(m, b, q);
  };

  const devView = () => {
    const mode = devMode();
    return full(B().dev, { live: mode === 'live' || mode === 'suspended', tables: devTables(), mode });
  };

  function clubsList() {
    const b = B();
    const t = now();
    const dev = { club_id: ctx.clubId, name: 'Клуб для разработки', city: 'Екатеринбург', mode: devMode(), tables: devTables(), sub: b.dev };
    return [dev, ...b.others].map((c) => {
      const s = c.sub;
      const live = c.mode === 'live' || c.mode === 'suspended';
      const canceled = c.mode === 'test' && Boolean(s.trial_until);
      const state = stateOf(s, { now: t, live, canceled });
      const open = s.invoices.find((i) => i.status === 'open') ?? null;
      const price = priceOf(s);
      return {
        club_id: c.club_id,
        name: c.name,
        city: c.city,
        mode: c.mode,
        state,
        plan: { id: PLAN.id, code: PLAN.code, title: PLAN.title },
        price_per_table_kopecks: price,
        personal_price: Boolean(s.personal),
        personal_price_reason: s.personal?.reason ?? null,
        tables: c.tables,
        monthly_kopecks: c.tables * price,
        went_live_at: iso(s.trial_until ? s.trial_until - PLAN.trial_days * DAY : null),
        trial_until: iso(s.trial_until),
        paid_until: iso(s.paid_until),
        debt_kopecks: s.invoices.filter((i) => i.status === 'open').reduce((a, i) => a + i.amount_kopecks, 0),
        open_invoice: brief(open),
        autopay: Boolean(s.autopay && s.card),
        card: Boolean(s.card),
        __sub: s,
      };
    });
  }

  const platformGuard = (fn, { admin = false } = {}) => (m, b, q) => {
    if (!me()) return err(401, 'unauthorized');
    const pr = platformRole();
    if (!pr || (admin && pr !== 'platform_admin')) return err(403, 'forbidden');
    if (B().off) return unavailable();
    return fn(m, b, q);
  };
  const findClub = (id) => clubsList().find((c) => c.club_id === id) ?? null;

  const routes = [
    ['GET', /^\/api\/clubs\/([^/]+)\/subscription$/, clubGuard(() => {
      const v = devView();
      if (role() !== 'owner') return ok({ mode: v.mode, state: v.state, trial_until: v.trial_until, paid_until: v.paid_until, banner: v.banner });
      return ok(v);
    })],
    ['GET', /^\/api\/clubs\/([^/]+)\/subscription\/invoices$/, clubGuard(() => ok({ items: B().dev.invoices.map(invoiceJson) }), { ownerOnly: true })],
    ['POST', /^\/api\/clubs\/([^/]+)\/subscription\/card$/, clubGuard((_m, body) => {
      const s = B().dev;
      if (devMode() === 'test') return { status: 409, body: { error: 'billing_unavailable' } };
      const email = typeof body?.email === 'string' && body.email.trim() ? body.email.trim() : s.receipt_email;
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return err(400, 'bad_request');
      const open = s.invoices.find((i) => i.status === 'open') ?? null;
      if (open && s.pending) return err(409, 'payment_pending');
      const purpose = open ? 'invoice' : 'bind';
      s.pending = { until: now() + 5000, purpose, email };
      return { status: 201, body: { payment_id: uuid(), purpose, amount_kopecks: open ? open.amount_kopecks : 100, confirmation_url: '/club/subscription' } };
    }, { ownerOnly: true })],
    ['DELETE', /^\/api\/clubs\/([^/]+)\/subscription\/autopay$/, clubGuard(() => {
      const s = B().dev;
      if (!s.card) return err(409, 'card_required');
      s.card = null;
      s.autopay = false;
      return ok({ autopay: false, card: null });
    }, { ownerOnly: true })],

    ['GET', /^\/api\/platform\/subscriptions$/, platformGuard(() => {
      const items = clubsList();
      const t = now();
      const monthStart = (() => {
        const d = new Date(t + 3 * 60 * MIN);
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 3 * 60 * MIN;
      })();
      const counts = { trial: 0, active: 0, past_due: 0, unpaid: 0, canceled: 0 };
      let mrr = 0;
      let paid = 0;
      let n = 0;
      for (const c of items) {
        counts[c.state] += 1;
        if (c.mode === 'live' && ['active', 'past_due', 'unpaid'].includes(c.state)) mrr += c.monthly_kopecks;
        for (const i of c.__sub.invoices) {
          if (i.status === 'paid' && i.paid_via !== 'free' && i.paid_at >= monthStart) {
            paid += i.amount_kopecks;
            n += 1;
          }
        }
      }
      return ok({
        items: items.map(({ __sub, ...x }) => x),
        plans: [{ ...PLAN }],
        totals: { mrr_kopecks: mrr, paid_this_month_kopecks: paid, payments_this_month: n, debt_kopecks: items.reduce((a, c) => a + c.debt_kopecks, 0), clubs: counts },
      });
    })],
    ['POST', /^\/api\/platform\/subscriptions\/([^/]+)\/mark-paid$/, platformGuard((m, body) => {
      const c = findClub(m[1]);
      if (!c) return err(404, 'not_found');
      if (!String(body?.reason ?? '').trim()) return err(400, 'reason_required');
      if (!String(body?.document ?? '').trim()) return err(400, 'bad_request');
      const inv = c.__sub.invoices.find((i) => i.id === body.invoice_id);
      if (!inv) return err(404, 'not_found');
      if (inv.status === 'paid') return err(409, 'invoice_paid');
      settle(c.__sub, inv, 'manual', { document: String(body.document).trim() });
      return ok({ invoice_id: inv.id, status: 'paid', paid_via: 'manual', paid_until: iso(c.__sub.paid_until) });
    }, { admin: true })],
    ['PUT', /^\/api\/platform\/subscriptions\/([^/]+)\/price$/, platformGuard((m, body) => {
      const c = findClub(m[1]);
      if (!c) return err(404, 'not_found');
      if (!String(body?.reason ?? '').trim()) return err(400, 'reason_required');
      const p = body?.price_per_table_kopecks;
      if (p !== null && (!Number.isSafeInteger(p) || p < 0)) return err(400, 'bad_request');
      c.__sub.personal = p === null ? null : { price: p, reason: String(body.reason).trim() };
      return ok({ club_id: c.club_id, price_per_table_kopecks: priceOf(c.__sub), personal_price: p !== null });
    }, { admin: true })],
  ];
  return { routes, advance };
}
