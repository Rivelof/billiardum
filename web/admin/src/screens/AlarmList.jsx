import { useState } from 'preact/hooks';
import { formatTime, plural } from '@billiardum/shared/format';
import { Icon } from '../components/Icon.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { api } from '../lib/api.js';
import { alarmTime, alarmView, sortAlarms } from '../lib/alarms.js';

/** Открытые тревоги: уровень словом, что случилось и что делать, «Принято». */
export function AlarmList({ alarms, timeZone, onAck, emptyText = 'Тревог нет. Всё под контролем.' }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

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
              <button type="button" class="btn btn--quiet btn--sm alarm__ack" disabled={busy === a.id} onClick={() => ack(a.id)}>
                <Icon name="check" />
                {busy === a.id ? 'Отмечаем…' : 'Принято'}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
