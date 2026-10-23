import { useEffect, useState } from 'preact/hooks';
import { Icon } from '../components/Icon.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { BotCode } from '../components/BotCode.jsx';
import { Ill } from '../components/Ill.jsx';
import { useLoginMethods } from '../components/hooks.js';
import { loginChoice } from '@billiardum/shared/api';
import { DEV_LOGIN } from '../lib/env.js';
import { startBotLink, pendingBotLink, checkBotLink, cancelBotLink, devLogin, normalizePhone } from '../lib/auth.js';

const CHANNELS = {
  max: { name: 'MAX', open: 'Открыть MAX' },
  telegram: { name: 'Telegram', open: 'Открыть Telegram' },
};

/**
 * Вход через бота мессенджера (decisions №49, ревью входа п. 2): ссылка открывает бота, гость
 * отправляет ему код с этого экрана (6 цифр; три неверных — ссылка сгорает) и при первом входе
 * нажимает «Поделиться контактом». Приложение узнаёт об этом опросом.
 * В разработке — вход по телефону (POST /api/auth/dev).
 */
export function SignIn({ onDone, title = 'Войдите, чтобы оплатить' }) {
  const [link, setLink] = useState(() => pendingBotLink());
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [expired, setExpired] = useState(false);
  // U1: только настроенные на сервере способы входа; not_configured на кнопку — убираем её
  const methods = useLoginMethods();
  const [unavailable, setUnavailable] = useState([]);

  // Опрос статуса, пока гость в мессенджере. Сразу проверяем и при возвращении во вкладку.
  useEffect(() => {
    if (!link) return undefined;
    let stopped = false;
    let timer;
    const poll = async () => {
      try {
        const status = await checkBotLink(link.nonce);
        if (stopped) return;
        if (status === 'done') {
          onDone?.();
          return;
        }
        if (status === 'expired') {
          setLink(null);
          setExpired(true);
          return;
        }
        setError(null);
      } catch (err) {
        if (!stopped) setError(err);
      }
      if (!stopped) timer = setTimeout(poll, 2000);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer);
        poll();
      }
    };
    timer = setTimeout(poll, 1500);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [link?.nonce]);

  const start = async (channel) => {
    setBusy(channel);
    setError(null);
    setExpired(false);
    try {
      const res = await startBotLink(channel);
      setLink({ ...res, channel });
    } catch (err) {
      if (err?.code === 'not_configured') setUnavailable((u) => [...u, channel]);
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  if (link) {
    const ch = CHANNELS[link.channel] ?? CHANNELS.max;
    return (
      <section class="step" aria-labelledby="signin-title">
        <h2 class="step__title" id="signin-title">
          Подтвердите номер в {ch.name}
        </h2>
        <BotCode code={link.code} />
        <ol class="howto">
          <li>Откройте бота «Бильярдум» в {ch.name} по кнопке ниже.</li>
          <li>{link.code ? 'Отправьте боту код с этого экрана.' : 'Следуйте подсказкам бота.'}</li>
          <li>Если бот попросит, нажмите «Поделиться контактом».</li>
          <li>Вернитесь сюда — продолжим сами.</li>
        </ol>
        <a class="btn btn--primary btn--block btn--lg" href={link.deep_link} target="_blank" rel="noopener noreferrer">
          {ch.open}
          <Icon name="external" />
        </a>
        <p class="waiting" role="status">
          <span class="waiting__dot" aria-hidden="true" />
          Ждём подтверждения из {ch.name}…
        </p>
        <ErrorNote error={error} />
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
      </section>
    );
  }

  const choice = loginChoice(methods ?? null, { devBuild: DEV_LOGIN, unavailable });
  if (methods === undefined) {
    return (
      <section class="step" aria-labelledby="signin-title" aria-busy="true">
        <h2 class="step__title" id="signin-title">
          {title}
        </h2>
        <p class="muted loading">Проверяем способы входа…</p>
      </section>
    );
  }
  if (choice.empty) {
    return (
      <section class="step empty" aria-labelledby="signin-title">
        <Ill name="lamp" />
        <h2 class="step__title" id="signin-title">
          Вход временно недоступен
        </h2>
        <p class="hint">Обратитесь на ресепшн клуба.</p>
      </section>
    );
  }

  return (
    <section class="step" aria-labelledby="signin-title">
      <h2 class="step__title" id="signin-title">
        {title}
      </h2>
      {choice.channels.length ? (
        <p class="hint">
          Номер телефона нужен для чека и напоминаний о конце игры. Подтвердите его в мессенджере: бот попросит код с этого экрана.
        </p>
      ) : null}
      {expired ? (
        <div class="note" role="status">
          <Icon name="clock" />
          <p class="note__title">Вход не подтверждён.</p>
          <p class="note__body">Ссылка устарела или код трижды ввели неверно. Нажмите кнопку ещё раз — покажем новый код.</p>
        </div>
      ) : null}
      {choice.channels.length ? (
        <div class="stack">
          {choice.channels.map((c, i) => (
            <button key={c} type="button" class={`btn ${i === 0 ? 'btn--primary' : 'btn--secondary'} btn--block btn--lg`} disabled={Boolean(busy)} onClick={() => start(c)}>
              {busy === c ? `Открываем ${CHANNELS[c].name}…` : `Войти через ${CHANNELS[c].name}`}
            </button>
          ))}
        </div>
      ) : null}
      {/* not_configured уже убрал кнопку — техническое сообщение не показываем */}
      {error?.code === 'not_configured' ? null : <ErrorNote error={error} />}
      {choice.dev ? <DevLogin onDone={onDone} /> : null}
    </section>
  );
}

function DevLogin({ onDone }) {
  const [phone, setPhone] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const normalized = normalizePhone(phone);
    setInvalid(!normalized);
    if (!normalized) return;
    setBusy(true);
    setError(null);
    try {
      await devLogin(normalized);
      onDone?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="devlogin" onSubmit={submit} noValidate>
      <p class="devlogin__tag">Только для разработки</p>
      <div class="field">
        <label class="field__label" for="dev-phone">
          Телефон
        </label>
        <input
          class="field__input"
          id="dev-phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="+7 900 000-00-00"
          value={phone}
          aria-invalid={invalid ? 'true' : undefined}
          aria-describedby={invalid ? 'dev-phone-err' : 'dev-phone-hint'}
          onInput={(e) => setPhone(e.currentTarget.value)}
        />
        {invalid ? (
          <p class="field__error" id="dev-phone-err">
            Введите российский номер: +7 и 10 цифр.
          </p>
        ) : (
          <p class="field__hint" id="dev-phone-hint">
            Вход без бота: POST /api/auth/dev, в проде его нет.
          </p>
        )}
      </div>
      <button type="submit" class="btn btn--quiet btn--block" disabled={busy}>
        {busy ? 'Входим…' : 'Войти по номеру'}
      </button>
      <ErrorNote error={error} />
    </form>
  );
}
