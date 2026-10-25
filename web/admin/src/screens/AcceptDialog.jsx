import { useEffect, useRef, useState } from 'preact/hooks';
import { formatMoney } from '@billiardum/shared/format';
import { Dialog } from '../components/Dialog.jsx';
import { Icon } from '../components/Icon.jsx';
import { Keypad } from '../components/Keypad.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { api } from '../lib/api.js';
import { changeFor, keypad, parseRubles, quickSums, groupDigits } from '../lib/cash.js';
import { requestName } from '../lib/words.js';
import { familyText } from '@billiardum/shared/resource';
import { requestFamily, requestHallItem, requestLength } from '../lib/court.js';

/**
 * «Принять оплату» по заявке гостя (контракт §5): наличные — ввод полученной суммы и сдача крупно;
 * карта — через банковский терминал клуба, ресепшн подтверждает «Оплата прошла».
 * После принятия сервер включает свет и ставит чек ККТ в очередь (receipt_pending до моста ККТ в M2).
 */
export function AcceptDialog({ request, onClose, onDone, hall, refreshHall }) {
  const open = Boolean(request);
  const [method, setMethod] = useState('cash');
  const [received, setReceived] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);

  // Сессию сервер создаёт асинхронно (accept отвечает session_id: null) — ждём стол в зале по SSE и опросу
  const table = requestHallItem(request, hall);
  const lit = Boolean(result && (result.session_id || table?.session));
  useEffect(() => {
    if (!result || lit) return undefined;
    const started = Date.now();
    const t = setInterval(() => {
      if (Date.now() - started > 30000) clearInterval(t);
      refreshHall?.();
    }, 1500);
    return () => clearInterval(t);
  }, [result, lit]);

  useEffect(() => {
    if (open) {
      setMethod('cash');
      setReceived('');
      setError(null);
      setResult(null);
      setBusy(false);
    }
  }, [request?.id]);

  if (!request) return <Dialog open={false} onClose={onClose} title="" />;

  const amount = request.amount_kopecks;
  const receivedK = parseRubles(received);
  const calc = changeFor(amount, receivedK);
  const tooMuch = receivedK !== null && receivedK - amount > 1_000_000; // сдача больше 10 000 ₽ — почти наверняка опечатка
  const what = `${requestName(request)} · ${requestLength(request)}`;
  const onWhat = requestName(request, { case: 'pre', capital: false });

  const submit = async (e) => {
    e?.preventDefault();
    if (method === 'cash' && !calc.enough) {
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = method === 'cash' ? { method: 'cash', received_kopecks: receivedK } : { method: 'card_terminal' };
      const res = await api.accept(request.id, body);
      setResult({ ...res, method });
      onDone?.(request, res);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Dialog open={open} onClose={onClose} title="Оплата принята" labelledBy="accept-title">
        <div class="accept-done" role="status">
          {result.method === 'cash' ? (
            <div class="change change--big">
              <p class="change__label">Сдача</p>
              <p class="change__value display">{formatMoney(result.change_kopecks ?? 0)}</p>
            </div>
          ) : null}
          <p class="lead accept-done__light" aria-live="polite">
            <Icon name="lamp" />
            {lit
              ? `Свет на ${onWhat} включён. Чек ставим в очередь кассы.`
              : `Включаем свет на ${onWhat}… Чек ставим в очередь кассы.`}
          </p>
          <button type="button" class="btn btn--primary btn--block btn--lg" onClick={onClose}>
            Готово
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title="Принять оплату" labelledBy="accept-title" wide>
      <form class="accept" onSubmit={submit} noValidate>
        <div class="accept__sum">
          <p class="accept__what">{what}</p>
          <p class="accept__amount display">{formatMoney(amount)}</p>
          {request.guest_masked_phone ? <p class="small">Гость {request.guest_masked_phone}</p> : null}
        </div>

        <fieldset class="seg" aria-label="Способ оплаты">
          <label class="seg__item">
            <input type="radio" name="method" value="cash" checked={method === 'cash'} onChange={() => setMethod('cash')} />
            <span class="seg__box">
              <Icon name="cash" />
              Наличные
            </span>
          </label>
          <label class="seg__item">
            <input type="radio" name="method" value="card_terminal" checked={method === 'card_terminal'} onChange={() => setMethod('card_terminal')} />
            <span class="seg__box">
              <Icon name="card" />
              Карта через терминал
            </span>
          </label>
        </fieldset>

        {method === 'cash' ? (
          <div class="cash">
            <div class="cash__input">
              <div class="field">
                <label class="field__label" for="received">
                  Получено от гостя, ₽
                </label>
                <input
                  ref={inputRef}
                  id="received"
                  class="field__input field__input--money mono"
                  inputMode="decimal"
                  autoComplete="off"
                  value={groupDigits(received)}
                  aria-invalid={received && !calc.enough ? 'true' : undefined}
                  aria-describedby="change-out"
                  onInput={(e) => setReceived(e.currentTarget.value.replace(/[^\d,.]/g, ''))}
                />
              </div>
              <div class="quick" role="group" aria-label="Быстрый выбор суммы">
                {quickSums(amount).map((v) => (
                  <button type="button" key={v} class="btn btn--secondary btn--sm" onClick={() => setReceived(String(v / 100))}>
                    {v === amount ? 'Без сдачи' : formatMoney(v)}
                  </button>
                ))}
              </div>
              <div id="change-out" class={`change${calc.enough ? '' : ' change--short'}`} aria-live="polite">
                <p class="change__label">{calc.enough ? 'Сдача' : receivedK === null ? 'Введите сумму' : 'Не хватает'}</p>
                <p class="change__value display">{receivedK === null ? '—' : formatMoney(calc.enough ? calc.change : calc.short)}</p>
              </div>
              {tooMuch ? <p class="field__error">Сдача больше 10 000 ₽ — проверьте сумму.</p> : null}
            </div>
            <Keypad onKey={(k) => setReceived((v) => keypad(v.replace(/[,.].*$/, ''), k))} />
          </div>
        ) : (
          <div class="terminal">
            <ol class="howto">
              <li>
                <span>
                  Проведите на терминале <b class="mono">{formatMoney(amount)}</b>.
                </span>
              </li>
              <li>
                <span>Дождитесь, когда терминал напечатает чек об оплате.</span>
              </li>
              <li>
                <span>{familyText('Нажмите кнопку ниже — свет на столе включится.', requestFamily(request))}</span>
              </li>
            </ol>
          </div>
        )}

        <ErrorNote error={error} />

        <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy || (method === 'cash' && (!calc.enough || tooMuch))}>
          <Icon name="lamp" />
          {busy
            ? 'Принимаем…'
            : method === 'cash'
              ? calc.enough
                ? `Принять ${formatMoney(receivedK)} и включить свет`
                : 'Введите полученную сумму'
              : 'Оплата по карте прошла — включить свет'}
        </button>
      </form>
    </Dialog>
  );
}
