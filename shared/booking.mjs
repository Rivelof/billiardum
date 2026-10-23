/**
 * Бильярдум — бронь (M3, docs/contracts/m3.md; PRODUCT §6; DESIGN §1, §4 — борт-шкала). Без зависимостей.
 * Время в API — ISO UTC, на экране — по поясу клуба (IANA). Деньги — целые копейки.
 *
 *   zonedMs('2026-10-22', 21 * 60, 'Asia/Yekaterinburg')   → момент 21:00 по клубу в мс
 *   boardSlots(day, { resourceId })                         → деления борт-шкалы: время, занято, свободно столов
 *   durationsFor(day, resourceId, startMs)                  → [60, 90, 120] — сколько можно забронировать подряд
 *   bookingPrice(rates, startMs, minutes)                   → { amount_kopecks, breakdown }
 */

const MIN = 60_000;

const offsetFormats = new Map();
function offsetFormat(timeZone) {
  let f = offsetFormats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    offsetFormats.set(timeZone, f);
  }
  return f;
}

/** Части местного времени клуба: { y, mo, d, h, mi }. */
export function localParts(ms, timeZone) {
  const parts = Object.fromEntries(offsetFormat(timeZone).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day), h: Number(parts.hour), mi: Number(parts.minute) };
}

/** Смещение пояса в мс для момента ms (местное − UTC). */
export function tzOffset(ms, timeZone) {
  const p = localParts(ms, timeZone);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  return asUtc - Math.floor(ms / MIN) * MIN;
}

/**
 * Момент «дата + минуты от полуночи» по поясу клуба. Минуты могут быть больше 1440 — ночь после полуночи.
 * @param {string} date 'YYYY-MM-DD' — рабочий день клуба
 * @param {number} minutes от полуночи этого дня
 * @param {string} timeZone IANA
 */
export function zonedMs(date, minutes, timeZone) {
  const [y, mo, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d) + minutes * MIN;
  const first = guess - tzOffset(guess, timeZone);
  return guess - tzOffset(first, timeZone);
}

