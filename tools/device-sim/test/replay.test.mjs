// Таблица повторов §3.2 — чистая функция и через автомат с NVS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ackPayload, decideReplay } from '../lib/replay.mjs';
import { TableMachine, STATE_PERIOD_MS } from '../lib/machine.mjs';
import { FakeClock } from '../lib/clock.mjs';
import { MemoryNvs, NVS_KEYS } from '../lib/nvs.mjs';
import { makeCommand, signed, TEST_KEY_B64 } from './helpers/sign.mjs';

const A = '0192f3c1-6d1a-7c3e-9b2a-0000000000a1';
const B = '0192f3c1-6d1a-7c3e-9b2a-0000000000b2';

test('§3.2 как таблица', () => {
  const saved = { seq: 5, id: A, ok: true, error: null, state_seq: 3 };
  assert.equal(decideReplay(null, 1, A), 'execute');
  assert.equal(decideReplay(saved, 6, B), 'execute');
  assert.equal(decideReplay(saved, 500, A), 'execute');
  assert.equal(decideReplay(saved, 5, A), 'resend');
  assert.equal(decideReplay(saved, 5, B), 'replayed');
  assert.equal(decideReplay(saved, 4, A), 'replayed');
  assert.equal(decideReplay(saved, 1, B), 'replayed');
  assert.equal(decideReplay({ seq: 5, id: null }, 5, A), 'replayed');
});

test('ack из блока NVS собирается байт в байт так же, как при ответе', () => {
  assert.equal(
    ackPayload({ id: A, seq: 5, ok: false, error: 'unknown_type', state_seq: 3 }),
    `{"v":1,"cmd_id":"${A}","seq":5,"ok":false,"error":"unknown_type","state_seq":3}`,
  );
  assert.equal(ackPayload({ id: A, seq: 6, ok: true, error: null, state_seq: 4 }), `{"v":1,"cmd_id":"${A}","seq":6,"ok":true,"error":null,"state_seq":4}`);
});

function rig() {
  const clock = new FakeClock(1000);
  const nvs = new MemoryNvs();
  const realSet = nvs.set.bind(nvs);
  nvs.set = (k, v) => {
    if (k === NVS_KEYS.replay) out.order.push('nvs:replay');
    realSet(k, v);
  };
  const out = { acks: [], states: [], events: [], commands: [], order: [] };
  const machine = new TableMachine({
    deviceKey: Buffer.from(TEST_KEY_B64, 'base64'),
    clock,
    nvs,
    output: (m) => {
      out.order.push(m.kind);
      if (m.kind === 'ack') out.acks.push(m.payload);
      if (m.kind === 'state') out.states.push(m.state);
      if (m.kind === 'event') out.events.push(JSON.parse(m.entry.payload));
      if (m.kind === 'command') out.commands.push(m.info);
    },
  });
  machine.start();
  const send = (cmd) => {
    const raw = typeof cmd === 'string' ? cmd : signed(cmd);
    machine.handleCommand(Buffer.from(raw, 'utf8'));
    return JSON.parse(out.acks.at(-1));
  };
  return { clock, nvs, out, machine, send };
}

test('seq больше сохранённого: исполнить → блок {seq, id, ok, error, state_seq} в NVS → ack', () => {
  const { nvs, send, machine, out } = rig();
  const from = out.order.length;
  const ack = send(makeCommand({ seq: 1, id: A, type: 'identify', body: { duration_ms: 10_000 } }));
  assert.deepEqual([ack.cmd_id, ack.seq, ack.ok, ack.error], [A, 1, true, null]);
  assert.deepEqual(nvs.get(NVS_KEYS.replay), { seq: 1, id: A, ok: true, error: null, state_seq: ack.state_seq });
  // Исполнение (state) → запись блока в NVS → ack.
  assert.deepEqual(out.order.slice(from), ['state', 'nvs:replay', 'ack', 'command']);
  assert.equal(machine.snapshot().last_seq, 1);
  machine.stop();
});

test('точный повтор (тот же id и seq): сохранённый ack байт в байт, без исполнения', () => {
  const { clock, out, send, machine } = rig();
  const raw = signed(makeCommand({ seq: 1, id: A, type: 'identify', body: { duration_ms: 10_000 } }));
  send(raw);
  const firstAck = out.acks.at(-1);
  assert.equal(out.states.at(-1).led, 'identify');

  clock.advance(STATE_PERIOD_MS); // identify кончился, state_seq вырос от публикаций
  assert.ok(out.states.at(-1).state_seq > JSON.parse(firstAck).state_seq);
  const statesBefore = out.states.length;
  send(raw);
  assert.equal(out.acks.at(-1), firstAck, 'тот же ack');
  assert.equal(out.states.length, statesBefore, 'state не публиковался — команда не исполнялась');
  assert.equal(out.commands.at(-1).result, 'resend');
  machine.stop();
});

