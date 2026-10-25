// Критерий 7: протокол на живом стеке и журнал.
// * Независимая канонизация и подпись (helpers.mjs) проходят docs/protocol-vectors.json.
// * Команда сервера на проводе подписана ключом устройства из devices.json.
// * У каждой команды на проводе есть запись device.cmd в bl.audit_log (с тем же cmd_id и seq),
//   и каждая новая запись device.cmd ушла на провод: число записей = число отправленных команд.
// * По каждому устройству: seq в журнале без повторов, последний = devices.last_seq = last_seq в state.
// * audit_verify по клубу — ok; хеши цепочки пересчитаны в Node по формуле supabase/README.md.
//
// Команду вызывает сам сервер: стол 8 на мгновение отключается (вход его учёткой и сразу
// выход), сервер видит offline → online и шлёт ping (актуальное состояние, M0). В cmd пишет
// только сервер — тест в cmd ничего не публикует.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import {
  adminClient,
  appClient,
  CLUB_A,
  connectMqtt,
  connectObserver,
  containerLog,
  loadDevices,
  repoPath,
  SERVER_CONTAINER,
  setContext,
  signCommand,
  sleep,
  subscribeEach,
  topic,
  verifySig,
  waitAllOnline,
  waitFor,
} from './helpers.mjs';

const devices = loadDevices();
const byId = new Map(devices.map((d) => [d.device_id, d]));
const D8 = devices.find((d) => d.table_number === 8);

let observer;
let admin;

before(async () => {
  admin = await adminClient();
  observer = await connectObserver();
  const g = await subscribeEach(observer.client, ['bl/v1/#']);
  assert.equal(g['bl/v1/#'], 1);
  await sleep(1500);
});

after(async () => {
  await observer?.client.endAsync();
  await admin?.end();
});

test('канонизация и подпись теста проходят все векторы protocol-vectors.json (ok и bad_sig)', (t) => {
  const { vectors } = JSON.parse(readFileSync(repoPath('docs/protocol-vectors.json'), 'utf8'));
  let ok = 0;
  let badSig = 0;
  for (const v of vectors) {
    if (v.expect !== 'ok' && v.expect !== 'bad_sig') continue;
    const cmd = JSON.parse(v.raw);
    const { canonical, sig } = signCommand(cmd, v.key_b64);
    assert.equal(canonical, v.canonical, `${v.name}: каноническая строка`);
    if (v.expect === 'ok') {
      assert.equal(sig, v.sig ?? cmd.sig, `${v.name}: подпись`);
      assert.equal(verifySig(cmd, v.key_b64), true, v.name);
      ok += 1;
    } else {
      assert.equal(verifySig(cmd, v.key_b64), false, v.name);
      badSig += 1;
    }
  }
  t.diagnostic(`векторов ok: ${ok}, bad_sig: ${badSig} (из ${vectors.length})`);
  assert.ok(ok > 0 && badSig > 0);
});

async function journalCmds() {
  const { rows } = await admin.query(
    `select seq::int as chain_seq, object_id::text as device_id, data->>'cmd_id' as cmd_id,
            (data->>'seq')::bigint as seq, data->>'type' as type, actor_type, created_at
       from bl.audit_log where club_id = $1 and action = 'device.cmd' order by seq`,
    [CLUB_A],
  );
  return rows.map((r) => ({ ...r, seq: Number(r.seq) }));
}

