// T31 «Подписка без участия людей» (docs/contracts/m5-3.md §4; №180–188) — только API.
//
// Клубы сценария: синтетический владелец (+7998…) заводит два клуба «E2E M5.3 …» (Екатеринбург, по
// 1 столу, контроллеры — один процесс симулятора --claim на хосте, порт E2E_M53_SIM_PORT=18081), касса
// ресепшена выключена, боевой магазин 800002, оферта → live. Синтетический управляющий приглашён в оба
// (для T30: владелец и управляющий двух клубов; пользователи сида не трогаются — у них один клуб).
// Подписка проверяется на первом клубе (B). Магазин платформы — эмулятор 800010.
// Подставные часы — clock-runner.mjs в контейнере сервера (настоящий processClub/getSubscription по
// одному клубу): напоминание за 7 дней, счёт на дату, автосписание, отказ и повторы, 14 дней, плашка.
//   1. go-live → пробный 60 дней (до местной полуночи), в test — без подписки;
//   2. «за 7 дней» без карты — плашка trial_ending и одно уведомление;
//   3. привязка карты — заморозка 1 ₽ на магазин платформы (save_payment_method), отмена, маска карты;
//   4. счёт на дату конца пробного: столы × цена; автосписание без владельца, чек 54‑ФЗ, paid_until +1 мес;
//   5. отказ карты: повторы через 1 и 3 дня, плашка, уведомления; через 14 дней — Андрею (один раз);
//      свет и игры работают (настоящая игра на столе клуба), режим клуба не меняется;
//   6. ручная отметка оплаты Андреем — с причиной и платёжкой, журнал, уведомление; оператор — 403;
//   7. автоплатёж выключен → счёт ждёт карту (card_required); приостановка — без счетов и начислений,
//      возобновление сдвигает срок;
//   8. персональная цена — Андрей с причиной, со следующего счёта.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import {
  adminClient,
  ANDREY,
  api,
  apiRaw,
  billingAt,
  capi,
  claimSim,
  DAY,
  emu,
  emuSucceed,
  loadState,
  loginWait,
  newGuest,
  notificationsFor,
  staffPhone,
  PLATFORM_SHOP,
  processAlive,
  provisionFactory,
  providerId,
  saveState,
  SHOPS,
  short,
  sleep,
  startClaimSim,
  stopProcess,
  waitClaimSim,
  waitFor,
  waitPaymentSession,
} from './helpers.mjs';

const PORT = Number(process.env.E2E_M53_SIM_PORT || 18081);
const TZ = 'Asia/Yekaterinburg';
const S = { ...loadState() };
let db;

before(async () => {
  db = await adminClient();
  S.ownerPhone ??= staffPhone();
  S.managerPhone ??= staffPhone();
  S.owner = await loginWait(S.ownerPhone);
  S.manager = await loginWait(S.managerPhone);
  S.ownerId = S.owner.user.id;
  S.managerId = S.manager.user.id;
  saveState({ ownerPhone: S.ownerPhone, managerPhone: S.managerPhone, ownerId: S.ownerId, managerId: S.managerId });
  S.andrey = await loginWait('+70000000009');
  S.operator = await loginWait('+70000000010');
});

after(async () => {
  emu('/__emu/config', { post: true, body: { decline_recurring: false } });
  if (!process.env.E2E_M53_KEEP_SIM && S.simPid) stopProcess(S.simPid);
  await db?.end();
});

const own = (method, p, body) => capi(method, p, { token: S.owner.token, club: S.club, body });
const sub = async () => (await own('GET', `/api/clubs/${S.club}/subscription`)).json;
const audit = async (actions, since) =>
  (
    await db.query(
      `select seq, club_id, action, reason, actor_id, data, created_at from bl.audit_log where (club_id = $1 or (club_id is null and data->>'club_id' = $1::text))
         and action = any($2::text[]) and created_at >= $3 order by created_at, seq`,
      [S.club, actions, since],
    )
  ).rows;
const invoices = async () => (await db.query('select * from bl.billing_invoices where club_id = $1 order by period_start', [S.club])).rows;
const subRow = async () => (await db.query('select * from bl.club_subscriptions where club_id = $1', [S.club])).rows[0];

