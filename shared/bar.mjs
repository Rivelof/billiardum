/**
 * Бильярдум — бар: меню, модификаторы, корзина и статусы заказов (контракт M2 §3–§4). Без зависимостей,
 * общий для web/guest (заказ со стола) и web/admin (касса, экран бара). Деньги — целые копейки (инвариант 10).
 *
 *   const menu = normalizeMenu(await api.get(`/clubs/${club}/menu`));
 *   let cart = emptyCart();
 *   cart = addProduct(cart, product, defaultModifiers(product));
 *   cartTotals(cart)          → { count: 1, subtotal_kopecks: 18000 }
 *   orderItems(cart)          → [{ product_id, qty: 1, modifier_ids: [...] }]
 */

/** Статусы заказа по контракту §3. */
export const ORDER_STATUSES = Object.freeze(['new', 'preparing', 'ready', 'served', 'canceled']);

/** Следующий статус одним касанием на экране бара (§4: preparing → ready → served). */
export const ORDER_NEXT = Object.freeze({ new: 'preparing', preparing: 'ready', ready: 'served' });

/** Статус словом: гостю и бару — по-разному («Принят» у гостя — «Новый» у бара). */
export const ORDER_WORD = Object.freeze({
  guest: { new: 'Принят', preparing: 'Готовится', ready: 'Готов, несём к столу', served: 'Выдан', canceled: 'Отменён' },
  staff: { new: 'Новый', preparing: 'Готовится', ready: 'Готов', served: 'Выдан', canceled: 'Отменён' },
});

/** Кнопка следующего статуса на экране бара: говорит, что произойдёт. */
export const ORDER_ACTION = Object.freeze({ new: 'Начать готовить', preparing: 'Готово', ready: 'Выдан гостю' });

/**
 * @param {string} status
 * @param {'guest' | 'staff'} [audience]
 */
export function orderWord(status, audience = 'guest') {
  return ORDER_WORD[audience === 'staff' ? 'staff' : 'guest'][status] ?? 'Принят';
}

/** Заказ ещё в работе у бара (виден в очереди и у гостя как текущий). */
export function orderActive(order) {
  return ['new', 'preparing', 'ready'].includes(order?.status);
}

const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const byOrder = (a, b) => num(a.sort, 1e9) - num(b.sort, 1e9) || String(a.name).localeCompare(String(b.name), 'ru');

/**
 * Меню из ответа `GET /api/clubs/{club}/menu` в один вид. Принимаются оба вида ответа сервера:
 *   - товары внутри категорий: `categories: [{ id, name, products: [...] }]` (menuFor backend-pos);
 *   - плоский каталог: `categories`, `products` с `modifier_group_ids` и общий `modifier_groups` (каталог управляющего).
 * Группы модификаторов: `min_select`/`max_select` (или `required`/`max`), вариант по умолчанию — `is_default` (или `default`).
 * @param {object} raw
 * @returns {{ categories: object[], products: object[], groups: object[], byId: Map<string, object>, settings: object, alcoholHidden: boolean }}
 */
