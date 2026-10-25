// Браузер M5.6/M5.7 (Playwright, Chromium /opt/pw-browsers): два прохода — 1280×900 светлая и 360×780 тёмная,
// на каждом экране обе темы: без прокрутки вбок, axe без serious/critical, видимый фокус, скриншот.
//
//   * «Зал» клуба сида: «Факт / Прогноз» (переключатель с клавиатуры), «мало данных» = history_days API,
//     подсказки — «появятся вместе с прогнозом»; «Столы» — столбец «С замены сукна, ч» = API;
//   * «Зал» с прогнозом и подсказками: ответ сервера дополняется series.forecast и hints из своего прогона 01
//     (настоящий сервер на своём Postgres, forecast-fixture.json) — на стенде 8 недель истории нет;
//   * «Отчёты → Обслуживание столов» (свой клуб из 02): событие с расходом, исправление без стоимости,
//     «События не было», «Пороги» (Esc закрывает); ресепшну раздел не открывается;
//   * «API и вебхуки» (свой клуб A из 03): ключ показывается один раз — после «Готово» его нет ни на экране,
//     ни после перезагрузки; отзыв из интерфейса; внутренний адрес вебхука — понятная ошибка.
// Запуск — после 01 (fixture), 02 и 03 (свои клубы в E2E_M56_DIR/state.json).

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { bodyText, chromium, errors, newCtx, screen, skip, summary, watch } from './browser-lib.mjs';
import { api, BASE, CLUB_SEED, loadState, login, SEED_PHONES, STATE_DIR } from './lib.mjs';

const S = loadState();
const FIXTURE = path.join(STATE_DIR, 'forecast-fixture.json');
const PASSES = [
  { width: 1280, scheme: 'light' },
  { width: 360, scheme: 'dark' },
];
let browser;
const ready = !skip && S.maintClub && S.apiA;

