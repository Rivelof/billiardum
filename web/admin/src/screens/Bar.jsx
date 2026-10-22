import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { formatTime, plural } from '@billiardum/shared/format';
import { ORDER_ACTION, ORDER_NEXT, mergeOrder, modifiersText, orderPayWord, orderTable, orderWord, sortQueue, waitMinutes, waitTone } from '@billiardum/shared/bar';
import { Icon } from '../components/Icon.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { useNow } from '../components/hooks.js';
import { api, streamClub } from '../lib/api.js';
import { can } from '../lib/auth.js';
import { audioState, chime, unlockAudio, ORDER_CHIME } from '../lib/sound.js';
import { linkHandler } from '../lib/router.js';
import { BASE } from '../lib/env.js';

const COLUMNS = [
  { status: 'new', title: 'Новые', empty: 'Новых заказов нет. Заказ со стола появится здесь со звуком.' },
  { status: 'preparing', title: 'Готовятся', empty: 'Ничего не готовится.' },
  { status: 'ready', title: 'Готовы', empty: 'Готовых заказов нет.' },
];
const MINUTES = ['минуту', 'минуты', 'минут'];
const HIGHLIGHT_MS = 20000;


/**
 * Экран бара (ТВ или планшет, PRODUCT §10): очередь заказов крупно, всегда тёмный «зал».
 * Стол, позиции с модификаторами, время ожидания; смена статуса одним касанием; звук нового заказа (WebAudio).
 * Живые обновления — SSE `bar` в канале клуба (контракт m2 §5), запасной опрос раз в 20 секунд.
 */
