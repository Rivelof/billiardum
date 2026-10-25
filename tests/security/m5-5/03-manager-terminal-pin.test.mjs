// PoC M5.5 — управляющий сети и терминал/PIN (контракт №192; №218). Заход 2: после исправления (bc51e24).
// Н-2 (заход 1): управляющий сети заводил терминал клуба (365 дней), который переживал вывод клуба и отзыв.
// Теперь: POST /api/staff/terminal управляющему сети — 403 (api/routes/auth.mjs:469, networkManager: false);
// прямой терминал владельца и управляющего клуба не затрагивается операциями сети; PIN-вход управляющего сети
// на терминале владельца не открывает маршруты сети и гаснет вместе с доступом.
// Терминал, выданный до исправления (строка в базе), проверяется на своём Postgres: 17-network-terminals-db.test.mjs.
//
// Запуск: node tests/security/m5-5/03-manager-terminal-pin.test.mjs

import { addClub, api, check, createClub, createNetwork, login, phone2, RUN, summary } from './_helpers.mjs';

const results = [];

const A = await login(phone2());
const club1 = await createClub(A.token, { name: `T1 ${RUN}` });
const club2 = await createClub(A.token, { name: `T2 ${RUN}` });
const club3 = await createClub(A.token, { name: `T3 ${RUN}` }); // вне сети
const NA = await createNetwork(A.token, `NT ${RUN}`);
await addClub(A.token, NA, club1);
await addClub(A.token, NA, club2);

const mPhone = phone2();
await api('POST', `/api/networks/${NA}/managers`, { token: A.token, body: { phone: mPhone } });
let M = await login(mPhone);

// 0. Прямой управляющий club1 и управляющий сети, который одновременно прямой управляющий club3.
const dPhone = phone2();
await api('POST', `/api/clubs/${club1}/staff`, { token: A.token, headers: { 'x-club-id': club1 }, body: { phone: dPhone, role: 'manager' } });
const D = await login(dPhone);
await api('POST', `/api/clubs/${club3}/staff`, { token: A.token, headers: { 'x-club-id': club3 }, body: { phone: mPhone, role: 'manager' } });
M = await login(mPhone); // повторный вход принимает приглашение прямого управляющего club3

// 1. Управляющий сети терминал в клубах сети не заводит — ни прямым телом, ни подменой клуба.
const attempts = [
  ['club1 в теле', { token: M.token, body: { club_id: club1, name: 'x' } }],
  ['club2 в теле', { token: M.token, body: { club_id: club2, name: 'x' } }],
  ['club1 в теле заглавными', { token: M.token, body: { club_id: club1.toUpperCase(), name: 'x' } }],
  ['club1 в теле, заголовок club2', { token: M.token, headers: { 'x-club-id': club2 }, body: { club_id: club1, name: 'x' } }],
  ['без club_id, заголовок club1', { token: M.token, headers: { 'x-club-id': club1 }, body: { name: 'x' } }],
  ['без club_id и заголовка (у пользователя несколько клубов)', { token: M.token, body: { name: 'x' } }],
];
const odd = [];
for (const [label, opts] of attempts) {
  const r = await api('POST', '/api/staff/terminal', opts);
  if (r.status === 200 && r.json?.terminal_token) odd.push(`${label}→200 ТЕРМИНАЛ ВЫДАН`);
  else if (r.status !== 403 && r.status !== 400) odd.push(`${label}→${r.status}`);
}
check(results, 'управляющий сети: терминал в club1/club2 не заводится (403/400, токен не выдан)', odd.length === 0, odd.join('; ') || attempts.length + ' попыток');
const direct403 = await api('POST', '/api/staff/terminal', { token: M.token, body: { club_id: club1, name: 'x' } });
check(results, 'управляющий сети: club1 в теле → именно 403', direct403.status === 403, `status=${direct403.status} ${direct403.json?.error}`);

// Терминал в club3, где он прямой управляющий, — можно (прямой доступ не затронут).
const own3 = await api('POST', '/api/staff/terminal', { token: M.token, body: { club_id: club3, name: `прямой ${RUN}` } });
check(results, 'он же в club3 (прямой управляющий, не сеть) → терминал выдан', own3.status === 200 && own3.json?.terminal_token, `status=${own3.status}`);
// Подмена: заголовок club3 при club_id club1 в теле — терминал должен попасть не в club1.
const mix = await api('POST', '/api/staff/terminal', { token: M.token, headers: { 'x-club-id': club3 }, body: { club_id: club1, name: 'mix' } });
if (mix.status === 200) {
  const list = await api('GET', '/api/staff/terminal', { token: mix.json.terminal_token });
  check(results, 'подмена: заголовок club3 + club_id club1 — терминал выдан не в club1', list.status === 200 && list.json?.club_id !== club1, `club=${list.json?.club_id} (club1=${club1}, club3=${club3})`);
} else {
  check(results, 'подмена: заголовок club3 + club_id club1 → отказ', mix.status === 403 || mix.status === 400, `status=${mix.status}`);
}

