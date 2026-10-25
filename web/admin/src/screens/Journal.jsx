import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { Ill } from '../components/Ill.jsx';
import { plural } from '@billiardum/shared/format';
import { Shell } from '../components/Shell.jsx';
import { Icon } from '../components/Icon.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { api } from '../lib/api.js';
import { can } from '../lib/auth.js';
import { ACTION_GROUPS, actorLabel, auditView, groupByDate, journalLink, legacyActionParam, matchesAction } from '../lib/audit.js';
import { periodRange } from '../lib/zone.js';
import { resourceName } from '@billiardum/shared/resource';

const PERIODS = [
  { value: 'today', label: 'Сегодня' },
  { value: 'yesterday', label: 'Вчера' },
  { value: 'week', label: '7 дней' },
];
const RECORDS = ['запись', 'записи', 'записей'];

/**
 * Журнал действий клуба (только дополняется, инвариант 2): фильтры по периоду, действию, столу и сотруднику,
 * «Проверить цепочку» хешей (владелец, GET /audit/verify).
 */
export function Journal({ ctx }) {
  const { club, role, user, timeZone } = ctx;
  const clubId = club.club_id;
  // M5.2: переход из «Контроля» дашборда — ?group=manual&period=week&actor={id}
  const [initial] = useState(() => journalLink(typeof location === 'undefined' ? '' : location.search));
  const [period, setPeriod] = useState(initial.period);
  const [group, setGroup] = useState(initial.group);
  const [resource, setResource] = useState('');
  const [actor, setActor] = useState(initial.actor);
  const [items, setItems] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [tables, setTables] = useState([]);
  const [actors, setActors] = useState(() => new Map());
  const [verify, setVerify] = useState(null);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    api
      .hall(clubId)
      .then((h) => setTables((Array.isArray(h) ? h : []).map((x) => x.resource).sort((a, b) => Number(a.family === 'court') - Number(b.family === 'court') || a.number - b.number)))
      .catch(() => {});
  }, [clubId]);

  const query = useMemo(() => ({ ...periodRange(period, Date.now(), timeZone), action: group, resource, actor }), [period, group, resource, actor, timeZone]);
  const [legacy, setLegacy] = useState(false); // сервер принимает только одно действие или префикс «x.»

  const fetchPage = useCallback(
    async (after) => {
      if (!legacy) {
        try {
          return { res: await api.audit(clubId, { ...query, cursor: after }), clientFilter: false };
        } catch (err) {
          if (err?.code !== 'bad_request' || !query.action) throw err;
          setLegacy(true);
        }
      }
      const param = legacyActionParam(query.action);
      const res = await api.audit(clubId, { ...query, action: param ?? undefined, cursor: after });
      return { res, clientFilter: param === null };
    },
    [clubId, query, legacy],
  );

  const load = useCallback(
    async (after) => {
      setBusy(true);
      setError(null);
      try {
        const { res, clientFilter } = await fetchPage(after);
        const all = Array.isArray(res?.items) ? res.items : [];
        const list = clientFilter ? all.filter((it) => matchesAction(query.action, it.action)) : all;
        setItems((prev) => (after ? [...(prev ?? []), ...list] : list));
        setCursor(res?.next_cursor ?? null);
        setActors((prev) => {
          const next = new Map(prev);
          for (const it of all) if (it.actor_id && (it.actor_name || it.actor_role || it.actor?.name || it.actor?.role)) next.set(it.actor_id, actorLabel(it));
          return next;
        });
      } catch (err) {
        setError(err);
      } finally {
        setBusy(false);
      }
    },
    [fetchPage, query.action],
  );

  useEffect(() => {
    load(null);
  }, [query]);

  const runVerify = async () => {
    setVerifying(true);
    setVerify(null);
    try {
      setVerify(await api.verify(clubId));
    } catch (err) {
      setVerify({ error: err });
    } finally {
      setVerifying(false);
    }
  };

  const tableMap = useMemo(() => new Map(tables.map((t) => [t.id, { number: t.number, family: t.family, type: t.type }])), [tables]);
  const views = (items ?? []).map((it) => auditView(it, timeZone, { tables: tableMap }));
  const groups = groupByDate(views);

  return (
    <Shell club={club} role={role} user={user} timeZone={timeZone} active="journal" title="Журнал">
      <div class="page journal">
        <div class="journal__top">
          <p class="hint">Журнал только дополняется: записи нельзя изменить или удалить, каждая связана хешем с предыдущей.</p>
          {can.verify(role) ? (
            <button type="button" class="btn btn--secondary" onClick={runVerify} disabled={verifying}>
              <Icon name="chain" />
              {verifying ? 'Проверяем цепочку…' : 'Проверить цепочку'}
            </button>
          ) : null}
        </div>

        {verify ? <VerifyResult result={verify} /> : null}

        <form class="filters" aria-label="Фильтры журнала" onSubmit={(e) => e.preventDefault()}>
          <fieldset class="pills">
            <legend class="visually-hidden">Период</legend>
            {PERIODS.map((p) => (
              <label class="pill" key={p.value}>
                <input type="radio" name="period" value={p.value} checked={period === p.value} onChange={() => setPeriod(p.value)} />
                <span>{p.label}</span>
              </label>
            ))}
          </fieldset>
          <div class="filters__selects">
            <div class="field">
              <label class="field__label" for="f-action">
                Действие
              </label>
              <select id="f-action" class="field__input" value={group} onChange={(e) => setGroup(e.currentTarget.value)}>
                {ACTION_GROUPS.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.label}
                  </option>
                ))}
              </select>
            </div>
            <div class="field">
              <label class="field__label" for="f-table">
                {tables.some((t) => t.family === 'court') ? 'Стол или корт' : 'Стол'}
              </label>
              <select id="f-table" class="field__input" value={resource} onChange={(e) => setResource(e.currentTarget.value)}>
                <option value="">{tables.some((t) => t.family === 'court') ? 'Все столы и корты' : 'Все столы'}</option>
                {tables.map((t) => (
                  <option key={t.id} value={t.id}>
                    {resourceName(t)}
                  </option>
                ))}
              </select>
            </div>
            <div class="field">
              <label class="field__label" for="f-actor">
                Сотрудник
              </label>
              <select id="f-actor" class="field__input" value={actor} onChange={(e) => setActor(e.currentTarget.value)}>
                <option value="">Все</option>
                {actor && !actors.has(actor) ? <option value={actor}>Выбранный сотрудник</option> : null}
                {[...actors].map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </form>

        <ErrorNote error={error}>
          <button type="button" class="btn btn--secondary btn--sm" onClick={() => load(null)}>
            Загрузить снова
          </button>
        </ErrorNote>

        {items === null ? (
          <p class="muted loading">Загружаем журнал…</p>
        ) : views.length ? (
          <>
            <p class="small" aria-live="polite">
              Показано {views.length} {plural(views.length, RECORDS)}
            </p>
            {groups.map((g) => (
              <section class="day" key={g.date} aria-label={g.date}>
                <h2 class="day__title">{g.date}</h2>
                <ol class="log">
                  {g.items.map((v) => (
                    <li key={v.id} class={`log__item${v.manual ? ' log__item--manual' : ''}`}>
                      <span class="log__time mono">{v.time}</span>
                      <div class="log__body">
                        <p class="log__title">
                          {v.manual ? <span class="log__tag">Ручное</span> : null}
                          {v.title}
                          {v.table ? <span class="log__table"> · {v.table}</span> : null}
                        </p>
                        {v.details.length ? <p class="log__details">{v.details.join(' · ')}</p> : null}
                        {v.reason ? <p class="log__reason">«{v.reason}»</p> : null}
                        <p class="log__meta">
                          <span>{v.actor}</span>
                          {v.seq !== null ? <span class="mono">№ {v.seq}</span> : null}
                          {v.hash ? <span class="mono" title="Хеш записи">{v.hash}</span> : null}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
            {cursor ? (
              <button type="button" class="btn btn--quiet btn--block" disabled={busy} onClick={() => load(cursor)}>
                {busy ? 'Загружаем…' : 'Показать ещё'}
              </button>
            ) : null}
          </>
        ) : (
          <div class="empty-queue">
            <Ill name="cue" />
            <Icon name="journal" size={32} />
            <p class="empty-queue__title">За этот период записей нет</p>
            <p class="hint">Выберите другой период или снимите фильтры. Записи появляются при каждой игре, оплате и действии персонала.</p>
          </div>
        )}
      </div>
    </Shell>
  );
}

function VerifyResult({ result }) {
  if (result.error) {
    return (
      <ErrorNote error={result.error} />
    );
  }
  if (result.ok) {
    return (
      <div class="note note--free verify" role="status">
        <Icon name="shield" />
        <p class="note__title">Цепочка цела</p>
        <p class="note__body">
          Проверено {result.count} {plural(result.count ?? 0, RECORDS)}: ни одна не изменена и не удалена. Хеш последней записи{' '}
          <span class="mono">{String(result.head_hash ?? '').slice(0, 16)}…</span> совпадает с тем, что приходит вам в утренней сводке.
        </p>
      </div>
    );
  }
  return (
    <div class="note note--error verify" role="alert">
      <Icon name="alert" />
      <p class="note__title">Цепочка нарушена на записи № {result.broken_seq}</p>
      <p class="note__body">
        Запись изменили или удалили в базе в обход программы. Сохраните этот экран и сразу сообщите в поддержку платформы.
      </p>
    </div>
  );
}
