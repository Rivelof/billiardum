// Общее каталога клубов (M4): ошибки, проверка ввода, уведомления платформе, контекст клуба.

import { setContext } from '../lib/store.mjs';
import { safely } from '../bookings/queries.mjs';
import { BookingError } from '../bookings/errors.mjs';

export const DirectoryError = BookingError;
export const fail = (code, detail, status) => {
  throw new DirectoryError(code, detail, status);
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (v) => typeof v === 'string' && UUID.test(v);
export const PHONE = /^\+[1-9][0-9]{7,14}$/;
export const DISCIPLINES = Object.freeze(['pyramid', 'pool', 'snooker']);
export const RESOURCE_DISCIPLINE = Object.freeze({ billiard_pyramid: 'pyramid', billiard_pool: 'pool', billiard_snooker: 'snooker' });
export const iso = (d) => (d ? new Date(d).toISOString() : null);

/** Строка 1..max символов после обрезки или null. */
export function text(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length >= 1 && s.length <= max ? s : null;
}

/** Телефон в E.164 из «8 (912) 345-67-89», «+7 912 …» или null. */
export function phone(v) {
  if (typeof v !== 'string' || v.length > 40) return null;
  const d = v.replace(/[^\d+]/g, '');
  let p = d;
  if (/^8\d{10}$/.test(d)) p = `+7${d.slice(1)}`;
  else if (/^7\d{10}$/.test(d)) p = `+${d}`;
  else if (/^9\d{9}$/.test(d)) p = `+7${d}`;
  return PHONE.test(p) ? p : null;
}

/** Маска телефона: +7912***6789. */
export function maskPhone(p) {
  return typeof p === 'string' && p.length >= 9 ? `${p.slice(0, 5)}***${p.slice(-4)}` : null;
}

/**
 * Необязательный шаг в транзакции (уведомление, данные соседа) в точке сохранения: ошибка не
 * оставляет транзакцию в состоянии ошибки (иначе COMMIT молча станет ROLLBACK).
 */
export { safely };

/** Перейти в контекст клуба (или выйти из него: null) внутри транзакции. */
export async function enterClub(db, clubId) {
  await setContext(db, { clubId: clubId ?? null });
}

/** Получатели уведомлений платформы по роли (core 0710: операторов нет — администраторы). */
export async function platformRecipients(db, role) {
  const { rows } = await db.query('select u as user_id from bl.platform_recipients($1) as u', [role]);
  return rows.map((r) => r.user_id);
}

/**
 * Уведомление сотрудникам платформы (оператор — заявки и модерация, администратор — leads).
 * Возвращает число получателей; нет получателей — предупреждение в лог (заявка всё равно видна
 * на экране оператора).
 */
export async function notifyPlatform(db, deps, log, role, msg) {
  const ids = await safely(db, () => platformRecipients(db, role), { fallback: [], log, what: 'platform_recipients' });
  for (const id of ids) await safely(db, () => deps.notify.send(db, id, msg), { log, what: `notify:${msg.kind}` });
  if (ids.length === 0) log?.warn?.('platform_notify_unrouted', { role, kind: msg.kind });
  return ids.length;
}

export async function notifyUser(db, deps, log, userId, msg) {
  if (!isUuid(userId)) return null;
  return safely(db, () => deps.notify.send(db, userId, msg), { log, what: `notify:${msg.kind}` });
}

/** Карточка по id (видимая или своя/платформы — RLS). */
export async function loadCard(db, id) {
  if (!isUuid(id)) return null;
  const { rows } = await db.query(
    `select p.*, c.slug as city_slug, c.name as city_name, c.timezone as city_timezone
       from bl.club_public p join bl.cities c on c.id = p.city_id where p.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