// 2. Терминал владельца в club2 и прямого управляющего в club1; на терминале владельца — PIN-вход управляющего сети.
const ownerTerm = await api('POST', '/api/staff/terminal', { token: A.token, body: { club_id: club2, name: `owner ${RUN}` } });
const directTerm = await api('POST', '/api/staff/terminal', { token: D.token, body: { club_id: club1, name: `direct ${RUN}` } });
check(results, 'владелец (club2) и прямой управляющий (club1) заводят терминалы', ownerTerm.status === 200 && directTerm.status === 200, `${ownerTerm.status}/${directTerm.status}`);
const tOwner = ownerTerm.json?.terminal_token;
const tDirect = directTerm.json?.terminal_token;

{
  const set = await api('PUT', '/api/staff/pin', { token: M.token, body: { club_id: club2, pin: '482916' } });
  check(results, 'управляющий сети задаёт PIN в club2', set.status === 200, `status=${set.status}`);
  const sw = await api('POST', '/api/staff/pin', { token: tOwner, body: { user_id: M.user.id, pin: '482916' } });
  check(results, 'PIN-вход управляющего сети на терминале владельца → 200', sw.status === 200 && sw.json?.token, `status=${sw.status} role=${sw.json?.role}`);
  const pinTok = sw.json?.token;
  if (pinTok) {
    const nets = await api('GET', '/api/networks', { token: pinTok });
    const net = await api('GET', `/api/networks/${NA}`, { token: pinTok });
    const tpl = await api('GET', `/api/networks/${NA}/tariffs`, { token: pinTok });
    const dash = await api('GET', `/api/networks/${NA}/dashboard`, { token: pinTok });
    check(results, 'PIN-токен: /api/networks, сеть, тарифы сети, «Сеть» → 403', [nets, net, tpl, dash].every((r) => r.status === 403), [nets, net, tpl, dash].map((r) => r.status).join('/'));
    const me = await api('GET', '/api/me', { token: pinTok });
    check(results, 'PIN-токен: /api/me не раскрывает сети', me.status === 200 && (me.json.networks ?? []).length === 0, `networks=${me.json?.networks?.length}`);
    const exp = await api('GET', `/api/clubs/${club2}/dashboard/export.csv?table=summary`, { token: pinTok });
    const money = await api('GET', `/api/clubs/${club2}/dashboard?tab=money`, { token: pinTok });
    check(results, 'PIN-токен управляющего сети: экспорт и «Деньги» → 403', exp.status === 403 && money.status === 403, `${exp.status}/${money.status}`);
    // Терминал нового образца: PIN-токен не заводит новый терминал (нужен личный вход).
    const reg = await api('POST', '/api/staff/terminal', { token: pinTok, body: { club_id: club2, name: 'pin-made' } });
    check(results, 'PIN-токен управляющего сети не заводит терминал', reg.status === 403 || reg.status === 401, `status=${reg.status}`);
    globalThis.__pin = pinTok;
  }
}

// 3. Вывод club2 из сети: PIN-токен управляющего сети гаснет; терминал владельца жив; прямой терминал club1 жив.
{
  const rm = await api('DELETE', `/api/networks/${NA}/clubs/${club2}`, { token: A.token });
  check(results, 'владелец выводит club2 из сети', rm.status === 200, `status=${rm.status}`);
  const pinTok = globalThis.__pin;
  if (pinTok) {
    const r = await api('GET', `/api/clubs/${club2}/now`, { token: pinTok });
    check(results, 'после вывода клуба: PIN-токен управляющего сети → 401/403', r.status === 401 || r.status === 403, `status=${r.status}`);
  }
  const own = await api('GET', '/api/staff/terminal', { token: tOwner });
  check(results, 'терминал владельца в club2 после вывода клуба жив (не затронут)', own.status === 200, `status=${own.status}`);
  const dir = await api('GET', '/api/staff/terminal', { token: tDirect });
  check(results, 'прямой терминал управляющего club1 жив', dir.status === 200, `status=${dir.status}`);
}

// 4. Отзыв управляющего сети: прямые терминалы живы; его личный прямой терминал в club3 жив (прямое членство).
{
  const list = await api('GET', `/api/networks/${NA}/managers`, { token: A.token });
  const member = list.json.items.find((x) => x.user_id === M.user.id);
  const rev = await api('DELETE', `/api/networks/${NA}/managers/${member.id}`, { token: A.token });
  check(results, 'владелец отзывает управляющего сети', rev.status === 200, `status=${rev.status}`);
  const dir = await api('GET', '/api/staff/terminal', { token: tDirect });
  check(results, 'после отзыва: прямой терминал club1 жив', dir.status === 200, `status=${dir.status}`);
  const own = await api('GET', '/api/staff/terminal', { token: tOwner });
  check(results, 'после отзыва: терминал владельца жив', own.status === 200, `status=${own.status}`);
  if (own3.json?.terminal_token) {
    const t3 = await api('GET', '/api/staff/terminal', { token: own3.json.terminal_token });
    check(results, 'после отзыва: терминал в club3 (прямое членство того же человека) жив', t3.status === 200, `status=${t3.status}`);
  }
  const sw = await api('POST', '/api/staff/pin', { token: tDirect, body: { user_id: M.user.id, pin: '482916' } });
  check(results, 'отозванный управляющий сети не входит по PIN в club1 (членство погашено)', sw.status === 401 || sw.status === 403, `status=${sw.status}`);
  // Тот же человек в club3 (прямой управляющий) PIN в club3 ещё может иметь — не проверяем: это прямой доступ.
}

process.exit(summary(results).length ? 1 : 0);
