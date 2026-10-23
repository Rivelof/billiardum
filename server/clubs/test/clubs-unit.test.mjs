// Подключение клуба (M5.1 backend-A): чистые функции без базы — маска секрета, проверка магазина
// GET /v3/me, коды ошибок, ручное действие, нефискальный «ТЕСТ» для ККТ, пары магазина по режиму.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { ERROR_CODES, HttpError, safeErrorData, toHttpError } from '../../http/errors.mjs';
import { recordManual, manualReason } from '../../lib/manual.mjs';
import { testReceiptTask, testShiftReportTask } from '../../kkt/atol-task.mjs';
import { decryptShopSecret, encryptShopSecret, shopModeOf, shopModeOfClub, yookassaSecretContext } from '../../payments/settings.mjs';
import { createEmulator } from '../../../tools/yookassa-emu/lib/emulator.mjs';
import { isLiveClub, secretMask, shopJson, verifyPair } from '../shops.mjs';
import { FALLBACK, resolveNeighbors } from '../neighbors.mjs';
import { CHECKLIST_IDS, STEP_IDS } from '../service.mjs';

const CLUB = 'c9000000-0000-4000-8000-000000000001';

describe('коды ошибок M5.1 (§4)', () => {
  it('все коды контракта в словаре', () => {
    for (const code of ['clubs_limit', 'checklist_incomplete', 'club_suspended', 'shop_invalid', 'shop_mode_mismatch', 'fiscalization_off', 'tariff_gap', 'tariff_overlap', 'xlsx_invalid', 'qr_invalid']) {
      assert.ok(ERROR_CODES.has(code), code);
    }
  });

  it('409 checklist_incomplete отдаёт failed — только известные пункты', () => {
    const e = toHttpError(new HttpError(409, 'checklist_incomplete', { data: { failed: ['tables', 'offer', 'tables'] } }));
    assert.deepEqual(e, { status: 409, code: 'checklist_incomplete', headers: undefined, data: { failed: ['tables', 'offer'] } });
    assert.equal(safeErrorData({ failed: ['tables', '<script>'] }), null);
    assert.equal(safeErrorData({ failed: 'tables' }), null);
    assert.deepEqual([...CHECKLIST_IDS].sort(), ['devices', 'kkt', 'offer', 'shop_live', 'stickers', 'tables', 'tariffs']);
    assert.equal(STEP_IDS.length, 10);
  });
});

describe('магазин ЮKassa: маска и пары', () => {
  it('маска — последние 4 символа и длина, сам секрет не отдаётся', () => {
    assert.deepEqual(secretMask('test_abcdefgh1234'), { last4: '1234', length: 17 });
    assert.equal(secretMask(''), null);
    const key = randomBytes(32);
    const row = { club_id: CLUB, test_shop_id: '900001', test_secret_key_enc: encryptShopSecret('test_secret_9f2c', key, CLUB, 'test'), test_verified_at: new Date('2026-10-23T10:00:00Z'), test_me: { account_id: '900001', test: true, fiscalization_enabled: true } };
    const json = shopJson(row, 'test', key);
    assert.deepEqual(json, { mode: 'test', shop_id: '900001', secret_mask: { last4: '9f2c', length: 16 }, verified_at: '2026-10-23T10:00:00.000Z', test: true, fiscalization: true, account_id: '900001' });
    assert.ok(!JSON.stringify(json).includes('test_secret'));
    assert.deepEqual(shopJson(row, 'live', key).shop_id, null);
  });

  it('контекст шифрования: тестовая пара не расшифровывается как боевая и наоборот', () => {
    const key = randomBytes(32);
    const enc = encryptShopSecret('s3cret-key', key, CLUB, 'test');
    assert.equal(decryptShopSecret(enc, key, CLUB, 'test'), 's3cret-key');
    assert.throws(() => decryptShopSecret(enc, key, CLUB, 'live'));
    assert.equal(yookassaSecretContext(CLUB), `yookassa_secret/${CLUB}`);
    assert.equal(yookassaSecretContext(CLUB, 'test'), `yookassa_secret/${CLUB}/test`);
  });

  it('пара по режиму клуба и по платежу', () => {
    assert.equal(shopModeOfClub('test'), 'test');
    assert.equal(shopModeOfClub('live'), 'live');
    assert.equal(shopModeOfClub('suspended', 'test'), 'test');
    assert.equal(shopModeOfClub('suspended', 'live'), 'live');
    assert.equal(shopModeOf({ is_test: true }), 'test');
    assert.equal(shopModeOf({ is_test: false }), 'live');
    assert.equal(isLiveClub('suspended', 'live'), true);
    assert.equal(isLiveClub('suspended', 'test'), false);
  });
});

