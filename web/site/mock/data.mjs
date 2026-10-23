/**
 * Заглушка публичного API для разработки сайта (контракт M4 §4). ДЕМО-ДАННЫЕ: клубы, игроки, отзывы и турниры
 * выдуманы и живут только здесь. В проде сайт берёт данные из BL_API_URL, а эта папка не используется.
 *
 * Формы ответов — как ожидает сайт (web/site/README.md, «Формы ответов публичного API»).
 * Свободные столы «живые»: состояние стола меняется каждые 10 минут по детерминированному хешу.
 */

const TZ = 'Asia/Yekaterinburg';

export const CITIES = [
  { slug: 'ekaterinburg', name: 'Екатеринбург', name_in: 'в Екатеринбурге', timezone: TZ },
  { slug: 'chelyabinsk', name: 'Челябинск', name_in: 'в Челябинске', timezone: TZ },
  { slug: 'perm', name: 'Пермь', name_in: 'в Перми', timezone: 'Asia/Yekaterinburg' },
];

const weekday = [1, 2, 3, 4, 5];
const weekend = [6, 7];

function tables(spec) {
  // spec: [['pyramid', 6], ['pool', 2]] → ресурсы с номерами по порядку
  const out = [];
  let n = 1;
  for (const [kind, count] of spec) {
    for (let i = 0; i < count; i += 1) {
      out.push({
        id: `00000000-0000-4000-8000-${String(n).padStart(4, '0')}${'0'.repeat(8)}`,
        number: n,
        type: `billiard_${kind}`,
        title: kind === 'pyramid' ? 'Русская пирамида, 12 футов' : kind === 'pool' ? 'Пул, 9 футов' : 'Снукер, 12 футов',
      });
      n += 1;
    }
  }
  return out;
}

function priceRules(spec) {
  // spec: { pyramid: [дневная, вечерняя, ночная, выходные] } в рублях за час
  return Object.entries(spec).map(([type, [day, evening, night, weekendDay, weekendEvening]]) => ({
    type,
    title: type === 'pyramid' ? 'Русская пирамида' : type === 'pool' ? 'Пул' : 'Снукер',
    rules: [
      { days: weekday, from: '12:00', to: '17:00', price_per_hour_kopecks: day * 100 },
      { days: weekday, from: '17:00', to: '02:00', price_per_hour_kopecks: evening * 100 },
      { days: weekday, from: '02:00', to: '06:00', price_per_hour_kopecks: night * 100 },
      { days: weekend, from: '12:00', to: '17:00', price_per_hour_kopecks: weekendDay * 100 },
      { days: weekend, from: '17:00', to: '06:00', price_per_hour_kopecks: weekendEvening * 100 },
    ],
  }));
}

