// T28 «Защита подключения» (docs/contracts/m5-1.md §5; №67, №154, №159, №161, №162).
//
//   * чужой владелец не привязывает контроллер чужого клуба (ни к своему столу, ни через чужой клуб);
//   * 5 неверных кодов закрывают окно: (а) bind владельца по заводскому реестру — 403 ×5, затем 429;
//     (б) claim контроллера — 403 ×5, затем и верный код 403 (окно закрыто);
//   * секрет магазина нигде не отдаётся целиком (ответы API, журнал, уведомления, лог сервера, база);
//   * боевой магазин с test:true или без фискализации не принимается, ничего не сохраняется;
//   * четвёртый тестовый клуб — clubs_limit;
//   * ресепшн не видит мастер, магазины и чек-лист; управляющий видит мастер без магазинов.
//
// Клуб A — из 01 (E2E_M5_DIR/state.json); клуб B и пользователь с 3 тестовыми клубами создаются здесь.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  capi,
  containerLog,
  loadState,
  loginRetry,
  provisionFactory,
  SERVER_CONTAINER,
  SHOPS,
  short,
  sleep,
  staffPhone,
} from './helpers.mjs';

const st = loadState();
const skip = !st.club || !st.devices ? 'нет клуба из 01 (E2E_M5_DIR/state.json)' : false;
const S = {};
let db;
const T0 = new Date();

before(async () => {
  if (skip) return;
  db = await adminClient();
  S.ownerA = await loginRetry(st.ownerPhone, { consent: false });
  S.rec = await loginRetry(st.recPhone, { consent: false });
  S.ownerB = await loginRetry(staffPhone(), { consent: false });
  const b = await capi('POST', '/api/clubs', { token: S.ownerB.token, body: { name: 'E2E M5 Чужой клуб', city_name: 'Екатеринбург', timezone: 'Asia/Yekaterinburg' } });
  assert.equal(b.status, 201, short(b));
  S.clubB = b.json.club_id;
  const r = await capi('POST', `/api/clubs/${S.clubB}/resources`, { token: S.ownerB.token, club: S.clubB, body: { number: 1, kind: 'pool' } });
  S.resB = r.json.id;
});

after(async () => {
  await db?.end();
});

const B = (method, p, body) => capi(method, p, { token: S.ownerB.token, club: S.clubB, body });

test('T28-1: чужой владелец не привязывает контроллер чужого клуба', { skip }, async (t) => {
  const dev = st.devices[0];
  // (а) контроллер клуба A — к своему столу клуба B.
  const own = await B('POST', `/api/clubs/${S.clubB}/devices/bind`, { qr: dev.qr, resource_id: S.resB });
  // (б) через путь клуба A — не член клуба.
  const foreignPath = await capi('POST', `/api/clubs/${st.club}/devices/bind`, { token: S.ownerB.token, club: st.club, body: { qr: dev.qr, resource_id: st.tables[0].id } });
  // (в) свой клуб в пути, стол клуба A.
  const foreignRes = await B('POST', `/api/clubs/${S.clubB}/devices/bind`, { qr: dev.qr, resource_id: st.tables[0].id });
  // (г) новый заводской контроллер — к столу клуба A через свой клуб.
  const f = provisionFactory(1, `t28a-${Date.now()}`);
  const foreignRes2 = await B('POST', `/api/clubs/${S.clubB}/devices/bind`, { qr: f.devices[0].qr, resource_id: st.tables[1].id });
  const { rows } = await db.query('select club_id, resource_id from bl.devices where id = $1', [dev.device_id]);
  const { rows: win } = await db.query('select count(*)::int as n from bl.device_bind_windows where device_id = any($1::uuid[]) and club_id = $2', [[dev.device_id, f.devices[0].device_id], S.clubB]);
  t.diagnostic(`к своему столу: ${short(own)}; путь клуба A: ${short(foreignPath)}; стол клуба A в своём пути: ${short(foreignRes)}; новый контроллер к столу A: ${short(foreignRes2)}; устройство осталось в клубе A: ${rows[0].club_id === st.club}; окон привязки клуба B: ${win[0].n}`);
  assert.equal(own.status, 403);
  assert.ok([403, 404].includes(foreignPath.status));
  assert.equal(foreignRes.status, 404);
  assert.equal(foreignRes2.status, 404);
  assert.equal(rows[0].club_id, st.club);
  assert.equal(win[0].n, 0);
});

