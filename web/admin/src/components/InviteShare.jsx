import { useState } from 'preact/hooks';
import { Icon } from './Icon.jsx';
import { canWebShare, inviteShare } from '../lib/onboarding.js';

/** Скопировать текст: Clipboard API, иначе выделение и execCommand (старые WebView). */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'visually-hidden';
    document.body.append(area);
    area.select();
    let ok;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

/** Кнопка «Скопировать» с ответом словом рядом (для диктора — role=status). */
export function CopyButton({ text, label = 'Скопировать', class: cls = 'btn btn--secondary' }) {
  const [state, setState] = useState(null);
  return (
    <>
      <button
        type="button"
        class={cls}
        onClick={async () => {
          setState((await copyText(text)) ? 'ok' : 'fail');
          setTimeout(() => setState(null), 4000);
        }}
      >
        <Icon name={state === 'ok' ? 'check' : 'copy'} />
        {state === 'ok' ? 'Скопировано' : label}
      </button>
      <span class="visually-hidden" role="status">
        {state === 'ok' ? 'Скопировано' : state === 'fail' ? 'Не получилось скопировать — выделите текст и скопируйте вручную.' : ''}
      </span>
      {state === 'fail' ? <span class="small field__error">Не получилось скопировать — выделите текст и скопируйте вручную.</span> : null}
    </>
  );
}

/**
 * Приглашение сотрудника ссылкой (№158): SMS нет, владелец сам отправляет текст в мессенджер.
 * «Поделиться» — Web Share (телефон), «Скопировать» — везде.
 */
export function InviteShare({ invite, title = 'Отправьте приглашение сотруднику' }) {
  const share = inviteShare(invite);
  if (!share) return null;
  const data = { title: 'Приглашение в Бильярдум', text: share.text, ...(share.url && !share.text.includes(share.url) ? { url: share.url } : {}) };
  const sharable = canWebShare(globalThis.navigator, data);
  return (
    <section class="panel invite" aria-labelledby="invite-share-title">
      <h3 class="section-title" id="invite-share-title">
        {title}
      </h3>
      <p class="hint">SMS мы не отправляем. Перешлите этот текст сотруднику в мессенджер — он войдёт со своего телефона, и доступ откроется сам.</p>
      <p class="invite__text" id="invite-text">
        {share.text}
      </p>
      <div class="row">
        {sharable ? (
          <button
            type="button"
            class="btn btn--primary"
            onClick={() => {
              navigator.share(data).catch(() => {});
            }}
          >
            <Icon name="share" />
            Поделиться
          </button>
        ) : null}
        <CopyButton text={share.text} class={sharable ? 'btn btn--secondary' : 'btn btn--primary'} />
      </div>
    </section>
  );
}
