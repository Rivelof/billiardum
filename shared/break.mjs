/**
 * Бильярдум — «разбой при прокрутке» без фреймворка (DESIGN §6, решение №127): главная сайта (остров) и,
 * при желании, главная гостя. Перенесено из web/guest/src/lib/break-sim.js и components/BreakTable.jsx
 * без изменения физики: одна детерминированная симуляция при загрузке, дальше кадры берутся по прогрессу
 * прокрутки (назад — шары собираются обратно).
 *
 *   simulateBreak()           → { frames: Float32Array, count, balls, r, pockets }
 *   breakSvg()                → '<svg …>' собранная пирамида на столе: серверный рендер и prefers-reduced-motion
 *   mountBreak(canvas, opts?) → () => void  рисует разбой на canvas, возвращает отписку
 *
 * Единицы — длина игрового поля: поле 1 × 0,5 (пирамида 12 футов, 3550 × 1775 мм), центр в (0,5; 0,25).
 * frames[(f * balls + i) * 3 + k]: k = 0 — x, 1 — y, 2 — видимость (1 на сукне, 0 — в лузе).
 * Шар 0 — биток, 1–15 — пирамида с номерами.
 */

export const FIELD = Object.freeze({ w: 1, h: 0.5 });
export const BALL_R = 0.021;
/** Стол с бортом: 3890 × 2115 мм, борт 170 мм. */
export const BREAK_ASPECT = 2115 / 3890;
const RAIL = 170 / 3890;

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

// ---------- рисунок: собранная пирамида (сервер, reduced-motion, до загрузки острова) ----------

/**
 * Стол сверху горизонтально с собранной пирамидой и битком — та же геометрия, что у canvas.
 * Цвета — классы brk-* из hall.css (токены зала), без атрибутов style.
 * @param {{ uid?: string, label?: string }} [options]
 * @returns {string} SVG 3890 × 2115, только константы — безопасно для innerHTML
 */
