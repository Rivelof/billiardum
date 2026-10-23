import { useEffect, useState } from 'preact/hooks';
import { BRACKET_MATCH, DISCIPLINE_WORD } from '@billiardum/shared/plus';
import { api, streamTournament } from '../lib/api.js';
import { champion, liveMatches } from '../lib/tournaments.js';
import '../styles/m4.css';

/**
 * ТВ-экран сетки (PRODUCT §10, №140): крупно, читается с другого конца зала, без ПДн — только ники и посев.
 * Публичные данные турнира, обновление по SSE tournament:{id} (событие bracket); без SSE — опрос раз в 20 с.
 */
export function TournamentTv({ id }) {
  const [t, setT] = useState(null);
  const [error, setError] = useState(null);
  const [live, setLive] = useState('connecting');
  useEffect(() => {
    let alive = true;
    const load = () =>
      api.publicTournament(id).then(
        (x) => alive && (setT(x), setError(null)),
        (err) => alive && setError(err),
      );
    load();
    const s = streamTournament(id, {
      onEvent: (_n, data) => {
        if (data?.rounds) setT((x) => (x ? { ...x, bracket: { rounds: data.rounds } } : x));
      },
      onOpen: load,
      onState: setLive,
    });
    const poll = setInterval(load, 20000);
    return () => {
      alive = false;
      s.close();
      clearInterval(poll);
    };
  }, [id]);

  if (!t) {
    return (
      <main class="tv" data-theme="dark">
        <p class="tv__wait">{error ? 'Турнир не найден' : 'Загружаем сетку…'}</p>
      </main>
    );
  }
  const now = liveMatches(t.bracket);
  const win = champion(t.bracket);
  return (
    <main class="tv" data-theme="dark" aria-labelledby="tv-title">
      <header class="tv__head">
        <div>
          <p class="tv__brand display">Бильярдум</p>
          <h1 class="tv__title display" id="tv-title">
            {t.title}
          </h1>
          <p class="tv__sub">
            {t.club?.name} · {DISCIPLINE_WORD[t.discipline]} · до {t.race_to} побед
          </p>
        </div>
        <p class={`tv__live${live === 'open' ? ' tv__live--on' : ''}`}>
          <span class="tv__dot" aria-hidden="true" />
          {live === 'open' ? 'Вживую' : 'Обновляем…'}
        </p>
      </header>
      {win ? (
        <p class="tv__champion">
          <span class="tv__champion-kicker">Победитель</span>
          <span class="display">{win.nick}</span>
        </p>
      ) : null}
      {now.length ? (
        <section class="tv__now" aria-label="Сейчас играют">
          {now.map((m) => (
            <div class="tv__nowcard" key={m.id}>
              <span class="tv__table">{m.table_number ? `Стол ${m.table_number}` : m.round}</span>
              <span class="tv__pair">
                {m.a.nick} <span class="tv__score mono">{m.score_a ?? 0}:{m.score_b ?? 0}</span> {m.b.nick}
              </span>
              <span class="tv__state">{BRACKET_MATCH[m.status]}</span>
            </div>
          ))}
        </section>
      ) : null}
      {t.bracket ? (
        <ol class="tv__rounds" style={{ '--rounds': t.bracket.rounds.length }}>
          {t.bracket.rounds.map((r, ri) => (
            <li class="tv__round" key={`${r.title}${ri}`}>
              <h2 class="tv__rtitle">{r.title}</h2>
              <ul class="tv__matches">
                {r.matches.map((m) => (
                  <li class={`tvm tvm--${m.status}`} key={m.id}>
                    {[
                      ['a', m.a, m.score_a],
                      ['b', m.b, m.score_b],
                    ].map(([k, side, score]) => (
                      <p class={`tvm__side${m.winner === k ? ' tvm__side--win' : ''}`} key={k}>
                        <span class="tvm__seed mono">{side?.seed ?? ''}</span>
                        <span class="tvm__nick">{side?.nick ?? '—'}</span>
                        <span class="tvm__score mono">{score ?? ''}</span>
                      </p>
                    ))}
                    {m.status === 'canceled' ? <p class="tvm__meta">{BRACKET_MATCH.canceled}</p> : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      ) : (
        <p class="tv__wait">Сетка появится, когда турнир начнётся. Записалось: {t.entries_count}.</p>
      )}
    </main>
  );
}
