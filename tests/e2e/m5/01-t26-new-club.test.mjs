// T26 «Новый клуб за вечер» (docs/contracts/m5-1.md §5; решения №152–162) через API и симулятор.
//
// Новый пользователь входит, создаёт клуб (test), ставит на план 2 стола, шаблон «Будни и выходные»,
// меню из .xlsx (сначала предпросмотр), приглашает ресепшн ссылкой, подключает тестовый магазин
// (эмулятор, /v3/me), делает проверочный платёж 1 ₽ (возврат, вебхук), привязывает 2 новых
// контроллера симулятора по BLD1-QR (provision-factory + отдельный процесс --claim на 18081),
// печатает наклейки. Гость сканирует QR, видит режим test, платит тестовой картой — свет включает
// подписанная команда с device.cmd в журнале, по окончании свет гаснет.
//
// Состояние для 02 и 03 — E2E_M5_DIR/state.json. Симулятор новых контроллеров остаётся работать
// (его гасит 05 в конце, если не задан E2E_M5_KEEP_SIM).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import {
  adminClient,
  apiRaw,
  capi,
  claimSim,
  clubAudit,
  clubCmdsWithAudit,
  EKB_TZ,
  emu,
  emuSucceed,
  loginRetry,
  makeXlsx,
  MENU_ROWS,
  newGuest,
  phonesIn,
  processAlive,
  provisionFactory,
  providerId,
  saveState,
  SHOPS,
  short,
  simLog,
  sleep,
  staffPhone,
  startClaimSim,
  waitClaimSim,
  waitFor,
  waitPaymentSession,
  XLSX_MIME,
} from './helpers.mjs';

const PORT = Number(process.env.E2E_M5_SIM_PORT || 18081);
const S = {};
let db;

before(async () => {
  db = await adminClient();
});

after(async () => {
  await db?.end();
});

const onboarding = () => capi('GET', `/api/clubs/${S.club}/onboarding`, { token: S.owner.token, club: S.club });
const stepsOf = (o) => Object.fromEntries(o.steps.map((s) => [s.id, s.done]));

test('T26-1: новый пользователь создаёт клуб — test, он владелец, журнал club.create', async (t) => {
  S.ownerPhone = staffPhone();
  S.owner = await loginRetry(S.ownerPhone, { consent: false });
  const lst = await capi('GET', '/api/clubs/claimable-listings', { token: S.owner.token });
  assert.equal(lst.status, 200, short(lst));
  assert.deepEqual(lst.json.items, []);
  const bad = await capi('POST', '/api/clubs', { token: S.owner.token, body: { name: 'E2E M5 без пояса', city_name: 'Нигдеград' } });
  assert.equal(bad.status, 400, `город не из справочника без пояса — 400: ${short(bad)}`);
  const r = await capi('POST', '/api/clubs', { token: S.owner.token, body: { name: `E2E M5 Клуб ${Date.now() % 100000}`, city_name: 'Екатеринбург', timezone: EKB_TZ } });
  assert.equal(r.status, 201, short(r));
  assert.equal(r.json.mode, 'test');
  S.club = r.json.club_id;
  S.t0 = new Date(Date.now() - 2000);
  const me = (await capi('GET', '/api/me', { token: S.owner.token })).json;
  const mine = me.clubs.find((c) => c.club_id === S.club || c.id === S.club);
  assert.ok(mine, 'клуб в /api/me');
  assert.equal(mine.mode, 'test');
  assert.ok([mine.role, ...(mine.roles ?? [])].includes('owner'), `роль владельца: ${JSON.stringify(mine)}`);
  const { rows } = await db.query('select mode, city, city_id, timezone, created_by from bl.clubs where id = $1', [S.club]);
  assert.equal(rows[0].mode, 'test');
  assert.ok(rows[0].city_id, 'город связан со справочником по названию');
  assert.equal(rows[0].timezone, EKB_TZ);
  const au = await clubAudit(db, S.club, { actions: ['club.create'] });
  assert.equal(au.length, 1);
  const o = (await onboarding()).json;
  assert.equal(o.mode, 'test');
  assert.equal(stepsOf(o).club, true);
  assert.equal(o.checklist.ready, false);
  assert.equal(o.webhook_url, `https://localhost:8443/api/webhooks/yookassa/${S.club}`);
  saveState({ club: S.club, ownerPhone: S.ownerPhone, t0: S.t0.toISOString(), port: PORT });
  t.diagnostic(`клуб ${S.club.slice(0, 8)} mode=test, город ${rows[0].city} (city_id есть), пояс ${rows[0].timezone}; журнал club.create; шаги ${JSON.stringify(stepsOf(o))}; чек-лист: ${o.checklist.items.filter((i) => !i.ok).map((i) => `${i.id} «${i.detail}»`).join('; ')}`);
});

