// T41 (live) и T42 на своём Postgres: боевой режим клуба (причина, журнал manual.*, тревога владельцу), терминалы
// управляющего сети, сравнение с живыми деньгами и рейтинг, подписка «Сеть», корты в тарифах, бронях, дашборде и каталоге.
// На стенде `live` недоступен (нужны ЮKassa и чек-лист запуска), поэтому эти пункты проверяются тестами разработчиков
// на временной базе: каждый тест сам создаёт и удаляет свою базу, стенд и его данные не затрагиваются.
//
//   DATABASE_ADMIN_URL=postgres://postgres@127.0.0.1:<порт>/postgres node --test tests/e2e/m5-8/05-db-networks.test.mjs
//
// DATABASE_ADMIN_URL — свой кластер (initdb во временной папке), НЕ база стенда: адрес стенда (порт 54322) отвергается.
// Без переменной тесты пропускаются.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const URL_ENV = process.env.DATABASE_ADMIN_URL;
const SKIP = URL_ENV ? false : 'нужен DATABASE_ADMIN_URL своего временного Postgres';

const FILES = [
  ['T41/T42: сети, шаблоны, управляющий сети, вкладка «Сеть», RLS, добавление клуба в сеть (live и test)', 'server/networks/test/db/networks.test.mjs'],
  ['T42: подписка «Сеть» (план в базе, 2+ клубов, цена только у Андрея)', 'server/networks/test/db/billing.test.mjs'],
  ['T42: управляющий сети — терминалы гаснут, способы оплаты скрыты на всех GET, надбавки модификаторов', 'server/orders/test/db/network-guards.test.mjs'],
  ['T47/T48: бар и заявки корта', 'server/orders/test/db/padel.test.mjs'],
  ['T47: мастер зала и тарифов корта', 'server/setup/test/db/padel.test.mjs'],
  ['T47: бронь корта', 'server/bookings/test/db/padel.test.mjs'],
  ['T47: дашборд и отчёты по видам ресурсов', 'server/dashboard/test/db/padel.test.mjs'],
  ['T47: дашборд — доработки M5.5/M5.8', 'server/dashboard/test/db/m55-fixes.test.mjs'],
  ['T48: каталог и фильтр «падел»', 'server/directory/test/db/padel.test.mjs'],
];
const UNIT = ['server/networks/test/networks-unit.test.mjs', 'server/test/padel-unit.test.mjs', 'server/tariffs/test/slot.test.mjs', 'server/setup/test/tariffs.test.mjs', 'server/setup/test/padel.test.mjs'];

function run(files, env = {}) {
  // Вложенный `node --test` не должен считать себя дочерним процессом внешнего прогона (иначе отчёт уходит родителю).
  const base = { ...process.env };
  delete base.NODE_TEST_CONTEXT;
  const res = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=600000', ...files], {
    cwd: ROOT,
    env: { ...base, ...env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 20 * 60_000,
  });
  const out = `${res.stdout}\n${res.stderr}`;
  const n = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
  return { status: res.status, tests: n('tests'), pass: n('pass'), fail: n('fail'), out };
}

describe('T41/T42/T47/T48: тесты разработчиков на своём Postgres', { skip: SKIP }, () => {
  it('адрес базы — не база стенда', () => {
    const u = new URL(URL_ENV);
    assert.notEqual(u.port, '54322', 'порт 54322 — база стенда (docker); нужен свой кластер');
    assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname), `хост ${u.hostname}`);
  });

  it('юнит-тесты без базы: шаблоны сетей, слоты корта, тарифы мастера', (t) => {
    const r = run(UNIT);
    t.diagnostic(`тестов ${r.tests}, прошло ${r.pass}, упало ${r.fail}`);
    assert.equal(r.status, 0, r.out.slice(-1500));
    assert.equal(r.fail, 0);
  });

  for (const [title, file] of FILES) {
    it(`${title} — ${file}`, (t) => {
      const r = run([file], { DATABASE_ADMIN_URL: URL_ENV });
      t.diagnostic(`${file}: тестов ${r.tests}, прошло ${r.pass}, упало ${r.fail}`);
      assert.equal(r.status, 0, r.out.slice(-2500));
      assert.ok(r.tests > 0 && r.fail === 0);
    });
  }
});
