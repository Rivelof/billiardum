/**
 * Турниры клуба (M4, №140): форма создания, доступные действия по статусу, сетка олимпийской системы
 * с посевом по рейтингу. Чистые функции — проверяются в Node; сетку на сервере строит backend-tournaments,
 * здесь — для заглушки и подсказок на экране.
 */
import { DISCIPLINES, roundTitle } from '@billiardum/shared/plus';
import { CANCEL_REFUND_CODES, LATE_REFUND_REASONS } from '@billiardum/shared/reasons';

export const FORMATS = ['single_elim', 'groups_playoff'];

/**
 * Ошибки формы турнира по полям (пусто — можно сохранять).
 * @param {{ title, discipline, format, race_to, rating_limit, fee_rub, places, starts_at, ends_at, resource_ids }} f
 */
export function tournamentErrors(f, now = Date.now()) {
  const e = {};
  if (!String(f.title ?? '').trim() || String(f.title).trim().length > 80) e.title = 'Название — до 80 знаков.';
  if (!DISCIPLINES.includes(f.discipline)) e.discipline = 'Выберите дисциплину.';
  if (!FORMATS.includes(f.format)) e.format = 'Выберите формат.';
  const race = Number(f.race_to);
  if (!Number.isInteger(race) || race < 1 || race > 15) e.race_to = 'До скольких побед — от 1 до 15.';
  if (f.rating_limit !== '' && f.rating_limit !== null && f.rating_limit !== undefined) {
    const r = Number(f.rating_limit);
    if (!Number.isInteger(r) || r < 800 || r > 3000) e.rating_limit = 'Лимит рейтинга — от 800 до 3 000 или пусто.';
  }
  const fee = Number(String(f.fee_rub ?? '0').replace(',', '.'));
  if (!Number.isFinite(fee) || fee < 0 || fee > 100000) e.fee_rub = 'Взнос — от 0 до 100 000 ₽.';
  const places = Number(f.places);
  if (!Number.isInteger(places) || places < 4 || places > 128) e.places = 'Мест — от 4 до 128.';
  const s = Date.parse(f.starts_at);
  const en = Date.parse(f.ends_at);
  if (!Number.isFinite(s) || s < now) e.starts_at = 'Начало — в будущем.';
  if (!Number.isFinite(en) || !(en > s)) e.ends_at = 'Конец — позже начала.';
  if (!Array.isArray(f.resource_ids) || !f.resource_ids.length) e.resource_ids = 'Выберите хотя бы один стол — он будет заблокирован на время матчей.';
  return e;
}

/**
 * Тело POST /api/clubs/{club}/tournaments из формы: деньги — копейками, лимит — число или null.
 * publish: true — сразу открыть запись (иначе сервер создаёт черновик draft, его видит только клуб).
 */
export function tournamentBody(f, { publish = true } = {}) {
  const fee = Math.round(Number(String(f.fee_rub ?? '0').replace(',', '.')) * 100);
  return {
    title: String(f.title).trim(),
    discipline: f.discipline,
    format: f.format,
    race_to: Number(f.race_to),
    rating_limit: f.rating_limit === '' || f.rating_limit === null || f.rating_limit === undefined ? null : Number(f.rating_limit),
    fee_kopecks: fee,
    prize_text: String(f.prize_text ?? '').trim(),
    places: Number(f.places),
    starts_at: new Date(f.starts_at).toISOString(),
    ends_at: new Date(f.ends_at).toISOString(),
    resource_ids: [...f.resource_ids],
    publish,
  };
}

/** Турнир начат: сетка построена, столы заняты (№147, №149 — после старта другие правила времени и взносов). */
export function isStarted(t) {
  return t?.status === 'running' || t?.status === 'finished' || Boolean(t?.started_at);
}

/** Какие действия доступны организатору по статусу турнира. */
export function tournamentActions(t) {
  const s = t?.status;
  return {
    publish: s === 'draft',
    closeEntry: s === 'registration',
    openEntry: s === 'closed',
    start: (s === 'registration' || s === 'closed') && (t.entries_count ?? t.entries?.length ?? 0) >= 2,
    cancel: s === 'draft' || s === 'registration' || s === 'closed' || s === 'running',
    fixScore: s === 'running' || s === 'finished',
    // Правка названия и призов — пока турнир не завершён; время — только до старта (после — «Продлить турнир»)
    edit: s === 'draft' || s === 'registration' || s === 'closed' || s === 'running',
    extend: s === 'running',
  };
}

