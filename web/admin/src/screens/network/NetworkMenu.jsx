import { useCallback, useEffect, useState } from 'preact/hooks';
import { normalizeMenu } from '@billiardum/shared/bar';
import { Icon } from '../../components/Icon.jsx';
import { Dialog } from '../../components/Dialog.jsx';
import { ErrorNote } from '../../components/ErrorNote.jsx';
import { api } from '../../lib/api.js';
import { SUBJECT_OPTIONS, UNIT_OPTIONS, VAT_OPTIONS } from '../../lib/words.js';
import {
  TEMPLATE_PRODUCTS_MAX,
  clubMenuState,
  clubsWord,
  duplicateError,
  emptyProductForm,
  groupByCategory,
  isLive,
  menuBody,
  menuDuplicate,
  priceText,
  productFormErrors,
  productFromForm,
  productToForm,
  productsWord,
  reasonError,
} from '../../lib/networks.js';
import { ClubModeBadge, ConfirmDialog, ModeBlock, ReasonField } from './parts.jsx';

/**
 * Шаблон меню сети (№191): список товаров целиком — PUT /api/networks/{id}/menu { products, reason? } (до 300 товаров).
 * Товар, убранный из шаблона, в клубах снимается с продажи. Алкоголь: в QR-меню гостя не показывается (№76),
 * признак алкоголя у товара сети клуб не снимет. Затронуты боевые клубы — причина и уведомление владельцу.
 */
