/*
 * BL_MOCK_MARKER — заглушка M5.1 «Подключение клуба без выезда» (только VITE_MOCK=1), по docs/contracts/m5-1.md §4.
 * Где контракт молчит — формы ответов из допущений frontend (web/admin/README.md, раздел M5.1).
 *
 * Сценарии: onboarding — новый пользователь без клубов (вход, «Подключить клуб», мастер с нуля; у него одобрена
 * заявка «Подтвердить клуб» на карточку «Клуб „Свояк“»); testmode — клуб разработки в тестовом режиме (ресепшн,
 * плашка), testmode-owner — он же у владельца: шаги почти все сделаны, чек-лист — без боевого магазина.
 *
 * Правила эмулятора ЮKassa: идентификатор магазина — цифры; ключ тестового магазина начинается с test_, боевого —
 * с live_ (иначе shop_mode_mismatch); боевой магазин с идентификатором на 0 — без чеков (fiscalization_off).
 * Проверочный платёж проходит через 3 с, уведомление — через 5 с, возврат 1 ₽ — через 7 с.
 * Контроллер после привязки по QR выходит на связь через 5 с. QR для проверки: BLD1:{uuid}:{код от 6 знаков}.
 */

import { buildRules, defaultTariffForm, hallHasCourts, hallTypes, isCourtRule, ruleKind, weekCoverage } from '../lib/tariffs.js';
import { parseBld1 } from '../lib/onboarding.js';
import { menuFromCsv } from '../lib/csv.js';

const MIN = 60_000;
const uuid = () => globalThis.crypto.randomUUID();
const iso = (t) => new Date(t).toISOString();
const KIND_TYPE = { pyramid: 'billiard_pyramid', pool: 'billiard_pool', snooker: 'billiard_snooker', mixed: 'billiard_mixed', padel_court: 'padel_court' };
/** M5.8: семья вида мастера — у столов и кортов своя нумерация, стол ↔ корт — 400 bad_request (как server/setup/hall.mjs). */
const familyOfKind = (kind) => (kind === 'padel_court' ? 'court' : 'table');
const familyOfRes = (r) => (r?.family === 'court' || r?.type === 'padel_court' ? 'court' : 'table');
const SLOT_MINUTES = [60, 90, 120];
const BUSY_REASON = { busy: 'session', pending: 'pending', reserved: 'reserved', service: 'service' };
const CODE_ABC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const tableCode = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(10)), (b) => CODE_ABC[b % 32]).join('');
const PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';

export const NEWCOMER = { id: 'u-new-0009', name: null, phone_masked: '+7 *** ***-00-09', role: null };

const CITIES = [
  { id: 'c0000000-0000-4000-8000-0000000000e1', slug: 'ekaterinburg', name: 'Екатеринбург', name_in: 'в Екатеринбурге', region: 'Свердловская область', timezone: 'Asia/Yekaterinburg', clubs: 3, free_now: 0 },
  { id: 'c0000000-0000-4000-8000-0000000000e2', slug: 'perm', name: 'Пермь', name_in: 'в Перми', region: 'Пермский край', timezone: 'Asia/Yekaterinburg', clubs: 1, free_now: 0 },
  { id: 'c0000000-0000-4000-8000-0000000000e3', slug: 'moskva', name: 'Москва', name_in: 'в Москве', region: null, timezone: 'Europe/Moscow', clubs: 0, free_now: 0 },
];

/**
 * Тарифы клуба разработки: шаблон «Будни и выходные × день и вечер», как в сиде. courts — и правила корта:
 * слот 1,5 ч — 2 400 ₽ днём, 3 000 ₽ вечером (M5.8); в ответе у правила корта min и шаг — слот, цена часа — справочная.
 */
function devRules(courts = false) {
  const form = { ...defaultTariffForm('weekend_day_evening'), weekend: [5, 6, 7], prices: { wd_day: '500', wd_eve: '800', we_day: '600', we_eve: '1000', 'wd_day:padel_court': '2400', 'wd_eve:padel_court': '3000', 'we_day:padel_court': '2700', 'we_eve:padel_court': '3300' } };
  return buildRules(form, ['pyramid', 'pool'], '06:00', courts).map(courtView);
}

