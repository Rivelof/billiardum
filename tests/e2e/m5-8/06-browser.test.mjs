// Браузер M5.5/M5.8 (Playwright, Chromium /opt/pw-browsers): два прохода — 1280×900 светлая и 360×780 тёмная, на каждом
// экране обе темы: без прокрутки вбок, axe без serious/critical, видимый фокус, скриншот (E2E_SHOTS_DIR).
//
//   M5.5 «Сеть» (клубы и данные — из 01 и 02, E2E_M58_DIR/state.json):
//     * экран «Сеть» владельца: клубы, управляющие, тарифы (шаблон, режим), меню; вкладка «Сеть» дашборда;
//     * жёсткий шаблон: на шаге «Тарифы» клуба — «Изменить тарифы — задаёт сеть» и пояснение;
//     * управляющий сети: в дашборде нет вкладки «Деньги», вкладка «Сеть» есть, раздел «Сеть» без кнопок изменения;
//   M5.8 «Падел-корт» (клуб сида, корты 101 и 102 — играют и освобождаются):
//     * админка: план зала, тарифы (вкладка «Падел-корты», слот), ресепшн (заявка на корт), касса, бар (заказ в счёт корта),
//       журнал, контроллеры, отчёт смены, «Зал» дашборда с фильтром «Столы / Корты»;
//     * гость (360 px): QR корта, оплата, игра, продление, «Я играю», бронь, чек, заявка на ресепшн (в том числе открытая
//       в новой вкладке — без контекста оплаты);
//     * сайт: каталог `?d=padel`, страница клуба.
// T48 — слова: сканер `wording` (browser-lib.mjs) ищет мелкие блоки, где один ресурс назван и «столом», и «кортом».

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyText, chromium, errors, newCtx, screen, skip, summary, tableWords, watch, wording } from './browser-lib.mjs';
import { api, BASE, CLUB_SEED, COURTS, loadState, login, newGuest, payQuote, quote, SEED_PHONES, short, startGame, stopGame, tableByCode, waitCourtFree } from './lib.mjs';

const S = loadState();
const PASSES = [
  { width: 1280, scheme: 'light' },
  { width: 360, scheme: 'dark' },
];
const G = {};
let browser;

/** Заявка «Оплачу на ресепшене» на корт 102 (держит корт до отклонения). */
async function makeRequest() {
  await waitCourtFree(102, G.g3.token, 240_000);
  const t = await tableByCode(COURTS[102].code, G.g3.token);
  const q = await quote(G.g3.token, { resource_id: t.json.resource.id, kind: 'start', minutes: 90 });
  const p = await payQuote(G.g3.token, q.json.quote_id, 'reception');
  G.request = p.status === 200 ? p.json.reception_request_id : null;
  return G.request;
}
async function dropRequest() {
  if (!G.request) return;
  await api('POST', `/api/reception/requests/${G.request}/decline`, { token: G.rec.token, body: { reason_code: 'other' } }).catch(() => {});
  G.request = null;
}
const ready = !skip && S.t41 && S.t42 && S.t42net && S.t41b;

before(async () => {
  if (!ready) return;
  browser = await chromium.launch();
  G.owner = await login(SEED_PHONES.owner);
  G.rec = await login(SEED_PHONES.reception);
  G.g1 = await newGuest();
  G.g2 = await newGuest();
  G.g3 = await newGuest();
  await waitCourtFree(101, G.g1.token);
  await waitCourtFree(102, G.g3.token);
  G.game = await startGame(101, 90, G.g1);
  // Заказ из бара в счёт корта: заказ называет «Корт 1» на экране бара и в кассе.
  const menu = (await api('GET', `/api/clubs/${CLUB_SEED}/catalog`, { token: G.owner.token, club: CLUB_SEED })).json;
  const prod = (menu.products ?? []).find((p) => p.active && !p.is_alcohol && !p.stop_list);
  if (prod) {
    const o = await api('POST', '/api/orders', { token: G.g1.token, idem: true, body: { session_id: G.game.sessionId, items: [{ product_id: prod.id, qty: 1 }], pay: 'tab' } });
    G.order = o.status === 201 ? o.json : null;
    G.orderNote = o.status === 201 ? `заказ в счёт корта: ${prod.name}` : `заказ не создан: ${short(o)}`;
  }
});

