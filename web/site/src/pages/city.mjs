import { formatMoney } from '@billiardum/shared/format';
import { html } from '../html.mjs';
import { ClubRow, Crumbs, Empty } from '../components.mjs';
import { CATALOG_DISCIPLINES, applyFilters, clubsWord, courtsWord, hasFilters, padelOnly, parseFilters, priceCapsFor, sortsFor, tablesWord } from '../lib.mjs';
import { breadcrumbsLd, clubListLd } from '../seo.mjs';

function Chip({ type = 'checkbox', name, value = '1', checked, children }) {
  return html`<label class="chip"><input type=${type} name=${name} value=${value} checked=${checked} /><span>${children}</span></label>`;
}

/** Фильтры каталога — обычная форма GET: работают без JS, остров только отправляет её при изменении. */
function Filters({ city, f, total, shown }) {
  return html`<form class="filters" method="get" action=${`/${city.slug}/`} data-autosubmit aria-label="Фильтры каталога">
    <fieldset class="filters__group">
      <legend>Игра</legend>
      <div class="chips">${Object.entries(CATALOG_DISCIPLINES).map(([k, v]) => html`<${Chip} name="d" value=${k} checked=${f.d.includes(k)}>${v}<//>`)}</div>
    </fieldset>
    <fieldset class="filters__group">
      <legend>Условия</legend>
      <div class="chips">
        <${Chip} name="free" checked=${f.free}>Свободно сейчас<//>
        <${Chip} name="online" checked=${f.online}>Онлайн-бронь<//>
        <${Chip} name="h24" checked=${f.h24}>Круглосуточно<//>
      </div>
    </fieldset>
    <fieldset class="filters__group">
      <legend>${padelOnly(f) ? 'Цена слота корта' : 'Цена часа стола'}</legend>
      <div class="chips">
        <${Chip} type="radio" name="max" value="" checked=${!f.max}>Любая<//>
        ${priceCapsFor(f).map((p) => html`<${Chip} type="radio" name="max" value=${p} checked=${f.max === p}>до ${formatMoney(p * 100)}<//>`)}
      </div>
    </fieldset>
    <div class="filters__row">
      <label class="field filters__sort">
        <span class="field__label">Сортировка</span>
        <select name="sort" class="field__input">
          ${Object.entries(sortsFor(f)).map(([k, v]) => html`<option value=${k} selected=${f.sort === k}>${v}</option>`)}
        </select>
      </label>
      ${f.h ? html`<input type="hidden" name="h" value=${f.h} />` : null}
      <button class="btn btn--primary filters__go" type="submit" data-autosubmit-hide>Показать клубы</button>
    </div>
    ${hasFilters(f) ? html`<p class="filters__reset"><a href=${`/${city.slug}/${f.h ? `?h=${f.h}` : ''}`}>Сбросить фильтры</a> <span class="small">(показано ${shown} из ${total})</span></p>` : null}
  </form>`;
}

export async function cityPage({ api, cfg, params, url }) {
  const res = await api.city(params.city);
  if (!res) return null;
  const { city, clubs } = res;
  const cities = await api.cities();
  const f = parseFilters(url.searchParams);
  const list = applyFilters(clubs, f);
  const platform = clubs.filter((c) => c.status === 'platform');
  const freeTotal = platform.reduce((s, c) => s + (c.free_now ?? 0), 0);
  // M5.8: падел-корты города — отдельно от столов
  const padel = clubs.some((c) => c.disciplines?.includes('padel'));
  const courtsFree = platform.reduce((s, c) => s + (c.courts_free_now ?? 0), 0);
  const courtsTotal = platform.reduce((s, c) => s + (c.courts_count ?? 0), 0);
  const onlyPadel = padelOnly(f);
  const crumbs = [{ name: 'Главная', path: '/' }, { name: city.name, path: `/${city.slug}/` }];

  const body = html`<div class="wrap page">
    <${Crumbs} items=${crumbs.map((c) => ({ name: c.name, href: c.path }))} />
    <header class="page__head">
      <h1 class="display page__title">Бильярдные клубы ${city.name_in}</h1>
      <p class="page__lead">${clubs.length
        ? html`${clubs.length} ${clubsWord(clubs.length)}${platform.length
          ? onlyPadel
            ? html`, ${platform.length} из них на программе Бильярдума: там видно свободные корты, а играть можно по QR-коду. Сейчас свободно <b>${courtsFree} ${courtsWord(courtsFree)}</b> для падела.`
            : html`, ${platform.length} из них на программе Бильярдума: там видно свободные столы, а играть можно по QR-коду. Сейчас свободно <b>${freeTotal} ${tablesWord(freeTotal)}</b>${courtsTotal ? html` и <b>${courtsFree} ${courtsWord(courtsFree)}</b> для падела` : ''}.`
          : '. Клубы на программе Бильярдума здесь пока не работают: бронь — по заявке.'}`
        : 'Клубов в каталоге пока нет.'}</p>
    </header>
    ${clubs.length ? html`<div class="catalog">
      <${Filters} city=${city} f=${f} total=${clubs.length} shown=${list.length} />
      <section class="catalog__list" aria-labelledby="found">
        <h2 class="catalog__count" id="found"><span role="status">${list.length ? `Найдено ${list.length} ${clubsWord(list.length)}` : 'Ничего не нашлось'}</span></h2>
        ${list.length ? html`<ul class="clubs">${list.map((c) => html`<${ClubRow} club=${c} hours=${f.h} courts=${onlyPadel} />`)}</ul>`
          : html`<${Empty} ill="pocket" title="Под эти условия клубов нет"
              action=${html`<a class="btn btn--quiet" href=${`/${city.slug}/`}>Показать все клубы</a>`}>
              ${f.free ? '«Свободно сейчас» видно только у клубов на программе Бильярдума. ' : ''}Попробуйте убрать часть фильтров.<//>`}
      </section>
    </div>` : html`<${Empty} ill="rack" title="Клубов пока нет"
        action=${html`<a class="btn btn--primary" href="/dlya-biznesa/">Добавить клуб бесплатно</a>`}>Карточки добавляют владельцы клубов или наша команда с их согласия.<//>`}
    <aside class="addclub">
      <p><b>Вашего клуба нет в списке?</b> Карточка в каталоге бесплатна: заявки гостей придут в мессенджер клуба.</p>
      <a class="btn btn--quiet btn--sm" href="/dlya-biznesa/#kartochka">Добавить клуб</a>
    </aside>
  </div>`;

  return {
    path: `/${city.slug}/`,
    title: `Бильярдные клубы ${city.name_in}${platform.length ? `: свободно ${onlyPadel ? `${courtsFree} ${courtsWord(courtsFree)}` : `${freeTotal} ${tablesWord(freeTotal)}`} сейчас` : ''} — Бильярдум`,
    description: `${clubs.length} ${clubsWord(clubs.length)} ${city.name_in}: русская пирамида, пул, снукер${padel ? ', падел' : ''}. Свободные столы${padel ? ' и корты' : ''} сейчас, цены, онлайн-бронь и круглосуточные клубы.`,
    body,
    islands: [],
    jsonld: [breadcrumbsLd(cfg.origin, crumbs), clubListLd(cfg.origin, city, list)],
    active: 'clubs',
    citySlug: city.slug,
    cities,
    cookie: `bl-city=${city.slug}; Path=/; Max-Age=31536000; SameSite=Lax`,
  };
}
