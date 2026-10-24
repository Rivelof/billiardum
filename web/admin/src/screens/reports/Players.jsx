import { useEffect, useState } from 'preact/hooks';
import { formatMoney, formatDate, formatTime } from '@billiardum/shared/format';
import { DataTable } from '../../components/DataTable.jsx';
import { Dialog } from '../../components/Dialog.jsx';
import { ErrorNote } from '../../components/ErrorNote.jsx';
import { Icon } from '../../components/Icon.jsx';
import { api } from '../../lib/api.js';
import { can } from '../../lib/auth.js';
import { countWords, gameMinutes, guestLabel, PAY_LABEL, revealReasonError } from '../../lib/reports.js';
import { formatMinutesShort } from '../../lib/dashboard.js';
import { periodWords, presetRange } from '../../lib/period.js';
import { PrintHead, printNow, ReportFilters, ReportTools, useReportQuery } from './common.jsx';

/**
 * «Кто играл за столом» (№179): стол и период → игры с временем, суммой, способом и гостем маской или ником.
 * Полный телефон — только владельцу по кнопке с причиной; сервер пишет guest.lookup в журнал и уведомляет владельца.
 * Номер живёт только на этом экране до ухода с него и не печатается.
 */
export function PlayersScreen({ ctx, today, title }) {
  const { club, role, timeZone } = ctx;
  const [state, update] = useReportQuery(today, ['table']);
  const [tables, setTables] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(null);
  const [phones, setPhones] = useState({});
  // Период по умолчанию здесь — последние 7 дней: разбор происшествия обычно свежий
  useEffect(() => {
    if (!new URLSearchParams(location.search).get('from')) update(presetRange('7d', today));
  }, []);
  useEffect(() => {
    api
      .hall(club.club_id)
      .then((h) => setTables((Array.isArray(h) ? h : []).map((x) => x.resource).sort((a, b) => a.number - b.number)))
      .catch((err) => setError(err));
  }, [club.club_id]);
  useEffect(() => {
    if (!state.table) {
      setData(null);
      return;
    }
    setBusy(true);
    setError(null);
    api
      .tableGames(club.club_id, state.table, { from: state.from, to: state.to })
      .then((res) => setData(Array.isArray(res?.items) ? res.items : []))
      .catch((err) => setError(err))
      .finally(() => setBusy(false));
  }, [club.club_id, state.table, state.from, state.to]);
  const table = tables?.find((t) => t.id === state.table);
  const when = (iso) => `${formatDate(iso, timeZone)}, ${formatTime(iso, timeZone)}`;
  const columns = [
    { key: 'start', label: 'Начало', head: true, sortValue: (g) => Date.parse(g.started_at), render: (g) => when(g.started_at) },
    { key: 'end', label: 'Конец', render: (g) => (g.ended_at ? formatTime(g.ended_at, timeZone) : 'идёт') },
    { key: 'len', label: 'Длительность', num: true, render: (g) => (g.ended_at ? formatMinutesShort(gameMinutes(g.started_at, g.ended_at)) : 'идёт') },
    { key: 'amount', label: 'Сумма', num: true, sortValue: (g) => g.amount_kopecks, render: (g) => (Number.isSafeInteger(g.amount_kopecks) ? formatMoney(g.amount_kopecks) : '—') },
    { key: 'method', label: 'Способ', render: (g) => (g.methods ?? (g.method ? [g.method] : [])).map((m) => PAY_LABEL[m] ?? m).join(', ') || (g.staff_name ? `касса, ${g.staff_name}` : '—') },
    {
      key: 'guest',
      label: 'Гость',
      render: (g) => (
        <span class="rguest">
          <span>{guestLabel(g.guest)}</span>
          {g.guest?.nick && g.guest?.phone_masked ? <span class="small muted"> · {g.guest.phone_masked}</span> : null}
          {phones[g.session_id] ? (
            <b class="rguest__phone no-print mono">{phones[g.session_id]}</b>
          ) : can.revealPhone(role) && g.guest ? (
            <button type="button" class="btn btn--quiet btn--sm no-print" onClick={() => setReveal(g)} aria-label={`Показать телефон гостя: игра ${when(g.started_at)}`}>
              Показать телефон
            </button>
          ) : null}
        </span>
      ),
    },
  ];
  return (
    <section class="rscreen" aria-labelledby="r-title">
      <PrintHead club={club} title={title} from={state.from} to={state.to} today={today} timeZone={timeZone} extra={table ? `Стол ${table.number}` : null} />
      <div class="rhead">
        <h2 class="section-title" id="r-title">
          {title}
        </h2>
        <ReportTools onPrint={data?.length ? printNow : null} />
      </div>
      <p class="small muted no-print">Для разбора происшествий: поломка, забытая вещь, спор. Гость — ником Бильярдум+ или маской телефона.</p>
      <ReportFilters state={state} update={update} today={today} club={club}>
        <label class="dfield">
          <span class="dfield__label">Стол</span>
          <select class="field__input" value={state.table} onChange={(e) => update({ table: e.currentTarget.value })}>
            <option value="">Выберите стол</option>
            {(tables ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                Стол {t.number}
              </option>
            ))}
          </select>
        </label>
      </ReportFilters>
      <ErrorNote error={error} />
      {!state.table ? (
        <p class="muted">Выберите стол, чтобы увидеть игры за период.</p>
      ) : data ? (
        <>
          <p class="rsummary" role="status">
            Стол {table?.number ?? ''} · {periodWords(state.from, state.to, today)} · {countWords.records(data.length)}
          </p>
          <div class={busy ? 'is-busy' : ''}>
            <DataTable caption={`Игры за столом ${table?.number ?? ''}`} columns={columns} rows={data} rowKey={(g) => g.session_id} empty="За этот период за столом никто не играл." />
          </div>
        </>
      ) : busy ? (
        <p class="muted loading" role="status">
          Загружаем игры…
        </p>
      ) : null}
      <RevealDialog game={reveal} clubId={club.club_id} timeZone={timeZone} onClose={() => setReveal(null)} onDone={(id, phone) => (setPhones((p) => ({ ...p, [id]: phone })), setReveal(null))} />
    </section>
  );
}

