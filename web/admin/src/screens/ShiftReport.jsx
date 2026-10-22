import { useCallback, useEffect, useState } from 'preact/hooks';
import { formatDate, formatMoney, formatTime, plural } from '@billiardum/shared/format';
import { Shell } from '../components/Shell.jsx';
import { Icon } from '../components/Icon.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { api } from '../lib/api.js';
import { ACTION_LABEL } from '../lib/audit.js';
import { reconcile, revenueTable, staffName } from '../lib/shift.js';
import { METHOD_LABEL, minutesWords } from '../lib/words.js';
import { linkHandler } from '../lib/router.js';
import { BASE } from '../lib/env.js';

const GAMES = ['игра', 'игры', 'игр'];
const RECEIPTS = ['чек', 'чека', 'чеков'];

/** Часы игры коротко: 3380 → «56 ч 20 мин». */
function hoursShort(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (!h) return `${m} мин`;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

const pct = (v) => `${String(Math.round((Number(v) || 0) * 10) / 10).replace('.', ',')} %`;

/**
 * Отчёт смены (PRODUCT §4.2, `GET /api/shifts/{id}/report`, backend-kkt) для владельца и управляющего:
 * наличные и расхождение, выручка столов и бара по способам оплаты, часы игры и загрузка, сверка ККТ и онлайн
 * до копейки, ручные действия, минуты сервисного света по сотрудникам и столам (№71).
 */
export function ShiftReport({ ctx }) {
  const { club, role, user, timeZone, id } = ctx;
  const clubId = club.club_id;
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setReport(await api.shiftReport(id));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const s = report?.shift;
  const tz = s?.timezone ?? timeZone;
  const live = report ? report.period?.live ?? !s?.closed_at : false;
  const back = (
    <a class="btn btn--quiet btn--sm" href={`${BASE}c/${encodeURIComponent(clubId)}/shift`} onClick={linkHandler}>
      <Icon name="back" />
      Все смены
    </a>
  );

  return (
    <Shell club={club} role={role} user={user} timeZone={timeZone} active="shift" title="Отчёт смены">
      <div class="page report">
        <div class="report__back">{back}</div>
        <ErrorNote error={error}>
          <button type="button" class="btn btn--secondary btn--sm" onClick={load}>
            Загрузить снова
          </button>
        </ErrorNote>
        {!report && !error ? <p class="muted">Загружаем отчёт…</p> : null}
        {report ? (
          <>
            <header class="report__head">
              <h2 class="report__title display">
                Смена {s.number ? `№ ${s.number}, ` : ''}
                {formatDate(s.opened_at, tz)}
              </h2>
              <p class="report__when">
                <span class="mono">
                  {formatTime(s.opened_at, tz)}–{live ? 'сейчас' : formatTime(s.closed_at, tz)}
                </span>
                {staffName(s, 'opened') ? ` · открыта: ${staffName(s, 'opened')}` : ''}
                {staffName(s, 'closed') ? ` · закрыта: ${staffName(s, 'closed')}` : ''}
              </p>
              {live ? (
                <p class="badge badge--play">
                  <span class="badge__dot" aria-hidden="true" />
                  Смена ещё идёт, цифры на этот момент
                </p>
              ) : null}
            </header>
            <div class="report__grid">
              <Cash cash={report.cash ?? s} comment={s.close_comment ?? s.comment} />
              <Reconcile rec={report.reconciliation} />
              <Revenue revenue={report.revenue} />
              <Play play={report.play} />
              <Service light={report.service_light} />
              <Manual manual={report.manual_actions} timeZone={tz} />
            </div>
          </>
        ) : null}
      </div>
    </Shell>
  );
}

function Cash({ cash, comment }) {
  const d = cash.discrepancy_kopecks;
  const closed = Number.isSafeInteger(cash.actual_cash_kopecks);
  return (
    <section class="rcard rcard--cash" aria-labelledby="r-cash">
      <h3 class="rcard__title" id="r-cash">
        <Icon name="register" />
        Наличные в кассе
      </h3>
      <dl class="receipt">
        <div class="receipt__row">
          <dt>Размен</dt>
          <dd class="receipt__sum">{formatMoney(cash.float_kopecks ?? 0)}</dd>
        </div>
        {Number.isSafeInteger(cash.cash_sales_kopecks) ? (
          <div class="receipt__row">
            <dt>Наличные продажи</dt>
            <dd class="receipt__sum">+{formatMoney(cash.cash_sales_kopecks)}</dd>
          </div>
        ) : null}
        {cash.cash_refunds_kopecks ? (
          <div class="receipt__row">
            <dt>Наличные возвраты</dt>
            <dd class="receipt__sum">−{formatMoney(cash.cash_refunds_kopecks)}</dd>
          </div>
        ) : null}
        <div class="receipt__row">
          <dt>Должно быть</dt>
          <dd class="receipt__sum">{formatMoney(cash.expected_cash_kopecks ?? 0)}</dd>
        </div>
        {closed ? (
          <div class="receipt__row receipt__row--total">
            <dt>Факт</dt>
            <dd class="receipt__sum">{formatMoney(cash.actual_cash_kopecks)}</dd>
          </div>
        ) : null}
      </dl>
      {closed ? (
        <p class={`verdict verdict--${d ? 'bad' : 'ok'}`}>
          <Icon name={d ? 'alert' : 'check'} />
          <span>
            {d ? `${d < 0 ? 'Недостача' : 'Излишек'} ` : 'Сходится до копейки'}
            {d ? <b class="mono">{formatMoney(Math.abs(d))}</b> : null}
          </span>
        </p>
      ) : (
        <p class="hint">Факт наличных вводят при закрытии смены.</p>
      )}
      {comment ? <p class="report__comment">«{comment}»</p> : null}
    </section>
  );
}

function Revenue({ revenue }) {
  const t = revenueTable(revenue);
  const refunds = revenue?.refunds?.total_kopecks ?? 0;
  const withOther = t.other > 0;
  const withPk = t.packages > 0;
  return (
    <section class="rcard rcard--wide" aria-labelledby="r-rev">
      <h3 class="rcard__title" id="r-rev">
        <Icon name="cash" />
        Выручка: {formatMoney(Number.isSafeInteger(revenue?.total_kopecks) ? revenue.total_kopecks : t.total)}
      </h3>
      <table class="rtable">
        <caption class="visually-hidden">Выручка столов и бара по способам оплаты</caption>
        <thead>
          <tr>
            <th scope="col">Способ оплаты</th>
            <th scope="col" class="num">
              Столы
            </th>
            <th scope="col" class="num">
              Бар
            </th>
            {withPk ? (
              <th scope="col" class="num">
                Пакеты
              </th>
            ) : null}
            {withOther ? (
              <th scope="col" class="num">
                Прочее
              </th>
            ) : null}
            <th scope="col" class="num">
              Итого
            </th>
          </tr>
        </thead>
        <tbody>
          {t.rows.map((r) => (
            <tr key={r.method}>
              <th scope="row">{METHOD_LABEL[r.method]}</th>
              <td class="num mono" data-label="Столы">
                {formatMoney(r.tables)}
              </td>
              <td class="num mono" data-label="Бар">
                {formatMoney(r.bar)}
              </td>
              {withPk ? (
                <td class="num mono" data-label="Пакеты">
                  {formatMoney(r.packages)}
                </td>
              ) : null}
              {withOther ? (
                <td class="num mono" data-label="Прочее">
                  {formatMoney(r.other)}
                </td>
              ) : null}
              <td class="num mono" data-label="Итого">
                {formatMoney(r.total)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Всего</th>
            <td class="num mono" data-label="Столы">
              {formatMoney(t.tables)}
            </td>
            <td class="num mono" data-label="Бар">
              {formatMoney(t.bar)}
            </td>
            {withPk ? (
              <td class="num mono" data-label="Пакеты">
                {formatMoney(t.packages)}
              </td>
            ) : null}
            {withOther ? (
              <td class="num mono" data-label="Прочее">
                {formatMoney(t.other)}
              </td>
            ) : null}
            <td class="num mono" data-label="Итого">
              {formatMoney(t.total)}
            </td>
          </tr>
        </tfoot>
      </table>
      <p class="small">
        Наличные и карта на терминале — чеки ККТ клуба; СБП и карта онлайн — ЮKassa.{withPk ? ' Пакеты часов — предоплата: чек при покупке, зачёт при игре.' : ''}
        {refunds ? ` Возвраты за смену: ${formatMoney(refunds)}, после возвратов — ${formatMoney(revenue.net_kopecks ?? t.total - refunds)}.` : ''}
      </p>
    </section>
  );
}

function Reconcile({ rec }) {
  const kkt = reconcile(rec?.kkt);
  const online = reconcile(rec?.online);
  const k = rec?.kkt ?? {};
  const o = rec?.online ?? {};
  const pending = (k.receipts?.pending?.count ?? 0) + (k.receipts?.unknown?.count ?? 0);
  const failed = k.receipts?.failed?.count ?? 0;
  const UNCHECKED = {
    unavailable: 'ЮKassa не ответила — сверим позже, откройте отчёт ещё раз.',
    not_configured: 'Магазин ЮKassa клуба не подключён — сверять не с чем.',
    skipped: 'Сверка с ЮKassa не запрашивалась.',
    too_many: 'Слишком много платежей для сверки за один раз — сверьте в личном кабинете ЮKassa.',
  };
  const word = (c, extra) => (c.state === 'ok' ? 'Сходится до копейки' : c.state === 'diff' ? `Расходится на ${formatMoney(Math.abs(c.diff))}${extra ? `: ${extra}` : ''}` : null);
  return (
    <section class="rcard" aria-labelledby="r-rec">
      <h3 class="rcard__title" id="r-rec">
        <Icon name="shield" />
        Сверка
      </h3>
      <ul class="recons">
        <li class={`recon recon--${kkt.state === 'diff' ? 'bad' : kkt.state === 'ok' ? 'ok' : 'wait'}`}>
          <p class="recon__title">
            <Icon name={kkt.state === 'ok' ? 'check' : kkt.state === 'diff' ? 'alert' : 'clock'} />
            Чеки ККТ
          </p>
          <dl class="recon__pair">
            <div>
              <dt>Продажи на кассе</dt>
              <dd class="mono">{formatMoney(k.system_kopecks ?? 0)}</dd>
            </div>
            <div>
              <dt>Пробито чеков</dt>
              <dd class="mono">{formatMoney(k.kkt_kopecks ?? 0)}</dd>
            </div>
          </dl>
          <p class="recon__word">
            {word(kkt, [pending ? `${pending} ${plural(pending, RECEIPTS)} ещё в очереди кассы` : '', failed ? `не пробились ${failed}` : ''].filter(Boolean).join(', ')) ?? 'Не проверено.'}
          </p>
          {k.settlements?.count ? (
            <p class="small recon__extra">
              Отдельно — чеки зачёта предоплаты (брони, пакеты, депозиты): {k.settlements.count} {plural(k.settlements.count, RECEIPTS)} на{' '}
              <span class="mono">{formatMoney(k.settlements.settlement_kopecks ?? k.settlements.amount_kopecks ?? 0)}</span>
              {k.settlements.by_state?.pending?.count || k.settlements.by_state?.failed?.count
                ? `, не пробито ${(k.settlements.by_state?.pending?.count ?? 0) + (k.settlements.by_state?.unknown?.count ?? 0) + (k.settlements.by_state?.failed?.count ?? 0)}`
                : ''}
              .
            </p>
          ) : null}
        </li>
        <li class={`recon recon--${online.state === 'diff' ? 'bad' : online.state === 'ok' ? 'ok' : 'wait'}`}>
          <p class="recon__title">
            <Icon name={online.state === 'ok' ? 'check' : online.state === 'diff' ? 'alert' : 'clock'} />
            Онлайн-оплаты
          </p>
          <dl class="recon__pair">
            <div>
              <dt>Платежи в системе</dt>
              <dd class="mono">{formatMoney((o.system_kopecks ?? 0) - (o.system_refunds_kopecks ?? 0))}</dd>
            </div>
            <div>
              <dt>ЮKassa</dt>
              <dd class="mono">{Number.isSafeInteger(o.yookassa_kopecks) ? formatMoney(o.yookassa_kopecks - (o.yookassa_refunds_kopecks ?? 0)) : '—'}</dd>
            </div>
          </dl>
          <p class="recon__word">{word(online, o.mismatches?.length ? `${o.mismatches.length} ${plural(o.mismatches.length, ['платёж', 'платежа', 'платежей'])} не совпали, проверьте журнал` : '') ?? UNCHECKED[o.status] ?? 'Не проверено.'}</p>
        </li>
      </ul>
    </section>
  );
}

function Play({ play }) {
  if (!play) return null;
  // Сначала самые загруженные: владелец ищет простаивающие и перегруженные столы
  const tables = [...(play.by_resource ?? [])].sort((a, b) => (b.utilization_percent ?? 0) - (a.utilization_percent ?? 0) || (a.number ?? 0) - (b.number ?? 0));
  return (
    <section class="rcard" aria-labelledby="r-play">
      <h3 class="rcard__title" id="r-play">
        <Icon name="hall" />
        Игра
      </h3>
      <dl class="kpis">
        <div>
          <dt>Часы игры</dt>
          <dd class="display">{hoursShort(play.minutes ?? 0)}</dd>
        </div>
        <div>
          <dt>{plural(play.sessions ?? 0, ['Игра', 'Игры', 'Игр'])}</dt>
          <dd class="display">{play.sessions ?? 0}</dd>
        </div>
        <div>
          <dt>Загрузка</dt>
          <dd class="display">{pct(play.utilization_percent)}</dd>
        </div>
      </dl>
      <p class="meter meter--wide" aria-hidden="true">
        <span class="meter__fill" style={{ width: `${Math.min(100, Number(play.utilization_percent) || 0)}%` }} />
      </p>
      {play.shift_minutes ? (
        <p class="small">
          Загрузка — доля времени смены ({hoursShort(play.shift_minutes)}), когда на {play.resources ?? 'всех'} {plural(play.resources ?? 0, ['столе', 'столах', 'столах'])} шла игра: {play.sessions ?? 0} {plural(play.sessions ?? 0, GAMES)}.
        </p>
      ) : null}
      {tables.length ? (
        <ul class="ptables" aria-label="Загрузка по столам">
          {tables.map((t) => (
            <li class="ptable" key={t.resource_id ?? t.number}>
              <span class="ptable__name">Стол {t.number ?? t.resource_number}</span>
              <span class="ptable__meta">
                {t.sessions ? `${hoursShort(t.minutes ?? 0)} · ${t.sessions} ${plural(t.sessions, GAMES)}` : 'Не играли'}
                {t.revenue_kopecks ? ` · ${formatMoney(t.revenue_kopecks)}` : ''}
              </span>
              <span class="meter ptable__meter" aria-hidden="true">
                <span class="meter__fill" style={{ width: `${Math.min(100, Number(t.utilization_percent) || 0)}%` }} />
              </span>
              <span class="ptable__pct mono">{pct(t.utilization_percent)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Service({ light }) {
  if (!light) return null;
  const over = light.exceeded ?? (light.threshold_minutes && light.total_minutes > light.threshold_minutes);
  const tables = light.by_resource ?? light.by_table ?? [];
  return (
    <section class="rcard" aria-labelledby="r-svc">
      <h3 class="rcard__title" id="r-svc">
        <Icon name="wrench" />
        Сервисный свет
      </h3>
      <p class={`verdict verdict--${over ? 'bad' : 'ok'}`}>
        <Icon name={over ? 'alert' : 'check'} />
        <span>
          <b class="mono">{minutesWords(light.total_minutes ?? 0)}</b> за смену
          {light.threshold_minutes ? (over ? `, больше порога клуба (${minutesWords(light.threshold_minutes)})` : `, порог клуба — ${minutesWords(light.threshold_minutes)}`) : ''}
        </span>
      </p>
      {light.by_staff?.length || tables.length ? (
        <div class="svc">
          {light.by_staff?.length ? (
            <dl class="receipt" aria-label="По сотрудникам">
              {light.by_staff.map((x, i) => (
                <div class="receipt__row" key={x.user_id ?? x.name ?? i}>
                  <dt>{x.name ?? 'Сотрудник'}</dt>
                  <dd class="receipt__sum">{x.minutes} мин</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {tables.length ? (
            <dl class="receipt" aria-label="По столам">
              {tables.map((x, i) => (
                <div class="receipt__row" key={x.resource_id ?? x.number ?? i}>
                  <dt>Стол {x.number ?? x.resource_number}</dt>
                  <dd class="receipt__sum">{x.minutes} мин</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      ) : (
        <p class="hint">Сервисный свет за смену не включали.</p>
      )}
    </section>
  );
}

function Manual({ manual, timeZone }) {
  const items = Array.isArray(manual) ? manual : Array.isArray(manual?.items) ? manual.items : [];
  const count = Number.isInteger(manual?.count) ? manual.count : items.length;
  return (
    <section class="rcard rcard--wide" aria-labelledby="r-man">
      <h3 class="rcard__title" id="r-man">
        <Icon name="journal" />
        Ручные действия
        {count ? <span class="count">{count}</span> : null}
      </h3>
      {items.length ? (
        <ul class="log">
          {items.map((a, i) => (
            <LogItem a={a} timeZone={timeZone} key={`${a.at}-${i}`} />
          ))}
        </ul>
      ) : (
        <p class="hint">Ручных действий за смену не было: ни сервисного света, ни скидок выше лимита, ни возвратов.</p>
      )}
      {count > items.length ? <p class="small">Показаны первые {items.length}. Остальные — в журнале.</p> : null}
      {/* №125: действия системы и гостей — свёрнутыми строками, в ручные не входят */}
      <Folded title="Действия гостей" group={manual?.guests} timeZone={timeZone} />
      <Folded title="Автоматические действия системы" group={manual?.automatic} timeZone={timeZone} />
    </section>
  );
}

function Folded({ title, group, timeZone }) {
  const list = Array.isArray(group?.items) ? group.items : [];
  const n = Number.isInteger(group?.count) ? group.count : list.length;
  if (!n) return null;
  return (
    <details class="auto">
      <summary class="auto__summary">
        {title}: <b>{n}</b>
        {group?.by_action ? <span class="auto__by"> — {Object.entries(group.by_action).map(([k, c]) => `${(ACTION_LABEL[k] ?? k).toLowerCase()} ${c}`).join(', ')}</span> : null}
      </summary>
      {list.length ? (
        <ul class="log">
          {list.map((a, i) => (
            <LogItem a={a} timeZone={timeZone} key={`${a.at}-${i}`} />
          ))}
        </ul>
      ) : null}
    </details>
  );
}

const WHO = { automatic: 'Система', guest: 'Гость' };

function LogItem({ a, timeZone }) {
  const other = a.kind === 'automatic' || a.kind === 'guest';
  // Денежные записи той же операции сервер склеил с этой строкой (linked) — подпись мелко
  const linked = Array.isArray(a.linked) ? [...new Set(a.linked)].map((x) => (ACTION_LABEL[x] ?? x).toLowerCase()) : [];
  return (
    <li class={`log__item${other ? '' : ' log__item--manual'}`}>
      <span class="log__time mono">{formatTime(a.at, timeZone)}</span>
      <div class="log__body">
        <p class="log__title">
          {a.resource_number ? <span class="log__table">Стол {a.resource_number} · </span> : null}
          {ACTION_LABEL[a.action] ?? a.action}
          {Number.isFinite(a.minutes) ? `, ${minutesWords(a.minutes)}` : ''}
          {Number.isSafeInteger(a.amount_kopecks) ? `, ${formatMoney(a.amount_kopecks)}` : ''}
        </p>
        {a.reason ? <p class="log__reason">«{a.reason}»</p> : null}
        <p class="log__meta">
          {WHO[a.kind] ?? a.actor_name ?? 'Сотрудник'}
          {linked.length ? ` · вместе с: ${linked.join(', ')}` : ''}
        </p>
      </div>
    </li>
  );
}