export function normalizeMenu(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const groups = (Array.isArray(src.modifier_groups) ? src.modifier_groups : []).map(normalizeGroup);
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const cats = Array.isArray(src.categories) ? src.categories : [];
  const nested = cats.flatMap((c, i) => (Array.isArray(c?.products) ? c.products.map((p) => ({ category_id: c.id ?? null, ...p, sort: num(p.sort, i * 1000 + c.products.indexOf(p)) })) : []));
  const flat = Array.isArray(src.products) ? src.products : [];
  const products = [...flat, ...nested]
    .filter((p) => p && typeof p.id === 'string' && Number.isSafeInteger(p.price_kopecks) && p.active !== false)
    .map((p) => {
      const refs = Array.isArray(p.modifier_groups) ? p.modifier_groups : Array.isArray(p.modifier_group_ids) ? p.modifier_group_ids : [];
      const own = refs.map((g) => (typeof g === 'string' ? groupById.get(g) : normalizeGroup(g))).filter(Boolean);
      return {
        ...p,
        category_id: p.category_id ?? null,
        name: String(p.name ?? 'Товар'),
        stop_list: Boolean(p.stop_list),
        is_alcohol: Boolean(p.is_alcohol),
        stock_qty: Number.isFinite(p.stock_qty) ? p.stock_qty : null,
        modifier_groups: own,
      };
    })
    .sort(byOrder);
  const used = new Set(products.map((p) => p.category_id));
  const categories = cats
    .filter((c) => c && c.active !== false && used.has(c.id ?? null))
    .map((c) => ({ id: c.id ?? null, name: String(c.name ?? 'Другое'), sort: c.sort }))
    .sort((a, b) => (a.id === null) - (b.id === null) || num(a.sort, 1e9) - num(b.sort, 1e9) || cats.indexOf(a) - cats.indexOf(b));
  if (products.some((p) => !categories.some((c) => c.id === p.category_id))) {
    // Товар без своей категории или с неактивной — в «Другое» (как у сервера)
    for (const p of products) if (!categories.some((c) => c.id === p.category_id)) p.category_id = null;
    if (!categories.some((c) => c.id === null)) categories.push({ id: null, name: 'Другое', sort: 1e9 });
  }
  return {
    categories,
    products,
    groups,
    byId: new Map(products.map((p) => [p.id, p])),
    settings: src.settings ?? {},
    alcoholHidden: Boolean(src.alcohol_hidden),
  };
}

function normalizeGroup(g) {
  const modifiers = (Array.isArray(g?.modifiers) ? g.modifiers : [])
    .filter((m) => m && typeof m.id === 'string' && m.active !== false)
    .map((m) => ({
      ...m,
      name: String(m.name ?? ''),
      price_delta_kopecks: Number.isSafeInteger(m.price_delta_kopecks) ? m.price_delta_kopecks : 0,
      default: Boolean(m.default ?? m.is_default),
    }));
  const minRaw = Number.isFinite(g?.min_select) ? g.min_select : Number.isFinite(g?.min) ? g.min : g?.required ? 1 : 0;
  const min = Math.max(0, minRaw);
  const maxRaw = Number.isFinite(g?.max_select) ? g.max_select : Number.isFinite(g?.max) ? g.max : min >= 1 ? 1 : modifiers.length || 1;
  const max = Math.max(min, 1, maxRaw);
  return { ...g, id: String(g?.id ?? ''), name: String(g?.name ?? ''), required: min >= 1, min, max, modifiers };
}

/**
 * Товар можно заказать: не в стоп-листе и сервер не сказал `available: false`. Остаток на складе продажу не запрещает
 * (у сервера это настройка клуба pos_stop_at_zero — тогда он сам пришлёт available: false).
 */
export function available(product) {
  return Boolean(product) && !product.stop_list && product.available !== false;
}

/** Почему нельзя заказать — словом (статус не только цветом). */
export function unavailableWord(product) {
  if (!product) return 'Нет в меню';
  if (product.stop_list) return 'Стоп-лист';
  if (product.available === false) return 'Закончился';
  return null;
}

/**
 * Выбор по умолчанию: в обязательных группах на один вариант — вариант с `default`, иначе первый.
 * @param {object} product товар из normalizeMenu
 * @returns {string[]} id модификаторов
 */
export function defaultModifiers(product) {
  const out = [];
  for (const g of product?.modifier_groups ?? []) {
    if (g.min < 1 || !g.modifiers.length) continue;
    const pick = g.modifiers.find((m) => m.default) ?? g.modifiers[0];
    out.push(pick.id);
  }
  return out;
}

/**
 * Нажатие на вариант: в группе на один вариант — как радио (обязательную нельзя снять),
 * в группе на несколько — как флажок, но не больше max.
 * @param {object} product
 * @param {string[]} selected
 * @param {string} groupId
 * @param {string} modifierId
 * @returns {string[]}
 */
export function toggleModifier(product, selected, groupId, modifierId) {
  const g = product?.modifier_groups?.find((x) => x.id === groupId);
  if (!g || !g.modifiers.some((m) => m.id === modifierId)) return selected;
  const inGroup = new Set(g.modifiers.map((m) => m.id));
  const current = selected.filter((id) => inGroup.has(id));
  const rest = selected.filter((id) => !inGroup.has(id));
  const on = current.includes(modifierId);
  if (g.max === 1) {
    if (on) return g.min >= 1 ? selected : rest;
    return [...rest, modifierId];
  }
  if (on) return current.length <= g.min ? selected : selected.filter((id) => id !== modifierId);
  if (current.length >= g.max) return selected;
  return [...selected, modifierId];
}