function RevealDialog({ game, clubId, timeZone, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setReason('');
    setErr(null);
    setError(null);
  }, [game?.session_id]);
  const submit = async (e) => {
    e.preventDefault();
    const msg = revealReasonError(reason);
    setErr(msg);
    if (msg) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.revealGuestPhone(clubId, game.session_id, reason.trim());
      onDone(game.session_id, res?.phone ?? '—');
    } catch (er) {
      setError(er);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={Boolean(game)} onClose={onClose} title="Показать телефон гостя" labelledBy="reveal-title">
      {game ? (
        <form class="form" onSubmit={submit} noValidate>
          <p class="lead">
            Игра {formatDate(game.started_at, timeZone)}, {formatTime(game.started_at, timeZone)} · {guestLabel(game.guest)}
          </p>
          <div class="note note--lamp" role="note">
            <Icon name="shield" />
            <p class="note__title">Это действие попадёт в журнал</p>
            <p class="note__body">Телефон — персональные данные гостя. Запрос с вашей причиной сохранится в журнале, вам придёт уведомление. Не передавайте номер третьим лицам.</p>
          </div>
          <div class="field">
            <label class="field__label" for="reveal-reason">
              Причина
            </label>
            <input id="reveal-reason" class="field__input" maxLength={300} value={reason} onInput={(e) => setReason(e.currentTarget.value)} aria-invalid={err ? 'true' : undefined} aria-describedby={err ? 'reveal-err' : undefined} />
            {err ? (
              <p class="field__error" id="reveal-err">
                {err}
              </p>
            ) : null}
          </div>
          <ErrorNote error={error} />
          <div class="dialog__actions">
            <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
              {busy ? 'Запрашиваем…' : 'Показать телефон и записать в журнал'}
            </button>
            <button type="button" class="btn btn--quiet btn--block" onClick={onClose}>
              Не показывать
            </button>
          </div>
        </form>
      ) : null}
    </Dialog>
  );
}
