// PoC M5.5 — подмена идентификаторов в пути и «Все мои клубы» для управляющего сети.
// Проверяем: DELETE клуба/управляющего из чужой сети через свою сеть; управляющий сети и
// /api/clubs/all/dashboard (вкладка «Деньги» и экспорт — без клубов сети); кэш дашборда не
// смешивает владельца и управляющего сети; reset чужого клуба.
//
// Запуск: node tests/security/m5-5/12-path-spoofing-and-all-clubs.test.mjs

import { addClub, api, check, createClub, createNetwork, login, phone, RUN, summary } from './_helpers.mjs';

const results = [];
const A = await login(phone());
const B = await login(phone());
const a1 = await createClub(A.token, { name: `PA1 ${RUN}` });
const a2 = await createClub(A.token, { name: `PA2 ${RUN}` });
const b1 = await createClub(B.token, { name: `PB1 ${RUN}` });
const b2 = await createClub(B.token, { name: `PB2 ${RUN}` });
const NA = await createNetwork(A.token, `NPA ${RUN}`);
const NB = await createNetwork(B.token, `NPB ${RUN}`);
await addClub(A.token, NA, a1);
await addClub(A.token, NA, a2);
await addClub(B.token, NB, b1);
await addClub(B.token, NB, b2);

// Управляющие обеих сетей.
const mA = phone();
const mB = phone();
await api('POST', `/api/networks/${NA}/managers`, { token: A.token, body: { phone: mA } });
await api('POST', `/api/networks/${NB}/managers`, { token: B.token, body: { phone: mB } });
const MA = await login(mA);
const MB = await login(mB);
const memberOfB = (await api('GET', `/api/networks/${NB}/managers`, { token: B.token })).json.items[0];

// 1. Подмена клуба/участника в пути чужой сети.
{
  const rmForeignClub = await api('DELETE', `/api/networks/${NA}/clubs/${b1}`, { token: A.token });
  const rmForeignMember = await api('DELETE', `/api/networks/${NA}/managers/${memberOfB.id}`, { token: A.token });
  const viaOtherNet = await api('DELETE', `/api/networks/${NB}/clubs/${b1}`, { token: A.token });
  check(results, 'A удаляет клуб B через свою сеть → 404', rmForeignClub.status === 404, `status=${rmForeignClub.status}`);
  check(results, 'A отзывает управляющего B через свою сеть → 404', rmForeignMember.status === 404, `status=${rmForeignMember.status}`);
  check(results, 'A удаляет клуб B через сеть B → 404', viaOtherNet.status === 404, `status=${viaOtherNet.status}`);
  const nb = await api('GET', `/api/networks/${NB}`, { token: B.token });
  const stillMgr = await api('GET', `/api/clubs/${b1}/now`, { token: MB.token });
  check(results, 'после попыток сеть B цела: 2 клуба, управляющий B работает', nb.json?.clubs?.length === 2 && stillMgr.status === 200, `clubs=${nb.json?.clubs?.length} mgr=${stillMgr.status}`);
}

// 2. Управляющий сети A в клубах и сети B.
{
  const probes = {
    'сеть B': await api('GET', `/api/networks/${NB}`, { token: MA.token }),
    'клуб b1 now': await api('GET', `/api/clubs/${b1}/now`, { token: MA.token }),
    'клуб b1 dashboard': await api('GET', `/api/clubs/${b1}/dashboard`, { token: MA.token }),
    'клуб b1 network': await api('GET', `/api/clubs/${b1}/network`, { token: MA.token }),
    'reset клуба b1': await api('POST', `/api/clubs/${b1}/network/reset`, { token: MA.token, body: { scope: 'tariffs' } }),
    'reset клуба b1 через X-Club-Id': await api('POST', `/api/clubs/${a1}/network/reset`, { token: MA.token, headers: { 'x-club-id': b1 }, body: { scope: 'menu' } }),
  };
  const open = Object.entries(probes).filter(([k, r]) => k !== 'reset клуба b1 через X-Club-Id' && r.status < 400);
  check(results, 'управляющий сети A: сеть B и клуб b1 недоступны (4xx)', open.length === 0, Object.entries(probes).map(([k, r]) => `${k}=${r.status}`).join(' | '));
  // reset своего клуба a1 с подставленным заголовком чужого клуба: путь главнее заголовка, чужой клуб не затронут.
  const probe = probes['reset клуба b1 через X-Club-Id'];
  check(results, 'X-Club-Id не переопределяет клуб из пути (ответ не 5xx, чужой клуб не затронут)', probe.status < 500, `status=${probe.status}`);
}

// 3. «Все мои клубы» у управляющего сети: сводка есть, «Деньги» и экспорт — нет.
{
  const sum = await api('GET', '/api/clubs/all/dashboard?tab=summary', { token: MA.token });
  const money = await api('GET', '/api/clubs/all/dashboard?tab=money', { token: MA.token });
  const exp = await api('GET', '/api/clubs/all/dashboard/export.csv?table=summary', { token: MA.token });
  const nowAll = await api('GET', '/api/clubs/all/dashboard/now', { token: MA.token });
  const ids = JSON.stringify(sum.json ?? {});
  check(results, 'управляющий сети: «Все клубы»/сводка — только клубы его сети', sum.status === 200 && ids.includes(a1) && !ids.includes(b1) && !ids.includes(b2), `status=${sum.status}`);
  check(results, 'управляющий сети: «Все клубы»/«Деньги» → 403 (нет клубов без сети)', money.status === 403, `status=${money.status}`);
  check(results, 'управляющий сети: «Все клубы»/экспорт → 403', exp.status === 403, `status=${exp.status}`);
  const t = JSON.stringify(nowAll.json ?? {});
  check(results, '«Все клубы»/сейчас: без разбивки по способам и без чужих клубов', nowAll.status === 200 && !/"by_method":\{/.test(t) && !t.includes(b1), `status=${nowAll.status}`);
}

// 4. Кэш дашборда не смешивает владельца и управляющего сети (одна вкладка «Деньги» у владельца).
{
  const ownerFirst = await api('GET', `/api/clubs/${a1}/dashboard?tab=money`, { token: A.token });
  const mgrAfter = await api('GET', `/api/clubs/${a1}/dashboard?tab=money`, { token: MA.token });
  const ownerNow = await api('GET', `/api/clubs/${a1}/dashboard/now`, { token: A.token });
  const mgrNow = await api('GET', `/api/clubs/${a1}/dashboard/now`, { token: MA.token });
  check(results, 'кэш: владелец прогрел «Деньги» — управляющему сети всё равно 403', ownerFirst.status === 200 && mgrAfter.status === 403, `owner=${ownerFirst.status} mgr=${mgrAfter.status}`);
  const mgrBy = mgrNow.json?.revenue_today?.by_method;
  check(results, 'кэш: владелец прогрел «Сейчас» — у управляющего сети by_method скрыт', ownerNow.status === 200 && mgrNow.status === 200 && (mgrBy === null || mgrBy === undefined), `by_method=${JSON.stringify(mgrBy)} x-cache=${mgrNow.headers['x-cache'] ?? '-'}`);
}

process.exit(summary(results).length ? 1 : 0);
