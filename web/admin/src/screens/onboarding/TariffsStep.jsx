import { Fragment } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { formatMoney } from '@billiardum/shared/format';
import { Icon } from '../../components/Icon.jsx';
import { ErrorNote } from '../../components/ErrorNote.jsx';
import { api } from '../../lib/api.js';
import {
  TEMPLATES,
  TYPE_WORD,
  WEEKDAYS,
  WEEKDAY_SHORT,
  buildRules,
  defaultTariffForm,
  hallTypes,
  kindOfType,
  ruleKind,
  previewGrid,
  priceKey,
  priceLevels,
  spanText,
  tariffBands,
  tariffFormErrors,
  tariffsBody,
  templateNeeds,
  weekCoverage,
  weekSummary,
} from '../../lib/tariffs.js';

const PHASES = [
  ['template', 'Шаблон'],
  ['prices', 'Цены'],
  ['preview', 'Неделя'],
];
const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);

/**
 * Шаг «Тарифы» (№156): шаблон → цены → предпросмотр недели по часам. Сервер проверяет неделю без дыр
 * и пересечений; 400 tariff_gap | tariff_overlap { weekday, from, to } подсвечивает день и часы.
 * В боевом режиме изменение тарифа — ручное действие с причиной (инвариант 8).
 */
export function TariffsStep({ ctx, ob, reload, live }) {
  const clubId = ctx.club.club_id;
  const dayStart = /^\d{2}:\d{2}$/.test(ob.day_start_local ?? '') ? ob.day_start_local : '06:00';
  const [types, setTypes] = useState(null);
  const [current, setCurrent] = useState(undefined); // undefined — грузим, null — нет
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    // Типы столов в работе — из списка столов (kind, и смешанный стол тоже)
    api
      .resources(clubId)
      .then((r) => setTypes(hallTypes(r?.resources)))
      .catch(() => setTypes(['pyramid']));
    // GET …/tariffs → { timezone, day_start_local, rules, resource_rules, coverage }
    api.tariffs(clubId).then((r) => setCurrent(Array.isArray(r?.rules) && r.rules.length ? r.rules : null)).catch(() => setCurrent(null));
  }, [clubId]);

  if (!types || current === undefined) return <p class="muted loading">Загружаем тарифы…</p>;

  if (current && !editing) {
    return (
      <div class="stack ob__content">
        {notice ? (
          <p class="note note--free" role="status">
            <Icon name="check" />
            <span class="note__title">{notice}</span>
          </p>
        ) : null}
        <p class="lead">Тарифы клуба по дням и часам. Сутки клуба начинаются в {dayStart}: ночь после полуночи считается по предыдущему дню.</p>
        <TypedWeek rules={current} types={types} dayStart={dayStart} />
        <div class="row">
          <button type="button" class="btn btn--secondary" onClick={() => setEditing(true)}>
            <Icon name="edit" />
            Изменить тарифы
          </button>
        </div>
      </div>
    );
  }

  return (
    <TariffWizard
      clubId={clubId}
      types={types}
      dayStart={dayStart}
      live={live}
      canCancel={Boolean(current)}
      onCancel={() => setEditing(false)}
      onSaved={(rules) => {
        setCurrent(rules);
        setEditing(false);
        setNotice('Тарифы сохранены.');
        reload();
      }}
    />
  );
}