test('точный повтор не перезапускает таймер identify', () => {
  const { clock, out, send, machine } = rig();
  const raw = signed(makeCommand({ seq: 1, id: A, type: 'identify', body: { duration_ms: 10_000 } }));
  send(raw);
  clock.advance(6_000);
  send(raw);
  clock.advance(4_000);
  assert.equal(machine.snapshot().led, 'green_dim', 'identify кончился через 10 с от первой команды');
  assert.equal(out.states.filter((s) => s.led === 'identify').length, 1);
  machine.stop();
});

test('seq равен сохранённому, id другой: replayed_seq и событие, NVS не меняется', () => {
  const { nvs, out, send, machine } = rig();
  send(makeCommand({ seq: 3, id: A }));
  const before = nvs.get(NVS_KEYS.replay);
  const ack = send(makeCommand({ seq: 3, id: B }));
  assert.deepEqual([ack.cmd_id, ack.seq, ack.ok, ack.error], [B, 3, false, 'replayed_seq']);
  assert.deepEqual(nvs.get(NVS_KEYS.replay), before);
  const ev = out.events.at(-1);
  assert.equal(ev.type, 'replayed_seq');
  assert.deepEqual(ev.data, { cmd_id: B, seq: 3 });
  machine.stop();
});

test('seq меньше сохранённого: replayed_seq и событие', () => {
  const { out, send, machine } = rig();
  send(makeCommand({ seq: 10, id: A }));
  const ack = send(makeCommand({ seq: 9, id: B }));
  assert.equal(ack.error, 'replayed_seq');
  // Старый id с меньшим seq — тоже отказ (событие — не чаще раза в 10 с, ack — всегда).
  assert.equal(send(makeCommand({ seq: 2, id: A })).error, 'replayed_seq');
  assert.deepEqual(out.events.filter((e) => e.type === 'replayed_seq').map((e) => e.data.seq), [9]);
  machine.stop();
});

test('пропуск seq допустим: исполняется', () => {
  const { send, machine } = rig();
  send(makeCommand({ seq: 1, id: A }));
  assert.equal(send(makeCommand({ seq: 40, id: B })).ok, true);
  assert.equal(machine.snapshot().last_seq, 40);
  machine.stop();
});

test('bad_sig не сдвигает seq; та же команда с верной подписью потом исполняется', () => {
  const { nvs, out, send, machine } = rig();
  const cmd = makeCommand({ seq: 2, id: A });
  const forged = signed(cmd, Buffer.alloc(32, 7).toString('base64'));
  const bad = send(forged);
  assert.deepEqual([bad.cmd_id, bad.seq, bad.ok, bad.error], [A, 2, false, 'bad_sig']);
  assert.equal(nvs.get(NVS_KEYS.replay), undefined);
  assert.equal(out.events.at(-1).type, 'bad_sig');
  assert.deepEqual(out.events.at(-1).data, { cmd_id: A, seq: 2 });
  assert.equal(send(cmd).ok, true);
  machine.stop();
});

test('unknown_type сдвигает seq и сохраняется: повтор получает тот же ack', () => {
  const { out, send, nvs, machine } = rig();
  const raw = signed(makeCommand({ seq: 4, id: A, type: 'lamp.on', body: { session_id: B } }));
  const ack = send(raw);
  assert.deepEqual([ack.ok, ack.error], [false, 'unknown_type']);
  assert.equal(nvs.get(NVS_KEYS.replay).seq, 4);
  const stored = out.acks.at(-1);
  send(raw);
  assert.equal(out.acks.at(-1), stored);
  assert.equal(machine.mode, 'free');
  machine.stop();
});

test('точный повтор session.start не исполняется второй раз: свет и остаток те же', () => {
  const { out, send, nvs, machine } = rig();
  const raw = signed(makeCommand({ seq: 4, id: A, type: 'session.start', body: { session_id: B, remaining_ms: 3_600_000, buzzer: true } }));
  assert.equal(send(raw).ok, true);
  const writes = nvs.writes;
  const states = out.states.length;
  send(raw);
  assert.equal(nvs.writes, writes, 'NVS не тронут');
  assert.equal(out.states.length, states, 'state не публикуется');
  assert.equal(machine.mode, 'active');
  machine.stop();
});

test('ping повтором не публикует state второй раз', () => {
  const { out, send, machine } = rig();
  const raw = signed(makeCommand({ seq: 1, id: A }));
  const before = out.states.length;
  const ack = send(raw);
  assert.equal(out.states.length, before + 1);
  assert.equal(ack.state_seq, out.states.at(-1).state_seq, 'ack указывает на опубликованный state');
  send(raw);
  assert.equal(out.states.length, before + 1);
  machine.stop();
});