test('T26-2: план зала — 2 стола, перетаскивание и поворот (журнал без причины в test)', async (t) => {
  const hall = await capi('PUT', `/api/clubs/${S.club}/hall`, { token: S.owner.token, club: S.club, body: { width: 1200, height: 800 } });
  assert.equal(hall.status, 200, short(hall));
  const a = await capi('POST', `/api/clubs/${S.club}/resources`, { token: S.owner.token, club: S.club, body: { number: 1, kind: 'pyramid', plan_x: 300, plan_y: 300, plan_rotation: 0 } });
  const b = await capi('POST', `/api/clubs/${S.club}/resources`, { token: S.owner.token, club: S.club, body: { number: 2, kind: 'pool', plan_x: 800, plan_y: 300, plan_rotation: 90 } });
  assert.equal(a.status, 201, short(a));
  assert.equal(b.status, 201, short(b));
  const dup = await capi('POST', `/api/clubs/${S.club}/resources`, { token: S.owner.token, club: S.club, body: { number: 2, kind: 'pool' } });
  assert.equal(dup.status, 409, `номер занят: ${short(dup)}`);
  // «Перетаскивание»: новая позиция и поворот.
  const mv = await capi('PATCH', `/api/clubs/${S.club}/resources/${a.json.id}`, { token: S.owner.token, club: S.club, body: { plan_x: 350, plan_y: 420, plan_rotation: 90 } });
  assert.equal(mv.status, 200, short(mv));
  assert.equal(mv.json.plan_x, 350);
  const list = (await capi('GET', `/api/clubs/${S.club}/resources`, { token: S.owner.token, club: S.club })).json;
  assert.deepEqual(list.plan, { width_cm: 1200, height_cm: 800 });
  assert.equal(list.resources.length, 2);
  S.tables = list.resources.map((r) => ({ id: r.id, number: r.number, kind: r.kind, code: r.code }));
  const au = await clubAudit(db, S.club, { actions: ['resource.create', 'resource.update', 'hall.update', 'manual.resource_add'] });
  assert.equal(au.filter((x) => x.action === 'resource.create').length, 2);
  assert.equal(au.filter((x) => x.action === 'manual.resource_add').length, 0, 'в test — не ручное действие');
  assert.ok(au.some((x) => x.action === 'resource.update' && x.data.changed.plan_x));
  const { rows: al } = await db.query("select count(*)::int as n from bl.alarms where club_id = $1 and type = 'manual_action'", [S.club]);
  assert.equal(al[0].n, 0, 'в test тревог нет');
  saveState({ tables: S.tables });
  t.diagnostic(`зал 12×8 м; столы ${S.tables.map((x) => `№${x.number} ${x.kind} код ${x.code}`).join(', ')}; дубль номера — 409 duplicate; позиция 300,300→350,420 и поворот 0→90 — resource.update; журнал ${au.map((x) => x.action).join(', ')}; тревог 0`);
});

