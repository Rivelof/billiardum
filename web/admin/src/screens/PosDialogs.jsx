import { useEffect, useRef, useState } from 'preact/hooks';
import { formatMoney } from '@billiardum/shared/format';
import { defaultModifiers, toggleModifier, unitPrice, validateModifiers } from '@billiardum/shared/bar';
import { DISCOUNT_REASONS } from '@billiardum/shared/reasons';
import { Dialog } from '../components/Dialog.jsx';
import { Icon } from '../components/Icon.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { Keypad, PIN_KEYS } from '../components/Keypad.jsx';
import { CashEntry, cashState } from '../components/CashEntry.jsx';
import { QrCode } from '../components/QrCode.jsx';
import { api, newIdempotencyKey } from '../lib/api.js';
import { approvalBody, approvalError, discountKopecks, discountPercent, normalizeSale, overLimit, receiptView, saleBody, saleTotals, wholeDiscount } from '../lib/pos.js';
import { keypad, parseRubles } from '../lib/cash.js';
import { normalizePhone } from '../lib/auth.js';
import { linkHandler } from '../lib/router.js';
import { BASE } from '../lib/env.js';

/** Выбор модификаторов товара (объём, сахар, молоко…) и количества перед добавлением в чек. */
export function ModifierDialog({ product, onClose, onAdd }) {
  const [sel, setSel] = useState([]);
  const [qty, setQty] = useState(1);
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (!product) return;
    setSel(defaultModifiers(product));
    setQty(1);
    setTried(false);
  }, [product?.id]);

  if (!product) return <Dialog open={false} onClose={onClose} title="" />;
  const check = validateModifiers(product, sel);
  const unit = unitPrice(product, sel);

  return (
    <Dialog open onClose={onClose} title={product.name} labelledBy="mod-title" wide>
      <form
        class="mods"
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (check.ok) onAdd(product, sel, qty);
        }}
        noValidate
      >
        {product.modifier_groups.map((g) => {
          const err = tried ? check.errors.find((x) => x.group_id === g.id) : null;
          const single = g.max === 1;
          // Обязательная группа на один вариант — радио; остальные — флажки (необязательный вариант можно снять)
          const type = single && g.min >= 1 ? 'radio' : 'checkbox';
          return (
            <fieldset class="mods__group" key={g.id} aria-describedby={err ? `mod-err-${g.id}` : undefined}>
              <legend class="mods__legend">
                {g.name}
                <span class="mods__rule">{g.min >= 1 ? (single ? 'выберите один' : `от ${g.min} до ${g.max}`) : single ? 'по желанию' : `по желанию, до ${g.max}`}</span>
              </legend>
              <div class="opts">
                {g.modifiers.map((m) => (
                  <label class="opt" key={m.id}>
                    <input type={type} name={`mod-${g.id}`} checked={sel.includes(m.id)} onChange={() => setSel((s) => toggleModifier(product, s, g.id, m.id))} />
                    <span class="opt__box">
                      <span class="opt__name">{m.name}</span>
                      {m.price_delta_kopecks ? <span class="opt__delta mono">+{formatMoney(m.price_delta_kopecks)}</span> : null}
                    </span>
                  </label>
                ))}
              </div>
              {err ? (
                <p class="field__error" id={`mod-err-${g.id}`}>
                  {err.text}
                </p>
              ) : null}
            </fieldset>
          );
        })}
        <div class="mods__qty">
          <span class="field__label" id="mod-qty">
            Количество
          </span>
          <div class="stepper stepper--lg" role="group" aria-labelledby="mod-qty">
            <button type="button" class="stepper__btn" aria-label="Меньше на одну" disabled={qty <= 1} onClick={() => setQty((q) => Math.max(1, q - 1))}>
              <Icon name="minus" />
            </button>
            <span class="stepper__value mono" aria-live="polite">
              {qty}
            </span>
            <button type="button" class="stepper__btn" aria-label="Больше на одну" disabled={qty >= 99} onClick={() => setQty((q) => Math.min(99, q + 1))}>
              <Icon name="plus" />
            </button>
          </div>
        </div>
        <button type="submit" class="btn btn--primary btn--block btn--lg">
          <Icon name="plus" />
          Добавить в чек — {formatMoney(unit * qty)}
        </button>
      </form>
    </Dialog>
  );
}

const QUICK_PERCENTS = [5, 10, 15, 20];


