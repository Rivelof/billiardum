/**
 * Бильярдум — зал: столы в настоящем масштабе (DESIGN §1, §4), расстановка на плане и статусы словами.
 * Без зависимостей. Рисунок стола — строка SVG на классах из hall.css (без атрибутов style: работает при строгой CSP).
 *
 *   tableKind('billiard_pool')                     → 'pool'
 *   tableSvg('pyramid', { horizontal: true })      → '<svg …>…</svg>'
 *   planLayout(resources, { perRow: 4 })           → { width, height, items: [{ id, number, kind, x, y, w, h }] } в мм
 *   tableState(item, { formatTime })               → { tone, lit, word, label }
 */

/** Размеры столов в мм: поле и борт. Пирамида и снукер 12 футов, пул 9 футов (поэтому пул на плане короче). */
export const TABLE_SIZES = Object.freeze({
  pyramid: { fieldLong: 3550, fieldShort: 1775, rail: 170, outerShort: 2115, outerLong: 3890 },
  pool: { fieldLong: 2540, fieldShort: 1270, rail: 150, outerShort: 1570, outerLong: 2840 },
});

const TYPE_LABEL = {
  pyramid: 'Русская пирамида, 12 футов',
  snooker: 'Снукер, 12 футов',
  pool: 'Пул, 9 футов',
};

/**
 * Вид стола для рисунка по типу ресурса.
 * @param {string | undefined} type 'billiard_pyramid', 'billiard_pool', 'billiard_snooker'
 * @returns {'pyramid' | 'pool'}
 */
export function tableKind(type) {
  return /pool/i.test(type ?? '') ? 'pool' : 'pyramid';
}

/**
 * Подпись типа стола: название из клуба, иначе по типу.
 * @param {string | undefined} type
 * @param {string | undefined} [title] resource.title из API, например 'Пирамида 12 футов'
 */
export function typeLabel(type, title) {
  // Название вида «Стол 2» ничего не добавляет к номеру — тогда подпись по типу
  if (title && !/^стол\s*№?\s*\d+$/i.test(title.trim())) return title;
  if (/snooker/i.test(type ?? '')) return TYPE_LABEL.snooker;
  return TYPE_LABEL[tableKind(type)];
}

// Геометрия рисунка — из shared/styleguide.html, единица viewBox — 1 мм
const ART = {
  pyramid: {
    w: 2115, h: 3890, rx: 120, rail: 170,
    spot: [1057.5, 1945, 980, 1850],
    pockets: [[185, 185, 70], [1930, 185, 70], [160, 1945, 62], [1955, 1945, 62], [185, 3705, 70], [1930, 3705, 70]],
    diamonds: { r: 20, side: [85, 2030], along: [614, 1058, 1501, 2389, 2832, 3276], ends: [85, 3805], across: [614, 1058, 1501] },
    bar: [932, 815, 250, 2260, 125],
    lamps: { x: 1057.5, ys: [1095, 1945, 2795], r: 82 },
  },
  pool: {
    w: 1570, h: 2840, rx: 110, rail: 150,
    spot: [785, 1420, 720, 1320],
    pockets: [[170, 170, 85], [1400, 170, 85], [140, 1420, 75], [1430, 1420, 75], [170, 2670, 85], [1400, 2670, 85]],
    diamonds: { r: 18, side: [75, 1495], along: [467, 785, 1102, 1738, 2055, 2373], ends: [75, 2765], across: [467, 785, 1102] },
    bar: [670, 640, 230, 1560, 115],
    lamps: { x: 785, ys: [860, 1420, 1980], r: 76 },
  },
};

let uidCounter = 0;

/**
 * Стол сверху (DESIGN §1, §2 — редакция №127): полированный ореховый борт с бликом, латунные накладки у луз,
 * сукно с мягкой виньеткой, прицельные метки, лампа над столом и её тёплый конус на сукне.
 * Свет управляется CSS-переменной --lit (0 — темно, 1 — горит) на предке; цвета — классы в hall.css.
 * @param {'pyramid' | 'pool'} kind
 * @param {{ horizontal?: boolean, uid?: string, className?: string }} [options]
 * @returns {string} разметка SVG, только константы — безопасно для innerHTML
 */
