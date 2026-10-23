import { errorMessage } from '@billiardum/shared/errors';
import { formatTime } from '@billiardum/shared/format';
import { lastClub } from '../lib/flow.js';
import { Icon } from './Icon.jsx';

/** Ошибка словами: что случилось и что делать. role=alert — диктор прочтёт сразу. */
export function ErrorNote({ error, busyUntil, limitUntil, children, class: cls = '' }) {
  if (!error) return null;
  // busy_until из ответа (стол занят, в т. ч. турниром) — временем клуба, если экран не передал своё
  let until = busyUntil;
  if (!until && error?.data?.busy_until) {
    try {
      until = formatTime(error.data.busy_until, lastClub()?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch {
      until = undefined;
    }
  }
  const msg = errorMessage(error, { audience: 'guest', busyUntil: until, limitUntil });
  return (
    <div class={`note note--error ${cls}`} role="alert">
      <Icon name="alert" />
      <p class="note__title">{msg.title}</p>
      <p class="note__body">{msg.action}</p>
      {children ? <div class="note__actions">{children}</div> : null}
    </div>
  );
}
