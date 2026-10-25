// Сети клубов (M5.5, docs/contracts/m5-5-8.md №190, №192, №194): сеть владельца, клубы сети,
// управляющие сети. Шаблоны тарифов и меню — templates.mjs, сравнение клубов — compare.mjs.
//
// Маршруты сети работают в личном контексте пользователя (app.club_id пуст): сеть видят её
// владелец и принятые управляющие (bl.network_access). Состав сети и управляющие меняются только
// узкими функциями базы (bl.network_add_club и т. д.): владение клубом и сетью проверяет база.
// В клуб сервер входит ctx.useClub(club): RLS по club_id — как у любого запроса клуба.
//
// Журнал: у сети своей цепочки нет — запись идёт в цепочку каждого клуба, которого касается
// действие: network.club_added, network.club_removed, network.updated, network.manager_invited,
// network.manager_added, network.manager_revoked, network.archived (и шаблоны — templates.mjs).

import { maskPhone, normalizePhone } from '../auth/index.mjs';
import { HttpError } from '../http/errors.mjs';
import { appendAudit } from '../lib/audit.mjs';
import { setContext } from '../lib/store.mjs';
import { INVITE_TTL_MS } from '../staff/index.mjs';

export const MODES = ['hard', 'soft'];
export const NETWORKS_LIMIT = 5;
export const CLUBS_LIMIT = 100;

const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);

/** Ошибка узкой функции сети → HTTP. */
export function networkDbError(err) {
  switch (err?.code) {
    case 'BLN01':
      return new HttpError(403, 'forbidden', { detail: 'not owner of the club' });
    case 'BLN02':
      return new HttpError(409, 'club_in_network', { detail: 'club is in another network' });
    case 'BLN03':
      return new HttpError(404, 'not_found', { detail: 'network' });
    case 'BLN04':
      return new HttpError(409, 'networks_limit', { detail: `не больше ${CLUBS_LIMIT} клубов в сети` });
    case 'BLN05':
      return new HttpError(409, 'networks_limit', { detail: `не больше ${NETWORKS_LIMIT} сетей` });
    case 'BLN06':
      return new HttpError(409, 'duplicate', { detail: 'already manager' });
    case 'BLN07':
      return new HttpError(404, 'not_found', { detail: 'member' });
    case 'BLN10':
      return new HttpError(409, 'network_locked', { detail: 'network manager' });
    case '22023':
      return new HttpError(400, 'bad_request', { detail: err.message });
    case '42501':
      return new HttpError(403, 'forbidden', { detail: err.message });
    default:
      return err;
  }
}

/** Вызов узкой функции в точке сохранения: ошибка — HTTP, транзакция не ломается. */
export async function callDb(db, sql, params) {
  await db.query('savepoint bl_network_call');
  try {
    const res = await db.query(sql, params);
    await db.query('release savepoint bl_network_call');
    return res;
  } catch (err) {
    await db.query('rollback to savepoint bl_network_call');
    throw networkDbError(err);
  }
}

/** Только личный вход (не PIN терминала клуба): сеть — дело владельца и управляющих. */
export function requireSession(ctx) {
  if (ctx.principal?.kind !== 'session') throw new HttpError(403, 'forbidden', { detail: 'personal login required' });
}

/**
 * Доступ к сети в личном контексте: 'owner' | 'manager'; нет доступа (или сети нет) — 404.
 * want — 'owner': управляющему 403.
 */
export async function networkAccess(ctx, networkId, { want = null } = {}) {
  requireSession(ctx);
  await ctx.useClub(null);
  const { rows } = await ctx.db.query('select bl.network_access($1) as a', [networkId]);
  const access = rows[0]?.a ?? null;
  if (access !== 'owner' && access !== 'manager') throw new HttpError(404, 'not_found', { detail: 'network' });
  if (want === 'owner' && access !== 'owner') throw new HttpError(403, 'forbidden', { detail: 'network owner only' });
  return access;
}

