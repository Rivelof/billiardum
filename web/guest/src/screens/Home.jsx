import { useEffect, useState } from 'preact/hooks';
import { formatDuration } from '@billiardum/shared/format';
import { resourceArt } from '@billiardum/shared/hall';
import { Stage } from '../components/Stage.jsx';
import { Icon } from '../components/Icon.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { useNow } from '../components/hooks.js';
import { api } from '../lib/api.js';
import { auth } from '../lib/auth.js';
import { SignedInAs } from '../components/SignedInAs.jsx';
import { useStore } from '../lib/store.js';
import { BASE } from '../lib/env.js';
import { linkHandler } from '../lib/router.js';
import { gameView } from '../lib/game.js';
import { tableName } from '../lib/words.js';

const PHASE_WORD = { play: 'осталось', warn: 'меньше 5 минут', grace: 'льгота', unlimited: 'без лимита, идёт', over: 'завершается' };

/** Главная приложения: текущие игры или подсказка «Отсканируйте QR-код на столе». */
export function Home() {
  const { status } = useStore(auth);
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState(null);
  const now = useNow(0, Boolean(sessions?.length));

  useEffect(() => {
    if (status !== 'user') return;
    api
      .currentSessions()
      .then((list) => setSessions(Array.isArray(list) ? list : []))
      .catch(setError);
  }, [status]);

  const active = (sessions ?? []).filter((s) => !['closed', 'cancelled'].includes(s.status));
  // «Разбой при прокрутке» (DESIGN §6) — отдельным чанком; пока грузится, стоит обычный стол
  const [Break, setBreak] = useState(null);
  useEffect(() => {
    if (active.length || Break) return;
    import('../components/BreakTable.jsx')
      .then((m) => setBreak(() => m.BreakTable))
      .catch(() => {});
  }, [active.length]);

  return (
    <div class="screen">
      <Stage
        variant={active.length ? 'table' : 'home'}
        kind={resourceArt(active[0]?.resource)}
        lit={active.length ? 'true' : 'false'}
        tone={active.length ? 'play' : 'idle'}
        label="Бильярдум"
        art={!active.length && Break ? <Break class="stage__art" /> : null}
      >
        <h1 class="stage__title stage__title--md display">{active.length ? (
            'Ваша игра'
          ) : (
            <>
              Отсканируйте <span class="nowrap">QR-код</span> на столе
            </>
          )}</h1>
        {!active.length ? <p class="stage__sub">Выберите время, оплатите — и свет над столом загорится сам.</p> : null}
      </Stage>
      <main class="wrap content">
        <ErrorNote error={error} />
        {active.length ? (
          <ul class="games">
            {active.map((s) => {
              const v = gameView(s, now);
              return (
                <li key={s.id}>
                  <a class="games__item" href={`${BASE}s/${encodeURIComponent(s.id)}`} onClick={linkHandler}>
                    <span class="games__table display">{tableName(s.resource?.number, s.resource)}</span>
                    <span class="games__state">
                      {PHASE_WORD[v.phase] ?? 'идёт игра'} <span class="mono">{formatDuration(v.ms)}</span>
                    </span>
                    <Icon name="forward" />
                  </a>
                </li>
              );
            })}
          </ul>
        ) : (
          <ol class="howto howto--steps" aria-label="Как начать игру">
            <li>
              <span>
                <b>Наведите камеру</b> на QR-код на наклейке у стола.
              </span>
            </li>
            <li>
              <span>
                <b>Выберите время</b>: 1, 2, 3 часа или без лимита.
              </span>
            </li>
            <li>
              <span>
                <b>Оплатите</b> по СБП, картой или на ресепшене — свет загорится сам.
              </span>
            </li>
          </ol>
        )}
        <nav class="homelinks" aria-label="Бронь и профиль">
          <a class="homelinks__item homelinks__item--main" href={`${BASE}book`} onClick={linkHandler}>
            <Icon name="calendar" />
            <span>
              Забронировать стол
              <span class="homelinks__sub">День, время и стол на плане зала</span>
            </span>
            <Icon name="forward" />
          </a>
          <a class="homelinks__item" href={`${BASE}bookings`} onClick={linkHandler}>
            <Icon name="list" />
            <span>Мои брони</span>
            <Icon name="forward" />
          </a>
          <a class="homelinks__item" href={`${BASE}plus`} onClick={linkHandler}>
            <Icon name="trophy" />
            <span>
              Бильярдум+
              <span class="homelinks__sub">Рейтинг, соперники и турниры</span>
            </span>
            <Icon name="forward" />
          </a>
          <a class="homelinks__item" href={`${BASE}me`} onClick={linkHandler}>
            <Icon name="user" />
            <span>Профиль, пакеты часов и уведомления</span>
            <Icon name="forward" />
          </a>
        </nav>
        <footer class="foot">
          <a href={`${BASE}privacy`} onClick={linkHandler}>
            Политика обработки персональных данных
          </a>
          {status === 'user' ? <SignedInAs always /> : null}
        </footer>
      </main>
    </div>
  );
}
