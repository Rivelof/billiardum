// T9. Команда с неверной подписью → bad_sig, тревога.
//
// На живом стеке подать команду в cmd устройства нечем: в cmd пишет только сервер (bl-server,
// закреплён за client id сервера — под ним не входим, иначе выбьем сервер), учётка стола читает
// только свой cmd (M0, 05-mqtt-acl), а роль admin у bl-admin даёт лишь чтение # и $CONTROL.
// Тест проверяет последнее: подписанная чужим ключом session.start от bl-admin в cmd стола →
// PUBACK 0x87 «Not authorized», до симулятора не доходит, свет не включается.
//
// Сам путь bad_sig → событие → тревога critical проверяется тестами владельцев, их тест и
// запускает (E2E_T9_RUN=1 — по умолчанию да):
//   * tools/device-sim: сценарий 14-bad-body (bad_sig, seq не сдвигается, событие не чаще раза
//     в 10 с) — общий с нативными тестами прошивки;
//   * server/test/light/device.test.mjs «T9» — временная база, поддельный контроллер: ack bad_sig,
//     тревога critical, device.event в журнале (нужен DATABASE_ADMIN_URL из .env).

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { connectMqtt, publishQos1, signCommand, topic } from '../m0/helpers.mjs';
import { brief, env, loadDevices, logLines, REPO_ROOT, sim, SIM_CONTAINER, sleep } from './helpers.mjs';

const TABLE = Number(process.env.E2E_T9_TABLE || 5);
const RUN_OWNERS = process.env.E2E_T9_RUN !== '0';

test(`T9: bl-admin не может подать команду в cmd стола ${TABLE} (PUBACK 0x87), до контроллера не доходит`, async (t) => {
  const dev = loadDevices().find((d) => d.table_number === TABLE);
  const before = await sim(TABLE);
  const client = await connectMqtt({
    clientId: `bl-e2e-t9-${randomBytes(4).toString('hex')}`,
    username: env('MQTT_ADMIN_USER'),
    password: env('MQTT_ADMIN_PASSWORD'),
    protocolVersion: 5,
  });
  const since = new Date();
  const cmd = {
    v: 1,
    id: randomUUID(),
    seq: Number(before.state.last_seq) + 1,
    type: 'session.start',
    issued_at: Math.floor(Date.now() / 1000),
    body: { session_id: randomUUID(), remaining_ms: 3_600_000, warn_ms: [300_000, 60_000], grace_ms: 120_000, buzzer: true },
  };
  cmd.sig = signCommand(cmd, randomBytes(32).toString('base64')).sig; // чужой ключ
  const r = await publishQos1(client, topic(dev.club_id, dev.device_id, 'cmd'), JSON.stringify(cmd));
  await client.endAsync();
  await sleep(1500);
  const seen = logLines(SIM_CONTAINER, since, 'sim_cmd').filter((l) => l.table === TABLE && l.cmd_id === cmd.id);
  const after = await sim(TABLE);
  t.diagnostic(`PUBACK: ${JSON.stringify(r)}; симулятор получил: ${seen.length}; стол: ${brief(after)}`);
  assert.equal(r.ok, false);
  assert.equal(r.code, 135, 'PUBACK 0x87 Not authorized');
  assert.equal(seen.length, 0);
  assert.equal(after.state.relay, before.state.relay);
});

function run(t, label, args, extraEnv = {}) {
  // Без NODE_TEST_CONTEXT: иначе вложенный node --test отдаёт отчёт не в TAP, а родителю.
  const { NODE_TEST_CONTEXT: _ctx, ...base } = process.env;
  const res = spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8', env: { ...base, ...extraEnv }, maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
  const out = `${res.stdout}\n${res.stderr}`;
  const lines = out.split('\n').filter((l) => /^# (tests|pass|fail|skipped)\b/.test(l) || /(not )?ok \d+ - .*(T9|bad_sig|14-bad-body)/.test(l));
  t.diagnostic(`${label}: exit ${res.status}; ${lines.map((l) => l.trim()).join(' | ')}`);
  return { status: res.status, out };
}

test('T9: bad_sig → событие → тревога critical — тесты симулятора и backend-light', { skip: !RUN_OWNERS && 'E2E_T9_RUN=0', timeout: 600_000 }, (t) => {
  const simRes = run(t, 'device-sim сценарии', ['--test', '--test-name-pattern=bad_sig|14-bad-body', 'tools/device-sim/test/scenarios.test.mjs']);
  assert.equal(simRes.status, 0, 'сценарий bad_sig симулятора');
  assert.match(simRes.out, /# pass [1-9]/);
  const lightRes = run(t, 'server/test/light/device.test.mjs', ['--test', '--test-concurrency=1', '--test-name-pattern=T9', 'server/test/light/device.test.mjs'], {
    DATABASE_ADMIN_URL: env('DATABASE_ADMIN_URL'),
  });
  assert.equal(lightRes.status, 0, 'тест T9 backend-light');
  assert.match(lightRes.out, /ok \d+ - T9: команда с неверной подписью/);
});
