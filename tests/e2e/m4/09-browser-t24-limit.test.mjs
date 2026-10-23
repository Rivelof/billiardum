// T24 в интерфейсе гостя (360 px): запись на турнир с рейтингом выше лимита — отказ с объяснением
// (лимит и рейтинг игрока на экране). Турнир — на завтра (стол 2), лимит 1199, игрок с рейтингом
// 1200 (новый профиль); в конце турнир отменяется клубом с причиной.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { api, BASE, brief2, CLUB_A, MIN, newGuest, ok, plusProfile, RES, staff } from './helpers.mjs';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/opt/pw-browsers';
const SHOTS = process.env.E2E_SHOTS_DIR || path.join(os.tmpdir(), 'bl-e2e-m4-shots');
let chromium = null;
let skip = false;
try {
  const mod = await import(pathToFileURL(createRequire(path.join(process.env.E2E_PW_DIR || '/opt/node-tools', 'x.js')).resolve('playwright-core')).href);
  chromium = mod.chromium ?? mod.default?.chromium;
} catch {
  skip = 'нет playwright-core';
}

let browser;
let man;
let tid;

before(async () => {
  if (skip) return;
  browser = await chromium.launch();
  man = await staff('manager');
});

after(async () => {
  if (tid) await api('POST', `/api/clubs/${CLUB_A}/tournaments/${tid}/cancel`, { token: man.token, body: { reason: 'e2e: проверка интерфейса окончена' } });
  await browser?.close();
});

test('рейтинг выше лимита: на экране турнира — отказ с лимитом и рейтингом', { skip }, async (t) => {
  const starts = new Date(Math.ceil((Date.now() + 26 * 60 * MIN) / 3_600_000) * 3_600_000);
  const r = await api('POST', `/api/clubs/${CLUB_A}/tournaments`, {
    token: man.token,
    body: {
      title: 'E2E Лимит',
      discipline: 'pyramid',
      format: 'single_elim',
      race_to: 2,
      rating_limit: 1199,
      fee_kopecks: 10_000,
      places: 8,
      starts_at: starts.toISOString(),
      ends_at: new Date(starts.getTime() + 60 * MIN).toISOString(),
      resource_ids: [RES(2)],
      publish: true,
    },
  });
  assert.equal(r.status, 201, brief2(r));
  tid = r.json.id;
  const g = await newGuest();
  await plusProfile(g);
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 360, height: 780 }, locale: 'ru-RU', colorScheme: 'dark' });
  await ctx.request.post(`${BASE}/api/auth/dev`, { data: { phone: g.phone } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app/tournaments/${tid}`, { waitUntil: 'load' });
  await page.getByRole('button', { name: /Записаться/ }).click();
  await page.getByText('Записаться нельзя: рейтинг выше лимита').waitFor({ timeout: 10_000 });
  const note = await page.locator('.note__body').first().innerText();
  const w = await page.evaluate(() => globalThis.document.documentElement.scrollWidth);
  await page.screenshot({ path: path.join(SHOTS, 't24-limit.png'), fullPage: true });
  await ctx.close();
  const me = await ok(api('GET', `/api/tournaments/${tid}/me`, { token: g.token }));
  t.diagnostic(`экран: «Записаться нельзя: рейтинг выше лимита» — «${note}»; ширина ${w}; записи нет (${JSON.stringify(me.entry)})`);
  assert.match(note, /1\s?199/);
  assert.match(note, /1\s?200/);
  assert.equal(me.entry, null);
  assert.ok(w <= 361);
});