test('живая команда: подписана ключом из devices.json, у каждой команды на проводе — запись device.cmd и наоборот', async (t) => {
  const head0 = Number((await admin.query('select coalesce(max(seq), 0) as s from bl.audit_log where club_id = $1', [CLUB_A])).rows[0].s);
  const before = await journalCmds();
  const mark = observer.messages.length;
  const t0 = Date.now();
  const since = new Date(t0 - 1000);

  // Мгновенное отключение стола 8: вход его учёткой (брокер закрывает сессию симулятора,
  // Last Will offline) и сразу штатный выход. Симулятор переподключится через 3 с.
  const kick = await connectMqtt({ clientId: D8.device_id, username: D8.mqtt_username, password: D8.mqtt_password });
  await kick.endAsync();

  const cmdTopic8 = topic(D8.club_id, D8.device_id, 'cmd');
  const wireCmd = await waitFor(() => observer.messages.find((m, i) => i >= mark && m.topic === cmdTopic8), {
    timeoutMs: 30_000,
    what: 'команда сервера столу 8',
  });
  const cmd8 = JSON.parse(wireCmd.payload);
  await waitFor(
    () => observer.messages.find((m, i) => i >= mark && m.topic === topic(D8.club_id, D8.device_id, 'ack') && m.payload.includes(cmd8.id)),
    { timeoutMs: 20_000, what: 'ack стола 8' },
  );
  const recovered = await waitAllOnline(since, devices.length, { timeoutMs: 75_000 }); // с M5.8 — 10 (столы и корты)
  await sleep(3500); // повторы без ack (3 с) успели бы прийти

  const window = observer.messages.slice(mark).filter((m) => m.topic.endsWith('/cmd'));
  const wire = new Map();
  for (const m of window) {
    const c = JSON.parse(m.payload);
    const deviceId = m.topic.split('/')[3];
    const prev = wire.get(c.id);
    if (prev) assert.equal(prev.raw, m.payload, 'повтор команды не байт в байт');
    else wire.set(c.id, { cmd: c, deviceId, raw: m.payload });
  }
  const after = await journalCmds();
  const added = after.filter((r) => r.chain_seq > head0);
  const journalById = new Map(after.map((r) => [r.cmd_id, r]));

  t.diagnostic(`стол 8: команда на проводе ${JSON.stringify({ id: cmd8.id, seq: cmd8.seq, type: cmd8.type, issued_at: cmd8.issued_at })}`);
  t.diagnostic(`сообщений в cmd за окно: ${window.length}, разных команд: ${wire.size}; новых записей device.cmd: ${added.length} (было ${before.length}, стало ${after.length})`);
  t.diagnostic(`восстановление: ${JSON.stringify(recovered)}`);

  // Каждая команда на проводе — подписана ключом устройства и есть в журнале.
  for (const { cmd, deviceId } of wire.values()) {
    const dev = byId.get(deviceId);
    assert.ok(dev, `команда неизвестному устройству ${deviceId}`);
    assert.equal(verifySig(cmd, dev.device_key), true, `подпись команды ${cmd.id} не сходится с ключом из devices.json`);
    assert.equal(verifySig({ ...cmd, seq: cmd.seq + 1 }, dev.device_key), false, 'подпись не зависит от seq');
    const rec = journalById.get(cmd.id);
    assert.ok(rec, `команды ${cmd.id} (${deviceId}, seq ${cmd.seq}) нет в журнале`);
    assert.equal(rec.device_id, deviceId);
    assert.equal(rec.seq, cmd.seq);
    assert.equal(rec.type, cmd.type);
    assert.equal(rec.actor_type, 'system');
    // Запись журнала сделана до публикации (публикация после коммита).
    assert.ok(Date.parse(rec.created_at) <= window.find((m) => m.payload.includes(cmd.id)).at + 50);
  }
  // Каждая новая запись device.cmd ушла на провод.
  for (const r of added) assert.ok(wire.has(r.cmd_id), `запись device.cmd ${r.cmd_id} без команды на проводе`);
  assert.equal(added.length, [...wire.keys()].filter((id) => journalById.get(id).chain_seq > head0).length);
  assert.ok(wire.has(cmd8.id));
  assert.equal(cmd8.type, 'ping');
  assert.deepEqual(cmd8.body, {});
  assert.ok(Math.abs(cmd8.issued_at - Math.floor(t0 / 1000)) < 60, 'issued_at — секунды Unix по часам сервера');

  // Сервер получил ack именно этой команды.
  const acks = containerLog(SERVER_CONTAINER, { since }).filter((l) => l.msg === 'cmd_ack' && l.device_id === D8.device_id);
  t.diagnostic(`лог сервера: ${JSON.stringify(acks.at(-1))}`);
  assert.ok(acks.some((l) => l.seq === cmd8.seq && l.ok === true));
});

