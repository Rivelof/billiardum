import { formatMoney } from '@billiardum/shared/format';
import { Keypad } from './Keypad.jsx';
import { changeFor, keypad, parseRubles, quickSums, groupDigits } from '../lib/cash.js';

/** Сдача больше 10 000 ₽ — почти наверняка опечатка. */
export const CHANGE_SANITY = 1_000_000;

/**
 * Ввод полученных наличных: поле (с клавиатуры), быстрые суммы, сдача крупно, экранная клавиатура.
 * value — строка рублей, как ввёл кассир; onChange получает новую строку.
 */
export function CashEntry({ amount, value, onChange, inputRef, id = 'received', label = 'Получено от гостя, ₽' }) {
  const receivedK = parseRubles(value);
  const calc = changeFor(amount, receivedK);
  const tooMuch = receivedK !== null && receivedK - amount > CHANGE_SANITY;
  return (
    <div class="cash">
      <div class="cash__input">
        <div class="field">
          <label class="field__label" for={id}>
            {label}
          </label>
          <input
            ref={inputRef}
            id={id}
            class="field__input field__input--money mono"
            inputMode="decimal"
            autoComplete="off"
            value={groupDigits(value)}
            aria-invalid={value && !calc.enough ? 'true' : undefined}
            aria-describedby={`${id}-change`}
            onInput={(e) => onChange(e.currentTarget.value.replace(/[^\d,.]/g, ''))}
          />
        </div>
        <div class="quick" role="group" aria-label="Быстрый выбор суммы">
          {quickSums(amount).map((v) => (
            <button type="button" key={v} class="btn btn--secondary btn--sm" onClick={() => onChange(String(v / 100))}>
              {v === amount ? 'Без сдачи' : formatMoney(v)}
            </button>
          ))}
        </div>
        <div id={`${id}-change`} class={`change${calc.enough ? '' : ' change--short'}`} aria-live="polite">
          <p class="change__label">{calc.enough ? 'Сдача' : receivedK === null ? 'Введите сумму' : 'Не хватает'}</p>
          <p class="change__value display">{receivedK === null ? '—' : formatMoney(calc.enough ? calc.change : calc.short)}</p>
        </div>
        {tooMuch ? <p class="field__error">Сдача больше 10 000 ₽ — проверьте сумму.</p> : null}
      </div>
      <Keypad onKey={(k) => onChange(keypad(String(value).replace(/[,.].*$/, ''), k))} />
    </div>
  );
}

/** Состояние ввода для кнопки: хватает ли, не опечатка ли. */
export function cashState(amount, value) {
  const receivedK = parseRubles(value);
  const calc = changeFor(amount, receivedK);
  return { receivedK, ...calc, tooMuch: receivedK !== null && receivedK - amount > CHANGE_SANITY };
}
