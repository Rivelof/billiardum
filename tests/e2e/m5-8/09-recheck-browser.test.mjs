// Перепроверка дефектов приёмки M5.5/M5.8 в браузере (Playwright, Chromium /opt/pw-browsers); код main 0fd990e.
// Два прохода: 1280×900 тёмная и 360×780 светлая; на каждом экране `screen()` проверяет ещё и вторую тему
// (прокрутка вбок, axe serious/critical, скриншот E2E_SHOTS_DIR). API-часть — 08-recheck-api.test.mjs.
//
//   Д1  заявка ресепшену открыта в новой вкладке (/app/r/{id}): «Корт 2…» у корта, «Стол 7…» у стола;
//   Д2  гость: игра, бар, чек корта и стола — «стол» у корта и «корт» у стола не встречаются;
//   Д3  касса, бар, ресепшн программы клуба: «Счёт корта», «В счёт корта», «Открытый счёт корта»; Д4 журнал: «Команда корту», «Заказ с корта»;
//   Д5  сайт ?d=padel: заголовок про корты, «Цена слота корта», «Больше свободных кортов»; смешанные дисциплины — «стол…» как раньше;
//   Д6  план зала сида (39 × 23,5 м): 10 объектов внутри поля и без наложений, страница не шире окна; мастер зала с маленьким залом — «Увеличьте зал»;
//   Д7  фокус с клавиатуры виден: план зала (1280 тёмная), ресепшн (1280 тёмная), сетка брони гостя (360 светлая): у каждой остановки Tab
//       есть контур/тень И экран вокруг элемента меняется относительно расфокусированного;
//   M5.6 Д1 сообщение после исправления события обслуживания говорит о кассе по cashbook.action.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyText, chromium, errors, newCtx, screen, skip, summary, tableWords, watch, wording } from './browser-lib.mjs';
import { api, BASE, CLUB_SEED, COURTS, courtRule, login, makeClub, newGuest, payQuote, quote, rule, SEED_PHONES, short, staffPhone, startGame, stopGame, tableByCode, waitCourtFree, waitFor } from './lib.mjs';

const PASSES = [
  { width: 1280, scheme: 'dark' },
  { width: 360, scheme: 'light' },
];
const G = { sessions: [], requests: [] };
const S_LEGACY = [];
let browser;
const ready = !skip;

/** Слова «корт…» вне оборотов «стол или корт» (для экранов, целиком про стол). */
const courtWords = (page) =>
  page.evaluate(() => {
    const WORD = '(?:стол\\p{L}*|корт\\p{L}*)';
    const pair = new RegExp(`${WORD}\\s*(?:и|или|/|,|—|–|-)\\s*${WORD}`, 'giu');
    const text = globalThis.document.body.innerText.replace(/\s+/g, ' ').replace(pair, '').replace(pair, '');
    return [...text.matchAll(/.{0,40}корт\p{L}*.{0,40}/giu)].map((m) => m[0]);
  });

async function open(ctx, url, tag, { wait = 700 } = {}) {
  const page = await ctx.newPage();
  watch(page, tag);
  await page.goto(`${BASE}${url}`, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); // поток SSE держит сеть
  await page.waitForTimeout(wait);
  return page;
}

async function request(guest, code, minutes) {
  const t = await tableByCode(code, guest.token);
  const q = await quote(guest.token, { resource_id: t.json.resource.id, kind: 'start', minutes });
  const p = await payQuote(guest.token, q.json.quote_id, 'reception');
  assert.equal(p.status, 200, short(p));
  G.requests.push(p.json.reception_request_id);
  return p.json.reception_request_id;
}

before(async () => {
  if (!ready) return;
  browser = await chromium.launch();
  G.owner = await login(SEED_PHONES.owner);
  G.rec = await login(SEED_PHONES.reception);
  G.gc = await newGuest();
  G.gt = await newGuest();
  G.gr = await newGuest();
  G.gq = await newGuest();
  await waitCourtFree(101, G.gc.token, 240_000);
  await waitCourtFree(102, G.gr.token, 240_000);
  G.court = await startGame(101, 90, G.gc);
  G.sessions.push({ guest: G.gc, id: G.court.sessionId });
  // Стол 8 (столы 1–4 не трогаем).
  const t8 = await tableByCode('TEST000008', G.gt.token);
  assert.equal(t8.json.status, 'free', 'стол 8 свободен');
  const q = await quote(G.gt.token, { resource_id: t8.json.resource.id, kind: 'start', minutes: 60 });
  const pay = await payQuote(G.gt.token, q.json.quote_id);
  const { emuSucceed, providerId } = await import('./lib.mjs');
  emuSucceed(providerId(pay.json));
  const p = await waitFor(async () => {
    const r = await api('GET', `/api/payments/${pay.json.payment_id}`, { token: G.gt.token });
    return r.status === 200 && r.json.session_id ? r.json : null;
  }, { what: 'сессия стола 8' });
  G.table = { sessionId: p.session_id };
  G.sessions.push({ guest: G.gt, id: p.session_id });
  // Заказ в счёт: корт и стол.
  const menu = (await api('GET', `/api/clubs/${CLUB_SEED}/catalog`, { token: G.owner.token, club: CLUB_SEED })).json;
  const prod = (menu.products ?? []).find((x) => x.active && !x.is_alcohol && !x.stop_list);
  G.orders = [];
  if (prod) {
    for (const [guest, id] of [[G.gc, G.court.sessionId], [G.gt, G.table.sessionId]]) {
      const o = await api('POST', '/api/orders', { token: guest.token, idem: true, body: { session_id: id, items: [{ product_id: prod.id, qty: 1 }], pay: 'tab' } });
      G.orders.push(o.status);
    }
  }
  // Заявки ресепшену: корт 102 и стол 7.
  G.reqCourt = await request(G.gr, COURTS[102].code, 90);
  G.reqTable = await request(G.gq, 'TEST000007', 60);
});

