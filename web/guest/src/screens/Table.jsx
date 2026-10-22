import { useEffect, useState, useCallback, useRef } from 'preact/hooks';
import { formatMoney, formatTime } from '@billiardum/shared/format';
import { tableKind, typeLabel } from '@billiardum/shared/hall';
import { Stage, StatusBadge } from '../components/Stage.jsx';
import { Icon } from '../components/Icon.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { useNow } from '../components/hooks.js';
import { SignIn } from './SignIn.jsx';
import { Consent } from './Consent.jsx';
import { Pay } from './Pay.jsx';
import { SignedInAs } from '../components/SignedInAs.jsx';
import { api } from '../lib/api.js';
import { auth, needsConsent } from '../lib/auth.js';
import { useStore } from '../lib/store.js';
import { navigate } from '../lib/router.js';
import { BASE } from '../lib/env.js';
import { optionLabel, optionMinutes, tableName } from '../lib/words.js';
import { getFlow, rememberClub, setFlow } from '../lib/flow.js';
import { MyBooking, Waitlist, startableBooking, useMyWaitlist } from '../components/TableExtras.jsx';

const STEPS = ['choose', 'signin', 'consent', 'pay'];

/**
 * «Стол» по QR (/app/t/{code}): номер, тип, статус словом, цена сейчас и дальше, выбор времени,
 * вход, согласие и оплата — шагами на одной странице (?step=…), кнопка «Назад» браузера работает.
 */
