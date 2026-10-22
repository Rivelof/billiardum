import { Icon } from './Icon.jsx';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'back'];

/** Экранная клавиатура суммы для планшета без мыши и клавиатуры. С клавиатуры цифры вводятся в поле. */
export function Keypad({ onKey, label = 'Клавиатура суммы' }) {
  return (
    <div class="keypad" role="group" aria-label={label}>
      {KEYS.map((k) => (
        <button type="button" key={k} class="keypad__key" onClick={() => onKey(k)} aria-label={k === 'back' ? 'Стереть цифру' : undefined}>
          {k === 'back' ? <Icon name="erase" /> : k}
        </button>
      ))}
    </div>
  );
}
