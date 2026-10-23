import { useCallback, useEffect, useState } from 'preact/hooks';
import { DISCIPLINES, DISCIPLINE_WORD, scoreValid } from '@billiardum/shared/plus';
import { Icon } from './Icon.jsx';
import { Dialog } from './Dialog.jsx';
import { ErrorNote } from './ErrorNote.jsx';
import { MatchCard, DisputeDialog } from './MatchCard.jsx';
import { api } from '../lib/api.js';
import { auth } from '../lib/auth.js';
import { useStore } from '../lib/store.js';
import { BASE } from '../lib/env.js';
import { linkHandler } from '../lib/router.js';
import { disciplineOfTable, opponents, sortMatches } from '../lib/plus.js';
import '../styles/m4.css';

/**
 * «Партия» на экране игры (Бильярдум+, T22/T23): внести счёт с соперником из участников сессии, подтвердить
 * или оспорить счёт соперника. Засчитывает в рейтинг сервер: оба за этим столом, оба подтвердили за 30 минут,
 * не больше трёх партий пары за сутки — иначе «в рейтинг не засчитана» с причиной.
 */
export function MatchPanel({ session }) {
  const { user } = useStore(auth);
  const meId = user?.id;
  const rivals = opponents(session, meId);
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [disputing, setDisputing] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await api.matches(session.id);
      setItems(Array.isArray(res?.items) ? res.items : []);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [session.id]);
  useEffect(() => {
    load();
  }, [load]);
  // Пока соперник подтверждает — перечитываем раз в 5 секунд
  const waiting = items?.some((m) => m.status === 'pending');
  useEffect(() => {
    if (!waiting) return undefined;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [waiting, load]);

  if (!rivals.length && !items?.length) return null;
  const replace = (m) => setItems((list) => (list ?? []).map((x) => (x.id === m.id ? m : x)));
  const list = sortMatches(items, meId);

  return (
    <section class="partia" aria-labelledby="partia-title">
      <div class="partia__head">
        <h2 class="step__label" id="partia-title">
          Партия в рейтинг
        </h2>
        <a class="partia__more" href={`${BASE}plus`} onClick={linkHandler}>
          Бильярдум+
        </a>
      </div>
      <p class="hint">Сыграли партию — внесите счёт. Соперник подтвердит в своём телефоне, и рейтинг пересчитается у обоих.</p>
      <ErrorNote error={error} />
      {list.length ? (
        <ul class="partia__list">
          {list.slice(0, 2).map((m) => (
            <li key={m.id}>
              <MatchCard match={m} meId={meId} onChange={replace} onDispute={() => setDisputing(m)} />
            </li>
          ))}
        </ul>
      ) : null}
      {list.length > 2 ? (
        <details class="partia__more-list">
          <summary>Ещё партии за этим столом: {list.length - 2}</summary>
          <ul class="partia__list">
            {list.slice(2).map((m) => (
              <li key={m.id}>
                <MatchCard match={m} meId={meId} onChange={replace} onDispute={() => setDisputing(m)} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {rivals.length ? (
        <button type="button" class="btn btn--secondary btn--block btn--lg" onClick={() => setAdding(true)}>
          <Icon name="plus" />
          Записать партию
        </button>
      ) : null}
      <AddMatchDialog
        open={adding}
        session={session}
        rivals={rivals}
        onClose={() => setAdding(false)}
        onDone={(m) => {
          setAdding(false);
          setItems((l) => [m, ...(l ?? [])]);
        }}
      />
      <DisputeDialog
        match={disputing}
        onClose={() => setDisputing(null)}
        onDone={(m) => {
          setDisputing(null);
          replace(m);
        }}
      />
    </section>
  );
}

/** Счётчик шаров/партий: крупные «−» и «+», число по центру — одной рукой. */
function Stepper({ id, label, value, onChange, max }) {
  return (
    <div class="stepper" role="group" aria-labelledby={`${id}-l`}>
      <span class="stepper__label" id={`${id}-l`}>
        {label}
      </span>
      <div class="stepper__row">
        <button type="button" class="stepper__btn" aria-label={`${label}: меньше`} disabled={value <= 0} onClick={() => onChange(value - 1)}>
          −
        </button>
        <output class="stepper__value display" aria-live="polite">
          {value}
        </output>
        <button type="button" class="stepper__btn" aria-label={`${label}: больше`} disabled={value >= max} onClick={() => onChange(value + 1)}>
          +
        </button>
      </div>
    </div>
  );
}

function AddMatchDialog({ open, session, rivals, onClose, onDone }) {
  const [discipline, setDiscipline] = useState(() => disciplineOfTable(session.resource?.type));
  const [rival, setRival] = useState(rivals[0]?.user_id ?? null);
  const [mine, setMine] = useState(8);
  const [theirs, setTheirs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!open) return;
    const d = disciplineOfTable(session.resource?.type);
    setDiscipline(d);
    setRival(rivals[0]?.user_id ?? null);
    setMine(d === 'pyramid' ? 8 : 1);
    setTheirs(0);
    setError(null);
  }, [open]);
  const ok = Boolean(rival) && scoreValid(discipline, mine, theirs);
  const max = discipline === 'pyramid' ? 8 : 15;
  const submit = async (e) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await api.addMatch({ session_id: session.id, discipline, opponent_id: rival, my_score: mine, opponent_score: theirs }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const rivalNick = rivals.find((r) => r.user_id === rival)?.nick ?? 'Соперник';
  return (
    <Dialog open={open} onClose={onClose} title="Записать партию" labelledBy="am-title">
      <form class="form" onSubmit={submit} noValidate>
        <fieldset class="seg">
          <legend class="seg__legend">Дисциплина</legend>
          <div class="seg__row">
            {DISCIPLINES.map((d) => (
              <label class="seg__item" key={d}>
                <input type="radio" name="am-d" checked={discipline === d} onChange={() => setDiscipline(d)} />
                <span class="seg__box">{DISCIPLINE_WORD[d]}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {rivals.length > 1 ? (
          <fieldset class="seg">
            <legend class="seg__legend">Соперник</legend>
            <div class="seg__row">
              {rivals.map((r) => (
                <label class="seg__item" key={r.user_id}>
                  <input type="radio" name="am-r" checked={rival === r.user_id} onChange={() => setRival(r.user_id)} />
                  <span class="seg__box">{r.nick}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : (
          <p class="hint">
            Соперник: <b>{rivalNick}</b>
          </p>
        )}
        <div class="scorepad">
          <Stepper id="am-me" label="Вы" value={mine} onChange={setMine} max={max} />
          <span class="scorepad__colon display" aria-hidden="true">
            :
          </span>
          <Stepper id="am-them" label={rivalNick} value={theirs} onChange={setTheirs} max={max} />
        </div>
        {!ok ? <p class="field__error">{discipline === 'pyramid' ? 'В пирамиде партия до 8 шаров: у победителя 8, у проигравшего меньше.' : 'Счёт не может быть ничейным.'}</p> : null}
        <ErrorNote error={error}>
          {error?.code === 'no_profile' ? (
            <a class="btn btn--secondary btn--sm" href={`${BASE}plus`} onClick={linkHandler}>
              Открыть Бильярдум+
            </a>
          ) : null}
        </ErrorNote>
        <div class="dialog__actions">
          <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy || !ok}>
            {busy ? 'Отправляем…' : `Отправить ${mine}:${theirs} на подтверждение`}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
