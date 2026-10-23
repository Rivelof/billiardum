// Экраны клуба (управляющий) для турнира после старта, 1280 и 360 px: «Продлить турнир» (с
// причиной), «Вернуть взнос» игроку (здоровье, комментарий), «Отменить турнир» после старта —
// без возврата (по умолчанию) и с возвратом всем при поломке оборудования. Каждое действие
// проверяется по API и журналу; экраны — без горизонтальной прокрутки, axe без serious/critical.
// Турниры: T1 — стол E2E_CLUBUI_TABLE_A (8, пул), 1280 px; T2 — стол E2E_CLUBUI_TABLE_B (1, пирамида), 360 px.

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
  brief2,
  CLUB_A,
  ensureFree,
  enterAndPay,
  MIN,
  newGuest,
  ok,
  plusProfile,
  receiptsOf,
  refundsOf,
  RES,
  staff,
  waitFor,
} from './helpers.mjs';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/opt/pw-browsers';
const SHOTS = process.env.E2E_SHOTS_DIR || path.join(os.tmpdir(), 'bl-e2e-m4-shots');
const TABLE_A = Number(process.env.E2E_CLUBUI_TABLE_A || 8);
const TABLE_B = Number(process.env.E2E_CLUBUI_TABLE_B || 1);
const TZ = 'Asia/Yekaterinburg';
let chromium = null;
let skip = false;
try {
  const mod = await import(pathToFileURL(createRequire(path.join(process.env.E2E_PW_DIR || '/opt/node-tools', 'x.js')).resolve('playwright-core')).href);
  chromium = mod.chromium ?? mod.default?.chromium;
} catch {
  skip = 'нет playwright-core';
}
function axeSource() {
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
let man;
let cookies;
const made = [];
const errors = [];
const known = [];

before(async () => {
  if (skip) return;
  mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch();
  db = await adminClient();
  man = await staff('manager');
  await ensureFree(TABLE_A);
  await ensureFree(TABLE_B);
});

after(async () => {
  for (const c of made) if (!c.closed) await api('POST', `/api/clubs/${CLUB_A}/tournaments/${c.id}/cancel`, { token: man.token, body: { reason: 'e2e: уборка' } });
  await browser?.close();
  await db?.end();
});

async function started(title, discipline, table) {
  const startsAt = new Date(Math.ceil((Date.now() + 65_000) / 1000) * 1000);
  const r = await api('POST', `/api/clubs/${CLUB_A}/tournaments`, {
    token: man.token,
    body: { title, discipline, format: 'single_elim', race_to: 2, fee_kopecks: 10_000, places: 8, match_minutes: 20, starts_at: startsAt.toISOString(), ends_at: new Date(startsAt.getTime() + 60 * MIN).toISOString(), resource_ids: [RES(table)], publish: true },
  });
  assert.equal(r.status, 201, brief2(r));
  const c = { id: r.json.id, P: [] };
  made.push(c);
  for (let i = 0; i < 4; i += 1) {
    const g = await newGuest();
    await plusProfile(g);
    const e = await enterAndPay(g, c.id);
    const { rows } = await db.query('select id from bl.payments where entry_id = $1', [e.entry.entry_id]);
    c.P.push({ ...g, entryId: e.entry.entry_id, paymentId: rows[0].id });
  }
  await ok(api('POST', `/api/clubs/${CLUB_A}/tournaments/${c.id}/start`, { token: man.token, body: {} }));
  return c;
}

async function page(width) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: width < 500 ? 780 : 800 }, locale: 'ru-RU', timezoneId: TZ, bypassCSP: true });
  if (cookies) await ctx.addCookies(cookies);
  else {
    const r = await ctx.request.post(`${BASE}/api/auth/dev`, { data: { phone: '+70000000003' } });
    assert.ok(r.ok());
    cookies = await ctx.cookies();
  }
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  return { ctx, p };
}

