import { Fragment } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { formatMoney } from '@billiardum/shared/format';
import { SLOT_MINUTES, slotLabel } from '@billiardum/shared/resource';
import { Icon } from './Icon.jsx';
import { ErrorNote } from './ErrorNote.jsx';
import {
  COURT_KIND,
  KIND_WORD,
  TEMPLATES,
  TYPE_WORD,
  WEEKDAYS,
  WEEKDAY_SHORT,
  buildRules,
  defaultTariffForm,
  isCourtRule,
  kindOfType,
  ruleKind,
  rulesSlot,
  previewGrid,
  priceKey,
  priceLevels,
  spanText,
  tariffBands,
  tariffFormErrors,
  templateNeeds,
  weekCoverage,
  weekSummary,
  withCourts,
} from '../lib/tariffs.js';
import '../styles/tariff-editor.css';

const PHASES = [
  ['template', 'Шаблон'],
  ['prices', 'Цены'],
  ['preview', 'Неделя'],
];
const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);

/**
 * Редактор тарифов (№156): шаблон → цены → предпросмотр недели по часам. Один компонент для мастера подключения клуба
 * (PUT /api/clubs/{club}/tariffs) и шаблона тарифов сети (M5.5, PUT /api/networks/{id}/tariffs): куда сохранять, решает onSave.
 * Сервер проверяет неделю без дыр и пересечений; 400 tariff_gap | tariff_overlap { weekday, from, to, kind?, club_id? }
 * подсвечивает день и часы. В боевом режиме изменение — ручное действие с причиной (инвариант 8).
 *
 * onSave(rules, reason) — Promise; ошибка остаётся на экране. errorClubName(error) — имя клуба из ошибки шаблона сети.
 *
 * M5.8 (№204, №212, №213): courts — в клубе (в клубах сети) есть корты: блок корта обязателен — длина слота 60/90/120
 * и цена слота по тем же полосам шаблона («2 400 ₽ за 1,5 ч»). offerCourts — кортов нет, но цены кортов можно задать
 * впрок (шаблон сети). slot — длина слота из текущих правил клуба. types пусто — в клубе только корты.
 */
