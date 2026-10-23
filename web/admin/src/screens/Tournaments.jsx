import { useCallback, useEffect, useState } from 'preact/hooks';
import { formatDate, formatMoney, formatTime, plural } from '@billiardum/shared/format';
import { BRACKET_MATCH, DISCIPLINES, DISCIPLINE_WORD, FORMAT_WORD, TOURNAMENT_STATUS } from '@billiardum/shared/plus';
import { Shell } from '../components/Shell.jsx';
import { Icon } from '../components/Icon.jsx';
import { Ill } from '../components/Ill.jsx';
import { Dialog } from '../components/Dialog.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { api, streamTournament } from '../lib/api.js';
import { linkHandler, navigate } from '../lib/router.js';
import { BASE } from '../lib/env.js';
import { cancelRefund, FORMATS, tournamentActions, tournamentBody, tournamentErrors } from '../lib/tournaments.js';
import '../styles/m4.css';

const WINS = ['победы', 'побед', 'побед'];
const PEOPLE = ['игрок', 'игрока', 'игроков'];

function Status({ status }) {
  const s = TOURNAMENT_STATUS[status] ?? { word: status, tone: 'off' };
  const cls = s.tone === 'free' ? 'free' : s.tone === 'play' ? 'play' : s.tone === 'alert' ? 'alert' : 'reserved';
  return (
    <span class={`badge badge--${cls}`}>
      <span class="badge__dot" aria-hidden="true" />
      {s.word}
    </span>
  );
}

/**
 * Турниры клуба (управляющий, №140): список, создание, запись, старт с посевом, сетка, исправление счёта
 * с причиной, отмена с возвратом взносов. Адреса: /tournaments, /tournaments/new, /tournaments/{id}.
 */
export function Tournaments({ ctx }) {
  const { club, role, user, timeZone, id } = ctx;
  const base = `${BASE}c/${encodeURIComponent(club.club_id)}/tournaments`;
  return (
    <Shell club={club} role={role} user={user} timeZone={timeZone} active="tournaments" title="Турниры">
      <div class="page tours">
        {id === 'new' ? <CreateForm clubId={club.club_id} base={base} timeZone={timeZone} /> : id ? <Detail clubId={club.club_id} id={id} base={base} timeZone={timeZone} /> : <List clubId={club.club_id} base={base} timeZone={timeZone} />}
      </div>
    </Shell>
  );
}

