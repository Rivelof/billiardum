// T47 (часть 1): тарифы корта по слотам, бронь корта, настройка клуба — на своих клубах test (без контроллера).
// docs/contracts/m5-5-8.md №203–205, decisions №212, №213, №219, №220.
//
//   * слот 60 / 90 / 120 минут (настройка клуба): `PUT …/tariffs` → `GET` отдаёт `slots: {padel_court: N}`, свободные интервалы
//     (`availability`) несут `slot_minutes`, `per_slot_kopecks`; слот 75 минут, два разных слота в клубе, цена слота 0 и 49 коп.
//     (< 1 ₽ после округления), час стола 29,99 ₽ при шаге 1 минута — 400;
//   * граница расписания внутри слота делит слот по минутам: цена брони на 3 слота длины (60/90/120) сверена с ручным расчётом;
//   * пояс клуба: тот же слот в Екатеринбурге и Калининграде считается по местному времени;
//   * бронь корта: 1–2 слота кратно длине слота; не кратно — 400; бронь стола и корта в одном клубе не смешиваются;
//   * клуб с кортами обязан задать правила корта: `tariff_gap {kind: padel_court}`; `kind: null` — только столы;
//   * нумерация своя у семьи: «Стол 1» и «Корт 1» одновременно; стол ↔ корт сменой вида — 400;
//   * в боевой конфигурации котировки (dev-флаг минут выключен — как в проде) корт принимает только 1–4 слота, «Без лимита» и
//     баланс пакетов — 400 (чистая функция `parseQuoteRequest`, без базы). На стенде включён DEV_ALLOW_ANY_MINUTES, поэтому
//     живая котировка там принимает любые минуты — это ожидаемо и в проде выключено.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { parseQuoteRequest } from '../../../server/payments/quotes.mjs';
import { api, apiWait, courtRule, dayPlus, localToUtc, login, makeClub, newGuest, rule, saveState, short, staffPhone, TZ } from './lib.mjs';

const S = {};
const putTariffs = (c, rules) => api('PUT', `/api/clubs/${c.club}/tariffs`, { token: S.owner.token, club: c.club, body: { rules } });
// POST /api/bookings ограничен 30 запросами в минуту на IP: при 429 ждём окно (apiWait).
const book = async (c, resourceId, at, minutes) => {
  const r = await apiWait('POST', '/api/bookings', { token: S.guest.token, body: { resource_id: resourceId, starts_at: at.toISOString(), minutes } });
  if (r.status === 201) await apiWait('POST', `/api/bookings/${r.json.id}/cancel`, { token: S.guest.token, body: {} });
  return r;
};
const court = (c, n = 1) => c.resources.find((r) => r.family === 'court' && r.number === n);
const table = (c, n = 1) => c.resources.find((r) => r.family === 'table' && r.number === n);

before(async () => {
  S.owner = await login(staffPhone());
  S.owner2 = await login(staffPhone());
  S.guest = await newGuest();
  // Три клуба владельца (предел тестовых клубов — 3): слоты 60, 90 и 120.
  S.s60 = await makeClub(S.owner, { name: 'E2E M5.8 Слот 60', kinds: ['pyramid'], courts: 2, rules: [rule('06:00', '06:00', 600), courtRule('06:00', '18:00', 60, 1500), courtRule('18:00', '06:00', 60, 2100)] });
  S.s90 = await makeClub(S.owner, { name: 'E2E M5.8 Слот 90', kinds: ['pyramid', 'pool'], courts: 1, rules: [rule('06:00', '06:00', 600), courtRule('06:00', '18:00', 90, 2400), courtRule('18:00', '06:00', 90, 3600)] });
  S.s120 = await makeClub(S.owner, { name: 'E2E M5.8 Слот 120', kinds: ['pyramid'], courts: 1, rules: [rule('06:00', '06:00', 600), courtRule('06:00', '18:00', 120, 2400), courtRule('18:00', '06:00', 120, 3600)] });
  S.kgd = await makeClub(S.owner2, { name: 'E2E M5.8 Корт Кгд', city: 'Калининград', tz: TZ.kgd, kinds: ['pyramid'], courts: 1, rules: [rule('06:00', '06:00', 600), courtRule('06:00', '18:00', 90, 2400), courtRule('18:00', '06:00', 90, 3600)] });
  saveState({ t47: { owner: S.owner.phone, s60: S.s60.club, s90: S.s90.club, s120: S.s120.club, owner2: S.owner2.phone, kgd: S.kgd.club } });
});

