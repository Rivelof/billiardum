// Конечный автомат без MQTT: загрузка, state, периодичность, identify, ping, M1-типы, буфер событий.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CAPS, SIM_FW, STATE_PERIOD_MS, TableMachine } from '../lib/machine.mjs';
import { FakeClock } from '../lib/clock.mjs';
import { EventRing, MemoryNvs, NVS_KEYS } from '../lib/nvs.mjs';
import { COMMAND_TYPES, EXECUTED_IN_M0, LEDS, MODE_OUTPUTS, MODES, TRANSITIONS } from '../lib/modes.mjs';
import { makeCommand, signed, TEST_KEY_B64 } from './helpers/sign.mjs';

const STATE_KEYS = [
  'v', 'state_seq', 'mode', 'session_id', 'remaining_ms', 'relay', 'dim', 'led', 'buzzer',
  'current_ma', 'caps', 'fw', 'boot', 'rssi', 'uptime_s', 'last_seq',
];

function rig(options = {}) {
  const clock = options.clock ?? new FakeClock(5_000);
  const nvs = options.nvs ?? new MemoryNvs();
  const out = { acks: [], states: [], stateMsgs: [], events: [] };
  const machine = new TableMachine({
    deviceKey: Buffer.from(TEST_KEY_B64, 'base64'),
    clock,
    nvs,
    caps: options.caps,
    output: (m) => {
      if (m.kind === 'ack') out.acks.push(m.payload);
      if (m.kind === 'state') {
        out.states.push(m.state);
        out.stateMsgs.push(m);
      }
      if (m.kind === 'event') out.events.push(JSON.parse(m.entry.payload));
    },
  });
  machine.start(options.start);
  let seq = 0;
  const send = (type, body = {}) => {
    seq += 1;
    machine.handleCommand(Buffer.from(signed(makeCommand({ seq, type, body })), 'utf8'));
    return JSON.parse(out.acks.at(-1));
  };
  return { clock, nvs, out, machine, send };
}

test('загрузка: boot+1 в NVS, событие boot с n=1, первый state', () => {
  const { nvs, out, machine } = rig();
  assert.equal(nvs.get(NVS_KEYS.boot), 1);
  assert.equal(out.events.length, 1);
  assert.deepEqual(out.events[0], {
    v: 1, boot: 1, n: 1, type: 'boot', at_uptime_ms: 0,
    data: { fw: SIM_FW, caps: [...DEFAULT_CAPS], reset_reason: 'power_on' },
  });
  assert.equal(out.states.length, 1);
  assert.equal(out.stateMsgs[0].changed, true);
  machine.stop();
});

test('перезагрузка с тем же NVS: boot растёт, n начинается заново', () => {
  const nvs = new MemoryNvs();
  rig({ nvs }).machine.stop();
  const second = rig({ nvs, start: { resetReason: 'sw' } });
  assert.equal(second.out.events[0].boot, 2);
  assert.equal(second.out.events[0].n, 1);
  assert.equal(second.out.events[0].data.reset_reason, 'sw');
  assert.equal(second.machine.snapshot().boot, 2);
  second.machine.stop();
});

test('state по формату §4: поля, порядок и значения в free', () => {
  const { out, machine } = rig();
  const s = JSON.parse(out.stateMsgs[0].payload);
  assert.deepEqual(Object.keys(s), STATE_KEYS);
  assert.deepEqual(s, {
    v: 1, state_seq: 1, mode: 'free', session_id: null, remaining_ms: null, relay: false, dim: 0,
    led: 'green_dim', buzzer: false, current_ma: 0, caps: [...DEFAULT_CAPS], fw: SIM_FW, boot: 1,
    rssi: s.rssi, uptime_s: 0, last_seq: 0,
  });
  assert.ok(Number.isInteger(s.rssi) && s.rssi < 0);
  machine.stop();
});

test('без датчика тока current_ma = null, caps как задано', () => {
  const { out, machine } = rig({ caps: ['relay', 'led'] });
  assert.equal(out.states[0].current_ma, null);
  assert.deepEqual(out.states[0].caps, ['relay', 'led']);
  assert.deepEqual(out.events[0].data.caps, ['relay', 'led']);
  machine.stop();
});

test('state раз в 60 с без изменений: state_seq растёт, uptime идёт', () => {
  const { clock, out, machine } = rig();
  clock.advance(STATE_PERIOD_MS - 1);
  assert.equal(out.states.length, 1);
  clock.advance(1);
  assert.equal(out.states.length, 2);
  assert.equal(out.stateMsgs[1].changed, false);
  assert.equal(out.states[1].state_seq, 2);
  assert.equal(out.states[1].uptime_s, 60);
  clock.advance(3 * STATE_PERIOD_MS);
  assert.equal(out.states.length, 5);
  assert.equal(out.states.at(-1).uptime_s, 240);
  machine.stop();
});

test('ping: ack ok и внеочередной state; ack.state_seq = state_seq опубликованного state', () => {
  const { out, send, machine } = rig();
  const ack = send('ping');
  assert.deepEqual(Object.keys(ack), ['v', 'cmd_id', 'seq', 'ok', 'error', 'state_seq']);
  assert.deepEqual([ack.v, ack.seq, ack.ok, ack.error], [1, 1, true, null]);
  assert.equal(out.states.length, 2);
  assert.equal(ack.state_seq, out.states[1].state_seq);
  assert.equal(out.states[1].last_seq, 1);
  machine.stop();
});