before(async () => {
  if (!ready) return;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

async function open(ctx, url, tag) {
  const page = await ctx.newPage();
  watch(page, tag);
  await page.goto(`${BASE}${url}`, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); // поток SSE держит сеть
  await page.waitForTimeout(500);
  return page;
}

for (const pass of PASSES) {
  const tag = `w${pass.width}`;

  test(`${tag}: «Зал» клуба сида — Факт / Прогноз, мало данных, подсказки, столбец сукна`, { skip: !ready && 'нет playwright или состояния 02/03' }, async (t) => {
    const owner = await login(SEED_PHONES.owner);
    const hall = (await api('GET', `/api/clubs/${CLUB_SEED}/dashboard?tab=hall`, { token: owner.token, club: CLUB_SEED })).json;
    const ctx = await newCtx(browser, { ...pass, phone: SEED_PHONES.owner });
    try {
      const page = await open(ctx, `/club/c/${CLUB_SEED}/dashboard?tab=hall`, `${tag}-hall`);
      const txt = await bodyText(page);
      assert.match(txt, /Загрузка по дням недели и часам/);
      assert.ok(await page.locator('input[name="dheat-mode"][value="fact"]').isChecked(), 'по умолчанию — факт');
      // «Столы»: столбец часов с замены сукна = API.
      assert.match(txt, /С замены сукна, ч/);
      const s7 = hall.tables.by_resource.find((r) => r.number === 7 && r.type !== 'padel_court');
      if (s7) assert.ok(txt.includes(new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(s7.cloth_hours)), `сукно стола 7 ${s7.cloth_hours}`);
      await screen(t, page, `${tag}-hall-fact`, pass.scheme);
      // Переключатель с клавиатуры.
      await page.locator('input[name="dheat-mode"][value="fact"]').focus();
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(300);
      assert.ok(await page.locator('input[name="dheat-mode"][value="forecast"]').isChecked(), 'стрелка → «Прогноз»');
      const t2 = await bodyText(page);
      const days = hall.series.forecast.history_days;
      assert.equal(hall.series.forecast.status, 'insufficient_data');
      assert.ok(t2.includes(`Мало истории для прогноза — нужно 14 дней, сейчас ${days} ${days === 1 ? 'день' : days < 5 ? 'дня' : 'дней'}`), `текст «мало данных»: ${t2.match(/Мало истории[^.]*\./)?.[0]}`);
      assert.match(t2, /Подсказки появятся вместе с прогнозом, когда у клуба будет 14 дней истории/);
      assert.match(t2, /прогноз/);
      await screen(t, page, `${tag}-hall-forecast-empty`, pass.scheme);
      t.diagnostic(`факт по умолчанию; «С замены сукна, ч» на месте; стрелка → прогноз: «${t2.match(/Мало истории[^.]*\./)?.[0]}»`);
    } finally {
      await ctx.close();
    }
  });

  test(`${tag}: «Зал» с прогнозом и подсказками (ответ сервера из 01)`, { skip: (!ready || !existsSync(FIXTURE)) && 'нет forecast-fixture.json (прогон 01)' }, async (t) => {
    const fx = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const ctx = await newCtx(browser, { ...pass, phone: SEED_PHONES.owner });
    try {
      await ctx.route(/\/api\/clubs\/[^/]+\/dashboard\?.*tab=hall/, async (route) => {
        const resp = await route.fetch();
        const json = await resp.json();
        json.series.forecast = fx.forecast;
        json.hints = fx.hints;
        await route.fulfill({ response: resp, json });
      });
      const page = await open(ctx, `/club/c/${CLUB_SEED}/dashboard?tab=hall`, `${tag}-hall-fx`);
      await page.locator('label.seg__item', { hasText: 'Прогноз' }).click();
      await page.waitForTimeout(400);
      const txt = await bodyText(page);
      assert.match(txt, /Прогноз на неделю/);
      assert.match(txt, /медиана за 8 недель \(/);
      assert.match(txt, /Это ориентир, а не обещание/);
      assert.match(txt, /Праздники клуба считаются как воскресенье/);
      const items = page.locator('ul.phints > li');
      assert.equal(await items.count(), fx.hints.length);
      for (let i = 0; i < fx.hints.length; i += 1) assert.ok((await items.nth(i).innerText()).includes(fx.hints[i].text), `подсказка ${i + 1}`);
      assert.equal(await page.getByRole('link', { name: /Открыть тарифы/ }).count(), fx.hints.length);
      await screen(t, page, `${tag}-hall-forecast`, pass.scheme);
      // Таблица-дубль для диктора: пятница 20:00 — 86,7 %.
      await page.locator('#heat').getByRole('button', { name: /Показать таблицей/ }).click().catch(async () => page.getByRole('button', { name: /Показать таблицей/ }).first().click());
      await page.waitForTimeout(300);
      const tt = await bodyText(page);
      assert.match(tt, /86,7/);
      // Цены не меняются: подсказка ведёт в тарифы, сама ничего не пишет (запросов кроме GET нет).
      const writes = [];
      page.on('request', (r) => r.method() !== 'GET' && r.url().includes('/api/') && writes.push(`${r.method()} ${new URL(r.url()).pathname}`));
      await page.waitForTimeout(500);
      assert.deepEqual(writes, []);
      t.diagnostic(`подсказок ${fx.hints.length}: ${fx.hints.map((h) => `«${h.text}»`).join(' ')}; «Открыть тарифы» × ${fx.hints.length}; таблица-дубль содержит 86,7`);
    } finally {
      await ctx.close();
    }
  });

  test(`${tag}: «Отчёты → Обслуживание столов» — событие с расходом, исправление, «не было», пороги`, { skip: !ready && 'нет состояния 02' }, async (t) => {
    const ctx = await newCtx(browser, { ...pass, phone: S.maintOwnerPhone });
    try {
      const page = await open(ctx, `/club/c/${S.maintClub}/reports/maintenance`, `${tag}-maint`);
      let txt = await bodyText(page);
      assert.match(txt, /Обслуживание столов/);
      assert.match(txt, /Счётчик — часы игры стола с последней замены/);
      assert.doesNotMatch(txt, /Корт 1 ·/, 'корта в счётчиках нет');
      await screen(t, page, `${tag}-maint`, pass.scheme);
      // Событие с расходом.
      await page.getByRole('button', { name: /^Событие$/ }).click();
      const dlg = page.getByRole('dialog');
      await dlg.waitFor();
      assert.ok(await dlg.evaluate((d) => d.contains(globalThis.document.activeElement)), 'фокус в окне');
      await dlg.locator('#me-resource').selectOption({ label: 'Стол 1 · Пирамида' });
      await dlg.locator('label.seg__item', { hasText: 'Сукно' }).first().click().catch(async () => dlg.locator('input[name="me-kind"][value="cloth"]').check());
      await dlg.locator('#me-cost').fill('1 500');
      await dlg.locator('#me-comment').fill(`E2E браузер ${tag}`);
      await screen(t, page, `${tag}-maint-event-dialog`, pass.scheme);
      const submit = dlg.getByRole('button', { name: /Записать событие и расход 1\s500\s₽/ });
      assert.equal(await submit.count(), 1, 'кнопка называет расход');
      await submit.click();
      await dlg.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(800);
      txt = await bodyText(page);
      assert.match(txt, /Записано: замена сукна, стол 1, .*Расход 1\s500\s₽ — в кассе управляющего/);
      // Ответы сервера на запись событий: cashbook.action (что сделала касса).
      const actions = [];
      page.on('response', async (r) => {
        if (r.request().method() === 'POST' && /\/maintenance$/.test(new URL(r.url()).pathname)) actions.push((await r.json().catch(() => null))?.cashbook?.action ?? `HTTP ${r.status()}`);
      });
      // Исправление без стоимости (только комментарий).
      const fixBtn = page.getByRole('button', { name: /Исправить\s*:\s*Замена сукна, стол 1/ }).first();
      await fixBtn.click();
      const fd = page.getByRole('dialog');
      await fd.waitFor();
      await fd.locator('#me-reason').fill(`E2E уточнил комментарий ${tag}`);
      await fd.locator('#me-comment').fill(`E2E браузер ${tag} — Simonis`);
      const costShown = await fd.locator('#me-cost').inputValue();
      await screen(t, page, `${tag}-maint-fix-dialog`, pass.scheme);
      await fd.getByRole('button', { name: /Записать исправление/ }).click();
      await page.waitForTimeout(800);
      const afterFix = await bodyText(page);
      const fixMsg = afterFix.match(/Запись исправлена[^.]*\.[^.]*\.?/)?.[0] ?? '';
      // «Не было» для исправления без стоимости: сервер сторнирует расход цепочки (reversed).
      await page.getByRole('button', { name: /Исправить\s*:\s*Замена сукна, стол 1/ }).first().click();
      const vd = page.getByRole('dialog');
      await vd.waitFor();
      await vd.locator('#me-reason').fill(`E2E не меняли ${tag}`);
      await vd.getByText(/События не было/).first().click();
      await vd.getByRole('button', { name: /Отметить: события не было/ }).click();
      await page.waitForTimeout(800);
      const afterVoid = await bodyText(page);
      const voidMsg = afterVoid.match(/Отмечено: события не было[^.]*\.[^.]*\./)?.[0] ?? '';
      // Проверка по API: итог кассы цепочки 0 (сторно было).
      const owner = await login(S.maintOwnerPhone);
      const ev = (await api('GET', `/api/clubs/${S.maintClub}/maintenance?limit=200`, { token: owner.token, club: S.maintClub })).json.events;
      const root = ev.find((e) => e.comment === `E2E браузер ${tag}` && !e.corrects_id);
      const fix = ev.find((e) => e.corrects_id === root?.event_id);
      const vo = ev.find((e) => e.corrects_id === fix?.event_id);
      assert.ok(root && fix && vo, 'цепочка из трёх записей');
      assert.equal(root.cost_kopecks, 150_000);
      assert.equal(fix.cost_kopecks, 0, 'исправление без стоимости');
      assert.equal(vo.voided, true);
      const au = (await api('GET', `/api/clubs/${S.maintClub}/audit?action=cashbook.storno&limit=200`, { token: owner.token, club: S.maintClub })).json.items;
      assert.deepEqual(actions, ['kept', 'reversed'], 'исправление без стоимости — kept, «не было» — reversed');
      assert.ok(au.length >= 1);
      const fixShort = fixMsg.split('. ')[0];
      t.diagnostic(`цена в окне исправления: «${costShown}»; сервер: ${actions.join(' → ')}; сообщение после исправления: «${fixShort}.» (нет «Стоимость не изменена: расход в кассе по исходной записи»); после «не было»: «${voidMsg}» (сервер сторнировал расход 1 500 ₽, в сообщении о сторно ни слова)`);
      summary.push({ name: `${tag}-maint-messages`, fixMsg: fixShort, voidMsg, costShown, actions });
      // Пороги: окно открывается, Esc закрывает, фокус возвращается на кнопку.
      const thr = page.getByRole('button', { name: /Пороги/ });
      await thr.click();
      const td = page.getByRole('dialog', { name: /Пороги обслуживания/ });
      await td.waitFor();
      await screen(t, page, `${tag}-maint-thresholds`, pass.scheme);
      await page.keyboard.press('Escape');
      await td.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
      assert.equal(await page.getByRole('dialog', { name: /Пороги обслуживания/ }).count(), 0, 'Esc закрыл окно');
      const backFocus = await page.evaluate(() => globalThis.document.activeElement?.textContent?.trim() ?? '');
      t.diagnostic(`Esc — окно порогов закрыто, фокус на «${backFocus}»`);
      // Тексты по server/maintenance/README.md: kept — «Стоимость не изменена: расход в кассе по исходной записи»;
      // reversed — расход сторнирован. Проверяются в конце, чтобы остальное прошло (дефект Д1 отчёта).
      assert.match(fixMsg, /Стоимость не изменена/, `после исправления без стоимости (kept): «${fixShort}»`);
      assert.match(voidMsg, /сторн/, `после «не было» (reversed): «${voidMsg}»`);
    } finally {
      await ctx.close();
    }
  });

  test(`${tag}: ресепшн — «Обслуживание столов» и «API» не открываются`, { skip: !ready && 'нет состояния 02' }, async (t) => {
    const rec = S.maintReceptionPhone;
    const ctx = await newCtx(browser, { ...pass, phone: rec });
    try {
      const page = await open(ctx, `/club/c/${S.maintClub}/reports/maintenance`, `${tag}-rec-maint`);
      const txt = await bodyText(page);
      assert.doesNotMatch(txt, /Счётчик — часы игры стола с последней замены/);
      assert.doesNotMatch(txt, /Стол 1 · Пирамида \d/);
      const p2 = await open(ctx, `/club/c/${S.maintClub}/api`, `${tag}-rec-api`);
      const t2 = await bodyText(p2);
      assert.doesNotMatch(t2, /Выпустить ключ/);
      await screen(t, page, `${tag}-rec-maint`, pass.scheme);
      t.diagnostic(`ресепшн: обслуживание — «${txt.slice(txt.indexOf('Ещё') + 3, txt.indexOf('Ещё') + 120).trim()}…»; API — «Выпустить ключ» нет`);
    } finally {
      await ctx.close();
    }
  });

  test(`${tag}: «API и вебхуки» — ключ показывается один раз; отзыв; внутренний адрес вебхука — ошибка`, { skip: !ready && 'нет состояния 03' }, async (t) => {
    const ctx = await newCtx(browser, { ...pass, phone: S.apiOwnerA });
    try {
      const page = await open(ctx, `/club/c/${S.apiA}/api`, `${tag}-api`);
      assert.match(await bodyText(page), /Ключи API/);
      await screen(t, page, `${tag}-api`, pass.scheme);
      await page.getByRole('button', { name: /^Выпустить ключ$/ }).first().click();
      const dlg = page.getByRole('dialog');
      await dlg.waitFor();
      // Без имени и прав — ошибки полей.
      await dlg.getByRole('button', { name: /^Выпустить ключ$/ }).click();
      await page.waitForTimeout(200);
      assert.ok((await dlg.locator('.field__error').count()) >= 1, 'ошибки полей');
      await dlg.locator('#ck-name').fill(`E2E браузер ${tag}`);
      await dlg.locator('#ck-scope-0').check();
      await dlg.getByRole('button', { name: /^Выпустить ключ$/ }).click();
      const code = dlg.locator('code.token__value');
      await code.waitFor({ timeout: 10_000 });
      const key = (await code.innerText()).trim();
      assert.match(key, /^blk_[A-Za-z0-9_-]{43}$/);
      assert.match(await dlg.innerText(), /Ключ показывается один раз/);
      await screen(t, page, `${tag}-api-key-once`, pass.scheme);
      // Ключ работает.
      const ok = await api('GET', '/api/v1/club/tables', { headers: { authorization: `Bearer ${key}` } });
      assert.equal(ok.status, 200);
      await dlg.getByRole('button', { name: /Готово, ключ сохранён/ }).click();
      await page.waitForTimeout(500);
      const html = await page.content();
      assert.ok(!html.includes(key) && !html.includes(key.slice(12)), 'после «Готово» ключа нет в странице');
      assert.ok((await bodyText(page)).includes(key.slice(0, 12)), 'префикс в списке');
      await page.reload({ waitUntil: 'load' });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      assert.ok(!(await page.content()).includes(key.slice(12)), 'после перезагрузки ключа нет');
      // Отзыв из интерфейса.
      await page.getByRole('button', { name: new RegExp(`Отозвать ключ «E2E браузер ${tag}»`) }).click();
      const cd = page.getByRole('dialog');
      await cd.waitFor();
      assert.match(await cd.innerText(), /перестанет работать сразу/);
      await cd.getByRole('button', { name: /^Отозвать ключ$/ }).click();
      await page.waitForTimeout(800);
      assert.match(await bodyText(page), new RegExp(`Ключ «E2E браузер ${tag}» отозван`));
      assert.equal((await api('GET', '/api/v1/club/tables', { headers: { authorization: `Bearer ${key}` } })).status, 401);
      // Вебхук на внутренний адрес — ошибка понятным текстом, без кода.
      await page.getByRole('button', { name: /Добавить адрес/ }).first().click();
      const hd = page.getByRole('dialog');
      await hd.waitFor();
      await hd.locator('#cw-url').fill('https://169.254.169.254/latest/meta-data/');
      await hd.locator('#cw-ev-0').check();
      const posts = [];
      page.on('request', (r) => r.method() === 'POST' && r.url().includes('/webhooks') && posts.push(r.url()));
      await hd.getByRole('button', { name: /Добавить|Сохранить|Подключить/ }).last().click();
      await page.waitForTimeout(800);
      const ht = await hd.innerText();
      assert.doesNotMatch(ht, /url_forbidden/);
      assert.match(ht, /внутрен|локальн|недоступ|нельзя|запрещ/i, `текст ошибки: ${ht.slice(0, 300)}`);
      t.diagnostic(`вебхук: запросов POST к серверу ${posts.length} (0 — отказ проверкой в браузере)`);
      await screen(t, page, `${tag}-api-hook-error`, pass.scheme);
      t.diagnostic(`ключ ${key.slice(0, 12)}…(${key.length}) — «показывается один раз», работает; после «Готово» и перезагрузки на странице только префикс; отзыв из интерфейса → 401; вебхук на 169.254.169.254: «${(ht.match(/[^\n]*(внутрен|локальн|недоступ|нельзя|запрещ)[^\n]*/i) ?? [''])[0].trim()}»`);
    } finally {
      await ctx.close();
    }
  });
}

test('итог браузера: без прокрутки вбок, axe без serious/critical, фокус виден, ошибок страниц нет', { skip: !ready && 'пропущено' }, (t) => {
  const screens = summary.filter((s) => 'hscroll' in s);
  // Свечение корта на плане зала (.tbl__glow, M5.8 — незаконченная работа frontend по паделу в дереве) — отдельно,
  // не дефект M5.6: см. «Для сведения» отчёта.
  const court = (s) => s.culprits?.length && s.culprits.every((c) => c === 'tbl__glow');
  const padel = screens.filter((s) => s.hscroll && court(s)).map((s) => `${s.name} ${s.sw}>${s.iw}`);
  const hs = screens.filter((s) => s.hscroll && !court(s)).map((s) => `${s.name} ${s.sw}>${s.iw} (${s.culprits?.join(', ')})`);
  if (padel.length) t.diagnostic(`прокрутка от свечения корта на плане зала (M5.8, не M5.6): ${padel.join('; ')}`);
  const ser = screens.filter((s) => s.serious.length).map((s) => `${s.name}: ${s.serious.map((v) => `${v.id} [${v.target}] ${v.html}`).join('; ')}`);
  const nf = screens.filter((s) => s.noFocus.length).map((s) => `${s.name}: ${s.noFocus.map((f) => `${f.tag} «${f.label}»`).join(', ')}`);
  t.diagnostic(`экранов ${screens.length}; прокрутка: ${hs.length ? hs.join('; ') : 'нет'}; axe serious: ${ser.length ? ser.join(' | ') : 'нет'}; фокус не виден: ${nf.length ? nf.join(' | ') : 'нет'}; ошибки: ${errors.length ? errors.join(' | ') : 'нет'}`);
  assert.deepEqual(hs, []);
  assert.deepEqual(ser, []);
  assert.deepEqual(nf, []);
  assert.deepEqual(errors, []);
});