async function check(t, p, name) {
  await p.waitForTimeout(800);
  const w = await p.evaluate(() => ({ sw: globalThis.document.documentElement.scrollWidth, iw: globalThis.innerWidth }));
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
  let serious = [];
  if (AXE) {
    await p.addScriptTag({ content: AXE });
    const v = await p.evaluate(async () => (await globalThis.axe.run(globalThis.document, { resultTypes: ['violations'] })).violations.map((x) => ({ id: x.id, impact: x.impact, n: x.nodes.length, target: x.nodes[0]?.target?.join(' '), html: x.nodes[0]?.html?.slice(0, 160) })));
    serious = v.filter((x) => ['serious', 'critical'].includes(x.impact));
    known.push(...serious.filter((x) => x.id === 'label-content-name-mismatch').map((x) => `${name}: ${x.target}`));
    serious = serious.filter((x) => x.id !== 'label-content-name-mismatch'); // известное замечание — в отчёте
  }
  t.diagnostic(`${name}: ${w.sw <= w.iw + 1 ? 'без прокрутки' : `ПРОКРУТКА ${w.sw}>${w.iw}`}; axe serious/critical ${serious.length ? serious.map((x) => `${x.id}×${x.n} (${x.target}: ${x.html})`).join(',') : 0}`);
  return { hscroll: w.sw > w.iw + 1, serious };
}

function localInput(d) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

