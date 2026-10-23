import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { plural } from '@billiardum/shared/format';
import { tableSvg } from '@billiardum/shared/hall';
import { Icon } from '../../components/Icon.jsx';
import { Dialog } from '../../components/Dialog.jsx';
import { ErrorNote } from '../../components/ErrorNote.jsx';
import { useMedia } from '../../components/hooks.js';
import { api } from '../../lib/api.js';
import {
  DEFAULT_HALL,
  KINDS,
  artKind,
  clampCenter,
  footprint,
  hallFromMetres,
  kindLabel,
  metres,
  moveTable,
  nextNumber,
  nextSpot,
  numberError,
  placeUnset,
  planTables,
  pxToCm,
  resourceBody,
  resourcePatch,
  rotateTable,
  tableAria,
} from '../../lib/hallEditor.js';

const TABLES = ['стол', 'стола', 'столов'];
const pct = (v) => `${(v * 100).toFixed(3)}%`;
const fmtM = (cm) => String(Math.round(cm / 10) / 10).replace('.', ',');

/**
 * Шаг «План зала» (№155): размер зала, столы перетаскиванием мышью и пальцем, поворот, номер и тип.
 * Стрелки двигают выбранный стол на 10 см (с Shift — на 50 см), R — поворот на 90°.
 * На узком экране (360 px) — список столов с полями вместо плана. Стол с историей не удаляется — выводится из работы.
 */
