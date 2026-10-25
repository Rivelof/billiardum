import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Icon } from '../../components/Icon.jsx';
import { ErrorNote } from '../../components/ErrorNote.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { api } from '../../lib/api.js';
import { BASE } from '../../lib/env.js';
import { linkHandler } from '../../lib/router.js';
import { tileViews, TILES } from '../../lib/dashboard.js';
import { periodWords } from '../../lib/period.js';
import { COMPARE_TILES, daysWords, networkCompareView, placeWords, tablesAvgWords } from '../../lib/networkDashboard.js';
import { Tile } from './tabs.jsx';
import '../../styles/network.css';

const TOTAL_TILES = ['revenue', 'utilization', 'revenue_per_table_day', 'games', 'play_hours', 'guests'];
const MODE_WORD = { test: 'Тестовый режим', suspended: 'Приостановлен', live: 'Боевой режим' };

/**
 * Вкладка «Сеть» дашборда (M5.5 №193, GET /api/networks/{id}/dashboard): клубы сети по плиткам, рейтинг по загрузке
 * и выручке со стола, клубы в тестовом режиме — отдельно, вне рейтинга. Денег по способам оплаты здесь нет.
 * Период — общие даты, каждый клуб считается по своим рабочим суткам и поясу. На телефоне таблица — карточки.
 */
