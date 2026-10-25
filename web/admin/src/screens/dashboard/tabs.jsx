import { useEffect, useMemo, useState } from 'preact/hooks';
import { formatMoney, formatTime, formatDate, plural } from '@billiardum/shared/format';
import { countText, resourceName } from '@billiardum/shared/resource';
import { Icon } from '../../components/Icon.jsx';
import { HallPlan } from '../../components/HallPlan.jsx';
import { useMedia } from '../../components/hooks.js';
import { DataTable } from '../../components/DataTable.jsx';
import { TableDialog } from '../TableDialog.jsx';
import { api } from '../../lib/api.js';
import { can } from '../../lib/auth.js';
import { BASE } from '../../lib/env.js';
import { linkHandler } from '../../lib/router.js';
import { METHOD_LABEL, rowPlace } from '../../lib/words.js';
import { ACTION_LABEL } from '../../lib/audit.js';
import { alarmView } from '../../lib/alarms.js';
import { eachDay, dayLong, addDays } from '../../lib/period.js';
import {
  capacityRing,
  compactMoney,
  formatHours,
  formatMinutesShort,
  formatNumber,
  formatPct,
  formatSeconds,
  hallTotals,
  familyTotals,
  kindFamily,
  heatmapMatrix,
  isEmptyPeriod,
  kindCards,
  KIND_LABEL,
  lineSeries,
  share,
  stackedRows,
  TAB_TILES,
  tileViews,
} from '../../lib/dashboard.js';
import { ChartCard, Legend, Lines, Ring, Shares, StackedBars } from './charts.jsx';
import { HeatSection } from './forecast.jsx';
import { clothView } from '../../lib/maintenance.js';

const EMPTY_TEXT = 'За этот период игр не было. Цифры появятся после первой оплаченной игры.';
const GUESTS = ['гость', 'гостя', 'гостей'];
const SHIFTS = ['смена', 'смены', 'смен'];
const ALARMS = ['тревога', 'тревоги', 'тревог'];
const DAYS = ['день', 'дня', 'дней'];
const money = (v) => (Number.isFinite(v) ? formatMoney(Math.round(v)) : '—');
/** Средние — целыми рублями: копейки в среднем чеке — шум. */
const rub = (v) => (Number.isFinite(v) ? formatMoney(Math.round(v / 100) * 100) : '—');
const pctText = (v) => (Number.isFinite(v) ? formatPct(v) : '—');
const actionLabel = (a) => ACTION_LABEL[a] ?? a;

const REVENUE_SERIES = [
  { key: 'tables', label: 'Столы', cls: 'viz-1' },
  { key: 'bar', label: 'Бар', cls: 'viz-2' },
  { key: 'other', label: 'Прочее', cls: 'viz-3' },
];

const periodDays = (view, ctx) => eachDay(view.period.from ?? ctx.filters.from, view.period.to ?? ctx.filters.to);

// ---------- плитки ----------

