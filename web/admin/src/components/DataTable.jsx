import { useMemo, useState } from 'preact/hooks';
import { Icon } from './Icon.jsx';
import { plural } from '@billiardum/shared/format';
import '../styles/tables.css';

const ROWS = ['строку', 'строки', 'строк'];

/**
 * Таблица программы клуба (M5.2): сортировка по столбцам (aria-sort), раскрытие строки, «Показать ещё».
 * На телефоне строки — карточки (стили .rtable в m2.css: подпись столбца из data-label), без прокрутки вбок.
 * При печати — обычная таблица, заголовок повторяется на каждой странице (styles/print.css).
 *
 * columns: [{ key, label, num?, head?, render?(row), sortKey? }]. sortKey — ключ сортировки (сервера или клиента).
 * sort: { key, desc } и onSort(key) — сортировка снаружи (сервер); без onSort и с sortValue — на клиенте.
 */
export function DataTable({ columns, rows, rowKey, caption, captionVisible = false, sort, onSort, expand, expandLabel = 'Состав', limit = 0, foot, empty = 'Нет записей.', rowClass, rowLabel, id }) {
  const [open, setOpen] = useState(() => new Set());
  const [shown, setShown] = useState(limit);
  const [localSort, setLocalSort] = useState(null);
  const activeSort = onSort ? sort : localSort;
  const sorted = useMemo(() => {
    if (onSort || !localSort) return rows;
    const col = columns.find((c) => c.key === localSort.key);
    if (!col?.sortValue) return rows;
    const list = [...rows].sort((a, b) => {
      const x = col.sortValue(a);
      const y = col.sortValue(b);
      const c = typeof x === 'string' ? x.localeCompare(y, 'ru') : (x ?? -Infinity) - (y ?? -Infinity);
      return localSort.desc ? -c : c;
    });
    return list;
  }, [rows, localSort, onSort]);
  const visible = limit && shown < sorted.length ? sorted.slice(0, shown) : sorted;
  const toggleSort = (key) => {
    if (onSort) onSort(key);
    else setLocalSort((s) => (s?.key === key ? { key, desc: !s.desc } : { key, desc: true }));
  };
  const toggle = (k) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const sortable = columns.filter((c) => c.sortKey || c.sortValue).map((c) => ({ k: c.sortKey ?? c.key, label: c.label, num: c.num }));
  if (!rows.length) return <p class="muted dtable-empty">{empty}</p>;
  return (
    <div class="dtable" id={id}>
      {sortable.length ? (
        <label class="dtable__sortsel">
          <span class="dfield__label">Сортировка</span>
          <select
            class="field__input"
            value={activeSort ? `${activeSort.key}:${activeSort.desc ? 'd' : 'a'}` : ''}
            onChange={(e) => {
              const [key, dir] = e.currentTarget.value.split(':');
              if (!key) return;
              if (onSort) onSort(key, dir === 'd');
              else setLocalSort({ key, desc: dir === 'd' });
            }}
          >
            {!activeSort ? <option value="">Как есть</option> : null}
            {sortable.flatMap((c) => [
              <option key={`${c.k}:d`} value={`${c.k}:d`}>
                {c.label}: {c.num ? 'больше сначала' : 'с конца'}
              </option>,
              <option key={`${c.k}:a`} value={`${c.k}:a`}>
                {c.label}: {c.num ? 'меньше сначала' : 'с начала'}
              </option>,
            ])}
          </select>
        </label>
      ) : null}
      <table class="rtable">
        <caption class={captionVisible ? '' : 'visually-hidden'}>{caption}</caption>
        <thead>
          <tr>
            {expand ? (
              <th scope="col" class="dtable__x">
                <span class="visually-hidden">{expandLabel}</span>
              </th>
            ) : null}
            {columns.map((c) => {
              const can = Boolean(c.sortKey || c.sortValue);
              const on = activeSort?.key === (c.sortKey ?? c.key);
              return (
                <th key={c.key} scope="col" class={c.num ? 'num' : ''} aria-sort={on ? (activeSort.desc ? 'descending' : 'ascending') : undefined}>
                  {can ? (
                    <>
                      <button type="button" class="dtable__sort" onClick={() => toggleSort(c.sortKey ?? c.key)}>
                        {c.label}
                        <Icon name={on ? (activeSort.desc ? 'down' : 'up') : 'filter'} class={on ? '' : 'dtable__sorticon'} />
                      </button>
                      {/* Печать: кнопки в повторённой шапке таблицы Chrome не рисует — там простой текст */}
                      <span class="dtable__plain" aria-hidden="true">
                        {c.label}
                      </span>
                    </>
                  ) : (
                    c.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => {
            const k = rowKey(r);
            const isOpen = open.has(k);
            const body = expand && isOpen ? expand(r) : null;
            return [
              <tr key={k} class={rowClass?.(r) ?? ''}>
                {expand ? (
                  <td class="dtable__x" data-label="">
                    <button type="button" class="icon-btn dtable__toggle" aria-expanded={isOpen ? 'true' : 'false'} aria-controls={`dt-${k}`} aria-label={rowLabel ? `${expandLabel}: ${rowLabel(r)}` : expandLabel} onClick={() => toggle(k)}>
                      <Icon name={isOpen ? 'minus' : 'plus'} />
                    </button>
                  </td>
                ) : null}
                {columns.map((c) => {
                  const v = c.render ? c.render(r) : r[c.key];
                  return c.head ? (
                    <th key={c.key} scope="row" class={c.num ? 'num' : ''}>
                      {v}
                    </th>
                  ) : (
                    <td key={c.key} class={c.num ? 'num' : ''} data-label={c.label}>
                      {v}
                    </td>
                  );
                })}
              </tr>,
              expand && isOpen ? (
                <tr key={`${k}-x`} class="dtable__more" id={`dt-${k}`}>
                  <td colSpan={columns.length + 1} data-label="">
                    {body}
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
        {foot ? <tfoot>{foot}</tfoot> : null}
      </table>
      {limit && shown < sorted.length ? (
        <button type="button" class="btn btn--quiet btn--sm dtable__moreBtn" onClick={() => setShown(sorted.length)}>
          Показать все {sorted.length} {plural(sorted.length, ROWS)}
        </button>
      ) : null}
    </div>
  );
}
