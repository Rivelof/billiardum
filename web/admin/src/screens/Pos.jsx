import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { formatMoney, formatTime, plural } from '@billiardum/shared/format';
import { addFixed, addProduct, available, defaultModifiers, emptyCart, lineTotal, modifiersText, normalizeMenu, refreshCart, removeLine, setQty, unavailableWord } from '@billiardum/shared/bar';
import { Shell } from '../components/Shell.jsx';
import { Icon } from '../components/Icon.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { ModifierDialog, DiscountDialog, PayDialog, StopListDialog } from './PosDialogs.jsx';
import { api, streamClub } from '../lib/api.js';
import { can } from '../lib/auth.js';
import { session } from '../lib/store.js';
import { DEFAULT_DISCOUNT_LIMIT, discountPercent, kktState, requestLine, saleTotals, tabLine } from '../lib/pos.js';
import { minutesShort } from '../lib/words.js';
import { currentOf } from '../lib/shift.js';
import { linkHandler } from '../lib/router.js';
import { BASE } from '../lib/env.js';
import { expiresOf } from '../lib/reception.js';

const CART_KEY = 'bl-pos-cart';
const TABLES = 'tables';
const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е');

/**
 * Касса POS ресепшена «как в магазине» (PRODUCT §4, контракт m2 §4): планшет горизонтально, без мыши.
 * Слева — плитки товаров по категориям и поиск, первая вкладка «Столы»: заявки гостей и открытые счета столов.
 * Справа — чек: позиции, скидка (выше лимита — подтверждение управляющего), оплата наличными, картой или по СБП.
 */
