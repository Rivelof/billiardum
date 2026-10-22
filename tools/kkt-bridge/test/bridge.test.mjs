// Мост ККТ на эмуляторе АТОЛ и тестовом сервере WebSocket: задание → чек, повтор и обрыв
// (идемпотентность по UUID — один чек на один receipt_id), выключенная ККТ, журнал моста,
// состояние ККТ, настройки.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { WebSocketServer } from 'ws';
import { createBridge, parseFiscal } from '../lib/bridge.mjs';
import { ConfigError, loadConfig, parseConfig, stripBom } from '../lib/config.mjs';
import { createAtolEmulator } from '../emu/emulator.mjs';

const TOKEN = 'A'.repeat(20) + 'b'.repeat(20) + '0123456789_-abcdefghijklmnopqr';

const sellTask = (total = 500) => ({
  type: 'sell',
  electronically: false,
  operator: { name: 'Кассир' },
  items: [{ type: 'position', name: 'Кофе', price: total, quantity: 1, amount: total, tax: { type: 'none' }, paymentMethod: 'fullPayment', paymentObject: 'commodity' }],
  payments: [{ type: 'cash', sum: total }],
  total,
});

/** Тестовый сервер: принимает мост с токеном, шлёт задания, собирает сообщения. */
function createFakeServer() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const state = { sockets: [], messages: [], auth: [], autoAck: true, waiters: [] };
  wss.on('connection', (ws, req) => {
    state.auth.push(req.headers.authorization ?? null);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      ws.close(4003, 'token');
      return;
    }
    state.sockets.push(ws);
    ws.send(JSON.stringify({ type: 'welcome', bridge_id: 'b1', club_id: 'c1', ping_ms: 1000 }));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      state.messages.push(msg);
      if (msg.type === 'result' && state.autoAck && msg.outcome !== 'in_progress') ws.send(JSON.stringify({ type: 'ack', uuid: msg.uuid }));
      for (const w of [...state.waiters]) {
        if (w.match(msg)) {
          state.waiters.splice(state.waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    });
  });
  return {
    state,
    get url() {
      return `ws://127.0.0.1:${wss.address().port}/api/kkt/ws`;
    },
    live: () => state.sockets.filter((s) => s.readyState === 1),
    send(msg) {
      for (const s of state.sockets) if (s.readyState === 1) s.send(JSON.stringify(msg));
    },
    job(uuid, request = [sellTask()], kind = 'receipt') {
      this.send({ type: 'job', job_id: uuid, kind, uuid, request });
    },
    wait(match, timeoutMs = 5000) {
      const hit = state.messages.find(match);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        state.waiters.push(w);
        setTimeout(() => {
          const i = state.waiters.indexOf(w);
          if (i >= 0) {
            state.waiters.splice(i, 1);
            reject(new Error('fake server: не дождались сообщения'));
          }
        }, timeoutMs);
      });
    },
    kickAll() {
      for (const s of state.sockets) s.terminate();
    },
    close: () => new Promise((resolve) => {
      for (const s of state.sockets) s.terminate();
      wss.close(() => resolve());
    }),
  };
}

async function waitFor(fn, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor: не дождались');
    await new Promise((r) => setTimeout(r, 20));
  }
}

let emu;
let server;
let dir;
const bridges = [];

function bridgeConfig(overrides = {}) {
  return parseConfig(
    {
      server_url: server.url,
      token: TOKEN,
      atol_url: emu.url,
      name: 'Ресепшн',
      data_dir: dir,
      job_timeout_ms: 1500,
      poll_ms: 20,
      status_poll_ms: 100,
      reconnect_min_ms: 30,
      reconnect_max_ms: 200,
      ...overrides,
    },
    { env: {} },
  );
}

function startBridge(overrides) {
  const b = createBridge({ config: bridgeConfig(overrides) });
  bridges.push(b);
  b.start();
  return b;
}