test('T28-2: 5 неверных кодов при привязке владельцем (заводской реестр) — затем 429, и верный код тоже', { skip }, async (t) => {
  const f = provisionFactory(1, `t28b-${Date.now()}`);
  const d = f.devices[0];
  const codes = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await B('POST', `/api/clubs/${S.clubB}/devices/bind`, { device_id: d.device_id, claim_code: `WRONG-CODE-000${i}`, resource_id: S.resB });
    codes.push(r.status);
  }
  const right = await B('POST', `/api/clubs/${S.clubB}/devices/bind`, { qr: d.qr, resource_id: S.resB });
  const { rows } = await db.query('select count(*)::int as n from bl.device_bind_windows where device_id = $1', [d.device_id]);
  t.diagnostic(`неверные: ${codes.join(', ')}; верный после 5 неверных: ${short(right)} (Retry-After ${right.headers['retry-after'] ?? '—'}); окон привязки: ${rows[0].n}`);
  assert.deepEqual(codes, [403, 403, 403, 403, 403]);
  assert.equal(right.status, 429);
  assert.equal(right.json.error, 'rate_limited');
  assert.equal(rows[0].n, 0);
});

test('T28-3: 5 неверных кодов от контроллера (claim) закрывают окно — верный код тоже forbidden', { skip }, async (t) => {
  const f = provisionFactory(1, `t28c-${Date.now()}`);
  const d = f.devices[0];
  const bind = await B('POST', `/api/clubs/${S.clubB}/devices/bind`, { qr: d.qr, resource_id: S.resB });
  assert.equal(bind.status, 200, short(bind));
  const codes = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await api('POST', '/api/devices/claim', { body: { device_id: d.device_id, claim_code: `WRONG-CODE-111${i}` } });
    codes.push(`${r.status}:${r.json?.error}`);
  }
  const right = await api('POST', '/api/devices/claim', { body: { device_id: d.device_id, claim_code: d.claim_code } });
  const { rows } = await db.query('select failed_attempts, closed_at is not null as closed, claimed_at from bl.device_bind_windows where device_id = $1', [d.device_id]);
  const { rows: dev } = await db.query('select count(*)::int as n from bl.devices where id = $1', [d.device_id]);
  t.diagnostic(`неверные claim: ${codes.join(', ')}; верный после них: ${short(right)}; окно ${JSON.stringify(rows[0])}; устройство в bl.devices: ${dev[0].n}`);
  assert.deepEqual(codes.map((c) => c.split(':')[0]), ['403', '403', '403', '403', '403']);
  assert.equal(right.status, 403, 'окно закрыто');
  assert.ok(!right.text.includes('device_key'));
  assert.equal(rows[0].failed_attempts, 5);
  assert.equal(rows[0].closed, true);
  assert.equal(dev[0].n, 0);
  // Новое окно владельцем — и верный код проходит? (код не сгорел — контроллер не получил ключей)
  S.claimDevice = d;
});

