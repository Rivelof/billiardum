// Lighthouse сайта web/site на мобильном профиле (контракт M4: приёмка «Lighthouse мобильный
// ≥ 90 на главной, странице города и клуба»). Этап `npm run ci -- --site`, в GitHub — задача site.
//
// 1. Сайт поднимается на хосте в режиме заглушки (BL_API_URL=mock: данные web/site/mock, без
//    сервера и базы) на свободном порту 127.0.0.1. Острова должны быть собраны заранее
//    (npm run build -w web/site — это делает этап --site).
// 2. Страницы: главная, город с наибольшим числом клубов и клуб на программе в нём (по
//    заглушке публичного API сайта) — или свои: --url /путь/ (можно несколько раз).
// 3. Lighthouse (закреплённая версия LIGHTHOUSE_VERSION, через npm exec) — мобильный профиль
//    по умолчанию: эмуляция телефона, имитация медленной сети и CPU. Каждая страница
//    --runs раз (по умолчанию 3), берётся медиана по каждой категории.
// 4. Порог — PERFORMANCE, ACCESSIBILITY, SEO ≥ 90. Ниже — код выхода 1 и список
//    непройденных проверок категории. Отчёты JSON и сводка — в .lighthouse/ (вне git).
//
// Chrome: CHROME_PATH, иначе установленный Chrome или Chromium, иначе Chrome for Testing
// CHROME_BUILD скачивается через @puppeteer/browsers в ~/.cache/billiardum/chrome. В раннере
// GitHub ubuntu-24.04 Chrome уже есть.
//
//   node scripts/ci-lighthouse.mjs [--runs 3] [--url /ekaterinburg/]…

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { capture, fail, isMain, makeLogger, npm, ROOT, runMain } from './dev-lib.mjs';

const log = makeLogger('lighthouse');

/** Закреплённые версии (выпущены не позже чем за две недели до закрепления). */
export const LIGHTHOUSE_VERSION = '13.5.0';
export const BROWSERS_VERSION = '3.2.4';
export const CHROME_BUILD = '155.0.8059.39';

export const CATEGORIES = ['performance', 'accessibility', 'seo'];
export const THRESHOLD = 0.9;
export const REPORT_DIR = join(ROOT, '.lighthouse');
const SITE_DIR = join(ROOT, 'web', 'site');
const START_TIMEOUT_MS = 30_000;

export function parseArgs(args) {
  const opts = { runs: 3, urls: [] };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--runs') {
      const n = Number(args[(i += 1)]);
      if (!Number.isInteger(n) || n < 1 || n > 9) fail('--runs — число от 1 до 9.');
      opts.runs = n;
    } else if (a === '--url') {
      const u = args[(i += 1)] ?? '';
      if (!u.startsWith('/')) fail('--url — путь страницы от корня сайта, например /ekaterinburg/.');
      opts.urls.push(u);
    } else fail(`неизвестный параметр ${a}. Есть --runs N и --url /путь/.`);
  }
  return opts;
}

