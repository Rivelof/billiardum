import { useEffect, useState } from 'preact/hooks';
import { formatDate, formatMoney, plural } from '@billiardum/shared/format';
import { availableChannels, channelsOrder, moveChannel, primaryChannel } from '@billiardum/shared/booking';
import { Header } from '../components/Header.jsx';
import { Icon } from '../components/Icon.jsx';
import { Dialog } from '../components/Dialog.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { SignedInAs } from '../components/SignedInAs.jsx';
import { SignIn } from './SignIn.jsx';
import { api } from '../lib/api.js';
import { auth } from '../lib/auth.js';
import { useStore } from '../lib/store.js';
import { linkHandler } from '../lib/router.js';
import { BASE, MOCK } from '../lib/env.js';
import { minutesWords, perHour } from '../lib/words.js';
import { isIos, isStandalone, pushAvailability } from '../lib/platform.js';
import { subscribePush } from '../lib/push.js';
import { safeRedirectUrl } from '../lib/urls.js';
import { getFlow, lastClub, setFlow } from '../lib/flow.js';
import '../styles/m3.css';

const DAYS = ['день', 'дня', 'дней'];
const CHANNEL = {
  max: { name: 'MAX', sub: 'Бот Бильярдума в MAX' },
  telegram: { name: 'Telegram', sub: 'Бот Бильярдума в Telegram' },
  webpush: { name: 'Уведомления браузера', sub: 'Web Push на этом устройстве' },
};

