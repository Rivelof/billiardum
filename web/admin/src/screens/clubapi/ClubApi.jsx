import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { formatDate, formatTime } from '@billiardum/shared/format';
import { Shell } from '../../components/Shell.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Dialog } from '../../components/Dialog.jsx';
import { ErrorNote } from '../../components/ErrorNote.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { api } from '../../lib/api.js';
import { auth } from '../../lib/auth.js';
import { useStore } from '../../lib/store.js';
import { BASE } from '../../lib/env.js';
import { linkHandler } from '../../lib/router.js';
import {
  DELIVERY_FILTER,
  DELIVERY_STATUS,
  DOCS_PATH,
  EVENTS,
  EVENT_LABEL,
  MAX_KEYS,
  MAX_WEBHOOKS,
  PERSONAL_LOGIN_TEXT,
  SCOPES,
  SCOPE_LABEL,
  deliveryErrorText,
  hooksCountText,
  keyBody,
  keyFormErrors,
  keysCountText,
  lastDeliveryWords,
  webhookBody,
  webhookFormErrors,
  webhookServerError,
} from '../../lib/clubapi.js';
import '../../styles/clubapi.css';

const STATUS_ICON = { pending: 'clock', delivered: 'check', failed: 'alert', canceled: 'close' };

/**
 * M5.7 «API и вебхуки» (№199–202, server/clubapi/README.md): ключи API и адреса вебхуков клуба, журнал доставок.
 * Только владелец. Ключ и секрет — один раз; выпуск и регистрация — только личным входом (не PIN). Отдельный чанк.
 * webhookId — журнал доставок одного адреса (/club/c/{club}/api/webhooks/{id}, ссылка из уведомления о сбое).
 */
export function ClubApi({ ctx, webhookId }) {
  const { club, role, user, timeZone } = ctx;
  const { principal } = useStore(auth);
  const pin = principal === 'pin';
  const when = (iso) => `${formatDate(iso, timeZone)}, ${formatTime(iso, timeZone)}`;
  const base = `${BASE}c/${encodeURIComponent(club.club_id)}/api`;
  return (
    <Shell club={club} role={role} user={user} timeZone={timeZone} active="api" title="API">
      <div class="page capi">
        {pin ? (
          <div class="note note--lamp" id="capi-pin">
            <Icon name="lock" />
            <p class="note__title">Вы вошли по PIN на терминале</p>
            <p class="note__body">{PERSONAL_LOGIN_TEXT}</p>
          </div>
        ) : null}
        {webhookId ? <WebhookLog clubId={club.club_id} id={webhookId} base={base} when={when} /> : <Overview clubId={club.club_id} pin={pin} base={base} when={when} />}
        <Docs />
      </div>
    </Shell>
  );
}

function Docs() {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return (
    <section class="panel capi__docs" aria-labelledby="capi-docs">
      <h2 class="section-title" id="capi-docs">
        Для разработчиков
      </h2>
      <p>
        Описание API — в файле <code class="mono">{DOCS_PATH}</code> в репозитории Бильярдума: маршруты (OpenAPI 3.1), примеры curl, проверка подписи вебхука. Передайте его разработчику вместе с ключом.
      </p>
      <dl class="capi__facts">
        <div>
          <dt>Адрес API</dt>
          <dd>
            <code class="mono">{origin}/api/v1/club/…</code>
          </dd>
        </div>
        <div>
          <dt>Ключ</dt>
          <dd>
            заголовок <code class="mono">Authorization: Bearer blk_…</code>, только чтение, без данных гостей
          </dd>
        </div>
        <div>
          <dt>Лимит</dt>
          <dd>600 запросов в минуту на ключ, продажи — 60</dd>
        </div>
        <div>
          <dt>Подпись вебхука</dt>
          <dd>
            <code class="mono">X-Bl-Signature: v1=HMAC-SHA256(секрет, «X-Bl-Timestamp.тело»)</code>
          </dd>
        </div>
      </dl>
    </section>
  );
}

