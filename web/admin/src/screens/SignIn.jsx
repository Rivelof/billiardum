import { useEffect, useState } from 'preact/hooks';
import { Icon } from '../components/Icon.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { BotCode } from '../components/BotCode.jsx';
import { useLoginMethods } from '../components/hooks.js';
import { loginChoice } from '@billiardum/shared/api';
import { DEV_LOGIN, BASE } from '../lib/env.js';
import { getTerminal } from '../lib/api.js';
import { startBotLink, pendingBotLink, checkBotLink, cancelBotLink, devLogin, normalizePhone } from '../lib/auth.js';
import { linkHandler } from '../lib/router.js';

const NAME = { max: 'MAX', telegram: 'Telegram' };

/** Вход персонала: телефон через бота MAX или Telegram, в разработке — по номеру; на терминале — смена по PIN. */
export function SignIn() {
  const [link, setLink] = useState(() => pendingBotLink());
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [expired, setExpired] = useState(false);
  // U1: только настроенные на сервере способы входа; not_configured на кнопку — убираем её
  const methods = useLoginMethods();
  const [unavailable, setUnavailable] = useState([]);
  const choice = loginChoice(methods ?? null, { devBuild: DEV_LOGIN, unavailable });
  const terminal = getTerminal();

  useEffect(() => {
    if (!link) return undefined;
    let stopped = false;
    let timer;
    const poll = async () => {
      try {
        const status = await checkBotLink(link.nonce);
        if (stopped || status === 'done') return;
        if (status === 'expired') {
          setLink(null);
          setExpired(true);
          return;
        }
      } catch (err) {
        if (!stopped) setError(err);
      }
      if (!stopped) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 1500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [link?.nonce]);

  const start = async (channel) => {
    setBusy(channel);
    setError(null);
    setExpired(false);
    try {
      setLink(await startBotLink(channel));
    } catch (err) {
      if (err?.code === 'not_configured') setUnavailable((u) => [...u, channel]);
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div class="signin" data-theme="dark">
      <div class="signin__card">
        <p class="signin__brand display">Бильярдум</p>
        <h1 class="signin__title">Вход для персонала клуба</h1>
        {link ? (
          <div class="form">
            <BotCode code={link.code} />
            <p class="lead">
              Откройте бота в {NAME[link.channel]}, отправьте ему этот код, при первом входе нажмите «Поделиться контактом» и вернитесь сюда.
            </p>
            <a class="btn btn--primary btn--block btn--lg" href={link.deep_link} target="_blank" rel="noopener noreferrer">
              Открыть {NAME[link.channel]}
              <Icon name="external" />
            </a>
            <p class="muted" role="status">
              Ждём подтверждения…
            </p>
            <button
              type="button"
              class="btn btn--link"
              onClick={() => {
                cancelBotLink();
                setLink(null);
              }}
            >
              Выбрать другой мессенджер
            </button>
          </div>
        ) : (
          <div class="form">
            {methods === undefined ? (
              <p class="muted loading">Проверяем способы входа…</p>
            ) : choice.channels.length ? (
              <p class="hint">Войдите по номеру телефона, который владелец клуба добавил в персонал. Подтверждение — в мессенджере: бот попросит код с этого экрана.</p>
            ) : choice.empty ? (
              <div class="note" role="status">
                <Icon name="info" />
                <p class="note__title">Вход временно недоступен</p>
                <p class="note__body">{terminal ? 'Через мессенджер войти сейчас нельзя. На этом терминале можно войти по PIN.' : 'Через мессенджер войти сейчас нельзя. Обратитесь к владельцу клуба.'}</p>
              </div>
            ) : null}
            {expired ? (
              <div class="note" role="status">
                <Icon name="clock" />
                <p class="note__title">Вход не подтверждён.</p>
                <p class="note__body">Ссылка устарела или код трижды ввели неверно. Начните заново — покажем новый код.</p>
              </div>
            ) : null}
            {methods === undefined
              ? null
              : choice.channels.map((c, i) => (
                  <button key={c} type="button" class={`btn ${i === 0 ? 'btn--primary' : 'btn--secondary'} btn--block btn--lg`} disabled={Boolean(busy)} onClick={() => start(c)}>
                    {busy === c ? `Открываем ${NAME[c]}…` : `Войти через ${NAME[c]}`}
                  </button>
                ))}
            {terminal ? (
              <a class="btn btn--quiet btn--block btn--lg" href={`${BASE}pin`} onClick={linkHandler}>
                <Icon name="key" />
                Быстрая смена по PIN
              </a>
            ) : null}
          </div>
        )}
        {/* not_configured уже убрал кнопку — техническое сообщение не показываем */}
        {error?.code === 'not_configured' ? null : <ErrorNote error={error} />}
        {methods !== undefined && choice.dev ? <DevLogin /> : null}
      </div>
    </div>
  );
}

function DevLogin() {
  const [phone, setPhone] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    const p = normalizePhone(phone);
    setInvalid(!p);
    if (!p) return;
    setBusy(true);
    setError(null);
    try {
      await devLogin(p);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="devlogin form" onSubmit={submit} noValidate>
      <p class="devlogin__tag">Только для разработки</p>
      <div class="field">
        <label class="field__label" for="dev-phone">
          Телефон сотрудника
        </label>
        <input
          id="dev-phone"
          class="field__input"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="+7 900 000-00-00"
          value={phone}
          aria-invalid={invalid ? 'true' : undefined}
          aria-describedby="dev-phone-hint"
          onInput={(e) => setPhone(e.currentTarget.value)}
        />
        <p class={invalid ? 'field__error' : 'field__hint'} id="dev-phone-hint">
          {invalid ? 'Введите российский номер: +7 и 10 цифр.' : 'POST /api/auth/dev, в проде его нет.'}
        </p>
      </div>
      <button type="submit" class="btn btn--quiet btn--block" disabled={busy}>
        {busy ? 'Входим…' : 'Войти по номеру'}
      </button>
      <ErrorNote error={error} />
    </form>
  );
}