export function BarScreen({ ctx }) {
  const { club, role, timeZone } = ctx;
  const clubId = club.club_id;
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState(null);
  const [live, setLive] = useState('open');
  const [sound, setSound] = useState(audioState() === 'running');
  const [fresh, setFresh] = useState(() => new Set());
  const [busy, setBusy] = useState(null);
  const [announce, setAnnounce] = useState('');
  const seen = useRef(null);
  const now = useNow(0, true);

  const noticeNew = useCallback((list) => {
    if (!seen.current) {
      seen.current = new Set(list.map((o) => o.id));
      return;
    }
    const added = list.filter((o) => o.status === 'new' && !seen.current.has(o.id));
    for (const o of list) seen.current.add(o.id);
    if (!added.length) return;
    chime(ORDER_CHIME);
    setFresh((prev) => new Set([...prev, ...added.map((o) => o.id)]));
    const o = added[added.length - 1];
    setAnnounce(`Новый заказ: ${orderTable(o) ? `стол ${orderTable(o)}` : 'касса'}, ${o.items.map((i) => `${i.name} ${i.qty}`).join(', ')}`);
    setTimeout(() => setFresh((prev) => new Set([...prev].filter((id) => !added.some((a) => a.id === id)))), HIGHLIGHT_MS);
  }, []);

  const load = useCallback(async () => {
    try {
      const list = await api.barQueue(clubId);
      const arr = Array.isArray(list) ? list : [];
      noticeNew(arr);
      setOrders(arr);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [clubId, noticeNew]);

  useEffect(() => {
    load();
    const stream = streamClub(clubId, {
      events: ['bar'],
      onEvent: (_name, data) => {
        // Сервер шлёт заказ целиком; если пришло только {order_id, status} — перечитываем очередь
        if (data?.id && Array.isArray(data.items)) {
          setOrders((list) => {
            const next = mergeOrder(list ?? [], data);
            noticeNew(next);
            return next;
          });
        } else load();
      },
      onOpen: load,
      onState: setLive,
    });
    const poll = setInterval(load, 20000);
    return () => {
      stream.close();
      clearInterval(poll);
    };
  }, [clubId, load, noticeNew]);

  useEffect(() => {
    const unlock = () => unlockAudio().then((ok) => setSound(ok)).catch(() => {});
    document.addEventListener('pointerdown', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });
    return () => {
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
    };
  }, []);

  const advance = async (order) => {
    const next = ORDER_NEXT[order.status];
    if (!next) return;
    setBusy(order.id);
    setError(null);
    const before = order;
    setOrders((list) => mergeOrder(list, { ...order, status: next }));
    setAnnounce(`${orderTable(order) ? `Стол ${orderTable(order)}` : 'Касса'}, заказ ${order.number}: ${orderWord(next, 'staff').toLowerCase()}`);
    try {
      const res = await api.setOrderStatus(order.id, next);
      if (res?.id) setOrders((list) => mergeOrder(list, res));
    } catch (err) {
      setOrders((list) => mergeOrder(list, before));
      setError(err);
      if (err?.code === 'order_closed') load();
    } finally {
      setBusy(null);
    }
  };

  const queue = sortQueue(orders ?? []);
  const home = can.pos(role) ? `${BASE}c/${encodeURIComponent(clubId)}/pos` : `${BASE}c/${encodeURIComponent(clubId)}/more`;

  return (
    <div class="kiosk" data-theme="dark">
      <header class="kiosk__bar">
        <div class="kiosk__brand">
          <span class="display">Бильярдум</span>
          <span class="kiosk__club">{club.name ?? 'Клуб'}</span>
        </div>
        <h1 class="kiosk__title display">Заказы бара</h1>
        <div class="kiosk__tools">
          {live !== 'open' ? (
            <span class="bar__live" role="status">
              <Icon name="refresh" />
              Нет связи, переподключаемся
            </span>
          ) : null}
          <span class="kiosk__clock mono" aria-label={`Время клуба ${formatTime(now, timeZone)}`}>
            {formatTime(now, timeZone)}
          </span>
          <button
            type="button"
            class={`btn btn--sm ${sound ? 'btn--quiet' : 'btn--lamp'}`}
            aria-pressed={sound ? 'true' : 'false'}
            onClick={async () => {
              const ok = await unlockAudio().catch(() => false);
              setSound(ok);
              if (ok) chime(ORDER_CHIME);
            }}
          >
            <Icon name={sound ? 'sound' : 'mute'} />
            {sound ? 'Звук заказов включён' : 'Включить звук заказов'}
          </button>
          <a class="btn btn--quiet btn--sm" href={home} onClick={linkHandler}>
            <Icon name="back" />
            {can.pos(role) ? 'К кассе' : 'Меню программы'}
          </a>
        </div>
      </header>
      <p class="visually-hidden" aria-live="assertive">
        {announce}
      </p>
      <main class="board" id="main">
        <ErrorNote error={error} class="board__error">
          <button type="button" class="btn btn--secondary btn--sm" onClick={load}>
            Обновить
          </button>
        </ErrorNote>
        {orders === null && !error ? <p class="muted board__loading">Загружаем заказы…</p> : null}
        {COLUMNS.map((col) => {
          const list = queue.filter((o) => o.status === col.status);
          return (
            <section class={`lane lane--${col.status}`} key={col.status} aria-labelledby={`lane-${col.status}`}>
              <h2 class="lane__title" id={`lane-${col.status}`}>
                {col.title}
                <span class="lane__count mono">{list.length}</span>
              </h2>
              {list.length ? (
                <ul class="lane__list">
                  {list.map((o) => {
                    const min = waitMinutes(o, now);
                    const tone = waitTone(min);
                    const where = orderTable(o) ? `Стол ${orderTable(o)}` : 'Касса';
                    return (
                      <li key={o.id}>
                        <article class={`ticket ticket--${o.status}${fresh.has(o.id) ? ' ticket--fresh' : ''}`} aria-labelledby={`t-${o.id}`}>
                          <header class="ticket__head">
                            <h3 class="ticket__where display" id={`t-${o.id}`}>
                              {where}
                            </h3>
                            <span class="ticket__no mono">№&nbsp;{o.number}</span>
                          </header>
                          <p class={`ticket__wait ticket__wait--${tone}`}>
                            <Icon name={tone === 'ok' ? 'clock' : 'alert'} />
                            {min < 1 ? 'Только что' : `Ждёт ${min} ${plural(min, MINUTES)}`}
                            {tone === 'late' ? ' — очень долго' : tone === 'slow' ? ' — долго' : ''}
                          </p>
                          <ul class="ticket__items">
                            {o.items.map((it, i) => (
                              <li key={i}>
                                <span class="ticket__qty mono">{it.qty}&nbsp;×</span>
                                <span>
                                  <span class="ticket__name">{it.name}</span>
                                  {it.modifiers?.length ? <span class="ticket__mods">{modifiersText(it.modifiers)}</span> : null}
                                </span>
                              </li>
                            ))}
                          </ul>
                          {o.comment ? <p class="ticket__comment">«{o.comment}»</p> : null}
                          <p class="ticket__meta">
                            <span>{orderPayWord(o)}</span>
                            <span>{orderWord(o.status, 'staff')}</span>
                          </p>
                          <button type="button" class={`btn btn--lg btn--block ticket__go ${o.status === 'preparing' ? 'btn--lamp' : 'btn--primary'}`} disabled={busy === o.id} onClick={() => advance(o)}>
                            <Icon name={o.status === 'ready' ? 'check' : o.status === 'preparing' ? 'cup' : 'forward'} />
                            {ORDER_ACTION[o.status]}
                          </button>
                        </article>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p class="lane__empty">{col.empty}</p>
              )}
            </section>
          );
        })}
      </main>
    </div>
  );
}
