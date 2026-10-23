import { useEffect, useRef, useState } from 'preact/hooks';
import { formatDate, formatTime } from '@billiardum/shared/format';
import { newIdempotencyKey } from '@billiardum/shared/api';
import { Icon } from '../../components/Icon.jsx';
import { ErrorNote } from '../../components/ErrorNote.jsx';
import { CopyButton } from '../../components/InviteShare.jsx';
import { api } from '../../lib/api.js';
import { paymentCheckView, shopBody, shopErrors, shopView, webhookUrl } from '../../lib/onboarding.js';

const TABS = [
  ['test', 'Тестовый магазин'],
  ['live', 'Боевой магазин'],
];

/**
 * Шаг «ЮKassa» (№154): у клуба два магазина — тестовый и боевой. Деньги гостей идут клубу, в его магазин.
 * Секрет после сохранения виден только маской; сервер проверяет пару ключей в ЮKassa (GET /v3/me).
 * Проверочный платёж 1 ₽ с возвратом проверяет и уведомления (вебхук). В боевом режиме правка — с причиной.
 */
export function PaymentsStep({ ctx, ob, reload, live }) {
  const clubId = ctx.club.club_id;
  const [tab, setTab] = useState(live ? 'live' : 'test');
  const tabs = useRef({});
  const hook = webhookUrl(globalThis.location?.origin, clubId, ob.webhook_url);

  const onKey = (e) => {
    const i = TABS.findIndex(([id]) => id === tab);
    const next = e.key === 'ArrowRight' ? TABS[(i + 1) % 2][0] : e.key === 'ArrowLeft' ? TABS[(i + 1) % 2][0] : null;
    if (!next) return;
    e.preventDefault();
    setTab(next);
    tabs.current[next]?.focus();
  };

  return (
    <div class="stack ob__content">
      <p class="lead">Подключите магазины ЮKassa вашего клуба: деньги гостей идут сразу клубу. Тестовый — для проверки сейчас, боевой — для запуска.</p>

      <section class="panel" aria-labelledby="hook-title">
        <h3 class="section-title" id="hook-title">
          Адрес для уведомлений ЮKassa
        </h3>
        <p class="hint">Без него свет не включится после оплаты: ЮKassa сообщает об оплате на этот адрес.</p>
        <p class="hookurl mono" id="hook-url">
          {hook}
        </p>
        <CopyButton text={hook} label="Скопировать адрес" />
        <ol class="howto">
          <li>
            <span>Откройте личный кабинет ЮKassa и выберите магазин клуба.</span>
          </li>
          <li>
            <span>Раздел «Интеграция» → «HTTP-уведомления»: вставьте адрес выше.</span>
          </li>
          <li>
            <span>Отметьте события об успешном платеже, отмене платежа и возврате, сохраните.</span>
          </li>
          <li>
            <span>Сделайте так в обоих магазинах — тестовом и боевом.</span>
          </li>
        </ol>
      </section>

      <div class="tabs" role="tablist" aria-label="Магазины ЮKassa">
        {TABS.map(([id, label]) => (
          <button
            type="button"
            role="tab"
            key={id}
            id={`shop-tab-${id}`}
            ref={(el) => (tabs.current[id] = el)}
            class="tabs__tab"
            aria-selected={tab === id ? 'true' : 'false'}
            aria-controls={`shop-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            onKeyDown={onKey}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`shop-panel-${tab}`} aria-labelledby={`shop-tab-${tab}`} class="tabs__panel">
        <Shop key={tab} mode={tab} clubId={clubId} ob={ob} reload={reload} live={live} timeZone={ctx.timeZone} />
      </div>
      <Reception clubId={clubId} live={live} reload={reload} />
    </div>
  );
}

/**
 * Касса ресепшена (пункт чек-листа kkt): включена — гости могут платить на ресепшене наличными и картой,
 * чек пробивает ККТ клуба через мост; выключена — только онлайн. PATCH …/payment-settings { reception_enabled, reason? }.
 */
function Reception({ clubId, live, reload }) {
  const [settings, setSettings] = useState(undefined);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    api
      .clubPaymentSettings(clubId)
      .then((r) => setSettings(r?.settings ?? null))
      .catch((err) => {
        setSettings(null);
        if (err?.code !== 'not_found') setError(err);
      });
  }, [clubId]);
  if (settings === undefined) return null;
  const on = settings?.reception_enabled === true;
  const toggle = async () => {
    setTried(true);
    if (live && !reason.trim()) {
      document.getElementById('rcp-reason')?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.updateClubPaymentSettings(clubId, { reception_enabled: !on, ...(live ? { reason: reason.trim() } : {}) });
      setSettings(res?.settings ?? res ?? { ...settings, reception_enabled: !on });
      setReason('');
      setTried(false);
      reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="panel" aria-labelledby="rcp-title">
      <h3 class="section-title" id="rcp-title">
        Касса ресепшена
      </h3>
      <p class={`badge rcp-state ${on ? 'badge--free' : 'badge--off'}`}>
        <Icon name={on ? 'check' : 'minus'} />
        {on ? 'Включена: оплата на ресепшене, чек — ККТ клуба' : 'Выключена: гости платят только онлайн'}
      </p>
      <p class="hint">
        {on
          ? 'Перед запуском мост ККТ должен быть на связи, а ККТ — фискальной: это пункт чек-листа. Настройка моста — на экране «Касса ККТ».'
          : 'Включите, если ресепшн будет принимать наличные и карту и продавать бар. Понадобится ККТ клуба и мост — экран «Касса ККТ».'}
      </p>
      {live ? (
        <div class="field">
          <label class="field__label" for="rcp-reason">
            Причина
          </label>
          <textarea id="rcp-reason" class="field__input field__input--area" rows={2} maxLength={300} value={reason} aria-invalid={tried && !reason.trim() ? 'true' : undefined} aria-describedby="rcp-reason-e" onInput={(e) => setReason(e.currentTarget.value)} />
          <p class={tried && !reason.trim() ? 'field__error' : 'field__hint'} id="rcp-reason-e">
            {tried && !reason.trim() ? 'Клуб в боевом режиме: без причины не изменить.' : 'Уйдёт в журнал и владельцу в уведомлении.'}
          </p>
        </div>
      ) : null}
      <ErrorNote error={error} />
      <button type="button" class="btn btn--secondary" disabled={busy} onClick={toggle}>
        {busy ? 'Сохраняем…' : on ? 'Выключить кассу ресепшена' : 'Включить кассу ресепшена'}
      </button>
    </section>
  );
}

function Shop({ mode, clubId, ob, reload, live, timeZone }) {
  const [settings, setSettings] = useState(undefined);
  const [form, setForm] = useState({ shop_id: '', secret_key: '', reason: '' });
  const [editing, setEditing] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api
      .paymentSettings(clubId, mode)
      .then((s) => {
        setSettings(s ?? null);
        setForm((f) => ({ ...f, shop_id: s?.shop_id ?? '' }));
        setEditing(!s?.shop_id);
      })
      .catch((err) => {
        if (err?.code === 'not_found') {
          setSettings(null);
          setEditing(true);
        } else setError(err);
      });
  }, [clubId, mode]);

  const view = shopView(settings, mode);
  const errors = shopErrors(form, { hasSecret: view.configured, live });
  const show = (k) => tried && errors[k];

  const save = async (e) => {
    e.preventDefault();
    setTried(true);
    if (Object.keys(errors).length) {
      document.getElementById(`shop-${Object.keys(errors)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const s = await api.savePaymentSettings(clubId, mode, shopBody(form, { live }));
      setSettings(s);
      setForm({ shop_id: s?.shop_id ?? form.shop_id, secret_key: '', reason: '' });
      setEditing(false);
      setTried(false);
      setSaved(true);
      reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (settings === undefined && !error) return <p class="muted loading">Загружаем магазин…</p>;

  return (
    <div class="stack">
      <p class="hint">
        {mode === 'test'
          ? 'Тестовый магазин создаётся в кабинете ЮKassa отдельно, ключ начинается с test_. Им оплачиваются игры, пока клуб в тестовом режиме: деньги не списываются.'
          : 'Боевой магазин — тот, где ЮKassa принимает настоящие деньги, ключ начинается с live_. В нём должны быть включены чеки по 54-ФЗ.'}
      </p>

      {view.configured ? (
        <div class="shop">
          <dl class="facts facts--compact">
            <div>
              <dt>Магазин</dt>
              <dd class="mono">{settings.shop_id}</dd>
            </div>
            <div>
              <dt>Секретный ключ</dt>
              <dd class="mono">{view.mask ?? 'сохранён'}</dd>
            </div>
            {settings.verified_at ? (
              <div>
                <dt>Проверен</dt>
                <dd>
                  {formatDate(settings.verified_at, timeZone)}, {formatTime(settings.verified_at, timeZone)}
                </dd>
              </div>
            ) : null}
          </dl>
          <ul class="shop__flags">
            {view.flags.map((f) => (
              <li key={f.id} class={`badge ${f.ok ? 'badge--free' : 'badge--alert'}`}>
                <Icon name={f.ok ? 'check' : 'alert'} />
                {f.text}
              </li>
            ))}
          </ul>
          {saved ? (
            <p class="note note--free" role="status">
              <Icon name="check" />
              <span class="note__title">Магазин сохранён и проверен в ЮKassa.</span>
            </p>
          ) : null}
          {!editing ? (
            <button type="button" class="btn btn--quiet btn--sm" onClick={() => setEditing(true)}>
              <Icon name="edit" />
              Поменять магазин или ключ
            </button>
          ) : null}
        </div>
      ) : null}

      {editing ? (
        <form class="form shop__form" onSubmit={save} noValidate>
          <div class="field">
            <label class="field__label" for="shop-shop_id">
              Идентификатор магазина (shopId)
            </label>
            <input
              id="shop-shop_id"
              class="field__input mono"
              inputMode="numeric"
              autoComplete="off"
              value={form.shop_id}
              aria-invalid={show('shop_id') ? 'true' : undefined}
              aria-describedby="shop-shop_id-e"
              onInput={(e) => setForm({ ...form, shop_id: e.currentTarget.value })}
            />
            <p class={show('shop_id') ? 'field__error' : 'field__hint'} id="shop-shop_id-e">
              {show('shop_id') || 'Кабинет ЮKassa → «Интеграция» → «Ключи API».'}
            </p>
          </div>
          <div class="field">
            <label class="field__label" for="shop-secret_key">
              Секретный ключ
            </label>
            <input
              id="shop-secret_key"
              class="field__input mono"
              type="password"
              autoComplete="new-password"
              spellcheck={false}
              value={form.secret_key}
              aria-invalid={show('secret_key') ? 'true' : undefined}
              aria-describedby="shop-secret_key-e"
              onInput={(e) => setForm({ ...form, secret_key: e.currentTarget.value })}
            />
            <p class={show('secret_key') ? 'field__error' : 'field__hint'} id="shop-secret_key-e">
              {show('secret_key') || (view.configured ? 'Оставьте пустым, чтобы не менять сохранённый ключ. Целиком ключ больше нигде не показывается.' : 'После сохранения ключ виден только по последним символам.')}
            </p>
          </div>
          {live ? (
            <div class="field">
              <label class="field__label" for="shop-reason">
                Причина изменения
              </label>
              <textarea
                id="shop-reason"
                class="field__input field__input--area"
                rows={2}
                maxLength={300}
                value={form.reason}
                aria-invalid={show('reason') ? 'true' : undefined}
                aria-describedby="shop-reason-e"
                onInput={(e) => setForm({ ...form, reason: e.currentTarget.value })}
              />
              <p class={show('reason') ? 'field__error' : 'field__hint'} id="shop-reason-e">
                {show('reason') || 'Клуб в боевом режиме: изменение попадёт в журнал, владельцу придёт тревога.'}
              </p>
            </div>
          ) : null}
          <ErrorNote error={error} />
          <div class="row">
            <button type="submit" class="btn btn--primary" disabled={busy}>
              {busy ? 'Проверяем в ЮKassa…' : 'Сохранить и проверить'}
            </button>
            {view.configured ? (
              <button
                type="button"
                class="btn btn--quiet"
                onClick={() => {
                  setEditing(false);
                  setTried(false);
                  setError(null);
                  setForm({ shop_id: settings.shop_id, secret_key: '', reason: '' });
                }}
              >
                Не менять
              </button>
            ) : null}
          </div>
        </form>
      ) : null}

      {view.verified ? <PaymentCheck mode={mode} clubId={clubId} check={ob.payment_checks?.[mode] ?? null} reload={reload} /> : null}
    </div>
  );
}

/** «Проверочный платёж 1 ₽» (№154): платёж с автоматическим возвратом; статус — из GET …/onboarding. */
function PaymentCheck({ mode, clubId, check, reload }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [payUrl, setPayUrl] = useState(null);
  const key = useRef(null);
  const view = paymentCheckView(check);

  // Пока ЮKassa не ответила — перечитываем статус каждые 2,5 с
  useEffect(() => {
    if (!view?.polling) return undefined;
    const t = setInterval(reload, 2500);
    return () => clearInterval(t);
  }, [view?.polling, reload]);

  const run = async () => {
    setBusy(true);
    setError(null);
    key.current = key.current ?? newIdempotencyKey();
    try {
      const res = await api.checkPayment(clubId, mode, key.current);
      key.current = null;
      // Боевой магазин: если ЮKassa ждёт оплату картой, сервер может вернуть страницу оплаты (допущение)
      setPayUrl(typeof res?.confirmation_url === 'string' && /^https:\/\//.test(res.confirmation_url) ? res.confirmation_url : null);
      await reload();
    } catch (err) {
      setError(err?.code === 'not_configured' ? { code: 'shop_invalid' } : err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="panel" aria-labelledby={`check-${mode}`}>
      <h3 class="section-title" id={`check-${mode}`}>
        Проверочный платёж 1 ₽
      </h3>
      <p class="hint">
        {mode === 'test'
          ? 'Обязательно для тестового режима. Платёж пройдёт в тестовом магазине и сразу вернётся — так проверяются и ключи, и уведомления.'
          : 'Рекомендуем перед запуском: 1 ₽ пройдёт через боевой магазин и сразу вернётся.'}
      </p>
      {view ? (
        <div class={`note ${view.tone === 'ok' ? 'note--free' : view.tone === 'bad' ? 'note--error' : 'note--lamp'}`} role="status">
          <Icon name={view.tone === 'ok' ? 'check' : view.tone === 'bad' ? 'alert' : 'clock'} />
          <p class="note__title">{view.title}</p>
          <p class="note__body">{view.text}</p>
        </div>
      ) : null}
      {payUrl && view?.tone === 'wait' ? (
        <a class="btn btn--lamp" href={payUrl} target="_blank" rel="noopener noreferrer">
          <Icon name="external" />
          Оплатить 1 ₽ на странице ЮKassa
        </a>
      ) : null}
      <ErrorNote error={error} />
      <button type="button" class={`btn ${view?.tone === 'ok' ? 'btn--secondary' : 'btn--primary'}`} disabled={busy || view?.tone === 'wait'} onClick={run}>
        {busy ? 'Отправляем…' : view ? 'Отправить проверочный платёж ещё раз' : 'Отправить проверочный платёж 1 ₽'}
      </button>
    </section>
  );
}
