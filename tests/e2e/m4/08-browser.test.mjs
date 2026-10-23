// Браузер (Playwright, Chromium из /opt/pw-browsers): ключевые экраны M4 на 360 px в светлой и
// тёмной теме — без горизонтальной прокрутки, axe без нарушений serious/critical, видимый фокус с
// клавиатуры. Сценарии: ник Бильярдум+, подтверждение партии соперником (T22 в интерфейсе),
// заявка в клуб без программы (T25) и её статус, отзыв, турниры, «Добавить/Подтвердить клуб»,
// ссылка клуба «Ответить на заявку»; сайт (главная, город, клуб, турниры, турнир, рейтинг,
// Бильярдум+, «Для клубов»); ТВ-сетка турнира без входа (1280×720).
//
// playwright-core: E2E_PW_DIR или /opt/node-tools; axe-core — из кэша npx (lighthouse) или
// E2E_AXE_FILE. Стол E2E_UI_TABLE (по умолчанию 1). Скриншоты — E2E_SHOTS_DIR.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  BASE,
  CLUB_A,
  DEMO_LISTING,
  ensureFree,
  newGuest,
  ok,
  phonesIn,
  plusProfile,
  startGame,
  tableCode,
  waitFor,
} from './helpers.mjs';

const TABLE = Number(process.env.E2E_UI_TABLE || 1);
const SHOTS = process.env.E2E_SHOTS_DIR || path.join(os.tmpdir(), 'bl-e2e-m4-shots');
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
let game;
let tid;
const P = {};
const errors = [];
const summary = [];
const sessions = new Map(); // телефон → cookies входа (вход для разработки ограничен 30 в минуту)

before(async () => {
  if (skip) return;
  mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch();
  db = await adminClient();
  const { rows } = await db.query("select id from bl.tournaments where club_id = $1 and status = 'finished' order by created_at desc limit 1", [CLUB_A]);
  tid = rows[0]?.id ?? null;
});

after(async () => {
  if (game?.sessionId) await api('POST', `/api/sessions/${game.sessionId}/stop`, { token: game.guest.token, body: {} }).catch(() => {});
  await browser?.close();
  await db?.end();
});

async function context(phone, { scheme = 'light', viewport = { width: 360, height: 780 } } = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport, locale: 'ru-RU', timezoneId: 'Asia/Yekaterinburg', colorScheme: scheme, deviceScaleFactor: 1, bypassCSP: true });
  if (phone) {
    if (sessions.has(phone)) {
      await ctx.addCookies(sessions.get(phone));
    } else {
      const r = await ctx.request.post(`${BASE}/api/auth/dev`, { data: { phone } });
      if (!r.ok()) throw new Error(`вход: ${r.status()}`);
      sessions.set(phone, await ctx.cookies());
    }
  }
  return ctx;
}

function watch(page, tag) {
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 500) errors.push(`${tag}: ${r.status()} ${new URL(r.url()).pathname}`);
  });
}

const text = (page) => page.evaluate(() => globalThis.document.body.innerText.replace(/\s+/g, ' '));

/** Проверки экрана: прокрутка, axe, фокус; скриншот. → строка итога */
async function check(t, page, name) {
  await page.waitForTimeout(1200);
  const w = await page.evaluate(() => ({ sw: globalThis.document.documentElement.scrollWidth, iw: globalThis.innerWidth }));
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
  let axe = 'axe нет';
  let serious = [];
  if (AXE) {
    await page.addScriptTag({ content: AXE });
    const res = await page.evaluate(async () => {
      const r = await globalThis.axe.run(globalThis.document, { resultTypes: ['violations'] });
      return r.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, target: v.nodes[0]?.target?.join(' ') }));
    });
    serious = res.filter((v) => ['serious', 'critical'].includes(v.impact));
    axe = res.length ? res.map((v) => `${v.id}/${v.impact}×${v.n}`).join(',') : 'axe 0';
  }
  // Клавиатура: три Tab — у элемента с фокусом видимый индикатор (outline или box-shadow).
  await page.mouse.click(1, 1).catch(() => {});
  const focus = [];
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
  const line = `${name}: ${w.sw <= w.iw + 1 ? 'без прокрутки' : `ПРОКРУТКА ${w.sw}>${w.iw}`}; ${axe}; фокус ${focus.filter(Boolean).length}/3${noFocus.length ? ` (НЕ ВИДЕН: ${noFocus.map((f) => `${f.tag} «${f.label}»`).join(', ')})` : ' виден'}`;
  summary.push({ name, hscroll: w.sw > w.iw + 1, serious, noFocus });
  t.diagnostic(line);
  return line;
}