test('T31-0: два клуба синтетического владельца — зал, тариф, боевой магазин, контроллеры, наклейки (в test подписки нет)', { timeout: 6 * 60_000 }, async (t) => {
  if (S.club && S.live) {
    t.diagnostic(`клубы из прошлого прогона ${S.club.slice(0, 8)}, ${S.club2?.slice(0, 8)} — запускаю симулятор заново`);
    const sim = startClaimSim({ qrs: S.devices.map((d) => d.qr), port: PORT, tag: 'm53' });
    S.simPid = sim.pid;
    await waitClaimSim(PORT, S.simTable, (x) => x.online, { timeoutMs: 90_000, what: 'контроллер на связи' });
    return;
  }
  const f = provisionFactory(2, `m53-${Date.now()}`);
  S.devices = f.devices;
  const sim = startClaimSim({ qrs: f.devices.map((d) => d.qr), port: PORT, tag: 'm53' });
  S.simPid = sim.pid;
  await waitFor(async () => (await claimSim(PORT).catch(() => null))?.length === 2, { timeoutMs: 20_000, what: 'симулятор --claim поднялся' });
  const made = [];
  for (const [i, dev] of f.devices.entries()) {
    const r = await capi('POST', '/api/clubs', { token: S.owner.token, body: { name: `E2E M5.3 ${i === 0 ? 'Подписка' : 'Второй'} ${Date.now() % 100000}`, city_name: 'Екатеринбург', timezone: TZ } });
    assert.equal(r.status, 201, short(r));
    const club = r.json.club_id;
    const o = (method, p, body) => capi(method, p, { token: S.owner.token, club, body });
    assert.equal((await o('PUT', `/api/clubs/${club}/hall`, { width: 800, height: 600 })).status, 200);
    const res = await o('POST', `/api/clubs/${club}/resources`, { number: 1, kind: 'pyramid', plan_x: 300, plan_y: 300, plan_rotation: 0 });
    assert.equal(res.status, 201, short(res));
    const list = (await o('GET', `/api/clubs/${club}/resources`)).json;
    const table = { id: list.resources[0].id, code: list.resources[0].code };
    const tpl = (await capi('GET', '/api/tariff-templates', { token: S.owner.token })).json.templates.find((x) => x.id === 'single');
    const rules = tpl.rules.map((x) => ({ kind: null, days: x.days, from: x.from, to: x.to, price_per_hour_kopecks: 60_000, min_minutes: 1, step_minutes: 1 }));
    assert.equal((await o('PUT', `/api/clubs/${club}/tariffs`, { rules })).status, 200);
    if (i === 0) {
      // Магазин клуба = магазин платформы — 400 shop_invalid (№188), ничего не сохранено.
      const clash = await o('PUT', `/api/clubs/${club}/payment-settings/live`, { shop_id: PLATFORM_SHOP, secret_key: 'test_emu_800010_platform_dev_only' });
      const clashT = await o('PUT', `/api/clubs/${club}/payment-settings/test`, { shop_id: PLATFORM_SHOP, secret_key: 'test_emu_800010_platform_dev_only' });
      assert.equal(clash.status, 400, short(clash));
      assert.equal(clash.json.error, 'shop_invalid');
      assert.equal(clashT.status, 400, short(clashT));
      assert.equal(clashT.json.error, 'shop_invalid');
      const ps0 = (await db.query('select * from bl.club_payment_settings where club_id = $1', [club])).rows[0];
      assert.ok(!ps0 || !JSON.stringify(ps0).includes(PLATFORM_SHOP), 'магазин платформы не сохранён');
      S.clash = { live: clash.json, test: clashT.json };
    }
    assert.equal((await o('PUT', `/api/clubs/${club}/payment-settings/live`, SHOPS.live)).status, 200);
    assert.equal((await o('PUT', `/api/clubs/${club}/payment-settings/test`, SHOPS.test)).status, 200);
    const off = await o('PATCH', `/api/clubs/${club}/payment-settings`, { reception_enabled: false });
    assert.equal(off.status, 200, short(off));
    const bind = await o('POST', `/api/clubs/${club}/devices/bind`, { qr: dev.qr, resource_id: table.id });
    assert.equal(bind.status, 200, short(bind));
    const simTable = (await claimSim(PORT)).find((x) => x.device_id === dev.device_id).table;
    await waitClaimSim(PORT, simTable, (x) => x.claim?.state === 'claimed' && x.online && x.state?.mode === 'free', { timeoutMs: 90_000, what: `контроллер ${simTable} claimed и online` });
    const stk = await apiRaw('GET', `/api/clubs/${club}/qr-stickers.pdf?resources=${table.id}`, { token: S.owner.token, headers: { 'x-club-id': club } });
    assert.equal(stk.status, 200);
    const inv = await o('POST', `/api/clubs/${club}/staff/invites`, { phone: S.managerPhone, role: 'manager' });
    assert.equal(inv.status, 201, short(inv));
    made.push({ club, table, simTable, device: dev });
  }
  [S.club, S.club2] = made.map((m) => m.club);
  S.table = made[0].table;
  S.table2 = made[1].table;
  S.simTable = made[0].simTable;
  S.simTable2 = made[1].simTable;
  S.device = made[0].device;
  // Управляющий принимает приглашения при входе.
  S.manager = await loginWait(S.managerPhone);
  const me = (await capi('GET', '/api/me', { token: S.manager.token })).json;
  assert.ok(made.every((m) => me.clubs.some((c) => (c.club_id ?? c.id) === m.club)), 'управляющий принял оба приглашения');
  // В test подписки нет: «пробный начнётся после перехода».
  const s0 = await sub();
  assert.equal(s0.mode, 'test');
  assert.equal(s0.state, 'trial');
  assert.equal(s0.trial_until, null);
  assert.equal(s0.next_invoice, null);
  assert.equal((await db.query('select count(*)::int as n from bl.club_subscriptions where club_id = $1', [S.club])).rows[0].n, 0, 'подписки в test нет');
  // Второй клуб — сразу в live и одна игра (для T30: сумма двух клубов).
  const g2 = await capi('POST', `/api/clubs/${S.club2}/go-live`, { token: S.owner.token, club: S.club2, body: { accept_offer: true } });
  assert.equal(g2.status, 200, short(g2));
  const guest = await newGuest();
  const q = await capi('POST', '/api/quotes', { token: guest.token, body: { resource_id: S.table2.id, kind: 'start', minutes: 1 } });
  assert.equal(q.status, 200, short(q));
  const p = await capi('POST', `/api/quotes/${q.json.quote_id}/pay`, { token: guest.token, body: { method: 'sbp' }, idem: true });
  emuSucceed(providerId(p.json));
  const ps = await waitPaymentSession(guest.token, p.json.payment_id, { timeoutMs: 20_000 });
  await waitClaimSim(PORT, S.simTable2, (x) => x.state?.relay === true, { timeoutMs: 15_000, what: 'свет во втором клубе' });
  await api('POST', `/api/sessions/${ps.session_id}/stop`, { token: guest.token, body: {} });
  saveState({ club: S.club, club2: S.club2, table: S.table, table2: S.table2, devices: S.devices, device: S.device, simTable: S.simTable, simTable2: S.simTable2, simPid: S.simPid, clash: S.clash, game2: q.json.amount_kopecks });
  t.diagnostic(`клубы ${S.club.slice(0, 8)} (подписка) и ${S.club2.slice(0, 8)} (второй, live, игра ${q.json.amount_kopecks} коп.); магазин платформы в поле клуба — 400 ${JSON.stringify(S.clash.live)} / тестовый ${JSON.stringify(S.clash.test)}; контроллеры → столы сим ${S.simTable}, ${S.simTable2}; в test: ${JSON.stringify({ mode: s0.mode, state: s0.state, trial_until: s0.trial_until })}`);
});