test('T26-3: тариф «Будни и выходные» — проверка недели (дыра, пересечение), сохранение без причины', async (t) => {
  const tpl = await capi('GET', '/api/tariff-templates', { token: S.owner.token });
  assert.equal(tpl.status, 200);
  const ids = tpl.json.templates.map((x) => x.id);
  assert.deepEqual(ids, ['single', 'weekdays_weekend', 'day_evening', 'day_evening_night', 'weekdays_weekend_day_evening']);
  const ww = tpl.json.templates.find((x) => x.id === 'weekdays_weekend');
  const price = { weekday: 60_000, weekend: 90_000 };
  const rules = ww.rules.map((r) => ({ kind: null, days: r.days, from: r.from, to: r.to, price_per_hour_kopecks: price[r.price], min_minutes: 30, step_minutes: 1 }));
  const gap = await capi('PUT', `/api/clubs/${S.club}/tariffs`, { token: S.owner.token, club: S.club, body: { rules: rules.slice(0, 1) } });
  assert.equal(gap.status, 400, short(gap));
  assert.equal(gap.json.error, 'tariff_gap');
  const over = await capi('PUT', `/api/clubs/${S.club}/tariffs`, {
    token: S.owner.token,
    club: S.club,
    body: { rules: [...rules, { kind: 'pool', days: [6], from: '12:00', to: '14:00', price_per_hour_kopecks: 1, min_minutes: 30, step_minutes: 1 }] },
  });
  assert.equal(over.status, 400, short(over));
  assert.equal(over.json.error, 'tariff_overlap');
  const okr = await capi('PUT', `/api/clubs/${S.club}/tariffs`, { token: S.owner.token, club: S.club, body: { rules } });
  assert.equal(okr.status, 200, short(okr));
  const au = await clubAudit(db, S.club, { actions: ['tariff.update', 'manual.tariff_change'] });
  assert.equal(au.length, 1);
  assert.equal(au[0].action, 'tariff.update');
  assert.equal(au[0].reason, null);
  const o = (await onboarding()).json;
  assert.equal(stepsOf(o).tariffs, true);
  // Цена у гостя: будни 600 ₽/ч или выходные 900 ₽/ч по местному времени клуба.
  const tbl = (await capi('GET', `/api/t/${S.tables[0].code}`)).json;
  assert.ok([60_000, 90_000].includes(tbl.price_now.price_per_hour_kopecks), JSON.stringify(tbl.price_now));
  t.diagnostic(`шаблоны: ${ids.join(', ')}; только будни — 400 ${JSON.stringify(gap.json)}; лишнее правило — 400 ${JSON.stringify(over.json)}; сохранено ${rules.length} правила, журнал tariff.update без причины; у гостя сейчас ${tbl.price_now.price_per_hour_kopecks / 100} ₽/ч`);
});

test('T26-4: меню из .xlsx — предпросмотр, затем загрузка; не-zip под типом xlsx — xlsx_invalid; алкоголь не в QR-меню', async (t) => {
  const file = makeXlsx(MENU_ROWS);
  const notZip = await apiRaw('POST', `/api/clubs/${S.club}/catalog/import?dry_run=1`, { token: S.owner.token, body: Buffer.from('category,name\n'), contentType: XLSX_MIME, headers: { 'x-club-id': S.club } });
  assert.equal(notZip.status, 400);
  assert.equal(notZip.json?.error, 'xlsx_invalid', short(notZip));
  const dry = await apiRaw('POST', `/api/clubs/${S.club}/catalog/import?dry_run=1`, { token: S.owner.token, body: file, contentType: XLSX_MIME, headers: { 'x-club-id': S.club } });
  assert.equal(dry.status, 200, short(dry));
  const { rows: p0 } = await db.query('select count(*)::int as n from bl.products where club_id = $1', [S.club]);
  assert.equal(p0[0].n, 0, 'предпросмотр ничего не пишет');
  const imp = await apiRaw('POST', `/api/clubs/${S.club}/catalog/import`, { token: S.owner.token, body: file, contentType: XLSX_MIME, headers: { 'x-club-id': S.club } });
  assert.equal(imp.status, 200, short(imp));
  const { rows: prods } = await db.query('select name, price_kopecks::int as price_kopecks, is_alcohol from bl.products where club_id = $1 order by name', [S.club]);
  const byName = Object.fromEntries(prods.map((p) => [p.name, p]));
  assert.equal(byName['Вода e2e']?.price_kopecks, 12_000);
  assert.equal(byName['Чай e2e']?.price_kopecks, 15_050);
  assert.equal(byName['Орешки e2e']?.price_kopecks, 9_000, 'формула — сохранённое значение');
  assert.equal(byName['Пиво e2e']?.is_alcohol, true);
  const menu = await capi('GET', `/api/clubs/${S.club}/menu`);
  assert.equal(menu.status, 200, short(menu));
  const names = menu.json.categories.flatMap((c) => c.products.map((p) => p.name));
  assert.ok(!names.includes('Пиво e2e'), 'алкоголь гостю не показывается');
  const o = (await onboarding()).json;
  assert.equal(stepsOf(o).menu, true);
  saveState({ products: prods.length });
  t.diagnostic(`не-zip — 400 xlsx_invalid; предпросмотр 200 (${JSON.stringify(dry.json).slice(0, 160)}…), товаров 0; загрузка 200: ${prods.map((p) => `${p.name} ${p.price_kopecks / 100}${p.is_alcohol ? ' (алк.)' : ''}`).join(', ')}; QR-меню без входа: ${names.join(', ')}`);
});