test('журнал по каждому устройству: seq без повторов и пропусков, последний = devices.last_seq = state.last_seq', async (t) => {
  const cmds = await journalCmds();
  const { rows: devRows } = await admin.query('select id::text, last_seq::int from bl.devices where club_id = $1 order by id', [CLUB_A]);
  const { rows: syncRows } = await admin.query(
    `select object_id::text as device_id, (data->>'from')::int as "from", (data->>'to')::int as "to"
       from bl.audit_log where club_id = $1 and action = 'device.seq_sync'`,
    [CLUB_A],
  );
  // Последний retained state каждого стола (симулятор публикует его после ack).
  const states = new Map();
  for (const m of observer.messages) {
    if (m.topic.endsWith('/state')) {
      try {
        states.set(m.topic.split('/')[3], JSON.parse(m.payload));
      } catch {
        // не JSON — не от симулятора
      }
    }
  }
  const acks = containerLog(SERVER_CONTAINER).filter((l) => l.msg === 'cmd_ack');
  let total = 0;
  for (const d of devRows) {
    const seqs = cmds.filter((c) => c.device_id === d.id).map((c) => c.seq);
    const skipped = syncRows.filter((s) => s.device_id === d.id).reduce((n, s) => n + (s.to - s.from), 0);
    total += seqs.length;
    const st = states.get(d.id);
    t.diagnostic(
      `${d.id.slice(-2)}: device.cmd ${seqs.length} (seq ${seqs[0]}…${seqs.at(-1)}), last_seq ${d.last_seq}, seq_sync +${skipped}, state.last_seq ${st?.last_seq}`,
    );
    assert.equal(new Set(seqs).size, seqs.length, `${d.id}: повтор seq в журнале`);
    assert.deepEqual(seqs, seqs.slice().sort((a, b) => a - b), `${d.id}: seq в цепочке не по возрастанию`);
    assert.equal(seqs.at(-1), d.last_seq, `${d.id}: последний seq журнала ≠ devices.last_seq`);
    assert.equal(seqs.length + skipped, d.last_seq, `${d.id}: число команд в журнале ≠ числу выделенных seq`);
    if (st) assert.equal(st.last_seq, d.last_seq, `${d.id}: контроллер принял не все команды`);
    // Каждый cmd_ack в логе сервера — команда из журнала.
    for (const a of acks.filter((x) => x.device_id === d.id)) {
      assert.ok(seqs.includes(a.seq), `${d.id}: cmd_ack seq ${a.seq} без записи в журнале`);
    }
  }
  t.diagnostic(`всего device.cmd: ${total}; cmd_ack в логе сервера: ${acks.length}`);
});

test('audit_verify(клуб) — ok; цепочка пересчитана в Node по формуле', async (t) => {
  const { rows: v } = await admin.query('select * from bl.audit_verify($1)', [CLUB_A]);
  t.diagnostic(`audit_verify (supabase_admin): ${JSON.stringify(v[0])}`);
  assert.equal(v[0].ok, true);
  assert.equal(v[0].first_bad_seq, null);
  assert.equal(Number(v[0].checked), Number(v[0].head_seq));

  const app = await appClient();
  try {
    await app.query('begin');
    await setContext(app, CLUB_A);
    const { rows: va } = await app.query('select * from bl.audit_verify($1)', [CLUB_A]);
    await app.query('rollback');
    t.diagnostic(`audit_verify (app_api, контекст клуба): ok=${va[0].ok}, checked=${va[0].checked}`);
    assert.equal(va[0].ok, true);
  } finally {
    await app.end();
  }
  const { rows: vp } = await admin.query('select * from bl.audit_verify(null)');
  t.diagnostic(`audit_verify (цепочка платформы): ${JSON.stringify(vp[0])}`);
  assert.equal(vp[0].ok, true);

  // Независимый пересчёт: hash = sha256(prev_hash || canonical), canonical — текст jsonb-массива.
  const { rows } = await admin.query(
    `select id::text, club_id::text, seq::text as seq_text, (extract(epoch from created_at) * 1000000)::bigint::text as us,
            actor_type, actor_id::text, action, object_type, object_id::text, reason, data::text as data, prev_hash, hash
       from bl.audit_log a where club_id = $1 order by a.seq`,
    [CLUB_A],
  );
  const s = (x) => (x === null ? 'null' : JSON.stringify(x));
  let prev = '0'.repeat(64);
  for (const r of rows) {
    const canonical = `[${['"bl.audit.v1"', s(r.id), s(r.club_id), r.seq_text, r.us, s(r.actor_type), s(r.actor_id), s(r.action), s(r.object_type), s(r.object_id), s(r.reason), r.data ?? 'null'].join(', ')}]`;
    assert.equal(r.prev_hash, prev, `запись ${r.seq_text}: prev_hash не равен хешу предыдущей`);
    const h = createHash('sha256').update(prev + canonical, 'utf8').digest('hex');
    assert.equal(h, r.hash, `запись ${r.seq_text}: хеш не пересчитывается`);
    prev = r.hash;
  }
  t.diagnostic(`пересчитано в Node: ${rows.length} записей, голова ${prev.slice(0, 16)}… = head_hash ${String(v[0].head_hash).slice(0, 16)}…`);
  assert.equal(rows.length, Number(v[0].checked));
  assert.equal(prev, v[0].head_hash, 'голова цепочки в Node ≠ head_hash из audit_verify');
});
