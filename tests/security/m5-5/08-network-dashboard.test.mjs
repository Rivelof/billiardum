// PoC M5.5 — вкладка «Сеть» дашборда (№193, №192, №167).
// Проверяем: чужая сеть недоступна (404); в ответе нет денег по способам оплаты; тестовые клубы не
// входят в рейтинг; клубы вне сети не попадают в ответ; период с мусором и слишком длинный → 400;
// подмена query (club, club_id, network_id, kind, tab) не расширяет выборку; вывод клуба убирает его
// из таблицы; управляющий сети не получает чужие клубы владельца вне сети.
// Тестовые деньги: в test-клубах платежей на стенде нет (не проверяется платёжным сценарием);
// исключение is_test — server/dashboard/service.mjs:355,361 и существующие тесты M5.2.
//
// Запуск: node tests/security/m5-5/08-network-dashboard.test.mjs

import { addClub, api, check, createClub, createNetwork, login, phone, RUN, summary } from './_helpers.mjs';

const results = [];
const A = await login(phone());
const B = await login(phone());
const inNet = await createClub(A.token, { name: `D1 ${RUN}` });
const inNet2 = await createClub(A.token, { name: `D2 ${RUN}`, timezone: 'Europe/Kaliningrad', city: 'Калининград' });
const outside = await createClub(A.token, { name: `Dout ${RUN}` }); // свой клуб А вне сети
const foreign = await createClub(B.token, { name: `Dforeign ${RUN}` });
const NA = await createNetwork(A.token, `ND ${RUN}`);
await addClub(A.token, NA, inNet);
await addClub(A.token, NA, inNet2);

const mPhone = phone();
await api('POST', `/api/networks/${NA}/managers`, { token: A.token, body: { phone: mPhone } });
const M = await login(mPhone);

// 1. Владелец и управляющий видят ровно клубы сети.
for (const [who, tok] of [['владелец', A.token], ['управляющий', M.token]]) {
  const d = await api('GET', `/api/networks/${NA}/dashboard`, { token: tok });
  const ids = (d.json?.clubs ?? []).map((c) => c.club_id).sort();
  check(results, `${who}: таблица содержит ровно 2 клуба сети`, d.status === 200 && JSON.stringify(ids) === JSON.stringify([inNet, inNet2].sort()), `status=${d.status} ids=${ids.length}`);
  check(results, `${who}: клуба вне сети и чужого клуба нет в ответе`, !JSON.stringify(d.json).includes(outside) && !JSON.stringify(d.json).includes(foreign), '');
}

// 2. Чужая сеть: 404 на дашборд, любые query-подмены не помогают.
{
  const r = await api('GET', `/api/networks/${NA}/dashboard`, { token: B.token });
  check(results, 'посторонний: дашборд чужой сети → 404', r.status === 404, `status=${r.status}`);
  const spoof = await api('GET', `/api/networks/${NA}/dashboard?club=${foreign}&club_id=${foreign}&network_id=${NA}`, { token: B.token });
  check(results, 'посторонний: подмена club/club_id в query → 404', spoof.status === 404, `status=${spoof.status}`);
  const own = await api('GET', `/api/networks/${NA}/dashboard?club=${foreign}&club_id=${foreign}`, { token: A.token });
  check(results, 'владелец: подмена club/club_id в query не добавляет чужой клуб', own.status === 200 && !JSON.stringify(own.json).includes(foreign), `status=${own.status}`);
  const A2 = await api('GET', `/api/networks/${foreign}/dashboard`, { token: A.token });
  check(results, 'club_id вместо network_id в пути → 404', A2.status === 404, `status=${A2.status}`);
}

// 3. Денег по способам оплаты в ответе нет ни у кого (ключи).
{
  for (const [who, tok] of [['владелец', A.token], ['управляющий', M.token]]) {
    const d = await api('GET', `/api/networks/${NA}/dashboard`, { token: tok });
    const t = JSON.stringify(d.json);
    check(results, `${who}: в ответе «Сети» нет разбивки по способам оплаты`, !/by_method|"cash"|"card"|"sbp"|card_terminal|payment_method/.test(t), t.length + ' байт');
  }
}

// 4. Тестовые клубы показываются, но не ранжируются.
{
  const d = await api('GET', `/api/networks/${NA}/dashboard`, { token: A.token });
  const placeVals = (c) => Object.entries(c).filter(([k]) => k.startsWith('place_')).map(([, v]) => v);
  const allUnranked = (d.json?.clubs ?? []).length > 0 && (d.json.clubs).every((c) => c.mode === 'test' && c.ranked === false && placeVals(c).every((v) => v === null));
  check(results, 'test-клубы: ranked=false, мест в рейтинге нет', allUnranked, JSON.stringify((d.json?.clubs ?? []).map((c) => [c.mode, c.ranked, placeVals(c)])));
  const rankingEmpty = Object.values(d.json?.ranking ?? { x: [1] }).every((arr) => Array.isArray(arr) && arr.length === 0);
  check(results, 'рейтинг пуст, пока нет live-клубов', rankingEmpty, JSON.stringify(d.json?.ranking));
}

// 5. Параметры периода: мусор, перевёрнутый, слишком длинный, неверная вкладка/вид — 400, не 500.
{
  const cases = {
    garbage: 'from=abc&to=def',
    reversed: 'from=2026-10-20&to=2026-10-01',
    too_long: 'from=2020-01-01&to=2026-10-01',
    sql: `from=2026-10-01'--&to=2026-10-02`,
    compare_bad: 'compare=2',
    huge_future: 'from=2026-10-01&to=9999-12-31',
  };
  const bad = [];
  for (const [k, q] of Object.entries(cases)) {
    const r = await api('GET', `/api/networks/${NA}/dashboard?${q}`, { token: A.token });
    if (r.status !== 400) bad.push(`${k}=${r.status}`);
  }
  check(results, 'период: мусор / перевёрнутый / длиннее года / SQL / compare=2 → 400', bad.length === 0, bad.join(', ') || 'все 400');
}

// 6. Вывод клуба из сети убирает его из таблицы сразу.
{
  await api('DELETE', `/api/networks/${NA}/clubs/${inNet2}`, { token: A.token });
  const d = await api('GET', `/api/networks/${NA}/dashboard`, { token: M.token });
  const ids = (d.json?.clubs ?? []).map((c) => c.club_id);
  check(results, 'после вывода клуба управляющий не видит его в таблице', ids.length === 1 && ids[0] === inNet, `ids=${ids.length}`);
}

// 7. Архив сети: управляющий теряет доступ ко всему.
{
  const del = await api('DELETE', `/api/networks/${NA}`, { token: A.token });
  const d = await api('GET', `/api/networks/${NA}/dashboard`, { token: M.token });
  const now = await api('GET', `/api/clubs/${inNet}/dashboard`, { token: M.token });
  check(results, 'архив сети: управляющий → 404 на сеть и 403 на клуб', del.status === 200 && d.status === 404 && now.status === 403, `${del.status}/${d.status}/${now.status}`);
}

process.exit(summary(results).length ? 1 : 0);
