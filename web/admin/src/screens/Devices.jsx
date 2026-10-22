import { useCallback, useEffect, useState } from 'preact/hooks';
import { formatTime } from '@billiardum/shared/format';
import { typeLabel } from '@billiardum/shared/hall';
import { Shell } from '../components/Shell.jsx';
import { Icon } from '../components/Icon.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { api, streamClub } from '../lib/api.js';
import { can } from '../lib/auth.js';
import { mergeHall } from '../lib/hall.js';
import { capsWords, noCurrentSensor, parseClaimCode, parseDeviceId, signalWord } from '../lib/devices.js';

const IDENTIFY_SECONDS = 30;

/**
 * «Контроллеры» (владелец, управляющий, монтажник): на связи ли, сигнал, прошивка, возможности;
 * «Подсветить стол» (identify) и «Добавить контроллер» — номер и код с наклейки вручную, выбор стола (№67).
 * Камера для QR наклейки — позже.
 */
export function Devices({ ctx }) {
  const { club, role, user, timeZone } = ctx;
  const clubId = club.club_id;
  const [hall, setHall] = useState(null);
  const [error, setError] = useState(null);
  const [lit, setLit] = useState({}); // resourceId → момент конца подсветки
  const [preset, setPreset] = useState('');

  const load = useCallback(async () => {
    try {
      setHall(await api.hall(clubId));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [clubId]);

  useEffect(() => {
    load();
    const stream = streamClub(clubId, { onEvent: (name, d) => name === 'hall' && d && setHall((h) => mergeHall(h, d)), onOpen: load });
    const poll = setInterval(load, 30000);
    return () => {
      stream.close();
      clearInterval(poll);
    };
  }, [clubId, load]);

  const identify = async (resourceId) => {
    try {
      await api.identify(resourceId, IDENTIFY_SECONDS);
      setLit((m) => ({ ...m, [resourceId]: Date.now() + IDENTIFY_SECONDS * 1000 }));
      setTimeout(() => setLit((m) => ({ ...m, [resourceId]: 0 })), IDENTIFY_SECONDS * 1000);
    } catch (err) {
      setError(err);
    }
  };

  const tables = (hall ?? []).slice().sort((a, b) => a.resource.number - b.resource.number);
  const online = tables.filter((t) => t.device?.online).length;

  return (
    <Shell club={club} role={role} user={user} timeZone={timeZone} active="devices" title="Контроллеры">
      <div class="page devices">
        <p class="hint">
          {hall ? `На связи ${online} из ${tables.length}. ` : ''}Контроллер на каждом столе включает свет только по команде сервера. «Подсветить стол» мигает
          индикатором, чтобы найти стол в зале.
        </p>
        <ErrorNote error={error}>
          <button type="button" class="btn btn--secondary btn--sm" onClick={load}>
            Обновить
          </button>
        </ErrorNote>
        {hall === null ? <p class="muted">Загружаем контроллеры…</p> : null}
        <ul class="devlist">
          {tables.map((t) => {
            const d = t.device ?? {};
            const bound = Boolean(d.id);
            const word = signalWord(d.rssi);
            const caps = capsWords(d.caps);
            return (
              <li key={t.resource.id} class={`dev${!d.online ? ' dev--off' : ''}`}>
                <div class="dev__head">
                  <p class="dev__table">
                    <span class="display">Стол {t.resource.number}</span>
                    <span class="muted"> {typeLabel(t.resource.type, t.resource.title)}</span>
                  </p>
                  <p class={`badge ${d.online ? 'badge--free' : 'badge--alert'}`}>
                    <span class="badge__dot" aria-hidden="true" />
                    {!bound ? 'Не привязан' : d.online ? 'На связи' : 'Нет связи'}
                  </p>
                </div>
                {bound ? (
                  <dl class="facts facts--compact">
                    <div>
                      <dt>Сигнал Wi-Fi</dt>
                      <dd>{Number.isFinite(d.rssi) ? <><span class="mono">{d.rssi} дБм</span>, {word}</> : 'нет данных'}</dd>
                    </div>
                    <div>
                      <dt>Прошивка</dt>
                      <dd class="mono">{d.fw ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>Умеет</dt>
                      <dd>{caps.length ? caps.join(', ') : 'нет данных'}</dd>
                    </div>
                    <div>
                      <dt>Номер</dt>
                      <dd class="mono dev__id">{d.id}</dd>
                    </div>
                  </dl>
                ) : (
                  <p class="hint">К этому столу контроллер ещё не привязан.</p>
                )}
                {noCurrentSensor(d) ? (
                  <p class="note note--lamp">
                    <Icon name="info" />
                    <span class="note__title">Нет датчика тока: защита от света в обход системы на этом столе выключена.</span>
                  </p>
                ) : null}
                <div class="row">
                  {bound && d.online && can.identify(role) ? (
                    <button type="button" class="btn btn--secondary btn--sm" onClick={() => identify(t.resource.id)} disabled={lit[t.resource.id] > Date.now()}>
                      <Icon name="locate" />
                      {lit[t.resource.id] > Date.now() ? `Стол мигает ${IDENTIFY_SECONDS} секунд` : 'Подсветить стол'}
                    </button>
                  ) : null}
                  {can.bind(role) ? (
                    <a
                      class="btn btn--quiet btn--sm"
                      href="#bind"
                      onClick={() => setPreset(t.resource.id)}
                    >
                      {bound ? 'Заменить контроллер' : 'Привязать контроллер'}
                    </a>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        {can.bind(role) && hall ? <BindForm clubId={clubId} tables={tables} preset={preset} hall={hall} timeZone={timeZone} /> : null}
      </div>
    </Shell>
  );
}

function BindForm({ clubId, tables, preset, hall, timeZone }) {
  const [deviceId, setDeviceId] = useState('');
  const [code, setCode] = useState('');
  const [resourceId, setResourceId] = useState(preset || tables[0]?.resource.id || '');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [opened, setOpened] = useState(null); // { deviceId, resourceId, until }

  useEffect(() => {
    if (preset) setResourceId(preset);
  }, [preset]);

  const id = parseDeviceId(deviceId);
  const claim = parseClaimCode(code);

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    if (!id || !claim || !resourceId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.bindDevice(clubId, { device_id: id, resource_id: resourceId, claim_code: claim });
      setOpened({ deviceId: id, resourceId, until: res.bind_until });
      setCode('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const target = opened ? hall.find((h) => h.resource.id === opened.resourceId) : null;
  const joined = Boolean(target && target.device?.id === opened.deviceId && target.device?.online);

  return (
    <section class="panel bind" id="bind" aria-labelledby="bind-title">
      <h2 class="section-title" id="bind-title">
        Добавить контроллер
      </h2>
      <ol class="howto">
        <li>
          <span>Перепишите номер и код с наклейки на корпусе контроллера.</span>
        </li>
        <li>
          <span>Выберите стол и откройте привязку: у контроллера будет 30 минут.</span>
        </li>
        <li>
          <span>Включите контроллер в зале — он подключится к серверу сам.</span>
        </li>
      </ol>
      {opened ? (
        <div class={`note ${joined ? 'note--free' : 'note--lamp'}`} role="status">
          <Icon name={joined ? 'check' : 'clock'} />
          <p class="note__title">
            {joined
              ? `Контроллер на связи и привязан к столу ${target.resource.number}.`
              : `Привязка открыта до ${formatTime(opened.until, timeZone)}. Включите контроллер — покажем, когда он выйдет на связь.`}
          </p>
        </div>
      ) : null}
      <form class="form bind__form" onSubmit={submit} noValidate>
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
            aria-invalid={touched && !id ? 'true' : undefined}
            aria-describedby="dev-id-hint"
            onInput={(e) => setDeviceId(e.currentTarget.value)}
          />
          <p class={touched && !id ? 'field__error' : 'field__hint'} id="dev-id-hint">
            {touched && !id ? 'Номер — 36 знаков с дефисами, как на наклейке.' : '36 знаков с дефисами, напечатан под QR-кодом.'}
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
            aria-invalid={touched && !claim ? 'true' : undefined}
            aria-describedby="dev-code-hint"
            onInput={(e) => setCode(e.currentTarget.value)}
          />
          <p class={touched && !claim ? 'field__error' : 'field__hint'} id="dev-code-hint">
            {touched && !claim ? 'Код — от 6 знаков: латинские буквы, цифры и дефис.' : 'Код с наклейки. После привязки он сгорает.'}
          </p>
        </div>
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
        <button type="submit" class="btn btn--primary" disabled={busy}>
          {busy ? 'Открываем…' : 'Открыть привязку на 30 минут'}
        </button>
      </form>
    </section>
  );
}