/** Правило корта, как его отдаёт сервер: min_minutes = step_minutes = слот, price_per_hour_kopecks — справочно. */
function courtView(r) {
  if (!isCourtRule(r)) return r;
  return { ...r, min_minutes: r.slot_minutes, step_minutes: r.slot_minutes, price_per_hour_kopecks: Math.max(1, Math.floor((r.price_per_slot_kopecks * 120 + r.slot_minutes) / (2 * r.slot_minutes))) };
}

export function m5State(scenario, t) {
  const fresh = scenario === 'onboarding';
  const testDev = String(scenario ?? '').startsWith('testmode');
  const courts = String(scenario ?? '').startsWith('court');
  return {
    // Клубы, созданные в заглушке; пусто — у вошедшего клуб разработки (его режим — devMode)
    clubs: [],
    devMode: testDev ? 'test' : 'live',
    // M5.8: в ?mock=court… зал больше — под столами два корта 10,6 × 20,6 м; court-owner-gap — у кортов нет цены
    hallSize: fresh ? null : scenario === 'court-small' ? { width: 1600, height: 1000 } : courts ? { width: 2400, height: 3700 } : { width: 1800, height: 1400 },
    tariffs: fresh ? [] : devRules(courts && scenario !== 'court-owner-gap'),
    shops: {
      test: fresh ? null : { shop_id: '506751', secret_mask: { last4: '9f2c', length: 48 }, verified_at: iso(t - 3 * 24 * 60 * MIN), test: true, fiscalization: true },
      live: null,
    },
    checks: { test: fresh ? null : { payment_id: uuid(), status: 'succeeded', refunded: true, webhook_at: iso(t - 3 * 24 * 60 * MIN), created_at: iso(t - 3 * 24 * 60 * MIN) }, live: null },
    stickersAt: fresh ? null : t - 2 * 24 * 60 * MIN,
    // GET /api/clubs/claimable-listings: одобренная «Подтвердить клуб», ещё не связанная с клубом
    claimable: fresh
      ? [{ listing_id: 'c1000000-0000-4000-8000-0000000000bb', name: 'Клуб «Свояк»', address: 'ул. Малышева, 5', city: 'Екатеринбург', city_id: CITIES[0].id, timezone: 'Asia/Yekaterinburg' }]
      : [],
    retired: [],
    binds: [],
    // Касса ресепшена (PATCH …/payment-settings reception_enabled); у клуба разработки мост ККТ на связи
    kktEnabled: !fresh,
    bridgeOk: !fresh,
  };
}

/** Зал как у сервера: столы, затем корты, внутри — по номеру. */
const hallOrder = (a, c) => Number(familyOfRes(a.resource) === 'court') - Number(familyOfRes(c.resource) === 'court') || a.resource.number - c.resource.number;

