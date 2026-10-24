import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { formatMoney, formatTime } from '@billiardum/shared/format';
import { DataTable } from '../../components/DataTable.jsx';
import { Dialog } from '../../components/Dialog.jsx';
import { ErrorNote } from '../../components/ErrorNote.jsx';
import { Icon } from '../../components/Icon.jsx';
import { api, newIdempotencyKey } from '../../lib/api.js';
import { can } from '../../lib/auth.js';
import { parseRubles } from '../../lib/cash.js';
import { csvName } from '../../lib/export.js';
import { cashbookFormErrors, cashbookSummary, canStorno } from '../../lib/reports.js';
import { dayLong, periodWords } from '../../lib/period.js';
import { Shares } from '../dashboard/charts.jsx';
import { downloadResponse, PrintHead, printNow, ReportFilters, ReportTools, useReportQuery } from './common.jsx';

const money = (v) => (Number.isSafeInteger(v) ? formatMoney(v) : '—');
const KIND_WORD = { income: 'Доход', expense: 'Расход', collection: 'Инкассация' };

/**
 * Касса управляющего (№177, формы server/dashboard): остаток на начало и конец, доходы (инкассации из смен — сами,
 * прочие — вручную), расходы по статьям. Записи не правятся и не удаляются — только сторно новой записью с причиной.
 */
