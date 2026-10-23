import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { formatDuration, formatMoney, formatTime } from '@billiardum/shared/format';
import { tableKind } from '@billiardum/shared/hall';
import { Stage } from '../components/Stage.jsx';
import { Icon } from '../components/Icon.jsx';
import { Dialog } from '../components/Dialog.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { useNow } from '../components/hooks.js';
import { PushOffer } from '../components/PushOffer.jsx';
import { Pay } from './Pay.jsx';
import { api, streamSession } from '../lib/api.js';
import { auth } from '../lib/auth.js';
import { useStore } from '../lib/store.js';
import { clockSkew, gameView, timerTexts, maxExtendMinutes, lampState, pulseLamp, timeLeftShare } from '../lib/game.js';
import { durationWords, minutesWords, optionLabel, tableName } from '../lib/words.js';
import { navigate, linkHandler } from '../lib/router.js';
import { BASE } from '../lib/env.js';
import { clubTimeZone, getFlow, setFlow } from '../lib/flow.js';
import { currentOrder, ordersWord, tabSummary } from '../lib/bar.js';
import { orderWord } from '@billiardum/shared/bar';
import { extendLimitText } from '@billiardum/shared/booking';

const EXTEND_OPTIONS = [30, 60, 120, 180];
const TONE = { play: 'play', warn: 'warn', grace: 'grace', unlimited: 'play' };

/**
 * «Игра» (/app/s/{id}): таймер на полэкрана моноширинным; за 5 минут — янтарный, в льготу — красный,
 * лампа приглушается как на столе. «Продлить», «Закончить игру» (только плательщик, №46), кто за столом.
 * Живые обновления — SSE `session`; при разрыве — перечитываем сессию.
 */
