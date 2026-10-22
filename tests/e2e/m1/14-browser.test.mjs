// Браузер (Playwright, Chromium): T1 целиком в интерфейсе гостя на 360 px и T2 со стороны
// ресепшена на 1280×800; плюс текст второго гостя в T12. Скриншоты — в E2E_SHOTS_DIR.
//
// Пакет playwright-core не входит в зависимости репозитория: путь к папке, где он установлен
// (node_modules/playwright-core), — E2E_PW_DIR; браузеры — PLAYWRIGHT_BROWSERS_PATH (по умолчанию
// /opt/pw-browsers). Без пакета тест пропускается. Сертификат Caddy — ignoreHTTPSErrors.
//
// T1: /app/t/{код} → «2 часа» → вход по телефону (разработка) → согласие → СБП → страница
//     эмулятора ЮKassa «Оплатить» → ожидание света → экран игры: таймер 2:00:00 (±2 с), свет
//     в симуляторе; без горизонтальной прокрутки на каждом шаге; экран игры в тёмной теме;
//     «Закончить игру» → диалог → свет гаснет → чек.
// T2: ресепшн входит по телефону, гость отправляет заявку (API) → заявка появляется без
//     перезагрузки → «Принять оплату» → 2000 на клавиатуре суммы → сдача на экране → «Принять …
//     и включить свет» → «Свет на столе N включён», симулятор relay true.
// T12: пока стол держит другой гость, второй видит «Стол сейчас занимают».

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { api, BASE, guestPhone, newGuest, ok, pay, quote, table, tableCode, waitSim, waitTableFree } from './helpers.mjs';

const T1_TABLE = Number(process.env.E2E_UI_T1_TABLE || 2);
const T2_TABLE = Number(process.env.E2E_UI_T2_TABLE || 6);
const T12_TABLE = Number(process.env.E2E_UI_T12_TABLE || 2);
const SHOTS = process.env.E2E_SHOTS_DIR || path.join(os.tmpdir(), 'bl-e2e-m1-shots');
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
const errors = [];

