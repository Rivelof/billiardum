import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { formatDate, formatTime } from '@billiardum/shared/format';
import { Icon } from '../../components/Icon.jsx';
import { useStore } from '../../lib/store.js';
import { auth, can } from '../../lib/auth.js';
import { periodError, periodWords, monthToDate, isYmd } from '../../lib/period.js';
import { fileNameFrom, saveFile } from '../../lib/export.js';

/** Фильтры отчёта в адресе: ?from=&to=&q=&all=1 (свои ключи экрана — через extra). */
export function useReportQuery(today, extraKeys = []) {
  const read = () => {
    const q = new URLSearchParams(location.search);
    const def = monthToDate(today);
    let from = q.get('from');
    let to = q.get('to');
    if (!isYmd(from) || !isYmd(to) || periodError(from, to, today)) ({ from, to } = def);
    const extra = Object.fromEntries(extraKeys.map((k) => [k, q.get(k) ?? '']));
    return { from, to, q: q.get('q') ?? '', all: q.get('all') === '1', ...extra };
  };
  const [state, setState] = useState(read);
  const update = (patch) =>
    setState((prev) => {
      const next = { ...prev, ...patch };
      const q = new URLSearchParams();
      const def = monthToDate(today);
      if (next.from !== def.from || next.to !== def.to) {
        q.set('from', next.from);
        q.set('to', next.to);
      }
      if (next.q) q.set('q', next.q);
      if (next.all) q.set('all', '1');
      for (const k of extraKeys) if (next[k]) q.set(k, next[k]);
      const s = q.toString();
      history.replaceState(null, '', `${location.pathname}${s ? `?${s}` : ''}`);
      return next;
    });
  return [state, update];
}

/**
 * Строка фильтров отчёта: период (по умолчанию текущий месяц), клуб (у владельца — «Все мои клубы»), поиск
 * и свои поля экрана (children).
 */
export function ReportFilters({ state, update, today, club, allowAll = false, search, children }) {
  const { clubs } = useStore(auth);
  const [from, setFrom] = useState(state.from);
  const [to, setTo] = useState(state.to);
  const [err, setErr] = useState(null);
  const [text, setText] = useState(state.q ?? '');
  const timer = useRef(null);
  // Период поменяли снаружи (адрес, «7 дней» по умолчанию у «Кто играл») — поля показывают его же
  useEffect(() => {
    setFrom(state.from);
    setTo(state.to);
  }, [state.from, state.to]);
  const owners = clubs.filter((c) => c.role === 'owner');
  const canAll = allowAll && can.owner(club.role) && owners.length > 1;
  const apply = (f, t) => {
    const msg = periodError(f, t, today);
    setErr(msg);
    if (!msg) update({ from: f, to: t });
  };
  const onSearch = (v) => {
    setText(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => update({ q: v.trim() }), 350);
  };
  return (
    <div class="rfilters no-print" role="search" aria-label="Фильтры отчёта">
      <label class="dfield">
        <span class="dfield__label">С</span>
        <input class="field__input" type="date" value={from} max={today} onChange={(e) => (setFrom(e.currentTarget.value), apply(e.currentTarget.value, to))} aria-invalid={err ? 'true' : undefined} aria-describedby={err ? 'rperiod-err' : undefined} />
      </label>
      <label class="dfield">
        <span class="dfield__label">По</span>
        <input class="field__input" type="date" value={to} max={today} onChange={(e) => (setTo(e.currentTarget.value), apply(from, e.currentTarget.value))} aria-invalid={err ? 'true' : undefined} aria-describedby={err ? 'rperiod-err' : undefined} />
      </label>
      {canAll ? (
        <label class="dfield">
          <span class="dfield__label">Клуб</span>
          <select class="field__input" value={state.all ? 'all' : 'one'} onChange={(e) => update({ all: e.currentTarget.value === 'all' })}>
            <option value="one">{club.name ?? 'Этот клуб'}</option>
            <option value="all">Все мои клубы</option>
          </select>
        </label>
      ) : null}
      {search ? (
        <label class="dfield rfilters__search">
          <span class="dfield__label">Поиск</span>
          <input class="field__input" type="search" value={text} placeholder={search} onInput={(e) => onSearch(e.currentTarget.value)} />
        </label>
      ) : null}
      {children}
      {err ? (
        <p class="field__error rfilters__err" id="rperiod-err" role="alert">
          {err}
        </p>
      ) : null}
    </div>
  );
}

