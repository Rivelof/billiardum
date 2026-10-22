import { useEffect, useRef, useState } from 'preact/hooks';
import { formatTime, plural } from '@billiardum/shared/format';
import { Icon } from '../components/Icon.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { Dialog } from '../components/Dialog.jsx';
import { api, newIdempotencyKey } from '../lib/api.js';
import { alarmAction, alarmTime, alarmView, sortAlarms } from '../lib/alarms.js';
import { can } from '../lib/auth.js';

/**
 * Открытые тревоги: уровень словом, что случилось и что делать, «Принято».
 * Действие тревоги (Д2: «Повторить» чек зачёта) — управляющему и владельцу, с причиной.
 */
export function AlarmList({ alarms, timeZone, onAck, role, emptyText = 'Тревог нет. Всё под контролем.' }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [acting, setActing] = useState(null); // { alarm, action }
  const [done, setDone] = useState({}); // alarm.id → текст результата

  if (!alarms.length) {
    return (
      <p class="calm" role="status">
        <Icon name="shield" />
        {emptyText}
      </p>
    );
  }

  const ack = async (id) => {
    setBusy(id);
    setError(null);
    try {
      await api.ack(id);
      onAck?.(id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <ErrorNote error={error} />
      <ul class="alarms">
        {sortAlarms(alarms).map((a) => {
          const v = alarmView(a);
          return (
            <li key={a.id} class={`alarm alarm--${v.level}`}>
              <p class="alarm__head">
                <span class="alarm__level">
                  <Icon name="alert" />
                  {v.levelWord}
                </span>
                {v.table ? <span class="alarm__table">{v.table}</span> : null}
                {alarmTime(a) ? <span class="alarm__time mono">{formatTime(alarmTime(a), timeZone)}</span> : null}
                {v.repeats ? <span>{v.repeats} {plural(v.repeats, ['раз', 'раза', 'раз'])} подряд</span> : null}
              </p>
              <p class="alarm__title">{v.title}</p>
              <p class="alarm__text">{v.text}</p>
              {done[a.id] ? (
                <p class="alarm__done" role="status">
                  <Icon name="check" />
                  {done[a.id]}
                </p>
              ) : null}
              <span class="alarm__tools">
                {alarmAction(a) && can.manage(role) && !done[a.id] ? (
                  <button type="button" class="btn btn--secondary btn--sm" onClick={() => setActing({ alarm: a, action: alarmAction(a) })}>
                    <Icon name="refresh" />
                    {alarmAction(a).title}
                  </button>
                ) : null}
                <button type="button" class="btn btn--quiet btn--sm alarm__ack" disabled={busy === a.id} onClick={() => ack(a.id)}>
                  <Icon name="check" />
                  {busy === a.id ? 'Отмечаем…' : 'Принято'}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      <RetryDialog
        target={acting}
        onClose={() => setActing(null)}
        onDone={(alarm, res) => {
          setActing(null);
          setDone((d) => ({ ...d, [alarm.id]: res?.retried === false ? 'Чек уже не ждёт повтора — обновите тревоги.' : 'Чек зачёта отправлен в ЮKassa повторно. Тревогу можно принять.' }));
        }}
      />
    </>
  );
}

/** «Повторить» чек зачёта (Д2): причина обязательна, один Idempotency-Key на окно. */
function RetryDialog({ target, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const key = useRef(null);
  const id = target?.alarm?.id;
  useEffect(() => {
    setReason('');
    setTried(false);
    setError(null);
    key.current = id ? newIdempotencyKey() : null;
  }, [id]);
  if (!target) return <Dialog open={false} onClose={onClose} title="" />;
  const ok = reason.trim().length >= 3;
  return (
    <Dialog open onClose={onClose} title="Повторить чек зачёта?" labelledBy="retry-title">
      <form
        class="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setTried(true);
          if (!ok) return;
          setBusy(true);
          setError(null);
          try {
            const res = await api.retryReceiptSettle(target.action.receiptId, reason.trim(), key.current);
            onDone(target.alarm, res);
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
        noValidate
      >
        <p class="hint">Чек снова уйдёт в ЮKassa. Второго чека не будет: прошлый отказ значит, что чек не создан.</p>
        <div class="field">
          <label class="field__label" for="retry-reason">
            Причина
          </label>
          <input id="retry-reason" class="field__input" maxLength={300} value={reason} aria-invalid={tried && !ok ? 'true' : undefined} onInput={(e) => setReason(e.currentTarget.value)} />
          {tried && !ok ? <p class="field__error">Напишите причину — она уйдёт в журнал.</p> : <p class="field__hint">Например: «Исправили ИНН в настройках ЮKassa».</p>}
        </div>
        <ErrorNote error={error} />
        <div class="dialog__actions dialog__actions--row">
          <button type="submit" class="btn btn--primary btn--lg" disabled={busy}>
            {busy ? 'Отправляем…' : 'Повторить'}
          </button>
          <button type="button" class="btn btn--quiet btn--lg" onClick={onClose}>
            Отмена
          </button>
        </div>
      </form>
    </Dialog>
  );
}