export const CLUBS = [
  {
    id: '11111111-1111-4111-8111-000000000001',
    club_id: 'cccccccc-cccc-4ccc-8ccc-000000000001',
    slug: 'svoyak',
    city_slug: 'ekaterinburg',
    name: 'Свояк',
    address: 'ул. Малышева, 51',
    status: 'platform',
    description: 'Зал на десять столов: восемь пирамид 12 футов и два пула. Играете по QR-коду на столе: оплатили — свет включился.',
    phone: '+7 343 000-00-01',
    online_booking: true,
    open_24h: false,
    hours: [{ days: [1, 2, 3, 4, 5, 6, 7], open: '12:00', close: '04:00' }],
    payment_methods: ['sbp', 'card', 'cash'],
    geo: { lat: 56.8389, lon: 60.6057 },
    resources: tables([['pyramid', 8], ['pool', 2]]),
    prices: priceRules({ pyramid: [450, 700, 500, 600, 800], pool: [350, 550, 400, 450, 650] }),
    reviews: [
      { id: 'r1', author: 'Шар_в_лузе', rating: 5, text: 'Сукно свежее, столы ровные. Оплатил по QR — свет загорелся через пару секунд, никого не звал.', created_at: '2026-10-12T17:20:00Z', reply: { text: 'Спасибо! Ждём снова.', created_at: '2026-10-12T19:00:00Z' } },
      { id: 'r2', author: 'Дуплет66', rating: 4, text: 'Хорошие кии, но вечером в пятницу без брони не попасть.', created_at: '2026-10-04T20:05:00Z', reply: null },
    ],
  },
  {
    id: '11111111-1111-4111-8111-000000000002',
    club_id: 'cccccccc-cccc-4ccc-8ccc-000000000002',
    slug: 'abrikol',
    city_slug: 'ekaterinburg',
    name: 'Абриколь',
    address: 'пр. Ленина, 24/8',
    status: 'platform',
    description: 'Круглосуточный клуб русской пирамиды. Шесть столов 12 футов.',
    phone: '+7 343 000-00-02',
    online_booking: true,
    open_24h: true,
    hours: [],
    payment_methods: ['sbp', 'card'],
    geo: { lat: 56.8397, lon: 60.6149 },
    resources: tables([['pyramid', 6]]),
    prices: priceRules({ pyramid: [400, 650, 450, 550, 750] }),
    reviews: [
      { id: 'r3', author: 'Ночная_смена', rating: 5, text: 'Единственное место, где можно спокойно поиграть в три часа ночи.', created_at: '2026-10-18T22:40:00Z', reply: null },
    ],
  },
  {
    id: '11111111-1111-4111-8111-000000000003',
    club_id: 'cccccccc-cccc-4ccc-8ccc-000000000003',
    slug: 'karambol',
    city_slug: 'ekaterinburg',
    name: 'Карамболь',
    address: 'ул. 8 Марта, 46',
    status: 'platform',
    description: 'Пул и снукер в центре. Шесть столов пула, один снукер и одна пирамида.',
    phone: '+7 343 000-00-03',
    online_booking: true,
    open_24h: false,
    hours: [{ days: [1, 2, 3, 4, 5], open: '14:00', close: '02:00' }, { days: [6, 7], open: '12:00', close: '04:00' }],
    payment_methods: ['sbp', 'card', 'cash'],
    geo: { lat: 56.8292, lon: 60.6031 },
    resources: tables([['pyramid', 1], ['snooker', 1], ['pool', 6]]),
    prices: priceRules({ pool: [300, 500, 350, 400, 600], snooker: [500, 800, 600, 700, 900], pyramid: [400, 650, 450, 550, 750] }),
    reviews: [],
  },
  {
    id: '11111111-1111-4111-8111-000000000004',
    club_id: 'cccccccc-cccc-4ccc-8ccc-000000000004',
    slug: 'rezerv',
    city_slug: 'ekaterinburg',
    name: 'Резерв',
    address: 'ул. Белинского, 86',
    status: 'claimed',
    description: 'Пять столов русской пирамиды.',
    phone: '+7 343 000-00-04',
    online_booking: false,
    open_24h: false,
    hours: [{ days: [1, 2, 3, 4, 5, 6, 7], open: '13:00', close: '02:00' }],
    payment_methods: ['cash', 'card'],
    geo: { lat: 56.8228, lon: 60.6142 },
    tables_count: 5,
    disciplines: ['pyramid'],
    price_day_kopecks: 40000,
    price_night_kopecks: 60000,
    prices: priceRules({ pyramid: [400, 600, 450, 500, 650] }),
    reviews: [],
  },
  {
    id: '11111111-1111-4111-8111-000000000005',
    club_id: 'cccccccc-cccc-4ccc-8ccc-000000000005',
    slug: 'duplet',
    city_slug: 'ekaterinburg',
    name: 'Дуплет',
    address: 'ул. Викулова, 33',
    status: 'listed',
    description: '',
    phone: '+7 343 000-00-05',
    online_booking: false,
    open_24h: false,
    hours: [{ days: [1, 2, 3, 4, 5, 6, 7], open: '12:00', close: '00:00' }],
    payment_methods: ['cash'],
    geo: null,
    tables_count: 4,
    disciplines: ['pool', 'snooker'],
    price_day_kopecks: 30000,
    price_night_kopecks: 45000,
    prices: [],
    reviews: [],
  },
  {
    id: '11111111-1111-4111-8111-000000000006',
    club_id: 'cccccccc-cccc-4ccc-8ccc-000000000006',
    slug: 'kiy',
    city_slug: 'chelyabinsk',
    name: 'Кий',
    address: 'ул. Кирова, 110',
    status: 'platform',
    description: 'Пирамида и пул на Кировке.',
    phone: '+7 351 000-00-06',
    online_booking: true,
    open_24h: false,
    hours: [{ days: [1, 2, 3, 4, 5, 6, 7], open: '12:00', close: '03:00' }],
    payment_methods: ['sbp', 'card', 'cash'],
    geo: { lat: 55.1644, lon: 61.4024 },
    resources: tables([['pyramid', 4], ['pool', 3]]),
    prices: priceRules({ pyramid: [350, 600, 400, 500, 700], pool: [300, 450, 350, 400, 550] }),
    reviews: [],
  },
];

