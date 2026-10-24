import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { formatDate, formatMoney, formatTime } from '@billiardum/shared/format';
import { Shell } from '../components/Shell.jsx';
import { Icon } from '../components/Icon.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { MoneyEntry } from '../components/MoneyEntry.jsx';
import { api, newIdempotencyKey, streamClub } from '../lib/api.js';
import { can } from '../lib/auth.js';
import { parseRubles } from '../lib/cash.js';
import { closeLabel, currentOf, discrepancy, shiftList, staffName } from '../lib/shift.js';
import { linkHandler } from '../lib/router.js';
import { BASE } from '../lib/env.js';

const DEFAULT_FLOAT = '3000';

/**
 * Смена (PRODUCT §4.2, решения №81, №83): открыть с разменом; закрыть с вводом фактических наличных —
 * ожидаемая сумма, расхождение крупно, предупреждение при ≠ 0. Управляющему и владельцу — список отчётов смен.
 */
export function Shift({ ctx }) {
  const { club, role, user, timeZone } = ctx;
  const clubId = club.club_id;
  const [shift, setShift] = useState(undefined);
  const [error, setError] = useState(null);
  const [closing, setClosing] = useState(false);
  const [closed, setClosed] = useState(null);
  const [history, setHistory] = useState(null);

  const load = useCallback(async () => {
    try {
      setShift(currentOf(await api.currentShift(clubId)));
      setError(null);
    } catch (err) {
      if (err?.code === 'not_found') setShift(null);
      else setError(err);
    }
    if (can.reports(role)) {
      try {
        setHistory(shiftList(await api.shifts(clubId, { limit: 14 })));
      } catch {
        setHistory([]);
      }
    }
  }, [clubId, role]);

  useEffect(() => {
    load();
    const stream = streamClub(clubId, { events: ['shift'], onEvent: () => !closing && load(), onOpen: load });
    return () => stream.close();
  }, [clubId, load]);

  const fmtT = (iso) => formatTime(iso, timeZone);

  return (
    <Shell club={club} role={role} user={user} timeZone={timeZone} active="shift" title={can.reports(role) ? 'Смены' : 'Смена'}>
      <div class="page shift">
        <ErrorNote error={error}>
          <button type="button" class="btn btn--secondary btn--sm" onClick={load}>
            Обновить
          </button>
        </ErrorNote>

        {shift === undefined && !error ? <p class="muted loading">Загружаем смену…</p> : null}

        {closed ? (
          <ClosedSummary shift={closed} role={role} clubId={clubId} onNew={() => (setClosed(null), load())} fmtT={fmtT} />
        ) : shift === null ? (
          <OpenShift clubId={clubId} onOpened={(s) => setShift(s)} />
        ) : shift ? (
          closing ? (
            <CloseShift
              shift={shift}
              onCancel={() => setClosing(false)}
              onClosed={(s) => {
                setClosed(s);
                setClosing(false);
                setShift(null);
                load();
              }}
            />
          ) : (
            <section class="panel shift__open" aria-labelledby="shift-now">
              <p class="badge badge--play">
                <span class="badge__dot" aria-hidden="true" />
                Смена открыта
              </p>
              <h2 class="shift__title display" id="shift-now">
                С {fmtT(shift.opened_at)}, {formatDate(shift.opened_at, timeZone)}
              </h2>
              <p class="muted">Кассир: {staffName(shift, 'opened') ?? 'сотрудник клуба'}</p>
              <dl class="receipt shift__facts">
                <div class="receipt__row">
                  <dt>Размен при открытии</dt>
                  <dd class="receipt__sum">{formatMoney(shift.float_kopecks ?? 0)}</dd>
                </div>
                {Number.isSafeInteger(shift.cash_sales_kopecks) ? (
                  <div class="receipt__row">
                    <dt>Наличные продажи</dt>
                    <dd class="receipt__sum">+{formatMoney(shift.cash_sales_kopecks)}</dd>
                  </div>
                ) : null}
                {shift.cash_refunds_kopecks ? (
                  <div class="receipt__row">
                    <dt>Наличные возвраты</dt>
                    <dd class="receipt__sum">−{formatMoney(shift.cash_refunds_kopecks)}</dd>
                  </div>
                ) : null}
                {Number.isSafeInteger(shift.expected_cash_kopecks) ? (
                  <div class="receipt__row receipt__row--total">
                    <dt>Должно быть в кассе</dt>
                    <dd class="receipt__sum">{formatMoney(shift.expected_cash_kopecks)}</dd>
                  </div>
                ) : null}
              </dl>
              {!Number.isSafeInteger(shift.expected_cash_kopecks) ? <p class="hint">Сколько наличных должно быть в кассе, программа покажет после закрытия смены: вы вводите только то, что насчитали.</p> : null}
              {Number.isSafeInteger(shift.sales_count) ? <p class="small">Продаж за смену: {shift.sales_count}.</p> : null}
              <button type="button" class="btn btn--primary btn--lg" onClick={() => setClosing(true)}>
                <Icon name="register" />
                Закрыть смену
              </button>
            </section>
          )
        ) : null}

        {can.reports(role) ? <History list={history} clubId={clubId} timeZone={timeZone} /> : null}
      </div>
    </Shell>
  );
}

