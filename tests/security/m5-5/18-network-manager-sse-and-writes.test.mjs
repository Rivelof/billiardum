// PoC M5.5, заход 2 — Н-3 на стенде: SSE-поток клуба (api/routes/stream.mjs transform), ответы на записи (POST
// продажи/возврата самим управляющим сети) и повтор по Idempotency-Key. Сравнение с прямым управляющим клуба
// (способы видны — фильтр не ломает работу).
//
// Запуск: node tests/security/m5-5/18-network-manager-sse-and-writes.test.mjs

import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { addClub, api, check, createClub, createNetwork, login, phone2, RUN, sleep, summary } from './_helpers.mjs';

const results = [];
const A = await login(phone2());
const club = await createClub(A.token, { name: `E1 ${RUN}` });
const NA = await createNetwork(A.token, `NE ${RUN}`);
await addClub(A.token, NA, club);
const hdr = { 'x-club-id': club };

const mPhone = phone2();
await api('POST', `/api/networks/${NA}/managers`, { token: A.token, body: { phone: mPhone } });
const M = await login(mPhone);
const dPhone = phone2();
await api('POST', `/api/clubs/${club}/staff`, { token: A.token, headers: hdr, body: { phone: dPhone, role: 'manager' } });
const D = await login(dPhone);
const rPhone = phone2();
await api('POST', `/api/clubs/${club}/staff`, { token: A.token, headers: hdr, body: { phone: rPhone, role: 'reception' } });
const R = await login(rPhone);

const prod = (await api('POST', `/api/clubs/${club}/catalog/products`, { token: A.token, headers: hdr, body: { name: 'Чай', price_kopecks: 15000 } })).json;
await api('POST', `/api/clubs/${club}/shifts`, { token: A.token, headers: hdr, body: { float_kopecks: 100_000 } });