const NICKS = [
  'Свояк_Урал', 'Шар_в_лузе', 'Дуплет66', 'Абриколь', 'Ночная_смена', 'Кикс', 'Карамболь_74', 'Пирамидон', 'Резка', 'Клапштос',
  'Накат', 'Оттяжка', 'Винт', 'Бортовой', 'Чужой_шар', 'Подставка', 'Кладка', 'Штаны', 'Разбой', 'Подрезка',
  'Прицел', 'Тихий_кий', 'Лузер', 'Боковой', 'Свободная',
];

export function levelOf(rating) {
  if (rating >= 1800) return 'Мастер';
  if (rating >= 1600) return 'Сильный';
  if (rating >= 1400) return 'Опытный';
  if (rating >= 1200) return 'Любитель';
  return 'Новичок';
}

export const PLAYERS = NICKS.map((nick, i) => {
  const rating = 1890 - i * 31 - (i % 3) * 7;
  const games = 140 - i * 4;
  return { nick, rating, games, wins: Math.round(games * (0.68 - i * 0.012)), city_slug: i % 4 === 3 ? 'chelyabinsk' : 'ekaterinburg', club_slug: i % 2 ? 'abrikol' : 'svoyak' };
});

const NOW = () => Date.now();
const DAY = 86_400_000;

function iso(ms) {
  return new Date(Math.round(ms / 600_000) * 600_000).toISOString();
}