export function m5Routes(ctx) {
  const { now, me, err, ok, emit, audit } = ctx;
  const S = () => ctx.state().m5;
  const st = () => ctx.state();
  const role = () => me()?.role;
  const owner = (fn) => (m, b, q) => (!me() ? err(401, 'unauthorized') : role() === 'owner' ? fn(m, b, q) : err(403, 'forbidden'));
  const manager = (fn) => (m, b, q) => (!me() ? err(401, 'unauthorized') : ['owner', 'manager'].includes(role()) ? fn(m, b, q) : err(403, 'forbidden'));
  const fail = (status, code, extra = {}) => ({ status, body: { error: code, ...extra } });
  const mode = () => (S().clubs.length ? S().clubs[0].mode : S().devMode);
  const live = () => mode() === 'live';

  /** Контроллеры, привязанные по QR, выходят на связь через 5 с; проверочные платежи идут по времени. */
  function advance() {
    const t = now();
    for (const b of S().binds) {
      if (b.done || t < b.online_at) continue;
      const tbl = st().hall.find((x) => x.resource.id === b.resource_id);
      b.done = true;
      if (!tbl) continue;
      tbl.device = { id: b.device_id, online: true, rssi: -58, fw: '1.0.0', caps: ['relay', 'led', 'buzzer', 'current'] };
      if (tbl.status === 'offline') tbl.status = 'free';
      audit('device.claimed', { resource_number: tbl.resource.number, data: { device_id: b.device_id } });
      emit('hall', tbl);
    }
    for (const c of Object.values(S().checks)) {
      if (!c?.timeline) continue;
      if (c.status === 'pending' && t >= c.timeline.paid) c.status = 'succeeded';
      if (!c.webhook_at && t >= c.timeline.webhook) c.webhook_at = iso(c.timeline.webhook);
      if (!c.refunded && t >= c.timeline.refund) c.refunded = true;
    }
  }

  const products = () => st().m2?.catalog?.products ?? [];
  const staff = () => st().m3?.staff ?? [];
  const invites = () => st().m3?.invites ?? [];

  /** Типы столов для проверки недели: в работе и упомянутые в правилах (как server/setup/tariffs.mjs); корты — свои правила. */
  const weekKinds = (rules) => [...new Set([...hallTypes(st().hall), ...(hallHasCourts(st().hall) ? ['padel_court'] : []), ...rules.map(ruleKind).filter(Boolean)])];
  function weekProblem(rules) {
    for (const kind of weekKinds(rules)) {
      const cov = weekCoverage(rules, kind);
      if (cov.gaps[0]) return { code: 'tariff_gap', kind, ...cov.gaps[0] };
      if (cov.overlaps[0]) return { code: 'tariff_overlap', kind, ...cov.overlaps[0] };
    }
    return null;
  }
  const coversWeek = (rules) => rules.length > 0 && !weekProblem(rules);
  const shopReady = (m) => {
    const s = S().shops[m];
    return Boolean(s?.verified_at) && (m === 'test' ? s.test === true : s.test === false && s.fiscalization === true);
  };
  const checkDone = (m) => S().checks[m]?.status === 'succeeded' && Boolean(S().checks[m].webhook_at);
  const devicesOk = () => st().hall.length > 0 && st().hall.every((x) => x.device?.id && x.device.online);

  function checklist() {
    const offline = st().hall.filter((x) => !(x.device?.id && x.device.online)).map((x) => x.resource.number);
    const items = [
      { id: 'tables', ok: st().hall.length > 0, detail: st().hall.length ? null : 'В зале нет столов.' },
      { id: 'devices', ok: devicesOk(), detail: offline.length ? `Без связи: ${offline.map((n) => `стол ${n}`).join(', ')}.` : null },
      { id: 'tariffs', ok: coversWeek(S().tariffs), detail: null },
      { id: 'shop_live', ok: shopReady('live'), detail: S().shops.live ? null : 'Боевой магазин ещё не подключён.' },
      { id: 'kkt', ok: !S().kktEnabled || S().bridgeOk, detail: S().kktEnabled && !S().bridgeOk ? 'Мост ККТ не на связи.' : null },
      { id: 'stickers', ok: Boolean(S().stickersAt), detail: null },
      { id: 'offer', ok: mode() === 'live', detail: null },
    ];
    return { items, ready: items.every((i) => i.ok || i.id === 'offer') };
  }

  function onboardingView() {
    advance();
    const staffDone = staff().filter((s) => s.active).length > 1 || invites().some((i) => !i.revoked);
    const steps = [
      { id: 'club', done: true },
      { id: 'hall', done: st().hall.length > 0 },
      { id: 'tariffs', done: coversWeek(S().tariffs) },
      { id: 'menu', done: products().length > 0 },
      { id: 'staff', done: staffDone },
      { id: 'payments', done: shopReady('test') && checkDone('test') },
      { id: 'devices', done: devicesOk() },
      { id: 'stickers', done: Boolean(S().stickersAt) },
      { id: 'test', done: checkDone('test') && devicesOk() },
      { id: 'go_live', done: mode() === 'live' },
    ];
    const strip = (c) => (c ? { payment_id: c.payment_id, status: c.status, refunded: c.refunded, webhook_at: c.webhook_at, created_at: c.created_at } : null);
    return {
      mode: mode(),
      steps,
      checklist: checklist(),
      hall: S().hallSize,
      day_start_local: '06:00',
      kkt_enabled: S().kktEnabled,
      webhook_url: `${globalThis.location?.origin ?? 'http://127.0.0.1:5174'}/api/webhooks/yookassa/${S().clubs[0]?.id ?? '0b6b8c1e-5a7d-4f0e-9c3a-2d1e4f5a6b7c'}`,
      offer: { version: '2026-10-23', accepted_at: mode() === 'live' ? iso(now()) : null, accepted_version: mode() === 'live' ? '2026-10-23' : null },
      shops: { test: S().shops.test, live: S().shops.live },
      payment_checks: { test: strip(S().checks.test), live: strip(S().checks.live) },
    };
  }

  function createClub(b) {
    if (!me()) return err(401, 'unauthorized');
    const name = String(b?.name ?? '').trim();
    if (name.length < 2 || name.length > 100) return err(400, 'bad_request');
    if (!/^[A-Za-z_]+\/[A-Za-z_]+$/.test(b?.timezone ?? '')) return err(400, 'bad_request');
    const city = b.city_id ? CITIES.find((c) => c.id === b.city_id)?.name : String(b.city_name ?? '').trim();
    if (!city) return err(400, 'bad_request');
    if (S().clubs.filter((c) => c.mode === 'test').length >= 3) return err(409, 'clubs_limit');
    const club = { id: uuid(), name, city, timezone: b.timezone, mode: 'test', listing_id: null };
    if (b.listing_id) {
      if (!S().claimable.some((c) => c.listing_id === b.listing_id)) return err(404, 'not_found');
      S().claimable = S().claimable.filter((c) => c.listing_id !== b.listing_id);
      club.listing_id = b.listing_id;
    }
    S().clubs.push(club);
    // Первый клуб нового пользователя: пустой зал, меню и персонал — только владелец
    if (S().clubs.length === 1) {
      st().user.role = 'owner';
      st().user.name = st().user.name ?? null;
      st().hall = [];
      st().requests = [];
      st().alarms = [];
      if (st().m2?.catalog) Object.assign(st().m2.catalog, { categories: [], products: [], modifier_groups: [] });
      if (st().m3) {
        st().m3.staff = [{ user_id: me().id, name: me().name ?? null, phone: '+79000000009', role: 'owner', active: true, pin_set: false }];
        st().m3.invites = [];
      }
      S().hallSize = null;
      S().tariffs = [];
      S().shops = { test: null, live: null };
      S().checks = { test: null, live: null };
      S().stickersAt = null;
      S().kktEnabled = false;
      S().bridgeOk = false;
      S().retired = [];
    }
    audit('club.create', { data: { club_id: club.id } });
    return { status: 201, body: { club_id: club.id, mode: 'test' } };
  }

  function saveShop(m, b) {
    if (!['test', 'live'].includes(m)) return err(404, 'not_found');
    if (live() && !String(b?.reason ?? '').trim()) return err(400, 'reason_required');
    const shopId = String(b?.shop_id ?? '').trim();
    if (!/^\d{3,12}$/.test(shopId)) return err(400, 'shop_invalid');
    const key = String(b?.secret_key ?? '').trim();
    const prev = S().shops[m];
    if (!key && !prev) return err(400, 'shop_invalid');
    if (key && !/^(test|live)_[A-Za-z0-9_-]{6,}$/.test(key)) return err(400, 'shop_invalid');
    if (key && !key.startsWith(`${m}_`)) return err(400, 'shop_mode_mismatch');
    if (m === 'live' && shopId.endsWith('0')) return err(400, 'fiscalization_off');
    S().shops[m] = {
      shop_id: shopId,
      secret_mask: key ? { last4: key.slice(-4), length: key.length } : prev.secret_mask,
      verified_at: iso(now()),
      test: m === 'test',
      fiscalization: true,
    };
    if (prev?.shop_id !== shopId) S().checks[m] = null;
    audit(live() ? 'manual.payment_settings' : 'club.payment_settings', { reason: b?.reason ?? null, data: { mode: m } });
    return ok(S().shops[m]);
  }

  function saveTariffs(b) {
    if (live() && !String(b?.reason ?? '').trim()) return err(400, 'reason_required');
    const rules = Array.isArray(b?.rules) ? b.rules : null;
    if (!rules?.length) return err(400, 'bad_request');
    if (rules.length > 100) return err(400, 'bad_request');
    const slots = new Set();
    for (const r of rules) {
      if (r.kind !== undefined && r.kind !== null && !KIND_TYPE[r.kind]) return err(400, 'bad_request');
      if (r.kind === 'padel_court') {
        // M5.8 (№212): цена за слот, слот 60/90/120 — один на вид; цена часа у корта не принимается
        if (!SLOT_MINUTES.includes(r.slot_minutes) || !Number.isInteger(r.price_per_slot_kopecks) || r.price_per_slot_kopecks <= 0 || r.price_per_hour_kopecks !== undefined) return err(400, 'bad_request');
        slots.add(r.slot_minutes);
        continue;
      }
      if (r.slot_minutes !== undefined || r.price_per_slot_kopecks !== undefined) return err(400, 'bad_request');
      if (!Number.isInteger(r.min_minutes) || !Number.isInteger(r.step_minutes) || !Number.isInteger(r.price_per_hour_kopecks)) return err(400, 'bad_request');
      if (r.price_per_hour_kopecks <= 0) return err(400, 'bad_request'); // №163: тариф 0 ₽ не бывает
    }
    if (slots.size > 1) return err(400, 'bad_request');
    const problem = weekProblem(rules);
    if (problem) return fail(400, problem.code, { kind: problem.kind, weekday: problem.weekday, from: problem.from, to: problem.to });
    S().tariffs = rules.map((r) => courtView({ ...r }));
    audit(live() ? 'manual.tariff_change' : 'tariff.update', { reason: b?.reason ?? null, data: { rules: rules.length } });
    return ok(tariffsView());
  }

  /** GET …/tariffs → { timezone, day_start_local, rules, resource_rules, coverage }. */
  function tariffsView() {
    const problem = weekProblem(S().tariffs);
    const slot = S().tariffs.find((r) => r.kind === 'padel_court')?.slot_minutes;
    return { timezone: S().clubs[0]?.timezone ?? 'Asia/Yekaterinburg', day_start_local: '06:00', rules: S().tariffs, resource_rules: [], coverage: { ok: S().tariffs.length > 0 && !problem, problem }, slots: slot ? { padel_court: slot } : {} };
  }

  /** Стол в форме server/setup/hall.mjs. */
  const resourceView = (r, active = true) => ({ id: r.id, number: r.number, kind: r.kind ?? (r.type === 'padel_court' ? 'padel_court' : /pool/.test(r.type) ? 'pool' : 'pyramid'), type: r.type, family: familyOfRes(r), title: r.title, code: r.code ?? null, plan_x: r.plan_x ?? 0, plan_y: r.plan_y ?? 0, plan_rotation: r.plan_rotation ?? 0, active, sticker_printed_at: S().stickersAt ? iso(S().stickersAt) : null });
  const planView = () => ({ width_cm: (S().hallSize ?? { width: 1800 }).width, height_cm: (S().hallSize ?? { height: 1200 }).height });

  function createTable(b) {
    if (live() && !String(b?.reason ?? '').trim()) return err(400, 'reason_required');
    const n = Number(b?.number);
    if (!Number.isInteger(n) || n < 1 || n > 999) return err(400, 'bad_request');
    if (!KIND_TYPE[b?.kind]) return err(400, 'bad_request');
    const fam = familyOfKind(b.kind);
    if (st().hall.some((x) => x.resource.number === n && familyOfRes(x.resource) === fam)) return err(409, 'duplicate');
    for (const k of ['plan_x', 'plan_y']) if (!Number.isInteger(b[k]) || b[k] < 0) return err(400, 'bad_request');
    const tbl = {
      resource: { id: uuid(), number: n, type: KIND_TYPE[b.kind], kind: b.kind, family: fam, title: `${fam === 'court' ? 'Корт' : 'Стол'} ${n}`, code: tableCode(), plan_x: b.plan_x, plan_y: b.plan_y, plan_rotation: b.plan_rotation ?? 0 },
      status: 'offline',
      session: null,
      until: null,
      device: null,
    };
    st().hall.push(tbl);
    st().hall.sort(hallOrder);
    audit('resource.create', { resource_number: n });
    emit('hall', tbl);
    return { status: 201, body: resourceView(tbl.resource) };
  }

  function patchTable(id, b) {
    const tbl = st().hall.find((x) => x.resource.id === id);
    if (!tbl) return err(404, 'not_found');
    if (b?.active === false) {
      if (live() && !String(b.reason ?? '').trim()) return err(400, 'reason_required');
      if (BUSY_REASON[tbl.status]) return fail(409, 'table_busy', { reason: BUSY_REASON[tbl.status], resource_id: tbl.resource.id });
      st().hall = st().hall.filter((x) => x !== tbl);
      S().retired.push(tbl.resource);
      audit(live() ? 'manual.resource_retire' : 'resource.retire', { resource_number: tbl.resource.number, reason: b.reason ?? null });
      return ok(resourceView(tbl.resource, false));
    }
    // №164: смена типа стола в боевом режиме — ручное действие с причиной
    const kindChange = b?.kind !== undefined && b.kind !== resourceView(tbl.resource).kind;
    // M5.8 (№213): стол не становится кортом и наоборот
    if (kindChange && KIND_TYPE[b.kind] && familyOfKind(b.kind) !== familyOfRes(tbl.resource)) return err(400, 'bad_request');
    if (kindChange && live() && !String(b.reason ?? '').trim()) return err(400, 'reason_required');
    if (b?.number !== undefined) {
      const n = Number(b.number);
      if (!Number.isInteger(n) || n < 1 || n > 999) return err(400, 'bad_request');
      if (st().hall.some((x) => x !== tbl && x.resource.number === n && familyOfRes(x.resource) === familyOfRes(tbl.resource))) return err(409, 'duplicate');
      tbl.resource.number = n;
      tbl.resource.title = `${familyOfRes(tbl.resource) === 'court' ? 'Корт' : 'Стол'} ${n}`;
    }
    if (b?.kind !== undefined) {
      if (!KIND_TYPE[b.kind]) return err(400, 'bad_request');
      Object.assign(tbl.resource, { kind: b.kind, type: KIND_TYPE[b.kind] });
    }
    for (const k of ['plan_x', 'plan_y']) {
      if (b?.[k] === undefined) continue;
      if (!Number.isInteger(b[k]) || b[k] < 0) return err(400, 'bad_request');
      tbl.resource[k] = b[k];
    }
    if (b?.plan_rotation !== undefined) {
      if (!Number.isInteger(b.plan_rotation) || b.plan_rotation < 0 || b.plan_rotation > 359) return err(400, 'bad_request');
      tbl.resource.plan_rotation = b.plan_rotation;
    }
    st().hall.sort(hallOrder);
    audit(kindChange && live() ? 'manual.resource_kind' : 'resource.update', { resource_number: tbl.resource.number, reason: kindChange && live() ? String(b.reason).trim() : null });
    emit('hall', tbl);
    return ok(resourceView(tbl.resource));
  }

  /** Импорт файлом: .xlsx — образец из трёх строк (разбор Excel — на сервере), .csv — как текст. */
  function importFile(b, dryRun) {
    const bytes = b.__raw instanceof Uint8Array ? b.__raw : new Uint8Array(b.__raw ?? []);
    if (bytes.length > 2 * 1024 * 1024) return err(413, 'too_large');
    let rows;
    if (/spreadsheetml/.test(b.__type ?? '')) {
      if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return err(400, 'xlsx_invalid');
      rows = [
        { line: 2, category: 'Кофе и чай', name: 'Американо', price_kopecks: 18000, unit: 'шт', is_alcohol: false, vat_code: null },
        { line: 3, category: 'Напитки', name: 'Вода без газа, 0,5 л', price_kopecks: 9000, unit: 'шт', is_alcohol: false, vat_code: null },
        { line: 4, category: 'Закуски', name: 'Фисташки, 50 г', price_kopecks: 25000, unit: 'шт', is_alcohol: false, vat_code: null },
        { line: 5, category: 'Пиво и сидр', name: 'Светлое разливное, 0,5 л', price_kopecks: 29000, unit: 'шт', is_alcohol: true, vat_code: 11 },
      ];
    } else {
      const parsed = menuFromCsv(new TextDecoder().decode(bytes));
      if (parsed.errors.length) return ok({ applied: false, created: 0, updated: 0, unchanged: 0, categories_created: [], errors: parsed.errors.map((e) => ({ line: e.line, field: null, code: 'bad_name' })), rows: [] });
      rows = parsed.rows;
    }
    const cat = st().m2.catalog;
    let created = 0;
    let updated = 0;
    const newCats = [];
    for (const r of rows) {
      let c = r.category ? cat.categories.find((x) => x.name.toLowerCase() === r.category.toLowerCase()) : null;
      if (r.category && !c && !newCats.includes(r.category)) newCats.push(r.category);
      if (r.category && !c && !dryRun) {
        c = { id: uuid(), name: r.category, sort: cat.categories.length + 1, active: true };
        cat.categories.push(c);
      }
      const existing = cat.products.find((p) => p.name.toLowerCase() === r.name.toLowerCase());
      if (existing) updated += 1;
      else created += 1;
      if (dryRun) continue;
      if (existing) Object.assign(existing, { price_kopecks: r.price_kopecks, unit: r.unit, is_alcohol: r.is_alcohol });
      else {
        cat.products.push({ id: uuid(), category_id: c?.id ?? null, name: r.name, description: null, sku: null, price_kopecks: r.price_kopecks, unit: r.unit, is_alcohol: r.is_alcohol, vat_code: r.vat_code ?? null, payment_subject: r.is_alcohol ? 'excise' : 'commodity', stop_list: false, track_stock: true, photo: null, sort: cat.products.length + 1, active: true, modifier_group_ids: [], stock_qty: 0, cost_kopecks: 0, min_qty: null });
      }
    }
    return ok({ applied: !dryRun, created, updated, unchanged: 0, categories_created: newCats, errors: [], rows: dryRun ? rows : undefined });
  }

  function invite(b) {
    if (!/^\+7\d{10}$/.test(b?.phone ?? '')) return err(400, 'bad_request');
    if (!['manager', 'reception', 'installer', 'bar'].includes(b.role)) return err(400, 'bad_request');
    if (staff().some((s) => s.active && s.phone === b.phone)) return err(409, 'duplicate');
    const list = invites();
    let inv = list.find((i) => i.phone === b.phone && !i.revoked);
    if (inv) Object.assign(inv, { role: b.role, expires_at: now() + 7 * 24 * 60 * MIN });
    else {
      inv = { id: uuid(), phone: b.phone, role: b.role, created_at: now(), expires_at: now() + 7 * 24 * 60 * MIN };
      list.unshift(inv);
    }
    audit('staff.invite', { data: { role: b.role } });
    const club = S().clubs[0]?.name ?? 'Клуб для разработки';
    const roleWord = { manager: 'управляющим', reception: 'администратором ресепшена', installer: 'монтажником', bar: 'барменом' }[b.role];
    const url = `${globalThis.location?.origin ?? 'http://127.0.0.1:5174'}/club/`;
    const masked = `+7 *** ***-${b.phone.slice(-4, -2)}-${b.phone.slice(-2)}`;
    return {
      status: 201,
      body: {
        id: inv.id,
        phone_masked: masked,
        role: inv.role,
        created_at: iso(inv.created_at),
        expires_at: iso(inv.expires_at),
        invite_url: url,
        invite_text: `Вас пригласили в «${club}» ${roleWord}. Откройте ${url} и войдите через MAX или Telegram с номером ${masked} — доступ откроется сам. Приглашение действует 7 дней.`,
      },
    };
  }

  const routes = [
    ['GET', /^\/api\/public\/cities$/, () => ok({ items: CITIES })],
    ['GET', /^\/api\/clubs\/claimable-listings$/, () => (me() ? ok({ items: S().claimable }) : err(401, 'unauthorized'))],
    ['POST', /^\/api\/clubs$/, (_m, b) => createClub(b)],
    // Управляющему — без магазинов (shops: null), как у сервера
    ['GET', /^\/api\/clubs\/([^/]+)\/onboarding$/, manager(() => ok(role() === 'owner' ? onboardingView() : { ...onboardingView(), shops: null }))],
    ['POST', /^\/api\/clubs\/([^/]+)\/go-live$/, owner((_m, b) => {
      if (b?.accept_offer !== true) return fail(409, 'checklist_incomplete', { failed: ['offer'] });
      advance();
      const failed = checklist().items.filter((i) => !i.ok && i.id !== 'offer').map((i) => i.id);
      if (failed.length) return fail(409, 'checklist_incomplete', { failed });
      if (S().clubs.length) S().clubs[0].mode = 'live';
      else S().devMode = 'live';
      audit('club.go_live', {});
      return ok({ mode: 'live' });
    })],
    // Настройки оплаты клуба: касса ресепшена — пункт чек-листа kkt
    ['GET', /^\/api\/clubs\/([^/]+)\/payment-settings$/, owner(() => ok({ settings: paySettings(), shops: { test: S().shops.test, live: S().shops.live } }))],
    ['PATCH', /^\/api\/clubs\/([^/]+)\/payment-settings$/, owner((_m, b) => {
      if (live() && !String(b?.reason ?? '').trim()) return err(400, 'reason_required');
      if (b?.reception_enabled !== undefined) {
        if (typeof b.reception_enabled !== 'boolean') return err(400, 'bad_request');
        S().kktEnabled = b.reception_enabled;
      }
      audit(live() ? 'manual.payment_settings' : 'club.payment_settings', { reason: b?.reason ?? null, data: { reception_enabled: S().kktEnabled } });
      return ok({ settings: paySettings() });
    })],
    ['GET', /^\/api\/clubs\/([^/]+)\/payment-settings\/(test|live)$/, owner((m) => ok(S().shops[m[2]] ?? { shop_id: null, secret_mask: null, verified_at: null, test: null, fiscalization: null }))],
    ['PUT', /^\/api\/clubs\/([^/]+)\/payment-settings\/(test|live)$/, owner((m, b) => saveShop(m[2], b))],
    ['POST', /^\/api\/clubs\/([^/]+)\/payment-settings\/(test|live)\/check$/, owner((m) => {
      const md = m[2];
      if (!S().shops[md]?.verified_at) return err(409, 'not_configured');
      const t = now();
      S().checks[md] = { payment_id: uuid(), status: 'pending', refunded: false, webhook_at: null, created_at: iso(t), timeline: { paid: t + 3000, webhook: t + 5000, refund: t + 7000 } };
      audit('payment.check', { data: { mode: md } });
      return { status: 201, body: { payment_id: S().checks[md].payment_id, status: 'pending', confirmation_url: null } };
    })],
    ['PUT', /^\/api\/clubs\/([^/]+)\/hall$/, manager((_m, b) => {
      const ok2 = (v) => Number.isInteger(v) && v >= 300 && v <= 10000;
      if (!ok2(b?.width) || !ok2(b?.height)) return err(400, 'bad_request');
      S().hallSize = { width: b.width, height: b.height };
      return ok({ plan: planView() });
    })],
    ['GET', /^\/api\/clubs\/([^/]+)\/resources$/, manager(() => ok({ plan: planView(), resources: [...st().hall.map((x) => resourceView(x.resource)), ...S().retired.map((r) => resourceView(r, false))] }))],
    ['POST', /^\/api\/clubs\/([^/]+)\/resources$/, manager((_m, b) => createTable(b))],
    ['PATCH', /^\/api\/clubs\/([^/]+)\/resources\/([^/]+)$/, manager((m, b) => patchTable(m[2], b))],
    ['GET', /^\/api\/clubs\/([^/]+)\/tariffs$/, manager(() => ok(tariffsView()))],
    ['PUT', /^\/api\/clubs\/([^/]+)\/tariffs$/, manager((_m, b) => saveTariffs(b))],
    ['POST', /^\/api\/clubs\/([^/]+)\/staff\/invites$/, owner((_m, b) => invite(b))],
    ['GET', /^\/api\/clubs\/([^/]+)\/qr-stickers\.pdf$/, manager((_m, _b, q) => {
      const ids = (q.get('resources') ?? '').split(',').filter(Boolean);
      if (ids.some((id) => !st().hall.some((x) => x.resource.id === id))) return err(404, 'not_found');
      S().stickersAt = now();
      return { status: 200, pdf: PDF };
    })],
    ['POST', /^\/api\/leads$/, (_m, b) => {
      if (b?.consent !== true) return err(403, 'consent_required');
      if (!/^\+7\d{10}$/.test(b?.phone ?? '') || !String(b?.name ?? '').trim()) return err(400, 'bad_request');
      return { status: 201, body: { ok: true } };
    }],
  ];

  function paySettings() {
    return { reception_enabled: S().kktEnabled, sbp_enabled: true, card_enabled: true, vat_code: 1, tax_system_code: null };
  }

  /** Привязка: { qr } или { device_id, claim_code } (№159); у стола — окно 30 минут, контроллер на связи через 5 с. */
  function bind(b) {
    if (!['owner', 'installer'].includes(role())) return err(403, 'forbidden');
    let deviceId = b?.device_id;
    if (b?.qr !== undefined) {
      const p = parseBld1(b.qr);
      if (!p) return err(400, 'qr_invalid');
      deviceId = p.device_id;
    } else if (!/^[0-9a-f-]{36}$/.test(b?.device_id ?? '') || !/^[A-Za-z0-9-]{6,64}$/.test(b?.claim_code ?? '')) return err(400, 'bad_request');
    if (!st().hall.some((x) => x.resource.id === b.resource_id)) return err(404, 'not_found');
    S().binds.push({ device_id: deviceId, resource_id: b.resource_id, online_at: now() + 5000 });
    return ok({ bind_until: iso(now() + 30 * MIN) });
  }

  return { routes, advance, importFile, bind, clubsFor: (user) => clubsFor(user) };

  /** Клубы вошедшего для GET /api/me: созданные в заглушке или клуб разработки с режимом. */
  function clubsFor(user) {
    if (!user?.role) return [];
    if (S().clubs.length) return S().clubs.map((c) => ({ club_id: c.id, role: user.role, name: c.name, timezone: c.timezone, mode: c.mode }));
    return null;
  }
}