after(async () => {
  if (!ready) return;
  if (G.game) await stopGame(G.g1, G.game.sessionId).catch(() => {});
  await dropRequest();
  await browser?.close();
  const bad = summary.filter((s) => s.hscroll || s.serious.length);
  console.log(`# экранов проверено: ${summary.length}; с прокруткой вбок: ${summary.filter((s) => s.hscroll).length}; с axe serious/critical: ${summary.filter((s) => s.serious.length).length}; ошибки страниц: ${errors.length}`);
  for (const b of bad) console.log(`#   ${b.name}: ${b.hscroll ? `прокрутка ${b.sw}>${b.iw} (${b.culprits})` : ''} ${b.serious.map((v) => `${v.id}[${v.target}]`).join(',')}`);
});

async function open(ctx, url, tag, { wait = 700 } = {}) {
  const page = await ctx.newPage();
  watch(page, tag);
  await page.goto(`${BASE}${url}`, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); // поток SSE держит сеть
  await page.waitForTimeout(wait);
  return page;
}
const tab = async (page, name) => {
  await page.getByRole('tab', { name: new RegExp(name) }).first().click();
  await page.waitForTimeout(600);
};

for (const pass of PASSES) {
  const tag = `w${pass.width}`;
  const skipAll = !ready && 'нет playwright или состояния 01/02';

  describe(`${tag}: M5.5 «Сеть»`, { skip: skipAll }, () => {
    it('экран «Сеть» владельца: клубы, управляющие, тарифы, меню; вкладка «Сеть» дашборда', async (t) => {
      const ctx = await newCtx(browser, { ...pass, phone: S.t42.owner });
      try {
        const page = await open(ctx, `/club/c/${S.t42.c1}/network/${S.t42net}`, `${tag}-net`);
        let txt = await bodyText(page);
        assert.match(txt, /Вы — владелец сети/);
        assert.match(txt, /E2E M5\.8 Упр-Екб/);
        assert.match(txt, /E2E M5\.8 Упр-Кгд/);
        assert.match(txt, /Europe\/Kaliningrad/);
        assert.match(txt, /1 190 ₽ за стол в месяц/);
        await screen(t, page, `${tag}-net-clubs`, pass.scheme);
        await tab(page, 'Управляющие');
        txt = await bodyText(page);
        assert.match(txt, /\+7998\*\*\*/, 'телефон управляющего — маской');
        assert.doesNotMatch(txt, new RegExp(S.t42nm.replace('+', '\\+')), 'полного номера на экране нет');
        await screen(t, page, `${tag}-net-managers`, pass.scheme);
        await tab(page, 'Тарифы');
        await screen(t, page, `${tag}-net-tariffs-empty`, pass.scheme);
        await tab(page, 'Меню');
        await screen(t, page, `${tag}-net-menu-empty`, pass.scheme);
        // Дашборд, вкладка «Сеть».
        const dash = await open(ctx, `/club/c/${S.t42.c1}/dashboard?tab=network&network=${S.t42net}`, `${tag}-netdash`);
        txt = await bodyText(dash);
        assert.match(txt, /клубы в рейтинге: 0 из 2/);
        assert.match(txt, /Вне рейтинга/);
        assert.match(txt, /Каждый клуб считается по своим рабочим суткам и часовому поясу/);
        await screen(t, dash, `${tag}-net-dashboard`, pass.scheme);
      } finally {
        await ctx.close();
      }
    });

    it('шаблон тарифов и меню сети (Екатеринбург + Калининград): правила, режим «мягкий», клубы с версиями', async (t) => {
      const ctx = await newCtx(browser, { ...pass, phone: S.t41.owner });
      try {
        const page = await open(ctx, `/club/c/${S.t41.e}/network/${S.t41net}`, `${tag}-tpl`);
        await tab(page, 'Тарифы');
        let txt = await bodyText(page);
        assert.match(txt, /Мягкий/, 'режим шаблона');
        assert.match(txt, /700 ₽/, 'цена шаблона 700 ₽/ч (v3)');
        assert.match(txt, /1 000 ₽/);
        assert.match(txt, /Asia\/Yekaterinburg|Екатеринбург/);
        assert.match(txt, /Europe\/Kaliningrad/);
        await screen(t, page, `${tag}-tpl-tariffs`, pass.scheme);
        await tab(page, 'Меню');
        txt = await bodyText(page);
        assert.match(txt, /Лимонад E2E/);
        await screen(t, page, `${tag}-tpl-menu`, pass.scheme);
      } finally {
        await ctx.close();
      }
    });

    it('жёсткий шаблон: шаг «Тарифы» клуба — «задаёт сеть»; в «Меню» товар шаблона под замком', async (t) => {
      const owner = await login(S.t41.owner);
      await api('PATCH', `/api/networks/${S.t41net}`, { token: owner.token, body: { tariffs_mode: 'hard', menu_mode: 'hard' } });
      const ctx = await newCtx(browser, { ...pass, phone: S.t41.owner });
      try {
        const page = await open(ctx, `/club/c/${S.t41.e}/onboarding/tariffs`, `${tag}-locked`);
        const txt = await bodyText(page);
        assert.match(txt, /Изменить тарифы — задаёт сеть/);
        assert.match(txt, /задаёт сеть «E2E M5\.8 Сеть Урал»: шаблон жёсткий/);
        await screen(t, page, `${tag}-locked-tariffs`, pass.scheme);
        const menu = await open(ctx, `/club/c/${S.t41.e}/menu`, `${tag}-locked-menu`);
        const mt = await bodyText(menu);
        t.diagnostic(`меню клуба при жёстком шаблоне: ${/Лимонад E2E/.test(mt) ? 'товар шаблона виден' : 'товара нет'}`);
        await screen(t, menu, `${tag}-locked-menu`, pass.scheme);
      } finally {
        await ctx.close();
        await api('PATCH', `/api/networks/${S.t41net}`, { token: owner.token, body: { tariffs_mode: 'soft', menu_mode: 'soft' } });
      }
    });

    it('сеть с кортом в шаблоне (владелец Б): правило корта слотом 90 мин в шаблоне и в клубе', async (t) => {
      const ctx = await newCtx(browser, { ...pass, phone: S.t41b.owner });
      try {
        const page = await open(ctx, `/club/c/${S.t41b.g}/network/${S.t41b.net}`, `${tag}-tplb`);
        await tab(page, 'Тарифы');
        await page.getByText('Падел-корты', { exact: true }).first().click();
        await page.waitForTimeout(600);
        const txt = await bodyText(page);
        t.diagnostic(`шаблон, вкладка кортов: ${txt.replace(/^.*?Столы Падел-корты/, '').slice(0, 500)}`);
        assert.match(txt, /2 600 ₽/, 'цена слота корта в шаблоне');
        assert.match(txt, /1,5 ч|90 мин/, 'слот корта');
        const w = await wording(page);
        assert.deepEqual(w.courtWithTable, [], `шаблон, корт со словом «стол»: ${JSON.stringify(w.courtWithTable.slice(0, 3))}`);
        await screen(t, page, `${tag}-tplb-tariffs`, pass.scheme);
        const club = await open(ctx, `/club/c/${S.t41b.g}/onboarding/tariffs`, `${tag}-tplb-club`);
        await club.getByText('Падел-корты', { exact: true }).first().click().catch(() => {});
        await club.waitForTimeout(500);
        await screen(t, club, `${tag}-tplb-club-tariffs`, pass.scheme);
      } finally {
        await ctx.close();
      }
    });

    it('управляющий сети: в дашборде нет «Денег», есть «Сеть»; раздел «Сеть» без кнопок изменения; клуб — как управляющий', async (t) => {
      const ctx = await newCtx(browser, { ...pass, phone: S.t42nm });
      try {
        const dash = await open(ctx, `/club/c/${S.t42.c1}/dashboard`, `${tag}-nm-dash`);
        const tabs = (await dash.getByRole('tab').allInnerTexts()).map((x) => x.trim());
        t.diagnostic(`вкладки дашборда управляющего сети: ${tabs.join(' | ')}`);
        assert.ok(!tabs.includes('Деньги'), 'вкладки «Деньги» нет');
        assert.ok(tabs.includes('Сеть'), 'вкладка «Сеть» есть');
        await screen(t, dash, `${tag}-nm-dash`, pass.scheme);
        const net = await open(ctx, `/club/c/${S.t42.c1}/network/${S.t42net}`, `${tag}-nm-net`);
        const txt = await bodyText(net);
        assert.match(txt, /управляющий сети|Вы — управляющий/i);
        assert.equal(await net.getByRole('button', { name: /Удалить сеть|Убрать из сети|Переименовать/ }).count(), 0, 'кнопок изменения нет');
        await screen(t, net, `${tag}-nm-net`, pass.scheme);
        const netdash = await open(ctx, `/club/c/${S.t42.c1}/dashboard?tab=network&network=${S.t42net}`, `${tag}-nm-netdash`);
        assert.match(await bodyText(netdash), /Вне рейтинга/);
        await screen(t, netdash, `${tag}-nm-netdash`, pass.scheme);
        const shift = await open(ctx, `/club/c/${S.t42.c1}/shift`, `${tag}-nm-shift`);
        const st = await bodyText(shift);
        t.diagnostic(`смена у управляющего сети: ${st.slice(0, 200)}`);
        assert.doesNotMatch(st, /СБП|Наличные продажи|Картой на терминале/, 'способы оплаты на экране смены скрыты');
        await screen(t, shift, `${tag}-nm-shift`, pass.scheme);
        const more = await open(ctx, `/club/c/${S.t42.c1}/more`, `${tag}-nm-more`);
        assert.match(await bodyText(more), /Сеть/);
        await screen(t, more, `${tag}-nm-more`, pass.scheme);
      } finally {
        await ctx.close();
      }
    });
  });

  describe(`${tag}: M5.8 корты в админке клуба сида`, { skip: skipAll }, () => {
    const adminCtx = () => newCtx(browser, { ...pass, phone: SEED_PHONES.owner });

    it('план зала и тарифы: 8 столов и 2 корта, «Падел-корты» со слотом', async (t) => {
      const ctx = await adminCtx();
      try {
        const hall = await open(ctx, `/club/c/${CLUB_SEED}/onboarding/hall`, `${tag}-hall`);
        let txt = await bodyText(hall);
        assert.match(txt, /8 столов и 2 корта в работе/);
        assert.match(txt, /Добавить стол или корт/);
        await screen(t, hall, `${tag}-hall`, pass.scheme);
        // На 360 px вместо плана сразу список (переключателя «План / Список» нет).
        const toList = hall.getByRole('button', { name: 'Список' });
        if (await toList.count()) await toList.first().click();
        await hall.waitForTimeout(500);
        txt = await bodyText(hall);
        assert.match(txt, /Корт 1/);
        assert.match(txt, /Корт 2/);
        const w = await wording(hall);
        assert.deepEqual(w.courtWithTable, [], `план зала, список: ${JSON.stringify(w.courtWithTable.slice(0, 3))}`);
        await screen(t, hall, `${tag}-hall-list`, pass.scheme);
        const tar = await open(ctx, `/club/c/${CLUB_SEED}/onboarding/tariffs`, `${tag}-tariffs`);
        await tar.getByText('Падел-корты', { exact: true }).first().click();
        await tar.waitForTimeout(600);
        txt = await bodyText(tar);
        t.diagnostic(`тарифы, вкладка корта: ${txt.replace(/^.*?Падел-корты/, 'Падел-корты').slice(0, 600)}`);
        assert.match(txt, /1,5 ч|90 мин|слот/i, 'слот корта в тарифах');
        assert.match(txt, /2 400 ₽|3 600 ₽|3 900 ₽/, 'цена слота');
        const tw = await wording(tar);
        assert.deepEqual(tw.courtWithTable, [], `тарифы корта: ${JSON.stringify(tw.courtWithTable.slice(0, 3))}`);
        await screen(t, tar, `${tag}-tariffs-court`, pass.scheme);
      } finally {
        await ctx.close();
      }
    });

    it('журнал и контроллеры: действия корта называют корт — без «Команда столу · Корт N» и «Заказ со стола · Корт N»', async (t) => {
      const ctx = await adminCtx();
      try {
        const j = await open(ctx, `/club/c/${CLUB_SEED}/journal`, `${tag}-journal`);
        const jw = await wording(j);
        t.diagnostic(`журнал: «Корт N» + «стол»: ${JSON.stringify(jw.courtWithTable.slice(0, 6))}`);
        await screen(t, j, `${tag}-journal`, pass.scheme);
        const d = await open(ctx, `/club/c/${CLUB_SEED}/devices`, `${tag}-devices`);
        const dw = await wording(d);
        assert.deepEqual(dw.courtWithTable, [], `контроллеры: ${JSON.stringify(dw.courtWithTable.slice(0, 3))}`);
        await screen(t, d, `${tag}-devices`, pass.scheme);
        const now = await open(ctx, `/club/c/${CLUB_SEED}/now`, `${tag}-now`);
        const nw = await wording(now);
        assert.deepEqual(nw.courtWithTable, [], `«Сейчас»: ${JSON.stringify(nw.courtWithTable.slice(0, 3))}`);
        await screen(t, now, `${tag}-now`, pass.scheme);
        assert.deepEqual(jw.courtWithTable, [], `журнал: блоки «Корт N» со словом «стол»: ${JSON.stringify(jw.courtWithTable.slice(0, 6))}`);
      } finally {
        await ctx.close();
      }
    });

    it('дашборд «Зал» с фильтром «Столы / Корты» и отчёт смены «Столы — … ; корты — …»', async (t) => {
      const ctx = await adminCtx();
      try {
        const page = await open(ctx, `/club/c/${CLUB_SEED}/dashboard?tab=hall`, `${tag}-dash-hall`, { wait: 1200 });
        const txt = await bodyText(page);
        assert.match(txt, /Корт 1/);
        assert.match(txt, /Корт 2/);
        t.diagnostic(`фильтр вида на «Зале»: ${txt.match(/Столы\s*\/\s*Корты|Все виды|Только корты|Корты/g)?.slice(0, 4).join(', ') ?? 'нет'}`);
        await screen(t, page, `${tag}-dash-hall`, pass.scheme);
        const court = await open(ctx, `/club/c/${CLUB_SEED}/dashboard?tab=hall&kind=court`, `${tag}-dash-court`, { wait: 1200 });
        await screen(t, court, `${tag}-dash-court`, pass.scheme);
        const cur = (await api('GET', `/api/clubs/${CLUB_SEED}/shifts/current`, { token: G.owner.token, club: CLUB_SEED })).json.shift;
        if (cur) {
          const rep = await open(ctx, `/club/c/${CLUB_SEED}/shift/${cur.id}`, `${tag}-shift-report`, { wait: 1200 });
          const rt = await bodyText(rep);
          assert.match(rt, /Столы — [\d,]+ ч, загрузка [\d,]+ %/);
          assert.match(rt, /корты — [\d,]+ ч, загрузка [\d,]+ %/i);
          const rw = await wording(rep);
          assert.deepEqual(rw.courtWithTable, [], `отчёт смены: ${JSON.stringify(rw.courtWithTable.slice(0, 3))}`);
          await screen(t, rep, `${tag}-shift-report`, pass.scheme);
        } else t.diagnostic('открытой смены нет — отчёт смены не открывался');
      } finally {
        await ctx.close();
      }
    });
  });

  describe(`${tag}: M5.8 гость: QR корта, оплата, игра, продление, «Я играю», чек`, { skip: skipAll }, () => {
    it('QR свободного корта' + (pass.width < 1000 ? ' и экран оплаты' : ''), async (t) => {
      const fresh = await newGuest();
      const ctx = await newCtx(browser, { ...pass, phone: fresh.phone });
      try {
        await waitCourtFree(102, fresh.token, 240_000);
        const scan = await open(ctx, `/t/${COURTS[102].code}`, `${tag}-g-scan`);
        let txt = await bodyText(scan);
        assert.match(txt, /Корт 2/);
        assert.match(txt, /Слот — 1,5 ч/);
        assert.match(txt, /Игра на корте — слотами по 1,5 ч/);
        assert.deepEqual(await tableWords(scan), [], 'экран QR корта');
        await screen(t, scan, `${tag}-g-scan`, pass.scheme);
        if (pass.width < 1000) {
          // Экран оплаты — один раз (котировка держит корт 3 минуты).
          await scan.getByRole('button', { name: /Продолжить к оплате/ }).click();
          await scan.waitForTimeout(1200);
          txt = await bodyText(scan);
          assert.match(txt, /Корт 2 · 1,5 ч/);
          assert.deepEqual(await tableWords(scan), [], 'экран оплаты корта');
          await screen(t, scan, `${tag}-g-pay`, pass.scheme);
        }
      } finally {
        await ctx.close();
      }
    });

    it('игра на корте 101: экран игры, продление слотом, чек, бар; другой гость — «Я играю на этом корте»', async (t) => {
      const issues = [];
      const words = async (page, what) => {
        const w = await tableWords(page);
        if (w.length) issues.push(`${what}: ${JSON.stringify(w)}`);
      };
      const ctx1 = await newCtx(browser, { ...pass, phone: G.g1.phone });
      try {
        const game = await open(ctx1, `/app/s/${G.game.sessionId}`, `${tag}-g-game`);
        let txt = await bodyText(game);
        assert.match(txt, /Корт 1/);
        assert.match(txt, /Осталось/);
        await words(game, 'экран игры на корте');
        await screen(t, game, `${tag}-g-game`, pass.scheme);
        await game.getByRole('button', { name: /Продлить игру/ }).click();
        await game.waitForTimeout(700);
        txt = await bodyText(game);
        assert.match(txt, /На сколько продлить\?/);
        assert.match(txt, /Слот — 1,5 ч/);
        await words(game, 'окно продления корта');
        await screen(t, game, `${tag}-g-extend`, pass.scheme);
        const rc = await open(ctx1, `/app/s/${G.game.sessionId}/receipt`, `${tag}-g-receipt`);
        txt = await bodyText(rc);
        assert.match(txt, /Корт 1, 90 минут/);
        await words(rc, 'чек корта');
        await screen(t, rc, `${tag}-g-receipt`, pass.scheme);
        const bar = await open(ctx1, `/app/s/${G.game.sessionId}/bar`, `${tag}-g-bar`);
        t.diagnostic(`бар гостя на корте: слова «стол…»: ${JSON.stringify(await tableWords(bar))}`);
        await screen(t, bar, `${tag}-g-bar`, pass.scheme);
      } finally {
        await ctx1.close();
      }
      const ctx2 = await newCtx(browser, { ...pass, phone: G.g2.phone });
      try {
        const busy = await open(ctx2, `/t/${COURTS[101].code}`, `${tag}-g-busy`);
        let txt = await bodyText(busy);
        assert.match(txt, /Корт занят до/);
        assert.match(txt, /Я играю на этом корте/);
        await words(busy, 'занятый корт');
        await screen(t, busy, `${tag}-g-busy`, pass.scheme);
        await busy.getByRole('button', { name: /Я играю на этом корте/ }).click();
        await busy.waitForTimeout(1200);
        txt = await bodyText(busy);
        t.diagnostic(`после «Я играю»: ${txt.slice(0, 220)}`);
        await words(busy, 'после «Я играю»');
        await screen(t, busy, `${tag}-g-joined`, pass.scheme);
      } finally {
        await ctx2.close();
      }
      assert.deepEqual(issues, [], 'слово «стол» на экранах корта');
    });

    it('бронь корта: выбор вида, сетка «сколько кортов», слот', async (t) => {
      const g = await newGuest();
      const ctx = await newCtx(browser, { ...pass, phone: g.phone });
      try {
        const page = await open(ctx, `/app/book/${CLUB_SEED}?family=court`, `${tag}-g-book`);
        const txt = await bodyText(page);
        assert.match(txt, /Падел-корт\s*2 корта, игра слотами/);
        assert.match(txt, /Свободно, цифра — сколько кортов/);
        const w = await wording(page);
        t.diagnostic(`бронь: смешанных ${JSON.stringify(w.mixed)}`);
        await screen(t, page, `${tag}-g-book`, pass.scheme);
      } finally {
        await ctx.close();
      }
    });
  });

  describe(`${tag}: M5.8 заявка на ресепшн за корт (ресепшн, касса, гость)`, { skip: skipAll }, () => {
    before(async () => {
      if (ready) await makeRequest();
    });
    after(async () => {
      await dropRequest();
    });

    it('ресепшн: заявка «Корт 2 · 1 слот · 1,5 ч», зал со столами и «Падел-корты»', async (t) => {
      assert.ok(G.request, 'заявка создана');
      const ctx = await newCtx(browser, { ...pass, phone: SEED_PHONES.reception });
      try {
        const page = await open(ctx, `/club/c/${CLUB_SEED}/reception`, `${tag}-reception`);
        const txt = await bodyText(page);
        assert.match(txt, /Корт 2/);
        assert.match(txt, /1 слот · 1,5 ч/);
        assert.match(txt, /Падел-корты/);
        assert.match(txt, /Свободно \d+ (стол|стола|столов)/);
        const w = await wording(page);
        t.diagnostic(`ресепшн: смешанных ${JSON.stringify(w.mixed)}`);
        assert.deepEqual(w.courtWithTable, [], `блоки с «Корт N» и словом «стол»: ${JSON.stringify(w.courtWithTable)}`);
        await screen(t, page, `${tag}-reception`, pass.scheme);
      } finally {
        await ctx.close();
      }
    });

    it('касса и бар: заявка гостя «Корт 2» и счёт «Корт 1» называют корт; заказ в счёт корта в баре — «Корт 1»', async (t) => {
      const ctx = await newCtx(browser, { ...pass, phone: SEED_PHONES.reception });
      try {
        const pos = await open(ctx, `/club/c/${CLUB_SEED}/pos`, `${tag}-pos`);
        const pt = await bodyText(pos);
        assert.match(pt, /Корт 2/);
        assert.match(pt, /1 слот · 1,5 ч/);
        const pw = await wording(pos);
        t.diagnostic(`касса: «Корт N» + «стол»: ${JSON.stringify(pw.courtWithTable)}`);
        await screen(t, pos, `${tag}-pos`, pass.scheme);
        const bar = await open(ctx, `/club/c/${CLUB_SEED}/bar`, `${tag}-bar`);
        const bt = await bodyText(bar);
        t.diagnostic(G.orderNote ?? 'заказа нет');
        if (G.order) assert.match(bt, /Корт 1/, 'заказ в счёт корта подписан «Корт 1»');
        const bw = await wording(bar);
        await screen(t, bar, `${tag}-bar`, pass.scheme);
        assert.deepEqual(bw.courtWithTable, [], `бар: ${JSON.stringify(bw.courtWithTable)}`);
        assert.deepEqual(pw.courtWithTable, [], `касса: «Корт N» + «стол»: ${JSON.stringify(pw.courtWithTable)}`);
      } finally {
        await ctx.close();
      }
    });

    it('гость: заявка на ресепшн за корт — «Корт 2…» в новой вкладке и после перехода по ссылке (без контекста оплаты)', async (t) => {
      assert.ok(G.request, 'заявка создана');
      const ctx = await newCtx(browser, { ...pass, phone: G.g3.phone });
      try {
        const page = await open(ctx, `/app/r/${G.request}`, `${tag}-g-request`);
        const txt = await bodyText(page);
        t.diagnostic(`заявка в новой вкладке: ${txt.slice(0, 260)}`);
        assert.match(txt, /Подойдите на ресепшн/);
        await screen(t, page, `${tag}-g-request`, pass.scheme);
        assert.match(txt, /Корт 2/, 'заявка на корт называет «Корт 2»');
        assert.deepEqual(await tableWords(page), [], 'слово «стол» в заявке на корт');
      } finally {
        await ctx.close();
      }
    });
  });

  describe(`${tag}: M5.8 сайт с кортом`, { skip: skipAll }, () => {
    it('каталог `?d=padel` и страница клуба с кортами (SSR) — тексты по виду ресурса', async (t) => {
      const ctx = await newCtx(browser, { ...pass, phone: G.g2.phone });
      try {
        const cat = await open(ctx, '/ekaterinburg/?d=padel', `${tag}-site-padel`);
        const catTxt = await bodyText(cat);
        let txt = catTxt;
        assert.match(txt, /(Свободно \d+ (корт|корта|кортов)|Корты заняты|Нет свободных кортов|Все корты заняты)/, 'карточка: свободные корты');
        assert.match(txt, /Падел: от 2 400 ₽ за 1,5 ч/);
        t.diagnostic(`каталог ?d=padel: слова «стол…» вне пар: ${JSON.stringify(await tableWords(cat)).slice(0, 700)}`);
        t.diagnostic(`заголовок: ${await cat.title()}`);
        await screen(t, cat, `${tag}-site-padel`, pass.scheme);
        const club = await open(ctx, '/ekaterinburg/testovyy-klub/', `${tag}-site-club`);
        txt = await bodyText(club);
        assert.match(txt, /Падел-корты/);
        assert.match(txt, /Корт 1/);
        assert.match(txt, /Падел, ₽ за 1,5 ч/);
        assert.match(txt, /падел-корт — за слот/);
        const cw = await wording(club);
        t.diagnostic(`страница клуба: смешанных ${cw.mixed.length}`);
        assert.deepEqual(cw.courtWithTable, [], `страница клуба: ${JSON.stringify(cw.courtWithTable.slice(0, 3))}`);
        await screen(t, club, `${tag}-site-club`, pass.scheme);
        // Каталог только «Падел»: заголовок, подпись фильтра цены и сортировка не должны говорить про столы (T48; цена, сортировка
        // и «свободно» считаются по кортам — решение №221).
        const bad = [];
        if (/стол/i.test(await cat.title())) bad.push(`заголовок «${await cat.title()}»`);
        if (/Цена часа стола/.test(catTxt)) bad.push('подпись фильтра «Цена часа стола»');
        if (/Больше свободных столов/.test(catTxt)) bad.push('сортировка «Больше свободных столов»');
        assert.deepEqual(bad, [], 'каталог с фильтром «Падел» называет столы там, где считает корты');
      } finally {
        await ctx.close();
      }
    });
  });
}

describe('браузер: итоги', { skip: !ready && 'нет playwright или состояния 01/02' }, () => {
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
