import { useCallback, useEffect, useState } from 'preact/hooks';
import { formatDate, formatTime } from '@billiardum/shared/format';
import { ACHIEVEMENTS, DISCIPLINES, DISCIPLINE_WORD, levelTitle, nextLevel, nickValid, notCountedText } from '@billiardum/shared/plus';
import { Header } from '../components/Header.jsx';
import { Icon } from '../components/Icon.jsx';
import { Ill } from '../components/Ill.jsx';
import { Dialog } from '../components/Dialog.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { Seg } from '../components/Seg.jsx';
import { MatchCard, DisputeDialog } from '../components/MatchCard.jsx';
import { SignIn } from './SignIn.jsx';
import { api } from '../lib/api.js';
import { auth } from '../lib/auth.js';
import { useStore } from '../lib/store.js';
import { linkHandler, navigate } from '../lib/router.js';
import { BASE } from '../lib/env.js';
import { lastClub } from '../lib/flow.js';
import { ratingIn, seasonNow, zoneOf } from '../lib/plus.js';
// Списки-ссылки (.plinks) и пустые состояния — из стилей M3
import '../styles/m3.css';
import '../styles/m3-redesign.css';
import '../styles/m4.css';

const DISC_OPTIONS = DISCIPLINES.map((d) => [d, DISCIPLINE_WORD[d]]);
const BALL_MARK = { dry: '8:0', regular: '10', night_shift: '5', tournament: '1', five_clubs: '5', comeback: '3:7' };

/** Обёртка экранов Бильярдум+: шапка, вход, загрузка профиля. */
function PlusPage({ title, back = { href: `${BASE}plus`, label: 'Бильярдум+' }, children, signInTitle = 'Войдите, чтобы открыть Бильярдум+' }) {
  const { status } = useStore(auth);
  return (
    <div class="screen screen--paper">
      <Header back={back} />
      <main class="wrap content plus">
        <h1 class="page-title display">{title}</h1>
        {status === 'anon' ? <SignIn title={signInTitle} /> : null}
        {status === 'user' ? children : null}
      </main>
    </div>
  );
}

