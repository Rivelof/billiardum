/**
 * M5.5 «Сети» (docs/contracts/m5-5-8.md №190–194, server/networks/README.md): слова, проверки форм и вид ответов
 * для экрана «Сеть», шаблонов тарифов и меню сети и вкладки «Сеть» дашборда.
 * Без JSX и DOM — тестируется в Node (test/networks.test.mjs).
 *
 * Деньги — копейки, время — ISO UTC, даты периода — YYYY-MM-DD; форматирует клиент.
 */

import { formatDate, formatMoney } from '@billiardum/shared/format';
import { spanText, TYPE_WORD } from './tariffs.js';
import { parseRubles } from './cash.js';
import { NAME_MAX, isLive, isNetworkManager, productsWord, withReason } from './networkBase.js';

export * from './networkBase.js';

/** Разделы экрана «Сеть»; управляющим сети — без раздела «Управляющие» (список видит только владелец). */
export const SECTIONS = Object.freeze([
  { value: 'clubs', label: 'Клубы' },
  { value: 'managers', label: 'Управляющие' },
  { value: 'tariffs', label: 'Тарифы' },
  { value: 'menu', label: 'Меню' },
]);
export const sectionsFor = (role) => SECTIONS.filter((s) => role === 'owner' || s.value !== 'managers');

export const MODE_LABEL = Object.freeze({ soft: 'Мягкий', hard: 'Жёсткий' });

/** Что значит режим шаблона — для подписи у переключателя (№191). */
export const MODE_HINT = Object.freeze({
  tariffs: {
    soft: 'Клуб может сохранить свои тарифы. Тогда шаблон сети его больше не меняет, пока клуб сам не вернётся к шаблону.',
    hard: 'Клубы не меняют тарифы сами: всё задаёт шаблон сети. Клубы со своими тарифами вернутся к шаблону.',
  },
  menu: {
    soft: 'Клуб может поменять у себя цену или название товара шаблона. Такой товар шаблон больше не меняет. Признак алкоголя клуб не снимает.',
    hard: 'Клубы не меняют поля товаров шаблона: название, цену, категорию, алкоголь, НДС. Стоп-лист, склад, фото и модификаторы клуб ведёт сам.',
  },
});

export const CLUB_MODE_LABEL = Object.freeze({ live: 'Боевой режим', test: 'Тестовый режим', suspended: 'Приостановлен' });

/**
 * Что можно человеку на экране сети.
 * @param {{ role?: string }} network ответ GET /api/networks/{id} (role — owner | manager)
 * @param {string|null} principal session | pin
 */
export function networkRights(network, principal) {
  const pin = principal === 'pin';
  const owner = network?.role === 'owner';
  return { pin, owner, edit: owner && !pin };
}

/** Ошибка названия сети (1–100 символов после обрезки пробелов) или null. */
export function networkNameError(name) {
  const v = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!v) return 'Напишите название сети, например «Сеть Урал».';
  if (v.length > NAME_MAX) return `Название — до ${NAME_MAX} символов.`;
  return null;
}
export const cleanName = (name) => String(name ?? '').replace(/\s+/g, ' ').trim();

/**
 * Клубы, которых коснётся новая версия шаблона тарифов: «жёсткий» — все, «мягкий» — кроме переопределивших.
 * Боевые среди них требуют причину.
 */
export function tariffTouched(clubs, mode) {
  return (Array.isArray(clubs) ? clubs : []).filter((c) => mode === 'hard' || !c.override);
}
export const liveTouched = (clubs) => clubs.filter(isLive);

/** Свои клубы владельца, которые ещё не в этой сети (кандидаты «Добавить клуб»). */
export function addableClubs(memberships, network) {
  const inNet = new Set((network?.clubs ?? []).map((c) => c.club_id));
  return (Array.isArray(memberships) ? memberships : []).filter((m) => m.role === 'owner' && !isNetworkManager(m) && !inNet.has(m.club_id));
}

/**
 * Что случится с клубом при добавлении в сеть (POST /api/networks/{id}/clubs): шаблоны сети применяются сразу —
 * тарифы заменяют тарифы клуба, товары шаблона меню записываются в каталог. Клуб в боевом режиме — ручное действие
 * с причиной (инвариант 8).
 * @param {{ tariffs?: { template?: boolean }, menu?: { template?: boolean } }} network GET /api/networks/{id}
 * @param {{ live?: boolean, mode?: string } | null} club членство из GET /api/me
 * @returns {{ tariffs: boolean, menu: boolean, live: boolean, reasonNeeded: boolean, warning: string | null }}
 */
export function addClubPlan(network, club) {
  const tariffs = network?.tariffs?.template === true;
  const menu = network?.menu?.template === true;
  const live = isLive(club);
  let warning = null;
  if (tariffs && menu) warning = 'Клуб сразу получит шаблоны сети: его тарифы будут заменены тарифами шаблона, а товары шаблона меню запишутся в его меню.';
  else if (tariffs) warning = 'Клуб сразу получит шаблон тарифов сети: его нынешние тарифы будут заменены.';
  else if (menu) warning = 'Клуб сразу получит шаблон меню сети: товары шаблона запишутся в его меню.';
  return { tariffs, menu, live, reasonNeeded: live && (tariffs || menu), warning };
}

