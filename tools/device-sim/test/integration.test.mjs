// Симулятор с настоящим брокером. Без брокера пропускается: npm test остаётся зелёным без Docker.
// Брокер, пароли, ACL и TLS готовит scripts/integration.mjs (npm run test:it).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import mqtt from 'mqtt';
import { makeCommand, signed, testSig } from './helpers/sign.mjs';

const env = process.env;
const URL_ = env.SIM_IT_MQTT_URL;
const INDEX = fileURLToPath(new URL('../index.mjs', import.meta.url));

if (!URL_) {
  test('интеграция с брокером', { skip: 'нет брокера: npm run test:it -w tools/device-sim (нужен Docker)' }, () => {});
} else {
  describe('симулятор и брокер Mosquitto', () => {
    const file = JSON.parse(readFileSync(env.SIM_IT_DEVICES_FILE, 'utf8'));
    const [dev1, dev2] = file.devices;
    const ca = env.SIM_IT_CA_FILE ? readFileSync(env.SIM_IT_CA_FILE) : undefined;
    const topic = (d, leaf) => `bl/v1/${d.club_id}/${d.device_id}/${leaf}`;
    const messages = [];
    const logs = [];
    let observer;
    let sim;
    let simExited;

    const on = (d, leaf) => messages.filter((m) => m.topic === topic(d, leaf));
    async function waitFor(fn, what, ms = 8000) {
      const until = Date.now() + ms;
      for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() > until) throw new Error(`не дождались: ${what}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    const connectObserver = () => mqtt.connectAsync(URL_, {
      clientId: `bl-sim-it-${process.pid}-${Math.random().toString(16).slice(2, 8)}`,
      username: env.SIM_IT_OBSERVER_USER,
      password: env.SIM_IT_OBSERVER_PASSWORD,
      protocolVersion: 4,
      reconnectPeriod: 0,
      ...(ca ? { ca } : {}),
    });

    async function command(d, cmd, raw) {
      const acksBefore = on(d, 'ack').length;
      await observer.publishAsync(topic(d, 'cmd'), raw ?? signed(cmd, d.device_key), { qos: 1 });
      const msg = await waitFor(() => on(d, 'ack')[acksBefore], `ack на ${cmd?.type ?? 'команду'}`);
      return { raw: msg.payload, ack: JSON.parse(msg.payload) };
    }

    before(async () => {
      observer = await connectObserver();
      observer.on('message', (t, payload, packet) => messages.push({ topic: t, payload: payload.toString(), retain: packet.retain }));
      await observer.subscribeAsync('bl/v1/#', { qos: 1 });
      await new Promise((r) => setTimeout(r, 200));
      messages.length = 0;

      sim = spawn(process.execPath, [INDEX], {
        env: { ...env, SIM_DEVICES_FILE: env.SIM_IT_DEVICES_FILE, LOG_LEVEL: 'debug', MQTT_URL: '', MQTT_CA_FILE: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      simExited = new Promise((r) => sim.on('exit', r));
      let buf = '';
      sim.stdout.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) if (line) logs.push(line);
      });
      sim.stderr.on('data', (chunk) => logs.push(`STDERR ${chunk}`));
    });

    after(async () => {
      if (sim && sim.exitCode === null) sim.kill('SIGKILL');
      await observer?.endAsync();
    });

    test('оба стола: online (retained), state и событие boot', async () => {
      for (const d of [dev1, dev2]) {
        await waitFor(() => on(d, 'status').find((m) => m.payload === 'online'), `online ${d.table_number}`);
        const st = await waitFor(() => on(d, 'state')[0], `state ${d.table_number}`);
        const state = JSON.parse(st.payload);
        assert.equal(state.v, 1);
        assert.equal(state.mode, 'free');
        assert.equal(state.relay, false);
        assert.equal(state.led, 'green_dim');
        assert.equal(state.boot, 1);
        assert.ok(Array.isArray(state.caps) && state.caps.includes('relay'));
        assert.equal(typeof state.fw, 'string');
        assert.equal(state.last_seq, 0);
        const ev = JSON.parse((await waitFor(() => on(d, 'event')[0], `boot ${d.table_number}`)).payload);
        assert.deepEqual([ev.v, ev.boot, ev.n, ev.type], [1, 1, 1, 'boot']);
        assert.deepEqual(Object.keys(ev.data).sort(), ['caps', 'fw', 'reset_reason']);
      }
      const sub = await connectObserver();
      const retained = [];
      sub.on('message', (t, p, packet) => packet.retain && retained.push(t));
      await sub.subscribeAsync(`bl/v1/${dev1.club_id}/+/+`, { qos: 1 });
      await waitFor(() => retained.includes(topic(dev1, 'status')) && retained.includes(topic(dev1, 'state')), 'retained status и state');
      await sub.endAsync();
    });

    test('лог: строки JSON, sim_state по контракту §7', async () => {
      await waitFor(() => logs.some((l) => l.includes('"sim_state"') && l.includes(dev2.device_id)), 'sim_state');
      for (const line of logs) assert.doesNotThrow(() => JSON.parse(line), line);
      const st = JSON.parse(logs.find((l) => l.includes('"sim_state"') && l.includes(dev1.device_id)));
      assert.equal(st.level, 'info');
      assert.equal(st.table, dev1.table_number);
      assert.deepEqual([st.mode, st.relay, st.led], ['free', false, 'green_dim']);
      assert.ok(!Number.isNaN(Date.parse(st.t)));
    });

    let pingRaw;
    let pingAck;
    test('ping: ack ok и state с тем же state_seq', async () => {
      const statesBefore = on(dev1, 'state').length;
      const cmd = makeCommand({ seq: 1, type: 'ping' });
      pingRaw = signed(cmd, dev1.device_key);
      const { raw, ack } = await command(dev1, cmd, pingRaw);
      pingAck = raw;
      assert.deepEqual([ack.cmd_id, ack.seq, ack.ok, ack.error], [cmd.id, 1, true, null]);
      const st = await waitFor(() => on(dev1, 'state')[statesBefore], 'state после ping');
      assert.equal(JSON.parse(st.payload).state_seq, ack.state_seq);
      assert.equal(JSON.parse(st.payload).last_seq, 1);
    });

    test('точный повтор: тот же ack, без исполнения', async () => {
      const statesBefore = on(dev1, 'state').length;
      const { raw } = await command(dev1, null, pingRaw);
      assert.equal(raw, pingAck);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(on(dev1, 'state').length, statesBefore, 'повтор ping не публикует state');
    });

    test('тот же seq с другим id: replayed_seq и событие', async () => {
      const cmd = makeCommand({ seq: 1, type: 'ping' });
      const { ack } = await command(dev1, cmd);
      assert.deepEqual([ack.cmd_id, ack.ok, ack.error], [cmd.id, false, 'replayed_seq']);
      const ev = await waitFor(() => on(dev1, 'event').map((m) => JSON.parse(m.payload)).find((e) => e.type === 'replayed_seq'), 'событие replayed_seq');
      assert.deepEqual([ev.boot, ev.n, ev.data], [1, 2, { cmd_id: cmd.id, seq: 1 }]);
    });

    test('подпись чужим ключом: bad_sig и событие, seq не сдвигается', async () => {
      const cmd = makeCommand({ seq: 2, type: 'ping' });
      const { ack } = await command(dev1, cmd, signed(cmd, dev2.device_key));
      assert.deepEqual([ack.ok, ack.error], [false, 'bad_sig']);
      await waitFor(() => on(dev1, 'event').some((m) => JSON.parse(m.payload).type === 'bad_sig'), 'событие bad_sig');
      const raw = JSON.stringify({ ...cmd, sig: testSig(cmd, dev1.device_key) });
      assert.equal((await command(dev1, cmd, raw)).ack.ok, true, 'seq 2 с верной подписью принимается');
    });

    test('identify: индикатор identify и возврат; остальные типы — unknown_type', async () => {
      const cmd = makeCommand({ seq: 3, type: 'identify', body: { duration_ms: 700 } });
      assert.equal((await command(dev1, cmd)).ack.ok, true);
      await waitFor(() => on(dev1, 'state').some((m) => JSON.parse(m.payload).led === 'identify'), 'led identify');
      await waitFor(() => JSON.parse(on(dev1, 'state').at(-1).payload).led === 'green_dim', 'led снова green_dim', 4000);
      const start = makeCommand({ seq: 4, type: 'session.start', body: { session_id: '0192f3c0-0000-7000-8000-000000000001', remaining_ms: 60000, buzzer: true } });
      assert.deepEqual(Object.values((await command(dev1, start)).ack).slice(3, 5), [false, 'unknown_type']);
    });

    test('bad_format: ack без cmd_id; второй стол команд не видел', async () => {
      const { ack } = await command(dev1, null, '{"v":1,"id":');
      assert.deepEqual([ack.cmd_id, ack.seq, ack.ok, ack.error], [null, null, false, 'bad_format']);
      assert.equal(on(dev2, 'ack').length, 0);
    });

    test('устройство пишет только в свои топики (ACL как у Dynamic Security)', () => {
      const allowed = new Set([dev1, dev2].flatMap((d) => ['cmd', 'ack', 'state', 'event', 'status'].map((l) => topic(d, l))));
      for (const m of messages) assert.ok(allowed.has(m.topic), m.topic);
      assert.ok(!logs.some((l) => /mqtt_subscribe_failed|mqtt_publish_failed|STDERR/.test(l)), 'ошибок MQTT в логе нет');
    });

    test('в логе нет секретов', () => {
      const text = logs.join('\n');
      for (const d of [dev1, dev2]) {
        assert.ok(!text.includes(d.mqtt_password), 'пароль MQTT в логе');
        assert.ok(!text.includes(d.device_key), 'device_key в логе');
      }
      assert.ok(!text.includes(JSON.parse(pingRaw).sig), 'подпись в логе');
    });

    if (ca) {
      test('TLS: без нашего CA брокер не принимается', async () => {
        await assert.rejects(mqtt.connectAsync(URL_, {
          username: env.SIM_IT_OBSERVER_USER, password: env.SIM_IT_OBSERVER_PASSWORD, reconnectPeriod: 0, connectTimeout: 3000,
        }), /certificate|self.signed|unable to verify/i);
      });
    }

    test('обрыв связи (процесс убит): брокер публикует Last Will offline, retained', async () => {
      const before = { 1: on(dev1, 'status').length, 2: on(dev2, 'status').length };
      sim.kill('SIGKILL');
      await simExited;
      for (const [d, n] of [[dev1, before[1]], [dev2, before[2]]]) {
        const m = await waitFor(() => on(d, 'status').slice(n).find((x) => x.payload === 'offline'), `offline ${d.table_number}`);
        assert.equal(m.payload, 'offline');
      }
      const sub = await connectObserver();
      const got = new Map();
      sub.on('message', (t, p, packet) => packet.retain && got.set(t, p.toString()));
      await sub.subscribeAsync(topic(dev1, 'status'), { qos: 1 });
      await waitFor(() => got.get(topic(dev1, 'status')) === 'offline', 'retained offline');
      await sub.endAsync();
    });

    test('штатная остановка (SIGTERM): симулятор сам публикует offline и выходит с кодом 0', async () => {
      const n = on(dev1, 'status').length;
      const again = spawn(process.execPath, [INDEX], {
        env: { ...env, SIM_DEVICES_FILE: env.SIM_IT_DEVICES_FILE, SIM_TABLES: String(dev1.table_number), MQTT_URL: '', MQTT_CA_FILE: '' },
        stdio: 'ignore',
      });
      const exited = new Promise((r) => again.on('exit', r));
      await waitFor(() => on(dev1, 'status').slice(n).some((m) => m.payload === 'online'), 'online после перезапуска');
      const m = on(dev1, 'status').length;
      again.kill('SIGTERM');
      assert.equal(await exited, 0);
      await waitFor(() => on(dev1, 'status').slice(m).some((x) => x.payload === 'offline'), 'offline при штатной остановке');
    });
  });
}
