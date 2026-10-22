// Перезапуск сервисов Node в npm run dev по отпечатку кода (дефект Д2 приёмки M3).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import {
  codeFingerprint,
  NODE_SERVICES,
  nextState,
  parseInspect,
  planServices,
  readState,
  SERVICE_CODE,
  staleReason,
  writeState,
} from './dev-code.mjs';
import { ROOT } from './dev-lib.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'bl-code-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function tree(name, files) {
  const root = join(tmp, name);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

const PATHS = ['svc', 'conf/keys.json', 'package-lock.json'];
const FILES = {
  'svc/index.mjs': 'export const a = 1;\n',
  'svc/lib/x.mjs': 'export const x = 2;\n',
  'svc/test/x.test.mjs': 'test\n',
  'svc/README.md': '# svc\n',
  'svc/node_modules/dep/index.js': 'dep\n',
  'conf/keys.json': '{"k":1}\n',
  'package-lock.json': '{}\n',
};

test('отпечаток без git: код, ключи и зависимости — да; тесты, *.md, node_modules — нет', () => {
  const root = tree('plain', FILES);
  const base = codeFingerprint(PATHS, root);
  assert.equal(base.files, 4);
  assert.match(base.hash, /^[0-9a-f]{64}$/);
  assert.equal(codeFingerprint(PATHS, root).hash, base.hash, 'стабилен');

  for (const f of ['svc/test/x.test.mjs', 'svc/README.md', 'svc/node_modules/dep/index.js']) {
    writeFileSync(join(root, f), 'changed\n');
    assert.equal(codeFingerprint(PATHS, root).hash, base.hash, f);
  }
  for (const f of ['svc/lib/x.mjs', 'conf/keys.json', 'package-lock.json']) {
    const old = readFileSync(join(root, f));
    writeFileSync(join(root, f), 'changed\n');
    assert.notEqual(codeFingerprint(PATHS, root).hash, base.hash, f);
    writeFileSync(join(root, f), old);
    assert.equal(codeFingerprint(PATHS, root).hash, base.hash, `${f}: вернули — тот же отпечаток`);
  }
  writeFileSync(join(root, 'svc/new.mjs'), 'x\n');
  assert.notEqual(codeFingerprint(PATHS, root).hash, base.hash, 'новый файл');
  unlinkSync(join(root, 'svc/new.mjs'));
  unlinkSync(join(root, 'svc/lib/x.mjs'));
  assert.notEqual(codeFingerprint(PATHS, root).hash, base.hash, 'удалённый файл');
  assert.equal(codeFingerprint(['nothing-here'], root).files, 0, 'нет пути — пусто, без ошибки');
});

test('отпечаток: newest — самое позднее mtime файлов и папок', () => {
  const root = tree('mtime', FILES);
  const old = new Date('2026-01-01T00:00:00Z');
  for (const p of ['svc/index.mjs', 'svc/lib/x.mjs', 'conf/keys.json', 'package-lock.json', 'svc/lib', 'svc']) utimesSync(join(root, p), old, old);
  assert.equal(codeFingerprint(PATHS, root).newest, old.getTime());
  const later = new Date('2026-02-01T00:00:00Z');
  utimesSync(join(root, 'svc/lib'), later, later); // так выглядит удаление или переименование файла
  assert.equal(codeFingerprint(PATHS, root).newest, later.getTime());
});

const hasGit = spawnSync('git', ['--version']).status === 0;

test('отпечаток в git: игнорируемое не считается, новое неотслеживаемое — считается', { skip: !hasGit && 'нет git' }, () => {
  const root = tree('repo', { ...FILES, '.gitignore': 'svc/*.log\nconf/\n' });
  const git = (...args) => assert.equal(spawnSync('git', ['-C', root, ...args]).status, 0, args.join(' '));
  git('init', '-q');
  git('add', '-A');
  const base = codeFingerprint(PATHS, root);
  assert.equal(base.files, 4, 'conf/keys.json игнорируется git, но указан файлом — считается');
  writeFileSync(join(root, 'svc/run.log'), 'log\n');
  assert.equal(codeFingerprint(PATHS, root).hash, base.hash, 'игнорируемый файл');
  writeFileSync(join(root, 'svc/draft.mjs'), 'x\n');
  assert.notEqual(codeFingerprint(PATHS, root).hash, base.hash, 'новый неотслеживаемый файл');
  unlinkSync(join(root, 'svc/draft.mjs'));
  unlinkSync(join(root, 'svc/index.mjs'));
  assert.notEqual(codeFingerprint(PATHS, root).hash, base.hash, 'удалён, но в индексе');
});

const T0 = '2026-10-22T20:06:31.509142952Z';
const t0 = Date.parse(T0);
const running = (id, startedAt = T0) => ({ id, running: true, startedAt });
const code = (hash, newest = t0 - 60_000) => ({ hash, newest, files: 1 });

test('staleReason: по записи — по отпечатку, без записи — по времени файлов', () => {
  const c = running('c1');
  assert.equal(staleReason(c, { container: 'c1', started: T0, code: 'h1' }, code('h1')), null);
  assert.equal(staleReason(c, { container: 'c1', started: T0, code: 'h1' }, code('h2')), 'код изменился');
  // Запись о совпадающем коде, но mtime новее — решает отпечаток (правка и откат).
  assert.equal(staleReason(c, { container: 'c1', started: T0, code: 'h1' }, code('h1', t0 + 60_000)), null);
  // Записи нет или контейнер с тех пор пересоздан / перезапущен — по времени.
  for (const rec of [undefined, { container: 'c0', started: T0, code: 'h1' }, { container: 'c1', started: '2026-10-22T08:00:00Z', code: 'h1' }]) {
    assert.equal(staleReason(c, rec, code('h2', t0 - 60_000)), null);
    assert.equal(staleReason(c, rec, code('h2', t0 + 60_000)), 'файлы новее старта контейнера');
    assert.equal(staleReason(c, rec, code('h2', t0 - 1000)), 'файлы новее старта контейнера', 'запас на часы Docker');
  }
  assert.equal(staleReason({ id: 'c1', running: true, startedAt: 'нет' }, undefined, code('h1')), 'неизвестно время старта');
});

const ALL = ['server', 'device-sim', 'yookassa-emu', 'kkt-emu', 'kkt-bridge', 'caddy'];
const ids = Object.fromEntries(ALL.map((s) => [s, `id-${s}`]));
const containers = Object.fromEntries(ALL.map((s) => [s, running(ids[s])]));
const state = Object.fromEntries(ALL.map((s) => [s, { container: ids[s], started: T0, code: `h-${s}` }]));
const codes = Object.fromEntries(ALL.map((s) => [s, code(`h-${s}`)]));
const plan = (over = {}) => planServices({ services: ALL, containers, state, codes, ...over });
const restarted = (p) => Object.entries(p.actions).filter(([, a]) => a.action === 'restart').map(([s]) => s);

test('план: код не менялся — ничего не перезапускается, ключи прежние', () => {
  const p = plan();
  assert.deepEqual(restarted(p), []);
  assert.ok(Object.values(p.actions).every((a) => a.action === 'keep'));
  assert.equal(p.provision, false);
  assert.equal(p.registerKkt, false);
  assert.deepEqual(p.recreate, []);
});

test('план: изменился код эмулятора — перезапускается только он (Д2)', () => {
  const p = plan({ codes: { ...codes, 'yookassa-emu': code('new') } });
  assert.deepEqual(restarted(p), ['yookassa-emu']);
  assert.equal(p.actions['yookassa-emu'].reason, 'код изменился');
  assert.equal(p.provision, false);
});

test('план: изменился server — заново provision:dev, перезапуск device-sim, новый мост', () => {
  const p = plan({ codes: { ...codes, server: code('new') } });
  assert.deepEqual(restarted(p), ['server', 'device-sim', 'kkt-bridge']);
  assert.equal(p.provision, true);
  assert.equal(p.registerKkt, true);
  assert.deepEqual(p.recreate, ['kkt-bridge']);
  // Без скрипта регистрации мост не трогаем.
  const q = plan({ codes: { ...codes, server: code('new') }, kktRegister: false });
  assert.deepEqual(restarted(q), ['server', 'device-sim']);
  assert.equal(q.registerKkt, false);
});

test('план: --restart — все сервисы Node, caddy нет', () => {
  const p = plan({ force: true });
  assert.deepEqual(restarted(p), NODE_SERVICES);
  assert.equal(p.actions.caddy.action, 'keep');
  assert.equal(p.provision, true);
});

test('план: нет контейнера или он остановлен — start; server — ещё и provision:dev', () => {
  const { server: _s, ...rest } = containers;
  const p = plan({ containers: { ...rest, 'kkt-emu': { ...containers['kkt-emu'], running: false } } });
  assert.deepEqual(p.actions.server, { action: 'start', reason: 'нет контейнера' });
  assert.deepEqual(p.actions['kkt-emu'], { action: 'start', reason: 'остановлен' });
  assert.equal(p.provision, true);
  assert.deepEqual(restarted(p), ['device-sim', 'kkt-bridge']);
});

test('план: нет devices.json — provision:dev; нет токена моста — только регистрация моста', () => {
  assert.equal(plan({ devicesFile: false }).provision, true);
  const p = plan({ kktToken: false });
  assert.equal(p.provision, false);
  assert.equal(p.registerKkt, true);
  assert.deepEqual(restarted(p), ['kkt-bridge']);
  assert.equal(plan({ kktToken: false, kktRegister: false }).registerKkt, false);
});

test('состояние: у нетронутого — прежний отпечаток, у запущенного заново — отпечаток перед up', () => {
  const before = { server: running('a'), 'device-sim': running('b'), caddy: running('c') };
  const after = { server: running('a'), 'device-sim': running('b', '2026-10-22T21:00:00Z'), caddy: { id: 'c', running: false, startedAt: T0 } };
  const s = nextState({
    services: ['server', 'device-sim', 'caddy'],
    before,
    after,
    planCodes: { server: code('p1'), 'device-sim': code('p2'), caddy: code('p3') },
    upCodes: { server: code('u1'), 'device-sim': code('u2'), caddy: code('u3') },
  });
  assert.deepEqual(s, {
    server: { container: 'a', started: T0, code: 'p1' },
    'device-sim': { container: 'b', started: '2026-10-22T21:00:00Z', code: 'u2' },
  });
  const file = join(tmp, 'state.json');
  assert.deepEqual(readState(file), {}, 'нет файла — пусто');
  writeState(s, file);
  assert.deepEqual(readState(file), s);
  writeFileSync(file, 'не json');
  assert.deepEqual(readState(file), {});
});

test('docker inspect: сервис по метке Compose, одноразовые контейнеры не считаются', () => {
  const out = [
    `id1 true ${T0} server False`,
    'id2 false 0001-01-01T00:00:00Z kkt-emu False',
    `id3 true ${T0} server True`,
    '',
  ].join('\n');
  assert.deepEqual(parseInspect(out), {
    server: { id: 'id1', running: true, startedAt: T0 },
    'kkt-emu': { id: 'id2', running: false, startedAt: '0001-01-01T00:00:00Z' },
  });
});

test('compose.yml: у каждого сервиса Node есть список кода; db и mosquitto в план не входят', () => {
  const compose = readFileSync(join(ROOT, 'deploy', 'dev', 'compose.yml'), 'utf8');
  const nodeServices = [...compose.matchAll(/\n {2}([a-z][a-z-]*):\n {4}<<: \*node-service/g)].map((m) => m[1]);
  assert.deepEqual([...nodeServices].sort(), [...NODE_SERVICES].sort());
  for (const s of [...NODE_SERVICES, 'caddy']) assert.ok(SERVICE_CODE[s]?.length > 0, s);
  assert.equal(SERVICE_CODE.db, undefined);
  assert.equal(SERVICE_CODE.mosquitto, undefined);
  // Пути из списков есть в репозитории (кроме файлов, которые создаёт npm run dev).
  const generated = ['.env', 'deploy/dev/certs/ca.crt', 'deploy/dev/devices.json', 'deploy/dev/kkt-bridge.token'];
  for (const p of new Set(Object.values(SERVICE_CODE).flat())) {
    if (generated.includes(p)) continue;
    assert.ok(codeFingerprint([p]).files > 0, `нет ${p}`);
  }
});
