import { useCallback, useEffect, useState } from 'preact/hooks';
import { formatDate, formatTime } from '@billiardum/shared/format';
import { Icon } from '../components/Icon.jsx';
import { Ill } from '../components/Ill.jsx';
import { Dialog } from '../components/Dialog.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { api } from '../lib/api.js';
import { auth, logout, platformRole } from '../lib/auth.js';
import { useStore } from '../lib/store.js';
import { linkHandler, navigate } from '../lib/router.js';
import { BASE } from '../lib/env.js';
import { Lazy } from '../components/Lazy.jsx';
import { PLATFORM_FLOW, PLATFORM_SCREENS, PLATFORM_TABS, RU_ZONES, actNeedsDialog, cityBody, cityErrors, needsReason, openCount } from '../lib/platform.js';
import '../styles/m4.css';

const TZ = 'Europe/Moscow';
const ROLE_WORD = { platform_operator: 'Оператор платформы', platform_admin: 'Администратор платформы' };

/**
 * Экран оператора платформы (№134–136): заявки гостей в клубы без программы (T25: через 15 минут без ответа клуба —
 * сюда), заявки клубов на программу (leads), модерация карточек «Добавить/Подтвердить клуб», жалобы на отзывы.
 * Действия — в журнал платформы; отказ и скрытие — с причиной.
 */
