/**
 * Разбой пирамиды для главной гостя (DESIGN §6): одна детерминированная симуляция при загрузке, дальше кадры
 * берутся по прогрессу прокрутки (назад — шары собираются обратно). Без случайности и без зависимости от
 * частоты кадров: шаг физики фиксирован, кадр записывается каждые 1/60 с.
 *
 * Единицы — длина игрового поля: поле 1 × 0,5 (пирамида 12 футов, 3550 × 1775 мм), центр в (0,5; 0,25).
 * Шары крупнее настоящих (на телефоне настоящий шар — 5 px), лузы — по углам и в середине длинных бортов.
 *
 * simulateBreak() → { frames: Float32Array, count, balls, r, pockets }
 *   frames[(f * balls + i) * 3 + k]: k = 0 — x, 1 — y, 2 — видимость (1 на сукне, 0 — в лузе, между — закатывается).
 *   Шар 0 — биток, 1–15 — пирамида с номерами.
 */

export const FIELD = Object.freeze({ w: 1, h: 0.5 });
export const BALL_R = 0.021;

export const POCKETS = Object.freeze([
  [0, 0], [0.5, 0], [1, 0],
  [0, 0.5], [0.5, 0.5], [1, 0.5],
]);

const DT = 1 / 240;
const PER_FRAME = 4; // 240 / 4 = 60 кадров в секунду
const MAX_FRAMES = 480; // 8 с — предел; обычно сукно чистое раньше
const SINK_FRAMES = 9; // столько кадров шар «закатывается» в лузу

/** Пирамида: вершина к битку, 5 рядов, шары касаются друг друга. */
export function rack(r = BALL_R) {
  const out = [];
  const apex = 0.72;
  const step = r * 2 * Math.cos(Math.PI / 6) + 0.0004;
  let n = 1;
  for (let row = 0; row < 5; row += 1) {
    for (let k = 0; k <= row; k += 1) {
      out.push({ n, x: apex + row * step, y: FIELD.h / 2 + (k - row / 2) * (2 * r + 0.0004) });
      n += 1;
    }
  }
  return out;
}

export function simulateBreak() {
  const r = BALL_R;
  // Биток чуть ниже оси: разбой несимметричный, как живой
  const balls = [{ n: 0, x: 0.22, y: FIELD.h / 2 + 0.006, vx: 2.9, vy: -0.035, in: 1, sink: -1, px: 0, py: 0 }];
  for (const b of rack(r)) balls.push({ ...b, vx: 0, vy: 0, in: 1, sink: -1, px: 0, py: 0 });
  const N = balls.length;
  const frames = new Float32Array(MAX_FRAMES * N * 3);
  const record = (f) => {
    for (let i = 0; i < N; i += 1) {
      const b = balls[i];
      const o = (f * N + i) * 3;
      frames[o] = b.x;
      frames[o + 1] = b.y;
      frames[o + 2] = b.in;
    }
  };

  const capture = (b) => {
    for (const [px, py] of POCKETS) {
      const lim = px === 0.5 ? r * 1.9 : r * 2.3;
      if ((b.x - px) ** 2 + (b.y - py) ** 2 < lim * lim) return [px, py];
    }
    return null;
  };
  const nearest = (b) => {
    let best = POCKETS[0];
    let d = Infinity;
    for (const p of POCKETS) {
      const dd = (b.x - p[0]) ** 2 + (b.y - p[1]) ** 2;
      if (dd < d) {
        d = dd;
        best = p;
      }
    }
    return best;
  };

  let f = 0;
  let t = 0;
  record(f);
  while (f < MAX_FRAMES - 1) {
    for (let s = 0; s < PER_FRAME; s += 1) {
      t += DT;
      for (const b of balls) {
        if (b.sink >= 0) continue;
        // Трение сукна; после разбоя шары мягко «ищут» ближайшую лузу, чтобы к концу сукно было чистым
        const sp = Math.hypot(b.vx, b.vy);
        if (t > 0.9) {
          const [px, py] = nearest(b);
          const dx = px - b.x;
          const dy = py - b.y;
          const d = Math.hypot(dx, dy) || 1;
          const pull = t > 2.2 ? 3.2 : 1.1;
          b.vx += (dx / d) * pull * DT;
          b.vy += (dy / d) * pull * DT;
        }
        const drag = sp > 0 ? Math.max(0, 1 - (0.55 * DT) / Math.max(sp, 0.05)) : 1;
        b.vx *= drag;
        b.vy *= drag;
        b.x += b.vx * DT;
        b.y += b.vy * DT;
        const hit = capture(b);
        if (hit) {
          b.sink = 0;
          [b.px, b.py] = hit;
          continue;
        }
        // Борта: отскок с потерей скорости
        if (b.x < r) {
          b.x = r;
          b.vx = Math.abs(b.vx) * 0.78;
        } else if (b.x > FIELD.w - r) {
          b.x = FIELD.w - r;
          b.vx = -Math.abs(b.vx) * 0.78;
        }
        if (b.y < r) {
          b.y = r;
          b.vy = Math.abs(b.vy) * 0.78;
        } else if (b.y > FIELD.h - r) {
          b.y = FIELD.h - r;
          b.vy = -Math.abs(b.vy) * 0.78;
        }
      }
      // Соударения шаров: упругие, массы равные
      for (let i = 0; i < N; i += 1) {
        const a = balls[i];
        if (a.sink >= 0) continue;
        for (let j = i + 1; j < N; j += 1) {
          const b = balls[j];
          if (b.sink >= 0) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= 4 * r * r || d2 === 0) continue;
          const d = Math.sqrt(d2);
          const nx = dx / d;
          const ny = dy / d;
          const overlap = 2 * r - d;
          a.x -= (nx * overlap) / 2;
          a.y -= (ny * overlap) / 2;
          b.x += (nx * overlap) / 2;
          b.y += (ny * overlap) / 2;
          const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
          if (rel <= 0) continue;
          const imp = rel * 0.96;
          a.vx -= imp * nx;
          a.vy -= imp * ny;
          b.vx += imp * nx;
          b.vy += imp * ny;
        }
      }
      // Раздвижка соударений могла вытолкнуть шар за резину — вернуть на сукно
      for (const b of balls) {
        if (b.sink >= 0) continue;
        b.x = Math.min(FIELD.w - r, Math.max(r, b.x));
        b.y = Math.min(FIELD.h - r, Math.max(r, b.y));
      }
    }
    // Закатывание в лузу: шар съезжает к центру лузы и гаснет
    for (const b of balls) {
      if (b.sink < 0 || b.in <= 0) continue;
      b.sink += 1;
      const k = b.sink / SINK_FRAMES;
      b.x += (b.px - b.x) * 0.45;
      b.y += (b.py - b.y) * 0.45;
      b.in = Math.max(0, 1 - k);
    }
    // Запасной путь: всё, что ещё на сукне к концу 5-й секунды, катится прямо в ближайшую лузу
    if (t > 5) {
      for (const b of balls) {
        if (b.sink >= 0) continue;
        const [px, py] = nearest(b);
        b.vx = (px - b.x) * 4;
        b.vy = (py - b.y) * 4;
      }
    }
    f += 1;
    record(f);
    if (balls.every((b) => b.in <= 0)) break;
  }
  return { frames: frames.subarray(0, (f + 1) * N * 3), count: f + 1, balls: N, r, pockets: POCKETS };
}
