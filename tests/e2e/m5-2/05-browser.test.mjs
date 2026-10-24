// T29/T30 в браузере (Playwright, Chromium из /opt/pw-browsers): дашборд и отчёты M5.2 глазами
// владельца клуба сида. Два прохода: 1280×900 (светлая) и 360×780 (тёмная); на каждом экране — обе
// темы, без горизонтальной прокрутки страницы, axe без serious/critical, видимый фокус с клавиатуры,
// подписи для диктора у графиков (таблица-дубль или aria-label).
//   * дашборд: 5 вкладок за 7 дней, «Все мои клубы», пустое состояние (сутки без игр);
//   * числа на экране = API (выручка, игры за вчера);
//   * отчёты: смены, заказы, ревизии, списания, приходы, касса, «Кто играл», ведомость ревизии;
//   * «Экспорт в Excel» — файл скачивается (BOM, «;»);
//   * печать: «Напечатать» → PDF A4 (page.pdf в режиме print): несколько страниц, шапка таблицы на
//     каждой странице, без меню; ресепшну раздел «Дашборд» не открывается.
// playwright-core: E2E_PW_DIR или /opt/node-tools; axe-core — E2E_AXE_FILE или кэш npx. Скриншоты —
// E2E_SHOTS_DIR, PDF — туда же.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { addDays, BASE, CLUB_A, dash, loginWait, tv, workingDay } from './helpers.mjs';

const SHOTS = process.env.E2E_SHOTS_DIR || path.join(os.tmpdir(), 'bl-e2e-m52-shots');
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
const today = workingDay();
const yesterday = addDays(today, -1);
let browser;
const errors = [];
const summary = [];

before(async () => {
  if (skip) return;
  mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch();
});
after(async () => browser?.close());

function watch(page, tag) {
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 500) errors.push(`${tag}: ${r.status()} ${new URL(r.url()).pathname}`);
  });
}

async function checkOne(t, page, name) {
  await page.waitForTimeout(600);
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
  for (let i = 0; i < 4; i += 1) {
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
  // Графики: у каждого svg — имя для диктора (aria-label/aria-labelledby/title) или aria-hidden с таблицей рядом.
  const charts = await page.evaluate(() =>
    [...globalThis.document.querySelectorAll('main svg')]
      .filter((s) => s.getBoundingClientRect().width > 80 && s.getBoundingClientRect().height > 40)
      .map((s) => ({
        named: Boolean(s.getAttribute('aria-label') || s.getAttribute('aria-labelledby') || s.querySelector('title') || s.closest('[role=img][aria-label],figure[aria-label]')),
        hidden: s.getAttribute('aria-hidden') === 'true' || Boolean(s.closest('[aria-hidden=true]')),
        table: Boolean(s.closest('figure,section,.card,div')?.querySelector('table, button[aria-expanded], details')),
      })),
  );
  const unnamed = charts.filter((c) => !c.named && !(c.hidden && c.table));
  const noFocus = focus.filter((f) => f && !f.visible);
  const hs = w.sw > w.iw + 1;
  summary.push({ name, hscroll: hs, serious, noFocus, unnamed: unnamed.length });
  t.diagnostic(`${name}: ${hs ? `ПРОКРУТКА ${w.sw}>${w.iw}` : 'без прокрутки'}; ${axe}; фокус ${focus.filter(Boolean).length}/4${noFocus.length ? ` (НЕ ВИДЕН: ${noFocus.map((f) => `${f.tag} «${f.label}»`).join(', ')})` : ' виден'}; графиков ${charts.length}${unnamed.length ? `, без подписи ${unnamed.length}` : ''}`);
}

async function screen(t, page, name, scheme) {
  await checkOne(t, page, `${name}-${scheme}`);
  const other = scheme === 'light' ? 'dark' : 'light';
  await page.emulateMedia({ colorScheme: other });
  await checkOne(t, page, `${name}-${other}`);
  await page.emulateMedia({ colorScheme: scheme });
}

const bodyText = (page) => page.evaluate(() => globalThis.document.body.innerText.replace(/\s+/g, ' '));
const rub = (k) => `${new Intl.NumberFormat('ru-RU').format(Math.round(k / 100)).replace(/ /g, ' ')}`;

async function ownerContext({ width, scheme, phone = '+70000000001' }) {
  const viewport = width >= 1000 ? { width, height: 900 } : { width, height: 780 };
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport, locale: 'ru-RU', timezoneId: 'Asia/Yekaterinburg', colorScheme: scheme, deviceScaleFactor: 1, acceptDownloads: true, bypassCSP: true });
  const r = await ctx.request.post(`${BASE}/api/auth/dev`, { data: { phone } });
  assert.ok(r.ok(), `вход ${r.status()}`);
  return ctx;
}

