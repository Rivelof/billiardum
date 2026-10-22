// Автомат M1: то, что не видно в общих сценариях — когда публикуется state, порядок state → NVS → ack,
// выход relay для метрики, износ NVS, срок в прошлом после config.set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TableMachine, SESSION_SAVE_MS, BOOT_WAIT_MS } from '../lib/machine.mjs';
import { FakeClock } from '../lib/clock.mjs';
import { MemoryNvs, NVS_KEYS } from '../lib/nvs.mjs';
import { simSensor } from '../lib/scenario.mjs';
import { makeCommand, signed, TEST_KEY_B64 } from './helpers/sign.mjs';

const S = '0192f3c0-0000-7000-8000-0000000000c1';

function rig(options = {}) {
  const clock = new FakeClock(0);
  const nvs = options.nvs ?? new MemoryNvs();
  const faults = { bypass: false, lampFault: false };
  const out = { all: [], states: [], acks: [], events: [] };
  const machine = new TableMachine({
    deviceKey: Buffer.from(TEST_KEY_B64, 'base64'),
    clock,
    nvs,
    caps: options.caps,
    sensor: simSensor(faults),
    output: (m) => {
      out.all.push(m);
      if (m.kind === 'state') out.states.push(m);
      if (m.kind === 'ack') out.acks.push(JSON.parse(m.payload));
      if (m.kind === 'event') out.events.push(JSON.parse(m.entry.payload));
    },
  });
  machine.start();
  machine.setOnline(true);
  let seq = 0;
  const send = (type, body = {}) => {
    seq += 1;
    machine.handleCommand(Buffer.from(signed(makeCommand({ seq, type, body }))));
    return out.acks.at(-1);
  };
  return { clock, nvs, faults, out, machine, send };
}

test('state публикуется при смене режима и раз в 60 с, но не от хода остатка', () => {
  const { clock, out, send, machine } = rig();
  send('session.start', { session_id: S, remaining_ms: 3_600_000, buzzer: true });
  const n = out.states.length;
  clock.advance(59_999);
  assert.equal(out.states.length, n, 'остаток идёт — публикации нет');
  clock.advance(1);
  assert.equal(out.states.length, n + 1, 'периодическая (60 с от загрузки)');
  assert.equal(out.states.at(-1).changed, false);
  assert.equal(out.states.at(-1).state.remaining_ms, 3_540_000);
  machine.stop();
});

test('session.start: выход relay с cmd_id, state раньше ack, ack.state_seq — этот state', () => {
  const { out, send, machine } = rig();
  const from = out.all.length;
  const ack = send('session.start', { session_id: S, remaining_ms: 3_600_000, buzzer: true });
  const kinds = out.all.slice(from).map((m) => m.kind);
  assert.deepEqual(kinds, ['relay', 'state', 'ack', 'command']);
  const relay = out.all.slice(from).find((m) => m.kind === 'relay');
  assert.deepEqual([relay.on, relay.cmd_id, relay.type], [true, ack.cmd_id, 'session.start']);
  assert.equal(ack.state_seq, out.states.at(-1).state.state_seq);
  // Повторный start при горящем свете — без relay (свет уже горел).
  send('session.start', { session_id: S, remaining_ms: 600_000, buzzer: true });
  assert.equal(out.all.filter((m) => m.kind === 'relay').length, 1);
  machine.stop();
});

test('износ NVS: сессия на час — одна запись остатка в минуту', () => {
  const { clock, nvs, send, machine } = rig();
  send('session.start', { session_id: S, remaining_ms: 3_600_000, buzzer: true });
  const before = nvs.writes;
  clock.advance(3_600_000 + 120_000);
  const writes = nvs.writes - before;
  // 60 контрольных записей + начало льготы + удаление в конце; на событиях при связи записей нет.
  assert.ok(writes <= 63, `записей ${writes}`);
  assert.equal(nvs.get(NVS_KEYS.session), undefined);
  assert.equal(SESSION_SAVE_MS, 60_000);
  assert.equal(BOOT_WAIT_MS, 30_000);
  machine.stop();
});

test('срок в прошлом после config.set срабатывает сейчас, а не задним числом', () => {
  const { clock, faults, out, send, machine } = rig();
  faults.bypass = true;
  machine.sensorChanged();
  clock.advance(5000);
  send('config.set', { current_confirm_ms: 1000 });
  clock.advance(0);
  const ev = out.events.find((e) => e.type === 'bypass_detected');
  assert.ok(ev, 'событие есть');
  assert.equal(ev.at_uptime_ms, 5000);
  machine.stop();
});

test('льгота без света в обход не принимается за lamp_fault при приглушении', () => {
  const { clock, out, send, machine } = rig({ caps: ['relay', 'led', 'buzzer', 'current', 'dimmer'] });
  send('config.set', { grace_dim: 0 });
  send('session.start', { session_id: S, remaining_ms: 1000, grace_ms: 600_000, buzzer: true });
  clock.advance(1000 + 120_000);
  assert.equal(machine.snapshot().mode, 'grace');
  assert.equal(machine.snapshot().current_ma, 0);
  assert.ok(!out.events.some((e) => e.type === 'lamp_fault'));
  machine.stop();
});

test('state.free в окне ожидания стирает сессию из NVS; ping окно не закрывает', () => {
  const nvs = new MemoryNvs();
  const a = rig({ nvs });
  a.send('session.start', { session_id: S, remaining_ms: 600_000, buzzer: true });
  a.clock.advance(60_000);
  a.machine.stop();
  const b = new TableMachine({ deviceKey: Buffer.from(TEST_KEY_B64, 'base64'), clock: a.clock, nvs, output: () => {} });
  b.start();
  assert.equal(b.bootWaiting, true);
  b.handleCommand(Buffer.from(signed(makeCommand({ seq: 2, type: 'ping' }))));
  assert.equal(b.bootWaiting, true, 'ping — не ответ о состоянии');
  b.handleCommand(Buffer.from(signed(makeCommand({ seq: 3, type: 'ota.start', body: { url: 'https://x.ru/f.bin', version: '1', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', image_sig: 'AA==' } }))));
  assert.equal(b.snapshot().last_seq, 3);
  b.handleCommand(Buffer.from(signed(makeCommand({ seq: 4, type: 'state.free' }))));
  assert.equal(b.bootWaiting, false);
  assert.equal(nvs.get(NVS_KEYS.session), undefined);
  a.clock.advance(BOOT_WAIT_MS);
  assert.equal(b.snapshot().mode, 'free');
  b.stop();
});