/**
 * Проверка выбора модификаторов перед добавлением в корзину.
 * @returns {{ ok: boolean, errors: { group_id: string, code: 'required' | 'too_many', text: string }[] }}
 */
export function validateModifiers(product, selected) {
  const errors = [];
  for (const g of product?.modifier_groups ?? []) {
    const n = g.modifiers.filter((m) => selected.includes(m.id)).length;
    if (n < g.min) errors.push({ group_id: g.id, code: 'required', text: `Выберите: ${g.name.toLowerCase()}.` });
    if (n > g.max) errors.push({ group_id: g.id, code: 'too_many', text: `${g.name}: не больше ${g.max}.` });
  }
  return { ok: errors.length === 0, errors };
}

/** Выбранные модификаторы товара в порядке групп меню. */
export function pickedModifiers(product, selected) {
  const out = [];
  for (const g of product?.modifier_groups ?? []) {
    for (const m of g.modifiers) if (selected.includes(m.id)) out.push({ id: m.id, name: m.name, price_delta_kopecks: m.price_delta_kopecks, group_id: g.id });
  }
  return out;
}

/** Цена одной штуки с модификаторами, копейки. */
export function unitPrice(product, selected = []) {
  return product.price_kopecks + pickedModifiers(product, selected).reduce((s, m) => s + m.price_delta_kopecks, 0);
}

/** Ключ строки корзины: один товар с одинаковыми модификаторами складывается в одну строку. */
export function lineKey(productId, modifierIds = []) {
  return `p:${productId}|${[...modifierIds].sort().join(',')}`;
}

/** Модификаторы строкой для корзины, чека и экрана бара: «0,4 л, без сахара». */
export function modifiersText(modifiers) {
  return (Array.isArray(modifiers) ? modifiers : [])
    .map((m) => (typeof m === 'string' ? m : m?.name))
    .filter(Boolean)
    .join(', ');
}

/** @returns {{ lines: object[] }} */
export function emptyCart() {
  return { lines: [] };
}

const MAX_QTY = 99;

/**
 * Добавить товар. Строка корзины: { key, kind: 'product', product_id, name, qty, modifier_ids, modifiers, unit_kopecks }.
 * @param {{ lines: object[] }} cart
 * @param {object} product товар из normalizeMenu
 * @param {string[]} [modifierIds]
 * @param {number} [qty]
 */
export function addProduct(cart, product, modifierIds = [], qty = 1) {
  const key = lineKey(product.id, modifierIds);
  const existing = cart.lines.find((l) => l.key === key);
  if (existing) return setQty(cart, key, existing.qty + qty);
  const line = {
    key,
    kind: 'product',
    product_id: product.id,
    name: product.name,
    qty: Math.min(MAX_QTY, Math.max(1, Math.floor(qty))),
    modifier_ids: [...modifierIds],
    modifiers: pickedModifiers(product, modifierIds),
    unit_kopecks: unitPrice(product, modifierIds),
  };
  return { ...cart, lines: [...cart.lines, line] };
}

/**
 * Строка с фиксированной суммой (касса: заявка стола «Стол 4 · 2 ч», счёт стола). Повтор с тем же ключом не дублирует.
 * @param {{ lines: object[] }} cart
 * @param {{ key: string, kind: string, name: string, amount_kopecks: number, [k: string]: unknown }} item
 */
export function addFixed(cart, item) {
  if (!Number.isSafeInteger(item.amount_kopecks)) throw new TypeError('addFixed: сумма — целые копейки');
  if (cart.lines.some((l) => l.key === item.key)) return cart;
  const { amount_kopecks, ...rest } = item;
  return { ...cart, lines: [...cart.lines, { ...rest, qty: 1, fixed: true, unit_kopecks: amount_kopecks }] };
}

/** Количество строки; 0 — убрать строку. Строки с фиксированной суммой — только 1 или убрать. */
export function setQty(cart, key, qty) {
  const q = Math.floor(Number(qty));
  if (!Number.isFinite(q) || q <= 0) return removeLine(cart, key);
  return {
    ...cart,
    lines: cart.lines.map((l) => (l.key === key ? { ...l, qty: l.fixed ? 1 : Math.min(MAX_QTY, q) } : l)),
  };
}