describe('T47. тарифы корта по слотам (свои клубы)', () => {
  it('справочник видов: падел-корт — слотами, до 4 игроков, слова «корт» по падежам; слоты 60/90/120', async () => {
    const r = await api('GET', '/api/resource-kinds');
    assert.equal(r.status, 200);
    const k = r.json.kinds.find((x) => x.kind === 'padel_court');
    assert.deepEqual([k.family, k.billing, k.max_players, k.noun.one, k.noun.few, k.noun.many], ['court', 'slot', 4, 'корт', 'корта', 'кортов']);
    assert.deepEqual(r.json.slot_minutes, [60, 90, 120]);
    assert.equal(r.json.default_slot_minutes, 90);
    const table = r.json.kinds.find((x) => x.kind === 'pyramid');
    assert.deepEqual([table.family, table.billing, table.noun.one], ['table', 'hourly', 'стол']);
  });

  it('настройка слота клуба: GET …/tariffs отдаёт slots; правила корта с slot_minutes и ценой слота в копейках', async () => {
    for (const [c, slot] of [[S.s60, 60], [S.s90, 90], [S.s120, 120]]) {
      const t = (await api('GET', `/api/clubs/${c.club}/tariffs`, { token: S.owner.token, club: c.club })).json;
      assert.deepEqual(t.slots, { padel_court: slot });
      const cr = t.rules.filter((x) => x.kind === 'padel_court');
      assert.equal(cr.length, 2);
      for (const x of cr) {
        assert.equal(x.slot_minutes, slot);
        assert.equal(x.min_minutes, slot, 'минимум = слот');
        assert.equal(x.step_minutes, slot, 'шаг = слот');
        assert.ok(Number.isInteger(x.price_per_slot_kopecks));
      }
      assert.equal(t.coverage.ok, true);
      const day = dayPlus(3);
      const av = (await api('GET', `/api/clubs/${c.club}/availability?date=${day}`)).json;
      const ct = av.resources.find((r) => r.kind === 'padel_court');
      assert.equal(ct.slot_minutes, slot);
      assert.deepEqual(ct.rates.map((x) => x.slot_minutes), [slot, slot]);
      assert.deepEqual(ct.rates.map((x) => x.per_slot_kopecks), [slot === 60 ? 150_000 : 240_000, slot === 60 ? 210_000 : 360_000]);
    }
  });

  it('недопустимые настройки: слот 75, два разных слота, цена 0, 49 коп. за слот, час стола 29,99 ₽ при шаге 1 мин — 400, тарифы целы', async (t) => {
    const before = JSON.stringify((await api('GET', `/api/clubs/${S.s90.club}/tariffs`, { token: S.owner.token, club: S.s90.club })).json.rules);
    const base = [rule('06:00', '06:00', 600)];
    const bad = {
      'слот 75': [...base, courtRule('06:00', '06:00', 75, 2400)],
      'слоты 60 и 90 в одном клубе': [...base, courtRule('06:00', '18:00', 60, 1500), courtRule('18:00', '06:00', 90, 3600)],
      'цена слота 0': [...base, courtRule('06:00', '06:00', 90, 0)],
      'цена слота 49 коп. (< 1 ₽ после округления)': [...base, { ...courtRule('06:00', '06:00', 90, 0), price_per_slot_kopecks: 49 }],
      'час стола 2999 коп. при шаге 1 минута': [rule('06:00', '06:00', 0, { price_per_hour_kopecks: 2999 }), courtRule('06:00', '06:00', 90, 2400)],
      'корт без слота': [...base, { kind: 'padel_court', days: [1, 2, 3, 4, 5, 6, 7], from: '06:00', to: '06:00', price_per_hour_kopecks: 160_000, min_minutes: 90, step_minutes: 90 }],
      'слот у стола': [{ ...rule('06:00', '06:00', 600), slot_minutes: 90, price_per_slot_kopecks: 90_000 }, courtRule('06:00', '06:00', 90, 2400)],
      'дыра у корта (до 18:00)': [...base, courtRule('06:00', '18:00', 90, 2400)],
      'пересечение у корта': [...base, courtRule('06:00', '18:00', 90, 2400), courtRule('12:00', '06:00', 90, 3600)],
    };
    const lines = [];
    for (const [name, rules] of Object.entries(bad)) {
      const r = await putTariffs(S.s90, rules);
      assert.equal(r.status, 400, `${name}: ${short(r)}`);
      lines.push(`${name}: ${r.json.error}${r.json.kind ? ` kind=${r.json.kind}` : ''}`);
    }
    t.diagnostic(lines.join('; '));
    // Дыра корта называет вид.
    const gap = await putTariffs(S.s90, [...base, courtRule('06:00', '18:00', 90, 2400)]);
    assert.equal(gap.json.error, 'tariff_gap');
    assert.equal(gap.json.kind, 'padel_court');
    // Без правил корта клуб с кортами не принимает тарифы: kind:null — только столы.
    const noCourt = await putTariffs(S.s90, base);
    assert.equal(noCourt.status, 400, short(noCourt));
    assert.deepEqual([noCourt.json.error, noCourt.json.kind], ['tariff_gap', 'padel_court']);
    assert.equal(JSON.stringify((await api('GET', `/api/clubs/${S.s90.club}/tariffs`, { token: S.owner.token, club: S.s90.club })).json.rules), before, 'тарифы не изменились');
    // 50 коп. за слот и 3000 коп. за час при шаге 1 минута — границы допустимого.
    const edge = await putTariffs(S.s90, [rule('06:00', '06:00', 0, { price_per_hour_kopecks: 3000 }), { ...courtRule('06:00', '06:00', 90, 0), price_per_slot_kopecks: 50 }]);
    assert.equal(edge.status, 200, short(edge));
    const restore = await putTariffs(S.s90, [rule('06:00', '06:00', 600), courtRule('06:00', '18:00', 90, 2400), courtRule('18:00', '06:00', 90, 3600)]);
    assert.equal(restore.status, 200, short(restore));
  });

  it('цена брони: граница расписания внутри слота делит слот по минутам (60/90/120), пояс — местный', async (t) => {
    const day = dayPlus(4);
    const cases = [
      // [клуб, слот, старт местный, минуты, ожидание копейки, пояс]
      // 60: день 1 500 ₽/слот (25/мин), вечер 2 100 (35/мин). 17:30–18:30 = 30·25 + 30·35 = 1 800 ₽.
      [S.s60, 60, '17:30', 60, 180_000, TZ.ekb],
      [S.s60, 60, '17:00', 60, 150_000, TZ.ekb], // весь слот днём
      [S.s60, 60, '18:00', 60, 210_000, TZ.ekb], // весь слот вечером (граница на старте слота)
      [S.s60, 60, '17:00', 120, 150_000 + 210_000, TZ.ekb], // два слота: день и вечер
      // 90: день 2 400 (26,67/мин), вечер 3 600 (40/мин). 17:00–18:30 = 60·26,67 + 30·40 = 1 600 + 1 200 = 2 800 ₽.
      [S.s90, 90, '17:00', 90, 280_000, TZ.ekb],
      [S.s90, 90, '17:30', 90, 30 * (240_000 / 90) + 60 * (360_000 / 90), TZ.ekb], // 30 мин днём + 60 вечером = 800 + 2 400
      [S.s90, 90, '16:30', 90, 240_000, TZ.ekb],
      // 120: день 2 400 (20/мин), вечер 3 600 (30/мин). 17:00–19:00 = 60·20 + 60·30 = 1 200 + 1 800 = 3 000 ₽.
      [S.s120, 120, '17:00', 120, 300_000, TZ.ekb],
      [S.s120, 120, '17:30', 120, 30 * (240_000 / 120) + 90 * (360_000 / 120), TZ.ekb], // шаг начала брони — 30 минут
      // Калининград (UTC+2) — те же цены на то же местное время.
      [S.kgd, 90, '17:00', 90, 280_000, TZ.kgd],
    ];
    const lines = [];
    for (const [c, slot, hhmm, minutes, expected, tz] of cases) {
      const res = court(c);
      const r = await book(c, res.id, localToUtc(day, hhmm, tz), minutes);
      assert.equal(r.status, 201, `${c.name} ${hhmm} ${minutes}: ${short(r)}`);
      assert.equal(r.json.amount_kopecks, Math.floor(expected / 100 + 0.5) * 100, `${c.name} слот ${slot} ${hhmm} +${minutes}: ${r.json.amount_kopecks} коп. вместо ${expected}`);
      lines.push(`${slot}/${hhmm}+${minutes}=${r.json.amount_kopecks / 100} ₽`);
    }
    t.diagnostic(lines.join('; '));
  });

  it('бронь корта: 1–2 слота кратно слоту; не кратно, ноль, отрицательно, 5 слотов — 400; начало вне сетки — 400', async (t) => {
    const day = dayPlus(5);
    const res = court(S.s90);
    const at = localToUtc(day, '10:00', TZ.ekb);
    const ok = [];
    for (const m of [90, 180]) {
      const r = await book(S.s90, res.id, at, m);
      assert.equal(r.status, 201, `${m}: ${short(r)}`);
      ok.push(m);
    }
    const bad = [30, 45, 60, 89, 91, 100, 120, 0, -90, 180.5, '90', null, 450, 1e9];
    for (const m of bad) {
      const r = await book(S.s90, res.id, at, m);
      assert.equal(r.status, 400, `minutes=${JSON.stringify(m)}: ${short(r)}`);
    }
    const three = await book(S.s90, res.id, at, 270);
    t.diagnostic(`успешно: ${ok.join(', ')}; 270 (3 слота) → ${three.status} ${three.json?.error ?? ''}`);
    assert.equal((await book(S.s90, res.id, new Date(at.getTime() + 15 * 60_000), 90)).status, 400, 'начало не по сетке 30 минут');
    assert.equal((await book(S.s90, res.id, new Date(at.getTime() + 7 * 60_000), 90)).status, 400, 'начало не по сетке');
    assert.equal((await book(S.s90, res.id, new Date(Date.now() - 3600_000), 90)).status, 400, 'в прошлом');
    // Стол в клубе с кортами — часовая бронь по часам, корт — слотом.
    const tr = await book(S.s90, table(S.s90).id, at, 60);
    assert.equal(tr.status, 201, short(tr));
    assert.equal(tr.json.amount_kopecks, 60_000, 'стол 600 ₽/ч');
    // Пересечение по одному корту — 409; параллельно на втором корте — можно.
    const first = await apiWait('POST', '/api/bookings', { token: S.guest.token, body: { resource_id: court(S.s60, 1).id, starts_at: localToUtc(day, '14:00', TZ.ekb).toISOString(), minutes: 120 } });
    assert.equal(first.status, 201, short(first));
    const g2 = await newGuest();
    const clash = await apiWait('POST', '/api/bookings', { token: g2.token, body: { resource_id: court(S.s60, 1).id, starts_at: localToUtc(day, '15:00', TZ.ekb).toISOString(), minutes: 60 } });
    assert.equal(clash.status, 409, short(clash));
    const other = await apiWait('POST', '/api/bookings', { token: g2.token, body: { resource_id: court(S.s60, 2).id, starts_at: localToUtc(day, '15:00', TZ.ekb).toISOString(), minutes: 60 } });
    assert.equal(other.status, 201, short(other));
    for (const id of [first.json.id]) await api('POST', `/api/bookings/${id}/cancel`, { token: S.guest.token, body: {} });
    await api('POST', `/api/bookings/${other.json.id}/cancel`, { token: g2.token, body: {} });
  });

  it('семьи ресурсов: «Стол 1» и «Корт 1» вместе, дубль внутри семьи — 409, стол ↔ корт сменой вида — 400, название по умолчанию', async () => {
    const c = S.s90;
    const list = (await api('GET', `/api/clubs/${c.club}/resources`, { token: S.owner.token, club: c.club })).json.resources;
    assert.deepEqual(list.filter((r) => r.number === 1).map((r) => r.title).sort(), ['Корт 1', 'Стол 1']);
    assert.deepEqual(list.map((r) => r.family), ['table', 'table', 'court'], 'столы, затем корты');
    const dupCourt = await api('POST', `/api/clubs/${c.club}/resources`, { token: S.owner.token, club: c.club, body: { number: 1, kind: 'padel_court', plan_x: 900, plan_y: 700, plan_rotation: 0 } });
    assert.equal(dupCourt.status, 409, short(dupCourt));
    const dupTable = await api('POST', `/api/clubs/${c.club}/resources`, { token: S.owner.token, club: c.club, body: { number: 1, kind: 'pool', plan_x: 900, plan_y: 300, plan_rotation: 0 } });
    assert.equal(dupTable.status, 409, short(dupTable));
    const t = table(c, 1);
    const cr = court(c, 1);
    assert.equal((await api('PATCH', `/api/clubs/${c.club}/resources/${t.id}`, { token: S.owner.token, club: c.club, body: { kind: 'padel_court' } })).status, 400, 'стол → корт');
    assert.equal((await api('PATCH', `/api/clubs/${c.club}/resources/${cr.id}`, { token: S.owner.token, club: c.club, body: { kind: 'pool' } })).status, 400, 'корт → стол');
    // Корт под номером 2 — «Корт 2» по умолчанию; обслуживание сукна у корта — 400.
    const add = await api('POST', `/api/clubs/${c.club}/resources`, { token: S.owner.token, club: c.club, body: { number: 2, kind: 'padel_court', plan_x: 900, plan_y: 700, plan_rotation: 0 } });
    assert.equal(add.status, 201, short(add));
    const l2 = (await api('GET', `/api/clubs/${c.club}/resources`, { token: S.owner.token, club: c.club })).json.resources;
    assert.equal(l2.find((r) => r.family === 'court' && r.number === 2).title, 'Корт 2');
    // Клуб с кортом без правил корта: корт в тариф-гэпе (kind: null — только столы) — новый клуб.
    const fresh = await makeClub(S.owner2, { name: 'E2E M5.8 Без правил корта', kinds: ['pyramid'], courts: 1 });
    const gap = await api('PUT', `/api/clubs/${fresh.club}/tariffs`, { token: S.owner2.token, club: fresh.club, body: { rules: [rule('06:00', '06:00', 600)] } });
    assert.equal(gap.status, 400, short(gap));
    assert.deepEqual([gap.json.error, gap.json.kind], ['tariff_gap', 'padel_court']);
  });

  it('боевая конфигурация котировки (без dev-флага минут): корт — только 1–4 слота; «Без лимита» и баланс — 400', () => {
    const RID = '14e6ef0d-18db-41cc-b335-ae41b1f1712e';
    const prod = { devAllowAnyMinutes: false, slotMinutes: 90 };
    for (const slots of [1, 2, 3, 4]) assert.equal(parseQuoteRequest({ resource_id: RID, kind: 'start', minutes: 90 * slots }, prod).minutes, 90 * slots);
    for (const m of [1, 30, 45, 60, 89, 91, 100, 120, 180.5, 0, -90, 450, 540, 999_999]) {
      assert.throws(() => parseQuoteRequest({ resource_id: RID, kind: 'start', minutes: m }, prod), (e) => e?.code === 'bad_request', `minutes=${m}`);
    }
    assert.throws(() => parseQuoteRequest({ resource_id: RID, kind: 'start', minutes: null }, prod), (e) => e?.code === 'bad_request', '«Без лимита»');
    assert.throws(() => parseQuoteRequest({ resource_id: RID, kind: 'start', minutes: 90, use_balance: true }, prod), (e) => e?.code === 'bad_request', 'баланс пакетов');
    // Для стола в той же конфигурации «Без лимита» разрешён — различие по виду ресурса.
    assert.equal(parseQuoteRequest({ resource_id: RID, kind: 'start', minutes: null }, { devAllowAnyMinutes: false }).minutes, null);
  });
});
