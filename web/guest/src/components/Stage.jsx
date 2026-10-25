import { familyText } from '@billiardum/shared/resource';
import { Header } from './Header.jsx';
import { TableArt } from './TableArt.jsx';

/**
 * Сцена «Свет над столом»: тёмный зал (всегда тёмный в обеих темах, DESIGN §2), стол сверху,
 * над ним лампа. tone управляет рамкой и цветом таймера: idle, play, warn, grace.
 */
export function Stage({ kind = 'pyramid', lit = 'false', tone = 'idle', compact = false, variant, back, children, label, art, pulse = false, ring = null }) {
  return (
    <section class={`stage stage--${tone}${compact ? ' stage--compact' : ''}${variant ? ` stage--${variant}` : ''}`} data-theme="dark" aria-label={label}>
      <Header back={back} />
      <div class="stage__body">
        {art ?? <TableArt kind={kind} lit={lit} pulse={pulse} ring={ring} class="stage__art" />}
        <div class="stage__text">{children}</div>
      </div>
    </section>
  );
}

const BADGE = {
  free: ['free', 'Свободен'],
  busy: ['play', 'Идёт игра'],
  pending: ['pending', 'Сейчас оплачивают'],
  reserved: ['reserved', 'Ждёт гостя'],
  service: ['pending', 'На обслуживании'],
  offline: ['alert', 'Нет связи со столом'],
};

/** Статус стола словом и точкой (статус никогда не только цветом); у корта — «Нет связи с кортом» (M5.8). */
export function StatusBadge({ status, resource }) {
  const [tone, word] = BADGE[status] ?? BADGE.free;
  return (
    <p class={`badge badge--${tone}`}>
      <span class="badge__dot" aria-hidden="true" />
      {familyText(word, resource)}
    </p>
  );
}
