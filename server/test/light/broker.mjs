// Свой брокер для it-sim.test.mjs: контейнер eclipse-mosquitto:2.1.2-alpine (decisions №40)
// с TLS (одноразовый CA, openssl) и Dynamic Security на свободном порту 127.0.0.1.
// Общий брокер стека для интеграционного теста не годится: тест создаёт свои учётки и
// устройства, а мост слушает bl/v1/+/+/#. Контейнер удаляется в stop().

import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mqtt from 'mqtt';

export const IMAGE = 'eclipse-mosquitto:2.1.2-alpine';

const CONF = `allow_anonymous false
max_packet_size 8192
listener 8883
protocol mqtt
certfile /mosquitto/certs/mqtt.crt
keyfile /mosquitto/certs/mqtt.key
tls_version tlsv1.2
plugin /usr/lib/mosquitto_dynamic_security.so
plugin_opt_config_file /mosquitto/data/dynamic-security.json
persistence false
log_dest stdout
log_type error
log_type warning
`;

const ENTRY = `mkdir -p /mosquitto/certs /mosquitto/data
cp /certs/ca.crt /certs/mqtt.crt /certs/mqtt.key /mosquitto/certs/
chown -R mosquitto:mosquitto /mosquitto/certs /mosquitto/data
chmod 600 /mosquitto/certs/mqtt.key
[ -s /mosquitto/data/dynamic-security.json ] || mosquitto_ctrl dynsec init /mosquitto/data/dynamic-security.json bl-admin "$MQTT_ADMIN_PASSWORD" >/dev/null
chown mosquitto:mosquitto /mosquitto/data/dynamic-security.json
exec mosquitto -c /mosquitto/config/mosquitto.conf`;

/** Есть ли docker и openssl на хосте. */
export function canStartBroker() {
  const d = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
  const o = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  return d.status === 0 && o.status === 0;
}

function openssl(args, cwd) {
  execFileSync('openssl', args, { cwd, stdio: 'ignore' });
}

/** @returns {Promise<{ url, caFile, adminUser, adminPassword, stop(): void }>} */
export async function startBroker() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bl-light-it-'));
  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'ca.key'], dir);
  openssl(['req', '-x509', '-new', '-key', 'ca.key', '-sha256', '-days', '2', '-subj', '/CN=bl-light-it CA', '-out', 'ca.crt'], dir);
  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'mqtt.key'], dir);
  openssl(['req', '-new', '-key', 'mqtt.key', '-subj', '/CN=localhost', '-out', 'mqtt.csr'], dir);
  writeFileSync(path.join(dir, 'ext.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n');
  openssl(['x509', '-req', '-in', 'mqtt.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-sha256', '-extfile', 'ext.cnf', '-out', 'mqtt.crt'], dir);
  writeFileSync(path.join(dir, 'mosquitto.conf'), CONF);
  const name = `bl-light-it-${randomBytes(3).toString('hex')}`;
  const adminPassword = randomBytes(18).toString('base64url');
  execFileSync(
    'docker',
    [
      'run', '-d', '--name', name, '-e', 'MQTT_ADMIN_PASSWORD', '-p', '127.0.0.1::8883',
      '-v', `${path.join(dir, 'mosquitto.conf')}:/mosquitto/config/mosquitto.conf:ro`,
      '-v', `${dir}:/certs:ro`,
      '--entrypoint', '/bin/sh', IMAGE, '-ec', ENTRY,
    ],
    { env: { ...process.env, MQTT_ADMIN_PASSWORD: adminPassword }, stdio: 'ignore' },
  );
  const stop = () => {
    spawnSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore' });
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const port = execFileSync('docker', ['port', name, '8883/tcp'], { encoding: 'utf8' }).trim().split('\n')[0].split(':').at(-1);
    const url = `mqtts://localhost:${port}`;
    const caFile = path.join(dir, 'ca.crt');
    const { readFileSync } = await import('node:fs');
    const ca = readFileSync(caFile);
    const end = Date.now() + 30_000;
    for (;;) {
      try {
        const c = await mqtt.connectAsync(url, { username: 'bl-admin', password: adminPassword, ca, reconnectPeriod: 0, connectTimeout: 2_000, clientId: `probe-${randomBytes(3).toString('hex')}` });
        await c.endAsync();
        break;
      } catch (err) {
        if (Date.now() > end) throw new Error(`брокер ${name} не поднялся: ${err.message}`, { cause: err });
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    return { url, caFile, adminUser: 'bl-admin', adminPassword, stop };
  } catch (err) {
    stop();
    throw err;
  }
}
