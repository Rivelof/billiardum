/**
 * «Подключить клуб» (M5.1, №152): форма создания клуба без выезда. Чистые функции, без DOM.
 *
 * POST /api/clubs { name, city_id | city_name, timezone, listing_id? } → { club_id, mode: 'test' }; 409 clubs_limit.
 * Часовой пояс подставляется по городу: из справочника (city.timezone), иначе по таблице ниже; владелец может поправить.
 */

/** Часовые пояса России (IANA) — для выбора; подпись — город и смещение от Москвы. */
export const RU_ZONES = Object.freeze([
  ['Europe/Kaliningrad', 'Калининград (МСК−1)'],
  ['Europe/Moscow', 'Москва (МСК)'],
  ['Europe/Volgograd', 'Волгоград (МСК)'],
  ['Europe/Samara', 'Самара (МСК+1)'],
  ['Europe/Saratov', 'Саратов (МСК+1)'],
  ['Europe/Ulyanovsk', 'Ульяновск (МСК+1)'],
  ['Europe/Astrakhan', 'Астрахань (МСК+1)'],
  ['Asia/Yekaterinburg', 'Екатеринбург (МСК+2)'],
  ['Asia/Omsk', 'Омск (МСК+3)'],
  ['Asia/Novosibirsk', 'Новосибирск (МСК+4)'],
  ['Asia/Barnaul', 'Барнаул (МСК+4)'],
  ['Asia/Tomsk', 'Томск (МСК+4)'],
  ['Asia/Novokuznetsk', 'Новокузнецк (МСК+4)'],
  ['Asia/Krasnoyarsk', 'Красноярск (МСК+4)'],
  ['Asia/Irkutsk', 'Иркутск (МСК+5)'],
  ['Asia/Chita', 'Чита (МСК+6)'],
  ['Asia/Yakutsk', 'Якутск (МСК+6)'],
  ['Asia/Vladivostok', 'Владивосток (МСК+7)'],
  ['Asia/Sakhalin', 'Сахалин (МСК+8)'],
  ['Asia/Magadan', 'Магадан (МСК+8)'],
  ['Asia/Kamchatka', 'Камчатка (МСК+9)'],
]);
const ZONE_IDS = new Set(RU_ZONES.map(([z]) => z));

/** Крупные города → пояс, если справочник городов пояса не прислал. */
const CITY_TZ = {
  москва: 'Europe/Moscow',
  'санкт-петербург': 'Europe/Moscow',
  петербург: 'Europe/Moscow',
  казань: 'Europe/Moscow',
  'нижний новгород': 'Europe/Moscow',
  'ростов-на-дону': 'Europe/Moscow',
  краснодар: 'Europe/Moscow',
  сочи: 'Europe/Moscow',
  воронеж: 'Europe/Moscow',
  ярославль: 'Europe/Moscow',
  тула: 'Europe/Moscow',
  калининград: 'Europe/Kaliningrad',
  волгоград: 'Europe/Volgograd',
  самара: 'Europe/Samara',
  тольятти: 'Europe/Samara',
  ижевск: 'Europe/Samara',
  саратов: 'Europe/Saratov',
  ульяновск: 'Europe/Ulyanovsk',
  астрахань: 'Europe/Astrakhan',
  екатеринбург: 'Asia/Yekaterinburg',
  челябинск: 'Asia/Yekaterinburg',
  пермь: 'Asia/Yekaterinburg',
  уфа: 'Asia/Yekaterinburg',
  тюмень: 'Asia/Yekaterinburg',
  оренбург: 'Asia/Yekaterinburg',
  курган: 'Asia/Yekaterinburg',
  'нижний тагил': 'Asia/Yekaterinburg',
  магнитогорск: 'Asia/Yekaterinburg',
  сургут: 'Asia/Yekaterinburg',
  омск: 'Asia/Omsk',
  новосибирск: 'Asia/Novosibirsk',
  барнаул: 'Asia/Barnaul',
  томск: 'Asia/Tomsk',
  кемерово: 'Asia/Novokuznetsk',
  новокузнецк: 'Asia/Novokuznetsk',
  красноярск: 'Asia/Krasnoyarsk',
  иркутск: 'Asia/Irkutsk',
  'улан-удэ': 'Asia/Irkutsk',
  чита: 'Asia/Chita',
  якутск: 'Asia/Yakutsk',
  владивосток: 'Asia/Vladivostok',
  хабаровск: 'Asia/Vladivostok',
  'южно-сахалинск': 'Asia/Sakhalin',
  магадан: 'Asia/Magadan',
  'петропавловск-камчатский': 'Asia/Kamchatka',
};

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/ё/g, 'е').replace(/^г\.\s*/, '').replace(/\s+/g, ' ');

/** Справочник городов (GET /api/public/cities → { items }) → [{ id?, slug?, name, timezone? }]. */
export function cityList(res) {
  const items = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
  return items.filter((c) => typeof c?.name === 'string' && c.name.trim()).map((c) => ({ id: c.id ?? null, slug: c.slug ?? null, name: c.name.trim(), timezone: ZONE_IDS.has(c.timezone) ? c.timezone : null }));
}

/** Город из справочника по введённому названию (без регистра и «г.»). */
export const findCity = (name, cities) => cities.find((c) => norm(c.name) === norm(name)) ?? null;

/** Пояс по городу: справочник, затем таблица крупных городов. Не знаем — null (выберет владелец). */
export function tzForCity(name, cities = []) {
  const c = findCity(name, cities);
  if (c?.timezone) return c.timezone;
  return CITY_TZ[norm(name)] ?? null;
}

/** Подтверждённые карточки пользователя (M4, «Подтвердить клуб»), которые можно связать с новым клубом. */
export function approvedListings(res) {
  const items = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
  return items
    .filter((c) => c?.status === 'approved' && c?.listing?.id && !c.listing.club_id)
    .map((c) => ({ id: c.listing.id, name: c.listing.name ?? 'Карточка клуба', city: c.listing.city ?? null, timezone: ZONE_IDS.has(c.listing.timezone) ? c.listing.timezone : null }));
}

/** Ошибки формы по полям. */
export function clubStartErrors(form) {
  const errors = {};
  const name = String(form.name ?? '').trim();
  if (name.length < 2 || name.length > 100) errors.name = 'Название — от 2 до 100 символов, как его знают гости.';
  const city = String(form.city ?? '').trim();
  if (city.length < 2 || city.length > 100) errors.city = 'Укажите город клуба.';
  if (!ZONE_IDS.has(form.timezone)) errors.timezone = 'Выберите часовой пояс клуба: по нему считаются тарифы и время игры.';
  return errors;
}

/** Тело POST /api/clubs: город из справочника — city_id (или slug, если id нет), иначе — название. */
export function clubStartBody(form, cities = []) {
  const body = { name: String(form.name).trim(), timezone: form.timezone };
  const c = findCity(form.city, cities);
  if (c?.id) body.city_id = c.id;
  else body.city_name = c?.name ?? String(form.city).trim();
  if (form.listing_id) body.listing_id = form.listing_id;
  return body;
}
