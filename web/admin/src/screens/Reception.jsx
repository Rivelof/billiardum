import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { formatMoney, plural } from '@billiardum/shared/format';
import { Shell } from '../components/Shell.jsx';
import { Icon } from '../components/Icon.jsx';
import { HallPlan } from '../components/HallPlan.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { useNow } from '../components/hooks.js';
import { AcceptDialog } from './AcceptDialog.jsx';
import { DeclineDialog } from './DeclineDialog.jsx';
import { TableDialog } from './TableDialog.jsx';
import { api, streamClub } from '../lib/api.js';
import { mergeHall } from '../lib/hall.js';
import { expiresOf, minutesLeft } from '../lib/reception.js';
import { audioState, chime, unlockAudio } from '../lib/sound.js';
import { agoWords, minutesShort, minutesWords } from '../lib/words.js';

const HIGHLIGHT_MS = 15000;

/**
 * Ресепшн (планшет горизонтально, без мыши): очередь заявок «Стол 4 · 2 ч · 1 600 ₽» со звуком,
 * «Принять оплату», «Отклонить» с причиной; зал с «Сервисный свет».
 */
export function Reception({ ctx }) {
  const { club, role, user, timeZone } = ctx;
  const clubId = club.club_id;
  const [requests, setRequests] = useState(null);
  const [hall, setHall] = useState(null);
  const [error, setError] = useState(null);
  const [live, setLive] = useState('open');
  const [fresh, setFresh] = useState(() => new Set());
  const [announce, setAnnounce] = useState('');
  const [accepting, setAccepting] = useState(null);
  const [declining, setDeclining] = useState(null);
  const [table, setTable] = useState(null);
  const [sound, setSound] = useState(audioState() === 'running');
  const seen = useRef(null);
  const now = useNow(0, true);

  const loadRequests = useCallback(async () => {
    try {
      const list = await api.requests(clubId);
      const sorted = (Array.isArray(list) ? list : []).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      if (seen.current) {
        const added = sorted.filter((r) => !seen.current.has(r.id));
        if (added.length) {
          chime();
          setFresh((prev) => new Set([...prev, ...added.map((r) => r.id)]));
          const r = added[added.length - 1];
          setAnnounce(`Новая заявка: стол ${r.resource_number}, ${r.minutes ? minutesWords(r.minutes) : 'без лимита'}, ${formatMoney(r.amount_kopecks)}`);
          setTimeout(() => setFresh((prev) => new Set([...prev].filter((id) => !added.some((a) => a.id === id)))), HIGHLIGHT_MS);
        }
      }
      seen.current = new Set(sorted.map((r) => r.id));
      setRequests(sorted);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [clubId]);

  const loadHall = useCallback(async () => {
    try {
      setHall(await api.hall(clubId));
    } catch (err) {
      setError(err);
    }
  }, [clubId]);

  useEffect(() => {
    loadRequests();
    loadHall();
    const stream = streamClub(clubId, {
      onEvent: (name, data) => {
        if (name === 'reception_request') loadRequests();
        else if (name === 'hall') setHall((h) => (data ? mergeHall(h, data) : h));
        else if (name === 'session') loadHall();
      },
      onOpen: () => {
        loadRequests();
        loadHall();
      },
      onState: setLive,
    });
    const poll = setInterval(() => {
      loadRequests();
      loadHall();
    }, 30000);
    return () => {
      stream.close();
      clearInterval(poll);
    };
  }, [clubId, loadRequests, loadHall]);

  // Звук разрешается первым касанием экрана — дальше заявки звенят сами
  useEffect(() => {
    const unlock = () => unlockAudio().then((ok) => setSound(ok)).catch(() => {});
    document.addEventListener('pointerdown', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });
    return () => {
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
    };
  }, []);

  // Срок заявки — expires_at от сервера (backend-money), иначе 15 минут от создания
  const visible = (requests ?? []).filter((r) => expiresOf(r) > now);

  const tools = (
    <>
      {live !== 'open' ? (
        <span class="bar__live" role="status">
          <Icon name="refresh" />
          Нет связи, переподключаемся
        </span>
      ) : null}
      <button
        type="button"
        class={`btn btn--sm ${sound ? 'btn--quiet' : 'btn--lamp'}`}
        aria-pressed={sound ? 'true' : 'false'}
        onClick={async () => {
          const ok = await unlockAudio().catch(() => false);
          setSound(ok);
          if (ok) chime();
        }}
      >
        <Icon name={sound ? 'sound' : 'mute'} />
        {sound ? 'Звук заявок включён' : 'Включить звук заявок'}
      </button>
    </>
  );

  return (
    <Shell club={club} role={role} user={user} timeZone={timeZone} active="reception" title="Ресепшн" tools={tools} wide>
      <p class="visually-hidden" aria-live="assertive">
        {announce}
      </p>
      <div class="reception">
        <section class="queue" aria-labelledby="queue-title">
          <h2 class="section-title" id="queue-title">
            Заявки на оплату
            {visible.length ? <span class="count">{visible.length}</span> : null}
          </h2>
          <ErrorNote error={error}>
            <button
              type="button"
              class="btn btn--secondary btn--sm"
              onClick={() => {
                loadRequests();
                loadHall();
              }}
            >
              Обновить
            </button>
          </ErrorNote>
          {requests === null ? (
            <p class="muted">Загружаем заявки…</p>
          ) : visible.length ? (
            <ul class="queue__list">
              {visible.map((r) => {
                const left = expiresOf(r) - now;
                const leftMin = minutesLeft(r, Math.max(now, Date.now()));
                return (
                  <li key={r.id} class={`req${fresh.has(r.id) ? ' req--new' : ''}`}>
                    <p class="req__title">
                      <span class="display req__table">Стол {r.resource_number}</span>
                      <span class="req__what">
                        <span class="req__sep" aria-hidden="true">·</span>
                        {minutesShort(r.minutes)}
                        <span class="req__sep" aria-hidden="true">·</span>
                        <span class="mono">{formatMoney(r.amount_kopecks)}</span>
                      </span>
                    </p>
                    <p class="req__meta">
                      {fresh.has(r.id) ? <span class="req__flag">Новая</span> : null}
                      {r.kind === 'extend' ? <span class="req__kind">Продление</span> : null}
                      <span>{agoWords(now - Date.parse(r.created_at))}</span>
                      {r.guest_masked_phone ? <span class="mono">{r.guest_masked_phone}</span> : null}
                      <span class={left < 3 * 60000 ? 'req__soon' : ''}>
                        сгорит через {leftMin} {plural(leftMin, ['минуту', 'минуты', 'минут'])}
                      </span>
                    </p>
                    <div class="req__actions">
                      <button type="button" class="btn btn--primary btn--lg" onClick={() => setAccepting(r)}>
                        Принять оплату
                      </button>
                      <button type="button" class="btn btn--quiet btn--lg" onClick={() => setDeclining(r)}>
                        Отклонить
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div class="empty-queue">
              <Icon name="reception" size={32} />
              <p class="empty-queue__title">Заявок нет</p>
              <p class="hint">Когда гость выберет «Оплачу на ресепшене», заявка появится здесь со звуком. Онлайн-оплаты проходят без вас.</p>
            </div>
          )}
        </section>

        <section class="reception__hall" aria-labelledby="hall-title">
          <h2 class="section-title visually-hidden" id="hall-title">
            Зал
          </h2>
          {hall ? <HallPlan items={hall} timeZone={timeZone} onSelect={setTable} selected={table?.resource?.id} /> : <p class="muted">Загружаем зал…</p>}
          <p class="hint hall-hint">Нажмите на стол, чтобы увидеть игру или включить сервисный свет.</p>
        </section>
      </div>

      <AcceptDialog
        request={accepting}
        hall={hall}
        refreshHall={loadHall}
        onClose={() => setAccepting(null)}
        onDone={() => {
          loadRequests();
          loadHall();
        }}
      />
      <DeclineDialog
        request={declining}
        onClose={() => setDeclining(null)}
        onDone={() => {
          loadRequests();
          loadHall();
        }}
      />
      <TableDialog item={(hall ?? []).find((x) => x.resource.id === table?.resource?.id) ?? table} role={role} timeZone={timeZone} onClose={() => setTable(null)} onChanged={loadHall} />
    </Shell>
  );
}