test('T31-1: переход в live → пробный период 60 дней до местной полуночи; управляющий видит только состояние', async (t) => {
  if (!S.live) {
    const g = await own('POST', `/api/clubs/${S.club}/go-live`, { accept_offer: true });
    assert.equal(g.status, 200, short(g));
    assert.equal(g.json.mode, 'live');
    S.live = true;
    saveState({ live: true });
  }
  const club = (await db.query('select went_live_at from bl.clubs where id = $1', [S.club])).rows[0];
  const s = await waitFor(async () => {
    const x = await sub();
    return x.mode === 'live' && x.trial_until ? x : null;
  }, { timeoutMs: 20_000, what: 'подписка с пробным периодом' });
  const row = await subRow();
  // Конец пробного: местная полночь через 60 суток после местной даты перехода.
  const localStart = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(club.went_live_at);
  const end = new Date(`${localStart}T00:00:00+05:00`);
  end.setUTCDate(end.getUTCDate() + 60);
  assert.equal(s.state, 'trial');
  assert.equal(s.trial_days, 60);
  assert.equal(new Date(s.trial_until).toISOString(), end.toISOString(), 'пробный до местной полуночи + 60 суток');
  assert.equal(s.paid_until, null);
  assert.equal(s.tables, 1);
  assert.equal(s.price_per_table_kopecks, 79_000);
  assert.deepEqual(s.next_invoice, { date: new Date(end.getTime() + 5 * 3600_000).toISOString().slice(0, 10), amount_kopecks: 79_000, invoice_id: null });
  assert.equal(s.card, null);
  assert.equal(s.autopay, false);
  assert.ok(Math.abs(new Date(row.trial_started_at) - club.went_live_at) < 60_000, 'начало пробного — переход в live');
  const man = S.manager;
  const m = (await capi('GET', `/api/clubs/${S.club}/subscription`, { token: man.token, club: S.club })).json;
  assert.deepEqual(Object.keys(m).sort(), ['banner', 'mode', 'paid_until', 'state', 'trial_until']);
  const inv = await capi('GET', `/api/clubs/${S.club}/subscription/invoices`, { token: man.token, club: S.club });
  assert.equal(inv.status, 403, 'история счетов — только владельцу');
  S.trialUntil = new Date(s.trial_until);
  saveState({ trialUntil: s.trial_until, wentLive: club.went_live_at });
  t.diagnostic(`go-live ${club.went_live_at.toISOString()} → пробный до ${s.trial_until} (60 дней); следующий счёт ${JSON.stringify(s.next_invoice)}; управляющий: ${JSON.stringify(m)}`);
});

