import { useCallback, useEffect, useState } from 'preact/hooks';
import { formatDate, formatMoney, formatTime, plural } from '@billiardum/shared/format';
import { DISCIPLINE_WORD, FORMAT_WORD, TOURNAMENT_STATUS, nickValid, raceScoreValid, ratingLimitText } from '@billiardum/shared/plus';
import { Header } from '../components/Header.jsx';
import { Icon } from '../components/Icon.jsx';
import { Ill } from '../components/Ill.jsx';
import { Dialog } from '../components/Dialog.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { Seg } from '../components/Seg.jsx';
import { Bracket } from '../components/Bracket.jsx';
import { SignIn } from './SignIn.jsx';
import { api, streamTournament } from '../lib/api.js';
import { auth } from '../lib/auth.js';
import { useStore } from '../lib/store.js';
import { linkHandler } from '../lib/router.js';
import { BASE } from '../lib/env.js';
import { lastClub } from '../lib/flow.js';
import { safeRedirectUrl } from '../lib/urls.js';
import { entryState, filterTournaments, placesLeft, shownTournamentScore, zoneOf } from '../lib/plus.js';
import '../styles/m4.css';

const PLACES = ['место', 'места', 'мест'];
const WINS = ['победы', 'побед', 'побед'];
const tzOf = (t) => zoneOf(t?.club?.timezone, lastClub()?.timezone);

function Badge({ status }) {
  const s = TOURNAMENT_STATUS[status] ?? { word: status, tone: 'off' };
  const cls = s.tone === 'free' ? 'free' : s.tone === 'play' ? 'play' : s.tone === 'alert' ? 'alert' : 'reserved';
  return (
    <span class={`badge badge--${cls}`}>
      <span class="badge__dot" aria-hidden="true" />
      {s.word}
    </span>
  );
}

function weekday(iso, tz) {
  return new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: tz }).format(new Date(iso));
}

