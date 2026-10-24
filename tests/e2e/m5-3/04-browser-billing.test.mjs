// Экраны подписки M5.3 в браузере (код 4d79ae2): 360 и 1280, обе темы, axe без serious/critical.
//   Подготовка через API (клубы M5.3, E2E_M53_DIR):
//     * клуб C — карта привязана, эмулятор отвечает 500 на первую попытку списания → счёт выставлен
//       подставными часами, попыток 0, ошибки нет → плашка invoice_due «Счёт за подписку будет списан DD.MM»;
//     * клуб B — открытый счёт без карты (card_required) → плашка payment_failed (заметная).
//   * «Подписка» владельца (B и C) и управляющего (только состояние, «Оплачивает владелец клуба»);
//   * плашка на дашборде; крестик — скрыта до завтра (localStorage), после перезагрузки не видна;
//     компактная на кассе («Подписка не оплачена · Оплатить»);
//   * «Клубы и подписки» у platform_admin: MRR, «Должники», «Отметить оплату» (причина и платёжка),
//     «Персональная цена», «Изменить цену плана» с причиной (предупреждение; без причины — ошибка;
//     сохранение → PUT плана; затем цена возвращается API); у оператора — только чтение;
//   * касса клуба сида (Pos.jsx) — без label-content-name-mismatch.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { adminClient, api, BASE, billingAt, capi, CLUB_A, emu, emuSucceed, loadState, loginWait, providerId, sleep, waitFor } from './helpers.mjs';
import { bodyText, chromium, errors, newCtx, screen, skip as noPw, summary, watch } from '../m5-2/browser-lib.mjs';

const st = loadState();
const skip = noPw || (!st.club2 ? 'нет клубов M5.3' : false);
const B = st.club;
const C = st.club2;
const PLAN = 'bf000000-0000-4000-8000-000000000001';
const S = {};
let db;
let browser;

before(async () => {
  if (skip) return;
  db = await adminClient();
  browser = await chromium.launch();
  S.x = await loginWait(st.ownerPhone);
  S.andrey = await loginWait('+70000000009');
});
after(async () => {
  emu('/__emu/config', { post: true, body: { fail_next: { count: 0, status: 500 } } });
  await browser?.close();
  await db?.end();
});

const sub = async (club) => (await capi('GET', `/api/clubs/${club}/subscription`, { token: S.x.token, club })).json;

test('подготовка API: C — invoice_due (счёт выставлен, списания не было), B — payment_failed', { skip, timeout: 3 * 60_000 }, async (t) => {
  let c = await sub(C);
  if (!c.open_invoice) {
    if (!c.card) {
      const r = await capi('POST', `/api/clubs/${C}/subscription/card`, { token: S.x.token, club: C, body: { email: 'owner-e2e@billiardum.test' } });
      assert.equal(r.status, 201, r.text);
      emuSucceed(providerId({ confirmation: { url: r.json.confirmation_url } }));
      await waitFor(async () => ((await sub(C)).card ? true : null), { timeoutMs: 40_000, what: 'карта C' });
    }
    c = await sub(C);
    emu('/__emu/config', { post: true, body: { fail_next: { count: 1, status: 500 } } });
    const run = billingAt('process', C, new Date(new Date(c.trial_until).getTime() + 2 * 60_000));
    emu('/__emu/config', { post: true, body: { fail_next: { count: 0, status: 500 } } });
    t.diagnostic(`проход C: ${run.result}; ${JSON.stringify(run.logs).slice(0, 200)}`);
  }
  c = await sub(C);
  assert.ok(c.open_invoice, 'у C открытый счёт');
  assert.equal(c.open_invoice.attempts, 0);
  assert.equal(c.banner?.kind, 'invoice_due', JSON.stringify(c.banner));
  const b = await sub(B);
  assert.equal(b.banner?.kind, 'payment_failed', JSON.stringify(b.banner));
  S.cDue = c.banner;
  t.diagnostic(`C: ${JSON.stringify(c.banner)}; B: ${JSON.stringify(b.banner)}`);
});

