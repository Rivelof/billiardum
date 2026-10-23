import { formatDate, plural } from '@billiardum/shared/format';
import { html, Icon, Raw } from '../html.mjs';
import { APP, Crumbs, Empty } from '../components.mjs';
import { getArticle, listArticles } from '../journal.mjs';
import { UUID } from '../lib.mjs';
import { breadcrumbsLd } from '../seo.mjs';

const MSK = 'Europe/Moscow';

export async function businessPage({ api, cfg, url }) {
  const cities = await api.cities();
  const claim = UUID.test(url.searchParams.get('claim') ?? '') ? url.searchParams.get('claim') : null;
  const crumbs = [{ name: 'Главная', path: '/' }, { name: 'Для бизнеса', path: '/dlya-biznesa/' }];
  const body = html`<div class="wrap page">
    <${Crumbs} items=${crumbs.map((c) => ({ name: c.name, href: c.path }))} />
    <header class="page__head">
      <h1 class="display page__title">Для бизнеса</h1>
      <p class="page__lead">Бесплатная карточка клуба в каталоге, сообщество владельцев и всё, что нужно бильярдному бизнесу рядом.</p>
    </header>

    <section class="block split" id="kartochka" aria-labelledby="card-title">
      <div>
        <h2 class="display" id="card-title">Карточка клуба — бесплатно</h2>
        <ul class="ticks">
          <li><${Icon} name="check" /><span>Клуб в каталоге города: адрес, часы, цены, столы.</span></li>
          <li><${Icon} name="check" /><span>Заявки гостей на бронь приходят в мессенджер клуба. Не ответили за 15 минут — заявку подхватит наш оператор.</span></li>
          <li><${Icon} name="check" /><span>Отзывы оставляют только гости, которые у вас играли или бронировали стол.</span></li>
          <li><${Icon} name="check" /><span>Подключите программу — и в карточке появятся свободные столы вживую и онлайн-бронь.</span></li>
        </ul>
        <p class="small">Мы не копируем 2ГИС и другие справочники: каждую карточку добавляет владелец или наша команда с согласия клуба.</p>
      </div>
      <div class="side-card side-card--brass" data-directory data-claim=${claim ?? ''}>
        <h3 class="side-card__h">${claim ? 'Подтвердить клуб' : 'Добавить или подтвердить клуб'}</h3>
        <p class="hint">${claim
          ? 'Войдите в приложение и подтвердите, что вы владелец или управляющий. Оператор проверит права и свяжется с вами.'
          : 'Войдите в приложение по номеру телефона, заполните карточку — оператор проверит её и опубликует. Если ваш клуб уже есть в каталоге, откройте его страницу и нажмите «Подтвердить клуб».'}</p>
        <a class="btn btn--primary" href=${claim ? `${APP}directory/claim/${claim}` : `${APP}directory/add`}>${claim ? 'Подтвердить права на клуб' : 'Добавить клуб'}</a>
      </div>
    </section>

    <section class="block" aria-labelledby="comm-title">
      <h2 class="display" id="comm-title">Сообщество владельцев</h2>
      <p class="prose">Владельцы клубов на программе обсуждают с нами тарифы, турниры и то, что стоит сделать следующим. Пишите через заявку на странице «Для клубов» — добавим вас в общий канал.</p>
      <a class="btn btn--quiet" href="/dlya-klubov/#zayavka">Оставить заявку</a>
    </section>

    <section class="block" aria-labelledby="sup-title">
      <h2 class="display" id="sup-title">Поставщики, мастера, тренеры</h2>
      <${Empty} ill="cue" title="Раздел наполняется">
        Здесь появятся поставщики столов и сукна, мастера по перетяжке и тренеры. Только те, кто сам попросит разместиться, — без выдуманных компаний.<//>
    </section>
  </div>`;
  return {
    path: '/dlya-biznesa/',
    title: 'Для бизнеса: бесплатная карточка бильярдного клуба — Бильярдум',
    description: 'Добавьте бильярдный клуб в каталог бесплатно: заявки гостей в мессенджер клуба, отзывы только от реальных гостей, сообщество владельцев.',
    body,
    islands: [],
    jsonld: [breadcrumbsLd(cfg.origin, crumbs)],
    active: 'dlya-biznesa',
    cities,
  };
}

