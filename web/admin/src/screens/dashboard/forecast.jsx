import { useMemo, useState } from 'preact/hooks';
import { Icon } from '../../components/Icon.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { BASE } from '../../lib/env.js';
import { linkHandler } from '../../lib/router.js';
import { can } from '../../lib/auth.js';
import { heatmapMatrix } from '../../lib/dashboard.js';
import { basisText, forecastView, hintsView, holidayText, notEnoughText } from '../../lib/forecast.js';
import { ChartCard, Heatmap } from './charts.jsx';

const pad = (h) => `${String(h).padStart(2, '0')}:00`;

/** Таблица-дубль тепловой карты: часы строками, дни столбцами. */
function heatTable(matrix, caption) {
  return (
    <DataTable
      caption={caption}
      columns={[{ key: 'hour', label: 'Час', head: true, render: (r) => pad(r.hour) }, ...matrix.rows.map((row) => ({ key: `d${row.dow}`, label: row.label, num: true, render: (r) => (row.cells[r.ci].pct === null ? 'нет часов' : `${Math.round(row.cells[r.ci].pct)} %`) }))]}
      rows={matrix.hours.map((hour, ci) => ({ hour, ci }))}
      rowKey={(r) => r.hour}
    />
  );
}

/**
 * M5.6 (№196): тепловая карта «Факт / Прогноз». Факт — загрузка за выбранный период; прогноз — series.forecast того же
 * ответа (медиана 8 недель по дню недели и часу, не зависит от периода). У «всех клубов» прогноза нет (forecast: null) —
 * переключателя нет, подсказка выбрать клуб. Под картой — подсказки по цене (№197).
 */
export function HeatSection({ view, ctx, busy, emptyText }) {
  const single = ctx.scope !== 'all';
  const [mode, setMode] = useState('fact');
  const fact = useMemo(() => heatmapMatrix(view.hall.cells, view.period.dayStart), [view]);
  const fc = useMemo(() => forecastView(view.hall.forecast), [view]);
  const fcMatrix = useMemo(() => (fc?.enough ? heatmapMatrix(fc.cells, view.period.dayStart) : null), [fc, view.period.dayStart]);
  const hints = useMemo(() => hintsView(view.hall.hints), [view]);
  const isForecast = single && mode === 'forecast';

  const switcher = single ? (
    <fieldset class="dheatmode">
      <legend class="visually-hidden">Что показать на тепловой карте</legend>
      <div class="seg">
        {[
          ['fact', 'Факт'],
          ['forecast', 'Прогноз'],
        ].map(([v, l]) => (
          <label class="seg__item" key={v}>
            <input type="radio" name="dheat-mode" value={v} checked={mode === v} onChange={() => setMode(v)} />
            <span class="seg__box">{l}</span>
          </label>
        ))}
      </div>
    </fieldset>
  ) : (
    <p class="small muted">Прогноз загрузки считается для каждого клуба отдельно — выберите клуб в фильтре сверху.</p>
  );

  return (
    <>
      <div class="dsec--wide">
        {isForecast ? (
          <ChartCard
            id="heat"
            title="Прогноз на неделю"
            badge={fc?.label ?? 'прогноз'}
            sub={fc?.enough ? `Загрузка по дню недели и часу: ${basisText(fc)}. Это ориентир, а не обещание.` : 'Медиана прошлых недель по дню недели и часу'}
            switcher={switcher}
            busy={busy}
            empty={!fcMatrix || fcMatrix.empty}
            emptyText={!fc ? 'Прогноза пока нет: сервер не прислал его для этого клуба. Обновите страницу позже.' : !fc.enough ? notEnoughText(fc) : 'Прогноз пустой: за прошлые недели игр не было.'}
            table={fcMatrix ? () => heatTable(fcMatrix, 'Прогноз загрузки по дням недели и часам') : null}
          >
            {fcMatrix ? (
              <>
                <Heatmap forecast matrix={fcMatrix} label="Прогноз загрузки на неделю: дни недели по строкам, часы по столбцам. Стрелками можно пройти по ячейкам; значения — в таблице «Показать таблицей»." />
                {holidayText(fc) ? <p class="small muted">{holidayText(fc)}</p> : null}
              </>
            ) : null}
          </ChartCard>
        ) : (
          <ChartCard
            id="heat"
            title="Загрузка по дням недели и часам"
            badge={single ? 'факт' : null}
            sub={fact.peak ? `Пик — ${fact.rows[fact.peak.dow - 1].long}, ${pad(fact.peak.hour)}: ${Math.round(fact.peak.pct)} %` : 'Часы — от начала рабочих суток клуба'}
            switcher={switcher}
            busy={busy}
            empty={fact.empty}
            emptyText={emptyText}
            onExport={ctx.exportTable ? () => ctx.exportTable('hourly') : null}
            exporting={ctx.exporting === 'hourly'}
            table={() => heatTable(fact, 'Загрузка по дням недели и часам')}
          >
            <Heatmap matrix={fact} label="Тепловая карта загрузки: дни недели по строкам, часы по столбцам. Стрелками можно пройти по ячейкам; значения — в таблице «Показать таблицей»." />
          </ChartCard>
        )}
      </div>
      <PriceHints hints={hints} fc={fc} single={single} ctx={ctx} />
    </>
  );
}

/**
 * Подсказки по цене (№197): только подсказки — цены сами не меняются. Карточка: что заметили, окно, цифры,
 * «Открыть тарифы» — шаг тарифов мастера своего клуба (владелец и управляющий, №155–156). У «всех клубов» — имя клуба.
 */
function PriceHints({ hints, fc, single, ctx }) {
  const tariffs = (clubId) => `${BASE}c/${encodeURIComponent(clubId)}/onboarding/tariffs`;
  const canTariffs = can.setup(ctx.role);
  return (
    <section class="dsec dsec--wide" aria-labelledby="h-hints">
      <h2 class="section-title" id="h-hints">
        Подсказки по цене
      </h2>
      <p class="small muted">По загрузке за 8 недель. Это только подсказки: цены меняются только в тарифах, вручную — с причиной, владелец получит уведомление.</p>
      {single && fc && !fc.enough ? (
        <p class="muted">Подсказки появятся вместе с прогнозом, когда у клуба будет 14 дней истории.</p>
      ) : !hints.length ? (
        <p class="muted">Подсказок нет: загрузка без долгих провалов и очередей. Проверим снова, когда наберутся новые недели.</p>
      ) : (
        <ul class="phints">
          {hints.map((h) => (
            <li key={h.id} class={`phint phint--${h.tone}`}>
              <p class="phint__tag">
                <Icon name={h.tone === 'raise' ? 'up' : 'down'} />
                {h.tag}
                {h.clubName ? <span class="phint__club"> · {h.clubName}</span> : null}
              </p>
              <p class="phint__text">{h.text}</p>
              <dl class="phint__nums">
                <div>
                  <dt>Окно</dt>
                  <dd>{h.window}</dd>
                </div>
                {h.numbers.map((n) => (
                  <div key={n.key}>
                    <dt>{n.label}</dt>
                    <dd>{n.value}</dd>
                  </div>
                ))}
              </dl>
              {canTariffs ? (
                <a class="btn btn--secondary btn--sm phint__go" href={tariffs(h.clubId ?? ctx.club.club_id)} onClick={linkHandler}>
                  <Icon name="percent" />
                  Открыть тарифы{h.clubName ? <span class="visually-hidden"> клуба {h.clubName}</span> : null}
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
