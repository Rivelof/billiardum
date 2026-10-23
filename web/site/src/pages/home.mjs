import { breakSvg } from '@billiardum/shared/break';
import { plural } from '@billiardum/shared/format';
import { html, Icon, Raw } from '../html.mjs';
import { Abacus, ClubRow, Empty, HallPlan, TournamentRow } from '../components.mjs';
import { DISCIPLINES, HOURS, applyFilters, clubsWord, freeWord, levelOf, liveMatch, parseFilters, tablesWord, tournamentUrl } from '../lib.mjs';
import { organizationLd, websiteLd } from '../seo.mjs';

/** Город главной: из cookie bl-city (последний открытый город), иначе город с наибольшим числом клубов на программе. */
export function pickCity(cities, cookieCity) {
  if (!cities.length) return null;
  const byCookie = cities.find((c) => c.slug === cookieCity);
  if (byCookie) return byCookie;
  return [...cities].sort((a, b) => (b.online_clubs ?? 0) - (a.online_clubs ?? 0) || (b.clubs ?? 0) - (a.clubs ?? 0))[0];
}

function Hero({ city, cities }) {
  const free = city?.free_tables ?? 0;
  const live = city && city.platform_clubs > 0;
  const title = live
    ? `${city.name_in[0].toUpperCase()}${city.name_in.slice(1)} ${freeWord(free)} ${free}\u00a0${tablesWord(free)}`
    : city
      ? html`Бильярдные клубы ${city.name_in}`
      : 'Бильярдные клубы со свободными столами';
  const others = cities.filter((c) => c.slug !== city?.slug);
  return html`<section class="hero" aria-labelledby="hero-title">
    <div class="wrap hero__in">
      <div class="hero__text">
        <h1 class="hero__title display" id="hero-title">${title}</h1>
        <p class="hero__lead">${live
          ? 'Свободный стол можно занять по QR-коду: оплатили — свет над ним загорелся. Или забронируйте заранее.'
          : city
            ? 'Клубы этого города пока без нашей программы: свободные столы не видны, бронь — по заявке.'
            : 'Каталог только наполняется: клубы добавляют их владельцы. Как только в городе появится первый клуб, он будет здесь.'}</p>
        ${others.length ? html`<p class="hero__cities">Другой город: ${others.map((c, i) => html`${i ? ', ' : ''}<a href=${`/${c.slug}/`}>${c.name}</a>`)}</p>` : null}
      </div>
      <div class="hero__table" data-break>
        <${Raw} class="hero__still" html=${breakSvg({ uid: 'hero-brk' })} />
        <canvas class="break" hidden aria-hidden="true"></canvas>
      </div>
    </div>
    ${city ? html`<form class="search wrap" action=${`/${city.slug}/`} method="get" role="search" aria-label="Найти стол">
      <label class="search__f">
        <span class="search__l">Игра</span>
        <select name="d" class="field__input">
          <option value="">Любая</option>
          ${Object.entries(DISCIPLINES).map(([k, v]) => html`<option value=${k}>${v}</option>`)}
        </select>
      </label>
      <fieldset class="search__f">
        <legend class="search__l">Когда</legend>
        <div class="seg">
          <label><input type="radio" name="free" value="1" checked /><span>Сейчас</span></label>
          <label><input type="radio" name="online" value="1" /><span>Заранее</span></label>
        </div>
      </fieldset>
      <label class="search__f">
        <span class="search__l">На сколько</span>
        <select name="h" class="field__input">
          ${HOURS.map((h) => html`<option value=${h} selected=${h === 2}>${h} ${plural(h, ['час', 'часа', 'часов'])}</option>`)}
        </select>
      </label>
      <button class="btn btn--primary search__go" type="submit"><${Icon} name="search" />Найти стол</button>
    </form>` : null}
  </section>`;
}

