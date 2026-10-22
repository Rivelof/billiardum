import { useCallback, useEffect, useState } from 'preact/hooks';
import { formatMoney, formatTime } from '@billiardum/shared/format';
import { Shell } from '../components/Shell.jsx';
import { HallPlan } from '../components/HallPlan.jsx';
import { useMedia } from '../components/hooks.js';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { AlarmList } from './AlarmList.jsx';
import { TableDialog } from './TableDialog.jsx';
import { mergeHall } from '../lib/hall.js';
import { api, streamClub } from '../lib/api.js';
import { withNextBooking } from '../lib/bookings.js';
import { METHOD_LABEL } from '../lib/words.js';

const METHODS = ['sbp', 'card', 'cash', 'card_terminal'];

/**
 * «Сейчас» для владельца и управляющего (сначала телефон): тревоги сверху, зал, выручка за сегодня по способам оплаты.
 */
export function Now({ ctx }) {
  const { club, role, user, timeZone } = ctx;
  const clubId = club.club_id;
  const [data, setData] = useState(null);
  const [alarms, setAlarms] = useState(null);
  const [error, setError] = useState(null);
  const [table, setTable] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [bookings, setBookings] = useState([]); // M3: брони сегодня — янтарная рамка на плане зала
  const narrow = useMedia('(max-width: 639px)');

  const load = useCallback(async () => {
    try {
      const [n, a] = await Promise.all([api.now(clubId), api.alarms(clubId)]);
      api
        .bookings(clubId)
        .then((r) => setBookings(Array.isArray(r) ? r : (r?.bookings ?? [])))
        .catch(() => {});
      setData(n);
      setAlarms(Array.isArray(a) ? a : Array.isArray(n?.alarms_open) ? n.alarms_open : []);
      setUpdatedAt(Date.now());
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [clubId]);

  const loadAlarms = useCallback(async () => {
    try {
      const a = await api.alarms(clubId);
      setAlarms(Array.isArray(a) ? a : []);
    } catch (err) {
      setError(err);
    }
  }, [clubId]);

  useEffect(() => {
    load();
    const stream = streamClub(clubId, {
      onEvent: (name, d) => {
        if (name === 'alarm') loadAlarms();
        else if (name === 'hall') setData((x) => (x && d ? { ...x, hall: mergeHall(x.hall, d) } : x));
        else load();
      },
      onOpen: load,
    });
    const poll = setInterval(load, 60000);
    return () => {
      stream.close();
      clearInterval(poll);
    };
  }, [clubId, load, loadAlarms]);

  const revenue = data?.revenue_today_kopecks ?? {};
  const total = METHODS.reduce((s, m) => s + (Number.isSafeInteger(revenue[m]) ? revenue[m] : 0), 0);
  const hall = withNextBooking(Array.isArray(data?.hall) ? data.hall : [], bookings);

  return (
    <Shell club={club} role={role} user={user} timeZone={timeZone} active="now" title="Сейчас" alarmsCount={alarms?.length ?? 0}>
      <div class="page now">
        <ErrorNote error={error}>
          <button type="button" class="btn btn--secondary btn--sm" onClick={load}>
            Обновить
          </button>
        </ErrorNote>

        <section class="now__alarms" aria-labelledby="alarms-title">
          <h2 class="section-title" id="alarms-title">
            Тревоги
            {alarms?.length ? <span class="count count--alert">{alarms.length}</span> : null}
          </h2>
          {alarms ? <AlarmList alarms={alarms} timeZone={timeZone} onAck={(id) => setAlarms((l) => l.filter((x) => x.id !== id))} /> : <p class="muted">Загружаем…</p>}
        </section>

        <section class="now__hall" aria-labelledby="now-hall-title">
          <h2 class="section-title" id="now-hall-title">
            Зал
          </h2>
          {data ? <HallPlan items={hall} timeZone={timeZone} onSelect={setTable} perRow={narrow ? 4 : undefined} selected={table?.resource?.id} /> : <p class="muted">Загружаем зал…</p>}
        </section>

        <section class="now__money" aria-labelledby="money-title">
          <h2 class="section-title" id="money-title">
            Выручка за сегодня
          </h2>
          {data ? (
            <div class="money">
              <p class="money__total display">{formatMoney(total)}</p>
              <dl class="receipt money__list">
                {METHODS.map((m) => (
                  <div class="receipt__row" key={m}>
                    <dt>{METHOD_LABEL[m]}</dt>
                    <dd class="receipt__sum">{formatMoney(Number.isSafeInteger(revenue[m]) ? revenue[m] : 0)}</dd>
                  </div>
                ))}
              </dl>
              {updatedAt ? (
                <p class="small">
                  {data.day_started_at ? `С ${formatTime(data.day_started_at, timeZone)} — начала рабочих суток клуба. ` : ''}Обновлено в {formatTime(updatedAt, timeZone)}.
                </p>
              ) : null}
            </div>
          ) : null}
          {data && total === 0 ? <p class="hint">Сегодня оплат ещё не было. Первая появится здесь сразу после оплаты гостя.</p> : null}
        </section>
      </div>
      <TableDialog
        item={hall.find((x) => x.resource.id === table?.resource?.id) ?? table}
        role={role}
        timeZone={timeZone}
        onClose={() => setTable(null)}
        onChanged={load}
      />
    </Shell>
  );
}
