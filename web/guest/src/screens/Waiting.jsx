import { isTestClub } from '../lib/testmode.js';
import { TestModeNote } from '../components/TestModeNote.jsx';
import { useEffect, useRef, useState } from 'preact/hooks';
import { formatMoney, formatTime } from '@billiardum/shared/format';
import { DECLINE_REASONS } from '@billiardum/shared/reasons';
import { Stage } from '../components/Stage.jsx';
import { Icon } from '../components/Icon.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { usePoll } from '../components/hooks.js';
import { api } from '../lib/api.js';
import { navigate, linkHandler } from '../lib/router.js';
import { BASE } from '../lib/env.js';
import { getFlow, setFlow, clubTimeZone } from '../lib/flow.js';
import { minutesWords, tableName } from '../lib/words.js';
import { familyText } from '@billiardum/shared/resource';
import { requestResource } from '../lib/reception.js';

const LIGHT_DELAY = 1100; // лампа загорается 0,6 с, затем экран «Игра»

/** Свет загорелся: показываем лампу и переходим к игре. */
function useGoToGame(sessionId, kind) {
  useEffect(() => {
    if (!sessionId) return undefined;
    const delay = kind === 'extend' ? 300 : LIGHT_DELAY;
    const t = setTimeout(() => navigate(`${BASE}s/${encodeURIComponent(sessionId)}`, { replace: true }), delay);
    return () => clearTimeout(t);
  }, [sessionId, kind]);
}

function backToTable(flow) {
  if (flow.kind === 'extend' && flow.sessionId) return { href: `${BASE}s/${encodeURIComponent(flow.sessionId)}`, label: 'Вернуться к игре' };
  if (flow.code) return { href: `${BASE}t/${encodeURIComponent(flow.code)}`, label: 'Выбрать время заново' };
  return { href: BASE, label: 'На главную' };
}

/**
 * Ожидание после страницы ЮKassa (/app/wait/{payment_id}, return_url платежа):
 * «Ждём подтверждения» → «Оплата прошла. Включаем свет…» (до появления сессии) → «Свет включён» → «Игра».
 */
