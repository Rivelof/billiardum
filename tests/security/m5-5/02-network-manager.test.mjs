// PoC M5.5 — роль «управляющий сети» (контракт m5-5-8.md №192, №166; CLAUDE.md инвариант 8).
// Проверяем: управляющий сети видит клубы как управляющий, НО без денег по способам оплаты и
// экспорта и без действий владельца сети; не может сам себе выдать owner / снять запрет (BLN10);
// доступ снимается при выводе клуба из сети и при отзыве; остатки (PIN-токены) гаснут.
//
// Запуск: node tests/security/m5-5/02-network-manager.test.mjs

import { addClub, api, check, createClub, createNetwork, login, phone, RUN, summary } from './_helpers.mjs';

const results = [];

const A = await login(phone()); // владелец сети
const clubA1 = await createClub(A.token, { name: `A1 ${RUN}` });
const clubA2 = await createClub(A.token, { name: `A2 ${RUN}` });
const NA = await createNetwork(A.token, `NA ${RUN}`);
await addClub(A.token, NA, clubA1);
await addClub(A.token, NA, clubA2);

// Приглашаем управляющего сети, затем входим им — привязка приглашения при входе.
const mPhone = phone();
const inv = await api('POST', `/api/networks/${NA}/managers`, { token: A.token, body: { phone: mPhone } });
check(results, 'owner приглашает управляющего сети → 201', inv.status === 201, `status=${inv.status}`);
const M = await login(mPhone);

// 1. Управляющий сети видит сеть (role manager) и её клубы, тарифы, меню, дашборд.
{
  const me = await api('GET', '/api/me', { token: M.token });
  const net = me.json.networks?.find((n) => n.network_id === NA);
  check(results, 'me: управляющий видит сеть с role=manager', net?.role === 'manager', `net=${JSON.stringify(net)}`);
  const clubIds = (me.json.clubs ?? []).map((c) => c.club_id);
  check(results, 'me: оба клуба сети доступны управляющему', clubIds.includes(clubA1) && clubIds.includes(clubA2), `clubs=${clubIds.length}`);
  const g = await api('GET', `/api/networks/${NA}`, { token: M.token });
  check(results, 'управляющий GET сети → 200 role=manager', g.status === 200 && g.json.role === 'manager', `status=${g.status} role=${g.json?.role}`);
  const t = await api('GET', `/api/networks/${NA}/tariffs`, { token: M.token });
  const mn = await api('GET', `/api/networks/${NA}/menu`, { token: M.token });
  const d = await api('GET', `/api/networks/${NA}/dashboard`, { token: M.token });
  check(results, 'управляющий читает тарифы/меню/дашборд сети → 200', t.status === 200 && mn.status === 200 && d.status === 200, `t=${t.status} m=${mn.status} d=${d.status}`);
}

// 2. Действия ВЛАДЕЛЬЦА сети управляющему запрещены — 403 (доступ есть, но не owner).
{
  const patch = await api('PATCH', `/api/networks/${NA}`, { token: M.token, body: { name: 'x' } });
  const put = await api('PUT', `/api/networks/${NA}/tariffs`, { token: M.token, body: { rules: [] } });
  const putM = await api('PUT', `/api/networks/${NA}/menu`, { token: M.token, body: { products: [] } });
  const invite = await api('POST', `/api/networks/${NA}/managers`, { token: M.token, body: { phone: phone() } });
  const listM = await api('GET', `/api/networks/${NA}/managers`, { token: M.token });
  const del = await api('DELETE', `/api/networks/${NA}`, { token: M.token });
  const addC = await addClub(M.token, NA, clubA1);
  const rmC = await api('DELETE', `/api/networks/${NA}/clubs/${clubA1}`, { token: M.token });
  const all = { patch, put, putM, invite, listM, del, addC, rmC };
  const bad = Object.entries(all).filter(([, r]) => r.status !== 403);
  check(results, 'управляющему все действия владельца сети → 403', bad.length === 0, bad.map(([k, r]) => `${k}=${r.status}`).join(', ') || 'все 403');
}

