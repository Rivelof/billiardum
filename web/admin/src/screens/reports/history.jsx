import { useState } from 'preact/hooks';
import { formatMoney, formatDate, formatTime } from '@billiardum/shared/format';
import { DataTable } from '../../components/DataTable.jsx';
import { ErrorNote } from '../../components/ErrorNote.jsx';
import { Icon } from '../../components/Icon.jsx';
import { api } from '../../lib/api.js';
import { linkHandler } from '../../lib/router.js';
import { csvName } from '../../lib/export.js';
import { countWords, guestLabel, ORDER_SOURCE, ORDER_STATUS, PAY_LABEL, qtyWords, WRITEOFF_SOURCE } from '../../lib/reports.js';
import { periodWords } from '../../lib/period.js';
import { downloadResponse, MoreButton, PrintHead, printNow, ReportFilters, ReportTools, usePaged, useReportQuery, When } from './common.jsx';

const money = (v) => (Number.isFinite(v) ? formatMoney(v) : '—');

/**
 * Столбцы и раскрытие каждой истории (№173, формы server/history). Сортировка — на сервере:
 * заказы created_at | number | amount | status | canceled_at; ревизии created_at | items | diff_kopecks | diff_qty;
 * списания created_at | product | qty | cost | source; приходы created_at | product | qty | cost | unit_cost.
 */
