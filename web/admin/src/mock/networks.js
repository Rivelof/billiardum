/*
 * BL_MOCK_MARKER — заглушка M5.5 «Сети» (только VITE_MOCK=1), формы ответов — строго по server/networks/README.md
 * (ветка m5-5-networks, коммит 37fec7c).
 *
 * Сценарии:
 *   network          — владелец: сеть «Сеть Урал» из трёх клубов (два боевых в разных поясах, один в тесте вне рейтинга),
 *                      мягкие шаблоны тарифов и меню; у второго клуба появились снукерные столы — шаблон не покрывает его неделю;
 *                      в клубе разработки «Капучино» изменён в клубе; четвёртый клуб владельца — не в сети;
 *   network-hard     — то же, шаблоны жёсткие: в клубе тарифы и поля товаров сети не меняются (409 network_locked);
 *   network-empty    — владелец двух клубов без сети: «Создать сеть»;
 *   network-manager  — управляющий сети: клубы с network_id, без «Денег» и выгрузок, переключатель клубов в шапке;
 *   network-pin      — владелец вошёл по PIN на терминале: сеть только по личному входу (у PIN networks: [], сеть — 403).
 */

import { buildRules, defaultTariffForm, weekCoverage } from '../lib/tariffs.js';
import { DASHBOARD_CLUBS } from './dashboard.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const iso = (t) => new Date(t).toISOString();
const uuid = () => globalThis.crypto.randomUUID();
const PHONE = /^\+[1-9][0-9]{7,14}$/;

export const NET_ID = 'e5500000-0000-4000-8000-000000000001';
export const NET_CLUBS = Object.freeze({
  dev: '0b6b8c1e-5a7d-4f0e-9c3a-2d1e4f5a6b7c',
  second: DASHBOARD_CLUBS[1].id,
  third: 'c5500000-0000-4000-8000-000000000003',
  fourth: 'c5500000-0000-4000-8000-000000000004',
});
const PLAN = { id: 'bf000000-0000-4000-8000-000000000002', code: 'network', title: 'Сеть', price_per_table_kopecks: 119000, active: true };
export const NET_MANAGER = { id: 'u-netmgr-0010', name: 'Сергей Н.', phone: '+79000000010', phone_masked: '+7 *** ***-00-10', role: 'manager' };

/** Клубы заглушки: пояс, начало суток, типы столов в работе. */
const CLUB_INFO = {
  [NET_CLUBS.dev]: { name: 'Клуб для разработки', city: 'Екатеринбург', timezone: 'Asia/Yekaterinburg', day_start_local: '06:00', mode: 'live', types: ['pyramid', 'pool'], tables: 8 },
  [NET_CLUBS.second]: { name: DASHBOARD_CLUBS[1].name, city: 'Калининград', timezone: 'Europe/Kaliningrad', day_start_local: '08:00', mode: 'live', types: ['pyramid', 'snooker'], tables: 6 },
  [NET_CLUBS.third]: { name: 'Третий клуб (заглушка)', city: 'Новосибирск', timezone: 'Asia/Novosibirsk', day_start_local: '06:00', mode: 'test', types: ['pyramid'], tables: 4 },
  [NET_CLUBS.fourth]: { name: 'Четвёртый клуб (заглушка)', city: 'Москва', timezone: 'Europe/Moscow', day_start_local: '06:00', mode: 'live', types: ['pool'], tables: 5 },
};

export const isNetworkScenario = (sc) => String(sc ?? '').startsWith('network');
/** M5.8: ?mock=network-court — у третьего клуба сети два падел-корта: шаблону нужны правила корта (№213). */
const courtsIn = (scenario, clubId) => (scenario === 'network-court' && clubId === NET_CLUBS.third ? 2 : 0);
const SLOTS = [60, 90, 120];

/** Шаблон тарифов сети: будни и выходные × день и вечер, разные цены для пирамиды и пула. */
function templateRules() {
  const form = { ...defaultTariffForm('weekend_day_evening'), weekend: [5, 6, 7], perType: true, prices: { 'wd_day:pyramid': '550', 'wd_eve:pyramid': '850', 'we_day:pyramid': '650', 'we_eve:pyramid': '1050', 'wd_day:pool': '450', 'wd_eve:pool': '700', 'we_day:pool': '500', 'we_eve:pool': '800' } };
  return buildRules(form, ['pyramid', 'pool']).map((r) => ({ ...r, start_local: r.from, end_local: r.to }));
}

const TPL_PRODUCTS = [
  ['Кофе', 'Американо', 'COF-AM', 19000, 'шт', false],
  ['Кофе', 'Капучино', 'COF-CAP', 23000, 'шт', false],
  ['Напитки', 'Кола, 0,33 л', 'DRK-COLA', 15000, 'шт', false],
  ['Пиво', 'Светлое разливное, 0,5 л', 'BEER-L', 29000, 'порц', true],
  ['Пиво', 'Сидр, 0,33 л', 'BEER-CID', 28000, 'шт', true],
  ['Для игры', 'Мел для кия', 'GAME-CHALK', 10000, 'шт', false],
];

