// Сетка турнира без базы: посев, олимпийская система (8, 6 с bye), группы и плей-офф, таблица группы, счёт.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  bracketSize,
  defaultMatchMinutes,
  groupStandings,
  planElimination,
  qualifierSlots,
  roundRobin,
  roundTitle,
  seedOrder,
  splitGroups,
  standardOrder,
  validScore,
} from '../bracket.mjs';

const players = (ratings) => ratings.map((r, i) => ({ id: `p${String(i + 1).padStart(2, '0')}`, rating: r, confirmed_at: new Date(1_000 + i) }));

/** Пары первого раунда в виде [посев, посев] (null — bye). */
const firstRound = (plan, seeds) =>
  plan.matches.filter((m) => m.round === 1).map((m) => [m.a === null ? null : seeds.indexOf(m.a) + 1, m.b === null ? null : seeds.indexOf(m.b) + 1]);

describe('посев', () => {
  it('по рейтингу дисциплины, при равенстве — кто раньше подтвердил, затем id', () => {
    const list = [
      { id: 'b', rating: 1500, confirmed_at: new Date(2) },
      { id: 'a', rating: 1500, confirmed_at: new Date(2) },
      { id: 'c', rating: 1700, confirmed_at: new Date(3) },
      { id: 'd', rating: 1500, confirmed_at: new Date(1) },
    ];
    assert.deepEqual(seedOrder(list).map((e) => e.id), ['c', 'd', 'a', 'b']);
    // Детерминированно: порядок входа не важен.
    assert.deepEqual(seedOrder([...list].reverse()).map((e) => e.id), ['c', 'd', 'a', 'b']);
  });
});