/** Кнопки отчёта: «Экспорт в Excel» (CSV) и «Напечатать» с подсказкой про PDF. */
export function ReportTools({ onExport, exporting, onPrint, printing, children }) {
  return (
    <div class="rtools no-print">
      {children}
      {onExport ? (
        <button type="button" class="btn btn--quiet btn--sm" onClick={onExport} disabled={exporting}>
          <Icon name="download" />
          {exporting ? 'Готовим файл…' : 'Экспорт в Excel'}
        </button>
      ) : null}
      {onPrint ? (
        <button type="button" class="btn btn--quiet btn--sm" onClick={onPrint} disabled={printing} aria-describedby="print-hint">
          <Icon name="printer" />
          {printing ? 'Готовим к печати…' : 'Напечатать'}
        </button>
      ) : null}
      {onPrint ? (
        <p class="small muted rtools__hint" id="print-hint">
          Нужен PDF — выберите «Сохранить как PDF» в окне печати.
        </p>
      ) : null}
    </div>
  );
}

/** Шапка печатной страницы: клуб, отчёт, период, когда напечатано. На экране не видна. */
export function PrintHead({ club, title, from, to, today, timeZone, extra }) {
  const now = Date.now();
  return (
    <div class="print-head" aria-hidden="true">
      <p class="print-head__brand">Бильярдум · {club.name ?? 'Клуб'}</p>
      <p class="print-head__title">{title}</p>
      <p class="print-head__meta">
        {from && to ? `Период: ${periodWords(from, to, today)}. ` : ''}
        {extra ? `${extra}. ` : ''}
        Напечатано {formatDate(now, timeZone)} {new Date(now).getFullYear()}, {formatTime(now, timeZone)}
      </p>
    </div>
  );
}

/**
 * Список страницами (cursor): первая страница по фильтрам, «Показать ещё», «загрузить всё» для печати.
 * fetchPage(cursor) → { items, next_cursor, totals? }.
 */
export function usePaged(fetchPage, key) {
  const [items, setItems] = useState(null);
  const [totals, setTotals] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const my = ++seq.current;
    setBusy(true);
    setError(null);
    try {
      const res = await fetchPage(undefined);
      if (my !== seq.current) return;
      setItems(Array.isArray(res?.items) ? res.items : Array.isArray(res) ? res : []);
      setTotals(res?.totals ?? null);
      setCursor(res?.next_cursor ?? null);
    } catch (err) {
      if (my === seq.current) setError(err);
    } finally {
      if (my === seq.current) setBusy(false);
    }
  }, [key]);
  useEffect(() => {
    reload();
  }, [reload]);
  const more = async () => {
    if (!cursor) return [];
    const my = seq.current;
    setBusy(true);
    try {
      const res = await fetchPage(cursor);
      if (my !== seq.current) return [];
      const add = Array.isArray(res?.items) ? res.items : [];
      setItems((prev) => [...(prev ?? []), ...add]);
      setCursor(res?.next_cursor ?? null);
      return add;
    } catch (err) {
      setError(err);
      return [];
    } finally {
      setBusy(false);
    }
  };
  /** Все страницы (печать, CSV на клиенте); не больше 60 страниц, чтобы не повесить вкладку. */
  const all = async () => {
    let list = items ?? [];
    let c = cursor;
    let pages = 0;
    setBusy(true);
    try {
      while (c && pages < 60) {
        const res = await fetchPage(c);
        list = [...list, ...(Array.isArray(res?.items) ? res.items : [])];
        c = res?.next_cursor ?? null;
        pages += 1;
      }
      setItems(list);
      setCursor(c);
      return list;
    } catch (err) {
      setError(err);
      return list;
    } finally {
      setBusy(false);
    }
  };
  return { items, totals, cursor, busy, error, reload, more, all };
}

/** Печать после того, как браузер нарисовал все строки. */
export function printNow() {
  requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
}

/** Скачать CSV с сервера (Response) под его именем. */
export async function downloadResponse(res, fallback) {
  const blob = await res.blob();
  saveFile(fileNameFrom(res, fallback), blob);
}

/** «Показать ещё» под списком страницами. */
export function MoreButton({ paged }) {
  if (!paged.cursor) return null;
  return (
    <button type="button" class="btn btn--quiet btn--sm no-print rmore" onClick={paged.more} disabled={paged.busy}>
      {paged.busy ? 'Загружаем…' : 'Показать ещё'}
    </button>
  );
}
