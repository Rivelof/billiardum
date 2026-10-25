// Браузер для приёмки M5.5/M5.8: playwright-core (E2E_PW_DIR или /opt/node-tools), Chromium из
// /opt/pw-browsers, axe-core (E2E_AXE_FILE или кэш npx). Проверка экрана в обеих темах: прокрутка
// страницы вбок, axe (serious/critical), видимый фокус с клавиатуры, скриншот. Вход для разработки —
// POST /api/auth/dev в контексте браузера (cookie сессии). Самоподписанный сертификат Caddy стенда —
// ignoreHTTPSErrors только для localhost стенда.
// Плюс сканер слов «стол» / «корт» (T48): `wording(page)` — какие мелкие блоки текста называют один ресурс обоими словами.

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BASE } from './lib.mjs';

export const SHOTS = process.env.E2E_SHOTS_DIR || path.join(os.tmpdir(), 'bl-e2e-m58-shots');
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
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport, locale: 'ru-RU', timezoneId: 'Asia/Yekaterinburg', colorScheme: scheme, deviceScaleFactor: 1, bypassCSP: true });
  for (let i = 0; i < 6; i += 1) {
    const r = await ctx.request.post(`${BASE}/api/auth/dev`, { data: { phone } });
    if (r.ok()) {
      // Гостю принимаем согласие (иначе экран согласия закрывает приложение).
      const me = await (await ctx.request.get(`${BASE}/api/me`)).json().catch(() => null);
      if (me?.user && !me.user.consent?.accepted && me.user.consent?.version) await ctx.request.post(`${BASE}/api/auth/consent`, { data: { version: me.user.consent.version } });
      return ctx;
    }
    if (r.status() !== 429) throw new Error(`вход ${r.status()}`);
    await new Promise((res) => setTimeout(res, 15_000));
  }
  throw new Error('вход: 429');
}

export async function checkOne(t, page, name) {
  await page.waitForTimeout(500);
  const w = await page.evaluate(() => {
    const iw = globalThis.innerWidth;
    const sw = globalThis.document.documentElement.scrollWidth;
    // Кто вылезает за правый край (первые листья): класс элемента — для отчёта.
    const culprits = [];
    if (sw > iw + 1) {
      for (const el of globalThis.document.querySelectorAll('body *')) {
        const rc = el.getBoundingClientRect();
        let clipped = false;
        for (let a = el.parentElement; a && a !== globalThis.document.body; a = a.parentElement) {
          if (globalThis.getComputedStyle(a).overflowX !== 'visible') {
            clipped = true;
            break;
          }
        }
        if (!clipped && rc.width > 0 && rc.right > iw + 1 && !el.closest('svg')) culprits.push(String(el.className?.baseVal ?? el.className ?? el.tagName).split(' ')[0] || el.tagName.toLowerCase());
        if (culprits.length >= 5) break;
      }
    }
    return { sw, iw, culprits };
  });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
  let serious = [];
  let all = [];
  let axe = 'axe нет';
  if (AXE) {
    if (!(await page.evaluate(() => Boolean(globalThis.axe)))) await page.addScriptTag({ content: AXE });
    const res = await page.evaluate(async () => {
      const r = await globalThis.axe.run(globalThis.document, { resultTypes: ['violations'] });
      return r.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, target: v.nodes[0]?.target?.join(' '), html: v.nodes[0]?.html?.slice(0, 160) }));
    });
    serious = res.filter((v) => ['serious', 'critical'].includes(v.impact));
    all = res;
    axe = res.length ? res.map((v) => `${v.id}/${v.impact}×${v.n}${['serious', 'critical'].includes(v.impact) ? ` [${v.target}]` : ''}`).join(',') : 'axe 0';
  }
  const focus = [];
  await page.evaluate(() => globalThis.document.activeElement?.blur?.());
  for (let i = 0; i < 5; i += 1) {
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
  summary.push({ name, hscroll: hs, sw: w.sw, iw: w.iw, culprits: w.culprits, serious, all, noFocus });
  t.diagnostic(`${name}: ${hs ? `ПРОКРУТКА ${w.sw}>${w.iw} (${w.culprits.join(', ')})` : 'без прокрутки'}; ${axe}; фокус ${focus.filter(Boolean).length}/5${noFocus.length ? ` (НЕ ВИДЕН: ${noFocus.map((f) => `${f.tag} «${f.label}»`).join(', ')})` : ' виден'}`);
  return { serious, all, hscroll: hs };
}