export function CashbookScreen({ ctx, today, title }) {
  const { club, role, timeZone } = ctx;
  const clubId = club.club_id;
  const [state, update] = useReportQuery(today);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(null); // 'income' | 'expense'
  const [storno, setStorno] = useState(null);
  const [cats, setCats] = useState(false);
  const [done, setDone] = useState(null);
  const [exporting, setExporting] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      setData(await api.cashbook(clubId, { from: state.from, to: state.to }));
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }, [clubId, state.from, state.to]);
  useEffect(() => {
    load();
  }, [load]);
  const exportCsv = async () => {
    setExporting(true);
    setError(null);
    try {
      await downloadResponse(await api.cashbookExport(clubId, { from: state.from, to: state.to }), csvName('cashbook', state.from, state.to));
    } catch (err) {
      setError(err);
    } finally {
      setExporting(false);
    }
  };
  const sum = data ? cashbookSummary(data) : null;
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const categories = Array.isArray(data?.categories) ? data.categories : [];
  const columns = [
    { key: 'date', label: 'Дата', head: true, sortValue: (r) => r.date, render: (r) => dayLong(r.date) },
    {
      key: 'what',
      label: 'Статья',
      sortValue: (r) => r.category ?? '',
      render: (r) => (
        <span>
          <span class={`rkind rkind--${r.kind}`}>{KIND_WORD[r.kind] ?? r.kind}</span> {r.category ?? 'Без статьи'}
          {r.kind === 'collection' ? <span class="small muted"> · из смены, автоматически</span> : null}
        </span>
      ),
    },
    {
      key: 'amount',
      label: 'Сумма',
      num: true,
      sortValue: (r) => r.signed_kopecks ?? r.amount_kopecks,
      render: (r) => (
        <span class={r.amount_kopecks < 0 ? 'dneg' : ''}>
          {r.kind === 'expense' && r.amount_kopecks > 0 ? '−' : r.amount_kopecks > 0 ? '+' : ''}
          {money(Math.abs(r.amount_kopecks))}
          {r.reverses_id ? ' (сторно)' : ''}
        </span>
      ),
    },
    { key: 'comment', label: 'Комментарий', render: (r) => (r.reverses_id ? `Причина сторно: «${r.reason ?? ''}»` : (r.comment ?? '—')) },
    { key: 'who', label: 'Кто', render: (r) => `${r.created_by_name ?? '—'}${r.created_at ? `, ${formatTime(r.created_at, timeZone)}` : ''}` },
    {
      key: 'act',
      label: 'Действие',
      render: (r) =>
        r.reversed_by ? (
          <span class="small muted">Сторнирована</span>
        ) : r.reverses_id ? (
          <span class="small muted">Сторно записи</span>
        ) : canStorno(r) ? (
          <button type="button" class="btn btn--quiet btn--sm no-print" onClick={() => setStorno(r)} aria-label={`Сторнировать: ${r.category ?? ''} ${money(r.amount_kopecks)}, ${dayLong(r.date)}`}>
            Сторнировать
          </button>
        ) : (
          <span class="small muted">—</span>
        ),
    },
  ];
  return (
    <section class="rscreen" aria-labelledby="r-title">
      <PrintHead club={club} title={title} from={state.from} to={state.to} today={today} timeZone={timeZone} />
      <div class="rhead">
        <h2 class="section-title" id="r-title">
          {title}
        </h2>
        <ReportTools onExport={exportCsv} exporting={exporting} onPrint={printNow}>
          <button type="button" class="btn btn--primary btn--sm" onClick={() => setAdding('expense')}>
            <Icon name="plus" />
            Добавить расход
          </button>
          <button type="button" class="btn btn--secondary btn--sm" onClick={() => setAdding('income')}>
            <Icon name="plus" />
            Добавить доход
          </button>
          {can.cashbookCategories(role) ? (
            <button type="button" class="btn btn--quiet btn--sm" onClick={() => setCats(true)}>
              <Icon name="settings" />
              Статьи
            </button>
          ) : null}
        </ReportTools>
      </div>
      <ReportFilters state={state} update={update} today={today} club={club} />
      <p class="small muted no-print">Управленческий учёт для владельца и управляющего, не бухгалтерия. Записи не правятся: ошибочную — сторнируйте с причиной и внесите заново.</p>
      {done ? (
        <p class="note note--free" role="status">
          <Icon name="check" />
          <span class="note__title">{done}</span>
        </p>
      ) : null}
      <ErrorNote error={error}>
        <button type="button" class="btn btn--secondary btn--sm" onClick={load}>
          Повторить
        </button>
      </ErrorNote>
      {sum ? (
        <div class={`rcash${busy ? ' is-busy' : ''}`}>
          <dl class="receipt rcash__sum">
            <div class="receipt__row">
              <dt>На начало периода</dt>
              <dd class="receipt__sum">{money(sum.opening)}</dd>
            </div>
            <div class="receipt__row">
              <dt>Инкассации из смен</dt>
              <dd class="receipt__sum">+{money(sum.collections)}</dd>
            </div>
            <div class="receipt__row">
              <dt>Прочие доходы</dt>
              <dd class="receipt__sum">+{money(sum.otherIncome)}</dd>
            </div>
            <div class="receipt__row">
              <dt>Расходы</dt>
              <dd class="receipt__sum">−{money(sum.expense)}</dd>
            </div>
            <div class="receipt__row receipt__row--total">
              <dt>На конец периода</dt>
              <dd class="receipt__sum">{money(Number.isSafeInteger(data.closing_kopecks) ? data.closing_kopecks : sum.closing)}</dd>
            </div>
          </dl>
          {sum.mismatch ? (
            <p class="note note--error" role="alert">
              <Icon name="alert" />
              <span class="note__title">Остаток не сходится: по записям выходит {money(sum.closing)}. Обновите страницу; если повторится — сообщите в поддержку.</span>
            </p>
          ) : null}
          <section class="dsec" aria-labelledby="cb-cats">
            <h3 class="section-title" id="cb-cats">
              Расходы по статьям
            </h3>
            {sum.byCategory.length ? <Shares rows={sum.byCategory.map((c) => ({ key: c.name, label: c.name, value: c.amount }))} total={sum.byCategory.reduce((s, c) => s + c.amount, 0)} format={money} /> : <p class="muted">За период расходов нет.</p>}
          </section>
        </div>
      ) : !error ? (
        <p class="muted loading" role="status">
          Загружаем кассу…
        </p>
      ) : null}
      {data ? (
        <DataTable caption={`Записи кассы, ${periodWords(state.from, state.to, today)}`} columns={columns} rows={entries} rowKey={(r) => r.entry_id} empty="За этот период записей нет. Инкассации из смен появятся сами, расходы внесите кнопкой «Добавить расход»." rowClass={(r) => (r.reversed_by || r.reverses_id ? 'is-muted' : '')} />
      ) : null}
      <AddDialog kind={adding} categories={categories} today={today} clubId={clubId} onClose={() => setAdding(null)} onDone={(it) => (setAdding(null), setDone(`Записано: ${it.category}, ${money(it.amount_kopecks)}.`), load())} />
      <StornoDialog item={storno} clubId={clubId} onClose={() => setStorno(null)} onDone={() => (setStorno(null), setDone('Запись сторнирована. Если сумма была неверной — внесите её заново.'), load())} />
      {can.cashbookCategories(role) ? <CategoriesDialog open={cats} clubId={clubId} categories={categories} onClose={() => setCats(false)} onChanged={load} /> : null}
    </section>
  );
}