export function GameScreen({ id }) {
  const [session, setSession] = useState(null);
  const [skew, setSkew] = useState(0);
  const [loadError, setLoadError] = useState(null);
  const [live, setLive] = useState('open');
  const [bar, setBar] = useState({ tab: null, orders: [] });

  // Счёт стола и заказы бара (M2): полоса над кнопками и напоминание после игры
  const loadBar = useCallback(async () => {
    const [t, o] = await Promise.allSettled([api.tab(id), api.sessionOrders(id)]);
    setBar((b) => ({ tab: t.status === 'fulfilled' ? t.value : b.tab, orders: o.status === 'fulfilled' && Array.isArray(o.value) ? o.value : b.orders }));
  }, [id]);

  const apply = useCallback((s) => {
    if (!s || typeof s !== 'object') return;
    setSession(s);
    const k = clockSkew(s, Date.now());
    if (k) setSkew(k);
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await api.session(id));
      setLoadError(null);
    } catch (err) {
      setLoadError(err);
    }
  }, [id, apply]);

  useEffect(() => {
    load();
    loadBar();
    const stream = streamSession(id, {
      events: ['session', 'order'],
      // В событии SSE сервер не знает, кто смотрит (is_payer: false) — берём своё из GET и перечитываем
      onEvent: (name, data) => {
        if (name === 'order') {
          loadBar();
          return;
        }
        if (data && data.id === id) setSession((prev) => ({ ...prev, ...data, is_payer: prev?.is_payer ?? data.is_payer }));
        load();
      },
      onOpen: () => {
        load();
        loadBar();
      },
      onState: setLive,
    });
    // Запасной опрос: SSE может не пройти через прокси мобильного оператора
    const poll = setInterval(load, 30000);
    return () => {
      stream.close();
      clearInterval(poll);
    };
  }, [id, load, apply]);

  const now = useNow(skew, Boolean(session));
  const view = session ? gameView(session, now) : null;

  // После льготы ждём закрытия от сервера; закрыта — на чек
  useEffect(() => {
    if (view?.phase !== 'over') return undefined;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [view?.phase, load]);

  if (!session) {
    return (
      <div class="screen" aria-busy={loadError ? undefined : 'true'}>
        <Stage label="Игра">
          <p class="stage__title display">{loadError ? 'Игра не найдена' : 'Игра'}</p>
          {!loadError ? <p class="stage__sub">Загружаем…</p> : null}
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

  const tz = clubTimeZone(session.club?.timezone);
  const number = session.resource?.number;
  const kind = tableKind(session.resource?.type);
  const phase = view.phase;

  if (phase === 'interrupted') return <Interrupted session={session} view={view} kind={kind} onUpdate={apply} />;
  if (phase === 'closed' || phase === 'cancelled') return <Closed session={session} kind={kind} tab={bar.tab} />;

  const texts = timerTexts(view, { timeZone: tz, startedAt: session.started_at, unlimited: session.unlimited });
  const tone = TONE[phase] ?? 'idle';

  return (
    <div class={`screen screen--game screen--${phase}`}>
      <Stage kind={kind} lit={lampState(phase)} tone={tone} label={`${tableName(number)}, игра`} pulse={pulseLamp(view, session)} ring={timeLeftShare(view, session)}>
        <p class="stage__kicker">
          {tableName(number)}
          {live !== 'open' ? <span class="stage__live"> · обновляем…</span> : null}
        </p>
        <div class={`timer timer--${phase}`} role="timer" aria-label={texts.aria}>
          <p class="timer__label">
            {phase === 'warn' ? <Icon name="clock" /> : null}
            {phase === 'grace' ? <Icon name="alert" /> : null}
            {texts.label}
          </p>
          <p class="timer__value" aria-hidden="true">
            {formatDuration(view.ms)}
          </p>
          <p class="timer__note">{texts.note}</p>
        </div>
      </Stage>
      <PhaseAnnouncer phase={phase} />

      <main class="wrap content content--game">
        <ExtendPending session={session} tz={tz} />
        <BarStrip sessionId={session.id} bar={bar} />
        <Participants session={session} />
        <MatchSlot session={session} />
        <PushOffer />
      </main>

      <GameActions session={session} view={view} tz={tz} onUpdate={apply} reload={load} />
    </div>
  );
}

/**
 * «Партия» Бильярдум+ (M4) — отдельный чанк: грузим, только когда за столом есть соперник с user_id.
 */
let matchPanel = null;
function MatchSlot({ session }) {
  const { user } = useStore(auth);
  const hasRival = (session.participants ?? []).some((p) => p.user_id && p.user_id !== user?.id);
  const [Panel, setPanel] = useState(() => matchPanel);
  useEffect(() => {
    if (!hasRival || Panel) return;
    import('../components/MatchPanel.jsx')
      .then((m) => {
        matchPanel = m.MatchPanel;
        setPanel(() => m.MatchPanel);
      })
      .catch(() => {});
  }, [hasRival]);
  return hasRival && Panel ? <Panel session={session} /> : null;
}

/** Для экранного диктора: объявить смену состояния (меньше 5 минут, льгота), а не каждую секунду. */
function PhaseAnnouncer({ phase }) {
  const prev = useRef(phase);
  const [text, setText] = useState('');
  useEffect(() => {
    if (prev.current !== phase) {
      if (phase === 'warn') setText('Осталось меньше 5 минут.');
      else if (phase === 'grace') setText('Время вышло. Две минуты на продление, затем свет погаснет.');
      else if (phase === 'over') setText('Игра завершена.');
      prev.current = phase;
    }
  }, [phase]);
  return (
    <p class="visually-hidden" aria-live="assertive">
      {text}
    </p>
  );
}

function Participants({ session }) {
  const list = Array.isArray(session.participants) ? session.participants : [];
  if (!list.length) return null;
  return (
    <section class="players" aria-labelledby="players-title">
      <h2 class="step__label" id="players-title">
        За столом
      </h2>
      <ul class="players__list">
        {list.map((p, i) => (
          <li class="players__item" key={p.user_id ?? `${p.nick ?? p.label}-${i}`}>
            <Icon name="user" />
            {/* light (M4): nick — ник Бильярдум+ или null, label — «Игрок N» */}
            <span>{p.nick ?? p.label ?? `Игрок ${i + 1}`}</span>
            {p.is_payer ? <span class="players__tag">оплатил</span> : null}
          </li>
        ))}
      </ul>
      <p class="hint">Друг тоже может продлевать игру: пусть отсканирует QR на столе и нажмёт «Я играю за этим столом».</p>
    </section>
  );
}

/** Продление на ресепшене: таймер на экране, пока администратор не примет оплату. */
function ExtendPending({ session, tz }) {
  const p = getFlow().extendRequest;
  const active = Boolean(p) && p.sessionId === session.id && Date.parse(session.paid_until) <= p.paidUntilBefore && Date.now() < p.expiresAt;
  useEffect(() => {
    if (p && !active) setFlow({ extendRequest: null });
  }, [active]);
  if (!active) return null;
  return (
    <div class="note note--lamp" role="status">
      <Icon name="reception" />
      <p class="note__title">Подойдите на ресепшн: «{tableName(session.resource?.number)}, {minutesWords(p.minutes)}»</p>
      <p class="note__body">
        К оплате <b class="mono">{formatMoney(p.amount)}</b>. Таймер продлится, как только администратор примет оплату. Заявка действует до{' '}
        <span class="mono">{formatTime(p.expiresAt, tz)}</span>.
      </p>
    </div>
  );
}

function GameActions({ session, view, tz, onUpdate, reload }) {
  const [extendOpen, setExtendOpen] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const phase = view.phase;
  // «Без лимита» продлевается новой заморозкой или блоком СБП: POST /api/quotes {kind: 'extend', minutes: null}
  const canExtend = ['play', 'warn', 'grace', 'unlimited'].includes(phase);
  const canStop = session.is_payer && ['play', 'warn', 'grace', 'unlimited'].includes(phase);

  if (phase === 'over') {
    return (
      <div class="actionbar actionbar--fixed">
        <p class="waiting" role="status">
          <span class="waiting__dot" aria-hidden="true" />
          Закрываем игру и готовим чек…
        </p>
      </div>
    );
  }

  return (
    <div class="actionbar actionbar--fixed">
      {canExtend ? (
        <button
          type="button"
          class={`btn btn--block ${phase === 'unlimited' ? 'btn--quiet' : `btn--lg ${phase === 'warn' ? 'btn--lamp' : 'btn--primary'}`}`}
          onClick={() => setExtendOpen(true)}
        >
          <Icon name="extend" />
          {session.unlimited ? 'Продлить без лимита' : 'Продлить игру'}
        </button>
      ) : null}
      <div class={`actionbar__row${canStop ? '' : ' actionbar__row--one'}`}>
        <a class="btn btn--secondary btn--block" href={`${BASE}s/${encodeURIComponent(session.id)}/bar`} onClick={linkHandler}>
          <Icon name="cup" />
          Бар
        </a>
        {canStop ? (
          <button type="button" class={`btn btn--block ${session.unlimited && phase === 'unlimited' ? 'btn--primary' : 'btn--quiet'}`} onClick={() => setStopOpen(true)}>
            <Icon name="stop" />
            Закончить игру
          </button>
        ) : null}
      </div>
      {!session.is_payer && phase !== 'over' ? <p class="small actionbar__note">Закончить игру может тот, кто её оплатил.</p> : null}

      <ExtendDialog open={extendOpen} onClose={() => setExtendOpen(false)} session={session} tz={tz} reload={reload} />
      <StopDialog open={stopOpen} onClose={() => setStopOpen(false)} session={session} view={view} onStopped={onUpdate} />
    </div>
  );
}

function ExtendDialog({ open, onClose, session, tz, reload }) {
  const [minutes, setMinutes] = useState(60);
  const [quote, setQuote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const max = maxExtendMinutes(session);
  const paidUntil = Date.parse(session.paid_until);
  const from = Math.max(paidUntil, Date.now());
  // Бронь после игры (№106): к вариантам добавляем «до 20:55» — ровно до предела, если он не совпал с вариантом
  const limitText = extendLimitText(session, (x) => formatTime(x, tz));
  const options = max !== null && max >= 5 && !EXTEND_OPTIONS.includes(max) ? [...EXTEND_OPTIONS.filter((m) => m < max), max] : EXTEND_OPTIONS;

  useEffect(() => {
    if (!open) {
      setQuote(null);
      setError(null);
    } else if (max !== null && minutes > max) {
      // Бронь близко: выбираем самый длинный доступный вариант
      const fit = options.filter((m) => m <= max);
      if (fit.length) setMinutes(fit[fit.length - 1]);
    }
  }, [open]);

  const unlimited = Boolean(session.unlimited);
  const requestQuote = async (opts = {}) => {
    setBusy(true);
    setError(null);
    try {
      // Часы пакета (№112): есть на балансе — продление сразу с use_balance, гость может отказаться
      let useBalance = false;
      if (!unlimited && !opts.noBalance && session.club?.id) {
        const bal = await api.balance(session.club.id).catch(() => null);
        useBalance = (bal?.minutes ?? 0) > 0;
      }
      const q = await api.quote({ resourceId: session.resource.id, kind: 'extend', minutes: unlimited ? null : minutes, sessionId: session.id, useBalance });
      setFlow({
        kind: 'extend',
        sessionId: session.id,
        number: session.resource?.number,
        resourceId: session.resource?.id,
        timeZone: tz,
      });
      setQuote(q);
    } catch (err) {
      setError(err);
      if (err?.code === 'session_not_active' || err?.code === 'booking_conflict') reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={quote ? 'Оплата продления' : 'Продлить игру'} labelledBy="extend-title">
      {quote ? (
        <Pay
          quote={quote}
          what={unlimited ? `${tableName(session.resource?.number)} · без лимита` : `${tableName(session.resource?.number)} · ещё ${minutesWords(minutes)}`}
          kind="extend"
          unlimited={unlimited}
          timeZone={tz}
          onRequote={() => requestQuote()}
          onWithoutBalance={() => requestQuote({ noBalance: true })}
          onReception={(res) => {
            setFlow({
              extendRequest: {
                id: res.reception_request_id,
                sessionId: session.id,
                minutes: unlimited ? quote.unlimited?.hold_minutes ?? 120 : minutes,
                amount: unlimited ? quote.unlimited?.hold_amount_kopecks ?? quote.amount_kopecks : quote.amount_kopecks,
                paidUntilBefore: paidUntil,
                expiresAt: Date.now() + 15 * 60 * 1000,
              },
            });
            onClose();
          }}
        />
      ) : unlimited ? (
        <form
          class="step"
          onSubmit={(e) => {
            e.preventDefault();
            requestQuote();
          }}
        >
          <p class="lead">
            Игра без лимита оплачена до <span class="mono">{formatTime(session.paid_until, tz)}</span>. Продлите сейчас: картой — новая заморозка,
            по СБП — следующий блок. Платите всё равно только за сыгранное.
          </p>
          <ErrorNote error={error} limitUntil={session.extend_limit_until ? formatTime(session.extend_limit_until, tz) : undefined} />
          <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
            {busy ? 'Считаем цену…' : 'Рассчитать продление'}
          </button>
        </form>
      ) : (
        <form
          class="step"
          onSubmit={(e) => {
            e.preventDefault();
            requestQuote();
          }}
        >
          <fieldset>
            <legend class="step__label">На сколько продлить?</legend>
            <div class="choice choice--grid">
              {options.map((m) => {
                const blocked = max !== null && m > max;
                const toLimit = max !== null && m === max && !EXTEND_OPTIONS.includes(m);
                return (
                  <label class="choice__item" key={m}>
                    <input type="radio" name="extend" value={m} checked={minutes === m} disabled={blocked} onChange={() => setMinutes(m)} />
                    <span class="choice__box">
                      <span class="choice__title">{toLimit ? `До ${formatTime(session.extend_limit_until, tz)}` : optionLabel(m)}</span>
                      <span class="choice__sub">{blocked ? 'Стол забронирован' : `До ${formatTime(from + m * 60000, tz)}`}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          {limitText ? (
            <p class="note note--lamp">
              <Icon name="calendar" />
              <span class="note__title">{limitText}</span>
            </p>
          ) : null}
          <ErrorNote error={error} limitUntil={session.extend_limit_until ? formatTime(session.extend_limit_until, tz) : undefined} />
          <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy || (max !== null && minutes > max)}>
            {busy ? 'Считаем цену…' : `Рассчитать цену за ${minutesWords(minutes, { accusative: true })}`}
          </button>
        </form>
      )}
    </Dialog>
  );
}

function StopDialog({ open, onClose, session, view, onStopped }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const unlimited = session.unlimited;

  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await api.stop(session.id);
      onClose();
      onStopped(s);
      navigate(`${BASE}s/${encodeURIComponent(session.id)}/receipt`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Закончить игру?" labelledBy="stop-title">
      <div class="step">
        {unlimited ? (
          <p class="lead">
            Свет над столом погаснет. Посчитаем фактическое время — <b>{durationWords(view.ms)}</b> — и сразу покажем чек.
          </p>
        ) : (
          <>
            <p class="lead">Свет над столом погаснет.</p>
            <div class="note note--lamp">
              <Icon name="info" />
              <p class="note__title">Оплаченное время не возвращается</p>
              <p class="note__body">
                {view.phase === 'grace' ? 'Оплаченное время уже вышло.' : `Осталось ${durationWords(view.ms)} — они сгорят.`}
              </p>
            </div>
          </>
        )}
        <ErrorNote error={error} />
        <div class="dialog__actions">
          <button type="button" class="btn btn--primary btn--block btn--lg" disabled={busy} onClick={stop}>
            {busy ? 'Выключаем свет…' : 'Закончить и выключить свет'}
          </button>
          <button type="button" class="btn btn--quiet btn--block" onClick={onClose}>
            Продолжить игру
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** Свет погас без связи, а оплачено больше (T6): плательщик выбирает «Продолжить игру» или возврат. */
function Interrupted({ session, view, kind, onUpdate }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const left = durationWords(view.ms);

  const resolve = async (choice) => {
    setBusy(choice);
    setError(null);
    try {
      const s = await api.resolve(session.id, choice);
      onUpdate(s);
      if (choice === 'refund') navigate(`${BASE}s/${encodeURIComponent(session.id)}/receipt`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div class="screen">
      <Stage kind={kind} lit="false" label={`${tableName(session.resource?.number)}, игра прервана`}>
        <p class="stage__kicker">{tableName(session.resource?.number)}</p>
        <h1 class="stage__title display">Свет погас раньше времени</h1>
      </Stage>
      <main class="wrap content">
        <div class="step">
          <p class="lead">
            Стол терял связь с сервером и выключил свет по своему таймеру. Неотыгранное время — <b>{left}</b>.
          </p>
          {session.is_payer ? (
            <>
              <ErrorNote error={error} />
              <div class="stack">
                <button type="button" class="btn btn--primary btn--block btn--lg" disabled={Boolean(busy)} onClick={() => resolve('continue')}>
                  <Icon name="lamp" />
                  {busy === 'continue' ? 'Включаем свет…' : 'Продолжить игру'}
                </button>
                <button type="button" class="btn btn--quiet btn--block" disabled={Boolean(busy)} onClick={() => resolve('refund')}>
                  {busy === 'refund' ? 'Оформляем возврат…' : 'Вернуть деньги за неотыгранное время'}
                </button>
              </div>
              <p class="hint">«Продолжить игру» включит свет на {left}. Возврат придёт на карту или счёт, с которого вы платили.</p>
            </>
          ) : (
            <p class="hint">Решение — продолжить игру или вернуть деньги — принимает тот, кто оплатил игру.</p>
          )}
        </div>
      </main>
    </div>
  );
}

function Closed({ session, kind, tab }) {
  const t = tabSummary(tab);
  return (
    <div class="screen">
      <Stage kind={kind} lit="false" label={`${tableName(session.resource?.number)}, игра завершена`}>
        <p class="stage__kicker">{tableName(session.resource?.number)}</p>
        <h1 class="stage__title display">{session.status === 'cancelled' ? 'Игра отменена' : 'Игра завершена'}</h1>
      </Stage>
      <main class="wrap content">
        <div class="step">
          <p class="lead">Свет над столом выключен. Спасибо за игру!</p>
          {t.open ? (
            <div class="note note--lamp" role="status">
              <Icon name="cup" />
              <p class="note__title">Счёт бара не оплачен: {formatMoney(t.total)}</p>
              <p class="note__body">{t.count ? `${ordersWord(t.count)} в счёте стола. ` : ''}Оплатите онлайн или на ресепшене перед уходом.</p>
              <div class="note__actions">
                <a class="btn btn--primary btn--sm" href={`${BASE}s/${encodeURIComponent(session.id)}/bar#tab`} onClick={linkHandler}>
                  Оплатить счёт бара
                </a>
              </div>
            </div>
          ) : null}
          <a class="btn btn--primary btn--block btn--lg" href={`${BASE}s/${encodeURIComponent(session.id)}/receipt`} onClick={linkHandler}>
            <Icon name="receipt" />
            Открыть чек
          </a>
        </div>
      </main>
    </div>
  );
}

/** Полоса бара на экране «Игра»: текущий заказ и счёт стола (M2). Ничего не заказано — ничего не показываем. */
function BarStrip({ sessionId, bar }) {
  const order = currentOrder(bar.orders);
  const t = tabSummary(bar.tab);
  if (!order && !t.open) return null;
  return (
    <a class="barstrip" href={`${BASE}s/${encodeURIComponent(sessionId)}/bar`} onClick={linkHandler}>
      <Icon name="cup" />
      <span class="barstrip__text">
        {order ? (
          <span class="barstrip__main">
            Заказ № {order.number}: {order.awaiting_payment ? 'ждёт оплаты' : orderWord(order.status).toLowerCase()}
          </span>
        ) : null}
        {t.open ? (
          <span class="barstrip__sub">
            Счёт стола <b class="mono">{formatMoney(t.total)}</b>
            {t.count ? `, ${ordersWord(t.count)}` : ''}
          </span>
        ) : null}
      </span>
      <Icon name="forward" />
    </a>
  );
}