/** Местная дата клуба 'YYYY-MM-DD'. */
export function localDate(ms, timeZone) {
  const p = localParts(ms, timeZone);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Следующий день 'YYYY-MM-DD' (без поясов: календарная арифметика). */
export function addDays(date, n) {
  const [y, mo, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Часы и минуты по клубу: '21:00'. */
export function hhmm(ms, timeZone) {
  const p = localParts(ms, timeZone);
  return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
}

const ms = (iso) => (typeof iso === 'number' ? iso : Date.parse(iso));
const overlaps = (a1, a2, b1, b2) => a1 < b2 && b1 < a2;

/**
 * Занятость стола в интервале. busy — [{ from, to, kind }] из GET /api/clubs/{club}/availability.
 * @returns {object | null} интервал, который пересекается
 */
export function busyAt(resource, fromMs, toMs) {
  return (resource?.busy ?? []).find((b) => overlaps(fromMs, toMs, ms(b.from), ms(b.to))) ?? null;
}

/**
 * Деления борт-шкалы на день (DESIGN §4): от открытия до закрытия клуба с шагом step_minutes.
 * Для выбранного стола — занят ли он в это деление; без стола — сколько столов свободны хотя бы min_minutes.
 * Прошедшее время и ближе lead_minutes к «сейчас» недоступно.
 * @param {object} day ответ availability
 * @param {{ resourceId?: string | null, now?: number }} [opts]
 * @returns {{ at: number, label: string, hour: boolean, state: 'free' | 'busy' | 'past', free: number }[]}
 */
export function boardSlots(day, opts = {}) {
  const tz = day.club?.timezone;
  const step = day.step_minutes ?? 30;
  const min = day.min_minutes ?? 60;
  const open = ms(day.open_at);
  const close = ms(day.close_at);
  const now = opts.now ?? Date.now();
  const earliest = now + (day.lead_minutes ?? 0) * MIN;
  const resources = opts.resourceId ? (day.resources ?? []).filter((r) => r.id === opts.resourceId) : day.resources ?? [];
  const out = [];
  for (let t = open; t + min * MIN <= close; t += step * MIN) {
    const p = localParts(t, tz);
    const free = resources.filter((r) => !busyAt(r, t, t + min * MIN)).length;
    let state = free ? 'free' : 'busy';
    if (t < earliest) state = 'past';
    out.push({ at: t, label: hhmm(t, tz), hour: p.mi === 0, state, free: state === 'past' ? 0 : free });
  }
  return out;
}

/** Свободно подряд от start до ближайшей занятости или закрытия, в минутах. */
export function freeRun(day, resourceId, startMs) {
  const r = (day.resources ?? []).find((x) => x.id === resourceId);
  const close = ms(day.close_at);
  let end = close;
  for (const b of r?.busy ?? []) {
    const f = ms(b.from);
    const to = ms(b.to);
    if (to <= startMs) continue;
    if (f <= startMs) return 0;
    end = Math.min(end, f);
  }
  return Math.max(0, Math.floor((end - startMs) / MIN));
}

/** Варианты длительности брони: из списка клуба, не дольше свободного окна и max_minutes. */
export function durationsFor(day, resourceId, startMs, options = [60, 90, 120, 180, 240]) {
  const run = freeRun(day, resourceId, startMs);
  const min = day.min_minutes ?? 60;
  const max = Math.min(day.max_minutes ?? 240, run);
  return options.filter((m) => m >= min && m <= max);
}

/** Столы, свободные с start на minutes (для плана зала): Set id. */
export function freeTables(day, startMs, minutes) {
  return new Set((day.resources ?? []).filter((r) => !busyAt(r, startMs, startMs + minutes * MIN)).map((r) => r.id));
}

/**
 * Цена брони поминутно по тарифу дня, округление один раз до рублей «половина вверх» (решение №44, как котировка).
 * @param {{ from: string, to: string, per_hour_kopecks: number }[]} rates
 * @returns {{ amount_kopecks: number, breakdown: { from: number, to: number, per_hour_kopecks: number, amount_kopecks: number }[] } | null}
 */
export function bookingPrice(rates, startMs, minutes) {
  if (!Array.isArray(rates) || !rates.length || !(minutes > 0)) return null;
  const parts = [];
  let exact = 0;
  for (let i = 0; i < minutes; i += 1) {
    const t = startMs + i * MIN;
    const rate = rates.find((r) => ms(r.from) <= t && t < ms(r.to));
    if (!rate) return null;
    const last = parts[parts.length - 1];
    if (last && last.per_hour_kopecks === rate.per_hour_kopecks) {
      last.to = t + MIN;
      last.exact += rate.per_hour_kopecks / 60;
    } else parts.push({ from: t, to: t + MIN, per_hour_kopecks: rate.per_hour_kopecks, exact: rate.per_hour_kopecks / 60 });
    exact += rate.per_hour_kopecks / 60;
  }
  const round = (k) => Math.floor(k / 100 + 0.5) * 100;
  return { amount_kopecks: round(exact), breakdown: parts.map(({ exact: e, ...p }) => ({ ...p, amount_kopecks: round(e) })) };
}

/**
 * Предоплата по правилам клуба: none — без предоплаты, deposit — фиксированная сумма (не больше цены), full — вся цена.
 * @param {{ prepayment?: 'none' | 'deposit' | 'full', deposit_kopecks?: number }} rules
 */
export function prepayFor(rules, amountKopecks) {
  if (!rules || rules.prepayment === 'full') return rules ? amountKopecks : 0;
  if (rules.prepayment === 'deposit') return Math.min(amountKopecks, rules.deposit_kopecks ?? 0);
  return 0;
}

/** Удержание брони после начала: 15 минут без предоплаты, 30 с предоплатой (№107) или как в правилах клуба. */
export function holdMinutes(prepaidKopecks, rules = {}) {
  return prepaidKopecks > 0 ? (rules.hold_prepaid_minutes ?? 30) : (rules.hold_minutes ?? 15);
}

export const BOOKING_WORD = Object.freeze({
  pending_payment: 'Ждёт предоплаты',
  confirmed: 'Подтверждена',
  reserved: 'Стол ждёт вас',
  started: 'Игра началась',
  expired: 'Сгорела',
  canceled: 'Отменена',
});

/** Бронь ещё впереди или идёт удержание — её можно начать, отменить, оплатить. */
export function bookingOpen(b) {
  return ['pending_payment', 'confirmed', 'reserved'].includes(b?.status);
}

/**
 * Мои брони: сначала ближайшие открытые по времени, затем прошедшие — свежие сверху.
 * @param {object[]} list
 */
export function sortBookings(list) {
  const open = list.filter(bookingOpen).sort((a, b) => ms(a.starts_at) - ms(b.starts_at));
  const done = list.filter((b) => !bookingOpen(b)).sort((a, b) => ms(b.starts_at) - ms(a.starts_at));
  return [...open, ...done];
}

/**
 * Условия отмены словами — по полям сервера booking.cancel: { allowed, refund_kopecks, free_until }.
 * @returns {{ allowed: boolean, text: string }}
 */
export function cancelText(booking, { formatMoney, formatTime }) {
  const c = booking?.cancel ?? {};
  const paid = booking?.paid_kopecks ?? 0;
  if (!c.allowed) return { allowed: false, text: 'Бронь уже нельзя отменить.' };
  if (!paid) return { allowed: true, text: 'Предоплаты нет — отмена бесплатная.' };
  const refund = c.refund_kopecks ?? 0;
  if (refund >= paid) {
    return { allowed: true, text: c.free_until ? `До ${formatTime(c.free_until)} предоплата вернётся полностью — ${formatMoney(paid)}.` : `Предоплата вернётся полностью — ${formatMoney(paid)}.` };
  }
  if (refund > 0) return { allowed: true, text: `Вернём ${formatMoney(refund)} из ${formatMoney(paid)} по правилам клуба.` };
  return { allowed: true, text: `Предоплата ${formatMoney(paid)} по правилам клуба не возвращается.` };
}

/**
 * Продление перед бронью или турниром (№106, №146): «Стол забронирован на 21:00, можно продлить до 20:55».
 * Что впереди — по полям сессии или по подсказке экрана (opts.by): next_booking_at — бронь,
 * extend_limit_by: 'tournament' или by: 'tournament' — турнир. Неизвестно (предел сервера учитывает и бронь,
 * и окно турнира) — нейтрально: «Стол занят с 21:00».
 * @param {{ extend_limit_until?: string | null, next_booking_at?: string | null, extend_limit_by?: string | null, unlimited?: boolean }} session
 * @param {(x: number) => string} formatTime
 * @param {{ by?: 'booking' | 'tournament' | null }} [opts]
 * @returns {string | null}
 */
export function extendLimitText(session, formatTime, opts = {}) {
  if (!session || session.unlimited || !session.extend_limit_until) return null;
  const limit = ms(session.extend_limit_until);
  const by = opts.by ?? session.extend_limit_by ?? (session.next_booking_at ? 'booking' : null);
  const at = session.next_booking_at && by === 'booking' ? ms(session.next_booking_at) : limit + 5 * MIN;
  const paid = session.paid_until ? ms(session.paid_until) : null;
  const what = by === 'tournament' ? `На столе турнир с ${formatTime(at)}` : by === 'booking' ? `Стол забронирован на ${formatTime(at)}` : `Стол занят с ${formatTime(at)}`;
  if (paid !== null && limit <= paid) return `${what}, продлить игру нельзя.`;
  return `${what}, можно продлить до ${formatTime(limit)}.`;
}

/**
 * Лист ожидания: оставшиеся секунды предложения (5 минут, №109) и слова о месте в очереди.
 * @param {{ status: string, position?: number, offer_until?: string | null }} entry
 */
/** Причина закрытия или возврата записи очереди (close_reason сервера) словами для гостя. */
export const WAITLIST_NOTE = Object.freeze({
  released: 'Стол отдали гостю у стойки, вы можете снова встать в очередь',
  expired: 'Вы не ответили за 5 минут',
  table_taken: 'Стол успели занять, вы остаётесь в очереди на своём месте',
});

export function waitlistView(entry, now = Date.now()) {
  if (!entry) return { state: 'none', left: 0, text: '', note: null };
  const note = WAITLIST_NOTE[entry.close_reason] ?? null;
  if (entry.status === 'offered') {
    const left = Math.max(0, ms(entry.offer_until) - now);
    return { state: left > 0 ? 'offered' : 'missed', left, text: left > 0 ? 'Стол свободен — он ваш на 5 минут' : 'Время предложения вышло', note: left > 0 ? null : WAITLIST_NOTE.expired };
  }
  if (entry.status === 'waiting') {
    const n = entry.position ?? 1;
    // table_taken: принять не успели — стол заняли, гость остаётся в очереди на своём месте
    return { state: 'waiting', left: 0, text: n <= 1 ? 'Вы первый в очереди' : `Вы ${n}-й в очереди`, note: entry.close_reason === 'table_taken' ? note : null };
  }
  if (entry.status === 'accepted') return { state: 'accepted', left: 0, text: 'Стол ваш', note: null };
  // Истекло (expired) или клуб снял удержание (released, №122) — причина в close_reason
  if (entry.status === 'expired') return { state: 'missed', left: 0, text: 'Предложение закончилось', note: note ?? 'Время вышло или клуб отдал стол гостю у стойки. Можно снова встать в очередь.' };
  return { state: 'none', left: 0, text: '', note: null };
}

/**
 * Котировка с балансом пакета часов (№112, server/payments/quotes.mjs): запрос с use_balance: true возвращает
 * balance_minutes — сколько минут покрыл баланс, balance_available_minutes — сколько было, amount_kopecks — доплата за остальное.
 * @returns {{ usable: boolean, full: boolean, minutes: number, rest: number, available: number }}
 */
export function balanceCover(quote) {
  const minutes = quote?.balance_minutes ?? 0;
  const rest = quote?.amount_kopecks ?? 0;
  const available = quote?.balance_available_minutes ?? 0;
  if (!(minutes > 0)) return { usable: false, full: false, minutes: 0, rest, available };
  return { usable: true, full: rest === 0, minutes, rest, available };
}

/** Телефон для брони по телефону: +7XXXXXXXXXX из «8 (912) 345-67-89», иначе null. */
export function normalizePhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) return `+7${digits.slice(1)}`;
  if (digits.length === 10 && digits[0] === '9') return `+7${digits}`;
  return null;
}

/** Каналы уведомлений сервера (PATCH /api/me): MAX, Telegram, Web Push. */
export const CHANNELS = Object.freeze(['max', 'telegram', 'webpush']);

/**
 * Порядок каналов уведомлений (№110): основной — первым, остальные — в прежнем порядке.
 * @param {string[]} order
 * @param {string} primary
 * @param {string[]} [available] каналы, настроенные на сервере (№126): остальные не показываем
 */
export function channelsOrder(order, primary, available = CHANNELS) {
  const ok = (c) => available.includes(c);
  const all = [...(Array.isArray(order) && order.length ? order : []), ...CHANNELS];
  return [primary, ...all.filter((c) => c !== primary)].filter((c, i, a) => ok(c) && a.indexOf(c) === i);
}

/** Каналы, которые сервер умеет доставлять (№126: user.channels_available); без поля — все. */
export function availableChannels(user) {
  const list = Array.isArray(user?.channels_available) ? user.channels_available.filter((c) => CHANNELS.includes(c)) : CHANNELS;
  return list;
}

/**
 * Основной канал для показа (№126): сохранённый, если сервер его доставляет; иначе первый доступный из уже
 * подключённых (user.channels), иначе просто первый доступный.
 */
export function primaryChannel(user) {
  const available = availableChannels(user);
  if (available.includes(user?.notify_channel)) return user.notify_channel;
  return available.find((c) => user?.channels?.[c]) ?? available[0] ?? null;
}

/** Сдвинуть канал вверх (-1) или вниз (+1) в списке. */
export function moveChannel(order, channel, dir) {
  const i = order.indexOf(channel);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return order;
  const next = order.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}
