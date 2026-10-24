/**
 * Экран оператора платформы и карточка клуба (M4, №133–136, №141): статусы словами, сводка оценок, действия.
 */

export const LISTING_STATUS = {
  listed: { word: 'В каталоге', tone: 'reserved', text: 'Карточка добавлена в каталог Бильярдума, но права на клуб не подтверждены. Гости бронируют по заявке.' },
  claimed: { word: 'Подтверждён', tone: 'free', text: 'Вы подтвердили права на клуб. Гости бронируют по заявке — подключите программу, чтобы бронь была живой.' },
  platform: { word: 'На платформе', tone: 'play', text: 'Клуб работает в программе Бильярдума: на странице живой план зала, свободные столы, цены и онлайн-бронь.' },
};

/** Средняя оценка: { avg: '4,0' (для экрана), value: 4, count } или null. */
export function ratingSummary(reviews) {
  const list = (reviews ?? []).filter((r) => Number.isFinite(r.rating));
  if (!list.length) return null;
  const avg = list.reduce((s, r) => s + r.rating, 0) / list.length;
  return { avg: avg.toFixed(1).replace('.', ','), value: Math.round(avg * 10) / 10, count: list.length };
}

export const PLATFORM_TABS = [
  ['requests', 'Заявки гостей'],
  ['leads', 'Заявки клубов'],
  ['listings', 'Карточки'],
  ['reports', 'Жалобы'],
  ['cities', 'Города'],
];

/** Разделы платформы со своим экраном (не список записей оператора): M5.3 «Клубы и подписки» — отдельный чанк. */
export const PLATFORM_SCREENS = [['billing', 'Клубы и подписки']];

/** Пояса России для справочника городов (IANA). */
export const RU_ZONES = [
  ['Europe/Kaliningrad', 'Калининград, МСК−1'],
  ['Europe/Moscow', 'Москва, МСК'],
  ['Europe/Samara', 'Самара, МСК+1'],
  ['Asia/Yekaterinburg', 'Екатеринбург, МСК+2'],
  ['Asia/Omsk', 'Омск, МСК+3'],
  ['Asia/Novosibirsk', 'Новосибирск, МСК+4'],
  ['Asia/Krasnoyarsk', 'Красноярск, МСК+4'],
  ['Asia/Irkutsk', 'Иркутск, МСК+5'],
  ['Asia/Yakutsk', 'Якутск, МСК+6'],
  ['Asia/Vladivostok', 'Владивосток, МСК+7'],
  ['Asia/Magadan', 'Магадан, МСК+8'],
  ['Asia/Kamchatka', 'Камчатка, МСК+9'],
];

/**
 * Ошибки формы города (как server/directory/cities.mjs): название, «в Перми» (с предлогом в/во/на), пояс.
 * @returns {Record<string, string>}
 */
export function cityErrors(c) {
  const e = {};
  if (String(c?.name ?? '').trim().length < 2) e.name = 'Укажите название города.';
  const nameIn = String(c?.name_in ?? '').trim();
  if (nameIn.length < 3 || !/^(в|во|на)\s/i.test(nameIn)) e.name_in = 'Как в фразе «клубы в Перми»: начните с «в», «во» или «на».';
  if (!RU_ZONES.some(([z]) => z === c?.timezone) && !/^[A-Za-z_]+\/[A-Za-z_]+$/.test(c?.timezone ?? '')) e.timezone = 'Выберите часовой пояс.';
  if (c?.slug && !/^[a-z0-9-]{2,60}$/.test(c.slug)) e.slug = 'Латиница, цифры и дефис.';
  return e;
}

/** Тело города для POST/PATCH: пустые необязательные поля не отправляем. */
export function cityBody(c, { create = false } = {}) {
  const out = { name: c.name.trim(), name_in: c.name_in.trim(), timezone: c.timezone };
  if (c.region?.trim()) out.region = c.region.trim();
  if (create && c.slug?.trim()) out.slug = c.slug.trim();
  if (typeof c.active === 'boolean') out.active = c.active;
  return out;
}

/** Статусы и действия по видам записей оператора (как у server/directory: requests, leads, listings, reports). */
export const PLATFORM_FLOW = {
  requests: {
    field: 'status',
    words: { sent: 'Ждёт клуб', operator: 'У оператора', accepted: 'Клуб принял', declined: 'Клуб отказал', closed: 'Закрыта' },
    tones: { sent: 'reserved', operator: 'alert', accepted: 'free', declined: 'reserved', closed: 'reserved' },
    actions: {
      sent: [['accepted', 'Клуб принял'], ['declined', 'Клуб отказал']],
      operator: [['accepted', 'Клуб принял'], ['declined', 'Клуб отказал'], ['closed', 'Закрыть']],
      accepted: [],
      declined: [],
      closed: [],
    },
  },
  leads: {
    field: 'status',
    words: { new: 'Новая', contacted: 'Связались', demo: 'Показ', won: 'Подключаем', lost: 'Отказ', spam: 'Спам' },
    tones: { new: 'alert', contacted: 'play', demo: 'play', won: 'free', lost: 'reserved', spam: 'reserved' },
    actions: { new: [['contacted', 'Связались'], ['spam', 'Спам']], contacted: [['demo', 'Показ'], ['won', 'Подключаем'], ['lost', 'Отказ']], demo: [['won', 'Подключаем'], ['lost', 'Отказ']], won: [], lost: [], spam: [] },
  },
  listings: {
    field: 'status',
    words: { new: 'На проверке', approved: 'Принята', rejected: 'Отклонена' },
    tones: { new: 'alert', approved: 'free', rejected: 'reserved' },
    actions: { new: [['approved', 'Принять'], ['rejected', 'Отклонить']], approved: [], rejected: [] },
  },
  reports: {
    field: 'status',
    words: { new: 'Новая', hidden: 'Отзыв скрыт', kept: 'Отзыв оставлен' },
    tones: { new: 'alert', hidden: 'reserved', kept: 'free' },
    actions: { new: [['hidden', 'Скрыть отзыв'], ['kept', 'Оставить']], hidden: [], kept: [] },
  },
};

/** Ответ гостю на заявку (T25) — текст причины уходит гостю в уведомление; для лидов — заметка. */
export function actNeedsDialog(kind, value) {
  return kind === 'requests' || kind === 'leads' || needsReason(value);
}

/** Действие требует причины (отказ, скрытие, отклонение — в журнал платформы). */
export function needsReason(value) {
  return ['rejected', 'hidden', 'declined'].includes(value);
}

/** Открытых записей во вкладке — для счётчика. */
export function openCount(kind, items) {
  if (kind === 'cities') return 0;
  const open = { requests: ['operator', 'sent'], leads: ['new'], listings: ['new'], reports: ['new'] }[kind] ?? [];
  const field = PLATFORM_FLOW[kind]?.field ?? 'status';
  return (items ?? []).filter((x) => open.includes(x[field])).length;
}
