import { useMemo } from 'preact/hooks';
import { planLayout, tableSvg, tableState, typeLabel } from '@billiardum/shared/hall';
import { formatTime, plural } from '@billiardum/shared/format';

const TABLES = ['стол', 'стола', 'столов'];
const pct = (v) => `${(v * 100).toFixed(3)}%`;

/** Подсчёт столов по состояниям для легенды и заголовка. */
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
 * План зала (DESIGN §4): столы в настоящих пропорциях, свободные тёмные, занятые освещены, бронь — янтарная рамка.
 * Каждый стол — кнопка с подписью для диктора «Стол 4, идёт игра до 21:40». Зал всегда тёмный.
 */
export function HallPlan({ items, timeZone, onSelect, perRow, label = 'План зала', selected }) {
  const layout = useMemo(
    () => planLayout(items.map((i) => ({ id: i.resource.id, number: i.resource.number, type: i.resource.type })), { perRow }),
    [items.map((i) => `${i.resource.id}:${i.resource.type}`).join(','), perRow],
  );
  const byId = useMemo(() => new Map(items.map((i) => [i.resource.id, i])), [items]);
  const svgs = useMemo(() => new Map(layout.items.map((p) => [p.id, tableSvg(p.kind, { uid: `spot-${p.id}` })])), [layout]);
  const fmt = (iso) => formatTime(iso, timeZone);
  const counts = hallCounts(items, timeZone);

  return (
    <div class="hall" data-theme="dark">
      <div class="hall__head">
        <p class="hall__free display">
          {counts.free ? `Свободно ${counts.free} ${plural(counts.free, TABLES)}` : 'Все столы заняты'}
        </p>
        <ul class="legend" aria-label="Состояние столов">
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
      <div class="hall__floor">
        <div class="plan" role="group" aria-label={`${label}, ${items.length} ${plural(items.length, TABLES)}`} style={{ aspectRatio: `${layout.width} / ${layout.height}` }}>
          {layout.items.map((p) => {
            const item = byId.get(p.id);
            const st = tableState(item, { formatTime: fmt });
            const lit = st.tone === 'grace' ? 'dim' : String(st.lit);
            return (
              <button
                type="button"
                key={p.id}
                class="tbl lit-host"
                data-lit={lit}
                data-tone={st.tone}
                data-kind={p.kind}
                aria-pressed={selected === p.id ? 'true' : undefined}
                aria-label={`Стол ${p.number}, ${(st.spoken ?? st.word).toLowerCase()}. ${typeLabel(item.resource.type, item.resource.title)}`}
                style={{ left: pct(p.x / layout.width), top: pct(p.y / layout.height), width: pct(p.w / layout.width) }}
                onClick={() => onSelect?.(item)}
              >
                <span class="tbl__glow" aria-hidden="true" />
                <span class="tbl__art" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svgs.get(p.id) }} />
                <span class="tbl__cap" aria-hidden="true">
                  <span class="tbl__num">Стол {p.number}</span>
                  <span class="tbl__status">{st.word}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
