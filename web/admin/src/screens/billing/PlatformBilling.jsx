import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { formatMoney, plural } from '@billiardum/shared/format';
import { Icon } from '../../components/Icon.jsx';
import { Ill } from '../../components/Ill.jsx';
import { Dialog } from '../../components/Dialog.jsx';
import { ErrorNote } from '../../components/ErrorNote.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { api } from '../../lib/api.js';
import {
  clubDate,
  filterClubs,
  isDebtor,
  markPaidBody,
  markPaidErrors,
  paidUntilText,
  paymentsWord,
  periodText,
  PLAN_PRICE_WARNING,
  planImpact,
  planImpactText,
  planPriceBody,
  planPriceErrors,
  priceBody,
  priceErrors,
  pricePreview,
  stateCounts,
  subState,
  failureText,
} from '../../lib/billing.js';
import '../../styles/billing.css';

const TZ = 'Europe/Moscow';
const MODE_WORD = { test: 'тестовый режим', suspended: 'приостановлен' };

/**
 * «Клубы и подписки» (M5.3, №186) в разделе платформы: сверху MRR и оплаты за месяц, таблица клубов
 * (состояние, цена за стол, столы, оплачено до, долг), фильтр «Должники». Администратор платформы —
 * «Отметить оплату» по выставленному счёту (причина и номер платёжки), «Персональная цена» с причиной
 * и «Изменить цену плана» (PUT /api/platform/plans/{id}, с причиной). Оператор платформы — только чтение. Без ключей магазина платформы — «Подписка ещё не подключена».
 */
