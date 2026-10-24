import { Component } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Icon } from '../../components/Icon.jsx';
import { arcPath, HEAT_LEGEND, hourSpan, labelEvery, niceTicks, ringArcs } from '../../lib/dashboard.js';
import { dayLong, dayShort, weekday, WEEKDAY_LONG } from '../../lib/period.js';

/**
 * Лёгкие SVG-графики дашборда (M5.2, §3): столбцы с разбивкой, линии, кольцо, тепловая карта.
 * Без библиотек; цвета — токены --viz-* (styles/dashboard.css, обе темы, проверены на контраст и различимость).
 * Подсказка — при наведении, касании и с клавиатуры (стрелки); у каждого графика — таблица-дубль «Показать таблицей».
 * Тяжёлый слой (столбцы) не перерисовывается при движении указателя: он в Static.
 */

/** Не перерисовывает детей, пока не изменился deps (366 столбцов не перерисовываются на каждое движение мыши). */
class Static extends Component {
  shouldComponentUpdate(next) {
    return next.deps !== this.props.deps;
  }
  render() {
    return this.props.children;
  }
}

/** Ширина элемента (ResizeObserver). */
export function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setWidth(Math.round(el.getBoundingClientRect().width));
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Легенда: значок как у метки (прямоугольник для столбцов, линия для линий) и подпись текстом. */
export function Legend({ items, kind = 'rect' }) {
  if (!items?.length) return null;
  return (
    <ul class="vlegend">
      {items.map((it) => (
        <li key={it.key}>
          <span class={`vlegend__mark vlegend__mark--${kind} ${it.cls}`} aria-hidden="true" />
          {it.label}
          {it.value ? <b class="vlegend__value">{it.value}</b> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Карточка графика: заголовок, легенда, кнопки «Показать таблицей» и «Скачать CSV», сам график или пустое состояние.
 */
export function ChartCard({ id, title, sub, legend, onExport, exporting, table, empty, emptyText = 'За этот период игр не было.', children, busy }) {
  const [open, setOpen] = useState(false);
  const tableId = `${id}-table`;
  return (
    <section class={`vcard${busy ? ' vcard--busy' : ''}`} aria-labelledby={`${id}-title`} aria-busy={busy ? 'true' : undefined}>
      <div class="vcard__head">
        <div>
          <h3 class="vcard__title" id={`${id}-title`}>
            {title}
          </h3>
          {sub ? <p class="vcard__sub">{sub}</p> : null}
        </div>
        <div class="vcard__tools">
          {table && !empty ? (
            <button type="button" class="btn btn--quiet btn--sm" aria-expanded={open ? 'true' : 'false'} aria-controls={tableId} onClick={() => setOpen((o) => !o)}>
              <Icon name="list" />
              {open ? 'Скрыть таблицу' : 'Показать таблицей'}
            </button>
          ) : null}
          {onExport && !empty ? (
            <button type="button" class="btn btn--quiet btn--sm" onClick={onExport} disabled={exporting} aria-label={`Скачать CSV: ${title}`}>
              <Icon name="download" />
              {exporting ? 'Готовим файл…' : 'CSV'}
            </button>
          ) : null}
        </div>
      </div>
      {empty ? (
        <p class="vcard__empty">{emptyText}</p>
      ) : (
        <>
          {legend}
          {children}
          {table ? (
            <div id={tableId} class="vcard__table" hidden={!open}>
              {open ? table() : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

const H = 200; // высота поля графика без оси дат
const AXIS = 28; // полоса подписей дат
const TOP = 10;

/** Столбец со скруглённым верхом (4 px) и прямым низом у базовой линии. */
function topRounded(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h);
  if (h <= 0 || w <= 0) return '';
  return `M${x} ${y + h}V${y + rr}Q${x} ${y} ${x + rr} ${y}H${x + w - rr}Q${x + w} ${y} ${x + w} ${y + rr}V${y + h}Z`;
}

/** Подпись даты под столбцом: у краёв прижимается внутрь, чтобы не обрезаться. */
function xLabelPos(x, plotWidth) {
  if (x < 28) return { x: 2, 'text-anchor': 'start' };
  if (x > plotWidth - 32) return { x: plotWidth - 2, 'text-anchor': 'end' };
  return { x, 'text-anchor': 'middle' };
}

/** Ось значений слева: не прокручивается вместе с графиком. */
export function axisWidth(ticks, format) {
  return Math.max(36, Math.min(96, Math.max(...ticks.map((t) => String(format(t)).length)) * 7.2 + 10));
}
function YAxis({ ticks, max, format, width }) {
  return (
    <svg class="vaxis" width={width} height={TOP + H + AXIS} aria-hidden="true" focusable="false">
      {ticks.map((t) => (
        <text key={t} x={width - 6} y={TOP + H - (t / max) * H + 4} text-anchor="end">
          {format(t)}
        </text>
      ))}
    </svg>
  );
}

/** Подсказка над графиком: значение крупно, подпись серии мельче, ключ серии — короткой линией её цвета. */
function Tip({ x, plotWidth, title, rows, footer }) {
  const left = Math.max(0, Math.min(x, plotWidth));
  const flip = left > plotWidth / 2;
  return (
    <div class={`vtip${flip ? ' vtip--left' : ''}`} style={{ left: `${left}px` }} aria-hidden="true">
      <p class="vtip__title">{title}</p>
      {rows.map((r) => (
        <p class="vtip__row" key={r.key}>
          {r.cls ? <span class={`vtip__key ${r.cls}`} /> : null}
          <b>{r.value}</b> <span>{r.label}</span>
        </p>
      ))}
      {footer ? <p class="vtip__foot">{footer}</p> : null}
    </div>
  );
}

/** Индекс под указателем и с клавиатуры (← → Home End), сообщение для диктора при движении с клавиатуры. */
function useCursor(count, describe) {
  const [active, setActive] = useState(null);
  const [spoken, setSpoken] = useState('');
  const set = (i, speak) => {
    const v = i === null ? null : Math.max(0, Math.min(count - 1, i));
    setActive(v);
    if (speak && v !== null) setSpoken(describe(v));
  };
  const onKeyDown = (e) => {
    const map = { ArrowRight: 1, ArrowLeft: -1 };
    if (e.key in map) set((active ?? count - 1) + map[e.key], true);
    else if (e.key === 'Home') set(0, true);
    else if (e.key === 'End') set(count - 1, true);
    else if (e.key === 'Escape') set(null);
    else return;
    e.preventDefault();
  };
  return { active, set, spoken, onKeyDown, onFocus: () => set(active ?? count - 1, true), onBlur: () => set(null) };
}

/**
 * Столбцы с разбивкой по дням.
 * @param {{ rows: Array<{ date, values, total, today }>, max: number }} data из stackedRows
 * @param {Array<{ key, label, cls }>} series по порядку снизу вверх
 */
export function StackedBars({ data, series, format, axisFormat, label }) {
  const [scroller, width] = useWidth();
  const n = data.rows.length;
  const minBand = n > 120 ? 6 : n > 45 ? 10 : 16;
  const plotWidth = Math.max(width, n * minBand);
  const band = n ? plotWidth / n : 0;
  const barW = Math.max(1, Math.min(24, band * 0.68, band - 2));
  const { max, ticks } = useMemo(() => niceTicks(data.max), [data.max]);
  const every = labelEvery(n, plotWidth);
  const describe = (i) => {
    const r = data.rows[i];
    return `${dayLong(r.date)}: всего ${format(r.total)}; ${series.map((s, k) => `${s.label.toLowerCase()} ${format(r.values[k])}`).join(', ')}`;
  };
  const cur = useCursor(n, describe);
  const fmtAxis = axisFormat ?? format;
  const aw = axisWidth(ticks, fmtAxis);
  // Длинный период: сразу показать последние дни (текущий день справа)
  useEffect(() => {
    const el = scroller.current;
    if (el && plotWidth > width) el.scrollLeft = el.scrollWidth;
  }, [plotWidth, width]);

  const bars = useMemo(
    () =>
      data.rows.map((r, i) => {
        const x = i * band + (band - barW) / 2;
        let y = TOP + H;
        const segs = [];
        const visible = r.values.map((v, k) => [v, k]).filter(([v]) => v > 0);
        visible.forEach(([v, k], j) => {
          const h = (v / max) * H;
          const top = j === visible.length - 1;
          const gap = j > 0 && h > 3 ? 2 : 0;
          const hh = Math.max(0, h - gap);
          y -= h;
          segs.push(top ? <path key={k} class={series[k].cls} d={topRounded(x, y, barW, hh, 4)} /> : <rect key={k} class={series[k].cls} x={x} y={y + gap} width={barW} height={hh} />);
        });
        return <g key={r.date}>{segs}</g>;
      }),
    [data, band, barW, max],
  );
  const todayIdx = data.rows.findIndex((r) => r.today);

  return (
    <div class="vplot">
      <div class="vplot__frame" style={{ gridTemplateColumns: `${aw}px minmax(0, 1fr)` }}>
        <YAxis ticks={ticks} max={max} format={fmtAxis} width={aw} />
        <div class="vplot__scroll" ref={scroller} role="img" aria-label={label} tabIndex={0} onKeyDown={cur.onKeyDown} onFocus={cur.onFocus} onBlur={cur.onBlur}>
          <div class="vplot__inner" style={{ width: `${plotWidth}px` }}>
            <svg
              class="vsvg"
              width={plotWidth}
              height={TOP + H + AXIS}
              aria-hidden="true"
              focusable="false"
              onPointerMove={(e) => cur.set(Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left) / band))}
              onPointerDown={(e) => cur.set(Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left) / band))}
              onPointerLeave={(e) => e.pointerType === 'mouse' && cur.set(null)}
            >
              {todayIdx >= 0 ? <rect class="vtoday" x={todayIdx * band} y={0} width={band} height={TOP + H} /> : null}
              {ticks.map((t) => (
                <line key={t} class="vgrid" x1={0} x2={plotWidth} y1={TOP + H - (t / max) * H} y2={TOP + H - (t / max) * H} />
              ))}
              <Static deps={bars}>
                <g>{bars}</g>
              </Static>
              {cur.active !== null ? <rect class="vhover" x={cur.active * band} y={0} width={band} height={TOP + H} /> : null}
              {data.rows.map((r, i) =>
                (i % every === 0 && (todayIdx < 0 || i === todayIdx || Math.abs(todayIdx - i) * band >= 56)) || r.today ? (
                  <text key={r.date} class={`vxlabel${r.today ? ' vxlabel--today' : ''}`} {...xLabelPos(i * band + band / 2, plotWidth)} y={TOP + H + 18}>
                    {r.today ? 'сегодня' : dayShort(r.date)}
                  </text>
                ) : null,
              )}
            </svg>
            {cur.active !== null && data.rows[cur.active] ? (
              <Tip
                x={cur.active * band + band / 2}
                plotWidth={plotWidth}
                title={`${dayLong(data.rows[cur.active].date)}, ${WEEKDAY_LONG[weekday(data.rows[cur.active].date) - 1]}${data.rows[cur.active].today ? ' (сутки идут)' : ''}`}
                rows={[...series.map((s, k) => ({ key: s.key, cls: s.cls, label: s.label, value: format(data.rows[cur.active].values[k]) })).reverse()]}
                footer={`Всего ${format(data.rows[cur.active].total)}`}
              />
            ) : null}
          </div>
        </div>
      </div>
      <p class="visually-hidden" aria-live="polite">
        {cur.spoken}
      </p>
    </div>
  );
}

/**
 * Линии по дням (2 px). null — разрыв: в этот день не было игр, средний чек не считается.
 * @param {{ dates: string[], series: Array<{ key, points }>, max }} data из lineSeries
 */
export function Lines({ data, series, format, axisFormat, label, fixedMax }) {
  const [scroller, width] = useWidth();
  const n = data.dates.length;
  const plotWidth = Math.max(width, n * (n > 120 ? 4 : 10));
  const step = n > 1 ? plotWidth / n : plotWidth;
  const { max, ticks } = useMemo(() => niceTicks(fixedMax ?? data.max), [data.max, fixedMax]);
  const xOf = (i) => i * step + step / 2;
  const yOf = (v) => TOP + H - (Math.min(v, max) / max) * H;
  const paths = useMemo(
    () =>
      data.series.map((s) => {
        let d = '';
        let pen = false;
        s.points.forEach((v, i) => {
          if (v === null) {
            pen = false;
            return;
          }
          d += `${pen ? 'L' : 'M'}${Math.round(xOf(i) * 10) / 10} ${Math.round(yOf(v) * 10) / 10}`;
          pen = true;
        });
        return d;
      }),
    [data, step, max],
  );
  const every = labelEvery(n, plotWidth);
  const describe = (i) => `${dayLong(data.dates[i])}: ${series.map((s, k) => `${s.label.toLowerCase()} ${format(data.series[k].points[i])}`).join(', ')}`;
  const cur = useCursor(n, describe);
  const fmtAxis = axisFormat ?? format;
  const aw = axisWidth(ticks, fmtAxis);
  useEffect(() => {
    const el = scroller.current;
    if (el && plotWidth > width) el.scrollLeft = el.scrollWidth;
  }, [plotWidth, width]);
  const lastIdx = (pts) => {
    for (let i = pts.length - 1; i >= 0; i -= 1) if (pts[i] !== null) return i;
    return -1;
  };
  const pick = (e) => cur.set(Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left) / step));

  return (
    <div class="vplot">
      <div class="vplot__frame" style={{ gridTemplateColumns: `${aw}px minmax(0, 1fr)` }}>
        <YAxis ticks={ticks} max={max} format={fmtAxis} width={aw} />
        <div class="vplot__scroll" ref={scroller} role="img" aria-label={label} tabIndex={0} onKeyDown={cur.onKeyDown} onFocus={cur.onFocus} onBlur={cur.onBlur}>
          <div class="vplot__inner" style={{ width: `${plotWidth}px` }}>
            <svg class="vsvg" width={plotWidth} height={TOP + H + AXIS} aria-hidden="true" focusable="false" onPointerMove={pick} onPointerDown={pick} onPointerLeave={(e) => e.pointerType === 'mouse' && cur.set(null)}>
              {ticks.map((t) => (
                <line key={t} class="vgrid" x1={0} x2={plotWidth} y1={yOf(t)} y2={yOf(t)} />
              ))}
              {paths.map((d, k) => (
                <path key={series[k].key} class={`vline ${series[k].cls}`} d={d} />
              ))}
              {cur.active !== null ? <line class="vcross" x1={xOf(cur.active)} x2={xOf(cur.active)} y1={TOP} y2={TOP + H} /> : null}
              {data.series.map((s, k) => {
                const i = cur.active ?? lastIdx(s.points);
                const v = s.points[i];
                return i >= 0 && v !== null && v !== undefined ? <circle key={s.key} class={`vdot ${series[k].cls}`} cx={xOf(i)} cy={yOf(v)} r={4} /> : null;
              })}
              {data.dates.map((d, i) =>
                i % every === 0 ? (
                  <text key={d} class="vxlabel" {...xLabelPos(xOf(i), plotWidth)} y={TOP + H + 18}>
                    {dayShort(d)}
                  </text>
                ) : null,
              )}
            </svg>
            {cur.active !== null && data.dates[cur.active] ? (
              <Tip
                x={xOf(cur.active)}
                plotWidth={plotWidth}
                title={`${dayLong(data.dates[cur.active])}, ${WEEKDAY_LONG[weekday(data.dates[cur.active]) - 1]}`}
                rows={series.map((s, k) => ({ key: s.key, cls: s.cls, label: s.label, value: format(data.series[k].points[cur.active]) }))}
              />
            ) : null}
          </div>
        </div>
      </div>
      <p class="visually-hidden" aria-live="polite">
        {cur.spoken}
      </p>
    </div>
  );
}

/**
 * Кольцо: доли с зазором 2 px, в центре — главное число. Сегменты нажимаются и наводятся (подсказка),
 * значения всегда видны в легенде рядом.
 * @param {Array<{ key, label, value, cls, text }>} segments
 */
export function Ring({ segments, size = 168, thickness = 22, center, centerSub, label, interactive = true }) {
  const [active, setActive] = useState(null);
  const R = size / 2;
  const r = R - thickness;
  const arcs = ringArcs(segments.map((s) => s.value), segments.filter((s) => s.value > 0).length > 1 ? 2 / R : 0);
  return (
    <div class="vring" style={{ width: `${size}px` }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
        <circle class="vring__track" cx={R} cy={R} r={R - thickness / 2} stroke-width={thickness} fill="none" />
        {arcs.map((a, i) =>
          a.end > a.start ? (
            <path
              key={segments[i].key}
              class={`${segments[i].cls}${active === i ? ' is-active' : ''}`}
              d={arcPath(R, R, R, r, a.start, a.end)}
              onPointerEnter={interactive ? () => setActive(i) : undefined}
              onPointerDown={interactive ? () => setActive(i) : undefined}
              onPointerLeave={interactive ? () => setActive(null) : undefined}
            />
          ) : null,
        )}
        <text class="vring__big" x={R} y={(active !== null ? segments[active].label : centerSub) ? R + 2 : R + 7} text-anchor="middle" aria-hidden="true">
          {active !== null ? segments[active].text : center}
        </text>
        {(active !== null ? segments[active].label : centerSub) ? (
          <text class="vring__small" x={R} y={R + 20} text-anchor="middle" aria-hidden="true">
            {active !== null ? segments[active].label : centerSub}
          </text>
        ) : null}
      </svg>
    </div>
  );
}

/**
 * Тепловая карта «день недели × час»: 7 строк, 24 часа в порядке рабочих суток клуба. Одна шкала — янтарь лампы:
 * чем ярче (в светлой теме — темнее), тем больше загрузка. Закрытые часы — без заливки.
 */
export function Heatmap({ matrix, label }) {
  const [scroller, width] = useWidth();
  const cols = matrix.hours.length;
  const cell = Math.max(22, Math.floor(width / cols));
  const plotWidth = cell * cols;
  const rowH = 28;
  const headH = 22;
  const [active, setActive] = useState(null); // [row, col]
  const [spoken, setSpoken] = useState('');
  const describe = (ri, ci) => {
    const row = matrix.rows[ri];
    const c = row.cells[ci];
    return `${row.long}, ${hourSpan(c.hour)}: ${c.pct === null ? 'нет часов работы' : `загрузка ${Math.round(c.pct)} %`}`;
  };
  const move = (ri, ci, speak) => {
    const r = Math.max(0, Math.min(6, ri));
    const c = Math.max(0, Math.min(cols - 1, ci));
    setActive([r, c]);
    if (speak) setSpoken(describe(r, c));
  };
  const onKeyDown = (e) => {
    const [r, c] = active ?? [0, 0];
    const map = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] };
    if (map[e.key]) move(r + map[e.key][0], c + map[e.key][1], true);
    else if (e.key === 'Home') move(r, 0, true);
    else if (e.key === 'End') move(r, cols - 1, true);
    else if (e.key === 'Escape') setActive(null);
    else return;
    e.preventDefault();
  };
  const pick = (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    const ci = Math.floor((e.clientX - box.left) / cell);
    const ri = Math.floor((e.clientY - box.top - headH) / rowH);
    if (ri >= 0 && ri < 7 && ci >= 0 && ci < cols) move(ri, ci, false);
    else if (e.pointerType === 'mouse') setActive(null);
  };
  const cells = useMemo(
    () =>
      matrix.rows.map((row, ri) =>
        row.cells.map((c, ci) =>
          c.level === null ? (
            <rect key={`${ri}-${ci}`} class="vheat-closed" x={ci * cell + 1} y={headH + ri * rowH + 1} width={cell - 2} height={rowH - 2} rx={3} />
          ) : (
            <rect key={`${ri}-${ci}`} class={`vheat vheat--l${c.level}`} x={ci * cell + 1} y={headH + ri * rowH + 1} width={cell - 2} height={rowH - 2} rx={3} />
          ),
        ),
      ),
    [matrix, cell],
  );
  // На узком экране сразу показать вечер (пик), а не утренние закрытые часы
  useEffect(() => {
    const el = scroller.current;
    if (!el || plotWidth <= width || !matrix.peak) return;
    const col = matrix.hours.indexOf(matrix.peak.hour);
    el.scrollLeft = Math.max(0, (col - 4) * cell);
  }, [plotWidth, width, matrix]);
  const act = active ? { row: matrix.rows[active[0]], cell: matrix.rows[active[0]].cells[active[1]] } : null;
  return (
    <div class="vheatwrap">
      <div class="vheatwrap__frame">
        <div class="vheat__days" aria-hidden="true" style={{ paddingTop: `${headH}px` }}>
          {matrix.rows.map((r) => (
            <span key={r.dow} style={{ height: `${rowH}px` }}>
              {r.label}
            </span>
          ))}
        </div>
        <div class="vplot__scroll" ref={scroller} role="img" aria-label={label} tabIndex={0} onKeyDown={onKeyDown} onFocus={() => move(active?.[0] ?? 4, active?.[1] ?? 15, true)} onBlur={() => setActive(null)}>
          <div class="vplot__inner" style={{ width: `${plotWidth}px` }}>
            <svg class="vsvg" width={plotWidth} height={headH + rowH * 7} aria-hidden="true" focusable="false" onPointerMove={pick} onPointerDown={pick} onPointerLeave={(e) => e.pointerType === 'mouse' && setActive(null)}>
              {matrix.hours.map((h, ci) =>
                ci % 3 === 0 ? (
                  <text key={h} class="vxlabel" x={ci * cell + 2} y={14}>
                    {String(h).padStart(2, '0')}
                  </text>
                ) : null,
              )}
              <Static deps={cells}>
                <g>{cells}</g>
              </Static>
              {active ? <rect class="vheat-focus" x={active[1] * cell} y={headH + active[0] * rowH} width={cell} height={rowH} rx={4} /> : null}
            </svg>
            {act ? (
              <Tip
                x={active[1] * cell + cell / 2}
                plotWidth={plotWidth}
                title={`${act.row.long[0].toUpperCase()}${act.row.long.slice(1)}, ${hourSpan(act.cell.hour)}`}
                rows={[{ key: 'pct', value: act.cell.pct === null ? 'Нет часов работы' : `${Math.round(act.cell.pct)} %`, label: act.cell.pct === null ? '' : 'загрузка' }]}
                footer={act.cell.pct === null ? null : `Сыграно ${Math.round(act.cell.play / 60)} ч из ${Math.round(act.cell.capacity / 60)} ч`}
              />
            ) : null}
          </div>
        </div>
      </div>
      <ul class="vheatlegend" aria-label="Шкала загрузки">
        {HEAT_LEGEND.map((t, i) => (
          <li key={t}>
            <span class={`vheatlegend__sw vheat--l${i}`} aria-hidden="true" />
            {t}
          </li>
        ))}
        <li>
          <span class="vheatlegend__sw vheat-closed" aria-hidden="true" />
          нет часов работы (клуб закрыт или час ещё не наступил)
        </li>
      </ul>
      <p class="visually-hidden" aria-live="polite">
        {spoken}
      </p>
    </div>
  );
}

/** Полосы долей (структура выручки, способы, источники): одна серия — один цвет, значение и % текстом. */
export function Shares({ rows, total, format }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul class="shares">
      {rows.map((r) => (
        <li key={r.key} class="shares__row">
          <span class="shares__label">{r.label}</span>
          <span class="shares__value num">{format(r.value)}</span>
          <span class="shares__pct num">{total ? `${Math.round((r.value / total) * 100)} %` : '—'}</span>
          <span class="shares__bar" aria-hidden="true">
            <span class="shares__fill" style={{ width: `${(r.value / max) * 100}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}