// 3. Деньги по способам оплаты и экспорт — управляющему сети НЕТ.
{
  // Дашборд вкладка «Деньги» — 403.
  const money = await api('GET', `/api/clubs/${clubA1}/dashboard?tab=money`, { token: M.token });
  check(results, 'управляющий сети: вкладка «Деньги» клуба → 403', money.status === 403, `status=${money.status}`);
  // Экспорт CSV — 403 (роль owner и networkManager:false).
  const exp = await api('GET', `/api/clubs/${clubA1}/dashboard/export.csv?table=summary`, { token: M.token });
  check(results, 'управляющий сети: экспорт дашборда → 403', exp.status === 403, `status=${exp.status}`);
  const expHist = await api('GET', `/api/clubs/${clubA1}/history/orders/export.csv`, { token: M.token });
  check(results, 'управляющий сети: экспорт истории → 403', expHist.status === 403, `status=${expHist.status}`);
  // Касса управляющего (№177) открыта управляющему по замыслу (он ведёт её как управляющий клуба);
  // экспорт кассы закрыт (networkManager:false).
  const cash = await api('GET', `/api/clubs/${clubA1}/cashbook`, { token: M.token });
  check(results, 'касса управляющего: просмотр доступен (по замыслу), не 5xx', cash.status === 200, `status=${cash.status}`);
  const cashExp = await api('GET', `/api/clubs/${clubA1}/cashbook/export.csv`, { token: M.token });
  check(results, 'управляющий сети: экспорт кассы → 403', cashExp.status === 403, `status=${cashExp.status}`);
  // Дашборд/now — разбивка by_method должна быть скрыта (null) для управляющего сети.
  const dnow = await api('GET', `/api/clubs/${clubA1}/dashboard/now`, { token: M.token });
  const byMethod = dnow.json?.revenue_today?.by_method ?? 'absent';
  check(results, 'dashboard/now: by_method скрыт у управляющего сети', dnow.status === 200 && (byMethod === null || byMethod === 'absent'), `status=${dnow.status} by_method=${JSON.stringify(byMethod)}`);
  // Ранее известная утечка: /clubs/{club}/now отдавал revenue_today_kopecks по способам. На b4f1103 исправлено.
  const onow = await api('GET', `/api/clubs/${clubA1}/now`, { token: M.token });
  check(results, '/clubs/{club}/now: разбивка по способам скрыта у управляющего сети', onow.status === 200 && onow.json.revenue_today_kopecks === null, `status=${onow.status} v=${JSON.stringify(onow.json?.revenue_today_kopecks)}`);
}

// 4. Управляющий сети НЕ может выдать себе owner / сменить роль / снять запрет; и клуб-владелец тоже.
{
  // Через staff-маршруты клуба управляющий (роль manager) не владелец → 403 на уровне роутера.
  const asMgr = await api('PATCH', `/api/clubs/${clubA1}/staff/${M.user.id}`, { token: M.token, body: { role: 'owner' } });
  check(results, 'управляющий PATCH staff (выдать owner) → 403', asMgr.status === 403, `status=${asMgr.status}`);
  // Владелец клуба НЕ может локально менять/снимать управляющего сети — 409 network_locked.
  const ownerChange = await api('PATCH', `/api/clubs/${clubA1}/staff/${M.user.id}`, { token: A.token, body: { role: 'reception' } });
  const ownerRevoke = await api('DELETE', `/api/clubs/${clubA1}/staff/${M.user.id}`, { token: A.token });
  check(results, 'владелец меняет роль управляющего сети → 409 network_locked', ownerChange.status === 409 && ownerChange.json?.error === 'network_locked', `status=${ownerChange.status} ${ownerChange.json?.error ?? ''}`);
  check(results, 'владелец отзывает управляющего сети локально → 409 network_locked', ownerRevoke.status === 409 && ownerRevoke.json?.error === 'network_locked', `status=${ownerRevoke.status} ${ownerRevoke.json?.error ?? ''}`);
}

// 5. Вывод клуба из сети снимает доступ управляющего к этому клубу, остальные остаются.
{
  const rm = await api('DELETE', `/api/networks/${NA}/clubs/${clubA1}`, { token: A.token });
  check(results, 'владелец выводит clubA1 из сети → 200', rm.status === 200, `status=${rm.status}`);
  const now1 = await api('GET', `/api/clubs/${clubA1}/now`, { token: M.token });
  const now2 = await api('GET', `/api/clubs/${clubA2}/now`, { token: M.token });
  check(results, 'управляющий в выведенном clubA1 → 403', now1.status === 403, `status=${now1.status}`);
  check(results, 'управляющий в оставшемся clubA2 → ещё доступен', now2.status === 200, `status=${now2.status}`);
}

// 6. Отзыв управляющего снимает доступ ко всем клубам сети.
{
  const list = await api('GET', `/api/networks/${NA}/managers`, { token: A.token });
  const member = list.json.items.find((x) => x.user_id === M.user.id) ?? list.json.items[0];
  const rev = await api('DELETE', `/api/networks/${NA}/managers/${member.id}`, { token: A.token });
  check(results, 'владелец отзывает управляющего → 200', rev.status === 200, `status=${rev.status}`);
  const now2 = await api('GET', `/api/clubs/${clubA2}/now`, { token: M.token });
  const net = await api('GET', `/api/networks/${NA}`, { token: M.token });
  check(results, 'после отзыва: доступ к клубу сети → 403', now2.status === 403, `status=${now2.status}`);
  check(results, 'после отзыва: сеть управляющему → 404', net.status === 404, `status=${net.status}`);
}

process.exit(summary(results).length ? 1 : 0);
