import { useCallback, useEffect, useState } from 'preact/hooks';
import { typeLabel } from '@billiardum/shared/hall';
import { Shell } from '../components/Shell.jsx';
import { Icon } from '../components/Icon.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { api, streamClub } from '../lib/api.js';
import { can } from '../lib/auth.js';
import { mergeHall } from '../lib/hall.js';
import { capsWords, noCurrentSensor, signalWord } from '../lib/devices.js';
import { DeviceBind } from '../components/DeviceBind.jsx';
import { familyText, resourceName } from '@billiardum/shared/resource';

const IDENTIFY_SECONDS = 30;

/**
 * «Контроллеры» (владелец, управляющий, монтажник): на связи ли, сигнал, прошивка, возможности;
 * «Подсветить стол» (identify) и «Добавить контроллер» — QR с корпуса камерой или номер и код вручную, выбор стола
 * (№67, M5.1 №159).
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
        {hall === null ? <p class="muted loading">Загружаем контроллеры…</p> : null}
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
                    <span class="display">{resourceName(t.resource)}</span>
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
                  <p class="hint">{familyText('К этому столу контроллер ещё не привязан.', t.resource)}</p>
                )}
                {noCurrentSensor(d) ? (
                  <p class="note note--lamp">
                    <Icon name="info" />
                    <span class="note__title">{familyText('Нет датчика тока: защита от света в обход системы на этом столе выключена.', t.resource)}</span>
                  </p>
                ) : null}
                <div class="row">
                  {bound && d.online && can.identify(role) ? (
                    <button type="button" class="btn btn--secondary btn--sm" onClick={() => identify(t.resource.id)} disabled={lit[t.resource.id] > Date.now()}>
                      <Icon name="locate" />
                      {familyText(lit[t.resource.id] > Date.now() ? `Стол мигает ${IDENTIFY_SECONDS} секунд` : 'Подсветить стол', t.resource)}
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
        {can.bind(role) && hall ? <DeviceBind clubId={clubId} tables={tables} preset={preset} timeZone={timeZone} /> : null}
      </div>
    </Shell>
  );
}
