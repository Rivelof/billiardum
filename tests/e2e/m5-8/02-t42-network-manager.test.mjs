// T42 «Управляющий сети, сравнение, изоляция, подписка „Сеть“» (docs/contracts/m5-5-8.md №192–194, №214, №218) на стенде.
//
// Свои клубы test (не live; клуб сида в сеть не входит — на нём были бы чужие данные и доступ управляющего сети к
// живому клубу): владелец A — сеть из клубов C1 (Екатеринбург, 4 стола и 2 корта) и C2 (Калининград), владелец B — своя сеть.
// Ресепшн C1 открывает смену и продаёт бар наличными; управляющий сети (приглашение → вход) смотрит те же данные.
// Проверки:
//   * приглашение (7 дней, текст без телефона), принятие при входе, видит все клубы сети как управляющий;
//   * нет «Денег» (tab=money — 403) и экспортов (дашборд, истории, смены, касса — 403, у управляющего клуба — 200);
//   * способы оплаты — `method`, `methods`, `payment_method`, `by_method`, `cash_sales_kopecks`, `cash_refunds_kopecks`,
//     `received_kopecks`, `change_kopecks` — `null` на любой глубине во всех GET-маршрутах клуба (смена, продажи, журнал,
//     «Сейчас», отчёт смены); у владельца те же поля не null (проверка не пустая);
//   * терминал ресепшена управляющий сети не заводит (403), управляющий клуба — заводит;
//   * вывод клуба из сети и отзыв управляющего снимают доступ сразу (следующий же запрос тем же токеном);
//   * чужая сеть — 404 (и данные, и управление), чужой клуб — 403;
//   * сравнение: вкладка «Сеть» = дашборд клуба (плитки, tables_avg), корты отдельно, тестовые клубы вне рейтинга;
//   * подписка «Сеть»: `plan.applies` только при 2+ клубах, цена 119 000 коп. (1 190 ₽) за стол.
// Выручка на живых данных, рейтинг с деньгами, терминалы управляющего, выданные до отзыва, — в
// 05-db-networks.test.mjs на своём Postgres (server/networks/test/db, server/orders/test/db/network-guards.test.mjs).

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { api, auditOf, courtRule, dayPlus, invite, login, makeClub, rule, saveState, short, staffPhone, TZ } from './lib.mjs';

const S = {};
const HIDE = ['method', 'methods', 'payment_method', 'by_method', 'cash_sales_kopecks', 'cash_refunds_kopecks', 'received_kopecks', 'change_kopecks'];

/** Все значения полей из HIDE на любой глубине: [{path, value}]. */
function methodFields(json, path = '$') {
  const out = [];
  if (Array.isArray(json)) json.forEach((v, i) => out.push(...methodFields(v, `${path}[${i}]`)));
  else if (json && typeof json === 'object') {
    for (const [k, v] of Object.entries(json)) {
      if (HIDE.includes(k)) out.push({ path: `${path}.${k}`, value: v });
      else out.push(...methodFields(v, `${path}.${k}`));
    }
  }
  return out;
}

const today = () => new Date().toISOString().slice(0, 10);
const get = (club, p, token) => api('GET', p, { token, club });

before(async () => {
  S.a = await login(staffPhone());
  S.b = await login(staffPhone());
  const rules = [rule('06:00', '06:00', 600), courtRule('06:00', '06:00', 90, 2400)];
  S.c1 = await makeClub(S.a, { name: 'E2E M5.8 Упр-Екб', kinds: ['pyramid', 'pool', 'pool', 'pyramid'], courts: 2, rules });
  S.c2 = await makeClub(S.a, { name: 'E2E M5.8 Упр-Кгд', city: 'Калининград', tz: TZ.kgd, kinds: ['pyramid', 'pool'], rules });
  S.cb = await makeClub(S.b, { name: 'E2E M5.8 Чужая-сеть', kinds: ['pyramid'], rules: [rule('06:00', '06:00', 500)] });
  S.rec = await invite(S.c1.club, S.a.token, 'reception');
  S.man = await invite(S.c1.club, S.a.token, 'manager'); // управляющий клуба (не сети) — для сравнения прав
  saveState({ t42: { owner: S.a.phone, c1: S.c1.club, c2: S.c2.club } });
});

