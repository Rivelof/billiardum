// T10. Ток при выключенном реле (свет в обход) → bypass_detected, тревога владельцу сразу.
//
// Свободный стол, симулятор: режим bypass (380 мА при выключенном реле). Через current_confirm_ms
// (10 с) контроллер шлёт bypass_detected и переходит в fault. Сервер: событие в bl.device_events
// и журнале, тревога bypass_detected critical (GET /api/clubs/{club}/alarms?state=open),
// alarm.raised в журнале, уведомление владельцу в bl.notifications (со статусом доставки).
// «Сразу» — от события у сервера до тревоги и уведомления < 2 с. В конце режим снимается.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { adminClient, api, brief, CLUB_A, ok, PHONES, simPost, staff, waitFor, waitSim, waitTableFree } from './helpers.mjs';

const TABLE = Number(process.env.E2E_T10_TABLE || 5);
let db;
let faultOn = false;

before(async () => {
  db = await adminClient();
  await waitTableFree(TABLE);
});

after(async () => {
  if (faultOn) await simPost(TABLE, 'fault', { name: 'bypass', on: false });
  await db?.end();
});

test(`T10: стол ${TABLE} — ток при выключенном реле → bypass_detected, тревога владельцу`, { timeout: 2 * 60_000 }, async (t) => {
  const owner = await staff('owner');
  // Повтор открытой тревоги того же типа по столу только увеличивает счётчик (server/alarms):
  // для чистого прогона владелец сначала подтверждает старую тревогу bypass_detected этого стола.
  const open = (await ok(api('GET', `/api/clubs/${CLUB_A}/alarms?state=open`, { token: owner.token }))).filter((a) => a.type === 'bypass_detected' && a.resource_number === TABLE);
  for (const a of open) await ok(api('POST', `/api/alarms/${a.id}/ack`, { token: owner.token, body: {} }));
  if (open.length) t.diagnostic(`подтверждены старые тревоги bypass_detected стола: ${open.length}`);
  const since = new Date();
  const r = await simPost(TABLE, 'fault', { name: 'bypass', on: true });
  faultOn = true;
  t.diagnostic(`bypass включён: ${brief(r.json.table)} current_ma=${r.json.table.state.current_ma}`);
  const fault = await waitSim(TABLE, (x) => x.state.mode === 'fault', { timeoutMs: 20_000, intervalMs: 200, what: 'fault' });
  const tFault = Date.now();
  t.diagnostic(`контроллер через ${((tFault - since) / 1000).toFixed(1)} с: ${brief(fault)} current_ma=${fault.state.current_ma}`);
  assert.equal(fault.state.relay, false);

  const ev = await waitFor(
    async () => (await db.query("select received_at, data from bl.device_events where device_id = $1 and type = 'bypass_detected' and received_at >= $2", [fault.device_id, since])).rows[0],
    { timeoutMs: 10_000, what: 'bypass_detected у сервера' },
  );
  const alarm = await waitFor(
    async () => {
      const list = await ok(api('GET', `/api/clubs/${CLUB_A}/alarms?state=open`, { token: owner.token }));
      return list.find((a) => a.type === 'bypass_detected' && a.resource_number === TABLE && new Date(a.last_raised_at) >= since);
    },
    { timeoutMs: 10_000, intervalMs: 200, what: 'тревога в API владельца' },
  );
  const dt = new Date(alarm.last_raised_at) - new Date(ev.received_at);
  t.diagnostic(`событие у сервера ${new Date(ev.received_at).toISOString()} (${JSON.stringify(ev.data)}); тревога: ${JSON.stringify({ type: alarm.type, level: alarm.level, state: alarm.state, count: alarm.count, text: alarm.text })}, через ${dt} мс после события`);
  assert.equal(alarm.level, 'critical');
  assert.ok(dt < 2000, 'тревога сразу');

  const { rows: au } = await db.query("select action, data from bl.audit_log where club_id = $1 and created_at >= $2 and (action = 'alarm.raised' and data->>'type' = 'bypass_detected' or action = 'device.event' and data->>'type' = 'bypass_detected')", [CLUB_A, since]);
  t.diagnostic(`журнал: ${au.map((a) => `${a.action}(${a.data.type})`).join(', ')}`);
  assert.ok(au.some((a) => a.action === 'device.event'));
  assert.ok(au.some((a) => a.action === 'alarm.raised'));

  const { rows: notes } = await db.query(
    `select n.kind, n.level, n.status, n.channel, n.text, n.created_at from bl.notifications n join bl.users u on u.id = n.user_id
      where u.phone = $1 and n.created_at >= $2 order by n.created_at`,
    [PHONES.owner, since],
  );
  t.diagnostic(`уведомления владельцу: ${notes.map((n) => `${n.kind}/${n.level}[${n.status}${n.channel ? `:${n.channel}` : ''}] «${n.text}» через ${new Date(n.created_at) - new Date(ev.received_at)} мс`).join('; ')}`);
  const n = notes.find((x) => x.kind === 'alarm' && x.level === 'critical' && x.text.includes(`Стол ${TABLE}`));
  assert.ok(n, 'уведомление владельцу о свете в обход');
  assert.ok(new Date(n.created_at) - new Date(ev.received_at) < 2000, 'уведомление сразу');

  await simPost(TABLE, 'fault', { name: 'bypass', on: false });
  faultOn = false;
  const back = await waitSim(TABLE, (x) => x.state.mode === 'free', { timeoutMs: 20_000, what: 'стол снова free' });
  t.diagnostic(`режим снят: ${brief(back)}`);
});
