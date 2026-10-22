import { useCallback, useEffect, useState } from 'preact/hooks';
import { formatDate, formatTime } from '@billiardum/shared/format';
import { Icon } from '../components/Icon.jsx';
import { Ill } from '../components/Ill.jsx';
import { Dialog } from '../components/Dialog.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { api, getTerminal } from '../lib/api.js';
import { sortTerminals, terminalState } from '../lib/terminals.js';

/** «12 октября, 14:30»; сегодня — только время. */
function when(iso, tz) {
  if (!iso) return null;
  const today = formatDate(new Date(), tz) === formatDate(iso, tz);
  return today ? `сегодня в ${formatTime(iso, tz)}` : `${formatDate(iso, tz)}, ${formatTime(iso, tz)}`;
}

/**
 * Персонал → Терминалы (владелец, ревью входа): общие планшеты ресепшена, на которых сотрудники меняются
 * по PIN. Отзыв гасит PIN-входы на терминале сразу; блокировка после 10 неверных PIN за час снимается здесь.
 */
export function Terminals({ clubId, timeZone }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [revoking, setRevoking] = useState(null);
  const [notice, setNotice] = useState(null);
  const here = getTerminal()?.id ?? null;

  const load = useCallback(async () => {
    try {
      const res = await api.terminals(clubId);
      setList(Array.isArray(res) ? res : (res?.terminals ?? []));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [clubId]);
  useEffect(() => {
    load();
  }, [load]);

  const unlock = async (t) => {
    setBusy(t.id);
    setError(null);
    try {
      await api.unlockTerminal(clubId, t.id);
      setNotice(`Терминал «${t.name}» разблокирован: вход по PIN снова работает.`);
      load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const now = Date.now();
  const items = sortTerminals(list ?? [], now);
  const live = items.filter((t) => terminalState(t, now).state !== 'revoked');

  return (
    <>
      <p class="hint">
        Терминал — общий планшет ресепшена: сотрудники меняются на нём по PIN, каждое действие подписано своим именем. Новый терминал регистрируют на самом устройстве в разделе «Ещё».
      </p>
      <ErrorNote error={error}>
        <button type="button" class="btn btn--secondary btn--sm" onClick={load}>
          Обновить
        </button>
      </ErrorNote>
      {notice ? (
        <p class="note note--free" role="status">
          <Icon name="check" />
          <span class="note__title">{notice}</span>
        </p>
      ) : null}
      {list === null && !error ? <p class="muted loading">Загружаем терминалы…</p> : null}

      {list !== null && !items.length ? (
        <div class="empty-queue">
          <Ill name="cue" />
          <p class="empty-queue__title">Терминалов пока нет</p>
          <p class="hint">Откройте программу клуба на планшете ресепшена, войдите сами и нажмите «Сделать это устройство терминалом» в разделе «Ещё».</p>
        </div>
      ) : null}

      {items.length ? (
        <section aria-labelledby="term-list">
          <h2 class="tables__title" id="term-list">
            Терминалы <span class="count">{live.length}</span>
          </h2>
          <ul class="terms">
            {items.map((t) => {
              const st = terminalState(t, now);
              return (
                <li class={`term term--${st.state}`} key={t.id}>
                  <span class="term__icon" aria-hidden="true">
                    <Icon name={st.state === 'locked' ? 'lock' : 'key'} />
                  </span>
                  <span class="term__main">
                    <span class="term__name">
                      {t.name}
                      {t.id === here ? <span class="person__tag">это устройство</span> : null}
                    </span>
                    <span class="term__sub">
                      Добавил {t.created_by?.name ?? 'сотрудник'} {formatDate(t.created_at, timeZone)}
                      {st.state === 'revoked' ? ` · отозван ${formatDate(t.revoked_at, timeZone)}` : t.expires_at ? ` · действует до ${formatDate(t.expires_at, timeZone)}` : ''}
                    </span>
                    <span class="term__sub">{t.last_used_at ? `Последний вход по PIN — ${when(t.last_used_at, timeZone)}` : 'По PIN на нём ещё не входили'}</span>
                  </span>
                  <span class={`badge badge--${st.tone === 'alert' ? 'alert' : st.tone === 'free' ? 'free' : 'off'} term__badge`}>
                    <span class="badge__dot" aria-hidden="true" />
                    {st.word}
                  </span>
                  {st.state === 'locked' ? (
                    <p class="term__locked">
                      Заблокирован {when(t.locked_at, timeZone)}: за час на нём 10 раз ввели неверный PIN. Если это были свои — разблокируйте; если планшет мог попасть в чужие руки — отзовите.
                    </p>
                  ) : null}
                  {st.canRevoke ? (
                    <span class="term__tools">
                      {st.canUnlock ? (
                        <button type="button" class="btn btn--primary btn--sm" disabled={busy === t.id} onClick={() => unlock(t)}>
                          <Icon name="key" />
                          {busy === t.id ? 'Разблокируем…' : 'Разблокировать'}
                        </button>
                      ) : null}
                      <button type="button" class="btn btn--quiet btn--sm person__revoke" onClick={() => setRevoking(t)}>
                        Отозвать
                      </button>
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <RevokeTerminal
        terminal={revoking}
        clubId={clubId}
        here={revoking?.id === here}
        onClose={() => setRevoking(null)}
        onDone={(t) => {
          setRevoking(null);
          setNotice(`Терминал «${t.name}» отозван: вход по PIN на нём больше не работает.`);
          load();
        }}
      />
    </>
  );
}

function RevokeTerminal({ terminal, clubId, here, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => setError(null), [terminal?.id]);
  if (!terminal) return <Dialog open={false} onClose={onClose} title="" />;
  return (
    <Dialog open onClose={onClose} title={`Отозвать терминал «${terminal.name}»?`} labelledBy="trv-title">
      <div class="form">
        <div class="note note--error">
          <Icon name="alert" />
          <p class="note__title">Сразу, без отмены</p>
          <p class="note__body">
            Сотрудник, вошедший на нём по PIN, выйдет; вход по PIN на этом устройстве перестанет работать.{here ? ' Это устройство — тот самый терминал.' : ''} Вернуть — зарегистрировать
            терминал заново в «Ещё». Действие попадёт в журнал.
          </p>
        </div>
        <ErrorNote error={error} />
        <div class="dialog__actions dialog__actions--row">
          <button
            type="button"
            class="btn btn--danger btn--lg"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api.revokeTerminal(clubId, terminal.id);
                onDone(terminal);
              } catch (err) {
                setError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Отзываем…' : 'Отозвать терминал'}
          </button>
          <button type="button" class="btn btn--quiet btn--lg" onClick={onClose}>
            Не отзывать
          </button>
        </div>
      </div>
    </Dialog>
  );
}
