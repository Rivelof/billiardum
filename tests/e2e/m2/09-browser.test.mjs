// Браузер (Playwright, Chromium): T13 на кассе ресепшена 1280×800 и T15 у гостя на 360 px вместе
// с экраном бара (бармен +70000000005). Скриншоты — в E2E_SHOTS_DIR.
//
// Пакет playwright-core не входит в зависимости репозитория: E2E_PW_DIR — папка, где лежит
// node_modules/playwright-core; браузеры — PLAYWRIGHT_BROWSERS_PATH (/opt/pw-browsers). Без пакета
// тест пропускается. Сертификат Caddy — ignoreHTTPSErrors. Вход — POST /api/auth/dev (cookie).
//
// T13: смена (API) → касса: Кофе → Американо (0,4 л, с сахаром, 2 шт.) → Чипсы → Чай чёрный →
//      «К оплате 740 ₽» → «Наличные» → 1000 → сдача 260 ₽ → чек: ФД на экране = ФД в базе и в
//      эмуляторе АТОЛ; остаток склада уменьшился (Американо −2,6).
// T15: гость за столом (API) → «Бар»: меню без пива → чай с сахаром + чипсы → корзина → «в счёт
//      стола» → заказ; экран бара: заказ стола появился без перезагрузки → «готовится» →
//      «готов» → «выдан», гость видит статус; гость закончил игру → счёт открыт → оплата
//      счёта СБП на странице эмулятора ЮKassa → счёт закрыт.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  BAR_PHONE,
  BASE,
  CLUB_A,
  closeMyShift,
  docsFor,
  ensureBarUser,
  kktDocs,
  ok,
  openMyShift,
  P,
  receiptRow,
  staff,
  startGame,
  stockOf,
  waitFor,
  waitSale,
  waitSim,
  waitTableFree,
  ensureStock,
  serveOrders,
} from './helpers.mjs';

const TABLE = Number(process.env.E2E_UI_T15_TABLE || 6);
const SHOTS = process.env.E2E_SHOTS_DIR || path.join(os.tmpdir(), 'bl-e2e-m2-shots');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/opt/pw-browsers';

let chromium = null;
let skip = false;
try {
  const dir = process.env.E2E_PW_DIR;
  const mod = dir ? await import(pathToFileURL(createRequire(path.join(dir, 'x.js')).resolve('playwright-core')).href) : await import('playwright-core');
  chromium = mod.chromium ?? mod.default?.chromium;
} catch {
  skip = 'нет playwright-core (E2E_PW_DIR)';
}

let browser;
let db;
let rec;
let man;
let shift;
let game;
let tabSession = null;
const errors = [];

function watch(page, tag) {
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 500 && r.url().includes('/api/')) errors.push(`${tag}: ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
  });
}

async function context(phone, viewport, extra = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport, locale: 'ru-RU', timezoneId: 'Asia/Yekaterinburg', ...extra });
  const r = await ctx.request.post(`${BASE}/api/auth/dev`, { data: { phone } });
  if (!r.ok()) throw new Error(`вход ${phone}: ${r.status()}`);
  return ctx;
}

const text = (page) => page.evaluate(() => globalThis.document.body.innerText.replace(/\s+/g, ' '));
const noHScroll = (page) => page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth + 1);

function shooter(t, page) {
  return async (name) => {
    await page.waitForTimeout(250);
    const okW = await noHScroll(page);
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    t.diagnostic(`${name}.png: ${new URL(page.url()).pathname}; без горизонтальной прокрутки: ${okW}`);
    assert.ok(okW, `${name}: горизонтальная прокрутка`);
  };
}

before(async () => {
  if (skip) return;
  mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch();
  db = await adminClient();
  await ensureBarUser(db);
  rec = await staff('reception');
  man = await staff('manager');
  await ensureStock(db, man, { [P.chips]: 30, [P.nuts]: 20, [P.waterStill]: 30, [P.waterSpark]: 20, [P.beer]: 20 });
});

after(async () => {
  if (game?.sessionId) await api('POST', `/api/sessions/${game.sessionId}/stop`, { token: game.guest.token, body: {} }).catch(() => {});
  if (tabSession && shift) {
    // Тест упал до оплаты счёта: закрыть счёт на ресепшене, чтобы не оставлять долг на стенде.
    const r = await api('GET', `/api/sessions/${tabSession}/tab`, { token: rec.token }).catch(() => null);
    if (r?.json?.total_kopecks > 0) await api('POST', `/api/sessions/${tabSession}/tab/pay`, { token: rec.token, idem: true, body: { method: 'card_terminal' } }).catch(() => {});
  }
  if (shift) {
    const closed = await closeMyShift({ rec, man, shiftId: shift.id, comment: 'e2e браузер' }).catch((e) => console.log(`# смена не закрыта: ${e.message}`));
    if (closed) console.log(`# смена №${closed.number} закрыта честно, расхождение ${closed.discrepancy_kopecks}`);
  }
  await browser?.close();
  await db?.end();
  if (errors.length) console.log(`# ошибки страниц: ${errors.join('; ')}`);
});

