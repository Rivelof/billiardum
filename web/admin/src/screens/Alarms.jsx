import { useCallback, useEffect, useState } from 'preact/hooks';
import { Shell } from '../components/Shell.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { AlarmList } from './AlarmList.jsx';
import { api, streamClub } from '../lib/api.js';

/** Тревоги клуба: открытые, сначала критичные, кнопка «Принято». Доставка в MAX и Web Push — отдельно, здесь видны всегда. */
export function Alarms({ ctx }) {
  const { club, role, user, timeZone } = ctx;
  const clubId = club.club_id;
  const [alarms, setAlarms] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const a = await api.alarms(clubId);
      setAlarms(Array.isArray(a) ? a : []);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [clubId]);

  useEffect(() => {
    load();
    const stream = streamClub(clubId, { onEvent: (name) => name === 'alarm' && load(), onOpen: load });
    return () => stream.close();
  }, [clubId, load]);

  return (
    <Shell club={club} role={role} user={user} timeZone={timeZone} active="alarms" title="Тревоги" alarmsCount={alarms?.length ?? 0}>
      <div class="page">
        <p class="hint">Тревоги приходят и в MAX или Web Push. «Принято» отмечает, что вы разбираетесь; запись попадёт в журнал.</p>
        <ErrorNote error={error}>
          <button type="button" class="btn btn--secondary btn--sm" onClick={load}>
            Обновить
          </button>
        </ErrorNote>
        {alarms ? <AlarmList alarms={alarms} timeZone={timeZone} role={role} clubId={clubId} onAck={(id) => setAlarms((l) => l.filter((x) => x.id !== id))} /> : <p class="muted loading">Загружаем…</p>}
      </div>
    </Shell>
  );
}