/**
 * Ошибка добавления клуба в сеть словами: клуб не добавлен ни при какой из них.
 * 400 reason_required — нужна причина (клуб в боевом режиме); 400 tariff_gap | tariff_overlap { club_id, … } — шаблон
 * тарифов не покрывает неделю клуба; 409 duplicate { field, value } — артикул или название товара шаблона занят в меню клуба.
 * @returns {{ error: unknown, clubName: string | null, hint: string | null, needReason: boolean }}
 */
export function addClubError(err, clubName = null) {
  const code = err?.code;
  if (code === 'reason_required') return { error: err, clubName: null, hint: 'Клуб не добавлен. Напишите причину: клуб в боевом режиме, владелец получит уведомление.', needReason: true };
  if (code === 'tariff_gap' || code === 'tariff_overlap') {
    const where = problemText({ ...err.data, type: code === 'tariff_overlap' ? 'overlap' : 'gap' });
    return { error: err, clubName, hint: `Клуб не добавлен, тарифы не изменены. ${where ? `${where} ` : ''}Дополните шаблон тарифов сети: он должен покрывать всю неделю клуба.`, needReason: false };
  }
  const dup = menuDuplicate(err, clubName);
  if (dup) return { ...dup, hint: 'Клуб не добавлен, меню не изменено.', needReason: false };
  return { error: err, clubName: null, hint: null, needReason: false };
}

/**
 * 409 duplicate { club_id, field: 'sku' | 'name', value } при записи шаблона меню в клуб (PUT меню, добавление клуба):
 * ошибка с кодом network_menu_duplicate и тем, что совпало (артикул или название); иначе null.
 * @returns {{ error: { code: string, data: object }, clubName: string | null } | null}
 */
export function menuDuplicate(err, clubName = null) {
  if (err?.code !== 'duplicate' || !['sku', 'name'].includes(err?.data?.field)) return null;
  return { error: { code: 'network_menu_duplicate', data: err.data }, clubName: clubName ?? null };
}

/** Сеть для экрана: из адреса, затем сеть клуба (управляющий сети), затем первая. */
export function pickNetwork(networks, membership, wanted) {
  const list = Array.isArray(networks) ? networks : [];
  return list.find((n) => n.network_id === wanted) ?? list.find((n) => n.network_id === membership?.network_id) ?? list[0] ?? null;
}

/** Телефон управляющего → E.164 или null (как у приглашения персонала). */
export { normalizePhone } from '@billiardum/shared/booking';

/** Строка управляющего: «Приглашён, ждём входа до 1 ноября» или «Управляющий сети с 21 октября». */
export function managerStatusText(m, timeZone) {
  if (m?.status === 'active') return m.accepted_at ? `Управляющий сети с ${formatDate(m.accepted_at, timeZone)}` : 'Управляющий сети';
  return m?.expires_at ? `Приглашён, ждём первого входа до ${formatDate(m.expires_at, timeZone)}` : 'Приглашён, ждём первого входа';
}

/** Проблема недели клуба (problem шаблона) словами: «В среду с 02:00 до 06:00 нет цены · пул». */
export function problemText(problem) {
  if (!problem || !problem.weekday) return null;
  // Весь день (from = to): «В понедельник нет цены ни на один час»
  const whole = problem.from && problem.from === problem.to;
  const base = whole ? `${spanText(problem, problem.type === 'overlap' ? 'overlap' : 'gap').split(' с ')[0]} ${problem.type === 'overlap' ? 'весь день задано две цены' : 'нет цены ни на один час'}.` : spanText(problem, problem.type === 'overlap' ? 'overlap' : 'gap');
  // M5.8: корты — свои правила слота (kind: 'padel_court')
  if (problem.kind === 'padel_court') return `${base.slice(0, -1)} · корты.`;
  return TYPE_WORD[problem.kind] ? `${base.slice(0, -1)} · ${TYPE_WORD[problem.kind].toLowerCase()}.` : base;
}

/** Состояние тарифов клуба в шаблоне: слово и тон (бейдж всегда со словом, DESIGN §2). */
export function clubTariffState(c, mode) {
  if (c?.problem) return { tone: 'alert', icon: 'alert', text: 'Неделя не покрыта' };
  if (c?.override && mode !== 'hard') return { tone: 'lamp', icon: 'edit', text: 'Изменено в клубе' };
  return { tone: 'free', icon: 'check', text: 'По шаблону' };
}

// ---------- шаблон меню ----------

const UNITS = ['шт', 'порц', 'л', 'мл', 'кг', 'г'];
const SKU = /^[0-9A-Za-z._/-]{1,64}$/;

export const emptyProductForm = () => ({ key: `n${Math.random().toString(36).slice(2, 9)}`, id: null, category: '', name: '', sku: '', price: '', unit: 'шт', is_alcohol: false, vat_code: '', payment_subject: 'commodity', description: '', active: true, sort: 0 });

