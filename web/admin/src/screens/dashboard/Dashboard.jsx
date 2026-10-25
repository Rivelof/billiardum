import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Shell } from '../../components/Shell.jsx';
import { ErrorNote } from '../../components/ErrorNote.jsx';
import { useStore } from '../../lib/store.js';
import { auth, can } from '../../lib/auth.js';
import { api } from '../../lib/api.js';
import { BASE } from '../../lib/env.js';
import { navigate } from '../../lib/router.js';
import { csvName, fileNameFrom, saveFile } from '../../lib/export.js';
import { comparePeriod, periodError, periodWords, PRESETS, presetRange, workDate, DEFAULT_DAY_START, addDays, MAX_DAYS } from '../../lib/period.js';
import { allClubsScope, dashboardQuery, dashboardView, KINDS, KIND_LABEL, nowView, readFilters, TABS, writeFilters } from '../../lib/dashboard.js';
import { SummaryTab, MoneyTab, HallTab, GuestsTab, ControlTab } from './tabs.jsx';
import { NetworkTab } from './NetworkTab.jsx';
import { isNetworkManager, moneyHiddenForAll } from '../../lib/networkBase.js';
import { dashboardTabs } from '../../lib/networkDashboard.js';
import '../../styles/dashboard.css';

const TAB_VIEW = { summary: SummaryTab, money: MoneyTab, hall: HallTab, guests: GuestsTab, control: ControlTab };
const NOW_TABS = new Set(['summary', 'hall']);

/**
 * Дашборд владельца (M5.2, docs/contracts/m5-2.md §3): период, клуб (у владельца нескольких — «Все мои клубы»),
 * тип стола, сравнение; вкладки Сводка · Деньги · Зал · Гости и брони · Контроль. Отдельный чанк.
 * M5.5: управляющему сети — без «Денег» (№192); у участника сети — вкладка «Сеть» со сравнением клубов (№193).
 */
