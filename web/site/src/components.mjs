/**
 * Общие части страниц сайта: шапка, подвал, нижняя панель, план зала, строка зала, строка клуба, афиша,
 * счёты, сетка турнира, таблица рейтинга, сетка цен, пустые состояния. Всё рендерится на сервере.
 */
import { formatDate, formatMoney, formatTime, plural } from '@billiardum/shared/format';
import { resourceArt, tableKind, tableSvg } from '@billiardum/shared/hall';
import { familyOf, resourceName, slotLabel } from '@billiardum/shared/resource';
import { illustration } from '@billiardum/shared/illustrations';
import { html, Icon, Raw } from './html.mjs';
import {
  DISCIPLINES, FORMATS, courtPriceText, courtsWord, disciplinesText, TOURNAMENT_STATUS, freeWord, hallKey, hallLabel, hoursText, priceForHours,
  priceGrid, publicTableState, seatsLeft, tablesWord, tournamentUrl,
} from './lib.mjs';

export const APP = '/app/';

// ---------- каркас ----------

const NAV = [
  { key: 'clubs', label: 'Клубы', icon: 'hall' },
  { key: 'turniry', href: '/turniry/', label: 'Турниры', icon: 'trophy' },
  { key: 'rejting', href: '/rejting/', label: 'Рейтинг', icon: 'list' },
  { key: 'plus', href: '/plus/', label: 'Бильярдум+', icon: 'user' },
  { key: 'dlya-klubov', href: '/dlya-klubov/', label: 'Для клубов', icon: 'reception' },
];

export function Logo() {
  return html`<a class="logo" href="/" aria-label="Бильярдум, на главную">
    <svg class="logo__mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <circle class="logo__lamp" cx="16" cy="16" r="15" />
      <circle class="logo__ball" cx="16" cy="16" r="9" />
      <circle class="logo__spot" cx="16" cy="16" r="3.2" />
    </svg>
    <span class="logo__word">Бильярдум</span>
  </a>`;
}

export function Header({ active, citySlug }) {
  const clubsHref = citySlug ? `/${citySlug}/` : '/#goroda';
  return html`<header class="top">
    <div class="top__in wrap">
      <${Logo} />
      <nav class="top__nav" aria-label="Разделы сайта">
        <ul>
          ${NAV.map((n) => html`<li><a href=${n.href ?? clubsHref} aria-current=${active === n.key ? 'page' : undefined}>${n.label}</a></li>`)}
        </ul>
      </nav>
      <div class="top__tools">
        <button type="button" class="icon-btn theme-btn" data-theme-toggle hidden aria-label="Светлая тема">
          <${Icon} name="sun" class="theme-btn__sun" /><${Icon} name="moon" class="theme-btn__moon" />
        </button>
        <a class="btn btn--sm btn--secondary top__app" href=${APP}>Открыть приложение</a>
      </div>
    </div>
  </header>`;
}

/** Нижняя панель на телефоне (DESIGN §5): Клубы, Турниры, Бильярдум+, Профиль. */
export function BottomNav({ active, citySlug }) {
  const items = [
    { key: 'clubs', href: citySlug ? `/${citySlug}/` : '/#goroda', label: 'Клубы', icon: 'hall' },
    { key: 'turniry', href: '/turniry/', label: 'Турниры', icon: 'trophy' },
    { key: 'plus', href: '/plus/', label: 'Бильярдум+', icon: 'star' },
    { key: 'me', href: `${APP}me`, label: 'Профиль', icon: 'user' },
  ];
  return html`<nav class="bnav" aria-label="Быстрые разделы">
    ${items.map((i) => html`<a href=${i.href} aria-current=${active === i.key ? 'page' : undefined}><${Icon} name=${i.icon} /><span>${i.label}</span></a>`)}
  </nav>`;
}