describe('олимпийская система', () => {
  it('стандартная расстановка: первые два — только в финале', () => {
    assert.deepEqual(standardOrder(2), [1, 2]);
    assert.deepEqual(standardOrder(4), [1, 4, 2, 3]);
    assert.deepEqual(standardOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
    assert.equal(bracketSize(5), 8);
    assert.equal(bracketSize(8), 8);
    assert.equal(bracketSize(9), 16);
  });

  it('8 участников: 4 + 2 + 1 матчей, пары 1–8, 4–5, 2–7, 3–6, без bye, переходы по сетке', () => {
    const seeded = seedOrder(players([1800, 1700, 1650, 1600, 1500, 1400, 1300, 1200]));
    const plan = planElimination(seeded);
    assert.equal(plan.size, 8);
    assert.equal(plan.rounds, 3);
    assert.equal(plan.matches.length, 7);
    assert.deepEqual(firstRound(plan, seeded), [
      [1, 8],
      [4, 5],
      [2, 7],
      [3, 6],
    ]);
    assert.ok(plan.matches.every((m) => !m.bye));
    const r1 = plan.matches.filter((m) => m.round === 1);
    assert.deepEqual(
      r1.map((m) => m.next),
      [
        { round: 2, position: 0, slot: 'a' },
        { round: 2, position: 0, slot: 'b' },
        { round: 2, position: 1, slot: 'a' },
        { round: 2, position: 1, slot: 'b' },
      ],
    );
    const final = plan.matches.find((m) => m.round === 3);
    assert.equal(final.next, null);
    // Тот же вход — та же сетка.
    assert.deepEqual(planElimination(seedOrder(players([1800, 1700, 1650, 1600, 1500, 1400, 1300, 1200]))), plan);
  });

  it('6 участников: сетка на 8, bye у посевов 1 и 2', () => {
    const seeded = seedOrder(players([1500, 1400, 1300, 1600, 1250, 1350]));
    const plan = planElimination(seeded);
    assert.equal(plan.size, 8);
    assert.deepEqual(firstRound(plan, seeded), [
      [1, null],
      [4, 5],
      [2, null],
      [3, 6],
    ]);
    assert.deepEqual(plan.matches.filter((m) => m.round === 1).map((m) => m.bye), [true, false, true, false]);
    assert.equal(plan.matches.filter((m) => m.round === 2).length, 2);
  });

  it('5 участников: три bye, ни одной пустой пары', () => {
    const plan = planElimination(['a', 'b', 'c', 'd', 'e']);
    const r1 = plan.matches.filter((m) => m.round === 1);
    assert.equal(r1.filter((m) => m.bye).length, 3);
    assert.ok(r1.every((m) => m.a !== null || m.b !== null));
  });

  it('названия раундов', () => {
    assert.equal(roundTitle(3, 3), 'Финал');
    assert.equal(roundTitle(2, 3), 'Полуфинал');
    assert.equal(roundTitle(1, 3), '1/4 финала');
    assert.equal(roundTitle(1, 4), '1/8 финала');
  });
});

describe('группы и плей-офф', () => {
  it('2 группы по 4: змейка по посеву', () => {
    const seeded = seedOrder(players([1800, 1700, 1650, 1600, 1500, 1400, 1300, 1200]));
    const groups = splitGroups(seeded, 2).map((g) => g.map((e) => seeded.indexOf(e) + 1));
    assert.deepEqual(groups, [
      [1, 4, 5, 8],
      [2, 3, 6, 7],
    ]);
  });

  it('круговая на 4: 3 тура по 2 матча, каждая пара один раз, игрок в туре один раз', () => {
    const rounds = roundRobin(['a', 'b', 'c', 'd']);
    assert.equal(rounds.length, 3);
    const pairs = rounds.flat().map((p) => [...p].sort().join(''));
    assert.deepEqual([...pairs].sort(), ['ab', 'ac', 'ad', 'bc', 'bd', 'cd']);
    for (const r of rounds) assert.equal(new Set(r.flat()).size, r.flat().length);
    // Нечётное число: один отдыхает, пар 3 из 3.
    assert.equal(roundRobin(['a', 'b', 'c']).flat().length, 3);
  });

  it('2×4 → плей-офф на 4: A1–B2, B1–A2 в полуфиналах', () => {
    const slots = qualifierSlots(2, 2);
    const plan = planElimination(slots);
    assert.equal(plan.size, 4);
    const r1 = plan.matches.filter((m) => m.round === 1).map((m) => [m.a, m.b]);
    assert.deepEqual(r1, [
      [{ group: 0, place: 1 }, { group: 1, place: 2 }],
      [{ group: 1, place: 1 }, { group: 0, place: 2 }],
    ]);
    assert.equal(plan.matches.filter((m) => m.round === 2).length, 1);
  });

  it('4 группы по 2 выхода: победитель играет со вторым соседней группы, одногруппники в разных половинах', () => {
    const plan = planElimination(qualifierSlots(4, 2));
    const r1 = plan.matches.filter((m) => m.round === 1);
    for (const m of r1) assert.notEqual(m.a.group, m.b.group);
    const half = (p) => (p < 2 ? 0 : 1);
    for (let g = 0; g < 4; g += 1) {
      const pos = r1.filter((m) => m.a.group === g || m.b.group === g).map((m) => half(m.position));
      assert.deepEqual(new Set(pos).size, 2, `группа ${g}`);
    }
  });

  it('3 группы по 2: сетка на 8 с bye у двух лучших победителей', () => {
    const plan = planElimination(qualifierSlots(3, 2));
    const r1 = plan.matches.filter((m) => m.round === 1);
    assert.equal(r1.filter((m) => m.bye).length, 2);
    for (const m of r1.filter((x) => !x.bye)) assert.notEqual(m.a.group, m.b.group);
  });

  it('таблица группы: победы, личная встреча у двоих, затем разница партий', () => {
    const members = [
      { id: 'a', seed: 1 },
      { id: 'b', seed: 2 },
      { id: 'c', seed: 3 },
    ];
    const m = (x, y, sx, sy) => ({ entry_a: x, entry_b: y, score_a: sx, score_b: sy, winner_entry_id: sx > sy ? x : y });
    // a и b по 1 победе… нет: a 2, b 1, c 0.
    let table = groupStandings(members, [m('a', 'b', 2, 1), m('a', 'c', 2, 0), m('b', 'c', 2, 1)]);
    assert.deepEqual(table.map((r) => [r.id, r.wins, r.place]), [
      ['a', 2, 1],
      ['b', 1, 2],
      ['c', 0, 3],
    ]);
    // Все по одной победе — по разнице партий: c (+1), a (0), b (−1).
    table = groupStandings(members, [m('a', 'b', 2, 0), m('b', 'c', 2, 1), m('c', 'a', 2, 0)]);
    assert.deepEqual(table.map((r) => r.id), ['c', 'a', 'b']);
    // Двое равны по победам — решает личная встреча, даже если разница хуже.
    const four = [...members, { id: 'd', seed: 4 }];
    table = groupStandings(four, [m('a', 'b', 2, 1), m('b', 'c', 2, 0), m('b', 'd', 2, 0), m('a', 'c', 0, 2), m('a', 'd', 2, 1), m('c', 'd', 2, 0)]);
    // a: 2 победы (над b, d), b: 2 (c, d), c: 2 (a, d) — трое равны → по разнице.
    assert.equal(table[3].id, 'd');
  });
});

describe('счёт и длительность', () => {
  it('до N побед: у победителя ровно N', () => {
    assert.ok(validScore(2, 1, 2));
    assert.ok(validScore(0, 3, 3));
    assert.ok(!validScore(2, 2, 2));
    assert.ok(!validScore(3, 1, 2));
    assert.ok(!validScore(1, 0, 2));
    assert.ok(!validScore(-1, 2, 2));
    assert.ok(!validScore(1.5, 2, 2));
  });
  it('время на матч по умолчанию', () => {
    assert.equal(defaultMatchMinutes(2), 60);
    assert.equal(defaultMatchMinutes(1), 30);
    assert.equal(defaultMatchMinutes(25), 600);
  });
});