after(async () => {
  if (!ready) return;
  for (const id of G.requests ?? []) await api('POST', `/api/reception/requests/${id}/decline`, { token: G.rec.token, body: { reason_code: 'other' } }).catch(() => {});
  for (const { guest, id } of G.sessions) await stopGame(guest, id).catch(() => {});
  await browser?.close();
  const bad = summary.filter((s) => s.hscroll || s.serious.length);
  console.log(`# экранов проверено: ${summary.length}; с прокруткой вбок: ${summary.filter((s) => s.hscroll).length}; с axe serious/critical: ${summary.filter((s) => s.serious.length).length}; ошибки страниц: ${errors.length}`);
  for (const b of bad) console.log(`#   ${b.name}: ${b.hscroll ? `прокрутка ${b.sw}>${b.iw} (${b.culprits})` : ''} ${b.serious.map((v) => `${v.id}[${v.target}]`).join(',')}`);
});

/**
 * Проба видимого фокуса на текущем элементе: контур/тень (computed) И изменение картинки вокруг элемента
 * против расфокусированного (два эталонных снимка подряд — картинка стабильна). Фокус возвращается на элемент.
 */
async function probe(page) {
  const info = await page.evaluate(() => {
    const el = globalThis.document.activeElement;
    if (!el || el === globalThis.document.body) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const cs = globalThis.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const mark = `bl-probe-${Math.random().toString(36).slice(2)}`;
    el.setAttribute('data-probe', mark);
    const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 && cs.outlineColor !== 'rgba(0, 0, 0, 0)';
    const shadow = Boolean(cs.boxShadow && cs.boxShadow !== 'none');
    return { mark, tag: el.tagName.toLowerCase(), cls: String(el.className).split(' ')[0], label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40), outline, shadow, fv: el.matches(':focus-visible'), rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
  });
  if (!info) return null;
  const pad = 8;
  const vp = page.viewportSize();
  const cx = Math.max(0, Math.floor(info.rect.x - pad));
  const cy = Math.max(0, Math.floor(info.rect.y - pad));
  const clip = {
    x: cx,
    y: cy,
    width: Math.max(1, Math.min(vp.width - cx, Math.ceil(info.rect.w + 2 * pad))),
    height: Math.max(1, Math.min(vp.height - cy, Math.ceil(info.rect.h + 2 * pad))),
  };
  let changed = true;
  let stable = true;
  if (clip.width >= 2 && clip.height >= 2) {
    const focused = await page.screenshot({ clip });
    await page.evaluate(() => globalThis.document.activeElement?.blur?.());
    const plain1 = await page.screenshot({ clip });
    const plain2 = await page.screenshot({ clip });
    await page.evaluate((mark) => globalThis.document.querySelector(`[data-probe="${mark}"]`)?.focus({ focusVisible: true }), info.mark);
    stable = plain1.equals(plain2);
    changed = !focused.equals(plain1);
  }
  await page.evaluate((mark) => globalThis.document.querySelector(`[data-probe="${mark}"]`)?.removeAttribute('data-probe'), info.mark);
  const computed = info.outline || info.shadow;
  return { key: `${info.tag}:${info.label}:${Math.round(info.rect.x)},${Math.round(info.rect.y)}`, name: `${info.tag}.${info.cls} «${info.label}»`, computed, changed, stable, ok: computed && (!stable || changed) };
}

/** Проход Tab по странице: остановки без видимого фокуса. maxStops — сколько остановок пройти. */
async function focusAudit(page, { maxStops = 40 } = {}) {
  const bad = [];
  const seen = new Set();
  await page.evaluate(() => {
    globalThis.document.activeElement?.blur?.();
    globalThis.scrollTo(0, 0);
  });
  for (let i = 0; i < maxStops; i += 1) {
    await page.keyboard.press('Tab');
    const r = await probe(page);
    if (!r) continue;
    if (seen.has(r.key)) break;
    seen.add(r.key);
    if (!r.ok) bad.push({ label: r.name, computed: r.computed, changed: r.changed, stable: r.stable });
  }
  return { bad, stops: seen.size };
}

/** Стрелки внутри сетки с блуждающим tabindex: каждая новая ячейка — с видимым фокусом. */
async function arrowAudit(page, keys) {
  const bad = [];
  const names = [];
  for (const k of keys) {
    await page.keyboard.press(k);
    const r = await probe(page);
    if (!r) continue;
    names.push(r.name);
    if (!r.ok) bad.push({ label: r.name, computed: r.computed, changed: r.changed, stable: r.stable });
  }
  return { bad, names };
}