export function tournaments() {
  const now = NOW();
  const p = (i) => ({ nick: PLAYERS[i].nick, rating: PLAYERS[i].rating, seed: i + 1 });
  return [
    {
      id: '22222222-2222-4222-8222-000000000001',
      title: 'Кубок «Свояка»: свободная пирамида',
      discipline: 'pyramid',
      format: 'single_elim',
      race_to: 3,
      starts_at: iso(now - 2 * 3600_000),
      timezone: TZ,
      status: 'running',
      entry_fee_kopecks: 100000,
      prize_fund_kopecks: 800000,
      seats: 8,
      entries: 8,
      rating_max: null,
      club_slug: 'svoyak',
      rules: 'Олимпийская система, матчи до 3 побед, партия до 8 шаров. Посев по рейтингу Бильярдум+.',
      bracket: {
        rounds: [
          { title: 'Четвертьфинал', matches: [
            { id: 'm1', a: p(0), b: p(7), score_a: 3, score_b: 1, status: 'done', winner: 'a', table: 1 },
            { id: 'm2', a: p(3), b: p(4), score_a: 2, score_b: 3, status: 'done', winner: 'b', table: 2 },
            { id: 'm3', a: p(2), b: p(5), score_a: 3, score_b: 0, status: 'done', winner: 'a', table: 3 },
            { id: 'm4', a: p(1), b: p(6), score_a: 3, score_b: 2, status: 'done', winner: 'a', table: 4 },
          ] },
          { title: 'Полуфинал', matches: [
            { id: 'm5', a: p(0), b: p(4), score_a: 2, score_b: 1, status: 'playing', winner: null, table: 1 },
            { id: 'm6', a: p(2), b: p(1), score_a: 0, score_b: 0, status: 'scheduled', winner: null, table: 2 },
          ] },
          { title: 'Финал', matches: [
            { id: 'm7', a: null, b: null, score_a: 0, score_b: 0, status: 'scheduled', winner: null, table: null },
          ] },
        ],
      },
    },
    {
      id: '22222222-2222-4222-8222-000000000002',
      title: 'Осенний турнир по пулу',
      discipline: 'pool',
      format: 'groups_playoff',
      race_to: 5,
      starts_at: iso(now + 3 * DAY),
      timezone: TZ,
      status: 'registration',
      entry_fee_kopecks: 150000,
      prize_fund_kopecks: null,
      seats: 16,
      entries: 9,
      rating_max: 1600,
      club_slug: 'karambol',
      rules: 'Группы по четыре, двое выходят в плей-офф. Матчи до 5 побед. Запись — для игроков с рейтингом пула до 1 600.',
      bracket: null,
    },
    {
      id: '22222222-2222-4222-8222-000000000003',
      title: 'Ночная пирамида',
      discipline: 'pyramid',
      format: 'single_elim',
      race_to: 2,
      starts_at: iso(now + 6 * DAY + 5 * 3600_000),
      timezone: TZ,
      status: 'registration',
      entry_fee_kopecks: 50000,
      prize_fund_kopecks: 300000,
      seats: 16,
      entries: 4,
      rating_max: 1400,
      club_slug: 'abrikol',
      rules: 'Олимпийская система, матчи до 2 побед. Для любителей: рейтинг пирамиды до 1 400.',
      bracket: null,
    },
    {
      id: '22222222-2222-4222-8222-000000000004',
      title: 'Открытие сезона',
      discipline: 'pyramid',
      format: 'single_elim',
      race_to: 3,
      starts_at: iso(now - 14 * DAY),
      timezone: TZ,
      status: 'finished',
      entry_fee_kopecks: 100000,
      prize_fund_kopecks: 500000,
      seats: 4,
      entries: 4,
      rating_max: null,
      club_slug: 'kiy',
      rules: 'Олимпийская система, матчи до 3 побед.',
      bracket: {
        rounds: [
          { title: 'Полуфинал', matches: [
            { id: 'f1', a: p(3), b: p(11), score_a: 3, score_b: 1, status: 'done', winner: 'a', table: 1 },
            { id: 'f2', a: p(7), b: p(15), score_a: 1, score_b: 3, status: 'done', winner: 'b', table: 2 },
          ] },
          { title: 'Финал', matches: [
            { id: 'f3', a: p(3), b: p(15), score_a: 3, score_b: 2, status: 'done', winner: 'a', table: 1 },
          ] },
        ],
      },
    },
  ];
}

/** Стабильный хеш строки → [0, 1). */
function hash01(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10_000) / 10_000;
}

/** Живое состояние стола без ПДн: меняется каждые 10 минут. */
export function liveStatus(club, resource, now = NOW()) {
  const slot = Math.floor(now / 600_000);
  const x = hash01(`${club.id}:${resource.number}:${slot}`);
  const slotEnd = (slot + 1) * 600_000;
  if (x < 0.5) return { status: 'busy', until: iso(slotEnd + Math.round(x * 12) * 600_000) };
  if (x < 0.58) return { status: 'free', next_booking: { starts_at: iso(slotEnd + 3 * 3600_000) } };
  if (x < 0.62) return { status: 'reserved', next_booking: { starts_at: iso(slotEnd + 600_000) } };
  if (x < 0.64) return { status: 'unavailable' };
  return { status: 'free' };
}
