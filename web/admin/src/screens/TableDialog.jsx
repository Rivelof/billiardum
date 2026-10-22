import { useEffect, useState } from 'preact/hooks';
import { formatDuration, formatTime } from '@billiardum/shared/format';
import { SERVICE_REASONS, reasonLabel } from '@billiardum/shared/reasons';
import { tableState, typeLabel } from '@billiardum/shared/hall';
import { Dialog } from '../components/Dialog.jsx';
import { Icon } from '../components/Icon.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { api } from '../lib/api.js';
import { can } from '../lib/auth.js';
import { minutesWords } from '../lib/words.js';

const SERVICE_MINUTES = [15, 30, 60];
const FREE_MINUTES = [10, 15, 30, 60];

/**
 * Стол на плане: что происходит, контроллер, ручные действия с обязательной причиной (инвариант 8):
 * «Сервисный свет» (ресепшн и выше), «Продлить без оплаты» (управляющий и владелец).
 */
export function TableDialog({ item, role, timeZone, onClose, onChanged }) {
  const [mode, setMode] = useState(null); // null | 'service' | 'free'
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
        ) : (
          <div class="dialog__actions">
            {item.status === 'service' && can.reception(role) ? (
              <button type="button" class="btn btn--primary btn--block btn--lg" disabled={busy} onClick={stopService}>
                {busy ? 'Выключаем…' : 'Выключить сервисный свет'}
              </button>
            ) : null}
            {st.tone === 'free' && can.reception(role) ? (
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
