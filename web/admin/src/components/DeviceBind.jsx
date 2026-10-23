import { useEffect, useRef, useState } from 'preact/hooks';
import { formatTime } from '@billiardum/shared/format';
import { Icon } from './Icon.jsx';
import { ErrorNote } from './ErrorNote.jsx';
import { api } from '../lib/api.js';
import { parseClaimCode, parseDeviceId } from '../lib/devices.js';
import { parseBld1 } from '../lib/onboarding.js';
import { cameraErrorText, startScanner } from '../lib/qrscan.js';

/**
 * «Добавить контроллер» (№67, M5.1 №159): QR на корпусе BLD1:{device_id}:{claim_code} — камерой
 * (BarcodeDetector, иначе локальный jsQR отдельным чанком) или вручную: номер и код с наклейки.
 * Затем стол → окно привязки 30 минут; экран ждёт, пока контроллер выйдет на связь (зал по SSE и опросу).
 * Wi-Fi клуба вводится на портале самого контроллера (точка доступа, №60).
 */
export function DeviceBind({ clubId, tables, preset, timeZone, headingLevel = 2 }) {
  const H = `h${headingLevel}`;
  const [mode, setMode] = useState('scan'); // scan | manual
  const [found, setFound] = useState(null); // { qr, device_id, claim_code } из QR
  const [deviceId, setDeviceId] = useState('');
  const [code, setCode] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [opened, setOpened] = useState(null); // { deviceId, resourceId, until }

  const free = tables.find((t) => !t.device?.id);
  useEffect(() => {
    if (preset) setResourceId(preset);
    else if (!resourceId) setResourceId(free?.resource.id ?? tables[0]?.resource.id ?? '');
  }, [preset, tables.length]);

  const manualId = parseDeviceId(deviceId);
  const manualCode = parseClaimCode(code);
  const target = tables.find((t) => t.resource.id === resourceId);
  const ready = Boolean(resourceId) && (mode === 'scan' ? Boolean(found) : Boolean(manualId && manualCode));

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const res = mode === 'scan' ? await api.bindByQr(clubId, found.qr, resourceId) : await api.bindDevice(clubId, { device_id: manualId, resource_id: resourceId, claim_code: manualCode });
      setOpened({ deviceId: mode === 'scan' ? found.device_id : manualId, resourceId, until: res?.bind_until ?? null });
      setFound(null);
      setCode('');
      setDeviceId('');
      setTouched(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const bound = opened ? tables.find((t) => t.resource.id === opened.resourceId) : null;
  const joined = Boolean(bound && bound.device?.id === opened.deviceId && bound.device?.online);

  return (
    <section class="panel bind" id="bind" aria-labelledby="bind-title">
      <H class="section-title" id="bind-title">
        Добавить контроллер
      </H>
      <ol class="howto">
        <li>
          <span>Отсканируйте QR-код на корпусе контроллера или перепишите номер и код с наклейки.</span>
        </li>
        <li>
          <span>Выберите стол — откроется привязка на 30 минут.</span>
        </li>
        <li>
          <span>Включите контроллер и введите Wi-Fi клуба на его странице — он подключится к серверу сам.</span>
        </li>
      </ol>

      {opened ? (
        <div class={`note ${joined ? 'note--free' : 'note--lamp'}`} role="status">
          <Icon name={joined ? 'check' : 'clock'} />
          <p class="note__title">
            {joined
              ? `Контроллер на связи и привязан к столу ${bound.resource.number}.`
              : `Привязка к столу ${bound?.resource.number ?? ''} открыта${opened.until ? ` до ${formatTime(opened.until, timeZone)}` : ''}. Включите контроллер — покажем, когда он выйдет на связь.`}
          </p>
        </div>
      ) : null}

      <div class="viewtog" role="group" aria-label="Как ввести контроллер">
        <button type="button" class="viewtog__btn" aria-pressed={mode === 'scan' ? 'true' : 'false'} onClick={() => setMode('scan')}>
          <Icon name="camera" />
          Сканировать QR
        </button>
        <button type="button" class="viewtog__btn" aria-pressed={mode === 'manual' ? 'true' : 'false'} onClick={() => setMode('manual')}>
          <Icon name="edit" />
          Ввести вручную
        </button>
      </div>

      <form class="form bind__form" onSubmit={submit} noValidate>
        {mode === 'scan' ? (
          found ? (
            <div class="note note--free">
              <Icon name="check" />
              <p class="note__title">QR прочитан: контроллер {found.device_id.slice(0, 8)}…</p>
              <p class="note__body">
                <button type="button" class="btn btn--link" onClick={() => setFound(null)}>
                  Сканировать другой
                </button>
              </p>
            </div>
          ) : (
            <Scanner onFound={setFound} />
          )
        ) : (
          <>
            <div class="field">
              <label class="field__label" for="dev-id">
                Номер контроллера
              </label>
              <input
                id="dev-id"
                class="field__input mono"
                autoComplete="off"
                spellcheck={false}
                placeholder="d1000000-0000-4000-8000-000000000009"
                value={deviceId}
                aria-invalid={touched && !manualId ? 'true' : undefined}
                aria-describedby="dev-id-hint"
                onInput={(e) => {
                  const v = e.currentTarget.value;
                  // Вставили текст QR целиком — разложим сами
                  const p = parseBld1(v);
                  if (p) {
                    setDeviceId(p.device_id);
                    setCode(p.claim_code);
                  } else setDeviceId(v);
                }}
              />
              <p class={touched && !manualId ? 'field__error' : 'field__hint'} id="dev-id-hint">
                {touched && !manualId ? 'Номер — 36 знаков с дефисами, как на наклейке.' : '36 знаков с дефисами под QR-кодом. Можно вставить текст QR целиком.'}
              </p>
            </div>
            <div class="field">
              <label class="field__label" for="dev-code">
                Код привязки
              </label>
              <input
                id="dev-code"
                class="field__input mono"
                autoComplete="off"
                spellcheck={false}
                value={code}
                aria-invalid={touched && !manualCode ? 'true' : undefined}
                aria-describedby="dev-code-hint"
                onInput={(e) => setCode(e.currentTarget.value)}
              />
              <p class={touched && !manualCode ? 'field__error' : 'field__hint'} id="dev-code-hint">
                {touched && !manualCode ? 'Код — от 6 знаков: латинские буквы, цифры и дефис.' : 'Код с наклейки. После привязки он сгорает.'}
              </p>
            </div>
          </>
        )}
        {touched && mode === 'scan' && !found ? <p class="field__error">Сначала отсканируйте QR-код контроллера или введите номер вручную.</p> : null}
        <div class="field">
          <label class="field__label" for="dev-table">
            Стол
          </label>
          <select id="dev-table" class="field__input" value={resourceId} onChange={(e) => setResourceId(e.currentTarget.value)}>
            {tables.map((t) => (
              <option key={t.resource.id} value={t.resource.id}>
                Стол {t.resource.number}
                {t.device?.id ? ' — заменить контроллер' : ''}
              </option>
            ))}
          </select>
        </div>
        <ErrorNote error={error} />
        <button type="submit" class="btn btn--primary" disabled={busy || !tables.length}>
          {busy ? 'Открываем…' : target ? `Привязать к столу ${target.resource.number}` : 'Привязать к столу'}
        </button>
      </form>
    </section>
  );
}

/** Окно камеры: запускается по кнопке (разрешение на камеру — по действию человека), гаснет при уходе с экрана. */
function Scanner({ onFound }) {
  const video = useRef(null);
  const scanner = useRef(null);
  const [state, setState] = useState('idle'); // idle | starting | on | error
  const [camError, setCamError] = useState(null);
  const [wrong, setWrong] = useState(false);

  const stop = () => {
    scanner.current?.stop();
    scanner.current = null;
  };
  useEffect(() => stop, []);

  const start = async () => {
    setState('starting');
    setCamError(null);
    setWrong(false);
    try {
      scanner.current = await startScanner(video.current, (text) => {
        const p = parseBld1(text);
        if (!p) {
          setWrong(true);
          return;
        }
        stop();
        setState('idle');
        onFound(p);
      });
      setState('on');
    } catch (err) {
      setCamError(err?.code ?? 'camera_failed');
      setState('error');
    }
  };

  return (
    <div class="scan">
      <div class={`scan__view${state === 'on' || state === 'starting' ? ' scan__view--on' : ''}`}>
        <video ref={video} class="scan__video" muted playsInline aria-label="Камера: наведите на QR-код на корпусе контроллера" />
        {state === 'on' ? <span class="scan__frame" aria-hidden="true" /> : null}
      </div>
      <p class="small" role="status">
        {state === 'starting' ? 'Включаем камеру…' : state === 'on' ? (wrong ? 'Это не QR контроллера Бильярдума. Наведите на QR на корпусе контроллера.' : 'Наведите камеру на QR-код на корпусе контроллера.') : ''}
      </p>
      {camError ? (
        <p class="note note--error" role="alert">
          <Icon name="alert" />
          <span class="note__title">{cameraErrorText(camError)}</span>
        </p>
      ) : null}
      {state === 'on' || state === 'starting' ? (
        <button
          type="button"
          class="btn btn--quiet"
          onClick={() => {
            stop();
            setState('idle');
          }}
        >
          Выключить камеру
        </button>
      ) : (
        <button type="button" class="btn btn--secondary" onClick={start}>
          <Icon name="camera" />
          Включить камеру
        </button>
      )}
    </div>
  );
}
