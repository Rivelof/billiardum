// PoC M5.5 — журнал, ПДн, mass assignment, добавление клуба в сеть с готовым шаблоном.
// Проверяем: действия сети попадают в журнал КАЖДОГО клуба сети (инвариант 2, №191); цепочка хешей
// цела (audit/verify); полный телефон приглашённого нигде не виден (журнал, ответы, текст
// приглашения); лишние поля в телах (owner_user_id, archived_at, role, network_id) игнорируются;
// клуб, добавленный в сеть с жёстким шаблоном, не остаётся «вне шаблона».
//
// Запуск: node tests/security/m5-5/10-audit-pii-mass-assignment.test.mjs

import { addClub, api, check, createClub, createNetwork, login, phone, RUN, summary } from './_helpers.mjs';

const results = [];
const rule = (price, o = {}) => ({ kind: null, days: [1, 2, 3, 4, 5, 6, 7], from: '06:00', to: '06:00', price_per_hour_kopecks: price, min_minutes: 30, step_minutes: 1, ...o });

const A = await login(phone());
const B = await login(phone());
const club1 = await createClub(A.token, { name: `J1 ${RUN}` });
const club2 = await createClub(A.token, { name: `J2 ${RUN}`, timezone: 'Europe/Kaliningrad', city: 'Калининград' });
const club3 = await createClub(A.token, { name: `J3 ${RUN}` });
const NA = await createNetwork(A.token, `NJ ${RUN}`);
await addClub(A.token, NA, club1);
await addClub(A.token, NA, club2);

const audit = async (club, token = A.token) => (await api('GET', `/api/clubs/${club}/audit?limit=200`, { token })).json?.items ?? [];
const actions = (items) => items.map((i) => i.action);

// 1. Действия сети — в журнале каждого клуба.
{
  await api('PUT', `/api/networks/${NA}/tariffs`, { token: A.token, body: { rules: [rule(15000)] } });
  await api('PUT', `/api/networks/${NA}/menu`, { token: A.token, body: { products: [{ name: 'Чай', price_kopecks: 15000 }] } });
  const mPhone = phone();
  const inv = await api('POST', `/api/networks/${NA}/managers`, { token: A.token, body: { phone: mPhone } });
  const M = await login(mPhone);
  for (const [label, c] of [['club1', club1], ['club2 (другой пояс)', club2]]) {
    const a = actions(await audit(c));
    const need = ['network.club_added', 'network.tariffs_applied', 'network.menu_applied', 'network.manager_invited', 'network.manager_added'];
    const miss = need.filter((x) => !a.includes(x));
    check(results, `журнал ${label}: есть записи сети (${need.length})`, miss.length === 0, miss.length ? `нет: ${miss.join(', ')}` : '');
  }
  // Цепочка хешей цела в обоих клубах.
  for (const c of [club1, club2]) {
    const v = await api('GET', `/api/clubs/${c}/audit/verify`, { token: A.token });
    check(results, `цепочка журнала клуба цела после операций сети (${c.slice(0, 8)})`, v.status === 200 && v.json?.ok === true, JSON.stringify(v.json));
  }
  // 2. ПДн: полный телефон не встречается ни в журнале, ни в ответах.
  const digits = mPhone.replace(/\D/g, '');
  const leakIn = {};
  for (const [k, text] of Object.entries({
    audit1: JSON.stringify(await audit(club1)),
    audit2: JSON.stringify(await audit(club2)),
    invite: inv.text,
    managers: (await api('GET', `/api/networks/${NA}/managers`, { token: A.token })).text,
    network: (await api('GET', `/api/networks/${NA}`, { token: A.token })).text,
    staff: (await api('GET', `/api/clubs/${club1}/staff`, { token: A.token })).text,
    me_mgr: (await api('GET', '/api/me', { token: M.token })).text,
  })) {
    if (text.includes(mPhone) || text.replace(/\D/g, '').includes(digits)) leakIn[k] = true;
  }
  // /api/me самого пользователя может содержать его собственный номер — это не утечка.
  delete leakIn.me_mgr;
  check(results, 'полный телефон приглашённого не виден владельцу/журналу/тексту приглашения', Object.keys(leakIn).length === 0, Object.keys(leakIn).join(', ') || 'везде маска');
  // Журнал читает и управляющий сети; у него тоже без телефона.
  const mgrAudit = JSON.stringify((await api('GET', `/api/clubs/${club1}/audit?limit=200`, { token: M.token })).json);
  check(results, 'журнал глазами управляющего сети: без полного телефона', !mgrAudit.includes(mPhone), '');
}