export function NetworkTab({ networks, network, onNetwork, filters, today, clubs }) {
  const [data, setData] = useState(null);
  const [key, setKey] = useState(null);
  const [error, setError] = useState(null);
  const seq = useRef(0);
  const want = `${network?.network_id}|${filters.from}|${filters.to}|${filters.compare}`;
  const load = useCallback(async () => {
    if (!network) return;
    const my = ++seq.current;
    try {
      const res = await api.networkDashboard(network.network_id, { from: filters.from, to: filters.to, compare: filters.compare ? 1 : 0 });
      if (my !== seq.current) return;
      setData(res);
      setKey(want);
      setError(null);
    } catch (err) {
      if (my === seq.current) setError(err);
    }
  }, [want]);
  useEffect(() => {
    load();
  }, [load]);
  const view = useMemo(() => (data ? networkCompareView(data, { compare: filters.compare }) : null), [data, filters.compare]);
  const busy = key !== want;
  const member = new Set((clubs ?? []).map((c) => c.club_id));

  if (!network) return <p class="hint">Сети клубов у вас нет. Создать её можно в разделе «Сеть».</p>;
  return (
    <div class={`dgrid ncmp${busy && view ? ' is-busy' : ''}`} aria-busy={busy ? 'true' : undefined}>
      <div class="dsec dsec--wide ncmp__head">
        {networks.length > 1 ? (
          <label class="dfield">
            <span class="dfield__label">Сеть</span>
            <select class="field__input" value={network.network_id} onChange={(e) => onNetwork(e.currentTarget.value)}>
              {networks.map((n) => (
                <option key={n.network_id} value={n.network_id}>
                  {n.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <p>
          <b>«{view?.network?.name ?? network.name}»</b>
          {view ? ` · ${periodWords(view.period?.from ?? filters.from, view.period?.to ?? filters.to, today)}` : ''}. Каждый клуб считается по своим рабочим суткам и часовому поясу, даты периода общие. Тип стола на этой вкладке не учитывается.
        </p>
        {view?.mixedDays ? <p class="small muted">У клубов разные пояса или начало суток: «сегодня» у каждого клуба своё.</p> : null}
        {view?.missing?.length ? (
          <p class="note note--lamp">
            <Icon name="clock" />
            <span class="note__title">Часть дней ещё пересчитывается</span>
            <span class="note__body">Цифры за {daysWords(view.missing.length)} появятся после ночного пересчёта.</span>
          </p>
        ) : null}
      </div>
      <ErrorNote error={error} class="dsec--wide">
        <button type="button" class="btn btn--secondary btn--sm" onClick={load}>
          Повторить
        </button>
      </ErrorNote>
      {!view && !error ? (
        <p class="muted loading dsec--wide" role="status">
          Сравниваем клубы сети…
        </p>
      ) : null}
      {view && view.empty ? (
        <div class="dash__empty dsec--wide" role="status">
          <Icon name="chain" />
          <p>В сети пока нет клубов. Добавьте клубы в разделе «Сеть» — сравнение появится здесь.</p>
        </div>
      ) : null}
      {view && !view.empty ? (
        <>
          {view.totals ? <Totals raw={data?.totals?.tiles} compare={filters.compare} ranked={view.ranked.length} count={view.ranked.length + view.outside.length} /> : null}
          <Ranking id="ncmp-util" title="Рейтинг по загрузке" items={view.ranking.utilization} of={view.ranked.length} />
          <Ranking id="ncmp-rev" title="Рейтинг по выручке со стола в день" items={view.ranking.revenue} of={view.ranked.length} />
          <Compare rows={view.ranked} totals={view.totals} member={member} />
          {view.outside.length ? (
            <section class="dsec dsec--wide" aria-labelledby="ncmp-out">
              <h2 class="section-title" id="ncmp-out">
                Вне рейтинга
              </h2>
              <p class="hint">Клубы в тестовом режиме: оплаты в них тестовые, поэтому цифры не входят ни в итог, ни в рейтинг.</p>
              <ul class="nclubs">
                {view.outside.map((c) => (
                  <li key={c.id} class="nclub">
                    <div class="nclub__main">
                      <p class="nclub__name">{member.has(c.id) ? <a href={`${BASE}c/${encodeURIComponent(c.id)}/dashboard`} onClick={linkHandler}>{c.name}</a> : c.name}</p>
                      <p class="nclub__tags">
                        <span class="nbadge nbadge--test">
                          <Icon name="flask" />
                          {MODE_WORD[c.mode] ?? 'Вне рейтинга'}
                        </span>
                        <span class="small muted">игр: {c.tiles.games?.text ?? '—'}</span>
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Totals({ raw, compare, ranked, count }) {
  const tiles = tileViews(raw, TOTAL_TILES, { compare });
  if (!tiles.length) return null;
  return (
    <section class="dsec dsec--wide" aria-labelledby="ncmp-total">
      <h2 class="section-title" id="ncmp-total">
        Вся сеть{' '}
        <span class="muted ncmp__count">
          · клубы в рейтинге: {ranked} из {count}
        </span>
      </h2>
      <div class="dtiles">
        {tiles.map((t) => (
          <Tile key={t.id} t={t} />
        ))}
      </div>
    </section>
  );
}

/** Место 1–3 — шар из слоновой кости с номером (DESIGN §1), дальше — число. */
function Place({ place }) {
  if (!place) return <span class="ncmp__noplace">—</span>;
  return (
    <span class={`nball${place <= 3 ? ' nball--top' : ''}`} aria-hidden="true">
      {place}
    </span>
  );
}

function Ranking({ id, title, items, of }) {
  return (
    <section class="dsec" aria-labelledby={id}>
      <h2 class="section-title" id={id}>
        {title}
      </h2>
      {items.length ? (
        <ol class="nrank">
          {items.map((x) => (
            <li key={x.id} class="nrank__item">
              <Place place={x.place} />
              <span class="visually-hidden">{placeWords(x.place, of)}:</span>
              <span class="nrank__name">{x.name}</span>
              <b class="nrank__value">{x.text}</b>
            </li>
          ))}
        </ol>
      ) : (
        <p class="muted">Пока нечего сравнивать: в рейтинге клубы в боевом режиме с играми за период.</p>
      )}
    </section>
  );
}

function Compare({ rows, totals, member }) {
  const columns = useMemo(
    () => [
      {
        key: 'name',
        label: 'Клуб',
        head: true,
        sortValue: (r) => r.name,
        render: (r) => (
          <span class="ncmp__club">
            {member.has(r.id) ? (
              <a href={`${BASE}c/${encodeURIComponent(r.id)}/dashboard`} onClick={linkHandler}>
                {r.name}
              </a>
            ) : (
              r.name
            )}
            <span class="small muted">
              {r.dayStart ? `сутки с ${r.dayStart}` : ''}
              {r.tablesAvg !== null ? ` · в среднем ${tablesAvgWords(r.tablesAvg)}` : ''}
            </span>
          </span>
        ),
      },
      {
        key: 'place',
        label: 'Место',
        num: true,
        sortValue: (r) => -(r.placeUtil ?? 1e9),
        render: (r) => (
          <span class="ncmp__places">
            <span class="ncmp__place">
              <Place place={r.placeUtil} />
              <span class="small">загрузка</span>
            </span>
            <span class="ncmp__place">
              <Place place={r.placeRevenue} />
              <span class="small">выручка</span>
            </span>
            <span class="visually-hidden">
              По загрузке — {placeWords(r.placeUtil)}, по выручке со стола в день — {placeWords(r.placeRevenue)}.
            </span>
          </span>
        ),
      },
      ...COMPARE_TILES.map((id) => ({
        key: id,
        label: TILES[id].label,
        num: true,
        cls: 'rnowrap',
        sortValue: (r) => r.tiles[id]?.value ?? null,
        render: (r) => <Cell t={r.tiles[id]} />,
      })),
    ],
    [rows],
  );
  const foot = totals ? (
    <tr>
      <th scope="row">Вся сеть</th>
      <td class="num" data-label="Место">
        —
      </td>
      {COMPARE_TILES.map((id) => (
        <td key={id} class="num rnowrap" data-label={TILES[id].label}>
          <Cell t={totals.tiles[id]} />
        </td>
      ))}
    </tr>
  ) : null;
  return (
    <section class="dsec dsec--wide" aria-labelledby="ncmp-table">
      <h2 class="section-title" id="ncmp-table">
        Клубы по плиткам
      </h2>
      {rows.length ? (
        <div class="ncmp__scroll" role="region" aria-label="Таблица клубов: на узком экране прокручивается вбок" tabIndex={0}>
          <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} caption="Клубы сети в рейтинге: плитки дашборда за период" foot={foot} />
        </div>
      ) : (
        <p class="muted">В рейтинге пока нет клубов: сравнение — для клубов в боевом режиме.</p>
      )}
    </section>
  );
}

function Cell({ t }) {
  if (!t) return '—';
  return (
    <span class="ncmp__cell">
      {t.text}
      {t.delta ? (
        <span class={`ncmp__delta dtile__delta--${t.delta.tone}`}>
          <span aria-hidden="true">{t.delta.text}</span>
          <span class="visually-hidden">{t.delta.spoken}</span>
        </span>
      ) : null}
    </span>
  );
}
