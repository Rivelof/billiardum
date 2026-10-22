// Честность CI: каждый *.test.mjs в репозитории запускает какой-то скрипт CI.
//
// Покрытием считаются шаблоны `node --test …` из скриптов test, test:db и test:it корня
// и всех пакетов workspaces (без шаблонов — все *.test.mjs пакета, как у Node) и каталоги,
// которые scripts/ci-test-db.mjs запускает сам (light и тесты модулей на базе).
// Не считаются: tests/e2e и tests/security — сценарии tester и pentester на живом стеке.
//
// Новый модуль положил тесты в каталог, который не попадает ни в один шаблон (например
// server/kkt/test/, пока его нет в скрипте test сервера), — `npm run ci -- --base` падает
// со списком файлов, а не молча их пропускает.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LIGHT_TESTS, moduleDbTestDirs } from './ci-test-db.mjs';
import { ROOT } from './dev-lib.mjs';

/** Каталоги, тесты которых запускают tester и pentester, а не CI. */
export const LIVE_TEST_DIRS = ['tests/e2e/', 'tests/security/'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.pio', 'coverage']);
const SCRIPTS = ['test', 'test:db', 'test:it'];

// Глоб в регулярное выражение: две звёздочки и слеш — любые каталоги (и ни одного),
// одна звёздочка — часть одного имени.
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      re += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Шаблоны файлов из команд `node --test …` скрипта npm; без шаблонов — все *.test.mjs. */
export function testPatterns(script) {
  const out = [];
  for (const part of script.split(/&&|\|\||;/)) {
    const tokens = part.trim().split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ''));
    const at = tokens.findIndex((t, k) => t === '--test' && /(^|[/\\])node(\.exe)?$/.test(tokens[k - 1] ?? ''));
    if (at < 0) continue;
    const files = tokens.slice(at + 1).filter((t) => t && !t.startsWith('-'));
    out.push(...(files.length > 0 ? files : ['**/*.test.mjs']));
  }
  return out;
}

function listTestFiles(root, dir = '') {
  const found = [];
  for (const d of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${d.name}` : d.name;
    if (d.isDirectory()) {
      if (!SKIP_DIRS.has(d.name) && !LIVE_TEST_DIRS.some((p) => `${rel}/`.startsWith(p))) found.push(...listTestFiles(root, rel));
    } else if (d.name.endsWith('.test.mjs')) found.push(rel);
  }
  return found;
}

/** Шаблоны покрытия с путями от корня: [{base, re}], base — каталог пакета ('' — корень). */
function coverage(root) {
  const pkg = (dir) => JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  const rootPkg = pkg('');
  const sources = [{ base: '', scripts: rootPkg.scripts ?? {} }];
  for (const dir of rootPkg.workspaces ?? []) {
    if (existsSync(join(root, dir, 'package.json'))) sources.push({ base: dir, scripts: pkg(dir).scripts ?? {} });
  }
  const rules = [];
  for (const { base, scripts } of sources) {
    for (const name of SCRIPTS) {
      for (const p of testPatterns(scripts[name] ?? '')) rules.push({ base, re: globToRegExp(p) });
    }
  }
  for (const p of [LIGHT_TESTS, ...moduleDbTestDirs(root).map((d) => `${d}/*.test.mjs`)]) rules.push({ base: '', re: globToRegExp(p) });
  return rules;
}

/** Файлы *.test.mjs, которые не запускает ни один скрипт CI (пути от корня, по алфавиту). */
export function uncoveredTests(root = ROOT) {
  const rules = coverage(root);
  return listTestFiles(root)
    .filter((file) =>
      !rules.some(({ base, re }) => {
        if (base && !file.startsWith(`${base}/`)) return false;
        const rel = base ? file.slice(base.length + 1) : file;
        return re.test(rel);
      }),
    )
    .sort();
}
