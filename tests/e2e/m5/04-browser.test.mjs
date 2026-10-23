// T26 и T27 в браузере (Playwright, Chromium из /opt/pw-browsers): путь владельца целиком —
// «Подключить клуб» → мастер → план зала (перетаскивание) → тариф → .xlsx → приглашение → тестовый
// магазин и проверочный платёж → контроллеры (ручной ввод BLD1) → наклейки → чек-лист 409 →
// боевой магазин → live. Два прохода: 1280×900 (светлая) и 360×780 (тёмная); на каждом экране —
// обе темы (emulateMedia), без горизонтальной прокрутки, axe без serious/critical, видимый фокус.
// Гость в тестовом режиме видит плашку «Тестовый режим клуба — деньги не списываются» (360, обе темы).
//
// Для каждого прохода — 2 новых контроллера (provision-factory) и свой процесс симулятора --claim
// (порты E2E_M5_UI_PORTS, по умолчанию 18082 и 18083). playwright-core: E2E_PW_DIR или /opt/node-tools;
// axe-core — E2E_AXE_FILE или кэш npx. Скриншоты — E2E_SHOTS_DIR.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import {
  adminClient,
  BASE,
  emuSucceed,
  makeXlsx,
  MENU_ROWS,
  newGuest,
  provisionFactory,
  saveState,
  sleep,
  staffPhone,
  startClaimSim,
  stopProcess,
  waitFor,
} from './helpers.mjs';

const SHOTS = process.env.E2E_SHOTS_DIR || path.join(os.tmpdir(), 'bl-e2e-m5-shots');
const PORTS = (process.env.E2E_M5_UI_PORTS || '18082,18083').split(',').map(Number);
process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/opt/pw-browsers';

let chromium = null;
let skip = false;
try {
  const dir = process.env.E2E_PW_DIR || '/opt/node-tools';
  const mod = await import(pathToFileURL(createRequire(path.join(dir, 'x.js')).resolve('playwright-core')).href);
  chromium = mod.chromium ?? mod.default?.chromium;
} catch {
  skip = 'нет playwright-core (E2E_PW_DIR)';
}

function axeSource() {
  if (process.env.E2E_AXE_FILE) return readFileSync(process.env.E2E_AXE_FILE, 'utf8');
  const root = path.join(os.homedir(), '.npm', '_npx');
  for (const d of existsSync(root) ? readdirSync(root) : []) {
    const p = path.join(root, d, 'node_modules', 'axe-core', 'axe.min.js');
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  return null;
}
const AXE = axeSource();

let browser;
let db;
const errors = [];
const summary = [];
const sims = [];

before(async () => {
  if (skip) return;
  mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch();
  db = await adminClient();
});

after(async () => {
  for (const pid of sims) if (!process.env.E2E_M5_KEEP_SIM) stopProcess(pid);
  await browser?.close();
  await db?.end();
});

function watch(page, tag) {
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 500) errors.push(`${tag}: ${r.status()} ${new URL(r.url()).pathname}`);
  });
}