test('браузер T13: касса 1280×800 — продажа наличными со сдачей, чек ККТ, остаток', { skip, timeout: 4 * 60_000 }, async (t) => {
  shift = await openMyShift({ rec, man, floatKopecks: 100_000, log: (m) => t.diagnostic(m) });
  const stock0 = await stockOf(db, P.americano);
  const ctx = await context('+70000000004', { width: 1280, height: 800 });
  const page = await ctx.newPage();
  watch(page, 'касса');
  const shot = shooter(t, page);
  let saleJson = null;
  page.on('response', async (r) => {
    if (r.url().endsWith('/api/pos/sales') && r.request().method() === 'POST') saleJson = await r.json().catch(() => null);
  });
  await page.goto(`${BASE}/club/c/${CLUB_A}/pos`, { waitUntil: 'load' });
  await page.getByRole('radio', { name: 'Кофе' }).waitFor({ timeout: 15_000 });
  await shot('ui-t13-01-pos-1280');
  await page.getByRole('radio', { name: 'Кофе' }).check();
  await page.getByRole('button', { name: /^Американо/ }).click();
  const dlg = page.locator('dialog[open]').first();
  await dlg.getByRole('radio', { name: /0,4 л/ }).check();
  await dlg.getByRole('radio', { name: /С сахаром/ }).check();
  await dlg.getByRole('button', { name: 'Больше на одну' }).click();
  const addBtn = dlg.getByRole('button', { name: /Добавить в чек/ });
  const addText = (await addBtn.innerText()).replace(/\s+/g, ' ');
  await shot('ui-t13-02-modifiers-1280');
  t.diagnostic(`модификаторы: кнопка «${addText}»`);
  assert.match(addText, /440/);
  await addBtn.click();
  await page.getByRole('radio', { name: 'Снеки' }).check();
  await page.getByRole('button', { name: /^Чипсы/ }).click();
  if (await dlg.isVisible().catch(() => false)) await dlg.getByRole('button', { name: /Добавить в чек/ }).click();
  await page.getByRole('radio', { name: 'Чай' }).check();
  await page.getByRole('button', { name: /^Чай чёрный/ }).click();
  await dlg.getByRole('radio', { name: /Без сахара/ }).check();
  await dlg.getByRole('button', { name: /Добавить в чек/ }).click();
  await page.waitForTimeout(300);
  const cartText = await text(page);
  await shot('ui-t13-03-cart-1280');
  t.diagnostic(`чек на экране: …${cartText.slice(cartText.indexOf('Чек'), cartText.indexOf('Чек') + 260)}`);
  assert.match(cartText, /К оплате\s*740\s₽/);
  await page.getByRole('button', { name: /^Наличные/ }).click();
  const pay = page.locator('dialog[open]').first();
  await pay.locator('#cash-received, input[inputmode=decimal], input[inputmode=numeric]').first().fill('1000');
  await page.waitForTimeout(300);
  const payText = (await pay.innerText()).replace(/\s+/g, ' ');
  await shot('ui-t13-04-cash-change-1280');
  t.diagnostic(`окно оплаты: «${payText.slice(0, 200)}»`);
  assert.match(payText, /260\s₽/, 'сдача 260 ₽ на экране');
  await pay.locator('button[type=submit]').first().click();
  await waitFor(() => saleJson, { timeoutMs: 10_000, what: 'ответ POST /api/pos/sales' });
  const sale = await waitSale(rec.token, saleJson.sale_id);
  const shown = await waitFor(
    async () => {
      const s = (await page.locator('dialog[open]').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
      return s.includes(String(sale.receipt_fd)) ? s : null;
    },
    { timeoutMs: 20_000, intervalMs: 500, what: 'ФД на экране кассы' },
  ).catch(async () => (await text(page)).slice(0, 400));
  await shot('ui-t13-05-receipt-1280');
  t.diagnostic(`экран после оплаты: «${String(shown).slice(0, 260)}»`);
  const rc = await receiptRow(db, sale.receipt_id);
  const docs = docsFor(kktDocs(), rc);
  const stock1 = await stockOf(db, P.americano);
  t.diagnostic(`продажа: ${sale.total_kopecks} коп., сдача ${sale.change_kopecks}; чек ${sale.receipt_status} ФД ${sale.receipt_fd} ФП ${sale.receipt_fp}; документов АТОЛ ${docs.length}; Американо ${stock0} → ${stock1}`);
  assert.equal(sale.total_kopecks, 74_000);
  assert.equal(sale.change_kopecks, 26_000);
  assert.equal(docs.length, 1);
  assert.ok(String(shown).includes(String(sale.receipt_fd)), 'номер ФД виден на кассе');
  assert.ok(Math.abs(stock0 - 2.6 - stock1) < 1e-9);
  const served = await serveOrders(db, rec.token, { saleIds: [sale.sale_id] });
  t.diagnostic(`заказ кассы на экране бара («Готовить в баре» отмечено по умолчанию): выдан ${served}`);
  await ctx.close();
});

test(`браузер T15: гость 360 px (стол ${TABLE}) — заказ «в счёт стола», экран бара, оплата счёта`, { skip, timeout: 6 * 60_000 }, async (t) => {
  await waitTableFree(TABLE);
  game = await startGame(TABLE, 30);
  const gctx = await context(game.guest.phone, { width: 360, height: 780 }, { isMobile: true, hasTouch: true });
  const g = await gctx.newPage();
  watch(g, 'гость');
  const gshot = shooter(t, g);
  let orderJson = null;
  g.on('response', async (r) => {
    if (r.url().endsWith('/api/orders') && r.request().method() === 'POST') orderJson = { status: r.status(), body: await r.json().catch(() => null) };
  });
  await g.goto(`${BASE}/app/s/${game.sessionId}/bar`, { waitUntil: 'load' });
  await g.getByRole('button', { name: /Выбрать: Чай чёрный/ }).waitFor({ timeout: 15_000 });
  const menuText = await text(g);
  await gshot('ui-t15-01-guest-menu-360');
  t.diagnostic(`меню гостя: пиво на экране: ${/Пиво/.test(menuText)}`);
  assert.ok(!/Пиво/.test(menuText), 'алкоголь в QR-меню не показан');
  await g.getByRole('button', { name: /Выбрать: Чай чёрный/ }).click();
  const sheet = g.locator('dialog[open]').first();
  await sheet.getByRole('radio', { name: /С сахаром/ }).check();
  await gshot('ui-t15-02-guest-modifiers-360');
  await sheet.locator('button[type=submit], .btn--primary').last().click();
  await g.getByRole('radio', { name: 'Снеки' }).check();
  await g.getByRole('button', { name: /(Добавить|Выбрать): Чипсы/ }).click();
  await g.waitForTimeout(300);
  if (await sheet.isVisible().catch(() => false)) await sheet.locator('button[type=submit], .btn--primary').last().click();
  await g.locator('.cartbtn').click();
  const cart = g.locator('dialog[open]').first();
  await cart.getByRole('radio', { name: /сч[её]т стола/i }).check();
  await gshot('ui-t15-03-guest-cart-tab-360');
  await cart.locator('button[type=submit]').last().click();
  await waitFor(() => orderJson, { timeoutMs: 10_000, what: 'ответ POST /api/orders' });
  t.diagnostic(`заказ: HTTP ${orderJson.status} №${orderJson.body?.order?.number} ${orderJson.body?.order?.pay_mode} ${orderJson.body?.order?.subtotal_kopecks} коп.`);
  assert.equal(orderJson.status, 201);
  const order = orderJson.body.order;
  tabSession = game.sessionId;
  assert.equal(order.pay_mode, 'tab');
  assert.equal(order.subtotal_kopecks, 30_000);
  await g.waitForTimeout(800);
  await gshot('ui-t15-04-guest-order-placed-360');

  const bctx = await context(BAR_PHONE, { width: 1280, height: 800 });
  const bar = await bctx.newPage();
  watch(bar, 'бар');
  const bshot = shooter(t, bar);
  await bar.goto(`${BASE}/club/c/${CLUB_A}/bar`, { waitUntil: 'load' });
  const ticket = bar.locator('article.ticket', { hasText: `Стол ${TABLE}` }).filter({ hasText: String(order.number) }).first();
  await ticket.waitFor({ timeout: 15_000 });
  await bshot('ui-t15-05-bar-queue-1280');
  t.diagnostic(`экран бара: «${(await ticket.innerText()).replace(/\s+/g, ' ').slice(0, 160)}»`);
  const statuses = [];
  for (const want of ['preparing', 'ready', 'served']) {
    await ticket.locator('button.ticket__go').click();
    const o = await waitFor(
      async () => {
        const r = await api('GET', `/api/orders/${order.id}`, { token: game.guest.token });
        return r.status === 200 && r.json.status === want ? r.json : null;
      },
      { timeoutMs: 10_000, intervalMs: 200, what: `статус ${want}` },
    );
    await g.waitForTimeout(700);
    const gt = await text(g);
    statuses.push(`${o.status}`);
    if (want === 'preparing') await bshot('ui-t15-06-bar-preparing-1280');
    if (want === 'ready') await gshot('ui-t15-07-guest-order-ready-360');
    t.diagnostic(`бармен: «далее» → ${o.status}; у гостя на экране: «${gt.slice(0, 200)}»`);
    if (want === 'served') break;
  }
  assert.deepEqual(statuses, ['preparing', 'ready', 'served']);
  await bctx.close();

  // Гость уходит: игра закончена, счёт остаётся; оплата счёта СБП.
  await ok(api('POST', `/api/sessions/${game.sessionId}/stop`, { token: game.guest.token, body: {} }));
  await waitSim(TABLE, (x) => x.state.mode === 'free' && x.state.relay === false, { timeoutMs: 10_000 });
  const sid = game.sessionId;
  game.sessionId = null;
  // Экран игры гостя после конца: «Счёт бара не оплачен» → «Оплатить счёт бара» → бар → «Оплатить счёт».
  await g.goto(`${BASE}/app/s/${sid}`, { waitUntil: 'load' });
  await g.getByText(/Счёт бара не оплачен/).waitFor({ timeout: 15_000 });
  const tabText = await text(g);
  await gshot('ui-t15-08-guest-game-over-tab-open-360');
  t.diagnostic(`экран гостя после конца игры: «${tabText.slice(0, 260)}»`);
  assert.match(tabText, /300\s₽/);
  await g.getByRole('button', { name: /Оплатить счёт бара/ }).or(g.getByRole('link', { name: /Оплатить счёт бара/ })).first().click();
  const payTab = g.getByRole('button', { name: /Оплатить счёт\s+\d/ }).first();
  await payTab.waitFor({ timeout: 15_000 });
  await gshot('ui-t15-09-guest-tab-pay-360');
  await payTab.click();
  await g.waitForURL(/\/pay\//, { timeout: 15_000 });
  await gshot('ui-t15-10-yookassa-emu-360');
  await g.getByRole('button', { name: 'Оплатить', exact: true }).click();
  const paid = await waitFor(
    async () => {
      const r = await api('GET', `/api/sessions/${sid}/tab`, { token: game.guest.token });
      return r.status === 200 && r.json.total_kopecks === 0 ? r.json : null;
    },
    { timeoutMs: 20_000, intervalMs: 300, what: 'счёт оплачен' },
  );
  await g.waitForTimeout(1500);
  const doneText = await text(g);
  await gshot('ui-t15-11-guest-tab-paid-360');
  t.diagnostic(`после оплаты: счёт ${paid.total_kopecks} коп.; экран: «${doneText.slice(0, 200)}»`);
  tabSession = null;
  await gctx.close();
});

test('браузер: касса — скидка 20 % выше лимита по PIN управляющего (№95, №100)', { skip, timeout: 4 * 60_000 }, async (t) => {
  if (!shift) shift = await openMyShift({ rec, man, floatKopecks: 0, log: (m) => t.diagnostic(m) });
  const ctx = await context('+70000000004', { width: 1280, height: 800 });
  const page = await ctx.newPage();
  watch(page, 'касса-скидка');
  const shot = shooter(t, page);
  let saleJson = null;
  page.on('response', async (r) => {
    if (r.url().endsWith('/api/pos/sales') && r.request().method() === 'POST') saleJson = await r.json().catch(() => null);
  });
  await page.goto(`${BASE}/club/c/${CLUB_A}/pos`, { waitUntil: 'load' });
  await page.getByRole('radio', { name: 'Кофе' }).check();
  await page.getByRole('button', { name: /^Капучино/ }).click();
  const dlg = page.locator('dialog[open]').first();
  await dlg.getByRole('button', { name: 'Больше на одну' }).click();
  await dlg.getByRole('button', { name: /Добавить в чек/ }).click();
  await page.getByRole('button', { name: 'Скидка' }).click();
  const d = page.locator('dialog[open]').first();
  await d.getByRole('button', { name: '20 %' }).click();
  await d.getByRole('radio', { name: 'Компенсация за неудобство' }).check();
  await d.getByLabel('Своими словами').fill('Гость ждал заказ 40 минут (e2e)');
  await d.getByRole('radio', { name: 'Управляющий (тест)' }).check();
  const pin = d.locator('[aria-label*="PIN"], .pinpad, .pin').last();
  for (const digit of '1234') {
    const inPad = pin.getByRole('button', { name: digit, exact: true });
    await ((await inPad.count()) ? inPad.first() : d.getByRole('button', { name: digit, exact: true }).last()).click();
  }
  await shot('ui-pin-01-discount-pin-1280');
  await d.getByRole('button', { name: /Подтвердить у управляющего/ }).click();
  await page.waitForTimeout(800);
  const cartText = await text(page);
  await shot('ui-pin-02-cart-discount-1280');
  t.diagnostic(`чек после подтверждения: …${cartText.slice(cartText.indexOf('Чек'), cartText.indexOf('Чек') + 220)}`);
  assert.match(cartText, /К оплате\s*352\s₽/);
  await page.getByRole('button', { name: /^Наличные/ }).click();
  const pay = page.locator('dialog[open]').first();
  await pay.locator('#cash-received, input[inputmode=decimal], input[inputmode=numeric]').first().fill('500');
  await pay.locator('button[type=submit]').first().click();
  await waitFor(() => saleJson, { timeoutMs: 10_000, what: 'ответ POST /api/pos/sales' });
  await shot('ui-pin-03-paid-1280');
  const sale = await waitSale(rec.token, saleJson.sale_id, { printed: false });
  const { rows: au } = await db.query("select action, actor_id, reason from bl.audit_log where club_id = $1 and object_id = $2 and action in ('manual.discount', 'pos.discount')", [CLUB_A, sale.sale_id]);
  t.diagnostic(`продажа: ${sale.status} итог ${sale.total_kopecks}, скидка ${sale.discount_kopecks}, сдача ${sale.change_kopecks}; журнал ${JSON.stringify(au.map((a) => ({ action: a.action, manager: a.actor_id === man.user.id, reason: a.reason })))}`);
  assert.equal(sale.discount_kopecks, 8_800);
  assert.equal(sale.total_kopecks, 35_200);
  assert.ok(au.some((a) => a.action === 'manual.discount' && a.actor_id === man.user.id && a.reason));
  await ctx.close();
});
