import { formatDate, formatMoney, formatTime, plural } from '@billiardum/shared/format';
import { html, Icon } from '../html.mjs';
import { APP, Abacus, Bracket, Crumbs, Empty, TournamentRow } from '../components.mjs';
import { DISCIPLINES, FORMATS, TOURNAMENT_STATUS, UUID, levelOf, liveMatch, seatsLeft, tournamentUrl } from '../lib.mjs';
import { breadcrumbsLd, tournamentLd } from '../seo.mjs';

const GROUPS = [
  { key: 'now', title: 'Идут сейчас', test: (t) => t.status === 'live' },
  { key: 'soon', title: 'Скоро', test: (t) => t.status === 'registration' || t.status === 'closed' },
  { key: 'past', title: 'Прошедшие', test: (t) => t.status === 'finished' },
];

export async function tournamentsPage({ api, cfg, url }) {
  const cities = await api.cities();
  const city = cities.find((c) => c.slug === url.searchParams.get('city')) ?? null;
  const citySlug = city?.slug ?? null;
  const tournaments = await api.tournaments({ cityName: city?.name });
  const crumbs = [{ name: 'Главная', path: '/' }, { name: 'Турниры', path: '/turniry/' }];
  const body = html`<div class="wrap page">
    <${Crumbs} items=${crumbs.map((c) => ({ name: c.name, href: c.path }))} />
    <header class="page__head">
      <h1 class="display page__title">Турниры</h1>
      <p class="page__lead">Афиша турниров в клубах на программе Бильярдума: запись онлайн со взносом, посев по рейтингу, сетка и счёт вживую. Результаты меняют рейтинг Бильярдум+.</p>
    </header>
    ${cities.length > 1 ? html`<nav class="tabs" aria-label="Город">
      <a href="/turniry/" aria-current=${citySlug ? undefined : 'page'}>Все города</a>
      ${cities.map((c) => html`<a href=${`/turniry/?city=${c.slug}`} aria-current=${citySlug === c.slug ? 'page' : undefined}>${c.name}</a>`)}
    </nav>` : null}
    ${tournaments.length ? GROUPS.map((g) => {
      const list = tournaments.filter(g.test);
      if (!list.length) return null;
      return html`<section class="block" aria-labelledby=${`g-${g.key}`}>
        <h2 class="display" id=${`g-${g.key}`}>${g.title}</h2>
        <ul class="afisha">${list.map((t) => html`<${TournamentRow} t=${t} />`)}</ul>
      </section>`;
    }) : html`<${Empty} ill="cue" title="Турниров пока нет">
      Турниры создают клубы на программе Бильярдума. Как только клуб опубликует турнир, он появится в афише.<//>`}
  </div>`;
  return {
    path: '/turniry/',
    title: 'Турниры по бильярду: афиша и сетки — Бильярдум',
    description: 'Турниры по русской пирамиде, пулу и снукеру в клубах: запись онлайн, взнос, сетка и счёт вживую, рейтинг игроков.',
    body,
    jsonld: [breadcrumbsLd(cfg.origin, crumbs)],
    active: 'turniry',
    cities,
  };
}

export async function tournamentPage({ api, cfg, params }) {
  if (!UUID.test(params.id)) return null;
  const res = await api.tournament(params.id);
  if (!res) return null;
  const { tournament: t, entries, bracket } = res;
  const cities = await api.cities();
  const st = TOURNAMENT_STATUS[t.status] ?? TOURNAMENT_STATUS.registration;
  const left = seatsLeft(t);
  const live = liveMatch(bracket);
  const crumbs = [{ name: 'Главная', path: '/' }, { name: 'Турниры', path: '/turniry/' }, { name: t.title, path: tournamentUrl(t.id) }];
  const body = html`<div class="wrap page">
    <${Crumbs} items=${crumbs.map((c) => ({ name: c.name, href: c.path }))} />
    <header class="t-head">
      <div>
        <p class="t-head__status"><span class=${`tstatus tstatus--${st.tone}`}>${st.word}</span></p>
        <h1 class="display page__title">${t.title}</h1>
        <p class="page__lead">${DISCIPLINES[t.discipline]}, ${(FORMATS[t.format] ?? t.format).toLowerCase()}, матчи до ${t.race_to} ${plural(t.race_to, ['победы', 'побед', 'побед'])}${t.discipline === 'pyramid' ? ', партия до 8 шаров' : ''}.</p>
      </div>
      <dl class="facts">
        <div><dt>Начало</dt><dd>${formatDate(t.starts_at, t.timezone)}, <span class="mono">${formatTime(t.starts_at, t.timezone)}</span></dd></div>
        <div><dt>Клуб</dt><dd>${t.club.path ? html`<a href=${t.club.path}>${t.club.name}</a>` : t.club.name}${[t.club.city_name, t.club.address].filter(Boolean).map((x) => `, ${x}`).join('')}</dd></div>
        <div><dt>Взнос</dt><dd>${t.entry_fee_kopecks ? formatMoney(t.entry_fee_kopecks) : 'Бесплатно'}</dd></div>
        ${t.prize_text ? html`<div><dt>Призы</dt><dd>${t.prize_text}</dd></div>` : null}
        <div><dt>Места</dt><dd>${t.entries} из ${t.seats}${t.status === 'registration' ? `, свободно ${left}` : ''}</dd></div>
        ${t.rating_max ? html`<div><dt>Рейтинг</dt><dd>до ${t.rating_max} по ${t.discipline === 'pyramid' ? 'пирамиде' : t.discipline === 'pool' ? 'пулу' : 'снукеру'}</dd></div>` : null}
      </dl>
    </header>
    ${t.status === 'registration' ? html`<div class="t-cta">
      ${left ? html`<a class="btn btn--primary btn--lg" href=${`${APP}tournaments/${t.id}`}>Записаться и оплатить взнос</a>` : html`<p class="note"><${Icon} name="info" /><span>Мест нет. Следите за афишей — места освобождаются, если кто-то отменит запись.</span></p>`}
      <p class="small">Взнос возвращается целиком, если вы отмените запись до её закрытия${t.registration_closes_at ? ` (${formatDate(t.registration_closes_at, t.timezone)}, ${formatTime(t.registration_closes_at, t.timezone)})` : ''} или клуб отменит турнир. После закрытия записи взнос не возвращается.${t.rating_max ? ` Если ваш рейтинг выше ${t.rating_max}, запись не пройдёт — так турнир остаётся честным для своего уровня.` : ''}</p>
    </div>` : null}

    ${live ? html`<section class="block onair onair--wide" aria-labelledby="live-title">
      <p class="onair__tag"><span class="tstatus tstatus--alert">В эфире</span> ${live.round}${live.match.table ? `, стол ${live.match.table}` : ''}</p>
      <h2 class="onair__title" id="live-title">${live.match.a?.nick ?? '—'} и ${live.match.b?.nick ?? '—'}</h2>
      <${Abacus} match=${live.match} race=${t.race_to} />
    </section>` : null}

    <section class="block" aria-labelledby="br-title">
      <h2 class="display" id="br-title">Сетка</h2>
      ${bracket?.rounds?.length ? html`<${Bracket} bracket=${bracket} />`
        : html`<p class="hint">Сетка появится после закрытия записи: посев — по рейтингу Бильярдум+${t.discipline === 'pyramid' ? ' по пирамиде' : ''}.</p>`}
    </section>

    ${t.rules ? html`<section class="block" aria-labelledby="rules-title"><h2 class="display" id="rules-title">Правила</h2><p class="prose">${t.rules}</p>
      <p class="small">Счёт матча вносят оба игрока в приложении и подтверждают. Если записи расходятся, решает организатор, исправление попадает в журнал клуба.</p></section>` : null}

    ${entries.length ? html`<section class="block" aria-labelledby="en-title">
      <h2 class="display" id="en-title">Участники</h2>
      <ol class="entries">${entries.map((e, i) => html`<li><span class="mono entries__seed">${e.seed ?? i + 1}</span><span>${e.nick}</span><span class="small">${levelOf(e.rating)}, ${e.rating}</span></li>`)}</ol>
    </section>` : null}
  </div>`;
  return {
    path: tournamentUrl(t.id),
    title: `${t.title} — турнир, ${[t.club.name, t.club.city_name].filter(Boolean).join(', ')} — Бильярдум`,
    description: `${DISCIPLINES[t.discipline]}, ${formatDate(t.starts_at, t.timezone)} в ${formatTime(t.starts_at, t.timezone)}, клуб «${t.club.name}». ${st.word}. Взнос ${t.entry_fee_kopecks ? formatMoney(t.entry_fee_kopecks) : 'бесплатно'}.`,
    body,
    jsonld: [tournamentLd(cfg.origin, { ...t }), breadcrumbsLd(cfg.origin, crumbs)],
    og: { image: `/og/turnir/${t.id}.png` },
    active: 'turniry',
    citySlug: t.club.city_slug ?? undefined,
    cities,
  };
}