export function tableSvg(kind, options = {}) {
  const a = ART[kind] ?? ART.pyramid;
  const uid = options.uid ?? `bl-spot-${(uidCounter += 1)}`;
  const c = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`;
  const d = a.diamonds;
  const diamonds = [
    ...d.side.flatMap((x) => d.along.map((y) => c(x, y, d.r))),
    ...d.ends.flatMap((y) => d.across.map((x) => c(x, y, d.r))),
  ].join('');
  const fieldW = a.w - 2 * a.rail;
  const fieldH = a.h - 2 * a.rail;
  const [bx, by, bw, bh, brx] = a.bar;
  const edge = Math.round(a.rail * 0.18);
  const body =
    `<rect class="ta-rail" width="${a.w}" height="${a.h}" rx="${a.rx}" fill="url(#${uid}-r)"/>` +
    `<rect class="ta-rail-hi" x="${edge}" y="${edge}" width="${a.w - 2 * edge}" height="${a.h - 2 * edge}" rx="${a.rx - edge}"/>` +
    `<g class="ta-brass">${a.pockets.map(([x, y, r]) => c(x, y, Math.round(r * 1.55))).join('')}</g>` +
    `<rect class="ta-cloth" x="${a.rail}" y="${a.rail}" width="${fieldW}" height="${fieldH}" fill="url(#${uid}-c)"/>` +
    `<ellipse class="ta-spot" cx="${a.spot[0]}" cy="${a.spot[1]}" rx="${a.spot[2]}" ry="${a.spot[3]}" fill="url(#${uid})"/>` +
    `<rect class="ta-cushion" x="${a.rail + 25}" y="${a.rail + 25}" width="${fieldW - 50}" height="${fieldH - 50}"/>` +
    `<g class="ta-pockets">${a.pockets.map(([x, y, r]) => c(x, y, r)).join('')}</g>` +
    `<g class="ta-diamonds">${diamonds}</g>` +
    `<rect class="ta-bar" x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${brx}"/>` +
    `<g class="ta-lamps">${a.lamps.ys.map((y) => c(a.lamps.x, y, a.lamps.r)).join('')}</g>`;
  const defs =
    '<defs>' +
    `<radialGradient id="${uid}">` +
    '<stop offset="0" class="ta-stop" stop-opacity="0.42"/>' +
    '<stop offset="0.55" class="ta-stop" stop-opacity="0.16"/>' +
    '<stop offset="1" class="ta-stop" stop-opacity="0"/>' +
    '</radialGradient>' +
    `<linearGradient id="${uid}-r" x1="0" y1="0" x2="1" y2="1">` +
    '<stop offset="0" class="ta-r1"/><stop offset="0.45" class="ta-r2"/><stop offset="1" class="ta-r3"/>' +
    '</linearGradient>' +
    `<radialGradient id="${uid}-c" cx="0.5" cy="0.5" r="0.72">` +
    '<stop offset="0" class="ta-c1"/><stop offset="1" class="ta-c2"/>' +
    '</radialGradient>' +
    '</defs>';
  const cls = `ta ta--${kind}${options.className ? ` ${options.className}` : ''}`;
  if (options.horizontal) {
    return (
      `<svg class="${cls}" viewBox="0 0 ${a.h} ${a.w}" aria-hidden="true" focusable="false">${defs}` +
      `<g transform="translate(${a.h} 0) rotate(90)">${body}</g></svg>`
    );
  }
  return `<svg class="${cls}" viewBox="0 0 ${a.w} ${a.h}" aria-hidden="true" focusable="false">${defs}${body}</svg>`;
}

const MARGIN_X = 1500;
const MARGIN_TOP = 1000;
const MARGIN_BOTTOM = 800;
const GAP_X = 1800; // проход между столами для кия
const GAP_Y = 3400; // проход между рядами, сюда же помещается подпись

/**
 * Расстановка столов на плане, пока у ресурсов нет своих координат: ряды по perRow (по умолчанию — авто),
 * сначала большие столы (пирамида, снукер), затем пул. Столы в ряду выровнены по нижнему краю.
 * @param {{ id: string, number: number, type?: string }[]} resources
 * @param {{ perRow?: number }} [options] perRow не задан — столько, сколько столов одного вида, от 3 до 6
 * @returns {{ width: number, height: number, items: { id: string, number: number, kind: 'pyramid' | 'pool', x: number, y: number, w: number, h: number }[] }}
 */
export function planLayout(resources, options = {}) {
  const sorted = [...resources].sort((a, b) => a.number - b.number);
  const big = sorted.filter((r) => tableKind(r.type) === 'pyramid');
  const small = sorted.filter((r) => tableKind(r.type) === 'pool');
  // По умолчанию — ряд на вид столов (сколько больших или малых), от 3 до 6 в ряду
  const perRow = Math.max(1, options.perRow ?? Math.min(6, Math.max(3, big.length, small.length)));
  const rows = [];
  for (const group of [big, small]) {
    for (let i = 0; i < group.length; i += perRow) rows.push(group.slice(i, i + perRow));
  }
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const cell = TABLE_SIZES.pyramid.outerShort;
  const rowH = TABLE_SIZES.pyramid.outerLong;
  const width = 2 * MARGIN_X + cols * cell + (cols - 1) * GAP_X;
  const items = [];
  rows.forEach((row, ri) => {
    const rowTop = MARGIN_TOP + ri * (rowH + GAP_Y);
    row.forEach((r, ci) => {
      const kind = tableKind(r.type);
      const size = TABLE_SIZES[kind];
      const cx = MARGIN_X + ci * (cell + GAP_X) + cell / 2;
      items.push({
        id: r.id,
        number: r.number,
        kind,
        x: cx - size.outerShort / 2,
        y: rowTop + (rowH - size.outerLong),
        w: size.outerShort,
        h: size.outerLong,
      });
    });
  });
  const height = rows.length ? MARGIN_TOP + rows.length * rowH + (rows.length - 1) * GAP_Y + MARGIN_BOTTOM : MARGIN_TOP;
  return { width, height, items };
}