export function median(values) {
  const v = values.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Страницы проверки по заглушке публичного API: главная, город с наибольшим числом клубов,
 * клуб на программе (status platform) в нём, иначе любой клуб города.
 */
export function pickPages(cities, cityDetail) {
  const city = [...(cities?.items ?? [])].sort((a, b) => (b.clubs ?? 0) - (a.clubs ?? 0))[0];
  if (!city) throw new Error('в заглушке нет городов');
  const clubs = cityDetail?.items ?? [];
  const club = clubs.find((c) => c.status === 'platform') ?? clubs[0];
  if (!club) throw new Error(`в городе ${city.slug} нет клубов`);
  return [
    { name: 'главная', path: '/' },
    { name: 'город', path: `/${city.slug}/` },
    { name: 'клуб', path: club.path ?? `/${city.slug}/${club.slug}/` },
  ];
}

/** Медианы категорий по прогонам и непройденные пороги. runs — [{ performance: 0.97, … }]. */
export function evaluate(runs, { categories = CATEGORIES, threshold = THRESHOLD } = {}) {
  const scores = Object.fromEntries(categories.map((c) => [c, median(runs.map((r) => r[c]))]));
  const failed = categories.filter((c) => scores[c] === null || scores[c] < threshold);
  return { scores, failed };
}

/** Непройденные проверки категории из отчёта Lighthouse (для сообщения об ошибке). */
export function failedAudits(lhr, category) {
  const refs = lhr?.categories?.[category]?.auditRefs ?? [];
  return refs
    .filter((r) => r.weight > 0)
    .map((r) => lhr.audits?.[r.id])
    .filter((a) => a && typeof a.score === 'number' && a.score < 0.9)
    .map((a) => `${a.id}: ${a.title}${a.displayValue ? ` (${a.displayValue})` : ''}`);
}

/** Путь к Chrome из вывода `@puppeteer/browsers install`: «chrome@155… /путь/к/chrome». */
export function parseBrowsersOutput(text) {
  const line = text.trim().split('\n').reverse().find((l) => /^chrome@\S+ /.test(l.trim()));
  return line ? line.trim().replace(/^chrome@\S+\s+/, '') : null;
}

function which(name) {
  const r = capture(process.platform === 'win32' ? 'where' : 'which', [name]);
  return r.code === 0 ? r.stdout.split(/\r?\n/)[0].trim() || null : null;
}

function findChrome() {
  if (process.env.CHROME_PATH) {
    if (!existsSync(process.env.CHROME_PATH)) fail(`CHROME_PATH=${process.env.CHROME_PATH}: файла нет.`);
    return process.env.CHROME_PATH;
  }
  for (const name of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
    const p = which(name);
    if (p) return p;
  }
  const fixed = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return fixed.find((p) => existsSync(p)) ?? null;
}

/** npm exec закреплённого пакета; вывод перехватывается. */
function npmExec(pkg, bin, args, { env } = {}) {
  const c = npm(['exec', '--yes', `--package=${pkg}`, '--', bin, ...args]);
  return new Promise((resolve, reject) => {
    const child = spawn(c.cmd, c.args, { cwd: ROOT, env: env ?? process.env, shell: c.shell, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code: code ?? 1, stdout: out, stderr: err }));
  });
}

async function ensureChrome() {
  const found = findChrome();
  if (found) return found;
  const dir = join(homedir(), '.cache', 'billiardum', 'chrome');
  log(`Chrome в системе не найден — Chrome for Testing ${CHROME_BUILD} из ${dir} (скачивается @puppeteer/browsers ${BROWSERS_VERSION}, если его там ещё нет)`);
  const r = await npmExec(`@puppeteer/browsers@${BROWSERS_VERSION}`, 'browsers', ['install', `chrome@${CHROME_BUILD}`, '--path', dir]);
  const path = r.code === 0 ? parseBrowsersOutput(r.stdout) : null;
  if (!path || !existsSync(path)) {
    fail(`не удалось получить Chrome (${(r.stderr || r.stdout).trim().split('\n').at(-1) ?? ''}). Укажите CHROME_PATH.`);
  }
  return path;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Сайт на заглушке API; возвращает { origin, stop }. */
async function startSite() {
  if (!existsSync(join(SITE_DIR, 'dist', 'manifest.json'))) fail('нет сборки островов web/site/dist: npm run build -w web/site');
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), BL_API_URL: 'mock', SITE_ORIGIN: origin, BL_SITE_NOINDEX: '', BL_SITE_DEV: '', YANDEX_METRIKA_ID: '' };
  delete env.NODE_ENV;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: SITE_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const stop = () => {
    if (child.exitCode === null) child.kill();
  };
  process.on('exit', stop);
  const started = Date.now();
  for (;;) {
    if (child.exitCode !== null) fail(`сайт завершился при старте (код ${child.exitCode}):\n${output.trim()}`);
    try {
      const r = await fetch(`${origin}/health`);
      if (r.ok) break;
    } catch {
      // ещё не слушает
    }
    if (Date.now() - started > START_TIMEOUT_MS) {
      stop();
      fail(`сайт не ответил на /health за ${START_TIMEOUT_MS / 1000} с:\n${output.trim()}`);
    }
    await sleep(250);
  }
  log(`сайт на заглушке API: ${origin}`);
  return { origin, stop };
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) fail(`${url}: HTTP ${r.status}`);
  return r.json();
}

async function discoverPages(origin) {
  const cities = await getJson(`${origin}/api/public/cities`);
  const top = [...(cities.items ?? [])].sort((a, b) => (b.clubs ?? 0) - (a.clubs ?? 0))[0];
  const detail = top ? await getJson(`${origin}/api/public/cities/${top.slug}`) : null;
  try {
    return pickPages(cities, detail);
  } catch (err) {
    fail(`страницы для проверки не найти: ${err.message}`);
  }
}