function useProfile() {
  const [me, setMe] = useState(undefined);
  const [error, setError] = useState(null);
  const { status } = useStore(auth);
  const load = useCallback(async () => {
    try {
      setMe(await api.plusMe());
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    if (status === 'user') load();
  }, [status, load]);
  return [me, setMe, error, load];
}

/** Шар-медаль достижения: получено — цветной шар с латунной полосой, нет — контур. */
function AchBall({ code, earned }) {
  return (
    <span class={`achball${earned ? ' achball--on' : ''}`} aria-hidden="true">
      <span class="achball__mark mono">{BALL_MARK[code] ?? '★'}</span>
    </span>
  );
}

/** Бильярдум+: ник, уровень, рейтинг по дисциплинам, разделы, достижения, история. */
export function PlusScreen() {
  const [me, setMe, error, load] = useProfile();
  return (
    <PlusPage title="Бильярдум+" back={{ href: `${BASE}me`, label: 'Профиль' }}>
      <ErrorNote error={error}>
        <button type="button" class="btn btn--secondary btn--sm" onClick={load}>
          Загрузить снова
        </button>
      </ErrorNote>
      {me === undefined && !error ? <p class="muted loading">Загружаем профиль…</p> : null}
      {me && !me.nick ? <NickSetup onDone={setMe} /> : null}
      {me?.nick ? (
        <PlayerCard card={me} self>
          <nav class="plinks" aria-label="Бильярдум+">
          <PlusLink href="plus/rating" icon="chart" title="Таблицы рейтинга" sub="Клуб, город, страна; месяц и всё время" />
          <PlusLink href="plus/rivals" icon="users" title="Ищу соперника" sub="Подбор ±150 рейтинга и приглашения «Сыграем?»" />
          <PlusLink href="plus/friends" icon="user" title="Друзья" sub="Кто из друзей сейчас в клубе" />
          <PlusLink href="tournaments" icon="trophy" title="Турниры" sub="Запись, сетка и мой матч" />
          <PlusLink href="plus/settings" icon="settings" title="Ник и приватность" sub="Что видят другие игроки" />
          </nav>
        </PlayerCard>
      ) : null}
    </PlusPage>
  );
}

function PlusLink({ href, icon, title, sub }) {
  return (
    <a class="plinks__item" href={`${BASE}${href}`} onClick={linkHandler}>
      <Icon name={icon} />
      <span>
        {title}
        <span class="plinks__sub">{sub}</span>
      </span>
      <Icon name="forward" />
    </a>
  );
}

/** Карточка игрока: себя — целиком, чужого — что он открыл. */
function PlayerCard({ card, self = false, children }) {
  const tz = zoneOf(lastClub()?.timezone);
  const main = [...(card.ratings ?? [])].sort((a, b) => b.games - a.games)[0] ?? ratingIn(card, 'pyramid');
  const up = nextLevel(main.rating);
  return (
    <>
      <section class="plus-hero" data-theme="dark" aria-labelledby="ph-nick">
        <p class="plus-hero__kicker">Бильярдум+</p>
        <h2 class="plus-hero__nick display" id="ph-nick">
          {card.nick}
        </h2>
        <p class="plus-hero__level">
          <span class="plus-hero__badge">{levelTitle(main.level, main.rating)}</span>
          <span>
            {DISCIPLINE_WORD[main.discipline]} · <span class="mono">{main.rating}</span>
          </span>
        </p>
        {self && up ? (
          <p class="plus-hero__next">
            До уровня «{up.next}» — <span class="mono">{up.left}</span>
          </p>
        ) : null}
      </section>

      <section aria-labelledby="pr-rt">
        <h2 class="step__label" id="pr-rt">
          Рейтинг по дисциплинам
        </h2>
        <ul class="rtiles">
          {DISCIPLINES.map((d) => {
            const r = card.ratings?.find((x) => x.discipline === d);
            return (
              <li class={`rtile${r ? '' : ' rtile--none'}`} key={d}>
                <span class="rtile__disc">{DISCIPLINE_WORD[d]}</span>
                <span class="rtile__value display">{r ? r.rating : '—'}</span>
                <span class="rtile__sub">{r ? `${levelTitle(r.level, r.rating)} · ${r.games} ${gamesWord(r.games)}` : 'ещё не играли'}</span>
                {r && r.season_rating !== undefined && r.season_rating !== r.rating ? <span class="rtile__season mono">месяц {r.season_rating}</span> : null}
              </li>
            );
          })}
        </ul>
      </section>

      {children}

      {card.achievements ? (
        <section aria-labelledby="pr-ach">
          <h2 class="step__label" id="pr-ach">
            Достижения <span class="count">{card.achievements.length}</span>
          </h2>
          <ul class="achs">
            {Object.entries(ACHIEVEMENTS)
              // Невыдаваемые пока (soon, «Камбэк» в M4) — только если уже получены
              .filter(([code, a]) => card.achievements.some((x) => x.code === code) || (self && !a.soon))
              .map(([code, a]) => {
                const got = card.achievements.find((x) => x.code === code);
                return (
                  <li class={`ach${got ? ' ach--on' : ''}`} key={code}>
                    <AchBall code={code} earned={Boolean(got)} />
                    <span class="ach__title">{a.title}</span>
                    <span class="ach__text">{got ? `${a.text} · ${formatDate(got.earned_at, tz)}` : a.text}</span>
                    {!got ? <span class="visually-hidden">Ещё не получено.</span> : null}
                  </li>
                );
              })}
          </ul>
        </section>
      ) : null}

      {card.history ? (
        <section aria-labelledby="pr-hist">
          <h2 class="step__label" id="pr-hist">
            Последние партии
          </h2>
          {card.history.length ? (
            <ul class="hist">
              {card.history.map((h) => (
                <li class={`hist__item hist__item--${h.result}`} key={h.match_id}>
                  <span class="hist__res" aria-hidden="true">
                    {h.result === 'win' ? 'П' : 'Пр'}
                  </span>
                  <span class="hist__main">
                    <span class="hist__who">
                      <span class="visually-hidden">{h.result === 'win' ? 'Победа' : 'Поражение'}: </span>
                      {h.opponent_nick}
                    </span>
                    <span class="hist__sub">
                      {DISCIPLINE_WORD[h.discipline]}
                      {h.tournament ? ' · турнир' : ''} · {formatDate(h.at, tz)}
                      {h.club_name ? ` · ${h.club_name}` : ''}
                    </span>
                    {!h.counted ? <span class="hist__nc">{notCountedText(h.not_counted_reason) ?? 'в рейтинг не засчитана'}</span> : null}
                  </span>
                  <span class="hist__score mono">
                    {h.my_score}:{h.opponent_score}
                  </span>
                  <span class={`hist__delta mono${h.delta > 0 ? ' hist__delta--up' : h.delta < 0 ? ' hist__delta--down' : ''}`}>
                    {h.counted && h.delta !== null ? (h.delta > 0 ? `+${h.delta}` : `${h.delta}`) : '—'}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div class="empty">
              <Ill name="cue" />
              <p class="hint">Партий пока нет. Сыграйте за столом и запишите счёт на экране игры — соперник подтвердит, и рейтинг пересчитается.</p>
            </div>
          )}
        </section>
      ) : null}
    </>
  );
}

const GAMES = ['партия', 'партии', 'партий'];
function gamesWord(n) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return GAMES[2];
  if (b > 1 && b < 5) return GAMES[1];
  if (b === 1) return GAMES[0];
  return GAMES[2];
}

/** Первый вход в Бильярдум+: придумать ник (без телефона и фамилии, №138). */
function NickSetup({ onDone }) {
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
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="step" onSubmit={submit} noValidate aria-labelledby="nick-title">
      <div class="empty">
        <Ill name="rack" />
      </div>
      <h2 class="step__title" id="nick-title">
        Придумайте ник
      </h2>
      <p class="hint">Под ником вас увидят в таблицах рейтинга и турнирных сетках. Телефон и фамилию другие игроки не видят.</p>
      <div class="field">
        <label class="field__label" for="nick">
          Ник
        </label>
        <input
          id="nick"
          class="field__input"
          autoComplete="nickname"
          maxLength={20}
          value={nick}
          aria-invalid={tried && !ok ? 'true' : undefined}
          aria-describedby="nick-hint"
          onInput={(ev) => setNick(ev.currentTarget.value)}
        />
        {tried && !ok ? (
          <p class="field__error" id="nick-hint">
            От 3 до 20 букв и цифр, можно «_» и «-», без пробелов и номера телефона.
          </p>
        ) : (
          <p class="field__hint" id="nick-hint">
            Например: Кий_Мастер, Борт, Shark77.
          </p>
        )}
      </div>
      <ErrorNote error={error} />
      <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
        {busy ? 'Сохраняем…' : 'Сохранить ник'}
      </button>
    </form>
  );
}

const PRIVACY = [
  ['show_history', 'История партий', 'Соперники, счёт и изменения рейтинга'],
  ['show_achievements', 'Достижения', '«Сухая», «Ночная смена» и другие'],
  ['show_clubs', 'Клубы, где я играю', 'Названия клубов в профиле'],
  ['friends_see_in_club', 'Друзья видят, что я в клубе', 'Только друзьям и только пока идёт игра'],
];

/** Ник и приватность: по умолчанию видны ник, уровень и рейтинг, остальное — по выбору (№138). */
export function PlusSettings() {
  const [me, setMe, error] = useProfile();
  const [nick, setNick] = useState('');
  const [privacy, setPrivacy] = useState({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!me) return;
    setNick(me.nick ?? '');
    setPrivacy(me.privacy ?? {});
  }, [me?.nick]);
  const ok = nickValid(nick.trim());
  const submit = async (e) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    setSaveError(null);
    setSaved(false);
    try {
      setMe(await api.updatePlus({ ...(nick.trim() !== me.nick ? { nick: nick.trim() } : {}), privacy }));
      setSaved(true);
    } catch (err) {
      setSaveError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <PlusPage title="Ник и приватность">
      <ErrorNote error={error} />
      {me === undefined && !error ? <p class="muted loading">Загружаем…</p> : null}
      {me ? (
        <form class="step" onSubmit={submit} noValidate>
          <div class="field">
            <label class="field__label" for="nick-edit">
              Ник
            </label>
            <input id="nick-edit" class="field__input" maxLength={20} value={nick} aria-invalid={!ok ? 'true' : undefined} aria-describedby="nick-edit-hint" onInput={(ev) => setNick(ev.currentTarget.value)} />
            <p class={ok ? 'field__hint' : 'field__error'} id="nick-edit-hint">
              {ok ? 'Виден в таблицах и сетках турниров.' : 'От 3 до 20 букв и цифр, можно «_» и «-», без пробелов и номера телефона.'}
            </p>
          </div>
          <fieldset class="privacy">
            <legend class="step__label">Что видят другие игроки</legend>
            <p class="hint">Ник, уровень и рейтинг видны всем — без них нет таблиц. Остальное включайте сами.</p>
            {PRIVACY.map(([key, title, sub]) => (
              <label class="toggle" key={key}>
                <input type="checkbox" checked={Boolean(privacy[key])} onChange={(ev) => setPrivacy((p) => ({ ...p, [key]: ev.currentTarget.checked }))} />
                <span class="toggle__text">
                  <span class="toggle__title">{title}</span>
                  <span class="toggle__sub">{sub}</span>
                </span>
                <span class="toggle__switch" aria-hidden="true" />
              </label>
            ))}
          </fieldset>
          <ErrorNote error={saveError} />
          {saved ? (
            <p class="note note--free" role="status">
              <Icon name="check" />
              <span class="note__title">Сохранили.</span>
            </p>
          ) : null}
          <div class="actionbar">
            <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy || !ok}>
              {busy ? 'Сохраняем…' : 'Сохранить'}
            </button>
          </div>
        </form>
      ) : null}
    </PlusPage>
  );
}

