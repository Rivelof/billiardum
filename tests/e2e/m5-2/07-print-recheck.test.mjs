// Перепроверка Н2 (код 4d79ae2): печать историй на A4. История заказов — дата в одну строку, около
// 33 строк на страницу (~13 страниц на 423 заказа); остальные отчёты (ревизии, списания, приходы, смены,
// касса) печатаются: A4, шапка таблицы на каждой странице, меню и кнопки скрыты, строки не обрезаны.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { BASE, CLUB_A, workingDay } from './helpers.mjs';
import { chromium, errors, newCtx, SHOTS, skip, watch } from './browser-lib.mjs';

const today = workingDay();
let browser;
before(async () => {
  if (!skip) browser = await chromium.launch();
});
after(async () => browser?.close());

async function printReport(t, kind, query = `from=2026-10-22&to=${today}`) {
  const ctx = await newCtx(browser, { width: 1280, scheme: 'light', phone: '+70000000001' });
  const page = await ctx.newPage();
  watch(page, `print-${kind}`);
  try {
    await page.goto(`${BASE}/club/c/${CLUB_A}/reports/${kind}?${query}`, { waitUntil: 'load' });
    await page.waitForSelector('main table, main .dtable, main .rempty, main .empty', { timeout: 20_000 });
    await page.waitForTimeout(1500);
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
    // Подписи столбцов, видимые в печати (innerText учитывает скрытые элементы и display: none).
    const heads = await page.evaluate(() =>
      [...globalThis.document.querySelectorAll('thead th')].filter((th) => globalThis.getComputedStyle(th).display !== 'none').map((th) => th.innerText.split('\n')[0].trim()).filter(Boolean),
    );
    const hidden = await page.evaluate(() => [...globalThis.document.querySelectorAll('nav, .no-print')].every((el) => globalThis.getComputedStyle(el).display === 'none' || el.getBoundingClientRect().height === 0));
    const pdf = path.join(SHOTS, `re-${kind}-a4.pdf`);
    writeFileSync(pdf, await page.pdf({ format: 'A4', preferCSSPageSize: true }));
    const info = spawnSync('pdfinfo', [pdf], { encoding: 'utf8' }).stdout;
    const pages = Number(/Pages:\s+(\d+)/.exec(info)?.[1] ?? 0);
    const size = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(info);
    const txt = spawnSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' }).stdout;
    const perPage = txt.split('\f').filter((p) => p.trim());
    const key = heads.find((h) => !/Состав|Позиции/.test(h)) ?? heads[0] ?? '';
    const withHead = perPage.filter((p) => p.split('\n').some((l) => l.includes(key) && l.includes(heads.at(-1) ?? key))).length;
    // Ширина: правый край таблицы не уходит за страницу — последний столбец есть в шапке каждой страницы.
    const last = heads.at(-1) ?? '';
    const withLast = perPage.filter((p) => p.split('\n').some((l) => l.includes(last))).length;
    return { rows, pages, size, perPage, withHead, withLast, key, last, hidden, txt };
  } finally {
    await ctx.close();
  }
}

test('Н2: история заказов — дата в одну строку, ~33 строки на A4, шапка на каждой странице', { skip, timeout: 5 * 60_000 }, async (t) => {
  const r = await printReport(t, 'orders');
  // Дата в одну строку: нет строк, где от даты остался только месяц или время.
  const broken = r.txt.split('\n').filter((l) => /^\s*(октября,?|\d{2}:\d{2})\s*$/.test(l)).length;
  const perPageRows = r.rows / Math.max(1, r.pages);
  t.diagnostic(`заказов ${r.rows}, страниц ${r.pages} (${perPageRows.toFixed(1)} строк на стр.), ${r.size ? `${Math.round(r.size[1])}×${Math.round(r.size[2])} pt` : '?'}; шапка «${r.key}» на ${r.withHead}/${r.perPage.length}, последний столбец «${r.last}» на ${r.withLast}; строк-обрывков даты ${broken}; меню скрыто ${r.hidden}`);
  assert.ok(r.size && Math.abs(Number(r.size[1]) - 595) < 3 && Math.abs(Number(r.size[2]) - 842) < 3, 'A4');
  assert.equal(broken, 0, 'дата в одну строку');
  assert.ok(perPageRows >= 28, `не меньше ~30 строк на странице (${perPageRows.toFixed(1)})`);
  assert.equal(r.withHead, r.perPage.length, 'шапка на каждой странице');
  assert.equal(r.withLast, r.perPage.length, 'таблица не обрезана справа');
  assert.ok(r.hidden);
});

for (const kind of ['audits', 'writeoffs', 'arrivals', 'shifts', 'cashbook']) {
  test(`Н2: печать «${kind}» не сломана — A4, шапка и последний столбец на каждой странице`, { skip, timeout: 3 * 60_000 }, async (t) => {
    const q = kind === 'cashbook' ? `from=${today.slice(0, 8)}01&to=${today}` : `from=2026-10-22&to=${today}`;
    const r = await printReport(t, kind, q);
    t.diagnostic(`${kind}: строк ${r.rows}, страниц ${r.pages}; шапка «${r.key}» на ${r.withHead}/${r.perPage.length}, последний столбец «${r.last}» на ${r.withLast}; меню скрыто ${r.hidden}`);
    assert.ok(r.size && Math.abs(Number(r.size[1]) - 595) < 3, 'A4');
    assert.ok(r.pages >= 1);
    const tablePages = r.perPage.length;
    if (r.rows > 0) {
      assert.equal(r.withHead, tablePages, 'шапка на каждой странице таблицы');
      assert.equal(r.withLast, tablePages, 'последний столбец на каждой странице таблицы');
    }
    assert.ok(r.hidden, 'меню и кнопки скрыты');
  });
}

test('печать: без ошибок страницы', { skip }, () => {
  assert.deepEqual(errors, []);
});
