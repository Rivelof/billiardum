/**
 * Бильярдум+ и турниры гостя (M4): чистые функции экранов — проверяются в Node.
 */
import { levelOf } from '@billiardum/shared/plus';

/** Пояс для дат: клуба, если известен, иначе устройства. */
export function zoneOf(...candidates) {
  for (const z of candidates) if (typeof z === 'string' && z) return z;
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow';
}

/** Сезон — календарный месяц по Москве (№137): '2026-10'. */
export function seasonNow(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit' }).formatToParts(now);
  return `${parts.find((p) => p.type === 'year').value}-${parts.find((p) => p.type === 'month').value}`;
}

/** Рейтинг дисциплины из профиля; нет партий — стартовые 1 200. */
export function ratingIn(profile, discipline) {
  const r = profile?.ratings?.find((x) => x.discipline === discipline);
  return r ? r : { discipline, rating: 1200, games: 0, level: levelOf(1200).code, season_rating: 1200 };
}

/** Дисциплина партии по типу стола: пул — пул, снукер — снукер, остальное — пирамида. */
export function disciplineOfTable(type) {
  if (/snooker/i.test(type ?? '')) return 'snooker';
  if (/pool/i.test(type ?? '')) return 'pool';
  return 'pyramid';
}

/** Соперники для «Партии»: участники сессии кроме меня, у кого есть user_id. */
export function opponents(session, meId) {
  return (session?.participants ?? []).filter((p) => p.user_id && p.user_id !== meId).map((p, i) => ({ user_id: p.user_id, nick: p.nick ?? p.label ?? `Игрок ${i + 1}` }));
}

/** Партии, где ждут моего подтверждения, — первыми. */
export function sortMatches(items, meId) {
  const needMe = (m) => m.status === 'pending' && m.players?.some((p) => p.user_id === meId && !p.confirmed);
  return [...(items ?? [])].sort((a, b) => Number(needMe(b)) - Number(needMe(a)) || String(b.played_at ?? b.created_at ?? '').localeCompare(String(a.played_at ?? a.created_at ?? '')));
}

/** Моя сторона и соперник в партии. */
export function sides(match, meId) {
  const me = match?.players?.find((p) => p.user_id === meId) ?? match?.players?.[0];
  const them = match?.players?.find((p) => p !== me) ?? null;
  return { me, them };
}

/**
 * Состояние записи на турнир для экрана: что показать и какую кнопку.
 * @returns {'closed' | 'open' | 'pending_payment' | 'entered' | 'full'}
 */
export function entryState(t, mine) {
  const e = mine?.entry;
  if (e?.status === 'confirmed') return 'entered';
  if (e?.status === 'pending_payment') return 'pending_payment';
  if (t?.status !== 'registration') return 'closed';
  if (Number.isInteger(t?.places) && t.entries_count >= t.places) return 'full';
  return 'open';
}

/** Мест осталось: «осталось 3 места из 16». */
export function placesLeft(t) {
  if (!Number.isInteger(t?.places)) return null;
  return Math.max(0, t.places - (t.entries_count ?? 0));
}

/** Фильтр афиши турниров. */
export function filterTournaments(items, filter) {
  const list = items ?? [];
  if (filter === 'open') return list.filter((t) => t.status === 'registration');
  if (filter === 'live') return list.filter((t) => t.status === 'running');
  if (filter === 'past') return list.filter((t) => ['finished', 'canceled'].includes(t.status));
  return list.filter((t) => !['finished', 'canceled'].includes(t.status));
}

/** Статус заявки в клуб без программы (T25) словами. */
export const REQUEST_STATUS = {
  sent: { title: 'Заявка отправлена в клуб', text: 'Клуб получил её в мессенджер. Обычно отвечают за несколько минут — эта страница обновится сама.', tone: 'pending', step: 1 },
  operator: { title: 'Клуб пока не ответил — подключили оператора', text: 'Через 15 минут без ответа заявка ушла оператору Бильярдума: он позвонит в клуб и напишет вам.', tone: 'pending', step: 2 },
  accepted: { title: 'Клуб принял заявку', text: 'Стол ждёт вас. Если планы изменятся — позвоните в клуб.', tone: 'free', step: 3 },
  declined: { title: 'Клуб не сможет принять', text: 'На это время мест нет. Попробуйте другое время или другой клуб.', tone: 'alert', step: 3 },
  closed: { title: 'Заявка закрыта', text: 'Если нужен стол — отправьте новую заявку.', tone: 'off', step: 3 },
};

/** Длина текста отзыва и маскирование телефонов перед отправкой (сервер маскирует тоже, №141). */
export const REVIEW_MAX = 1000;
export function maskPhones(text) {
  return String(text ?? '').replace(/\+?\d[\d\s()-]{8,}\d/g, (m) => (m.replace(/\D/g, '').length >= 10 ? '***' : m));
}
