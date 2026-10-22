// Проверка WebSocket моста ККТ через Caddy (`npm run ci -- --config`, контракт M2, decisions №77).
//
// Во временной сети Docker: заглушка сервера (alias server, порт 3000, те же таймауты
// HTTP, что у server/index.mjs) и caddy с deploy/dev/Caddyfile. Клиент — Node 22 со
// встроенным WebSocket в сетевом пространстве caddy, как мост на ПК ресепшена:
// wss://localhost/api/kkt/ws, доверие — корень внутреннего CA Caddy (NODE_EXTRA_CA_CERTS).
//
// Проверяет: GET без Upgrade доходит до сервера; 101 и заголовки Upgrade, Connection,
// X-Forwarded-Proto, Authorization (токен моста), нет Origin; первый кадр сервера приходит без запроса клиента (без буфера);
// эхо 3 МБ — больше лимита тела 1 МБ у /api/*; после простоя оба направления живы.
//
//   node scripts/ci-caddy-ws.mjs              — простой 2 с (CI)
//   node scripts/ci-caddy-ws.mjs --idle 330   — простой дольше idle_timeout Caddy (5 мин)
//
// Внутри контейнеров тот же файл: `upstream` — заглушка сервера, `client` — проверки.

import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { capture, fail, isMain, makeLogger, ROOT, run, runMain } from './dev-lib.mjs';

const log = makeLogger('caddy-ws');
export const WS_PATH = '/api/kkt/ws';
const CA_PATH = '/data/caddy/pki/authorities/local/root.crt';

// --- Заглушка сервера (в контейнере) ---

function frame(text) {
  const p = Buffer.from(text);
  let h;
  if (p.length < 126) h = Buffer.from([0x81, p.length]);
  else if (p.length < 65536) {
    h = Buffer.alloc(4);
    h[0] = 0x81;
    h[1] = 126;
    h.writeUInt16BE(p.length, 2);
  } else {
    h = Buffer.alloc(10);
    h[0] = 0x81;
    h[1] = 127;
    h.writeBigUInt64BE(BigInt(p.length), 2);
  }
  return Buffer.concat([h, p]);
}

/** Минимальный сервер WebSocket: приветствие сразу после 101, эхо текста, push после простоя. */
function upstream(idleS) {
  const srv = http.createServer((req, res) => {
    res.writeHead(426, { 'content-type': 'application/json' });
    res.end('{"error":"upgrade_required"}');
  });
  srv.headersTimeout = 20_000;
  srv.requestTimeout = 30_000;
  srv.on('upgrade', (req, sock, head) => {
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const seen = {
      path: req.url,
      upgrade: req.headers.upgrade,
      connection: req.headers.connection,
      version: req.headers['sec-websocket-version'],
      proto: req.headers['x-forwarded-proto'],
      xff: Boolean(req.headers['x-forwarded-for']),
      auth: req.headers.authorization === 'Bearer ci-check-token',
      origin: req.headers.origin ?? null,
    };
    sock.write(frame(JSON.stringify({ hello: true, seen })));
    const t0 = Date.now();
    const push = setTimeout(() => sock.write(frame(JSON.stringify({ push: Math.round((Date.now() - t0) / 1000) }))), (idleS + 3) * 1000);
    let buf = Buffer.from(head ?? []);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const masked = (buf[1] & 0x80) !== 0;
        const mask = masked ? buf.subarray(off, off + 4) : null;
        if (masked) off += 4;
        if (buf.length < off + len) return;
        const p = Buffer.from(buf.subarray(off, off + len));
        buf = buf.subarray(off + len);
        if (mask) for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
        if (op === 8) {
          sock.end(Buffer.from([0x88, 0]));
          return;
        }
        if (op === 1) sock.write(frame(p.toString()));
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      clearTimeout(push);
      console.log(`upstream: соединение закрыто через ${Math.round((Date.now() - t0) / 1000)} с`);
    });
  });
  srv.listen(3000, () => console.log('upstream: слушаю 3000'));
}

// --- Клиент (в контейнере, в сети caddy) ---

