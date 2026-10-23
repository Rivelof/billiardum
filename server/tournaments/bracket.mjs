// Сетка турнира (контракт M4 §1 п. 11, PRODUCT §14): чистые функции без базы.
//
// Всё детерминировано: одинаковый вход — одинаковая сетка (тесты сравнивают структуру).
//
//   seedOrder(entries)                 — посев по рейтингу дисциплины (выше — раньше), при равенстве —
//                                        кто раньше подтвердил запись, затем id.
//   bracketSize(n)                     — размер олимпийской сетки: ближайшая степень двойки ≥ n.
//   standardOrder(size)                — порядок посевов в первом раунде: [1, 8, 4, 5, 2, 7, 3, 6] для 8.
//   planElimination(slots)             — олимпийская сетка по слотам посева (null — пусто, bye у соперника).
//   splitGroups(seeded, groupCount)    — посев «змейкой» по группам.
//   roundRobin(members)                — круговая в группе (метод круга): туры и пары.
//   qualifierSlots(groupCount, advance)— кто выходит в плей-офф в порядке посева плей-офф.
//   groupStandings(members, matches)   — таблица группы: победы, личная встреча, разница партий, партии, посев.
//   validScore(a, b, raceTo)           — счёт матча «до N побед».
//   roundTitle(round, totalRounds)     — «Финал», «Полуфинал», «1/4 финала», …

export const GROUP_LETTERS = 'ABCDEFGHIJKLMNOP';

/** Посев: рейтинг по убыванию; равный — раньше подтверждённая запись, затем id (стабильно). */
export function seedOrder(entries) {
  return [...entries].sort((x, y) => {
    const r = (Number(y.rating) || 0) - (Number(x.rating) || 0);
    if (r !== 0) return r;
    const tx = x.confirmed_at ? new Date(x.confirmed_at).getTime() : 0;
    const ty = y.confirmed_at ? new Date(y.confirmed_at).getTime() : 0;
    if (tx !== ty) return tx - ty;
    return String(x.id) < String(y.id) ? -1 : String(x.id) > String(y.id) ? 1 : 0;
  });
}

export function bracketSize(n) {
  if (!Number.isInteger(n) || n < 2) throw new Error('bracketSize: нужно ≥ 2 участников');
  let size = 2;
  while (size < n) size *= 2;
  return size;
}

/**
 * Стандартная расстановка посевов: первый и второй встречаются только в финале,
 * первые четыре — не раньше полуфинала и т. д. Сумма соседей в паре = size + 1.
 */
export function standardOrder(size) {
  if (!Number.isInteger(size) || size < 2 || (size & (size - 1)) !== 0) throw new Error('standardOrder: степень двойки');
  let order = [1, 2];
  while (order.length < size) {
    const n = order.length * 2;
    const next = [];
    for (const s of order) next.push(s, n + 1 - s);
    order = next;
  }
  return order;
}

/**
 * Олимпийская сетка.
 * @param {Array<any|null>} slots слоты в порядке посева (индекс 0 — первый посев); null — пусто
 *   (соперник проходит дальше без игры, bye). Слот — что угодно: id записи или источник «группа, место».
 * @returns {{ size: number, rounds: number, matches: Array<{ round: number, position: number, a: any|null,
 *   b: any|null, bye: boolean, next: { round: number, position: number, slot: 'a'|'b' } | null }> }}
 *   Позиции считаются с 0 внутри раунда; победитель матча (r, p) идёт в (r + 1, ⌊p/2⌋), слот a при чётном p.
 */
export function planElimination(slots) {
  const n = slots.length;
  const size = bracketSize(n);
  const order = standardOrder(size);
  const rounds = Math.log2(size);
  const at = (seed) => (seed <= n ? (slots[seed - 1] ?? null) : null);
  const matches = [];
  for (let round = 1; round <= rounds; round += 1) {
    const count = size / 2 ** round;
    for (let position = 0; position < count; position += 1) {
      const next = round < rounds ? { round: round + 1, position: Math.floor(position / 2), slot: position % 2 === 0 ? 'a' : 'b' } : null;
      if (round === 1) {
        const a = at(order[position * 2]);
        const b = at(order[position * 2 + 1]);
        if (a === null && b === null) throw new Error('planElimination: пустая пара');
        matches.push({ round, position, a, b, bye: a === null || b === null, seeds: [order[position * 2], order[position * 2 + 1]], next });
      } else {
        matches.push({ round, position, a: null, b: null, bye: false, seeds: null, next });
      }
    }
  }
  return { size, rounds, matches };
}

/** Посев «змейкой»: 1→A, 2→B, 3→B, 4→A, 5→A … Возвращает массив групп (списки в порядке посева). */
export function splitGroups(seeded, groupCount) {
  if (!Number.isInteger(groupCount) || groupCount < 2) throw new Error('splitGroups: групп ≥ 2');
  if (seeded.length < groupCount * 2) throw new Error('splitGroups: в группе нужно ≥ 2 участников');
  const groups = Array.from({ length: groupCount }, () => []);
  seeded.forEach((e, i) => {
    const lap = Math.floor(i / groupCount);
    const k = i % groupCount;
    groups[lap % 2 === 0 ? k : groupCount - 1 - k].push(e);
  });
  return groups;
}

/**
 * Круговая (метод круга, первый закреплён): каждый с каждым один раз.
 * @returns {Array<Array<[any, any]>>} туры; в туре пары без повторов игрока; при нечётном числе
 *   участников один отдыхает (пары с отдыхающим не возвращаются).
 */
