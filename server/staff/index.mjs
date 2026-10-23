// Персонал клуба (контракт M3 §1 п. 9, §4; decisions №111). Только владелец.
//
// * Приглашение по телефону с ролью на 7 дней; привязывается при первом входе с этим номером
//   (acceptInvites из server/auth, функция bl.staff_accept_invites).
// * Смена роли; отзыв доступа в один шаг: членство гаснет, PIN стирается, PIN-токены клуба
//   отзываются, личные — если других членств нет (bl.staff_revoke); терминалы клуба,
//   заведённые сотрудником, отзываются.
// * Каждое действие — в журнал клуба: staff.invite, staff.invite_revoked, staff.invite_accepted,
//   staff.role, staff.revoke. Телефоны наружу — только маской.

import { maskPhone, normalizePhone } from '../auth/index.mjs';
import { HttpError } from '../http/errors.mjs';
import { appendAudit } from '../lib/audit.mjs';
import { setContext } from '../lib/store.mjs';

export const INVITE_TTL_MS = 7 * 24 * 3600_000;
export const INVITE_ROLES = ['manager', 'reception', 'installer', 'bar'];

const iso = (v) => (v instanceof Date ? v.toISOString() : v);

function inviteJson(r) {
  return { id: r.id, phone_masked: maskPhone(r.phone), role: r.role, created_at: iso(r.created_at), expires_at: iso(r.expires_at) };
}

/** Сотрудники и открытые приглашения клуба из контекста. */
export async function listStaff(db, { now }) {
  const staff = await db.query(
    `select m.user_id, m.role, m.active, m.pin_hash is not null as pin_set, u.name, u.phone
       from bl.club_members m join bl.users u on u.id = m.user_id
      order by m.active desc, m.role, u.name nulls last, m.user_id`,
  );
  const invites = await db.query(
    `select id, phone, role, created_at, expires_at from bl.staff_invites
      where accepted_at is null and revoked_at is null and expires_at > $1
      order by created_at desc`,
    [now],
  );
  return {
    staff: staff.rows.map((r) => ({ user_id: r.user_id, name: r.name, phone_masked: maskPhone(r.phone), role: r.role, active: r.active, pin_set: r.pin_set })),
    invites: invites.rows.map(inviteJson),
  };
}

/** Роль в тексте приглашения (M5.1 №158): «на роль …». */
export const ROLE_TITLES = Object.freeze({ manager: 'управляющего', reception: 'администратора ресепшена', installer: 'монтажника', bar: 'бармена' });

/**
 * Ссылка и текст приглашения (M5.1 №158): SMS-провайдера нет, владелец пересылает текст сам
 * («Скопировать» или «Поделиться»). Вход — /club/ по телефону, на который выписано приглашение;
 * сам телефон в текст не попадает. publicHost — хост без схемы (PUBLIC_HOST).
 */
