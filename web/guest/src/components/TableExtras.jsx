import { useEffect, useState } from 'preact/hooks';
import { formatDuration, formatMoney, formatTime } from '@billiardum/shared/format';
import { waitlistView } from '@billiardum/shared/booking';
import { Icon } from './Icon.jsx';
import { ErrorNote } from './ErrorNote.jsx';
import { useNow } from './hooks.js';
import { Pay } from '../screens/Pay.jsx';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';
import { BASE } from '../lib/env.js';
import { tableName } from '../lib/words.js';
import { setFlow } from '../lib/flow.js';
import { useMeStream } from '../lib/live.js';
export { startableBooking } from '../lib/booking.js';
import { safeRedirectUrl } from '../lib/urls.js';

/**
 * Своя бронь на экране стола по QR (M3, PRODUCT §6): «Ваша бронь на 21:00 — Начать игру» без повторной оплаты.
 * POST /api/bookings/{id}/start { code } → started | payment_required (бронь без полной предоплаты, ранний приход —
 * доплата: переход на ЮKassa или котировка — тогда оплата как обычно).
 */
export function MyBooking({ table, booking: b, code, onReload }) {
  const tz = table.club?.timezone;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [due, setDue] = useState(null); // { amount_kopecks, quote? }
  const now = useNow();
  const at = formatTime(b.starts_at, tz);
  const until = formatTime(b.ends_at, tz);
  const early = Date.parse(b.starts_at) - now > 5 * 60_000;

  const start = async (method) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.startBooking(b.id, code, method);
      if (res?.status === 'started' && res.session_id) {
        navigate(`${BASE}s/${encodeURIComponent(res.session_id)}`, { replace: true });
        return;
      }
      if (res?.status === 'payment_required') {
        const url = safeRedirectUrl(res.confirmation?.url ?? res.confirmation?.confirmation_url);
        if (url) {
          setFlow({ paymentId: res.payment_id, code, number: table.resource?.number, resourceId: table.resource?.id, timeZone: tz, kind: 'start' });
          window.location.assign(url);
          return;
        }
        setDue({ amount_kopecks: res.amount_kopecks, quote: res.quote ?? null });
      }
      setBusy(false);
    } catch (err) {
      setError(err);
      setBusy(false);
      if (['booking_not_active', 'booking_expired', 'table_busy', 'table_pending', 'table_service'].includes(err?.code)) onReload?.();
    }
  };

  return (
    <section class="mybook" aria-labelledby="mybook-title">
      <p class="mybook__kicker">
        <Icon name="calendar" />
        {b.status === 'reserved' ? 'Стол ждёт вас' : 'Ваша бронь'}
      </p>
      <h2 class="mybook__title display" id="mybook-title">
        Ваша бронь на {at}
      </h2>
      <p class="lead">
        {tableName(table.resource?.number)}, {at}–{until}
        {b.paid_kopecks ? ` · оплачено ${formatMoney(b.paid_kopecks)}` : ''}
      </p>
      {table.status === 'busy' ? (
        <p class="note note--lamp" role="status">
          <Icon name="clock" />
          <span class="note__title">Стол ещё занят предыдущей игрой</span>
          <span class="note__body">Время брони за вами: начнёте, как только стол освободится. Удержим его до {formatTime(b.hold_until ?? b.starts_at, tz)}.</span>
        </p>
      ) : null}
      {early && !due ? <p class="hint">Вы пришли раньше брони. Если стол свободен, можно начать сейчас — доплатите за время до {at}.</p> : null}
      {due?.quote ? (
        <Pay
          quote={due.quote}
          what={`${tableName(table.resource?.number)} · доплата по брони`}
          kind="start"
          unlimited={false}
          timeZone={tz}
          onRequote={() => start()}
          onError={() => false}
        />
      ) : null}
      <ErrorNote error={error} />
      {!due?.quote ? (
        <div class="actionbar">
          <button type="button" class="btn btn--primary btn--block btn--lg" disabled={busy || table.status === 'busy'} onClick={() => start()}>
            <Icon name="lamp" />
            {busy ? 'Включаем свет…' : early ? 'Начать игру сейчас' : 'Начать игру по брони'}
          </button>
          {table.status === 'busy' ? (
            <button type="button" class="btn btn--quiet btn--block" onClick={onReload}>
              <Icon name="refresh" />
              Проверить стол снова
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Лист ожидания на занятом столе (M3, №109): «Сообщить, когда освободится», место в очереди, предложение на 5 минут
 * с таймером и «Занять стол». Своё место (GET /api/me/waitlist, опрос раз в 5 секунд) держит экран стола — useMyWaitlist.
 */
export function Waitlist({ table, entry, setEntry, signedIn, onSignIn, onTaken }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const now = useNow(0, entry?.status === 'offered');
  const v = waitlistView(entry, now);
  const tz = table.club?.timezone;
  const resourceId = table.resource?.id;

  const join = async () => {
    if (!signedIn) {
      onSignIn();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setEntry(await api.joinWaitlist(resourceId));
    } catch (err) {
      setError(err);
      if (err?.code === 'table_free') onTaken?.(null);
    } finally {
      setBusy(false);
    }
  };
  const leave = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.leaveWaitlist(entry.id);
      setEntry(null);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const take = async () => {
    setBusy(true);
    setError(null);
    try {
      const w = await api.acceptWaitlist(entry.id);
      setEntry(w);
      onTaken?.(w);
    } catch (err) {
      setError(err);
      if (err?.code === 'offer_expired') setEntry({ ...entry, status: 'expired' });
    } finally {
      setBusy(false);
    }
  };

  if (v.state === 'offered') {
    return (
      <section class="offer" aria-labelledby="offer-title" role="alert">
        <p class="offer__kicker">
          <Icon name="lamp" />
          {tableName(table.resource?.number)} освободился
        </p>
        <h2 class="offer__title display" id="offer-title">
          Стол ваш на 5 минут
        </h2>
        <p class="offer__timer mono" role="timer" aria-label={`Осталось ${Math.ceil(v.left / 60000)} мин`}>
          {formatDuration(v.left)}
        </p>
        <p class="hint">Не займёте за это время — предложим следующему в очереди.</p>
        <ErrorNote error={error} />
        <div class="actionbar">
          <button type="button" class="btn btn--primary btn--block btn--lg" disabled={busy} onClick={take}>
            {busy ? 'Занимаем…' : 'Занять стол'}
          </button>
          <button type="button" class="btn btn--quiet btn--block" disabled={busy} onClick={leave}>
            Не надо, выйти из очереди
          </button>
        </div>
      </section>
    );
  }

  if (v.state === 'waiting') {
    return (
      <section class="queue-me" aria-labelledby="wl-title">
        <h2 class="step__label" id="wl-title">
          <Icon name="hourglass" />
          {v.text}
        </h2>
        <p class="hint">
          Когда стол освободится, пришлём уведомление{table.busy_until ? ` — ориентировочно в ${formatTime(table.busy_until, tz)}` : ''}. Стол будет ваш 5 минут.
        </p>
        <ErrorNote error={error} />
        <button type="button" class="btn btn--quiet btn--block" disabled={busy} onClick={leave}>
          Выйти из очереди
        </button>
      </section>
    );
  }

  if (v.state === 'accepted') return null;

  return (
    <section class="queue-me" aria-labelledby="wl-title">
      <h2 class="step__label" id="wl-title">
        Подождать этот стол?
      </h2>
      <p class="hint">Встаньте в очередь: когда стол освободится, он будет ваш 5 минут.</p>
      {error?.code === 'limit_exceeded' ? (
        <p class="note note--error" role="alert">
          <Icon name="alert" />
          <span class="note__title">Вы уже ждёте три стола</span>
          <span class="note__body">Выйдите из одной очереди, чтобы встать в эту.</span>
        </p>
      ) : (
        <ErrorNote error={error} />
      )}
      <button type="button" class="btn btn--secondary btn--block btn--lg" disabled={busy} onClick={join}>
        <Icon name="bell" />
        {busy ? 'Ставим в очередь…' : 'Сообщить, когда освободится'}
      </button>
    </section>
  );
}

/**
 * Своё место в очереди на этот стол: поток гостя (№120, событие waitlist) — перечитываем GET /api/me/waitlist;
 * без потока (обрыв) — опрос раз в 5 секунд. Принятое предложение — onAccepted: стол удержан, дальше время и оплата.
 */
export function useMyWaitlist(resourceId, enabled, onAccepted) {
  const [entry, setEntry] = useState(null);
  const on = Boolean(enabled && resourceId);
  const load = async () => {
    try {
      const list = await api.myWaitlist();
      const mine = (Array.isArray(list) ? list : []).find((w) => w.resource?.id === resourceId && ['waiting', 'offered', 'accepted'].includes(w.status));
      setEntry(mine ?? null);
      if (mine?.status === 'accepted') onAccepted?.(mine);
    } catch {
      // нет связи — повторим
    }
  };
  const live = useMeStream((name, data) => {
    if (name === 'open' || (name === 'waitlist' && (!data?.resource?.id || data.resource.id === resourceId))) load();
  }, on);
  useEffect(() => {
    if (!on || live) return undefined;
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [resourceId, on, live]);
  return [entry, setEntry];
}
