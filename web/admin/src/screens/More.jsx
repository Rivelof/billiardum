import { useState } from 'preact/hooks';
import { Shell } from '../components/Shell.jsx';
import { Icon } from '../components/Icon.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { api, getTerminal, setTerminal } from '../lib/api.js';
import { auth, can, logout } from '../lib/auth.js';
import { useStore } from '../lib/store.js';
import { navigate, linkHandler } from '../lib/router.js';
import { BASE } from '../lib/env.js';
import { ROLE_LABEL } from '../lib/words.js';

/** «Ещё»: QR-наклейки (PDF), терминал ресепшена, выход. */
export function More({ ctx }) {
  const { club, role, user, timeZone } = ctx;
  const { principal } = useStore(auth);
  return (
    <Shell club={club} role={role} user={user} timeZone={timeZone} active="more" title="Ещё">
      <div class="page more">
        <section class="panel">
          <h2 class="section-title">Вы</h2>
          <NameForm user={user} />
          <p>
            {user?.name ?? user?.phone_masked ?? 'Сотрудник'}, {ROLE_LABEL[role]?.toLowerCase() ?? role}
          </p>
          <button
            type="button"
            class="btn btn--quiet"
            onClick={async () => {
              await logout().catch(() => {});
              navigate(`${BASE}signin`, { replace: true });
            }}
          >
            <Icon name="logout" />
            Выйти
          </button>
        </section>
        {can.devices(role) ? (
          <section class="panel">
            <h2 class="section-title">Контроллеры</h2>
            <p class="hint">На связи ли столы, сигнал, прошивка, «Подсветить стол», привязка нового контроллера.</p>
            <a class="btn btn--secondary" href={`${BASE}c/${encodeURIComponent(club.club_id)}/devices`} onClick={linkHandler}>
              <Icon name="chip" />
              Открыть контроллеры
            </a>
          </section>
        ) : null}
        {can.manage(role) ? <Stickers clubId={club.club_id} /> : null}
        {can.setPin(role) && principal === 'session' ? <SetPin clubId={club.club_id} /> : null}
        {can.terminal(role) ? <Terminal clubId={club.club_id} /> : null}
      </div>
    </Shell>
  );
}

function Stickers({ clubId }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.qrStickers(clubId);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'billiardum-qr-stickers.pdf';
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="panel">
      <h2 class="section-title">QR-наклейки на столы</h2>
      <p class="hint">PDF на A4: по наклейке на каждый стол — QR-код, номер стола и короткий код. Распечатайте и наклейте у стола.</p>
      <ErrorNote error={error} />
      <button type="button" class="btn btn--primary" disabled={busy} onClick={download}>
        <Icon name="download" />
        {busy ? 'Готовим PDF…' : 'Скачать QR-наклейки (PDF)'}
      </button>
    </section>
  );
}

/** Имя сотрудника — им подписаны действия в журнале и выбор на терминале (PATCH /api/me, §14). */
function NameForm({ user }) {
  const [name, setName] = useState(user?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    const value = name.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateMe({ name: value });
      auth.set((s) => ({ user: s.user ? { ...s.user, name: value } : s.user }));
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="form pinset" onSubmit={submit}>
      <div class="field">
        <label class="field__label" for="me-name">
          Ваше имя в программе клуба
        </label>
        <input id="me-name" class="field__input" maxLength={60} autoComplete="name" value={name} onInput={(e) => (setName(e.currentTarget.value), setSaved(false))} />
        <p class="field__hint">Им подписаны ваши действия в журнале и кнопка на терминале ресепшена.</p>
      </div>
      <ErrorNote error={error} />
      <button type="submit" class="btn btn--quiet" disabled={busy || !name.trim()}>
        {busy ? 'Сохраняем…' : saved ? 'Имя сохранено' : 'Сохранить имя'}
      </button>
    </form>
  );
}