export async function journalPage({ api, cfg }) {
  const cities = await api.cities();
  const articles = listArticles({ mock: cfg.mock });
  const crumbs = [{ name: 'Главная', path: '/' }, { name: 'Журнал', path: '/zhurnal/' }];
  const body = html`<div class="wrap page">
    <${Crumbs} items=${crumbs.map((c) => ({ name: c.name, href: c.path }))} />
    <header class="page__head">
      <h1 class="display page__title">Журнал</h1>
      <p class="page__lead">Статьи для игроков и владельцев клубов.</p>
    </header>
    ${articles.length ? html`<ul class="articles">${articles.map((a) => html`<li class="article-row">
      <p class="small">${[a.audience, a.date ? formatDate(`${a.date}T12:00:00Z`, MSK) : null].filter(Boolean).join(', ')}</p>
      <h2 class="article-row__title"><a href=${`/zhurnal/${a.slug}/`}>${a.title}</a></h2>
      ${a.description ? html`<p class="hint">${a.description}</p>` : null}
    </li>`)}</ul>` : html`<${Empty} ill="receipt" title="Статей пока нет">
      Здесь будут статьи о том, как играть, где тренироваться и как вести клуб. Первые появятся скоро.<//>`}
  </div>`;
  return {
    path: '/zhurnal/',
    title: 'Журнал — Бильярдум',
    description: 'Статьи для игроков и владельцев бильярдных клубов.',
    body,
    jsonld: [breadcrumbsLd(cfg.origin, crumbs)],
    active: 'zhurnal',
    cities,
    noindex: articles.length === 0,
  };
}

export async function articlePage({ api, cfg, params }) {
  const a = getArticle(params.slug, { mock: cfg.mock });
  if (!a) return null;
  const cities = await api.cities();
  const crumbs = [{ name: 'Главная', path: '/' }, { name: 'Журнал', path: '/zhurnal/' }, { name: a.title, path: `/zhurnal/${a.slug}/` }];
  const body = html`<div class="wrap page">
    <${Crumbs} items=${crumbs.map((c) => ({ name: c.name, href: c.path }))} />
    <article class="article">
      <header class="page__head">
        <p class="small">${[a.audience, a.date ? formatDate(`${a.date}T12:00:00Z`, MSK) : null].filter(Boolean).join(', ')}</p>
        <h1 class="display page__title">${a.title}</h1>
        ${a.description ? html`<p class="page__lead">${a.description}</p>` : null}
      </header>
      <${Raw} as="div" class="prose" html=${a.html} />
    </article>
  </div>`;
  return {
    path: `/zhurnal/${a.slug}/`,
    title: `${a.title} — Журнал Бильярдума`,
    description: a.description || a.title,
    body,
    jsonld: [
      breadcrumbsLd(cfg.origin, crumbs),
      { '@context': 'https://schema.org', '@type': 'Article', headline: a.title, description: a.description, datePublished: a.date ?? undefined, inLanguage: 'ru-RU', publisher: { '@type': 'Organization', name: 'Бильярдум' } },
    ],
    og: { type: 'article' },
    active: 'zhurnal',
    cities,
  };
}

export function notFoundPage() {
  const body = html`<div class="wrap page page--center">
    <${Empty} ill="pocket" title="Такой страницы нет"
      action=${html`<p class="empty__actions"><a class="btn btn--primary" href="/">На главную</a> <a class="btn btn--quiet" href="/turniry/">Турниры</a></p>`}>
      Шар ушёл в лузу: адрес устарел или в нём опечатка. Клубы города можно найти с главной.<//>
    <h1 class="visually-hidden">Страница не найдена</h1>
  </div>`;
  return { status: 404, path: '/404/', title: 'Страница не найдена — Бильярдум', description: 'Такой страницы нет.', body, noindex: true };
}

export function unavailablePage() {
  const body = html`<div class="wrap page page--center">
    <h1 class="visually-hidden">Сервис временно недоступен</h1>
    <${Empty} ill="lamp" title="Не получилось загрузить данные"
      action=${html`<a class="btn btn--primary" href="">Обновить страницу</a>`}>
      Сервер клубов сейчас не отвечает. Игры в клубах при этом идут как обычно. Попробуйте обновить страницу через минуту.<//>
  </div>`;
  return { status: 503, path: '/', title: 'Сервис временно недоступен — Бильярдум', description: 'Сервер клубов не отвечает.', body, noindex: true };
}

/** 429: гость упёрся в лимит сайта (M4-6). retryAfter — секунды из заголовка Retry-After. */
export function rateLimitedPage(retryAfter = 60) {
  const sec = Math.max(1, Math.round(retryAfter));
  const wait = sec >= 60 ? 'минуту' : `${sec} ${plural(sec, ['секунду', 'секунды', 'секунд'])}`;
  const body = html`<div class="wrap page page--center">
    <h1 class="visually-hidden">Слишком много запросов</h1>
    <${Empty} ill="cue" title="Слишком много запросов с вашего адреса"
      action=${html`<a class="btn btn--primary" href="">Обновить страницу</a>`}>
      За последнюю минуту отсюда открыли очень много страниц подряд, и мы притормозили, чтобы сайт работал у всех. Подождите ${wait} и обновите страницу.<//>
  </div>`;
  return { status: 429, path: '/', title: 'Слишком много запросов — Бильярдум', description: 'Слишком много запросов с одного адреса.', body, noindex: true };
}