/** Профиль: часы пакетов на балансе, покупка пакета, брони и уведомления (M3, №112). */
export function ProfileScreen({ search }) {
  const { status, user } = useStore(auth);
  const paidReturn = new URLSearchParams(search).get('paid') === 'package';
  const [balance, setBalance] = useState(null);
  const [club, setClub] = useState(null);
  const [packages, setPackages] = useState(null);
  const [buying, setBuying] = useState(null);
  const [error, setError] = useState(null);
  const [waiting, setWaiting] = useState(paidReturn);

  const loadBalance = async (c = club) => {
    if (!c) return null;
    try {
      const b = await api.balance(c.id);
      setBalance(b ?? { minutes: 0, lots: [] });
      return b;
    } catch (err) {
      setError(err);
      return null;
    }
  };

  useEffect(() => {
    if (status !== 'user') return;
    // Клуб: тот, где гость открывал стол, если он в списке клубов (GET /api/clubs, №120), иначе первый
    api
      .clubs()
      .then((list) => {
        const all = Array.isArray(list) ? list : [];
        return all.find((c) => c.id === lastClub()?.id) ?? all[0] ?? lastClub();
      })
      .catch(() => lastClub())
      .then(async (c) => {
        setClub(c ?? null);
        if (!c) {
          setBalance({ minutes: 0, lots: [] });
          return;
        }
        loadBalance(c);
        setPackages(await api.packages(c.id).catch(() => []));
      });
  }, [status]);

  // Вернулись с оплаты пакета (return_url /app/me?paid=package): часы появляются после подтверждения ЮKassa —
  // опрашиваем полминуты, пока баланс не вырастет относительно того, что был до оплаты
  useEffect(() => {
    if (!paidReturn || status !== 'user' || !club) return undefined;
    const before = Date.now();
    const was = getFlow().balanceBefore ?? 0;
    const t = setInterval(async () => {
      const b = await loadBalance(club);
      if ((b?.minutes ?? 0) > was || Date.now() - before > 30000) {
        setFlow({ balanceBefore: null });
        clearInterval(t);
        setWaiting(false);
      }
    }, 3000);
    return () => clearInterval(t);
  }, [paidReturn, status, club?.id]);

  const primary = primaryChannel(user);

  return (
    <div class="screen screen--paper">
      <Header back={{ href: BASE, label: 'На главную' }} />
      <main class="wrap content profile">
        <h1 class="page-title display">Профиль</h1>
        {status === 'anon' ? <SignIn title="Войдите, чтобы открыть профиль" /> : null}
        {status === 'user' ? <SignedInAs always /> : null}
        <ErrorNote error={error} />

        {status === 'user' ? (
          <>
            <section aria-labelledby="pr-bal">
              <h2 class="step__label" id="pr-bal">
                Часы на балансе
              </h2>
              {paidReturn && waiting ? (
                <p class="waiting" role="status">
                  <span class="waiting__dot" aria-hidden="true" />
                  Пакет оплачен — часы появятся здесь через несколько секунд.
                </p>
              ) : null}
              {balance === null ? <p class="muted loading">Загружаем…</p> : null}
              {balance?.minutes > 0 ? (
                <div class="balance">
                  <span class="balance__hours display">{minutesWords(balance.minutes)}</span>
                  <span class="balance__sub">{club?.name ?? 'В клубе'}</span>
                  {balance.lots?.length ? (
                    <ul class="lots" aria-label="Пакеты на балансе">
                      {balance.lots.map((l) => (
                        <li key={l.id}>
                          <span>{minutesWords(l.minutes_left)}</span>
                          <span class="lots__until">до {formatDate(l.expires_at, club?.timezone ?? 'Europe/Moscow')}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <span class="hint">Сначала списываются часы, которые сгорят раньше. Оплатите ими игру у стола — при оплате выберите часы пакета.</span>
                </div>
              ) : balance ? (
                <p class="empty">Пакетов пока нет. Пакет — это часы игры дешевле, чем по тарифу: ими можно оплатить игру у стола.</p>
              ) : null}
            </section>

            {packages?.length ? (
              <section aria-labelledby="pr-pk">
                <h2 class="step__label" id="pr-pk">
                  Пакеты часов{club?.name ? ` · ${club.name}` : ''}
                </h2>
                <ul class="packs">
                  {packages
                    .filter((p) => p.active !== false)
                    .map((p) => (
                      <li class="pack" key={p.id}>
                        <p class="pack__name">{p.title}</p>
                        <p class="pack__price display">{formatMoney(p.price_kopecks)}</p>
                        <p class="pack__sub">
                          {minutesWords(p.minutes)} · {perHour(Math.round(p.price_kopecks / (p.minutes / 60) / 100) * 100)} · действует {p.valid_days} {plural(p.valid_days, DAYS)}
                        </p>
                        <button type="button" class="btn btn--secondary btn--block" onClick={() => setBuying(p)}>
                          <Icon name="ticket" />
                          Купить за {formatMoney(p.price_kopecks)}
                        </button>
                      </li>
                    ))}
                </ul>
              </section>
            ) : null}

            <nav class="plinks" aria-label="Разделы профиля">
              <a class="plinks__item" href={`${BASE}bookings`} onClick={linkHandler}>
                <Icon name="calendar" />
                <span>Мои брони</span>
                <Icon name="forward" />
              </a>
              <a class="plinks__item" href={`${BASE}me/notify`} onClick={linkHandler}>
                <Icon name="bell" />
                <span>
                  Уведомления
                  <span class="plinks__sub">{primary ? `Основной канал — ${CHANNEL[primary]?.name ?? primary}` : 'Каналы пока не настроены'}</span>
                </span>
                <Icon name="forward" />
              </a>
              <a class="plinks__item" href={`${BASE}privacy`} onClick={linkHandler}>
                <Icon name="shield" />
                <span>Обработка персональных данных</span>
                <Icon name="forward" />
              </a>
            </nav>
          </>
        ) : null}
      </main>
      <BuyDialog pack={buying} balanceBefore={balance?.minutes ?? 0} onClose={() => setBuying(null)} />
    </div>
  );
}

function BuyDialog({ pack, balanceBefore = 0, onClose }) {
  const [method, setMethod] = useState('sbp');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    setError(null);
    setBusy(false);
  }, [pack?.id]);
  const buy = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.buyPackage(pack.id, method);
      const url = safeRedirectUrl(res?.confirmation?.url ?? res?.confirmation?.confirmation_url);
      if (!url) throw Object.assign(new Error('confirmation'), { code: 'payment_failed' });
      // return_url ЮKassa — /app/me?paid=package: профиль дождётся часов на балансе
      setFlow({ kind: 'package', paymentId: res.payment_id, balanceBefore });
      window.location.assign(url);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Dialog open={Boolean(pack)} onClose={onClose} title={pack ? `Пакет «${pack.title}»` : ''} labelledBy="buy-title">
      {pack ? (
        <div class="step">
          <p class="lead">
            {minutesWords(pack.minutes)} игры за <b>{formatMoney(pack.price_kopecks)}</b>. Часы лягут на баланс в клубе и действуют {pack.valid_days} {plural(pack.valid_days, DAYS)}. Чек придёт сразу после оплаты.
          </p>
          <div class="choice choice--methods choice--pair">
            {[
              ['sbp', 'transfer', 'СБП'],
              ['card', 'card', 'Картой'],
            ].map(([m, icon, title]) => (
              <label class="choice__item" key={m}>
                <input type="radio" name="buy-method" checked={method === m} onChange={() => setMethod(m)} />
                <span class="choice__box choice__box--row">
                  <Icon name={icon} />
                  <span class="choice__title">{title}</span>
                </span>
              </label>
            ))}
          </div>
          <ErrorNote error={error} />
          <button type="button" class="btn btn--primary btn--block btn--lg" disabled={busy} onClick={buy}>
            {busy ? 'Открываем оплату…' : `Оплатить ${formatMoney(pack.price_kopecks)}`}
          </button>
        </div>
      ) : null}
    </Dialog>
  );
}

/**
 * Каналы уведомлений (PRODUCT §12, №110): основной канал и порядок запасных. Не доставилось основным — пробуем следующий.
 * PATCH /api/me { notify_channel, channels_order }. На iPhone Web Push работает только с экрана «Домой».
 */
export function NotifyScreen() {
  const { status, user } = useStore(auth);
  // Подключённые каналы — user.channels { max, telegram, webpush } из GET /api/me (№120); Web Push, включённый
  // только что на этом устройстве, — сразу, не дожидаясь перечитывания профиля
  const [pushOn, setPushOn] = useState(false);
  const linked = { ...(user?.channels ?? {}), webpush: pushOn || Boolean(user?.channels?.webpush) };
  // Предлагаем только каналы, настроенные на сервере (№126: channels_available); основной по умолчанию — первый из них
  const available = availableChannels(user);
  const [primary, setPrimary] = useState(() => primaryChannel(user));
  const [order, setOrder] = useState(() => channelsOrder(user?.channels_order, primaryChannel(user), available));
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const iosHint = pushAvailability() === 'ios-install' || (isIos() && !isStandalone());

  useEffect(() => {
    if (!user) return;
    setPrimary(primaryChannel(user));
    setOrder(channelsOrder(user.channels_order, primaryChannel(user), availableChannels(user)));
  }, [user?.notify_channel, (user?.channels_order ?? []).join(), available.join()]);

  const choose = (c) => {
    setPrimary(c);
    setOrder((o) => channelsOrder(o, c, available));
    setSaved(false);
  };
  const move = (c, dir) => {
    setOrder((o) => {
      const next = moveChannel(o, c, dir);
      setPrimary(next[0] && linked[next[0]] ? next[0] : primary);
      return next;
    });
    setSaved(false);
  };

  const save = async () => {
    setBusy('save');
    setError(null);
    try {
      const res = await api.updateMe({ notify_channel: primary, channels_order: channelsOrder(order, primary, available) });
      if (res?.user) auth.set((s) => ({ user: { ...s.user, ...res.user } }));
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const connect = async (c) => {
    setBusy(c);
    setError(null);
    try {
      if (c === 'webpush') {
        // В заглушке разработки сервис-воркера нет — подписку изображает сервер заглушки
        const r = MOCK ? (await api.pushSubscribe({ endpoint: 'mock' }), 'done') : await subscribePush();
        if (r !== 'done') throw Object.assign(new Error('denied'), { code: 'push_denied' });
        setPushOn(true);
      } else {
        const res = await api.botLink(c);
        const url = safeRedirectUrl(res?.deep_link);
        if (url) window.location.assign(url);
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div class="screen screen--paper">
      <Header back={{ href: `${BASE}me`, label: 'Профиль' }} />
      <main class="wrap content profile">
        <h1 class="page-title display">Уведомления</h1>
        <p class="lead">Напомним о конце игры и брони, сообщим, когда освободится стол. Не дошло основным каналом — пробуем следующий по списку.</p>
        {status === 'anon' ? <SignIn title="Войдите, чтобы настроить уведомления" /> : null}

        {status === 'user' ? (
          <>
            {!available.length ? <p class="empty">Уведомления в клубе пока не настроены. О конце игры напомнит сам стол: за 5 минут индикатор замигает жёлтым и прозвучит короткий сигнал.</p> : null}
            <fieldset class="channels" hidden={!available.length}>
              <legend class="step__label">Каналы по порядку</legend>
              <ol class="chlist">
                {order.map((c, i) => {
                  const on = Boolean(linked[c]);
                  const meta = CHANNEL[c];
                  return (
                    <li class={`chan${primary === c ? ' chan--primary' : ''}`} key={c}>
                      <label class="chan__pick">
                        <input type="radio" name="primary" checked={primary === c} disabled={!on} onChange={() => choose(c)} />
                        <span class="chan__text">
                          <span class="chan__name">
                            {meta.name}
                            {primary === c ? <span class="chan__tag">основной</span> : null}
                          </span>
                          <span class={`chan__state${on ? ' chan__state--on' : ''}`}>
                            <Icon name={on ? 'check' : 'info'} />
                            {on ? 'Подключён' : 'Не подключён'}
                            {c === 'telegram' ? ' · в России работает с перебоями' : ''}
                          </span>
                        </span>
                      </label>
                      {!on ? (
                        <button type="button" class="btn btn--secondary btn--sm chan__connect" disabled={busy === c} onClick={() => connect(c)}>
                          {busy === c ? 'Подключаем…' : c === 'webpush' ? 'Включить на этом устройстве' : `Подключить ${meta.name}`}
                        </button>
                      ) : null}
                      {order.length > 1 ? (
                        <span class="chan__tools">
                          <button type="button" class="icon-btn" disabled={i === 0} aria-label={`${meta.name}: выше в списке`} onClick={() => move(c, -1)}>
                            <Icon name="up" />
                          </button>
                          <button type="button" class="icon-btn" disabled={i === order.length - 1} aria-label={`${meta.name}: ниже в списке`} onClick={() => move(c, 1)}>
                            <Icon name="down" />
                          </button>
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </fieldset>

            {iosHint ? (
              <section class="note note--lamp" aria-labelledby="ios-title">
                <Icon name="phone" />
                <h2 class="note__title" id="ios-title">
                  На iPhone — сначала «На экран Домой»
                </h2>
                <p class="note__body">
                  Уведомления браузера на iPhone приходят, только если Бильярдум добавлен на экран «Домой»: нажмите «Поделиться» внизу Safari, затем «На экран Домой» и откройте Бильярдум с
                  иконки. Нужна iOS 16.4 или новее.
                </p>
              </section>
            ) : null}

            <p class="hint hint--icon">
              <Icon name="bell" />
              Режим «Не беспокоить» мы не обходим — поэтому у стола всегда есть свой сигнал о конце игры.
            </p>
            <ErrorNote error={error} />
            {saved ? (
              <p class="note note--free" role="status">
                <Icon name="check" />
                <span class="note__title">Сохранили: основной канал — {CHANNEL[primary]?.name ?? primary}.</span>
              </p>
            ) : null}
            <div class="actionbar">
              <button type="button" class="btn btn--primary btn--block btn--lg" disabled={busy === 'save' || !primary} onClick={save}>
                {busy === 'save' ? 'Сохраняем…' : 'Сохранить'}
              </button>
            </div>
          </>
        ) : null}
      </main>
    </div>
  );
}

