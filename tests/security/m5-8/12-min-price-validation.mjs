// PoC M5.8, заход 2 — Н-2: тариф не меньше 1 ₽ после округления (№220, bc51e24), на стенде.
// Правило валидации: для наименьшей оплачиваемой единицы (слот целиком; час — на шаг продления) сумма после
// округления «половина вверх» до рубля не меньше 1 ₽, то есть слот ≥ 50 коп., час×шаг ≥ 3 000 копеек·минут.
// Проверяются: граничные значения для слота и часа при всех допустимых шагах и слотах, мастер тарифов клуба,
// шаблон тарифов сети, обходы порога (огромные числа, min_minutes, шаг 1, правила вперемешку, несколько видов),
// и что после отказа действующие правила клуба не изменились (атомарность).
// Свой клуб владельца в режиме test (без устройств), сид и чужие клубы не затрагиваются.
//
// Запуск: node tests/security/m5-8/12-min-price-validation.mjs

import { api, login, ok, runner, sleep } from './lib.mjs';

const r = runner('M5.8 / 12: тариф не меньше 1 ₽ после округления');
const owner = await login();
// Лимит PUT тарифов — 60 в минуту на источник: при 429 ждём и повторяем (лимит не обходим).
const J = async (method, path, body, token = owner.token) => {
  for (let i = 0; ; i += 1) {
    const x = await api(method, path, { token, body });
    if (x.status !== 429 || i >= 12) return x;
    await sleep(5000);
  }
};

const club = (await ok(J('POST', '/api/clubs', { name: 'Pentest Padel 58 R2', city_name: 'Москва', timezone: 'Europe/Moscow' }), 201));
const CID = club.club_id;
const base = `/api/clubs/${CID}`;
const court = (await J('POST', `${base}/resources`, { kind: 'padel_court', number: 1 })).json;
const table = (await J('POST', `${base}/resources`, { kind: 'pool', number: 1 })).json;
r.check('подготовка: в клубе корт и стол', Boolean(court?.id && table?.id));

const ALL = [1, 2, 3, 4, 5, 6, 7];
const tableRule = (over = {}) => ({ kind: null, days: ALL, from: '06:00', to: '06:00', price_per_hour_kopecks: 50000, min_minutes: 30, step_minutes: 15, ...over });
const courtRule = (over = {}) => ({ kind: 'padel_court', days: ALL, from: '06:00', to: '06:00', slot_minutes: 90, price_per_slot_kopecks: 240000, ...over });
const put = (rules) => J('PUT', `${base}/tariffs`, { rules });
const good = await put([tableRule(), courtRule()]);
r.check('рабочий набор правил принят (стол 500 ₽/ч, корт 2 400 ₽/слот)', good.status === 200, `${good.status} ${good.json?.error ?? ''}`);
const snapshot = async () => JSON.stringify((await J('GET', `${base}/tariffs`)).json?.rules ?? (await J('GET', `${base}/tariffs`)).json);
const goodState = await snapshot();

// --- A. Слот: порог 50 копеек (0,50 ₽ → округляется до 1 ₽), 49 — до 0 ₽ ---------------------------------------
for (const slot of [60, 90, 120]) {
  for (const [price, want] of [[49, 400], [50, 200], [1, 400], [99, 200]]) {
    const x = await put([tableRule(), courtRule({ slot_minutes: slot, price_per_slot_kopecks: price })]);
    r.check(`корт: слот ${slot} мин, цена ${price} коп. → ${want}`, x.status === want, `${x.status} ${x.json?.error ?? ''}`);
  }
}
await put([tableRule(), courtRule()]);

// --- B. Час: порог price × step ≥ 3 000 (50 коп. × 60 минут) -------------------------------------------------
const hourly = [];
for (const step of [1, 2, 5, 10, 15, 20, 30, 60]) {
  const minPrice = Math.ceil(3000 / step);
  hourly.push([step, minPrice - 1, 400], [step, minPrice, 200]);
}
for (const [step, price, want] of hourly) {
  const x = await put([tableRule({ price_per_hour_kopecks: price, step_minutes: step, min_minutes: 0 }), courtRule()]);
  r.check(`стол: шаг ${step} мин, ${price} коп./ч (${price * step} коп.·мин) → ${want}`, x.status === want, `${x.status} ${x.json?.error ?? ''}`);
}
await put([tableRule(), courtRule()]);

