import { useState } from 'preact/hooks';
import { Shell, navItems } from '../components/Shell.jsx';
import { Icon } from '../components/Icon.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { api, getTerminal, setTerminal } from '../lib/api.js';
import { auth, can, logout, platformRole } from '../lib/auth.js';
import { useStore } from '../lib/store.js';
import { navigate, linkHandler } from '../lib/router.js';
import { BASE } from '../lib/env.js';
import { ROLE_LABEL } from '../lib/words.js';
import { pinMinLength, pinValid } from '../lib/terminals.js';

/** «Ещё»: QR-наклейки (PDF), терминал ресепшена, выход. */
export function More({ ctx }) {
  const { club, role, user, timeZone } = ctx;
  const { principal } = useStore(auth);
  return (
    <Shell club={club} role={role} user={user} timeZone={timeZone} active="more" title="Ещё">
      <div class="page more">
        <section class="panel">
          <h2 class="section-title">Вы</h2>
          <NameForm user={user} />
          <p>
            {user?.name ?? user?.phone_masked ?? 'Сотрудник'}, {ROLE_LABEL[role]?.toLowerCase() ?? role}
          </p>
          <button
            type="button"
            class="btn btn--quiet"
            onClick={async () => {
              await logout().catch(() => {});
              navigate(`${BASE}signin`, { replace: true });
            }}
          >
            <Icon name="logout" />
            Выйти
          </button>
          {can.owner(role) ? (
            <a class="btn btn--link" href={`${BASE}start`} onClick={linkHandler}>
              Подключить ещё клуб
            </a>
          ) : null}
        </section>
        {platformRole(user) ? (
          <section class="panel">
            <h2 class="section-title">Платформа Бильярдум</h2>
            <p class="hint">Заявки гостей в клубы без программы, заявки клубов, модерация карточек и жалоб.</p>
            <a class="btn btn--secondary" href={`${BASE}platform`} onClick={linkHandler}>
              <Icon name="report" />
              Экран оператора
            </a>
          </section>
        ) : null}
        <Sections role={role} clubId={club.club_id} />
        {can.manage(role) ? <Stickers clubId={club.club_id} /> : null}
        {can.setPin(role) && principal === 'session' ? <SetPin clubId={club.club_id} role={role} /> : null}
        {can.terminal(role) ? <Terminal clubId={club.club_id} /> : null}
      </div>
    </Shell>
  );
}

const SECTION_HINT = {
  pos: 'Продажа бара, заявки и счета столов: наличные, карта, СБП.',
  reception: 'Очередь заявок «Оплачу на ресепшене» и зал.',
  bar: 'Очередь заказов бара крупно, для ТВ или планшета.',
  stock: 'Остатки, приход, списание, ревизия.',
  menu: 'Товары, модификаторы, стоп-лист, импорт CSV.',
  kkt: 'Мост к кассе клуба: подключение и состояние.',
  devices: 'Контроллеры столов: связь, прошивка, привязка.',
  tournaments: 'Создание, запись со взносом, сетка и ТВ-экран.',
  disputes: 'Оспоренные партии Бильярдум+ — решение с причиной.',
  listing: 'Карточка клуба на сайте Бильярдума и ответы на отзывы.',
  bookings: 'Брони на день: лента по столам, бронь по телефону.',
  packages: 'Пакеты часов: продажа и возврат.',
  staff: 'Сотрудники, роли и терминалы ресепшена.',
  onboarding: 'Мастер подключения: зал, тарифы, ЮKassa, контроллеры, запуск.',
  subscription: 'План, счета и карта для оплаты программы Бильярдума.',
  api: 'Ключи API для CRM и сайта, вебхуки о играх, бронях и сменах.',
};

const SUBSCRIPTION_STATE_HINT = 'Состояние подписки клуба на Бильярдум.';

const SETUP_HINT = 'План зала, тарифы, меню из Excel, QR-наклейки.';

