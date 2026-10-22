import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { formatDate, formatDuration, formatMoney, formatTime, plural } from '@billiardum/shared/format';
import { planLayout, tableSvg, typeLabel } from '@billiardum/shared/hall';
import {
  BOOKING_WORD,
  addDays,
  boardSlots,
  bookingOpen,
  bookingPrice,
  busyAt,
  cancelText,
  durationsFor,
  freeTables,
  holdMinutes,
  localDate,
  prepayFor,
  sortBookings,
  waitlistView,
} from '@billiardum/shared/booking';
import { Header } from '../components/Header.jsx';
import { Icon } from '../components/Icon.jsx';
import { Dialog } from '../components/Dialog.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { useNow, usePoll } from '../components/hooks.js';
import { SignIn } from './SignIn.jsx';
import { Consent } from './Consent.jsx';
import { api } from '../lib/api.js';
import { auth, needsConsent } from '../lib/auth.js';
import { session as sessionStore, useStore } from '../lib/store.js';
import { linkHandler, navigate } from '../lib/router.js';
import { BASE } from '../lib/env.js';
import { minutesWords, tableName } from '../lib/words.js';
import { safeRedirectUrl } from '../lib/urls.js';
import { clubTimeZone, getFlow, lastClub, setFlow } from '../lib/flow.js';
import { useMeStream } from '../lib/live.js';
import '../styles/m3.css';

const MIN = 60_000;
const TABLES = ['стол', 'стола', 'столов'];
const WEEKDAY = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' });
const dayShort = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  return WEEKDAY.format(new Date(Date.UTC(y, m - 1, d)));
};
const DAY_FORMAT = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const dayLong = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  return DAY_FORMAT.format(new Date(Date.UTC(y, m - 1, d)));
};
const pct = (v) => `${(v * 100).toFixed(3)}%`;
const PAY_METHODS = [
  ['sbp', 'transfer', 'СБП', 'В приложении банка'],
  ['card', 'card', 'Картой', 'На странице ЮKassa'],
];