/** Сотрудник задаёт себе PIN для быстрой смены на терминале (PUT /api/staff/pin, §14). */
function SetPin({ clubId }) {
  const [pin, setPin] = useState('');
  const [repeat, setRepeat] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const valid = /^\d{4,6}$/.test(pin);
  const same = pin === repeat;

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    if (!valid || !same) return;
    setBusy(true);
    setError(null);
    try {
      await api.setPin(clubId, pin);
      setDone(true);
      setPin('');
      setRepeat('');
      setTouched(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="panel">
      <h2 class="section-title">PIN для терминала</h2>
      <p class="hint">С PIN вы входите на общем планшете ресепшена за секунду, без мессенджера. Каждое действие подписано вашим именем.</p>
      {done ? (
        <p class="note note--free" role="status">
          <Icon name="check" />
          <span class="note__title">PIN сохранён.</span>
        </p>
      ) : null}
      <form class="form pinset" onSubmit={submit} noValidate>
        <div class="field">
          <label class="field__label" for="pin-new">
            Новый PIN, 4–6 цифр
          </label>
          <input
            id="pin-new"
            class="field__input mono"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={6}
            value={pin}
            aria-invalid={touched && !valid ? 'true' : undefined}
            aria-describedby={touched && !valid ? 'pin-new-err' : undefined}
            onInput={(e) => setPin(e.currentTarget.value.replace(/\D/g, '').slice(0, 6))}
          />
          {touched && !valid ? (
            <p class="field__error" id="pin-new-err">
              PIN — от 4 до 6 цифр.
            </p>
          ) : null}
        </div>
        <div class="field">
          <label class="field__label" for="pin-repeat">
            Повторите PIN
          </label>
          <input
            id="pin-repeat"
            class="field__input mono"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={6}
            value={repeat}
            aria-invalid={touched && valid && !same ? 'true' : undefined}
            aria-describedby={touched && valid && !same ? 'pin-repeat-err' : undefined}
            onInput={(e) => setRepeat(e.currentTarget.value.replace(/\D/g, '').slice(0, 6))}
          />
          {touched && valid && !same ? (
            <p class="field__error" id="pin-repeat-err">
              PIN не совпадает.
            </p>
          ) : null}
        </div>
        <ErrorNote error={error} />
        <button type="submit" class="btn btn--primary" disabled={busy}>
          {busy ? 'Сохраняем…' : 'Сохранить PIN'}
        </button>
      </form>
    </section>
  );
}

function Terminal({ clubId }) {
  const [terminal, setTerm] = useState(getTerminal);
  const [name, setName] = useState('Ресепшн');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const register = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.registerTerminal(clubId, name.trim() || 'Ресепшн');
      const value = { token: res.terminal_token, id: res.terminal_id ?? null, name: name.trim() || 'Ресепшн', club_id: clubId, expires_at: res.expires_at ?? null };
      setTerminal(value);
      setTerm(value);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="panel">
      <h2 class="section-title">Терминал ресепшена</h2>
      {terminal ? (
        <>
          <p>
            Это устройство — терминал «{terminal.name}». Сотрудники меняются на нём по PIN без входа через бота.
          </p>
          <div class="row">
            <a class="btn btn--secondary" href={`${BASE}pin`} onClick={linkHandler}>
              <Icon name="key" />
              Сменить сотрудника по PIN
            </a>
            <button
              type="button"
              class="btn btn--quiet"
              onClick={() => {
                setTerminal(null);
                setTerm(null);
              }}
            >
              Забыть терминал на этом устройстве
            </button>
          </div>
        </>
      ) : (
        <form class="form" onSubmit={register}>
          <p class="hint">Сделайте общий планшет ресепшена терминалом: сотрудники будут меняться на нём по PIN, каждое действие подписано своим именем.</p>
          <div class="field">
            <label class="field__label" for="term-name">
              Название терминала
            </label>
            <input id="term-name" class="field__input" value={name} maxLength={40} onInput={(e) => setName(e.currentTarget.value)} />
          </div>
          <ErrorNote error={error} />
          <button type="submit" class="btn btn--primary" disabled={busy}>
            {busy ? 'Регистрируем…' : 'Сделать это устройство терминалом'}
          </button>
        </form>
      )}
    </section>
  );
}
