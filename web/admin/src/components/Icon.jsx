import { ICONS } from '@billiardum/shared/icons';

/** Линейный значок 24×24, толщина 1,75. Декоративный: смысл несёт текст рядом. */
export function Icon({ name, class: cls = '', size }) {
  const paths = ICONS[name] ?? [];
  const style = size ? { width: `${size}px`, height: `${size}px` } : undefined;
  return (
    <svg class={`icon ${cls}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={style}>
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
