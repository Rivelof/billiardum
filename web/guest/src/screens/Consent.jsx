import { useState } from 'preact/hooks';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { giveConsent } from '../lib/auth.js';
import { BASE } from '../lib/env.js';
import { consentCopy } from '../lib/consent.js';

/**
 * Согласие на обработку персональных данных — отдельным флажком при первом входе (PRODUCT §11, 152‑ФЗ).
 * Без согласия денежные операции невозможны (consent_required). Тексты — по сценарию (intent): оплата,
 * присоединение к игре, очередь, бронь.
 */
export function Consent({ onDone, intent = 'start' }) {
  const copy = consentCopy(intent);
  const [checked, setChecked] = useState(false);
  const [showError, setShowError] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!checked) {
      setShowError(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await giveConsent();
      onDone?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="step" onSubmit={submit} noValidate aria-labelledby="consent-title">
      <h2 class="step__title" id="consent-title">
        Согласие на обработку данных
      </h2>
      <p class="hint">{copy.why}</p>
      <label class="check">
        <input
          type="checkbox"
          checked={checked}
          aria-invalid={showError && !checked ? 'true' : undefined}
          aria-describedby={showError && !checked ? 'consent-err' : undefined}
          onChange={(e) => {
            setChecked(e.currentTarget.checked);
            if (e.currentTarget.checked) setShowError(false);
          }}
        />
        <span>
          Даю согласие на обработку моих персональных данных по{' '}
          <a href={`${BASE}privacy`} target="_blank" rel="noopener">
            политике обработки данных
          </a>
        </span>
      </label>
      {showError && !checked ? (
        <p class="field__error" id="consent-err" role="alert">
          {copy.required}
        </p>
      ) : null}
      <ErrorNote error={error} />
      <div class="actionbar">
        <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
          {busy ? 'Сохраняем…' : copy.cta}
        </button>
      </div>
    </form>
  );
}
