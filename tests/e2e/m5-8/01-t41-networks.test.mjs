// T41 «Шаблон тарифа сети» (docs/contracts/m5-5-8.md №190, №191, №215) на стенде.
//
// Свои клубы test (не live): владелец A — сеть «Сеть Урал» из клубов Екатеринбург (UTC+5), Калининград (UTC+2) и
// Новосибирск (UTC+7, добавляется позже со своими тарифами); владелец B — вторая сеть для отказов при добавлении.
// Шаги:
//   1. шаблон 06–18 / 18–06 → в обоих клубах те же локальные границы и цены; цену подтверждает бронь на одно и то же
//      местное время (17:30–18:30) — 750 ₽ в обоих клубах, а на один и тот же момент UTC цены разные (пояса);
//   2. мягкий режим: правка клуба держится при новой версии шаблона (в журнале applied:false), у второго клуба новая версия;
//      «Вернуть как в сети» (`POST …/network/reset`) возвращает к шаблону;
//   3. жёсткий режим: переход возвращает переопределивших к шаблону; правка клуба — 409 network_locked; меню: правка
//      товара шаблона — 409, импорт CSV по такому товару — ошибка строки network_template и ничего не применено;
//   4. клуб, добавленный в сеть, сразу получает шаблоны (его тарифы заменены, в журнале added);
//   5. добавление клуба с кортом при шаблоне без правил корта — 400 tariff_gap {club_id, kind:'padel_court'},
//      клуб не в сети, его тарифы целы; после шаблона с правилом корта — добавлен;
//   6. журнал network.* в каждом клубе, цепочка цела (audit/verify), права: управляющий клуба не владелец сети, чужой — 404.
// `live` на стенде недоступен (нужны ЮKassa и чек-лист): причина, журнал manual.* и уведомление по live — в
// 05-db-networks.test.mjs на своём Postgres.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { ALL_DAYS, api, auditOf, bookingPrice, courtRule, dayPlus, invite, localToUtc, login, makeClub, newGuest, rule, rulesView, saveState, short, staffPhone, TZ } from './lib.mjs';

const S = {};

const tariffsOf = async (club, token) => (await api('GET', `/api/clubs/${club}/tariffs`, { token, club })).json;
const netOf = async (club, token) => (await api('GET', `/api/clubs/${club}/network`, { token, club })).json.network;
const TEMPLATE_1 = [rule('06:00', '18:00', 600), rule('18:00', '06:00', 900)];
const TEMPLATE_2 = [rule('06:00', '18:00', 650), rule('18:00', '06:00', 950)];

before(async () => {
  S.a = await login(staffPhone());
  S.b = await login(staffPhone());
  S.e = await makeClub(S.a, { name: 'E2E M5.8 Урал-Екб', city: 'Екатеринбург', tz: TZ.ekb });
  S.k = await makeClub(S.a, { name: 'E2E M5.8 Урал-Кгд', city: 'Калининград', tz: TZ.kgd });
  S.n = await makeClub(S.a, { name: 'E2E M5.8 Урал-Нск', city: 'Новосибирск', tz: TZ.nsk, rules: [rule('06:00', '06:00', 400)] });
  S.guest = await newGuest();
  saveState({ t41: { owner: S.a.phone, e: S.e.club, k: S.k.club, n: S.n.club } });
});