const SCOPES = [
  ['club', 'Клуб'],
  ['city', 'Город'],
  ['country', 'Страна'],
];

/** Таблицы рейтинга: дисциплина, клуб/город/страна, месяц или всё время (№137). */
export function RatingScreen() {
  const club = useClubs()[0] ?? null;
  const [discipline, setDiscipline] = useState('pyramid');
  const [scope, setScope] = useState(club?.id ? 'club' : 'country');
  const [season, setSeason] = useState('month');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const mine = useMyProfile();
  const myNick = mine?.nick ?? null;
  // Скрыл клубы (show_clubs=false, №145) — в таблицах клуба и города его нет, me: null
  const hiddenClubs = mine?.privacy?.show_clubs === false && (scope === 'club' || scope === 'city');
  useEffect(() => {
    let alive = true;
    setData(null);
    api
      .rating({ discipline, scope, ...(scope === 'club' && club?.id ? { club: club.id } : {}), season: season === 'month' ? seasonNow() : 'all' }, auth.get().status === 'user')
      .then((d) => alive && (setData(d), setError(null)))
      .catch((err) => alive && setError(err));
    return () => {
      alive = false;
    };
  }, [discipline, scope, season, club?.id]);
  return (
    <PlusPage title="Рейтинг" signInTitle="Войдите, чтобы увидеть своё место">
      <div class="filters-plus">
        <Seg name="rt-d" legend="Дисциплина" value={discipline} options={DISC_OPTIONS} onChange={setDiscipline} hideLegend />
        <Seg name="rt-s" legend="Таблица" value={scope} options={club?.id ? SCOPES : SCOPES.slice(1)} onChange={setScope} hideLegend />
        <Seg
          name="rt-p"
          legend="Период"
          value={season}
          options={[
            ['month', 'Этот месяц'],
            ['all', 'Всё время'],
          ]}
          onChange={setSeason}
          hideLegend
        />
      </div>
      {data?.me ? (
        <p class="myplace" role="status">
          Вы — <b class="display">{data.me.place}</b> место · рейтинг <span class="mono">{data.me.rating}</span>
        </p>
      ) : null}
      {data && !data.me && hiddenClubs ? (
        <p class="note" role="status">
          <Icon name="info" />
          <span class="note__title">Вы скрыли клубы — вас нет в таблицах клуба и города.</span>
          <span class="note__body">
            Показать можно в{' '}
            <a href={`${BASE}plus/settings`} onClick={linkHandler}>
              настройках приватности
            </a>
            .
          </span>
        </p>
      ) : null}
      <ErrorNote error={error} />
      {data === null && !error ? <p class="muted loading">Считаем таблицу…</p> : null}
      {data?.items?.length ? (
        <ol class="rtable" aria-label={`Рейтинг: ${DISCIPLINE_WORD[discipline]}`}>
          {data.items.map((p) => (
            <li class={`rtable__row${p.place <= 3 ? ` rtable__row--top rtable__row--${p.place}` : ''}${p.nick === myNick ? ' rtable__row--me' : ''}`} key={p.nick}>
              <span class="rtable__place mono">{p.place}</span>
              <a class="rtable__nick" href={`${BASE}players/${encodeURIComponent(p.nick)}`} onClick={linkHandler}>
                {p.nick}
                {p.nick === myNick ? <span class="person__tag">вы</span> : null}
              </a>
              <span class="rtable__level">{levelTitle(p.level, p.rating)}</span>
              <span class="rtable__rating mono">{p.rating}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {data && !data.items?.length ? (
        <div class="empty">
          <Ill name="rack" />
          <p class="hint">В этой таблице пока никого. Сыграйте партию и подтвердите счёт — вы будете первым.</p>
        </div>
      ) : null}
    </PlusPage>
  );
}

function useMyProfile() {
  const [me, setMe] = useState(null);
  const { status } = useStore(auth);
  useEffect(() => {
    if (status === 'user')
      api
        .plusMe()
        .then((m) => setMe(m ?? null))
        .catch(() => {});
  }, [status]);
  return me;
}

function useMyNick() {
  return useMyProfile()?.nick ?? null;
}

/** Профиль другого игрока: что он открыл, «В друзья». */
export function PlayerScreen({ nick }) {
  const [card, setCard] = useState(undefined);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const myNick = useMyNick();
  useEffect(() => {
    api.player(nick).then(setCard, (err) => (setError(err), setCard(null)));
  }, [nick]);
  return (
    <PlusPage title="Игрок" back={{ href: `${BASE}plus/rating`, label: 'Рейтинг' }}>
      <ErrorNote error={error} />
      {card === undefined ? <p class="muted loading">Загружаем…</p> : null}
      {card ? <PlayerCard card={card} self={card.nick === myNick} /> : null}
      {card && card.nick !== myNick ? (
        <div class="stack">
          {notice ? (
            <p class="note note--free" role="status">
              <Icon name="check" />
              <span class="note__title">{notice}</span>
            </p>
          ) : null}
          <button
            type="button"
            class="btn btn--secondary btn--block btn--lg"
            onClick={async () => {
              try {
                await api.addFriend(card.nick);
                setNotice(`Заявка в друзья отправлена: ${card.nick}.`);
              } catch (err) {
                setError(err);
              }
            }}
          >
            <Icon name="plus" />
            Добавить в друзья
          </button>
        </div>
      ) : null}
    </PlusPage>
  );
}

/** «Ищу соперника» и приглашения «Сыграем?» (№139). */
/** Клубы на платформе (GET /api/clubs) — для «Ищу соперника» и таблицы клуба; последний открытый — первым. */
function useClubs() {
  const [list, setList] = useState(() => (lastClub()?.id ? [lastClub()] : []));
  useEffect(() => {
    api
      .clubs()
      .then((r) => {
        const all = Array.isArray(r) ? r : (r?.items ?? []);
        const last = lastClub();
        setList(last?.id ? [last, ...all.filter((c) => c.id !== last.id)] : all);
      })
      .catch(() => {});
  }, []);
  return list;
}

export function RivalsScreen() {
  const clubs = useClubs();
  const [picked, setPicked] = useState(null);
  const chosen = picked ?? (clubs[0]?.id ? [clubs[0].id] : []);
  const club = clubs.find((c) => c.id === chosen[0]) ?? lastClub();
  const tz = zoneOf(club?.timezone);
  const [state, setState] = useState(null);
  const [invites, setInvites] = useState(null);
  const [discipline, setDiscipline] = useState('pyramid');
  const [when, setWhen] = useState('today');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [inviting, setInviting] = useState(null);
  const [notice, setNotice] = useState(null);
  const { status } = useStore(auth);

  const load = useCallback(async () => {
    try {
      const [l, i] = await Promise.all([api.lfg(), api.invites()]);
      setState(l);
      setInvites(i);
      if (l?.lfg?.discipline) setDiscipline(l.lfg.discipline);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    if (status === 'user') load();
  }, [status, load]);

  const start = async () => {
    setBusy(true);
    setError(null);
    const day = when === 'today' ? 0 : 1;
    const from = new Date(Date.now() + day * 86400000);
    from.setMinutes(0, 0, 0);
    if (day === 0) from.setHours(from.getHours() + 1);
    else from.setHours(18);
    const to = new Date(from.getTime() + 5 * 3600000);
    try {
      setState(await api.startLfg({ discipline, from: from.toISOString(), to: to.toISOString(), club_ids: chosen }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const answer = async (inv, accept) => {
    try {
      const res = await api.answerInvite(inv.id, accept);
      setNotice(accept ? `Играете с ${inv.from.nick} ${formatDate(res.starts_at, tz)} в ${formatTime(res.starts_at, tz)} — бронь на двоих создана.` : 'Приглашение отклонено.');
      load();
    } catch (err) {
      setError(err);
    }
  };

  const pending = invites?.incoming?.filter((i) => i.status === 'pending') ?? [];
  return (
    <PlusPage title="Ищу соперника">
      <ErrorNote error={error} />
      {notice ? (
        <p class="note note--free" role="status">
          <Icon name="check" />
          <span class="note__title">{notice}</span>
        </p>
      ) : null}

      {pending.length ? (
        <section aria-labelledby="inv-in">
          <h2 class="step__label" id="inv-in">
            Вас зовут сыграть <span class="count">{pending.length}</span>
          </h2>
          <ul class="invites">
            {pending.map((inv) => (
              <li class="invite" key={inv.id}>
                <p class="invite__title">
                  <b>{inv.from.nick}</b>: «Сыграем?»
                </p>
                <p class="invite__sub">
                  {DISCIPLINE_WORD[inv.discipline]} · {inv.club.name} · {formatDate(inv.starts_at, tz)}, <span class="mono">{formatTime(inv.starts_at, tz)}</span> · {inv.minutes / 60} ч
                </p>
                <div class="invite__actions">
                  <button type="button" class="btn btn--primary btn--sm" onClick={() => answer(inv, true)}>
                    Сыграем
                  </button>
                  <button type="button" class="btn btn--quiet btn--sm" onClick={() => answer(inv, false)}>
                    Не сейчас
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {state && !state.lfg ? (
        <section class="step" aria-labelledby="lfg-title">
          <h2 class="step__label" id="lfg-title">
            Найти соперника своего уровня
          </h2>
          <Seg name="lfg-d" legend="Дисциплина" value={discipline} options={DISC_OPTIONS} onChange={setDiscipline} />
          <Seg
            name="lfg-w"
            legend="Когда"
            value={when}
            options={[
              ['today', 'Сегодня вечером'],
              ['tomorrow', 'Завтра'],
            ]}
            onChange={setWhen}
          />
          {clubs.length > 1 ? (
            <fieldset class="seg">
              <legend class="seg__legend">Клубы</legend>
              <div class="seg__row">
                {clubs.slice(0, 10).map((c) => (
                  <label class="seg__item" key={c.id}>
                    <input
                      type="checkbox"
                      checked={chosen.includes(c.id)}
                      onChange={(ev) => {
                        const on = ev.currentTarget.checked;
                        setPicked(on ? [...chosen, c.id] : chosen.filter((x) => x !== c.id));
                      }}
                    />
                    <span class="seg__box">{c.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <p class="hint">Покажем игроков с рейтингом ±150 от вашего{clubs.length === 1 && club?.name ? `, которые играют в «${club.name}»` : ''}. Пригласить можно до 10 человек в день.</p>
          {!chosen.length ? <p class="field__error">Выберите хотя бы один клуб.</p> : null}
          <button type="button" class="btn btn--primary btn--block btn--lg" disabled={busy || !chosen.length} onClick={start}>
            <Icon name="search" />
            {busy ? 'Ищем…' : 'Ищу соперника'}
          </button>
        </section>
      ) : null}

      {state?.lfg ? (
        <section aria-labelledby="cand-title">
          <div class="lfg-on">
            <span class="lfg-on__dot" aria-hidden="true" />
            <p>
              Вы в поиске: {DISCIPLINE_WORD[state.lfg.discipline]}
              {state.lfg.from ? ` · с ${formatTime(state.lfg.from, tz)}` : ''}
            </p>
            <button
              type="button"
              class="btn btn--quiet btn--sm"
              onClick={async () => {
                try {
                  setState(await api.stopLfg());
                } catch (err) {
                  setError(err);
                }
              }}
            >
              Не ищу
            </button>
          </div>
          <h2 class="step__label" id="cand-title">
            Подходят по рейтингу <span class="count">{state.candidates.length}</span>
          </h2>
          {state.candidates.length ? (
            <ul class="people-g">
              {state.candidates.map((c) => (
                <li class="pg" key={c.user_id}>
                  <span class="pg__avatar display" aria-hidden="true">
                    {c.nick.slice(0, 1)}
                  </span>
                  <span class="pg__main">
                    <a class="pg__nick" href={`${BASE}players/${encodeURIComponent(c.nick)}`} onClick={linkHandler}>
                      {c.nick}
                    </a>
                    <span class="pg__sub">
                      {levelTitle(c.level, c.rating)} · <span class="mono">{c.rating}</span>
                      {c.clubs?.length ? ` · ${c.clubs.join(', ')}` : ''}
                    </span>
                  </span>
                  <button type="button" class="btn btn--secondary btn--sm" onClick={() => setInviting(c)}>
                    Сыграем?
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div class="empty">
              <Ill name="pocket" />
              <p class="hint">Пока никого подходящего. Оставайтесь в поиске — пришлём уведомление, когда кто-то позовёт.</p>
            </div>
          )}
        </section>
      ) : null}

      {invites?.outgoing?.length ? (
        <section aria-labelledby="inv-out">
          <h2 class="step__label" id="inv-out">
            Ваши приглашения
          </h2>
          <ul class="invites invites--quiet">
            {invites.outgoing.map((inv) => (
              <li class="invite" key={inv.id}>
                <p class="invite__title">
                  {inv.to.nick} · {INVITE_WORD[inv.status] ?? inv.status}
                </p>
                <p class="invite__sub">
                  {DISCIPLINE_WORD[inv.discipline]} · {formatDate(inv.starts_at, tz)}, <span class="mono">{formatTime(inv.starts_at, tz)}</span>
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <InviteDialog
        to={inviting}
        discipline={state?.lfg?.discipline ?? discipline}
        club={club}
        onClose={() => setInviting(null)}
        onDone={(inv) => {
          setInviting(null);
          setNotice(`Приглашение отправлено: ${inv.to.nick}. Как только примет — появится бронь на двоих.`);
          load();
        }}
      />
    </PlusPage>
  );
}

const INVITE_WORD = { pending: 'ждём ответа', accepted: 'принял — бронь создана', declined: 'отказался', expired: 'не ответил' };

function InviteDialog({ to, discipline, club, onClose, onDone }) {
  const tz = zoneOf(club?.timezone);
  const [slot, setSlot] = useState(null);
  const [minutes, setMinutes] = useState('120');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const slots = [];
  const base = new Date();
  base.setMinutes(0, 0, 0);
  for (let i = 2; slots.length < 6; i += 1) slots.push(new Date(base.getTime() + i * 3600000).toISOString());
  useEffect(() => {
    setSlot(slots[0]);
    setError(null);
  }, [to?.user_id]);
  if (!to) return <Dialog open={false} onClose={onClose} title="" />;
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.invite({ to_user_id: to.user_id, discipline, club_id: club?.id, starts_at: slot, minutes: Number(minutes) }));
    } catch (err) {
      setError(err?.code === 'rate_limited' || err?.code === 'limit_exceeded' ? { code: 'invite_limit' } : err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title={`Сыграем с ${to.nick}?`} labelledBy="inv-title">
      <div class="form">
        <p class="hint">
          {DISCIPLINE_WORD[discipline]}
          {club?.name ? ` · ${club.name}` : ''}. Примет — бронь на двоих создастся сама.
        </p>
        <fieldset class="seg">
          <legend class="seg__legend">Во сколько</legend>
          <div class="seg__row">
            {slots.map((s) => (
              <label class="seg__item" key={s}>
                <input type="radio" name="inv-slot" checked={slot === s} onChange={() => setSlot(s)} />
                <span class="seg__box mono">{formatTime(s, tz)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <Seg
          name="inv-len"
          legend="Сколько играем"
          value={minutes}
          options={[
            ['60', '1 час'],
            ['120', '2 часа'],
            ['180', '3 часа'],
          ]}
          onChange={setMinutes}
        />
        <ErrorNote error={error} />
        <div class="dialog__actions">
          <button type="button" class="btn btn--primary btn--block btn--lg" disabled={busy || !slot} onClick={send}>
            {busy ? 'Отправляем…' : 'Отправить «Сыграем?»'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** Друзья: сейчас в клубе (с разрешения друга), список, заявки, добавить по нику. */
export function FriendsScreen() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [nick, setNick] = useState('');
  const [notice, setNotice] = useState(null);
  const { status } = useStore(auth);
  const load = useCallback(() => api.friends().then((d) => (setData(d), setError(null)), setError), []);
  useEffect(() => {
    if (status === 'user') load();
  }, [status, load]);
  const act = async (fn, msg) => {
    try {
      setData(await fn());
      if (msg) setNotice(msg);
      setError(null);
    } catch (err) {
      setError(err);
    }
  };
  const inClub = data?.friends?.filter((f) => f.in_club_now) ?? [];
  return (
    <PlusPage title="Друзья">
      <ErrorNote error={error} />
      {notice ? (
        <p class="note note--free" role="status">
          <Icon name="check" />
          <span class="note__title">{notice}</span>
        </p>
      ) : null}
      {data === null && !error ? <p class="muted loading">Загружаем друзей…</p> : null}

      {inClub.length ? (
        <section class="inclub" aria-labelledby="fr-now" data-theme="dark">
          <h2 class="inclub__title" id="fr-now">
            <span class="inclub__lamp" aria-hidden="true" />
            Сейчас в клубе
          </h2>
          <ul class="inclub__list">
            {inClub.map((f) => (
              <li key={f.user_id}>
                <b>{f.nick}</b> — {f.in_club_now.club_name}, с <span class="mono">{formatTime(f.in_club_now.since, zoneOf(lastClub()?.timezone))}</span>
              </li>
            ))}
          </ul>
          <p class="inclub__note">Видно только тех друзей, кто это разрешил.</p>
        </section>
      ) : null}

      {data?.incoming?.length ? (
        <section aria-labelledby="fr-in">
          <h2 class="step__label" id="fr-in">
            Заявки в друзья <span class="count">{data.incoming.length}</span>
          </h2>
          <ul class="people-g">
            {data.incoming.map((f) => (
              <li class="pg" key={f.user_id}>
                <span class="pg__avatar display" aria-hidden="true">
                  {f.nick.slice(0, 1)}
                </span>
                <span class="pg__main">
                  <span class="pg__nick">{f.nick}</span>
                  <span class="pg__sub">{levelTitle(f.level)}</span>
                </span>
                <span class="pg__tools">
                  <button type="button" class="btn btn--primary btn--sm" onClick={() => act(() => api.addFriend(f.nick), `${f.nick} теперь в друзьях.`)}>
                    Принять
                  </button>
                  <button type="button" class="btn btn--quiet btn--sm" aria-label={`Отклонить заявку ${f.nick}`} onClick={() => act(() => api.removeFriend(f.user_id))}>
                    Нет
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data ? (
        <section aria-labelledby="fr-list">
          <h2 class="step__label" id="fr-list">
            Друзья <span class="count">{data.friends.length}</span>
          </h2>
          {data.friends.length ? (
            <ul class="people-g">
              {data.friends.map((f) => (
                <li class="pg" key={f.user_id}>
                  <span class={`pg__avatar display${f.in_club_now ? ' pg__avatar--lit' : ''}`} aria-hidden="true">
                    {f.nick.slice(0, 1)}
                  </span>
                  <span class="pg__main">
                    <a class="pg__nick" href={`${BASE}players/${encodeURIComponent(f.nick)}`} onClick={linkHandler}>
                      {f.nick}
                    </a>
                    <span class="pg__sub">
                      {levelTitle(f.level, f.rating)}
                      {f.rating ? (
                        <>
                          {' '}
                          · <span class="mono">{f.rating}</span>
                        </>
                      ) : null}
                    </span>
                  </span>
                  <button type="button" class="btn btn--quiet btn--sm pg__remove" aria-label={`Убрать ${f.nick} из друзей`} onClick={() => act(() => api.removeFriend(f.user_id), `${f.nick} больше не в друзьях.`)}>
                    <Icon name="close" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div class="empty">
              <Ill name="cue" />
              <p class="hint">Друзей пока нет. Добавьте по нику — или сыграйте партию: после неё легко позвать соперника в друзья.</p>
            </div>
          )}
          {data.outgoing?.length ? <p class="muted small">Ждут ответа: {data.outgoing.map((f) => f.nick).join(', ')}.</p> : null}
        </section>
      ) : null}

      <form
        class="addfriend"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (nick.trim().length < 3) return;
          act(() => api.addFriend(nick.trim()), `Заявка отправлена: ${nick.trim()}.`).then(() => setNick(''));
        }}
      >
        <label class="field__label" for="fr-nick">
          Добавить по нику
        </label>
        <div class="addfriend__row">
          <input id="fr-nick" class="field__input" maxLength={20} value={nick} placeholder="Ник игрока" onInput={(e) => setNick(e.currentTarget.value)} />
          <button type="submit" class="btn btn--secondary">
            Добавить
          </button>
        </div>
      </form>
    </PlusPage>
  );
}

/** Партия по ссылке из уведомления: подтвердить или оспорить (T22/T23). */
export function MatchScreen({ id }) {
  const { user } = useStore(auth);
  const [m, setM] = useState(undefined);
  const [error, setError] = useState(null);
  const [disputing, setDisputing] = useState(false);
  useEffect(() => {
    api.match(id).then(setM, (err) => (setError(err), setM(null)));
  }, [id]);
  return (
    <PlusPage title="Партия" signInTitle="Войдите, чтобы подтвердить партию">
      <ErrorNote error={error} />
      {m === undefined ? <p class="muted loading">Загружаем…</p> : null}
      {m ? <MatchCard match={m} meId={user?.id} onChange={setM} onDispute={() => setDisputing(true)} big /> : null}
      {m ? (
        <a class="btn btn--quiet btn--block" href={`${BASE}plus`} onClick={linkHandler}>
          К профилю Бильярдум+
        </a>
      ) : null}
      <DisputeDialog match={disputing ? m : null} onClose={() => setDisputing(false)} onDone={(x) => (setM(x), setDisputing(false))} />
    </PlusPage>
  );
}

/** Нет такого экрана Бильярдум+ — на главную раздела. */
export function goPlus() {
  navigate(`${BASE}plus`, { replace: true });
}