test('T28-4: боевой магазин с test:true или без фискализации не принимается, ничего не сохраняется', { skip }, async (t) => {
  const cases = [
    ['live', SHOPS.test, 'shop_mode_mismatch'],
    ['live', SHOPS.liveNoFiscal, 'fiscalization_off'],
    ['test', SHOPS.live, 'shop_mode_mismatch'],
    ['live', { shop_id: SHOPS.live.shop_id, secret_key: 'live_wrong_secret_0000' }, 'shop_invalid'],
    ['live', { shop_id: '800099', secret_key: SHOPS.live.secret_key }, 'shop_invalid'],
  ];
  const out = [];
  for (const [mode, body, code] of cases) {
    const r = await B('PUT', `/api/clubs/${S.clubB}/payment-settings/${mode}`, body);
    out.push(`${mode} ${body.shop_id}: ${r.status} ${r.json?.error}`);
    assert.equal(r.status, 400, short(r));
    assert.equal(r.json.error, code);
  }
  const g = await B('GET', `/api/clubs/${S.clubB}/payment-settings`);
  const { rows } = await db.query('select shop_id, secret_key_enc, test_shop_id, test_secret_key_enc from bl.club_payment_settings where club_id = $1', [S.clubB]);
  t.diagnostic(`${out.join('; ')}; после отказов: ${JSON.stringify(g.json.shops)}; в базе ${JSON.stringify(rows[0])}`);
  assert.equal(g.json.shops.live.shop_id, null);
  assert.equal(g.json.shops.test.shop_id, null);
  assert.equal(rows[0].shop_id, null);
  assert.equal(rows[0].test_shop_id, null);
  const check = await B('POST', `/api/clubs/${S.clubB}/payment-settings/live/check`, {});
  assert.equal(check.status, 409);
  assert.equal(check.json.error, 'not_configured');
});

test('T28-5: секрет магазина нигде не отдаётся целиком', { skip }, async (t) => {
  // Сохранить оба магазина в клубе B и собрать всё, что видно снаружи.
  assert.equal((await B('PUT', `/api/clubs/${S.clubB}/payment-settings/test`, SHOPS.test)).status, 200);
  assert.equal((await B('PUT', `/api/clubs/${S.clubB}/payment-settings/live`, SHOPS.live)).status, 200);
  const keep = await B('PUT', `/api/clubs/${S.clubB}/payment-settings/test`, { shop_id: SHOPS.test.shop_id });
  assert.equal(keep.status, 200, 'без secret_key — прежний ключ той же пары');
  const secrets = [SHOPS.test.secret_key, SHOPS.live.secret_key];
  const views = [
    await B('GET', `/api/clubs/${S.clubB}/payment-settings`),
    await B('GET', `/api/clubs/${S.clubB}/payment-settings/test`),
    await B('GET', `/api/clubs/${S.clubB}/payment-settings/live`),
    await B('GET', `/api/clubs/${S.clubB}/onboarding`),
    keep,
    await capi('GET', `/api/clubs/${st.club}/onboarding`, { token: S.ownerA.token, club: st.club }),
    await capi('GET', `/api/clubs/${st.club}/payment-settings`, { token: S.ownerA.token, club: st.club }),
    await B('GET', `/api/clubs/${S.clubB}/audit?limit=200`),
  ];
  const leaksApi = views.filter((v) => secrets.some((s) => v.text.includes(s)));
  const { rows: au } = await db.query('select count(*)::int as n from bl.audit_log where club_id = any($1::uuid[]) and (data::text like $2 or data::text like $3 or coalesce(reason, \'\') like $2)', [
    [S.clubB, st.club],
    `%${secrets[0]}%`,
    `%${secrets[1]}%`,
  ]);
  const { rows: nt } = await db.query('select count(*)::int as n from bl.notifications where text like $1 or text like $2 or data::text like $1 or data::text like $2', [`%${secrets[0]}%`, `%${secrets[1]}%`]);
  const { rows: dbRow } = await db.query(
    "select (secret_key_enc::text like $2 or test_secret_key_enc::text like $3) as plain, live_me::text as live_me, test_me::text as test_me from bl.club_payment_settings where club_id = $1",
    [S.clubB, `%${secrets[1]}%`, `%${secrets[0]}%`],
  );
  const logs = containerLog(SERVER_CONTAINER, { since: T0 });
  const rawLogs = JSON.stringify(logs);
  const leakLog = secrets.filter((s) => rawLogs.includes(s));
  const mask = views[0].json.shops;
  t.diagnostic(`ответов API проверено ${views.length} — с секретом: ${leaksApi.length}; маски ${JSON.stringify(mask.test.secret_mask)} / ${JSON.stringify(mask.live.secret_mask)}; журнал: ${au[0].n}; уведомления: ${nt[0].n}; в базе открытым текстом: ${dbRow[0].plain}; /v3/me в базе: ${dbRow[0].live_me}; строк лога сервера ${logs.length}, с секретом: ${leakLog.length}`);
  assert.equal(leaksApi.length, 0);
  assert.equal(au[0].n, 0);
  assert.equal(nt[0].n, 0);
  assert.equal(dbRow[0].plain, false);
  assert.equal(leakLog.length, 0);
  assert.deepEqual(mask.test.secret_mask, { last4: 'only', length: SHOPS.test.secret_key.length });
});

