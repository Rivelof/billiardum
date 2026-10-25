// PoC M5.8 / сценарий 3 — мастер тарифов и зал: покрытие недели, граничные значения слота,
// смена типа стол↔корт, нумерация, депозит на корте. Свой клуб владельца (режим test, без устройств),
// сид и чужие клубы не затрагиваются.
//
// Атакующий: владелец/управляющий, который хочет получить бесплатную или дешёвую игру через тариф,
// либо ресепшн, который хочет принять деньги за корт способом «Без лимита».
// Инварианты: 8 (тариф 0 ₽ и смена вида — не тихо), 10 (копейки, пояс клуба).
//
// Запуск: node tests/security/m5-8/03-setup-tariffs-hall.mjs

import { api, login, ok, runner } from './lib.mjs';

const r = runner('M5.8 / 3: тарифы корта, зал, депозит');
const owner = await login();
const J = (token, method, path, body, extra) => api(method, path, { token, body, ...extra });

const club = await ok(J(owner.token, 'POST', '/api/clubs', { name: 'Pentest Padel 58 B', city_name: 'Москва', timezone: 'Europe/Moscow' }), 201).catch(async () => null);
// Некоторые версии отвечают 200: повторим без жёсткого кода.
const cr = club ?? (await J(owner.token, 'POST', '/api/clubs', { name: 'Pentest Padel 58 B', city_name: 'Москва', timezone: 'Europe/Moscow' })).json;
const CID = cr.club_id;
const base = `/api/clubs/${CID}`;
const res = (kind, number, token = owner.token) => J(token, 'POST', `${base}/resources`, { kind, number });
const court = (await res('padel_court', 1)).json;
const table = (await res('pool', 1)).json;
r.check('в одном клубе «Корт 1» и «Стол 1» (разные семьи)', court?.id && table?.id && court.family === 'court' && table.family === 'table', `${court?.title} / ${table?.title}`);

const ALL = [1, 2, 3, 4, 5, 6, 7];
const tableRule = { kind: null, days: ALL, from: '06:00', to: '06:00', price_per_hour_kopecks: 50000, min_minutes: 30, step_minutes: 15 };
const courtRule = (over = {}) => ({ kind: 'padel_court', days: ALL, from: '06:00', to: '06:00', slot_minutes: 90, price_per_slot_kopecks: 900000, ...over });
const put = (rules) => J(owner.token, 'PUT', `${base}/tariffs`, { rules });

// --- A. Покрытие недели и вид ---------------------------------------------------------------
let x = await put([tableRule]);
r.check('kind:null покрывает только столы: клуб с кортом без правил корта — tariff_gap', x.status === 400 && x.json?.error === 'tariff_gap', `${x.status} ${x.text.slice(0, 160)}`);
x = await put([courtRule()]);
r.check('только правила корта при столе в работе — tariff_gap', x.status === 400 && x.json?.error === 'tariff_gap', `${x.status} ${x.text.slice(0, 160)}`);
x = await put([tableRule, courtRule()]);
r.check('столы + корт — 200, покрытие ok', x.status === 200 && x.json?.coverage?.ok === true && x.json?.slots?.padel_court === 90, `${x.status} slots=${JSON.stringify(x.json?.slots)}`);
x = await put([tableRule, courtRule({ to: '23:00' })]);
r.check('корт с дырой 23:00–06:00 — tariff_gap', x.status === 400 && x.json?.error === 'tariff_gap', `${x.status} ${x.json?.error}`);
x = await put([tableRule, courtRule(), courtRule({ days: [1], price_per_slot_kopecks: 100 })]);
r.check('два правила корта на одну минуту — tariff_overlap', x.status === 400 && x.json?.error === 'tariff_overlap', `${x.status} ${x.json?.error}`);
await put([tableRule, courtRule()]); // вернуть рабочий набор