/** Бронь дальше этого срока на плане зала не показываем: стол свободен для игры сейчас. */
export const BOOKED_HORIZON_MS = 12 * 60 * 60_000;

/**
 * Состояние стола на плане зала словами (DESIGN §2: статус никогда не передаётся только цветом).
 * @param {{ status: string, session?: { status?: string, paid_until?: string, grace_until?: string | null, unlimited?: boolean } | null, until?: string | null, busy_until?: string | null, device?: { online?: boolean } }} item элемент `GET /api/clubs/{club}/hall`
 * @param {{ formatTime?: (iso: string) => string, now?: number }} [options]
 * word — коротко для подписи на плане, spoken (если есть) — полностью для экранного диктора.
 * item.hold — { kind, until, source: 'booking' | 'waitlist' | 'staff', offer_id?, booking_id? }: стол, предложенный гостю
 * из очереди (№122), — «Из очереди до 21:05».
 * item.next_booking — { id, starts_at, ends_at, source, status } | null ближайшей живой брони стола (сервер, M3 №120):
 * свободный стол с бронью в ближайшие 12 часов получает янтарную рамку и время брони; дальняя бронь план не красит.
 * @returns {{ tone: 'free' | 'pending' | 'reserved' | 'booked' | 'play' | 'ending' | 'grace' | 'service' | 'offline', lit: boolean, word: string, spoken?: string }}
 */
export function tableState(item, options = {}) {
  const fmt = options.formatTime ?? ((iso) => iso);
  const now = options.now ?? Date.now();
  const session = item.session ?? null;
  const sStatus = session?.status;
  const until = item.until ?? item.busy_until ?? null;
  const offline = item.status === 'offline' || item.device?.online === false;

  if (offline) return { tone: 'offline', lit: Boolean(session), word: 'Нет связи' };
  if (item.status === 'service') {
    return { tone: 'service', lit: true, word: until ? `Сервис до ${fmt(until)}` : 'Сервисный свет' };
  }
  if (session && ['active', 'ending', 'grace'].includes(sStatus ?? 'active')) {
    if (sStatus === 'grace') return { tone: 'grace', lit: true, word: 'Льгота' };
    if (sStatus === 'ending') return { tone: 'ending', lit: true, word: '<\u00a05\u00a0мин', spoken: 'меньше 5 минут' };
    if (session.unlimited) return { tone: 'play', lit: true, word: 'Без лимита' };
    return { tone: 'play', lit: true, word: session.paid_until ? `До ${fmt(session.paid_until)}` : 'Идёт игра' };
  }
  // Бронь (M3): стол пока свободен, а на него бронь сегодня — янтарная рамка и время брони (DESIGN §1, §4)
  const booking = item.next_booking ?? null;
  // Предложение из листа ожидания держит стол за гостем до конца предложения (№122): hold.source 'waitlist'
  if (item.hold?.source === 'waitlist' && item.hold.kind !== 'pending') {
    const till = item.hold.until ?? item.until;
    return { tone: 'reserved', lit: false, word: till ? `Из очереди до ${fmt(till)}` : 'Из очереди', spoken: till ? `предложен гостю из очереди до ${fmt(till)}` : 'предложен гостю из очереди' };
  }
  if (item.status === 'reserved') {
    return { tone: 'reserved', lit: false, word: booking?.starts_at ? `Бронь ${fmt(booking.starts_at)}` : 'Бронь', spoken: booking?.starts_at ? `ждёт гостя по брони на ${fmt(booking.starts_at)}` : 'забронирован' };
  }
  if ((item.status === 'free' || !item.status) && booking?.starts_at && Date.parse(booking.starts_at) - now <= BOOKED_HORIZON_MS) {
    return { tone: 'booked', lit: false, word: `Бронь ${fmt(booking.starts_at)}`, spoken: `свободен, бронь на ${fmt(booking.starts_at)}` };
  }
  switch (item.status) {
    case 'fault':
      return { tone: 'offline', lit: false, word: 'Неисправность', spoken: 'неисправность контроллера' };
    case 'busy':
    case 'active':
    case 'ending':
    case 'grace':
      return { tone: 'play', lit: true, word: until ? `До ${fmt(until)}` : 'Идёт игра' };
    case 'pending':
      return { tone: 'pending', lit: false, word: 'Оплата', spoken: 'гость оплачивает' };
    case 'reserved':
      return { tone: 'reserved', lit: false, word: 'Бронь' };
    default:
      return { tone: 'free', lit: false, word: 'Свободен' };
  }
}
