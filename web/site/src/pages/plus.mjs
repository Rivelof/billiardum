import { html, Icon } from '../html.mjs';
import { APP, Crumbs, Empty, RatingTable } from '../components.mjs';
import { DISCIPLINES, LEVELS, seasonLabel, seasonsList } from '../lib.mjs';
import { breadcrumbsLd } from '../seo.mjs';

const SCOPES = { country: 'Россия', city: 'Город', club: 'Клуб' };

/** Рейтинг: фильтры — обычная форма GET, работают без JS. */
export async function ratingPage({ api, cfg, url, now }) {
  const sp = url.searchParams;
  const discipline = sp.get('discipline') in DISCIPLINES ? sp.get('discipline') : 'pyramid';
  const cities = await api.cities();
  const city = cities.find((c) => c.slug === sp.get('city')) ?? null;
  let scope = sp.get('scope') in SCOPES ? sp.get('scope') : 'country';
  if (scope !== 'country' && !city) scope = 'country';
  // Клубы города на программе: рейтинг клуба API ищет по club_id
  const clubs = city ? [...(await api.clubIndex()).entries()].filter(([, k]) => k.city_slug === city.slug).map(([id, k]) => ({ id, ...k })) : [];
  const club = scope === 'club' ? clubs.find((c) => c.slug === sp.get('club')) ?? null : null;
  if (scope === 'club' && !club) scope = 'city';
  const seasons = seasonsList(now);
  const seasonParam = seasons.includes(sp.get('season')) ? sp.get('season') : 'all';
  const q = new URLSearchParams({ discipline, scope, season: seasonParam });
  if (city && scope !== 'country') q.set('city', city.slug);
  if (club) q.set('club', club.id);
  const { rows } = await api.rating(q);
  const tabQ = new URLSearchParams({ scope, season: seasonParam });
  if (city) tabQ.set('city', city.slug);
  if (club) tabQ.set('club', club.slug);
  const where = scope === 'club' && club ? `клуб «${club.name}»` : scope === 'city' && city ? city.name : 'вся Россия';
  const caption = `Рейтинг: ${DISCIPLINES[discipline]}, ${where}, ${seasonLabel(seasonParam).toLowerCase()}`;
  const crumbs = [{ name: 'Главная', path: '/' }, { name: 'Рейтинг', path: '/rejting/' }];
  const tabHref = (d) => {
    const x = new URLSearchParams(tabQ);
    x.set('discipline', d);
    return `/rejting/?${x}`;
  };

  const body = html`<div class="wrap page">
    <${Crumbs} items=${crumbs.map((c) => ({ name: c.name, href: c.path }))} />
    <header class="page__head">
      <h1 class="display page__title">Рейтинг игроков</h1>
      <p class="page__lead">Рейтинг Эло Бильярдум+ по каждой дисциплине. В таблице — ник, уровень и рейтинг: остальное игрок открывает сам.</p>
    </header>
    <nav class="tabs" aria-label="Дисциплина">
      ${Object.entries(DISCIPLINES).map(([k, v]) => html`<a href=${tabHref(k)} aria-current=${discipline === k ? 'page' : undefined}>${v}</a>`)}
    </nav>
    <form class="rfilters" method="get" action="/rejting/" aria-label="Таблица рейтинга">
      <input type="hidden" name="discipline" value=${discipline} />
      <label class="field"><span class="field__label">Таблица</span>
        <select class="field__input" name="scope">${Object.entries(SCOPES).map(([k, v]) => html`<option value=${k} selected=${scope === k}>${v}</option>`)}</select></label>
      <label class="field"><span class="field__label">Город</span>
        <select class="field__input" name="city"><option value="">Выберите город</option>${cities.map((c) => html`<option value=${c.slug} selected=${city?.slug === c.slug}>${c.name}</option>`)}</select></label>
      ${clubs.length ? html`<label class="field"><span class="field__label">Клуб</span>
        <select class="field__input" name="club"><option value="">Любой</option>${clubs.map((c) => html`<option value=${c.slug} selected=${club?.slug === c.slug}>${c.name}</option>`)}</select></label>` : null}
      <label class="field"><span class="field__label">Сезон</span>
        <select class="field__input" name="season">${seasons.map((s) => html`<option value=${s} selected=${seasonParam === s}>${seasonLabel(s)}</option>`)}</select></label>
      <button class="btn btn--primary" type="submit">Показать таблицу</button>
    </form>
    ${scope !== 'country' && !city ? html`<p class="hint">Чтобы открыть таблицу города или клуба, выберите город.</p>` : null}
    <section class="block" aria-labelledby="rt-title">
      <h2 class="rating__title" id="rt-title">${DISCIPLINES[discipline]}: ${where}, ${seasonLabel(seasonParam).toLowerCase()}</h2>
      ${rows.length ? html`<${RatingTable} rows=${rows} caption=${caption} />`
        : html`<${Empty} ill="cue" title="В этой таблице пока никого">
          Рейтинг появляется после первых засчитанных партий: оба игрока за одним оплаченным столом клуба на программе и оба подтвердили счёт в приложении.<//>`}
    </section>
    <p class="small">Сезон — календарный месяц по московскому времени. Общий рейтинг копится за всё время.</p>
  </div>`;

  return {
    path: '/rejting/',
    title: `Рейтинг игроков: ${DISCIPLINES[discipline].toLowerCase()} — Бильярдум`,
    description: 'Рейтинг Эло игроков в русскую пирамиду, пул и снукер: таблицы по клубу, городу и стране, сезоны по месяцам.',
    body,
    islands: [],
    jsonld: [breadcrumbsLd(cfg.origin, crumbs)],
    active: 'rejting',
    cities,
  };
}

const ACHIEVEMENTS = [
  ['Сухая', 'Победа 8:0 в пирамиде.'],
  ['Завсегдатай', '10 игр в одном клубе.'],
  ['Ночная смена', '5 игр, начатых после полуночи.'],
  ['Турнирный', 'Первый турнир.'],
  ['Пять клубов', 'Игры в пяти разных клубах.'],
  // «Камбэк» в M4 не выдаётся (№145) — не рекламируем, пока нет счёта по ходу партии
];

export async function plusPage({ api, cfg }) {
  const cities = await api.cities();
  const crumbs = [{ name: 'Главная', path: '/' }, { name: 'Бильярдум+', path: '/plus/' }];
  const body = html`
  <section class="plus-hero">
    <div class="wrap plus-hero__in">
      <div>
        <${Crumbs} items=${crumbs.map((c) => ({ name: c.name, href: c.path }))} />
        <h1 class="display plus-hero__title">Бильярдум+</h1>
        <p class="plus-hero__lead">Играй. Расти. Находи соперников. Твой рейтинг по пирамиде, пулу и снукеру, соперники твоего уровня и турниры — в одном профиле.</p>
        <div class="plus-hero__cta">
          <a class="btn btn--primary btn--lg" href=${`${APP}plus`}>Открыть профиль</a>
          <a class="btn btn--quiet" href="/rejting/">Смотреть рейтинг</a>
        </div>
      </div>
      <ol class="ladder" aria-label="Уровни игроков">
        ${[...LEVELS].reverse().map((l) => html`<li class="ladder__step"><span class="ladder__name">${l.name}</span><span class="ladder__range mono">${l.to === null ? `${l.from} и выше` : l.from === 0 ? `до ${l.to}` : `${l.from}–${l.to}`}</span></li>`)}
      </ol>
    </div>
  </section>

  <div class="wrap page">
    <section class="block split" aria-labelledby="elo-title">
      <div>
        <h2 class="display" id="elo-title">Как считается рейтинг</h2>
        <p>Рейтинг Эло, отдельный по каждой дисциплине: пирамида (все разновидности вместе), пул и снукер. Все начинают с 1 200.</p>
        <ul class="ticks">
          <li><${Icon} name="check" /><span>Первые 20 партий рейтинг меняется быстрее, потом спокойнее.</span></li>
          <li><${Icon} name="check" /><span>Турнирная партия весит в полтора раза больше обычной.</span></li>
          <li><${Icon} name="check" /><span>Уровни любительские, не спортивные разряды.</span></li>
        </ul>
      </div>
      <div class="rulecard">
        <h3 class="rulecard__h">Партия засчитывается сама, без администратора, если</h3>
        <ol class="rulecard__list">
          <li>вы оба привязаны к одной оплаченной игре за столом клуба на программе;</li>
          <li>оба подтвердили счёт в приложении в течение 30 минут после партии;</li>
          <li>это не больше третьей засчитанной партии вашей пары за день.</li>
        </ol>
        <p class="small">Если счёт не сошёлся, партию разбирает управляющий клуба, решение остаётся в журнале.</p>
      </div>
    </section>

    <section class="block" aria-labelledby="opp-title">
      <h2 class="display" id="opp-title">Соперники и друзья</h2>
      <div class="cols2">
        <div class="feature"><h3>Ищу соперника</h3><p>Выбери дисциплину, время и клубы. Подберём игроков с рейтингом ±150 от твоего. Позови «Сыграем?» — после согласия стол бронируется на двоих.</p></div>
        <div class="feature"><h3>Друзья</h3><p>Добавляй по контактам или после совместной партии. «Друзья в клубе сейчас» видно, только если друг это разрешил.</p></div>
        <div class="feature"><h3>Приватность</h3><p>По умолчанию другие видят только ник, уровень и рейтинг. Остальное открываешь сам.</p></div>
      </div>
    </section>

    <section class="block" aria-labelledby="ach-title">
      <h2 class="display" id="ach-title">Достижения</h2>
      <p class="hint">Только те, что система может проверить по играм, — без самоотметок.</p>
      <ul class="achievements">${ACHIEVEMENTS.map(([n, d]) => html`<li><span class="ach__mark" aria-hidden="true"></span><b>${n}</b><span>${d}</span></li>`)}</ul>
    </section>

    <section class="block cta-band">
      <h2 class="display">Начни с одной партии</h2>
      <p>Отсканируй QR-код на столе в клубе на программе, сыграй и подтвердите счёт вдвоём. Рейтинг посчитается сам.</p>
      <a class="btn btn--lamp" href=${`${APP}plus`}>Открыть профиль в приложении</a>
    </section>
  </div>`;
  return {
    path: '/plus/',
    title: 'Бильярдум+: рейтинг игроков, соперники и достижения',
    description: 'Рейтинг Эло по русской пирамиде, пулу и снукеру без участия персонала, поиск соперника твоего уровня, друзья и достижения.',
    body,
    jsonld: [breadcrumbsLd(cfg.origin, crumbs)],
    active: 'plus',
    cities,
  };
}