/** Афиша турниров: запись идёт, идут сейчас, прошедшие. */
export function TournamentsScreen() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('soon');
  useEffect(() => {
    api.tournaments().then(
      (r) => setItems(Array.isArray(r?.items) ? r.items : []),
      (err) => (setError(err), setItems([])),
    );
  }, []);
  const list = filterTournaments(items, filter === 'soon' ? null : filter);
  return (
    <div class="screen screen--paper">
      <Header back={{ href: `${BASE}plus`, label: 'Бильярдум+' }} />
      <main class="wrap content plus">
        <h1 class="page-title display">Турниры</h1>
        <Seg
          name="tr-f"
          legend="Какие турниры"
          hideLegend
          value={filter}
          onChange={setFilter}
          options={[
            ['soon', 'Скоро'],
            ['open', 'Запись'],
            ['live', 'Идут'],
            ['past', 'Прошли'],
          ]}
        />
        <ErrorNote error={error} />
        {items === null ? <p class="muted loading">Загружаем турниры…</p> : null}
        {items && !list.length ? (
          <div class="empty">
            <Ill name="rack" />
            <p class="hint">{filter === 'past' ? 'Прошедших турниров пока нет.' : 'Сейчас турниров нет. Клубы публикуют их здесь — загляните позже.'}</p>
          </div>
        ) : null}
        {list.length ? (
          <ul class="tlist">
            {list.map((t) => {
              const tz = tzOf(t);
              const left = placesLeft(t);
              return (
                <li key={t.id}>
                  <a class="tcard" href={`${BASE}tournaments/${encodeURIComponent(t.id)}`} onClick={linkHandler}>
                    <span class="tcard__stub" aria-hidden="true">
                      <span class="tcard__day display">{new Intl.DateTimeFormat('ru-RU', { day: 'numeric', timeZone: tz }).format(new Date(t.starts_at))}</span>
                      <span class="tcard__month">{new Intl.DateTimeFormat('ru-RU', { month: 'short', timeZone: tz }).format(new Date(t.starts_at)).replace('.', '')}</span>
                      <span class="tcard__wd">{weekday(t.starts_at, tz)}</span>
                    </span>
                    <span class="tcard__main">
                      <span class="visually-hidden">{formatDate(t.starts_at, tz)}, </span>
                      <span class="tcard__title">{t.title}</span>
                      <span class="tcard__sub">
                        {DISCIPLINE_WORD[t.discipline]} · до {t.race_to} {plural(t.race_to, WINS)} · <span class="mono">{formatTime(t.starts_at, tz)}</span>
                      </span>
                      <span class="tcard__sub">{t.club?.name}</span>
                      <span class="tcard__tags">
                        <Badge status={t.status} />
                        <span class="tag">{t.fee_kopecks ? `взнос ${formatMoney(t.fee_kopecks)}` : 'бесплатно'}</span>
                        {t.rating_limit ? <span class="tag tag--limit">рейтинг до {t.rating_limit}</span> : null}
                        {t.status === 'registration' && left !== null ? <span class="tag">{left ? `${left} ${plural(left, PLACES)}` : 'мест нет'}</span> : null}
                      </span>
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        ) : null}
      </main>
    </div>
  );
}

/** Турнир: условия, запись со взносом (T24 — отказ по рейтингу с объяснением), мой матч, сетка вживую. */
export function TournamentScreen({ id, search }) {
  const { status } = useStore(auth);

  const paidReturn = new URLSearchParams(search ?? '').get('paid') === '1';
  const [pub, setT] = useState(null);
  const [mine, setMine] = useState(null);
  // Публичный турнир кэшируется на минуту (для сайта) — статус и число мест берём свежими из /me, если вошли
  const t = pub && mine?.tournament ? { ...pub, status: mine.tournament.status ?? pub.status, entries_count: mine.tournament.entries_count ?? pub.entries_count } : pub;
  // Профиль Бильярдум+: undefined — ещё не знаем, nick: null — ника нет, записаться нельзя (№150)
  const [profile, setProfile] = useState(undefined);
  const myNick = profile?.nick ?? null;
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState(null);
  const [leaving, setLeaving] = useState(false);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      setT(await api.tournament(id));
      if (auth.get().status === 'user') setMine(await api.myTournament(id).catch(() => null));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [id]);
  useEffect(() => {
    load();
  }, [load, status]);
  useEffect(() => {
    if (status === 'user')
      api
        .plusMe()
        .then((m) => setProfile({ nick: m?.nick ?? null }))
        .catch(() => setProfile(null));
  }, [status]);
  // Сетка вживую (SSE tournament:{id}) — пока турнир идёт
  useEffect(() => {
    if (t?.status !== 'running') return undefined;
    const s = streamTournament(id, {
      onEvent: (_name, data) => {
        if (data?.rounds) setT((x) => (x ? { ...x, bracket: { rounds: data.rounds } } : x));
        if (auth.get().status === 'user') api.myTournament(id).then(setMine, () => {});
      },
    });
    return () => s.close();
  }, [t?.status, id]);
  // Вернулись с оплаты взноса — ждём подтверждения ЮKassa
  useEffect(() => {
    if (!paidReturn || mine?.entry?.status !== 'pending_payment') return undefined;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [paidReturn, mine?.entry?.status, load]);

  if (!t) {
    return (
      <div class="screen screen--paper">
        <Header back={{ href: `${BASE}tournaments`, label: 'Турниры' }} />
        <main class="wrap content plus">
          <ErrorNote error={error} />
          {!error ? <p class="muted loading">Загружаем турнир…</p> : null}
        </main>
      </div>
    );
  }

  const tz = tzOf(t);
  const state = entryState(t, mine);
  const left = placesLeft(t);

  const enter = async () => {
    setBusy(true);
    setError(null);
    setLimit(null);
    try {
      const res = await api.enterTournament(t.id);
      const url = safeRedirectUrl(res?.confirmation?.url);
      if (url) {
        window.location.assign(url);
        return;
      }
      setNotice('Вы записаны на турнир.');
      await load();
    } catch (err) {
      if (err?.code === 'rating_above_limit' || err?.code === 'rating_below_limit') setLimit({ ...(err.data ?? {}), below: err.code === 'rating_below_limit' });
      // №150: без ника записи нет — показываем форму ника вместо кнопки, запись продолжится после него
      else if (err?.code === 'no_profile') setProfile({ nick: null });
      else setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="screen screen--paper">
      <Header back={{ href: `${BASE}tournaments`, label: 'Турниры' }} />
      <section class="thero" data-theme="dark" aria-labelledby="t-title">
        <div class="wrap thero__in">
          <p class="thero__kicker">
            {t.club?.name}
            {t.club?.city ? ` · ${t.club.city}` : ''}
          </p>
          <h1 class="thero__title display" id="t-title">
            {t.title}
          </h1>
          <p class="thero__when">
            {formatDate(t.starts_at, tz)}, {weekday(t.starts_at, tz)} · <span class="mono">{formatTime(t.starts_at, tz)}</span>
          </p>
          <Badge status={t.status} />
        </div>
      </section>
      <main class="wrap content plus">
        <dl class="tfacts">
          <div>
            <dt>Дисциплина</dt>
            <dd>{DISCIPLINE_WORD[t.discipline]}</dd>
          </div>
          <div>
            <dt>Формат</dt>
            <dd>{FORMAT_WORD[t.format] ?? t.format}</dd>
          </div>
          <div>
            <dt>Матч</dt>
            <dd>
              до {t.race_to} {plural(t.race_to, WINS)}
              {t.discipline === 'pyramid' ? ', партия до 8 шаров' : ''}
            </dd>
          </div>
          <div>
            <dt>Рейтинг</dt>
            <dd>{t.rating_limit ? `до ${t.rating_limit}` : 'без ограничения'}</dd>
          </div>
          <div>
            <dt>Взнос</dt>
            <dd class="mono">{t.fee_kopecks ? formatMoney(t.fee_kopecks) : 'бесплатно'}</dd>
          </div>
          <div>
            <dt>Места</dt>
            <dd>
              {t.entries_count} из {t.places}
            </dd>
          </div>
          {t.prize_text ? (
            <div class="tfacts__wide">
              <dt>Призы</dt>
              <dd>{t.prize_text}</dd>
            </div>
          ) : null}
        </dl>

        {notice ? (
          <p class="note note--free" role="status">
            <Icon name="check" />
            <span class="note__title">{notice}</span>
          </p>
        ) : null}
        <ErrorNote error={error} />

        {status === 'anon' && t.status === 'registration' ? <SignIn title="Войдите, чтобы записаться" /> : null}

        {status === 'user' ? (
          <section class="tentry" aria-labelledby="te-title">
            <h2 class="visually-hidden" id="te-title">
              Запись
            </h2>
            {state === 'open' && profile?.nick === null ? (
              <NickGate
                fee={t.fee_kopecks}
                onDone={(p) => {
                  setProfile({ nick: p?.nick ?? null });
                  if (p?.nick) enter();
                }}
              />
            ) : null}
            {state === 'open' && profile?.nick !== null ? (
              <>
                <p class="hint">
                  {t.fee_kopecks ? 'Взнос возвращаем целиком, если отмените запись до её закрытия или клуб отменит турнир. После начала турнира взнос не возвращается.' : 'Участие бесплатное.'} Посев — по рейтингу в дисциплине.
                </p>
                <button type="button" class="btn btn--primary btn--block btn--lg" disabled={busy} onClick={enter}>
                  <Icon name="trophy" />
                  {busy ? 'Записываем…' : t.fee_kopecks ? `Записаться за ${formatMoney(t.fee_kopecks)}` : 'Записаться'}
                </button>
                {left !== null && left <= 3 ? <p class="muted small">Осталось {left} {plural(left, PLACES)}.</p> : null}
              </>
            ) : null}
            {limit ? (
              <div class="note note--lamp" role="alert">
                <Icon name="info" />
                <p class="note__title">{limit.below ? 'Записаться нельзя: рейтинг ниже порога' : 'Записаться нельзя: рейтинг выше лимита'}</p>
                <p class="note__body">{ratingLimitText(limit, t.discipline, limit.below)}</p>
                <div class="note__actions">
                  <a class="btn btn--secondary btn--sm" href={`${BASE}tournaments`} onClick={linkHandler}>
                    Другие турниры
                  </a>
                </div>
              </div>
            ) : null}
            {state === 'pending_payment' ? (
              <div class="note note--lamp" role="status">
                <Icon name="clock" />
                <p class="note__title">{paidReturn ? 'Ждём подтверждения оплаты…' : 'Взнос не оплачен'}</p>
                <p class="note__body">{paidReturn ? 'Обычно это несколько секунд — страница обновится сама.' : 'Место держим, пока идёт запись. Оплатите взнос, чтобы попасть в сетку.'}</p>
                {!paidReturn ? (
                  <div class="note__actions">
                    <button type="button" class="btn btn--primary btn--sm" disabled={busy} onClick={enter}>
                      Оплатить взнос
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {state === 'entered' ? (
              <div class="tin">
                <p class="tin__title">
                  <Icon name="check" />
                  Вы в турнире
                </p>
                {t.status === 'registration' ? (
                  <button type="button" class="btn btn--quiet btn--sm" onClick={() => setLeaving(true)}>
                    Отменить запись
                  </button>
                ) : null}
              </div>
            ) : null}
            {state === 'full' ? <p class="note">Все места заняты.</p> : null}
          </section>
        ) : null}

        {mine?.match ? <MyMatch match={mine.match} raceTo={t.race_to} onChange={load} /> : null}

        {t.bracket?.rounds?.length ? (
          <section aria-labelledby="t-br">
            <h2 class="step__label" id="t-br">
              Сетка
            </h2>
            <Bracket bracket={t.bracket} myNick={myNick} />
          </section>
        ) : null}

        {t.entries?.length ? (
          <details class="tentries">
            <summary>
              Участники <span class="count">{t.entries.length}</span>
            </summary>
            <ol class="tentries__list">
              {t.entries.map((p) => (
                <li key={p.nick} class={p.nick === myNick ? 'tentries__me' : ''}>
                  <span class="mono">{p.seed}</span>
                  <span>{p.nick}</span>
                  <span class="mono">{p.rating}</span>
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </main>
      <LeaveDialog
        open={leaving}
        t={t}
        onClose={() => setLeaving(false)}
        onDone={(res) => {
          setLeaving(false);
          setNotice(res?.refund_kopecks ? `Запись отменена. Вернём ${formatMoney(res.refund_kopecks)} тем же способом, что платили.` : 'Запись отменена.');
          load();
        }}
      />
    </div>
  );
}

/**
 * №150: на турнир записывают только с ником Бильярдум+ (сетка, ТВ, рейтинг ×1,5). Вместо «Записаться» — короткая
 * форма ника; после сохранения запись продолжается сама (со взносом — переход к оплате).
 */
function NickGate({ fee, onDone }) {
  const [nick, setNick] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ok = nickValid(nick.trim());
  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await api.updatePlus({ nick: nick.trim() }));
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <form class="nickgate" onSubmit={submit} noValidate aria-labelledby="ng-title">
      <h3 class="nickgate__title" id="ng-title">
        Создайте ник, чтобы участвовать
      </h3>
      <p class="hint">Под ником вас увидят в сетке, на экране клуба и в рейтинге — турнирные матчи идут в него с коэффициентом 1,5. Телефон и фамилию другие игроки не видят.</p>
      <div class="field">
        <label class="field__label" for="ng-nick">
          Ник
        </label>
        <input
          id="ng-nick"
          class="field__input"
          autoComplete="nickname"
          maxLength={20}
          value={nick}
          aria-invalid={tried && !ok ? 'true' : undefined}
          aria-describedby="ng-hint"
          onInput={(ev) => setNick(ev.currentTarget.value)}
        />
        {tried && !ok ? (
          <p class="field__error" id="ng-hint">
            От 3 до 20 букв и цифр, можно «_» и «-», без пробелов и номера телефона.
          </p>
        ) : (
          <p class="field__hint" id="ng-hint">
            Например: Кий_Мастер, Борт, Shark77. Поменять можно потом в Бильярдум+.
          </p>
        )}
      </div>
      <ErrorNote error={error} />
      <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
        {busy ? 'Сохраняем…' : fee ? `Сохранить ник и записаться за ${formatMoney(fee)}` : 'Сохранить ник и записаться'}
      </button>
    </form>
  );
}

function LeaveDialog({ open, t, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  return (
    <Dialog open={open} onClose={onClose} title="Отменить запись?" labelledBy="lv-title">
      <div class="form">
        <p class="lead">{t.fee_kopecks ? `Взнос ${formatMoney(t.fee_kopecks)} вернём целиком — запись ещё не закрыта.` : 'Место освободится для другого игрока.'}</p>
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
                onDone(await api.leaveTournament(t.id));
              } catch (err) {
                setError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Отменяем…' : 'Отменить запись'}
          </button>
          <button type="button" class="btn btn--quiet btn--lg" onClick={onClose}>
            Остаться
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** Мой матч: внести счёт до N побед или подтвердить счёт соперника; расхождение — организатору. */
function MyMatch({ match, raceTo, onChange }) {
  const mineKey = match.side === 'a' ? 'score_a' : 'score_b';
  const theirKey = match.side === 'a' ? 'score_b' : 'score_a';
  // Внесённый счёт: свой (если внёс я) или соперника — { score_a, score_b, at } (server/tournaments)
  const report = shownTournamentScore(match);
  const [mine, setMine] = useState(raceTo);
  const [theirs, setTheirs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const entered = match.status === 'pending_confirm';
  const ok = raceScoreValid(raceTo, mine, theirs);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const a = match.side === 'a' ? mine : theirs;
      const b = match.side === 'a' ? theirs : mine;
      await api.tournamentScore(match.id, a, b);
      setEditing(false);
      onChange();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      // Подтверждаем ровно показанный счёт: соперник успел переписать — 409 score_changed (M4-3)
      await api.confirmTournamentScore(match.id, report);
      onChange();
    } catch (err) {
      // Свежий счёт — перечитываем матч; текст ошибки остаётся: «Соперник изменил счёт — проверьте ещё раз»
      if (err?.code === 'score_changed') onChange();
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="mymatch" aria-labelledby="mm-title" data-theme="dark">
      <p class="mymatch__kicker">Ваш матч{match.table_number ? ` · стол ${match.table_number}` : ''}</p>
      <h2 class="mymatch__title display" id="mm-title">
        против {match.opponent_nick}
      </h2>
      {entered && !editing ? (
        <>
          <p class="mymatch__score display" aria-label={`Счёт ${report[mineKey]}:${report[theirKey]}`}>
            {report[mineKey]}:{report[theirKey]}
          </p>
          {match.i_confirmed ? (
            <p class="mymatch__hint">Вы внесли счёт — ждём подтверждения соперника.</p>
          ) : (
            <>
              <p class="mymatch__hint">Соперник внёс этот счёт. Всё верно?</p>
              <div class="mymatch__actions">
                <button type="button" class="btn btn--primary" disabled={busy} onClick={confirm}>
                  <Icon name="check" />
                  Подтвердить
                </button>
                <button type="button" class="btn btn--quiet" onClick={() => setEditing(true)}>
                  Счёт другой
                </button>
              </div>
            </>
          )}
        </>
      ) : match.status === 'disputed' ? (
        <p class="mymatch__hint">Счёт не совпал — организатор проверит и внесёт результат.</p>
      ) : (
        <>
          <p class="mymatch__hint">
            Матч до {raceTo} {plural(raceTo, WINS)}. После игры внесите счёт — соперник подтвердит.
            {editing ? ' Если счёт не совпадёт с его, решит организатор.' : ''}
          </p>
          <div class="scorepad">
            <TStep label="Вы" value={mine} onChange={setMine} max={raceTo} />
            <span class="scorepad__colon display" aria-hidden="true">
              :
            </span>
            <TStep label={match.opponent_nick} value={theirs} onChange={setTheirs} max={raceTo} />
          </div>
          {!ok ? <p class="field__error">У победителя ровно {raceTo}, у проигравшего меньше.</p> : null}
          <button type="button" class="btn btn--primary btn--block btn--lg" disabled={busy || !ok} onClick={send}>
            {busy ? 'Отправляем…' : `Внести счёт ${mine}:${theirs}`}
          </button>
        </>
      )}
      <ErrorNote error={error} />
    </section>
  );
}

function TStep({ label, value, onChange, max }) {
  return (
    <div class="stepper" role="group" aria-label={label}>
      <span class="stepper__label">{label}</span>
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