/** Строка сети (личный контекст, RLS). */
export async function loadNetwork(db, networkId) {
  const { rows } = await db.query(
    `select id, owner_user_id, name, tariffs_mode, menu_mode, tariffs_template, tariffs_version, menu_template, menu_version, created_at, updated_at
       from bl.networks where id = $1 and archived_at is null`,
    [networkId],
  );
  if (!rows[0]) throw new HttpError(404, 'not_found', { detail: 'network' });
  return rows[0];
}

/** Активные клубы сети (личный контекст: владелец и управляющие видят строки сети; клубы — как участники). */
export async function networkClubs(db, networkId) {
  const { rows } = await db.query(
    `select nc.club_id, nc.tariffs_override, nc.tariffs_version, nc.menu_version, nc.added_at, c.name, c.city, c.timezone, c.mode, c.mode_before_suspend, c.settings
       from bl.network_clubs nc left join bl.clubs c on c.id = nc.club_id
      where nc.network_id = $1 and nc.active
      order by c.name nulls last, nc.club_id`,
    [networkId],
  );
  return rows;
}

/** Войти в клуб сети и проверить роль; owner — только владелец клуба. Возвращает роли. */
export async function enterNetworkClub(ctx, clubId, roles = ['owner', 'manager']) {
  const got = await ctx.useClub(clubId);
  if (!got.some((r) => roles.includes(r))) throw new HttpError(403, 'forbidden', { detail: 'club role' });
  return got;
}

/** Запись журнала в цепочку каждого клуба из clubIds (контекст после — личный). */
async function auditClubs(ctx, clubIds, entry) {
  for (const clubId of clubIds) {
    await ctx.useClub(clubId);
    await appendAudit(ctx.db, { actorType: 'user', actorId: ctx.user.id, objectType: 'network', ...entry });
  }
  await ctx.useClub(null);
}

const dayStartOf = (settings) => (typeof settings?.day_start_local === 'string' && /^\d{2}:\d{2}$/.test(settings.day_start_local) ? settings.day_start_local : '06:00');

function clubJson(c) {
  return {
    club_id: c.club_id,
    name: c.name ?? null,
    city: c.city ?? null,
    timezone: c.timezone ?? null,
    day_start_local: dayStartOf(c.settings),
    mode: c.mode ?? null,
    tariffs_override: c.tariffs_override,
    tariffs_version: c.tariffs_version,
    menu_version: c.menu_version,
    added_at: iso(c.added_at),
  };
}

/** Сеть для ответа API. */
export async function networkJson(ctx, networkId, access) {
  const n = await loadNetwork(ctx.db, networkId);
  const clubs = await networkClubs(ctx.db, networkId);
  const plan = (await ctx.db.query("select id, code, title, price_per_table_kopecks, active from bl.billing_plans where code = 'network'")).rows[0] ?? null;
  return {
    id: n.id,
    name: n.name,
    role: access,
    tariffs_mode: n.tariffs_mode,
    menu_mode: n.menu_mode,
    tariffs: { template: n.tariffs_template, version: n.tariffs_version },
    menu: { template: n.menu_template, version: n.menu_version },
    clubs: clubs.map(clubJson),
    // План подписки «Сеть» (№194): действует для клубов сети из 2+ клубов, цену задаёт платформа.
    plan: plan ? { id: plan.id, code: plan.code, title: plan.title, price_per_table_kopecks: Number(plan.price_per_table_kopecks), active: plan.active, applies: clubs.length >= 2 && plan.active } : null,
    created_at: iso(n.created_at),
    updated_at: iso(n.updated_at),
  };
}

/** Сети пользователя (личный контекст): владелец или управляющий. */
export async function myNetworks(db, userId) {
  await setContext(db, { clubId: null });
  const { rows } = await db.query(
    `select n.id, n.name, n.owner_user_id, n.tariffs_mode, n.menu_mode,
            (select count(*)::int from bl.network_clubs c where c.network_id = n.id and c.active) as clubs
       from bl.networks n
      where n.archived_at is null
      order by n.name, n.id`,
  );
  return rows.map((r) => ({ network_id: r.id, name: r.name, role: r.owner_user_id === userId ? 'owner' : 'manager', clubs: r.clubs, tariffs_mode: r.tariffs_mode, menu_mode: r.menu_mode }));
}

