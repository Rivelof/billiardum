// Привязка контроллера по QR с корпуса (M5.1 №159): BLD1, заводской реестр (5 неверных кодов
// закрывают привязку на 30 минут), лимит claim на устройство и широкий лимит по IP (NAT клуба),
// код привязки 8…63 символа (пароль точки доступа WPA2, protocol §7).

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createRouter } from '../../../api/router.mjs';
import { CLAIM_DEVICE_LIMIT, CLAIM_IP_LIMIT, routes as deviceRoutes } from '../../../api/routes/devices.mjs';
import { createBinding } from '../../devices/bind.mjs';
import { appendAudit } from '../../lib/audit.mjs';
import { withContext } from '../../lib/store.mjs';
import { claimCodeHash } from '../../sessions/service.mjs';
import { CLUB, CLUB_B, createTestDb, OWNER, RES, RES_B, SKIP, startLight } from './harness.mjs';

const OWNER_B = 'a2000000-0000-4000-8000-000000000002';

describe('привязка по QR BLD1 и заводской реестр', { skip: SKIP }, () => {
  let t;
  let h;
  let server;
  let base;
  const principals = {
    owner: { kind: 'session', userId: OWNER, hasPhone: true, consents: [] },
    ownerB: { kind: 'session', userId: OWNER_B, hasPhone: true, consents: [] },
  };

  before(async () => {
    t = await createTestDb();
    h = await startLight(t, { devices: [1, 2] });
    const app = { ...h.ctx, config: { ...h.ctx.config, allowedOrigins: [] }, clock: h.ctx.clock, pool: t.app };
    const router = createRouter(app, { routes: deviceRoutes.map((r) => ({ ...r, file: 'devices.mjs' })), resolvePrincipal: async (tok) => principals[tok] ?? null });
    server = http.createServer((req, res) => router.handle(req, res));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    await h?.stop();
    await t?.drop();
  });

  async function call(method, path, { token, body } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
  }
  const bind = async (token, body, club = CLUB) => {
    const r = await call('POST', `/api/clubs/${club}/devices/bind`, { token, body });
    return { status: r.status, json: r.json };
  };

  it('QR без реестра: bind открывает окно, claim по коду из QR; неверный QR — 400 qr_invalid', async () => {
    const dev = 'd9100000-0000-4000-8000-000000000001';
    const code = '7K2M-Q9XD-4HTB-R1VS';
    for (const qr of ['BLD2:x', `BLD1:${dev}`, `BLD1:${dev}:SHORT`, `BLD1:${dev}:${'A'.repeat(64)}`, 42]) {
      assert.deepEqual(await bind('owner', { qr, resource_id: RES(3) }), { status: 400, json: { error: 'qr_invalid' } }, String(qr));
    }
    // device_id рядом с QR — должен совпадать.
    assert.equal((await bind('owner', { qr: `BLD1:${dev}:${code}`, device_id: 'd9100000-0000-4000-8000-000000000009', resource_id: RES(3) })).json.error, 'qr_invalid');
    const b = await bind('owner', { qr: ` BLD1:${dev.toUpperCase()}:${code}\n`, resource_id: RES(3) });
    assert.equal(b.status, 200);
    assert.equal(b.json.device_id, dev);
    const w = await t.q('select claim_code_hash from bl.device_bind_windows where device_id = $1', [dev]);
    assert.equal(w.rows[0].claim_code_hash, claimCodeHash(dev, code));
    const audit = await t.q("select data from bl.audit_log where action = 'device.bind' and object_id = $1", [dev]);
    assert.deepEqual([audit.rows[0].data.via, audit.rows[0].data.factory], ['qr', false]);
    const c = await call('POST', '/api/devices/claim', { body: { device_id: dev, claim_code: code } });
    assert.equal(c.status, 200);
    // Чужой клуб: QR чужого устройства не привязывает.
    assert.equal((await bind('ownerB', { qr: `BLD1:${dev}:${code}`, resource_id: RES_B }, CLUB_B)).status, 403);
  });

  it('код 8…63 символа: 7 и 64 — 400 при привязке и при claim', async () => {
    const dev = 'd9100000-0000-4000-8000-000000000002';
    assert.equal((await bind('owner', { device_id: dev, claim_code: 'ABC-123', resource_id: RES(4) })).status, 400);
    assert.equal((await bind('owner', { device_id: dev, claim_code: 'A'.repeat(64), resource_id: RES(4) })).status, 400);
    assert.equal((await bind('owner', { device_id: dev, claim_code: 'A'.repeat(63), resource_id: RES(4) })).status, 200);
    assert.equal((await call('POST', '/api/devices/claim', { body: { device_id: dev, claim_code: 'A'.repeat(64) } })).status, 400);
    assert.equal((await call('POST', '/api/devices/claim', { body: { device_id: dev, claim_code: 'A'.repeat(63) } })).status, 200);
  });

  it('заводской реестр: неверный код — 403 со счётчиком, пятый закрывает привязку на 30 минут (429); верный — окно', async () => {
    const dev = 'd9100000-0000-4000-8000-000000000003';
    const code = 'ABCD-EFGH-JKMN-PQRS';
    await t.q('insert into bl.device_factory (device_id, claim_code_hash, batch) values ($1, $2, $3)', [dev, claimCodeHash(dev, code), 'T1']);
    for (let i = 1; i <= 4; i += 1) {
      assert.deepEqual(await bind('owner', { qr: `BLD1:${dev}:WRONG-000${i}`, resource_id: RES(5) }), { status: 403, json: { error: 'forbidden' } });
      assert.equal((await t.q('select bind_failed from bl.device_factory where device_id = $1', [dev])).rows[0].bind_failed, i, 'попытка засчитана');
    }
    assert.equal((await t.q('select count(*)::int as n from bl.device_bind_windows where device_id = $1', [dev])).rows[0].n, 0, 'окно не открыто');
    assert.equal((await bind('owner', { qr: `BLD1:${dev}:WRONG-0005`, resource_id: RES(5) })).status, 403);
    const locked = await t.q('select bind_failed, bind_locked_until from bl.device_factory where device_id = $1', [dev]);
    assert.ok(locked.rows[0].bind_locked_until > new Date(h.time.now()));
    // Закрыто: и верный код — 429, пока не прошло 30 минут.
    assert.deepEqual(await bind('owner', { qr: `BLD1:${dev}:${code}`, resource_id: RES(5) }), { status: 429, json: { error: 'rate_limited' } });
    await h.time.jump(31 * 60_000);
    const ok = await bind('owner', { qr: `BLD1:${dev}:${code}`, resource_id: RES(5) });
    assert.equal(ok.status, 200);
    const audit = await t.q("select data from bl.audit_log where action = 'device.bind' and object_id = $1", [dev]);
    assert.equal(audit.rows[0].data.factory, true);
    assert.equal((await t.q('select bind_failed, bind_locked_until from bl.device_factory where device_id = $1', [dev])).rows[0].bind_failed, 0);
    // app_api реестр не читает.
    await assert.rejects(t.app.query('select * from bl.device_factory'), (e) => e.code === '42501');
  });

  it(`claim: на устройство ${CLAIM_DEVICE_LIMIT.max} в минуту, с IP — ${CLAIM_IP_LIMIT.max}`, async () => {
    assert.deepEqual([CLAIM_DEVICE_LIMIT.max, CLAIM_IP_LIMIT.max], [6, 60]);
    const dev = 'd9100000-0000-4000-8000-000000000004';
    let last;
    for (let i = 0; i < CLAIM_DEVICE_LIMIT.max; i += 1) {
      last = await call('POST', '/api/devices/claim', { body: { device_id: dev, claim_code: 'NOPE-NOPE' } });
      assert.equal(last.status, 403, 'нет окна — 403, но не лимит');
    }
    last = await call('POST', '/api/devices/claim', { body: { device_id: dev, claim_code: 'NOPE-NOPE' } });
    assert.equal(last.status, 429);
    assert.equal(last.json.error, 'rate_limited');
    assert.ok(Number(last.headers.get('retry-after')) >= 1);
    // Другие контроллеры клуба за тем же NAT — не упираются.
    for (let n = 5; n <= 12; n += 1) {
      const r = await call('POST', '/api/devices/claim', { body: { device_id: `d9100000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`, claim_code: 'NOPE-NOPE' } });
      assert.equal(r.status, 403);
    }
  });

  it('№162: в проде (requireFactory) bind и claim — только устройства из реестра; в разработке — и без реестра', async () => {
    const make = (requireFactory) =>
      createBinding({
        pool: t.app,
        withContext,
        clock: h.ctx.clock,
        log: h.ctx.log,
        audit: appendAudit,
        encKey: t.encKey,
        mqttPublicUrl: 'mqtts://dev.billiardum.test:8883',
        dynsec: async () => ({ async ensureRole() {}, async ensureClient() {} }),
        requireFactory,
      });
    const prod = make(true);
    const dev = make(false);
    const bindAs = (b, deviceId, claimCode, res) => withContext(t.app, { clubId: CLUB, userId: OWNER, actorType: 'user' }, (db) => b.bind(db, { clubId: CLUB, userId: OWNER, deviceId, resourceId: res, claimCode }));
    const claimAs = (b, deviceId, claimCode) => withContext(t.app, { clubId: null, actorType: 'user' }, (db) => b.claim(db, { deviceId, claimCode }));
    const forbidden = (e) => e.status === 403 && e.code === 'forbidden';
    // Без реестра: прод — 403 при bind; разработка — окно открывается, claim проходит.
    const loose = 'd9200000-0000-4000-8000-000000000001';
    await assert.rejects(bindAs(prod, loose, 'LOOSE-CODE-1', RES(6)), forbidden);
    assert.ok((await bindAs(dev, loose, 'LOOSE-CODE-1', RES(6))).bind_until);
    // Окно открыто разработкой, но прод ключи такому устройству не выдаёт.
    await assert.rejects(claimAs(prod, loose, 'LOOSE-CODE-1'), forbidden);
    assert.ok((await claimAs(dev, loose, 'LOOSE-CODE-1')).device_key);
    // Из реестра: прод — bind и claim проходят.
    const reg = 'd9200000-0000-4000-8000-000000000002';
    const code = 'WXYZ-0123-4567-89AB';
    await t.q('insert into bl.device_factory (device_id, claim_code_hash) values ($1, $2)', [reg, claimCodeHash(reg, code)]);
    assert.ok((await bindAs(prod, reg, code, RES(7))).bind_until);
    assert.ok((await claimAs(prod, reg, code)).device_key);
  });
});