async function client(idleS) {
  const check = (ok, what) => {
    if (!ok) throw new Error(what);
    console.log(`ok: ${what}`);
  };
  const res = await fetch(`https://localhost${WS_PATH}`);
  check(res.status === 426, `GET без Upgrade доходит до сервера (${res.status})`);

  // Токен моста — в заголовке Authorization, как у tools/kkt-bridge (WebSocket Node 22 с headers).
  const ws = new WebSocket(`wss://localhost${WS_PATH}`, { headers: { authorization: 'Bearer ci-check-token' } });
  const queue = [];
  let waiter = null;
  ws.onmessage = (e) => {
    if (waiter) waiter(e.data);
    else queue.push(e.data);
  };
  const next = (ms) =>
    new Promise((resolve, reject) => {
      if (queue.length > 0) return resolve(queue.shift());
      const t = setTimeout(() => {
        waiter = null;
        reject(new Error(`нет кадра за ${ms} мс`));
      }, ms);
      waiter = (d) => {
        clearTimeout(t);
        waiter = null;
        resolve(d);
      };
    });
  let closed = null;
  ws.onclose = (e) => {
    closed = e.code;
  };
  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('WebSocket не открылся'));
  });
  const hello = JSON.parse(await next(2000));
  const ms = Date.now() - t0;
  check(ms < 1000, `101 и первый кадр сервера без запроса клиента за ${ms} мс (без буфера)`);
  const s = hello.seen;
  check(
    s.path === WS_PATH && s.upgrade === 'websocket' && /upgrade/i.test(s.connection) && s.version === '13',
    `сервер получил Upgrade: ${s.upgrade}, Connection: ${s.connection}, Sec-WebSocket-Version: ${s.version}`,
  );
  check(s.proto === 'https' && s.xff, 'сервер получил X-Forwarded-Proto https и X-Forwarded-For');
  check(s.auth, 'сервер получил Authorization: Bearer … (токен моста)');
  // server/kkt отклоняет WebSocket с Origin (мост — не страница браузера).
  check(s.origin === null, 'без заголовка Origin: WebSocket Node 22 его не шлёт, Caddy не добавляет');

  const chunk = 'x'.repeat(128 * 1024);
  let back = 0;
  for (let i = 0; i < 24; i++) {
    ws.send(chunk);
    back += (await next(5000)).length;
  }
  check(back === 24 * chunk.length, 'эхо 3 МБ (больше лимита тела 1 МБ у /api/*)');

  await sleep(idleS * 1000);
  check(closed === null, `простой ${idleS} с: соединение открыто`);
  ws.send('after-idle');
  check((await next(5000)) === 'after-idle', 'после простоя: клиент → сервер → клиент');
  const push = JSON.parse(await next(10_000));
  check(typeof push.push === 'number', `после простоя: сервер → клиент без запроса (через ${push.push} с)`);
  ws.close(1000);
}

// --- Оркестровка (на хосте) ---

/** Запускает проверку во временной сети Docker; ошибка — UserError с логами контейнеров. */
export async function checkCaddyWebSocket({ caddyImage, nodeImage, idleS = 2 }) {
  const id = randomBytes(4).toString('hex');
  const net = `bl-ci-ws-${id}`;
  const up = `bl-ci-ws-up-${id}`;
  const caddy = `bl-ci-ws-caddy-${id}`;
  const scripts = join(ROOT, 'scripts');
  const caddyfile = join(ROOT, 'deploy', 'dev', 'Caddyfile');
  const dir = mkdtempSync(join(tmpdir(), 'bl-ci-ws-'));
  const docker = (args, what) => {
    const r = capture('docker', args);
    if (r.code !== 0) fail(`${what}: ${(r.stderr || r.stdout).trim().split('\n').at(-1)}`);
    return r.stdout.trim();
  };
  const label = ['--label', 'com.billiardum.ci=1'];
  try {
    docker(['network', 'create', ...label, net], 'сеть Docker');
    docker(
      ['run', '-d', '--name', up, ...label, '--network', net, '--network-alias', 'server', '-v', `${scripts}:/t:ro`, nodeImage,
        'node', '/t/ci-caddy-ws.mjs', 'upstream', String(idleS)],
      'заглушка сервера',
    );
    docker(['run', '-d', '--name', caddy, ...label, '--network', net, '-v', `${caddyfile}:/etc/caddy/Caddyfile:ro`, caddyImage], 'caddy');
    // Корень внутреннего CA Caddy создаётся при первом старте.
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      ready = capture('docker', ['exec', caddy, 'test', '-f', CA_PATH]).code === 0;
      if (!ready) await sleep(1000);
    }
    if (!ready) fail('caddy не создал корень внутреннего CA за 60 с');
    docker(['cp', `${caddy}:${CA_PATH}`, join(dir, 'root.crt')], 'корень CA Caddy');
    const code = await run('docker', [
      'run', '--rm', ...label, '--network', `container:${caddy}`,
      '-e', 'NODE_EXTRA_CA_CERTS=/ca/root.crt', '-v', `${dir}:/ca:ro`, '-v', `${scripts}:/t:ro`, nodeImage,
      'node', '/t/ci-caddy-ws.mjs', 'client', String(idleS),
    ]);
    if (code !== 0) {
      await run('docker', ['logs', '--tail', '20', caddy]);
      await run('docker', ['logs', '--tail', '20', up]);
      fail(`WebSocket ${WS_PATH} через Caddy: проверка не прошла (код ${code})`);
    }
  } finally {
    capture('docker', ['rm', '-f', up, caddy]);
    capture('docker', ['network', 'rm', net]);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const [mode, arg] = process.argv.slice(2);
  if (mode === 'client') {
    await client(Number(arg) || 2);
    console.log('client: всё прошло');
    return 0;
  }
  let idleS = 2;
  if (mode === '--idle' && /^\d+$/.test(arg ?? '')) idleS = Number(arg);
  else if (mode !== undefined) fail('параметры: без них или --idle <секунды>');
  const { CADDY_IMAGE, NODE_IMAGE } = await import('./ci.mjs');
  log(`${CADDY_IMAGE}, ${NODE_IMAGE}: WebSocket ${WS_PATH}, простой ${idleS} с`);
  await checkCaddyWebSocket({ caddyImage: CADDY_IMAGE, nodeImage: NODE_IMAGE, idleS });
  log('WebSocket через Caddy: всё прошло');
  return 0;
}

if (isMain(import.meta.url)) {
  // Заглушка сервера работает, пока контейнер не удалят; остальное — через runMain.
  if (process.argv[2] === 'upstream') upstream(Number(process.argv[3]) || 2);
  else runMain('caddy-ws', main);
}
