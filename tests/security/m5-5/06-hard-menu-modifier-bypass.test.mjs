// PoC M5.5 — обход «жёсткого» шаблона меню модификатором с отрицательной надбавкой (№191, №217, инвариант 8).
// Заход 1 (находка Н-1): управляющий клуба создавал группу с price_delta_kopecks < 0, привязывал к товару шаблона
// (modifier_group_ids не входил в замок) и продавал чай 150 ₽ за 10 ₽ без лимита, причины и тревоги.
// Заход 2 (после bc51e24): отрицательная надбавка → 400, привязка групп к товару жёсткого шаблона → 409 network_locked;
// сценарий воспроизводит тот же путь и убеждается, что он закрыт на каждом шаге (в сети и в клубе вне сети).
// Подробные варианты — 14-modifier-discount-recheck.test.mjs; старые данные — 15-modifier-old-data.test.mjs.
//
// Запуск: node tests/security/m5-5/06-hard-menu-modifier-bypass.test.mjs

import { addClub, api, check, createClub, createNetwork, login, phone2, RUN, summary } from './_helpers.mjs';

const results = [];
const A = await login(phone2());
const club = await createClub(A.token, { name: `H2 ${RUN}` });
const NA = await createNetwork(A.token, `NH ${RUN}`);
await addClub(A.token, NA, club);

const tpl = await api('PUT', `/api/networks/${NA}/menu`, { token: A.token, body: { products: [{ name: 'Чай', category: 'Напитки', price_kopecks: 15000 }] } });
check(results, 'шаблон меню: Чай 150 ₽', tpl.status === 200, `status=${tpl.status}`);
const hard = await api('PATCH', `/api/networks/${NA}`, { token: A.token, body: { menu_mode: 'hard' } });
check(results, 'меню сети — жёсткое', hard.status === 200 && hard.json.menu_mode === 'hard', `status=${hard.status}`);

// Управляющий клуба (обычный сотрудник).
const mPhone = phone2();
const inv = await api('POST', `/api/clubs/${club}/staff`, { token: A.token, body: { phone: mPhone, role: 'manager' } });
check(results, 'владелец приглашает управляющего клуба', inv.status === 201, `status=${inv.status}`);
const M = await login(mPhone);
const hdr = { 'x-club-id': club };
const mApi = (method, path, body, extra = {}) => api(method, path, { token: M.token, body, headers: hdr, ...extra });

const cat = await mApi('GET', `/api/clubs/${club}/catalog`);
const tea = cat.json?.products?.find((p) => p.name === 'Чай');
check(results, 'управляющий видит товар шаблона', Boolean(tea), `status=${cat.status}`);

const direct = await mApi('PATCH', `/api/catalog/products/${tea.id}`, { price_kopecks: 1000 });
check(results, 'контроль: прямая правка цены товара шаблона → 409 network_locked', direct.status === 409 && direct.json?.error === 'network_locked', `status=${direct.status}`);

// Тот же путь, что и в заходе 1.
const grp = await mApi('POST', `/api/clubs/${club}/catalog/modifier-groups`, { name: 'Акция', min_select: 0, max_select: 1, modifiers: [{ name: 'Своим', price_delta_kopecks: -14000 }] });
check(results, 'Н-1 закрыт: группа с модификатором −140 ₽ → 400 bad_request', grp.status === 400 && grp.json?.error === 'bad_request', `status=${grp.status} ${grp.json?.error ?? ''}`);
const okGrp = await mApi('POST', `/api/clubs/${club}/catalog/modifier-groups`, { name: 'Допы', min_select: 0, max_select: 1, modifiers: [{ name: 'Лимон', price_delta_kopecks: 0 }] });
const neg = await mApi('POST', `/api/catalog/modifier-groups/${okGrp.json?.id}/modifiers`, { name: 'Своим', price_delta_kopecks: -14000 });
check(results, 'Н-1 закрыт: модификатор −140 ₽ в существующую группу → 400', neg.status === 400, `status=${neg.status}`);
const patch = await mApi('PATCH', `/api/catalog/modifiers/${okGrp.json?.modifiers?.[0]?.id}`, { price_delta_kopecks: -14000 });
check(results, 'Н-1 закрыт: правка надбавки в −140 ₽ → 400', patch.status === 400, `status=${patch.status}`);
const link = await mApi('PATCH', `/api/catalog/products/${tea.id}`, { modifier_group_ids: [okGrp.json?.id] });
check(results, 'Н-1 закрыт: привязка группы к товару жёсткого шаблона → 409 network_locked', link.status === 409 && link.json?.error === 'network_locked', `status=${link.status} ${link.json?.error ?? ''}`);

// Продажа: цена шаблона, скидки нет.
const shift = await mApi('POST', `/api/clubs/${club}/shifts`, { float_kopecks: 100_000 });
check(results, 'смена открыта управляющим', shift.status === 201, `status=${shift.status} ${shift.json?.error ?? ''}`);
const sale = await mApi('POST', '/api/pos/sales', { items: [{ product_id: tea.id, qty: 1 }], method: 'cash', received_kopecks: 15000 }, { idem: true });
check(results, 'продажа товара шаблона: 150 ₽, discount_kopecks = 0', sale.status === 201 && sale.json?.total_kopecks === 15000 && sale.json?.discount_kopecks === 0, `status=${sale.status} total=${sale.json?.total_kopecks} disc=${sale.json?.discount_kopecks}`);
const withMod = await mApi('POST', '/api/pos/sales', { items: [{ product_id: tea.id, qty: 1, modifier_ids: [okGrp.json?.modifiers?.[0]?.id] }], method: 'cash', received_kopecks: 15000 }, { idem: true });
check(results, 'модификатор не из групп товара шаблона → 400 (привязка закрыта)', withMod.status === 400, `status=${withMod.status}`);

// Контроль: клуб вне сети — приём закрыт и там.
{
  const solo = await createClub(A.token, { name: `H2solo ${RUN}` });
  const soloPhone = phone2();
  await api('POST', `/api/clubs/${solo}/staff`, { token: A.token, body: { phone: soloPhone, role: 'manager' } });
  const S = await login(soloPhone);
  const sApi = (method, path, body, extra = {}) => api(method, path, { token: S.token, body, headers: { 'x-club-id': solo }, ...extra });
  const p = await sApi('POST', `/api/clubs/${solo}/catalog/products`, { name: 'Чай', price_kopecks: 15000 });
  const g = await sApi('POST', `/api/clubs/${solo}/catalog/modifier-groups`, { name: 'Акция', min_select: 0, max_select: 1, modifiers: [{ name: 'Своим', price_delta_kopecks: -14000 }] });
  check(results, 'контроль: клуб вне сети — отрицательный модификатор → 400', g.status === 400, `status=${g.status}`);
  await sApi('POST', `/api/clubs/${solo}/shifts`, { float_kopecks: 100_000 });
  const sale2 = await sApi('POST', '/api/pos/sales', { items: [{ product_id: p.json.id, qty: 1 }], method: 'cash', received_kopecks: 15000 }, { idem: true });
  check(results, 'контроль: клуб вне сети — товар продаётся по своей цене', sale2.status === 201 && sale2.json?.total_kopecks === 15000, `status=${sale2.status} total=${sale2.json?.total_kopecks}`);
}

process.exit(summary(results).length ? 1 : 0);
