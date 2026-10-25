import { errorMessage } from '@billiardum/shared/errors';
import { formatTime } from '@billiardum/shared/format';
import { lastClub } from '../lib/flow.js';
import { Icon } from './Icon.jsx';

/**
 * Ошибка словами: что случилось и что делать. role=alert — диктор прочтёт сразу.
 * resource — ресурс экрана (M5.8): у корта тексты со словом «корт»; playersLimit — предел «Я играю» (max_players).
 */
export function ErrorNote({ error, busyUntil, limitUntil, timeZone, resource, playersLimit, children, class: cls = '' }) {
  if (!error) return null;
  // busy_until из ответа (стол занят, в т. ч. турниром: «Стол занят турниром до 21:30») — временем клуба:
  // пояс экрана (timeZone), иначе последнего клуба, иначе устройства
  let until = busyUntil;
  if (!until && error?.data?.busy_until) {
    try {
      until = formatTime(error.data.busy_until, timeZone || lastClub()?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch {
      until = undefined;
    }
  }
  const ctx = { audience: 'guest', busyUntil: until, limitUntil };
  if (resource) ctx.family = resource;
  if (Number.isInteger(playersLimit)) ctx.playersLimit = playersLimit;
  const msg = errorMessage(error, ctx);
  return (
    <div class={`note note--error ${cls}`} role="alert">
      <Icon name="alert" />
      <p class="note__title">{msg.title}</p>
      <p class="note__body">{msg.action}</p>
      {children ? <div class="note__actions">{children}</div> : null}
    </div>
  );
}
