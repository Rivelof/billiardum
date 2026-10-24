import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { formatMoney } from '@billiardum/shared/format';
import { Shell } from '../../components/Shell.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Ill } from '../../components/Ill.jsx';
import { Dialog } from '../../components/Dialog.jsx';
import { ErrorNote } from '../../components/ErrorNote.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { api } from '../../lib/api.js';
import { can } from '../../lib/auth.js';
import { session } from '../../lib/store.js';
import { SUB_RETURN_KEY, putSubscription } from '../../lib/billingBanner.js';
import {
  outcomeText,
  cardAction,
  cardBody,
  cardText,
  dateText,
  emailError,
  invoiceStatus,
  openInvoiceView,
  periodText,
  receiptView,
  safeConfirmationUrl,
  subStateOf,
  summaryOf,
  tablesWord,
} from '../../lib/billing.js';
import '../../styles/billing.css';

const POLL_MS = 4000;

/**
 * Экран «Подписка» (M5.3, №185): владельцу — план и цена за стол, столы, следующий счёт, пробный период,
 * «оплачено до», карта маской, привязка и смена карты на странице ЮKassa, отключение автоплатежа,
 * история счетов с чеками. Управляющему — только состояние. Ресепшн экран не видит (маршрут закрыт).
 * Без ключей магазина платформы (503 billing_unavailable) — «Подписка ещё не подключена», без ошибки.
 */