export function WaitPayment({ paymentId }) {
  const flow = getFlow();
  const [payment, setPayment] = useState(null);
  const [error, setError] = useState(null);
  const started = useRef(Date.now());
  const done = useRef(false);

  usePoll(
    async () => {
      if (done.current) return;
      try {
        const p = await api.payment(paymentId);
        setPayment(p);
        setError(null);
        if (p.status === 'canceled') done.current = true;
        if ((p.status === 'succeeded' || p.status === 'waiting_for_capture') && (p.session_id || flow.kind === 'extend')) done.current = true;
      } catch (err) {
        setError(err);
      }
    },
    1500,
    [paymentId],
  );

  const paid = payment && (payment.status === 'succeeded' || payment.status === 'waiting_for_capture');
  const sessionId = paid ? payment.session_id ?? (flow.kind === 'extend' ? flow.sessionId : null) : null;
  useGoToGame(sessionId, flow.kind);
  // M3: return_url ЮKassa у пакета часов и предоплаты брони — тоже /app/wait/{id}; после оплаты — в профиль или к брони
  useEffect(() => {
    if (!paid || flow.paymentId !== paymentId) return;
    if (flow.kind === 'package') navigate(`${BASE}me?paid=package`, { replace: true });
    if (flow.kind === 'booking' && flow.bookingId) navigate(`${BASE}bookings/${encodeURIComponent(flow.bookingId)}`, { replace: true });
  }, [paid, flow.kind]);
  useEffect(() => {
    if (payment?.status === 'canceled' && flow.kind === 'booking' && flow.bookingId) navigate(`${BASE}bookings/${encodeURIComponent(flow.bookingId)}`, { replace: true });
  }, [payment?.status]);

  const back = backToTable(flow);
  const slow = !paid && Date.now() - started.current > 3 * 60 * 1000;
  const extend = flow.kind === 'extend';

  let title;
  let text;
  let lit = 'false';
  if (payment?.status === 'canceled') {
    title = 'Оплата отменена';
    text = 'Деньги не списаны. Выберите время заново или другой способ оплаты.';
  } else if (sessionId) {
    lit = 'true';
    title = extend ? 'Игра продлена' : 'Свет включён';
    text = extend ? 'Возвращаемся к таймеру.' : 'Хорошей игры! Открываем таймер.';
  } else if (paid) {
    title = 'Включаем свет…';
    text = familyText('Оплата прошла. Лампа над столом загорится через секунду.', flow.family);
  } else {
    title = 'Ждём подтверждения оплаты';
    text = 'Обычно это несколько секунд. Если вы закрыли страницу банка, оплата всё равно может прийти — подождите минуту.';
  }

  return (
    <div class="screen">
      <Stage kind={flow.family === 'court' ? 'court' : undefined} lit={lit} tone={lit === 'true' ? 'play' : 'idle'} label={tableName(flow.number, flow.family)}>
        <p class="stage__kicker">{tableName(flow.number, flow.family)}</p>
        <h1 class="stage__title display" aria-live="polite">
          {title}
        </h1>
      </Stage>
      <main class="wrap content">
        {flow.testMode || isTestClub(payment) ? <TestModeNote /> : null}
        <div class="step">
          {paid ? <PocketDrop /> : null}
          <p class="lead" aria-live="polite">
            {text}
          </p>
          {!paid && payment?.status !== 'canceled' ? (
            <p class="waiting" role="status">
              <span class="waiting__dot" aria-hidden="true" />
              Проверяем оплату
            </p>
          ) : null}
          <ErrorNote error={error} />
          {slow ? (
            <div class="note">
              <Icon name="clock" />
              <p class="note__title">Подтверждение не пришло за 3 минуты.</p>
              <p class="note__body">Если деньги списались, свет включится, как только банк подтвердит оплату. Если нет — выберите время заново.</p>
            </div>
          ) : null}
          {payment?.status === 'canceled' || slow ? (
            <a class="btn btn--primary btn--block btn--lg" href={back.href} onClick={linkHandler}>
              {back.label}
            </a>
          ) : null}
        </div>
      </main>
    </div>
  );
}

/**
 * Ожидание «Оплачу на ресепшене» (/app/r/{request_id}). Заявка живёт 15 минут (контракт §5).
 * Статус — GET /api/reception/requests/{id} (запрошен у backend); если маршрута нет — ищем свою сессию.
 */