// 3. Mass assignment: лишние поля игнорируются.
{
  const create = await api('POST', '/api/networks', { token: A.token, body: { name: `MA ${RUN}`, owner_user_id: B.user.id, archived_at: '2020-01-01T00:00:00Z', tariffs_template: true, tariffs_version: 99 } });
  check(results, 'POST /networks с owner_user_id чужого: владелец — вызывающий', create.status === 201 && create.json?.role === 'owner' && create.json?.tariffs?.version === 0 && create.json?.tariffs?.template === false, `status=${create.status} role=${create.json?.role} v=${create.json?.tariffs?.version}`);
  const bGet = await api('GET', `/api/networks/${create.json.id}`, { token: B.token });
  check(results, 'чужой пользователь из owner_user_id сетью не завладел (404)', bGet.status === 404, `status=${bGet.status}`);
  const patch = await api('PATCH', `/api/networks/${NA}`, { token: A.token, body: { owner_user_id: B.user.id, archived_at: '2020-01-01T00:00:00Z', tariffs_version: 500, menu_template: false, id: create.json.id } });
  const still = await api('GET', `/api/networks/${NA}`, { token: A.token });
  const bNa = await api('GET', `/api/networks/${NA}`, { token: B.token });
  check(results, 'PATCH сети с owner_user_id/archived_at/version: поля игнорируются', patch.status === 200 && still.status === 200 && bNa.status === 404 && still.json?.tariffs?.version !== 500, `patch=${patch.status} bNa=${bNa.status} v=${still.json?.tariffs?.version}`);
  const inv = await api('POST', `/api/networks/${NA}/managers`, { token: A.token, body: { phone: phone(), role: 'owner', network_id: create.json.id } });
  check(results, 'приглашение с role=owner в теле: управляющий, не владелец', inv.status === 201 && !('role' in (inv.json ?? {})), `status=${inv.status}`);
  const PN = await api('PATCH', `/api/networks/${NA}`, { token: A.token, body: { tariffs_mode: 'hard; drop table', menu_mode: ['hard'] } });
  check(results, 'tariffs_mode/menu_mode вне списка → 400', PN.status === 400, `status=${PN.status}`);
}

// 4. Ограничения на сети: не больше 5 сетей на владельца.
{
  const C = await login(phone());
  const codes = [];
  for (let i = 0; i < 6; i += 1) codes.push((await api('POST', '/api/networks', { token: C.token, body: { name: `L${i} ${RUN}` } })).status);
  check(results, 'шестая сеть владельца → 409 (лимит 5)', codes.slice(0, 5).every((s) => s === 201) && codes[5] === 409, codes.join(','));
}

// 5. Клуб добавлен в сеть после жёсткого шаблона: получает ли шаблон и лежит ли под замком.
{
  await api('PATCH', `/api/networks/${NA}`, { token: A.token, body: { tariffs_mode: 'hard', menu_mode: 'hard' } });
  await api('PUT', `/api/clubs/${club3}/tariffs`, { token: A.token, body: { rules: [rule(5000)] } });
  const add = await addClub(A.token, NA, club3);
  const t3 = await api('GET', `/api/clubs/${club3}/tariffs`, { token: A.token });
  const cat3 = await api('GET', `/api/clubs/${club3}/catalog`, { token: A.token });
  const price = t3.json?.rules?.[0]?.price_per_hour_kopecks;
  const hasTea = (cat3.json?.products ?? []).some((p) => p.name === 'Чай' && p.price_kopecks === 15000);
  const lock = await api('PUT', `/api/clubs/${club3}/tariffs`, { token: A.token, body: { rules: [rule(1)] } });
  check(results, 'клуб, добавленный в жёсткую сеть: тарифы клуба = шаблон сети сразу', add.status === 201 && price === 15000, `add=${add.status} price=${price} (шаблон 15000, свои были 5000)`);
  check(results, 'клуб, добавленный в жёсткую сеть: меню клуба = шаблон сразу', hasTea, `has Чай 150 ₽=${hasTea}`);
  check(results, 'клуб в жёсткой сети под замком (409)', lock.status === 409, `status=${lock.status}`);
}

process.exit(summary(results).length ? 1 : 0);