function TariffWizard({ clubId, types, dayStart, live, canCancel, onCancel, onSaved }) {
  const [phase, setPhase] = useState('template');
  const [form, setForm] = useState(defaultTariffForm());
  const [tried, setTried] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setPrice = (key, v) => setForm((f) => ({ ...f, prices: { ...f.prices, [key]: v } }));

  const errors = tariffFormErrors(form, types, dayStart);
  const ok = !Object.keys(errors).length;
  const rules = useMemo(() => (ok ? buildRules(form, types, dayStart) : []), [form, types, ok]);
  const bands = tariffBands(form, dayStart);
  const need = templateNeeds(form.template);
  const multi = types.length > 1;
  // 400 tariff_gap | tariff_overlap { kind, weekday, from, to }: день, часы и тип столов
  const errKind = TYPE_WORD[error?.data?.kind] ? error.data.kind : kindOfType(error?.data?.resource_type);
  const highlight = error?.data?.weekday ? { weekday: error.data.weekday, from: error.data.from, to: error.data.to, type: errKind } : null;

  const toPreview = (e) => {
    e.preventDefault();
    setTried(true);
    if (!ok) {
      document.querySelector('.tw [aria-invalid="true"]')?.focus();
      return;
    }
    setError(null);
    setPhase('preview');
  };

  const save = async () => {
    if (live && !reason.trim()) {
      setTried(true);
      document.getElementById('tw-reason')?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.saveTariffs(clubId, tariffsBody(rules, { live, reason }));
      onSaved(Array.isArray(res?.rules) && res.rules.length ? res.rules : rules);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="stack ob__content tw">
      <ol class="tw__phases" aria-label="Шаги мастера тарифов">
        {PHASES.map(([id, label], i) => (
          <li key={id} aria-current={phase === id ? 'step' : undefined} class={phase === id ? 'tw__phase tw__phase--on' : 'tw__phase'}>
            <span class="mono">{i + 1}</span> {label}
          </li>
        ))}
      </ol>

      {phase === 'template' ? (
        <form
          class="form"
          onSubmit={(e) => {
            e.preventDefault();
            setPhase('prices');
          }}
        >
          <fieldset>
            <legend class="field__label">С чего начнём</legend>
            <div class="tw__templates">
              {TEMPLATES.map((t) => (
                <label class="tw__tpl" key={t.id}>
                  <input type="radio" name="tw-tpl" checked={form.template === t.id} onChange={() => set({ template: t.id })} />
                  <span class="tw__tplbox">
                    <span class="tw__tpltitle">{t.title}</span>
                    <span class="tw__tplsub">{t.about}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div class="row">
            <button type="submit" class="btn btn--primary">
              Задать цены
              <Icon name="forward" />
            </button>
            {canCancel ? (
              <button type="button" class="btn btn--quiet" onClick={onCancel}>
                Оставить прежние тарифы
              </button>
            ) : null}
          </div>
        </form>
      ) : null}

      {phase === 'prices' ? (
        <form class="form" onSubmit={toPreview} noValidate>
          <p class="hint">Цена — за час игры, рубли. Сутки клуба начинаются в {dayStart}: ночь после полуночи считается по предыдущему дню.</p>
          {need.evening || need.night ? (
            <div class="tw__times">
              {need.evening ? <TimeField id="tw-evening" label="Вечер начинается в" value={form.evening} error={tried && errors.evening} onChange={(v) => set({ evening: v })} /> : null}
              {need.night ? <TimeField id="tw-night" label="Ночь начинается в" value={form.night} error={tried && errors.night} onChange={(v) => set({ night: v })} /> : null}
            </div>
          ) : null}
          {need.weekend ? (
            <fieldset class="tw__weekend" aria-describedby={tried && errors.weekend ? 'tw-we-e' : undefined}>
              <legend class="field__label">Выходные дни</legend>
              <div class="pills">
                {WEEKDAYS.map((d) => (
                  <label class="pill tw__day" key={d}>
                    <input
                      type="checkbox"
                      checked={form.weekend.includes(d)}
                      onChange={(e) => set({ weekend: e.currentTarget.checked ? [...form.weekend, d].sort() : form.weekend.filter((x) => x !== d) })}
                    />
                    <span>{WEEKDAY_SHORT[d]}</span>
                  </label>
                ))}
              </div>
              {tried && errors.weekend ? (
                <p class="field__error" id="tw-we-e">
                  {errors.weekend}
                </p>
              ) : (
                <p class="field__hint">Праздники считаются выходными сами.</p>
              )}
            </fieldset>
          ) : null}
          {multi ? (
            <label class="check">
              <input type="checkbox" checked={form.perType} onChange={(e) => set({ perType: e.currentTarget.checked })} />
              <span>Разные цены по типам столов: {types.map((t) => TYPE_WORD[t].toLowerCase()).join(', ')}</span>
            </label>
          ) : null}
          <div class="tw__prices">
            {bands.map((b) => (
              <fieldset class="tw__band" key={b.key}>
                <legend class="tw__bandtitle">
                  {b.label} <span class="muted">· {b.time}</span>
                </legend>
                <div class="tw__bandfields">
                  {(form.perType ? types : [null]).map((type) => {
                    const key = priceKey(b.key, type);
                    const id = `tw-p-${key.replace(/[^a-z0-9]/gi, '-')}`;
                    const err = tried && errors[`price:${key}`];
                    return (
                      <div class="field" key={key}>
                        <label class="field__label" for={id}>
                          {type ? `${TYPE_WORD[type]}, ₽ в час` : '₽ в час'}
                        </label>
                        <input id={id} class="field__input field__input--money mono" inputMode="decimal" value={form.prices[key] ?? ''} aria-invalid={err ? 'true' : undefined} aria-describedby={err ? `${id}-e` : undefined} onInput={(e) => setPrice(key, e.currentTarget.value)} />
                        {err ? (
                          <p class="field__error" id={`${id}-e`}>
                            {err}
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </div>
          <div class="tw__times">
            <div class="field">
              <label class="field__label" for="tw-min">
                Минимум игры
              </label>
              <select id="tw-min" class="field__input" value={String(form.min_minutes)} onChange={(e) => set({ min_minutes: Number(e.currentTarget.value) })}>
                {[0, 30, 60, 90, 120].map((m) => (
                  <option key={m} value={String(m)}>
                    {m === 0 ? 'Без минимума' : `${m} минут`}
                  </option>
                ))}
              </select>
            </div>
            <div class="field">
              <label class="field__label" for="tw-step">
                Шаг оплаты
              </label>
              <select id="tw-step" class="field__input" value={String(form.step_minutes)} onChange={(e) => set({ step_minutes: Number(e.currentTarget.value) })}>
                {[1, 5, 10, 15, 30, 60].map((m) => (
                  <option key={m} value={String(m)}>
                    {m === 1 ? 'Поминутно' : `${m} минут`}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div class="row">
            <button type="submit" class="btn btn--primary">
              Показать неделю
              <Icon name="forward" />
            </button>
            <button type="button" class="btn btn--quiet" onClick={() => setPhase('template')}>
              <Icon name="back" />
              Другой шаблон
            </button>
          </div>
        </form>
      ) : null}

      {phase === 'preview' ? (
        <div class="form">
          <p class="hint">Так цены лягут на неделю. Проверьте и сохраните.</p>
          <TypedWeek rules={rules} types={types} dayStart={dayStart} highlight={highlight} />
          {live ? (
            <div class="field">
              <label class="field__label" for="tw-reason">
                Причина изменения тарифа
              </label>
              <textarea id="tw-reason" class="field__input field__input--area" rows={2} maxLength={300} value={reason} aria-invalid={tried && !reason.trim() ? 'true' : undefined} aria-describedby="tw-reason-e" onInput={(e) => setReason(e.currentTarget.value)} />
              <p class={tried && !reason.trim() ? 'field__error' : 'field__hint'} id="tw-reason-e">
                {tried && !reason.trim() ? 'Клуб в боевом режиме: без причины тариф не изменить.' : 'Уйдёт в журнал и владельцу в уведомлении.'}
              </p>
            </div>
          ) : null}
          <ErrorNote error={error}>{errKind ? <p class="small">Тип столов: {TYPE_WORD[errKind].toLowerCase()}.</p> : null}</ErrorNote>
          <div class="row">
            <button type="button" class="btn btn--primary btn--lg" disabled={busy} onClick={save}>
              {busy ? 'Сохраняем…' : 'Сохранить тарифы'}
            </button>
            <button type="button" class="btn btn--quiet" onClick={() => setPhase('prices')}>
              <Icon name="back" />
              Поправить цены
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TimeField({ id, label, value, error, onChange }) {
  return (
    <div class="field">
      <label class="field__label" for={id}>
        {label}
      </label>
      <select id={id} class="field__input mono" value={value} aria-invalid={error ? 'true' : undefined} aria-describedby={error ? `${id}-e` : undefined} onChange={(e) => onChange(e.currentTarget.value)}>
        {HOURS.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
      {error ? (
        <p class="field__error" id={`${id}-e`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Неделя по типам столов: если цены разные — переключатель типа. */
function TypedWeek({ rules, types, dayStart, highlight }) {
  const known = highlight?.type && !types.includes(highlight.type) ? [...types, highlight.type] : types;
  const present = known.filter((t) => rules.some((r) => !ruleKind(r) || ruleKind(r) === t));
  const list = present.length ? present : known;
  const [type, setType] = useState(highlight?.type && list.includes(highlight.type) ? highlight.type : list[0]);
  useEffect(() => {
    if (highlight?.type && list.includes(highlight.type)) setType(highlight.type);
  }, [highlight?.type]);
  // Все правила на все типы (kind: null) — неделя одна, переключатель не нужен
  const same = rules.every((r) => !ruleKind(r));
  return (
    <div class="stack">
      {list.length > 1 && !same ? (
        <div class="viewtog" role="group" aria-label="Тип стола">
          {list.map((t) => (
            <button type="button" key={t} class="viewtog__btn" aria-pressed={type === t ? 'true' : 'false'} onClick={() => setType(t)}>
              {TYPE_WORD[t]}
            </button>
          ))}
        </div>
      ) : null}
      <WeekGrid rules={rules} type={type} dayStart={dayStart} highlight={highlight && (!highlight.type || highlight.type === type) ? highlight : null} />
    </div>
  );
}


/**
 * Предпросмотр недели: 7 дней × 24 часа от начала суток клуба. Сетка — картинка для глаз (aria-hidden),
 * для экранного диктора — та же неделя словами под ней. Дыры и пересечения — значком и словом, не только цветом.
 */
function WeekGrid({ rules, type, dayStart, highlight }) {
  const cov = useMemo(() => weekCoverage(rules, type, dayStart), [rules, type, dayStart]);
  const grid = previewGrid(cov, dayStart, highlight);
  const levels = priceLevels(cov);
  const level = (p) => Math.min(5, levels.indexOf(p));
  const summary = weekSummary(cov, dayStart);
  return (
    <div class="wk">
      <div class="wk__scroll">
        <div class="wk__grid" aria-hidden="true">
          <span class="wk__corner" />
          {WEEKDAYS.map((d) => (
            <span key={d} class={`wk__day${highlight?.weekday === d ? ' wk__day--mark' : ''}`}>
              {WEEKDAY_SHORT[d]}
            </span>
          ))}
          {grid.rows.map((row) => (
            <Fragment key={row.hour}>
              <span class="wk__hour mono">
                {row.hour}
              </span>
              {row.cells.map((c) => (
                <span
                  key={`${row.hour}-${c.weekday}`}
                  class={`wk__c wk__c--${c.state}${c.price !== null && c.state !== 'gap' ? ` wk__c--l${level(c.price)}` : ''}${c.mark ? ' wk__c--mark' : ''}`}
                >
                  {c.state === 'gap' ? '—' : c.state === 'overlap' ? '×2' : c.price !== null ? <span class="wk__p">{Math.round(c.price / 100)}</span> : ''}
                </span>
              ))}
            </Fragment>
          ))}
        </div>
      </div>
      <ul class="wk__legend" aria-hidden="true">
        {levels.slice(0, 6).map((p, i) => (
          <li key={p}>
            <span class={`wk__sw wk__c--l${i}`} />
            {formatMoney(p)} в час
          </li>
        ))}
        {cov.gaps.length ? (
          <li>
            <span class="wk__sw wk__c--gap">—</span>
            нет цены
          </li>
        ) : null}
        {cov.overlaps.length ? (
          <li>
            <span class="wk__sw wk__c--overlap">×2</span>
            две цены
          </li>
        ) : null}
      </ul>
      {cov.gaps.length || cov.overlaps.length ? (
        <div class="note note--error" role="alert">
          <Icon name="alert" />
          <p class="note__title">Неделя покрыта не целиком — сервер такой тариф не примет</p>
          <ul class="note__body">
            {[...cov.gaps.slice(0, 3).map((s) => spanText(s, 'gap')), ...cov.overlaps.slice(0, 3).map((s) => spanText(s, 'overlap'))].map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <h3 class="wk__sumtitle">Неделя словами</h3>
      <dl class="wk__sum">
        {summary.map((l) => (
          <div key={l.days}>
            <dt>{l.days}</dt>
            <dd>{l.text}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
