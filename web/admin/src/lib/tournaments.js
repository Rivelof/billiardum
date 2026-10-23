/**
 * Турниры клуба (M4, №140): форма создания, доступные действия по статусу, сетка олимпийской системы
 * с посевом по рейтингу. Чистые функции — проверяются в Node; сетку на сервере строит backend-tournaments,
 * здесь — для заглушки и подсказок на экране.
 */
import { DISCIPLINES, roundTitle } from '@billiardum/shared/plus';

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
  };
}

/** Отмена турнира: кому и сколько вернём (взнос целиком всем оплатившим, №140). */
export function cancelRefund(t) {
  const paid = (t?.entries ?? []).filter((e) => e.paid).length;
  return { players: paid, kopecks: paid * (t?.fee_kopecks ?? 0) };
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