export function NetworkMenu({ n, rights, ctx, onNetwork }) {
  const [m, setM] = useState(null);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(null); // null — смотрим; [] — правим список
  const [editing, setEditing] = useState(null); // форма товара в окне
  const [removing, setRemoving] = useState(false);
  const [notice, setNotice] = useState(null);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const load = useCallback(async () => {
    try {
      setM(await api.networkMenu(n.id));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [n.id]);
  useEffect(() => {
    load();
  }, [load, n.menu_mode]);

  if (error && !m) {
    return (
      <ErrorNote error={error}>
        <button type="button" class="btn btn--secondary btn--sm" onClick={load}>
          Повторить
        </button>
      </ErrorNote>
    );
  }
  if (!m) return <p class="muted loading">Загружаем шаблон меню…</p>;
  const clubs = Array.isArray(m.clubs) ? m.clubs : [];
  const products = (Array.isArray(m.products) ? m.products : []).filter((p) => p.active !== false);
  const live = clubs.filter(isLive);
  const nameOf = (id) => clubs.find((c) => c.club_id === id)?.name ?? null;

  const startEdit = () => {
    setDraft(products.map(productToForm));
    setReason('');
    setTried(false);
    setSaveError(null);
  };
  const startFromClub = async () => {
    setSaveError(null);
    try {
      const menu = normalizeMenu(await api.catalog(ctx.club.club_id));
      const catName = new Map(menu.categories.map((c) => [c.id, c.name]));
      setDraft(
        menu.products.slice(0, TEMPLATE_PRODUCTS_MAX).map((p, i) =>
          productToForm({ ...p, id: null, category: catName.get(p.category_id) ?? null, sku: p.sku ?? null, unit: { pcs: 'шт', ml: 'мл', g: 'г', portion: 'порц' }[p.unit] ?? p.unit, sort: i }, i),
        ),
      );
    } catch (err) {
      setSaveError(err);
    }
  };
  const dup = draft ? duplicateError(draft) : null;
  const dupView = menuDuplicate(saveError, nameOf(saveError?.data?.club_id));
  const rErr = reasonError(reason, live.length > 0);
  const save = async () => {
    setTried(true);
    if (dup || draft.length > TEMPLATE_PRODUCTS_MAX) return;
    if (rErr) {
      document.getElementById('nm-reason')?.focus();
      return;
    }
    setBusy(true);
    setSaveError(null);
    try {
      const res = await api.saveNetworkMenu(n.id, menuBody(draft, reason));
      setM(res);
      setDraft(null);
      setNotice(`Шаблон меню сохранён${Number.isInteger(res?.version) ? ` (версия ${res.version})` : ''}: ${productsWord(draft.length)} в ${clubsWord(clubs.length)}.`);
      onNetwork(null);
    } catch (err) {
      setSaveError(err);
      if (err?.code === 'reason_required') document.getElementById('nm-reason')?.focus();
    } finally {
      setBusy(false);
    }
  };

  if (draft) {
    const groups = groupByCategory(draft.map((f, i) => ({ ...f, sort: i, _i: i })));
    const categories = [...new Set(draft.map((f) => String(f.category ?? '').trim()).filter(Boolean))];
    return (
      <div class="net__stack">
        <section class="panel" aria-labelledby="nm-edit">
          <div class="net__row">
            <h3 class="section-title" id="nm-edit">
              Товары шаблона <span class="count">{draft.length}</span>
            </h3>
            <button type="button" class="btn btn--secondary btn--sm" onClick={() => setEditing({ ...emptyProductForm(), _new: true })} disabled={draft.length >= TEMPLATE_PRODUCTS_MAX}>
              <Icon name="plus" />
              Добавить товар
            </button>
          </div>
          <p class="hint">Шаблон сохраняется целиком: товар, которого нет в списке, в клубах снимется с продажи. Свои товары клубов шаблон не трогает.</p>
          {!draft.length ? (
            <div class="row">
              <p class="muted">Список пуст. Добавьте товары или возьмите за основу меню клуба «{ctx.club.name ?? 'Клуб'}».</p>
              <button type="button" class="btn btn--quiet btn--sm" onClick={startFromClub}>
                <Icon name="list" />
                Взять меню этого клуба
              </button>
            </div>
          ) : null}
          {groups.map((g) => (
            <div key={g.name} class="nmenu__group">
              <h4 class="nmenu__cat">{g.name}</h4>
              <ul class="nmenu">
                {g.items.map((f) => (
                  <li key={f.key} class="nmenu__item">
                    <div class="nmenu__main">
                      <p class="nmenu__name">
                        {f.name || 'Без названия'}
                        {f.is_alcohol ? <span class="tag">Алкоголь</span> : null}
                      </p>
                      <p class="nmenu__meta">
                        {f.sku ? <span class="mono">{f.sku}</span> : null}
                        <span>{f.unit}</span>
                      </p>
                    </div>
                    <p class="nmenu__price mono">{priceText(productFromForm(f).price_kopecks)}</p>
                    <div class="nmenu__acts">
                      <button type="button" class="btn btn--quiet btn--sm" onClick={() => setEditing({ ...f })} aria-label={`Изменить: ${f.name}`}>
                        <Icon name="edit" />
                        Изменить
                      </button>
                      <button type="button" class="btn btn--quiet btn--sm" onClick={() => setDraft((d) => d.filter((x) => x.key !== f.key))} aria-label={`Убрать из шаблона: ${f.name}`}>
                        <Icon name="trash" />
                        Убрать
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
        <section class="panel" aria-labelledby="nm-save">
          <h3 class="section-title" id="nm-save">
            Сохранить шаблон
          </h3>
          <MenuTouchNote clubs={clubs} live={live} />
          {live.length ? <ReasonField id="nm-reason" label="Причина изменения шаблона меню" value={reason} onInput={setReason} error={tried ? rErr : null} /> : null}
          {tried && dup ? (
            <p class="field__error" role="alert">
              {dup}
            </p>
          ) : null}
          <ErrorNote error={dupView?.error ?? saveError} clubName={dupView?.clubName}>
            {dupView ? <p class="small">Шаблон не сохранён, меню клубов не изменено.</p> : null}
          </ErrorNote>
          <div class="row">
            <button type="button" class="btn btn--primary btn--lg" onClick={save} disabled={busy}>
              {busy ? 'Сохраняем…' : 'Сохранить шаблон меню'}
            </button>
            <button type="button" class="btn btn--quiet" onClick={() => setDraft(null)}>
              Отменить изменения
            </button>
          </div>
        </section>
        <ProductDialog
          form={editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSave={(f) => {
            setDraft((d) => (f._new ? [...d, { ...f, _new: undefined }] : d.map((x) => (x.key === f.key ? f : x))));
            setEditing(null);
          }}
        />
      </div>
    );
  }

  return (
    <div class="net__stack">
      {notice ? (
        <p class="note note--free" role="status">
          <Icon name="check" />
          <span class="note__title">{notice}</span>
        </p>
      ) : null}
      <ModeBlock n={n} scope="menu" rights={rights} onNetwork={onNetwork} />
      <section class="panel" aria-labelledby="nm-list">
        <div class="net__row">
          <h3 class="section-title" id="nm-list">
            {m.template ? `Шаблон меню · версия ${m.version}` : 'Шаблона меню ещё нет'}
          </h3>
          {rights.owner ? (
            <div class="row">
              <button type="button" class="btn btn--primary btn--sm" onClick={startEdit} disabled={!rights.edit || !clubs.length} aria-describedby={rights.pin ? 'net-pin' : undefined}>
                <Icon name={m.template ? 'edit' : 'plus'} />
                {m.template ? 'Изменить шаблон' : 'Создать шаблон меню'}
              </button>
              {m.template ? (
                <button type="button" class="btn btn--quiet btn--sm" onClick={() => setRemoving(true)} disabled={!rights.edit} aria-describedby={rights.pin ? 'net-pin' : undefined}>
                  Снять шаблон
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <p class="hint">Алкоголь в QR-меню гостя не показывается, пока юрист не разрешит онлайн-продажу; на кассе ресепшена он продаётся как обычно. Признак алкоголя у товара сети клуб не снимет.</p>
        {m.template && products.length ? (
          groupByCategory(products).map((g) => (
            <div key={g.name} class="nmenu__group">
              <h4 class="nmenu__cat">{g.name}</h4>
              <ul class="nmenu">
                {g.items.map((p) => (
                  <li key={p.id} class="nmenu__item">
                    <div class="nmenu__main">
                      <p class="nmenu__name">
                        {p.name}
                        {p.is_alcohol ? <span class="tag">Алкоголь — клуб не снимет</span> : null}
                      </p>
                      <p class="nmenu__meta">
                        {p.sku ? <span class="mono">{p.sku}</span> : null}
                        <span>{p.unit ?? 'шт'}</span>
                        {p.description ? <span>{p.description}</span> : null}
                      </p>
                    </div>
                    <p class="nmenu__price mono">{priceText(p.price_kopecks)}</p>
                  </li>
                ))}
              </ul>
            </div>
          ))
        ) : (
          <p class="hint">
            {rights.owner
              ? 'Создайте шаблон — товары появятся в меню каждого клуба сети. Склад, стоп-лист, фото и модификаторы клубы ведут сами.'
              : 'Владелец сети ещё не задал шаблон меню: у каждого клуба своё меню.'}
          </p>
        )}
      </section>
      <section class="panel" aria-labelledby="nm-clubs">
        <h3 class="section-title" id="nm-clubs">
          Меню в клубах
        </h3>
        {clubs.length ? (
          <ul class="nclubs">
            {clubs.map((c) => {
              const st = clubMenuState(c, m.version);
              return (
                <li key={c.club_id} class="nclub">
                  <div class="nclub__main">
                    <p class="nclub__name">{c.name ?? 'Клуб'}</p>
                    <p class="nclub__tags">
                      <ClubModeBadge mode={c.mode} />
                      {m.template ? (
                        <span class={`nbadge nbadge--${st.tone}`}>
                          <Icon name={st.icon} />
                          {st.text}
                        </span>
                      ) : null}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p class="hint">В сети пока нет клубов.</p>
        )}
      </section>
      <ConfirmDialog
        open={removing}
        title="Снять шаблон меню?"
        action="Снять шаблон"
        labelId="nm-rm"
        onClose={() => setRemoving(false)}
        run={async () => {
          setM(await api.deleteNetworkMenu(n.id));
          setRemoving(false);
          setNotice('Шаблон меню снят. Товары остались в меню клубов как свои товары клуба.');
          onNetwork(null);
        }}
      >
        <p>Товары останутся в меню клубов, но станут своими товарами клуба: дальше каждый клуб меняет их сам.</p>
      </ConfirmDialog>
    </div>
  );
}

function MenuTouchNote({ clubs, live }) {
  return (
    <div class={`note${live.length ? ' note--lamp' : ''}`}>
      <Icon name={live.length ? 'alert' : 'info'} />
      <p class="note__title">{live.length ? 'В сети есть клубы в боевом режиме' : `Шаблон запишется в меню ${clubsWord(clubs.length)}`}</p>
      <p class="note__body">
        {live.length
          ? `${live.map((c) => c.name ?? 'Клуб').join(', ')}: изменение шаблона меню — ручное действие. Нужна причина; владельцу клуба сразу уйдёт уведомление, запись появится в журнале каждого клуба.`
          : 'Клубы в тестовом режиме: только запись в журнал клуба.'}
        {' '}Товары, изменённые в клубе при мягком шаблоне, шаблон не меняет — кроме признака алкоголя.
      </p>
    </div>
  );
}

/** Товар шаблона: поля как у сервера (normalizeProducts). */
function ProductDialog({ form, categories, onClose, onSave }) {
  const [f, setF] = useState(form);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    setF(form);
    setTried(false);
  }, [form]);
  if (!form || !f) return <Dialog open={false} onClose={onClose} title="" />;
  const errors = productFormErrors(f);
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const bad = (k) => (tried && errors[k] ? 'true' : undefined);
  const submit = (e) => {
    e.preventDefault();
    setTried(true);
    if (Object.keys(errors).length) {
      document.querySelector('.npform [aria-invalid="true"]')?.focus();
      return;
    }
    onSave({ ...f, name: f.name.trim(), category: String(f.category ?? '').trim(), sku: String(f.sku ?? '').trim() });
  };
  const err = (k) =>
    tried && errors[k] ? (
      <p class="field__error" id={`np-${k}-e`}>
        {errors[k]}
      </p>
    ) : null;
  return (
    <Dialog open onClose={onClose} title={form._new ? 'Новый товар шаблона' : f.name || 'Товар шаблона'} labelledBy="np-title" wide>
      <form class="form pform npform" onSubmit={submit} noValidate>
        <div class="field pform__name">
          <label class="field__label" for="np-name">
            Название
          </label>
          <input id="np-name" class="field__input" maxLength={128} value={f.name} aria-invalid={bad('name')} aria-describedby={bad('name') ? 'np-name-e' : undefined} onInput={(e) => set({ name: e.currentTarget.value })} />
          {err('name')}
        </div>
        <div class="field">
          <label class="field__label" for="np-cat">
            Категория
          </label>
          <input id="np-cat" class="field__input" list="np-cats" maxLength={100} value={f.category} aria-invalid={bad('category')} aria-describedby={bad('category') ? 'np-category-e' : 'np-cat-h'} onInput={(e) => set({ category: e.currentTarget.value })} />
          <datalist id="np-cats">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          {err('category') ?? (
            <p class="field__hint" id="np-cat-h">
              В клубе — категория с этим названием, нет такой — создастся.
            </p>
          )}
        </div>
        <div class="field">
          <label class="field__label" for="np-price">
            Цена, ₽
          </label>
          <input id="np-price" class="field__input mono" inputMode="decimal" value={f.price} aria-invalid={bad('price')} aria-describedby={bad('price') ? 'np-price-e' : undefined} onInput={(e) => set({ price: e.currentTarget.value.replace(/[^\d,.]/g, '') })} />
          {err('price')}
        </div>
        <div class="field">
          <label class="field__label" for="np-sku">
            Артикул
          </label>
          <input id="np-sku" class="field__input mono" maxLength={64} value={f.sku} aria-invalid={bad('sku')} aria-describedby={bad('sku') ? 'np-sku-e' : 'np-sku-h'} onInput={(e) => set({ sku: e.currentTarget.value })} />
          {err('sku') ?? (
            <p class="field__hint" id="np-sku-h">
              Необязательно. По артикулу шаблон находит товар в клубе.
            </p>
          )}
        </div>
        <div class="field">
          <label class="field__label" for="np-unit">
            Единица
          </label>
          <select id="np-unit" class="field__input" value={f.unit} onChange={(e) => set({ unit: e.currentTarget.value })}>
            {UNIT_OPTIONS.map((o) => (
              <option value={o.value} key={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label class="field__label" for="np-vat">
            НДС в чеке
          </label>
          <select id="np-vat" class="field__input" value={f.vat_code} onChange={(e) => set({ vat_code: e.currentTarget.value })}>
            {VAT_OPTIONS.map((o) => (
              <option value={o.value} key={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label class="field__label" for="np-subj">
            Предмет расчёта
          </label>
          <select id="np-subj" class="field__input" value={f.is_alcohol ? 'excise' : f.payment_subject} disabled={f.is_alcohol} onChange={(e) => set({ payment_subject: e.currentTarget.value })}>
            {SUBJECT_OPTIONS.map((o) => (
              <option value={o.value} key={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div class="field pform__name">
          <label class="field__label" for="np-desc">
            Описание
          </label>
          <textarea id="np-desc" class="field__input field__input--area" rows={2} maxLength={500} value={f.description} aria-invalid={bad('description')} onInput={(e) => set({ description: e.currentTarget.value })} />
          {err('description')}
        </div>
        <fieldset class="pform__flags">
          <legend class="field__label">Особенности</legend>
          <label class="check">
            <input type="checkbox" checked={f.is_alcohol} onChange={(e) => set({ is_alcohol: e.currentTarget.checked })} />
            <span>
              Алкоголь
              <span class="field__hint">Гости не увидят его в QR-меню. Клубы сети этот признак не снимут.</span>
            </span>
          </label>
        </fieldset>
        <button type="submit" class="btn btn--primary btn--lg pform__submit">
          {form._new ? 'Добавить в шаблон' : 'Сохранить в шаблоне'}
        </button>
        <p class="small muted pform__name">Изменения уйдут в клубы, когда вы сохраните шаблон целиком.</p>
      </form>
    </Dialog>
  );
}
