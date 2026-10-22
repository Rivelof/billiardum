import { useState } from 'preact/hooks';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { giveConsent } from '../lib/auth.js';
import { BASE } from '../lib/env.js';

/**
 * Согласие на обработку персональных данных — отдельным флажком при первом входе (PRODUCT §11, 152‑ФЗ).
 * Без согласия денежные операции невозможны (consent_required).
 */
export function Consent({ onDone }) {
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
      <p class="hint">
        Мы храним номер телефона и историю игр на серверах в России. Они нужны для оплаты, чеков и напоминаний о конце игры.
      </p>
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
          Отметьте флажок: без согласия оплата недоступна.
        </p>
      ) : null}
      <ErrorNote error={error} />
      <div class="actionbar">
        <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
          {busy ? 'Сохраняем…' : 'Продолжить к оплате'}
        </button>
      </div>
    </form>
  );
}