async function flow(t, c, width, { refundAll }) {
  const res = [];
  const { ctx, p } = await page(width);
  const url = `${BASE}/club/c/${CLUB_A}/tournaments/${c.id}`;
  await p.goto(url, { waitUntil: 'load' });
  await p.getByRole('button', { name: 'Продлить турнир' }).first().waitFor({ timeout: 15_000 });
  res.push(await check(t, p, `club-tour-${width}`));
  // Продлить турнир.
  const d0 = await ok(api('GET', `/api/clubs/${CLUB_A}/tournaments/${c.id}`, { token: man.token }));
  // Поле datetime-local — с точностью до минуты.
  const newEnds = new Date(Math.floor((new Date(d0.ends_at).getTime() + 30 * MIN) / MIN) * MIN);
  await p.getByRole('button', { name: 'Продлить турнир' }).first().click();
  await p.locator('#tx-end').fill(localInput(newEnds));
  await p.locator('#tx-reason').fill('Матчи затянулись (e2e интерфейс)');
  res.push(await check(t, p, `club-tour-extend-${width}`));
  await p.getByRole('dialog').getByRole('button', { name: 'Продлить турнир' }).click();
  await p.waitForTimeout(1500);
  await p.screenshot({ path: path.join(SHOTS, `club-tour-extend-after-${width}.png`) });
  const dlgText = await p.getByRole('dialog').innerText().catch(() => '');
  t.diagnostic(`после «Продлить»: диалог ${dlgText ? `открыт: «${dlgText.replace(/\s+/g, ' ').slice(0, 300)}»` : 'закрыт'}; в поле ${await p.locator('#tx-end').inputValue().catch(() => '—')} (ожидали ${localInput(newEnds)})`);
  const d1 = await waitFor(
    async () => {
      const x = await ok(api('GET', `/api/clubs/${CLUB_A}/tournaments/${c.id}`, { token: man.token }));
      return new Date(x.ends_at).getTime() === newEnds.getTime() ? x : null;
    },
    { timeoutMs: 10_000, intervalMs: 300, what: 'турнир продлён из интерфейса' },
  );
  const { rows: au } = await db.query("select reason from bl.audit_log where action = 'manual.tournament_extend' and object_id = $1", [c.id]);
  // Вернуть взнос первому игроку.
  const g = c.P[0];
  await p.getByRole('button', { name: new RegExp(`Вернуть взнос.*${g.nick}`) }).click();
  await p.getByRole('radio', { name: 'Здоровье игрока' }).check({ force: true });
  await p.locator('#tr-comment').fill('Травма руки, справка (e2e интерфейс)');
  res.push(await check(t, p, `club-tour-refund-${width}`));
  await p.getByRole('dialog').getByRole('button', { name: /^Вернуть/ }).click();
  const refunds = await waitFor(
    async () => {
      const x = await refundsOf(db, g.paymentId);
      return x.length && x.every((y) => y.status === 'succeeded') ? x : null;
    },
    { timeoutMs: 40_000, intervalMs: 500, what: 'возврат взноса из интерфейса' },
  );
  const rc = await waitFor(async () => (await receiptsOf(db, g.paymentId)).find((x) => x.kind === 'refund' && x.status === 'succeeded') ?? null, { timeoutMs: 40_000, what: 'чек возврата' });
  // Отменить турнир после старта.
  await p.getByRole('button', { name: 'Отменить турнир' }).click();
  if (refundAll) {
    await p.getByRole('switch').check();
    await p.getByRole('radio', { name: 'Поломка оборудования' }).check({ force: true });
    await p.locator('#tc-reason').fill('Порвалось сукно, стол не годится (e2e интерфейс)');
  } else {
    await p.locator('#tc-reason').fill('Доигрывать некому (e2e интерфейс)');
  }
  res.push(await check(t, p, `club-tour-cancel-${width}`));
  const btnText = await p.getByRole('button', { name: refundAll ? 'Отменить и вернуть взносы' : 'Отменить без возврата' }).innerText();
  await p.getByRole('button', { name: refundAll ? 'Отменить и вернуть взносы' : 'Отменить без возврата' }).click();
  const d2 = await waitFor(
    async () => {
      const x = await ok(api('GET', `/api/clubs/${CLUB_A}/tournaments/${c.id}`, { token: man.token }));
      return x.status === 'canceled' ? x : null;
    },
    { timeoutMs: 10_000, intervalMs: 300, what: 'турнир отменён из интерфейса' },
  );
  c.closed = true;
  await p.waitForTimeout(1000);
  const txt = (await p.evaluate(() => globalThis.document.body.innerText)).replace(/\s+/g, ' ');
  res.push(await check(t, p, `club-tour-canceled-${width}`));
  let others = [];
  if (refundAll) {
    for (const x of c.P.slice(1)) {
      const r = await waitFor(
        async () => {
          const y = await refundsOf(db, x.paymentId);
          return y.length && y.every((z) => z.status === 'succeeded') ? y : null;
        },
        { timeoutMs: 40_000, intervalMs: 500, what: 'возврат при отмене' },
      );
      others.push(r[0].amount_kopecks);
    }
  } else {
    others = (await Promise.all(c.P.slice(1).map((x) => refundsOf(db, x.paymentId)))).flat().map((x) => x.amount_kopecks);
  }
  const { rows: al } = await db.query("select data->>'action' as action, data->>'refund' as refund, count from bl.alarms where club_id = $1 and data->>'tournament_id' = $2 and type = 'manual_action' order by raised_at", [CLUB_A, c.id]);
  await ctx.close();
  t.diagnostic(`${width} px: продлён до ${d1.ends_at} (журнал ${au.length}); взнос ${g.nick}: возврат ${refunds.map((x) => `${x.amount_kopecks} ${x.status}`).join(', ')}, чек ${rc.kind}/${rc.status}; кнопка «${btnText}» → ${d2.status}; возвраты остальным: ${others.join(', ') || 'нет'}; тревоги manual_action: ${al.map((x) => `${x.action}${x.refund ? `/${x.refund}` : ''}×${x.count}`).join(', ')}; на экране: «${txt.slice(0, 160)}»`);
  return { res, others, al };
}

test('1280 px: продлить, вернуть взнос игроку, отменить с возвратом всем (поломка оборудования)', { skip, timeout: 10 * MIN }, async (t) => {
  const c = await started('E2E Клуб UI 1280', 'pool', TABLE_A);
  const { res, others, al } = await flow(t, c, 1280, { refundAll: true });
  assert.equal(others.length, 3, 'возвраты остальным трём');
  assert.equal(al.filter((x) => /tournament_cancel/.test(x.action)).length, 1, 'одна тревога за отмену');
  assert.deepEqual(res.filter((x) => x.hscroll || x.serious.length), []);
});

test('360 px: продлить, вернуть взнос игроку, отменить без возврата', { skip, timeout: 10 * MIN }, async (t) => {
  const c = await started('E2E Клуб UI 360', 'pyramid', TABLE_B);
  const { res, others } = await flow(t, c, 360, { refundAll: false });
  assert.deepEqual(others, [], 'без возврата остальным');
  assert.deepEqual(res.filter((x) => x.hscroll || x.serious.length), [], 'прокрутка или axe на 360 px');
  assert.deepEqual(errors, []);
  assert.deepEqual(known, [], 'Д8: label-content-name-mismatch на кнопках сетки');
});