test('identify: индикатор identify на duration_ms, потом обратно; повторный identify продлевает', () => {
  const { clock, out, send, machine } = rig();
  assert.equal(send('identify', { duration_ms: 30_000 }).ok, true);
  assert.equal(out.states.at(-1).led, 'identify');
  assert.equal(out.stateMsgs.at(-1).changed, true);
  assert.equal(out.states.at(-1).relay, false, 'свет не включается');
  clock.advance(20_000);
  send('identify', { duration_ms: 30_000 });
  clock.advance(20_000);
  assert.equal(machine.snapshot().led, 'identify');
  clock.advance(10_000);
  assert.equal(machine.snapshot().led, 'green_dim');
  assert.equal(out.states.at(-1).led, 'green_dim');
  machine.stop();
});

test('identify с неверным телом — bad_format на шаге 4 (seq сдвинут); без led — hw_fault', () => {
  const { send, machine } = rig();
  assert.equal(send('identify', {}).error, 'bad_format');
  assert.equal(send('identify', { duration_ms: 0 }).error, 'bad_format');
  assert.equal(machine.snapshot().last_seq, 2);
  machine.stop();
  const noLed = rig({ caps: ['relay'] });
  assert.equal(noLed.send('identify', { duration_ms: 1000 }).error, 'hw_fault');
  noLed.machine.stop();
});

test('остальные типы до M1 — unknown_type, стол остаётся free со светом выключенным', () => {
  const { send, machine, out } = rig();
  const notYet = COMMAND_TYPES.filter((t) => !EXECUTED_IN_M0.has(t));
  assert.equal(notYet.length, 11);
  for (const type of [...notYet, 'no.such.type']) {
    const ack = send(type, { session_id: '0192f3c0-0000-7000-8000-000000000001', remaining_ms: 60_000, duration_ms: 1000 });
    assert.deepEqual([ack.ok, ack.error], [false, 'unknown_type'], type);
  }
  assert.equal(machine.mode, 'free');
  assert.ok(out.states.every((s) => s.relay === false));
  machine.stop();
});

test('bad_format: ack без cmd_id и seq, события нет', () => {
  const { machine, out } = rig();
  machine.handleCommand(Buffer.from('{"v":1,"id":'));
  assert.deepEqual(JSON.parse(out.acks.at(-1)), { v: 1, cmd_id: null, seq: null, ok: false, error: 'bad_format', state_seq: 1 });
  assert.equal(out.events.length, 1, 'только boot');
  machine.stop();
});

test('события лежат в буфере NVS до подтверждения доставки', () => {
  const { machine } = rig();
  machine.handleCommand(Buffer.from(signed(makeCommand({ seq: 1 }), Buffer.alloc(32).toString('base64'))));
  const pending = machine.pendingEvents();
  assert.deepEqual(pending.map((e) => [e.type, e.boot, e.n]), [['boot', 1, 1], ['bad_sig', 1, 2]]);
  assert.equal(machine.eventDelivered(1, 1), true);
  assert.deepEqual(machine.pendingEvents().map((e) => e.n), [2]);
  assert.equal(machine.eventDelivered(1, 1), false);
  machine.stop();
});

test('кольцевой буфер: при переполнении вытесняется старое, счётчик вытесненных растёт', () => {
  const nvs = new MemoryNvs();
  const ring = new EventRing(nvs, 3);
  for (let n = 1; n <= 5; n += 1) ring.push({ boot: 1, n, type: 't', payload: `${n}` });
  assert.deepEqual(ring.list().map((e) => e.n), [3, 4, 5]);
  assert.equal(ring.dropped, 2);
  assert.equal(ring.remove(1, 4), true); // не самое старое
  assert.deepEqual(ring.list().map((e) => e.n), [3, 5]);
  ring.push({ boot: 2, n: 1, type: 't', payload: 'x' });
  assert.equal(ring.remove(1, 3), true);
  assert.deepEqual(ring.list().map((e) => [e.boot, e.n]), [[1, 5], [2, 1]]);
});

test('NVS: команды пишут одну запись replay, ping без событий — без лишних записей', () => {
  const { nvs, send, machine } = rig();
  const before = nvs.writes;
  send('ping');
  assert.equal(nvs.writes - before, 1);
  machine.stop();
});

test('§5 заложен структурой: состояния, выходы и переходы согласованы', () => {
  assert.deepEqual(Object.keys(MODE_OUTPUTS).sort(), [...MODES].sort());
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...MODES].sort());
  for (const { led } of Object.values(MODE_OUTPUTS)) assert.ok(LEDS.includes(led));
  for (const targets of Object.values(TRANSITIONS)) {
    for (const target of Object.values(targets)) {
      for (const mode of target.split('|')) assert.ok(MODES.includes(mode), mode);
    }
  }
  assert.equal(MODE_OUTPUTS.free.relay, false);
  assert.equal(MODE_OUTPUTS.active.relay, true);
});
