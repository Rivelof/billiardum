// Все векторы docs/protocol-vectors.json: результат проверки и каноническая строка.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { verifyCommand } from '../lib/command.mjs';
import { TableMachine } from '../lib/machine.mjs';
import { FakeClock } from '../lib/clock.mjs';
import { testCanonical } from './helpers/sign.mjs';

const file = JSON.parse(readFileSync(new URL('../../../docs/protocol-vectors.json', import.meta.url), 'utf8'));
const vectors = file.vectors;

test('файл векторов на месте и не пуст', () => {
  assert.equal(file.protocol, 'bl/v1');
  assert.ok(vectors.length >= 20, `векторов ${vectors.length}`);
  const kinds = new Set(vectors.map((v) => v.expect));
  assert.deepEqual([...kinds].sort(), ['bad_format', 'bad_sig', 'ok']);
});

for (const vec of vectors) {
  test(`вектор «${vec.name}» → ${vec.expect}`, () => {
    const key = Buffer.from(vec.key_b64, 'base64');
    const r = verifyCommand(Buffer.from(vec.raw, 'utf8'), key);
    assert.equal(r.status, vec.expect, `причина: ${r.reason}`);

    if (vec.expect === 'ok' || vec.expect === 'bad_sig') {
      assert.equal(r.canonical, vec.canonical, 'каноническая строка');
    }
    if (vec.expect === 'ok') {
      const sig = createHmac('sha256', key).update(r.canonical, 'utf8').digest('base64');
      assert.equal(sig, vec.sig, 'подпись канонической строки');
      // Независимая канонизация тестов даёт ту же строку.
      assert.equal(testCanonical(JSON.parse(vec.raw)), vec.canonical);
    }
  });

  test(`вектор «${vec.name}» через автомат: ack`, () => {
    const acks = [];
    const machine = new TableMachine({
      deviceKey: Buffer.from(vec.key_b64, 'base64'),
      clock: new FakeClock(),
      output: (m) => m.kind === 'ack' && acks.push(JSON.parse(m.payload)),
    });
    machine.start();
    machine.handleCommand(Buffer.from(vec.raw, 'utf8'));
    machine.stop();
    assert.equal(acks.length, 1);
    const [ack] = acks;
    if (vec.expect === 'ok') {
      // Подпись и формат верны; на свежем контроллере без сессии extend и stop — wrong_session.
      const type = JSON.parse(vec.raw).type;
      const want = ['session.extend', 'session.stop'].includes(type) ? 'wrong_session' : 'ok';
      assert.equal(ack.ok ? 'ok' : ack.error, want, type);
    } else {
      assert.deepEqual([ack.ok, ack.error], [false, vec.expect]);
    }
  });
}