test('T31-2: за 7 дней до конца пробного без автоплатежа — плашка trial_ending и одно уведомление', async (t) => {
  const at = new Date(S.trialUntil.getTime() - 6 * DAY + 3600_000);
  const since = new Date();
  const r1 = billingAt('process', S.club, at);
  const r2 = billingAt('process', S.club, new Date(at.getTime() + 3600_000));
  const st = billingAt('state', S.club, at);
  assert.equal(st.owner.banner?.kind, 'trial_ending');
  assert.equal(st.owner.banner.days_left, 6);
  assert.equal(st.manager.banner?.kind, 'trial_ending', 'управляющему — плашка');
  const own1 = await notificationsFor(db, S.ownerId, { kinds: ['billing.reminder'], since });
  const man1 = await notificationsFor(db, S.managerId, { kinds: ['billing.reminder'], since });
  assert.equal(own1.filter((n) => n.data?.club_id === S.club || n.text.includes('Пробный')).length, 1, 'владельцу — одно напоминание');
  assert.equal(man1.length >= 1, true, 'управляющему — напоминание');
  assert.equal((await invoices()).length, 0, 'счёта ещё нет');
  t.diagnostic(`часы ${at.toISOString()}: ${r1.result}/${r2.result}; плашка ${JSON.stringify(st.owner.banner)}; владельцу: «${own1[0]?.text}»`);
});

test('T31-3: привязка карты — заморозка 1 ₽ в магазине платформы с save_payment_method, снята; маска карты', { timeout: 2 * 60_000 }, async (t) => {
  const noEmail = await own('POST', `/api/clubs/${S.club}/subscription/card`, {});
  assert.equal(noEmail.status, 400, 'email для чека обязателен при первой привязке');
  const badReturn = await own('POST', `/api/clubs/${S.club}/subscription/card`, { email: 'owner-e2e@billiardum.test', return_url: 'https://evil.example/x' });
  assert.equal(badReturn.status, 400, `чужой return_url — 400: ${short(badReturn)}`);
  const r = await own('POST', `/api/clubs/${S.club}/subscription/card`, { email: 'owner-e2e@billiardum.test' });
  assert.equal(r.status, 201, short(r));
  assert.equal(r.json.purpose, 'bind');
  assert.equal(r.json.amount_kopecks, 100);
  const pid = providerId({ confirmation: { url: r.json.confirmation_url } });
  const ep = emu(`/__emu/payments/${pid}`);
  assert.equal(ep.shop_id, PLATFORM_SHOP, 'платёж — в магазин платформы');
  assert.equal(ep.capture, false, 'заморозка');
  assert.equal(ep.save_payment_method ?? ep.savePaymentMethod ?? true, true);
  const pending = await sub();
  assert.equal(pending.card_pending, true, 'card_pending до итога');
  emuSucceed(pid);
  const s = await waitFor(async () => {
    const x = await sub();
    return x.card && x.autopay ? x : null;
  }, { timeoutMs: 40_000, what: 'карта сохранена' });
  const ep2 = await waitFor(() => {
    const x = emu(`/__emu/payments/${pid}`);
    return x.status === 'canceled' ? x : null;
  }, { timeoutMs: 40_000, what: 'заморозка 1 ₽ снята' });
  assert.match(s.card.mask, /^•• \d{4}$/);
  assert.equal(s.receipt_email, 'owner-e2e@billiardum.test');
  const row = await subRow();
  assert.ok(row.payment_method_enc && !JSON.stringify(row.payment_method_enc).includes(ep2.payment_method?.id ?? '§'), 'способ оплаты в базе — шифротекст');
  const au = await audit(['billing.card_start', 'billing.card_saved'], new Date(Date.now() - 120_000));
  assert.ok(au.some((a) => a.action === 'billing.card_start' && a.club_id === S.club), 'billing.card_start в цепочке клуба');
  assert.ok(au.some((a) => a.action === 'billing.card_saved'), 'billing.card_saved');
  t.diagnostic(`без email — 400; чужой return_url — ${badReturn.status} ${JSON.stringify(badReturn.json)}; заморозка ${pid.slice(0, 8)} 1 ₽ магазин ${ep.shop_id} capture=${ep.capture} → ${ep2.status}; карта ${JSON.stringify(s.card)}, autopay ${s.autopay}`);
});

