import { useState } from 'preact/hooks';
import { Shell } from '../components/Shell.jsx';
import { Icon } from '../components/Icon.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { api, getTerminal, setTerminal } from '../lib/api.js';
import { can, logout } from '../lib/auth.js';
import { navigate } from '../lib/router.js';
import { BASE } from '../lib/env.js';
import { ROLE_LABEL } from '../lib/words.js';

/** «Ещё»: QR-наклейки (PDF), терминал ресепшена, выход. */
export function More({ ctx }) {
  const { club, role, user, timeZone } = ctx;
  return (
    <Shell club={club} role={role} user={user} timeZone={timeZone} active="more" title="Ещё">
      <div class="page more">
        <section class="panel">
          <h2 class="section-title">Вы</h2>
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
        {can.manage(role) ? <Stickers clubId={club.club_id} /> : null}
        {can.manage(role) ? <Terminal clubId={club.club_id} /> : null}
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
      const value = { token: res.terminal_token, name: name.trim() || 'Ресепшн', club_id: clubId };
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
            <a class="btn btn--secondary" href={`${BASE}pin`}>
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
