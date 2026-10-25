// PoC M5.5 — управляющий сети и терминал/PIN (контракт №192; staff/index.mjs:156-171).
// Гипотеза H1: управляющий сети заводит терминал клуба (POST /api/staff/terminal, роль manager).
// Обычный отзыв сотрудника гасит терминалы, заведённые им (staff.revoke). Отзыв управляющего сети
// и вывод клуба из сети (bl.network_sync_access) гасят только PIN-токены, но не терминалы —
// терминал остаётся рабочим у человека, которого в клубе больше нет.
//
// Также: PIN-вход управляющего сети не открывает маршруты сети и не снимает запрет на экспорт.
//
// Запуск: node tests/security/m5-5/03-manager-terminal-pin.test.mjs

import { addClub, api, check, createClub, createNetwork, login, phone, RUN, summary } from './_helpers.mjs';

const results = [];

const A = await login(phone());
const club1 = await createClub(A.token, { name: `T1 ${RUN}` });
const club2 = await createClub(A.token, { name: `T2 ${RUN}` });
const NA = await createNetwork(A.token, `NT ${RUN}`);
await addClub(A.token, NA, club1);
await addClub(A.token, NA, club2);

const mPhone = phone();
await api('POST', `/api/networks/${NA}/managers`, { token: A.token, body: { phone: mPhone } });
const M = await login(mPhone);

// 1. Управляющий сети заводит терминал в каждом клубе сети.
const t1 = await api('POST', '/api/staff/terminal', { token: M.token, body: { club_id: club1, name: `term1 ${RUN}` } });
const t2 = await api('POST', '/api/staff/terminal', { token: M.token, body: { club_id: club2, name: `term2 ${RUN}` } });
check(results, 'управляющий сети заводит терминал в club1 (роль manager)', t1.status === 200 && t1.json?.terminal_token, `status=${t1.status}`);
check(results, 'управляющий сети заводит терминал в club2', t2.status === 200 && t2.json?.terminal_token, `status=${t2.status}`);
const term1 = t1.json?.terminal_token;
const term2 = t2.json?.terminal_token;

// 2. Терминал работает: список сотрудников клуба (user_id, имена, маска телефона).
const before = await api('GET', '/api/staff/terminal', { token: term1 });
check(results, 'терминал club1 работает до отзыва', before.status === 200 && Array.isArray(before.json?.staff), `status=${before.status} staff=${before.json?.staff?.length}`);

// 3. PIN-вход управляющего сети: PIN-токен не открывает маршруты сети (нужен личный вход).
{
  const set = await api('PUT', '/api/staff/pin', { token: M.token, body: { club_id: club1, pin: '482916' } });
  check(results, 'управляющий сети задаёт PIN (6 цифр)', set.status === 200, `status=${set.status}`);
  const sw = await api('POST', '/api/staff/pin', { token: term1, body: { user_id: M.user.id, pin: '482916' } });
  check(results, 'PIN-вход управляющего сети на терминале → 200', sw.status === 200 && sw.json?.token, `status=${sw.status} role=${sw.json?.role}`);
  const pinTok = sw.json?.token;
  if (pinTok) {
    const nets = await api('GET', '/api/networks', { token: pinTok });
    const net = await api('GET', `/api/networks/${NA}`, { token: pinTok });
    const tpl = await api('GET', `/api/networks/${NA}/tariffs`, { token: pinTok });
    const dash = await api('GET', `/api/networks/${NA}/dashboard`, { token: pinTok });
    check(results, 'PIN-токен: /api/networks → 403', nets.status === 403, `status=${nets.status}`);
    check(results, 'PIN-токен: GET сети → 403', net.status === 403, `status=${net.status}`);
    check(results, 'PIN-токен: тарифы сети → 403', tpl.status === 403, `status=${tpl.status}`);
    check(results, 'PIN-токен: вкладка «Сеть» → 403', dash.status === 403, `status=${dash.status}`);
    const me = await api('GET', '/api/me', { token: pinTok });
    check(results, 'PIN-токен: /api/me не раскрывает сети', me.status === 200 && (me.json.networks ?? []).length === 0, `networks=${me.json?.networks?.length}`);
    // Экспорт и деньги под PIN-токеном — всё равно 403 (networkManager определяется по членству).
    const exp = await api('GET', `/api/clubs/${club1}/dashboard/export.csv?table=summary`, { token: pinTok });
    const money = await api('GET', `/api/clubs/${club1}/dashboard?tab=money`, { token: pinTok });
    check(results, 'PIN-токен управляющего сети: экспорт → 403', exp.status === 403, `status=${exp.status}`);
    check(results, 'PIN-токен управляющего сети: «Деньги» → 403', money.status === 403, `status=${money.status}`);
    // PIN-токен в чужом клубе сети (club2): токен привязан к терминалу club1.
    const other = await api('GET', `/api/clubs/${club2}/now`, { token: pinTok });
    check(results, 'PIN-токен club1 в club2 сети → 403', other.status === 403, `status=${other.status}`);
    globalThis.__pin = pinTok;
  }
}

// 4. Владелец выводит club1 из сети: PIN-токен гаснет (заявлено), терминал?
{
  const rm = await api('DELETE', `/api/networks/${NA}/clubs/${club1}`, { token: A.token });
  check(results, 'владелец выводит club1 из сети', rm.status === 200, `status=${rm.status}`);
  const pinTok = globalThis.__pin;
  if (pinTok) {
    const r = await api('GET', `/api/clubs/${club1}/now`, { token: pinTok });
    check(results, 'после вывода клуба: PIN-токен управляющего → 401/403', r.status === 401 || r.status === 403, `status=${r.status}`);
  }
  const after = await api('GET', '/api/staff/terminal', { token: term1 });
  check(
    results,
    'H1: терминал, заведённый управляющим сети, погашен после вывода клуба из сети',
    after.status === 401 || after.status === 403,
    after.status === 200 ? `НАХОДКА: терминал жив (200), staff=${JSON.stringify(after.json?.staff?.map((s) => s.name))}` : `status=${after.status}`,
  );
}

// 5. Владелец отзывает управляющего: терминал в club2 (заведён им же) жив?
{
  const list = await api('GET', `/api/networks/${NA}/managers`, { token: A.token });
  const member = list.json.items.find((x) => x.user_id === M.user.id);
  const rev = await api('DELETE', `/api/networks/${NA}/managers/${member.id}`, { token: A.token });
  check(results, 'владелец отзывает управляющего сети', rev.status === 200, `status=${rev.status}`);
  const after = await api('GET', '/api/staff/terminal', { token: term2 });
  check(
    results,
    'H1: терминал, заведённый управляющим сети, погашен после отзыва управляющего',
    after.status === 401 || after.status === 403,
    after.status === 200 ? 'НАХОДКА: терминал жив (200) у отозванного управляющего' : `status=${after.status}`,
  );
  // Контроль: терминал не даёт денежных действий без PIN. Что умеет терминал без PIN-токена?
  const sw = await api('POST', '/api/staff/pin', { token: term2, body: { user_id: M.user.id, pin: '482916' } });
  check(results, 'отозванный управляющий не входит по PIN (членство погашено)', sw.status === 401, `status=${sw.status}`);
}

process.exit(summary(results).length ? 1 : 0);