function watch(page, tag) {
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 500 && r.url().includes('/api/')) errors.push(`${tag}: ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
  });
}

async function noHScroll(page) {
  // Выполняется в браузере.
  return page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth + 1);
}

before(async () => {
  if (skip) return;
  mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
});

const guestCtx = (extra = {}) =>
  browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, locale: 'ru-RU', timezoneId: 'Asia/Yekaterinburg', ...extra });

test(`браузер T1: гость на 360 px, стол ${T1_TABLE}, 2 часа по СБП → свет, таймер 2:00:00, чек`, { skip, timeout: 3 * 60_000 }, async (t) => {
  await waitTableFree(T1_TABLE);
  const ctx = await guestCtx({ colorScheme: 'light' });
  const page = await ctx.newPage();
  watch(page, 'guest');
  const shot = async (name) => {
    const ok360 = await noHScroll(page);
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    t.diagnostic(`${name}: ${new URL(page.url()).pathname}; без горизонтальной прокрутки: ${ok360}`);
    assert.ok(ok360, `${name}: горизонтальная прокрутка на 360 px`);
  };

  // Ссылка с QR-наклейки (/t/{код}) проверяется отдельным тестом ниже; поток T1 — с /app/t/{код}.
  await page.goto(`${BASE}/app/t/${tableCode(T1_TABLE)}`, { waitUntil: 'networkidle' });
  await shot('ui-t1-01-table-360');
  await page.getByRole('radio', { name: /2 часа/ }).check();
  await page.getByRole('button', { name: 'Продолжить к оплате' }).click();
  await page.getByLabel('Телефон').waitFor();
  await shot('ui-t1-02-signin-360');
  await page.getByLabel('Телефон').fill(guestPhone());
  await page.getByRole('button', { name: 'Войти по номеру' }).click();
  await page.getByRole('checkbox').waitFor({ timeout: 10_000 });
  await shot('ui-t1-03-consent-360');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Продолжить к оплате' }).click();
  const payBtn = page.getByRole('button', { name: /Оплатить .* и включить свет/ });
  await payBtn.waitFor({ timeout: 10_000 });
  const sbp = page.getByRole('radio', { name: /СБП/ });
  if (await sbp.count()) await sbp.first().check();
  const amount = (await page.locator('.pay__amount').textContent().catch(() => '')).replace(/\s+/g, ' ');
  await shot('ui-t1-04-pay-360');
  await payBtn.click();
  await page.waitForURL(/\/pay\//, { timeout: 15_000 });
  await shot('ui-t1-05-yookassa-emu-360');
  const tPay = Date.now();
  await page.getByRole('button', { name: 'Оплатить', exact: true }).click();
  const lit = await waitSim(T1_TABLE, (x) => x.state.relay === true, { timeoutMs: 10_000, intervalMs: 50, what: 'свет после «Оплатить»' });
  const tLit = Date.now();
  await page.waitForURL(/\/app\/s\//, { timeout: 20_000 });
  const timer = page.locator('.timer__value');
  await timer.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(600);
  const timerText = (await timer.textContent()).trim();
  await shot('ui-t1-06-game-360');
  t.diagnostic(`сумма на экране оплаты «${amount}»; «Оплатить» в ЮKassa → свет в симуляторе ${tLit - tPay} мс (опрос, с вебхуком и переходом); таймер «${timerText}»; симулятор: mode=${lit.state.mode} remaining=${lit.state.remaining_ms}`);
  assert.match(timerText, /^(2:00:00|1:59:5\d)$/, 'таймер 2:00:00');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'ui-t1-07-game-dark-360.png') });
  await page.emulateMedia({ colorScheme: 'light' });

  // «Закончить игру» → диалог → свет гаснет → чек.
  await page.getByRole('button', { name: 'Закончить игру' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  const dlgText = (await dialog.textContent()).replace(/\s+/g, ' ');
  await shot('ui-t1-08-stop-dialog-360');
  await dialog.getByRole('button', { name: 'Закончить и выключить свет' }).click();
  const dark = await waitSim(T1_TABLE, (x) => x.state.relay === false && x.state.mode === 'free', { timeoutMs: 10_000 });
  await page.waitForTimeout(1500);
  const body = (await page.locator('main').textContent().catch(() => '')).replace(/\s+/g, ' ');
  await shot('ui-t1-09-after-stop-360');
  t.diagnostic(`диалог: «${dlgText.slice(0, 160)}»; после: ${new URL(page.url()).pathname} — «${body.slice(0, 200)}»; симулятор: mode=${dark.state.mode}`);
  const receiptLink = page.getByRole('link', { name: /[Чч]ек/ }).or(page.getByRole('button', { name: /[Чч]ек/ }));
  if (!/\/receipt/.test(page.url()) && (await receiptLink.count())) {
    await receiptLink.first().click();
    await page.waitForTimeout(1500);
  }
  const rtext = (await page.locator('main').textContent().catch(() => '')).replace(/\s+/g, ' ');
  await shot('ui-t1-10-receipt-360');
  t.diagnostic(`чек: ${new URL(page.url()).pathname} — «${rtext.slice(0, 260)}»`);
  assert.match(rtext, /1\s?000\s?₽|1 000 ₽/, 'в чеке сумма');
  await ctx.close();
});

test('браузер T1: ссылка с QR-наклейки https://{PUBLIC_HOST}/t/{код} открывает экран стола', { skip }, async (t) => {
  const ctx = await guestCtx();
  const page = await ctx.newPage();
  const resp = await page.goto(`${BASE}/t/${tableCode(T1_TABLE)}`, { waitUntil: 'networkidle' });
  const body = (await page.textContent('body').catch(() => '')).slice(0, 120);
  await page.screenshot({ path: path.join(SHOTS, 'ui-t1-00-qr-link-360.png') });
  t.diagnostic(`GET /t/${tableCode(T1_TABLE)} → HTTP ${resp.status()} ${new URL(page.url()).pathname} «${body}»`);
  await ctx.close();
  assert.match(new URL(page.url()).pathname, new RegExp(`/app/t/${tableCode(T1_TABLE)}$`), 'короткая ссылка QR ведёт на экран стола');
});

test(`браузер T2: ресепшн 1280×800, стол ${T2_TABLE} — заявка без перезагрузки, наличные, свет`, { skip, timeout: 3 * 60_000 }, async (t) => {
  await waitTableFree(T2_TABLE);
  const rctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 }, locale: 'ru-RU', timezoneId: 'Asia/Yekaterinburg' });
  const rec = await rctx.newPage();
  watch(rec, 'club');
  const shot = (name) => rec.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  await rec.goto(`${BASE}/club/signin`, { waitUntil: 'networkidle' });
  await rec.getByLabel('Телефон сотрудника').fill('+70000000004');
  await rec.getByRole('button', { name: 'Войти по номеру' }).click();
  await rec.waitForURL(/\/reception$/, { timeout: 15_000 });
  await rec.waitForTimeout(1000);
  await rec.getByRole('button', { name: /Включить звук заявок/ }).click().catch(() => {});
  await shot('ui-t2-01-reception-1280x800');

  const g = await newGuest();
  const tbl = await table(T2_TABLE, g.token);
  const q = await ok(quote(g.token, { resourceId: tbl.resource.id, minutes: 60 }));
  const r = await ok(pay(g.token, q.quote_id, 'reception'));
  const t0 = Date.now();
  const tile = rec.locator('.req').filter({ hasText: `Стол ${T2_TABLE}` });
  await tile.first().waitFor({ timeout: 15_000 });
  const tileText = (await tile.first().textContent()).replace(/\s+/g, ' ');
  await shot('ui-t2-02-request-1280x800');
  t.diagnostic(`заявка ${r.reception_request_id.slice(0, 8)} на экране через ${Date.now() - t0} мс без перезагрузки: «${tileText}»`);
  await tile.first().getByRole('button', { name: 'Принять оплату' }).click();
  await rec.waitForTimeout(400);
  for (const k of ['2', '0', '0', '0']) await rec.getByRole('group', { name: 'Клавиатура суммы' }).getByRole('button', { name: k, exact: true }).click();
  const change = (await rec.locator('#change-out').textContent()).replace(/\s+/g, ' ');
  await shot('ui-t2-03-accept-cash-1280x800');
  assert.match(change, /1\s?500\s?₽/, 'сдача 1 500 ₽');
  const tAccept = Date.now();
  await rec.getByRole('button', { name: /Принять .* и включить свет/ }).click();
  const lit = await waitSim(T2_TABLE, (x) => x.state.relay === true, { timeoutMs: 10_000, intervalMs: 50 });
  const tLit = Date.now();
  await rec.getByText(new RegExp(`Свет на столе ${T2_TABLE} включён`)).waitFor({ timeout: 20_000 });
  const done = (await rec.locator('.accept-done').textContent()).replace(/\s+/g, ' ');
  await shot('ui-t2-04-light-on-1280x800');
  t.diagnostic(`сдача на экране «${change}»; «Принять» → свет ${tLit - tAccept} мс; экран: «${done}»; симулятор: mode=${lit.state.mode} relay=${lit.state.relay}`);
  await rec.getByRole('button', { name: 'Готово' }).click().catch(() => {});
  const st = await ok(api('GET', `/api/reception/requests/${r.reception_request_id}`, { token: g.token }));
  await ok(api('POST', `/api/sessions/${st.session_id}/stop`, { token: g.token, body: {} }));
  await waitSim(T2_TABLE, (x) => x.state.mode === 'free', { timeoutMs: 5000 });
  await rctx.close();
});

test(`браузер T12: второй гость видит понятный отказ (стол ${T12_TABLE})`, { skip, timeout: 2 * 60_000 }, async (t) => {
  await waitTableFree(T12_TABLE);
  const a = await newGuest();
  const rid = (await table(T12_TABLE)).resource.id;
  await ok(quote(a.token, { resourceId: rid, minutes: 60 }));
  const ctx = await guestCtx();
  const page = await ctx.newPage();
  watch(page, 'guest-b');
  await page.goto(`${BASE}/app/t/${tableCode(T12_TABLE)}`, { waitUntil: 'networkidle' });
  const notice = page.locator('.notice');
  await notice.waitFor({ timeout: 10_000 });
  const text = (await notice.textContent()).replace(/\s+/g, ' ').trim();
  await page.screenshot({ path: path.join(SHOTS, 'ui-t12-01-second-guest-360.png') });
  t.diagnostic(`второй гость видит: «${text}»; кнопки оплаты: ${await page.getByRole('button', { name: 'Продолжить к оплате' }).count()}`);
  assert.match(text, /Стол сейчас занимают/);
  assert.match(text, /3 минуты/);
  assert.equal(await page.getByRole('button', { name: 'Продолжить к оплате' }).count(), 0);
  await ctx.close();
  // Удержание A истечёт само через 3 минуты (проверено в 11-t12).
});

test('браузер: без ошибок страницы и 5xx API', { skip }, (t) => {
  t.diagnostic(`ошибки: ${JSON.stringify(errors)}`);
  assert.deepEqual(errors, []);
});
