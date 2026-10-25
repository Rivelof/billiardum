import { formatDate, formatMoney, plural } from '@billiardum/shared/format';
import { html, Icon } from '../html.mjs';
import { APP, Badge, Crumbs, HallPlan, PriceGrid, TournamentRow } from '../components.mjs';
import { courtPriceText, courtsWord, hoursText, tablesWord, telHref } from '../lib.mjs';
import { breadcrumbsLd, clubLd } from '../seo.mjs';

/**
 * Клуб без программы: бронь по заявке (T25). Заявку отправляет вошедший гость в приложении
 * (/app/request/{listing_id}: телефон и согласие — там); клуб отвечает, через 15 минут — оператор.
 */
function RequestBlock({ club }) {
  return html`<section class="reqform" id="zayavka" aria-labelledby="req-title">
    <h2 class="display" id="req-title">Бронь по заявке</h2>
    <p>Клуб пока не подключил онлайн-бронь. Оставьте заявку: выберите время и число гостей — заявка уйдёт в клуб, а ответ придёт вам в приложение.</p>
    <ol class="reqsteps">
      <li>Войдите по номеру телефона — так клуб сможет подтвердить бронь.</li>
      <li>Укажите дату, время и сколько вас будет.</li>
      <li>Клуб ответит. Если он не ответит за 15 минут, заявку подхватит оператор Бильярдума.</li>
    </ol>
    <p><a class="btn btn--primary btn--lg" href=${`${APP}request/${club.id}`}>Оставить заявку на бронь</a></p>
    ${club.phone ? html`<p class="hint">Или позвоните в клуб: <a class="mono" href=${telHref(club.phone)}>${club.phone}</a></p>` : null}
  </section>`;
}

function Reviews({ reviews, timezone }) {
  const items = reviews?.items ?? [];
  return html`<section class="block" aria-labelledby="rev-title">
    <div class="block__head">
      <h2 class="display" id="rev-title">Отзывы</h2>
      ${reviews?.count && reviews.avg ? html`<p class="rev__avg"><${Icon} name="star" /> <b>${String(reviews.avg).replace('.', ',')}</b> из 5, ${reviews.count} ${plural(reviews.count, ['отзыв', 'отзыва', 'отзывов'])}</p>` : null}
    </div>
    ${items.length ? html`<ul class="reviews">${items.map((r) => html`<li class="review">
      <p class="review__head"><b>${r.author}</b> <span class="review__rate" role="img" aria-label=${`Оценка ${r.rating} из 5`}>${Array.from({ length: 5 }, (_, i) => html`<${Icon} name="star" class=${i < r.rating ? 'star star--on' : 'star'} />`)}</span>
        <time class="small" datetime=${r.created_at}>${formatDate(r.created_at, timezone)}</time></p>
      <p class="review__text">${r.text}</p>
      ${r.reply ? html`<div class="review__reply"><p class="small"><b>Ответ клуба</b></p><p>${r.reply.text}</p></div>` : null}
    </li>`)}</ul>` : html`<p class="hint">Отзывов пока нет.</p>`}
    <p class="small">Отзыв может оставить только гость, который играл или бронировал стол в этом клубе за последние 90 дней, — в <a href=${APP}>приложении Бильярдума</a>.</p>
  </section>`;
}