async function dashboardPass(t, { width, scheme, tag }) {
  const ctx = await ownerContext({ width, scheme });
  const page = await ctx.newPage();
  watch(page, tag);
  try {
    await page.goto(`${BASE}/club/`, { waitUntil: 'load' });
    await page.waitForURL(/\/dashboard/, { timeout: 20_000 });
    t.diagnostic(`${tag}: главный экран владельца — ${new URL(page.url()).pathname}`);
    for (const tab of ['summary', 'money', 'hall', 'guests', 'control']) {
      await page.goto(`${BASE}/club/c/${CLUB_A}/dashboard?tab=${tab}&p=7d`, { waitUntil: 'load' });
      await page.waitForSelector('main [role=tablist], main .dtabs, main h1', { timeout: 15_000 });
      await page.waitForTimeout(1200);
      await screen(t, page, `${tag}-dash-${tab}`, scheme);
    }
    // Числа на экране = API: вчера, сводка.
    await page.goto(`${BASE}/club/c/${CLUB_A}/dashboard?tab=summary&p=custom&from=${yesterday}&to=${yesterday}`, { waitUntil: 'load' });
    await page.waitForTimeout(2000);
    const own = await loginWait('+70000000001');
    const api = (await dash(own.token, CLUB_A, { from: yesterday, to: yesterday, tab: 'summary' })).json;
    const text = await bodyText(page);
    assert.ok(text.includes(rub(tv(api, 'revenue'))), `выручка ${rub(tv(api, 'revenue'))} ₽ на экране`);
    assert.ok(text.includes(String(tv(api, 'games'))), `игр ${tv(api, 'games')} на экране`);
    // Все мои клубы.
    await page.goto(`${BASE}/club/c/${CLUB_A}/dashboard?tab=summary&p=7d&all=1`, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    await screen(t, page, `${tag}-dash-all`, scheme);
    // Пустое состояние: сутки создания клуба сида (игр не было).
    await page.goto(`${BASE}/club/c/${CLUB_A}/dashboard?tab=summary&p=custom&from=2026-10-21&to=2026-10-21`, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    const empty = await bodyText(page);
    assert.match(empty, /За этот период игр не было/, 'честное пустое состояние');
    await screen(t, page, `${tag}-dash-empty`, scheme);
    // Отчёты.
    for (const r of ['shifts', 'orders', 'audits', 'writeoffs', 'arrivals', 'cashbook', 'players', 'audit-sheet']) {
      await page.goto(`${BASE}/club/c/${CLUB_A}/reports/${r}`, { waitUntil: 'load' });
      await page.waitForTimeout(1500);
      await screen(t, page, `${tag}-rep-${r}`, scheme);
    }
  } finally {
    await ctx.close();
  }
}

test('браузер 1280×900, светлая: дашборд (5 вкладок, все клубы, пусто) и 8 отчётов — обе темы, axe, фокус', { skip, timeout: 15 * 60_000 }, async (t) => {
  await dashboardPass(t, { width: 1280, scheme: 'light', tag: 'w1280' });
});

test('браузер 360×780, тёмная: дашборд и отчёты — без прокрутки, обе темы, axe, фокус', { skip, timeout: 15 * 60_000 }, async (t) => {
  await dashboardPass(t, { width: 360, scheme: 'dark', tag: 'w360' });
});

test('браузер: «Экспорт в Excel» скачивает CSV (BOM, «;»); «Напечатать» → PDF A4, шапка таблицы на каждой странице', { skip, timeout: 10 * 60_000 }, async (t) => {
  const ctx = await ownerContext({ width: 1280, scheme: 'light' });
  const page = await ctx.newPage();
  watch(page, 'print');
  try {
    const month = `${today.slice(0, 8)}01`;
    await page.goto(`${BASE}/club/c/${CLUB_A}/reports/orders?from=2026-10-22&to=${today}`, { waitUntil: 'load' });
    await page.waitForSelector('table, .dtable', { timeout: 20_000 });
    await page.waitForTimeout(1500);
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), page.getByRole('button', { name: 'Экспорт в Excel' }).click()]);
    const file = path.join(SHOTS, dl.suggestedFilename());
    await dl.saveAs(file);
    const buf = readFileSync(file);
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM');
    assert.ok(buf.toString('utf8').split('\r\n')[0].includes(';'), 'разделитель «;»');
    // Печать: окно печати подменяем, страницы догружаются кнопкой, затем PDF в режиме print.
    await page.evaluate(() => {
      globalThis.__printed = 0;
      globalThis.print = () => {
        globalThis.__printed += 1;
      };
    });
    await page.getByRole('button', { name: 'Напечатать' }).click();
    await page.waitForFunction(() => globalThis.__printed > 0, null, { timeout: 30_000 });
    await page.emulateMedia({ media: 'print' });
    const rows = await page.evaluate(() => globalThis.document.querySelectorAll('tbody tr').length);
    const headRepeat = await page.evaluate(() => {
      const th = globalThis.document.querySelector('thead');
      return th ? globalThis.getComputedStyle(th).display : null;
    });
    const navHidden = await page.evaluate(() => [...globalThis.document.querySelectorAll('nav, header.topbar, .no-print')].every((el) => globalThis.getComputedStyle(el).display === 'none' || el.getBoundingClientRect().height === 0));
    const pdfPath = path.join(SHOTS, 'orders-a4.pdf');
    writeFileSync(pdfPath, await page.pdf({ format: 'A4', printBackground: false, preferCSSPageSize: true }));
    const info = spawnSync('pdfinfo', [pdfPath], { encoding: 'utf8' }).stdout;
    const pages = Number(/Pages:\s+(\d+)/.exec(info)?.[1] ?? 0);
    const size = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(info);
    const txt = spawnSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8' }).stdout;
    const perPage = txt.split('\f').filter((p) => p.trim());
    const headerWord = (await page.evaluate(() => globalThis.document.querySelector('thead th')?.textContent?.trim())) ?? '';
    const withHeader = perPage.filter((p) => p.includes(headerWord)).length;
    t.diagnostic(`CSV ${dl.suggestedFilename()} ${buf.length} байт; печать: строк ${rows}, thead display=${headRepeat}, меню скрыто: ${navHidden}; PDF ${pages} стр., ${size ? `${Math.round(size[1])}×${Math.round(size[2])} pt` : '?'}, шапка «${headerWord}» на ${withHeader} из ${perPage.length} стр.; «Стр. N из M»: ${/Стр\.\s*\d+\s*из\s*\d+/.test(txt)}`);
    assert.ok(size && Math.abs(Number(size[1]) - 595) < 3 && Math.abs(Number(size[2]) - 842) < 3, 'A4');
    assert.ok(pages >= 2, `несколько страниц (${pages}) — проверка повторения шапки`);
    assert.equal(withHeader, perPage.length, 'шапка таблицы на каждой странице');
    assert.ok(navHidden, 'без меню и кнопок');
    void month;
  } finally {
    await ctx.close();
  }
});