before(async () => {
  emu = createAtolEmulator({ recoverMs: 50 });
  await emu.listen(0);
});
after(async () => {
  await emu.close();
});
beforeEach(async () => {
  emu.control.reset();
  server = createFakeServer();
  await new Promise((r) => setTimeout(r, 10));
  dir = mkdtempSync(join(tmpdir(), 'kkt-bridge-test-'));
});
afterEach(async () => {
  for (const b of bridges.splice(0)) await b.stop();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('мост ККТ: задания', () => {
  it('исходящее соединение с Bearer-токеном; hello; задание → чек на ККТ, результат с ФД и ФП, ack', async () => {
    startBridge();
    const hello = await server.wait((m) => m.type === 'hello');
    assert.equal(hello.name, 'Ресепшн');
    assert.equal(server.state.auth[0], `Bearer ${TOKEN}`);
    const uuid = randomUUID();
    server.job(uuid);
    const r = await server.wait((m) => m.type === 'result' && m.uuid === uuid);
    assert.equal(r.outcome, 'done');
    assert.equal(r.task_created, true);
    assert.equal(r.fiscal.fd, 2);
    assert.match(r.fiscal.fp, /^\d{10}$/);
    assert.match(r.fiscal.fn, /^\d{16}$/);
    assert.equal(r.fiscal.receipt_number, 1);
    assert.equal(r.fiscal.partial, false);
    assert.equal(emu.control.state().receipts, 1);
  });

  it('повтор того же UUID (после пробития) — тот же результат, второго чека нет', async () => {
    startBridge();
    await server.wait((m) => m.type === 'hello');
    const uuid = randomUUID();
    server.job(uuid);
    const first = await server.wait((m) => m.type === 'result' && m.uuid === uuid);
    server.state.messages.length = 0;
    server.job(uuid);
    server.job(uuid);
    const second = await server.wait((m) => m.type === 'result' && m.uuid === uuid);
    assert.equal(second.fiscal.fd, first.fiscal.fd);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(emu.control.state().receipts, 1, 'один чек на один UUID');
    assert.equal(emu.control.state().stats.posts, 1, 'задание в АТОЛ отправлено один раз');
  });

  it('обрыв связи с сервером во время печати: после переподключения — результат, чек один', async () => {
    emu.control.delay(400);
    server.state.autoAck = false;
    startBridge();
    await server.wait((m) => m.type === 'hello');
    const uuid = randomUUID();
    server.job(uuid);
    await waitFor(() => emu.control.state().stats.posts === 1);
    server.kickAll();
    await waitFor(() => server.live().length === 1 && server.state.messages.filter((m) => m.type === 'hello').length === 2);
    // Сервер после переподключения повторяет задание — мост его не пробивает заново.
    server.job(uuid);
    const r = await server.wait((m) => m.type === 'result' && m.uuid === uuid);
    assert.equal(r.outcome, 'done');
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(emu.control.state().receipts, 1);
    assert.equal(emu.control.state().stats.posts, 1);
  });

  it('результат без ack досылается после переподключения (журнал моста)', async () => {
    server.state.autoAck = false;
    startBridge();
    await server.wait((m) => m.type === 'hello');
    const uuid = randomUUID();
    server.job(uuid);
    await server.wait((m) => m.type === 'result' && m.uuid === uuid);
    server.state.messages.length = 0;
    server.kickAll();
    const again = await server.wait((m) => m.type === 'result' && m.uuid === uuid);
    assert.equal(again.outcome, 'done');
    server.send({ type: 'ack', uuid });
    await new Promise((r) => setTimeout(r, 50));
    server.state.messages.length = 0;
    server.kickAll();
    await server.wait((m) => m.type === 'hello');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(server.state.messages.filter((m) => m.type === 'result').length, 0, 'подтверждённый результат не досылается');
  });

  it('ККТ выключена (АТОЛ не принимает задание): error kkt_offline, task_created=false; после включения тот же UUID пробивается', async () => {
    emu.control.power(false, 'reject');
    startBridge();
    await server.wait((m) => m.type === 'hello');
    const uuid = randomUUID();
    server.job(uuid);
    const r1 = await server.wait((m) => m.type === 'result' && m.uuid === uuid);
    assert.equal(r1.outcome, 'error');
    assert.equal(r1.error.code, 'kkt_offline');
    assert.equal(r1.error.category, 'connection');
    assert.equal(r1.task_created, false);
    emu.control.power(true);
    server.state.messages.length = 0;
    server.job(uuid);
    const r2 = await server.wait((m) => m.type === 'result' && m.uuid === uuid);
    assert.equal(r2.outcome, 'done');
    assert.equal(emu.control.state().receipts, 1);
  });

  it('ККТ без связи во время задания: error atol_2 (connection), task_created=true', async () => {
    emu.control.power(false, 'error');
    startBridge();
    await server.wait((m) => m.type === 'hello');
    const uuid = randomUUID();
    server.job(uuid);
    const r = await server.wait((m) => m.type === 'result' && m.uuid === uuid);
    assert.equal(r.outcome, 'error');
    assert.equal(r.error.code, 'atol_2');
    assert.equal(r.error.category, 'connection');
    assert.equal(r.task_created, true);
  });

  it('ККТ ждёт (выключена, задание в очереди): in_progress по таймауту, затем done', async () => {
    emu.control.power(false, 'wait');
    startBridge({ job_timeout_ms: 200 });
    await server.wait((m) => m.type === 'hello');
    const uuid = randomUUID();
    server.job(uuid);
    const r1 = await server.wait((m) => m.type === 'result' && m.uuid === uuid);
    assert.equal(r1.outcome, 'in_progress');
    emu.control.power(true);
    server.state.messages.length = 0;
    server.job(uuid);
    const r2 = await server.wait((m) => m.type === 'result' && m.uuid === uuid);
    assert.equal(r2.outcome, 'done');
    assert.equal(emu.control.state().receipts, 1);
  });

  it('АТОЛ забыл отправленное задание: исход unknown (atol_task_lost), второй чек не пробивается', async () => {
    emu.control.delay(300);
    startBridge();
    await server.wait((m) => m.type === 'hello');
    const uuid = randomUUID();
    server.job(uuid);
    await server.wait((m) => m.type === 'result' && m.uuid === uuid);
    emu.control.reset();
    server.state.messages.length = 0;
    server.job(uuid);
    const r = await server.wait((m) => m.type === 'result' && m.uuid === uuid);
    assert.equal(r.outcome, 'unknown');
    assert.equal(r.error.code, 'atol_task_lost');
    assert.equal(emu.control.state().stats.posts, 0);
  });

  it('АТОЛ забыл задание сразу после постановки: unknown без ожидания таймаута, чек не повторяется', async () => {
    emu.control.delay(200);
    emu.control.fault('forget_request', 1);
    startBridge({ job_timeout_ms: 30000 });
    await server.wait((m) => m.type === 'hello');
    const uuid = randomUUID();
    server.job(uuid);
    const r = await server.wait((m) => m.type === 'result' && m.uuid === uuid, 3000);
    assert.equal(r.outcome, 'unknown');
    assert.equal(r.error.code, 'atol_task_lost');
    assert.equal(emu.control.state().stats.posts, 1);
    assert.equal(emu.control.state().receipts, 1);
  });

  it('перезапуск моста: журнал на диске помнит UUID, новое задание не ставится второй раз', async () => {
    emu.control.delay(500);
    const b1 = startBridge();
    await server.wait((m) => m.type === 'hello');
    const uuid = randomUUID();
    server.job(uuid);
    await waitFor(() => emu.control.state().stats.posts === 1);
    await b1.stop();
    bridges.splice(bridges.indexOf(b1), 1);
    server.state.messages.length = 0;
    startBridge();
    await server.wait((m) => m.type === 'hello');
    server.job(uuid);
    const r = await server.wait((m) => m.type === 'result' && m.uuid === uuid && m.outcome === 'done');
    assert.equal(r.fiscal.fd, 2);
    assert.equal(emu.control.state().stats.posts, 1);
    assert.equal(emu.control.state().receipts, 1);
  });

  it('смена ККТ: open_shift уже открыта — skipped; close_shift — done с ФД', async () => {
    startBridge();
    await server.wait((m) => m.type === 'hello');
    const u1 = randomUUID();
    server.job(u1, [{ type: 'openShift', operator: { name: 'Кассир' } }], 'open_shift');
    assert.equal((await server.wait((m) => m.type === 'result' && m.uuid === u1)).outcome, 'done');
    const u2 = randomUUID();
    server.job(u2, [{ type: 'openShift', operator: { name: 'Кассир' } }], 'open_shift');
    const r2 = await server.wait((m) => m.type === 'result' && m.uuid === u2);
    assert.equal(r2.outcome, 'skipped');
    assert.equal(r2.shift.state, 'opened');
    const u3 = randomUUID();
    server.job(u3, [{ type: 'closeShift', operator: { name: 'Кассир' } }], 'close_shift');
    const r3 = await server.wait((m) => m.type === 'result' && m.uuid === u3);
    assert.equal(r3.outcome, 'done');
    assert.ok(r3.fiscal.fd > 0);
  });

  it('смена ККТ дольше 24 часов: ошибка чека с категорией shift_expired', async () => {
    emu.control.expireShift();
    startBridge();
    await server.wait((m) => m.type === 'hello');
    const uuid = randomUUID();
    server.job(uuid);
    const r = await server.wait((m) => m.type === 'result' && m.uuid === uuid);
    assert.equal(r.outcome, 'error');
    assert.equal(r.error.category, 'shift_expired');
  });

  it('состояние ККТ: выключили — status online=false, включили — online=true', async () => {
    startBridge();
    await server.wait((m) => m.type === 'status' && m.kkt.online === true);
    emu.control.power(false, 'reject');
    await server.wait((m) => m.type === 'status' && m.kkt.online === false);
    emu.control.power(true);
    server.state.messages.length = 0;
    await server.wait((m) => m.type === 'status' && m.kkt.online === true);
  });

  it('неверный токен — сервер закрывает 4003, мост переподключается с паузой', async () => {
    const b = createBridge({ config: { ...bridgeConfig(), token: 'x'.repeat(64) } });
    bridges.push(b);
    b.start();
    await waitFor(() => server.state.auth.length >= 2);
    assert.equal(server.state.auth[0], `Bearer ${'x'.repeat(64)}`);
  });
});

describe('мост ККТ: процесс', () => {
  it('сервер закрыл соединение 1001 и пропал — процесс моста жив и переподключается к новому серверу', async () => {
    const first = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => first.once('listening', r));
    const port = first.address().port;
    const hellos = [];
    const onConn = (srv) => srv.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'welcome', bridge_id: 'b1', club_id: 'c1', ping_ms: 60000 }));
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'hello') hellos.push({ srv, ws });
      });
    });
    onConn(first);
    const cfgDir = mkdtempSync(join(tmpdir(), 'kkt-bridge-proc-'));
    writeFileSync(join(cfgDir, 'kkt-bridge.json'), JSON.stringify({
      server_url: `ws://127.0.0.1:${port}/api/kkt/ws`, token: TOKEN, atol_url: emu.url,
      status_poll_ms: 600000, reconnect_min_ms: 50, reconnect_max_ms: 200,
    }));
    const child = spawn(process.execPath, [fileURLToPath(new URL('../index.mjs', import.meta.url)), '--config', join(cfgDir, 'kkt-bridge.json')], { stdio: 'pipe' });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    let exited = null;
    child.on('exit', (code) => {
      exited = code;
    });
    try {
      await waitFor(() => hellos.length === 1);
      // Сервер останавливается: 1001, порт закрыт; переподключения падают (1006) — процесс должен жить.
      hellos[0].ws.close(1001, 'server stopping');
      await new Promise((r) => first.close(r));
      await new Promise((r) => setTimeout(r, 700));
      assert.equal(exited, null, 'процесс моста не завершился');
      const second = new WebSocketServer({ port, host: '127.0.0.1' });
      onConn(second);
      await waitFor(() => hellos.length === 2, 5000).catch((err) => {
        throw new Error(`${err.message}: ${out.slice(-1500)}`);
      });
      assert.equal(hellos[1].srv, second);
      assert.equal(exited, null);
      for (const c of second.clients) c.terminate();
      await new Promise((r) => second.close(r));
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => (exited !== null ? r() : child.on('exit', r)));
      rmSync(cfgDir, { recursive: true, force: true });
    }
    assert.equal(exited, 0, 'по сигналу — код 0');
  });
});

