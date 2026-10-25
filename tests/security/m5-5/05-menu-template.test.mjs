// PoC M5.5 — шаблон меню сети (№191, №76: алкоголь не показывается в QR-меню гостя).
// Проверяем: цена <= 0 / дробная; алкоголь шаблона не виден гостю в обоих клубах; клуб не снимает
// флаг is_alcohol (PATCH и импорт CSV) ни в мягком, ни в жёстком режиме; жёсткий режим блокирует
// PATCH полей шаблона и импорт; подмена network_product_id в теле; чужие id товаров в PUT.
//
// Запуск: node tests/security/m5-5/05-menu-template.test.mjs

import { addClub, api, check, createClub, createNetwork, login, phone, RUN, summary } from './_helpers.mjs';

const results = [];

const A = await login(phone());
const B = await login(phone());
const club1 = await createClub(A.token, { name: `M1 ${RUN}` });
const club2 = await createClub(A.token, { name: `M2 ${RUN}`, timezone: 'Europe/Kaliningrad', city: 'Калининград' });
const NA = await createNetwork(A.token, `NM ${RUN}`);
await addClub(A.token, NA, club1);
await addClub(A.token, NA, club2);
const NB = await createNetwork(B.token, `NMB ${RUN}`);

const prod = (o) => ({ name: 'Чай', category: 'Напитки', price_kopecks: 15000, unit: 'шт', ...o });
const putMenu = (token, products, net = NA, extra = {}) => api('PUT', `/api/networks/${net}/menu`, { token, body: { products, ...extra } });

// 1. Цена: 0, минус, дробь, строка, огромная — 400, шаблон не создан.
{
  const bad = [];
  for (const [k, v] of Object.entries({ zero: 0, negative: -1, fractional: 99.5, string: '100', huge: 100_000_001, nul: null })) {
    const r = await putMenu(A.token, [prod({ price_kopecks: v })]);
    if (r.status !== 400) bad.push(`${k}=${r.status}`);
  }
  check(results, 'шаблон меню: цена 0/минус/дробь/строка/огромная/null → 400', bad.length === 0, bad.join(', ') || 'все 400');
  const other = [];
  for (const [k, p] of Object.entries({ is_alcohol_str: prod({ is_alcohol: 'true' }), vat_99: prod({ vat_code: 99 }), subject_bad: prod({ payment_subject: 'free' }), unit_bad: prod({ unit: 'бочка' }), sku_bad: prod({ sku: 'a b;--' }), name_trim: prod({ name: ' x ' }) })) {
    const r = await putMenu(A.token, [p]);
    if (r.status !== 400) other.push(`${k}=${r.status}`);
  }
  check(results, 'шаблон меню: неверные поля → 400', other.length === 0, other.join(', ') || 'все 400');
}

// 2. Корректный шаблон: чай, пиво (алкоголь, артикул). Применяется в оба клуба.
let beerTplId;
{
  const r = await putMenu(A.token, [prod({ name: 'Чай' }), prod({ name: 'Пиво', category: 'Бар', price_kopecks: 25000, is_alcohol: true, sku: 'BEER-1' })]);
  check(results, 'корректный шаблон меню → 200', r.status === 200 && r.json?.template === true, `status=${r.status}`);
  beerTplId = r.json?.products?.find((p) => p.name === 'Пиво')?.id;
}

// 3. Гость (без входа) не видит алкоголь в QR-меню ни в одном клубе; чай виден.
{
  for (const [label, c] of [['club1', club1], ['club2', club2]]) {
    const m = await api('GET', `/api/clubs/${c}/menu`);
    const text = JSON.stringify(m.json);
    check(results, `${label}: гостевое меню содержит «Чай» и не содержит «Пиво»`, m.status === 200 && text.includes('Чай') && !text.includes('Пиво') && !text.includes('BEER-1'), `status=${m.status}`);
  }
}

// 4. Клуб (мягкий режим) не снимает флаг алкоголя: PATCH is_alcohol=false → 409; CSV-импорт с тем же sku → ошибка.
const catalog1 = await api('GET', `/api/clubs/${club1}/catalog`, { token: A.token });
const beer1 = catalog1.json?.products?.find((p) => p.sku === 'BEER-1');
{
  check(results, 'товар «Пиво» создан в club1 с флагом алкоголя и ссылкой на шаблон', beer1?.is_alcohol === true && beer1?.network_product_id === beerTplId, JSON.stringify({ a: beer1?.is_alcohol, n: beer1?.network_product_id === beerTplId }));
  const p = await api('PATCH', `/api/catalog/products/${beer1.id}`, { token: A.token, body: { is_alcohol: false } });
  check(results, 'мягкий: PATCH is_alcohol=false на товаре шаблона → 409 network_locked', p.status === 409 && p.json?.error === 'network_locked', `status=${p.status} ${p.json?.error ?? ''}`);
  const csv = 'category;name;price;unit;sku;alcohol\nБар;Пиво;250;шт;BEER-1;0\n';
  const imp = await api('POST', `/api/clubs/${club1}/catalog/import`, { token: A.token, body: { csv } });
  const rowErr = imp.json?.errors ?? [];
  const after = (await api('GET', `/api/clubs/${club1}/catalog`, { token: A.token })).json.products.find((x) => x.sku === 'BEER-1');
  check(results, 'мягкий: импорт CSV без флага алкоголя не снимает его', after?.is_alcohol === true, `import status=${imp.status} applied=${imp.json?.applied} errors=${JSON.stringify(rowErr).slice(0, 160)} is_alcohol=${after?.is_alcohol}`);
  const m = await api('GET', `/api/clubs/${club1}/menu`);
  check(results, 'после попыток алкоголь по-прежнему не виден гостю', !JSON.stringify(m.json).includes('Пиво'), '');
}

