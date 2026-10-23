import { formatMoney } from '@billiardum/shared/format';
import { tableSvg } from '@billiardum/shared/hall';
import { html, Icon, Raw } from '../html.mjs';
import { APP, Crumbs } from '../components.mjs';
import { PLANS, planTotal, tablesWord } from '../lib.mjs';
import { breadcrumbsLd, faqLd } from '../seo.mjs';

const STEPS = [
  ['Заявка и тест', 'Оставляете заявку, мы заводим клуб. Тест — до двух месяцев бесплатно: все оплаты тестовые, свет работает по-настоящему.'],
  ['Свет на столах', 'Электрик клуба ставит контроллер в линию лампы каждого стола по нашей инструкции. Привязка — QR-код на корпусе и Wi-Fi клуба.'],
  ['Запуск', 'План зала, тарифы по шаблону, меню бара из таблицы, QR-наклейки на столы. Переключаете клуб в боевой режим.'],
];

const TASKS = [
  ['lamp', 'Стол не играет бесплатно', 'Свет над столом включает только сервер после оплаты. Каждое включение — в журнале, ручное — с причиной и сразу вам в телефон.'],
  ['register', 'Ресепшн работает как касса в магазине', 'Бар, наличные и карты через ККТ клуба, смена закрывается вслепую. Время стола гость оплачивает сам по QR.'],
  ['phone', 'Вы видите клуб с телефона', 'Зал сейчас, выручка, тревоги и утренняя сводка за вчера. Не нужно звонить администратору, чтобы узнать, что происходит.'],
];

const MODULES = [
  ['hall', 'Зал и свет', 'План зала вживую: какие столы горят, до скольки оплачено, где бронь. Сервисный свет — только с причиной и уведомлением владельцу.'],
  ['qr', 'Игра по QR', 'Гость сканирует код на столе, платит через СБП или картой — свет включается. Предупреждения о конце времени, продление по оплате, свет гаснет сам.'],
  ['cart', 'Касса и бар', 'Продажи как в магазине, чек по 54‑ФЗ через ККТ клуба, заказы бара со стола, стоп-лист, склад.'],
  ['calendar', 'Бронь', 'Онлайн-бронь с предоплатой или без, борт-шкала времени, лист ожидания, бронь по телефону от ресепшена.'],
  ['report', 'Смены и отчёты', 'Открытие и закрытие смены, расхождения кассы, утренняя сводка владельцу, отчёты по столам и бару.'],
  ['chain', 'Журнал и тревоги', 'Журнал действий только дополняется. Скидка выше лимита, возврат, бесплатная игра — с причиной и тревогой владельцу.'],
  ['trophy', 'Турниры и рейтинг', 'Турнир из программы: запись со взносом, посев по рейтингу, сетка на ТВ, столы блокируются сами.'],
  ['search', 'Каталог для гостей', 'Карточка клуба на сайте со свободными столами вживую, ценами и бронью — гости находят вас сами.'],
];

const COMPARE = [
  ['Свет над столом', 'включает администратор', 'включается после оплаты'],
  ['Конец времени', 'следит администратор', 'гость получает предупреждения, свет гаснет сам'],
  ['Связь пропала', 'игра на доверии', 'контроллер доигрывает оплаченное время сам'],
  ['Бесплатная игра «для своих»', 'не видно', 'только с причиной, тревога владельцу'],
  ['Касса и бар', 'тетрадь или отдельная программа', 'касса с чеками, склад, смены вслепую'],
  ['Бронь', 'по телефону', 'онлайн с предоплатой и лист ожидания'],
  ['Гости находят клуб', 'по старой карточке в справочнике', 'по свободным столам в каталоге'],
];

