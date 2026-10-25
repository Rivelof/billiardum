// Перепроверка дефектов приёмки M5.5/M5.8 (код main 0fd990e) на стенде, часть API. Браузерная часть — 09-recheck-browser.test.mjs.
//
//   * Д1: GET /api/reception/requests/{id} несёт resource_number / resource_type / resource_family (корт 2 и стол 8); чужой гость — 404;
//   * слоты корта: старт 1–4 слотов (200), 5 слотов и не кратные слоту — 400; продление 1–4 слотов, 5 — 400; оплаченное продление на 4 слота;
//   * дашборд «Зал»: by_type и by_resource несут family, у кортов resources = 2 (и tables для совместимости);
//   * M5.6 Н1: «Столы» (by_resource) показывают все ресурсы с нулями — сегодня, за день до создания клуба;
//   * исправления захода 2 pentester: тариф ниже порога — 400 (слот 49 коп., час 49 коп.); жёсткое меню сети — группа модификаторов,
//     привязанная к товару шаблона ДО жёсткого режима, не правится (409 network_locked), группа своего товара правится;
//     бронь на 0 ₽ на стенде недостижима (тариф < порога не принимается) — её путь проверяется на своём Postgres (см. отчёт).
// Игры только на корте 101 и 102 и столе 8; столы 1–4 не трогаются.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { api, CLUB_SEED, COURTS, courtRule, dayPlus, extendGame, login, makeClub, newGuest, payQuote, quote, rule, SEED_PHONES, short, sim, staffPhone, startGame, stopGame, tableByCode, waitCourtFree, waitFor } from './lib.mjs';

const S = { requests: [], sessions: [] };
const TABLE8 = 'TEST000008';

before(async () => {
  S.owner = await login(SEED_PHONES.owner);
  S.man = await login(SEED_PHONES.manager);
  S.rec = await login(SEED_PHONES.reception);
  S.g1 = await newGuest();
  S.g2 = await newGuest();
});

after(async () => {
  for (const id of S.requests) await api('POST', `/api/reception/requests/${id}/decline`, { token: S.rec.token, body: { reason_code: 'other' } }).catch(() => {});
  for (const { guest, id } of S.sessions) await stopGame(guest, id).catch(() => {});
});

async function waitTableFree(code, token, timeoutMs = 60_000) {
  return waitFor(async () => {
    const r = await tableByCode(code, token);
    return r.status === 200 && r.json.status === 'free' ? r.json : null;
  }, { timeoutMs, intervalMs: 1000, what: `${code} свободен` });
}