function PlusCard({ top }) {
  return html`<section class="plusband" aria-labelledby="plus-title">
    <div class="wrap plusband__in">
      <div class="plusband__text">
        <h2 class="display" id="plus-title">Бильярдум+</h2>
        <p class="plusband__lead">Играй. Расти. Находи соперников. Рейтинг Эло по пирамиде, пулу и снукеру считается сам: партия засчитывается, когда вы оба за одним оплаченным столом и оба подтвердили счёт.</p>
        <a class="btn btn--secondary" href="/plus/">Как устроен рейтинг</a>
      </div>
      <figure class="pcard" aria-label=${top ? `Первое место в рейтинге пирамиды: ${top.nick}` : 'Карточка игрока'}>
        <div class="pcard__head">
          <span class="pcard__disc">Русская пирамида</span>
          <span class="pcard__level">${top ? top.level : 'Любитель'}</span>
        </div>
        <p class="pcard__nick">${top ? top.nick : 'Твой ник'}</p>
        <p class="pcard__rating display">${top ? top.rating : '1 200'}</p>
        <dl class="pcard__stats">
          ${top
            ? html`<div><dt>Партий</dt><dd>${top.games}</dd></div><div><dt>Место</dt><dd>1</dd></div><div><dt>Уровень</dt><dd>${top.level}</dd></div>`
            : html`<div><dt>Старт</dt><dd>1 200</dd></div><div><dt>Уровень</dt><dd>${levelOf(1200)}</dd></div>`}
        </dl>
        <figcaption class="small">${top ? 'Лидер общего рейтинга по пирамиде' : 'С этого начинает каждый игрок'}</figcaption>
      </figure>
    </div>
  </section>`;
}

