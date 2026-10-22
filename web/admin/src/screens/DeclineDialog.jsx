import { useEffect, useState } from 'preact/hooks';
import { DECLINE_REASONS } from '@billiardum/shared/reasons';
import { Dialog } from '../components/Dialog.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { api } from '../lib/api.js';
import { requestTitle } from '../lib/words.js';

/** «Отклонить» заявку с причиной: гость увидит отказ, стол освободится. */
export function DeclineDialog({ request, onClose, onDone }) {
  const [reason, setReason] = useState(DECLINE_REASONS[0].code);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setReason(DECLINE_REASONS[0].code);
    setError(null);
  }, [request?.id]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.decline(request.id, reason);
      onDone?.(request);
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(request)} onClose={onClose} title="Отклонить заявку" labelledBy="decline-title">
      {request ? (
        <form class="form" onSubmit={submit}>
          <p class="lead">{requestTitle(request)}</p>
          <fieldset>
            <legend class="field__label">Причина</legend>
            <div class="choice choice--list">
              {DECLINE_REASONS.map((r) => (
                <label class="choice__item" key={r.code}>
                  <input type="radio" name="reason" value={r.code} checked={reason === r.code} onChange={() => setReason(r.code)} />
                  <span class="choice__box">
                    <span class="choice__title">{r.label}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <p class="hint">Гость увидит, что заявка отклонена, а стол снова станет свободным.</p>
          <ErrorNote error={error} />
          <div class="dialog__actions">
            <button type="submit" class="btn btn--danger btn--block btn--lg" disabled={busy}>
              {busy ? 'Отклоняем…' : 'Отклонить заявку'}
            </button>
            <button type="button" class="btn btn--quiet btn--block" onClick={onClose}>
              Не отклонять
            </button>
          </div>
        </form>
      ) : null}
    </Dialog>
  );
}