/** Экран в одной теме: прокрутка, axe, фокус с клавиатуры, скриншот. */
async function checkOne(t, page, name) {
  await page.waitForTimeout(700);
  const w = await page.evaluate(() => ({ sw: globalThis.document.documentElement.scrollWidth, iw: globalThis.innerWidth }));
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
  let serious = [];
  let axe = 'axe нет';
  if (AXE) {
    if (!(await page.evaluate(() => Boolean(globalThis.axe)))) await page.addScriptTag({ content: AXE });
    const res = await page.evaluate(async () => {
      const r = await globalThis.axe.run(globalThis.document, { resultTypes: ['violations'] });
      return r.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, target: v.nodes[0]?.target?.join(' ') }));
    });
    serious = res.filter((v) => ['serious', 'critical'].includes(v.impact));
    axe = res.length ? res.map((v) => `${v.id}/${v.impact}×${v.n}${['serious', 'critical'].includes(v.impact) ? ` [${v.target}]` : ''}`).join(',') : 'axe 0';
  }
  const focus = [];
  await page.evaluate(() => globalThis.document.activeElement?.blur?.());
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press('Tab');
    focus.push(
      await page.evaluate(() => {
        const el = globalThis.document.activeElement;
        if (!el || el === globalThis.document.body) return null;
        const cs = globalThis.getComputedStyle(el);
        const visible = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none');
        return { tag: el.tagName.toLowerCase(), label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24), visible };
      }),
    );
  }
  const noFocus = focus.filter((f) => f && !f.visible);
  const hs = w.sw > w.iw + 1;
  summary.push({ name, hscroll: hs, serious, noFocus });
  t.diagnostic(`${name}: ${hs ? `ПРОКРУТКА ${w.sw}>${w.iw}` : 'без прокрутки'}; ${axe}; фокус ${focus.filter(Boolean).length}/3${noFocus.length ? ` (НЕ ВИДЕН: ${noFocus.map((f) => `${f.tag} «${f.label}»`).join(', ')})` : ' виден'}`);
}

/** Экран в обеих темах; возвращает к исходной. */
async function screen(t, page, name, scheme) {
  await checkOne(t, page, `${name}-${scheme}`);
  const other = scheme === 'light' ? 'dark' : 'light';
  await page.emulateMedia({ colorScheme: other });
  await checkOne(t, page, `${name}-${other}`);
  await page.emulateMedia({ colorScheme: scheme });
}

const bodyText = (page) => page.evaluate(() => globalThis.document.body.innerText.replace(/\s+/g, ' '));