export function PlatformBilling({ role }) {
  const admin = role === 'platform_admin';
  const [data, setData] = useState(null);
  const [off, setOff] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [notice, setNotice] = useState(null);
  const [paying, setPaying] = useState(null);
  const [pricing, setPricing] = useState(null);
  const [planEdit, setPlanEdit] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await api.platformSubscriptions();
      setData({ items: res?.items ?? [], plans: res?.plans ?? [], totals: res?.totals ?? null });
      setOff(false);
      setError(null);
    } catch (err) {
      if (err?.code === 'billing_unavailable') setOff(true);
      else setError(err);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const items = data?.items ?? [];
  const debtors = useMemo(() => items.filter(isDebtor).length, [items]);
  const rows = useMemo(() => filterClubs(items, filter), [items, filter]);
  const planOf = (item) => data?.plans?.find((p) => p.id === item?.plan?.id) ?? data?.plans?.[0] ?? null;

  if (off) {
    return (
      <section class="panel subempty" aria-labelledby="pb-off">
        <Ill name="pocket" />
        <h2 class="section-title" id="pb-off">
          Подписка ещё не подключена
        </h2>
        <p>На сервере не заданы ключи магазина ЮKassa платформы — клубы пока пользуются программой бесплатно, счета не выставляются.</p>
        <p class="hint">
          Ключи <span class="mono">PLATFORM_YOOKASSA_SHOP_ID</span> и <span class="mono">PLATFORM_YOOKASSA_SECRET</span> задаются в .env сервера.
        </p>
      </section>
    );
  }

  const columns = [
    {
      key: 'name',
      label: 'Клуб',
      head: true,
      sortValue: (r) => r.name ?? '',
      render: (r) => (
        <span class="pbill__club">
          <span class="pbill__name">{r.name}</span>
          <span class="small muted">
            {r.city ?? ''}
            {MODE_WORD[r.mode] ? ` · ${MODE_WORD[r.mode]}` : ''}
          </span>
        </span>
      ),
    },
    {
      key: 'state',
      label: 'Состояние',
      sortValue: (r) => ['unpaid', 'past_due', 'trial', 'active', 'canceled'].indexOf(r.state),
      render: (r) => {
        const s = subState(r.state);
        return (
          <span class={`badge badge--${s.tone}`}>
            <span class="badge__dot" aria-hidden="true" />
            {s.word}
          </span>
        );
      },
    },
    {
      key: 'price',
      label: 'Цена за стол',
      num: true,
      sortValue: (r) => r.price_per_table_kopecks ?? 0,
      render: (r) => (
        <span class="pbill__price">
          {formatMoney(r.price_per_table_kopecks ?? 0)}
          {r.personal_price ? <span class="small pbill__personal">персональная{r.personal_price_reason ? `: ${r.personal_price_reason}` : ''}</span> : null}
        </span>
      ),
    },
    { key: 'tables', label: 'Столов', num: true, sortValue: (r) => r.tables ?? 0, render: (r) => r.tables ?? 0 },
    { key: 'paid', label: 'Оплачено до', sortValue: (r) => r.paid_until ?? r.trial_until ?? '', render: (r) => paidUntilText(r) },
    {
      key: 'debt',
      label: 'Долг',
      num: true,
      sortValue: (r) => r.debt_kopecks ?? 0,
      render: (r) =>
        r.debt_kopecks > 0 ? (
          <span class="pbill__debt">
            <b>{formatMoney(r.debt_kopecks)}</b>
            {r.open_invoice ? (
              <span class="small muted">
                с {clubDate(r.open_invoice.period_start, r.timezone)}
                {r.open_invoice.last_error ? ` · ${failureText(r.open_invoice.last_error)}` : ''}
                {!r.card && r.open_invoice.last_error !== 'card_required' ? ' · карты нет' : ''}
              </span>
            ) : null}
          </span>
        ) : (
          <span class="muted">нет</span>
        ),
    },
  ];
  if (admin) {
    columns.push({
      key: 'actions',
      label: 'Действия',
      render: (r) => (
        <span class="pbill__actions">
          {r.open_invoice ? (
            <button type="button" class="btn btn--secondary btn--sm" aria-label={`Отметить оплату: ${r.name}`} onClick={() => setPaying(r)}>
              Отметить оплату
            </button>
          ) : null}
          <button type="button" class="btn btn--quiet btn--sm" aria-label={`Персональная цена: ${r.name}`} onClick={() => setPricing(r)}>
            Персональная цена
          </button>
        </span>
      ),
    });
  }

  const t = data?.totals;
  return (
    <section class="pbill" aria-labelledby="pb-title">
      <h2 class="visually-hidden" id="pb-title">
        Клубы и подписки
      </h2>
      <ErrorNote error={error}>
        <button type="button" class="btn btn--secondary btn--sm" onClick={load}>
          <Icon name="refresh" />
          Обновить
        </button>
      </ErrorNote>
      {notice ? (
        <p class="note note--free" role="status">
          <Icon name="check" />
          <span class="note__title">{notice}</span>
        </p>
      ) : null}
      {!data && !error ? (
        <p class="muted loading" role="status">
          Загружаем подписки…
        </p>
      ) : null}
      {t ? (
        <dl class="pbill__kpis">
          <div>
            <dt>MRR</dt>
            <dd class="display num">{formatMoney(t.mrr_kopecks ?? 0)}</dd>
            <dd class="small muted">в месяц с боевых клубов вне пробного периода</dd>
          </div>
          <div>
            <dt>Оплаты за месяц</dt>
            <dd class="display num">{formatMoney(t.paid_this_month_kopecks ?? 0)}</dd>
            <dd class="small muted">{paymentsWord(t.payments_this_month ?? 0)} с начала месяца</dd>
          </div>
          <div>
            <dt>Долг</dt>
            <dd class={`display num${t.debt_kopecks > 0 ? ' pbill__kpi-debt' : ''}`}>{formatMoney(t.debt_kopecks ?? 0)}</dd>
            <dd class="small muted">{debtors ? `у ${debtors} ${plural(debtors, ['клуба', 'клубов', 'клубов'])}` : 'должников нет'}</dd>
          </div>
          <div>
            <dt>Клубы</dt>
            <dd class="pbill__counts">
              {stateCounts(t.clubs).length
                ? stateCounts(t.clubs).map(([k, word, n]) => (
                    <span key={k} class="pbill__count">
                      {word} <b class="num">{n}</b>
                    </span>
                  ))
                : 'пока нет'}
            </dd>
          </div>
        </dl>
      ) : null}
      {data && !admin ? <p class="hint">Только чтение: отметить оплату и изменить цену может администратор платформы.</p> : null}
      {data?.plans?.length ? (
        <ul class="pbill__plans" aria-label="Планы подписки">
          {data.plans
            .filter((p) => p.active !== false)
            .map((p) => (
              <li key={p.id} class="pbill__plan">
                <span class="small">
                  План «{p.title}» — <b class="num">{formatMoney(p.price_per_table_kopecks)}</b> за стол в месяц, пробный период {p.trial_days} {plural(p.trial_days, ['день', 'дня', 'дней'])}
                </span>
                {admin ? (
                  <button type="button" class="btn btn--quiet btn--sm" onClick={() => setPlanEdit(p)}>
                    Изменить цену плана
                    <span class="visually-hidden"> «{p.title}»</span>
                  </button>
                ) : null}
              </li>
            ))}
        </ul>
      ) : null}
      {data ? (
        <div class="viewtog" role="group" aria-label="Какие клубы показать">
          <button type="button" class="viewtog__btn" aria-pressed={filter === 'all' ? 'true' : 'false'} onClick={() => setFilter('all')}>
            Все клубы <span class="num">{items.length}</span>
          </button>
          <button type="button" class="viewtog__btn" aria-pressed={filter === 'debtors' ? 'true' : 'false'} onClick={() => setFilter('debtors')}>
            Должники <span class="num">{debtors}</span>
          </button>
        </div>
      ) : null}
      {data ? (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.club_id}
          caption={filter === 'debtors' ? 'Должники по подписке' : 'Клубы и подписки'}
          rowClass={(r) => (isDebtor(r) ? 'is-problem' : '')}
          empty={filter === 'debtors' ? 'Должников нет: все клубы оплачены или в пробном периоде.' : 'Клубов в боевом режиме пока нет. Они появятся здесь после перехода в боевой режим.'}
        />
      ) : null}
      <MarkPaidDialog
        item={paying}
        onClose={() => setPaying(null)}
        onDone={(res) => {
          setNotice(`Оплата отмечена: ${paying.name}${res?.paid_until ? `, оплачено до ${clubDate(res.paid_until, paying.timezone)}` : ''}. Владельцу ушло уведомление.`);
          setPaying(null);
          load();
        }}
        onStale={() => load()}
      />
      <PriceDialog
        item={pricing}
        plan={planOf(pricing)}
        onClose={() => setPricing(null)}
        onDone={(res) => {
          setNotice(`${pricing.name}: ${res?.personal_price ? `персональная цена ${formatMoney(res.price_per_table_kopecks)} за стол` : 'снова цена плана'} — со следующего счёта. Владельцу ушло уведомление.`);
          setPricing(null);
          load();
        }}
      />
      {admin ? (
        <PlanPriceDialog
          plan={planEdit}
          items={items}
          onClose={() => setPlanEdit(null)}
          onDone={(res) => {
            setNotice(`План «${res?.title ?? planEdit.title}»: ${formatMoney(res?.price_per_table_kopecks ?? 0)} за стол — со следующего счёта у клубов без персональной цены.`);
            setPlanEdit(null);
            load();
          }}
        />
      ) : null}
    </section>
  );
}

