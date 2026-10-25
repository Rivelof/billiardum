// Каталог сайта с падел-кортами (M5.8 №205, T48): фильтр «падел» (клубы с кортами), столы и корты
// отдельно в карточке, «свободно сейчас» — по столам и по кортам, цены корта — за слот, план зала со
// словом вида ресурса. Без ПДн. Корты сида включаются здесь (harness выводит их из работы для M4).

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CARD_A, CARD_DEMO, CLUB_A, MIN, setup, T0 } from './harness.mjs';

const skip = !process.env.DATABASE_ADMIN_URL;
const COURT_1 = 'e1000000-0000-4000-8000-000000000101';

describe('каталог: падел', { skip }, () => {
  let h;
  let guest;

  before(async () => {
    h = await setup();
    await h.admin.query("update bl.resources set active = true where club_id = $1 and type = 'padel_court'", [CLUB_A]);
    guest = await h.login('+79990007001');
  });
  after(async () => {
    await h?.close();
  });

  it('фильтр disciplines=padel — только клубы с кортами; карточка: столы и корты отдельно, цена корта за слот', async () => {
    h.clock.set(T0);
    await h.session({ resourceId: COURT_1, payer: guest.id, paidUntilMs: T0 + 90 * MIN });
    const all = await h.request('GET', '/api/public/cities/ekaterinburg');
    assert.equal(all.status, 200, all.text);
    const a = all.json.items.find((x) => x.id === CARD_A);
    assert.deepEqual(a.disciplines.sort(), ['padel', 'pool', 'pyramid']);
    assert.deepEqual([a.tables_count, a.courts_count, a.free_now, a.courts_free_now], [8, 2, 8, 1]);
    assert.equal(a.price_from_kopecks, 50_000, '«от» — за час стола');
    assert.deepEqual([a.court_price_from_kopecks, a.slot_minutes], [240_000, 90]);
    const padel = await h.request('GET', '/api/public/cities/ekaterinburg?disciplines=padel');
    assert.equal(padel.status, 200, padel.text);
    assert.deepEqual(padel.json.items.map((x) => x.id), [CARD_A]);
    assert.deepEqual(padel.json.filters.disciplines, ['padel']);
    assert.equal((await h.request('GET', '/api/public/cities/ekaterinburg?disciplines=padel,pool')).json.items.length, 1);
    // «Свободно сейчас» с фильтром «падел» — по кортам (один занят, второй свободен).
    assert.equal((await h.request('GET', '/api/public/cities/ekaterinburg?disciplines=padel&free_now=1')).json.items.length, 1);
    // В городе «свободно сейчас» — столы, как раньше.
    const city = (await h.request('GET', '/api/public/cities')).json.items.find((x) => x.slug === 'ekaterinburg');
    assert.equal(city.free_now, 8);
  });

  it('Н-4 pentester M5.8: с фильтром «падел» price_max сравнивается с ценой корта (слот), без него — с ценой часа стола', async () => {
    const ids = async (query) => (await h.request('GET', `/api/public/cities/ekaterinburg?${query}`)).json.items.map((x) => x.id);
    // Стол 500 ₽/ч, слот корта 2 400 ₽: «до 1 000 ₽» — стол подходит, корт нет.
    assert.deepEqual(await ids('price_max=100000'), [CARD_A]);
    assert.deepEqual(await ids('disciplines=padel&price_max=100000'), [], 'корт дороже 1 000 ₽ — раньше клуб проходил по цене стола');
    assert.deepEqual(await ids('disciplines=padel&price_max=240000'), [CARD_A]);
    assert.deepEqual(await ids('disciplines=padel&price_max=239999'), []);
    // Сортировка по цене при «падел» — по цене корта: карточка без цены корта (без программы) — в конце.
    await h.admin.query("update bl.club_public set disciplines = '{padel}' where id = $1", [CARD_DEMO]);
    assert.deepEqual(await ids('disciplines=padel&sort=price'), [CARD_A, CARD_DEMO]);
  });

  it('карточка без программы с дисциплиной padel — тоже в фильтре; неверная дисциплина — 400', async () => {
    await h.admin.query("update bl.club_public set disciplines = '{padel}' where id = $1", [CARD_DEMO]);
    const r = await h.request('GET', '/api/public/cities/ekaterinburg?disciplines=padel&sort=name');
    assert.deepEqual(r.json.items.map((x) => x.id).sort(), [CARD_A, CARD_DEMO].sort());
    assert.equal((await h.request('GET', '/api/public/cities/ekaterinburg?disciplines=tennis')).status, 400);
  });

  it('страница клуба: на плане корт — kind padel_court, семья court, дисциплина padel; цены корта — за слот; без ПДн', async () => {
    const r = await h.request('GET', '/api/public/clubs/ekaterinburg/testovyy-klub');
    assert.equal(r.status, 200, r.text);
    const { live, prices } = r.json;
    assert.deepEqual([live.total, live.courts_total, live.courts_free_now], [8, 2, 1]);
    const c1 = live.tables.find((x) => x.id === COURT_1);
    assert.deepEqual([c1.kind, c1.family, c1.discipline, c1.number, c1.status], ['padel_court', 'court', 'padel', 1, 'busy']);
    const t1 = live.tables.find((x) => x.number === 1 && x.family === 'table');
    assert.deepEqual([t1.kind, t1.discipline], ['pyramid', 'pyramid']);
    const p = prices.filter((x) => x.discipline === 'padel');
    assert.equal(p.length, 3);
    assert.ok(p.every((x) => x.slot_minutes === 90 && x.price_per_slot_kopecks > 0));
    assert.ok(!r.text.includes(guest.id) && !r.text.includes(guest.phone));
  });
});
