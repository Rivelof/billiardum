// Поиск гостя на кассе (№121) без базы: лимит в минуту на сотрудника, тревога о промахах раз в час.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGuestLookupGuard, LOOKUPS_PER_MINUTE, MISSES_PER_HOUR } from '../guest-lookup.mjs';

const A = 'a1000000-0000-4000-8000-000000000004';
const B = 'a1000000-0000-4000-8000-000000000003';
const at = (ms) => new Date(Date.UTC(2026, 9, 22, 12, 0, 0) + ms);

describe('поиск гостя: лимит и промахи', () => {
  it(`${LOOKUPS_PER_MINUTE} поисков в минуту на сотрудника, дальше — 429 rate_limited; через минуту — снова можно`, () => {
    const g = createGuestLookupGuard();
    for (let i = 0; i < LOOKUPS_PER_MINUTE; i += 1) g.lookup(A, at(i * 1000));
    assert.throws(() => g.lookup(A, at(30_000)), (e) => e.code === 'rate_limited' && e.status === 429);
    g.lookup(B, at(30_000));
    g.lookup(A, at(61_000));
  });

  it(`${MISSES_PER_HOUR} промахов за час — тревога один раз в час на сотрудника`, () => {
    const g = createGuestLookupGuard();
    const fired = [];
    for (let i = 0; i < 15; i += 1) fired.push(g.miss(A, at(i * 60_000)));
    assert.deepEqual(fired.map((x, i) => (x ? i : null)).filter((x) => x !== null), [MISSES_PER_HOUR - 1]);
    assert.equal(g.miss(B, at(0)), false, 'у другого сотрудника свой счёт');
    // Через час после тревоги и при 10 промахах в окне — снова.
    let again = false;
    for (let i = 0; i < 10; i += 1) again = g.miss(A, at(3_600_000 + 9 * 60_000 + i * 1000)) || again;
    assert.equal(again, true);
  });

  it('промахи старше часа не считаются', () => {
    const g = createGuestLookupGuard();
    for (let i = 0; i < 9; i += 1) g.miss(A, at(i * 1000));
    assert.equal(g.miss(A, at(3_700_000)), false);
    assert.equal(g.missesInHour(A, at(3_700_000)), 1);
  });
});