function List({ clubId, base, timeZone }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.tournaments(clubId).then(
      (r) => setItems(Array.isArray(r?.items) ? r.items : []),
      (err) => (setError(err), setItems([])),
    );
  }, [clubId]);
  return (
    <>
      <div class="bookings__head">
        <p class="hint">Турнир публикуется в Бильярдуме: игроки записываются и платят взнос в приложении, счёт вносят сами. Столы турнира блокируются на время матчей.</p>
        <a class="btn btn--primary" href={`${base}/new`} onClick={linkHandler}>
          <Icon name="plus" />
          Новый турнир
        </a>
      </div>
      <ErrorNote error={error} />
      {items === null ? <p class="muted loading">Загружаем турниры…</p> : null}
      {items?.length === 0 ? (
        <p class="empty-queue">
          <Ill name="rack" />
          <span class="empty-queue__title">Турниров пока нет</span>
          Создайте первый — например, «Субботняя пирамида до 4 побед» с взносом и призами.
        </p>
      ) : null}
      {items?.length ? (
        <ul class="tlist-a">
          {items.map((t) => (
            <li key={t.id}>
              <a class={`trow trow--${t.status}`} href={`${base}/${encodeURIComponent(t.id)}`} onClick={linkHandler}>
                <span class="trow__date">
                  <span class="trow__day display">{new Intl.DateTimeFormat('ru-RU', { day: 'numeric', timeZone }).format(new Date(t.starts_at))}</span>
                  <span class="trow__month">{new Intl.DateTimeFormat('ru-RU', { month: 'short', timeZone }).format(new Date(t.starts_at)).replace('.', '')}</span>
                </span>
                <span class="trow__main">
                  <span class="trow__title">{t.title}</span>
                  <span class="trow__sub">
                    {DISCIPLINE_WORD[t.discipline]} · до {t.race_to} {plural(t.race_to, WINS)} · {formatTime(t.starts_at, timeZone)} · {t.fee_kopecks ? `взнос ${formatMoney(t.fee_kopecks)}` : 'бесплатно'}
                    {t.rating_limit ? ` · рейтинг до ${t.rating_limit}` : ''}
                  </span>
                </span>
                <span class="trow__count">
                  <span class="display">{t.entries_count}</span>
                  <span>из {t.places}</span>
                </span>
                <Status status={t.status} />
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** Значение для <input type="datetime-local"> во времени клуба. */
function localInput(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
/** Обратно: местное время клуба → момент. */
function fromLocalInput(v, tz) {
  if (!v) return '';
  const guess = Date.parse(`${v}:00Z`);
  const shown = Date.parse(`${localInput(guess, tz)}:00Z`);
  return new Date(guess - (shown - guess)).toISOString();
}

function CreateForm({ clubId, base, timeZone }) {
  const start = Math.ceil((Date.now() + 3 * 86400000) / 3600000) * 3600000;
  const [f, setF] = useState(() => ({
    title: '',
    discipline: 'pyramid',
    format: 'single_elim',
    race_to: '3',
    rating_limit: '',
    fee_rub: '500',
    prize_text: '',
    places: '16',
    starts_local: localInput(start, timeZone),
    ends_local: localInput(start + 6 * 3600000, timeZone),
    resource_ids: [],
  }));
  const [tables, setTables] = useState([]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.hall(clubId).then(
      (h) => setTables((Array.isArray(h) ? h : (h?.items ?? [])).map((x) => x.resource).filter(Boolean)),
      () => {},
    );
  }, [clubId]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.currentTarget.value }));
  const form = { ...f, starts_at: fromLocalInput(f.starts_local, timeZone), ends_at: fromLocalInput(f.ends_local, timeZone) };
  const errs = tournamentErrors(form);
  const bad = (k) => (tried && errs[k] ? 'true' : undefined);
  const submit = async (e, publish = true) => {
    e.preventDefault();
    setTried(true);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    try {
      const t = await api.createTournament(clubId, tournamentBody(form, { publish }));
      navigate(`${base}/${encodeURIComponent(t.id)}`, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const Err = ({ k }) =>
    tried && errs[k] ? (
      <p class="field__error" id={`tf-${k}-err`}>
        {errs[k]}
      </p>
    ) : null;
  return (
    <form class="form tform" onSubmit={submit} noValidate aria-labelledby="tf-title">
      <a class="btn btn--quiet btn--sm tform__back" href={base} onClick={linkHandler}>
        <Icon name="back" />
        Все турниры
      </a>
      <h2 class="section-title" id="tf-title">
        Новый турнир
      </h2>
      <div class="field">
        <label class="field__label" for="tf-title-in">
          Название
        </label>
        <input id="tf-title-in" class="field__input" maxLength={80} value={f.title} placeholder="Субботняя пирамида" aria-invalid={bad('title')} aria-describedby={bad('title') ? 'tf-title-err' : undefined} onInput={set('title')} />
        <Err k="title" />
      </div>
      <fieldset>
        <legend class="field__label">Дисциплина</legend>
        <div class="choice choice--pills">
          {DISCIPLINES.map((d) => (
            <label class="choice__item" key={d}>
              <input type="radio" name="tf-d" checked={f.discipline === d} onChange={() => setF((x) => ({ ...x, discipline: d }))} />
              <span class="choice__box">
                <span class="choice__title">{DISCIPLINE_WORD[d]}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend class="field__label">Формат</legend>
        <div class="choice choice--pills">
          {FORMATS.map((d) => (
            <label class="choice__item" key={d}>
              <input type="radio" name="tf-f" checked={f.format === d} onChange={() => setF((x) => ({ ...x, format: d }))} />
              <span class="choice__box">
                <span class="choice__title">{FORMAT_WORD[d]}</span>
              </span>
            </label>
          ))}
        </div>
        <p class="field__hint">«До двух поражений» — в следующем этапе.</p>
      </fieldset>
      <div class="tform__grid">
        <div class="field">
          <label class="field__label" for="tf-race">
            Матч до … побед
          </label>
          <input id="tf-race" class="field__input mono" type="number" inputMode="numeric" min={1} max={15} value={f.race_to} aria-invalid={bad('race_to')} aria-describedby={bad('race_to') ? 'tf-race_to-err' : 'tf-race-hint'} onInput={set('race_to')} />
          {tried && errs.race_to ? <Err k="race_to" /> : <p class="field__hint" id="tf-race-hint">{f.discipline === 'pyramid' ? 'Партия — до 8 шаров.' : 'Партия — до победы.'}</p>}
        </div>
        <div class="field">
          <label class="field__label" for="tf-places">
            Мест
          </label>
          <input id="tf-places" class="field__input mono" type="number" inputMode="numeric" min={4} max={128} value={f.places} aria-invalid={bad('places')} aria-describedby={bad('places') ? 'tf-places-err' : undefined} onInput={set('places')} />
          <Err k="places" />
        </div>
        <div class="field">
          <label class="field__label" for="tf-limit">
            Лимит рейтинга
          </label>
          <input id="tf-limit" class="field__input mono" type="number" inputMode="numeric" placeholder="без лимита" value={f.rating_limit} aria-invalid={bad('rating_limit')} aria-describedby={bad('rating_limit') ? 'tf-rating_limit-err' : 'tf-limit-hint'} onInput={set('rating_limit')} />
          {tried && errs.rating_limit ? <Err k="rating_limit" /> : <p class="field__hint" id="tf-limit-hint">Игроку с рейтингом выше запись не откроется — с объяснением.</p>}
        </div>
        <div class="field">
          <label class="field__label" for="tf-fee">
            Взнос, ₽
          </label>
          <input id="tf-fee" class="field__input mono" inputMode="decimal" value={f.fee_rub} aria-invalid={bad('fee_rub')} aria-describedby={bad('fee_rub') ? 'tf-fee_rub-err' : 'tf-fee-hint'} onInput={set('fee_rub')} />
          {tried && errs.fee_rub ? <Err k="fee_rub" /> : <p class="field__hint" id="tf-fee-hint">Оплата через ЮKassa с чеком. 0 — бесплатно.</p>}
        </div>
        <div class="field">
          <label class="field__label" for="tf-start">
            Начало
          </label>
          <input id="tf-start" class="field__input mono" type="datetime-local" value={f.starts_local} aria-invalid={bad('starts_at')} aria-describedby={bad('starts_at') ? 'tf-starts_at-err' : undefined} onInput={set('starts_local')} />
          <Err k="starts_at" />
        </div>
        <div class="field">
          <label class="field__label" for="tf-end">
            Конец
          </label>
          <input id="tf-end" class="field__input mono" type="datetime-local" value={f.ends_local} aria-invalid={bad('ends_at')} aria-describedby={bad('ends_at') ? 'tf-ends_at-err' : undefined} onInput={set('ends_local')} />
          <Err k="ends_at" />
        </div>
      </div>
      <div class="field">
        <label class="field__label" for="tf-prize">
          Призы
        </label>
        <input id="tf-prize" class="field__input" maxLength={200} value={f.prize_text} placeholder="1 место — 10 000 ₽, 2 место — 5 000 ₽" onInput={set('prize_text')} />
      </div>
      <fieldset aria-describedby={bad('resource_ids') ? 'tf-resource_ids-err' : 'tf-tables-hint'}>
        <legend class="field__label">Столы турнира</legend>
        <div class="choice choice--pills">
          {tables.map((r) => (
            <label class="choice__item" key={r.id}>
              <input
                type="checkbox"
                checked={f.resource_ids.includes(r.id)}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  setF((x) => ({ ...x, resource_ids: on ? [...x.resource_ids, r.id] : x.resource_ids.filter((y) => y !== r.id) }));
                }}
              />
              <span class="choice__box">
                <span class="choice__title">Стол {r.number}</span>
              </span>
            </label>
          ))}
        </div>
        {tried && errs.resource_ids ? (
          <Err k="resource_ids" />
        ) : (
          <p class="field__hint" id="tf-tables-hint">
            На время матчей брони и игры по QR на этих столах не принимаются.
          </p>
        )}
      </fieldset>
      <ErrorNote error={error} />
      <div class="row">
        <button type="submit" class="btn btn--primary btn--lg" disabled={busy}>
          {busy ? 'Создаём…' : 'Опубликовать турнир'}
        </button>
        <button type="button" class="btn btn--quiet btn--lg" disabled={busy} onClick={(e) => submit(e, false)}>
          Сохранить черновик
        </button>
      </div>
    </form>
  );
}

function Detail({ clubId, id, base, timeZone }) {
  const [t, setT] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const [fixing, setFixing] = useState(null);
  const [canceling, setCanceling] = useState(false);
  const load = useCallback(async () => {
    try {
      setT(await api.tournament(clubId, id));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [clubId, id]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (t?.status !== 'running') return undefined;
    const s = streamTournament(id, { onEvent: (_n, data) => data?.rounds && setT((x) => (x ? { ...x, bracket: { rounds: data.rounds } } : x)) });
    return () => s.close();
  }, [t?.status, id]);

  const act = async (key, fn, msg) => {
    setBusy(key);
    setError(null);
    try {
      setT(await fn());
      setNotice(msg);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  if (!t) return error ? <ErrorNote error={error} /> : <p class="muted loading">Загружаем турнир…</p>;
  const a = tournamentActions(t);
  const paid = t.entries.filter((e) => e.paid).length;
  return (
    <>
      <a class="btn btn--quiet btn--sm tform__back" href={base} onClick={linkHandler}>
        <Icon name="back" />
        Все турниры
      </a>
      <header class="thead">
        <div class="thead__main">
          <h2 class="thead__title display">{t.title}</h2>
          <p class="thead__sub">
            {formatDate(t.starts_at, timeZone)}, <span class="mono">{formatTime(t.starts_at, timeZone)}</span>–<span class="mono">{formatTime(t.ends_at, timeZone)}</span> · {DISCIPLINE_WORD[t.discipline]} · {FORMAT_WORD[t.format]} · до {t.race_to} {plural(t.race_to, WINS)}
          </p>
        </div>
        <Status status={t.status} />
      </header>
      <dl class="tstats">
        <div>
          <dt>Записались</dt>
          <dd class="display">
            {t.entries_count}
            <span class="tstats__of">из {t.places}</span>
          </dd>
        </div>
        <div>
          <dt>Оплатили взнос</dt>
          <dd class="display">{t.fee_kopecks ? paid : '—'}</dd>
        </div>
        <div>
          <dt>Взносы</dt>
          <dd class="display mono">{formatMoney(paid * t.fee_kopecks)}</dd>
        </div>
        <div>
          <dt>Лимит рейтинга</dt>
          <dd class="display">{t.rating_limit ?? '—'}</dd>
        </div>
      </dl>
      {notice ? (
        <p class="note note--free" role="status">
          <Icon name="check" />
          <span class="note__title">{notice}</span>
        </p>
      ) : null}
      <ErrorNote error={error} />
      <div class="row tactions">
        {a.publish ? (
          <button type="button" class="btn btn--primary" disabled={busy} onClick={() => act('publish', () => api.updateTournament(clubId, id, { status: 'registration' }), 'Турнир опубликован: запись открыта в Бильярдуме.')}>
            Опубликовать и открыть запись
          </button>
        ) : null}
        {a.closeEntry ? (
          <button type="button" class="btn btn--secondary" disabled={busy} onClick={() => act('close', () => api.updateTournament(clubId, id, { status: 'closed' }), 'Запись закрыта.')}>
            Закрыть запись
          </button>
        ) : null}
        {a.openEntry ? (
          <button type="button" class="btn btn--secondary" disabled={busy} onClick={() => act('open', () => api.updateTournament(clubId, id, { status: 'registration' }), 'Запись снова открыта.')}>
            Открыть запись
          </button>
        ) : null}
        {a.start ? (
          <button type="button" class="btn btn--primary" disabled={busy} onClick={() => act('start', () => api.startTournament(clubId, id), 'Турнир начат: посев по рейтингу, сетка построена, столы заблокированы.')}>
            <Icon name="trophy" />
            {busy === 'start' ? 'Строим сетку…' : 'Начать турнир'}
          </button>
        ) : null}
        {t.status === 'running' || t.status === 'finished' ? (
          <a class="btn btn--secondary" href={`${BASE}tv/tournament/${encodeURIComponent(t.id)}`} target="_blank" rel="noopener">
            <Icon name="external" />
            ТВ-экран сетки
          </a>
        ) : null}
        {a.cancel ? (
          <button type="button" class="btn btn--quiet person__revoke" onClick={() => setCanceling(true)}>
            Отменить турнир
          </button>
        ) : null}
      </div>

      {t.bracket ? (
        <section aria-labelledby="td-br">
          <h3 class="tables__title" id="td-br">
            Сетка
          </h3>
          <p class="hint">Нажмите на матч, чтобы исправить счёт — с причиной, исправление попадёт в журнал.</p>
          <AdminBracket bracket={t.bracket} onPick={a.fixScore ? setFixing : null} />
        </section>
      ) : null}

      <section aria-labelledby="td-en">
        <h3 class="tables__title" id="td-en">
          Участники <span class="count">{t.entries.length}</span>
        </h3>
        {t.entries.length ? (
          <ol class="entries">
            {[...t.entries]
              .sort((x, y) => (x.seed ?? 99) - (y.seed ?? 99) || y.rating - x.rating)
              .map((e) => (
                <li class="entries__row" key={e.entry_id}>
                  <span class="entries__seed mono">{e.seed ?? '·'}</span>
                  <span class="entries__nick">{e.nick}</span>
                  <span class="entries__rating mono">{e.rating}</span>
                  <span class={`entries__paid${e.paid ? ' entries__paid--ok' : ''}`}>{t.fee_kopecks ? (e.paid ? 'оплачен' : 'ждём оплату') : 'бесплатно'}</span>
                </li>
              ))}
          </ol>
        ) : (
          <p class="muted">Пока никто не записался. Турнир виден игрокам в Бильярдуме.</p>
        )}
      </section>

      <FixScoreDialog
        match={fixing}
        raceTo={t.race_to}
        onClose={() => setFixing(null)}
        onDone={(x) => {
          setFixing(null);
          setT(x);
          setNotice('Счёт исправлен. Исправление записано в журнал, владелец получил уведомление.');
        }}
      />
      <CancelDialog
        open={canceling}
        t={t}
        clubId={clubId}
        onClose={() => setCanceling(false)}
        onDone={(x) => {
          setCanceling(false);
          setT(x);
          setNotice(x.refunded ? `Турнир отменён. Взнос вернём ${x.refunded} ${plural(x.refunded, PEOPLE)} целиком.` : 'Турнир отменён.');
        }}
      />
    </>
  );
}

/** Сетка для организатора: матч — кнопка (исправить счёт). */
function AdminBracket({ bracket, onPick }) {
  return (
    <div class="abracket" role="region" aria-label="Турнирная сетка" tabIndex={0}>
      <ol class="abracket__rounds">
        {bracket.rounds.map((r, ri) => (
          <li class="abracket__round" key={`${r.title}${ri}`}>
            <h4 class="abracket__title">{r.title}</h4>
            <ul class="abracket__matches">
              {r.matches.map((m) => {
                const body = (
                  <>
                    <MSide side={m.a} score={m.score_a} win={m.winner === 'a'} />
                    <MSide side={m.b} score={m.score_b} win={m.winner === 'b'} />
                    <span class="am__meta">
                      {m.table_number && m.status !== 'done' ? `Стол ${m.table_number} · ` : ''}
                      {BRACKET_MATCH[m.status] ?? ''}
                    </span>
                  </>
                );
                const pickable = onPick && m.a && m.b;
                return (
                  <li key={m.id}>
                    {pickable ? (
                      <button type="button" class={`am am--${m.status}`} onClick={() => onPick(m)} aria-label={`${m.a.nick} — ${m.b.nick}${m.score_a !== null ? `, ${m.score_a}:${m.score_b}` : ''}. Исправить счёт`}>
                        {body}
                      </button>
                    ) : (
                      <div class={`am am--${m.status}`}>{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}

function MSide({ side, score, win }) {
  return (
    <span class={`am__side${win ? ' am__side--win' : ''}${side ? '' : ' am__side--empty'}`}>
      <span class="am__seed mono">{side?.seed ?? ''}</span>
      <span class="am__nick">{side?.nick ?? '—'}</span>
      <span class="am__score mono">{score ?? ''}</span>
    </span>
  );
}

function FixScoreDialog({ match, raceTo, onClose, onDone }) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!match) return;
    setA(match.score_a ?? '');
    setB(match.score_b ?? '');
    setReason('');
    setTried(false);
    setError(null);
  }, [match?.id]);
  if (!match) return <Dialog open={false} onClose={onClose} title="" />;
  const na = Number(a);
  const nb = Number(b);
  const scoreOk = Number.isInteger(na) && Number.isInteger(nb) && Math.max(na, nb) === raceTo && Math.min(na, nb) < raceTo && a !== '' && b !== '';
  const ok = scoreOk && reason.trim().length >= 3;
  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await api.fixScore(match.id, na, nb, reason.trim()));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title="Исправить счёт матча" labelledBy="fx-title">
      <form class="form" onSubmit={submit} noValidate>
        <div class="fxscore">
          <div class="field">
            <label class="field__label" for="fx-a">
              {match.a?.nick}
            </label>
            <input id="fx-a" class="field__input field__input--money mono" type="number" inputMode="numeric" min={0} max={raceTo} value={a} onInput={(ev) => setA(ev.currentTarget.value)} />
          </div>
          <span class="fxscore__colon display" aria-hidden="true">
            :
          </span>
          <div class="field">
            <label class="field__label" for="fx-b">
              {match.b?.nick}
            </label>
            <input id="fx-b" class="field__input field__input--money mono" type="number" inputMode="numeric" min={0} max={raceTo} value={b} onInput={(ev) => setB(ev.currentTarget.value)} />
          </div>
        </div>
        {tried && !scoreOk ? <p class="field__error">Матч до {raceTo} побед: у победителя ровно {raceTo}, у проигравшего меньше.</p> : null}
        <div class="field">
          <label class="field__label" for="fx-reason">
            Причина
          </label>
          <input id="fx-reason" class="field__input" maxLength={300} value={reason} aria-invalid={tried && reason.trim().length < 3 ? 'true' : undefined} placeholder="Игроки внесли разный счёт, проверили по видео" onInput={(ev) => setReason(ev.currentTarget.value)} />
          {tried && reason.trim().length < 3 ? <p class="field__error">Напишите причину — её увидит владелец, исправление попадёт в журнал.</p> : null}
        </div>
        <ErrorNote error={error} />
        <div class="dialog__actions">
          <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
            {busy ? 'Сохраняем…' : 'Исправить счёт'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function CancelDialog({ open, t, clubId, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const refund = cancelRefund(t);
  return (
    <Dialog open={open} onClose={onClose} title="Отменить турнир?" labelledBy="tc-title">
      <form
        class="form"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          setTried(true);
          if (reason.trim().length < 3) return;
          setBusy(true);
          setError(null);
          try {
            onDone(await api.cancelTournament(clubId, t.id, reason.trim()));
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div class="note note--error">
          <Icon name="alert" />
          <p class="note__title">{refund.players ? `Вернём ${formatMoney(refund.kopecks)}: ${refund.players} ${plural(refund.players, PEOPLE)}` : 'Взносов к возврату нет'}</p>
          <p class="note__body">При отмене клубом взнос возвращается всем целиком через ЮKassa. Игроки получат уведомление, столы освободятся. Действие попадёт в журнал.</p>
        </div>
        <div class="field">
          <label class="field__label" for="tc-reason">
            Причина
          </label>
          <input id="tc-reason" class="field__input" maxLength={300} value={reason} aria-invalid={tried && reason.trim().length < 3 ? 'true' : undefined} onInput={(e) => setReason(e.currentTarget.value)} />
          {tried && reason.trim().length < 3 ? <p class="field__error">Напишите причину — её увидят игроки и владелец.</p> : null}
        </div>
        <ErrorNote error={error} />
        <div class="dialog__actions dialog__actions--row">
          <button type="submit" class="btn btn--danger btn--lg" disabled={busy}>
            {busy ? 'Отменяем…' : 'Отменить турнир'}
          </button>
          <button type="button" class="btn btn--quiet btn--lg" onClick={onClose}>
            Не отменять
          </button>
        </div>
      </form>
    </Dialog>
  );
}
