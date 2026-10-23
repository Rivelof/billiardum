import { useEffect, useState } from 'preact/hooks';
import { formatDate, formatTime } from '@billiardum/shared/format';
import { addDays, localDate, zonedMs } from '@billiardum/shared/booking';
import { Header } from '../components/Header.jsx';
import { Icon } from '../components/Icon.jsx';
import { Ill } from '../components/Ill.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { Seg } from '../components/Seg.jsx';
import { SignIn } from './SignIn.jsx';
import { api } from '../lib/api.js';
import { auth } from '../lib/auth.js';
import { useStore } from '../lib/store.js';
import { linkHandler, navigate } from '../lib/router.js';
import { BASE } from '../lib/env.js';
import { lastClub } from '../lib/flow.js';
import { CLUB_ANSWER_KEY, REQUEST_STATUS, REVIEW_MAX, clubAnswerState, maskPhones, parseClubAnswer, peopleWords, zoneOf } from '../lib/plus.js';
import { minutesWords } from '../lib/words.js';
import { local } from '../lib/store.js';
import { DISCIPLINES, DISCIPLINE_WORD } from '@billiardum/shared/plus';
// Дни-фишки (.days, .day) и списки — из стилей M3
import '../styles/m3.css';
import '../styles/m3-redesign.css';
import '../styles/m4.css';

const STAR_WORD = ['', 'Плохо', 'Так себе', 'Нормально', 'Хорошо', 'Отлично'];

/**
 * Отзыв о клубе после игры (№141): оценка 1–5 шарами и текст до 1 000 знаков. Оставить может гость с игрой или
 * бронью в клубе за 90 дней (иначе 403 review_not_allowed); один отзыв на клуб — повторно он редактируется.
 */
export function ReviewScreen({ clubId, search }) {
  const { status } = useStore(auth);
  const name = new URLSearchParams(search ?? '').get('name') ?? (lastClub()?.id === clubId ? lastClub()?.name : null);
  const [rating, setRating] = useState(0);
  const [text, setText] = useState('');
  const [existing, setExisting] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (status !== 'user') return;
    api
      .myReview(clubId)
      .then((r) => {
        setExisting(r ?? null);
        if (r) {
          setRating(r.rating);
          setText(r.text ?? '');
        }
      })
      .catch(() => setExisting(null));
  }, [status, clubId]);

  const submit = async (e) => {
    e.preventDefault();
    if (!rating) return;
    setBusy(true);
    setError(null);
    try {
      await api.review({ club_id: clubId, rating, text: maskPhones(text.trim()) });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="screen screen--paper">
      <Header back={{ href: BASE, label: 'На главную' }} />
      <main class="wrap content plus">
        <h1 class="page-title display">{existing ? 'Ваш отзыв' : 'Как вам клуб?'}</h1>
        {name ? <p class="lead">{name}</p> : null}
        {status === 'anon' ? <SignIn title="Войдите, чтобы оставить отзыв" /> : null}
        {status === 'user' && done ? (
          <div class="empty">
            <Ill name="lamp" />
            <p class="step__title">Спасибо!</p>
            <p class="hint">Отзыв появится на странице клуба в Бильярдуме. Клуб может на него ответить.</p>
            <a class="btn btn--secondary" href={BASE} onClick={linkHandler}>
              На главную
            </a>
          </div>
        ) : null}
        {status === 'user' && !done ? (
          <form class="step" onSubmit={submit} noValidate>
            <fieldset class="stars">
              <legend class="step__label">Оценка</legend>
              <div class="stars__row">
                {[1, 2, 3, 4, 5].map((n) => (
                  <label class={`stars__item${n <= rating ? ' stars__item--on' : ''}`} key={n}>
                    <input type="radio" name="rv-rating" value={n} checked={rating === n} onChange={() => setRating(n)} />
                    <span class="stars__ball" aria-hidden="true">
                      {n}
                    </span>
                    <span class="visually-hidden">
                      {n} из 5 — {STAR_WORD[n]}
                    </span>
                  </label>
                ))}
              </div>
              <p class="stars__word" aria-hidden="true">
                {STAR_WORD[rating] || 'Выберите от 1 до 5'}
              </p>
            </fieldset>
            <div class="field">
              <label class="field__label" for="rv-text">
                Что понравилось, что нет
              </label>
              <textarea id="rv-text" class="field__input field__input--area" rows={5} maxLength={REVIEW_MAX} value={text} aria-describedby="rv-count" onInput={(e) => setText(e.currentTarget.value)} />
              <p class="field__hint" id="rv-count">
                <span class="mono">{text.length}</span> из {REVIEW_MAX}. Телефоны в тексте мы скроем.
              </p>
            </div>
            <ErrorNote error={error} />
            <div class="actionbar">
              <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy || !rating}>
                {busy ? 'Отправляем…' : existing ? 'Сохранить отзыв' : 'Отправить отзыв'}
              </button>
            </div>
          </form>
        ) : null}
      </main>
    </div>
  );
}

