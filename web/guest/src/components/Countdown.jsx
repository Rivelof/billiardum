import { formatDuration } from '@billiardum/shared/format';

/**
 * Отсчёт с кольцом (DESIGN §6): цифры крупно, рядом кольцо тает вместе со временем. Кольцо декоративное,
 * время для диктора — в aria-label таймера.
 * @param {{ left: number, total: number, label: string }} props мс
 */
export function Countdown({ left, total, label }) {
  const v = total > 0 ? Math.min(1, Math.max(0, left / total)) : 0;
  const C = 2 * Math.PI * 26;
  return (
    <p class="countdown" role="timer" aria-label={label}>
      <svg class="countdown__ring" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
        <circle class="countdown__track" cx="32" cy="32" r="26" />
        <circle class="countdown__arc" cx="32" cy="32" r="26" stroke-dasharray={`${(C * v).toFixed(2)} ${C.toFixed(2)}`} transform="rotate(-90 32 32)" />
      </svg>
      <span class="countdown__value mono" aria-hidden="true">
        {formatDuration(left)}
      </span>
    </p>
  );
}
