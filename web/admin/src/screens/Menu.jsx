import { useCallback, useEffect, useState } from 'preact/hooks';
import { formatMoney, plural } from '@billiardum/shared/format';
import { normalizeMenu } from '@billiardum/shared/bar';
import { Shell } from '../components/Shell.jsx';
import { Icon } from '../components/Icon.jsx';
import { Dialog } from '../components/Dialog.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { api } from '../lib/api.js';
import { parseRubles } from '../lib/cash.js';
import { CSV_SAMPLE, menuFromCsv, serverCsvError } from '../lib/csv.js';
import { unitWord } from '../lib/stock.js';
import { SUBJECT_OPTIONS, UNIT_OPTIONS, VAT_OPTIONS } from '../lib/words.js';

const ALL = '__all';
const PRODUCTS = ['товар', 'товара', 'товаров'];

/**
 * Меню бара (управляющий): товары по категориям, цены, модификаторы, стоп-лист одним касанием, импорт из CSV.
 * Алкоголь отмечается флагом: в QR-меню гостя его скрывает сервер (решение №76), на кассе продаётся как обычно.
 */
export function MenuAdmin({ ctx }) {
  const { club, role, user, timeZone } = ctx;
  const clubId = club.club_id;
  const [raw, setRaw] = useState(null);
  const [error, setError] = useState(null);
  const [cat, setCat] = useState(ALL);
  const [editing, setEditing] = useState(null); // товар или {} для нового
  const [group, setGroup] = useState(null);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      // Каталог управляющего (плоский, с modifier_group_ids); нет маршрута — меню персонала
      setRaw(await api.catalog(clubId).catch((err) => (['not_found', 'method_not_allowed'].includes(err?.code) ? api.menu(clubId) : Promise.reject(err))));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [clubId]);

  useEffect(() => {
    load();
  }, [load]);

  const menu = raw ? normalizeMenu(raw) : null;
  // «Все» — по разделам в порядке меню, как на кассе и у гостя
  const catOrder = new Map((menu?.categories ?? []).map((c, i) => [c.id, i]));
  const products = menu
    ? menu.products.filter((p) => cat === ALL || p.category_id === cat).sort((a, b) => (catOrder.get(a.category_id) ?? 999) - (catOrder.get(b.category_id) ?? 999))
    : [];
  const stopCount = menu ? menu.products.filter((p) => p.stop_list).length : 0;

  const toggleStop = async (p) => {
    setBusy(p.id);
    setError(null);
    const next = !p.stop_list;
    const flip = (list) => (list ?? []).map((x) => (x.id === p.id ? { ...x, stop_list: next } : x));
    setRaw((r) => (Array.isArray(r.products) ? { ...r, products: flip(r.products) } : { ...r, categories: r.categories.map((c) => ({ ...c, products: flip(c.products) })) }));
    try {
      await api.setStopList(p.id, next);
      setNotice(next ? `«${p.name}» в стоп-листе: гости и касса его не увидят в продаже.` : `«${p.name}» снова в продаже.`);
    } catch (err) {
      setError(err);
      load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Shell club={club} role={role} user={user} timeZone={timeZone} active="menu" title="Меню">
      <div class="page menu">
        <div class="menu__top">
          <p class="hint">
            {menu ? `${menu.products.length} ${plural(menu.products.length, PRODUCTS)}${stopCount ? `, в стоп-листе ${stopCount}` : ''}. ` : ''}
            Алкоголь гости в приложении не видят, пока юрист не разрешит онлайн-продажу; на кассе он продаётся как обычно.
          </p>
          <div class="row">
            <button type="button" class="btn btn--primary" onClick={() => setEditing({})} disabled={!menu}>
              <Icon name="plus" />
              Добавить товар
            </button>
            <button type="button" class="btn btn--quiet" onClick={() => setImporting(true)} disabled={!menu}>
              <Icon name="upload" />
              Загрузить из CSV
            </button>
          </div>
        </div>
        <p class="visually-hidden" role="status">
          {notice}
        </p>
        <ErrorNote error={error}>
          <button type="button" class="btn btn--secondary btn--sm" onClick={load}>
            Обновить
          </button>
        </ErrorNote>
        {!menu && !error ? <p class="muted loading">Загружаем меню…</p> : null}
        {menu ? (
          <>
            <div class="pills" role="radiogroup" aria-label="Категория">
              <label class="pill">
                <input type="radio" name="menu-cat" checked={cat === ALL} onChange={() => setCat(ALL)} />
                <span>Все</span>
              </label>
              {menu.categories.filter((c) => c.id !== null).map((c) => (
                <label class="pill" key={c.id}>
                  <input type="radio" name="menu-cat" checked={cat === c.id} onChange={() => setCat(c.id)} />
                  <span>{c.name}</span>
                </label>
              ))}
            </div>
            {products.length ? (
              <ul class="plist">
                {products.map((p) => (
                  <li class={`prow${p.stop_list ? ' prow--stop' : ''}`} key={p.id}>
                    <div class="prow__main">
                      <p class="prow__name">
                        {p.name}
                        {p.is_alcohol ? <span class="tag">Алкоголь — только касса</span> : null}
                      </p>
                      <p class="prow__meta">
                        {p.modifier_groups.length ? <span>{p.modifier_groups.map((g) => g.name).join(', ')}</span> : null}
                        {p.stock_qty !== null ? (
                          <span>
                            остаток {p.stock_qty} {unitWord(p.unit)}
                          </span>
                        ) : (
                          <span>без учёта остатка</span>
                        )}
                      </p>
                    </div>
                    <p class="prow__price mono">{formatMoney(p.price_kopecks)}</p>
                    <button type="button" class={`switch${p.stop_list ? '' : ' switch--on'}`} aria-pressed={p.stop_list ? 'false' : 'true'} disabled={busy === p.id} onClick={() => toggleStop(p)} aria-label={`${p.name}: ${p.stop_list ? 'в стоп-листе, вернуть в продажу' : 'в продаже, поставить в стоп-лист'}`}>
                      <span class="switch__track" aria-hidden="true">
                        <span class="switch__knob" />
                      </span>
                      <span class="switch__word">{p.stop_list ? 'Стоп-лист' : 'В продаже'}</span>
                    </button>
                    <button type="button" class="btn btn--quiet btn--sm" onClick={() => setEditing(p)} aria-label={`Изменить: ${p.name}`}>
                      <Icon name="edit" />
                      Изменить
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p class="hint">В этой категории пока нет товаров. Добавьте товар или загрузите меню из CSV.</p>
            )}

            <section class="groups" aria-labelledby="groups-title">
              <div class="groups__head">
                <h2 class="section-title" id="groups-title">
                  Модификаторы
                </h2>
                <button type="button" class="btn btn--quiet btn--sm" onClick={() => setGroup({})}>
                  <Icon name="plus" />
                  Добавить группу
                </button>
              </div>
              <ul class="glist">
                {menu.groups.map((g) => (
                  <li class="grow" key={g.id}>
                    <p class="grow__name">
                      {g.name}
                      <span class="small">{g.min >= 1 ? 'обязательно' : 'по желанию'}{g.max > 1 ? `, до ${g.max}` : ''}</span>
                    </p>
                    <p class="grow__opts">
                      {g.modifiers.map((m) => `${m.name}${m.price_delta_kopecks ? ` +${formatMoney(m.price_delta_kopecks)}` : ''}`).join(' · ')}
                    </p>
                    <button type="button" class="btn btn--quiet btn--sm" onClick={() => setGroup(g)} aria-label={`Изменить группу: ${g.name}`}>
                      <Icon name="edit" />
                      Изменить
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </>
        ) : null}
      </div>
      <ProductDialog
        product={editing}
        categories={(menu?.categories ?? []).filter((c) => c.id !== null)}
        groups={menu?.groups ?? []}
        clubId={clubId}
        onClose={() => setEditing(null)}
        onSaved={(p) => {
          setEditing(null);
          setNotice(`«${p.name}» сохранён.`);
          load();
        }}
      />
      <GroupDialog
        group={group}
        clubId={clubId}
        onClose={() => setGroup(null)}
        onSaved={() => {
          setGroup(null);
          load();
        }}
      />
      <ImportDialog
        open={importing}
        clubId={clubId}
        onClose={() => setImporting(false)}
        onDone={(res) => {
          setImporting(false);
          setNotice(`Загружено: новых ${res.created ?? 0}, обновлено ${res.updated ?? 0}.`);
          load();
        }}
      />
    </Shell>
  );
}

function ProductDialog({ product, categories, groups, clubId, onClose, onSaved }) {
  const isNew = product && !product.id;
  const [f, setF] = useState({});
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!product) return;
    setF({
      name: product.name ?? '',
      category_id: product.category_id ?? categories[0]?.id ?? '',
      price: product.price_kopecks ? String(product.price_kopecks / 100).replace('.', ',') : '',
      unit: { pcs: 'шт', ml: 'мл', g: 'г', portion: 'порц' }[product.unit] ?? product.unit ?? 'шт',
      vat_code: product.vat_code === null || product.vat_code === undefined ? '' : String(product.vat_code),
      payment_subject: product.payment_subject ?? 'commodity',
      is_alcohol: Boolean(product.is_alcohol),
      track_stock: product.id ? Boolean(product.track_stock ?? product.stock_qty !== null) : true,
      stop_list: Boolean(product.stop_list),
      groups: product.modifier_group_ids ?? (product.modifier_groups ?? []).map((g) => (typeof g === 'string' ? g : g.id)),
    });
    setTried(false);
    setError(null);
  }, [product]);

  if (!product) return <Dialog open={false} onClose={onClose} title="" />;
  const price = parseRubles(f.price ?? '');
  const nameOk = Boolean(f.name?.trim()) && f.name.trim().length <= 80;
  const set = (patch) => setF((x) => ({ ...x, ...patch }));

  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (!nameOk || !price || !f.category_id) return;
    setBusy(true);
    setError(null);
    const body = {
      name: f.name.trim(),
      category_id: f.category_id,
      price_kopecks: price,
      unit: f.unit,
      vat_code: f.vat_code ? Number(f.vat_code) : null,
      payment_subject: f.payment_subject,
      is_alcohol: f.is_alcohol,
      track_stock: f.track_stock,
      stop_list: f.stop_list,
      modifier_group_ids: f.groups,
    };
    try {
      const saved = isNew ? await api.createProduct(clubId, body) : await api.updateProduct(product.id, body);
      onSaved(saved ?? body);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={isNew ? 'Новый товар' : product.name} labelledBy="prod-title" wide>
      <form class="form pform" onSubmit={submit} noValidate>
        <div class="field pform__name">
          <label class="field__label" for="p-name">
            Название
          </label>
          <input id="p-name" class="field__input" maxLength={80} value={f.name} aria-invalid={tried && !nameOk ? 'true' : undefined} onInput={(e) => set({ name: e.currentTarget.value })} />
          {tried && !nameOk ? <p class="field__error">Напишите название, до 80 символов.</p> : <p class="field__hint">Так товар увидят гость и кассир. Объём лучше писать в названии: «Кола, 0,33 л».</p>}
        </div>
        <div class="field">
          <label class="field__label" for="p-cat">
            Категория
          </label>
          <select id="p-cat" class="field__input" value={f.category_id} onChange={(e) => set({ category_id: e.currentTarget.value })}>
            {categories.map((c) => (
              <option value={c.id} key={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label class="field__label" for="p-price">
            Цена, ₽
          </label>
          <input id="p-price" class="field__input mono" inputMode="decimal" value={f.price} aria-invalid={tried && !price ? 'true' : undefined} onInput={(e) => set({ price: e.currentTarget.value.replace(/[^\d,.]/g, '') })} />
          {tried && !price ? <p class="field__error">Укажите цену больше нуля.</p> : null}
        </div>
        <div class="field">
          <label class="field__label" for="p-unit">
            Единица
          </label>
          <select id="p-unit" class="field__input" value={f.unit} onChange={(e) => set({ unit: e.currentTarget.value })}>
            {UNIT_OPTIONS.map((o) => (
              <option value={o.value} key={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label class="field__label" for="p-vat">
            НДС в чеке
          </label>
          <select id="p-vat" class="field__input" value={f.vat_code} onChange={(e) => set({ vat_code: e.currentTarget.value })}>
            {VAT_OPTIONS.map((o) => (
              <option value={o.value} key={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label class="field__label" for="p-subj">
            Предмет расчёта
          </label>
          <select id="p-subj" class="field__input" value={f.payment_subject} onChange={(e) => set({ payment_subject: e.currentTarget.value })}>
            {SUBJECT_OPTIONS.map((o) => (
              <option value={o.value} key={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <fieldset class="pform__flags">
          <legend class="field__label">Особенности</legend>
          <label class="check">
            <input type="checkbox" checked={f.is_alcohol} onChange={(e) => set({ is_alcohol: e.currentTarget.checked, payment_subject: e.currentTarget.checked ? 'excise' : f.payment_subject === 'excise' ? 'commodity' : f.payment_subject })} />
            <span>
              Алкоголь
              <span class="field__hint">Гости не увидят его в приложении. Продаётся только на кассе ресепшена.</span>
            </span>
          </label>
          <label class="check">
            <input type="checkbox" checked={f.track_stock} onChange={(e) => set({ track_stock: e.currentTarget.checked })} />
            <span>
              Учитывать остаток на складе
              <span class="field__hint">Для кофе и чая из зёрен и листа обычно не нужно.</span>
            </span>
          </label>
          <label class="check">
            <input type="checkbox" checked={f.stop_list} onChange={(e) => set({ stop_list: e.currentTarget.checked })} />
            <span>В стоп-листе — временно не продаётся</span>
          </label>
        </fieldset>
        {groups.length ? (
          <fieldset class="pform__groups">
            <legend class="field__label">Модификаторы</legend>
            {groups.map((g) => (
              <label class="check" key={g.id}>
                <input type="checkbox" checked={f.groups?.includes(g.id)} onChange={(e) => set({ groups: e.currentTarget.checked ? [...(f.groups ?? []), g.id] : (f.groups ?? []).filter((x) => x !== g.id) })} />
                <span>
                  {g.name}
                  <span class="field__hint">{(g.modifiers ?? []).map((m) => m.name).join(', ')}</span>
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
        <ErrorNote error={error} />
        <button type="submit" class="btn btn--primary btn--lg pform__submit" disabled={busy}>
          {busy ? 'Сохраняем…' : isNew ? 'Добавить товар в меню' : 'Сохранить товар'}
        </button>
      </form>
    </Dialog>
  );
}

const blankOpt = () => ({ key: Math.random().toString(36).slice(2), name: '', price: '0' });

function GroupDialog({ group, clubId, onClose, onSaved }) {
  const isNew = group && !group.id;
  const [name, setName] = useState('');
  const [required, setRequired] = useState(true);
  const [max, setMax] = useState(1);
  const [opts, setOpts] = useState([]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!group) return;
    setName(group.name ?? '');
    setRequired(group.id ? Boolean(group.required ?? group.min_select > 0) : true);
    setMax(group.max ?? group.max_select ?? 1);
    setOpts(group.modifiers?.length ? group.modifiers.map((m) => ({ key: m.id, id: m.id, name: m.name, price: String((m.price_delta_kopecks ?? 0) / 100).replace('.', ',') })) : [blankOpt(), blankOpt()]);
    setTried(false);
    setError(null);
  }, [group]);

  if (!group) return <Dialog open={false} onClose={onClose} title="" />;
  const filled = opts.filter((o) => o.name.trim());
  const pricesOk = filled.every((o) => parseRubles(o.price || '0') !== null);

  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (!name.trim() || !filled.length || !pricesOk) return;
    setBusy(true);
    setError(null);
    const maxSel = Math.max(1, Math.min(filled.length, Number(max) || 1));
    const body = {
      name: name.trim(),
      min_select: required ? 1 : 0,
      max_select: maxSel,
      modifiers: filled.map((o) => ({ ...(o.id ? { id: o.id } : {}), name: o.name.trim(), price_delta_kopecks: parseRubles(o.price || '0') })),
    };
    try {
      if (isNew) await api.createGroup(clubId, body);
      else {
        // Сервер меняет группу и варианты по отдельности; убранный вариант — active: false (на него ссылаются заказы)
        await api.updateGroup(group.id, { name: body.name, min_select: body.min_select, max_select: body.max_select });
        const before = new Map((group.modifiers ?? []).map((x) => [x.id, x]));
        for (const o of body.modifiers) {
          if (!o.id) await api.addModifier(group.id, { name: o.name, price_delta_kopecks: o.price_delta_kopecks });
          else {
            const was = before.get(o.id);
            if (!was || was.name !== o.name || was.price_delta_kopecks !== o.price_delta_kopecks) await api.updateModifier(o.id, { name: o.name, price_delta_kopecks: o.price_delta_kopecks });
          }
        }
        for (const id of before.keys()) if (!body.modifiers.some((o) => o.id === id)) await api.updateModifier(id, { active: false });
      }
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={isNew ? 'Новая группа модификаторов' : group.name} labelledBy="grp-title">
      <form class="form" onSubmit={submit} noValidate>
        <div class="field">
          <label class="field__label" for="g-name">
            Название группы
          </label>
          <input id="g-name" class="field__input" maxLength={40} value={name} aria-invalid={tried && !name.trim() ? 'true' : undefined} onInput={(e) => setName(e.currentTarget.value)} />
          <p class="field__hint">Например: «Объём», «Сахар», «Соус».</p>
        </div>
        <label class="check">
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.currentTarget.checked)} />
          <span>Обязательно выбрать вариант</span>
        </label>
        <div class="field">
          <label class="field__label" for="g-max">
            Сколько вариантов можно выбрать
          </label>
          <input id="g-max" class="field__input mono" inputMode="numeric" value={max} onInput={(e) => setMax(e.currentTarget.value.replace(/\D/g, '').slice(0, 2))} />
        </div>
        <fieldset>
          <legend class="field__label">Варианты и доплата</legend>
          <ul class="gopts">
            {opts.map((o, i) => (
              <li class="gopt" key={o.key}>
                <div class="field">
                  <label class="field__label visually-hidden" for={`go-n-${o.key}`}>
                    Вариант {i + 1}
                  </label>
                  <input id={`go-n-${o.key}`} class="field__input" placeholder={`Вариант ${i + 1}`} value={o.name} onInput={(e) => setOpts((os) => os.map((x) => (x.key === o.key ? { ...x, name: e.currentTarget.value } : x)))} />
                </div>
                <div class="field">
                  <label class="field__label visually-hidden" for={`go-p-${o.key}`}>
                    Доплата за вариант {i + 1}, ₽
                  </label>
                  <input id={`go-p-${o.key}`} class="field__input mono" inputMode="decimal" value={o.price} onInput={(e) => setOpts((os) => os.map((x) => (x.key === o.key ? { ...x, price: e.currentTarget.value.replace(/[^\d,.]/g, '') } : x)))} />
                </div>
                <button type="button" class="icon-btn" aria-label={`Убрать вариант ${i + 1}`} onClick={() => setOpts((os) => os.filter((x) => x.key !== o.key))} disabled={opts.length <= 1}>
                  <Icon name="trash" />
                </button>
              </li>
            ))}
          </ul>
          <p class="field__hint">Доплата в рублях, 0 — без доплаты.</p>
          {tried && !filled.length ? <p class="field__error">Добавьте хотя бы один вариант.</p> : null}
          {tried && !pricesOk ? <p class="field__error">Доплата — сумма в рублях, например 40 или 40,50.</p> : null}
        </fieldset>
        <button type="button" class="btn btn--quiet btn--sm" onClick={() => setOpts((os) => [...os, blankOpt()])}>
          <Icon name="plus" />
          Добавить вариант
        </button>
        <ErrorNote error={error} />
        <button type="submit" class="btn btn--primary btn--lg btn--block" disabled={busy}>
          {busy ? 'Сохраняем…' : 'Сохранить группу'}
        </button>
      </form>
    </Dialog>
  );
}

function ImportDialog({ open, clubId, onClose, onDone }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [serverErrors, setServerErrors] = useState([]);

  useEffect(() => {
    if (open) {
      setText('');
      setError(null);
      setServerErrors([]);
    }
  }, [open]);

  const parsed = text.trim() ? menuFromCsv(text) : null;

  const readFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ''));
    reader.readAsText(file, 'utf-8');
  };

  const sample = () => {
    const url = URL.createObjectURL(new Blob([`\uFEFF${CSV_SAMPLE}`], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'menu-sample.csv';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!parsed?.rows.length || parsed.errors.length) return;
    setBusy(true);
    setError(null);
    setServerErrors([]);
    try {
      const res = (await api.importMenu(clubId, text)) ?? {};
      if (res.applied === false && Array.isArray(res.errors) && res.errors.length) setServerErrors(res.errors.map(serverCsvError));
      else onDone(res);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Загрузить меню из CSV" labelledBy="csv-title" wide>
      <form class="form" onSubmit={submit} noValidate>
        <p class="hint">
          Обязательно: название и цена. По желанию: категория, ед (шт, порц, л, мл, кг, г), алкоголь (да или нет), НДС (код ЮKassa). Товар с той же категорией и названием обновится, новый — добавится.
        </p>
        <div class="row">
          <label class="btn btn--secondary file">
            <Icon name="upload" />
            Выбрать файл
            <input class="file__input" type="file" accept=".csv,text/csv,text/plain" onChange={(e) => readFile(e.currentTarget.files?.[0])} />
          </label>
          <button type="button" class="btn btn--link" onClick={sample}>
            Скачать образец
          </button>
        </div>
        <div class="field">
          <label class="field__label" for="csv-text">
            Или вставьте таблицу
          </label>
          <textarea id="csv-text" class="field__input mono csv__text" rows={6} value={text} onInput={(e) => setText(e.currentTarget.value)} />
        </div>
        {parsed?.errors.length ? (
          <div class="note note--error" role="alert">
            <Icon name="alert" />
            <p class="note__title">
              {parsed.errors.length} {plural(parsed.errors.length, ['ошибка', 'ошибки', 'ошибок'])} — исправьте файл и загрузите снова
            </p>
            <ul class="note__body csv__errors">
              {parsed.errors.slice(0, 8).map((x) => (
                <li key={x.line}>{x.text}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {parsed?.rows.length ? (
          <div class="csv__preview">
            <table class="rtable">
              <caption>
                Готово к загрузке: {parsed.rows.length} {plural(parsed.rows.length, PRODUCTS)}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Категория</th>
                  <th scope="col">Название</th>
                  <th scope="col" class="num">
                    Цена
                  </th>
                  <th scope="col">Алкоголь</th>
                </tr>
              </thead>
              <tbody>
                {parsed.rows.slice(0, 12).map((r) => (
                  <tr key={r.line}>
                    <td data-label="Категория">{r.category ?? 'Другое'}</td>
                    <th scope="row">{r.name}</th>
                    <td class="num mono" data-label="Цена">
                      {formatMoney(r.price_kopecks)}
                    </td>
                    <td data-label="Алкоголь">{r.is_alcohol ? 'да' : 'нет'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {parsed.rows.length > 12 ? <p class="small">И ещё {parsed.rows.length - 12}.</p> : null}
          </div>
        ) : null}
        {serverErrors.length ? (
          <div class="note note--error" role="alert">
            <Icon name="alert" />
            <p class="note__title">Сервер не принял файл — меню не изменилось</p>
            <ul class="note__body csv__errors">
              {serverErrors.slice(0, 8).map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <ErrorNote error={error} />
        <button type="submit" class="btn btn--primary btn--lg" disabled={busy || !parsed?.rows.length || parsed.errors.length > 0}>
          <Icon name="upload" />
          {busy ? 'Загружаем…' : parsed?.rows.length && !parsed.errors.length ? `Загрузить ${parsed.rows.length} ${plural(parsed.rows.length, PRODUCTS)}` : 'Загрузить меню'}
        </button>
      </form>
    </Dialog>
  );
}