describe('T42. управляющий сети', () => {
  it('сеть из двух клубов; план «Сеть» применяется только при 2+ клубах, цена 1 190 ₽ за стол — 119000 коп.', async (t) => {
    const n = await api('POST', '/api/networks', { token: S.a.token, body: { name: 'E2E M5.8 Сеть T42' } });
    assert.equal(n.status, 201, short(n));
    S.net = n.json.id;
    assert.equal((await api('POST', `/api/networks/${S.net}/clubs`, { token: S.a.token, body: { club_id: S.c1.club } })).status, 201);
    let g = (await api('GET', `/api/networks/${S.net}`, { token: S.a.token })).json;
    assert.equal(g.plan.applies, false, 'один клуб — план «Сеть» не применяется');
    assert.equal(g.plan.price_per_table_kopecks, 119_000);
    assert.equal(g.plan.code, 'network');
    assert.equal(g.plan.title, 'Сеть');
    assert.equal((await api('POST', `/api/networks/${S.net}/clubs`, { token: S.a.token, body: { club_id: S.c2.club } })).status, 201);
    g = (await api('GET', `/api/networks/${S.net}`, { token: S.a.token })).json;
    assert.equal(g.plan.applies, true, 'два клуба — применяется');
    assert.ok(Number.isInteger(g.plan.price_per_table_kopecks), 'цена — целые копейки');
    assert.equal(g.plan.price_per_table_kopecks, 119_000);
    assert.equal(g.clubs.length, 2);
    // Выход клуба — снова «Клуб»; возвращаем.
    assert.equal((await api('DELETE', `/api/networks/${S.net}/clubs/${S.c2.club}`, { token: S.a.token })).status, 200);
    assert.equal((await api('GET', `/api/networks/${S.net}`, { token: S.a.token })).json.plan.applies, false, 'после выхода второго клуба');
    assert.equal((await api('POST', `/api/networks/${S.net}/clubs`, { token: S.a.token, body: { club_id: S.c2.club } })).status, 201);
    assert.equal((await api('GET', `/api/networks/${S.net}`, { token: S.a.token })).json.plan.applies, true);
    // Цену плана менять через API владельца нельзя (только Андрей, platform).
    const price = await api('PUT', '/api/platform/plans/bf000000-0000-4000-8000-000000000002', { token: S.a.token, body: { price_per_table_kopecks: 1 } });
    assert.ok([403, 404].includes(price.status), `цену плана владелец не меняет: ${short(price)}`);
    assert.equal((await api('GET', `/api/networks/${S.net}`, { token: S.a.token })).json.plan.price_per_table_kopecks, 119_000);
    t.diagnostic(`план: ${JSON.stringify(g.plan)}`);
  });

  it('приглашение управляющего сети: 201, текст без телефона; владелец не приглашает себя; принятие при входе', async (t) => {
    S.nmPhone = staffPhone();
    const inv = await api('POST', `/api/networks/${S.net}/managers`, { token: S.a.token, body: { phone: S.nmPhone } });
    assert.equal(inv.status, 201, short(inv));
    assert.equal(inv.json.status, 'invited');
    assert.ok(inv.json.invite_url?.startsWith('https://'), `invite_url ${inv.json.invite_url}`);
    const digits = S.nmPhone.replace(/\D/g, '');
    assert.ok(!String(inv.json.invite_text).includes(digits.slice(1)), 'в тексте приглашения нет телефона');
    assert.ok(!String(inv.json.invite_text).includes(S.nmPhone));
    assert.match(inv.json.phone_masked, /\*/);
    S.invite = inv.json.id;
    const again = await api('POST', `/api/networks/${S.net}/managers`, { token: S.a.token, body: { phone: S.nmPhone } });
    assert.ok(again.status === 201 || again.status === 200, `повтор продлевает: ${short(again)}`);
    const self = await api('POST', `/api/networks/${S.net}/managers`, { token: S.a.token, body: { phone: S.a.phone } });
    assert.equal(self.status, 409, short(self));
    assert.equal((await api('POST', `/api/networks/${S.net}/managers`, { token: S.a.token, body: { phone: '12345' } })).status, 400);
    let list = (await api('GET', `/api/networks/${S.net}/managers`, { token: S.a.token })).json.items;
    assert.equal(list.length, 1, 'повтор не плодит приглашений');
    assert.equal(list[0].status, 'invited');
    assert.ok(!JSON.stringify(list).includes(digits.slice(1)), 'список без полного номера');
    // Вход с этим номером принимает приглашение.
    S.nm = await login(S.nmPhone);
    list = (await api('GET', `/api/networks/${S.net}/managers`, { token: S.a.token })).json.items;
    assert.equal(list[0].status, 'active');
    assert.equal(list[0].user_id, S.nm.user.id);
    const me = (await api('GET', '/api/me', { token: S.nm.token })).json;
    assert.deepEqual(me.clubs.map((c) => c.club_id).sort(), [S.c1.club, S.c2.club].sort(), 'видит оба клуба сети');
    assert.ok(me.clubs.every((c) => c.role === 'manager' && c.network_id === S.net), JSON.stringify(me.clubs));
    assert.deepEqual(me.networks.map((x) => [x.network_id, x.role]), [[S.net, 'manager']]);
    t.diagnostic(`/api/me управляющего: ${me.clubs.length} клуба роль ${me.clubs[0].role} network_id=${me.clubs[0].network_id?.slice(0, 8)}`);
  });

  it('права сети: управляющий сети читает, но не меняет сеть, состав, шаблоны и управляющих', async () => {
    const t = S.nm.token;
    assert.equal((await api('GET', `/api/networks/${S.net}`, { token: t })).json.role, 'manager');
    assert.equal((await api('GET', `/api/networks/${S.net}/tariffs`, { token: t })).status, 200);
    assert.equal((await api('GET', `/api/networks/${S.net}/menu`, { token: t })).status, 200);
    for (const [m, p, body] of [
      ['PATCH', `/api/networks/${S.net}`, { name: 'Взлом' }],
      ['DELETE', `/api/networks/${S.net}`, undefined],
      ['POST', `/api/networks/${S.net}/clubs`, { club_id: S.c1.club }],
      ['DELETE', `/api/networks/${S.net}/clubs/${S.c2.club}`, undefined],
      ['POST', `/api/networks/${S.net}/managers`, { phone: staffPhone() }],
      ['DELETE', `/api/networks/${S.net}/managers/${S.invite}`, undefined],
      ['PUT', `/api/networks/${S.net}/tariffs`, { rules: [rule('06:00', '06:00', 1)] }],
      ['DELETE', `/api/networks/${S.net}/tariffs`, undefined],
      ['PUT', `/api/networks/${S.net}/menu`, { products: [] }],
    ]) {
      const r = await api(m, p, { token: t, body });
      assert.equal(r.status, 403, `${m} ${p}: ${short(r)}`);
    }
    assert.equal((await api('GET', `/api/networks/${S.net}`, { token: S.a.token })).json.name, 'E2E M5.8 Сеть T42', 'имя не изменено');
    // Управляющий клуба (прямое членство) тоже не владелец сети.
    assert.ok([403, 404].includes((await api('PATCH', `/api/networks/${S.net}`, { token: S.man.token, body: { name: 'x' } })).status));
    // Клуб, к которому членство выдала сеть, не меняет и не отзывает управляющего сети.
    const staff = await api('GET', `/api/clubs/${S.c1.club}/staff`, { token: S.a.token, club: S.c1.club });
    assert.equal(staff.status, 200, short(staff));
    const nmRow = (staff.json.items ?? staff.json.staff ?? staff.json).find?.((x) => x.user_id === S.nm.user.id);
    assert.ok(nmRow, 'управляющий сети в списке персонала');
    assert.equal(nmRow.network_id, S.net);
    const patch = await api('PATCH', `/api/clubs/${S.c1.club}/staff/${S.nm.user.id}`, { token: S.a.token, club: S.c1.club, body: { role: 'reception' } });
    assert.equal(patch.status, 409, short(patch));
    assert.equal(patch.json.error, 'network_locked');
    assert.equal((await api('DELETE', `/api/clubs/${S.c1.club}/staff/${S.nm.user.id}`, { token: S.a.token, club: S.c1.club })).status, 409);
  });

  it('как управляющий: зал, тарифы, смены, кассу, журнал и «Кто играл» читает; терминал ресепшена не заводит (403)', async (t) => {
    for (const club of [S.c1.club, S.c2.club]) {
      for (const p of ['resources', 'tariffs', 'catalog', 'shifts', 'alarms?state=open', 'audit', 'now', 'dashboard?tab=hall', 'dashboard?tab=summary', 'dashboard?tab=guests', 'dashboard?tab=control', 'dashboard/now', 'cashbook']) {
        const r = await get(club, `/api/clubs/${club}/${p}`, S.nm.token);
        assert.equal(r.status, 200, `${club.slice(0, 8)} ${p}: ${short(r)}`);
      }
    }
    // Терминал: управляющий клуба заводит, управляющий сети — нет.
    const term = await api('POST', '/api/staff/terminal', { token: S.nm.token, body: { club_id: S.c1.club, name: 'Терминал управляющего сети' } });
    assert.equal(term.status, 403, short(term));
    const ok = await api('POST', '/api/staff/terminal', { token: S.man.token, body: { club_id: S.c1.club, name: 'Терминал управляющего клуба e2e' } });
    assert.equal(ok.status, 200, short(ok));
    t.diagnostic('терминал: управляющий сети 403, управляющий клуба 200');
    // Управляющий сети правит тарифы клуба как управляющий (мягкий шаблон отсутствует — можно).
    const put = await api('PUT', `/api/clubs/${S.c2.club}/tariffs`, { token: S.nm.token, club: S.c2.club, body: { rules: [rule('06:00', '06:00', 650), courtRule('06:00', '06:00', 90, 2400)] } });
    assert.equal(put.status, 200, short(put));
  });

  it('деньги: tab=money и экспорты — 403 у управляющего сети, у управляющего клуба — можно (экспорты) / владельцу — деньги', async (t) => {
    const club = S.c1.club;
    const d = today();
    const money = await get(club, `/api/clubs/${club}/dashboard?tab=money&from=${d}&to=${d}`, S.nm.token);
    assert.equal(money.status, 403, short(money));
    assert.equal((await get(club, `/api/clubs/${club}/dashboard?tab=money&from=${d}&to=${d}`, S.a.token)).status, 200, 'владелец видит «Деньги»');
    const exports = [
      `/api/clubs/${club}/dashboard/export.csv?from=${d}&to=${d}&tab=hall`,
      `/api/clubs/${club}/history/orders/export.csv`,
      `/api/clubs/${club}/shifts/export.csv`,
      `/api/clubs/${club}/cashbook/export.csv`,
    ];
    const res = [];
    for (const p of exports) {
      const nm = await get(club, p, S.nm.token);
      assert.equal(nm.status, 403, `управляющий сети ${p}: ${short(nm)}`);
      const man = await get(club, p, S.man.token);
      res.push(`${p.split('?')[0].replace(`/api/clubs/${club}/`, '')}: сеть ${nm.status}, управляющий клуба ${man.status}`);
      if (!p.includes('/dashboard/')) assert.equal(man.status, 200, `управляющий клуба ${p}: ${short(man)}`);
    }
    t.diagnostic(res.join('; '));
    // «Все мои клубы»: деньги и экспорт управляющему сети тоже закрыты.
    const all = await api('GET', `/api/clubs/all/dashboard?tab=money&from=${d}&to=${d}`, { token: S.nm.token });
    assert.ok(all.status === 403 || all.status === 404 || all.json?.clubs?.length === 0 || all.json?.tables == null, `все мои клубы · деньги: ${short(all)}`);
    assert.notEqual((await api('GET', `/api/clubs/all/dashboard/export.csv?from=${d}&to=${d}`, { token: S.nm.token })).status, 200);
  });

  it('способы оплаты null во всех GET: смена, продажи, журнал, «Сейчас», отчёт смены; у владельца те же поля заполнены', async (t) => {
    const club = S.c1.club;
    // Ресепшн: смена и продажа бара наличными (3 000 ₽ размен, 2 × 100 ₽ + сдача).
    const sh = await api('POST', `/api/clubs/${club}/shifts`, { token: S.rec.token, club, body: { float_kopecks: 300_000 } });
    assert.equal(sh.status, 201, short(sh));
    S.shift = sh.json.id;
    const prod = await api('POST', `/api/clubs/${club}/catalog/products`, { token: S.a.token, club, body: { name: 'Чай T42', price_kopecks: 10_000, category: 'Бар' } });
    assert.equal(prod.status, 201, short(prod));
    const sale = await api('POST', '/api/pos/sales', { token: S.rec.token, club, idem: true, body: { items: [{ product_id: prod.json.id, qty: 2 }], method: 'cash', received_kopecks: 30_000 } });
    assert.equal(sale.status, 201, short(sale));
    S.sale = sale.json.sale_id;
    const sale2 = await api('POST', '/api/pos/sales', { token: S.rec.token, club, idem: true, body: { items: [{ product_id: prod.json.id, qty: 1 }], method: 'card_terminal' } });
    assert.equal(sale2.status, 201, short(sale2));
    const d = today();
    const paths = [
      `/api/clubs/${club}/now`,
      `/api/clubs/${club}/dashboard/now`,
      `/api/clubs/${club}/shifts/current`,
      `/api/clubs/${club}/shifts`,
      `/api/shifts/${S.shift}`,
      `/api/shifts/${S.shift}/report?online=0`,
      `/api/clubs/${club}/pos/sales`,
      `/api/pos/sales/${S.sale}`,
      `/api/clubs/${club}/audit?limit=100`,
      `/api/clubs/${club}/history/orders`,
      `/api/clubs/${club}/dashboard?tab=summary&from=${d}&to=${d}`,
      `/api/clubs/${club}/dashboard?tab=control&from=${d}&to=${d}`,
      `/api/clubs/${club}/cashbook`,
      `/api/clubs/${club}/resources`,
    ];
    let hiddenTotal = 0;
    let ownerNonNull = 0;
    const lines = [];
    for (const p of paths) {
      const nm = await get(club, p, S.nm.token);
      assert.equal(nm.status, 200, `${p}: ${short(nm)}`);
      const fields = methodFields(nm.json);
      const bad = fields.filter((f) => f.value !== null && f.value !== undefined);
      assert.deepEqual(bad, [], `управляющий сети видит способ оплаты в ${p}: ${JSON.stringify(bad.slice(0, 4))}`);
      hiddenTotal += fields.length;
      const ow = await get(club, p, S.a.token);
      assert.equal(ow.status, 200, `владелец ${p}`);
      const nn = methodFields(ow.json).filter((f) => f.value !== null && f.value !== undefined);
      ownerNonNull += nn.length;
      lines.push(`${p.replace(club, 'C1').replace(S.shift, 'SHIFT').replace(S.sale, 'SALE').split('?')[0]}: null-полей ${fields.length}, у владельца со значением ${nn.length}`);
    }
    for (const l of lines) t.diagnostic(l);
    assert.ok(ownerNonNull > 0, 'у владельца способы оплаты есть (проверка не пустая)');
    // «Сейчас»: итог есть, способов нет.
    const nowNm = (await get(club, `/api/clubs/${club}/now`, S.nm.token)).json;
    assert.equal(nowNm.revenue_today_kopecks, null);
    assert.equal(typeof nowNm.revenue_today_total_kopecks, 'number');
    const nowOwner = (await get(club, `/api/clubs/${club}/now`, S.a.token)).json;
    assert.equal(typeof nowOwner.revenue_today_kopecks, 'object');
    // Отчёт смены: methods_hidden, итоги остаются; управляющему клуба — целиком.
    const rep = (await get(club, `/api/shifts/${S.shift}/report?online=0`, S.nm.token)).json;
    assert.equal(rep.methods_hidden, true);
    assert.equal(rep.revenue.by_method, null);
    assert.equal(typeof rep.revenue.total_kopecks, 'number');
    assert.equal(rep.cash.float_kopecks, 300_000, 'размен остаётся');
    const repMan = (await get(club, `/api/shifts/${S.shift}/report?online=0`, S.man.token)).json;
    assert.equal(repMan.methods_hidden, undefined);
    assert.equal(typeof repMan.revenue.by_method, 'object');
    assert.ok(repMan.revenue.by_method, 'у управляющего клуба разбивка есть');
    // Продажа: сумма остаётся, способ скрыт.
    const s = (await get(club, `/api/pos/sales/${S.sale}`, S.nm.token)).json;
    assert.equal(s.method, null);
    assert.equal(s.received_kopecks ?? null, null);
    assert.equal(s.change_kopecks ?? null, null);
    assert.equal(s.bar_kopecks, 20_000);
    const so = (await get(club, `/api/pos/sales/${S.sale}`, S.a.token)).json;
    assert.equal(so.method, 'cash');
    assert.equal(so.received_kopecks, 30_000);
    // Журнал: pos.sale без способа.
    const aud = (await get(club, `/api/clubs/${club}/audit?action=pos.*&limit=50`, S.nm.token)).json.items;
    assert.ok(aud.some((x) => x.action === 'pos.sale'), 'pos.sale в журнале');
    assert.ok(aud.filter((x) => x.action === 'pos.sale').every((x) => x.data?.method == null), 'способ в pos.sale скрыт');
    const audOwner = (await get(club, `/api/clubs/${club}/audit?action=pos.*&limit=50`, S.a.token)).json.items;
    assert.ok(audOwner.filter((x) => x.action === 'pos.sale').some((x) => x.data?.method), 'у владельца способ в pos.sale есть');
    t.diagnostic(`скрытых полей у управляющего сети: ${hiddenTotal}; со значением у владельца: ${ownerNonNull}`);
  });

  it('сравнение клубов: вкладка «Сеть» = дашборд клуба; корты отдельно; тестовые клубы вне рейтинга; период', async (t) => {
    const d = today();
    for (const who of ['a', 'nm']) {
      const token = S[who].token;
      const r = await api('GET', `/api/networks/${S.net}/dashboard?from=${d}&to=${d}&compare=0`, { token });
      assert.equal(r.status, 200, short(r));
      assert.equal(r.json.role, who === 'a' ? 'owner' : 'manager');
      assert.equal(r.json.clubs.length, 2);
      assert.ok(!JSON.stringify(r.json).match(/by_method|"methods"/), 'в сравнении нет денег по способам');
      for (const c of r.json.clubs) {
        assert.equal(c.mode, 'test');
        assert.equal(c.ranked, false, 'тестовый клуб вне рейтинга');
        assert.equal(c.place_utilization, null);
        assert.equal(c.place_revenue_per_table_day, null);
        // Плитки сети = плитки дашборда клуба с kind=table (число столов) / без фильтра (общие).
        const dash = (await get(c.club_id, `/api/clubs/${c.club_id}/dashboard?from=${d}&to=${d}`, token)).json;
        const dashT = (await get(c.club_id, `/api/clubs/${c.club_id}/dashboard?from=${d}&to=${d}&kind=table`, token)).json;
        const tv = (j, id) => j.tiles.find((x) => x.id === id)?.value;
        const nv = (id) => c.tiles.find((x) => x.id === id)?.value;
        for (const id of ['revenue', 'games', 'play_hours', 'guests', 'no_staff_share', 'avg_check_bar']) assert.equal(nv(id), tv(dash, id), `${c.name}: ${id}`);
        for (const id of ['utilization', 'avg_check_game', 'revenue_per_table_day', 'avg_hour_price']) assert.equal(nv(id), tv(dashT, id), `${c.name}: ${id} (столы)`);
      }
      assert.deepEqual(r.json.ranking.utilization, []);
      assert.deepEqual(r.json.ranking.revenue_per_table_day, []);
      const t1 = r.json.clubs.find((c) => c.club_id === S.c1.club);
      // Корты: блок courts отдельно либо null, «столов» 4 (корты не входят в tables_avg).
      t.diagnostic(`${who}: tables_avg C1=${t1.tables_avg}, courts=${JSON.stringify(t1.courts)}; totals.courts=${JSON.stringify(r.json.totals.courts)}`);
      assert.ok(t1.tables_avg <= 4, `корты не входят в столы: ${t1.tables_avg}`);
    }
    // Период: до 366 суток; больше — 400; сегодня-будущее допустимо.
    assert.equal((await api('GET', `/api/networks/${S.net}/dashboard?from=2025-01-01&to=${d}`, { token: S.a.token })).status, 400);
    assert.equal((await api('GET', `/api/networks/${S.net}/dashboard?from=${dayPlus(-3)}&to=${d}&compare=1`, { token: S.nm.token })).status, 200);
    assert.equal((await api('GET', `/api/networks/${S.net}/dashboard?from=bad&to=${d}`, { token: S.a.token })).status, 400);
  });

  it('чужая сеть и чужой клуб: 404 на сеть, 403 на клуб — ни данных, ни управления', async () => {
    const nb = await api('POST', '/api/networks', { token: S.b.token, body: { name: 'E2E M5.8 Чужая сеть' } });
    assert.equal(nb.status, 201);
    assert.equal((await api('POST', `/api/networks/${nb.json.id}/clubs`, { token: S.b.token, body: { club_id: S.cb.club } })).status, 201);
    for (const [m, p] of [['GET', `/api/networks/${nb.json.id}`], ['GET', `/api/networks/${nb.json.id}/tariffs`], ['GET', `/api/networks/${nb.json.id}/menu`], ['GET', `/api/networks/${nb.json.id}/managers`], ['GET', `/api/networks/${nb.json.id}/dashboard`]]) {
      for (const who of ['nm', 'a']) assert.equal((await api(m, p, { token: S[who].token })).status, 404, `${who} ${m} ${p}`);
    }
    for (const [m, p, body] of [['PATCH', `/api/networks/${nb.json.id}`, { name: 'x' }], ['POST', `/api/networks/${nb.json.id}/managers`, { phone: staffPhone() }], ['POST', `/api/networks/${nb.json.id}/clubs`, { club_id: S.c1.club }], ['PUT', `/api/networks/${nb.json.id}/tariffs`, { rules: [rule('06:00', '06:00', 100)] }], ['DELETE', `/api/networks/${nb.json.id}`]]) {
      assert.equal((await api(m, p, { token: S.nm.token, body })).status, 404, `${m} ${p}`);
    }
    // Клуб чужой сети: управляющий сети A данных не видит.
    for (const p of ['resources', 'tariffs', 'audit', 'now', 'shifts', 'dashboard?tab=hall']) {
      const r = await api('GET', `/api/clubs/${S.cb.club}/${p}`, { token: S.nm.token, club: S.cb.club });
      assert.ok([403, 404].includes(r.status), `${p}: ${short(r)}`);
    }
    assert.equal((await api('POST', '/api/staff/terminal', { token: S.nm.token, body: { club_id: S.cb.club, name: 'x' } })).status, 403);
    // Чужая сеть не видит нашу.
    assert.equal((await api('GET', `/api/networks/${S.net}`, { token: S.b.token })).status, 404);
    const mine = (await api('GET', '/api/networks', { token: S.nm.token })).json.items;
    assert.deepEqual(mine.map((x) => [x.network_id, x.role]), [[S.net, 'manager']]);
    assert.equal(S.b.token === S.a.token, false);
  });

  it('вывод клуба из сети снимает доступ сразу; отзыв управляющего — сразу, токен тот же', async (t) => {
    const club2 = S.c2.club;
    assert.equal((await get(club2, `/api/clubs/${club2}/resources`, S.nm.token)).status, 200, 'до вывода доступ есть');
    const rm = await api('DELETE', `/api/networks/${S.net}/clubs/${club2}`, { token: S.a.token });
    assert.equal(rm.status, 200, short(rm));
    const after = await get(club2, `/api/clubs/${club2}/resources`, S.nm.token);
    assert.ok([403, 404].includes(after.status), `после вывода клуба: ${short(after)}`);
    assert.equal((await get(S.c1.club, `/api/clubs/${S.c1.club}/resources`, S.nm.token)).status, 200, 'другой клуб сети — доступ остался');
    const me = (await api('GET', '/api/me', { token: S.nm.token })).json;
    assert.deepEqual(me.clubs.map((c) => c.club_id), [S.c1.club]);
    const list = (await api('GET', `/api/networks/${S.net}/managers`, { token: S.a.token })).json.items;
    const row = list.find((x) => x.user_id === S.nm.user.id);
    assert.ok(row);
    const rev = await api('DELETE', `/api/networks/${S.net}/managers/${row.id}`, { token: S.a.token });
    assert.equal(rev.status, 200, short(rev));
    for (const p of ['resources', 'shifts', 'now', `dashboard?tab=hall`]) {
      const r = await get(S.c1.club, `/api/clubs/${S.c1.club}/${p}`, S.nm.token);
      assert.ok([403, 404].includes(r.status), `после отзыва ${p}: ${short(r)}`);
    }
    assert.equal((await api('GET', `/api/networks/${S.net}`, { token: S.nm.token })).status, 404);
    assert.deepEqual((await api('GET', '/api/me', { token: S.nm.token })).json.clubs, []);
    t.diagnostic('после вывода клуба и отзыва — 403/404 на тот же токен без повторного входа');
    // Приглашение по повторному номеру снова выдаёт доступ, чужим он не нужен: возвращаем клуб для браузерных проверок.
    assert.equal((await api('POST', `/api/networks/${S.net}/clubs`, { token: S.a.token, body: { club_id: club2 } })).status, 201);
    const inv = await api('POST', `/api/networks/${S.net}/managers`, { token: S.a.token, body: { phone: S.nmPhone } });
    assert.equal(inv.status, 201, short(inv));
    S.nm = await login(S.nmPhone);
    assert.equal((await get(club2, `/api/clubs/${club2}/resources`, S.nm.token)).status, 200, 'повторное приглашение — доступ вернулся');
    saveState({ t42net: S.net, t42nm: S.nmPhone, t42rec: S.rec.phone });
  });

  it('журнал: network.* — вывод, приглашение, принятие, отзыв — в цепочке каждого клуба; цепочка цела', async (t) => {
    for (const club of [S.c1.club, S.c2.club]) {
      const items = await auditOf(club, S.a.token, 'network.*');
      const have = new Set(items.map((x) => x.action));
      // Отзыв управляющего пишется в клубы, которые входили в сеть на этот момент: C1; C2 к тому времени уже вышел.
      const need = ['network.club_added', 'network.manager_invited', 'network.manager_added', ...(club === S.c1.club ? ['network.manager_revoked'] : ['network.club_removed'])];
      for (const a of need) assert.ok(have.has(a), `${club.slice(0, 8)}: нет ${a}; есть ${[...have]}`);
      const inv = items.find((x) => x.action === 'network.manager_invited');
      assert.ok(!JSON.stringify(inv.data).includes(S.nmPhone.slice(2)), 'в журнале приглашения телефон только маской');
      const v = await api('GET', `/api/clubs/${club}/audit/verify`, { token: S.a.token, club });
      assert.equal(v.json.ok, true, short(v));
      t.diagnostic(`${club.slice(0, 8)}: ${[...have].join(', ')}; цепочка ok`);
    }
    const out = await auditOf(S.c2.club, S.a.token, 'network.club_removed');
    assert.equal(out.length, 2, 'вывод клуба C2 записан дважды (шаг подписки и шаг доступа)');
  });
});
