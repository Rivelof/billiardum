#!/usr/bin/env node
// Интеграционный тест симулятора с настоящим брокером (контракты M0 §10, M1 §9).
// Поднимает свой контейнер bl-fw-mqtt (eclipse-mosquitto:2.1.2-alpine, decisions №40; порт 18884) с временным
// конфигом: вход по паролю, ACL как у Dynamic Security (устройство — только свои топики),
// TLS с одноразовым CA, если на хосте есть openssl (иначе mqtt:// и предупреждение).
// Запускает test/integration.test.mjs и удаляет контейнер.
//
//   npm run test:it -w tools/device-sim
//   SIM_IT_TLS=0      — без TLS
//   SIM_IT_KEEP=1     — не удалять контейнер и временную папку
//   SIM_IT_WORKDIR=…  — где создать временную папку (по умолчанию os.tmpdir())

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = process.env.SIM_IT_CONTAINER || 'bl-fw-mqtt';
const IMAGE = 'eclipse-mosquitto:2.1.2-alpine';
const PORT = Number(process.env.SIM_IT_PORT || 18884);
const OBSERVER = 'bl-sim-it';
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sh(cmd, args, what) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${what}: ${(r.stderr || r.error?.message || '').trim()}`);
  return r.stdout;
}

function hasOpenssl() {
  return spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0;
}

function makeCerts(dir) {
  const p = (f) => path.join(dir, f);
  writeFileSync(p('ext.cnf'), [
    'basicConstraints=CA:FALSE',
    'keyUsage=critical,digitalSignature,keyAgreement',
    'extendedKeyUsage=serverAuth',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '',
  ].join('\n'));
  sh('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', p('ca.key')], 'ключ CA');
  sh('openssl', ['req', '-x509', '-new', '-key', p('ca.key'), '-sha256', '-days', '2', '-subj', '/CN=bl-sim-it-ca',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-out', p('ca.crt')], 'сертификат CA');
  sh('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', p('server.key')], 'ключ брокера');
  sh('openssl', ['req', '-new', '-key', p('server.key'), '-subj', '/CN=localhost', '-out', p('server.csr')], 'запрос брокера');
  sh('openssl', ['x509', '-req', '-in', p('server.csr'), '-CA', p('ca.crt'), '-CAkey', p('ca.key'), '-CAcreateserial',
    '-days', '2', '-sha256', '-extfile', p('ext.cnf'), '-out', p('server.crt')], 'сертификат брокера');
  rmSync(p('ca.key'));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForBroker() {
  for (let i = 0; i < 100; i += 1) {
    const logs = spawnSync('docker', ['logs', NAME], { encoding: 'utf8' });
    const text = `${logs.stdout}${logs.stderr}`;
    if (/mosquitto version \S+ running/.test(text)) return;
    if (/terminating|Error/.test(text)) throw new Error(`брокер не запустился:\n${text}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('брокер не запустился за 10 с');
}