/** Цена плана (только platform_admin): новая цена, причина в журнал платформы, предупреждение и кого коснётся. */
function PlanPriceDialog({ plan, items, onClose, onDone }) {
  const [form, setForm] = useState({ rubles: '', reason: '' });
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    setForm({ rubles: plan ? String((plan.price_per_table_kopecks ?? 0) / 100) : '', reason: '' });
    setTried(false);
    setError(null);
  }, [plan?.id]);
  if (!plan) return <Dialog open={false} onClose={onClose} title="" />;
  const errs = planPriceErrors(form, plan);
  const bad = (k) => (tried && errs[k] ? 'true' : undefined);
  const impact = planImpactText(planImpact(items, plan, form));
  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await api.updatePlan(plan.id, planPriceBody(form)));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title={`Цена плана «${plan.title}»`} labelledBy="pb-plan-title">
      <form class="form" onSubmit={submit} noValidate>
        <p>
          Сейчас: <b class="num">{formatMoney(plan.price_per_table_kopecks ?? 0)}</b> за стол в месяц.
        </p>
        <p class="note note--lamp" id="pb-plan-warn">
          <Icon name="info" />
          <span class="note__title">{PLAN_PRICE_WARNING}</span>
        </p>
        <div class="field">
          <label class="field__label" for="pb-plan-rub">
            Новая цена за стол в месяц, ₽
          </label>
          <input
            id="pb-plan-rub"
            class="field__input mono"
            inputMode="decimal"
            autoComplete="off"
            maxLength={12}
            value={form.rubles}
            aria-invalid={bad('rubles')}
            aria-describedby="pb-plan-rub-hint pb-plan-warn"
            onInput={(e) => setForm((f) => ({ ...f, rubles: e.currentTarget.value.replace(/[^\d,.\s]/g, '') }))}
          />
          <p class={bad('rubles') ? 'field__error' : 'field__hint'} id="pb-plan-rub-hint">
            {bad('rubles') ? errs.rubles : 'Уже выставленные счета не меняются. Клубы с персональной ценой платят по ней.'}
          </p>
        </div>
        <p class="small" role="status">
          {impact}
        </p>
        <div class="field">
          <label class="field__label" for="pb-plan-reason">
            Причина
          </label>
          <input
            id="pb-plan-reason"
            class="field__input"
            maxLength={2000}
            value={form.reason}
            placeholder="Например: индексация цен с 1 января"
            aria-invalid={bad('reason')}
            aria-describedby={bad('reason') ? 'pb-plan-reason-err' : undefined}
            onInput={(e) => setForm((f) => ({ ...f, reason: e.currentTarget.value }))}
          />
          {bad('reason') ? (
            <p class="field__error" id="pb-plan-reason-err">
              {errs.reason}
            </p>
          ) : null}
        </div>
        <ErrorNote error={error} />
        <div class="dialog__actions">
          <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
            {busy ? 'Сохраняем…' : 'Сохранить цену плана'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function MarkPaidDialog({ item, onClose, onDone, onStale }) {
  const [form, setForm] = useState({ document: '', reason: '' });
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    setForm({ document: '', reason: '' });
    setTried(false);
    setError(null);
  }, [item?.club_id]);
  if (!item?.open_invoice) return <Dialog open={false} onClose={onClose} title="" />;
  const inv = item.open_invoice;
  const errs = markPaidErrors(form);
  const bad = (k) => (tried && errs[k] ? 'true' : undefined);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.currentTarget.value }));
  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await api.markInvoicePaid(item.club_id, markPaidBody(inv.id, form)));
    } catch (err) {
      setError(err);
      if (err?.code === 'invoice_paid') onStale();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title="Отметить оплату по счёту" labelledBy="pb-pay-title">
      <form class="form" onSubmit={submit} noValidate>
        <p>
          {item.name}: счёт на <b class="num">{formatMoney(inv.amount_kopecks)}</b> за {periodText(inv.period_start, inv.period_end, item.timezone || TZ)}.
        </p>
        <p class="hint">Для юрлица, которое заплатило с расчётного счёта. Это ручное действие платформы: причина и номер платёжки попадут в журнал, владельцу уйдёт уведомление.</p>
        <div class="field">
          <label class="field__label" for="pb-doc">
            Номер платёжного поручения
          </label>
          <input id="pb-doc" class="field__input mono" maxLength={200} value={form.document} aria-invalid={bad('document')} aria-describedby={bad('document') ? 'pb-doc-err' : undefined} onInput={set('document')} />
          {bad('document') ? (
            <p class="field__error" id="pb-doc-err">
              {errs.document}
            </p>
          ) : null}
        </div>
        <div class="field">
          <label class="field__label" for="pb-reason">
            Причина
          </label>
          <input
            id="pb-reason"
            class="field__input"
            maxLength={2000}
            value={form.reason}
            placeholder="Например: оплата по счёту от юрлица"
            aria-invalid={bad('reason')}
            aria-describedby={bad('reason') ? 'pb-reason-err' : undefined}
            onInput={set('reason')}
          />
          {bad('reason') ? (
            <p class="field__error" id="pb-reason-err">
              {errs.reason}
            </p>
          ) : null}
        </div>
        <ErrorNote error={error} />
        <div class="dialog__actions">
          <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
            {busy ? 'Отмечаем…' : `Отметить счёт на ${formatMoney(inv.amount_kopecks)} оплаченным`}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function PriceDialog({ item, plan, onClose, onDone }) {
  const [form, setForm] = useState({ rubles: '', reset: false, reason: '' });
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    setForm({ rubles: item?.personal_price ? String((item.price_per_table_kopecks ?? 0) / 100) : '', reset: false, reason: '' });
    setTried(false);
    setError(null);
  }, [item?.club_id]);
  if (!item) return <Dialog open={false} onClose={onClose} title="" />;
  const errs = priceErrors(form);
  const bad = (k) => (tried && errs[k] ? 'true' : undefined);
  const preview = pricePreview(form, item, plan);
  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await api.setClubPrice(item.club_id, priceBody(form)));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title={`Цена для клуба: ${item.name}`} labelledBy="pb-price-title">
      <form class="form" onSubmit={submit} noValidate>
        <p>
          Сейчас: <b class="num">{formatMoney(item.price_per_table_kopecks ?? 0)}</b> за стол в месяц
          {item.personal_price ? ' (персональная)' : ' (цена плана)'}
          {plan ? `. Цена плана «${plan.title}» — ${formatMoney(plan.price_per_table_kopecks)}.` : '.'}
        </p>
        {item.personal_price ? (
          <fieldset class="pbill__kind">
            <legend class="field__label">Какую цену поставить</legend>
            <label class="check">
              <input type="radio" name="pb-kind" checked={!form.reset} onChange={() => setForm((f) => ({ ...f, reset: false }))} />
              <span>Персональную</span>
            </label>
            <label class="check">
              <input type="radio" name="pb-kind" checked={form.reset} onChange={() => setForm((f) => ({ ...f, reset: true }))} />
              <span>Вернуть цену плана</span>
            </label>
          </fieldset>
        ) : null}
        {!form.reset ? (
          <div class="field">
            <label class="field__label" for="pb-rub">
              Цена за стол в месяц, ₽
            </label>
            <input
              id="pb-rub"
              class="field__input mono"
              inputMode="decimal"
              autoComplete="off"
              maxLength={12}
              value={form.rubles}
              aria-invalid={bad('rubles')}
              aria-describedby="pb-rub-hint"
              onInput={(e) => setForm((f) => ({ ...f, rubles: e.currentTarget.value.replace(/[^\d,.\s]/g, '') }))}
            />
            <p class={bad('rubles') ? 'field__error' : 'field__hint'} id="pb-rub-hint">
              {bad('rubles') ? errs.rubles : '0 — бесплатно: счёт сразу будет оплачен.'}
            </p>
          </div>
        ) : null}
        {preview ? (
          <p class="small" role="status">
            {preview}
          </p>
        ) : null}
        <div class="field">
          <label class="field__label" for="pb-preason">
            Причина
          </label>
          <input
            id="pb-preason"
            class="field__input"
            maxLength={2000}
            value={form.reason}
            placeholder="Например: пилотный клуб, скидка на полгода"
            aria-invalid={bad('reason')}
            aria-describedby={bad('reason') ? 'pb-preason-err' : undefined}
            onInput={(e) => setForm((f) => ({ ...f, reason: e.currentTarget.value }))}
          />
          {bad('reason') ? (
            <p class="field__error" id="pb-preason-err">
              {errs.reason}
            </p>
          ) : null}
        </div>
        <ErrorNote error={error} />
        <div class="dialog__actions">
          <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
            {busy ? 'Сохраняем…' : form.reset ? 'Вернуть цену плана' : 'Сохранить персональную цену'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
