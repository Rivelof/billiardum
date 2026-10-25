import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { tableSvg } from '@billiardum/shared/hall';
import { countText, familyText, resourceName } from '@billiardum/shared/resource';
import { Icon } from '../../components/Icon.jsx';
import { Dialog } from '../../components/Dialog.jsx';
import { ErrorNote } from '../../components/ErrorNote.jsx';
import { useMedia } from '../../components/hooks.js';
import { api } from '../../lib/api.js';
import {
  COURT_KIND,
  DEFAULT_HALL,
  familyChange,
  familyOfKind,
  fitRotation,
  fitScale,
  fitsHall,
  oversizeHint,
  hallSize,
  kindsOfFamily,
  retireBusyText,
  KINDS,
  artKind,
  clampCenter,
  footprint,
  hallFromMetres,
  kindLabel,
  kindNeedsReason,
  metres,
  moveTable,
  nextNumber,
  nextSpot,
  numberError,
  placeUnset,
  planTables,
  planSaver,
  pxToCm,
  resourceBody,
  resourcePatch,
  rotateTable,
  tableAria,
} from '../../lib/hallEditor.js';

const pct = (v) => `${(v * 100).toFixed(3)}%`;
const fmtM = (cm) => String(Math.round(cm / 10) / 10).replace('.', ',');

/**
 * Шаг «План зала» (№155): размер зала, столы перетаскиванием мышью и пальцем, поворот, номер и тип.
 * Стрелки двигают выбранный стол на 10 см (с Shift — на 50 см), R — поворот на 90°.
 * На узком экране (360 px) — список столов с полями вместо плана. Стол с историей не удаляется — выводится из работы.
 * M5.8 (№203, №213): вид «Падел-корт» — корт 10 × 20 м в настоящем размере; нумерация своя у столов и у кортов;
 * стол и корт друг в друга не превращаются — в выборе вида только виды той же семьи, 400 сервера — словами.
 */

/** Слово ресурса плана: «Стол 4», «Корт 1»; case — падеж, capital: false — со строчной. */
const nameOf = (t, opts) => resourceName(t.family ?? familyOfKind(t.kind), t.number, opts);

const pos = (p) => ({ plan_x: p.x, plan_y: p.y });