/** Разделы, которых нет в нижней панели телефона (у владельца и управляющего). */
function Sections({ role, clubId }) {
  const items = navItems(role, clubId).filter((it) => it.wideOnly);
  if (!items.length) return null;
  return (
    <section class="panel panel--sections" aria-labelledby="sections-title">
      <h2 class="section-title" id="sections-title">
        Разделы
      </h2>
      <ul class="sections">
        {items.map((it) => (
          <li key={it.key}>
            <a class="sections__link" href={it.href} onClick={linkHandler}>
              <Icon name={it.icon} />
              <span>
                <span class="sections__name">{it.key === 'kkt' ? 'Касса ККТ' : it.key === 'api' ? 'API и вебхуки' : it.label}</span>
                <span class="sections__hint">{it.key === 'onboarding' && !can.onboarding(role) ? SETUP_HINT : it.key === 'subscription' && !can.subscriptionManage(role) ? SUBSCRIPTION_STATE_HINT : SECTION_HINT[it.key]}</span>
              </span>
              <Icon name="forward" class="sections__go" />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Stickers({ clubId }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.qrStickers(clubId);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'billiardum-qr-stickers.pdf';
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="panel">
      <h2 class="section-title">QR-наклейки на столы</h2>
      <p class="hint">PDF на A4: по наклейке на каждый стол — QR-код, номер стола и короткий код. Распечатайте и наклейте у стола.</p>
      <ErrorNote error={error} />
      <button type="button" class="btn btn--primary" disabled={busy} onClick={download}>
        <Icon name="download" />
        {busy ? 'Готовим PDF…' : 'Скачать QR-наклейки (PDF)'}
      </button>
    </section>
  );
}

/** Имя сотрудника — им подписаны действия в журнале и выбор на терминале (PATCH /api/me, §14). */
function NameForm({ user }) {
  const [name, setName] = useState(user?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    const value = name.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateMe({ name: value });
      auth.set((s) => ({ user: s.user ? { ...s.user, name: value } : s.user }));
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="form pinset" onSubmit={submit}>
      <div class="field">
        <label class="field__label" for="me-name">
          Ваше имя в программе клуба
        </label>
        <input id="me-name" class="field__input" maxLength={60} autoComplete="name" value={name} onInput={(e) => (setName(e.currentTarget.value), setSaved(false))} />
        <p class="field__hint">Им подписаны ваши действия в журнале и кнопка на терминале ресепшена.</p>
      </div>
      <ErrorNote error={error} />
      <button type="submit" class="btn btn--quiet" disabled={busy || !name.trim()}>
        {busy ? 'Сохраняем…' : saved ? 'Имя сохранено' : 'Сохранить имя'}
      </button>
    </form>
  );
}

/** Сотрудник задаёт себе PIN для быстрой смены на терминале (PUT /api/staff/pin, §14). */
function SetPin({ clubId, role }) {
  // Владелец и управляющий — ровно 6 цифр (ревью входа п. 5), остальные — 4–6
  const min = pinMinLength(role);
  const rule = min === 6 ? '6 цифр' : '4–6 цифр';
  const [pin, setPin] = useState('');
  const [repeat, setRepeat] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const valid = pinValid(pin, role);
  const same = pin === repeat;

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    if (!valid || !same) return;
    setBusy(true);
    setError(null);
    try {
      await api.setPin(clubId, pin);
      setDone(true);
      setPin('');
      setRepeat('');
      setTouched(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="panel">
      <h2 class="section-title">PIN для терминала</h2>
      <p class="hint">С PIN вы входите на общем планшете ресепшена за секунду, без мессенджера. Каждое действие подписано вашим именем.</p>
      {done ? (
        <p class="note note--free" role="status">
          <Icon name="check" />
          <span class="note__title">PIN сохранён.</span>
        </p>
      ) : null}
      <form class="form pinset" onSubmit={submit} noValidate>
        <div class="field">
          <label class="field__label" for="pin-new">
            Новый PIN, {rule}
          </label>
          <input
            id="pin-new"
            class="field__input mono"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={6}
            value={pin}
            aria-invalid={touched && !valid ? 'true' : undefined}
            aria-describedby={touched && !valid ? 'pin-new-err' : undefined}
            onInput={(e) => setPin(e.currentTarget.value.replace(/\D/g, '').slice(0, 6))}
          />
          {touched && !valid ? (
            <p class="field__error" id="pin-new-err">
              {min === 6 ? 'PIN владельца и управляющего — ровно 6 цифр: им подтверждают скидки выше лимита на кассе.' : 'PIN — от 4 до 6 цифр.'}
            </p>
          ) : null}
        </div>
        <div class="field">
          <label class="field__label" for="pin-repeat">
            Повторите PIN
          </label>
          <input
            id="pin-repeat"
            class="field__input mono"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={6}
            value={repeat}
            aria-invalid={touched && valid && !same ? 'true' : undefined}
            aria-describedby={touched && valid && !same ? 'pin-repeat-err' : undefined}
            onInput={(e) => setRepeat(e.currentTarget.value.replace(/\D/g, '').slice(0, 6))}
          />
          {touched && valid && !same ? (
            <p class="field__error" id="pin-repeat-err">
              PIN не совпадает.
            </p>
          ) : null}
        </div>
        <ErrorNote error={error} />
        <button type="submit" class="btn btn--primary" disabled={busy}>
          {busy ? 'Сохраняем…' : 'Сохранить PIN'}
        </button>
      </form>
    </section>
  );
}

function Terminal({ clubId }) {
  const [terminal, setTerm] = useState(getTerminal);
  const [name, setName] = useState('Ресепшн');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const register = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.registerTerminal(clubId, name.trim() || 'Ресепшн');
      const value = { token: res.terminal_token, id: res.terminal_id ?? null, name: name.trim() || 'Ресепшн', club_id: clubId, expires_at: res.expires_at ?? null };
      setTerminal(value);
      setTerm(value);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="panel">
      <h2 class="section-title">Терминал ресепшена</h2>
      {terminal ? (
        <>
          <p>
            Это устройство — терминал «{terminal.name}». Сотрудники меняются на нём по PIN без входа через бота.
          </p>
          <div class="row">
            <a class="btn btn--secondary" href={`${BASE}pin`} onClick={linkHandler}>
              <Icon name="key" />
              Сменить сотрудника по PIN
            </a>
            <button
              type="button"
              class="btn btn--quiet"
              onClick={() => {
                setTerminal(null);
                setTerm(null);
              }}
            >
              Забыть терминал на этом устройстве
            </button>
          </div>
        </>
      ) : (
        <form class="form" onSubmit={register}>
          <p class="hint">Сделайте общий планшет ресепшена терминалом: сотрудники будут меняться на нём по PIN, каждое действие подписано своим именем.</p>
          <div class="field">
            <label class="field__label" for="term-name">
              Название терминала
            </label>
            <input id="term-name" class="field__input" value={name} maxLength={40} onInput={(e) => setName(e.currentTarget.value)} />
          </div>
          <ErrorNote error={error} />
          <button type="submit" class="btn btn--primary" disabled={busy}>
            {busy ? 'Регистрируем…' : 'Сделать это устройство терминалом'}
          </button>
        </form>
      )}
    </section>
  );
}