test('T28-6: четвёртый тестовый клуб — 409 clubs_limit (у владельца B уже 1)', { skip }, async (t) => {
  const st2 = [];
  for (let i = 2; i <= 4; i += 1) {
    const r = await capi('POST', '/api/clubs', { token: S.ownerB.token, body: { name: `E2E M5 лимит ${i}`, city_name: 'Екатеринбург', timezone: 'Asia/Yekaterinburg' } });
    st2.push(`${i}: ${r.status}${r.json?.error ? ` ${r.json.error}` : ''}`);
    if (i < 4) assert.equal(r.status, 201, short(r));
    else {
      assert.equal(r.status, 409, short(r));
      assert.equal(r.json.error, 'clubs_limit');
    }
  }
  const { rows } = await db.query("select count(*)::int as n from bl.clubs c join bl.club_members m on m.club_id = c.id where m.user_id = $1 and m.role = 'owner' and c.mode = 'test'", [S.ownerB.user.id]);
  // Владелец клуба A (live) может завести новый тестовый — live не считается.
  t.diagnostic(`клубы владельца B: ${st2.join('; ')}; тестовых у него ${rows[0].n}`);
  assert.equal(rows[0].n, 3);
});

test('T28-7: ресепшн не видит мастер, магазины и чек-лист; управляющий — мастер без магазинов', { skip }, async (t) => {
  const C = st.club;
  const R = (method, p, body) => capi(method, p, { token: S.rec.token, club: C, body });
  const probes = [
    ['GET', `/api/clubs/${C}/onboarding`],
    ['GET', `/api/clubs/${C}/payment-settings`],
    ['GET', `/api/clubs/${C}/payment-settings/test`],
    ['GET', `/api/clubs/${C}/payment-settings/live`],
    ['PUT', `/api/clubs/${C}/payment-settings/test`, SHOPS.test],
    ['POST', `/api/clubs/${C}/payment-settings/test/check`, {}],
    ['POST', `/api/clubs/${C}/go-live`, { accept_offer: true }],
    ['GET', `/api/clubs/${C}/resources`],
    ['POST', `/api/clubs/${C}/resources`, { number: 9, kind: 'pool', reason: 'x' }],
    ['PUT', `/api/clubs/${C}/tariffs`, { rules: [], reason: 'x' }],
    ['PUT', `/api/clubs/${C}/hall`, { width: 500, height: 500 }],
    ['POST', `/api/clubs/${C}/staff/invites`, { phone: staffPhone(), role: 'manager' }],
    ['POST', `/api/clubs/${C}/devices/bind`, { qr: st.devices[0].qr, resource_id: st.tables[0].id }],
    ['POST', `/api/clubs/${C}/catalog/import`, { csv: 'name,price\nX,1\n', dry_run: true }],
  ];
  const res = [];
  for (const [m, p, body] of probes) {
    const r = await R(m, p, body);
    res.push(`${m} ${p.replace(C, '{club}')} → ${r.status}`);
  }
  // Управляющий: приглашение и вход.
  const manPhone = staffPhone();
  const inv = await capi('POST', `/api/clubs/${C}/staff/invites`, { token: S.ownerA.token, club: C, body: { phone: manPhone, role: 'manager' } });
  assert.equal(inv.status, 201, short(inv));
  await sleep(200);
  const man = await loginRetry(manPhone, { consent: false });
  const mo = await capi('GET', `/api/clubs/${C}/onboarding`, { token: man.token, club: C });
  const mps = await capi('GET', `/api/clubs/${C}/payment-settings`, { token: man.token, club: C });
  const mgl = await capi('POST', `/api/clubs/${C}/go-live`, { token: man.token, club: C, body: { accept_offer: true } });
  t.diagnostic(`ресепшн: ${res.join('; ')}; управляющий: onboarding ${mo.status} (shops=${JSON.stringify(mo.json?.shops)}, checklist ${mo.json?.checklist ? 'есть' : 'нет'}), payment-settings ${mps.status}, go-live ${mgl.status}`);
  for (const line of res) assert.match(line, /→ 403$/, line);
  assert.equal(mo.status, 200);
  assert.equal(mo.json.shops, null);
  assert.equal(mps.status, 403);
  assert.equal(mgl.status, 403);
});