async function clubIdFromUrl(page) {
  await page.waitForURL(/\/club\/c\/[0-9a-f-]{36}\//);
  return /\/club\/c\/([0-9a-f-]{36})\//.exec(page.url())[1];
}

async function providerOfCheck(clubId) {
  return waitFor(async () => {
    const { rows } = await db.query("select provider_payment_id from bl.shop_checks where club_id = $1 and mode = 'test' and status = 'pending' order by created_at desc limit 1", [clubId]);
    return rows[0]?.provider_payment_id ?? null;
  }, { timeoutMs: 20_000, what: 'проверочный платёж в базе' });
}

/**
 * Путь владельца в браузере. width — 1280 или 360; scheme — тема прохода.
 */
async function ownerFlow(t, { width, scheme, port, tag }) {
  const viewport = width >= 1000 ? { width, height: 900 } : { width, height: 780 };
  const phone = staffPhone();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport, locale: 'ru-RU', timezoneId: 'Asia/Yekaterinburg', colorScheme: scheme, deviceScaleFactor: 1, acceptDownloads: true, bypassCSP: true });
  const r = await ctx.request.post(`${BASE}/api/auth/dev`, { data: { phone } });
  assert.ok(r.ok(), `вход ${r.status()}`);
  const page = await ctx.newPage();
  watch(page, tag);
  const out = { phone };
  try {
    // 1. «Подключить клуб».
    await page.goto(`${BASE}/club/`, { waitUntil: 'load' });
    await page.waitForURL(/\/club\/start/, { timeout: 15_000 });
    await page.getByRole('heading', { name: 'Подключить клуб' }).waitFor();
    await screen(t, page, `${tag}-01-start`, scheme);
    await page.click('text=Создать клуб в тестовом режиме');
    await page.waitForSelector('.field__error');
    await page.fill('#cs-name', `E2E M5 UI ${tag} ${Date.now() % 10000}`);
    await page.fill('#cs-city', 'Екатеринбург');
    await page.waitForFunction(() => globalThis.document.querySelector('#cs-timezone')?.value === 'Asia/Yekaterinburg', null, { timeout: 5000 }).catch(() => page.selectOption('#cs-timezone', 'Asia/Yekaterinburg'));
    await page.click('text=Создать клуб в тестовом режиме');
    const clubId = await clubIdFromUrl(page);
    out.clubId = clubId;
    await page.waitForURL(/onboarding\/hall/);
    assert.ok((await page.locator('.modenote').count()) > 0, 'плашка тестового режима в программе клуба');
    await screen(t, page, `${tag}-02-hall-empty`, scheme);

    // 2. Зал: два стола, второй — пул; перетаскивание (только на широком экране) и поворот.
    for (let i = 0; i < 2; i += 1) {
      await page.click('text=Добавить стол');
      await page.waitForSelector('dialog[open]');
      if (i === 1) await page.check('dialog[open] input[name="add-kind"] >> nth=1');
      if (i === 0) await screen(t, page, `${tag}-03-add-table`, scheme);
      await page.click('dialog[open] button[type=submit]');
      await page.waitForSelector('dialog[open]', { state: 'detached' }).catch(() => {});
      await page.waitForTimeout(600);
    }
    await waitFor(async () => {
      const { rows } = await db.query('select count(*)::int as n from bl.resources where club_id = $1', [clubId]);
      return rows[0].n === 2;
    }, { what: 'два стола в базе' });
    if (width >= 1000) {
      const before = (await db.query('select number, plan_x, plan_y, plan_rotation from bl.resources where club_id = $1 order by number', [clubId])).rows;
      const tbl = page.locator('.pe__tbl').nth(1);
      const box = await tbl.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 90, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(400);
      out.focusAfterDrag = await page.evaluate(() => globalThis.document.activeElement?.className ?? null);
      await page.keyboard.press('r');
      await page.waitForTimeout(900);
      out.rAfterDrag = (await db.query('select plan_rotation from bl.resources where club_id = $1 and number = 2', [clubId])).rows[0].plan_rotation;
      out.rAfterDragUi = await tbl.evaluate((el) => /rotate\((\d+)deg\)/.exec(el.style.transform)?.[1] ?? null);
      // Клавиатура: фокус на столе, стрелка и R.
      await tbl.focus();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('r');
      const after = await waitFor(async () => {
        const { rows } = await db.query('select number, plan_x, plan_y, plan_rotation from bl.resources where club_id = $1 order by number', [clubId]);
        return rows[1].plan_x !== before[1].plan_x && rows[1].plan_rotation !== before[1].plan_rotation ? rows : null;
      }, { timeoutMs: 10_000, what: 'позиция и поворот сохранены' });
      out.drag = `стол 2: ${before[1].plan_x},${before[1].plan_y} ↻${before[1].plan_rotation} → ${after[1].plan_x},${after[1].plan_y} ↻${after[1].plan_rotation} (R сразу после перетаскивания мышью: на экране ↻${out.rAfterDragUi}, в базе ↻${out.rAfterDrag}, фокус «${out.focusAfterDrag}»)`;
    } else {
      out.drag = (await page.locator('.pe__tbl').count()) === 0 ? 'список столов с полями вместо плана' : 'ПЛАН на узком экране';
    }
    await screen(t, page, `${tag}-04-hall`, scheme);
    await page.click('text=Дальше: Тарифы');

    // 3. Тариф «Будни и выходные».
    await page.waitForURL(/tariffs/);
    await page.check('input[name="tw-tpl"] >> nth=1');
    await screen(t, page, `${tag}-05-tariffs-template`, scheme);
    await page.click('text=Задать цены');
    await page.fill('#tw-p-wd', '600');
    await page.fill('#tw-p-we', '900');
    await page.click('text=Показать неделю');
    await screen(t, page, `${tag}-06-tariffs-week`, scheme);
    await page.click('text=Сохранить тарифы');
    await page.waitForSelector('text=Тарифы сохранены.');
    await page.click('text=Дальше: Меню бара');

    // 4. Меню из .xlsx: предпросмотр, затем загрузка.
    await page.setInputFiles('input[type=file]', { name: 'menu.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: makeXlsx(MENU_ROWS) });
    await page.waitForSelector('text=Будет добавлено');
    const { rows: p0 } = await db.query('select count(*)::int as n from bl.products where club_id = $1', [clubId]);
    assert.equal(p0[0].n, 0, 'предпросмотр не пишет');
    await screen(t, page, `${tag}-07-menu-preview`, scheme);
    await page.click('text=/Загрузить в меню: /');
    await page.waitForSelector('text=Меню загружено');
    const { rows: p1 } = await db.query('select count(*)::int as n from bl.products where club_id = $1', [clubId]);
    out.menu = p1[0].n;
    await page.click('text=Дальше: Персонал');

    // 5. Приглашение ресепшена ссылкой.
    await page.click('text=Пригласить сотрудника');
    await page.waitForSelector('dialog[open]');
    await page.fill('#inv-phone', staffPhone().slice(2));
    await page.click('dialog[open] button[type=submit]');
    await page.waitForSelector('.invite__text');
    out.invite = (await page.locator('.invite__text').innerText()).replace(/\s+/g, ' ');
    assert.ok(out.invite.includes('https://localhost:8443/club/'));
    assert.ok((await page.locator('text=Скопировать').count()) > 0, 'кнопка «Скопировать»');
    await screen(t, page, `${tag}-08-staff-invite`, scheme);
    await page.click('text=Дальше: ЮKassa');

    // 6. Тестовый магазин: сначала боевой ключ в тестовом поле — отказ, затем верно; проверочный платёж.
    await page.fill('#shop-shop_id', '800002');
    await page.fill('#shop-secret_key', 'live_emu_800002_dev_only');
    await page.click('text=Сохранить и проверить');
    await page.waitForSelector('.note--error');
    out.mismatch = (await page.locator('.note--error').first().innerText()).replace(/\s+/g, ' ');
    await screen(t, page, `${tag}-09-shop-mismatch`, scheme);
    await page.fill('#shop-shop_id', '800001');
    await page.fill('#shop-secret_key', 'test_emu_800001_dev_only');
    await page.click('text=Сохранить и проверить');
    await page.waitForSelector('text=Магазин сохранён');
    const shopText = await bodyText(page);
    assert.ok(!shopText.includes('test_emu_800001_dev_only'), 'ключ не показан целиком');
    await page.click('text=Отправить проверочный платёж 1 ₽');
    await page.waitForSelector('text=/Ждём/');
    emuSucceed(await providerOfCheck(clubId));
    await page.waitForSelector('text=/1 ₽ вернулся/', { timeout: 60_000 });
    await screen(t, page, `${tag}-10-shop-check-ok`, scheme);
    await page.click('text=Дальше: Контроллеры');

    // 7. Контроллеры: ручной ввод BLD1 и выбор стола.
    const f = provisionFactory(2, `${tag}-${Date.now()}`);
    const sim = startClaimSim({ qrs: f.devices.map((d) => d.qr), port, tag });
    sims.push(sim.pid);
    await page.waitForSelector('.dvs');
    await screen(t, page, `${tag}-11-devices-empty`, scheme);
    for (const [i, d] of f.devices.entries()) {
      await page.click('text=Ввести вручную');
      await page.fill('#dev-id', d.qr);
      await page.selectOption('#dev-table', { index: i });
      await page.click('form.bind__form button[type=submit]');
      await page.waitForSelector('text=/открыта/');
    }
    const tOnline = Date.now();
    await page.waitForSelector('text=На связи 2 из 2', { timeout: 120_000 });
    out.online = Math.round((Date.now() - tOnline) / 1000);
    await screen(t, page, `${tag}-12-devices-online`, scheme);
    await page.click('text=Дальше: QR-наклейки');

    // 8. Наклейки.
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=/Скачать PDF/')]);
    const pdf = await dl.path();
    out.pdf = readFileSync(pdf).subarray(0, 5).toString();
    await screen(t, page, `${tag}-13-stickers`, scheme);
    await page.click('text=Дальше: Тестовый режим');
    await page.waitForSelector('.tm__qr');
    await screen(t, page, `${tag}-14-test`, scheme);

    // 9. Запуск: 409 со списком, затем исправить (боевой магазин, касса выключена) и live.
    await page.click('text=Дальше: Запуск');
    await page.check('#gl-offer');
    await page.click('text=Перейти в боевой режим');
    await page.waitForSelector('text=Клуб ещё не готов');
    out.failed = (await page.locator('.cl__item--no').allInnerTexts().catch(() => [])).map((x) => x.replace(/\s+/g, ' ')).filter(Boolean);
    await screen(t, page, `${tag}-15-golive-409`, scheme);
    await page.click('.cl__go >> nth=0');
    await page.waitForURL(/payments/);
    await page.click('#shop-tab-live');
    await page.fill('#shop-shop_id', '800003');
    await page.fill('#shop-secret_key', 'live_emu_800003_dev_only');
    await page.click('text=Сохранить и проверить');
    await page.waitForSelector('.note--error');
    out.noFiscal = (await page.locator('.note--error').first().innerText()).replace(/\s+/g, ' ');
    await page.fill('#shop-shop_id', '800002');
    await page.fill('#shop-secret_key', 'live_emu_800002_dev_only');
    await page.click('text=Сохранить и проверить');
    await page.waitForSelector('text=Магазин сохранён');
    await page.click('text=Выключить кассу ресепшена');
    await page.waitForSelector('text=Включить кассу ресепшена');
    await screen(t, page, `${tag}-16-shops-live`, scheme);
    await page.goto(`${BASE}/club/c/${clubId}/onboarding/go_live`);
    await page.check('#gl-offer');
    await page.click('text=Перейти в боевой режим');
    await page.waitForSelector('text=Готово: клуб в боевом режиме.', { timeout: 30_000 });
    await page.waitForTimeout(800);
    out.banner = await page.locator('.modenote').count();
    await screen(t, page, `${tag}-17-live`, scheme);
    const { rows: c } = await db.query('select mode from bl.clubs where id = $1', [clubId]);
    out.mode = c[0].mode;
    const card = await waitFor(async () => {
      const { rows } = await db.query('select status from bl.club_public where club_id = $1', [clubId]);
      return rows[0]?.status ?? null;
    }, { timeoutMs: 30_000, what: 'карточка' });
    out.card = card;
    // Главный экран владельца после live — без плашки.
    await page.goto(`${BASE}/club/c/${clubId}/`, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    out.bannerHome = await page.locator('.modenote').count();
    return out;
  } catch (err) {
    await page.screenshot({ path: path.join(SHOTS, `${tag}-FAIL.png`), fullPage: true }).catch(() => {});
    err.message = `${err.message} (url ${page.url()}; шаги: ${JSON.stringify(out)})`;
    throw err;
  } finally {
    await ctx.close();
  }
}

test('владелец 1280 px, светлая тема (каждый экран — и тёмная): весь путь до live', { skip, timeout: 15 * 60_000 }, async (t) => {
  const out = await ownerFlow(t, { width: 1280, scheme: 'light', port: PORTS[0], tag: 'w1280' });
  saveState({ ui1280: out.clubId });
  t.diagnostic(`клуб ${out.clubId.slice(0, 8)}; ${out.drag}; меню ${out.menu} позиций; приглашение «${out.invite.slice(0, 120)}…»; боевой ключ в тестовом поле: «${out.mismatch}»; контроллеры на связи через ${out.online} с; наклейки ${out.pdf}; 409: ${out.failed.join(' | ')}; без чеков: «${out.noFiscal}»; после live: режим ${out.mode}, карточка ${out.card}, плашек в мастере ${out.banner}, на главной ${out.bannerHome}`);
  assert.equal(out.mode, 'live');
  assert.equal(out.card, 'platform');
  assert.equal(out.banner, 0, 'плашки тестового режима нет');
  assert.equal(out.bannerHome, 0);
  assert.equal(String(out.rAfterDrag), String(out.rAfterDragUi), 'поворот клавишей R после перетаскивания сохранён (экран = база)');
});

test('владелец 360 px, тёмная тема (каждый экран — и светлая): весь путь до live', { skip, timeout: 15 * 60_000 }, async (t) => {
  const out = await ownerFlow(t, { width: 360, scheme: 'dark', port: PORTS[1], tag: 'w360' });
  saveState({ ui360: out.clubId });
  t.diagnostic(`клуб ${out.clubId.slice(0, 8)}; зал: ${out.drag}; меню ${out.menu}; контроллеры на связи через ${out.online} с; 409: ${out.failed.join(' | ')}; после live: ${out.mode}, карточка ${out.card}, плашек ${out.banner}/${out.bannerHome}`);
  assert.equal(out.mode, 'live');
  assert.equal(out.banner, 0);
  assert.equal(out.bannerHome, 0);
});

test('гость 360 px в клубе в test: плашка «Тестовый режим клуба — деньги не списываются», обе темы', { skip }, async (t) => {
  const { loadState } = await import('./helpers.mjs');
  // Клуб в test: свежий клуб владельца-гостя с одним столом (создан через API).
  const { capi } = await import('./helpers.mjs');
  const { loginRetry } = await import('./helpers.mjs');
  const owner = await loginRetry(staffPhone(), { consent: false });
  const c = await capi('POST', '/api/clubs', { token: owner.token, body: { name: 'E2E M5 гостевой test', city_name: 'Екатеринбург', timezone: 'Asia/Yekaterinburg' } });
  const res = await capi('POST', `/api/clubs/${c.json.club_id}/resources`, { token: owner.token, club: c.json.club_id, body: { number: 1, kind: 'pyramid' } });
  const code = res.json.code;
  const guest = await newGuest();
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 360, height: 780 }, locale: 'ru-RU', timezoneId: 'Asia/Yekaterinburg', colorScheme: scheme, bypassCSP: true });
    await ctx.request.post(`${BASE}/api/auth/dev`, { data: { phone: guest.phone } });
    const page = await ctx.newPage();
    watch(page, `guest-${scheme}`);
    await page.goto(`${BASE}/t/${code}`, { waitUntil: 'load' });
    await page.waitForURL(/\/app\/t\//);
    await page.waitForTimeout(1500);
    const txt = await bodyText(page);
    t.diagnostic(`гость ${scheme}: «${(/Тестовый режим[^.]*\.?[^.]*/.exec(txt) ?? ['нет'])[0]}»`);
    assert.match(txt, /Тестовый режим клуба/);
    assert.match(txt, /деньги не списываются/);
    await checkOne(t, page, `guest-test-${scheme}`);
    await ctx.close();
  }
  void loadState;
});

test('итог по экранам: без прокрутки, без serious/critical axe, фокус виден; без ошибок страниц', { skip }, async (t) => {
  const hs = summary.filter((s) => s.hscroll).map((s) => s.name);
  const ax = summary.filter((s) => s.serious.length).map((s) => `${s.name}: ${s.serious.map((v) => `${v.id}/${v.impact}×${v.n} [${v.target}]`).join(', ')}`);
  const nf = summary.filter((s) => s.noFocus.length).map((s) => `${s.name}: ${s.noFocus.map((f) => `${f.tag} «${f.label}»`).join(', ')}`);
  t.diagnostic(`экранов ${summary.length}; прокрутка: ${hs.join(', ') || 'нет'}; axe serious/critical: ${ax.join(' | ') || 'нет'}; фокус не виден: ${nf.join(' | ') || 'нет'}; ошибки страниц: ${errors.join(' | ') || 'нет'}`);
  assert.deepEqual(hs, []);
  assert.deepEqual(ax, []);
  assert.deepEqual(errors, []);
});

void sleep;