for (const [width, scheme] of [
  [1280, 'light'],
  [360, 'dark'],
]) {
  test(`владелец ${width}: «Подписка», плашки invoice_due и payment_failed, крестик до завтра, компактная на кассе`, { skip, timeout: 8 * 60_000 }, async (t) => {
    const ctx = await newCtx(browser, { width, scheme, phone: st.ownerPhone });
    const page = await ctx.newPage();
    watch(page, `owner${width}`);
    const tag = `bill-w${width}`;
    try {
      for (const [club, name] of [
        [B, 'B'],
        [C, 'C'],
      ]) {
        await page.goto(`${BASE}/club/c/${club}/subscription`, { waitUntil: 'load' });
        await page.waitForTimeout(2000);
        const text = await bodyText(page);
        if (name === 'B') assert.match(text, /•• 4477|Привязать карту|Оплатить .* картой/, 'карта или оплата картой');
        if (name === 'C') assert.match(text, /Ждёт списания/, 'C: «Ждёт списания» вместо «Просрочена»');
        assert.doesNotMatch(text, /отключ(им|ат) свет|свет погаснет/i, 'не пугает отключением света');
        await screen(t, page, `${tag}-sub-${name}`, scheme);
      }
      // Плашки на дашборде.
      await page.goto(`${BASE}/club/c/${C}/dashboard`, { waitUntil: 'load' });
      const noteC = page.locator('.subnote');
      await noteC.first().waitFor({ timeout: 15_000 });
      const tC = await noteC.first().innerText();
      assert.match(tC, /Счёт за подписку будет списан \d{2}\.\d{2}/);
      assert.equal(await page.locator('.subnote--strong').count(), 0, 'invoice_due — не заметная');
      await screen(t, page, `${tag}-banner-due`, scheme);
      await page.goto(`${BASE}/club/c/${B}/dashboard`, { waitUntil: 'load' });
      await page.locator('.subnote--strong').first().waitFor({ timeout: 15_000 });
      const tB = await page.locator('.subnote').first().innerText();
      assert.match(tB, /Оплата подписки не прошла/);
      assert.match(tB, /Перейти к оплате/);
      await screen(t, page, `${tag}-banner-failed`, scheme);
      // Крестик: до завтра, после перезагрузки не видна.
      await page.getByRole('button', { name: 'Скрыть напоминание о подписке до завтра' }).click();
      await page.waitForTimeout(400);
      assert.equal(await page.locator('.subnote').count(), 0, 'скрыта');
      await page.reload({ waitUntil: 'load' });
      await page.waitForTimeout(2500);
      assert.equal(await page.locator('.subnote').count(), 0, 'после перезагрузки — скрыта');
      const saved = await page.evaluate((k) => globalThis.localStorage.getItem(k), `bl-sub-banner:${B}`);
      assert.ok(saved, 'localStorage');
      // Компактная — на кассе (сбросим скрытие).
      await page.evaluate((k) => globalThis.localStorage.removeItem(k), `bl-sub-banner:${B}`);
      await page.goto(`${BASE}/club/c/${B}/pos`, { waitUntil: 'load' });
      await page.waitForTimeout(2500);
      const compact = page.locator('.subnote--compact');
      const nCompact = await compact.count();
      const tCompact = nCompact ? await compact.first().innerText() : '';
      await screen(t, page, `${tag}-pos-B`, scheme);
      t.diagnostic(`C: «${tC.replace(/\s+/g, ' ')}»; B: «${tB.replace(/\s+/g, ' ')}»; крестик — скрыта, после перезагрузки скрыта (${saved}); касса B: компактная ${nCompact} «${tCompact.replace(/\s+/g, ' ')}»`);
      assert.equal(nCompact, 1, 'компактная плашка на кассе');
      assert.match(tCompact, /Подписка не оплачена/);
    } finally {
      await ctx.close();
    }
  });
}