export function Pos({ ctx }) {
  const { club, role, user, timeZone } = ctx;
  const clubId = club.club_id;
  const [menu, setMenu] = useState(null);
  const [requests, setRequests] = useState([]);
  const [tabs, setTabs] = useState([]);
  const [shift, setShift] = useState(undefined); // undefined — ещё не знаем, null — смены нет
  const [kktRaw, setKkt] = useState(null);
  const [limit, setLimit] = useState(DEFAULT_DISCOUNT_LIMIT);
  const [error, setError] = useState(null);
  const [cart, setCart] = useState(() => session.get(CART_KEY)?.cart ?? emptyCart());
  const [discount, setDiscount] = useState(() => session.get(CART_KEY)?.discount ?? null);
  const [toBar, setToBar] = useState(true);
  const [category, setCategory] = useState(null);
  const [query, setQuery] = useState('');
  const [modProduct, setModProduct] = useState(null);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [payMethod, setPayMethod] = useState(null);
  const [stopOpen, setStopOpen] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [liveTick, setLiveTick] = useState(0); // события sale и receipt — окну оплаты перечитать продажу
  const [live, setLive] = useState('open');
  const cartRef = useRef(cart);
  cartRef.current = cart;
  const abandoned = useRef(null); // продажа СБП, окно которой закрыли до оплаты
  const [lateNote, setLateNote] = useState(false);

  useEffect(() => session.set(CART_KEY, cart.lines.length || discount ? { cart, discount } : null), [cart, discount]);

  const loadMenu = useCallback(async () => {
    try {
      const m = normalizeMenu(await api.menu(clubId));
      setMenu(m);
      const { cart: fresh, removed } = refreshCart(cartRef.current, m);
      if (removed.length) {
        setCart(fresh);
        setAnnounce(`Убрали из чека: ${removed.join(', ')} — нет в продаже.`);
      }
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [clubId]);

  const loadTables = useCallback(async () => {
    const [r, t] = await Promise.allSettled([api.requests(clubId), api.tabs(clubId)]);
    const reqs = r.status === 'fulfilled' && Array.isArray(r.value) ? r.value.filter((x) => expiresOf(x) > Date.now()) : null;
    const tbs = t.status === 'fulfilled' && Array.isArray(t.value) ? t.value.filter((x) => x.total_kopecks > 0) : null;
    if (reqs) setRequests(reqs);
    if (tbs) setTabs(tbs);
    // Заявка сгорела или её приняли в другом окне, счёт оплачен — убираем из чека и говорим об этом
    setCart((c) => {
      let next = c;
      const gone = [];
      for (const l of c.lines) {
        if (l.kind === 'request' && reqs && !reqs.some((x) => x.id === l.request_id)) gone.push(l);
        if (l.kind === 'tab' && tbs && !tbs.some((x) => x.session_id === l.session_id && x.total_kopecks === l.unit_kopecks)) gone.push(l);
      }
      for (const l of gone) next = removeLine(next, l.key);
      if (gone.length) setAnnounce(`Убрали из чека: ${gone.map((l) => l.name).join(', ')} — заявка или счёт изменились.`);
      return next;
    });
  }, [clubId]);

  const loadShift = useCallback(async () => {
    try {
      setShift(currentOf(await api.currentShift(clubId)));
    } catch (err) {
      setShift(err?.code === 'not_found' ? null : undefined);
    }
  }, [clubId]);

  const loadKkt = useCallback(async () => {
    try {
      setKkt(await api.kktStatus(clubId));
    } catch {
      setKkt(null);
    }
  }, [clubId]);

  const loadSettings = useCallback(async () => {
    try {
      const st = await api.posSettings(clubId);
      if (Number.isInteger(st?.discount_limit_percent)) setLimit(st.discount_limit_percent);
    } catch {
      // нет настроек — лимит по умолчанию 10 % (№82)
    }
  }, [clubId]);

  const loadAll = useCallback(
    () => Promise.all([loadMenu(), loadTables(), loadShift(), loadKkt(), loadSettings()]),
    [loadMenu, loadTables, loadShift, loadKkt, loadSettings],
  );

  useEffect(() => {
    loadAll();
    const stream = streamClub(clubId, {
      onEvent: (name, data) => {
        if (name === 'reception_request' || name === 'bar' || name === 'session') loadTables();
        else if (name === 'shift') loadShift();
        else if (name === 'kkt') {
          // Сводка кассы ККТ приходит целиком; изменилась очередь — окну оплаты перечитать чек
          if (data && typeof data === 'object') setKkt(data);
          else loadKkt();
          setLiveTick((n) => n + 1);
        } else if (name === 'pos_sale') {
          setLiveTick((n) => n + 1);
          if (abandoned.current && data?.sale_id === abandoned.current && data.status === 'completed') {
            abandoned.current = null;
            setLateNote(true);
            setAnnounce('Оплата по СБП за закрытый QR пришла. Чек закрыт.');
            setCart(emptyCart());
            setDiscount(null);
          } else if (data?.sale_id === abandoned.current && data?.status === 'canceled') abandoned.current = null;
        }
      },
      onOpen: loadAll,
      onState: setLive,
    });
    const poll = setInterval(() => {
      loadTables();
      loadKkt();
    }, 30000);
    return () => {
      stream.close();
      clearInterval(poll);
    };
  }, [clubId, loadAll, loadTables, loadShift, loadKkt]);

  const kkt = kktState(kktRaw);
  const totals = saleTotals(cart, discount);
  // Подтверждение управляющего привязано к сумме: состав чека изменился — скидку подтверждают заново
  useEffect(() => {
    if (!discount) return;
    if (!totals.base || (discount.approval && discount.approval.base_kopecks !== totals.base)) {
      setDiscount(null);
      setAnnounce(totals.base ? 'Скидку сняли: состав чека изменился. Подтвердите её заново.' : 'Скидку сняли: в чеке нет бара.');
    }
  }, [totals.base]);
  const tablesCount = requests.length + tabs.length;
  const activeCategory = category ?? (tablesCount ? TABLES : menu?.categories[0]?.id ?? null);
  const qtyIn = useMemo(() => {
    const m = new Map();
    for (const l of cart.lines) if (l.kind === 'product') m.set(l.product_id, (m.get(l.product_id) ?? 0) + l.qty);
    return m;
  }, [cart]);

  const shown = useMemo(() => {
    if (!menu) return [];
    const q = norm(query.trim());
    if (q) return menu.products.filter((p) => norm(p.name).includes(q));
    if (activeCategory === TABLES) return [];
    return menu.products.filter((p) => (p.category_id ?? null) === activeCategory || (activeCategory === null && !menu.categories.some((c) => c.id === p.category_id)));
  }, [menu, query, activeCategory]);

  const add = (product) => {
    if (!available(product)) return;
    if (product.modifier_groups.length) {
      setModProduct(product);
      return;
    }
    setCart((c) => addProduct(c, product, defaultModifiers(product)));
    setAnnounce(`${product.name} в чеке`);
  };

  const newCheck = () => {
    setCart(emptyCart());
    setDiscount(null);
    setToBar(true);
    loadTables();
    loadMenu();
  };

  const noShift = shift === null;
  const hasProducts = cart.lines.some((l) => l.kind === 'product');
  const kktOff = kkt.known && !kkt.online;
  const hasRequests = cart.lines.some((l) => l.kind === 'request');

  const tools = (
    <>
      {live !== 'open' ? (
        <span class="bar__live" role="status">
          <Icon name="refresh" />
          Нет связи, переподключаемся
        </span>
      ) : null}
      {kkt.known ? (
        <span class={`badge ${kktOff || kkt.warning ? 'badge--alert' : 'badge--free'} pos__kkt`} role="status">
          <span class="badge__dot" aria-hidden="true" />
          {kktOff ? 'Касса ККТ не на связи' : kkt.warning ? 'Касса ККТ: проверьте чеки' : 'Касса ККТ на связи'}
          {kkt.pending ? `, в очереди ${kkt.pending} ${plural(kkt.pending, ['чек', 'чека', 'чеков'])}` : ''}
        </span>
      ) : null}
    </>
  );

  return (
    <Shell club={club} role={role} user={user} timeZone={timeZone} active="pos" title="Касса" tools={tools} wide>
      <p class="visually-hidden" aria-live="polite">
        {announce}
      </p>
      <div class="pos">
        <section class="pos__catalog" aria-label="Товары">
          <div class="pos__find">
            <label class="search">
              <Icon name="search" />
              <span class="visually-hidden">Найти товар</span>
              <input
                class="search__input"
                type="search"
                placeholder="Найти товар"
                value={query}
                autoComplete="off"
                onInput={(e) => setQuery(e.currentTarget.value)}
              />
            </label>
            <button type="button" class="btn btn--quiet pos__stop" disabled={!menu} onClick={() => setStopOpen(true)}>
              <Icon name="list" />
              Стоп-лист
            </button>
          </div>
          {!query ? (
            <div class="pills pos__cats" role="radiogroup" aria-label="Категории">
              {tablesCount ? (
                <label class="pill">
                  <input type="radio" name="pos-cat" checked={activeCategory === TABLES} onChange={() => setCategory(TABLES)} />
                  <span>
                    Столы <b class="pill__count">{tablesCount}</b>
                  </span>
                </label>
              ) : null}
              {(menu?.categories ?? []).map((c) => (
                <label class="pill" key={c.id ?? 'other'}>
                  <input type="radio" name="pos-cat" checked={activeCategory === c.id} onChange={() => setCategory(c.id)} />
                  <span>{c.name}</span>
                </label>
              ))}
            </div>
          ) : (
            <p class="hint pos__found" role="status">
              {shown.length ? `Нашли ${shown.length} ${plural(shown.length, ['товар', 'товара', 'товаров'])}` : `По запросу «${query.trim()}» ничего нет. Проверьте написание.`}
            </p>
          )}

          <ErrorNote error={error}>
            <button type="button" class="btn btn--secondary btn--sm" onClick={loadAll}>
              Обновить
            </button>
          </ErrorNote>

          {menu === null && !error ? <p class="muted">Загружаем меню…</p> : null}

          {activeCategory === TABLES && !query ? (
            <TableTiles requests={requests} tabs={tabs} cart={cart} timeZone={timeZone} onAdd={(item) => setCart((c) => addFixed(c, item))} />
          ) : (
            <ul class="tiles">
              {shown.map((p) => {
                const word = unavailableWord(p);
                const n = qtyIn.get(p.id) ?? 0;
                const low = !word && p.stock_qty !== null && p.stock_qty <= 5;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      class={`tile${n ? ' tile--in' : ''}${word ? ' tile--off' : ''}`}
                      disabled={Boolean(word)}
                      onClick={() => add(p)}
                      aria-label={`${p.name}, ${formatMoney(p.price_kopecks)}${word ? `, ${word.toLowerCase()}` : ''}${n ? `, в чеке ${n}` : ''}${p.modifier_groups.length ? ', с выбором' : ''}`}
                    >
                      <span class="tile__name">{p.name}</span>
                      <span class="tile__foot">
                        <span class="tile__price mono">{formatMoney(p.price_kopecks)}</span>
                        {word ? <span class="tile__state">{word}</span> : low ? <span class="tile__state tile__state--low">Осталось {p.stock_qty}</span> : null}
                        {p.is_alcohol ? <span class="tile__tag" title="Проверьте возраст гостя">18+</span> : null}
                      </span>
                      {n ? (
                        <span class="tile__qty mono" aria-hidden="true">
                          {n}
                        </span>
                      ) : null}
                      {p.modifier_groups.length ? <span class="tile__more" aria-hidden="true">выбор</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <aside class="pos__cart" aria-labelledby="cart-title">
          <div class="cart__head">
            <h2 class="section-title" id="cart-title">
              Чек
              {totals.count ? <span class="count">{totals.count}</span> : null}
            </h2>
            {cart.lines.length ? (
              <button type="button" class="btn btn--link" onClick={newCheck}>
                Очистить чек
              </button>
            ) : null}
          </div>

          {noShift ? (
            <div class="note note--lamp cart__shift">
              <Icon name="register" />
              <p class="note__title">Смена не открыта</p>
              <p class="note__body">Касса не продаёт, пока смена закрыта: откройте её с разменом.</p>
              <div class="note__actions">
                <a class="btn btn--secondary btn--sm" href={`${BASE}c/${encodeURIComponent(clubId)}/shift`} onClick={linkHandler}>
                  Открыть смену
                </a>
              </div>
            </div>
          ) : null}

          {lateNote ? (
            <div class="note note--free" role="status">
              <Icon name="check" />
              <p class="note__title">Оплата по СБП пришла после закрытия QR</p>
              <p class="note__body">Тот чек оплачен и закрыт, повторно продавать не нужно.</p>
              <div class="note__actions">
                <button type="button" class="btn btn--quiet btn--sm" onClick={() => setLateNote(false)}>
                  Понятно
                </button>
              </div>
            </div>
          ) : null}
          {cart.lines.length ? (
            <ul class="cart__lines">
              {cart.lines.map((l) => (
                <li class="cline" key={l.key}>
                  <div class="cline__what">
                    <span class="cline__name">{l.name}</span>
                    {l.kind === 'product' && l.modifiers.length ? <span class="cline__sub">{modifiersText(l.modifiers)}</span> : null}
                  </div>
                  <span class="cline__sum mono">{formatMoney(lineTotal(l))}</span>
                  <div class="cline__qty">
                    {l.fixed ? (
                      <>
                        <span class="cline__sub">{l.sub}</span>
                        <button type="button" class="icon-btn cline__del" aria-label={`Убрать из чека: ${l.name}`} onClick={() => setCart((c) => removeLine(c, l.key))}>
                          <Icon name="trash" />
                        </button>
                      </>
                    ) : (
                      <div class="stepper" role="group" aria-label={`${l.name}: количество`}>
                        <button type="button" class="stepper__btn" aria-label={l.qty === 1 ? `Убрать ${l.name}` : 'Меньше на одну'} onClick={() => setCart((c) => setQty(c, l.key, l.qty - 1))}>
                          <Icon name={l.qty === 1 ? 'trash' : 'minus'} />
                        </button>
                        <span class="stepper__value mono" aria-live="polite">
                          {l.qty}
                        </span>
                        <button type="button" class="stepper__btn" aria-label="Больше на одну" disabled={l.qty >= 99} onClick={() => setCart((c) => setQty(c, l.key, l.qty + 1))}>
                          <Icon name="plus" />
                        </button>
                      </div>
                    )}
                    {!l.fixed ? <span class="cline__unit small">{formatMoney(l.unit_kopecks)} за шт.</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div class="cart__empty">
              <Icon name="receipt" size={30} />
              <p>Чек пуст. Нажмите на товар слева{tablesCount ? ' или на заявку во вкладке «Столы»' : ''}.</p>
            </div>
          )}

          <div class="cart__foot">
            <div class="cart__tools">
              <button type="button" class="btn btn--quiet btn--sm cart__disc" disabled={!totals.base} onClick={() => setDiscountOpen(true)}>
                <Icon name="percent" />
                {discount ? 'Изменить скидку' : 'Скидка'}
              </button>
              {hasProducts ? (
                <label class="check cart__tobar">
                  <input type="checkbox" checked={toBar} onChange={(e) => setToBar(e.currentTarget.checked)} />
                  <span>Готовить в баре</span>
                </label>
              ) : null}
            </div>
            <dl class="receipt cart__totals">
              {totals.discount || cart.lines.length > 1 ? (
                <div class="receipt__row">
                  <dt>Сумма</dt>
                  <dd class="receipt__sum">{formatMoney(totals.subtotal)}</dd>
                </div>
              ) : null}
              {totals.discount ? (
                <div class="receipt__row cart__discount">
                  <dt>
                    Скидка {discountPercent(totals.base, totals.discount).toLocaleString('ru-RU')} %{discount?.approval ? `, подтвердил ${discount.approval.approved_by?.name ?? 'управляющий'}` : ''}
                  </dt>
                  <dd class="receipt__sum">−{formatMoney(totals.discount)}</dd>
                </div>
              ) : null}
              <div class="receipt__row receipt__row--total">
                <dt>К оплате</dt>
                <dd class="receipt__sum cart__total display">{formatMoney(totals.total)}</dd>
              </div>
            </dl>
            <div class="paybtns" role="group" aria-label="Оплата">
              <button type="button" class="paybtn" disabled={!cart.lines.length || noShift} onClick={() => setPayMethod('cash')}>
                <Icon name="cash" />
                <span class="paybtn__title">Наличные</span>
                <span class="paybtn__sub">{noShift ? 'нужна смена' : 'сдача на экране'}</span>
              </button>
              <button type="button" class="paybtn" disabled={!cart.lines.length || noShift} onClick={() => setPayMethod('card_terminal')}>
                <Icon name="card" />
                <span class="paybtn__title">Карта</span>
                <span class="paybtn__sub">{noShift ? 'нужна смена' : 'терминал'}</span>
              </button>
              <button type="button" class="paybtn" disabled={!cart.lines.length || hasRequests || noShift} onClick={() => setPayMethod('sbp')}>
                <Icon name="qr" />
                <span class="paybtn__title">СБП</span>
                <span class="paybtn__sub">{noShift ? 'нужна смена' : hasRequests ? 'не для заявки стола' : 'QR на экране'}</span>
              </button>
            </div>
            {kktOff ? (
              <p class="cart__kkt small" role="status">
                <Icon name="alert" />
                Касса ККТ не на связи: продажа сохранится, чек пробьётся позже.
              </p>
            ) : null}
          </div>
        </aside>
      </div>

      <ModifierDialog
        product={modProduct}
        onClose={() => setModProduct(null)}
        onAdd={(p, ids, qty) => {
          setCart((c) => addProduct(c, p, ids, qty));
          setAnnounce(`${p.name} в чеке`);
          setModProduct(null);
        }}
      />
      <StopListDialog open={stopOpen} menu={menu} onClose={() => setStopOpen(false)} onChanged={loadMenu} />
      <DiscountDialog
        open={discountOpen}
        clubId={clubId}
        role={role}
        base={totals.base}
        limit={limit}
        current={discount}
        bigAllowed={can.bigDiscount(role)}
        onClose={() => setDiscountOpen(false)}
        onApply={(d) => {
          setDiscount(d);
          setDiscountOpen(false);
        }}
      />
      <PayDialog
        method={payMethod}
        cart={cart}
        discount={discount}
        toBar={toBar && hasProducts}
        kktOnline={kkt.known ? kkt.online : undefined}
        clubId={clubId}
        liveTick={liveTick}
        onClose={() => setPayMethod(null)}
        onDone={newCheck}
        onShiftClosed={loadShift}
        onAbandon={(id) => (abandoned.current = id)}
      />
    </Shell>
  );
}

/** Вкладка «Столы»: заявки «Оплачу на ресепшене» и открытые счета столов (№79). */
function TableTiles({ requests, tabs, cart, timeZone, onAdd }) {
  const inCart = new Set(cart.lines.map((l) => l.key));
  if (!requests.length && !tabs.length) {
    return <p class="hint">Заявок и открытых счетов нет. Когда гость выберет «Оплачу на ресепшене» или закажет бар «в счёт стола», он появится здесь.</p>;
  }
  return (
    <div class="tables">
      {requests.length ? (
        <>
          <h3 class="tables__title">Заявки гостей</h3>
          <ul class="tiles tiles--tables">
            {requests.map((r) => {
              const line = requestLine(r);
              const added = inCart.has(line.key);
              return (
                <li key={r.id}>
                  <button type="button" class={`tile tile--table${added ? ' tile--in' : ''}`} disabled={added} onClick={() => onAdd(line)} aria-label={`Заявка: стол ${r.resource_number}, ${minutesShort(r.minutes)}, ${formatMoney(r.amount_kopecks)}${added ? ', уже в чеке' : ''}`}>
                    <span class="tile__table display">Стол {r.resource_number}</span>
                    <span class="tile__name">{r.kind === 'extend' ? 'Продление' : 'Игра'}, {minutesShort(r.minutes)}</span>
                    <span class="tile__foot">
                      <span class="tile__price mono">{formatMoney(r.amount_kopecks)}</span>
                      <span class="tile__state">{added ? 'В чеке' : `до ${formatTime(expiresOf(r), timeZone)}`}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {tabs.length ? (
        <>
          <h3 class="tables__title">Счета столов</h3>
          <ul class="tiles tiles--tables">
            {tabs.map((t) => {
              const line = tabLine(t);
              const added = inCart.has(line.key);
              const ended = !['active', 'ending', 'grace'].includes(t.session_status ?? 'active');
              const number = t.resource?.number ?? t.resource_number;
              return (
                <li key={t.session_id}>
                  <button type="button" class={`tile tile--table${added ? ' tile--in' : ''}${ended ? ' tile--ended' : ''}`} disabled={added} onClick={() => onAdd(line)} aria-label={`Счёт стола ${number}, ${line.sub}, ${formatMoney(t.total_kopecks)}${ended ? ', игра закончилась' : ''}${added ? ', уже в чеке' : ''}`}>
                    <span class="tile__table display">Стол {number}</span>
                    <span class="tile__name">{line.sub}</span>
                    <span class="tile__foot">
                      <span class="tile__price mono">{formatMoney(t.total_kopecks)}</span>
                      <span class={`tile__state${ended ? ' tile__state--low' : ''}`}>{added ? 'В чеке' : ended ? 'Игра закончилась' : 'Идёт игра'}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      <p class="hint">Заявку и счёт можно оплатить вместе с баром одним чеком.</p>
    </div>
  );
}