export const FAQ = [
  { q: 'Нужно ли менять столы или лампы?', a: 'Нет. Контроллер ставится в разрыв линии лампы над столом. Монтаж делает электрик клуба по инструкции: в комплекте автомат и корпус.' },
  { q: 'Что будет, если пропадёт интернет?', a: 'Оплаченная игра не обрывается: контроллер на столе сам доиграет оплаченное время и погасит свет. Неоплаченную игру он никогда не продлевает.' },
  { q: 'Куда идут деньги гостей?', a: 'В магазин ЮKassa вашего клуба. Бильярдум не держит деньги гостей у себя. Чеки по 54‑ФЗ — онлайн через ЮKassa, на ресепшене через вашу ККТ.' },
  { q: 'Сколько стоит?', a: 'Сейчас мы проверяем цены с первыми клубами: ориентир — 790 ₽ за стол в месяц для одного зала и 1 190 ₽ для сети. Тест — до двух месяцев бесплатно. Контроллер — по себестоимости плюс монтажный комплект.' },
  { q: 'Где хранятся данные гостей?', a: 'Только на серверах в России, по 152‑ФЗ. Иностранной аналитики и пикселей нет.' },
  { q: 'Можно ли работать без онлайн-оплаты?', a: 'Да. Ресепшн принимает наличные и карты через ККТ клуба и запускает стол из программы. Каждое ручное действие записывается в журнал.' },
];

const DEMO_TABLES = [
  { n: 1, kind: 'pyramid', on: true },
  { n: 2, kind: 'pyramid', on: false },
  { n: 3, kind: 'pyramid', on: true },
  { n: 4, kind: 'pool', on: false },
];

/** Живая демо-программа ресепшена (DESIGN §5): стол можно запустить и остановить — свет загорается. */
function Demo() {
  return html`<figure class="demo" data-demo aria-labelledby="demo-cap">
    <div class="demo__bar"><span class="demo__title">Ресепшн, зал</span><span class="demo__free" data-demo-free>Свободно 2 из 4</span></div>
    <ul class="demo__tables">
      ${DEMO_TABLES.map((t) => html`<li class="demo__t" data-kind=${t.kind}>
        <span class="tbl__art lit-host" data-lit=${t.on ? 'true' : 'false'} data-demo-art><span class="tbl__glow"></span><${Raw} html=${tableSvg(t.kind, { uid: `demo-${t.n}` })} /></span>
        <span class="demo__cap"><b>Стол ${t.n}</b> <span data-demo-word>${t.on ? 'Идёт игра' : 'Свободен'}</span></span>
        <button type="button" class="btn btn--sm demo__btn" data-demo-btn hidden data-on=${t.on ? 'true' : 'false'} aria-label=${`Стол ${t.n}: ${t.on ? 'остановить' : 'запустить'}`}>${t.on ? 'Остановить' : 'Запустить'}</button>
      </li>`)}
    </ul>
    <figcaption id="demo-cap" class="small">Демо: так выглядит зал в программе клуба. В настоящем клубе стол запускает оплата гостя, а ручной запуск требует причины.</figcaption>
  </figure>`;
}

export function LeadForm({ state = {}, now }) {
  const v = state.values ?? {};
  if (state.sent) {
    return html`<div class="note note--free" role="status"><${Icon} name="check" /><div>
      <p class="note__title">Заявка у нас</p>
      <p>Мы свяжемся с вами по телефону в рабочее время, расскажем о тесте и подключении.</p></div></div>`;
  }
  return html`<form class="form" method="post" action="/dlya-klubov/zayavka/" data-async-form novalidate>
    ${state.error ? html`<div class="note note--error" role="alert" tabindex="-1" data-focus><${Icon} name="alert" /><div><p class="note__title">Заявка не отправлена</p><p>${state.error}</p></div></div>` : null}
    <input type="hidden" name="t" value=${String(now)} />
    <div class="hp" aria-hidden="true"><label>Сайт <input type="text" name="website" tabindex="-1" autocomplete="off" /></label></div>
    <div class="form__grid">
      <label class="field"><span class="field__label">Как вас зовут</span>
        <input class="field__input" name="name" required maxlength="80" autocomplete="name" value=${v.name ?? ''} /></label>
      <label class="field"><span class="field__label">Телефон</span>
        <input class="field__input" name="phone" type="tel" required inputmode="tel" autocomplete="tel" placeholder="+7 900 000-00-00" value=${v.phone ?? ''} /></label>
      <label class="field"><span class="field__label">Клуб</span>
        <input class="field__input" name="club_name" required maxlength="120" autocomplete="organization" value=${v.club_name ?? ''} /></label>
      <label class="field"><span class="field__label">Город</span>
        <input class="field__input" name="city" required maxlength="80" autocomplete="address-level2" value=${v.city ?? ''} /></label>
      <label class="field"><span class="field__label">Сколько столов</span>
        <input class="field__input" name="tables_count" type="number" inputmode="numeric" min="1" max="200" value=${v.tables_count ?? ''} /></label>
    </div>
    <label class="field"><span class="field__label">Комментарий</span>
      <textarea class="field__input" name="comment" maxlength="1000" rows="3">${v.comment ?? ''}</textarea>
      <span class="field__hint">Необязательно. Например: когда удобно позвонить или какие столы в зале.</span></label>
    <label class="check"><input type="checkbox" name="consent" value="1" required checked=${v.consent === '1'} />
      <span>Согласен на обработку имени и телефона, чтобы со мной связались по заявке, по <a href=${`${APP}privacy`}>политике обработки персональных данных</a>.</span></label>
    <button class="btn btn--primary btn--lg" type="submit">Отправить заявку</button>
    <p class="form__status" role="status" aria-live="polite"></p>
  </form>`;
}