test('управляющий 360/1280: «Подписка» — только состояние, плашка без «Перейти к оплате»', { skip, timeout: 5 * 60_000 }, async (t) => {
  for (const [width, scheme] of [
    [1280, 'light'],
    [360, 'dark'],
  ]) {
    const ctx = await newCtx(browser, { width, scheme, phone: st.managerPhone });
    const page = await ctx.newPage();
    watch(page, `man${width}`);
    try {
      await page.goto(`${BASE}/club/c/${B}/subscription`, { waitUntil: 'load' });
      await page.waitForTimeout(2000);
      const text = await bodyText(page);
      assert.match(text, /видит владелец клуба/);
      assert.doesNotMatch(text, /Отключить автоплатёж|Привязать карту|Сменить карту|•• 4477/);
      await screen(t, page, `bill-man-w${width}-sub`, scheme);
      await page.goto(`${BASE}/club/c/${B}/dashboard`, { waitUntil: 'load' });
      const note = page.locator('.subnote').first();
      await note.waitFor({ timeout: 15_000 });
      const nt = await note.innerText();
      assert.match(nt, /Оплачивает владелец клуба/);
      assert.doesNotMatch(nt, /Перейти к оплате/);
      t.diagnostic(`управляющий ${width}: плашка «${nt.replace(/\s+/g, ' ')}»`);
    } finally {
      await ctx.close();
    }
  }
});

test('«Клубы и подписки» — platform_admin: MRR, должники, отметка оплаты, персональная цена, правка цены плана с причиной', { skip, timeout: 8 * 60_000 }, async (t) => {
  for (const [width, scheme] of [
    [1280, 'light'],
    [360, 'dark'],
  ]) {
    const ctx = await newCtx(browser, { width, scheme, phone: '+70000000009' });
    const page = await ctx.newPage();
    watch(page, `adm${width}`);
    try {
      await page.goto(`${BASE}/club/platform/billing`, { waitUntil: 'load' });
      await page.waitForSelector('.pbill', { timeout: 20_000 });
      await page.waitForTimeout(1500);
      const text = await bodyText(page);
      assert.match(text, /MRR|в месяц с боевых клубов/);
      await screen(t, page, `bill-adm-w${width}-list`, scheme);
      await page.getByRole('button', { name: /Должники/ }).click();
      await page.waitForTimeout(600);
      const deb = await bodyText(page);
      assert.ok(deb.includes('E2E M5.3'), 'клубы сценария в должниках');
      await screen(t, page, `bill-adm-w${width}-debtors`, scheme);
      // Диалоги: отметка оплаты (B) и персональная цена — открыть, проверить, закрыть.
      const payBtn = page.getByRole('button', { name: /^Отметить оплату: E2E M5\.3 Подписка/ });
      await payBtn.first().click();
      await page.waitForSelector('dialog[open]');
      await page.locator('dialog[open] button[type=submit]').click();
      await page.waitForTimeout(400);
      const errs = await page.locator('dialog[open] .field__error').count();
      assert.ok(errs >= 1, 'без платёжки и причины — ошибки полей');
      await screen(t, page, `bill-adm-w${width}-markpaid`, scheme);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      await page.getByRole('button', { name: /^Персональная цена: E2E M5\.3 Подписка/ }).first().click();
      await page.waitForSelector('dialog[open]');
      await screen(t, page, `bill-adm-w${width}-price`, scheme);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      // Правка цены плана: предупреждение, без причины — ошибка; на 1280 — сохранить 800 ₽ и вернуть API.
      await page.getByRole('button', { name: /Изменить цену плана/ }).first().click();
      await page.waitForSelector('dialog[open]');
      const warn = await page.locator('#pb-plan-warn').innerText();
      assert.match(warn, /со следующего счёта/i);
      await page.fill('#pb-plan-rub', '800');
      await page.locator('dialog[open] button[type=submit]').click();
      await page.waitForTimeout(500);
      assert.ok(await page.locator('#pb-plan-reason-err').count(), 'без причины — ошибка');
      await screen(t, page, `bill-adm-w${width}-plan`, scheme);
      if (width === 1280) {
        await page.fill('#pb-plan-reason', 'Проверка правки цены плана (тест e2e)');
        await page.locator('dialog[open] button[type=submit]').click();
        const p = await waitFor(async () => {
          const r = (await db.query('select price_per_table_kopecks from bl.billing_plans where id = $1', [PLAN])).rows[0];
          return Number(r.price_per_table_kopecks) === 80_000 ? r : null;
        }, { timeoutMs: 15_000, what: 'цена плана 800 ₽' });
        const au = (await db.query("select reason from bl.audit_log where club_id is null and action = 'billing.plan_update' order by seq desc limit 1")).rows[0];
        S.planChanged = { price: Number(p.price_per_table_kopecks), reason: au?.reason };
        const back = await api('PUT', `/api/platform/plans/${PLAN}`, { token: S.andrey.token, body: { price_per_table_kopecks: 79_000, reason: 'Вернуть цену после проверки (тест e2e)' } });
        assert.equal(back.status, 200, back.text);
      } else {
        await page.keyboard.press('Escape');
      }
      t.diagnostic(`admin ${width}: ошибок полей в «Отметить оплату» без данных ${errs}; предупреждение «${warn.replace(/\s+/g, ' ').slice(0, 140)}»${S.planChanged ? `; план → ${S.planChanged.price} коп., журнал billing.plan_update «${S.planChanged.reason}», возвращено 79 000` : ''}`);
    } finally {
      await ctx.close();
    }
  }
});