export function Tile({ t }) {
  const [open, setOpen] = useState(false);
  const id = `tile-${t.id}`;
  return (
    <div class={`dtile${t.offTarget ? ' dtile--alert' : ''}${t.target !== null && !t.offTarget ? ' dtile--goal' : ''}`}>
      <div class="dtile__head">
        <p class="dtile__label" id={`${id}-label`}>
          {t.label}
        </p>
        <button type="button" class="dtile__info" aria-expanded={open ? 'true' : 'false'} aria-controls={`${id}-formula`} aria-label={`Как считается: ${t.label}`} onClick={() => setOpen((o) => !o)}>
          <Icon name="info" />
        </button>
      </div>
      <p class="dtile__value">{t.text}</p>
      {t.target !== null ? (
        <p class={`dtile__goal${t.offTarget ? ' dtile__goal--bad' : ''}`}>
          <Icon name={t.offTarget ? 'alert' : 'check'} />
          {t.offTarget ? `Цель — ${t.target}. Разберите каждую.` : `Цель ${t.target} — выполнена`}
        </p>
      ) : null}
      {t.delta ? (
        <p class={`dtile__delta dtile__delta--${t.delta.tone}`}>
          <span aria-hidden="true">{t.delta.text}</span>
          <span class="visually-hidden">{t.delta.spoken}</span>
          {t.prevText ? <span class="dtile__prev"> · было {t.prevText}</span> : null}
        </p>
      ) : null}
      {t.parts ? (
        <ul class="dtile__parts">
          {t.parts.map((p) => (
            <li key={p.key}>
              <span>{p.label}</span>
              <b>{p.text}</b>
              <span class="dtile__pct">{p.pct ?? ''}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p class="dtile__formula" id={`${id}-formula`} hidden={!open}>
        {t.formula}
      </p>
    </div>
  );
}

function Tiles({ view, tab, ctx, busy }) {
  const tiles = tileViews(view.tiles, TAB_TILES[tab], { compare: ctx.filters.compare, family: kindFamily(ctx.filters.kind) });
  if (!tiles.length) return null;
  return (
    <div class={`dtiles${busy ? ' is-busy' : ''}`} aria-busy={busy ? 'true' : undefined}>
      {tiles.map((t) => (
        <Tile key={t.id} t={t} />
      ))}
    </div>
  );
}

function EmptyNote({ view }) {
  if (!isEmptyPeriod(view)) return null;
  return (
    <div class="dash__empty" role="status">
      <Icon name="chart" />
      <p>
        <b>За этот период игр не было.</b>
      </p>
      <p class="muted">Цифры появятся после первой оплаченной игры. Выберите другой период или загляните позже.</p>
    </div>
  );
}

/** Сутки, которые планировщик ещё не досчитал (period.missing_days) — честно говорим, что цифры неполные. */
function MissingNote({ view }) {
  const n = view.period.missing.length;
  if (!n) return null;
  return (
    <p class="note note--lamp dsec--wide" role="status">
      <Icon name="hourglass" />
      <span class="note__title">
        Данные досчитываются: ещё {n} {plural(n, ['сутки', 'суток', 'суток'])} без итогов. Обновите страницу через пару минут.
      </span>
    </p>
  );
}

// ---------- зал сейчас ----------

function busyRing(busy, total) {
  return [
    { key: 'busy', label: 'Занято', value: busy, cls: 'viz-2', text: `${busy}` },
    { key: 'free', label: 'Свободно', value: Math.max(0, total - busy), cls: 'vring__free', text: `${Math.max(0, total - busy)}` },
  ];
}

function KindCards({ now }) {
  const cards = kindCards(now?.byKind);
  const totals = hallTotals(now?.byKind);
  // M5.8: клуб со столами и кортами — «Столы: занято 5 из 8 · Корты: занято 1 из 2» под итогом зала
  const fams = familyTotals(now?.byKind);
  if (!cards.length) return <p class="muted">Столов в работе пока нет. Добавьте их в разделе «Подключение» → «План зала».</p>;
  return (
    <div class="dkinds">
      <div class="dkind dkind--total">
        <Ring size={76} thickness={10} interactive={false} segments={busyRing(totals.busy, totals.total)} center={`${Math.round(totals.pct ?? 0)}\u00a0%`} label={`Весь зал: занято ${totals.busy} из ${totals.total}`} />
        <div>
          <p class="dkind__title">Весь зал</p>
          <p class="dkind__busy">
            занято <b>{totals.busy}</b> / {totals.total}
          </p>
          <p class="small muted">
            {Number.isFinite(now.loadNow) ? `Сейчас ${formatPct(now.loadNow)}` : null}
            {Number.isFinite(now.loadDay) ? ` · за сутки ${formatPct(now.loadDay)}` : null}
          </p>
          {Number.isFinite(now.revenueToday) ? <p class="small">Сегодня {money(now.revenueToday)}</p> : null}
          {fams.length ? <p class="small">{fams.map((x) => `${x.label}: ${x.words}`).join(' · ')}</p> : null}
        </div>
      </div>
      {cards.map((c) => (
        <div class="dkind" key={c.kind}>
          <Ring size={76} thickness={10} interactive={false} segments={busyRing(c.busy, c.total)} center={`${Math.round(c.pct ?? 0)}\u00a0%`} label={`${c.label}: ${c.words}`} />
          <div>
            <p class="dkind__title">{c.label}</p>
            <p class="dkind__busy">
              занято <b>{c.busy}</b> / {c.total}
            </p>
            <p class="small muted">{[c.booked ? `бронь ${c.booked}` : null, c.service ? `сервис ${c.service}` : null].filter(Boolean).join(' · ') || 'без броней и сервиса'}</p>
            {c.revenue !== null ? <p class="small">Сегодня {money(c.revenue)}</p> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function OnShift({ now, timeZone }) {
  const list = now?.onShift ?? [];
  return (
    <p class="dshift">
      <Icon name="user" />
      {list.length ? (
        <span>
          В смене:{' '}
          {list.map((s, i) => (
            <span key={i}>
              {i ? '; ' : ''}
              <b>{s.name ?? 'Сотрудник'}</b>
              {s.since ? ` с ${formatTime(s.since, timeZone)}` : ''}
              {s.club ? ` (${s.club})` : ''}
            </span>
          ))}
        </span>
      ) : (
        <span>Смена не открыта.</span>
      )}
    </p>
  );
}

// ---------- графики ----------

function RevenueChart({ view, ctx, busy }) {
  const rows = useMemo(() => stackedRows(view.revenueDaily, REVENUE_SERIES.map((s) => s.key), { days: periodDays(view, ctx), today: ctx.today }), [view]);
  const title = 'Выручка по дням';
  return (
    <ChartCard
      id="rev"
      title={title}
      sub="Столы, бар и прочее, до возвратов; текущий день выделен"
      busy={busy}
      empty={rows.empty}
      emptyText={EMPTY_TEXT}
      legend={<Legend items={REVENUE_SERIES} />}
      onExport={ctx.exportTable ? () => ctx.exportTable('revenue_daily') : null}
      exporting={ctx.exporting === 'revenue_daily'}
      table={() => (
        <DataTable
          caption={title}
          columns={[
            { key: 'date', label: 'Дата', head: true, render: (r) => `${dayLong(r.date)}${r.today ? ' (сегодня)' : ''}` },
            ...REVENUE_SERIES.map((s, k) => ({ key: s.key, label: s.label, num: true, render: (r) => money(r.values[k]) })),
            { key: 'total', label: 'Всего', num: true, render: (r) => money(r.total) },
          ]}
          rows={rows.rows}
          rowKey={(r) => r.date}
        />
      )}
    >
      <StackedBars data={rows} series={REVENUE_SERIES} format={money} axisFormat={compactMoney} label={`${title}: столбцы, ${rows.rows.length} ${plural(rows.rows.length, DAYS)}. Значения — в таблице «Показать таблицей».`} />
    </ChartCard>
  );
}

/** «Выручка за 30 дней» (§3, как у LANGAME): одна серия — чистая выручка, текущий день выделен. */
function Revenue30Chart({ view, ctx, busy }) {
  const days = view.revenue30.length ? view.revenue30.map((r) => r.date) : eachDay(addDays(ctx.filters.to, -29), ctx.filters.to);
  const rows = useMemo(() => stackedRows(view.revenue30, ['net'], { days, today: ctx.today }), [view]);
  const series = [{ key: 'net', label: 'Выручка', cls: 'viz-1' }];
  return (
    <ChartCard
      id="rev30"
      title="Выручка за 30 дней"
      sub="За вычетом возвратов, по конец периода; текущий день выделен"
      busy={busy}
      empty={rows.empty}
      emptyText="За 30 дней оплат не было."
      onExport={ctx.exportTable ? () => ctx.exportTable('revenue_daily') : null}
      exporting={ctx.exporting === 'revenue_daily'}
      table={() => <DataTable caption="Выручка за 30 дней" columns={[{ key: 'date', label: 'Дата', head: true, render: (r) => `${dayLong(r.date)}${r.today ? ' (сегодня)' : ''}` }, { key: 'net', label: 'Выручка', num: true, render: (r) => money(r.total) }]} rows={rows.rows} rowKey={(r) => r.date} />}
    >
      <StackedBars data={rows} series={series} format={money} axisFormat={compactMoney} label="Выручка за 30 дней: столбцы по дням. Значения — в таблице «Показать таблицей»." />
    </ChartCard>
  );
}

// ---------- Сводка ----------

function ClubsTable({ view }) {
  if (!view.clubs.length) return null;
  return (
    <section class="dsec dsec--wide" aria-labelledby="sum-clubs">
      <h2 class="section-title" id="sum-clubs">
        По клубам
      </h2>
      <DataTable
        caption="По клубам"
        columns={[
          { key: 'name', label: 'Клуб', head: true, sortValue: (c) => c.name ?? '' },
          { key: 'revenue', label: 'Выручка', num: true, sortValue: (c) => c.revenue_kopecks ?? 0, render: (c) => money(c.revenue_kopecks) },
          { key: 'games', label: 'Игр', num: true, sortValue: (c) => c.games ?? 0, render: (c) => formatNumber(c.games ?? 0) },
          { key: 'hours', label: 'Часов игры', num: true, render: (c) => (Number.isFinite(c.play_hours) ? formatHours(c.play_hours * 60) : '—') },
          { key: 'util', label: 'Загрузка', num: true, render: (c) => pctText(c.utilization_pct) },
          { key: 'guests', label: 'Гостей', num: true, render: (c) => formatNumber(c.guests ?? 0) },
        ]}
        rows={view.clubs}
        rowKey={(c) => c.club_id}
      />
    </section>
  );
}

export function SummaryTab({ view, now, busy, ctx }) {
  return (
    <div class="dgrid">
      <MissingNote view={view} />
      <EmptyNote view={view} />
      <Tiles view={view} tab="summary" ctx={ctx} busy={busy} />
      <section class="dsec dsec--wide" aria-labelledby="sum-hall">
        <div class="dsec__head">
          <h2 class="section-title" id="sum-hall">
            Статус зала сейчас
          </h2>
          <button type="button" class="btn btn--quiet btn--sm" onClick={() => ctx.onTab('hall')}>
            Схема зала
            <Icon name="forward" />
          </button>
        </div>
        {now ? <KindCards now={now} /> : <p class="muted loading">Загружаем зал…</p>}
        {now ? <OnShift now={now} timeZone={ctx.timeZone} /> : null}
      </section>
      <ClubsTable view={view} />
      <div class="dsec--wide">
        <RevenueChart view={view} ctx={ctx} busy={busy} />
      </div>
    </div>
  );
}

// ---------- Деньги ----------

const STRUCTURE = { tables: 'Столы', bar: 'Бар', deposits: 'Депозиты', packages: 'Пакеты часов', tournaments: 'Взносы турниров', other: 'Прочее' };
const SOURCES = { qr: 'QR гостя', reception: 'Касса ресепшена', booking: 'Онлайн-бронь', online_booking: 'Онлайн-бронь', tournament: 'Турнир' };

function SharesCard({ id, title, list, labels, busy, note }) {
  const rows = list.filter((r) => labels[r.id]).map((r) => ({ key: r.id, label: labels[r.id], value: Math.max(0, r.amount) }));
  const total = rows.reduce((s, r) => s + r.value, 0);
  return (
    <section class={`dsec${busy ? ' is-busy' : ''}`} aria-labelledby={id}>
      <h2 class="section-title" id={id}>
        {title}
      </h2>
      {total ? <Shares rows={rows} total={total} format={money} /> : <p class="muted">За этот период оплат не было.</p>}
      {note}
    </section>
  );
}

export function MoneyTab({ view, busy, ctx }) {
  const m = view.money;
  const cash = m.cash;
  const days = periodDays(view, ctx);
  const checks = useMemo(() => lineSeries(m.daily, ['avg_check_game', 'avg_check_bar'], { days }), [view]);
  const CHECKS = [
    { key: 'avg_check_game', label: 'Средний чек игры', cls: 'viz-1' },
    { key: 'avg_check_bar', label: 'Средний чек бара', cls: 'viz-2' },
  ];
  const clubPath = `${BASE}c/${encodeURIComponent(ctx.club.club_id)}/`;
  const refundsByMethod = m.methods.filter((x) => x.refunds > 0);
  return (
    <div class="dgrid">
      <MissingNote view={view} />
      <EmptyNote view={view} />
      <Tiles view={view} tab="money" ctx={ctx} busy={busy} />
      <SharesCard id="m-structure" title="Структура выручки" list={m.structure} labels={STRUCTURE} busy={busy} />
      <SharesCard
        id="m-methods"
        title="Способы оплаты"
        list={m.methods}
        labels={METHOD_LABEL}
        busy={busy}
        note={
          <p class="small">
            Возвраты: {m.refunds.count ? `${formatNumber(m.refunds.count)} на ${money(m.refunds.amount)}` : 'не было'}
            {refundsByMethod.length ? ` (${refundsByMethod.map((x) => `${(METHOD_LABEL[x.id] ?? x.id).toLowerCase()} ${money(x.refunds)}`).join(', ')})` : ''}.
          </p>
        }
      />
      <SharesCard id="m-sources" title="Источники" list={m.sources} labels={SOURCES} busy={busy} />
      <section class={`dsec${busy ? ' is-busy' : ''}`} aria-labelledby="m-cash">
        <div class="dsec__head">
          <h2 class="section-title" id="m-cash">
            Наличные в кассе
          </h2>
          <a class="btn btn--quiet btn--sm" href={`${clubPath}reports/cashbook`} onClick={linkHandler}>
            Касса управляющего
            <Icon name="forward" />
          </a>
        </div>
        {cash ? (
          <dl class="receipt">
            {Number.isFinite(cash.start) ? (
              <div class="receipt__row">
                <dt>Размен на начало</dt>
                <dd class="receipt__sum">{money(cash.start)}</dd>
              </div>
            ) : null}
            <div class="receipt__row">
              <dt>Пришло наличными</dt>
              <dd class="receipt__sum">{money(cash.sales)}</dd>
            </div>
            {cash.refunds ? (
              <div class="receipt__row">
                <dt>Возвраты наличными</dt>
                <dd class="receipt__sum">−{money(cash.refunds)}</dd>
              </div>
            ) : null}
            <div class="receipt__row">
              <dt>Инкассации</dt>
              <dd class="receipt__sum">−{money(cash.collections)}</dd>
            </div>
            <div class="receipt__row">
              <dt>{cash.discrepancy ? <Icon name="alert" /> : null} Расхождения смен</dt>
              <dd class={`receipt__sum${cash.discrepancy ? ' dneg' : ''}`}>{cash.discrepancy ? money(cash.discrepancy) : 'нет'}</dd>
            </div>
          </dl>
        ) : (
          <p class="muted">{ctx.filters.kind ? 'Касса считается по всему клубу: уберите фильтр по типу стола.' : 'Нет данных о кассе за период.'}</p>
        )}
        {m.shifts.length ? (
          <p class="small muted">
            {m.shifts.length} {plural(m.shifts.length, SHIFTS)} за период.{' '}
            <a class="rlink" href={`${clubPath}reports/shifts?from=${ctx.filters.from}&to=${ctx.filters.to}`} onClick={linkHandler}>
              Список смен
            </a>
          </p>
        ) : null}
      </section>
      {m.expenses.length ? (
        <section class={`dsec${busy ? ' is-busy' : ''}`} aria-labelledby="m-exp">
          <h2 class="section-title" id="m-exp">
            Расходы по статьям
          </h2>
          <Shares rows={m.expenses.map((e) => ({ key: e.name, label: e.name, value: e.amount }))} total={m.expenses.reduce((s, e) => s + e.amount, 0)} format={money} />
        </section>
      ) : null}
      <div class="dsec--wide">
        <Revenue30Chart view={view} ctx={ctx} busy={busy} />
      </div>
      <div class="dsec--wide">
        <ChartCard
          id="checks"
          title="Средние чеки по дням"
          busy={busy}
          empty={checks.empty}
          emptyText={EMPTY_TEXT}
          legend={<Legend items={CHECKS} kind="line" />}
          onExport={ctx.exportTable ? () => ctx.exportTable('revenue_daily') : null}
          exporting={ctx.exporting === 'revenue_daily'}
        >
          <Lines data={checks} series={CHECKS} format={rub} axisFormat={compactMoney} label="Средний чек игры и бара по дням: линии. Значения — в таблице по дням ниже." />
        </ChartCard>
      </div>
      <section class={`dsec dsec--wide${busy ? ' is-busy' : ''}`} aria-labelledby="m-daily">
        <div class="dsec__head">
          <h2 class="section-title" id="m-daily">
            По дням
          </h2>
          {ctx.exportTable && m.daily.length ? (
            <button type="button" class="btn btn--quiet btn--sm" onClick={() => ctx.exportTable('revenue_daily')} disabled={ctx.exporting === 'revenue_daily'}>
              <Icon name="download" />
              Скачать CSV
            </button>
          ) : null}
        </div>
        {m.daily.some((d) => d.revenue || d.games) ? (
          <DataTable
            caption="По дням"
            limit={10}
            columns={[
              { key: 'date', label: 'Дата', head: true, sortValue: (d) => d.date, render: (d) => `${dayLong(d.date)}${d.today ? ' (сегодня)' : ''}` },
              { key: 'revenue', label: 'Выручка', num: true, sortValue: (d) => d.revenue, render: (d) => money(d.revenue) },
              { key: 'games', label: 'Игр', num: true, sortValue: (d) => d.games, render: (d) => formatNumber(d.games) },
              { key: 'cg', label: 'Чек игры', num: true, sortValue: (d) => d.avg_check_game, render: (d) => rub(d.avg_check_game) },
              { key: 'cb', label: 'Чек бара', num: true, sortValue: (d) => d.avg_check_bar, render: (d) => rub(d.avg_check_bar) },
              { key: 'util', label: 'Загрузка', num: true, sortValue: (d) => d.utilization, render: (d) => pctText(d.utilization) },
            ]}
            rows={[...m.daily].reverse()}
            rowKey={(d) => d.date}
          />
        ) : (
          <p class="muted">{EMPTY_TEXT}</p>
        )}
      </section>
    </div>
  );
}

// ---------- Зал ----------

const KIND_SERIES_CLS = ['viz-1', 'viz-2', 'viz-3'];

export function HallTab({ view, now, busy, ctx }) {
  const narrow = useMedia('(max-width: 639px)');
  const [table, setTable] = useState(null);
  const [plan, setPlan] = useState(null);
  const h = view.hall;
  const tz = ctx.timeZone;
  const single = ctx.scope !== 'all';
  // Схема зала — тот же ответ, что у «Сейчас» (GET …/now): стол открывается тем же окном
  const loadPlan = async () => {
    try {
      const n = await api.now(ctx.club.club_id);
      setPlan(Array.isArray(n?.hall) ? n.hall : []);
    } catch {
      setPlan([]);
    }
  };
  useEffect(() => {
    if (!single) return undefined;
    loadPlan();
    const t = setInterval(() => document.visibilityState === 'visible' && loadPlan(), 30000);
    return () => clearInterval(t);
  }, [single, ctx.club.club_id]);
  const matrix = useMemo(() => heatmapMatrix(h.cells, view.period.dayStart), [view]);
  const ring = capacityRing(h.ring);
  const days = periodDays(view, ctx);
  const kindKeys = ctx.filters.kind ? [ctx.filters.kind] : view.period.kinds.slice(0, 3);
  const loadKeys = kindKeys.length > 1 ? kindKeys : ['total'];
  const loadSeries = loadKeys.map((k, i) => ({ key: k, label: k === 'total' ? 'Загрузка' : (KIND_LABEL[k] ?? k), cls: KIND_SERIES_CLS[i] }));
  const load = useMemo(() => lineSeries(h.loadDaily, loadKeys, { days }), [view, loadKeys.join()]);
  const ringSegments = ring
    ? [
        { key: 'played', label: 'Сыграно', value: ring.segments[0].minutes, cls: 'viz-1', text: formatHours(ring.segments[0].minutes) },
        { key: 'service', label: 'Сервис', value: ring.segments[1].minutes, cls: 'viz-2', text: formatHours(ring.segments[1].minutes) },
        { key: 'unrealized', label: 'Нереализовано', value: ring.segments[2].minutes, cls: 'viz-rest', text: formatHours(ring.segments[2].minutes) },
      ]
    : [];
  return (
    <div class="dgrid">
      <section class="dsec dsec--wide" aria-labelledby="hall-now">
        <h2 class="section-title" id="hall-now">
          Сейчас
        </h2>
        {now ? <KindCards now={now} /> : <p class="muted loading">Загружаем зал…</p>}
        {now ? <OnShift now={now} timeZone={tz} /> : null}
        {!single ? (
          <p class="hint">Схема зала у каждого клуба своя — выберите клуб в фильтре сверху.</p>
        ) : plan?.length ? (
          <>
            <HallPlan items={plan} timeZone={tz} onSelect={setTable} perRow={narrow ? 4 : undefined} selected={table?.resource?.id} label="Схема зала" />
            <TableDialog item={plan.find((x) => x.resource.id === table?.resource?.id) ?? table} role={ctx.role} timeZone={tz} onClose={() => setTable(null)} onChanged={() => (loadPlan(), ctx.reloadNow())} />
          </>
        ) : plan ? (
          <p class="muted">Схемы зала пока нет: расставьте столы в «Подключении» → «План зала».</p>
        ) : null}
      </section>
      <MissingNote view={view} />
      <EmptyNote view={view} />
      <Tiles view={view} tab="hall" ctx={ctx} busy={busy} />
      <HeatSection view={view} ctx={ctx} busy={busy} emptyText={EMPTY_TEXT} />
      <ChartCard
        id="cap"
        title="Загрузка в часах"
        sub={ring ? `Ёмкость ${formatHours(ring.capacity)}: столы в работе × часы работы клуба` : null}
        busy={busy}
        empty={!ring || matrix.empty}
        emptyText={EMPTY_TEXT}
        onExport={ctx.exportTable ? () => ctx.exportTable('hourly') : null}
        exporting={ctx.exporting === 'hourly'}
        table={() => (
          <DataTable
            caption="Загрузка в часах"
            columns={[
              { key: 'label', label: 'Часы', head: true },
              { key: 'hours', label: 'Сколько', num: true },
              { key: 'pct', label: 'Доля ёмкости', num: true },
            ]}
            rows={[{ label: 'Ёмкость', hours: formatHours(ring.capacity), pct: '100 %' }, ...ring.segments.map((s) => ({ label: s.label, hours: formatHours(s.minutes), pct: formatPct(s.pct) }))]}
            rowKey={(r) => r.label}
          />
        )}
      >
        {ring ? (
          <div class="dcap">
            <Ring segments={ringSegments} center={formatPct(ring.segments[0].pct)} centerSub="сыграно" label={`Загрузка в часах: сыграно ${formatPct(ring.segments[0].pct)} ёмкости`} />
            <Legend items={[{ key: 'cap', label: 'Ёмкость', cls: 'viz-none', value: formatHours(ring.capacity) }, ...ringSegments.map((s, i) => ({ key: s.key, label: s.label, cls: s.cls, value: `${s.text} · ${formatPct(ring.segments[i].pct)}` }))]} />
          </div>
        ) : null}
      </ChartCard>
      <ChartCard
        id="loadd"
        title={loadSeries.length > 1 ? 'Загрузка по дням и типам столов' : 'Загрузка по дням'}
        busy={busy}
        empty={load.empty || matrix.empty}
        emptyText={EMPTY_TEXT}
        legend={loadSeries.length > 1 ? <Legend items={loadSeries} kind="line" /> : null}
        table={() => (
          <DataTable
            caption="Загрузка по дням"
            columns={[{ key: 'date', label: 'Дата', head: true, render: (r) => dayLong(r.date) }, ...loadSeries.map((s, k) => ({ key: s.key, label: s.label, num: true, render: (r) => pctText(load.series[k].points[r.i]) }))]}
            rows={load.dates.map((date, i) => ({ date, i }))}
            rowKey={(r) => r.date}
          />
        )}
      >
        <Lines data={load} series={loadSeries} format={pctText} axisFormat={(v) => `${v}\u00a0%`} fixedMax={100} label="Загрузка столов по дням в процентах: линии. Значения — в таблице «Показать таблицей»." />
      </ChartCard>
      <section class={`dsec dsec--wide${busy ? ' is-busy' : ''}`} aria-labelledby="h-tables">
        <div class="dsec__head">
          <h2 class="section-title" id="h-tables">
            {h.resources.some((r) => r.family === 'court') ? (h.resources.every((r) => r.family === 'court') ? 'По кортам' : 'По столам и кортам') : 'По столам'}
          </h2>
          {ctx.exportTable && h.resources.length ? (
            <button type="button" class="btn btn--quiet btn--sm" onClick={() => ctx.exportTable('tables')} disabled={ctx.exporting === 'tables'}>
              <Icon name="download" />
              Скачать CSV
            </button>
          ) : null}
        </div>
        {h.byKind.length > 1 ? (
          <ul class="dkindsum">
            {h.byKind.map((k) => (
              <li key={k.kind}>
                <b>{KIND_LABEL[k.kind] ?? k.kind}</b> · {countText(k.resources, k.family)} · {formatHours(k.play_minutes)} · {pctText(k.load)} · {money(k.revenue)}
              </li>
            ))}
          </ul>
        ) : null}
        {h.resources.length ? (
          <DataTable
            caption={h.resources.some((r) => r.family === 'court') ? 'По столам и кортам' : 'По столам'}
            columns={[
              // Столы, затем корты; «Корт 1» и «Стол 1» — разные ресурсы (№213)
              { key: 'number', label: h.resources.some((r) => r.family === 'court') ? 'Стол или корт' : 'Стол', head: true, sortValue: (r) => (r.family === 'court' ? 10_000 : 0) + r.number, render: (r) => `${r.title ?? resourceName(r.family, r.number)} · ${KIND_LABEL[r.kind] ?? r.kind}${r.club ? ` · ${r.club}` : ''}` },
              { key: 'games', label: 'Игр', num: true, sortValue: (r) => r.games ?? 0, render: (r) => (Number.isFinite(r.games) ? formatNumber(r.games) : '—') },
              { key: 'play', label: 'Часы игры', num: true, sortValue: (r) => r.play_minutes, render: (r) => formatHours(r.play_minutes) },
              { key: 'revenue', label: 'Выручка', num: true, sortValue: (r) => r.revenue ?? 0, render: (r) => money(r.revenue) },
              { key: 'load', label: 'Загрузка', num: true, sortValue: (r) => r.load ?? -1, render: (r) => pctText(r.load) },
              // M5.6 (№198): часы игры с последней замены сукна; порог достигнут — словом, не только цветом
              { key: 'cloth', label: 'С замены сукна, ч', num: true, sortValue: (r) => r.cloth_hours ?? -1, render: (r) => <ClothCell r={r} /> },
            ].filter((col) => col.key !== 'cloth' || h.resources.some((r) => r.family !== 'court'))}
            rows={h.resources}
            rowKey={(r) => r.id}
          />
        ) : (
          <p class="muted">Столов в работе пока нет.</p>
        )}
        {single && can.reportsView(ctx.role) ? (
          <p class="small">
            <a class="dlink" href={`${BASE}c/${encodeURIComponent(ctx.club.club_id)}/reports/maintenance`} onClick={linkHandler}>
              <Icon name="wrench" />
              Обслуживание столов: замены, счётчики и пороги
            </a>
          </p>
        ) : null}
      </section>
    </div>
  );
}

/** Часы с замены сукна (текущий счётчик, не за период): «1 629» и «порог 1 500» словом, если достигнут. */
function ClothCell({ r }) {
  // Сукна у корта нет: обслуживание и износ — только у столов (№211)
  if (r.family === 'court') return <span class="muted">нет сукна</span>;
  const c = clothView(r);
  if (!c) return <span class="muted">не отмечено</span>;
  return (
    <span class={c.due ? 'dcloth dcloth--reached' : 'dcloth'}>
      {formatNumber(c.hours)}
      {c.due ? (
        <span class="dcloth__flag">
          <Icon name="wrench" />
          {c.threshold ? `порог ${formatNumber(c.threshold)}` : 'пора менять'}
        </span>
      ) : null}
      <span class="dcloth__since">{c.since ? `с ${dayLong(c.since)}` : 'с начала учёта'}</span>
    </span>
  );
}

// ---------- Гости и брони ----------

function Stat({ label, value, sub }) {
  return (
    <div class="dstat">
      <dt>{label}</dt>
      <dd>
        <b>{value}</b>
        {sub ? <span class="small muted"> {sub}</span> : null}
      </dd>
    </div>
  );
}
const pctOf = (a, b) => {
  const p = share(a, b);
  return p === null ? null : `${Math.round(p)} %`;
};
const pctRound = (v) => (Number.isFinite(v) ? `${Math.round(v)} %` : null);

export function GuestsTab({ view, busy, ctx }) {
  const g = view.guests;
  const total = g.new + g.repeat;
  const GSERIES = [
    { key: 'new', label: 'Новые', cls: 'viz-1' },
    { key: 'returning', label: 'Повторные', cls: 'viz-2' },
  ];
  const rows = useMemo(() => stackedRows(g.daily, ['new', 'returning'], { days: periodDays(view, ctx), today: ctx.today }), [view]);
  const n = (v) => formatNumber(v ?? 0);
  return (
    <div class="dgrid">
      <MissingNote view={view} />
      <EmptyNote view={view} />
      <Tiles view={view} tab="guests" ctx={ctx} busy={busy} />
      <section class={`dsec${busy ? ' is-busy' : ''}`} aria-labelledby="g-guests">
        <h2 class="section-title" id="g-guests">
          Гости
        </h2>
        <dl class="dstats">
          <Stat label="Новые" value={n(g.new)} sub={pctRound(g.newPct) ?? pctOf(g.new, total)} />
          <Stat label="Повторные" value={n(g.repeat)} sub={pctRound(g.repeatPct) ?? pctOf(g.repeat, total)} />
          <Stat label="Потерянные" value={n(g.lost)} sub="играли 3+ раза, не были 60 дней" />
        </dl>
        <p class="small muted">Только количества — без имён и телефонов.</p>
      </section>
      <section class={`dsec${busy ? ' is-busy' : ''}`} aria-labelledby="g-book">
        <h2 class="section-title" id="g-book">
          Брони
        </h2>
        <dl class="dstats">
          <Stat label="Всего" value={n(g.bookings.total)} sub={g.bookings.upcoming ? `ещё впереди ${g.bookings.upcoming}` : null} />
          <Stat label="Пришли" value={n(g.bookings.came)} sub={pctOf(g.bookings.came, g.bookings.total)} />
          <Stat label="Не пришли" value={n(g.bookings.noShow)} sub={pctOf(g.bookings.noShow, g.bookings.total)} />
          <Stat label="Отменены" value={n(g.bookings.canceled)} sub={pctOf(g.bookings.canceled, g.bookings.total)} />
          <Stat label="Бронь → игра" value={Number.isFinite(g.bookings.lead) ? formatMinutesShort(g.bookings.lead) : '—'} sub="в среднем у пришедших" />
        </dl>
      </section>
      <section class={`dsec${busy ? ' is-busy' : ''}`} aria-labelledby="g-more">
        <h2 class="section-title" id="g-more">
          Очередь, продления, пакеты
        </h2>
        <dl class="dstats">
          <Stat label="Очередь: предложено" value={n(g.waitlist.offered)} />
          <Stat label="Очередь: заняли стол" value={n(g.waitlist.accepted)} sub={pctOf(g.waitlist.accepted, g.waitlist.offered)} />
          <Stat label="Продлений" value={n(g.extensions.total)} sub={g.extensions.free ? `бесплатных ${g.extensions.free}` : null} />
          <Stat label="Из приложения" value={n(g.extensions.fromApp)} sub={pctRound(g.extensions.pct) ?? pctOf(g.extensions.fromApp, g.extensions.total)} />
          <Stat label="Пакетов продано" value={n(g.packages.sold)} sub={Number.isFinite(g.packages.soldMinutes) ? `на ${formatHours(g.packages.soldMinutes)}` : null} />
          <Stat label="Пакетами сыграно" value={Number.isFinite(g.packages.usedMinutes) ? formatHours(g.packages.usedMinutes) : '—'} />
        </dl>
      </section>
      <section class={`dsec${busy ? ' is-busy' : ''}`} aria-labelledby="g-tour">
        <h2 class="section-title" id="g-tour">
          Турниры и Бильярдум+
        </h2>
        <dl class="dstats">
          <Stat label="Участников турниров" value={n(g.tournaments.participants)} />
          <Stat label="Взносы" value={money(g.tournaments.fees)} />
          <Stat label="Партий засчитано" value={n(g.plus)} sub="в рейтинг Бильярдум+" />
        </dl>
      </section>
      <div class="dsec--wide">
        <ChartCard
          id="guestsd"
          title="Гости по дням"
          sub="Новые и повторные за сутки (сумма по дням больше гостей периода: один гость приходит в разные дни)"
          busy={busy}
          empty={rows.empty}
          emptyText="За этот период гостей не было."
          legend={<Legend items={GSERIES} />}
          onExport={ctx.exportTable ? () => ctx.exportTable('bookings') : null}
          exporting={ctx.exporting === 'bookings'}
          table={() => (
            <DataTable
              caption="Гости по дням"
              columns={[
                { key: 'date', label: 'Дата', head: true, render: (r) => dayLong(r.date) },
                { key: 'new', label: 'Новые', num: true, render: (r) => formatNumber(r.values[0]) },
                { key: 'returning', label: 'Повторные', num: true, render: (r) => formatNumber(r.values[1]) },
              ]}
              rows={rows.rows}
              rowKey={(r) => r.date}
            />
          )}
        >
          <StackedBars data={rows} series={GSERIES} format={(v) => `${formatNumber(v)} ${plural(v, GUESTS)}`} axisFormat={(v) => formatNumber(v)} label="Гости по дням: столбцы, новые и повторные. Значения — в таблице «Показать таблицей»." />
        </ChartCard>
      </div>
    </div>
  );
}

// ---------- Контроль ----------

export function ControlTab({ view, busy, ctx }) {
  const c = view.control;
  const tz = ctx.timeZone;
  const pilot = c.pilot;
  const r = c.reaction;
  const [onlyProblems, setOnlyProblems] = useState(false);
  const clubPath = `${BASE}c/${encodeURIComponent(ctx.club.club_id)}/`;
  const journalPeriod = ctx.filters.preset === 'today' || ctx.filters.preset === 'yesterday' ? ctx.filters.preset : 'week';
  const journal = (extra = '') => `${clubPath}journal?group=manual&period=${journalPeriod}${extra}`;
  // Сводки по видам и сотрудникам — от сервера; нет — считаем по списку
  const byAction = useMemo(() => {
    if (c.byAction.length) return c.byAction.map((x) => [x.action, x.count]);
    const m = new Map();
    for (const a of c.manual) m.set(a.action, (m.get(a.action) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [view]);
  const byStaff = useMemo(() => {
    if (c.byStaff.length) return c.byStaff;
    const m = new Map();
    for (const a of c.manual) {
      const k = a.staff_id ?? a.staff_name ?? '—';
      const e = m.get(k) ?? { id: a.staff_id, name: a.staff_name ?? 'Сотрудник', count: 0, map: new Map() };
      e.count += 1;
      e.map.set(a.action, (e.map.get(a.action) ?? 0) + 1);
      m.set(k, e);
    }
    return [...m.values()].map((e) => ({ id: e.id, name: e.name, count: e.count, actions: [...e.map] })).sort((a, b) => b.count - a.count);
  }, [view]);
  const pick = (list) => (onlyProblems ? list.filter((g) => g.problem) : list);
  const lights = pilot.lights;
  const statLine = (g) => `${g.count}${Number.isFinite(g.avg) ? ` · в среднем ${formatMinutesShort(g.avg)}` : ''}`;
  const alarmRows = onlyProblems ? r.rows.filter((a) => a.problem) : r.rows;
  return (
    <div class="dgrid">
      <MissingNote view={view} />
      <Tiles view={view} tab="control" ctx={ctx} busy={busy} />
      <section class={`dsec dsec--wide${busy ? ' is-busy' : ''}`} aria-labelledby="c-pilot">
        <h2 class="section-title" id="c-pilot">
          Метрики пилота
        </h2>
        <div class={`dgoal${lights > 0 ? ' dgoal--bad' : ''}`}>
          <Icon name={lights > 0 ? 'alert' : 'check'} />
          <p>
            <b>Свет без записи в журнале: {Number.isFinite(lights) ? formatNumber(lights) : '—'}</b>
            {pilot.lightsDetail && lights > 0 ? <span class="small"> (команд {pilot.lightsDetail.commands}, игр {pilot.lightsDetail.sessions})</span> : null}
            <br />
            <span class="small">{lights > 0 ? 'Цель — 0. Разберите каждую: откройте журнал и тревоги за эти сутки.' : 'Цель — 0. Свет горел только с записью в журнале.'}</span>
          </p>
        </div>
        <dl class="dstats">
          <Stat label="Игр без персонала" value={pctText(pilot.noStaffPct)} sub="запустил гость по QR или брони" />
          <Stat label="Скан → свет, медиана" value={Number.isFinite(pilot.scanMedian) ? formatSeconds(pilot.scanMedian) : '—'} sub={Number.isFinite(pilot.scanUnder20) ? `быстрее 20 с — ${Math.round(pilot.scanUnder20)} %` : 'цель — меньше 20 с'} />
          <Stat label="Продлений из приложения" value={pctText(pilot.extAppPct)} />
        </dl>
      </section>

      <section class={`dsec dsec--wide${busy ? ' is-busy' : ''}`} aria-labelledby="c-manual">
        <div class="dsec__head">
          <h2 class="section-title" id="c-manual">
            Ручные действия
            {c.manual.length ? <span class="count">{c.manual.length}</span> : null}
          </h2>
          <div class="dsec__tools">
            <a class="btn btn--quiet btn--sm" href={journal()} onClick={linkHandler}>
              <Icon name="journal" />
              Открыть в журнале
            </a>
            {ctx.exportTable && c.manual.length ? (
              <button type="button" class="btn btn--quiet btn--sm" onClick={() => ctx.exportTable('manual')} disabled={ctx.exporting === 'manual'}>
                <Icon name="download" />
                Скачать CSV
              </button>
            ) : null}
          </div>
        </div>
        {c.manual.length || byAction.length ? (
          <>
            <div class="dcols">
              <div>
                <h3 class="dsub">По видам</h3>
                <ul class="dlist">
                  {byAction.map(([k, n]) => (
                    <li key={k}>
                      <span>{actionLabel(k)}</span>
                      <b class="num">{n}</b>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 class="dsub">По сотрудникам</h3>
                <ul class="dlist">
                  {byStaff.map((s) => (
                    <li key={s.id ?? s.name}>
                      <span>
                        {s.id ? (
                          <a href={journal(`&actor=${encodeURIComponent(s.id)}`)} onClick={linkHandler}>
                            {s.name}
                          </a>
                        ) : (
                          s.name
                        )}
                        <span class="small muted"> · {s.actions.map(([k, n]) => `${actionLabel(k).toLowerCase()} ${n}`).join(', ')}</span>
                      </span>
                      <b class="num">{s.count}</b>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            {c.manual.length ? (
              <>
                <h3 class="dsub">С причинами</h3>
                <ul class="dmanual">
                  {c.manual.map((a) => (
                    <li key={a.id} class="dmanual__item">
                      <p class="dmanual__head">
                        <b>{actionLabel(a.action)}</b>
                        {rowPlace(a) ? ` · ${rowPlace(a)}` : ''}
                        {Number.isFinite(a.amount_kopecks) ? ` · ${money(a.amount_kopecks)}` : ''}
                      </p>
                      <p class="dmanual__reason">{a.reason ? `«${a.reason}»` : 'Без причины'}</p>
                      <p class="small muted">
                        {formatDate(a.at, tz)}, {formatTime(a.at, tz)} · {a.staff_name ?? 'Сотрудник'}
                        {a.club_name ? ` · ${a.club_name}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        ) : (
          <p class="muted">За этот период ручных действий не было.</p>
        )}
        {c.automatic ? <p class="small muted">Действий системы за период: {formatNumber(c.automatic)} — для сведения, они в журнале.</p> : null}
      </section>

      <section class={`dsec${busy ? ' is-busy' : ''}`} aria-labelledby="c-shifts">
        <div class="dsec__head">
          <h2 class="section-title" id="c-shifts">
            Расхождения касс
          </h2>
          {ctx.exportTable && c.shiftsTotal ? (
            <button type="button" class="btn btn--quiet btn--sm" onClick={() => ctx.exportTable('shifts')} disabled={ctx.exporting === 'shifts'} aria-label="Скачать CSV: смены">
              <Icon name="download" />
              CSV
            </button>
          ) : null}
        </div>
        {c.shifts.length ? (
          <ul class="dlist">
            {c.shifts.map((s) => (
              <li key={s.id ?? s.number}>
                <span>
                  {s.id ? (
                    <a href={`${clubPath}shift/${encodeURIComponent(s.id)}`} onClick={linkHandler}>
                      Смена {s.number ?? ''}
                      {s.closed_at || s.opened_at ? ` · ${formatDate(s.closed_at ?? s.opened_at, tz)}` : ''}
                    </a>
                  ) : (
                    `Смена ${s.number ?? ''}`
                  )}
                  {s.staff ? <span class="small muted"> · {s.staff}</span> : null}
                  {s.club ? <span class="small muted"> · {s.club}</span> : null}
                  {s.comment ? <span class="small muted"> · «{s.comment}»</span> : null}
                </span>
                <b class="num dneg">
                  {s.discrepancy < 0 ? 'недостача ' : 'излишек '}
                  {money(Math.abs(s.discrepancy))}
                </b>
              </li>
            ))}
          </ul>
        ) : (
          <p class="muted">{c.shiftsTotal ? 'Все смены за период сошлись до рубля.' : 'За этот период закрытых смен не было.'}</p>
        )}
        {c.shiftsTotal ? (
          <p class="small muted">
            Всего {formatNumber(c.shiftsTotal)} {plural(c.shiftsTotal, SHIFTS)}, с расхождением — {c.shifts.length}.
          </p>
        ) : null}
      </section>

      <section class={`dsec${busy ? ' is-busy' : ''}`} aria-labelledby="c-react">
        <h2 class="section-title" id="c-react">
          Реакция на тревоги
        </h2>
        {r.total ? (
          <>
            <p class="small">
              {r.total} {plural(r.total, ALARMS)}
              {Number.isFinite(r.avg) ? `, в среднем до «Принято» — ${formatMinutesShort(r.avg)}` : ''}. {r.problems ? <b>Просрочено: {r.problems}</b> : `Все приняты быстрее ${Math.round(r.limitMin)} минут.`}
              <br />
              <span class="muted">Просрочено — приняли позже {Math.round(r.limitMin)} минут или не приняли совсем.</span>
            </p>
            <label class="dswitch dswitch--inline">
              <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.currentTarget.checked)} />
              <span class="dswitch__track" aria-hidden="true">
                <span class="dswitch__knob" />
              </span>
              <span>Только проблемные</span>
            </label>
            <h3 class="dsub">По видам</h3>
            {pick(r.byType).length ? (
              <ul class="dlist">
                {pick(r.byType).map((g) => (
                  <li key={g.key} class={g.problem ? 'is-problem' : ''}>
                    <span>
                      {alarmView({ type: g.key }).title}
                      <span class="small muted"> · {statLine(g)}</span>
                    </span>
                    {g.problems ? (
                      <b class="dneg">
                        <Icon name="alert" /> просрочено {g.problems}
                      </b>
                    ) : (
                      <b class="dpos">
                        <Icon name="check" /> в срок
                      </b>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p class="muted">Проблемных нет.</p>
            )}
            {r.byStaff.length ? (
              <>
                <h3 class="dsub">Кто принимал</h3>
                {pick(r.byStaff).length ? (
                  <ul class="dlist">
                    {pick(r.byStaff).map((g) => (
                      <li key={g.key} class={g.problem ? 'is-problem' : ''}>
                        <span>
                          {g.key}
                          <span class="small muted"> · {statLine(g)}</span>
                        </span>
                        {g.problems ? (
                          <b class="dneg">
                            <Icon name="alert" /> просрочено {g.problems}
                          </b>
                        ) : (
                          <b class="dpos">
                            <Icon name="check" /> в срок
                          </b>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p class="muted">Проблемных нет.</p>
                )}
              </>
            ) : null}
            {alarmRows.length ? (
              <>
                <h3 class="dsub">{r.rows.every((a) => a.problem) ? 'Просроченные тревоги' : 'Тревоги'}</h3>
                <ul class="dalarms">
                  {alarmRows.map((a) => (
                    <li key={a.id} class={a.problem ? 'is-problem' : ''}>
                      <p>
                        <b>{alarmView(a).title}</b>
                        {rowPlace(a) ? ` · ${rowPlace(a)}` : ''}
                      </p>
                      <p class="small">
                        {formatDate(a.raised_at, tz)}, {formatTime(a.raised_at, tz)} ·{' '}
                        {a.minutes === null ? (
                          <b class="dneg">
                            <Icon name="alert" /> не принята
                          </b>
                        ) : a.problem ? (
                          <b class="dneg">
                            <Icon name="alert" /> принята через {formatMinutesShort(a.minutes)}
                          </b>
                        ) : (
                          <span>принята через {formatMinutesShort(a.minutes)}</span>
                        )}
                        {a.by ? ` · ${a.by}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        ) : (
          <p class="muted">За этот период тревог не было.</p>
        )}
      </section>
    </div>
  );
}
