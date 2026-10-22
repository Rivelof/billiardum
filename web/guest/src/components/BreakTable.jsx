import { useEffect, useRef } from 'preact/hooks';
import { simulateBreak, FIELD, POCKETS } from '../lib/break-sim.js';

/**
 * «Разбой при прокрутке» (DESIGN §6) — главная гостя, отдельный чанк. Стол сверху на canvas: ореховый борт,
 * латунные накладки, сукно под лампой, 15 шаров русской пирамиды (слоновая кость с номерами) и биток.
 * Кадр берётся из предрасчёта по прогрессу прокрутки первого экрана: вниз — разбой и шары в лузах,
 * вверх — шары собираются обратно. Короткая страница без прокрутки — разбой проигрывается один раз сам.
 * prefers-reduced-motion — стоит собранная пирамида. Рисуется только при смене кадра.
 */
const ASPECT = 2115 / 3890; // стол 12 футов с бортом
const RAIL = 170 / 3890;

/** Цвета токенов (hex) для canvas: прозрачность и оттенок светлее/темнее без color-mix. */
function rgb(hex) {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? [...h].map((c) => c + c).join('') : h.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) || 0);
}
const alpha = (hex, a) => `rgb(${rgb(hex).join(' ')} / ${a})`;
const shade = (hex, k) => `rgb(${rgb(hex).map((c) => Math.round(k > 0 ? c + (255 - c) * k : c * (1 + k))).join(' ')})`;

export function BreakTable({ class: cls = '' }) {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext?.('2d');
    if (!ctx) return undefined;
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

    let W = 0;
    let H = 0;
    let dpr = 1;
    let rail = 0;
    let unit = 0; // пикселей на единицу поля
    let table = null;
    let shown = -1;
    let raf = 0;
    let auto = 0;

    const toX = (x) => rail + x * unit;
    const toY = (y) => rail + y * unit;

    function paintTable() {
      const off = document.createElement('canvas');
      off.width = Math.round(W * dpr);
      off.height = Math.round(H * dpr);
      const g = off.getContext('2d');
      g.scale(dpr, dpr);
      const R = Math.min(W, H) * 0.06;
      // Борт: полированный орех с бликом
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
      // Латунные накладки у луз
      g.fillStyle = C.brass;
      for (const [px, py] of POCKETS) {
        g.beginPath();
        g.arc(toX(px), toY(py), unit * (px === 0.5 ? 0.044 : 0.05), 0, Math.PI * 2);
        g.fill();
      }
      // Сукно: зелёное, мягкая виньетка к бортам
      const fw = unit * FIELD.w;
      const fh = unit * FIELD.h;
      const cloth = g.createRadialGradient(W / 2, H / 2, fh * 0.1, W / 2, H / 2, fw * 0.62);
      cloth.addColorStop(0, C.cloth);
      cloth.addColorStop(1, C.clothOff);
      g.fillStyle = cloth;
      g.fillRect(rail, rail, fw, fh);
      // Тёплый конус лампы
      const lamp = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, fw * 0.5);
      lamp.addColorStop(0, alpha(C.lamp, 0.3));
      lamp.addColorStop(1, alpha(C.lamp, 0));
      g.fillStyle = lamp;
      g.fillRect(rail, rail, fw, fh);
      // Резина бортов
      g.strokeStyle = C.bg;
      g.globalAlpha = 0.35;
      g.lineWidth = Math.max(1, rail * 0.22);
      g.strokeRect(rail + g.lineWidth / 2, rail + g.lineWidth / 2, fw - g.lineWidth, fh - g.lineWidth);
      g.globalAlpha = 1;
      // Лузы
      g.fillStyle = C.bg;
      for (const [px, py] of POCKETS) {
        g.beginPath();
        g.arc(toX(px), toY(py), unit * (px === 0.5 ? 0.03 : 0.034), 0, Math.PI * 2);
        g.fill();
      }
      // Прицельные метки на борту
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
      // тень на сукне
      ctx.fillStyle = 'rgb(0 0 0 / 0.35)';
      ctx.beginPath();
      ctx.ellipse(x + r * 0.25, y + r * 0.35, r, r * 0.85, 0, 0, Math.PI * 2);
      ctx.fill();
      // шар из слоновой кости: блик сверху слева
      const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
      g.addColorStop(0, shade(C.ivory, 0.7));
      g.addColorStop(0.55, C.ivory);
      g.addColorStop(1, shade(C.ivory, -0.28));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      if (n === 0) {
        // биток — без номера, с латунной точкой
        ctx.fillStyle = C.brass;
        ctx.beginPath();
        ctx.arc(x, y, r * 0.22, 0, Math.PI * 2);
        ctx.fill();
      } else if (r >= 6.5) {
        ctx.fillStyle = C.bg;
        ctx.font = `700 ${Math.round(r * (n > 9 ? 0.92 : 1.05))}px Geologica, system-ui, sans-serif`;
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
    }

    // Прогресс прокрутки: разбой заканчивается, пока стол ещё на экране (верх стола ушёл за край, видна
    // нижняя половина с лузами), и не позже конца первого экрана; на короткой странице — проигрывается сам
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
      W = box.width;
      H = W * ASPECT;
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
  }, []);

  return <canvas ref={ref} class={`break ${cls}`} role="img" aria-label="Стол сверху: пирамида из 15 шаров, при прокрутке биток разбивает её" />;
}