export function Footer({ cities = [] }) {
  return html`<footer class="foot">
    <div class="wrap foot__in">
      <div class="foot__brand">
        <${Logo} />
        <p class="hint">Бильярдные клубы со свободными столами, турниры и рейтинг игроков. Свет над столом горит, пока идёт оплаченная игра.</p>
      </div>
      ${cities.length ? html`<nav class="foot__col" aria-label="Города">
        <h2 class="foot__h">Города</h2>
        <ul>${cities.map((c) => html`<li><a href=${`/${c.slug}/`}>${c.name}</a></li>`)}</ul>
      </nav>` : null}
      <nav class="foot__col" aria-label="Игрокам">
        <h2 class="foot__h">Игрокам</h2>
        <ul>
          <li><a href="/turniry/">Турниры</a></li>
          <li><a href="/rejting/">Рейтинг</a></li>
          <li><a href="/plus/">Бильярдум+</a></li>
          <li><a href=${APP}>Приложение</a></li>
          <li><a href="/zhurnal/">Журнал</a></li>
        </ul>
      </nav>
      <nav class="foot__col" aria-label="Клубам">
        <h2 class="foot__h">Клубам</h2>
        <ul>
          <li><a href="/dlya-klubov/">Программа для клуба</a></li>
          <li><a href="/dlya-biznesa/">Карточка клуба бесплатно</a></li>
          <li><a href="/club/">Вход для персонала</a></li>
        </ul>
      </nav>
    </div>
    <div class="wrap foot__legal">
      <p class="small">© Бильярдум, 2026. Данные гостей хранятся на серверах в России.</p>
      <p class="small"><a href=${`${APP}privacy`}>Политика обработки персональных данных</a></p>
    </div>
  </footer>`;
}

export function MockNote() {
  return html`<aside class="mocknote" aria-label="Демо-данные"><p>Демо-данные заглушки: клубы, игроки, турниры и отзывы выдуманы для разработки. В рабочей версии здесь только настоящие клубы.</p></aside>`;
}

export function Crumbs({ items }) {
  return html`<nav class="crumbs" aria-label="Вы здесь">
    <ol>${items.map((it, i) => html`<li>${i < items.length - 1 ? html`<a href=${it.href}>${it.name}</a>` : html`<span aria-current="page">${it.name}</span>`}</li>`)}</ol>
  </nav>`;
}

export function Empty({ ill = 'rack', title, children, action }) {
  return html`<div class="empty">
    <${Raw} class="ill-wrap" html=${illustration(ill)} />
    <p class="empty__title">${title}</p>
    ${children ? html`<div class="empty__body hint">${children}</div>` : null}
    ${action ?? null}
  </div>`;
}

export function Badge({ tone = 'free', children }) {
  return html`<span class=${`badge badge--${tone}`}><span class="badge__dot" aria-hidden="true"></span>${children}</span>`;
}

// ---------- зал ----------

/**
 * План зала (DESIGN §1, §4): свободные столы тёмные, занятые освещены, бронь с янтарной рамкой.
 * Сетка без координат (как planLayout в shared/hall.mjs): ряд на вид стола, на телефоне 3 стола в ряду.
 * Остров hall.js обновляет статусы каждые 30 с по data-src.
 */