export function breakSvg(options = {}) {
  const uid = options.uid ?? 'brk';
  const W = 3890;
  const H = 2115;
  const rail = 170;
  const unit = W - 2 * rail;
  const X = (x) => +(rail + x * unit).toFixed(1);
  const Y = (y) => +(rail + y * unit).toFixed(1);
  const r = +(BALL_R * unit).toFixed(1);
  const pockets = POCKETS.map(([px, py]) => [X(px), Y(py), px === 0.5]);
  const marks = [];
  for (const x of [0.125, 0.25, 0.375, 0.625, 0.75, 0.875]) marks.push([X(x), rail / 2], [X(x), H - rail / 2]);
  for (const y of [0.125, 0.25, 0.375]) marks.push([rail / 2, Y(y)], [W - rail / 2, Y(y)]);
  const balls = [{ n: 0, x: 0.22, y: FIELD.h / 2 }, ...rack()];
  const ball = ({ n, x, y }) => {
    const cx = X(x);
    const cy = Y(y);
    const num = n === 0
      ? `<circle class="brk-cue" cx="${cx}" cy="${cy}" r="${(r * 0.22).toFixed(1)}"/>`
      : `<text class="brk-num" x="${cx}" y="${cy}" font-size="${Math.round(r * (n > 9 ? 0.92 : 1.05))}" text-anchor="middle" dominant-baseline="central">${n}</text>`;
    return `<circle class="brk-shadow" cx="${cx + r * 0.25}" cy="${cy + r * 0.35}" r="${r}"/>` +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${uid}-b)"/>${num}`;
  };
  const label = options.label ? `<title>${options.label}</title>` : '';
  return (
    `<svg class="brk" viewBox="0 0 ${W} ${H}" role="img" aria-hidden="${options.label ? 'false' : 'true'}" focusable="false">${label}` +
    '<defs>' +
    `<linearGradient id="${uid}-r" x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="brk-r1"/><stop offset="0.45" class="brk-r2"/><stop offset="1" class="brk-r3"/></linearGradient>` +
    `<radialGradient id="${uid}-c" cx="0.5" cy="0.5" r="0.62"><stop offset="0" class="brk-c1"/><stop offset="1" class="brk-c2"/></radialGradient>` +
    `<radialGradient id="${uid}-l" cx="0.5" cy="0.5" r="0.5"><stop offset="0" class="brk-l1" stop-opacity="0.3"/><stop offset="1" class="brk-l1" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="${uid}-b" cx="0.33" cy="0.3" r="0.7"><stop offset="0" class="brk-b1"/><stop offset="0.55" class="brk-b2"/><stop offset="1" class="brk-b3"/></radialGradient>` +
    '</defs>' +
    `<rect width="${W}" height="${H}" rx="${Math.round(H * 0.06)}" fill="url(#${uid}-r)"/>` +
    `<rect class="brk-edge" x="31" y="31" width="${W - 62}" height="${H - 62}" rx="${Math.round(H * 0.048)}"/>` +
    `<g class="brk-brass">${pockets.map(([x, y, mid]) => `<circle cx="${x}" cy="${y}" r="${Math.round(unit * (mid ? 0.044 : 0.05))}"/>`).join('')}</g>` +
    `<rect x="${rail}" y="${rail}" width="${unit}" height="${unit / 2}" fill="url(#${uid}-c)"/>` +
    `<rect x="${rail}" y="${rail}" width="${unit}" height="${unit / 2}" fill="url(#${uid}-l)"/>` +
    `<rect class="brk-cushion" x="${rail + 19}" y="${rail + 19}" width="${unit - 38}" height="${unit / 2 - 38}"/>` +
    `<g class="brk-pocket">${pockets.map(([x, y, mid]) => `<circle cx="${x}" cy="${y}" r="${Math.round(unit * (mid ? 0.03 : 0.034))}"/>`).join('')}</g>` +
    `<g class="brk-mark">${marks.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="17"/>`).join('')}</g>` +
    balls.map(ball).join('') +
    '</svg>'
  );
}

// ---------- canvas: разбой по прокрутке ----------

function rgb(hex) {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? [...h].map((c) => c + c).join('') : h.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) || 0);
}
const alpha = (hex, a) => `rgb(${rgb(hex).join(' ')} / ${a})`;
const shade = (hex, k) => `rgb(${rgb(hex).map((c) => Math.round(k > 0 ? c + (255 - c) * k : c * (1 + k))).join(' ')})`;

/**
 * Разбой на canvas по прогрессу прокрутки первого экрана (как BreakTable гостя). Короткая страница без
 * прокрутки — разбой проигрывается один раз сам. prefers-reduced-motion — стоит собранная пирамида.
 * Рисуется только при смене кадра.
 * @param {HTMLCanvasElement} canvas
 * @param {{ onReady?: () => void }} [options] onReady — первый кадр нарисован (можно спрятать картинку-заглушку)
 * @returns {() => void}
 */
export function mountBreak(canvas, options = {}) {
  const ctx = canvas?.getContext?.('2d');
  if (!ctx) return () => {};
  const sim = simulateBreak();
  const N = sim.balls;
  const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const css = getComputedStyle(canvas);
  const tok = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  const C = {
    bg: tok('--hall-bg', '#15100C'),
    rail: tok('--hall-rail', '#4A2F1C'),
    railHi: tok('--hall-rail-hi', '#8A5B34'),
    brass: tok('--hall-brass', '#C99A55'),
    cloth: tok('--hall-cloth-on', '#2F9A63'),
    clothOff: tok('--hall-cloth-off', '#1E4A34'),
    ivory: tok('--hall-text', '#F0E6D6'),
    lamp: tok('--lamp', '#F4B860'),
  };
  const textFont = tok('--font-text', 'Geologica, system-ui, sans-serif');

  let W = 0;
  let H = 0;
  let dpr = 1;
  let rail = 0;
  let unit = 0;
  let table = null;
  let shown = -1;
  let raf = 0;
  let auto = 0;
  let ready = false;

  const toX = (x) => rail + x * unit;
  const toY = (y) => rail + y * unit;

  function paintTable() {
    const off = document.createElement('canvas');
    off.width = Math.round(W * dpr);
    off.height = Math.round(H * dpr);
    const g = off.getContext('2d');
    g.scale(dpr, dpr);
    const R = Math.min(W, H) * 0.06;
    const wood = g.createLinearGradient(0, 0, W, H);
    wood.addColorStop(0, C.railHi);
    wood.addColorStop(0.45, C.rail);
    wood.addColorStop(1, C.bg);
    g.fillStyle = wood;
    g.beginPath();
    g.roundRect(0, 0, W, H, R);
    g.fill();
    g.strokeStyle = C.railHi;
    g.globalAlpha = 0.5;
    g.lineWidth = Math.max(1, rail * 0.12);
    g.beginPath();
    g.roundRect(rail * 0.18, rail * 0.18, W - rail * 0.36, H - rail * 0.36, R * 0.8);
    g.stroke();
    g.globalAlpha = 1;
    g.fillStyle = C.brass;
    for (const [px, py] of POCKETS) {
      g.beginPath();
      g.arc(toX(px), toY(py), unit * (px === 0.5 ? 0.044 : 0.05), 0, Math.PI * 2);
      g.fill();
    }
    const fw = unit * FIELD.w;
    const fh = unit * FIELD.h;
    const cloth = g.createRadialGradient(W / 2, H / 2, fh * 0.1, W / 2, H / 2, fw * 0.62);
    cloth.addColorStop(0, C.cloth);
    cloth.addColorStop(1, C.clothOff);
    g.fillStyle = cloth;
    g.fillRect(rail, rail, fw, fh);
    const lamp = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, fw * 0.5);
    lamp.addColorStop(0, alpha(C.lamp, 0.3));
    lamp.addColorStop(1, alpha(C.lamp, 0));
    g.fillStyle = lamp;
    g.fillRect(rail, rail, fw, fh);
    g.strokeStyle = C.bg;
    g.globalAlpha = 0.35;
    g.lineWidth = Math.max(1, rail * 0.22);
    g.strokeRect(rail + g.lineWidth / 2, rail + g.lineWidth / 2, fw - g.lineWidth, fh - g.lineWidth);
    g.globalAlpha = 1;
    g.fillStyle = C.bg;
    for (const [px, py] of POCKETS) {
      g.beginPath();
      g.arc(toX(px), toY(py), unit * (px === 0.5 ? 0.03 : 0.034), 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = C.ivory;
    g.globalAlpha = 0.6;
    const dot = Math.max(1, rail * 0.1);
    for (const x of [0.125, 0.25, 0.375, 0.625, 0.75, 0.875]) {
      for (const y of [rail / 2, H - rail / 2]) {
        g.beginPath();
        g.arc(toX(x), y, dot, 0, Math.PI * 2);
        g.fill();
      }
    }
    for (const y of [0.125, 0.25, 0.375]) {
      for (const x of [rail / 2, W - rail / 2]) {
        g.beginPath();
        g.arc(x, toY(y), dot, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.globalAlpha = 1;
    return off;
  }

  function ball(n, x, y, k) {
    const r = sim.r * unit * (0.55 + 0.45 * k);
    ctx.globalAlpha = Math.min(1, k * 1.6);
    ctx.fillStyle = 'rgb(0 0 0 / 0.35)';
    ctx.beginPath();
    ctx.ellipse(x + r * 0.25, y + r * 0.35, r, r * 0.85, 0, 0, Math.PI * 2);
    ctx.fill();
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
    g.addColorStop(0, shade(C.ivory, 0.7));
    g.addColorStop(0.55, C.ivory);
    g.addColorStop(1, shade(C.ivory, -0.28));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (n === 0) {
      ctx.fillStyle = C.brass;
      ctx.beginPath();
      ctx.arc(x, y, r * 0.22, 0, Math.PI * 2);
      ctx.fill();
    } else if (r >= 6.5) {
      ctx.fillStyle = C.bg;
      ctx.font = `700 ${Math.round(r * (n > 9 ? 0.92 : 1.05))}px ${textFont}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(n), x, y + r * 0.06);
    }
    ctx.globalAlpha = 1;
  }

  function draw(f) {
    if (f === shown || !table) return;
    shown = f;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(table, 0, 0, W, H);
    const base = f * N * 3;
    for (let i = N - 1; i >= 0; i -= 1) {
      const o = base + i * 3;
      const k = sim.frames[o + 2];
      if (k <= 0) continue;
      ball(i, toX(sim.frames[o]), toY(sim.frames[o + 1]), k);
    }
    if (!ready) {
      ready = true;
      options.onReady?.();
    }
  }

  let reach = 0;
  const range = () => Math.max(1, Math.min(Math.max(100, reach), innerHeight * 0.85, document.documentElement.scrollHeight - innerHeight));
  const frameFor = (p) => Math.round(Math.min(1, Math.max(0, p)) * (sim.count - 1));
  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      draw(frameFor(scrollY / range()));
    });
  };

  function layout() {
    const box = canvas.getBoundingClientRect();
    if (!box.width) return;
    W = box.width;
    H = W * BREAK_ASPECT;
    dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    rail = W * RAIL;
    unit = W - 2 * rail;
    reach = box.top + scrollY + H * 0.45;
    table = paintTable();
    shown = -1;
    draw(reduce ? 0 : frameFor(scrollY / range()));
  }

  layout();
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => layout()) : null;
  ro?.observe(canvas);
  if (!reduce) {
    if (document.documentElement.scrollHeight - innerHeight < 40) {
      const t0 = performance.now() + 700;
      const step = (now) => {
        const p = (now - t0) / ((sim.count / 60) * 1000);
        draw(frameFor(p));
        if (p < 1) auto = requestAnimationFrame(step);
      };
      auto = requestAnimationFrame(step);
    } else addEventListener('scroll', onScroll, { passive: true });
  }
  return () => {
    ro?.disconnect();
    removeEventListener('scroll', onScroll);
    cancelAnimationFrame(raf);
    cancelAnimationFrame(auto);
  };
}