describe('T41. шаблон тарифа сети', () => {
  it('сеть создана; клубы Екатеринбург и Калининград добавлены (шаблона ещё нет — ничего не применяется)', async () => {
    const c = await api('POST', '/api/networks', { token: S.a.token, body: { name: 'E2E M5.8 Сеть Урал' } });
    assert.equal(c.status, 201, short(c));
    S.net = c.json.id;
    for (const club of [S.e.club, S.k.club]) {
      const r = await api('POST', `/api/networks/${S.net}/clubs`, { token: S.a.token, body: { club_id: club } });
      assert.equal(r.status, 201, short(r));
    }
    const g = await api('GET', `/api/networks/${S.net}`, { token: S.a.token });
    assert.deepEqual(g.json.clubs.map((x) => x.timezone).sort(), [TZ.ekb, TZ.kgd]);
    assert.equal(g.json.tariffs.template, false);
    assert.equal((await netOf(S.e.club, S.a.token)).tariffs.template, false);
    // Клуб в двух сетях — нельзя; чужой клуб — нельзя.
    const second = await api('POST', '/api/networks', { token: S.a.token, body: { name: 'E2E M5.8 Вторая' } });
    assert.equal(second.status, 201);
    S.net2 = second.json.id;
    const dup = await api('POST', `/api/networks/${S.net2}/clubs`, { token: S.a.token, body: { club_id: S.e.club } });
    assert.equal(dup.status, 409, short(dup));
    assert.equal(dup.json.error, 'club_in_network');
    const foreign = await api('POST', `/api/networks/${S.net2}/clubs`, { token: S.b.token, body: { club_id: S.n.club } });
    assert.ok([403, 404].includes(foreign.status), `чужая сеть/клуб: ${short(foreign)}`);
  });

  it('шаблон 06–18 / 18–06: в обоих клубах те же локальные границы и цены (копейки)', async (t) => {
    const put = await api('PUT', `/api/networks/${S.net}/tariffs`, { token: S.a.token, body: { rules: TEMPLATE_1 } });
    assert.equal(put.status, 200, short(put));
    assert.equal(put.json.version, 1);
    assert.equal(put.json.mode, 'soft');
    const te = await tariffsOf(S.e.club, S.a.token);
    const tk = await tariffsOf(S.k.club, S.a.token);
    assert.equal(te.timezone, TZ.ekb);
    assert.equal(tk.timezone, TZ.kgd);
    assert.deepEqual(rulesView(te.rules), rulesView(tk.rules), 'правила в клубах одинаковы (местное время и копейки)');
    assert.deepEqual(rulesView(te.rules), rulesView(TEMPLATE_1.map((r) => ({ ...r, kind: null }))));
    assert.ok(te.coverage.ok && tk.coverage.ok, 'неделя покрыта');
    for (const club of [S.e.club, S.k.club]) {
      const n = await netOf(club, S.a.token);
      assert.deepEqual([n.tariffs.template, n.tariffs.mode, n.tariffs.locked, n.tariffs.override, n.tariffs.version, n.tariffs.applied_version], [true, 'soft', false, false, 1, 1], club);
    }
    t.diagnostic(`Екб: ${JSON.stringify(rulesView(te.rules))}; Кгд: ${JSON.stringify(rulesView(tk.rules))}`);
  });

  it('цена по местному времени клуба: бронь 17:30–18:30 местного = 750 ₽ в обоих клубах, один момент UTC — разные цены', async (t) => {
    const day = dayPlus(3);
    const tableE = S.e.resources.find((r) => r.number === 1).id;
    const tableK = S.k.resources.find((r) => r.number === 1).id;
    // 17:30 местного: 30 мин по 600 ₽/ч + 30 мин по 900 ₽/ч = 300 + 450.
    const e = await bookingPrice(S.guest, tableE, localToUtc(day, '17:30', TZ.ekb), 60);
    const k = await bookingPrice(S.guest, tableK, localToUtc(day, '17:30', TZ.kgd), 60);
    assert.equal(e.status, 201, JSON.stringify(e));
    assert.equal(k.status, 201, JSON.stringify(k));
    assert.equal(e.amount, 75_000, 'Екатеринбург 17:30 местного');
    assert.equal(k.amount, 75_000, 'Калининград 17:30 местного');
    // Один и тот же момент UTC (12:30Z): в Екатеринбурге 17:30 (граница в середине), в Калининграде 14:30 (весь час по 600).
    const same = localToUtc(day, '17:30', TZ.ekb);
    const k2 = await bookingPrice(S.guest, tableK, same, 60);
    assert.equal(k2.status, 201, JSON.stringify(k2));
    assert.equal(k2.amount, 60_000, 'Калининград, тот же момент UTC (14:30 местного): 600 ₽');
    // Ночь: 05:30 местного = 30 мин вечерних (900) + 30 мин дневных (600) = 450 + 300.
    const ne = await bookingPrice(S.guest, tableE, localToUtc(dayPlus(4), '05:30', TZ.ekb), 60);
    const nk = await bookingPrice(S.guest, tableK, localToUtc(dayPlus(4), '05:30', TZ.kgd), 60);
    assert.equal(ne.amount, 75_000, `Екб 05:30 (${JSON.stringify(ne)})`);
    assert.equal(nk.amount, 75_000, `Кгд 05:30 (${JSON.stringify(nk)})`);
    t.diagnostic(`17:30 местного: Екб ${e.amount}, Кгд ${k.amount}; тот же UTC в Кгд ${k2.amount}; 05:30: Екб ${ne.amount}, Кгд ${nk.amount} (копейки)`);
  });

  it('мягкий режим: правка клуба (Екатеринбург) держится при новой версии шаблона; Калининград получает v2', async () => {
    const own = [rule('06:00', '06:00', 500)];
    const put = await api('PUT', `/api/clubs/${S.e.club}/tariffs`, { token: S.a.token, club: S.e.club, body: { rules: own } });
    assert.equal(put.status, 200, short(put));
    let n = await netOf(S.e.club, S.a.token);
    assert.equal(n.tariffs.override, true, 'клуб помечен переопределившим');
    assert.equal(n.tariffs.locked, false);
    const v2 = await api('PUT', `/api/networks/${S.net}/tariffs`, { token: S.a.token, body: { rules: TEMPLATE_2 } });
    assert.equal(v2.status, 200, short(v2));
    assert.equal(v2.json.version, 2);
    const te = await tariffsOf(S.e.club, S.a.token);
    const tk = await tariffsOf(S.k.club, S.a.token);
    assert.deepEqual(rulesView(te.rules), rulesView(own), 'Екатеринбург держит своё');
    assert.deepEqual(rulesView(tk.rules), rulesView(TEMPLATE_2), 'Калининград — v2');
    n = await netOf(S.e.club, S.a.token);
    assert.deepEqual([n.tariffs.override, n.tariffs.version, n.tariffs.applied_version], [true, 2, 1]);
    const nk = await netOf(S.k.club, S.a.token);
    assert.deepEqual([nk.tariffs.override, nk.tariffs.version, nk.tariffs.applied_version], [false, 2, 2]);
    // Журнал: у Екатеринбурга — «шаблон есть, не применён», у Калининграда — применён.
    const ae = await auditOf(S.e.club, S.a.token, 'network.tariffs_template');
    assert.ok(ae.some((x) => x.data?.applied === false && x.data?.version === 2), `журнал Екб: ${JSON.stringify(ae.map((x) => x.data))}`);
    const ak = await auditOf(S.k.club, S.a.token, 'network.tariffs_applied');
    assert.ok(ak.some((x) => x.data?.version === 2 && x.data?.mode === 'soft'), 'журнал Кгд: применён v2');
    // Цена брони в Екатеринбурге — по своему тарифу клуба (500 ₽/ч), в Калининграде — по v2.
    const day = dayPlus(5);
    const pe = await bookingPrice(S.guest, S.e.resources.find((r) => r.number === 1).id, localToUtc(day, '12:00', TZ.ekb), 60);
    const pk = await bookingPrice(S.guest, S.k.resources.find((r) => r.number === 1).id, localToUtc(day, '12:00', TZ.kgd), 60);
    assert.equal(pe.amount, 50_000, 'Екб: своё 500 ₽/ч');
    assert.equal(pk.amount, 65_000, 'Кгд: шаблон v2 650 ₽/ч');
  });

  it('POST …/network/reset {scope: tariffs}: клуб возвращается к шаблону (v2), пометка снята', async () => {
    const bad = await api('POST', `/api/clubs/${S.e.club}/network/reset`, { token: S.a.token, club: S.e.club, body: { scope: 'nothing' } });
    assert.equal(bad.status, 400, short(bad));
    const r = await api('POST', `/api/clubs/${S.e.club}/network/reset`, { token: S.a.token, club: S.e.club, body: { scope: 'tariffs' } });
    assert.equal(r.status, 200, short(r));
    assert.equal(r.json.scope, 'tariffs');
    assert.deepEqual(rulesView(r.json.tariffs.rules), rulesView(TEMPLATE_2));
    const n = await netOf(S.e.club, S.a.token);
    assert.deepEqual([n.tariffs.override, n.tariffs.applied_version], [false, 2]);
    const a = await auditOf(S.e.club, S.a.token, 'network.tariffs_applied');
    assert.ok(a.some((x) => x.data?.reset === true), 'журнал: reset:true');
    // Клуб вне сети reset не делает.
    const out = await api('POST', `/api/clubs/${S.n.club}/network/reset`, { token: S.a.token, club: S.n.club, body: { scope: 'tariffs' } });
    assert.ok(out.status >= 400 && out.status < 500, `клуб вне сети: ${short(out)}`);
  });

  it('жёсткий режим: правка Екатеринбурга до перехода возвращается к шаблону; затем правка клуба — 409 network_locked', async () => {
    const own = [rule('06:00', '06:00', 480)];
    assert.equal((await api('PUT', `/api/clubs/${S.e.club}/tariffs`, { token: S.a.token, club: S.e.club, body: { rules: own } })).status, 200);
    assert.equal((await netOf(S.e.club, S.a.token)).tariffs.override, true);
    const p = await api('PATCH', `/api/networks/${S.net}`, { token: S.a.token, body: { tariffs_mode: 'hard' } });
    assert.equal(p.status, 200, short(p));
    assert.equal(p.json.tariffs_mode, 'hard');
    const te = await tariffsOf(S.e.club, S.a.token);
    assert.deepEqual(rulesView(te.rules), rulesView(TEMPLATE_2), 'переход в hard вернул переопределивших к шаблону');
    const n = await netOf(S.e.club, S.a.token);
    assert.deepEqual([n.tariffs.mode, n.tariffs.locked, n.tariffs.override], ['hard', true, false]);
    for (const club of [S.e.club, S.k.club]) {
      const r = await api('PUT', `/api/clubs/${club}/tariffs`, { token: S.a.token, club, body: { rules: own } });
      assert.equal(r.status, 409, short(r));
      assert.equal(r.json.error, 'network_locked');
      assert.equal(r.json.network_id, S.net);
      assert.deepEqual(rulesView((await tariffsOf(club, S.a.token)).rules), rulesView(TEMPLATE_2), 'тарифы не изменились');
    }
    // Новая версия шаблона в hard идёт во все клубы.
    const v3 = await api('PUT', `/api/networks/${S.net}/tariffs`, { token: S.a.token, body: { rules: [rule('06:00', '18:00', 700), rule('18:00', '06:00', 1000)] } });
    assert.equal(v3.status, 200, short(v3));
    for (const club of [S.e.club, S.k.club]) {
      const t = await tariffsOf(club, S.a.token);
      assert.ok(rulesView(t.rules).every((x) => /\|(70000|100000)\|/.test(x)), `${club}: ${rulesView(t.rules)}`);
    }
    // Журнал сети в каждом клубе: network.updated (переход в hard).
    for (const club of [S.e.club, S.k.club]) {
      const a = await auditOf(club, S.a.token, 'network.updated');
      assert.ok(a.some((x) => JSON.stringify(x.data).includes('hard')), `network.updated в ${club}`);
    }
    // Обратно в мягкий: правка клуба снова проходит.
    assert.equal((await api('PATCH', `/api/networks/${S.net}`, { token: S.a.token, body: { tariffs_mode: 'soft' } })).status, 200);
    assert.equal((await api('PUT', `/api/clubs/${S.k.club}/tariffs`, { token: S.a.token, club: S.k.club, body: { rules: own } })).status, 200);
    assert.equal((await netOf(S.k.club, S.a.token)).tariffs.override, true);
    // Вернуть Калининград к шаблону — для следующих шагов.
    assert.equal((await api('POST', `/api/clubs/${S.k.club}/network/reset`, { token: S.a.token, club: S.k.club, body: { scope: 'tariffs' } })).status, 200);
    saveState({ t41net: S.net });
  });

  it('меню: мягкий — правка клуба = переопределение; жёсткий — 409 network_locked и импорт по товару шаблона отклонён', async (t) => {
    const put = await api('PUT', `/api/networks/${S.net}/menu`, {
      token: S.a.token,
      body: { products: [{ category: 'Бар', name: 'Лимонад E2E', sku: 'E2E-LEM', price_kopecks: 15_000, unit: 'шт' }, { category: 'Бар', name: 'Чай E2E', sku: 'E2E-TEA', price_kopecks: 9_000, unit: 'шт' }] },
    });
    assert.equal(put.status, 200, short(put));
    const cat = async (club) => (await api('GET', `/api/clubs/${club}/catalog`, { token: S.a.token, club })).json;
    const findP = (c, sku) => (c.products ?? c.items ?? []).find((p) => p.sku === sku);
    let ce = await cat(S.e.club);
    const lem = findP(ce, 'E2E-LEM');
    assert.ok(lem, `товар шаблона в каталоге клуба: ${JSON.stringify(Object.keys(ce))}`);
    assert.ok(lem.network_product_id);
    // Мягкий: правка цены → переопределение.
    const patch = await api('PATCH', `/api/catalog/products/${lem.id}`, { token: S.a.token, club: S.e.club, body: { price_kopecks: 16_000 } });
    assert.equal(patch.status, 200, short(patch));
    ce = await cat(S.e.club);
    assert.equal(findP(ce, 'E2E-LEM').network_override, true);
    assert.equal(findP(ce, 'E2E-LEM').price_kopecks, 16_000);
    // Новая версия шаблона (цена 17 000) переопределённый товар не меняет, чай — меняет.
    const put2 = await api('PUT', `/api/networks/${S.net}/menu`, {
      token: S.a.token,
      body: { products: [{ category: 'Бар', name: 'Лимонад E2E', sku: 'E2E-LEM', price_kopecks: 17_000, unit: 'шт' }, { category: 'Бар', name: 'Чай E2E', sku: 'E2E-TEA', price_kopecks: 9_500, unit: 'шт' }] },
    });
    assert.equal(put2.status, 200, short(put2));
    ce = await cat(S.e.club);
    assert.equal(findP(ce, 'E2E-LEM').price_kopecks, 16_000, 'мягкий: переопределение держится');
    assert.equal(findP(ce, 'E2E-TEA').price_kopecks, 9_500);
    const ck = await cat(S.k.club);
    assert.equal(findP(ck, 'E2E-LEM').price_kopecks, 17_000, 'Калининград — шаблон');
    // Жёсткий.
    assert.equal((await api('PATCH', `/api/networks/${S.net}`, { token: S.a.token, body: { menu_mode: 'hard' } })).status, 200);
    ce = await cat(S.e.club);
    assert.equal(findP(ce, 'E2E-LEM').price_kopecks, 17_000, 'переход в hard вернул цену шаблона');
    const lem2 = findP(ce, 'E2E-LEM');
    const locked = await api('PATCH', `/api/catalog/products/${lem2.id}`, { token: S.a.token, club: S.e.club, body: { price_kopecks: 18_000 } });
    assert.equal(locked.status, 409, short(locked));
    assert.equal(locked.json.error, 'network_locked');
    // Импорт CSV по товару шаблона: предпросмотр и боевой — ошибка строки network_template, ничего не применено.
    const csv = 'категория;название;цена;ед;артикул\nБар;Лимонад E2E;180;шт;E2E-LEM\nБар;Свой товар клуба E2E;50;шт;E2E-OWN\n';
    const dry = await api('POST', `/api/clubs/${S.e.club}/catalog/import`, { token: S.a.token, club: S.e.club, body: { csv, dry_run: true } });
    assert.equal(dry.status, 200, short(dry));
    assert.deepEqual([dry.json.applied, dry.json.errors.map((e) => e.code)], [false, ['network_template']], short(dry));
    const imp = await api('POST', `/api/clubs/${S.e.club}/catalog/import`, { token: S.a.token, club: S.e.club, body: { csv } });
    assert.ok([200, 400, 409].includes(imp.status), short(imp));
    assert.equal(imp.json.applied, false, short(imp));
    assert.equal(imp.json.errors?.[0]?.code, 'network_template');
    ce = await cat(S.e.club);
    assert.equal(findP(ce, 'E2E-LEM').price_kopecks, 17_000, 'цена не изменилась');
    assert.equal(findP(ce, 'E2E-OWN'), undefined, 'импорт целиком не применён — своего товара нет');
    // Только своё — импорт проходит (свои товары клуба можно).
    const own = await api('POST', `/api/clubs/${S.e.club}/catalog/import`, { token: S.a.token, club: S.e.club, body: { csv: 'категория;название;цена;ед;артикул\nБар;Свой товар клуба E2E;50;шт;E2E-OWN\n' } });
    assert.equal(own.status, 200, short(own));
    assert.equal(own.json.applied, true);
    // Алкоголь шаблона клуб не снимает ни в каком режиме — отдельно в db-тестах; здесь — журнал.
    const a = await auditOf(S.e.club, S.a.token, 'network.menu*');
    t.diagnostic(`журнал меню Екб: ${[...new Set(a.map((x) => x.action))].join(', ')}`);
    assert.ok(a.some((x) => x.action === 'network.menu_applied' || x.action === 'network.menu_template'));
    assert.equal((await api('PATCH', `/api/networks/${S.net}`, { token: S.a.token, body: { menu_mode: 'soft' } })).status, 200);
  });

  it('клуб, добавленный в сеть, сразу получает шаблон: его тарифы (400 ₽/ч) заменены; журнал network.club_added и added:true', async () => {
    const before = await tariffsOf(S.n.club, S.a.token);
    assert.deepEqual(rulesView(before.rules), rulesView([rule('06:00', '06:00', 400)]));
    const r = await api('POST', `/api/networks/${S.net}/clubs`, { token: S.a.token, body: { club_id: S.n.club } });
    assert.equal(r.status, 201, short(r));
    const after = await tariffsOf(S.n.club, S.a.token);
    const tmpl = await api('GET', `/api/networks/${S.net}/tariffs`, { token: S.a.token });
    assert.deepEqual(rulesView(after.rules), rulesView(tmpl.json.rules.map((x) => ({ ...x, kind: x.kind ?? null }))), 'тарифы клуба = шаблон');
    assert.equal(after.timezone, TZ.nsk);
    const n = await netOf(S.n.club, S.a.token);
    assert.equal(n.tariffs.override, false);
    assert.equal(n.tariffs.applied_version, tmpl.json.version);
    const added = await auditOf(S.n.club, S.a.token, 'network.club_added');
    assert.equal(added.length, 1);
    const applied = await auditOf(S.n.club, S.a.token, 'network.tariffs_applied');
    assert.ok(applied.some((x) => x.data?.added === true), `network.tariffs_applied added: ${JSON.stringify(applied.map((x) => x.data))}`);
    // Повторное добавление — 200 без изменений.
    const again = await api('POST', `/api/networks/${S.net}/clubs`, { token: S.a.token, body: { club_id: S.n.club } });
    assert.equal(again.status, 200, short(again));
    // План «Сеть» из 3 клубов применяется (подробно — T42).
    assert.equal((await api('GET', `/api/networks/${S.net}`, { token: S.a.token })).json.clubs.length, 3);
  });

  it('добавление клуба с кортом при шаблоне без правил корта — 400 tariff_gap {club_id, kind: padel_court}, клуб не добавлен, его тарифы целы', async () => {
    const x = await makeClub(S.b, { name: 'E2E M5.8 Сеть-2 Стол', kinds: ['pyramid'], rules: [rule('06:00', '06:00', 450)] });
    const g = await makeClub(S.b, { name: 'E2E M5.8 Сеть-2 Корт', kinds: ['pool'], courts: 1, rules: [rule('06:00', '06:00', 470), courtRule('06:00', '06:00', 90, 2400)] });
    S.x = x;
    S.g = g;
    const net = await api('POST', '/api/networks', { token: S.b.token, body: { name: 'E2E M5.8 Сеть Б' } });
    assert.equal(net.status, 201);
    S.netB = net.json.id;
    assert.equal((await api('POST', `/api/networks/${S.netB}/clubs`, { token: S.b.token, body: { club_id: x.club } })).status, 201);
    const put = await api('PUT', `/api/networks/${S.netB}/tariffs`, { token: S.b.token, body: { rules: [rule('06:00', '06:00', 500)] } });
    assert.equal(put.status, 200, short(put));
    const before = rulesView((await tariffsOf(g.club, S.b.token)).rules);
    const r = await api('POST', `/api/networks/${S.netB}/clubs`, { token: S.b.token, body: { club_id: g.club } });
    assert.equal(r.status, 400, short(r));
    assert.equal(r.json.error, 'tariff_gap');
    assert.equal(r.json.club_id, g.club);
    assert.equal(r.json.kind, 'padel_court');
    assert.ok(r.json.weekday >= 1 && r.json.from, `weekday/from: ${short(r)}`);
    assert.equal((await netOf(g.club, S.b.token)), null, 'клуб не в сети');
    assert.equal((await api('GET', `/api/networks/${S.netB}`, { token: S.b.token })).json.clubs.length, 1);
    assert.deepEqual(rulesView((await tariffsOf(g.club, S.b.token)).rules), before, 'тарифы клуба не тронуты');
    assert.equal((await auditOf(g.club, S.b.token, 'network.club_added')).length, 0, 'в журнале клуба нет записи о добавлении');
    // Шаблон с правилом корта (слот 90): клуб добавляется, правила корта из шаблона.
    const put2 = await api('PUT', `/api/networks/${S.netB}/tariffs`, { token: S.b.token, body: { rules: [rule('06:00', '06:00', 500), courtRule('06:00', '06:00', 90, 2600)] } });
    assert.equal(put2.status, 200, short(put2));
    const ok = await api('POST', `/api/networks/${S.netB}/clubs`, { token: S.b.token, body: { club_id: g.club } });
    assert.equal(ok.status, 201, short(ok));
    saveState({ t41b: { owner: S.b.phone, net: S.netB, x: x.club, g: g.club } });
    const t = await tariffsOf(g.club, S.b.token);
    assert.deepEqual(t.slots, { padel_court: 90 });
    assert.ok(rulesView(t.rules).some((v) => v.startsWith('padel_court|') && v.includes('slot90=260000')), rulesView(t.rules).join(' ; '));
    // Мусорная форма шаблона и роли.
    assert.equal((await api('PUT', `/api/networks/${S.netB}/tariffs`, { token: S.b.token, body: { rules: [] } })).status, 400);
    assert.equal((await api('PUT', `/api/networks/${S.netB}/tariffs`, { token: S.b.token, body: { rules: [rule('06:00', '12:00', 500)] } })).status, 400, 'дыра в неделе шаблона');
    assert.equal((await api('PUT', `/api/networks/${S.netB}/tariffs`, { token: S.b.token, body: { rules: [rule('06:00', '06:00', 0)] } })).status, 400, 'цена 0');
    assert.equal((await api('PUT', `/api/networks/${S.net}/tariffs`, { token: S.b.token, body: { rules: TEMPLATE_1 } })).status, 404, 'чужая сеть');
  });

  it('журнал network.* в каждом клубе сети; цепочка журнала цела', async (t) => {
    const need = {
      [S.e.club]: ['network.club_added', 'network.tariffs_applied', 'network.tariffs_template', 'network.updated'],
      [S.k.club]: ['network.club_added', 'network.tariffs_applied', 'network.updated'],
      [S.n.club]: ['network.club_added', 'network.tariffs_applied'],
    };
    for (const [club, actions] of Object.entries(need)) {
      const items = await auditOf(club, S.a.token, 'network.*');
      const have = new Set(items.map((x) => x.action));
      for (const a of actions) assert.ok(have.has(a), `${club}: нет ${a}; есть ${[...have].join(', ')}`);
      assert.ok(items.every((x) => x.actor_type === 'user' && x.actor_id), 'исполнитель записан');
      const v = await api('GET', `/api/clubs/${club}/audit/verify`, { token: S.a.token, club });
      assert.equal(v.status, 200, short(v));
      assert.equal(v.json.ok, true, short(v));
      t.diagnostic(`${club.slice(0, 8)}: network.* ${items.length} записей (${[...have].join(', ')}); цепочка ok, записей ${v.json.checked ?? v.json.count ?? '?'}`);
    }
    const g = await auditOf(S.g.club, S.b.token, 'network.*');
    assert.ok(g.some((x) => x.action === 'network.club_added'));
  });

  it('права: управляющий клуба шаблон сети не меняет; чужой пользователь — 404; без входа — 401', async () => {
    const man = await invite(S.e.club, S.a.token, 'manager');
    const put = await api('PUT', `/api/networks/${S.net}/tariffs`, { token: man.token, body: { rules: TEMPLATE_1 } });
    assert.ok([403, 404].includes(put.status), `управляющий клуба (не сети): ${short(put)}`);
    const stranger = await login(staffPhone());
    for (const [m, p] of [['GET', `/api/networks/${S.net}`], ['GET', `/api/networks/${S.net}/tariffs`], ['GET', `/api/networks/${S.net}/menu`], ['GET', `/api/networks/${S.net}/dashboard`]]) {
      assert.equal((await api(m, p, { token: stranger.token })).status, 404, `${m} ${p}`);
    }
    assert.equal((await api('PUT', `/api/networks/${S.net}/tariffs`, { token: stranger.token, body: { rules: TEMPLATE_1 } })).status, 404);
    assert.equal((await api('GET', `/api/networks/${S.net}`)).status, 401);
    assert.equal((await api('POST', `/api/clubs/${S.e.club}/network/reset`, { token: stranger.token, club: S.e.club, body: { scope: 'tariffs' } })).status, 403);
    assert.equal(ALL_DAYS.length, 7);
  });
});