const HOURS = Array.from({ length: 15 }, (_, i) => 10 + i); // 10:00–24:00

/** Заявка в клуб без программы (T25): клуб получает её в мессенджер, 15 минут без ответа — оператору. */
export function RequestScreen({ listingId }) {
  const { status } = useStore(auth);
  const [listing, setListing] = useState(undefined);
  const [error, setError] = useState(null);
  const tz = zoneOf(listing?.timezone, lastClub()?.timezone);
  const today = localDate(Date.now(), tz);
  const [date, setDate] = useState(today);
  const [hour, setHour] = useState(() => Math.min(23, new Date().getHours() + 2));
  const [minutes, setMinutes] = useState('120');
  const [people, setPeople] = useState(2);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.listing(listingId).then(setListing, (err) => (setError(err), setListing(null)));
  }, [listingId]);
  const days = [0, 1, 2, 3, 4, 5, 6].map((n) => addDays(today, n));
  const startsAt = zonedMs(date, hour * 60, tz);
  const past = startsAt < Date.now();
  const submit = async (e) => {
    e.preventDefault();
    if (past) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.clubRequest({ listing_id: listingId, starts_at: new Date(startsAt).toISOString(), minutes: Number(minutes), people, comment: comment.trim() });
      navigate(`${BASE}requests/${encodeURIComponent(r.id)}`, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="screen screen--paper">
      <Header back={{ href: BASE, label: 'На главную' }} />
      <main class="wrap content plus">
        <h1 class="page-title display">Заявка на стол</h1>
        {listing === undefined ? <p class="muted loading">Загружаем клуб…</p> : null}
        <ErrorNote error={error} />
        {listing ? (
          <div class="lcard">
            <p class="lcard__name">{listing.name}</p>
            <p class="lcard__sub">
              {listing.city}
              {listing.address ? `, ${listing.address}` : ''}
            </p>
            <p class="lcard__note">
              <Icon name="info" />
              Клуб пока без программы Бильярдума: бронь по заявке. Отправим её в клуб, а если он не ответит за 15 минут — подключим нашего оператора.
            </p>
          </div>
        ) : null}
        {listing && status === 'anon' ? <SignIn title="Войдите, чтобы отправить заявку" /> : null}
        {listing && status === 'user' ? (
          <form class="step" onSubmit={submit} noValidate>
            <fieldset>
              <legend class="step__label">День</legend>
              <div class="days">
                {days.map((d, i) => (
                  <label class="day" key={d}>
                    <input type="radio" name="rq-day" checked={date === d} onChange={() => setDate(d)} />
                    <span class="day__box">
                      <span class="day__wd">{i === 0 ? 'Сегодня' : i === 1 ? 'Завтра' : new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`))}</span>
                      <span class="day__num">{new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`))}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div class="field">
              <label class="field__label" for="rq-hour">
                Во сколько
              </label>
              <select id="rq-hour" class="field__input mono" value={hour} onChange={(e) => setHour(Number(e.currentTarget.value))}>
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {String(h % 24).padStart(2, '0')}:00
                  </option>
                ))}
              </select>
              {past ? <p class="field__error">Это время уже прошло — выберите позже.</p> : null}
            </div>
            <Seg
              name="rq-len"
              legend="Сколько играете"
              value={minutes}
              onChange={setMinutes}
              options={[
                ['60', '1 час'],
                ['120', '2 часа'],
                ['180', '3 часа'],
              ]}
            />
            <div class="field">
              <span class="field__label" id="rq-people-l">
                Сколько вас
              </span>
              <div class="stepper__row stepper__row--inline" role="group" aria-labelledby="rq-people-l">
                <button type="button" class="stepper__btn" aria-label="Меньше человек" disabled={people <= 1} onClick={() => setPeople(people - 1)}>
                  −
                </button>
                <output class="stepper__value display" aria-live="polite">
                  {people}
                </output>
                <button type="button" class="stepper__btn" aria-label="Больше человек" disabled={people >= 12} onClick={() => setPeople(people + 1)}>
                  +
                </button>
              </div>
            </div>
            <div class="field">
              <label class="field__label" for="rq-comment">
                Пожелания
              </label>
              <input id="rq-comment" class="field__input" maxLength={300} value={comment} placeholder="Например: стол под пирамиду, у окна" onInput={(e) => setComment(e.currentTarget.value)} />
            </div>
            <div class="actionbar">
              <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy || past}>
                {busy ? 'Отправляем…' : `Отправить заявку на ${formatTime(startsAt, tz)}`}
              </button>
            </div>
          </form>
        ) : null}
      </main>
    </div>
  );
}

