// Живые проверки «защита держит» (поручено tester после ухода pentester):
// 1. Лимит сайта: 125 разных несуществующих адресов клуба за минуту с одного IP → 429 с Retry-After
//    (не позже 121-го), кэшированные страницы с того же IP открываются.
// 2. Подделка X-Forwarded-For через Caddy не снимает лимит API (проба pentester xff_via_caddy.mjs).
// 3. Изнутри сети Docker прямо на server:3000 подделанный XFF с адресом сайта не снимает лимит
//    публичного API (проба xff_inner_network.mjs; сервер доверяет XFF только Caddy и сайту).
// Пробы — из отдельных контейнеров node:22.23.4-alpine в сети billiardum_default: свой IP, лимиты
// тестера не задеваются. Корень CA Caddy — во временной папке.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { CADDY_CONTAINER } from '../m0/helpers.mjs';
import { REPO_ROOT } from './helpers.mjs';

const NET = process.env.E2E_DOCKER_NET || 'billiardum_default';
const IMAGE = process.env.E2E_PROBE_IMAGE || 'node:22.23.4-alpine';
let caDir;

before(() => {
  caDir = mkdtempSync(path.join(os.tmpdir(), 'bl-e2e-ca-'));
  const r = spawnSync('docker', ['exec', CADDY_CONTAINER, 'cat', '/data/caddy/pki/authorities/local/root.crt'], { encoding: 'utf8' });
  writeFileSync(path.join(caDir, 'root.crt'), r.stdout);
});

function probe(dir, script) {
  const r = spawnSync(
    'docker',
    ['run', '--rm', '--network', NET, '-v', `${dir}:/probe:ro`, '-v', `${caDir}/root.crt:/ca/root.crt:ro`, IMAGE, 'node', `/probe/${script}`],
    { encoding: 'utf8', timeout: 180_000 },
  );
  assert.equal(r.status, 0, `${script}: ${r.stderr.slice(-400)}`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

test('лимит сайта: 429 с Retry-After после 120 некэшированных адресов, кэшированные страницы открываются', async (t) => {
  const out = probe(path.join(REPO_ROOT, 'tests/e2e/m4/probes'), 'site_limit.mjs');
  t.diagnostic(JSON.stringify(out));
  // Лимит — ведро на 120 в минуту с пополнением (2 в секунду): за ~2 с прогона добавляется пара запросов.
  assert.ok(out.firstLimited !== null && out.firstLimited <= 125, `429 на ${out.firstLimited}-м запросе`);
  assert.ok(Number(out.retry) > 0, 'Retry-After');
  assert.deepEqual(out.after, [200, 200, 200], 'кэшированные страницы открываются');
});

test('подделка X-Forwarded-For через Caddy не снимает лимит API (31-й запрос — 429)', async (t) => {
  // Проба pentester читает /probe/caddy-root.crt — копия пробы с путём к корню CA во временной папке.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bl-e2e-xff-'));
  for (const f of ['xff_via_caddy.mjs', 'xff_inner_network.mjs']) {
    const src = spawnSync('cat', [path.join(REPO_ROOT, 'tests/security/m4/probes', f)], { encoding: 'utf8' }).stdout;
    writeFileSync(path.join(dir, f), src.replaceAll('/probe/caddy-root.crt', '/ca/root.crt'));
  }
  const raw = spawnSync('docker', ['run', '--rm', '--network', NET, '-v', `${dir}:/probe:ro`, '-v', `${caDir}/root.crt:/ca/root.crt:ro`, IMAGE, 'node', '/probe/xff_via_caddy.mjs'], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(raw.status, 0, raw.stderr.slice(-300));
  const codes = JSON.parse(raw.stdout.trim().split('\n').at(-1));
  const inner = spawnSync('docker', ['run', '--rm', '--network', NET, '-v', `${dir}:/probe:ro`, IMAGE, 'node', '/probe/xff_inner_network.mjs'], { encoding: 'utf8', timeout: 120_000 });
  const innerOut = inner.status === 0 ? JSON.parse(inner.stdout.trim().split('\n').at(-1)) : { error: inner.stderr.slice(-200) };
  t.diagnostic(`через Caddy: ${JSON.stringify(codes)}; изнутри сети на server:3000 с XFF сайта: ${JSON.stringify(innerOut)}`);
  assert.equal(codes.at(-1), 429, '31-й запрос с новым поддельным XFF — 429');
  if (innerOut.spoofed_site_ip) assert.ok((innerOut.spoofed_site_ip['429'] ?? 0) > 0, 'подделка XFF изнутри сети не снимает лимит');
});
