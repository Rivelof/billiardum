// Общее для браузерных перепроверок M5.2/M5.3: Playwright (playwright-core из E2E_PW_DIR или /opt/node-tools,
// Chromium из /opt/pw-browsers), axe-core (E2E_AXE_FILE или кэш npx), проверка экрана в обеих темах:
// прокрутка страницы, axe (serious/critical и весь список), видимый фокус с клавиатуры, скриншот.

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BASE } from './helpers.mjs';

export const SHOTS = process.env.E2E_SHOTS_DIR || path.join(os.tmpdir(), 'bl-e2e-m52-shots');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/opt/pw-browsers';
mkdirSync(SHOTS, { recursive: true });

export let chromium = null;
export let skip = false;
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
export const AXE = axeSource();

export const summary = [];
export const errors = [];

export function watch(page, tag) {
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 500) errors.push(`${tag}: ${r.status()} ${new URL(r.url()).pathname}`);
  });
}

export async function newCtx(browser, { width, scheme, phone }) {
  const viewport = width >= 1000 ? { width, height: 900 } : { width, height: 780 };
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport, locale: 'ru-RU', timezoneId: 'Asia/Yekaterinburg', colorScheme: scheme, deviceScaleFactor: 1, acceptDownloads: true, bypassCSP: true });
  const r = await ctx.request.post(`${BASE}/api/auth/dev`, { data: { phone } });
  if (!r.ok()) throw new Error(`вход ${r.status()}`);
  return ctx;
}

export async function checkOne(t, page, name) {
  await page.waitForTimeout(600);
  const w = await page.evaluate(() => ({ sw: globalThis.document.documentElement.scrollWidth, iw: globalThis.innerWidth }));
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
  let serious = [];
  let all = [];
  let axe = 'axe нет';
  if (AXE) {
    if (!(await page.evaluate(() => Boolean(globalThis.axe)))) await page.addScriptTag({ content: AXE });
    const res = await page.evaluate(async () => {
      const r = await globalThis.axe.run(globalThis.document, { resultTypes: ['violations'] });
      return r.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, target: v.nodes[0]?.target?.join(' ') }));
    });
    serious = res.filter((v) => ['serious', 'critical'].includes(v.impact));
    all = res;
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
  const noFocus = focus.filter((f) => f && !f.visible);
  const hs = w.sw > w.iw + 1;
  summary.push({ name, hscroll: hs, serious, all, noFocus });
  t.diagnostic(`${name}: ${hs ? `ПРОКРУТКА ${w.sw}>${w.iw}` : 'без прокрутки'}; ${axe}; фокус ${focus.filter(Boolean).length}/4${noFocus.length ? ` (НЕ ВИДЕН: ${noFocus.map((f) => `${f.tag} «${f.label}»`).join(', ')})` : ' виден'}`);
  return { serious, all };
}

export async function screen(t, page, name, scheme) {
  const a = await checkOne(t, page, `${name}-${scheme}`);
  const other = scheme === 'light' ? 'dark' : 'light';
  await page.emulateMedia({ colorScheme: other });
  const b = await checkOne(t, page, `${name}-${other}`);
  await page.emulateMedia({ colorScheme: scheme });
  return [a, b];
}

export const bodyText = (page) => page.evaluate(() => globalThis.document.body.innerText.replace(/\s+/g, ' '));