for (const pass of PASSES) {
  const tag = `w${pass.width}`;
  const skipAll = skip || (!ready && 'нет playwright');

  describe(`${tag}: Д1 заявка ресепшену в новой вкладке`, { skip: skipAll }, () => {
    it('корт 102: «Корт 2…» без слова «стол»; стол 7: «Стол 7…» без слова «корт»', async (t) => {
      const ctx = await newCtx(browser, { ...pass, phone: G.gr.phone });
      try {
        const page = await open(ctx, `/app/r/${G.reqCourt}`, `${tag}-req-court`);
        const txt = await bodyText(page);
        t.diagnostic(`заявка на корт: ${txt.slice(0, 300)}`);
        assert.match(txt, /Подойдите на ресепшн/);
        assert.match(txt, /Корт 2/);
        assert.deepEqual(await tableWords(page), [], 'слово «стол» в заявке на корт');
        assert.match(txt, /Корт до этого времени за вами/);
        await screen(t, page, `${tag}-req-court`, pass.scheme);
      } finally {
        await ctx.close();
      }
      const ctx2 = await newCtx(browser, { ...pass, phone: G.gq.phone });
      try {
        const page = await open(ctx2, `/app/r/${G.reqTable}`, `${tag}-req-table`);
        const txt = await bodyText(page);
        t.diagnostic(`заявка на стол: ${txt.slice(0, 300)}`);
        assert.match(txt, /Стол 7/);
        assert.deepEqual(await courtWords(page), [], 'слово «корт» в заявке на стол');
        assert.match(txt, /Стол до этого времени за вами/);
        await screen(t, page, `${tag}-req-table`, pass.scheme);
      } finally {
        await ctx2.close();
      }
    });
  });

  describe(`${tag}: Д2 гость — игра, бар, чек`, { skip: skipAll }, () => {
    it('корт 1: «Счёт корта», «В счёт корта»; стол 8: «Счёт стола» — без чужого слова', async (t) => {
      const issues = [];
      const ctx = await newCtx(browser, { ...pass, phone: G.gc.phone });
      try {
        for (const [path, what] of [[`/app/s/${G.court.sessionId}`, 'игра'], [`/app/s/${G.court.sessionId}/bar`, 'бар'], [`/app/s/${G.court.sessionId}/receipt`, 'чек']]) {
          const page = await open(ctx, path, `${tag}-gc-${what}`);
          const w = await tableWords(page);
          const txt = await bodyText(page);
          t.diagnostic(`корт, ${what}: ${(txt.match(/(?:В |Открытый )?[Сс]чёт[а-я]* [а-я]+(?: \d)?/g) ?? []).join(' | ')}`);
          if (w.length) issues.push(`корт, ${what}: ${JSON.stringify(w)}`);
          await screen(t, page, `${tag}-gc-${what}`, pass.scheme);
          await page.close();
        }
      } finally {
        await ctx.close();
      }
      const ctx2 = await newCtx(browser, { ...pass, phone: G.gt.phone });
      try {
        for (const [path, what] of [[`/app/s/${G.table.sessionId}`, 'игра'], [`/app/s/${G.table.sessionId}/bar`, 'бар'], [`/app/s/${G.table.sessionId}/receipt`, 'чек']]) {
          const page = await open(ctx2, path, `${tag}-gt-${what}`);
          const w = await courtWords(page);
          const txt = await bodyText(page);
          t.diagnostic(`стол, ${what}: ${(txt.match(/(?:В |Открытый )?[Сс]чёт[а-я]* [а-я]+(?: \d)?/g) ?? []).join(' | ')}`);
          if (w.length) issues.push(`стол, ${what}: ${JSON.stringify(w)}`);
          if (what === 'чек') assert.match(txt, /Стол 8/);
          await screen(t, page, `${tag}-gt-${what}`, pass.scheme);
          await page.close();
        }
      } finally {
        await ctx2.close();
      }
      assert.deepEqual(issues, [], 'чужое слово на экранах гостя');
    });
  });

  describe(`${tag}: Д3–Д4 программа клуба — касса, бар, ресепшн, журнал`, { skip: skipAll }, () => {
    it('ресепшн, касса, бар, «Сейчас»: «Корт N» не стоит рядом со словом «стол» и «Стол N» — рядом со словом «корт»', async (t) => {
      const ctx = await newCtx(browser, { ...pass, phone: SEED_PHONES.reception });
      const issues = [];
      try {
        for (const [path, what] of [['reception', 'ресепшн'], ['pos', 'касса'], ['bar', 'бар'], ['now', 'сейчас']]) {
          const page = await open(ctx, `/club/c/${CLUB_SEED}/${path}`, `${tag}-a-${what}`, { wait: 1200 });
          const w = await wording(page);
          const txt = await bodyText(page);
          t.diagnostic(`${what}: счёт-формулировки: ${[...new Set(txt.match(/(?:В |Открытый )?[Сс]чёт[а-я]* (?:корта|стола)(?: \d+)?/g) ?? [])].join(' | ') || '—'}; корт+стол: ${w.courtWithTable.length}, стол+корт: ${w.tableWithCourt.length}`);
          if (w.courtWithTable.length) issues.push(`${what}, «Корт N» + «стол»: ${JSON.stringify(w.courtWithTable.slice(0, 3))}`);
          // Сводка зала ресепшена («Свободно 5 столов, корты заняты … Стол 1 … Корт 1 …») называет оба вида законно.
          const tw = w.tableWithCourt.filter((x) => !/^Свободно \d+ (?:стол|стола|столов), корт/.test(x));
          if (tw.length) issues.push(`${what}, «Стол N» + «корт»: ${JSON.stringify(tw.slice(0, 3))}`);
          await screen(t, page, `${tag}-a-${what}`, pass.scheme);
          await page.close();
        }
      } finally {
        await ctx.close();
      }
      assert.deepEqual(issues, []);
    });

    it('бар и касса: счёт на «Корт 1» называется «…корта», на «Стол 8» — «…стола» (в тексте страницы)', async (t) => {
      const ctx = await newCtx(browser, { ...pass, phone: SEED_PHONES.reception });
      const txts = {};
      try {
        for (const path of ['bar', 'pos']) {
          const page = await open(ctx, `/club/c/${CLUB_SEED}/${path}`, `${tag}-b-${path}`, { wait: 1500 });
          txts[path] = await bodyText(page);
          await page.close();
        }
      } finally {
        await ctx.close();
      }
      t.diagnostic(`заказы в счёт созданы: ${JSON.stringify(G.orders)}`);
      if (G.orders.every((s) => s === 201)) {
        const bar = txts.bar;
        t.diagnostic(`бар: ${[...new Set(bar.match(/[^.]{0,30}(?:Корт 1|Стол 8)[^.]{0,40}/g) ?? [])].slice(0, 6).join(' || ')}`);
        assert.match(bar, /Корт 1/);
        assert.doesNotMatch(bar, /Корт 1[^А-Я]{0,60}(?:счёт|Счёт) стола|(?:счёт|Счёт) стола[^А-Я]{0,60}Корт 1/, 'бар: корт назван столом');
      }
    });

    it('журнал: «Команда корту», «Заказ с корта» у корта; «Команда столу», «Заказ со стола» у стола — без перепутанных слов', async (t) => {
      const ctx = await newCtx(browser, { ...pass, phone: SEED_PHONES.owner });
      try {
        const page = await open(ctx, `/club/c/${CLUB_SEED}/journal`, `${tag}-journal`, { wait: 1500 });
        const txt = await bodyText(page);
        const w = await wording(page);
        const seen = [...new Set(txt.match(/(?:Команда|Заказ с|Заказ со) (?:корту|корта|столу|стола)(?: · (?:Корт|Стол) \d+)?/g) ?? [])];
        t.diagnostic(`журнал: ${seen.slice(0, 10).join(' | ')}`);
        assert.ok(seen.some((s) => /Команда корту/.test(s)) || /Команда корту/.test(txt), 'есть «Команда корту»');
        assert.deepEqual(seen.filter((s) => /· Корт/.test(s) && /столу|стола/.test(s)), [], 'корт назван столом');
        assert.deepEqual(seen.filter((s) => /· Стол/.test(s) && /корту|корта/.test(s)), [], 'стол назван кортом');
        assert.deepEqual(w.courtWithTable, [], 'журнал: «Корт N» + «стол»');
        assert.deepEqual(w.tableWithCourt, [], 'журнал: «Стол N» + «корт»');
        await screen(t, page, `${tag}-journal`, pass.scheme);
      } finally {
        await ctx.close();
      }
    });
  });

  describe(`${tag}: Д5 сайт`, { skip: skipAll }, () => {
    it('?d=padel: заголовок про корты, «Цена слота корта», «Больше свободных кортов», «свободно N корта»; смешанные — как раньше', async (t) => {
      const ctx = await newCtx(browser, { ...pass, phone: G.gq.phone });
      try {
        const cat = await open(ctx, '/ekaterinburg/?d=padel', `${tag}-site-padel`);
        const txt = await bodyText(cat);
        const title = await cat.title();
        const h1 = await cat.locator('h1').first().innerText();
        const legends = await cat.locator('legend').allInnerTexts();
        const sorts = await cat.locator('select option, [role="option"], label').allInnerTexts();
        t.diagnostic(`padel: title «${title}»; h1 «${h1}»; legends ${JSON.stringify(legends)}; сортировка ${JSON.stringify(sorts.filter((s) => /свободн|Дешевле|Дороже|рейтинг/i.test(s)))}`);
        t.diagnostic(`padel: слова «стол…» вне пар: ${JSON.stringify(await tableWords(cat)).slice(0, 400)}`);
        assert.doesNotMatch(title, /стол/i, 'заголовок вкладки');
        assert.doesNotMatch(h1, /стол/i, 'h1');
        assert.match(`${title} ${h1}`, /корт|падел/i);
        assert.ok(legends.some((l) => /Цена слота корта/.test(l)), 'фильтр «Цена слота корта»');
        assert.ok(!legends.some((l) => /Цена часа стола/.test(l)), 'нет «Цена часа стола»');
        assert.match(txt, /Больше свободных кортов/);
        assert.doesNotMatch(txt, /Больше свободных столов/);
        assert.doesNotMatch(txt, /свободно \d+ (?:стол|стола|столов)/i, 'карточка: свободно столов');
        assert.match(txt, /Падел: от 2 400 ₽ за 1,5 ч/);
        // Шаги цены: слоты корта (тысячи ₽), а не 500–1 200 ₽ за час стола.
        const prices = await cat.evaluate(() => [...globalThis.document.querySelectorAll('input[name="pmax"], input[name="price_max"], select[name="pmax"] option, [data-price]')].map((e) => e.value || e.textContent).slice(0, 10));
        t.diagnostic(`padel: поле цены: ${JSON.stringify(prices)}; текст фильтра: ${txt.match(/Цена слота корта[^А-Я]{0,120}/)?.[0]}`);
        await screen(t, cat, `${tag}-site-padel`, pass.scheme);
        // Смешанные дисциплины: как раньше — «Цена часа стола», «Больше свободных столов».
        for (const url of ['/ekaterinburg/', '/ekaterinburg/?d=padel,pyramid', '/ekaterinburg/?d=pool']) {
          const p2 = await open(ctx, url, `${tag}-site-mixed`);
          const t2 = await bodyText(p2);
          const l2 = await p2.locator('legend').allInnerTexts();
          t.diagnostic(`${url}: legends ${JSON.stringify(l2)}; «Больше свободных столов» ${/Больше свободных столов/.test(t2)}; «…кортов» ${/Больше свободных кортов/.test(t2)}`);
          assert.ok(l2.some((l) => /Цена часа стола/.test(l)), `${url}: «Цена часа стола»`);
          assert.match(t2, /Больше свободных столов/, `${url}: сортировка`);
          assert.doesNotMatch(t2, /Больше свободных кортов/, `${url}: нет «кортов»`);
          await p2.close();
        }
      } finally {
        await ctx.close();
      }
    });
  });

  describe(`${tag}: Д6 план зала`, { skip: skipAll }, () => {
    it('зал сида 39 × 23,5 м: страница не шире окна, объекты внутри поля плана, корты и столы без наложений', async (t) => {
      const ctx = await newCtx(browser, { ...pass, phone: SEED_PHONES.owner });
      try {
        const hall = await open(ctx, `/club/c/${CLUB_SEED}/onboarding/hall`, `${tag}-hall`, { wait: 1200 });
        const txt = await bodyText(hall);
        t.diagnostic(`мастер зала: ${txt.match(/\d+[,.]?\d* м (?:на|×) \d+[,.]?\d* м|Размер зала[^А-Я]{0,60}/)?.[0] ?? txt.slice(0, 160)}`);
        const sizeLabel = await hall.locator('[role="group"][aria-label^="План зала"]').first().getAttribute('aria-label').catch(() => null);
        t.diagnostic(`план: ${sizeLabel}`);
        const geom = await hall.evaluate(() => {
          const floor = globalThis.document.querySelector('.pe__floor');
          if (!floor) return null;
          const f = floor.getBoundingClientRect();
          const items = [...floor.querySelectorAll('.pe__tbl')].map((b) => {
            const r = b.getBoundingClientRect();
            return { n: b.getAttribute('aria-label')?.slice(0, 20), x: r.x, y: r.y, r: r.right, b: r.bottom, w: r.width, h: r.height };
          });
          const out = [];
          for (const i of items) if (i.x < f.x - 1 || i.y < f.y - 1 || i.r > f.right + 1 || i.b > f.bottom + 1) out.push(`вне поля: ${i.n}`);
          for (let a = 0; a < items.length; a += 1) {
            for (let c = a + 1; c < items.length; c += 1) {
              const A = items[a];
              const C = items[c];
              const ox = Math.min(A.r, C.r) - Math.max(A.x, C.x);
              const oy = Math.min(A.b, C.b) - Math.max(A.y, C.y);
              if (ox > 2 && oy > 2) out.push(`наложение: ${A.n} и ${C.n} (${Math.round(ox)}×${Math.round(oy)} px)`);
            }
          }
          return { count: items.length, floor: [f.width, f.height].map(Math.round), out, sw: globalThis.document.documentElement.scrollWidth, iw: globalThis.innerWidth };
        });
        if (pass.width >= 1000) {
          assert.ok(geom, 'на 1280 план виден');
          t.diagnostic(`план 1280: объектов ${geom.count}, поле ${geom.floor.join('×')}, замечания ${JSON.stringify(geom.out)}`);
          assert.equal(geom.count, 10);
          assert.deepEqual(geom.out, []);
        } else {
          t.diagnostic(`на 360 план заменён списком: ${geom ? 'план есть' : 'плана нет, список'}`);
          if (geom) assert.deepEqual(geom.out, []);
        }
        const hs = await hall.evaluate(() => [globalThis.document.documentElement.scrollWidth, globalThis.innerWidth]);
        assert.ok(hs[0] <= hs[1] + 1, `страница шире окна: ${hs[0]} > ${hs[1]}`);
        await screen(t, hall, `${tag}-hall`, pass.scheme);
        // Живой зал («Сейчас», дашборд «Зал») — тоже без прокрутки вбок.
        for (const path of ['now', 'dashboard?tab=hall']) {
          const p = await open(ctx, `/club/c/${CLUB_SEED}/${path}`, `${tag}-hall-${path}`, { wait: 1200 });
          const w = await p.evaluate(() => [globalThis.document.documentElement.scrollWidth, globalThis.innerWidth]);
          assert.ok(w[0] <= w[1] + 1, `${path}: ${w[0]} > ${w[1]}`);
          await screen(t, p, `${tag}-hall-${path.replace(/\W+/g, '-')}`, pass.scheme);
          await p.close();
        }
      } finally {
        await ctx.close();
      }
    });

    it('мастер зала: маленький зал (16 × 10 м) с кортом — подсказка «Увеличьте зал»; после увеличения подсказки нет, корт на плане внутри поля', async (t) => {
      const owner = await login(staffPhone());
      const c = await makeClub(owner, { name: `E2E M5.8 Перепроверка Зал ${tag}`, kinds: ['pyramid'], courts: 1, rules: [rule('06:00', '06:00', 600), courtRule('06:00', '06:00', 90, 2400)] });
      const ctx = await newCtx(browser, { ...pass, phone: owner.phone });
      try {
        const page = await open(ctx, `/club/c/${c.club}/onboarding/hall`, `${tag}-smallhall`, { wait: 1200 });
        const txt = await bodyText(page);
        t.diagnostic(`мастер, маленький зал: ${txt.match(/[^.]*Увеличьте зал[^.]*\./)?.[0] ?? 'подсказки нет'}`);
        assert.match(txt, /Увеличьте зал/);
        assert.match(txt, /Корт 1/);
        const inside = () =>
          page.evaluate(() => {
            const f = globalThis.document.querySelector('.pe__floor');
            if (!f) return null;
            const fr = f.getBoundingClientRect();
            return [...globalThis.document.querySelectorAll('.pe__tbl')].map((b) => {
              const r = b.getBoundingClientRect();
              return { n: b.getAttribute('aria-label')?.slice(0, 12), ok: r.x >= fr.x - 1 && r.y >= fr.y - 1 && r.right <= fr.right + 1 && r.bottom <= fr.bottom + 1, over: Math.round(Math.max(r.bottom - fr.bottom, r.right - fr.right, fr.x - r.x, fr.y - r.y)) };
            });
          });
        if (pass.width >= 1000) {
          // Корт сохранён API с произвольной точкой (300, 700): при зале меньше корта точка может выпускать его за поле плана.
          const legacy = await inside();
          t.diagnostic(`маленький зал, корт в точке из API (300, 700): ${JSON.stringify(legacy)}`);
          S_LEGACY.push(legacy);
          // Корт в центре зала (как ставит редактор: середина, если зал меньше корта) — внутри поля.
          const court = c.resources.find((r) => r.family === 'court' || r.type === 'padel_court');
          const mv = await api('PATCH', `/api/clubs/${c.club}/resources/${court.id}`, { token: owner.token, club: c.club, body: { plan_x: 800, plan_y: 500 } });
          assert.equal(mv.status, 200, short(mv));
          await page.reload({ waitUntil: 'load' });
          await page.waitForTimeout(1200);
          const centered = await inside();
          t.diagnostic(`маленький зал, корт в центре: ${JSON.stringify(centered)}`);
          assert.ok(centered.every((x) => x.ok), `объекты внутри поля: ${JSON.stringify(centered)}`);
        }
        assert.ok((await page.evaluate(() => globalThis.document.documentElement.scrollWidth)) <= pass.width + 1, 'страница не шире окна');
        await screen(t, page, `${tag}-smallhall`, pass.scheme);
        await page.close();
        const put = await api('PUT', `/api/clubs/${c.club}/hall`, { token: owner.token, club: c.club, body: { width: 3900, height: 2350 } });
        assert.equal(put.status, 200, short(put));
        const again = await open(ctx, `/club/c/${c.club}/onboarding/hall`, `${tag}-bighall`, { wait: 1200 });
        const t2 = await bodyText(again);
        assert.doesNotMatch(t2, /Увеличьте зал/, 'в большом зале подсказки нет');
        await screen(t, again, `${tag}-bighall`, pass.scheme);
      } finally {
        await ctx.close();
      }
    });
  });

  describe(`${tag}: M5.6 Д1 сообщение после исправления события обслуживания`, { skip: skipAll }, () => {
    it('«исправление комментария» → «Стоимость не изменена: расход в кассе по исходной записи»; «события не было» → «сторнирован»', async (t) => {
      const owner = await login(staffPhone());
      const c = await makeClub(owner, { name: `E2E M5.8 Перепроверка Обслуж ${tag}`, kinds: ['pyramid'], rules: [rule('06:00', '06:00', 600)] });
      const ctx = await newCtx(browser, { ...pass, phone: owner.phone });
      try {
        const page = await open(ctx, `/club/c/${c.club}/reports/maintenance`, `${tag}-maint`);
        await page.getByRole('button', { name: /^Событие$/ }).click();
        const dlg = page.getByRole('dialog');
        await dlg.waitFor();
        await dlg.locator('#me-resource').selectOption({ label: 'Стол 1 · Пирамида' });
        await dlg.locator('input[name="me-kind"][value="cloth"]').check();
        await dlg.locator('#me-cost').fill('1 500');
        await dlg.locator('#me-comment').fill(`E2E перепроверка ${tag}`);
        const actions = [];
        page.on('response', async (r) => {
          if (r.request().method() === 'POST' && /\/maintenance$/.test(new URL(r.url()).pathname)) actions.push((await r.json().catch(() => null))?.cashbook?.action ?? `HTTP ${r.status()}`);
        });
        await dlg.getByRole('button', { name: /Записать событие и расход 1\s500\s₽/ }).click();
        await dlg.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(800);
        const created = (await bodyText(page)).match(/Записано:[^]*?(?:кассу управляющего|кассе управляющего)[^.]*\./)?.[0] ?? (await bodyText(page)).match(/Записано:[^.]*\.[^.]*\./)?.[0];
        // Исправление комментария без стоимости.
        await page.getByRole('button', { name: /Исправить\s*:\s*Замена сукна, стол 1/ }).first().click();
        const fd = page.getByRole('dialog');
        await fd.waitFor();
        await fd.locator('#me-reason').fill('E2E уточнил комментарий');
        await fd.locator('#me-comment').fill(`E2E перепроверка ${tag} — уточнение`);
        await fd.getByRole('button', { name: /Записать исправление/ }).click();
        await page.waitForTimeout(900);
        const afterFix = await bodyText(page);
        const fixMsg = afterFix.match(/Запись исправлена.{0,200}/)?.[0] ?? '';
        // «События не было».
        await page.getByRole('button', { name: /Исправить\s*:\s*Замена сукна, стол 1/ }).first().click();
        const vd = page.getByRole('dialog');
        await vd.waitFor();
        await vd.locator('#me-reason').fill('E2E не меняли');
        await vd.getByText(/События не было/).first().click();
        await vd.getByRole('button', { name: /Отметить: события не было/ }).click();
        await page.waitForTimeout(900);
        const voidMsg = (await bodyText(page)).match(/Отмечено: события не было.{0,200}/)?.[0] ?? '';
        t.diagnostic(`сервер: ${actions.join(' → ')}; создание: «${created}»; исправление: «${fixMsg}»; «не было»: «${voidMsg}»`);
        await screen(t, page, `${tag}-maint-done`, pass.scheme);
        assert.deepEqual(actions, ['created', 'kept', 'reversed']);
        assert.match(created ?? '', /Расход 1\s500\s₽ внесён в кассу управляющего/);
        assert.match(fixMsg, /Стоимость не изменена: расход в кассе по исходной записи/);
        assert.match(voidMsg, /Расход 1\s500\s₽ сторнирован/);
      } finally {
        await ctx.close();
      }
    });
  });
}