/** Сколько заплатил игрок: paid_kopecks из ответа, иначе взнос турнира у оплатившего. */
export function paidOf(t, e) {
  if (Number.isSafeInteger(e?.paid_kopecks)) return e.paid_kopecks;
  return e?.paid ? (t?.fee_kopecks ?? 0) : 0;
}

/** Взнос ещё у клуба: оплачен и возврат не начат. */
const refundableEntry = (t, e) => e?.status !== 'canceled' && paidOf(t, e) > 0 && (e.refund_status ?? 'none') === 'none';

/**
 * Отмена турнира: кому и сколько вернём. До старта — всем оплатившим целиком (№138); после старта —
 * только с «Вернуть взносы всем» по аварии (№149), иначе никому.
 * @param {object} t турнир с entries
 * @param {{ refundAll?: boolean }} [opts]
 */
export function cancelRefund(t, { refundAll = false } = {}) {
  if (isStarted(t) && !refundAll) return { players: 0, kopecks: 0 };
  const list = (t?.entries ?? []).filter((e) => refundableEntry(t, e));
  return { players: list.length, kopecks: list.reduce((a, e) => a + paidOf(t, e), 0) };
}

/** Причины, с которыми при отмене после старта можно вернуть взносы всем: только авария (№149). */
export const CANCEL_REFUND_REASONS = LATE_REFUND_REASONS.filter((r) => CANCEL_REFUND_CODES.includes(r.code));

/**
 * Ошибки формы отмены. reason — комментарий (всегда обязателен); после старта с возвратом всем — и код аварии.
 * @param {{ started: boolean, reason: string, refundAll?: boolean, reasonCode?: string | null }} f
 */
export function cancelErrors(f) {
  const e = {};
  if (String(f.reason ?? '').trim().length < 3) e.reason = f.started && f.refundAll ? 'Опишите, что случилось, — комментарий увидят игроки и владелец.' : 'Напишите причину — её увидят игроки и владелец.';
  if (f.started && f.refundAll && !CANCEL_REFUND_CODES.includes(f.reasonCode)) e.reason_code = 'Выберите, что случилось: поломка оборудования или авария в клубе.';
  return e;
}

/** Тело POST …/cancel: до старта — { reason }; после — с refund 'none' или 'all' и кодом аварии. */
export function cancelBody(f) {
  const reason = String(f.reason ?? '').trim();
  if (!f.started) return { reason };
  return f.refundAll ? { reason, refund: 'all', reason_code: f.reasonCode } : { reason, refund: 'none' };
}

/** Можно ли вернуть взнос одному игроку: турнир начат, игрок платил, возврат ещё не оформлен (№149). */
export function canRefundEntry(t, e) {
  return t?.status === 'running' && refundableEntry(t, e);
}

/** Ошибки формы возврата одному игроку: код из закрытого списка и комментарий. */
export function entryRefundErrors(f) {
  const e = {};
  if (!LATE_REFUND_REASONS.some((r) => r.code === f.reasonCode)) e.reason_code = 'Выберите причину из списка.';
  if (String(f.comment ?? '').trim().length < 3) e.comment = 'Напишите, что случилось, — комментарий увидит владелец.';
  return e;
}

/** Оплата и возврат участника словами: статус не только цветом. */
export function entryPayWord(t, e) {
  if (!t?.fee_kopecks && !paidOf(t, e)) return { word: 'бесплатно', tone: 'off' };
  if (e.refund_status === 'done') return { word: 'взнос возвращён', tone: 'off' };
  if (e.refund_status === 'pending') return { word: 'возврат оформляется', tone: 'pending' };
  if (e.status === 'canceled') return { word: 'запись отменена', tone: 'off' };
  return paidOf(t, e) > 0 ? { word: 'оплачен', tone: 'ok' } : { word: 'ждём оплату', tone: 'pending' };
}