test('T31-4: счёт на дату конца пробного = столы × цена; автосписание без владельца, чек 54‑ФЗ, paid_until +1 мес', async (t) => {
  const at = new Date(S.trialUntil.getTime() + 2 * 60_000);
  const since = new Date();
  const r = billingAt('process', S.club, at);
  const inv = await waitFor(async () => {
    const x = (await invoices())[0];
    return x?.status === 'paid' ? x : null;
  }, { timeoutMs: 30_000, what: 'счёт 1 оплачен' });
  assert.equal(inv.tables, 1);
  assert.equal(Number(inv.price_per_table_kopecks), 79_000);
  assert.equal(Number(inv.amount_kopecks), 79_000);
  assert.equal(inv.paid_via, 'card');
  assert.equal(new Date(inv.period_start_at).toISOString(), S.trialUntil.toISOString(), 'период с конца пробного');
  const pays = (await db.query('select * from bl.billing_payments where invoice_id = $1', [inv.id])).rows;
  assert.equal(pays.length, 1);
  assert.equal(pays[0].initiated_by, 'autopay');
  assert.equal(pays[0].idempotence_key, `bl-sub-${inv.id}-1`, 'ключ идемпотентности: счёт и попытка');
  const ep = emu(`/__emu/payments/${pays[0].provider_payment_id}`);
  assert.equal(ep.shop_id, PLATFORM_SHOP);
  assert.equal(ep.status, 'succeeded');
  assert.equal(ep.amount.value, '790.00');
  const item = ep.receipt?.items?.[0];
  assert.equal(item?.description, 'Подписка на программу «Бильярдум»', 'чек: услуга');
  assert.equal(ep.receipt?.customer?.email, 'owner-e2e@billiardum.test', 'чек на email владельца');
  assert.equal(item?.payment_subject, 'service');
  const s = await sub();
  assert.equal(new Date(s.paid_until).toISOString(), new Date(inv.period_end_at).toISOString(), 'paid_until = конец периода');
  const months = (new Date(inv.period_end_at) - new Date(inv.period_start_at)) / DAY;
  assert.ok(months >= 28 && months <= 31, `период — месяц (${months} дн.)`);
  const list = (await own('GET', `/api/clubs/${S.club}/subscription/invoices`)).json.items;
  assert.equal(list[0].receipt?.status, 'succeeded');
  assert.equal(list[0].receipt?.email, 'owner-e2e@billiardum.test');
  const au = await audit(['billing.invoice_issued', 'billing.charge', 'billing.invoice_paid'], since);
  assert.deepEqual([...new Set(au.map((a) => a.action))].sort(), ['billing.charge', 'billing.invoice_issued', 'billing.invoice_paid']);
  const n = await waitFor(async () => (await notificationsFor(db, S.ownerId, { kinds: ['billing.payment_succeeded'], since }))[0] ?? null, { what: 'уведомление об оплате' });
  S.inv1 = inv.id;
  S.paid1 = new Date(inv.period_end_at);
  saveState({ inv1: inv.id, paid1: S.paid1.toISOString() });
  t.diagnostic(`часы ${at.toISOString()} → ${r.result}; счёт ${inv.period_start}–${inv.period_end}: ${inv.tables} × ${inv.price_per_table_kopecks} = ${inv.amount_kopecks}; ЮKassa ${ep.id.slice(0, 8)} ${ep.amount.value} ₽, ключ ${pays[0].idempotence_key.replace(inv.id, '{счёт}')}, чек «${item.description}» → ${ep.receipt.customer.email}; paid_until ${s.paid_until}; владельцу: «${n.text}»`);
});

