/**
 * Разметка страниц: Preact + htm (теговые шаблоны вместо JSX — серверу не нужна сборка).
 * Рендер — preact-render-to-string. Сырая разметка (SVG из shared) — только константы из наших модулей.
 */
import { h } from 'preact';
import htm from 'htm';
import { ICONS, ICON_STROKE } from '@billiardum/shared/icons';

export const html = htm.bind(h);

/** Готовая разметка из наших модулей (SVG стола, Markdown после экранирования). Не для данных из API. */
export function Raw({ html: markup, as = 'span', ...props }) {
  return h(as, { ...props, dangerouslySetInnerHTML: { __html: markup } });
}

export function Icon({ name, class: cls = '', label }) {
  const paths = ICONS[name] ?? [];
  return html`<svg class=${`icon ${cls}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width=${ICON_STROKE}
    stroke-linecap="round" stroke-linejoin="round" aria-hidden=${label ? undefined : 'true'} role=${label ? 'img' : undefined}
    aria-label=${label} focusable="false">${paths.map((d) => html`<path d=${d} />`)}</svg>`;
}