export const EXTEND_MATCH_MIN = 10;
export const EXTEND_MATCH_MAX = 240;
/** Подсказка: дальше этого от текущего момента сервер не продлит (№147); точный предел — в ответе 409. */
export const EXTEND_AHEAD_MS = 12 * 3600000;

/**
 * Ошибки формы продления идущего турнира (POST …/extend).
 * @param {{ ends_at: string, match_minutes: string | number, reason: string }} f ends_at — ISO
 * @param {{ ends_at: string, match_minutes?: number }} t текущее окно
 */
export function extendErrors(f, t, now = Date.now()) {
  const e = {};
  const end = Date.parse(f.ends_at);
  const curEnd = Date.parse(t?.ends_at);
  const mm = Number(f.match_minutes);
  const curMm = Number.isInteger(t?.match_minutes) ? t.match_minutes : null;
  if (!Number.isFinite(end)) e.ends_at = 'Укажите время конца.';
  else if (end <= now) e.ends_at = 'Конец — позже текущего времени.';
  else if (end > now + EXTEND_AHEAD_MS) e.ends_at = 'Не дальше 12 часов от текущего момента.';
  if (f.match_minutes !== '' && f.match_minutes !== null && f.match_minutes !== undefined) {
    const max = Math.max(EXTEND_MATCH_MAX, curMm ?? 0);
    if (!Number.isInteger(mm) || mm < EXTEND_MATCH_MIN || mm > max) e.match_minutes = `Время матча — от ${EXTEND_MATCH_MIN} до ${max} минут.`;
  }
  const sameEnd = Number.isFinite(end) && end === curEnd;
  const sameMm = f.match_minutes === '' || f.match_minutes === null || f.match_minutes === undefined || mm === curMm;
  if (!e.ends_at && !e.match_minutes && sameEnd && sameMm) e.ends_at = 'Ничего не меняется: укажите новый конец или время матча.';
  if (String(f.reason ?? '').trim().length < 3) e.reason = 'Напишите причину — её увидит владелец, продление попадёт в журнал.';
  return e;
}

/** Тело POST …/extend: только изменённые поля и причина. */
export function extendBody(f, t) {
  const out = { reason: String(f.reason ?? '').trim() };
  const end = Date.parse(f.ends_at);
  if (Number.isFinite(end) && end !== Date.parse(t?.ends_at)) out.ends_at = new Date(end).toISOString();
  const mm = Number(f.match_minutes);
  if (f.match_minutes !== '' && f.match_minutes !== null && f.match_minutes !== undefined && mm !== t?.match_minutes) out.match_minutes = mm;
  return out;
}

/**
 * Правка турнира (PATCH): до старта — название, призы, места и время; после старта (№147) — только
 * название и призы, время не отправляем вовсе (иначе 409 tournament_started).
 * @param {{ title: string, prize_text: string, places: string, starts_at: string, ends_at: string }} f
 */
export function editBody(f, t) {
  const out = {};
  const title = String(f.title ?? '').trim();
  if (title && title !== t.title) out.title = title;
  const prize = String(f.prize_text ?? '').trim();
  if (prize !== (t.prize_text ?? '')) out.prize_text = prize;
  if (isStarted(t)) return out;
  const places = Number(f.places);
  if (Number.isInteger(places) && places !== t.places) out.places = places;
  for (const k of ['starts_at', 'ends_at']) {
    const v = Date.parse(f[k]);
    if (Number.isFinite(v) && v !== Date.parse(t[k])) out[k] = new Date(v).toISOString();
  }
  return out;
}

/** Ошибки правки: название, места не меньше записавшихся, конец позже начала (до старта). */
export function editErrors(f, t) {
  const e = {};
  const title = String(f.title ?? '').trim();
  if (!title || title.length > 80) e.title = 'Название — до 80 знаков.';
  if (isStarted(t)) return e;
  const places = Number(f.places);
  const taken = t.entries_count ?? 0;
  if (!Number.isInteger(places) || places < Math.max(4, taken) || places > 128) e.places = `Мест — от ${Math.max(4, taken)} до 128.`;
  const s = Date.parse(f.starts_at);
  const en = Date.parse(f.ends_at);
  if (!Number.isFinite(s)) e.starts_at = 'Укажите начало.';
  if (!Number.isFinite(en) || !(en > s)) e.ends_at = 'Конец — позже начала.';
  return e;
}

