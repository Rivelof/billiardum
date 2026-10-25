/**
 * Логика сайта без DOM и без сети: фильтры каталога (работают без JS через query), сортировка, сетка цен
 * «дни × часы», часы работы словами, уровни Бильярдум+, статус стола для гостя. Покрыта тестами.
 */
import { formatMoney, formatTime, plural } from '@billiardum/shared/format';
import { tableState } from '@billiardum/shared/hall';
import { familyOf, resourceName, slotLabel } from '@billiardum/shared/resource';

/** Дисциплины бильярда: турниры и рейтинг Бильярдум+ (рейтинг падела — в бэклоге, №205). */
export const DISCIPLINES = Object.freeze({ pyramid: 'Русская пирамида', pool: 'Пул', snooker: 'Снукер' });
/** Дисциплины каталога: бильярд и падел (M5.8, фильтр «Падел» — клубы с кортами). */
export const CATALOG_DISCIPLINES = Object.freeze({ ...DISCIPLINES, padel: 'Падел' });
export const DISCIPLINE_SHORT = Object.freeze({ pyramid: 'Пирамида', pool: 'Пул', snooker: 'Снукер', padel: 'Падел' });

/** Дисциплины списком: «Пирамида, пул, снукер». */
export function disciplinesText(list) {
  return (list ?? []).map((d) => DISCIPLINE_SHORT[d]).filter(Boolean).map((w, i) => (i ? w.toLowerCase() : w)).join(', ');
}

/** Первая часть адреса, которая не может быть городом. */
export const RESERVED = new Set([
  'turniry', 'rejting', 'plus', 'dlya-klubov', 'dlya-biznesa', 'zhurnal', 't', 'assets', 'shared', 'og', 'api',
  'app', 'club', 'pay', 'health', 'favicon.svg', 'favicon.ico', 'sitemap.xml', 'robots.txt',
]);

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Код стола на наклейке (как TABLE_CODE в api/routes/owner.mjs). */
export const TABLE_CODE = /^[0-9A-HJKMNP-TV-Z]{10}$/;

export const cityUrl = (city) => `/${city}/`;
export const clubUrl = (city, club) => `/${city}/${club}/`;
export const tournamentUrl = (id) => `/turniry/${id}/`;

/** Уровни Бильярдум+ (PRODUCT §13): любительские, не спортивные разряды. */
export const LEVELS = Object.freeze([
  { name: 'Новичок', from: 0, to: 1199 },
  { name: 'Любитель', from: 1200, to: 1399 },
  { name: 'Опытный', from: 1400, to: 1599 },
  { name: 'Сильный', from: 1600, to: 1799 },
  { name: 'Мастер', from: 1800, to: null },
]);

export function levelOf(rating) {
  return [...LEVELS].reverse().find((l) => rating >= l.from)?.name ?? 'Новичок';
}

export const tablesWord = (n) => plural(n, ['стол', 'стола', 'столов']);
export const courtsWord = (n) => plural(n, ['корт', 'корта', 'кортов']);

/** Только падел в фильтре: «свободно сейчас» и статус — по кортам (как server/directory public.mjs). */
export const padelOnly = (f) => f.d.length > 0 && f.d.every((d) => d === 'padel');

/** Цена корта в карточке: «от 2 400 ₽ за 1,5 ч» (court_price_from_kopecks за slot_minutes). null — цены нет. */
export function courtPriceText(club) {
  if (!Number.isInteger(club.court_price_from_kopecks) || !(club.slot_minutes > 0)) return null;
  return `от ${formatMoney(club.court_price_from_kopecks)} за ${slotLabel(club.slot_minutes)}`;
}
export const clubsWord = (n) => plural(n, ['клуб', 'клуба', 'клубов']);
export const freeWord = (n) => plural(n, ['свободен', 'свободно', 'свободно']);

// ---------- фильтры каталога ----------

export const SORTS = Object.freeze({
  recommended: 'Сначала с онлайн-бронью',
  free: 'Больше свободных столов',
  price: 'Сначала дешевле',
  rating: 'По оценке гостей',
  name: 'По названию',
});

export const PRICE_CAPS = Object.freeze([500, 800, 1200]);
export const HOURS = Object.freeze([1, 2, 3]);

/**
 * Фильтры из адреса: ?d=pyramid&d=pool&free=1&online=1&h24=1&max=800&sort=price&h=2
 * Неизвестные значения отбрасываются (адрес из чужих рук).
 */