export function HallPlan({ hall, club, city, timezone, now = Date.now(), headingId, heading }) {
  const resources = [...(hall?.resources ?? [])].sort((a, b) => a.number - b.number);
  const states = resources.map((r) => ({ r, s: publicTableState(r, timezone, now) }));
  const isFree = ({ s }) => s.tone === 'free' || s.tone === 'booked';
  // M5.8: столы и падел-корты — отдельными рядами и своими счётчиками («Корт 1» и «Стол 1» — разные)
  const tables = states.filter(({ r }) => familyOf(r) !== 'court');
  const courts = states.filter(({ r }) => familyOf(r) === 'court');
  const free = tables.filter(isFree).length;
  const freeCourts = courts.filter(isFree).length;
  const groups = [
    tables.filter(({ r }) => tableKind(r.type) === 'pyramid'),
    tables.filter(({ r }) => tableKind(r.type) === 'pool'),
  ].filter((g) => g.length);
  const booking = club.online_booking && club.club_id;
  // Одна сетка для всех рядов: пул под пирамидами стоит в тех же колонках
  const cols = Math.min(6, Math.max(1, ...groups.map((g) => g.length)));
  const cell = ({ r, s }) => {
    const kind = resourceArt(r);
    const court = kind === 'court';
    const art = html`<span class="tbl__art lit-host" data-lit=${s.lit ? 'true' : 'false'}><span class="tbl__glow"></span><${Raw} html=${tableSvg(kind, { uid: `t${club.slug}-${court ? 'c' : ''}${r.number}` })} /></span>
          <span class="tbl__cap"><span class="tbl__num">${resourceName(r, r.number)}</span>${' '}<span class="tbl__status" data-status>${s.word}</span></span>`;
    const attrs = { 'data-tone': s.tone, 'data-kind': kind, 'data-n': hallKey(r) };
    const href = `${APP}book/${club.club_id}${court ? '?family=court' : `?table=${r.number}`}`;
    return html`<li class="plan-cell">${booking
      ? html`<a class="tbl" href=${href} aria-label=${`${hallLabel(r, s)}. Забронировать`} ...${attrs}>${art}</a>`
      : html`<div class="tbl" role="img" aria-label=${hallLabel(r, s)} ...${attrs}>${art}</div>`}</li>`;
  };
  return html`<section class="hall hall--site" aria-labelledby=${headingId}
      data-hall data-src=${`/api/public/clubs/${city}/${club.slug}`} data-tz=${timezone}>
    <div class="hall__head">
      <h2 class="hall__title" id=${headingId}>${heading ?? 'Зал сейчас'}</h2>
      ${tables.length ? html`<p class="hall__free" aria-live="polite"><b data-hall-free>${free}</b> <span data-hall-word>${plural(free, ['стол', 'стола', 'столов'])} ${freeWord(free)}</span> из ${tables.length}</p>` : null}
      ${courts.length ? html`<p class="hall__free" aria-live="polite"><b data-hall-free-court>${freeCourts}</b> <span data-hall-word-court>${courtsWord(freeCourts)} ${freeWord(freeCourts)}</span> из ${courts.length}</p>` : null}
      <ul class="legend" aria-label="Обозначения">
        <li><span class="legend__mark"></span>Свободен</li>
        <li><span class="legend__mark legend__mark--play"></span>Идёт игра, свет горит</li>
        <li><span class="legend__mark legend__mark--booked"></span>Бронь</li>
      </ul>
    </div>
    ${groups.map((g) => html`<ul class=${`plan-grid plan-grid--c${cols}`}>${g.map(cell)}</ul>`)}
    ${courts.length ? html`<h3 class="hall__sub">Падел-корты</h3><ul class=${`plan-grid plan-grid--courts plan-grid--c${Math.min(4, courts.length)}`}>${courts.map(cell)}</ul>` : null}
    <p class="hall__note small">${booking ? `Нажмите на ${courts.length && tables.length ? 'стол или корт' : courts.length ? 'корт' : 'стол'}, чтобы забронировать в приложении.` : 'Онлайн-бронь в этом клубе пока не включена: приходите и играйте по QR-коду.'} Обновляется каждые 30 секунд.</p>
  </section>`;
}

/**
 * Строка зала в каталоге (DESIGN §4): маленькие столы по числу, горящие — заняты. Заменяет фото клуба.
 * API отдаёт только число столов и свободных, поэтому свободные идут первыми.
 */
export function HallStrip({ club }) {
  const n = club.tables_count ?? 0;
  // M5.8: корты — после столов, крупнее
  const k = club.courts_count ?? 0;
  if (!n && !k) return null;
  const live = club.status === 'platform' && club.free_now !== null;
  const free = live ? Math.min(n, club.free_now) : 0;
  const freeK = live ? Math.min(k, club.courts_free_now ?? 0) : 0;
  const parts = live
    ? [n ? `Свободно ${free} из ${n} ${plural(n, ['стола', 'столов', 'столов'])}` : null, k ? `${n ? 'с' : 'С'}вободно ${freeK} из ${k} ${plural(k, ['корта', 'кортов', 'кортов'])}` : null]
    : [n ? `${n} ${tablesWord(n)}` : null, k ? `${k} ${courtsWord(k)}` : null];
  const label = live ? parts.filter(Boolean).join(', ') : `${parts.filter(Boolean).join(', ')}, занятость видна только у клубов на программе`;
  const item = (i, f, court) => html`<i class=${`strip__t${court ? ' strip__t--court' : ''} ${!live ? 'strip__t--idle' : i < f ? 'strip__t--off' : 'strip__t--on'}`}></i>`;
  return html`<span class=${`strip${live ? '' : ' strip--idle'}`} role="img" aria-label=${label}>
    ${Array.from({ length: Math.min(n, 30) }, (_, i) => item(i, free, false))}
    ${Array.from({ length: Math.min(k, 8) }, (_, i) => item(i, freeK, true))}
  </span>`;
}

export function ClubStatus({ club, courts = false }) {
  if (club.status !== 'platform') return html`<${Badge} tone="reserved">Бронь по заявке<//>`;
  // Только корты в клубе или фильтр «Падел» — статус по кортам (M5.8)
  if (courts || (!club.tables_count && club.courts_count)) {
    if (club.courts_free_now > 0) return html`<${Badge} tone="free">Свободно ${club.courts_free_now} ${courtsWord(club.courts_free_now)}<//>`;
    return html`<${Badge} tone="play">Все корты заняты<//>`;
  }
  if (club.free_now > 0) return html`<${Badge} tone="free">Свободно ${club.free_now}<//>`;
  return html`<${Badge} tone="play">Все столы заняты<//>`;
}