export function WaitReception({ requestId, search = '' }) {
  const flow = getFlow();
  const tz = clubTimeZone(flow.timeZone);
  const [req, setReq] = useState(null);
  const [error, setError] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const fallback = useRef(false);
  const createdAt = useRef(flow.requestAt ?? Date.now());

  useEffect(() => {
    if (!flow.requestAt) setFlow({ requestAt: createdAt.current });
  }, []);

  usePoll(
    async () => {
      if (sessionId || req?.status === 'declined' || req?.status === 'expired') return;
      try {
        if (!fallback.current) {
          try {
            const r = await api.receptionRequest(requestId);
            setReq(r);
            if (r.status === 'accepted' && r.session_id) setSessionId(r.session_id);
            if (r.status === 'accepted' && !r.session_id && flow.kind === 'extend') setSessionId(flow.sessionId);
            setError(null);
            return;
          } catch (err) {
            if (err?.code !== 'not_found') throw err;
            fallback.current = true;
          }
        }
        const list = await api.currentSessions();
        const mine = (Array.isArray(list) ? list : []).find((s) => s.resource?.id === flow.resourceId);
        if (mine && (flow.kind !== 'extend' || Date.parse(mine.paid_until) > (flow.paidUntilBefore ?? 0))) setSessionId(mine.id);
        setError(null);
      } catch (err) {
        setError(err);
      }
    },
    2000,
    [requestId],
  );

  useGoToGame(sessionId, flow.kind);

  // Вид и номер ресурса: сервер → адрес заявки → эта вкладка (в новой вкладке flow пуст)
  const rr = requestResource({ req, search, flow });
  const expiresAt = req?.expires_at ? Date.parse(req.expires_at) : createdAt.current + 15 * 60 * 1000;
  const amount = req?.amount_kopecks ?? flow.amount;
  const minutes = req?.minutes ?? flow.minutes;
  const back = backToTable(flow);
  const extend = flow.kind === 'extend';
  const what = `${tableName(rr.number, rr.family)}${minutes ? ` · ${minutesWords(minutes)}` : ' · без лимита'}`;

  if (req?.status === 'declined' || req?.status === 'expired') {
    const reason = DECLINE_REASONS.find((r) => r.code === req.reason_code)?.guest;
    return (
      <div class="screen">
        <Stage kind={rr.family === 'court' ? 'court' : undefined} label={tableName(rr.number, rr.family)}>
          <p class="stage__kicker">{what}</p>
          <h1 class="stage__title display">{req.status === 'expired' ? 'Заявка сгорела' : 'Заявку отклонили'}</h1>
        </Stage>
        <main class="wrap content">
          <div class="step">
            <p class="lead">
              {req.status === 'expired'
                ? familyText('Ресепшн не принял оплату за 15 минут, и стол снова свободен. Если всё ещё хотите играть, выберите время заново.', rr.family)
                : `Ресепшн отклонил заявку${reason ? `: ${reason}` : ''}. Деньги не списаны. Можно выбрать время заново или оплатить онлайн.`}
            </p>
            <a class="btn btn--primary btn--block btn--lg" href={back.href} onClick={linkHandler}>
              {back.label}
            </a>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div class="screen">
      <Stage kind={rr.family === 'court' ? 'court' : undefined} lit={sessionId ? 'true' : 'false'} tone={sessionId ? 'play' : 'idle'} label={tableName(rr.number, rr.family)}>
        <p class="stage__kicker">{what}</p>
        <h1 class="stage__title display" aria-live="polite">
          {sessionId ? (extend ? 'Игра продлена' : 'Свет включён') : req?.status === 'accepted' ? 'Включаем свет…' : 'Подойдите на ресепшн'}
        </h1>
      </Stage>
      <main class="wrap content">
        {sessionId ? (
          <p class="lead">{extend ? 'Возвращаемся к таймеру.' : 'Хорошей игры! Открываем таймер.'}</p>
        ) : req?.status === 'accepted' ? (
          <p class="lead" role="status">
            {familyText('Ресепшн принял оплату. Лампа над столом загорится через секунду.', rr.family)}
          </p>
        ) : (
          <div class="step">
            <div class="say">
              <p class="say__label">Скажите администратору</p>
              <p class="say__phrase">
                «{tableName(rr.number, rr.family)}, {minutes ? minutesWords(minutes) : 'без лимита'}»
              </p>
              {amount ? (
                <p class="say__sum">
                  К оплате <b class="mono">{formatMoney(amount)}</b> наличными или картой
                </p>
              ) : null}
            </div>
            <p class="waiting" role="status">
              <span class="waiting__dot" aria-hidden="true" />
              {extend ? 'Таймер продлится, как только ресепшн примет оплату' : 'Свет включится, как только ресепшн примет оплату'}
            </p>
            <p class="hint">
              Заявка действует до <span class="mono">{formatTime(expiresAt, tz)}</span>. {familyText('Стол до этого времени за вами.', rr.family)}
            </p>
            <ErrorNote error={error} />
          </div>
        )}
      </main>
    </div>
  );
}

/** Оплата прошла (DESIGN §6): шар закатывается в лузу, над ней загорается свет. Декоративно — скрыт от диктора. */
function PocketDrop() {
  return (
    <div class="pocket-drop" aria-hidden="true">
      <svg viewBox="0 0 132 66" focusable="false">
        <rect class="pocket-drop__rail" x="0" y="20" width="132" height="46" rx="10" />
        <rect class="pocket-drop__cloth" x="0" y="30" width="132" height="36" />
        <circle class="pocket-drop__glow" cx="108" cy="30" r="26" />
        <circle class="pocket-drop__brass" cx="108" cy="30" r="17" />
        <circle class="pocket-drop__hole" cx="108" cy="30" r="11" />
        <circle class="pocket-drop__ball" cx="108" cy="30" r="9" />
      </svg>
    </div>
  );
}
