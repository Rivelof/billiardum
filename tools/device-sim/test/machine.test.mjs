// Конечный автомат без MQTT: загрузка, state, периодичность, ping, identify, тело команд,
// события (boot_id, буфер 64, events_dropped, ограничение частоты, NVS только без связи).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CAPS, REJECT_EVENT_INTERVAL_MS, SIM_FW, STATE_PERIOD_MS, TableMachine } from '../lib/machine.mjs';
import { FakeClock } from '../lib/clock.mjs';
import { EVENT_RING_CAPACITY, EventRing, MemoryNvs, NVS_KEYS } from '../lib/nvs.mjs';
import { BODY_SPECS, validateBody } from '../lib/body.mjs';
import { COMMAND_TYPES, EXECUTED_IN_M0, LEDS, MODE_OUTPUTS, MODES, TRANSITIONS } from '../lib/modes.mjs';
import { makeCommand, signed, TEST_KEY_B64 } from './helpers/sign.mjs';

const STATE_KEYS = [
  'v', 'state_seq', 'mode', 'session_id', 'remaining_ms', 'relay', 'dim', 'led', 'buzzer',
  'current_ma', 'caps', 'fw', 'boot', 'rssi', 'uptime_s', 'last_seq',
];
const SESSION = '0192f3c0-0000-7000-8000-000000000001';
const WRONG_KEY = Buffer.alloc(32, 3).toString('base64');

