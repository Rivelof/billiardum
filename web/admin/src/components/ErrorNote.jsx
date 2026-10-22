import { errorMessage } from '@billiardum/shared/errors';
import { Icon } from './Icon.jsx';

/** Ошибка для персонала: что случилось, что делать и код для поддержки мелко. */
export function ErrorNote({ error, children, class: cls = '' }) {
  if (!error) return null;
  const msg = errorMessage(error, { audience: 'staff' });
  return (
    <div class={`note note--error ${cls}`} role="alert">
      <Icon name="alert" />
      <p class="note__title">{msg.title}</p>
      <p class="note__body">
        {msg.action} <span class="small">Код: {msg.code}</span>
      </p>
      {children ? <div class="note__actions">{children}</div> : null}
    </div>
  );
}