async function main() {
  sh('docker', ['image', 'inspect', IMAGE], `нет образа ${IMAGE}`);
  const tls = process.env.SIM_IT_TLS !== '0' && hasOpenssl();
  const root = mkdtempSync(path.join(process.env.SIM_IT_WORKDIR || tmpdir(), 'bl-sim-it-'));
  const broker = path.join(root, 'broker');
  mkdirSync(broker);

  const secret = () => randomBytes(18).toString('base64url');
  const clubId = randomUUID();
  const devices = [1, 2].map((table) => ({
    device_id: randomUUID(),
    club_id: clubId,
    resource_id: randomUUID(),
    table_number: table,
    mqtt_username: null,
    mqtt_password: secret(),
    device_key: randomBytes(32).toString('base64'),
  }));
  for (const d of devices) d.mqtt_username = d.device_id;
  const observerPassword = secret();

  if (tls) makeCerts(broker);
  writeFileSync(path.join(broker, 'mosquitto.conf'), [
    `listener ${PORT}`,
    'allow_anonymous false',
    'password_file /mosquitto/config/passwd',
    'acl_file /mosquitto/config/acl',
    'persistence false',
    'log_dest stdout',
    ...(tls ? ['cafile /mosquitto/config/ca.crt', 'certfile /mosquitto/config/server.crt', 'keyfile /mosquitto/config/server.key'] : []),
    '',
  ].join('\n'));
  // Как роль Dynamic Security из протокола §2: чтение cmd, запись ack/state/event/status.
  writeFileSync(path.join(broker, 'acl'), [
    `user ${OBSERVER}`,
    'topic readwrite bl/v1/#',
    '',
    'pattern read bl/v1/+/%u/cmd',
    'pattern write bl/v1/+/%u/ack',
    'pattern write bl/v1/+/%u/state',
    'pattern write bl/v1/+/%u/event',
    'pattern write bl/v1/+/%u/status',
    '',
  ].join('\n'));
  writeFileSync(path.join(broker, 'passwd'), [
    `${OBSERVER}:${observerPassword}`,
    ...devices.map((d) => `${d.device_id}:${d.mqtt_password}`),
    '',
  ].join('\n'), { mode: 0o600 });
  // Хеширует пароли и отдаёт файлы пользователю mosquitto внутри контейнера.
  sh('docker', ['run', '--rm', '-v', `${broker}:/w`, IMAGE, 'sh', '-c',
    'mosquitto_passwd -U /w/passwd && chown -R mosquitto:mosquitto /w && chmod 0600 /w/passwd /w/acl && (chmod 0600 /w/server.key 2>/dev/null || true)'],
  'подготовка паролей');

  const url = `${tls ? 'mqtts' : 'mqtt'}://localhost:${PORT}`;
  const devicesFile = path.join(root, 'devices.json');
  writeFileSync(devicesFile, JSON.stringify({ mqtt_url: url, ca_file: tls ? path.join(broker, 'ca.crt') : null, devices }, null, 2), { mode: 0o600 });

  spawnSync('docker', ['rm', '-f', NAME], { encoding: 'utf8' });
  let code;
  try {
    sh('docker', ['run', '-d', '--name', NAME, '-p', `127.0.0.1:${PORT}:${PORT}`, '-v', `${broker}:/mosquitto/config:ro`,
      IMAGE, 'mosquitto', '-c', '/mosquitto/config/mosquitto.conf'], 'запуск брокера');
    await waitForBroker();
    process.stdout.write(`# брокер ${NAME} на ${url}${tls ? ' (TLS, одноразовый CA)' : ' (без TLS: нет openssl или SIM_IT_TLS=0)'}\n`);

    const child = spawn(process.execPath, ['--test', 'test/integration.test.mjs'], {
      cwd: PACKAGE_DIR,
      stdio: 'inherit',
      env: {
        ...process.env,
        SIM_IT_MQTT_URL: url,
        SIM_IT_CA_FILE: tls ? path.join(broker, 'ca.crt') : '',
        SIM_IT_DEVICES_FILE: devicesFile,
        SIM_IT_OBSERVER_USER: OBSERVER,
        SIM_IT_OBSERVER_PASSWORD: observerPassword,
        SIM_IT_CONTROL_PORT: String(await freePort()),
      },
    });
    code = await new Promise((resolve) => child.on('exit', (c) => resolve(c ?? 1)));
  } finally {
    if (process.env.SIM_IT_KEEP === '1') {
      process.stdout.write(`# SIM_IT_KEEP=1: контейнер ${NAME} и папка ${root} оставлены\n`);
    } else {
      spawnSync('docker', ['rm', '-f', NAME], { encoding: 'utf8' });
      // Файлы брокера принадлежат uid mosquitto — удаляем изнутри контейнера.
      spawnSync('docker', ['run', '--rm', '-v', `${root}:/w`, IMAGE, 'rm', '-rf', '/w/broker'], { encoding: 'utf8' });
      rmSync(root, { recursive: true, force: true });
    }
  }
  process.exitCode = code;
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
});