export function ClubRow({ club, hours, courts = false }) {
  const h = hoursText(club);
  const disciplines = disciplinesText(club.disciplines);
  const forHours = courts ? null : priceForHours(club, hours);
  const court = courtPriceText(club);
  return html`<li class="club-row">
    <div class="club-row__main">
      <h3 class="club-row__name"><a href=${club.path}>${club.name}</a></h3>
      <p class="club-row__addr">${club.address}</p>
      <p class="club-row__meta">${[disciplines, club.tables_count ? `${club.tables_count} ${tablesWord(club.tables_count)}` : null, club.courts_count ? `${club.courts_count} ${courtsWord(club.courts_count)}` : null, h[0]].filter(Boolean).join(', ')}</p>
    </div>
    <div class="club-row__hall"><${HallStrip} club=${club} /></div>
    <div class="club-row__side">
      <${ClubStatus} club=${club} courts=${courts} />
      ${forHours ? html`<p class="club-row__price"><b>${forHours}</b></p>`
        : club.price_from_kopecks && !courts ? html`<p class="club-row__price"><span>от <b>${formatMoney(club.price_from_kopecks)}</b> в час</span></p>`
        : !court ? html`<p class="club-row__price small">Цены уточняйте в клубе</p>` : null}
      ${court ? html`<p class="club-row__price small">Падел: ${court}</p>` : null}
      ${club.rating ? html`<p class="club-row__rate small"><${Icon} name="star" /> ${String(club.rating.avg).replace('.', ',')}, ${club.rating.count} ${plural(club.rating.count, ['отзыв', 'отзыва', 'отзывов'])}</p>` : null}
    </div>
  </li>`;
}

// ---------- цены ----------

export function PriceGrid({ prices }) {
  if (!prices?.length) return null;
  return html`<div class="prices">${prices.map((block) => {
    const g = priceGrid(block);
    return html`<div class="scroll-x" tabindex="0" role="region" aria-label=${`Цены: ${g.title}`}>
      <table class="ptable">
        <caption>${g.title}, ₽ за ${g.slot_minutes ? slotLabel(g.slot_minutes) : 'час'}</caption>
        <thead><tr><th scope="col"><span class="visually-hidden">Дни</span></th>${g.cols.map((c) => html`<th scope="col">${c.label}</th>`)}</tr></thead>
        <tbody>${g.rows.map((r) => html`<tr><th scope="row">${r.label}</th>${r.cells.map((k) => html`<td>${k === null ? html`<span aria-label="нет">—</span>` : formatMoney(k)}</td>`)}</tr>`)}</tbody>
      </table>
    </div>`;
  })}</div>`;
}

// ---------- турниры ----------

export function TournamentRow({ t, showClub = true }) {
  const st = TOURNAMENT_STATUS[t.status] ?? TOURNAMENT_STATUS.registration;
  const left = seatsLeft(t);
  return html`<li class="afisha__row">
    <p class="afisha__date"><span class="afisha__day display">${formatDate(t.starts_at, t.timezone).split(' ')[0]}</span><span class="afisha__month">${formatDate(t.starts_at, t.timezone).split(' ').slice(1).join(' ')}</span><span class="mono">${formatTime(t.starts_at, t.timezone)}</span></p>
    <div class="afisha__main">
      <h3 class="afisha__title"><a href=${tournamentUrl(t.id)}>${t.title}</a></h3>
      <p class="afisha__meta">${DISCIPLINES[t.discipline]}, ${(FORMATS[t.format] ?? t.format).toLowerCase()}, до ${t.race_to} ${plural(t.race_to, ['победы', 'побед', 'побед'])}${t.rating_max ? `, рейтинг до ${t.rating_max}` : ''}</p>
      ${showClub ? html`<p class="afisha__club">${t.club.path ? html`<a href=${t.club.path}>${t.club.name}</a>` : t.club.name}${t.club.city_name ? `, ${t.club.city_name}` : ''}</p>` : null}
    </div>
    <div class="afisha__side">
      <span class=${`tstatus tstatus--${st.tone}`}>${st.word}</span>
      <p class="small">Взнос ${t.entry_fee_kopecks ? formatMoney(t.entry_fee_kopecks) : 'бесплатно'}${t.status === 'registration' ? `, ${left ? `осталось ${left} ${plural(left, ['место', 'места', 'мест'])}` : 'мест нет'}` : ''}</p>
    </div>
  </li>`;
}