export function TariffWizard({
  types,
  courts = false,
  offerCourts = false,
  slot = null,
  dayStart,
  live,
  canCancel,
  onCancel,
  onSave,
  saveLabel = 'Сохранить тарифы',
  reasonLabel = 'Причина изменения тарифа',
  reasonHint = 'Уйдёт в журнал и владельцу в уведомлении.',
  reasonMissing = 'Клуб в боевом режиме: без причины тариф не изменить.',
  previewNote = null,
  errorClubName,
}) {
  const [phase, setPhase] = useState('template');
  const [form, setForm] = useState(() => defaultTariffForm(undefined, slot ?? undefined));
  const [tried, setTried] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setPrice = (key, v) => setForm((f) => ({ ...f, prices: { ...f.prices, [key]: v } }));

  const errors = tariffFormErrors(form, types, dayStart, courts);
  const ok = !Object.keys(errors).length;
  const court = withCourts(form, courts);
  const rules = useMemo(() => (ok ? buildRules(form, types, dayStart, courts) : []), [form, types, ok, courts]);
  const bands = tariffBands(form, dayStart);
  const need = templateNeeds(form.template);
  const multi = types.length > 1;
  const tables = types.length > 0;
  // 400 tariff_gap | tariff_overlap { kind, weekday, from, to }: день, часы и тип столов (или корты — kind: 'padel_court')
  const errKind = KIND_WORD[error?.data?.kind] ? error.data.kind : kindOfType(error?.data?.resource_type);
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
      await onSave(rules, live ? reason.trim() : '');
    } catch (err) {
      setError(err);
      if (err?.code === 'reason_required') {
        setTried(true);
        document.getElementById('tw-reason')?.focus();
      }
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
          <p class="hint">
            {tables ? 'Цена стола — за час игры, рубли.' : 'Цена корта — за слот, рубли.'} Сутки клуба начинаются в {dayStart}: ночь после полуночи считается по предыдущему дню.
          </p>
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
          {tables ? <h3 class="tw__group">{court ? 'Столы · цена за час' : 'Цена за час'}</h3> : null}
          {tables ? (
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
          ) : null}
          {tables ? (
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
          ) : null}
          {!courts && offerCourts ? (
            <label class="check">
              <input type="checkbox" checked={form.courts} onChange={(e) => set({ courts: e.currentTarget.checked })} />
              <span>Задать и цены падел-кортов — впрок, для клубов, где корты появятся</span>
            </label>
          ) : null}
          {court ? <CourtPrices form={form} bands={bands} errors={errors} tried={tried} required={courts} set={set} setPrice={setPrice} /> : null}
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
          <TypedWeek rules={rules} types={types} courts={court} dayStart={dayStart} highlight={highlight} />
          {previewNote}
          {live ? (
            <div class="field">
              <label class="field__label" for="tw-reason">
                {reasonLabel}
              </label>
              <textarea id="tw-reason" class="field__input field__input--area" rows={2} maxLength={300} value={reason} aria-invalid={tried && !reason.trim() ? 'true' : undefined} aria-describedby="tw-reason-e" onInput={(e) => setReason(e.currentTarget.value)} />
              <p class={tried && !reason.trim() ? 'field__error' : 'field__hint'} id="tw-reason-e">
                {tried && !reason.trim() ? reasonMissing : reasonHint}
              </p>
            </div>
          ) : null}
          <ErrorNote error={error} clubName={errorClubName?.(error) ?? undefined}>
            {errKind && errKind !== COURT_KIND ? <p class="small">Тип столов: {TYPE_WORD[errKind].toLowerCase()}.</p> : null}
          </ErrorNote>
          <div class="row">
            <button type="button" class="btn btn--primary btn--lg" disabled={busy} onClick={save}>
              {busy ? 'Сохраняем…' : saveLabel}
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

/**
 * Блок корта (№204, №212): длина слота одна на все корты клуба, цена — за слот по тем же полосам шаблона.
 * Минимум и шаг у корта — слот, продление — слотами (1–4), «Без лимита» и пакетов часов у корта нет.
 */
function CourtPrices({ form, bands, errors, tried, required, set, setPrice }) {
  const slot = form.slot_minutes;
  return (
    <section class="tw__court" aria-labelledby="tw-court-t">
      <h3 class="tw__group" id="tw-court-t">
        Падел-корты · цена за слот
      </h3>
      <p class="hint">
        {required ? 'В клубе есть корты — без цены корта гость не начнёт игру. ' : ''}Игра и бронь корта — слотами: гость берёт от 1 до 4 слотов и продлевает тоже слотом. «Без лимита» и пакетов часов у корта нет.
      </p>
      <fieldset aria-describedby={tried && errors.slot_minutes ? 'tw-slot-e' : 'tw-slot-h'}>
        <legend class="field__label">Длина слота</legend>
        <div class="choice choice--pills">
          {SLOT_MINUTES.map((m) => (
            <label class="choice__item" key={m}>
              <input type="radio" name="tw-slot" value={m} checked={slot === m} onChange={() => set({ slot_minutes: m })} />
              <span class="choice__box">
                <span class="choice__title">{slotLabel(m)}</span>
              </span>
            </label>
          ))}
        </div>
        {tried && errors.slot_minutes ? (
          <p class="field__error" id="tw-slot-e">
            {errors.slot_minutes}
          </p>
        ) : (
          <p class="field__hint" id="tw-slot-h">
            Одна для всех кортов клуба. Граница цены внутри слота делит его по минутам.
          </p>
        )}
      </fieldset>
      <div class="tw__prices">
        {bands.map((b) => {
          const key = priceKey(b.key, COURT_KIND);
          const id = `tw-c-${b.key.replace(/[^a-z0-9]/gi, '-')}`;
          const err = tried && errors[`price:${key}`];
          return (
            <fieldset class="tw__band" key={key}>
              <legend class="tw__bandtitle">
                {b.label} <span class="muted">· {b.time}</span>
              </legend>
              <div class="field">
                <label class="field__label" for={id}>
                  Корт, ₽ за {slotLabel(slot)}
                </label>
                <input id={id} class="field__input field__input--money mono" inputMode="decimal" value={form.prices[key] ?? ''} aria-invalid={err ? 'true' : undefined} aria-describedby={err ? `${id}-e` : undefined} onInput={(e) => setPrice(key, e.currentTarget.value)} />
                {err ? (
                  <p class="field__error" id={`${id}-e`}>
                    {err}
                  </p>
                ) : null}
              </div>
            </fieldset>
          );
        })}
      </div>
    </section>
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

/**
 * Неделя по типам столов: если цены разные — переключатель типа. Корты (courts или правила корта) — своя неделя
 * «Падел-корты» с ценой слота; если правил корта нет, а корты есть — неделя кортов вся без цены (сервер её не примет).
 */
export function TypedWeek({ rules, types, courts = false, dayStart, highlight }) {
  const courtRules = rules.filter(isCourtRule);
  const tableRules = rules.filter((r) => !isCourtRule(r));
  const withCourt = courts || courtRules.length > 0 || highlight?.type === COURT_KIND;
  const tableKinds = highlight?.type && highlight.type !== COURT_KIND && !types.includes(highlight.type) ? [...types, highlight.type] : types;
  const present = tableKinds.filter((t) => tableRules.some((r) => !ruleKind(r) || ruleKind(r) === t));
  const tableList = present.length ? present : tableKinds;
  // Все правила столов на все типы (kind: null) — неделя столов одна
  const same = tableRules.every((r) => !ruleKind(r));
  const options = [];
  if (tableList.length && (tableRules.length || !withCourt)) {
    if (same || tableList.length === 1) options.push({ id: tableList[0], label: withCourt ? 'Столы' : TYPE_WORD[tableList[0]] });
    else for (const t of tableList) options.push({ id: t, label: TYPE_WORD[t] });
  }
  if (withCourt) options.push({ id: COURT_KIND, label: KIND_WORD[COURT_KIND] });
  const ids = options.map((o) => o.id);
  // Подсветка сервера по типу, которого нет отдельной кнопкой (одна цена на все столы), — неделя столов
  const pick = (t) => (!t ? null : ids.includes(t) ? t : t !== COURT_KIND && ids[0] && ids[0] !== COURT_KIND ? ids[0] : null);
  const [type, setType] = useState(pick(highlight?.type) ?? ids[0]);
  useEffect(() => {
    const t = pick(highlight?.type);
    if (t) setType(t);
  }, [highlight?.type]);
  const cur = ids.includes(type) ? type : ids[0];
  const slot = rulesSlot(courtRules);
  return (
    <div class="stack">
      {options.length > 1 ? (
        <div class="viewtog" role="group" aria-label={withCourt ? 'Столы или корты' : 'Тип стола'}>
          {options.map((o) => (
            <button type="button" key={o.id} class="viewtog__btn" aria-pressed={cur === o.id ? 'true' : 'false'} onClick={() => setType(o.id)}>
              {o.label}
            </button>
          ))}
        </div>
      ) : null}
      {cur === COURT_KIND ? <p class="hint">{slot ? `Цена корта — за слот ${slotLabel(slot)}. Гость берёт от 1 до 4 слотов.` : 'Цен кортов пока нет.'}</p> : null}
      <WeekGrid
        key={cur}
        rules={rules}
        type={cur}
        slot={cur === COURT_KIND ? (slot ?? 60) : null}
        dayStart={dayStart}
        highlight={highlight && (!highlight.type || highlight.type === cur || (highlight.type !== COURT_KIND && cur !== COURT_KIND && !ids.includes(highlight.type))) ? highlight : null}
      />
    </div>
  );
}


/**
 * Предпросмотр недели: 7 дней × 24 часа от начала суток клуба. Сетка — картинка для глаз (aria-hidden),
 * для экранного диктора — та же неделя словами под ней. Дыры и пересечения — значком и словом, не только цветом.
 */
function WeekGrid({ rules, type, slot = null, dayStart, highlight }) {
  const cov = useMemo(() => weekCoverage(rules, type, dayStart), [rules, type, dayStart]);
  const grid = previewGrid(cov, dayStart, highlight);
  const levels = priceLevels(cov);
  const level = (p) => Math.min(5, levels.indexOf(p));
  const summary = weekSummary(cov, dayStart, slot);
  const unit = slot ? `за ${slotLabel(slot)}` : 'в час';
  return (
    <div class="wk">
      <div class="wk__scroll" role="region" aria-label="Неделя по часам: картинка, та же неделя словами — ниже" tabIndex={0}>
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
            {formatMoney(p)} {unit}
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