test('браузер: ресепшну раздел «Дашборд» и отчёты не открываются', { skip, timeout: 3 * 60_000 }, async (t) => {
  const ctx = await ownerContext({ width: 360, scheme: 'light', phone: '+70000000004' });
  const page = await ctx.newPage();
  try {
    const seen = [];
    for (const p of ['dashboard', 'reports/cashbook', 'reports/players']) {
      await page.goto(`${BASE}/club/c/${CLUB_A}/${p}`, { waitUntil: 'load' });
      await page.waitForTimeout(1500);
      const text = await bodyText(page);
      seen.push(`${p} → ${new URL(page.url()).pathname.replace(CLUB_A, '{A}')} «${text.slice(0, 60)}»`);
      assert.doesNotMatch(text, /Чистая выручка|Остаток на конец|Показать телефон/, `${p}: данных нет`);
    }
    t.diagnostic(seen.join('; '));
  } finally {
    await ctx.close();
  }
});

test('браузер: итог — без прокрутки, axe без serious/critical, фокус виден, графики подписаны, без ошибок страницы', { skip }, () => {
  const bad = summary.filter((s) => s.hscroll || s.serious.length || s.noFocus.length || s.unnamed);
  assert.deepEqual(errors, [], 'ошибок страницы и 5xx нет');
  assert.deepEqual(
    bad.map((s) => `${s.name}: ${s.hscroll ? 'прокрутка; ' : ''}${s.serious.map((v) => `${v.id}/${v.impact}`).join(',')}${s.noFocus.length ? ' фокус не виден' : ''}${s.unnamed ? ` графиков без подписи ${s.unnamed}` : ''}`),
    [],
  );
});
