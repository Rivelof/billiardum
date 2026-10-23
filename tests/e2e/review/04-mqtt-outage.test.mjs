// Ревью (mqtt): обрыв связи сервера с брокером. Mosquitto не перезапускается и сеть сервера не
// трогается: связь сервера рвёт брокер — тест входит учёткой сервера с его закреплённым client id
// (bl-server), брокер отключает живой сервер (перехват сессии MQTT). Тест держит перехват
// E2E_REVIEW_MQTT_HOLD_MS (8 с), заново входя при каждом переподключении сервера, затем уходит.
//
// Стол E2E_REVIEW_MQTT_TABLE (по умолчанию 5): гость играет; во время обрыва оплачивает продление
// (+3 мин). Ожидаемо: сервер пишет mqtt_disconnected, неподтверждённые команды — abandoned,
// поставленные за обрыв — superseded (не уходят устаревшими); после переподключения
// (mqtt_connected reconnect) столу уходит актуальное состояние — остаток по новому paid_until;
// у каждой отправленной команды есть device.cmd.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { connectMqtt, env } from '../m0/helpers.mjs';
import { adminClient, cmdsWithAudit, containerLog, DEV, extendGame, MIN, ok, api, SERVER_CONTAINER, session, sleep, startGame, waitFor, waitSim, waitTableFree } from '../m3/helpers.mjs';

const T = Number(process.env.E2E_REVIEW_MQTT_TABLE || 5);
const HOLD_MS = Number(process.env.E2E_REVIEW_MQTT_HOLD_MS || 8000);
let db;

before(async () => {
  db = await adminClient();
  await waitTableFree(T);
});

after(async () => {
  await db?.end();
});

/** Держать связь сервера с брокером разорванной holdMs: входить с его client id, пока не истечёт срок. */
async function holdServerOff(holdMs) {
  const until = Date.now() + holdMs;
  let takeovers = 0;
  while (Date.now() < until) {
    let c;
    try {
      c = await connectMqtt({ clientId: 'bl-server', username: env('MQTT_SERVER_USER'), password: env('MQTT_SERVER_PASSWORD') });
    } catch {
      await sleep(200);
      continue;
    }
    takeovers += 1;
    await new Promise((resolve) => {
      const left = Math.max(0, until - Date.now());
      const timer = setTimeout(resolve, left);
      c.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await c.endAsync(true).catch(() => {});
  }
  return takeovers;
}

test(`обрыв сервера с брокером: команды не уходят устаревшими, после связи — актуальное состояние (стол ${T})`, { timeout: 10 * MIN }, async (t) => {
  const game = await startGame(T, 5);
  await waitSim(T, (x) => x.state.relay === true && x.state.session_id === game.sessionId, { timeoutMs: 5000 });
  const s0 = await session(game.guest.token, game.sessionId);
  const since = new Date();
  const holding = holdServerOff(HOLD_MS);
  await sleep(500);
  const ext = await extendGame(game.guest, game.tbl.resource.id, game.sessionId, 3);
  const takeovers = await holding;
  const s1 = await waitFor(async () => {
    const x = await session(game.guest.token, game.sessionId);
    return new Date(x.paid_until) > new Date(s0.paid_until) ? x : null;
  }, { timeoutMs: 15_000, what: 'продление записано' });
  const reconnected = await waitFor(() => containerLog(SERVER_CONTAINER, { since }).find((l) => l.msg === 'mqtt_connected' && l.reconnect === true) ?? null, {
    timeoutMs: 30_000,
    what: 'сервер переподключился',
  });
  const expected = () => new Date(s1.paid_until) - Date.now();
  const lit = await waitSim(T, (x) => x.state.relay === true && Math.abs(x.state.remaining_ms - expected()) < 3000, { timeoutMs: 20_000, what: 'контроллер получил новый остаток' });
  const logs = containerLog(SERVER_CONTAINER, { since }).filter((l) => ['mqtt_disconnected', 'mqtt_connected', 'cmd_abandoned', 'mqtt_outgoing_purged'].includes(l.msg) || (l.msg === 'cmd_ack' && l.device_id === DEV(T)));
  const { cmds, missing } = await cmdsWithAudit(db, T, since);
  t.diagnostic(`перехватов ${takeovers}; продление +3 мин (${ext.q.amount_kopecks} коп.) оплачено в обрыв; переподключение в ${reconnected.t}; контроллер: остаток ${Math.round(lit.state.remaining_ms / 1000)} с (ожидали ${Math.round(expected() / 1000)})`);
  t.diagnostic(`лог сервера: ${logs.map((l) => `${l.msg}${l.type ? `:${l.type}` : ''}${l.reconnect !== undefined ? `(reconnect=${l.reconnect})` : ''}`).join(', ')}`);
  t.diagnostic(`команды стола: ${cmds.map((c) => `${c.type}:${c.status}`).join(', ')}; без журнала ${missing.length}`);
  assert.ok(logs.some((l) => l.msg === 'mqtt_disconnected'), 'сервер заметил обрыв');
  assert.deepEqual(missing, []);
  assert.ok(cmds.some((c) => c.status === 'acked' && ['session.resume', 'session.extend'].includes(c.type)), 'после связи — актуальное состояние');
  assert.ok(!cmds.some((c) => c.status === 'queued'), 'в очереди ничего не зависло');
  await ok(api('POST', `/api/sessions/${game.sessionId}/stop`, { token: game.guest.token }));
  await waitSim(T, (x) => x.state.relay === false, { timeoutMs: 10_000 });
});