test('T31-5: отказ карты — повторы через 1 и 3 дня, плашка и уведомления; через 14 дней — Андрею один раз', { timeout: 5 * 60_000 }, async (t) => {
  emu('/__emu/config', { post: true, body: { decline_recurring: { count: 10, reason: 'insufficient_funds' } } });
  const p1 = S.paid1;
  const since = new Date();
  const steps = [];
  const at1 = new Date(p1.getTime() + 2 * 60_000);
  steps.push(billingAt('process', S.club, at1).result);
  let inv = (await invoices()).find((x) => x.status === 'open');
  assert.ok(inv, 'счёт 2 выставлен');
  assert.equal(inv.attempts, 1);
  assert.equal(inv.last_error, 'insufficient_funds');
  assert.equal(new Date(inv.next_attempt_at).toISOString(), new Date(at1.getTime() + DAY).toISOString(), 'повтор через 1 день');
  const st1 = billingAt('state', S.club, new Date(at1.getTime() + 60_000));
  assert.equal(st1.owner.state, 'past_due');
  assert.equal(st1.owner.banner?.kind, 'payment_failed');
  assert.equal(st1.owner.banner.last_error, 'insufficient_funds');
  assert.equal(st1.manager.banner?.kind, 'payment_failed', 'управляющему — плашка');
  // Повтор раньше срока — ничего.
  steps.push(billingAt('process', S.club, new Date(at1.getTime() + 12 * 3600_000)).result);
  assert.equal((await invoices()).find((x) => x.id === inv.id).attempts, 1, 'до срока повтора — без списания');
  steps.push(billingAt('process', S.club, new Date(at1.getTime() + DAY + 60_000)).result);
  inv = (await invoices()).find((x) => x.id === inv.id);
  assert.equal(inv.attempts, 2);
  assert.equal(new Date(inv.next_attempt_at).toISOString(), new Date(at1.getTime() + 3 * DAY).toISOString(), 'повтор через 3 дня после первой неудачи');
  steps.push(billingAt('process', S.club, new Date(at1.getTime() + 3 * DAY + 60_000)).result);
  inv = (await invoices()).find((x) => x.id === inv.id);
  assert.equal(inv.attempts, 3);
  assert.equal(inv.next_attempt_at, null, 'попыток больше не будет');
  steps.push(billingAt('process', S.club, new Date(at1.getTime() + 5 * DAY)).result);
  assert.equal((await invoices()).find((x) => x.id === inv.id).attempts, 3, 'четвёртой попытки нет');
  const pays = (await db.query('select attempt, idempotence_key, status, error from bl.billing_payments where invoice_id = $1 order by attempt', [inv.id])).rows;
  assert.deepEqual(pays.map((p) => [p.attempt, p.status]), [[1, 'canceled'], [2, 'canceled'], [3, 'canceled']]);
  assert.deepEqual(pays.map((p) => p.idempotence_key), [1, 2, 3].map((n) => `bl-sub-${inv.id}-${n}`));
  const failedOwner = await notificationsFor(db, S.ownerId, { kinds: ['billing.payment_failed'], since });
  const failedMan = await notificationsFor(db, S.managerId, { kinds: ['billing.payment_failed'], since });
  assert.equal(failedOwner.length, 3, 'владельцу — при каждой неудаче');
  assert.equal(failedMan.length, 3, 'управляющему — при каждой неудаче');
  // 13 дней — Андрею ещё нет; 14 — один раз.
  steps.push(billingAt('process', S.club, new Date(p1.getTime() + 13 * DAY)).result);
  assert.equal((await notificationsFor(db, ANDREY, { kinds: ['platform.billing_overdue'], since })).length, 0, '13 дней — Андрею нет');
  steps.push(billingAt('process', S.club, new Date(p1.getTime() + 14 * DAY + 60_000)).result);
  steps.push(billingAt('process', S.club, new Date(p1.getTime() + 15 * DAY)).result);
  const over = await notificationsFor(db, ANDREY, { kinds: ['platform.billing_overdue'], since });
  assert.equal(over.length, 1, 'Андрею — один раз');
  assert.match(over[0].text, /работает как обычно/);
  const st14 = billingAt('state', S.club, new Date(p1.getTime() + 14 * DAY + 2 * 60_000));
  assert.equal(st14.owner.state, 'unpaid');
  assert.equal(st14.owner.banner.kind, 'payment_failed');
  assert.ok(st14.owner.banner.days_overdue >= 14);
  const mode = (await db.query('select mode from bl.clubs where id = $1', [S.club])).rows[0].mode;
  assert.equal(mode, 'live', 'автоматически ничего не отключается');
  S.inv2 = inv.id;
  saveState({ inv2: inv.id });
  t.diagnostic(`проходы: ${steps.join(', ')}; попытки ${pays.map((p) => `${p.attempt}:${p.status}/${p.error}`).join(', ')}; уведомлений владельцу ${failedOwner.length}, управляющему ${failedMan.length} («${failedOwner[0].text}»); Андрею: «${over[0].text}»; на 14-й день ${st14.owner.state}, просрочка ${st14.owner.banner.days_overdue} дн.; режим ${mode}`);
});

test('T31-5б: при неоплаченной подписке свет и игры работают — игра гостя на столе клуба, свет, гаснет по оплаченному', { timeout: 4 * 60_000 }, async (t) => {
  const s = await sub();
  assert.ok(['past_due', 'unpaid'].includes(s.state), `состояние ${s.state}`);
  const guest = await newGuest();
  const q = await capi('POST', '/api/quotes', { token: guest.token, body: { resource_id: S.table.id, kind: 'start', minutes: 1 } });
  assert.equal(q.status, 200, short(q));
  const p = await capi('POST', `/api/quotes/${q.json.quote_id}/pay`, { token: guest.token, body: { method: 'sbp' }, idem: true });
  assert.equal(p.status, 200, short(p));
  const pid = providerId(p.json);
  const ep = emu(`/__emu/payments/${pid}`);
  assert.equal(ep.shop_id, SHOPS.live.shop_id, 'деньги гостя — в магазин клуба, не платформы');
  emuSucceed(pid);
  const ps = await waitPaymentSession(guest.token, p.json.payment_id, { timeoutMs: 20_000 });
  const lit = await waitClaimSim(PORT, S.simTable, (x) => x.state?.relay === true && x.state?.session_id === ps.session_id, { timeoutMs: 15_000, what: 'свет включён' });
  await api('POST', `/api/sessions/${ps.session_id}/stop`, { token: guest.token, body: {} });
  await waitClaimSim(PORT, S.simTable, (x) => x.state?.mode === 'free', { timeoutMs: 15_000, what: 'свет погас' });
  const bp = (await db.query('select count(*)::int as n from bl.billing_payments where provider_payment_id = $1', [pid])).rows[0].n;
  assert.equal(bp, 0, 'платёж гостя не в платежах платформы');
  S.guestPid = pid;
  saveState({ guestPid: pid, guestPayment: p.json.payment_id });
  t.diagnostic(`подписка ${s.state}, плашка ${JSON.stringify(s.banner)}; игра гостя: ЮKassa ${pid.slice(0, 8)} магазин ${ep.shop_id}, свет relay=${lit.state.relay}; закончена гостем`);
});