test('«Клубы и подписки» — оператор: только чтение', { skip, timeout: 4 * 60_000 }, async (t) => {
  for (const [width, scheme] of [
    [1280, 'light'],
    [360, 'dark'],
  ]) {
    const ctx = await newCtx(browser, { width, scheme, phone: '+70000000010' });
    const page = await ctx.newPage();
    watch(page, `op${width}`);
    try {
      await page.goto(`${BASE}/club/platform/billing`, { waitUntil: 'load' });
      await page.waitForSelector('.pbill', { timeout: 20_000 });
      await page.waitForTimeout(1500);
      const text = await bodyText(page);
      assert.match(text, /Только чтение/);
      const btns = await page.getByRole('button', { name: /Отметить оплату|Персональная цена|Изменить цену плана/ }).count();
      assert.equal(btns, 0, 'кнопок изменения нет');
      await screen(t, page, `bill-op-w${width}`, scheme);
      t.diagnostic(`оператор ${width}: кнопок изменения ${btns}`);
    } finally {
      await ctx.close();
    }
  }
});

test('касса клуба сида (Pos.jsx): axe без label-content-name-mismatch, 1280 и 360, обе темы', { skip, timeout: 4 * 60_000 }, async (t) => {
  for (const [width, scheme] of [
    [1280, 'light'],
    [360, 'dark'],
  ]) {
    const ctx = await newCtx(browser, { width, scheme, phone: '+70000000004' });
    const page = await ctx.newPage();
    watch(page, `pos${width}`);
    try {
      await page.goto(`${BASE}/club/c/${CLUB_A}/pos`, { waitUntil: 'load' });
      await page.waitForTimeout(2500);
      const res = await screen(t, page, `pos-seed-w${width}`, scheme);
      const mismatch = res.flatMap((r) => r.all).filter((v) => v.id === 'label-content-name-mismatch');
      assert.deepEqual(mismatch, [], 'нет label-content-name-mismatch');
    } finally {
      await ctx.close();
    }
  }
});

test('итог: прокрутки нет, axe без serious/critical, фокус виден, без ошибок страницы', { skip }, async () => {
  await sleep(10);
  const bad = summary.filter((s) => s.hscroll || s.serious.length || s.noFocus.length);
  assert.deepEqual(errors, []);
  assert.deepEqual(bad.map((s) => `${s.name}: ${s.hscroll ? 'прокрутка ' : ''}${s.serious.map((v) => `${v.id}/${v.impact} [${v.target}]`).join(',')}${s.noFocus.length ? ' фокус не виден' : ''}`), []);
});