export function removeLine(cart, key) {
  return { ...cart, lines: cart.lines.filter((l) => l.key !== key) };
}

export function lineTotal(line) {
  return line.unit_kopecks * line.qty;
}

/** Итог корзины: сколько штук и сумма без скидки. */
export function cartTotals(cart) {
  let count = 0;
  let subtotal = 0;
  for (const l of cart.lines) {
    count += l.qty;
    subtotal += lineTotal(l);
  }
  return { count, subtotal_kopecks: subtotal };
}

/** Позиции заказа для API (`POST /api/orders`, товары в `POST /api/pos/sales`). */
export function orderItems(cart) {
  return cart.lines.filter((l) => l.kind === 'product').map((l) => ({ product_id: l.product_id, qty: l.qty, modifier_ids: [...l.modifier_ids] }));
}

/**
 * Корзина после обновления меню: исчезнувшие и ушедшие в стоп-лист товары убираются, цены — из нового меню.
 * @returns {{ cart: object, removed: string[] }} removed — названия убранных позиций, чтобы сказать об этом
 */
export function refreshCart(cart, menu) {
  const removed = [];
  const lines = [];
  for (const l of cart.lines) {
    if (l.kind !== 'product') {
      lines.push(l);
      continue;
    }
    const p = menu.byId.get(l.product_id);
    if (!available(p)) {
      removed.push(l.name);
      continue;
    }
    lines.push({ ...l, name: p.name, modifiers: pickedModifiers(p, l.modifier_ids), unit_kopecks: unitPrice(p, l.modifier_ids) });
  }
  return { cart: { ...cart, lines }, removed };
}

/** Номер стола заказа: `resource.number` (backend-pos) или `resource_number`; null — заказ кассы. */
export function orderTable(order) {
  return order?.resource?.number ?? order?.resource_number ?? null;
}

/** Сумма заказа: `subtotal_kopecks` (backend-pos) или `total_kopecks`. */
export function orderTotal(order) {
  const v = order?.subtotal_kopecks ?? order?.total_kopecks;
  return Number.isSafeInteger(v) ? v : 0;
}

/** Как оплачен заказ — словом для бара и гостя: в счёт стола, онлайн (оплачен или ждёт оплаты), на кассе. */
export function orderPayWord(order) {
  const mode = order?.pay_mode ?? order?.pay;
  if (mode === 'tab') return order?.paid ? 'Счёт оплачен' : 'В счёт стола';
  if (mode === 'pos' || order?.source === 'pos') return 'Оплачен на кассе';
  if (order?.awaiting_payment) return 'Ждёт оплаты';
  return 'Оплачен онлайн';
}

/** Минуты ожидания заказа для экрана бара: от created_at до now, целые, не меньше 0. */
export function waitMinutes(order, now) {
  const t = Date.parse(order?.created_at);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / 60000));
}

/**
 * Насколько долго ждёт заказ: обычно, долго (≥ 10 мин), очень долго (≥ 20 мин). Пороги — настройка позже.
 * @returns {'ok' | 'slow' | 'late'}
 */
export function waitTone(minutes) {
  if (minutes >= 20) return 'late';
  if (minutes >= 10) return 'slow';
  return 'ok';
}

/** Сортировка очереди бара: по статусу (новые, готовятся, готовы), внутри — кто ждёт дольше, тот выше. */
export function sortQueue(orders) {
  const rank = { new: 0, preparing: 1, ready: 2 };
  return [...orders]
    .filter(orderActive)
    .sort((a, b) => rank[a.status] - rank[b.status] || String(a.created_at).localeCompare(String(b.created_at)));
}

/**
 * Применить событие SSE `bar` (или `order`) к списку: сервер шлёт заказ целиком; выданные и отменённые уходят из очереди.
 * @param {object[] | null} list
 * @param {object} order
 */
export function mergeOrder(list, order) {
  if (!order?.id || !Array.isArray(list)) return list;
  const i = list.findIndex((o) => o.id === order.id);
  if (i < 0) return [...list, order];
  const next = list.slice();
  next[i] = { ...list[i], ...order };
  return next;
}
