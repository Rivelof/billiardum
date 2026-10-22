/**
 * Бильярдум — иллюстрации пустых состояний (DESIGN §8: линейные SVG, без эмодзи). Предметы бильярдной:
 * пустой стол с треугольником, кий и шар, луза, чек-лента, лампа. Строка SVG на currentColor и классах
 * (без атрибутов style) — безопасно для innerHTML при строгой CSP. Толщина линий — как у значков, 1,75 на 24 px.
 *
 *   illustration('rack')  → '<svg …>…</svg>'
 */

const STROKE = 'fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"';

const ART = {
  // Пустой стол сверху и треугольник для пирамиды: «пока никого»
  rack:
    `<rect x="8" y="22" width="104" height="56" rx="8" ${STROKE}/>` +
    `<rect x="16" y="30" width="88" height="40" rx="2" ${STROKE} class="ill-soft"/>` +
    `<path d="M70 38 L92 50 L70 62 Z" ${STROKE} class="ill-accent"/>` +
    '<g class="ill-dot"><circle cx="16" cy="30" r="3.5"/><circle cx="104" cy="30" r="3.5"/><circle cx="16" cy="70" r="3.5"/><circle cx="104" cy="70" r="3.5"/><circle cx="60" cy="29" r="3"/><circle cx="60" cy="71" r="3"/></g>',
  // Кий и шар: «ничего не выбрано», «нажмите на товар»
  cue:
    `<path d="M14 76 L82 30" ${STROKE}/>` +
    `<path d="M74 35.5 L82 30" ${STROKE} class="ill-accent"/>` +
    `<circle cx="96" cy="24" r="10" ${STROKE}/>` +
    `<path d="M92.5 20.5 a5 5 0 0 1 4.5 -2" ${STROKE} class="ill-soft"/>` +
    `<path d="M20 86 h80" ${STROKE} class="ill-soft"/>`,
  // Луза с латунной накладкой: «очередь пуста», «заявок нет»
  pocket:
    `<path d="M24 70 a36 36 0 0 1 72 0" ${STROKE} class="ill-accent"/>` +
    `<path d="M34 70 a26 26 0 0 1 52 0" ${STROKE}/>` +
    '<g class="ill-dot"><circle cx="60" cy="70" r="12"/></g>' +
    `<path d="M10 70 h100" ${STROKE} class="ill-soft"/>`,
  // Чек-лента: «чек пуст»
  receipt:
    `<path d="M34 12 h52 v68 l-6.5 -5 -6.5 5 -6.5 -5 -6.5 5 -6.5 -5 -6.5 5 -6.5 -5 -6.5 5 Z" ${STROKE}/>` +
    `<path d="M44 28 h32 M44 40 h24 M44 52 h28" ${STROKE} class="ill-soft"/>` +
    `<path d="M44 64 h32" ${STROKE} class="ill-accent"/>`,
  // Лампа над столом: «свет погас», «брони нет»
  lamp:
    `<path d="M60 8 v14" ${STROKE} class="ill-soft"/>` +
    `<path d="M36 40 a24 18 0 0 1 48 0 Z" ${STROKE}/>` +
    `<path d="M42 50 l-14 26 h64 l-14 -26" ${STROKE} class="ill-accent"/>` +
    `<path d="M18 86 h84" ${STROKE} class="ill-soft"/>`,
};

export const ILLUSTRATIONS = Object.freeze(Object.keys(ART));

/**
 * @param {'rack' | 'cue' | 'pocket' | 'receipt' | 'lamp'} name
 * @returns {string} SVG 120 × 96, декоративный (aria-hidden)
 */
export function illustration(name) {
  const body = ART[name] ?? ART.rack;
  return `<svg class="ill" viewBox="0 0 120 96" aria-hidden="true" focusable="false">${body}</svg>`;
}