/** Ссылка наружу: только https, без передачи адреса страницы. */
const safeUrl = (u) => (typeof u === 'string' && /^https:\/\/[^\s"<>]+$/.test(u) ? u : null);

export async function clubPage({ api, cfg, params, now }) {
  const res = await api.club(params.city, params.club);
  if (!res) return null;
  const { club, hall, prices, tournaments, reviews } = res;
  const cities = await api.cities();
  const city = cities.find((c) => c.slug === res.city.slug) ?? res.city;
  const tz = club.timezone;
  const platform = club.status === 'platform';
  const hours = hoursText(club);
  const crumbs = [{ name: 'Главная', path: '/' }, { name: city.name, path: `/${city.slug}/` }, { name: club.name, path: club.path }];
  const mapHref = club.geo
    ? `https://yandex.ru/maps/?pt=${club.geo.lng},${club.geo.lat}&z=17&l=map`
    : `https://yandex.ru/maps/?text=${encodeURIComponent(`${city.name}, ${club.address}`)}`;
  const upcoming = tournaments.filter((t) => t.status !== 'finished' && t.status !== 'cancelled');
  const links = [
    [safeUrl(club.max_url), 'Написать в MAX'],
    [safeUrl(club.telegram_url), 'Написать в Telegram'],
    [safeUrl(club.url), 'Сайт клуба'],
  ].filter(([u]) => u);
  const canBook = platform && club.online_booking && club.club_id;
  // M5.8: падел-корты клуба — отдельно от столов
  const courts = club.courts_count ?? 0;
  const tablesN = club.tables_count ?? 0;
  const bookWhat = courts && tablesN ? 'стол или корт' : courts ? 'корт' : 'стол';

  const body = html`<div class="wrap page">
    <${Crumbs} items=${crumbs.map((c) => ({ name: c.name, href: c.path }))} />
    <header class="club-head">
      <div class="club-head__text">
        <h1 class="display page__title">${club.name}</h1>
        <p class="club-head__addr"><${Icon} name="pin" /> ${city.name}, ${club.address}</p>
        <p class="club-head__badges">
          ${platform ? html`<${Badge} tone="free">На программе Бильярдума<//>` : html`<${Badge} tone="reserved">Бронь по заявке<//>`}
          ${club.open_24h ? html`<${Badge} tone="play">Круглосуточно<//>` : null}
          ${tablesN || courts ? html`<span class="small">${[tablesN ? `${tablesN} ${tablesWord(tablesN)}` : null, courts ? `${courts} ${courtsWord(courts)} для падела` : null].filter(Boolean).join(', ')}</span>` : null}
        </p>
        ${club.description ? html`<p class="club-head__about">${club.description}</p>` : null}
      </div>
      <div class="club-head__cta">
        ${canBook ? html`<a class="btn btn--primary btn--lg" href=${`${APP}book/${club.club_id}${courts && !tablesN ? '?family=court' : ''}`}>Забронировать ${bookWhat}</a>` : null}
        ${!platform ? html`<a class="btn btn--primary btn--lg" href=${`${APP}request/${club.id}`}>Оставить заявку на бронь</a>` : null}
        ${club.phone ? html`<a class="btn btn--quiet" href=${telHref(club.phone)}><${Icon} name="phone" />Позвонить в клуб</a>` : null}
      </div>
    </header>

    <div class="club-grid">
      <div class="club-grid__main">
        ${platform && hall ? html`<${HallPlan} hall=${hall} club=${club} city=${city.slug} timezone=${tz} now=${now} headingId="hall-title" />`
          : html`<section class="nohall"><h2 class="nohall__title">${platform ? 'План зала скоро появится' : 'План зала появится после подключения'}</h2>
              <p class="hint">Свободные столы вживую видно только в клубах на программе Бильярдума: свет над столом там включает оплата, поэтому мы точно знаем, где идёт игра.</p></section>`}

        ${!platform ? html`<${RequestBlock} club=${club} />` : null}

        <section class="block" aria-labelledby="price-title">
          <h2 class="display" id="price-title">Цены</h2>
          ${prices.length ? html`<${PriceGrid} prices=${prices} /><p class="small">${prices.some((b) => b.rules?.some((r) => r.slot_minutes)) ? 'Столы — цена за час, падел-корт — за слот: корт бронируется и продлевается слотами. ' : 'Цена за час '}по местному времени клуба. Ночь после полуночи считается по тарифу предыдущего дня.</p>`
            : club.price_from_kopecks || courtPriceText(club) ? html`<p>${club.price_from_kopecks ? html`Стол от <b>${formatMoney(club.price_from_kopecks)}</b> в час. ` : null}${courtPriceText(club) ? `Падел-корт ${courtPriceText(club)}. ` : null}Подробные цены — у клуба.</p>`
            : html`<p class="hint">Клуб не указал цены. Уточните по телефону.</p>`}
        </section>

        <section class="block" aria-labelledby="ct-title">
          <h2 class="display" id="ct-title">Турниры клуба</h2>
          ${upcoming.length ? html`<ul class="afisha">${upcoming.map((t) => html`<${TournamentRow} t=${t} showClub=${false} />`)}</ul>`
            : html`<p class="hint">${platform ? 'Ближайших турниров нет. Клуб публикует их здесь, запись — онлайн.' : 'Турниры с онлайн-записью проводят клубы на программе Бильярдума.'}</p>`}
        </section>

        ${platform ? html`<${Reviews} reviews=${reviews} timezone=${tz} />` : null}
      </div>

      <aside class="club-grid__side" aria-label="Контакты и часы">
        <section class="side-card">
          <h2 class="side-card__h">Часы работы</h2>
          ${hours.length ? html`<ul class="side-list">${hours.map((h) => html`<li>${h}</li>`)}</ul>` : html`<p class="hint">Клуб не указал часы.</p>`}
        </section>
        <section class="side-card">
          <h2 class="side-card__h">Адрес</h2>
          <p>${city.name}, ${club.address}</p>
          <p><a href=${mapHref} rel="noopener nofollow" target="_blank">Открыть в Яндекс Картах<span class="visually-hidden"> (в новой вкладке)</span></a></p>
        </section>
        ${platform ? html`<section class="side-card">
          <h2 class="side-card__h">Как играть</h2>
          <p>Отсканируйте QR-код на борту свободного стола${courts ? ' или корта' : ''} и оплатите через СБП или картой — свет включится сам, чек придёт сразу.</p>
        </section>` : null}
        ${club.phone || links.length ? html`<section class="side-card">
          <h2 class="side-card__h">Связаться</h2>
          ${club.phone ? html`<p><a class="mono" href=${telHref(club.phone)}>${club.phone}</a></p>` : null}
          ${links.map(([u, label]) => html`<p><a href=${u} rel="noopener nofollow" target="_blank">${label}<span class="visually-hidden"> (в новой вкладке)</span></a></p>`)}
        </section>` : null}
        ${club.status === 'listed' ? html`<section class="side-card side-card--brass">
          <h2 class="side-card__h">Это ваш клуб?</h2>
          <p class="hint">Подтвердите права — и сможете сами менять цены, часы и отвечать на заявки.</p>
          <a class="btn btn--quiet btn--sm" href=${`/dlya-biznesa/?claim=${club.id}#kartochka`}>Подтвердить клуб</a>
        </section>` : null}
      </aside>
    </div>
  </div>`;

  return {
    path: club.path,
    title: `${club.name}, бильярдный клуб ${city.name_in}${platform && club.free_now !== null ? `: свободно ${club.free_now} ${plural(club.free_now, ['стол', 'стола', 'столов'])}` : ''} — Бильярдум`,
    description: `${club.name}, ${city.name}, ${club.address}. ${platform ? `Свободные столы${courts ? ' и падел-корты' : ''} сейчас, цены по дням и часам, онлайн-бронь и турниры.` : 'Часы работы, цены и бронь по заявке.'}`,
    body,
    islands: [platform && hall ? 'hall' : null].filter(Boolean),
    jsonld: [clubLd(cfg.origin, { club, city, reviews }), breadcrumbsLd(cfg.origin, crumbs)],
    og: { image: `/og/club/${city.slug}/${club.slug}.png` },
    active: 'clubs',
    citySlug: city.slug,
    cities,
    cookie: `bl-city=${city.slug}; Path=/; Max-Age=31536000; SameSite=Lax`,
  };
}
