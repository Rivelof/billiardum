import { Keypad } from './Keypad.jsx';
import { groupDigits, keypad } from '../lib/cash.js';

/**
 * Поле суммы в рублях с экранной клавиатурой (размен, факт наличных, цена закупки): планшет без мыши и клавиатуры.
 * value — строка рублей, как ввёл сотрудник; разбирает её parseRubles из lib/cash.js.
 */
export function MoneyEntry({ id, label, value, onChange, hint, invalid, describedBy, inputRef, keypadLabel = 'Клавиатура суммы' }) {
  return (
    <div class="money-entry">
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
          aria-invalid={invalid ? 'true' : undefined}
          aria-describedby={describedBy ?? (hint ? `${id}-hint` : undefined)}
          onInput={(e) => onChange(e.currentTarget.value.replace(/[^\d,.]/g, ''))}
        />
        {hint ? (
          <p class="field__hint" id={`${id}-hint`}>
            {hint}
          </p>
        ) : null}
      </div>
      <Keypad label={keypadLabel} onKey={(k) => onChange(keypad(String(value).replace(/[,.].*$/, ''), k))} />
    </div>
  );
}