// Сеть -----------------------------------------------------------------------------------------------

/** POST /api/networks {name} → 201 сеть. */
export async function createNetwork(ctx, body) {
  requireSession(ctx);
  await ctx.useClub(null);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (name.length < 1 || name.length > 100) throw new HttpError(400, 'bad_request', { detail: 'name' });
  const { rows } = await callDb(ctx.db, 'select bl.network_create($1) as id', [name]);
  ctx.log?.info?.('network_created', { network_id: rows[0].id, user_id: ctx.user.id });
  return networkJson(ctx, rows[0].id, 'owner');
}

/**
 * PATCH /api/networks/{id} {name?, tariffs_mode?, menu_mode?, reason?} — владелец.
 * Переход шаблона в «жёсткий» возвращает клубы, переопределившие шаблон, к шаблону — это изменение
 * шаблона для них (templates.mjs: в live — причина и уведомление владельцу).
 */
export async function updateNetwork(ctx, networkId, body, { enforceTemplates }) {
  await networkAccess(ctx, networkId, { want: 'owner' });
  const b = body ?? {};
  const n = await loadNetwork(ctx.db, networkId);
  const sets = [];
  const params = [networkId];
  const changes = {};
  if (b.name !== undefined) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (name.length < 1 || name.length > 100) throw new HttpError(400, 'bad_request', { detail: 'name' });
    if (name !== n.name) {
      params.push(name);
      sets.push(`name = $${params.length}`);
      changes.name = [n.name, name];
    }
  }
  for (const k of ['tariffs_mode', 'menu_mode']) {
    if (b[k] === undefined) continue;
    if (!MODES.includes(b[k])) throw new HttpError(400, 'bad_request', { detail: k });
    if (b[k] !== n[k]) {
      params.push(b[k]);
      sets.push(`${k} = $${params.length}`);
      changes[k] = [n[k], b[k]];
    }
  }
  if (sets.length === 0) return networkJson(ctx, networkId, 'owner');
  params.push(ctx.clock.now());
  sets.push(`updated_at = $${params.length}`);
  await ctx.db.query(`update bl.networks set ${sets.join(', ')} where id = $1`, params);
  const clubs = (await networkClubs(ctx.db, networkId)).map((c) => c.club_id);
  await auditClubs(ctx, clubs, { action: 'network.updated', objectId: networkId, data: { network_id: networkId, changes } });
  // «Жёсткий» шаблон: переопределения клубов снимаются — шаблон применяется к ним.
  const hard = { tariffs: changes.tariffs_mode?.[1] === 'hard' && n.tariffs_template, menu: changes.menu_mode?.[1] === 'hard' && n.menu_template };
  if (hard.tariffs || hard.menu) await enforceTemplates(ctx, networkId, { tariffs: hard.tariffs, menu: hard.menu, reason: b.reason });
  return networkJson(ctx, networkId, 'owner');
}

/** DELETE /api/networks/{id} — владелец: архив, клубы выходят из сети, управляющие отзываются. */
export async function archiveNetwork(ctx, networkId) {
  await networkAccess(ctx, networkId, { want: 'owner' });
  const clubs = (await networkClubs(ctx.db, networkId)).map((c) => c.club_id);
  await callDb(ctx.db, 'select bl.network_archive($1)', [networkId]);
  await auditClubs(ctx, clubs, { action: 'network.archived', objectId: networkId, data: { network_id: networkId } });
  return { ok: true, clubs_removed: clubs.length };
}

// Клубы сети -----------------------------------------------------------------------------------------