test('T31-6: ручная отметка оплаты Андреем — причина и платёжка обязательны, журнал, уведомление; оператор и владелец — 403', async (t) => {
  const since = new Date();
  const url = `/api/platform/subscriptions/${S.club}/mark-paid`;
  const opr = await api('POST', url, { token: S.operator.token, body: { invoice_id: S.inv2, reason: 'x', document: '1' } });
  const ownr = await api('POST', url, { token: S.owner.token, body: { invoice_id: S.inv2, reason: 'x', document: '1' } });
  assert.equal(opr.status, 403, 'оператор — только чтение');
  assert.equal(ownr.status, 403, 'владелец клуба — нет');
  const noReason = await api('POST', url, { token: S.andrey.token, body: { invoice_id: S.inv2, document: 'п/п 15' } });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.json.error, 'reason_required');
  const noDoc = await api('POST', url, { token: S.andrey.token, body: { invoice_id: S.inv2, reason: 'Оплата по счёту юрлица' } });
  assert.equal(noDoc.status, 400);
  const r = await api('POST', url, { token: S.andrey.token, body: { invoice_id: S.inv2, reason: 'Оплата по счёту юрлица (тест e2e)', document: 'п/п №15 от 24.10.2026' } });
  assert.equal(r.status, 200, short(r));
  assert.equal(r.json.paid_via, 'manual');
  const again = await api('POST', url, { token: S.andrey.token, body: { invoice_id: S.inv2, reason: 'повтор', document: 'п/п №15' } });
  assert.equal(again.status, 409);
  assert.equal(again.json.error, 'invoice_paid');
  const inv = (await invoices()).find((x) => x.id === S.inv2);
  assert.equal(inv.status, 'paid');
  const s = await sub();
  assert.equal(new Date(s.paid_until).toISOString(), new Date(inv.period_end_at).toISOString());
  assert.equal(s.state, 'active');
  const au = await audit(['manual.billing_mark_paid'], since);
  assert.equal(au.length, 1);
  assert.ok(au[0].reason && au[0].actor_id === ANDREY);
  const n = await waitFor(async () => (await notificationsFor(db, S.ownerId, { kinds: ['billing.payment_succeeded'], since }))[0] ?? null, { what: 'уведомление владельцу' });
  const list = (await own('GET', `/api/clubs/${S.club}/subscription/invoices`)).json.items.find((x) => x.id === S.inv2);
  assert.equal(list.paid_via, 'manual');
  assert.equal(list.document, 'п/п №15 от 24.10.2026');
  S.paid2 = new Date(inv.period_end_at);
  saveState({ paid2: S.paid2.toISOString() });
  t.diagnostic(`оператор ${opr.status}, владелец ${ownr.status}; без причины ${JSON.stringify(noReason.json)}; без платёжки ${noDoc.status}; отметка → ${JSON.stringify(r.json)}; повтор ${JSON.stringify(again.json)}; журнал manual.billing_mark_paid «${au[0].reason}»; владельцу: «${n.text}»`);
});