export function Platform({ tab = 'requests' }) {
  const { user, clubs } = useStore(auth);
  const role = platformRole(user);
  const kind = PLATFORM_TABS.some(([k]) => k === tab) || PLATFORM_SCREENS.some(([k]) => k === tab) ? tab : 'requests';
  const screen = PLATFORM_SCREENS.some(([k]) => k === kind);
  const [data, setData] = useState({});
  const [error, setError] = useState(null);
  const [acting, setActing] = useState(null);
  const [notice, setNotice] = useState(null);
  // Город: { mode: 'create' | 'edit' | 'approve', city?, listing? } — новый, правка или одобрение «Добавить клуб» с новым городом
  const [cityEdit, setCityEdit] = useState(null);
  const [tabErrors, setTabErrors] = useState({});

  const load = useCallback(async () => {
    // Разделы грузятся независимо: сбой одного (например, сервер ещё без «Городов») не прячет остальные
    const all = await Promise.allSettled(PLATFORM_TABS.map(([k]) => api.platformList(k).then((r) => [k, r?.items ?? []])));
    const next = {};
    const errors = {};
    all.forEach((r, i) => {
      const k = PLATFORM_TABS[i][0];
      if (r.status === 'fulfilled') next[k] = r.value[1];
      else errors[k] = r.reason;
    });
    setData(next);
    setTabErrors(errors);
    setError(null);
  }, []);
  useEffect(() => {
    if (role) load();
  }, [role, load]);
  // Заявки гостей ждут ответа минутами — обновляем раз в 30 секунд
  useEffect(() => {
    if (!role) return undefined;
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [role, load]);

  if (!role) {
    return (
      <div class="signin" data-theme="dark">
        <div class="signin__card">
          <h1 class="signin__title">Нет доступа</h1>
          <p class="hint">Экран оператора — только для команды Бильярдума.</p>
          <a class="btn btn--quiet btn--block" href={BASE} onClick={linkHandler}>
            В программу клуба
          </a>
        </div>
      </div>
    );
  }

  const items = screen ? null : (data[kind] ?? null);
  const flow = PLATFORM_FLOW[kind];
  const apply = async (item, value, reason, note) => {
    try {
      if (kind === 'listings' && value === 'approved') {
        // Города из «Добавить клуб» нет в справочнике — 409 city_required: создадим его в том же запросе
        try {
          const x = await api.platformUpdate(kind, item.id, { action: 'approve', ...(reason ? { reason } : {}) });
          setData((d) => ({ ...d, [kind]: d[kind].map((y) => (y.id === x.id ? x : y)) }));
          setNotice('Заявка принята.');
          return true;
        } catch (err) {
          if (err?.code !== 'city_required') throw err;
          setCityEdit({ mode: 'approve', listing: item, city: { name: item.payload?.city ?? '', name_in: '', timezone: 'Europe/Moscow', region: '', slug: '' } });
          return false;
        }
      }
      const x = await api.platformUpdate(kind, item.id, { [flow.field]: value, ...(reason ? { reason } : {}), ...(note !== undefined ? { note } : {}) });
      setData((d) => ({ ...d, [kind]: d[kind].map((y) => (y.id === x.id ? x : y)) }));
      setNotice(`Готово: ${flow.words[value] ?? value}.`);
      return true;
    } catch (err) {
      setError(err);
      return false;
    }
  };

  return (
    <div class="op">
      <a class="skip" href="#op-main">
        К содержимому
      </a>
      <header class="op__bar" data-theme="dark">
        <p class="op__brand">
          <span class="display">Бильярдум</span>
          <span class="op__role">{ROLE_WORD[role]}</span>
        </p>
        <div class="op__tools">
          {clubs.length ? (
            <a class="btn btn--quiet btn--sm" href={BASE} onClick={linkHandler}>
              Программа клуба
            </a>
          ) : null}
          <button
            type="button"
            class="btn btn--quiet btn--sm"
            onClick={async () => {
              await logout().catch(() => {});
              navigate(`${BASE}signin`, { replace: true });
            }}
          >
            <Icon name="logout" />
            Выйти
          </button>
        </div>
      </header>
      <main class="op__main" id="op-main">
        <h1 class="op__title display">{kind === 'billing' ? 'Клубы и подписки' : 'Заявки и модерация'}</h1>
        <nav class="subnav subnav--scroll" aria-label="Разделы оператора">
          {PLATFORM_TABS.map(([k, label]) => {
            const n = openCount(k, data[k]);
            return (
              <a class="subnav__item" key={k} href={`${BASE}platform/${k}`} onClick={linkHandler} aria-current={k === kind ? 'page' : undefined}>
                {label}
                {n ? <span class="count count--alert">{n}</span> : null}
              </a>
            );
          })}
          {PLATFORM_SCREENS.map(([k, label]) => (
            <a class="subnav__item" key={k} href={`${BASE}platform/${k}`} onClick={linkHandler} aria-current={k === kind ? 'page' : undefined}>
              {label}
            </a>
          ))}
        </nav>
        {kind === 'billing' ? (
          <Lazy key="platformBilling" chunk="platformBilling" label="Открываем подписки…" fallback={<p class="muted loading" role="status">Загружаем…</p>} render={(m) => <m.PlatformBilling role={role} />} />
        ) : null}
        <ErrorNote error={screen ? null : (error ?? tabErrors[kind] ?? null)} />
        {notice ? (
          <p class="note note--free" role="status">
            <Icon name="check" />
            <span class="note__title">{notice}</span>
          </p>
        ) : null}
        {!screen && items === null && !error && !tabErrors[kind] ? <p class="muted loading">Загружаем…</p> : null}
        {kind === 'cities' ? (
          <div class="row">
            <button type="button" class="btn btn--primary" onClick={() => setCityEdit({ mode: 'create', city: { name: '', name_in: '', timezone: 'Europe/Moscow', region: '', slug: '', active: true } })}>
              <Icon name="plus" />
              Новый город
            </button>
          </div>
        ) : null}
        {kind === 'cities' && items?.length ? (
          <ul class="oplist">
            {items.map((c) => (
              <li class="opcard opcity" key={c.id}>
                <div class="opcard__body">
                  <p class="opcard__title">
                    {c.name} <span class="muted">· {c.name_in}</span>
                  </p>
                  <p class="muted small">
                    {c.region ? `${c.region} · ` : ''}
                    {c.timezone} · /{c.slug}/ · клубов: <span class="mono">{c.clubs ?? 0}</span>
                  </p>
                </div>
                <p class="opcard__foot">
                  <span class={`badge badge--${c.active ? 'free' : 'reserved'}`}>
                    <span class="badge__dot" aria-hidden="true" />
                    {c.active ? 'На сайте' : 'Скрыт'}
                  </span>
                  <button type="button" class="btn btn--secondary btn--sm" onClick={() => setCityEdit({ mode: 'edit', city: { ...c, region: c.region ?? '' } })}>
                    Изменить
                  </button>
                </p>
              </li>
            ))}
          </ul>
        ) : null}
        {items?.length === 0 ? (
          <p class="empty-queue">
            <Ill name="pocket" />
            <span class="empty-queue__title">Пусто</span>
            Новых записей нет.
          </p>
        ) : null}
        {kind !== 'cities' && items?.length ? (
          <ul class="oplist">
            {items.map((x) => (
              <li class={`opcard opcard--${x[flow.field]}`} key={x.id}>
                <OpBody kind={kind} x={x} />
                <p class="opcard__foot">
                  <span class={`badge badge--${flow.tones[x[flow.field]] ?? 'reserved'}`}>
                    <span class="badge__dot" aria-hidden="true" />
                    {flow.words[x[flow.field]] ?? x[flow.field]}
                  </span>
                  <span class="opcard__actions">
                    {(flow.actions[x[flow.field]] ?? []).map(([value, label]) => (
                      <button
                        type="button"
                        key={value}
                        class={`btn btn--sm ${needsReason(value) ? 'btn--quiet' : 'btn--primary'}`}
                        onClick={() => (actNeedsDialog(kind, value) ? setActing({ x, value, label, kind }) : apply(x, value))}
                      >
                        {label}
                      </button>
                    ))}
                  </span>
                </p>
              </li>
            ))}
          </ul>
        ) : null}
      </main>
      <CityDialog
        edit={cityEdit}
        onClose={() => setCityEdit(null)}
        onDone={(res, mode) => {
          setCityEdit(null);
          if (mode === 'approve') {
            setData((d) => ({ ...d, listings: d.listings.map((y) => (y.id === res.id ? res : y)) }));
            setNotice('Город добавлен, заявка принята — клуб появится в каталоге.');
            load();
            return;
          }
          setNotice(mode === 'create' ? `Город «${res.name}» добавлен.` : `Город «${res.name}» сохранён.`);
          load();
        }}
      />
      <ActDialog
        act={acting}
        onClose={() => setActing(null)}
        // Лиды — заметка воронки; заявки гостей — ответ гостю; отклонение и скрытие — причина в журнал платформы
        onDone={async (text) => (await (kind === 'leads' ? apply(acting.x, acting.value, undefined, text ?? '') : apply(acting.x, acting.value, text))) && setActing(null)}
      />
    </div>
  );
}

function Tel({ phone }) {
  if (!phone) return <span class="muted">—</span>;
  return (
    <a class="mono" href={`tel:${phone.replace(/[^\d+]/g, '')}`}>
      {phone}
    </a>
  );
}

function OpBody({ kind, x }) {
  const at = (iso) => (iso ? `${formatDate(iso, TZ)}, ${formatTime(iso, TZ)}` : '—');
  if (kind === 'requests') {
    return (
      <div class="opcard__body">
        <p class="opcard__title">
          {x.listing?.name ?? 'Клуб'} <span class="muted">· {x.listing?.city}</span>
        </p>
        <p>
          Стол на <b>{at(x.starts_at)}</b> (мск) · {x.minutes / 60} ч · {x.people} чел.{x.comment ? ` · «${x.comment}»` : ''}
        </p>
        <dl class="opfacts">
          <div>
            <dt>Гость</dt>
            <dd>
              <Tel phone={x.guest?.phone ?? x.guest?.phone_masked} />
            </dd>
          </div>
          <div>
            <dt>Создана</dt>
            <dd>
              {at(x.created_at)}
              {x.escalated_at ? ` · у оператора с ${formatTime(x.escalated_at, TZ)}` : ''}
            </dd>
          </div>
          {x.answer_text ? (
            <div>
              <dt>Ответ</dt>
              <dd>«{x.answer_text}»</dd>
            </div>
          ) : null}
        </dl>
      </div>
    );
  }
  if (kind === 'leads') {
    return (
      <div class="opcard__body">
        <p class="opcard__title">
          {x.club_name} <span class="muted">· {x.city}</span>
        </p>
        <p>
          {x.name}
          {x.tables_count ? (
            <>
              {' '}
              · столов: <b class="mono">{x.tables_count}</b>
            </>
          ) : null}{' '}
          · <Tel phone={x.phone} />
        </p>
        {x.comment ? <p class="muted">«{x.comment}»</p> : null}
        <p class="muted small">
          {at(x.created_at)}
          {x.note ? ` · ${x.note}` : ''}
        </p>
      </div>
    );
  }
  if (kind === 'listings') {
    const name = x.listing?.name ?? x.payload?.name ?? 'Клуб';
    const city = x.listing?.city ?? x.payload?.city ?? '';
    return (
      <div class="opcard__body">
        <p class="opcard__title">
          {x.kind === 'claim' ? 'Подтвердить клуб' : 'Добавить клуб'}: {name}
        </p>
        <p>
          {city}
          {x.payload?.address ? `, ${x.payload.address}` : ''}
          {x.listing?.path ? <span class="muted"> · {x.listing.path}</span> : null}
        </p>
        <p class="muted small">
          Заявитель: <Tel phone={x.user?.phone ?? x.user?.phone_masked} /> · {at(x.created_at)}
          {x.reason ? ` · ${x.reason}` : ''}
        </p>
      </div>
    );
  }
  const balls = Math.max(0, Math.min(5, Number(x.review?.rating) || 0));
  return (
    <div class="opcard__body">
      <p class="opcard__title">Жалоба: {x.reason}</p>
      <blockquote class="opquote">
        <span class="mono" role="img" aria-label={`Оценка ${balls} из 5`}>
          {'●'.repeat(balls)}
        </span>{' '}
        о «{x.review?.club?.name ?? 'клубе'}»: «{x.review?.text}»
      </blockquote>
      <p class="muted small">{at(x.created_at)}</p>
    </div>
  );
}

function ActDialog({ act, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setReason(''), [act?.x?.id, act?.value]);
  if (!act) return <Dialog open={false} onClose={onClose} title="" />;
  const required = needsReason(act.value);
  const label = act.kind === 'requests' ? (required ? 'Что ответить гостю' : 'Сообщение гостю (необязательно)') : required ? 'Причина' : 'Заметка';
  return (
    <Dialog open onClose={onClose} title={act.label} labelledBy="opa-title">
      <form
        class="form"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          if (required && reason.trim().length < 3) return;
          setBusy(true);
          await onDone(reason.trim() || undefined);
          setBusy(false);
        }}
      >
        <div class="field">
          <label class="field__label" for="opa-reason">
            {label}
          </label>
          <input id="opa-reason" class="field__input" maxLength={300} value={reason} placeholder={act.kind === 'requests' ? 'Например: стол 3 ждёт вас, позвоните, если опоздаете' : required ? 'Будет в журнале платформы' : 'Например: перезвонить в понедельник'} onInput={(e) => setReason(e.currentTarget.value)} />
        </div>
        <div class="dialog__actions">
          <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy || (required && reason.trim().length < 3)}>
            {busy ? 'Сохраняем…' : act.label}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Новый город, правка или одобрение «Добавить клуб» с созданием города (409 city_required). */
