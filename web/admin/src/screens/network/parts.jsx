import { useEffect, useState } from 'preact/hooks';
import { Icon } from '../../components/Icon.jsx';
import { Dialog } from '../../components/Dialog.jsx';
import { ErrorNote } from '../../components/ErrorNote.jsx';
import { api } from '../../lib/api.js';
import { CLUB_MODE_LABEL, MODE_HINT, MODE_LABEL, REASON_MAX, isLive, reasonError, withReason } from '../../lib/networks.js';

/* Общие части экрана «Сеть» (M5.5): бейдж режима клуба, подтверждение, причина, режим шаблона. */

/** Бейдж режима клуба словом (статус не только цветом). */
export function ClubModeBadge({ mode }) {
  const live = mode === 'live';
  return (
    <span class={`nbadge${live ? ' nbadge--live' : mode === 'test' ? ' nbadge--test' : ''}`}>
      <Icon name={live ? 'check' : mode === 'test' ? 'flask' : 'alert'} />
      {CLUB_MODE_LABEL[mode] ?? 'Режим неизвестен'}
    </span>
  );
}

/** Подтверждение необратимого или заметного действия: что произойдёт — словами, кнопка говорит действие. */
export function ConfirmDialog({ open, title, children, action, danger = false, reasonNeeded = false, onClose, run, labelId }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setReason('');
    setTried(false);
  }, [open]);
  const rErr = reasonError(reason, reasonNeeded);
  const go = async (e) => {
    e.preventDefault();
    setTried(true);
    if (rErr) {
      document.getElementById(`${labelId}-reason`)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await run(reason.trim());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={title} labelledBy={labelId}>
      <form class="form" onSubmit={go} noValidate>
        {children}
        {reasonNeeded ? <ReasonField id={`${labelId}-reason`} value={reason} onInput={setReason} error={tried ? rErr : null} /> : null}
        <ErrorNote error={error} />
        <div class="row">
          <button type="submit" class={`btn ${danger ? 'btn--danger' : 'btn--primary'}`} disabled={busy}>
            {busy ? 'Минуту…' : action}
          </button>
          <button type="button" class="btn btn--quiet" onClick={onClose}>
            Отменить
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Поле причины ручного действия в боевом режиме (инвариант 8). */
export function ReasonField({ id, value, onInput, error, label = 'Причина', hint = 'Уйдёт в журнал каждого боевого клуба и владельцу в уведомлении.' }) {
  return (
    <div class="field">
      <label class="field__label" for={id}>
        {label}
      </label>
      <textarea id={id} class="field__input field__input--area" rows={2} maxLength={REASON_MAX} value={value} aria-invalid={error ? 'true' : undefined} aria-describedby={`${id}-e`} onInput={(e) => onInput(e.currentTarget.value)} />
      <p class={error ? 'field__error' : 'field__hint'} id={`${id}-e`}>
        {error ?? hint}
      </p>
    </div>
  );
}

// ---------- режим шаблона (в разделах «Тарифы» и «Меню») ----------

/**
 * Мягкий или жёсткий шаблон (№191). Переход в жёсткий возвращает к шаблону переопределившие клубы — в боевых это
 * ручное действие: причина обязательна (PATCH /api/networks/{id} { tariffs_mode | menu_mode, reason }).
 */
export function ModeBlock({ n, scope, rights, onNetwork }) {
  const key = scope === 'tariffs' ? 'tariffs_mode' : 'menu_mode';
  const [mode, setMode] = useState(n[key] ?? 'soft');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => setMode(n[key] ?? 'soft'), [n[key]]);
  const changed = mode !== (n[key] ?? 'soft');
  const live = (n.clubs ?? []).filter(isLive);
  const needReason = changed && mode === 'hard' && live.length > 0 && Boolean(n[scope]?.template);
  const rErr = reasonError(reason, needReason);
  const name = `${scope}-mode`;
  const save = async (e) => {
    e.preventDefault();
    setTried(true);
    if (rErr) {
      document.getElementById(`${name}-reason`)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await api.updateNetwork(n.id, withReason({ [key]: mode }, reason));
      setReason('');
      setTried(false);
      onNetwork(next, `Шаблон ${scope === 'tariffs' ? 'тарифов' : 'меню'}: ${MODE_LABEL[mode].toLowerCase()} режим.`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="panel nmode" onSubmit={save} noValidate>
      <fieldset class="nmode__set" disabled={!rights.edit}>
        <legend class="section-title">Режим шаблона</legend>
        <div class="nmode__opts">
          {['soft', 'hard'].map((m) => (
            <label class="tw__tpl" key={m}>
              <input type="radio" name={name} checked={mode === m} onChange={() => setMode(m)} />
              <span class="tw__tplbox">
                <span class="tw__tpltitle">
                  <Icon name={m === 'hard' ? 'lock' : 'edit'} /> {MODE_LABEL[m]}
                  {(n[key] ?? 'soft') === m ? <span class="muted"> · сейчас</span> : null}
                </span>
                <span class="tw__tplsub">{MODE_HINT[scope][m]}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {!rights.owner ? <p class="small muted">Режим меняет владелец сети.</p> : null}
      {changed ? (
        <>
          {needReason ? (
            <>
              <p class="note note--lamp">
                <Icon name="alert" />
                <span class="note__title">Боевые клубы вернутся к шаблону</span>
                <span class="note__body">
                  {live.map((c) => c.name ?? 'Клуб').join(', ')}: клубы со своими {scope === 'tariffs' ? 'тарифами' : 'товарами'} сразу вернутся к шаблону. Это ручное действие — владельцу уйдёт уведомление, запись — в журнал каждого клуба.
                </span>
              </p>
              <ReasonField id={`${name}-reason`} value={reason} onInput={setReason} error={tried ? rErr : null} />
            </>
          ) : null}
          <ErrorNote error={error} />
          <div class="row">
            <button type="submit" class="btn btn--primary" disabled={busy || !rights.edit}>
              {busy ? 'Сохраняем…' : mode === 'hard' ? 'Сделать шаблон жёстким' : 'Сделать шаблон мягким'}
            </button>
            <button type="button" class="btn btn--quiet" onClick={() => setMode(n[key] ?? 'soft')}>
              Оставить как было
            </button>
          </div>
        </>
      ) : null}
    </form>
  );
}