async function both(t, phone, url, name, fn) {
  for (const scheme of ['light', 'dark']) {
    const ctx = await context(phone, { scheme });
    const page = await ctx.newPage();
    watch(page, `${name}-${scheme}`);
    await page.goto(`${BASE}${url}`, { waitUntil: 'load' });
    if (fn) await fn(page, scheme);
    await check(t, page, `${name}-${scheme}`);
    await ctx.close();
  }
}

test('гость 360 px: ник Бильярдум+ в интерфейсе', { skip }, async (t) => {
  P.c = await newGuest();
  const ctx = await context(P.c.phone);
  const page = await ctx.newPage();
  watch(page, 'nick');
  await page.goto(`${BASE}/app/plus`, { waitUntil: 'load' });
  await page.getByLabel('Ник', { exact: true }).fill('аб');
  await page.getByRole('button', { name: 'Сохранить ник' }).click();
  await page.getByText('От 3 до 20 букв').waitFor({ timeout: 5000 });
  await check(t, page, 'plus-nick-error');
  const nick = `ui_${String(Date.now()).slice(-6)}x`;
  await page.getByLabel('Ник', { exact: true }).fill(nick);
  await page.getByRole('button', { name: 'Сохранить ник' }).click();
  await page.getByText(nick).first().waitFor({ timeout: 10_000 });
  const me = await ok(api('GET', '/api/plus/me', { token: P.c.token }));
  assert.equal(me.nick, nick);
  await check(t, page, 'plus-profile-light');
  await ctx.close();
  await both(t, P.c.phone, '/app/plus', 'plus-profile');
  await both(t, P.c.phone, '/app/plus/rating', 'plus-rating');
  await both(t, P.c.phone, '/app/plus/friends', 'plus-friends');
  await both(t, P.c.phone, '/app/plus/rivals', 'plus-rivals');
});

test('T22 в интерфейсе: соперник открывает партию по ссылке из уведомления и подтверждает', { skip }, async (t) => {
  await ensureFree(TABLE);
  P.a = await newGuest();
  P.b = await newGuest();
  await plusProfile(P.a);
  await plusProfile(P.b);
  game = await startGame(TABLE, 30, { guest: P.a });
  await ok(api('POST', `/api/sessions/${game.sessionId}/join`, { token: P.b.token, body: { code: tableCode(TABLE) } }));
  const m = await ok(api('POST', '/api/plus/matches', { token: P.a.token, body: { session_id: game.sessionId, discipline: 'pyramid', opponent_id: P.b.user.id, my_score: 8, opponent_score: 5 } }), 201);
  P.matchId = m.id;
  for (const scheme of ['dark']) {
    const ctx = await context(P.b.phone, { scheme });
    const page = await ctx.newPage();
    watch(page, 'match');
    await page.goto(`${BASE}/app/plus/matches/${m.id}`, { waitUntil: 'load' });
    await check(t, page, `match-pending-${scheme}`);
    await page.getByRole('button', { name: /Подтвердить/ }).click();
    const done = await waitFor(
      async () => {
        const x = await ok(api('GET', '/api/plus/matches', { token: P.b.token }));
        return x.items.find((y) => y.id === m.id && y.counted) ?? null;
      },
      { timeoutMs: 10_000, intervalMs: 300, what: 'партия засчитана' },
    );
    await page.waitForTimeout(500);
    const txt = await text(page);
    await check(t, page, `match-confirmed-${scheme}`);
    t.diagnostic(`B подтвердил в интерфейсе: counted=${done.counted}, Δ ${JSON.stringify(done.rating_delta)}; на экране: «${txt.slice(0, 200)}»`);
    await ctx.close();
  }
  await both(t, P.a.phone, `/app/s/${game.sessionId}`, 'game-with-plus');
});

