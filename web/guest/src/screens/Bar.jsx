import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { formatMoney } from '@billiardum/shared/format';
import {
  addProduct,
  available,
  cartTotals,
  defaultModifiers,
  emptyCart,
  lineTotal,
  mergeOrder,
  modifiersText,
  normalizeMenu,
  orderItems,
  orderPayWord,
  orderTotal,
  orderWord,
  refreshCart,
  setQty,
  toggleModifier,
  unavailableWord,
  unitPrice,
  validateModifiers,
} from '@billiardum/shared/bar';
import { Header } from '../components/Header.jsx';
import { Icon } from '../components/Icon.jsx';
import { Dialog } from '../components/Dialog.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { usePoll } from '../components/hooks.js';
import { api, streamSession } from '../lib/api.js';
import { BASE } from '../lib/env.js';
import { linkHandler } from '../lib/router.js';
import { session as sessionStore } from '../lib/store.js';
import { safeRedirectUrl } from '../lib/urls.js';
import { tableName } from '../lib/words.js';
import { ORDER_STEPS, canOrder, itemsWord, orderCta, ordersWord, sortGuestOrders, stepIndex, tabSummary } from '../lib/bar.js';
import '../styles/bar.css';

const cartKey = (id) => `bl-bar-cart:${id}`;
const STEP_WORD = { new: 'Принят', preparing: 'Готовится', ready: 'Готов', served: 'Выдан' };

/**
 * Бар со стола (PRODUCT §5, контракт m2 §4): меню без алкоголя (его не отдаёт сервер, №76), модификаторы, корзина,
 * заказ «в счёт стола» или с оплатой онлайн, статус заказа по SSE `order`, счёт стола и его оплата — и после игры (№79).
 */
