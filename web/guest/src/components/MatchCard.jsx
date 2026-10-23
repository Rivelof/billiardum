import { useEffect, useState } from 'preact/hooks';
import { formatTime } from '@billiardum/shared/format';
import { DISCIPLINE_WORD, matchState, notCountedText } from '@billiardum/shared/plus';
import { Icon } from './Icon.jsx';
import { Dialog } from './Dialog.jsx';
import { ErrorNote } from './ErrorNote.jsx';
import { api } from '../lib/api.js';
import { lastClub } from '../lib/flow.js';
import { sides, zoneOf } from '../lib/plus.js';

/** Карточка партии: счёт, статус, «Подтвердить» / «Оспорить», причина «не засчитана». Используется и на экране игры. */
export function MatchCard({ match, meId, onChange, onDispute, big = false }) {
  const { me, them } = sides(match, meId);
  const st = matchState(match, meId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const delta = match.rating_delta?.[meId];
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      onChange(await api.confirmMatch(match.id));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article class={`mcard${big ? ' mcard--big' : ''} mcard--${st.tone}`} aria-label={`Партия: ${me?.nick} ${me?.score}, ${them?.nick} ${them?.score}`}>
      <p class="mcard__head">
        <span>{DISCIPLINE_WORD[match.discipline]}</span>
        <span class={`badge badge--${st.tone === 'play' ? 'play' : st.tone === 'free' ? 'free' : st.tone === 'alert' ? 'alert' : 'reserved'}`}>
          <span class="badge__dot" aria-hidden="true" />
          {st.word}
        </span>
      </p>
      <p class="mcard__score" aria-hidden="true">
        <span class="mcard__side">
          <span class="mcard__num display">{me?.score}</span>
          <span class="mcard__nick">{me?.nick ?? 'Вы'}</span>
        </span>
        <span class="mcard__colon display">:</span>
        <span class="mcard__side">
          <span class="mcard__num display">{them?.score}</span>
          <span class="mcard__nick">{them?.nick ?? 'Соперник'}</span>
        </span>
      </p>
      {match.counted === false ? <p class="mcard__nc">{notCountedText(match.not_counted_reason) ?? 'в рейтинг не засчитана'}</p> : null}
      {match.counted && Number.isFinite(delta) ? (
        <p class={`mcard__delta mono${delta >= 0 ? ' mcard__delta--up' : ' mcard__delta--down'}`}>
          Рейтинг {delta >= 0 ? `+${delta}` : delta}
        </p>
      ) : null}
      {match.status === 'pending' && !st.canConfirm ? <p class="mcard__hint">Соперник подтверждает в своём телефоне — до {formatTime(match.confirm_until, zoneOf(lastClub()?.timezone))}.</p> : null}
      <ErrorNote error={error} />
      {st.canConfirm || (match.status === 'confirmed' && Date.now() < Date.parse(match.confirm_until ?? 0)) ? (
        <div class="mcard__actions">
          {st.canConfirm ? (
            <button type="button" class="btn btn--primary btn--sm" disabled={busy} onClick={confirm}>
              <Icon name="check" />
              {busy ? 'Подтверждаем…' : 'Подтвердить счёт'}
            </button>
          ) : null}
          {onDispute && (st.canConfirm || (match.status === 'confirmed' && Date.now() < Date.parse(match.confirm_until ?? 0))) ? (
            <button type="button" class="btn btn--quiet btn--sm" onClick={onDispute}>
              Счёт неверный
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/** Спор: результат уходит управляющему клуба, решение — в журнал (№137). */
export function DisputeDialog({ match, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    setReason('');
    setError(null);
  }, [match?.id]);
  if (!match) return <Dialog open={false} onClose={onClose} title="" />;
  return (
    <Dialog open onClose={onClose} title="Оспорить счёт?" labelledBy="dsp-title">
      <form
        class="form"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          if (reason.trim().length < 3) return;
          setBusy(true);
          setError(null);
          try {
            onDone(await api.disputeMatch(match.id, reason.trim()));
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p class="hint">Партию рассудит управляющий клуба. Пока спор не решён, рейтинг не меняется.</p>
        <div class="field">
          <label class="field__label" for="dsp-reason">
            Что не так
          </label>
          <input id="dsp-reason" class="field__input" maxLength={300} value={reason} placeholder="Например: счёт был 8:6, а не 8:5" onInput={(e) => setReason(e.currentTarget.value)} />
        </div>
        <ErrorNote error={error} />
        <div class="dialog__actions">
          <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy || reason.trim().length < 3}>
            {busy ? 'Отправляем…' : 'Отправить управляющему'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