describe('мост ККТ: разбор и настройки', () => {
  it('parseFiscal: ФД обязателен, ФП и ФН — если есть; частичный результат помечен', () => {
    assert.equal(parseFiscal({}), null);
    assert.equal(parseFiscal({ fiscalParams: { fiscalDocumentNumber: 0 } }), null);
    const p = parseFiscal({ fiscalParams: { fiscalDocumentNumber: 7 } });
    assert.deepEqual([p.fd, p.fp, p.partial], [7, null, true]);
    const f = parseFiscal({ fiscalParams: { fiscalDocumentNumber: 8, fiscalDocumentSign: 429279302, fnNumber: '9999078900005419', shiftNumber: 2 } });
    assert.deepEqual([f.fd, f.fp, f.fn, f.shift_number, f.partial], [8, '429279302', '9999078900005419', 2, false]);
  });

  it('настройки: wss обязателен (ws — только localhost), токен проверяется, BOM снимается', () => {
    const base = { token: TOKEN, atol_url: 'http://127.0.0.1:16732' };
    assert.throws(() => parseConfig({ ...base, server_url: 'ws://bl.example.ru/api/kkt/ws' }, { env: {} }), ConfigError);
    assert.throws(() => parseConfig({ ...base, server_url: 'https://bl.example.ru/api/kkt/ws' }, { env: {} }), ConfigError);
    assert.ok(parseConfig({ ...base, server_url: 'wss://bl.example.ru/api/kkt/ws' }, { env: {} }));
    assert.ok(parseConfig({ ...base, server_url: 'ws://localhost:3000/api/kkt/ws' }, { env: {} }));
    assert.throws(() => parseConfig({ ...base, server_url: 'wss://bl.example.ru/x', token: 'short' }, { env: {} }), /токен/);
    assert.throws(() => parseConfig({ server_url: 'wss://bl.example.ru/x' }, { env: {} }), /нет токена/);
    assert.equal(parseConfig({ server_url: 'wss://h/x' }, { env: { KKT_BRIDGE_TOKEN: TOKEN } }).token, TOKEN);
    assert.equal(stripBom('\uFEFF{}'), '{}');
    const file = join(dir, 'bom.json');
    writeFileSync(file, `\uFEFF${JSON.stringify({ server_url: 'wss://h/api/kkt/ws', token_file: 'token.txt' })}`);
    writeFileSync(join(dir, 'token.txt'), `\uFEFF${TOKEN}\r\n`);
    const c = loadConfig(file, { env: {} });
    assert.equal(c.token, TOKEN);
    assert.equal(c.dataDir, join(dir, 'kkt-bridge-data'));
  });
});
