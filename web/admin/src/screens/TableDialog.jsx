import { useEffect, useState } from 'preact/hooks';
import { formatDuration, formatMoney, formatTime } from '@billiardum/shared/format';
import { SERVICE_REASONS, reasonLabel } from '@billiardum/shared/reasons';
import { tableState, typeLabel } from '@billiardum/shared/hall';
import { Dialog } from '../components/Dialog.jsx';
import { Icon } from '../components/Icon.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { CashEntry } from '../components/CashEntry.jsx';
import { api, newIdempotencyKey } from '../lib/api.js';
import { parseRubles } from '../lib/cash.js';
import { can } from '../lib/auth.js';
import { minutesWords } from '../lib/words.js';

const SERVICE_MINUTES = [15, 30, 60];
const FREE_MINUTES = [10, 15, 30, 60];

/**
 * Стол на плане: что происходит, контроллер, ручные действия с обязательной причиной (инвариант 8):
 * «Сервисный свет» (ресепшн и выше), «Продлить без оплаты» (управляющий и владелец).
 */
export function TableDialog({ item, role, timeZone, onClose, onChanged }) {
  const [mode, setMode] = useState(null); // null | 'service' | 'free' | 'deposit' | 'release'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setMode(null);
    setError(null);
  }, [item?.resource?.id]);

  if (!item) return <Dialog open={false} onClose={onClose} title="" />;

  const fmt = (iso) => formatTime(iso, timeZone);
  const st = tableState(item, { formatTime: fmt });
  const s = item.session;
  const d = item.device ?? {};
  const number = item.resource.number;
  // №122: предложение из очереди держит стол — ресепшн может снять удержание с причиной
  const offer = item.hold?.source === 'waitlist' && item.hold.kind !== 'pending' ? item.hold : null;

  const stopService = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.serviceStop(item.resource.id);
      onChanged?.();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={`Стол ${number}`} labelledBy="table-title">
      <div class="form">
        <div class="tinfo">
          <p class={`badge badge--${badgeTone(st.tone)}`}>
            <span class="badge__dot" aria-hidden="true" />
            {st.word}
          </p>
          <p class="muted">{typeLabel(item.resource.type, item.resource.title)}</p>
        </div>

        {s ? (
          <dl class="facts">
            <div>
              <dt>Игра</dt>
              <dd>{s.unlimited ? `без лимита, с ${fmt(s.started_at)}` : `с ${fmt(s.started_at)} до ${fmt(s.paid_until)}`}</dd>
            </div>
            {!s.unlimited && s.paid_until ? (
              <div>
                <dt>Осталось</dt>
                <dd class="mono">{formatDuration(Date.parse(s.paid_until) - Date.now())}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}

        {s?.deposit_kopecks ? (
          <p class="note note--lamp">
            <Icon name="cash" />
            <span class="note__title">Депозит наличными {formatMoney(s.deposit_kopecks)}</span>
            <span class="note__body">Игра идёт, пока хватает депозита, и сама не продлевается. При закрытии посчитаем по факту, остаток верните гостю наличными — программа подскажет сумму.</span>
          </p>
        ) : null}

        {offer ? (
          <p class="note note--lamp">
            <Icon name="hourglass" />
            <span class="note__title">Предложен из очереди{offer.until ? ` до ${fmt(offer.until)}` : ''}</span>
            <span class="note__body">Гость из листа ожидания получил уведомление: стол держим за ним, пока не ответит. Гость у стойки этот стол занять не сможет.</span>
          </p>
        ) : null}

        {item.status === 'service' ? (
          <dl class="facts">
            <div>
              <dt>Сервисный свет</dt>
              <dd>
                {item.until ? `до ${fmt(item.until)}` : 'включён'}
                {item.hold?.reason_code ? `, ${reasonLabel(SERVICE_REASONS, item.hold.reason_code).toLowerCase()}` : ''}
              </dd>
            </div>
          </dl>
        ) : null}

        <dl class="facts">
          <div>
            <dt>Контроллер</dt>
            <dd>{d.online === false ? 'нет связи' : 'на связи'}</dd>
          </div>
          {Number.isFinite(d.rssi) ? (
            <div>
              <dt>Сигнал Wi-Fi</dt>
              <dd class="mono">{d.rssi} дБм</dd>
            </div>
          ) : null}
          {d.fw ? (
            <div>
              <dt>Прошивка</dt>
              <dd class="mono">{d.fw}</dd>
            </div>
          ) : null}
          {Array.isArray(d.caps) && !d.caps.includes('current') ? (
            <div>
              <dt>Датчик тока</dt>
              <dd>нет — защита от света в обход выключена</dd>
            </div>
          ) : null}
        </dl>

        <ErrorNote error={error} />

        {mode === 'service' ? (
          <ServiceForm item={item} onCancel={() => setMode(null)} onDone={() => (onChanged?.(), onClose())} />
        ) : mode === 'free' ? (
          <ExtendFreeForm session={s} onCancel={() => setMode(null)} onDone={() => (onChanged?.(), onClose())} />
        ) : mode === 'release' ? (
          <ReleaseForm offerId={offer?.offer_id} number={number} onCancel={() => setMode(null)} onDone={() => (onChanged?.(), onClose())} />
        ) : mode === 'deposit' ? (
          <DepositForm item={item} timeZone={timeZone} onCancel={() => setMode(null)} onDone={() => onChanged?.()} onClose={onClose} />
        ) : (
          <div class="dialog__actions">
            {item.status === 'service' && can.reception(role) ? (
              <button type="button" class="btn btn--primary btn--block btn--lg" disabled={busy} onClick={stopService}>
                {busy ? 'Выключаем…' : 'Выключить сервисный свет'}
              </button>
            ) : null}
            {offer?.offer_id && can.reception(role) ? (
              <button type="button" class="btn btn--secondary btn--block btn--lg" onClick={() => setMode('release')}>
                Снять удержание
              </button>
            ) : null}
            {['free', 'booked'].includes(st.tone) && can.reception(role) ? (
              <button type="button" class="btn btn--primary btn--block btn--lg" onClick={() => setMode('deposit')}>
                <Icon name="cash" />
                Без лимита: депозит наличными
              </button>
            ) : null}
            {['free', 'booked'].includes(st.tone) && can.reception(role) ? (
              <button type="button" class="btn btn--secondary btn--block btn--lg" onClick={() => setMode('service')}>
                <Icon name="wrench" />
                Сервисный свет
              </button>
            ) : null}
            {s && ['play', 'ending', 'grace'].includes(st.tone) && !s.unlimited && can.extendFree(role) ? (
              <button type="button" class="btn btn--secondary btn--block btn--lg" onClick={() => setMode('free')}>
                <Icon name="extend" />
                Продлить без оплаты
              </button>
            ) : null}
            <button type="button" class="btn btn--quiet btn--block" onClick={onClose}>
              Закрыть
            </button>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function badgeTone(tone) {
  if (['play', 'ending'].includes(tone)) return 'play';
  if (tone === 'grace' || tone === 'offline') return 'alert';
  if (tone === 'free') return 'free';
  return 'pending';
}

function ManualWarning() {
  return (
    <p class="note note--lamp manual">
      <Icon name="info" />
      <span class="note__title">Ручное действие: владелец сразу получит уведомление, запись попадёт в журнал.</span>
    </p>
  );
}

function ServiceForm({ item, onCancel, onDone }) {
  const [code, setCode] = useState(SERVICE_REASONS[0].code);
  const [minutes, setMinutes] = useState(15);
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const textOk = text.trim().length >= 3;

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    if (!textOk) return;
    setBusy(true);
    setError(null);
    try {
      await api.serviceStart(item.resource.id, { minutes, reason_code: code, reason_text: text.trim() });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="form" onSubmit={submit} noValidate>
      <fieldset>
        <legend class="field__label">Причина</legend>
        <div class="choice choice--pills">
          {SERVICE_REASONS.map((r) => (
            <label class="choice__item" key={r.code}>
              <input type="radio" name="svc-reason" value={r.code} checked={code === r.code} onChange={() => setCode(r.code)} />
              <span class="choice__box">
                <span class="choice__title">{r.label}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend class="field__label">На сколько</legend>
        <div class="choice choice--pills">
          {SERVICE_MINUTES.map((m) => (
            <label class="choice__item" key={m}>
              <input type="radio" name="svc-min" value={m} checked={minutes === m} onChange={() => setMinutes(m)} />
              <span class="choice__box">
                <span class="choice__title">{minutesWords(m)}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div class="field">
        <label class="field__label" for="svc-text">
          Что делаете — обязательно
        </label>
        <textarea
          id="svc-text"
          class="field__input"
          rows={2}
          maxLength={300}
          placeholder="Например: протираем сукно после пролитого напитка"
          value={text}
          aria-invalid={touched && !textOk ? 'true' : undefined}
          aria-describedby={touched && !textOk ? 'svc-text-err' : undefined}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        {touched && !textOk ? (
          <p class="field__error" id="svc-text-err">
            Опишите причину хотя бы в двух словах: без неё свет не включится.
          </p>
        ) : null}
      </div>
      <ManualWarning />
      <ErrorNote error={error} />
      <div class="dialog__actions">
        <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
          <Icon name="lamp" />
          {busy ? 'Включаем…' : `Включить свет на ${minutesWords(minutes).replace('минута', 'минуту')}`}
        </button>
        <button type="button" class="btn btn--quiet btn--block" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </form>
  );
}

function ExtendFreeForm({ session, onCancel, onDone }) {
  const [minutes, setMinutes] = useState(15);
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const textOk = text.trim().length >= 3;

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    if (!textOk) return;
    setBusy(true);
    setError(null);
    try {
      await api.extendFree(session.id, { minutes, reason_text: text.trim() });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="form" onSubmit={submit} noValidate>
      <fieldset>
        <legend class="field__label">На сколько продлить</legend>
        <div class="choice choice--pills">
          {FREE_MINUTES.map((m) => (
            <label class="choice__item" key={m}>
              <input type="radio" name="free-min" value={m} checked={minutes === m} onChange={() => setMinutes(m)} />
              <span class="choice__box">
                <span class="choice__title">{minutesWords(m)}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div class="field">
        <label class="field__label" for="free-text">
          Причина — обязательно
        </label>
        <textarea
          id="free-text"
          class="field__input"
          rows={2}
          maxLength={300}
          placeholder="Например: свет погас из-за сбоя, компенсируем гостю"
          value={text}
          aria-invalid={touched && !textOk ? 'true' : undefined}
          aria-describedby={touched && !textOk ? 'free-text-err' : undefined}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        {touched && !textOk ? (
          <p class="field__error" id="free-text-err">
            Опишите причину: без неё продление не выполнится.
          </p>
        ) : null}
      </div>
      <ManualWarning />
      <ErrorNote error={error} />
      <div class="dialog__actions">
        <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
          {busy ? 'Продлеваем…' : `Продлить бесплатно на ${minutesWords(minutes).replace('минута', 'минуту')}`}
        </button>
        <button type="button" class="btn btn--quiet btn--block" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </form>
  );
}

/**
 * Депозит наличными для «Без лимита» (№87, №112): сумма депозита и полученные наличные (сдача), нужна открытая смена.
 * Игра идёт до исчерпания депозита по тарифу; при закрытии — расчёт по факту и возврат остатка с чеком возврата.
 */
function DepositForm({ item, timeZone, onCancel, onDone, onClose }) {
  const [amount, setAmount] = useState('2000');
  const [received, setReceived] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const [key] = useState(() => newIdempotencyKey());
  const amountK = parseRubles(amount);
  const receivedK = received ? parseRubles(received) : amountK;
  const okAmount = amountK !== null && amountK >= 10000;
  const okReceived = receivedK !== null && amountK !== null && receivedK >= amountK;

  if (done) {
    return (
      <div class="form" role="status">
        <div class="change change--big">
          <p class="change__label">Сдача</p>
          <p class="change__value display">{formatMoney(done.change_kopecks ?? 0)}</p>
        </div>
        <p class="lead">
          Свет включён. Депозит {formatMoney(amountK)} — игра до <b class="mono">{done.paid_until ? formatTime(done.paid_until, timeZone) : '—'}</b>, если гость не закончит раньше.
        </p>
        <p class="hint">Чек ККТ на депозит пробит. Когда гость закончит, остаток вернётся наличными с чеком возврата — сумму покажет программа.</p>
        <button type="button" class="btn btn--primary btn--block btn--lg" onClick={onClose}>
          Готово
        </button>
      </div>
    );
  }

  return (
    <form
      class="form deposit"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!okAmount || !okReceived) return;
        setBusy(true);
        setError(null);
        try {
          const res = await api.deposit({ resource_id: item.resource.id, amount_kopecks: amountK, received_kopecks: receivedK }, key);
          setDone(res ?? {});
          onDone();
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }}
      noValidate
    >
      <div class="field">
        <label class="field__label" for="dep-amount">
          Депозит, ₽
        </label>
        <input id="dep-amount" class="field__input field__input--money mono" inputMode="decimal" value={amount} aria-invalid={!okAmount ? 'true' : undefined} onInput={(e) => setAmount(e.currentTarget.value.replace(/[^\d,.]/g, ''))} />
        {!okAmount ? <p class="field__error">Депозит не меньше 100 ₽.</p> : <p class="field__hint">Игра идёт, пока хватает депозита по тарифу. Остаток вернём при закрытии.</p>}
      </div>
      {okAmount ? <CashEntry amount={amountK} value={received} onChange={setReceived} id="dep-received" /> : null}
      <ErrorNote error={error} />
      <div class="dialog__actions dialog__actions--row">
        <button type="submit" class="btn btn--primary btn--lg" disabled={busy || !okAmount || !okReceived}>
          {busy ? 'Включаем свет…' : `Принять ${okAmount ? formatMoney(amountK) : ''} и включить свет`}
        </button>
        <button type="button" class="btn btn--quiet btn--lg" onClick={onCancel}>
          Назад
        </button>
      </div>
    </form>
  );
}

/** Снять удержание предложения из очереди (№122): ручное действие с причиной, гостю уходит уведомление. */
function ReleaseForm({ offerId, number, onCancel, onDone }) {
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ok = text.trim().length >= 3;
  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.releaseOffer(offerId, text.trim());
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <form class="form" onSubmit={submit} noValidate>
      <ManualWarning />
      <p class="hint">Стол {number} станет свободным для гостя у стойки. Гость из очереди получит уведомление, что предложение снято.</p>
      <div class="field">
        <label class="field__label" for="rel-reason">
          Причина
        </label>
        <input id="rel-reason" class="field__input" maxLength={300} value={text} aria-invalid={touched && !ok ? 'true' : undefined} onInput={(e) => setText(e.currentTarget.value)} />
        {touched && !ok ? <p class="field__error">Напишите причину — её увидит владелец.</p> : <p class="field__hint">Например: «Гость из очереди не отвечает, за стол просится пара у стойки».</p>}
      </div>
      <ErrorNote error={error} />
      <div class="dialog__actions dialog__actions--row">
        <button type="submit" class="btn btn--danger btn--lg" disabled={busy}>
          {busy ? 'Снимаем…' : 'Снять удержание'}
        </button>
        <button type="button" class="btn btn--quiet btn--lg" onClick={onCancel}>
          Назад
        </button>
      </div>
    </form>
  );
}