function config(kind, tz) {
  const when = (iso) => (iso ? `${formatDate(iso, tz)}, ${formatTime(iso, tz)}` : '—');
  const stamp = (iso) => <When iso={iso} timeZone={tz} />;
  const date = { key: 'created_at', label: 'Дата', sortKey: 'created_at', cls: 'rnowrap', render: (r) => stamp(r.created_at) };
  if (kind === 'orders') {
    return {
      id: (r) => r.order_id,
      search: 'Номер заказа или товар',
      empty: 'За этот период заказов не было.',
      statusLabel: 'Статус',
      statuses: ORDER_STATUS,
      columns: [
        { key: 'number', label: 'Номер', head: true, sortKey: 'number', cls: 'rnowrap', render: (r) => <span class="mono">№{r.number}</span> },
        date,
        { key: 'canceled_at', label: 'Отмена', sortKey: 'canceled_at', cls: 'rnowrap', render: (r) => stamp(r.canceled_at) },
        { key: 'guest', label: 'Гость', render: (r) => guestLabel(r.guest, { pos: r.source === 'pos' }) },
        { key: 'table', label: 'Стол', cls: 'rnowrap', render: (r) => (r.resource_number ? `Стол ${r.resource_number}` : ORDER_SOURCE[r.source] ?? '—') },
        { key: 'amount', label: 'Сумма', num: true, sortKey: 'amount', render: (r) => money(r.amount_kopecks) },
        { key: 'method', label: 'Способ', render: (r) => PAY_LABEL[r.method] ?? r.method ?? '—' },
        { key: 'status', label: 'Статус', sortKey: 'status', cls: 'rnowrap', render: (r) => <span class={`rstatus rstatus--${r.status}`}>{ORDER_STATUS[r.status] ?? r.status}</span> },
      ],
      expand: (r) => (
        <div class="rexp">
          <ul class="rexp__lines">
            {(r.lines ?? []).map((l, i) => (
              <li key={i}>
                <span>
                  {l.name} × {qtyWords(l.qty)}
                  {l.modifiers?.length ? <span class="small muted"> · {l.modifiers.join(', ')}</span> : null}
                </span>
                <b class="num">{money(l.amount_kopecks)}</b>
              </li>
            ))}
          </ul>
          {r.created_by_name ? <p class="small muted">Кассир: {r.created_by_name}</p> : null}
          {r.cancel_reason ? (
            <p class="small">
              Отменил {r.canceled_by_name ?? 'сотрудник'}: «{r.cancel_reason}»
            </p>
          ) : null}
        </div>
      ),
      rowLabel: (r) => `заказ №${r.number}`,
      totals: (t) => (t ? `${countWords.records(t.count)} · ${money(t.amount_kopecks)} без отменённых${t.canceled ? ` · отменено ${t.canceled}` : ''}` : null),
    };
  }
  if (kind === 'audits') {
    return {
      id: (r) => r.audit_id,
      search: 'Товар или комментарий',
      empty: 'За этот период ревизий не было.',
      columns: [
        { ...date, head: true },
        { key: 'staff', label: 'Провёл', render: (r) => r.created_by_name ?? '—' },
        { key: 'items', label: 'Позиций', num: true, sortKey: 'items', render: (r) => `${r.items}${r.mismatches ? ` (расхождений ${r.mismatches})` : ''}` },
        { key: 'diff_qty', label: 'Расхождение, шт', num: true, sortKey: 'diff_qty', render: (r) => qtyWords(r.diff_qty) },
        { key: 'diff_kopecks', label: 'Расхождение, ₽', num: true, sortKey: 'diff_kopecks', render: (r) => <span class={r.diff_kopecks < 0 ? 'dneg' : ''}>{money(r.diff_kopecks)}</span> },
      ],
      expand: (r) => (
        <div class="rexp">
          {r.note ? <p class="small">Комментарий: «{r.note}»</p> : null}
          <table class="rtable rtable--bars rexp__table">
            <caption class="visually-hidden">Позиции ревизии</caption>
            <thead>
              <tr>
                <th scope="col">Товар</th>
                <th scope="col" class="num">
                  По системе
                </th>
                <th scope="col" class="num">
                  Факт
                </th>
                <th scope="col" class="num">
                  Расхождение
                </th>
              </tr>
            </thead>
            <tbody>
              {(r.lines ?? []).map((l) => (
                <tr key={l.product_id ?? l.name} class={l.diff_qty ? 'is-problem' : ''}>
                  <th scope="row">{l.name}</th>
                  <td class="num">{qtyWords(l.expected_qty)}</td>
                  <td class="num">{qtyWords(l.actual_qty)}</td>
                  <td class="num">{l.diff_qty ? `${qtyWords(l.diff_qty)} · ${money(l.diff_kopecks)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ),
      rowLabel: (r) => `ревизия ${when(r.created_at)}`,
      expandLabel: 'Позиции',
      totals: (t) => (t ? `${countWords.records(t.count)} · расхождение ${money(t.diff_kopecks)} по себестоимости${t.shortage_kopecks ? ` (недостача ${money(Math.abs(t.shortage_kopecks))}${t.surplus_kopecks ? `, излишек ${money(t.surplus_kopecks)}` : ''})` : ''}` : null),
    };
  }
  if (kind === 'writeoffs') {
    return {
      id: (r) => r.movement_id,
      search: 'Товар или причина',
      empty: 'За этот период списаний не было.',
      statusLabel: 'Источник',
      statuses: WRITEOFF_SOURCE,
      columns: [
        { ...date, head: true },
        { key: 'staff', label: 'Кто списал', render: (r) => r.created_by_name ?? '—' },
        { key: 'source', label: 'Источник', sortKey: 'source', render: (r) => WRITEOFF_SOURCE[r.source] ?? r.source },
        { key: 'product', label: 'Товар', sortKey: 'product', render: (r) => r.product },
        { key: 'qty', label: 'Кол-во', num: true, sortKey: 'qty', render: (r) => `${qtyWords(r.qty)} ${r.unit ?? ''}` },
        { key: 'reason', label: 'Причина', render: (r) => r.reason ?? '—' },
        { key: 'cost', label: 'Сумма', num: true, sortKey: 'cost', render: (r) => money(r.cost_kopecks) },
      ],
      totals: (t) => (t ? `${countWords.records(t.count)} · ${money(t.cost_kopecks)} по себестоимости` : null),
    };
  }
  return {
    id: (r) => r.movement_id,
    search: 'Товар или комментарий',
    empty: 'За этот период приходов не было.',
    columns: [
      { ...date, head: true },
      { key: 'staff', label: 'Кто', render: (r) => r.created_by_name ?? '—' },
      { key: 'supplier', label: 'Поставщик', render: (r) => r.supplier ?? (r.note ? `не указан · ${r.note}` : 'не указан') },
      { key: 'product', label: 'Товар', sortKey: 'product', render: (r) => r.product },
      { key: 'qty', label: 'Кол-во', num: true, sortKey: 'qty', render: (r) => `${qtyWords(r.qty)} ${r.unit ?? ''}` },
      { key: 'unit_cost', label: 'Цена закупки', num: true, sortKey: 'unit_cost', render: (r) => money(r.unit_cost_kopecks) },
      { key: 'cost', label: 'Сумма', num: true, sortKey: 'cost', render: (r) => money(r.cost_kopecks) },
    ],
    totals: (t) => (t ? `${countWords.records(t.count)} · ${money(t.cost_kopecks)}` : null),
  };
}


/** История заказов, ревизий, списаний или приходов (№173). */
export function HistoryScreen({ kind, ctx, today, base, title }) {
  const { club, timeZone } = ctx;
  const [state, update] = useReportQuery(today, ['status', 'sort']);
  const [exporting, setExporting] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState(null);
  const cfg = config(kind, timeZone);
  const scope = state.all ? 'all' : club.club_id;
  const sort = state.sort || '-created_at';
  const query = { from: state.from, to: state.to, ...(state.q ? { q: state.q } : {}), ...(cfg.statuses && state.status ? { status: state.status } : {}), sort };
  const key = JSON.stringify([kind, scope, query]);
  const paged = usePaged((cursor) => api.history(scope, kind, { ...query, ...(cursor ? { cursor } : {}) }), key);
  const onSort = (k, desc) => {
    const cur = sort.replace(/^-/, '');
    const isDesc = desc ?? !(cur === k && sort.startsWith('-'));
    update({ sort: `${isDesc ? '-' : ''}${k}` });
  };
  const exportCsv = async () => {
    setExporting(true);
    setError(null);
    try {
      await downloadResponse(await api.historyExport(scope, kind, query), csvName('history', kind, state.from, state.to));
    } catch (err) {
      setError(err);
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
  const totals = cfg.totals(paged.totals);
  return (
    <section class="rscreen" aria-labelledby="r-title">
      <PrintHead club={club} title={title} from={state.from} to={state.to} today={today} timeZone={timeZone} extra={state.q ? `Поиск: ${state.q}` : null} />
      <div class="rhead">
        <h2 class="section-title" id="r-title">
          {title}
        </h2>
        <ReportTools onExport={exportCsv} exporting={exporting} onPrint={print} printing={printing}>
          {kind === 'audits' ? (
            <a class="btn btn--quiet btn--sm" href={`${base}/audit-sheet`} onClick={linkHandler}>
              <Icon name="list" />
              Распечатать ведомость
            </a>
          ) : null}
        </ReportTools>
      </div>
      <ReportFilters state={state} update={update} today={today} club={club} allowAll search={cfg.search}>
        {cfg.statuses ? (
          <label class="dfield">
            <span class="dfield__label">{cfg.statusLabel}</span>
            <select class="field__input" value={state.status} onChange={(e) => update({ status: e.currentTarget.value })}>
              <option value="">Все</option>
              {Object.entries(cfg.statuses).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </ReportFilters>
      <p class="rsummary" role="status">
        {periodWords(state.from, state.to, today)}
        {totals ? ` · ${totals}` : ''}
      </p>
      <ErrorNote error={paged.error || error}>
        {paged.error ? (
          <button type="button" class="btn btn--secondary btn--sm" onClick={paged.reload}>
            Повторить
          </button>
        ) : null}
      </ErrorNote>
      {paged.items ? (
        <div class={paged.busy ? 'is-busy' : ''}>
          <DataTable
            caption={`${title}, ${periodWords(state.from, state.to, today)}`}
            columns={cfg.columns}
            rows={paged.items}
            rowKey={cfg.id}
            sort={{ key: sort.replace(/^-/, ''), desc: sort.startsWith('-') }}
            onSort={onSort}
            expand={cfg.expand}
            expandLabel={cfg.expandLabel ?? 'Состав'}
            rowLabel={cfg.rowLabel}
            empty={state.q ? `Ничего не нашли по «${state.q}». Проверьте написание или очистите поиск.` : cfg.empty}
            rowClass={(r) => (r.status === 'canceled' ? 'is-muted' : '')}
          />
          <MoreButton paged={paged} />
        </div>
      ) : !paged.error ? (
        <p class="muted loading" role="status">
          Загружаем…
        </p>
      ) : null}
    </section>
  );
}