export async function ownersPage({ api, cfg, url, now, form = {} }) {
  const cities = await api.cities();
  const raw = Number(url.searchParams.get('stolov'));
  const tables = Number.isInteger(raw) && raw >= 1 && raw <= 200 ? raw : 10;
  const sent = form.sent || url.searchParams.get('zayavka') === 'ok';
  const crumbs = [{ name: 'Главная', path: '/' }, { name: 'Для клубов', path: '/dlya-klubov/' }];

  const body = html`
  <section class="own-hero">
    <div class="wrap own-hero__in">
      <div class="own-hero__text">
        <${Crumbs} items=${crumbs.map((c) => ({ name: c.name, href: c.path }))} />
        <h1 class="display own-hero__title">Клуб, где стол не играет бесплатно</h1>
        <p class="own-hero__lead">Программа для бильярдного клуба: свет над столом включается после оплаты, гость играет по QR без администратора, ресепшн продаёт бар как кассир, а вы видите всё с телефона.</p>
        <div class="own-hero__cta">
          <a class="btn btn--lamp btn--lg" href="#zayavka">Оставить заявку</a>
          <a class="btn btn--quiet" href="#tarify">Тарифы</a>
        </div>
      </div>
      <${Demo} />
    </div>
  </section>

  <div class="wrap page">
    <section class="block" aria-labelledby="steps-title">
      <h2 class="display" id="steps-title">Подключение в три шага</h2>
      <ol class="steps">${STEPS.map(([t, d], i) => html`<li class="steps__item"><span class="steps__n display" aria-hidden="true">${i + 1}</span><h3>${t}</h3><p>${d}</p></li>`)}</ol>
    </section>

    <section class="block" aria-labelledby="tasks-title">
      <h2 class="display" id="tasks-title">Три задачи владельца</h2>
      <ul class="tasks">${TASKS.map(([icon, t, d]) => html`<li class="tasks__item"><${Icon} name=${icon} /><div><h3>${t}</h3><p>${d}</p></div></li>`)}</ul>
    </section>

    <section class="block" aria-labelledby="mod-title">
      <h2 class="display" id="mod-title">Что внутри</h2>
      <div class="modules" data-modules>
        <div class="modules__list" role="tablist" aria-label="Модули программы" data-modules-tabs hidden>
          ${MODULES.map(([icon, t], i) => html`<button type="button" role="tab" id=${`mt-${i}`} aria-controls=${`mp-${i}`} aria-selected=${i === 0 ? 'true' : 'false'} tabindex=${i === 0 ? '0' : '-1'}><${Icon} name=${icon} />${t}</button>`)}
        </div>
        <div class="modules__panels">
          ${MODULES.map(([icon, t, d], i) => html`<section class="modules__panel" id=${`mp-${i}`} aria-labelledby=${`mt-${i}`} data-panel>
            <h3><${Icon} name=${icon} />${t}</h3><p>${d}</p>
          </section>`)}
        </div>
      </div>
    </section>

    <section class="block" aria-labelledby="cmp-title">
      <h2 class="display" id="cmp-title">Как было и как станет</h2>
      <div class="scroll-x" tabindex="0" role="region" aria-label="Сравнение">
        <table class="cmp">
          <thead><tr><th scope="col"><span class="visually-hidden">Что</span></th><th scope="col">Без программы</th><th scope="col">С Бильярдумом</th></tr></thead>
          <tbody>${COMPARE.map(([a, b, c]) => html`<tr><th scope="row">${a}</th><td>${b}</td><td class="cmp__ours">${c}</td></tr>`)}</tbody>
        </table>
      </div>
    </section>

    <section class="block" id="tarify" aria-labelledby="price-title">
      <h2 class="display" id="price-title">Тарифы</h2>
      <p class="note note--lamp"><${Icon} name="info" /><span><b>Тест — до двух месяцев бесплатно.</b> Цены предварительные: мы проверяем их с первыми клубами и зафиксируем до запуска.</span></p>
      <form class="calc" method="get" action="/dlya-klubov/#tarify" data-calc>
        <label class="calc__label" for="calc-n">Столов в клубе: <output class="calc__n display" for="calc-n" data-calc-n>${tables}</output></label>
        <input id="calc-n" class="calc__range" type="range" name="stolov" min="1" max="40" value=${Math.min(40, tables)} />
        <noscript><button class="btn btn--sm btn--quiet" type="submit">Пересчитать</button></noscript>
      </form>
      <ul class="plans">
        <li class="plan">
          <h3 class="plan__name">Карточка в каталоге</h3>
          <p class="plan__price display">0 ₽</p>
          <p>Клуб в каталоге, заявки гостей на бронь приходят в мессенджер клуба.</p>
        </li>
        ${PLANS.map((p) => html`<li class=${`plan${p.id === 'club' ? ' plan--main' : ''}`}>
          <h3 class="plan__name">${p.name}</h3>
          <p class="plan__price display"><span data-calc-total=${p.perTable}>${formatMoney(planTotal(p, tables))}</span><span class="plan__per"> в месяц</span></p>
          <p class="small">≈ ${formatMoney(p.perTable * 100)} за стол, <span data-calc-tables>${tables} ${tablesWord(tables)}</span></p>
          <p>${p.about}</p>
        </li>`)}
      </ul>
      <p class="small">Контроллер — по себестоимости плюс монтажный комплект, монтаж делает электрик клуба. Комиссии с онлайн-брони на старте нет. Подписка оплачивается автоплатежом, отдельно от денег гостей.</p>
    </section>

    <section class="block first" aria-labelledby="first-title">
      <h2 class="display" id="first-title">Программа первых клубов</h2>
      <ul class="ticks">
        <li><${Icon} name="check" /><span>Тест до двух месяцев бесплатно, с настоящим светом и тестовыми оплатами.</span></li>
        <li><${Icon} name="check" /><span>Подключение без выезда: инструкция для электрика и связь с командой напрямую.</span></li>
        <li><${Icon} name="check" /><span>Ваши пожелания идут в план разработки: мы строим программу вместе с первыми клубами.</span></li>
      </ul>
    </section>

    <section class="block lead" id="zayavka" aria-labelledby="lead-title">
      <h2 class="display" id="lead-title">Заявка на подключение</h2>
      <p class="hint">Оставьте контакты — свяжемся, расскажем о тесте и посчитаем комплект контроллеров под ваш зал.</p>
      <${LeadForm} state=${{ ...form, sent }} now=${now} />
    </section>

    <section class="block" aria-labelledby="faq-title">
      <h2 class="display" id="faq-title">Вопросы</h2>
      <div class="faq">${FAQ.map((f) => html`<details><summary>${f.q}</summary><p>${f.a}</p></details>`)}</div>
    </section>
  </div>`;

  return {
    path: '/dlya-klubov/',
    title: 'Программа для бильярдного клуба: свет по оплате, касса, бронь — Бильярдум',
    description: 'Свет над столом включается после оплаты, игра по QR без администратора, касса и бар с чеками, бронь, турниры. Тест до 2 месяцев бесплатно.',
    body,
    islands: ['owners', 'forms'],
    jsonld: [breadcrumbsLd(cfg.origin, crumbs), faqLd(FAQ)],
    active: 'dlya-klubov',
    cities,
    status: form.error ? 422 : 200,
  };
}
