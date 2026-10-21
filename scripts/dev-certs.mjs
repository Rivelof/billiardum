// Dev-сертификаты для брокера MQTT: собственный CA и сертификат Mosquitto.
// Без OpenSSL и сторонних пакетов: ключи ECDSA P-256 из node:crypto,
// сертификаты X.509 v3 собираются в DER вручную (контракт M0 §4).
//
//   node scripts/dev-certs.mjs        — создать, если файлов нет
//
// Файлы: deploy/dev/certs/ca.crt, ca.key, mqtt.crt, mqtt.key (в git не попадают).
// Готовые файлы не перегенерируются. Если пропал только сертификат брокера,
// он выпускается заново тем же CA. Чтобы сменить всё, удалите deploy/dev/certs/.

import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CERTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'dev', 'certs');

export const CA_SUBJECT = [['O', 'Billiardum dev'], ['CN', 'Billiardum Dev CA']];
export const BROKER_SUBJECT = [['O', 'Billiardum dev'], ['CN', 'mosquitto']];
export const BROKER_DNS = ['localhost', 'mosquitto'];
export const BROKER_IPS = ['127.0.0.1'];
export const CA_DAYS = 3650; // 10 лет
export const BROKER_DAYS = 730; // 2 года
const RENEW_BEFORE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- DER ----------

