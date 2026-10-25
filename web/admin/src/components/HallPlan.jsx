import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { courtLayout, planLayout, tableSvg, tableState, typeLabel } from '@billiardum/shared/hall';
import { formatTime } from '@billiardum/shared/format';
import { countText, familyOf, resourceName } from '@billiardum/shared/resource';

const pct = (v) => `${(v * 100).toFixed(3)}%`;

/** Подсчёт столов (кортов) по состояниям для легенды и заголовка. */
export function hallCounts(items, timeZone) {
  const counts = { play: 0, free: 0, service: 0, offline: 0, pending: 0, reserved: 0, booked: 0 };
  for (const it of items) {
    const st = tableState(it, { formatTime: (iso) => formatTime(iso, timeZone) });
    const key = ['ending', 'grace'].includes(st.tone) ? 'play' : st.tone;
    counts[key] = (counts[key] ?? 0) + 1;
    // Стол с бронью позже сегодня пока свободен (M3): считаем и в «Свободно», и в «Бронь»
    if (key === 'booked') counts.free += 1;
  }
  return counts;
}

/**
 * Заголовок зала: «Свободно 3 стола», у клуба с кортами — «Свободно 3 стола и 1 корт» (M5.8, свой счёт у семьи).
 * @param {object[]} items элементы зала
 */
export function freeText(items, timeZone) {
  const tables = items.filter((i) => familyOf(i.resource) !== 'court');
  const courts = items.filter((i) => familyOf(i.resource) === 'court');
  const free = (list) => hallCounts(list, timeZone).free;
  const ft = free(tables);
  const fc = free(courts);
  if (!courts.length) return ft ? `Свободно ${countText(ft, 'table')}` : 'Все столы заняты';
  if (!tables.length) return fc ? `Свободно ${countText(fc, 'court')}` : 'Все корты заняты';
  if (!ft && !fc) return 'Все столы и корты заняты';
  if (!fc) return `Свободно ${countText(ft, 'table')}, корты заняты`;
  if (!ft) return `Свободно ${countText(fc, 'court')}, столы заняты`;
  return `Свободно ${countText(ft, 'table')} и ${countText(fc, 'court')}`;
}

/** Ширина плана → столбцов: на стол около 88 px, на корт около 120 px (подписи не наезжают). */
function useFloorWidth() {
  const floor = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = floor.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [floor, width];
}

/**
 * План зала (DESIGN §4): столы в настоящих пропорциях, свободные тёмные, занятые освещены, бронь — янтарная рамка.
 * Каждый стол — кнопка с подписью для диктора «Стол 4, идёт игра до 21:40». Зал всегда тёмный.
 * M5.8: падел-корты — своим рядом под столами и в своём масштабе (корт в 5 раз длиннее стола), «Корт 1» — из family.
 */
export function HallPlan({ items, timeZone, onSelect, perRow, label = 'План зала', selected }) {
  const tables = items.filter((i) => familyOf(i.resource) !== 'court');
  const courts = items.filter((i) => familyOf(i.resource) === 'court');
  const counts = hallCounts(items, timeZone);

  return (
    <div class="hall" data-theme="dark">
      <div class="hall__head">
        <p class="hall__free display">{freeText(items, timeZone)}</p>
        <ul class="legend" aria-label={courts.length ? 'Состояние столов и кортов' : 'Состояние столов'}>
          <li>
            <span class="legend__mark legend__mark--play" aria-hidden="true" />
            Идёт игра <b>{counts.play}</b>
          </li>
          <li>
            <span class="legend__mark" aria-hidden="true" />
            Свободно <b>{counts.free}</b>
          </li>
          {counts.booked + counts.reserved ? (
            <li>
              <span class="legend__mark legend__mark--booked" aria-hidden="true" />
              Бронь <b>{counts.booked + counts.reserved}</b>
            </li>
          ) : null}
          {counts.service ? (
            <li>
              <span class="legend__mark legend__mark--service" aria-hidden="true" />
              Сервис <b>{counts.service}</b>
            </li>
          ) : null}
          {counts.pending ? (
            <li>
              <span class="legend__mark legend__mark--pending" aria-hidden="true" />
              Оплата <b>{counts.pending}</b>
            </li>
          ) : null}
          {counts.offline ? (
            <li>
              <span class="legend__mark legend__mark--offline" aria-hidden="true" />
              Нет связи <b>{counts.offline}</b>
            </li>
          ) : null}
        </ul>
      </div>
      {tables.length || !courts.length ? <Floor items={tables} timeZone={timeZone} onSelect={onSelect} perRow={perRow} label={label} selected={selected} /> : null}
      {courts.length ? (
        <>
          {tables.length ? <h3 class="hall__sub">Падел-корты</h3> : null}
          <Floor items={courts} court timeZone={timeZone} onSelect={onSelect} label={tables.length ? 'Падел-корты' : label} selected={selected} />
        </>
      ) : null}
    </div>
  );
}