// --- C. Обходы порога ---------------------------------------------------------------------------------------
const bypass = [
  ['цена 1 коп. со шагом 60', tableRule({ price_per_hour_kopecks: 1, step_minutes: 60, min_minutes: 0 }), 400],
  ['цена 29 коп. со шагом 60, min 1440 (большой минимум не поднимает порог шага)', tableRule({ price_per_hour_kopecks: 29, step_minutes: 60, min_minutes: 1440 }), 400],
  ['цена 49 коп. со шагом 60, min 60', tableRule({ price_per_hour_kopecks: 49, step_minutes: 60, min_minutes: 60 }), 400],
  ['дробная цена 49.99', tableRule({ price_per_hour_kopecks: 49.99, step_minutes: 60 }), 400],
  ['цена строкой «50»', tableRule({ price_per_hour_kopecks: '50', step_minutes: 60 }), 400],
  ['шаг 0 (деление на 0)', tableRule({ price_per_hour_kopecks: 50, step_minutes: 0 }), 400],
  ['шаг 61 (> 60)', tableRule({ price_per_hour_kopecks: 5000, step_minutes: 61 }), 400],
  ['шаг 1e21', tableRule({ price_per_hour_kopecks: 5000, step_minutes: 1e21 }), 400],
  ['шаг −15', tableRule({ price_per_hour_kopecks: 5000, step_minutes: -15 }), 400],
  ['min_minutes −1', tableRule({ min_minutes: -1 }), 400],
  ['min_minutes 1441 (> суток)', tableRule({ min_minutes: 1441 }), 400],
  ['цена 100 000 000 коп./ч (предел) со шагом 60', tableRule({ price_per_hour_kopecks: 100_000_000, step_minutes: 60 }), 200],
  ['цена 100 000 001 (выше предела)', tableRule({ price_per_hour_kopecks: 100_000_001 }), 400],
  ['цена 9007199254740991 (MAX_SAFE_INTEGER)', tableRule({ price_per_hour_kopecks: Number.MAX_SAFE_INTEGER }), 400],
];
for (const [label, rule, want] of bypass) {
  const x = await put([rule, courtRule()]);
  r.check(`обход: ${label} → ${want}`, x.status === want, `${x.status} ${x.json?.error ?? ''}`);
}
await put([tableRule(), courtRule()]);
// Копеечное правило вперемешку с нормальными (другой день / другое окно): целиком отклоняется, нормальные не записываются.
const mixed = await put([tableRule({ days: [1, 2, 3, 4, 5] }), tableRule({ days: [6, 7], price_per_hour_kopecks: 10, step_minutes: 15 }), courtRule()]);
r.check('копеечное правило в выходные среди нормальных → 400, набор не записан', mixed.status === 400, `${mixed.status} ${mixed.json?.error ?? ''}`);
const mixedCourt = await put([tableRule(), courtRule({ days: [1, 2, 3, 4, 5] }), courtRule({ days: [6, 7], price_per_slot_kopecks: 10 })]);
r.check('копеечный слот в выходные среди нормальных → 400', mixedCourt.status === 400, `${mixedCourt.status} ${mixedCourt.json?.error ?? ''}`);
await put([tableRule(), courtRule()]);
r.check('правила клуба после всех отказов — прежние', (await snapshot()) === goodState);

// Копеечный тариф у стола и корта через «kind» конкретного вида и общего.
const kinds = [];
for (const kind of ['pool', 'pyramid', 'snooker', 'carom']) {
  const x = await put([tableRule({ kind, price_per_hour_kopecks: 10, step_minutes: 15 }), tableRule(), courtRule()]);
  kinds.push(`${kind}:${x.status}`);
}
r.check('копеечный тариф конкретного вида стола → 400', kinds.every((k) => k.endsWith(':400')), kinds.join(' '));
await put([tableRule(), courtRule()]);

// --- D. Шаблон тарифов сети --------------------------------------------------------------------------------
const net = (await ok(J('POST', '/api/networks', { name: 'Pentest R2 net' }), 201));
const NID = net.id;
const tpl = (rules) => J('PUT', `/api/networks/${NID}/tariffs`, { rules });
const tplCases = [
  ['слот 49 коп.', [tableRule(), courtRule({ price_per_slot_kopecks: 49 })], 400],
  ['слот 50 коп.', [tableRule(), courtRule({ price_per_slot_kopecks: 50 })], 200],
  ['час 2 999/шаг 1', [tableRule({ price_per_hour_kopecks: 2999, step_minutes: 1, min_minutes: 0 }), courtRule()], 400],
  ['час 3 000/шаг 1', [tableRule({ price_per_hour_kopecks: 3000, step_minutes: 1, min_minutes: 0 }), courtRule()], 200],
  ['час 49/шаг 60', [tableRule({ price_per_hour_kopecks: 49, step_minutes: 60 }), courtRule()], 400],
];
for (const [label, rules, want] of tplCases) {
  const x = await tpl(rules);
  r.check(`шаблон сети: ${label} → ${want}`, x.status === want, `${x.status} ${x.json?.error ?? ''}`);
}
const okTpl = await tpl([tableRule(), courtRule()]);
r.check('шаблон сети: нормальный набор → 200', okTpl.status === 200, `${okTpl.status} ${okTpl.json?.error ?? ''}`);
const added = await J('POST', `/api/networks/${NID}/clubs`, { club_id: CID });
r.check('клуб добавлен в сеть с нормальным шаблоном (шаблон применён)', added.status === 201, `${added.status} ${added.json?.error ?? ''}`);
const reput = await tpl([tableRule(), courtRule({ price_per_slot_kopecks: 10 })]);
r.check('шаблон сети уже действует: замена на копеечный → 400, клубы не получают его', reput.status === 400, `${reput.status}`);
const after = await J('GET', `${base}/tariffs`);
const rules = JSON.stringify(after.json);
r.check('правила клуба после попытки копеечного шаблона — не копеечные', !/"price_per_slot_kopecks":10[,}]/.test(rules), '');

r.done();