async function newZeroClub(tag) {
  const owner = await login(staffPhone());
  const c = await makeClub(owner, { name: `E2E M5.8 Перепроверка Нули ${tag}`, kinds: ['pyramid', 'pool', 'snooker'], courts: 1, rules: [rule('06:00', '06:00', 600), courtRule('06:00', '06:00', 90, 2400)] });
  return { ...c, owner };
}

for (const pass of PASSES) {
  const tag = `w${pass.width}`;
  describe(`${tag}: дашборд «Зал» — число ресурсов вида, M5.6 Н1`, { skip: skip || (!ready && 'нет playwright') }, () => {
    it('«Падел-корт · 2 корта», «Пирамида · 5 столов»; в «Столах» все 10 ресурсов (в новом клубе — все с нулями)', async (t) => {
      const ctx = await newCtx(browser, { ...pass, phone: SEED_PHONES.owner });
      try {
        const page = await open(ctx, `/club/c/${CLUB_SEED}/dashboard?tab=hall`, `${tag}-dash-kinds`, { wait: 1800 });
        const txt = await bodyText(page);
        const line = txt.match(/Падел-корт\s*·\s*[^·]{1,20}/)?.[0];
        t.diagnostic(`сводка видов: ${[...txt.matchAll(/(?:Пирамида|Пул|Снукер|Падел-корт)\s*·\s*\d+\s+[а-я]+/g)].map((m) => m[0]).join(' | ')}`);
        assert.match(txt, /Падел-корт\s*·\s*2 корта/, `строка корта: ${line}`);
        assert.doesNotMatch(txt, /Падел-корт\s*·\s*\d+ (?:стол|стола|столов)/);
        assert.match(txt, /Пирамида\s*·\s*5 столов/);
        const rows = await page.evaluate(() => [...globalThis.document.querySelectorAll('table tbody tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ').trim().slice(0, 30)));
        const named = rows.filter((r) => /^(Стол|Корт) \d+/.test(r));
        t.diagnostic(`строки «Столов»: ${named.length}: ${named.map((r) => r.split(' ').slice(0, 2).join(' ')).join(', ')}`);
        assert.equal(new Set(named.map((r) => r.split(' ').slice(0, 2).join(' '))).size, 10, 'все 10 ресурсов в таблице');
        await screen(t, page, `${tag}-dash-kinds`, pass.scheme);
      } finally {
        await ctx.close();
      }
    });

    it('новый клуб без игр (3 стола, корт): в «Столах» все 4 ресурса с нулями (M5.6 Н1)', async (t) => {
      const c = await newZeroClub(tag);
      const ctx = await newCtx(browser, { ...pass, phone: c.owner.phone });
      try {
        const page = await open(ctx, `/club/c/${c.club}/dashboard?tab=hall`, `${tag}-dash-zero`, { wait: 1800 });
        const rows = await page.evaluate(() => [...globalThis.document.querySelectorAll('table tbody tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ').trim().slice(0, 40)).filter((r) => /^(Стол|Корт) \d+/.test(r)));
        t.diagnostic(`новый клуб, «Столы»: ${rows.join(' | ')}`);
        assert.equal(rows.length, 4, 'в новом клубе в «Столах» все 4 ресурса');
        await screen(t, page, `${tag}-dash-zero`, pass.scheme);
      } finally {
        await ctx.close();
      }
    });

    it('новый клуб без игр: сводка по видам не противоречит таблице («Падел-корт · 1 корт», «Пирамида · 1 стол»)', async (t) => {
      const c = await newZeroClub(tag);
      const ctx = await newCtx(browser, { ...pass, phone: c.owner.phone });
      try {
        const page = await open(ctx, `/club/c/${c.club}/dashboard?tab=hall`, `${tag}-dash-zero-sum`, { wait: 1800 });
        const txt = await bodyText(page);
        const sum = [...txt.matchAll(/(?:Пирамида|Пул|Снукер|Падел-корт)\s*·\s*\d+\s+[а-я]+/g)].map((m) => m[0]);
        t.diagnostic(`сводка видов нового клуба: ${sum.join(' | ') || '—'}`);
        assert.match(txt, /Падел-корт\s*·\s*1 корт/, `сводка: ${sum.join(' | ')}`);
        assert.match(txt, /Пирамида\s*·\s*1 стол/, `сводка: ${sum.join(' | ')}`);
      } finally {
        await ctx.close();
      }
    });
  });
}

