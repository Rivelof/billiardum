import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { formatDate, formatMoney, formatTime } from '@billiardum/shared/format';
import { Icon } from '../../components/Icon.jsx';
import { Dialog } from '../../components/Dialog.jsx';
import { ErrorNote } from '../../components/ErrorNote.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { api, newIdempotencyKey } from '../../lib/api.js';
import { linkHandler } from '../../lib/router.js';
import { parseRubles } from '../../lib/cash.js';
import { dayLong } from '../../lib/period.js';
import { KIND_LABEL } from '../../lib/dashboard.js';
import {
  ALL_KINDS,
  COUNTER_KINDS,
  MAINT_KINDS,
  MAINT_COST_MAX_BACK_DAYS,
  COMMENT_MAX,
  canCorrect,
  correctionBody,
  costMinDate,
  eventBody,
  eventEffect,
  eventFormErrors,
  eventMinDate,
  eventServerError,
  eventStateWords,
  hoursText,
  maintenanceView,
  parseThresholds,
  reachedText,
} from '../../lib/maintenance.js';
import '../../styles/maintenance.css';

const SHORT = Object.fromEntries(MAINT_KINDS.map((k) => [k.value, k.short]));
const money = (v) => formatMoney(v);

/**
 * M5.6 «Обслуживание столов» (№198, server/maintenance/README.md) — раздел «Отчётов»: счётчики часов игры с последней
 * замены сукна, шаров и резины, прогресс к порогу, «+ Событие» (стоимость — расходом в кассу управляющего), история
 * с исправлениями (новая запись с причиной, «события не было»), пороги. Владелец и управляющий; ресепшн «Отчёты» не
 * видит. Отдельный чанк.
 */