/** Статус заявки: отправлена → (оператор) → принята / отказ; обновляется сама. */
export function RequestStatusScreen({ id }) {
  const [r, setR] = useState(undefined);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api.clubRequestStatus(id).then(
        (x) => alive && (setR(x), setError(null)),
        (err) => alive && setError(err),
      );
    load();
    const t = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);
  const st = r ? (REQUEST_STATUS[r.status] ?? REQUEST_STATUS.sent) : null;
  const tz = zoneOf(r?.timezone, lastClub()?.timezone);
  return (
    <div class="screen screen--paper">
      <Header back={{ href: BASE, label: 'На главную' }} />
      <main class="wrap content plus">
        <h1 class="page-title display">Заявка на стол</h1>
        <ErrorNote error={error} />
        {r === undefined && !error ? <p class="muted loading">Загружаем…</p> : null}
        {r ? (
          <>
            <div class="lcard">
              <p class="lcard__name">{r.club?.name}</p>
              <p class="lcard__sub">
                {formatDate(r.starts_at, tz)}, <span class="mono">{formatTime(r.starts_at, tz)}</span> · {r.minutes / 60} ч · {r.people} чел.
              </p>
            </div>
            <ol class="rsteps" aria-label="Ход заявки">
              <li class={`rsteps__item${st.step >= 1 ? ' rsteps__item--done' : ''}`}>Отправлена в клуб</li>
              {r.status === 'operator' || st.step === 2 ? <li class="rsteps__item rsteps__item--done">Подключили оператора</li> : null}
              <li class={`rsteps__item${st.step >= 3 ? ' rsteps__item--done' : ''}`}>Ответ клуба</li>
            </ol>
            <div class={`note ${st.tone === 'free' ? 'note--free' : st.tone === 'alert' ? 'note--error' : 'note--lamp'}`} role="status">
              <Icon name={st.tone === 'free' ? 'check' : st.tone === 'alert' ? 'alert' : 'clock'} />
              <p class="note__title">{st.title}</p>
              <p class="note__body">{r.answer_text || st.text}</p>
            </div>
            {['sent', 'operator'].includes(r.status) ? (
              <button
                type="button"
                class="btn btn--quiet btn--block"
                onClick={async () => {
                  try {
                    setR(await api.cancelClubRequest(r.id));
                  } catch (err) {
                    setError(err);
                  }
                }}
              >
                Отменить заявку
              </button>
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  );
}

const ANSWER_MAX = 500;
const WEEKDAY = (iso, tz) => new Intl.DateTimeFormat('ru-RU', { weekday: 'long', timeZone: tz }).format(new Date(iso));

/**
 * Ответ клуба без программы на заявку гостя (T25, Д1): ссылка из уведомления `/app/club-request/{id}?t=…`, без входа.
 * Заявка с телефоном гостя, «Принять» и «Отказать» с текстом ответа. Ссылка одноразовая и живёт 24 часа:
 * после ответа сервер стирает токен (404), поэтому «Вы уже ответили» — по отметке этого браузера.
 */
export function ClubAnswerScreen({ id, search }) {
  const token = new URLSearchParams(search ?? '').get('t');
  const [request, setRequest] = useState(undefined);
  const [loadError, setLoadError] = useState(null);
  const [answered, setAnswered] = useState(() => parseClubAnswer(local.get(CLUB_ANSWER_KEY(id))));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [justNow, setJustNow] = useState(false);
  useEffect(() => {
    if (!token) return undefined;
    let alive = true;
    setLoadError(null);
    api.clubRequestByToken(id, token).then(
      (r) => alive && setRequest(r ?? null),
      (err) => alive && (setLoadError(err), setRequest(null)),
    );
    return () => {
      alive = false;
    };
  }, [id, token, attempt]);
  const state = clubAnswerState({ token, request, error: loadError, answered: Boolean(answered) });
  // Пояс клуба сервер в этой ссылке не отдаёт — время как на устройстве (клуб и телефон обычно в одном городе)
  const tz = zoneOf(request?.timezone);

  const send = async (decision) => {
    setBusy(decision);
    setError(null);
    try {
      await api.answerClubRequest(id, token, decision, text.trim());
      const mark = { decision, at: new Date().toISOString() };
      local.set(CLUB_ANSWER_KEY(id), JSON.stringify(mark));
      setAnswered(mark);
      setJustNow(true);
      setRequest(null);
    } catch (err) {
      // Ссылка истекла или уже использована, на заявку ответил кто-то другой — показываем это вместо формы
      if (err?.code === 'not_found') {
        setLoadError(err);
        setRequest(null);
      } else if (err?.code === 'request_closed') {
        setRequest((r) => (r ? { ...r, status: 'closed' } : r));
      } else setError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div class="screen screen--paper">
      <Header />
      <main class="wrap content plus">
        <h1 class="page-title display">Заявка гостя</h1>
        {state === 'loading' ? <p class="muted loading">Загружаем заявку…</p> : null}
        {state === 'error' ? (
          <>
            <ErrorNote error={loadError} />
            <button type="button" class="btn btn--secondary btn--block" onClick={() => setAttempt((n) => n + 1)}>
              Загрузить заявку ещё раз
            </button>
          </>
        ) : null}
        {state === 'answered' ? (
          <div class="empty" role="status">
            <Ill name="lamp" />
            <p class="step__title">{justNow ? 'Ответ отправлен гостю' : 'Вы уже ответили на эту заявку'}</p>
            <p class="hint">
              {answered.decision === 'accept' ? 'Вы приняли заявку — гость получил уведомление, что стол его ждёт.' : 'Вы отказали — гость получил уведомление и подберёт другое время или клуб.'}
              {answered.at && !justNow ? ` Ответ отправлен ${formatDate(answered.at, tz)} в ${formatTime(answered.at, tz)}.` : ''} Ссылка одноразовая — изменить ответ по ней уже нельзя.
            </p>
          </div>
        ) : null}
        {state === 'invalid' ? (
          <div class="note note--lamp" role="alert">
            <Icon name="info" />
            <p class="note__title">Ссылка больше не работает</p>
            <p class="note__body">
              Ссылка на заявку действует 24 часа и только для одного ответа. Скорее всего, на заявку уже ответили — вы, другой сотрудник или оператор Бильярдума, — или гость её отменил. Если вы не отвечали, заявку обработает оператор: гость без ответа не останется.
            </p>
          </div>
        ) : null}
        {request && state === 'closed' ? (
          <div class="note note--lamp" role="status">
            <Icon name="info" />
            <p class="note__title">На заявку уже ответили</p>
            <p class="note__body">{(REQUEST_STATUS[request.status] ?? REQUEST_STATUS.closed).title}. Ответить по этой ссылке уже нельзя.</p>
          </div>
        ) : null}
        {request && state === 'open' ? (
          <>
            <p class="lead">{request.club?.name}</p>
            <p class="hint">Гость просит стол и ждёт ответа. Ответьте — он сразу получит уведомление.</p>
            <dl class="tfacts">
              <div>
                <dt>Когда</dt>
                <dd>
                  {formatDate(request.starts_at, tz)}, {WEEKDAY(request.starts_at, tz)}
                </dd>
              </div>
              <div>
                <dt>Во сколько</dt>
                <dd class="mono">{formatTime(request.starts_at, tz)}</dd>
              </div>
              <div>
                <dt>Сколько играют</dt>
                <dd>{minutesWords(request.minutes)}</dd>
              </div>
              <div>
                <dt>Гостей</dt>
                <dd>{peopleWords(request.people)}</dd>
              </div>
              {request.comment ? (
                <div class="tfacts__wide">
                  <dt>Пожелания</dt>
                  <dd>{request.comment}</dd>
                </div>
              ) : null}
              <div class="tfacts__wide">
                <dt>Телефон гостя</dt>
                <dd>
                  {request.guest_phone ? (
                    <a class="mono" href={`tel:${String(request.guest_phone).replace(/[^\d+]/g, '')}`}>
                      {request.guest_phone}
                    </a>
                  ) : (
                    'не указан'
                  )}
                </dd>
              </div>
            </dl>
            {request.status === 'operator' ? (
              <p class="note note--lamp" role="status">
                <Icon name="clock" />
                <span class="note__title">Заявку уже передали оператору Бильярдума — ответить всё ещё можно: гость получит ваш ответ сразу.</span>
              </p>
            ) : null}
            <div class="field">
              <label class="field__label" for="ca-text">
                Ответ гостю
              </label>
              <textarea id="ca-text" class="field__input field__input--area" rows={3} maxLength={ANSWER_MAX} value={text} aria-describedby="ca-hint" onInput={(e) => setText(e.currentTarget.value)} />
              <p class="field__hint" id="ca-hint">
                Необязательно. Гость увидит его в уведомлении. Например: «Ждём, стол 3 у окна» или «Всё занято, свободно с 21:00».
              </p>
            </div>
            <ErrorNote error={error} />
            <div class="answer-actions">
              <button type="button" class="btn btn--primary btn--block btn--lg" disabled={Boolean(busy)} onClick={() => send('accept')}>
                <Icon name="check" />
                {busy === 'accept' ? 'Отправляем…' : 'Принять заявку'}
              </button>
              <button type="button" class="btn btn--quiet btn--block btn--lg" disabled={Boolean(busy)} onClick={() => send('decline')}>
                {busy === 'decline' ? 'Отправляем…' : 'Отказать'}
              </button>
            </div>
            <p class="muted small">Ссылка действует 24 часа и только для одного ответа.</p>
          </>
        ) : null}
      </main>
    </div>
  );
}

/** Заявка оператору отправлена — общий финал «Добавить» и «Подтвердить клуб». */
function SentToOperator({ title, text }) {
  return (
    <div class="empty">
      <Ill name="pocket" />
      <p class="step__title">{title}</p>
      <p class="hint">{text}</p>
      <a class="btn btn--secondary" href={BASE} onClick={linkHandler}>
        На главную
      </a>
    </div>
  );
}

/** Ошибка лимита заявок на карточки (5 открытых) — не «продление», а свой текст. */
const claimError = (err) => (err?.code === 'limit_exceeded' ? { code: 'claims_limit' } : err);

/**
 * «Добавить клуб» (с сайта, №133): гость предлагает клуб в каталог — заявка уходит оператору платформы,
 * карточка появится после проверки со статусом «В каталоге». Вход обязателен.
 */
export function DirectoryAdd() {
  const { status } = useStore(auth);
  const [f, setF] = useState({ city: '', name: '', address: '', phone: '', hours_text: '', tables_count: '', comment: '', disciplines: [] });
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.currentTarget.value }));
  const errs = {
    city: f.city.trim().length < 2,
    name: f.name.trim().length < 2,
    address: f.address.trim().length < 3,
    tables_count: f.tables_count !== '' && !(Number.isInteger(Number(f.tables_count)) && Number(f.tables_count) >= 1 && Number(f.tables_count) <= 200),
  };
  const bad = (k) => (tried && errs[k] ? 'true' : undefined);
  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (Object.values(errs).some(Boolean)) return;
    setBusy(true);
    setError(null);
    try {
      await api.directoryAdd({
        city: f.city.trim(),
        name: f.name.trim(),
        address: f.address.trim(),
        ...(f.phone.trim() ? { phone: f.phone.trim() } : {}),
        ...(f.hours_text.trim() ? { hours_text: f.hours_text.trim() } : {}),
        ...(f.disciplines.length ? { disciplines: f.disciplines } : {}),
        ...(f.tables_count ? { tables_count: Number(f.tables_count) } : {}),
        ...(f.comment.trim() ? { comment: f.comment.trim() } : {}),
      });
      setDone(true);
    } catch (err) {
      setError(claimError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="screen screen--paper">
      <Header back={{ href: BASE, label: 'На главную' }} />
      <main class="wrap content plus">
        <h1 class="page-title display">Добавить клуб</h1>
        {status === 'anon' ? <SignIn title="Войдите, чтобы предложить клуб" /> : null}
        {status === 'user' && done ? <SentToOperator title="Заявка отправлена оператору" text="Оператор Бильярдума проверит клуб и добавит его в каталог. Ответ придёт в мессенджер." /> : null}
        {status === 'user' && !done ? (
          <form class="step" onSubmit={submit} noValidate>
            <p class="hint">Знаете бильярдный клуб, которого нет в Бильярдуме? Расскажите о нём — после проверки он появится в каталоге, и гости смогут отправлять ему заявки.</p>
            <Field id="da-city" label="Город" value={f.city} onInput={set('city')} invalid={bad('city')} error="Укажите город." />
            <Field id="da-name" label="Название клуба" value={f.name} onInput={set('name')} invalid={bad('name')} error="Укажите название." />
            <Field id="da-addr" label="Адрес" value={f.address} onInput={set('address')} invalid={bad('address')} error="Укажите улицу и дом." />
            <Field id="da-phone" label="Телефон клуба" type="tel" value={f.phone} onInput={set('phone')} hint="Если знаете — так оператор быстрее свяжется с клубом." />
            <Field id="da-hours" label="Часы работы" value={f.hours_text} onInput={set('hours_text')} placeholder="Ежедневно 12:00–02:00" />
            <fieldset class="seg">
              <legend class="seg__legend">Во что играют</legend>
              <div class="seg__row">
                {DISCIPLINES.map((d) => (
                  <label class="seg__item" key={d}>
                    <input
                      type="checkbox"
                      checked={f.disciplines.includes(d)}
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        setF((x) => ({ ...x, disciplines: on ? [...x.disciplines, d] : x.disciplines.filter((y) => y !== d) }));
                      }}
                    />
                    <span class="seg__box">{DISCIPLINE_WORD[d]}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <Field id="da-tables" label="Столов" inputMode="numeric" value={f.tables_count} onInput={set('tables_count')} invalid={bad('tables_count')} error="Число от 1 до 200." />
            <Field id="da-comment" label="Комментарий" value={f.comment} onInput={set('comment')} placeholder="Например: я владелец, хочу подключить клуб" />
            <ErrorNote error={error} />
            <div class="actionbar">
              <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
                {busy ? 'Отправляем…' : 'Отправить оператору'}
              </button>
            </div>
          </form>
        ) : null}
      </main>
    </div>
  );
}

function Field({ id, label, value, onInput, invalid, error, hint, type = 'text', inputMode, placeholder }) {
  return (
    <div class="field">
      <label class="field__label" for={id}>
        {label}
      </label>
      <input
        id={id}
        class="field__input"
        type={type}
        inputMode={inputMode}
        maxLength={300}
        value={value}
        placeholder={placeholder}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-err` : hint ? `${id}-hint` : undefined}
        onInput={onInput}
      />
      {invalid ? (
        <p class="field__error" id={`${id}-err`}>
          {error}
        </p>
      ) : hint ? (
        <p class="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** «Подтвердить клуб» (с сайта, №133): владелец заявляет права на карточку — проверяет оператор. */
export function DirectoryClaim({ listingId }) {
  const { status } = useStore(auth);
  const [listing, setListing] = useState(undefined);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    api.listing(listingId).then(setListing, (err) => (setError(err), setListing(null)));
  }, [listingId]);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.directoryClaim(listingId, comment.trim());
      setDone(true);
    } catch (err) {
      setError(claimError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="screen screen--paper">
      <Header back={{ href: BASE, label: 'На главную' }} />
      <main class="wrap content plus">
        <h1 class="page-title display">Подтвердить клуб</h1>
        {listing === undefined ? <p class="muted loading">Загружаем клуб…</p> : null}
        {listing ? (
          <div class="lcard">
            <p class="lcard__name">{listing.name}</p>
            <p class="lcard__sub">
              {listing.city}
              {listing.address ? `, ${listing.address}` : ''}
            </p>
          </div>
        ) : null}
        {listing && status === 'anon' ? <SignIn title="Войдите с телефоном владельца или управляющего" /> : null}
        {listing && status === 'user' && done ? (
          <SentToOperator title="Заявка отправлена оператору" text="Оператор позвонит по номеру, с которым вы вошли, и подтвердит права. После этого заявки гостей будут приходить вам." />
        ) : null}
        {listing && status === 'user' && !done ? (
          <form class="step" onSubmit={submit} noValidate>
            <p class="hint">Вы владелец или управляющий этого клуба? Подтвердите права — сможете менять карточку, отвечать на отзывы и получать заявки гостей.</p>
            <div class="field">
              <label class="field__label" for="dc-comment">
                Кто вы в клубе
              </label>
              <input id="dc-comment" class="field__input" maxLength={300} value={comment} placeholder="Например: владелец, Иван" onInput={(e) => setComment(e.currentTarget.value)} />
            </div>
            <ErrorNote error={error} />
            <div class="actionbar">
              <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
                {busy ? 'Отправляем…' : 'Отправить на проверку'}
              </button>
            </div>
          </form>
        ) : null}
        {listing === null ? <ErrorNote error={error} /> : null}
      </main>
    </div>
  );
}