test('T26-5: приглашение ресепшена ссылкой — текст без телефона, вход принимает приглашение', async (t) => {
  S.recPhone = staffPhone();
  const r = await capi('POST', `/api/clubs/${S.club}/staff/invites`, { token: S.owner.token, club: S.club, body: { phone: S.recPhone, role: 'reception' } });
  assert.equal(r.status, 201, short(r));
  assert.equal(r.json.invite_url, 'https://localhost:8443/club/');
  assert.ok(r.json.invite_text.includes(r.json.invite_url), 'ссылка в тексте');
  assert.deepEqual(phonesIn(r.json.invite_text), [], 'без телефона в тексте');
  assert.ok(!r.json.invite_text.includes(S.recPhone.slice(-7)));
  const rec = await loginRetry(S.recPhone, { consent: false });
  const me = (await capi('GET', '/api/me', { token: rec.token })).json;
  const c = me.clubs.find((x) => (x.club_id ?? x.id) === S.club);
  assert.ok(c, 'приглашение принято при первом входе');
  assert.ok([c.role, ...(c.roles ?? [])].includes('reception'));
  assert.equal(c.mode, 'test');
  const o = (await onboarding()).json;
  assert.equal(stepsOf(o).staff, true);
  saveState({ recPhone: S.recPhone });
  t.diagnostic(`invite_url ${r.json.invite_url}; текст: «${r.json.invite_text}»; ресепшн вошёл — клуб в /api/me с ролью reception, mode test`);
});

test('T26-6: тестовый магазин 800001 (/v3/me), маска ключа; проверочный платёж 1 ₽ — вебхук и возврат', async (t) => {
  const put = await capi('PUT', `/api/clubs/${S.club}/payment-settings/test`, { token: S.owner.token, club: S.club, body: SHOPS.test });
  assert.equal(put.status, 200, short(put));
  assert.equal(put.json.test, true);
  assert.equal(put.json.shop_id, '800001');
  assert.deepEqual(put.json.secret_mask, { last4: SHOPS.test.secret_key.slice(-4), length: SHOPS.test.secret_key.length });
  assert.ok(!put.text.includes(SHOPS.test.secret_key));
  const chk = await capi('POST', `/api/clubs/${S.club}/payment-settings/test/check`, { token: S.owner.token, club: S.club, body: {} });
  assert.equal(chk.status, 201, short(chk));
  const pid = providerId({ confirmation: { url: chk.json.confirmation_url } });
  const ep = emu(`/__emu/payments/${pid}`);
  assert.equal(ep.amount?.value, '1.00');
  assert.equal(ep.shop_id, '800001', 'проверочный платёж — в тестовый магазин');
  assert.ok(ep.receipt, 'чек в запросе платежа (инвариант 7)');
  emuSucceed(pid);
  const pc = await waitFor(
    async () => {
      const o = (await onboarding()).json;
      const c = o.payment_checks.test;
      return c && c.status === 'succeeded' && c.webhook_at && c.refunded ? { o, c } : null;
    },
    { timeoutMs: 60_000, intervalMs: 1000, what: 'проверочный платёж: succeeded, вебхук, возврат' },
  );
  const ep2 = emu(`/__emu/payments/${pid}`);
  const refunds = (ep2.receipts ?? []).map((r) => r.type ?? r.receipt_type ?? '?');
  const au = await clubAudit(db, S.club, { actions: ['club.payment_settings', 'club.shop_check', 'club.shop_check_refunded'] });
  const { rows: pay } = await db.query('select count(*)::int as n from bl.payments where club_id = $1', [S.club]);
  assert.equal(pay[0].n, 0, 'проверочный платёж — не в bl.payments');
  assert.equal(stepsOf(pc.o).payments, true);
  t.diagnostic(`PUT test → test:true, маска ${JSON.stringify(put.json.secret_mask)}; check → ${chk.json.status}, ЮKassa ${pid.slice(0, 8)} 1.00 ₽; затем succeeded via ${pc.c.confirmed_via}, вебхук ${pc.c.webhook_at}, возврат ${pc.c.refund_status}; магазин эмулятора ${ep2.shop_id}, чеки эмулятора: ${refunds.join(', ') || 'нет'}; журнал ${au.map((x) => x.action).join(', ')}; шаг payments done`);
});