describe('проверка пары GET /v3/me (эмулятор)', () => {
  async function withEmu(fn) {
    const emu = createEmulator({
      shops: [
        { shopId: '900001', secret: 'test_secret_1', test: true },
        { shopId: '900002', secret: 'live_secret_2', test: false, fiscalization: true },
        { shopId: '900003', secret: 'live_secret_3', test: false, fiscalization: false },
      ],
    });
    const addr = await emu.listen(0);
    try {
      return await fn({ yookassaApiUrl: `http://127.0.0.1:${addr.port}/v3`, yookassaTimeoutMs: 2000 }, emu);
    } finally {
      await emu.close();
    }
  }
  const code = (c) => (err) => err instanceof HttpError && err.code === c;

  it('test — только тестовый магазин, live — только боевой с фискализацией', async () => {
    await withEmu(async (config, emu) => {
      assert.deepEqual(await verifyPair({ shopId: '900001', secret: 'test_secret_1', mode: 'test', config }), { account_id: '900001', test: true, fiscalization_enabled: true });
      assert.deepEqual(await verifyPair({ shopId: '900002', secret: 'live_secret_2', mode: 'live', config }), { account_id: '900002', test: false, fiscalization_enabled: true });
      await assert.rejects(verifyPair({ shopId: '900002', secret: 'live_secret_2', mode: 'test', config }), code('shop_mode_mismatch'));
      await assert.rejects(verifyPair({ shopId: '900001', secret: 'test_secret_1', mode: 'live', config }), code('shop_mode_mismatch'));
      await assert.rejects(verifyPair({ shopId: '900003', secret: 'live_secret_3', mode: 'live', config }), code('fiscalization_off'));
      await assert.rejects(verifyPair({ shopId: '900001', secret: 'wrong_secret', mode: 'test', config }), code('shop_invalid'));
      await assert.rejects(verifyPair({ shopId: '999999', secret: 'test_secret_1', mode: 'test', config }), code('shop_invalid'));
      emu.config.down = true;
      await assert.rejects(verifyPair({ shopId: '900001', secret: 'test_secret_1', mode: 'test', config }), (e) => e.status === 503 && e.code === 'yookassa_unavailable');
    });
  });

  it('эмулятор: GET /v3/me по магазину и поле test у платежей', async () => {
    await withEmu(async (config) => {
      const auth = `Basic ${Buffer.from('900002:live_secret_2').toString('base64')}`;
      const me = await (await fetch(`${config.yookassaApiUrl}/me`, { headers: { authorization: auth } })).json();
      assert.deepEqual(me, { account_id: '900002', test: false, fiscalization_enabled: true, payment_methods: ['bank_card', 'sbp'], status: 'enabled' });
      const res = await fetch(`${config.yookassaApiUrl}/me`, { headers: { authorization: `Basic ${Buffer.from('900002:x').toString('base64')}` } });
      assert.equal(res.status, 401);
    });
  });
});

