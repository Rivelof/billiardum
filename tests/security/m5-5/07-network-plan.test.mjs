// PoC M5.5 — подписка «Сеть» (№194, №180, №185).
// Проверяем: владелец не может сам включить план, поменять цену или отметить оплату (маршруты
// платформы закрыты); план действует только у сети из 2+ клубов; управляющий сети не видит счетов
// и не привязывает карту; оператор платформы не меняет цену (только администратор).
//
// Запуск: node tests/security/m5-5/07-network-plan.test.mjs

import { addClub, api, check, createClub, createNetwork, login, phone, RUN, summary } from './_helpers.mjs';

const results = [];
const PLAN_NETWORK = 'bf000000-0000-4000-8000-000000000002'; // константа миграции 1350, не секрет

const A = await login(phone());
const club1 = await createClub(A.token, { name: `P1 ${RUN}` });
const club2 = await createClub(A.token, { name: `P2 ${RUN}` });
const NA = await createNetwork(A.token, `NP ${RUN}`);

// 1. Сеть из одного клуба — план «Сеть» не применяется; из двух — применяется; после вывода — снова нет.
{
  await addClub(A.token, NA, club1);
  const one = await api('GET', `/api/networks/${NA}`, { token: A.token });
  check(results, 'сеть из 1 клуба: plan.applies = false', one.json?.plan?.applies === false, `applies=${one.json?.plan?.applies} price=${one.json?.plan?.price_per_table_kopecks}`);
  await addClub(A.token, NA, club2);
  const two = await api('GET', `/api/networks/${NA}`, { token: A.token });
  check(results, 'сеть из 2 клубов: plan.applies = true', two.json?.plan?.applies === true, `applies=${two.json?.plan?.applies}`);
  await api('DELETE', `/api/networks/${NA}/clubs/${club2}`, { token: A.token });
  const back = await api('GET', `/api/networks/${NA}`, { token: A.token });
  check(results, 'после вывода клуба: plan.applies = false', back.json?.plan?.applies === false, `applies=${back.json?.plan?.applies}`);
  await addClub(A.token, NA, club2);
}

// 2. Владелец не меняет план и цену: маршруты платформы закрыты (личный вход без роли платформы).
{
  const plan = await api('PUT', `/api/platform/plans/${PLAN_NETWORK}`, { token: A.token, body: { price_per_table_kopecks: 1, active: true } });
  const price = await api('PUT', `/api/platform/subscriptions/${club1}/price`, { token: A.token, body: { price_per_table_kopecks: 1, reason: 'poc' } });
  const paid = await api('POST', `/api/platform/subscriptions/${club1}/mark-paid`, { token: A.token, body: { reason: 'poc' } });
  const list = await api('GET', '/api/platform/subscriptions', { token: A.token });
  check(results, 'владелец: PUT плана / цены клуба / mark-paid / список подписок → 403', [plan, price, paid, list].every((r) => r.status === 403), `${plan.status}/${price.status}/${paid.status}/${list.status}`);
  const plans = await api('GET', `/api/networks/${NA}`, { token: A.token });
  check(results, 'цена плана «Сеть» не изменилась (119 000 коп.)', plans.json?.plan?.price_per_table_kopecks === 119000, `price=${plans.json?.plan?.price_per_table_kopecks}`);
}

// 3. Мутации подписки клуба владельцем: нет маршрута смены плана (метод/путь).
{
  const probes = [
    ['PUT', `/api/clubs/${club1}/subscription`, { plan: 'network' }],
    ['PATCH', `/api/clubs/${club1}/subscription`, { plan_id: PLAN_NETWORK }],
    ['POST', `/api/clubs/${club1}/subscription/plan`, { plan_id: PLAN_NETWORK }],
  ];
  const out = [];
  for (const [m, p, b] of probes) {
    const r = await api(m, p, { token: A.token, body: b });
    out.push(`${m} ${p.split('/').slice(-2).join('/')}=${r.status}`);
  }
  check(results, 'владелец: нет маршрута смены плана подписки (404/405)', out.every((s) => /=(404|405)$/.test(s)), out.join(', '));
}

// 4. Управляющий сети: подписка — только состояние; карта, автоплатёж, счета — владельцу.
{
  const mPhone = phone();
  await api('POST', `/api/networks/${NA}/managers`, { token: A.token, body: { phone: mPhone } });
  const M = await login(mPhone);
  const st = await api('GET', `/api/clubs/${club1}/subscription`, { token: M.token });
  const card = await api('POST', `/api/clubs/${club1}/subscription/card`, { token: M.token, body: { email: 'x@example.invalid' } });
  const auto = await api('DELETE', `/api/clubs/${club1}/subscription/autopay`, { token: M.token, body: {} });
  const inv = await api('GET', `/api/clubs/${club1}/subscription/invoices`, { token: M.token });
  check(results, 'управляющий сети: состояние подписки читает (200)', st.status === 200, `status=${st.status}`);
  check(results, 'управляющий сети: карта / автоплатёж / счета → 403', [card, auto, inv].every((r) => r.status === 403), `${card.status}/${auto.status}/${inv.status}`);
  // Тело состояния не должно содержать платёжных данных (карта, токены).
  const txt = JSON.stringify(st.json ?? {});
  check(results, 'состояние подписки не содержит токенов карты / ключей', !/payment_method|card_token|secret|shop_key/i.test(txt), txt.slice(0, 160));
}

// 5. Чужой владелец не видит план/подписку чужого клуба.
{
  const B = await login(phone());
  const r = await api('GET', `/api/clubs/${club1}/subscription`, { token: B.token });
  const n = await api('GET', `/api/networks/${NA}`, { token: B.token });
  check(results, 'посторонний: подписка чужого клуба → 403, сеть → 404', r.status === 403 && n.status === 404, `${r.status}/${n.status}`);
}

process.exit(summary(results).length ? 1 : 0);