describe('Д7. фокус с клавиатуры виден (контур/тень и изменение картинки)', { skip: skip || (!ready && 'нет playwright') }, () => {
  it('план зала (1280, тёмная): кнопки столов и кортов, переключатели, кнопки', async (t) => {
    const ctx = await newCtx(browser, { width: 1280, scheme: 'dark', phone: SEED_PHONES.owner });
    try {
      const page = await open(ctx, `/club/c/${CLUB_SEED}/onboarding/hall`, 'focus-hall', { wait: 1200 });
      const r = await focusAudit(page, { maxStops: 40 });
      t.diagnostic(`план зала: остановок ${r.stops}; без видимого фокуса ${r.bad.length}: ${JSON.stringify(r.bad.slice(0, 8))}`);
      assert.ok(r.stops >= 12, `пройдено остановок: ${r.stops}`);
      assert.deepEqual(r.bad, []);
    } finally {
      await ctx.close();
    }
  });

  it('контроль проверки: на плане зала с принудительно убранным контуром аудит находит остановки без фокуса', async (t) => {
    const ctx = await newCtx(browser, { width: 1280, scheme: 'dark', phone: SEED_PHONES.owner });
    try {
      const page = await open(ctx, `/club/c/${CLUB_SEED}/onboarding/hall`, 'focus-control', { wait: 1000 });
      await page.addStyleTag({ content: '*:focus, *:focus-visible { outline: none !important; box-shadow: none !important; }' });
      const r = await focusAudit(page, { maxStops: 14 });
      t.diagnostic(`контроль: остановок ${r.stops}, без фокуса ${r.bad.length}`);
      assert.ok(r.bad.length >= 5, 'аудит обязан увидеть отсутствие фокуса');
    } finally {
      await ctx.close();
    }
  });

  it('ресепшн (1280, тёмная): заявка, кнопки, вкладки', async (t) => {
    const ctx = await newCtx(browser, { width: 1280, scheme: 'dark', phone: SEED_PHONES.reception });
    try {
      const page = await open(ctx, `/club/c/${CLUB_SEED}/reception`, 'focus-reception', { wait: 1500 });
      const r = await focusAudit(page, { maxStops: 45 });
      t.diagnostic(`ресепшн: остановок ${r.stops}; без видимого фокуса ${r.bad.length}: ${JSON.stringify(r.bad.slice(0, 8))}`);
      assert.ok(r.stops >= 8, `пройдено остановок: ${r.stops}`);
      assert.deepEqual(r.bad, []);
    } finally {
      await ctx.close();
    }
  });

  it('сетка брони гостя (360, светлая): «18:40, свободно 1 корт» и соседние кнопки', async (t) => {
    const g = await newGuest();
    const ctx = await newCtx(browser, { width: 360, scheme: 'light', phone: g.phone });
    try {
      const page = await open(ctx, `/app/book/${CLUB_SEED}?family=court`, 'focus-book', { wait: 1500 });
      const cells = await page.locator('button').evaluateAll((bs) => bs.map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim()).filter((s) => /свободно/i.test(s)).slice(0, 5));
      t.diagnostic(`кнопки сетки: ${JSON.stringify(cells)}`);
      const r = await focusAudit(page, { maxStops: 12 });
      t.diagnostic(`бронь, Tab: остановок ${r.stops}; без видимого фокуса ${r.bad.length}: ${JSON.stringify(r.bad.slice(0, 8))}`);
      // Сетка — один Tab-стоп (блуждающий tabindex): ставим фокус на первую свободную ячейку и ходим стрелками.
      await page.evaluate(() => globalThis.document.activeElement?.blur?.());
      await page.locator('button.slot--free').first().focus();
      const first = await probe(page);
      const arrows = await arrowAudit(page, ['ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp']);
      t.diagnostic(`бронь, ячейка «${first?.name}»: ok=${first?.ok}; стрелки: ${arrows.names.join(' → ')}; без видимого фокуса ${arrows.bad.length}: ${JSON.stringify(arrows.bad)}`);
      assert.ok(r.stops >= 5, `пройдено остановок: ${r.stops}`);
      assert.ok(first?.ok, `ячейка сетки: ${JSON.stringify(first)}`);
      assert.deepEqual(r.bad, []);
      assert.deepEqual(arrows.bad, []);
    } finally {
      await ctx.close();
    }
  });
});

describe('браузер: итоги', { skip: skip || (!ready && 'нет playwright') }, () => {
  it('на всех экранах нет ошибок 5xx и исключений страниц', () => {
    assert.deepEqual(errors, []);
  });
  it('на всех экранах нет прокрутки вбок и axe serious/critical — 0', (t) => {
    const hs = summary.filter((s) => s.hscroll).map((s) => `${s.name} (${s.sw}>${s.iw}: ${s.culprits})`);
    const ax = summary.filter((s) => s.serious.length).map((s) => `${s.name}: ${s.serious.map((v) => `${v.id}[${v.target}]`).join(',')}`);
    t.diagnostic(`экранов: ${summary.length}`);
    assert.deepEqual(hs, [], 'горизонтальная прокрутка');
    assert.deepEqual(ax, [], 'axe serious/critical');
  });
});