// 5. Обходы через смежные поля: смена sku/названия/категории не должна обнулять флаг или связь.
{
  const rn = await api('PATCH', `/api/catalog/products/${beer1.id}`, { token: A.token, body: { name: 'Квас', sku: 'KVAS-1' } });
  const after = (await api('GET', `/api/clubs/${club1}/catalog`, { token: A.token })).json.products.find((x) => x.id === beer1.id);
  check(results, 'мягкий: переименование товара шаблона разрешено, алкоголь остаётся алкоголем', rn.status === 200 && after?.is_alcohol === true, `status=${rn.status} is_alcohol=${after?.is_alcohol}`);
  const m = await api('GET', `/api/clubs/${club1}/menu`);
  check(results, 'переименованный алкоголь («Квас») не виден гостю', !JSON.stringify(m.json).includes('Квас'), '');
  // payment_subject: excise → commodity не должен открывать товар гостю.
  const ps = await api('PATCH', `/api/catalog/products/${beer1.id}`, { token: A.token, body: { payment_subject: 'commodity' } });
  const m2 = await api('GET', `/api/clubs/${club1}/menu`);
  check(results, 'смена payment_subject не открывает алкоголь гостю', !JSON.stringify(m2.json).includes('Квас'), `patch=${ps.status}`);
}

// 6. Подмена network_product_id / network_override в теле создания и правки товара — игнорируется.
{
  const forged = await api('POST', `/api/clubs/${club2}/catalog/products`, {
    token: A.token,
    body: { name: 'Левый', price_kopecks: 100, network_product_id: beerTplId, network_override: true, is_alcohol: false },
  });
  const created = forged.json;
  check(results, 'подмена network_product_id при создании товара игнорируется', forged.status === 201 && (created?.network_product_id ?? null) === null && created?.network_override === false, `status=${forged.status} npid=${created?.network_product_id} ovr=${created?.network_override}`);
  const beer2 = (await api('GET', `/api/clubs/${club2}/catalog`, { token: A.token })).json.products.find((p) => p.sku === 'BEER-1');
  const f2 = await api('PATCH', `/api/catalog/products/${beer2.id}`, { token: A.token, body: { network_override: true, network_product_id: null, is_alcohol: false } });
  const still = (await api('GET', `/api/clubs/${club2}/catalog`, { token: A.token })).json.products.find((p) => p.id === beer2.id);
  check(results, 'PATCH с network_product_id=null / is_alcohol=false не отвязывает и не снимает алкоголь', still?.network_product_id === beerTplId && still?.is_alcohol === true, `patch=${f2.status} npid_ok=${still?.network_product_id === beerTplId} alc=${still?.is_alcohol}`);
}

// 7. Чужая сеть: id товара из NA в PUT сети NB — 400; чужой владелец не читает шаблон.
{
  const r = await putMenu(B.token, [prod({ id: beerTplId, name: 'Украденный' })], NB);
  check(results, 'чужой id товара шаблона в своей сети → 400', r.status === 400, `status=${r.status}`);
  const g = await api('GET', `/api/networks/${NA}/menu`, { token: B.token });
  const p = await putMenu(B.token, [prod()], NA);
  check(results, 'чужой владелец: GET/PUT меню сети → 404', g.status === 404 && p.status === 404, `${g.status}/${p.status}`);
}

// 8. Жёсткий режим: PATCH полей шаблона и импорт блокируются; цена не обходится.
{
  const hard = await api('PATCH', `/api/networks/${NA}`, { token: A.token, body: { menu_mode: 'hard' } });
  check(results, 'PATCH menu_mode=hard → 200', hard.status === 200, `status=${hard.status}`);
  const tea1 = (await api('GET', `/api/clubs/${club1}/catalog`, { token: A.token })).json.products.find((p) => p.name === 'Чай');
  const pr = await api('PATCH', `/api/catalog/products/${tea1.id}`, { token: A.token, body: { price_kopecks: 1 } });
  check(results, 'жёсткий: PATCH цены товара шаблона → 409 network_locked', pr.status === 409 && pr.json?.error === 'network_locked', `status=${pr.status}`);
  const off = await api('PATCH', `/api/catalog/products/${tea1.id}`, { token: A.token, body: { active: false } });
  check(results, 'жёсткий: снятие товара шаблона с продажи → 409', off.status === 409, `status=${off.status}`);
  const imp = await api('POST', `/api/clubs/${club1}/catalog/import`, { token: A.token, body: { csv: 'category;name;price;unit\nНапитки;Чай;1;шт\n' } });
  const after = (await api('GET', `/api/clubs/${club1}/catalog`, { token: A.token })).json.products.find((p) => p.id === tea1.id);
  check(results, 'жёсткий: импорт CSV не меняет цену товара шаблона', after?.price_kopecks === 15000, `import=${imp.status} applied=${imp.json?.applied} price=${after?.price_kopecks}`);
  const stop = await api('POST', `/api/catalog/products/${tea1.id}/stop-list`, { token: A.token, body: { stop_list: true } });
  check(results, 'жёсткий: стоп-лист остаётся доступным клубу (не поле шаблона)', stop.status === 200, `status=${stop.status}`);
  // Возврат клуба к шаблону вернул «Квас» → «Пиво»: жёсткий режим применил шаблон принудительно.
  const beerBack = (await api('GET', `/api/clubs/${club1}/catalog`, { token: A.token })).json.products.find((p) => p.id === beer1.id);
  check(results, 'жёсткий: переопределённый товар возвращён к шаблону (имя Пиво, алкоголь)', beerBack?.name === 'Пиво' && beerBack?.is_alcohol === true, `name=${beerBack?.name} alc=${beerBack?.is_alcohol}`);
}

process.exit(summary(results).length ? 1 : 0);