export function Subscription({ ctx }) {
  const { club, role, user, timeZone } = ctx;
  const clubId = club.club_id;
  const owner = can.subscriptionManage(role);
  const [sub, setSub] = useState(null);
  const [invoices, setInvoices] = useState(null);
  const [off, setOff] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [cardOpen, setCardOpen] = useState(false);
  const [autopayOpen, setAutopayOpen] = useState(false);
  // Владелец вернулся со страницы ЮKassa — сообщим итог, когда сервер его узнает: { club_id, mask, invoice_id } до ухода
  const returned = useRef(null);
  if (returned.current === null) {
    const r = session.get(SUB_RETURN_KEY);
    returned.current = r && r.club_id === clubId ? r : false;
  }
  const prev = useRef(null);

  const load = useCallback(async () => {
    try {
      const s = await api.subscription(clubId);
      putSubscription(clubId, s);
      const was = prev.current;
      prev.current = s;
      setSub(s);
      setOff(false);
      setError(null);
      // Итог оплаты или привязки: card_pending погас
      const ret = returned.current;
      if (owner && !s.card_pending && (was?.card_pending || ret)) {
        if (ret) {
          session.set(SUB_RETURN_KEY, null);
          returned.current = false;
        }
        const before = ret || { mask: was?.card?.mask ?? null, invoice_id: was?.open_invoice?.id ?? null };
        const msg = outcomeText(before, s);
        if (msg) setNotice(msg);
      }
      if (owner) {
        const inv = await api.subscriptionInvoices(clubId);
        setInvoices(Array.isArray(inv?.items) ? inv.items : []);
      }
    } catch (err) {
      if (err?.code === 'billing_unavailable') {
        setOff(true);
        setError(null);
      } else setError(err);
    }
  }, [clubId, owner]);

  useEffect(() => {
    load();
  }, [load]);

  // Проверяем оплату: пока ЮKassa не ответила (card_pending), опрашиваем сервер
  const pending = Boolean(sub?.card_pending);
  useEffect(() => {
    if (!pending) return undefined;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [pending, load]);

  const st = sub ? subStateOf(sub) : null;
  const sum = sub ? summaryOf(sub, { timeZone }) : null;
  const inv = owner && sub ? openInvoiceView(sub, { timeZone }) : null;
  const action = cardAction(sub);
  const testMode = sub?.mode === 'test';

  return (
    <Shell club={club} role={role} user={user} timeZone={timeZone} active="subscription" title="Подписка">
      <div class="page subpage">
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
        {!sub && !off && !error ? (
          <p class="muted loading" role="status">
            Загружаем подписку…
          </p>
        ) : null}

        {off ? <Unavailable /> : null}

        {sub && !off ? (
          <section class="panel subhead" aria-labelledby="sub-title">
            <div class="subhead__top">
              <h2 class="section-title" id="sub-title">
                Подписка на Бильярдум
              </h2>
              <span class={`badge badge--${st.tone}`}>
                <span class="badge__dot" aria-hidden="true" />
                {st.word}
              </span>
            </div>
            <p class="subhead__title">{sum.title}</p>
            {sum.detail ? <p class="subhead__detail">{sum.detail}</p> : null}
            {owner ? <Facts sub={sub} timeZone={timeZone} /> : <ManagerFacts sub={sub} timeZone={timeZone} />}
            {!owner ? <p class="hint">План, счета и карту для оплаты видит владелец клуба.</p> : null}
          </section>
        ) : null}

        {owner && sub && !off && pending ? (
          <p class="note note--lamp" role="status">
            <Icon name="hourglass" />
            <span class="note__title">Проверяем оплату в ЮKassa…</span>
            <span class="note__body">Обычно это занимает до минуты. Экран обновится сам.</span>
          </p>
        ) : null}

        {inv ? (
          <div class={`note ${sub.state === 'unpaid' ? 'note--error' : 'note--lamp'}`} role="note">
            <Icon name="alert" />
            <p class="note__title">{inv.title}</p>
            <p class="note__body">
              {inv.reason ? `${inv.reason} ` : ''}
              {inv.next}
            </p>
            {!pending ? (
              <div class="note__actions">
                <button type="button" class="btn btn--primary" onClick={() => setCardOpen(true)}>
                  <Icon name="card" />
                  {action.label}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {owner && sub && !off && !testMode ? (
          <section class="panel subcard" aria-labelledby="sub-card-title">
            <h2 class="section-title" id="sub-card-title">
              Карта и автоплатёж
            </h2>
            {sub.card ? (
              <p class="subcard__card">
                <Icon name="card" />
                <span class="mono">{cardText(sub.card)}</span>
              </p>
            ) : (
              <p>Карта не привязана.</p>
            )}
            <p class="subcard__state">
              <span class={`badge badge--${sub.autopay ? 'free' : 'off'}`}>
                <span class="badge__dot" aria-hidden="true" />
                {sub.autopay ? 'Автоплатёж включён' : 'Автоплатёж выключен'}
              </span>
            </p>
            <p class="hint">
              {sub.autopay
                ? 'Счёт выставляется раз в месяц вперёд и оплачивается с этой карты сам, без вашего участия.'
                : 'Привяжите карту — счета будут оплачиваться сами в день счёта. Карту вводите на странице ЮKassa, программа её номер не видит.'}
            </p>
            {sub.receipt_email ? (
              <p class="small muted">
                Чеки по 54-ФЗ приходят на <span class="subcard__email">{sub.receipt_email}</span>.
              </p>
            ) : null}
            <div class="row">
              {!sub.open_invoice ? (
                <button type="button" class="btn btn--primary" disabled={pending} onClick={() => setCardOpen(true)}>
                  <Icon name="card" />
                  {action.label}
                </button>
              ) : null}
              {sub.card ? (
                <button type="button" class="btn btn--quiet" disabled={pending} onClick={() => setAutopayOpen(true)}>
                  Отключить автоплатёж
                </button>
              ) : null}
            </div>
          </section>
        ) : null}

        {owner && sub && !off ? <History invoices={invoices} sub={sub} timeZone={timeZone} /> : null}
      </div>
      <CardDialog
        open={cardOpen}
        sub={sub}
        action={action}
        clubId={clubId}
        onClose={() => setCardOpen(false)}
      />
      <AutopayDialog
        open={autopayOpen}
        sub={sub}
        timeZone={timeZone}
        clubId={clubId}
        onClose={() => setAutopayOpen(false)}
        onDone={() => {
          setAutopayOpen(false);
          setNotice('Автоплатёж отключён, карта отвязана. Следующий счёт оплатите вручную или привяжите карту снова.');
          load();
        }}
      />
    </Shell>
  );
}

function Unavailable() {
  return (
    <section class="panel subempty" aria-labelledby="sub-off-title">
      <Ill name="pocket" />
      <h2 class="section-title" id="sub-off-title">
        Подписка ещё не подключена
      </h2>
      <p>Оплата программы Бильярдума пока не включена — делать ничего не нужно, программа клуба работает полностью.</p>
      <p class="hint">Когда подписку подключат, здесь появятся план, цена за стол, счета и карта для автоплатежа.</p>
    </section>
  );
}

function Facts({ sub, timeZone }) {
  const testMode = sub.mode === 'test';
  const next = sub.next_invoice;
  return (
    <dl class="facts subfacts">
      <div>
        <dt>План</dt>
        <dd>
          «{sub.plan?.title ?? 'Клуб'}» · <span class="num">{formatMoney(sub.price_per_table_kopecks ?? 0)}</span> за стол в месяц
          {sub.personal_price ? <span class="subfacts__mark"> · персональная цена</span> : null}
        </dd>
      </div>
      <div>
        <dt>Столов в работе</dt>
        <dd class="num">{sub.tables ?? 0}</dd>
      </div>
      <div>
        <dt>{next?.invoice_id ? 'Открытый счёт' : 'Следующий счёт'}</dt>
        <dd>
          {next ? (
            <>
              {dateText(next.date, timeZone)} · <b class="num">{formatMoney(next.amount_kopecks)}</b>
              {!next.invoice_id ? (
                <span class="subfacts__calc">
                  {' '}
                  ({tablesWord(sub.tables ?? 0)} × {formatMoney(sub.price_per_table_kopecks ?? 0)})
                </span>
              ) : null}
            </>
          ) : testMode ? (
            'после перехода в боевой режим и пробного периода'
          ) : (
            '—'
          )}
        </dd>
      </div>
      <div>
        <dt>Пробный период</dt>
        <dd>{testMode ? `${sub.trial_days ?? 60} дней после запуска` : sub.trial_until ? (sub.state === 'trial' ? `до ${dateText(sub.trial_until, timeZone)}` : `закончился ${dateText(sub.trial_until, timeZone)}`) : '—'}</dd>
      </div>
      <div>
        <dt>Оплачено до</dt>
        <dd>{sub.paid_until ? dateText(sub.paid_until, timeZone) : '—'}</dd>
      </div>
    </dl>
  );
}

function ManagerFacts({ sub, timeZone }) {
  if (sub.mode === 'test') return null;
  return (
    <dl class="facts subfacts">
      {sub.trial_until ? (
        <div>
          <dt>Пробный период</dt>
          <dd>{sub.state === 'trial' ? `до ${dateText(sub.trial_until, timeZone)}` : `закончился ${dateText(sub.trial_until, timeZone)}`}</dd>
        </div>
      ) : null}
      <div>
        <dt>Оплачено до</dt>
        <dd>{sub.paid_until ? dateText(sub.paid_until, timeZone) : '—'}</dd>
      </div>
    </dl>
  );
}

function History({ invoices, sub, timeZone }) {
  const columns = [
    { key: 'period', label: 'Период', head: true, render: (r) => periodText(r.period_start, r.period_end, timeZone) },
    { key: 'tables', label: 'Столов', num: true, render: (r) => r.tables },
    { key: 'amount', label: 'Сумма', num: true, render: (r) => formatMoney(r.amount_kopecks) },
    {
      key: 'status',
      label: 'Статус',
      render: (r) => {
        const s = invoiceStatus(r);
        return (
          <span class="subinv__status">
            <span class={`badge badge--${s.tone}`}>
              <span class="badge__dot" aria-hidden="true" />
              {s.word}
            </span>
            {s.detail ? <span class="small muted">{s.detail}</span> : null}
          </span>
        );
      },
    },
    {
      key: 'receipt',
      label: 'Чек',
      render: (r) => {
        const v = receiptView(r);
        if (!v) return <span class="muted">—</span>;
        return v.url ? (
          <a href={v.url} target="_blank" rel="noopener noreferrer">
            {v.text}
            <Icon name="external" />
          </a>
        ) : (
          <span class="small">{v.text}</span>
        );
      },
    },
  ];
  const firstDate = sub.next_invoice?.date ?? null;
  return (
    <section class="panel subhist" aria-labelledby="sub-hist-title">
      <h2 class="section-title" id="sub-hist-title">
        Счета
      </h2>
      {invoices === null ? (
        <p class="muted loading" role="status">
          Загружаем счета…
        </p>
      ) : (
        <DataTable
          columns={columns}
          rows={invoices}
          rowKey={(r) => r.id}
          caption="Счета за подписку, новые сверху"
          limit={12}
          empty={firstDate ? `Счетов пока нет. Первый счёт — ${dateText(firstDate, timeZone)}: столы в работе × цена за стол.` : 'Счетов пока нет. Первый счёт выставится в день окончания пробного периода.'}
        />
      )}
    </section>
  );
}

function CardDialog({ open, sub, action, clubId, onClose }) {
  const saved = sub?.receipt_email ?? '';
  const [email, setEmail] = useState(saved);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!open) return;
    setEmail(saved);
    setTried(false);
    setError(null);
  }, [open, saved]);
  if (!open || !sub) return <Dialog open={false} onClose={onClose} title="" />;
  const emailErr = emailError(email, { required: !saved });
  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (emailErr) return;
    setBusy(true);
    setError(null);
    try {
      const value = email.trim();
      // Email уходит, только если его ввели впервые или изменили — иначе сервер возьмёт сохранённый
      const res = await api.subscriptionCard(clubId, cardBody(value !== saved ? value : ''));
      const url = safeConfirmationUrl(res?.confirmation_url, location.origin);
      if (!url) throw Object.assign(new Error('confirmation_url'), { code: 'yookassa_unavailable' });
      session.set(SUB_RETURN_KEY, { club_id: clubId, mask: sub.card?.mask ?? null, invoice_id: sub.open_invoice?.id ?? null });
      location.assign(url);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  const invoice = action.purpose === 'invoice';
  return (
    <Dialog open onClose={onClose} title={action.title} labelledBy="sub-card-dlg">
      <form class="form" onSubmit={submit} noValidate>
        {invoice ? (
          <p>
            Откроется страница ЮKassa: оплатите счёт на <b class="num">{formatMoney(sub.open_invoice.amount_kopecks)}</b>. Карта сохранится, и следующие счета будут оплачиваться сами.
          </p>
        ) : (
          <p>Откроется страница ЮKassa. Чтобы проверить карту, банк заморозит 1 ₽ и сразу вернёт его — денег вы не платите. Дальше счета подписки будут оплачиваться с этой карты сами.</p>
        )}
        <div class="field">
          <label class="field__label" for="sub-email">
            Email для чеков
          </label>
          <input
            id="sub-email"
            class="field__input"
            type="email"
            inputMode="email"
            autoComplete="email"
            maxLength={254}
            value={email}
            aria-invalid={tried && emailErr ? 'true' : undefined}
            aria-describedby="sub-email-hint"
            onInput={(ev) => setEmail(ev.currentTarget.value)}
          />
          <p class={tried && emailErr ? 'field__error' : 'field__hint'} id="sub-email-hint">
            {tried && emailErr ? emailErr : 'ЮKassa пришлёт сюда чек по 54-ФЗ на каждую оплату подписки.'}
          </p>
        </div>
        <ErrorNote error={error} />
        <div class="dialog__actions">
          <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
            {busy ? 'Открываем ЮKassa…' : 'Перейти на страницу ЮKassa'}
            {!busy ? <Icon name="external" /> : null}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function AutopayDialog({ open, sub, timeZone, clubId, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!open) return;
    setReason('');
    setError(null);
  }, [open]);
  if (!open || !sub) return <Dialog open={false} onClose={onClose} title="" />;
  const next = sub.next_invoice?.date ? dateText(sub.next_invoice.date, timeZone) : null;
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.disableAutopay(clubId, reason.trim() || undefined);
      putSubscription(clubId, { ...sub, autopay: res?.autopay ?? false, card: res?.card ?? null });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title="Отключить автоплатёж?" labelledBy="sub-off-dlg">
      <form class="form" onSubmit={submit} noValidate>
        <p>
          Карта <span class="mono">{cardText(sub.card)}</span> будет отвязана, и счета перестанут оплачиваться сами.
          {next ? ` Следующий счёт — ${next} — нужно будет оплатить вручную.` : ''} Привязать карту снова можно в любой момент.
        </p>
        <p class="hint">Программа клуба продолжит работать как обычно.</p>
        <div class="field">
          <label class="field__label" for="sub-off-reason">
            Почему отключаете (необязательно)
          </label>
          <input id="sub-off-reason" class="field__input" maxLength={500} value={reason} onInput={(ev) => setReason(ev.currentTarget.value)} />
        </div>
        <ErrorNote error={error} />
        <div class="dialog__actions subdlg__actions">
          <button type="submit" class="btn btn--danger btn--lg" disabled={busy}>
            {busy ? 'Отключаем…' : 'Отключить автоплатёж'}
          </button>
          <button type="button" class="btn btn--quiet btn--lg" onClick={onClose}>
            Оставить как есть
          </button>
        </div>
      </form>
    </Dialog>
  );
}