// Корректные тела всех типов §3.3.
const VALID_BODIES = {
  'session.start': { session_id: SESSION, remaining_ms: 3_600_000, buzzer: true },
  'session.resume': { session_id: SESSION, remaining_ms: 60_000, warn_ms: [120_000, 30_000], grace_ms: 0, buzzer: false },
  'session.extend': { session_id: SESSION, remaining_ms: 86_400_000, buzzer: true },
  'session.stop': { session_id: SESSION, reason_code: 'guest_finished' },
  'service.start': { duration_ms: 900_000, reason_code: 'cleaning' },
  'service.stop': {},
  'state.reserved': { until_ms: 900_000 },
  'state.pending': { until_ms: 180_000 },
  'state.free': {},
  identify: { duration_ms: 30_000 },
  'config.set': { led_brightness: 255, grace_dim: 0 },
  'ota.start': { url: 'https://billiardum.ru/fw/1.0.4.bin', version: '1.0.4', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', image_sig: 'MEUCIQ' },
  ping: {},
};

function rig(options = {}) {
  const clock = options.clock ?? new FakeClock(5_000);
  const nvs = options.nvs ?? new MemoryNvs();
  const out = { acks: [], states: [], stateMsgs: [], events: [] };
  let bootIds = 0;
  const machine = new TableMachine({
    deviceKey: Buffer.from(TEST_KEY_B64, 'base64'),
    clock,
    nvs,
    caps: options.caps,
    bootId: () => `b00710${String(++bootIds).padStart(2, '0')}`,
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
  const send = (type, body = {}, key) => {
    seq += 1;
    machine.handleCommand(Buffer.from(signed(makeCommand({ seq, type, body }), key), 'utf8'));
    return JSON.parse(out.acks.at(-1));
  };
  return { clock, nvs, out, machine, send };
}

test('загрузка: boot+1 в NVS, событие boot с boot_id и n=1, первый state', () => {
  const { nvs, out, machine } = rig();
  assert.equal(nvs.get(NVS_KEYS.boot), 1);
  assert.equal(out.events.length, 1);
  assert.deepEqual(Object.keys(out.events[0]), ['v', 'boot', 'boot_id', 'n', 'type', 'at_uptime_ms', 'data']);
  assert.deepEqual(out.events[0], {
    v: 1, boot: 1, boot_id: 'b0071001', n: 1, type: 'boot', at_uptime_ms: 0,
    data: { fw: SIM_FW, caps: [...DEFAULT_CAPS], reset_reason: 'poweron' },
  });
  assert.equal(out.states.length, 1);
  assert.equal(out.stateMsgs[0].changed, true);
  machine.stop();
});

test('boot_id по умолчанию — 8 случайных шестнадцатеричных символов, новый при каждой загрузке', () => {
  const nvs = new MemoryNvs();
  const ids = new Set();
  for (let i = 0; i < 5; i += 1) {
    const m = new TableMachine({ deviceKey: Buffer.alloc(32), clock: new FakeClock(), nvs });
    m.start();
    assert.match(m.bootId, /^[0-9a-f]{8}$/);
    ids.add(m.bootId);
    m.stop();
  }
  assert.equal(ids.size, 5);
});

test('перезагрузка с тем же NVS: boot растёт, boot_id новый, n начинается с 1', () => {
  const nvs = new MemoryNvs();
  rig({ nvs }).machine.stop();
  const second = rig({ nvs, start: { resetReason: 'sw' } });
  const boot = second.out.events[0];
  assert.deepEqual([boot.boot, boot.n, boot.data.reset_reason], [2, 1, 'sw']);
  assert.equal(second.machine.snapshot().boot, 2);
  second.machine.stop();
});

test('state по формату §4: поля, порядок и значения в free; state_seq с 1', () => {
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
  assert.equal(send('identify', { duration_ms: 30_000, extra: null }).ok, true);
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

test('identify: неверное тело — bad_body, seq принят и ответ повторяется; без led — hw_fault', () => {
  const { send, machine, nvs } = rig();
  assert.equal(send('identify', {}).error, 'bad_body');
  assert.equal(send('identify', { duration_ms: 0 }).error, 'bad_body');
  assert.equal(send('identify', { duration_ms: '5' }).error, 'bad_body');
  assert.equal(machine.snapshot().last_seq, 3);
  assert.deepEqual(nvs.get(NVS_KEYS.replay).error, 'bad_body');
  machine.stop();
  const noLed = rig({ caps: ['relay'] });
  assert.equal(noLed.send('identify', { duration_ms: 1000 }).error, 'hw_fault');
  noLed.machine.stop();
});

test('верные тела типов до M1 — unknown_type; стол остаётся free со светом выключенным', () => {
  const { send, machine, out } = rig();
  const notYet = COMMAND_TYPES.filter((t) => !EXECUTED_IN_M0.has(t));
  assert.equal(notYet.length, 11);
  for (const type of notYet) {
    assert.ok(validateBody(type, VALID_BODIES[type]).ok, type);
    const ack = send(type, VALID_BODIES[type]);
    assert.deepEqual([ack.ok, ack.error], [false, 'unknown_type'], type);
  }
  assert.deepEqual([send('no.such.type', { anything: [1] }).error], ['unknown_type']);
  assert.equal(machine.mode, 'free');
  assert.ok(out.states.every((s) => s.relay === false));
  machine.stop();
});

test('bad_body: нет поля, не тот тип значения, вне диапазона §3.3', () => {
  assert.deepEqual(Object.keys(BODY_SPECS).sort(), [...COMMAND_TYPES].sort());
  const cases = [
    ['session.start', { session_id: SESSION, remaining_ms: 60_000 }, 'buzzer'],
    ['session.start', { session_id: SESSION.toUpperCase(), remaining_ms: 60_000, buzzer: true }, 'session_id'],
    ['session.start', { session_id: SESSION, remaining_ms: 0, buzzer: true }, 'remaining_ms'],
    ['session.start', { session_id: SESSION, remaining_ms: 86_400_001, buzzer: true }, 'remaining_ms'],
    ['session.start', { session_id: SESSION, remaining_ms: 1, buzzer: 1 }, 'buzzer'],
    ['session.start', { session_id: SESSION, remaining_ms: 1, buzzer: true, warn_ms: [60_000, 300_000] }, 'warn_ms'],
    ['session.start', { session_id: SESSION, remaining_ms: 1, buzzer: true, warn_ms: [300_000] }, 'warn_ms'],
    ['session.start', { session_id: SESSION, remaining_ms: 1, buzzer: true, warn_ms: [3_600_001, 1] }, 'warn_ms'],
    ['session.start', { session_id: SESSION, remaining_ms: 1, buzzer: true, warn_ms: [2, 2] }, 'warn_ms'],
    ['session.start', { session_id: SESSION, remaining_ms: 1, buzzer: true, grace_ms: 600_001 }, 'grace_ms'],
    ['session.start', { session_id: SESSION, remaining_ms: 1, buzzer: true, grace_ms: null }, 'grace_ms'],
    ['session.resume', { remaining_ms: 1, buzzer: true }, 'session_id'],
    ['session.extend', { session_id: SESSION, buzzer: true }, 'remaining_ms'],
    ['session.stop', { session_id: SESSION }, 'reason_code'],
    ['session.stop', { session_id: SESSION, reason_code: '' }, 'reason_code'],
    ['service.start', { reason_code: 'cleaning' }, 'duration_ms'],
    ['state.pending', { until_ms: -1 }, 'until_ms'],
    ['state.reserved', {}, 'until_ms'],
    ['config.set', { led_brightness: 256 }, 'led_brightness'],
    ['config.set', { grace_dim: 101 }, 'grace_dim'],
    ['config.set', { current_on_ma: 0 }, 'current_on_ma'],
    ['ota.start', { ...VALID_BODIES['ota.start'], url: 'http://billiardum.ru/fw.bin' }, 'url'],
    ['ota.start', { ...VALID_BODIES['ota.start'], sha256: '00' }, 'sha256'],
    ['ota.start', { url: 'https://billiardum.ru/fw.bin', version: '1', sha256: VALID_BODIES['ota.start'].sha256 }, 'image_sig'],
  ];
  for (const [type, body, field] of cases) {
    assert.deepEqual(validateBody(type, body), { ok: false, error: 'bad_body', field }, `${type} ${JSON.stringify(body)}`);
  }
  // Умолчания §3.3 и игнорирование неизвестных полей.
  assert.deepEqual(validateBody('session.start', { ...VALID_BODIES['session.start'], extra: 'x' }).body, {
    ...VALID_BODIES['session.start'], warn_ms: [300_000, 60_000], grace_ms: 120_000,
  });
  assert.deepEqual(validateBody('config.set', {}).body, {});

  const { send, machine } = rig();
  const ack = send('session.start', { session_id: SESSION, remaining_ms: 0, buzzer: true });
  assert.deepEqual([ack.ok, ack.error], [false, 'bad_body']);
  machine.stop();
});

test('bad_format: ack без cmd_id и seq, события нет', () => {
  const { machine, out } = rig();
  machine.handleCommand(Buffer.from('{"v":1,"id":'));
  assert.deepEqual(JSON.parse(out.acks.at(-1)), { v: 1, cmd_id: null, seq: null, ok: false, error: 'bad_format', state_seq: 1 });
  assert.equal(out.events.length, 1, 'только boot');
  machine.stop();
});

test('события: в outbox до подтверждения доставки, адресуются (boot_id, n)', () => {
  const { machine, send } = rig();
  send('ping', {}, WRONG_KEY);
  assert.deepEqual(machine.outbox().map((e) => [e.type, e.boot_id, e.n]), [['boot', 'b0071001', 1], ['bad_sig', 'b0071001', 2]]);
  assert.equal(machine.eventDelivered('b0071001', 1), true);
  assert.deepEqual(machine.outbox().map((e) => e.n), [2]);
  assert.equal(machine.eventDelivered('b0071001', 1), false);
  assert.equal(machine.eventDelivered('ffffffff', 2), false, 'чужая загрузка');
  machine.stop();
});

test('bad_sig и replayed_seq — не чаще раза в 10 с на тип; пропущенные — в data.suppressed следующего', () => {
  const { clock, out, send, machine } = rig();
  for (let i = 0; i < 4; i += 1) assert.equal(send('ping', {}, WRONG_KEY).error, 'bad_sig', 'ack — на каждую');
  assert.equal(out.events.filter((e) => e.type === 'bad_sig').length, 1);
  assert.equal(send('ping').ok, true); // seq 5
  const replay = () => machine.handleCommand(Buffer.from(signed(makeCommand({ seq: 1 }))));
  replay();
  replay();
  assert.equal(out.events.filter((e) => e.type === 'replayed_seq').length, 1, 'свой счёт на каждый тип');

  clock.advance(REJECT_EVENT_INTERVAL_MS - 1);
  send('ping', {}, WRONG_KEY);
  assert.equal(out.events.filter((e) => e.type === 'bad_sig').length, 1);
  clock.advance(1);
  send('ping', {}, WRONG_KEY);
  const badSig = out.events.filter((e) => e.type === 'bad_sig');
  assert.equal(badSig.length, 2);
  assert.equal(badSig[0].data.suppressed, undefined);
  assert.equal(badSig[1].data.suppressed, 4);
  assert.deepEqual(Object.keys(badSig[1].data), ['cmd_id', 'seq', 'suppressed']);
  clock.advance(REJECT_EVENT_INTERVAL_MS);
  replay();
  assert.equal(out.events.filter((e) => e.type === 'replayed_seq').at(-1).data.suppressed, 1);
  machine.stop();
});

test('NVS: при связи доставленные события в NVS не пишутся; без связи — пишутся', () => {
  const { nvs, send, machine } = rig();
  machine.setOnline(true);
  for (const e of machine.outbox()) machine.eventDelivered(e.boot_id, e.n);
  const before = nvs.writes;
  send('ping', {}, WRONG_KEY); // событие bad_sig при связи
  const [ev] = machine.outbox();
  machine.eventDelivered(ev.boot_id, ev.n);
  assert.equal(nvs.writes, before, 'ни одной записи');
  send('ping'); // команда: одна запись блока replay
  assert.equal(nvs.writes, before + 1);

  machine.setOnline(false);
  const offline = nvs.writes;
  machine.handleCommand(Buffer.from(signed(makeCommand({ seq: 1 })))); // replayed_seq без связи
  assert.ok(nvs.writes > offline, 'недоставленное событие записано');
  assert.deepEqual(machine.outbox().map((e) => e.type), ['replayed_seq']);
  // Буфер переживает новую загрузку на том же NVS (M1: перезагрузка).
  machine.stop();
  const again = new TableMachine({ deviceKey: Buffer.from(TEST_KEY_B64, 'base64'), clock: new FakeClock(), nvs });
  again.start();
  assert.deepEqual(again.outbox().map((e) => e.type), ['replayed_seq', 'boot']);
  again.stop();
});

test('буфер на 64: переполнение вытесняет старое, затем первым уходит events_dropped {count}', () => {
  assert.equal(EVENT_RING_CAPACITY, 64);
  // Без связи: boot + 69 событий bad_sig (по одному в 10 с) = 70 → 6 вытеснено.
  const r = rig();
  for (let i = 0; i < 69; i += 1) {
    r.send('ping', {}, WRONG_KEY);
    r.clock.advance(REJECT_EVENT_INTERVAL_MS);
  }
  const box = r.machine.outbox();
  assert.equal(box.length, 65);
  assert.deepEqual([box[0].type, JSON.parse(box[0].payload).data], ['events_dropped', { count: 6 }]);
  assert.equal(box[0].n, 71);
  assert.deepEqual([box[1].n, box.at(-1).n], [7, 70], 'вытеснены n 1…6');
  assert.equal(r.machine.outbox().length, 65, 'events_dropped создаётся один раз');
  assert.equal(r.machine.eventDelivered(box[0].boot_id, 71), true);
  assert.equal(r.machine.outbox()[0].n, 7);
  r.machine.stop();
});

test('кольцевой буфер: вытеснение, удаление не по порядку, счётчик вытесненных', () => {
  const nvs = new MemoryNvs();
  const ring = new EventRing(nvs, 3);
  const e = (n) => ({ boot: 1, boot_id: 'aaaaaaaa', n, type: 't', payload: `${n}` });
  for (let n = 1; n <= 5; n += 1) ring.push(e(n));
  assert.deepEqual(ring.list().map((x) => x.n), [3, 4, 5]);
  assert.equal(ring.dropped, 2);
  assert.equal(nvs.writes, 0, 'без persist() в NVS ничего');
  ring.persist();
  assert.ok(nvs.writes > 0);
  assert.equal(ring.remove('aaaaaaaa', 4), true);
  assert.deepEqual(ring.list().map((x) => x.n), [3, 5]);
  assert.equal(ring.takeDropped(), 2);
  assert.equal(ring.takeDropped(), 0);
  const reloaded = new EventRing(nvs, 3);
  assert.deepEqual(reloaded.list().map((x) => x.n), [3, 5]);
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
