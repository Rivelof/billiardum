import { useMemo, useState } from 'preact/hooks';
import { formatMoney, formatDate, formatTime } from '@billiardum/shared/format';
import { DataTable } from '../../components/DataTable.jsx';
import { ErrorNote } from '../../components/ErrorNote.jsx';
import { api } from '../../lib/api.js';
import { BASE } from '../../lib/env.js';
import { linkHandler } from '../../lib/router.js';
import { csvName } from '../../lib/export.js';
import { countWords, shiftStaff, shiftState, SHIFT_STATUS_FILTER } from '../../lib/reports.js';
import { periodWords } from '../../lib/period.js';
import { downloadResponse, MoreButton, PrintHead, printNow, ReportFilters, ReportTools, usePaged, useReportQuery } from './common.jsx';

const money = (v) => (Number.isSafeInteger(v) ? formatMoney(v) : '—');

/** Список смен (№176): период, сотрудник, состояние; строка открывает отчёт смены; CSV и печать. */
export function ShiftsScreen({ ctx, today, title }) {
  const { club, timeZone } = ctx;
  const [state, update] = useReportQuery(today, ['staff', 'status']);
  const [printing, setPrinting] = useState(false);
  const [staffSeen, setStaffSeen] = useState([]);
  const query = { from: state.from, to: state.to, ...(state.staff ? { staff: state.staff } : {}), ...(state.status ? { status: state.status } : {}) };
  const key = JSON.stringify([club.club_id, query]);
  const paged = usePaged(async (cursor) => {
    const res = await api.shifts(club.club_id, { ...query, ...(cursor ? { cursor } : {}) });
    const items = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
    if (!state.staff) setStaffSeen((prev) => mergeStaff(prev, shiftStaff(items)));
    return { items, next_cursor: res?.next_cursor ?? null };
  }, key);
  const when = (iso) => (iso ? `${formatDate(iso, timeZone)}, ${formatTime(iso, timeZone)}` : '—');
  const href = (s) => `${BASE}c/${encodeURIComponent(club.club_id)}/shift/${encodeURIComponent(s.id)}`;
  const columns = useMemo(
    () => [
      {
        key: 'number',
        label: 'Смена',
        head: true,
        sortValue: (s) => Date.parse(s.opened_at),
        render: (s) => (
          <a class="rlink" href={href(s)} onClick={linkHandler}>
            {s.number ? `№${s.number}` : 'Смена'} · {formatDate(s.opened_at, timeZone)}
          </a>
        ),
      },
      { key: 'opened', label: 'Открыта', render: (s) => `${formatTime(s.opened_at, timeZone)}, ${s.opened_by_name ?? 'сотрудник'}` },
      { key: 'closed', label: 'Закрыта', render: (s) => (s.closed_at ? `${when(s.closed_at)}${s.closed_by_name && s.closed_by_name !== s.opened_by_name ? `, ${s.closed_by_name}` : ''}` : 'идёт') },
      { key: 'revenue', label: 'Выручка', num: true, sortValue: (s) => s.revenue_total_kopecks ?? -1, render: (s) => money(s.revenue_total_kopecks) },
      {
        key: 'state',
        label: 'Состояние',
        sortValue: (s) => Math.abs(s.discrepancy_kopecks ?? 0),
        render: (s) => {
          const st = shiftState(s);
          return <span class={`rstatus rstatus--${st.key}`}>{st.word}</span>;
        },
      },
    ],
    [timeZone, club.club_id],
  );
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);
  const exportCsv = async () => {
    setExporting(true);
    setExportError(null);
    try {
      await downloadResponse(await api.shiftsExport(club.club_id, query), csvName('shifts', state.from, state.to));
    } catch (err) {
      setExportError(err);
    } finally {
      setExporting(false);
    }
  };
  const print = async () => {
    setPrinting(true);
    await paged.all();
    setPrinting(false);
    printNow();
  };
  const items = paged.items ?? [];
  const withDiff = items.filter((s) => shiftState(s).key === 'short' || shiftState(s).key === 'over').length;
  const staffName = staffSeen.find((s) => s.id === state.staff)?.name;
  return (
    <section class="rscreen" aria-labelledby="r-title">
      <PrintHead club={club} title="Смены" from={state.from} to={state.to} today={today} timeZone={timeZone} extra={[staffName ? `Сотрудник: ${staffName}` : null, state.status ? `Состояние: ${SHIFT_STATUS_FILTER.find((x) => x.value === state.status)?.label}` : null].filter(Boolean).join('. ') || null} />
      <div class="rhead">
        <h2 class="section-title" id="r-title">
          {title}
        </h2>
        <ReportTools onExport={exportCsv} exporting={exporting} onPrint={print} printing={printing} />
      </div>
      <ReportFilters state={state} update={update} today={today} club={club}>
        <label class="dfield">
          <span class="dfield__label">Сотрудник</span>
          <select class="field__input" value={state.staff} onChange={(e) => update({ staff: e.currentTarget.value })}>
            <option value="">Все</option>
            {staffSeen.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label class="dfield">
          <span class="dfield__label">Состояние</span>
          <select class="field__input" value={state.status} onChange={(e) => update({ status: e.currentTarget.value })}>
            {SHIFT_STATUS_FILTER.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </ReportFilters>
      <p class="rsummary" role="status">
        {periodWords(state.from, state.to, today)}
        {paged.items ? ` · ${countWords.records(items.length)}${paged.cursor ? ' (показаны первые)' : ''}${withDiff ? ` · с расхождением ${withDiff}` : ''}` : ''}
      </p>
      <ErrorNote error={exportError} />
      <ErrorNote error={paged.error}>
        <button type="button" class="btn btn--secondary btn--sm" onClick={paged.reload}>
          Повторить
        </button>
      </ErrorNote>
      {paged.items ? (
        <div class={paged.busy ? 'is-busy' : ''}>
          <DataTable caption={`Смены, ${periodWords(state.from, state.to, today)}`} columns={columns} rows={items} rowKey={(s) => s.id} empty="За этот период смен не было." rowClass={(s) => (['short', 'over'].includes(shiftState(s).key) ? 'is-problem' : '')} />
          <MoreButton paged={paged} />
        </div>
      ) : !paged.error ? (
        <p class="muted loading" role="status">
          Загружаем смены…
        </p>
      ) : null}
    </section>
  );
}

function mergeStaff(prev, add) {
  const map = new Map(prev.map((s) => [s.id, s]));
  for (const s of add) map.set(s.id, s);
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}