export async function homePage({ api, cfg, cookies, now }) {
  const cities = await api.cities();
  const city = pickCity(cities, cookies['bl-city']);
  let cityData = null;
  let featured = null;
  let live = null;
  if (city) {
    cityData = await api.city(city.slug);
    const platform = (cityData?.clubs ?? []).filter((c) => c.status === 'platform' && c.tables_count);
    const best = platform.sort((a, b) => (b.tables_count ?? 0) - (a.tables_count ?? 0))[0];
    if (best) featured = await api.club(city.slug, best.slug);
  }
  // «Свободно сейчас» по городу — сумма по клубам на программе (у остальных занятость не видна)
  const livePlatform = (cityData?.clubs ?? []).filter((c) => c.status === 'platform' && c.free_now !== null);
  if (city) {
    city.platform_clubs = livePlatform.length;
    city.free_tables = livePlatform.reduce((s, c) => s + c.free_now, 0);
  }
  const all = await api.tournaments({ cityName: city?.name });
  const liveT = all.find((t) => t.status === 'live');
  const tournaments = all.filter((t) => ['registration', 'closed', 'live'].includes(t.status)).slice(0, 4);
  if (liveT) {
    const detail = await api.tournament(liveT.id);
    const lm = liveMatch(detail?.bracket);
    if (lm) live = { t: liveT, ...lm };
  }
  const top = (await api.rating(new URLSearchParams({ discipline: 'pyramid', scope: 'country', season: 'all' }))).rows[0] ?? null;
  const clubs = cityData ? applyFilters(cityData.clubs ?? [], parseFilters('')).slice(0, 5) : [];

  const body = html`
    <${Hero} city=${city} cities=${cities} />

    ${featured?.hall ? html`<div class="wrap block">
      <${HallPlan} hall=${featured.hall} club=${featured.club} city=${city.slug} timezone=${featured.club.timezone} now=${now}
        headingId="hall-title" heading=${`Зал сейчас: ${featured.club.name}`} />
      <p class="block__more"><a href=${featured.club.path}>Цены, часы и бронь в клубе «${featured.club.name}»</a></p>
    </div>` : null}

    ${city ? html`<section class="wrap block" aria-labelledby="clubs-title">
      <div class="block__head">
        <h2 class="display" id="clubs-title">Клубы ${city.name_in}</h2>
        <a class="block__link" href=${`/${city.slug}/`}>Все ${city.clubs} ${clubsWord(city.clubs)} с фильтрами</a>
      </div>
      ${clubs.length ? html`<ul class="clubs">${clubs.map((c) => html`<${ClubRow} club=${c} />`)}</ul>`
        : html`<${Empty} ill="rack" title="Клубов в этом городе пока нет">Владелец клуба может добавить карточку бесплатно.<//>`}
    </section>` : html`<section class="wrap block"><${Empty} ill="rack" title="Каталог наполняется"
        action=${html`<a class="btn btn--primary" href="/dlya-biznesa/">Добавить свой клуб</a>`}>
        Клубы добавляют владельцы или наша команда с согласия клуба. Мы не копируем справочники: каждая карточка подтверждена клубом.<//></section>`}

    <section class="wrap block" aria-labelledby="t-title">
      <div class="block__head">
        <h2 class="display" id="t-title">Ближайшие турниры</h2>
        <a class="block__link" href="/turniry/">Вся афиша</a>
      </div>
      <div class="tgrid">
        ${tournaments.length ? html`<ul class="afisha">${tournaments.map((t) => html`<${TournamentRow} t=${t} />`)}</ul>`
          : html`<${Empty} ill="cue" title="Турниров пока нет">Клубы на программе публикуют турниры здесь: запись онлайн со взносом, сетка и счёт вживую.<//>`}
        ${live ? html`<article class="onair" aria-labelledby="onair-title">
          <p class="onair__tag"><span class="tstatus tstatus--alert">В эфире</span> ${live.round}${live.match.table ? `, стол ${live.match.table}` : ''}</p>
          <h3 class="onair__title" id="onair-title"><a href=${tournamentUrl(live.t.id)}>${live.t.title}</a></h3>
          <${Abacus} match=${live.match} race=${live.t.race_to} />
          <p class="small">Костяшки — выигранные партии. Матч до ${live.t.race_to} ${plural(live.t.race_to, ['победы', 'побед', 'побед'])}${live.t.discipline === 'pyramid' ? ', партия до 8 шаров' : ''}.</p>
        </article>` : null}
      </div>
    </section>

    <${PlusCard} top=${top} />

    <section class="ownerband" aria-labelledby="own-title">
      <div class="wrap ownerband__in">
        <div>
          <h2 class="display" id="own-title">Владеете бильярдным клубом?</h2>
          <p>Свет над столом включается после оплаты, касса работает как в магазине, а вы видите зал с телефона. Карточка в каталоге — бесплатно.</p>
        </div>
        <div class="ownerband__actions">
          <a class="btn btn--lamp" href="/dlya-klubov/">Программа для клуба</a>
          <a class="btn btn--quiet" href="/dlya-biznesa/">Бесплатная карточка</a>
        </div>
      </div>
    </section>

    ${cities.length ? html`<section class="wrap block" id="goroda" aria-labelledby="cities-title">
      <h2 class="display" id="cities-title">Города</h2>
      <ul class="cities">${cities.map((c) => html`<li><a href=${`/${c.slug}/`}><span class="cities__name">${c.name}</span>
        <span class="cities__meta">${c.clubs} ${clubsWord(c.clubs)}${c.online_clubs ? `, на программе ${c.online_clubs}` : ''}</span></a></li>`)}</ul>
    </section>` : null}
  `;

  const free = city?.free_tables;
  return {
    path: '/',
    title: city && city.platform_clubs ? `Бильярд ${city.name_in}: ${free} ${tablesWord(free)} ${freeWord(free)} сейчас — Бильярдум` : 'Бильярдум — бильярдные клубы со свободными столами',
    description: city
      ? `Бильярдные клубы ${city.name_in}: свободные столы сейчас, цены, бронь онлайн, турниры и рейтинг игроков. Русская пирамида, пул, снукер.`
      : 'Бильярдные клубы со свободными столами, бронь, турниры и рейтинг игроков. Русская пирамида, пул, снукер.',
    body,
    islands: ['break', featured?.hall ? 'hall' : null].filter(Boolean),
    jsonld: [organizationLd(cfg.origin), websiteLd(cfg.origin)],
    active: 'home',
    citySlug: city?.slug,
    cities,
    vary: 'Cookie',
  };
}