async function lighthouse(url, chrome, outFile) {
  const args = [
    url,
    '--output=json',
    `--output-path=${outFile}`,
    `--only-categories=${CATEGORIES.join(',')}`,
    '--chrome-flags=--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage',
    '--quiet',
  ];
  const r = await npmExec(`lighthouse@${LIGHTHOUSE_VERSION}`, 'lighthouse', args, { env: { ...process.env, CHROME_PATH: chrome } });
  if (r.code !== 0 || !existsSync(outFile)) {
    fail(`lighthouse ${url}: код ${r.code}\n${(r.stderr || r.stdout).trim().split('\n').slice(-15).join('\n')}`);
  }
  const lhr = JSON.parse(readFileSync(outFile, 'utf8'));
  if (lhr.runtimeError) fail(`lighthouse ${url}: ${lhr.runtimeError.code} ${lhr.runtimeError.message}`);
  return lhr;
}

const pct = (x) => (x === null ? '—' : String(Math.round(x * 100)));

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(join(SITE_DIR, 'server.mjs'))) fail('нет web/site/server.mjs (зона frontend-site)');
  const chrome = await ensureChrome();
  const runsWord = opts.runs === 1 ? 'прогон' : opts.runs < 5 ? 'прогона' : 'прогонов'; // --runs 1–9
  log(`Chrome: ${chrome}; Lighthouse ${LIGHTHOUSE_VERSION}, мобильный профиль, ${opts.runs} ${runsWord} на страницу, порог ${pct(THRESHOLD)}`);
  const site = await startSite();
  try {
    const pages = opts.urls.length > 0 ? opts.urls.map((p) => ({ name: p, path: p })) : await discoverPages(site.origin);
    rmSync(REPORT_DIR, { recursive: true, force: true });
    mkdirSync(REPORT_DIR, { recursive: true });
    const rows = [];
    const problems = [];
    for (const [i, page] of pages.entries()) {
      const runs = [];
      let last = null;
      for (let n = 1; n <= opts.runs; n += 1) {
        const file = join(REPORT_DIR, `${i + 1}-${n}.json`);
        last = await lighthouse(`${site.origin}${page.path}`, chrome, file);
        runs.push(Object.fromEntries(CATEGORIES.map((c) => [c, lhr(last, c)])));
      }
      const { scores, failed } = evaluate(runs);
      rows.push({ ...page, scores, failed, lcp: last.audits?.['largest-contentful-paint']?.displayValue, cls: last.audits?.['cumulative-layout-shift']?.displayValue });
      log(`${page.name} ${page.path}: ${CATEGORIES.map((c) => `${c} ${pct(scores[c])}`).join(', ')}`);
      for (const c of failed) problems.push(`${page.name} ${page.path}: ${c} ${pct(scores[c])} < ${pct(THRESHOLD)}\n    ${failedAudits(last, c).join('\n    ') || '(нет отдельных проверок ниже 90)'}`);
    }
    const table = [
      '| Страница | Путь | Performance | Accessibility | SEO | LCP | CLS |',
      '|---|---|---|---|---|---|---|',
      ...rows.map((r) => `| ${r.name} | \`${r.path}\` | ${CATEGORIES.map((c) => `${pct(r.scores[c])}${r.failed.includes(c) ? ' ✗' : ''}`).join(' | ')} | ${r.lcp ?? '—'} | ${r.cls ?? '—'} |`),
    ].join('\n');
    writeFileSync(join(REPORT_DIR, 'summary.json'), `${JSON.stringify({ lighthouse: LIGHTHOUSE_VERSION, runs: opts.runs, threshold: THRESHOLD, pages: rows }, null, 2)}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Lighthouse, мобильный профиль (медиана из ${opts.runs})\n\n${table}\n`);
    }
    console.log(`\n${table}\n`);
    if (problems.length > 0) fail(`ниже порога:\n  - ${problems.join('\n  - ')}\nОтчёты Lighthouse (JSON): .lighthouse/`);
    log('все страницы не ниже порога');
  } finally {
    site.stop();
  }
  return 0;
}

function lhr(report, category) {
  const s = report?.categories?.[category]?.score;
  return typeof s === 'number' ? s : null;
}

if (isMain(import.meta.url)) runMain('lighthouse', main);