test('подтверждённая партия: кнопка «Счёт неверный» не предлагает спор, который сервер отклонит', { skip }, async (t) => {
  assert.ok(P.matchId);
  const ctx = await context(P.b.phone);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app/plus/matches/${P.matchId}`, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const btn = page.getByRole('button', { name: 'Счёт неверный' });
  const visible = await btn.isVisible().catch(() => false);
  let shown = '';
  if (visible) {
    await btn.click();
    await page.locator('#dsp-reason').fill('Счёт был 8:6 (e2e)');
    await page.getByRole('button', { name: 'Отправить управляющему' }).click();
    await page.waitForTimeout(1500);
    shown = await text(page);
    await page.screenshot({ path: path.join(SHOTS, 'match-dispute-after-confirm.png') });
  }
  const m = (await ok(api('GET', '/api/plus/matches', { token: P.b.token }))).items.find((x) => x.id === P.matchId);
  await ctx.close();
  t.diagnostic(`партия ${m.status}/counted=${m.counted}; кнопка «Счёт неверный» ${visible ? 'ПОКАЗАНА' : 'скрыта'}${visible ? `; после отправки на экране: «${shown.slice(0, 260)}»` : ''}`);
  assert.equal(visible, false, 'спор после подтверждения: кнопка есть, сервер отвечает 409 match_not_pending');
});

test('T25 в интерфейсе: заявка в клуб без программы → экран статуса', { skip }, async (t) => {
  const g = await newGuest();
  const ctx = await context(g.phone);
  const page = await ctx.newPage();
  watch(page, 'request');
  await page.goto(`${BASE}/app/request/${DEMO_LISTING}`, { waitUntil: 'load' });
  await check(t, page, 'request-form-light');
  await page.getByRole('radio', { name: /Завтра/ }).check({ force: true });
  await page.getByLabel('Пожелания').fill('Стол у окна (e2e)');
  await page.getByRole('button', { name: /Отправить заявку/ }).click();
  await page.waitForURL(/\/app\/requests\//, { timeout: 10_000 });
  const id = page.url().split('/requests/')[1].split(/[?#]/)[0];
  await page.waitForTimeout(1000);
  const st = await ok(api('GET', `/api/clubs/requests/${id}`, { token: g.token }));
  const txt = await text(page);
  await check(t, page, 'request-status-light');
  await ctx.close();
  await both(t, g.phone, `/app/requests/${id}`, 'request-status');
  await ok(api('POST', `/api/clubs/requests/${id}/cancel`, { token: g.token, body: {} }));
  t.diagnostic(`заявка ${id.slice(0, 8)} статус ${st.status}; на экране: «${txt.slice(0, 220)}»`);
});

test('отзыв, турниры, «Добавить клуб», «Подтвердить клуб» — 360 px, обе темы', { skip }, async (t) => {
  assert.ok(P.a, 'нужен гость с игрой');
  await both(t, P.a.phone, `/app/review/${CLUB_A}`, 'review');
  await both(t, P.a.phone, '/app/tournaments', 'tournaments');
  if (tid) await both(t, P.a.phone, `/app/tournaments/${tid}`, 'tournament');
  await both(t, P.a.phone, '/app/directory/add', 'directory-add');
  await both(t, P.a.phone, `/app/directory/claim/${DEMO_LISTING}`, 'directory-claim');
  // Отзыв через интерфейс: звёзды и текст.
  const ctx = await context(P.a.phone);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app/review/${CLUB_A}`, { waitUntil: 'load' });
  await page.locator('.stars__item').nth(4).click();
  await page.locator('#rv-text').fill('Удобное приложение, свет включился сразу (e2e)');
  await page.getByRole('button', { name: /Отправить|Сохранить|Опубликовать/ }).click();
  const mine = await waitFor(
    async () => {
      const x = await api('GET', `/api/reviews/mine?club_id=${CLUB_A}`, { token: P.a.token });
      return x.json?.rating === 5 ? x.json : null;
    },
    { timeoutMs: 10_000, intervalMs: 300, what: 'отзыв сохранён' },
  );
  await check(t, page, 'review-sent-light');
  await ctx.close();
  t.diagnostic(`отзыв из интерфейса: ${mine.rating}★ «${mine.text}»`);
});