function CityDialog({ edit, onClose, onDone }) {
  const [c, setC] = useState(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    setC(edit?.city ? { ...edit.city } : null);
    setTried(false);
    setError(null);
  }, [edit]);
  if (!edit || !c) return <Dialog open={false} onClose={onClose} title="" />;
  const errs = cityErrors(c);
  const create = edit.mode !== 'edit';
  const set = (k) => (e) => setC((x) => ({ ...x, [k]: e.currentTarget.value }));
  const bad = (k) => (tried && errs[k] ? 'true' : undefined);
  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    try {
      let res;
      if (edit.mode === 'approve') res = await api.platformUpdate('listings', edit.listing.id, { action: 'approve', new_city: cityBody(c, { create: true }) });
      else if (edit.mode === 'create') res = await api.createCity(cityBody(c, { create: true }));
      else res = await api.platformUpdate('cities', c.id, cityBody(c));
      onDone(res, edit.mode);
    } catch (err) {
      setError(err?.code === 'duplicate' ? { code: 'city_duplicate' } : err);
    } finally {
      setBusy(false);
    }
  };
  const title = edit.mode === 'approve' ? 'Новый город для клуба' : edit.mode === 'create' ? 'Новый город' : `Город: ${edit.city.name}`;
  return (
    <Dialog open onClose={onClose} title={title} labelledBy="city-title">
      <form class="form" onSubmit={submit} noValidate>
        {edit.mode === 'approve' ? <p class="hint">Города «{edit.listing.payload?.city}» ещё нет в справочнике. Добавьте его — заявка одобрится вместе с ним.</p> : null}
        <div class="field">
          <label class="field__label" for="ct-name">
            Название
          </label>
          <input id="ct-name" class="field__input" maxLength={100} value={c.name} aria-invalid={bad('name')} onInput={set('name')} />
          {bad('name') ? <p class="field__error">{errs.name}</p> : null}
        </div>
        <div class="field">
          <label class="field__label" for="ct-in">
            Где — «в Перми»
          </label>
          <input id="ct-in" class="field__input" maxLength={120} value={c.name_in} placeholder="в Перми" aria-invalid={bad('name_in')} aria-describedby="ct-in-hint" onInput={set('name_in')} />
          <p class={bad('name_in') ? 'field__error' : 'field__hint'} id="ct-in-hint">
            {bad('name_in') ? errs.name_in : 'Для заголовков сайта: «Бильярдные клубы в Перми».'}
          </p>
        </div>
        <div class="field">
          <label class="field__label" for="ct-tz">
            Часовой пояс
          </label>
          <select id="ct-tz" class="field__input" value={c.timezone} aria-invalid={bad('timezone')} onChange={set('timezone')}>
            {RU_ZONES.some(([z]) => z === c.timezone) ? null : <option value={c.timezone}>{c.timezone}</option>}
            {RU_ZONES.map(([z, label]) => (
              <option key={z} value={z}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label class="field__label" for="ct-region">
            Регион
          </label>
          <input id="ct-region" class="field__input" maxLength={120} value={c.region} placeholder="Пермский край" onInput={set('region')} />
        </div>
        {create ? (
          <div class="field">
            <label class="field__label" for="ct-slug">
              Адрес страницы
            </label>
            <input id="ct-slug" class="field__input mono" maxLength={60} value={c.slug} placeholder="perm" aria-invalid={bad('slug')} aria-describedby="ct-slug-hint" onInput={set('slug')} />
            <p class={bad('slug') ? 'field__error' : 'field__hint'} id="ct-slug-hint">
              {bad('slug') ? errs.slug : 'Пусто — сделаем из названия. После создания не меняется.'}
            </p>
          </div>
        ) : (
          <p class="muted small">
            Адрес страницы: <span class="mono">/{c.slug}/</span> — не меняется.
          </p>
        )}
        {edit.mode !== 'approve' ? (
          <label class="check">
            <input type="checkbox" checked={c.active !== false} onChange={(e) => setC((x) => ({ ...x, active: e.currentTarget.checked }))} />
            <span>Показывать на сайте</span>
          </label>
        ) : null}
        <ErrorNote error={error} />
        <div class="dialog__actions">
          <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
            {busy ? 'Сохраняем…' : edit.mode === 'approve' ? 'Добавить город и принять заявку' : edit.mode === 'create' ? 'Добавить город' : 'Сохранить'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