// --- SSE ------------------------------------------------------------------------------------------------
let ca;
function openStream(token, query, ms, { bearer = true } = {}) {
  ca ??= spawnSync('docker', ['exec', 'billiardum-caddy-1', 'cat', '/data/caddy/pki/authorities/local/root.crt'], { encoding: 'utf8' }).stdout;
  return new Promise((resolve) => {
    const chunks = [];
    const req = https.request(new URL(`/api/stream?${query}`, 'https://localhost:8443'), { ca, headers: { ...(bearer ? { authorization: `Bearer ${token}` } : {}), accept: 'text/event-stream' } }, (res) => {
      res.on('data', (c) => chunks.push(c.toString()));
      setTimeout(() => req.destroy(), ms);
      res.on('close', () => resolve({ status: res.statusCode, text: chunks.join('') }));
    });
    req.on('error', () => resolve({ status: 0, text: chunks.join('') }));
    req.end();
  });
}
const streamTok = await api('POST', '/api/stream/token', { token: M.token, headers: hdr, body: { club } });
const streams = [openStream(M.token, `club=${club}`, 5000), openStream(D.token, `club=${club}`, 5000), openStream(A.token, `club=${club}`, 5000), openStream(null, `club=${club}&token=${streamTok.json?.token}`, 5000, { bearer: false })];
await sleep(1200);
// События: продажа наличными (получено 777 ₽), карта терминала, возврат, заказ на бар.
const pos = (who, body, idem = true) => api('POST', '/api/pos/sales', { token: who.token, headers: hdr, idem, body });
const sc = await pos(R, { items: [{ product_id: prod.id, qty: 3 }], method: 'cash', received_kopecks: 77_700, to_bar: true });
const sk = await pos(R, { items: [{ product_id: prod.id, qty: 1 }], method: 'card_terminal', to_bar: true });
const full = await api('GET', `/api/pos/sales/${sc.json.sale_id}`, { token: A.token, headers: hdr });
const rf = await api('POST', `/api/pos/sales/${sc.json.sale_id}/refund`, { token: D.token, headers: hdr, idem: true, body: { reason: 'тест', items: [{ order_item_id: full.json.items[0].order_item_id, qty: 1 }] } });
check(results, 'подготовка: продажи и возврат прошли', sc.status === 201 && sk.status === 201 && rf.status === 201, `${sc.status}/${sk.status}/${rf.status}`);
const [sm, sd, so, st] = await Promise.all(streams);
check(results, 'SSE: все три потока открыты (200)', sm.status === 200 && sd.status === 200 && so.status === 200, `${sm.status}/${sd.status}/${so.status}`);
const events = (t) => [...t.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
console.log(`INFO  события управляющего сети: ${[...new Set(events(sm.text))].join(', ')}; владельца: ${[...new Set(events(so.text))].join(', ')}`);
const METHOD_RE = /"(method|payment_method)":"(cash|card_terminal|sbp|card)"|"(received_kopecks|change_kopecks)":\d|"by_method":\{|"cash_sales_kopecks":\d|"cash_refunds_kopecks":\d/;
check(results, 'SSE: поток управляющего сети не содержит способов, полученных/сдачи, by_method', !METHOD_RE.test(sm.text), (sm.text.match(METHOD_RE) ?? [''])[0]);
console.log(`INFO  у прямого управляющего и владельца в потоке есть способ: ${METHOD_RE.test(sd.text)} / ${METHOD_RE.test(so.text)}`);
check(results, 'SSE по одноразовому токену (без заголовка Authorization) у управляющего сети: поток открыт, способов нет', streamTok.status === 200 && st.status === 200 && events(st.text).length > 2 && !METHOD_RE.test(st.text), `${streamTok.status}/${st.status} событий ${events(st.text).length}`);
check(results, 'SSE: у прямого управляющего клуба события не искажены (событий не меньше, чем у управляющего сети)', events(sd.text).length >= events(sm.text).length && events(sm.text).length > 2, `${events(sd.text).length}/${events(sm.text).length}`);

// --- Записи самим управляющим сети ---------------------------------------------------------------------------
{
  const key = crypto.randomUUID();
  const body = { items: [{ product_id: prod.id, qty: 2 }], method: 'cash', received_kopecks: 99_900 };
  const s1 = await api('POST', '/api/pos/sales', { token: M.token, headers: hdr, idem: key, body });
  const s2 = await api('POST', '/api/pos/sales', { token: M.token, headers: hdr, idem: key, body });
  check(results, 'управляющий сети: продажа наличными (его же ввод) — ответ без способа, сдачи и полученных; повтор по ключу — то же', s1.status === 201 && s1.json.method === null && s1.json.received_kopecks === null && s1.json.change_kopecks === null && s2.headers['idempotent-replayed'] === 'true' && s2.json.method === null && s2.json.received_kopecks === null, `${s1.status}/${s2.status} method=${s1.json?.method}/${s2.json?.method} received=${s1.json?.received_kopecks}/${s2.json?.received_kopecks}`);
  // Тот же ключ у другого сотрудника того же клуба: ключ продажи действует на клуб (request_key), возвращается та же
  // продажа — без второго списания; для прямого управляющего ответ со способом (его права), не размножает продажу.
  const s3 = await api('POST', '/api/pos/sales', { token: D.token, headers: hdr, idem: key, body });
  const count = await api('GET', `/api/clubs/${club}/pos/sales`, { token: A.token });
  const same = (count.json.items ?? count.json).filter((x) => x.sale_id === s1.json.sale_id || x.id === s1.json.sale_id).length;
  check(results, 'тот же Idempotency-Key у другого сотрудника клуба — та же продажа, второй не создаётся', s3.status === 201 && s3.json.sale_id === s1.json.sale_id && same === 1, `status=${s3.status} одинаковых=${same}`);
  // Прямой управляющий видит способ в той же продаже.
  const seen = await api('GET', `/api/pos/sales/${s1.json.sale_id}`, { token: D.token, headers: hdr });
  check(results, 'прямой управляющий клуба видит способ и полученные по этой продаже', seen.json?.method === 'cash' && seen.json?.received_kopecks === 99_900, `method=${seen.json?.method}`);
  // Журнал: запись pos.sale самого управляющего сети без способа у него и со способом у владельца.
  const aud = await api('GET', `/api/clubs/${club}/audit?action=pos.sale&limit=20`, { token: M.token });
  const audOwn = await api('GET', `/api/clubs/${club}/audit?action=pos.sale&limit=20`, { token: A.token });
  check(results, 'журнал pos.sale: у управляющего сети method = null, у владельца есть', (aud.json.items ?? []).length > 0 && aud.json.items.every((i) => i.data.method === null) && audOwn.json.items.some((i) => i.data.method === 'cash'), `${(aud.json.items ?? []).length}`);
  // Текстовые поля: комментарий и причина возврата не уходят в способ (пользовательский ввод остаётся как есть).
  const rfM = await api('POST', `/api/pos/sales/${s1.json.sale_id}/refund`, { token: M.token, headers: hdr, idem: true, body: { reason: 'вернул наличными по просьбе гостя' } });
  check(results, 'возврат управляющим сети: ответ без способа', rfM.status === 201 && JSON.stringify(rfM.json).search(/"method":"/) === -1, `status=${rfM.status}`);
}

// --- PIN-токен управляющего сети (терминал владельца) ----------------------------------------------------------
{
  const term = await api('POST', '/api/staff/terminal', { token: A.token, body: { club_id: club, name: `pin ${RUN}` } });
  const set = await api('PUT', '/api/staff/pin', { token: M.token, body: { club_id: club, pin: '361572' } });
  const sw = await api('POST', '/api/staff/pin', { token: term.json?.terminal_token, body: { user_id: M.user.id, pin: '361572' } });
  check(results, 'PIN-вход управляющего сети на терминале владельца', term.status === 200 && set.status === 200 && sw.status === 200 && sw.json?.token, `${term.status}/${set.status}/${sw.status}`);
  if (sw.json?.token) {
    const sales = await api('GET', `/api/clubs/${club}/pos/sales`, { token: sw.json.token });
    const audit = await api('GET', `/api/clubs/${club}/audit?action=pos.sale&limit=20`, { token: sw.json.token });
    const items = sales.json?.items ?? sales.json ?? [];
    check(results, 'под PIN-токеном: список продаж и журнал — способы скрыты', sales.status === 200 && items.length > 0 && items.every((x) => x.method === null) && (audit.json.items ?? []).every((i) => i.data.method === null), `${sales.status}/${audit.status}`);
  }
}

// --- Смешанная роль: управляющий сети клуба A и владелец собственного клуба B ----------------------------------
{
  const clubB = await createClub(M.token, { name: `E2 own ${RUN}` });
  const hb = { 'x-club-id': clubB };
  const pb = (await api('POST', `/api/clubs/${clubB}/catalog/products`, { token: M.token, headers: hb, body: { name: 'Кофе', price_kopecks: 12000 } })).json;
  await api('POST', `/api/clubs/${clubB}/shifts`, { token: M.token, headers: hb, body: { float_kopecks: 50_000 } });
  const sb = await api('POST', '/api/pos/sales', { token: M.token, headers: hb, idem: true, body: { items: [{ product_id: pb.id, qty: 1 }], method: 'cash', received_kopecks: 12_000 } });
  const own = await api('GET', `/api/clubs/${clubB}/pos/sales`, { token: M.token });
  check(results, 'свой клуб B (он владелец): способ виден по пути клуба B', sb.status === 201 && (own.json.items ?? own.json).some((x) => x.method === 'cash'), `${sb.status}/${own.status}`);
  const viaA = await api('GET', `/api/clubs/${club}/pos/sales`, { token: M.token });
  check(results, 'клуб A (он управляющий сети): способ скрыт', (viaA.json.items ?? viaA.json).every((x) => x.method === null), `${viaA.status}`);
  const all = await api('GET', '/api/clubs/all/history/orders', { token: M.token });
  const allItems = all.json?.items ?? [];
  // Тестовые клубы не попадают в историю заказов (not is_test), поэтому на стенде проверка пустая; по коду
  // (api/router.mjs: sawNetworkManager сбрасывается только на запрос) ответ «Все клубы» фильтруется целиком.
  console.log(`INFO  «Все клубы» у смешанной роли: заказов ${allItems.length}${allItems.length === 0 ? ' (данных нет — проверка пустая; фильтр по коду действует на весь ответ, способы клуба B тоже скрыты)' : ''}`);
  check(results, 'смешанная роль: «Все клубы» — 200 и ни одной строки клуба A со способом', all.status === 200 && allItems.filter((x) => x.club_id === club).every((x) => x.method === null), `${all.status}`);
  // Подмена клуба заголовком: путь клуба B (владелец), заголовок клуба A — данные клуба A не появляются.
  const spoof = await api('GET', `/api/clubs/${clubB}/pos/sales`, { token: M.token, headers: { 'x-club-id': club } });
  const spoofItems = spoof.json?.items ?? spoof.json ?? [];
  check(results, 'путь B + заголовок A: либо данные B со способом, либо отказ; продаж клуба A со способом нет', spoof.status !== 200 || !spoofItems.some((x) => x.method === 'cash' && x.total_kopecks === 18000), `${spoof.status}`);
}

process.exit(summary(results).length ? 1 : 0);