test('доп.: приостановка платформой — новая игра 409 club_suspended, возобновление; только platform_admin', { skip }, async (t) => {
  const { platform } = await import('./helpers.mjs');
  const admin = await platform('admin');
  const op = await platform('operator');
  const tb = st.tables[0];
  const guest = await loginRetry(`+7999${String(Date.now()).slice(-7)}`);
  const noReason = await capi('POST', `/api/platform/clubs/${st.club}/suspend`, { token: admin.token, body: {} });
  const byOperator = await capi('POST', `/api/platform/clubs/${st.club}/suspend`, { token: op.token, body: { reason: 'e2e' } });
  const byOwner = await capi('POST', `/api/platform/clubs/${st.club}/suspend`, { token: S.ownerA.token, body: { reason: 'e2e' } });
  const sus = await capi('POST', `/api/platform/clubs/${st.club}/suspend`, { token: admin.token, body: { reason: 'e2e: проверка приостановки' } });
  const q = await capi('POST', '/api/quotes', { token: guest.token, body: { resource_id: tb.id, kind: 'start', minutes: 30 } });
  const gl = await capi('POST', `/api/clubs/${st.club}/go-live`, { token: S.ownerA.token, club: st.club, body: { accept_offer: true } });
  const res = await capi('POST', `/api/platform/clubs/${st.club}/resume`, { token: admin.token, body: { reason: 'e2e: возобновить' } });
  const q2 = await capi('POST', '/api/quotes', { token: guest.token, body: { resource_id: tb.id, kind: 'start', minutes: 30 } });
  const { rows } = await db.query("select action, reason from bl.audit_log where club_id = $1 and action in ('club.suspend', 'club.resume') order by seq", [st.club]);
  t.diagnostic(`без причины ${noReason.status} ${noReason.json?.error}; оператор ${byOperator.status}; владелец ${byOwner.status}; приостановка ${short(sus)}; котировка ${q.status} ${q.json?.error}; go-live владельцем ${gl.status} ${gl.json?.error ?? gl.json?.mode}; возобновление ${short(res)}; котировка после ${q2.status}; журнал ${rows.map((r) => `${r.action} «${r.reason}»`).join(', ')}`);
  assert.equal(noReason.status, 400);
  assert.equal(byOperator.status, 403);
  assert.ok([401, 403].includes(byOwner.status));
  assert.equal(sus.json.mode, 'suspended');
  assert.equal(q.status, 409);
  assert.equal(q.json.error, 'club_suspended');
  assert.equal(res.json.mode, 'live', 'возобновление — в прежний режим');
  assert.equal(q2.status, 200);
});

test('доп.: «Заказать комплект» — заявка kind kit', { skip }, async (t) => {
  const body = { kind: 'kit', name: 'E2E Владелец', club_name: 'E2E M5 Клуб', city: 'Екатеринбург', phone: '+79990001122', tables_count: 2, consent: true, website: '', elapsed_ms: 5000 };
  const r = await api('POST', '/api/leads', { body });
  const bad = await api('POST', '/api/leads', { body: { ...body, kind: 'box' } });
  const { rows } = await db.query("select kind, tables_count, phone from bl.leads where kind = 'kit' and created_at > now() - interval '1 minute' order by created_at desc limit 1");
  t.diagnostic(`kit: ${short(r)}; kind box: ${bad.status}; в базе ${rows[0] ? `${rows[0].kind} столов ${rows[0].tables_count}` : 'нет'}`);
  assert.ok([201, 429].includes(r.status), short(r));
  if (r.status === 201) assert.equal(rows[0]?.kind, 'kit');
  assert.equal(bad.status, 400);
});
