// PoC M5.5 — обход «жёсткого» шаблона меню через модификатор с отрицательной надбавкой (№191, инвариант 8).
// Гипотеза H2: жёсткий шаблон блокирует поля товара (MENU_TEMPLATE_FIELDS), но модификаторы в шаблон
// не входят. Управляющий клуба (сотрудник, не владелец сети) создаёт группу с модификатором
// price_delta_kopecks < 0, привязывает к товару шаблона (modifier_group_ids — не поле шаблона) и
// продаёт товар на кассе с этим модификатором: цена строки = price + delta (>= 1 коп.).
// Скидка идёт мимо лимита скидок (№82) и без уведомления владельцу (только запись catalog.*).
//
// Запуск: node tests/security/m5-5/06-hard-menu-modifier-bypass.test.mjs

import { addClub, api, check, createClub, createNetwork, login, phone, RUN, summary } from './_helpers.mjs';

const results = [];
const A = await login(phone());
const club = await createClub(A.token, { name: `H2 ${RUN}` });
const NA = await createNetwork(A.token, `NH ${RUN}`);
await addClub(A.token, NA, club);

const tpl = await api('PUT', `/api/networks/${NA}/menu`, { token: A.token, body: { products: [{ name: 'Чай', category: 'Напитки', price_kopecks: 15000 }] } });
check(results, 'шаблон меню: Чай 150 ₽', tpl.status === 200, `status=${tpl.status}`);
const hard = await api('PATCH', `/api/networks/${NA}`, { token: A.token, body: { menu_mode: 'hard' } });
check(results, 'меню сети — жёсткое', hard.status === 200 && hard.json.menu_mode === 'hard', `status=${hard.status}`);

// Управляющий клуба (обычный сотрудник).
const mPhone = phone();
const inv = await api('POST', `/api/clubs/${club}/staff`, { token: A.token, body: { phone: mPhone, role: 'manager' } });
check(results, 'владелец приглашает управляющего клуба', inv.status === 201, `status=${inv.status}`);
const M = await login(mPhone);
const hdr = { 'x-club-id': club };
const mApi = (method, path, body, extra = {}) => api(method, path, { token: M.token, body, headers: hdr, ...extra });

const cat = await mApi('GET', `/api/clubs/${club}/catalog`);
const tea = cat.json?.products?.find((p) => p.name === 'Чай');
check(results, 'управляющий видит товар шаблона', Boolean(tea), `status=${cat.status}`);

// Контроль: прямая правка цены заблокирована.
const direct = await mApi('PATCH', `/api/catalog/products/${tea.id}`, { price_kopecks: 1000 });
check(results, 'контроль: прямая правка цены товара шаблона → 409 network_locked', direct.status === 409 && direct.json?.error === 'network_locked', `status=${direct.status}`);

// Обход: модификатор -140 ₽.
const grp = await mApi('POST', `/api/clubs/${club}/catalog/modifier-groups`, { name: 'Акция', min_select: 0, max_select: 1, modifiers: [{ name: 'Своим', price_delta_kopecks: -14000 }] });
check(results, 'управляющий создаёт группу с модификатором -140 ₽', grp.status === 201, `status=${grp.status} ${grp.text.slice(0, 120)}`);
const modId = grp.json?.modifiers?.[0]?.id;
const link = await mApi('PATCH', `/api/catalog/products/${tea.id}`, { modifier_group_ids: [grp.json?.id] });
check(results, 'жёсткий шаблон: привязка группы к товару шаблона разрешена (обход)', link.status === 200, `status=${link.status} ${link.json?.error ?? ''}`);

// Продажа на кассе: цена строки.
const shift = await mApi('POST', `/api/clubs/${club}/shifts`, { float_kopecks: 100_000 });
check(results, 'смена открыта управляющим', shift.status === 201, `status=${shift.status} ${shift.json?.error ?? ''}`);
const sale = await mApi('POST', '/api/pos/sales', { items: [{ product_id: tea.id, qty: 1, modifier_ids: [modId] }], method: 'cash', received_kopecks: 5000 }, { idem: true });
const unit = sale.json?.total_kopecks;
check(results, 'H2: продажа товара шаблона (150 ₽) по цене 10 ₽ через модификатор', !(sale.status < 300 && Number(unit) < 15000), `status=${sale.status} total_kopecks=${unit} discount_kopecks=${sale.json?.discount_kopecks}`);

// Владельцу ушло уведомление/тревога о скидке? (инвариант 8)
const alarms = await api('GET', `/api/clubs/${club}/alarms`, { token: A.token });
const manual = (alarms.json?.items ?? alarms.json ?? []).filter?.((a) => /manual|discount/.test(a.type ?? '')) ?? [];
check(results, 'владельцу ушла тревога о скидке/ручном действии', manual.length > 0, `alarms=${JSON.stringify((alarms.json?.items ?? alarms.json ?? []).map?.((a) => a.type))}`);

// Контроль: то же в клубе вне сети — дело не в сети, приём работает в любом клубе (M2, server/catalog/api.mjs:187).
{
  const solo = await createClub(A.token, { name: `H2solo ${RUN}` });
  const soloPhone = phone();
  await api('POST', `/api/clubs/${solo}/staff`, { token: A.token, body: { phone: soloPhone, role: 'manager' } });
  const S = await login(soloPhone);
  const sApi = (method, path, body, extra = {}) => api(method, path, { token: S.token, body, headers: { 'x-club-id': solo }, ...extra });
  const p = await sApi('POST', `/api/clubs/${solo}/catalog/products`, { name: 'Чай', price_kopecks: 15000 });
  const g = await sApi('POST', `/api/clubs/${solo}/catalog/modifier-groups`, { name: 'Акция', min_select: 0, max_select: 1, modifiers: [{ name: 'Своим', price_delta_kopecks: -14000 }] });
  await sApi('PATCH', `/api/catalog/products/${p.json.id}`, { modifier_group_ids: [g.json.id] });
  await sApi('POST', `/api/clubs/${solo}/shifts`, { float_kopecks: 100_000 });
  const sale2 = await sApi('POST', '/api/pos/sales', { items: [{ product_id: p.json.id, qty: 1, modifier_ids: [g.json.modifiers[0].id] }], method: 'cash', received_kopecks: 5000 }, { idem: true });
  const unit2 = sale2.json?.total_kopecks;
  check(results, 'контроль: клуб вне сети — тот же приём (приём не специфичен для сети)', !(sale2.status < 300 && Number(unit2) < 15000), `status=${sale2.status} total_kopecks=${unit2}`);
}

process.exit(summary(results).length ? 1 : 0);