/** Выбор клуба для брони: GET /api/clubs (без входа, №120); клуб, где гость уже был, — первым. */
export function BookClubs() {
  const [clubs, setClubs] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api
      .clubs()
      .then((list) => {
        const here = lastClub()?.id;
        const all = Array.isArray(list) ? list : [];
        setClubs([...all.filter((c) => c.id === here), ...all.filter((c) => c.id !== here)]);
      })
      .catch((err) => {
        // Нет связи со списком — хотя бы клуб, где гость открывал стол по QR
        const c = lastClub();
        if (c) setClubs([c]);
        else setError(err);
      });
  }, []);
  return (
    <div class="screen screen--paper">
      <Header back={{ href: BASE, label: 'На главную' }} />
      <main class="wrap content book">
        <h1 class="page-title display">Бронь стола</h1>
        <p class="lead">Выберите клуб, день и время — стол на плане зала будет ждать вас.</p>
        <ErrorNote error={error} />
        {clubs === null && !error ? <p class="muted">Загружаем клубы…</p> : null}
        {clubs?.length === 0 ? <p class="empty">Клубов с бронью пока нет.</p> : null}
        {clubs?.length ? (
          <ul class="clublist">
            {clubs.map((c) => (
              <li key={c.id}>
                <a class="clublist__item" href={`${BASE}book/${encodeURIComponent(c.id)}`} onClick={linkHandler}>
                  <span class="clublist__name">{c.name}</span>
                  <span class="clublist__sub">
                    {[c.city, c.address].filter(Boolean).join(', ')}
                  </span>
                  <Icon name="forward" />
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        <a class="btn btn--quiet btn--block" href={`${BASE}bookings`} onClick={linkHandler}>
          <Icon name="calendar" />
          Мои брони
        </a>
      </main>
    </div>
  );
}

/**
 * Бронь стола (PRODUCT §6, DESIGN §1, §4): день → время на борт-шкале → стол на плане зала → длительность → предоплата.
 * Свободные интервалы — GET /api/clubs/{club}/availability?date=; бронь — POST /api/bookings; предоплата — /pay (ЮKassa).
 */
export function BookScreen({ clubId }) {
  const KEY = `bl-book:${clubId}`;
  const saved = sessionStore.get(KEY) ?? {};
  const { status: authStatus, user } = useStore(auth);
  const [day, setDay] = useState(null);
  const [date, setDate] = useState(saved.date ?? null);
  const [slot, setSlot] = useState(saved.slot ?? null);
  const [resourceId, setResourceId] = useState(saved.resourceId ?? null);
  const [minutes, setMinutes] = useState(saved.minutes ?? null);
  const [method, setMethod] = useState('sbp');
  const [loadError, setLoadError] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [askAuth, setAskAuth] = useState(false);
  const now = useNow(0, true);

  // Рабочие сутки клуба (после полуночи до day_start — ещё вчерашние): дата availability без date
  const [workday, setWorkday] = useState(null);
  useEffect(() => {
    api
      .availability(clubId)
      .then((res) => {
        if (!res?.date) return;
        setWorkday(res.date);
        // Сохранённый день уже прошёл — на сегодня
        setDate((x) => (x && x < res.date ? res.date : x));
      })
      .catch(() => {});
  }, [clubId]);
  const load = useCallback(
    async (d) => {
      try {
        const res = await api.availability(clubId, d ?? undefined);
        setDay(res);
        setLoadError(null);
        if (!d) setDate(res.date);
      } catch (err) {
        setLoadError(err);
      }
    },
    [clubId],
  );
  useEffect(() => {
    load(date);
  }, [date]);
  useEffect(() => sessionStore.set(KEY, { date, slot, resourceId, minutes }), [date, slot, resourceId, minutes]);

  const tz = day?.club?.timezone ?? 'Europe/Moscow';
  const today = workday ?? localDate(now, tz);
  const days = useMemo(() => Array.from({ length: Math.min((day?.max_days ?? 6) + 1, 14) }, (_, i) => addDays(today, i)), [today, day?.max_days]);
  const ready = day && day.date === date;
  const minLen = day?.min_minutes ?? 60;
  const slots = ready ? boardSlots(day, { resourceId, now }) : [];
  const free = ready && slot ? freeTables(day, slot, minLen) : new Set();
  const durations = ready && slot && resourceId ? durationsFor(day, resourceId, slot) : [];
  const chosenMinutes = durations.includes(minutes) ? minutes : (durations[0] ?? null);
  const resource = day?.resources?.find((r) => r.id === resourceId);
  // Цена по тарифу стола (availability.resources[].rates); окончательную считает сервер при брони
  const price = ready && slot && chosenMinutes && resource ? bookingPrice(resource.rates ?? day.rates, slot, chosenMinutes) : null;
  const prepay = price ? prepayFor(day.rules, price.amount_kopecks) : 0;

  // Выбранное время стало недоступным (заняли, прошло) — сбрасываем
  useEffect(() => {
    if (!ready || !slot) return;
    const s = slots.find((x) => x.at === slot);
    if (!s || s.state !== 'free') {
      setSlot(null);
      setResourceId(null);
    } else if (resourceId && !free.has(resourceId) && !durationsFor(day, resourceId, slot).length) setResourceId(null);
  }, [ready, day]);

  const pickDate = (d) => {
    setDate(d);
    setSlot(null);
    setResourceId(null);
    setError(null);
  };
  const pickSlot = (at) => {
    setSlot(at);
    setError(null);
    if (resourceId && !freeTables(day, at, minLen).has(resourceId)) setResourceId(null);
  };

  const book = async () => {
    setError(null);
    if (auth.get().status !== 'user') {
      setAskAuth(true);
      return;
    }
    if (needsConsent(auth.get().user)) {
      setAskAuth(true);
      return;
    }
    setBusy(true);
    try {
      const b = await api.createBooking({ resource_id: resourceId, starts_at: new Date(slot).toISOString(), minutes: chosenMinutes });
      sessionStore.set(KEY, null);
      if (b.status === 'pending_payment') {
        try {
          const res = await api.payBooking(b.id, method);
          const url = safeRedirectUrl(res?.confirmation?.url ?? res?.confirmation?.confirmation_url);
          if (url) {
            // return_url ЮKassa — /app/bookings/{id}?paid=1: экран брони дождётся подтверждения
            setFlow({ kind: 'booking', bookingId: b.id, paymentId: res.payment_id });
            window.location.assign(url);
            return;
          }
        } catch {
          // оплатить можно со страницы брони
        }
      }
      navigate(`${BASE}bookings/${encodeURIComponent(b.id)}`);
    } catch (err) {
      setError(err);
      if (['booking_conflict', 'table_busy', 'table_pending', 'table_service', 'bad_request'].includes(err?.code)) load(date);
      setBusy(false);
    }
  };

  const signedIn = authStatus === 'user';
  const consentNeeded = signedIn && needsConsent(user);

  return (
    <div class="screen screen--paper">
      <Header back={{ href: `${BASE}book`, label: 'К выбору клуба' }} />
      <main class="wrap content book">
        <div class="book__head">
          <h1 class="page-title display">Бронь стола</h1>
          {day?.club?.name ? <p class="muted">{day.club.name}</p> : null}
        </div>

        <ErrorNote error={loadError}>
          <button type="button" class="btn btn--secondary btn--sm" onClick={() => load(date)}>
            <Icon name="refresh" />
            Загрузить снова
          </button>
        </ErrorNote>

        <section class="book__step" aria-labelledby="b-date">
          <h2 class="step__label" id="b-date">
            День
          </h2>
          <div class="days" role="radiogroup" aria-labelledby="b-date">
            {days.map((d, i) => (
              <label class="day" key={d}>
                <input type="radio" name="book-day" checked={date === d} onChange={() => pickDate(d)} />
                <span class="day__box">
                  <span class="day__wd">{i === 0 ? 'Сегодня' : i === 1 ? 'Завтра' : dayShort(d)}</span>
                  <span class="day__num">{dayLong(d)}</span>
                </span>
              </label>
            ))}
          </div>
        </section>

        <section class="book__step" aria-labelledby="b-time">
          <h2 class="step__label" id="b-time">
            Время начала
            {resource ? <span class="step__aside">для стола {resource.number}</span> : null}
          </h2>
          {!ready ? <p class="muted">Загружаем свободное время…</p> : <BoardScale slots={slots} selected={slot} minutes={chosenMinutes ?? minLen} onPick={pickSlot} tz={tz} date={date} tableChosen={Boolean(resource)} total={day.resources.length} />}
        </section>

        {ready && slot ? (
          <section class="book__step" aria-labelledby="b-table">
            <h2 class="step__label" id="b-table">
              Стол
              <span class="step__aside">
                с {formatTime(slot, tz)}: свободно {free.size} {plural(free.size, TABLES)}
              </span>
            </h2>
            <BookPlan day={day} slot={slot} free={free} selected={resourceId} onPick={(id) => setResourceId(id)} tz={tz} />
          </section>
        ) : null}

        {ready && slot && resource ? (
          <section class="book__step" aria-labelledby="b-len">
            <h2 class="step__label" id="b-len">
              Сколько играете
            </h2>
            {durations.length ? (
              <div class="choice choice--grid">
                {durations.map((m) => (
                  <label class="choice__item" key={m}>
                    <input type="radio" name="book-len" checked={chosenMinutes === m} onChange={() => setMinutes(m)} />
                    <span class="choice__box">
                      <span class="choice__title">{minutesWords(m)}</span>
                      <span class="choice__sub">
                        {formatTime(slot, tz)}–{formatTime(slot + m * MIN, tz)}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <p class="note note--error">
                <Icon name="alert" />
                <span class="note__title">С {formatTime(slot, tz)} стол свободен меньше часа. Выберите другое время или стол.</span>
              </p>
            )}
          </section>
        ) : null}

        {ready && slot && resource && chosenMinutes ? (
          <section class="book__sum" aria-labelledby="b-sum">
            <h2 class="book__what" id="b-sum">
              {tableName(resource.number)} · {dayLong(date)}, {formatTime(slot, tz)}–{formatTime(slot + chosenMinutes * MIN, tz)}
            </h2>
            <p class="muted">{typeLabel(resource.type, resource.title)}</p>
            {price ? (
              <dl class="receipt">
                {price.breakdown.length > 1
                  ? price.breakdown.map((p) => (
                      <div class="receipt__row" key={p.from}>
                        <dt>
                          <span class="mono">
                            {formatTime(p.from, tz)}–{formatTime(p.to, tz)}
                          </span>{' '}
                          · {formatMoney(p.per_hour_kopecks)}/ч
                        </dt>
                        <dd class="receipt__sum">{formatMoney(p.amount_kopecks)}</dd>
                      </div>
                    ))
                  : null}
                <div class="receipt__row receipt__row--total">
                  <dt>Игра</dt>
                  <dd class="receipt__sum">{formatMoney(price.amount_kopecks)}</dd>
                </div>
                {prepay ? (
                  <div class="receipt__row">
                    <dt>Предоплата сейчас</dt>
                    <dd class="receipt__sum">{formatMoney(prepay)}</dd>
                  </div>
                ) : null}
              </dl>
            ) : null}
            <ul class="rules">
              <li>
                <Icon name="clock" />
                Стол держим {minutesWords(holdMinutes(prepay, day.rules), { accusative: true })} после начала. Не пришли — бронь сгорает
                {prepay ? ', предоплата — по правилам клуба' : ''}.
              </li>
              <li>
                <Icon name="calendar" />
                {prepay
                  ? `Отмена с возвратом предоплаты — не позже чем за ${minutesWords(day.rules?.free_cancel_minutes ?? 120, { accusative: true })} до начала.`
                  : 'Отменить можно в «Моих бронях».'}
              </li>
              <li>
                <Icon name="qr" />
                Придёте — отсканируйте QR на столе: игра начнётся по брони{prepay >= (price?.amount_kopecks ?? 0) && prepay ? ' без повторной оплаты' : ''}.
              </li>
            </ul>
            {prepay ? (
              <fieldset>
                <legend class="step__label">Способ предоплаты</legend>
                <div class="choice choice--methods">
                  {PAY_METHODS.map(([m, icon, title, sub]) => (
                    <label class="choice__item" key={m}>
                      <input type="radio" name="book-method" checked={method === m} onChange={() => setMethod(m)} />
                      <span class="choice__box choice__box--row">
                        <Icon name={icon} />
                        <span>
                          <span class="choice__title">{title}</span>
                          <span class="choice__sub">{sub}</span>
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}
            {askAuth && !signedIn ? <SignIn title="Войдите, чтобы забронировать" onDone={() => setAskAuth(false)} /> : null}
            {askAuth && consentNeeded ? <Consent onDone={() => setAskAuth(false)} /> : null}
            {error?.code === 'limit_exceeded' ? (
              <p class="note note--error" role="alert">
                <Icon name="alert" />
                <span class="note__title">У вас уже три брони в этом клубе</span>
                <span class="note__body">Отмените одну в «Моих бронях» или дождитесь, когда ближайшая начнётся.</span>
              </p>
            ) : (
              <ErrorNote error={error} />
            )}
            {!askAuth || (signedIn && !consentNeeded) ? (
              <div class="actionbar">
                <button type="button" class="btn btn--primary btn--block btn--lg" disabled={busy} onClick={book}>
                  <Icon name="calendar" />
                  {busy ? 'Бронируем…' : prepay ? `Забронировать и оплатить ${formatMoney(prepay)}` : 'Забронировать стол'}
                </button>
              </div>
            ) : null}
          </section>
        ) : null}
      </main>
    </div>
  );
}

/**
 * Борт-шкала (DESIGN §1, §4): борт стола с прицельными метками на каждом часе, деления по шагу клуба.
 * Занятые закрашены, выбранное подсвечено лампой. Каждое деление — переключатель с подписью для диктора;
 * стрелки двигают фокус, на узком экране шкала прокручивается внутри блока.
 */
export function BoardScale({ slots, selected, minutes = 60, onPick, tz, date, tableChosen, total }) {
  const scroller = useRef(null);
  const refs = useRef(new Map());
  const firstFree = slots.find((s) => s.state === 'free')?.at ?? null;
  const focusAt = selected ?? firstFree;

  // Показать выбранное или первое свободное деление (без прокрутки страницы)
  useEffect(() => {
    const el = refs.current.get(focusAt);
    const box = scroller.current;
    if (el && box) box.scrollLeft = Math.max(0, el.offsetLeft - box.clientWidth / 3);
  }, [date, slots.length]);

  const move = (from, dir) => {
    const list = slots.filter((s) => s.state === 'free');
    const i = list.findIndex((s) => s.at === from);
    const next = list[Math.min(list.length - 1, Math.max(0, i + dir))];
    if (next) {
      onPick(next.at);
      refs.current.get(next.at)?.focus();
    }
  };

  if (!slots.length) return <p class="empty">В этот день клуб не принимает брони.</p>;
  const freeCount = slots.filter((s) => s.state === 'free').length;

  return (
    <div class="board">
      <div class="board__scroll" ref={scroller}>
        <div class="board__rail" role="radiogroup" aria-label={`Время начала, ${dayLong(date)}`} style={{ '--slots': slots.length }}>
          {slots.map((s) => {
            const on = s.at === selected;
            // Выбранный интервал целиком светится лампой: начало ярко, дальше — мягче
            const inRange = selected !== null && s.at > selected && s.at < selected + minutes * MIN;
            const word = s.state === 'past' ? 'уже нельзя' : s.state === 'busy' ? (tableChosen ? 'стол занят' : 'все столы заняты') : tableChosen ? 'свободно' : `свободно ${s.free} ${plural(s.free, TABLES)}`;
            return (
              <button
                type="button"
                role="radio"
                key={s.at}
                ref={(el) => (el ? refs.current.set(s.at, el) : refs.current.delete(s.at))}
                class={`slot slot--${s.state}${s.hour ? ' slot--hour' : ''}${on ? ' slot--on' : ''}${inRange ? ' slot--range' : ''}`}
                aria-checked={on ? 'true' : 'false'}
                aria-label={`${s.label}, ${word}`}
                disabled={s.state !== 'free'}
                tabIndex={s.at === focusAt ? 0 : -1}
                onClick={() => onPick(s.at)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    move(s.at, 1);
                  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    move(s.at, -1);
                  }
                }}
              >
                <span class="slot__time" aria-hidden="true">
                  {s.hour ? s.label.slice(0, 2) : ''}
                </span>
                <span class="slot__cell" aria-hidden="true">
                  {s.hour ? <span class="slot__mark" /> : null}
                </span>
                <span class="slot__free" aria-hidden="true">
                  {!tableChosen && s.state === 'free' && total > 1 ? s.free : ''}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <ul class="board__legend" aria-hidden="true">
        <li>
          <span class="board__key board__key--free" />
          Свободно{!tableChosen && total > 1 ? ', цифра — сколько столов' : ''}
        </li>
        <li>
          <span class="board__key board__key--busy" />
          Занято
        </li>
        <li>
          <span class="board__key board__key--on" />
          Выбрано
        </li>
      </ul>
      {selected ? (
        <p class="board__picked" aria-live="polite">
          Начало в <b class="mono">{formatTime(selected, tz)}</b>
          {minutes ? (
            <>
              , до <b class="mono">{formatTime(selected + minutes * MIN, tz)}</b>
            </>
          ) : null}
        </p>
      ) : (
        <p class="board__picked muted">{freeCount ? 'Нажмите на деление борта — это время начала.' : 'Свободного времени в этот день нет. Выберите другой день.'}</p>
      )}
    </div>
  );
}

/** План зала для брони: свободные на выбранное время столы тёмные и нажимаются, занятые приглушены со словом «до 20:00». */
function BookPlan({ day, slot, free, selected, onPick, tz }) {
  const layout = useMemo(() => planLayout(day.resources.map((r) => ({ id: r.id, number: r.number, type: r.type }))), [day.resources.map((r) => r.id).join(',')]);
  const svgs = useMemo(() => new Map(layout.items.map((p) => [p.id, tableSvg(p.kind, { uid: `bk-${p.id}` })])), [layout]);
  const byId = new Map(day.resources.map((r) => [r.id, r]));
  const minLen = day.min_minutes ?? 60;
  return (
    <div class="hall book__hall" data-theme="dark">
      <div class="hall__head">
        <ul class="legend" aria-hidden="true">
          <li>
            <span class="legend__mark" />
            Свободен
          </li>
          <li>
            <span class="legend__mark legend__mark--booked" />
            Выбран
          </li>
          <li>
            <span class="legend__mark legend__mark--off" />
            Занят
          </li>
        </ul>
      </div>
      <div class="hall__floor">
        <div class="plan" role="group" aria-label={`План зала на ${formatTime(slot, tz)}`} style={{ aspectRatio: `${layout.width} / ${layout.height}` }}>
          {layout.items.map((p) => {
            const r = byId.get(p.id);
            const ok = free.has(p.id) && r.bookable !== false;
            const clash = busyAt(r, slot, slot + minLen * MIN);
            const word = ok ? 'Свободен' : r.bookable === false ? 'Не бронируется' : clash ? (clash.kind === 'booking' ? `Бронь до ${formatTime(clash.to, tz)}` : `Занят до ${formatTime(clash.to, tz)}`) : 'Занят';
            const on = selected === p.id;
            return (
              <button
                type="button"
                key={p.id}
                class="tbl lit-host"
                data-lit="false"
                data-tone={on ? 'booked' : 'free'}
                data-kind={p.kind}
                disabled={!ok}
                aria-pressed={on ? 'true' : 'false'}
                aria-label={`Стол ${p.number}, ${word.toLowerCase()}. ${typeLabel(r.type, r.title)}`}
                style={{ left: pct(p.x / layout.width), top: pct(p.y / layout.height), width: pct(p.w / layout.width) }}
                onClick={() => onPick(p.id)}
              >
                <span class="tbl__art" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svgs.get(p.id) }} />
                <span class="tbl__cap" aria-hidden="true">
                  <span class="tbl__num">Стол {p.number}</span>
                  <span class="tbl__status">{on ? 'Выбран' : word}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Мои брони: ближайшие сверху, прошедшие ниже. */
export function MyBookings() {
  const { status } = useStore(auth);
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const load = () =>
    api
      .myBookings()
      .then((l) => setList(sortBookings(Array.isArray(l) ? l : [])))
      .catch(setError);
  useEffect(() => {
    if (status === 'user') load();
  }, [status]);
  // Подтвердилась, сгорела, отменена — поток гостя (№120)
  useMeStream((name) => name === 'booking' && load(), status === 'user');
  const open = (list ?? []).filter(bookingOpen);
  const past = (list ?? []).filter((b) => !bookingOpen(b));
  return (
    <div class="screen screen--paper">
      <Header back={{ href: BASE, label: 'На главную' }} />
      <main class="wrap content book">
        <h1 class="page-title display">Мои брони</h1>
        {status === 'anon' ? <SignIn title="Войдите, чтобы увидеть брони" /> : null}
        <ErrorNote error={error} />
        {status === 'user' && list === null && !error ? <p class="muted">Загружаем брони…</p> : null}
        {list && !open.length ? <p class="empty">Ближайших броней нет. Забронируйте стол — он будет ждать вас в выбранное время.</p> : null}
        {open.length ? <BookingList list={open} title="Ближайшие" /> : null}
        <a class="btn btn--primary btn--block btn--lg" href={`${BASE}book`} onClick={linkHandler}>
          <Icon name="calendar" />
          Забронировать стол
        </a>
        {past.length ? <BookingList list={past} title="Прошедшие" quiet /> : null}
      </main>
    </div>
  );
}

function BookingList({ list, title, quiet = false }) {
  return (
    <section aria-label={title}>
      <h2 class="step__label">{title}</h2>
      <ul class={`blist${quiet ? ' blist--quiet' : ''}`}>
        {list.map((b) => {
          const tz = b.club?.timezone ?? 'Europe/Moscow';
          return (
            <li key={b.id}>
              <a class="blist__item" href={`${BASE}bookings/${encodeURIComponent(b.id)}`} onClick={linkHandler}>
                <span class="blist__when">
                  <span class="blist__date">{formatDate(b.starts_at, tz)}</span>
                  <span class="blist__time mono">
                    {formatTime(b.starts_at, tz)}–{formatTime(b.ends_at, tz)}
                  </span>
                </span>
                <span class="blist__what">
                  {tableName(b.resource?.number)}
                  {b.club?.name ? ` · ${b.club.name}` : ''}
                </span>
                <span class={`badge badge--${badgeTone(b.status)}`}>
                  <span class="badge__dot" aria-hidden="true" />
                  {BOOKING_WORD[b.status] ?? b.status}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const badgeTone = (s) => (s === 'confirmed' || s === 'reserved' ? 'reserved' : s === 'pending_payment' ? 'pending' : s === 'started' ? 'play' : s === 'expired' ? 'alert' : 'free');

/** Бронь: подробности, предоплата (return_url /app/bookings/{id}), как начать, отмена по правилам. */
export function BookingScreen({ id }) {
  const [b, setB] = useState(null);
  const [error, setError] = useState(null);
  const [method, setMethod] = useState('sbp');
  const [busy, setBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [refund, setRefund] = useState(null);
  // Вернулись с оплаты предоплаты (return_url /app/bookings/{id}?paid=1): подтверждение ЮKassa приходит через
  // несколько секунд — событие booking в потоке гостя (№120), без потока — опрос раз в 2,5 секунды
  const watching = useRef(getFlow().bookingId === id || new URLSearchParams(location.search).has('paid'));
  const load = async () => {
    try {
      const next = await api.booking(id);
      setB(next);
      setError(null);
      if (next.status !== 'pending_payment' && watching.current) {
        watching.current = false;
        setFlow({ bookingId: null });
      }
    } catch (err) {
      setError(err);
    }
  };
  const live = useMeStream((name, data) => {
    if (name === 'open' || (name === 'booking' && data?.id === id)) load();
  });
  usePoll(
    async () => {
      if (b && (live || !(b.status === 'pending_payment' && watching.current))) return;
      await load();
    },
    2500,
    [id, live],
  );
  const tz = b?.club?.timezone ?? 'Europe/Moscow';
  const fmtT = (x) => formatTime(x, tz);

  const pay = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.payBooking(id, method);
      const url = safeRedirectUrl(res?.confirmation?.url ?? res?.confirmation?.confirmation_url);
      if (!url) throw Object.assign(new Error('confirmation'), { code: 'payment_failed' });
      setFlow({ kind: 'booking', bookingId: id, paymentId: res.payment_id });
      window.location.assign(url);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.cancelBooking(id);
      setRefund(res?.refund_kopecks ?? 0);
      setB(res);
      setCancelOpen(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (!b) {
    return (
      <div class="screen screen--paper">
        <Header back={{ href: `${BASE}bookings`, label: 'Мои брони' }} />
        <main class="wrap content">
          <ErrorNote error={error} />
          {!error ? <p class="muted">Загружаем бронь…</p> : null}
        </main>
      </div>
    );
  }

  const waitingPay = b.status === 'pending_payment' && watching.current;
  const terms = cancelText(b, { formatMoney, formatTime: fmtT });
  return (
    <div class="screen screen--paper">
      <Header back={{ href: `${BASE}bookings`, label: 'Мои брони' }} />
      <main class="wrap content book">
        <section class="bcard" aria-labelledby="bk-title">
          <p class="bcard__code">{b.source === 'phone' ? 'Бронь по телефону' : 'Бронь стола'}</p>
          <h1 class="bcard__time display" id="bk-title">
            {fmtT(b.starts_at)}–{fmtT(b.ends_at)}
          </h1>
          <p class="bcard__day">
            {formatDate(b.starts_at, tz)} · {tableName(b.resource?.number)}
          </p>
          <p class="muted">
            {b.club?.name}
            {b.resource ? ` · ${typeLabel(b.resource.type, b.resource.title)}` : ''}
          </p>
          <p class={`badge badge--${badgeTone(b.status)}`}>
            <span class="badge__dot" aria-hidden="true" />
            {BOOKING_WORD[b.status] ?? b.status}
          </p>
        </section>

        {refund !== null ? (
          <p class="note note--free" role="status">
            <Icon name="check" />
            <span class="note__title">Бронь отменена</span>
            <span class="note__body">{refund ? `Вернём ${formatMoney(refund)} тем же способом, которым вы платили: обычно это занимает до 3 рабочих дней.` : 'Стол освобождён для других гостей.'}</span>
          </p>
        ) : null}

        {waitingPay ? (
          <p class="waiting" role="status">
            <span class="waiting__dot" aria-hidden="true" />
            Проверяем предоплату. Обычно это несколько секунд.
          </p>
        ) : null}

        {b.status === 'pending_payment' && !waitingPay ? (
          <section class="step" aria-labelledby="bk-pay">
            <h2 class="step__label" id="bk-pay">
              Предоплата {formatMoney(b.prepayment_kopecks)}
            </h2>
            <p class="hint">
              Без предоплаты клуб не держит стол{b.pay_until ? `: оплатите до ${fmtT(b.pay_until)}, иначе бронь снимется` : ''}.
            </p>
            <div class="choice choice--methods">
              {PAY_METHODS.map(([m, icon, title, sub]) => (
                <label class="choice__item" key={m}>
                  <input type="radio" name="bk-method" checked={method === m} onChange={() => setMethod(m)} />
                  <span class="choice__box choice__box--row">
                    <Icon name={icon} />
                    <span>
                      <span class="choice__title">{title}</span>
                      <span class="choice__sub">{sub}</span>
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <div class="actionbar">
              <button type="button" class="btn btn--primary btn--block btn--lg" disabled={busy} onClick={pay}>
                {busy ? 'Открываем оплату…' : `Оплатить ${formatMoney(b.prepayment_kopecks)}`}
              </button>
            </div>
          </section>
        ) : null}

        {b.status === 'confirmed' || b.status === 'reserved' ? (
          <section class="note note--lamp" aria-labelledby="bk-how">
            <Icon name="qr" />
            <h2 class="note__title" id="bk-how">
              {b.status === 'reserved' ? `${tableName(b.resource?.number)} ждёт вас` : 'Как начать игру'}
            </h2>
            <p class="note__body">
              Отсканируйте QR на столе {b.resource?.number} и нажмите «Начать игру по брони»
              {b.paid_kopecks >= b.amount_kopecks ? ' — без повторной оплаты' : ''}. Стол держим до {fmtT(b.hold_until)}.
            </p>
          </section>
        ) : null}

        {b.status === 'expired' ? (
          <p class="note note--error">
            <Icon name="alert" />
            <span class="note__title">Бронь сгорела</span>
            <span class="note__body">Гость не пришёл до {fmtT(b.hold_until)}. {b.paid_kopecks ? 'Предоплата — по правилам клуба.' : ''}</span>
          </p>
        ) : null}

        {b.status === 'started' && b.session_id ? (
          <a class="btn btn--primary btn--block btn--lg" href={`${BASE}s/${encodeURIComponent(b.session_id)}`} onClick={linkHandler}>
            <Icon name="lamp" />
            Открыть игру
          </a>
        ) : null}

        <dl class="receipt">
          <div class="receipt__row">
            <dt>Игра, {minutesWords(b.minutes)}</dt>
            <dd class="receipt__sum">{formatMoney(b.amount_kopecks)}</dd>
          </div>
          <div class="receipt__row">
            <dt>Оплачено</dt>
            <dd class="receipt__sum">{formatMoney(b.paid_kopecks ?? 0)}</dd>
          </div>
        </dl>

        <ErrorNote error={error} />

        {terms.allowed && bookingOpen(b) ? (
          <>
            <p class="hint">{terms.text}</p>
            <button type="button" class="btn btn--quiet btn--block" onClick={() => setCancelOpen(true)}>
              Отменить бронь
            </button>
          </>
        ) : null}
      </main>

      <Dialog open={cancelOpen} onClose={() => setCancelOpen(false)} title="Отменить бронь?" labelledBy="cancel-title">
        <div class="step">
          <p class="lead">
            {tableName(b.resource?.number)}, {formatDate(b.starts_at, tz)}, {fmtT(b.starts_at)}–{fmtT(b.ends_at)}.
          </p>
          <p class="hint">{terms.text}</p>
          <ErrorNote error={error} />
          <button type="button" class="btn btn--danger btn--block btn--lg" disabled={busy} onClick={cancel}>
            {busy ? 'Отменяем…' : 'Отменить бронь'}
          </button>
          <button type="button" class="btn btn--quiet btn--block" onClick={() => setCancelOpen(false)}>
            Оставить бронь
          </button>
        </div>
      </Dialog>
    </div>
  );
}

/** Предложение из листа ожидания (ссылка из уведомления /app/waitlist/{id}): таймер 5 минут и «Занять стол». */
export function WaitlistOffer({ id }) {
  const { status } = useStore(auth);
  const [entry, setEntry] = useState(undefined);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tz, setTz] = useState(() => clubTimeZone(lastClub()?.timezone));
  const now = useNow(0, entry?.status === 'offered');
  const v = waitlistView(entry, now);

  const load = useCallback(async () => {
    try {
      const list = await api.myWaitlist();
      setEntry((Array.isArray(list) ? list : []).find((w) => w.id === id) ?? null);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [id]);
  // Поток гостя (№120): предложение, удержание, очередь сдвинулась; без потока — опрос раз в 5 секунд
  const live = useMeStream((name, data) => {
    if (name === 'open' || (name === 'waitlist' && (data?.offer_id ?? data?.id) === id)) load();
  }, status === 'user');
  useEffect(() => {
    if (status !== 'user' || live) return undefined;
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [id, status, live]);
  // Время «держим до» — по часовому поясу клуба записи
  const clubId = entry?.club_id;
  useEffect(() => {
    if (!clubId) return;
    api
      .clubs()
      .then((list) => {
        const c = (Array.isArray(list) ? list : []).find((x) => x.id === clubId);
        if (c?.timezone) setTz(c.timezone);
      })
      .catch(() => {});
  }, [clubId]);

  const take = async () => {
    setBusy(true);
    setError(null);
    try {
      // Кода стола в ответе нет (№119): стол держим за гостем, игра — сканированием QR на столе
      const w = await api.acceptWaitlist(id);
      setEntry((e) => ({ ...e, ...w, id, status: 'accepted' }));
    } catch (err) {
      setError(err);
      load();
    } finally {
      setBusy(false);
    }
  };
  const rejoin = async () => {
    setBusy(true);
    setError(null);
    try {
      const w = await api.joinWaitlist(entry.resource.id);
      // Новая запись — со своей ссылкой; экран следит за ней
      navigate(`${BASE}waitlist/${encodeURIComponent(w.id)}`, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const leave = async () => {
    setBusy(true);
    try {
      await api.leaveWaitlist(id);
      setEntry(null);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="screen screen--paper">
      <Header back={{ href: BASE, label: 'На главную' }} />
      <main class="wrap content book">
        {status === 'anon' ? <SignIn title="Войдите, чтобы занять стол" /> : null}
        <ErrorNote error={error} />
        {entry === undefined && status === 'user' && !error ? <p class="muted">Проверяем стол…</p> : null}
        {entry === null ? <p class="empty">Этой записи в очереди уже нет: стол заняли или вы вышли из очереди.</p> : null}
        {entry ? (
          <section class={`offer${v.state === 'offered' ? '' : ' offer--quiet'}`} aria-labelledby="wo-title">
            <p class="offer__kicker">
              <Icon name={v.state === 'offered' ? 'lamp' : 'hourglass'} />
              {tableName(entry.resource?.number)}
            </p>
            <h1 class="offer__title display" id="wo-title">
              {v.state === 'offered' ? 'Стол ваш на 5 минут' : v.state === 'waiting' ? v.text : v.state === 'accepted' ? 'Стол ваш' : 'Предложение закончилось'}
            </h1>
            {v.state === 'offered' ? (
              <>
                <p class="offer__timer mono" role="timer" aria-label={`Осталось ${Math.ceil(v.left / 60000)} мин`}>
                  {formatDuration(v.left)}
                </p>
                <p class="hint">Не займёте за это время — предложим следующему в очереди.</p>
                <div class="actionbar">
                  <button type="button" class="btn btn--primary btn--block btn--lg" disabled={busy} onClick={take}>
                    {busy ? 'Занимаем…' : 'Занять стол'}
                  </button>
                  <button type="button" class="btn btn--quiet btn--block" disabled={busy} onClick={leave}>
                    Не надо, выйти из очереди
                  </button>
                </div>
              </>
            ) : null}
            {v.state === 'waiting' && v.note ? (
              <p class="note note--lamp" role="status">
                <Icon name="info" />
                <span class="note__title">{v.note}</span>
              </p>
            ) : null}
            {v.state === 'waiting' ? <p class="hint">Когда стол освободится, пришлём уведомление. Стол будет ваш 5 минут.</p> : null}
            {v.state === 'missed' ? (
              <>
                <p class="lead">{v.note}</p>
                <button type="button" class="btn btn--secondary btn--block btn--lg" disabled={busy} onClick={rejoin}>
                  <Icon name="bell" />
                  {busy ? 'Ставим в очередь…' : 'Встать в очередь снова'}
                </button>
              </>
            ) : null}
            {v.state === 'accepted' ? (
              <div class="held">
                <p class="held__title">{entry.hold_until ? `Стол держим до ${formatTime(entry.hold_until, tz)}` : 'Стол держим 3 минуты'}</p>
                <p class="held__body">
                  <Icon name="qr" />
                  <span>
                    Отсканируйте QR-код на столе {entry.resource?.number}, выберите время и оплатите — свет включится сам.
                  </span>
                </p>
              </div>
            ) : null}
          </section>
        ) : null}
      </main>
    </div>
  );
}
