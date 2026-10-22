import { Icon } from './Icon.jsx';

const MONEY_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'back'];
export const PIN_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'];

/** Экранная клавиатура суммы или PIN для планшета без мыши и клавиатуры. С клавиатуры цифры вводятся в поле. */
export function Keypad({ onKey, label = 'Клавиатура суммы', keys = MONEY_KEYS, compact = false }) {
  return (
    <div class={`keypad${compact ? ' keypad--compact' : ''}`} role="group" aria-label={label}>
      {keys.map((k) => (
        <button
          type="button"
          key={k}
          class={`keypad__key${k === 'clear' ? ' keypad__key--word' : ''}`}
          onClick={() => onKey(k)}
          aria-label={k === 'back' ? 'Стереть цифру' : k === 'clear' ? 'Стереть всё' : undefined}
        >
          {k === 'back' ? <Icon name="erase" /> : k === 'clear' ? 'Сброс' : k}
        </button>
      ))}
    </div>
  );
}
