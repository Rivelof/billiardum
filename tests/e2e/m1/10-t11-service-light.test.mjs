// T11. Ресепшн включает сервисный свет: без причины нельзя; с причиной — свет на время,
// запись в журнале, уведомление владельцу (инвариант 8).
//
// Ресепшн (+70000000004): без reason_code/reason_text — reason_required; неизвестный код —
// bad_request; больше service_max_minutes (30) — limit_exceeded; гость — 403. С причиной на 2 мин:
// симулятор service, purple, свет, остаток ≈ 2 мин; журнал service.start с текстом причины в reason;
// тревога service_light и уведомление владельцу; стол для гостей — service (котировка
// table_service). «Выключить» — service.stop, свет гаснет, запись в журнале.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { adminClient, api, brief, CLUB_A, newGuest, ok, PHONES, quote, staff, table, waitFor, waitSim, waitTableFree } from './helpers.mjs';

const TABLE = Number(process.env.E2E_T11_TABLE || 5);
let db;
let rec;
let rid;
let on = false;

before(async () => {
  db = await adminClient();
  await waitTableFree(TABLE);
  rec = await staff('reception');
  rid = (await table(TABLE)).resource.id;
});

after(async () => {
  if (on) await api('POST', `/api/resources/${rid}/service/stop`, { token: rec.token, body: {} });
  await db?.end();
});

test(`T11: стол ${TABLE} — сервисный свет без причины нельзя`, async (t) => {
  const cases = [
    ['без причины', { minutes: 2 }],
    ['только код', { minutes: 2, reason_code: 'cleaning' }],
    ['пустой текст', { minutes: 2, reason_code: 'cleaning', reason_text: '   ' }],
    ['только текст', { minutes: 2, reason_text: 'уборка' }],
    ['неизвестный код', { minutes: 2, reason_code: 'free_game', reason_text: 'друг' }],
    ['больше 30 минут', { minutes: 31, reason_code: 'cleaning', reason_text: 'уборка' }],
  ];
  for (const [name, body] of cases) {
    const r = await api('POST', `/api/resources/${rid}/service`, { token: rec.token, body });
    t.diagnostic(`${name} → HTTP ${r.status} ${r.text}`);
    assert.ok(r.status >= 400, name);
  }
  const g = await newGuest();
  const rg = await api('POST', `/api/resources/${rid}/service`, { token: g.token, body: { minutes: 2, reason_code: 'cleaning', reason_text: 'уборка' } });
  t.diagnostic(`гость → HTTP ${rg.status} ${rg.text}`);
  assert.ok([401, 403].includes(rg.status));
  const st = await (await fetch(`http://127.0.0.1:18080/sim/tables/${TABLE}`)).json();
  assert.equal(st.state.relay, false, 'свет не включился');
  const bad = await api('POST', `/api/resources/${rid}/service`, { token: rec.token, body: { minutes: 2 } });
  assert.equal(bad.json?.error, 'reason_required');
});

test(`T11: с причиной — свет на 2 мин, журнал, тревога и уведомление владельцу`, { timeout: 60_000 }, async (t) => {
  const since = new Date();
  const reasonText = 'Протираем сукно после пролитого чая (e2e)';
  const r = await ok(api('POST', `/api/resources/${rid}/service`, { token: rec.token, body: { minutes: 2, reason_code: 'cleaning', reason_text: reasonText } }));
  on = true;
  const x = await waitSim(TABLE, (y) => y.state.mode === 'service' && y.state.relay === true, { timeoutMs: 5000, intervalMs: 50 });
  t.diagnostic(`ответ ${JSON.stringify(r)}; симулятор: ${brief(x)}`);
  assert.equal(x.state.led, 'purple');
  assert.ok(Math.abs(x.state.remaining_ms - (new Date(r.until) - Date.now())) < 3000 && x.state.remaining_ms <= 120_000, 'свет на время');

  const tbl = await table(TABLE);
  const g = await newGuest();
  const q = await quote(g.token, { resourceId: rid, minutes: 60 });
  t.diagnostic(`стол для гостя: status=${tbl.status}; котировка → HTTP ${q.status} ${q.text}`);
  assert.equal(tbl.status, 'service');
  assert.equal(q.json?.error, 'table_service');

  const { rows: au } = await db.query("select action, actor_type, actor_id, reason, data from bl.audit_log where club_id = $1 and created_at >= $2 and action in ('service.start', 'alarm.raised', 'device.cmd') order by seq", [CLUB_A, since]);
  const start = au.find((a) => a.action === 'service.start');
  t.diagnostic(`журнал: ${au.map((a) => `${a.action}${a.data?.type ? `(${a.data.type})` : ''}`).join(', ')}; service.start: reason «${start?.reason}», data ${JSON.stringify(start?.data)}`);
  assert.ok(start, 'service.start в журнале');
  assert.equal(start.reason, reasonText);
  assert.equal(start.data.reason_code, 'cleaning');
  assert.equal(start.actor_id, rec.user.id, 'действие записано на сотрудника');
  assert.ok(au.some((a) => a.action === 'device.cmd' && a.data.type === 'service.start'));

  const owner = await staff('owner');
  const alarm = await waitFor(
    async () => (await ok(api('GET', `/api/clubs/${CLUB_A}/alarms?state=open`, { token: owner.token }))).find((a) => a.type === 'service_light' && a.resource_number === TABLE && new Date(a.last_raised_at) >= since),
    { timeoutMs: 5000, what: 'тревога service_light' },
  );
  const { rows: notes } = await db.query(
    'select n.kind, n.level, n.status, n.text, n.created_at from bl.notifications n join bl.users u on u.id = n.user_id where u.phone = $1 and n.created_at >= $2 order by n.created_at',
    [PHONES.owner, since],
  );
  t.diagnostic(`тревога: ${JSON.stringify({ type: alarm.type, level: alarm.level, text: alarm.text, data: alarm.data })}; уведомления владельцу: ${notes.map((n) => `${n.kind}/${n.level}[${n.status}] «${n.text}»`).join('; ')}`);
  assert.ok(notes.length >= 1, 'уведомление владельцу');
});

test('T11: «Выключить сервисный свет» — свет гаснет, запись в журнале', async (t) => {
  const since = new Date();
  await ok(api('POST', `/api/resources/${rid}/service/stop`, { token: rec.token, body: {} }));
  on = false;
  const x = await waitSim(TABLE, (y) => y.state.mode === 'free' && y.state.relay === false, { timeoutMs: 5000 });
  const { rows } = await db.query("select action, reason from bl.audit_log where club_id = $1 and created_at >= $2 and action = 'service.stop'", [CLUB_A, since]);
  t.diagnostic(`симулятор: ${brief(x)}; журнал: ${JSON.stringify(rows)}`);
  assert.equal(rows.length, 1);
});