/** Экран в обеих темах: сначала scheme, затем вторая. */
export async function screen(t, page, name, scheme) {
  const a = await checkOne(t, page, `${name}-${scheme}`);
  const other = scheme === 'light' ? 'dark' : 'light';
  await page.emulateMedia({ colorScheme: other });
  const b = await checkOne(t, page, `${name}-${other}`);
  await page.emulateMedia({ colorScheme: scheme });
  return [a, b];
}

export const bodyText = (page) => page.evaluate(() => globalThis.document.body.innerText.replace(/\s+/g, ' '));

/**
 * Сканер слов T48. Ищет самые мелкие видимые блоки (до 400 знаков), где вместе с подписью «Корт N» стоит слово «стол…»
 * в нижнем регистре (и наоборот: подпись «Стол N» и слово «корт…»). Обороты «стол или корт», «столы и корты», «стол/корт»
 * вычищаются: там смешение законно (экран про оба вида). Соседние подписи строк («Корт 2 … Стол 1 …») не считаются:
 * подпись пишется с заглавной, слово в тексте — со строчной.
 *   courtWithTable — «Корт N» рядом (до 80 знаков) со словом «стол…», tableWithCourt — «Стол N» рядом со словом «корт…».
 * `mixed` — блоки, где в нижнем регистре встречаются оба слова вне оборотов (экран про один вид не должен их смешивать).
 */
export function wording(page) {
  return page.evaluate(() => {
    const WORD = '(?:[Сс]тол\\p{L}*|[Кк]орт\\p{L}*)';
    const pair = new RegExp(`${WORD}\\s*(?:и|или|/|,|—|–|-)\\s*${WORD}`, 'gu');
    const strip = (s) => s.replace(pair, '').replace(pair, '');
    const lowTable = '(?<!\\p{L})стол\\p{L}*';
    const lowCourt = '(?<!\\p{L})корт\\p{L}*';
    const reCourtThenTable = new RegExp(`Корт\\s*\\d+[\\s\\S]{0,80}?${lowTable}|${lowTable}[\\s\\S]{0,80}?Корт\\s*\\d+`, 'u');
    const reTableThenCourt = new RegExp(`Стол\\s*\\d+[\\s\\S]{0,80}?${lowCourt}|${lowCourt}[\\s\\S]{0,80}?Стол\\s*\\d+`, 'u');
    const reMixed = new RegExp(`${lowTable}[\\s\\S]*${lowCourt}|${lowCourt}[\\s\\S]*${lowTable}`, 'u');
    const out = { mixed: [], courtWithTable: [], tableWithCourt: [] };
    const visible = (el) => {
      const cs = globalThis.getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const textOf = (el) => strip((el.innerText ?? '').replace(/\s+/g, ' ').trim());
    const scan = (re, bucket) => {
      for (const el of globalThis.document.body.querySelectorAll('*')) {
        if (['SCRIPT', 'STYLE', 'SVG', 'PATH'].includes(el.tagName.toUpperCase()) || !visible(el)) continue;
        const text = (el.innerText ?? '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 400 || !re.test(strip(text))) continue;
        const deeper = [...el.children].some((c) => visible(c) && re.test(textOf(c)));
        if (!deeper) bucket.push(text);
      }
    };
    scan(reMixed, out.mixed);
    scan(reCourtThenTable, out.courtWithTable);
    scan(reTableThenCourt, out.tableWithCourt);
    for (const k of Object.keys(out)) out[k] = [...new Set(out[k])];
    return out;
  });
}

/** Слово «стол…» в тексте страницы вне оборотов «стол или корт» (для экранов, целиком про корт). */
export function tableWords(page) {
  return page.evaluate(() => {
    const WORD = '(?:стол\\p{L}*|корт\\p{L}*)';
    const pair = new RegExp(`${WORD}\\s*(?:и|или|/|,|—|–|-)\\s*${WORD}`, 'giu');
    const text = globalThis.document.body.innerText.replace(/\s+/g, ' ');
    const stripped = text.replace(pair, '').replace(pair, '');
    return [...stripped.matchAll(/.{0,40}стол\p{L}*.{0,40}/giu)].map((m) => m[0]);
  });
}
