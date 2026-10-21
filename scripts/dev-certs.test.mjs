import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { brokerCertProblem, ensureDevCerts } from './dev-certs.mjs';

const dir = mkdtempSync(join(tmpdir(), 'bl-certs-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const quiet = () => {};
const read = (f) => readFileSync(join(dir, f), 'utf8');
const DAY = 24 * 60 * 60 * 1000;

test('создаёт CA и сертификат брокера по контракту §4', () => {
  const res = ensureDevCerts({ dir, log: quiet });
  assert.deepEqual(res, { changed: true, caChanged: true });

  const ca = new X509Certificate(read('ca.crt'));
  const cert = new X509Certificate(read('mqtt.crt'));
  assert.equal(ca.ca, true);
  assert.equal(cert.ca, false);
  assert.ok(cert.checkIssued(ca));
  assert.ok(cert.verify(ca.publicKey));
  assert.ok(ca.verify(ca.publicKey));
  assert.equal(cert.subjectAltName, 'DNS:localhost, DNS:mosquitto, IP Address:127.0.0.1');

  const years = (c) => (new Date(c.validTo) - new Date(c.validFrom)) / (365 * DAY);
  assert.ok(Math.abs(years(ca) - 10) < 0.05, `CA ${years(ca)} лет`);
  assert.ok(Math.abs(years(cert) - 2) < 0.05, `брокер ${years(cert)} лет`);
  assert.equal(brokerCertProblem(read('ca.crt'), read('mqtt.crt')), null);
});

test('не перегенерирует готовые файлы', () => {
  const before = read('mqtt.crt');
  assert.deepEqual(ensureDevCerts({ dir, log: quiet }), { changed: false, caChanged: false });
  assert.equal(read('mqtt.crt'), before);
});

test('пропавший сертификат брокера выпускается тем же CA', () => {
  const caBefore = read('ca.crt');
  unlinkSync(join(dir, 'mqtt.crt'));
  assert.deepEqual(ensureDevCerts({ dir, log: quiet }), { changed: true, caChanged: false });
  assert.equal(read('ca.crt'), caBefore);
  assert.equal(brokerCertProblem(caBefore, read('mqtt.crt')), null);
});

test('сертификат брокера, который скоро истечёт, выпускается заново', () => {
  const soon = new Date(Date.now() + 720 * DAY);
  assert.equal(brokerCertProblem(read('ca.crt'), read('mqtt.crt'), soon), 'сертификат брокера истекает');
  assert.deepEqual(ensureDevCerts({ dir, log: quiet, now: soon }), { changed: true, caChanged: false });
  assert.equal(brokerCertProblem(read('ca.crt'), read('mqtt.crt'), soon), null);
});
