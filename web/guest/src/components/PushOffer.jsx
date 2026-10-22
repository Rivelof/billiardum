import { useState } from 'preact/hooks';
import { Icon } from './Icon.jsx';
import { pushAvailability } from '../lib/platform.js';
import { subscribePush } from '../lib/push.js';
import { local } from '../lib/store.js';

const DISMISSED = 'bl-push-dismissed';

/**
 * Предложение напоминаний Web Push на экране «Игра». В уведомлении только стол и время (decisions №53).
 * На iPhone без «На экран Домой» Web Push не работает — там подсказка на экране чека после первой игры.
 */
export function PushOffer() {
  const [state, setState] = useState(() => (local.get(DISMISSED) ? 'hidden' : pushAvailability()));
  const [busy, setBusy] = useState(false);

  if (state !== 'ok' && state !== 'done' && state !== 'denied-now' && state !== 'failed') return null;

  const enable = async () => {
    setBusy(true);
    try {
      setState((await subscribePush()) === 'done' ? 'done' : 'denied-now');
    } catch {
      setState('failed');
    } finally {
      setBusy(false);
    }
  };

  if (state === 'done') {
    return (
      <p class="note note--free" role="status">
        <Icon name="check" />
        <span class="note__title">Напоминания включены: за 10 минут и за минуту до конца.</span>
      </p>
    );
  }

  return (
    <section class="note push" aria-labelledby="push-title">
      <Icon name="bell" />
      <h2 class="note__title" id="push-title">
        Напомнить о конце игры?
      </h2>
      <p class="note__body">
        {state === 'denied-now'
          ? 'Уведомления запрещены в настройках браузера. Разрешите их для этого сайта и нажмите кнопку ещё раз.'
          : state === 'failed'
            ? 'Не получилось включить напоминания. Попробуйте ещё раз — а сигнал у стола сработает в любом случае.'
            : 'Пришлём уведомление за 10 минут и за минуту до конца. В нём только номер стола и время.'}
      </p>
      <div class="note__actions">
        <button type="button" class="btn btn--secondary btn--sm" disabled={busy} onClick={enable}>
          {busy ? 'Включаем…' : 'Включить напоминания'}
        </button>
        <button
          type="button"
          class="btn btn--link"
          onClick={() => {
            local.set(DISMISSED, '1');
            setState('hidden');
          }}
        >
          Не надо
        </button>
      </div>
    </section>
  );
}
