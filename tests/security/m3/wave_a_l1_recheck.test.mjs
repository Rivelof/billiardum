// Перепроверка L1 (волна A) после №121, коммит 800fc3e: поиск гостя по телефону на кассе
// (bl.pos_guest через server/orders/guest-lookup.mjs) — лимит 20/мин на сотрудника и тревога
// guest_lookup_misses при 10 промахах за час.
// Атаки: обход лимита корзиной из нескольких пакетов и поиском по user_id; поиск без следа
// (запрос падает после поиска — продажа не создаётся); подмена времени клиентом; повтор тревоги.
// Обвязка — server/orders/test/db/harness.mjs (настоящий POS, money, эмулятор ЮKassa).
//
// Запуск: DATABASE_ADMIN_URL=postgres://supabase_admin:...@127.0.0.1:55460/postgres \
//   node --test tests/security/m3/wave_a_l1_recheck.test.mjs

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { guestLookupGuard, LOOKUPS_PER_MINUTE } from '../../../server/orders/guest-lookup.mjs';
import { CLUB_A, newKey, PHONES, setup } from '../../../server/orders/test/db/harness.mjs';

const skip = !process.env.DATABASE_ADMIN_URL;
const GUEST = 'a9000000-0000-4000-8000-0000000000d1';
const GUEST_PHONE = '+79990000099';