/** POST /api/networks/{id}/clubs {club_id} — владелец: только свой клуб, клуб — не больше чем в одной сети. */
export async function addClub(ctx, networkId, body) {
  await networkAccess(ctx, networkId, { want: 'owner' });
  const clubId = body?.club_id;
  if (typeof clubId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(clubId)) throw new HttpError(400, 'bad_request', { detail: 'club_id' });
  // Сервер проверяет владение до базы (база проверит ещё раз): владелец клуба напрямую.
  const own = await ctx.db.query("select 1 from bl.club_members where club_id = $1 and user_id = $2 and role = 'owner' and active and network_id is null", [clubId, ctx.user.id]);
  if (own.rowCount === 0) throw new HttpError(403, 'forbidden', { detail: 'not owner of the club' });
  const before = (await networkClubs(ctx.db, networkId)).some((c) => c.club_id === clubId);
  await callDb(ctx.db, 'select bl.network_add_club($1, $2) as id', [networkId, clubId]);
  if (!before) {
    const n = await loadNetwork(ctx.db, networkId);
    await auditClubs(ctx, [clubId], { action: 'network.club_added', objectId: networkId, data: { network_id: networkId, name: n.name, tariffs_mode: n.tariffs_mode, menu_mode: n.menu_mode } });
  }
  return { status: before ? 200 : 201, json: await networkJson(ctx, networkId, 'owner') };
}

/** DELETE /api/networks/{id}/clubs/{club_id} — владелец: клуб выходит; его тарифы и меню остаются как есть. */
export async function removeClub(ctx, networkId, clubId) {
  await networkAccess(ctx, networkId, { want: 'owner' });
  const { rows } = await callDb(ctx.db, 'select bl.network_remove_club($1, $2) as ok', [networkId, clubId]);
  if (!rows[0].ok) throw new HttpError(404, 'not_found', { detail: 'club' });
  await auditClubs(ctx, [clubId], { action: 'network.club_removed', objectId: networkId, data: { network_id: networkId } });
  return networkJson(ctx, networkId, 'owner');
}

// Управляющие сети ------------------------------------------------------------------------------------

function memberJson(r) {
  const status = r.accepted_at ? 'active' : 'invited';
  return {
    id: r.id,
    status,
    user_id: r.user_id ?? null,
    name: r.name ?? null,
    phone_masked: maskPhone(r.phone),
    created_at: iso(r.created_at),
    expires_at: status === 'invited' ? iso(r.expires_at) : null,
    accepted_at: iso(r.accepted_at),
  };
}

/** GET /api/networks/{id}/managers — владелец. */
export async function listManagers(ctx, networkId) {
  await networkAccess(ctx, networkId, { want: 'owner' });
  const { rows } = await callDb(ctx.db, 'select * from bl.network_members_list($1)', [networkId]);
  return { items: rows.map((r) => memberJson(r)) };
}

/** Текст приглашения управляющего сети (SMS-провайдера нет, №158): без телефона. */
export function networkInviteMessage({ networkName, publicHost, expiresAt, timezone = 'Europe/Moscow' }) {
  if (!/^[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(String(publicHost ?? ''))) throw new Error('networkInviteMessage: publicHost');
  const url = `https://${publicHost}/club/`;
  const until = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: timezone }).format(new Date(expiresAt));
  const name = String(networkName ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const text =
    `Вас пригласили управляющим сети клубов «${name}» в программе «Бильярдум». ` +
    `Откройте ссылку и войдите по номеру телефона, на который пришло это приглашение: ${url} ` +
    `Приглашение действует до ${until}.`;
  return { invite_url: url, invite_text: text };
}

/** POST /api/networks/{id}/managers {phone} — владелец: приглашение на 7 дней, привязка при входе. */
export async function inviteManager(ctx, networkId, body) {
  await networkAccess(ctx, networkId, { want: 'owner' });
  const raw = body?.phone;
  const phone = typeof raw === 'string' && raw.trim().startsWith('+') ? normalizePhone(raw) : null;
  if (!phone) throw new HttpError(400, 'bad_request', { detail: 'phone' });
  // Владелец сети и так видит всё — себя не приглашает.
  const self = await ctx.db.query('select phone from bl.users where id = $1', [ctx.user.id]);
  if (self.rows[0]?.phone === phone) throw new HttpError(409, 'duplicate', { detail: 'owner' });
  const now = ctx.clock.now();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  const { rows } = await callDb(ctx.db, 'select bl.network_invite($1, $2, $3) as id', [networkId, phone, expiresAt]);
  const id = rows[0].id;
  const n = await loadNetwork(ctx.db, networkId);
  const clubs = await networkClubs(ctx.db, networkId);
  await auditClubs(ctx, clubs.map((c) => c.club_id), {
    action: 'network.manager_invited',
    objectId: networkId,
    data: { network_id: networkId, member_id: id, phone_masked: maskPhone(phone), expires_at: expiresAt.toISOString() },
  });
  const out = { id, status: 'invited', phone_masked: maskPhone(phone), expires_at: expiresAt.toISOString() };
  const host = ctx.config?.publicHost;
  if (!host) return out;
  return { ...out, ...networkInviteMessage({ networkName: n.name, publicHost: host, expiresAt, timezone: clubs[0]?.timezone ?? 'Europe/Moscow' }) };
}