test('T31-7: автоплатёж выключен — счёт ждёт карту (card_required); приостановка — без счетов, возобновление сдвигает срок', { timeout: 6 * 60_000 }, async (t) => {
  emu('/__emu/config', { post: true, body: { decline_recurring: false } });
  const since = new Date();
  const off = await own('DELETE', `/api/clubs/${S.club}/subscription/autopay`, { reason: 'Сменю карту (тест e2e)' });
  assert.equal(off.status, 200, short(off));
  assert.deepEqual(off.json, { autopay: false, card: null });
  const off2 = await own('DELETE', `/api/clubs/${S.club}/subscription/autopay`, {});
  assert.equal(off2.status, 409);
  assert.equal(off2.json.error, 'card_required');
  const at3 = new Date(S.paid2.getTime() + 2 * 60_000);
  billingAt('process', S.club, at3);
  const inv3 = (await invoices()).find((x) => x.status === 'open');
  assert.ok(inv3, 'счёт 3 выставлен');
  assert.equal(inv3.last_error, 'card_required');
  assert.equal(inv3.attempts, 0, 'без карты — без списания');
  const cr = await notificationsFor(db, S.ownerId, { kinds: ['billing.card_required'], since });
  assert.equal(cr.length, 1);
  billingAt('process', S.club, new Date(at3.getTime() + DAY));
  assert.equal((await notificationsFor(db, S.ownerId, { kinds: ['billing.card_required'], since })).length, 1, 'card_required — один раз на счёт');
  // Приостановка Андреем: счета не выставляются (даже на дату следующего периода), ничего не начисляется.
  const sp = await api('POST', `/api/platform/clubs/${S.club}/suspend`, { token: S.andrey.token, body: { reason: 'Проверка приостановки подписки (тест e2e)' } });
  assert.equal(sp.status, 200, short(sp));
  await waitFor(async () => ((await subRow()).suspended_since ? true : null), { timeoutMs: 150_000, intervalMs: 3000, what: 'планировщик отметил начало приостановки' });
  const before = (await invoices()).length;
  const rowBefore = await subRow();
  billingAt('process', S.club, new Date(S.paid2.getTime() + 35 * DAY));
  billingAt('process', S.club, new Date(S.paid2.getTime() + 70 * DAY));
  assert.equal((await invoices()).length, before, 'за приостановку счетов нет');
  const rs = await api('POST', `/api/platform/clubs/${S.club}/resume`, { token: S.andrey.token, body: { reason: 'Возобновление (тест e2e)' } });
  assert.equal(rs.status, 200, short(rs));
  const rowAfter = await waitFor(async () => {
    const x = await subRow();
    return x.suspended_since === null ? x : null;
  }, { timeoutMs: 150_000, intervalMs: 3000, what: 'возобновление учтено планировщиком' });
  const au = await audit(['billing.suspended', 'billing.resumed'], since);
  assert.deepEqual(au.map((a) => a.action), ['billing.suspended', 'billing.resumed']);
  const shiftDays = (new Date(rowAfter.paid_until) - new Date(rowBefore.paid_until)) / DAY;
  assert.equal(au[1].data.kind, 'shift');
  assert.equal(shiftDays, 1, 'срок сдвинут на длительность приостановки (целые сутки вверх)');
  assert.equal((await invoices()).length, before, 'задним числом не начислено');
  S.inv3 = inv3.id;
  saveState({ inv3: inv3.id });
  t.diagnostic(`автоплатёж выключен ${JSON.stringify(off.json)}, повтор ${JSON.stringify(off2.json)}; счёт 3 ${inv3.period_start}: ${inv3.last_error}, попыток 0; card_required ×1 «${cr[0].text}»; приостановка с ${rowBefore.suspended_since?.toISOString?.() ?? rowBefore.suspended_since}; счетов ${before} → ${(await invoices()).length}; возобновление ${JSON.stringify(au[1].data)}: paid_until ${new Date(rowBefore.paid_until).toISOString()} → ${new Date(rowAfter.paid_until).toISOString()}`);
});

test('T31-8: персональная цена — только Андрей с причиной; со следующего счёта; MRR и долг в «Клубах и подписках»', async (t) => {
  const url = `/api/platform/subscriptions/${S.club}/price`;
  const byOwner = await api('PUT', url, { token: S.owner.token, body: { price_per_table_kopecks: 1, reason: 'x' } });
  const byOp = await api('PUT', url, { token: S.operator.token, body: { price_per_table_kopecks: 1, reason: 'x' } });
  const noReason = await api('PUT', url, { token: S.andrey.token, body: { price_per_table_kopecks: 50_000 } });
  assert.equal(byOwner.status, 403);
  assert.equal(byOp.status, 403);
  assert.equal(noReason.status, 400);
  const r = await api('PUT', url, { token: S.andrey.token, body: { price_per_table_kopecks: 50_000, reason: 'Пилотный клуб (тест e2e)' } });
  assert.equal(r.status, 200, short(r));
  assert.equal(r.json.personal_price, true);
  const s = await sub();
  assert.equal(s.price_per_table_kopecks, 50_000);
  assert.equal(s.personal_price, true);
  const inv3 = (await invoices()).find((x) => x.id === S.inv3);
  assert.equal(Number(inv3.amount_kopecks), 79_000, 'выставленный счёт не пересчитан');
  const list = await api('GET', '/api/platform/subscriptions', { token: S.operator.token });
  assert.equal(list.status, 200);
  const item = list.json.items.find((x) => x.club_id === S.club);
  assert.equal(item.debt_kopecks, 79_000, 'долг — открытый счёт 3');
  assert.equal(item.monthly_kopecks, 50_000);
  assert.ok(list.json.totals.mrr_kopecks >= 50_000);
  // Чистка: счёт 3 — отметкой Андрея, цена — плана.
  await api('POST', `/api/platform/subscriptions/${S.club}/mark-paid`, { token: S.andrey.token, body: { invoice_id: S.inv3, reason: 'Закрытие сценария (тест e2e)', document: 'п/п №16' } });
  const back = await api('PUT', url, { token: S.andrey.token, body: { price_per_table_kopecks: null, reason: 'Вернуть цену плана (тест e2e)' } });
  assert.equal(back.status, 200);
  assert.equal(back.json.personal_price, false);
  t.diagnostic(`владелец ${byOwner.status}, оператор ${byOp.status}, без причины ${noReason.status}; цена 500 ₽ → ${JSON.stringify(r.json)}; счёт 3 остался ${inv3.amount_kopecks}; в списке: долг ${item.debt_kopecks}, в месяц ${item.monthly_kopecks}, MRR ${list.json.totals.mrr_kopecks}`);
});

export { readFileSync, sleep, processAlive };
