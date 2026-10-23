// Эло, уровни, сезоны, ник и счёт Бильярдум+ — без базы (PRODUCT §13, решение №136).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyElo, delta, expected, isSeason, kFactor, levelOf, nickValid, roundHalfAway, scoreValid, seasonOf,
} from '../elo.mjs';

describe('формула Эло', () => {
  it('ожидаемый результат: равные — 0,5; сумма ожиданий — 1; +400 — 10 к 1', () => {
    assert.equal(expected(1200, 1200), 0.5);
    assert.ok(Math.abs(expected(1500, 1300) + expected(1300, 1500) - 1) < 1e-12);
    assert.ok(Math.abs(expected(1600, 1200) - 10 / 11) < 1e-12);
  });

  it('K = 40 первые 20 партий, затем 20', () => {
    assert.equal(kFactor(0), 40);
    assert.equal(kFactor(19), 40);
    assert.equal(kFactor(20), 20);
    assert.equal(kFactor(500), 20);
  });

  it('новички 1200 и 1200: победа +20, поражение −20 (T22)', () => {
    const r = applyElo({ rating: 1200, games: 0 }, { rating: 1200, games: 0 }, 'a');
    assert.deepEqual([r.a.delta, r.b.delta, r.a.after, r.b.after], [20, -20, 1220, 1180]);
    assert.equal(r.a.k, 40);
  });

  it('после 20 партий изменение вдвое меньше; у каждого свой K', () => {
    const r = applyElo({ rating: 1200, games: 20 }, { rating: 1200, games: 3 }, 'a');
    assert.equal(r.a.delta, 10);
    assert.equal(r.b.delta, -20);
  });

  it('турнирная партия ×1,5', () => {
    const plain = applyElo({ rating: 1200, games: 0 }, { rating: 1200, games: 0 }, 'b');
    const t = applyElo({ rating: 1200, games: 0 }, { rating: 1200, games: 0 }, 'b', { multiplierX10: 15 });
    assert.equal(plain.b.delta, 20);
    assert.equal(t.b.delta, 30);
    assert.equal(t.a.delta, -30);
  });

  it('победа слабого даёт больше, чем победа сильного', () => {
    const weak = delta({ rating: 1200, opponent: 1600, games: 30, win: true });
    const strong = delta({ rating: 1600, opponent: 1200, games: 30, win: true });
    assert.equal(weak, 18);
    assert.equal(strong, 2);
  });

  it('округление половины от нуля, как round(numeric) в Postgres; без −0', () => {
    assert.equal(roundHalfAway(2.5), 3);
    assert.equal(roundHalfAway(-2.5), -3);
    assert.equal(roundHalfAway(-0.4), -0);
    assert.ok(Object.is(delta({ rating: 3000, opponent: 0, games: 50, win: true }), 0));
  });
});

describe('уровни и сезоны', () => {
  it('уровни PRODUCT §13: границы', () => {
    assert.equal(levelOf(1199), 'novice');
    assert.equal(levelOf(1200), 'amateur');
    assert.equal(levelOf(1399), 'amateur');
    assert.equal(levelOf(1400), 'experienced');
    assert.equal(levelOf(1600), 'strong');
    assert.equal(levelOf(1799), 'strong');
    assert.equal(levelOf(1800), 'master');
  });

  it('сезон — месяц по Москве: 31 октября 21:00 UTC уже ноябрь', () => {
    assert.equal(seasonOf('2026-10-31T20:59:59Z'), '2026-10');
    assert.equal(seasonOf('2026-10-31T21:00:00Z'), '2026-11');
    assert.equal(isSeason('all'), true);
    assert.equal(isSeason('2026-13'), false);
    assert.equal(isSeason('2026-1'), false);
  });
});

describe('ник и счёт', () => {
  it('ник: 3–20 символов, латиница, кириллица, цифры, _ и -; не телефон', () => {
    assert.equal(nickValid('Кий_Мастер'), true);
    assert.equal(nickValid('ace-99'), true);
    assert.equal(nickValid('ab'), false);
    assert.equal(nickValid('a'.repeat(21)), false);
    assert.equal(nickValid('79991234567'), false);
    assert.equal(nickValid('a9991234567'), false);
    assert.equal(nickValid('ник с пробелом'), false);
    assert.equal(nickValid('<script>'), false);
  });

  it('счёт: без ничьей; в пирамиде у победителя 8', () => {
    assert.equal(scoreValid('pyramid', 8, 5), true);
    assert.equal(scoreValid('pyramid', 0, 8), true);
    assert.equal(scoreValid('pyramid', 9, 5), false);
    assert.equal(scoreValid('pyramid', 7, 5), false);
    assert.equal(scoreValid('pool', 5, 3), true);
    assert.equal(scoreValid('pool', 3, 3), false);
    assert.equal(scoreValid('pool', 1.5, 0), false);
    assert.equal(scoreValid('snooker', -1, 2), false);
  });
});