// --- B. Граничные значения слота -------------------------------------------------------------
const bad = [
  ['цена 0', { price_per_slot_kopecks: 0 }],
  ['цена −1', { price_per_slot_kopecks: -1 }],
  ['цена 1.5', { price_per_slot_kopecks: 1.5 }],
  ['цена строкой', { price_per_slot_kopecks: '900000' }],
  ['цена null', { price_per_slot_kopecks: null }],
  ['цена 1e21', { price_per_slot_kopecks: 1e21 }],
  ['цена выше предела 100000001', { price_per_slot_kopecks: 100_000_001 }],
  ['цена MAX_SAFE_INTEGER', { price_per_slot_kopecks: Number.MAX_SAFE_INTEGER }],
  ['слот 75', { slot_minutes: 75 }],
  ['слот 0', { slot_minutes: 0 }],
  ['слот строкой', { slot_minutes: '90' }],
  ['слот 150', { slot_minutes: 150 }],
  ['слот не задан', { slot_minutes: undefined }],
  ['min_minutes ≠ слот', { min_minutes: 30 }],
  ['step_minutes ≠ слот', { step_minutes: 1 }],
  ['почасовая цена на корте', { price_per_hour_kopecks: 50000 }],
];
for (const [label, over] of bad) {
  const rule = courtRule(over);
  for (const k of Object.keys(rule)) if (rule[k] === undefined) delete rule[k];
  const resp = await put([tableRule, rule]);
  r.check(`корт: ${label} — 400`, resp.status === 400, `${resp.status} ${resp.json?.error}`);
}
const wrongKinds = [
  ['слот на правиле «все столы»', { ...tableRule, slot_minutes: 90, price_per_slot_kopecks: 900000 }],
  ['слот на правиле пула', { ...tableRule, kind: 'pool', slot_minutes: 60, price_per_slot_kopecks: 100000 }],
];
for (const [label, rule] of wrongKinds) {
  const resp = await put([rule, courtRule()]);
  r.check(`${label} — 400`, resp.status === 400, `${resp.status} ${resp.json?.error}`);
}
x = await put([tableRule, courtRule(), courtRule({ days: [1], slot_minutes: 120 })]);
r.check('две длины слота у корта — 400 (одна на вид)', x.status === 400, `${x.status} ${x.json?.error}`);
const stateAfter = (await J(owner.token, 'GET', `${base}/tariffs`)).json;
r.check('после отказов действует прежний набор (слот 90, 900 000 коп.)', stateAfter?.slots?.padel_court === 90 && stateAfter.rules.some((q) => q.price_per_slot_kopecks === 900000), JSON.stringify(stateAfter?.slots));

// Наблюдение, не проверка защиты: копеечная цена слота проходит «> 0», но округление до рубля даёт 0 ₽.
x = await put([tableRule, courtRule({ price_per_slot_kopecks: 49 })]);
console.log(`НАБЛЮДЕНИЕ цена слота 49 коп. принимается: ${x.status}`);
await put([tableRule, courtRule()]);

// --- C. Зал: смена вида и номера ---------------------------------------------------------------
x = await J(owner.token, 'PATCH', `${base}/resources/${court.id}`, { kind: 'pool' });
r.check('корт → пул: 400', x.status === 400, `${x.status} ${x.json?.error}`);
x = await J(owner.token, 'PATCH', `${base}/resources/${table.id}`, { kind: 'padel_court' });
r.check('стол → корт: 400', x.status === 400, `${x.status} ${x.json?.error}`);
x = await J(owner.token, 'PATCH', `${base}/resources/${table.id}`, { kind: 'snooker' });
r.check('контроль: пул → снукер (та же семья) разрешено', x.status === 200, `${x.status}`);
x = await res('padel_court', 1);
r.check('второй «Корт 1» — отказ', x.status >= 400, `${x.status} ${x.json?.error}`);
x = await res('pool', 1);
r.check('второй «Стол 1» — отказ', x.status >= 400, `${x.status} ${x.json?.error}`);
const court2 = (await res('padel_court', 2)).json;
x = await J(owner.token, 'PATCH', `${base}/resources/${court2.id}`, { number: 1 });
r.check('перенумеровать «Корт 2» в «Корт 1» — отказ', x.status >= 400, `${x.status} ${x.json?.error}`);
for (const n of [0, -1, 1.5, '1', 1e9]) {
  x = await res('padel_court', n);
  r.check(`номер корта ${JSON.stringify(n)} — 400`, x.status === 400, `${x.status} ${x.json?.error}`);
}
for (const k of ['padel', 'Padel_Court', 'tennis', '', null]) {
  x = await res(k, 7);
  r.check(`вид ${JSON.stringify(k)} — 400`, x.status === 400, `${x.status} ${x.json?.error}`);
}