export function inviteMessage({ clubName, role, publicHost, expiresAt, timezone = 'Europe/Moscow' }) {
  if (!/^[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(String(publicHost ?? ''))) throw new Error('inviteMessage: publicHost');
  const url = `https://${publicHost}/club/`;
  const until = expiresAt ? ` до ${new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: timezone }).format(new Date(expiresAt))}` : '';
  const name = String(clubName ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const text =
    `Вас пригласили в программу клуба «${name}» на роль ${ROLE_TITLES[role] ?? 'сотрудника'}. ` +
    `Откройте ссылку и войдите по номеру телефона, на который пришло это приглашение: ${url} ` +
    `Приглашение действует${until || ' 7 дней'}.`;
  return { invite_url: url, invite_text: text };
}

/** Пригласить по телефону с ролью. Повторное приглашение того же номера продлевает и меняет роль. */
export async function invite(db, { clubId, phone, role, byUserId, now, publicHost = null }) {
  const e164 = typeof phone === 'string' ? normalizePhone(phone) : null;
  if (!e164 || !phone.trim().startsWith('+')) throw new HttpError(400, 'bad_request', { detail: 'phone' });
  if (!INVITE_ROLES.includes(role)) throw new HttpError(400, 'bad_request', { detail: 'role' });
  const member = await db.query(
    'select m.active from bl.club_members m join bl.users u on u.id = m.user_id where u.phone = $1 and m.active',
    [e164],
  );
  if (member.rowCount > 0) throw new HttpError(409, 'duplicate', { detail: 'already staff' });
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  const open = await db.query(
    `select id from bl.staff_invites where phone = $1 and accepted_at is null and revoked_at is null for update`,
    [e164],
  );
  let row;
  if (open.rowCount > 0) {
    row = (
      await db.query('update bl.staff_invites set role = $2, expires_at = $3 where id = $1 returning *', [open.rows[0].id, role, expiresAt])
    ).rows[0];
  } else {
    row = (
      await db.query(
        `insert into bl.staff_invites (club_id, phone, role, invited_by, created_at, expires_at)
         values ($1, $2, $3, $4, $5, $6) returning *`,
        [clubId, e164, role, byUserId, now, expiresAt],
      )
    ).rows[0];
  }
  await appendAudit(db, {
    action: 'staff.invite',
    objectType: 'staff_invite',
    objectId: row.id,
    actorType: 'user',
    actorId: byUserId,
    data: { invite_id: row.id, role, phone_masked: maskPhone(e164), expires_at: iso(row.expires_at) },
  });
  if (!publicHost) return inviteJson(row);
  const club = (await db.query('select name, timezone from bl.clubs where id = $1', [clubId])).rows[0];
  return { ...inviteJson(row), ...inviteMessage({ clubName: club?.name ?? '', role, publicHost, expiresAt: row.expires_at, timezone: club?.timezone }) };
}

export async function revokeInvite(db, { inviteId, byUserId, now }) {
  const { rows } = await db.query(
    'update bl.staff_invites set revoked_at = $2 where id = $1 and accepted_at is null and revoked_at is null returning id, role',
    [inviteId, now],
  );
  if (rows.length === 0) throw new HttpError(404, 'not_found');
  await appendAudit(db, {
    action: 'staff.invite_revoked',
    objectType: 'staff_invite',
    objectId: inviteId,
    actorType: 'user',
    actorId: byUserId,
    data: { invite_id: inviteId, role: rows[0].role },
  });
  return { ok: true };
}

async function memberForChange(db, { userId, byUserId }) {
  if (userId === byUserId) throw new HttpError(403, 'forbidden', { detail: 'self' });
  const { rows } = await db.query('select role, active from bl.club_members where user_id = $1 for update', [userId]);
  const m = rows[0];
  if (!m || !m.active) throw new HttpError(404, 'not_found');
  if (m.role === 'owner') throw new HttpError(403, 'forbidden', { detail: 'owner' });
  return m;
}

export async function changeRole(db, { userId, role, byUserId }) {
  if (!INVITE_ROLES.includes(role)) throw new HttpError(400, 'bad_request', { detail: 'role' });
  const m = await memberForChange(db, { userId, byUserId });
  if (m.role !== role) {
    await db.query('update bl.club_members set role = $2 where user_id = $1', [userId, role]);
    await appendAudit(db, {
      action: 'staff.role',
      objectType: 'user',
      objectId: userId,
      actorType: 'user',
      actorId: byUserId,
      data: { user_id: userId, from: m.role, to: role },
    });
  }
  return { ok: true, user_id: userId, role };
}

/**
 * Отозвать доступ: членство, PIN, PIN-токены клуба, личные токены — если других членств нет
 * (bl.staff_revoke, №130 п. 11); терминалы клуба, заведённые сотрудником, — тоже (ревью входа п. 5).
 */
export async function revoke(db, { userId, byUserId, now = new Date() }) {
  const m = await memberForChange(db, { userId, byUserId });
  const tokens = (await db.query('select bl.staff_revoke($1) as n', [userId])).rows[0].n;
  const terminals = (
    await db.query('update bl.staff_terminals set revoked_at = $2 where created_by = $1 and revoked_at is null returning id', [userId, now])
  ).rows.map((r) => r.id);
  await appendAudit(db, {
    action: 'staff.revoke',
    objectType: 'user',
    objectId: userId,
    actorType: 'user',
    actorId: byUserId,
    data: { user_id: userId, role: m.role, tokens_revoked: tokens ?? 0, terminals_revoked: terminals },
  });
  return { ok: true, tokens_revoked: tokens ?? 0, terminals_revoked: terminals.length };
}

/**
 * При входе: привязать приглашения на номер пользователя (контекст переключается в личный
 * и по клубам и возвращается в личный). Возвращает [{club_id, role}].
 */
export async function acceptInvites(db, userId) {
  await setContext(db, { clubId: null, userId });
  const { rows } = await db.query('select * from bl.staff_accept_invites()');
  for (const r of rows) {
    await setContext(db, { clubId: r.club_id });
    await appendAudit(db, {
      action: 'staff.invite_accepted',
      objectType: 'staff_invite',
      objectId: r.invite_id,
      actorType: 'user',
      actorId: userId,
      data: { invite_id: r.invite_id, role: r.role },
    });
  }
  await setContext(db, { clubId: null });
  return rows.map((r) => ({ club_id: r.club_id, role: r.role }));
}