/**
 * Сетка олимпийской системы: посев по рейтингу (1 — с последним), свободные проходы у сильнейших.
 * @param {{ nick: string, rating: number, user_id?: string }[]} players
 * @returns {{ rounds: { title: string, matches: object[] }[] }}
 */
export function seedBracket(players, { tables = [] } = {}) {
  const seeded = [...players].sort((a, b) => b.rating - a.rating).map((p, i) => ({ ...p, seed: i + 1 }));
  let size = 2;
  while (size < seeded.length) size *= 2;
  const order = seedOrder(size);
  const slot = (n) => seeded[n - 1] ?? null;
  const rounds = [];
  const first = [];
  for (let i = 0; i < size; i += 2) {
    const a = slot(order[i]);
    const b = slot(order[i + 1]);
    const bye = !a || !b;
    first.push({
      id: `r0m${i / 2}`,
      table_number: bye ? null : (tables[(i / 2) % Math.max(1, tables.length)] ?? null),
      a: a && { nick: a.nick, seed: a.seed },
      b: b && { nick: b.nick, seed: b.seed },
      score_a: null,
      score_b: null,
      status: bye ? 'done' : 'scheduled',
      winner: bye ? (a ? 'a' : b ? 'b' : null) : null,
    });
  }
  rounds.push({ title: roundTitle(first.length), matches: first });
  let n = first.length / 2;
  let r = 1;
  while (n >= 1) {
    rounds.push({ title: roundTitle(n), matches: Array.from({ length: n }, (_, i) => ({ id: `r${r}m${i}`, table_number: null, a: null, b: null, score_a: null, score_b: null, status: 'scheduled', winner: null })) });
    n /= 2;
    r += 1;
  }
  return advance({ rounds });
}

/** Порядок посева для сетки размера size: 1–8, 4–5, 2–7, 3–6 … (сильнейшие встречаются в финале). */
export function seedOrder(size) {
  let order = [1, 2];
  while (order.length < size) {
    const n = order.length * 2 + 1;
    order = order.flatMap((s) => [s, n - s]);
  }
  return order;
}

/** Провести победителей в следующий круг (после проходов и исправлений счёта). */
export function advance(bracket) {
  const rounds = bracket.rounds.map((r) => ({ ...r, matches: r.matches.map((m) => ({ ...m })) }));
  for (let r = 0; r < rounds.length - 1; r += 1) {
    rounds[r].matches.forEach((m, i) => {
      const next = rounds[r + 1].matches[Math.floor(i / 2)];
      const side = i % 2 === 0 ? 'a' : 'b';
      const w = m.winner === 'a' ? m.a : m.winner === 'b' ? m.b : null;
      if (w && !next[side]) next[side] = w;
    });
  }
  return { rounds };
}

/** Записать счёт матча (организатор или подтверждённый игроками): победитель — у кого raceTo. */
export function applyScore(bracket, matchId, scoreA, scoreB) {
  const rounds = bracket.rounds.map((r) => ({ ...r, matches: r.matches.map((m) => (m.id === matchId ? { ...m, score_a: scoreA, score_b: scoreB, status: 'done', winner: scoreA > scoreB ? 'a' : 'b' } : { ...m })) }));
  return advance({ rounds });
}

/** Матчи, которые сейчас играются или ждут стола, — для ТВ «Сейчас играют». */
export function liveMatches(bracket) {
  const out = [];
  for (const r of bracket?.rounds ?? []) for (const m of r.matches) if (m.a && m.b && ['playing', 'pending_confirm', 'disputed'].includes(m.status)) out.push({ ...m, round: r.title });
  return out;
}

/** Победитель турнира, когда финал сыгран. */
export function champion(bracket) {
  const final = bracket?.rounds?.at(-1)?.matches?.[0];
  if (!final || final.status !== 'done') return null;
  return final.winner === 'a' ? final.a : final.winner === 'b' ? final.b : null;
}