/** Ключи и адреса одним экраном. */
function Overview({ clubId, pin, base, when }) {
  const [keys, setKeys] = useState(null);
  const [hooks, setHooks] = useState(null);
  const [error, setError] = useState(null);
  const [issuing, setIssuing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [revoke, setRevoke] = useState(null);
  const [disable, setDisable] = useState(null);
  const [done, setDone] = useState(null);
  const [testing, setTesting] = useState(null);
  const load = useCallback(async () => {
    try {
      const [k, h] = await Promise.all([api.apiKeys(clubId), api.webhooks(clubId)]);
      setKeys(k);
      setHooks(h);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [clubId]);
  useEffect(() => {
    load();
  }, [load]);
  const sendTest = async (h) => {
    setTesting(h.webhook_id);
    setError(null);
    try {
      await api.testWebhook(clubId, h.webhook_id);
      setDone(`Тестовое событие ping отправлено на ${h.host}. Результат — в журнале доставок через несколько секунд.`);
      setTimeout(load, 4000);
    } catch (err) {
      setError(err);
    } finally {
      setTesting(null);
    }
  };
  const keyItems = Array.isArray(keys?.items) ? keys.items : [];
  const hookItems = Array.isArray(hooks?.items) ? hooks.items : [];
  const activeKeys = keys?.active ?? keyItems.filter((k) => k.active).length;
  const activeHooks = hooks?.active ?? hookItems.filter((h) => h.active).length;
  const keyLimit = keys?.limit ?? MAX_KEYS;
  const hookLimit = hooks?.limit ?? MAX_WEBHOOKS;
  return (
    <>
      <p class="lead capi__lead">Ключи API дают программам клуба (CRM, сайту, таблицам) читать столы, тарифы, свободное время, продажи и брони — без данных гостей. Вебхуки сами сообщают вашему серверу о начале и конце игр, бронях и закрытых сменах.</p>
      {done ? (
        <p class="note note--free" role="status">
          <Icon name="check" />
          <span class="note__title">{done}</span>
        </p>
      ) : null}
      <ErrorNote error={error}>
        <button type="button" class="btn btn--secondary btn--sm" onClick={load}>
          Повторить
        </button>
      </ErrorNote>

      <section class="panel" aria-labelledby="capi-keys">
        <div class="capi__head">
          <h2 class="section-title" id="capi-keys">
            Ключи API
          </h2>
          <button type="button" class="btn btn--primary btn--sm" onClick={() => setIssuing(true)} disabled={!keys || pin || activeKeys >= keyLimit} aria-describedby={pin ? 'capi-pin' : activeKeys >= keyLimit ? 'capi-keys-limit' : undefined}>
            <Icon name="key" />
            Выпустить ключ
          </button>
        </div>
        {keys ? (
          <p class={`small ${activeKeys >= keyLimit ? '' : 'muted'}`} id="capi-keys-limit">
            {keysCountText(activeKeys, keyLimit)}
            {activeKeys >= keyLimit ? '. Чтобы выпустить новый, отзовите ненужный.' : '.'}
          </p>
        ) : null}
        {!keys && !error ? (
          <p class="muted loading" role="status">
            Загружаем ключи…
          </p>
        ) : null}
        {keys && !keyItems.length ? <p class="muted">Ключей пока нет. Выпустите ключ для своей программы и передайте его разработчику.</p> : null}
        {keyItems.length ? (
          <ul class="capi__list">
            {keyItems.map((k) => (
              <li key={k.key_id} class={`capi__item${k.active ? '' : ' is-off'}`}>
                <div class="capi__row">
                  <p class="capi__name">{k.name}</p>
                  <span class={`badge ${k.active ? 'badge--free' : 'badge--off'}`}>
                    <Icon name={k.active ? 'check' : 'close'} />
                    {k.active ? 'Действует' : k.revoked_at ? `Отозван ${when(k.revoked_at)}` : 'Отозван'}
                  </span>
                </div>
                <p class="mono capi__prefix">{k.prefix}…</p>
                <p class="small">Права: {(k.scopes ?? []).map((s) => SCOPE_LABEL[s] ?? s).join(', ')}</p>
                <p class="small muted">
                  Выпустил {k.created_by_name ?? 'владелец'} {k.created_at ? when(k.created_at) : ''} · {k.last_used_at ? `последний запрос ${when(k.last_used_at)}` : 'запросов ещё не было'}
                </p>
                {k.active ? (
                  <button type="button" class="btn btn--quiet btn--sm capi__act" onClick={() => setRevoke(k)}>
                    <Icon name="close" />
                    Отозвать<span class="visually-hidden"> ключ «{k.name}»</span>
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section class="panel" aria-labelledby="capi-hooks">
        <div class="capi__head">
          <h2 class="section-title" id="capi-hooks">
            Вебхуки
          </h2>
          <button type="button" class="btn btn--primary btn--sm" onClick={() => setAdding(true)} disabled={!hooks || pin || activeHooks >= hookLimit} aria-describedby={pin ? 'capi-pin' : activeHooks >= hookLimit ? 'capi-hooks-limit' : undefined}>
            <Icon name="plus" />
            Добавить адрес
          </button>
        </div>
        {hooks ? (
          <p class={`small ${activeHooks >= hookLimit ? '' : 'muted'}`} id="capi-hooks-limit">
            {hooksCountText(activeHooks, hookLimit)}
            {activeHooks >= hookLimit ? '. Чтобы добавить новый, выключите ненужный.' : '.'} Неудачная доставка повторяется до 24 часов; если адрес так и не ответит, владелец получит уведомление.
          </p>
        ) : null}
        {!hooks && !error ? (
          <p class="muted loading" role="status">
            Загружаем адреса…
          </p>
        ) : null}
        {hooks && !hookItems.length ? <p class="muted">Адресов пока нет. Добавьте https-адрес своего сервера и выберите события.</p> : null}
        {hookItems.length ? (
          <ul class="capi__list">
            {hookItems.map((h) => (
              <li key={h.webhook_id} class={`capi__item${h.active ? '' : ' is-off'}`}>
                <div class="capi__row">
                  <p class="capi__name">{h.description || h.host}</p>
                  <span class={`badge ${h.active ? 'badge--free' : 'badge--off'}`}>
                    <Icon name={h.active ? 'check' : 'close'} />
                    {h.active ? 'Включён' : 'Выключен'}
                  </span>
                </div>
                <p class="mono capi__url">{h.url}</p>
                <p class="small">События: {(h.events ?? []).map((e) => EVENT_LABEL[e] ?? e).join(', ')}</p>
                <p class="small">
                  <DeliveryMark status={h.last_delivery?.status} />
                  {lastDeliveryWords(h.last_delivery, when)}
                  {h.pending ? ` · ждут попытки: ${h.pending}` : ''}
                  {h.failed ? ` · не доставлено: ${h.failed}` : ''}
                </p>
                <div class="capi__acts">
                  <a class="btn btn--secondary btn--sm" href={`${base}/webhooks/${encodeURIComponent(h.webhook_id)}`} onClick={linkHandler}>
                    <Icon name="list" />
                    Журнал доставок<span class="visually-hidden">: {h.host}</span>
                  </a>
                  {h.active ? (
                    <>
                      <button type="button" class="btn btn--quiet btn--sm" onClick={() => sendTest(h)} disabled={testing === h.webhook_id}>
                        <Icon name="forward" />
                        {testing === h.webhook_id ? 'Отправляем…' : 'Отправить тестовое событие'}
                        <span class="visually-hidden">: {h.host}</span>
                      </button>
                      <button type="button" class="btn btn--quiet btn--sm" onClick={() => setDisable(h)}>
                        <Icon name="close" />
                        Выключить<span class="visually-hidden"> адрес {h.host}</span>
                      </button>
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <IssueKeyDialog open={issuing} clubId={clubId} scopes={keys?.scopes} onClose={() => setIssuing(false)} onChanged={load} />
      <AddHookDialog open={adding} clubId={clubId} events={hooks?.events} onClose={() => setAdding(false)} onChanged={load} />
      <ConfirmDialog
        item={revoke}
        title="Отозвать ключ"
        text={revoke ? `Ключ «${revoke.name}» (${revoke.prefix}…) перестанет работать сразу: программы, которые его используют, получат отказ. Отменить нельзя — понадобится новый ключ.` : ''}
        action="Отозвать ключ"
        onClose={() => setRevoke(null)}
        run={() => api.revokeApiKey(clubId, revoke.key_id)}
        onDone={() => (setRevoke(null), setDone(`Ключ «${revoke.name}» отозван.`), load())}
      />
      <ConfirmDialog
        item={disable}
        title="Выключить адрес"
        text={disable ? `События перестанут приходить на ${disable.host}, ждущие доставки отменятся. Выключение необратимо — чтобы снова получать события, адрес придётся добавить заново с новым секретом.` : ''}
        action="Выключить адрес"
        onClose={() => setDisable(null)}
        run={() => api.disableWebhook(clubId, disable.webhook_id)}
        onDone={() => (setDisable(null), setDone(`Адрес ${disable.host} выключен.`), load())}
      />
    </>
  );
}

function DeliveryMark({ status }) {
  if (!status) return null;
  return <Icon name={STATUS_ICON[status] ?? 'info'} class={`capi__mark capi__mark--${status}`} />;
}

/** Секрет или ключ один раз: значение, «Скопировать», предупреждение. */
function OnceValue({ value, label, warning }) {
  const [copied, setCopied] = useState(false);
  const ref = useRef(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(ref.current);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  };
  return (
    <>
      <div class="note note--lamp" role="alert">
        <Icon name="alert" />
        <p class="note__title">{label} показывается один раз</p>
        <p class="note__body">{warning}</p>
      </div>
      <div class="token">
        <code class="token__value mono" ref={ref}>
          {value}
        </code>
        <button type="button" class="btn btn--secondary btn--sm" onClick={copy}>
          <Icon name={copied ? 'check' : 'copy'} />
          {copied ? 'Скопировано' : 'Скопировать'}
        </button>
      </div>
      <p class="visually-hidden" aria-live="polite">
        {copied ? `${label} скопирован в буфер обмена` : ''}
      </p>
    </>
  );
}

const personalError = (err) => (err?.code === 'forbidden' ? { code: 'forbidden', personal: true } : null);

function IssueKeyDialog({ open, clubId, scopes, onClose, onChanged }) {
  const list = Array.isArray(scopes) && scopes.length ? scopes.filter((s) => SCOPES.includes(s)) : SCOPES;
  const [name, setName] = useState('');
  const [picked, setPicked] = useState([]);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState(null);
  useEffect(() => {
    if (!open) return;
    setName('');
    setPicked([]);
    setErrors({});
    setError(null);
    setIssued(null);
  }, [open]);
  const submit = async (e) => {
    e.preventDefault();
    const errs = keyFormErrors({ name, scopes: picked });
    setErrors(errs);
    if (Object.keys(errs).length) {
      document.getElementById(errs.name ? 'ck-name' : 'ck-scope-0')?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.createApiKey(clubId, keyBody({ name, scopes: picked }));
      setIssued(res);
      onChanged();
    } catch (err) {
      setError(personalError(err) ?? err);
    } finally {
      setBusy(false);
    }
  };
  // Закрыть окно с ключом — ключ пропадает с экрана навсегда
  const close = () => (setIssued(null), onClose());
  return (
    <Dialog open={open} onClose={close} title={issued ? `Ключ «${issued.name}»` : 'Выпустить ключ API'} labelledBy="ck-title">
      {issued?.key ? (
        <div class="form">
          <OnceValue value={issued.key} label="Ключ" warning="Скопируйте его и передайте разработчику по защищённому каналу. В Бильярдуме ключ не хранится: потеряете — отзовите и выпустите новый." />
          <p class="small">Права: {(issued.scopes ?? []).map((s) => SCOPE_LABEL[s] ?? s).join(', ')}.</p>
          <div class="dialog__actions">
            <button type="button" class="btn btn--primary btn--block btn--lg" onClick={close}>
              Готово, ключ сохранён
            </button>
          </div>
        </div>
      ) : (
        <form class="form" onSubmit={submit} noValidate>
          <div class="field">
            <label class="field__label" for="ck-name">
              Имя ключа
            </label>
            <input id="ck-name" class="field__input" maxLength={100} value={name} onInput={(e) => setName(e.currentTarget.value)} aria-invalid={errors.name ? 'true' : undefined} aria-describedby={errors.name ? 'ck-name-err' : 'ck-name-hint'} />
            {errors.name ? (
              <p class="field__error" id="ck-name-err">
                {errors.name}
              </p>
            ) : (
              <p class="field__hint" id="ck-name-hint">
                Где он будет работать: «CRM», «Сайт клуба». Видно только в этом списке.
              </p>
            )}
          </div>
          <fieldset class="field" aria-describedby={errors.scopes ? 'ck-scopes-err' : undefined}>
            <legend class="field__label">Что можно читать</legend>
            <div class="capi__checks">
              {list.map((s, i) => (
                <label class="check" key={s}>
                  <input id={`ck-scope-${i}`} type="checkbox" checked={picked.includes(s)} onChange={(e) => setPicked((p) => (e.currentTarget.checked ? [...p, s] : p.filter((x) => x !== s)))} />
                  <span>{SCOPE_LABEL[s] ?? s}</span>
                </label>
              ))}
            </div>
            {errors.scopes ? (
              <p class="field__error" id="ck-scopes-err">
                {errors.scopes}
              </p>
            ) : null}
          </fieldset>
          <p class="hint">Ключ только читает. Данных гостей (телефонов, имён) через API нет. Выпуск попадёт в журнал.</p>
          {error?.personal ? (
            <p class="note note--error" role="alert">
              <Icon name="lock" />
              <span class="note__title">{PERSONAL_LOGIN_TEXT}</span>
            </p>
          ) : (
            <ErrorNote error={error} />
          )}
          <div class="dialog__actions">
            <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
              {busy ? 'Выпускаем…' : 'Выпустить ключ'}
            </button>
            <button type="button" class="btn btn--quiet btn--block" onClick={close}>
              Отмена
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function AddHookDialog({ open, clubId, events, onClose, onChanged }) {
  const list = Array.isArray(events) && events.length ? events.filter((x) => EVENTS.includes(x)) : EVENTS;
  const [form, setForm] = useState({ url: '', events: [], description: '' });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);
  useEffect(() => {
    if (!open) return;
    setForm({ url: '', events: [], description: '' });
    setErrors({});
    setError(null);
    setCreated(null);
  }, [open]);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const submit = async (e) => {
    e.preventDefault();
    const errs = webhookFormErrors(form);
    setErrors(errs);
    if (Object.keys(errs).length) {
      document.getElementById(errs.url ? 'cw-url' : errs.events ? 'cw-ev-0' : 'cw-desc')?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.createWebhook(clubId, webhookBody(form));
      setCreated(res);
      onChanged();
    } catch (err) {
      const field = webhookServerError(err);
      if (field) {
        setErrors(field);
        document.getElementById('cw-url')?.focus();
      } else setError(personalError(err) ?? err);
    } finally {
      setBusy(false);
    }
  };
  const close = () => (setCreated(null), onClose());
  return (
    <Dialog open={open} onClose={close} title={created ? `Адрес ${created.host} добавлен` : 'Добавить адрес вебхука'} labelledBy="cw-title" wide>
      {created?.secret ? (
        <div class="form">
          <OnceValue value={created.secret} label="Секрет" warning="Им ваш сервер проверяет подпись X-Bl-Signature. В Бильярдуме секрет не показывается повторно: потеряете — выключите адрес и добавьте заново." />
          <p class="small">
            Проверка: HMAC-SHA256 секретом от строки <code class="mono">X-Bl-Timestamp.тело</code> должен совпасть с <code class="mono">X-Bl-Signature</code> после <code class="mono">v1=</code>. Повтор события узнаётся по <code class="mono">X-Bl-Event-Id</code>.
          </p>
          <div class="dialog__actions">
            <button type="button" class="btn btn--primary btn--block btn--lg" onClick={close}>
              Готово, секрет сохранён
            </button>
          </div>
        </div>
      ) : (
        <form class="form" onSubmit={submit} noValidate>
          <div class="field">
            <label class="field__label" for="cw-url">
              Адрес
            </label>
            <input id="cw-url" class="field__input mono" type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://" value={form.url} onInput={(e) => set({ url: e.currentTarget.value })} aria-invalid={errors.url ? 'true' : undefined} aria-describedby={errors.url ? 'cw-url-err' : 'cw-url-hint'} />
            {errors.url ? (
              <p class="field__error" id="cw-url-err">
                {errors.url}
              </p>
            ) : (
              <p class="field__hint" id="cw-url-hint">
                Только https:// на порту 443, адрес должен быть доступен из интернета. Переадресации не выполняются.
              </p>
            )}
          </div>
          <fieldset class="field" aria-describedby={errors.events ? 'cw-ev-err' : undefined}>
            <legend class="field__label">События</legend>
            <div class="capi__checks">
              {list.map((x, i) => (
                <label class="check" key={x}>
                  <input id={`cw-ev-${i}`} type="checkbox" checked={form.events.includes(x)} onChange={(e) => set({ events: e.currentTarget.checked ? [...form.events, x] : form.events.filter((y) => y !== x) })} />
                  <span>
                    {EVENT_LABEL[x]} <span class="mono small muted">{x}</span>
                  </span>
                </label>
              ))}
            </div>
            {errors.events ? (
              <p class="field__error" id="cw-ev-err">
                {errors.events}
              </p>
            ) : null}
          </fieldset>
          <div class="field">
            <label class="field__label" for="cw-desc">
              Описание <span class="muted">(необязательно)</span>
            </label>
            <input id="cw-desc" class="field__input" maxLength={200} value={form.description} onInput={(e) => set({ description: e.currentTarget.value })} aria-invalid={errors.description ? 'true' : undefined} aria-describedby={errors.description ? 'cw-desc-err' : undefined} />
            {errors.description ? (
              <p class="field__error" id="cw-desc-err">
                {errors.description}
              </p>
            ) : null}
          </div>
          <p class="hint">В событиях нет данных гостей: только стол, время, статус и суммы. Адрес получает события, случившиеся после добавления.</p>
          {error?.personal ? (
            <p class="note note--error" role="alert">
              <Icon name="lock" />
              <span class="note__title">{PERSONAL_LOGIN_TEXT}</span>
            </p>
          ) : (
            <ErrorNote error={error} />
          )}
          <div class="dialog__actions">
            <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
              {busy ? 'Проверяем адрес…' : 'Добавить адрес'}
            </button>
            <button type="button" class="btn btn--quiet btn--block" onClick={close}>
              Отмена
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function ConfirmDialog({ item, title, text, action, onClose, run, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => setError(null), [item]);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await run();
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={Boolean(item)} onClose={onClose} title={title} labelledBy="capi-confirm-title">
      <div class="form">
        <p>{text}</p>
        <ErrorNote error={error} />
        <div class="dialog__actions">
          <button type="button" class="btn btn--danger btn--block btn--lg" onClick={go} disabled={busy}>
            {busy ? 'Минуту…' : action}
          </button>
          <button type="button" class="btn btn--quiet btn--block" onClick={onClose}>
            Отмена
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** Журнал доставок одного адреса: фильтр по статусу, попытки раскрываются, «Показать ещё» — курсором. */
function WebhookLog({ clubId, id, base, when }) {
  const [hook, setHook] = useState(undefined);
  const [items, setItems] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const [testing, setTesting] = useState(false);
  const [disable, setDisable] = useState(false);
  const load = useCallback(async () => {
    try {
      const [list, page] = await Promise.all([api.webhooks(clubId), api.webhookDeliveries(clubId, id, status ? { status } : undefined)]);
      setHook((Array.isArray(list?.items) ? list.items : []).find((h) => h.webhook_id === id) ?? null);
      setItems(Array.isArray(page?.items) ? page.items : []);
      setCursor(page?.next_cursor ?? null);
      setError(null);
    } catch (err) {
      if (err?.code === 'not_found') setHook(null);
      setError(err?.code === 'not_found' ? null : err);
    }
  }, [clubId, id, status]);
  useEffect(() => {
    load();
  }, [load]);
  const more = async () => {
    try {
      const page = await api.webhookDeliveries(clubId, id, { ...(status ? { status } : {}), cursor });
      setItems((xs) => [...xs, ...(Array.isArray(page?.items) ? page.items : [])]);
      setCursor(page?.next_cursor ?? null);
    } catch (err) {
      setError(err);
    }
  };
  const sendTest = async () => {
    setTesting(true);
    setError(null);
    try {
      await api.testWebhook(clubId, id);
      setDone('Тестовое событие ping отправлено. Обновим журнал через несколько секунд.');
      setTimeout(load, 4000);
    } catch (err) {
      setError(err);
    } finally {
      setTesting(false);
    }
  };
  if (hook === null) {
    return (
      <section class="panel" aria-labelledby="capi-log">
        <h2 class="section-title" id="capi-log">
          Адрес не найден
        </h2>
        <p>Такого адреса вебхука у клуба нет — возможно, ссылка из другого клуба.</p>
        <a class="btn btn--secondary" href={base} onClick={linkHandler}>
          <Icon name="back" />
          Все ключи и адреса
        </a>
      </section>
    );
  }
  return (
    <>
      <a class="dlink" href={base} onClick={linkHandler}>
        <Icon name="back" />
        Все ключи и адреса
      </a>
      <section class="panel" aria-labelledby="capi-log">
        <div class="capi__head">
          <h2 class="section-title" id="capi-log">
            Журнал доставок{hook ? `: ${hook.host}` : ''}
          </h2>
          {hook?.active ? (
            <div class="capi__acts">
              <button type="button" class="btn btn--secondary btn--sm" onClick={sendTest} disabled={testing}>
                <Icon name="forward" />
                {testing ? 'Отправляем…' : 'Отправить тестовое событие'}
              </button>
              <button type="button" class="btn btn--quiet btn--sm" onClick={() => setDisable(true)}>
                <Icon name="close" />
                Выключить адрес
              </button>
            </div>
          ) : null}
        </div>
        {hook ? (
          <>
            <p class="mono capi__url">{hook.url}</p>
            <p class="small">
              <span class={`badge ${hook.active ? 'badge--free' : 'badge--off'}`}>
                <Icon name={hook.active ? 'check' : 'close'} />
                {hook.active ? 'Включён' : 'Выключен'}
              </span>{' '}
              События: {(hook.events ?? []).map((e) => EVENT_LABEL[e] ?? e).join(', ')}
            </p>
          </>
        ) : null}
        {done ? (
          <p class="note note--free" role="status">
            <Icon name="check" />
            <span class="note__title">{done}</span>
          </p>
        ) : null}
        <ErrorNote error={error}>
          <button type="button" class="btn btn--secondary btn--sm" onClick={load}>
            Повторить
          </button>
        </ErrorNote>
        <div class="capi__filter">
          <label class="dfield">
            <span class="dfield__label">Статус</span>
            <select class="field__input" value={status} onChange={(e) => setStatus(e.currentTarget.value)}>
              {DELIVERY_FILTER.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" class="btn btn--quiet btn--sm" onClick={load}>
            <Icon name="refresh" />
            Обновить
          </button>
        </div>
        {items === null && !error ? (
          <p class="muted loading" role="status">
            Загружаем доставки…
          </p>
        ) : null}
        {items ? (
          <DataTable
            caption="Доставки событий, новые сверху"
            columns={[
              { key: 'at', label: 'Событие случилось', head: true, render: (r) => when(r.created_at) },
              { key: 'event', label: 'Событие', render: (r) => EVENT_LABEL[r.event] ?? r.event },
              {
                key: 'status',
                label: 'Статус',
                render: (r) => (
                  <span class={`capi__st capi__st--${r.status}`}>
                    <DeliveryMark status={r.status} />
                    {DELIVERY_STATUS[r.status] ?? r.status}
                  </span>
                ),
              },
              { key: 'attempts', label: 'Попыток', num: true },
              {
                key: 'result',
                label: 'Результат',
                render: (r) =>
                  r.status === 'delivered'
                    ? `ответ ${r.http_status ?? '2xx'}${r.delivered_at ? `, ${when(r.delivered_at)}` : ''}`
                    : [deliveryErrorText(r.error, r.http_status), r.status === 'pending' && r.next_attempt_at ? `следующая попытка ${when(r.next_attempt_at)}` : null].filter(Boolean).join('; ') || '—',
              },
            ]}
            rows={items}
            rowKey={(r) => r.delivery_id}
            expand={(r) =>
              r.log?.length ? (
                <ol class="capi__log">
                  {r.log.map((a) => (
                    <li key={a.attempt}>
                      Попытка {a.attempt}: {when(a.at)} — {a.error ? deliveryErrorText(a.error, a.http_status) : `ответ ${a.http_status}`}
                      {Number.isFinite(a.duration_ms) ? `, ${a.duration_ms} мс` : ''}
                    </li>
                  ))}
                </ol>
              ) : (
                <p class="small muted">Попыток ещё не было.</p>
              )
            }
            expandLabel="Попытки"
            rowLabel={(r) => `${EVENT_LABEL[r.event] ?? r.event}, ${when(r.created_at)}`}
            empty={status ? 'Доставок с таким статусом нет.' : 'Доставок пока нет. Нажмите «Отправить тестовое событие», чтобы проверить адрес.'}
          />
        ) : null}
        {cursor ? (
          <button type="button" class="btn btn--quiet btn--sm" onClick={more}>
            Показать ещё
          </button>
        ) : null}
      </section>
      <ConfirmDialog
        item={disable && hook ? hook : null}
        title="Выключить адрес"
        text={hook ? `События перестанут приходить на ${hook.host}, ждущие доставки отменятся. Выключение необратимо.` : ''}
        action="Выключить адрес"
        onClose={() => setDisable(false)}
        run={() => api.disableWebhook(clubId, id)}
        onDone={() => (setDisable(false), setDone('Адрес выключен.'), load())}
      />
    </>
  );
}