/** Один ряд плана: столы (planLayout) или корты (courtLayout). */
function Floor({ items, court = false, timeZone, onSelect, perRow, label, selected }) {
  const [floor, floorWidth] = useFloorWidth();
  const fit = floorWidth ? (court ? Math.max(1, Math.min(4, Math.floor(floorWidth / 120))) : Math.max(2, Math.min(6, Math.floor(floorWidth / 88)))) : null;
  const layout = useMemo(() => {
    const list = items.map((i) => ({ id: i.resource.id, number: i.resource.number, type: i.resource.type }));
    if (court) return courtLayout(list, fit ? { perRow: fit } : {});
    const auto = planLayout(list, { perRow });
    const cols = new Set(auto.items.map((i) => i.x)).size;
    return fit && cols > fit ? planLayout(list, { perRow: fit }) : auto;
  }, [items.map((i) => `${i.resource.id}:${i.resource.type}`).join(','), perRow, fit, court]);
  const byId = useMemo(() => new Map(items.map((i) => [i.resource.id, i])), [items]);
  const svgs = useMemo(() => new Map(layout.items.map((p) => [p.id, tableSvg(p.kind, { uid: `spot-${p.id}` })])), [layout]);
  const fmt = (iso) => formatTime(iso, timeZone);
  const family = court ? 'court' : 'table';

  return (
    <div class="hall__floor" ref={floor}>
      <div
        class="plan"
        role="group"
        aria-label={`${label}, ${countText(items.length, family)}`}
        // Корт в своём масштабе, но не на всю ширину: около 170 px на корт в ряду
        style={{ aspectRatio: `${layout.width} / ${layout.height}`, ...(court ? { maxWidth: `${new Set(layout.items.map((i) => i.x)).size * 170}px` } : {}) }}
      >
        {layout.items.map((p) => {
          const item = byId.get(p.id);
          const st = tableState(item, { formatTime: fmt });
          const lit = st.tone === 'grace' ? 'dim' : String(st.lit);
          const name = resourceName(item.resource, p.number);
          return (
            <button
              type="button"
              key={p.id}
              class="tbl lit-host"
              data-lit={lit}
              data-tone={st.tone}
              data-kind={p.kind}
              aria-pressed={selected === p.id ? 'true' : undefined}
              // Имя начинается с видимой подписи «Стол 4 До 21:40» (WCAG 2.5.3), затем — полностью для диктора
              aria-label={`${name} ${st.word.toLowerCase()}${st.spoken ? `, ${st.spoken}` : ''}. ${typeLabel(item.resource.type, item.resource.title)}`}
              style={{ left: pct(p.x / layout.width), top: pct(p.y / layout.height), width: pct(p.w / layout.width) }}
              onClick={() => onSelect?.(item)}
            >
              <span class="tbl__glow" aria-hidden="true" />
              <span class="tbl__art" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svgs.get(p.id) }} />
              <span class="tbl__cap" aria-hidden="true">
                <span class="tbl__num">{name}</span> <span class="tbl__status">{st.word}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