export function roundRobin(members) {
  const list = [...members];
  if (list.length < 2) return [];
  if (list.length % 2 === 1) list.push(null);
  const n = list.length;
  const rounds = [];
  let ring = list.slice(1);
  for (let r = 0; r < n - 1; r += 1) {
    const cur = [list[0], ...ring];
    const pairs = [];
    for (let i = 0; i < n / 2; i += 1) {
      const a = cur[i];
      const b = cur[n - 1 - i];
      if (a === null || b === null) continue;
      // Чередуем «хозяина», чтобы первый посев не всегда был слева.
      pairs.push(r % 2 === 0 || i > 0 ? [a, b] : [b, a]);
    }
    rounds.push(pairs);
    ring = [ring[ring.length - 1], ...ring.slice(0, -1)];
  }
  return rounds;
}

/**
 * Источники слотов плей-офф в порядке посева: { group, place } (группа с 0, место с 1).
 * Победители групп — посевы 1…G; вторые места ставятся так, чтобы в первом раунде победитель
 * группы g играл со вторым местом соседней группы (g^1 при чётном G, иначе следующей по кругу),
 * а участники одной группы оказывались в разных половинах сетки. Места 3+ — по группам подряд.
 */
export function qualifierSlots(groupCount, advance) {
  if (!Number.isInteger(advance) || advance < 1 || advance > 4) throw new Error('qualifierSlots: выход 1–4');
  const total = groupCount * advance;
  if (total < 2) throw new Error('qualifierSlots: в плей-офф нужно ≥ 2');
  const slots = new Array(total).fill(null);
  for (let g = 0; g < groupCount; g += 1) slots[g] = { group: g, place: 1 };
  if (advance >= 2) {
    const size = bracketSize(total);
    const partner = (g) => (groupCount % 2 === 0 ? g ^ 1 : (g + 1) % groupCount);
    for (let g = 0; g < groupCount; g += 1) {
      // Посев g + 1 в первом раунде играет с посевом size − g; туда — второе место группы-партнёра.
      const seed = size - g;
      const src = { group: partner(g), place: 2 };
      if (seed <= total && slots[seed - 1] === null) slots[seed - 1] = src;
    }
    // Что не встало парой (размер сетки больше числа вышедших) — в свободные места по порядку.
    const placed = new Set(slots.filter(Boolean).filter((s) => s.place === 2).map((s) => s.group));
    for (let g = 0; g < groupCount; g += 1) {
      if (placed.has(g)) continue;
      const free = slots.indexOf(null);
      slots[free] = { group: g, place: 2 };
    }
  }
  for (let place = 3; place <= advance; place += 1) {
    for (let g = 0; g < groupCount; g += 1) slots[slots.indexOf(null)] = { group: g, place };
  }
  return slots;
}

/**
 * Таблица группы.
 * @param {Array<{ id: string, seed: number }>} members
 * @param {Array<{ entry_a: string, entry_b: string, score_a: number, score_b: number, winner_entry_id: string }>} matches
 *   сыгранные матчи группы
 * @returns {Array<{ id, seed, played, wins, losses, frames_for, frames_against, place }>}
 */
export function groupStandings(members, matches) {
  const rows = new Map(members.map((m) => [m.id, { id: m.id, seed: m.seed, played: 0, wins: 0, losses: 0, frames_for: 0, frames_against: 0 }]));
  for (const m of matches) {
    const a = rows.get(m.entry_a);
    const b = rows.get(m.entry_b);
    if (!a || !b || !m.winner_entry_id) continue;
    a.played += 1;
    b.played += 1;
    a.frames_for += m.score_a;
    a.frames_against += m.score_b;
    b.frames_for += m.score_b;
    b.frames_against += m.score_a;
    if (m.winner_entry_id === a.id) {
      a.wins += 1;
      b.losses += 1;
    } else {
      b.wins += 1;
      a.losses += 1;
    }
  }
  const headToHead = (x, y) => {
    const m = matches.find((k) => (k.entry_a === x.id && k.entry_b === y.id) || (k.entry_a === y.id && k.entry_b === x.id));
    if (!m?.winner_entry_id) return 0;
    return m.winner_entry_id === x.id ? -1 : 1;
  };
  const list = [...rows.values()];
  list.sort((x, y) => {
    if (y.wins !== x.wins) return y.wins - x.wins;
    // Личная встреча решает только при равенстве двух (у трёх и более — по разнице партий).
    const tied = list.filter((r) => r.wins === x.wins);
    if (tied.length === 2) {
      const h = headToHead(x, y);
      if (h !== 0) return h;
    }
    const dx = x.frames_for - x.frames_against;
    const dy = y.frames_for - y.frames_against;
    if (dy !== dx) return dy - dx;
    if (y.frames_for !== x.frames_for) return y.frames_for - x.frames_for;
    return x.seed - y.seed;
  });
  return list.map((r, i) => ({ ...r, place: i + 1 }));
}

/** Счёт «до N побед»: целые, у победителя ровно N, у проигравшего меньше. */
export function validScore(a, b, raceTo) {
  return (
    Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= 0 && a !== b && Math.max(a, b) === raceTo && Math.min(a, b) < raceTo
  );
}

/** Название раунда олимпийской сетки. */
export function roundTitle(round, totalRounds) {
  const left = totalRounds - round;
  if (left === 0) return 'Финал';
  if (left === 1) return 'Полуфинал';
  return `1/${2 ** left} финала`;
}

export function groupTitle(groupNo) {
  return `Группа ${GROUP_LETTERS[groupNo] ?? groupNo + 1}`;
}

/** Ориентировочная длительность матча «до N»: худший случай 2N − 1 партий по 15 минут плюс 15. */
export function defaultMatchMinutes(raceTo) {
  return Math.min(600, (2 * raceTo - 1) * 15 + 15);
}
