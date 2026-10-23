// QR с корпуса контроллера (M5.1 №159): разбор BLD1, заводской код, PDF наклеек на корпус,
// команды консоли factory для прошивки.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import jsQR from 'jsqr';
import { FACTORY_CLAIM_CODE, formatDeviceQr, generateClaimCode, parseDeviceQr } from '../../devices/qr.mjs';
import { deviceStickersPdf, PER_PAGE } from '../../qr/device-stickers.mjs';
import { qrMatrix } from '../../qr/stickers.mjs';
import { claimCodeHash } from '../../sessions/service.mjs';
import { factoryCommands, generateDevices, parseArgs } from '../../../scripts/provision-factory.mjs';

const DEV = 'd9000000-0000-4000-8000-0000000000aa';

describe('BLD1', () => {
  it('разбор: префикс, UUID строчными, код как есть; неверное — null', () => {
    assert.deepEqual(parseDeviceQr(`BLD1:${DEV.toUpperCase()}:7K2M-Q9XD-4HTB-R1VS\n`), { deviceId: DEV, claimCode: '7K2M-Q9XD-4HTB-R1VS' });
    assert.deepEqual(parseDeviceQr(`BLD1:${DEV}:CODE-1234`), { deviceId: DEV, claimCode: 'CODE-1234' });
    for (const bad of [
      `BLD2:${DEV}:CODE-1234`,
      `bld1:${DEV}:CODE-1234`,
      `BLD1:${DEV}`,
      `BLD1:not-a-uuid:CODE-1234`,
      `BLD1:${DEV}:CODE 1234`,
      `BLD1:${DEV}:SHORT`,
      `BLD1:${DEV}:CODE-1234:extra`,
      `https://example.com/BLD1:${DEV}:CODE-1234`,
      42,
      null,
      `BLD1:${DEV}:${'A'.repeat(64)}`,
      `BLD1:${DEV}:ABCDEFG`,
    ]) {
      assert.equal(parseDeviceQr(bad), null, String(bad));
    }
    // Код 8…63 символа: он же пароль точки доступа WPA2 (protocol §7).
    assert.equal(parseDeviceQr(`BLD1:${DEV}:${'A'.repeat(63)}`).claimCode.length, 63);
    assert.equal(parseDeviceQr(`BLD1:${DEV}:ABCDEFGH`).claimCode, 'ABCDEFGH');
    assert.equal(formatDeviceQr(DEV, 'CODE-1234'), `BLD1:${DEV}:CODE-1234`);
    assert.throws(() => formatDeviceQr('x', 'CODE-1234'));
  });

  it('заводской код: 16 символов Crockford Base32 группами по 4, разные', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateClaimCode()));
    assert.equal(codes.size, 200);
    for (const c of codes) assert.match(c, FACTORY_CLAIM_CODE);
    assert.equal(generateClaimCode(() => Buffer.alloc(10, 0)), '0000-0000-0000-0000');
    assert.equal(generateClaimCode(() => Buffer.alloc(10, 0xff)), 'ZZZZ-ZZZZ-ZZZZ-ZZZZ');
  });
});

describe('provision-factory', () => {
  it('устройства: device_id UUID v4, код, хеш как у привязки (№67); команды консоли', () => {
    const devices = generateDevices(3);
    assert.equal(devices.length, 3);
    for (const d of devices) {
      assert.match(d.device_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.match(d.claim_code, FACTORY_CLAIM_CODE);
      assert.equal(d.claim_code_hash, claimCodeHash(d.device_id, d.claim_code));
      assert.equal(d.qr, `BLD1:${d.device_id}:${d.claim_code}`);
    }
    const cmds = factoryCommands(devices);
    assert.deepEqual(cmds, devices.map((d) => `factory ${d.device_id} ${d.claim_code}`));
    // Прошивка: код 8–64 печатных ASCII, без пробелов (firmware/src/main.cpp handleConsoleLine).
    for (const d of devices) assert.ok(d.claim_code.length >= 8 && d.claim_code.length <= 64 && !/\s/.test(d.claim_code));
  });

  it('аргументы: --count, --batch, --out; неверные — ошибка', () => {
    assert.deepEqual(parseArgs(['--count', '5', '--batch', 'B-2026-10', '--out', 'x.pdf']), { count: 5, batch: 'B-2026-10', out: 'x.pdf', commandsOut: null, dryRun: false });
    assert.equal(parseArgs(['--dry-run']).dryRun, true);
    assert.throws(() => parseArgs(['--count', '0']));
    assert.throws(() => parseArgs(['--count', '1001']));
    assert.throws(() => parseArgs(['--batch', 'плохо']));
    assert.throws(() => parseArgs(['--what']));
  });

  it('PDF наклеек на корпус: страницы по 24, QR читается и равен BLD1', () => {
    const devices = generateDevices(PER_PAGE + 1);
    const pdf = deviceStickersPdf({ devices, batch: 'B1' });
    const text = pdf.toString('latin1');
    assert.ok(text.startsWith('%PDF-1.7'));
    assert.equal(Number(/\/Type \/Pages[^>]*\/Count (\d+)/.exec(text)[1]), 2);
    // QR той же матрицей, что в PDF: рисуем в картинку и читаем jsQR.
    const m = qrMatrix(devices[0].qr);
    const scale = 4;
    const quiet = 4;
    const size = (m.length + quiet * 2) * scale;
    const img = new Uint8ClampedArray(size * size * 4).fill(255);
    for (let y = 0; y < m.length; y += 1) {
      for (let x = 0; x < m.length; x += 1) {
        if (!m[y][x]) continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const p = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
            img[p] = 0;
            img[p + 1] = 0;
            img[p + 2] = 0;
          }
        }
      }
    }
    assert.equal(jsQR(img, size, size)?.data, devices[0].qr);
    assert.throws(() => deviceStickersPdf({ devices: [] }));
  });
});