export function HallStep({ ctx, ob, reload, live }) {
  const clubId = ctx.club.club_id;
  const wide = useMedia('(min-width: 760px)');
  const [view, setView] = useState('plan');
  const [hall, setHall] = useState(ob.hall?.width ? ob.hall : DEFAULT_HALL);
  const [tables, setTables] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);
  const [adding, setAdding] = useState(false);
  const [retiring, setRetiring] = useState(null);
  const server = useRef(new Map()); // id → стол, как он сохранён на сервере

  const load = useCallback(async () => {
    try {
      const list = planTables(await api.hall(clubId));
      server.current = new Map(list.map((t) => [t.id, t]));
      setTables(placeUnset(list, hall));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [clubId, hall.width, hall.height]);
  useEffect(() => {
    load();
  }, [load]);

  /** Сохранить изменения стола: только изменённые поля. */
  const commit = useCallback(
    async (t) => {
      const before = server.current.get(t.id) ?? {};
      const body = resourcePatch(before, t);
      if (!Object.keys(body).length) return true;
      try {
        await api.updateResource(clubId, t.id, body);
        server.current.set(t.id, { ...before, ...t, unset: false });
        setSaved(`Стол ${t.number} сохранён.`);
        setError(null);
        return true;
      } catch (err) {
        setError(err);
        load();
        return false;
      }
    },
    [clubId, load],
  );

  const update = (t) => setTables((list) => list.map((x) => (x.id === t.id ? t : x)));
  const sel = tables?.find((t) => t.id === selected) ?? null;
  const showPlan = wide && view === 'plan';

  return (
    <div class="stack ob__content hall-ed">
      <p class="lead">Расставьте столы как в зале: гости и ресепшн увидят этот план. Номер стола — тот, что будет на QR-наклейке.</p>
      {live ? (
        <p class="note note--lamp">
          <Icon name="info" />
          <span class="note__title">Клуб в боевом режиме: новый стол и вывод стола из работы попадут в журнал, владельцу придёт уведомление.</span>
        </p>
      ) : null}

      <HallSize
        hall={hall}
        clubId={clubId}
        onSaved={async (h) => {
          setHall(h);
          setSaved('Размер зала сохранён.');
          // Столы, которые оказались за стеной, возвращаем в зал
          for (const t of tables ?? []) {
            const p = clampCenter(t.plan_x, t.plan_y, t.kind, t.plan_rotation, h);
            if (p.x !== t.plan_x || p.y !== t.plan_y) await commit({ ...t, plan_x: p.x, plan_y: p.y });
          }
          load();
          reload();
        }}
      />

      <div class="hall-ed__bar">
        <p class="hall-ed__count">
          {tables ? (tables.length ? `${tables.length} ${plural(tables.length, TABLES)} в работе` : 'Столов пока нет') : 'Загружаем столы…'}
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
            Добавить стол
          </button>
        </div>
      </div>

      <ErrorNote error={error} />
      <p class="small hall-ed__saved" role="status" aria-live="polite">
        {saved}
      </p>

      {tables && !tables.length ? (
        <div class="empty-state">
          <p class="lead">В зале пока нет столов.</p>
          <p class="hint">Нажмите «Добавить стол» — он появится на плане, затем его можно перетащить на место.</p>
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
            onCommit={(id) => {
              const t = tables.find((x) => x.id === id);
              if (t) commit(t);
            }}
            getTable={(id) => tables.find((x) => x.id === id)}
          />
          <p class="small muted">Перетащите стол мышью или пальцем. С клавиатуры: Tab — к столу, стрелки — сдвиг на 10 см (с Shift — на 50 см), R — поворот.</p>
          {sel ? (
            <TablePanel
              key={sel.id}
              table={sel}
              tables={tables}
              hall={hall}
              onChange={async (t) => {
                update(t);
                if (!(await commit(t))) return;
                reload();
              }}
              onRetire={() => setRetiring(sel)}
            />
          ) : (
            <p class="hint">Выберите стол на плане, чтобы поменять номер, тип или повернуть его.</p>
          )}
        </>
      ) : null}

      {tables?.length && !showPlan ? (
        <TableList
          tables={tables}
          hall={hall}
          onChange={async (t) => {
            update(t);
            if (await commit(t)) reload();
          }}
          onRetire={setRetiring}
        />
      ) : null}

      <AddDialog
        open={adding}
        tables={tables ?? []}
        hall={hall}
        clubId={clubId}
        onClose={() => setAdding(false)}
        onDone={async (res, number) => {
          setAdding(false);
          setSaved(`Стол ${number} добавлен.`);
          await load();
          if (res?.id) setSelected(res.id);
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
          setSaved(`Стол ${t.number} выведен из работы.`);
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
          await api.saveHall(clubId, parsed.hall);
          await onSaved(parsed.hall);
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
function PlanEditor({ tables, hall, selected, onSelect, onMove, onCommit, getTable }) {
  const ref = useRef(null);
  const drag = useRef(null);
  const keyTimer = useRef(null);
  const svgs = useMemo(() => new Map(['pyramid', 'pool'].map((k) => [k, tableSvg(k)])), []);

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
    if (d?.moved) onCommit(d.id);
  };
  const key = (e, t) => {
    const step = e.shiftKey ? 50 : 10;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    let next = null;
    if (moves[e.key]) next = moveTable(getTable(t.id), ...moves[e.key], hall);
    else if (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') next = rotateTable(getTable(t.id), 90, hall);
    if (!next) return;
    e.preventDefault();
    onSelect(t.id);
    onMove(next);
    clearTimeout(keyTimer.current);
    keyTimer.current = setTimeout(() => onCommit(t.id), 600);
  };

  return (
    <div class="hall pe" data-theme="dark">
      <div
        class="pe__floor"
        ref={ref}
        role="group"
        aria-label={`План зала ${metres(hall.width)} на ${metres(hall.height)}, ${tables.length} ${plural(tables.length, TABLES)}`}
        style={{ aspectRatio: `${hall.width} / ${hall.height}`, '--gx': pct(100 / hall.width), '--gy': pct(100 / hall.height) }}
      >
        {tables.map((t) => {
          const size = footprint(t.kind, 0);
          return (
            <button
              type="button"
              key={t.id}
              class={`pe__tbl lit-host${t.busy ? ' pe__tbl--busy' : ''}`}
              data-lit={t.lit ? 'true' : 'false'}
              aria-pressed={selected === t.id ? 'true' : 'false'}
              aria-label={tableAria(t)}
              style={{
                left: pct(t.plan_x / hall.width),
                top: pct(t.plan_y / hall.height),
                width: pct(size.w / hall.width),
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

/** Выбранный стол: номер, тип, поворот, вывод из работы. */
function TablePanel({ table, tables, hall, onChange, onRetire }) {
  const [number, setNumber] = useState(String(table.number));
  const numErr = numberError(number, tables, table.id);
  return (
    <section class="panel pe-panel" aria-labelledby="pe-sel">
      <h3 class="section-title" id="pe-sel">
        Стол {table.number}
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
        <div class="field">
          <label class="field__label" for="pe-kind">
            Тип стола
          </label>
          <select id="pe-kind" class="field__input" value={table.kind} onChange={(e) => onChange({ ...table, kind: e.currentTarget.value })}>
            {KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
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
      {table.busy ? <p class="small muted">Сейчас на столе игра — вывести его из работы можно после неё.</p> : null}
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
  const numErr = numberError(number, tables, t.id);
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
        <span class="display">Стол {t.number}</span> <span class="muted">{kindLabel(t.kind)}</span>
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
        <div class="field pe-row__wide">
          <label class="field__label" for={id('k')}>
            Тип
          </label>
          <select id={id('k')} class="field__input" value={t.kind} onChange={(e) => onChange({ ...t, kind: e.currentTarget.value })}>
            {KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
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
        Вывести стол {t.number} из работы
      </button>
    </li>
  );
}

function AddDialog({ open, tables, hall, clubId, onClose, onDone }) {
  const [number, setNumber] = useState('');
  const [kind, setKind] = useState('pyramid');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!open) return;
    setNumber(String(nextNumber(tables)));
    setKind(tables[tables.length - 1]?.kind ?? 'pyramid');
    setTried(false);
    setError(null);
  }, [open]);
  const numErr = numberError(number, tables);
  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (numErr) return;
    setBusy(true);
    setError(null);
    const spot = nextSpot(tables, hall, kind, 0);
    const n = Number(number);
    try {
      const res = await api.createResource(clubId, resourceBody({ number: n, kind, plan_x: spot.x, plan_y: spot.y, plan_rotation: 0 }));
      onDone(res, n);
    } catch (err) {
      setError(err?.code === 'duplicate' ? { code: 'duplicate_table' } : err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Новый стол" labelledBy="add-tbl-title">
      <form class="form" onSubmit={submit} noValidate>
        <div class="field">
          <label class="field__label" for="add-num">
            Номер стола
          </label>
          <input id="add-num" class="field__input mono" inputMode="numeric" value={number} aria-invalid={tried && numErr ? 'true' : undefined} aria-describedby="add-num-e" onInput={(e) => setNumber(e.currentTarget.value)} />
          <p class={tried && numErr ? 'field__error' : 'field__hint'} id="add-num-e">
            {(tried && numErr) || 'Этот номер будет на QR-наклейке и в приложении гостя.'}
          </p>
        </div>
        <fieldset>
          <legend class="field__label">Тип стола</legend>
          <div class="rolechoice">
            {KINDS.map((k) => (
              <label class="rolechoice__item" key={k.id}>
                <input type="radio" name="add-kind" checked={kind === k.id} onChange={() => setKind(k.id)} />
                <span class="rolechoice__box">
                  <span class="rolechoice__title">{k.label}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {error?.code === 'duplicate_table' ? (
          <p class="note note--error" role="alert">
            <Icon name="alert" />
            <span class="note__title">Стол с номером {number} уже есть. Выберите другой номер.</span>
          </p>
        ) : (
          <ErrorNote error={error} />
        )}
        <div class="dialog__actions">
          <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
            {busy ? 'Добавляем…' : `Добавить стол ${numErr ? '' : number}`.trim()}
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
  return (
    <Dialog open onClose={onClose} title={`Вывести стол ${table.number} из работы?`} labelledBy="retire-title">
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
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p class="hint">Стол пропадёт с плана, из приложения гостя и из брони. История игр за ним сохранится в журнале и отчётах.</p>
        <div class="field">
          <label class="field__label" for="retire-reason">
            Причина{live ? '' : ' (по желанию)'}
          </label>
          <textarea id="retire-reason" class="field__input field__input--area" rows={2} maxLength={300} value={reason} aria-invalid={tried && need ? 'true' : undefined} aria-describedby="retire-reason-e" onInput={(e) => setReason(e.currentTarget.value)} />
          <p class={tried && need ? 'field__error' : 'field__hint'} id="retire-reason-e">
            {tried && need ? 'Клуб в боевом режиме: без причины стол не вывести.' : live ? 'Уйдёт в журнал и владельцу в уведомлении.' : 'Попадёт в журнал.'}
          </p>
        </div>
        <ErrorNote error={error} />
        <div class="dialog__actions dialog__actions--row">
          <button type="submit" class="btn btn--danger btn--lg" disabled={busy}>
            {busy ? 'Выводим…' : `Вывести стол ${table.number}`}
          </button>
          <button type="button" class="btn btn--quiet btn--lg" onClick={onClose}>
            Оставить в работе
          </button>
        </div>
      </form>
    </Dialog>
  );
}