/**
 * Счёты (DESIGN §1, §4): костяшки по числу побед в матче (до N), сдвинутые влево — выигранные партии.
 * В пирамиде матч идёт из партий до 8 шаров; шары внутри партии API не отдаёт.
 */
export function Abacus({ match, race }) {
  const n = Math.max(1, Math.min(15, race || 3));
  const row = (player, games) => html`<div class="abacus__row">
    <p class="abacus__name">${player?.nick ?? 'Определится'}</p>
    <span class="abacus__wire" role="img" aria-label=${`${player?.nick ?? 'Игрок'}: ${games} из ${n} побед`}>
      ${Array.from({ length: n }, (_, i) => html`<i class=${`bead${i < games ? ' bead--on' : ''}${i === games ? ' bead--gap' : ''}`}></i>`)}
    </span>
    <p class="abacus__games display" aria-hidden="true">${games}</p>
  </div>`;
  return html`<div class="abacus">
    ${row(match.a, match.score_a ?? 0)}
    ${row(match.b, match.score_b ?? 0)}
  </div>`;
}

export function Bracket({ bracket }) {
  if (!bracket?.rounds?.length) return null;
  const player = (p, score, won) => html`<li class=${`bm__p${won ? ' bm__p--won' : ''}`}>
    <span class="bm__seed mono">${p?.seed ?? ''}</span>
    <span class="bm__nick">${p?.nick ?? 'Определится'}</span>
    <span class="bm__score mono">${p ? score : ''}</span>
    ${won ? html`<span class="visually-hidden">, победитель</span>` : null}
  </li>`;
  return html`<div class="bracket scroll-x" tabindex="0" role="region" aria-label="Сетка турнира">
    <ol class="bracket__in">
      ${bracket.rounds.map((round) => html`<li class="bracket__round">
        <h3 class="bracket__title">${round.title}</h3>
        <ol class="bracket__matches">
          ${round.matches.map((m) => html`<li class=${`bm bm--${m.status}`}>
            <ol class="bm__players">
              ${player(m.a, m.score_a, m.winner === 'a')}
              ${player(m.b, m.score_b, m.winner === 'b')}
            </ol>
            <p class="bm__meta small">${m.status === 'live' ? html`<span class="tstatus tstatus--alert">Идёт</span>` : html`<span>${m.status === 'finished' ? 'Сыгран' : m.status === 'canceled' ? 'Отменён' : 'Ждёт'}</span>`}${m.table && m.status !== 'canceled' ? html`<span>стол ${m.table}</span>` : null}</p>
          </li>`)}
        </ol>
      </li>`)}
    </ol>
  </div>`;
}

// ---------- рейтинг ----------

/** Шар из слоновой кости с номером — только места 1–3 (DESIGN §1). */
export function PlaceBall({ place }) {
  if (place > 3) return html`<span class="place mono">${place}</span>`;
  return html`<span class="place place--ball" role="img" aria-label=${`${place} место`}>
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><circle class="pball" cx="16" cy="16" r="14" /><circle class="pball__hi" cx="11" cy="10" r="4" /><text x="16" y="17" text-anchor="middle" dominant-baseline="central" class="pball__n">${place}</text></svg>
  </span>`;
}

export function RatingTable({ rows, caption }) {
  return html`<div class="scroll-x" tabindex="0" role="region" aria-label=${caption}>
    <table class="rtable">
      <caption class="visually-hidden">${caption}</caption>
      <thead><tr><th scope="col">Место</th><th scope="col">Игрок</th><th scope="col" class="rtable__lvl">Уровень</th><th scope="col" class="num">Рейтинг</th><th scope="col" class="num rtable__opt">Партий</th></tr></thead>
      <tbody>${rows.map((r) => html`<tr class=${r.place <= 3 ? 'rtable__top' : ''}>
        <td><${PlaceBall} place=${r.place} /></td>
        <th scope="row" class="rtable__nick">${r.nick}<span class="rtable__sub">${r.level}</span></th>
        <td class="rtable__lvl">${r.level}</td>
        <td class="num rtable__rating">${r.rating}</td>
        <td class="num rtable__opt">${r.games}</td>
      </tr>`)}</tbody>
    </table>
  </div>`;
}