/**
 * Скидка на бар (товары и счёт стола). В пределах лимита клуба — сразу; выше — причина обязательна (инвариант 8),
 * ресепшену — подтверждение управляющего его PIN на этом экране, владельцу уходит тревога (№82).
 */
export function DiscountDialog({ open, clubId, base, limit, current, bigAllowed, onClose, onApply }) {
  const [type, setType] = useState('percent');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [text, setText] = useState('');
  const [approvers, setApprovers] = useState(null);
  const [approver, setApprover] = useState('');
  const [pin, setPin] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setType(current?.type ?? 'percent');
    setValue(current ? (current.type === 'percent' ? String(current.value) : String((current.kopecks ?? 0) / 100)) : '');
    setReason(current?.reason?.code ?? '');
    setText(current?.reason?.text ?? '');
    setPin('');
    setTried(false);
    setError(null);
  }, [open]);

  const d = type === 'percent' ? { type, value: Number(value) } : { type, kopecks: parseRubles(value) ?? 0 };
  const kop = discountKopecks(base, d);
  const whole = wholeDiscount(base, kop);
  const over = overLimit(base, kop, limit);
  const needApproval = over && !bigAllowed;

  useEffect(() => {
    if (!open || !needApproval || approvers) return;
    api
      .approvers(clubId)
      .then((list) => {
        const l = Array.isArray(list) ? list : [];
        setApprovers(l);
        if (l.length === 1) setApprover(l[0].user_id);
      })
      .catch(() => setApprovers([]));
  }, [open, needApproval]);

  const reasonOk = reason && text.trim().length >= 3;
  const apply = async (e) => {
    e.preventDefault();
    setTried(true);
    if (!kop || whole) return;
    const result = { ...d, kopecks: d.type === 'amount' ? kop : undefined, base_kopecks: base };
    if (!over) {
      onApply(result);
      return;
    }
    if (!reasonOk) return;
    const why = { code: reason, text: text.trim() };
    if (!needApproval) {
      onApply({ ...result, reason: why });
      return;
    }
    if (!approver || !/^\d{4,6}$/.test(pin)) return;
    setBusy(true);
    setError(null);
    try {
      // Та же скидка и та же корзина, что уйдут в продажу: сервер сверяет percent | amount_kopecks (№95)
      // и не пускает корзину крупнее одобренной или скидку больше max_discount_kopecks (№100)
      const a = await api.approveDiscount(approvalBody({ approver, pin, reason: why, discount: d, discountKopecks: kop, subtotalKopecks: base }));
      const who = approvers?.find((u) => u.user_id === approver);
      onApply({ ...result, reason: why, approval: { ...a, approved_by: { user_id: approver, name: who?.name ?? null }, base_kopecks: base, discount_kopecks: kop } });
    } catch (err) {
      setError(approvalError(err));
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  const setFromKey = (k) => setValue((v) => (type === 'percent' ? keypad(String(v), k).slice(0, 3) : keypad(String(v).replace(/[,.].*$/, ''), k)));
  const onInput = (raw) => setValue(type === 'percent' ? raw.replace(/\D/g, '').slice(0, 3) : raw.replace(/[^\d,.]/g, ''));
  let cta = 'Введите скидку';
  if (kop) cta = over ? (needApproval ? 'Подтвердить у управляющего' : `Применить скидку ${formatMoney(kop)} с причиной`) : `Применить скидку ${formatMoney(kop)}`;

  return (
    <Dialog open={open} onClose={onClose} title="Скидка" labelledBy="disc-title" wide>
      <form class="disc" onSubmit={apply} noValidate>
        <p class="hint">
          Скидка действует на бар: товары и счета столов ({formatMoney(base)}). Время стола — по тарифу. Лимит ресепшена — {limit} %.
        </p>
        <fieldset class="seg" aria-label="Вид скидки">
          <label class="seg__item">
            <input type="radio" name="disc-type" checked={type === 'percent'} onChange={() => (setType('percent'), setValue(''))} />
            <span class="seg__box">
              <Icon name="percent" />
              Процент
            </span>
          </label>
          <label class="seg__item">
            <input type="radio" name="disc-type" checked={type === 'amount'} onChange={() => (setType('amount'), setValue(''))} />
            <span class="seg__box">
              <Icon name="cash" />
              Сумма, ₽
            </span>
          </label>
        </fieldset>

        <div class="disc__entry">
          <div class="disc__value">
            {type === 'percent' ? (
              <div class="quick" role="group" aria-label="Быстрый выбор процента">
                {QUICK_PERCENTS.map((p) => (
                  <button type="button" key={p} class={`btn btn--sm ${String(p) === String(value) ? 'btn--primary' : 'btn--secondary'}`} aria-pressed={String(p) === String(value) ? 'true' : 'false'} onClick={() => setValue(String(p))}>
                    {p} %
                  </button>
                ))}
              </div>
            ) : null}
            <div class="field">
              <label class="field__label" for="disc-value">
                {type === 'percent' ? 'Скидка, %' : 'Скидка, ₽'}
              </label>
              <input id="disc-value" class="field__input field__input--money mono" inputMode={type === 'percent' ? 'numeric' : 'decimal'} autoComplete="off" value={value} aria-invalid={whole || (type === 'percent' && Number(value) > 100) ? 'true' : undefined} aria-describedby="disc-err" onInput={(e) => onInput(e.currentTarget.value)} />
              {whole ? (
                <p class="field__error" id="disc-err">
                  Скидка не может быть на всю сумму бара.
                </p>
              ) : type === 'percent' ? (
                <p class="field__hint" id="disc-err">
                  Целый процент, от 1 до 99.
                </p>
              ) : null}
            </div>
            <div class={`change${kop ? '' : ' change--short'}${over ? ' change--over' : ''}`} aria-live="polite">
              <p class="change__label">{kop ? `Скидка ${discountPercent(base, kop).toLocaleString('ru-RU')} %` : 'Скидка'}</p>
              <p class="change__value display">{kop ? `−${formatMoney(kop)}` : '—'}</p>
            </div>
          </div>
          <Keypad onKey={setFromKey} label="Клавиатура скидки" compact />
        </div>

        {over ? (
          <div class="disc__over">
            <div class="note note--lamp" role="status">
              <Icon name="alert" />
              <p class="note__title">Больше лимита ресепшена ({limit} %)</p>
              <p class="note__body">{bigAllowed ? 'Укажите причину: скидка попадёт в журнал, владелец получит уведомление.' : 'Нужна причина и подтверждение управляющего. Владелец получит уведомление.'}</p>
            </div>
            <fieldset>
              <legend class="field__label">Причина</legend>
              <div class="pills">
                {DISCOUNT_REASONS.map((r) => (
                  <label class="pill" key={r.code}>
                    <input type="radio" name="disc-reason" checked={reason === r.code} onChange={() => setReason(r.code)} />
                    <span>{r.label}</span>
                  </label>
                ))}
              </div>
              {tried && !reason ? <p class="field__error">Выберите причину.</p> : null}
            </fieldset>
            <div class="field">
              <label class="field__label" for="disc-text">
                Своими словами
              </label>
              <textarea id="disc-text" class="field__input" rows={2} maxLength={300} value={text} aria-invalid={tried && text.trim().length < 3 ? 'true' : undefined} onInput={(e) => setText(e.currentTarget.value)} />
              {tried && text.trim().length < 3 ? <p class="field__error">Опишите причину — её увидит владелец.</p> : <p class="field__hint">Например: «Гость ждал заказ 40 минут».</p>}
            </div>
            {needApproval ? (
              <div class="approve">
                <fieldset>
                  <legend class="field__label">Кто подтверждает</legend>
                  {approvers === null ? <p class="muted">Загружаем управляющих…</p> : null}
                  {approvers?.length === 0 ? <p class="hint">Не нашли управляющих клуба. Попросите владельца добавить управляющего или дать скидку в пределах лимита.</p> : null}
                  <div class="pills">
                    {(approvers ?? []).map((u) => (
                      <label class="pill" key={u.user_id}>
                        <input type="radio" name="approver" checked={approver === u.user_id} onChange={() => setApprover(u.user_id)} />
                        <span>{u.name ?? 'Управляющий'}</span>
                      </label>
                    ))}
                  </div>
                  {tried && !approver ? <p class="field__error">Выберите, кто подтверждает.</p> : null}
                </fieldset>
                <div class="approve__pin">
                  <div class="field">
                    <label class="field__label" for="approve-pin">
                      PIN управляющего
                    </label>
                    <input
                      id="approve-pin"
                      class="field__input mono approve__input"
                      type="password"
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={6}
                      value={pin}
                      aria-invalid={tried && !/^\d{4,6}$/.test(pin) ? 'true' : undefined}
                      onInput={(e) => setPin(e.currentTarget.value.replace(/\D/g, '').slice(0, 6))}
                    />
                    <p class="field__hint">Управляющий вводит PIN сам.</p>
                  </div>
                  <Keypad keys={PIN_KEYS} label="Клавиатура PIN" compact onKey={(k) => setPin((p) => (k === 'back' ? p.slice(0, -1) : k === 'clear' ? '' : (p + k).slice(0, 6)))} />
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <ErrorNote error={error} />
        <div class="dialog__actions dialog__actions--row">
          <button type="submit" class="btn btn--primary btn--lg" disabled={!kop || whole || busy}>
            {busy ? 'Проверяем PIN…' : cta}
          </button>
          {current ? (
            <button type="button" class="btn btn--quiet btn--lg" onClick={() => onApply(null)}>
              Убрать скидку
            </button>
          ) : null}
        </div>
      </form>
    </Dialog>
  );
}

const TITLES = { cash: 'Оплата наличными', card_terminal: 'Оплата картой', sbp: 'Оплата по СБП' };

/**
 * Оплата чека (контракт m2 §4–§5). Наличные — ввод суммы и сдача крупно; карта — через терминал клуба;
 * СБП — QR из ответа API (confirmation_data), ожидание по SSE `sale` и опросу. После оплаты — состояние чека ККТ.
 */
export function PayDialog({ method, cart, discount, toBar, kktOnline, clubId, liveTick, onClose, onDone, onShiftClosed, onAbandon, onReapprove }) {
  const open = Boolean(method);
  const [received, setReceived] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sale, setSale] = useState(null);
  const [phone, setPhone] = useState('');
  const key = useRef(null);
  const inputRef = useRef(null);
  const totals = saleTotals(cart, discount);
  const askPhone = method === 'sbp' && (error?.code === 'phone_required' || phone !== '');

  const submit = async (e) => {
    e?.preventDefault();
    const cash = cashState(totals.total, received);
    if (method === 'cash' && (!cash.enough || cash.tooMuch)) {
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = saleBody(cart, { discount, approval: discount?.approval, reason: discount?.reason, method, receivedKopecks: cash.receivedK, toBar });
      // СБП: чек ЮKassa уходит на телефон гостя, если у клуба нет почты для чеков (backend-pos: customer_phone)
      if (method === 'sbp' && normalizePhone(phone)) body.customer_phone = normalizePhone(phone);
      setSale(normalizeSale(await api.sale(body, key.current)));
    } catch (err) {
      // Подтверждение управляющего истекло (5 минут), использовано, корзина крупнее одобренной или скидка больше — 403 (№100)
      // Скидка выше лимита без подтверждения (сняли старое) — 403 limit_exceeded: просим PIN управляющего
      setError(err?.code === 'forbidden' && discount?.approval ? { code: 'approval_invalid' } : err?.code === 'limit_exceeded' && discount ? { code: 'approval_required' } : err);
      if (err?.code === 'shift_closed') onShiftClosed?.();
    } finally {
      setBusy(false);
    }
  };

  // Новое окно оплаты — новый ключ идемпотентности; СБП сразу создаёт продажу и показывает QR
  useEffect(() => {
    if (!open) return;
    key.current = newIdempotencyKey();
    setReceived('');
    setPhone('');
    setError(null);
    setSale(null);
    setBusy(false);
    if (method === 'sbp') submit();
  }, [method]);

  const refresh = async () => {
    if (!sale?.id) return;
    try {
      const next = normalizeSale(await api.saleStatus(sale.id));
      if (next) setSale(next);
    } catch {
      // опрос повторится
    }
  };

  const paid = Boolean(sale?.paid);
  const pending = Boolean(sale?.pending);
  const receiptWaiting = paid && sale.method !== 'sbp' && (!sale.receipt?.status || sale.receipt.status === 'receipt_pending');

  // Ждём оплату по СБП и печать чека: событие SSE (liveTick) и опрос раз в 2 секунды, не дольше минуты
  useEffect(() => {
    if (!pending && !receiptWaiting) return undefined;
    const started = Date.now();
    const t = setInterval(() => {
      if (Date.now() - started > 60_000) clearInterval(t);
      refresh();
    }, 2000);
    return () => clearInterval(t);
  }, [sale?.id, pending, receiptWaiting]);
  useEffect(() => {
    if (liveTick) refresh();
  }, [liveTick]);

  const close = async () => {
    if (pending && sale?.id) {
      // Снимаем QR (№98). Гость успел оплатить — 409 already_paid: показываем оплату, окно не закрываем
      try {
        await api.cancelSale(sale.id, 'Гость не стал платить по QR');
      } catch (err) {
        if (err?.code === 'already_paid') {
          await refresh();
          return;
        }
        // сеть или сервер: касса ещё следит за продажей — придёт оплата событием pos_sale, чек закроется сам
      }
      onAbandon?.(sale.id);
    }
    if (paid) onDone?.();
    onClose();
  };

  if (!open) return <Dialog open={false} onClose={onClose} title="" />;

  if (paid) {
    const r = receiptView(sale.receipt, kktOnline, sale.method);
    return (
      <Dialog open onClose={close} title="Оплачено" labelledBy="pay-title" wide>
        <div class="paydone" role="status">
          {sale.method === 'cash' ? (
            <div class="change change--big">
              <p class="change__label">Сдача</p>
              <p class="change__value display">{formatMoney(sale.change_kopecks ?? 0)}</p>
            </div>
          ) : (
            <p class="paydone__sum">
              <span class="display">{formatMoney(sale.total_kopecks ?? totals.total)}</span> {sale.method === 'sbp' ? 'по СБП' : 'картой'}
            </p>
          )}
          <div class={`note rstate rstate--${r.tone}`}>
            <Icon name={r.tone === 'ok' ? 'check' : r.tone === 'warn' ? 'alert' : 'printer'} />
            <p class="note__title">{r.title}</p>
            <p class="note__body">{r.text}</p>
          </div>
          {sale.hasTable ? (
            <p class="lead paydone__light">
              <Icon name="lamp" />
              Свет на оплаченном столе включится через несколько секунд.
            </p>
          ) : null}
          <button type="button" class="btn btn--primary btn--block btn--lg" onClick={close}>
            Новый чек
          </button>
        </div>
      </Dialog>
    );
  }

  const cash = cashState(totals.total, received);
  return (
    <Dialog open onClose={close} title={TITLES[method]} labelledBy="pay-title" wide>
      <form class="accept" onSubmit={submit} noValidate>
        <div class="accept__sum">
          <p class="accept__what">
            К оплате{totals.discount ? `, со скидкой ${formatMoney(totals.discount)}` : ''}
          </p>
          <p class="accept__amount display">{formatMoney(totals.total)}</p>
        </div>

        {method === 'cash' ? <CashEntry amount={totals.total} value={received} onChange={setReceived} inputRef={inputRef} id="pos-received" /> : null}

        {method === 'card_terminal' ? (
          <ol class="howto">
            <li>
              <span>
                Проведите на терминале <b class="mono">{formatMoney(totals.total)}</b>.
              </span>
            </li>
            <li>
              <span>Дождитесь, когда терминал напечатает слип об оплате.</span>
            </li>
            <li>
              <span>Нажмите кнопку ниже — касса пробьёт чек.</span>
            </li>
          </ol>
        ) : null}

        {method === 'sbp' ? (
          <div class="sbp">
            {pending && sale.confirmation?.confirmation_data ? (
              <>
                <QrCode data={sale.confirmation.confirmation_data} label={`QR-код для оплаты ${formatMoney(totals.total)} по СБП`} />
                <div class="sbp__text">
                  <p class="lead">Покажите QR гостю: он наведёт камеру телефона или откроет приложение банка и подтвердит оплату.</p>
                  <p class="waiting" role="status">
                    <span class="waiting__dot" aria-hidden="true" />
                    Ждём оплату по СБП
                  </p>
                </div>
              </>
            ) : sale && !pending ? (
              <div class="note">
                <Icon name="info" />
                <p class="note__title">QR больше не действует</p>
                <p class="note__body">Оплата отменена. Создайте новый QR или выберите другой способ.</p>
              </div>
            ) : !error ? (
              <p class="waiting" role="status">
                <span class="waiting__dot" aria-hidden="true" />
                Создаём QR…
              </p>
            ) : null}
            {askPhone && !pending ? (
              <div class="field">
                <label class="field__label" for="sbp-phone">
                  Телефон гостя для чека
                </label>
                <input id="sbp-phone" class="field__input mono" type="tel" inputMode="tel" autoComplete="off" value={phone} onInput={(e) => setPhone(e.currentTarget.value)} aria-invalid={phone && !normalizePhone(phone) ? 'true' : undefined} />
                <p class="field__hint">ЮKassa пришлёт на него чек по СБП.</p>
              </div>
            ) : null}
          </div>
        ) : null}

        <ErrorNote error={error}>
          {error?.code === 'shift_closed' ? (
            <a class="btn btn--secondary btn--sm" href={`${BASE}c/${encodeURIComponent(clubId)}/shift`} onClick={linkHandler}>
              Открыть смену
            </a>
          ) : (error?.code === 'approval_invalid' || error?.code === 'approval_required') && onReapprove ? (
            <button type="button" class="btn btn--secondary btn--sm" onClick={onReapprove}>
              {error.code === 'approval_invalid' ? 'Подтвердить скидку заново' : 'Подтвердить скидку'}
            </button>
          ) : null}
        </ErrorNote>

        {method === 'cash' ? (
          <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy || !cash.enough || cash.tooMuch}>
            <Icon name="cash" />
            {busy ? 'Проводим…' : cash.enough ? `Принять ${formatMoney(cash.receivedK)}` : 'Введите полученную сумму'}
          </button>
        ) : null}
        {method === 'card_terminal' ? (
          <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
            <Icon name="card" />
            {busy ? 'Проводим…' : 'Оплата по карте прошла'}
          </button>
        ) : null}
        {method === 'sbp' ? (
          <div class="dialog__actions dialog__actions--row">
            {sale && !pending ? (
              <button type="button" class="btn btn--primary btn--lg" disabled={busy} onClick={() => ((key.current = newIdempotencyKey()), submit())}>
                <Icon name="qr" />
                Создать новый QR
              </button>
            ) : null}
            {error && !sale ? (
              <button type="button" class="btn btn--primary btn--lg" disabled={busy || (askPhone && !normalizePhone(phone))} onClick={() => submit()}>
                <Icon name="refresh" />
                Создать QR ещё раз
              </button>
            ) : null}
            <button type="button" class="btn btn--quiet btn--lg" onClick={close}>
              {pending ? 'Отменить оплату по СБП' : 'Закрыть'}
            </button>
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}

/**
 * Стоп-лист с кассы (№88): ресепшн снимает с продажи закончившееся и возвращает обратно.
 * Цены и состав меню меняет только управляющий (раздел «Меню»).
 */
export function StopListDialog({ open, menu, onClose, onChanged }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [local, setLocal] = useState({});
  useEffect(() => {
    if (open) {
      setLocal({});
      setError(null);
    }
  }, [open]);
  if (!open || !menu) return <Dialog open={false} onClose={onClose} title="" />;
  const toggle = async (p) => {
    const next = !(local[p.id] ?? p.stop_list);
    setBusy(p.id);
    setError(null);
    setLocal((m) => ({ ...m, [p.id]: next }));
    try {
      await api.setStopList(p.id, next);
      onChanged?.();
    } catch (err) {
      setLocal((m) => ({ ...m, [p.id]: !next }));
      setError(err);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog open onClose={onClose} title="Стоп-лист" labelledBy="stop-title" wide>
      <div class="form">
        <p class="hint">Закончилось — выключите: гости не смогут заказать это со стола, а на кассе плитка станет неактивной. Цены меняет управляющий.</p>
        <ErrorNote error={error} />
        {menu.categories.map((c) => {
          const list = menu.products.filter((p) => p.category_id === c.id);
          if (!list.length) return null;
          return (
            <section key={c.id ?? 'other'} aria-label={c.name}>
              <h3 class="tables__title">{c.name}</h3>
              <ul class="plist">
                {list.map((p) => {
                  const stop = local[p.id] ?? p.stop_list;
                  return (
                    <li class={`prow prow--compact${stop ? ' prow--stop' : ''}`} key={p.id}>
                      <div class="prow__main">
                        <p class="prow__name">{p.name}</p>
                      </div>
                      <button type="button" class={`switch${stop ? '' : ' switch--on'}`} aria-pressed={stop ? 'false' : 'true'} disabled={busy === p.id} onClick={() => toggle(p)} aria-label={`${p.name}: ${stop ? 'в стоп-листе, вернуть в продажу' : 'в продаже, поставить в стоп-лист'}`}>
                        <span class="switch__track" aria-hidden="true">
                          <span class="switch__knob" />
                        </span>
                        <span class="switch__word">{stop ? 'Стоп-лист' : 'В продаже'}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </Dialog>
  );
}