test('ссылка клуба «Ответить на заявку» (/app/club-request/{id}?t=…) открывает экран ответа', { skip }, async (t) => {
  const { rows } = await db.query("select id from bl.club_requests order by created_at desc limit 1");
  const ctx = await context(null);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app/club-request/${rows[0].id}?t=${'x'.repeat(43)}`, { waitUntil: 'load' });
  const txt = await text(page);
  await check(t, page, 'club-request-link');
  await ctx.close();
  t.diagnostic(`экран по ссылке клуба: «${txt.slice(0, 200)}»`);
  assert.ok(!/не найден|страницы нет|404/i.test(txt), 'ссылка из уведомления клубу ведёт на «страница не найдена»');
});

test('сайт 360 px, обе темы: главная, город, клуб, турниры, рейтинг, Бильярдум+, «Для клубов»', { skip }, async (t) => {
  const pages = [
    ['/', 'site-home'],
    ['/ekaterinburg/', 'site-city'],
    ['/ekaterinburg/testovyy-klub/', 'site-club'],
    ['/ekaterinburg/demo-bez-programmy/', 'site-club-listed'],
    ['/turniry/', 'site-tournaments'],
    ...(tid ? [[`/turniry/${tid}/`, 'site-tournament']] : []),
    ['/rejting/', 'site-rating'],
    ['/plus/', 'site-plus'],
    ['/dlya-klubov/', 'site-for-clubs'],
  ];
  for (const [url, name] of pages) await both(t, null, url, name);
});

test('ТВ-сетка турнира без входа (1280×720): ники и счёт, без ПДн', { skip }, async (t) => {
  if (!tid) return t.skip('нет сыгранного турнира');
  const ctx = await context(null, { viewport: { width: 1280, height: 720 }, scheme: 'dark' });
  const page = await ctx.newPage();
  watch(page, 'tv');
  await page.goto(`${BASE}/club/tv/tournament/${tid}`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  const txt = await text(page);
  await page.screenshot({ path: path.join(SHOTS, 'tv.png') });
  const pub = await ok(api('GET', `/api/public/tournaments/${tid}`));
  const nicks = pub.entries.map((e) => e.nick);
  const shown = nicks.filter((n) => txt.includes(n));
  await ctx.close();
  t.diagnostic(`ТВ: «${txt.slice(0, 200)}»; ников на экране ${shown.length}/${nicks.length}; телефоны: ${phonesIn(txt).length}`);
  assert.ok(!/Войти|Вход по телефону|PIN/i.test(txt) || shown.length > 0, 'ТВ без входа');
  assert.equal(shown.length, nicks.length);
  assert.deepEqual(phonesIn(txt), []);
});

test('итог по экранам: без прокрутки, без serious/critical axe, фокус виден; без ошибок страниц', { skip }, async (t) => {
  const hs = summary.filter((s) => s.hscroll).map((s) => s.name);
  const ax = summary.filter((s) => s.serious.length).map((s) => `${s.name}: ${s.serious.map((v) => `${v.id}×${v.n} (${v.target})`).join(', ')}`);
  const nf = summary.filter((s) => s.noFocus.length).map((s) => `${s.name}: ${s.noFocus.map((f) => `${f.tag} «${f.label}»`).join(', ')}`);
  t.diagnostic(`экранов ${summary.length}; прокрутка: ${hs.join(', ') || 'нет'}; axe serious/critical: ${ax.join(' | ') || 'нет'}; фокус не виден: ${nf.join(' | ') || 'нет'}; ошибки страниц: ${errors.join(' | ') || 'нет'}`);
  assert.deepEqual(hs, []);
  assert.deepEqual(ax, []);
  assert.deepEqual(nf, []);
  assert.deepEqual(errors, []);
});
