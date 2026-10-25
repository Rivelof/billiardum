// PoC M5.5 — изоляция сетей (контракт m5-5-8.md №190; CLAUDE.md инвариант 5).
// Атакующий «Посторонний» и «владелец-сосед»: чужая сеть, чужой клуб, свой клуб во вторую сеть,
// подмена network_id/club_id, клуб, где ты не активный владелец, гонка добавления.
//
// Запуск: node tests/security/m5-5/01-network-isolation.test.mjs
// Каждая строка — утверждение безопасного поведения; FAIL = находка.

import { addClub, api, check, createClub, createNetwork, login, phone, RUN, summary } from './_helpers.mjs';

const results = [];

const A = await login(phone()); // владелец-сосед №1
const B = await login(phone()); // владелец-сосед №2

const clubA1 = await createClub(A.token, { name: `A1 ${RUN}` });
const clubA2 = await createClub(A.token, { name: `A2 ${RUN}` });
const clubB1 = await createClub(B.token, { name: `B1 ${RUN}` });

const NA = await createNetwork(A.token, `NA ${RUN}`);
const NB = await createNetwork(B.token, `NB ${RUN}`);

// A наполняет свою сеть своими клубами.
check(results, 'A добавляет свой clubA1 в NA', (await addClub(A.token, NA, clubA1)).status === 201);
check(results, 'A добавляет свой clubA2 в NA', (await addClub(A.token, NA, clubA2)).status === 201);

// 1. Посторонний (B) не видит чужую сеть NA — 404 (не 403, чтобы не подтверждать существование).
{
  const r = await api('GET', `/api/networks/${NA}`, { token: B.token });
  check(results, 'B GET чужой сети NA → 404', r.status === 404, `status=${r.status}`);
}
// 2. A не видит чужую сеть NB — 404.
{
  const r = await api('GET', `/api/networks/${NB}`, { token: A.token });
  check(results, 'A GET чужой сети NB → 404', r.status === 404, `status=${r.status}`);
}
// 3. B не может менять чужую сеть NA (PATCH, PUT тарифов, приглашение, удаление) — 404.
{
  const patch = await api('PATCH', `/api/networks/${NA}`, { token: B.token, body: { name: 'hacked' } });
  const put = await api('PUT', `/api/networks/${NA}/tariffs`, { token: B.token, body: { rules: [] } });
  const inv = await api('POST', `/api/networks/${NA}/managers`, { token: B.token, body: { phone: phone() } });
  const del = await api('DELETE', `/api/networks/${NA}`, { token: B.token });
  check(results, 'B PATCH чужой NA → 404', patch.status === 404, `status=${patch.status}`);
  check(results, 'B PUT тарифов чужой NA → 404', put.status === 404, `status=${put.status}`);
  check(results, 'B приглашение в чужую NA → 404', inv.status === 404, `status=${inv.status}`);
  check(results, 'B DELETE чужой NA → 404', del.status === 404, `status=${del.status}`);
  // И сеть NA цела.
  const still = await api('GET', `/api/networks/${NA}`, { token: A.token });
  check(results, 'NA цела после попыток B', still.status === 200 && still.json.name === `NA ${RUN}`, `name=${still.json?.name}`);
}
// 4. A не может втянуть ЧУЖОЙ клуб (clubB1) в свою сеть NA — 403 (не владелец клуба).
{
  const r = await addClub(A.token, NA, clubB1);
  check(results, 'A добавляет ЧУЖОЙ clubB1 в NA → 403', r.status === 403, `status=${r.status} ${r.json?.error ?? ''}`);
}
// 5. B не может втянуть свой clubB1 в ЧУЖУЮ сеть NA — 404 (нет доступа к сети).
{
  const r = await addClub(B.token, NA, clubB1);
  check(results, 'B добавляет свой clubB1 в чужую NA → 404', r.status === 404, `status=${r.status}`);
}
// 6. Свой клуб — не больше чем в одной сети: A заводит вторую сеть NA2 и пытается туда clubA1.
{
  const NA2 = await createNetwork(A.token, `NA2 ${RUN}`);
  const r = await addClub(A.token, NA2, clubA1);
  check(results, 'A кладёт свой clubA1 во ВТОРУЮ сеть → 409 club_in_network', r.status === 409 && r.json?.error === 'club_in_network', `status=${r.status} ${r.json?.error ?? ''}`);
}
// 7. Подмена club_id в теле: A (владелец NA) просит добавить clubB1 — должно отвергнуться 403.
//    (идентично п.4, но подчёркивает, что тело не обходит проверку владения.)
{
  const r = await api('POST', `/api/networks/${NA}/clubs`, { token: A.token, body: { club_id: clubB1, network_id: NB } });
  check(results, 'A: подмена club_id/network_id в теле → 403', r.status === 403, `status=${r.status} ${r.json?.error ?? ''}`);
}
// 8. Клуб, где ты не активный владелец: A добавляет несуществующий/рандомный club_id.
{
  const fake = '00000000-0000-4000-8000-0000000000aa';
  const r = await addClub(A.token, NA, fake);
  check(results, 'A добавляет несуществующий клуб → 403', r.status === 403, `status=${r.status}`);
}
// 9. Гонка добавления: A заводит NA3, запускает два addClub(clubA2 уже в NA) в разные сети одновременно.
//    clubA2 уже в NA, поэтому обе должны отразиться как club_in_network; но проверим целостность:
//    clubA2 остаётся ровно в одной сети.
{
  const NA3 = await createNetwork(A.token, `NA3 ${RUN}`);
  const [r1, r2] = await Promise.all([addClub(A.token, NA3, clubA2), addClub(A.token, NA3, clubA2)]);
  const codes = [r1, r2].map((r) => `${r.status}/${r.json?.error ?? ''}`).join(', ');
  // clubA2 уже в NA → обе 409 club_in_network; гонки не создают вторую активную строку.
  check(results, 'Гонка: clubA2 во второй сети обе → 409 club_in_network', r1.status === 409 && r2.status === 409, codes);
  const na = await api('GET', `/api/networks/${NA}`, { token: A.token });
  const na3 = await api('GET', `/api/networks/${NA3}`, { token: A.token });
  const inNA = na.json.clubs.some((c) => c.club_id === clubA2);
  const inNA3 = na3.json.clubs.some((c) => c.club_id === clubA2);
  check(results, 'clubA2 ровно в одной сети (NA), не в NA3', inNA && !inNA3, `inNA=${inNA} inNA3=${inNA3}`);
}
// 10. Повтор добавления своего клуба в ту же сеть идемпотентен (200), не создаёт дубль.
{
  const r = await addClub(A.token, NA, clubA1);
  const na = await api('GET', `/api/networks/${NA}`, { token: A.token });
  const count = na.json.clubs.filter((c) => c.club_id === clubA1).length;
  check(results, 'Повтор addClub своего клуба → 200 и без дубля', (r.status === 200 || r.status === 201) && count === 1, `status=${r.status} count=${count}`);
}

process.exit(summary(results).length ? 1 : 0);