export function networksState(scenario, t) {
  if (!isNetworkScenario(scenario)) return null;
  const hard = scenario === 'network-hard';
  const none = scenario === 'network-empty';
  const products = TPL_PRODUCTS.map(([category, name, sku, price, unit, alcohol], i) => ({
    id: `e5510000-0000-4000-8000-00000000000${i + 1}`,
    category,
    name,
    sku,
    price_kopecks: price,
    unit,
    is_alcohol: alcohol,
    vat_code: null,
    payment_subject: alcohol ? 'excise' : 'commodity',
    description: null,
    sort: i,
    active: true,
    updated_at: iso(t - 3 * DAY),
  }));
  const member = (club, extra = {}) => ({ club_id: club, tariffs_override: false, tariffs_version: 2, menu_version: 3, added_at: iso(t - 20 * DAY), ...extra });
  return {
    networks: none
      ? []
      : [
          {
            id: NET_ID,
            name: 'Сеть Урал',
            archived: false,
            tariffs_mode: hard ? 'hard' : 'soft',
            menu_mode: hard ? 'hard' : 'soft',
            tariffs: { template: true, version: 2, rules: templateRules() },
            menu: { template: true, version: 3, products },
            clubs: [member(NET_CLUBS.dev), member(NET_CLUBS.second), member(NET_CLUBS.third, { tariffs_version: 1 })],
            managers: [
              { id: 'e5520000-0000-4000-8000-000000000001', status: 'active', user_id: NET_MANAGER.id, name: NET_MANAGER.name, phone_masked: NET_MANAGER.phone_masked, created_at: iso(t - 12 * DAY), expires_at: iso(t - 5 * DAY), accepted_at: iso(t - 11 * DAY) },
              { id: 'e5520000-0000-4000-8000-000000000002', status: 'invited', user_id: null, name: null, phone_masked: '+7 *** ***-38-12', created_at: iso(t - 1 * DAY), expires_at: iso(t + 6 * DAY), accepted_at: null },
            ],
            created_at: iso(t - 20 * DAY),
            updated_at: iso(t - 3 * DAY),
          },
        ],
    // Свои клубы владельца (в /api/me): в сценарии network-empty — клуб разработки и четвёртый
    owned: none ? [NET_CLUBS.dev, NET_CLUBS.fourth] : [NET_CLUBS.dev, NET_CLUBS.second, NET_CLUBS.third, NET_CLUBS.fourth],
    clubMode: Object.fromEntries(Object.entries(CLUB_INFO).map(([id, c]) => [id, c.mode])),
  };
}

/** Каталог клуба разработки: товары шаблона по названию — со ссылкой на товар сети; «Капучино» изменён в клубе. */
export function patchNetworkCatalog(state) {
  const N = state.networks;
  const net = N?.networks?.[0];
  const cat = state.m2?.catalog;
  if (!net || !cat) return;
  for (const p of cat.products) {
    const tp = net.menu.products.find((x) => x.name === p.name || (x.name === 'Капучино' && p.name === 'Капучино'));
    if (!tp) continue;
    p.network_product_id = tp.id;
    p.sku = tp.sku;
    p.is_alcohol = tp.is_alcohol;
    p.network_override = p.name === 'Капучино' && net.menu_mode !== 'hard';
    if (!p.network_override) p.price_kopecks = tp.price_kopecks;
  }
  // Управляющий сети — в персонале каждого клуба сети (доступ выдан сетью)
  const staff = state.m3?.staff;
  if (Array.isArray(staff) && !staff.some((s) => s.user_id === NET_MANAGER.id)) staff.push({ user_id: NET_MANAGER.id, name: NET_MANAGER.name, phone: NET_MANAGER.phone, role: 'manager', active: true, pin_set: false, network_id: NET_ID });
}