export function MaintenanceScreen({ ctx, today, base, title }) {
  const { club, timeZone } = ctx;
  const clubId = club.club_id;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(null); // { resourceId?, kind? }
  const [fixing, setFixing] = useState(null); // событие
  const [limits, setLimits] = useState(false);
  const [done, setDone] = useState(null);
  const [fTable, setFTable] = useState('');
  const [fKind, setFKind] = useState('');
  const load = useCallback(async () => {
    setBusy(true);
    try {
      setData(await api.maintenance(clubId));
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }, [clubId]);
  useEffect(() => {
    load();
  }, [load]);
  const view = useMemo(() => (data ? maintenanceView(data) : null), [data]);
  const reached = view ? reachedText(view) : null;
  const events = view ? view.events.filter((e) => (!fTable || e.resourceId === fTable) && (!fKind || e.kind === fKind)) : [];
  const working = view ? view.resources.filter((r) => r.active) : [];
  const when = (iso) => `${formatDate(iso, timeZone)}, ${formatTime(iso, timeZone)}`;

  const counterCol = (k) => ({
    key: k,
    label: SHORT[k],
    sortValue: (r) => r.counters[k].pct ?? r.counters[k].hours / 1e6,
    render: (r) => <Counter c={r.counters[k]} kind={k} number={r.number} />,
  });

  return (
    <section class="rscreen maint" aria-labelledby="r-title">
      <div class="rhead">
        <h2 class="section-title" id="r-title">
          {title}
        </h2>
        <div class="rtools">
          <button type="button" class="btn btn--primary btn--sm" onClick={() => setAdding({})} disabled={!working.length}>
            <Icon name="plus" />
            Событие
          </button>
          <button type="button" class="btn btn--quiet btn--sm" onClick={() => setLimits(true)} disabled={!view}>
            <Icon name="settings" />
            Пороги
          </button>
        </div>
      </div>
      <p class="small muted">Счётчик — часы игры стола с последней замены. Порог — когда пора менять; при достижении владелец и управляющий получат уведомление (это не тревога).</p>
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
      {reached ? (
        <p class="note note--lamp">
          <Icon name="wrench" />
          <span class="note__title">{reached}</span>
        </p>
      ) : null}
      {!view && !error ? (
        <p class="muted loading" role="status">
          Загружаем столы…
        </p>
      ) : null}
      {view ? (
        <div class={`maint__body${busy ? ' is-busy' : ''}`}>
          <section class="dsec" aria-labelledby="mt-tables">
            <h3 class="section-title" id="mt-tables">
              Столы
            </h3>
            <DataTable
              caption="Часы игры с последней замены по столам"
              columns={[
                { key: 'table', label: 'Стол', head: true, sortValue: (r) => r.number, render: (r) => <TableName r={r} /> },
                ...COUNTER_KINDS.map(counterCol),
                {
                  key: 'act',
                  label: 'Действие',
                  render: (r) =>
                    r.active ? (
                      <button type="button" class="btn btn--quiet btn--sm" onClick={() => setAdding({ resourceId: r.id, kind: r.reached[0] ?? 'cloth' })}>
                        <Icon name="plus" />
                        Событие<span class="visually-hidden">: стол {r.number}</span>
                      </button>
                    ) : (
                      <span class="small muted">выведен из работы</span>
                    ),
                },
              ]}
              rows={view.resources}
              rowKey={(r) => r.id}
              rowClass={(r) => (r.reached.length ? 'is-reached' : r.active ? '' : 'is-muted')}
              empty="Столов пока нет: расставьте их в «Подключении» → «План зала»."
            />
          </section>
          <section class="dsec" aria-labelledby="mt-history">
            <h3 class="section-title" id="mt-history">
              История событий
            </h3>
            <div class="maint__filters">
              <label class="dfield">
                <span class="dfield__label">Стол</span>
                <select class="field__input" value={fTable} onChange={(e) => setFTable(e.currentTarget.value)}>
                  <option value="">Все столы</option>
                  {view.resources.map((r) => (
                    <option key={r.id} value={r.id}>
                      Стол {r.number}
                    </option>
                  ))}
                </select>
              </label>
              <label class="dfield">
                <span class="dfield__label">Что сделали</span>
                <select class="field__input" value={fKind} onChange={(e) => setFKind(e.currentTarget.value)}>
                  <option value="">Всё</option>
                  {MAINT_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {view.labels[k.value] ?? k.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <DataTable
              caption="История событий обслуживания"
              columns={[
                { key: 'date', label: 'Дата', head: true, sortValue: (r) => r.date, render: (r) => dayLong(r.date) },
                { key: 'table', label: 'Стол', sortValue: (r) => r.number ?? 0, render: (r) => (r.number !== null ? `Стол ${r.number}` : '—') },
                {
                  key: 'kind',
                  label: 'Что сделали',
                  render: (r) => (
                    <span class="maint__ev">
                      <span class={r.state === 'corrected' || r.state === 'voided' ? 'maint__struck' : ''}>{r.kindLabel}</span>
                      {eventStateWords(r) ? <span class={`maint__state maint__state--${r.state}`}>{eventStateWords(r)}</span> : null}
                    </span>
                  ),
                },
                {
                  key: 'cost',
                  label: 'Стоимость',
                  num: true,
                  sortValue: (r) => r.cost,
                  render: (r) =>
                    r.cost > 0 ? (
                      <span>
                        {money(r.cost)}
                        <span class="small muted">{r.cashbookEntryId ? ' · в кассе' : ' · расход сторнирован'}</span>
                      </span>
                    ) : (
                      <span class="muted">без расхода</span>
                    ),
                },
                { key: 'comment', label: 'Комментарий', render: (r) => r.comment ?? '—' },
                { key: 'who', label: 'Кто', render: (r) => `${r.by ?? '—'}${r.at ? `, ${when(r.at)}` : ''}` },
                {
                  key: 'act',
                  label: 'Действие',
                  render: (r) =>
                    canCorrect(r) ? (
                      <button type="button" class="btn btn--quiet btn--sm" onClick={() => setFixing(r)}>
                        <Icon name="edit" />
                        Исправить<span class="visually-hidden">: {r.kindLabel}, стол {r.number}, {dayLong(r.date)}</span>
                      </button>
                    ) : (
                      <span class="small muted">—</span>
                    ),
                },
              ]}
              rows={events}
              rowKey={(r) => r.id}
              rowClass={(r) => (r.state === 'corrected' || r.state === 'voided' ? 'is-muted' : '')}
              limit={30}
              empty={view.events.length ? 'По этим условиям событий нет.' : 'Событий пока нет. Отметьте последнюю замену сукна и шаров кнопкой «Событие» — счётчик начнётся с этой даты.'}
            />
            <p class="small muted">
              Записи не удаляются: ошибку исправьте кнопкой «Исправить» — появится новая запись с причиной, расход в кассе сторнируется и внесётся заново. Расходы — в{' '}
              <a href={`${base}/cashbook`} onClick={linkHandler} class="dlink dlink--inline">
                кассе управляющего
              </a>
              , статья «Ремонт столов».
            </p>
          </section>
        </div>
      ) : null}
      {view ? <EventDialog open={adding} fix={null} view={view} today={today} clubId={clubId} onClose={() => setAdding(null)} onDone={(text) => (setAdding(null), setDone(text), load())} /> : null}
      {view ? <EventDialog open={fixing ? {} : null} fix={fixing} view={view} today={today} clubId={clubId} onClose={() => setFixing(null)} onDone={(text) => (setFixing(null), setDone(text), load())} /> : null}
      {view ? <ThresholdsDialog open={limits} view={view} clubId={clubId} onClose={() => setLimits(false)} onDone={(text) => (setLimits(false), setDone(text), load())} /> : null}
    </section>
  );
}

function TableName({ r }) {
  return (
    <span class="maint__table">
      <span>
        {r.title} · {KIND_LABEL[r.kind] ?? r.kind}
      </span>
      {!r.active ? <span class="small muted">выведен из работы</span> : null}
      {r.reached.length ? (
        <span class="maint__flag">
          <Icon name="wrench" />
          Пора: {r.reached.map((k) => SHORT[k].toLowerCase()).join(', ')}
        </span>
      ) : null}
    </span>
  );
}

/** Счётчик: часы из порога, полоса прогресса (декоративная), состояние словом и с какой даты. */
function Counter({ c, kind, number }) {
  return (
    <span class={`mcount mcount--${c.state}`}>
      <span class="mcount__value">
        <b>{hoursText(c.hours)}</b>
        {c.threshold ? <span class="muted"> из {hoursText(c.threshold)}</span> : null}
      </span>
      {c.pct !== null ? (
        <span class="mcount__bar" aria-hidden="true">
          <span class="mcount__fill" style={{ width: `${Math.max(2, c.pct)}%` }} />
        </span>
      ) : null}
      <span class="mcount__state">
        {c.state === 'reached' || c.state === 'near' ? <Icon name={c.state === 'reached' ? 'wrench' : 'clock'} /> : null}
        {c.stateWord}
        {c.pct !== null ? `, ${c.pct} %` : ''}
      </span>
      <span class="mcount__since small muted">{c.sinceWords}</span>
      <span class="visually-hidden">
        {' '}
        ({SHORT[kind]}, стол {number})
      </span>
    </span>
  );
}

const formFrom = (today, preset, fix) =>
  fix
    ? { resourceId: fix.resourceId, kind: fix.kind, date: fix.date, cost: fix.cost ? String(fix.cost / 100).replace('.', ',') : '', comment: fix.comment ?? '', reason: '', voided: false }
    : { resourceId: preset?.resourceId ?? '', kind: preset?.kind ?? 'cloth', date: today, cost: '', comment: '', reason: '', voided: false };

/** «+ Событие» и «Исправить» (fix — исправляемая запись): одна форма, у исправления — причина и «События не было». */
function EventDialog({ open, fix, view, today, clubId, onClose, onDone }) {
  const [form, setForm] = useState(() => formFrom(today, open, fix));
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(null);
  useEffect(() => {
    if (!open) return;
    setForm(formFrom(today, open, fix));
    setErrors({});
    setError(null);
    key.current = newIdempotencyKey();
  }, [open, fix]);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const costValue = form.cost.trim() ? (parseRubles(form.cost) ?? Number.NaN) : null;
  const table = view.resources.find((r) => r.id === form.resourceId);
  const effect = form.voided ? [] : eventEffect({ kind: form.kind, cost: Number.isSafeInteger(costValue) ? costValue : 0, number: table?.number });
  const choices = view.resources.filter((r) => r.active || r.id === form.resourceId);
  const submit = async (e) => {
    e.preventDefault();
    const errs = eventFormErrors({ ...form, cost: costValue }, today, { correction: Boolean(fix) });
    setErrors(errs);
    if (Object.keys(errs).length) {
      document.getElementById(`me-${Object.keys(errs)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = fix ? correctionBody(fix, { ...form, cost: costValue }) : eventBody({ ...form, cost: costValue });
      await api.addMaintenanceEvent(clubId, body, key.current);
      const kindLabel = (view.labels[form.kind] ?? form.kind).toLowerCase();
      onDone(
        fix
          ? form.voided
            ? `Отмечено: события не было (${kindLabel}, стол ${table?.number}). Счётчик пересчитан${fix.cost ? ', расход в кассе сторнирован' : ''}.`
            : `Запись исправлена: ${kindLabel}, стол ${table?.number}, ${dayLong(form.date)}.`
          : `Записано: ${kindLabel}, стол ${table?.number}, ${dayLong(form.date)}${costValue > 0 ? `. Расход ${money(costValue)} — в кассе управляющего` : ''}.`,
      );
    } catch (err) {
      const mapped = eventServerError(err);
      if (mapped?.reason) {
        setErrors({ reason: mapped.reason });
        document.getElementById('me-reason')?.focus();
      } else if (mapped?.form) setError({ text: mapped.form });
      else setError(err);
    } finally {
      setBusy(false);
    }
  };
  const err = (k, hint) => (errors[k] ? { 'aria-invalid': 'true', 'aria-describedby': `me-${k}-err` } : hint ? { 'aria-describedby': hint } : {});
  const fieldError = (k) =>
    errors[k] ? (
      <p class="field__error" id={`me-${k}-err`}>
        {errors[k]}
      </p>
    ) : null;
  const title = fix ? 'Исправить запись' : 'Событие обслуживания';
  return (
    <Dialog open={Boolean(open)} onClose={onClose} title={title} labelledBy={fix ? 'mf-title' : 'me-title'}>
      <form class="form" onSubmit={submit} noValidate>
        {fix ? (
          <>
            <p class="hint">
              Было: {fix.kindLabel.toLowerCase()}, стол {fix.number}, {dayLong(fix.date)}
              {fix.cost ? `, ${money(fix.cost)}` : ''}. Запись не удаляется: появится исправление с причиной.
            </p>
            <div class="field">
              <label class="field__label" for="me-reason">
                Причина исправления
              </label>
              <input id="me-reason" class="field__input" maxLength={2000} value={form.reason} onInput={(e) => set({ reason: e.currentTarget.value })} {...err('reason', 'me-reason-hint')} />
              {fieldError('reason') ?? (
                <p class="field__hint" id="me-reason-hint">
                  Например, «опечатка в сумме» или «сукно меняли на другом столе». Попадёт в журнал.
                </p>
              )}
            </div>
            <label class="check">
              <input type="checkbox" checked={form.voided} onChange={(e) => set({ voided: e.currentTarget.checked })} />
              <span>События не было — убрать из счётчика{fix.cost ? ' и сторнировать расход' : ''}</span>
            </label>
          </>
        ) : null}
        {!form.voided ? (
          <>
            <div class="field">
              <label class="field__label" for="me-resource">
                Стол
              </label>
              <select id="me-resource" class="field__input" value={form.resourceId} onChange={(e) => set({ resourceId: e.currentTarget.value })} {...err('resource')}>
                <option value="">Выберите стол</option>
                {choices.map((r) => (
                  <option key={r.id} value={r.id}>
                    Стол {r.number} · {KIND_LABEL[r.kind] ?? r.kind}
                  </option>
                ))}
              </select>
              {fieldError('resource')}
            </div>
            <fieldset class="field">
              <legend class="field__label">Что сделали</legend>
              <div class="seg maint__kinds">
                {MAINT_KINDS.map((k, i) => (
                  <label class="seg__item" key={k.value}>
                    <input type="radio" id={i === 0 ? 'me-kind' : undefined} name={fix ? 'mf-kind' : 'me-kind'} value={k.value} checked={form.kind === k.value} onChange={() => set({ kind: k.value })} />
                    <span class="seg__box">{view.labels[k.value] ?? k.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div class="field">
              <label class="field__label" for="me-date">
                Дата
              </label>
              <input id="me-date" type="date" class="field__input" value={form.date} min={eventMinDate(today)} max={today} onChange={(e) => set({ date: e.currentTarget.value })} {...err('date')} />
              {fieldError('date')}
            </div>
            <div class="field">
              <label class="field__label" for="me-cost">
                Стоимость, ₽ <span class="muted">(необязательно)</span>
              </label>
              <input id="me-cost" class="field__input field__input--money" inputMode="decimal" autoComplete="off" value={form.cost} onInput={(e) => set({ cost: e.currentTarget.value })} {...err('cost', 'me-cost-hint')} />
              {fieldError('cost') ?? (
                <p class="field__hint" id="me-cost-hint">
                  Пусто — без расхода. Со стоимостью дата — не раньше {dayLong(costMinDate(today))} ({MAINT_COST_MAX_BACK_DAYS} дней назад), без неё — до года назад.
                </p>
              )}
            </div>
            <div class="field">
              <label class="field__label" for="me-comment">
                Комментарий
              </label>
              <input id="me-comment" class="field__input" maxLength={COMMENT_MAX} value={form.comment} onInput={(e) => set({ comment: e.currentTarget.value })} {...err('comment', 'me-comment-hint')} />
              {fieldError('comment') ?? (
                <p class="field__hint" id="me-comment-hint">
                  Например, «сукно 12 футов, перетяжка мастером».
                </p>
              )}
            </div>
            <div class="note note--lamp">
              <Icon name="alert" />
              <p class="note__title">Стоимость уйдёт расходом в кассу управляющего</p>
              <p class="note__body">Статья «Ремонт столов», дата события. {fix ? 'Прежний расход этой записи сторнируется.' : 'Ошибку потом исправьте здесь же — расход сторнируется сам.'}</p>
            </div>
          </>
        ) : null}
        {effect.length ? (
          <p class="hint" aria-live="polite">
            {effect.join(' ')}
          </p>
        ) : null}
        {error?.text ? (
          <p class="note note--error" role="alert">
            <Icon name="alert" />
            <span class="note__title">{error.text}</span>
          </p>
        ) : (
          <ErrorNote error={error} />
        )}
        <div class="dialog__actions">
          <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
            {busy ? 'Записываем…' : fix ? (form.voided ? 'Отметить: события не было' : 'Записать исправление') : costValue > 0 ? `Записать событие и расход ${money(costValue)}` : 'Записать событие'}
          </button>
          <button type="button" class="btn btn--quiet btn--block" onClick={onClose}>
            Отмена
          </button>
        </div>
      </form>
    </Dialog>
  );
}

const thrText = (v) => (v === null || v === undefined ? '' : String(v));

function ThresholdsDialog({ open, view, clubId, onClose, onDone }) {
  const [raw, setRaw] = useState({});
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setRaw(Object.fromEntries(ALL_KINDS.map((k) => [k, thrText(view.thresholds[k])])));
    setErrors({});
    setError(null);
  }, [open]);
  const submit = async (e) => {
    e.preventDefault();
    const { changed, errors: errs } = parseThresholds(raw, view.thresholds);
    setErrors(errs);
    if (Object.keys(errs).length) {
      document.getElementById(`mt-${Object.keys(errs)[0]}`)?.focus();
      return;
    }
    if (!Object.keys(changed).length) {
      onDone('Пороги не изменились.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.maintenanceThresholds(clubId, changed);
      onDone('Пороги сохранены. Уведомление придёт, когда стол их достигнет.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Пороги обслуживания" labelledBy="mt-title">
      <form class="form" onSubmit={submit} noValidate>
        <p class="hint">Часы игры стола, после которых пора менять. Пусто — без порога: счётчик идёт, уведомлений нет.</p>
        {ALL_KINDS.map((k) => (
          <div class="field" key={k}>
            <label class="field__label" for={`mt-${k}`}>
              {view.labels[k] ?? SHORT[k]}, ч
            </label>
            <input
              id={`mt-${k}`}
              class="field__input"
              inputMode="numeric"
              autoComplete="off"
              value={raw[k] ?? ''}
              onInput={(e) => setRaw((r) => ({ ...r, [k]: e.currentTarget.value }))}
              aria-invalid={errors[k] ? 'true' : undefined}
              aria-describedby={errors[k] ? `mt-${k}-err` : `mt-${k}-hint`}
            />
            {errors[k] ? (
              <p class="field__error" id={`mt-${k}-err`}>
                {errors[k]}
              </p>
            ) : (
              <p class="field__hint" id={`mt-${k}-hint`}>
                {view.defaults[k] ? `По умолчанию ${hoursText(view.defaults[k])}.` : 'По умолчанию без порога.'}
              </p>
            )}
          </div>
        ))}
        <ErrorNote error={error} />
        <div class="dialog__actions">
          <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
            {busy ? 'Сохраняем…' : 'Сохранить пороги'}
          </button>
          <button type="button" class="btn btn--quiet btn--block" onClick={onClose}>
            Отмена
          </button>
        </div>
      </form>
    </Dialog>
  );
}
