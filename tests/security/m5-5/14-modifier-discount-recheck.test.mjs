// PoC M5.5, заход 2 — Н-1 «скидка через модификатор с отрицательной надбавкой» после bc51e24 (№217).
// Проверяется на стенде https://localhost:8443: отрицательная надбавка при создании группы, модификатора, правке
// (в том числе обходные формы числа); привязка групп к товару жёсткого шаблона; остальные пути к цене строки:
// количество, цена товара, лишние поля позиции, скидка кассы, возвраты, ручные позиции, чужая группа.
// Старые данные с отрицательной надбавкой (нужен прямой UPDATE) — в 15-modifier-old-data.test.mjs на своём Postgres.
//
// Раздел 5 воспроизводит ОСТАТОЧНОЕ замечание (низкая): в жёстком меню замок закрывает привязку групп, но не правку групп,
// привязанных до включения жёсткого режима, — надбавка вверх поднимает цену товара шаблона (150 → 550 ₽). Падает, пока
// замечание не закрыто; остальные 41 проверка зелёные.
//
// Запуск: node tests/security/m5-5/14-modifier-discount-recheck.test.mjs

import { addClub, api, check, createClub, createNetwork, login, phone2, RUN, summary } from './_helpers.mjs';

const results = [];
const A = await login(phone2());
const club = await createClub(A.token, { name: `R2-mod ${RUN}` });
const hdr = { 'x-club-id': club };
const own = (method, path, body, extra = {}) => api(method, path, { token: A.token, body, headers: hdr, ...extra });

// Сотрудники: управляющий и ресепшн клуба.
const mPhone = phone2();
const rPhone = phone2();
await own('POST', `/api/clubs/${club}/staff`, { phone: mPhone, role: 'manager' });
await own('POST', `/api/clubs/${club}/staff`, { phone: rPhone, role: 'reception' });
const M = await login(mPhone);
const R = await login(rPhone);
const mgr = (method, path, body, extra = {}) => api(method, path, { token: M.token, body, headers: hdr, ...extra });
const rec = (method, path, body, extra = {}) => api(method, path, { token: R.token, body, headers: hdr, ...extra });

const tea = (await mgr('POST', `/api/clubs/${club}/catalog/products`, { name: 'Чай', price_kopecks: 15000 })).json;
const cake = (await mgr('POST', `/api/clubs/${club}/catalog/products`, { name: 'Пирог', price_kopecks: 20000 })).json;
check(results, 'подготовка: товары созданы', Boolean(tea?.id && cake?.id), `${tea?.id}`);