describe('ручное действие (ctx.manual)', () => {
  it('без причины — reason_required; с причиной — журнал manual.* и тревога владельцу', async () => {
    assert.throws(() => manualReason('  '), (e) => e.code === 'reason_required');
    assert.throws(() => manualReason(undefined), (e) => e.code === 'reason_required');
    const queries = [];
    const raised = [];
    const db = {
      async query(sql, params) {
        queries.push({ sql, params });
        return { rowCount: 1, rows: [{ id: 'a0000000-0000-4000-8000-000000000001', seq: 7, hash: 'h' }] };
      },
    };
    const alarms = { raise: async (_db, clubId, a) => (raised.push({ clubId, ...a }), { id: 'b0000000-0000-4000-8000-000000000001' }) };
    await assert.rejects(recordManual(db, { clubId: CLUB, alarms }, { action: 'manual.tariff_change', text: 'Изменён тариф.' }), (e) => e.code === 'reason_required');
    await assert.rejects(recordManual(db, { clubId: CLUB, alarms }, { action: 'tariff.change', reason: 'x', text: 'т' }), /manual\.\*/);
    const out = await recordManual(db, { clubId: CLUB, userId: 'a1000000-0000-4000-8000-000000000001', alarms }, { action: 'manual.tariff_change', reason: ' праздник ', text: 'Изменён тариф.', data: { rules: 3 } });
    assert.equal(out.alarm_id, 'b0000000-0000-4000-8000-000000000001');
    const audit = queries.find((q) => /insert into bl\.audit_log/.test(q.sql));
    assert.equal(audit.params[3], 'manual.tariff_change');
    assert.equal(audit.params[6], 'праздник');
    assert.equal(raised[0].type, 'manual_action');
    assert.equal(raised[0].manual, true);
    assert.equal(raised[0].text, 'Изменён тариф. Причина: праздник');
    assert.deepEqual(raised[0].data, { action: 'manual.tariff_change', reason: 'праздник', staff_id: 'a1000000-0000-4000-8000-000000000001', rules: 3 });
  });
});

describe('ККТ в тестовом режиме: нефискальный «ТЕСТ»', () => {
  it('задание nonFiscal без фискальных полей, сумма сверяется', () => {
    const items = [{ description: 'Чай', quantity: 2, amount: { value: '150.00', currency: 'RUB' }, vat_code: 1, payment_mode: 'full_payment', payment_subject: 'commodity' }];
    const task = testReceiptTask({ kind: 'sale', items, amountKopecks: 30000, operatorName: 'Анна' });
    assert.equal(task.type, 'nonFiscal');
    assert.ok(task.items.every((x) => x.type === 'text'));
    assert.equal(task.items[0].text, 'ТЕСТ');
    assert.ok(task.items.some((x) => x.text === 'Итого 300,00 ₽'));
    assert.ok(!('payments' in task) && !('taxationType' in task));
    assert.throws(() => testReceiptTask({ kind: 'sale', items, amountKopecks: 100 }), /сумма позиций/);
  });

  it('отчёт о закрытии смены — нефискальный «ТЕСТ»', () => {
    const task = testShiftReportTask({ number: 3, operatorName: 'Анна', sales: { count: 2, kopecks: 150050 } });
    assert.equal(task.type, 'nonFiscal');
    assert.deepEqual(task.items.map((x) => x.text), [
      'ТЕСТ', 'Тестовый режим клуба', 'Отчёт о закрытии смены. Не фискальный', 'Смена №3', 'Тестовых продаж: 2 на 1500,50 ₽', 'Кассир: Анна', 'ТЕСТ',
    ]);
    assert.ok(task.items.every((x) => x.type === 'text'));
  });
});

describe('соседи чек-листа (backend-B, §3)', () => {
  it('подмена функций и запасные реализации', async () => {
    const fake = { resources: { activeCount: async () => 5 }, tariffs: { coversWeek: async () => ({ ok: true }) }, qr: { printedAt: async () => new Date() } };
    const n = await resolveNeighbors(fake, { spec: './нет-такого-модуля.mjs' });
    assert.equal(await n.resources.activeCount(), 5);
    assert.deepEqual(await n.tariffs.coversWeek(), { ok: true });
    const fb = await resolveNeighbors({}, { spec: './нет-такого-модуля.mjs' });
    assert.equal(fb.resources.activeCount, FALLBACK.resources.activeCount);
    assert.equal(fb.tariffs.coversWeek, FALLBACK.tariffs.coversWeek);
    assert.equal(fb.qr.printedAt, FALLBACK.qr.printedAt);
  });
});