export function networkRoutes({ state, me, err, ok, now, dash, catalog }) {
  const S = () => state().networks;
  const on = () => isNetworkScenario(state().scenario) && S();
  const pin = () => state().sessionKind === 'pin';
  const isManager = () => state().scenario === 'network-manager';
  const userRole = () => (isManager() ? 'manager' : 'owner');
  const live = (mode) => mode === 'live' || mode === 'suspended';
  const net = (id) => S().networks.find((n) => n.id === id && !n.archived) ?? null;
  const fail = (status, code, data) => ({ status, body: { error: code, ...(data ?? {}) } });
  const info = (id) => CLUB_INFO[id] ?? { name: 'Клуб', city: null, timezone: 'Europe/Moscow', day_start_local: '06:00', mode: 'live', types: ['pyramid'], tables: 4 };
  const modeOf = (id) => S().clubMode[id] ?? info(id).mode;
  const netOfClub = (clubId) => S().networks.find((n) => !n.archived && n.clubs.some((c) => c.club_id === clubId)) ?? null;
  const reasonOk = (b) => typeof b?.reason === 'string' && b.reason.trim().length > 0;

  /** Доступ к сети как у сервера: PIN — 403, чужая — 404, управляющий на действии владельца — 403. */
  function access(id, want = 'any') {
    if (!me()) return { res: err(401, 'unauthorized') };
    if (pin()) return { res: err(403, 'forbidden') };
    const n = net(id);
    if (!n) return { res: err(404, 'not_found') };
    if (want === 'owner' && userRole() !== 'owner') return { res: err(403, 'forbidden') };
    return { n };
  }

  function problemOf(n, clubId) {
    if (!n.tariffs.template) return null;
    const c = info(clubId);
    for (const kind of [...c.types, ...(courtsIn(state().scenario, clubId) ? ['padel_court'] : [])]) {
      const cov = weekCoverage(n.tariffs.rules, kind, c.day_start_local);
      if (cov.gaps.length) return { type: 'gap', kind, weekday: cov.gaps[0].weekday, from: cov.gaps[0].from, to: cov.gaps[0].to };
      if (cov.overlaps.length) return { type: 'overlap', kind, weekday: cov.overlaps[0].weekday, from: cov.overlaps[0].from, to: cov.overlaps[0].to };
    }
    return null;
  }

  const clubJson = (n, m) => {
    const c = info(m.club_id);
    return { club_id: m.club_id, name: c.name, city: c.city, timezone: c.timezone, day_start_local: c.day_start_local, mode: modeOf(m.club_id), tariffs_override: m.tariffs_override, tariffs_version: m.tariffs_version, menu_version: m.menu_version, added_at: m.added_at };
  };
  const networkJson = (n) => ({
    id: n.id,
    name: n.name,
    role: userRole(),
    tariffs_mode: n.tariffs_mode,
    menu_mode: n.menu_mode,
    tariffs: { template: n.tariffs.template, version: n.tariffs.version },
    menu: { template: n.menu.template, version: n.menu.version },
    clubs: n.clubs.map((m) => clubJson(n, m)),
    plan: { ...PLAN, applies: n.clubs.length >= 2 && PLAN.active },
    created_at: n.created_at,
    updated_at: n.updated_at,
  });
  const listItem = (n) => ({ network_id: n.id, name: n.name, role: userRole(), clubs: n.clubs.length, tariffs_mode: n.tariffs_mode, menu_mode: n.menu_mode });
  const tariffsJson = (n) => ({
    network_id: n.id,
    role: userRole(),
    mode: n.tariffs_mode,
    template: n.tariffs.template,
    version: n.tariffs.version,
    rules: n.tariffs.template ? n.tariffs.rules : [],
    clubs: n.clubs.map((m) => {
      const c = info(m.club_id);
      return { club_id: m.club_id, name: c.name, timezone: c.timezone, day_start_local: c.day_start_local, mode: modeOf(m.club_id), live: live(modeOf(m.club_id)), kinds: [...c.types, ...(courtsIn(state().scenario, m.club_id) ? ['padel_court'] : [])], override: n.tariffs_mode !== 'hard' && m.tariffs_override, applied_version: m.tariffs_version, problem: problemOf(n, m.club_id) };
    }),
  });
  const devOverrides = () => (catalog()?.products ?? []).filter((p) => p.network_product_id && p.network_override).length;
  const menuJson = (n) => ({
    network_id: n.id,
    role: userRole(),
    mode: n.menu_mode,
    template: n.menu.template,
    version: n.menu.version,
    products: n.menu.template ? n.menu.products : [],
    clubs: n.clubs.map((m) => ({ club_id: m.club_id, name: info(m.club_id).name, mode: modeOf(m.club_id), applied_version: m.menu_version, overrides: n.menu_mode === 'hard' ? 0 : m.club_id === NET_CLUBS.dev ? devOverrides() : 0 })),
  });
  const touch = (n) => {
    n.updated_at = iso(now());
  };

  /** Боевые клубы, которых коснётся изменение: тарифы — кроме переопределивших в мягком режиме. */
  const liveTouchedTariffs = (n) => n.clubs.filter((m) => live(modeOf(m.club_id)) && (n.tariffs_mode === 'hard' || !m.tariffs_override));
  const liveTouchedMenu = (n) => n.clubs.filter((m) => live(modeOf(m.club_id)));

  function enforce(n, scope) {
    if (scope === 'tariffs') for (const m of n.clubs) m.tariffs_override = false;
    if (scope === 'menu') for (const p of catalog()?.products ?? []) if (p.network_product_id) p.network_override = false;
  }

  /** Плитки клуба для вкладки «Сеть»: из дашборда клуба (те же числа), клуб в тесте — нули. */
  function clubNumbers(clubId, q) {
    const known = DASHBOARD_CLUBS.some((c) => c.id === clubId);
    const res = known && live(modeOf(clubId)) ? dash().response(clubId, new URLSearchParams({ from: q.from, to: q.to, tab: 'summary', compare: q.compare ? '1' : '0' }), { role: 'owner' }) : null;
    const tiles = res?.status === 200 ? res.body.tiles : [];
    const tables = info(clubId).tables;
    const get = (id, prev = false) => {
      const t = tiles.find((x) => x.id === id);
      return t ? (prev ? (t.prev ?? null) : t.value) : 0;
    };
    const one = (prev) => {
      const revenue = get('revenue', prev) ?? 0;
      return {
        revenue,
        games: get('games', prev) ?? 0,
        play_hours: get('play_hours', prev) ?? 0,
        utilization: get('utilization', prev) ?? 0,
        avg_check_game: tiles.length ? get('avg_check_game', prev) : null,
        avg_check_bar: tiles.length ? get('avg_check_bar', prev) : null,
        revenue_per_table_day: tiles.length ? get('revenue_per_table_day', prev) : null,
        revenue_per_table: tiles.length ? Math.round(revenue / tables) : null,
        avg_hour_price: tiles.length ? get('avg_hour_price', prev) : null,
        guests: get('guests', prev) ?? 0,
        no_staff_share: tiles.length ? get('no_staff_share', prev) : null,
        tables_avg: tables,
      };
    };
    return { now: one(false), prev: q.compare ? one(true) : null };
  }
  const NT = [['revenue', 'kopecks'], ['games', 'count'], ['play_hours', 'hours'], ['utilization', 'percent'], ['avg_check_game', 'kopecks'], ['avg_check_bar', 'kopecks'], ['revenue_per_table_day', 'kopecks'], ['revenue_per_table', 'kopecks'], ['avg_hour_price', 'kopecks'], ['guests', 'count'], ['no_staff_share', 'percent']];
  const r1 = (x) => Math.round(x * 10) / 10;
  const deltaPct = (v, p) => (v === null || p === null || p === undefined ? null : p === 0 ? (v === 0 ? 0 : null) : r1(((v - p) / Math.abs(p)) * 100));
  const tilesOf = (cur, prev) => NT.map(([id, unit]) => ({ id, value: cur[id], unit, prev: prev ? prev[id] : null, delta_pct: prev ? deltaPct(cur[id], prev[id]) : null }));
  function rank(rows, key) {
    const list = rows.filter((r) => r.ranked && r.numbers[key] !== null).sort((a, b) => b.numbers[key] - a.numbers[key]);
    let place = 0;
    let last = null;
    return list.map((r, i) => {
      if (r.numbers[key] !== last) {
        place = i + 1;
        last = r.numbers[key];
      }
      return { club_id: r.id, name: r.name, value: r.numbers[key], place };
    });
  }
  function sumNumbers(rows, pick) {
    const ranked = rows.filter((r) => r.ranked);
    const s = (k) => ranked.reduce((a, r) => a + (pick(r)?.[k] ?? 0), 0);
    const tables = ranked.reduce((a, r) => a + r.tables, 0);
    const games = s('games');
    const revenue = s('revenue');
    return {
      revenue,
      games,
      play_hours: r1(s('play_hours')),
      utilization: tables ? r1(ranked.reduce((a, r) => a + (pick(r)?.utilization ?? 0) * r.tables, 0) / tables) : null,
      avg_check_game: games ? Math.round(ranked.reduce((a, r) => a + (pick(r)?.avg_check_game ?? 0) * (pick(r)?.games ?? 0), 0) / games) : null,
      avg_check_bar: ranked.length ? Math.round(ranked.reduce((a, r) => a + (pick(r)?.avg_check_bar ?? 0), 0) / ranked.length) : null,
      revenue_per_table_day: tables ? Math.round(ranked.reduce((a, r) => a + (pick(r)?.revenue_per_table_day ?? 0) * r.tables, 0) / tables) : null,
      revenue_per_table: tables ? Math.round(revenue / tables) : null,
      avg_hour_price: s('play_hours') ? Math.round(revenue / s('play_hours')) : null,
      guests: s('guests'),
      no_staff_share: ranked.length ? r1(ranked.reduce((a, r) => a + (pick(r)?.no_staff_share ?? 0), 0) / ranked.length) : null,
      tables_avg: tables,
    };
  }

  const routes = [
    // GET /api/me: клубы (у управляющего сети — с network_id) и сети; у PIN — сетей нет
    ['GET', /^\/api\/me$/, () => {
      if (!on()) return undefined;
      if (!me()) return err(401, 'unauthorized');
      const manager = isManager();
      const n = S().networks.find((x) => !x.archived);
      const ids = manager ? (n?.clubs ?? []).map((m) => m.club_id) : S().owned;
      const clubs = ids.map((id) => ({ club_id: id, role: manager ? 'manager' : 'owner', name: info(id).name, timezone: info(id).timezone, mode: modeOf(id), ...(manager ? { network_id: n.id } : {}) }));
      const networks = pin() ? [] : S().networks.filter((x) => !x.archived).map(listItem);
      return ok({ session: { kind: state().sessionKind ?? 'session', terminal_id: null }, user: me(), clubs: pin() ? clubs.filter((c) => c.club_id === NET_CLUBS.dev) : clubs, networks });
    }],
    ['GET', /^\/api\/networks$/, () => {
      if (!on()) return undefined;
      if (pin()) return err(403, 'forbidden');
      return ok({ items: S().networks.filter((x) => !x.archived).map(listItem) });
    }],
    ['POST', /^\/api\/networks$/, (_m, b) => {
      if (!on()) return undefined;
      if (pin()) return err(403, 'forbidden');
      const name = typeof b?.name === 'string' ? b.name.trim() : '';
      if (name.length < 1 || name.length > 100) return err(400, 'bad_request');
      if (S().networks.filter((x) => !x.archived).length >= 5) return err(409, 'networks_limit');
      const n = { id: uuid(), name, archived: false, tariffs_mode: 'soft', menu_mode: 'soft', tariffs: { template: false, version: 0, rules: [] }, menu: { template: false, version: 0, products: [] }, clubs: [], managers: [], created_at: iso(now()), updated_at: iso(now()) };
      S().networks.push(n);
      return { status: 201, body: networkJson(n) };
    }],
    ['GET', /^\/api\/networks\/([^/]+)$/, (m) => {
      if (!on()) return undefined;
      const a = access(m[1]);
      return a.res ?? ok(networkJson(a.n));
    }],
    ['PATCH', /^\/api\/networks\/([^/]+)$/, (m, b) => {
      if (!on()) return undefined;
      const a = access(m[1], 'owner');
      if (a.res) return a.res;
      const n = a.n;
      if (b.name !== undefined) {
        const name = typeof b.name === 'string' ? b.name.trim() : '';
        if (name.length < 1 || name.length > 100) return err(400, 'bad_request');
        n.name = name;
      }
      for (const [k, scope] of [['tariffs_mode', 'tariffs'], ['menu_mode', 'menu']]) {
        if (b[k] === undefined) continue;
        if (!['soft', 'hard'].includes(b[k])) return err(400, 'bad_request');
        if (b[k] === 'hard' && n[k] !== 'hard' && n[scope].template) {
          const touched = scope === 'tariffs' ? n.clubs.filter((x) => live(modeOf(x.club_id)) && x.tariffs_override) : liveTouchedMenu(n);
          if (touched.length && !reasonOk(b)) return err(400, 'reason_required');
          enforce(n, scope);
        }
        n[k] = b[k];
      }
      touch(n);
      return ok(networkJson(n));
    }],
    ['DELETE', /^\/api\/networks\/([^/]+)$/, (m) => {
      if (!on()) return undefined;
      const a = access(m[1], 'owner');
      if (a.res) return a.res;
      a.n.archived = true;
      const removed = a.n.clubs.length;
      a.n.clubs = [];
      return ok({ ok: true, clubs_removed: removed });
    }],
    ['POST', /^\/api\/networks\/([^/]+)\/clubs$/, (m, b) => {
      if (!on()) return undefined;
      const a = access(m[1], 'owner');
      if (a.res) return a.res;
      const id = b?.club_id;
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return err(400, 'bad_request');
      if (!S().owned.includes(id)) return err(403, 'forbidden');
      if (a.n.clubs.some((x) => x.club_id === id)) return ok(networkJson(a.n));
      if (netOfClub(id)) return err(409, 'club_in_network');
      if (a.n.clubs.length >= 100) return err(409, 'networks_limit');
      // Шаблоны сети применяются к клубу сразу (server/networks/templates.mjs applyTemplatesToNewClub); любая ошибка — клуб не добавлен
      const tpl = a.n.tariffs.template || a.n.menu.template;
      if (a.n.tariffs.template) {
        // network-gap: у добавляемого клуба неделя не покрыта шаблоном
        const p = state().scenario === 'network-gap' ? { type: 'gap', kind: 'pool', weekday: 3, from: '02:00', to: '06:00' } : problemOf(a.n, id);
        if (p) return fail(400, p.type === 'overlap' ? 'tariff_overlap' : 'tariff_gap', { club_id: id, ...(p.kind ? { kind: p.kind } : {}), weekday: p.weekday, from: p.from, to: p.to });
      }
      if (tpl && live(modeOf(id)) && !reasonOk(b)) return err(400, 'reason_required');
      // network-dup: артикул товара шаблона занят другим товаром в меню клуба
      if (a.n.menu.template && state().scenario === 'network-dup') return fail(409, 'duplicate', { club_id: id, field: 'sku', value: a.n.menu.products[0]?.sku ?? 'COF-AM' });
      a.n.clubs.push({ club_id: id, tariffs_override: false, tariffs_version: a.n.tariffs.version, menu_version: a.n.menu.version, added_at: iso(now()) });
      touch(a.n);
      return { status: 201, body: networkJson(a.n) };
    }],
    ['DELETE', /^\/api\/networks\/([^/]+)\/clubs\/([^/]+)$/, (m) => {
      if (!on()) return undefined;
      const a = access(m[1], 'owner');
      if (a.res) return a.res;
      if (!a.n.clubs.some((x) => x.club_id === m[2])) return err(404, 'not_found');
      a.n.clubs = a.n.clubs.filter((x) => x.club_id !== m[2]);
      touch(a.n);
      return ok(networkJson(a.n));
    }],
    ['GET', /^\/api\/networks\/([^/]+)\/managers$/, (m) => {
      if (!on()) return undefined;
      const a = access(m[1], 'owner');
      return a.res ?? ok({ items: a.n.managers.filter((x) => !x.revoked).map(({ revoked: _r, phone: _p, ...x }) => x) });
    }],
    ['POST', /^\/api\/networks\/([^/]+)\/managers$/, (m, b) => {
      if (!on()) return undefined;
      const a = access(m[1], 'owner');
      if (a.res) return a.res;
      const phone = typeof b?.phone === 'string' ? b.phone.trim() : '';
      if (!PHONE.test(phone)) return err(400, 'bad_request');
      if (phone === '+79000000001' || phone === NET_MANAGER.phone) return err(409, 'duplicate');
      const masked = `+7 *** ***-${phone.slice(-4, -2)}-${phone.slice(-2)}`;
      const expires = iso(now() + 7 * DAY);
      let inv = a.n.managers.find((x) => !x.revoked && x.phone === phone);
      if (inv) inv.expires_at = expires;
      else {
        inv = { id: uuid(), status: 'invited', user_id: null, name: null, phone, phone_masked: masked, created_at: iso(now()), expires_at: expires, accepted_at: null };
        a.n.managers.push(inv);
      }
      const url = `${globalThis.location?.origin ?? 'http://localhost:5174'}/club/signin`;
      return {
        status: 201,
        body: {
          id: inv.id,
          status: 'invited',
          phone_masked: masked,
          expires_at: expires,
          invite_url: url,
          invite_text: `Вас пригласили управляющим сети клубов «${a.n.name}» в программе «Бильярдум». Войдите с этого номера телефона: ${url} — доступ к клубам сети откроется сам. Приглашение действует до ${new Date(now() + 7 * DAY).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}.`,
        },
      };
    }],
    ['DELETE', /^\/api\/networks\/([^/]+)\/managers\/([^/]+)$/, (m) => {
      if (!on()) return undefined;
      const a = access(m[1], 'owner');
      if (a.res) return a.res;
      const x = a.n.managers.find((y) => y.id === m[2] && !y.revoked);
      if (!x) return err(404, 'not_found');
      x.revoked = true;
      return ok({ ok: true });
    }],
    ['GET', /^\/api\/networks\/([^/]+)\/tariffs$/, (m) => {
      if (!on()) return undefined;
      const a = access(m[1]);
      return a.res ?? ok(tariffsJson(a.n));
    }],
    ['PUT', /^\/api\/networks\/([^/]+)\/tariffs$/, (m, b) => {
      if (!on()) return undefined;
      const a = access(m[1], 'owner');
      if (a.res) return a.res;
      const rules = Array.isArray(b?.rules) ? b.rules : null;
      if (!rules?.length || rules.length > 100) return err(400, 'bad_request');
      // Правило корта — слотом (M5.8): slot_minutes 60/90/120 одна на вид, price_per_slot_kopecks > 0; столы — цена часа
      const slots = new Set();
      for (const r of rules) {
        if (r.kind === 'padel_court') {
          if (!SLOTS.includes(r.slot_minutes) || !Number.isInteger(r.price_per_slot_kopecks) || r.price_per_slot_kopecks <= 0 || r.price_per_hour_kopecks !== undefined) return err(400, 'bad_request');
          slots.add(r.slot_minutes);
        } else if (!Number.isInteger(r.price_per_hour_kopecks) || r.price_per_hour_kopecks <= 0 || r.slot_minutes !== undefined) return err(400, 'bad_request');
      }
      if (slots.size > 1) return err(400, 'bad_request');
      const draft = { ...a.n, tariffs: { template: true, version: a.n.tariffs.version + 1, rules } };
      for (const x of a.n.clubs) {
        const p = problemOf(draft, x.club_id);
        if (p) return fail(400, p.type === 'overlap' ? 'tariff_overlap' : 'tariff_gap', { club_id: x.club_id, ...(p.kind ? { kind: p.kind } : {}), weekday: p.weekday, from: p.from, to: p.to });
      }
      if (liveTouchedTariffs(a.n).length && !reasonOk(b)) return err(400, 'reason_required');
      a.n.tariffs = { template: true, version: a.n.tariffs.version + 1, rules: rules.map((r) => ({ ...r, start_local: r.from, end_local: r.to })) };
      for (const x of a.n.clubs) if (a.n.tariffs_mode === 'hard' || !x.tariffs_override) x.tariffs_version = a.n.tariffs.version;
      touch(a.n);
      return ok(tariffsJson(a.n));
    }],
    ['DELETE', /^\/api\/networks\/([^/]+)\/tariffs$/, (m) => {
      if (!on()) return undefined;
      const a = access(m[1], 'owner');
      if (a.res) return a.res;
      a.n.tariffs = { ...a.n.tariffs, template: false };
      return ok(tariffsJson(a.n));
    }],
    ['GET', /^\/api\/networks\/([^/]+)\/menu$/, (m) => {
      if (!on()) return undefined;
      const a = access(m[1]);
      return a.res ?? ok(menuJson(a.n));
    }],
    ['PUT', /^\/api\/networks\/([^/]+)\/menu$/, (m, b) => {
      if (!on()) return undefined;
      const a = access(m[1], 'owner');
      if (a.res) return a.res;
      const items = Array.isArray(b?.products) ? b.products : null;
      if (!items || items.length > 300) return err(400, 'bad_request');
      const seen = new Set();
      for (const p of items) {
        if (typeof p?.name !== 'string' || !p.name.trim() || p.name.length > 128 || !Number.isSafeInteger(p.price_kopecks) || p.price_kopecks < 1) return err(400, 'bad_request');
        const key = `${(p.category ?? '').toLowerCase()}|${p.name.toLowerCase()}`;
        if (seen.has(key) || (p.sku && seen.has(`sku:${p.sku}`))) return err(400, 'bad_request');
        seen.add(key);
        if (p.sku) seen.add(`sku:${p.sku}`);
      }
      if (liveTouchedMenu(a.n).length && !reasonOk(b)) return err(400, 'reason_required');
      // network-dup: название товара шаблона занято другим товаром в меню клуба (409 duplicate { club_id, field, value })
      if (state().scenario === 'network-dup') return fail(409, 'duplicate', { club_id: a.n.clubs[0]?.club_id, field: 'name', value: String(items[0].name).slice(0, 128) });
      a.n.menu = {
        template: true,
        version: a.n.menu.version + 1,
        products: items.map((p, i) => ({ id: p.id ?? uuid(), category: p.category ?? null, name: p.name, sku: p.sku ?? null, price_kopecks: p.price_kopecks, unit: p.unit ?? 'шт', is_alcohol: Boolean(p.is_alcohol), vat_code: p.vat_code ?? null, payment_subject: p.payment_subject ?? (p.is_alcohol ? 'excise' : 'commodity'), description: p.description ?? null, sort: p.sort ?? i, active: p.active !== false, updated_at: iso(now()) })),
      };
      for (const x of a.n.clubs) x.menu_version = a.n.menu.version;
      touch(a.n);
      return ok(menuJson(a.n));
    }],
    ['DELETE', /^\/api\/networks\/([^/]+)\/menu$/, (m) => {
      if (!on()) return undefined;
      const a = access(m[1], 'owner');
      if (a.res) return a.res;
      a.n.menu = { ...a.n.menu, template: false };
      for (const p of catalog()?.products ?? []) if (p.network_product_id) Object.assign(p, { network_product_id: null, network_override: false });
      return ok(menuJson(a.n));
    }],
    ['GET', /^\/api\/networks\/([^/]+)\/dashboard$/, (m, _b, q) => {
      if (!on()) return undefined;
      const a = access(m[1]);
      if (a.res) return a.res;
      const today = dash().today();
      const from = q.get('from') ?? today;
      const to = q.get('to') ?? today;
      const compare = q.get('compare') !== '0';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return err(400, 'bad_request');
      const rows = a.n.clubs.map((x) => {
        const c = info(x.club_id);
        const nums = clubNumbers(x.club_id, { from, to, compare });
        return { id: x.club_id, name: c.name, c, numbers: nums.now, prev: nums.prev, ranked: live(modeOf(x.club_id)), tables: c.tables };
      });
      const ranking = { utilization: rank(rows, 'utilization'), revenue_per_table_day: rank(rows, 'revenue_per_table_day') };
      const placeOf = (list, id) => list.find((x) => x.club_id === id)?.place ?? null;
      const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;
      const totalNow = sumNumbers(rows, (r) => r.numbers);
      const totalPrev = compare ? sumNumbers(rows, (r) => r.prev) : null;
      return ok({
        network: { id: a.n.id, name: a.n.name },
        role: userRole(),
        period: { from, to, days },
        compare_period: compare ? { from, to } : null,
        clubs: rows.map((r) => ({
          club_id: r.id,
          name: r.name,
          timezone: r.c.timezone,
          day_start_local: r.c.day_start_local,
          mode: modeOf(r.id),
          today,
          includes_today: from <= today && today <= to,
          ranked: r.ranked,
          tables_avg: r.tables,
          tiles: tilesOf(r.numbers, r.prev),
          place_utilization: placeOf(ranking.utilization, r.id),
          place_revenue_per_table_day: placeOf(ranking.revenue_per_table_day, r.id),
        })),
        totals: { tables_avg: totalNow.tables_avg, tiles: tilesOf(totalNow, totalPrev) },
        ranking,
        missing_days: [],
        generated_at: iso(now()),
      });
    }],
    // Клуб: его сеть и возврат к шаблону
    ['GET', /^\/api\/clubs\/([^/]+)\/network$/, (m) => {
      if (!on()) return undefined;
      if (!me()) return err(401, 'unauthorized');
      const n = netOfClub(m[1]);
      if (!n) return ok({ network: null });
      const member = n.clubs.find((x) => x.club_id === m[1]);
      return ok({
        network: {
          id: n.id,
          name: n.name,
          tariffs: { template: n.tariffs.template, mode: n.tariffs_mode, locked: n.tariffs.template && n.tariffs_mode === 'hard', override: n.tariffs.template && member.tariffs_override, version: n.tariffs.version, applied_version: member.tariffs_version },
          menu: { template: n.menu.template, mode: n.menu_mode, locked: n.menu.template && n.menu_mode === 'hard', overrides: n.menu.template && m[1] === NET_CLUBS.dev ? devOverrides() : 0, version: n.menu.version, applied_version: member.menu_version },
        },
      });
    }],
    ['POST', /^\/api\/clubs\/([^/]+)\/network\/reset$/, (m, b) => {
      if (!on()) return undefined;
      const n = netOfClub(m[1]);
      if (!n) return err(404, 'not_found');
      if (!['tariffs', 'menu'].includes(b?.scope)) return err(400, 'bad_request');
      if (live(modeOf(m[1])) && !reasonOk(b)) return err(400, 'reason_required');
      const member = n.clubs.find((x) => x.club_id === m[1]);
      if (b.scope === 'tariffs') {
        member.tariffs_override = false;
        member.tariffs_version = n.tariffs.version;
        state().m5.tariffs = n.tariffs.rules.map(({ start_local: _s, end_local: _e, ...r }) => r);
        return ok({ scope: 'tariffs', tariffs: { timezone: info(m[1]).timezone, day_start_local: info(m[1]).day_start_local, rules: state().m5.tariffs, resource_rules: [], coverage: { ok: true, problem: null } } });
      }
      let updated = 0;
      for (const p of catalog()?.products ?? []) {
        if (!p.network_product_id || !p.network_override) continue;
        const tp = n.menu.products.find((x) => x.id === p.network_product_id);
        if (tp) Object.assign(p, { name: tp.name, price_kopecks: tp.price_kopecks, is_alcohol: tp.is_alcohol, network_override: false });
        updated += 1;
      }
      member.menu_version = n.menu.version;
      return ok({ scope: 'menu', created: 0, updated, deactivated: 0, price_changes: updated, skipped_override: 0 });
    }],
    // Тарифы клуба: жёсткий шаблон — 409 network_locked; мягкий — сохраняются как обычно и отмечаются переопределением
    ['PUT', /^\/api\/clubs\/([^/]+)\/tariffs$/, (m) => {
      if (!on()) return undefined;
      const n = netOfClub(m[1]);
      if (!n?.tariffs.template) return undefined;
      if (n.tariffs_mode === 'hard') return fail(409, 'network_locked', { network_id: n.id });
      n.clubs.find((x) => x.club_id === m[1]).tariffs_override = true;
      return undefined;
    }],
    // Товар сети в клубе: жёсткий шаблон — поля шаблона не меняются; алкоголь сети не снимается ни в каком режиме
    ['PATCH', /^\/api\/catalog\/products\/([^/]+)$/, (m, b) => {
      if (!on()) return undefined;
      const p = (catalog()?.products ?? []).find((x) => x.id === m[1]);
      const n = netOfClub(NET_CLUBS.dev);
      if (!p?.network_product_id || !n?.menu.template) return undefined;
      const fields = ['category_id', 'name', 'description', 'sku', 'price_kopecks', 'unit', 'is_alcohol', 'vat_code', 'payment_subject', 'active'];
      const touched = fields.filter((f) => f in b && b[f] !== p[f]);
      if (!touched.length) return undefined;
      if (n.menu_mode === 'hard') return fail(409, 'network_locked', { network_id: n.id });
      const tp = n.menu.products.find((x) => x.id === p.network_product_id);
      if (tp?.is_alcohol && b.is_alcohol === false) return fail(409, 'network_locked', { network_id: n.id });
      p.network_override = true;
      return undefined;
    }],
    // Управляющего сети клуб не меняет и не отзывает
    ['PATCH', /^\/api\/clubs\/([^/]+)\/staff\/([^/]+)$/, (m) => (on() && m[2] === NET_MANAGER.id ? fail(409, 'network_locked', { network_id: NET_ID }) : undefined)],
    ['DELETE', /^\/api\/clubs\/([^/]+)\/staff\/([^/]+)$/, (m) => (on() && m[2] === NET_MANAGER.id ? fail(409, 'network_locked', { network_id: NET_ID }) : undefined)],
    // Столы других клубов сети: свои типы (у второго — снукер, шаблон не покрывает его неделю)
    ['GET', /^\/api\/clubs\/([^/]+)\/resources$/, (m) => {
      if (!on() || m[1] === NET_CLUBS.dev || !CLUB_INFO[m[1]]) return undefined;
      const c = info(m[1]);
      const resources = Array.from({ length: c.tables }, (_, i) => {
        const kind = c.types[Math.min(c.types.length - 1, Math.floor((i * c.types.length) / c.tables))];
        return { id: `${m[1].slice(0, 24)}${String(i + 1).padStart(12, '0')}`, number: i + 1, kind, type: `billiard_${kind}`, family: 'table', title: `Стол ${i + 1}`, code: null, plan_x: 0, plan_y: 0, plan_rotation: 0, active: true, sticker_printed_at: null };
      });
      // M5.8: корты клуба — своя нумерация «Корт 1…»
      for (let i = 0; i < courtsIn(state().scenario, m[1]); i += 1) {
        resources.push({ id: `${m[1].slice(0, 24)}${String(901 + i).padStart(12, '0')}`, number: i + 1, kind: 'padel_court', type: 'padel_court', family: 'court', title: `Корт ${i + 1}`, code: null, plan_x: 0, plan_y: 0, plan_rotation: 0, active: true, sticker_printed_at: null });
      }
      return ok({ plan: { width_cm: 1800, height_cm: 1400 }, resources });
    }],
    // Управляющий сети: без «Денег» и выгрузок (как сервер — 403)
    ['GET', /^\/api\/clubs\/([^/]+)\/dashboard$/, (m, _b, q) => {
      if (!on()) return undefined;
      if (isManager() && q.get('tab') === 'money') return err(403, 'forbidden');
      // Третий и четвёртый клубы заглушки — данные клуба разработки (у дашборда заглушки их нет)
      if (m[1] === NET_CLUBS.third || m[1] === NET_CLUBS.fourth) return dash().response(NET_CLUBS.dev, q, { role: 'owner' });
      return undefined;
    }],
    ['GET', /^\/api\/clubs\/([^/]+)\/dashboard\/now$/, (m) => {
      if (!on()) return undefined;
      if (m[1] === NET_CLUBS.third || m[1] === NET_CLUBS.fourth) return dash().nowResponse(NET_CLUBS.dev, state().hall, { role: 'owner' });
      return undefined;
    }],
    ['GET', /^\/api\/clubs\/([^/]+)\/(history\/[a-z]+|shifts|cashbook)\/export\.csv$/, () => (on() && isManager() ? err(403, 'forbidden') : undefined)],
  ];
  return { routes };
}