// --- 1. Создание группы: отрицательные и обходные формы числа -----------------------------------------
const badDeltas = [-1, -14000, -10_000_000, -10_000_001, -0.5, 1.5, '-5', '−5', '5', null, true, [], {}, 1e21, -1e21, 10_000_001, Number.MAX_SAFE_INTEGER + 2];
const odd = [];
for (const d of badDeltas) {
  const r = await mgr('POST', `/api/clubs/${club}/catalog/modifier-groups`, { name: 'Акция', modifiers: [{ name: 'Х', price_delta_kopecks: d }] });
  if (r.status !== 400) odd.push(`${JSON.stringify(d)}→${r.status}`);
}
check(results, 'создание группы: 18 неверных надбавок (отрицательные, дробные, строки, null) → 400', odd.length === 0, odd.join('; '));
// сырой JSON: -0, 1E+2, -1e-0 (текстовые формы, которые JSON.stringify не выдаст)
let rawCa;
async function rawPost(path, rawBody, token = M.token) {
  const { default: https } = await import('node:https');
  const { spawnSync } = await import('node:child_process');
  rawCa ??= spawnSync('docker', ['exec', 'billiardum-caddy-1', 'cat', '/data/caddy/pki/authorities/local/root.crt'], { encoding: 'utf8' }).stdout;
  const ca = rawCa;
  return new Promise((resolve, reject) => {
    const req = https.request(new URL(path, 'https://localhost:8443'), { method: 'POST', ca, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-club-id': club, 'content-length': Buffer.byteLength(rawBody) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(rawBody);
  });
}
const rawForms = [['-1e0', 400], ['-0.0000001', 400], ['-1E+0', 400], ['-0', 201], ['-100e-2', 400], ['0.9e0', 400], ['1e2', 201], ['-9e0', 400], ['--1', 400], ['+-1', 400], ['-１', 400]];
const rawOdd = [];
for (const [f, expect] of rawForms) {
  const r = await rawPost(`/api/clubs/${club}/catalog/modifier-groups`, `{"name":"Акция","modifiers":[{"name":"Х","price_delta_kopecks":${f}}]}`);
  if (r.status !== expect) rawOdd.push(`${f}→${r.status} (ждали ${expect})`);
}
check(results, 'создание группы: числа в экспоненте и «-0» — отрицательное значение не проходит, -0 и 1e2 нормализуются', rawOdd.length === 0, rawOdd.join('; '));
// Массив: один положительный и один отрицательный — группа не создаётся.
const mix = await mgr('POST', `/api/clubs/${club}/catalog/modifier-groups`, { name: 'Смесь', modifiers: [{ name: 'А', price_delta_kopecks: 100 }, { name: 'Б', price_delta_kopecks: -100 }] });
const cat1 = (await mgr('GET', `/api/clubs/${club}/catalog`)).json;
check(results, 'группа с модификаторами [+100, −100] → 400 и не создаётся (атомарно)', mix.status === 400 && !cat1.modifier_groups.some((g) => g.name === 'Смесь'), `status=${mix.status}`);
// -0 хранится как 0.
const zero = cat1.modifier_groups.filter((g) => g.name === 'Акция').flatMap((g) => g.modifiers.map((m) => m.price_delta_kopecks));
check(results, 'в созданных группах «Акция» нет надбавок меньше 0', zero.every((v) => v >= 0), JSON.stringify(zero));

// --- 2. Модификатор в существующей группе и правка ---------------------------------------------------
const grp = (await mgr('POST', `/api/clubs/${club}/catalog/modifier-groups`, { name: 'Добавки', min_select: 0, max_select: 2, modifiers: [{ name: 'Лимон', price_delta_kopecks: 0 }, { name: 'Сироп', price_delta_kopecks: 3000 }] })).json;
const [lemon, syrup] = grp.modifiers;
const addNeg = await mgr('POST', `/api/catalog/modifier-groups/${grp.id}/modifiers`, { name: 'Скидка', price_delta_kopecks: -1 });
check(results, 'POST модификатора с надбавкой −1 → 400', addNeg.status === 400, `status=${addNeg.status}`);
const patchNeg = await mgr('PATCH', `/api/catalog/modifiers/${syrup.id}`, { price_delta_kopecks: -3000 });
check(results, 'PATCH надбавки в −3000 → 400', patchNeg.status === 400, `status=${patchNeg.status}`);
const patchStr = await mgr('PATCH', `/api/catalog/modifiers/${syrup.id}`, { price_delta_kopecks: '-3000' });
check(results, 'PATCH надбавки строкой «-3000» → 400', patchStr.status === 400, `status=${patchStr.status}`);
const stay = (await mgr('GET', `/api/clubs/${club}/catalog`)).json.modifier_groups.find((g) => g.id === grp.id).modifiers;
check(results, 'после отказов надбавки не изменились (0 и 3000)', stay.find((m) => m.id === lemon.id).price_delta_kopecks === 0 && stay.find((m) => m.id === syrup.id).price_delta_kopecks === 3000, JSON.stringify(stay.map((m) => m.price_delta_kopecks)));
// Лишние ключи с похожим смыслом не меняют цену.
const alias = await mgr('PATCH', `/api/catalog/modifiers/${syrup.id}`, { price_delta: -3000, delta_kopecks: -3000, price_kopecks: -3000, discount_kopecks: 3000, name: 'Сироп' });
const stay2 = (await mgr('GET', `/api/clubs/${club}/catalog`)).json.modifier_groups.find((g) => g.id === grp.id).modifiers.find((m) => m.id === syrup.id);
check(results, 'лишние ключи price_delta/delta_kopecks игнорируются: надбавка 3000', stay2.price_delta_kopecks === 3000, `status=${alias.status}`);
// Ресепшн модификаторы не правит.
const recPatch = await rec('PATCH', `/api/catalog/modifiers/${syrup.id}`, { price_delta_kopecks: 0 });
check(results, 'ресепшн не правит модификатор → 403', recPatch.status === 403, `status=${recPatch.status}`);

// Привязка группы к товару и продажа: цена = цена + надбавки, скидки нет.
const link = await mgr('PATCH', `/api/catalog/products/${tea.id}`, { modifier_group_ids: [grp.id] });
check(results, 'привязка группы к своему товару → 200', link.status === 200, `status=${link.status}`);
const shift = await mgr('POST', `/api/clubs/${club}/shifts`, { float_kopecks: 100_000 });
check(results, 'смена открыта', shift.status === 201, `status=${shift.status} ${shift.json?.error ?? ''}`);
const sale1 = await rec('POST', '/api/pos/sales', { items: [{ product_id: tea.id, qty: 1, modifier_ids: [syrup.id, lemon.id] }], method: 'cash', received_kopecks: 18000 }, { idem: true });
check(results, 'продажа чая с «Сироп» (+30 ₽): 180 ₽, discount_kopecks 0', sale1.status === 201 && sale1.json.total_kopecks === 18000 && sale1.json.discount_kopecks === 0, `status=${sale1.status} total=${sale1.json?.total_kopecks}`);

// --- 3. Остальные пути к цене строки -------------------------------------------------------------------
const qtyBad = [0, -1, 1.5, '2', null, 101, 1e21, NaN, true];
const qOdd = [];
for (const q of qtyBad) {
  const r = await rec('POST', '/api/pos/sales', { items: [{ product_id: tea.id, qty: q }], method: 'cash', received_kopecks: 1_000_000 }, { idem: true });
  if (r.status !== 400) qOdd.push(`${JSON.stringify(q)}→${r.status}`);
}
check(results, 'количество 0/−1/1.5/«2»/null/101/1e21/true → 400', qOdd.length === 0, qOdd.join('; '));
// Лишние поля позиции и продажи не влияют на цену.
const extra = await rec('POST', '/api/pos/sales', { items: [{ product_id: tea.id, qty: 1, price_kopecks: 1, unit_price_kopecks: 1, amount_kopecks: 1, discount_kopecks: 14999, name: 'Бесплатно' }], total_kopecks: 1, bar_total_kopecks: 1, discount_kopecks: 14999, method: 'cash', received_kopecks: 15000 }, { idem: true });
check(results, 'лишние поля price/amount/discount в позиции и продаже игнорируются: 150 ₽', extra.status === 201 && extra.json.total_kopecks === 15000 && extra.json.discount_kopecks === 0, `status=${extra.status} total=${extra.json?.total_kopecks} disc=${extra.json?.discount_kopecks}`);
// Ручные позиции кассы: неизвестные виды и «свободная» позиция.
const kinds = [];
for (const it of [{ kind: 'custom', name: 'Услуга', price_kopecks: 1, qty: 1 }, { kind: 'manual', amount_kopecks: 1 }, { kind: 'free', product_id: tea.id, qty: 1 }, { name: 'Ручная', price_kopecks: 100, qty: 1 }, { kind: 'product', product_id: tea.id, qty: 1, price_kopecks: -5 }]) {
  const r = await rec('POST', '/api/pos/sales', { items: [it], method: 'cash', received_kopecks: 100_000 }, { idem: true });
  kinds.push(`${it.kind ?? '—'}:${r.status}${r.status === 201 ? `:${r.json.total_kopecks}` : ''}`);
}
check(results, 'ручные позиции кассы (custom/manual/free/без product_id) → 400; product с лишней ценой → 150 ₽', kinds.slice(0, 4).every((k) => k.endsWith(':400')) && kinds[4] === 'product:201:15000', kinds.join(' '));
// Цена товара: 0, минус, дробь.
const priceOdd = [];
for (const p of [0, -1, 0.5, '100', null]) {
  const r = await mgr('PATCH', `/api/catalog/products/${cake.id}`, { price_kopecks: p });
  if (r.status !== 400) priceOdd.push(`PATCH ${JSON.stringify(p)}→${r.status}`);
  const c = await mgr('POST', `/api/clubs/${club}/catalog/products`, { name: `Дёшево ${RUN}`, price_kopecks: p });
  if (c.status !== 400) priceOdd.push(`POST ${JSON.stringify(p)}→${c.status}`);
}
check(results, 'цена товара 0/−1/0.5/«100»/null при создании и правке → 400', priceOdd.length === 0, priceOdd.join('; '));

// Скидка кассы: границы и права.
const settings = await mgr('GET', `/api/clubs/${club}/pos/settings`);
const limit = settings.json?.discount_limit_percent;
console.log(`INFO  лимит скидки ресепшена: ${limit} %`);
const dOdd = [];
for (const [name, d, who, expect] of [
  ['percent −1', { percent: -1 }, rec, 400],
  ['percent 101', { percent: 101 }, rec, 400],
  ['percent 1.5', { percent: 1.5 }, rec, 400],
  ['amount −1', { amount_kopecks: -1 }, rec, 400],
  ['amount > суммы', { amount_kopecks: 15001 }, rec, 400],
  ['percent и amount вместе', { percent: 1, amount_kopecks: 1 }, rec, 400],
  ['100 %, ресепшн', { percent: 100 }, rec, 400],
  ['100 %, управляющий с причиной', { percent: 100, reason: 'тест' }, mgr, 400],
  ['выше лимита без причины, управляющий', { percent: Math.min(99, (limit ?? 10) + 5) }, mgr, 400],
  ['выше лимита, ресепшн с причиной (limit_exceeded)', { percent: Math.min(99, (limit ?? 10) + 5), reason: 'очень надо' }, rec, 400],
]) {
  const r = await who('POST', '/api/pos/sales', { items: [{ product_id: tea.id, qty: 1 }], method: 'cash', received_kopecks: 20000, discount: d }, { idem: true });
  if (r.status !== expect) dOdd.push(`${name}→${r.status} (ждали ${expect}) ${r.json?.error ?? ''}`);
}
check(results, 'скидка кассы: отрицательная, больше суммы, 100 %, выше лимита без прав/причины — отказы', dOdd.length === 0, dOdd.join('; '));
// Скидка выше лимита управляющим с причиной → тревога владельцу (контроль механизма).
const disc = await mgr('POST', '/api/pos/sales', { items: [{ product_id: tea.id, qty: 1 }], method: 'cash', received_kopecks: 20000, discount: { percent: Math.min(99, (limit ?? 10) + 40), reason: 'постоянный гость' } }, { idem: true });
check(results, 'контроль: скидка выше лимита управляющим с причиной проходит и учтена', disc.status === 201 && disc.json.discount_kopecks > 0, `status=${disc.status} disc=${disc.json?.discount_kopecks}`);
const alarms = await own('GET', `/api/clubs/${club}/alarms`);
const types = (alarms.json?.items ?? alarms.json ?? []).map?.((a) => a.type) ?? [];
check(results, 'контроль: владельцу ушла тревога discount_over_limit', types.includes('discount_over_limit'), JSON.stringify(types));

// Возвраты: нельзя вернуть больше проданного/оплаченного; ресепшн не возвращает.
const s2 = await mgr('POST', '/api/pos/sales', { items: [{ product_id: tea.id, qty: 2 }, { product_id: cake.id, qty: 1 }], method: 'cash', received_kopecks: 100_000, discount: { percent: Math.min(99, limit ?? 10) } }, { idem: true });
check(results, 'продажа со скидкой в пределах лимита', s2.status === 201, `status=${s2.status} total=${s2.json?.total_kopecks}`);
const sid = s2.json?.sale_id;
const full = await mgr('GET', `/api/pos/sales/${sid}`);
const lines = full.json?.items ?? [];
const recRefund = await rec('POST', `/api/pos/sales/${sid}/refund`, { reason: 'x' }, { idem: true });
check(results, 'ресепшн не возвращает → 403', recRefund.status === 403, `status=${recRefund.status}`);
const noReason = await mgr('POST', `/api/pos/sales/${sid}/refund`, {}, { idem: true });
check(results, 'возврат без причины → 400', noReason.status === 400, `status=${noReason.status}`);
const over = await mgr('POST', `/api/pos/sales/${sid}/refund`, { reason: 'тест', items: [{ order_item_id: lines[0]?.order_item_id, qty: 99 }] }, { idem: true });
check(results, 'возврат 99 штук из 2 → 4xx', over.status >= 400 && over.status < 500, `status=${over.status} ${over.json?.error}`);
const negq = await mgr('POST', `/api/pos/sales/${sid}/refund`, { reason: 'тест', items: [{ order_item_id: lines[0]?.order_item_id, qty: -1 }] }, { idem: true });
check(results, 'возврат с количеством −1 → 400', negq.status === 400, `status=${negq.status}`);
const r1 = await mgr('POST', `/api/pos/sales/${sid}/refund`, { reason: 'тест' }, { idem: true });
const r2 = await mgr('POST', `/api/pos/sales/${sid}/refund`, { reason: 'тест ещё раз' }, { idem: true });
check(results, 'полный возврат один раз; повторный (другой ключ) → 409/4xx', r1.status === 201 && r2.status >= 400 && r2.status < 500, `${r1.status} / ${r2.status} ${r2.json?.error}`);
console.log(`INFO  сумма продажи ${full.json?.total_kopecks}, возвращено ${r1.json?.refunded_kopecks ?? r1.json?.amount_kopecks ?? JSON.stringify(r1.json).slice(0, 120)}`);

// Пакет часов на кассе: скидка кассы на пакет не действует (money.mjs), строка пакета не подменяется ценой.
{
  const gPhone = phone2();
  const G = await login(gPhone);
  const pk = await mgr('POST', `/api/clubs/${club}/packages`, { title: `Пакет ${RUN}`, hours: 2, price_kopecks: 100_000, valid_days: 30, reason: 'проверка' });
  check(results, 'подготовка: пакет 2 ч за 1 000 ₽', pk.status === 201, `status=${pk.status} ${pk.json?.error ?? ''}`);
  const cart = (extraItem = {}) => [{ kind: 'package', package_id: pk.json?.id, phone: gPhone, ...extraItem }];
  const withAmt = await rec('POST', '/api/pos/sales', { items: cart(), method: 'cash', received_kopecks: 200_000, discount: { amount_kopecks: 50_000 } }, { idem: true });
  check(results, 'пакет с суммой скидки 500 ₽ → 400 (скидка не действует на пакет)', withAmt.status === 400, `status=${withAmt.status} ${withAmt.json?.error ?? ''}`);
  const withPct = await rec('POST', '/api/pos/sales', { items: cart(), method: 'cash', received_kopecks: 200_000, discount: { percent: 10 } }, { idem: true });
  check(results, 'пакет с 10 % → цена не снижается (1 000 ₽, скидка 0) либо 400', withPct.status === 400 || (withPct.status === 201 && withPct.json.total_kopecks === 100_000 && withPct.json.discount_kopecks === 0), `status=${withPct.status} total=${withPct.json?.total_kopecks} disc=${withPct.json?.discount_kopecks}`);
  const price = await rec('POST', '/api/pos/sales', { items: cart({ price_kopecks: 100, amount_kopecks: 100 }), method: 'cash', received_kopecks: 200_000 }, { idem: true });
  check(results, 'пакет с price_kopecks в позиции → 1 000 ₽', price.status === 201 && price.json.total_kopecks === 100_000, `status=${price.status} total=${price.json?.total_kopecks}`);
  const bal = await api('GET', `/api/clubs/${club}/balance`, { token: G.token });
  console.log(`INFO  баланс гостя после покупки: ${JSON.stringify(bal.json).slice(0, 160)}`);
}

// Чужая группа: привязка группы другого клуба и продажа с чужим модификатором.
const other = await createClub(A.token, { name: `R2-mod-b ${RUN}` });
const og = (await api('POST', `/api/clubs/${other}/catalog/modifier-groups`, { token: A.token, headers: { 'x-club-id': other }, body: { name: 'Чужая', modifiers: [{ name: 'Чуж', price_delta_kopecks: 0 }] } })).json;
const linkX = await mgr('PATCH', `/api/catalog/products/${cake.id}`, { modifier_group_ids: [og.id] });
check(results, 'привязка группы чужого клуба → 4xx', linkX.status >= 400 && linkX.status < 500, `status=${linkX.status} ${linkX.json?.error}`);
const saleX = await rec('POST', '/api/pos/sales', { items: [{ product_id: tea.id, qty: 1, modifier_ids: [og.modifiers[0].id] }], method: 'cash', received_kopecks: 100_000 }, { idem: true });
check(results, 'продажа с модификатором чужого клуба → 400', saleX.status === 400, `status=${saleX.status}`);

// --- 4. Жёсткий шаблон меню сети -----------------------------------------------------------------------
{
  const NA = await createNetwork(A.token, `R2-net ${RUN}`);
  const nclub = await createClub(A.token, { name: `R2-nclub ${RUN}` });
  await addClub(A.token, NA, nclub);
  const nh = { 'x-club-id': nclub };
  await api('PUT', `/api/networks/${NA}/menu`, { token: A.token, body: { products: [{ name: 'Чай', category: 'Напитки', price_kopecks: 15000 }] } });
  await api('PATCH', `/api/networks/${NA}`, { token: A.token, body: { menu_mode: 'hard' } });
  const nmPhone = phone2();
  await api('POST', `/api/clubs/${nclub}/staff`, { token: A.token, body: { phone: nmPhone, role: 'manager' } });
  const NM = await login(nmPhone);
  const n = (method, path, body, extra = {}) => api(method, path, { token: NM.token, body, headers: nh, ...extra });
  const ncat = (await n('GET', `/api/clubs/${nclub}/catalog`)).json;
  const ntea = ncat.products.find((p) => p.name === 'Чай');
  const g = (await n('POST', `/api/clubs/${nclub}/catalog/modifier-groups`, { name: 'Топ', modifiers: [{ name: 'Доп', price_delta_kopecks: 100 }] })).json;
  const g2 = (await n('POST', `/api/clubs/${nclub}/catalog/modifier-groups`, { name: 'Топ2', modifiers: [{ name: 'Доп2', price_delta_kopecks: 100 }] })).json;
  const l1 = await n('PATCH', `/api/catalog/products/${ntea.id}`, { modifier_group_ids: [g.id] });
  check(results, 'жёсткий шаблон: привязка группы к товару шаблона → 409 network_locked', l1.status === 409 && l1.json?.error === 'network_locked', `status=${l1.status} ${l1.json?.error}`);
  const l2 = await n('PATCH', `/api/catalog/products/${ntea.id}`, { modifier_group_ids: [g.id, g2.id] });
  const l3 = await n('PATCH', `/api/catalog/products/${ntea.id}`, { modifier_group_ids: [g.id, g.id] });
  const l4 = await n('PATCH', `/api/catalog/products/${ntea.id}`, { modifier_group_ids: [g.id], sort: 5 });
  const l5 = await n('PATCH', `/api/catalog/products/${ntea.id}`, { modifier_group_ids: 'x' });
  check(results, 'жёсткий шаблон: варианты состава (две группы, дубль, вместе с sort, не массив) → 409/400, не 200', [l2, l3, l4, l5].every((r) => r.status === 409 || r.status === 400), [l2, l3, l4, l5].map((r) => r.status).join('/'));
  const after = (await n('GET', `/api/clubs/${nclub}/catalog`)).json.products.find((p) => p.id === ntea.id);
  check(results, 'после отказов у товара шаблона нет групп модификаторов', (after.modifier_group_ids ?? after.modifier_groups ?? []).length === 0, JSON.stringify(after.modifier_group_ids ?? after.modifier_groups));
  // Обход через копию товара: PATCH network_product_id, active=false + свой товар — это право клуба; проверяем, что подмена ссылки на шаблон не снимает замок.
  const sneaky = await n('PATCH', `/api/catalog/products/${ntea.id}`, { network_product_id: null, modifier_group_ids: [g.id] });
  const sneakyAfter = (await n('GET', `/api/clubs/${nclub}/catalog`)).json.products.find((p) => p.id === ntea.id);
  check(results, 'снять ссылку network_product_id в теле PATCH нельзя, замок держится', sneaky.status >= 400 || (sneakyAfter.modifier_group_ids ?? []).length === 0, `status=${sneaky.status} ${sneaky.json?.error ?? ''}`);
  // Мягкий режим — можно (контроль, чтобы замок не был «всегда 409»).
  await api('PATCH', `/api/networks/${NA}`, { token: A.token, body: { menu_mode: 'soft' } });
  const soft = await n('PATCH', `/api/catalog/products/${ntea.id}`, { modifier_group_ids: [g.id] });
  check(results, 'контроль: мягкий режим — привязка 200', soft.status === 200, `status=${soft.status} ${soft.json?.error ?? ''}`);
  // Возврат в жёсткий: привязка не должна оставлять скидочных вариантов (надбавки только ≥ 0).
  const neg = await n('POST', `/api/clubs/${nclub}/catalog/modifier-groups`, { name: 'Мин', modifiers: [{ name: 'Минус', price_delta_kopecks: -14000 }] });
  check(results, 'сеть, мягкий режим: отрицательный модификатор → 400', neg.status === 400, `status=${neg.status}`);
  await api('PATCH', `/api/networks/${NA}`, { token: A.token, body: { menu_mode: 'hard' } });
  const unlink = await n('PATCH', `/api/catalog/products/${ntea.id}`, { modifier_group_ids: [] });
  check(results, 'жёсткий шаблон: отвязка группы → 409', unlink.status === 409, `status=${unlink.status}`);
  // Продажа товара шаблона на кассе по цене шаблона.
  await n('POST', `/api/clubs/${nclub}/shifts`, { float_kopecks: 100_000 });
  const ns = await n('POST', '/api/pos/sales', { items: [{ product_id: ntea.id, qty: 1 }], method: 'cash', received_kopecks: 15000 }, { idem: true });
  check(results, 'продажа товара шаблона: 150 ₽ без скидки', ns.status === 201 && ns.json.total_kopecks === 15000 && ns.json.discount_kopecks === 0, `status=${ns.status} total=${ns.json?.total_kopecks}`);
}

// --- 5. Остаточное: группа, привязанная ДО включения жёсткого режима, и надбавка вверх -----------------------------
{
  const A2 = await login(phone2()); // лимит: 3 тестовых клуба на пользователя
  const NB = await createNetwork(A2.token, `R2-net-b ${RUN}`);
  const bclub = await createClub(A2.token, { name: `R2-bclub ${RUN}` });
  await addClub(A2.token, NB, bclub);
  const bh = { 'x-club-id': bclub };
  await api('PUT', `/api/networks/${NB}/menu`, { token: A2.token, body: { products: [{ name: 'Чай', category: 'Напитки', price_kopecks: 15000 }] } });
  const bmPhone = phone2();
  await api('POST', `/api/clubs/${bclub}/staff`, { token: A2.token, body: { phone: bmPhone, role: 'manager' } });
  const BM = await login(bmPhone);
  const b = (method, path, body, extra = {}) => api(method, path, { token: BM.token, body, headers: bh, ...extra });
  const bt = (await b('GET', `/api/clubs/${bclub}/catalog`)).json.products.find((p) => p.name === 'Чай');
  const grp = (await b('POST', `/api/clubs/${bclub}/catalog/modifier-groups`, { name: 'Размер', min_select: 1, max_select: 1, modifiers: [{ name: 'Обычный', price_delta_kopecks: 0, is_default: true }] })).json;
  const linkedSoft = await b('PATCH', `/api/catalog/products/${bt.id}`, { modifier_group_ids: [grp.id] });
  await api('PATCH', `/api/networks/${NB}`, { token: A2.token, body: { menu_mode: 'hard' } });
  const raise = await b('POST', `/api/catalog/modifier-groups/${grp.id}/modifiers`, { name: 'Большой', price_delta_kopecks: 50_000, is_default: false });
  const dflt = await b('PATCH', `/api/catalog/modifiers/${grp.modifiers[0].id}`, { price_delta_kopecks: 40_000 });
  await b('POST', `/api/clubs/${bclub}/shifts`, { float_kopecks: 100_000 });
  const sale = await b('POST', '/api/pos/sales', { items: [{ product_id: bt.id, qty: 1 }], method: 'cash', received_kopecks: 100_000 }, { idem: true });
  console.log(`INFO  привязка в мягком режиме: ${linkedSoft.status}; в жёстком: новый модификатор +500 ₽ → ${raise.status}, надбавка «по умолчанию» +400 ₽ → ${dflt.status}; продажа товара шаблона 150 ₽ → ${sale.json?.total_kopecks} коп.`);
  check(results, 'остаточное: уже привязанная группа в жёстком режиме не повышает цену товара шаблона (надбавка вверх замком не закрыта)', !(sale.status === 201 && sale.json.total_kopecks > 15000), `total=${sale.json?.total_kopecks}`);
}

process.exit(summary(results).length ? 1 : 0);
