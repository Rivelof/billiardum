// «Кто играл за столом» (M5.2 №179): разбор происшествий — поломка, забытая вещь, спор.
//   GET  /api/clubs/{club}/resources/{id}/sessions?from&to — владелец и управляющий: игры стола за период
//        (рабочие сутки клуба, по умолчанию — текущие; не больше 366): начало, конец, сумма, способы оплаты,
//        гость — ник Бильярдум+ или маска телефона; игра, которую оплатил сотрудник, — имя сотрудника.
//   POST /api/clubs/{club}/sessions/{id}/guest-phone {reason} — только владелец: полный телефон плательщика
//        игры; причина обязательна, журнал guest.lookup (без номера) и уведомление владельцу, как у ручного
//        действия (152‑ФЗ, инвариант 8). Ресепшн и бар — 403.

import { ROLES } from '../router.mjs';
import { HttpError } from '../../server/http/errors.mjs';
import { manualReason } from '../../server/lib/manual.mjs';
import { formatDate, formatTime } from '@billiardum/shared/format';
import { loadClub } from '../../server/dashboard/store.mjs';
import { dayBounds, daysBetween, isDay, workingDayOf } from '../../server/dashboard/time.mjs';

const STAFF_ROLES = ['owner', 'manager', 'reception', 'bar', 'installer'];
const iso = (d) => (d ? new Date(d).toISOString() : null);

async function labels(db, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  const out = new Map();
  if (!list.length) return out;
  for (const r of (await db.query('select user_id, nick from bl.plus_briefs($1::uuid[])', [list])).rows) if (r.nick) out.set(r.user_id, { nick: r.nick, phone_masked: null });
  for (const id of list) {
    if (out.has(id)) continue;
    out.set(id, { nick: null, phone_masked: (await db.query('select phone_masked from bl.user_brief($1)', [id])).rows[0]?.phone_masked ?? null });
  }
  return out;
}

async function sessionsOfResource(ctx, req) {
  const club = await loadClub(ctx.db, ctx.club);
  const res = (await ctx.db.query('select id, number, title, type from bl.resources where id = $1 and club_id = $2', [req.params.id, ctx.club])).rows[0];
  if (!res) throw new HttpError(404, 'not_found');
  const today = workingDayOf(ctx.clock.now(), club.timezone, club.day_start_local);
  const from = req.query.from ?? today;
  const to = req.query.to ?? from;
  if (!isDay(from) || !isDay(to) || from > to || daysBetween(from, to) > 366) throw new HttpError(400, 'bad_request', { detail: 'period' });
  const a = dayBounds(from, club.timezone, club.day_start_local).from;
  const b = dayBounds(to, club.timezone, club.day_start_local).to;
  const { rows } = await ctx.db.query(
    `select s.id, s.started_at, coalesce(s.ended_at, s.interrupted_at) as ended_at, s.status, s.source, s.payer_user_id, s.booking_id,
            (select count(*)::int from bl.session_participants sp where sp.session_id = s.id) as players,
            exists (select 1 from bl.club_members m where m.club_id = s.club_id and m.user_id = s.payer_user_id and m.role = any($4::text[])) as staff_payer
       from bl.sessions s
      where s.club_id = $1 and s.resource_id = $5 and s.started_at >= $2 and s.started_at < $3 and not s.is_test and s.status <> 'cancelled'
      order by s.started_at desc limit 1000`,
    [ctx.club, a, b, STAFF_ROLES, res.id],
  );
  const ids = rows.map((r) => r.id);
  const pays = ids.length
    ? (
        await ctx.db.query(
          `select coalesce(p.session_id, s.id) as session_id, p.method,
                  sum(case when p.capture then p.amount_kopecks else coalesce(p.captured_kopecks, 0) end)::bigint as amount
             from bl.payments p
             left join bl.sessions s on s.booking_id is not null and s.booking_id = p.booking_id and p.kind = 'booking'
            where p.club_id = $2 and p.status = 'succeeded' and p.provider <> 'balance' and not p.is_test
              and (p.session_id = any($1::uuid[]) or s.id = any($1::uuid[]))
            group by 1, 2`,
          [ids, ctx.club],
        )
      ).rows
    : [];
  const guests = await labels(ctx.db, rows.filter((r) => !r.staff_payer).map((r) => r.payer_user_id));
  const staff = new Map(
    (await ctx.db.query('select id, name from bl.users where id = any($1::uuid[])', [rows.filter((r) => r.staff_payer).map((r) => r.payer_user_id)])).rows.map((r) => [r.id, r.name]),
  );
  return {
    resource: res,
    period: { from, to },
    items: rows.map((r) => {
      const my = pays.filter((p) => p.session_id === r.id);
      return {
        session_id: r.id,
        started_at: iso(r.started_at),
        ended_at: iso(r.ended_at),
        status: r.status,
        source: r.source,
        players: r.players,
        amount_kopecks: my.reduce((s, p) => s + Number(p.amount), 0),
        methods: [...new Set(my.map((p) => p.method))].sort(),
        guest: r.payer_user_id && !r.staff_payer ? guests.get(r.payer_user_id) ?? { nick: null, phone_masked: null } : null,
        staff_name: r.staff_payer ? staff.get(r.payer_user_id) ?? null : null,
      };
    }),
  };
}

async function guestPhone(ctx, req) {
  const reason = manualReason(req.body?.reason);
  const club = await loadClub(ctx.db, ctx.club);
  const s = (await ctx.db.query('select s.id, s.resource_id, s.started_at, s.payer_user_id, r.number from bl.sessions s join bl.resources r on r.id = s.resource_id where s.id = $1 and s.club_id = $2', [req.params.id, ctx.club])).rows[0];
  if (!s) throw new HttpError(404, 'not_found');
  const phone = s.payer_user_id ? (await ctx.db.query('select bl.guest_phone($1, $2) as phone', [s.id, s.payer_user_id])).rows[0].phone : null;
  if (!phone) throw new HttpError(404, 'not_found');
  await ctx.audit.appendAudit(ctx.db, {
    action: 'guest.lookup',
    objectType: 'session',
    objectId: s.id,
    reason,
    actorType: 'user',
    actorId: req.user.id,
    data: { session_id: s.id, resource_id: s.resource_id },
  });
  // Уведомление владельцу — как у ручного действия (тревога manual_action уведомляет при каждом вызове).
  await ctx.alarms.raise(ctx.db, ctx.club, {
    type: 'manual_action',
    manual: true,
    resourceId: s.resource_id,
    data: { action: 'guest.lookup', reason, staff_id: req.user.id, session_id: s.id },
    dedupeKey: `guest.lookup:${s.id}`,
    text: `Просмотрен телефон гостя: стол ${s.number}, игра ${formatDate(s.started_at, club.timezone)} ${formatTime(s.started_at, club.timezone)}. Причина: ${reason}`,
  });
  return { session_id: s.id, phone };
}

export const routes = [
  { method: 'GET', path: '/api/clubs/{club}/resources/{id}/sessions', auth: 'staff', roles: [...ROLES.MANAGER_UP], handler: async (ctx, req) => ({ json: await sessionsOfResource(ctx, req) }) },
  {
    method: 'POST',
    path: '/api/clubs/{club}/sessions/{id}/guest-phone',
    auth: 'staff',
    roles: [...ROLES.OWNER],
    rateLimit: { max: 20, windowMs: 60_000 },
    handler: async (ctx, req) => ({ json: await guestPhone(ctx, req) }),
  },
];
