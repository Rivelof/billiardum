import { BRACKET_MATCH } from '@billiardum/shared/plus';

/**
 * Турнирная сетка олимпийской системы: раунды колонками, матч — две строки (посев, ник, счёт), победитель — латунью.
 * Свой ник подсвечен. На телефоне сетка прокручивается вбок внутри своей области, страница — нет.
 * @param {{ bracket: { rounds: { title: string, matches: object[] }[] }, myNick?: string | null }} props
 */
export function Bracket({ bracket, myNick }) {
  if (!bracket?.rounds?.length) return null;
  return (
    <div class="bracket" role="region" aria-label="Турнирная сетка" tabIndex={0}>
      <ol class="bracket__rounds">
        {bracket.rounds.map((r, ri) => (
          <li class="bracket__round" key={r.title + ri}>
            <h3 class="bracket__title">{r.title}</h3>
            <ul class="bracket__matches">
              {r.matches.map((m) => (
                <li class={`bm bm--${m.status}`} key={m.id}>
                  <Side side={m.a} score={m.score_a} win={m.winner === 'a'} me={myNick} />
                  <Side side={m.b} score={m.score_b} win={m.winner === 'b'} me={myNick} />
                  <p class="bm__meta">
                    {m.table_number && !['done', 'canceled'].includes(m.status) ? `Стол ${m.table_number} · ` : ''}
                    {BRACKET_MATCH[m.status] ?? ''}
                  </p>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Side({ side, score, win, me }) {
  if (!side) {
    return (
      <p class="bm__side bm__side--empty">
        <span class="bm__seed" />
        <span class="bm__nick">—</span>
        <span class="bm__score" />
      </p>
    );
  }
  return (
    <p class={`bm__side${win ? ' bm__side--win' : ''}${me && side.nick === me ? ' bm__side--me' : ''}`}>
      <span class="bm__seed mono">{side.seed ?? ''}</span>
      <span class="bm__nick">
        {side.nick}
        {win ? <span class="visually-hidden"> — победа</span> : null}
      </span>
      <span class="bm__score mono">{score ?? ''}</span>
    </p>
  );
}