describe('L1 после №121: поиск гостя на кассе', { skip }, () => {
  let h;
  let reception;
  let manager;
  let pkg;

  const sale = (who, body) => h.request('POST', '/api/pos/sales', { token: who.token, body, key: newKey(), club: CLUB_A });
  const pkgLine = (x) => ({ kind: 'package', package_id: pkg, ...x });

  before(async () => {
    h = await setup();
    reception = await h.login(PHONES.reception);
    manager = await h.login(PHONES.manager);
    await h.q(`insert into bl.users (id, phone) values ($1, $2) on conflict do nothing`, [GUEST, GUEST_PHONE]);
    await h.q(`insert into bl.consents (user_id, version, accepted_at) values ($1, '2026-10-21', now())`, [GUEST]);
    pkg = (await h.q(`insert into bl.tariff_packages (club_id, title, minutes, price_kopecks, valid_days) values ($1, 'Пентест', 600, 500000, 30) returning id`, [CLUB_A]))[0].id;
    await h.openShift();
  });
  beforeEach(() => guestLookupGuard.reset());
  after(async () => {
    guestLookupGuard.reset();
    await h?.close();
  });

  it('pos_guest вызывается только через страж: в server/ и api/ нет других вызовов', async () => {
    const { execSync } = await import('node:child_process');
    const hits = execSync("grep -rn 'bl.pos_guest(' server api --include=*.mjs | grep -v '/test/' || true", { encoding: 'utf8' }).split('\n').filter(Boolean);
    const calls = hits.filter((l) => /select bl\.pos_guest\(/.test(l));
    assert.equal(calls.length, 1, hits.join('\n'));
    assert.match(calls[0], /server\/orders\/pos\.mjs/);
  });

  it('лимит считает каждый пакет корзины: 4 продажи по 5 пакетов исчерпывают 20 поисков', async () => {
    // Корзина доходит до поиска (без ошибок корзины): 5 пакетов на существующего гостя — продажа проходит.
    const five = Array.from({ length: 5 }, () => pkgLine({ phone: GUEST_PHONE }));
    for (let i = 0; i < LOOKUPS_PER_MINUTE / 5; i += 1) {
      const r = await sale(reception, { items: five, method: 'card_terminal' });
      assert.equal(r.status, 201, `продажа ${i + 1}: ${r.text}`);
    }
    const over = await sale(reception, { items: [pkgLine({ phone: GUEST_PHONE })], method: 'card_terminal' });
    assert.deepEqual([over.status, over.json], [429, { error: 'rate_limited' }]);
    const byId = await sale(reception, { items: [pkgLine({ user_id: GUEST })], method: 'card_terminal' });
    assert.equal(byId.status, 429, 'поиск по user_id — тот же лимит');
  });

  it('промахи: 10 за час — одна тревога guest_lookup_misses, при 20 промахах повторной нет; телефонов в тревоге нет', async () => {
    const before = (await h.alarms('guest_lookup_misses')).length;
    for (let i = 0; i < LOOKUPS_PER_MINUTE; i += 1) {
      const r = await sale(manager, { items: [pkgLine({ phone: `+7999777${String(1000 + i)}` })], method: 'card_terminal' });
      assert.deepEqual([r.status, r.json], [409, { error: 'guest_not_found' }]);
    }
    const alarms = (await h.alarms('guest_lookup_misses')).slice(before);
    assert.equal(alarms.length, 1);
    assert.equal(alarms[0].data.staff_id, manager.id);
    assert.ok(!JSON.stringify(alarms).includes('+7999777'));
  });

  it('время — с часов сервера: поля at/now в теле не сдвигают окно лимита', async () => {
    for (let i = 0; i < LOOKUPS_PER_MINUTE; i += 1) {
      await sale(reception, { items: [pkgLine({ phone: `+7999666${String(1000 + i)}` })], method: 'card_terminal', at: '2000-01-01T00:00:00Z', now: '2099-01-01T00:00:00Z' });
    }
    const r = await sale(reception, { items: [pkgLine({ phone: GUEST_PHONE })], method: 'card_terminal', at: '2100-01-01T00:00:00Z' });
    assert.equal(r.status, 429);
  });

  it('остаток L1 исправлен: при ошибке корзины ответ одинаков для существующего и несуществующего телефона, поиска и промахов нет', async () => {
    const bads = [
      { name: 'пустой счёт стола', extra: { tabs: [randomUUID()] } },
      { name: 'несуществующая заявка', extra: { requests: [randomUUID()] } },
      { name: 'наличные без суммы', extra: {}, method: 'cash' },
      { name: 'одобрение PIN без скидки', extra: { discount: { approval_id: randomUUID() } } },
      { name: 'чужое одобрение скидки', extra: { items: [], discount: { percent: 50, approval_id: randomUUID() } } },
      { name: 'товар не из меню', extra: { items: [{ product_id: randomUUID(), qty: 1 }] } },
      { name: 'наличные меньше суммы', extra: { received_kopecks: 1 }, method: 'cash' },
    ];
    for (const b of bads) {
      const body = (phone) => ({ method: b.method ?? 'card_terminal', ...b.extra, items: [...(b.extra.items ?? []), pkgLine({ phone })] });
      const hit = await sale(reception, body(GUEST_PHONE));
      const miss = await sale(reception, body('+79998887766'));
      assert.notEqual(hit.status, 200, `${b.name}: ${hit.text}`);
      assert.deepEqual([hit.status, hit.json], [miss.status, miss.json], `${b.name}: ответы совпадают`);
      assert.notEqual(miss.json?.error, 'guest_not_found', `${b.name}: гость не искался`);
    }
    assert.equal(guestLookupGuard.missesInHour(reception.id, new Date()), 0, 'промахов нет');
  });

  it('L1-R2 исправлено: СБП выключена или у клуба нет магазина ЮKassa — ответ одинаков, гость не ищется', async () => {
    const [orig] = await h.q('select shop_id, secret_key_enc, sbp_enabled from bl.club_payment_settings where club_id = $1', [CLUB_A]);
    const states = [
      ['СБП выключена', 'update bl.club_payment_settings set sbp_enabled = false where club_id = $1'],
      ['нет магазина ЮKassa', 'update bl.club_payment_settings set sbp_enabled = true, shop_id = null, secret_key_enc = null where club_id = $1'],
    ];
    try {
      for (const [name, sql] of states) {
        await h.q(sql, [CLUB_A]);
        guestLookupGuard.reset();
        const body = (phone) => ({ items: [pkgLine({ phone })], method: 'sbp', customer_phone: '+79990000001' });
        const hit = await sale(reception, body(GUEST_PHONE));
        const miss = await sale(reception, body('+79998887755'));
        assert.deepEqual([hit.status, hit.json], [400, { error: 'bad_request' }], `${name}: ${hit.text}`);
        assert.deepEqual([miss.status, miss.json], [hit.status, hit.json], `${name}: ответы совпадают`);
        assert.equal(guestLookupGuard.missesInHour(reception.id, new Date()), 0, `${name}: промахов нет`);
        await h.q('update bl.club_payment_settings set shop_id = $2, secret_key_enc = $3, sbp_enabled = $4 where club_id = $1', [CLUB_A, orig.shop_id, orig.secret_key_enc, orig.sbp_enabled]);
      }
    } finally {
      await h.q('update bl.club_payment_settings set shop_id = $2, secret_key_enc = $3, sbp_enabled = $4 where club_id = $1', [CLUB_A, orig.shop_id, orig.secret_key_enc, orig.sbp_enabled]);
    }
  });

  it('перебор корзин: ни одна ошибочная корзина не отвечает по-разному для существующего и несуществующего гостя', async () => {
    const carts = [
      { method: 'sbp' }, // нет контакта для чека
      { method: 'sbp', customer_phone: '123' },
      { method: 'sbp', customer_phone: '+79990000001', received_kopecks: 1 },
      { method: 'cash', received_kopecks: 499_999 },
      { method: 'cash', received_kopecks: 500_000 + 10_000_001 },
      { method: 'card_terminal', received_kopecks: 1 },
      { method: 'card_terminal', to_bar: 'yes' },
      { method: 'card_terminal', tabs: [randomUUID(), randomUUID()] },
      { method: 'card_terminal', requests: [randomUUID()] },
      { method: 'cash', received_kopecks: 600_000, requests: [randomUUID()] },
      { method: 'card_terminal', discount: { percent: 101 } },
      { method: 'card_terminal', discount: { kopecks: -1 } },
      { method: 'card_terminal', discount: { approval_id: 'x' } },
      { method: 'card_terminal', items: [{ product_id: randomUUID(), qty: 0 }] },
      { method: 'card_terminal', items: [{ product_id: randomUUID(), qty: 1 }] },
      { method: 'bitcoin' },
    ];
    let compared = 0;
    for (const extra of carts) {
      guestLookupGuard.reset();
      const body = (phone) => ({ ...extra, items: [...(extra.items ?? []), pkgLine({ phone })] });
      const hit = await sale(reception, body(GUEST_PHONE));
      const miss = await sale(reception, body('+79998887744'));
      if (hit.status === 201) continue; // корзина верна: продажа прошла, промах — обычный guest_not_found
      compared += 1;
      assert.deepEqual([hit.status, hit.json], [miss.status, miss.json], `различие на корзине ${JSON.stringify(extra)}: ${hit.text} / ${miss.text}`);
    }
    assert.ok(compared >= 12, `сравнено ошибочных корзин: ${compared}`);
  });
});