/** DELETE /api/networks/{id}/managers/{member_id} — владелец: доступ ко всем клубам сети снимается сразу. */
export async function revokeManager(ctx, networkId, memberId) {
  await networkAccess(ctx, networkId, { want: 'owner' });
  const clubs = (await networkClubs(ctx.db, networkId)).map((c) => c.club_id);
  const { rows } = await callDb(ctx.db, 'select bl.network_revoke_member($1, $2) as user_id', [networkId, memberId]);
  await auditClubs(ctx, clubs, { action: 'network.manager_revoked', objectId: networkId, data: { network_id: networkId, member_id: memberId, user_id: rows[0].user_id ?? null } });
  return { ok: true };
}

/**
 * При входе (server/auth completeLogin): приглашения управляющим сети на номер пользователя.
 * Журнал network.manager_added — в цепочку каждого клуба сети. Контекст после — личный.
 */
export async function acceptNetworkInvites(db, userId) {
  await setContext(db, { clubId: null, userId });
  const { rows } = await db.query('select * from bl.network_accept_invites()');
  for (const r of rows) {
    const clubs = (await db.query('select club_id from bl.network_clubs where network_id = $1 and active order by club_id', [r.network_id])).rows;
    for (const c of clubs) {
      await setContext(db, { clubId: c.club_id });
      await appendAudit(db, {
        action: 'network.manager_added',
        objectType: 'network',
        objectId: r.network_id,
        actorType: 'user',
        actorId: userId,
        data: { network_id: r.network_id, member_id: r.member_id, user_id: userId },
      });
    }
    await setContext(db, { clubId: null });
  }
  return rows.map((r) => ({ network_id: r.network_id, member_id: r.member_id }));
}

// Клуб: его сеть --------------------------------------------------------------------------------------

/** GET /api/clubs/{club}/network — владелец и управляющий клуба: сеть клуба и состояние шаблонов. */
export async function clubNetworkJson(db, clubId) {
  const { rows } = await db.query(
    `select c.network_id, c.tariffs_override, c.tariffs_version, c.menu_version, n.name, n.tariffs_mode, n.menu_mode,
            n.tariffs_template, n.tariffs_version as network_tariffs_version, n.menu_template, n.menu_version as network_menu_version,
            (select count(*)::int from bl.products p where p.club_id = c.club_id and p.network_product_id is not null and p.network_override) as menu_overrides
       from bl.network_clubs c join bl.networks n on n.id = c.network_id
      where c.club_id = $1 and c.active and n.archived_at is null`,
    [clubId],
  );
  const r = rows[0];
  if (!r) return { network: null };
  return {
    network: {
      id: r.network_id,
      name: r.name,
      tariffs: {
        template: r.tariffs_template,
        mode: r.tariffs_mode,
        // locked — клуб не меняет тарифы сам (жёсткий шаблон); override — клуб переопределил мягкий шаблон.
        locked: r.tariffs_template && r.tariffs_mode === 'hard',
        override: r.tariffs_template && r.tariffs_override,
        version: r.network_tariffs_version,
        applied_version: r.tariffs_version,
      },
      menu: {
        template: r.menu_template,
        mode: r.menu_mode,
        locked: r.menu_template && r.menu_mode === 'hard',
        overrides: r.menu_template ? r.menu_overrides : 0,
        version: r.network_menu_version,
        applied_version: r.menu_version,
      },
    },
  };
}
