import { useEffect, useState } from 'preact/hooks';
import { Icon } from '../components/Icon.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { api, getTerminal } from '../lib/api.js';
import { pinSwitch } from '../lib/auth.js';
import { pinErrorKind } from '../lib/terminals.js';
import { navigate, linkHandler } from '../lib/router.js';
import { BASE } from '../lib/env.js';
import { ROLE_LABEL } from '../lib/words.js';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'];

const PIN_ERROR_TEXT = {
  pin_wrong: 'PIN не подошёл. После 5 ошибок подряд PIN блокируется на 15 минут.',
  pin_locked: 'PIN заблокирован на 15 минут после 5 ошибок. Войдите через мессенджер или подождите.',
  terminal_locked: 'Терминал заблокирован: на нём много раз ввели неверный PIN. Войдите через мессенджер; владелец разблокирует терминал в разделе «Персонал → Терминалы».',
};


/** Имя сотрудника (§14), пока его нет — маска телефона; роль — второй строкой. */
function staffLabel(u) {
  return u.name || u.phone_masked || ROLE_LABEL[u.role] || 'Сотрудник';
}

/**
 * Быстрая смена сотрудника по PIN на зарегистрированном терминале (контракт §4):
 * PIN 4–6 цифр; 5 ошибок подряд блокируют PIN на 15 минут — это делает сервер.
 */
export function Pin() {
  const terminal = getTerminal();
  const [users, setUsers] = useState(null);
  const [who, setWho] = useState(null);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Вошёл владелец или управляющий с коротким PIN — сначала просим сменить его на 6 цифр
  const [changePin, setChangePin] = useState(false);

  useEffect(() => {
    if (!terminal) return;
    // GET /api/staff/terminal → [{ user_id, name, role, phone_masked, pin_set }] (§14) или { terminal, staff: […] }
    api
      .terminalInfo()
      .then((info) => setUsers(Array.isArray(info) ? info : Array.isArray(info?.staff) ? info.staff : []))
      .catch(setError);
  }, []);

  const submit = async (value = pin) => {
    if (value.length < 4) return;
    setBusy(true);
    setError(null);
    try {
      const { pinChangeRequired } = await pinSwitch(who.user_id, value);
      if (pinChangeRequired) {
        setChangePin(true);
        return;
      }
      navigate(BASE, { replace: true });
    } catch (err) {
      setPin('');
      setError(pinErrorKind(err));
    } finally {
      setBusy(false);
    }
  };

  const press = (k) => {
    if (busy) return;
    if (k === 'back') return setPin((p) => p.slice(0, -1));
    if (k === 'clear') return setPin('');
    setPin((p) => (p.length < 6 ? p + k : p));
  };

  if (changePin) {
    return (
      <main class="signin" data-theme="dark">
        <div class="signin__card">
          <p class="signin__brand display">Бильярдум</p>
          <h1 class="signin__title">Смените PIN на 6 цифр</h1>
          <div class="note note--lamp">
            <Icon name="key" />
            <p class="note__title">Ваш PIN короче 6 цифр</p>
            <p class="note__body">
              У владельца и управляющего PIN — ровно 6 цифр: им подтверждают скидки выше лимита на кассе. Войдите со своего телефона через мессенджер и задайте новый PIN в
              разделе «Ещё».
            </p>
          </div>
          <button type="button" class="btn btn--primary btn--block btn--lg" onClick={() => navigate(BASE, { replace: true })}>
            Понятно, продолжить
          </button>
        </div>
      </main>
    );
  }

  if (!terminal) {
    return (
      <main class="signin" data-theme="dark">
        <div class="signin__card">
          <h1 class="signin__title">Это устройство не терминал</h1>
          <p class="hint">Смена по PIN работает только на планшете ресепшена, который владелец или управляющий зарегистрировал в разделе «Ещё».</p>
          <a class="btn btn--primary btn--block" href={`${BASE}signin`} onClick={linkHandler}>
            Войти через мессенджер
          </a>
        </div>
      </main>
    );
  }

  return (
    <main class="signin" data-theme="dark">
      <div class="signin__card signin__card--wide">
        <p class="signin__brand display">Бильярдум</p>
        <h1 class="signin__title">{who ? `PIN: ${staffLabel(who)}` : `Кто работает? Терминал «${terminal.name}»`}</h1>
        {!who ? (
          <>
            {users === null && !error ? <p class="muted loading">Загружаем сотрудников…</p> : null}
            <ul class="staff">
              {(users ?? []).map((u) => (
                <li key={u.user_id}>
                  <button type="button" class="staff__btn" disabled={u.pin_set === false} onClick={() => setWho(u)}>
                    <Icon name="user" />
                    <span>
                      <span class="staff__name">{staffLabel(u)}</span>
                      <span class="staff__role">
                        {ROLE_LABEL[u.role] ?? ''}
                        {u.pin_set === false ? ' · PIN не задан: войдите через мессенджер и задайте его в «Ещё»' : ''}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <ErrorNote error={error} />
          </>
        ) : (
          <form
            class="pinform"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <label class="visually-hidden" for="pin">
              PIN сотрудника, от 4 до 6 цифр
            </label>
            <input
              id="pin"
              class="pin__input mono"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              value={pin}
              onInput={(e) => setPin(e.currentTarget.value.replace(/\D/g, '').slice(0, 6))}
            />
            <div class="pin__dots" aria-hidden="true">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <span key={i} class={`pin__dot${i < pin.length ? ' pin__dot--on' : ''}`} />
              ))}
            </div>
            {PIN_ERROR_TEXT[error] ? (
              <p class="field__error" role="alert">
                {PIN_ERROR_TEXT[error]}
              </p>
            ) : (
              <ErrorNote error={error} />
            )}
            <div class="keypad keypad--pin" role="group" aria-label="Цифры PIN">
              {KEYS.map((k) => (
                <button
                  type="button"
                  key={k}
                  class="keypad__key"
                  onClick={() => press(k)}
                  aria-label={k === 'back' ? 'Стереть цифру' : k === 'clear' ? 'Очистить' : undefined}
                >
                  {k === 'back' ? <Icon name="erase" /> : k === 'clear' ? <Icon name="close" /> : k}
                </button>
              ))}
            </div>
            <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy || pin.length < 4}>
              {busy ? 'Проверяем…' : 'Войти'}
            </button>
            <button
              type="button"
              class="btn btn--link"
              onClick={() => {
                setWho(null);
                setPin('');
                setError(null);
              }}
            >
              Другой сотрудник
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