test('T26-7: 2 новых контроллера — заводской реестр, симулятор --claim, привязка по BLD1-QR', async (t) => {
  const f = provisionFactory(2, `t26-${Date.now()}`);
  assert.equal(f.devices.length, 2);
  for (const d of f.devices) assert.match(d.qr, /^BLD1:[0-9a-f-]{36}:[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const pdf = readFileSync(f.pdf);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const { rows: fac } = await db.query('select device_id, claim_code_hash from bl.device_factory where device_id = any($1::uuid[])', [f.devices.map((d) => d.device_id)]);
  assert.equal(fac.length, 2, 'в реестре');
  assert.ok(fac.every((r) => !JSON.stringify(r).includes(f.devices[0].claim_code) && !JSON.stringify(r).includes(f.devices[1].claim_code)), 'в базе только хеш');
  S.devices = f.devices;
  const sim = startClaimSim({ qrs: f.devices.map((d) => d.qr), port: PORT, tag: 't26' });
  saveState({ devices: f.devices, simPid: sim.pid, simLog: sim.log });
  await waitFor(async () => (await claimSim(PORT).catch(() => null))?.length === 2, { timeoutMs: 20_000, what: 'симулятор --claim поднялся' });
  // Окна привязки ещё нет — контроллер ждёт (forbidden).
  await waitFor(() => simLog('t26').some((l) => l.msg === 'sim_claim_failed' && /forbidden/.test(JSON.stringify(l))), { timeoutMs: 20_000, what: 'sim_claim_failed forbidden до привязки' });
  const badQr = await capi('POST', `/api/clubs/${S.club}/devices/bind`, { token: S.owner.token, club: S.club, body: { qr: `BLD2:${f.devices[0].device_id}:XXXX`, resource_id: S.tables[0].id } });
  assert.equal(badQr.status, 400);
  assert.equal(badQr.json.error, 'qr_invalid');
  const tBind = Date.now();
  for (const [i, d] of f.devices.entries()) {
    const r = await capi('POST', `/api/clubs/${S.club}/devices/bind`, { token: S.owner.token, club: S.club, body: { qr: d.qr, resource_id: S.tables[i].id } });
    assert.equal(r.status, 200, short(r));
    assert.equal(r.json.device_id, d.device_id);
  }
  const nums = {};
  for (const [i, d] of f.devices.entries()) {
    const list = await claimSim(PORT);
    const n = list.find((x) => x.device_id === d.device_id).table;
    nums[d.device_id] = n;
    const st = await waitClaimSim(PORT, n, (x) => x.claim?.state === 'claimed' && x.online && x.state?.mode === 'free', { timeoutMs: 90_000, what: `контроллер ${n} claimed и online` });
    S.tables[i].sim = n;
    S.tables[i].device_id = d.device_id;
    t.diagnostic(`стол №${S.tables[i].number} ← контроллер ${n} (${d.device_id.slice(0, 8)}): claim ${JSON.stringify({ state: st.claim.state, attempts: st.claim.attempts, failures: st.claim.failures })}, online, mode free`);
  }
  const claimedAt = simLog('t26').filter((l) => l.msg === 'sim_claimed' && new Date(l.t).getTime() >= tBind).map((l) => new Date(l.t).getTime() - tBind);
  const { rows: dev } = await db.query('select id, resource_id, club_id, last_seen_at from bl.devices where id = any($1::uuid[])', [f.devices.map((d) => d.device_id)]);
  assert.equal(dev.length, 2);
  assert.ok(dev.every((d) => d.club_id === S.club));
  const au = await clubAudit(db, S.club, { actions: ['device.bind', 'device.claim'] });
  assert.equal(au.filter((x) => x.action === 'device.bind' && x.data.via === 'qr' && x.data.factory === true).length, 2);
  assert.equal(au.filter((x) => x.action === 'device.claim').length, 2);
  const o = (await onboarding()).json;
  assert.equal(stepsOf(o).devices, true, JSON.stringify(o.checklist.items.find((x) => x.id === 'devices')));
  saveState({ tables: S.tables });
  t.diagnostic(`provision-factory: ${f.stderr}; BLD2 — 400 qr_invalid; bind по QR ×2 (factory:true, via qr); sim_claimed через ${claimedAt.map((x) => `${Math.round(x / 1000)} с`).join(', ')} после привязки; device.claim ×2; пункт devices ok; процесс симулятора ${processAlive(sim.pid) ? 'жив' : 'НЕ ЖИВ'}`);
});

test('T26-8: наклейки столов — PDF, отметка печати, журнал qr.stickers_printed', async (t) => {
  const ids = S.tables.map((x) => x.id).join(',');
  const r = await apiRaw('GET', `/api/clubs/${S.club}/qr-stickers.pdf?resources=${ids}`, { token: S.owner.token, headers: { 'x-club-id': S.club } });
  assert.equal(r.status, 200, short(r));
  assert.match(String(r.headers['content-type']), /application\/pdf/);
  assert.equal(r.buf.subarray(0, 5).toString(), '%PDF-');
  const bad = await apiRaw('GET', `/api/clubs/${S.club}/qr-stickers.pdf?resources=nope`, { token: S.owner.token, headers: { 'x-club-id': S.club } });
  assert.equal(bad.status, 400);
  const au = await clubAudit(db, S.club, { actions: ['qr.stickers_printed'] });
  assert.ok(au.length >= 1);
  const o = (await onboarding()).json;
  assert.equal(stepsOf(o).stickers, true);
  t.diagnostic(`PDF ${r.buf.length} байт; неверный список — 400; журнал qr.stickers_printed; шаги ${JSON.stringify(stepsOf(o))}`);
});

test('T26-9: гость сканирует QR — режим test, платит тестовой картой, свет по подписанной команде, гаснет сам', async (t) => {
  const tb = S.tables[0];
  const qr = await apiRaw('GET', `/t/${tb.code}`);
  assert.equal(qr.status, 302);
  assert.equal(qr.headers.location, `/app/t/${tb.code}`);
  const guest = await newGuest();
  const tbl = (await capi('GET', `/api/t/${tb.code}`, { token: guest.token })).json;
  assert.equal(tbl.club.mode, 'test', 'гость видит тестовый режим (плашка)');
  assert.equal(tbl.status, 'free');
  const q = await capi('POST', '/api/quotes', { token: guest.token, body: { resource_id: tb.id, kind: 'start', minutes: 1 } });
  assert.equal(q.status, 200, short(q));
  const pay = await capi('POST', `/api/quotes/${q.json.quote_id}/pay`, { token: guest.token, body: { method: 'card' }, idem: true });
  assert.equal(pay.status, 200, short(pay));
  const pid = providerId(pay.json);
  const ep = emu(`/__emu/payments/${pid}`);
  assert.equal(ep.shop_id, '800001', 'оплата гостя в test — тестовый магазин клуба');
  const tPaid = Date.now();
  emuSucceed(pid);
  const p = await waitPaymentSession(guest.token, pay.json.payment_id, { timeoutMs: 20_000 });
  const lit = await waitClaimSim(PORT, tb.sim, (x) => x.state?.relay === true, { timeoutMs: 15_000, what: 'свет включён' });
  const tLit = Date.now();
  const { rows: pr } = await db.query('select is_test, status, amount_kopecks, confirmed_at from bl.payments where id = $1', [pay.json.payment_id]);
  const { rows: sr } = await db.query('select is_test, status, paid_until from bl.sessions where id = $1', [p.session_id]);
  assert.equal(pr[0].is_test, true, 'платёж тестовый');
  assert.equal(sr[0].is_test, true, 'сессия тестовая');
  const { cmds, missing } = await clubCmdsWithAudit(db, S.club, [tb.device_id], new Date(tPaid - 5000));
  const start = cmds.find((c) => c.type === 'session.start');
  assert.ok(start, 'session.start в bl.device_commands');
  assert.deepEqual(missing, [], 'у каждой команды есть device.cmd');
  const { rows: dc } = await db.query("select data from bl.audit_log where club_id = $1 and action = 'device.cmd' and data->>'cmd_id' = $2", [S.club, start.id]);
  t.diagnostic(`/t/${tb.code} → 302 /app/t/${tb.code}; /api/t: club.mode=test; карта: ЮKassa ${pid.slice(0, 8)} магазин ${ep.shop_id} test=${ep.test}; платёж is_test=${pr[0].is_test} ${pr[0].amount_kopecks / 100} ₽, сессия is_test=${sr[0].is_test}; свет через ${tLit - tPaid} мс (опрос), relay=${lit.state.relay} mode=${lit.state.mode}; session.start ${start.id.slice(0, 8)} ack ${start.status}, device.cmd ${JSON.stringify(dc[0]?.data).slice(0, 160)}`);
  // Конец игры: 1 мин + льгота — свет гаснет сам.
  const off = await waitClaimSim(PORT, tb.sim, (x) => x.state?.relay === false && x.state?.mode === 'free', { timeoutMs: 5 * 60_000, what: 'свет погас по окончании' });
  const tOff = Date.now();
  const paidUntil = new Date(sr[0].paid_until).getTime();
  const after2 = await clubCmdsWithAudit(db, S.club, [tb.device_id], new Date(tPaid - 5000));
  assert.deepEqual(after2.missing, []);
  const s2 = await waitFor(async () => {
    const { rows } = await db.query('select status from bl.sessions where id = $1', [p.session_id]);
    return rows[0].status === 'closed' ? rows[0] : null;
  }, { timeoutMs: 60_000, what: 'сессия closed' });
  const relays = simLog('t26').filter((l) => ['sim_relay', 'sim_state'].includes(l.msg) && l.table === tb.sim && 'relay' in l);
  const o = (await onboarding()).json;
  assert.equal(stepsOf(o).test, true, 'шаг «тестовая игра» выполнен');
  saveState({ testSession: p.session_id, testPayment: pay.json.payment_id });
  t.diagnostic(`свет погас через ${Math.round((tOff - paidUntil) / 1000)} с после paid_until (льгота), mode ${off.state.mode}; сессия ${s2.status}; команды ${after2.cmds.map((c) => `${c.type}/${c.status}`).join(', ')}, без device.cmd: ${after2.missing.length}; реле в логе симулятора: ${[...new Set(relays.map((l) => `${l.msg}:${l.relay}`))].join(' → ')}`);
});

test('T26-10: итог мастера — 9 шагов из 10, в чек-листе осталось: боевой магазин, ККТ, оферта', async (t) => {
  await sleep(500);
  const o = (await onboarding()).json;
  const st = stepsOf(o);
  const notDone = Object.entries(st).filter(([, v]) => !v).map(([k]) => k);
  const failed = o.checklist.items.filter((i) => !i.ok).map((i) => i.id);
  t.diagnostic(`шаги не выполнены: ${notDone.join(', ')}; чек-лист не выполнен: ${o.checklist.items.filter((i) => !i.ok).map((i) => `${i.id} «${i.detail}»`).join('; ')}`);
  assert.deepEqual(notDone, ['go_live']);
  assert.deepEqual(failed.sort(), ['kkt', 'offer', 'shop_live'].sort());
});