function OpenShift({ clubId, onOpened }) {
  const [value, setValue] = useState(DEFAULT_FLOAT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const key = useRef(newIdempotencyKey());
  const k = parseRubles(value);
  const submit = async (e) => {
    e.preventDefault();
    if (k === null) return;
    setBusy(true);
    setError(null);
    try {
      onOpened(await api.openShift(clubId, k, key.current));
    } catch (err) {
      setError(err);
      if (err?.code === 'shift_open') onOpened(currentOf(await api.currentShift(clubId).catch(() => null)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="panel shift__form" aria-labelledby="shift-closed">
      <p class="badge">
        <span class="badge__dot" aria-hidden="true" />
        Смена закрыта
      </p>
      <h2 class="shift__title display" id="shift-closed">
        Откройте смену
      </h2>
      <p class="hint">Пересчитайте наличные в кассе перед началом работы. Без открытой смены касса не примет наличные.</p>
      <form class="shift__grid" onSubmit={submit} noValidate>
        <MoneyEntry id="float" label="Размен в кассе, ₽" value={value} onChange={setValue} invalid={value !== '' && k === null} hint="Сколько наличных в кассе сейчас, до первой продажи." keypadLabel="Клавиатура размена" />
        <div class="shift__side">
          <ErrorNote error={error} />
          <button type="submit" class="btn btn--primary btn--lg btn--block" disabled={busy || k === null}>
            <Icon name="register" />
            {busy ? 'Открываем…' : k === null ? 'Введите размен' : `Открыть смену с разменом ${formatMoney(k)}`}
          </button>
        </div>
      </form>
    </section>
  );
}

function CloseShift({ shift, onCancel, onClosed }) {
  const [value, setValue] = useState('');
  const [comment, setComment] = useState('');
  const [recounted, setRecounted] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const key = useRef(newIdempotencyKey());
  const inputRef = useRef(null);
  // Ожидаемая сумма до закрытия есть, если сервер отдаёт её в открытой смене; иначе «слепое» закрытие:
  // кассир вводит факт, расхождение — сразу после закрытия
  const known = Number.isSafeInteger(shift.expected_cash_kopecks);
  const expected = known ? shift.expected_cash_kopecks : 0;
  const actual = parseRubles(value);
  const diff = known ? discrepancy(expected, actual) : { kind: 'unknown', kopecks: 0, word: '', amount: '—' };
  const off = diff.kind === 'shortage' || diff.kind === 'surplus';

  useEffect(() => inputRef.current?.focus(), []);

  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (actual === null) {
      inputRef.current?.focus();
      return;
    }
    if (off && !recounted) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.closeShift(shift.id, { actual_cash_kopecks: actual, ...(comment.trim() ? { comment: comment.trim() } : {}) }, key.current);
      onClosed(res?.shift ?? (res?.id ? res : { ...shift, actual_cash_kopecks: actual, discrepancy_kopecks: diff.kopecks, closed_at: new Date().toISOString() }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="panel shift__form" aria-labelledby="close-title">
      <h2 class="shift__title display" id="close-title">
        Закрытие смены
      </h2>
      <p class="hint">Пересчитайте наличные в кассе и введите, сколько получилось. Размен тоже считается.</p>
      <form class="shift__grid" onSubmit={submit} noValidate>
        <MoneyEntry
          id="actual"
          label="Наличных в кассе, ₽"
          value={value}
          onChange={(v) => {
            setValue(v);
            setRecounted(false);
          }}
          inputRef={inputRef}
          invalid={tried && actual === null}
          describedBy="diff-out"
          keypadLabel="Клавиатура наличных"
        />
        <div class="shift__side">
          {known ? (
            <dl class="shift__compare">
              <div>
                <dt>Должно быть</dt>
                <dd class="display">{formatMoney(expected)}</dd>
              </div>
              <div>
                <dt>Факт</dt>
                <dd class="display">{actual === null ? '—' : formatMoney(actual)}</dd>
              </div>
            </dl>
          ) : (
            <div class="note" id="diff-out">
              <Icon name="register" />
              <p class="note__title">Пересчитайте наличные дважды</p>
              <p class="note__body">После закрытия сумму не изменить. Сколько должно быть и расхождение программа покажет сразу после закрытия, расхождение уйдёт владельцу.</p>
            </div>
          )}
          {known ? <div id="diff-out" class={`diff diff--${diff.kind}`} aria-live="polite">
            <p class="diff__label">
              {diff.kind === 'none' ? <Icon name="check" /> : off ? <Icon name="alert" /> : null}
              {diff.kind === 'unknown' ? 'Расхождение' : diff.kind === 'none' ? 'Сходится до копейки' : diff.kind === 'shortage' ? 'Недостача' : 'Излишек'}
            </p>
            <p class="diff__value display">{diff.kind === 'unknown' ? '—' : diff.kind === 'none' ? formatMoney(0) : `${diff.kopecks < 0 ? '−' : '+'}${diff.amount}`}</p>
          </div> : null}
          {off ? (
            <div class="shift__warn">
              <div class="note note--error" role="alert">
                <Icon name="alert" />
                <p class="note__title">Пересчитайте наличные ещё раз</p>
                <p class="note__body">Если расхождение останется, смена закроется с ним, и владелец сразу получит уведомление.</p>
              </div>
              <label class="check">
                <input type="checkbox" checked={recounted} onChange={(e) => setRecounted(e.currentTarget.checked)} aria-invalid={tried && !recounted ? 'true' : undefined} />
                <span>Наличные пересчитаны второй раз, сумма та же</span>
              </label>
              {tried && !recounted ? <p class="field__error">Отметьте, что пересчитали наличные.</p> : null}
              <div class="field">
                <label class="field__label" for="close-comment">
                  Комментарий для владельца
                </label>
                <input id="close-comment" class="field__input" maxLength={300} value={comment} onInput={(e) => setComment(e.currentTarget.value)} />
                <p class="field__hint">Необязательно. Например: «Гость оплатил наличными, чек пробит картой».</p>
              </div>
            </div>
          ) : null}
          <ErrorNote error={error} />
          <div class="dialog__actions">
            <button type="submit" class={`btn btn--lg btn--block ${off ? 'btn--danger' : 'btn--primary'}`} disabled={busy}>
              {busy ? 'Закрываем…' : known ? closeLabel(diff) : actual === null ? 'Введите наличные в кассе' : `Закрыть смену: в кассе ${formatMoney(actual)}`}
            </button>
            <button type="button" class="btn btn--quiet btn--block" onClick={onCancel}>
              Не закрывать, вернуться
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}

function ClosedSummary({ shift, role, clubId, onNew, fmtT }) {
  const d = shift.discrepancy_kopecks ?? 0;
  const diff = discrepancy(shift.expected_cash_kopecks ?? 0, shift.actual_cash_kopecks ?? 0);
  return (
    <section class="panel shift__done" role="status" aria-labelledby="done-title">
      <h2 class="shift__title display" id="done-title">
        Смена закрыта
      </h2>
      <p class="muted">
        {shift.opened_at ? `С ${fmtT(shift.opened_at)} ` : ''}
        {shift.closed_at ? `до ${fmtT(shift.closed_at)}` : ''}
      </p>
      <div class="shift__grid">
        <dl class="receipt shift__facts">
          <div class="receipt__row">
            <dt>Должно быть</dt>
            <dd class="receipt__sum">{formatMoney(shift.expected_cash_kopecks ?? 0)}</dd>
          </div>
          <div class="receipt__row">
            <dt>Факт</dt>
            <dd class="receipt__sum">{formatMoney(shift.actual_cash_kopecks ?? 0)}</dd>
          </div>
        </dl>
        <div class={`diff diff--${diff.kind}`}>
          <p class="diff__label">
            <Icon name={d === 0 ? 'check' : 'alert'} />
            {d === 0 ? 'Сходится до копейки' : d < 0 ? 'Недостача' : 'Излишек'}
          </p>
          <p class="diff__value display">{d === 0 ? formatMoney(0) : `${d < 0 ? '−' : '+'}${formatMoney(Math.abs(d))}`}</p>
        </div>
      </div>
      {d !== 0 ? (
        <div class="note note--error">
          <Icon name="alert" />
          <p class="note__title">Расхождение отправлено владельцу</p>
          <p class="note__body">Если нашли ошибку в подсчёте, сообщите управляющему: смену уже не переоткрыть, но расхождение можно объяснить в журнале.</p>
        </div>
      ) : null}
      <p class="hint">
        {d === 0 ? 'Отчёт смены отправлен владельцу. ' : ''}Наличные можно сдать управляющему.
      </p>
      <div class="row">
        {can.reports(role) && shift.id ? (
          <a class="btn btn--secondary" href={`${BASE}c/${encodeURIComponent(clubId)}/shift/${encodeURIComponent(shift.id)}`} onClick={linkHandler}>
            <Icon name="report" />
            Открыть отчёт смены
          </a>
        ) : null}
        <button type="button" class="btn btn--quiet" onClick={onNew}>
          Открыть новую смену
        </button>
      </div>
    </section>
  );
}

function History({ list, clubId, timeZone }) {
  return (
    <section class="shift__history" aria-labelledby="history-title">
      <h2 class="section-title" id="history-title">
        Отчёты смен
      </h2>
      {/* M5.2 (№176): все смены с фильтрами, экспорт и печать */}
      <a class="btn btn--quiet btn--sm" href={`${BASE}c/${encodeURIComponent(clubId)}/reports/shifts`} onClick={linkHandler}>
        <Icon name="report" />
        Все смены с фильтрами
      </a>
      {list === null ? <p class="muted loading">Загружаем…</p> : null}
      {list?.length === 0 ? <p class="hint">Закрытых смен пока нет. Отчёт появится здесь после закрытия первой смены.</p> : null}
      {list?.length ? (
        <ul class="shifts">
          {list.map((s) => {
            const d = s.discrepancy_kopecks;
            const open = s.status === 'open' || !s.closed_at;
            return (
              <li key={s.id}>
                <a class="shifts__item" href={`${BASE}c/${encodeURIComponent(clubId)}/shift/${encodeURIComponent(s.id)}`} onClick={linkHandler}>
                  <span class="shifts__when">
                    <b>{formatDate(s.opened_at, timeZone)}</b>
                    <span class="mono">
                      {formatTime(s.opened_at, timeZone)}–{open ? 'сейчас' : formatTime(s.closed_at, timeZone)}
                    </span>
                  </span>
                  <span class="shifts__who">{staffName(s, 'opened') ?? 'Сотрудник'}</span>
                  <span class="shifts__sum mono">{Number.isSafeInteger(s.revenue_total_kopecks) ? formatMoney(s.revenue_total_kopecks) : ''}</span>
                  <span class={`shifts__state shifts__state--${open ? 'open' : d ? (d < 0 ? 'short' : 'over') : 'ok'}`}>
                    {open ? 'Идёт' : d ? `${d < 0 ? 'Недостача' : 'Излишек'} ${formatMoney(Math.abs(d))}` : 'Касса сошлась'}
                  </span>
                  <Icon name="forward" />
                </a>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