/** Товар шаблона → форма (цена рублями с запятой). */
export function productToForm(p, i = 0) {
  return {
    key: p.id ?? `n${i}`,
    id: p.id ?? null,
    category: p.category ?? '',
    name: p.name ?? '',
    sku: p.sku ?? '',
    price: Number.isSafeInteger(p.price_kopecks) ? String(p.price_kopecks / 100).replace('.', ',') : '',
    unit: UNITS.includes(p.unit) ? p.unit : 'шт',
    is_alcohol: Boolean(p.is_alcohol),
    vat_code: p.vat_code === null || p.vat_code === undefined ? '' : String(p.vat_code),
    payment_subject: p.payment_subject ?? (p.is_alcohol ? 'excise' : 'commodity'),
    description: p.description ?? '',
    active: p.active !== false,
    sort: Number.isSafeInteger(p.sort) ? p.sort : i,
  };
}

/** Ошибки формы товара шаблона по правилам сервера (normalizeProducts) — { поле: текст }. */
export function productFormErrors(f) {
  const e = {};
  const name = String(f.name ?? '').trim();
  if (!name) e.name = 'Напишите название товара.';
  else if (name.length > 128) e.name = 'Название — до 128 символов.';
  if (String(f.category ?? '').trim().length > 100) e.category = 'Категория — до 100 символов.';
  const price = parseRubles(String(f.price ?? ''));
  if (!price || price > 100_000_000) e.price = 'Укажите цену больше нуля, например 250 или 120,50.';
  const sku = String(f.sku ?? '').trim();
  if (sku && !SKU.test(sku)) e.sku = 'Артикул — латинские буквы, цифры, точка, дефис, косая черта; до 64 знаков.';
  if (String(f.description ?? '').trim().length > 500) e.description = 'Описание — до 500 символов.';
  if (!UNITS.includes(f.unit)) e.unit = 'Выберите единицу.';
  return e;
}

/** Форма → товар тела PUT /api/networks/{id}/menu. */
export function productFromForm(f, sort = 0) {
  const vat = f.vat_code === '' || f.vat_code === null || f.vat_code === undefined ? null : Number(f.vat_code);
  const out = {
    ...(f.id ? { id: f.id } : {}),
    name: String(f.name).trim(),
    price_kopecks: parseRubles(String(f.price ?? '')),
    category: String(f.category ?? '').trim() || null,
    sku: String(f.sku ?? '').trim() || null,
    unit: f.unit,
    is_alcohol: Boolean(f.is_alcohol),
    vat_code: Number.isInteger(vat) && vat >= 1 && vat <= 12 ? vat : null,
    payment_subject: f.is_alcohol ? 'excise' : f.payment_subject === 'excise' ? 'commodity' : (f.payment_subject ?? 'commodity'),
    description: String(f.description ?? '').trim() || null,
    sort,
    active: f.active !== false,
  };
  return out;
}

/**
 * Повторы в шаблоне: одинаковые «категория + название» или артикул среди продаваемых — индексы через запятую.
 * @returns {string|null} текст ошибки
 */
export function duplicateError(forms) {
  const seen = new Map();
  for (const f of forms) {
    if (f.active === false) continue;
    const key = `${String(f.category ?? '').trim().toLowerCase()}|${String(f.name ?? '').trim().toLowerCase()}`;
    if (seen.has(key)) return `«${String(f.name).trim()}» повторяется в одной категории. Оставьте один товар.`;
    seen.set(key, true);
    const sku = String(f.sku ?? '').trim();
    if (sku) {
      if (seen.has(`sku:${sku}`)) return `Артикул ${sku} повторяется. У каждого товара — свой артикул.`;
      seen.set(`sku:${sku}`, true);
    }
  }
  return null;
}

/** Тело шаблона меню: товары по порядку списка. */
export function menuBody(forms, reason) {
  return withReason({ products: forms.map((f, i) => productFromForm(f, i)) }, reason);
}

/** Товары шаблона по категориям (в порядке первого появления), внутри — по sort. */
export function groupByCategory(products) {
  const order = [];
  const map = new Map();
  for (const p of [...(Array.isArray(products) ? products : [])].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))) {
    const c = String(p.category ?? '').trim() || 'Без категории';
    if (!map.has(c)) {
      map.set(c, []);
      order.push(c);
    }
    map.get(c).push(p);
  }
  return order.map((name) => ({ name, items: map.get(name) }));
}

export const priceText = (kopecks) => (Number.isSafeInteger(kopecks) ? formatMoney(kopecks) : '—');

/** Состояние меню клуба в шаблоне: «Как в сети» или «Изменено клубом: 2 товара». */
export function clubMenuState(c, version) {
  const behind = Number.isInteger(version) && Number.isInteger(c?.applied_version) && c.applied_version < version;
  if (c?.overrides > 0) return { tone: 'lamp', icon: 'edit', text: `Изменено клубом: ${productsWord(c.overrides)}` };
  if (behind) return { tone: 'pending', icon: 'clock', text: 'Ещё не получил новую версию' };
  return { tone: 'free', icon: 'check', text: 'Как в сети' };
}

