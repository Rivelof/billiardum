import { errorMessage } from '@billiardum/shared/errors';
import { Icon } from './Icon.jsx';

/** Ошибка словами: что случилось и что делать. role=alert — диктор прочтёт сразу. */
export function ErrorNote({ error, busyUntil, children, class: cls = '' }) {
  if (!error) return null;
  const msg = errorMessage(error, { audience: 'guest', busyUntil });
  return (
    <div class={`note note--error ${cls}`} role="alert">
      <Icon name="alert" />
      <p class="note__title">{msg.title}</p>
      <p class="note__body">{msg.action}</p>
      {children ? <div class="note__actions">{children}</div> : null}
    </div>
  );
}
