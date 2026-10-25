import { useEffect, useState } from 'preact/hooks';
import { Icon } from './Icon.jsx';
import { Dialog } from './Dialog.jsx';
import { ErrorNote } from './ErrorNote.jsx';
import { api } from '../lib/api.js';
import { productsWord, reasonError, REASON_MAX } from '../lib/networkBase.js';

/**
 * Сеть клуба (M5.5, GET /api/clubs/{club}/network): { network: null | {...} }. undefined — грузим.
 * Ошибка — считаем, что сети нет: экран клуба работает как раньше, сервер всё равно проверит шаблон (409 network_locked).
 */
export function useClubNetwork(clubId) {
  const [net, setNet] = useState(undefined);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    api
      .clubNetwork(clubId)
      .then((r) => alive && setNet(r?.network && typeof r.network === 'object' ? r.network : null))
      .catch(() => alive && setNet(null));
    return () => {
      alive = false;
    };
  }, [clubId, tick]);
  return [net, () => setTick((t) => t + 1)];
}

const TEXT = {
  tariffs: {
    locked: (n) => `Тарифы клуба задаёт сеть «${n}»: шаблон жёсткий. Изменить их может владелец сети в разделе «Сеть».`,
    override: (n) => `Клуб работает по своим тарифам. Новые версии шаблона сети «${n}» их не меняют, пока вы не вернёте клуб к шаблону.`,
    follows: (n) => `Тарифы клуба — из шаблона сети «${n}». Если сохраните свои, клуб перестанет получать новые версии шаблона, пока вы не вернёте его к шаблону.`,
    confirm: 'Тарифы клуба заменятся шаблоном сети. Свои тарифы клуба перестанут действовать сразу.',
    title: 'Вернуть тарифы к шаблону сети',
  },
  menu: {
    locked: (n) => `Товары шаблона сети «${n}» клуб не меняет: шаблон жёсткий. Стоп-лист, склад, фото и модификаторы вы ведёте сами, свои товары клуба — тоже.`,
    override: (n, count) => `Изменено в клубе: ${count}. Такие товары шаблон сети «${n}» больше не меняет, пока вы не вернёте меню к шаблону. Признак алкоголя у товаров сети клуб не снимает.`,
    follows: (n) => `Товары с отметкой «Шаблон сети» приходят из сети «${n}». Поменяете у такого товара цену или название — шаблон его больше не тронет. Признак алкоголя у товаров сети клуб не снимает.`,
    confirm: 'Товары шаблона вернутся к названиям, ценам и категориям сети. Стоп-лист, остатки и свои товары клуба не изменятся.',
    title: 'Вернуть меню к шаблону сети',
  },
};

/**
 * Плашка «шаблон сети» на тарифах и в меню клуба (№191): жёсткий — правка недоступна с объяснением, мягкий
 * и переопределено — «Изменено в клубе» и «Вернуть к шаблону» (POST …/network/reset, в боевом режиме — с причиной).
 * id — для aria-describedby у неактивных кнопок правки.
 */
export function NetworkNote({ clubId, network, scope, live, id, onReset }) {
  const [open, setOpen] = useState(false);
  const part = network?.[scope];
  if (!network || !part?.template) return null;
  const t = TEXT[scope];
  const overrides = scope === 'menu' ? Number(part.overrides) || 0 : part.override ? 1 : 0;
  const state = part.locked ? 'locked' : overrides > 0 ? 'override' : 'follows';
  const text = state === 'override' ? t.override(network.name, productsWord(overrides)) : t[state](network.name);
  return (
    <div class={`note netnote${state === 'locked' ? ' note--lamp' : ''}`} id={id}>
      <Icon name={state === 'locked' ? 'lock' : 'chain'} />
      <p class="note__title netnote__title">
        <span class="nbadge nbadge--net">
          <Icon name="chain" />
          Шаблон сети
        </span>
        {state === 'locked' ? (
          <span class="nbadge">
            <Icon name="lock" />
            Жёсткий шаблон
          </span>
        ) : null}
        {state === 'override' ? (
          <span class="nbadge nbadge--own">
            <Icon name="edit" />
            Изменено в клубе
          </span>
        ) : null}
      </p>
      <p class="note__body">{text}</p>
      {state === 'override' ? (
        <div class="note__actions">
          <button type="button" class="btn btn--secondary btn--sm" onClick={() => setOpen(true)}>
            <Icon name="refresh" />
            Вернуть к шаблону сети
          </button>
        </div>
      ) : null}
      <ResetDialog open={open} clubId={clubId} scope={scope} live={live} title={t.title} text={t.confirm} onClose={() => setOpen(false)} onDone={(res) => {
        setOpen(false);
        onReset?.(res);
      }} />
    </div>
  );
}

function ResetDialog({ open, clubId, scope, live, title, text, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!open) return;
    setReason('');
    setTried(false);
    setError(null);
  }, [open]);
  const rErr = reasonError(reason, live);
  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (rErr) {
      document.getElementById(`nr-reason-${scope}`)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onDone(await api.resetClubNetwork(clubId, scope, reason.trim() || undefined));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={title} labelledBy={`nr-title-${scope}`}>
      <form class="form" onSubmit={submit} noValidate>
        <p>{text}</p>
        {live ? (
          <div class="field">
            <label class="field__label" for={`nr-reason-${scope}`}>
              Причина
            </label>
            <textarea id={`nr-reason-${scope}`} class="field__input field__input--area" rows={2} maxLength={REASON_MAX} value={reason} aria-invalid={tried && rErr ? 'true' : undefined} aria-describedby={`nr-reason-${scope}-e`} onInput={(ev) => setReason(ev.currentTarget.value)} />
            <p class={tried && rErr ? 'field__error' : 'field__hint'} id={`nr-reason-${scope}-e`}>
              {tried && rErr ? 'Клуб в боевом режиме: без причины не вернуть.' : 'Клуб в боевом режиме: причина уйдёт в журнал и владельцу в уведомлении.'}
            </p>
          </div>
        ) : null}
        <ErrorNote error={error} />
        <div class="row">
          <button type="submit" class="btn btn--primary" disabled={busy}>
            {busy ? 'Возвращаем…' : 'Вернуть к шаблону'}
          </button>
          <button type="button" class="btn btn--quiet" onClick={onClose}>
            Оставить как есть
          </button>
        </div>
      </form>
    </Dialog>
  );
}