/** «8 столов и 2 корта в работе». */
function hallCount(tables) {
  const courts = tables.filter((t) => t.family === 'court').length;
  const n = tables.length - courts;
  const parts = [n ? countText(n, 'table') : null, courts ? countText(courts, 'court') : null].filter(Boolean);
  return `${parts.join(' и ')} в работе`;
}
export function HallStep({ ctx, ob, reload, live }) {
  const clubId = ctx.club.club_id;
  const wide = useMedia('(min-width: 760px)');
  const [view, setView] = useState('plan');
  const [hall, setHallState] = useState(() => hallSize(ob.hall) ?? DEFAULT_HALL);
  const hallRef = useRef(hall);
  const setHall = (h) => {
    hallRef.current = h;
    setHallState(h);
  };
  const [tables, setTablesState] = useState(null);
  // Актуальные столы редактора: обработчики клавиш и таймер сохранения читают их отсюда, а не из старой отрисовки (Д2)
  const tablesRef = useRef(null);
  const setTables = (next) => {
    tablesRef.current = typeof next === 'function' ? next(tablesRef.current) : next;
    setTablesState(tablesRef.current);
  };
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);
  const [adding, setAdding] = useState(false);
  const [retiring, setRetiring] = useState(null);
  const [kindAsk, setKindAsk] = useState(null); // { table, kind } — смена типа в боевом режиме ждёт причину (№164)
  const server = useRef(new Map()); // id → стол, как он сохранён на сервере

  /** GET …/resources → { plan, resources }; идёт ли игра — из зала (не обязательно). */
  const load = useCallback(async () => {
    try {
      const res = await api.resources(clubId);
      let statuses = null;
      try {
        statuses = new Map((await api.hall(clubId)).map((h) => [h.resource.id, h.status]));
      } catch {
        statuses = null;
      }
      const size = hallSize(res);
      if (size) setHall(size);
      const list = planTables(res?.resources, statuses);
      server.current = new Map(list.map((t) => [t.id, t]));
      const h = size ?? hallRef.current;
      // Сохранённый вне поля (зал уменьшили, координаты от руки) рисуем внутри стен; на сервер уйдёт при первом сдвиге
      setTables(placeUnset(list, h).map((t) => ({ ...t, ...pos(clampCenter(t.plan_x, t.plan_y, t.kind, t.plan_rotation, h)) })));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [clubId]);
  useEffect(() => {
    load();
  }, [load]);

  /** Сохранить изменения стола: только изменённые поля; reason — для смены типа в боевом режиме (№164). */
  const commit = useCallback(
    async (t, reason = null) => {
      const before = server.current.get(t.id) ?? {};
      const body = resourcePatch(before, t, { reason });
      if (!Object.keys(body).filter((k) => k !== 'reason').length) return true;
      try {
        await api.updateResource(clubId, t.id, body);
        server.current.set(t.id, { ...before, ...t, unset: false });
        setSaved(`${nameOf(t)} сохранён.`);
        setError(null);
        return true;
      } catch (err) {
        if (reason) throw err; // ошибку покажет окно причины
        if (err?.code === 'bad_request' && body.kind && familyChange(before, t)) {
          // №213: стол не становится кортом — сервер 400 bad_request без подробностей наружу
          setError({ code: 'family_change' });
        } else if (err?.code === 'duplicate' && body.number) {
          setError({ code: 'duplicate', text: `${resourceName(t.family, body.number)} уже есть. Выберите другой номер.` });
        } else if (err?.code === 'reason_required' && body.kind) {
          // Сервер считает клуб боевым (режим сменился, пока экран был открыт): спросим причину
          setKindAsk({ table: { ...before, ...t, kind: before.kind ?? t.kind }, kind: body.kind, fromServer: true });
          setError(null);
        } else setError(err);
        load();
        return false;
      }
    },
    [clubId, load],
  );

  const update = (t) => setTables((list) => list.map((x) => (x.id === t.id ? t : x)));
  // Стрелки и R — одним PATCH через 600 мс после последней клавиши, конец перетаскивания — сразу (Д2)
  const saver = useMemo(() => planSaver({ get: (id) => tablesRef.current?.find((x) => x.id === id) ?? null, save: (t) => commit(t) }), [commit]);
  useEffect(() => () => saver.dispose(), [saver]);

  /** Изменение стола из панели или списка: смена типа в боевом режиме — сначала причина (№164). */
  const change = async (t) => {
    const cur = tablesRef.current?.find((x) => x.id === t.id);
    if (cur && familyChange(cur, t)) {
      setError({ code: 'family_change' });
      return;
    }
    if (cur && kindNeedsReason(cur, t, live)) {
      setKindAsk({ table: cur, kind: t.kind });
      return;
    }
    update(t);
    if (await commit(t)) reload();
  };
  const sel = tables?.find((t) => t.id === selected) ?? null;
  const showPlan = wide && view === 'plan';

  return (
    <div class="stack ob__content hall-ed">
      <p class="lead">Расставьте столы и корты как в зале: гости и ресепшн увидят этот план. Номер — тот, что будет на QR-наклейке; у столов и кортов нумерация своя.</p>
      {live ? (
        <p class="note note--lamp">
          <Icon name="info" />
          <span class="note__title">Клуб в боевом режиме: новый стол или корт, смена типа стола и вывод из работы — с причиной; они попадут в журнал, владельцу придёт уведомление.</span>
        </p>
      ) : null}

      <HallSize
        hall={hall}
        clubId={clubId}
        onSaved={async (h) => {
          setHall(h);
          setSaved('Размер зала сохранён.');
          // Столы, которые оказались за стеной, возвращаем в зал
          for (const t of tablesRef.current ?? []) {
            const p = clampCenter(t.plan_x, t.plan_y, t.kind, t.plan_rotation, h);
            if (p.x !== t.plan_x || p.y !== t.plan_y) await commit({ ...t, plan_x: p.x, plan_y: p.y });
          }
          load();
          reload();
        }}
      />

      {tables?.length && oversizeHint(tables, hall) ? (
        <p class="note note--lamp" role="note">
          <Icon name="info" />
          <span class="note__title">{oversizeHint(tables, hall)}</span>
        </p>
      ) : null}

      <div class="hall-ed__bar">
        <p class="hall-ed__count">
          {tables ? (tables.length ? hallCount(tables) : 'Столов и кортов пока нет') : 'Загружаем столы…'}
        </p>
        <div class="row">
          {wide ? (
            <div class="viewtog" role="group" aria-label="Вид зала">
              <button type="button" class="viewtog__btn" aria-pressed={view === 'plan' ? 'true' : 'false'} onClick={() => setView('plan')}>
                План
              </button>
              <button type="button" class="viewtog__btn" aria-pressed={view === 'list' ? 'true' : 'false'} onClick={() => setView('list')}>
                Список
              </button>
            </div>
          ) : null}
          <button type="button" class="btn btn--primary" onClick={() => setAdding(true)} disabled={!tables}>
            <Icon name="plus" />
            Добавить стол или корт
          </button>
        </div>
      </div>

      {error?.text ? (
        <p class="note note--error" role="alert">
          <Icon name="alert" />
          <span class="note__title">{error.text}</span>
        </p>
      ) : (
        <ErrorNote error={error} />
      )}
      <p class="small hall-ed__saved" role="status" aria-live="polite">
        {saved}
      </p>

      {tables && !tables.length ? (
        <div class="empty-state">
          <p class="lead">В зале пока нет столов и кортов.</p>
          <p class="hint">Нажмите «Добавить стол или корт» — он появится на плане, затем его можно перетащить на место.</p>
        </div>
      ) : null}

      {tables?.length && showPlan ? (
        <>
          <PlanEditor
            tables={tables}
            hall={hall}
            selected={selected}
            onSelect={setSelected}
            onMove={update}
            onCommitLater={saver.later}
            onCommitNow={saver.now}
            getTable={(id) => tablesRef.current?.find((x) => x.id === id) ?? null}
          />
          <p class="small muted">Перетащите стол мышью или пальцем. С клавиатуры: Tab — к столу, стрелки — сдвиг на 10 см (с Shift — на 50 см), R — поворот.</p>
          {sel ? (
            <TablePanel
              key={sel.id}
              table={sel}
              tables={tables}
              hall={hall}
              onChange={change}
              onRetire={() => setRetiring(sel)}
            />
          ) : (
            <p class="hint">Выберите стол или корт на плане, чтобы поменять номер, тип или повернуть его.</p>
          )}
        </>
      ) : null}

      {tables?.length && !showPlan ? (
        <TableList
          tables={tables}
          hall={hall}
          onChange={change}
          onRetire={setRetiring}
        />
      ) : null}

      <AddDialog
        open={adding}
        live={live}
        tables={tables ?? []}
        hall={hall}
        clubId={clubId}
        onClose={() => setAdding(false)}
        onDone={async (res, number, family) => {
          setAdding(false);
          setSaved(`${resourceName(family, number)} добавлен.`);
          await load();
          if (res?.id) setSelected(res.id);
          reload();
        }}
      />
      <KindDialog
        ask={kindAsk}
        onClose={() => setKindAsk(null)}
        onSubmit={async (reason) => {
          const t = { ...kindAsk.table, kind: kindAsk.kind };
          await commit(t, reason);
          update(t);
          setKindAsk(null);
          setSaved(`${nameOf(t)}: тип изменён.`);
          reload();
        }}
      />
      <RetireDialog
        table={retiring}
        clubId={clubId}
        live={live}
        onClose={() => setRetiring(null)}
        onDone={async (t) => {
          setRetiring(null);
          setSelected(null);
          setSaved(`${nameOf(t)} выведен из работы.`);
          await load();
          reload();
        }}
      />
    </div>
  );
}

function HallSize({ hall, clubId, onSaved }) {
  const [w, setW] = useState(fmtM(hall.width));
  const [h, setH] = useState(fmtM(hall.height));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const parsed = hallFromMetres(w, h);
  const changed = parsed.hall && (parsed.hall.width !== hall.width || parsed.hall.height !== hall.height);
  return (
    <form
      class="hall-size"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setTried(true);
        if (!parsed.hall) return;
        setBusy(true);
        setError(null);
        try {
          const res = await api.saveHall(clubId, parsed.hall);
          await onSaved(hallSize(res) ?? parsed.hall);
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div class="field">
        <label class="field__label" for="hall-w">
          Ширина зала, м
        </label>
        <input id="hall-w" class="field__input mono" inputMode="decimal" value={w} aria-invalid={tried && parsed.errors.width ? 'true' : undefined} aria-describedby="hall-w-e" onInput={(e) => setW(e.currentTarget.value)} />
        <p class={tried && parsed.errors.width ? 'field__error' : 'field__hint'} id="hall-w-e">
          {(tried && parsed.errors.width) || 'Слева направо на плане'}
        </p>
      </div>
      <div class="field">
        <label class="field__label" for="hall-h">
          Длина зала, м
        </label>
        <input id="hall-h" class="field__input mono" inputMode="decimal" value={h} aria-invalid={tried && parsed.errors.height ? 'true' : undefined} aria-describedby="hall-h-e" onInput={(e) => setH(e.currentTarget.value)} />
        <p class={tried && parsed.errors.height ? 'field__error' : 'field__hint'} id="hall-h-e">
          {(tried && parsed.errors.height) || 'Сверху вниз на плане'}
        </p>
      </div>
      <button type="submit" class="btn btn--secondary" disabled={busy || (!changed && tried)}>
        {busy ? 'Сохраняем…' : 'Сохранить размер зала'}
      </button>
      <ErrorNote error={error} />
    </form>
  );
}

/** План-редактор: стол — кнопка; перетаскивание указателем (мышь, палец, перо), клавиатура — стрелки и R. */
function PlanEditor({ tables, hall, selected, onSelect, onMove, onCommitLater, onCommitNow, getTable }) {
  const ref = useRef(null);
  const drag = useRef(null);
  const svgs = useMemo(() => new Map(['pyramid', 'pool', 'court'].map((k) => [k, tableSvg(k)])), []);

  const down = (e, t) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    onSelect(t.id);
    const rect = ref.current.getBoundingClientRect();
    drag.current = { id: t.id, x: e.clientX, y: e.clientY, orig: t, w: rect.width, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
    d.moved = true;
    onMove(moveTable(d.orig, pxToCm(e.clientX - d.x, d.w, hall), pxToCm(e.clientY - d.y, d.w, hall), hall));
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) onCommitNow(d.id);
  };
  const key = (e, t) => {
    const step = e.shiftKey ? 50 : 10;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    let next = null;
    const cur = getTable(t.id) ?? t;
    if (moves[e.key]) next = moveTable(cur, ...moves[e.key], hall);
    else if (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') next = rotateTable(cur, 90, hall);
    if (!next) return;
    e.preventDefault();
    onSelect(t.id);
    onMove(next);
    onCommitLater(t.id);
  };

  return (
    <div class="hall pe" data-theme="dark">
      <div
        class="pe__floor"
        ref={ref}
        role="group"
        aria-label={`План зала ${metres(hall.width)} на ${metres(hall.height)}, ${hallCount(tables).replace(' в работе', '')}`}
        style={{ aspectRatio: `${hall.width} / ${hall.height}`, '--gx': pct(100 / hall.width), '--gy': pct(100 / hall.height) }}
      >
        {tables.map((t) => {
          // Корт больше зала — рисуем уменьшенным, до стен (подсказка «увеличьте зал» над планом)
          const size = footprint(t.kind, 0);
          const scale = fitScale(t.kind, t.plan_rotation, hall);
          return (
            <button
              type="button"
              key={t.id}
              class={`pe__tbl lit-host${t.busy ? ' pe__tbl--busy' : ''}${t.family === 'court' ? ' pe__tbl--court' : ''}`}
              data-lit={t.lit ? 'true' : 'false'}
              aria-pressed={selected === t.id ? 'true' : 'false'}
              aria-label={tableAria(t)}
              style={{
                left: pct(t.plan_x / hall.width),
                top: pct(t.plan_y / hall.height),
                width: pct((size.w * scale) / hall.width),
                transform: `translate(-50%, -50%) rotate(${t.plan_rotation}deg)`,
              }}
              onPointerDown={(e) => down(e, t)}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
              onKeyDown={(e) => key(e, t)}
              onClick={() => onSelect(t.id)}
            >
              <span class="pe__art" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svgs.get(artKind(t.kind)) }} />
              <span class="pe__num" aria-hidden="true" style={{ transform: `translate(-50%, -50%) rotate(${-t.plan_rotation}deg)` }}>
                {t.number}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Вид ресурса: у стола — выбор среди типов столов, у корта — только «Падел-корт» словом (стол и корт друг в друга
 * не превращаются, №213).
 */
function KindField({ id, t, label, wide = false, hint = true, onChange }) {
  const own = kindsOfFamily(t.family ?? familyOfKind(t.kind));
  if (own.length === 1) {
    return (
      <div class={`field${wide ? ' pe-row__wide' : ''}`}>
        <p class="field__label">{label}</p>
        <p class="pe-kind">{own[0].label}</p>
        {hint ? <p class="field__hint">Корт не превращается в стол: у них своя нумерация и тариф.</p> : null}
      </div>
    );
  }
  return (
    <div class={`field${wide ? ' pe-row__wide' : ''}`}>
      <label class="field__label" for={id}>
        {label}
      </label>
      <select id={id} class="field__input" value={t.kind} aria-describedby={hint ? `${id}-h` : undefined} onChange={(e) => onChange({ ...t, kind: e.currentTarget.value })}>
        {own.map((k) => (
          <option key={k.id} value={k.id}>
            {k.label}
          </option>
        ))}
      </select>
      {hint ? (
        <p class="field__hint" id={`${id}-h`}>
          Стол не превращается в корт: корт добавляется отдельно.
        </p>
      ) : null}
    </div>
  );
}

/** Выбранный стол (корт): номер, тип, поворот, вывод из работы. */
function TablePanel({ table, tables, hall, onChange, onRetire }) {
  const [number, setNumber] = useState(String(table.number));
  const numErr = numberError(number, tables, table.id, table.family);
  return (
    <section class="panel pe-panel" aria-labelledby="pe-sel">
      <h3 class="section-title" id="pe-sel">
        {nameOf(table)}
      </h3>
      <p class="small muted">
        {metres(table.plan_x)} от левой стены, {metres(table.plan_y)} от верхней{table.plan_rotation ? `, поворот ${table.plan_rotation}°` : ''}
      </p>
      <div class="pe-panel__fields">
        <div class="field">
          <label class="field__label" for="pe-num">
            Номер
          </label>
          <input
            id="pe-num"
            class="field__input mono"
            inputMode="numeric"
            value={number}
            aria-invalid={numErr ? 'true' : undefined}
            aria-describedby="pe-num-e"
            onInput={(e) => setNumber(e.currentTarget.value)}
            onChange={() => !numErr && Number(number) !== table.number && onChange({ ...table, number: Number(number) })}
          />
          <p class={numErr ? 'field__error' : 'field__hint'} id="pe-num-e">
            {numErr || 'Сохраняется, когда уходите из поля'}
          </p>
        </div>
        <KindField id="pe-kind" t={table} label={table.family === 'court' ? 'Вид' : 'Тип стола'} onChange={onChange} />
      </div>
      <div class="row">
        <button type="button" class="btn btn--secondary btn--sm" onClick={() => onChange(rotateTable(table, -90, hall))}>
          <Icon name="rotate" class="icon--flip" />
          Повернуть влево
        </button>
        <button type="button" class="btn btn--secondary btn--sm" onClick={() => onChange(rotateTable(table, 90, hall))}>
          <Icon name="rotate" />
          Повернуть вправо
        </button>
        <button type="button" class="btn btn--quiet btn--sm pe-panel__retire" onClick={onRetire} disabled={table.busy}>
          <Icon name="trash" />
          Вывести из работы
        </button>
      </div>
      {table.busy ? <p class="small muted">{familyText('Сейчас на столе игра — вывести его из работы можно после неё.', table.family)}</p> : null}
    </section>
  );
}

/** 360 px: список столов с полями вместо плана. */
function TableList({ tables, hall, onChange, onRetire }) {
  return (
    <ul class="pe-list">
      {tables.map((t) => (
        <TableRow key={t.id} t={t} tables={tables} hall={hall} onChange={onChange} onRetire={onRetire} />
      ))}
    </ul>
  );
}

function TableRow({ t, tables, hall, onChange, onRetire }) {
  const [number, setNumber] = useState(String(t.number));
  const [x, setX] = useState(fmtM(t.plan_x));
  const [y, setY] = useState(fmtM(t.plan_y));
  useEffect(() => {
    setX(fmtM(t.plan_x));
    setY(fmtM(t.plan_y));
  }, [t.plan_x, t.plan_y]);
  const numErr = numberError(number, tables, t.id, t.family);
  const id = (k) => `pl-${k}-${t.id}`;
  const commitPos = () => {
    const nx = Math.round(Number(String(x).replace(',', '.')) * 100);
    const ny = Math.round(Number(String(y).replace(',', '.')) * 100);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
    const p = clampCenter(nx, ny, t.kind, t.plan_rotation, hall);
    if (p.x !== t.plan_x || p.y !== t.plan_y) onChange({ ...t, plan_x: p.x, plan_y: p.y });
    else {
      setX(fmtM(t.plan_x));
      setY(fmtM(t.plan_y));
    }
  };
  return (
    <li class="pe-row">
      <h3 class="pe-row__title">
        <span class="display">{nameOf(t)}</span> <span class="muted">{kindLabel(t.kind)}</span>
      </h3>
      <div class="pe-row__grid">
        <div class="field">
          <label class="field__label" for={id('n')}>
            Номер
          </label>
          <input
            id={id('n')}
            class="field__input mono"
            inputMode="numeric"
            value={number}
            aria-invalid={numErr ? 'true' : undefined}
            aria-describedby={numErr ? id('ne') : undefined}
            onInput={(e) => setNumber(e.currentTarget.value)}
            onChange={() => !numErr && Number(number) !== t.number && onChange({ ...t, number: Number(number) })}
          />
          {numErr ? (
            <p class="field__error" id={id('ne')}>
              {numErr}
            </p>
          ) : null}
        </div>
        <KindField id={id('k')} t={t} label={t.family === 'court' ? 'Вид' : 'Тип'} wide hint={false} onChange={onChange} />
        <div class="field">
          <label class="field__label" for={id('x')}>
            От левой стены, м
          </label>
          <input id={id('x')} class="field__input mono" inputMode="decimal" value={x} onInput={(e) => setX(e.currentTarget.value)} onChange={commitPos} />
        </div>
        <div class="field">
          <label class="field__label" for={id('y')}>
            От верхней стены, м
          </label>
          <input id={id('y')} class="field__input mono" inputMode="decimal" value={y} onInput={(e) => setY(e.currentTarget.value)} onChange={commitPos} />
        </div>
        <div class="field pe-row__wide">
          <label class="field__label" for={id('r')}>
            Поворот
          </label>
          <select id={id('r')} class="field__input" value={String(t.plan_rotation)} onChange={(e) => onChange(rotateTable(t, Number(e.currentTarget.value) - t.plan_rotation, hall))}>
            {[...new Set([0, 90, 180, 270, t.plan_rotation])].sort((a, b) => a - b).map((r) => (
              <option key={r} value={String(r)}>
                {r === 0 || r === 180 ? `${r}° — вдоль зала` : r === 90 || r === 270 ? `${r}° — поперёк зала` : `${r}°`}
              </option>
            ))}
          </select>
        </div>
      </div>
      <button type="button" class="btn btn--quiet btn--sm pe-panel__retire" onClick={() => onRetire(t)} disabled={t.busy}>
        <Icon name="trash" />
        Вывести {nameOf(t, { capital: false, case: 'acc' })} из работы
      </button>
    </li>
  );
}

function AddDialog({ open, tables, hall, clubId, live, onClose, onDone }) {
  const [number, setNumber] = useState('');
  const [reason, setReason] = useState('');
  const [kind, setKind] = useState('pyramid');
  const [numberTouched, setNumberTouched] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const family = familyOfKind(kind);
  useEffect(() => {
    if (!open) return;
    const k = tables[tables.length - 1]?.kind ?? 'pyramid';
    setKind(k);
    setNumber(String(nextNumber(tables, familyOfKind(k))));
    setNumberTouched(false);
    setReason('');
    setTried(false);
    setError(null);
  }, [open]);
  // Номер — свой у столов и у кортов (№213): при смене семьи предлагаем следующий свободный номер этой семьи
  const pickKind = (k) => {
    setKind(k);
    if (!numberTouched && familyOfKind(k) !== family) setNumber(String(nextNumber(tables, familyOfKind(k))));
    setError(null);
  };
  const numErr = numberError(number, tables, null, family);
  const fits = fitsHall(kind, hall);
  const word = resourceName(family, null, { capital: false });
  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (numErr || (live && !reason.trim())) return;
    setBusy(true);
    setError(null);
    const rotation = fitRotation(kind, hall);
    const spot = nextSpot(tables, hall, kind, rotation);
    const n = Number(number);
    try {
      const res = await api.createResource(clubId, resourceBody({ number: n, kind, plan_x: spot.x, plan_y: spot.y, plan_rotation: rotation }, live ? reason : null));
      onDone(res, n, family);
    } catch (err) {
      setError(err?.code === 'duplicate' ? { code: 'duplicate_table' } : err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={family === 'court' ? 'Новый корт' : 'Новый стол'} labelledBy="add-tbl-title">
      <form class="form" onSubmit={submit} noValidate>
        <fieldset>
          <legend class="field__label">Что добавить</legend>
          <div class="rolechoice">
            {KINDS.map((k) => (
              <label class="rolechoice__item" key={k.id}>
                <input type="radio" name="add-kind" checked={kind === k.id} onChange={() => pickKind(k.id)} />
                <span class="rolechoice__box">
                  <span class="rolechoice__title">{k.label}</span>
                  {k.id === COURT_KIND ? <span class="rolechoice__sub">Игра и бронь — слотами по 1–2 ч, до 4 игроков. Нумерация кортов своя: «Корт 1», «Корт 2».</span> : null}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div class="field">
          <label class="field__label" for="add-num">
            Номер {resourceName(family, null, { case: 'gen', capital: false })}
          </label>
          <input
            id="add-num"
            class="field__input mono"
            inputMode="numeric"
            value={number}
            aria-invalid={tried && numErr ? 'true' : undefined}
            aria-describedby="add-num-e"
            onInput={(e) => {
              setNumberTouched(true);
              setNumber(e.currentTarget.value);
            }}
          />
          <p class={tried && numErr ? 'field__error' : 'field__hint'} id="add-num-e">
            {(tried && numErr) || 'Этот номер будет на QR-наклейке и в приложении гостя.'}
          </p>
        </div>
        {!fits ? (
          <p class="note note--lamp">
            <Icon name="info" />
            <span class="note__title">
              {family === 'court' ? 'Корт' : 'Стол'} не помещается в зал {metres(hall.width)} × {metres(hall.height)}
            </span>
            <span class="note__body">Увеличьте размер зала выше: если корты в отдельном помещении, укажите общий размер и поставьте их рядом со столами.</span>
          </p>
        ) : null}
        {live ? (
          <div class="field">
            <label class="field__label" for="add-reason">
              Причина
            </label>
            <textarea id="add-reason" class="field__input field__input--area" rows={2} maxLength={300} value={reason} aria-invalid={tried && !reason.trim() ? 'true' : undefined} aria-describedby="add-reason-e" onInput={(e) => setReason(e.currentTarget.value)} />
            <p class={tried && !reason.trim() ? 'field__error' : 'field__hint'} id="add-reason-e">
              {tried && !reason.trim() ? `Клуб в боевом режиме: без причины ${word} не добавить.` : 'Уйдёт в журнал и владельцу в уведомлении.'}
            </p>
          </div>
        ) : null}
        {error?.code === 'duplicate_table' ? (
          <p class="note note--error" role="alert">
            <Icon name="alert" />
            <span class="note__title">
              {family === 'court' ? 'Корт' : 'Стол'} с номером {number} уже есть. Выберите другой номер.
            </span>
          </p>
        ) : (
          <ErrorNote error={error} />
        )}
        <div class="dialog__actions">
          <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
            {busy ? 'Добавляем…' : `Добавить ${word} ${numErr ? '' : number}`.trim()}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** №164: смена типа стола в боевом режиме — с причиной; владельцу придёт уведомление. */
function KindDialog({ ask, onClose, onSubmit }) {
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const key = ask ? `${ask.table.id}:${ask.kind}` : null;
  useEffect(() => {
    setReason('');
    setTried(false);
    setError(null);
  }, [key]);
  if (!ask) return <Dialog open={false} onClose={onClose} title="" />;
  const { table, kind } = ask;
  const need = !reason.trim();
  const errText = error?.code === 'reason_required' ? 'Клуб в боевом режиме: без причины тип стола не сменить. Напишите причину и сохраните снова.' : null;
  return (
    <Dialog open onClose={onClose} title={`Сменить тип стола ${table.number}?`} labelledBy="kind-title">
      <form
        class="form"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          setTried(true);
          if (need) {
            document.getElementById('kind-reason')?.focus();
            return;
          }
          setBusy(true);
          setError(null);
          try {
            await onSubmit(reason.trim());
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <dl class="facts">
          <div>
            <dt>Было</dt>
            <dd>{kindLabel(table.kind)}</dd>
          </div>
          <div>
            <dt>Станет</dt>
            <dd>{kindLabel(kind)}</dd>
          </div>
        </dl>
        {ask.fromServer ? (
          <p class="note note--lamp" role="alert">
            <Icon name="info" />
            <span class="note__title">Клуб уже в боевом режиме: тип стола меняется только с причиной.</span>
          </p>
        ) : null}
        <p class="hint">Клуб в боевом режиме. Если цены в тарифах разные по типам столов, у стола {table.number} изменится цена часа — для следующих игр.</p>
        <div class="field">
          <label class="field__label" for="kind-reason">
            Причина
          </label>
          <textarea id="kind-reason" class="field__input field__input--area" rows={2} maxLength={300} value={reason} aria-invalid={tried && need ? 'true' : undefined} aria-describedby="kind-reason-e" onInput={(e) => setReason(e.currentTarget.value)} />
          <p class={tried && need ? 'field__error' : 'field__hint'} id="kind-reason-e">
            {tried && need ? 'Клуб в боевом режиме: без причины тип стола не сменить.' : 'Уйдёт в журнал и владельцу в уведомлении.'}
          </p>
        </div>
        {errText ? (
          <p class="note note--error" role="alert">
            <Icon name="alert" />
            <span class="note__title">{errText}</span>
          </p>
        ) : (
          <ErrorNote error={error} />
        )}
        <div class="dialog__actions dialog__actions--row">
          <button type="submit" class="btn btn--primary btn--lg" disabled={busy}>
            {busy ? 'Сохраняем…' : `Сменить тип стола ${table.number}`}
          </button>
          <button type="button" class="btn btn--quiet btn--lg" onClick={onClose}>
            Оставить как было
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function RetireDialog({ table, clubId, live, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    setReason('');
    setTried(false);
    setError(null);
  }, [table?.id]);
  if (!table) return <Dialog open={false} onClose={onClose} title="" />;
  const need = live && !reason.trim();
  const acc = nameOf(table, { case: 'acc', capital: false });
  return (
    <Dialog open onClose={onClose} title={`Вывести ${acc} из работы?`} labelledBy="retire-title">
      <form
        class="form"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          setTried(true);
          if (need) return;
          setBusy(true);
          setError(null);
          try {
            await api.updateResource(clubId, table.id, resourcePatch(table, { active: false }, { reason }));
            onDone(table);
          } catch (err) {
            setError(err?.code === 'table_busy' ? { code: 'table_busy', text: retireBusyText(err.data?.reason, table.number, table.family) } : err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p class="hint">{familyText('Стол пропадёт с плана, из приложения гостя и из брони. История игр за ним сохранится в журнале и отчётах.', table.family)}</p>
        <div class="field">
          <label class="field__label" for="retire-reason">
            Причина{live ? '' : ' (по желанию)'}
          </label>
          <textarea id="retire-reason" class="field__input field__input--area" rows={2} maxLength={300} value={reason} aria-invalid={tried && need ? 'true' : undefined} aria-describedby="retire-reason-e" onInput={(e) => setReason(e.currentTarget.value)} />
          <p class={tried && need ? 'field__error' : 'field__hint'} id="retire-reason-e">
            {tried && need ? `Клуб в боевом режиме: без причины ${resourceName(table.family, null, { capital: false })} не вывести.` : live ? 'Уйдёт в журнал и владельцу в уведомлении.' : 'Попадёт в журнал.'}
          </p>
        </div>
        {error?.text ? (
          <p class="note note--error" role="alert">
            <Icon name="alert" />
            <span class="note__title">{error.text}</span>
          </p>
        ) : (
          <ErrorNote error={error} />
        )}
        <div class="dialog__actions dialog__actions--row">
          <button type="submit" class="btn btn--danger btn--lg" disabled={busy}>
            {busy ? 'Выводим…' : `Вывести ${acc}`}
          </button>
          <button type="button" class="btn btn--quiet btn--lg" onClick={onClose}>
            Оставить в работе
          </button>
        </div>
      </form>
    </Dialog>
  );
}