function AddDialog({ kind, categories, today, clubId, onClose, onDone }) {
  const [form, setForm] = useState({ kind: 'expense', amount: '', categoryId: '', date: today, comment: '' });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(null);
  useEffect(() => {
    if (!kind) return;
    setForm({ kind, amount: '', categoryId: '', date: today, comment: '' });
    setErrors({});
    setError(null);
    key.current = newIdempotencyKey();
  }, [kind]);
  const list = categories.filter((c) => c.active !== false && c.kind === form.kind).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const submit = async (e) => {
    e.preventDefault();
    const amount = parseRubles(form.amount);
    const errs = cashbookFormErrors({ kind: form.kind, amount, categoryId: form.categoryId, date: form.date }, categories, today);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    try {
      const it = await api.addCashbook(clubId, { kind: form.kind, amount_kopecks: amount, category_id: form.categoryId, date: form.date, ...(form.comment.trim() ? { comment: form.comment.trim() } : {}) }, key.current);
      onDone({ category: it?.category ?? list.find((c) => c.category_id === form.categoryId)?.name, amount_kopecks: amount });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  return (
    <Dialog open={Boolean(kind)} onClose={onClose} title={form.kind === 'income' ? 'Добавить доход' : 'Добавить расход'} labelledBy="cb-add-title">
      <form class="form" onSubmit={submit} noValidate>
        <fieldset class="field">
          <legend class="field__label">Что это</legend>
          <div class="seg">
            {[
              ['expense', 'Расход'],
              ['income', 'Доход'],
            ].map(([v, l]) => (
              <label class="seg__item" key={v}>
                <input type="radio" name="cb-kind" value={v} checked={form.kind === v} onChange={() => set({ kind: v, categoryId: '' })} />
                <span class="seg__box">{l}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div class="field">
          <label class="field__label" for="cb-amount">
            Сумма, ₽
          </label>
          <input id="cb-amount" class="field__input field__input--money" inputMode="decimal" autoComplete="off" value={form.amount} onInput={(e) => set({ amount: e.currentTarget.value })} aria-invalid={errors.amount ? 'true' : undefined} aria-describedby={errors.amount ? 'cb-amount-err' : undefined} />
          {errors.amount ? (
            <p class="field__error" id="cb-amount-err">
              {errors.amount}
            </p>
          ) : null}
        </div>
        <div class="field">
          <label class="field__label" for="cb-cat">
            Статья
          </label>
          <select id="cb-cat" class="field__input" value={form.categoryId} onChange={(e) => set({ categoryId: e.currentTarget.value })} aria-invalid={errors.category ? 'true' : undefined} aria-describedby={errors.category ? 'cb-cat-err' : undefined}>
            <option value="">Выберите статью</option>
            {list.map((c) => (
              <option key={c.category_id} value={c.category_id}>
                {c.name}
              </option>
            ))}
          </select>
          {errors.category ? (
            <p class="field__error" id="cb-cat-err">
              {errors.category}
            </p>
          ) : null}
        </div>
        <div class="field">
          <label class="field__label" for="cb-date">
            Дата
          </label>
          <input id="cb-date" type="date" class="field__input" value={form.date} max={today} onChange={(e) => set({ date: e.currentTarget.value })} aria-invalid={errors.date ? 'true' : undefined} aria-describedby={errors.date ? 'cb-date-err' : undefined} />
          {errors.date ? (
            <p class="field__error" id="cb-date-err">
              {errors.date}
            </p>
          ) : null}
        </div>
        <div class="field">
          <label class="field__label" for="cb-comment">
            Комментарий
          </label>
          <input id="cb-comment" class="field__input" maxLength={200} value={form.comment} onInput={(e) => set({ comment: e.currentTarget.value })} aria-describedby="cb-comment-hint" />
          <p class="field__hint" id="cb-comment-hint">
            Например, «аренда за ноябрь» или номер счёта поставщика.
          </p>
        </div>
        <p class="hint">Запись нельзя будет изменить — только сторнировать с причиной. Это попадёт в журнал.</p>
        <ErrorNote error={error} />
        <div class="dialog__actions">
          <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
            {busy ? 'Записываем…' : form.kind === 'income' ? 'Записать доход' : 'Записать расход'}
          </button>
          <button type="button" class="btn btn--quiet btn--block" onClick={onClose}>
            Отмена
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function StornoDialog({ item, clubId, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(null);
  useEffect(() => {
    setReason('');
    setErr(null);
    setError(null);
    key.current = newIdempotencyKey();
  }, [item?.entry_id]);
  const submit = async (e) => {
    e.preventDefault();
    if (reason.trim().length < 3) {
      setErr('Напишите причину: например, «ошиблись в сумме» или «внесли дважды».');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.stornoCashbook(clubId, item.entry_id, reason.trim(), key.current);
      onDone();
    } catch (er) {
      // Повтор того же сторно (409 duplicate) — запись уже сторнирована, просто обновляем кассу
      if (er?.code === 'duplicate') onDone();
      else setError(er);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={Boolean(item)} onClose={onClose} title="Сторнировать запись" labelledBy="cb-storno-title">
      {item ? (
        <form class="form" onSubmit={submit} noValidate>
          <p class="lead">
            {KIND_WORD[item.kind] ?? item.kind} · {item.category} · {money(item.amount_kopecks)} · {dayLong(item.date)}
          </p>
          <p class="hint">Запись останется в кассе, рядом появится сторно с обратной суммой и вашей причиной сегодняшним числом. Прошлые остатки не меняются.</p>
          <div class="field">
            <label class="field__label" for="cb-reason">
              Причина
            </label>
            <input id="cb-reason" class="field__input" maxLength={300} value={reason} onInput={(e) => setReason(e.currentTarget.value)} aria-invalid={err ? 'true' : undefined} aria-describedby={err ? 'cb-reason-err' : undefined} />
            {err ? (
              <p class="field__error" id="cb-reason-err">
                {err}
              </p>
            ) : null}
          </div>
          <ErrorNote error={error} />
          <div class="dialog__actions">
            <button type="submit" class="btn btn--danger btn--block btn--lg" disabled={busy}>
              {busy ? 'Сторнируем…' : 'Сторнировать запись'}
            </button>
            <button type="button" class="btn btn--quiet btn--block" onClick={onClose}>
              Не сторнировать
            </button>
          </div>
        </form>
      ) : null}
    </Dialog>
  );
}

/** Справочник статей — только владелец (№177): добавить, скрыть или вернуть (удалить нельзя). */
function CategoriesDialog({ open, clubId, categories, onClose, onChanged }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('expense');
  const [err, setErr] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newIdempotencyKey());
  const add = async (e) => {
    e.preventDefault();
    if (name.trim().length < 2) {
      setErr('Название — от 2 до 40 знаков.');
      return;
    }
    setErr(null);
    setBusy(true);
    setError(null);
    try {
      await api.addCashbookCategory(clubId, { name: name.trim(), kind }, key.current);
      key.current = newIdempotencyKey();
      setName('');
      onChanged();
    } catch (er) {
      setError(er);
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (c) => {
    setError(null);
    try {
      await api.updateCashbookCategory(clubId, c.category_id, { active: !c.active });
      onChanged();
    } catch (er) {
      setError(er);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Статьи кассы" labelledBy="cb-cats-title">
      <div class="form">
        {['expense', 'income'].map((k) => (
          <section key={k} aria-labelledby={`cb-cats-${k}`}>
            <h3 class="field__label" id={`cb-cats-${k}`}>
              {k === 'expense' ? 'Расходы' : 'Доходы'}
            </h3>
            <ul class="dlist">
              {categories
                .filter((c) => c.kind === k)
                .map((c) => (
                  <li key={c.category_id}>
                    <span class={c.active ? '' : 'muted'}>
                      {c.name}
                      {c.active ? '' : ' (скрыта)'}
                    </span>
                    <button type="button" class="btn btn--quiet btn--sm" onClick={() => toggle(c)} aria-label={`${c.active ? 'Скрыть' : 'Вернуть'} статью «${c.name}»`}>
                      {c.active ? 'Скрыть' : 'Вернуть'}
                    </button>
                  </li>
                ))}
            </ul>
          </section>
        ))}
        <form class="form" onSubmit={add} noValidate>
          <div class="field">
            <label class="field__label" for="cb-newcat">
              Новая статья
            </label>
            <input id="cb-newcat" class="field__input" maxLength={40} value={name} onInput={(e) => setName(e.currentTarget.value)} aria-invalid={err ? 'true' : undefined} aria-describedby={err ? 'cb-newcat-err' : undefined} />
            {err ? (
              <p class="field__error" id="cb-newcat-err">
                {err}
              </p>
            ) : null}
          </div>
          <fieldset class="field">
            <legend class="field__label">Вид статьи</legend>
            <div class="seg">
              {[
                ['expense', 'Расход'],
                ['income', 'Доход'],
              ].map(([v, l]) => (
                <label class="seg__item" key={v}>
                  <input type="radio" name="cb-newkind" value={v} checked={kind === v} onChange={() => setKind(v)} />
                  <span class="seg__box">{l}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <ErrorNote error={error} />
          <button type="submit" class="btn btn--primary btn--block" disabled={busy}>
            Добавить статью
          </button>
        </form>
        <p class="hint">Статью нельзя удалить: старые записи ссылаются на неё. Скрытая статья не предлагается в новых записях.</p>
      </div>
    </Dialog>
  );
}