export function parseFilters(params) {
  const sp = params instanceof URLSearchParams ? params : new URLSearchParams(params ?? '');
  const d = [...new Set(sp.getAll('d').filter((x) => x in CATALOG_DISCIPLINES))];
  const max = Number(sp.get('max'));
  const h = Number(sp.get('h'));
  const sort = sp.get('sort');
  return {
    d,
    free: sp.get('free') === '1',
    online: sp.get('online') === '1',
    h24: sp.get('h24') === '1',
    max: PRICE_CAPS.includes(max) ? max : null,
    sort: sort in SORTS ? sort : 'recommended',
    h: HOURS.includes(h) ? h : null,
  };
}

/** Фильтры обратно в адрес — в одном порядке, чтобы ссылки и кэш не множились. */
export function filtersQuery(f) {
  const sp = new URLSearchParams();
  for (const d of Object.keys(CATALOG_DISCIPLINES)) if (f.d?.includes(d)) sp.append('d', d);
  if (f.free) sp.set('free', '1');
  if (f.online) sp.set('online', '1');
  if (f.h24) sp.set('h24', '1');
  if (f.max) sp.set('max', String(f.max));
  if (f.h) sp.set('h', String(f.h));
  if (f.sort && f.sort !== 'recommended') sp.set('sort', f.sort);
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export function hasFilters(f) {
  return Boolean(f.d.length || f.free || f.online || f.h24 || f.max);
}

/** Минимальная цена часа клуба — для фильтра «цена» и сортировки. null — цен нет. */
export function priceFrom(club) {
  return Number.isInteger(club.price_from_kopecks) ? club.price_from_kopecks : null;
}

/**
 * Каталог города по фильтрам — те же правила, что у API (server/directory/README.md): дисциплины — клуб
 * должен иметь все выбранные; «свободно сейчас» знают только клубы на программе. Сортировка recommended:
 * сначала онлайн-бронь, затем больше свободных, затем по названию.
 */
export function applyFilters(clubs, f) {
  // «Свободно сейчас» с фильтром только «Падел» — свободные корты, иначе — столы (M5.8)
  const freeOf = padelOnly(f) ? (c) => c.courts_free_now : (c) => c.free_now;
  const out = clubs.filter((c) => {
    if (f.d.length && !f.d.every((d) => c.disciplines?.includes(d))) return false;
    if (f.free && !(freeOf(c) > 0)) return false;
    if (f.online && !c.online_booking) return false;
    if (f.h24 && !c.open_24h) return false;
    if (f.max) {
      const p = priceFrom(c);
      if (p === null || p > f.max * 100) return false;
    }
    return true;
  });
  const byName = (a, b) => a.name.localeCompare(b.name, 'ru');
  const sorts = {
    recommended: (a, b) => Number(b.online_booking) - Number(a.online_booking) || (freeOf(b) ?? -1) - (freeOf(a) ?? -1) || byName(a, b),
    free: (a, b) => (freeOf(b) ?? -1) - (freeOf(a) ?? -1) || byName(a, b),
    price: (a, b) => (priceFrom(a) ?? Infinity) - (priceFrom(b) ?? Infinity) || byName(a, b),
    rating: (a, b) => (b.rating?.avg ?? -1) - (a.rating?.avg ?? -1) || (b.rating?.count ?? 0) - (a.rating?.count ?? 0) || byName(a, b),
    name: byName,
  };
  return out.sort(sorts[f.sort] ?? sorts.recommended);
}

/** «в Екатеринбурге»: предложный падеж названия города. Неизвестное сложное название — «в городе Н». */
const CITY_IN = {
  'Москва': 'в\u00a0Москве', 'Санкт-Петербург': 'в\u00a0Санкт-Петербурге', 'Нижний Новгород': 'в\u00a0Нижнем Новгороде',
  'Великий Новгород': 'в\u00a0Великом Новгороде', 'Ростов-на-Дону': 'в\u00a0Ростове-на-Дону', 'Набережные Челны': 'в\u00a0Набережных Челнах',
  'Пермь': 'в\u00a0Перми', 'Тверь': 'в\u00a0Твери', 'Казань': 'в\u00a0Казани', 'Рязань': 'в\u00a0Рязани', 'Тюмень': 'в\u00a0Тюмени',
  'Сочи': 'в\u00a0Сочи', 'Орёл': 'в\u00a0Орле', 'Нижний Тагил': 'в\u00a0Нижнем Тагиле', 'Старый Оскол': 'в\u00a0Старом Осколе',
  'Череповец': 'в\u00a0Череповце', 'Елец': 'в\u00a0Ельце', 'Йошкар-Ола': 'в\u00a0Йошкар-Оле', 'Улан-Удэ': 'в\u00a0Улан-Удэ',
};
export function cityIn(name) {
  const n = String(name ?? '').trim();
  if (!n) return '';
  if (CITY_IN[n]) return CITY_IN[n];
  if (/\s/.test(n)) return `в\u00a0городе ${n}`;
  const pre = /^[ВвФф][^аеёиоуыэюя]/.test(n) ? 'во' : 'в';
  let w;
  if (/[иоуэюы]$/i.test(n)) w = n;
  else if (/ия$/.test(n)) w = `${n.slice(0, -1)}и`;
  else if (/[ая]$/.test(n)) w = `${n.slice(0, -1)}е`;
  else if (/ь$/.test(n)) w = `${n.slice(0, -1)}и`;
  else if (/й$/.test(n)) w = `${n.slice(0, -1)}е`;
  else w = `${n}е`;
  return `${pre}\u00a0${w}`;
}

// ---------- цены «дни × часы» ----------

const DAY_SHORT = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/** [1,2,3,4,5] → «Будни», [6,7] → «Выходные», [1..7] → «Каждый день», [5] → «Пт», [1,2,3,4] → «Пн–Чт». */
export function daysLabel(days) {
  const s = [...new Set(days)].sort((a, b) => a - b);
  const key = s.join('');
  if (key === '1234567') return 'Каждый день';
  if (key === '12345') return 'Будни';
  if (key === '67') return 'Выходные';
  const contiguous = s.every((d, i) => i === 0 || d === s[i - 1] + 1);
  if (contiguous && s.length > 2) return `${DAY_SHORT[s[0]]}–${DAY_SHORT[s.at(-1)]}`;
  return s.map((d) => DAY_SHORT[d]).join(', ');
}

/**
 * Сетка цен одного вида стола: строки — группы дней, столбцы — начало интервала («с 17:00»).
 * Если у всех правил столбца один конец — заголовок «17:00–02:00». Пустая клетка — null.
 * @param {{ type: string, title?: string, rules: { days: number[], from: string, to: string, price_per_hour_kopecks: number }[] }} block
 * @returns {{ type, title, cols: { from, to: string | null, label }[], rows: { label, cells: (number | null)[] }[] }}
 */
export function priceGrid(block) {
  const rules = block.rules ?? [];
  // рабочие сутки начинаются в 06:00: ночь после полуночи идёт после вечера
  const minutes = (t) => {
    const [h, m] = t.split(':').map(Number);
    return (h * 60 + m - 360 + 1440) % 1440;
  };
  const dayKey = (days) => [...days].sort((a, b) => a - b).join('');
  const froms = [...new Set(rules.map((r) => r.from))].sort((a, b) => minutes(a) - minutes(b));
  const cols = froms.map((from) => {
    const tos = [...new Set(rules.filter((r) => r.from === from).map((r) => r.to))];
    const to = tos.length === 1 ? tos[0] : null;
    return { from, to, label: to ? `${from}–${to}` : `с ${from}` };
  });
  const groups = [];
  for (const r of rules) {
    const key = dayKey(r.days);
    if (!groups.some((g) => g.key === key)) groups.push({ key, days: [...r.days].sort((a, b) => a - b) });
  }
  groups.sort((a, b) => a.days[0] - b.days[0] || a.days.length - b.days.length);
  const rows = groups.map((g) => ({
    label: daysLabel(g.days),
    // клетка — правило этих дней, которое действует в начале столбца (вечер 17:00–06:00 покрывает и «02:00–06:00»)
    cells: cols.map((c) => {
      const at = minutes(c.from);
      const hit = rules.find((r) => {
        if (dayKey(r.days) !== g.key) return false;
        const a = minutes(r.from);
        const b = minutes(r.to) || 1440;
        return a <= at && at < (b > a ? b : b + 1440);
      });
      // Корт (M5.8): цена за слот
      return hit ? (Number.isInteger(hit.price_per_slot_kopecks) ? hit.price_per_slot_kopecks : hit.price_per_hour_kopecks) : null;
    }),
  }));
  const slot = rules.find((r) => r.slot_minutes > 0)?.slot_minutes ?? null;
  return { type: block.type, title: block.title ?? CATALOG_DISCIPLINES[block.type] ?? block.type, cols, rows, slot_minutes: slot };
}

// ---------- часы работы ----------

export function hoursText(club) {
  if (club.open_24h) return ['Круглосуточно'];
  return club.hours_text ? [club.hours_text] : [];
}

/** Цена N часов по самой низкой цене часа: «2 часа от 900 ₽». */
export function priceForHours(club, h) {
  const p = priceFrom(club);
  if (p === null || !h) return null;
  return `${h} ${plural(h, ['час', 'часа', 'часов'])} от ${formatMoney(p * h)}`;
}

// ---------- стол на плане зала для гостя ----------

/**
 * Публичный статус стола (без ПДн): free | busy | reserved | unavailable, until, next_booking.
 * Слова — как в программе клуба (shared/hall.mjs tableState), недоступный стол — просто «Недоступен».
 */
export function publicTableState(item, timeZone, now = Date.now()) {
  const fmt = (iso) => formatTime(iso, timeZone);
  if (item.status === 'unavailable' || item.status === 'service' || item.status === 'offline' || item.status === 'fault') {
    return { tone: 'service', lit: false, word: 'Недоступен', spoken: 'недоступен' };
  }
  const st = tableState({ status: item.status === 'busy' ? 'busy' : item.status, until: item.until ?? null, next_booking: item.next_booking ?? null }, { formatTime: fmt, now });
  if (st.tone === 'free') return { ...st, spoken: 'свободен' };
  if (st.tone === 'play') return { ...st, spoken: item.until ? `идёт игра до ${fmt(item.until)}` : 'идёт игра' };
  return { ...st, spoken: st.spoken ?? st.word.toLowerCase() };
}

/** Подпись стола для экранного диктора: начинается с видимого текста («Стол 4 До 21:40», «Корт 1 Свободен»), дальше — словами. */
export function hallLabel(item, state) {
  const spoken = state.spoken ?? state.word.toLowerCase();
  const visible = `${resourceName(item, item.number)} ${state.word}`;
  return spoken && spoken !== state.word.toLowerCase() ? `${visible}, ${spoken}` : visible;
}

/** Ключ ресурса на плане: номера у столов и кортов свои (M5.8) — «table-3», «court-1». */
export const hallKey = (item) => `${familyOf(item)}-${item.number}`;

// ---------- турниры ----------

export const FORMATS = Object.freeze({
  single_elim: 'Олимпийская система',
  groups_playoff: 'Группы и плей-офф',
  double_elim: 'До двух поражений',
});

export const TOURNAMENT_STATUS = Object.freeze({
  registration: { word: 'Идёт запись', tone: 'free' },
  closed: { word: 'Запись закрыта', tone: 'pending' },
  live: { word: 'В эфире', tone: 'alert' },
  finished: { word: 'Завершён', tone: 'muted' },
  cancelled: { word: 'Отменён', tone: 'muted' },
});

/** Матч «в эфире» из сетки турнира: первый со статусом live. */
export function liveMatch(bracket) {
  for (const round of bracket?.rounds ?? []) {
    for (const m of round.matches) if (m.status === 'live') return { round: round.title, match: m };
  }
  return null;
}

export function seatsLeft(t) {
  return Math.max(0, (t.seats ?? 0) - (t.entries ?? 0));
}

/** Сезоны рейтинга: '2026-10' → «Октябрь 2026». */
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
export function seasonLabel(season) {
  if (season === 'all') return 'За всё время';
  const m = /^(\d{4})-(\d{2})$/.exec(season ?? '');
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : season;
}

/** Сезоны рейтинга: «за всё время» и последние три месяца по Москве (сезон — календарный месяц, №136). */
export function seasonsList(now = Date.now()) {
  const [y, m] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit' })
    .format(new Date(now)).split('-').map(Number);
  const out = ['all'];
  for (let k = 0; k < 3; k += 1) {
    const d = new Date(Date.UTC(y, m - 1 - k, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/** Телефон для ссылки tel: — только цифры и плюс. */
export function telHref(phone) {
  return `tel:${String(phone ?? '').replace(/[^\d+]/g, '')}`;
}

// ---------- «Для клубов»: тарифы ----------

/** Гипотезы цен PRODUCT §17, ₽ за стол в месяц. */
export const PLANS = Object.freeze([
  { id: 'club', name: 'Клуб', perTable: 790, about: 'Один зал: свет, игра по QR, касса, бар, бронь, смены, журнал, турниры.' },
  { id: 'network', name: 'Сеть', perTable: 1190, about: 'Несколько залов: единые тарифы, сравнение залов, права по залам.' },
]);

export function planTotal(plan, tables) {
  const n = Math.max(1, Math.min(200, Math.round(Number(tables) || 1)));
  return plan.perTable * n * 100;
}