export function Dashboard({ ctx }) {
  const { club, role, user, timeZone } = ctx;
  const { clubs, networks } = useStore(auth);
  const [dayStart, setDayStart] = useState(DEFAULT_DAY_START);
  const today = workDate(Date.now(), timeZone, dayStart);
  const tabsAll = dashboardTabs(TABS, { networkManager: isNetworkManager(club), hasNetwork: networks.length > 0 });
  const [f, setF] = useState(() => readFilters(location.search, today, tabsAll));
  const [networkId, setNetworkId] = useState(() => new URLSearchParams(location.search).get('network'));
  const [data, setData] = useState(null);
  const [dataKey, setDataKey] = useState(null);
  const [now, setNow] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(null);
  const [exportError, setExportError] = useState(null);

  const allScope = allClubsScope(clubs);
  const canAll = allScope.canAll;
  const scope = f.all && canAll ? 'all' : club.club_id;
  // «Деньги» у «Все мои клубы» скрыты, если все клубы выборки — через сеть (сервер ответил бы 403)
  const tabs = scope === 'all' && moneyHiddenForAll(clubs) ? tabsAll.filter((t) => t.value !== 'money') : tabsAll;
  const tab = tabs.some((t) => t.value === f.tab) ? f.tab : 'summary';
  const netTab = tab === 'network';
  const network = networks.find((n) => n.network_id === networkId) ?? networks.find((n) => n.network_id === club.network_id) ?? networks[0] ?? null;
  // Экспорт — только владелец (№166); у сводки «Все мои клубы» — если он владелец во всех её клубах
  const canExport = scope === 'all' ? allScope.exportAll : can.dashboardExport(role);

  const update = (patch) => {
    setF((prev) => {
      const next = { ...prev, ...patch };
      history.replaceState(null, '', `${location.pathname}${writeFilters(next)}`);
      return next;
    });
  };

  const key = `${scope}|${tab}|${f.from}|${f.to}|${f.kind}|${f.compare}`;
  const seq = useRef(0);
  const load = useCallback(async () => {
    // Вкладка «Сеть» грузит своё (GET /api/networks/{id}/dashboard)
    if (netTab) return;
    const my = ++seq.current;
    setBusy(true);
    try {
      const res = await api.dashboard(scope, dashboardQuery({ ...f, tab }));
      if (my !== seq.current) return;
      setData(res);
      setDataKey(key);
      setError(null);
      const ds = res?.period?.day_start_local;
      if (typeof ds === 'string' && ds !== dayStart) setDayStart(ds);
    } catch (err) {
      if (my === seq.current) setError(err);
    } finally {
      if (my === seq.current) setBusy(false);
    }
  }, [key]);

  useEffect(() => {
    load();
  }, [load]);

  // «Сейчас» — на Сводке и в Зале, обновляется раз в 30 секунд
  const loadNow = useCallback(async () => {
    try {
      setNow(await api.dashboardNow(scope));
    } catch {
      // статус зала — дополнительный блок; ошибку покажет основной запрос
    }
  }, [scope]);
  useEffect(() => {
    if (!NOW_TABS.has(tab)) return undefined;
    loadNow();
    const t = setInterval(() => document.visibilityState === 'visible' && loadNow(), 30000);
    return () => clearInterval(t);
  }, [tab, loadNow]);

  const exportTable = async (table) => {
    if (!canExport) return;
    setExporting(table);
    setExportError(null);
    try {
      const query = { from: f.from, to: f.to, table, ...(f.kind ? { kind: f.kind } : {}) };
      const res = await api.dashboardExport(scope, query);
      const blob = await res.blob();
      saveFile(fileNameFrom(res, csvName('dashboard', table, f.from, f.to)), blob);
    } catch (err) {
      setExportError(err);
    } finally {
      setExporting(null);
    }
  };

  // Фильтры закреплены сразу под шапкой программы: её высота разная на телефоне и планшете
  useEffect(() => {
    const bar = document.querySelector('.bar');
    const root = document.querySelector('.dash');
    if (!bar || !root) return undefined;
    const setTop = () => root.style.setProperty('--dash-top', `${Math.round(bar.getBoundingClientRect().height)}px`);
    setTop();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(setTop);
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);

  const View = TAB_VIEW[tab];
  // Прошлый ответ остаётся на экране приглушённым, пока идёт новый
  const view = useMemo(() => (data ? dashboardView(data) : null), [data]);
  const nowV = useMemo(() => (now ? nowView(now) : null), [now]);
  const kinds = view?.period.kinds.length ? view.period.kinds : nowV?.byKind.length ? nowV.byKind.map((k) => k.kind) : KINDS.map((k) => k.value);
  const tz = view?.period.timezone ?? timeZone;
  const cmp = f.compare ? (view?.compare ?? comparePeriod(f.from, f.to, f.preset)) : null;

  return (
    <Shell club={club} role={role} user={user} timeZone={timeZone} active="dashboard" title="Дашборд">
      <div class="page dash">
        <Filters f={f} update={update} today={today} clubs={clubs} club={club} canAll={canAll} scope={scope} kinds={kinds} networkTab={netTab} />
        <p class="dash__period">
          <b>{periodWords(f.from, f.to, today)}</b>
          {netTab ? ' · все клубы сети' : scope === 'all' ? ` · все мои клубы (${allScope.count})` : ''}
          {f.kind && !netTab ? ` · ${KIND_LABEL[f.kind].toLowerCase()}` : ''}
          {cmp ? <span class="muted"> · сравнение с {periodWords(cmp.from, cmp.to, today)}</span> : null}
        </p>
        <Tabs tabs={tabs} value={tab} onChange={(next) => update({ tab: next })} />
        <div class="dash__panel" role="tabpanel" id={`dash-panel-${tab}`} aria-labelledby={`dash-tab-${tab}`} tabIndex={-1}>
          {netTab ? (
            <NetworkTab
              networks={networks}
              network={network}
              clubs={clubs}
              filters={f}
              today={today}
              onNetwork={(id) => {
                setNetworkId(id);
                const q = new URLSearchParams(location.search);
                q.set('network', id);
                history.replaceState(null, '', `${location.pathname}?${q.toString()}`);
              }}
            />
          ) : null}
          {netTab ? null : (
            <ErrorNote error={error}>
              <button type="button" class="btn btn--secondary btn--sm" onClick={load}>
                Повторить
              </button>
            </ErrorNote>
          )}
          <ErrorNote error={exportError} />
          {netTab ? null : view ? (
            <View
              view={view}
              now={nowV}
              busy={busy || dataKey !== key}
              ctx={{ ...ctx, timeZone: tz, scope, today, filters: { ...f, tab }, canExport, exporting, exportTable: canExport ? exportTable : null, onTab: (next) => update({ tab: next }), reloadNow: loadNow }}
            />
          ) : !error ? (
            <p class="muted loading" role="status">
              Считаем цифры за период…
            </p>
          ) : null}
        </div>
      </div>
    </Shell>
  );
}

function Filters({ f, update, today, clubs, club, canAll, scope, kinds, networkTab = false }) {
  const [from, setFrom] = useState(f.from);
  const [to, setTo] = useState(f.to);
  const [custom, setCustom] = useState(f.preset === 'custom');
  const [err, setErr] = useState(null);
  const manageClubs = clubs.filter((c) => can.dashboard(c.role));
  const choosePreset = (p) => {
    if (p === 'custom') {
      setCustom(true);
      setFrom(f.from);
      setTo(f.to);
      return;
    }
    setCustom(false);
    setErr(null);
    update({ preset: p, ...presetRange(p, today) });
  };
  const applyCustom = (e) => {
    e.preventDefault();
    const msg = periodError(from, to, today);
    setErr(msg);
    if (!msg) update({ preset: 'custom', from, to });
  };
  const chooseClub = (v) => {
    if (v === 'all') update({ all: true });
    else if (v === club.club_id) update({ all: false });
    else navigate(`${BASE}c/${encodeURIComponent(v)}/dashboard${writeFilters({ ...f, all: false })}`);
  };
  return (
    <div class="dfilters" role="search" aria-label="Фильтры дашборда">
      <div class="dfilters__row">
        <label class="dfield">
          <span class="dfield__label">Период</span>
          <select class="field__input" value={custom ? 'custom' : f.preset} onChange={(e) => choosePreset(e.currentTarget.value)}>
            {PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {!networkTab && (manageClubs.length > 1 || canAll) ? (
          <label class="dfield">
            <span class="dfield__label">Клуб</span>
            <select class="field__input" value={scope === 'all' ? 'all' : club.club_id} onChange={(e) => chooseClub(e.currentTarget.value)}>
              {canAll ? <option value="all">Все мои клубы</option> : null}
              {manageClubs.map((c) => (
                <option key={c.club_id} value={c.club_id}>
                  {c.name ?? 'Клуб'}
                </option>
              ))}
            </select>
          </label>
        ) : null}
{networkTab ? null : (
        <label class="dfield">
          <span class="dfield__label">Тип стола</span>
          <select class="field__input" value={f.kind} onChange={(e) => update({ kind: e.currentTarget.value })}>
            <option value="">Все столы</option>
            {KINDS.filter((k) => kinds.includes(k.value) || k.value === f.kind).map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        )}
        <label class="dswitch">
          <input type="checkbox" checked={f.compare} onChange={(e) => update({ compare: e.currentTarget.checked })} />
          <span class="dswitch__track" aria-hidden="true">
            <span class="dswitch__knob" />
          </span>
          <span>
            Сравнить<span class="dswitch__more"> с прошлым периодом</span>
          </span>
        </label>
      </div>
      {custom ? (
        <form class="dfilters__custom" onSubmit={applyCustom} noValidate>
          <label class="dfield">
            <span class="dfield__label">С</span>
            <input class="field__input" type="date" value={from} min={addDays(today, -(MAX_DAYS * 3))} max={today} onInput={(e) => setFrom(e.currentTarget.value)} aria-invalid={err ? 'true' : undefined} aria-describedby={err ? 'dperiod-err' : undefined} />
          </label>
          <label class="dfield">
            <span class="dfield__label">По</span>
            <input class="field__input" type="date" value={to} max={today} onInput={(e) => setTo(e.currentTarget.value)} aria-invalid={err ? 'true' : undefined} aria-describedby={err ? 'dperiod-err' : undefined} />
          </label>
          <button type="submit" class="btn btn--primary">
            Показать за период
          </button>
          {err ? (
            <p class="field__error" id="dperiod-err" role="alert">
              {err}
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}

/** Вкладки: на телефоне — сегменты в сетке, на планшете и компьютере — строка; стрелки переключают. */
function Tabs({ tabs = TABS, value, onChange }) {
  const refs = useRef({});
  const onKeyDown = (e) => {
    const i = tabs.findIndex((t) => t.value === value);
    const map = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 1, ArrowUp: -1 };
    let next = null;
    if (map[e.key]) next = tabs[(i + map[e.key] + tabs.length) % tabs.length];
    else if (e.key === 'Home') next = tabs[0];
    else if (e.key === 'End') next = tabs[tabs.length - 1];
    if (!next) return;
    e.preventDefault();
    onChange(next.value);
    refs.current[next.value]?.focus();
  };
  return (
    <div class={`dtabs dtabs--${tabs.length}`} role="tablist" aria-label="Разделы дашборда" onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button
          key={t.value}
          ref={(el) => (refs.current[t.value] = el)}
          type="button"
          role="tab"
          id={`dash-tab-${t.value}`}
          class="dtabs__tab"
          aria-selected={t.value === value ? 'true' : 'false'}
          aria-controls={t.value === value ? `dash-panel-${t.value}` : undefined}
          tabIndex={t.value === value ? 0 : -1}
          onClick={() => onChange(t.value)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

