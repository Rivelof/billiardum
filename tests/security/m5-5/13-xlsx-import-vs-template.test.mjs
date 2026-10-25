// PoC M5.5 — импорт меню из .xlsx против шаблона сети (№191, №76, №157).
// Проверяем: жёсткий шаблон — импорт .xlsx не меняет товар шаблона (ни цену, ни название);
// мягкий — флаг алкоголя шаблона импортом не снимается; предпросмотр (dry_run) показывает ошибку
// network_template; новые товары (вне шаблона) импортируются как обычно.
//
// Запуск: node tests/security/m5-5/13-xlsx-import-vs-template.test.mjs

import { apiRaw, makeXlsx, XLSX_MIME } from '../../e2e/m5/helpers.mjs';
import { addClub, api, check, createClub, createNetwork, login, phone, RUN, summary } from './_helpers.mjs';

const results = [];
const A = await login(phone());
const club = await createClub(A.token, { name: `X1 ${RUN}` });
const NA = await createNetwork(A.token, `NX ${RUN}`);
await addClub(A.token, NA, club);
await api('PUT', `/api/networks/${NA}/menu`, {
  token: A.token,
  body: { products: [{ name: 'Чай', category: 'Напитки', price_kopecks: 15000, sku: 'TEA-1' }, { name: 'Пиво', category: 'Бар', price_kopecks: 25000, is_alcohol: true, sku: 'BEER-1' }] },
});

const products = async () => (await api('GET', `/api/clubs/${club}/catalog`, { token: A.token })).json.products;
const by = async (sku) => (await products()).find((p) => p.sku === sku);
const upload = (rows, dry = false) =>
  apiRaw('POST', `/api/clubs/${club}/catalog/import${dry ? '?dry_run=1' : ''}`, { token: A.token, body: makeXlsx(rows), contentType: XLSX_MIME, headers: { 'x-club-id': club } });

const HEAD = ['категория', 'название', 'цена', 'ед', 'артикул', 'алкоголь'];

// 1. Мягкий режим: снять алкоголь у «Пива» импортом нельзя, цена Чая меняется как переопределение.
{
  const dry = await upload([HEAD, ['Бар', 'Пиво', 250, 'шт', 'BEER-1', 'нет']], true);
  const errs = JSON.stringify(dry.json?.errors ?? []);
  check(results, 'мягкий: предпросмотр xlsx со снятием алкоголя → ошибка network_template', dry.status === 200 && /network_template/.test(errs), `status=${dry.status} errors=${errs.slice(0, 120)}`);
  const imp = await upload([HEAD, ['Бар', 'Пиво', 250, 'шт', 'BEER-1', 'нет']]);
  const beer = await by('BEER-1');
  check(results, 'мягкий: импорт xlsx не снял алкоголь (applied=false, is_alcohol=true)', imp.json?.applied === false && beer?.is_alcohol === true, `applied=${imp.json?.applied} is_alcohol=${beer?.is_alcohol}`);
  const menu = await api('GET', `/api/clubs/${club}/menu`);
  check(results, 'гость по-прежнему не видит пиво', !JSON.stringify(menu.json).includes('Пиво'), '');
  // Формула: значение флага из формулы с «сохранённым» нет — сервер берёт <v>.
  const f = await upload([HEAD, ['Бар', 'Пиво', 250, 'шт', 'BEER-1', { f: 'IF(1=1,"нет","да")', v: 'нет' }]]);
  const beer2 = await by('BEER-1');
  check(results, 'формула в колонке алкоголя не обходит защиту', beer2?.is_alcohol === true, `applied=${f.json?.applied} status=${f.status}`);
  const ok = await upload([HEAD, ['Напитки', 'Чай', 99, 'шт', 'TEA-1', 'нет']]);
  const tea = await by('TEA-1');
  check(results, 'мягкий: цена Чая импортом меняется (переопределение), а не блокируется', ok.json?.applied === true && tea?.price_kopecks === 9900 && tea?.network_override === true, `applied=${ok.json?.applied} price=${tea?.price_kopecks} override=${tea?.network_override}`);
}

// 2. Жёсткий режим: импорт xlsx вообще не меняет товары шаблона.
{
  const hard = await api('PATCH', `/api/networks/${NA}`, { token: A.token, body: { menu_mode: 'hard' } });
  const tea0 = await by('TEA-1');
  check(results, 'жёсткий режим включён; переопределённая цена возвращена к шаблону', hard.status === 200 && tea0?.price_kopecks === 15000, `price=${tea0?.price_kopecks}`);
  const imp = await upload([HEAD, ['Напитки', 'Чай', 1, 'шт', 'TEA-1', 'нет']]);
  const tea = await by('TEA-1');
  check(results, 'жёсткий: импорт xlsx не меняет цену товара шаблона', tea?.price_kopecks === 15000 && imp.json?.applied === false, `applied=${imp.json?.applied} price=${tea?.price_kopecks} errors=${JSON.stringify(imp.json?.errors ?? []).slice(0, 100)}`);
  // Смешанный файл: строка шаблона + новая строка — атомарность: новая не должна пройти при ошибке.
  const mixed = await upload([HEAD, ['Напитки', 'Чай', 1, 'шт', 'TEA-1', 'нет'], ['Закуски', 'Орешки', 90, 'шт', 'NUT-1', 'нет']]);
  const nut = await by('NUT-1');
  check(results, 'жёсткий: смешанный файл атомарен — при ошибке строки шаблона новые не создаются', mixed.json?.applied === false && !nut, `applied=${mixed.json?.applied} created=${Boolean(nut)}`);
  // Новая позиция отдельным файлом — проходит (импорт вне шаблона разрешён).
  const fresh = await upload([HEAD, ['Закуски', 'Орешки', 90, 'шт', 'NUT-1', 'нет']]);
  check(results, 'жёсткий: новая позиция вне шаблона импортируется', fresh.json?.applied === true && Boolean(await by('NUT-1')), `applied=${fresh.json?.applied}`);
  // Новая позиция с алкоголем и «нет» — обычный товар клуба: алкоголь (как любой свой товар) решает владелец.
}

process.exit(summary(results).length ? 1 : 0);