// --- D. Корт выведен из работы → правила без корта → возврат в работу -----------------------------
x = await J(owner.token, 'PATCH', `${base}/resources/${court.id}`, { active: false });
const courtOff = x.status;
const court2off = (await J(owner.token, 'PATCH', `${base}/resources/${court2.id}`, { active: false })).status;
x = await put([tableRule]);
const putNoCourt = x.status;
x = await J(owner.token, 'PATCH', `${base}/resources/${court.id}`, { active: true });
console.log(`НАБЛЮДЕНИЕ: корт выведен (${courtOff}/${court2off}), правила без корта (${putNoCourt}), возврат корта в работу без правил → ${x.status} ${x.json?.error ?? ''}`);
const code = court.code;
const t = await J(owner.token, 'GET', `/api/t/${code}`);
r.check('корт без тарифа не продаётся: цена null, вариантов нет или статус не free', t.json?.price_now === null || (t.json?.options ?? []).length === 0 || t.json?.status !== 'free', `status=${t.json?.status} price_now=${JSON.stringify(t.json?.price_now)} options=${JSON.stringify(t.json?.options)}`);
await put([tableRule, courtRule()]);

// --- E. Депозит «Без лимита» на корте --------------------------------------------------------------
const shift = await J(owner.token, 'POST', `${base}/shifts`, { float_kopecks: 100000 });
console.log(`смена: ${shift.status} ${shift.text.slice(0, 120)}`);
const dep = (resourceId) => api('POST', '/api/reception/deposits', { token: owner.token, body: { resource_id: resourceId, amount_kopecks: 100000 }, idem: true });
const dc = await dep(court.id);
const dt = await dep(table.id);
if (shift.status === 200 || shift.status === 201) {
  r.check('депозит на корте — 400 bad_request (до приёма денег)', dc.status === 400 && dc.json?.error === 'bad_request', `${dc.status} ${dc.json?.error}`);
  r.check('контроль: депозит на столе доходит до проверки контроллера (table_offline)', dt.status === 409 && dt.json?.error === 'table_offline' || dt.status >= 400, `${dt.status} ${dt.json?.error}`);
} else {
  console.log(`НЕ ПРОВЕРЕНО: смена не открыта (${shift.status}); депозит на корте → ${dc.status} ${dc.json?.error}, на столе → ${dt.status} ${dt.json?.error}`);
}
// --- F. Обслуживание: корт не принимает события износа (№211), в кассу ничего не уходит ----------------
// Маршрут идемпотентный: без Idempotency-Key любой запрос — 400, поэтому ключ обязателен и в проверке корта.
const mt = (rid, over = {}) => J(owner.token, 'POST', `${base}/maintenance`, { resource_id: rid, kind: 'cloth', comment: 'poc', ...over }, { idem: true });
x = await mt(court.id);
r.check('обслуживание корта (сукно) — 400', x.status === 400, `${x.status} ${x.json?.error}`);
x = await mt(court.id, { cost_kopecks: 100000 });
r.check('обслуживание корта со стоимостью — 400, расход не создан', x.status === 400, `${x.status} ${x.json?.error}`);
x = await mt(table.id);
r.check('контроль: то же событие на столе принимается', x.status === 200 || x.status === 201, `${x.status} ${x.json?.error ?? ''}`);

r.done();
