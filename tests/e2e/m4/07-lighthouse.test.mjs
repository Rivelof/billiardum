// Lighthouse мобильный (по умолчанию: эмуляция телефона, медленная сеть и CPU) на живом стенде
// через Caddy: главная, город, клуб на программе, турнир. Категории performance, accessibility,
// best-practices, seo — медиана из E2E_LH_RUNS прогонов (по умолчанию 3), порог 0,9.
//
// Lighthouse — пакет из кэша npx (E2E_LH_CLI, по умолчанию ищется в ~/.npm/_npx), Chromium —
// /opt/pw-browsers (CHROME_PATH). Отчёты — $TMPDIR/bl-e2e-m4-lh/. Сертификат Caddy локальный:
// Chrome запускается с --ignore-certificate-errors (только на стенде).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { adminClient, BASE, CLUB_A } from './helpers.mjs';

const RUNS = Number(process.env.E2E_LH_RUNS || 3);
const OUT = path.join(os.tmpdir(), 'bl-e2e-m4-lh');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CATS = ['performance', 'accessibility', 'best-practices', 'seo'];

function findCli() {
  if (process.env.E2E_LH_CLI) return process.env.E2E_LH_CLI;
  const root = path.join(os.homedir(), '.npm', '_npx');
  for (const d of existsSync(root) ? readdirSync(root) : []) {
    const p = path.join(root, d, 'node_modules', 'lighthouse', 'cli', 'index.js');
    if (existsSync(p)) return p;
  }
  return null;
}

const CLI = findCli();
const pages = [
  { name: 'главная', path: '/' },
  { name: 'город', path: '/ekaterinburg/' },
  { name: 'клуб', path: '/ekaterinburg/testovyy-klub/' },
];

before(async () => {
  mkdirSync(OUT, { recursive: true });
  const db = await adminClient();
  const { rows } = await db.query("select id from bl.tournaments where club_id = $1 and status <> 'draft' order by (status = 'finished') desc, created_at desc limit 1", [CLUB_A]);
  await db.end();
  if (rows[0]) pages.push({ name: 'турнир', path: `/turniry/${rows[0].id}/` });
});

const median = (v) => {
  const s = v.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

test('Lighthouse мобильный ≥ 90: главная, город, клуб, турнир', { skip: !CLI && 'нет lighthouse в кэше npx (E2E_LH_CLI)', timeout: 30 * 60_000 }, async (t) => {
  const rows = [];
  for (const p of pages) {
    const runs = [];
    let last;
    for (let i = 0; i < RUNS; i += 1) {
      const file = path.join(OUT, `${p.name}-${i}.json`);
      const r = spawnSync(
        process.execPath,
        [CLI, `${BASE}${p.path}`, '--output=json', `--output-path=${file}`, '--quiet', `--only-categories=${CATS.join(',')}`, '--chrome-flags=--headless=new --no-sandbox --ignore-certificate-errors --disable-dev-shm-usage'],
        { env: { ...process.env, CHROME_PATH: CHROME }, encoding: 'utf8', timeout: 180_000 },
      );
      assert.equal(r.status, 0, `lighthouse ${p.path}: ${(r.stderr || '').slice(-400)}`);
      last = JSON.parse(readFileSync(file, 'utf8'));
      assert.ok(!last.runtimeError, `${p.path}: ${last.runtimeError?.code}`);
      runs.push(Object.fromEntries(CATS.map((c) => [c, last.categories[c]?.score ?? null])));
    }
    const scores = Object.fromEntries(CATS.map((c) => [c, median(runs.map((x) => x[c]))]));
    const failed = CATS.filter((c) => scores[c] === null || scores[c] < 0.9);
    const audits = failed.flatMap((c) =>
      last.categories[c].auditRefs
        .filter((a) => a.weight > 0)
        .map((a) => last.audits[a.id])
        .filter((a) => a && typeof a.score === 'number' && a.score < 0.9)
        .map((a) => `${c}:${a.id}${a.displayValue ? ` (${a.displayValue})` : ''}`),
    );
    const m = last.audits;
    rows.push({ ...p, scores, failed, audits, lcp: m['largest-contentful-paint']?.displayValue, cls: m['cumulative-layout-shift']?.displayValue, tbt: m['total-blocking-time']?.displayValue });
    t.diagnostic(`${p.name} ${p.path}: ${CATS.map((c) => `${c} ${Math.round(scores[c] * 100)}`).join(', ')}; LCP ${m['largest-contentful-paint']?.displayValue}, CLS ${m['cumulative-layout-shift']?.displayValue}, TBT ${m['total-blocking-time']?.displayValue}${audits.length ? `; ниже 0,9: ${audits.join(', ')}` : ''}`);
  }
  const bad = rows.filter((r) => r.failed.length);
  assert.deepEqual(bad.map((r) => `${r.path}: ${r.failed.join(',')}`), []);
});
