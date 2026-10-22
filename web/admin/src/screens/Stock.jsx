import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { formatMoney, plural } from '@billiardum/shared/format';
import { WRITEOFF_REASONS } from '@billiardum/shared/reasons';
import { Shell } from '../components/Shell.jsx';
import { Icon } from '../components/Icon.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { api, newIdempotencyKey } from '../lib/api.js';
import { parseRubles } from '../lib/cash.js';
import { arrivalTotal, auditLine, auditTotals, lowStock, parseQty, qtyText, unitWord } from '../lib/stock.js';

const TABS = [
  { key: 'left', label: 'Остатки' },
  { key: 'arrival', label: 'Приход' },
  { key: 'writeoff', label: 'Списание' },
  { key: 'audit', label: 'Ревизия' },
];
const POSITIONS = ['позиция', 'позиции', 'позиций'];

/**
 * Склад (управляющий, решение №80): остатки, приход с ценой закупки, списание с причиной,
 * ревизия «факт против расчёта» с расхождением в деньгах по средней себестоимости.
 */
export function Stock({ ctx }) {
  const { club, role, user, timeZone } = ctx;
  const clubId = club.club_id;
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('left');
  const [done, setDone] = useState(null);

  const load = useCallback(async () => {
    try {
      const [list, menu] = await Promise.all([api.stock(clubId), api.menu(clubId).catch(() => null)]);
      // backend-pos отдаёт category_id и avg_cost_kopecks; названия категорий — из меню
      const cats = new Map((menu?.categories ?? []).map((c) => [c.id, c.name]));
      setItems(
        (Array.isArray(list) ? list : [])
          .filter((i) => i.active !== false)
          .map((i) => ({ ...i, category: i.category ?? cats.get(i.category_id) ?? 'Другое', cost_kopecks: i.avg_cost_kopecks ?? i.cost_kopecks ?? 0 })),
      );
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [clubId]);

  useEffect(() => {
    load();
  }, [load]);

  const finish = (text) => {
    setDone(text);
    setTab('left');
    load();
  };

  return (
    <Shell club={club} role={role} user={user} timeZone={timeZone} active="stock" title="Склад">
      <div class="page stock">
        <div class="pills" role="radiogroup" aria-label="Раздел склада">
          {TABS.map((t) => (
            <label class="pill" key={t.key}>
              <input type="radio" name="stock-tab" checked={tab === t.key} onChange={() => (setTab(t.key), setDone(null))} />
              <span>{t.label}</span>
            </label>
          ))}
        </div>
        {done ? (
          <p class="note note--free" role="status">
            <Icon name="check" />
            <span class="note__title">{done}</span>
          </p>
        ) : null}
        <ErrorNote error={error}>
          <button type="button" class="btn btn--secondary btn--sm" onClick={load}>
            Обновить
          </button>
        </ErrorNote>
        {items === null && !error ? <p class="muted loading">Загружаем склад…</p> : null}
        {items ? (
          <>
            {tab === 'left' ? <Left items={items} /> : null}
            {tab === 'arrival' ? <Arrival items={items} onDone={finish} /> : null}
            {tab === 'writeoff' ? <Writeoff items={items} onDone={finish} /> : null}
            {tab === 'audit' ? <Audit items={items} onDone={finish} /> : null}
          </>
        ) : null}
      </div>
    </Shell>
  );
}

function Left({ items }) {
  if (!items.length) {
    return <p class="hint">На складе пока ничего не учитывается. Проведите первый приход — товар появится здесь с остатком и себестоимостью.</p>;
  }
  const value = arrivalTotal(items.map((i) => ({ qty: Math.max(0, i.qty), cost_kopecks: i.cost_kopecks ?? 0 })));
  const low = items.filter(lowStock);
  return (
    <section aria-labelledby="left-title" class="stock__left">
      <h2 class="section-title" id="left-title">
        Остатки
        {low.length ? <span class="count">{low.length}</span> : null}
      </h2>
      {low.length ? <p class="hint">Заканчивается: {low.map((i) => i.name).join(', ')}.</p> : null}
      <table class="rtable stock__table">
        <caption class="visually-hidden">Остатки на складе</caption>
        <thead>
          <tr>
            <th scope="col">Товар</th>
            <th scope="col" class="num">
              Остаток
            </th>
            <th scope="col" class="num">
              Себестоимость
            </th>
            <th scope="col" class="num">
              На сумму
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.product_id} class={lowStock(i) ? 'is-low' : ''}>
              <th scope="row">
                {i.name}
                <span class="stock__cat">{i.category}</span>
              </th>
              <td class="num mono" data-label="Остаток">
                <span>
                  {qtyText(i.qty)} {unitWord(i.unit)}
                  {lowStock(i) ? <span class="tag tag--low">{i.qty <= 0 ? 'Нет' : 'Мало'}</span> : null}
                </span>
              </td>
              <td class="num mono" data-label="Себестоимость">
                {formatMoney(i.cost_kopecks ?? 0)}
              </td>
              <td class="num mono" data-label="На сумму">
                {formatMoney(arrivalTotal([{ qty: Math.max(0, i.qty), cost_kopecks: i.cost_kopecks ?? 0 }]))}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={3}>
              Всего по себестоимости
            </th>
            <td class="num mono" data-label="Всего">
              {formatMoney(value)}
            </td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}

/** Выбор товара: по категориям. */
function ProductSelect({ id, items, value, onChange, label = 'Товар', invalid }) {
  const groups = useMemo(() => {
    const m = new Map();
    for (const i of items) {
      if (!m.has(i.category)) m.set(i.category, []);
      m.get(i.category).push(i);
    }
    return [...m.entries()];
  }, [items]);
  return (
    <div class="field">
      <label class="field__label" for={id}>
        {label}
      </label>
      <select id={id} class="field__input" value={value} aria-invalid={invalid ? 'true' : undefined} onChange={(e) => onChange(e.currentTarget.value)}>
        <option value="">Выберите товар</option>
        {groups.map(([cat, list]) => (
          <optgroup label={cat} key={cat}>
            {list.map((i) => (
              <option value={i.product_id} key={i.product_id}>
                {i.name} — {qtyText(i.qty)} {unitWord(i.unit)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

const blank = () => ({ id: Math.random().toString(36).slice(2), product_id: '', qty: '', cost: '' });

function Arrival({ items, onDone }) {
  const [lines, setLines] = useState([blank()]);
  const [comment, setComment] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const key = useRef(newIdempotencyKey());
  const parsed = lines.map((l) => ({ ...l, q: parseQty(l.qty), c: parseRubles(l.cost) }));
  const valid = parsed.filter((l) => l.product_id && l.q > 0 && l.c !== null);
  const total = arrivalTotal(valid.map((l) => ({ qty: l.q, cost_kopecks: l.c })));
  const lineSum = (l) => arrivalTotal([{ qty: l.q, cost_kopecks: l.c }]);
  const set = (id, patch) => setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (!valid.length || valid.length !== parsed.filter((l) => l.product_id || l.qty || l.cost).length) return;
    setBusy(true);
    setError(null);
    try {
      await api.arrival({ items: valid.map((l) => ({ product_id: l.product_id, qty: l.q, unit_cost_kopecks: l.c })), ...(comment.trim() ? { note: comment.trim() } : {}) }, key.current);
      onDone(`Приход проведён: ${valid.length} ${plural(valid.length, POSITIONS)} на ${formatMoney(total)}.`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="panel stock__form" onSubmit={submit} noValidate aria-labelledby="arr-title">
      <h2 class="section-title" id="arr-title">
        Приход
      </h2>
      <p class="hint">Цена закупки за единицу пересчитает среднюю себестоимость товара.</p>
      <ul class="slines">
        {parsed.map((l, i) => {
          const item = items.find((x) => x.product_id === l.product_id);
          const bad = tried && (l.product_id || l.qty || l.cost);
          return (
            <li class="sline" key={l.id}>
              <ProductSelect id={`arr-p-${l.id}`} items={items} value={l.product_id} onChange={(v) => set(l.id, { product_id: v })} label={`Товар ${i + 1}`} invalid={bad && !l.product_id} />
              <div class="field">
                <label class="field__label" for={`arr-q-${l.id}`}>
                  Количество{item ? `, ${unitWord(item.unit)}` : ''}
                </label>
                <input id={`arr-q-${l.id}`} class="field__input mono" inputMode="decimal" value={l.qty} aria-invalid={bad && !(l.q > 0) ? 'true' : undefined} onInput={(e) => set(l.id, { qty: e.currentTarget.value.replace(/[^\d,.]/g, '') })} />
              </div>
              <div class="field">
                <label class="field__label" for={`arr-c-${l.id}`}>
                  Цена за единицу, ₽
                </label>
                <input id={`arr-c-${l.id}`} class="field__input mono" inputMode="decimal" value={l.cost} aria-invalid={bad && l.c === null ? 'true' : undefined} onInput={(e) => set(l.id, { cost: e.currentTarget.value.replace(/[^\d,.]/g, '') })} />
              </div>
              <p class="sline__sum mono" aria-label="Сумма строки">
                {l.q > 0 && l.c !== null ? formatMoney(lineSum(l)) : '—'}
              </p>
              {lines.length > 1 ? (
                <button type="button" class="icon-btn sline__del" aria-label={`Убрать строку ${i + 1}`} onClick={() => setLines((ls) => ls.filter((x) => x.id !== l.id))}>
                  <Icon name="trash" />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <button type="button" class="btn btn--quiet btn--sm" onClick={() => setLines((ls) => [...ls, blank()])}>
        <Icon name="plus" />
        Добавить строку
      </button>
      {tried && !valid.length ? <p class="field__error">Заполните товар, количество и цену хотя бы в одной строке.</p> : null}
      <div class="field">
        <label class="field__label" for="arr-comment">
          Поставщик и накладная
        </label>
        <input id="arr-comment" class="field__input" maxLength={120} value={comment} onInput={(e) => setComment(e.currentTarget.value)} />
        <p class="field__hint">Необязательно. Например: «Метро, накладная 4512».</p>
      </div>
      <ErrorNote error={error} />
      <button type="submit" class="btn btn--primary btn--lg" disabled={busy}>
        <Icon name="box" />
        {busy ? 'Проводим…' : valid.length ? `Провести приход: ${valid.length} ${plural(valid.length, POSITIONS)} на ${formatMoney(total)}` : 'Провести приход'}
      </button>
    </form>
  );
}

function Writeoff({ items, onDone }) {
  const stocked = items.filter((i) => i.qty > 0);
  const [lines, setLines] = useState([blank()]);
  const [reason, setReason] = useState('');
  const [text, setText] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const key = useRef(newIdempotencyKey());
  const parsed = lines.map((l) => ({ ...l, q: parseQty(l.qty), item: items.find((x) => x.product_id === l.product_id) }));
  const valid = parsed.filter((l) => l.item && l.q > 0 && l.q <= l.item.qty);
  const amount = arrivalTotal(valid.map((l) => ({ qty: l.q, cost_kopecks: l.item.cost_kopecks ?? 0 })));
  const set = (id, patch) => setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const textOk = text.trim().length >= 3;

  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (!valid.length || !reason || !textOk) return;
    setBusy(true);
    setError(null);
    try {
      const label = WRITEOFF_REASONS.find((r) => r.code === reason)?.label ?? 'Другое';
      await api.writeoff({ items: valid.map((l) => ({ product_id: l.product_id, qty: l.q })), reason: `${label}: ${text.trim()}`, reason_code: reason }, key.current);
      onDone(`Списано: ${valid.length} ${plural(valid.length, POSITIONS)} на ${formatMoney(amount)} по себестоимости.`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="panel stock__form" onSubmit={submit} noValidate aria-labelledby="wo-title">
      <h2 class="section-title" id="wo-title">
        Списание
      </h2>
      <p class="hint">Списание — ручное действие: причина обязательна, запись уйдёт в журнал.</p>
      <ul class="slines">
        {parsed.map((l, i) => {
          const tooMany = l.item && l.q > l.item.qty;
          return (
            <li class="sline sline--two" key={l.id}>
              <ProductSelect id={`wo-p-${l.id}`} items={stocked} value={l.product_id} onChange={(v) => set(l.id, { product_id: v })} label={`Товар ${i + 1}`} invalid={tried && !l.item} />
              <div class="field">
                <label class="field__label" for={`wo-q-${l.id}`}>
                  Сколько списать{l.item ? `, ${unitWord(l.item.unit)}` : ''}
                </label>
                <input id={`wo-q-${l.id}`} class="field__input mono" inputMode="decimal" value={l.qty} aria-invalid={(tried && !(l.q > 0)) || tooMany ? 'true' : undefined} aria-describedby={tooMany ? `wo-e-${l.id}` : undefined} onInput={(e) => set(l.id, { qty: e.currentTarget.value.replace(/[^\d,.]/g, '') })} />
                {tooMany ? (
                  <p class="field__error" id={`wo-e-${l.id}`}>
                    На складе только {qtyText(l.item.qty)} {unitWord(l.item.unit)}.
                  </p>
                ) : null}
              </div>
              {lines.length > 1 ? (
                <button type="button" class="icon-btn sline__del" aria-label={`Убрать строку ${i + 1}`} onClick={() => setLines((ls) => ls.filter((x) => x.id !== l.id))}>
                  <Icon name="trash" />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <button type="button" class="btn btn--quiet btn--sm" onClick={() => setLines((ls) => [...ls, blank()])}>
        <Icon name="plus" />
        Добавить строку
      </button>
      <fieldset>
        <legend class="field__label">Причина</legend>
        <div class="pills">
          {WRITEOFF_REASONS.map((r) => (
            <label class="pill" key={r.code}>
              <input type="radio" name="wo-reason" checked={reason === r.code} onChange={() => setReason(r.code)} />
              <span>{r.label}</span>
            </label>
          ))}
        </div>
        {tried && !reason ? <p class="field__error">Выберите причину.</p> : null}
      </fieldset>
      <div class="field">
        <label class="field__label" for="wo-text">
          Что случилось
        </label>
        <textarea id="wo-text" class="field__input" rows={2} maxLength={300} value={text} aria-invalid={tried && !textOk ? 'true' : undefined} onInput={(e) => setText(e.currentTarget.value)} />
        {tried && !textOk ? <p class="field__error">Опишите причину своими словами.</p> : <p class="field__hint">Например: «Уронили ящик колы при разгрузке».</p>}
      </div>
      <ErrorNote error={error} />
      <button type="submit" class="btn btn--danger btn--lg" disabled={busy}>
        <Icon name="trash" />
        {busy ? 'Списываем…' : valid.length ? `Списать ${valid.length} ${plural(valid.length, POSITIONS)} на ${formatMoney(amount)}` : 'Списать'}
      </button>
    </form>
  );
}

function Audit({ items, onDone }) {
  const [facts, setFacts] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const key = useRef(newIdempotencyKey());
  const lines = items.map((i) => {
    const actual = facts[i.product_id] === undefined || facts[i.product_id] === '' ? null : parseQty(facts[i.product_id]);
    return { item: i, raw: facts[i.product_id] ?? '', ...auditLine(i.qty, actual, i.cost_kopecks ?? 0), actual };
  });
  const totals = auditTotals(lines);

  const submit = async (e) => {
    e.preventDefault();
    if (!totals.counted) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.stockAudit({ items: lines.filter((l) => l.counted).map((l) => ({ product_id: l.item.product_id, actual_qty: l.actual })) }, key.current);
      setResult(res);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    const net = result.total_diff_kopecks ?? 0;
    return (
      <section class="panel" role="status" aria-labelledby="aud-done">
        <h2 class="section-title" id="aud-done">
          Ревизия проведена
        </h2>
        <p class={`verdict verdict--${net < 0 ? 'bad' : 'ok'}`}>
          <Icon name={net ? 'alert' : 'check'} />
          <span>{net === 0 ? 'Всё сошлось с расчётом.' : `${net < 0 ? 'Недостача' : 'Излишек'} на ${formatMoney(Math.abs(net))} по себестоимости.`}</span>
        </p>
        <p class="hint">Остатки на складе теперь равны факту.</p>
        <button type="button" class="btn btn--secondary" onClick={() => onDone('Ревизия проведена, остатки обновлены.')}>
          К остаткам
        </button>
      </section>
    );
  }

  return (
    <form class="stock__form" onSubmit={submit} noValidate aria-labelledby="aud-title">
      <h2 class="section-title" id="aud-title">
        Ревизия
      </h2>
      <p class="hint">Пересчитайте товар и введите факт. Пустые строки не меняются. Расхождение в деньгах — по средней себестоимости.</p>
      <ul class="audit">
        {lines.map((l) => (
          <li class={`aline${l.counted && l.diff_qty ? (l.diff_qty < 0 ? ' aline--short' : ' aline--over') : ''}`} key={l.item.product_id}>
            <p class="aline__name">
              {l.item.name}
              <span class="stock__cat">{l.item.category}</span>
            </p>
            <p class="aline__calc">
              <span class="small">Расчёт</span>
              <span class="mono">
                {qtyText(l.item.qty)} {unitWord(l.item.unit)}
              </span>
            </p>
            <div class="field aline__fact">
              <label class="field__label" for={`aud-${l.item.product_id}`}>
                Факт
              </label>
              <input
                id={`aud-${l.item.product_id}`}
                class="field__input mono"
                inputMode="decimal"
                value={l.raw}
                aria-describedby={`aud-d-${l.item.product_id}`}
                onInput={(e) => {
                  const v = e.currentTarget.value.replace(/[^\d,.]/g, '');
                  setFacts((f) => ({ ...f, [l.item.product_id]: v }));
                }}
              />
            </div>
            <p class="aline__diff" id={`aud-d-${l.item.product_id}`}>
              {!l.counted ? (
                <span class="small">не считали</span>
              ) : l.diff_qty === 0 ? (
                <span class="aline__ok">сходится</span>
              ) : (
                <>
                  <span class="mono">
                    {l.diff_qty > 0 ? '+' : '−'}
                    {qtyText(Math.abs(l.diff_qty))} {unitWord(l.item.unit)}
                  </span>
                  <span class="mono aline__money">
                    {l.diff_qty < 0 ? 'недостача ' : 'излишек '}
                    {formatMoney(Math.abs(l.diff_kopecks))}
                  </span>
                </>
              )}
            </p>
          </li>
        ))}
      </ul>
      <div class="audit__foot panel">
        <dl class="audit__sum">
          <div>
            <dt>Посчитано</dt>
            <dd class="mono">
              {totals.counted} из {items.length}
            </dd>
          </div>
          <div>
            <dt>Недостача</dt>
            <dd class="mono">{formatMoney(totals.shortage_kopecks)}</dd>
          </div>
          <div>
            <dt>Излишек</dt>
            <dd class="mono">{formatMoney(totals.surplus_kopecks)}</dd>
          </div>
          <div class="audit__net">
            <dt>Итог</dt>
            <dd class="mono">{totals.net_kopecks === 0 ? formatMoney(0) : `${totals.net_kopecks < 0 ? '−' : '+'}${formatMoney(Math.abs(totals.net_kopecks))}`}</dd>
          </div>
        </dl>
        <ErrorNote error={error} />
        <button type="submit" class="btn btn--primary btn--lg" disabled={busy || !totals.counted}>
          <Icon name="check" />
          {busy ? 'Проводим…' : totals.counted ? `Провести ревизию по ${totals.counted} ${plural(totals.counted, ['товару', 'товарам', 'товарам'])}` : 'Введите факт хотя бы по одному товару'}
        </button>
      </div>
    </form>
  );
}