function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, ...parts) {
  const content = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

const seq = (...items) => tlv(0x30, ...items);
const set = (...items) => tlv(0x31, ...items);
const octetString = (buf) => tlv(0x04, buf);
const bitString = (buf, unusedBits = 0) => tlv(0x03, Buffer.from([unusedBits]), buf);
const derTrue = () => tlv(0x01, Buffer.from([0xff]));
const explicit = (n, inner) => tlv(0xa0 + n, inner);

function integer(value) {
  let buf = Buffer.isBuffer(value) ? value : Buffer.from([value]);
  // Минимальная запись: убрать лишние ведущие нули, добавить 0x00 перед старшим битом.
  while (buf.length > 1 && buf[0] === 0 && buf[1] < 0x80) buf = buf.subarray(1);
  if (buf[0] >= 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
  return tlv(0x02, buf);
}

function oid(dotted) {
  const arcs = dotted.split('.').map(Number);
  const out = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const chunk = [arc & 0x7f];
    for (let v = Math.floor(arc / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function derTime(date) {
  // RFC 5280: UTCTime до 2049 года включительно, дальше GeneralizedTime.
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  return date.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`, 'ascii'))
    : tlv(0x18, Buffer.from(`${iso}Z`, 'ascii'));
}

const OID = {
  CN: '2.5.4.3',
  O: '2.5.4.10',
  ecdsaWithSHA256: '1.2.840.10045.4.3.2',
  subjectKeyIdentifier: '2.5.29.14',
  keyUsage: '2.5.29.15',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  authorityKeyIdentifier: '2.5.29.35',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

function name(rdns) {
  return seq(...rdns.map(([type, value]) => set(seq(oid(OID[type]), tlv(0x0c, Buffer.from(value, 'utf8'))))));
}

function extension(id, critical, valueDer) {
  return critical ? seq(oid(id), derTrue(), octetString(valueDer)) : seq(oid(id), octetString(valueDer));
}

// Идентификатор ключа: SHA-1 от открытого ключа (RFC 5280 §4.2.1.2, способ 1).
function keyId(publicKey) {
  const { x, y } = publicKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(x, 'base64url'), Buffer.from(y, 'base64url')]);
  return createHash('sha1').update(point).digest();
}

function serialNumber() {
  const buf = randomBytes(16);
  buf[0] = (buf[0] & 0x7f) | 0x40; // положительный, без ведущего нуля
  return buf;
}

function toPem(label, der) {
  const lines = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

/**
 * Выпускает сертификат X.509 v3, подписанный ECDSA-SHA256.
 * @returns {string} PEM
 */
export function issueCertificate({ subject, issuer, publicKey, signingKey, issuerPublicKey, days, isCa, dns = [], ips = [], now = new Date() }) {
  const notBefore = new Date(now.getTime() - 60 * 60 * 1000); // запас на расхождение часов
  const notAfter = new Date(now.getTime() + days * DAY_MS);
  const sigAlg = seq(oid(OID.ecdsaWithSHA256));

  const extensions = [
    extension(OID.basicConstraints, true, isCa ? seq(derTrue(), integer(0)) : seq()),
    // keyCertSign + cRLSign = биты 5 и 6; digitalSignature = бит 0.
    extension(OID.keyUsage, true, isCa ? bitString(Buffer.from([0x06]), 1) : bitString(Buffer.from([0x80]), 7)),
    extension(OID.subjectKeyIdentifier, false, octetString(keyId(publicKey))),
    extension(OID.authorityKeyIdentifier, false, seq(tlv(0x80, keyId(issuerPublicKey)))),
  ];
  if (!isCa) {
    extensions.push(extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))));
    const altNames = [
      ...dns.map((d) => tlv(0x82, Buffer.from(d, 'ascii'))),
      ...ips.map((ip) => tlv(0x87, Buffer.from(ip.split('.').map(Number)))),
    ];
    extensions.push(extension(OID.subjectAltName, false, seq(...altNames)));
  }

  const tbs = seq(
    explicit(0, integer(2)), // v3
    integer(serialNumber()),
    sigAlg,
    name(issuer),
    seq(derTime(notBefore), derTime(notAfter)),
    name(subject),
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(...extensions)),
  );
  const signature = sign('sha256', tbs, signingKey); // DER (r, s)
  return toPem('CERTIFICATE', seq(tbs, sigAlg, bitString(signature)));
}

function newKeyPair() {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

function writeFile(path, content, mode) {
  writeFileSync(path, content, { mode });
}

/** Проверка сертификата брокера: подписан CA, не истекает, нужные SAN. Возвращает текст проблемы или null. */
export function brokerCertProblem(caPem, brokerPem, now = new Date()) {
  let ca;
  let cert;
  try {
    ca = new X509Certificate(caPem);
    cert = new X509Certificate(brokerPem);
  } catch {
    return 'файл сертификата не читается';
  }
  if (!cert.checkIssued(ca) || !cert.verify(ca.publicKey)) return 'сертификат брокера выпущен другим CA';
  if (new Date(ca.validTo).getTime() < now.getTime()) return 'истёк срок CA';
  if (new Date(cert.validTo).getTime() - now.getTime() < RENEW_BEFORE_DAYS * DAY_MS) return 'сертификат брокера истекает';
  for (const host of BROKER_DNS) if (!cert.checkHost(host)) return `в сертификате брокера нет имени ${host}`;
  for (const ip of BROKER_IPS) if (!cert.checkIP(ip)) return `в сертификате брокера нет адреса ${ip}`;
  return null;
}

/**
 * Создаёт недостающие dev-сертификаты.
 * @returns {{changed: boolean, caChanged: boolean}}
 */
export function ensureDevCerts({ dir = CERTS_DIR, log = (m) => console.log(`[certs] ${m}`), now = new Date() } = {}) {
  const p = {
    caCrt: join(dir, 'ca.crt'),
    caKey: join(dir, 'ca.key'),
    crt: join(dir, 'mqtt.crt'),
    key: join(dir, 'mqtt.key'),
  };
  mkdirSync(dir, { recursive: true });

  let caChanged = false;
  let caKey;
  let caCert;
  if (existsSync(p.caCrt) && existsSync(p.caKey)) {
    caKey = createPrivateKey(readFileSync(p.caKey));
    caCert = readFileSync(p.caCrt, 'utf8');
  } else {
    const pair = newKeyPair();
    caKey = pair.privateKey;
    caCert = issueCertificate({
      subject: CA_SUBJECT,
      issuer: CA_SUBJECT,
      publicKey: pair.publicKey,
      signingKey: pair.privateKey,
      issuerPublicKey: pair.publicKey,
      days: CA_DAYS,
      isCa: true,
      now,
    });
    writeFile(p.caKey, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), 0o600);
    writeFile(p.caCrt, caCert, 0o644);
    caChanged = true;
    log(`создан dev CA (10 лет): ${relative(process.cwd(), p.caCrt)}`);
  }

  const haveBroker = existsSync(p.crt) && existsSync(p.key);
  const problem = haveBroker && !caChanged ? brokerCertProblem(caCert, readFileSync(p.crt, 'utf8'), now) : 'нет файлов';
  if (!problem) return { changed: false, caChanged: false };
  if (haveBroker && !caChanged && problem === 'истёк срок CA') {
    throw new Error('Истёк срок dev CA. Удалите deploy/dev/certs/ и запустите снова.');
  }

  const pair = newKeyPair();
  const brokerPem = issueCertificate({
    subject: BROKER_SUBJECT,
    issuer: CA_SUBJECT,
    publicKey: pair.publicKey,
    signingKey: caKey,
    issuerPublicKey: new X509Certificate(caCert).publicKey,
    days: BROKER_DAYS,
    isCa: false,
    dns: BROKER_DNS,
    ips: BROKER_IPS,
    now,
  });
  const check = brokerCertProblem(caCert, brokerPem, now);
  if (check) throw new Error(`Не удалось выпустить сертификат брокера: ${check}. Удалите deploy/dev/certs/ и запустите снова.`);
  writeFile(p.key, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), 0o600);
  writeFile(p.crt, brokerPem, 0o644);
  log(`выпущен сертификат брокера (2 года, ${[...BROKER_DNS, ...BROKER_IPS].join(', ')})${haveBroker ? `: старый — ${problem}` : ''}`);
  return { changed: true, caChanged };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { changed } = ensureDevCerts();
  if (!changed) console.log(`[certs] сертификаты уже есть: ${relative(process.cwd(), CERTS_DIR)}`);
}