describe('Д1. заявка ресепшену за корт и за стол: вид ресурса в ответе гостю', () => {
  it('корт 102: resource_number 2, padel_court, family court; чужой гость — 404; без входа — 401', async (t) => {
    await waitCourtFree(102, S.g1.token, 240_000);
    const tb = await tableByCode(COURTS[102].code, S.g1.token);
    const q = await quote(S.g1.token, { resource_id: tb.json.resource.id, kind: 'start', minutes: 90 });
    assert.equal(q.status, 200, short(q));
    const p = await payQuote(S.g1.token, q.json.quote_id, 'reception');
    assert.equal(p.status, 200, short(p));
    const id = p.json.reception_request_id;
    assert.ok(id, short(p));
    S.requests.push(id);
    const r = await api('GET', `/api/reception/requests/${id}`, { token: S.g1.token });
    assert.equal(r.status, 200, short(r));
    t.diagnostic(`заявка на корт: ${JSON.stringify(r.json)}`);
    assert.deepEqual([r.json.resource_number, r.json.resource_type, r.json.resource_family, r.json.status], [2, 'padel_court', 'court', 'waiting']);
    assert.ok(!('phone' in r.json) && !/\+7\d{10}/.test(r.text), 'ПДн в ответе нет');
    assert.equal((await api('GET', `/api/reception/requests/${id}`, { token: S.g2.token })).status, 404, 'чужой гость');
    assert.equal((await api('GET', `/api/reception/requests/${id}`)).status, 401, 'без входа');
    assert.equal((await api('GET', `/api/reception/requests/${id}`, { token: S.rec.token })).status, 404, 'персонал — не автор заявки');
  });

  it('стол 8: resource_number 8, billiard_*, family table', async (t) => {
    await waitTableFree(TABLE8, S.g1.token);
    const tb = await tableByCode(TABLE8, S.g2.token);
    const q = await quote(S.g2.token, { resource_id: tb.json.resource.id, kind: 'start', minutes: 60 });
    assert.equal(q.status, 200, short(q));
    const p = await payQuote(S.g2.token, q.json.quote_id, 'reception');
    assert.equal(p.status, 200, short(p));
    S.requests.push(p.json.reception_request_id);
    const r = await api('GET', `/api/reception/requests/${p.json.reception_request_id}`, { token: S.g2.token });
    assert.equal(r.status, 200, short(r));
    t.diagnostic(`заявка на стол: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.resource_number, 8);
    assert.match(r.json.resource_type, /^billiard_/);
    assert.equal(r.json.resource_family, 'table');
  });

  it('заявки отклонены: гость видит declined с тем же видом ресурса', async () => {
    for (const id of S.requests) {
      const d = await api('POST', `/api/reception/requests/${id}/decline`, { token: S.rec.token, body: { reason_code: 'other' } });
      assert.equal(d.status, 200, short(d));
    }
    const first = await api('GET', `/api/reception/requests/${S.requests[0]}`, { token: S.g1.token });
    assert.equal(first.json.status, 'declined');
    assert.equal(first.json.resource_family, 'court');
    S.requests = [];
  });
});

describe('слоты корта: старт 1–4 слота, продление до 4 слотов', () => {
  it('котировка старта: 90/180/270/360 → 200 (слоты 1–4, цена кратна рублю); 0, «Без лимита», null, −90, 1441 → 400', async (t) => {
    const g = await newGuest();
    await waitCourtFree(101, g.token, 240_000);
    const tb = (await tableByCode(COURTS[101].code, g.token)).json;
    const lines = [];
    for (const n of [1, 2, 3, 4]) {
      const q = await quote(g.token, { resource_id: tb.resource.id, kind: 'start', minutes: 90 * n });
      assert.equal(q.status, 200, `${n} сл.: ${short(q)}`);
      assert.deepEqual([q.json.slots, q.json.slot_minutes, q.json.minutes], [n, 90, 90 * n]);
      assert.equal(q.json.amount_kopecks % 100, 0);
      lines.push(`${n} сл. = ${q.json.amount_kopecks / 100} ₽`);
    }
    // На стенде включён DEV_ALLOW_ANY_MINUTES (любые минуты 1…1440, №54): 5 слотов и 120 мин живьём не отказываются,
    // границу «1–4 слота» проверяет чистая функция в боевой конфигурации (следующий тест).
    for (const bad of [0, 'unlimited', null, -90, 1441]) {
      const q = await quote(g.token, { resource_id: tb.resource.id, kind: 'start', minutes: bad });
      assert.equal(q.status, 400, `minutes=${bad}: ${short(q)}`);
    }
    t.diagnostic(lines.join('; '));
    assert.deepEqual(tb.options, [90, 180, 270], 'на экране QR — три первых слота (1,5 / 3 / 4,5 ч); четвёртый — в окне продления и по API');
  });

  it('боевая конфигурация (чистая функция parseQuoteRequest, без DEV_ALLOW_ANY_MINUTES): корт — только 90/180/270/360; 450, 120, 45, null, «Без лимита» — отказ; стол — прежние минуты', async () => {
    const { parseQuoteRequest } = await import('../../../server/payments/quotes.mjs');
    const body = (minutes) => ({ resource_id: COURTS[101].id, kind: 'start', minutes });
    for (const m of [90, 180, 270, 360]) assert.equal(parseQuoteRequest(body(m), { slotMinutes: 90 }).minutes, m);
    for (const m of [450, 540, 120, 45, 0, null, 'unlimited', 1.5]) assert.throws(() => parseQuoteRequest(body(m), { slotMinutes: 90 }), { code: 'bad_request' }, `minutes=${m}`);
    const ext = (m) => parseQuoteRequest({ resource_id: COURTS[101].id, kind: 'extend', session_id: COURTS[102].id, minutes: m }, { slotMinutes: 90 });
    for (const m of [90, 180, 270, 360]) assert.equal(ext(m).minutes, m);
    assert.throws(() => ext(450), { code: 'bad_request' });
    assert.equal(parseQuoteRequest(body(60), { slotMinutes: null }).minutes, 60, 'стол: 60 минут как раньше');
  });

  it('игра 1 слот → котировки продления 1–4 слота (200), 0 / «Без лимита» / null — 400; оплата продления на 4 слота: остаток ~450 мин', async (t) => {
    const g = await newGuest();
    await waitCourtFree(101, g.token, 240_000);
    const gm = await startGame(101, 90, g);
    S.sessions.push({ guest: g, id: gm.sessionId });
    const rid = gm.t.resource.id;
    for (const n of [1, 2, 3, 4]) {
      const q = await quote(g.token, { resource_id: rid, kind: 'extend', session_id: gm.sessionId, minutes: 90 * n });
      assert.equal(q.status, 200, `продление ${n} сл.: ${short(q)}`);
      assert.equal(q.json.slots, n);
    }
    for (const bad of [0, 'unlimited', null]) {
      const q = await quote(g.token, { resource_id: rid, kind: 'extend', session_id: gm.sessionId, minutes: bad });
      assert.equal(q.status, 400, `продление minutes=${bad}: ${short(q)}`);
    }
    const e = await extendGame(101, gm.sessionId, 360, g);
    assert.equal(e.q.status, 200, short(e.q));
    assert.equal(Date.parse(e.after.paid_until) - Date.parse(e.before.paid_until), 360 * 60_000, 'оплачено ровно 4 слота');
    const s = await waitFor(async () => {
      const x = await sim(101);
      return x.state.remaining_ms > 445 * 60_000 ? x : null;
    }, { what: 'остаток ~450 мин на контроллере', timeoutMs: 15_000 });
    assert.ok(s.state.remaining_ms <= 450 * 60_000);
    const rc = (await api('GET', `/api/sessions/${gm.sessionId}/receipt`, { token: g.token })).json;
    t.diagnostic(`чек: ${rc.lines.map((l) => l.title).join(' | ')}`);
    assert.ok(rc.lines.every((l) => /^Корт 1, /.test(l.title)), 'в чеке только «Корт 1»');
    assert.ok(!/[Сс]тол/.test(JSON.stringify(rc)), 'в чеке нет слова «стол»');
    const st = await stopGame(g, gm.sessionId);
    assert.equal(st.status, 200, short(st));
    S.sessions = S.sessions.filter((x) => x.id !== gm.sessionId);
    await waitCourtFree(101, g.token, 30_000);
  });

  it('слова в чеке и платеже: у стола 8 — «Стол 8», слова «корт» нет (игра 60 минут, закрыта в конце)', async (t) => {
    const g = await newGuest();
    await waitTableFree(TABLE8, g.token);
    const tb = (await tableByCode(TABLE8, g.token)).json;
    const q = await quote(g.token, { resource_id: tb.resource.id, kind: 'start', minutes: 60 });
    assert.equal(q.status, 200, short(q));
    const pay = await payQuote(g.token, q.json.quote_id);
    assert.equal(pay.status, 200, short(pay));
    const { emuSucceed, providerId, emuPayment } = await import('./lib.mjs');
    emuSucceed(providerId(pay.json));
    const p = await waitFor(async () => {
      const r = await api('GET', `/api/payments/${pay.json.payment_id}`, { token: g.token });
      return r.status === 200 && r.json.session_id ? r.json : null;
    }, { what: 'сессия стола 8' });
    S.sessions.push({ guest: g, id: p.session_id });
    const rc = (await api('GET', `/api/sessions/${p.session_id}/receipt`, { token: g.token })).json;
    const em = JSON.stringify(emuPayment(providerId(pay.json)));
    t.diagnostic(`чек стола: ${rc.lines[0].title}; эмулятор: ${em.match(/"description":"[^"]*"/)?.[0]}`);
    assert.match(rc.lines[0].title, /^Стол 8/);
    assert.ok(!/[Кк]орт/.test(JSON.stringify(rc)), 'в чеке стола нет слова «корт»');
    assert.ok(!/[Кк]орт/.test(em), 'в платеже стола нет слова «корт»');
    const st = await stopGame(g, p.session_id);
    assert.equal(st.status, 200, short(st));
    S.sessions = S.sessions.filter((x) => x.id !== p.session_id);
  });
});

describe('дашборд «Зал» и «Столы» (M5.6 Н1)', () => {
  it('клуб сида, «Зал»: by_type — family и resources (корты 2), by_resource — все 10 ресурсов с family, «Сегодня» без выпадающих строк', async (t) => {
    const r = await api('GET', `/api/clubs/${CLUB_SEED}/dashboard?tab=hall&compare=0`, { token: S.owner.token, club: CLUB_SEED });
    assert.equal(r.status, 200, short(r));
    const bt = r.json.tables.by_type;
    const court = bt.find((x) => x.type === 'padel_court');
    assert.ok(court, `by_type: ${bt.map((x) => x.type)}`);
    assert.deepEqual([court.family, court.resources, court.tables], ['court', 2, 2]);
    for (const x of bt.filter((y) => y.type !== 'padel_court')) assert.equal(x.family, 'table', x.type);
    assert.equal(bt.filter((x) => x.family === 'table').reduce((a, x) => a + x.resources, 0), 8);
    const br = r.json.tables.by_resource;
    assert.equal(br.length, 10, `«Столы» сегодня: ${br.length} строк из 10`);
    assert.ok(br.every((x) => ['table', 'court'].includes(x.family)));
    assert.deepEqual(br.filter((x) => x.family === 'court').map((x) => x.title), ['Корт 1', 'Корт 2']);
    t.diagnostic(`by_type: ${bt.map((x) => `${x.type}:${x.family}:${x.resources}`).join(', ')}`);
  });

  it('новый клуб (3 стола и 1 корт, игр нет): «Столы» за сегодня и за день до создания — все 4 ресурса, нули, вид указан', async (t) => {
    const owner = await login(staffPhone());
    const c = await makeClub(owner, { name: 'E2E M5.8 Перепроверка Зал', kinds: ['pyramid', 'pool', 'snooker'], courts: 1, rules: [rule('06:00', '06:00', 600), courtRule('06:00', '06:00', 90, 2400)] });
    for (const [label, q] of [['сегодня', ''], ['вчера (клуба не было)', `&from=${dayPlus(-1)}&to=${dayPlus(-1)}`]]) {
      const r = await api('GET', `/api/clubs/${c.club}/dashboard?tab=hall&compare=0${q}`, { token: owner.token, club: c.club });
      assert.equal(r.status, 200, short(r));
      const br = r.json.tables.by_resource;
      t.diagnostic(`${label}: строк ${br.length}; ${br.map((x) => `${x.title}/${x.family}/игр ${x.games}/ёмкость ${x.capacity_minutes ?? '-'}`).join('; ')}`);
      assert.equal(br.length, 4, `${label}: «Столы» показывают все ресурсы`);
      assert.equal(br.filter((x) => x.family === 'court').length, 1);
      assert.ok(br.every((x) => x.games === 0 && x.revenue_kopecks === 0));
      assert.ok(br.every((x) => /^(Стол|Корт) \d+$/.test(x.title)));
    }
  });
});

describe('исправления захода 2 pentester (стенд)', () => {
  it('тариф ниже порога — 400: слот корта 49 коп., час стола 49 коп. при шаге 60, цена 0; слот 1 ₽ и час 600 ₽ проходят', async (t) => {
    const owner = await login(staffPhone());
    const c = await makeClub(owner, { name: 'E2E M5.8 Перепроверка Тариф', kinds: ['pyramid'], courts: 1 });
    const put = (rules) => api('PUT', `/api/clubs/${c.club}/tariffs`, { token: owner.token, club: c.club, body: { rules } });
    const out = [];
    for (const [label, rules] of [
      ['слот корта 49 коп.', [rule('06:00', '06:00', 600), courtRule('06:00', '06:00', 90, 0, { price_per_slot_kopecks: 49 })]],
      ['слот корта 0', [rule('06:00', '06:00', 600), courtRule('06:00', '06:00', 90, 0)]],
      ['час стола 49 коп., шаг 60', [rule('06:00', '06:00', 0, { price_per_hour_kopecks: 49, step_minutes: 60, min_minutes: 60 }), courtRule('06:00', '06:00', 90, 2400)]],
      ['час стола 29,99 ₽, шаг 1 мин', [rule('06:00', '06:00', 0, { price_per_hour_kopecks: 2999 }), courtRule('06:00', '06:00', 90, 2400)]],
    ]) {
      const r = await put(rules);
      out.push(`${label}: ${r.status} ${r.json?.error ?? ''}`);
      assert.equal(r.status, 400, `${label}: ${short(r)}`);
    }
    const ok = await put([rule('06:00', '06:00', 600), courtRule('06:00', '06:00', 90, 1)]);
    out.push(`слот 1 ₽: ${ok.status}`);
    assert.equal(ok.status, 200, short(ok));
    t.diagnostic(out.join('; '));
    // Шаблон сети: проверка в каждом клубе, ошибка с club_id.
    const net = await api('POST', '/api/networks', { token: owner.token, body: { name: 'E2E M5.8 Перепроверка Сеть' } });
    assert.equal(net.status, 201, short(net));
    assert.equal((await api('POST', `/api/networks/${net.json.id}/clubs`, { token: owner.token, body: { club_id: c.club } })).status, 201);
    const tpl = await api('PUT', `/api/networks/${net.json.id}/tariffs`, { token: owner.token, body: { rules: [rule('06:00', '06:00', 600), courtRule('06:00', '06:00', 90, 0, { price_per_slot_kopecks: 49 })] } });
    t.diagnostic(`шаблон сети со слотом 49 коп.: ${short(tpl)}`);
    assert.equal(tpl.status, 400, short(tpl));
  });

  it('жёсткое меню: группа, привязанная к товару шаблона ДО жёсткого режима, не правится (409 network_locked); группа своего товара — правится', async (t) => {
    const owner = await login(staffPhone());
    const c = await makeClub(owner, { name: 'E2E M5.8 Перепроверка Меню', kinds: ['pyramid'] });
    const net = await api('POST', '/api/networks', { token: owner.token, body: { name: 'E2E M5.8 Перепроверка Меню' } });
    assert.equal(net.status, 201, short(net));
    const nid = net.json.id;
    assert.equal((await api('POST', `/api/networks/${nid}/clubs`, { token: owner.token, body: { club_id: c.club } })).status, 201);
    const put = await api('PUT', `/api/networks/${nid}/menu`, { token: owner.token, body: { products: [{ category: 'Бар', name: 'Чай E2E', sku: 'E2E-RC-TEA', price_kopecks: 15_000, unit: 'шт' }] } });
    assert.equal(put.status, 200, short(put));
    const cat = async () => (await api('GET', `/api/clubs/${c.club}/catalog`, { token: owner.token, club: c.club })).json;
    const tea = (await cat()).products.find((p) => p.sku === 'E2E-RC-TEA');
    assert.ok(tea?.network_product_id, 'товар шаблона в каталоге клуба');
    const clubApi = (method, path, body) => api(method, path, { token: owner.token, club: c.club, body });
    // Мягкий режим: группа создаётся и привязывается к товару шаблона.
    const grp = await clubApi('POST', `/api/clubs/${c.club}/catalog/modifier-groups`, { name: 'Допы', min_select: 0, max_select: 1, modifiers: [{ name: 'Лимон', price_delta_kopecks: 0 }] });
    assert.equal(grp.status, 201, short(grp));
    const link = await clubApi('PATCH', `/api/catalog/products/${tea.id}`, { modifier_group_ids: [grp.json.id] });
    assert.equal(link.status, 200, `привязка в мягком режиме: ${short(link)}`);
    // Свой товар клуба с группой (контроль).
    const own = await clubApi('POST', `/api/clubs/${c.club}/catalog/products`, { name: 'Свой товар E2E', price_kopecks: 5000 });
    assert.equal(own.status, 201, short(own));
    const grp2 = await clubApi('POST', `/api/clubs/${c.club}/catalog/modifier-groups`, { name: 'Свои допы', min_select: 0, max_select: 1, modifiers: [{ name: 'Мёд', price_delta_kopecks: 1000 }] });
    assert.equal(grp2.status, 201, short(grp2));
    assert.equal((await clubApi('PATCH', `/api/catalog/products/${own.json.id}`, { modifier_group_ids: [grp2.json.id] })).status, 200);
    // Жёсткий режим.
    assert.equal((await api('PATCH', `/api/networks/${nid}`, { token: owner.token, body: { menu_mode: 'hard' } })).status, 200);
    const res = [];
    const add = await clubApi('POST', `/api/catalog/modifier-groups/${grp.json.id}/modifiers`, { name: 'Дорогой', price_delta_kopecks: 50_000 });
    res.push(`POST модификатор: ${add.status} ${add.json?.error ?? ''}`);
    assert.deepEqual([add.status, add.json?.error], [409, 'network_locked']);
    const patchMod = await clubApi('PATCH', `/api/catalog/modifiers/${grp.json.modifiers[0].id}`, { price_delta_kopecks: 40_000 });
    res.push(`PATCH модификатор: ${patchMod.status} ${patchMod.json?.error ?? ''}`);
    assert.deepEqual([patchMod.status, patchMod.json?.error], [409, 'network_locked']);
    const patchGrp = await clubApi('PATCH', `/api/catalog/modifier-groups/${grp.json.id}`, { name: 'Переименовано', min_select: 1 });
    res.push(`PATCH группа: ${patchGrp.status} ${patchGrp.json?.error ?? ''}`);
    assert.deepEqual([patchGrp.status, patchGrp.json?.error], [409, 'network_locked']);
    const patchOff = await clubApi('PATCH', `/api/catalog/modifiers/${grp.json.modifiers[0].id}`, { active: false });
    res.push(`PATCH выключить: ${patchOff.status} ${patchOff.json?.error ?? ''}`);
    assert.equal(patchOff.status, 409, 'выключение «по умолчанию»/надбавки привязанной группы тоже закрыто');
    const relink = await clubApi('PATCH', `/api/catalog/products/${tea.id}`, { modifier_group_ids: [] });
    res.push(`отвязать группу от товара шаблона: ${relink.status} ${relink.json?.error ?? ''}`);
    assert.equal(relink.status, 409);
    // Контроль: группа своего товара правится, стоп-лист товара шаблона клуб ведёт сам.
    const ownAdd = await clubApi('POST', `/api/catalog/modifier-groups/${grp2.json.id}/modifiers`, { name: 'Имбирь', price_delta_kopecks: 2000 });
    res.push(`контроль, своя группа POST: ${ownAdd.status}`);
    assert.equal(ownAdd.status, 201, short(ownAdd));
    const ownPatch = await clubApi('PATCH', `/api/catalog/modifiers/${grp2.json.modifiers[0].id}`, { price_delta_kopecks: 1500 });
    res.push(`контроль, своя группа PATCH: ${ownPatch.status}`);
    assert.equal(ownPatch.status, 200, short(ownPatch));
    // Нетронутая группа не изменилась.
    const after = (await cat()).modifier_groups?.find((g) => g.id === grp.json.id) ?? null;
    if (after) assert.deepEqual([after.name, after.modifiers.length], ['Допы', 1]);
    t.diagnostic(res.join('; '));
    // Мягкий режим возвращает правку.
    assert.equal((await api('PATCH', `/api/networks/${nid}`, { token: owner.token, body: { menu_mode: 'soft' } })).status, 200);
    const soft = await clubApi('POST', `/api/catalog/modifier-groups/${grp.json.id}/modifiers`, { name: 'Мягко', price_delta_kopecks: 1000 });
    assert.equal(soft.status, 201, `мягкий режим: ${short(soft)}`);
  });

  it('бронь на 0 ₽: на стенде недостижима — тариф ниже порога не принимается, бронь на минимальный тариф (слот 1 ₽) создаётся с ненулевой суммой', async (t) => {
    const owner = await login(staffPhone());
    const c = await makeClub(owner, { name: 'E2E M5.8 Перепроверка Бронь', kinds: ['pyramid'], courts: 1, rules: [rule('06:00', '06:00', 600), courtRule('06:00', '06:00', 90, 1)] });
    const court = c.resources.find((r) => r.family === 'court' || r.type === 'padel_court');
    const g = await newGuest();
    const start = new Date(Math.ceil((Date.now() + 3 * 86_400_000) / 1_800_000) * 1_800_000).toISOString();
    const b = await api('POST', '/api/bookings', { token: g.token, body: { resource_id: court.id, starts_at: start, minutes: 90 } });
    t.diagnostic(`бронь корта со слотом 1 ₽: ${short(b)}`);
    if (b.status === 201) {
      assert.ok(b.json.amount_kopecks >= 100, `сумма брони ${b.json.amount_kopecks}`);
      await api('POST', `/api/bookings/${b.json.id}/cancel`, { token: g.token, body: {} });
    } else assert.ok(b.status >= 400 && b.status < 500, short(b));
  });
});