export function BarScreen({ sessionId }) {
  const [session, setSession] = useState(null);
  const [menu, setMenu] = useState(null);
  const [orders, setOrders] = useState(null);
  const [tab, setTab] = useState(null);
  const [error, setError] = useState(null);
  const [cart, setCart] = useState(() => sessionStore.get(cartKey(sessionId)) ?? emptyCart());
  const [category, setCategory] = useState(null);
  const [modProduct, setModProduct] = useState(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [placed, setPlaced] = useState(null);
  const [announce, setAnnounce] = useState('');
  const cartRef = useRef(cart);
  cartRef.current = cart;

  useEffect(() => sessionStore.set(cartKey(sessionId), cart.lines.length ? cart : null), [cart, sessionId]);

  const loadTab = useCallback(async () => {
    const [t, o] = await Promise.allSettled([api.tab(sessionId), api.sessionOrders(sessionId)]);
    if (t.status === 'fulfilled') setTab(t.value);
    if (o.status === 'fulfilled' && Array.isArray(o.value)) setOrders(o.value);
  }, [sessionId]);

  const loadMenu = useCallback(async (clubId) => {
    const m = normalizeMenu(await api.menu(clubId));
    setMenu(m);
    const { cart: fresh, removed } = refreshCart(cartRef.current, m);
    if (removed.length) {
      setCart(fresh);
      setAnnounce(`Убрали из корзины: ${removed.join(', ')} — этого сейчас нет.`);
    }
    return m;
  }, []);

  const load = useCallback(async () => {
    try {
      const s = await api.session(sessionId);
      setSession(s);
      await Promise.all([s?.club?.id ? loadMenu(s.club.id) : null, loadTab()]);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [sessionId, loadMenu, loadTab]);

  useEffect(() => {
    load();
    const stream = streamSession(sessionId, {
      events: ['order', 'session'],
      onEvent: (name, data) => {
        if (name === 'order' && data?.id) {
          setOrders((list) => mergeOrder(list ?? [], data));
          if (data.status === 'ready') setAnnounce(`Заказ № ${data.number} готов, несём к столу.`);
          loadTab();
        } else if (name === 'session' && data?.id === sessionId) setSession((s) => ({ ...s, ...data }));
      },
      onOpen: loadTab,
    });
    const poll = setInterval(loadTab, 20000);
    return () => {
      stream.close();
      clearInterval(poll);
    };
  }, [sessionId, load, loadTab]);

  const open = canOrder(session);
  const totals = cartTotals(cart);
  const t = tabSummary(tab);
  const list = sortGuestOrders(orders ?? []);
  const active = list.filter((o) => ['new', 'preparing', 'ready'].includes(o.status));
  const qtyIn = useMemo(() => {
    const map = new Map();
    for (const l of cart.lines) map.set(l.product_id, (map.get(l.product_id) ?? 0) + l.qty);
    return map;
  }, [cart]);
  const shownCat = category ?? menu?.categories[0]?.id;
  const number = session?.resource?.number;

  const add = (p) => {
    if (!available(p)) return;
    if (p.modifier_groups.length) {
      setModProduct(p);
      return;
    }
    setCart((c) => addProduct(c, p, defaultModifiers(p)));
    setAnnounce(`${p.name} в корзине`);
  };

  return (
    <div class="screen screen--paper bar-screen">
      <Header back={{ href: `${BASE}s/${encodeURIComponent(sessionId)}`, label: 'К игре' }} />
      <p class="visually-hidden" aria-live="polite">
        {announce}
      </p>
      <main class={`wrap content bar${totals.count && open ? ' bar--cart' : ''}`}>
        <div class="bar__head">
          <h1 class="page-title display">Бар</h1>
          {session ? (
            <p class="muted">
              {open ? `${tableName(number)} — принесём заказ к столу` : `${tableName(number)} — игра закончилась, заказать к столу уже нельзя`}
            </p>
          ) : null}
        </div>

        <ErrorNote error={error}>
          <button type="button" class="btn btn--secondary btn--sm" onClick={load}>
            <Icon name="refresh" />
            Загрузить снова
          </button>
        </ErrorNote>

        {placed ? (
          <div class="note note--free" role="status">
            <Icon name="check" />
            <p class="note__title">Заказ № {placed.number} принят</p>
            <p class="note__body">{placed.pay_mode === 'tab' ? 'Он в счёте стола. Статус обновится здесь сам.' : 'Статус обновится здесь сам.'}</p>
          </div>
        ) : null}

        {active.length ? (
          <section class="orders" aria-labelledby="orders-title">
            <h2 class="step__label" id="orders-title">
              Ваши заказы
            </h2>
            <ul class="orders__list">
              {active.map((o) => (
                <li key={o.id}>
                  <OrderCard order={o} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {session && !open ? (
          <p class="hint">Меню бара доступно во время игры. Чтобы заказать ещё, подойдите на ресепшн.</p>
        ) : null}

        {open && menu ? (
          menu.products.length ? (
            <section class="menu" aria-labelledby="menu-title">
              <h2 class="visually-hidden" id="menu-title">
                Меню
              </h2>
              <div class="cats" role="radiogroup" aria-label="Раздел меню">
                {menu.categories.map((c) => (
                  <label class="cat" key={c.id ?? 'other'}>
                    <input type="radio" name="bar-cat" checked={shownCat === c.id} onChange={() => setCategory(c.id)} />
                    <span>{c.name}</span>
                  </label>
                ))}
              </div>
              <ul class="mlist">
                {menu.products
                  .filter((p) => p.category_id === shownCat)
                  .map((p) => {
                    const word = unavailableWord(p);
                    const n = qtyIn.get(p.id) ?? 0;
                    const mods = p.modifier_groups.map((g) => g.name.toLowerCase()).join(', ');
                    return (
                      <li class={`mrow${word ? ' mrow--off' : ''}`} key={p.id}>
                        <div class="mrow__text">
                          <p class="mrow__name">{p.name}</p>
                          {word ? <p class="mrow__sub mrow__sub--off">{word === 'Стоп-лист' ? 'Сейчас нет' : 'Закончилось'}</p> : mods ? <p class="mrow__sub">Выбор: {mods}</p> : null}
                        </div>
                        <p class="mrow__price mono">{formatMoney(p.price_kopecks)}</p>
                        <button
                          type="button"
                          class={`mrow__add${n ? ' mrow__add--in' : ''}`}
                          disabled={Boolean(word)}
                          onClick={() => add(p)}
                          aria-label={`${p.modifier_groups.length ? 'Выбрать' : 'Добавить'}: ${p.name}, ${formatMoney(p.price_kopecks)}${n ? `, в корзине ${n}` : ''}`}
                        >
                          {n ? <span class="mono">{n}</span> : <Icon name="plus" />}
                        </button>
                      </li>
                    );
                  })}
              </ul>
            </section>
          ) : (
            <p class="hint">В этом клубе пока нет меню бара. Спросите на ресепшене.</p>
          )
        ) : null}
        {open && !menu && !error ? (
          <p class="waiting" role="status">
            <span class="waiting__dot" aria-hidden="true" />
            Загружаем меню…
          </p>
        ) : null}

        {t.open || t.pending ? <TabBlock sessionId={sessionId} tab={tab} summary={t} onPaid={loadTab} /> : null}

        {list.some((o) => o.status === 'served') ? (
          <section class="orders orders--done" aria-labelledby="done-title">
            <h2 class="step__label" id="done-title">
              Выданы
            </h2>
            <ul class="receipt">
              {list
                .filter((o) => o.status === 'served')
                .map((o) => (
                  <li class="receipt__row" key={o.id}>
                    <span>
                      Заказ № {o.number}, {itemsWord(o.items?.reduce((s, i) => s + i.qty, 0) ?? 0)}
                    </span>
                    <span class="receipt__sum">{formatMoney(orderTotal(o))}</span>
                    <span class="receipt__sub">{orderPayWord(o)}</span>
                  </li>
                ))}
            </ul>
          </section>
        ) : null}
      </main>

      {open && totals.count ? (
        <div class="actionbar actionbar--fixed">
          <button type="button" class="btn btn--primary btn--block btn--lg cartbtn" onClick={() => setCartOpen(true)}>
            <Icon name="cart" />
            <span>Корзина · {itemsWord(totals.count)}</span>
            <span class="cartbtn__sum mono">{formatMoney(totals.subtotal_kopecks)}</span>
          </button>
        </div>
      ) : null}

      <ModSheet
        product={modProduct}
        onClose={() => setModProduct(null)}
        onAdd={(p, ids, qty) => {
          setCart((c) => addProduct(c, p, ids, qty));
          setAnnounce(`${p.name} в корзине`);
          setModProduct(null);
        }}
      />
      <CartSheet
        open={cartOpen}
        cart={cart}
        sessionId={sessionId}
        onCart={setCart}
        onClose={() => setCartOpen(false)}
        onStale={() => session?.club?.id && loadMenu(session.club.id)}
        onPlaced={(order) => {
          setCart(emptyCart());
          setCartOpen(false);
          setPlaced(order);
          if (order) setOrders((l) => mergeOrder(l ?? [], order));
          loadTab();
          window.scrollTo(0, 0);
        }}
      />
    </div>
  );
}

/** Карточка заказа: шкала статуса — настоящая последовательность «Принят → Готовится → Готов → Выдан». */
function OrderCard({ order }) {
  const step = stepIndex(order.status);
  const waitingPay = order.awaiting_payment;
  return (
    <article class={`ocard ocard--${order.status}`} aria-labelledby={`o-${order.id}`}>
      <header class="ocard__head">
        <h3 class="ocard__title" id={`o-${order.id}`}>
          Заказ № {order.number}
        </h3>
        {waitingPay || order.status === 'ready' ? (
          <p class={`badge ${waitingPay ? 'badge--pending' : 'badge--play'}`}>
            <span class="badge__dot" aria-hidden="true" />
            {waitingPay ? 'Ждёт оплаты' : orderWord(order.status)}
          </p>
        ) : null}
      </header>
      {!waitingPay ? (
        <ol class="steps" aria-label="Статус заказа">
          {ORDER_STEPS.map((s, i) => (
            <li key={s} class={`steps__item${i < step ? ' steps__item--done' : ''}${i === step ? ' steps__item--now' : ''}`} aria-current={i === step ? 'step' : undefined}>
              <span class="steps__dot" aria-hidden="true" />
              <span class="steps__word">{STEP_WORD[s]}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p class="hint">Оплата ещё не подтверждена. Если деньги списались, заказ сам уйдёт бару.</p>
      )}
      <p class="ocard__items">{(order.items ?? []).map((i) => `${i.qty} × ${i.name}${i.modifiers?.length ? ` (${modifiersText(i.modifiers)})` : ''}`).join(', ')}</p>
      <p class="ocard__meta">
        <span>{orderPayWord(order)}</span>
        <span class="mono">{formatMoney(orderTotal(order))}</span>
      </p>
    </article>
  );
}

/** Счёт стола: заказы «в счёт стола», оплата онлайн — сейчас или после игры (№79). */
function TabBlock({ sessionId, tab, summary, onPaid }) {
  const [method, setMethod] = useState('sbp');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const pay = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.payTab(sessionId, method, summary.total);
      const url = safeRedirectUrl(res?.confirmation?.url);
      if (url) window.location.assign(url);
      else onPaid?.();
    } catch (err) {
      setError(err);
      if (err?.code === 'already_paid') onPaid?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="tabblock" id="tab" aria-labelledby="tab-title">
      <div class="tabblock__top">
        <h2 class="tabblock__title" id="tab-title">
          Счёт стола
        </h2>
        <p class="tabblock__sum display">{formatMoney(summary.total)}</p>
      </div>
      <ul class="receipt">
        {(tab?.orders ?? []).map((o) => (
          <li class="receipt__row" key={o.id}>
            <span>Заказ № {o.number}</span>
            <span class="receipt__sum">{formatMoney(orderTotal(o))}</span>
          </li>
        ))}
      </ul>
      {summary.pending ? (
        <p class="waiting" role="status">
          <span class="waiting__dot" aria-hidden="true" />
          Оплата счёта идёт. Экран обновится, когда банк её подтвердит.
        </p>
      ) : (
        <>
          <p class="hint">
            {summary.count ? `${ordersWord(summary.count)} бара. ` : ''}Оплатите сейчас или после игры — на свет над столом счёт не влияет.
          </p>
          <fieldset class="paychoice">
            <legend class="visually-hidden">Способ оплаты счёта</legend>
            <label class="paychoice__item">
              <input type="radio" name="tab-method" checked={method === 'sbp'} onChange={() => setMethod('sbp')} />
              <span class="paychoice__box">
                <Icon name="transfer" />
                СБП
              </span>
            </label>
            <label class="paychoice__item">
              <input type="radio" name="tab-method" checked={method === 'card'} onChange={() => setMethod('card')} />
              <span class="paychoice__box">
                <Icon name="card" />
                Картой
              </span>
            </label>
          </fieldset>
          <ErrorNote error={error} />
          <button type="button" class="btn btn--secondary btn--block btn--lg" disabled={busy} onClick={pay}>
            {busy ? 'Открываем оплату…' : `Оплатить счёт ${formatMoney(summary.total)}`}
          </button>
        </>
      )}
    </section>
  );
}

/** Выбор модификаторов: объём, сахар, молоко… — нижний лист. */
function ModSheet({ product, onClose, onAdd }) {
  const [sel, setSel] = useState([]);
  const [qty, setQty] = useState(1);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (!product) return;
    setSel(defaultModifiers(product));
    setQty(1);
    setTried(false);
  }, [product?.id]);
  if (!product) return <Dialog open={false} onClose={onClose} title="" />;
  const check = validateModifiers(product, sel);
  const unit = unitPrice(product, sel);
  return (
    <Dialog open onClose={onClose} title={product.name} labelledBy="mod-title">
      <form
        class="step mods"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (check.ok) onAdd(product, sel, qty);
        }}
      >
        {product.modifier_groups.map((g) => {
          const err = tried ? check.errors.find((x) => x.group_id === g.id) : null;
          const type = g.max === 1 && g.min >= 1 ? 'radio' : 'checkbox';
          return (
            <fieldset class="mods__group" key={g.id}>
              <legend class="step__label">
                {g.name}
                <span class="mods__rule">{g.min >= 1 ? 'выберите один' : g.max > 1 ? `по желанию, до ${g.max}` : 'по желанию'}</span>
              </legend>
              <div class="opts">
                {g.modifiers.map((m) => (
                  <label class="opt" key={m.id}>
                    <input type={type} name={`m-${g.id}`} checked={sel.includes(m.id)} onChange={() => setSel((s) => toggleModifier(product, s, g.id, m.id))} />
                    <span class="opt__box">
                      {m.name}
                      {m.price_delta_kopecks ? <span class="opt__delta mono">+{formatMoney(m.price_delta_kopecks)}</span> : null}
                    </span>
                  </label>
                ))}
              </div>
              {err ? <p class="field__error">{err.text}</p> : null}
            </fieldset>
          );
        })}
        <div class="mods__qty">
          <span class="step__label" id="mod-qty">
            Сколько
          </span>
          <Stepper value={qty} onChange={setQty} labelledBy="mod-qty" />
        </div>
        <button type="submit" class="btn btn--primary btn--block btn--lg">
          <Icon name="plus" />В корзину — {formatMoney(unit * qty)}
        </button>
      </form>
    </Dialog>
  );
}

function Stepper({ value, onChange, labelledBy, label, min = 1 }) {
  return (
    <div class="stepper" role="group" aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : label}>
      <button type="button" class="stepper__btn" aria-label={value <= 1 && min === 0 ? 'Убрать' : 'Меньше на одну'} disabled={value <= min} onClick={() => onChange(value - 1)}>
        <Icon name={value <= 1 && min === 0 ? 'trash' : 'minus'} />
      </button>
      <span class="stepper__value mono" aria-live="polite">
        {value}
      </span>
      <button type="button" class="stepper__btn" aria-label="Больше на одну" disabled={value >= 99} onClick={() => onChange(value + 1)}>
        <Icon name="plus" />
      </button>
    </div>
  );
}

/** Корзина: позиции, пожелание бару, «в счёт стола» или оплата сейчас (СБП, карта). */
function CartSheet({ open, cart, sessionId, onCart, onClose, onStale, onPlaced }) {
  const [pay, setPay] = useState('tab');
  const [method, setMethod] = useState('sbp');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);
  const totals = cartTotals(cart);
  const amount = formatMoney(totals.subtotal_kopecks);

  const submit = async (e) => {
    e.preventDefault();
    if (!totals.count) return;
    setBusy(true);
    setError(null);
    try {
      const body = { session_id: sessionId, items: orderItems(cart), pay, ...(pay === 'online' ? { method } : {}), ...(comment.trim() ? { comment: comment.trim() } : {}) };
      const res = await api.createOrder(body);
      if (pay === 'online') {
        const url = safeRedirectUrl(res?.payment?.confirmation?.url);
        if (url) {
          onCart(emptyCart());
          window.location.assign(url);
          return;
        }
      }
      setComment('');
      onPlaced(res?.order ?? null);
    } catch (err) {
      // Позиция ушла в стоп-лист или её нельзя заказать со стола (алкоголь — 404, №76): меню обновится и уберёт её
      const stale = ['stop_list', 'not_found'].includes(err?.code);
      setError(stale ? { code: 'stop_list' } : err);
      if (stale) onStale?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Корзина" labelledBy="cart-title">
      {open ? (
        <form class="step cart" onSubmit={submit} noValidate>
          {cart.lines.length ? (
            <ul class="clines">
              {cart.lines.map((l) => (
                <li class="cline" key={l.key}>
                  <div class="cline__what">
                    <span class="cline__name">{l.name}</span>
                    {l.modifiers?.length ? <span class="cline__sub">{modifiersText(l.modifiers)}</span> : null}
                  </div>
                  <span class="cline__sum mono">{formatMoney(lineTotal(l))}</span>
                  <Stepper value={l.qty} min={0} onChange={(q) => onCart((c) => setQty(c, l.key, q))} label={`${l.name}: количество`} />
                </li>
              ))}
            </ul>
          ) : (
            <p class="hint">Корзина пуста. Выберите что-нибудь в меню.</p>
          )}
          <div class="field">
            <label class="field__label" for="bar-comment">
              Пожелание бару
            </label>
            <input id="bar-comment" class="field__input" maxLength={200} value={comment} placeholder="Например: без льда" onInput={(e) => setComment(e.currentTarget.value)} />
          </div>
          <fieldset>
            <legend class="step__label">Как оплатить</legend>
            <div class="choice">
              <label class="choice__item">
                <input type="radio" name="pay" checked={pay === 'tab'} onChange={() => setPay('tab')} />
                <span class="choice__box">
                  <span class="choice__title">В счёт стола</span>
                  <span class="choice__sub">Оплатите одним счётом в конце игры</span>
                </span>
              </label>
              <label class="choice__item">
                <input type="radio" name="pay" checked={pay === 'online'} onChange={() => setPay('online')} />
                <span class="choice__box">
                  <span class="choice__title">Оплатить сейчас</span>
                  <span class="choice__sub">СБП или картой, заказ уйдёт бару после оплаты</span>
                </span>
              </label>
            </div>
          </fieldset>
          {pay === 'online' ? (
            <fieldset class="paychoice">
              <legend class="visually-hidden">Способ оплаты</legend>
              <label class="paychoice__item">
                <input type="radio" name="order-method" checked={method === 'sbp'} onChange={() => setMethod('sbp')} />
                <span class="paychoice__box">
                  <Icon name="transfer" />
                  СБП
                </span>
              </label>
              <label class="paychoice__item">
                <input type="radio" name="order-method" checked={method === 'card'} onChange={() => setMethod('card')} />
                <span class="paychoice__box">
                  <Icon name="card" />
                  Картой
                </span>
              </label>
            </fieldset>
          ) : null}
          <ErrorNote error={error} />
          <div class="actionbar">
            <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy || !totals.count}>
              {busy ? 'Отправляем…' : orderCta(pay, amount)}
            </button>
          </div>
        </form>
      ) : null}
    </Dialog>
  );
}

/** Возврат после онлайн-оплаты заказа (return_url backend-pos `/app/orders/{id}`): ждём подтверждения. */
export function OrderPaid({ orderId }) {
  const [order, setOrder] = useState(null);
  const [error, setError] = useState(null);
  const done = useRef(false);
  usePoll(
    async () => {
      if (done.current) return;
      try {
        const o = await api.order(orderId);
        setOrder(o);
        setError(null);
        if (!o.awaiting_payment || o.status === 'canceled') done.current = true;
      } catch (err) {
        setError(err);
      }
    },
    1500,
    [orderId],
  );
  const paid = order && !order.awaiting_payment && order.status !== 'canceled';
  const back = order?.session_id ? `${BASE}s/${encodeURIComponent(order.session_id)}` : BASE;
  return (
    <div class="screen screen--paper">
      <Header back={{ href: back, label: 'К игре' }} />
      <main class="wrap content">
        <h1 class="page-title display" aria-live="polite">
          {!order ? 'Заказ бара' : order.status === 'canceled' ? 'Заказ отменён' : paid ? `Заказ № ${order.number} оплачен` : 'Ждём подтверждения оплаты'}
        </h1>
        <ErrorNote error={error} />
        {order && paid ? <OrderCard order={order} /> : null}
        {order && !paid && order.status !== 'canceled' ? (
          <p class="waiting" role="status">
            <span class="waiting__dot" aria-hidden="true" />
            Проверяем оплату. Обычно это несколько секунд.
          </p>
        ) : null}
        {order?.status === 'canceled' ? <p class="lead">Оплата не прошла, деньги не списаны. Вернитесь в меню и закажите снова.</p> : null}
        {order?.session_id ? (
          <a class="btn btn--primary btn--block btn--lg" href={`${BASE}s/${encodeURIComponent(order.session_id)}/bar`} onClick={linkHandler}>
            <Icon name="cup" />
            Меню бара и статус заказа
          </a>
        ) : null}
      </main>
    </div>
  );
}

/** Возврат после оплаты счёта стола (return_url backend-pos `/app/sessions/{id}/tab`). */
export function TabPaid({ sessionId }) {
  const [tab, setTab] = useState(null);
  const [error, setError] = useState(null);
  const done = useRef(false);
  usePoll(
    async () => {
      if (done.current) return;
      try {
        const t = await api.tab(sessionId);
        setTab(t);
        setError(null);
        if (!t?.pending_payment) done.current = true;
      } catch (err) {
        setError(err);
      }
    },
    1500,
    [sessionId],
  );
  const s = tabSummary(tab);
  const settled = tab && !s.pending;
  return (
    <div class="screen screen--paper">
      <Header back={{ href: `${BASE}s/${encodeURIComponent(sessionId)}`, label: 'К игре' }} />
      <main class="wrap content">
        <h1 class="page-title display" aria-live="polite">
          {!tab ? 'Счёт стола' : s.pending ? 'Ждём подтверждения оплаты' : s.open ? 'Счёт ещё не оплачен' : 'Счёт стола оплачен'}
        </h1>
        <ErrorNote error={error} />
        {tab && s.pending ? (
          <p class="waiting" role="status">
            <span class="waiting__dot" aria-hidden="true" />
            Проверяем оплату. Обычно это несколько секунд.
          </p>
        ) : null}
        {settled && !s.open ? <p class="lead">Спасибо! Чек по 54‑ФЗ придёт на ваш номер.</p> : null}
        {settled && s.open ? <p class="lead">Оплата не прошла или вы её отменили. Деньги не списаны — попробуйте ещё раз.</p> : null}
        <a class="btn btn--primary btn--block btn--lg" href={`${BASE}s/${encodeURIComponent(sessionId)}/bar${s.open ? '#tab' : ''}`} onClick={linkHandler}>
          {s.open ? 'Вернуться к счёту' : 'Открыть бар'}
        </a>
        <a class="btn btn--quiet btn--block" href={`${BASE}s/${encodeURIComponent(sessionId)}`} onClick={linkHandler}>
          К игре
        </a>
      </main>
    </div>
  );
}
