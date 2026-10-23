import { useCallback, useEffect, useState } from 'preact/hooks';
import { formatTime } from '@billiardum/shared/format';
import { DISCIPLINE_WORD } from '@billiardum/shared/plus';
import { Shell } from '../components/Shell.jsx';
import { Icon } from '../components/Icon.jsx';
import { Ill } from '../components/Ill.jsx';
import { Dialog } from '../components/Dialog.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { api } from '../lib/api.js';
import '../styles/m4.css';

/**
 * Споры по партиям Бильярдум+ (№137): игрок оспорил счёт — управляющий решает с причиной, решение в журнале.
 * Победа одного или другого — рейтинг пересчитается; «Аннулировать» — партия не попадёт в рейтинг.
 */
export function Disputes({ ctx }) {
  const { club, role, user, timeZone } = ctx;
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [resolving, setResolving] = useState(null);
  const [notice, setNotice] = useState(null);
  const load = useCallback(() => api.disputes(club.club_id).then((r) => (setItems(r?.items ?? []), setError(null)), setError), [club.club_id]);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <Shell club={club} role={role} user={user} timeZone={timeZone} active="disputes" title="Споры по партиям">
      <div class="page disputes">
        <p class="hint">Партии в рейтинг игроки подтверждают сами. Если счёт оспорен — решаете вы: решение и причина попадут в журнал, игроки получат уведомление.</p>
        <ErrorNote error={error} />
        {notice ? (
          <p class="note note--free" role="status">
            <Icon name="check" />
            <span class="note__title">{notice}</span>
          </p>
        ) : null}
        {items === null && !error ? <p class="muted loading">Загружаем споры…</p> : null}
        {items?.length === 0 ? (
          <p class="empty-queue">
            <Ill name="cue" />
            <span class="empty-queue__title">Споров нет</span>
            Все партии подтверждены игроками.
          </p>
        ) : null}
        {items?.length ? (
          <ul class="dlist">
            {items.map((d) => {
              const [a, b] = d.players;
              return (
                <li class="dcard" key={d.id}>
                  <p class="dcard__head">
                    <span>
                      {DISCIPLINE_WORD[d.discipline]}
                      {d.table_number ? ` · стол ${d.table_number}` : ''} · <span class="mono">{formatTime(d.created_at, timeZone)}</span>
                    </span>
                    <span class="badge badge--alert">
                      <span class="badge__dot" aria-hidden="true" />
                      Спор
                    </span>
                  </p>
                  <p class="dcard__score">
                    <span class="dcard__side">
                      <span class="dcard__num display">{a.score}</span>
                      <span class="dcard__nick">{a.nick}</span>
                    </span>
                    <span class="dcard__colon display" aria-hidden="true">
                      :
                    </span>
                    <span class="dcard__side">
                      <span class="dcard__num display">{b.score}</span>
                      <span class="dcard__nick">{b.nick}</span>
                    </span>
                  </p>
                  <blockquote class="dcard__reason">
                    <span class="dcard__who">{d.disputed_by ?? 'Игрок'}:</span> «{d.dispute_reason}»
                  </blockquote>
                  <button type="button" class="btn btn--primary btn--sm" onClick={() => setResolving(d)}>
                    Рассудить
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
      <ResolveDialog
        d={resolving}
        onClose={() => setResolving(null)}
        onDone={(d, result) => {
          setResolving(null);
          const [a, b] = d.players;
          setNotice(result === 'annul' ? 'Партия аннулирована и не попадёт в рейтинг.' : `Решено: победа ${result === 'a' ? a.nick : b.nick}. Рейтинг пересчитан.`);
          load();
        }}
      />
    </Shell>
  );
}

function ResolveDialog({ d, onClose, onDone }) {
  const [result, setResult] = useState(null);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    setResult(null);
    setReason('');
    setTried(false);
    setError(null);
  }, [d?.id]);
  if (!d) return <Dialog open={false} onClose={onClose} title="" />;
  const [a, b] = d.players;
  const ok = result && reason.trim().length >= 3;
  const options = [
    ['a', `Победа ${a.nick}`, `${a.score}:${b.score} в пользу ${a.nick}`],
    ['b', `Победа ${b.nick}`, `в пользу ${b.nick}`],
    ['annul', 'Аннулировать', 'Партия не попадёт в рейтинг'],
  ];
  return (
    <Dialog open onClose={onClose} title="Рассудить партию" labelledBy="rs-title">
      <form
        class="form"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          setTried(true);
          if (!ok) return;
          setBusy(true);
          setError(null);
          try {
            await api.resolveMatch(d.id, result, reason.trim());
            onDone(d, result);
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset>
          <legend class="field__label">Решение</legend>
          <div class="choice choice--list">
            {options.map(([v, title, sub]) => (
              <label class="choice__item" key={v}>
                <input type="radio" name="rs" checked={result === v} onChange={() => setResult(v)} />
                <span class="choice__box">
                  <span class="choice__title">{title}</span>
                  <span class="choice__sub">{sub}</span>
                </span>
              </label>
            ))}
          </div>
          {tried && !result ? <p class="field__error">Выберите решение.</p> : null}
        </fieldset>
        <div class="field">
          <label class="field__label" for="rs-reason">
            Причина
          </label>
          <input id="rs-reason" class="field__input" maxLength={300} value={reason} aria-invalid={tried && reason.trim().length < 3 ? 'true' : undefined} placeholder="Посмотрели запись камеры над столом" onInput={(e) => setReason(e.currentTarget.value)} />
          {tried && reason.trim().length < 3 ? <p class="field__error">Напишите причину — она попадёт в журнал и уведомление игрокам.</p> : null}
        </div>
        <ErrorNote error={error} />
        <div class="dialog__actions">
          <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
            {busy ? 'Сохраняем…' : 'Принять решение'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