export function TableScreen({ code, search }) {
  const stepParam = new URLSearchParams(search).get('step');
  const step = STEPS.includes(stepParam) ? stepParam : 'choose';
  const { status: authStatus } = useStore(auth);

  const [table, setTable] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [option, setOption] = useState(() => getFlow().code === code ? getFlow().option ?? null : null);
  const [quote, setQuote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inFlight = useRef(false);
  // M3: своя бронь на этот стол (GET /api/me/bookings) и стол, удержанный за гостем из очереди
  const [myBooking, setMyBooking] = useState(null);
  const [held, setHeld] = useState(false);
  const [waitEntry, setWaitEntry] = useMyWaitlist(table?.resource?.id, authStatus === 'user' && Boolean(table) && table.status !== 'free', () => setHeld(true));

  const load = useCallback(async () => {
    try {
      const t = await api.table(code);
      setTable(t);
      setLoadError(null);
      rememberClub(t.club);
      if (auth.get().status === 'user') {
        api
          .myBookings()
          .then((list) => setMyBooking(startableBooking(list, t.resource?.id)))
          .catch(() => {});
      }
      return t;
    } catch (err) {
      setLoadError(err);
      return null;
    }
  }, [code]);

  useEffect(() => {
    load();
  }, [load]);
  // Вход завершился (бот, мини-приложение) — перечитать: появится своя бронь
  useEffect(() => {
    if (authStatus === 'user' && table) load();
  }, [authStatus]);

  // Свой стол во время игры: сразу на экран «Игра»
  useEffect(() => {
    if (table?.my_session_id) navigate(`${BASE}s/${encodeURIComponent(table.my_session_id)}`, { replace: true });
  }, [table?.my_session_id]);

  // Занятый стол перепроверяем раз в 20 с: вдруг освободился (лимит API — 30 запросов в минуту с IP)
  useEffect(() => {
    if (!table || table.status === 'free') return undefined;
    const timer = setInterval(load, 20000);
    return () => clearInterval(timer);
  }, [table?.status, load]);

  useEffect(() => {
    if (table && !option && Array.isArray(table.options) && table.options.length) setOption(table.options[0]);
  }, [table]);

  // После перезагрузки на шаге оплаты котировки нет — возвращаем к выбору времени
  useEffect(() => {
    if (step === 'pay' && !quote) goStep(null, true);
  }, [step, quote]);

  const goStep = (s, replace = false) => navigate(`${BASE}t/${encodeURIComponent(code)}${s ? `?step=${s}` : ''}`, { replace });

  const handleFlowError = (err) => {
    const c = err?.code;
    if (c === 'unauthorized' || c === 'phone_required') {
      goStep('signin');
      return true;
    }
    if (c === 'consent_required') {
      goStep('consent');
      return true;
    }
    if (c && c.startsWith('table_')) load();
    if (c === 'quote_used') {
      setQuote(null);
      goStep(null);
    }
    return false;
  };

  /** Дальше после выбора времени, входа или согласия: вход → согласие → котировка → оплата (или присоединиться). */
  const proceed = async (intent = getFlow().intent ?? 'start') => {
    if (step === 'choose') setFlow({ noBalance: false });
    if (inFlight.current) return;
    setError(null);
    setFlow({ code, intent, option, number: table?.resource?.number, resourceId: table?.resource?.id, timeZone: table?.club?.timezone, kind: 'start' });
    const st = auth.get();
    if (st.status !== 'user') return goStep('signin');
    if (needsConsent(st.user)) return goStep('consent');
    // Лист ожидания (M3): после входа возвращаемся к столу, гость встаёт в очередь сам
    if (intent === 'waitlist') return goStep(null, true);
    setBusy(true);
    inFlight.current = true;
    try {
      if (intent === 'join') {
        await api.join(table.session_id);
        navigate(`${BASE}s/${encodeURIComponent(table.session_id)}`, { replace: true });
        return;
      }
      // Часы пакета на балансе в клубе (M3, №112) — котировка сразу с use_balance; гость может отказаться
      const minutes = optionMinutes(option);
      let useBalance = false;
      if (minutes !== null && !getFlow().noBalance && table.club?.id) {
        const bal = await api.balance(table.club.id).catch(() => null);
        useBalance = (bal?.minutes ?? 0) > 0;
      }
      const q = await api.quote({ resourceId: table.resource.id, kind: 'start', minutes, useBalance });
      setQuote(q);
      goStep('pay', step !== 'choose');
    } catch (err) {
      if (!handleFlowError(err)) setError(err);
      if (step !== 'choose' && !['unauthorized', 'phone_required', 'consent_required'].includes(err?.code)) goStep(null, true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (loadError && !table) {
    return (
      <div class="screen">
        <Stage label="Стол">
          <h1 class="stage__title display">{loadError.code === 'not_found' ? 'Стол не найден' : 'Не загрузили стол'}</h1>
        </Stage>
        <main class="wrap content">
          <ErrorNote error={loadError}>
            <button type="button" class="btn btn--secondary btn--sm" onClick={load}>
              <Icon name="refresh" />
              Загрузить снова
            </button>
          </ErrorNote>
        </main>
      </div>
    );
  }

  if (!table) {
    return (
      <div class="screen" aria-busy="true">
        <Stage label="Стол">
          <p class="stage__title display" aria-hidden="true">
            Стол
          </p>
          <p class="stage__sub">Загружаем…</p>
        </Stage>
      </div>
    );
  }

  const tz = table.club?.timezone;
  const number = table.resource?.number;
  const kind = tableKind(table.resource?.type);
  const lit = table.status === 'busy' ? 'true' : 'false';
  const compact = step !== 'choose';
  const what = `${tableName(number)} · ${optionLabel(option)}`;

  return (
    <div class="screen">
      <Stage
        kind={kind}
        lit={lit}
        compact={compact}
        tone={table.status === 'busy' ? 'play' : 'idle'}
        variant="table"
        label={`${tableName(number)}, ${typeLabel(table.resource?.type, table.resource?.title)}`}
        back={compact ? { href: `${BASE}t/${encodeURIComponent(code)}`, label: 'Назад к выбору времени' } : undefined}
      >
        {table.club?.name ? <p class="stage__kicker">{table.club.name}</p> : null}
        <div class="stage__row">
          <h1 class="stage__title display">{tableName(number)}</h1>
          {!compact ? <StatusBadge status={table.status} /> : null}
        </div>
        <p class="stage__sub">{typeLabel(table.resource?.type, table.resource?.title)}</p>
        {!compact && table.status === 'free' && table.price_now ? <StagePrice now={table.price_now} next={table.price_next} /> : null}
      </Stage>

      <main class="wrap content">
        {step === 'choose' && myBooking ? <MyBooking table={table} booking={myBooking} code={code} onReload={load} /> : null}
        {step === 'choose' && !myBooking && held ? (
          <p class="note note--lamp" role="status">
            <Icon name="clock" />
            <span class="note__title">Стол держим за вами 3 минуты — выберите время и оплатите.</span>
          </p>
        ) : null}
        {step === 'choose' && !myBooking && (table.status === 'free' || held) ? (
          <Choose table={table} option={option} setOption={setOption} busy={busy} error={error} onNext={() => proceed('start')} />
        ) : null}
        {step === 'choose' && !myBooking && !held && table.status !== 'free' ? (
          <NotFree
            table={table}
            error={error}
            busy={busy}
            onReload={load}
            onJoin={() => proceed('join')}
            signedIn={authStatus === 'user'}
            onSignIn={() => {
              setFlow({ code, intent: 'waitlist' });
              goStep('signin');
            }}
            waitEntry={waitEntry}
            setWaitEntry={setWaitEntry}
            onTaken={(w) => {
              if (w?.status === 'accepted') setHeld(true);
              load();
            }}
          />
        ) : null}
        {step === 'signin' ? (authStatus === 'user' ? <AutoProceed run={() => proceed()} /> : <SignIn />) : null}
        {step === 'consent' || step === 'pay' ? <SignedInAs /> : null}
        {step === 'consent' ? <Consent onDone={() => proceed()} /> : null}
        {step === 'pay' && quote ? (
          <Pay
            quote={quote}
            what={what}
            kind="start"
            unlimited={optionMinutes(option) === null}
            timeZone={tz}
            onRequote={() => proceed('start')}
            onWithoutBalance={() => {
              setFlow({ noBalance: true });
              proceed('start');
            }}
            onError={handleFlowError}
            onReception={(res) => {
              setFlow({ requestId: res.reception_request_id, amount: quote.amount_kopecks, minutes: quote.minutes ?? null });
              navigate(`${BASE}r/${encodeURIComponent(res.reception_request_id)}`, { replace: true });
            }}
          />
        ) : null}
        {busy && step !== 'choose' ? (
          <p class="waiting" role="status">
            <span class="waiting__dot" aria-hidden="true" />
            Считаем цену…
          </p>
        ) : null}
        {step !== 'choose' && error ? <ErrorNote error={error} /> : null}
      </main>
    </div>
  );
}

/** Вход уже есть (например, вернулись из бота в другой вкладке) — идём дальше без лишнего нажатия. */
function AutoProceed({ run }) {
  useEffect(() => {
    run();
  }, []);
  return null;
}

function Choose({ table, option, setOption, busy, error, onNext }) {
  const now = useNow();
  const tz = table.club?.timezone;
  // Бронь позже сегодня (M3, №106): играть можно до её начала минус 5 минут
  const limit = table.next_booking?.starts_at ? Date.parse(table.next_booking.starts_at) - 5 * 60000 : null;
  return (
    <form
      class="step"
      onSubmit={(e) => {
        e.preventDefault();
        onNext();
      }}
    >
      <fieldset>
        <legend class="step__label">Сколько играем?</legend>
        <div class="choice choice--grid">
          {(table.options ?? []).map((o) => {
            const m = optionMinutes(o);
            const blocked = limit !== null && (m === null || now + m * 60000 > limit);
            const sub = blocked ? 'Стол забронирован' : m === null ? 'Платите за фактическое время' : `До ${formatTime(now + m * 60000, tz)}`;
            return (
              <label class="choice__item" key={String(o)}>
                <input type="radio" name="option" value={String(o)} checked={option === o} disabled={blocked} onChange={() => setOption(o)} />
                <span class="choice__box">
                  <span class="choice__title">{optionLabel(o)}</span>
                  <span class="choice__sub">{sub}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {limit !== null ? (
        <p class="note note--lamp">
          <Icon name="calendar" />
          <span class="note__title">
            Стол забронирован на {formatTime(table.next_booking.starts_at, tz)}, играть можно до {formatTime(limit, tz)}
          </span>
        </p>
      ) : null}
      <p class="hint hint--icon">
        <Icon name="lamp" />
        Свет загорится сразу после оплаты. За 10 минут до конца напомним, продлить можно в один шаг.
      </p>

      <ErrorNote error={error} />

      <div class="actionbar">
        <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy || !option || (limit !== null && (optionMinutes(option) === null || now + optionMinutes(option) * 60000 > limit))}>
          {busy ? 'Считаем цену…' : 'Продолжить к оплате'}
        </button>
      </div>
    </form>
  );
}

/** Цена в сцене: «900 ₽/ч до 06:00, потом 500 ₽/ч» (PRODUCT §3, п. 2). */
function StagePrice({ now, next }) {
  return (
    <p class="stage__price">
      <span class="stage__price-value">
        <span class="display">{formatMoney(now.price_per_hour_kopecks).replace(/\s?₽$/, '')}</span>
        <span class="stage__price-unit">&nbsp;₽/ч</span>
      </span>
      <span class="stage__price-when">
        {now.until_local ? `до ${now.until_local}` : 'весь день'}
        {next ? `, потом ${formatMoney(next.price_per_hour_kopecks)}/ч` : ''}
      </span>
    </p>
  );
}

function NotFree({ table, error, busy, onReload, onJoin, signedIn, onSignIn, onTaken, waitEntry, setWaitEntry }) {
  const tz = table.club?.timezone;
  const until = table.busy_until ? formatTime(table.busy_until, tz) : null;
  const s = table.status;
  let title;
  let text;
  if (s === 'busy') {
    title = until ? `Стол занят до ${until}` : 'Стол занят';
    text = 'Остановить или продлить чужую игру нельзя. Выберите другой стол.';
  } else if (s === 'pending') {
    title = 'Стол сейчас занимают';
    text = 'Другой гость оплачивает игру. Если он не оплатит за 3 минуты, стол освободится.';
  } else if (s === 'reserved') {
    title = table.next_booking?.starts_at ? `Стол забронирован на ${formatTime(table.next_booking.starts_at, tz)}` : 'Стол забронирован';
    text = 'Скоро придут гости по брони. Выберите другой стол или забронируйте свой.';
  } else if (s === 'service') {
    title = until ? `Стол на обслуживании до ${until}` : 'Стол на обслуживании';
    text = 'Выберите другой стол или подойдите на ресепшн.';
  } else {
    title = 'Стол не на связи';
    text = 'Свет на нём сейчас не включится. Выберите другой стол или подойдите на ресепшн.';
  }
  // Предложение из очереди (5 минут) важнее всего остального на экране
  if (waitEntry?.status === 'offered') {
    return (
      <div class="step">
        <Waitlist table={table} entry={waitEntry} setEntry={setWaitEntry} signedIn={signedIn} onSignIn={onSignIn} onTaken={onTaken} />
      </div>
    );
  }
  return (
    <div class="step">
      <section class="notice" aria-labelledby="nf-title">
        <h2 class="notice__title" id="nf-title">
          {title}
        </h2>
        <p class="notice__text">{text}</p>
      </section>

      {s === 'busy' && table.session_id ? (
        <section class="join" aria-labelledby="join-title">
          <h2 class="step__label" id="join-title">
            Играете за этим столом?
          </h2>
          <p class="hint">Присоединитесь к игре: сможете продлевать её со своего телефона, а партии попадут в вашу историю.</p>
          <ErrorNote error={error} />
          <div class="actionbar">
            <button type="button" class="btn btn--primary btn--block btn--lg" disabled={busy} onClick={onJoin}>
              <Icon name="users" />
              {busy ? 'Присоединяем…' : 'Я играю за этим столом'}
            </button>
          </div>
        </section>
      ) : (
        <>
          <ErrorNote error={error} />
          <button type="button" class="btn btn--quiet btn--block" onClick={onReload}>
            <Icon name="refresh" />
            Проверить стол снова
          </button>
        </>
      )}

      {(s === 'busy' || s === 'pending' || s === 'reserved') && waitEntry?.status !== 'offered' ? (
        <Waitlist table={table} entry={waitEntry} setEntry={setWaitEntry} signedIn={signedIn} onSignIn={onSignIn} onTaken={onTaken} />
      ) : null}
    </div>
  );
}
